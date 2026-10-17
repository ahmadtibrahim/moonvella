/**
 * The square brand icon at 1200 × 1200, as a download.
 *
 * A RESOURCE ROUTE WITH A LOADER, NOT AN ACTION THAT RETURNS A RESPONSE, and
 * that distinction is the whole reason this file exists.
 *
 * It was an `intent` on the branding page's action, returning
 * `new Response(pngBytes)`. React Router treats an action's return value as DATA
 * for the document it is about to re-render, not as the response itself — so the
 * page received a PNG as its action data, its own `"error" in actionData` check
 * ran against the bytes, and the operator got:
 *
 *     Application Error
 *     TypeError: Cannot use 'in' operator to search for 'error' in <PNG IHDR…>
 *
 * with the image itself rendered as garbled text. The same trap already claimed
 * the invoice and statement PDFs, which is why those are resource routes too.
 *
 * A GET with a loader cannot be mistaken for page data, the browser's own
 * download handling applies, and no session token has to travel in a query
 * string.
 *
 * NOTHING HERE CHANGES ANYTHING. It reads the uploaded square slot, pads it onto
 * a white square rather than stretching it, and returns the bytes. The Shopify
 * app icon itself lives in the Shopify Dev Dashboard and this page says so.
 */

import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { buildShopifyAppIcon } from "~/services/branding.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Settings, like the page that offers it — an unauthenticated caller must not
  // be able to pull the operator's artwork through this route.
  await requirePermission(request, "settings.general");

  const icon = await buildShopifyAppIcon();
  if (!icon) {
    // Readable, structured, and never a stack trace or a storage path.
    return new Response("Upload the square icon first, then download the app icon.", {
      status: 409,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return new Response(new Uint8Array(icon), {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": 'attachment; filename="moonvella-app-icon-1200.png"',
      "Cache-Control": "no-store",
    },
  });
}
