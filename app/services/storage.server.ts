import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, extname, basename } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Storage abstraction for product images. The default implementation persists
 * files to local disk so they survive a restart. Swap this module for an object
 * storage implementation (S3, GCS, etc.) without changing callers.
 *
 * In production UPLOAD_DIR points at /app/uploads, which the compose file
 * bind-mounts from /opt/moonvella/uploads so uploaded images outlive container
 * rebuilds and replacements. Do not point this at a path inside the image.
 */
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? resolve(process.env.UPLOAD_DIR)
  : join(process.cwd(), "uploads");
const MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_TYPES = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

/**
 * Magic-byte signatures. A declared MIME type is attacker-controlled, so the
 * bytes are checked against it before anything is written to disk. This is what
 * stops an HTML or script payload from being stored behind an image extension.
 */
function detectImageType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.subarray(1, 4).toString("latin1") === "PNG") {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

const EXT_TO_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface StoredFile {
  url: string;
  filename: string;
}

export function isAllowedImageType(type: string): boolean {
  return ALLOWED_TYPES.has(type);
}

export async function saveProductImage(file: File): Promise<StoredFile> {
  if (!file || typeof file === "string") {
    throw new Error("No image file was provided.");
  }
  if (!isAllowedImageType(file.type)) {
    throw new Error(`Unsupported image type "${file.type}". Use PNG, JPEG, WEBP or GIF.`);
  }

  // Reject on the declared length before buffering, so an oversized body is
  // never pulled into memory.
  if (typeof file.size === "number" && file.size > MAX_BYTES) {
    throw new Error("The image exceeds the 5 MB limit.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("The uploaded image is empty.");
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error("The image exceeds the 5 MB limit.");
  }

  // The declared type must match what the bytes actually are.
  const actualType = detectImageType(buffer);
  if (!actualType || actualType !== file.type) {
    throw new Error(
      "The file contents do not match a supported image format (PNG, JPEG, WEBP or GIF)."
    );
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  // Filename is generated, never derived from user input, so it cannot traverse.
  const filename = `${Date.now()}-${randomBytes(8).toString("hex")}${
    ALLOWED_TYPES.get(actualType) ?? ".bin"
  }`;
  await writeFile(join(UPLOAD_DIR, filename), buffer, { mode: 0o644 });

  return { url: `/uploads/${filename}`, filename };
}

export async function readUpload(
  name: string
): Promise<{ data: Uint8Array; type: string } | null> {
  const safe = basename(name);
  if (safe !== name || !/^[A-Za-z0-9._-]+$/.test(safe)) {
    return null;
  }
  try {
    const data = await readFile(join(UPLOAD_DIR, safe));
    return {
      data: new Uint8Array(data),
      type: EXT_TO_TYPE[extname(safe).toLowerCase()] ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}
