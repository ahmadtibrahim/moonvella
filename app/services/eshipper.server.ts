/**
 * eShipper logistics integration boundary.
 *
 * Authentication follows the documented flow:
 *   POST {base}/api/v2/authenticate     -> obtain bearer token
 *   POST {base}/api/v2/refresh-token    -> refresh bearer token
 *   subsequent requests: Authorization: Bearer <token>
 *
 * Credentials are owner-managed and server-side ONLY. They are stored encrypted,
 * are never returned to the browser and are never logged; admin screens receive
 * only a masked account identifier and a status. Resolution order is the
 * encrypted store first, then the environment, and an operator's Disconnect
 * cancels both — see services/credentials.server.ts.
 *
 * Rate/booking/label/tracking/cancel endpoint paths follow the official
 * documentation exactly. When required configuration is absent, the module
 * runs in a clearly labelled simulated mode.
 *
 * Field names (values live in the encrypted store or the backend .env):
 *   ESHIPPER_BASE_URL        account API base URL (test host: uu2.eshipper.com)
 *   ESHIPPER_USERNAME        account username / API user
 *   ESHIPPER_PASSWORD        account password / API secret
 *   ESHIPPER_ACCOUNT_ID      account identifier (optional, if required)
 *   ESHIPPER_ENV             deployment environment gate; not settable in Settings
 */

import { createHash } from "node:crypto";
import { getCredentials, redactSecrets } from "./credentials.server";
import { COUNTRIES } from "~/utils/countries";

export interface RateRequest {
  shipFrom: {
    name?: string;
    address: string;
    city?: string;
    province?: string;
    postalCode: string;
    country: string;
    /** Carriers accept these; they are not required to price. */
    phone?: string | null;
    email?: string | null;
  };
  shipTo: {
    name?: string;
    address: string;
    city?: string;
    province?: string;
    postalCode: string;
    country: string;
    residential?: boolean;
    phone?: string | null;
    email?: string | null;
  };
  packages: { count: number; length: number; width: number; height: number; weight: number; units: string }[];
  declaredValue?: number;
  insurance?: boolean;
}

export interface RateQuote {
  carrier: string;
  serviceCode: string;
  serviceName: string;
  totalAmount: number;
  currency: string;
  transitDays: number | null;
  estimatedDelivery: Date | null;
  expiresAt: Date | null;
  /** The provider's own quote id, when it issues one. Needed to book by id. */
  providerQuoteId?: string | null;
  raw?: unknown;
}

export interface BookingResult {
  /**
   * `ShippingReply.order.orderId`, kept as the provider typed it — a string.
   *
   * The follow-up calls (`GET /api/v2/ship/{orderId}`, `/label`, `/track-order`)
   * declare that path segment `integer/int64`, so this value is a number in
   * string's clothing. It is stored verbatim rather than coerced because a
   * coerced NaN would be indistinguishable from "no id" and would silently
   * break reconciliation, which is the one path that must not be wrong.
   */
  providerShipmentId: string;
  carrier: string;
  serviceName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  /** The provider's own short tracking link, when it issues one. */
  brandedTrackingUrl?: string | null;
  /**
   * The label document returned at booking, inline.
   *
   * There is no `labelUrl` in the reply — the document comes back as data, and a
   * later re-download fetches `GET /api/v2/ship/{orderId}/label`.
   */
  label?: { type: string; data: string } | null;
  /**
   * The label as an openable href — a `data:` URI for the inline document, or
   * the provider's URL if that is what it turns out to send. Derived from
   * `label`, never from a `labelUrl` in the reply, which does not exist.
   */
  labelUrl: string | null;
  /**
   * The saved-quote id this booking was bought from, when it was issued.
   *
   * Carried out so the caller can persist it BEFORE the purchase, which is the
   * only handle that exists if the ship call never returns: the rate uuid is not
   * an order, and a timed-out booking leaves no order id to look up. It is
   * transient by nature — it names a draft that becomes an order on success.
   */
  savedQuoteId?: number | null;
  bookedCost: number;
  currency: string;
  raw?: unknown;
}

export interface LabelResult {
  /** Null when the provider answered with an empty document. */
  labelUrl: string | null;
  format: string;
}

export interface OrderDetailsResult {
  orderId: string;
  details: unknown;
}

export interface CustomsInvoiceResult {
  customsInvoiceUrl: string;
}

export interface TrackingEvent {
  dateTime: string;
  location: string;
  description: string;
  carrierEventCode?: string;
  proofOfDelivery?: unknown;
  statusText: string;
}

export interface TrackingResult {
  trackingUrl: string;
  trackingDetails: TrackingEvent[];
  labelGenerated: boolean;
  pickup: boolean;
  inTransit: boolean;
  /**
   * The parcel is on the van. A distinct signal, not a synonym for inTransit:
   * the work order names "Out for delivery" as one of the nine statuses a
   * shipment can be shown in, and folding it into "In transit" would lose the
   * only stage at which a customer can still be told "today".
   */
  outForDelivery: boolean;
  exception: boolean;
  undelivered: boolean;
  delivered: boolean;
  returned: boolean;
  cancelled: boolean;
  /**
   * The delivery date the CARRIER gave, when it gave one.
   *
   * Null means the carrier stated no estimate, which is not the same as "no
   * estimate exists" and must never be filled in from the service's transit
   * days or from elapsed time — §7 forbids inferring delivery from a clock.
   */
  deliveryEstimate: Date | null;
  /**
   * How many of the shipment's parcels the carrier reports as delivered, when
   * it reports per-parcel detail at all. Null when it does not.
   *
   * This is what makes a partial delivery visible instead of rounding it up to
   * a whole one: three of four cartons arriving is a real state, and a shipment
   * marked DELIVERED would stop the sweep from ever learning about the fourth.
   */
  deliveredPackages: number | null;
  totalPackages: number | null;
}

export interface BulkTrackingResult {
  results: TrackingResult[];
}

export interface ReturnQuote {
  carrier: string;
  serviceCode: string;
  serviceName: string;
  totalAmount: number;
  currency: string;
  transitDays: number | null;
  estimatedDelivery: Date | null;
  expiresAt: Date | null;
  /**
   * The rate envelope's `uuid` — the TRANSACTION handle, not a bookable quote.
   *
   * Same meaning as on an outbound quote, because the returns API answers with
   * the same `QuoteResponse` envelope. A return is booked by saving this quote
   * (`PUT /api/v2/returns/quote`) and creating the shipment from the numeric id
   * that comes back — never by spending the uuid directly.
   */
  providerQuoteId?: string | null;
  raw?: unknown;
}

export interface ReturnBookingResult {
  /**
   * `ShippingReply.order.orderId` — the SHIPPING ORDER, shared with outbound.
   *
   * `POST /api/v2/returns/create/{quoteId}` answers with the same
   * `ShippingReply` an outbound booking does, so this is the same id space and
   * the same follow-up calls (`GET /api/v2/returns/{orderId}`).
   */
  providerReturnId: string;
  carrier: string;
  serviceName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  brandedTrackingUrl?: string | null;
  label?: { type: string; data: string } | null;
  labelUrl: string | null;
  /** The saved return-quote id this was created from, when one was issued. */
  savedQuoteId?: number | null;
  bookedCost: number;
  currency: string;
  raw?: unknown;
}

export interface ReturnDetails {
  returnId: string;
  status: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  items: { sku: string; quantity: number }[];
  raw?: unknown;
}

export interface PickupResult {
  pickupId: string;
  scheduledDate: string;
  status: string;
  confirmationNumber?: string;
  raw?: unknown;
}

/**
 * Hosts confirmed as this account's test environment.
 *
 * Named explicitly rather than pattern-matched. A hostname is a string, not
 * proof of an environment, so inferring "this is only a test" from the text
 * "sandbox" would authorise real calls to any host that happens to contain the
 * word. `uu2.eshipper.com` is the account's confirmed test host, so it is
 * recognised by exact name — and for that reason needs no "sandbox" marker in
 * the URL.
 */
export const RECOGNIZED_TEST_HOSTS: readonly string[] = ["uu2.eshipper.com"];

export function isRecognizedTestHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return RECOGNIZED_TEST_HOSTS.includes(parsed.hostname.toLowerCase());
  } catch {
    return false; // Not a URL at all, so certainly not a recognised host.
  }
}

interface EshipperConfig {
  baseUrl: string | null;
  username: string | null;
  password: string | null;
  accountId: string | null;
  env: string;
}

/**
 * Every credential comes from the encrypted store, which itself falls back to
 * the environment — so a value saved in Settings takes effect without a
 * deployment, and an operator's Disconnect suppresses the environment too.
 */
async function eshipperConfig(): Promise<EshipperConfig> {
  const values = await getCredentials("eshipper");
  return {
    baseUrl: values.ESHIPPER_BASE_URL ?? null,
    username: values.ESHIPPER_USERNAME ?? null,
    password: values.ESHIPPER_PASSWORD ?? null,
    accountId: values.ESHIPPER_ACCOUNT_ID ?? null,
    // Which environment to believe stays deployment configuration: it is not a
    // stored field, so live bookings cannot be switched on from a browser form.
    env: (values.ESHIPPER_ENV ?? process.env.ESHIPPER_ENV ?? "").trim(),
  };
}

export function eshipperEnv(): string {
  return process.env.ESHIPPER_ENV || "";
}

export async function eshipperAuthConfigured(): Promise<boolean> {
  const config = await eshipperConfig();
  return !!config.baseUrl && !!config.username && !!config.password;
}

