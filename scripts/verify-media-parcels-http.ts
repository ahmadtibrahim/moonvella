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
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ADMIN_SESSION_COOKIE } from "~/utils/adminAuth.server";
import { JOB_KIND } from "~/services/jobs.server";
import { videoProbeKey } from "~/services/mediaProbe.server";
import { deleteObject, saveUpload } from "~/services/storage.server";

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
  // Deleting the product cascades to its assets, but an asset's ROW and its
  // OBJECT are two different things: the row goes with the product and the
  // bytes stay on disk. This suite stores real videos now, so the keys are read
  // out first and the files removed by name — a megabyte of orphaned clip per
  // run, otherwise, in a directory nothing ever sweeps.
  const orphans = await prisma.mediaAsset.findMany({
    where: { product: { productCode: { startsWith: "VERIFY-MP-" } } },
    select: { id: true, storageKey: true },
  });
  for (const orphan of orphans) await deleteObject(orphan.storageKey).catch(() => undefined);
  // The Retry this suite presses queues a probe against one of those assets.
  // The asset row is gone with its product, so the job would be claimed by the
  // next suite that drains the queue and would find nothing to measure.
  if (orphans.length) {
    await prisma.backgroundJob.deleteMany({
      where: { OR: orphans.map((orphan) => ({ idempotencyKey: { contains: orphan.id } })) },
    });
  }
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

/**
 * Post a multipart form at an admin path and read the answer both ways.
 *
 * The reply is parsed as JSON *and* kept as text, because one of the two
 * defects this suite covers is precisely that the answer was HTML: a check that
 * only looked at the parsed value could not tell "not JSON" from "JSON that
 * says no".
 */
async function postForm(path: string, cookie: string, body: FormData) {
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
  return {
    status: res.status,
    location: res.headers.get("location") ?? "",
    text,
    json,
    type: res.headers.get("content-type") ?? "",
  };
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
  body.set("scopeMode", "general");
  body.set("file", new Blob([pngBytes()], { type: "image/png" }), filename);

  return postForm(path, cookie, body);
}

/**
 * Encode a real video with the image's own ffmpeg, and read it back.
 *
 * Nothing here is stubbed. The defect this section covers is that a video could
 * never become READY, and "ready" means a length was measured from actual
 * bytes by the same tool the server uses — so the bytes are made here, by
 * ffmpeg, and uploaded through the same endpoint the editor's uploader calls.
 * If ffmpeg is missing from this image the check fails and says so, which is
 * the correct outcome: an image without ffmpeg is an image where every video
 * stays PROCESSING.
 *
 * `crf` and `scale` are exposed because the last check in this section needs a
 * file larger than the 64 MB `tmpfs` the test deployment mounts over `/tmp` —
 * the smallest clip that cannot fit there is a deliberately fat one.
 */
async function makeVideo(
  seconds: number,
  options: { scale?: string; rate?: number; crf?: string; preset?: string; noise?: boolean } = {}
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "verify-http-video-"));
  const path = join(dir, "clip.mp4");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-v", "error",
          "-f", "lavfi",
          "-i",
          `testsrc=size=${options.scale ?? "64x48"}:rate=${options.rate ?? 10}:duration=${seconds}`,
          // A test pattern compresses to almost nothing — which is why the
          // size check below needs noise: film grain is the one thing an
          // encoder cannot predict, so it is what makes a file big.
          ...(options.noise ? ["-vf", "noise=alls=100:allf=t"] : []),
          "-c:v", "libx264",
          "-preset", options.preset ?? "ultrafast",
          "-crf", options.crf ?? "28",
          "-pix_fmt", "yuv420p",
          "-y", path,
        ],
        { timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
        (error) => (error ? reject(new Error(String(error.message).split("\n")[0])) : resolve())
      );
    });
    return Buffer.from(await readFile(path));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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

