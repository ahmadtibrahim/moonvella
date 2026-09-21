/**
 * Odoo connector.
 *
 * MoonVella talks to Odoo over its external JSON-RPC API, never over the
 * database. That is a hard rule, not a preference: the connector below has no
 * database client, no SQL, and no `pg` import anywhere in its dependency
 * graph. It cannot reach `Prod-db` even if the credentials were wrong, because
 * it never opens a PostgreSQL connection at all.
 *
 * Three independent guards stand between this code and a live write:
 *
 *   1. Database-name guard (`assertDatabaseAllowed`) — refuses to authenticate
 *      against a database literally named `Prod-db` unless the operator has set
 *      ODOO_ALLOW_PROD_DB=yes. This project's own production database is
 *      therefore off-limits by default, by name.
 *   2. Mode guard (`odooMode`) — writes are refused unless ODOO_MODE=live.
 *      Anything less is read-only, and anything unset is disabled outright.
 *   3. Preview guard — every write function returns a preview of exactly what
 *      would be sent unless `confirm: true` is passed, so a caller cannot
 *      mutate Odoo by accident.
 *
 * The connector is inert until credentials are supplied. With no
 * ODOO_URL/ODOO_USERNAME/ODOO_API_KEY it reports "not configured" and every
 * call raises before any network I/O.
 */

import { systemAudit, AUDIT_ENTITY } from "./audit.server";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_TIMEOUT_MS = 15_000;

export type OdooMode = "disabled" | "readonly" | "live";

export interface OdooConfig {
  url: string;
  database: string;
  username: string;
  apiKey: string;
  timeoutMs: number;
}

/**
 * A database whose name matches this is refused unless explicitly unlocked.
 * Matched case-insensitively and with surrounding whitespace trimmed so that
 * `prod-db`, `Prod-db ` and `PROD-DB` are all caught.
 */
const PROTECTED_DATABASE_NAMES = new Set(["prod-db"]);

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("__REQUIRED")) return null;
  return trimmed;
}

