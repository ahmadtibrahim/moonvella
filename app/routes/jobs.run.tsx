/**
 * The queue's entry point, called by cron.
 *
 * WHY AN ENDPOINT AND NOT A WORKER PROCESS. MoonVella runs as a single Node
 * process with no scheduler of its own. A second process would need its own
 * build, its own crash handling and its own copy of every guard, and would be
 * the second place where "is this store still allowed to do this" is decided.
 * A route handler inherits all of it: the same database, the same connector
 * guards, the same deployment.
 *
 * AUTHENTICATION IS A SHARED SECRET, AND IT FAILS CLOSED. If the secret is not
 * set in the deployment environment, this route refuses to run anything —
 * including for a caller who supplies no secret at all. The alternative, "run if
 * no secret is configured", would mean a missing environment variable turns an
 * authenticated endpoint into an open one that archives other people's
 * catalogues.
 *
 * The comparison is over SHA-256 digests rather than the strings themselves, so
 * that it is constant-time and so that a secret of any length is compared
 * without revealing its length by timing.
 *
 * WHAT IT DOES NOT DO. It does not accept a job kind or a seller from the
 * caller. The queue decides what runs; this endpoint only says "run what is
 * due". A caller who could name a job could ask for an archive that the access
 * version check exists to prevent.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { runDueJobs } from "~/services/jobs.server";
import { jobHandlers } from "~/services/jobHandlers.server";

const SECRET_ENV = "MV_JOB_RUNNER_SECRET";
/** How many jobs one call may claim. Small, so a cron tick stays quick. */
const BATCH = 20;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function authorised(request: Request): { ok: true } | { ok: false; status: number; message: string } {
  const expected = (process.env[SECRET_ENV] ?? "").trim();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      message:
        `The job runner is not configured: ${SECRET_ENV} is not set in the deployment ` +
        `environment, so this endpoint will not run anything. This is deliberate — an ` +
        `unauthenticated runner would let anyone archive a store's catalogue.`,
    };
  }

  const supplied = (request.headers.get("x-moonvella-job-secret") ?? "").trim();
  if (!supplied || !timingSafeEqual(digest(supplied), digest(expected))) {
    return { ok: false, status: 401, message: "Not authorised." };
  }
  return { ok: true };
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return new Response("Use POST.", { status: 405, headers: { Allow: "POST" } });
  }

  const allowed = authorised(request);
  if (!allowed.ok) {
    return new Response(allowed.message, {
      status: allowed.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const summary = await runDueJobs(jobHandlers, { limit: BATCH });

  return Response.json(
    { ran: summary, at: new Date().toISOString() },
    // A runner response is operational detail, not a public document.
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** A GET is a person looking; it must not run anything. */
export async function loader() {
  return new Response(
    "This endpoint runs the MoonVella job queue on demand and is called with POST by cron.",
    { status: 405, headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" } },
  );
}
