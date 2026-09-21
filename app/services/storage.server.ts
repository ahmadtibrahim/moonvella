import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Storage for uploaded product media.
 *
 * Two properties are the reason this is a module rather than a few lines in a
 * route. First, no byte is stored before it has been identified from its own
 * contents: the declared content type is checked for *agreement* and never
 * trusted, the size ceiling is enforced on the bytes actually read, and the
 * uploader's filename is display metadata that is never used to build a path.
 * Second, what this module throws is shown to a user, so an error must never
 * carry a filesystem path.
 *
 * The object store itself sits behind `StorageBackend`, which only moves bytes.
 * Validation, checksums and key generation are all backend-independent, so
 * adding S3 later means implementing the interface and branching in
 * `getStorage()` — no caller, no database column and no key format changes.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** The three ceilings and validation rules differ by kind, so kind is explicit. */
export type MediaKind = "image" | "document" | "video";

/**
 * What a stored object is, and the only handle a caller needs to fetch it
 * again. `key` is what belongs in MediaAsset.storageKey; `checksum` in
 * MediaAsset.checksum.
 */
export interface StoredObject {
  key: string;
  /** `/uploads/<key>` — the app's serving route. */
  url: string;
  /** sha256, hex. Identical bytes always produce an identical value. */
  checksum: string;
  mimeType: string;
  kind: MediaKind;
  /** Bytes stored, as measured here rather than as declared by the client. */
  size: number;
  /** Sanitised. Display only — never a path, never a key. */
  originalFilename: string;
  /** Null for documents, and for a video whose duration could not be measured. */
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** Why `durationSeconds` is null, when it is. */
  durationProbe: DurationProbe;
}

/**
 * Whether a video's duration was measured. A missing probe is reported rather
 * than assumed away, so a caller can mark the asset as unverified instead of
 * publishing a clip nobody has checked.
 */
export type DurationProbe =
  | { status: "measured"; seconds: number }
  | { status: "not-video" }
  | { status: "unavailable"; reason: string };

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where objects live. The container's root filesystem is read-only, so the
 * write target has to be a mount: in production /app/uploads is a bind mount of
 * /var/lib/moonvella/uploads that outlives image rebuilds. Never a path inside
 * the image, never /tmp, never the git working tree.
 */
const DEFAULT_UPLOAD_DIR = "/app/uploads";

const MB = 1024 * 1024;

/**
 * Read per call rather than captured at import, so an operator can retune a
 * ceiling by environment and a test can lower one without reloading the module.
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Per-kind size ceilings. Anything larger is refused before it is buffered. */
export function uploadLimits(): Record<MediaKind, number> {
  return {
    image: envPositiveInt("UPLOAD_MAX_IMAGE_BYTES", 20 * MB),
    document: envPositiveInt("UPLOAD_MAX_PDF_BYTES", 25 * MB),
    video: envPositiveInt("UPLOAD_MAX_VIDEO_BYTES", 200 * MB),
  };
}

/* -------------------------------------------------------------------------- */
/* Allowlist and signatures                                                   */
/* -------------------------------------------------------------------------- */

interface AllowedType {
  /** The extension given to the stored object. Ours, never the uploader's. */
  extension: string;
  kind: MediaKind;
}

/**
 * The complete set of types that may be stored. Everything not listed is
 * refused, which is what keeps executables, archives, HTML and XML out without
 * having to enumerate them.
 *
 * SVG is absent deliberately: it is a script and document format, and rendering
 * one from this origin would be stored XSS. Serving it needs a sanitiser and a
 * sandboxed origin; until then refusing it is the only safe answer.
 */
const ALLOWED_TYPES = new Map<string, AllowedType>([
  ["image/png", { extension: "png", kind: "image" }],
  ["image/jpeg", { extension: "jpg", kind: "image" }],
  ["image/webp", { extension: "webp", kind: "image" }],
  ["image/gif", { extension: "gif", kind: "image" }],
  ["application/pdf", { extension: "pdf", kind: "document" }],
  ["video/mp4", { extension: "mp4", kind: "video" }],
  ["video/webm", { extension: "webm", kind: "video" }],
]);

/**
 * Spellings that unambiguously mean a type already on the allowlist. Only
 * aliases, never a second meaning: nothing here widens what can be stored.
 */
const DECLARED_ALIASES = new Map<string, string>([["image/jpg", "image/jpeg"]]);

