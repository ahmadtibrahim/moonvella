/**
 * Shipping / eShipper verification.
 *
 * Two kinds of check live here, and they are kept visibly apart:
 *
 *   1. Pure logic — unit conversions, tracking normalization, quote ranking,
 *      charge allocation. These are checked directly and need no provider.
 *
 *   2. Provider request mapping — the HTTP method and path each documented
 *      operation uses. These are checked by stubbing global.fetch and inspecting
 *      the request the adapter actually builds. They prove the SHAPE of our
 *      calls. They are NOT a real eShipper sandbox verification: no provider
 *      answered, and no label, pickup or cancellation was booked anywhere.
 */
import {
  allocateSellerShippingCharge,
  normalizeTrackingState,
  trackingLabel,
  pickCheapestQuote,
  pickFastestQuote,
} from "../app/services/shippingLogic";
import { toCm, toKg, buildQuotePackagesForOrder } from "../app/services/packaging.server";
import {
  getRates,
  bookShipment,
  cancelShipment,
  getLabel,
  getOrderDetails,
  getCustomsInvoice,
  trackByTrackingNumber,
  bulkTrack,
  getReturnQuote,
  schedulePickup,
  eshipperConfigured,
  eshipperMode,
  type TrackingResult,
} from "../app/services/eshipper.server";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function tracking(partial: Partial<TrackingResult>): TrackingResult {
  return {
    trackingUrl: "",
    trackingDetails: [],
    labelGenerated: false,
    pickup: false,
    inTransit: false,
    exception: false,
    undelivered: false,
    delivered: false,
    returned: false,
    cancelled: false,
    ...partial,
  };
}

// --- a fetch stub that records every call -----------------------------------
type Call = { url: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
function installFetch(respond: (url: string) => { status?: number; body?: unknown }) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    calls.push({ url, method, body });
    const r = respond(url);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}
const lastCall = () => calls[calls.length - 1];

const rateRequest = {
  shipFrom: { address: "1 Warehouse Way", city: "Toronto", province: "ON", postalCode: "M5H2N2", country: "CA" },
  shipTo: { address: "9 Buyer Rd", city: "Ottawa", province: "ON", postalCode: "K1A0A1", country: "CA", residential: true },
  packages: [{ count: 1, length: 30, width: 20, height: 10, weight: 2, units: "cm_kg" }],
};

