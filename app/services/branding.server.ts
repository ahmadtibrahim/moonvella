/**
 * MoonVella's own brand: the logo, the display name, and where each one shows.
 *
 * WHY THE LOGO IS A DATABASE ROW AND NOT A FILE ON DISK. It has to reach four
 * surfaces, and the PDF is the one that settles the design. The packing slip and
 * the invoice are rendered by PDFKit, which embeds an image by being handed a
 * Buffer — it does not fetch a URL. A logo that lives only as a path the running
 * process may or may not be able to open is a logo that prints blank on the one
 * document a customer keeps. Storing the bytes through the same `StorageBackend`
 * as media means the renderer resolves a row and gets bytes, and the same asset
 * serves the browser through a URL.
 *
 * EVERY UPLOAD IS RE-ENCODED, NOT STORED AS RECEIVED. This is the part of the
 * work order that is easy to fake and expensive to get wrong. A PNG with a
 * crafted header, a JPEG carrying an ICC profile that crashes a decoder, or a
 * file whose first bytes say PNG and whose tenth kilobyte is an ELF payload are
 * all "images" to a magic-number check. So the bytes are decoded and re-encoded
 * with ffmpeg, which:
 *
 *   * proves the file actually decodes as an image, because a decoder had to do
 *     it — a malformed file fails here rather than in a browser or a PDF;
 *   * strips metadata, because the encoder writes a fresh container and the
 *     source's EXIF, XMP, GPS and colour profiles are not carried across — the
 *     owner's phone photo cannot leak where it was taken into a customer PDF;
 *   * bounds the pixel dimensions, by scaling down rather than refusing, so a
 *     6000px upload becomes a usable asset instead of an error;
 *   * means the stored bytes are OURS. Nothing from the upload survives except
 *     the pixels.
 *
 * ffmpeg is already in the image (the video probe uses it), so this adds no
 * dependency. When it is unavailable the service REFUSES the upload rather than
 * storing an unsanitised file — the check is not best-effort.
 *
 * SVG IS NOT ACCEPTED, and cannot be added without a sanitizer. An SVG is a
 * document that can carry script and external references; serving one from the
 * app's own origin, on the login page, is cross-site scripting with extra steps.
 * Raster only.
 *
 * WHAT THE RETAILER CANNOT DO. Nothing here is reachable from the seller
 * surface. The brand is global and operator-owned; a merchant's own logo is a
 * separate, tenant-owned setting (`SellerBrandKit`) and the two are never
 * merged — see `applyBrandToPackingList` for where the distinction is drawn on a
 * printed document.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrandSlot } from "@prisma/client";

// Re-exported so a route can name a slot without importing the Prisma client
// namespace into a module boundary that has no business holding one.
export type { BrandSlot };
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import {
  createLocalBackend,
  deleteObject,
  newStorageKey,
  objectExists,
  readObject,
  type StorageBackend,
} from "./storage.server";

/** The slots, in the order the page shows them. */
export const BRAND_SLOTS: readonly BrandSlot[] = ["PRIMARY", "DARK", "SQUARE", "INVOICE"];

export interface BrandSlotSpec {
  slot: BrandSlot;
  label: string;
  /** What this slot is for, in the operator's words. */
  purpose: string;
  /** A short note about the shape it should be. */
  shape: string;
  /** The slot this one falls back to when it is empty. */
  fallback: BrandSlot | null;
}

export const BRAND_SLOT_SPECS: readonly BrandSlotSpec[] = [
  {
    slot: "PRIMARY",
    label: "Primary logo",
    purpose: "Used everywhere by default: the admin sidebar, the embedded app header and invoices.",
    shape: "Horizontal, with the wordmark. Around 540 × 180. PNG, JPEG or WebP.",
    fallback: null,
  },
  {
    slot: "DARK",
    label: "Dark-background variant",
    purpose:
      "Used on the navy sidebar and navy headers. Without one the primary logo is shown on a white backing, because a navy mark on a navy bar is invisible.",
    shape: "Same layout as the primary, drawn for a dark background.",
    fallback: "PRIMARY",
  },
  {
    slot: "SQUARE",
    label: "Square icon",
    purpose:
      "The favicon, and the source for the 1200 × 1200 image the Shopify app icon is built from.",
    shape: "Square, at least 512 × 512 so the 1200 px export stays sharp.",
    fallback: "PRIMARY",
  },
  {
    slot: "INVOICE",
    label: "Invoice logo",
    purpose: "Prints on invoices and statements. Leave empty to use the primary logo.",
    shape: "Wide work best — the invoice header is a horizontal band.",
    fallback: "PRIMARY",
  },
];

