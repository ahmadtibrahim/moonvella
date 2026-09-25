/**
 * A LIVE sandbox quote from eShipper — the half of the quote contract that
 * cannot be pinned offline.
 *
 * `verify-eshipper-contract.ts` pins every field NAME against one verbatim
 * response the provider actually returned. What it cannot establish is that the
 * provider ACCEPTS the envelope this code now builds, for real, with the units
 * it declares, and that more than one parcel arrives. That is this script, and
 * it is deliberately NOT part of `verify:all`: a suite that needs a live third
 * party fails for reasons that have nothing to do with the code, and `--all` is
 * meant to be runnable when the network, the account or the provider is having a
 * bad day.
 *
 *   node scripts/run-verify.mjs scripts/quote-sandbox.ts
 *
 * WHY IT IS SAFE. Two independent things hold:
 *
 *   1. The configured account must classify as "test". The app's own
 *      `classifyEshipperEnvironment` decides that, and it looks at the HOST
 *      first — a recognised test host is reported as test whatever
 *      ESHIPPER_ENV says, so a production account cannot be reached by setting
 *      the wrong variable. This script refuses outright on anything but "test".
 *   2. NOTHING IS BOOKED. It calls `getRates` and nothing else: no `book`, no
 *      `cancel`, no shipment row, no database write. The only write reachable
 *      from `getRates` is the not-configured health row, which is not on the
 *      configured path.
 *
 * PRINTS NO CREDENTIALS. The output is carriers, prices, parcel counts and
 * booleans. No token, no username, no base URL — not even the host.
 *
 * DO NOT extend this into a booking. A sandbox booking is a separate,
 * deliberate act with its own authorization, and it belongs in the purchase
 * flow, not here.
 */
import { getRates, eshipperEnvironment, type RateRequest } from "~/services/eshipper.server";

const env = await eshipperEnvironment();
if (env !== "test") {
  console.error(`REFUSING: the configured eShipper account is "${env}", not "test".`);
  console.error("A live quote against a production account is not authorized here.");
  process.exit(2);
}

const WAREHOUSE = {
  name: "MoonVella Warehouse",
  address: "994 Westport Cres, Unit 7A",
  city: "Mississauga",
  province: "ON",
  // The address we hold, deliberately NOT the one Google suggests. A check that
  // quoted from L5T 1X8 would be quoting a warehouse we do not ship from.
  postalCode: "L5T 1G1",
  country: "CA",
  phone: null,
  email: null,
};

const CONSIGNEE = {
  name: "Sandbox Consignee",
  address: "100 King St W",
  city: "Toronto",
  province: "ON",
  postalCode: "M5X 1A9",
  country: "CA",
  residential: false,
};

const request = (packages: RateRequest["packages"]): RateRequest => ({
  shipFrom: WAREHOUSE,
  shipTo: CONSIGNEE,
  packages,
  declaredValue: 250,
  insurance: false,
});

/** `totalAmount` is CENTS — `normalizeRates` multiplies `totalCharge` by 100. */
const dollars = (q: { totalAmount: number }) => q.totalAmount / 100;

function report(label: string, quotes: Awaited<ReturnType<typeof getRates>>) {
  const priced = quotes.filter((q) => q.totalAmount > 0);
  console.log(`\n${label}`);
  console.log(`  quotes returned: ${quotes.length}  (priced above zero: ${priced.length})`);
  for (const q of quotes.slice(0, 6)) {
    console.log(
      `    ${q.carrier} · ${q.serviceName} · $${dollars(q).toFixed(2)} ${q.currency}` +
        ` · transit ${q.transitDays ?? "n/a"} · serviceId ${q.serviceCode}` +
        ` · quoteId ${q.providerQuoteId ? "present" : "absent"}`
    );
  }
  return { returned: quotes.length, priced: priced.length };
}

// 1. ONE PARCEL, in centimetres and kilograms. The API takes the unit tokens it
//    is given and prices without complaint; whether it READ them as centimetres
//    is pinned offline, and the price rising with the box is the live evidence
//    that the dimensions were used at all.
const single = await getRates(
  request([{ count: 1, length: 40, width: 30, height: 20, weight: 2.5, units: "cm_kg" }])
);
const s = report("ONE PARCEL — 40 x 30 x 20 cm, 2.5 kg", single);

// 2. TWO PARCELS OF DIFFERENT SIZES. This is the case the envelope rewrite was
//    for: the API takes parcels individually rather than as a count, so both
//    boxes must reach it — and a second box that never arrived would price the
//    same as the first, which is why the prices are compared below.
const multi = await getRates(
  request([
    { count: 1, length: 40, width: 30, height: 20, weight: 2.5, units: "cm_kg" },
    { count: 1, length: 25, width: 20, height: 15, weight: 1.2, units: "cm_kg" },
  ])
);
const m = report("TWO DIFFERENT PARCELS — 40x30x20 @2.5kg and 25x20x15 @1.2kg", multi);

// 3. A COUNT OF TWO on one row, which the envelope must expand into two
//    enumerated parcels rather than sending a bare `count` the API would drop.
const counted = await getRates(
  request([{ count: 2, length: 40, width: 30, height: 20, weight: 2.5, units: "cm_kg" }])
);
const c = report("TWO OF THE SAME — count 2 of 40x30x20 @2.5kg", counted);

const cheapest = (qs: Awaited<ReturnType<typeof getRates>>) =>
  qs.length ? Math.min(...qs.map((q) => q.totalAmount)) : 0;

const single_ok = s.returned > 0 && s.priced > 0;
const multi_ok = m.returned > 0 && m.priced > 0;
const count_ok = c.returned > 0 && c.priced > 0;
const secondBoxArrived = cheapest(multi) > cheapest(single);
const handles = [...single, ...multi, ...counted].every((q) => !!q.providerQuoteId);

console.log("\n=== VERDICT ===");
console.log(`single parcel accepted and priced:  ${single_ok}`);
console.log(`two different parcels accepted:     ${multi_ok}`);
console.log(`count expanded and accepted:        ${count_ok}`);
console.log(
  `cheapest single / two-box:          $${dollars({ totalAmount: cheapest(single) }).toFixed(2)} / ` +
    `$${dollars({ totalAmount: cheapest(multi) }).toFixed(2)}`
);
console.log(`the second box raised the price:    ${secondBoxArrived} (if false, it never reached the carrier)`);
console.log(`all quotes carry a booking handle:  ${handles}`);

const ok = single_ok && multi_ok && count_ok && secondBoxArrived && handles;
console.log(ok ? "\nPASS — the sandbox accepted the envelope." : "\nFAIL — see the lines above.");
process.exit(ok ? 0 : 1);
