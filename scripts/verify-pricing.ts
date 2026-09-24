/**
 * What a seller is charged, on its own.
 *
 * WHAT THIS SUITE IS FOR. The owner's ruling is that Odoo supplies the price: a
 * seller pays each variant's effective sales price — the figure on the variant's
 * own form, which Odoo composes from the template's list price plus that
 * variant's attribute price extras. MoonVella reads that one field and charges
 * it. This suite pins every rule around that figure, and each one is a decision
 * about money:
 *
 *   • The price is the variant's own effective sales price, read as one field
 *     from `product.product`. It is never recomposed here from the template's
 *     list price and the attribute extras, so no second copy of Odoo's
 *     arithmetic can drift from Odoo's.
 *   • There is no fallback. No cost, no retail guess, no zero: a variant whose
 *     price Odoo will not state carries a problem and is left out.
 *   • Zero and negative are refused, because both are a pricelist nobody
 *     finished rather than a free product.
 *   • The currency is CAD and nothing converts between currencies. A company in
 *     another currency is a refusal, not a CAD label on a USD figure.
 *   • Odoo's `false` is read as absent and never as zero — `Number(false) === 0`
 *     is the trap this exists to close.
 *
 * There used to be a wholesale-pricelist matcher here, with quantity tiers,
 * date windows and rule precedence. It is gone, and so are its rules: the price
 * is no longer chosen from a list of candidate rows, so there is no precedence
 * left to get wrong.
 *
 * It reads no database, makes no network call and writes nothing. The functions
 * it calls are the ones the sync itself calls, exported for exactly this reason:
 * a rule whose only test needs a live Odoo is a rule whose test never runs.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-pricing.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  WHOLESALE_CURRENCY,
  billableCurrency,
  chargeablePrice,
  readNumber,
  toCents,
} from "~/services/odooImport.server";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** The decision, as a price or as null when there is none. */
function price(value: unknown): number | null {
  const decision = chargeablePrice(value);
  return decision.ok ? decision.price : null;
}

function problem(value: unknown): string | null {
  const decision = chargeablePrice(value);
  return decision.ok ? null : decision.problem;
}

