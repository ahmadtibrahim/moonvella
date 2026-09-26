import { requireMerchantAccess, AccessError } from "../services/seller.server";
import { buildMarketingPack } from "../services/marketingPack.server";
import { verifyDownloadToken } from "../services/downloadToken.server";
import { prisma } from "../db.server";

/**
 * The seller's Marketing Pack download.
 *
 * AUTHORIZATION IS THE WHOLE POINT OF THIS ROUTE. It is a document endpoint
 * that returns a file assembled from catalogue data, so three things have to be
 * true before a byte is produced:
 *
 *   1. The caller is an approved seller — either on an authenticated Shopify
 *      session, or holding a token this application minted for exactly this
 *      product and this store minutes ago. See below for why there are two.
 *   2. The product is published, active and not archived. That is the same gate
 *      the catalogue list applies, re-checked here because a URL can be kept
 *      and replayed after a product is withdrawn.
 *   3. Every asset inside the archive is approved, seller-visible and finished
 *      processing. That filter lives in the pack builder, which selects only
 *      the columns it is allowed to emit rather than removing the ones it is
 *      not.
 *
 * TWO WAYS IN, AND THE SESSION IS STILL THE FIRST. Loaded as a page inside the
 * admin frame, this is the same request it always was: a session, resolved from
 * the shop in it and never from the request. But the archive cannot be delivered
 * that way — a navigation inside the frame loses the frame parameters, and a
 * download inside the frame is blocked by the admin's sandbox — so the seller's
 * link opens a new top-level window at this URL carrying a signed token instead.
 * That window has no session and cannot have one. `downloadToken.server.ts`
 * holds the reasoning; what matters here is that the token names a SELLER, whose
 * access state is re-read from the database on every request, so a store blocked
 * after the link was drawn gets nothing. The token replaces the session, not the
 * authorization.
 *
 * It is a loader, not an action, because it changes nothing — a GET that
 * produced a side effect could be triggered by an image tag.
 */
export async function loader({ request }) {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  if (!productId) {
    throw new Response("Missing product.", { status: 400 });
  }

  const tokenClaims = verifyDownloadToken(url.searchParams.get("token"), {
    kind: "marketing_pack",
    resourceId: productId,
  });

  if (tokenClaims) {
    // The seller the token names, re-read: the token says who asked, not who
    // may have it.
    const seller = await prisma.seller.findUnique({
      where: { id: tokenClaims.sellerId },
      select: { status: true },
    });
    if (!seller || seller.status !== "APPROVED") {
      throw new Response("Product not available.", { status: 404 });
    }
  } else {
    try {
      // BUSINESS rather than "approved": a blocked store is owed the block
      // sentence, not a message about wholesale access that describes a state it
      // is not in. A refusal here reaches the layout's error boundary, which
      // renders the block card for exactly this message.
      await requireMerchantAccess(request, "BUSINESS");
    } catch (error) {
      if (error instanceof AccessError) {
        throw new Response(error.message, { status: 403 });
      }
      throw error;
    }
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
