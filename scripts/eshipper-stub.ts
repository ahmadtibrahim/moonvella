/**
 * A deterministic eShipper stand-in for suites that are testing OUR logic, not
 * the carrier's.
 *
 * verify-wholesale used to reach the real eShipper test host: it fetched live
 * quotes and then called the booking endpoint for real on every run. That made
 * it neither of the two test types — it simulated Stripe and hit a live provider
 * for shipping — and it spent real sandbox credit to check things like "a second
 * booking does not double-purchase", which is a property of our code and has
 * nothing to do with eShipper being up.
 *
 * The response shapes below are the ones the adapter actually parses; they are
 * copied from the stubs verify-shipping already uses rather than invented, so a
 * change to the adapter's expectations shows up as a failure in both suites.
 *
 * Delegation is deliberate. This does NOT simply replace globalThis.fetch: a
 * non-eShipper URL is passed to whatever fetch was already installed, so the
 * provider guard run-verify.mjs puts in place still refuses Stripe, and any
 * unexpected host still behaves exactly as it did before the stub existed. A
 * stub that swallowed everything would hide precisely the calls worth catching.
 */

const ESHIPPER_HOSTS = ["eshipper.com"];

export interface StubCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function isEshipper(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return ESHIPPER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return ESHIPPER_HOSTS.some((h) => url.includes(h));
  }
}

/**
 * Three quotes with deliberately different shapes:
 *   UPS         cheapest, so "cheapest" has something unambiguous to pick.
 *   Purolator   fastest of those with a known estimate.
 *   Canada Post no transit estimate, so the unknown-estimate path is exercised.
 *
 * THE FIELD NAMES ARE THE PROVIDER'S, read off a real 201 response rather than
 * assumed: `carrierName`, the numeric `serviceId`, `totalCharge`, and
 * `transitDays` as a STRING. They were previously `carrier`/`serviceCode`/
 * `total`/number, which is what the adapter read before the contract was
 * verified — so this stub agreed with a broken adapter and both looked right.
 * The quote id is not a per-quote field at all: the response envelope carries
 * one `uuid` covering every quote in it.
 */
const RATES = [
  { carrierName: "UPS", serviceId: 5000001, serviceName: "Standard", totalCharge: 12.0, currency: "CAD", transitDays: "5" },
  { carrierName: "Purolator", serviceId: 5000002, serviceName: "Express", totalCharge: 18.0, currency: "CAD", transitDays: "2" },
  { carrierName: "Canada Post", serviceId: 5000003, serviceName: "Expedited", totalCharge: 15.0, currency: "CAD", transitDays: null },
];

/** One envelope uuid covers every quote returned with it — this is the booking handle. */
const QUOTE_UUID = "STUB-QUOTE-UUID-1";

function responseFor(url: string): { status: number; body: unknown } {
  if (url.includes("/authenticate")) {
    return {
      status: 200,
      body: { token: "stub-token", expires_in: "3600", token_type: "Bearer", refresh_token: "stub-refresh-1", refresh_expires_in: "7200" },
    };
  }
  if (url.includes("/refresh-token")) {
    return {
      status: 200,
      body: { token: "stub-token-2", expires_in: "3600", token_type: "Bearer", refresh_token: "stub-refresh-2", refresh_expires_in: "7200" },
    };
  }
  if (url.includes("/api/v2/returns/quote")) {
    // The adapter wraps a return quote in an array itself rather than reading a
    // list, so this answer is the bare quote object. That shape is inherited
    // from the outbound quote envelope and is NOT yet confirmed against a real
    // returns response — see the note on `saveReturnQuote` in the adapter.
    return { status: 200, body: { ...RATES[0], carrierName: "UPS Returns", serviceName: "Return" } };
  }
  if (url.includes("/api/v2/quote")) {
    return { status: 200, body: { quotes: RATES, uuid: QUOTE_UUID, warnings: [] } };
  }
  // Sub-resources first: they are also under /api/v2/ship/.
  if (url.includes("/api/v2/ship/") && url.endsWith("/label")) {
    return { status: 200, body: { url: "https://labels.invalid/stub-label.pdf", format: "PDF" } };
  }
  if (url.includes("/api/v2/ship/") && url.endsWith("/order-details")) {
    return { status: 200, body: { orderId: "STUB-O-1", details: { weight: 2 } } };
  }
  if (url.includes("/api/v2/ship/") && url.endsWith("/customs-invoice")) {
    return { status: 200, body: { url: "https://labels.invalid/stub-customs.pdf" } };
  }
  if (url.includes("/api/v2/ship/")) {
    return {
      status: 200,
      body: {
        shipmentId: "STUB-SHIP-1",
        carrier: "UPS",
        serviceName: "Standard",
        trackingNumber: "STUBTRACK1",
        trackingUrl: "https://track.invalid/STUBTRACK1",
        labelUrl: "https://labels.invalid/stub-label.pdf",
        cost: 12.0,
        currency: "CAD",
      },
    };
  }
  if (url.includes("/api/v2/track/tracking-number/bulk")) {
    return { status: 200, body: { results: [] } };
  }
  if (url.includes("/api/v2/track/tracking-number/")) {
    return {
      status: 200,
      body: {
        trackingUrl: "https://track.invalid/STUBTRACK1",
        trackingDetails: [
          { dateTime: "2026-01-01T00:00:00Z", location: "Toronto", description: "In transit", carrierEventCode: "IT", statusText: "inTransit" },
        ],
        inTransit: true,
      },
    };
  }
  if (url.includes("/api/v2/pickup")) {
    return { status: 200, body: { pickupId: "STUB-PK-1", scheduledDate: "2026-02-01", status: "SCHEDULED" } };
  }
  // Anything else under the provider is a call the stub does not know about.
  // Answering 500 rather than guessing keeps it as a visible failure.
  return { status: 500, body: { error: `eshipper-stub: unmapped provider url ${url}` } };
}

/**
 * Install the stub. Returns the recorded calls so a suite can assert on the
 * requests the adapter built — the same technique verify-shipping uses.
 */
export function installEshipperStub(): { calls: StubCall[] } {
  const calls: StubCall[] = [];
  const underlying = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url ?? "");

    // Not the provider: let the real chain handle it, guard included.
    if (!isEshipper(url)) return underlying(input as never, init);

    let body: Record<string, unknown> | null = null;
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    calls.push({ url, method: init?.method ?? "GET", body });

    const r = responseFor(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { calls };
}