function main() {
  console.log("pricing suite — the variant's effective sales price\n");

  /* ------------------------------------------------------------------------ */
  console.log("A. Odoo's own figures are charged as they arrive");
  /* ------------------------------------------------------------------------ */

  check("A plain price is charged as it stands", price(39.99) === 39.99, String(price(39.99)));
  check(
    "A price Odoo sends as a string is read as the number it is",
    price("25.50") === 25.5,
    String(price("25.50"))
  );
  check(
    "An integer price is not mangled into a float",
    price(40) === 40,
    String(price(40))
  );
  /*
   * The case the whole design is for: two variants of one template, whose prices
   * differ only by their attribute extras. Odoo computed 39.99 and 44.99 from a
   * 39.99 list price and a +5.00 extra; MoonVella reads both figures and adds
   * nothing itself.
   */
  const base = price(39.99);
  const withExtra = price(44.99);
  check(
    "Two variants of one product are charged their own prices, extras included",
    base === 39.99 && withExtra === 44.99,
    `${base} / ${withExtra}`
  );
  check(
    "A price with more than two decimals is not rounded on the way in",
    price(39.999) === 39.999,
    String(price(39.999))
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nB. Odoo's `false` is absent, never zero");
  /* ------------------------------------------------------------------------ */

  check(
    "`false`, which Odoo uses for an empty field, is not read as a price of zero",
    readNumber(false) === null && price(false) === null,
    String(price(false))
  );
  check(
    "`true` is not read as the number one",
    readNumber(true) === null,
    String(readNumber(true))
  );
  check("An empty string is absent", readNumber("") === null && readNumber("   ") === null);
  check("A missing field is absent", readNumber(undefined) === null && readNumber(null) === null);
  check(
    "A value that is not a number at all is absent, not NaN",
    readNumber("not a price") === null && readNumber({}) === null && readNumber([]) === null,
    String(readNumber("not a price"))
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nC. A price MoonVella will not charge");
  /* ------------------------------------------------------------------------ */

  check(
    "No price at all is a problem, and says what was not done about it",
    /no sales price/.test(problem(undefined) ?? "") &&
      /does not fall back/.test(problem(undefined) ?? ""),
    (problem(undefined) ?? "").slice(0, 80)
  );
  check(
    "A price of zero is refused: that is an unfinished pricelist, not a free product",
    price(0) === null && /cannot be\s+charged/.test(problem(0) ?? ""),
    (problem(0) ?? "").slice(0, 80)
  );
  check("A negative price is refused", price(-5) === null, String(price(-5)));
  check(
    "The refusal quotes the figure Odoo holds, so the product can be found and fixed",
    (problem(0) ?? "").includes("0.00") && (problem(-5) ?? "").includes("-5.00"),
    problem(-5) ?? ""
  );
  check(
    "`false` — Odoo's empty field — is refused rather than charged at zero",
    price(false) === null,
    String(price(false))
  );
  check(
    "A price that is infinite or NaN is refused rather than written",
    price(Infinity) === null && price(NaN) === null,
    `${price(Infinity)} / ${price(NaN)}`
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nD. Currency: CAD, and nothing is converted");
  /* ------------------------------------------------------------------------ */

  const cad = billableCurrency("CAD", "TEST PILLOW");
  check(
    "A CAD company is charged in CAD",
    cad.ok && cad.currency === "CAD" && cad.note === null,
    JSON.stringify(cad)
  );
  check(
    "Every price MoonVella bills is CAD",
    WHOLESALE_CURRENCY === "CAD",
    WHOLESALE_CURRENCY
  );

  const usd = billableCurrency("USD", "TEST PILLOW");
  check(
    "A USD company is a refusal, not a CAD label on a USD figure",
    !usd.ok && usd.blocker.code === "ODOO_PRICE_CURRENCY_NOT_CAD",
    JSON.stringify(usd)
  );
  check(
    "And the refusal names the currency, the product and what to do",
    !usd.ok &&
      usd.blocker.message.includes("USD") &&
      usd.blocker.message.includes("TEST PILLOW") &&
      usd.blocker.remedy.includes("untag"),
    !usd.ok ? usd.blocker.remedy : ""
  );

  const unnamed = billableCurrency(undefined, "TEST PILLOW");
  check(
    "A product shared between companies has no currency of its own: that is a note, not a refusal",
    unnamed.ok && unnamed.currency === "CAD" && /no company currency/i.test(unnamed.note ?? ""),
    JSON.stringify(unnamed)
  );
  check(
    "An empty currency string is read as absent rather than as a currency",
    billableCurrency("", "TEST PILLOW").ok === true &&
      billableCurrency("   ", "TEST PILLOW").ok === true,
    JSON.stringify(billableCurrency("", "TEST PILLOW"))
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nE. From Odoo's decimals to the cents the catalogue stores");
  /* ------------------------------------------------------------------------ */

  check("39.99 is 3999 cents", toCents(39.99) === 3999, String(toCents(39.99)));
  check("44.99 is 4499 cents", toCents(44.99) === 4499, String(toCents(44.99)));
  check("A whole number of dollars is a whole number of cents", toCents(40) === 4000);
  check("A third decimal is rounded, not truncated", toCents(39.999) === 4000, String(toCents(39.999)));
  check(
    "The rounding is the same one the sync writes with, so preview and catalogue agree",
    toCents(19.99) === 1999 && toCents(0.01) === 1 && toCents(0.1) === 10,
    `${toCents(19.99)} / ${toCents(0.01)} / ${toCents(0.1)}`
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nF. The module itself: one price field, and no pricelist");
  /* ------------------------------------------------------------------------ */

  /*
   * The checks above prove the rules; these prove the module has not grown a
   * second way to price a variant beside them. Source-level because the thing
   * being prevented is a line of code, and a line of code is what has to be
   * looked for.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "../app/services/odooImport.server.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  check(
    "The effective sales price is read from the variant, as one field",
    /lst_price:\s*number/.test(source) && /"lst_price"/.test(code),
    "product.product.lst_price"
  );
  check(
    "Odoo's inputs to that figure are never read, so the arithmetic cannot be recomposed here",
    !/\blist_price\b/.test(code) && !/\bprice_extra\b/.test(code),
    "no list_price, no price_extra"
  );
  check(
    "No pricelist is read at all",
    !/product\.pricelist/.test(code) && !/pricelist/i.test(code),
    "no pricelist model"
  );
  check(
    "No wholesale-pricelist blocker survives, in any form",
    !/WHOLESALE_PRICELIST|PRICELIST_MISSING|PRICELIST_AMBIGUOUS|PRICELIST_ITEM/.test(code),
    "no pricelist blocker codes"
  );
  check(
    "The only price written for a variant is the one the rule returned",
    /wholesalePrice:\s*toCents\(wholesale\)/.test(code),
    "wholesalePrice = toCents(chargeable price)"
  );
  /*
   * The retail column is MoonVella's own, and the one place an import touches it
   * is the zero the column needs on create — never a figure derived from Odoo's
   * price. A seller's retail price edited here therefore survives every sync.
   */
  const retailLines = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("suggestedRetailPrice"));
  check(
    "Suggested retail is never derived from the Odoo price, only zeroed where the column needs it",
    retailLines.length > 0 && retailLines.every((line) => /^suggestedRetailPrice: 0,?$/.test(line)),
    retailLines.join(" | ") || "no occurrence"
  );
  check(
    "A cost is recorded beside the price and never charged as one",
    /costPrice: variant\.cost === null \? null : toCents\(variant\.cost\)/.test(code) &&
      !/wholesalePrice:[^\n]*\bcost\b/.test(code),
    "costPrice written to its own column"
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main();
