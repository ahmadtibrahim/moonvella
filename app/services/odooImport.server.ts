/**
 * The first Odoo catalogue import: read the tagged templates, and write them
 * into MoonVella as drafts.
 *
 * WHAT "THE FIRST IMPORT" MEANS HERE. One template is in scope — whichever
 * `product.template` records carry the mapped MoonVella App product tag — and
 * the import exists to prove the whole path on a known, small set rather than
 * to move a catalogue. Everything it writes is a draft: a product reaches a
 * storefront only through the publication gate, which this module never calls.
 *
 * TWO STEPS, ONE IMPLEMENTATION. The owner sees "Preview Odoo import" and then
 * "Import as draft". The preview is not a separate code path that could drift
 * from the import: `importOdooProducts` calls the same `previewOdooImport` and
 * refuses to write if it reports a blocker. What the owner approved is what the
 * import does, because it is literally the same read.
 *
 * PRICES. The approved source is the per-variant list price, which Odoo already
 * computes: `lst_price` is the template's `list_price` plus the variant's
 * attribute extras, and that composed figure is what a variant sells for. Both
 * halves are read and shown, so a surprising price can be traced to the
 * attribute that caused it instead of being taken on trust.
 *
 * STOCK IS READ, NEVER WRITTEN, AND NEVER INVENTED. Available quantity is the
 * quantity held at the configured consignment location for the configured
 * owner, minus what is already reserved there. The quantities are read at
 * import time on every run — this module contains no quantity literals — and
 * nothing here writes to `stock.quant`. If the consignment location or owner is
 * not configured, the import stops and says so rather than importing a
 * plausible-looking number, because a stock figure that is wrong is worse than
 * one that is absent: absent stock stops a sale, and wrong stock takes an order
 * nobody can fill.
 *
 * DRAFTS, AND IDEMPOTENT ONES. A second import of the same template updates the
 * same MoonVella product and the same variants, found through the durable
 * `ExternalProductMapping` / `ExternalVariantMapping` rows written by the first.
 * Media and documents attached in MoonVella are never touched — the update
 * writes the fields Odoo is the source of, and nothing else.
 */

import { prisma } from "~/db.server";
import { getCredential } from "./credentials.server";
import { PermanentJobError } from "./jobs.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import {
  MOONVELLA_PRODUCT_TAG_NAME,
  findProductTagByName,
  odooConfigured,
  odooMode,
  resolveOdooConfig,
  searchRead,
  type OdooRecord,
} from "./odoo.server";
import { checkProductCode } from "~/utils/productCode";

const PRODUCT_TEMPLATE_MODEL = "product.template";
const STOCK_QUANT_MODEL = "stock.quant";
const STOCK_LOCATION_MODEL = "stock.location";
const PARTNER_MODEL = "res.partner";
const ATTRIBUTE_VALUE_MODEL = "product.template.attribute.value";
const ATTRIBUTE_MODEL = "product.attribute";
const ATTRIBUTE_NAMED_VALUE_MODEL = "product.attribute.value";
const CURRENCY_MODEL = "res.currency";

export const CONSIGNMENT_LOCATION_FIELD = "ODOO_CONSIGNMENT_LOCATION";
export const CONSIGNMENT_OWNER_FIELD = "ODOO_CONSIGNMENT_OWNER";

export interface ImportBlocker {
  code: string;
  message: string;
  /** What the owner can do about it, in one sentence. */
  remedy: string;
}

interface OdooTemplateRow extends OdooRecord {
  name: string | false;
  default_code: string | false;
  list_price: number;
  categ_id: [number, string] | false;
  company_id: [number, string] | false;
  description_sale: string | false;
  description: string | false;
}

interface OdooVariantRow extends OdooRecord {
  default_code: string | false;
  barcode: string | false;
  standard_price: number;
  lst_price: number;
  price_extra: number;
  active: boolean;
  product_tmpl_id: [number, string] | false;
  product_template_attribute_value_ids: number[];
}

interface OdooQuantRow extends OdooRecord {
  product_id: [number, string] | false;
  location_id: [number, string] | false;
  owner_id: [number, string] | false;
  quantity: number;
  reserved_quantity: number;
}

