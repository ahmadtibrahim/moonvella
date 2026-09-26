/**
 * The deferred work queue.
 *
 * Until now MoonVella had no queue, no cron and no worker of any kind: every
 * effect happened inside the request that asked for it, and an effect that
 * could not happen simply did not. Two of the things this app must now do
 * cannot work that way. Blocking a store has to archive products in Shopify,
 * which can fail per product and has to be retried without the owner holding a
 * request open; approving one has to write a contact into Odoo, which may be
 * unreachable for an hour and must not lose the approval because of it.
 *
 * WHAT THIS IS NOT. It is not a durable broker. It is a table, a lease and a
 * claim loop, which is the smallest thing that gives at-least-once delivery of
 * a job that has already been committed to the database alongside the state
 * change that caused it. Every handler must therefore be idempotent, because
 * at-least-once means a job can run twice — once when a worker crashes mid-run
 * and the lease is reclaimed, and once again after a retry.
 *
 * WHY THE ACCESS VERSION IS ON THE JOB. A job queued while a store was approved
 * must not execute after that store has been blocked: archiving a blocked
 * store's catalogue and syncing a blocked store's contact are both exactly
 * backwards. Checking the version at claim time, rather than trusting the queue
 * to have been emptied, is what makes that a property of execution rather than a
 * property of whoever remembered to cancel things.
 */

import { prisma } from "~/db.server";
import type { BackgroundJob, JobStatus, Prisma, PrismaClient } from "@prisma/client";

/**
 * The kinds of work this deployment knows how to do.
 *
 * A constant rather than a string literal at each call site, because the
 * producer and the consumer are in different files and a typo in either would
 * show up as a job that sits PENDING forever with "no handler registered" —
 * which is only discovered by reading the job table.
 */
export const JOB_KIND = {
  /** Write the approved seller's company and contacts into Odoo. */
  ODOO_CONTACT_SYNC: "ODOO_CONTACT_SYNC",
  /** Archive the Shopify products this app imported, for a blocked store. */
  SHOPIFY_ARCHIVE_PRODUCTS: "SHOPIFY_ARCHIVE_PRODUCTS",
  /** Create or update MoonVella products from Odoo templates. */
  ODOO_PRODUCT_IMPORT: "ODOO_PRODUCT_IMPORT",
  /**
   * The whole Odoo catalogue sync: the default pickup location, the tagged
   * products, and the withdrawal of anything that has lost its tag.
   *
   * It is RECURRING — see RECURRING_JOBS — because a catalogue that is only
   * synced when somebody remembers to press a button is a catalogue that
   * disagrees with Odoo for as long as nobody remembers. The manual control on
   * the Odoo page runs this same work and records it in this same table, so
   * "when did it last run" has one answer.
   */
  ODOO_CATALOG_SYNC: "ODOO_CATALOG_SYNC",
  /**
   * Tell Shopify a shipment's tracking, after a booking whose immediate push
   * did not go through.
   *
   * Queued rather than retried in the request because the booking is already
   * paid for and committed: a Shopify outage must not turn a purchased label
   * into a failed booking, and it must not hold the operator's page open while
   * Shopify is down.
   */
  SHOPIFY_FULFILLMENT_SYNC: "SHOPIFY_FULFILLMENT_SYNC",
  /**
   * Poll the carriers for every shipment whose turn it is.
   *
   * §7: "Browser refresh must not be required for tracking updates." Before
   * this, a parcel's status advanced as often as somebody happened to open its
   * page. It is a RECURRING job — see RECURRING_JOBS — because a sweep that only
   * ran once would leave a parcel whose label was issued this afternoon
   * untracked until somebody looked.
   */
  SHIPMENT_TRACKING_SWEEP: "SHIPMENT_TRACKING_SWEEP",
  /**
   * Measure one video so it can stop being PROCESSING.
   *
   * Queued when an upload could not measure the clip itself (no ffprobe in the
   * image that took the upload, most often) and by the Retry on a failed tile.
   * The job is idempotent — the same bytes give the same answer — and every
   * run ends the row in READY or FAILED, so nothing here can loop.
   */
  MEDIA_VIDEO_PROBE: "MEDIA_VIDEO_PROBE",
  /**
   * Queue a probe for every video still stuck at PROCESSING.
   *
   * RECURRING — see RECURRING_JOBS — because the videos that need it were
   * uploaded before the fix shipped and will never ask for it themselves.
   */
  MEDIA_VIDEO_PROBE_SWEEP: "MEDIA_VIDEO_PROBE_SWEEP",
  /**
   * Tell the stores that list a variant how many are left.
   *
   * Queued when a Shopify push did not go through — usually because the
   * merchant's session needed refreshing — and never queued for a push that
   * already succeeded, which is what keeps the queue from becoming a second
   * synchroniser. The handler re-reads the quantity when it runs, so the
   * number that lands in the store is the current one and not the one that
   * was current when the change was made.
   */
  INVENTORY_PUSH: "INVENTORY_PUSH",
} as const;

