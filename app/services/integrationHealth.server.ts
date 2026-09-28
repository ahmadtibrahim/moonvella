import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY, type AuditActorType } from "./audit.server";
import {
  credentialFieldStates,
  disconnectCredentials,
  saveCredentials,
  type CredentialFieldState,
} from "./credentials.server";
import type { CredentialKey } from "./integrationFields";

/**
 * Two different things share one key space, and the split is deliberate.
 *
 * A CREDENTIAL integration is one MoonVella holds secrets for, that an operator
 * configures on the Settings page: Stripe, eShipper, Odoo. Those get a form.
 *
 * An OPERATIONAL check reports whether the Shopify scopes an already-connected
 * app relies on are actually granted — orders, fulfillment, analytics, product
 * import. Nothing is configured and no secret is held; the granted session scope
 * IS the state. These keep recording, because they are how Orders, Shipping and
 * product import stay observable. They belong in system health, not in a
 * credential form, and retiring them would blind the pages that read them.
 */
export type IntegrationKey =
  | "stripe"
  | "eshipper"
  | "odoo"
  | "google"
  | "shopify_analytics"
  | "shopify_orders"
  | "shopify_fulfillment"
  | "product_import";

/** Configured with credentials on the Settings page; each has a form. */
export const CREDENTIAL_KEYS: IntegrationKey[] = ["stripe", "eshipper", "odoo", "google"];

/**
 * Narrows an integration key to one the credential store serves. These are the
 * keys that hold secrets; operational checks have nothing to save.
 */
export function isCredentialKey(key: IntegrationKey): key is CredentialKey {
  return (CREDENTIAL_KEYS as string[]).includes(key);
}

/** Reported as system health. No form and no secret — the scope is the state. */
export const OPERATIONAL_KEYS: IntegrationKey[] = [
  "shopify_orders",
  "shopify_fulfillment",
  "shopify_analytics",
  "product_import",
];

export const DEFAULTS: Record<
  IntegrationKey,
  { status: string; message: string; credentialHints?: string }
> = {
  google: {
    status: "NOT_CONFIGURED",
    message:
      "Google Maps Platform is not configured. Address validation is unavailable, which " +
      "keeps the booking gate shut rather than treating an unchecked address as a good one. " +
      "Save a referrer-restricted browser key for Places autocomplete and a separate " +
      "IP-restricted server key for Address Validation.",
    // The console-side setup is written on each field below, where the operator
    // is when they need it. What is left here is the part no field can carry:
    // the restrictions are not readable from this app, and nothing here can
    // verify them.
    credentialHints:
      "Two keys from ONE Google Cloud project, not one key used twice, and not the google_maps_api_key Odoo holds.\nNothing on this page can check a key's restrictions: they live in the Google Cloud console, and that is where they have to be right.",
  },
  stripe: {
    status: "NOT_CONFIGURED",
    message:
      "Stripe is not configured. Save a test-mode secret key below to enable wholesale payment collection; Simulated mode records events locally only until then.",
    credentialHints: "STRIPE_SECRET_KEY: test-mode secret key (stored encrypted)\nSTRIPE_PUBLISHABLE_KEY: (optional) publishable key for the test environment\nSTRIPE_WEBHOOK_SECRET: signing secret for POST /webhooks/stripe",
  },
  eshipper: {
    status: "NOT_CONFIGURED",
    message:
      "eShipper is not configured. Save the account base URL, username and password below to enable real quotes and bookings. The confirmed test host is https://uu2.eshipper.com. Simulated mode is active meanwhile.",
    credentialHints: "ESHIPPER_BASE_URL: account API base URL — test host https://uu2.eshipper.com\nESHIPPER_USERNAME: account username / API user\nESHIPPER_PASSWORD: account password / API secret (stored encrypted)\nESHIPPER_ACCOUNT_ID: account identifier (optional, if issued)",
  },
  odoo: {
    status: "NOT_CONFIGURED",
    message:
      "Odoo is not configured. Set ODOO_URL, ODOO_DATABASE, ODOO_USERNAME and ODOO_API_KEY with a dedicated API service account. MoonVella reaches Odoo only over JSON-RPC and never through its PostgreSQL database; writes additionally require ODOO_MODE=live.",
    // Values for the fields themselves are written on the fields. This is the
    // deployment-side half, which the page cannot set and must not imply it can.
    credentialHints:
      "Not settable from this page, and both live in the deployment environment:\nODOO_ALLOW_PROD_DB=yes — Prod-db is refused by name without it, which is the guard against pointing a read at the wrong database.\nODOO_ALLOW_WRITES — never set for MoonVella: the catalogue sync reads and writes nothing back to the ERP, and no form here can authorise it.",
  },
  shopify_analytics: {
    status: "NOT_CONFIGURED",
    message:
      "Permission required: read_reports. ShopifyQL sales/sessions/visitor analytics populate after this scope is granted and the app is reauthorized. No numbers are shown until then.",
  },
  shopify_orders: {
    status: "NOT_CONFIGURED",
    message:
      "Permission required: read_orders. Order intake is enabled once this scope is granted and the order webhooks are subscribed.",
  },
  shopify_fulfillment: {
    status: "NOT_CONFIGURED",
    message:
      "Permission required: write_merchant_managed_fulfillment_orders (see docs) to create Shopify fulfillments and sync tracking.",
  },
  product_import: {
    status: "NOT_CONFIGURED",
    message:
      "Product import uses the already-granted write_products plus write_inventory, read_locations and write_files.",
  },
};

