/**
 * Money, said once.
 *
 * WHAT WAS WRONG WITH `$${(cents / 100).toFixed(2)}`. Every seller-facing page
 * had its own copy of that line — five of them, in five routes — and each
 * printed a bare `$89.99`. MoonVella prices in Canadian dollars, and the seller
 * reading that page may be pricing for a Canadian store, a US one, or both. A
 * bare `$` on a wholesale figure is the kind of ambiguity that gets a product
 * listed at a third off, and no page said which dollar it meant because no page
 * had anywhere to say it.
 *
 * So an amount now carries its currency wherever it is printed: `$89.99 CAD`.
 * One function, one shape, and the currency is not optional — a caller has to
 * say what it is formatting.
 *
 * THE USD VIEW IS A DISPLAY, NOT A SECOND PRICE. Nothing is stored in USD and
 * nothing is converted on the way in: `ProductVariant.suggestedRetailPrice`,
 * `ProductVariant.wholesalePrice` and `SellerVariantPrice.retailPrice` are all
 * cents, in CAD, and the seller's store is listed in CAD. The toggle multiplies
 * for reading only, at a rate the caller supplies and the page labels with its
 * date — a converted figure shown without the date and the rate it came from is
 * a number pretending to be a price. The base currency is spelled out as a
 * constant rather than inferred, so "everything is CAD" stays true in one place.
 *
 * WHICH IS ALSO WHY NO FORM TAKES A USD AMOUNT. `RetailPriceField` is the one
 * place a price is typed, and its label names the currency the number is in
 * whatever the reader has chosen to look at: a field that accepted a converted
 * figure would store it as the base one and list the product at the wrong price
 * with nothing on screen to say so. Reading converts; writing does not.
 */

/** The currency every amount in this application is stored in. */
export const BASE_CURRENCY = "CAD" as const;

/** The only other currency the interface will render, and only for reading. */
export const DISPLAY_CURRENCIES = ["CAD", "USD"] as const;

export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = "CAD";

/**
 * Where the seller's choice is kept between pages.
 *
 * `sessionStorage` rather than the URL: the embedded app's address carries the
 * frame parameters (`shop`, `host`, `id_token`) that authenticate the document,
 * and rewriting the query string to hold a display setting is how one of those
 * gets dropped. Session scope, because the choice is about this sitting, and a
 * seller who opens the app tomorrow should get the Canadian figures again
 * rather than wonder why every price moved.
 */
export const DISPLAY_CURRENCY_STORAGE_KEY = "moonvella.displayCurrency";

export function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return typeof value === "string" && (DISPLAY_CURRENCIES as readonly string[]).includes(value);
}

export interface MoneyFormat {
  /** The currency the cents are stored in. Only CAD exists today. */
  currency?: typeof BASE_CURRENCY;
  /** What the reader asked to see. */
  display?: DisplayCurrency;
  /** USD per 1 CAD. Required for a USD display; without it CAD is shown. */
  usdRate?: number | null;
}

/**
 * An amount, its currency, and — when the reader asked for USD — the rate that
 * converted it.
 *
 * A rate that is missing, zero, negative or not a number is treated as "no USD
 * rate", and the amount is printed in CAD. Falling back to the unconverted
 * figure would be the worst of the options: it would print a Canadian number
 * under a US label, and the reader has no way to see that happened.
 */
export function formatMoney(cents: number | null | undefined, format: MoneyFormat = {}): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";

  const wantsUsd = format.display === "USD" && isUsableRate(format.usdRate);

  if (!wantsUsd) {
    return `${(cents / 100).toFixed(2)} ${BASE_CURRENCY}`;
  }

  const converted = Math.round(cents * (format.usdRate as number));
  return `${(converted / 100).toFixed(2)} USD`;
}

/**
 * A bare number with no currency, for the places a code has to emit one: the
 * value of a `<input type="number">`, which rejects a currency suffix.
 *
 * Kept separate from `formatMoney` rather than offered as an option to it, so
 * that a field which silently drops the currency is a deliberate call at the
 * call site and not something a formatter was asked to do.
 */
export function amountForInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}

function isUsableRate(rate: number | null | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/**
 * The line under a converted figure: what the rate was and when it was true.
 *
 * Printed wherever a USD amount appears, because a converted price without it
 * is indistinguishable from a price somebody typed.
 */
export function rateCaption(usdRate: number, asOf: string | null): string {
  const when = asOf ? ` as of ${asOf}` : "";
  return `USD shown at 1 CAD = ${usdRate.toFixed(4)} USD${when}. Prices are stored and charged in CAD.`;
}
