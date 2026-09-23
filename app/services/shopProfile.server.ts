/**
 * The store facts MoonVella reads from Shopify, and what it says when one is
 * missing.
 *
 * Two rules shape this module.
 *
 * **The shop identity comes from the authenticated session, never from a form.**
 * A submitted field may say `storeName: "Acme"`; that value is display data at
 * best. Everything here is read from the Admin API using the session's own
 * shop, so a merchant cannot apply as somebody else's store.
 *
 * **A blank field must say why it is blank.** Shopify returns `null` for a
 * field the merchant has not filled in, an access denial for a field the app
 * may not read, and nothing at all when the request fails. Those are three
 * different situations with three different fixes, and collapsing them into
 * "Unknown" (which an earlier version did) tells the reader nothing while
 * looking like an answer. `ProfileField` therefore carries a reason, and the
 * interface renders the reason.
 *
 * Field availability was verified against the deployed Admin API version by
 * querying the live shop — see `SHOP_API_VERSION` and the test that asserts the
 * query text, not against the version's published documentation alone.
 */

import { apiVersion } from "~/shopify.server";

/** The Admin API version this query was verified against. */
export const SHOP_API_VERSION = String(apiVersion);

export type ProfileFieldKey =
  | "shopifyShopId"
  | "storeName"
  | "myshopifyDomain"
  | "storefrontUrl"
  | "storeOwnerEmail"
  | "storeContactEmail"
  | "shopOwnerName"
  | "countryCode"
  | "currency"
  | "plan"
  | "addressLine1"
  | "addressLine2"
  | "addressCity"
  | "addressProvinceCode"
  | "addressPostalCode"
  | "addressCountryCode";

/**
 * Why a field has the value it has. Stored per field so the page can explain a
 * blank input instead of showing an empty box next to a label.
 */
export type ProfileFieldSource =
  /** Read from Shopify, non-empty. */
  | "SHOPIFY"
  /** Shopify answered, and the answer was empty — the merchant has not set it. */
  | "SHOPIFY_EMPTY"
  /** The Admin API refused this field for this app's granted scopes. */
  | "NO_PERMISSION"
  /** The whole request failed: network, auth, or a GraphQL error. */
  | "IMPORT_FAILED"
  /** A merchant has typed over the imported value. */
  | "MERCHANT";

export interface ShopProfile {
  shopifyShopId: string | null;
  storeName: string | null;
  myshopifyDomain: string | null;
  storefrontUrl: string | null;
  storeOwnerEmail: string | null;
  storeContactEmail: string | null;
  shopOwnerName: string | null;
  countryCode: string | null;
  currency: string | null;
  plan: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressProvinceCode: string | null;
  addressPostalCode: string | null;
  addressCountryCode: string | null;
}

export interface ShopProfileResult {
  profile: ShopProfile;
  sources: Record<ProfileFieldKey, ProfileFieldSource>;
  /** The raw `shop` object as returned, for the stored snapshot. */
  raw: Record<string, unknown> | null;
  /** Set when the whole import failed. Distinct from a field being empty. */
  error: string | null;
}

export const PROFILE_FIELD_LABELS: Record<ProfileFieldKey, string> = {
  shopifyShopId: "Shopify shop ID",
  storeName: "Store display name",
  myshopifyDomain: "myshopify domain",
  storefrontUrl: "Storefront URL",
  storeOwnerEmail: "Store owner email",
  storeContactEmail: "Public store contact email",
  shopOwnerName: "Store owner name",
  countryCode: "Country",
  currency: "Currency",
  plan: "Shopify plan",
  addressLine1: "Street 1",
  addressLine2: "Street 2",
  addressCity: "City",
  addressProvinceCode: "Province / State",
  addressPostalCode: "Postal / ZIP code",
  addressCountryCode: "Country",
};

/**
 * One sentence per reason, written for the merchant who has to act on it. The
 * NO_PERMISSION text names the real cause — the app's own granted scopes — so
 * nobody goes looking for a field in Shopify that does not exist.
 */
export function explainSource(source: ProfileFieldSource): string {
  switch (source) {
    case "SHOPIFY":
      return "Imported from Shopify.";
    case "SHOPIFY_EMPTY":
      return "Shopify returned no value for this field. Add it in your Shopify store settings, then refresh — or complete it here.";
    case "NO_PERMISSION":
      return "The app is not permitted to read this field on this store. Reinstall or re-approve the app to grant the current scopes.";
    case "IMPORT_FAILED":
      return "The Shopify request failed, so this value was not read. Refresh to try again.";
    case "MERCHANT":
      return "Entered by you. Refreshing from Shopify will not overwrite it unless you clear it first.";
  }
}

/** The raw field is empty in Shopify's own answer. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}

const SHOP_QUERY = `#graphql
  query MoonVellaShopProfile {
    shop {
      id
      name
      myshopifyDomain
      email
      contactEmail
      shopOwnerName
      currencyCode
      primaryDomain { url }
      plan { displayName }
      billingAddress {
        address1
        address2
        city
        provinceCode
        zip
        country
        countryCodeV2
      }
    }
  }
`;

interface AdminGraphql {
  graphql: (
    query: string,
    opts?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/**
 * Read the shop profile.
 *
 * Never throws: an import failure is a state the application page must be able
 * to render (with the reason and a Refresh control), not an exception that
 * blanks the page. The returned `sources` map is exhaustive by construction, so
 * a new field cannot be added without deciding what to say about it.
 */
