/**
 * Two defects, driven over HTTP against a running app.
 *
 * DEFECT 1 — A PARCEL OF ZERO IS A PARCEL THAT GETS PRICED.
 * A carrier accepts whatever dimensions it is handed and answers with a number,
 * so a carton of length 0 does not fail: it becomes a quote for a parcel that
 * does not exist, and then a label. The rule therefore lives at the write, not
 * on each form, and this suite proves it at every door a parcel can come
 * through — the order page, the packing page's per-variant row (the one write
 * that does not go through `addOrderPackage`), and the shipping page's own
 * form. Each refusal is checked against the DATABASE, not against a status
 * code: what must be true is that no row was written.
 *
 * DEFECT 2 — THE UPLOADER WAS ANSWERED WITH HTML.
 * The batch uploader is the app's only raw XHR. It posted the file to the
 * page's own path, and React Router chooses between "run the action and answer
 * with its result" and "run the action, then render a whole document" by one
 * test — whether the pathname ends in `.data` — reading no header at all. So
 * every upload stored its file and answered with HTML the component could not
 * parse: the card reported failure, the queue never drained, and the retry
 * found its own upload already there as a duplicate.
 *
 * Both halves of that are checked here. The server half is driven for real: a
 * multipart POST answers JSON at the `.data` twin, and answers a DOCUMENT at
 * the page path — which is the root cause, demonstrated rather than described.
 * The client half is asserted from the component's own source, because there is
 * no browser in this environment; see the note at the end of this file for what
 * that does and does not establish.
 *
 * IT NEEDS A RUNNING SERVER, AN ADMIN ACCOUNT, AND THE VERIFY CLONE.
 * The throwaway OWNER account is made by the harness that calls this
 * (deployment/mv-verify-http.sh), never here.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-media-parcels-http.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { ADMIN_SESSION_COOKIE } from "~/utils/adminAuth.server";

const prisma = new PrismaClient();
const BASE = process.env.APP_BASE || "http://localhost:62259";
const EMAIL = process.env.OWNER_EMAIL || "";
const PASSWORD = process.env.OWNER_PASSWORD || "";
const CODE = `VERIFY-MP-${Date.now()}`;
const SHOP = `media-parcels-${Date.now()}.myshopify.com`;

let failures = 0;
let total = 0;

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
  const cookies: string[] =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function post(path: string, cookie: string, data: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
      Cookie: cookie,
    },
    body: new URLSearchParams(data),
  });
  return { status: res.status, body: await res.text() };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const made = { sellerId: "", productIds: [] as string[], orderIds: [] as string[] };

async function cleanup() {
  await prisma.orderPackage.deleteMany({ where: { order: { shopifyOrderId: { startsWith: "mp-" } } } });
  await prisma.shipment.deleteMany({ where: { order: { shopifyOrderId: { startsWith: "mp-" } } } });
  await prisma.order.deleteMany({ where: { shopifyOrderId: { startsWith: "mp-" } } });
  await prisma.product.deleteMany({ where: { productCode: { startsWith: "VERIFY-MP-" } } });
  await prisma.seller.deleteMany({ where: { shopDomain: { startsWith: "media-parcels-" } } });
}

/**
 * An order with the rows its pages expect to find. The shipping page reads the
 * order back through a shipment, so the ordering is: dock, product, variant,
 * seller, order, shipment.
 */
