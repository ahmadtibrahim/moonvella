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
 * PRICES COME FROM EACH VARIANT'S EFFECTIVE SALES PRICE. The owner's ruling is
 * that Odoo is the pricing authority, and the figure it supplies is the one a
 * seller would see on the product's own form: `product.product.lst_price`, which
 * the Odoo ORM composes from the template's list price plus that variant's
 * attribute price extras. It is read AS THE ORM COMPUTES IT and is never
 * recomposed here — the read is one field, so there is no second formula in this
 * module that could drift from Odoo's.
 *
 * There used to be a wholesale pricelist between Odoo and this module. It is
 * gone, and the fields it priced from are gone with it: no `list_price` or
 * `price_extra` appears in any read below, so the arithmetic cannot creep back
 * in one field at a time.
 *
 * The outcome is one of two things: a price, or a problem that blocks the
 * import. There is no third "fall back to something" path — a variant with no
 * usable sales price is not imported at the product's cost, at a retail guess or
 * at zero; it is left alone and the owner is told which product to price.
 *
 * CAD, CHECKED WHERE IT IS NOW DECIDED. The price comes from a product, so the
 * currency is the product's company currency. A company in another currency is a
 * refusal rather than a note: writing a USD figure into a column MoonVella bills
 * in CAD is a mispriced order, and nothing here converts between currencies.
 *
 * SUGGESTED RETAIL IS NOT IMPORTED. It is MoonVella's own field, edited here,
 * and an import neither writes it nor copies the wholesale price into it. On a
 * re-import it is left exactly as it is, including when the wholesale price
 * changes underneath it.
 *
 * STOCK IS READ, NEVER WRITTEN, AND NEVER INVENTED. Available quantity is what
 * is held ANYWHERE INSIDE THE CONFIGURED FULFILLMENT WAREHOUSE — every shelf,
 * every owner — minus what is already reserved there. The quantities are read
 * at import time on every run — this module contains no quantity literals — and
 * nothing here writes to `stock.quant`. If the fulfillment warehouse is not
 * configured, the import stops and says so rather than importing a
 * plausible-looking number, because a stock figure that is wrong is worse than
 * one that is absent: absent stock stops a sale, and wrong stock takes an order
 * nobody can fill.
 *
 * ONE CATALOGUE, MANY VENDORS. There used to be a global "consignment owner" and
 * a global "consignment location", and the import refused to run without both.
 * That made the whole catalogue depend on one vendor's setting: adding a vendor,
 * or stocking a second one, meant changing a global and re-deciding what every
 * other product's stock count meant. The tag is the owner's instruction to carry
 * a product, and it is the only eligibility rule left — a tagged product is
 * imported whichever vendor it belongs to.
 *
 * OWNERSHIP IS PRESERVED, NOT FLATTENED. Every quant read here carries the
 * location and owner it sits at, and those are kept per record — a variant's
 * stock is a list of (location, owner, quantity, reserved) rows, not one merged
 * number. What is company-owned and what is a vendor's consignment stock stay
 * distinguishable, so nobody has to guess later why a figure was what it was.
 * This is separate from the product's supplier, which is a fact about who sells
 * it to MoonVella, not about who owns the boxes on the shelf.
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
import { pushProductsInventory, queueInventoryRetries } from "./inventoryPush.server";

/**
 * The currency MoonVella bills a seller in. Odoo's own currency for a product
 * is recorded alongside it as the storefront currency, and the two are never
 * converted into one another.
 */
export const WHOLESALE_CURRENCY = "CAD";

const PRODUCT_TEMPLATE_MODEL = "product.template";
const PRODUCT_VARIANT_MODEL = "product.product";
const STOCK_QUANT_MODEL = "stock.quant";
const ATTRIBUTE_VALUE_MODEL = "product.template.attribute.value";
const ATTRIBUTE_MODEL = "product.attribute";
const ATTRIBUTE_NAMED_VALUE_MODEL = "product.attribute.value";
const CURRENCY_MODEL = "res.currency";

/**
 * The one thing the owner configures about stock: which warehouse fulfils it.
 *
 * The field name and the model are named here rather than imported from
 * `odooSync.server.ts`, which keeps its own copy for the pickup address.
 * Importing them the other way round would make this module depend on the sync
 * that depends on it.
 */
const WAREHOUSE_FIELD = "ODOO_WAREHOUSE";
const WAREHOUSE_MODEL = "stock.warehouse";

