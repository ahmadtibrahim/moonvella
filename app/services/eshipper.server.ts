import { setIntegrationState } from "./integrationHealth.server";

/**
 * eShipper logistics integration boundary.
 *
 * Authentication follows the documented flow:
 *   POST {base}/api/v2/authenticate     -> obtain bearer token
 *   POST {base}/api/v2/refresh-token    -> refresh bearer token
 *   subsequent requests: Authorization: Bearer <token>
 *
 * Credentials are owner-managed, server-side ONLY. They are never returned to
 * the browser, never stored in the database, and never logged. Admin screens
 * receive only a masked account identifier and a status.
 *
 * Rate/booking/label/tracking/cancel endpoint paths must be confirmed from the
 * account's official documentation; they are configured via env rather than
 * hard-coded, so no endpoint is invented. When required configuration is
 * absent, the module runs in a clearly labelled simulated mode.
 *
 * Env var names (values live only in the backend .env, excluded from git):
 *   ESHIPPER_BASE_URL        account API base URL
 *   ESHIPPER_USERNAME        account username / API user
 *   ESHIPPER_PASSWORD        account password / API secret
 *   ESHIPPER_ACCOUNT_ID      account identifier (optional, if required)
 *   ESHIPPER_RATE_PATH       rate-quote path (from docs)
 *   ESHIPPER_BOOK_PATH       booking path (from docs)
 *   ESHIPPER_LABEL_PATH      label path (from docs)
 *   ESHIPPER_TRACK_PATH      tracking path (from docs)
 *   ESHIPPER_CANCEL_PATH     cancel/void path (from docs)
 *   ESHIPPER_PICKUP_PATH     pickup path (optional, from docs)
 */

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

function baseUrl(): string | undefined {
  return process.env.ESHIPPER_BASE_URL;
}

export function eshipperAuthConfigured(): boolean {
  return !!baseUrl() && !!process.env.ESHIPPER_USERNAME && !!process.env.ESHIPPER_PASSWORD;
}

export function eshipperEnv(): string {
  return process.env.ESHIPPER_ENV || "sandbox";
}

export function eshipperConfigured(): boolean {
  if (!eshipperAuthConfigured() || !process.env.ESHIPPER_RATE_PATH) return false;
  // In non-production we REQUIRE an explicitly sandbox base URL. A production URL
  // (or an unconfirmed URL) fails safe to simulated mode — never a production call.
  if (eshipperEnv() === "production") return true;
  return /sandbox/i.test(baseUrl() || "");
}

export function eshipperMode(): "real" | "simulated" {
  return eshipperConfigured() ? "real" : "simulated";
}

/** Masked identifier safe to display in admin screens. Never a secret. */
export function maskedEshipperAccount(): string | null {
  const user = process.env.ESHIPPER_USERNAME;
  if (!user) return null;
  if (user.includes("@")) {
    const [name, domain] = user.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `${user.slice(0, 2)}***${user.slice(-2)}`;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function tokenRequest(path: "authenticate" | "refresh-token", body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl()}/api/v2/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Do not include credentials or tokens in the error.
    throw new Error(`eShipper ${path} failed (${res.status}).`);
  }
  return JSON.parse(text) as { token?: string; accessToken?: string; access_token?: string; expiresIn?: number };
}

async function getToken(force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  let data;
  if (cachedToken) {
    try {
      data = await tokenRequest("refresh-token", { token: cachedToken.value });
    } catch {
      data = undefined;
    }
  }
  if (!data) {
    data = await tokenRequest("authenticate", {
      username: process.env.ESHIPPER_USERNAME,
      password: process.env.ESHIPPER_PASSWORD,
      accountId: process.env.ESHIPPER_ACCOUNT_ID,
    });
  }
  const token = data.token || data.accessToken || data.access_token;
  if (!token) throw new Error("eShipper authentication returned no token.");
  cachedToken = { value: token, expiresAt: Date.now() + (data.expiresIn ? data.expiresIn * 1000 : 30 * 60 * 1000) };
  return token;
}