/** `test` covers the recognised test host; it is never reported as production. */
export type EshipperEnvironment = "production" | "test" | "unconfigured";

export interface EshipperEnvironmentInput {
  baseUrl?: string | null;
  username?: string | null;
  password?: string | null;
  env?: string | null;
}

/**
 * The environment decision, as a pure function.
 *
 * Split out from the store lookup deliberately: this is the rule that decides
 * whether real provider calls are allowed, and it is the part worth testing
 * exhaustively. A pure function can be exercised against every combination
 * without depending on what happens to be configured on the host.
 */
export function classifyEshipperEnvironment(input: EshipperEnvironmentInput): EshipperEnvironment {
  const baseUrl = (input.baseUrl ?? "").trim();
  const env = (input.env ?? "").trim();
  if (!baseUrl || !input.username || !input.password) return "unconfigured";
  // The host decides first. A recognised test host is reported as test whatever
  // ESHIPPER_ENV says, so a test account can never be mistaken for live.
  if (isRecognizedTestHost(baseUrl)) return "test";
  if (env === "production") return "production";
  if (env === "sandbox" && /sandbox/i.test(baseUrl)) return "test";
  return "unconfigured";
}

export async function eshipperEnvironment(): Promise<EshipperEnvironment> {
  return classifyEshipperEnvironment(await eshipperConfig());
}

export async function eshipperConfigured(): Promise<boolean> {
  return (await eshipperEnvironment()) !== "unconfigured";
}

export async function eshipperMode(): Promise<"real" | "simulated"> {
  return (await eshipperConfigured()) ? "real" : "simulated";
}

export interface EshipperStatus {
  /** Which host a call would actually go to, in the app's own terms. */
  environment: EshipperEnvironment;
  /** That host's name. Not a secret — it is the fact an operator needs. */
  host: string | null;
  /** Masked account identifier, or null when there is no credential at all. */
  account: string | null;
}

/**
 * The provider as an admin screen should state it.
 *
 * `eshipperMode()` answers a DIFFERENT question — "is a credential configured?" —
 * and its two words are not an environment. Collapsing "test host" and
 * "production host" into `real` is how a page came to report `eShipper: real`
 * above a deployment that was pointed at the account's TEST host, which reads as
 * "live" to the one person who has to decide whether pressing a button spends
 * money. Both statements are true about different things; only one of them is
 * worth the space.
 */
export async function eshipperStatus(): Promise<EshipperStatus> {
  const config = await eshipperConfig();
  let host: string | null = null;
  try {
    host = config.baseUrl ? new URL(config.baseUrl).hostname.toLowerCase() : null;
  } catch {
    host = null; // Not a URL, so not a host. `classify` will refuse it anyway.
  }
  return {
    environment: classifyEshipperEnvironment(config),
    host,
    account: await maskedEshipperAccount(),
  };
}

/**
 * The one sentence every admin screen uses, so two pages cannot describe the
 * same provider differently.
 */
export function describeEshipperStatus(status: EshipperStatus): string {
  const account = status.account ? ` · account ${status.account}` : "";
  switch (status.environment) {
    case "production":
      return `LIVE — calls reach the production host ${status.host ?? "(host unrecorded)"}${account}`;
    case "test":
      return `TEST environment — calls reach the account's test host ${status.host ?? "(host unrecorded)"}${account}`;
    default:
      return "not configured — quotes and bookings are simulated and no label is bought";
  }
}

