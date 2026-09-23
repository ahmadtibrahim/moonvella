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
import { getCredentials, redactSecrets } from "./credentials.server";

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

/**
 * Deployment-only switches. These are read from the environment and are
 * DELIBERATELY NOT storeable fields: a browser form must never be able to
 * authorise writes to a real ERP, nor to unlock the production database guard.
 *
 *   ODOO_ALLOW_WRITES   — second key for writes. `live` mode alone is not enough.
 *   ODOO_ALLOW_PROD_DB  — unlocks the Prod-db guard (guard 1).
 */
function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("__REQUIRED")) return null;
  return trimmed;
}

function envFlag(name: string): boolean {
  return (readEnv(name) ?? "").toLowerCase() === "yes";
}

/** Timeout stays deployment configuration; it is not a credential. */
function timeoutMs(): number {
  const raw = Number(readEnv("ODOO_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Every credential comes from the encrypted store, which itself falls back to
 * the environment — so a value saved in Settings takes effect without a
 * deployment, and an operator's Disconnect suppresses the environment too.
 *
 * This is what makes the Settings form real rather than decorative. The previous
 * version read `process.env` directly, so saving Odoo credentials on the
 * Settings page changed nothing and the form said so in its own note.
 *
 * ODOO_MODE is resolved from the same place (it is a storeable field) but only
 * ever *restricts*: turning writes ON additionally requires the deployment-only
 * ODOO_ALLOW_WRITES=yes, so the form cannot grant write access on its own.
 */
interface OdooState {
  config: OdooConfig | null;
  mode: OdooMode;
  /** Deployment-only opt-in, resolved separately from anything storeable. */
  writesAllowed: boolean;
}

/**
 * One store read for everything the connector decides from. Two reads would be
 * two chances for the mode and the credentials to disagree.
 */
async function loadOdooState(): Promise<OdooState> {
  const values = await getCredentials("odoo");
  const url = values.ODOO_URL;
  const database = values.ODOO_DATABASE;
  const username = values.ODOO_USERNAME;
  const apiKey = values.ODOO_API_KEY;

  const config: OdooConfig | null =
    url && database && username && apiKey
      ? { url: url.replace(/\/+$/, ""), database, username, apiKey, timeoutMs: timeoutMs() }
      : null;

  const writesAllowed = envFlag("ODOO_ALLOW_WRITES");
  return {
    config,
    mode: classifyOdooMode({
      configured: config !== null,
      mode: values.ODOO_MODE ?? null,
      writesAllowed,
    }),
    writesAllowed,
  };
}

export async function resolveOdooConfig(): Promise<OdooConfig | null> {
  return (await loadOdooState()).config;
}

export async function odooConfigured(): Promise<boolean> {
  return (await loadOdooState()).config !== null;
}

/**
 * The connection identifiers, safe to display. Anything secret (the API key)
 * is represented by whether it is set, never by its value. Used by Settings and
 * by the integration panel so an operator can see WHICH Odoo is targeted.
 */
export async function maskedOdooConnection(): Promise<{
  url: string | null;
  database: string | null;
  username: string | null;
  apiKeySet: boolean;
} | null> {
  const values = await getCredentials("odoo");
  if (!values.ODOO_URL && !values.ODOO_DATABASE) return null;
  return {
    url: values.ODOO_URL ?? null,
    database: values.ODOO_DATABASE ?? null,
    username: values.ODOO_USERNAME ?? null,
    apiKeySet: !!values.ODOO_API_KEY,
  };
}

export interface OdooModeInput {
  configured: boolean;
  /** Resolved ODOO_MODE, from the store or the environment. */
  mode: string | null;
  /** Deployment-only ODOO_ALLOW_WRITES=yes. Never storeable. */
  writesAllowed: boolean;
}

/**
 * The mode ladder, as a pure function.
 *
 * Split out from the store lookup deliberately: this is the rule that decides
 * whether writes are possible at all, and it is the part worth testing against
 * every combination without depending on what is configured on the host.
 *
 * `disabled`  — no credentials, or explicitly turned off. Nothing is called.
 * `readonly`  — credentials present; reads allowed, writes refused.
 * `live`      — reads and writes allowed, still subject to the database guard.
 *
 * Writes need TWO independent keys: ODOO_MODE=live (which an operator may set
 * from Settings) AND ODOO_ALLOW_WRITES=yes (which only a deployment can set).
 * A browser form therefore cannot turn on writing to a real ERP, and an
 * unrecognised mode always falls back to readonly rather than to live.
 */
export function classifyOdooMode(input: OdooModeInput): OdooMode {
  if (!input.configured) return "disabled";
  const raw = (input.mode ?? "readonly").trim().toLowerCase();
  if (raw === "disabled" || raw === "off" || raw === "none") return "disabled";
  if (raw !== "live") return "readonly";
  return input.writesAllowed ? "live" : "readonly";
}

export async function odooMode(): Promise<OdooMode> {
  return (await loadOdooState()).mode;
}

/**
 * Why writes are refused, in the operator's terms. Returned rather than logged
 * so Settings can show the missing switch instead of a bare refusal.
 */
export async function odooWriteBlockReason(): Promise<string | null> {
  const state = await loadOdooState();
  if (state.mode === "live") return null;
  if (state.mode === "disabled") {
    return "Odoo is not configured. Save the URL, database, username and API key in Settings.";
  }
  const requestedLive = (await getCredentials("odoo")).ODOO_MODE === "live";
  if (requestedLive && !state.writesAllowed) {
    return (
      "ODOO_MODE is set to live, but writes also require ODOO_ALLOW_WRITES=yes in the " +
      "deployment environment. That second switch is deliberately not settable from this page, " +
      "so a browser form can never authorise writing to the ERP."
    );
  }
  return 'ODOO_MODE is "readonly". Set it to "live" in Settings, and set ODOO_ALLOW_WRITES=yes in the deployment.';
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
 * Proof that the write check ran and passed.
 *
 * This exists so a missing `await` fails CLOSED. Resolving the mode now requires
 * the credential store, so the check is asynchronous; an async guard whose
 * result is not awaited is a guard that silently does nothing, which is exactly
 * the failure this connector cannot afford. `executeKw` refuses any method that
 * can mutate unless it is handed a permit, and a permit can only be produced by
 * an awaited `assertWriteAllowed` — a forgotten `await` yields a Promise, which
 * is not a permit, and the write is refused.
 */
const WRITE_PERMIT = Symbol("moonvella.odoo.write-permit");

export interface OdooWritePermit {
  readonly [WRITE_PERMIT]: true;
  readonly operation: string;
}

export function isWritePermit(value: unknown): value is OdooWritePermit {
  return typeof value === "object" && value !== null && WRITE_PERMIT in value;
}

/**
 * Guard 2. Throws unless the connector is permitted to mutate Odoo, otherwise
 * returns the permit the transport requires.
 */
export async function assertWriteAllowed(operation: string): Promise<OdooWritePermit> {
  const mode = await odooMode();
  if (mode === "disabled") {
    throw new OdooWriteBlockedError(
      `Cannot ${operation}: Odoo is not configured.`,
    );
  }
  if (mode !== "live") {
    const reason = await odooWriteBlockReason();
    throw new OdooWriteBlockedError(`Cannot ${operation}: ${reason}`);
  }
  return { [WRITE_PERMIT]: true, operation };
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
  const config = await resolveOdooConfig();
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
  const state = await loadOdooState();
  const config = state.config;
  if (!config) return { configured: false, mode: "disabled", ok: false };

  try {
    assertDatabaseAllowed(config.database);
  } catch (error) {
    return {
      configured: true,
      mode: state.mode,
      ok: false,
      databaseBlocked: true,
      error: (error as Error).message,
    };
  }

  try {
    const identity = await authenticate();
    return {
      configured: true,
      mode: state.mode,
      ok: true,
      uid: identity.uid,
      serverVersion: identity.serverVersion,
    };
  } catch (error) {
    return {
      configured: true,
      mode: state.mode,
      ok: false,
      error: (error as Error).message,
    };
  }
}

export interface OdooAuthTest {
  /** True only when Odoo accepted the credentials and returned a uid. */
  ok: boolean;
  configured: boolean;
  mode: OdooMode;
  database: string | null;
  username: string | null;
  serverVersion: string | null;
  databaseBlocked: boolean;
  /**
   * Whether this account may write, and why not when it may not. Reported as
   * guidance, never as a promise: the Odoo-side permissions are a separate
   * question from MoonVella's own switch.
   */
  writeBlockReason: string | null;
  reason: string | null;
}

/**
 * Authenticate against Odoo and stop there.
 *
 * This is what "Test connection" runs. It proves the four credentials resolve
 * and that Odoo accepts them, without reading a record, creating an order, or
 * posting anything to the ledger. A presence check ("all four fields are set")
 * is a different and much weaker fact, and is not what Settings reports.
 *
 * Safe by construction: it only ever calls `common.authenticate` and
 * `common.version`, both of which are read-only on Odoo's side.
 */
export async function testOdooConnection(): Promise<OdooAuthTest> {
  const state = await loadOdooState();
  const config = state.config;
  const masked = await maskedOdooConnection();

  const base = {
    configured: config !== null,
    mode: state.mode,
    database: masked?.database ?? null,
    username: masked?.username ?? null,
    serverVersion: null as string | null,
    databaseBlocked: false,
    writeBlockReason: await odooWriteBlockReason(),
  };

  if (!config) {
    return {
      ...base,
      ok: false,
      reason:
        "Odoo is not configured. Save the URL, database, username and API key below, " +
        "then test again.",
    };
  }

  try {
    assertDatabaseAllowed(config.database);
  } catch (error) {
    return {
      ...base,
      ok: false,
      databaseBlocked: true,
      reason: (error as Error).message,
    };
  }

  try {
    const identity = await authenticate();
    return { ...base, ok: true, serverVersion: identity.serverVersion, reason: null };
  } catch (error) {
    return {
      ...base,
      ok: false,
      reason: error instanceof Error ? redactSecrets(error.message) : "Authentication failed.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Generic model access                                                       */
/* -------------------------------------------------------------------------- */

type Domain = unknown[];

/**
 * The methods this connector may call WITHOUT a write permit.
 *
 * An allowlist rather than a denylist, deliberately. A denylist of dangerous
 * method names would silently permit every method nobody thought of — including
 * ones added by an Odoo upgrade, and including the `_`-prefixed private methods
 * Odoo refuses over RPC anyway. Here, an unlisted method is refused locally
 * before any network call, so the connector's write surface is a closed set.
 */
const READ_METHODS = new Set([
  "search_read",
  "search_count",
  "search",
  "read",
  "fields_get",
  "name_get",
  "name_search",
]);

/**
 * One `execute_kw`. Requires a write permit for every method that is not on the
 * read allowlist.
 *
 * This is the structural half of guard 2: `assertWriteAllowed` is async (it
 * resolves the mode from the credential store), and an async guard whose result
 * is not awaited does nothing at all. Handing the permit to the transport means
 * a forgotten `await` produces a Promise instead of a permit and the call is
 * refused — the mistake fails closed instead of silently writing.
 */
async function executeKw<T>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
  permit?: OdooWritePermit,
): Promise<T> {
  if (!READ_METHODS.has(method) && !isWritePermit(permit)) {
    throw new OdooWriteBlockedError(
      `Refusing ${model}.${method}: it is not a read method and no write permit was ` +
        `supplied. Writes must go through a guarded function that awaits ` +
        `assertWriteAllowed() first.`
    );
  }

  const config = await resolveOdooConfig();
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
/** Transient wizard that exposes the public Create-Invoice operation. */
const INVOICE_WIZARD_MODEL = "sale.advance.payment.inv";

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
 *
 * The permit from guard 2 is handed to `run` rather than dropped, and the
 * transport will not perform a mutating call without it. The guard is therefore
 * load-bearing at two independent points, and removing the `await` below breaks
 * the write instead of bypassing the check.
 */
async function guardedWrite<T>(
  operation: string,
  model: string,
  method: string,
  payload: unknown,
  confirm: boolean,
  run: (permit: OdooWritePermit) => Promise<T>,
): Promise<T | OdooWritePreview> {
  if (!confirm) {
    return { operation, model, method, payload, executed: false };
  }
  const permit = await assertWriteAllowed(operation);
  const result = await run(permit);
  await systemAudit(`odoo.${operation}`, AUDIT_ENTITY.INTEGRATION, model, {
    afterData: { payload, result },
  });
  return result;
}

export interface PartnerWriteResult {
  id: number;
  /**
   * `CREATED` when a new contact was written, `REUSED` when an existing one was
   * matched and nothing was written. A caller that sees `REUSED` must not treat
   * the partner as freshly synced — no field of it was updated.
   */
  outcome: "CREATED" | "REUSED";
}

export type PartnerWriteOutcome = PartnerWriteResult | OdooWritePreview;

/** Raised instead of writing when a match is not certain enough to act on. */
export class OdooPartnerReviewRequiredError extends OdooError {
  constructor(
    message: string,
    readonly candidates: PartnerCandidate[],
  ) {
    super(message, "PARTNER_REVIEW_REQUIRED");
    this.name = "OdooPartnerReviewRequiredError";
  }
}

export interface PartnerCandidate {
  id: number;
  name: string;
  email: string | false;
  vat?: string | false;
}

export type PartnerAction = "CREATE" | "REUSE" | "REVIEW";

export interface PartnerDecision {
  action: PartnerAction;
  /** Why, in the operator's terms. Shown when the answer is REVIEW. */
  reason: string;
  /** The one partner to reuse. Null unless the action is REUSE. */
  partnerId: number | null;
  /** Everyone the identifiers touched, for presentation. */
  candidates: PartnerCandidate[];
}

const normaliseEmail = (value: string | false | undefined) => (value || "").trim().toLowerCase();
/** Tax IDs are compared case- and space-insensitively; " 123 456 " is "123456". */
const normaliseVat = (value: string | false | undefined) => (value || "").replace(/\s+/g, "").toUpperCase();

/**
 * Decide what to do about a partner, given everything Odoo already holds that
 * matches one of its identifiers.
 *
 * Pure, and separated from the lookup, because this is the rule that decides
 * whether a second record for the same company ever gets written — and it is the
 * part worth testing against every combination without a live Odoo.
 *
 * The rule is deliberately conservative, and its default answer is REVIEW:
 *
 *   CREATE  nothing in Odoo carries either identifier. Safe to write.
 *   REUSE   exactly one existing partner carries BOTH the tax ID and the email.
 *           Nothing is written, which is what makes a repeated sync idempotent.
 *   REVIEW  everything else. Two partners carrying different identifiers, an
 *           email that matches but a tax ID that does not, or an email match
 *           with no tax ID to corroborate it.
 *
 * Two things it must never do, and does not:
 *
 *   It never merges. Two rows that disagree on a tax ID are not "probably the
 *   same company"; the disagreement is the finding, and it belongs to a person.
 *
 *   It never decides on email alone. Email is mutable and reused — a change of
 *   accounts contact would look exactly like a new company, and creating a
 *   duplicate for one is the failure this function exists to prevent. So a tax
 *   ID match with a different email is REVIEW, not REUSE: the record is not
 *   duplicated, and the contact change is not applied silently either. That is
 *   the emergency-contact-update case, and a person confirms it.
 */
export function decidePartnerAction(
  input: { name: string; email: string; vat?: string },
  matches: PartnerCandidate[],
): PartnerDecision {
  const wantEmail = normaliseEmail(input.email);
  const wantVat = normaliseVat(input.vat);

  const byEmail = matches.filter((m) => wantEmail && normaliseEmail(m.email) === wantEmail);
  const byVat = matches.filter((m) => wantVat && normaliseVat(m.vat) === wantVat);

  const touched = new Map<number, PartnerCandidate>();
  for (const m of [...byEmail, ...byVat]) touched.set(m.id, m);
  const candidates = [...touched.values()];

  if (candidates.length === 0) {
    return {
      action: "CREATE",
      reason: `No partner in Odoo carries ${wantVat ? "this tax ID or this email" : "this email"}.`,
      partnerId: null,
      candidates: [],
    };
  }

  if (candidates.length > 1) {
    return {
      action: "REVIEW",
      reason:
        `${candidates.length} existing partners carry one of these identifiers ` +
        `(${candidates.map((c) => c.id).join(", ")}). MoonVella does not merge companies automatically; ` +
        "a person must decide which is the same company, or that none is.",
      partnerId: null,
      candidates,
    };
  }

  const match = candidates[0];
  const vatAgrees = byVat.length === 1;
  const emailAgrees = byEmail.length === 1;

  if (vatAgrees && emailAgrees) {
    return {
      action: "REUSE",
      reason: `Partner ${match.id} ("${match.name}") matches on both tax ID and email.`,
      partnerId: match.id,
      candidates,
    };
  }

  if (vatAgrees && !emailAgrees) {
    return {
      action: "REVIEW",
      reason:
        `Partner ${match.id} ("${match.name}") matches on tax ID, but holds a different email ` +
        `("${match.email || "none"}" rather than "${input.email}"). This is a contact change on an ` +
        "existing company, so it is confirmed rather than applied — and it must not create a second record.",
      partnerId: null,
      candidates,
    };
  }

  return {
    action: "REVIEW",
    reason:
      `Partner ${match.id} ("${match.name}") matches on email alone` +
      (wantVat
        ? `, and its tax ID does not match "${input.vat}".`
        : ", and no tax ID was supplied to corroborate it.") +
      " An email address is not a stable identity, so it is not enough to reuse a record on.",
    partnerId: null,
    candidates,
  };
}

/**
 * The read half: everyone in Odoo carrying either identifier, then the pure
 * decision above. Read-only — it searches and returns, and writes nothing.
 */
export async function resolvePartner(input: {
  name: string;
  email: string;
  vat?: string;
}): Promise<PartnerDecision> {
  const email = normaliseEmail(input.email);
  const vat = normaliseVat(input.vat);

  // One query for "either identifier", rather than two, so a company that
  // matches on both is returned once and the pure decision below sees a single
  // row. Built from the leaves that actually exist: searching for
  // `vat = ""` would match every partner with no tax ID recorded, and searching
  // for nothing at all would return nothing and look like "no such company" —
  // which is the answer that creates duplicates.
  const leaves: unknown[][] = [];
  if (email) leaves.push(["email", "=ilike", email]);
  if (vat) leaves.push(["vat", "=ilike", vat]);
  if (leaves.length === 0) return decidePartnerAction(input, []);

  const domain: unknown[] = leaves.length === 1 ? leaves[0] : ["|", ...leaves];
  const matches = await searchRead<PartnerCandidate>(
    PARTNER_MODEL,
    domain,
    ["id", "name", "email", "vat"],
    { limit: 20 },
  );

  return decidePartnerAction(input, matches);
}

/**
 * Create a partner, or reuse the one that is certainly the same company.
 *
 * The previous version of this function wrote unconditionally: call it twice
 * with the same details and Odoo held two companies, with no identifier to tell
 * them apart afterwards. It now resolves first, and the resolution — not the
 * caller — decides whether a write happens.
 *
 * The preview path is unchanged and performs no lookup: describing what would
 * happen must not require reaching Odoo, or "preview" would be as fallible as
 * the write it is previewing.
 */
export async function upsertPartner(
  input: { name: string; email: string; phone?: string; vat?: string },
  options: { confirm?: boolean } = {},
): Promise<PartnerWriteOutcome> {
  return guardedWrite(
    "partner.create",
    PARTNER_MODEL,
    "create",
    input,
    options.confirm === true,
    async (permit): Promise<PartnerWriteResult> => {
      const decision = await resolvePartner(input);

      if (decision.action === "REVIEW") {
        throw new OdooPartnerReviewRequiredError(
          `Refusing to write a partner for "${input.name}": ${decision.reason}`,
          decision.candidates,
        );
      }

      if (decision.action === "REUSE" && decision.partnerId !== null) {
        return { id: decision.partnerId, outcome: "REUSED" };
      }

      const id = await executeKw<number>(
        PARTNER_MODEL,
        "create",
        [
          {
            name: input.name,
            email: input.email,
            ...(input.phone ? { phone: input.phone } : {}),
            ...(input.vat ? { vat: input.vat } : {}),
          },
        ],
        {},
        permit,
      );
      return { id, outcome: "CREATED" };
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
    async (permit) => ({
      id: await executeKw<number>(SALE_ORDER_MODEL, "create", [payload], {}, permit),
    }),
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
    async (permit) => {
      await executeKw(SALE_ORDER_MODEL, "action_confirm", [[orderId]], {}, permit);
      return { confirmed: true };
    },
  );
}

export interface OdooInvoiceSummary {
  id: number;
  /** False while the invoice is a draft — Odoo 18 no longer uses "/". */
  name: string | false;
  state: string;
  payment_state: string | false;
  amount_total: number;
  amount_residual: number;
  invoice_origin: string | false;
  company_id: [number, string] | false;
}

export interface SaleOrderLink {
  id: number;
  name: string;
  company_id: [number, string] | false;
  client_order_ref: string | false;
  partner_id: [number, string] | false;
}

/**
 * The invoices belonging to exactly ONE sale order, in one company.
 *
 * This replaces a lookup that asked for the most recent invoice in the whole
 * database (`[["invoice_origin","!=",false]]`, `order: "id desc"`, `limit: 1`)
 * and then reported its id as the invoice for this order. That query is wrong
 * in a way that gets worse the busier the system is: on a database where any
 * other invoice was created in between, it returns someone else's invoice — a
 * different customer, a different company — and MoonVella would record that id
 * against the MoonVella order. It cannot be made safe by tightening the limit,
 * because the result is not merely imprecise, it is unrelated.
 *
 * The link below is the one Odoo itself uses to answer "which invoices came
 * from this order" (`sale.advance.payment.inv.view_draft_invoices`, and
 * `sale.order._search_invoice_ids`): the order line → invoice line relation
 * `sale_order_line_invoice_rel`. It is a line-level link to the exact order, so
 * it cannot match a different order's invoice, and `company_id` is included
 * because an order and an invoice must agree on the company that owns them.
 *
 * `invoice_origin` is deliberately NOT used as the selector: it is a display
 * string, and Odoo joins several order names into it with commas when invoices
 * are grouped.
 */
export function invoiceDomainForSaleOrder(input: {
  saleOrderId: number;
  companyId?: number | null;
}): unknown[] {
  const domain: unknown[] = [
    ["line_ids.sale_line_ids.order_id", "=", input.saleOrderId],
    ["move_type", "=", "out_invoice"],
  ];
  if (typeof input.companyId === "number") {
    domain.push(["company_id", "=", input.companyId]);
  }
  return domain;
}

export async function findInvoicesForSaleOrder(input: {
  saleOrderId: number;
  companyId?: number | null;
}): Promise<OdooInvoiceSummary[]> {
  const domain = invoiceDomainForSaleOrder(input);

  return searchRead<OdooInvoiceSummary>(
    ACCOUNT_MOVE_MODEL,
    domain,
    [
      "id",
      "name",
      "state",
      "payment_state",
      "amount_total",
      "amount_residual",
      "invoice_origin",
      "company_id",
    ],
    { order: "id asc" },
  );
}

export interface CreateInvoiceResult {
  /** Every invoice this order owns, oldest first. */
  ids: number[];
  /** The one the operator is most likely to act on: a draft, else the newest. */
  id: number;
  invoices: OdooInvoiceSummary[];
}

/**
 * Invoices a confirmed sale order, using the only public workflow Odoo 18
 * offers for it.
 *
 * The previous implementation called `sale.order._create_invoices` over RPC.
 * Odoo refuses that outright: `odoo/service/model.py` `execute_cr` calls
 * `get_public_method()` before dispatch, and it raises
 * `AccessError: Private methods (such as 'sale.order._create_invoices') cannot
 * be called remotely` for any name beginning with `_`. The call could therefore
 * never have succeeded — not a misconfiguration, not a permission the operator
 * could grant, but a method Odoo will not expose over JSON-RPC at all.
 *
 * The supported route is the same one the "Create Invoice" button uses:
 * a `sale.advance.payment.inv` wizard (whose `create_invoices` IS public),
 * seeded from the order through the context `active_ids`, then `create_invoices`
 * on it. No custom Odoo module is needed for this operation — see the note in
 * the audit about which operations DO need one.
 */
export async function createInvoiceFromSaleOrder(
  orderId: number,
  options: { confirm?: boolean } = {},
): Promise<CreateInvoiceResult | OdooWritePreview> {
  return guardedWrite(
    "sale.order.create_invoice",
    INVOICE_WIZARD_MODEL,
    "create_invoices",
    { sale_order_id: orderId, advance_payment_method: "delivered" },
    options.confirm === true,
    async (permit) => {
      // Read the order first: the company is needed to scope the invoice lookup,
      // and reading it here means a bad id fails before anything is created.
      const [order] = await searchRead<SaleOrderLink>(
        SALE_ORDER_MODEL,
        [["id", "=", orderId]],
        ["id", "name", "company_id", "client_order_ref", "partner_id"],
        { limit: 1 },
      );
      if (!order) {
        throw new OdooError(
          `No sale order with id ${orderId} exists in Odoo.`,
          "SALE_ORDER_NOT_FOUND",
        );
      }

      const companyId =
        Array.isArray(order.company_id) && typeof order.company_id[0] === "number"
          ? order.company_id[0]
          : null;

      // Public workflow. The wizard takes the order from the context, not from
      // the values — `sale_order_ids` defaults to `env.context['active_ids']`.
      const wizardId = await executeKw<number>(
        INVOICE_WIZARD_MODEL,
        "create",
        [{ advance_payment_method: "delivered" }],
        {
          context: {
            active_model: SALE_ORDER_MODEL,
            active_ids: [orderId],
          },
        },
        permit,
      );
      await executeKw(INVOICE_WIZARD_MODEL, "create_invoices", [[wizardId]], {}, permit);

      // Select by the order's identity, never by recency.
      const invoices = await findInvoicesForSaleOrder({ saleOrderId: orderId, companyId });
      if (invoices.length === 0) {
        throw new OdooError(
          `Odoo reported success but no invoice is linked to sale order ${order.name} ` +
            `(id ${orderId})${companyId ? ` in company ${companyId}` : ""}. ` +
            `The usual cause is that no order line is invoiceable yet — for a ` +
            `delivery-based invoicing policy, nothing has been delivered.`,
          "NO_INVOICE_CREATED",
        );
      }

      // Prefer a draft (the one just created and still actionable); otherwise the
      // newest. Reported explicitly rather than silently picking [0].
      const draft = invoices.filter((invoice) => invoice.state === "draft");
      const pool = draft.length ? draft : invoices;
      const chosen = pool[pool.length - 1];

      return { ids: invoices.map((invoice) => invoice.id), id: chosen.id, invoices };
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
    async (permit) => {
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
        permit,
      );
      await executeKw(
        "account.payment.register",
        "action_create_payments",
        [[wizardId]],
        {},
        permit,
      );
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
export async function describeOdooIntegration(): Promise<{
  status: "NOT_CONFIGURED" | "OK" | "BLOCKED";
  message: string;
}> {
  const state = await loadOdooState();
  const config = state.config;
  if (!config) {
    return {
      status: "NOT_CONFIGURED",
      message:
        "Odoo is not configured. Save the URL, database, username and API key in " +
        "Settings. MoonVella connects only over Odoo's JSON-RPC API and never to its " +
        "PostgreSQL database.",
    };
  }

  try {
    assertDatabaseAllowed(config.database);
  } catch (error) {
    return { status: "BLOCKED", message: (error as Error).message };
  }

  return {
    status: "OK",
    message:
      `Odoo API configured for database "${config.database}" as "${config.username}" ` +
      `in ${state.mode} mode. ` +
      (state.mode === "live"
        ? "Writes are permitted and audited."
        : "Writes are refused. Setting ODOO_MODE=live in Settings is not sufficient on " +
          "its own — writes also require ODOO_ALLOW_WRITES=yes in the deployment environment."),
  };
}

/* -------------------------------------------------------------------------- */
/* Seller contact mapping                                                     */
/* -------------------------------------------------------------------------- */
/*
 * What follows is the read and write surface the approval-time contact sync
 * needs, and nothing more. Every field name here was checked against the
 * INSTALLED database before being written — `ir_model_fields` on `res.partner`,
 * `res.country`, `res.country.state`, `res.partner.category` and `product.tag` —
 * rather than against Odoo's documentation, because a field that a stock Odoo
 * has and this database does not is a write that fails at the worst moment.
 *
 * Two findings from that check shape the code:
 *
 *   • `company_type` is `store: false` on this database. It is computed from
 *     `is_company`, so "company type → Company" is expressed by writing
 *     `is_company: true`. Writing `company_type` directly is not possible.
 *
 *   • The only custom `res.partner` fields installed belong to PremaFirm's
 *     freight business (`x_freight_tax_treatment`, `x_freight_billing_relationship`,
 *     `x_*_driver_*`). None of them is a tax-registration field and none is
 *     MoonVella's, so the seller's GST/HST number goes to `vat` — the standard
 *     Odoo tax-ID field — and the customer designation goes to `customer_rank`,
 *     which is the field Odoo itself uses to mark a partner as a customer.
 *     Reusing a freight classification field would have written MoonVella's
 *     sellers into PremaFirm's tax reporting.
 */

const COUNTRY_MODEL = "res.country";
const STATE_MODEL = "res.country.state";
const PARTNER_CATEGORY_MODEL = "res.partner.category";
const PRODUCT_TAG_MODEL = "product.tag";

/**
 * The contact tag MoonVella applies, resolved BY NAME at sync time and stored
 * on the mapping.
 *
 * Resolved rather than hardcoded: `res.partner.category` ids are installation
 * data, and the id verified in this database today (248, "Moonvella app") is not
 * a fact about Odoo. The product tag is a different model entirely — `product.tag`,
 * id 2, "MoonVella App", capital A — and the two are resolved by separate
 * functions so that neither can be passed where the other belongs.
 */
export const MOONVELLA_CONTACT_TAG_NAME = "Moonvella app";
export const MOONVELLA_PRODUCT_TAG_NAME = "MoonVella App";

export interface OdooLookup {
  id: number;
  name: string;
}

/** Resolve an ISO country code to `res.country.id`. Null when not installed. */
export async function findCountryByCode(code: string): Promise<OdooLookup | null> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return null;
  const rows = await searchRead<OdooLookup>(
    COUNTRY_MODEL,
    [["code", "=", trimmed]],
    ["id", "name", "code"],
    { limit: 2 },
  );
  return rows[0] ?? null;
}

/**
 * Resolve a province/state code WITHIN a country.
 *
 * The country is part of the domain and not decoration: "ON" is Ontario in
 * Canada and nothing in the United States, and a lookup that ignored the
 * country would happily attach a Canadian province to a US address the first
 * time somebody's country code was wrong.
 */
export async function findStateByCode(
  countryId: number,
  code: string,
): Promise<OdooLookup | null> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed || !countryId) return null;
  const rows = await searchRead<OdooLookup>(
    STATE_MODEL,
    [
      ["country_id", "=", countryId],
      ["code", "=", trimmed],
    ],
    ["id", "name", "code"],
    { limit: 2 },
  );
  return rows[0] ?? null;
}

/** Resolve the MoonVella contact tag on `res.partner.category`. Read-only. */
export async function findContactTagByName(
  name: string = MOONVELLA_CONTACT_TAG_NAME,
): Promise<OdooLookup | null> {
  const rows = await searchRead<OdooLookup>(
    PARTNER_CATEGORY_MODEL,
    [["name", "=", name]],
    ["id", "name"],
    { limit: 2 },
  );
  return rows[0] ?? null;
}

/** Resolve the MoonVella product tag on `product.tag`. A DIFFERENT model. */
export async function findProductTagByName(
  name: string = MOONVELLA_PRODUCT_TAG_NAME,
): Promise<OdooLookup | null> {
  const rows = await searchRead<OdooLookup>(
    PRODUCT_TAG_MODEL,
    [["name", "=", name]],
    ["id", "name"],
    { limit: 2 },
  );
  return rows[0] ?? null;
}

const PRICELIST_MODEL = "product.pricelist";

/**
 * The pricelists this Odoo holds, for the Settings picker. Read-only.
 *
 * NEVER THROWS AND NEVER BLOCKS A PAGE. It answers `null` when Odoo is not
 * configured, is switched off, or cannot be reached — all three of which are
 * ordinary states for a Settings page that must still render. The caller falls
 * back to a plain text field, which accepts the same name-or-id the picker
 * would have offered, so a pricelist can always be set even when the list
 * cannot be read.
 *
 * The list is a convenience over that field, not a replacement for it: a
 * pricelist whose list is truncated or whose name was edited between reading
 * this and saving it must not leave the operator unable to save what they
 * meant.
 */
export async function listOdooPricelists(): Promise<OdooLookup[] | null> {
  try {
    const rows = await searchRead<OdooLookup>(
      PRICELIST_MODEL,
      [],
      ["id", "name"],
      { limit: 200, order: "name asc" },
    );
    return rows.filter((row) => typeof row.name === "string" && row.name.trim() !== "");
  } catch {
    return null;
  }
}

export interface OdooPartnerRecord extends OdooRecord {
  name?: string;
  email?: string | false;
  phone?: string | false;
  vat?: string | false;
  street?: string | false;
  street2?: string | false;
  city?: string | false;
  zip?: string | false;
  website?: string | false;
  is_company?: boolean;
  customer_rank?: number;
  parent_id?: [number, string] | false;
  category_id?: number[];
}

export const PARTNER_READ_FIELDS = [
  "id",
  "name",
  "email",
  "phone",
  "vat",
  "street",
  "street2",
  "city",
  "zip",
  "state_id",
  "country_id",
  "website",
  "is_company",
  "customer_rank",
  "parent_id",
  "category_id",
  "active",
];

/**
 * Read one partner by id. Returns null when it is gone.
 *
 * `active` is matched against both values on purpose. Odoo hides archived
 * records from a plain search, and an archived partner is not a missing one:
 * treating it as missing would make the contact sync stop and ask a person to
 * decide whether a record that is still there, still carries the seller's tax
 * id, and is simply switched off had "been removed or merged".
 */
export async function readPartner(id: number): Promise<OdooPartnerRecord | null> {
  if (!id) return null;
  const rows = await searchRead<OdooPartnerRecord>(
    PARTNER_MODEL,
    [
      ["id", "=", id],
      ["active", "in", [true, false]],
    ],
    PARTNER_READ_FIELDS,
    { limit: 1 },
  );
  return rows[0] ?? null;
}

/**
 * The partner fields the contact sync is allowed to write.
 *
 * Written as an interface rather than a bag of keys so that adding one is a
 * deliberate act: every entry here is a column on somebody's customer record.
 */
export interface PartnerValues {
  name: string;
  email?: string | null;
  phone?: string | null;
  vat?: string | null;
  street?: string | null;
  street2?: string | null;
  city?: string | null;
  zip?: string | null;
  state_id?: number | null;
  country_id?: number | null;
  website?: string | null;
  is_company?: boolean;
  customer_rank?: number;
  parent_id?: number | null;
  category_ids?: number[];
}

/**
 * Drop empty values and turn the interface into Odoo's own column names.
 *
 * A null is not written. Writing `phone: null` over a number somebody recorded
 * in Odoo would delete data MoonVella never supplied, which is the opposite of
 * "preserve unrelated Odoo fields" — so an absent value means "say nothing
 * about this column", not "clear it".
 */
export function partnerWritePayload(values: PartnerValues): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: values.name };

  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    payload[key] = value;
  };

  put("email", values.email);
  put("phone", values.phone);
  put("vat", values.vat);
  put("street", values.street);
  put("street2", values.street2);
  put("city", values.city);
  put("zip", values.zip);
  put("state_id", values.state_id);
  put("country_id", values.country_id);
  put("website", values.website);
  put("parent_id", values.parent_id);
  if (values.is_company !== undefined) payload.is_company = values.is_company;
  if (values.customer_rank !== undefined) payload.customer_rank = values.customer_rank;
  if (values.category_ids && values.category_ids.length > 0) {
    // `[6, 0, ids]` REPLACES the tag set, which would drop every other tag on
    // the record. `[4, id]` adds one without touching the rest, which is what
    // "preserve other tags" requires.
    payload.category_id = values.category_ids.map((id) => [4, id]);
  }

  return payload;
}

/** Create a partner with the mapped fields. Preview unless `confirm`. */
export async function createPartner(
  values: PartnerValues,
  options: { confirm?: boolean } = {},
): Promise<{ id: number } | OdooWritePreview> {
  const payload = partnerWritePayload(values);
  return guardedWrite(
    "partner.create",
    PARTNER_MODEL,
    "create",
    payload,
    options.confirm === true,
    async (permit) => {
      const id = await executeKw<number>(PARTNER_MODEL, "create", [payload], {}, permit);
      return { id };
    },
  );
}

/**
 * Write the mapped fields onto a partner MoonVella already owns a mapping to.
 *
 * This is the retry path. A second approval, a reapplication, or a retry after
 * an outage writes to the SAME partner id, because the mapping says that id is
 * this seller's. It deliberately does not go through `decidePartnerAction`: the
 * decision was already made and recorded when the mapping was created, and
 * re-deciding would turn a retry into a second judgement about identity.
 *
 * Only the mapped fields are sent. Everything else on the record — PremaFirm's
 * columns, other tags, notes, the salesperson — is left exactly as it was.
 */
export async function updatePartner(
  partnerId: number,
  values: PartnerValues,
  options: { confirm?: boolean } = {},
): Promise<{ id: number } | OdooWritePreview> {
  const payload = partnerWritePayload(values);
  return guardedWrite(
    "partner.update",
    PARTNER_MODEL,
    "write",
    { partnerId, payload },
    options.confirm === true,
    async (permit) => {
      await executeKw<boolean>(PARTNER_MODEL, "write", [[partnerId], payload], {}, permit);
      return { id: partnerId };
    },
  );
}