async function eshipperFetch(pathEnv: string, body: unknown) {
  if (eshipperEnv() !== "production" && !/sandbox/i.test(baseUrl() || "")) {
    throw new Error("Refusing a non-sandbox eShipper endpoint in test mode. Set ESHIPPER_ENV=production only for live bookings.");
  }
  const path = process.env[pathEnv];
  if (!path) throw new Error(`eShipper endpoint not configured (${pathEnv}). Set it from the account documentation.`);
  const doFetch = async () =>
    fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getToken()}`,
      },
      body: JSON.stringify(body),
    });
  let res = await doFetch();
  if (res.status === 401) {
    await getToken(true);
    res = await doFetch();
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`eShipper error ${res.status}.`);
  return JSON.parse(text);
}

function simulatedRates(req: RateRequest): RateQuote[] {
  const totalWeight = req.packages.reduce((s, p) => s + p.weight * p.count, 0);
  const totalCount = req.packages.reduce((s, p) => s + p.count, 0);
  const base = 900 + Math.round(totalWeight * 120) + totalCount * 350;
  const now = new Date();
  return [
    { carrier: "Canada Post", serviceCode: "CP-EXPEDITED", serviceName: "Expedited Parcel", totalAmount: base, currency: "CAD", transitDays: 3, estimatedDelivery: new Date(now.getTime() + 3 * 86400000), expiresAt: new Date(now.getTime() + 30 * 60000) },
    { carrier: "Purolator", serviceCode: "PURO-EXPRESS", serviceName: "Purolator Express", totalAmount: Math.round(base * 1.45), currency: "CAD", transitDays: 1, estimatedDelivery: new Date(now.getTime() + 1 * 86400000), expiresAt: new Date(now.getTime() + 30 * 60000) },
    { carrier: "UPS", serviceCode: "UPS-STANDARD", serviceName: "UPS Standard", totalAmount: Math.round(base * 0.92), currency: "CAD", transitDays: null, estimatedDelivery: null, expiresAt: new Date(now.getTime() + 30 * 60000) },
  ];
}

export async function getRates(req: RateRequest): Promise<RateQuote[]> {
  if (!eshipperConfigured()) {
    await setIntegrationState("eshipper", {
      status: "NOT_CONFIGURED",
      detail: `Simulated eShipper rates. Account ${maskedEshipperAccount() ?? "(not configured)"}. Configure credentials and rate path for real quotes.`,
    });
    return simulatedRates(req);
  }
  const raw = await eshipperFetch("ESHIPPER_RATE_PATH", req);
  return normalizeRates(raw);
}

function normalizeRates(raw: unknown): RateQuote[] {
  const list = Array.isArray(raw) ? raw : (raw as { rates?: unknown[] })?.rates ?? [];
  return list.map((r) => {
    const rate = r as Record<string, unknown>;
    const transit = rate.transitDays ?? rate.transit_days ?? null;
    const delivery = rate.estimatedDelivery ?? rate.deliveryDate ?? null;
    return {
      carrier: String(rate.carrier ?? rate.carrierName ?? "Unknown"),
      serviceCode: String(rate.serviceCode ?? rate.service_code ?? ""),
      serviceName: String(rate.serviceName ?? rate.service_name ?? ""),
      totalAmount: Math.round(Number(rate.total ?? rate.cost ?? 0) * 100),
      currency: String(rate.currency ?? "CAD"),
      transitDays: transit === null ? null : Number(transit),
      estimatedDelivery: delivery ? new Date(String(delivery)) : null,
      expiresAt: rate.expiresAt ? new Date(String(rate.expiresAt)) : null,
      raw: rate,
    };
  });
}

export async function bookShipment(input: {
  quote: { carrier: string; serviceCode: string; serviceName: string };
  rateRequest: RateRequest;
}): Promise<BookingResult> {
  if (!eshipperConfigured()) {
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
  const raw = (await eshipperFetch("ESHIPPER_BOOK_PATH", { serviceCode: input.quote.serviceCode, ...input.rateRequest })) as Record<string, unknown>;
  return {
    providerShipmentId: String(raw.shipmentId ?? raw.id ?? ""),
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

export async function cancelShipment(providerShipmentId: string): Promise<{ cancelled: boolean }> {
  if (!eshipperConfigured()) return { cancelled: true };
  const raw = (await eshipperFetch("ESHIPPER_CANCEL_PATH", { shipmentId: providerShipmentId })) as Record<string, unknown>;
  return { cancelled: Boolean(raw.cancelled ?? raw.success ?? true) };
}