/** Masked identifier safe to display in admin screens. Never a secret. */
export async function maskedEshipperAccount(): Promise<string | null> {
  const { username } = await eshipperConfig();
  if (!username) return null;
  if (username.includes("@")) {
    const [name, domain] = username.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `${username.slice(0, 2)}***${username.slice(-2)}`;
}

/**
 * The cached bearer token, plus the refresh token that renews it.
 *
 * `refresh_token` is a SEPARATE credential from the access token — retrying a
 * refresh with the access token is what the previous shape did, and the
 * documented request takes `refresh_token` and nothing else.
 */
let cachedToken: {
  value: string;
  expiresAt: number;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
  fingerprint: string;
} | null = null;

/**
 * Identifies a credential set without keeping a second copy of it. A changed
 * username, password or base URL must invalidate a cached bearer token; hashing
 * the three lets that comparison happen without holding the secret to compare.
 */
function credentialFingerprint(config: EshipperConfig): string {
  return createHash("sha256")
    .update(`${config.baseUrl}|${config.username}|${config.password}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The documented AuthenticationResponse, as returned by BOTH
 * POST /api/v2/authenticate and POST /api/v2/refresh-token.
 *
 * `expires_in` and `refresh_expires_in` are declared as STRINGS in the schema
 * ("The time in seconds in which token expires") even though a JSON number is
 * the natural reading, so both are accepted and coerced.
 */
interface TokenPayload {
  token?: string;
  expires_in?: string | number;
  token_type?: string;
  refresh_token?: string;
  refresh_expires_in?: string | number;
  [key: string]: unknown;
}

/** Seconds from a value the schema only promises will be a string. */
function secondsFrom(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The documented error body: { type, message, code, fieldErrors[], thirdPartyMessage }.
 * `fieldErrors` is where a validation refusal explains itself ("field: principal"),
 * so it is the part worth surfacing.
 */
interface EshipperErrorBody {
  message?: string;
  code?: string;
  fieldErrors?: { objectName?: string; field?: string; message?: string }[];
  thirdPartyMessage?: string;
}

/**
 * Compose a failure message from the provider's own words.
 *
 * The status alone ("failed (400)") is what made the last attempt undiagnosable
 * from the outside: a schema validation error and a wrong password both look
 * like "400". Field-level messages are included because they name the field
 * without naming the value, and everything goes through redactSecrets on the
 * way out so a provider that echoes a request back cannot leak the credential
 * into a detail an operator will read.
 */
function describeFailure(path: string, status: number, body: EshipperErrorBody | null, raw: string): string {
  const parts: string[] = [`eShipper ${path} failed (HTTP ${status})`];
  if (body?.code) parts.push(`code=${body.code}`);
  if (body?.message) parts.push(body.message);
  for (const field of body?.fieldErrors ?? []) {
    const name = field.field ?? field.objectName ?? "(unknown field)";
    parts.push(`${name}: ${field.message ?? "rejected"}`);
  }
  if (!body?.message && !body?.fieldErrors?.length && raw) {
    // Not JSON, or JSON with nothing recognisable in it. A short excerpt still
    // beats an empty reason, and the status line above says where it came from.
    parts.push(raw.slice(0, 200));
  }
  return redactSecrets(parts.join(" — "));
}

async function tokenRequest(
  config: EshipperConfig,
  path: "authenticate" | "refresh-token",
  body: Record<string, unknown>
): Promise<TokenPayload> {
  const res = await fetch(`${config.baseUrl}/api/v2/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: EshipperErrorBody | null = null;
    try {
      parsed = JSON.parse(text) as EshipperErrorBody;
    } catch {
      parsed = null;
    }
    throw new Error(describeFailure(path, res.status, parsed, text));
  }
  return JSON.parse(text) as TokenPayload;
}

async function getToken(force = false): Promise<string> {
  const config = await eshipperConfig();
  const fingerprint = credentialFingerprint(config);
  // Credentials changed since the token was issued: the old token belongs to a
  // different account and must not be reused.
  if (cachedToken && cachedToken.fingerprint !== fingerprint) cachedToken = null;

  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  let data: TokenPayload | undefined;
  const refreshUsable =
    !!cachedToken?.refreshToken &&
    (cachedToken.refreshExpiresAt === null || cachedToken.refreshExpiresAt > Date.now());
  if (cachedToken && refreshUsable) {
    // RefreshTokenDTO: required property `refresh_token`, and nothing else.
    try {
      data = await tokenRequest(config, "refresh-token", {
        refresh_token: cachedToken.refreshToken,
      });
    } catch {
      // A refresh token can expire or be revoked on its own schedule; the
      // fallback below re-authenticates with the principal and credential.
      data = undefined;
    }
  }
  if (!data) {
    // AuthenticationRequest: required properties `principal` and `credential`.
    // eShipper issues the principal at registration and it is the username here;
    // `accountId` is NOT part of this request and is not sent.
    data = await tokenRequest(config, "authenticate", {
      principal: config.username,
      credential: config.password,
    });
  }
  const token = data.token;
  if (!token) throw new Error("eShipper authentication returned no token.");
  const expiresIn = secondsFrom(data.expires_in);
  const refreshExpiresIn = secondsFrom(data.refresh_expires_in);
  cachedToken = {
    value: token,
    // 30 minutes only when the provider did not say; it normally does.
    expiresAt: Date.now() + (expiresIn !== null ? expiresIn * 1000 : 30 * 60 * 1000),
    refreshToken: data.refresh_token ?? null,
    refreshExpiresAt: refreshExpiresIn !== null ? Date.now() + refreshExpiresIn * 1000 : null,
    fingerprint,
  };
  return token;
}

/** Drops any cached bearer token; used after credentials change. */
export function resetEshipperToken(): void {
  cachedToken = null;
}

async function requireRealMode(operation: string) {
  const environment = await eshipperEnvironment();
  if (environment === "production" || environment === "test") return;
  const config = await eshipperConfig();
  throw new Error(
    `Refusing a real eShipper call for ${operation}: the base URL is not a recognised test host ` +
      `(recognised: ${RECOGNIZED_TEST_HOSTS.join(", ")}) and ESHIPPER_ENV is "${config.env || "(unset)"}". ` +
      `Point ESHIPPER_BASE_URL at the account's test host, or set ESHIPPER_ENV=production only for live bookings.`
  );
}

export interface EshipperAuthTest {
  /** True only when the provider accepted the credentials and issued a token. */
  ok: boolean;
  environment: EshipperEnvironment;
  baseUrlHost: string | null;
  recognizedTestHost: boolean;
  tokenReceived: boolean;
  /**
   * Account figures the provider volunteered during authentication — credit,
   * balance, available funds. Only non-secret scalars with those names are
   * copied here; the token and anything credential-shaped is dropped.
   */
  accountSignals: Record<string, string | number>;
  reason: string | null;
}

const CREDIT_SIGNAL = /(credit|balance|available|prepaid|funds|limit)/i;
const NEVER_RETURN = /(token|secret|password|api[_-]?key|authorization|client[_-]?id)/i;

/**
 * Extract only the account-credit figures from an authentication payload.
 *
 * A strict two-way filter (must look like credit, must not look like a
 * credential) so this can never become a path that returns the bearer token it
 * was just issued.
 */
export function extractCreditSignals(payload: unknown): Record<string, string | number> {
  const signals: Record<string, string | number> = {};
  const visit = (value: unknown, prefix: string, depth: number) => {
    if (depth > 3 || value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (NEVER_RETURN.test(key)) continue;
      if (entry !== null && typeof entry === "object") {
        visit(entry, path, depth + 1);
        continue;
      }
      if (!CREDIT_SIGNAL.test(key)) continue;
      if (typeof entry === "number") signals[path] = entry;
      else if (typeof entry === "string" && entry.length <= 64) signals[path] = entry;
    }
  };
  visit(payload, "", 0);
  return signals;
}

/**
 * Authenticate against the provider and stop there. No quote is requested and
 * nothing is booked, so this proves the credentials work without creating a
 * shipment or spending anything.
 */
export async function testEshipperAuthentication(): Promise<EshipperAuthTest> {
  const config = await eshipperConfig();
  const environment = await eshipperEnvironment();
  let baseUrlHost: string | null = null;
  try {
    baseUrlHost = config.baseUrl ? new URL(config.baseUrl).hostname.toLowerCase() : null;
  } catch {
    baseUrlHost = null;
  }
  const recognizedTestHost = isRecognizedTestHost(config.baseUrl);

  if (environment === "unconfigured") {
    return {
      ok: false,
      environment,
      baseUrlHost,
      recognizedTestHost,
      tokenReceived: false,
      accountSignals: {},
      reason: !config.baseUrl
        ? "No base URL is configured."
        : !config.username || !config.password
          ? "Username or password is missing."
          : `Credentials are present but the environment is unproven: the base URL is not a recognised test host (${RECOGNIZED_TEST_HOSTS.join(", ")}) and ESHIPPER_ENV is "${config.env || "(unset)"}".`,
    };
  }

  try {
    // The documented AuthenticationRequest, identical to the one a real
    // operation uses — a probe that authenticated differently would prove
    // nothing about the calls that follow it.
    const payload = await tokenRequest(config, "authenticate", {
      principal: config.username,
      credential: config.password,
    });
    const token = payload.token;
    if (!token) {
      return {
        ok: false,
        environment,
        baseUrlHost,
        recognizedTestHost,
        tokenReceived: false,
        accountSignals: extractCreditSignals(payload),
        reason: "The provider answered but issued no token.",
      };
    }
    // Deliberately not cached: a test must not leave a token behind for the next
    // real operation to pick up, and it says nothing about booking readiness.
    return {
      ok: true,
      environment,
      baseUrlHost,
      recognizedTestHost,
      tokenReceived: true,
      accountSignals: extractCreditSignals(payload),
      reason: null,
    };
  } catch (error) {
    return {
      ok: false,
      environment,
      baseUrlHost,
      recognizedTestHost,
      tokenReceived: false,
      accountSignals: {},
      reason: error instanceof Error ? redactSecrets(error.message) : "Authentication failed.",
    };
  }
}

/**
 * A call that never came back.
 *
 * SEPARATE FROM A REFUSAL, and the distinction is the whole point: a refusal
 * means nothing was purchased and a retry is safe, while a timeout means the
 * provider may have acted on a request we never saw the answer to. Only this
 * class leads to a booking being marked unresolved, so it must never be thrown
 * for a response the provider actually sent — a 500 with a body is a refusal,
 * however unhelpful.
 */
export class ProviderTimeoutError extends Error {
  readonly timeout = true;
  constructor(operation: string, ms: number, cause?: unknown) {
    super(
      `eShipper ${operation} did not answer within ${Math.round(ms / 1000)}s. ` +
        `Whether the request took effect is unknown.`
    );
    this.name = "ProviderTimeoutError";
    this.cause = cause;
  }
}

/**
 * How long any single provider call may take.
 *
 * Deliberately shorter than the platform's own request timeout, so a slow
 * provider produces our answer ("we do not know") rather than a killed request
 * whose outcome nobody recorded. Thirty seconds is generous for a JSON call and
 * still short enough that an operator is not left watching a spinner.
 */
const PROVIDER_TIMEOUT_MS = Number(process.env.ESHIPPER_TIMEOUT_MS || 30_000);

export function isProviderTimeout(error: unknown): boolean {
  return (error as { timeout?: boolean } | null)?.timeout === true;
}

/**
 * One provider call.
 *
 * `operation` names the call in a timeout message, because "did not answer" is
 * useless without saying what was being asked. A 401 is retried once with a
 * fresh token; a TIMEOUT IS NOT RETRIED — re-issuing a request that may have
 * been received is exactly the second purchase this file exists to avoid.
 */
async function eshipperFetch(method: string, path: string, body?: unknown, operation = path, asText = false) {
  const { baseUrl } = await eshipperConfig();
  const attempt = async (): Promise<Response> => {
    // One signal per attempt, kept in scope so a rejection can be attributed:
    // "the provider did not answer" and "the request never left" look identical
    // from a bare catch, and they mean opposite things about whether a label
    // might exist. Fresh per attempt so the token refresh below gets its own
    // full allowance rather than whatever was left of the first one.
    const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    try {
      return await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getToken()}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      if (signal.aborted || (error as { name?: string } | null)?.name === "TimeoutError") {
        throw new ProviderTimeoutError(operation, PROVIDER_TIMEOUT_MS, error);
      }
      /*
       * Not a timeout: DNS, a refused connection, TLS. The request never
       * reached the provider, so nothing can have been purchased and this is an
       * ordinary failure the caller may retry. Wrapping it as a timeout would
       * turn every network blip into an unknown booking that has to be
       * reconciled by hand — and an alarm that fires when nothing is wrong is
       * how the real one gets ignored.
       */
      throw error;
    }
  };
  let res = await attempt();
  if (res.status === 401) {
    await getToken(true);
    res = await attempt();
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    // The status line arrived but the body did not: the provider answered, so
    // this is a refusal whose reason is missing rather than an unknown outcome.
    throw new Error(`eShipper ${operation} answered ${res.status} but its body could not be read.`);
  }
  // Redacted, not raw: this message can be persisted as an integration detail.
  if (!res.ok) throw new Error(`eShipper error ${res.status}: ${redactSecrets(text)}`);
  if (!text) return {};
  /*
   * Some endpoints answer with a document rather than JSON — `/label` returns
   * the label itself. Parsing those as JSON would turn a perfectly good label
   * into a syntax error, so the caller says which it is expecting.
   */
  if (asText) return text;
  /*
   * A JSON endpoint can still answer with a bare string (Spring quotes it), so
   * a parse failure is reported with the body rather than as a raw SyntaxError
   * that says nothing about which call produced it.
   */
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`eShipper ${operation} did not answer with JSON: ${redactSecrets(text).slice(0, 300)}`);
  }
}

/**
 * The provider's quote envelope, established by asking the API.
 *
 * The published documentation is wrong on every name below, and wrong SILENTLY:
 * Jackson ignores a property it does not recognise, so a misspelled field is not
 * rejected -- it is dropped and a default takes its place. That is how a request
 * missing its postal code still answered HTTP 201 while ten carriers rated
 * "00000", and how a wholly malformed envelope looked like a successful call.
 *
 *   shipFrom / shipTo   ->  from / to
 *   packages: [ ... ]   ->  packages: { type, packages: [ ... ] }
 *   address             ->  address1      (the only address line required)
 *   postalCode          ->  zip
 *   name                ->  attention     (the Address type has no `name`)
 *
 * `address2` is real, so a unit number survives. `residential` is a Boolean on
 * the address. `packagingUnit` is the enum [METRIC, IMPERIAL].
 *
 * `declaredValue` and `insurance` are NOT properties of this request under any
 * name -- every near-miss was tested and ignored. They cannot be transmitted
 * here, and no separate endpoint has been verified, so this file must not imply
 * that a declared value is being sent. Recorded as open, not worked around.
 */
const WIRE_PACKAGING_UNIT = "METRIC";
const WIRE_DIMENSION_UNIT = "CM";
const WIRE_WEIGHT_UNIT = "KG";
/** The one unit the app ever stores; see the guard in buildQuoteRequest. */
const CANONICAL_PACKAGE_UNITS = "cm_kg";

interface WireAddress {
  address1: string;
  city?: string;
  province?: string;
  zip: string;
  country: string;
  residential?: boolean;
  attention?: string;
  phone?: string;
  email?: string;
}

interface WireParcel {
  length: number;
  width: number;
  height: number;
  weight: number;
  description: string;
  dimensionUnit: string;
  weightUnit: string;
}

