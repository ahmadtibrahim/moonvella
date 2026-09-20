import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Storage abstraction for product images. The default implementation persists
 * files to local disk so they survive a restart. Swap this module for an object
 * storage implementation (S3, GCS, etc.) without changing callers.
 */
const UPLOAD_DIR = join(process.cwd(), "uploads");
const MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_TYPES = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

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

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("The uploaded image is empty.");
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error("The image exceeds the 5 MB limit.");
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${randomBytes(8).toString("hex")}${
    ALLOWED_TYPES.get(file.type) ?? ".bin"
  }`;
  await writeFile(join(UPLOAD_DIR, filename), buffer);

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
