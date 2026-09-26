import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short-lived, signed permission to fetch one file, for one merchant.
 *
 * WHY A TOKEN IS NEEDED AT ALL, AND WHY IT IS NOT A LOOSENING OF ANYTHING.
 * Merchant pages live inside the Shopify admin's iframe, where a *click that
 * downloads a file* cannot be the same request as a page load. Two things stop
 * it:
 *
 *   • A document navigation inside the frame drops the frame parameters
 *     (`shop`, `host`, `embedded`, `id_token`) that authenticate the request,
 *     so the server answers with App Bridge's bootstrap page instead of bytes.
 *   • Even with those parameters, the admin frames the app in a sandbox that
 *     does not set `allow-downloads`, so a response carrying
 *     `Content-Disposition: attachment` is refused by the browser before it
 *     reaches the seller's disk.
 *
 * The way out of both is the same: the seller's click opens a NEW TOP-LEVEL
 * WINDOW at a URL that carries its own proof of permission. A top-level window
 * has no sandbox, downloads normally, and — crucially — has no Shopify session
 * and cannot get one, because a session is exactly what an embedded app has and
 * a standalone window does not.
 *
 * So the permission travels in the URL, and that makes it the most
 * security-sensitive string in the application:
 *
 *   • SIGNED, not opaque. An HMAC over the whole payload with a key derived
 *     from the app's own secret, so a seller cannot edit "which file" or
 *     "until when" and have it verify. The comparison is constant-time.
 *   • BOUND TO A SELLER. The payload names the seller, and the route that
 *     accepts it re-reads that seller's access state before serving — so a
 *     store that is blocked between the click and the fetch still gets nothing,
 *     and a token cannot be replayed by a different merchant.
 *   • BOUND TO ONE RESOURCE. The kind and the id are both in the signature, so
 *     a token minted for a product's marketing pack cannot fetch a document,
 *     and one minted for one file cannot fetch another.
 *   • SHORT-LIVED. Minutes, not days. It is spent by a click that is happening
 *     now; a copied URL stops working long before it is useful to anyone else.
 *
 * WHAT IT DELIBERATELY CANNOT DO. It grants nothing that the merchant's own
 * session would not grant: every accepting route re-derives, from the database,
 * whether the file is one this seller is allowed to have — approved, offered to
 * sellers, finished processing, on a published product. The token replaces the
 * *session*, not the *authorization check*, and the checks stay where they were.
 */

/** What a token may be spent on. One route each; nothing else accepts them. */
export type DownloadKind = "media" | "marketing_pack";

/**
 * How long a minted URL is good for.
 *
 * Ten minutes. Long enough to survive a slow page, a right-click and a copied
 * link, short enough that a URL left in a browser history or a log is worth
 * nothing by the time anyone finds it.
 */
const TOKEN_TTL_MS = 10 * 60 * 1000;

export interface DownloadTokenClaims {
  kind: DownloadKind;
  /** The storage key for `media`, the product id for `marketing_pack`. */
  resourceId: string;
  /** The seller the token was minted for. */
  sellerId: string;
  /** Unix milliseconds after which the token is refused. */
  expiresAt: number;
}

/**
 * The signing key, derived rather than reused.
 *
 * `SHOPIFY_API_SECRET` already signs session tokens, and this is a different
 * kind of assertion with a different lifetime and audience. Deriving a separate
 * key from it by HMAC keeps the two from being interchangeable: a download
 * token can never be presented as a session token, or the other way round,
 * because neither verifies under the other's key. The label is versioned so a
 * future change of payload shape can rotate the key without invalidating
 * anything that is already in flight.
 */
const KEY_LABEL = "moonvella.download.v1";

let cachedKey: Buffer | null = null;

function signingKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.SHOPIFY_API_SECRET || "";
  if (!secret) {
    /*
     * Refusing here rather than signing with an empty key. A deployment with no
     * secret is a misconfiguration, and the failure mode of continuing is that
     * every token is forgeable by anyone who guesses the label.
     */
    throw new Error("SHOPIFY_API_SECRET is not set, so download links cannot be signed.");
  }
  cachedKey = createHmac("sha256", secret).update(KEY_LABEL).digest();
  return cachedKey;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value as string).toString("base64url");
}

/**
 * The exact bytes that are signed.
 *
 * A fixed field order with a separator that cannot appear in any field: ids are
 * cuids, keys are hex, and the kind comes from a closed set, so `|` is
 * unambiguous. Signing a JSON blob would work too and would leave the door open
 * to two different serializations of the same claims verifying differently.
 */
function payloadOf(claims: DownloadTokenClaims): string {
  return [claims.kind, claims.resourceId, claims.sellerId, String(claims.expiresAt)].join("|");
}

function signatureOf(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/** Mint one. Called in a loader, immediately before the link is rendered. */
export function mintDownloadToken(
  claims: Omit<DownloadTokenClaims, "expiresAt">,
  now: number = Date.now()
): string {
  const full: DownloadTokenClaims = { ...claims, expiresAt: now + TOKEN_TTL_MS };
  const payload = payloadOf(full);
  return `${base64url(payload)}.${signatureOf(payload)}`;
}

/**
 * Verify one, or answer null.
 *
 * Null covers every way a token can be wrong — malformed, unsigned, signed with
 * another key, signed for another resource, expired — and the callers turn it
 * into the same 404 a missing file gets. Telling those apart in the response
 * would tell an attacker which half of a forgery attempt was right.
 */
export function verifyDownloadToken(
  token: string | null,
  expected: { kind: DownloadKind; resourceId: string },
  now: number = Date.now()
): DownloadTokenClaims | null {
  if (!token) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const payload = Buffer.from(token.slice(0, separator), "base64url").toString("utf8");
  const presented = Buffer.from(token.slice(separator + 1), "base64url");

  const expectedSignature = Buffer.from(signatureOf(payload), "base64url");
  if (presented.length !== expectedSignature.length) return null;
  if (!timingSafeEqual(presented, expectedSignature)) return null;

  const [kind, resourceId, sellerId, expiresAt] = payload.split("|");
  if (kind !== expected.kind || resourceId !== expected.resourceId) return null;
  if (!sellerId || !expiresAt) return null;

  const expiry = Number(expiresAt);
  if (!Number.isSafeInteger(expiry) || expiry <= now) return null;

  return { kind: expected.kind, resourceId, sellerId, expiresAt: expiry };
}

/**
 * The address a download link points at.
 *
 * `params` carries whatever else the route needs to find the file — the product
 * id for a marketing pack. Adding one is safe BECAUSE THE TOKEN IS SIGNED OVER
 * THE RESOURCE: the accepting route verifies the token against the id in the
 * URL, so a param that has been edited to name a different product fails
 * verification and is answered exactly like a forged signature. The token is
 * written last so a caller cannot displace it.
 */
export function downloadUrl(
  path: string,
  token: string,
  params: Record<string, string> = {}
): string {
  const query = new URLSearchParams({ ...params, token });
  return `${path}?${query.toString()}`;
}
