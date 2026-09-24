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
 * mapped product tag and not a guess, that prices come from each variant's
 * effective sales price and from nowhere else, that quantities are read at sync
 * time and never invented, that the sync writes drafts, that a re-sync cannot
 * blank MoonVella-added media, and that nothing in this module writes to Odoo.
 *
 * The price rules themselves are not checked by reading code — they are checked
 * by running them, exhaustively, in `verify-pricing.ts`. What is left for this
 * suite is the wiring: that the effective sales price is the field that is read,
 * that the two fields Odoo composes it from are not read at all, that the price
 * has to be CAD, and that no sync can write the retail column.
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
  WHOLESALE_CURRENCY,
  billableCurrency,
  chargeablePrice,
  importOdooProducts,
  previewOdooImport,
  productCodeFor,
  summariseQuants,
} from "~/services/odooImport.server";
import { MOONVELLA_PRODUCT_TAG_NAME, odooConfigured } from "~/services/odoo.server";
import { PermanentJobError } from "~/services/jobs.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const CODE = `VOI-${suffix}`;
const ODOO_DB = `verify-odoo-${suffix.toLowerCase()}`;

const SOURCE_PATH = join(process.cwd(), "app", "services", "odooImport.server.ts");
/** The sync module, read here for the one marker the two files have to agree on. */
const WITHDRAWAL_PATH = join(process.cwd(), "app", "services", "odooSync.server.ts");

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

/**
 * The body of a `const <name> = { … };` literal, for a field-level check.
 *
 * The closing brace is indented to match the declaration, and literals are
 * nested here — `productFields` sits at six spaces, `variantFields` inside the
 * variant loop at eight. The nearest closing brace of either shape is taken,
 * because running to the end of the file would swallow the next literal and
 * make a check about what a field does NOT contain pass for the wrong reason.
 */