export interface ImportBlocker {
  code: string;
  message: string;
  /** What the owner can do about it, in one sentence. */
  remedy: string;
}

/*
 * `list_price` on the template and `price_extra` on the attribute value are
 * deliberately ABSENT from these reads. They are the inputs Odoo's ORM adds up
 * to produce a variant's effective sales price, and reading them here would put
 * a second copy of that arithmetic in this module — free to drift from Odoo's
 * the first time the ORM's rules change. `lst_price` is read instead: one field,
 * already computed, on the record that is actually sold.
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
  /**
   * This variant's effective sales price, as Odoo computes it: the template's
   * list price plus the price extras of the attribute values this variant
   * carries. Odoo returns `false` for a field it holds nothing in, which is why
   * the caller narrows on `typeof === "number"` rather than on null.
   */
  lst_price: number | false;
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

/**
 * One stock record, as Odoo holds it: a quantity of one product at one location
 * belonging to one owner.
 *
 * `ownerId`/`ownerName` are null for company-owned stock. Odoo writes `false`
 * into `owner_id` when nobody outside the company owns the goods, and `false` is
 * not "unknown owner" — it is the company itself, which is a thing the record
 * can say and must not lose.
 */
export interface StockEntry {
  locationId: number;
  locationName: string;
  ownerId: number | null;
  ownerName: string | null;
  quantity: number;
  reserved: number;
}

export interface QuantSummary {
  /** Per Odoo variant id: the totals the catalogue's `inventory` column uses. */
  totals: Map<number, { onHand: number; reserved: number }>;
  /** Per Odoo variant id: every (location, owner) record, summed within itself. */
  records: Map<number, StockEntry[]>;
}

/**
 * Turn the quant rows into totals and per-record detail.
 *
 * PURE AND EXPORTED, like the money rules above and for the same reason: this
 * decides a stock figure, and a rule whose only test needs a live Odoo is a rule
 * whose test never runs. The awkward shapes Odoo really sends — `false` for a
 * missing owner, several quants at one location for one owner, a negative
 * correction — are exercised directly against this function instead of argued
 * about.
 *
 * Two levels, and they are not the same thing. A RECORD is one (location,
 * owner) pair: several quant rows there are one shelf, so they are summed. A
 * TOTAL adds the records up. The total is what the catalogue shows, and the
 * records are what say where it came from — neither is derived from the other by
 * discarding information, because a figure nobody can trace is a figure nobody
 * can check.
 *
 * A negative quantity is passed through rather than clamped. It is a real Odoo
 * correction, and it reached this function only because it sits inside the
 * warehouse subtree the caller asked for; hiding it here would make the records
 * disagree with the total. Records are sorted by location then owner so two runs
 * over the same data produce the same rows in the same order.
 */
export function summariseQuants(quants: OdooQuantRow[]): QuantSummary {
  const totals: QuantSummary["totals"] = new Map();
  const byKey = new Map<number, Map<string, StockEntry>>();

  for (const quant of quants) {
    const productId = toId(quant.product_id);
    if (productId === null) continue;

    const total = totals.get(productId) ?? { onHand: 0, reserved: 0 };
    total.onHand += quant.quantity ?? 0;
    total.reserved += quant.reserved_quantity ?? 0;
    totals.set(productId, total);

    const locationId = toId(quant.location_id);
    if (locationId === null) continue;
    const ownerId = toId(quant.owner_id);

    const forProduct = byKey.get(productId) ?? new Map<string, StockEntry>();
    const key = `${locationId}|${ownerId ?? ""}`;
    const entry = forProduct.get(key) ?? {
      locationId,
      locationName: labelOf(quant.location_id, locationId),
      ownerId,
      // The owner's name comes from the same many2one tuple the id did — the
      // quant read already returned it, so nothing extra is asked of Odoo.
      ownerName: ownerId === null ? null : labelOf(quant.owner_id, ownerId),
      quantity: 0,
      reserved: 0,
    };
    entry.quantity += quant.quantity ?? 0;
    entry.reserved += quant.reserved_quantity ?? 0;
    forProduct.set(key, entry);
    byKey.set(productId, forProduct);
  }

  const records: QuantSummary["records"] = new Map();
  for (const [productId, forProduct] of byKey) {
    records.set(
      productId,
      [...forProduct.values()].sort(
        (a, b) =>
          a.locationId - b.locationId ||
          (a.ownerId ?? 0) - (b.ownerId ?? 0),
      ),
    );
  }

  return { totals, records };
}

