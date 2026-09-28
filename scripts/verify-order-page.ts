/**
 * The order page's Packages card, over HTTP, against the running app.
 *
 * WHY THIS EXISTS SEPARATELY. `verify-packaging.ts` proves the resolver: that an
 * order with no parcel rows and an item whose variant carries packaging comes
 * back `source: "variant"` with nothing missing. It cannot see a page. The
 * defect this suite pins was not in the resolver at all — the resolver was right
 * and the screen asked the operator to type the dimensions anyway, because the
 * card decided what to say from `order.packages.length` instead of from the
 * answer the quote path actually uses.
 *
 * That is the failure mode worth a screen test: every service agrees the order
 * is quotable, and the operator is told it is not. Nothing throws, no log line
 * appears, and the way it is found is somebody typing numbers that already exist
 * — which is how it was found. The numbers they type are also the ones a carrier
 * is later billed against, so "just fill it in" is not a harmless workaround.
 *
 * IT NEEDS A RUNNING SERVER AND AN ADMIN ACCOUNT, provided by the harness that
 * calls it (see `docker/verify-http.sh` in the deployment notes).
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-order-page.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = process.env.APP_BASE || "http://localhost:62259";
const EMAIL = process.env.OWNER_EMAIL || "";
const PASSWORD = process.env.OWNER_PASSWORD || "";
const SUFFIX = Date.now().toString(36).toUpperCase();

/**
 * The carton the fixture item carries, in inches and pounds.
 *
 * Deliberately imperial: the page must show the operator the measurement the
 * system will send, which is the CONVERTED one, and a fixture already in cm
 * would pass whether or not the conversion ran. These are the numbers on the
 * demo pillow that started this — 8x8x16 in, 6 lb — so a regression here is the
 * reported defect returning rather than a number somebody picked.
 */
const CARTON = { length: 8, width: 8, height: 16, grossWeight: 6, dimensionUnit: "in", weightUnit: "lb" };
/** 20.32 x 20.32 x 40.64 cm, 2.722 kg — the same rounding the quote path applies. */
const QUOTED = { length: 20.32, width: 20.32, height: 40.64, weight: 2.722 };

let failures = 0;
let total = 0;

/** Numbered like the acceptance suite: a check cannot be dropped unnoticed. */
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${total}. ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
  });
  const cookies: string[] = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function get(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, html: await res.text() };
}

/**
 * The Packages card, out of a page that draws a dozen of them.
 *
 * Read as a slice rather than from the whole document, for the reason the editor
 * suite gives: "this page contains the words" is a weaker claim than "this card
 * contains the words", and the difference is where a false pass hides — the
 * quote card below it also talks about parcels.
 */
function packagesCard(html: string): string {
  const start = html.indexOf(">Packages</h2>");
  if (start < 0) return "";
  // To the heading of the card that follows it, whose words are the ones a
  // whole-page read would confuse these for.
  const next = html.indexOf(">Collection", start);
  const card = html.slice(start, next > start ? next : start + 4000);
  /*
   * React writes `<!-- -->` between two adjacent text nodes, so an interpolated
   * figure arrives as `20.32<!-- -->×<!-- -->20.32`. A browser shows neither the
   * marker nor a gap, and a check that matched the markup instead of the page
   * would fail on a card that renders correctly — which is exactly what it did
   * before this line existed.
   */
  return card.replace(/<!-- -->/g, "");
}

/** The Book shipment button's own tag, so its disabled state is read off it. */
function bookButton(html: string): string {
  const match = html.match(/<button[^>]*value="book_shipment"[^>]*>/);
  return match?.[0] ?? "";
}

const created: { sellerId?: string; productIds: string[]; orderIds: string[] } = { productIds: [], orderIds: [] };

async function makeSeller() {
  const seller = await prisma.seller.create({
    data: {
      shopDomain: `verify-order-page-${SUFFIX}.myshopify.com`,
      shopDomainFull: `verify-order-page-${SUFFIX}.myshopify.com`,
      storeName: `Verify Order Page ${SUFFIX}`,
      contactEmail: `verify-order-page-${SUFFIX}@mvverify.invalid`,
      status: "APPROVED",
    },
  });
  created.sellerId = seller.id;
  return seller;
}

/**
 * A product sold in one configuration, with a carton on the variant.
 *
 * The variant carries an option pair on purpose: a product with no options keeps
 * its carton on the PRODUCT, and the resolver reads the two shapes in different
 * places. The reported defect happened on the variant shape, so that is the one
 * built here.
 */
