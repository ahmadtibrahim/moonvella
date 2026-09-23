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

export interface RateRequest {
  shipFrom: { name?: string; address: string; city?: string; province?: string; postalCode: string; country: string };
  shipTo: { name?: string; address: string; city?: string; province?: string; postalCode: string; country: string; residential?: boolean };
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
  providerShipmentId: string;
  carrier: string;
  serviceName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  labelUrl: string | null;
  bookedCost: number;
  currency: string;
  raw?: unknown;
}

export interface LabelResult {
  labelUrl: string;
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
  exception: boolean;
  undelivered: boolean;
  delivered: boolean;
  returned: boolean;
  cancelled: boolean;
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
  /** The provider's quote id for the return, when it issues one. */
  providerQuoteId?: string | null;
  raw?: unknown;
}

export interface ReturnBookingResult {
  providerReturnId: string;
  carrier: string;
  serviceName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  labelUrl: string | null;
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

async function eshipperFetch(method: string, path: string, body?: unknown) {
  const { baseUrl } = await eshipperConfig();
  const doFetch = async () =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getToken()}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  let res = await doFetch();
  if (res.status === 401) {
    await getToken(true);
    res = await doFetch();
  }
  const text = await res.text();
  // Redacted, not raw: this message can be persisted as an integration detail.
  if (!res.ok) throw new Error(`eShipper error ${res.status}: ${redactSecrets(text)}`);
  if (!text) return {};
  return JSON.parse(text);
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
  const raw = await eshipperFetch("POST", "/api/v2/quote", req);
  return normalizeRates(raw);
}

function normalizeRates(raw: unknown): RateQuote[] {
  const list = Array.isArray(raw) ? raw : (raw as { rates?: unknown[] })?.rates ?? [];
  return list.map((r) => {
    const rate = r as Record<string, unknown>;
    const transit = rate.transitDays ?? rate.transit_days ?? null;
    const delivery = rate.estimatedDelivery ?? rate.deliveryDate ?? null;
    // Coerced rather than passed through: this arrives as unknown JSON and
    // booking by id needs a string. Absent stays null, meaning "no id issued".
    const quoteId = rate.quoteId ?? rate.quote_id ?? rate.id ?? null;
    return {
      carrier: String(rate.carrier ?? rate.carrierName ?? "Unknown"),
      serviceCode: String(rate.serviceCode ?? rate.service_code ?? ""),
      serviceName: String(rate.serviceName ?? rate.service_name ?? ""),
      totalAmount: Math.round(Number(rate.total ?? rate.cost ?? 0) * 100),
      currency: String(rate.currency ?? "CAD"),
      transitDays: transit === null ? null : Number(transit),
      estimatedDelivery: delivery ? new Date(String(delivery)) : null,
      expiresAt: rate.expiresAt ? new Date(String(rate.expiresAt)) : null,
      providerQuoteId: quoteId === null ? null : String(quoteId),
      raw: rate,
    };
  });
}

export async function saveQuote(quoteId: string, req: RateRequest): Promise<RateQuote> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("saveQuote");
  const raw = await eshipperFetch("PUT", `/api/v2/quote/${quoteId}`, req);
  return normalizeRates([raw])[0];
}

export async function getQuote(quoteId: string): Promise<RateQuote | null> {
  if (!(await eshipperConfigured())) return null;
  await requireRealMode("getQuote");
  const raw = await eshipperFetch("GET", `/api/v2/quote/${quoteId}`);
  const quotes = normalizeRates([raw]);
  return quotes[0] ?? null;
}

