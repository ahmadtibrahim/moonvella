import { requireApprovedSeller, AccessError } from "../services/seller.server";
import { buildMarketingPack } from "../services/marketingPack.server";
import { prisma } from "../db.server";

/**
 * The seller's Marketing Pack download.
 *
 * AUTHORIZATION IS THE WHOLE POINT OF THIS ROUTE. It is a document endpoint
 * that returns a file assembled from catalogue data, so three things have to be
 * true before a byte is produced:
 *
 *   1. The caller is an approved seller on an authenticated Shopify session —
 *      `requireApprovedSeller`, which resolves the shop from the session and
 *      never from the request.
 *   2. The product is published, active and not archived. That is the same gate
 *      the catalogue list applies, re-checked here because a URL can be kept
 *      and replayed after a product is withdrawn.
 *   3. Every asset inside the archive is approved, seller-visible and finished
 *      processing. That filter lives in the pack builder, which selects only
 *      the columns it is allowed to emit rather than removing the ones it is
 *      not.
 *
 * It is a loader, not an action, because it changes nothing — a GET that
 * produced a side effect could be triggered by an image tag.
 */
export async function loader({ request }) {
  let context;
  try {
    context = await requireApprovedSeller(request);
  } catch (error) {
    if (error instanceof AccessError) {
      throw new Response(error.message, { status: 403 });
    }
    throw error;
  }

  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  if (!productId) {
    throw new Response("Missing product.", { status: 400 });
  }

  // Belt and braces: confirm the product is one this seller could be shown at
  // all, so a product that is merely unpublished cannot be downloaded by a
  // seller who guessed its id.
  const visible = await prisma.product.findFirst({
    where: { id: productId, status: "PUBLISHED", isActive: true, isArchived: false },
    select: { id: true },
  });
  if (!visible) {
    throw new Response("Product not available.", { status: 404 });
  }

  const pack = await buildMarketingPack(productId);
  if (!pack) {
    throw new Response("Product not available.", { status: 404 });
  }
  if (pack.files.length === 0) {
    // An empty archive is a worse answer than an explanation: it opens in the
    // seller's file manager looking like a bug.
    throw new Response("This product has no marketing files available yet.", { status: 404 });
  }

  return new Response(pack.bytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(pack.bytes.byteLength),
      // The filename is the product code, already reduced to [a-z0-9-] by the
      // builder, so it cannot break out of the quoted string.
      "Content-Disposition": `attachment; filename="${pack.filename}"`,
      // Per-seller and assembled on demand; a shared cache must not keep it.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
