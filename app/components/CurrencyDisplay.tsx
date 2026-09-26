import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useFetcher } from "react-router";
import {
  DEFAULT_DISPLAY_CURRENCY,
  DISPLAY_CURRENCY_STORAGE_KEY,
  formatMoney,
  isDisplayCurrency,
  rateCaption,
  type DisplayCurrency,
} from "~/utils/money";

/**
 * THE CURRENCY A SELLER IS READING THE APPLICATION IN.
 *
 * Two currencies, one price. Everything in this application is stored in
 * Canadian dollars and charged in Canadian dollars — see the note in
 * `utils/money` — and the USD view is a conversion for reading, at the rate
 * MoonVella's own books are kept at, labelled with the day that rate was true.
 * Nothing on any screen is a US-dollar price, and the interface never lets one
 * look like one: `formatMoney` prints the currency beside every amount, so a
 * converted figure says USD and a stored figure says CAD even when they appear
 * in the same table.
 *
 * WHY THE PROVIDER OWNS THE CHOICE AND NOT EACH PAGE. A seller who wants to read
 * in US dollars wants that on every screen, not on one screen at a time. The
 * provider sits in the merchant layout, so the choice survives navigation inside
 * the app, and every page under it formats through the same value.
 *
 * WHY THE RATE IS FETCHED HERE RATHER THAN SENT WITH THE PAGE. The rate comes
 * from Odoo, and an outbound call on the page path would mean every page of
 * every seller waits on it — fifteen seconds of seller-visible latency if Odoo
 * is unreachable, for a number most of those pages will not print. So the page
 * sends nothing and this asks for the rate the first time somebody actually
 * asks to see US dollars. Until it arrives the view stays Canadian, which is
 * the honest thing to show when the rate is not known yet.
 *
 * THE CHOICE IS REMEMBERED FOR THE SITTING, in `sessionStorage`, under one key
 * from the money module. Not the URL: an embedded app's address carries the
 * frame parameters that authenticate the document, and a display preference has
 * no business in it. Not the database: it is a reading preference, not a term of
 * trade, and the owner's settings screen should not gain a field for it.
 */

interface CurrencyContextValue {
  /** What the reader asked to see. */
  display: DisplayCurrency;
  setDisplay: (next: DisplayCurrency) => void;
  /** USD per 1 CAD, or null when none has been read yet. */
  usdRate: number | null;
  usdRateAsOf: string | null;
  /** True while the rate for a USD view is on its way. */
  loadingRate: boolean;
  /**
   * True when USD was asked for and cannot be shown — no rate was read, and the
   * page must say so rather than print Canadian numbers under a US label.
   */
  rateUnavailable: boolean;
  /** An amount in the current view. The one way a price is rendered. */
  format: (cents: number | null | undefined) => string;
  /** The rate and its date, to print wherever a converted figure appears. */
  caption: string | null;
}

/**
 * A default that renders Canadian dollars, so a component used outside the
 * provider still prints an honest price rather than crashing or printing a bare
 * `$`. Pages are not expected to be outside it — this is a floor, not a plan.
 */
const FALLBACK: CurrencyContextValue = {
  display: DEFAULT_DISPLAY_CURRENCY,
  setDisplay: () => undefined,
  usdRate: null,
  usdRateAsOf: null,
  loadingRate: false,
  rateUnavailable: false,
  format: (cents) => formatMoney(cents, { display: DEFAULT_DISPLAY_CURRENCY }),
  caption: null,
};

const CurrencyContext = createContext<CurrencyContextValue>(FALLBACK);

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext);
}

interface RateResponse {
  rate: number | null;
  asOf: string | null;
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // Starts Canadian and corrects itself after mount: reading `sessionStorage`
  // during render would produce server markup that disagrees with the client's
  // first render, and React would resolve that by throwing the tree away.
  const [display, setDisplayState] = useState<DisplayCurrency>(DEFAULT_DISPLAY_CURRENCY);
  const [rate, setRate] = useState<RateResponse | null>(null);
  const [loadingRate, setLoadingRate] = useState(false);
  const fetcher = useFetcher<RateResponse>();
  const requested = useRef(false);

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY);
      if (isDisplayCurrency(stored) && stored !== DEFAULT_DISPLAY_CURRENCY) {
        setDisplayState(stored);
      }
    } catch {
      /*
       * `sessionStorage` throws when storage is disabled rather than returning
       * null. A seller whose browser refuses it gets the Canadian view, which is
       * the default and always correct — not an error page over a preference.
       */
    }
  }, []);

  useEffect(() => {
    if (display !== "USD" || rate || requested.current) return;
    requested.current = true;
    setLoadingRate(true);
    fetcher.load("/app/fx");
  }, [display, rate, fetcher]);

  useEffect(() => {
    if (!fetcher.data) return;
    setRate(fetcher.data);
    setLoadingRate(false);
  }, [fetcher.data]);

  const setDisplay = useCallback((next: DisplayCurrency) => {
    setDisplayState(next);
    try {
      window.sessionStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, next);
    } catch {
      /* see the note above */
    }
  }, []);

  const usdRate = rate?.rate ?? null;
  const usdRateAsOf = rate?.asOf ?? null;
  const rateUnavailable = display === "USD" && usdRate === null && !loadingRate;

  const format = useCallback(
    (cents: number | null | undefined) =>
      formatMoney(cents, { display, usdRate: usdRate ?? undefined }),
    [display, usdRate]
  );

  const caption =
    display === "USD" && usdRate !== null ? rateCaption(usdRate, usdRateAsOf) : null;

  return (
    <CurrencyContext.Provider
      value={{
        display,
        setDisplay,
        usdRate,
        usdRateAsOf,
        loadingRate,
        rateUnavailable,
        format,
        caption,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
}

/**
 * The control itself, and the sentence that explains what it is showing.
 *
 * IT IS NOT OFFERED WHEN THERE IS NO RATE. A toggle that switches to US dollars
 * and then prints Canadian ones is worse than no toggle: the seller has been
 * told the numbers changed when they did not. With no rate available the select
 * shows CAD and says why USD is not on offer, which is a fact about the
 * deployment rather than a decision the seller can act on.
 */
export function CurrencyToggle() {
  const { display, setDisplay, loadingRate, rateUnavailable, caption } = useCurrency();

  return (
    <div className="mv-currency-bar">
      <label className="mv-currency-label" htmlFor="mv-display-currency">
        Currency
      </label>
      <select
        id="mv-display-currency"
        className="mv-filter-select"
        value={display}
        onChange={(event) => setDisplay(event.target.value === "USD" ? "USD" : "CAD")}
      >
        <option value="CAD">CAD $</option>
        <option value="USD">USD $</option>
      </select>
      {loadingRate ? (
        <span className="mv-currency-note">Reading the exchange rate…</span>
      ) : rateUnavailable ? (
        <span className="mv-currency-note">
          The US dollar rate is unavailable right now, so amounts are shown in CAD.
        </span>
      ) : caption ? (
        <span className="mv-currency-note">{caption}</span>
      ) : (
        <span className="mv-currency-note">All prices are in Canadian dollars.</span>
      )}
    </div>
  );
}
