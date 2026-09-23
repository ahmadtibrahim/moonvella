/**
 * The wholesale price matcher, on its own.
 *
 * WHAT THIS SUITE IS FOR. `odooPricing.ts` decides which row of the "MoonVella
 * Wholesale" pricelist prices a variant, and every one of its rules is a
 * decision about money that a person will be charged. It is written as a pure
 * module precisely so this suite can exist: there is no Odoo connection in this
 * environment, and a rule that can only be tested against a live instance is a
 * rule whose tests never run.
 *
 * WHAT IT PROVES, AND WHY EACH ONE MATTERS.
 *
 *   • Precedence matches Odoo's own, so MoonVella's charge and Odoo's order
 *     line cannot disagree about which row applies.
 *   • Nothing is ever picked at random — two rows that could both price
 *     quantity 1 are refused with both ids named, because the difference is
 *     money and only the pricelist's owner knows which row was meant.
 *   • Nothing falls back to a list price, a retail price or a cost. Where there
 *     is no usable rule the answer is a problem, and the caller refuses.
 *   • Quantity tiers are not the price of one unit, and the seller is told
 *     plainly that quantity discounts are not supported yet.
 *   • Date windows are date-only and inclusive at both ends, because Odoo
 *     stores dates and a rule ending today still applies today.
 *   • Every price is CAD. There is no conversion anywhere in this module.
 *
 * It reads no database, makes no network call and writes nothing. The catalogue
 * files it would otherwise touch are not involved: the rows below are plain
 * objects, shaped the way Odoo sends them, so the normaliser is exercised as
 * part of every check.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-pricing.ts
 */
import {
  WHOLESALE_CURRENCY,
  VARIANT_LEVEL,
  TEMPLATE_LEVEL,
  matchBasePrice,
  normalizePricelistItem,
  normalizePricelistItems,
  todayIso,
  type OdooPricelistItemRow,
  type PriceOutcome,
  type PriceProblem,
  type PricedOutcome,
} from "~/services/odooPricing";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/* -------------------------------------------------------------------------- */
/* The fixtures                                                               */
/* -------------------------------------------------------------------------- */

const VARIANT = 501;
const TEMPLATE = 901;
const OTHER_VARIANT = 502;
const TODAY = "2026-03-15";
const PRICELIST = "MoonVella Wholesale";