export interface PreviewVariant {
  odooVariantId: number;
  sku: string | null;
  attributes: { attribute: string; value: string; priceExtra: number }[];
  basePrice: number;
  priceExtra: number;
  /** The per-variant list price: base + attribute extras, as Odoo computes it. */
  listPrice: number;
  cost: number | null;
  onHand: number;
  reserved: number;
  available: number;
  barcode: string | null;
  active: boolean;
  existingVariantId: string | null;
  /** Reasons this variant cannot be imported as it stands. */
  problems: string[];
}

export interface PreviewTemplate {
  odooTemplateId: number;
  odooName: string;
  productCode: string;
  codeSource: string;
  description: string | null;
  descriptionSource: string;
  odooCategory: string;
  currency: string;
  variants: PreviewVariant[];
  existingProductId: string | null;
  problems: string[];
}

export interface OdooImportPreview {
  ok: boolean;
  connection: { url: string | null; database: string | null; mode: string | null };
  tag: { id: number; name: string } | null;
  consignment: {
    locationId: number | null;
    location: string | null;
    ownerId: number | null;
    owner: string | null;
    note: string;
  };
  templates: PreviewTemplate[];
  blockers: ImportBlocker[];
  notes: string[];
  readAt: string;
}

/* -------------------------------------------------------------------------- */
/* Reference resolution                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the consignment location and owner from configuration.
 *
 * A numeric value is taken as an id; anything else is a name, and a name has to
 * be unambiguous. Two locations called "Consignment" would otherwise become
 * whichever one the database happened to return first, which is a stock figure
 * taken from the wrong shelf.
 */
async function resolveReference(
  model: string,
  value: string,
  lookup: { field: string; label: string }[],
  readFields: string[],
  label: string,
): Promise<{ id: number; name: string } | ImportBlocker> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      code: `${label.toUpperCase()}_NOT_CONFIGURED`,
      message: `${label} is not configured, so MoonVella does not know whose stock to read.`,
      remedy:
        `Set ${label} on the Odoo integration — the ${label.toLowerCase()} whose stock is ` +
        `sellable. It accepts a name or a numeric id.`,
    };
  }

  if (/^\d+$/.test(trimmed)) {
    const rows = await searchRead<OdooRecord>(
      model,
      [["id", "=", Number(trimmed)]],
      readFields,
    );
    const row = rows[0];
    if (!row) {
      return {
        code: `${label.toUpperCase()}_MISSING`,
        message: `No ${label.toLowerCase()} with id ${trimmed} exists in Odoo.`,
        remedy: `Correct or clear ${label} on the Odoo integration.`,
      };
    }
    return { id: row.id, name: nameOf(row, row.id) };
  }

  /*
   * Each name field is searched separately and the results are merged, rather
   * than one Odoo domain being built by ANDing or ORing them. A location is
   * configured by its dotted path ("WH/Stock/Consignment") or by its leaf name
   * ("Consignment"), and a hand-built prefix domain is easy to get subtly wrong
   * — which for this lookup means reading stock off the wrong shelf.
   */
  const found = new Map<number, OdooRecord>();
  for (const item of lookup) {
    const rows = await searchRead<OdooRecord>(
      model,
      [[item.field, "=", trimmed]],
      readFields,
      { limit: 5 },
    );
    for (const row of rows) found.set(row.id, row);
  }

  const matches = [...found.values()];
  if (matches.length === 0) {
    return {
      code: `${label.toUpperCase()}_MISSING`,
      message:
        `No ${label.toLowerCase()} in Odoo matches "${trimmed}" on ` +
        `${lookup.map((item) => item.label).join(" or ")}.`,
      remedy: `Correct or clear ${label} on the Odoo integration, or use its numeric id.`,
    };
  }
  if (matches.length > 1) {
    return {
      code: `${label.toUpperCase()}_AMBIGUOUS`,
      message:
        `${matches.length} Odoo records match "${trimmed}" ` +
        `(ids ${matches
          .map((row) => `${row.id} "${nameOf(row, "")}"`)
          .join(", ")}), so MoonVella cannot tell which one you mean.`,
      remedy: `Set ${label} to the numeric id of the correct record.`,
    };
  }
  const match = matches[0];
  return { id: match.id, name: nameOf(match, trimmed) };
}

