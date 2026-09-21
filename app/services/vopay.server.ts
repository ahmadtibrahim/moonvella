import { createHash, randomUUID } from "node:crypto";
import { prisma } from "~/db.server";
import { systemAudit } from "./audit.server";

/**
 * VoPay integration — Canadian EFT / Pre-Authorized Debit (PAD).
 *
 * MoonVella debits a seller's own bank account under a signed Canadian PAD
 * agreement. That makes the mandate, not the charge, the thing this module is
 * really about: a debit that is not backed by a live, unrevoked mandate is not
 * recoverable. Under Payments Canada Rule H1 the payer can have their bank
 * reverse an unauthorized debit, so "we thought the mandate was still good" is
 * not a defensible position. The rules below are therefore deliberately strict:
 *
 *   1. The mandate lifecycle is an explicit state machine. Only
 *      PENDING -> ACTIVE -> SUSPENDED -> ACTIVE and "anything -> CANCELLED" are
 *      legal. An illegal transition THROWS. It never quietly does nothing,
 *      because a silent no-op reads to the caller as success.
 *   2. CANCELLED is terminal. A payer's revocation must be irreversible without
 *      a fresh mandate and a fresh authorization, so no path leads out of it.
 *   3. `chargePad` refuses anything other than an ACTIVE mandate.
 *   4. Every mutating call takes a caller-supplied idempotency key, which is
 *      checked locally AND sent to VoPay. A retry after a timeout must never
 *      become a second debit on the payer's account.
 *   5. A base URL that is not explicitly a sandbox fails safe to simulated mode
 *      unless VOPAY_ENV=production (see `vopayConfigured`). Production is never
 *      reached by accident.
 *   6. A production deployment that resolves to simulated mode refuses to
 *      operate (see `assertOperable`). Pretending to charge is worse than
 *      failing: it would let a release ship with no funds moving at all.
 *
 * Data handling:
 * - Credentials are owner-managed and backend-only. They are never returned to
 *   the browser, never stored in the database and never logged. Admin screens
 *   receive `maskedVopayAccount()` only.
 * - Bank numbers are used to build the mandate request and are then discarded;
 *   the module keeps last-4 only, which is all a UI ever needs.
 * - The module owns no payment rows of its own. VoPay is the system of record
 *   for both mandates and debits, so local records exist only to make retries
 *   idempotent and to simulate the provider when unconfigured. Each transition
 *   is written to the shared audit log instead, through `auditPad` below.
 *
 * Env var names (values live only in the backend .env, excluded from git):
 *   VOPAY_ACCOUNT_ID     account identifier issued by VoPay
 *   VOPAY_API_KEY        API key for the account
 *   VOPAY_API_SECRET     API secret for the account
 *   VOPAY_BASE_URL       API base URL (must be a sandbox URL unless VOPAY_ENV=production)
 *   VOPAY_ENV            sandbox | production (default sandbox)
 *   VOPAY_TIMEOUT_MS     per-request timeout, default 15000
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** Audit entity label for every PAD record this module writes. */
const PAD_AUDIT_ENTITY = "VopayPadMandate";

/**
 * Resource paths, in one place so a reviewer can see exactly where requests go.
 * These must be confirmed against the account's official VoPay documentation
 * before VOPAY_ENV=production is set; nothing is sent until `vopayConfigured()`
 * is true, which additionally requires an explicitly sandbox base URL.
 */
const PATHS = {
  mandates: "/v1/mandates",
  mandate: (mandateId: string) => `/v1/mandates/${encodeURIComponent(mandateId)}`,
  suspend: (mandateId: string) => `/v1/mandates/${encodeURIComponent(mandateId)}/suspend`,
  resume: (mandateId: string) => `/v1/mandates/${encodeURIComponent(mandateId)}/resume`,
  cancel: (mandateId: string) => `/v1/mandates/${encodeURIComponent(mandateId)}/cancel`,
  charges: "/v1/charges",
} as const;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Missing, blank and placeholder values all mean "not configured". A `.env`
 * template that ships `__REQUIRED_NOT_SET__` must never be mistaken for a
 * working credential — that mistake would produce a production call with a
 * nonsense key instead of a clearly labelled simulated run.
 */
function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("__REQUIRED")) return null;
  return trimmed;
}

interface VopayCredentials {
  accountId: string;
  apiKey: string;
  apiSecret: string;
}

function vopayCredentials(): VopayCredentials | null {
  const accountId = readEnv("VOPAY_ACCOUNT_ID");
  const apiKey = readEnv("VOPAY_API_KEY");
  const apiSecret = readEnv("VOPAY_API_SECRET");
  if (!accountId || !apiKey || !apiSecret) return null;
  return { accountId, apiKey, apiSecret };
}

