/**
 * Whether MoonVella is allowed to do the fulfillment half of its job.
 *
 * MoonVella ships the goods itself, so it has to own both the fulfillment
 * service and the location stock sits at — Shopify will not let a fulfillment
 * order be routed to a location the app does not control. That needs two scopes
 * the app was installed without:
 *
 *   write_fulfillments — create the MoonVella fulfillment service that owns the
 *     stock. Without it `fulfillmentServiceCreate` is refused with "Required
 *     access: write_fulfillments", and every order stays routed to the
 *     merchant's own "Shop location", which MoonVella cannot fulfill from.
 *   write_locations — create and manage the location that service ships from.
 *     Without it there is nowhere to hold MoonVella stock that is not the
 *     merchant's own shelf.
 *
 * WHY THIS FILE EXISTS AT ALL. Shopify does not prompt for the two on its own.
 * The installed library (`@shopify/shopify-app-react-router@1.2.1`) never
 * asserts the configured scopes against the grant: `authenticate.admin`
 * constructs the scopes API and does not call it, and the only caller of the
 * grant redirect is the opt-in `scopes.request()`. So an app whose config
 * declares more than the merchant granted serves normally and silently — which
 * is exactly what happened: the 14-scope config was deployed and the merchant
 * opened the app to no permission screen at all, because nothing ever asked.
 * The request has to be made deliberately, and this is where that starts.
 */

/** The two, in the order they are shown and requested. Never reorder casually. */
export const FULFILLMENT_SCOPES = ["write_fulfillments", "write_locations"] as const;

export type FulfillmentScopeState = {
  /** Every scope Shopify says is granted, as of the read. */
  granted: string[];
  /** Which of `FULFILLMENT_SCOPES` are absent. Empty means the gate is open. */
  missing: string[];
};

/**
 * Which of the two are absent from a granted list.
 *
 * Split out as a pure function so the predicate can be tested against real
 * grant shapes — including the one Shopify actually returned for this store,
 * where `read_locations` is present and `write_locations` is not, which is the
 * case a naive "does it contain 'locations'?" check would get wrong.
 */
export function missingFulfillmentScopes(granted: readonly string[]): string[] {
  const held = new Set(granted.map((scope) => scope.toLowerCase()));
  return FULFILLMENT_SCOPES.filter((scope) => !held.has(scope));
}

/**
 * How long a granted-scope read is reused, in milliseconds.
 *
 * The layout revalidates every 30 seconds (`ACCESS_POLL_MS` in `app.jsx`) and a
 * revalidation re-runs the matched child loaders too, so an uncached read here
 * would put a Shopify GraphQL call on a timer for as long as any merchant
 * leaves the page open. Shopify's Admin API is a costed leaky bucket, not a
 * local query; a read that only has to be *fresh enough* to draw a banner does
 * not deserve that budget.
 *
 * The cost of the cache is latency on the one moment freshness matters: after
 * the merchant approves, the banner can survive up to this long. That is why
 * the grant action calls `forgetFulfillmentScopes` directly, and why this is
 * seconds rather than minutes.
 */
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { at: number; state: FulfillmentScopeState }>();

/** The minimum shape of the library's scopes API this module depends on. */
export type ScopeQuerier = {
  query: () => Promise<{ granted: string[] }>;
};

/**
 * The grant as Shopify currently reports it, never as the session remembers it.
 *
 * The session row carries a `scope` string written at install and updated by
 * the `app/scopes_update` webhook. It is a record of what was granted once, and
 * a stale one is indistinguishable from a current one by reading it — so it is
 * not read here. `scopes.query()` asks Shopify, which is the only party that
 * knows.
 */
export async function readFulfillmentScopes(
  shop: string,
  scopes: ScopeQuerier
): Promise<FulfillmentScopeState> {
  const cached = cache.get(shop);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.state;

  const { granted } = await scopes.query();
  const state: FulfillmentScopeState = { granted, missing: missingFulfillmentScopes(granted) };
  cache.set(shop, { at: Date.now(), state });
  return state;
}

/**
 * Drop the cached read for a shop.
 *
 * Called by the grant action so that a merchant who has just approved does not
 * have to wait out the TTL to see the banner go.
 */
export function forgetFulfillmentScopes(shop: string): void {
  cache.delete(shop);
}