async function makeItem(withPackaging: boolean) {
  const product = await prisma.product.create({
    data: { name: `Verify Order Page ${SUFFIX}${withPackaging ? "" : " (bare)"}`, productCode: `VERIFY-OP-${SUFFIX}-${withPackaging ? "A" : "B"}`, category: "Verification" },
  });
  created.productIds.push(product.id);
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: `VERIFY-OP-${SUFFIX}-${withPackaging ? "A" : "B"}`,
      name: "Standard",
      wholesalePrice: 1299,
      suggestedRetailPrice: 4900,
      inventory: 10,
      isDefault: true,
      variantOptions: { create: [{ name: "Size", value: "Standard", sortOrder: 0 }] },
    },
  });
  if (withPackaging) {
    await prisma.variantPackage.create({
      data: {
        variantId: variant.id,
        label: "Fixture carton",
        packageType: "carton",
        length: CARTON.length,
        width: CARTON.width,
        height: CARTON.height,
        dimensionUnit: CARTON.dimensionUnit,
        grossWeight: CARTON.grossWeight,
        weightUnit: CARTON.weightUnit,
        unitsPerPackage: 1,
        packagesPerUnit: 1,
        sortOrder: 0,
      },
    });
  }
  return { product, variant };
}

/**
 * An order carrying exactly one line, with NO parcel rows on the order.
 *
 * That absence is the fixture's whole point: it is the state the reported defect
 * was misread from. The seller is left unmapped to any dock, so the page's
 * origin resolution finds nothing — which is what makes the Book button's
 * disabled state checkable without standing up the whole Odoo mapping chain.
 * Packaging and origin are independent questions and the checks below keep them
 * apart on purpose.
 */
async function makeOrder(sellerId: string, variantId: string, sku: string) {
  const order = await prisma.order.create({
    data: {
      sellerId,
      shopifyOrderId: `verify-op-${SUFFIX}-${sku}`,
      shopifyOrderName: `#VERIFY-${SUFFIX}`,
      shopifyOrderNumber: 1,
      customerName: "Verify Customer",
      shippingAddress: JSON.stringify({
        first_name: "Verify",
        last_name: "Customer",
        address1: "110 Laurier Avenue West",
        city: "Ottawa",
        province_code: "ON",
        country_code: "CA",
        zip: "K1P 1J1",
      }),
      subtotal: 1299,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: 1299,
      moonvellaSubtotal: 1299,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: 1299,
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      paymentStatus: "PAID",
      // SUCCEEDED is what un-disables the Book button's payment half, so the
      // disabled state read below is about the address gates and nothing else.
      wholesalePaymentStatus: "SUCCEEDED",
      state: "IN_FULFILLMENT",
      supplierReference: `VERIFY-OP-${SUFFIX}-${sku}`,
      items: {
        create: [
          {
            shopifyLineItemId: `verify-op-line-${SUFFIX}-${sku}`,
            name: "Verify Order Page Item",
            sku,
            quantity: 1,
            price: 1299,
            wholesalePrice: 1299,
            totalDiscount: 0,
            variantId,
          },
        ],
      },
    },
  });
  created.orderIds.push(order.id);
  return order;
}