export function vopayEnv(): string {
  return (readEnv("VOPAY_ENV") ?? "sandbox").toLowerCase();
}

function vopayBaseUrl(): string | null {
  const raw = readEnv("VOPAY_BASE_URL");
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * True only when the credentials are complete AND the base URL is confirmed
 * safe for the declared environment.
 *
 * Fail-safe rule: outside production the base URL must explicitly look like a
 * sandbox. A production URL — or a URL we cannot confirm, including no URL at
 * all — fails safe to simulated mode. The cost of an accidental real PAD debit
 * against someone's bank account is far higher than the cost of a simulated
 * run, so the default answer to "is this URL safe?" must be no.
 */
export function vopayConfigured(): boolean {
  if (!vopayCredentials()) return false;
  const base = vopayBaseUrl();
  if (!base) return false;
  // In production the operator has explicitly declared the environment, so the
  // URL is taken as given.
  if (vopayEnv() === "production") return true;
  return /sandbox/i.test(base);
}

export function vopayMode(): "real" | "simulated" {
  return vopayConfigured() ? "real" : "simulated";
}

export function vopayTimeoutMs(): number {
  const raw = Number(readEnv("VOPAY_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Masked identifier safe to display in admin screens. Never a secret: at most
 * the last four characters survive, and anything too short to mask is hidden
 * entirely rather than shown in full.
 */
export function maskToLast4(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return "****";
  return `****${trimmed.slice(-4)}`;
}

export function maskedVopayAccount(): string | null {
  const credentials = vopayCredentials();
  return credentials ? maskToLast4(credentials.accountId) : null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type VopayErrorCode =
  | "NOT_CONFIGURED"
  | "SIMULATED_IN_PRODUCTION"
  | "VALIDATION"
  | "MANDATE_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "MANDATE_CANCELLED"
  | "MANDATE_NOT_ACTIVE"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_UNRESOLVED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENT_REPLAY_FAILED"
  | "TIMEOUT"
  | "UNREACHABLE"
  | "HTTP_ERROR"
  | "BAD_RESPONSE";

/**
 * Every failure carries a machine-readable code so callers can branch on it
 * without matching on prose. Messages never contain credentials, bank numbers
 * or request payloads.
 */
export class VopayError extends Error {
  constructor(
    message: string,
    readonly code: VopayErrorCode,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "VopayError";
  }
}

/* -------------------------------------------------------------------------- */
/* Mandate state machine                                                      */
/* -------------------------------------------------------------------------- */

export type PadMandateState = "PENDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";

/**
 * PENDING   — created, the payer's authorization has not been confirmed yet.
 * ACTIVE    — authorized; debits are permitted.
 * SUSPENDED — temporarily paused; authorized but no debits until resumed.
 * CANCELLED — revoked by the payer or the merchant. Terminal.
 *
 * There are no self-transitions: resuming an already-ACTIVE mandate is an
 * error, not a no-op, so a caller cannot mistake it for a state change that
 * happened.
 */
const PAD_TRANSITIONS: Record<PadMandateState, readonly PadMandateState[]> = {
  PENDING: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["SUSPENDED", "CANCELLED"],
  SUSPENDED: ["ACTIVE", "CANCELLED"],
  CANCELLED: [],
};

export function isLegalPadTransition(from: PadMandateState, to: PadMandateState): boolean {
  return PAD_TRANSITIONS[from].includes(to);
}

/**
 * Throws on every illegal transition. CANCELLED gets its own code because it is
 * the one state a caller must never work around: the payer has revoked, and the
 * only lawful way forward is a new mandate with a new authorization.
 */
export function assertLegalPadTransition(from: PadMandateState, to: PadMandateState): void {
  if (isLegalPadTransition(from, to)) return;
  if (from === "CANCELLED") {
    throw new VopayError(
      `PAD mandate is CANCELLED and cannot become ${to}. A cancellation is final; ` +
        `create a new mandate and collect a fresh authorization instead.`,
      "MANDATE_CANCELLED",
    );
  }
  throw new VopayError(
    `Illegal PAD mandate transition ${from} -> ${to}. Legal transitions are ` +
      `PENDING->ACTIVE, ACTIVE->SUSPENDED, SUSPENDED->ACTIVE and any->CANCELLED.`,
    "ILLEGAL_TRANSITION",
  );
}

/* -------------------------------------------------------------------------- */
/* Local records                                                              */
/* -------------------------------------------------------------------------- */

interface PadMandateRecord {
  id: string;
  sellerId: string;
  state: PadMandateState;
  reference: string | null;
  payerName: string;
  accountLast4: string | null;
  institutionNumber: string | null;
  transitNumber: string | null;
  accountType: string;
  simulated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Display-safe view of a mandate. Contains no account or transit number. */
export interface PadMandateResult {
  id: string;
  sellerId: string;
  state: PadMandateState;
  reference: string | null;
  payerName: string;
  accountLast4: string | null;
  institutionNumber: string | null;
  transitNumber: string | null;
  accountType: string;
  simulated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Outcome of a debit request. A PAD debit is never instantly final. */
export interface PadChargeResult {
  providerChargeId: string;
  mandateId: string;
  sellerId: string;
  /** Whole cents, as everywhere else in the ledger. */
  amount: number;
  currency: "CAD";
  /**
   * PROCESSING at submission. An EFT/PAD debit settles over business days, so
   * this module never reports a debit as settled or paid — only VoPay's
   * confirmation (or a reconciliation run) may do that.
   */
  status: "PROCESSING";
  reference: string | null;
  submittedAt: Date;
  simulated: boolean;
}

/**
 * Mandate records live in PostgreSQL, not in a Map.
 *
 * A PAD mandate carries a payer's standing authorization to debit their bank
 * account. If that state lived in process memory, a restart would erase the
 * record of a cancellation and the next collection run would debit a payer who
 * had already revoked. The provider remains the ultimate authority and is
 * consulted first in real mode; this table is the durable local mirror.
 */
type PadMandateRow = {
  id: string;
  sellerId: string;
  state: string;
  reference: string | null;
  payerName: string;
  accountLast4: string | null;
  institutionNumber: string | null;
  transitNumber: string | null;
  accountType: string;
  simulated: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toMandateRecord(row: PadMandateRow): PadMandateRecord {
  return { ...row, state: row.state as PadMandateState };
}

function cloneResult<T>(value: T): T {
  // A replay must not hand the caller a reference into the store.
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

function fingerprintOf(value: unknown): string {
  // One-way digest: the raw bank numbers that go into a fingerprint are never
  // retained, and the digest never leaves the process.
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

/**
 * Idempotency gate for every mutating call.
 *
 * A blank key is refused rather than defaulted: the whole point is that the
 * caller decides what constitutes "the same operation", and a generated key
 * would make every retry a new debit.
 *
 * The same key with different parameters is a conflict, not a replay. Silently
 * returning the earlier result would hide a caller bug that, on a payment path,
 * ends in the wrong amount being collected.
 */
async function withIdempotency<T>(
  operation: string,
  idempotencyKey: string,
  fingerprint: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const key = idempotencyKey?.trim();
  if (!key) {
    throw new VopayError(
      `An idempotency key is required for ${operation}. Supply a stable key per ` +
        `intended operation so a retry after a timeout cannot become a second debit.`,
      "VALIDATION",
    );
  }

  const scope = `${operation}:${key}`;
  const digest = fingerprintOf(fingerprint);

  // A durable claim, not a read-then-write. Two concurrent retries of the same
  // debit race here; the unique constraint on (scope, key) means exactly one of
  // them wins the insert and the other falls through to the replay path below.
  // A check-then-insert would let both through and debit the payer twice.
  let claimed = true;
  try {
    await prisma.idempotencyKey.create({
      data: { scope, key, fingerprint: digest, status: "IN_PROGRESS" },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    claimed = false;
  }

  if (!claimed) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });
    if (!existing) {
      // The row vanished between the failed insert and this read. Refusing is
      // the only safe answer: we cannot prove the earlier attempt did not
      // reach the provider.
      throw new VopayError(
        `Idempotency record for ${operation} disappeared mid-flight. Refusing to ` +
          `issue a second provider call.`,
        "IDEMPOTENCY_UNRESOLVED",
      );
    }
    if (existing.fingerprint !== digest) {
      throw new VopayError(
        `Idempotency key "${key}" was already used for ${operation} with different ` +
          `parameters. Use a new key for a genuinely new operation.`,
        "IDEMPOTENCY_CONFLICT",
      );
    }
    if (existing.status === "IN_PROGRESS") {
      // An earlier attempt claimed the key but never recorded an outcome. It
      // may or may not have reached the provider, so re-issuing could double
      // debit. Surfacing this for reconciliation is the honest outcome.
      throw new VopayError(
        `A previous ${operation} with key "${key}" is still unresolved. It is not ` +
          `known whether the provider received it. Reconcile against the provider ` +
          `before retrying.`,
        "IDEMPOTENCY_IN_PROGRESS",
      );
    }
    // A replay returns the recorded outcome and makes no provider call. That
    // also means a replay of a successful debit still reports success after the
    // mandate was suspended or cancelled in the meantime — the debit did happen.
    if (existing.status === "FAILED") {
      throw new VopayError(
        existing.error ?? `${operation} previously failed.`,
        "IDEMPOTENT_REPLAY_FAILED",
      );
    }
    return cloneResult(existing.result) as T;
  }

  try {
    const result = await run();
    await prisma.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: {
        status: "SUCCEEDED",
        result: cloneResult(result) as never,
        completedAt: new Date(),
      },
    });
    return result;
  } catch (error) {
    // Record the failure so a retry replays the error instead of re-attempting
    // a debit that the provider may already have accepted.
    await prisma.idempotencyKey
      .update({
        where: { scope_key: { scope, key } },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      })
      .catch(() => {
        // Losing the failure record must not mask the original error, which is
        // the one the caller needs. The row stays IN_PROGRESS and will surface
        // as IDEMPOTENCY_IN_PROGRESS on retry — the safe direction.
      });
    throw error;
  }
}

/** Prisma's unique-constraint violation, matched without importing its enum. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2002"
  );
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Refuses to act when a production deployment resolves to simulated mode.
 *
 * Simulated mode is honest in development and fatal in production: mandate
 * rows would be written, sellers would be told their account is set up, and no
 * money would ever move. Failing loudly here means a misconfigured production
 * release is caught by its first PAD attempt instead of by a receivable that
 * quietly never gets collected.
 */
function assertOperable(operation: string): "real" | "simulated" {
  const mode = vopayMode();
  if (mode === "simulated" && process.env.NODE_ENV === "production") {
    throw new VopayError(
      `Refusing to ${operation}: VoPay resolves to simulated mode while NODE_ENV=production. ` +
        `Set VOPAY_ACCOUNT_ID/VOPAY_API_KEY/VOPAY_API_SECRET and a VOPAY_BASE_URL confirmed for ` +
        `this environment (VOPAY_ENV=production for live debits).`,
      "SIMULATED_IN_PRODUCTION",
    );
  }
  return mode;
}

/**
 * Audit without ever blocking the mandate.
 *
 * VoPay holds the authoritative mandate state and every transition can be
 * re-read from it, so an unavailable audit sink must not leave a mandate
 * half-changed: refusing to cancel a mandate because the log was down would be
 * the worse failure. The error is logged without credentials and the caller
 * still receives the provider's outcome.
 */
async function auditPad(
  action: string,
  entityId: string,
  extra: { beforeData?: unknown; afterData?: unknown } = {},
): Promise<void> {
  try {
    await systemAudit(action, PAD_AUDIT_ENTITY, entityId, extra);
  } catch (error) {
    // Collapsed to one line: driver errors are multi-line and would otherwise
    // bury the surrounding payment log entries.
    const message = (error instanceof Error ? error.message : "unknown error")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    console.warn(`[vopay] audit record failed for ${action} (${entityId}): ${message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

interface VopayRequestInput {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  /** Present on every mutating call; sent as the Idempotency-Key header. */
  idempotencyKey?: string;
}

/**
 * One authenticated call. The authorization scheme and header names must be
 * confirmed against the account's VoPay documentation; they live in this single
 * function so a reviewer can see exactly what leaves the server and what does
 * not. Credentials are read here and never stored on a record or returned.
 */
async function vopayRequest(input: VopayRequestInput): Promise<Record<string, unknown>> {
  const credentials = vopayCredentials();
  const base = vopayBaseUrl();
  if (!credentials || !base) {
    throw new VopayError(
      "VoPay is not configured. Set VOPAY_ACCOUNT_ID/VOPAY_API_KEY/VOPAY_API_SECRET and a " +
        "VOPAY_BASE_URL for this environment.",
      "NOT_CONFIGURED",
    );
  }

  const controller = new AbortController();
  const timeoutMs = vopayTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${base}${input.path}`, {
      method: input.method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${credentials.apiKey}:${credentials.apiSecret}`).toString("base64")}`,
        "X-Account-Id": credentials.accountId,
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      ...(input.body
        ? { body: JSON.stringify({ ...input.body, idempotencyKey: input.idempotencyKey }) }
        : {}),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as { name?: string })?.name === "AbortError";
    throw new VopayError(
      aborted
        ? `VoPay request timed out after ${timeoutMs}ms.`
        : `Could not reach VoPay at ${base}.`,
      aborted ? "TIMEOUT" : "UNREACHABLE",
      error,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // The provider's free-text message is deliberately not surfaced: it can
    // echo the request body back, and the request body carries bank numbers.
    const code = await providerErrorCode(response);
    throw new VopayError(
      `VoPay returned HTTP ${response.status}${code ? ` (${code})` : ""}.`,
      "HTTP_ERROR",
      { status: response.status, code },
    );
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw new VopayError("VoPay returned a non-JSON response.", "BAD_RESPONSE", error);
  }
}

async function providerErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const nested = body?.error as Record<string, unknown> | undefined;
    const code = body?.code ?? nested?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Validation and mapping                                                     */
/* -------------------------------------------------------------------------- */

export interface PadBankAccountInput {
  /** Canadian institution number: exactly three digits. */
  institutionNumber: string;
  /** Canadian transit number: exactly five digits. */
  transitNumber: string;
  /** Account number: five to twelve digits. */
  accountNumber: string;
  accountType?: "chequing" | "savings";
}

/**
 * A Canadian PAD is keyed on the institution/transit/account triple, and a
 * malformed one is rejected by the bank days later as an unpaid debit that
 * still costs the payer a return fee. Checking the shapes here costs nothing.
 */
function assertPadBankAccount(account: PadBankAccountInput | undefined): void {
  const digits = (value: string | undefined) => (value ?? "").replace(/\s+/g, "");
  if (!/^\d{3}$/.test(digits(account?.institutionNumber))) {
    throw new VopayError("Bank institution number must be exactly three digits.", "VALIDATION");
  }
  if (!/^\d{5}$/.test(digits(account?.transitNumber))) {
    throw new VopayError("Bank transit number must be exactly five digits.", "VALIDATION");
  }
  if (!/^\d{5,12}$/.test(digits(account?.accountNumber))) {
    throw new VopayError("Bank account number must be five to twelve digits.", "VALIDATION");
  }
}

function normaliseProviderState(raw: unknown): PadMandateState {
  const state = String(raw ?? "").trim().toUpperCase();
  if (state === "PENDING" || state === "ACTIVE" || state === "SUSPENDED" || state === "CANCELLED") {
    return state;
  }
  // An unrecognised provider status is an error, not something to smooth over:
  // guessing here could treat a revoked mandate as ACTIVE and debit against it.
  throw new VopayError(
    `VoPay reported an unrecognised mandate status (${state || "empty"}).`,
    "BAD_RESPONSE",
  );
}

function publicMandate(record: PadMandateRecord): PadMandateResult {
  return {
    id: record.id,
    sellerId: record.sellerId,
    state: record.state,
    reference: record.reference,
    payerName: record.payerName,
    accountLast4: record.accountLast4,
    institutionNumber: record.institutionNumber,
    transitNumber: record.transitNumber,
    accountType: record.accountType,
    simulated: record.simulated,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Resolve a mandate, preferring the provider when it is authoritative.
 *
 * In simulated mode the local record is the only source, and no network call is
 * attempted — an unconfigured deployment must stay completely inert.
 */
async function loadMandate(
  mandateId: string,
  options: { refresh?: boolean } = {},
): Promise<PadMandateRecord> {
  const id = mandateId?.trim();
  if (!id) throw new VopayError("A PAD mandate id is required.", "VALIDATION");

  const row = await prisma.padMandate.findUnique({ where: { id } });
  const local = row ? toMandateRecord(row) : null;
  if (vopayMode() === "real" && (!local || options.refresh)) {
    const raw = await vopayRequest({ method: "GET", path: PATHS.mandate(id) });
    const state = normaliseProviderState(raw.status ?? raw.state);
    const refreshed: PadMandateRecord = {
      id,
      sellerId: String(raw.sellerId ?? local?.sellerId ?? ""),
      state,
      reference: local?.reference ?? null,
      payerName: local?.payerName ?? String(raw.payerName ?? ""),
      accountLast4: local?.accountLast4 ?? maskToLast4(String(raw.accountNumber ?? "")),
      institutionNumber: local?.institutionNumber ?? null,
      transitNumber: local?.transitNumber ?? null,
      accountType: local?.accountType ?? "chequing",
      simulated: false,
      createdAt: local?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    const saved = await prisma.padMandate.upsert({
      where: { id },
      create: {
        id,
        sellerId: refreshed.sellerId,
        state: refreshed.state,
        reference: refreshed.reference,
        payerName: refreshed.payerName,
        accountLast4: refreshed.accountLast4,
        institutionNumber: refreshed.institutionNumber,
        transitNumber: refreshed.transitNumber,
        accountType: refreshed.accountType,
        simulated: refreshed.simulated,
        createdAt: refreshed.createdAt,
      },
      update: {
        state: refreshed.state,
        reference: refreshed.reference,
        payerName: refreshed.payerName,
        accountLast4: refreshed.accountLast4,
        simulated: refreshed.simulated,
      },
    });
    return toMandateRecord(saved);
  }

  if (!local) {
    // An unknown id is an error rather than an empty result: returning "no
    // mandate" invites a caller to create a duplicate one.
    throw new VopayError(`No PAD mandate ${id} is known to this deployment.`, "MANDATE_NOT_FOUND");
  }
  return local;
}

/* -------------------------------------------------------------------------- */
/* Mandate lifecycle                                                          */
/* -------------------------------------------------------------------------- */

export interface CreatePadMandateInput {
  sellerId: string;
  /** The payer's legal name as it appears on the bank account. */
  payerName: string;
  payerEmail?: string | null;
  /** Description the payer will see, e.g. "MoonVella wholesale account". */
  reference?: string | null;
  bankAccount: PadBankAccountInput;
  idempotencyKey: string;
}

/**
 * Initiate a mandate. The result is PENDING: the payer's authorization still
 * has to be confirmed before the mandate is worth anything, and Rule H1 also
 * gives the payer a notice period before a first debit may be presented. This
 * module never skips that step; `activatePadMandate` is the only way in.
 */
export async function createPadMandate(input: CreatePadMandateInput): Promise<PadMandateResult> {
  const mode = assertOperable("create a PAD mandate");
  const sellerId = input.sellerId?.trim();
  if (!sellerId) throw new VopayError("A seller id is required.", "VALIDATION");
  if (!input.payerName?.trim()) {
    throw new VopayError(
      "The payer's legal name is required: it is what the payer recognises on the " +
        "mandate and on their bank statement.",
      "VALIDATION",
    );
  }
  assertPadBankAccount(input.bankAccount);

  const account = input.bankAccount;
  // The fingerprint identifies the mandate request without retaining the
  // account number itself; the digest is one-way and stays in this process.
  const fingerprint = {
    sellerId,
    payerName: input.payerName.trim(),
    reference: input.reference ?? null,
    institutionNumber: account.institutionNumber,
    transitNumber: account.transitNumber,
    accountNumberDigest: fingerprintOf(account.accountNumber.replace(/\s+/g, "")),
  };

  return withIdempotency("pad.mandate.create", input.idempotencyKey, fingerprint, async () => {
    const now = new Date();
    let record: PadMandateRecord;

    if (mode === "real") {
      const raw = await vopayRequest({
        method: "POST",
        path: PATHS.mandates,
        idempotencyKey: input.idempotencyKey,
        body: {
          sellerId,
          payerName: input.payerName.trim(),
          payerEmail: input.payerEmail ?? undefined,
          reference: input.reference ?? undefined,
          bankAccount: {
            institutionNumber: account.institutionNumber,
            transitNumber: account.transitNumber,
            accountNumber: account.accountNumber.replace(/\s+/g, ""),
            accountType: account.accountType ?? "chequing",
          },
        },
      });
      const id = String(raw.id ?? raw.mandateId ?? "").trim();
      if (!id) throw new VopayError("VoPay did not return a mandate id.", "BAD_RESPONSE");
      record = {
        id,
        sellerId,
        state: normaliseProviderState(raw.status ?? raw.state),
        reference: input.reference ?? null,
        payerName: input.payerName.trim(),
        accountLast4: maskToLast4(account.accountNumber.replace(/\s+/g, "")),
        institutionNumber: account.institutionNumber,
        transitNumber: account.transitNumber,
        accountType: account.accountType ?? "chequing",
        simulated: false,
        createdAt: now,
        updatedAt: now,
      };
    } else {
      record = {
        id: `sim_mandate_${randomUUID().slice(0, 8)}`,
        sellerId,
        state: "PENDING",
        reference: input.reference ?? null,
        payerName: input.payerName.trim(),
        accountLast4: maskToLast4(account.accountNumber.replace(/\s+/g, "")),
        institutionNumber: account.institutionNumber,
        transitNumber: account.transitNumber,
        accountType: account.accountType ?? "chequing",
        simulated: true,
        createdAt: now,
        updatedAt: now,
      };
    }

    const saved = await prisma.padMandate.create({
      data: {
        id: record.id,
        sellerId: record.sellerId,
        state: record.state,
        reference: record.reference,
        payerName: record.payerName,
        accountLast4: record.accountLast4,
        institutionNumber: record.institutionNumber,
        transitNumber: record.transitNumber,
        accountType: record.accountType,
        simulated: record.simulated,
        createdAt: record.createdAt,
      },
    });
    await auditPad("vopay.mandate.created", record.id, {
      afterData: {
        sellerId,
        state: record.state,
        reference: record.reference,
        accountLast4: record.accountLast4,
        simulated: record.simulated,
      },
    });
    return publicMandate(toMandateRecord(saved));
  });
}

/** Current state of one mandate. VoPay is authoritative in real mode. */
export async function getPadMandate(mandateId: string): Promise<PadMandateResult> {
  assertOperable("read a PAD mandate");
  const record = await loadMandate(mandateId, { refresh: vopayMode() === "real" });
  return publicMandate(record);
}

export interface PadMandateActionInput {
  idempotencyKey: string;
}

/**
 * Confirm that the payer authorized the mandate. PENDING -> ACTIVE only; in
 * real mode VoPay has to report the authorization first, because a mandate we
 * activated on our own would be exactly the unauthorized debit Rule H1 lets the
 * payer reverse.
 */
export async function activatePadMandate(
  mandateId: string,
  input: PadMandateActionInput,
): Promise<PadMandateResult> {
  const mode = assertOperable("activate a PAD mandate");
  return withIdempotency("pad.mandate.activate", input?.idempotencyKey ?? "", { mandateId }, async () => {
    // Assert against the state we already knew (PENDING -> ACTIVE), then let
    // VoPay confirm the authorization. The provider's answer is not itself a
    // transition to check: an already-ACTIVE mandate is only reachable here
    // through a replay, which the idempotency gate would have returned already.
    let record = await loadMandate(mandateId);
    const previous = record.state;
    assertLegalPadTransition(previous, "ACTIVE");
    if (mode === "real") {
      const confirmed = await loadMandate(mandateId, { refresh: true });
      if (confirmed.state !== "ACTIVE") {
        throw new VopayError(
          `VoPay has not confirmed the payer's authorization for mandate ${confirmed.id} ` +
            `(reported state: ${confirmed.state}).`,
          "MANDATE_NOT_ACTIVE",
        );
      }
      record = confirmed;
    }
    return applyState(record, "ACTIVE", "vopay.mandate.activated", previous);
  });
}

/**
 * Pause debits without revoking the authorization: the payer keeps their
 * mandate and the merchant keeps the ability to resume it.
 */
export async function suspendPadMandate(
  mandateId: string,
  input: PadMandateActionInput,
): Promise<PadMandateResult> {
  const mode = assertOperable("suspend a PAD mandate");
  return withIdempotency("pad.mandate.suspend", input?.idempotencyKey ?? "", { mandateId }, async () => {
    const record = await loadMandate(mandateId, { refresh: mode === "real" });
    assertLegalPadTransition(record.state, "SUSPENDED");
    if (mode === "real") {
      await vopayRequest({
        method: "POST",
        path: PATHS.suspend(record.id),
        idempotencyKey: input.idempotencyKey,
        body: { mandateId: record.id },
      });
    }
    return applyState(record, "SUSPENDED", "vopay.mandate.suspended");
  });
}

export async function resumePadMandate(
  mandateId: string,
  input: PadMandateActionInput,
): Promise<PadMandateResult> {
  const mode = assertOperable("resume a PAD mandate");
  return withIdempotency("pad.mandate.resume", input?.idempotencyKey ?? "", { mandateId }, async () => {
    const record = await loadMandate(mandateId, { refresh: mode === "real" });
    assertLegalPadTransition(record.state, "ACTIVE");
    if (mode === "real") {
      await vopayRequest({
        method: "POST",
        path: PATHS.resume(record.id),
        idempotencyKey: input.idempotencyKey,
        body: { mandateId: record.id },
      });
    }
    return applyState(record, "ACTIVE", "vopay.mandate.resumed");
  });
}

/**
 * Revoke a mandate. Terminal by construction: the state machine has no edges
 * out of CANCELLED, so every later call — including a resume with a fresh
 * idempotency key — is refused rather than quietly ignored.
 */
export async function cancelPadMandate(
  mandateId: string,
  input: PadMandateActionInput,
): Promise<PadMandateResult> {
  const mode = assertOperable("cancel a PAD mandate");
  return withIdempotency("pad.mandate.cancel", input?.idempotencyKey ?? "", { mandateId }, async () => {
    const record = await loadMandate(mandateId, { refresh: mode === "real" });
    assertLegalPadTransition(record.state, "CANCELLED");
    if (mode === "real") {
      await vopayRequest({
        method: "POST",
        path: PATHS.cancel(record.id),
        idempotencyKey: input.idempotencyKey,
        body: { mandateId: record.id },
      });
    }
    return applyState(record, "CANCELLED", "vopay.mandate.cancelled");
  });
}

async function applyState(
  record: PadMandateRecord,
  next: PadMandateState,
  action: string,
  previous: PadMandateState = record.state,
): Promise<PadMandateResult> {
  // Persist before auditing. The audit line asserts "this transition happened",
  // so the state must already be durable when it is written; the reverse order
  // could record a cancellation that a crash then erased.
  const saved = await prisma.padMandate.update({
    where: { id: record.id },
    data: { state: next },
  });
  const updated = toMandateRecord(saved);
  await auditPad(action, updated.id, {
    beforeData: { state: previous },
    afterData: { state: next, simulated: updated.simulated },
  });
  return publicMandate(updated);
}

/* -------------------------------------------------------------------------- */
/* Debits                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChargePadInput {
  mandateId: string;
  /** Whole cents. Fractional cents are refused rather than rounded. */
  amount: number;
  currency?: "CAD";
  reference?: string | null;
  idempotencyKey: string;
}

/**
 * Debit an active mandate.
 *
 * The mandate state is re-read from VoPay before a real debit, because a
 * suspension or cancellation that happened seconds ago is exactly the case
 * where the last known local state is not good enough — debiting a cancelled
 * mandate is the failure this whole module exists to prevent.
 */
export async function chargePad(input: ChargePadInput): Promise<PadChargeResult> {
  const mode = assertOperable("debit a PAD mandate");
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new VopayError(
      "A PAD debit amount must be a positive whole number of cents.",
      "VALIDATION",
    );
  }
  const currency = (input.currency ?? "CAD").toUpperCase();
  if (currency !== "CAD") {
    throw new VopayError(
      "Canadian PAD debits settle in CAD only. Convert or bill in another provider for other currencies.",
      "VALIDATION",
    );
  }

  return withIdempotency(
    "pad.charge",
    input.idempotencyKey,
    { mandateId: input.mandateId, amount: input.amount, currency, reference: input.reference ?? null },
    async () => {
      const record = await loadMandate(input.mandateId, { refresh: mode === "real" });
      if (record.state === "CANCELLED") {
        throw new VopayError(
          `Refusing to debit mandate ${record.id}: it is CANCELLED. A cancelled mandate ` +
            `cannot be charged; collect a new authorization first.`,
          "MANDATE_CANCELLED",
        );
      }
      if (record.state !== "ACTIVE") {
        throw new VopayError(
          `Refusing to debit mandate ${record.id}: it is ${record.state}, not ACTIVE. A PAD ` +
            `debit requires a live mandate; resume or activate it first.`,
          "MANDATE_NOT_ACTIVE",
        );
      }

      const submittedAt = new Date();
      let charge: PadChargeResult;

      if (mode === "real") {
        const raw = await vopayRequest({
          method: "POST",
          path: PATHS.charges,
          idempotencyKey: input.idempotencyKey,
          body: {
            mandateId: record.id,
            amount: input.amount,
            currency,
            reference: input.reference ?? undefined,
          },
        });
        const chargeId = String(raw.id ?? raw.chargeId ?? "").trim();
        if (!chargeId) throw new VopayError("VoPay did not return a charge id.", "BAD_RESPONSE");
        charge = {
          providerChargeId: chargeId,
          mandateId: record.id,
          sellerId: record.sellerId,
          amount: input.amount,
          currency: "CAD",
          status: "PROCESSING",
          reference: input.reference ?? null,
          submittedAt,
          simulated: false,
        };
      } else {
        charge = {
          providerChargeId: `sim_charge_${randomUUID().slice(0, 8)}`,
          mandateId: record.id,
          sellerId: record.sellerId,
          amount: input.amount,
          currency: "CAD",
          status: "PROCESSING",
          reference: input.reference ?? null,
          submittedAt,
          simulated: true,
        };
      }

      await auditPad("vopay.debit.submitted", charge.providerChargeId, {
        afterData: {
          mandateId: record.id,
          sellerId: record.sellerId,
          amount: charge.amount,
          currency: charge.currency,
          status: charge.status,
          reference: charge.reference,
          simulated: charge.simulated,
        },
      });
      return charge;
    },
  );
}