export const INTEGRATION_KEYS = Object.keys(DEFAULTS) as IntegrationKey[];

/**
 * The integrations for which the GRANTED SCOPE really is the whole state.
 *
 * `shopify_orders` and `shopify_fulfillment` USED TO BE IN HERE AND ARE NOT ANY
 * MORE, because for them the scope is not the state and the shortcut was a lie.
 *
 * `read_orders` appears in the session's granted scope list from the moment the
 * merchant approves the OAuth prompt — and an app can hold `read_orders`, be
 * completely unable to read a single order, and report HEALTHY, because Shopify
 * gates the Order object behind a second approval that has nothing to do with
 * scopes. That is exactly what was happening here: the settings page said the
 * order integration was healthy while every order query came back "This app is
 * not approved to access the Order object", and the merchant's orders silently
 * did not exist. A health check that cannot fail is worse than no health check,
 * because it is believed.
 *
 * What remains here are the integrations for which no cheap authenticated call
 * exists and the scope genuinely is the precondition — analytics is a ShopifyQL
 * capability that is either granted or not, and product import runs on scopes
 * that were granted at install and cannot be withheld separately.
 */
const SHOPIFY_SCOPE_BY_KEY: Partial<Record<IntegrationKey, string>> = {
  shopify_analytics: "read_reports",
  product_import: "write_products",
};

/**
 * Which of the seller's stores to probe, and what to probe it with.
 *
 * Shopify's answer depends on the store: an app can be approved for Protected
 * Customer Data on one store's install and not another's. Probing one store and
 * reporting for all of them would be the same class of mistake as reporting a
 * scope as access.
 */
async function probeStore(): Promise<
  { ok: true; shop: string } | { ok: false; reason: string; blocking: "SESSION" | "NONE" }
> {
  const session = await prisma.session.findFirst({
    where: { scope: { contains: "read_orders" } },
    orderBy: { expires: "desc" },
    select: { shop: true },
  });
  if (!session) {
    return {
      ok: false,
      reason:
        "No connected store holds the read_orders scope yet. Install or reauthorize the app on a store to begin.",
      blocking: "NONE",
    };
  }
  return { ok: true, shop: session.shop };
}

/**
 * Ask Shopify the question the integration actually depends on.
 *
 * Two reads, both authenticated, both cheap: the shop's own identity (the
 * baseline that proves the session and the token work at all), and ONE order.
 * The order read is the one that matters — it is the exact call the ingestion
 * path makes, and it is refused by Protected Customer Data approval rather than
 * by scopes, so a HEALTHY verdict from it means intake can genuinely work.
 *
 * Deliberately `first: 1` and no fields beyond the id. A health check that
 * pages a merchant's order history to prove it can read orders is a health
 * check that reads a merchant's order history.
 */
