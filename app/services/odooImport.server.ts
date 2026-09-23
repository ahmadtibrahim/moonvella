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
 * PRICES COME FROM THE WHOLESALE PRICELIST, AND FROM NOWHERE ELSE. The owner's
 * ruling is that Odoo is the pricing authority: the price MoonVella charges a
 * seller is the fixed quantity-1 price on the "MoonVella Wholesale" pricelist
 * selected in MoonVella's Odoo settings. It is not `lst_price`, it is not the
 * template's `list_price`, and it is never the product's cost — all three are
 * still readable in Odoo and all three would look like an answer, which is why
 * the substitution this module used to make is called out and refused in
 * `odooPricing.ts` rather than merely avoided here.
 *
 * The rule set is that module's, and the outcome is one of two things: a price,
 * or a problem that blocks the import. There is no third "fall back to
 * something" path. A product with no usable pricelist row is not imported at a
 * guessed price; it is left alone and the owner is told which row to add.
 *
 * CAD ONLY, NO CONVERSION. Every price written here is CAD cents, and the
 * selected pricelist must itself be a CAD pricelist — checked here, because it
 * is a fact about the pricelist rather than about a row. A product whose Odoo
 * company is in another currency is imported with a note: the storefront
 * currency is recorded, the wholesale price is still CAD, and nothing is
 * converted.
 *
 * SUGGESTED RETAIL IS NOT IMPORTED. It is MoonVella's own field, edited here,
 * and an import neither writes it nor copies the wholesale price into it. On a
 * re-import it is left exactly as it is, including when the wholesale price
 * changes underneath it.
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
import {
  WHOLESALE_CURRENCY,
  matchBasePrice,
  normalizePricelistItems,
  todayIso,
  type OdooPricelistItem,
  type OdooPricelistItemRow,
} from "./odooPricing";
import { checkProductCode } from "~/utils/productCode";

const PRODUCT_TEMPLATE_MODEL = "product.template";
const STOCK_QUANT_MODEL = "stock.quant";
const STOCK_LOCATION_MODEL = "stock.location";
const PARTNER_MODEL = "res.partner";
const ATTRIBUTE_VALUE_MODEL = "product.template.attribute.value";
const ATTRIBUTE_MODEL = "product.attribute";
const ATTRIBUTE_NAMED_VALUE_MODEL = "product.attribute.value";
const CURRENCY_MODEL = "res.currency";
const PRICELIST_MODEL = "product.pricelist";
const PRICELIST_ITEM_MODEL = "product.pricelist.item";

export const CONSIGNMENT_LOCATION_FIELD = "ODOO_CONSIGNMENT_LOCATION";
export const CONSIGNMENT_OWNER_FIELD = "ODOO_CONSIGNMENT_OWNER";
export const WHOLESALE_PRICELIST_FIELD = "ODOO_WHOLESALE_PRICELIST";

export interface ImportBlocker {
  code: string;
  message: string;
  /** What the owner can do about it, in one sentence. */
  remedy: string;
}

/*
 * `list_price` on the template and `lst_price` / `price_extra` on the variant
 * are deliberately ABSENT from these reads. They are the fields the import used
 * to price from, and leaving them in the read would leave them one line away
 * from being used again. The wholesale pricelist is the only price source.
 */
interface OdooTemplateRow extends OdooRecord {
  name: string | false;
  default_code: string | false;
  categ_id: [number, string] | false;
  company_id: [number, string] | false;
  description_sale: string | false;
  description: string | false;
}