/** The upload ceiling. The work order's number, and it is generous for a logo. */
export const BRAND_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * The largest stored edge. An upload bigger than this is SCALED DOWN, not
 * refused: an operator whose export is 6000 px wide has a usable logo, and the
 * only reason to hold a limit at all is that every stored pixel is a pixel the
 * PDF renderer has to decode.
 */
export const BRAND_MAX_EDGE = 2000;

/** The longest an upload's declared filename is kept, for the operator's eye. */
const MAX_ORIGINAL_NAME = 120;

/** The extension each accepted type is stored under. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export type BrandSlotState = {
  slot: BrandSlot;
  live: {
    id: string;
    version: number;
    contentType: string;
    width: number;
    height: number;
    bytes: number;
    checksum: string;
    url: string;
    createdAt: Date;
    createdByName: string | null;
  } | null;
  /** Every earlier version, newest first, so a person can roll back. */
  history: {
    id: string;
    version: number;
    width: number;
    height: number;
    bytes: number;
    url: string;
    createdAt: Date;
    createdByName: string | null;
  }[];
  /** Where this slot's image actually comes from, after the fallback chain. */
  effective: BrandSlot | null;
};

export interface BrandView {
  displayName: string;
  /** The name the brand falls back to when none has been set. */
  defaultDisplayName: string;
  slots: BrandSlotState[];
}

/**
 * What the app calls itself when the owner has not said.
 *
 * Deliberately not read from the environment: the display name is a brand
 * decision, and a deployment variable is the wrong place for one — it would make
 * renaming the product a restart rather than a click.
 */
export const DEFAULT_DISPLAY_NAME = "MoonVella";

/** The preference key the display name lives under. */
export const DISPLAY_NAME_KEY = "brand_display_name";

/** The public path a slot's stored asset is served from. */
export function brandAssetPath(slot: BrandSlot, version: number, checksum: string): string {
  // The checksum, not the version number, is what busts the cache. A rollback
  // re-uses a version number with different bytes if the asset was re-encoded
  // since, and a version-keyed URL would then serve the stale file from every
  // cache between here and the browser.
  return `/brand/${slot.toLowerCase()}/${version}.${checksum.slice(0, 12)}`;
}

/* -------------------------------------------------------------------------- */
/* Sanitising                                                                 */
/* -------------------------------------------------------------------------- */

export type SanitizeResult =
  | { status: "ok"; bytes: Buffer; contentType: string; width: number; height: number }
  | { status: "refused"; reason: string };