/* -------------------------------------------------------------------------- */
/* The read                                                                   */
/* -------------------------------------------------------------------------- */

/** The product code and where it came from, so the owner sees it before importing. */
export function productCodeFor(template: { id: number; default_code: string | false | null }) {
  /*
   * `false`, not `null`, is what Odoo's JSON-RPC returns for an empty char
   * field, and `??` does not catch it. Stringifying it would read an absent
   * reference as the word "FALSE" — a valid MoonVella code, and the same one for
   * every template that has no reference, so the second such template would
   * arrive as a Product Code collision with the first rather than as the
   * template it is. Only a real string counts as a reference.
   */
  const raw = typeof template.default_code === "string" ? template.default_code.trim() : "";
  if (raw) {
    const check = checkProductCode(raw);
    if (check.ok) {
      return { code: check.code, source: "Odoo's own reference on the template" };
    }
  }
  // No usable code on the template. The Odoo template id is the one identifier
  // that is stable, unique and traceable back to the source, so it is used
  // rather than a slug of the name — a name can be edited in Odoo, and a code
  // derived from it would change identity with it.
  return {
    code: `MV-ODOO-${template.id}`,
    source: raw
      ? `derived from the Odoo template id (Odoo's "${raw}" is not a valid MoonVella code)`
      : "derived from the Odoo template id (the template has no code of its own)",
  };
}

/**
 * Read everything the import would use, and say what it cannot do.
 *
 * Read-only, and safe to run at any time: it resolves references, reads the
 * tagged templates, their variants, their attributes, their prices and their
 * consignment stock, and writes nothing anywhere.
 */
