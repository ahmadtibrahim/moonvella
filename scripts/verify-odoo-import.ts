/**
 * The first Odoo catalogue import.
 *
 * WHAT THIS SUITE IS FOR. The import has two halves and only one of them runs
 * here. Half of it talks to Odoo, and there is no Odoo connection in this
 * environment — which is not an obstacle to the suite but the condition it is
 * written for, because the directive is explicit about what must happen when the
 * connection is not ready: a genuine blocker, and no sample inventory standing
 * in for the real thing. So the run below asserts that the import refuses, that
 * the refusal names the missing connection and what to do about it, and that
 * nothing at all was written while it refused.
 *
 * The other half is the part that will run against a real Odoo, and it is
 * checked by reading the code rather than by calling it: that eligibility is the
 * mapped product tag and not a guess, that prices come from the per-variant list
 * price, that quantities are read at import time and never invented, that the
 * import writes drafts, that a re-import cannot blank MoonVella-added media, and
 * that nothing in this module writes to Odoo.
 *
 * WHAT IT DOES NOT DO. It makes no Odoo call, writes no product, and touches no
 * inventory. The figures the preview will report when Odoo is connected are
 * verified against the test catalogue separately, with the owner's key.
 *
 * IT CREATES ROWS. Everything it makes goes in `cleanup()`, which runs even when
 * a check throws.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-odoo-import.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  CONSIGNMENT_LOCATION_FIELD,
  CONSIGNMENT_OWNER_FIELD,
  importOdooProducts,
  previewOdooImport,
  productCodeFor,
} from "~/services/odooImport.server";
import { MOONVELLA_PRODUCT_TAG_NAME, odooConfigured } from "~/services/odoo.server";
import { PermanentJobError } from "~/services/jobs.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const CODE = `VOI-${suffix}`;
const ODOO_DB = `verify-odoo-${suffix.toLowerCase()}`;

const SOURCE_PATH = join(process.cwd(), "app", "services", "odooImport.server.ts");

let failures = 0;
let total = 0;
let expected = 0;

function check(number: number, name: string, pass: boolean, detail = "") {
  total += 1;
  const isSubCheck = !Number.isInteger(number) && Math.floor(number) === expected;
  if (!isSubCheck) {
    if (number !== expected + 1) {
      failures += 1;
      console.log(`FAIL  check #${number} arrived out of order (expected #${expected + 1})`);
      return;
    }
    expected += 1;
  }
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${String(number).padStart(2)}. ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Source with its comments removed: these checks are about code, not prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The body of a `const <name> = { … };` literal, for a field-level check. */
function objectLiteral(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) return "";
  const end = source.indexOf("\n      };", start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

async function main() {
  const raw = readFileSync(SOURCE_PATH, "utf8");
  const source = stripComments(raw);

  /* -------------------------------------------------------------------- */
  /* What may be imported, and under what code                             */
  /* -------------------------------------------------------------------- */
  check(
    1,
    "Eligibility is the mapped product tag, read from Odoo's own tag link, and the tag is the MoonVella App one",
    MOONVELLA_PRODUCT_TAG_NAME === "MoonVella App" &&
      /\["product_tag_ids", "in", \[tag\.id\]\]/.test(source),
    `tag "${MOONVELLA_PRODUCT_TAG_NAME}" filtered by product_tag_ids`,
  );

  const goodCode = productCodeFor({ id: 901, default_code: "tp-pillow-01" });
  check(
    2,
    "A usable reference in Odoo is used verbatim as the Product Code, normalised rather than rewritten",
    goodCode.code === "TP-PILLOW-01" && /Odoo's own reference/.test(goodCode.source),
    `${goodCode.code} — ${goodCode.source}`,
  );

  const badCode = productCodeFor({ id: 902, default_code: "not a code" });
  check(
    3,
    "An unusable reference is refused rather than cleaned up, and the code falls back to the Odoo template id",
    badCode.code === "MV-ODOO-902" && /not a valid MoonVella code/.test(badCode.source),
    `${badCode.code} — ${badCode.source}`,
  );

  /*
   * Odoo sends `false` for an empty char field, not null and not "". Reading it
   * as a value would put the literal word FALSE on a product code — valid, and
   * identical for every template without a reference, so the second one would
   * arrive as a collision with the first instead of as itself.
   */
  const noCode = productCodeFor({ id: 903, default_code: false });
  const emptyCode = productCodeFor({ id: 903, default_code: "" });
  check(
    4,
    "An absent reference — Odoo's `false`, or an empty string — is read as absent, and the code falls back to the template id",
    noCode.code === "MV-ODOO-903" &&
      emptyCode.code === "MV-ODOO-903" &&
      /no code of its own/.test(noCode.source),
    `${noCode.code} — ${noCode.source}`,
  );

  const another = productCodeFor({ id: 904, default_code: null });
  check(
    5,
    "Two templates without references get two different codes, so a fallback cannot merge two products",
    another.code !== noCode.code,
    `${noCode.code} vs ${another.code}`,
  );

  check(
    6,
    "Which stock is read is configuration, not an assumption: a named consignment location and owner",
    CONSIGNMENT_LOCATION_FIELD === "ODOO_CONSIGNMENT_LOCATION" &&
      CONSIGNMENT_OWNER_FIELD === "ODOO_CONSIGNMENT_OWNER",
    `${CONSIGNMENT_LOCATION_FIELD} / ${CONSIGNMENT_OWNER_FIELD}`,
  );

  /* -------------------------------------------------------------------- */
  /* The connection is not ready, and the import says so                   */
  /* -------------------------------------------------------------------- */
  const configured = await odooConfigured();
  check(
    7,
    "Precondition: this environment has no Odoo connection, which is the state the blocker path exists for",
    configured === false,
    configured ? "Odoo IS configured here; the checks below expect it not to be" : "not configured",
  );

  const preview = await previewOdooImport();
  const blocker = preview.blockers[0];
  check(
    8,
    "The preview does not pretend to have a catalogue: it reports one blocker and no templates",
    preview.ok === false && preview.blockers.length === 1 && preview.templates.length === 0,
    `${preview.blockers.length} blocker(s), ${preview.templates.length} template(s)`,
  );
  check(
    9,
    "The blocker names the real reason and the thing the owner can do about it",
    blocker?.code === "ODOO_NOT_CONFIGURED" &&
      /not connected/.test(blocker.message) &&
      /Integrations/.test(blocker.remedy),
    `${blocker?.code}: ${blocker?.message}`,
  );
  check(
    10,
    "And it invents nothing to fill the gap: no tag, no consignment location or owner, no connection details",
    preview.tag === null &&
      preview.consignment.locationId === null &&
      preview.consignment.ownerId === null &&
      preview.connection.url === null &&
      preview.connection.database === null,
    JSON.stringify(preview.connection),
  );
  check(
    11,
    "The read is stamped, so the screen can say when this was last refreshed",
    !Number.isNaN(Date.parse(preview.readAt)),
    preview.readAt,
  );

  /* -------------------------------------------------------------------- */
  /* Preview writes nothing; import refuses to write anything either       */
  /* -------------------------------------------------------------------- */
  const before = {
    products: await prisma.product.count(),
    odooProducts: await prisma.externalProductMapping.count({ where: { provider: "ODOO" } }),
    odooVariants: await prisma.externalVariantMapping.count({ where: { provider: "ODOO" } }),
  };

  const dryRun = await importOdooProducts({ confirm: false });
  const afterDry = {
    products: await prisma.product.count(),
    odooProducts: await prisma.externalProductMapping.count({ where: { provider: "ODOO" } }),
    odooVariants: await prisma.externalVariantMapping.count({ where: { provider: "ODOO" } }),
  };
  check(
    12,
    "Previewing through the import itself performs no work and writes no rows",
    dryRun.executed === false &&
      afterDry.products === before.products &&
      afterDry.odooProducts === before.odooProducts &&
      afterDry.odooVariants === before.odooVariants,
    `executed=${dryRun.executed}, products ${before.products}->${afterDry.products}`,
  );
  check(
    13,
    "And what it returns is the same blocker the owner was shown, not a second opinion",
    dryRun.preview.blockers[0]?.code === blocker?.code &&
      dryRun.preview.readAt >= preview.readAt,
    `${dryRun.preview.blockers[0]?.code}`,
  );

  let importError: unknown = null;
  try {
    await importOdooProducts({ confirm: true });
  } catch (error) {
    importError = error;
  }
  const afterImport = {
    products: await prisma.product.count(),
    odooProducts: await prisma.externalProductMapping.count({ where: { provider: "ODOO" } }),
    odooVariants: await prisma.externalVariantMapping.count({ where: { provider: "ODOO" } }),
  };
  check(
    14,
    "Confirming the import refuses rather than importing from a connection it does not have",
    importError instanceof PermanentJobError &&
      /was not run/.test(messageOf(importError)) &&
      /not connected/.test(messageOf(importError)),
    messageOf(importError).slice(0, 130) || "no error",
  );
  check(
    15,
    "And the refusal is total: no product, no mapping and no variant mapping was written",
    afterImport.products === before.products &&
      afterImport.odooProducts === 0 &&
      afterImport.odooVariants === 0,
    `products ${before.products}->${afterImport.products}, odoo mappings ${afterImport.odooProducts}/${afterImport.odooVariants}`,
  );
  check(
    16,
    "It fails on the first attempt rather than being retried: a missing connection is not a transient fault",
    (importError as { permanent?: boolean })?.permanent === true,
    "permanent = true",
  );

  /* -------------------------------------------------------------------- */
  /* Re-importing updates, it does not duplicate                           */
  /* -------------------------------------------------------------------- */
  const product = await prisma.product.create({
    data: {
      name: "VOI Import Family",
      productCode: CODE,
      category: "Home",
      currency: "CAD",
      variants: {
        create: [
          {
            name: "One size",
            sku: `${CODE}-1`,
            wholesalePrice: 1000,
            suggestedRetailPrice: 2000,
            isDefault: true,
          },
        ],
      },
    },
    include: { variants: true },
  });
  const variantId = product.variants[0].id;

  const mapping = await prisma.externalProductMapping.create({
    data: {
      productId: product.id,
      provider: "ODOO",
      shopDomain: ODOO_DB,
      externalProductId: "9001",
      importStatus: "IMPORTED",
      lastSyncedAt: new Date(),
    },
  });
  let duplicateProduct: unknown = null;
  try {
    await prisma.externalProductMapping.create({
      data: {
        productId: product.id,
        provider: "ODOO",
        shopDomain: ODOO_DB,
        externalProductId: "9002",
        importStatus: "IMPORTED",
      },
    });
  } catch (error) {
    duplicateProduct = error;
  }
  check(
    17,
    "One MoonVella product has one Odoo mapping per Odoo database, which is what makes a second import an update",
    (duplicateProduct as { code?: string })?.code === "P2002",
    `duplicate insert rejected with ${(duplicateProduct as { code?: string })?.code ?? "no error"}`,
  );

  await prisma.externalVariantMapping.create({
    data: {
      variantId,
      provider: "ODOO",
      shopDomain: ODOO_DB,
      externalProductId: "9001",
      externalVariantId: "9101",
      importStatus: "IMPORTED",
      lastSyncedAt: new Date(),
    },
  });
  let duplicateVariant: unknown = null;
  try {
    await prisma.externalVariantMapping.create({
      data: {
        variantId,
        provider: "ODOO",
        shopDomain: ODOO_DB,
        externalProductId: "9001",
        externalVariantId: "9102",
        importStatus: "IMPORTED",
      },
    });
  } catch (error) {
    duplicateVariant = error;
  }
  check(
    17.1,
    "And one variant has one mapping, so the three variants cannot be re-created as six",
    (duplicateVariant as { code?: string })?.code === "P2002",
    `duplicate insert rejected with ${(duplicateVariant as { code?: string })?.code ?? "no error"}`,
  );
  check(
    17.2,
    "The Odoo database is the tenant on those rows, which is what keeps two Odoo sources apart",
    mapping.shopDomain === ODOO_DB && mapping.externalProductId === "9001",
    `${mapping.shopDomain} / template ${mapping.externalProductId}`,
  );

  /* -------------------------------------------------------------------- */
  /* Stock is read, never written, and never invented                      */
  /* -------------------------------------------------------------------- */
  // Every place the stock model is named, classified: the constant's own
  // declaration, and the one call that reads it. A write through this model
  // would appear here as a third site, or as a call in place of the read.
  const quantSites: number[] = [];
  for (let at = source.indexOf("STOCK_QUANT_MODEL"); at >= 0; at = source.indexOf("STOCK_QUANT_MODEL", at + 1)) {
    quantSites.push(at);
  }
  const quantDeclared = quantSites.filter((at) =>
    /^\s*=\s*"stock\.quant"/.test(source.slice(at + "STOCK_QUANT_MODEL".length, at + 60)),
  );
  const quantRead = quantSites.filter((at) =>
    /searchRead<\w+>\(\s*$/.test(source.slice(Math.max(0, at - 40), at)),
  );
  check(
    18,
    "The only thing done with stock.quant is reading it",
    quantSites.length === 2 && quantDeclared.length === 1 && quantRead.length === 1,
    `${quantSites.length} reference(s): ${quantDeclared.length} declaration, ${quantRead.length} read`,
  );
  check(
    19,
    "The quantity read is scoped to the configured location AND the configured owner, not the whole database",
    /\["location_id", "=", locationId\]/.test(source) && /\["owner_id", "=", ownerId\]/.test(source),
    "quant domain filtered by location and owner",
  );
  check(
    20,
    "Available stock is computed from what was read — on hand minus reserved — and floored at zero",
    /available: Math\.max\(0, stock\.onHand - stock\.reserved\)/.test(source),
    "no substituted figure",
  );
  check(
    21,
    "No quantity is hardcoded anywhere in the module, so the figures cannot silently become samples",
    !/inventory:\s*\d/.test(source) && /inventory: variant\.available/.test(source),
    "inventory comes from the read stock",
  );
  check(
    22,
    "A missing location or owner is a blocker, not a zero: the owner is told before anything is imported",
    /_NOT_CONFIGURED/.test(source) && /_AMBIGUOUS/.test(source) && /_MISSING/.test(source),
    "not-configured, missing and ambiguous are all reported",
  );
  check(
    22.1,
    "And a record's name is never rendered as Odoo's `false`, so the screen cannot name a location that way",
    /function nameOf\(/.test(source) && !/String\((row|match)\.complete_name/.test(source),
    "names read through one helper that treats false as absent",
  );

  /* -------------------------------------------------------------------- */
  /* Prices come from the approved source                                  */
  /* -------------------------------------------------------------------- */
  check(
    23,
    "The price is the per-variant list price, and both halves of it are read so it can be explained",
    /listPrice = variant\.lst_price \?\? \(template\.list_price \?\? 0\) \+ priceExtra/.test(source) &&
      /basePrice = template\.list_price \?\? 0/.test(source),
    "lst_price, with the template price and the attribute extras shown separately",
  );
  check(
    24,
    "A zero price stops the import instead of being written as a free product",
    /listPrice > 0/.test(source) && /would be imported at no/.test(raw) && /price\. Set a price in Odoo/.test(raw),
    "zero list price is a problem on the variant",
  );
  check(
    25,
    "The variant's SKU is Odoo's, and it is not invented when Odoo has none",
    /const sku = text\(variant\.default_code\)/.test(source) && /it is not invented here/.test(raw),
    "SKU read from default_code, never generated",
  );

  /* -------------------------------------------------------------------- */
  /* Drafts, and only drafts                                              */
  /* -------------------------------------------------------------------- */
  check(
    26,
    "The import writes a draft and cannot publish: the product is not shown to a seller by importing it",
    /status: "DRAFT" as const/.test(source) && /isPublished: false/.test(source),
    "DRAFT, unpublished",
  );
  check(
    27,
    "And it does not reach for the publication gate at all",
    !/publication\.server|publishProduct|publish\(/.test(source),
    "no publication call in the import",
  );

  /* -------------------------------------------------------------------- */
  /* A re-import cannot blank work done in MoonVella                       */
  /* -------------------------------------------------------------------- */
  const productFields = objectLiteral(source, "productFields");
  check(
    28,
    "The fields an import writes are Odoo's own, and the list can be read in one place",
    productFields.length > 0 && /name: template\.odooName/.test(productFields),
    `${productFields.split("\n").length} lines`,
  );
  check(
    29,
    "It writes none of MoonVella's own content, so a re-import cannot blank media, documents or features",
    !/media|document|image|feature|material|care|shipping/i.test(productFields),
    "no MoonVella-owned field in the update",
  );
  check(
    30,
    "The update passes that same list and nothing else",
    /tx\.product\.update\(\{ where: \{ id: existing\.productId \}, data: productFields \}\)/.test(
      source,
    ),
    "product.update data = productFields",
  );

  /* -------------------------------------------------------------------- */
  /* This module never writes to Odoo                                      */
  /* -------------------------------------------------------------------- */
  const odooWriters = [
    "createPartner",
    "updatePartner",
    "upsertPartner",
    "createSaleOrder",
    "confirmSaleOrder",
    "createInvoiceFromSaleOrder",
    "registerPayment",
    "assertWriteAllowed",
  ].filter((name) => new RegExp(`\\b${name}\\b`).test(source));
  check(
    31,
    "Nothing in the import writes to Odoo: it reads the catalogue and writes MoonVella drafts",
    odooWriters.length === 0,
    odooWriters.length ? `found: ${odooWriters.join(", ")}` : "no Odoo write helper referenced",
  );
  check(
    32,
    "And the only Odoo read is searchRead, which is the one path the write permit does not guard",
    /from "\.\/odoo\.server"/.test(source) && /searchRead,/.test(source),
    "searchRead imported from the Odoo connector",
  );

  const auditAction = /action: "odoo\.products_imported"/.test(source);
  check(
    33,
    "An import that does run is recorded, with what it created and what it updated",
    auditAction && /created: result\.created/.test(source) && /updated: result\.updated/.test(source),
    "audited as odoo.products_imported",
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await cleanup();
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

async function cleanup() {
  const products = await prisma.product.findMany({
    where: { productCode: { startsWith: CODE } },
    select: { id: true, variants: { select: { id: true } } },
  });
  const productIds = products.map((item) => item.id);
  const variantIds = products.flatMap((item) => item.variants.map((variant) => variant.id));
  if (productIds.length) {
    await prisma.externalProductMapping.deleteMany({ where: { productId: { in: productIds } } });
  }
  if (variantIds.length) {
    await prisma.externalVariantMapping.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.variantPackage.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await prisma.product.deleteMany({ where: { productCode: { startsWith: CODE } } });
  await prisma.externalProductMapping.deleteMany({ where: { shopDomain: ODOO_DB } });
  await prisma.externalVariantMapping.deleteMany({ where: { shopDomain: ODOO_DB } });
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // The original error is the one worth reporting.
  }
  await prisma.$disconnect();
  process.exit(1);
});