export async function bookShipment(input: {
  quote: { carrier: string; serviceCode: string; serviceName: string; providerQuoteId?: string | null };
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
  // Documented as POST /api/v2/ship/{quoteId}. Without a provider quote id there
  // is no id to book against, and booking by guessing one would risk a second
  // label purchase — so refuse and ask for a re-quote instead.
  if (!input.quote.providerQuoteId) {
    throw new Error(
      "This quote has no eShipper quote id. Re-request quotes so the booking can reference the provider quote."
    );
  }
  const raw = await eshipperFetch("POST", `/api/v2/ship/${encodeURIComponent(input.quote.providerQuoteId)}`, {
    ...input.rateRequest,
    serviceCode: input.quote.serviceCode,
  }) as Record<string, unknown>;
  return {
    providerShipmentId: String(raw.shipmentId ?? raw.orderId ?? raw.id ?? ""),
    carrier: String(raw.carrier ?? input.quote.carrier),
    serviceName: String(raw.serviceName ?? input.quote.serviceName),
    trackingNumber: String(raw.trackingNumber ?? raw.tracking ?? ""),
    trackingUrl: raw.trackingUrl ? String(raw.trackingUrl) : null,
    labelUrl: raw.labelUrl ? String(raw.labelUrl) : null,
    bookedCost: Math.round(Number(raw.cost ?? raw.total ?? 0) * 100),
    currency: String(raw.currency ?? "CAD"),
    raw,
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

export async function getShipment(orderId: string): Promise<BookingResult | null> {
  if (!(await eshipperConfigured())) return null;
  await requireRealMode("getShipment");
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}`) as Record<string, unknown>;
  if (!raw || Object.keys(raw).length === 0) return null;
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

export async function cancelShipment(providerShipmentId: string): Promise<{ cancelled: boolean }> {
  if (!(await eshipperConfigured())) return { cancelled: true };
  await requireRealMode("cancelShipment");
  const raw = await eshipperFetch("DELETE", "/api/v2/ship/cancel", { shipmentId: providerShipmentId }) as Record<string, unknown>;
  return { cancelled: Boolean(raw.cancelled ?? raw.success ?? true) };
}

export async function getLabel(orderId: string): Promise<LabelResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("getLabel");
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}/label`);
  return { labelUrl: String(raw.labelUrl ?? raw.url ?? ""), format: String(raw.format ?? "PDF") };
}

export async function getOrderDetails(orderId: string): Promise<OrderDetailsResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("getOrderDetails");
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}/order-details`);
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
      exception: false,
      undelivered: false,
      delivered: false,
      returned: false,
      cancelled: false,
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
      exception: false,
      undelivered: false,
      delivered: false,
      returned: false,
      cancelled: false,
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
        exception: false,
        undelivered: false,
        delivered: false,
        returned: false,
        cancelled: false,
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
  return {
    trackingUrl: String(r.trackingUrl ?? ""),
    trackingDetails: details,
    labelGenerated: Boolean(r.labelGenerated ?? r.label_created ?? false),
    pickup: Boolean(r.pickup ?? false),
    inTransit: Boolean(r.inTransit ?? r.in_transit ?? false),
    exception: Boolean(r.exception ?? false),
    undelivered: Boolean(r.undelivered ?? false),
    delivered: Boolean(r.delivered ?? false),
    returned: Boolean(r.returned ?? false),
    cancelled: Boolean(r.cancelled ?? false),
  };
}

export async function getReturnQuote(req: RateRequest): Promise<ReturnQuote[]> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("getReturnQuote");
  const raw = await eshipperFetch("POST", "/api/v2/returns/quote", req);
  const list = Array.isArray(raw) ? raw : (raw as { rates?: unknown[] })?.rates ?? [];
  return list.map((r) => {
    const rate = r as Record<string, unknown>;
    const transit = rate.transitDays ?? rate.transit_days ?? null;
    const delivery = rate.estimatedDelivery ?? rate.deliveryDate ?? null;
    // A return quote is booked by id like any other, so it carries the provider's
    // quote id too — the shipment record persists it under "eshipper-return".
    const quoteId = rate.quoteId ?? rate.quote_id ?? rate.id ?? null;
    return {
      carrier: String(rate.carrier ?? rate.carrierName ?? "Unknown"),
      serviceCode: String(rate.serviceCode ?? rate.service_code ?? ""),
      serviceName: String(rate.serviceName ?? rate.service_name ?? ""),
      totalAmount: Math.round(Number(rate.total ?? rate.cost ?? 0) * 100),
      currency: String(rate.currency ?? "CAD"),
      transitDays: transit === null ? null : Number(transit),
      estimatedDelivery: delivery ? new Date(String(delivery)) : null,
      expiresAt: rate.expiresAt ? new Date(String(rate.expiresAt)) : null,
      providerQuoteId: quoteId === null ? null : String(quoteId),
      raw: rate,
    };
  });
}

export async function saveReturnQuote(quoteId: string, req: RateRequest): Promise<ReturnQuote> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("saveReturnQuote");
  const raw = await eshipperFetch("PUT", `/api/v2/returns/quote/${quoteId}`, req);
  return normalizeRates([raw])[0] as ReturnQuote;
}

export async function bookReturn(input: {
  quote: { carrier: string; serviceCode: string; serviceName: string };
  rateRequest: RateRequest;
  returnItems: { sku: string; quantity: number }[];
  returnAddress: { name: string; address: string; city: string; province: string; postalCode: string; country: string };
}): Promise<ReturnBookingResult> {
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
  const raw = await eshipperFetch("POST", `/api/v2/returns/create/${input.quote.serviceCode}`, {
    ...input.rateRequest,
    serviceCode: input.quote.serviceCode,
    returnItems: input.returnItems,
    returnAddress: input.returnAddress,
  }) as Record<string, unknown>;
  return {
    providerReturnId: String(raw.returnId ?? raw.id ?? ""),
    carrier: String(raw.carrier ?? input.quote.carrier),
    serviceName: String(raw.serviceName ?? input.quote.serviceName),
    trackingNumber: String(raw.trackingNumber ?? raw.tracking ?? ""),
    trackingUrl: raw.trackingUrl ? String(raw.trackingUrl) : null,
    labelUrl: raw.labelUrl ? String(raw.labelUrl) : null,
    bookedCost: Math.round(Number(raw.cost ?? raw.total ?? 0) * 100),
    currency: String(raw.currency ?? "CAD"),
    raw,
  };
}

export async function updateReturn(data: Record<string, unknown>): Promise<ReturnBookingResult> {
  if (!(await eshipperConfigured())) throw new Error("eShipper not configured.");
  await requireRealMode("updateReturn");
  const raw = await eshipperFetch("PUT", "/api/v2/returns/create", data) as Record<string, unknown>;
  return {
    providerReturnId: String(raw.returnId ?? raw.id ?? ""),
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

export async function getReturn(returnId: string): Promise<ReturnDetails | null> {
  if (!(await eshipperConfigured())) return null;
  await requireRealMode("getReturn");
  const raw = await eshipperFetch("GET", `/api/v2/returns/${returnId}`) as Record<string, unknown>;
  if (!raw || Object.keys(raw).length === 0) return null;
  return {
    returnId: String(raw.returnId ?? raw.id ?? ""),
    status: String(raw.status ?? ""),
    trackingNumber: raw.trackingNumber ? String(raw.trackingNumber) : null,
    trackingUrl: raw.trackingUrl ? String(raw.trackingUrl) : null,
    labelUrl: raw.labelUrl ? String(raw.labelUrl) : null,
    items: Array.isArray(raw.items) ? raw.items.map((i: unknown) => {
      const it = i as Record<string, unknown>;
      return { sku: String(it.sku ?? ""), quantity: Number(it.quantity ?? 0) };
    }) : [],
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
  const raw = await eshipperFetch("POST", "/api/v2/pickup", data) as Record<string, unknown>;
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