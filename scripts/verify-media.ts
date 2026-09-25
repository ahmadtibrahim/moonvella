/**
 * The video pipeline and the template link: what makes an uploaded clip reach
 * READY, and what a template row really is.
 *
 * WHAT THIS SUITE IS ALLOWED TO TOUCH. It runs only against a database whose
 * name ends in `_verify` (the runner refuses anything else), it builds the
 * product, variant and asset rows it needs, and it removes them — and the
 * objects it stored — in a `finally`. It makes no network call of any kind: no
 * Google, no Shopify, no Odoo, no carrier.
 *
 * WHY IT ENCODES ITS OWN VIDEO. The check that matters is "a clip uploaded
 * today is measured and becomes READY", and that cannot be stubbed: a duration
 * read out of a fake would prove nothing about ffprobe. So the suite asks
 * ffmpeg — which is in this image because the Dockerfile puts it there, which
 * is exactly what the fix was about — for one second of real video, and then
 * measures it through the same code the upload path calls.
 *
 * THE IMAGE IS PART OF THE TEST. If ffmpeg or ffprobe is absent, the first
 * checks fail and say so. That is deliberate: "videos are measured" is a
 * property of the deployment, and a suite that skipped measurement on an image
 * without ffprobe would report green for the bug it was written to catch.
 *
 * IT DOES NOT DRIVE THE JOB RUNNER. `runDueJobs` claims whatever is pending,
 * including work other suites left behind, and running a tracking sweep or an
 * Odoo sync from here would reach providers this suite promises not to touch.
 * What is proved instead is the half that can be pinned: the job the sweep
 * queues is the job the handler registers for, and the handler turns the row
 * READY when it is handed that job.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { JOB_KIND, RECURRING_JOBS } from "../app/services/jobs.server";
import { jobHandlers } from "../app/services/jobHandlers.server";
import {
  probeVideoAsset,
  retryVideoProbe,
  sweepVideoProbes,
  videoProbeKey,
} from "../app/services/mediaProbe.server";
import {
  createTemplateAsset,
  DuplicateMediaError,
  assetUrl,
  getMedia,
} from "../app/services/media.server";
import { PERMISSIONS } from "../app/services/permissions";
import {
  isStorageKey,
  newStorageKey,
  probeScratchRoot,
  probeStoredVideo,
  probeVideoBytes,
  readObject,
  saveUpload,
} from "../app/services/storage.server";
import { parseRange } from "../app/routes/uploads.$filename";

const prisma = new PrismaClient();
/**
 * Who this suite acts as. The services under test record an audit row for the
 * retry and the template, and nothing else here depends on the role — the
 * service-level permission assertions belong to the routes, not to these
 * functions — so the actor is given every permission rather than a role that
 * would have to be kept in step with the grants table.
 */
const ACTOR = {
  actorType: "SYSTEM" as const,
  actorId: "verify-media",
  actorName: "Verify suite",
  permissions: PERMISSIONS,
};

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created = {
  productIds: [] as string[],
  assetIds: [] as string[],
  keys: [] as string[],
  jobIds: [] as string[],
};

/**
 * How many videos the sweep will look at in one pass. The default is 25, which
 * is the right number for a production tick — but this suite runs against a
 * clone of the production database, where videos already stuck at PROCESSING
 * are not a hypothesis, they are the rows the sweep exists to rescue. The
 * newest row (this suite's fixture) would sort past the first twenty-five of
 * them, so the suite widens the window rather than pretending the clone is
 * empty.
 */
const SWEEP_WINDOW = 500;

/**
 * Run a sweep, and take responsibility for every probe it queues.
 *
 * The sweep is a catalogue-wide operation: it will also queue probes for videos
 * that were already stuck before this suite ran, and those jobs would sit
 * PENDING in the clone for whichever suite next drains the queue. They are
 * ffprobe-only and could not reach a provider, but a suite that leaves rows
 * behind is a suite that changes what the next one is testing. So the jobs that
 * appeared during this call — this suite's own and anyone else's — are recorded
 * and removed in cleanup.
 */