export type JobKind = (typeof JOB_KIND)[keyof typeof JOB_KIND];

/**
 * A failure a retry cannot fix.
 *
 * The runner reads this flag rather than a message, so "this needs a person"
 * is a property of the error itself and cannot be lost by a handler that
 * forgets to phrase its message a particular way. Handlers throw it for the
 * answers that would be identical on the fifth attempt: Odoo refusing a match
 * because two contacts disagree about a tax id, a country code that is not
 * installed, a store that is not blocked being asked to archive its catalogue.
 */
export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * The key for a job that should happen at most once per seller at a time.
 *
 * Stable per (kind, seller) rather than per attempt: a re-approval while the
 * previous sync is still waiting must collapse into the same job, and a failed
 * one must be revived rather than duplicated.
 */
export function jobKey(kind: JobKind, sellerId: string, suffix?: string): string {
  return suffix ? `${kind}:${sellerId}:${suffix}` : `${kind}:${sellerId}`;
}

/** What a handler reports back. `result` is stored on the job for the audit. */
export interface JobOutcome {
  /** One line, shown to the owner. */
  summary: string;
  /** Everything the operator might need, stored as JSON. */
  detail?: Record<string, unknown>;
}

export type JobHandler = (job: BackgroundJob, context: JobContext) => Promise<JobOutcome>;

export interface JobContext {
  /** The client the handler should use — a transaction when one is open. */
  db: PrismaClient | Prisma.TransactionClient;
}

export interface EnqueueInput {
  kind: string;
  /**
   * Required, and deliberately so. Two calls that mean the same thing must
   * collapse into one job, and the only way to guarantee that is for the caller
   * to name the intent rather than let the queue invent a key.
   */
  idempotencyKey: string;
  sellerId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  /** The seller's access version when the work was asked for. */
  sellerAccessVersion?: number | null;
  db?: PrismaClient | Prisma.TransactionClient;
}

/**
 * Add a job, unless an equivalent one is already waiting or already done.
 *
 * The states that make a re-enqueue a no-op are PENDING and RUNNING and
 * SUCCEEDED. A FAILED or CANCELLED job is revived in place: the same row, the
 * same idempotency key, with its attempt count kept so an operator can see it
 * has failed before. Creating a second row for the same key is impossible
 * anyway — the column is unique — so the only question is what the existing row
 * becomes, and the answer for a failed job is "try again".
 */
