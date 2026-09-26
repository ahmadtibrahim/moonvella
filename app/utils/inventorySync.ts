/**
 * The words the inventory sync shows a seller, kept where both sides can read
 * them.
 *
 * `app.routes/app.settings` renders the description of the auto-sync switch in
 * the browser, and `services/inventoryPush` uses the reason string when it
 * counts a store as skipped. They import the same constants so the sentence on
 * the Settings screen is the same sentence the behaviour is judged by — a
 * description that drifts from the code is a switch that does not do what it
 * says.
 */

/**
 * What a seller sees on the Settings screen as the consequence of that switch.
 */
export const AUTO_SYNC_OFF_REASON =
  "the store has inventory auto-sync switched off, so its quantities are left alone";

/**
 * The sentence under the auto-sync switch on the Settings screen.
 */
export const AUTO_SYNC_DESCRIPTION =
  "Push catalogue quantities to this store whenever they change here. Leave it off to manage stock levels in Shopify yourself.";

/**
 * The quantity a storefront is told it may sell.
 *
 * IT LIVES HERE FOR THE SAME REASON THE SENTENCES DO: two places push a
 * quantity to a store — the import that creates the listing and the sync that
 * keeps it current — and a buffer applied by one and not the other is a store
 * whose stock jumps by five depending on which one ran last. Neither path owns
 * this rule, so it is here where both read it.
 *
 * THE BUFFER IS THE SELLER'S OWN MARGIN FOR ERROR: a seller who keeps five
 * units back for a trade counter, a damaged return or a mis-count tells their
 * storefront to offer five fewer than the warehouse holds.
 *
 * FLOORED AT ZERO. A buffer larger than the stock on hand is a seller saying
 * "do not sell this yet", and the honest translation is an empty shelf. A
 * negative available quantity is not something Shopify will store, and sending
 * one would turn a deliberate hold into a failed push for the whole product.
 *
 * A MISSING BUFFER IS ZERO, not the schema default of five. The two are
 * different statements: the default is what a seller who has never opened the
 * Settings screen is shown, and it is applied when their settings row is
 * created. Guessing five here would silently hold stock back for a store whose
 * settings nobody has written.
 */
export function bufferedQuantity(
  inventory: number,
  quantityBuffer: number | null | undefined
): number {
  const stock = Number.isFinite(inventory) ? inventory : 0;
  const buffer = Number.isFinite(quantityBuffer) ? Number(quantityBuffer) : 0;
  return Math.max(0, Math.trunc(stock - buffer));
}
