/**
 * Which Odoo pricelist row prices a variant — as a pure function.
 *
 * THE DECISION THIS ENCODES. Odoo is the pricing authority: the price MoonVella
 * charges a seller comes from a dedicated "MoonVella Wholesale" pricelist, and
 * from nowhere else. Not from `lst_price`, not from the template's
 * `list_price`, and never from the product's cost. Those three are all still
 * readable in Odoo and all still look like a price, which is exactly why the
 * substitution is easy to make by accident and why the rule is expressed as
 * code rather than as a comment on a read.
 *
 * WHAT A ROW HAS TO SATISFY. A row prices the variant at quantity 1 only when
 * all of these hold:
 *
 *   • it names this variant (`applied_on = 0_product_variant`), or names this
 *     variant's template (`applied_on = 1_product`);
 *   • `compute_price = fixed` and `price_surcharge = 0` — a percentage, a
 *     formula, or a fixed price that charges an extra is a rule MoonVella
 *     cannot turn into a firm number, and guessing at one would be inventing
 *     the very price this module exists to look up;
 *   • `min_quantity <= 1`, because a tier that starts at 6 units is not the
 *     price of one unit;
 *   • today falls inside `date_start`/`date_end`, both ends inclusive. Odoo
 *     stores dates, not timestamps, so a rule ending today still applies today.
 *
 * A MORE SPECIFIC ROW WINS, WHICH IS ODOO'S OWN PRECEDENCE. A variant-level row
 * is consulted first; only when the variant has no row that can price it is the
 * template-level row used. This is not a convenience — it is what Odoo does, so
 * billing a different figure would put MoonVella's charge and Odoo's own order
 * line out of step.
 *
 * NOTHING IS EVER PICKED AT RANDOM. Two rows that could both price quantity 1
 * is an ambiguity an import must not resolve by taking the first one Odoo
 * returned: the difference is money, and the person who set the pricelist is
 * the only one who knows which row was meant. The answer is a problem naming
 * both row ids, and the import refuses.
 *
 * HARD-CODED CAD. `WHOLESALE_CURRENCY` is the currency of every price this
 * module resolves, because MoonVella bills sellers in CAD and does no
 * conversion. The pricelist itself must be a CAD pricelist — that check is the
 * caller's, since it is a fact about the pricelist rather than about a row, and
 * it is enforced in `odooImport.server.ts`.
 *
 * PURE, AND DELIBERATELY SO. No Prisma, no credentials, no `searchRead`: the
 * rules above are the part worth testing exhaustively, and a module that needs
 * a live Odoo to test is a module whose tests never run.
 */

/**
 * The currency of every wholesale price MoonVella charges. Not configurable:
 * the owner's ruling is CAD only, with no conversion, so the storefront
 * currency of a product is never the currency a seller is billed in.
 */
export const WHOLESALE_CURRENCY = "CAD";

/** Odoo's `applied_on` values, spelled as Odoo spells them. */
export const VARIANT_LEVEL = "0_product_variant";
export const TEMPLATE_LEVEL = "1_product";

/**
 * A `product.pricelist.item` row as Odoo sends it, and a normalised one.
 *
 * The wire type is deliberately loose: Odoo returns `false` for an empty field
 * and `[id, name]` for a many2one, and a type that pretended otherwise would
 * push those conversions into every caller.
 */
export interface OdooPricelistItemRow {
  id: number;
  applied_on?: unknown;
  product_id?: unknown;
  product_tmpl_id?: unknown;
  min_quantity?: unknown;
  date_start?: unknown;
  date_end?: unknown;
  compute_price?: unknown;
  fixed_price?: unknown;
  price_surcharge?: unknown;
  percent_price?: unknown;
  [key: string]: unknown;
}

export interface OdooPricelistItem {
  id: number;
  /** `0_product_variant`, `1_product`, or a category/global level. */
  appliedOn: string;
  productVariantId: number | null;
  productTemplateId: number | null;
  minQuantity: number;
  /** `YYYY-MM-DD`, or null for "no start"/"no end". */
  dateStart: string | null;
  dateEnd: string | null;
  computePrice: string;
  fixedPrice: number | null;
  priceSurcharge: number;
  percentPrice: number | null;
}

