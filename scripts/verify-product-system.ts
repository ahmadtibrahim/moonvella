/**
 * Phase 21 — the numbered acceptance suite for the product, variant, media,
 * document and marketing system.
 *
 * EIGHTY-SIX CHECKS, IN TEN GROUPS. The numbering is not decoration: each
 * group corresponds to one promise the directive makes, and `check()` asserts
 * that the number it is handed is the next one, so a check cannot be dropped or
 * reordered without the suite failing on the numbering itself. The first
 * fifty-nine are the directive's; group J was added when Odoo became the
 * pricing authority, and covers the two price rules that decide what may be
 * listed — that suggested retail is optional, and that wholesale is not. Two
 * more were added when the seller's price moved from the family to the
 * variant: one for the old family price still being honoured, one for the two
 * numbers a store is actually given. The final two cover the inventory push:
 * who a quantity change is sent to, and that this suite sends it to nobody.
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
  setPrimaryAssignment,
  reorderAssignment,
  supersedeDocument,
  documentHistory,
  listProductMedia,
  generalGallery,
  orderForVariant,
  inheritanceSummary,
  DuplicateMediaError,
  type MediaAssetView,
} from "../app/services/media.server";
import { publicationReadiness } from "../app/services/publication.server";
import { previewMarketingPack, buildMarketingPack } from "../app/services/marketingPack.server";
import { permissionsFor, can } from "../app/services/permissions";
import { checkProductCode, PRODUCT_CODE_HELP } from "../app/utils/productCode";
import { isSafeEntryPath } from "../app/utils/zip";
import { intakeOrder } from "../app/services/orderIntake.server";
import { importProductForSeller, retailPriceFor, sellerCostFor } from "../app/services/shopifyImport.server";
import { readObject, deleteObject, objectExists } from "../app/services/storage.server";
import { planInventoryPush, pushInventoryForVariants } from "../app/services/inventoryPush.server";

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
  await prisma.mediaAsset.create({
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
    "The inheritance summary counts general product assets and per-variant assets separately",
    summary.general === 1 && summary.perVariant[measured.id] === 1 && summary.perVariant[second.id] === 1,
    `general ${summary.general}, first variant ${summary.perVariant[measured.id] ?? 0}, second ${summary.perVariant[second.id] ?? 0}`
  );

  /*
   * 22 — THE GALLERY RULE, AND IT IS A REPLACEMENT RATHER THAN AN ORDER.
   *
   * This check used to assert that a variant's own image came FIRST and the
   * general one followed it. That was the mixing rule, and mixing is what the
   * seller's storefront must not do: a shopper who has chosen Queen is looking
   * at Queen, and a photograph of the Standard size next to it reads as a
   * second, worse picture of the same thing. So the selected size's own media
   * is the whole gallery, and the general gallery is what a size with nothing
   * of its own falls back to — which is check 24 below, and check 70.
   */
  const ordered = orderForVariant(media, measured.id);
  const ownIndex = ordered.findIndex((row) => row.asset.id === lifestyle.id);
  const generalIndex = ordered.findIndex((row) => row.asset.id === shared.id);
  check(
    22,
    "A size with its own media shows only its own — the general gallery is not mixed in",
    ownIndex >= 0 && generalIndex === -1,
    `own at position ${ownIndex}, general asset at ${generalIndex}` +
      ` (${ordered.length} entr${ordered.length === 1 ? "y" : "ies"} offered)`
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
  /*
   * THE FALLBACK NEEDS A SIZE THAT GENUINELY HAS NOTHING OF ITS OWN.
   *
   * This check used to read `second` and pass, and it passed for the wrong
   * reason. Every size in this fixture is attached to `lifestyle` (check 20), so
   * what it was actually measuring was the old mixing rule — a size's own media
   * with the general gallery appended after it. That rule is gone, and check 22
   * above asserts its replacement: a size with its own media shows its own media
   * and nothing else. So the subject of this check has to be a size with no
   * media at all, which the fixture does not have until one is made here.
   *
   * It is made rather than borrowed because borrowing is what made the check
   * lie, and because the state it exercises — a size nobody has photographed yet
   * — is the ordinary state of a new size. Re-attaching `shared` to the family
   * afterwards is also the proof that detaching did not mutate the file.
   */
  const bare = await addVariant(
    family.id,
    {
      name: "Unphotographed size",
      sku: `${CODE}-BARE`,
      wholesalePrice: 1799,
      suggestedRetailPrice: 5900,
      inventory: 1,
    },
    owner
  );
  await attachMediaToVariants(shared.id, [], owner);
  const mediaAgain = await listProductMedia(family.id);
  const bareGallery = orderForVariant(mediaAgain, bare.id);
  check(
    24,
    "A size with no image of its own falls back to the general gallery, marked as not its own",
    bareGallery.some((row) => row.asset.id === shared.id && !row.isOwn) &&
      bareGallery.every((row) => !row.isOwn),
    `${bareGallery.length} image(s) for a size with none of its own: ` +
      `${bareGallery.map((row) => `${row.asset.title}${row.isOwn ? " (own)" : ""}`).join(", ") || "none"}`
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

  /*
   * 32 — WITHDRAWAL, NOT MODERATION.
   *
   * This check used to upload a creative and assert it was excluded for being
   * unapproved. Nothing is unapproved any more: an upload from the Admin Panel
   * is written approved and switched on, so a fresh upload belongs in the pack.
   * The state that still exists — and that a merchant reaches for — is a file
   * they have switched off, and the reason has to say so rather than leave them
   * hunting for a missing asset.
   */
  const hiddenCreative = await upload(family.id, pngBytes(1080, 1080, 0x55), "square-post.png", "image/png", {
    category: "MARKETING_CREATIVE",
    subtype: "SQUARE_POST",
    title: "Square social post",
    altText: "A square social post",
  });
  await updateMedia(hiddenCreative.id, { sellerVisible: false }, owner);
  const preview = await previewMarketingPack(family.id);
  const excludedDraft = preview?.excluded.find((row) => row.title === "Square social post");
  check(
    32,
    "An upload arrives approved and switched on; switched off, it leaves the pack and says why",
    hiddenCreative.approvalStatus === "APPROVED" &&
      hiddenCreative.sellerVisible &&
      Boolean(excludedDraft) &&
      /not marked visible/i.test(excludedDraft!.reason),
    `${hiddenCreative.approvalStatus}, sellerVisible=${hiddenCreative.sellerVisible}, ` +
      `excluded as "${excludedDraft?.reason ?? "not excluded"}"`
  );

  // 33
  // The archive is only produced for a published product, so switch on what
  // should ship and publish the family first. `setMediaApproval` is called even
  // though an upload now arrives approved: it is the moderation path a
  // seller-submitted file will use, and this is what keeps it exercised.

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
      refusedPublish.message.includes("At least one active, seller-visible product image"),
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
  // The seller's own retail price for this variant, set beforehand. It is the
  // price the store is meant to show, so the import is not refused — and the
  // sentinel is what proves the guard was passed rather than short-circuited.
  //
  // It is written to `SellerVariantPrice`, the table the seller's own screen
  // writes, and NOT to the family's older column: the import must read the
  // price the seller set for the size, and a test that satisfied it through the
  // legacy fallback would pass while the real path was broken.
  const strVariant = await prisma.productVariant.findFirstOrThrow({
    where: { sku: `${CODE}-STR-1` },
    select: { id: true },
  });
  await prisma.sellerProduct.update({
    where: { sellerId_productId: { sellerId: seller.id, productId: storeFamily.id } },
    data: { importStatus: "NEVER", lastImportError: null },
  });
  await prisma.sellerVariantPrice.create({
    data: { sellerId: seller.id, productVariantId: strVariant.id, retailPrice: 6400 },
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
  const keptRetail = await prisma.sellerVariantPrice.findUnique({
    where: {
      sellerId_productVariantId: { sellerId: seller.id, productVariantId: strVariant.id },
    },
  });
  check(
    64,
    "A retail price the seller already set for this variant is used instead, and survives the import attempt",
    sentinelReached === "SENTINEL: a Shopify call was attempted" &&
      keptRetail?.retailPrice === 6400,
    `${sentinelReached || "the guard refused again"} / retail ${keptRetail?.retailPrice}`
  );

  /* ======================================================================= */
  console.log("\nI. What multi-file upload depends on");
  /* ======================================================================= */
  /*
   * The batch uploader sends one request per file and has to decide, for each
   * card on screen, whether that file is now ON the product (retire the card),
   * or is still the operator's to retry (keep it, with its metadata). That
   * decision is made from the error TYPE and two fields on it, so both are
   * asserted here rather than left to a message string — a reworded sentence
   * must not turn a duplicate into an endless retry.
   *
   * The last check is the one a person actually hits: the same file added twice
   * to the product while being assigned to different variants. Deduplication is
   * per product, so the second upload is refused even though the assignment
   * differs — and the refusal says what to do instead, because the operator's
   * intent (this file on that variant) is legitimate and reachable.
   */
  const batchBytes = pngBytes(220, 160, 0xe1);
  const batchAssignment = [measured.id, second.id];
  const mediaCountBefore = await prisma.mediaAsset.count({ where: { productId: family.id } });

  // 65
  const batchFirst = await upload(family.id, batchBytes, "batch-one.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    title: "Batch upload one",
    altText: "First file of a batch",
    variantIds: batchAssignment,
  });
  const batchSecond = await upload(family.id, pngBytes(220, 160, 0xe2), "batch-two.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    title: "Batch upload two",
    altText: "Second file of a batch",
  });
  const batchRows = await prisma.mediaAsset.findMany({
    where: { id: { in: [batchFirst.id, batchSecond.id] } },
    select: { id: true, checksum: true, storageKey: true },
  });
  check(
    65,
    "Two files in one batch are two assets, each with its own bytes on disk",
    batchRows.length === 2 &&
      batchRows[0].checksum !== batchRows[1].checksum &&
      (await objectExists(batchRows[0].storageKey)) &&
      (await objectExists(batchRows[1].storageKey)),
    `${batchRows.length} row(s), both objects present`
  );

  // 66
  const assigned = await prisma.mediaAssetAssignment.findMany({
    where: { assetId: batchFirst.id },
    select: { variantId: true },
  });
  check(
    66,
    "A file's own variant selection is what it is attached to, not the previous file's",
    batchAssignment.length > 0 &&
      assigned.length === batchAssignment.length &&
      assigned.every((row) => row.variantId !== null && batchAssignment.includes(row.variantId)),
    `${assigned.length} of ${batchAssignment.length} selected variant(s) attached`
  );

  // 67
  let duplicateError: unknown = null;
  try {
    await uploadMedia(
      family.id,
      fileOf(batchBytes, "batch-one-again.png", "image/png"),
      { category: "LIFESTYLE_IMAGE", title: "The same file, second time" },
      owner
    );
  } catch (error) {
    duplicateError = error;
  }
  const duplicateTyped = duplicateError instanceof DuplicateMediaError;
  check(
    67,
    "A repeated file is refused as a DuplicateMediaError carrying the asset it matched",
    duplicateTyped &&
      (duplicateError as DuplicateMediaError).assetId === batchFirst.id &&
      /Batch upload one/.test((duplicateError as DuplicateMediaError).existingTitle),
    duplicateTyped
      ? `assetId matches=${(duplicateError as DuplicateMediaError).assetId === batchFirst.id}`
      : String(duplicateError)
  );

  // 68
  const afterDuplicate = await prisma.mediaAsset.count({ where: { productId: family.id } });
  const originalStillThere = await prisma.mediaAsset.findUnique({
    where: { id: batchFirst.id },
    select: { storageKey: true },
  });
  check(
    68,
    "The refused copy stores nothing and the original's bytes are untouched",
    afterDuplicate === mediaCountBefore + 2 &&
      !!originalStillThere &&
      (await objectExists(originalStillThere.storageKey)),
    `${afterDuplicate} asset(s) on the product, original object present`
  );

  // 69
  let secondDuplicate: unknown = null;
  try {
    await uploadMedia(
      family.id,
      fileOf(batchBytes, "batch-one-third.png", "image/png"),
      { category: "LIFESTYLE_IMAGE", title: "Same bytes, different variants", variantIds: [] },
      owner
    );
  } catch (error) {
    secondDuplicate = error;
  }
  check(
    69,
    "Deduplication is per product, not per assignment, and the refusal says how to attach it instead",
    secondDuplicate instanceof DuplicateMediaError &&
      /attach the existing asset/i.test((secondDuplicate as DuplicateMediaError).message),
    secondDuplicate instanceof DuplicateMediaError
      ? (secondDuplicate as DuplicateMediaError).message
      : String(secondDuplicate)
  );


  /* ======================================================================= */
  console.log("\nJ. Product media against variant media, and the Publish gate");
  /* ======================================================================= */
  /*
   * THE TWO SCOPES, AND THE FOUR THINGS A SELLER SEES.
   *
   * A product has one gallery of its own — general product media, attached to
   * the family rather than to a size — and each size may have its own. What a
   * shopper sees is decided by one rule, and these checks are that rule:
   *
   *   1. Nothing is selected: the general gallery, the primary image first.
   *   2. A size is selected that has media: that size's media, and nothing
   *      else. Not the general gallery, and above all not another size's.
   *   3. A size is selected that has none: the general gallery.
   *   4. The selection is cleared: back to 1, unchanged.
   *
   * It is built on a fresh product with Standard, Queen and King because the
   * failure this replaces was reported in exactly those terms, and because the
   * family used by the earlier groups has been through thirty checks by now.
   */
  const gallery = await createProduct(
    {
      name: "Gallery Family",
      productCode: `${CODE}-G`,
      category: "Test",
      description: "A family used to verify the product and variant media scopes.",
    },
    owner
  );
  const standard = await addVariant(
    gallery.id,
    { name: "Standard", sku: `${CODE}-G-STD`, wholesalePrice: 1000, suggestedRetailPrice: 2000, inventory: 5 },
    owner
  );
  const queen = await addVariant(
    gallery.id,
    { name: "Queen", sku: `${CODE}-G-QN`, wholesalePrice: 1200, suggestedRetailPrice: 2400, inventory: 5 },
    owner
  );
  const king = await addVariant(
    gallery.id,
    { name: "King", sku: `${CODE}-G-KG`, wholesalePrice: 1400, suggestedRetailPrice: 2800, inventory: 5 },
    owner
  );
  await setDefaultVariant(standard.id, owner);

  // The picture of the product itself, showing all three sizes — the one the
  // catalogue card is drawn from.
  const groupShot = await upload(gallery.id, pngBytes(1600, 900, 0x71), "group-shot.png", "image/png", {
    category: "WHITE_BACKGROUND_IMAGE",
    title: "Cooling Pillow",
    altText: "The cooling pillow in all three sizes",
  });
  const roomShot = await upload(gallery.id, pngBytes(1600, 900, 0x72), "room-shot.png", "image/png", {
    category: "LIFESTYLE_IMAGE",
    title: "Cooling pillow on a bed",
    altText: "The cooling pillow on a made bed",
  });
  const standardFront = await upload(gallery.id, pngBytes(900, 900, 0x73), "standard-front.png", "image/png", {
    category: "WHITE_BACKGROUND_IMAGE",
    title: "Standard front",
    altText: "The Standard size, front",
    variantIds: [standard.id],
  });
  const queenFront = await upload(gallery.id, pngBytes(900, 900, 0x74), "queen-front.png", "image/png", {
    category: "WHITE_BACKGROUND_IMAGE",
    title: "Queen front",
    altText: "The Queen size, front",
    variantIds: [queen.id],
  });

  // 70
  const galleryMedia = await listProductMedia(gallery.id);
  const general = generalGallery(galleryMedia);
  check(
    70,
    "The general gallery is the product's own media — no size's photographs appear in it",
    general.length === 2 &&
      general.every((row) => !row.isOwn) &&
      general.some((row) => row.asset.id === groupShot.id) &&
      general.every((row) => row.asset.id !== standardFront.id && row.asset.id !== queenFront.id),
    `${general.length} general asset(s): ${general.map((row) => row.asset.title).join(", ")}`
  );

  // 71
  await setPrimaryAssignment(
    (await prisma.mediaAssetAssignment.findFirst({
      where: { assetId: groupShot.id, variantId: null },
      select: { id: true },
    }))!.id,
    owner
  );
  const withPrimary = generalGallery(await listProductMedia(gallery.id));
  check(
    71,
    "The product primary image leads the general gallery",
    withPrimary[0]?.asset.id === groupShot.id && withPrimary[0].isPrimary,
    `${withPrimary[0]?.asset.title ?? "nothing"} first, primary=${withPrimary[0]?.isPrimary}`
  );

  // 72
  const queenGallery = orderForVariant(await listProductMedia(gallery.id), queen.id);
  check(
    72,
    "Selecting a size shows that size's media alone — no general media, no other size's",
    queenGallery.length === 1 &&
      queenGallery[0].asset.id === queenFront.id &&
      queenGallery[0].isOwn &&
      !queenGallery.some((row) => row.asset.id === groupShot.id || row.asset.id === standardFront.id),
    `${queenGallery.length} entr${queenGallery.length === 1 ? "y" : "ies"}: ` +
      `${queenGallery.map((row) => row.asset.title).join(", ") || "none"}`
  );

  // 73
  const kingGallery = orderForVariant(await listProductMedia(gallery.id), king.id);
  check(
    73,
    "A size with no media of its own falls back to the general gallery rather than showing nothing",
    kingGallery.length === 2 &&
      kingGallery.every((row) => !row.isOwn) &&
      kingGallery.some((row) => row.asset.id === groupShot.id),
    `${kingGallery.length} entr${kingGallery.length === 1 ? "y" : "ies"} for a size with none of its own`
  );

  // 74
  const cleared = generalGallery(await listProductMedia(gallery.id));
  check(
    74,
    "Clearing the selection returns the general gallery, unchanged",
    cleared.length === 2 && cleared[0]?.asset.id === groupShot.id,
    `${cleared.length} general asset(s), ${cleared[0]?.asset.title ?? "nothing"} first`
  );

  // 75
  /*
   * ONE PRIMARY, AND THE PREVIOUS HOLDER LOSES IT IN THE SAME WRITE.
   *
   * Two primaries would make "which picture represents this product" depend on
   * row order, and the gate blocks publication over it — but the block is the
   * backstop. This is the write that has to be exclusive.
   */
  await setPrimaryAssignment(
    (await prisma.mediaAssetAssignment.findFirst({
      where: { assetId: roomShot.id, variantId: null },
      select: { id: true },
    }))!.id,
    owner
  );
  const afterSwap = await prisma.mediaAssetAssignment.findMany({
    where: { variantId: null, isPrimary: true, asset: { productId: gallery.id } },
    select: { assetId: true },
  });
  check(
    75,
    "Setting a new product primary clears the previous one in the same transaction",
    afterSwap.length === 1 && afterSwap[0].assetId === roomShot.id,
    `${afterSwap.length} primary row(s) after the swap`
  );

  // 76
  /*
   * A VIDEO IS NOT A PICTURE, so it cannot be the product's primary image. The
   * catalogue card, the storefront thumbnail and the before-a-size-is-chosen
   * gallery are all image slots; a video in one of them is a blank card with a
   * play button at best.
   */
  const galleryVideo = await prisma.mediaAsset.create({
    data: {
      productId: gallery.id,
      category: "PRODUCT_VIDEO",
      title: "Product clip",
      originalFilename: "clip.mp4",
      storageKey: `gallery-${suffix.toLowerCase()}-clip`,
      mimeType: "video/mp4",
      fileSize: 2048,
      checksum: `gallery-clip-${suffix}`,
      processingStatus: "READY",
      durationSeconds: 5,
      approvalStatus: "APPROVED",
      sellerVisible: true,
      altText: "A five second clip of the pillow",
    },
  });
  await attachMediaToVariants(galleryVideo.id, [], owner);
  const videoAssignment = (
    await prisma.mediaAssetAssignment.findFirst({
      where: { assetId: galleryVideo.id, variantId: null },
      select: { id: true },
    })
  )!;
  const videoPrimary = await refused(() => setPrimaryAssignment(videoAssignment.id, owner));
  const stillOne = await prisma.mediaAssetAssignment.count({
    where: { variantId: null, isPrimary: true, asset: { productId: gallery.id } },
  });
  check(
    76,
    "A video cannot be made the product's primary image, and the refusal says to choose a photograph",
    videoPrimary.refused && /not an image/.test(videoPrimary.message) && stillOne === 1,
    videoPrimary.message.split("\n")[0] || "the video was accepted as primary"
  );

  // 77
  /*
   * ORDER IS THE MERCHANT'S, NOT THE DATABASE'S. Moving an image up inside a
   * scope is what puts the second photograph on the product page second, so it
   * has to survive a read.
   */
  const roomAssignment = (
    await prisma.mediaAssetAssignment.findFirst({
      where: { assetId: roomShot.id, variantId: null },
      select: { id: true },
    })
  )!;
  await reorderAssignment(roomAssignment.id, "down", owner);
  const reordered = await prisma.mediaAssetAssignment.findMany({
    where: { variantId: null, asset: { productId: gallery.id } },
    orderBy: { sortOrder: "asc" },
    select: { sortOrder: true },
  });
  check(
    77,
    "Reordering an attachment writes one order for the scope, with no duplicate positions",
    new Set(reordered.map((row) => row.sortOrder)).size === reordered.length,
    `positions ${reordered.map((row) => row.sortOrder).join(", ")}`
  );

  // 78
  /*
   * PUBLICATION, AS THE GATE NOW SEES IT.
   *
   * The two checks below are the ones the reported failure was about: media
   * that is READY and switched on satisfies the seller-image rule, and the
   * product-level primary satisfies the primary rule — with no approve step
   * anywhere in between.
   */
  await updateProduct(
    gallery.id,
    {
      name: "Gallery Family",
      productCode: `${CODE}-G`,
      category: "Test",
      description: "A family used to verify the product and variant media scopes.",
    },
    owner
  );
  const galleryReport = await publicationReadiness(gallery.id);
  const imageCheck = galleryReport.checks.find((row) => row.key === "seller_image");
  const primaryCheck = galleryReport.checks.find((row) => row.key === "primary_image");
  check(
    78,
    "Admin-uploaded READY media satisfies the seller-image rule, and the product primary satisfies the primary rule",
    imageCheck?.ok === true && primaryCheck?.ok === true,
    `seller_image=${imageCheck?.ok}, primary_image=${primaryCheck?.ok}`
  );

  // 79
  const beforePublish = await prisma.product.findUnique({ where: { id: gallery.id }, select: { status: true } });
  await setPublished(gallery.id, true, owner);
  const afterPublish = await prisma.product.findUnique({ where: { id: gallery.id }, select: { status: true } });
  const publishAudit = await prisma.auditLog.findFirst({
    where: { entityId: gallery.id, action: "product.published" },
    orderBy: { createdAt: "desc" },
    select: { actorId: true, createdAt: true },
  });
  check(
    79,
    "Publishing moves DRAFT to PUBLISHED and records who did it, in the same transaction",
    beforePublish?.status === "DRAFT" &&
      afterPublish?.status === "PUBLISHED" &&
      Boolean(publishAudit) &&
      publishAudit?.actorId === owner.actorId,
    `${beforePublish?.status} → ${afterPublish?.status}, actor recorded=${Boolean(publishAudit)}`
  );

  // 80
  const republished = await setPublished(gallery.id, true, owner);
  const publishAudits = await prisma.auditLog.count({
    where: { entityId: gallery.id, action: "product.published" },
  });
  check(
    80,
    "A second Publish is idempotent — the product stays published and nothing else changes",
    republished.status === "PUBLISHED" && publishAudits === 2,
    `${republished.status}, ${publishAudits} publish record(s)`
  );

  // 81
  /*
   * PUBLISHING IS PER PRODUCT. A gate that read the catalogue rather than the
   * product would let a draft through on the strength of somebody else's
   * finished work, and the check for that is simply that a second, unfinished
   * family is still a draft after the first one goes live.
   */
  const unrelated = await createProduct(
    {
      name: "Unrelated Family",
      productCode: `${CODE}-U`,
      category: "Test",
      description: "",
    },
    owner
  );
  const unrelatedRow = await prisma.product.findUnique({ where: { id: unrelated.id }, select: { status: true } });
  const unrelatedRefusal = await refused(() => setPublished(unrelated.id, true, owner));
  check(
    81,
    "Publishing one product does not publish another, and an unfinished one is refused",
    unrelatedRow?.status === "DRAFT" && unrelatedRefusal.refused,
    `${unrelatedRow?.status}, refused=${unrelatedRefusal.refused}`
  );

  // 82
  const refusedReport = await publicationReadiness(unrelated.id);
  check(
    82,
    "The refusal lists every blocker with the tab that resolves it, and none of them is an approval state",
    refusedReport.blockers.length >= 3 &&
      refusedReport.blockers.every((row) => Boolean(row.tab) && Boolean(row.detail)) &&
      !refusedReport.checks.some((row) => /approv/i.test(row.label)),
    `${refusedReport.blockers.length} blocker(s): ${refusedReport.blockers.map((row) => row.key).join(", ")}`
  );

  // 83
  /*
   * THE OLD FAMILY-LEVEL PRICE IS STILL HONOURED, and this check is what keeps
   * it that way. A store that set one price for a family under the screen that
   * had a single box was listed at that price. The price now belongs to the
   * variant, and the family figure has to keep pricing every variant that has
   * none of its own — otherwise the next import silently moves that store to
   * MoonVella's suggested retail, which is a price change nobody chose. Written
   * directly, because the screen that produced this state no longer exists.
   */
  await prisma.sellerVariantPrice.deleteMany({
    where: { sellerId: seller.id, productVariantId: strVariant.id },
  });
  await prisma.sellerProduct.update({
    where: { sellerId_productId: { sellerId: seller.id, productId: storeFamily.id } },
    data: { customRetailPrice: 5100 },
  });
  let legacyReached = "";
  try {
    const result = await importProductForSeller(sentinel, seller.id, storeFamily.id);
    legacyReached = result.ok ? "the import reported success" : result.error ?? "";
  } catch (error) {
    legacyReached = error instanceof Error ? error.message : String(error);
  }
  check(
    83,
    "A price set under the old family-level screen still prices every variant that has none of its own",
    legacyReached === "SENTINEL: a Shopify call was attempted",
    legacyReached || "the guard refused, so the family price was not read"
  );

  // 84
  /*
   * THE TWO NUMBERS A STORE IS GIVEN, AT THE MOMENT THEY ARE FORMATTED.
   *
   * `retailPriceFor` is what the listing is priced at: the seller's own figure
   * when they have set one, and the catalogue's recommendation when they have
   * not. There is no third path — the markup percentage that used to be applied
   * here is gone, and a price the seller typed must reach Shopify unchanged
   * rather than multiplied by anything.
   *
   * `sellerCostFor` is what the variant costs THE SELLER, which is the price
   * MoonVella invoices and not MoonVella's own acquisition cost. Sending the
   * latter was the defect: a store whose "cost per item" is below what it
   * actually pays believes it is profitable on every unit it loses money on.
   */
  check(
    84,
    "The listed price is the seller's own figure or the catalogue's, and the cost sent is what the seller pays",
    retailPriceFor(12800, 14900) === "149.00" &&
      retailPriceFor(12800, null) === "128.00" &&
      retailPriceFor(12800, undefined) === "128.00" &&
      sellerCostFor(5999) === 59.99,
    `${retailPriceFor(12800, 14900)} / ${retailPriceFor(12800, null)} / cost ${sellerCostFor(5999)}`
  );

  // 85
  /*
   * WHO A QUANTITY CHANGE IS SENT TO, DECIDED WITHOUT CALLING ANYONE.
   *
   * The push itself is a Shopify call, so the suite runs with it switched off —
   * see `NO_INVENTORY_PUSH` in run-verify.mjs; the clone's mappings point at a
   * real store's inventory items and a suite must not move a shelf. What is
   * tested instead is the whole of the decision: the store that is approved and
   * has an inventory item is told, and each of the three reasons not to tell one
   * — a store that is not approved, a mapping the import never recorded a
   * Shopify inventory item for, and the seller's own auto-sync switch — keeps
   * that store's shelf exactly as it is.
   *
   * The switch being off is itself checked, because a suite that silently
   * pushed would be the failure this whole arrangement exists to prevent.
   */
  const planned = planInventoryPush([
    {
      mappingId: "m1",
      shopifyInventoryItemId: "gid://shopify/InventoryItem/1",
      shopifyLocationId: null,
      sellerId: "s1",
      shopDomain: "one.myshopify.com",
      sellerStatus: "APPROVED",
      autoSyncInventory: true,
    },
    {
      mappingId: "m2",
      shopifyInventoryItemId: "gid://shopify/InventoryItem/2",
      shopifyLocationId: null,
      sellerId: "s1",
      shopDomain: "one.myshopify.com",
      sellerStatus: "APPROVED",
      autoSyncInventory: true,
    },
    {
      mappingId: "m3",
      shopifyInventoryItemId: "gid://shopify/InventoryItem/3",
      shopifyLocationId: null,
      sellerId: "s2",
      shopDomain: "two.myshopify.com",
      sellerStatus: "PENDING",
      autoSyncInventory: true,
    },
    {
      mappingId: "m4",
      shopifyInventoryItemId: null,
      shopifyLocationId: null,
      sellerId: "s3",
      shopDomain: "three.myshopify.com",
      sellerStatus: "APPROVED",
      autoSyncInventory: true,
    },
    {
      mappingId: "m5",
      shopifyInventoryItemId: "gid://shopify/InventoryItem/5",
      shopifyLocationId: null,
      sellerId: "s4",
      shopDomain: "four.myshopify.com",
      sellerStatus: "APPROVED",
      autoSyncInventory: false,
    },
  ]);
  const plannedOne = planned.byStore.get("s1") ?? [];
  check(
    85,
    "A quantity goes to approved stores that have an inventory item and auto-sync on, and to nobody else",
    planned.byStore.size === 1 &&
      plannedOne.length === 2 &&
      plannedOne.every((candidate) => candidate.shopifyInventoryItemId) &&
      planned.skipped.length === 3 &&
      planned.skipped.every((row) => Boolean(row.reason)) &&
      ["s2", "s3", "s4"].every(
        (sellerId) => !planned.byStore.has(sellerId)
      ),
    `${planned.byStore.size} store(s), ${plannedOne.length} in it, ${planned.skipped.length} skipped: ${planned.skipped
      .map((row) => row.reason)
      .join(" / ")}`
  );

  // 86
  /*
   * AND NOTHING LEAVES THE PROCESS WHILE THE SUITE IS RUNNING.
   *
   * The switch is the promise this suite makes to the storefront the clone was
   * taken from. It is asserted rather than assumed, so the day somebody runs a
   * suite without the runner's environment, this fails instead of quietly
   * writing quantities into a store.
   */
  const pushOutcome = await pushInventoryForVariants([]);
  const disabledOutcome = await pushInventoryForVariants([measured.id]);
  check(
    86,
    "With the push switched off, a push reports that it reached no store instead of reaching one",
    pushOutcome.pushed === 0 &&
      disabledOutcome.disabled === true &&
      disabledOutcome.pushed === 0 &&
      disabledOutcome.failures.length === 0 &&
      disabledOutcome.quantities.length === 1,
    `disabled=${disabledOutcome.disabled} pushed=${disabledOutcome.pushed} considered=${disabledOutcome.quantities.length}`
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  if (total !== 86) {
    failures += 1;
    console.log(`FAIL  the suite ran ${total} checks; 59 are from the original directive, 5 from the pricing wave, 5 from the shipping-and-media wave, 13 from the media-scope and publication correction, 2 from the seller-pricing wave and 2 from the inventory-push wave`);
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
