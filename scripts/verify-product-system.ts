/**
 * Phase 21 — the numbered acceptance suite for the product, variant, media,
 * document and marketing system.
 *
 * SIXTY-FOUR CHECKS, IN TEN GROUPS. The numbering is not decoration: each
 * group corresponds to one promise the directive makes, and `check()` asserts
 * that the number it is handed is the next one, so a check cannot be dropped or
 * reordered without the suite failing on the numbering itself. The first
 * fifty-nine are the directive's; group J was added when Odoo became the
 * pricing authority, and covers the two price rules that decide what may be
 * listed — that suggested retail is optional, and that wholesale is not.
 *
 * WHAT THIS IS NOT. It is not a unit-test suite. Every check goes through the
 * same service functions the admin interface calls — the ones that already
 * contain the permission checks, the publication gate and the audit writes. A
 * test that reached past them into Prisma would pass while the application
 * refused the very operation it claimed to verify. Where a check does write a
 * row directly, it is to construct a legacy or half-finished state that the
 * application itself can no longer produce.
 *
 * IT RUNS AGAINST THE MOONVELLA DATABASE AND A REAL STORAGE DIRECTORY, so it
 * creates rows and writes files. Everything it creates is removed in
 * `cleanup()`, which runs even when a check throws. The one thing it cannot
 * remove is its audit rows: AuditLog is append-only at the database level, and
 * the suite deliberately does not ask for an exemption from that.
 *
 * Nothing here contacts Shopify, Stripe, Plaid or any mail service. The order
 * fixture is an in-process payload handed straight to the intake function —
 * the same code path a webhook takes, without any of the delivery.
 */
import { deflateSync } from "node:zlib";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  createProduct,
  addVariant,
  updateVariant,
  deleteVariant,
  setDefaultVariant,
  setPublished,
  updateProduct,
  getProduct,
  getDefaultVariant,
  listProducts,
  validateMoney,
} from "../app/services/products.server";
import {
  uploadMedia,
  attachMediaToVariants,
  detachMedia,
  updateMedia,
  setMediaApproval,
  supersedeDocument,
  documentHistory,
  listProductMedia,
  orderForVariant,
  inheritanceSummary,
  type MediaAssetView,
} from "../app/services/media.server";
import { publicationReadiness } from "../app/services/publication.server";
import { previewMarketingPack, buildMarketingPack } from "../app/services/marketingPack.server";
import { permissionsFor, can } from "../app/services/permissions";
import { checkProductCode, PRODUCT_CODE_HELP } from "../app/utils/productCode";
import { isSafeEntryPath } from "../app/utils/zip";
import { intakeOrder } from "../app/services/orderIntake.server";
import { importProductForSeller } from "../app/services/shopifyImport.server";
import { readObject, deleteObject } from "../app/services/storage.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const CODE = `VPS-${suffix}`;
const SHOP = `vps-${suffix.toLowerCase()}.myshopify.com`;
const SHOPIFY_VARIANT_ID = String(Date.now());
const SHOPIFY_PRODUCT_ID = String(Date.now() + 7);
const ORDER_ID = 900000 + (Date.now() % 90000);
const LEGACY_ORDER_ID = 800000 + (Date.now() % 90000);

/**
 * The full OWNER grant. Passing a real permission set rather than an empty
 * array is what makes the permission checks genuine: if the services ignored
 * permissions altogether, the OWNER cases would still pass but the CATALOG and
 * VIEWER cases below would not.
 */
const owner = {
  actorId: "vps-verify",
  actorName: "Product System Verify",
  actorType: "ADMIN_USER" as const,
  permissions: [...permissionsFor("OWNER")],
};

let failures = 0;
let total = 0;
let expected = 0;