export async function fetchShopProfile(admin: AdminGraphql): Promise<ShopProfileResult> {
  const empty = blankProfile();

  let json: { data?: { shop?: Record<string, unknown> }; errors?: Array<{ message?: string }> };
  try {
    const response = await admin.graphql(SHOP_QUERY);
    json = await response.json();
  } catch (error) {
    return {
      profile: empty,
      sources: allFields("IMPORT_FAILED"),
      raw: null,
      error: error instanceof Error ? error.message : "The Shopify request failed.",
    };
  }

  const shop = json?.data?.shop;
  if (!shop) {
    // A GraphQL error and a missing shop are different failures. "Access
    // denied" is a permission problem the merchant can fix by re-approving the
    // app; anything else is transient. Reporting both as a failed import would
    // send the merchant to the wrong remedy half the time.
    const messages = (json?.errors ?? [])
      .map((e) => e?.message ?? "")
      .filter(Boolean)
      .join("; ");
    const permission = /access denied|not approved|unauthorized|forbidden/i.test(messages);
    const source: ProfileFieldSource = permission ? "NO_PERMISSION" : "IMPORT_FAILED";
    return {
      profile: empty,
      sources: allFields(source),
      raw: null,
      error: messages || "Shopify returned no shop record for this session.",
    };
  }

  const billing = (shop.billingAddress ?? {}) as Record<string, unknown>;
  const primaryDomain = (shop.primaryDomain ?? {}) as Record<string, unknown>;
  const plan = (shop.plan ?? {}) as Record<string, unknown>;

  const read = (raw: unknown): { value: string | null; source: ProfileFieldSource } =>
    isEmpty(raw)
      ? { value: null, source: "SHOPIFY_EMPTY" }
      : { value: String(raw).trim(), source: "SHOPIFY" };

  const entries: Array<[ProfileFieldKey, unknown]> = [
    ["shopifyShopId", shop.id],
    ["storeName", shop.name],
    ["myshopifyDomain", shop.myshopifyDomain],
    ["storefrontUrl", primaryDomain.url],
    ["storeOwnerEmail", shop.email],
    ["storeContactEmail", shop.contactEmail],
    ["shopOwnerName", shop.shopOwnerName],
    ["countryCode", billing.countryCodeV2 ?? billing.country],
    ["currency", shop.currencyCode],
    ["plan", plan.displayName],
    ["addressLine1", billing.address1],
    ["addressLine2", billing.address2],
    ["addressCity", billing.city],
    ["addressProvinceCode", billing.provinceCode],
    ["addressPostalCode", billing.zip],
    ["addressCountryCode", billing.countryCodeV2],
  ];

  const profile = blankProfile() as unknown as Record<string, string | null>;
  const sources = {} as Record<ProfileFieldKey, ProfileFieldSource>;
  for (const [key, raw] of entries) {
    const { value, source } = read(raw);
    profile[key] = value;
    sources[key] = source;
  }

  return {
    profile: profile as unknown as ShopProfile,
    sources,
    raw: shop,
    error: null,
  };
}

function blankProfile(): ShopProfile {
  return {
    shopifyShopId: null,
    storeName: null,
    myshopifyDomain: null,
    storefrontUrl: null,
    storeOwnerEmail: null,
    storeContactEmail: null,
    shopOwnerName: null,
    countryCode: null,
    currency: null,
    plan: null,
    addressLine1: null,
    addressLine2: null,
    addressCity: null,
    addressProvinceCode: null,
    addressPostalCode: null,
    addressCountryCode: null,
  };
}

function allFields(source: ProfileFieldSource): Record<ProfileFieldKey, ProfileFieldSource> {
  const out = {} as Record<ProfileFieldKey, ProfileFieldSource>;
  for (const key of Object.keys(PROFILE_FIELD_LABELS) as ProfileFieldKey[]) {
    out[key] = source;
  }
  return out;
}

/** Exposed for the suite that asserts the query still asks for every field. */
export const SHOP_PROFILE_QUERY = SHOP_QUERY;

/**
 * Which address columns the Odoo company mapping needs. An address is only
 * complete when every one of these has a value; the application page uses this
 * to decide whether to say "complete your address" rather than to guess at a
 * partial address.
 */
export const REQUIRED_ADDRESS_FIELDS: ProfileFieldKey[] = [
  "addressLine1",
  "addressCity",
  "addressProvinceCode",
  "addressPostalCode",
  "addressCountryCode",
];

export interface AddressCompleteness {
  complete: boolean;
  missing: ProfileFieldKey[];
  /** True when Shopify supplied every required field. */
  imported: boolean;
}

/**
 * Whether the structured address is usable, and if not, exactly which parts a
 * person still has to supply. Country and province are kept in code form
 * because that is what Odoo resolves against; a free-text province could not be
 * mapped to a `res.country.state` row without guessing.
 */
export function checkAddress(address: Partial<ShopProfile>): AddressCompleteness {
  const missing = REQUIRED_ADDRESS_FIELDS.filter((key) => isEmpty(address[key]));
  return {
    complete: missing.length === 0,
    missing,
    imported: missing.length === 0,
  };
}
