import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

export type IntegrationKey =
  | "shopify_analytics"
  | "shopify_orders"
  | "shopify_fulfillment"
  | "product_import"
  | "stripe"
  | "eshipper"
  | "plaid"
  | "inventory_sync";

const DEFAULTS: Record<IntegrationKey, { status: string; message: string }> = {
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
  stripe: {
    status: "NOT_CONFIGURED",
    message:
      "Stripe test key not configured. Set STRIPE_SECRET_KEY (test mode) to enable wholesale payment collection. Simulated mode records events locally only.",
  },
  eshipper: {
    status: "NOT_CONFIGURED",
    message:
      "eShipper not configured. Set ESHIPPER_BASE_URL/ESHIPPER_USERNAME/ESHIPPER_PASSWORD plus endpoint paths from the account docs for real quotes/booking. Simulated mode is active meanwhile.",
  },
  plaid: {
    status: "NOT_CONFIGURED",
    message:
      "Plaid not configured. Set PLAID_CLIENT_ID/PLAID_SECRET with PLAID_ENV=sandbox for the seller bank-linking flow. Bank linking is separate from payment collection and never marks an invoice paid.",
  },
  inventory_sync: {
    status: "NOT_CONFIGURED",
    message:
      "Inventory authority is the MoonVella local catalog for the first test. Odoo can replace it later.",
  },
};

export const INTEGRATION_KEYS = Object.keys(DEFAULTS) as IntegrationKey[];

const SHOPIFY_SCOPE_BY_KEY: Partial<Record<IntegrationKey, string>> = {
  shopify_analytics: "read_reports",
  shopify_orders: "read_orders",
  shopify_fulfillment: "write_merchant_managed_fulfillment_orders",
  product_import: "write_products",
};

export interface IntegrationStateView {
  key: string;
  status: string;
  message: string;
  detail: string;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}

export interface IntegrationActor {
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
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
    lastError: row?.lastError ?? null,
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
    case "stripe": {
      const { isStripeConfigured } = await import("./payments.server");
      return isStripeConfigured()
        ? { status: "HEALTHY", detail: "STRIPE_SECRET_KEY is set (Stripe test mode).", error: null }
        : {
            status: "NOT_CONFIGURED",
            detail: "STRIPE_SECRET_KEY not set. Simulated mode records local events only.",
            error: null,
          };
    }
    case "eshipper": {
      const { eshipperMode } = await import("./eshipper.server");
      return eshipperMode() === "real"
        ? { status: "HEALTHY", detail: "eShipper credentials and endpoint paths are set.", error: null }
        : {
            status: "NOT_CONFIGURED",
            detail: "eShipper credentials not set. Simulated quotes/booking are active.",
            error: null,
          };
    }
    case "plaid": {
      const { plaidConfigured } = await import("./plaid.server");
      return plaidConfigured()
        ? { status: "HEALTHY", detail: "PLAID_CLIENT_ID/PLAID_SECRET are set.", error: null }
        : {
            status: "NOT_CONFIGURED",
            detail: "Plaid credentials not set. Simulated bank linking is active.",
            error: null,
          };
    }
    case "inventory_sync": {
      const count = await prisma.product.count({ where: { isActive: true } });
      return count > 0
        ? { status: "HEALTHY", detail: `Local catalog authority active with ${count} active product(s).`, error: null }
        : {
            status: "NEVER_SYNCED",
            detail: "Local catalog is empty. Add products to activate inventory sync.",
            error: null,
          };
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
      actorType: actor ? "OWNER_USER" : "SYSTEM",
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
      actorType: actor ? "OWNER_USER" : "SYSTEM",
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