let seq = 0;
async function makeOrder() {
  seq++;
  const location = await prisma.pickupLocation.create({
    data: {
      code: `MP-DOCK-${Date.now()}-${seq}`,
      name: "Media Parcels Verify Dock",
      odooDatabase: "verify_db",
      odooCompanyId: 1,
      odooWarehouseId: 3,
      odooLocationId: 25,
      odooPartnerId: 145,
      contactName: "Dock Receiver",
      contactPhone: "+1 555 0177",
      contactEmail: "mp-dock@example.test",
      street1: "12 Main St",
      city: "Toronto",
      province: "ON",
      postalCode: "M5H 2N2",
      country: "CA",
      timeZone: "America/Toronto",
      pickupOpenTime: "09:00",
      pickupCloseTime: "16:00",
    },
  });

  const product = await prisma.product.create({
    data: {
      name: "Media Parcels Verify Pillow",
      productCode: `${CODE}-P${seq}`,
      category: "Verification",
      pickupLocationId: location.id,
    },
  });
  made.productIds.push(product.id);

  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: `${CODE}-P${seq}-V`,
      name: "Hotel Pillow",
      wholesalePrice: 1299,
      suggestedRetailPrice: 4900,
      inventory: 100,
      isDefault: true,
    },
  });

  const order = await prisma.order.create({
    data: {
      sellerId: made.sellerId,
      shopifyOrderId: `mp-${seq}`,
      shopifyOrderName: `#MP${seq}`,
      shopifyOrderNumber: seq,
      currency: "CAD",
      customerName: "Retail Customer",
      shippingAddress: JSON.stringify({
        name: "Retail Customer",
        address1: "500 Queen St W",
        city: "Toronto",
        province: "ON",
        zip: "M5V 2T6",
        country: "CA",
        residential: true,
      }),
      subtotal: 2598,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: 2598,
      moonvellaSubtotal: 2598,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: 2598,
      paymentStatus: "PAID",
      fulfillmentStatus: "PENDING",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      supplierReference: `${SHOP}#MP${seq}`,
      items: {
        create: [
          {
            name: "Hotel Pillow",
            sku: `${CODE}-P${seq}-V`,
            quantity: 2,
            price: 4900,
            wholesalePrice: 1299,
            totalDiscount: 0,
            shopifyLineItemId: `li${seq}`,
            variantId: variant.id,
          },
        ],
      },
      wholesalePayment: {
        create: {
          sellerId: made.sellerId,
          amount: 2598,
          currency: "CAD",
          provider: "stripe",
          status: "REQUIRES_PAYMENT",
          idempotencyKey: `mp:${seq}`,
        },
      },
      fulfillmentRequest: { create: {} },
    },
  });
  made.orderIds.push(order.id);

  const shipment = await prisma.shipment.create({
    data: { orderId: order.id, status: "PENDING", carrier: null },
  });

  return { order, shipment, variant };
}

/* -------------------------------------------------------------------------- */
/* Defect 1 — parcels                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The doors a parcel can come through, each with the fields its form sends.
 * The order page and the packing page post their own `length`/`weight` etc.;
 * the packing page's variant row posts a `parcels` LIST, because it is the one
 * write that does not go through `addOrderPackage`.
 */
function parcelDoors(orderId: string, shipmentId: string) {
  const valid = { count: "1", length: "40", width: "30", height: "20", weight: "2.5" };
  return [
    { label: "the order page", path: `/admin/orders/${orderId}`, extra: { intent: "add_package", ...valid } },
    { label: "the packing page", path: `/admin/packing/${orderId}`, extra: { intent: "add_package", ...valid } },
    { label: "the shipping page's own form", path: `/admin/shipping/${shipmentId}`, extra: { intent: "add_package", ...valid } },
  ];
}

/** Every refusal must be a refusal in the DATABASE, not just a message. */
async function parcelsRefused(
  cookie: string,
  orderId: string,
  path: string,
  intent: Record<string, string>,
  expect: RegExp,
  what: string
) {
  const before = await prisma.orderPackage.count({ where: { orderId } });
  const res = await post(path, cookie, intent);
  const after = await prisma.orderPackage.count({ where: { orderId } });
  const said = expect.test(res.body);
  check(
    `${what} is refused, and no parcel is stored`,
    after === before && said,
    `rows ${before}→${after}; ${said ? "refusal shown" : "NO REFUSAL IN THE REPLY"}`
  );
}