interface OdooVariantRow extends OdooRecord {
  default_code: string | false;
  barcode: string | false;
  /** The product's cost. Written to `costPrice`, never used as a price. */
  standard_price: number;
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
  attributes: { attribute: string; value: string }[];
  /**
   * The quantity-1 price from the wholesale pricelist, and the row it came
   * from. Null exactly when the variant carries a problem, so a null is never
   * silently imported as a price.
   */
  wholesalePrice: number | null;
  wholesaleCurrency: typeof WHOLESALE_CURRENCY | null;
  /** The pricelist row the price was read from, so a figure can be traced. */
  wholesaleItemId: number | null;
  /** Cost as Odoo records it. Shown for context; never used as a price. */
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
  /**
   * The pricelist every price in this preview came from. Null until it has been
   * resolved, which is what the owner sees when it is missing or misconfigured.
   */
  pricelist: {
    id: number | null;
    name: string | null;
    currency: string | null;
    /** Rows read from the pricelist itself, before any of them matched. */
    rows: number;
    note: string;
  } | null;
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
/**
 * The label, as a stable code fragment: "Wholesale pricelist" becomes
 * `WHOLESALE_PRICELIST`. A code with a space in it is not an identifier, and
 * these are matched on.
 */
function codeFor(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

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
      code: `${codeFor(label)}_NOT_CONFIGURED`,
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
        code: `${codeFor(label)}_MISSING`,
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
      code: `${codeFor(label)}_MISSING`,
      message:
        `No ${label.toLowerCase()} in Odoo matches "${trimmed}" on ` +
        `${lookup.map((item) => item.label).join(" or ")}.`,
      remedy: `Correct or clear ${label} on the Odoo integration, or use its numeric id.`,
    };
  }
  if (matches.length > 1) {
    return {
      code: `${codeFor(label)}_AMBIGUOUS`,
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
/* The wholesale pricelist                                                    */
/* -------------------------------------------------------------------------- */

/** Every column a price decision is made from, and nothing else. */
const PRICELIST_ITEM_FIELDS = [
  "id",
  "applied_on",
  "product_id",
  "product_tmpl_id",
  "min_quantity",
  "date_start",
  "date_end",
  "compute_price",
  "fixed_price",
  "price_surcharge",
  "percent_price",
];

/**
 * The currency of a pricelist, by name ("CAD"), or null when Odoo holds none or
 * it could not be read. Null is not "probably CAD": the caller refuses on it.
 */
async function pricelistCurrencyName(pricelistId: number): Promise<string | null> {
  const [pricelist] = await searchRead<OdooRecord>(
    PRICELIST_MODEL,
    [["id", "=", pricelistId]],
    ["id", "currency_id"],
    { limit: 1 },
  );
  const currencyId = toId(pricelist?.currency_id);
  if (currencyId === null) return null;
  const [currency] = await searchRead<OdooRecord>(
    CURRENCY_MODEL,
    [["id", "=", currencyId]],
    ["id", "name"],
    { limit: 1 },
  );
  return text(currency?.name ?? null);
}

/**
 * Every row of one pricelist, read in pages.
 *
 * `searchRead` returns 80 rows by default, and a truncated pricelist does not
 * look truncated: the variants whose rows fell off the end simply have no
 * price. That is a refusal rather than a wrong figure, but it is still the
 * import telling the owner something untrue about their own pricelist — that a
 * row they wrote is not there. So the read pages until a short page arrives,
 * and refuses outright rather than pretending if it never does.
 */
async function readPricelistItems(
  pricelistId: number,
): Promise<{ rows: OdooPricelistItem[] } | ImportBlocker> {
  const pageSize = 200;
  // A guard against a pricelist so large that paging never terminates. At ten
  // thousand rows something is wrong with the source, and the honest answer is
  // to stop rather than to page forever inside a web request.
  const maxRows = 10_000;
  const rows: OdooPricelistItemRow[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const page = await searchRead<OdooPricelistItemRow>(
      PRICELIST_ITEM_MODEL,
      [["pricelist_id", "=", pricelistId]],
      PRICELIST_ITEM_FIELDS,
      { limit: pageSize, offset, order: "id asc" },
    );
    rows.push(...page);
    if (page.length < pageSize) break;
    if (rows.length >= maxRows) {
      return {
        code: "WHOLESALE_PRICELIST_TOO_LARGE",
        message:
          `The selected pricelist has more than ${maxRows} rows, so MoonVella stopped reading it ` +
          `and will not import from a price list it has only partly seen.`,
        remedy:
          "Use a pricelist dedicated to MoonVella wholesale prices, or narrow this one, then try again.",
      };
    }
  }

  return { rows: normalizePricelistItems(rows) };
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
    pricelist: null,
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

  const [locationValue, ownerValue, pricelistValue] = await Promise.all([
    getCredential("odoo", CONSIGNMENT_LOCATION_FIELD),
    getCredential("odoo", CONSIGNMENT_OWNER_FIELD),
    getCredential("odoo", WHOLESALE_PRICELIST_FIELD),
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

  /*
   * The pricing authority, resolved by the same name-or-id rule as the
   * consignment pair and for the same reason: two pricelists called "MoonVella
   * Wholesale" must stop the import rather than become whichever one Odoo
   * returned first, because the difference is what every seller is charged.
   */
  const pricelist = await resolveReference(
    PRICELIST_MODEL,
    pricelistValue ?? "",
    [{ field: "name", label: "name" }],
    ["id", "name", "currency_id"],
    "Wholesale pricelist",
  );

  let pricelistItems: OdooPricelistItem[] = [];
  if ("code" in pricelist) {
    blockers.push(pricelist);
  } else {
    preview.pricelist = {
      id: pricelist.id,
      name: pricelist.name,
      currency: null,
      rows: 0,
      note: "",
    };

    /*
     * CAD, CHECKED AT THE PRICELIST, because that is where a currency lives.
     * A missing currency is a refusal too: "we could not read it" is not
     * evidence that it is CAD, and importing a price whose unit nobody can name
     * is how a seller gets billed in a currency they did not agree to.
     */
    const currencyName = await pricelistCurrencyName(pricelist.id);
    preview.pricelist.currency = currencyName;
    if (currencyName !== WHOLESALE_CURRENCY) {
      blockers.push({
        code: "WHOLESALE_PRICELIST_CURRENCY_NOT_CAD",
        message:
          `The "${pricelist.name}" pricelist is in ` +
          `${currencyName ?? "a currency MoonVella could not read from it"}, and MoonVella bills ` +
          `sellers in ${WHOLESALE_CURRENCY}.`,
        remedy:
          `Set that pricelist's currency to ${WHOLESALE_CURRENCY} in Odoo, or select a different ` +
          `pricelist on the Odoo integration. MoonVella does not convert between currencies.`,
      });
    }

    const items = await readPricelistItems(pricelist.id);
    if ("code" in items) {
      blockers.push(items);
    } else {
      pricelistItems = items.rows;
      preview.pricelist.rows = items.rows.length;
      preview.pricelist.note =
        `Seller prices come from the "${pricelist.name}" pricelist (id ${pricelist.id}, ` +
        `${currencyName ?? "currency unread"}): ${items.rows.length} row(s) read, and each variant ` +
        `is priced by its own quantity-1 fixed price. Odoo's list price is not read at all, and the ` +
        `product's cost is recorded for reference but is never charged to a seller.`;
    }
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
      // No `list_price`: it is not a price MoonVella charges, and reading it
      // would leave it a keystroke away from being used as one.
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
      // Cost, and only cost. `lst_price` and `price_extra` are the fields the
      // price used to be composed from; they are not read at all now.
      "standard_price",
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
  // Names only. `price_extra` used to be summed into the price; the wholesale
  // pricelist prices the variant, so the attribute no longer contributes money.
  const attributeValues = attributeValueIds.length
    ? await searchRead<OdooRecord>(
        ATTRIBUTE_VALUE_MODEL,
        [["id", "in", attributeValueIds]],
        ["id", "attribute_id", "product_attribute_value_id"],
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

  /*
   * One date for the whole read, and the date the pricelist windows are judged
   * against. A per-variant `new Date()` could straddle midnight and price two
   * variants of the same product on different days.
   */
  const today = todayIso();

  // Deduplicated: a tier note is a fact about the pricelist, not about each
  // variant that happens to carry tiers.
  const tierNotes = new Set<string>();

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
    const currencyCode = currency ?? WHOLESALE_CURRENCY;
    if (!currency) {
      notes.push(
        `No currency could be read from Odoo for ${text(template.name) ?? template.id}; ` +
          `${WHOLESALE_CURRENCY} is recorded because that is the currency MoonVella bills in.`,
      );
    } else if (currency !== WHOLESALE_CURRENCY) {
      /*
       * A note, not a blocker. The storefront currency and the billing currency
       * are different facts: the product is sold to shoppers in Odoo's company
       * currency, and the seller is billed in CAD. Nothing is converted — the
       * wholesale figure is the CAD figure from a CAD pricelist.
       */
      notes.push(
        `${text(template.name) ?? template.id}: Odoo's company currency for this product is ` +
          `${currency}, recorded as its storefront currency. The wholesale price is in ` +
          `${WHOLESALE_CURRENCY} and no conversion is applied between them.`,
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
          };
        });

      /*
       * The price, or the reason there is none. `matchBasePrice` never guesses:
       * a variant with no row it can use comes back as a problem, the problem
       * blocks the whole import, and nothing is written at a price nobody set.
       */
      const price = matchBasePrice(pricelistItems, {
        variantId: variant.id,
        templateId: template.id,
        today,
        pricelistName: preview.pricelist?.name ?? null,
      });
      if (price.kind === "problem") {
        variantProblems.push(price.message);
      } else if (price.note) {
        tierNotes.add(price.note);
      }

      const stock = stockByVariant.get(variant.id) ?? { onHand: 0, reserved: 0 };
      return {
        odooVariantId: variant.id,
        sku,
        attributes: attributesForVariant,
        wholesalePrice: price.kind === "priced" ? price.wholesale : null,
        wholesaleCurrency: price.kind === "priced" ? price.currency : null,
        wholesaleItemId: price.kind === "priced" ? price.itemId : null,
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

  for (const note of tierNotes) notes.push(note);

  const totalVariants = preview.templates.reduce((sum, item) => sum + item.variants.length, 0);
  notes.push(
    `${preview.templates.length} tagged template(s), ${totalVariants} variant(s) read from Odoo. ` +
      `Every price is the fixed quantity-1 price on ${
        preview.pricelist?.name ? `the "${preview.pricelist.name}" pricelist` : "the wholesale pricelist"
      }, in ${WHOLESALE_CURRENCY}; Odoo's list price is not read at all, and the product's cost is ` +
      `never charged. ` +
      `Stock is what is held at the consignment location for the consignment owner.`,
  );
  notes.push(
    "Suggested retail is not imported: it is MoonVella's own field and a re-import leaves it " +
      "as it is. Nothing has been written to Odoo by this preview, and the import does not change " +
      "Odoo inventory either: it reads quantities and prices, and writes MoonVella drafts.",
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
    variants: {
      odooVariantId: number;
      variantId: string;
      sku: string;
      /** The wholesale price written, in whole units, and its currency. */
      price: number;
      priceCurrency: string;
      available: number;
    }[];
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
        /*
         * Unreachable: a variant with no resolved price carries a problem, and
         * `importOdooProducts` refuses before this loop when any template has
         * one. It is written out anyway because the alternative — multiplying a
         * null by 100 — would write a price of zero into a catalogue, and that
         * is the one mistake this whole module is arranged to prevent.
         */
        const wholesale = variant.wholesalePrice;
        if (wholesale === null || !(wholesale > 0)) {
          throw new PermanentJobError(
            `The Odoo import stopped before writing: ${template.odooName} / ${sku} has no ` +
              `wholesale price from the pricelist. Nothing was written for this template.`,
          );
        }

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
          // The approved price source: the fixed quantity-1 price from the
          // selected wholesale pricelist, in CAD cents.
          wholesalePrice: Math.round(wholesale * 100),
          /*
           * `suggestedRetailPrice` IS NOT HERE, and its absence is the point.
           * It is MoonVella's own editorial field, so an update must not touch
           * it — a figure edited here after the first import survives every
           * later re-import, including one where the wholesale price moved. It
           * is filled in only on create, where the column is required and the
           * honest value is zero: "no suggested retail has been set".
           */
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
              data: {
                ...variantFields,
                productId: product.id,
                // Set once, at creation, and never again by an import. Zero
                // means "nothing suggested yet", which is what the editor shows
                // as empty — not a price, and certainly not the wholesale one.
                suggestedRetailPrice: 0,
              },
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
          // What was charged, i.e. the wholesale price written above.
          price: wholesale,
          priceCurrency: WHOLESALE_CURRENCY,
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
      // Which pricelist the prices came from, so a figure in the catalogue can
      // be traced to the read that produced it without opening the products.
      pricelist: preview.pricelist
        ? {
            id: preview.pricelist.id,
            name: preview.pricelist.name,
            currency: preview.pricelist.currency,
          }
        : null,
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
