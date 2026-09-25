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
import {
  toCm,
  toKg,
  buildQuotePackagesForOrder,
  parcelRowsToQuotePackages,
  type StoredParcelRow,
} from "../app/services/packaging.server";
import { packagesForShipment } from "../app/services/shipping.server";
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
  classifyEshipperEnvironment,
  isRecognizedTestHost,
  testEshipperAuthentication,
  resetEshipperToken,
  type TrackingResult,
} from "../app/services/eshipper.server";
import { getCredential } from "../app/services/credentials.server";

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
  outForDelivery: false,
  deliveryEstimate: null,
  deliveredPackages: null,
  totalPackages: null,
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
  // Classified from explicit inputs rather than from process.env: the decision
  // under test is the rule itself, and reading the live environment would make
  // this pass or fail according to what is configured on the host (including
  // anything an operator has saved in Settings).
  const creds = { username: "ops@example.com", password: "not-a-real-secret" };
  check(
    "a 'sandbox' hostname alone does NOT enable real calls",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://sandbox.eshipper.example/api", env: null }) === "unconfigured"
  );
  check(
    "explicit sandbox env + sandbox host enables sandbox calls",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://sandbox.eshipper.example/api", env: "sandbox" }) === "test"
  );
  check(
    "the production host is not live without an explicit production env",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://ww2.eshipper.com", env: null }) === "unconfigured"
  );
  check(
    "explicit production env enables live calls",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://ww2.eshipper.com", env: "production" }) === "production"
  );
  check(
    "the staging env value authorises nothing on its own",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://ww2.eshipper.com", env: "staging" }) === "unconfigured"
  );
  check(
    "missing credentials are unconfigured whatever the host",
    classifyEshipperEnvironment({ ...creds, password: null, baseUrl: "https://uu2.eshipper.com", env: "production" }) === "unconfigured"
  );

  // 6b. The confirmed test host is recognised by name, not by the word --------
  // uu2.eshipper.com is this account's confirmed test host. It is matched
  // exactly, so no "sandbox" in the URL is needed, while an arbitrary host still
  // cannot authorise itself merely by containing the word.
  check(
    "confirmed test host enables calls with no ESHIPPER_ENV set",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://uu2.eshipper.com", env: null }) === "test"
  );
  check(
    "a recognised test host is never reported as production, whatever ESHIPPER_ENV says",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://uu2.eshipper.com", env: "production" }) === "test"
  );
  check(
    "the test host is recognised case-insensitively and with a path",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://UU2.EShipper.com/api", env: null }) === "test"
  );
  check("a lookalike host is not recognised", isRecognizedTestHost("https://uu2.eshipper.com.evil.example") === false);
  check("the test host is only recognised over https", isRecognizedTestHost("http://uu2.eshipper.com") === false);
  check(
    "a lookalike host falls back to the env rules, not to trust",
    classifyEshipperEnvironment({ ...creds, baseUrl: "https://uu2.eshipper.com.evil.example", env: null }) === "unconfigured"
  );

  // The mocked provider section below drives the real functions, which resolve
  // credentials through the store. These environment values keep that path
  // self-contained.
  process.env.ESHIPPER_USERNAME = creds.username;
  process.env.ESHIPPER_PASSWORD = creds.password;
  process.env.ESHIPPER_BASE_URL = "https://sandbox.eshipper.example/api";
  process.env.ESHIPPER_ENV = "sandbox";

  // 7. Provider request mapping (MOCKED) -------------------------------------
  installFetch((url) => {
    if (url.includes("/authenticate")) return { body: { token: "test-token", expires_in: "3600", token_type: "Bearer", refresh_token: "refresh-1", refresh_expires_in: "7200" } };
    if (url.includes("/refresh-token")) return { body: { token: "refreshed-token", expires_in: "3600", token_type: "Bearer", refresh_token: "refresh-2", refresh_expires_in: "7200" } };
    if (url.includes("/api/v2/quote")) return { body: { quotes: [{ carrierName: "Canada Post", serviceId: 5000026, serviceName: "Expedited", totalCharge: 15.5, currency: "CAD", transitDays: "3" }], uuid: "Q-1", warnings: [] } };
    if (url.includes("/api/v2/ship/") && url.endsWith("/label")) return { body: { url: "https://labels.example/L.pdf", format: "PDF" } };
    if (url.includes("/api/v2/ship/") && url.endsWith("/order-details")) return { body: { orderId: "O", details: { weight: 2 } } };
    if (url.includes("/api/v2/ship/") && url.endsWith("/customs-invoice")) return { body: { url: "https://labels.example/C.pdf" } };
    if (url.includes("/api/v2/ship/")) return { body: { shipmentId: "SHIP-1", carrier: "Canada Post", serviceName: "Expedited", trackingNumber: "TRK1", trackingUrl: "https://track/TRK1", labelUrl: "https://labels/L.pdf", cost: 15.5, currency: "CAD" } };
    if (url.includes("/api/v2/track/tracking-number/bulk")) return { body: { results: [] } };
    if (url.includes("/api/v2/track/tracking-number/")) return { body: { trackingUrl: "https://track/TN", trackingDetails: [{ dateTime: "2026-01-01T00:00:00Z", location: "Toronto", description: "In transit", carrierEventCode: "IT", statusText: "inTransit" }], inTransit: true } };
    if (url.includes("/api/v2/returns/quote")) return { body: { carrierName: "UPS", serviceId: 5000200, serviceName: "Return", totalCharge: 9.25, currency: "CAD", transitDays: "5" } };
    if (url.includes("/api/v2/pickup")) return { body: { pickupId: "PK-1", scheduledDate: "2026-02-01", status: "SCHEDULED" } };
    return { status: 500, body: { error: "unexpected url" } };
  });

  const rates = await getRates(rateRequest);
  check("getRates: POST /api/v2/quote", lastCall().method === "POST" && lastCall().url.endsWith("/api/v2/quote"), `${lastCall().method} ${lastCall().url}`);
  check(
    "getRates: the provider quote id is the envelope's uuid, not a per-quote field",
    rates[0]?.providerQuoteId === "Q-1",
    JSON.stringify(rates[0]?.providerQuoteId)
  );
  /*
   * The WIRE shape, asserted as the provider defines it. Every name checked
   * here was established by asking the sandbox API; the provider ignores an
   * unknown property silently, so a regression to `shipFrom`/`packages: [...]`
   * would not raise an error anywhere -- it would simply price nothing. These
   * assertions are what stand between that and a release.
   */
  const quoteBody = lastCall().body as {
    from?: unknown;
    to?: unknown;
    packagingUnit?: string;
    packages?: { type?: string; packages?: unknown[] };
  };
  check(
    "getRates: addresses go out as from/to, the names the provider reads",
    !!quoteBody.from && !!quoteBody.to && !("shipFrom" in quoteBody) && !("shipTo" in quoteBody),
    `from=${!!quoteBody.from} to=${!!quoteBody.to}`
  );
  check(
    "getRates: parcels are nested under packages.packages, not a bare array",
    quoteBody.packages?.type === "Package" && Array.isArray(quoteBody.packages?.packages),
    `type=${quoteBody.packages?.type} packages=${Array.isArray(quoteBody.packages?.packages)}`
  );
  check(
    "getRates: the request declares its packaging unit",
    quoteBody.packagingUnit === "METRIC",
    String(quoteBody.packagingUnit)
  );

  // 7a. The authentication request is the DOCUMENTED one ----------------------
  // POST /api/v2/authenticate takes AuthenticationRequest: required properties
  // `principal` and `credential`. Sending username/password instead is a schema
  // validation failure — HTTP 400 — which is exactly what the sandbox produced.
  // `accountId` is not part of any documented authentication request.
  // Asserted after the call that triggers it: authentication happens lazily,
  // on the first operation, not when a credential is configured.
  const authCall = calls.find((c) => c.url.includes("/api/v2/authenticate"));
  const authBody = (authCall?.body ?? {}) as Record<string, unknown>;
  // Compared against the credentials the adapter actually RESOLVED, not the
  // environment fixtures set above: once an operator saves credentials in
  // Settings they outrank the environment, so an assertion pinned to the
  // fixture would fail for the wrong reason. Nothing here is printed — the
  // detail line reports booleans only, because `credential` is the password.
  const resolvedUsername = await getCredential("eshipper", "ESHIPPER_USERNAME");
  const resolvedPassword = await getCredential("eshipper", "ESHIPPER_PASSWORD");
  check("authenticate is called before the operation", !!authCall, authCall?.url ?? "not called");
  check(
    "authenticate sends the resolved username AS `principal`",
    !!authBody.principal && authBody.principal === resolvedUsername,
    `match=${authBody.principal === resolvedUsername}`
  );
  check(
    "authenticate sends the resolved password AS `credential`",
    !!authBody.credential && authBody.credential === resolvedPassword,
    `match=${authBody.credential === resolvedPassword}`
  );
  check(
    "authenticate sends exactly the two documented properties",
    JSON.stringify(Object.keys(authBody).sort()) === JSON.stringify(["credential", "principal"]),
    JSON.stringify(Object.keys(authBody).sort())
  );

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

  // 8. The refresh request, and the response fields it depends on ------------
  // POST /api/v2/refresh-token takes RefreshTokenDTO: required property
  // `refresh_token`, and it is a DIFFERENT value from the bearer token. The
  // only way to reach this path without a test hook is to let the issued token
  // expire, which `expires_in: "1"` does on its own — no production code is
  // modified to make this observable.
  // Everything up to here shares one cached bearer token. Dropping it is what
  // makes the renewal path reachable at all — with a live cached token, no
  // operation ever asks the provider for a new one.
  resetEshipperToken();
  const before = calls.length;
  installFetch((url) => {
    if (url.includes("/authenticate"))
      return { body: { token: "short-lived", expires_in: "1", token_type: "Bearer", refresh_token: "refresh-token-abc", refresh_expires_in: "7200" } };
    if (url.includes("/refresh-token"))
      return { body: { token: "renewed", expires_in: "3600", token_type: "Bearer", refresh_token: "refresh-token-def", refresh_expires_in: "7200" } };
    /*
     * This section is about the TOKEN, not the quote, but the reply still has
     * to be a real one: `getRates` now raises an empty answer as a failure
     * naming the carriers' own reasons, because a silently empty list is what
     * let a wholly malformed request look like a successful call. A stub that
     * returned nothing would now stop the test before it reached the assertion
     * it is actually making.
     */
    if (url.includes("/api/v2/quote"))
      return { body: { quotes: [{ carrierName: "Canada Post", serviceId: 5000026, serviceName: "Expedited", totalCharge: 15.5, currency: "CAD", transitDays: "3" }], uuid: "Q-3", warnings: [] } };
    return { status: 500, body: { error: "unexpected url" } };
  });

  await getRates(rateRequest); // authenticates, caches a token that expires at once
  await getRates(rateRequest); // therefore renews before quoting
  const refreshCall = calls.slice(before).find((c) => c.url.includes("/api/v2/refresh-token"));
  const refreshBody = (refreshCall?.body ?? {}) as Record<string, unknown>;
  check("an expired token is renewed via /api/v2/refresh-token", !!refreshCall, refreshCall?.url ?? "not called");
  check("the renewal sends `refresh_token`", refreshBody.refresh_token === "refresh-token-abc", JSON.stringify(refreshBody));
  check(
    "the renewal sends NOT the bearer token",
    refreshBody.refresh_token !== "short-lived" && !("token" in refreshBody)
  );
  check(
    "the renewal sends exactly the documented property",
    JSON.stringify(Object.keys(refreshBody)) === JSON.stringify(["refresh_token"]),
    JSON.stringify(Object.keys(refreshBody))
  );
  check(
    "the renewed bearer token is the one the provider issued",
    (calls.slice(before).filter((c) => c.url.includes("/api/v2/quote")).pop()?.url ?? "").includes("/api/v2/quote")
  );

  // 9. A refusal reports the provider's own validation detail ---------------
  // The failure path used to say only "failed (400)", which is why a schema
  // error was indistinguishable from a wrong password.
  installFetch(() => ({
    status: 400,
    body: {
      type: "VALIDATION_ERROR",
      code: "ESH-400-01",
      message: "Request validation failed",
      fieldErrors: [{ objectName: "AuthenticationRequest", field: "principal", message: "must not be blank" }],
    },
  }));
  const failure = await testEshipperAuthentication();
  check("a refusal is not reported as authenticated", failure.ok === false);
  check("the refusal names the HTTP status", /HTTP 400/.test(failure.reason ?? ""), failure.reason ?? "");
  check("the refusal carries the provider's message", /Request validation failed/.test(failure.reason ?? ""));
  check("the refusal carries the provider's error code", /ESH-400-01/.test(failure.reason ?? ""));
  check(
    "the refusal names the offending FIELD and its message",
    /principal: must not be blank/.test(failure.reason ?? ""),
    failure.reason ?? ""
  );

  // 10. EVERY parcel is in the request, in the units the provider is told -----
  /*
   * The owner's report was that only the first carton ever reached the carrier.
   * Whether that was ever true, it is the failure that costs money and nobody
   * notices: a two-parcel order quoted and labelled as one, with the second box
   * either left on the dock or collected with no paperwork. So this drives a
   * multi-parcel request through the real adapter and reads back the body it
   * actually sent — every row, in order, with the figures converted to the units
   * the request declares, and the totals a carrier would compute from them.
   *
   * STILL MOCKED: no provider answered this. It proves what WE send, not what
   * eShipper accepts.
   */
  installFetch((url) => {
    if (url.includes("/authenticate")) return { body: { token: "t", expires_in: "3600", token_type: "Bearer", refresh_token: "r", refresh_expires_in: "7200" } };
    if (url.includes("/api/v2/quote")) return { body: { quotes: [{ carrierName: "Canada Post", serviceId: 5000026, serviceName: "Expedited", totalCharge: 20, currency: "CAD", transitDays: "3" }], uuid: "Q-2", warnings: [] } };
    if (url.includes("/api/v2/ship/")) return { body: { shipmentId: "SHIP-2", carrier: "Canada Post", serviceName: "Expedited", trackingNumber: "TRK2", labelUrl: "https://labels/L2.pdf", cost: 20, currency: "CAD" } };
    return { status: 500, body: { error: "unexpected url" } };
  });
  resetEshipperToken();

  // A carton recorded in inches and pounds, and one in centimetres and kilograms:
  // the two ways a parcel arrives, converted through the one conversion point and
  // then sent.
  const storedRows: StoredParcelRow[] = [
    { id: "row-a", shipmentId: "ship-1", count: 1, length: 24, width: 18, height: 6, weight: 2.5, units: "in_lb" },
    { id: "row-b", shipmentId: "ship-1", count: 2, length: 30, width: 20, height: 10, weight: 1, units: "cm_kg" },
  ];
  const converted = parcelRowsToQuotePackages(storedRows);
  const multiRequest = { ...rateRequest, packages: converted.packages };
  await getRates(multiRequest);
  const multiBody = lastCall().body as {
    packages?: { packages?: Record<string, unknown>[] };
    packagingUnit?: string;
    scheduledShipDate?: string;
  };
  // The provider takes parcels enumerated, not as a count: the two stored rows
  // (count 1 and count 2) become three parcels on the wire.
  const sent = multiBody.packages?.packages ?? [];
  check(
    "every stored parcel reaches the wire, in row order",
    sent.length === 3 && converted.refused.length === 0,
    `${sent.length} parcel(s) from 2 rows (count 1 + count 2)`,
  );
  check(
    "each parcel keeps its own dimensions, and `count` is expanded to that many parcels",
    sent[0]?.length === 60.96 &&
      sent[0]?.width === 45.72 &&
      sent[0]?.height === 15.24 &&
      sent[0]?.weight === 1.134 &&
      sent[1]?.length === 30 &&
      sent[1]?.weight === 1 &&
      sent[2]?.length === 30 &&
      sent[2]?.weight === 1 &&
      !("count" in (sent[0] ?? {})),
    sent.map((p) => `${p.length}×${p.width}×${p.height} ${p.weight}kg`).join(" | "),
  );
  check(
    "the figures on the wire are centimetres and kilograms, whatever unit they were recorded in",
    sent[0]?.length === 60.96 && sent[0]?.weight === 1.134,
    `24in/2.5lb was sent as ${sent[0]?.length}/${sent[0]?.weight}`,
  );
  /*
   * The unit tokens, now VERIFIED against the provider rather than assumed.
   *
   * This block used to record that the token could not be established from this
   * environment. It has since been established by asking the sandbox: the same
   * box sent as CM and as IN does not price the same, and ten kilograms does not
   * price as ten pounds, so the provider reads these tokens rather than ignoring
   * them. `packagingUnit` is an enum, and the validator names its members
   * outright -- [METRIC, IMPERIAL].
   *
   * The per-parcel tokens are the ones to watch, because they are NOT validated:
   * an unrecognised value is silently defaulted, so a misspelling mis-prices with
   * no error anywhere. That is why buildQuoteRequest refuses anything but the one
   * spelling proven to price in centimetres and kilograms, and why these
   * assertions are pinned to literals rather than to "some non-empty token".
   */
  const dimensionUnits = new Set(sent.map((p) => String(p.dimensionUnit ?? "")));
  const weightUnits = new Set(sent.map((p) => String(p.weightUnit ?? "")));
  check(
    "every parcel carries the verified centimetre token",
    dimensionUnits.size === 1 && dimensionUnits.has("CM"),
    [...dimensionUnits].join(", ") || "(none)"
  );
  check(
    "every parcel carries the verified kilogram token",
    weightUnits.size === 1 && weightUnits.has("KG"),
    [...weightUnits].join(", ") || "(none)"
  );
  check(
    "the request declares the packaging unit those tokens belong to",
    multiBody.packagingUnit === "METRIC",
    String(multiBody.packagingUnit)
  );
  check(
    "the ship date is written in the one format the provider parses",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(multiBody.scheduledShipDate)),
    String(multiBody.scheduledShipDate)
  );
  check(
    "the totals a carrier reads from the request match the parcels it describes",
    sent.length === 3 &&
      Math.abs(sent.reduce((sum, p) => sum + Number(p.weight), 0) - (1.134 + 1 + 1)) < 1e-9,
    `3 parcels, ${(1.134 + 2).toFixed(3)} kg`,
  );

  await bookShipment({
    quote: { carrier: "Canada Post", serviceCode: "5000026", serviceName: "Expedited", providerQuoteId: "Q-2" },
    rateRequest: multiRequest,
  });
  const bookedBody = lastCall().body as {
    packages?: { packages?: Record<string, unknown>[] };
    serviceId?: unknown;
  };
  const bookedPackages = bookedBody.packages?.packages ?? [];
  check(
    "booking re-sends the same parcels: the label describes the boxes that were quoted",
    bookedPackages.length === 3 && bookedPackages[0]?.length === 60.96,
    `${bookedPackages.length} parcel(s) at booking`,
  );
  check(
    "booking names the service by the id the provider issued, not a reassembled code",
    bookedBody.serviceId === 5000026,
    String(bookedBody.serviceId),
  );

  // 11. A shipment books its OWN cartons, not the whole order's ---------------
  /*
   * `packagesForShipment` is pure — it is handed the shipment and the order and
   * returns what that box may be described as — so the scoping rules are checked
   * here with plain objects, no database and no provider.
   *
   * THE DEFECT THIS PINS: every booking used to send the ORDER's whole parcel
   * list, so an order packed into two boxes told the carrier that each box
   * contained all of them — a price, a label and a customs declaration for goods
   * that were not in it. The linked-carton branch is what fixes that, and the
   * refusal below is what stops the other half of it: a set whose unit cannot be
   * read is refused whole, because sending the readable half of a set is how a
   * parcel goes missing without anyone deciding to leave it out.
   */
  const orderWithTwoBoxes = {
    id: "order-1",
    items: [
      { id: "line-1", sku: "SKU-1", quantity: 1, variantId: "variant-1" },
      { id: "line-2", sku: "SKU-2", quantity: 1, variantId: "variant-2" },
    ],
    packages: [
      { id: "row-a", shipmentId: "ship-1", count: 1, length: 24, width: 18, height: 6, weight: 2.5, units: "in_lb" },
      { id: "row-b", shipmentId: "ship-2", count: 1, length: 30, width: 20, height: 10, weight: 1, units: "cm_kg" },
    ],
  };
  const forFirst = await packagesForShipment({ id: "ship-1", items: [] }, orderWithTwoBoxes);
  const forSecond = await packagesForShipment({ id: "ship-2", items: [] }, orderWithTwoBoxes);
  check(
    "a shipment described by assigned cartons carries only its own",
    forFirst.source === "linked" &&
      forFirst.packages.length === 1 &&
      forFirst.packages[0].length === 60.96 &&
      forSecond.packages.length === 1 &&
      forSecond.packages[0].length === 30,
    `first ${forFirst.packages.map((p) => p.length).join(",")} / second ${forSecond.packages.map((p) => p.length).join(",")}`,
  );
  const unassigned = await packagesForShipment(
    { id: "ship-9", items: [] },
    { ...orderWithTwoBoxes, packages: orderWithTwoBoxes.packages.map((p) => ({ ...p, shipmentId: null })) },
  );
  check(
    "cartons assigned to no box are described on the booking, and the operator is told to assign them",
    unassigned.packages.length === 2 && unassigned.notes.some((n) => n.includes("Assign the cartons")),
    unassigned.notes.join("; ") || "no note",
  );
  const unreadable = await packagesForShipment(
    { id: "ship-3", items: [] },
    {
      ...orderWithTwoBoxes,
      packages: [{ id: "row-mm", shipmentId: "ship-3", count: 1, length: 600, width: 400, height: 300, weight: 12, units: "mm_kg" }],
    },
  );
  check(
    "a carton in an unreadable unit refuses the shipment rather than being sent as written",
    unreadable.packages.length === 0 && unreadable.missing.some((m) => m.includes("row-mm")),
    unreadable.missing.join("; ") || "no reason given",
  );
  const nothingKnown = await packagesForShipment(
    { id: "ship-4", items: [{ orderItemId: "line-gone", quantity: 1 }] },
    { id: "order-2", items: [], packages: [] },
  );
  check(
    "a line that is no longer on the order is refused by name, not skipped",
    nothingKnown.packages.length === 0 && nothingKnown.missing.some((m) => m.includes("line-gone")),
    nothingKnown.missing.join("; "),
  );
  const emptyBox = await packagesForShipment(
    { id: "ship-5", items: [] },
    { id: "order-3", items: [], packages: [] },
  );
  check(
    "a box with nothing recorded and nothing to derive says so instead of booking nothing quietly",
    emptyBox.packages.length === 0 && emptyBox.missing.length === 1,
    emptyBox.missing.join("; "),
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  console.log("NOTE: provider checks are MOCKED request-mapping checks. No real eShipper sandbox call was made.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
