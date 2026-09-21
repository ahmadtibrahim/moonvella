import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "~/db.server";
import { contentTypeForKey, isStorageKey, readObject } from "~/services/storage.server";
import { getCurrentUser } from "~/utils/adminAuth.server";

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
 *   • An asset that is APPROVED, seller-visible, and on a product that is
 *     actually published is catalogue imagery. It is meant to be public, and
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
 * NOT IMPLEMENTED, and worth knowing:
 *   • Range requests. `StorageBackend.get` returns whole bytes, so a video
 *     plays from the start and cannot be seeked. Range support belongs in the
 *     backend interface and a streaming response, not in this loader.
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
      product: { select: { status: true, isActive: true, isArchived: true } },
    },
  });

  // A migrated asset has no stored object under a key of its own, and an
  // unknown key is simply not ours. Both are "not found" from here.
  if (!asset) {
    throw new Response("Not found", { status: 404 });
  }

  const isPublicCatalogueImage =
    asset.approvalStatus === "APPROVED" &&
    asset.sellerVisible &&
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

  return new Response(bytes as unknown as BodyInit, {
    headers: {
      // From the key's extension, which the storage module chose after
      // identifying the bytes. Never from the uploader's filename.
      "Content-Type": contentTypeForKey(key),
      "Content-Length": String(bytes.byteLength),
      // Public catalogue imagery is immutable and safe to cache hard. An
      // internal asset is private to a signed-in session, so it is marked
      // private — a shared cache must not keep a copy.
      "Cache-Control": isPublicCatalogueImage
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
      // Without this, a browser is free to treat the stored bytes as whatever
      // it sniffs them to be, which is how an uploaded file becomes a script.
      "X-Content-Type-Options": "nosniff",
      // Never render a stored file as a document; it is an image or a download.
      "Content-Disposition": "inline",
    },
  });
}