/** A day relative to TODAY, so the window checks never depend on the clock. */
function day(offset: number): string {
  const at = new Date(`${TODAY}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + offset);
  return at.toISOString().slice(0, 10);
}

/**
 * A pricelist row as Odoo sends it: a many2one is `[id, label]`, an empty field
 * is `false`, and numbers can arrive as strings. Defaults describe the plain
 * case — this variant, one unit, a fixed 25.00 — so each check states only what
 * it is about.
 */
function row(overrides: Partial<OdooPricelistItemRow> & { id: number }): OdooPricelistItemRow {
  return {
    applied_on: VARIANT_LEVEL,
    product_id: [VARIANT, "Pillow / White"],
    min_quantity: 1,
    compute_price: "fixed",
    fixed_price: 25,
    price_surcharge: 0,
    ...overrides,
  };
}

function templateRow(overrides: Partial<OdooPricelistItemRow> & { id: number }): OdooPricelistItemRow {
  return row({ applied_on: TEMPLATE_LEVEL, product_id: false, product_tmpl_id: [TEMPLATE, "Pillow"], ...overrides });
}

function match(rows: OdooPricelistItemRow[], variantId = VARIANT, templateId = TEMPLATE): PriceOutcome {
  return matchBasePrice(normalizePricelistItems(rows), {
    variantId,
    templateId,
    today: TODAY,
    pricelistName: PRICELIST,
  });
}

function priced(outcome: PriceOutcome): PricedOutcome | null {
  return outcome.kind === "priced" ? outcome : null;
}

function problem(outcome: PriceOutcome): PriceProblem | null {
  return outcome.kind === "problem" ? outcome : null;
}

/* -------------------------------------------------------------------------- */
/* The suite                                                                  */
/* -------------------------------------------------------------------------- */

function main() {
  console.log(`pricing suite — today ${TODAY}\n`);

  /* ------------------------------------------------------------------------ */
  console.log("A. Which row prices the variant");
  /* ------------------------------------------------------------------------ */

  const direct = match([row({ id: 1 })]);
  check(
    "A variant-level fixed price is the price of one unit",
    priced(direct)?.wholesale === 25 && priced(direct)?.level === "variant" && priced(direct)?.itemId === 1,
    JSON.stringify(direct)
  );

  const viaTemplate = match([templateRow({ id: 2, fixed_price: 30 })]);
  check(
    "The template's price is used when the variant has no row of its own",
    priced(viaTemplate)?.wholesale === 30 && priced(viaTemplate)?.level === "template",
    JSON.stringify(viaTemplate)
  );

  const both = match([templateRow({ id: 3, fixed_price: 30 }), row({ id: 4, fixed_price: 25 })]);
  check(
    "And the variant's own row wins when both exist, which is Odoo's own precedence",
    priced(both)?.wholesale === 25 && priced(both)?.level === "variant" && priced(both)?.itemId === 4,
    JSON.stringify(both)
  );

  const otherVariant = match([row({ id: 5, product_id: [OTHER_VARIANT, "Pillow / Blue"] })]);
  check(
    "A row naming a different variant does not price this one",
    problem(otherVariant)?.code === "WHOLESALE_PRICE_MISSING",
    JSON.stringify(otherVariant)
  );

  const globalRow = match([row({ id: 6, applied_on: "3_global", product_id: false, fixed_price: 10 })]);
  check(
    "Nor does an 'All Products' row: a global price is not this variant's price",
    problem(globalRow)?.code === "WHOLESALE_PRICE_MISSING",
    JSON.stringify(globalRow)
  );

  const otherTemplate = match([templateRow({ id: 7, product_tmpl_id: [902, "Cushion"] })]);
  check(
    "A row for another product template does not price this variant either",
    problem(otherTemplate)?.code === "WHOLESALE_PRICE_MISSING",
    JSON.stringify(otherTemplate)
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nB. Two rows that could both apply");
  /* ------------------------------------------------------------------------ */

  const ambiguous = match([row({ id: 10, fixed_price: 25 }), row({ id: 11, fixed_price: 26 })]);
  check(
    "Two quantity-1 rows at variant level are refused rather than chosen between",
    problem(ambiguous)?.code === "WHOLESALE_PRICE_AMBIGUOUS",
    JSON.stringify(ambiguous)
  );
  check(
    "And the refusal names both rows, so the person who set them can fix it",
    (problem(ambiguous)?.message ?? "").includes("10") && (problem(ambiguous)?.message ?? "").includes("11"),
    (problem(ambiguous)?.message ?? "").slice(0, 90)
  );

  const reversed = match([row({ id: 11, fixed_price: 26 }), row({ id: 10, fixed_price: 25 })]);
  check(
    "Reversing the order Odoo returned does not turn the refusal into a price",
    problem(reversed)?.code === "WHOLESALE_PRICE_AMBIGUOUS" &&
      priced(reversed) === null,
    JSON.stringify(reversed)
  );

  const ambiguousTemplate = match([
    templateRow({ id: 12, fixed_price: 30 }),
    templateRow({ id: 13, fixed_price: 31 }),
  ]);
  check(
    "The same refusal applies at template level",
    problem(ambiguousTemplate)?.code === "WHOLESALE_PRICE_AMBIGUOUS",
    JSON.stringify(ambiguousTemplate)
  );

  const oneExpired = match([
    row({ id: 14, fixed_price: 25, date_end: day(-1) }),
    row({ id: 15, fixed_price: 26 }),
  ]);
  check(
    "But a row whose window has closed is not a candidate, so one live row is not ambiguous",
    priced(oneExpired)?.wholesale === 26 && priced(oneExpired)?.itemId === 15,
    JSON.stringify(oneExpired)
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nC. Rules MoonVella cannot turn into a price");
  /* ------------------------------------------------------------------------ */

  const percentage = match([row({ id: 20, compute_price: "percentage", percent_price: 10, fixed_price: false })]);
  check(
    "A percentage rule is refused, and says so",
    problem(percentage)?.code === "WHOLESALE_PRICE_UNSUPPORTED_RULE" &&
      /percentage/.test(problem(percentage)?.message ?? ""),
    (problem(percentage)?.message ?? "").slice(0, 90)
  );

  const formula = match([row({ id: 21, compute_price: "formula", fixed_price: false })]);
  check(
    "A formula rule is refused",
    problem(formula)?.code === "WHOLESALE_PRICE_UNSUPPORTED_RULE" &&
      /formula/.test(problem(formula)?.message ?? ""),
    (problem(formula)?.message ?? "").slice(0, 90)
  );

  const surcharge = match([row({ id: 22, fixed_price: 25, price_surcharge: 2 })]);
  check(
    "A fixed price with a surcharge is refused rather than approximated",
    problem(surcharge)?.code === "WHOLESALE_PRICE_UNSUPPORTED_RULE" &&
      /surcharge/.test(problem(surcharge)?.message ?? ""),
    (problem(surcharge)?.message ?? "").slice(0, 90)
  );

  /*
   * The row that matters most here. A percentage rule at variant level is a
   * rule Odoo applies and MoonVella cannot compute. If it were treated as "not
   * applicable" the template's fixed price below would be charged instead — a
   * number MoonVella would bill while Odoo's own order line, which does
   * understand the percentage, said something else.
   */
  const shadowed = match([
    row({ id: 23, compute_price: "percentage", percent_price: 10, fixed_price: false }),
    templateRow({ id: 24, fixed_price: 30 }),
  ]);
  check(
    "An unsupported variant rule blocks; it does not fall through to the template's price",
    problem(shadowed)?.code === "WHOLESALE_PRICE_UNSUPPORTED_RULE" && priced(shadowed) === null,
    JSON.stringify(shadowed)
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nD. Quantity");
  /* ------------------------------------------------------------------------ */

  const tierOnly = match([row({ id: 30, fixed_price: 20, min_quantity: 6 })]);
  check(
    "A bulk tier is not the price of one unit: the variant is refused",
    problem(tierOnly)?.code === "WHOLESALE_PRICE_TIER_ONLY",
    JSON.stringify(tierOnly)
  );
  check(
    "And the refusal names the quantity the tier starts at",
    (problem(tierOnly)?.message ?? "").includes("6"),
    (problem(tierOnly)?.message ?? "").slice(0, 90)
  );

  const withTier = match([row({ id: 31, fixed_price: 25 }), row({ id: 32, fixed_price: 20, min_quantity: 6 })]);
  check(
    "A quantity-1 price alongside a tier is charged at quantity 1",
    priced(withTier)?.wholesale === 25 && priced(withTier)?.itemId === 31,
    JSON.stringify(withTier)
  );
  check(
    "And the seller is told, in the import preview, that the discount was not applied",
    /Quantity discounts are not supported yet/.test(priced(withTier)?.note ?? "") &&
      (priced(withTier)?.note ?? "").includes("6"),
    (priced(withTier)?.note ?? "no note").slice(0, 110)
  );

  const tierGone = match([row({ id: 33, fixed_price: 25 }), row({ id: 34, min_quantity: 6, date_end: day(-1) })]);
  check(
    "A tier outside its own window is not mentioned, because it is not on offer",
    priced(tierGone)?.note === null,
    priced(tierGone)?.note ?? "null"
  );

  const minimumAsString = match([row({ id: 35, min_quantity: "6" })]);
  check(
    "A minimum Odoo sends as a string is read as the number it is",
    problem(minimumAsString)?.code === "WHOLESALE_PRICE_TIER_ONLY",
    JSON.stringify(minimumAsString)
  );

  const noMinimum = match([row({ id: 36, min_quantity: false })]);
  check(
    "A row with no minimum is a quantity-1 price, which is Odoo's own default",
    priced(noMinimum)?.wholesale === 25,
    JSON.stringify(noMinimum)
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nE. Dates");
  /* ------------------------------------------------------------------------ */

  const future = match([row({ id: 40, date_start: day(1) })]);
  check(
    "A rule that starts tomorrow prices nothing today",
    problem(future)?.code === "WHOLESALE_PRICE_NOT_YET_VALID" &&
      (problem(future)?.message ?? "").includes(day(1)),
    JSON.stringify(future)
  );

  const expired = match([row({ id: 41, date_start: day(-30), date_end: day(-1) })]);
  check(
    "A rule that ended yesterday prices nothing today",
    problem(expired)?.code === "WHOLESALE_PRICE_EXPIRED" &&
      (problem(expired)?.message ?? "").includes(day(-1)),
    JSON.stringify(expired)
  );

  const startsToday = match([row({ id: 42, date_start: TODAY })]);
  const endsToday = match([row({ id: 43, date_end: TODAY })]);
  check(
    "The window is inclusive at both ends: a rule starting today, and one ending today, both apply",
    priced(startsToday)?.wholesale === 25 && priced(endsToday)?.wholesale === 25,
    `${JSON.stringify(startsToday)} / ${JSON.stringify(endsToday)}`
  );

  const openEnded = match([row({ id: 44, date_start: day(-400), date_end: false })]);
  check(
    "A rule with no end date is in force, however long ago it started",
    priced(openEnded)?.wholesale === 25,
    JSON.stringify(openEnded)
  );

  /*
   * An expired variant row is not a candidate, so it must not shadow the
   * template the way an unsupported one does. This is the difference between
   * "this rule does not apply today" and "this rule applies and I cannot
   * compute it".
   */
  const expiredVariant = match([row({ id: 45, fixed_price: 40, date_end: day(-1) }), templateRow({ id: 46, fixed_price: 30 })]);
  check(
    "An expired variant row steps aside for the template's live price",
    priced(expiredVariant)?.wholesale === 30 && priced(expiredVariant)?.level === "template",
    JSON.stringify(expiredVariant)
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nF. Zero, and nothing at all");
  /* ------------------------------------------------------------------------ */

  const zero = match([row({ id: 50, fixed_price: 0 })]);
  check(
    "A price of zero is refused: it is a pricelist nobody finished, not a free product",
    problem(zero)?.code === "WHOLESALE_PRICE_NOT_POSITIVE",
    JSON.stringify(zero)
  );

  const negative = match([row({ id: 51, fixed_price: -5 })]);
  check(
    "And so is a negative one",
    problem(negative)?.code === "WHOLESALE_PRICE_NOT_POSITIVE",
    JSON.stringify(negative)
  );

  const empty = match([]);
  check(
    "A pricelist with no row for the variant or its template is missing, not zero",
    problem(empty)?.code === "WHOLESALE_PRICE_MISSING" &&
      /no row for this variant/.test(problem(empty)?.message ?? ""),
    (problem(empty)?.message ?? "").slice(0, 90)
  );

  const noFixed = match([row({ id: 52, fixed_price: false })]);
  check(
    "A fixed rule with no price on it is refused rather than read as zero",
    problem(noFixed)?.code === "WHOLESALE_PRICE_NOT_POSITIVE",
    JSON.stringify(noFixed)
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nG. Which problem is reported first");
  /* ------------------------------------------------------------------------ */

  const unsupportedAndExpired = match([
    row({ id: 60, compute_price: "percentage", percent_price: 5, fixed_price: false }),
    row({ id: 61, fixed_price: 25, date_end: day(-1) }),
  ]);
  check(
    "An unsupported rule is named before a date problem: correcting the dates would not make it billable",
    problem(unsupportedAndExpired)?.code === "WHOLESALE_PRICE_UNSUPPORTED_RULE",
    problem(unsupportedAndExpired)?.code ?? "none"
  );

  const tierAndExpired = match([row({ id: 62, min_quantity: 6 }), row({ id: 63, date_end: day(-1) })]);
  check(
    "A quantity tier is named before an expired window",
    problem(tierAndExpired)?.code === "WHOLESALE_PRICE_TIER_ONLY",
    problem(tierAndExpired)?.code ?? "none"
  );

  const futureAndExpired = match([row({ id: 64, date_start: day(10) }), row({ id: 65, date_end: day(-10) })]);
  check(
    "A rule that has not started is named before one that has ended",
    problem(futureAndExpired)?.code === "WHOLESALE_PRICE_NOT_YET_VALID",
    problem(futureAndExpired)?.code ?? "none"
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nH. Reading what Odoo sends");
  /* ------------------------------------------------------------------------ */

  const absent = normalizePricelistItem({
    id: 70,
    applied_on: VARIANT_LEVEL,
    product_id: false,
    product_tmpl_id: false,
    min_quantity: false,
    date_start: false,
    date_end: "",
    compute_price: false,
    fixed_price: false,
    price_surcharge: false,
  });
  check(
    "Odoo's `false`, an empty string and a missing field are all read as absent",
    absent.productVariantId === null &&
      absent.productTemplateId === null &&
      absent.dateStart === null &&
      absent.dateEnd === null &&
      absent.fixedPrice === null &&
      absent.priceSurcharge === 0,
    JSON.stringify(absent)
  );
  check(
    "A missing rule type is a fixed price, which is Odoo's own default",
    absent.computePrice === "fixed" && absent.minQuantity === 1,
    `${absent.computePrice} @ ${absent.minQuantity}`
  );

  const many2one = normalizePricelistItem(row({ id: 71 }));
  check(
    "A many2one arrives as [id, label] and the id is what is matched on",
    many2one.productVariantId === VARIANT && many2one.productTemplateId === null,
    `${many2one.productVariantId}`
  );

  const asString = normalizePricelistItem(row({ id: 72, fixed_price: "25.50" }));
  check(
    "A price Odoo sends as a string is read as the number it is",
    asString.fixedPrice === 25.5,
    String(asString.fixedPrice)
  );

  const oddDate = normalizePricelistItem(row({ id: 73, date_start: "not a date" }));
  check(
    "A date that is not a date is dropped rather than compared as text",
    oddDate.dateStart === null,
    String(oddDate.dateStart)
  );

  const today = todayIso(new Date("2026-03-15T23:30:00Z"));
  check(
    "Today is a date, not a timestamp, so a window is never decided by the hour",
    today === "2026-03-15",
    today
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nI. Scope and currency");
  /* ------------------------------------------------------------------------ */

  /*
   * A row that names this variant but never says at what level is read as "All
   * Products" — which is what Odoo means by an unset scope, and is not a price
   * for one variant. Reading it as variant-level instead would apply a global
   * rule to a single variant's price.
   */
  const unscopedRow: OdooPricelistItemRow = {
    id: 74,
    applied_on: false,
    product_id: [VARIANT, "Pillow / White"],
    fixed_price: 15,
  };
  const unscoped = match([unscopedRow]);
  check(
    "A row with no scope is 'All Products', which does not price a variant even when it names one",
    normalizePricelistItem(unscopedRow).appliedOn === "3_global" &&
      problem(unscoped)?.code === "WHOLESALE_PRICE_MISSING",
    `${normalizePricelistItem(unscopedRow).appliedOn} — ${problem(unscoped)?.code ?? "priced"}`
  );

  const anyPrice = match([row({ id: 80, fixed_price: 12.34 })]);
  check(
    "Every resolved price is CAD, and the currency is not taken from the row",
    WHOLESALE_CURRENCY === "CAD" && priced(anyPrice)?.currency === "CAD",
    `${priced(anyPrice)?.currency}`
  );

  check(
    "The pricelist's name is carried into a refusal, so the message says which list to edit",
    (problem(empty)?.message ?? "").includes(PRICELIST),
    (problem(empty)?.message ?? "").slice(0, 80)
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main();