export interface WireQuoteRequest {
  from: WireAddress;
  to: WireAddress;
  scheduledShipDate: string;
  packagingUnit: string;
  packages: { type: string; packages: WireParcel[] };
}

/**
 * "yyyy-MM-dd HH:mm" -- the only shape the provider binds.
 *
 * The field is a java.time.LocalDateTime read by a pattern that stops at
 * minutes: ISO 8601 fails at index 10, and a value carrying seconds fails too.
 *
 * Formatted in UTC because the type carries no zone, so there is no way to tell
 * the provider which wall clock a reading belongs to. For an Eastern-time
 * warehouse this dates a late-evening request tomorrow. That is tolerable for a
 * scheduled ship DATE and it is what was proven to parse, but it is an
 * assumption rather than a verified reading of the provider's intent, and it is
 * recorded as open rather than presented as settled.
 */
function wireShipDate(when: Date): string {
  return when.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Names a caller produces that the platform's own ISO 3166 data does not.
 *
 * Kept deliberately short and justified: an alias earns its line by being a
 * shape something real sends, not by being a spelling somebody might use. The
 * three-letter ISO codes are NOT accepted — "CAN" is a different standard and a
 * half-filled alpha-3 table would rot; a 2-letter code or a name is what this
 * app stores and what a caller here produces.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  "united states of america": "US",
  "u.s.a.": "US",
  "u.s.a": "US",
  "u.s.": "US",
  usa: "US",
  "great britain": "GB",
  "united kingdom of great britain and northern ireland": "GB",
  "u.k.": "GB",
  uk: "GB",
  holland: "NL",
};

/**
 * Subdivision codes for the two countries in this market that define them.
 *
 * A province reaches the wire as a NAME — "Ontario", "British Columbia" — under
 * exactly the same conditions as a country name did, and the provider is silent
 * about it in exactly the same way: an unrecognised value is dropped and a
 * default takes its place, so the rate is priced for a subdivision nobody chose.
 *
 * The table stops at CA and US because those are the codes that exist. Every-
 * where else a province is free text or absent, and inventing a code for
 * "Bavaria" would be worse than passing the name through — which is what
 * `toCarrierProvince` does, and why it does not throw the way the country does.
 */
const SUBDIVISIONS: Record<string, string> = {
  // Canada
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", "nova scotia": "NS", "northwest territories": "NT",
  nunavut: "NU", ontario: "ON", "prince edward island": "PE", quebec: "QC", "québec": "QC",
  saskatchewan: "SK", yukon: "YT",
  // United States
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
  iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

const SUBDIVISION_CODES = new Set(Object.values(SUBDIVISIONS));

/**
 * The subdivision as the carrier wants it: a code where one is defined.
 *
 * NOT a refusal, unlike the country, and the difference is deliberate. A country
 * has a code in every case, so a value that is not one is always wrong. A
 * province has a code in two countries and not in the rest, so an unrecognised
 * value is either a misspelling to pass through or a real subdivision this table
 * has no business inventing — and refusing it would block shipments to most of
 * the world to catch a problem that only exists in the two countries the code
 * was defined for.
 */
export function toCarrierProvince(value: string | null | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && SUBDIVISION_CODES.has(upper)) return upper;
  return SUBDIVISIONS[raw.toLowerCase().replace(/\s+/g, " ")] ?? raw;
}

/**
 * The fields a carrier needs before it can price a parcel or print a label.
 *
 * THESE ARE ENFORCED; GOOGLE IS NOT. What a carrier will actually refuse is a
 * missing street or postal code, and that is what this checks — not whether an
 * address matches a postal database, which is a different question with a
 * different (and non-blocking) answer.
 *
 * `phone` is deliberately absent. Carriers require it for some services and not
 * others, and this layer has no per-service rule to consult — so a blanket
 * requirement would refuse shipments that are perfectly bookable, and a blanket
 * pass would be no check at all. It is sent whenever an address carries one, and
 * a carrier that needs it says so in its own words, which the operator sees.
 */
export interface CarrierAddress {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

const filled = (value: string | null | undefined) => Boolean(value && String(value).trim());

export function carrierAddressProblems(
  address: CarrierAddress,
  side: "pickup" | "delivery" | "return"
): string[] {
  const problems: string[] = [];
  if (!filled(address.name)) problems.push(`no recipient name on the ${side} address`);
  if (!filled(address.address)) problems.push(`no street on the ${side} address`);
  if (!filled(address.city)) problems.push(`no city on the ${side} address`);
  if (!filled(address.province)) problems.push(`no province or state on the ${side} address`);
  if (!filled(address.postalCode)) problems.push(`no postal or ZIP code on the ${side} address`);
  if (!filled(address.country)) problems.push(`no country on the ${side} address`);
  return problems;
}

let isoRegions: { codes: Set<string>; byName: Map<string, string> } | null = null;

/**
 * ISO 3166-1 alpha-2, from the platform's own CLDR data rather than a table
 * maintained here.
 *
 * Enumerating the two-letter space and asking what each one is called gives a
 * complete, correct code set and its English names for free — including the ones
 * no curated list would have ("Nigeria", "Côte d'Ivoire"). A hand-written map
 * would be 249 rows that rot quietly; this cannot disagree with the standard.
 */
function isoRegionTables(): { codes: Set<string>; byName: Map<string, string> } {
  if (isoRegions) return isoRegions;
  const codes = new Set<string>();
  const byName = new Map<string, string>();
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = String.fromCharCode(first, second);
        const name = display.of(code);
        if (name && name !== code && !/unknown/i.test(name)) {
          codes.add(code);
          byName.set(name.trim().toLowerCase(), code);
        }
      }
    }
  } catch {
    // No ICU on this host. The app's own list and the aliases above still cover
    // the operating market; see the permissive branch in the caller.
  }
  isoRegions = { codes, byName };
  return isoRegions;
}

/**
 * The country a carrier is given: ISO 3166-1 alpha-2, upper case.
 *
 * WHY THIS LIVES AT THE ADAPTER AND NOT AT THE CALLER. A country reached the
 * wire as a NAME — "Canada", straight out of Shopify's address JSON, where
 * `country` is a display name and `country_code` is the code — while every other
 * field on the address was correct. The provider does not reject that: Jackson
 * drops a value it cannot bind, so the quote came back for a shipment that
 * cannot exist, and nothing anywhere said so. Three callers build an address
 * from here (the quote/booking envelope, a return, a pickup) and each is a
 * separate place to forget, so the conversion happens at the one boundary they
 * all cross.
 *
 * ALPHA-2 IN, ALPHA-2 OUT, and anything else REFUSES. That is the same rule the
 * parcels get three screens up, for the same reason: the provider prices what it
 * is given rather than refusing it, so an unrecognised country would become a
 * real quote against a silent default. The refusal names the value AND the side
 * of the shipment it was on, because "CA" being wrong at the pickup end and at
 * the delivery end are two different records to go and fix.
 */
export function toIsoCountryCode(value: string | null | undefined, side: "pickup" | "delivery" | "return"): string {
  const raw = (value ?? "").trim();
  if (!raw) {
    throw new Error(
      `The ${side} address has no country, and a carrier cannot be asked to price or collect a shipment ` +
        `whose ${side} country is blank. Set the country on that address.`
    );
  }
  const { codes, byName } = isoRegionTables();
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const code = raw.toUpperCase();
    // A two-letter string is not automatically a country — "ZZ" is the classic
    // placeholder, and the provider would price it. Without ICU there is no set
    // to check against, and a right-shaped code is then worth more than a
    // refusal: the shape is the part the provider needs.
    if (codes.size === 0 || codes.has(code)) return code;
    throw new Error(
      `"${raw}" is not an ISO 3166-1 alpha-2 country code, so it cannot be sent as the ${side} country. ` +
        `Correct the country on that address.`
    );
  }
  const key = raw.toLowerCase();
  const fromApp = COUNTRIES.find((country) => country.name.trim().toLowerCase() === key)?.code;
  const resolved = fromApp ?? COUNTRY_ALIASES[key] ?? byName.get(key);
  if (resolved) return resolved;
  throw new Error(
    `"${raw}" is not a country this app can send: eShipper takes an ISO 3166-1 alpha-2 code, and the ` +
      `${side} address carries a value that is not one and is not a recognised country name. ` +
      `Correct the country on that address.`
  );
}

/**
 * The two conversions every address on this wire needs, plus the field check.
 *
 * A function rather than two lines in `toWireAddress` because two endpoints —
 * the return booking and the pickup — build their payload by hand and would
 * otherwise each have to remember. Forgetting looks like success: the provider
 * takes the address, drops what it does not recognise, and returns a price for a
 * shipment nobody described.
 */
function checkedDispatchAddress<
  T extends {
    name?: string | null;
    address?: string | null;
    city?: string | null;
    province?: string | null;
    postalCode?: string | null;
    country?: string | null;
  },
>(address: T, side: "pickup" | "delivery" | "return"): T {
  const problems = carrierAddressProblems(address, side);
  if (problems.length > 0) {
    throw new Error(
      `This address cannot be sent to eShipper: ${problems.join(", ")}. ` +
        `Correct the ${side} address before quoting or booking.`
    );
  }
  return {
    ...address,
    // The conversion that does not survive being left to the caller: see
    // toIsoCountryCode.
    country: toIsoCountryCode(address.country, side),
    // A subdivision NAME becomes a code where one exists, and is passed through
    // where none does. See toCarrierProvince.
    province: toCarrierProvince(address.province) ?? address.province,
  };
}