/** The display name out of a many2one tuple, or the id when it has none. */
function labelOf(value: unknown, fallback: number): string {
  if (Array.isArray(value) && typeof value[1] === "string" && value[1].trim()) {
    return value[1].trim();
  }
  return String(fallback);
}

export interface PreviewVariant {
  odooVariantId: number;
  sku: string | null;
  attributes: { attribute: string; value: string }[];
  /**
   * Odoo's effective sales price for this variant, and the currency Odoo holds
   * it in. Null exactly when the variant carries a problem, so a null is never
   * silently imported as a price.
   */
  wholesalePrice: number | null;
  wholesaleCurrency: string | null;
  /** Cost as Odoo records it. Shown for context; never used as a price. */
  cost: number | null;
  onHand: number;
  reserved: number;
  available: number;
  /**
   * Every stock record behind those three figures: which location, whose stock,
   * how much, how much reserved. Shown so a number can be traced, and written to
   * `VariantStockRecord` so it survives the next sync.
   */
  stock: StockEntry[];
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

/**
 * The warehouse stock is counted from, and the one the owner actually named.
 *
 * `rootLocationId` is the warehouse's own view location — Odoo's `view_location_id`
 * — and it is what makes "inside this warehouse" a rule instead of a guess: the
 * read is the subtree below it, so every shelf, bin and consignment corner the
 * warehouse owns is counted, and another warehouse's stock, a customer's
 * location or the supplier negatives under `Partners/Vendors` are not.
 */
export interface OdooWarehouse {
  id: number;
  name: string;
  rootLocationId: number;
  rootLocationName: string;
  note: string;
}

export interface OdooImportPreview {
  ok: boolean;
  connection: { url: string | null; database: string | null; mode: string | null };
  tag: { id: number; name: string } | null;
  /**
   * Where a seller's price comes from, stated once for the whole page. There is
   * nothing to configure here any more: it is a fact about Odoo rather than a
   * setting, and the card shows it so the figure in the table is traceable.
   */
  pricing: {
    currency: typeof WHOLESALE_CURRENCY;
    note: string;
  };
  /**
   * The fulfilling warehouse, once it resolves. Null means the read could not
   * name one, which is always accompanied by a blocker — the stock figures in
   * `templates` are only meaningful against a scope, so there is no "unknown
   * warehouse" state worth showing a number for.
   */
  warehouse: OdooWarehouse | null;
  templates: PreviewTemplate[];
  blockers: ImportBlocker[];
  notes: string[];
  readAt: string;
}

/* -------------------------------------------------------------------------- */
/* The money rules, as pure functions                                         */
/* -------------------------------------------------------------------------- */

/*
 * WHY THESE ARE PURE AND EXPORTED. Each one decides a figure a person is
 * charged, and a rule whose only test needs a live Odoo is a rule whose test
 * never runs. `scripts/verify-pricing.ts` calls everything below directly, with
 * the shapes Odoo really sends — including the awkward ones — so the refusals
 * are exercised in this environment rather than argued about.
 */

export type PriceDecision =
  | { ok: true; price: number }
  | { ok: false; problem: string };

/**
 * The price a seller is charged for one variant, from the value Odoo returned
 * for `lst_price`.
 *
 * There is no fallback of any kind, and that is the whole point. A cost, a
 * retail guess or a zero would each look like an answer; a figure nobody set is
 * worse than a refusal, because a refusal is visible and a wrong price is an
 * order. So a variant without a usable sales price carries the reason instead,
 * and its product is left out of the sync.
 */
export function chargeablePrice(lstPrice: unknown): PriceDecision {
  const price = readNumber(lstPrice);
  if (price === null) {
    return {
      ok: false,
      problem:
        "Odoo returns no sales price for this variant, so there is no figure to charge a " +
        "seller. MoonVella does not fall back to the product's cost, to a retail guess or " +
        "to zero.",
    };
  }
  if (!(price > 0)) {
    return {
      ok: false,
      problem:
        `Odoo's sales price for this variant is ${price.toFixed(2)}, which cannot be ` +
        `charged. Set the price in Odoo, then sync again.`,
    };
  }
  return { ok: true, price };
}

/**
 * The currency a variant's price may be written in.
 *
 * One function because it is one decision: the price comes from a product, so it
 * carries the product's company currency, and MoonVella bills in CAD. A company
 * in another currency is a refusal and not a note — writing a USD figure into a
 * column that is billed in CAD misprices the order, and nothing in this module
 * converts between currencies, so there is no correct figure to write.
 *
 * A template shared between companies genuinely has no single company currency.
 * That is a note rather than a refusal: the price is still a number Odoo
 * computed, and what is recorded is what MoonVella bills in, said out loud.
 */
export function billableCurrency(
  companyCurrency: unknown,
  productName: string,
): { ok: true; currency: string; note: string | null } | { ok: false; blocker: ImportBlocker } {
  const currency = typeof companyCurrency === "string" && companyCurrency.trim()
    ? companyCurrency.trim()
    : null;

  if (currency === null) {
    return {
      ok: true,
      currency: WHOLESALE_CURRENCY,
      note:
        `No company currency could be read from Odoo for ${productName}; ` +
        `${WHOLESALE_CURRENCY} is recorded because that is the currency MoonVella bills in.`,
    };
  }
  if (currency !== WHOLESALE_CURRENCY) {
    return {
      ok: false,
      blocker: {
        code: "ODOO_PRICE_CURRENCY_NOT_CAD",
        message:
          `${productName} is priced in ${currency}, and MoonVella bills sellers in ` +
          `${WHOLESALE_CURRENCY}.`,
        remedy:
          `Set that product's company currency to ${WHOLESALE_CURRENCY} in Odoo, or untag it ` +
          `from "${MOONVELLA_PRODUCT_TAG_NAME}". MoonVella does not convert between currencies.`,
      },
    };
  }
  return { ok: true, currency, note: null };
}

/**
 * A price in the currency's major unit, as the whole number of minor units the
 * catalogue stores. Rounding lives here rather than at the call site so there is
 * one answer to "what is 19.99 in cents" in the whole import.
 */
export function toCents(price: number): number {
  return Math.round(price * 100);
}

/**
 * A number Odoo sent, or null.
 *
 * Odoo puts `false` in a field it holds nothing in, and `false` is a perfectly
 * good zero in JavaScript — which is exactly the trap: `Number(false) === 0`,
 * and a price of zero looks like a free product rather than a missing one. So
 * only a number, or a string that is entirely a number, is read as a number.
 */
export function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Reference resolution                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A configuration label, as a stable code fragment: "Fulfillment warehouse"
 * becomes `FULFILLMENT_WAREHOUSE`. A code with a space in it is not an
 * identifier, and these are the codes blockers are read by.
 */
function codeFor(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Resolve a configured location, owner or warehouse from its label.
 *
 * A numeric value is taken as an id; anything else is a name, and a name has to
 * be unambiguous. Two locations called "Consignment" would otherwise become
 * whichever one the database happened to return first, which is a stock figure
 * taken from the wrong shelf.
 */
export async function resolveReference(
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
 * The columns a re-import may write over a product that is already here.
 *
 * WHAT ODOO OWNS, AND WHAT IT DOES NOT.
 *
 * Name, category and currency are Odoo's: they are the catalogue's own identity
 * for the template, and MoonVella has nowhere better to keep them. Description is
 * NOT one of those, whatever it looks like — the Details tab edits it here, and
 * the sync runs every six hours over every mapped product. Writing Odoo's copy
 * over it unconditionally means a description typed in MoonVella is gone by the
 * next sync, with no error and nothing on screen to say why: the owner types it
 * again, saves again, sees it saved, and it disappears again the same way. So a
 * description already written here is KEPT. Odoo's text is written only where
 * there is none of ours to lose — the first import, and any product whose
 * description is still blank here.
 *
 * PUBLICATION IS NOT IN THIS OBJECT EITHER. `status` and `isPublished` are the
 * publication gate, and only an operator moves them. An update that carried
 * `status: "DRAFT", isPublished: false` would unpublish a published product every
 * six hours — silently, since the sync is not something anybody is watching. The
 * gate is opened when a product is created (a draft, unpublished — see the create
 * path below) and by the restore path when the sync itself was what archived it;
 * never by a routine re-import.
 */
export function updateFieldsFor(
  template: Pick<PreviewTemplate, "odooName" | "description" | "odooCategory" | "currency">,
  held: { description: string | null }
) {
  return {
    name: template.odooName,
    description: held.description?.trim() ? held.description : template.description,
    category: template.odooCategory,
    currency: template.currency,
  };
}

/**
 * Read everything the import would use, and say what it cannot do.
 *
 * Read-only, and safe to run at any time: it resolves references, reads the
 * tagged templates, their variants, their attributes, their prices and their
 * stock, and writes nothing anywhere.
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
    pricing: {
      currency: WHOLESALE_CURRENCY,
      note:
        "A seller is charged each variant's effective sales price in Odoo — the price on the " +
        "variant's own form, which is the template's list price plus that variant's attribute " +
        "price extras. It is read as the Odoo ORM computes it, in one field, so this module holds " +
        "no second copy of the arithmetic. The product's cost is recorded for reference and is " +
        "never charged to a seller.",
    },
    warehouse: null,
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

  /*
   * The fulfillment warehouse. ONE setting, and it is not about ownership: the
   * owner names where goods ship from, and every vendor's stock inside it counts.
   * A name is searched on either of the two fields a warehouse is called by —
   * its name ("Premafirm Inc.") or its code ("WH") — because Odoo's warehouse
   * form has both and the owner may reach for either.
   */
  const warehouseValue = await getCredential("odoo", WAREHOUSE_FIELD);
  const warehouse = await resolveReference(
    WAREHOUSE_MODEL,
    warehouseValue ?? "",
    [
      { field: "name", label: "name" },
      { field: "code", label: "short code" },
    ],
    ["id", "name", "code", "view_location_id"],
    "Fulfillment warehouse",
  );
  if ("code" in warehouse) {
    blockers.push(warehouse);
    return preview;
  }

  /*
   * The view location, read from the resolved row. It is what makes "inside this
   * warehouse" a subtree rather than a list of location ids somebody has to
   * maintain: WH/Stock, WH/Stock/EcoComfort Consignment and any bin added later
   * are all below it, and none of them has to be named here.
   */
  const [warehouseRow] = await searchRead<OdooRecord>(
    WAREHOUSE_MODEL,
    [["id", "=", warehouse.id]],
    ["id", "name", "view_location_id"],
  );
  const rootLocationId = toId(warehouseRow?.view_location_id);
  if (rootLocationId === null) {
    blockers.push({
      code: "WAREHOUSE_WITHOUT_LOCATION",
      message:
        `Odoo's warehouse "${warehouse.name}" (id ${warehouse.id}) has no view location, so ` +
        `MoonVella cannot tell which shelves belong to it.`,
      remedy:
        `Set that warehouse's location in Odoo (Inventory → Configuration → Warehouses), or ` +
        `point ${WAREHOUSE_FIELD} at a warehouse that has one.`,
    });
    return preview;
  }

  const rootLocationName = labelOf(warehouseRow.view_location_id, rootLocationId);
  preview.warehouse = {
    id: warehouse.id,
    name: warehouse.name,
    rootLocationId,
    rootLocationName,
    note:
      `Stock is counted inside ${warehouse.name} (id ${warehouse.id}), i.e. everything under ` +
      `${rootLocationName} (location ${rootLocationId}), less anything already reserved ` +
      `there. Every owner counts — company-owned and consignment stock alike — and stock at ` +
      `any other warehouse is not counted.`,
  };

  /* ------------------------- templates and variants ------------------------ */
  const templates = await searchRead<OdooTemplateRow>(
    PRODUCT_TEMPLATE_MODEL,
    [["product_tag_ids", "in", [tag.id]]],
    [
      "id",
      "name",
      "default_code",
      // No `list_price`: it is one of the two inputs the ORM adds up to make a
      // variant's effective price, and reading it here would put that sum a
      // keystroke away from being done again in this module.
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
    PRODUCT_VARIANT_MODEL,
    [
      ["product_tmpl_id", "in", templateIds],
      // Archived variants are read too: a variant withdrawn in Odoo is a fact
      // the owner is owed, and it arrives as `active: false` rather than as a
      // variant that quietly stops existing.
      ["active", "in", [true, false]],
    ],
    [
      "id",
      "default_code",
      "barcode",
      // Cost, for reference only — it is never a price.
      "standard_price",
      // The seller's price: the ORM-computed effective sales price, in one
      // field. `price_extra` is deliberately not read; it is an input to this
      // number, not a second opinion about it.
      "lst_price",
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
  // Names only. `price_extra` is not read: the attribute's money already
  // reaches MoonVella inside `lst_price`, and reading it here as well would be
  // the first half of adding it up a second time.
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

  /*
   * Stock: one query, scoped to the warehouse and to NOTHING else.
   *
   * `child_of` the warehouse's view location is the whole rule. It reaches every
   * location the warehouse owns — WH/Stock, the consignment corner under it, a
   * bin somebody adds next month — and it stops there, so another warehouse's
   * shelves, a customer's location and the supplier negatives Odoo books under
   * `Partners/Vendors` are all outside the scope and cannot be counted.
   *
   * THERE IS NO OWNER FILTER, deliberately. Filtering by owner is what made the
   * import depend on one vendor's setting; the owner of each record is read and
   * kept instead, so two vendors' stock inside the same warehouse are both
   * counted, and which is which stays legible. `owner_id` is still in the fields
   * list — as something to READ, not something to filter on.
   */
  const quants = variantIds.length
    ? await searchRead<OdooQuantRow>(
        STOCK_QUANT_MODEL,
        [
          ["product_id", "in", variantIds],
          ["location_id", "child_of", [rootLocationId]],
        ],
        ["id", "product_id", "location_id", "owner_id", "quantity", "reserved_quantity"],
      )
    : [];
  const { totals: stockByVariant, records: stockRecordsByVariant } = summariseQuants(quants);

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

    const currency = billableCurrency(
      companyCurrency.get(toId(template.company_id) ?? -1),
      text(template.name) ?? String(template.id),
    );
    const currencyCode = currency.ok ? currency.currency : WHOLESALE_CURRENCY;
    if (!currency.ok) blockers.push(currency.blocker);
    else if (currency.note) notes.push(currency.note);

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
       * The price, or the reason there is none. The decision itself is
       * `chargeablePrice`, above: this line reads Odoo's field and hands it
       * over unchanged, so the rule has one implementation and one test.
       */
      const priced = chargeablePrice(variant.lst_price);
      if (!priced.ok) variantProblems.push(priced.problem);

      const stock = stockByVariant.get(variant.id) ?? { onHand: 0, reserved: 0 };
      return {
        odooVariantId: variant.id,
        sku,
        attributes: attributesForVariant,
        wholesalePrice: priced.ok ? priced.price : null,
        wholesaleCurrency: priced.ok ? currencyCode : null,
        cost: variant.standard_price ?? null,
        onHand: stock.onHand,
        reserved: stock.reserved,
        available: Math.max(0, stock.onHand - stock.reserved),
        stock: stockRecordsByVariant.get(variant.id) ?? [],
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
      `Every price is that variant's effective sales price in Odoo, in ${WHOLESALE_CURRENCY}; the ` +
      `product's cost is recorded for reference and is never charged. ` +
      `Stock is what is held inside the fulfillment warehouse, every owner included, ` +
      `less what is already reserved.`,
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
 * a warehouse location called "false". A record that has a name uses it; one
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
  /**
   * Products this sync had withdrawn, and has just brought back because the
   * template carries the tag again. Counted separately from `updated` because it
   * is the one update that changes whether a product is on sale at all.
   */
  restored: number;
  variantsWritten: number;
  /**
   * Tagged templates that were NOT written, and why. A product Odoo cannot
   * describe completely is left exactly as it is — not created, not updated, and
   * not deleted — and reported here so the reason is on a screen rather than in
   * somebody's memory of a page that used to show it.
   */
  blocked: { odooTemplateId: number; name: string; problems: string[] }[];
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
      /** The stock records written for this variant, one per location and owner. */
      stock: {
        locationName: string;
        ownerName: string | null;
        quantity: number;
        reserved: number;
      }[];
    }[];
  }[];
}

/**
 * Write the previewed templates into MoonVella as drafts.
 *
 * TWO KINDS OF REFUSAL, AND THEY ARE NOT THE SAME.
 *
 * A BLOCKER stops the whole run. Every blocker is a fact about the read itself —
 * no connection, no tag, no fulfillment warehouse, a company billing in another
 * currency — so there is no trustworthy catalogue to write and nothing is
 * written. A half-read catalogue that looks complete is worse than no import.
 *
 * A TEMPLATE PROBLEM skips that template and lets the rest through. A product
 * missing a SKU is a fact about one product, and the tag is the owner's
 * instruction to carry it. Refusing the whole catalogue over it would mean one
 * unfinished product in Odoo silently freezes every finished one — which is what
 * a scheduled sync must never do. The skipped product is reported with its
 * reason, is left exactly as it was, and is tried again on the next run.
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

  const writable = preview.templates.filter((item) => item.problems.length === 0);
  const blocked = preview.templates
    .filter((item) => item.problems.length > 0)
    .map((item) => ({
      odooTemplateId: item.odooTemplateId,
      name: item.odooName,
      problems: item.problems,
    }));

  const database = preview.connection.database ?? "";
  const result: ImportResult = {
    created: 0,
    updated: 0,
    restored: 0,
    variantsWritten: 0,
    blocked,
    templates: [],
  };

  /*
   * The products whose stock figures this run actually moved.
   *
   * Odoo is the authority on what is on the shelf, and this sync is how that
   * authority reaches the catalogue — so it is also how it has to reach the
   * storefronts. Collected per product rather than per variant because the push
   * sends one call per store carrying every size, and only for what changed:
   * re-sending the whole catalogue every six hours would be thousands of
   * pointless inventory writes a day, and a store whose quantities are steady
   * would see no difference at all.
   */
  const stockMoved = new Set<string>();

  for (const template of writable) {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.externalProductMapping.findFirst({
        where: {
          provider: "ODOO",
          shopDomain: database,
          externalProductId: String(template.odooTemplateId),
        },
        select: {
          productId: true,
          importStatus: true,
          // Read for `updateFieldsFor`: what is already written here is what the
          // update must not overwrite.
          product: { select: { description: true } },
        },
      });

      /*
       * THE CREATE PATH, and only the create path. A product arriving for the
       * first time is a draft, and not published: the publication gate is the
       * only thing that moves a product in front of a seller, and an import must
       * not be able to do it by accident. Odoo's description is taken as it
       * stands, because there is nothing written here yet to lose.
       *
       * A product that is ALREADY here goes through `updateFieldsFor` instead —
       * see the rule above it for which columns survive a re-import and which do
       * not. Nothing outside these objects is written either way: media,
       * documents, features, materials, care instructions and shipping detail
       * are not named here at all, so "preserve MoonVella-added media and
       * documents" holds by omission rather than by a merge.
       */
      const productFields = {
        name: template.odooName,
        description: template.description,
        category: template.odooCategory,
        currency: template.currency,
        status: "DRAFT" as const,
        isPublished: false,
      };

      /*
       * A WITHDRAWN PRODUCT IS BROUGHT BACK, AND NOTHING ELSE IS.
       *
       * The sync archives a product when its template loses the tag or is
       * archived in Odoo, and it records that on the mapping. If the tag comes
       * back, this is the row that says the sync is the one that hid it — so the
       * sync is the one that may unhide it, with the same four columns
       * `setArchived(false)` writes.
       *
       * A product an OPERATOR archived keeps `importStatus: "IMPORTED"` and is
       * therefore left alone: an import that un-archived it would be fighting a
       * decision somebody made here on purpose, and would do it every six hours.
       */
      const restoring = existing?.importStatus === "WITHDRAWN";
      const held = { description: existing?.product.description ?? null };
      const product = existing
        ? await tx.product.update({
            where: { id: existing.productId },
            data: restoring
              ? {
                  ...updateFieldsFor(template, held),
                  /*
                   * Coming back from the sync's own archive is the one case where
                   * the sync may also reopen the gate — with the same four columns
                   * `setArchived(false)` writes, and only for a product whose
                   * mapping says the sync was what closed it.
                   */
                  status: "DRAFT" as const,
                  isPublished: false,
                  isArchived: false,
                  isActive: true,
                }
              : updateFieldsFor(template, held),
          })
        : await tx.product.create({
            data: { ...productFields, productCode: template.productCode },
          });
      if (restoring) result.restored += 1;

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
         * Unreachable: a variant with no usable sales price carries a problem,
         * and only templates with no problems are written. It is checked again
         * here anyway because the alternative — multiplying a null by 100, or a
         * zero by 100 — would put a price of zero into the catalogue, and that
         * is the one mistake this whole module is arranged to prevent.
         */
        const priced = chargeablePrice(variant.wholesalePrice);
        if (!priced.ok) {
          throw new PermanentJobError(
            `The Odoo sync stopped before writing: ${template.odooName} / ${sku} — ` +
              `${priced.problem} Nothing was written for this template.`,
          );
        }
        const wholesale = priced.price;

        const existingVariant = await tx.externalVariantMapping.findFirst({
          where: {
            provider: "ODOO",
            shopDomain: database,
            externalVariantId: String(variant.odooVariantId),
          },
          select: {
            variantId: true,
            // Read to answer one question: did the shelf move since the last
            // sync? Only the variants where it did are pushed to the stores.
            variant: { select: { inventory: true, reserved: true, isActive: true } },
          },
        });

        const variantFields = {
          name: variantName(template.odooName, variant),
          sku,
          // The approved price source: Odoo's own effective sales price for
          // this variant, in cents. It is what a seller is charged.
          wholesalePrice: toCents(wholesale),
          /*
           * `suggestedRetailPrice` IS NOT HERE, and its absence is the point.
           * It is MoonVella's own editorial field, so an update must not touch
           * it — a figure edited here after the first import survives every
           * later re-import, including one where the wholesale price moved. It
           * is filled in only on create, where the column is required and the
           * honest value is zero: "no suggested retail has been set".
           */
          costPrice: variant.cost === null ? null : toCents(variant.cost),
          // Read, never written back, never defaulted.
          inventory: variant.available,
          /*
           * The other half of the figure above, kept so the catalogue can say
           * "25 on hand, 20 reserved" rather than only the difference. Written
           * from the same read as `inventory`, so the two cannot disagree.
           */
          reserved: variant.reserved,
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

        /*
         * A NEW VARIANT ALWAYS COUNTS, because its quantity has never been sent
         * anywhere. An existing one counts when any of the three figures a store
         * can be affected by has moved — the sellable count, what is held back,
         * or whether the size is on sale at all.
         */
        const previous = existingVariant?.variant;
        if (
          !previous ||
          previous.inventory !== variantFields.inventory ||
          previous.reserved !== variantFields.reserved ||
          previous.isActive !== variantFields.isActive
        ) {
          stockMoved.add(product.id);
        }

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

        /*
         * Stock records are REPLACED, never appended — the same rule the
         * attributes below follow, for the same reason. These rows describe what
         * Odoo holds right now; a row left behind by a previous sync would be a
         * quantity that no longer exists anywhere, and six-hourly syncs would
         * pile them up until the breakdown no longer described the total.
         */
        await tx.variantStockRecord.deleteMany({ where: { variantId: variantRow.id } });
        if (variant.stock.length) {
          await tx.variantStockRecord.createMany({
            data: variant.stock.map((record) => ({
              variantId: variantRow.id,
              odooLocationId: record.locationId,
              locationName: record.locationName,
              odooOwnerId: record.ownerId,
              ownerName: record.ownerName,
              quantity: record.quantity,
              reservedQuantity: record.reserved,
              odooDatabase: database,
            })),
          });
        }

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
          // What a seller is charged, i.e. the effective sales price written
          // above, in the currency Odoo holds it in.
          price: wholesale,
          priceCurrency: variant.wholesaleCurrency ?? WHOLESALE_CURRENCY,
          available: variant.available,
          stock: variant.stock.map((record) => ({
            locationName: record.locationName,
            ownerName: record.ownerName,
            quantity: record.quantity,
            reserved: record.reserved,
          })),
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
      restored: result.restored,
      variants: result.variantsWritten,
      blocked: result.blocked,
      // Where the prices came from, so a figure in the catalogue can be traced
      // to the read that produced it without opening the products.
      priceSource: "ODOO_EFFECTIVE_SALES_PRICE",
      priceCurrency: WHOLESALE_CURRENCY,
      // And where the stock figures came from: without the scope, "25" in the
      // catalogue is a number with no shelf behind it.
      stockScope: preview.warehouse
        ? {
            warehouseId: preview.warehouse.id,
            warehouse: preview.warehouse.name,
            rootLocationId: preview.warehouse.rootLocationId,
            rootLocation: preview.warehouse.rootLocationName,
          }
        : null,
      templates: result.templates.map((item) => ({
        odooTemplateId: item.odooTemplateId,
        productCode: item.productCode,
        outcome: item.outcome,
      })),
    },
  });

  /*
   * THE SHELF HAS MOVED, SO THE STOREFRONTS ARE TOLD.
   *
   * Runs after the audit, outside every transaction, and it never throws: the
   * sync has already written the catalogue successfully, and a Shopify outage
   * must not turn that into a failed sync — the numbers here are still right,
   * and a retry is queued for the stores that were not reached.
   */
  if (stockMoved.size) {
    const pushed = await pushProductsInventory([...stockMoved]);
    await queueInventoryRetries(pushed);
  }

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
