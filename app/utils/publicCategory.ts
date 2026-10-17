/**
 * The category label that may be shown to a SHOPPER.
 *
 * THE LEAK THIS EXISTS TO STOP. `Product.category` is MoonVella's own
 * classification, and one of its values was
 * `All / MoonVella Consignment Bedding`. The Shopify import sent that string
 * verbatim as the product's `productType` AND as a tag, so the phrase "MoonVella
 * Consignment" — an internal description of who owns the stock on a shelf —
 * appeared on the merchant's storefront in a field shoppers read.
 *
 * Ownership is a fact about our warehouse, not about the product. It belongs in
 * app-owned records (`VariantStockRecord.ownerName`, which is already private),
 * never in a customer-visible field.
 *
 * WHAT THIS DOES, AND WHY IT IS A SANITISER RATHER THAN A MAP. A map of known
 * labels has to be updated every time somebody types a new one, and the
 * failure — a phrase reaching a shop again — is silent and public. Stripping the
 * internal vocabulary instead means a category typed tomorrow cannot leak it.
 *
 * The fallback is deliberately dull. An unrecognisable category becomes "Home"
 * rather than being emitted raw: a blank product type is a merchant annoyance,
 * but a raw internal label on a storefront is a disclosure.
 */

/** Words that describe OUR relationship to the goods, not the goods. */
const INTERNAL_MARKERS = [
  "moonvella consignment",
  "consignment",
  "moonvella app",
  "odoo",
];

/**
 * "All / MoonVella Consignment Bedding" → "Bedding".
 *
 * Strips a leading "All /" grouping, removes each internal marker, and
 * collapses the punctuation that removing them leaves behind.
 */
export function publicCategoryLabel(raw: string | null | undefined): string {
  let label = String(raw ?? "").trim();
  if (!label) return "Home";

  // The catalogue groups by a "All / …" prefix, which is a navigation affordance
  // rather than part of the category's name.
  label = label.replace(/^\s*all\s*\/\s*/i, "");

  for (const marker of INTERNAL_MARKERS) {
    label = label.replace(new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
  }

  label = label
    .replace(/[–—-]+/g, " ")
    .replace(/[^A-Za-z0-9&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!label) return "Home";

  // Title-cased, because this is a label a shopper reads in a filter dropdown and
  // shouting or all-lower is a tell that it came out of a database.
  return label
    .split(" ")
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Whether a label is safe to send to a storefront at all.
 *
 * Exported so a caller can REFUSE rather than silently rewrite when it matters —
 * a test uses it to assert that no sanitised label ever contains the phrase, and
 * the import uses it as a final guard.
 */
export function isPubliclySafe(label: string): boolean {
  const lower = String(label ?? "").toLowerCase();
  return INTERNAL_MARKERS.every((marker) => !lower.includes(marker));
}
