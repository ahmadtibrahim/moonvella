/**
 * Nothing internal may reach a storefront.
 *
 * `Product.category` is MoonVella's own classification, and one value was
 * "All / MoonVella Consignment Bedding". The Shopify import sent it verbatim as
 * the product TYPE and as a TAG — both customer-visible — so the phrase
 * "MoonVella Consignment", which describes whose stock sits on our shelf,
 * appeared in a merchant's storefront filter and on the product listing.
 *
 * The sanitiser is checked as a FUNCTION rather than by reading the import code,
 * because the failure is about what comes OUT of it, and the import is checked
 * for the one thing a function test cannot see: that it calls the sanitiser and
 * never emits the raw category.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPubliclySafe, publicCategoryLabel } from "../app/utils/publicCategory";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function main() {
  const cases: [string, string][] = [
    ["All / MoonVella Consignment Bedding", "Bedding"],
    ["MoonVella Consignment Bedding", "Bedding"],
    ["Consignment Pillows", "Pillows"],
    ["All / Duvets", "Duvets"],
    ["Mattress Protection", "Mattress Protection"],
    ["Pillows", "Pillows"],
    ["", "Home"],
    ["   ", "Home"],
    ["!!!", "Home"],
  ];

  for (const [input, expected] of cases) {
    const got = publicCategoryLabel(input);
    check(
      `"${input}" → "${expected}"`,
      got === expected,
      got === expected ? "" : `got "${got}"`
    );
  }

  /*
   * The property, over a corpus including labels nobody has typed yet: no
   * sanitiser output may contain the internal vocabulary, whatever the input.
   */
  const corpus = [
    "All / MoonVella Consignment Bedding",
    "CONSIGNMENT bedding",
    "moonvella consignment",
    "Wholesale — MoonVella App — Pillows",
    "Bedding (MoonVella Consignment)",
    "odoo Duvets",
    "Pillows",
    "",
  ];
  check(
    "no sanitised label ever contains an internal marker",
    corpus.every((raw) => isPubliclySafe(publicCategoryLabel(raw))),
    corpus.map((raw) => `${raw || "(blank)"}→${publicCategoryLabel(raw)}`).join(" | ")
  );
  check(
    "the exact prohibited phrase is never produced",
    corpus.every((raw) => !publicCategoryLabel(raw).toLowerCase().includes("moonvella consignment"))
  );
  check(
    "a label that is only internal vocabulary degrades to the fallback",
    publicCategoryLabel("MoonVella Consignment") === "Home",
    publicCategoryLabel("MoonVella Consignment")
  );
  check(
    "the vendor name alone is NOT stripped — MoonVella is the brand on the listing",
    publicCategoryLabel("MoonVella Bedding") === "MoonVella Bedding",
    publicCategoryLabel("MoonVella Bedding")
  );

  /* The wiring: a function test cannot see whether the import uses it. */
  const source = readFileSync(join(process.cwd(), "app/services/shopifyImport.server.ts"), "utf8");
  check(
    "the Shopify import sanitises BOTH the product type and the tag",
    /productType:\s*publicCategoryLabel\(/.test(source) &&
      /tags:\s*\[[^\]]*publicCategoryLabel\(/.test(source)
  );
  /*
   * THE SPECIFIC UNSAFE FORMS, not every occurrence of the identifier. The raw
   * `product.category` still appears — INSIDE the sanitiser call — which the
   * first version of this check flagged. A check that forbids the identifier
   * outright would also forbid the correct code.
   */
  check(
    "and the raw category is never the value sent",
    !/productType:\s*product\.category\b/.test(source) &&
      !/tags:\s*\[\s*"MoonVella"\s*,\s*product\.category\s*\]/.test(source),
    "productType and the category tag both go through the sanitiser"
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
