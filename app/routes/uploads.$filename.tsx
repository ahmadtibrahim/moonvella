import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "~/db.server";
import { contentTypeForKey, isStorageKey, readObject } from "~/services/storage.server";
import { getCurrentUser } from "~/utils/adminAuth.server";
import { isReadyForSellers } from "~/services/mediaState";

/**
 * Serves a stored object by its key.
 *
 * AUTHORIZATION. The key is 128 bits of randomness, so it is already
 * unguessable — but an unguessable name is a capability, not a permission: it
 * cannot be revoked, and anyone who comes to hold it (a referrer header, a
 * screenshot, a log line, a shared link) can read the bytes forever. So the
 * key is treated as a locator and the decision is made from the database, on
 * every request:
 *
 *   • An asset that is offered to sellers, finished processing, and on a
 *     product that is actually published is catalogue imagery. It is meant to be public, and
 *     requiring a session would break the storefront and the marketing pack.
 *
 *   • Everything else — a draft, a rejected file, an asset held back from
 *     sellers, anything on an unpublished or archived product — is internal
 *     until someone approves and publishes it, and needs a signed-in staff
 *     session. An anonymous request for one of those gets the same 404 that a
 *     key that does not exist gets, so the response cannot be used to discover
 *     which keys are real.
 *
 * The lookup is one indexed query per request. That is the cost of revocation:
 * a signed URL would avoid it, at the price of a token that cannot be
 * withdrawn before it expires.
 *
 * RANGE REQUESTS ARE SUPPORTED, and a video needs them. Without them a player
 * could not seek, and Safari — which opens every video with `Range: bytes=0-1`
 * and refuses to play a server that answers 200 — could not play an uploaded
 * video at all. The object is still read whole from the backend and sliced
 * here, because `StorageBackend.get` returns bytes rather than a stream;
 * streaming belongs in the backend interface, and until it is there the honest
 * cost is one full read per request rather than a video that does not play.
 *
 * NOT IMPLEMENTED, and worth knowing:
 *   • Multi-range requests. `bytes=0-1,5-6` is answered with the whole object,
 *     which RFC 9110 allows and which no video element asks for.
 *   • Seller-scoped access. A seller sees catalogue imagery because it is
 *     public; they cannot reach another seller's private material because
 *     there is none in this table. If per-seller private files are added, this
 *     is the route that must learn about them.
 */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const key = String(params.filename || "");

  // The key is the only thing that can name an object. Anything else — a path,
  // a traversal attempt, a stray extension — is refused here so it never
  // reaches a backend and never becomes a filesystem call.
  if (!isStorageKey(key)) {
    throw new Response("Not found", { status: 404 });
  }

  const asset = await prisma.mediaAsset.findUnique({
    where: { storageKey: key },
    select: {
      approvalStatus: true,
      sellerVisible: true,
      processingStatus: true,
      product: { select: { status: true, isActive: true, isArchived: true } },
    },
  });

  // A migrated asset has no stored object under a key of its own, and an
  // unknown key is simply not ours. Both are "not found" from here.
  if (!asset) {
    throw new Response("Not found", { status: 404 });
  }

  // The same question the catalogue asks — see `mediaState` — and then the
  // product's own state on top of it: a file that is offered to sellers is still
  // not public until the family it belongs to is published.
  const isPublicCatalogueImage =
    isReadyForSellers(asset) &&
    asset.product.status === "PUBLISHED" &&
    asset.product.isActive &&
    !asset.product.isArchived;

  if (!isPublicCatalogueImage) {
    const user = await getCurrentUser(request);
    // 404 rather than 403: a 403 would confirm that this key names a real
    // object, which is exactly what someone enumerating keys wants to learn.
    if (!user) {
      throw new Response("Not found", { status: 404 });
    }
  }

  const bytes = await readObject(key);
  if (!bytes) {
    throw new Response("Not found", { status: 404 });
  }

  const headers: Record<string, string> = {
    // From the key's extension, which the storage module chose after
    // identifying the bytes. Never from the uploader's filename.
    "Content-Type": contentTypeForKey(key),
    // Says, on every response including this one, that a range may be asked
    // for. A player that is told nothing may download the whole file before
    // showing a frame.
    "Accept-Ranges": "bytes",
    // Public catalogue imagery is immutable and safe to cache hard. An
    // internal asset is private to a signed-in session, so it is marked
    // private — a shared cache must not keep a copy.
    "Cache-Control": isPublicCatalogueImage
      ? "public, max-age=31536000, immutable"
      : "private, no-store",
    // Without this, a browser is free to treat the stored bytes as whatever
    // it sniffs them to be, which is how an uploaded file becomes a script.
    "X-Content-Type-Options": "nosniff",
    // Images and video are served inline — they are inert containers, and
    // inline is what lets a thumbnail or a preview play from this URL.
    //
    // A PDF is not. It is the one type on the allowlist that a browser hands
    // to a renderer capable of running code embedded in the file, and the
    // directive for this system says plainly that embedded PDF content is
    // not to be executed. We cannot control what the reader does with a
    // script inside a PDF it is asked to display, so we do not ask it to
    // display one: a document is downloaded and opened by the person who
    // wanted it, in whatever they trust. The application itself never parses
    // a PDF beyond its signature either.
    "Content-Disposition": contentTypeForKey(key) === "application/pdf" ? "attachment" : "inline",
  };

  const range = parseRange(request.headers.get("Range"), bytes.byteLength);

  if (range === "unsatisfiable") {
    // 416, with the total length so the client can ask again correctly. The
    // body stays empty: there is nothing to say beyond the header.
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${bytes.byteLength}` },
    });
  }

  if (range) {
    const chunk = bytes.subarray(range.start, range.end + 1);
    return new Response(chunk as unknown as BodyInit, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
        "Content-Length": String(chunk.byteLength),
      },
    });
  }

  return new Response(bytes as unknown as BodyInit, {
    headers: { ...headers, "Content-Length": String(bytes.byteLength) },
  });
}

/** A single range to serve, "unsatisfiable", or null to serve everything. */
type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Read a `Range` header.
 *
 * Only the single `bytes=` form is understood. Anything else — another unit, a
 * malformed value, the multi-range form no video element sends — is answered
 * by serving the whole object, which is what a server is allowed to do with a
 * range it does not implement, and which is always a correct answer.
 *
 * The three shapes RFC 9110 defines are all handled: `bytes=100-200`,
 * `bytes=100-` (to the end) and `bytes=-500` (the last 500 bytes). A range that
 * cannot be satisfied — a start past the end — is told apart from one that was
 * never asked for, because the first must be answered 416 and the second 200.
 */
export function parseRange(header: string | null, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  if (rawEnd === "") return { start, end: size - 1 };

  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  // A range that runs past the end is not an error: it is clamped, and the
  // Content-Range says what was actually sent.
  return { start, end: Math.min(end, size - 1) };
}