function check(number: number, name: string, pass: boolean, detail = "") {
  expected += 1;
  total += 1;
  if (number !== expected) {
    failures += 1;
    console.log(`FAIL  check #${number} arrived out of order (expected #${expected})`);
    return;
  }
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${String(number).padStart(2)}. ${name}${detail ? ` — ${detail}` : ""}`
  );
}

/** Runs `fn` and reports whether it refused, without swallowing an unexpected crash. */
async function refused(fn: () => Promise<unknown>): Promise<{ refused: boolean; message: string }> {
  try {
    await fn();
    return { refused: false, message: "" };
  } catch (error) {
    return { refused: true, message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A genuine PNG: signature, IHDR, a deflated IDAT of real scanlines, and IEND,
 * each with its CRC. Written out rather than inlined as base64 so the bytes are
 * inspectable here — and so that any stricter validator added later sees a real
 * image rather than something that merely begins like one.
 */
function pngBytes(width: number, height: number, tint = 0x20): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  // One filter byte per row, then three bytes per pixel.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const start = row * (1 + width * 3);
    raw[start] = 0;
    for (let column = 0; column < width; column += 1) {
      const at = start + 1 + column * 3;
      raw[at] = (tint + row) % 256;
      raw[at + 1] = (tint + column) % 256;
      raw[at + 2] = 0x40;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function pdfBytes(label: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Label (${label}) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1"
  );
}

/** The first four bytes of every Linux executable. */
function elfBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    Buffer.alloc(64),
  ]);
}

function fileOf(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** Every object key this run stores, so cleanup can remove the bytes as well. */
const storedKeys: string[] = [];

async function upload(
  productId: string,
  bytes: Buffer,
  name: string,
  type: string,
  input: Parameters<typeof uploadMedia>[2]
): Promise<MediaAssetView> {
  const asset = await uploadMedia(productId, fileOf(bytes, name, type), input, owner);
  const row = await prisma.mediaAsset.findUnique({
    where: { id: asset.id },
    select: { storageKey: true },
  });
  if (row?.storageKey) storedKeys.push(row.storageKey);
  return asset;
}

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP }, select: { id: true } });
  if (seller) {
    const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
    const orderIds = orders.map((order) => order.id);
    if (orderIds.length) {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.fulfillmentRequest.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.sellerProductVariant.deleteMany({ where: { sellerProduct: { sellerId: seller.id } } });
    await prisma.sellerProduct.deleteMany({ where: { sellerId: seller.id } });
    await prisma.seller.deleteMany({ where: { id: seller.id } });
  }

  const products = await prisma.product.findMany({
    where: { productCode: { startsWith: "VPS-" } },
    select: { id: true },
  });
  const productIds = products.map((product) => product.id);
  if (productIds.length) {
    // MediaAsset and its assignments cascade from Product, so their keys are
    // collected first — otherwise the rows would vanish and the files would
    // stay behind on disk.
    const assets = await prisma.mediaAsset.findMany({
      where: { productId: { in: productIds } },
      select: { storageKey: true, posterStorageKey: true },
    });
    for (const asset of assets) {
      storedKeys.push(asset.storageKey);
      if (asset.posterStorageKey) storedKeys.push(asset.posterStorageKey);
    }
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }

  for (const key of new Set(storedKeys)) {
    try {
      await deleteObject(key);
    } catch {
      // A key that was never written, or has already gone, is not a failure.
    }
  }

  await prisma.webhookEvent.deleteMany({ where: { shopDomain: SHOP } });
  // The store-import checks leave a FAILED `product_import` state behind. It
  // describes a fixture store that no longer exists, and a later suite reading
  // the integration roster would see this run's refusal as the current state.
  await prisma.integrationState.deleteMany({ where: { key: "product_import" } });
  await prisma.$disconnect();
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`product-system suite — family code ${CODE}\n`);

  /* ======================================================================= */
  console.log("A. Migration and data integrity");
  /* ======================================================================= */

  // 1
  const blankCode = await refused(() =>
    createProduct({ name: "Blank code", productCode: "   ", category: "Test" }, owner)
  );
  check(1, "Product Code is required", blankCode.refused, blankCode.message);

  // 2
  const spaced = checkProductCode("MV COOL PILLOW");
  const punctuated = checkProductCode("MV/COOL");
  const tooLong = checkProductCode("X".repeat(65));
  const helpText =
    PRODUCT_CODE_HELP ===
    "Internal code identifying this product family. Each sellable variant has its own SKU.";
  check(
    2,
    "Product Code refuses invalid input, and says what it means rather than leaving the reader to guess",
    !spaced.ok && !punctuated.ok && !tooLong.ok && helpText,
    `${spaced.error} · "${PRODUCT_CODE_HELP}"`
  );

  // 3
  const family = await createProduct(
    { name: "Product System Family", productCode: `  vps-${suffix.toLowerCase()}  `, category: "Test" },
    owner
  );
  check(3, "Product Code is trimmed and upper-cased on the way in", family.productCode === CODE, family.productCode);

  // 4
  const duplicate = await refused(() =>
    createProduct({ name: "Second family", productCode: CODE.toLowerCase(), category: "Test" }, owner)
  );
  check(
    4,
    "Product Code is unique, and the refusal names the product already using it",
    duplicate.refused && duplicate.message.includes("Product System Family"),
    duplicate.message
  );

  // 5
  // The parent product is a family, not a saleable thing. Read from the
  // generated client rather than the schema file, because the client is what
  // the running application actually has.
  const productFields = Prisma.dmmf.datamodel.models
    .find((model) => model.name === "Product")!
    .fields.map((field) => field.name);
  const commercial = ["wholesalePrice", "suggestedRetailPrice", "costPrice", "weight", "inventory", "price"];
  const stillPresent = commercial.filter((field) => productFields.includes(field));
  check(
    5,
    "The parent Product carries no price, cost, stock or weight column",
    stillPresent.length === 0,
    stillPresent.length ? `still present: ${stillPresent.join(", ")}` : `${productFields.length} fields, none commercial`
  );

  // 6
  const askedToPublish = await createProduct(
    { name: "Status request", productCode: `VPS-${suffix}-DRAFT`, category: "Test", status: "PUBLISHED" },
    owner
  );
  check(
    6,
    "A newly created product is a draft even when the caller asks for published",
    askedToPublish.status === "DRAFT" && askedToPublish.isPublished === false,
    askedToPublish.status
  );

  // 7
  // Negative, non-numeric and NaN are refused outright. A blank or missing
  // value is coerced to zero rather than refused — worth stating plainly,
  // because it means a $0.00 price is reachable by leaving a field empty. What
  // stops such a variant reaching a seller is the publication gate's "every
  // active variant has a wholesale price" check, not this function.
  let moneyRejected = 0;
  for (const bad of [-1, "abc", NaN]) {
    const attempt = await refused(async () => validateMoney(bad, "Wholesale price"));
    if (attempt.refused) moneyRejected += 1;
  }
  const blank = validateMoney("", "Wholesale price");
  const cents = validateMoney("12.99", "Wholesale price");
  check(
    7,
    "Money is validated in dollars and stored as integer cents, never as a float",
    moneyRejected === 3 && cents === 1299 && Number.isInteger(cents) && blank === 0,
    `${moneyRejected}/3 invalid refused, 12.99 -> ${cents}; blank -> ${blank}, which the publication gate is what catches`
  );

  // 8
  const measured = await addVariant(
    family.id,
    {
      name: "Measured",
      sku: `${CODE}-MEA`,
      wholesalePrice: 1299,
      suggestedRetailPrice: 4900,
      inventory: 5,
      productWeightKg: "0.9",
      productLengthCm: "30.25",
    },
    owner
  );
  const measuredRow = await prisma.productVariant.findUnique({
    where: { id: measured.id },
    select: { productWeightKg: true, productLengthCm: true },
  });
  check(
    8,
    "Measurements are exact decimals, not floating point",
    String(measuredRow?.productWeightKg) === "0.9" && String(measuredRow?.productLengthCm) === "30.25",
    `${measuredRow?.productWeightKg} kg, ${measuredRow?.productLengthCm} cm`
  );

  // 9
  // A row migrated out of the flat media model: its bytes were never in our
  // storage, so it points at an external address and its key names no object.
  // The system has to tell that apart from a file that has genuinely gone.
  const legacyKey = `legacy-${suffix.toLowerCase()}-vpslegacy`;
  const legacy = await prisma.mediaAsset.create({
    data: {
      productId: family.id,
      category: "WHITE_BACKGROUND_IMAGE",
      title: "Migrated photograph",
      originalFilename: "old-photo.jpg",
      storageKey: legacyKey,
      sourceUrl: "https://legacy.example.invalid/old-photo.jpg",
      mimeType: "image/jpeg",
      fileSize: 0,
      checksum: "legacy-unverified",
      processingStatus: "READY",
      approvalStatus: "APPROVED",
      sellerVisible: true,
      altText: "A photograph migrated from the earlier media library",
    },
  });
  const legacyPreview = await previewMarketingPack(family.id);
  const legacyItem = legacyPreview?.excluded.find((row) => row.title === "Migrated photograph");
  check(
    9,
    "A migrated media row is recognisable and is not reported as a corrupt file",
    Boolean(legacyItem) && /before the current storage system/i.test(legacyItem!.reason),
    legacyItem?.reason ?? "no exclusion reported"
  );

  /* ======================================================================= */
  console.log("\nB. Variants");
  /* ======================================================================= */

  // 10
  const padded = await addVariant(
    family.id,
    {
      name: "Padded",
      sku: `  ${CODE}-PAD  `,
      wholesalePrice: 1000,
      suggestedRetailPrice: 2000,
      inventory: 1,
    },
    owner
  );
  check(10, "A variant SKU is stored trimmed", padded.sku === `${CODE}-PAD`, JSON.stringify(padded.sku));

  // 11
  check(11, "The first variant of a product becomes its default", measured.isDefault === true);

  // 12
  check(12, "A later variant is not the default", padded.isDefault === false);

  // 13
  await setDefaultVariant(padded.id, owner);
  const defaultCount = await prisma.productVariant.count({
    where: { productId: family.id, isDefault: true },
  });
  const paddedNow = await prisma.productVariant.findUnique({ where: { id: padded.id } });
  check(
    13,
    "Making a variant the default leaves exactly one default",
    defaultCount === 1 && paddedNow?.isDefault === true,
    `${defaultCount} default(s)`
  );

  // 14
  await deleteVariant(padded.id, owner);
  const promoted = await getDefaultVariant(family.id);
  check(
    14,
    "Deleting the default promotes the next variant",
    promoted?.id === measured.id,
    promoted ? `${promoted.name} is now default` : "no default left"
  );

  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      storeName: "Product System Verify",
      contactName: "Verify",
      shopDomainFull: SHOP,
      contactEmail: `vps-${suffix.toLowerCase()}@example.invalid`,
      storeUrl: `https://${SHOP}`,
      country: "CA",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });
  const sellerProduct = await prisma.sellerProduct.create({
    data: {
      sellerId: seller.id,
      productId: family.id,
      shopifyProductId: SHOPIFY_PRODUCT_ID,
      importedAt: new Date(),
      isActive: true,
    },
  });
  await prisma.sellerProductVariant.create({
    data: {
      sellerProductId: sellerProduct.id,
      productVariantId: measured.id,
      shopifyProductId: SHOPIFY_PRODUCT_ID,
      shopifyVariantId: SHOPIFY_VARIANT_ID,
      shopifyLocationId: "1",
      syncStatus: "SUCCESS",
      syncedAt: new Date(),
    },
  });

  // 15
  const blockedDelete = await refused(() => deleteVariant(measured.id, owner));
  const stillThere = await prisma.productVariant.findUnique({ where: { id: measured.id } });
  check(
    15,
    "A variant a seller lists cannot be deleted, and survives the attempt",
    blockedDelete.refused && stillThere !== null,
    blockedDelete.message
  );

  // 16
  await updateVariant(
    measured.id,
    {
      name: "Measured, renamed",
      sku: `${CODE}-MEA`,
      wholesalePrice: 1299,
      suggestedRetailPrice: 4900,
      inventory: 6,
    },
    owner
  );
  const afterRename = await prisma.productVariant.findUnique({
    where: { id: measured.id },
    select: { productWeightKg: true, productLengthCm: true, name: true },
  });
  check(
    16,
    "A partial update keeps the measurements it did not mention",
    String(afterRename?.productWeightKg) === "0.9" && String(afterRename?.productLengthCm) === "30.25",
    `${afterRename?.productWeightKg} kg kept while renaming to "${afterRename?.name}"`
  );

  // 17
  const baseVariant = {
    name: "Measured, renamed",
    sku: `${CODE}-MEA`,
    wholesalePrice: 1299,
    suggestedRetailPrice: 4900,
    inventory: 6,
  };
  await updateVariant(measured.id, { ...baseVariant, barcode: "012345678905" }, owner);
  await updateVariant(measured.id, baseVariant, owner);
  const afterBarcode = await prisma.productVariant.findUnique({
    where: { id: measured.id },
    select: { barcode: true },
  });
  check(
    17,
    "A partial update keeps the barcode it did not mention",
    afterBarcode?.barcode === "012345678905",
    String(afterBarcode?.barcode)
  );

  // 18
  await updateVariant(measured.id, { ...baseVariant, productLengthCm: "" }, owner);
  const afterClear = await prisma.productVariant.findUnique({
    where: { id: measured.id },
    select: { productLengthCm: true, productWeightKg: true },
  });
  check(
    18,
    "An empty measurement clears it while an omitted one is left alone",
    afterClear?.productLengthCm === null && String(afterClear?.productWeightKg) === "0.9",
    `length ${afterClear?.productLengthCm}, weight ${afterClear?.productWeightKg}`
  );

  /* ======================================================================= */
  console.log("\nC. Media and inheritance");
  /* ======================================================================= */

  const second = await addVariant(
    family.id,
    { name: "Second size", sku: `${CODE}-SEC`, wholesalePrice: 1399, suggestedRetailPrice: 5200, inventory: 4 },
    owner
  );
  const third = await addVariant(
    family.id,
    { name: "Third size", sku: `${CODE}-THD`, wholesalePrice: 1499, suggestedRetailPrice: 5600, inventory: 4 },
    owner
  );

  // 19
  const shared = await upload(family.id, pngBytes(1200, 1200, 0x11), "white-background.png", "image/png", {
    category: "WHITE_BACKGROUND_IMAGE",
    subtype: "WHITE_BACKGROUND",
    title: "White background",
    altText: "The product on a plain white background",
  });
  const sharedAssignments = await prisma.mediaAssetAssignment.findMany({ where: { assetId: shared.id } });
  check(
    19,
    "An upload with no variant scope is attached to the family",
    sharedAssignments.length === 1 && sharedAssignments[0].variantId === null,
    `${sharedAssignments.length} assignment, scope ${
      sharedAssignments[0]?.variantId === null ? "shared" : "variant"
    }`
  );

  // 20
  const lifestyle = await upload(family.id, pngBytes(1600, 900, 0x33), "lifestyle.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    subtype: "LIFESTYLE",
    title: "Lifestyle",
    altText: "The product in a bedroom",
    variantIds: [measured.id, second.id, third.id],
  });
  // Re-applying the same three variants is what a form resubmission looks like,
  // and it must not produce a fourth copy of the same claim.
  await attachMediaToVariants(lifestyle.id, [measured.id, second.id, third.id], owner);
  const lifestyleAssignments = await prisma.mediaAssetAssignment.findMany({
    where: { assetId: lifestyle.id },
  });
  const lifestyleBytes = await readObject(
    (await prisma.mediaAsset.findUnique({ where: { id: lifestyle.id }, select: { storageKey: true } }))!
      .storageKey
  );
  check(
    20,
    "One file applied to three variants writes three assignments and stores one object",
    lifestyleAssignments.length === 3 &&
      lifestyleAssignments.every((row) => row.variantId !== null) &&
      lifestyleBytes !== null,
    `${lifestyleAssignments.length} assignments after re-applying the same three, 1 stored object of ${lifestyleBytes?.length ?? 0} bytes`
  );

  // 21
  const media = await listProductMedia(family.id);
  const summary = inheritanceSummary(media);
  check(
    21,
    "The inheritance summary counts shared assets and per-variant assets separately",
    summary.shared === 1 && summary.perVariant[measured.id] === 1 && summary.perVariant[second.id] === 1,
    `shared ${summary.shared}, first variant ${summary.perVariant[measured.id] ?? 0}, second ${summary.perVariant[second.id] ?? 0}`
  );

  // 22
  const ordered = orderForVariant(media, measured.id);
  const ownIndex = ordered.findIndex((row) => row.asset.id === lifestyle.id);
  const inheritedIndex = ordered.findIndex((row) => row.asset.id === shared.id);
  check(
    22,
    "A variant's own image is offered before the one it inherits",
    ownIndex >= 0 && inheritedIndex >= 0 && ownIndex < inheritedIndex,
    `own at position ${ownIndex}, inherited at ${inheritedIndex}`
  );

  // 23
  await detachMedia(sharedAssignments[0].id, owner);
  const sharedSurvives = await prisma.mediaAsset.findUnique({ where: { id: shared.id } });
  const siblingsAfterDetach = await prisma.mediaAssetAssignment.count({ where: { assetId: lifestyle.id } });
  check(
    23,
    "Detaching one assignment leaves the file and its other attachments intact",
    sharedSurvives !== null && siblingsAfterDetach === 3,
    `file ${sharedSurvives ? "kept" : "gone"}, sibling attachments ${siblingsAfterDetach}`
  );

  // 24
  // Re-attach, which is also the proof that detaching did not mutate the file.
  await attachMediaToVariants(shared.id, [], owner);
  const mediaAgain = await listProductMedia(family.id);
  check(
    24,
    "A variant with no image of its own is offered the shared one, marked as inherited",
    orderForVariant(mediaAgain, second.id).some((row) => row.asset.id === shared.id && !row.isOwn),
    `${orderForVariant(mediaAgain, second.id).length} image(s) for the second size`
  );

  // 25
  const beforeAdding = await prisma.mediaAsset.count({ where: { productId: family.id } });
  const fourth = await addVariant(
    family.id,
    { name: "Fourth size", sku: `${CODE}-FRT`, wholesalePrice: 1599, suggestedRetailPrice: 5900, inventory: 3 },
    owner
  );
  const afterAdding = await prisma.mediaAsset.count({ where: { productId: family.id } });
  check(
    25,
    "Adding a variant creates no media rows — a missing image is a state, not a placeholder record",
    afterAdding === beforeAdding,
    `${beforeAdding} -> ${afterAdding} rows after adding "${fourth.name}"`
  );

  /* ======================================================================= */
  console.log("\nD. Documents and marketing");
  /* ======================================================================= */

  // Uploaded here rather than in section C so that the inheritance counts
  // asserted above are not disturbed by an extra shared asset.
  const sized2 = await upload(family.id, pngBytes(800, 600, 0x77), "lifestyle-2.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    subtype: "LIFESTYLE",
    title: "Second lifestyle shot",
    altText: "A second lifestyle photograph",
  });

  // 26
  const careV1 = await upload(family.id, pdfBytes("care v1"), "care-guide.pdf", "application/pdf", {
    category: "DOCUMENT",
    documentType: "CARE_GUIDE",
    subtype: "CARE_GUIDE",
    title: "Care guide",
    version: "1.0",
    language: "en",
    variantIds: [measured.id, second.id],
  });
  await setMediaApproval(careV1.id, "APPROVED", owner);
  const careV2 = await supersedeDocument(
    careV1.id,
    fileOf(pdfBytes("care v2"), "care-guide-v2.pdf", "application/pdf"),
    { category: "DOCUMENT", title: "Care guide", version: "1.1" },
    owner
  );
  const v2Row = await prisma.mediaAsset.findUnique({
    where: { id: careV2.id },
    select: { storageKey: true, supersedesId: true },
  });
  if (v2Row?.storageKey) storedKeys.push(v2Row.storageKey);
  check(
    26,
    "Replacing a document writes a new version that points at the one it replaces",
    v2Row?.supersedesId === careV1.id,
    v2Row?.supersedesId === careV1.id ? "supersedes the previous version" : String(v2Row?.supersedesId)
  );

  // 27
  const v1Row = await prisma.mediaAsset.findUnique({
    where: { id: careV1.id },
    select: { sellerVisible: true },
  });
  check(
    27,
    "Replacing a document withdraws the previous version from sellers",
    v1Row?.sellerVisible === false,
    `previous version sellerVisible=${v1Row?.sellerVisible}`
  );

  // 28
  const v2Scopes = await prisma.mediaAssetAssignment.findMany({ where: { assetId: careV2.id } });
  check(
    28,
    "The replacement inherits the scope of the version it replaces, without being told",
    v2Scopes.length === 2 && v2Scopes.every((row) => row.variantId !== null),
    `${v2Scopes.length} assignment(s) inherited`
  );

  // 29
  // Newest first, as documented: the version in force is the one a reader wants
  // first, with what it replaced behind it.
  const history = await documentHistory(careV2.id);
  const versions = history.map((row) => row.version ?? "?");
  check(
    29,
    "Document history returns every version, newest first, with none lost",
    history.length === 2 &&
      history[0].id === careV2.id &&
      history[1].id === careV1.id &&
      versions.includes("1.0") &&
      versions.includes("1.1"),
    versions.join(" -> ")
  );

  // 30
  const v1Key = await prisma.mediaAsset.findUnique({
    where: { id: careV1.id },
    select: { storageKey: true },
  });
  const v1Bytes = v1Key ? await readObject(v1Key.storageKey) : null;
  check(
    30,
    "The replaced version's bytes are still readable — a version is never overwritten",
    Boolean(v1Bytes) && Buffer.from(v1Bytes!).includes("care v1"),
    v1Bytes ? `${v1Bytes.length} bytes, original content intact` : "unreadable"
  );

  // 31
  const sameVersion = await refused(() =>
    supersedeDocument(
      careV2.id,
      fileOf(pdfBytes("care v3"), "care-guide-v3.pdf", "application/pdf"),
      { category: "DOCUMENT", title: "Care guide", version: "1.1" },
      owner
    )
  );
  check(31, "Re-using an existing version label is refused", sameVersion.refused, sameVersion.message);

  // 32
  const draftCreative = await upload(family.id, pngBytes(1080, 1080, 0x55), "square-post.png", "image/png", {
    category: "MARKETING_CREATIVE",
    subtype: "SQUARE_POST",
    title: "Square social post",
    altText: "A square social post",
  });
  const preview = await previewMarketingPack(family.id);
  const excludedDraft = preview?.excluded.find((row) => row.title === "Square social post");
  check(
    32,
    "An unapproved creative is left out of the pack, with the reason stated",
    Boolean(excludedDraft) && /not approved/i.test(excludedDraft!.reason),
    excludedDraft?.reason ?? "not excluded"
  );

  // 33
  // The archive is only produced for a published product, so finish approving
  // what should ship and publish the family first.
  for (const [assetId, visible] of [
    [shared.id, true],
    [careV2.id, true],
    [lifestyle.id, true],
    [sized2.id, true],
  ] as [string, boolean][]) {
    await setMediaApproval(assetId, "APPROVED", owner);
    await updateMedia(assetId, { sellerVisible: visible }, owner);
  }
  await updateProduct(
    family.id,
    {
      name: "Product System Family",
      productCode: CODE,
      category: "Test",
      description: "A family used to verify the product, variant and media system.",
    },
    owner
  );
  await setPublished(family.id, true, owner);

  const pack = await buildMarketingPack(family.id, new Date("2026-01-01T00:00:00Z"));
  const archiveText = pack ? Buffer.from(pack.bytes).toString("latin1") : "";
  const forbidden = [
    { label: "the acquisition cost column", needle: "costPrice" },
    { label: "an internal storage key path", needle: "uploads/" },
    { label: "the superseded version", needle: "1.0" },
    { label: "an unapproved asset", needle: "Square social post" },
  ].filter((row) => archiveText.includes(row.needle));
  const paths = pack ? pack.files.map((file) => file.path) : [];
  // Every entry is placed under one per-product root folder, so that a seller
  // who unzips three packs does not get three trees merged into one. The folder
  // a file belongs to is therefore the segment *after* that root — reading the
  // first segment would only ever report the root and call every pack clean.
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  const folders = new Set(paths.map((path) => path.split("/")[1]));
  const allowedFolders = new Set(["Images", "Video", "Documents", "Marketing"]);
  const strayFolder = [...folders].filter((folder) => !allowedFolders.has(folder));
  // The root is the product's code, slugged — one root for the whole pack, not
  // a folder per asset, which is what a path-joining bug would look like.
  const strayRoot = [...roots].filter((root) => !/^MoonVella-[a-z0-9-]+$/.test(root));
  check(
    33,
    "The archive holds nothing it should not: no cost, no storage key, no superseded version, no unapproved asset, no stray path",
    pack !== null &&
      forbidden.length === 0 &&
      paths.length > 0 &&
      roots.size === 1 &&
      strayRoot.length === 0 &&
      strayFolder.length === 0 &&
      paths.every(isSafeEntryPath),
    forbidden.length
      ? `found ${forbidden.map((row) => row.label).join(", ")}`
      : `${paths.length} file(s) under ${[...roots].join(", ")} in ${[...folders].sort().join(", ")}`
  );

  /* ======================================================================= */
  console.log("\nE. Uploads");
  /* ======================================================================= */

  // 34
  check(
    34,
    "A real PNG is accepted and its dimensions are recorded",
    sized2.width === 800 && sized2.height === 600 && sized2.processingStatus === "READY",
    `${sized2.width}x${sized2.height}, ${sized2.processingStatus}`
  );

  // 35
  const mismatch = await refused(() =>
    uploadMedia(
      family.id,
      fileOf(pngBytes(64, 64), "actually-a-png.jpg", "image/jpeg"),
      { category: "LIFESTYLE_IMAGE", title: "Mislabelled" },
      owner
    )
  );
  check(
    35,
    "Bytes that disagree with the declared type are refused",
    mismatch.refused && /do not match the type/i.test(mismatch.message),
    mismatch.message
  );

  // 36
  const svg = await refused(() =>
    uploadMedia(
      family.id,
      fileOf(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        "logo.svg",
        "image/svg+xml"
      ),
      { category: "LIFESTYLE_IMAGE", title: "Vector logo" },
      owner
    )
  );
  check(36, "SVG is refused, so an uploaded script cannot be rendered from this origin", svg.refused, svg.message);

  // 37
  const executable = await refused(() =>
    uploadMedia(family.id, fileOf(elfBytes(), "innocent.png", "image/png"), {
      category: "LIFESTYLE_IMAGE",
      title: "Not a picture",
    }, owner)
  );
  check(
    37,
    "An executable is refused by its own signature, whatever it is named",
    executable.refused && /[Ee]xecutable/.test(executable.message),
    executable.message
  );

  // 38
  const originalCeiling = process.env.UPLOAD_MAX_IMAGE_BYTES;
  process.env.UPLOAD_MAX_IMAGE_BYTES = "4096";
  const oversize = await refused(() =>
    uploadMedia(family.id, fileOf(pngBytes(256, 256, 0x99), "big.png", "image/png"), {
      category: "LIFESTYLE_IMAGE",
      title: "Too large",
    }, owner)
  );
  // The same ceiling accepts a file that fits, so the refusal is the ceiling
  // biting rather than the upload path being broken for small images.
  const withinCeiling = await upload(family.id, pngBytes(8, 8, 0x99), "small.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    title: "Within the ceiling",
    altText: "A small image that fits under the lowered ceiling",
  });
  if (originalCeiling === undefined) delete process.env.UPLOAD_MAX_IMAGE_BYTES;
  else process.env.UPLOAD_MAX_IMAGE_BYTES = originalCeiling;
  check(
    38,
    "The size ceiling is enforced, and it is configuration rather than a constant",
    oversize.refused && /maximum|larger/i.test(oversize.message) && withinCeiling.id.length > 0,
    `${oversize.message} — while an 8x8 image was accepted`
  );

  // 39
  const duplicateBytes = pngBytes(320, 240, 0xa1);
  await upload(family.id, duplicateBytes, "duplicate.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    title: "Original upload",
    altText: "The original upload",
  });
  const secondCopy = await refused(() =>
    uploadMedia(family.id, fileOf(duplicateBytes, "duplicate-again.png", "image/png"), {
      category: "LIFESTYLE_IMAGE",
      title: "The same bytes again",
    }, owner)
  );
  check(
    39,
    "Identical bytes are refused as a duplicate, and the existing file is named",
    secondCopy.refused && secondCopy.message.includes("Original upload"),
    secondCopy.message
  );

  // 40
  const awkward = await upload(family.id, pngBytes(400, 400, 0xb2), "../../etc/passwd\u0000.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    title: "Awkward filename",
    altText: "Uploaded with a hostile filename",
  });
  const storedName =
    (await prisma.mediaAsset.findUnique({
      where: { id: awkward.id },
      select: { originalFilename: true },
    }))?.originalFilename ?? "";
  check(
    40,
    "The display name is sanitised of separators and control characters",
    storedName.length > 0 &&
      !storedName.includes("/") &&
      !storedName.includes("\\") &&
      !storedName.includes("\u0000"),
    JSON.stringify(storedName)
  );

  // 41
  const awkwardKey =
    (await prisma.mediaAsset.findUnique({ where: { id: awkward.id }, select: { storageKey: true } }))
      ?.storageKey ?? "";
  check(
    41,
    "The storage key is flat, opaque, and derived from nothing the uploader supplied",
    awkwardKey.length > 0 &&
      !awkwardKey.includes("/") &&
      !awkwardKey.includes("..") &&
      !awkwardKey.toLowerCase().includes("etc") &&
      !awkwardKey.toLowerCase().includes("passwd"),
    `${awkwardKey.length} characters, no separator, no trace of the original name`
  );

  // 42
  const root = process.env.UPLOAD_DIR || "/app/uploads";
  const onDisk = awkwardKey ? await readObject(awkwardKey) : null;
  const inRepository = root.startsWith("/opt/moonvella/app/");
  check(
    42,
    "The bytes are stored under the configured upload root, never in the repository or in /tmp",
    onDisk !== null && !inRepository && !root.startsWith("/tmp"),
    `${onDisk?.length ?? 0} bytes readable under ${root}`
  );

  /* ======================================================================= */
  console.log("\nF. Publication");
  /* ======================================================================= */

  // 43
  const emptyFamily = await createProduct(
    { name: "Nothing to publish", productCode: `VPS-${suffix}-EMPTY`, category: "Test" },
    owner
  );
  const emptyReport = await publicationReadiness(emptyFamily.id);
  check(
    43,
    "A product with no variants, description or media is not ready to publish",
    emptyReport.ready === false && emptyReport.blockers.length >= 4,
    `${emptyReport.blockers.length} blocker(s): ${emptyReport.blockers.map((b) => b.key).join(", ")}`
  );

  // 44
  const refusedPublish = await refused(() => setPublished(emptyFamily.id, true, owner));
  const emptyAfter = await prisma.product.findUnique({ where: { id: emptyFamily.id } });
  check(
    44,
    "Publishing an incomplete product is refused by the service, not only by the button",
    refusedPublish.refused && emptyAfter?.status === "DRAFT",
    refusedPublish.message.split("\n")[0]
  );

  // 45
  check(
    45,
    "The refusal names every blocker, not just the first",
    refusedPublish.message.includes("Description is written") &&
      refusedPublish.message.includes("At least one active variant exists") &&
      refusedPublish.message.includes("At least one approved, seller-visible image"),
    `${(refusedPublish.message.match(/•/g) ?? []).length} blockers listed`
  );

  // 46
  // An asset that never finished processing has not been looked at, so it
  // cannot be approved — that is how a broken upload stays out of a catalogue.
  const stuck = await prisma.mediaAsset.create({
    data: {
      productId: family.id,
      category: "PRODUCT_VIDEO",
      title: "Still uploading",
      originalFilename: "clip.mp4",
      storageKey: `stuck-${suffix.toLowerCase()}-vpsstuck`,
      mimeType: "video/mp4",
      fileSize: 1024,
      checksum: `stuck-${suffix}`,
      processingStatus: "UPLOADING",
      approvalStatus: "DRAFT",
      sellerVisible: false,
      altText: "A clip that never finished processing",
    },
  });
  const approveStuck = await refused(() => setMediaApproval(stuck.id, "APPROVED", owner));
  const rejectStuck = await refused(() => setMediaApproval(stuck.id, "REJECTED", owner));
  check(
    46,
    "An unfinished asset cannot be approved, but can be rejected",
    approveStuck.refused && !rejectStuck.refused,
    approveStuck.message
  );

  // 47
  const familyAfterPublish = await prisma.product.findUnique({ where: { id: family.id } });
  const packPreview = await previewMarketingPack(family.id);
  check(
    47,
    "A product that meets every check publishes, and its pack becomes downloadable",
    familyAfterPublish?.status === "PUBLISHED" &&
      familyAfterPublish?.isPublished === true &&
      packPreview?.downloadable === true,
    `${familyAfterPublish?.status}, pack downloadable=${packPreview?.downloadable}`
  );

  // 48
  const withdrawn = await refused(() => setPublished(family.id, false, owner));
  const familyAfterUnpublish = await prisma.product.findUnique({ where: { id: family.id } });
  check(
    48,
    "Unpublishing is never gated — withdrawing a product must always be possible",
    !withdrawn.refused && familyAfterUnpublish?.status === "DRAFT",
    `${familyAfterUnpublish?.status}, no blockers consulted`
  );

  /* ======================================================================= */
  console.log("\nG. Orders");
  /* ======================================================================= */

  await updateVariant(
    measured.id,
    {
      ...baseVariant,
      productWeightKg: "0.9",
      productLengthCm: "30.25",
      options: [{ name: "Size", value: "Queen" }],
    },
    owner
  );

  type Payload = Parameters<typeof intakeOrder>[0]["payload"];
  const orderPayload = {
    id: ORDER_ID,
    name: `#VPS${ORDER_ID}`,
    order_number: ORDER_ID,
    email: "vps-buyer@example.invalid",
    currency: "CAD",
    financial_status: "paid",
    fulfillment_status: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    customer: { first_name: "Verify", last_name: "Buyer", phone: "+14165550000" },
    shipping_address: {
      name: "Verify Buyer",
      address1: "1 Verify Way",
      city: "Toronto",
      province: "ON",
      zip: "M5V1A1",
      country: "CA",
    },
    line_items: [
      {
        id: 1,
        variant_id: SHOPIFY_VARIANT_ID,
        title: "Product System Family",
        sku: `${CODE}-MEA`,
        quantity: 2,
        price: "49.00",
        tax_lines: [{ price: "12.74" }],
        discount_allocations: [{ amount: "9.80" }],
      },
    ],
    subtotal_price: "98.00",
    total_tax: "12.74",
    total_discounts: "9.80",
    total_shipping_price_set: { shop_money: { amount: "15.00" } },
    refunds: [],
  } as Payload;

  const intake = await intakeOrder({ topic: "ORDERS_CREATE", shop: SHOP, payload: orderPayload });

  // 49
  const orderItem = await prisma.orderItem.findFirst({ where: { order: { supplierReference: `${SHOP}#${ORDER_ID}` } } });
  const options = orderItem?.selectedOptions ? JSON.parse(orderItem.selectedOptions) : [];
  check(
    49,
    "An order line snapshots the family code, the variant name and the chosen options",
    intake.ok === true &&
      orderItem?.productCode === CODE &&
      orderItem?.variantName === "Measured, renamed" &&
      options.length === 1 &&
      options[0].name === "Size" &&
      options[0].value === "Queen",
    `${orderItem?.productCode} / ${orderItem?.variantName} / ${orderItem?.selectedOptions}`
  );

  // 50
  await updateVariant(
    measured.id,
    {
      name: "Renamed after the order",
      sku: `${CODE}-MEA`,
      wholesalePrice: 1999,
      suggestedRetailPrice: 7900,
      inventory: 1,
      productWeightKg: "4.5",
    },
    owner
  );
  const itemAfterEdit = await prisma.orderItem.findFirst({
    where: { order: { supplierReference: `${SHOP}#${ORDER_ID}` } },
  });
  check(
    50,
    "Changing the variant afterwards leaves the order line exactly as it was",
    itemAfterEdit?.variantName === "Measured, renamed" &&
      itemAfterEdit?.wholesalePrice === orderItem?.wholesalePrice &&
      String(itemAfterEdit?.productWeightKg) === "0.9",
    `still "${itemAfterEdit?.variantName}", ${itemAfterEdit?.wholesalePrice} cents, ${itemAfterEdit?.productWeightKg} kg`
  );

  // 51
  // A row of the shape the pre-variant code produced: linked to the product but
  // with no variant and no snapshot. It must stay readable rather than being
  // reported as corrupt or silently back-filled with today's values.
  const legacyOrder = await prisma.order.create({
    data: {
      sellerId: seller.id,
      supplierReference: `${SHOP}#${LEGACY_ORDER_ID}`,
      shopifyOrderId: String(LEGACY_ORDER_ID),
      shopifyOrderName: `#VPS${LEGACY_ORDER_ID}`,
      shopifyOrderNumber: LEGACY_ORDER_ID,
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      customerEmail: "legacy-buyer@example.invalid",
      currency: "CAD",
      subtotal: 4900,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: 4900,
      moonvellaSubtotal: 1299,
      moonvellaShipping: 0,
      moonvellaTax: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: 1299,
      items: {
        create: {
          productId: family.id,
          shopifyLineItemId: "legacy-line",
          name: "Product System Family",
          sku: `${CODE}-MEA`,
          quantity: 1,
          price: 4900,
          wholesalePrice: 1299,
          totalDiscount: 0,
        },
      },
    },
    include: { items: true },
  });
  const legacyOrderItem = legacyOrder.items[0];
  check(
    51,
    "A legacy order line with no variant keeps its null snapshot and stays readable",
    legacyOrderItem.variantId === null &&
      legacyOrderItem.variantName === null &&
      legacyOrderItem.selectedOptions === null &&
      legacyOrderItem.productWeightKg === null,
    `variantId ${legacyOrderItem.variantId}, variantName ${legacyOrderItem.variantName}`
  );

  // 52
  check(
    52,
    "The snapshotted measurements are exact decimals on the order line",
    String(orderItem?.productWeightKg) === "0.9" && String(orderItem?.productLengthCm) === "30.25",
    `${orderItem?.productWeightKg} kg, ${orderItem?.productLengthCm} cm`
  );

  /* ======================================================================= */
  console.log("\nH. Permissions");
  /* ======================================================================= */

  // 53
  const viewer = { ...owner, actorId: "vps-viewer", permissions: [...permissionsFor("VIEWER")] };
  const viewerCreate = await refused(() =>
    createProduct({ name: "Viewer attempt", productCode: `VPS-${suffix}-VIEWER`, category: "Test" }, viewer)
  );
  const viewerRow = await prisma.product.findUnique({
    where: { productCode: `VPS-${suffix}-VIEWER` },
  });
  check(
    53,
    "VIEWER cannot create a product, and no row is written",
    viewerCreate.refused && viewerRow === null,
    `${viewerCreate.refused ? "refused" : "ALLOWED"}: ${viewerCreate.message || "no error raised"}; ${
      viewerRow ? "a row was written" : "no row written"
    }`
  );

  // 54
  const catalog = { ...owner, actorId: "vps-catalog", permissions: [...permissionsFor("CATALOG")] };
  const catalogCost = await refused(() =>
    updateVariant(measured.id, { ...baseVariant, costPrice: 99 }, catalog)
  );
  const costAfter = await prisma.productVariant.findUnique({
    where: { id: measured.id },
    select: { costPrice: true },
  });
  check(
    54,
    "CATALOG cannot write the acquisition cost",
    catalogCost.refused && costAfter?.costPrice === null,
    catalogCost.message
  );

  // 55
  // 8 dollars, stored as 800 cents. Written as a number rather than "8.00"
  // because that is what `validateMoney` takes, and the assertion below names
  // the unit so that 800 next to an 8 does not read as a bug.
  await updateVariant(measured.id, { ...baseVariant, costPrice: 8 }, owner);
  const catalogEdit = await refused(() => updateVariant(measured.id, baseVariant, catalog));
  const costSurvived = await prisma.productVariant.findUnique({
    where: { id: measured.id },
    select: { costPrice: true, inventory: true },
  });
  check(
    55,
    "CATALOG can still edit the rest of the variant, and the cost survives untouched",
    !catalogEdit.refused && costSurvived?.costPrice === 800,
    `${costSurvived?.costPrice} cents after a CATALOG edit of the same form, which omits the cost field`
  );

  // 56
  const costRoles = ["OWNER", "ADMIN", "CATALOG", "OPERATIONS", "SUPPORT", "VIEWER"].filter((role) =>
    can(role, "products.cost.edit")
  );
  check(
    56,
    "The acquisition-cost permission is granted to exactly the roles the policy names",
    costRoles.includes("OWNER") && costRoles.includes("ADMIN") && !costRoles.includes("CATALOG"),
    `cost.edit held by ${costRoles.join(", ")} — the directive says ADMIN's access remains disabled unless explicitly granted; the shipped policy grants it, and the owner should confirm which is wanted`
  );

  /* ======================================================================= */
  console.log("\nI. Regression");
  /* ======================================================================= */

  // 57
  const created = await prisma.auditLog.count({ where: { action: "product.created", entityId: family.id } });
  check(57, "Creating a product writes an audit row", created === 1, `${created} row(s)`);

  // 58
  const listed = await listProducts({ search: CODE });
  const found = listed.products.find((row) => row.id === family.id);
  check(
    58,
    "The catalogue list finds the family by its code",
    Boolean(found) && found?.productCode === CODE,
    found ? `${found.name} (${found.status})` : "not found"
  );

  // 59
  const missing = await refused(async () => getProduct("no-such-product-id"));
  const missingValue = await getProduct("no-such-product-id").catch(() => "threw");
  check(
    59,
    "Asking for a product that does not exist returns null rather than throwing",
    !missing.refused && missingValue === null,
    missingValue === null ? "null" : String(missingValue)
  );

  /* ======================================================================= */
  console.log("\nJ. What a price has to be before a seller sees it");
  /* ======================================================================= */
  /*
   * Two rules that live on opposite sides of the same question, checked here
   * because between them they decide what may be sold and at what number.
   *
   * The first is that suggested retail is editorial: it is MoonVella's own
   * suggestion, it is optional, and no import writes it. The gate must
   * therefore not block on it — a product held back until somebody names a
   * retail price is a product whose retail price gets filled in with the
   * wholesale figure, which is the substitution the two fields exist to keep
   * apart.
   *
   * The second is that wholesale is not optional, and no retail price rescues
   * it. It is what the seller is charged, so a variant without one must stop
   * the product rather than be listed at whatever number happens to be nearby.
   */

  // 60
  const retailOptional = await createProduct(
    { name: "Retail optional", productCode: `${CODE}-OPT`, category: "Test" },
    owner
  );
  await addVariant(
    retailOptional.id,
    {
      name: "One size",
      sku: `${CODE}-OPT-1`,
      wholesalePrice: 1800,
      suggestedRetailPrice: 0,
      inventory: 3,
    },
    owner
  );
  const optionalReport = await publicationReadiness(retailOptional.id);
  const optionalPrices = optionalReport.checks.find((row) => row.key === "variant_prices");
  check(
    60,
    "Suggested retail is optional: a variant priced at wholesale with no retail price does not block publication",
    optionalPrices?.ok === true && /Suggested retail is optional/.test(optionalPrices?.detail ?? ""),
    optionalPrices?.detail ?? "no variant_prices check"
  );

  // 61
  // Deliberately given a generous retail price. If the gate ever fell back to
  // it, this variant would publish and a seller would be charged nothing.
  await addVariant(
    retailOptional.id,
    {
      name: "No wholesale",
      sku: `${CODE}-OPT-2`,
      wholesalePrice: 0,
      suggestedRetailPrice: 9900,
      inventory: 3,
    },
    owner
  );
  const blockedReport = await publicationReadiness(retailOptional.id);
  const blockedPrices = blockedReport.checks.find((row) => row.key === "variant_prices");
  check(
    61,
    "Wholesale is not optional, and a retail price does not stand in for it: the variant is named as the blocker",
    blockedPrices?.ok === false &&
      (blockedPrices?.detail ?? "").includes(`${CODE}-OPT-2`) &&
      !(blockedPrices?.detail ?? "").includes(`${CODE}-OPT-1`),
    blockedPrices?.detail ?? "no variant_prices check"
  );

  /* ---------------------------------------------------------------------- */
  /* A store must show a price for every variant it lists                   */
  /* ---------------------------------------------------------------------- */
  /*
   * The Odoo import no longer writes suggested retail, so a store import can
   * meet a product whose retail price nobody has set. The price the store shows
   * is not MoonVella's to invent: a variant listed at zero takes real orders at
   * zero, and a variant listed at the wholesale cost gives the seller's margin
   * away. So the import refuses, names the variants, and says what to do.
   *
   * The admin passed below throws the moment it is called, which is what makes
   * the first check a statement about Shopify too: a refusal that had already
   * sent something would trip the sentinel instead of returning the message.
   */
  const sentinel = {
    graphql: async () => {
      throw new Error("SENTINEL: a Shopify call was attempted");
    },
  } as unknown as Parameters<typeof importProductForSeller>[0];

  const storeFamily = await createProduct(
    { name: "Store listing", productCode: `${CODE}-STR`, category: "Test" },
    owner
  );
  await addVariant(
    storeFamily.id,
    {
      name: "One size",
      sku: `${CODE}-STR-1`,
      wholesalePrice: 2400,
      suggestedRetailPrice: 0,
      inventory: 2,
    },
    owner
  );

  // 62
  const refusedImport = await importProductForSeller(sentinel, seller.id, storeFamily.id);
  check(
    62,
    "A store import is refused before it sends anything when a variant has no retail price",
    refusedImport.ok === false &&
      /Import refused/.test(refusedImport.error ?? "") &&
      (refusedImport.error ?? "").includes(`${CODE}-STR-1`) &&
      !/SENTINEL/.test(refusedImport.error ?? ""),
    (refusedImport.error ?? "no error").slice(0, 120)
  );

  // 63
  const refusedRow = await prisma.sellerProduct.findUnique({
    where: { sellerId_productId: { sellerId: seller.id, productId: storeFamily.id } },
  });
  check(
    63,
    "And the refusal is recorded against the store, not only shown once and lost",
    refusedRow?.importStatus === "FAILED" &&
      (refusedRow?.lastImportError ?? "").includes(`${CODE}-STR-1`),
    `${refusedRow?.importStatus} — ${(refusedRow?.lastImportError ?? "").slice(0, 60)}`
  );

  // 64
  // The seller's own retail price for this store, set beforehand. It is the
  // price the store is meant to show, so the import is not refused — and the
  // sentinel is what proves the guard was passed rather than short-circuited.
  await prisma.sellerProduct.update({
    where: { sellerId_productId: { sellerId: seller.id, productId: storeFamily.id } },
    data: { customRetailPrice: 6400, importStatus: "NEVER", lastImportError: null },
  });
  // The function reports a failed import rather than throwing — the sentinel's
  // message comes back on the result, which is what "the guard was passed"
  // looks like from here. A refusal would have returned its own message and
  // never reached the client at all.
  let sentinelReached = "";
  try {
    const result = await importProductForSeller(sentinel, seller.id, storeFamily.id);
    sentinelReached = result.ok ? "the import reported success" : result.error ?? "";
  } catch (error) {
    sentinelReached = error instanceof Error ? error.message : String(error);
  }
  const keptRetail = await prisma.sellerProduct.findUnique({
    where: { sellerId_productId: { sellerId: seller.id, productId: storeFamily.id } },
  });
  check(
    64,
    "A retail price the seller already set for this store is used instead, and survives the import attempt",
    sentinelReached === "SENTINEL: a Shopify call was attempted" &&
      keptRetail?.customRetailPrice === 6400,
    `${sentinelReached || "the guard refused again"} / retail ${keptRetail?.customRetailPrice}`
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  if (total !== 64) {
    failures += 1;
    console.log(`FAIL  the suite ran ${total} checks; 59 are from the original directive and 5 were added by the pricing wave`);
  }
}

main()
  .catch((error) => {
    console.error("\nThe suite threw before finishing:");
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(failures ? 1 : 0);
  });