async function main() {
  // 1. Unit conversions -------------------------------------------------------
  check("inches to cm (1in = 2.54cm)", close(toCm(1, "in"), 2.54), String(toCm(1, "in")));
  check("cm unchanged", toCm(40, "cm") === 40);
  check("lb to kg (1lb = 0.45359237kg)", close(toKg(1, "lb"), 0.45359237), String(toKg(1, "lb")));
  check("kg unchanged", toKg(2.5, "kg") === 2.5);
  // Switching display unit must not change the physical measurement: 12in stored
  // as 30.48cm reads back as exactly 12in, and no drift is introduced by a
  // second round trip.
  const storedCm = toCm(12, "in");
  check("unit switch is lossless (12in -> cm -> in)", close(storedCm / 2.54, 12), String(storedCm / 2.54));
  check("no rounding drift over round trips", close(toCm(storedCm / 2.54, "in"), storedCm));

  // 2. Missing package data ---------------------------------------------------
  const noVariant = await buildQuotePackagesForOrder({
    items: [{ sku: "NO-VARIANT", quantity: 1, variantId: null }],
    packages: [],
  });
  check("missing variant packaging is reported, not invented", noVariant.packages.length === 0 && noVariant.missing.some((m) => m.includes("no variant mapping")), JSON.stringify(noVariant.missing));

  const manual = await buildQuotePackagesForOrder({
    items: [],
    packages: [{ count: 2, length: 30, width: 20, height: 10, weight: 1.5, units: "cm_kg" }],
  });
  check("manual order packages are used as-is", manual.source === "manual" && manual.packages.length === 1 && manual.packages[0].count === 2);

  // 3. Quote ranking with unknown estimates ----------------------------------
  const quotes = [
    { id: "a", totalAmount: 1800, transitDays: null },
    { id: "b", totalAmount: 1200, transitDays: 4 },
    { id: "c", totalAmount: null, transitDays: 2 },
  ];
  check("cheapest ignores a null amount", (pickCheapestQuote(quotes) as { id: string }).id === "b");
  check("fastest ignores a null estimate rather than treating it as zero", (pickFastestQuote(quotes) as { id: string }).id === "c");
  check("fastest is null when no estimate exists", pickFastestQuote([{ transitDays: null }, { transitDays: null }]) === null);
  check("cheapest is null when no amount exists", pickCheapestQuote([{ totalAmount: null }]) === null);

  // 4. Tracking normalization ------------------------------------------------
  check("label only is LABEL_CREATED, not shipped", normalizeTrackingState(tracking({ labelGenerated: true })) === "LABEL_CREATED");
  check("in transit is IN_TRANSIT", normalizeTrackingState(tracking({ inTransit: true })) === "IN_TRANSIT");
  check("delivered is DELIVERED", normalizeTrackingState(tracking({ delivered: true })) === "DELIVERED");
  check("exception is EXCEPTION", normalizeTrackingState(tracking({ exception: true })) === "EXCEPTION");
  check("returned wins over delivered (later, meaningful event)", normalizeTrackingState(tracking({ delivered: true, returned: true })) === "RETURNED");
  check("cancelled wins over everything", normalizeTrackingState(tracking({ delivered: true, cancelled: true })) === "CANCELLED");
  check("no indicators reads as UNKNOWN", normalizeTrackingState(tracking({})) === "UNKNOWN");
  check("tracking label: null is Preparing", trackingLabel(null) === "Preparing");
  check("tracking label: CANCELLING is Cancel requested", trackingLabel("CANCELLING") === "Cancel requested");

  // 5. Seller charge allocation ----------------------------------------------
  check("no confirmed charge -> no allocation", allocateSellerShippingCharge(0, 2, 4) === null);
  check("null charge -> no allocation", allocateSellerShippingCharge(null, 2, 4) === null);
  check("allocation is proportional (1200 over 3 shipments)", allocateSellerShippingCharge(1200, 1, 3) === 400);
  const sum = allocateSellerShippingCharge(1200, 1, 3)! * 3;
  check("allocations sum back to the order total", sum === 1200, String(sum));
  check("allocation rounds rather than inventing cents", allocateSellerShippingCharge(2000, 1, 3) === 667, String(allocateSellerShippingCharge(2000, 1, 3)));
  check("allocation never exceeds the order charge", allocateSellerShippingCharge(1200, 4, 4) === 1200);

  // 6. Sandbox verification is explicit, not hostname text --------------------
  process.env.ESHIPPER_BASE_URL = "https://sandbox.eshipper.example/api";
  process.env.ESHIPPER_USERNAME = "ops@example.com";
  process.env.ESHIPPER_PASSWORD = "not-a-real-secret";
  delete process.env.ESHIPPER_ENV;
  check("a 'sandbox' hostname alone does NOT enable real calls", eshipperConfigured() === false);
  check("unset env reports simulated mode", eshipperMode() === "simulated");

  process.env.ESHIPPER_ENV = "sandbox";
  check("explicit sandbox env + sandbox host enables sandbox calls", eshipperConfigured() === true);

  // 7. Provider request mapping (MOCKED) -------------------------------------
  installFetch((url) => {
    if (url.includes("/authenticate")) return { body: { token: "test-token", expiresIn: 3600 } };
    if (url.includes("/refresh-token")) return { body: { token: "test-token", expiresIn: 3600 } };
    if (url.includes("/api/v2/quote")) return { body: { rates: [{ carrier: "Canada Post", serviceCode: "CP", serviceName: "Expedited", total: 15.5, currency: "CAD", transitDays: 3, quoteId: "Q-1" }] } };
    if (url.includes("/api/v2/ship/") && url.endsWith("/label")) return { body: { url: "https://labels.example/L.pdf", format: "PDF" } };
    if (url.includes("/api/v2/ship/") && url.endsWith("/order-details")) return { body: { orderId: "O", details: { weight: 2 } } };
    if (url.includes("/api/v2/ship/") && url.endsWith("/customs-invoice")) return { body: { url: "https://labels.example/C.pdf" } };
    if (url.includes("/api/v2/ship/")) return { body: { shipmentId: "SHIP-1", carrier: "Canada Post", serviceName: "Expedited", trackingNumber: "TRK1", trackingUrl: "https://track/TRK1", labelUrl: "https://labels/L.pdf", cost: 15.5, currency: "CAD" } };
    if (url.includes("/api/v2/track/tracking-number/bulk")) return { body: { results: [] } };
    if (url.includes("/api/v2/track/tracking-number/")) return { body: { trackingUrl: "https://track/TN", trackingDetails: [{ dateTime: "2026-01-01T00:00:00Z", location: "Toronto", description: "In transit", carrierEventCode: "IT", statusText: "inTransit" }], inTransit: true } };
    if (url.includes("/api/v2/returns/quote")) return { body: { rates: [{ carrier: "UPS", serviceCode: "UP", serviceName: "Return", total: 9.25, currency: "CAD", transitDays: 5, quoteId: "RQ-1" }] } };
    if (url.includes("/api/v2/pickup")) return { body: { pickupId: "PK-1", scheduledDate: "2026-02-01", status: "SCHEDULED" } };
    return { status: 500, body: { error: "unexpected url" } };
  });

  const rates = await getRates(rateRequest);
  check("getRates: POST /api/v2/quote", lastCall().method === "POST" && lastCall().url.endsWith("/api/v2/quote"), `${lastCall().method} ${lastCall().url}`);
  check("getRates: provider quote id is preserved", rates[0]?.providerQuoteId === "Q-1", JSON.stringify(rates[0]?.providerQuoteId));
  check("getRates: request carries the packages", Array.isArray((lastCall().body as { packages?: unknown[] })?.packages));

  const booking = await bookShipment({
    quote: { carrier: "Canada Post", serviceCode: "CP", serviceName: "Expedited", providerQuoteId: "Q-1" },
    rateRequest,
  });
  check("bookShipment: POST /api/v2/ship/{quoteId}", lastCall().method === "POST" && lastCall().url.endsWith("/api/v2/ship/Q-1"), `${lastCall().method} ${lastCall().url}`);
  check("bookShipment: reads tracking + label from the response", booking.trackingNumber === "TRK1" && booking.labelUrl === "https://labels/L.pdf");
  check("bookShipment: refuses a quote with no provider id", await (async () => {
    try {
      await bookShipment({ quote: { carrier: "X", serviceCode: "X", serviceName: "X", providerQuoteId: null }, rateRequest });
      return false;
    } catch {
      return true;
    }
  })());

  await cancelShipment("SHIP-1");
  check("cancelShipment: DELETE /api/v2/ship/cancel", lastCall().method === "DELETE" && lastCall().url.endsWith("/api/v2/ship/cancel"), `${lastCall().method} ${lastCall().url}`);

  await getLabel("SHIP-1");
  check("getLabel: GET /api/v2/ship/{id}/label", lastCall().method === "GET" && lastCall().url.endsWith("/api/v2/ship/SHIP-1/label"), `${lastCall().method} ${lastCall().url}`);

  await getOrderDetails("SHIP-1");
  check("getOrderDetails: GET order-details", lastCall().url.endsWith("/api/v2/ship/SHIP-1/order-details"));

  await getCustomsInvoice("SHIP-1");
  check("getCustomsInvoice: GET customs-invoice", lastCall().url.endsWith("/api/v2/ship/SHIP-1/customs-invoice"));

  await trackByTrackingNumber("TRK1");
  check("trackByTrackingNumber: GET /api/v2/track/tracking-number/{n}", lastCall().url.endsWith("/api/v2/track/tracking-number/TRK1"));

  await getReturnQuote(rateRequest);
  check("getReturnQuote: POST /api/v2/returns/quote", lastCall().method === "POST" && lastCall().url.endsWith("/api/v2/returns/quote"));

  await schedulePickup({
    shipFrom: { name: "MoonVella", address: "1 Warehouse Way", city: "Toronto", province: "ON", postalCode: "M5H2N2", country: "CA" },
    pickupDate: "2026-02-01",
    pickupTimeWindow: "09:00-17:00",
    packages: [{ count: 1, weight: 2 }],
  });
  check("schedulePickup: POST /api/v2/pickup", lastCall().method === "POST" && lastCall().url.endsWith("/api/v2/pickup"));

  check("bulkTrack refuses more than 20 numbers", await (async () => {
    try {
      await bulkTrack(Array.from({ length: 21 }, (_, i) => `T${i}`));
      return false;
    } catch {
      return true;
    }
  })());

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  console.log("NOTE: provider checks are MOCKED request-mapping checks. No real eShipper sandbox call was made.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