/** A rule that priced the variant, with the row it came from. */
export interface PricedOutcome {
  kind: "priced";
  wholesale: number;
  currency: typeof WHOLESALE_CURRENCY;
  /** The pricelist row this price came from, so a figure can be traced. */
  itemId: number;
  level: "variant" | "template";
  /** Set when the variant also carries quantity tiers MoonVella does not apply. */
  note: string | null;
}

export interface PriceProblem {
  kind: "problem";
  code: string;
  message: string;
}

export type PriceOutcome = PricedOutcome | PriceProblem;

export interface MatchInput {
  variantId: number;
  templateId: number;
  /** Today, as `YYYY-MM-DD`. Windows are compared date-only and inclusively. */
  today: string;
  /** Named in messages so a refusal says which pricelist to go and edit. */
  pricelistName?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/** Odoo's `false` and `undefined` both mean "empty"; a string means a string. */
function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function numberOf(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === false) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A many2one arrives as `[id, label]`, or as a bare id, or as `false`. */
function idOf(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === "number") return value[0];
  if (typeof value === "number") return value;
  return null;
}

/** Odoo dates are `YYYY-MM-DD`; anything else is not a date and is dropped. */
function dateOf(value: unknown): string | null {
  const raw = textOf(value);
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

export function normalizePricelistItem(row: OdooPricelistItemRow): OdooPricelistItem {
  const fixed = row.fixed_price;
  const percent = row.percent_price;
  return {
    id: row.id,
    // A row that does not say what it applies to applies to everything, which
    // is not this variant. `3_global` is Odoo's own "All Products".
    appliedOn: textOf(row.applied_on) ?? "3_global",
    productVariantId: idOf(row.product_id),
    productTemplateId: idOf(row.product_tmpl_id),
    // Odoo's default minimum is 1. A row with no minimum is the base price.
    minQuantity: numberOf(row.min_quantity, 1),
    dateStart: dateOf(row.date_start),
    dateEnd: dateOf(row.date_end),
    // Odoo's default is a fixed price; a row that says nothing else is treated
    // as one rather than being refused for a missing field.
    computePrice: textOf(row.compute_price) ?? "fixed",
    fixedPrice: fixed === null || fixed === undefined || fixed === false ? null : numberOf(fixed, 0),
    priceSurcharge: numberOf(row.price_surcharge, 0),
    percentPrice:
      percent === null || percent === undefined || percent === false
        ? null
        : numberOf(percent, 0),
  };
}

export function normalizePricelistItems(rows: OdooPricelistItemRow[]): OdooPricelistItem[] {
  return rows.map(normalizePricelistItem);
}

/** Today as `YYYY-MM-DD`, in UTC. The unit a pricelist window is expressed in. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* The rules                                                                  */
/* -------------------------------------------------------------------------- */

function inWindow(item: OdooPricelistItem, today: string): boolean {
  if (item.dateStart && item.dateStart > today) return false;
  if (item.dateEnd && item.dateEnd < today) return false;
  return true;
}

/**
 * A rule MoonVella can turn into a number: a fixed price with no surcharge.
 *
 * `price_surcharge` is not "a small extra to add on". In Odoo it changes the
 * rule's meaning — a fixed price with a surcharge is a price plus an amount per
 * unit — and the owner ruled surcharges unsupported rather than approximated.
 */
function isSupportedRule(item: OdooPricelistItem): boolean {
  return item.computePrice === "fixed" && item.priceSurcharge === 0;
}

function describeRule(item: OdooPricelistItem): string {
  if (item.computePrice === "percentage") {
    return `a percentage rule (${item.percentPrice ?? 0}% off)`;
  }
  if (item.computePrice === "formula") {
    return "a formula rule";
  }
  if (item.computePrice === "fixed" && item.priceSurcharge !== 0) {
    return `a fixed price with a surcharge of ${item.priceSurcharge} added to it`;
  }
  return `a "${item.computePrice}" rule`;
}

/** "the "MoonVella Wholesale" pricelist", or a neutral phrase when unnamed. */
function where(pricelistName?: string | null): string {
  const name = textOf(pricelistName ?? null);
  return name ? `the "${name}" pricelist` : "the selected wholesale pricelist";
}

function ambiguous(candidates: OdooPricelistItem[], input: MatchInput, level: string): PriceProblem {
  const ids = candidates.map((item) => item.id).join(", ");
  return {
    kind: "problem",
    code: "WHOLESALE_PRICE_AMBIGUOUS",
    message:
      `${candidates.length} rows in ${where(input.pricelistName)} could price this variant at ` +
      `quantity 1 (pricelist rows ${ids}, ${level} level). MoonVella will not choose between them, ` +
      `because which one applies is a decision the pricelist's owner already made and the two ` +
      `decisions do not agree.`,
  };
}

function unsupported(item: OdooPricelistItem, input: MatchInput, level: string): PriceProblem {
  return {
    kind: "problem",
    code: "WHOLESALE_PRICE_UNSUPPORTED_RULE",
    message:
      `The row that prices this variant at quantity 1 in ${where(input.pricelistName)} is ` +
      `${describeRule(item)} (row ${item.id}, ${level} level), which MoonVella cannot turn into a ` +
      `firm price. Only a fixed price with no surcharge is supported.`,
  };
}

/**
 * A row priced the variant at zero, or at less than nothing.
 *
 * A zero is not "free": it is a pricelist nobody finished, and importing it
 * would have MoonVella ship goods and charge nothing for them.
 */
function notPositive(item: OdooPricelistItem, input: MatchInput, level: string): PriceProblem {
  return {
    kind: "problem",
    code: "WHOLESALE_PRICE_NOT_POSITIVE",
    message:
      `The quantity-1 price for this variant is ${item.fixedPrice} (pricelist row ${item.id}, ` +
      `${level} level), so a seller would be charged nothing for it. Set a price above zero in ` +
      `${where(input.pricelistName)} and import again.`,
  };
}

/**
 * The rule that has to be fixed, when no row can price the variant at all.
 *
 * The order is the owner's, and it is a priority rather than a list of
 * everything wrong: the first thing named is the one to fix. A percentage rule
 * is reported ahead of a date problem because it is unsupported even inside its
 * window — correcting the dates would not make it a price MoonVella can charge.
 */
function noApplicableRule(items: OdooPricelistItem[], input: MatchInput): PriceProblem {
  const base = {
    kind: "problem" as const,
    code: "WHOLESALE_PRICE_MISSING",
  };
  const list = where(input.pricelistName);

  const unsupportedRules = items.filter((item) => !isSupportedRule(item));
  if (unsupportedRules.length) {
    const first = unsupportedRules[0];
    return {
      ...base,
      code: "WHOLESALE_PRICE_UNSUPPORTED_RULE",
      message:
        `${list} prices this variant only with ${describeRule(first)} (row ${first.id}), and ` +
        `MoonVella charges a fixed quantity-1 price. Nothing here is a price it can bill a seller.`,
    };
  }

  const tiers = items.filter((item) => item.minQuantity > 1);
  if (tiers.length) {
    const lowest = tiers.reduce((a, b) => (a.minQuantity <= b.minQuantity ? a : b));
    return {
      ...base,
      code: "WHOLESALE_PRICE_TIER_ONLY",
      message:
        `This variant is priced only in quantity tiers in ${list}: the lowest starts at quantity ` +
        `${lowest.minQuantity} (row ${lowest.id}). MoonVella bills the quantity-1 price and will not ` +
        `use a bulk tier as the price of a single unit.`,
    };
  }

  const future = items.filter((item) => item.dateStart && item.dateStart > input.today);
  if (future.length) {
    const soonest = future.reduce((a, b) => ((a.dateStart ?? "") <= (b.dateStart ?? "") ? a : b));
    return {
      ...base,
      code: "WHOLESALE_PRICE_NOT_YET_VALID",
      message: `The price for this variant starts on ${soonest.dateStart} (row ${soonest.id}), so nothing prices it today.`,
    };
  }

  const expired = items.filter((item) => item.dateEnd && item.dateEnd < input.today);
  if (expired.length) {
    const latest = expired.reduce((a, b) => ((a.dateEnd ?? "") >= (b.dateEnd ?? "") ? a : b));
    return {
      ...base,
      code: "WHOLESALE_PRICE_EXPIRED",
      message: `The price for this variant ended on ${latest.dateEnd} (row ${latest.id}), so nothing prices it today.`,
    };
  }

  return {
    ...base,
    message:
      `${list} has no row for this variant and none for its product template either, so MoonVella ` +
      `has no price to charge a seller for it.`,
  };
}

/**
 * The rows that could price this variant at quantity 1, in this scope.
 *
 * "Could price" is deliberately broad: a row in its date window with a minimum
 * of one unit is a row Odoo would apply, whether or not MoonVella can compute
 * it. Narrowing this to supported rules would let a percentage rule at variant
 * level be quietly outranked by a template-level fixed price — a figure MoonVella
 * would then bill while Odoo's own order line, which does understand the
 * percentage, said something else.
 */
function candidatesInScope(items: OdooPricelistItem[], today: string): OdooPricelistItem[] {
  return items.filter((item) => inWindow(item, today) && item.minQuantity <= 1);
}

function scopeOutcome(
  items: OdooPricelistItem[],
  level: "variant" | "template",
  input: MatchInput,
): PricedOutcome | PriceProblem | null {
  const candidates = candidatesInScope(items, input.today);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return ambiguous(candidates, input, level);

  const only = candidates[0];
  if (!isSupportedRule(only)) return unsupported(only, input, level);
  if (!(only.fixedPrice !== null && only.fixedPrice > 0)) return notPositive(only, input, level);

  return {
    kind: "priced",
    wholesale: only.fixedPrice,
    currency: WHOLESALE_CURRENCY,
    itemId: only.id,
    level,
    note: tierNote(items, input),
  };
}

/**
 * Whether the variant is also priced in quantity tiers, which MoonVella does
 * not apply. Said plainly rather than left out: a seller who is quoted the
 * quantity-1 price for six units should be able to see that the pricelist
 * offered something else and that MoonVella chose not to use it.
 */
function tierNote(items: OdooPricelistItem[], input: MatchInput): string | null {
  const tiers = items.filter((item) => item.minQuantity > 1 && inWindow(item, input.today));
  if (tiers.length === 0) return null;
  const lowest = tiers.reduce((a, b) => (a.minQuantity <= b.minQuantity ? a : b));
  return (
    `Quantity discounts are not supported yet: ${where(input.pricelistName)} also prices larger ` +
    `quantities (from quantity ${lowest.minQuantity}), and sellers are charged the quantity-1 price.`
  );
}

/**
 * The wholesale price of one variant, at quantity 1, in CAD.
 *
 * Variant-level rows are consulted first and template-level rows only when the
 * variant has none, which is Odoo's own precedence. Nothing falls back to a
 * list price, a retail price or a cost: when no row can price the variant the
 * answer is a problem, and the caller refuses rather than importing a number
 * nobody agreed to.
 */
export function matchBasePrice(
  items: OdooPricelistItem[],
  input: MatchInput,
): PriceOutcome {
  const variantItems = items.filter(
    (item) => item.appliedOn === VARIANT_LEVEL && item.productVariantId === input.variantId,
  );
  const templateItems = items.filter(
    (item) => item.appliedOn === TEMPLATE_LEVEL && item.productTemplateId === input.templateId,
  );

  const variant = scopeOutcome(variantItems, "variant", input);
  if (variant) return variant;

  const template = scopeOutcome(templateItems, "template", input);
  if (template) return template;

  return noApplicableRule([...variantItems, ...templateItems], input);
}
