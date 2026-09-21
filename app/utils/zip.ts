/**
 * A deterministic ZIP writer.
 *
 * WHY NOT A LIBRARY. There is no ZIP package in the dependency tree and the
 * build host has no network, so adding one is not possible here. That turns out
 * to be the better answer anyway: this writer stores entries uncompressed
 * (method 0), which means the bytes depend only on the input bytes and the
 * header fields we choose — so the same product contents produce a byte-for-byte
 * identical archive every time. A general-purpose archiver makes no such
 * promise, and Phase 23 needs to rebuild and compare.
 *
 * WHAT IT DOES NOT DO. No compression, no ZIP64, no encryption, no directory
 * entries (folders exist because the paths contain "/"). Archives are capped at
 * `MAX_ARCHIVE_BYTES` and refuse rather than emit something a reader will
 * reject. Stored entries are the right trade: images, video and PDFs are already
 * compressed, so deflating them saves single-digit percent and costs CPU.
 */

/** Refuse to build an archive larger than this. Guards ZIP32 offset limits. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export interface ZipEntry {
  /**
   * Path inside the archive, using "/" separators. Must be relative, must not
   * begin with "/", must not contain "..".
   */
  path: string;
  bytes: Uint8Array;
}

/* -------------------------------------------------------------------------- */
/* CRC-32                                                                     */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Header fields                                                              */
/* -------------------------------------------------------------------------- */

/**
 * MS-DOS date and time, the only timestamp format ZIP32 has.
 *
 * Clamped to 1980-01-01, the earliest value the format can express, because a
 * pre-1980 date would encode as a negative field and corrupt the header.
 */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = when.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const date = ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const time =
    (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  return { time, date };
}

/** Paths are emitted as UTF-8 with bit 11 set so a reader does not decode them as CP437. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  get size(): number {
    return this.length;
  }

  u16(value: number): void {
    this.raw(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.raw(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ])
    );
  }

  raw(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/**
 * A path that cannot escape the archive or collide with a sibling.
 *
 * `..` is refused rather than rewritten: a path that tried to leave is a bug in
 * the caller, and silently sanitising it would hide that. Control characters
 * and backslashes are refused for the same reason — a reader on Windows would
 * treat "\" as a separator and produce a different tree than we described.
 */
export function isSafeEntryPath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\") || path.includes("//")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/**
 * Builds the archive bytes.
 *
 * `generatedAt` is a parameter rather than a call to `Date.now()` so a caller
 * can pin it and get reproducible output; two runs over the same assets with
 * the same timestamp are byte-identical.
 */
export function buildZip(entries: ZipEntry[], generatedAt: Date): Uint8Array {
  if (entries.length === 0) {
    throw new Error("Cannot build an archive with no entries.");
  }
  if (entries.length > 0xffff) {
    throw new Error(`Too many files for one archive (${entries.length}).`);
  }

  const seen = new Set<string>();
  const { time, date } = dosDateTime(generatedAt);
  const body = new ByteWriter();
  const central = new ByteWriter();

  // Sorted, so entry order does not depend on how the caller collected them.
  const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const entry of ordered) {
    if (!isSafeEntryPath(entry.path)) {
      throw new Error(`Unsafe path in archive: ${JSON.stringify(entry.path)}`);
    }
    if (seen.has(entry.path)) {
      throw new Error(`Two files would be written to the same path: ${entry.path}`);
    }
    seen.add(entry.path);

    const nameBytes = new TextEncoder().encode(entry.path);
    const crc = crc32(entry.bytes);
    const localOffset = body.size;

    body.u32(0x04034b50); // local file header
    body.u16(20); // version needed
    body.u16(FLAG_UTF8);
    body.u16(METHOD_STORE);
    body.u16(time);
    body.u16(date);
    body.u32(crc);
    body.u32(entry.bytes.length); // compressed size == uncompressed (stored)
    body.u32(entry.bytes.length);
    body.u16(nameBytes.length);
    body.u16(0); // extra field length
    body.raw(nameBytes);
    body.raw(entry.bytes);

    central.u32(0x02014b50); // central directory header
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(FLAG_UTF8);
    central.u16(METHOD_STORE);
    central.u16(time);
    central.u16(date);
    central.u32(crc);
    central.u32(entry.bytes.length);
    central.u32(entry.bytes.length);
    central.u16(nameBytes.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk number
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(localOffset);
    central.raw(nameBytes);
  }

  const centralBytes = central.concat();
  const total = body.size + centralBytes.length + 22;
  if (total > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `This pack would be ${Math.round(total / 1024 / 1024)} MB, over the ${Math.round(
        MAX_ARCHIVE_BYTES / 1024 / 1024
      )} MB limit for a single archive.`
    );
  }

  const end = new ByteWriter();
  end.u32(0x06054b50); // end of central directory
  end.u16(0); // this disk
  end.u16(0); // disk with central directory
  end.u16(ordered.length);
  end.u16(ordered.length);
  end.u32(centralBytes.length);
  end.u32(body.size);
  end.u16(0); // comment length

  const out = new ByteWriter();
  out.raw(body.concat());
  out.raw(centralBytes);
  out.raw(end.concat());
  return out.concat();
}
