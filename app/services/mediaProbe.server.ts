/**
 * Finishing what an upload started: measuring a video.
 *
 * A video is not READY when its bytes are stored. It is READY when its length
 * is known, because publication gates on `video_duration` and an asset that
 * claims READY without a duration is an asset nobody can check. Before this
 * module existed every video sat at PROCESSING forever: the probe ran during
 * upload, the image had no ffprobe, and nothing ever tried again. The upload
 * path still measures inline — it is fast and it saves a round trip through the
 * queue — but a failure there is no longer the end of the story.
 *
 * Two ways in, and they are deliberately different:
 *
 * 1. The SWEEP, on the queue's clock (every five minutes), re-probes every video
 *    still marked PROCESSING. That is what rescues the assets uploaded by an
 *    image without ffmpeg, and what catches an upload whose enqueue was lost.
 *    It looks only at PROCESSING rows, which is what keeps it from looping: a
 *    row it has already touched is READY or FAILED and drops out of its scope.
 *
 * 2. A RETRY, asked for by a person looking at a FAILED tile. Nothing retries a
 *    failed probe on its own — a file ffprobe cannot decode will not start
 *    decoding on the sixth attempt, and a queue that keeps re-reading a broken
 *    upload is a queue that hides the fact that somebody has to look at it.
 *
 * Both paths end in the same place: the row is terminal. Every branch of
 * `probeVideoAsset` writes READY or FAILED (or skips a row that is already
 * decided), so no run of this module can leave a video in a state that invites
 * another run.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { JOB_KIND, enqueueJob } from "./jobs.server";
import {
  isStorageKey,
  probeStoredVideo,
  probeVideoBytes,
  readObject,
  storedObjectPath,
} from "./storage.server";
import type { VideoProbe } from "./storage.server";
import type { CatalogActor } from "./products.server";

/** How many stuck videos one sweep will look at. */
const SWEEP_LIMIT = 25;

/** The idempotency key for the probe of one asset, before any retry suffix. */
export function videoProbeKey(assetId: string): string {
  return `${JOB_KIND.MEDIA_VIDEO_PROBE}:${assetId}`;
}

export interface ProbeOutcome {
  assetId: string;
  status: "READY" | "FAILED" | "SKIPPED";
  /** Why it is not READY, in words an operator can act on. */
  reason?: string;
  seconds?: number;
}

/**
 * Measure one asset and record the answer. Safe to run twice: the second run
 * measures the same bytes and writes the same row, and a row that is already
 * measured is not touched at all.
 */
export async function probeVideoAsset(assetId: string): Promise<ProbeOutcome> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      storageKey: true,
      mimeType: true,
      width: true,
      height: true,
      processingStatus: true,
      durationSeconds: true,
    },
  });
  if (!asset) return { assetId, status: "SKIPPED", reason: "the asset no longer exists" };
  if (!asset.mimeType.startsWith("video/")) {
    return { assetId, status: "SKIPPED", reason: "the asset is not a video" };
  }
  if (asset.processingStatus === "READY" && asset.durationSeconds !== null) {
    return { assetId, status: "SKIPPED", reason: "the video has already been measured" };
  }
  if (process.env.UPLOAD_VIDEO_PROBE === "off") {
    // Left PROCESSING rather than called FAILED: nothing is wrong with the
    // file, an operator has switched the probe off, and a FAILED tile would
    // invite a retry that is configured not to work.
    return {
      assetId,
      status: "SKIPPED",
      reason: "the video probe is switched off by configuration",
    };
  }

  const measured = await measure(asset);
  if (measured.status === "unavailable") {
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { processingStatus: "FAILED", processingError: measured.reason },
    });
    return { assetId, status: "FAILED", reason: measured.reason };
  }

  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: {
      processingStatus: "READY",
      // The column is an Int and ffprobe answers in fractional seconds. Rounded
      // rather than truncated, and rounded the same way the inline upload probe
      // rounds, so the two paths cannot disagree about the same file by a
      // second.
      durationSeconds: Math.round(measured.seconds),
      // Cleared, not left behind: a tile that says FAILED while also showing
      // the reason for an earlier failure is worse than either alone.
      processingError: null,
      // Frame size is filled in only where it is missing, so a re-probe cannot
      // overwrite a measurement that came from somewhere better.
      ...(asset.width === null && measured.width !== null
        ? { width: measured.width, height: measured.height }
        : {}),
    },
  });
  return { assetId, status: "READY", seconds: measured.seconds };
}