async function defect1(cookie: string, orderId: string, shipmentId: string, variantId: string) {
  console.log("\n— A parcel of zero, or worse, must never reach the table —");

  for (const door of parcelDoors(orderId, shipmentId)) {
    await parcelsRefused(
      cookie, orderId, door.path,
      { ...door.extra, length: "0" },
      /greater than zero/i,
      `A length of zero on ${door.label}`
    );
    await parcelsRefused(
      cookie, orderId, door.path,
      { ...door.extra, width: "-4" },
      /greater than zero/i,
      `A negative width on ${door.label}`
    );
    await parcelsRefused(
      cookie, orderId, door.path,
      { ...door.extra, height: "abc" },
      /not a number|greater than zero/i,
      `A height that is not a number on ${door.label}`
    );
    await parcelsRefused(
      cookie, orderId, door.path,
      { ...door.extra, weight: "0" },
      /greater than zero/i,
      `A weight of zero on ${door.label}`
    );
    await parcelsRefused(
      cookie, orderId, door.path,
      { ...door.extra, weight: "-2" },
      /greater than zero/i,
      `A negative weight on ${door.label}`
    );
    await parcelsRefused(
      cookie, orderId, door.path,
      { ...door.extra, weight: "" },
      /greater than zero|not a number/i,
      `A missing weight on ${door.label}`
    );
  }

  /*
   * THE PATH THAT BYPASSES `addOrderPackage`.
   *
   * `intent=add_variant_package` does not take a parcel from the form at all.
   * It reads the ORDER ITEM, looks up that variant's packaging rows, converts
   * each one to cm/kg and writes the results — so the numbers it validates were
   * never typed by anybody and can be a zero or a NaN that a stored packaging
   * row produced. That is the case the guard at the top of the branch exists
   * for, and it is the one that has to be exercised by putting a bad figure
   * into a packaging row.
   *
   * AN EARLIER RUN OF THIS SUITE POSTED A `parcels[0][length]` LIST HERE AND
   * CALLED IT THE PER-VARIANT FORM. No such shape exists: the handler reads
   * `orderItemId` and nothing else, so it answered "Order item not found.", the
   * table stayed empty, and the check failed on the refusal text while looking
   * as though the guard were missing. The list is not the request; it is what
   * the SERVER builds. What follows builds it the way the server does.
   */
  const item = await prisma.orderItem.findFirst({ where: { orderId, variantId } });
  if (!item) throw new Error("The order item for the fixture variant is missing.");

  const pkg = await prisma.variantPackage.create({
    data: { variantId, length: 0, width: 30, height: 20, grossWeight: 2.5, unitsPerPackage: 1, packagesPerUnit: 1 },
  });

  await parcelsRefused(
    cookie, orderId, `/admin/packing/${orderId}`,
    { intent: "add_variant_package", orderItemId: item.id },
    /greater than zero/i,
    "A zero length in a packaging row the packing page derives parcels from"
  );

  // THE CONTROL FOR THIS BRANCH. A guard that refused every derived parcel
  // would pass the check above for the wrong reason.
  //
  // ONE ROW, NOT TWO. The branch maps one `OrderPackage` per packaging ROW and
  // records how many boxes that row describes in its `count` column — so an
  // item of two units, one package per unit, is a single row carrying count 2.
  // An earlier run of this suite expected two rows and read a correct reply as a
  // failure.
  await prisma.variantPackage.update({
    where: { id: pkg.id },
    data: { length: 40, width: 30, height: 20, grossWeight: 2.5 },
  });
  const beforeVariant = await prisma.orderPackage.count({ where: { orderId } });
  await post(`/admin/packing/${orderId}`, cookie, { intent: "add_variant_package", orderItemId: item.id });
  const afterVariant = await prisma.orderPackage.count({ where: { orderId } });
  const derived = await prisma.orderPackage.findFirst({ where: { orderId }, orderBy: { id: "desc" } });
  check(
    "And a sound packaging row is still turned into a parcel, counted for both units",
    afterVariant === beforeVariant + 1 && derived?.count === 2 &&
      derived?.length === 40 && derived?.width === 30 && derived?.height === 20 && derived?.weight === 2.5,
    `rows ${beforeVariant}→${afterVariant}; count ${derived?.count}, ${derived?.length} × ${derived?.width} × ${derived?.height}, ${derived?.weight} kg`
  );
  await prisma.variantPackage.delete({ where: { id: pkg.id } });
  await prisma.orderPackage.deleteMany({ where: { orderId } });

  // THE CONTROL. If the guard refused everything, every check above would pass
  // for the wrong reason — so a good parcel must still go in.
  const before = await prisma.orderPackage.count({ where: { orderId } });
  await post(`/admin/orders/${orderId}`, cookie, {
    intent: "add_package", count: "1", length: "40", width: "30", height: "20", weight: "2.5",
  });
  const after = await prisma.orderPackage.count({ where: { orderId } });
  check("A parcel with real measurements is still accepted", after === before + 1, `rows ${before}→${after}`);

  const stored = await prisma.orderPackage.findFirst({ where: { orderId }, orderBy: { id: "desc" } });
  check(
    "And it is stored with the figures that were typed",
    stored?.length === 40 && stored?.width === 30 && stored?.height === 20 && stored?.weight === 2.5,
    `${stored?.length} × ${stored?.width} × ${stored?.height}, ${stored?.weight} kg`
  );
}

/* -------------------------------------------------------------------------- */
/* Defect 2 — the uploader's answer                                            */
/* -------------------------------------------------------------------------- */

/**
 * A tiny but real PNG: the storage layer reads the image header, so a file of
 * the right name and the wrong bytes is refused — which is how the first run of
 * this suite failed against a hand-made "png" of eight bytes.
 *
 * Returned as an ArrayBuffer rather than a Buffer or a Uint8Array view: only a
 * plain ArrayBuffer is unambiguously a BlobPart, and the view types are generic
 * over a buffer that may be shared.
 */