async function probeShopifyOrders(): Promise<IntegrationCheckResult> {
  const store = await probeStore();
  if (!store.ok) {
    return { status: "NOT_CONFIGURED", detail: store.reason, error: null };
  }

  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(store.shop);
    const res = await admin.graphql(
      `#graphql
        query MoonVellaOrderProbe {
          shop { name myshopifyDomain }
          orders(first: 1) { nodes { id } }
          webhookSubscriptions(first: 20) { nodes { id topic } }
        }`,
    );
    const json: {
      data?: {
        shop?: { name?: string; myshopifyDomain?: string } | null;
        orders?: { nodes?: { id: string }[] } | null;
        webhookSubscriptions?: { nodes?: { id: string; topic: string }[] } | null;
      };
      errors?: { message: string }[];
    } = await res.json();

    const errors = json?.errors ?? [];
    if (errors.length) {
      const message = errors.map((e) => e.message).join("; ");
      const pcd = /protected customer data/i.test(message);
      return {
        status: pcd ? "BLOCKED" : "FAILED",
        detail:
          `Shopify refused the order read for ${store.shop}: ${message}` +
          (pcd
            ? " — the app must be approved for Protected Customer Data in the Shopify Partner Dashboard. " +
              "Until then no order can be read or subscribed to, whatever the granted scopes say."
            : ""),
        error: message,
      };
    }

    const orderSubscriptions = (json?.data?.webhookSubscriptions?.nodes ?? []).filter((s) =>
      String(s.topic ?? "").toUpperCase().startsWith("ORDERS_"),
    );
    const orderCount = json?.data?.orders?.nodes?.length ?? 0;

    if (orderSubscriptions.length === 0) {
      /*
       * Readable orders but no subscriptions is a real and distinct failure:
       * the app can see orders and will never be told about a new one. It is
       * reported as FAILED rather than healthy because a store with no
       * subscription is a store whose orders do not arrive.
       */
      return {
        status: "FAILED",
        detail:
          `Orders are readable for ${store.shop}, but no orders/* webhook subscription exists. ` +
          `New orders will not be delivered until the app's webhook subscriptions are registered.`,
        error: "No orders/* webhook subscription is registered.",
      };
    }

    return {
      status: "HEALTHY",
      detail:
        `Authenticated against ${json?.data?.shop?.myshopifyDomain ?? store.shop} and read the Order object ` +
        `(${orderCount ? "at least one order" : "the order set, which is empty"}). ` +
        `${orderSubscriptions.length} order subscription(s) registered: ` +
        `${orderSubscriptions.map((s) => s.topic).join(", ")}.`,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "order probe failed";
    const pcd = /protected customer data/i.test(message);
    return {
      status: pcd ? "BLOCKED" : "FAILED",
      detail:
        `Could not read orders for ${store.shop}: ${message}` +
        (pcd
          ? " — Protected Customer Data approval is required in the Shopify Partner Dashboard."
          : ""),
      error: message,
    };
  }
}

/**
 * Whether MoonVella can actually own a shipment, asked rather than assumed.
 *
 * Three facts, in the order they matter: the fulfillment services are readable
 * (which needs the fulfillment scopes), a MoonVella service with a location of
 * its own exists for the store (which is what stops MoonVella fulfilling out of
 * the merchant's shelf), and the fulfillment orders are readable (which is what
 * Protected Customer Data gates).
 */