/** Whether the image tooling this service depends on is present. */
let ffmpegProbe: Promise<boolean> | null = null;
export function hasFfmpeg(): Promise<boolean> {
  if (!ffmpegProbe) {
    ffmpegProbe = new Promise((resolve) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }
  return ffmpegProbe;
}

/**
 * Read the pixel dimensions out of an encoded image's header.
 *
 * ffmpeg will not tell us the OUTPUT size without running it, and running it is
 * exactly what we are doing — but we need the size BEFORE the run to decide
 * whether to scale. The header carries it for all three formats, and reading it
 * is a few bytes of arithmetic rather than a decode.
 *
 * Returns null for anything it does not recognise, which the caller treats as a
 * refusal: a header we cannot read is not a header we can bound.
 */
export function readImageSize(
  bytes: Buffer,
  contentType: string
): { width: number; height: number } | null {
  try {
    if (contentType === "image/png") {
      // 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4).
      if (bytes.length < 24) return null;
      if (bytes.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (contentType === "image/jpeg") {
      // Walk the marker segments to the start-of-frame, which carries the size.
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        // Start of frame: baseline, progressive and the arithmetic variants.
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        // Standalone markers carry no length.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const length = bytes.readUInt16BE(offset + 2);
        if (length < 2) return null;
        offset += 2 + length;
      }
      return null;
    }
    if (contentType === "image/webp") {
      if (bytes.length < 30) return null;
      if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
        return null;
      }
      const fourcc = bytes.toString("ascii", 12, 16);
      if (fourcc === "VP8X") {
        // 24-bit little-endian, minus one, in each direction.
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width: w, height: h };
      }
      if (fourcc === "VP8 ") {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode, strip and re-encode an uploaded image.
 *
 * The output is always PNG or JPEG — never WebP — because those are the two
 * formats every PDF renderer and every mail client in the world draws, and the
 * stored asset has to print. A WebP upload is accepted and converted; a PNG with
 * transparency keeps it (JPEG would flatten it to black).
 */
export async function sanitizeImage(input: {
  bytes: Buffer;
  contentType: string;
  /** Injected so a suite can drive this without ffmpeg present. */
  runner?: ImageRunner;
}): Promise<SanitizeResult> {
  const runner: ImageRunner = input.runner ?? runFfmpeg;

  const size = readImageSize(input.bytes, input.contentType);
  if (!size || size.width < 1 || size.height < 1) {
    return {
      status: "refused",
      reason:
        "The image header could not be read, so its size could not be checked. The file is " +
        "malformed or is not really an image.",
    };
  }
  if (size.width > 12000 || size.height > 12000) {
    return {
      status: "refused",
      reason: `The image is ${size.width} × ${size.height}px, which is too large to decode safely.`,
    };
  }

  // PNG when the source is PNG or carries transparency; JPEG otherwise. Both
  // branches are decided from the SOURCE, because converting a logo with a
  // transparent background to JPEG would replace it with a black rectangle.
  const outType = input.contentType === "image/png" || input.contentType === "image/webp"
    ? "image/png"
    : "image/jpeg";

  const scale = Math.min(1, BRAND_MAX_EDGE / Math.max(size.width, size.height));
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "input.bin",
    // ONE FRAME. An animated WebP or a multi-page file would otherwise produce a
    // sequence, and ffmpeg would write the last frame as the logo.
    "-frames:v", "1",
    // Strip every container-level metadata block: EXIF, XMP, GPS, ICC, chapters.
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    // A deterministic filter chain rather than a passthrough, so the encoder
    // re-runs even when the image needs no scaling.
    "-vf", scale < 1 ? `scale=${Math.round(size.width * scale)}:-2` : "scale=iw:ih",
  ];
  await runner(args, input.bytes, outType === "image/png" ? "out.png" : "out.jpg");
  if (!runner.output) {
    return { status: "refused", reason: runner.error ?? "The image could not be re-encoded." };
  }

  const encoded = runner.output;
  const finalSize = readImageSize(encoded, outType);
  if (!finalSize) {
    return {
      status: "refused",
      reason: "The re-encoded image could not be read back, so it was not stored.",
    };
  }

  return {
    status: "ok",
    bytes: encoded,
    contentType: outType,
    width: finalSize.width,
    height: finalSize.height,
  };
}

/**
 * The ffmpeg invocation, and its output.
 *
 * Shaped as a small object rather than a function so a suite can substitute one:
 * the interesting behaviour of `sanitizeImage` is about its DECISIONS — what it
 * refuses, how it scales — and those must be checkable on a host where the
 * assertion is not "whatever ffmpeg happens to do".
 */
export interface ImageRunner {
  (args: string[], input: Buffer, outputName: string): Promise<void>;
  output?: Buffer;
  error?: string;
}

/**
 * The real runner. An `ImageRunner` value rather than a bare function: the call
 * writes its result onto itself, which is what lets a substitute be swapped in
 * without the caller having to know which kind it got.
 */
const runFfmpeg: ImageRunner = Object.assign(
  async (args: string[], input: Buffer, outputName: string): Promise<void> => {
    runFfmpeg.output = undefined;
    runFfmpeg.error = undefined;

    const workspace = await mkdtemp(join(tmpdir(), "mv-brand-"));
    try {
      await writeFile(join(workspace, "input.bin"), input);
      const code = await new Promise<number>((resolve) => {
        const child = spawn("ffmpeg", [...args, outputName], { cwd: workspace, stdio: "ignore" });
        child.on("error", () => resolve(-1));
        child.on("close", (value) => resolve(value ?? -1));
      });
      if (code !== 0) {
        runFfmpeg.error =
          "ffmpeg could not decode the upload. The file may be a format we do not support, a " +
          "truncated download, or not an image at all.";
        return;
      }
      runFfmpeg.output = await readFile(join(workspace, outputName));
    } catch {
      runFfmpeg.error = "The image could not be re-encoded.";
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  },
  { output: undefined as Buffer | undefined, error: undefined as string | undefined }
);

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The live version of a slot, or the slot it falls back to, or null.
 *
 * The fallback chain is walked rather than stored, and it is bounded: a slot
 * whose fallback is itself cannot loop, because the spec table is the only place
 * fallbacks are declared and none of them points at itself.
 */
export async function effectiveSlot(slot: BrandSlot): Promise<BrandSlot | null> {
  let current: BrandSlot | null = slot;
  const seen = new Set<BrandSlot>();
  while (current) {
    if (seen.has(current)) return null;
    seen.add(current);
    const live = await prisma.brandAsset.findFirst({
      where: { slot: current, supersededAt: null },
      select: { id: true },
    });
    if (live) return current;
    current = BRAND_SLOT_SPECS.find((spec) => spec.slot === current)?.fallback ?? null;
  }
  return null;
}

export async function getDisplayName(): Promise<string> {
  const row = await prisma.adminPreference.findUnique({ where: { key: DISPLAY_NAME_KEY } });
  const value = row?.value?.trim();
  return value ? value : DEFAULT_DISPLAY_NAME;
}

/** Everything the branding page and the surfaces need. */
export async function getBrandView(): Promise<BrandView> {
  const rows = await prisma.brandAsset.findMany({ orderBy: [{ slot: "asc" }, { version: "desc" }] });
  const displayName = await getDisplayName();

  const slots: BrandSlotState[] = [];
  for (const spec of BRAND_SLOT_SPECS) {
    const forSlot = rows.filter((row) => row.slot === spec.slot);
    const live = forSlot.find((row) => row.supersededAt === null) ?? null;
    slots.push({
      slot: spec.slot,
      live: live
        ? {
            id: live.id,
            version: live.version,
            contentType: live.contentType,
            width: live.width,
            height: live.height,
            bytes: live.bytes,
            checksum: live.checksum,
            url: brandAssetPath(live.slot, live.version, live.checksum),
            createdAt: live.createdAt,
            createdByName: live.createdByName,
          }
        : null,
      history: forSlot
        .filter((row) => row.supersededAt !== null)
        .map((row) => ({
          id: row.id,
          version: row.version,
          width: row.width,
          height: row.height,
          bytes: row.bytes,
          url: brandAssetPath(row.slot, row.version, row.checksum),
          createdAt: row.createdAt,
          createdByName: row.createdByName,
        })),
      effective: await effectiveSlot(spec.slot),
    });
  }

  return { displayName, defaultDisplayName: DEFAULT_DISPLAY_NAME, slots };
}

/**
 * The bytes of a slot's live asset, for a PDF renderer.
 *
 * Resolved through the FALLBACK CHAIN, so an empty invoice slot prints the
 * primary logo rather than nothing — which is what the work order asks for
 * ("invoice logo, default to primary") and is the opposite of what a plain
 * lookup would do.
 */
export async function brandImageFor(slot: BrandSlot): Promise<Buffer | null> {
  const effective = await effectiveSlot(slot);
  if (!effective) return null;
  const live = await prisma.brandAsset.findFirst({
    where: { slot: effective, supersededAt: null },
    select: { storageKey: true },
  });
  if (!live) return null;
  const bytes = await readObject(live.storageKey);
  return bytes ? Buffer.from(bytes) : null;
}

/**
 * The URL of a slot's live asset, resolved through the fallback chain.
 *
 * The SERVER-SIDE counterpart of `brandImageFor`, for the surfaces that render
 * HTML rather than a PDF. Returned as a path, not an absolute URL: the app is
 * reached under more than one hostname (the admin host and the embedded app
 * host), and an absolute URL built from one of them is a logo that 404s or
 * breaks the frame on the other.
 */
export async function brandImageUrl(slot: BrandSlot): Promise<string | null> {
  const effective = await effectiveSlot(slot);
  if (!effective) return null;
  const live = await prisma.brandAsset.findFirst({
    where: { slot: effective, supersededAt: null },
    select: { slot: true, version: true, checksum: true },
  });
  if (!live) return null;
  return brandAssetPath(live.slot, live.version, live.checksum);
}

/**
 * The live asset for a slot WITHOUT the fallback chain — what a URL serves.
 *
 * The public route resolves the exact slot it was asked for rather than walking
 * the chain, so a client that fetched `/brand/invoice/…` and got the primary
 * logo knows that is what it got, and a cache entry is never about a slot other
 * than the one in its path.
 */
export async function liveAssetFor(slot: BrandSlot) {
  return prisma.brandAsset.findFirst({ where: { slot, supersededAt: null } });
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface BrandActor {
  id: string;
  name?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Replace a slot's logo, keeping the previous version.
 *
 * The order is: sanitise first, store the sanitised bytes second, and only then
 * touch the database. Sanitising last would leave a stored object for a file
 * that was refused; superseding first would leave the slot with NO live version
 * for as long as the upload took, which on a slow file is a window in which the
 * sidebar and a PDF render without a logo at all.
 *
 * The version number is derived from the highest existing one for the slot
 * rather than from a counter, so a rolled-back slot re-uses the numbers it
 * already has instead of drifting upward forever.
 */
export async function replaceBrandSlot(
  slot: BrandSlot,
  file: File,
  actor: BrandActor,
  backend: StorageBackend = createLocalBackend()
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  if (!BRAND_SLOTS.includes(slot)) return { ok: false, error: "Unknown brand slot." };

  if (typeof file?.arrayBuffer !== "function") return { ok: false, error: "No file was provided." };

  const declared = (file.type || "").toLowerCase().split(";")[0].trim();
  if (declared === "image/svg+xml" || declared === "image/svg") {
    return {
      ok: false,
      error:
        "SVG is not accepted. An SVG is a document that can carry script and external " +
        "references, and this one would be served from the app's own origin — including on the " +
        "sign-in page. Upload a PNG, JPEG or WebP instead.",
    };
  }
  const extension = EXTENSIONS[declared];
  if (!extension) {
    return { ok: false, error: "Brand images must be PNG, JPEG or WebP." };
  }

  if (Number.isFinite(file.size) && file.size > BRAND_MAX_UPLOAD_BYTES) {
    return { ok: false, error: "The file is larger than 5 MB." };
  }
  const raw = Buffer.from(await file.arrayBuffer());
  if (raw.length === 0) return { ok: false, error: "The uploaded file is empty." };
  if (raw.length > BRAND_MAX_UPLOAD_BYTES) return { ok: false, error: "The file is larger than 5 MB." };

  // The bytes must be what they claim to be. `saveUpload`'s detector is reused
  // rather than reimplemented: one signature table, one place to be wrong.
  const detected = detectBrandSignature(raw);
  if (detected !== declared) {
    return {
      ok: false,
      error: "The file contents do not match the type the upload declared.",
    };
  }

  if (!(await hasFfmpeg())) {
    return {
      ok: false,
      error:
        "The image tooling is unavailable in this deployment, so the upload cannot be sanitised " +
        "and will not be stored. This is a deployment problem, not a problem with the file.",
    };
  }

  const sanitized = await sanitizeImage({ bytes: raw, contentType: declared });
  if (sanitized.status === "refused") return { ok: false, error: sanitized.reason };

  const checksum = createHash("sha256").update(sanitized.bytes).digest("hex");
  const key = newStorageKey(extension);
  await backend.put(key, sanitized.bytes);

  const previous = await prisma.brandAsset.findFirst({ where: { slot, supersededAt: null } });
  const highest = await prisma.brandAsset.findFirst({
    where: { slot },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (highest?.version ?? 0) + 1;

  try {
    await prisma.$transaction(async (tx) => {
      if (previous) {
        await tx.brandAsset.update({
          where: { id: previous.id },
          data: { supersededAt: new Date() },
        });
      }
      await tx.brandAsset.create({
        data: {
          slot,
          version,
          storageKey: key,
          contentType: sanitized.contentType,
          width: sanitized.width,
          height: sanitized.height,
          bytes: sanitized.bytes.length,
          checksum,
          originalName: sanitizeBrandName(file.name),
          createdById: actor.id,
          createdByName: actor.name ?? null,
        },
      });
    });
  } catch (error) {
    // The object is already written and nothing points at it. Removing it here
    // rather than leaving it is the difference between one orphan and one per
    // failed upload.
    await backend.remove(key).catch(() => {});
    throw error;
  }

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "brand.asset_replaced",
    entityType: AUDIT_ENTITY.ADMIN_PREFERENCE,
    entityId: `${slot}`,
    beforeData: previous
      ? { slot, version: previous.version, bytes: previous.bytes }
      : { slot, version: null },
    afterData: {
      slot,
      version,
      width: sanitized.width,
      height: sanitized.height,
      bytes: sanitized.bytes.length,
      checksum,
      originalName: sanitizeBrandName(file.name),
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return { ok: true, version };
}

/**
 * Put an earlier version back.
 *
 * A ROLLBACK, NOT A RE-UPLOAD, and the distinction is the point: the bytes being
 * restored are the ones that were already approved and already printed, so no
 * new decode happens and no new sanitisation decision is taken. The current live
 * version is superseded and the chosen one is un-superseded, in one transaction,
 * so the slot is never without a live row.
 */
export async function restoreBrandVersion(
  slot: BrandSlot,
  version: number,
  actor: BrandActor
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = await prisma.brandAsset.findUnique({
    where: { slot_version: { slot, version } },
  });
  if (!target) return { ok: false, error: `Version ${version} of ${slot} does not exist.` };

  await prisma.$transaction(async (tx) => {
    await tx.brandAsset.updateMany({
      where: { slot, supersededAt: null },
      data: { supersededAt: new Date() },
    });
    await tx.brandAsset.update({ where: { id: target.id }, data: { supersededAt: null } });
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "brand.version_restored",
    entityType: AUDIT_ENTITY.ADMIN_PREFERENCE,
    entityId: slot,
    afterData: { slot, version },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return { ok: true };
}

/**
 * Clear a slot, returning it to its fallback.
 *
 * The rows are KEPT and the live one superseded, so "reset to default" is
 * reversible in the same way a replacement is — an operator who clears the
 * invoice logo and then wants it back does not have to find the file again.
 */
export async function resetBrandSlot(
  slot: BrandSlot,
  actor: BrandActor
): Promise<{ ok: true } | { ok: false; error: string }> {
  const live = await prisma.brandAsset.findFirst({ where: { slot, supersededAt: null } });
  if (!live) return { ok: false, error: `${slot} is already using its default.` };

  await prisma.brandAsset.update({ where: { id: live.id }, data: { supersededAt: new Date() } });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "brand.slot_reset",
    entityType: AUDIT_ENTITY.ADMIN_PREFERENCE,
    entityId: slot,
    beforeData: { slot, version: live.version },
    afterData: { slot, version: null, fallbackTo: BRAND_SLOT_SPECS.find((s) => s.slot === slot)?.fallback ?? null },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return { ok: true };
}

/** Set the name the app calls itself. Empty clears it back to the default. */
export async function setDisplayName(value: string, actor: BrandActor): Promise<string> {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 60);
  const before = await getDisplayName();

  if (!cleaned) {
    await prisma.adminPreference.deleteMany({ where: { key: DISPLAY_NAME_KEY } });
  } else {
    await prisma.adminPreference.upsert({
      where: { key: DISPLAY_NAME_KEY },
      create: { key: DISPLAY_NAME_KEY, value: cleaned },
      update: { value: cleaned },
    });
  }

  const after = await getDisplayName();
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "brand.display_name_changed",
    entityType: AUDIT_ENTITY.ADMIN_PREFERENCE,
    entityId: DISPLAY_NAME_KEY,
    beforeData: { displayName: before },
    afterData: { displayName: after },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });
  return after;
}

/** Keep only the basename, drop control characters, and cap the length. */
export function sanitizeBrandName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/["'<>|:*?]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, MAX_ORIGINAL_NAME) || "brand-image";
}

/**
 * The signature table, restricted to the three accepted image formats.
 *
 * Deliberately narrower than `saveUpload`'s: a brand slot is an image and only
 * an image, so GIF (which animates) and PDF (which is a document) are refused
 * here even though the media library accepts them.
 */
export function detectBrandSignature(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Delete an orphaned stored object. Only used by the suite and by an operator
 * cleaning up after a failed write; nothing in the live path deletes a version,
 * because every version is a rollback target.
 */
export async function purgeBrandObject(key: string): Promise<boolean> {
  if (!(await objectExists(key))) return false;
  return deleteObject(key);
}

/**
 * The largest square icon the app can offer Shopify, built from the uploaded
 * square slot.
 *
 * Shopify's app icon is set in the Dev Dashboard and is NOT updated by an upload
 * here — saying otherwise would be the same class of lie as a Connected badge
 * over a switched-off integration. This produces the FILE, and the page tells
 * the operator where to put it.
 */
export async function buildShopifyAppIcon(size = 1200): Promise<Buffer | null> {
  const source = await brandImageFor("SQUARE");
  if (!source || !(await hasFfmpeg())) return null;
  const runner = runFfmpeg;
  // Padded onto a white square rather than stretched: the work order is explicit
  // that aspect ratio is preserved and nothing is stretched, and a non-square
  // mark padded is the only honest way to reach a required square.
  await runner(
    [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "input.bin",
      "-frames:v", "1",
      "-map_metadata", "-1",
      "-vf",
      `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white`,
    ],
    source,
    "icon.png"
  );
  return runner.output ?? null;
}
