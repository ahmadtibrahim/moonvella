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
 * Rate/booking/label/tracking/cancel endpoint paths follow the official
 * documentation exactly. When required configuration is absent, the module
 * runs in a clearly labelled simulated mode.
 *
 * Env var names (values live only in the backend .env, excluded from git):
 *   ESHIPPER_BASE_URL        account API base URL
 *   ESHIPPER_USERNAME        account username / API user
 *   ESHIPPER_PASSWORD        account password / API secret
 *   ESHIPPER_ACCOUNT_ID      account identifier (optional, if required)
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

function baseUrl(): string | undefined {
  return process.env.ESHIPPER_BASE_URL;
}

export function eshipperAuthConfigured(): boolean {
  return !!baseUrl() && !!process.env.ESHIPPER_USERNAME && !!process.env.ESHIPPER_PASSWORD;
}

export function eshipperEnv(): string {
  // Deliberately empty when unset. A hostname is a string, not proof of an
  // environment: treating a URL that merely contains "sandbox" as authorization
  // to call a provider is exactly the mistake this avoids. Only an explicit
  // ESHIPPER_ENV=sandbox or ESHIPPER_ENV=production enables real calls.
  return process.env.ESHIPPER_ENV || "";
}

export function eshipperConfigured(): boolean {
  if (!eshipperAuthConfigured()) return false;
  const env = eshipperEnv();
  if (env === "production") return true;
  if (env === "sandbox") return /sandbox/i.test(baseUrl() || "");
  return false;
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

function requireRealMode(operation: string) {
  const env = eshipperEnv();
  if (env === "production") return;
  if (env === "sandbox" && /sandbox/i.test(baseUrl() || "")) return;
  throw new Error(
    `Refusing a real eShipper call for ${operation}: ESHIPPER_ENV is "${env || "(unset)"}" and sandbox could not be confirmed. ` +
      `Set ESHIPPER_ENV=sandbox with a sandbox base URL, or ESHIPPER_ENV=production only for live bookings.`
  );
}

async function eshipperFetch(method: string, path: string, body?: unknown) {
  const doFetch = async () =>
    fetch(`${baseUrl()}${path}`, {
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
  if (!res.ok) throw new Error(`eShipper error ${res.status}: ${text}`);
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
  if (!eshipperConfigured()) {
    // Imported lazily so importing this module (e.g. from a test or a script)
    // does not pull in the database layer for a code path that never touches it.
    const { setIntegrationState } = await import("./integrationHealth.server");
    await setIntegrationState("eshipper", {
      status: "NOT_CONFIGURED",
      detail: `Simulated eShipper rates. Account ${maskedEshipperAccount() ?? "(not configured)"}. Configure credentials for real quotes.`,
    });
    return simulatedRates(req);
  }
  requireRealMode("getRates");
  const raw = await eshipperFetch("POST", "/api/v2/quote", req);
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
      providerQuoteId: rate.quoteId ?? rate.quote_id ?? rate.id ?? null,
      raw: rate,
    };
  });
}

export async function saveQuote(quoteId: string, req: RateRequest): Promise<RateQuote> {
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("saveQuote");
  const raw = await eshipperFetch("PUT", `/api/v2/quote/${quoteId}`, req);
  return normalizeRates([raw])[0];
}

export async function getQuote(quoteId: string): Promise<RateQuote | null> {
  if (!eshipperConfigured()) return null;
  requireRealMode("getQuote");
  const raw = await eshipperFetch("GET", `/api/v2/quote/${quoteId}`);
  const quotes = normalizeRates([raw]);
  return quotes[0] ?? null;
}

export async function bookShipment(input: {
  quote: { carrier: string; serviceCode: string; serviceName: string; providerQuoteId?: string | null };
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
  requireRealMode("bookShipment");
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
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("updateShipment");
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
  if (!eshipperConfigured()) return null;
  requireRealMode("getShipment");
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
  if (!eshipperConfigured()) return { cancelled: true };
  requireRealMode("cancelShipment");
  const raw = await eshipperFetch("DELETE", "/api/v2/ship/cancel", { shipmentId: providerShipmentId }) as Record<string, unknown>;
  return { cancelled: Boolean(raw.cancelled ?? raw.success ?? true) };
}

export async function getLabel(orderId: string): Promise<LabelResult> {
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("getLabel");
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}/label`);
  return { labelUrl: String(raw.labelUrl ?? raw.url ?? ""), format: String(raw.format ?? "PDF") };
}

export async function getOrderDetails(orderId: string): Promise<OrderDetailsResult> {
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("getOrderDetails");
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}/order-details`);
  return { orderId, details: raw };
}

export async function getCustomsInvoice(orderId: string): Promise<CustomsInvoiceResult> {
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("getCustomsInvoice");
  const raw = await eshipperFetch("GET", `/api/v2/ship/${orderId}/customs-invoice`);
  return { customsInvoiceUrl: String(raw.url ?? raw.customsInvoiceUrl ?? "") };
}

export async function trackByOrderId(orderId: string): Promise<TrackingResult> {
  if (!eshipperConfigured()) {
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
  requireRealMode("trackByOrderId");
  const raw = await eshipperFetch("GET", `/api/v2/track/${orderId}`);
  return normalizeTracking(raw);
}

export async function trackByTrackingNumber(trackingNumber: string): Promise<TrackingResult> {
  if (!eshipperConfigured()) {
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
  requireRealMode("trackByTrackingNumber");
  const raw = await eshipperFetch("GET", `/api/v2/track/tracking-number/${trackingNumber}`);
  return normalizeTracking(raw);
}

export async function bulkTrack(trackingNumbers: string[]): Promise<BulkTrackingResult> {
  if (!eshipperConfigured()) {
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
  requireRealMode("bulkTrack");
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
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("getReturnQuote");
  const raw = await eshipperFetch("POST", "/api/v2/returns/quote", req);
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

export async function saveReturnQuote(quoteId: string, req: RateRequest): Promise<ReturnQuote> {
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("saveReturnQuote");
  const raw = await eshipperFetch("PUT", `/api/v2/returns/quote/${quoteId}`, req);
  return normalizeRates([raw])[0] as ReturnQuote;
}

export async function bookReturn(input: {
  quote: { carrier: string; serviceCode: string; serviceName: string };
  rateRequest: RateRequest;
  returnItems: { sku: string; quantity: number }[];
  returnAddress: { name: string; address: string; city: string; province: string; postalCode: string; country: string };
}): Promise<ReturnBookingResult> {
  if (!eshipperConfigured()) {
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
  requireRealMode("bookReturn");
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
  if (!eshipperConfigured()) throw new Error("eShipper not configured.");
  requireRealMode("updateReturn");
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
  if (!eshipperConfigured()) return null;
  requireRealMode("getReturn");
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
  if (!eshipperConfigured()) {
    return {
      pickupId: `sim_pickup_${Math.random().toString(36).slice(2, 10)}`,
      scheduledDate: data.pickupDate,
      status: "SCHEDULED",
      confirmationNumber: `SIMCONF${Date.now()}`,
    };
  }
  requireRealMode("schedulePickup");
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
  if (!eshipperConfigured()) return { cancelled: true };
  requireRealMode("cancelPickup");
  const raw = await eshipperFetch("POST", `/api/v2/pickup/${pickupId}`, {}) as Record<string, unknown>;
  return { cancelled: Boolean(raw.cancelled ?? raw.success ?? true) };
}