export async function enqueueJob(input: EnqueueInput) {
  const db = input.db ?? prisma;

  const existing = await db.backgroundJob.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing) {
    if (
      existing.status === "PENDING" ||
      existing.status === "RUNNING" ||
      existing.status === "SUCCEEDED"
    ) {
      return existing;
    }
    return db.backgroundJob.update({
      where: { id: existing.id },
      data: {
        status: "PENDING",
        runAt: input.runAt ?? new Date(),
        lastError: null,
        finishedAt: null,
        startedAt: null,
        payload: (input.payload ?? existing.payload ?? undefined) as never,
        sellerAccessVersion: input.sellerAccessVersion ?? existing.sellerAccessVersion,
      },
    });
  }

  return db.backgroundJob.create({
    data: {
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      sellerId: input.sellerId ?? null,
      payload: (input.payload ?? {}) as never,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
      sellerAccessVersion: input.sellerAccessVersion ?? null,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Recurring work                                                              */
/* -------------------------------------------------------------------------- */

export interface RecurringJob {
  kind: JobKind;
  /** How often a fresh one is queued. Also the bucket width of its key. */
  everyMs: number;
  /** One line, for the owner's screen. */
  summary: string;
}

/**
 * The jobs that must happen on a schedule rather than in response to something.
 *
 * WHY THIS IS A DECLARATION AND NOT A HANDLER THAT RE-QUEUES ITSELF.
 *
 * The obvious way to keep a periodic job alive is for the handler to enqueue its
 * own successor. It does not work here. `enqueueJob` treats a PENDING, RUNNING or
 * SUCCEEDED row with the same key as already-satisfied and returns it unchanged,
 * so a handler re-enqueuing its own key while RUNNING gets its own row back, with
 * `runAt` untouched — and then the runner marks that row SUCCEEDED. The heartbeat
 * stops on the first beat and the queue looks healthy.
 *
 * So the beat comes from OUTSIDE: the cron entry point calls `ensureRecurringJobs`
 * before it runs anything, which queues the current bucket's job if it is not
 * already there. Each bucket is a NEW row with a NEW key, so the "already
 * satisfied" rule never applies to it, and a tick that arrives late still queues
 * the bucket it is in rather than skipping it. If the app is down for an hour,
 * the next tick queues one sweep — not twelve — because only the current bucket
 * is ever created.
 */
export const RECURRING_JOBS: readonly RecurringJob[] = [
  {
    kind: JOB_KIND.SHIPMENT_TRACKING_SWEEP,
    everyMs: 5 * 60 * 1000,
    summary: "Poll carriers for shipments that are due a tracking check.",
  },
  {
    kind: JOB_KIND.MEDIA_VIDEO_PROBE_SWEEP,
    // Five minutes, the same beat as tracking. A video stuck at PROCESSING is
    // visible to a seller as a file that never becomes usable, so the wait
    // after a deploy that fixes the probe should be measured in minutes.
    everyMs: 5 * 60 * 1000,
    summary: "Queue a probe for every video still waiting to be measured.",
  },
  {
    kind: JOB_KIND.ODOO_CATALOG_SYNC,
    // Six hours. A catalogue is not a shipment: prices and stock move in Odoo
    // over days, and every run reads the whole tagged set. Often enough that a
    // change made in the morning is on a seller's screen the same afternoon,
    // rare enough that it is not the busiest thing this app does.
    everyMs: 6 * 60 * 60 * 1000,
    summary: "Read the tagged Odoo catalogue and update MoonVella's drafts.",
  },
];

/** How long a finished recurring job is kept before it is pruned. */
const RECURRING_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Queue this tick's recurring work, if this tick has not already done so.
 *
 * Called by the cron entry point (app/routes/jobs.run.tsx) before it runs
 * anything. Safe to call from anywhere and any number of times: the bucket key
 * makes a second call in the same bucket a no-op.
 */
export async function ensureRecurringJobs(now: Date = new Date()): Promise<string[]> {
  const queued: string[] = [];

  for (const recurring of RECURRING_JOBS) {
    const bucket = Math.floor(now.getTime() / recurring.everyMs);
    const key = `recurring:${recurring.kind}:${bucket}`;

    const existing = await prisma.backgroundJob.findUnique({ where: { idempotencyKey: key } });
    if (existing) continue;

    /*
     * `maxAttempts: 1` is deliberate. A recurring job that fails is not retried
     * by the queue — the next tick queues the next bucket regardless, and the
     * failure is recorded on the row for a person. Retrying inside the bucket
     * would mean the sweep and its own retry overlapping on the same shipments,
     * and the per-shipment backoff is already doing that job properly.
     */
    await enqueueJob({
      kind: recurring.kind,
      idempotencyKey: key,
      runAt: new Date(bucket * recurring.everyMs),
      maxAttempts: 1,
      payload: { recurring: true, bucket },
    });
    queued.push(key);
  }

  /*
   * Housekeeping, in the same place and for the same reason: without it the
   * queue fills with 288 finished sweep rows a day. Only rows this function
   * created are touched, and only once they are past retention, so nothing an
   * operator might still be reading disappears.
   */
  await prisma.backgroundJob.deleteMany({
    where: {
      idempotencyKey: { startsWith: "recurring:" },
      status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] },
      createdAt: { lt: new Date(now.getTime() - RECURRING_RETENTION_MS) },
    },
  });

  return queued;
}

/** How long a claimed job may stay RUNNING before the lease is treated as dead. */
const LEASE_MS = 10 * 60 * 1000;

function backoffMs(attempts: number): number {
  // 30s, 1m, 2m, 4m … capped at an hour. Odoo being down for a morning should
  // not mean a job that has burned its five attempts by 9:05.
  const minutes = Math.min(60, 0.5 * 2 ** Math.max(0, attempts - 1));
  return Math.round(minutes * 60 * 1000);
}

export interface RunSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  cancelled: number;
  /** True when the runner stopped because it hit its cap, not because it ran out. */
  more: boolean;
}

