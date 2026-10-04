import { readFileSync } from "node:fs";

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

const ordersQueue = read("app/routes/admin.orders.tsx");
const orderPage = read("app/routes/admin.orders_.$id.tsx");
const shipmentPage = read("app/routes/admin.shipping_.$shipmentId.tsx");
const shipmentsList = read("app/routes/admin.shipping.tsx");
const pickups = read("app/routes/admin.pickups.tsx");
const returns = read("app/routes/admin.returns.tsx");
const claims = read("app/routes/admin.claims.tsx");
const rateSelection = read("app/components/RateSelection.tsx");
const bookingConfirmation = read("app/components/BookingConfirmation.tsx");
const fulfillment = read("app/services/fulfillment.server.ts");
const eshipper = read("app/services/eshipper.server.ts");
const shippingOps = read("app/services/shippingOperations.server.ts");
const shopifyAppToml = read("shopify.app.toml");

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
  "next action is derived from stored order and shipment state",
  [
    "Collect seller payment",
    "Select rate / book label",
    "Reconcile booking",
    "Pack order",
    "Hand to carrier",
    "Carrier tracking",
    "Delivered",
    "Cancelled",
  ].every((label) => ordersQueue.includes(`"${label}"`)),
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
  [orderPage, shipmentPage, shipmentsList].every(
    (source) =>
      !source.includes("add_package") && !source.includes("remove_package") && !source.includes("Add parcel"),
  ),
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
  read("app/routes/app.orders.jsx").includes("newly required permissions") &&
    read("app/services/shopifyFulfillment.server.ts").includes("approve the newly required scopes"),
);

const failures = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
process.exit(failures.length ? 1 : 0);