async function probeShopifyFulfillment(): Promise<IntegrationCheckResult> {
  const store = await probeStore();
  if (!store.ok) {
    return { status: "NOT_CONFIGURED", detail: store.reason, error: null };
  }

  const seller = await prisma.seller.findUnique({
    where: { shopDomain: store.shop },
    select: { shopifyFulfillmentLocationId: true, fulfillmentLocationCheckedAt: true },
  });

  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(store.shop);
    const res = await admin.graphql(
      `#graphql
        query MoonVellaFulfillmentProbe {
          fulfillmentServices(first: 20) { nodes { id serviceName handle location { id name } } }
        }`,
    );
    const json: {
      data?: {
        fulfillmentServices?: {
          nodes?: { id: string; serviceName?: string | null; location?: { id?: string } | null }[];
        } | null;
      };
      errors?: { message: string }[];
    } = await res.json();

    const errors = json?.errors ?? [];
    if (errors.length) {
      const message = errors.map((e) => e.message).join("; ");
      return {
        status: /access scope|access denied/i.test(message) ? "BLOCKED" : "FAILED",
        detail: `Shopify refused the fulfillment-service read for ${store.shop}: ${message}`,
        error: message,
      };
    }

    // Imported dynamically rather than at the top of the file: the fulfillment
    // service imports this module for `setIntegrationState`, so a static import
    // here would be a cycle.
    const { MOONVELLA_FULFILLMENT_SERVICE_NAME: wanted } = await import("./shopifyFulfillment.server");

    const services = json?.data?.fulfillmentServices?.nodes ?? [];
    const ours = services.find(
      (s) => String(s.serviceName ?? "").toLowerCase() === wanted.toLowerCase(),
    );
    const locationId = ours?.location?.id ?? seller?.shopifyFulfillmentLocationId ?? null;

    if (!locationId) {
      return {
        status: "NOT_CONFIGURED",
        detail:
          `No ${wanted} fulfillment service exists for ${store.shop}. ` +
          `It is created on the first product import; until it exists, orders would be routed to the ` +
          `merchant's own location and MoonVella would be shipping from the merchant's shelf.`,
        error: null,
      };
    }

    return {
      status: "HEALTHY",
      detail:
        `The ${wanted} fulfillment service is present for ${store.shop} ` +
        `with location ${locationId}. MoonVella's stock belongs there and the fulfillment orders for ` +
        `MoonVella lines are routed to it.`,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "fulfillment probe failed";
    return {
      status: "FAILED",
      detail: `Could not read fulfillment services for ${store.shop}: ${message}`,
      error: message,
    };
  }
}

export interface IntegrationStateView {
  key: string;
  status: string;
  message: string;
  detail: string;
  /**
   * Credential guidance, carried on the view so the Settings page can render it
   * without importing this server-only module into the client bundle.
   */
  credentialHints: string;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  /**
   * Per-field credential state — the only form in which credential information
   * reaches the browser, and already stripped of secret values by the store.
   * Empty for operational checks, which hold no credentials.
   */
  credentialFields: CredentialFieldState[];
  /**
   * When an operator disconnected this integration. Non-null means the provider
   * is genuinely unreachable, including through the environment, until
   * credentials are saved again.
   */
  disconnectedAt: Date | null;
}

