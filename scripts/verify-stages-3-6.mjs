import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* global process */

/*
 * STAGES 3–6 OF THE ADMIN REDESIGN, CHECKED AS ONE PIECE.
 *
 * The redesign's promises are mostly negative — what a page MAY NOT offer —
 * and a negative is exactly what a screenshot review misses. So this reads the
 * source and asserts both halves: the shared shell, the one dialog, the one
 * booking path are present, and the manual parcel forms, the Google address
 * verdicts, the later-status controls and the direct booking posts are gone.
 *
 * Reading source rather than rendering has a known blind spot: it cannot tell
 * whether a control LOOKS right, only that it is still the same control. The
 * browser-only checks are listed in the handoff for exactly that reason.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Every .ts/.tsx/.js/.jsx file under app/, comments stripped.
 *
 * Comments go because the sweep below is a "this call is ABSENT" rule, and a
 * comment that quotes the illegal call — the exact fixture the fulfillment-scopes
 * suite injects on purpose — would otherwise read as a live one. Strings stay:
 * the handle being searched for is a string literal, so a stripper that ate
 * strings would find nothing and pass while the call sat there.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function appSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(stripComments(readFileSync(full, "utf8")));
    }
  };
  walk(fileURLToPath(new URL("../app", import.meta.url)));
  return out;
}

const ordersQueue = read("app/routes/admin.orders.tsx");
const shippingLogic = read("app/services/shippingLogic.ts");
const orderPage = read("app/routes/admin.orders_.$id.tsx");
const shipmentPage = read("app/routes/admin.shipping_.$shipmentId.tsx");
const shipmentsList = read("app/routes/admin.shipping.tsx");
const pickups = read("app/routes/admin.pickups.tsx");
const packingPage = read("app/routes/admin.packing.$orderId.tsx");
const returns = read("app/routes/admin.returns.tsx");
const claims = read("app/routes/admin.claims.tsx");
const rateSelection = read("app/components/RateSelection.tsx");
const bookingConfirmation = read("app/components/BookingConfirmation.tsx");
const fulfillment = read("app/services/fulfillment.server.ts");
const eshipper = read("app/services/eshipper.server.ts");
const shippingOps = read("app/services/shippingOperations.server.ts");
const shopifyAppToml = read("shopify.app.toml");
const ordersApp = read("app/routes/app.orders.jsx");

const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

/* ---------------------------------------------------------------- Stage 3 */

check(
  "orders queue uses the shared admin shell",
  ordersQueue.includes('className="mv-page-wide"') &&
    ordersQueue.includes('className="mv-page-header"') &&
    ordersQueue.includes('className="mv-panel"'),
);
check(
  "orders queue columns are the redesign's seven",
  ["Order", "Seller", "Customer", "Seller payment", "Next action", "Shipping", "Open"].every((c) =>
    ordersQueue.includes(`<th>${c}</th>`),
  ),
);
check(
  "queue filters are a GET form over stored order state",
  ordersQueue.includes("<Form method=\"get\"") &&
    ordersQueue.includes("mv-filter-bar") &&
    ordersQueue.includes('name="state"') &&
    ordersQueue.includes('name="seller"') &&
    ordersQueue.includes('name="payment"'),
);
check(
  "next action is derived from stored order and shipment state, in one shared rule",
  [
    "Collect seller payment",
    "Select rate / book label",
    "Reconcile booking",
    "Pack order",
    "Hand to carrier",
    "Carrier tracking",
    "Delivered",
    "Cancelled",
  ].every((label) => shippingLogic.includes(`"${label}"`)) &&
    ordersQueue.includes("nextQueueAction(") &&
    ordersQueue.includes('from "~/services/shippingLogic"'),
);
check(
  "the queue's action for a booking already under way is a statement, never a door",
  shippingLogic.includes('"Booking in progress"') &&
    /label: "Booking in progress", tone: "warning" \}/.test(shippingLogic) &&
    shippingLogic.includes('"Retry failed booking"') &&
    shippingLogic.includes('"Reconcile booking"'),
);
check(
  "a queue action that IS a door carries the shipment it opens",
  /to: `\/admin\/shipping\/\$\{shipment\.id\}`/.test(shippingLogic) &&
    ordersQueue.includes("<Link to={next.to}") &&
    ordersQueue.includes("NEXT_ACTION_CLASS[next.tone]"),
);
check(
  "the Shopify customer payment is labelled as the store's, not the seller's",
  ordersQueue.includes("Shopify: {o.paymentStatus}") &&
    ordersQueue.includes("o.wholesalePayment?.status ?? o.wholesalePaymentStatus"),
);
check("the queue offers one obvious open action", />\s*Open\s*<\/Link>/.test(ordersQueue));

