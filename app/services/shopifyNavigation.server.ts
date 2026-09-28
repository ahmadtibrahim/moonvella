/**
 * Where the browser goes when it comes back from a provider.
 *
 * WHY THIS IS NOT `${url.origin}/app/billing`, WHICH IS WHAT IT REPLACES.
 *
 * A Stripe Checkout session cannot be completed in an iframe — Stripe refuses
 * to render and says so in the console: "Stripe Checkout is not able to run in
 * an iFrame. Please redirect to Checkout at the top level." So the setup flow
 * hands the URL to the TOP window, which leaves the Shopify admin entirely.
 * Whatever the session then sends the browser back to is a top-level page, and
 * a top-level page on the app's own origin is not the embedded app: it is a
 * bare document with no `host`, no `id_token` and no App Bridge, so the next
 * thing it can do is show "MoonVella has to be opened from your Shopify admin".
 * That is the same dead end this codebase has already fixed once, arriving by a
 * different road.
 *
 * Coming back THROUGH the admin is what re-establishes the frame: the admin
 * loads the app in a fresh iframe with a fresh `host` and `id_token`, and the
 * embedded session is minted again on that load. So the return URL is an admin
 * URL, and it is built here rather than at each call site.
 *
 * WHY IT PREFERS THE `host` PARAMETER. `host` is the authoritative statement of
 * which admin and which store the request came from — base64 of, for example,
 * `admin.shopify.com/store/moonvilla-sandbox`. It survives custom domains, where
 * a `*.myshopify.com` handle is not the store's address at all. The parameter is
 * attacker-controllable, though, so it is DECODED AND THEN CHECKED against a
 * strict shape before any of it reaches a URL: this function's output is handed
 * to a browser as a navigation target, and "we built it from a request" is not
 * the same as "it is safe to follow". Anything that does not match falls back to
 * the derived admin address rather than being followed.
 */

/**
 * The app's client id. This is the `apps/<id>` segment the admin uses for an app
 * that has no handle yet, and it is what the framework's own
 * `getEmbeddedAppUrl` builds — see `@shopify/shopify-api`'s
 * `buildEmbeddedAppUrl`. Reaching for the client id rather than the app's
 * human-facing handle means this does not break if the handle is ever renamed.
 */
const CLIENT_ID = process.env.SHOPIFY_API_KEY ?? "";

/**
 * The only decoded host this will follow: an admin address for a store, on a
 * domain Shopify actually serves.
 *
 * THIS IS AN OPEN-REDIRECT GUARD, not a formatting preference. `host` arrives
 * from the request, and the value this function returns is handed to a browser
 * as a navigation target. A pattern that merely looked plausible — any
 * `something/store/something` — would let a link to the app carrying
 * `?host=<base64 of evil.example.com/store/x>` put that address onto a real
 * Stripe session's `success_url`, so a seller who had just typed a card number
 * would be delivered to whoever sent the link. The suffix list is the one
 * `@shopify/shopify-api`'s own `sanitizeHost` enforces, and the shape is its
 * `shopAdminRegex`.
 */
const DECODED_HOST =
  /^admin\.(myshopify\.com|shopify\.com|myshopify\.io|shop\.dev)\/store\/[a-z0-9][a-z0-9-_]*$/i;

/** The library validates the encoding before decoding; so does this. */
const BASE64 = /^[0-9a-zA-Z+/]+={0,2}$/;

/** A Shopify shop domain's store handle: `foo.myshopify.com` -> `foo`. */
export function storeHandle(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, "").toLowerCase();
}

/**
 * The admin address of a page inside this app.
 *
 * `request` is optional because two callers genuinely do not have one: the
 * seller-charge job runs in the queue, where there is no browser and no `host`,
 * and it still has to produce a URL a seller can follow. Those callers get the
 * derived address, which is correct for every `*.myshopify.com` store.
 */
export function shopifyAdminAppUrl(shop: string, path: string, request?: Request): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const tail = `/apps/${CLIENT_ID}${suffix}`;

  const host = request ? new URL(request.url).searchParams.get("host") : null;
  if (host && BASE64.test(host)) {
    // Decoded and CHECKED, in that order, and the check is what decides. A host
    // that does not decode to a Shopify admin address is not followed — it
    // falls through to the derived address rather than failing the seller's
    // checkout over a query string somebody else chose.
    const decoded = Buffer.from(host, "base64").toString("utf8");
    if (DECODED_HOST.test(decoded)) return `https://${decoded}${tail}`;
  }

  const handle = storeHandle(shop);
  return `https://admin.shopify.com/store/${handle}${tail}`;
}