export interface IntegrationActor {
  actorType?: AuditActorType;
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function getIntegrationState(
  key: IntegrationKey
): Promise<IntegrationStateView> {
  const row = await prisma.integrationState.findUnique({ where: { key } });
  const fallback = DEFAULTS[key];
  const detail = row?.detail ?? fallback.message;
  return {
    key,
    status: row?.status ?? fallback.status,
    message: detail,
    detail,
    credentialHints: fallback.credentialHints ?? "",
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
    lastError: row?.lastError ?? null,
    credentialFields: isCredentialKey(key) ? await credentialFieldStates(key) : [],
    disconnectedAt: row?.disconnectedAt ?? null,
  };
}

export async function listIntegrationStates(): Promise<IntegrationStateView[]> {
  const keys = Object.keys(DEFAULTS) as IntegrationKey[];
  return Promise.all(keys.map((key) => getIntegrationState(key)));
}

export interface IntegrationCheckResult {
  status: string;
  detail: string;
  error: string | null;
}

/**
 * Lightweight, side-effect-free probe for one integration. Shopify keys check
 * the granted session scope; provider keys check server-side credentials only
 * (no outbound call); inventory checks the local catalog.
 */
export async function checkIntegration(
  key: IntegrationKey
): Promise<IntegrationCheckResult> {
  // The operational checks read the granted session scope rather than probing a
  // provider: the scope IS the state. A missing scope reports the exact
  // permission to grant, not a generic failure.
  const scope = SHOPIFY_SCOPE_BY_KEY[key];
  if (scope) {
    const session = await prisma.session.findFirst({
      where: { scope: { contains: scope } },
      orderBy: { expires: "desc" },
      select: { shop: true },
    });
    return session
      ? { status: "HEALTHY", detail: `${scope} granted for ${session.shop}.`, error: null }
      : {
          status: "NOT_CONFIGURED",
          detail: `Permission required: ${scope}. Grant it and reauthorize the app.`,
          error: null,
        };
  }

  switch (key) {
    /*
     * Both of these were scope checks and both were wrong, for the same reason:
     * the scope Shopify grants during OAuth and the approval Shopify requires
     * before an app may touch an order are different gates, and only the second
     * one decides whether any of this works. See the note on
     * SHOPIFY_SCOPE_BY_KEY.
     */
    case "shopify_orders":
      return await probeShopifyOrders();
    case "shopify_fulfillment":
      return await probeShopifyFulfillment();

    case "stripe": {
      // An authenticated call, not a presence check. "A key is present" and "the
      // key works" are different facts, and only the second one may be shown as
      // Connected — a typo'd or revoked key is exactly what an operator runs
      // this to find out.
      const { testStripeAuthentication } = await import("./payments.server");
      const result = await testStripeAuthentication();
      if (result.ok) {
        return {
          status: "HEALTHY",
          detail: result.livemode
            ? "Authenticated against Stripe — but this is a LIVE key, not a test key. Wholesale payments would be real."
            : "Authenticated against Stripe (test mode).",
          error: null,
        };
      }
      return {
        status: result.reason?.startsWith("No Stripe secret key") ? "NOT_CONFIGURED" : "FAILED",
        detail: result.reason ?? "Stripe authentication failed.",
        error: result.reason?.startsWith("No Stripe secret key") ? null : (result.reason ?? null),
      };
    }
    case "eshipper": {
      // Authenticates and stops. No quote, no booking, nothing spent.
      const { testEshipperAuthentication } = await import("./eshipper.server");
      const result = await testEshipperAuthentication();
      if (result.ok) {
        const signals = Object.entries(result.accountSignals);
        return {
          status: "HEALTHY",
          detail: [
            `Authenticated against ${result.baseUrlHost ?? "the configured host"} (${result.environment} environment).`,
            "No quote was requested and no shipment was booked.",
            signals.length
              ? `Account signals: ${signals.map(([name, value]) => `${name}=${value}`).join(", ")}.`
              : "The provider reported no credit or balance figures, so testing credit cannot be established from authentication alone.",
          ].join(" "),
          error: null,
        };
      }
      const unconfigured = result.environment === "unconfigured";
      return {
        status: unconfigured ? "NOT_CONFIGURED" : "FAILED",
        detail: result.reason ?? "eShipper authentication failed.",
        error: unconfigured ? null : (result.reason ?? null),
      };
    }
    case "odoo": {
      // A real authentication, matching how Stripe and eShipper are probed. It
      // reads no record and posts nothing: `common.authenticate` and
      // `common.version` are the only calls it makes. "The four fields are set"
      // is a much weaker fact than "Odoo accepted them", and only the second may
      // be shown as Connected.
      const { testOdooConnection } = await import("./odoo.server");
      const result = await testOdooConnection();
      if (result.ok) {
        return {
          status: "HEALTHY",
          detail: [
            `Authenticated against Odoo database "${result.database}" as "${result.username}"`,
            result.serverVersion ? `(server ${result.serverVersion}).` : ".",
            "No record was read, no order was created and nothing was posted to the ledger.",
            `MoonVella is in ${result.mode} mode.`,
            result.writeBlockReason ?? "Writes are permitted and audited.",
          ].join(" "),
          error: null,
        };
      }
      const unconfigured = !result.configured;
      return {
        status: unconfigured ? "NOT_CONFIGURED" : result.databaseBlocked ? "BLOCKED" : "FAILED",
        detail: result.reason ?? "Odoo authentication failed.",
        error: unconfigured ? null : (result.reason ?? null),
      };
    }
    case "google": {
      // TWO CREDENTIALS, TWO PROBES, TWO LINES. Google is the one integration
      // here that holds a public key and a secret key for the same provider, and
      // they fail independently: a browser key that Google refuses kills
      // autocomplete and nothing else, and a server key that Google refuses
      // stops every address verdict. Collapsing them into one verdict would name
      // neither the credential to replace nor the screen that breaks, so the
      // check reports each on its own line and only calls the integration
      // FAILED when Google actually refused something.
      //
      // Both are real calls. Places Autocomplete is the same request the page
      // makes, built by the same function, carrying the referrer that origin
      // would send; Address Validation is a real validation. That is the
      // difference between this check and reading the store.
      const { checkGoogle } = await import("./googleHealth.server");
      return checkGoogle();
    }
    default:
      return { status: "NOT_CONFIGURED", detail: "No check is available for this integration.", error: null };
  }
}

/** Run a probe and persist the result. Used by the admin settings actions. */
export async function refreshIntegration(key: IntegrationKey, actor?: IntegrationActor) {
  const result = await checkIntegration(key);
  await setIntegrationState(key, { status: result.status, detail: result.detail, error: result.error }, actor);
  return getIntegrationState(key);
}

/** Clear a stored error without re-probing; a FAILED state resets to NEVER_SYNCED. */
export async function clearIntegrationError(key: IntegrationKey, actor?: IntegrationActor) {
  const row = await prisma.integrationState.findUnique({ where: { key } });
  if (!row) {
    return getIntegrationState(key);
  }
  const nextStatus = row.status === "FAILED" ? "NEVER_SYNCED" : row.status;
  await prisma.integrationState.update({
    where: { key },
    data: { status: nextStatus, lastError: null, lastErrorAt: null },
  });
  await recordAudit(
    {
      actorType: actor ? "ADMIN_USER" : "SYSTEM",
      actorId: actor?.actorId ?? "system",
      actorName: actor?.actorName ?? "System",
      action: "integration.error_cleared",
      entityType: AUDIT_ENTITY.INTEGRATION,
      entityId: key,
      beforeData: { status: row.status, error: row.lastError },
      afterData: { status: nextStatus, error: null },
      ipAddress: actor?.ipAddress,
      userAgent: actor?.userAgent,
    }
  );
  return getIntegrationState(key);
}

/**
 * Save credentials for an integration, then re-check it.
 *
 * The re-check is an authenticated call, so a saved-but-wrong credential lands
 * as FAILED with the provider's own reason rather than a hopeful "Saved".
 */
export async function saveIntegrationCredentials(
  key: IntegrationKey,
  credentials: Record<string, string>,
  actor: IntegrationActor
) {
  if (!isCredentialKey(key)) {
    throw new Error(`${key} is an operational check and holds no credentials.`);
  }

  /*
   * A value of the wrong KIND is refused before anything is written.
   *
   * The field mapping is right — STRIPE_SECRET_KEY is a secret field and takes
   * the sk_… key — so this is not a mapping fix: it is what happens when the
   * VALUE pasted into that field is the publishable key from the top of the same
   * Stripe console page. Storing it produces a provider that reports FAILED
   * forever with a generic 401, and the operator's next move is to re-check the
   * mapping, which was never wrong. Refusing at the door names the mistake while
   * the person who made it is still looking at the form.
   *
   * The whole submission is refused rather than the one field skipped: silently
   * saving the other fields of a form whose key field was rejected would leave
   * the operator believing the paste worked.
   */
  const rejected = await rejectWrongKindValues(key, credentials);
  if (rejected) throw new Error(rejected);

  const result = await saveCredentials(key, credentials);

  // Field NAMES only. A credential value must never reach the audit log.
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "integration.credentials_saved",
    entityType: AUDIT_ENTITY.INTEGRATION,
    entityId: key,
    afterData: { savedFields: result.saved, unchangedFields: result.unchanged },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  await resetProviderState(key);
  return refreshIntegration(key, actor);
}

/**
 * The values a provider will refuse to authenticate, caught while they are still
 * in the operator's hands.
 *
 * Two providers have a wrong KIND of value an operator actually reaches for, and
 * both mistakes are made on the provider's own console page, with the correct
 * value visible on the same screen:
 *
 *   * Stripe's secret field is next to the publishable key, which is a valid
 *     Stripe value that cannot authenticate anything.
 *   * Either Google key field is next to the project's OAuth client ID, which is
 *     the longest and most key-shaped thing on the credentials screen and is not
 *     an API key at all.
 *
 * Each is written as a lookup on the fields that have this failure rather than
 * as a general rule that would have to guess what every other provider's values
 * look like. Returns the sentence to show, or null when nothing is wrong. Never
 * returns or logs the value.
 */
async function rejectWrongKindValues(
  key: CredentialKey,
  credentials: Record<string, string>
): Promise<string | null> {
  if (key === "stripe") {
    const { stripeKeyKindProblem } = await import("./stripeMode.server");
    return stripeKeyKindProblem(credentials.STRIPE_SECRET_KEY ?? null);
  }
  if (key === "google") {
    const { googleKeyKindProblem } = await import("./googleHealth.server");
    for (const field of ["GOOGLE_MAPS_BROWSER_KEY", "GOOGLE_MAPS_SERVER_KEY"]) {
      // Only a field the operator actually submitted. A blank field means "keep
      // what is saved", and the saved value was accepted when it was saved.
      const submitted = credentials[field];
      if (submitted === undefined) continue;
      const problem = googleKeyKindProblem(field, submitted);
      if (problem) return problem;
    }
    return null;
  }
  return null;
}

/**
 * Drop anything a provider module cached from the previous credentials. Without
 * this, a saved change would take effect for new calls but a cached bearer token
 * from the old account could still be reused.
 */
async function resetProviderState(key: IntegrationKey) {
  if (key !== "eshipper") return;
  const { resetEshipperToken } = await import("./eshipper.server");
  resetEshipperToken();
}

/**
 * Disconnect an integration, so that it stops operating rather than merely
 * reporting that it has.
 *
 * Two things happen, and both are needed. The stored credentials are deleted,
 * and a flag is set that suppresses the environment as well. Deleting alone
 * would leave a provider configured through the environment fully live while the
 * status line claimed otherwise.
 *
 * Credentials saved again later lift the flag, so this is reversible by the same
 * operator who set it.
 */
export async function disconnectIntegration(key: IntegrationKey, actor: IntegrationActor) {
  if (!isCredentialKey(key)) {
    throw new Error(`${key} is an operational check and cannot be disconnected.`);
  }

  const before = await prisma.integrationState.findUnique({ where: { key } });
  const { removed } = await disconnectCredentials(key);
  await resetProviderState(key);

  await setIntegrationState(key, {
    status: "NOT_CONFIGURED",
    detail:
      "Disconnected by operator. Provider operations are disabled: stored credentials were deleted and the " +
      "environment is suppressed for this integration until credentials are saved again.",
    error: null,
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "integration.disconnected",
    entityType: AUDIT_ENTITY.INTEGRATION,
    entityId: key,
    // Counts and names only — never a credential value.
    beforeData: { status: before?.status ?? null, storedCredentialsRemoved: removed },
    afterData: { status: "NOT_CONFIGURED", providerOperationsDisabled: true },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return getIntegrationState(key);
}

export async function setIntegrationState(
  key: string,
  input: { status: string; detail?: string | null; error?: string | null },
  actor?: IntegrationActor
) {
  const healthy = input.status === "HEALTHY";
  const existing = await prisma.integrationState.findUnique({ where: { key } });
  const detail = input.detail ?? null;
  const error = input.error ?? null;
  const now = new Date();

  const row = await prisma.integrationState.upsert({
    where: { key },
    create: {
      key,
      status: input.status as never,
      detail,
      lastError: error,
      lastSuccessAt: healthy ? now : null,
      lastErrorAt: error ? now : null,
    },
    update: {
      status: input.status as never,
      detail,
      lastError: error,
      ...(healthy ? { lastSuccessAt: now } : {}),
      ...(error ? { lastErrorAt: now } : {}),
    },
  });

  const changed =
    !existing ||
    existing.status !== input.status ||
    (existing.detail ?? null) !== detail ||
    (existing.lastError ?? null) !== error;

  if (changed) {
    await recordAudit({
      actorType: actor ? "ADMIN_USER" : "SYSTEM",
      actorId: actor?.actorId ?? "system",
      actorName: actor?.actorName ?? "System",
      action: "integration.state_changed",
      entityType: AUDIT_ENTITY.INTEGRATION,
      entityId: key,
      beforeData: existing
        ? { status: existing.status, detail: existing.detail, error: existing.lastError }
        : null,
      afterData: { status: input.status, detail, error },
      ipAddress: actor?.ipAddress,
      userAgent: actor?.userAgent,
    });
  }

  return row;
}