function toWireAddress(
  source: RateRequest["shipFrom"] | RateRequest["shipTo"],
  side: "pickup" | "delivery"
): WireAddress {
  const checked = checkedDispatchAddress(source, side);
  const address: WireAddress = {
    address1: checked.address,
    city: checked.city,
    province: checked.province,
    zip: checked.postalCode,
    country: checked.country,
    // `attention`, not `name`: the Address type has no `name` property, so a
    // recipient sent under that key is dropped and the label prints with nobody
    // to deliver to. Whether `attention` renders as the recipient is confirmed
    // on a label, not by a quote -- recorded as open.
    attention: checked.name,
    residential: "residential" in checked ? checked.residential : undefined,
  };
  if (checked.phone) address.phone = checked.phone;
  if (checked.email) address.email = checked.email;
  return address;
}

/**
 * The app's request, expressed the way the provider actually reads it.
 *
 * Units are REFUSED rather than coerced. The per-parcel unit tokens are not
 * validated by the provider -- an unrecognised value is silently defaulted -- so
 * a parcel sent in the wrong unit would be priced on a wrong figure with no
 * error anywhere to show for it. This app stores one canonical unit, so any
 * other value is a bug upstream and belongs here, loudly, not on the wire.
 */
export function buildQuoteRequest(req: RateRequest, when: Date): WireQuoteRequest {
  const parcels: WireParcel[] = [];
  for (const p of req.packages) {
    if (p.units !== CANONICAL_PACKAGE_UNITS) {
      throw new Error(
        `Package units "${p.units}" cannot be sent to eShipper. This app stores ${CANONICAL_PACKAGE_UNITS} only, ` +
          `and the provider does not reject an unknown unit -- it silently defaults it -- so a wrong unit would be priced without complaint.`
      );
    }
    /*
     * The last gate before a carrier is asked to move something. The forms and
     * the write layer already refuse these, so anything reaching here is a bad
     * row from before those rules existed or a path nobody has thought of yet.
     * It is checked anyway because of what the provider does with it: a zero or
     * a NaN is not rejected upstream, it is priced, and the answer looks
     * exactly like a real quote.
     */
    for (const [field, value] of Object.entries({
      length: p.length,
      width: p.width,
      height: p.height,
      weight: p.weight,
    })) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(
          `A parcel cannot be sent to eShipper with ${field} = ${String(value)}: ` +
            `the provider prices what it is given rather than refusing it, so this would become a real quote for a parcel that cannot exist.`
        );
      }
    }
    // `count` is N identical parcels; the provider takes them enumerated.
    const copies = Math.max(1, Math.floor(p.count));
    for (let i = 0; i < copies; i += 1) {
      parcels.push({
        length: p.length,
        width: p.width,
        height: p.height,
        weight: p.weight,
        description: "Carton",
        dimensionUnit: WIRE_DIMENSION_UNIT,
        weightUnit: WIRE_WEIGHT_UNIT,
      });
    }
  }
  if (parcels.length === 0) {
    throw new Error("A quote needs at least one parcel; none were supplied.");
  }
  return {
    from: toWireAddress(req.shipFrom, "pickup"),
    to: toWireAddress(req.shipTo, "delivery"),
    scheduledShipDate: wireShipDate(when),
    packagingUnit: WIRE_PACKAGING_UNIT,
    packages: { type: "Package", packages: parcels },
  };
}

function simulatedRates(req: RateRequest): RateQuote[] {
  const totalWeight = req.packages.reduce((s, p) => s + p.weight * p.count, 0);
  const totalCount = req.packages.reduce((s, p) => s + p.count, 0);
  const base = 900 + Math.round(totalWeight * 120) + totalCount * 350;
  const now = new Date();
  return [
    { carrier: "Canada Post", serviceCode: "CP-EXPEDITED", serviceName: "Expedited Parcel", totalAmount: base, currency: "CAD", transitDays: 3, estimatedDelivery: new Date(now.getTime() + 3 * 86400000), expiresAt: new Date(now.getTime() + 30 * 60000), providerQuoteId: `sim_q_cp_${totalCount}` },
    { carrier: "Purolator", serviceCode: "PURO-EXPRESS", serviceName: "Purolator Express", totalAmount: Math.round(base * 1.45), currency: "CAD", transitDays: 1, estimatedDelivery: new Date(now.getTime() + 1 * 86400000), expiresAt: new Date(now.getTime() + 30 * 60000), providerQuoteId: `sim_q_puro_${totalCount}` },
    { carrier: "UPS", serviceCode: "UPS-STANDARD", serviceName: "UPS Standard", totalAmount: Math.round(base * 0.92), currency: "CAD", transitDays: null, estimatedDelivery: null, expiresAt: new Date(now.getTime() + 30 * 60000), providerQuoteId: `sim_q_ups_${totalCount}` },
  ];
}

export async function getRates(req: RateRequest): Promise<RateQuote[]> {
  if (!(await eshipperConfigured())) {
    // Imported lazily: recording the state pulls in the health module, and a
    // simulated quote should not make that import mandatory for callers that
    // never reach this branch.
    const { setIntegrationState } = await import("./integrationHealth.server");
    await setIntegrationState("eshipper", {
      status: "NOT_CONFIGURED",
      detail: `Simulated eShipper rates. Account ${(await maskedEshipperAccount()) ?? "(not configured)"}. Configure credentials for real quotes.`,
    });
    return simulatedRates(req);
  }
  await requireRealMode("getRates");
  const raw = await eshipperFetch("POST", "/api/v2/quote", buildQuoteRequest(req, new Date()));
  const envelope = raw as { uuid?: unknown; warnings?: unknown[] } | null;
  const quotes = normalizeRates(raw, envelope?.uuid == null ? null : String(envelope.uuid));
  if (quotes.length === 0) {
    /*
     * An empty list is not "no coverage" -- it is the provider declining to
     * price, and it says why in `warnings`, one line per carrier. Returning []
     * discarded those reasons, which is what let a wholly malformed envelope
     * look like a successful call with nothing available. The reasons are
     * raised instead, so the operator reads "Canada Post: The Postal Code is
     * invalid" rather than an unexplained blank.
     */
    const reasons = (envelope?.warnings ?? []).map((w) => String(w).trim()).filter(Boolean);
    throw new Error(
      reasons.length
        ? `eShipper returned no rates. ${reasons.length} carrier(s) declined: ${reasons.join(" | ")}`
        : "eShipper returned no rates and offered no reason."
    );
  }
  return quotes;
}

/**
 * The provider's answer, read by its real names.
 *
 * `totalCharge` is the figure to bill on. It was previously read as `total`,
 * which does not exist in the response, so every quote priced at zero. The
 * service handle is the numeric `serviceId`; there is no `serviceCode`.
 *
 * The quote id is the envelope's `uuid`, not a per-quote field: ONE uuid covers
 * every quote in a response, which is why it is passed in rather than searched
 * for. It is the handle a booking names, and it is absent on responses that
 * carry no id at all -- hence nullable rather than invented.
 */
export function normalizeRates(raw: unknown, quoteId: string | null): RateQuote[] {
  const list = Array.isArray(raw) ? raw : (raw as { quotes?: unknown[] })?.quotes ?? [];
  return list.map((r) => {
    const rate = r as Record<string, unknown>;
    const transit = rate.transitDays ?? rate.transit_days ?? null;
    const delivery = rate.estimatedDelivery ?? rate.deliveryDate ?? null;
    return {
      carrier: String(rate.carrierName ?? rate.carrier ?? "Unknown"),
      serviceCode: String(rate.serviceId ?? rate.serviceCode ?? ""),
      serviceName: String(rate.serviceName ?? rate.service_name ?? ""),
      totalAmount: Math.round(Number(rate.totalCharge ?? rate.totalChargedAmount ?? 0) * 100),
      currency: String(rate.currency ?? "CAD"),
      transitDays: transit === null ? null : Number(transit),
      estimatedDelivery: delivery ? new Date(String(delivery)) : null,
      expiresAt: rate.expiresAt ? new Date(String(rate.expiresAt)) : null,
      providerQuoteId: quoteId,
      raw: rate,
    };
  });
}

/**
 * Save a quote so that it can be booked.
 *
 * A rate is NOT bookable. `POST /api/v2/ship/{quoteId}` takes an
 * `integer/int64` naming a quote the provider has SAVED, and a rate response
 * contains no such number — its `uuid` identifies the rate TRANSACTION, not a
 * quote. `PUT /api/v2/quote` is the missing step: "save a quote as a draft
 * order for review and future action", answered with the `quoteId` to book by.
 *
 * Note the verbs, because they invert the obvious reading: on this API **PUT
 * saves a quote and POST fetches rates**. Posting the uuid to the ship endpoint
 * (what this app used to do) cannot work at any point — the provider rejects it
 * with a Java type error before it reads the body.
 *
 * The body is the documented `SaveQuoteRequest` — the SAME rate request that
 * produced the quote, the ONE quote object being bought, and the uuid tying
 * them together. Because the whole rate request is saved, everything it
 * carried travels with the draft: the addresses, the parcels, and the
 * `notifyRecipient` flag that decides whether the carrier tells the customer.
 */