/**
 * Executable formats. They cannot reach storage — nothing in ALLOWED_TYPES
 * claims them — but they are named here so the refusal is deliberate and
 * survives someone later adding a permissive entry to the allowlist.
 */
const EXECUTABLE_MAGIC: { label: string; match: (bytes: Buffer) => boolean }[] = [
  { label: "ELF", match: (b) => b.length >= 4 && b.readUInt32BE(0) === 0x7f454c46 },
  { label: "Windows PE", match: (b) => b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a },
  {
    label: "Mach-O",
    match: (b) =>
      b.length >= 4 &&
      (b.readUInt32BE(0) === 0xfeedface ||
        b.readUInt32BE(0) === 0xcefaedfe ||
        b.readUInt32BE(0) === 0xcffaedfe ||
        b.readUInt32BE(0) === 0xfeedfacf),
  },
  { label: "Java class", match: (b) => b.length >= 4 && b.readUInt32BE(0) === 0xcafebabe },
  { label: "WebAssembly", match: (b) => b.length >= 4 && b.readUInt32BE(0) === 0x0061736d },
  {
    label: "shell script",
    match: (b) => b.length >= 2 && b[0] === 0x23 && b[1] === 0x21,
  },
];

/** ISO base media brands that identify a real MP4 rather than some other container. */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "mmp4",
  "msdh",
  "M4V ",
  "M4A ",
  "M4VH",
]);

/**
 * Identify the bytes themselves and return the one type they may be declared
 * as. This — not the request — is the authority: the declared type is compared
 * against this result, so a payload cannot be labelled into a better fate than
 * its own contents earn it.
 */