async function sweep(limit: number = SWEEP_WINDOW) {
  const before = new Set(
    (
      await prisma.backgroundJob.findMany({
        where: { kind: JOB_KIND.MEDIA_VIDEO_PROBE },
        select: { id: true },
      })
    ).map((row) => row.id)
  );
  const summary = await sweepVideoProbes(limit);
  const after = await prisma.backgroundJob.findMany({
    where: { kind: JOB_KIND.MEDIA_VIDEO_PROBE },
    select: { id: true },
  });
  for (const row of after) {
    if (!before.has(row.id)) created.jobIds.push(row.id);
  }
  return summary;
}

/** Every probe key recorded for one asset, which is how a retry is named. */
async function probeKeysFor(assetId: string): Promise<string[]> {
  const rows = await prisma.backgroundJob.findMany({
    where: { idempotencyKey: { startsWith: videoProbeKey(assetId) } },
    select: { idempotencyKey: true },
    orderBy: { idempotencyKey: "asc" },
  });
  return rows.map((row) => row.idempotencyKey);
}

/** One second of real video, encoded by the image's own ffmpeg. */
async function makeVideo(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-v", "error",
        "-f", "lavfi",
        "-i", "testsrc=size=64x48:rate=10:duration=1",
        "-pix_fmt", "yuv420p",
        "-y", path,
      ],
      { timeout: 60000 },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

async function makeProduct(name: string): Promise<{ productId: string; variantId: string }> {
  const product = await prisma.product.create({
    data: {
      name: `${name} ${suffix}`,
      productCode: `VM-${suffix}-${created.productIds.length}`,
      category: "Verification",
    },
    select: { id: true },
  });
  created.productIds.push(product.id);

  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: `VM-${suffix}-${created.productIds.length}-0`,
      name: "Default",
      wholesalePrice: 1200,
      suggestedRetailPrice: 2900,
      inventory: 5,
      isDefault: true,
      isActive: true,
    },
    select: { id: true },
  });

  return { productId: product.id, variantId: variant.id };
}

/**
 * A video row whose key names nothing on the volume — the other way a stored
 * clip stops being measurable: the row survives, the bytes do not.
 */
async function makeVideoWithNoFile(
  productId: string,
  variantId: string,
  filename: string
): Promise<string> {
  const asset = await prisma.mediaAsset.create({
    data: {
      productId,
      category: "PRODUCT_VIDEO",
      subtype: "PRODUCT_DEMO",
      title: filename,
      originalFilename: filename,
      // A real key of the usual shape, deliberately never written to.
      storageKey: newStorageKey("mp4"),
      mimeType: "video/mp4",
      fileSize: 2048,
      checksum: `verify-${suffix}`,
      processingStatus: "PROCESSING",
      approvalStatus: "DRAFT",
      sellerVisible: false,
      createdById: ACTOR.actorId,
    },
    select: { id: true },
  });
  created.assetIds.push(asset.id);
  await prisma.mediaAssetAssignment.create({
    data: { assetId: asset.id, variantId, sortOrder: 0 },
  });
  return asset.id;
}

/**
 * A stored object plus the row that claims to be waiting on a probe — the state
 * every video was left in before this work: bytes on disk, PROCESSING forever,
 * and nothing on the queue to change that.
 */
async function makeStuckVideo(
  productId: string,
  variantId: string,
  bytes: Buffer,
  filename: string
): Promise<string> {
  const stored = await saveUpload(new File([new Uint8Array(bytes)], filename, { type: "video/mp4" }));
  created.keys.push(stored.key);
  const asset = await prisma.mediaAsset.create({
    data: {
      productId,
      category: "PRODUCT_VIDEO",
      subtype: "PRODUCT_DEMO",
      title: filename,
      originalFilename: filename,
      storageKey: stored.key,
      mimeType: "video/mp4",
      fileSize: stored.size,
      checksum: stored.checksum,
      processingStatus: "PROCESSING",
      approvalStatus: "DRAFT",
      sellerVisible: false,
      createdById: ACTOR.actorId,
    },
    select: { id: true },
  });
  created.assetIds.push(asset.id);
  await prisma.mediaAssetAssignment.create({
    data: { assetId: asset.id, variantId, sortOrder: 0 },
  });
  return asset.id;
}