export async function saveQuote(input: {
  /** The rate envelope's `uuid` — the transaction the quote came from. */
  rateUuid: string;
  rateRequest: RateRequest;
  /** The one quote object being bought, as the provider returned it. */
  quote: Record<string, unknown>;
}): Promise<number> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("saveQuote");
  const raw = (await eshipperFetch(
    "PUT",
    "/api/v2/quote",
    {
      quoteRequest: buildQuoteRequest(input.rateRequest, new Date()),
      quote: input.quote,
      uuid: input.rateUuid,
    },
    "saveQuote"
  )) as { quoteId?: unknown; message?: unknown; type?: unknown };
  const quoteId = Number(raw?.quoteId);
  if (!Number.isFinite(quoteId) || quoteId <= 0) {
    // Never fall back to the uuid: it is a string the ship endpoint cannot even
    // deserialize, so "no id" and "wrong id" are the same refusal one call later.
    throw new Error(
      `eShipper did not issue a bookable quote id for this rate. It said: ${String(raw?.message ?? "nothing")}`
    );
  }
  return quoteId;
}

export async function getQuote(quoteId: string): Promise<RateQuote | null> {
  if (!(await eshipperConfigured())) return null;
  await requireRealMode("getQuote");
  const raw = await eshipperFetch("GET", `/api/v2/quote/${quoteId}`);
  const quotes = normalizeRates([raw], quoteId);
  return quotes[0] ?? null;
}

export async function bookShipment(input: {
  quote: {
    carrier: string;
    serviceCode: string;
    serviceName: string;
    providerQuoteId?: string | null;
    /** The provider's own quote object, replayed verbatim into the save. */
    raw?: unknown;
  };
  rateRequest: RateRequest;
}): Promise<BookingResult> {
  if (!(await eshipperConfigured())) {
    const id = `sim_ship_${Math.random().toString(36).slice(2, 10)}`;
    const tracking = `SIM${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`;
    return {
      providerShipmentId: id,
      carrier: input.quote.carrier,
      serviceName: input.quote.serviceName,
      trackingNumber: tracking,
      trackingUrl: `https://example.invalid/simulated-tracking/${tracking}`,
      labelUrl: `https://example.invalid/simulated-label/${id}.pdf`,
      bookedCost: 0,
      currency: "CAD",
    };
  }
  await requireRealMode("bookShipment");
  /*
   * Two calls, in the documented order: save the quote, then buy the saved
   * quote. The save is what turns a rate into something bookable, and it must
   * happen immediately before the purchase rather than at quote time — a draft
   * order is created per call, and one per rate the operator merely LOOKED at
   * would litter the account with drafts nobody asked for.
   *
   * The uuid is the rate handle stored on the quote; `raw` is the provider's own
   * quote object, replayed verbatim so the draft is the quote that was priced.
   */
  if (!input.quote.providerQuoteId) {
    throw new Error(
      "This quote has no eShipper rate id. Re-request quotes so the booking can reference the rate it was priced from."
    );
  }
  const quoteObject = input.quote.raw as Record<string, unknown> | undefined;
  if (!quoteObject || typeof quoteObject !== "object" || Array.isArray(quoteObject)) {
    throw new Error(
      "This quote did not keep the provider's own quote object, so it cannot be saved for booking. Re-request quotes."
    );
  }
  const savedQuoteId = await saveQuote({
    rateUuid: input.quote.providerQuoteId,
    rateRequest: input.rateRequest,
    quote: quoteObject,
  });
  /*
   * No request body: the saved quote already carries the addresses, parcels and
   * the service being bought — the endpoint's contract is the id in the path.
   * Sending the rate envelope again (as this used to) would describe a second,
   * unsaved shipment and could only ever book the wrong thing.
   *
   * Named, because this is the one call whose timeout means "you may own a label
   * you cannot see" rather than "nothing happened".
   */
  const raw = (await eshipperFetch(
    "POST",
    `/api/v2/ship/${savedQuoteId}`,
    undefined,
    "bookShipment"
  )) as Record<string, unknown>;
  return { ...readShippingReply(raw, input.quote), savedQuoteId };
}

/**
 * The label as something an operator can click.
 *
 * `ShippingReply` describes the label as `{type, data}` and does NOT say whether
 * `data` is the document or a link to it. Both readings are handled rather than
 * assumed, because guessing wrong here is invisible: a URL wrapped as base64 and
 * a base64 blob treated as a URL both produce a broken button and no error. The
 * first real booking settles which one this account is given. A `data:` URI is
 * deliberate — it makes `labelUrl` directly openable by the existing links,
 * without a download route or a new column.
 */
export function labelToHref(label: { type: string; data: string } | null | undefined): string | null {
  if (!label?.data) return null;
  if (/^https?:\/\//i.test(label.data)) return label.data;
  const mime = /pdf/i.test(label.type) ? "application/pdf" : "application/octet-stream";
  return `data:${mime};base64,${label.data}`;
}

/**
 * Read the provider's booking answer by its documented names.
 *
 * `ShippingReply` nests everything: the ids under `order`, the carrier under
 * `carrier`, and the money under `quote` — where `quote.totalCharge` is what was
 * actually BOUGHT, which is not guaranteed to equal what was quoted. The old
 * reader looked for `shipmentId`, `cost` and `labelUrl` at the top level; none
 * of those keys exist, so a successful booking would have been recorded as an
 * empty provider id at zero cost.
 *
 * The label arrives inline as `labelData.label[]` of `{type, data}` rather than
 * as a URL — there is no `labelUrl` anywhere in the reply.
 */
function readShippingReply(
  reply: Record<string, unknown>,
  fallback: { carrier: string; serviceName: string }
): BookingResult {
  const order = (reply.order ?? {}) as Record<string, unknown>;
  const carrier = (reply.carrier ?? {}) as Record<string, unknown>;
  const quote = (reply.quote ?? {}) as Record<string, unknown>;
  const labels = ((reply.labelData ?? {}) as Record<string, unknown>).label;
  const first = Array.isArray(labels) ? (labels[0] as Record<string, unknown> | undefined) : undefined;
  return {
    // A STRING here, and that is not an oversight: the reply types it as such.
    // The numeric shipping order id the follow-up GETs want is this value read
    // as a number, which is why it is kept verbatim rather than coerced.
    providerShipmentId: String(order.orderId ?? ""),
    carrier: String(carrier.carrierName ?? fallback.carrier),
    serviceName: String(carrier.serviceName ?? fallback.serviceName),
    trackingNumber: String(reply.trackingNumber ?? ""),
    trackingUrl: reply.trackingUrl ? String(reply.trackingUrl) : null,
    brandedTrackingUrl: reply.brandedTrackingUrl ? String(reply.brandedTrackingUrl) : null,
    // Not a URL: the document itself, which the caller must persist.
    label: first ? { type: String(first.type ?? "PDF"), data: String(first.data ?? "") } : null,
    labelUrl: labelToHref(first ? { type: String(first.type ?? "PDF"), data: String(first.data ?? "") } : null),
    bookedCost: Math.round(Number(quote.totalCharge ?? 0) * 100),
    currency: String(quote.currency ?? "CAD"),
    raw: reply,
  };
}

export async function updateShipment(data: Record<string, unknown>): Promise<BookingResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("updateShipment");
  const raw = await eshipperFetch("PUT", "/api/v2/ship", data) as Record<string, unknown>;
  return {
    providerShipmentId: String(raw.shipmentId ?? raw.id ?? ""),
    carrier: String(raw.carrier ?? ""),
    serviceName: String(raw.serviceName ?? ""),
    trackingNumber: String(raw.trackingNumber ?? raw.tracking ?? ""),
    trackingUrl: raw.trackingUrl ? String(raw.trackingUrl) : null,
    labelUrl: raw.labelUrl ? String(raw.labelUrl) : null,
    bookedCost: Math.round(Number(raw.cost ?? raw.total ?? 0) * 100),
    currency: String(raw.currency ?? "CAD"),
    raw,
  };
}

/**
 * Ask the provider what it holds under a shipping order id.
 *
 * Used to resolve a booking whose call never returned: if the provider has a
 * shipment under this id, the booking exists and is adopted rather than repeated.
 *
 * The id is `ShippingReply.order.orderId` — the SHIPPING ORDER, numeric in a
 * string's clothing. It is NOT the quote. Until a booking succeeds there is no
 * such id, which is exactly why a booking that times out cannot be reconciled by
 * quote: see the note on `bookShipment`'s saved-quote id.
 */
export async function getShipment(orderId: string): Promise<BookingResult | null> {
  if (!(await eshipperConfigured())) return null;
  await requireRealMode("getShipment");
  const raw = (await eshipperFetch("GET", `/api/v2/ship/${orderId}`, undefined, "getShipment")) as Record<
    string,
    unknown
  >;
  if (!raw || Object.keys(raw).length === 0) return null;
  return readShippingReply(raw, { carrier: "", serviceName: "" });
}

/**
 * Cancel a booked shipment at the provider.
 *
 * The body is the documented `ShipmentCancelRequest` — `{order: {trackingId,
 * orderId}}` — and NOT `{shipmentId}` as this used to send, which matched no
 * field the provider reads. Either identifier cancels it; if a tracking number
 * is given the order number is ignored, so the tracking number is preferred as
 * the narrower of the two.
 *
 * `cancelled` is read from the reply naming the orders it cancelled. This is the
 * safe direction to be strict in: a reply we cannot read leaves the shipment
 * CANCELLING rather than claiming a refund that may not have happened.
 */
export async function cancelShipment(input: {
  providerShipmentId?: string | null;
  trackingNumber?: string | null;
}): Promise<{ cancelled: boolean; raw?: unknown }> {
  if (!(await eshipperConfigured())) return { cancelled: true };
  await requireRealMode("cancelShipment");
  const order = input.trackingNumber
    ? { trackingId: input.trackingNumber }
    : { orderId: input.providerShipmentId ?? "" };
  const raw = (await eshipperFetch("DELETE", "/api/v2/ship/cancel", { order }, "cancelShipment")) as {
    order?: unknown;
  };
  return { cancelled: Array.isArray(raw?.order) && raw.order.length > 0, raw };
}