/**
 * Where the bytes are, and what came back.
 *
 * A stored file is probed in place. A row whose key predates this storage
 * system has no bytes here at all, and a backend that is not a filesystem has
 * no path to offer, so the bytes are read back through the storage interface
 * instead — the path a future object store would take. Both are reported as
 * themselves rather than as "the file is broken", because they need different
 * answers from a person.
 */
async function measure(asset: { storageKey: string }): Promise<VideoProbe> {
  if (storedObjectPath(asset.storageKey)) {
    const probe = await probeStoredVideo(asset.storageKey);
    if (probe) return probe;
    return {
      status: "unavailable",
      reason: "the stored file is missing from the uploads volume; upload it again",
    };
  }

  if (!isStorageKey(asset.storageKey)) {
    return {
      status: "unavailable",
      reason:
        "this file was recorded before videos were stored here, so there are no bytes to measure; upload it again",
    };
  }

  const bytes = await readObject(asset.storageKey);
  if (!bytes) {
    return {
      status: "unavailable",
      reason: "the stored file could not be read; upload it again",
    };
  }
  return probeVideoBytes(bytes);
}

export interface ProbeSweepSummary {
  /** Videos found still marked PROCESSING. */
  considered: number;
  /** Probes queued for them, new rows only. */
  enqueued: number;
  /** How many were already queued or running. */
  alreadyQueued: number;
  errors: string[];
}

/**
 * Queue a probe for every video still stuck at PROCESSING.
 *
 * The row is not probed here. This runs inside the queue's own tick, and a
 * tick that spent a minute decoding video would hold the lease while other
 * work waited; the probe goes on the queue as its own job where it can fail,
 * be retried and be seen.
 *
 * Idempotent through the per-asset key: a second sweep before the first
 * probe has run finds the job already there and adds nothing. A video that
 * has since reached READY or FAILED is no longer in scope.
 */
export async function sweepVideoProbes(limit: number = SWEEP_LIMIT): Promise<ProbeSweepSummary> {
  const stuck = await prisma.mediaAsset.findMany({
    where: { processingStatus: "PROCESSING", mimeType: { startsWith: "video/" } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const summary: ProbeSweepSummary = {
    considered: stuck.length,
    enqueued: 0,
    alreadyQueued: 0,
    errors: [],
  };

  for (const asset of stuck) {
    try {
      const key = videoProbeKey(asset.id);
      const existing = await prisma.backgroundJob.findUnique({ where: { idempotencyKey: key } });
      const job = await enqueueJob({
        kind: JOB_KIND.MEDIA_VIDEO_PROBE,
        idempotencyKey: key,
        payload: { assetId: asset.id, sweep: true },
      });
      // `enqueueJob` returns the row it found when the key is already
      // satisfied, so "was there one before" is the only honest way to tell a
      // newly queued probe from one that was already waiting.
      if (existing && existing.createdAt.getTime() === job.createdAt.getTime()) {
        summary.alreadyQueued += 1;
      } else {
        summary.enqueued += 1;
      }
    } catch (error) {
      summary.errors.push(
        `${asset.id}: ${error instanceof Error ? error.message : "could not be queued"}`,
      );
    }
  }

  return summary;
}

/**
 * Ask for one more attempt at a video a person is looking at.
 *
 * The row goes back to PROCESSING first — so the tile shows progress instead of
 * the failure the retry was meant to clear, and so a lost job is picked up by
 * the next sweep — and the probe is then queued under a fresh key. A fresh key
 * is necessary: the queue treats a SUCCEEDED row as already-satisfied, and the
 * first attempt succeeded in the only sense the queue knows, because a probe
 * that ends FAILED is a probe that ran correctly.
 */
export async function retryVideoProbe(assetId: string, actor: CatalogActor): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { id: true, mimeType: true, processingStatus: true, processingError: true },
  });
  if (!asset) throw new Error("Asset not found.");
  if (!asset.mimeType.startsWith("video/")) {
    throw new Error("Only a video has a length to measure.");
  }

  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: { processingStatus: "PROCESSING", processingError: null },
  });

  const base = videoProbeKey(assetId);
  const attempts = await prisma.backgroundJob.count({
    where: { idempotencyKey: { startsWith: base } },
  });
  await enqueueJob({
    kind: JOB_KIND.MEDIA_VIDEO_PROBE,
    // Named by attempt number rather than by time, so the jobs list reads as
    // "third attempt at this video" instead of a row of timestamps.
    idempotencyKey: `${base}:${attempts + 1}`,
    payload: { assetId, retry: true },
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.probe_retried",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assetId,
    beforeData: {
      processingStatus: asset.processingStatus,
      processingError: asset.processingError,
    },
    afterData: { processingStatus: "PROCESSING" },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}
