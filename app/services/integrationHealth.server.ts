import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

export type IntegrationKey =
  | "stripe"
  | "eshipper"
  | "odoo";

const DEFAULTS: Record<IntegrationKey, { status: string; message: string; credentialHints: string }> = {
  stripe: {
    status: "NOT_CONFIGURED",
    message:
      "Stripe test key not configured. Set STRIPE_SECRET_KEY (test mode) to enable wholesale payment collection. Simulated mode records events locally only.",
    credentialHints: "STRIPE_SECRET_KEY: test-mode secret key\nSTRIPE_PUBLISHABLE_KEY: (optional) publishable key for test environment\nSTRIPE_WEBHOOK_SECRET: webhook signing secret for order webhooks",
  },
  eshipper: {
    status: "NOT_CONFIGURED",
    message:
      "eShipper not configured. Set ESHIPPER_BASE_URL, ESHIPPER_USERNAME, ESHIPPER_PASSWORD and rate/booking/label paths from the account docs for real quotes/booking. Simulated mode is active meanwhile.",
    credentialHints: "ESHIPPER_BASE_URL: account API base URL\nESHIPPER_USERNAME: account username / API user\nESHIPPER_PASSWORD: account password / API secret\nESHIPPER_RATE_PATH: rate-quote path (from docs)\nESHIPPER_BOOK_PATH: booking path (from docs)\nESHIPPER_LABEL_PATH: label path (from docs)\nESHIPPER_TRACK_PATH: tracking path (from docs)\nESHIPPER_CANCEL_PATH: cancel/void path (from docs)",
  },
  odoo: {
    status: "NOT_CONFIGURED",
    message:
      "Odoo is not configured. Set ODOO_URL, ODOO_DATABASE, ODOO_USERNAME and ODOO_API_KEY with a dedicated API service account. MoonVella reaches Odoo only over JSON-RPC and never through its PostgreSQL database; writes additionally require ODOO_MODE=live.",
    credentialHints: "ODOO_URL: Odoo instance URL (e.g. https://erp.premafirm.com)\nODOO_DATABASE: database name\nODOO_USERNAME: service account username\nODOO_API_KEY: service account API key\nODOO_MODE: readonly (default) or live\nODOO_ALLOW_PROD_DB: yes (only if connecting to Prod-db deliberately)",
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
    case "odoo": {
      const { describeOdooIntegration } = await import("./odoo.server");
      const described = describeOdooIntegration();
      return {
        status: described.status === "OK" ? "HEALTHY" : described.status,
        detail: described.message,
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

/** Save integration credentials and re-check status. */
export async function saveIntegrationCredentials(
  key: IntegrationKey,
  credentials: Record<string, string>,
  actor: IntegrationActor
) {
  // Persist credentials server-side (outside the database, via .env or secure store)
  // For now, we record the fact that credentials were provided and re-check status.
  // The actual .env update must be done by the deployment pipeline, not this API.
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "integration.credentials_saved",
    entityType: AUDIT_ENTITY.INTEGRATION,
    entityId: key,
    afterData: { credentialCount: Object.keys(credentials).length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  // Re-check integration status with new credentials
  return refreshIntegration(key, actor);
}

/** Disconnect an integration: reset status to NOT_CONFIGURED and stop provider operations. */
export async function disconnectIntegration(key: IntegrationKey, actor: IntegrationActor) {
  await setIntegrationState(key, {
    status: "NOT_CONFIGURED",
    detail: "Disconnected by operator. Provider operations disabled.",
    error: null,
  });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "integration.disconnected",
    entityType: AUDIT_ENTITY.INTEGRATION,
    entityId: key,
    beforeData: { status: (await prisma.integrationState.findUnique({ where: { key } }))?.status },
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