/* ---------------------------------------------------------------- Stage 4 */

check(
  "order page uses the shared admin shell",
  orderPage.includes('className="mv-page-wide"') &&
    orderPage.includes('className="mv-page-header"') &&
    orderPage.includes('className="mv-actions"'),
);
check(
  "order page offers Get shipping rates beside the workflow",
  orderPage.includes("Get shipping rates"),
);
check(
  "rate selection is one shared dialog with Cancel and Confirm",
  rateSelection.includes("mv-rate-overlay") &&
    rateSelection.includes("mv-rate-dialog-footer") &&
    rateSelection.includes("Cancel") &&
    rateSelection.includes("Confirm rate"),
);
check(
  "order and shipment pages choose rates through the same component",
  orderPage.includes('from "~/components/RateSelection"') &&
    shipmentPage.includes('from "~/components/RateSelection"') &&
    /<RateSelection\b/.test(orderPage) &&
    /<RateSelection\b/.test(shipmentPage),
);
check(
  "selecting a rate never purchases — the dialog posts only the selection",
  rateSelection.includes('name="intent" value="select_quote"') &&
    !rateSelection.includes("book_shipment"),
);
check(
  "exactly one booking submit surface exists",
  (bookingConfirmation.match(/value="book_shipment"/g) ?? []).length === 1 &&
    !orderPage.includes('name="intent" value="book_shipment"') &&
    !shipmentPage.includes('name="intent" value="book_shipment"'),
);
check(
  "no manual package entry or removal remains on the workflow pages",
  [orderPage, shipmentPage, shipmentsList, packingPage].every(
    (source) =>
      !source.includes("add_package") && !source.includes("remove_package") && !source.includes("Add parcel"),
  ),
);
check(
  "the packing page shows the order's parcels read-only and writes none",
  packingPage.includes("READ-ONLY") &&
    !packingPage.includes("add_variant_package") &&
    !packingPage.includes("name=\"count\"") &&
    !packingPage.includes("name=\"weight\"") &&
    packingPage.includes("getVariantPackages"),
);
check(
  "the packing page's own Mark packed control is drawn from the same matrix the server enforces",
  packingPage.includes('availableWarehouseEvents(s).includes("packed")') &&
    packingPage.includes("handedToCarrierAt: s.handedToCarrierAt"),
);
check(
  "a second booking cannot be started from the order page",
  orderPage.includes("orderBookingGate(") &&
    orderPage.includes("bookPreparedShipment(") &&
    /gate\.kind === "blocked"/.test(orderPage) &&
    /throw new Error\(gate\.refusal\)/.test(orderPage),
);
check(
  "the booking gate and the server read the same shipped set",
  shippingLogic.includes("export function orderBookingGate") &&
    shippingLogic.includes("export function shipmentMayBeBooked") &&
    shippingLogic.includes("providerShipmentId") &&
    orderPage.includes("status: { not: \"CANCELLED\" }") &&
    shipmentPage.includes("shipmentMayBeBooked(shipment)"),
);
check(
  "a shipped, excepted, delivered or cancelled parcel offers no warehouse milestone",
  shippingLogic.includes("export function availableWarehouseEvents") &&
    shippingLogic.includes("export function advanceRefusal") &&
    [orderPage, shipmentPage, shipmentsList].every((source) => source.includes("availableWarehouseEvents(s")),
);
check(
  "the server enforces the milestone order, not just the pages that draw it",
  fulfillment.includes("advanceRefusal(") &&
    fulfillment.includes("prisma.shipment.updateMany(") &&
    fulfillment.includes("packedAt: null") &&
    /status: "BOOKED", packedAt: \{ not: null \}/.test(fulfillment),
);
check(
  "packaging is resolved from the order, variants and products",
  orderPage.includes("buildQuotePackagesForOrder") &&
    shipmentPage.includes("packagesForShipment") &&
    shipmentPage.includes("SHIPMENT_PARCEL_SOURCE"),
);
check(
  "no Google address-validation controls remain on the workflow pages",
  [orderPage, shipmentPage, shipmentsList].every(
    (source) =>
      !source.includes("addressValidation") &&
      !source.includes("AddressGateCard") &&
      !source.includes("check_address") &&
      !source.includes("apply_suggestion") &&
      !source.includes("override_address"),
  ),
);
check(
  "carrier-required address fields are still refused by name",
  eshipper.includes("export function carrierAddressProblems"),
);
check(
  "operators may record only packed and handed to carrier",
  shipmentsList.includes('const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = ["packed", "handed_to_carrier"]') &&
    shipmentPage.includes('const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = ["packed", "handed_to_carrier"]') &&
    orderPage.includes('const allowed: ShipmentAdvanceEvent[] = ["packed", "handed_to_carrier"]'),
);
check(
  "later-status controls are absent from every shipment surface",
  [orderPage, shipmentPage, shipmentsList].every(
    (source) =>
      !source.includes('value="shipped"') &&
      !source.includes('value="in_transit"') &&
      !source.includes('value="delivered"') &&
      !source.includes('value="exception"'),
  ),
);
check(
  "handoff notification follows the stored preference unless overridden",
  fulfillment.includes("opts?.notifyCustomer ?? shipment.notifyCustomerOnPush") &&
    shipmentPage.includes('name="notifyCustomer"') &&
    shipmentPage.includes("notifyCustomerOnPush"),
);
check(
  "label and packing-slip controls exist on both workflow pages",
  orderPage.includes("View label") &&
    orderPage.includes("Print packing slip") &&
    shipmentPage.includes("Download shipping label") &&
    shipmentPage.includes("Print packing slip"),
);
check(
  "the order timeline is readable activity with technical details underneath",
  orderPage.includes("ACTIVITY_TEXT") &&
    orderPage.includes("humanizeAction") &&
    orderPage.includes("Technical details"),
);
check(
  "pickup scheduling stays separate from label booking",
  shipmentPage.includes('name="intent" value="schedule_pickup"') &&
    shipmentPage.includes("disabled={!shipment.providerShipmentId") &&
    shipmentPage.includes("oneOffAtRegularDock"),
);