async function cleanup() {
  try {
    if (created.orderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } });
    }
    if (created.sellerId) {
      await prisma.seller.deleteMany({ where: { id: created.sellerId } });
    }
    for (const productId of created.productIds) {
      await prisma.variantPackage.deleteMany({ where: { variant: { productId } } });
      await prisma.productVariant.deleteMany({ where: { productId } });
      await prisma.product.deleteMany({ where: { id: productId } });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const cookie = await login();

  const seller = await makeSeller();
  const packaged = await makeItem(true);
  const bare = await makeItem(false);
  const goodOrder = await makeOrder(seller.id, packaged.variant.id, packaged.variant.sku);
  const bareOrder = await makeOrder(seller.id, bare.variant.id, bare.variant.sku);

  /* ---------------------------------------------------------------- */
  /* 1. An order the system can already describe is not asked to       */
  /* ---------------------------------------------------------------- */
  const page = await get(`/admin/orders/${goodOrder.id}`, cookie);
  check("the order page renders", page.status === 200, `HTTP ${page.status}`);

  const card = packagesCard(page.html);
  check("the Packages card is on the page", card.length > 0);

  // The defect, in its own words. An operator reading this sentence on an order
  // whose carton is already recorded is being sent to type it again.
  check(
    "the card no longer asks for dimensions that already exist",
    !card.includes("Add package dimensions and weight before quoting"),
  );

  const absent = await get(`/admin/orders/does-not-exist-${SUFFIX}`, cookie);
  check("a missing order is a 404, not a page that looks empty", absent.status === 404, `HTTP ${absent.status}`);

  /* ---------------------------------------------------------------- */
  /* 2. It says what will be sent, in the units the carrier is billed  */
  /* ---------------------------------------------------------------- */
  // Converted, not as stored: this is the figure the rate request carries, and
  // the fixture is imperial so a page that printed the stored numbers would
  // report 8x8x16 here rather than passing.
  check(
    "the card shows the parcel the quote path will send, converted",
    card.includes(`${QUOTED.length}×${QUOTED.width}×${QUOTED.height} cm`) && card.includes(`${QUOTED.weight} kg`),
    card.match(/\d+(\.\d+)?×\d+(\.\d+)?×\d+(\.\d+)? cm, [\d.]+ kg/)?.[0] ?? "(no parcel line found)",
  );
  check(
    "the card names where those parcels come from",
    card.includes("from the packaging stored on the ordered items"),
  );

  /* ---------------------------------------------------------------- */
  /* 3. A genuinely incomplete order still says so, and says which     */
  /* ---------------------------------------------------------------- */
  // The twin. Removing the false warning must not remove the true one: an order
  // whose item has no carton has to be refused with the SKU named, or the fix
  // trades a wrong message for silence.
  const barePage = await get(`/admin/orders/${bareOrder.id}`, cookie);
  const bareCard = packagesCard(barePage.html);
  check("the incomplete order's page renders", barePage.status === 200, `HTTP ${barePage.status}`);
  check(
    "an order with no resolvable packaging is still refused, naming the line",
    bareCard.includes("No packaging could be resolved") && bareCard.includes(bare.variant.sku),
    bareCard.slice(0, 220),
  );
  check(
    "and it does not claim a parcel it cannot describe",
    !bareCard.includes(`${QUOTED.length}×${QUOTED.width}×${QUOTED.height} cm`),
  );

  /* ---------------------------------------------------------------- */
  /* 4. An address verdict is not what holds the button                */
  /* ---------------------------------------------------------------- */
  /*
   * WHAT THIS USED TO SAY. This section asserted the opposite: that the button
   * was disabled while an address verdict was outstanding, and that the page
   * said so in the words "Booking is blocked until every address on the label is
   * accepted". The owner has withdrawn that rule — booking takes the seller's
   * address as supplied and refuses only for the fields a carrier needs — so the
   * assertion is inverted rather than dropped, and the fixture is unchanged:
   * this order has NO verdicts recorded for either end, which is the state every
   * Shopify order arrives in.
   *
   * The button IS disabled here, and the page IS saying why — but the reason it
   * gives is the quote, not an address. That distinction is the check: an
   * operator reading an address-shaped excuse on a page whose addresses are
   * perfectly sendable has been taught to go and satisfy a validator the carrier
   * never asked about.
   */
  const button = bookButton(page.html);
  check("the Book shipment button is on the page", button.length > 0, button.slice(0, 120));
  check("and it is disabled, because no service has been selected", button.includes("disabled"));
  check(
    "and the reason the page gives is the quote",
    page.html.includes("Request shipping quotes, then select a service, before booking."),
  );
  check(
    "and the address card says in as many words that it does not block booking",
    page.html.includes("these checks do not block booking"),
  );
  check(
    "and no address verdict is described as holding the button",
    !page.html.includes("Booking is blocked until every address on the label is accepted") &&
      !page.html.includes("Booking needs every address below accepted"),
  );

  /* ---------------------------------------------------------------- */
  /* 5. A booking needs a live quote, and the page says so             */
  /* ---------------------------------------------------------------- */
  /*
   * The same rule `bookShipmentForOrder` applies, drawn from the same facts.
   * This order has never been quoted, so there is nothing selected to buy — the
   * state a failed or empty quote response also leaves behind, which is why the
   * button must not be offered for it.
   */
  check(
    "an unquoted order is told a service has to be chosen",
    page.html.includes("Request shipping quotes, then select a service, before booking"),
  );

  // The twin: a quote that is selected but past its expiry. The page has to
  // change its answer, because "select a service" is the wrong instruction for
  // an operator who has already selected one.
  await prisma.shippingQuote.create({
    data: {
      orderId: goodOrder.id,
      originLocationId: null,
      provider: "eshipper",
      carrier: "Canada Post",
      serviceCode: "5000026",
      serviceName: "Expedited",
      providerQuoteId: `verify-op-quote-${SUFFIX}`,
      totalAmount: 1474,
      currency: "CAD",
      selected: true,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  const expiredPage = await get(`/admin/orders/${goodOrder.id}`, cookie);
  check("the expired-quote page renders", expiredPage.status === 200, `HTTP ${expiredPage.status}`);
  check(
    "and the page asks for a re-quote rather than for a selection",
    expiredPage.html.includes("The selected quote has expired. Request quotes again and select a fresh one."),
  );
  /*
   * The button's DISABLED state is deliberately not asserted in this section.
   * This fixture's seller is mapped to no dock, so `bookingGatesOpen` is false
   * and the button is disabled whatever the quote says — a check written here
   * would pass for a reason that has nothing to do with the quote. The quote
   * gate is pinned where it can be isolated: `verify-booking.ts` books with no
   * selection and with an expired one and asserts the carrier is never called.
   */

  console.log(`\n${total - failures}/${total} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanup);
