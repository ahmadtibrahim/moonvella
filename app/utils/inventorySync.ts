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