function detectSignature(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  // A PDF reader may skip leading junk, so the header is looked for where a
  // reader would look. Nothing past this marker is parsed: embedded scripts,
  // actions and attachments are never touched, let alone executed.
  if (bytes.subarray(0, 1024).includes("%PDF-")) {
    return "application/pdf";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1");
    return MP4_BRANDS.has(brand) ? "video/mp4" : null;
  }
  // EBML, then the DocType that distinguishes WebM from Matroska (which is not
  // on the allowlist). Both are ASCII inside the header, near the start.
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    const header = bytes.subarray(0, 256).toString("latin1");
    if (header.includes("webm")) return "video/webm";
    return null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Image dimensions                                                           */
/* -------------------------------------------------------------------------- */

interface Dimensions {
  width: number;
  height: number;
}

function pngDimensions(bytes: Buffer): Dimensions | null {
  // Signature(8) + chunk length(4) + "IHDR"(4) + width(4) + height(4).
  if (bytes.length < 24 || bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes: Buffer): Dimensions | null {
  // "GIF89a" + logical screen descriptor.
  if (bytes.length < 10) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegDimensions(bytes: Buffer): Dimensions | null {
  let offset = 2; // past SOI
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // A run of 0xFF bytes may pad a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    offset += 2;
    // Standalone markers carry no length field.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // Start of scan: if no SOF was seen before it, there is no header to read.
    if (marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    // SOF0-SOF15, minus the three markers in that range that are not SOFs.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (length < 7) return null;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Buffer): Dimensions | null {
  const chunk = bytes.subarray(12, 16).toString("latin1");
  // Extended format: canvas size, minus one, as 24-bit little-endian pairs.
  if (chunk === "VP8X") {
    if (bytes.length < 30) return null;
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  // Lossless: 14 bits of width then 14 bits of height, minus one, bit-packed.
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  // Lossy: dimensions follow the 3-byte start code inside the frame header.
  const sync = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
  if (sync === -1 || sync + 7 > bytes.length) return null;
  return {
    width: bytes.readUInt16LE(sync + 3) & 0x3fff,
    height: bytes.readUInt16LE(sync + 5) & 0x3fff,
  };
}

/**
 * Dimensions from the header bytes. `sharp` is not a dependency and one is not
 * being added for this, so the four formats on the allowlist are decoded here —
 * header fields only, never pixel data, so nothing is decompressed and a
 * decompression bomb costs nothing until the bytes are actually rendered.
 */
function imageDimensions(mimeType: string, bytes: Buffer): Dimensions | null {
  switch (mimeType) {
    case "image/png":
      return pngDimensions(bytes);
    case "image/gif":
      return gifDimensions(bytes);
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Video duration                                                             */
/* -------------------------------------------------------------------------- */

/** Cached answer to "is ffprobe usable here?" — undefined until first asked. */
let ffprobeAvailable: boolean | null = null;

async function hasFfprobe(): Promise<boolean> {
  if (process.env.UPLOAD_VIDEO_PROBE === "off") return false;
  if (ffprobeAvailable !== null) return ffprobeAvailable;
  ffprobeAvailable = await new Promise<boolean>((resolveProbe) => {
    execFile("ffprobe", ["-version"], { timeout: 5000 }, (error) => resolveProbe(!error));
  });
  return ffprobeAvailable;
}

/**
 * Duration of a video, measured with ffprobe when this image has it.
 *
 * ffprobe is NOT installed in the moonvella image (node:22-alpine, with only
 * openssl and libc6-compat added), so in production this reports
 * `unavailable` and no duration is recorded. That is the honest outcome: a
 * duration parsed by hand out of a container header would be an unverified
 * number stored next to verified ones, and the caller can gate publication on
 * the probe status instead. Set UPLOAD_VIDEO_PROBE=off to skip the attempt
 * entirely.
 *
 * The probe reads a private copy: ffprobe is given a path inside a fresh
 * temporary directory rather than anything that encodes a real object key, its
 * stderr is never propagated (it quotes the input path), and the directory is
 * removed whatever happens. Note that /tmp in this container is a 64 MB tmpfs,
 * so a video far larger than that cannot be probed even where ffprobe exists.
 */
async function probeVideoDuration(bytes: Buffer): Promise<DurationProbe> {
  if (process.env.UPLOAD_VIDEO_PROBE === "off") {
    return { status: "unavailable", reason: "the duration probe is switched off by configuration" };
  }
  if (!(await hasFfprobe())) {
    return { status: "unavailable", reason: "ffprobe is not installed in this image" };
  }

  let workspace: string | null = null;
  try {
    workspace = await mkdtemp(join(tmpdir(), "moonvella-probe-"));
    const input = join(workspace, "input");
    await writeFile(input, bytes);

    const stdout = await new Promise<string>((resolveProbe, rejectProbe) => {
      execFile(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          input,
        ],
        { timeout: 20000, maxBuffer: 64 * 1024 },
        (error, out) => (error ? rejectProbe(error) : resolveProbe(out))
      );
    });

    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { status: "unavailable", reason: "the duration probe returned no usable value" };
    }
    return { status: "measured", seconds };
  } catch {
    // Fixed text: the underlying error quotes the temporary path.
    return { status: "unavailable", reason: "the duration probe could not run" };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Storage backend                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Object operations, and nothing else. A backend is handed bytes and an opaque
 * key; it is never asked about content types, checksums or names, because those
 * are decided before it is called and must stay identical whichever backend is
 * underneath.
 */
export interface StorageBackend {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
}

/**
 * A key is 32 random hex characters plus a server-chosen extension: flat, no
 * directory part, nothing a client supplied. Every path a backend builds is
 * built from this shape alone.
 */
const KEY_PATTERN = /^[0-9a-f]{32}\.[a-z0-9]{2,5}$/;

export function isStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Errors from here reach a user, so none of them carry a path. */
const STORE_FAILED = "The file could not be stored. Please try again.";
const READ_FAILED = "The file could not be read.";
const DELETE_FAILED = "The file could not be deleted.";

/**
 * Local filesystem backend. The only place in the app that knows where objects
 * physically live.
 */
export function createLocalBackend(root: string = process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR): StorageBackend {
  const base = resolve(root);

  function pathFor(key: string): string {
    if (!isStorageKey(key)) throw new Error("Invalid storage key.");
    const target = resolve(base, key);
    // The pattern already rules out separators and "..", so this can only fire
    // if that pattern is ever loosened. Cheap insurance against a future edit.
    if (!target.startsWith(base + sep)) throw new Error("Invalid storage key.");
    return target;
  }

  return {
    async put(key, bytes) {
      const target = pathFor(key);
      try {
        await mkdir(base, { recursive: true });
        // "wx" refuses to overwrite. Keys are random, so a collision means a
        // generator bug, and clobbering an existing asset would be data loss.
        await writeFile(target, bytes, { mode: 0o644, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
          throw new Error("An object with this key already exists.");
        }
        throw new Error(STORE_FAILED);
      }
    },

    async get(key) {
      // A key that does not match the storage format names no object, and the
      // honest answer to "give me the bytes under this key" is then null —
      // the same answer as a key whose file has gone. This matters because a
      // migrated row's key is exactly that: it keeps the identifier the file
      // had before this storage system existed, and `pathFor` refuses it. Left
      // to fall through, the refusal would be caught below and re-thrown as a
      // read failure, so a caller's "is there anything to read?" branch would
      // never be reached and a whole marketing pack would fail to build over
      // one legacy photograph.
      if (!isStorageKey(key)) return null;
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw new Error(READ_FAILED);
      }
    },

    async remove(key) {
      try {
        await unlink(pathFor(key));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw new Error(DELETE_FAILED);
      }
    },

    async has(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

let backend: StorageBackend | null = null;

/**
 * The configured backend. This is the seam: an S3 implementation is selected
 * here and nothing above changes — callers already hold only a key and never a
 * path.
 */
export function getStorage(): StorageBackend {
  if (backend) return backend;
  const configured = process.env.STORAGE_BACKEND || "local";
  if (configured !== "local") {
    // Named rather than silently falling back to disk: an operator asking for
    // S3 and getting local files would find out from the data, not the logs.
    throw new Error(`Storage backend "${configured}" is not configured in this build.`);
  }
  backend = createLocalBackend();
  return backend;
}

/* -------------------------------------------------------------------------- */
/* Checksums and names                                                        */
/* -------------------------------------------------------------------------- */

/** sha256 of the stored bytes, hex. The value MediaAsset.checksum holds. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Checksum of an upload, without storing it.
 *
 * Duplicate detection is a database question and belongs to the caller, which
 * has the model: compute the checksum here, then look it up against the indexed
 * `MediaAsset.checksum` column. Finding an existing row means the bytes are
 * already stored under another key and only the row needs writing.
 */
export async function checksumForUpload(file: File): Promise<string> {
  if (!isFileLike(file)) throw new Error("No file was provided.");
  return checksumOf(Buffer.from(await file.arrayBuffer()));
}

/**
 * The uploader's filename, reduced to something safe to display.
 *
 * Display is all it is for: the stored key is generated from random bytes and
 * the verified type, so a name containing "../" or an absolute path has nothing
 * to influence. This exists so that a name echoed back into a page cannot carry
 * control characters, quotes or a directory part into the interface.
 */
export function sanitizeDisplayName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  // Anything after a separator is the name; everything before it is a path.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // Control and format characters: a newline in a display name breaks a log
    // line, and a bidi override can make a name read as something it is not.
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/["'<>|:*?]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return "upload";
  // Long names are kept recognisable rather than rejected.
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

function isFileLike(value: unknown): value is File {
  return (
    !!value &&
    typeof value !== "string" &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).size === "number"
  );
}

/**
 * The declared type, normalised for comparison. Parameters are dropped and a
 * known alias resolved; anything else is returned as sent, to be judged by the
 * allowlist. An absent or generic type stays as it is and is therefore refused —
 * an upload that will not say what it is does not get the benefit of the doubt.
 */
function normalizeDeclaredMime(declared: unknown): string {
  const value = typeof declared === "string" ? declared.trim().toLowerCase().split(";")[0].trim() : "";
  return DECLARED_ALIASES.get(value) ?? value;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

export interface SaveUploadOptions {
  /** Override the configured backend — tests, and a future S3 migration run. */
  backend?: StorageBackend;
}

/**
 * Validate an upload and store it.
 *
 * Order matters: the cheap refusals happen before the bytes are buffered, the
 * size ceiling is applied to the bytes actually read rather than the length the
 * client claimed, and the declared type is only ever compared against the type
 * the bytes identify as. The key is generated last, from randomness and the
 * verified type alone.
 */
export async function saveUpload(file: File, options: SaveUploadOptions = {}): Promise<StoredObject> {
  if (!isFileLike(file)) throw new Error("No file was provided.");

  const declared = normalizeDeclaredMime(file.type);
  const allowed = ALLOWED_TYPES.get(declared);
  if (!allowed) {
    throw new Error(
      "Unsupported file type. Upload a PNG, JPEG, WEBP, GIF, PDF, MP4 or WEBM file."
    );
  }

  const limit = uploadLimits()[allowed.kind];

  // Refuse the claimed length before buffering, so an oversized body is not
  // read into memory. The real length is checked again below.
  if (Number.isFinite(file.size) && file.size > limit) {
    throw new Error(oversizeMessage(limit));
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) throw new Error("The uploaded file is empty.");
  if (bytes.length > limit) throw new Error(oversizeMessage(limit));

  for (const executable of EXECUTABLE_MAGIC) {
    if (executable.match(bytes)) {
      throw new Error("Executable files cannot be uploaded.");
    }
  }

  const detected = detectSignature(bytes);
  if (!detected) {
    throw new Error("The file contents are not a supported PNG, JPEG, WEBP, GIF, PDF, MP4 or WEBM file.");
  }
  if (detected !== declared) {
    throw new Error("The file contents do not match the type the upload declared.");
  }

  let width: number | null = null;
  let height: number | null = null;
  if (allowed.kind === "image") {
    const dimensions = imageDimensions(detected, bytes);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
      // Unreadable dimensions mean the header is malformed, not merely unusual.
      throw new Error("The image header could not be read.");
    }
    const maxSide = envPositiveInt("UPLOAD_MAX_IMAGE_SIDE", 20000);
    const maxPixels = envPositiveInt("UPLOAD_MAX_IMAGE_PIXELS", 100_000_000);
    if (dimensions.width > maxSide || dimensions.height > maxSide) {
      throw new Error(`Images may be at most ${maxSide} pixels on a side.`);
    }
    if (dimensions.width * dimensions.height > maxPixels) {
      throw new Error("The image has more pixels than this catalogue accepts.");
    }
    width = dimensions.width;
    height = dimensions.height;
  }

  let durationSeconds: number | null = null;
  let durationProbe: DurationProbe = { status: "not-video" };
  if (allowed.kind === "video") {
    durationProbe = await probeVideoDuration(bytes);
    if (durationProbe.status === "measured") {
      const maxSeconds = envPositiveInt("UPLOAD_MAX_VIDEO_SECONDS", 3600);
      if (durationProbe.seconds > maxSeconds) {
        throw new Error(tooLongMessage(maxSeconds));
      }
      durationSeconds = Math.round(durationProbe.seconds);
    }
  }

  // Random, flat, extension from the verified type. Nothing here derives from
  // the uploader, so no name — "../../etc/passwd", "/etc/shadow", a 4 kB of
  // emoji — can reach a path.
  const key = `${randomBytes(16).toString("hex")}.${allowed.extension}`;
  await (options.backend ?? getStorage()).put(key, bytes);

  return {
    key,
    url: `/uploads/${key}`,
    checksum: checksumOf(bytes),
    mimeType: detected,
    kind: allowed.kind,
    size: bytes.length,
    originalFilename: sanitizeDisplayName(file.name),
    width,
    height,
    durationSeconds,
    durationProbe,
  };
}

function oversizeMessage(limit: number): string {
  // A ceiling below 1 MB is legitimate (a test, a restrictive deployment), so
  // the message never rounds it away to "0 MB".
  const described = limit >= MB ? `${Math.round(limit / MB)} MB` : `${limit} bytes`;
  return `The file is larger than the ${described} limit for this kind of media.`;
}

function tooLongMessage(seconds: number): string {
  const described = seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
  return `Videos may be at most ${described} long.`;
}

/* -------------------------------------------------------------------------- */
/* Read, delete, exist                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Content type for a stored key, from the extension the server gave it.
 *
 * The extension is not a claim by anyone: it is appended by `saveUpload` after
 * the bytes were identified, so it is as trustworthy as the key itself. The
 * database's `MediaAsset.mimeType` remains the record of what a file *is*; this
 * is what a response can be labelled with without a query.
 */
export function contentTypeForKey(key: string): string {
  const extension = key.slice(key.lastIndexOf(".") + 1);
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "pdf":
      return "application/pdf";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

/** An object's bytes, or null when it is not there. */
export function readObject(key: string): Promise<Uint8Array | null> {
  return getStorage().get(key);
}

/** Remove an object. Returns whether it existed. */
export function deleteObject(key: string): Promise<boolean> {
  return getStorage().remove(key);
}

/** Whether an object is present. For integrity checks, not for authorization. */
export function objectExists(key: string): Promise<boolean> {
  return getStorage().has(key);
}