export async function previewOdooImport(): Promise<OdooImportPreview> {
  const blockers: ImportBlocker[] = [];
  const notes: string[] = [];

  const config = await resolveOdooConfig();
  const mode = await odooMode();

  const preview: OdooImportPreview = {
    ok: false,
    connection: {
      url: config?.url ?? null,
      database: config?.database ?? null,
      mode,
    },
    tag: null,
    consignment: {
      locationId: null,
      location: null,
      ownerId: null,
      owner: null,
      note: "",
    },
    templates: [],
    blockers,
    notes,
    readAt: new Date().toISOString(),
  };

  if (!(await odooConfigured())) {
    blockers.push({
      code: "ODOO_NOT_CONFIGURED",
      message:
        "Odoo is not connected: no URL, database, username and API key are saved for it.",
      remedy: "Enter the Odoo connection details on the Integrations page, then try again.",
    });
    return preview;
  }

  if (mode === "disabled") {
    // Disabled means nothing is called, reads included. Saying so is the
    // difference between "there is no catalogue to import" and "the connection
    // is switched off", and only one of those is the owner's to fix.
    blockers.push({
      code: "ODOO_DISABLED",
      message: "The Odoo connection is switched off, so nothing can be read from it.",
      remedy: "Set the Odoo mode to readonly (or live) on the Integrations page, then try again.",
    });
    return preview;
  }

  const tag = await findProductTagByName(MOONVELLA_PRODUCT_TAG_NAME);
  if (!tag) {
    blockers.push({
      code: "PRODUCT_TAG_MISSING",
      message:
        `Odoo has no product tag called "${MOONVELLA_PRODUCT_TAG_NAME}", so nothing is ` +
        `marked as eligible for import.`,
      remedy:
        `Create the tag "${MOONVELLA_PRODUCT_TAG_NAME}" on the products you want imported ` +
        `(product.tag, not res.partner.category), then try again.`,
    });
    return preview;
  }
  preview.tag = { id: tag.id, name: tag.name };

  const [locationValue, ownerValue] = await Promise.all([
    getCredential("odoo", CONSIGNMENT_LOCATION_FIELD),
    getCredential("odoo", CONSIGNMENT_OWNER_FIELD),
  ]);

  const location = await resolveReference(
    STOCK_LOCATION_MODEL,
    locationValue ?? "",
    [
      { field: "complete_name", label: "its full path" },
      { field: "name", label: "its short name" },
    ],
    ["id", "name", "complete_name"],
    "Consignment location",
  );
  if ("code" in location) {
    blockers.push(location);
  } else {
    preview.consignment.locationId = location.id;
    preview.consignment.location = location.name;
  }

  const owner = await resolveReference(
    PARTNER_MODEL,
    ownerValue ?? "",
    [{ field: "name", label: "name" }],
    ["id", "name"],
    "Consignment owner",
  );
  if ("code" in owner) {
    blockers.push(owner);
  } else {
    preview.consignment.ownerId = owner.id;
    preview.consignment.owner = owner.name;
  }

  if (blockers.length > 0) return preview;

  const locationId = preview.consignment.locationId as number;
  const ownerId = preview.consignment.ownerId as number;
  preview.consignment.note =
    `Stock is read from ${preview.consignment.location} (id ${locationId}) for owner ` +
    `${preview.consignment.owner}, less anything already reserved there. No other location ` +
    `and no other owner is counted.`;

  /* ------------------------- templates and variants ------------------------ */
  const templates = await searchRead<OdooTemplateRow>(
    PRODUCT_TEMPLATE_MODEL,
    [["product_tag_ids", "in", [tag.id]]],
    [
      "id",
      "name",
      "default_code",
      "list_price",
      "categ_id",
      "company_id",
      "description_sale",
      "description",
    ],
    { order: "id asc" },
  );

  if (templates.length === 0) {
    blockers.push({
      code: "NO_TAGGED_TEMPLATES",
      message: `No Odoo product carries the "${tag.name}" tag, so there is nothing to import.`,
      remedy: `Tag the products you want in Odoo with "${tag.name}", then preview again.`,
    });
    return preview;
  }

  const templateIds = templates.map((row) => row.id);
  const variants = await searchRead<OdooVariantRow>(
    "product.product",
    [
      ["product_tmpl_id", "in", templateIds],
      ["active", "in", [true, false]],
    ],
    [
      "id",
      "default_code",
      "barcode",
      "standard_price",
      "lst_price",
      "price_extra",
      "active",
      "product_template_attribute_value_ids",
      "product_tmpl_id",
    ],
    { order: "id asc" },
  );

  const variantIds = variants.map((row) => row.id);

  // Attributes: one read for the values used by these variants, one for the
  // attribute names, one for the value names. Three calls for the whole import,
  // rather than three per variant.
  const attributeValueIds = [
    ...new Set(variants.flatMap((row) => row.product_template_attribute_value_ids ?? [])),
  ];
  const attributeValues = attributeValueIds.length
    ? await searchRead<OdooRecord>(
        ATTRIBUTE_VALUE_MODEL,
        [["id", "in", attributeValueIds]],
        ["id", "price_extra", "attribute_id", "product_attribute_value_id"],
      )
    : [];
  const attributeIds = [...new Set(attributeValues.map((row) => toId(row.attribute_id)))].filter(
    (id): id is number => id !== null,
  );
  const namedValueIds = [
    ...new Set(attributeValues.map((row) => toId(row.product_attribute_value_id))),
  ].filter((id): id is number => id !== null);
  const [attributes, namedValues] = await Promise.all([
    attributeIds.length
      ? searchRead<OdooRecord>(ATTRIBUTE_MODEL, [["id", "in", attributeIds]], ["id", "name"])
      : [],
    namedValueIds.length
      ? searchRead<OdooRecord>(
          ATTRIBUTE_NAMED_VALUE_MODEL,
          [["id", "in", namedValueIds]],
          ["id", "name"],
        )
      : [],
  ]);
  const attributeNames = new Map(attributes.map((row) => [row.id, String(row.name ?? row.id)]));
  const valueNames = new Map(namedValues.map((row) => [row.id, String(row.name ?? row.id)]));
  const attributeById = new Map(attributeValues.map((row) => [row.id, row]));

  // Consignment stock: one query, filtered by both the location and the owner.
  const quants = variantIds.length
    ? await searchRead<OdooQuantRow>(
        STOCK_QUANT_MODEL,
        [
          ["product_id", "in", variantIds],
          ["location_id", "=", locationId],
          ["owner_id", "=", ownerId],
        ],
        ["id", "product_id", "location_id", "owner_id", "quantity", "reserved_quantity"],
      )
    : [];
  const stockByVariant = new Map<number, { onHand: number; reserved: number }>();
  for (const quant of quants) {
    const productId = toId(quant.product_id);
    if (productId === null) continue;
    const current = stockByVariant.get(productId) ?? { onHand: 0, reserved: 0 };
    current.onHand += quant.quantity ?? 0;
    current.reserved += quant.reserved_quantity ?? 0;
    stockByVariant.set(productId, current);
  }

  // Currency: read from the templates' own companies rather than assumed.
  const companyIds = [
    ...new Set(templates.map((row) => toId(row.company_id)).filter((id): id is number => id !== null)),
  ];
  const companies = companyIds.length
    ? await searchRead<OdooRecord>(
        "res.company",
        [["id", "in", companyIds]],
        ["id", "currency_id"],
      )
    : [];
  const currencyIds = [
    ...new Set(companies.map((row) => toId(row.currency_id)).filter((id): id is number => id !== null)),
  ];
  const currencies = currencyIds.length
    ? await searchRead<OdooRecord>(CURRENCY_MODEL, [["id", "in", currencyIds]], ["id", "name"])
    : [];
  const currencyNames = new Map(currencies.map((row) => [row.id, String(row.name ?? "")]));
  const companyCurrency = new Map(
    companies.map((row) => {
      const currencyId = toId(row.currency_id);
      return [row.id, currencyId === null ? null : (currencyNames.get(currencyId) ?? null)];
    }),
  );

  /* ------------------------------- assemble -------------------------------- */
  const existingProducts = await prisma.externalProductMapping.findMany({
    where: {
      provider: "ODOO",
      shopDomain: config?.database ?? "",
      externalProductId: { in: templateIds.map(String) },
    },
    select: { externalProductId: true, productId: true },
  });
  const productByTemplate = new Map(
    existingProducts
      .filter((row) => row.externalProductId !== null)
      .map((row) => [Number(row.externalProductId), row.productId]),
  );

  const existingVariants = await prisma.externalVariantMapping.findMany({
    where: {
      provider: "ODOO",
      shopDomain: config?.database ?? "",
      externalVariantId: { in: variantIds.map(String) },
    },
    select: { externalVariantId: true, variantId: true },
  });
  const variantByOdooId = new Map(
    existingVariants
      .filter((row) => row.externalVariantId !== null)
      .map((row) => [Number(row.externalVariantId), row.variantId]),
  );

  /*
   * Two collisions that would otherwise surface as a constraint violation
   * halfway through the import, after some products had been written.
   *
   * A SKU and a Product Code are both unique in MoonVella and both mean
   * something to somebody: the SKU is what a seller orders by, and the code is
   * the family identifier. If Odoo holds a SKU that MoonVella already has on a
   * different variant, the honest answer is to show the owner both records and
   * let them decide, not to overwrite one product's identifier with another's.
   */
  const skus = variants.map((row) => text(row.default_code)).filter((sku): sku is string => !!sku);
  const codes = templates.map((template) => productCodeFor(template).code);
  const [skuOwners, codeOwners] = await Promise.all([
    skus.length
      ? prisma.productVariant.findMany({
          where: { sku: { in: skus } },
          select: { id: true, sku: true, productId: true },
        })
      : [],
    codes.length
      ? prisma.product.findMany({
          where: { productCode: { in: codes } },
          select: { id: true, productCode: true, name: true },
        })
      : [],
  ]);
  const variantBySku = new Map(skuOwners.map((row) => [row.sku, row.id]));
  const productByCode = new Map(codeOwners.map((row) => [row.productCode, row]));

  for (const template of templates) {
    const problems: string[] = [];
    const { code, source } = productCodeFor(template);

    const mappedProduct = productByTemplate.get(template.id) ?? null;
    const codeOwner = productByCode.get(code);
    // Only a first import chooses a code; a re-import keeps the code the product
    // already has, so a later collision with a *different* product's code is not
    // this import's problem and must not block it.
    if (!mappedProduct && codeOwner) {
      problems.push(
        `Product Code ${code} already belongs to "${codeOwner.name}" in MoonVella. ` +
          `Importing would either overwrite that product's code or create a duplicate family.`,
      );
    }

    const descriptionSale = text(template.description_sale);
    const descriptionInternal = text(template.description);
    const description = descriptionSale ?? descriptionInternal ?? null;
    const descriptionSource = descriptionSale
      ? "Odoo sales description"
      : descriptionInternal
        ? "Odoo internal note"
        : "Odoo holds no description — left empty rather than invented";

    const currency =
      companyCurrency.get(toId(template.company_id) ?? -1) ?? null;
    const currencyCode = currency ?? "CAD";
    if (!currency) {
      notes.push(
        `No currency could be read from Odoo for ${text(template.name) ?? template.id}; ` +
          `CAD is assumed because that is this catalogue's currency.`,
      );
    }

    const templateVariants = variants.filter(
      (row) => toId(row.product_tmpl_id) === template.id,
    );

    if (templateVariants.length === 0) {
      problems.push("This template has no variants, so there is nothing sellable to import.");
    }

    const previewVariants: PreviewVariant[] = templateVariants.map((variant) => {
      const variantProblems: string[] = [];
      const sku = text(variant.default_code);
      const skuOwner = sku ? variantBySku.get(sku) : undefined;
      if (sku && skuOwner && skuOwner !== variantByOdooId.get(variant.id)) {
        variantProblems.push(
          `SKU ${sku} is already used by another MoonVella variant. A SKU identifies one ` +
            `sellable unit, so it is not reassigned by an import.`,
        );
      }
      if (!sku) {
        // A MoonVella variant's SKU is unique and required, and it is the
        // seller's own identifier. Inventing one would put a number MoonVella
        // made up onto a supplier's product, so the import stops instead.
        variantProblems.push(
          "This variant has no SKU (default_code) in Odoo. MoonVella's SKU is unique and is " +
            "used to identify the variant to sellers, so it is not invented here.",
        );
      }

      const attributesForVariant = (variant.product_template_attribute_value_ids ?? [])
        .map((id) => attributeById.get(id))
        .filter((row): row is OdooRecord => !!row)
        .map((row) => {
          const attributeId = toId(row.attribute_id);
          const valueId = toId(row.product_attribute_value_id);
          return {
            attribute: attributeId === null ? "attribute" : (attributeNames.get(attributeId) ?? "attribute"),
            value: valueId === null ? "value" : (valueNames.get(valueId) ?? "value"),
            priceExtra: (row.price_extra as number) ?? 0,
          };
        });

      const priceExtra = attributesForVariant.reduce((sum, item) => sum + item.priceExtra, 0);
      const listPrice = variant.lst_price ?? (template.list_price ?? 0) + priceExtra;
      const basePrice = template.list_price ?? 0;

      if (!(listPrice > 0)) {
        variantProblems.push(
          "The per-variant list price in Odoo is zero, so the variant would be imported at no " +
            "price. Set a price in Odoo and import again.",
        );
      }

      const stock = stockByVariant.get(variant.id) ?? { onHand: 0, reserved: 0 };
      return {
        odooVariantId: variant.id,
        sku,
        attributes: attributesForVariant,
        basePrice,
        priceExtra,
        listPrice,
        cost: variant.standard_price ?? null,
        onHand: stock.onHand,
        reserved: stock.reserved,
        available: Math.max(0, stock.onHand - stock.reserved),
        barcode: text(variant.barcode),
        active: variant.active !== false,
        existingVariantId: variantByOdooId.get(variant.id) ?? null,
        problems: variantProblems,
      };
    });

    if (!description) {
      // A note rather than a problem: an empty description is a fact about the
      // source, and the product is a draft the owner can write into.
      notes.push(`${text(template.name) ?? template.id}: no description in Odoo.`);
    }

    preview.templates.push({
      odooTemplateId: template.id,
      odooName: text(template.name) ?? `Template ${template.id}`,
      productCode: code,
      codeSource: source,
      description,
      descriptionSource,
      odooCategory: template.categ_id ? String(template.categ_id[1]) : "uncategorised",
      currency: currencyCode,
      variants: previewVariants,
      existingProductId: productByTemplate.get(template.id) ?? null,
      problems: [...problems, ...previewVariants.flatMap((variant) => variant.problems)],
    });
  }

  const totalVariants = preview.templates.reduce((sum, item) => sum + item.variants.length, 0);
  notes.push(
    `${preview.templates.length} tagged template(s), ${totalVariants} variant(s) read from Odoo. ` +
      `Prices are the per-variant list price (template list price plus the variant's attribute ` +
      `extras), and stock is what is held at the consignment location for the consignment owner.`,
  );
  notes.push(
    "Nothing has been written to Odoo by this preview, and the import does not change Odoo " +
      "inventory either: it reads quantities and writes MoonVella drafts.",
  );

  preview.ok = preview.templates.every((item) => item.problems.length === 0);
  return preview;
}