function objectLiteral(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) return "";
  const candidates = [source.indexOf("\n      };", start), source.indexOf("\n        };", start)].filter(
    (at) => at >= 0,
  );
  if (candidates.length === 0) return source.slice(start);
  return source.slice(start, Math.min(...candidates));
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
    "One setting scopes stock — the fulfillment warehouse — and no global consignment owner survives to be set",
    /ODOO_WAREHOUSE/.test(source) &&
      !/ODOO_CONSIGNMENT/.test(source) &&
      !/CONSIGNMENT_OWNER/.test(source) &&
      !/CONSIGNMENT_LOCATION/.test(source),
    "ODOO_WAREHOUSE present; no ODOO_CONSIGNMENT* anywhere in the module",
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
    "And it invents nothing to fill the gap: no tag, no warehouse, no connection details",
    preview.tag === null &&
      preview.warehouse === null &&
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
    "The quantity read is scoped to the fulfillment warehouse's location subtree, and to no owner at all",
    /\["location_id", "child_of", \[rootLocationId\]\]/.test(source) &&
      !/\["owner_id", "="/.test(source) &&
      /\["location_id", "child_of"/.test(source),
    "quant domain uses child_of the warehouse root and filters on no owner",
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
    "A missing fulfillment warehouse is a blocker, not a zero: the owner is told before anything is imported",
    /_NOT_CONFIGURED/.test(source) && /_AMBIGUOUS/.test(source) && /_MISSING/.test(source),
    "not-configured, missing and ambiguous are all reported",
  );
  check(
    22.2,
    "The warehouse is resolved by name or code through the same resolver, so an ambiguous one is refused",
    /resolveReference\(\s*WAREHOUSE_MODEL,/.test(source) &&
      /\{ field: "code", label: "short code" \}/.test(source) &&
      /WAREHOUSE_FIELD = "ODOO_WAREHOUSE"/.test(source),
    "ODOO_WAREHOUSE resolved on name or code, ambiguous names refused",
  );
  check(
    22.3,
    "And its view location is what scopes stock, so 'inside this warehouse' is a subtree rather than a list",
    /view_location_id/.test(source) && /toId\(warehouseRow\?\.view_location_id\)/.test(source),
    "view_location_id read from the resolved warehouse row",
  );
  check(
    22.4,
    "Without a view location the import refuses rather than reading every location in the database",
    /WAREHOUSE_WITHOUT_LOCATION/.test(source),
    "a warehouse with no location is a blocker",
  );
  check(
    22.5,
    "A tagged product is imported whichever vendor it belongs to: the tag is the ENTIRE template domain",
    // The domain array closes immediately after the tag term — one term, not the
    // tag AND something about who supplies it. `seller_ids` (Odoo's vendor
    // field) appears nowhere, so eligibility cannot narrow by vendor.
    /\[\["product_tag_ids", "in", \[tag\.id\]\]\]/.test(source) &&
      !/seller_ids/.test(source),
    "template domain is the tag alone; no vendor field is read",
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
  /*
   * Odoo is the pricing authority, and the figure it supplies is each variant's
   * effective sales price: the price on the variant's own form, which Odoo
   * composes from the template's list price plus that variant's attribute price
   * extras.
   *
   * `list_price` and `price_extra` are both still readable in Odoo, both still
   * arrive in a read if you ask for them, and adding them up here would look
   * exactly like the right answer while being a second copy of Odoo's
   * arithmetic — free to drift from Odoo's the first time its rules change. So
   * most of what follows is about what is NOT read, and about the pricelist
   * that used to be consulted and is gone.
   */
  check(
    23,
    "The price source is the variant's own effective sales price, read as one field from product.product",
    /PRODUCT_VARIANT_MODEL = "product\.product"/.test(source) &&
      /"lst_price"/.test(source) &&
      /lst_price: number \| false/.test(source),
    "product.product.lst_price, read as Odoo computes it",
  );
  check(
    23.1,
    "Neither field Odoo composes that figure from is read, so the arithmetic cannot creep back in one field at a time",
    !/\blist_price\b/.test(source) && !/\bprice_extra\b/.test(source),
    "no list_price, no price_extra, anywhere outside comments",
  );
  check(
    23.2,
    "The price is decided by the pure rule, and a variant it cannot price is a problem rather than a number",
    /const priced = chargeablePrice\(variant\.lst_price\)/.test(source) &&
      /if \(!priced\.ok\) variantProblems\.push\(priced\.problem\)/.test(source) &&
      // The cost is read and filed as a cost. It is never on a line that sets
      // a wholesale price, which is what stops it becoming one.
      !/wholesalePrice:[^\n]*(cost|standard_price)/.test(source) &&
      /costPrice: variant\.cost === null/.test(source),
    "chargeablePrice decides the price; the cost reaches costPrice and nothing else",
  );
  check(
    23.3,
    "No pricelist is read at all any more — no model, no paged read, no item to match",
    !/PRICELIST_MODEL|PricelistItem|matchBasePrice|WHOLESALE_PRICELIST/.test(source) &&
      !/"product\.pricelist"/.test(source),
    "the pricelist machinery is gone, not merely unused",
  );
  check(
    23.4,
    "The price is CAD, read as a name and never converted: a company in another currency is refused",
    /const currency = billableCurrency\(/.test(source) &&
      /ODOO_PRICE_CURRENCY_NOT_CAD/.test(source) &&
      /CURRENCY_MODEL,[\s\S]{0,90}\["id", "name"\]/.test(source) &&
      !/"rate"/.test(source) &&
      WHOLESALE_CURRENCY === "CAD",
    "currency read by name only; no rate is read because none is applied",
  );
  check(
    23.5,
    "And the write refuses a variant with no usable price, rather than rounding a null into a zero",
    /const priced = chargeablePrice\(variant\.wholesalePrice\)/.test(source) &&
      /if \(!priced\.ok\) \{/.test(source) &&
      /throw new PermanentJobError\(/.test(source),
    "the last gate before a price reaches a catalogue",
  );
  check(
    23.6,
    "The preview carries the price and its currency, so the figure on the screen is the figure that would be written",
    /wholesalePrice: priced\.ok \? priced\.price : null/.test(source) &&
      /wholesaleCurrency: priced\.ok \? currencyCode : null/.test(source),
    "price and currency carried into the preview, null exactly where a problem is",
  );
  /*
   * The rules above are checked again by running them: the fixtures here are
   * Odoo's `false` and a zero, which are the two values that must never become
   * a price. This is the same function the sync calls, so a rule that passes
   * here passes in the module too.
   */
  const effective = chargeablePrice(39.99);
  const inUsd = billableCurrency("USD", "TEST PILLOW");
  check(
    23.7,
    "The rule itself refuses Odoo's `false` and a zero, and states the effective price when there is one",
    chargeablePrice(false).ok === false &&
      chargeablePrice(0).ok === false &&
      effective.ok === true &&
      effective.price === 39.99 &&
      inUsd.ok === false &&
      billableCurrency("CAD", "TEST PILLOW").ok === true,
    `${JSON.stringify(effective)} / ${JSON.stringify(inUsd)}`,
  );

  const variantFields = objectLiteral(source, "variantFields");
  check(
    24,
    "An import never writes suggested retail: the editor's own field is not in the fields an import updates",
    variantFields.length > 0 && !/suggestedRetailPrice/.test(variantFields),
    variantFields.length ? `${variantFields.split("\n").length} lines, no suggestedRetailPrice` : "literal not found",
  );
  check(
    24.1,
    "It is supplied on create only, where the column requires a value, so a retail price edited here survives every re-import",
    /data: variantFields,/.test(source) &&
      /\.\.\.variantFields,[\s\S]{0,240}suggestedRetailPrice: 0,/.test(source),
    "update writes variantFields; create adds the zero the column needs",
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
    "The update passes that same list, plus the archive columns only when this sync is the one that hid the product",
    /data: restoring\s*\?\s*\{\s*\.\.\.productFields,\s*isArchived: false,\s*isActive: true\s*\}\s*:\s*productFields,/.test(
      source,
    ) &&
      /const restoring = existing\?\.importStatus === "WITHDRAWN"/.test(source) &&
      // The ordinary update writes Odoo's fields and nothing about archiving, so
      // an operator's own archived product is not silently restored.
      !/isArchived|isActive/.test(productFields),
    "product.update data = productFields, or productFields + the withdrawal's own undo",
  );
  check(
    30.1,
    "And the marker that undo depends on is the one the sync writes when it withdraws a product",
    /importStatus: "WITHDRAWN"/.test(readFileSync(WITHDRAWAL_PATH, "utf8")),
    "odooSync.server.ts marks a withdrawal it made",
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

  /* -------------------------------------------------------------------- */
  /* Which stock belongs to whom, from quants Odoo really sends            */
  /* -------------------------------------------------------------------- */
  /*
   * The aggregation is exercised directly, with the shapes Odoo returns rather
   * than with a stub: `owner_id: false` for company stock, two owners in one
   * warehouse, several quant rows on one shelf, and a negative correction. A
   * total that quietly drops a record is indistinguishable from one that never
   * had it, and this is the only place that can tell the difference.
   */
  // The row shape, taken from the function that consumes it rather than
  // restated: a fixture that drifts from the real shape tests the fixture.
  type Quant = Parameters<typeof summariseQuants>[0][number];
  const quant = (
    id: number,
    productId: number,
    locationId: number,
    locationName: string,
    owner: number | false,
    ownerName: string | null,
    quantity: number,
    reservedQuantity: number,
  ): Quant => ({
    id,
    product_id: [productId, "TEST PILLOW"] as [number, string],
    location_id: [locationId, locationName] as [number, string],
    owner_id: (owner === false ? false : [owner, ownerName ?? ""]) as [number, string] | false,
    quantity,
    reserved_quantity: reservedQuantity,
  });

  // One warehouse, two vendors and the company's own goods, plus one shelf
  // holding two quant rows for the same owner.
  const mixed = summariseQuants([
    quant(1, 349, 25, "WH/Stock/EcoComfort Consignment", 41, "O/A EcoComfort", 25, 5),
    quant(2, 349, 25, "WH/Stock/EcoComfort Consignment", 41, "O/A EcoComfort", 3, 0),
    quant(3, 349, 26, "WH/Stock/Northline Consignment", 57, "Northline Textiles", 10, 2),
    quant(4, 349, 8, "WH/Stock", false, null, 7, 1),
  ]);
  const totals349 = mixed.totals.get(349);
  const records349 = mixed.records.get(349) ?? [];

  check(
    34,
    "Stock keeps every owner apart: the breakdown names the location and the owner, and the company is its own owner",
    records349.length === 3 &&
      records349.some((record) => record.ownerName === "O/A EcoComfort") &&
      records349.some((record) => record.ownerName === "Northline Textiles") &&
      records349.some((record) => record.ownerId === null && record.ownerName === null),
    records349.map((record) => `${record.locationName}/${record.ownerName ?? "company"}`).join(", "),
  );
  check(
    35,
    "Two quant rows on one shelf are one record, so nothing is duplicated",
    records349.filter((record) => record.locationId === 25).length === 1 &&
      records349.find((record) => record.locationId === 25)?.quantity === 28,
    `location 25 summed to ${records349.find((record) => record.locationId === 25)?.quantity}`,
  );
  check(
    36,
    "And the total is exactly the records added up — every owner counted, none duplicated",
    totals349?.onHand === 45 &&
      totals349?.reserved === 8 &&
      records349.reduce((sum, record) => sum + record.quantity, 0) === totals349?.onHand &&
      records349.reduce((sum, record) => sum + record.reserved, 0) === totals349?.reserved,
    `on hand ${totals349?.onHand}, reserved ${totals349?.reserved}`,
  );

  // A negative is a real Odoo correction. It reaches this function only because
  // it sits inside the warehouse scope, and it is passed through rather than
  // clamped, so the records still add up to the total they are read with.
  const corrected = summariseQuants([
    quant(5, 350, 25, "WH/Stock/EcoComfort Consignment", 41, "O/A EcoComfort", 20, 0),
    quant(6, 350, 25, "WH/Stock/EcoComfort Consignment", 41, "O/A EcoComfort", -4, 0),
  ]);
  check(
    37,
    "A negative correction is carried through, not clamped, so the breakdown matches the total",
    corrected.totals.get(350)?.onHand === 16 &&
      corrected.records.get(350)?.[0]?.quantity === 16,
    `on hand ${corrected.totals.get(350)?.onHand}`,
  );
  check(
    38,
    "Records come back in a stable order, so two syncs over the same data write the same rows",
    JSON.stringify(records349.map((record) => record.locationId)) === "[8,25,26]",
    records349.map((record) => record.locationId).join(","),
  );
  const orphan = quant(7, 351, 25, "WH/Stock", 41, "O/A EcoComfort", 5, 0);
  orphan.product_id = false;
  check(
    39,
    "A quant with no product is dropped rather than filed under a product it does not belong to",
    summariseQuants([orphan]).totals.size === 0,
    "an unattributable quant contributes to no product",
  );

  /* -------------------------------------------------------------------- */
  /* The breakdown is written, and replaced rather than appended to        */
  /* -------------------------------------------------------------------- */
  const variantFieldsBody = objectLiteral(source, "variantFields");
  check(
    40,
    "The variant row keeps both halves of the figure: what is on hand, and what is already reserved",
    /inventory: variant\.available/.test(variantFieldsBody) &&
      /reserved: variant\.reserved/.test(variantFieldsBody),
    "inventory and reserved are written from the same read",
  );
  check(
    41,
    "Stock records are replaced on every sync, never appended, so six-hourly runs cannot pile up history",
    /tx\.variantStockRecord\.deleteMany\(\{ where: \{ variantId: variantRow\.id \} \}\)/.test(source) &&
      /tx\.variantStockRecord\.createMany\(/.test(source) &&
      !/variantStockRecord\.(update|upsert)/.test(source),
    "deleteMany then createMany, inside the same transaction as the variant",
  );
  check(
    42,
    "And each written record carries its location, its owner and the Odoo database the ids belong to",
    /odooLocationId: record\.locationId/.test(source) &&
      /locationName: record\.locationName/.test(source) &&
      /odooOwnerId: record\.ownerId/.test(source) &&
      /ownerName: record\.ownerName/.test(source) &&
      /odooDatabase: database/.test(source),
    "location, owner and database are all recorded",
  );
  check(
    43,
    "The scope the stock came from is recorded on the audit row, so a figure can be traced to its warehouse",
    /stockScope: preview\.warehouse/.test(source) &&
      /rootLocationId: preview\.warehouse\.rootLocationId/.test(source),
    "audited with its warehouse and root location",
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
