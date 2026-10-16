/**
 * Serves a MoonVella brand image, publicly.
 *
 * WHY THIS IS PUBLIC WHEN EVERY OTHER STORED OBJECT IS NOT. The logo has to
 * render on the sign-in page, in the favicon, and inside a PDF that a customer
 * keeps — none of which has a session. `uploads.$filename.tsx` deliberately
 * requires one for anything not published to sellers, and it is the right rule
 * there: catalogue imagery is a merchant's asset with a revocation story. The
 * brand is the operator's own mark, shown on a page whose whole purpose is to
 * ask someone to sign in, and a logo behind a session would be a logo that
 * cannot appear on the thing that precedes a session.
 *
 * WHAT IT IS NOT. It serves exactly the one live asset for the slot named in the
 * path, and only if the version and checksum in the path match that row. It is
 * not a general object reader: an arbitrary storage key in the path is a 404, so
 * the route cannot be used to enumerate or fetch media.
 *
 * THE PATH CARRIES THE CHECKSUM, which is what makes the bytes cacheable
 * forever. A replaced logo gets a new checksum and therefore a new URL, so no
 * cache anywhere has to be purged and a rollback does not serve a stale file.
 * `immutable` is safe precisely because of that, and it is the reason the URL is
 * built by `brandAssetPath` rather than hand-written at each call site.
 *
 * A 404 FOR EVERY FAILURE. Unknown slot, unknown version, wrong checksum, a
 * missing object — all the same response, because distinguishing them would let
 * a caller learn which slots exist and which versions were once uploaded.
 */

import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "~/db.server";
import { readObject } from "~/services/storage.server";
import { BRAND_SLOTS, type BrandSlot } from "~/services/branding.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const slotParam = (params.slot ?? "").toUpperCase() as BrandSlot;
  if (!BRAND_SLOTS.includes(slotParam)) return notFound();

  // "/brand/primary/3.ab12cd34ef56" — the version, then the checksum prefix.
  const asset = /^(\d+)\.([0-9a-f]{6,64})$/.exec(params.asset ?? "");
  if (!asset) return notFound();
  const version = Number(asset[1]);
  const checksumPrefix = asset[2];
  if (!Number.isInteger(version) || version < 1) return notFound();

  const row = await prisma.brandAsset.findUnique({
    where: { slot_version: { slot: slotParam, version } },
    select: { storageKey: true, contentType: true, checksum: true },
  });
  if (!row) return notFound();
  // The checksum in the path must describe the bytes we are about to send. A
  // path with a stale checksum is a stale cache entry, and answering it with the
  // new bytes would give the browser something different from what it asked for.
  if (row.checksum.slice(0, checksumPrefix.length) !== checksumPrefix) return notFound();

  const bytes = await readObject(row.storageKey);
  if (!bytes) return notFound();

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(bytes.length),
      // Safe because the URL contains the checksum of the bytes it returns.
      "Cache-Control": "public, max-age=31536000, immutable",
      // A logo is decoration, not content: if it fails to load the page must
      // still be usable, which is why nothing depends on this request.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}