/**
 * THE VIDEO PIPELINE, OVER HTTP, AGAINST A DEPLOYMENT THAT HAS A 64 MB /tmp.
 *
 * What went wrong: every uploaded video stayed at PROCESSING forever, because
 * the image had no ffprobe and nothing ever tried again. An asset in that state
 * cannot be approved, cannot be published, and — the part a person notices —
 * its tile is drawn as a broken image, because the preview branched on the
 * asset's CATEGORY rather than on what the file actually is.
 *
 * So this section drives the three things that were broken, through the same
 * endpoints the screens call:
 *
 *   1. An upload of a real clip, encoded here by this image's own ffmpeg, must
 *      come back READY with a length.
 *   2. The stored object must be servable the way a player needs it — a range
 *      request answered 206, a whole request answered 200, a bad range refused
 *      with 416 — and the media tab must render a <video> for it, not an <img>.
 *   3. A clip too large for the 64 MB tmpfs the deployment mounts over /tmp
 *      must still be measured, which is only possible if the probe scratches on
 *      the uploads volume.
 */
async function videoPipeline(cookie: string, productId: string) {
  console.log("\n— A video must be measured, playable, and drawn as what it is —");

  const productPath = `/admin/products/${productId}`;
  const dataPath = `${productPath}/media-batch`;
  const mediaTab = `${productPath}?tab=media`;

  const upload = async (filename: string, bytes: Buffer, title: string) => {
    const body = new FormData();
    body.set("intent", "media_upload_batch");
    body.set("tab", "media");
    body.set("category", "PRODUCT_VIDEO");
    body.set("title", title);
    body.set("scopeMode", "general");
    body.set("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), filename);
    return postForm(dataPath, cookie, body);
  };

  const seconds = 2;
  const filename = `verify-mp-${Date.now()}.mp4`;
  let uploaded: Awaited<ReturnType<typeof upload>>;
  try {
    uploaded = await upload(filename, await makeVideo(seconds), "Verify video");
  } catch (error) {
    check(
      "This image can encode a test clip (ffmpeg is present)",
      false,
      error instanceof Error ? error.message : "ffmpeg failed"
    );
    return;
  }

  check(
    "A video uploads through the same endpoint as every other file",
    uploaded.json?.ok === true,
    `HTTP ${uploaded.status} · ${uploaded.text.slice(0, 80)}`
  );
  const videoId = typeof uploaded.json?.assetId === "string" ? uploaded.json.assetId : "";
  const video = videoId
    ? await prisma.mediaAsset.findUnique({
        where: { id: videoId },
        select: {
          mimeType: true,
          processingStatus: true,
          durationSeconds: true,
          processingError: true,
          width: true,
          height: true,
          storageKey: true,
          fileSize: true,
        },
      })
    : null;

  check(
    "It is READY, because the upload measured it rather than promising to measure it",
    video?.processingStatus === "READY",
    `${video?.processingStatus} · ${video?.processingError ?? "no error"}`
  );
  check(
    "And it carries the length of the clip that was actually uploaded",
    video?.durationSeconds === seconds,
    `${video?.durationSeconds}s for a ${seconds}s clip`
  );
  check(
    "And the frame size, so the tile can reserve the right box",
    video?.width === 64 && video?.height === 48,
    `${video?.width}×${video?.height}`
  );
  check(
    "No probe is queued for a video that is already measured",
    (await prisma.backgroundJob.count({ where: { idempotencyKey: videoProbeKey(videoId) } })) === 0,
    videoId || "no asset"
  );

  /* ---- The bytes, served the way a player asks for them ---------------- */

  const key = video?.storageKey ?? "";
  const size = video?.fileSize ?? 0;
  const getRange = (range?: string) =>
    fetch(`${BASE}/uploads/${key}`, {
      headers: range ? { Range: range, Cookie: cookie } : { Cookie: cookie },
    });

  const partial = await getRange("bytes=0-1");
  const partialBody = new Uint8Array(await partial.arrayBuffer());
  check(
    "A range request is answered 206 with exactly the bytes asked for",
    partial.status === 206 && partialBody.byteLength === 2,
    `HTTP ${partial.status} · ${partialBody.byteLength} bytes`
  );
  check(
    "And names the range it sent, which is what a player seeks by",
    partial.headers.get("content-range") === `bytes 0-1/${size}`,
    partial.headers.get("content-range") ?? "no Content-Range"
  );
  check(
    "And says, on that response, that ranges are supported at all",
    partial.headers.get("accept-ranges") === "bytes",
    partial.headers.get("accept-ranges") ?? "no Accept-Ranges"
  );

  const whole = await getRange();
  check(
    "With no range the whole clip is served, as video, with its length declared",
    whole.status === 200 &&
      whole.headers.get("content-type") === "video/mp4" &&
      whole.headers.get("accept-ranges") === "bytes" &&
      whole.headers.get("content-length") === String(size),
    `HTTP ${whole.status} · ${whole.headers.get("content-type")} · ${whole.headers.get("content-length")}/${size}`
  );
  await whole.arrayBuffer();

  const tooFar = await getRange(`bytes=${size + 10}-`);
  check(
    "A range past the end is refused with 416 and the real length, not answered 200",
    tooFar.status === 416 && tooFar.headers.get("content-range") === `bytes */${size}`,
    `HTTP ${tooFar.status} · ${tooFar.headers.get("content-range") ?? "no Content-Range"}`
  );

  /* ---- What the screen draws ------------------------------------------- */

  const tabRes = await fetch(`${BASE}${mediaTab}`, { headers: { Cookie: cookie } });
  const tabHtml = await tabRes.text();
  const keyPattern = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  check(
    "The media tab renders a video element pointing at the stored object",
    new RegExp(`<video[^>]*src="/uploads/${keyPattern}"`).test(tabHtml),
    `HTTP ${tabRes.status}`
  );
  check(
    "And does not draw that same object as an image, which is the defect this covers",
    !new RegExp(`<img[^>]*src="/uploads/${keyPattern}"`).test(tabHtml)
  );
  check(
    "And declares a captions channel, so the player is not silent to assistive technology",
    /<track[^>]*kind="captions"/.test(tabHtml)
  );

  /* ---- A template is a link, and is created as one --------------------- */

  const templateUrl = `https://www.canva.com/design/verify-http-${Date.now()}/view`;
  const templateForm = new FormData();
  templateForm.set("intent", "media_upload_template");
  templateForm.set("tab", "marketing");
  templateForm.set("title", "Verify template");
  templateForm.set("templateUrl", templateUrl);
  templateForm.set("instructions", "Keep the palette.");
  templateForm.set("scopeMode", "general");
  const templateRes = await postForm(productPath, cookie, templateForm);

  const templateRow = await prisma.mediaAsset.findFirst({
    where: { productId, templateUrl },
    select: { id: true, category: true, mimeType: true, processingStatus: true, fileSize: true },
  });
  check(
    "A template is created from a link alone, with no file to upload",
    templateRow !== null,
    `HTTP ${templateRes.status} · ${templateRow?.id ?? "no row written"}`
  );
  check(
    "The template row is a link, not a file waiting to be processed",
    templateRow?.category === "EDITABLE_TEMPLATE" &&
      templateRow?.mimeType === "text/uri-list" &&
      templateRow?.processingStatus === "READY" &&
      templateRow?.fileSize === 0,
    JSON.stringify(templateRow)
  );

  const marketingRes = await fetch(`${BASE}${productPath}?tab=marketing`, {
    headers: { Cookie: cookie },
  });
  check(
    "And it is rendered as a link the operator can open, not as an image",
    (await marketingRes.text()).includes(templateUrl),
    `HTTP ${marketingRes.status}`
  );

  /* ---- A video that failed, and the Retry a person presses ------------- */

  /*
   * The row is made here rather than uploaded, because the uploader refuses a
   * file it cannot identify and a video only reaches FAILED by being damaged
   * after it was accepted. Its stored copy is a real clip cut short — the same
   * shape of damage as a truncated transfer.
   */
  const damaged = (await makeVideo(seconds)).subarray(0, 512);
  const storedDamaged = await saveUpload(
    new File([new Uint8Array(damaged)], "damaged.mp4", { type: "video/mp4" })
  );
  const broken = await prisma.mediaAsset.create({
    data: {
      productId,
      category: "PRODUCT_VIDEO",
      title: "Verify damaged video",
      originalFilename: "damaged.mp4",
      storageKey: storedDamaged.key,
      mimeType: "video/mp4",
      fileSize: storedDamaged.size,
      checksum: storedDamaged.checksum,
      processingStatus: "FAILED",
      processingError: "the file could not be read as a video",
      approvalStatus: "DRAFT",
      sellerVisible: false,
    },
    select: { id: true },
  });

  const failedHtml = await (await fetch(`${BASE}${mediaTab}`, { headers: { Cookie: cookie } })).text();
  check(
    "A failed video shows why it failed, on the screen, in words",
    failedHtml.includes("the file could not be read as a video")
  );
  check(
    "And offers a Retry that names the asset it is for",
    new RegExp(`name="assetId"[^>]*value="${broken.id}"`).test(failedHtml) &&
      failedHtml.includes("media_probe_retry")
  );

  const retryForm = new FormData();
  retryForm.set("intent", "media_probe_retry");
  retryForm.set("tab", "media");
  retryForm.set("assetId", broken.id);
  const retryRes = await postForm(productPath, cookie, retryForm);

  const afterRetry = await prisma.mediaAsset.findUnique({
    where: { id: broken.id },
    select: { processingStatus: true, processingError: true },
  });
  check(
    "Pressing Retry puts the video back to processing and clears the old failure",
    afterRetry?.processingStatus === "PROCESSING" && afterRetry?.processingError === null,
    `HTTP ${retryRes.status} · ${JSON.stringify(afterRetry)}`
  );
  const retryJobs = await prisma.backgroundJob.findMany({
    where: { idempotencyKey: { startsWith: videoProbeKey(broken.id) } },
    select: { idempotencyKey: true, kind: true },
  });
  check(
    "And queues a probe of the right kind, named by attempt",
    retryJobs.length === 1 &&
      retryJobs[0].kind === JOB_KIND.MEDIA_VIDEO_PROBE &&
      retryJobs[0].idempotencyKey !== videoProbeKey(broken.id),
    JSON.stringify(retryJobs)
  );

  /* ---- A clip too big for the tmpfs ------------------------------------ */

  /*
   * THE ONE THAT PROVES THE SCRATCH LOCATION. This deployment mounts a 64 MB
   * tmpfs over /tmp, which is where a probe would naturally write its working
   * copy. The clip below is larger than that, so a probe that reached for /tmp
   * would fail to write it, the video would come back PROCESSING, and this
   * check would fail — which is the whole point of making it.
   */
  let bigUploaded: Awaited<ReturnType<typeof upload>>;
  try {
    const big = await makeVideo(2, { scale: "1280x720", rate: 25, crf: "0", noise: true });
    const mb = Math.round(big.byteLength / (1024 * 1024));
    bigUploaded = await upload(`verify-mp-big-${Date.now()}.mp4`, big, "Verify large video");
    check(
      "The large clip really is larger than the tmpfs the deployment mounts over /tmp",
      mb > 64,
      `${mb} MB`
    );
  } catch (error) {
    bigUploaded = { status: 0, location: "", text: "", json: null, type: "" };
    check(
      "A clip larger than the 64 MB /tmp can be encoded and uploaded",
      false,
      error instanceof Error ? error.message : "failed"
    );
  }

  const bigId = typeof bigUploaded.json?.assetId === "string" ? bigUploaded.json.assetId : "";
  const bigRow = bigId
    ? await prisma.mediaAsset.findUnique({
        where: { id: bigId },
        select: { processingStatus: true, durationSeconds: true, fileSize: true },
      })
    : null;
  check(
    "And it is measured anyway — the probe wrote its working copy somewhere that had the room",
    bigRow?.processingStatus === "READY" && bigRow?.durationSeconds === 2,
    JSON.stringify(bigRow ?? bigUploaded.text.slice(0, 120))
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
  await videoPipeline(cookie, product.id);

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