/**
 * Re-download the label for a booked shipping order.
 *
 * The endpoint answers with the DOCUMENT, typed `string` in the spec — not a
 * JSON object and not a URL — so it is read as text and wrapped the same way the
 * booking reply's inline label is.
 */
export async function getLabel(orderId: string): Promise<LabelResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("getLabel");
  const text = (await eshipperFetch("GET", `/api/v2/ship/${orderId}/label`, undefined, "getLabel", true)) as string;
  return { labelUrl: labelToHref({ type: "PDF", data: text }), format: "PDF" };
}

export async function getOrderDetails(orderId: string): Promise<OrderDetailsResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("getOrderDetails");
  // Spec types this 200 as `string`: it is a document, not JSON.
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}/order-details`, undefined, "getOrderDetails", true);
  return { orderId, details: raw };
}

export async function getCustomsInvoice(orderId: string): Promise<CustomsInvoiceResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("getCustomsInvoice");
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}/customs-invoice`);
  return { customsInvoiceUrl: String(raw.url ?? raw.customsInvoiceUrl ?? "") };
}

export async function trackByOrderId(orderId: string): Promise<TrackingResult> {
  if (!(await eshipperConfigured())) {
    return {
      trackingUrl: "https://example.invalid/simulated-tracking/SIM123",
      trackingDetails: [
        { dateTime: new Date().toISOString(), location: "Origin", description: "Label created", statusText: "labelGenerated" },
      ],
      labelGenerated: true,
      pickup: false,
      inTransit: false,
      outForDelivery: false,
      exception: false,
      undelivered: false,
      delivered: false,
      returned: false,
      cancelled: false,
      deliveryEstimate: null,
      deliveredPackages: null,
      totalPackages: null,
    };
  }
  await requireRealMode("trackByOrderId");
  const raw = await eshipperFetch("GET", `/api/v2/track/${orderId}`);
  return normalizeTracking(raw);
}

export async function trackByTrackingNumber(trackingNumber: string): Promise<TrackingResult> {
  if (!(await eshipperConfigured())) {
    return {
      trackingUrl: `https://example.invalid/simulated-tracking/${trackingNumber}`,
      trackingDetails: [
        { dateTime: new Date().toISOString(), location: "Origin", description: "Label created", statusText: "labelGenerated" },
      ],
      labelGenerated: true,
      pickup: false,
      inTransit: false,
      outForDelivery: false,
      exception: false,
      undelivered: false,
      delivered: false,
      returned: false,
      cancelled: false,
      deliveryEstimate: null,
      deliveredPackages: null,
      totalPackages: null,
    };
  }
  await requireRealMode("trackByTrackingNumber");
  const raw = await eshipperFetch("GET", `/api/v2/track/tracking-number/${trackingNumber}`);
  return normalizeTracking(raw);
}

export async function bulkTrack(trackingNumbers: string[]): Promise<BulkTrackingResult> {
  if (!(await eshipperConfigured())) {
    return {
      results: trackingNumbers.map((tn) => ({
        trackingUrl: `https://example.invalid/simulated-tracking/${tn}`,
        trackingDetails: [{ dateTime: new Date().toISOString(), location: "Origin", description: "Label created", statusText: "labelGenerated" }],
        labelGenerated: true,
        pickup: false,
        inTransit: false,
        outForDelivery: false,
        exception: false,
        undelivered: false,
        delivered: false,
        returned: false,
        cancelled: false,
        deliveryEstimate: null,
        deliveredPackages: null,
        totalPackages: null,
      })),
    };
  }
  await requireRealMode("bulkTrack");
  if (trackingNumbers.length > 20) {
    throw new Error("Bulk tracking limited to 20 tracking numbers per request.");
  }
  const raw = await eshipperFetch("POST", "/api/v2/track/tracking-number/bulk", { trackingNumbers });
  const results = (Array.isArray(raw) ? raw : (raw as { results?: unknown[] })?.results ?? []).map(normalizeTracking);
  return { results };
}

function normalizeTracking(raw: unknown): TrackingResult {
  const r = raw as Record<string, unknown>;
  const details = (Array.isArray(r.trackingDetails) ? r.trackingDetails : []).map((d: unknown) => {
    const de = d as Record<string, unknown>;
    return {
      dateTime: String(de.dateTime ?? de.timestamp ?? ""),
      location: String(de.location ?? ""),
      description: String(de.description ?? de.status ?? ""),
      carrierEventCode: de.carrierEventCode ? String(de.carrierEventCode) : undefined,
      proofOfDelivery: de.proofOfDelivery,
      statusText: String(de.statusText ?? de.status ?? ""),
    };
  });
  // Only a date the carrier actually stated. A malformed one is dropped rather
  // than turned into today: an unparsable estimate is not an estimate of now.
  const estimateRaw = r.deliveryEstimate ?? r.estimatedDelivery ?? r.expectedDelivery ?? r.deliveryDate ?? null;
  const estimateDate = estimateRaw ? new Date(String(estimateRaw)) : null;
  const deliveryEstimate = estimateDate && !Number.isNaN(estimateDate.getTime()) ? estimateDate : null;

  const count = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };

  return {
    trackingUrl: String(r.trackingUrl ?? ""),
    trackingDetails: details,
    labelGenerated: Boolean(r.labelGenerated ?? r.label_created ?? false),
    pickup: Boolean(r.pickup ?? false),
    inTransit: Boolean(r.inTransit ?? r.in_transit ?? false),
    outForDelivery: Boolean(r.outForDelivery ?? r.out_for_delivery ?? false),
    exception: Boolean(r.exception ?? false),
    undelivered: Boolean(r.undelivered ?? false),
    delivered: Boolean(r.delivered ?? false),
    returned: Boolean(r.returned ?? false),
    cancelled: Boolean(r.cancelled ?? false),
    deliveryEstimate,
    deliveredPackages: count(r.deliveredPackages ?? r.delivered_packages),
    totalPackages: count(r.totalPackages ?? r.total_packages ?? r.packageCount),
  };
}

/**
 * Whether a return LABEL may be purchased. Off, deliberately, and off here.
 *
 * The returns workflow was rewritten against the documented contract (save the
 * return quote, then create from the numeric id) after the previous
 * implementation was found to be calling an endpoint that cannot work. The
 * rewrite is correct as far as the spec goes, but NO RETURN HAS EVER COMPLETED
 * AGAINST THE PROVIDER — not in test, not in production. A booking path that has
 * never once succeeded is not one to leave a button on.
 *
 * So quoting stays open (it is read-only and costs nothing) and the PURCHASE is
 * closed. The gate lives in the adapter rather than only in the screen, because
 * a hidden button is not a control: the action, a job, or a future caller would
 * each have to remember, and the one that forgets buys a label.
 *
 * Flip this to `true` only when a sandbox return has been created end to end and
 * the reply recorded — then remove this comment and its gate.
 */
export const RETURN_PURCHASING_ENABLED = false;

/** The refusal, in the operator's words, whenever the gate above is closed. */
export const RETURN_PURCHASING_DISABLED_REASON =
  "Return label purchasing is switched off until a return has been created successfully against " +
  "eShipper's sandbox. Return rates can still be requested; no return label can be bought yet.";

function assertReturnPurchasingEnabled() {
  if (!RETURN_PURCHASING_ENABLED) throw new Error(RETURN_PURCHASING_DISABLED_REASON);
}

export async function getReturnQuote(req: RateRequest): Promise<ReturnQuote[]> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("getReturnQuote");
  /*
   * The SAME wire request as an outbound rate call, and that is not a
   * coincidence: `ReturnQuoteRequest_APIv2UserView` is `QuoteRequest_APIv2UserView`
   * plus three return-only flags (`boxFreeLabelFree`, `qrCodePackaged`,
   * `returnLabelPackaged`), all optional and all defaulting to the outbound
   * behaviour. Everything this app sends is therefore already valid here.
   *
   * The answer is the same `QuoteResponse` envelope too, which is why it is read
   * with `normalizeRates` rather than by hand. Reading it by hand is what was
   * wrong before: the reader looked for `rates` (the key is `quotes`), for
   * `total`/`cost` (the key is `totalCharge`) and for `carrier`/`serviceCode`
   * (they are `carrierName`/`serviceId`), so every return rate came back absent
   * or priced at zero — the exact defect the outbound reader had already been
   * fixed for, still live on this side of the copy.
   */
  const raw = await eshipperFetch("POST", "/api/v2/returns/quote", buildQuoteRequest(req, new Date()));
  const envelope = raw as { uuid?: unknown; warnings?: unknown[] } | null;
  const quotes = normalizeRates(raw, envelope?.uuid == null ? null : String(envelope.uuid)) as ReturnQuote[];
  if (quotes.length === 0) {
    // The same rule as getRates: an empty list is the provider declining to
    // price, and it says why in `warnings`. Returning [] discards the reason and
    // makes a malformed envelope look like "no coverage".
    const reasons = (envelope?.warnings ?? []).map((w) => String(w).trim()).filter(Boolean);
    throw new Error(
      reasons.length
        ? `eShipper returned no return rates. ${reasons.length} carrier(s) declined: ${reasons.join(" | ")}`
        : "eShipper returned no return rates and offered no reason."
    );
  }
  return quotes;
}

