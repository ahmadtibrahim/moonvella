/**
 * The eShipper quote contract, pinned.
 *
 * Every name asserted here was established by asking the provider's API, not by
 * reading its documentation, which is wrong on all of them. The reason that
 * matters is that the provider is SILENT about it: Jackson ignores a property it
 * does not recognise, so a wrong field name is not rejected -- it is dropped,
 * a default takes its place, and the call still answers HTTP 201. That is how
 * this integration shipped sending `shipFrom`/`shipTo`/`postalCode`/`address`
 * to an API that reads `from`/`to`/`zip`/`address1`, and how every quote priced
 * at zero off a `total` field that does not exist.
 *
 * So this suite is deliberately OFFLINE. It does not call the provider: the
 * other suites in this directory assert the no-connection path for the same
 * reason, and a test that needs a live third party fails for reasons that have
 * nothing to do with the code. The live sandbox quote is a separate, deliberate
 * check. What is pinned here is everything that can be settled from the code
 * plus ONE VERBATIM RESPONSE the provider actually returned -- so a future
 * rename breaks a test instead of quietly re-zeroing every price again.
 *
 * Nothing is booked. Nothing is purchased.
 */
import { buildQuoteRequest, normalizeRates, type RateRequest } from "~/services/eshipper.server";

const WAREHOUSE = {
  name: "MoonVella Warehouse",
  address: "994 Westport Cres, Unit 7A",
  city: "Mississauga",
  province: "ON",
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

const parcel = (l: number, w: number, h: number, kg: number, count = 1) =>
  ({ count, length: l, width: w, height: h, weight: kg, units: "cm_kg" });

const request = (packages: RateRequest["packages"]): RateRequest =>
  ({ shipFrom: WAREHOUSE, shipTo: CONSIGNEE, packages, declaredValue: 250, insurance: false });

/*
 * A response the provider actually returned, reproduced verbatim -- same keys,
 * same nesting, same types (note `transitDays` is a STRING and the charges are
 * decimal dollars, not cents). It is the fixture the parser is held to. The
 * uuid is the envelope's, not a quote's, because that is where the provider
 * puts it: ONE uuid covers every quote in the response.
 */
const CAPTURED_RESPONSE = {
  quotes: [
    {
      baseCharge: 9.31,
      carrierName: "Canada Post",
      currency: "CAD",
      customsCharges: null,
      fuelSurcharge: 3.73,
      fuelSurchargePercentage: 40.05,
      modeTransport: "GROUND",
      remarks: "",
      serviceId: 5000026,
      serviceName: "Expedited",
      surcharges: null,
      taxes: [{ amount: 1.7, name: "HST" }],
      totalCharge: 14.74,
      totalChargedAmount: 14.74,
      totalCustomsCharges: 0,
      transitDays: "1",
    },
    {
      baseCharge: 44.16,
      carrierName: "Canpar",
      currency: "CAD",
      serviceId: 5000123,
      serviceName: "Ground",
      totalCharge: 58.33,
      totalChargedAmount: 58.33,
      transitDays: "2",
    },
  ],
  uuid: "a58c4cb3-7b17-441c-978f-e3b31fe2dd51",
  warnings: ["Day & Ross: Carrier supports only Pallet for shipment"],
};

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

function main() {
  console.log("=== the request the provider actually reads ===");
  const wire = buildQuoteRequest(request([parcel(60, 40, 30, 10)]), new Date("2026-09-26T00:54:00Z"));
  console.log(JSON.stringify(wire, null, 2).split("\n").map((l) => "  " + l).join("\n"));

  check("from" in wire && "to" in wire, "addresses are sent as from/to", "the names the API defines");
  check(
    !("shipFrom" in wire) && !("shipTo" in wire),
    "and not as shipFrom/shipTo, which the API ignores without complaint"
  );
  check(wire.from.address1 === "994 Westport Cres, Unit 7A", "address1 carries the street and unit", wire.from.address1);
  check(!("address" in wire.from), "and `address` is not sent, because the API has no such field");
  check(wire.from.zip === "L5T 1G1", "the postal code goes in `zip`", wire.from.zip);
  check(
    !("postalCode" in wire.from),
    "and not in `postalCode`, which the API drops -- the carriers rated a default 00000 because of it"
  );
  check(
    wire.from.attention === "MoonVella Warehouse",
    "the contact name goes in `attention`",
    "the Address type has no `name` property"
  );

  check(wire.packagingUnit === "METRIC", "packagingUnit is the canonical enum member", wire.packagingUnit);
  check(
    wire.scheduledShipDate === "2026-09-26 00:54",
    "the ship date is `yyyy-MM-dd HH:mm`",
    `"${wire.scheduledShipDate}"`
  );
  const shape = wire.packages;
  check(Array.isArray(shape.packages), "parcels are nested under packages.packages, not sent as a bare array");
  check(shape.type === "Package", "the package type is declared", shape.type);
  check(
    shape.packages[0].dimensionUnit === "CM" && shape.packages[0].weightUnit === "KG",
    "parcels carry the unit tokens proven to price in centimetres and kilograms"
  );
  check(
    !("declaredValue" in wire) && !("insurance" in wire),
    "declared value and insurance are NOT sent",
    "this API has no such field under any name; they are carried internally and are not transmittable here"
  );

  console.log("\n=== parcels ===");
  check(
    buildQuoteRequest(request([parcel(30, 20, 20, 5, 3)]), new Date()).packages.packages.length === 3,
    "`count` becomes that many enumerated parcels",
    "the API takes parcels individually, not as a count"
  );
  check(
    buildQuoteRequest(request([parcel(1, 1, 1, 1), parcel(2, 2, 2, 2)]), new Date()).packages.packages.length === 2,
    "two different parcels stay two parcels"
  );

  console.log("\n=== units are refused, not coerced ===");
  let refusal = "";
  try {
    buildQuoteRequest(request([{ ...parcel(30, 20, 20, 5), units: "in_lb" }]), new Date());
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  check(
    /in_lb/.test(refusal) && /silently defaults/.test(refusal),
    "a unit the app does not store is refused before it reaches the wire",
    "the provider defaults an unknown unit silently, so a wrong one would be priced without complaint"
  );

  let emptyRefusal = "";
  try {
    buildQuoteRequest(request([]), new Date());
  } catch (error) {
    emptyRefusal = error instanceof Error ? error.message : String(error);
  }
  check(/at least one parcel/.test(emptyRefusal), "an empty parcel list is refused", emptyRefusal.slice(0, 80));

  console.log("\n=== the response is read by its real names ===");
  const quotes = normalizeRates(CAPTURED_RESPONSE, CAPTURED_RESPONSE.uuid);
  check(quotes.length === 2, "both quotes are read", `${quotes.length}`);
  check(
    quotes[0].totalAmount === 1474,
    "the price comes from `totalCharge`, not the absent `total`",
    `${quotes[0].totalAmount} cents from 14.74`
  );
  check(quotes.every((q) => q.totalAmount > 0), "no quote prices at zero");
  check(quotes[0].carrier === "Canada Post", "the carrier comes from `carrierName`", quotes[0].carrier);
  check(quotes[0].serviceName === "Expedited", "the service name is read", quotes[0].serviceName);
  check(
    quotes[0].serviceCode === "5000026",
    "the service handle comes from the numeric `serviceId`",
    "there is no `serviceCode` in the response, and a booking names this handle"
  );
  check(
    quotes.every((q) => q.providerQuoteId === CAPTURED_RESPONSE.uuid),
    "every quote carries the envelope's uuid as its booking handle",
    "one uuid covers the whole response; it is not a per-quote field"
  );
  check(quotes[0].transitDays === 1, "transit days are coerced from the string the API sends", `${quotes[0].transitDays}`);
  check(quotes[0].currency === "CAD", "the currency is read", quotes[0].currency);

  console.log("\n=== a response with no id is not given one ===");
  const orphans = normalizeRates({ quotes: [CAPTURED_RESPONSE.quotes[0]] }, null);
  check(
    orphans[0].providerQuoteId === null,
    "an absent quote id stays null rather than being invented",
    "booking refuses a quote with no id instead of guessing one"
  );

  console.log(`\n=== ${passed}/${passed + failed} checks passed ===`);
  if (failed) process.exit(1);
}

main();