/**
 * Claim and run due jobs.
 *
 * The claim is a conditional UPDATE, not a read-then-write: two runners racing
 * on the same row produce one winner because the loser's `updateMany` matches
 * nothing. That matters even with a single container, because the owner's page
 * and the cron entry point can both call this.
 */
export async function runDueJobs(
  handlers: Record<string, JobHandler>,
  options: { limit?: number; now?: Date } = {},
): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 20;

  const summary: RunSummary = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
    more: false,
  };

  // A job whose worker died mid-run would otherwise sit RUNNING forever, and the
  // queue would look busy while doing nothing. The lease expires it back into
  // the pending set; handlers are idempotent, so running it a second time is
  // safe by construction.
  await prisma.backgroundJob.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: new Date(now.getTime() - LEASE_MS) },
    },
    data: { status: "PENDING", startedAt: null, lastError: "Lease expired; requeued." },
  });

  const due = await prisma.backgroundJob.findMany({
    where: { status: "PENDING", runAt: { lte: now } },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
    take: limit + 1,
  });

  if (due.length > limit) summary.more = true;

  for (const candidate of due.slice(0, limit)) {
    const claim = await prisma.backgroundJob.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue;

    const job = await prisma.backgroundJob.findUnique({ where: { id: candidate.id } });
    if (!job) continue;
    summary.claimed += 1;

    await runJob(job, handlers, summary);
  }

  return summary;
}