/**
 * Save a return quote so that it can be created.
 *
 * THE SAME THREE-STEP SHAPE AS AN OUTBOUND BOOKING, on a parallel set of paths:
 *
 *     POST /api/v2/returns/quote      rates
 *     PUT  /api/v2/returns/quote      SAVE  -> SaveQuoteResponse.quoteId
 *     POST /api/v2/returns/create/{id} CREATE -> ShippingReply
 *
 * Note the body key: `returnQuoteRequest`, NOT `quoteRequest`. The two save
 * endpoints differ in exactly that one word, and Jackson ignores a property it
 * does not recognise — so sending the outbound name would not be rejected, it
 * would be saved as an empty request.
 *
 * This replaces a `PUT /api/v2/returns/quote/{quoteId}` that does not exist:
 * the save path takes no path segment at all, and the value being passed as one
 * was a service code.
 */
export async function saveReturnQuote(input: {
  /** The rate envelope's `uuid` — the transaction the return quote came from. */
  rateUuid: string;
  rateRequest: RateRequest;
  /** The one quote object being bought, as the provider returned it. */
  quote: Record<string, unknown>;
}): Promise<number> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("saveReturnQuote");
  const raw = (await eshipperFetch(
    "PUT",
    "/api/v2/returns/quote",
    {
      returnQuoteRequest: buildQuoteRequest(input.rateRequest, new Date()),
      quote: input.quote,
      uuid: input.rateUuid,
    },
    "saveReturnQuote"
  )) as { quoteId?: unknown; message?: unknown; type?: unknown };
  const quoteId = Number(raw?.quoteId);
  if (!Number.isFinite(quoteId) || quoteId <= 0) {
    // Never fall back to the uuid — see saveQuote. The create endpoint declares
    // `integer/int64`, so "no id" and "wrong id" are the same refusal one call
    // later, and the second one has no message to explain itself.
    throw new Error(
      `eShipper did not issue a creatable return quote id. It said: ${String(raw?.message ?? "nothing")}`
    );
  }
  return quoteId;
}

export async function bookReturn(input: {
  quote: {
    carrier: string;
    serviceCode: string;
    serviceName: string;
    /** The rate envelope's uuid; the handle the SAVE names. */
    providerQuoteId?: string | null;
    /** The provider's own quote object, replayed verbatim into the save. */
    raw?: unknown;
  };
  rateRequest: RateRequest;
}): Promise<ReturnBookingResult> {
  /*
   * Checked FIRST, before the simulated branch. A simulated return is still a
   * return that reports success, and reporting success is the thing this gate
   * exists to stop: an operator who saw one would reasonably conclude the flow
   * works, which is exactly what nobody knows yet.
   */
  assertReturnPurchasingEnabled();
  if (!(await eshipperConfigured())) {
    const id = `sim_ret_${Math.random().toString(36).slice(2, 10)}`;
    const tracking = `SIMR${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`;
    return {
      providerReturnId: id,
      carrier: input.quote.carrier,
      serviceName: input.quote.serviceName,
      trackingNumber: tracking,
      trackingUrl: `https://example.invalid/simulated-return-tracking/${tracking}`,
      labelUrl: `https://example.invalid/simulated-return-label/${id}.pdf`,
      bookedCost: 0,
      currency: "CAD",
    };
  }
  await requireRealMode("bookReturn");
  /*
   * SAVE, THEN CREATE — the returns equivalent of the outbound two-call booking,
   * and it replaces a call that could never have worked.
   *
   * The old body was `POST /api/v2/returns/create/{serviceCode}` carrying the
   * rate envelope plus `returnItems` and `returnAddress`. Three things were
   * wrong with it, and the last one is the instructive one:
   *
   *   1. `/returns/create/{id}` takes `integer/int64` — a SAVED QUOTE id. A
   *      service code is neither numeric nor a quote.
   *   2. The create-by-quote endpoint takes NO request body: everything it needs
   *      travels in the save that precedes it.
   *   3. `returnItems` and `returnAddress` DO NOT EXIST in this API. Neither
   *      name appears anywhere in the 278 schemas. Jackson ignores unknown
   *      properties, so they were not rejected — they were silently dropped,
   *      which is why the call looked plausible and bought nothing.
   *
   * The lesson generalises and is why this is written against the spec rather
   * than against the previous implementation: on this API an unrecognised field
   * is not an error, so a wrong body is indistinguishable from a right one until
   * something is actually purchased.
   *
   * What is being returned is OUR record, not the provider's: the API creates a
   * label from the return address to the destination and does not itemise it.
   * The line items are stored on the local Shipment (ShipmentItem) by the
   * caller, which is where an operator reads them.
   */
  if (!input.quote.providerQuoteId) {
    throw new Error(
      "This return quote has no eShipper rate id. Re-request return rates so the booking can reference the rate it was priced from."
    );
  }
  const quoteObject = input.quote.raw as Record<string, unknown> | undefined;
  if (!quoteObject || typeof quoteObject !== "object" || Array.isArray(quoteObject)) {
    throw new Error(
      "This return quote did not keep the provider's own quote object, so it cannot be saved. Re-request return rates."
    );
  }
  const savedQuoteId = await saveReturnQuote({
    rateUuid: input.quote.providerQuoteId,
    rateRequest: input.rateRequest,
    quote: quoteObject,
  });
  const raw = (await eshipperFetch(
    "POST",
    `/api/v2/returns/create/${savedQuoteId}`,
    undefined,
    "bookReturn"
  )) as Record<string, unknown>;
  // The create answers with the SAME `ShippingReply` an outbound booking does,
  // so it is read by the same reader — one place that knows the reply's shape
  // rather than two that can drift.
  const reply = readShippingReply(raw, input.quote);
  return { ...reply, providerReturnId: reply.providerShipmentId, savedQuoteId };
}

/**
 * Create a return from a full request, with no saved quote.
 *
 * `PUT /api/v2/returns/create` is real and documented, but it is a DIFFERENT
 * operation from the saved-quote path this module books through: it takes the
 * whole `ReturnShippingRequest` (`ReturnQuoteRequest` plus `forwardShippingOrderId`
 * and `warehouse`), obtains quotes itself and books the best one. It is kept for
 * completeness and is not on the operator's path.
 *
 * Its answer is a `ShippingReply`, so it is read by the same reader — the old
 * body looked for `returnId`/`id`/`status`/`items`, none of which this reply
 * carries, and would have recorded an empty return at zero cost.
 */
export async function updateReturn(data: Record<string, unknown>): Promise<ReturnBookingResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("updateReturn");
  const raw = await eshipperFetch("PUT", "/api/v2/returns/create", data) as Record<string, unknown>;
  const reply = readShippingReply(raw, { carrier: "", serviceName: "" });
  return { ...reply, providerReturnId: reply.providerShipmentId };
}

export async function getReturn(returnId: string): Promise<ReturnDetails | null> {
  if (!(await eshipperConfigured())) return null;
  await requireRealMode("getReturn");
  const raw = await eshipperFetch("GET", `/api/v2/returns/${returnId}`) as Record<string, unknown>;
  if (!raw || Object.keys(raw).length === 0) return null;
  /*
   * Read as the `ShippingReply` it is, under the same names `readShippingReply`
   * uses. `status` and `items` have no counterpart in the reply at all — the
   * provider describes a shipment, not our return record — so they are reported
   * as absent rather than filled from keys that do not exist. The itemised lines
   * the operator reads come from our own ShipmentItem rows.
   */
  const reply = readShippingReply(raw, { carrier: "", serviceName: "" });
  const order = (raw.order ?? {}) as Record<string, unknown>;
  return {
    returnId: reply.providerShipmentId,
    status: order.message ? String(order.message) : "",
    trackingNumber: reply.trackingNumber || null,
    trackingUrl: reply.trackingUrl,
    labelUrl: reply.labelUrl,
    items: [],
    raw,
  };
}

export async function schedulePickup(data: {
  shipFrom: { name: string; address: string; city: string; province: string; postalCode: string; country: string; phone?: string; email?: string };
  pickupDate: string;
  pickupTimeWindow: string;
  packages: { count: number; weight: number; length?: number; width?: number; height?: number }[];
  notes?: string;
}): Promise<PickupResult> {
  if (!(await eshipperConfigured())) {
    return {
      pickupId: `sim_pickup_${Math.random().toString(36).slice(2, 10)}`,
      scheduledDate: data.pickupDate,
      status: "SCHEDULED",
      confirmationNumber: `SIMCONF${Date.now()}`,
    };
  }
  await requireRealMode("schedulePickup");
  // `data` IS the payload on this endpoint, so the ship-from address is not
  // built by `toWireAddress` and gets the same treatment by hand.
  const payload = { ...data, shipFrom: checkedDispatchAddress(data.shipFrom, "pickup") };
  const raw = await eshipperFetch("POST", "/api/v2/pickup", payload) as Record<string, unknown>;
  return {
    pickupId: String(raw.pickupId ?? raw.id ?? ""),
    scheduledDate: String(raw.scheduledDate ?? data.pickupDate),
    status: String(raw.status ?? "SCHEDULED"),
    confirmationNumber: raw.confirmationNumber ? String(raw.confirmationNumber) : undefined,
    raw,
  };
}

export async function cancelPickup(pickupId: string): Promise<{ cancelled: boolean }> {
  if (!(await eshipperConfigured())) return { cancelled: true };
  await requireRealMode("cancelPickup");
  const raw = await eshipperFetch("POST", `/api/v2/pickup/${pickupId}`, {}) as Record<string, unknown>;
  return { cancelled: Boolean(raw.cancelled ?? raw.success ?? true) };
}