import { useFetcher } from "react-router";
import { amountForInput, formatMoney } from "~/utils/money";

/**
 * THE SELLER'S PRICE FOR ONE VARIANT, EDITABLE IN PLACE.
 *
 * WHAT THIS FIELD IS. Suggested Retail is the price the seller's own customers
 * pay — the figure their Shopify listing shows. It arrives pre-filled from
 * MoonVella's recommendation and the seller may change it to anything they like,
 * per variant, because a King and a Standard are not the same product to a
 * shopper. Saving it here writes `SellerVariantPrice`, which the catalogue card,
 * My Products and the next import all read.
 *
 * THE FIELD IS IN CANADIAN DOLLARS, ALWAYS, EVEN IN THE USD VIEW. This is the
 * one place in the application where a number is typed rather than read, and a
 * number typed into a converted field would be stored as the currency it is
 * not: a seller reading in US dollars who typed 149 would list the product at
 * $149 CAD — 49% more than they meant — and nothing on the screen would have
 * said so. So the label names the currency the number is in, and a reader in
 * the US view gets the converted figure beside it as a sentence rather than in
 * the box. Reading converts; writing does not.
 *
 * EACH FIELD OWNS ITS FETCHER, which is why this is a component and not a
 * markup fragment: a product has one field per variant, and a page with six
 * price boxes sharing one fetcher would show six spinners and six results for
 * whichever submission finished last.
 *
 * A REFUSAL IS SHOWN HERE, not swallowed. The service refuses a zero, a
 * negative, a fraction and an implausible amount, and says why; that sentence
 * belongs under the field that produced it.
 */
export interface RetailPriceFieldProps {
  variantId: string;
  /** The seller's current price for this variant, in cents CAD. */
  amount: number;
  /** MoonVella's recommended price, in cents CAD, for the placeholder. */
  suggested: number;
  hasOverride: boolean;
  /** True when neither the catalogue nor the seller has a usable price. */
  needsRetailPrice: boolean;
  /** The live USD rate, when the reader is in the US view. */
  usdRate?: number | null;
  /** Reads as USD, so the converted figure can be shown beside a CAD input. */
  displayUsd?: boolean;
  disabled?: boolean;
}

interface PriceActionResult {
  ok?: boolean;
  error?: string;
  retailPrice?: number;
}

export default function RetailPriceField({
  variantId,
  amount,
  suggested,
  hasOverride,
  needsRetailPrice,
  usdRate = null,
  displayUsd = false,
  disabled = false,
}: RetailPriceFieldProps) {
  const fetcher = useFetcher<PriceActionResult>();
  const busy = fetcher.state !== "idle";
  const error = fetcher.data?.ok === false ? fetcher.data.error : null;

  const converted =
    displayUsd && typeof usdRate === "number" && usdRate > 0
      ? formatMoney(amount, { display: "USD", usdRate })
      : null;

  return (
    <div className="mv-price-field">
      <fetcher.Form method="post" className="mv-price-form">
        <input type="hidden" name="intent" value="set-retail" />
        <input type="hidden" name="variantId" value={variantId} />
        <label className="mv-price-label" htmlFor={`retail-${variantId}`}>
          Suggested Retail (CAD $)
        </label>
        <div className="mv-price-input-row">
          <input
            id={`retail-${variantId}`}
            // Re-keyed on the server's figure so a saved price replaces what is
            // in the box, while typing in an unsaved box is never disturbed.
            key={amount}
            className={`mv-price-input${needsRetailPrice ? " mv-price-input-missing" : ""}`}
            type="number"
            name="amount"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            defaultValue={amount > 0 ? amountForInput(amount) : ""}
            placeholder={suggested > 0 ? amountForInput(suggested) : "0.00"}
            disabled={disabled || busy}
            aria-label="Suggested retail price in Canadian dollars"
          />
          <button
            type="submit"
            className="mv-price-save"
            disabled={disabled || busy}
          >
            {busy && fetcher.formData?.get("intent") === "set-retail" ? "Saving…" : "Save"}
          </button>
        </div>
      </fetcher.Form>

      <div className="mv-price-meta">
        {converted ? <span className="mv-price-converted">≈ {converted}</span> : null}
        {hasOverride ? (
          <fetcher.Form method="post" className="mv-price-reset-form">
            <input type="hidden" name="intent" value="reset-retail" />
            <input type="hidden" name="variantId" value={variantId} />
            <button type="submit" className="mv-price-reset" disabled={disabled || busy}>
              {busy && fetcher.formData?.get("intent") === "reset-retail"
                ? "Resetting…"
                : "Use MoonVella's price"}
            </button>
          </fetcher.Form>
        ) : null}
        {needsRetailPrice ? (
          <span className="mv-price-warning">
            Set a price to import this size — a store cannot list a variant at zero.
          </span>
        ) : null}
      </div>

      {error ? <p className="mv-price-error">{error}</p> : null}
    </div>
  );
}