/* ---------------------------------------------------------------- Stage 5 */

check(
  "shipping list, pickups, returns and claims share one workspace shell",
  [shipmentsList, pickups, returns, claims].every(
    (source) => source.includes("mv-page-wide") && source.includes("ShippingOperationsNav"),
  ),
);
check(
  "returns remain approval records while return purchasing is disabled",
  eshipper.includes("export const RETURN_PURCHASING_ENABLED = false;") &&
    eshipper.includes("assertReturnPurchasingEnabled") &&
    shipmentPage.includes("returnPurchasing.enabled"),
);
check(
  "claims require the carrier's own claim number before SUBMITTED",
  shippingOps.includes('input.status === "SUBMITTED" && !carrierClaimNumber') &&
    claims.includes('name="carrierClaimNumber"'),
);

/* ---------------------------------------------------------------- Stage 6 */

check(
  "write_fulfillments and write_locations are required scopes",
  /^scopes = ".*write_fulfillments.*write_locations.*"$/m.test(shopifyAppToml),
);
check("neither required scope is duplicated as an optional scope", /^optional_scopes = \[\]$/m.test(shopifyAppToml));
check(
  "an older installation is told to approve the newly required permissions",
  ordersApp.includes("newly required permissions") &&
    read("app/services/shopifyFulfillment.server.ts").includes("approve the newly required scopes"),
);
check(
  "the old in-app grant request is gone, and the card says where approval really happens",
  ordersApp.includes('value="recheck_fulfillment_scopes"') &&
    !ordersApp.includes("grant_fulfillment_scopes") &&
    ordersApp.includes("Check again") &&
    ordersApp.includes("app-update flow"),
);
check(
  "no required scope is passed to a dynamic scope request, and the detector can fail",
  (() => {
    const requiredScopes = ["write_fulfillments", "write_locations"];
    // The same rule the fulfillment-scopes suite applies, kept here too because
    // this is the stage that declares them required: Shopify accepts a dynamic
    // `scopes.request()` only for OPTIONAL scopes, so naming a required one is
    // a call that cannot succeed.
    const offending = (source) => {
      const needle = "scopes.request(";
      const hits = [];
      for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
        let i = at + needle.length;
        let depth = 1;
        let args = "";
        while (i < source.length && depth > 0) {
          const ch = source[i];
          if (ch === "(") depth += 1;
          else if (ch === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
          args += ch;
          i += 1;
        }
        if (/FULFILLMENT_SCOPES/.test(args)) hits.push(args.trim());
        for (const scope of requiredScopes) if (args.includes(`"${scope}"`)) hits.push(args.trim());
      }
      return hits;
    };
    const selfTest =
      offending('await scopes.request(["write_fulfillments"]);').length === 1 &&
      offending("await scopes.request([...FULFILLMENT_SCOPES]);").length === 1 &&
      offending('await scopes.request(["write_discounts"]);').length === 0;
    const live = appSources().filter((source) => offending(source).length > 0);
    return selfTest && live.length === 0;
  })(),
);

const failures = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
process.exit(failures.length ? 1 : 0);