async function runJob(
  job: BackgroundJob,
  handlers: Record<string, JobHandler>,
  summary: RunSummary,
) {
  /*
   * Authorization is re-checked HERE, not at enqueue time.
   *
   * The version is bumped by every status change, so a mismatch means the store
   * this job was queued for is not in the state that justified it. The job is
   * cancelled rather than retried: nothing about a retry would make a blocked
   * store's contact sync correct.
   */
  if (job.sellerId && job.sellerAccessVersion !== null) {
    const seller = await prisma.seller.findUnique({
      where: { id: job.sellerId },
      select: { accessVersion: true, status: true },
    });
    if (!seller) {
      return finish(job, summary, {
        status: "CANCELLED",
        lastError: "The seller record no longer exists.",
      });
    }
    if (seller.accessVersion !== job.sellerAccessVersion) {
      return finish(job, summary, {
        status: "CANCELLED",
        lastError:
          `Seller access changed from version ${job.sellerAccessVersion} to ` +
          `${seller.accessVersion} (now ${seller.status}); this job was queued for a state ` +
          `the store is no longer in.`,
      });
    }
  }

  const handler = handlers[job.kind];
  if (!handler) {
    // Retrying cannot help: no handler means the deployment is missing one, so
    // the job fails immediately rather than burning five attempts to say so.
    return finish(job, summary, {
      status: "FAILED",
      lastError: `No handler is registered for job kind "${job.kind}".`,
      attempts: job.maxAttempts,
    });
  }

  try {
    const outcome = await handler(job, { db: prisma });
    return finish(job, summary, {
      status: "SUCCEEDED",
      result: outcome as never,
      lastError: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    /*
     * Some failures are answers, not accidents. A sync that Odoo refused
     * because two existing contacts disagree about the company's tax id will
     * refuse again in thirty seconds, and burning four more attempts to
     * rediscover that only delays telling a person. An error marked permanent
     * fails on the first attempt; the reason is stored where the owner can read
     * it.
     */
    const permanent = (error as { permanent?: boolean })?.permanent === true;
    if (permanent || job.attempts >= job.maxAttempts) {
      return finish(job, summary, { status: "FAILED", lastError: message });
    }
    return finish(job, summary, {
      status: "PENDING",
      lastError: message,
      runAt: new Date(Date.now() + backoffMs(job.attempts)),
      startedAt: null,
    });
  }
}

async function finish(
  job: BackgroundJob,
  summary: RunSummary,
  data: {
    status: JobStatus;
    lastError?: string | null;
    result?: never;
    runAt?: Date;
    attempts?: number;
    startedAt?: null;
  },
) {
  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      status: data.status,
      lastError: data.lastError ?? null,
      ...(data.result !== undefined ? { result: data.result } : {}),
      ...(data.runAt ? { runAt: data.runAt } : {}),
      ...(data.attempts !== undefined ? { attempts: data.attempts } : {}),
      ...(data.startedAt === null ? { startedAt: null } : {}),
      ...(data.status === "PENDING" ? {} : { finishedAt: new Date() }),
    },
  });

  switch (data.status) {
    case "SUCCEEDED":
      summary.succeeded += 1;
      break;
    case "FAILED":
      summary.failed += 1;
      break;
    case "CANCELLED":
      summary.cancelled += 1;
      break;
    case "PENDING":
      summary.retried += 1;
      break;
    default:
      break;
  }
}

/**
 * Cancel everything still waiting for a seller.
 *
 * Called when a store's access changes: the queued work was justified by the
 * old state. Jobs already RUNNING are left alone — they hold a lease and their
 * handler is idempotent, so cancelling the row underneath a running handler
 * would only make the record disagree with what happened.
 */
export async function cancelPendingJobsForSeller(
  sellerId: string,
  reason: string,
  db: PrismaClient | Prisma.TransactionClient = prisma,
) {
  return db.backgroundJob.updateMany({
    where: { sellerId, status: "PENDING" },
    data: { status: "CANCELLED", lastError: reason, finishedAt: new Date() },
  });
}

/** Counts per status, for the owner's screens. */
export async function jobCounts(where: Prisma.BackgroundJobWhereInput = {}) {
  const rows = await prisma.backgroundJob.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const counts: Record<JobStatus, number> = {
    PENDING: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

/** The jobs worth showing a person: everything not already finished cleanly. */
export async function openJobsFor(where: Prisma.BackgroundJobWhereInput, take = 20) {
  return prisma.backgroundJob.findMany({
    where: { ...where, status: { in: ["PENDING", "RUNNING", "FAILED"] } },
    orderBy: [{ status: "asc" }, { runAt: "asc" }],
    take,
  });
}

export function describeJob(job: BackgroundJob): string {
  const attempts = `${job.attempts}/${job.maxAttempts}`;
  switch (job.status) {
    case "PENDING":
      return `Waiting (attempt ${attempts}${job.lastError ? `, last error: ${job.lastError}` : ""})`;
    case "RUNNING":
      return `Running (attempt ${attempts})`;
    case "SUCCEEDED":
      return "Done";
    case "FAILED":
      return `Failed after ${attempts} attempts: ${job.lastError ?? "no error recorded"}`;
    case "CANCELLED":
      return `Cancelled: ${job.lastError ?? "no reason recorded"}`;
    default:
      return job.status;
  }
}