function pngBytes(): ArrayBuffer {
  const source = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const out = new ArrayBuffer(source.length);
  new Uint8Array(out).set(source);
  return out;
}

async function uploadTo(path: string, cookie: string, filename: string) {
  const body = new FormData();
  body.set("intent", "media_upload_batch");
  body.set("tab", "media");
  // A real member of the MediaCategory enum. "PRODUCT_IMAGE" is not one, and
  // the first run of this suite spent its whole upload section being correctly
  // refused for that reason — see the enum in prisma/schema.prisma.
  body.set("category", "WHITE_BACKGROUND_IMAGE");
  body.set("title", "Verify upload");
  body.set("altText", "A one pixel image");
  body.set("scopeMode", "shared");
  body.set("file", new Blob([pngBytes()], { type: "image/png" }), filename);

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: BASE, Cookie: cookie },
    body,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, text, json, type: res.headers.get("content-type") ?? "" };
}

async function defect2(cookie: string, productId: string) {
  console.log("\n— The uploader must be answered with a result, not a page —");

  const pagePath = `/admin/products/${productId}`;
  // The endpoint the uploader actually calls. It is a resource route, which is
  // the only arrangement in this framework where `Response.json` reaches the
  // caller unchanged — see the note in app/routes/admin.products_.$id_.media-batch.tsx
  // for the two encodings that were measured and why neither is JSON.
  const dataPath = `${pagePath}/media-batch`;
  const filename = `verify-mp-${Date.now()}.png`;

  const first = await uploadTo(dataPath, cookie, filename);
  check(
    "The uploader's endpoint answers plain JSON, which is what it parses",
    first.json !== null && first.json.ok === true,
    `${first.type.split(";")[0]} · ${first.text.slice(0, 60)}`
  );
  const assetId = typeof first.json?.assetId === "string" ? first.json.assetId : "";
  check("And names the asset it stored", !!assetId, assetId || "no id in the reply");

  check(
    "The file really is on the product",
    (await prisma.mediaAsset.count({ where: { productId, id: assetId } })) === 1
  );

  /*
   * THE RETRY. A file that was stored but reported as failed is the one a person
   * uploads again, so the second attempt must be refused as a duplicate rather
   * than stored twice — and the refusal must be an ANSWER, not an error status,
   * because the uploader treats a non-2xx as "connection trouble" and offers to
   * retry the thing that can never succeed.
   */
  const again = await uploadTo(dataPath, cookie, filename);
  check(
    "Uploading the same file again is refused as a duplicate, not stored twice",
    again.json !== null && again.json.duplicate === true && again.json.ok === false,
    `HTTP ${again.status} · ${again.text.slice(0, 60)}`
  );
  check(
    "And exactly one asset exists for it",
    (await prisma.mediaAsset.count({ where: { productId, title: { contains: "Verify upload" } } })) === 1
  );
  check(
    "The duplicate names the asset it duplicates, so the uploader can link to it",
    again.json?.assetId === assetId,
    String(again.json?.assetId ?? "none")
  );

  /*
   * THE ROOT CAUSE, DEMONSTRATED. The same multipart POST to the PAGE's own
   * path — which is what the uploader used to send — comes back as a document.
   * This is the defect itself, not a description of it: it is why a JSON.parse
   * of the reply throws, why every file was reported as failed while the asset
   * was in fact stored, and why an `Accept` header could never have fixed it.
   *
   * The `.data` twin was tried first and is worse, not better: it contains no
   * HTML, so `JSON.parse` SUCCEEDS — on the framework's turbo-stream envelope,
   * which is an ARRAY. `answer.ok` is then `undefined`, which is the same
   * "failed" outcome as before, produced by a parse that does not throw. A
   * resource route is the only arrangement that returns the Response verbatim.
   */
  const toPage = await uploadTo(pagePath, cookie, `${filename}.second.png`);
  check(
    "The same upload to the page path answers with a document, not a result",
    toPage.json === null && /<html|<!DOCTYPE/i.test(toPage.text),
    `${toPage.type.split(";")[0] || "no content-type"} · ${toPage.text.slice(0, 40).replace(/\n/g, " ")}`
  );

  // A category that is not on the enum, and a request with none at all. Both
  // must come back as an ANSWER the uploader can parse and show, not as an
  // error status — a non-2xx reads to the uploader as "connection trouble",
  // which offers a retry for something that can never succeed.
  //
  // The second case is the one the old code could not answer: its fallback was
  // `?? "PRODUCT_IMAGE"`, a value that is not on the enum, so a request with no
  // category was turned into a request with an invalid one.
  for (const [what, sent] of [
    ["not on the enum", "PRODUCT_IMAGE"],
    ["missing entirely", ""],
  ] as const) {
    const body = new FormData();
    body.set("intent", "media_upload_batch");
    if (sent) body.set("category", sent);
    body.set("file", new Blob([pngBytes()], { type: "image/png" }), `bad-category-${sent || "none"}.png`);
    const res = await fetch(`${BASE}${dataPath}`, {
      method: "POST", redirect: "manual", headers: { Origin: BASE, Cookie: cookie }, body,
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    check(
      `A category ${what} is refused with a readable reason, as an answer rather than an error status`,
      res.status === 200 && json?.ok === false && typeof json?.error === "string",
      `HTTP ${res.status} · ${String(json?.error ?? text.slice(0, 40))}`
    );
    check(
      `And no asset is stored for a category ${what}`,
      (await prisma.mediaAsset.count({ where: { productId, category: { not: "WHITE_BACKGROUND_IMAGE" } } })) === 0
    );
  }
}

/**
 * The client half, asserted from the source.
 *
 * THERE IS NO BROWSER IN THIS ENVIRONMENT — no chromium, no firefox, and no DOM
 * implementation in the image — so what runs below is a reading of the code, not
 * an execution of it. It establishes that the URL the component builds is the
 * resource route that answers JSON and that the queue is emptied on success; it
 * does NOT establish that a browser renders the result, that the fields visibly
 * reset, or that the drag-and-drop path behaves. Those need a real browser and
 * are reported as not exercised.
 */
function defect2ClientSource() {
  const source = readFileSync(new URL("../app/components/product/BatchUploader.tsx", import.meta.url), "utf8");
  const compact = source.replace(/\s+/g, " ");

  check(
    "The uploader posts to its own resource route, which is the one that answers JSON",
    /xhr\.open\(\s*"POST",\s*`\/admin\/products\/\$\{productId\}\/media-batch`/.test(compact),
    "the page path answered with a document; the `.data` twin answered with the framework's envelope"
  );
  check(
    "It does not post to the page path or to the `.data` twin",
    !/xhr\.open\([^)]*\.data/.test(compact) && !/xhr\.open\(\s*"POST",\s*`\$\{location\.pathname\}`/.test(compact)
  );
  check(
    "It sends the session cookie, so the action can identify the caller",
    /xhr\.withCredentials\s*=\s*true/.test(compact)
  );
  check(
    "A stored file is taken out of the queue, so the run can drain",
    /answer\.ok/.test(compact) && /status: "done"/.test(compact) && /removeCard\(card\.key\)/.test(compact)
  );
  check(
    "A refusal that is not a duplicate is kept, so nothing is silently dropped",
    /status: "failed"/.test(compact)
  );
  check(
    "A duplicate is kept too, and never offered for retry — retrying it could only refuse again",
    /status: "duplicate"/.test(compact) &&
      /row\.status === "failed"\s*\?\s*\{ \.\.\.row, status: "queued"/.test(compact),
    "the Retry control re-queues failures only, so a duplicate cannot be retried"
  );
  check(
    "The form resets only after a clean finish, so typed text is not cleared out from under a failure",
    /if \(cards\.length > 0 \|\| uploaded === 0\) return;/.test(compact)
  );
}

/* -------------------------------------------------------------------------- */

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Set OWNER_EMAIL and OWNER_PASSWORD.");
    process.exit(1);
  }

  await cleanup();

  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      storeName: "Media Parcels Verify Seller",
      shopDomainFull: SHOP,
      contactEmail: "mp@test.example",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });
  made.sellerId = seller.id;

  const cookie = await login();
  check(
    "The throwaway owner can sign in, and the cookie is the app's own",
    cookie.includes(ADMIN_SESSION_COOKIE),
    cookie ? "session issued" : "no cookie"
  );

  const { order, shipment, variant } = await makeOrder();
  await defect1(cookie, order.id, shipment.id, variant.id);

  const product = await prisma.product.create({
    data: {
      name: "Media Parcels Verify Uploads",
      productCode: `${CODE}-MEDIA`,
      category: "Verification",
      variants: {
        create: [{ name: "One size", sku: `${CODE}-MEDIA-1`, wholesalePrice: 1000, suggestedRetailPrice: 2000, isDefault: true }],
      },
    },
  });
  made.productIds.push(product.id);
  await defect2(cookie, product.id);
  defect2ClientSource();

  await cleanup();

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