/** A jsonb-ish Odoo value that should be a string, or null. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A record's name, tolerant of Odoo's `false`.
 *
 * Odoo sends `false` for a field it has nothing in, and `??` does not catch it:
 * `complete_name ?? name` yields `false`, and stringifying that shows the owner
 * a consignment location called "false". A record that has a name uses it; one
 * that does not falls back to something that identifies it.
 */
function nameOf(record: OdooRecord, fallback: string | number): string {
  return text(record.complete_name) ?? text(record.name) ?? String(fallback);
}

/** Odoo many2one values arrive as `[id, name]` or `false`. */
function toId(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === "number") return value[0];
  if (typeof value === "number") return value;
  return null;
}

/* -------------------------------------------------------------------------- */
/* The write                                                                  */
/* -------------------------------------------------------------------------- */

export interface ImportResult {
  created: number;
  updated: number;
  variantsWritten: number;
  templates: {
    odooTemplateId: number;
    name: string;
    productId: string;
    outcome: "CREATED" | "UPDATED";
    productCode: string;
    variants: { odooVariantId: number; variantId: string; sku: string; price: number; available: number }[];
  }[];
}

/**
 * Write the previewed templates into MoonVella as drafts.
 *
 * Refuses to run at all when the preview reports a blocker: a partial import of
 * a catalogue the owner has not seen is worse than no import, because the
 * missing half looks like a product that does not exist.
 */