export function odooConfig(): OdooConfig | null {
  const url = readEnv("ODOO_URL");
  const database = readEnv("ODOO_DATABASE");
  const username = readEnv("ODOO_USERNAME");
  const apiKey = readEnv("ODOO_API_KEY");
  if (!url || !database || !username || !apiKey) return null;

  const timeoutRaw = Number(readEnv("ODOO_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS;

  return { url: url.replace(/\/+$/, ""), database, username, apiKey, timeoutMs };
}

export function odooConfigured(): boolean {
  return odooConfig() !== null;
}

/**
 * `disabled`  — no credentials, or explicitly turned off. Nothing is called.
 * `readonly`  — credentials present; reads allowed, writes refused.
 * `live`      — reads and writes allowed, still subject to the database guard.
 *
 * The default is NOT `live`. An operator must opt in explicitly, which means a
 * misconfigured environment fails closed rather than writing to a real ERP.
 */
export function odooMode(): OdooMode {
  if (!odooConfigured()) return "disabled";
  const raw = (readEnv("ODOO_MODE") ?? "readonly").toLowerCase();
  if (raw === "live") return "live";
  if (raw === "disabled" || raw === "off" || raw === "none") return "disabled";
  return "readonly";
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class OdooError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "OdooError";
  }
}

export class OdooNotConfiguredError extends OdooError {
  constructor() {
    super(
      "Odoo is not configured. Set ODOO_URL, ODOO_DATABASE, ODOO_USERNAME and ODOO_API_KEY.",
      "NOT_CONFIGURED",
    );
    this.name = "OdooNotConfiguredError";
  }
}

export class OdooDatabaseBlockedError extends OdooError {
  constructor(database: string) {
    super(
      `Refusing to connect to Odoo database "${database}": it is a protected production ` +
        `database. MoonVella must never read or write it. Point ODOO_DATABASE at a ` +
        `dedicated database, or set ODOO_ALLOW_PROD_DB=yes if this is a deliberate, ` +
        `reviewed decision.`,
      "PROTECTED_DATABASE",
    );
    this.name = "OdooDatabaseBlockedError";
  }
}

export class OdooWriteBlockedError extends OdooError {
  constructor(reason: string) {
    super(reason, "WRITE_BLOCKED");
    this.name = "OdooWriteBlockedError";
  }
}

/**
 * Guard 1. Called before authentication on every request path, so an
 * accidental Prod-db configuration fails before a single byte is sent.
 */
export function assertDatabaseAllowed(database: string): void {
  const normalised = database.trim().toLowerCase();
  if (!PROTECTED_DATABASE_NAMES.has(normalised)) return;
  const override = (readEnv("ODOO_ALLOW_PROD_DB") ?? "").toLowerCase();
  if (override === "yes") return;
  throw new OdooDatabaseBlockedError(database);
}

/**
 * Guard 2. Throws unless the connector is permitted to mutate Odoo.
 */
export function assertWriteAllowed(operation: string): void {
  const mode = odooMode();
  if (mode === "disabled") {
    throw new OdooWriteBlockedError(
      `Cannot ${operation}: Odoo is not configured.`,
    );
  }
  if (mode !== "live") {
    throw new OdooWriteBlockedError(
      `Cannot ${operation}: ODOO_MODE is "${mode}", not "live". Set ODOO_MODE=live ` +
        `to permit Odoo writes.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  method: "call";
  params: { service: string; method: string; args: unknown[] };
  id: number;
}

let rpcCounter = 0;

/**
 * One authenticated call. Odoo's external API takes the password on every
 * execute_kw, so there is no session to cache and no cookie jar to leak — the
 * credential never leaves this function.
 */
async function callOdoo(
  service: "common" | "object",
  method: string,
  args: unknown[],
  config: OdooConfig,
): Promise<unknown> {
  const envelope: JsonRpcEnvelope = {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args },
    id: ++rpcCounter,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw new OdooError(
      aborted
        ? `Odoo request timed out after ${config.timeoutMs}ms.`
        : `Could not reach Odoo at ${config.url}.`,
      aborted ? "TIMEOUT" : "UNREACHABLE",
      error,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new OdooError(
      `Odoo returned HTTP ${response.status}.`,
      "HTTP_ERROR",
      { status: response.status },
    );
  }

  let payload: {
    result?: unknown;
    error?: { code?: number; message?: string; data?: { message?: string } };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    throw new OdooError("Odoo returned a non-JSON response.", "BAD_RESPONSE", error);
  }

  if (payload.error) {
    // Odoo nests the human-readable cause in error.data.message. Prefer it over
    // the generic top-level "Odoo Server Error".
    const detail =
      payload.error.data?.message ?? payload.error.message ?? "Unknown Odoo error";
    throw new OdooError(detail, "RPC_ERROR", payload.error);
  }

  return payload.result;
}

/* -------------------------------------------------------------------------- */
/* Authentication + health                                                    */
/* -------------------------------------------------------------------------- */

export interface OdooIdentity {
  uid: number;
  database: string;
  username: string;
  serverVersion: string | null;
}

/**
 * Authenticates and returns the resolved uid. This is the only function that
 * sends credentials to `common.authenticate`; every other call reuses the uid
 * returned here but still carries the credential, as Odoo's API requires.
 */
export async function authenticate(): Promise<OdooIdentity> {
  const config = odooConfig();
  if (!config) throw new OdooNotConfiguredError();
  assertDatabaseAllowed(config.database);

  const uid = await callOdoo(
    "common",
    "authenticate",
    [config.database, config.username, config.apiKey, {}],
    config,
  );

  if (typeof uid !== "number" || uid <= 0) {
    throw new OdooError(
      "Odoo rejected the credentials. Check ODOO_USERNAME and ODOO_API_KEY, and " +
        "confirm the service account has access to this database.",
      "AUTH_FAILED",
    );
  }

  let serverVersion: string | null = null;
  try {
    const version = (await callOdoo("common", "version", [], config)) as {
      server_version?: string;
    };
    serverVersion = version?.server_version ?? null;
  } catch {
    // Version is informational. A failure here must not fail authentication.
  }

  return { uid, database: config.database, username: config.username, serverVersion };
}

export interface OdooHealth {
  configured: boolean;
  mode: OdooMode;
  ok: boolean;
  uid?: number;
  serverVersion?: string | null;
  databaseBlocked?: boolean;
  error?: string;
}

/**
 * Safe to call from a health endpoint: never throws, never writes.
 */
export async function checkOdooHealth(): Promise<OdooHealth> {
  const config = odooConfig();
  if (!config) return { configured: false, mode: "disabled", ok: false };

  try {
    assertDatabaseAllowed(config.database);
  } catch (error) {
    return {
      configured: true,
      mode: odooMode(),
      ok: false,
      databaseBlocked: true,
      error: (error as Error).message,
    };
  }

  try {
    const identity = await authenticate();
    return {
      configured: true,
      mode: odooMode(),
      ok: true,
      uid: identity.uid,
      serverVersion: identity.serverVersion,
    };
  } catch (error) {
    return {
      configured: true,
      mode: odooMode(),
      ok: false,
      error: (error as Error).message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Generic model access                                                       */
/* -------------------------------------------------------------------------- */

type Domain = unknown[];

async function executeKw<T>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const config = odooConfig();
  if (!config) throw new OdooNotConfiguredError();
  assertDatabaseAllowed(config.database);

  const identity = await authenticate();
  return (await callOdoo(
    "object",
    "execute_kw",
    [config.database, identity.uid, config.apiKey, model, method, args, kwargs],
    config,
  )) as T;
}

export interface OdooRecord {
  id: number;
  [key: string]: unknown;
}

/**
 * Constrained on `{ id: number }` rather than on `OdooRecord`: the latter
 * carries an index signature, which would force every caller-facing interface
 * to declare one too. Every Odoo model has an integer `id`, and that is the
 * only guarantee callers actually rely on.
 */
export async function searchRead<T extends { id: number } = OdooRecord>(
  model: string,
  domain: Domain,
  fields: string[] = [],
  options: { limit?: number; order?: string; offset?: number } = {},
): Promise<T[]> {
  const result = await executeKw<T[]>(model, "search_read", [domain], {
    fields,
    limit: options.limit ?? 80,
    ...(options.order ? { order: options.order } : {}),
    ...(options.offset ? { offset: options.offset } : {}),
  });
  return result ?? [];
}

export async function searchCount(model: string, domain: Domain): Promise<number> {
  return (await executeKw<number>(model, "search_count", [domain])) ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Domain operations                                                          */
/* -------------------------------------------------------------------------- */

/** The Odoo model this connector treats as the customer record. */
const PARTNER_MODEL = "res.partner";
const PRODUCT_MODEL = "product.product";
const SALE_ORDER_MODEL = "sale.order";
const ACCOUNT_MOVE_MODEL = "account.move";

export interface OdooPartner {
  id: number;
  name: string;
  email: string | false;
  phone?: string | false;
  vat?: string | false;
}

/** Read-only lookup by exact email. Returns null when absent. */
export async function findPartnerByEmail(email: string): Promise<OdooPartner | null> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return null;
  const rows = await searchRead<OdooPartner>(
    PARTNER_MODEL,
    [["email", "=ilike", normalised]],
    ["id", "name", "email", "phone", "vat"],
    { limit: 1 },
  );
  return rows[0] ?? null;
}

export async function findProductByCode(code: string): Promise<OdooRecord | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const rows = await searchRead(
    PRODUCT_MODEL,
    [["default_code", "=", trimmed]],
    ["id", "name", "default_code", "list_price", "uom_id", "type"],
    { limit: 1 },
  );
  return rows[0] ?? null;
}

export interface OdooWritePreview {
  operation: string;
  model: string;
  method: string;
  payload: unknown;
  executed: false;
}

/**
 * Guard 3. Wraps a write so that, unless `confirm` is true, the caller receives
 * a description of the change instead of causing it. This mirrors the
 * preview-every-write behaviour used elsewhere in MoonVella.
 */
async function guardedWrite<T>(
  operation: string,
  model: string,
  method: string,
  payload: unknown,
  confirm: boolean,
  run: () => Promise<T>,
): Promise<T | OdooWritePreview> {
  if (!confirm) {
    return { operation, model, method, payload, executed: false };
  }
  assertWriteAllowed(operation);
  const result = await run();
  await systemAudit(`odoo.${operation}`, AUDIT_ENTITY.INTEGRATION, model, {
    afterData: { payload, result },
  });
  return result;
}

export async function upsertPartner(
  input: { name: string; email: string; phone?: string; vat?: string },
  options: { confirm?: boolean } = {},
): Promise<{ id: number } | OdooWritePreview> {
  return guardedWrite(
    "partner.create",
    PARTNER_MODEL,
    "create",
    input,
    options.confirm === true,
    async () => {
      const id = await executeKw<number>(PARTNER_MODEL, "create", [
        {
          name: input.name,
          email: input.email,
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.vat ? { vat: input.vat } : {}),
        },
      ]);
      return { id };
    },
  );
}

export interface SaleOrderLine {
  productId: number;
  quantity: number;
  priceUnit: number;
  name?: string;
}

export async function createSaleOrder(
  input: { partnerId: number; lines: SaleOrderLine[]; clientOrderRef?: string },
  options: { confirm?: boolean } = {},
): Promise<{ id: number } | OdooWritePreview> {
  const payload = {
    partner_id: input.partnerId,
    ...(input.clientOrderRef ? { client_order_ref: input.clientOrderRef } : {}),
    order_line: input.lines.map((line) => [
      0,
      0,
      {
        product_id: line.productId,
        product_uom_qty: line.quantity,
        price_unit: line.priceUnit,
        ...(line.name ? { name: line.name } : {}),
      },
    ]),
  };

  return guardedWrite(
    "sale.order.create",
    SALE_ORDER_MODEL,
    "create",
    payload,
    options.confirm === true,
    async () => ({ id: await executeKw<number>(SALE_ORDER_MODEL, "create", [payload]) }),
  );
}

/**
 * Confirms a quotation (`action_confirm`). Separate from create so an operator
 * can stage a draft and inspect it in Odoo before it becomes binding.
 */
export async function confirmSaleOrder(
  orderId: number,
  options: { confirm?: boolean } = {},
): Promise<{ confirmed: boolean } | OdooWritePreview> {
  return guardedWrite(
    "sale.order.confirm",
    SALE_ORDER_MODEL,
    "action_confirm",
    { id: orderId },
    options.confirm === true,
    async () => {
      await executeKw(SALE_ORDER_MODEL, "action_confirm", [[orderId]]);
      return { confirmed: true };
    },
  );
}

export async function createInvoiceFromSaleOrder(
  orderId: number,
  options: { confirm?: boolean } = {},
): Promise<{ id: number } | OdooWritePreview> {
  return guardedWrite(
    "account.move.create_from_sale_order",
    ACCOUNT_MOVE_MODEL,
    "_create_invoices",
    { sale_order_id: orderId },
    options.confirm === true,
    async () => {
      await executeKw(SALE_ORDER_MODEL, "_create_invoices", [[orderId]]);
      const invoices = await searchRead<{ id: number }>(
        ACCOUNT_MOVE_MODEL,
        [["invoice_origin", "!=", false]],
        ["id"],
        { limit: 1, order: "id desc" },
      );
      if (!invoices[0]) {
        throw new OdooError(
          "Odoo created no invoice for the sale order.",
          "NO_INVOICE_CREATED",
        );
      }
      return { id: invoices[0].id };
    },
  );
}

export interface OdooInvoiceState {
  id: number;
  name: string | false;
  state: string;
  payment_state: string | false;
  amount_total: number;
  amount_residual: number;
  currency: string | false;
}

/** Read-only invoice status lookup, keyed by the Odoo invoice id. */
export async function getInvoiceState(
  invoiceId: number,
): Promise<OdooInvoiceState | null> {
  const rows = await searchRead<OdooInvoiceState>(
    ACCOUNT_MOVE_MODEL,
    [["id", "=", invoiceId]],
    [
      "id",
      "name",
      "state",
      "payment_state",
      "amount_total",
      "amount_residual",
      "currency_id",
    ],
    { limit: 1 },
  );
  return rows[0] ?? null;
}

/**
 * Registers a payment against an invoice. Intentionally requires explicit
 * confirmation; this is the call that would move real money in the ledger.
 */
export async function registerPayment(
  input: {
    invoiceId: number;
    journalId: number;
    amount: number;
    paymentDate: string;
  },
  options: { confirm?: boolean } = {},
): Promise<{ id: number } | OdooWritePreview> {
  const context = {
    active_model: ACCOUNT_MOVE_MODEL,
    active_ids: [input.invoiceId],
  };

  return guardedWrite(
    "account.payment.register",
    "account.payment.register",
    "create",
    input,
    options.confirm === true,
    async () => {
      const wizardId = await executeKw<number>(
        "account.payment.register",
        "create",
        [
          {
            journal_id: input.journalId,
            amount: input.amount,
            payment_date: input.paymentDate,
          },
        ],
        { context },
      );
      await executeKw("account.payment.register", "action_create_payments", [
        [wizardId],
      ]);
      return { id: wizardId };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Integration health                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Human-readable state for the admin integration panel. Deliberately describes
 * the safety posture, because "configured" alone would hide the Prod-db guard.
 */
export function describeOdooIntegration(): {
  status: "NOT_CONFIGURED" | "OK" | "BLOCKED";
  message: string;
} {
  const config = odooConfig();
  if (!config) {
    return {
      status: "NOT_CONFIGURED",
      message:
        "Odoo is not configured. Set ODOO_URL, ODOO_DATABASE, ODOO_USERNAME and " +
        "ODOO_API_KEY with a dedicated service account. MoonVella connects only over " +
        "Odoo's JSON-RPC API and never to its PostgreSQL database.",
    };
  }

  try {
    assertDatabaseAllowed(config.database);
  } catch (error) {
    return { status: "BLOCKED", message: (error as Error).message };
  }

  const mode = odooMode();
  return {
    status: "OK",
    message:
      `Odoo API configured for database "${config.database}" in ${mode} mode. ` +
      (mode === "live"
        ? "Writes are permitted and audited."
        : "Writes are refused until ODOO_MODE=live."),
  };
}
