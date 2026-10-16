/**
 * The cancellation reasons, and their labels.
 *
 * WHY THIS IS NOT IN THE `.server` MODULE BESIDE IT. The order page renders the
 * reasons in a `<select>`, so the table has to be reachable from a component —
 * and a route component that imports a `.server` module fails the BUILD with
 * "Server-only module referenced by client". `tsc` sees nothing wrong with it,
 * so only the build catches it; this is the third time that has happened in this
 * codebase, which is why the rule is written down here rather than only in the
 * commit that fixed it.
 *
 * Nothing here touches the database or a provider. It is a list of words.
 */

export const CANCELLATION_REASONS = [
  { value: "OUT_OF_STOCK", label: "Out of stock" },
  { value: "PRODUCT_UNAVAILABLE", label: "Product unavailable" },
  { value: "SELLER_REQUEST", label: "Seller request" },
  { value: "DUPLICATE_ORDER", label: "Duplicate order" },
  { value: "OTHER", label: "Other" },
] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number]["value"];

export function reasonLabel(reason: string): string {
  return CANCELLATION_REASONS.find((entry) => entry.value === reason)?.label ?? reason;
}