export async function importOdooProducts(options: {
  confirm: boolean;
}): Promise<{ preview: OdooImportPreview; executed: false } | { preview: OdooImportPreview; executed: true; result: ImportResult }> {
  const preview = await previewOdooImport();

  if (!options.confirm) {
    return { preview, executed: false };
  }

  if (preview.blockers.length > 0) {
    throw new PermanentJobError(
      `The Odoo import was not run: ${preview.blockers.map((b) => b.message).join(" ")}`,
    );
  }
  const blocked = preview.templates.filter((item) => item.problems.length > 0);
  if (blocked.length > 0) {
    throw new PermanentJobError(
      `The Odoo import was not run: ${blocked.length} template(s) have problems. ` +
        blocked
          .slice(0, 3)
          .map((item) => `${item.odooName}: ${item.problems[0]}`)
          .join(" | "),
    );
  }

  const database = preview.connection.database ?? "";
  const result: ImportResult = { created: 0, updated: 0, variantsWritten: 0, templates: [] };

  for (const template of preview.templates) {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.externalProductMapping.findFirst({
        where: {
          provider: "ODOO",
          shopDomain: database,
          externalProductId: String(template.odooTemplateId),
        },
        select: { productId: true },
      });

      const productFields = {
        name: template.odooName,
        description: template.description,
        category: template.odooCategory,
        currency: template.currency,
        // A draft, and not published. The publication gate is the only thing
        // that moves a product in front of a seller, and an import must not be
        // able to do it by accident.
        status: "DRAFT" as const,
        isPublished: false,
      };

      /*
       * Only MoonVella-owned columns are written on an update. Media, documents,
       * features, materials, care instructions and shipping detail are not in
       * this object, so a re-import cannot blank work that was done here after
       * the first import — which is exactly what "preserve MoonVella-added
       * media and documents" requires, and it is achieved by omission rather
       * than by a merge.
       */
      const product = existing
        ? await tx.product.update({ where: { id: existing.productId }, data: productFields })
        : await tx.product.create({
            data: { ...productFields, productCode: template.productCode },
          });

      await tx.externalProductMapping.upsert({
        where: {
          provider_shopDomain_productId: {
            provider: "ODOO",
            shopDomain: database,
            productId: product.id,
          },
        },
        create: {
          provider: "ODOO",
          shopDomain: database,
          productId: product.id,
          externalProductId: String(template.odooTemplateId),
          importStatus: "IMPORTED",
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
        update: {
          externalProductId: String(template.odooTemplateId),
          importStatus: "IMPORTED",
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });

      const variantRows: ImportResult["templates"][number]["variants"] = [];

      for (const [index, variant] of template.variants.entries()) {
        const sku = variant.sku as string;
        const existingVariant = await tx.externalVariantMapping.findFirst({
          where: {
            provider: "ODOO",
            shopDomain: database,
            externalVariantId: String(variant.odooVariantId),
          },
          select: { variantId: true },
        });

        const variantFields = {
          name: variantName(template.odooName, variant),
          sku,
          // The approved price source: the per-variant list price, in cents.
          wholesalePrice: Math.round(variant.listPrice * 100),
          // Odoo holds no suggested retail for these products. Setting it equal
          // to the list price leaves the field populated with a real number —
          // the source price — rather than a markup nobody agreed to, and the
          // preview says so before the import runs.
          suggestedRetailPrice: Math.round(variant.listPrice * 100),
          costPrice: variant.cost === null ? null : Math.round(variant.cost * 100),
          // Read, never written back, never defaulted.
          inventory: variant.available,
          currency: template.currency,
          barcode: variant.barcode,
          isActive: variant.active,
          isDefault: index === 0,
          sortOrder: index,
        };

        const variantRow = existingVariant
          ? await tx.productVariant.update({
              where: { id: existingVariant.variantId },
              data: variantFields,
            })
          : await tx.productVariant.create({
              data: { ...variantFields, productId: product.id },
            });

        await tx.externalVariantMapping.upsert({
          where: {
            provider_shopDomain_variantId: {
              provider: "ODOO",
              shopDomain: database,
              variantId: variantRow.id,
            },
          },
          create: {
            provider: "ODOO",
            shopDomain: database,
            variantId: variantRow.id,
            externalProductId: String(template.odooTemplateId),
            externalVariantId: String(variant.odooVariantId),
            importStatus: "IMPORTED",
            lastSyncedAt: new Date(),
          },
          update: {
            externalProductId: String(template.odooTemplateId),
            externalVariantId: String(variant.odooVariantId),
            importStatus: "IMPORTED",
            lastSyncedAt: new Date(),
            lastSyncError: null,
          },
        });

        // Attributes are replaced rather than merged: they describe the Odoo
        // variant, and a stale "size: Queen" left behind by a correction in
        // Odoo would be a claim about a product that is no longer true.
        await tx.variantOption.deleteMany({ where: { variantId: variantRow.id } });
        if (variant.attributes.length) {
          await tx.variantOption.createMany({
            data: variant.attributes.map((attribute, optionIndex) => ({
              variantId: variantRow.id,
              name: attribute.attribute,
              value: attribute.value,
              sortOrder: optionIndex,
            })),
          });
        }

        variantRows.push({
          odooVariantId: variant.odooVariantId,
          variantId: variantRow.id,
          sku,
          price: variant.listPrice,
          available: variant.available,
        });
        result.variantsWritten += 1;
      }

      if (existing) result.updated += 1;
      else result.created += 1;

      result.templates.push({
        odooTemplateId: template.odooTemplateId,
        name: template.odooName,
        productId: product.id,
        outcome: existing ? "UPDATED" : "CREATED",
        productCode: product.productCode,
        variants: variantRows,
      });
    });
  }

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: "odoo-import",
    actorName: "Odoo import",
    action: "odoo.products_imported",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: preview.templates.map((item) => String(item.odooTemplateId)).join(","),
    afterData: {
      database,
      created: result.created,
      updated: result.updated,
      variants: result.variantsWritten,
      templates: result.templates.map((item) => ({
        odooTemplateId: item.odooTemplateId,
        productCode: item.productCode,
        outcome: item.outcome,
      })),
    },
  });

  return { preview, executed: true, result };
}

/** "TEST PILLOW — Queen", falling back to the SKU when there is no attribute. */
function variantName(
  productName: string,
  variant: { sku: string | null; attributes: { value: string }[] },
): string {
  const attribute = variant.attributes.map((item) => item.value).filter(Boolean).join(" / ");
  return attribute ? `${productName} — ${attribute}` : (variant.sku ?? productName);
}