async function cleanup(): Promise<void> {
  if (created.jobIds.length) {
    await prisma.backgroundJob.deleteMany({ where: { id: { in: created.jobIds } } });
  }
  if (created.assetIds.length) {
    // The probe jobs are keyed by asset id, so they are found by it too: a job
    // that survived the sweep's own bookkeeping is still this suite's mess.
    await prisma.backgroundJob.deleteMany({
      where: { OR: created.assetIds.map((id) => ({ idempotencyKey: { contains: id } })) },
    });
  }
  if (created.productIds.length) {
    await prisma.mediaAsset.deleteMany({ where: { productId: { in: created.productIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: created.productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
  }
  const root = process.env.UPLOAD_DIR || "/app/uploads";
  for (const key of created.keys) {
    await rm(join(root, key), { force: true }).catch(() => undefined);
  }
  await prisma.$disconnect();
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "verify-media-"));
  try {
    /* -------------------------------------------------------------------- */
    /* The probe, against a file that is really a video                      */
    /* -------------------------------------------------------------------- */
    const videoPath = join(work, "clip.mp4");
    let encoded = true;
    try {
      await makeVideo(videoPath);
    } catch (error) {
      encoded = false;
      check(
        "the image can encode a test video (ffmpeg present)",
        false,
        error instanceof Error ? error.message.split("\n")[0] : "ffmpeg failed"
      );
    }

    if (encoded) {
      const bytes = Buffer.from(await readFile(videoPath));

      const measured = await probeVideoBytes(bytes);
      check(
        "a real clip is measured, not reported as unreadable",
        measured.status === "measured",
        measured.status === "unavailable" ? measured.reason : `status=${measured.status}`
      );
      check(
        "the measured duration is the one second that was encoded",
        measured.status === "measured" && Math.abs(measured.seconds - 1) < 0.5,
        measured.status === "measured" ? String(measured.seconds) : "no measurement"
      );
      check(
        "the frame size comes back from the same call",
        measured.status === "measured" && measured.width === 64 && measured.height === 48,
        measured.status === "measured" ? `${measured.width}×${measured.height}` : "no measurement"
      );

      const garbage = await probeVideoBytes(Buffer.from("this is not a video, it is a sentence"));
      check(
        "bytes that are not a video fail with a fixed, path-free reason",
        garbage.status === "unavailable" &&
          /could not be read as a video|ran out of time/.test(garbage.reason) &&
          !garbage.reason.includes("/"),
        garbage.status === "unavailable" ? garbage.reason : "unexpectedly measured"
      );

      /* ------------------------------------------------------------------ */
      /* The row: PROCESSING becomes READY, once, terminally                */
      /* ------------------------------------------------------------------ */
      const probeProduct = await makeProduct("Verify Media Probe");
      const stuck = await makeStuckVideo(probeProduct.productId, probeProduct.variantId, bytes, "clip.mp4");

      const probed = await probeVideoAsset(stuck);
      check(
        "probing a stored video reports READY with its duration",
        probed.status === "READY" && typeof probed.seconds === "number" && Math.abs(probed.seconds - 1) < 0.5,
        JSON.stringify(probed)
      );

      const row = await prisma.mediaAsset.findUnique({
        where: { id: stuck },
        select: {
          processingStatus: true,
          durationSeconds: true,
          processingError: true,
          width: true,
          height: true,
        },
      });
      check(
        "the row says READY, with a whole-second duration and no error",
        row?.processingStatus === "READY" &&
          row?.durationSeconds === 1 &&
          row?.processingError === null,
        JSON.stringify(row)
      );
      check(
        "the frame size is filled in on a row that had none",
        row?.width === 64 && row?.height === 48,
        `${row?.width}×${row?.height}`
      );

      const again = await probeVideoAsset(stuck);
      check(
        "measuring an already-measured video does nothing at all",
        again.status === "SKIPPED" && /already/.test(again.reason ?? ""),
        JSON.stringify(again)
      );

      /* ------------------------------------------------------------------ */
      /* A video nobody measured: the sweep, the job, and the end of it     */
      /* ------------------------------------------------------------------ */
      const sweepProduct = await makeProduct("Verify Media Sweep");
      const stuckAgain = await makeStuckVideo(
        sweepProduct.productId,
        sweepProduct.variantId,
        bytes,
        "sweep.mp4"
      );

      const first = await sweep();
      const job = await prisma.backgroundJob.findUnique({
        where: { idempotencyKey: videoProbeKey(stuckAgain) },
      });
      check(
        "the sweep queues a probe for the video nothing else would ever measure",
        job?.status === "PENDING",
        JSON.stringify({ found: Boolean(job), status: job?.status })
      );
      check(
        "the queued job carries the kind, the key and the asset it is for",
        job?.kind === JOB_KIND.MEDIA_VIDEO_PROBE &&
          (job?.payload as { assetId?: string } | null)?.assetId === stuckAgain,
        JSON.stringify({ kind: job?.kind, payload: job?.payload })
      );
      check(
        "every video the sweep looked at is accounted for as queued, already queued or errored",
        first.enqueued + first.alreadyQueued + first.errors.length === first.considered,
        JSON.stringify(first)
      );

      const second = await sweep();
      check(
        "a second sweep queues nothing at all: every probe is already waiting",
        second.enqueued === 0 && second.errors.length === 0,
        JSON.stringify(second)
      );
      check(
        "and it still sees them, which is what makes the first sweep's count meaningful",
        second.alreadyQueued === second.considered,
        JSON.stringify(second)
      );

      const handler = jobHandlers[JOB_KIND.MEDIA_VIDEO_PROBE];
      check(
        "the queue has a handler registered for that kind",
        typeof handler === "function",
        String(typeof handler)
      );
      check(
        "the runner runs handlers from this same map, so the kind is reachable",
        (await readFile(new URL("../app/routes/jobs.run.tsx", import.meta.url), "utf8")).includes(
          "runDueJobs(jobHandlers"
        )
      );

      if (job && handler) {
        const outcome = await handler(job, { db: prisma });
        check(
          "the handler reports having measured the video",
          /Measured video/.test(outcome.summary),
          outcome.summary
        );
      }

      const sweptRow = await prisma.mediaAsset.findUnique({
        where: { id: stuckAgain },
        select: { processingStatus: true, durationSeconds: true },
      });
      check(
        "the swept video is READY with a duration",
        sweptRow?.processingStatus === "READY" && sweptRow?.durationSeconds === 1,
        JSON.stringify(sweptRow)
      );

      const third = await sweep();
      check(
        "the measured video has dropped out of the sweep's scope, and nothing was re-queued",
        third.considered === first.considered - 1 && third.enqueued === 0,
        `${first.considered} → ${third.considered} considered, ${third.enqueued} enqueued`
      );

      const beat = RECURRING_JOBS.find((entry) => entry.kind === JOB_KIND.MEDIA_VIDEO_PROBE_SWEEP);
      check(
        "the sweep is scheduled, on a five-minute beat",
        beat?.everyMs === 5 * 60 * 1000,
        JSON.stringify(beat ?? "not scheduled")
      );
      check(
        "the sweep has a handler of its own",
        typeof jobHandlers[JOB_KIND.MEDIA_VIDEO_PROBE_SWEEP] === "function"
      );

      /* ------------------------------------------------------------------ */
      /* A file that cannot be measured: FAILED, and only a person retries   */
      /* ------------------------------------------------------------------ */
      // The file is a real clip whose stored copy was cut short — the header
      // survives, the index of frames does not. It cannot be built by handing
      // `saveUpload` nonsense, and that is the point: the uploader refuses a
      // file it cannot identify at all, so the only way a video reaches FAILED
      // is by being damaged AFTER it was accepted. That is the case this
      // branch exists for.
      const damaged = bytes.subarray(0, 512);
      const badProduct = await makeProduct("Verify Media Failure");
      const bad = await makeStuckVideo(
        badProduct.productId,
        badProduct.variantId,
        damaged,
        "cut-short.mp4"
      );

      // The production sequence, in order: the sweep queues it, the handler
      // picks it up, and the answer is FAILED. The handler is what reports it —
      // the run reached a conclusion, so the job succeeded at finding out.
      await sweep();
      const badJob = await prisma.backgroundJob.findUnique({
        where: { idempotencyKey: videoProbeKey(bad) },
      });
      if (badJob && handler) {
        const outcome = await handler(badJob, { db: prisma });
        check(
          "a file that cannot be measured is reported as an answer, not thrown as an error",
          /could not be measured/.test(outcome.summary),
          outcome.summary
        );
      }

      const failedRow = await prisma.mediaAsset.findUnique({
        where: { id: bad },
        select: { processingStatus: true, processingError: true, durationSeconds: true },
      });
      check(
        "a video whose stored copy was cut short ends FAILED, with the reason",
        failedRow?.processingStatus === "FAILED" && /could not be read as a video/.test(String(failedRow?.processingError)),
        JSON.stringify(failedRow)
      );
      check(
        "no duration was invented for a file that has none",
        failedRow?.durationSeconds === null,
        String(failedRow?.durationSeconds)
      );
      check(
        "the stored failure message names no filesystem path",
        !String(failedRow?.processingError).includes("/"),
        String(failedRow?.processingError)
      );

      const keysAfterFailure = await sweep().then(() => probeKeysFor(bad));
      check(
        "nothing retries a FAILED video on its own — the sweep has moved past it",
        keysAfterFailure.length === 1 && keysAfterFailure[0] === videoProbeKey(bad),
        JSON.stringify(keysAfterFailure)
      );

      await retryVideoProbe(bad, ACTOR);
      const afterRetry = await prisma.mediaAsset.findUnique({
        where: { id: bad },
        select: { processingStatus: true, processingError: true },
      });
      check(
        "a retry clears the failure and puts the video back to PROCESSING",
        afterRetry?.processingStatus === "PROCESSING" && afterRetry?.processingError === null,
        JSON.stringify(afterRetry)
      );

      const retryJobs = await probeKeysFor(bad);
      const retryKey = retryJobs.find((key) => key !== videoProbeKey(bad));
      check(
        "the retry is a NEW job, named by attempt, not the satisfied first one",
        retryJobs.length === 2 && Boolean(retryKey) && /:\d+$/.test(String(retryKey)),
        JSON.stringify(retryJobs)
      );

      const auditRows = await prisma.auditLog.count({
        where: { entityId: bad, action: "media.probe_retried" },
      });
      check("the retry is recorded in the audit trail", auditRows === 1, String(auditRows));

      const waitingNow = await prisma.mediaAsset.count({
        where: { processingStatus: "PROCESSING", mimeType: { startsWith: "video/" } },
      });
      const sweepAfterRetry = await sweep();
      check(
        "a retried video is back in the sweep's scope until it resolves",
        sweepAfterRetry.considered === Math.min(waitingNow, SWEEP_WINDOW),
        `${sweepAfterRetry.considered} considered, ${waitingNow} waiting`
      );
      check(
        "and the sweep adds nothing, because the retry is already queued",
        sweepAfterRetry.enqueued === 0,
        JSON.stringify(sweepAfterRetry)
      );

      // Retrying again must not collide with the attempt that is already there,
      // which is where a naive idempotency key silently swallows the second try.
      const retriedJob = retryKey
        ? await prisma.backgroundJob.findUnique({ where: { idempotencyKey: retryKey } })
        : null;
      if (retriedJob && handler) await handler(retriedJob, { db: prisma });
      await retryVideoProbe(bad, ACTOR);
      const keysAfterSecondRetry = await probeKeysFor(bad);
      check(
        "a second retry gets an attempt number of its own rather than reusing the first",
        keysAfterSecondRetry.length === 3 && keysAfterSecondRetry.some((key) => /:2$/.test(key)),
        JSON.stringify(keysAfterSecondRetry)
      );

      /* ------------------------------------------------------------------ */
      /* The other way a video stops being measurable: the bytes are gone    */
      /* ------------------------------------------------------------------ */
      const goneProduct = await makeProduct("Verify Media Gone");
      const gone = await makeVideoWithNoFile(
        goneProduct.productId,
        goneProduct.variantId,
        "deleted.mp4"
      );
      const goneOutcome = await probeVideoAsset(gone);
      check(
        "a row whose file is no longer on the volume fails, and says which problem it is",
        goneOutcome.status === "FAILED" && /uploads volume/.test(goneOutcome.reason ?? ""),
        JSON.stringify(goneOutcome)
      );
      check(
        "that reason names no path either",
        !String(goneOutcome.reason).includes("/"),
        String(goneOutcome.reason)
      );

      /* ------------------------------------------------------------------ */
      /* The scratch directory is on the uploads volume, not in /tmp        */
      /* ------------------------------------------------------------------ */
      const scratch = probeScratchRoot();
      const uploadRoot = process.env.UPLOAD_DIR || "/app/uploads";
      check(
        "byte-based probing scratches on the uploads volume, never in /tmp",
        scratch.startsWith(uploadRoot) && !scratch.startsWith("/tmp"),
        scratch
      );

      /* ------------------------------------------------------------------ */
      /* Reaching the bytes, and the range a browser asks for               */
      /* ------------------------------------------------------------------ */
      const rangeProduct = await makeProduct("Verify Media Range");
      const rangeAsset = await makeStuckVideo(
        rangeProduct.productId,
        rangeProduct.variantId,
        bytes,
        "range.mp4"
      );
      const rangeKey = (
        await prisma.mediaAsset.findUnique({ where: { id: rangeAsset }, select: { storageKey: true } })
      )?.storageKey as string;
      check(
        "the stored object is on disk where the probe expects it",
        (await stat(join(uploadRoot, rangeKey))).isFile(),
        rangeKey
      );
      const inPlace = await probeStoredVideo(rangeKey);
      check(
        "a stored video is measured in place",
        inPlace?.status === "measured" && Math.abs(inPlace.seconds - 1) < 0.5,
        JSON.stringify(inPlace)
      );
      check(
        "a key that names no object is reported as nothing to probe, not as a failure",
        (await probeStoredVideo(`${"0".repeat(32)}.mp4`)) === null
      );

      const size = bytes.byteLength;
      check(
        "no Range header means the whole object",
        parseRange(null, size) === null && parseRange("", size) === null
      );
      const open = parseRange("bytes=100-", size);
      check(
        "an open range runs to the end",
        typeof open === "object" && open !== null && open.start === 100 && open.end === size - 1,
        JSON.stringify(open)
      );
      const closed = parseRange("bytes=0-99", size);
      check(
        "a closed range is served as asked",
        typeof closed === "object" && closed !== null && closed.start === 0 && closed.end === 99,
        JSON.stringify(closed)
      );
      const suffixRange = parseRange("bytes=-100", size);
      check(
        "a suffix range takes the last N bytes",
        typeof suffixRange === "object" &&
          suffixRange !== null &&
          suffixRange.start === size - 100 &&
          suffixRange.end === size - 1,
        JSON.stringify(suffixRange)
      );
      const clamped = parseRange(`bytes=0-${size + 5000}`, size);
      check(
        "a range past the end is clamped rather than refused",
        typeof clamped === "object" && clamped !== null && clamped.end === size - 1,
        JSON.stringify(clamped)
      );
      check(
        "a start past the end is unsatisfiable — a 416, not a 200",
        parseRange(`bytes=${size + 1}-`, size) === "unsatisfiable" &&
          parseRange("bytes=-0", size) === "unsatisfiable",
        String(parseRange(`bytes=${size + 1}-`, size))
      );
      check(
        "another unit, a malformed value or a multi-range request is ignored, which means serve it all",
        parseRange("items=0-10", size) === null &&
          parseRange("bytes=0-1,5-6", size) === null &&
          parseRange("bytes=abc", size) === null &&
          parseRange("bytes=5-3", size) === "unsatisfiable"
      );
      const safari = parseRange("bytes=0-1", size);
      check(
        "the two-byte request Safari opens every video with is answered, not refused",
        typeof safari === "object" && safari !== null && safari.start === 0 && safari.end === 1,
        JSON.stringify(safari)
      );

      /* ------------------------------------------------------------------ */
      /* A template is a link, not a file                                  */
      /* ------------------------------------------------------------------ */
      const templateProduct = await makeProduct("Verify Media Template");
      const templateUrl = `https://www.canva.com/design/verify-${suffix}/view`;

      let missingLinkRefused = false;
      try {
        await createTemplateAsset(
          templateProduct.productId,
          { title: "Brand board", templateUrl: "" },
          ACTOR
        );
      } catch (error) {
        missingLinkRefused = error instanceof Error && /link/.test(error.message);
      }
      check("a template with no link is refused, by name", missingLinkRefused);

      let httpRefused = false;
      try {
        await createTemplateAsset(
          templateProduct.productId,
          { title: "Brand board", templateUrl: "http://www.canva.com/design/x" },
          ACTOR
        );
      } catch (error) {
        httpRefused = error instanceof Error && /https/.test(error.message);
      }
      check("a template link must be https", httpRefused);

      let noTitleRefused = false;
      try {
        await createTemplateAsset(templateProduct.productId, { title: "  ", templateUrl }, ACTOR);
      } catch (error) {
        noTitleRefused = error instanceof Error && /title/.test(error.message);
      }
      check("a template with no title is refused", noTitleRefused);

      const template = await createTemplateAsset(
        templateProduct.productId,
        { title: "Brand board", templateUrl, instructions: "Keep the palette.", variantIds: [] },
        ACTOR
      );
      check(
        "a template row is created READY, with no processing to wait for",
        template.category === "EDITABLE_TEMPLATE" && template.processingStatus === "READY",
        `${template.category}/${template.processingStatus}`
      );
      check(
        "a template is typed as a link, not as an image or a video",
        template.mimeType === "text/uri-list",
        template.mimeType
      );
      // The key is read from the row, not from the view: the view is what the
      // editor and the seller screens are handed, and it deliberately does not
      // carry the key — a screen that never sees one cannot leak one.
      const templateKey = (
        await prisma.mediaAsset.findUnique({
          where: { id: template.id },
          select: { storageKey: true },
        })
      )?.storageKey;
      check(
        "the editor's view of an asset does not carry its storage key",
        !("storageKey" in template) && !JSON.stringify(template).includes(String(templateKey)),
        Object.keys(template).join(",")
      );
      check(
        "a template's key has the shape of a key and names no stored object",
        isStorageKey(String(templateKey)) && (await readObject(String(templateKey))) === null,
        String(templateKey)
      );
      const templateRow = { storageKey: String(templateKey), sourceUrl: null, templateUrl };
      check(
        "a template's URL is the link the seller opens, not a /uploads path",
        assetUrl(templateRow) === templateUrl,
        assetUrl(templateRow)
      );
      check(
        "every other asset's URL is its own stored object",
        assetUrl({ storageKey: String(templateKey), sourceUrl: null }) ===
          `/uploads/${templateKey}` &&
          assetUrl({ storageKey: String(templateKey), sourceUrl: "https://cdn.example/x.jpg" }) ===
            "https://cdn.example/x.jpg",
        assetUrl({ storageKey: String(templateKey), sourceUrl: null })
      );
      check(
        "a template reports no file size, because there are no bytes",
        template.fileSize === 0 && template.originalFilename.length > 0,
        `${template.fileSize} / ${template.originalFilename}`
      );

      const readBack = await getMedia(template.id);
      check(
        "the editor reads a template back with its link and its instruction",
        readBack?.templateUrl === templateUrl &&
          readBack?.instructions === "Keep the palette." &&
          readBack?.processingError === null,
        JSON.stringify({
          templateUrl: readBack?.templateUrl,
          instructions: readBack?.instructions,
          processingError: readBack?.processingError,
        })
      );

      let duplicateRefused = false;
      try {
        await createTemplateAsset(
          templateProduct.productId,
          { title: "Brand board again", templateUrl },
          ACTOR
        );
      } catch (error) {
        duplicateRefused = error instanceof DuplicateMediaError;
      }
      check("the same template link twice is refused as a duplicate", duplicateRefused);

      const skipped = await probeVideoAsset(template.id);
      check(
        "a template is not treated as a video to measure",
        skipped.status === "SKIPPED" && /not a video/.test(skipped.reason ?? ""),
        JSON.stringify(skipped)
      );
      const missing = await probeVideoAsset("no-such-asset-id");
      check(
        "an asset that no longer exists is skipped, not failed",
        missing.status === "SKIPPED",
        JSON.stringify(missing)
      );

      /* ------------------------------------------------------------------ */
      /* A video waiting on the probe, as the screen sees it                */
      /* ------------------------------------------------------------------ */
      const freshVideo = await makeStuckVideo(
        rangeProduct.productId,
        rangeProduct.variantId,
        bytes,
        "fresh.mp4"
      );
      const freshView = await getMedia(freshVideo);
      check(
        "a video waiting to be measured carries no error text",
        freshView?.processingStatus === "PROCESSING" && freshView?.processingError === null,
        JSON.stringify({ status: freshView?.processingStatus, error: freshView?.processingError })
      );

      /* ------------------------------------------------------------------ */
      /* The switch that turns probing off                                  */
      /* ------------------------------------------------------------------ */
      const offProduct = await makeProduct("Verify Media Probe Off");
      const offAsset = await makeStuckVideo(offProduct.productId, offProduct.variantId, bytes, "off.mp4");
      process.env.UPLOAD_VIDEO_PROBE = "off";
      try {
        const off = await probeVideoAsset(offAsset);
        check(
          "with probing switched off the row is left PROCESSING, not called FAILED",
          off.status === "SKIPPED" && /switched off/.test(off.reason ?? ""),
          JSON.stringify(off)
        );
        const offRow = await prisma.mediaAsset.findUnique({
          where: { id: offAsset },
          select: { processingStatus: true, processingError: true },
        });
        check(
          "nothing is written to the row when the probe is switched off",
          offRow?.processingStatus === "PROCESSING" && offRow?.processingError === null,
          JSON.stringify(offRow)
        );
      } finally {
        delete process.env.UPLOAD_VIDEO_PROBE;
      }
      const offSweep = await sweep();
      check(
        "a video paused by configuration is still in the sweep's scope",
        offSweep.considered >= 1,
        JSON.stringify(offSweep)
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

main()
  .catch((error) => {
    failures++;
    console.error("FAIL  the suite threw:", error);
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n${total - failures}/${total} checks passed`);
    process.exit(failures ? 1 : 0);
  });
