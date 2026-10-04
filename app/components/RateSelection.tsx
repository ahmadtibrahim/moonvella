import { useState } from "react";
import { Form } from "react-router";
import { formatDateTime } from "~/utils/dates";

/*
 * RATE CHOOSING — a decision, a confirmation, and nothing bought.
 *
 * The dialog holds the whole batch and every fact a choice is made on: carrier,
 * service, cost, transit estimate, when the rate was quoted, when it stops
 * being usable, and which dock it prices. Picking a row only marks it; the
 * dialog's two endings are Cancel — which unmounts the form, so there is
 * nothing left to post — and Confirm, which records the selection. Buying the
 * label is a different step with its own confirmation screen; nothing on this
 * surface can spend money.
 *
 * Rows that cannot become a booking are not offered: an expired rate, one
 * priced from a dock the parcel does not collect from, or one that predates
 * dock-scoped quoting would each be refused by the booking gate, and the
 * refusal is printed on the row instead of after the click.
 *
 * Shared by the order page and the shipment page so the two screens price the
 * same way: one component means the batch time, the refusals and the
 * confirm-before-record rule cannot drift apart between them.
 */

/** The shape a rate row needs, structurally — each caller passes its loader's
 *  own quote type, which has these fields plus whatever else it carries. */
export interface RateQuoteOption {
  id: string;
  carrier: string;
  serviceName: string;
  totalAmount: number;
  currency: string;
  transitDays: number | null;
  quotedAt: string | Date;
  expiresAt: string | Date | null;
  originLocationId: string | null;
  originLocation: { code: string; name: string } | null;
  selected: boolean;
}

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function RateSelection({
  quotes,
  dockIds,
  now,
  subject = "order",
}: {
  quotes: RateQuoteOption[];
  dockIds: string[];
  now: number;
  /** What the choice is for, so the dialog's wording fits the page it is on. */
  subject?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = quotes.find((q) => q.selected) ?? null;
  const [chosen, setChosen] = useState<string | null>(current?.id ?? null);

  const cheapest = quotes[0] ?? null;
  const fastest =
    quotes.filter((q) => q.transitDays !== null).sort((a, b) => (a.transitDays ?? 0) - (b.transitDays ?? 0))[0] ??
    null;

  const refusal = (q: RateQuoteOption): string | null => {
    if (q.expiresAt != null && new Date(q.expiresAt).getTime() < now) {
      return "This rate has expired — request rates again.";
    }
    if (q.originLocationId == null) {
      return "This rate predates dock-scoped quoting, so it cannot be booked.";
    }
    if (!dockIds.includes(q.originLocationId)) {
      return "This rate was priced from a dock this order does not collect from.";
    }
    return null;
  };

  const chosenQuote = quotes.find((q) => q.id === chosen) ?? null;
  const confirmable = chosenQuote !== null && refusal(chosenQuote) === null;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        <button
          type="button"
          className="mv-button mv-button-dark"
          disabled={quotes.every((q) => refusal(q) !== null)}
          onClick={() => {
            setChosen(current?.id ?? null);
            setOpen(true);
          }}
        >
          Select rate…
        </button>
        {current ? (
          <span className="mv-badge mv-badge-success">
            Selected: {current.carrier} {current.serviceName} · {money(current.totalAmount, current.currency)}
          </span>
        ) : (
          <span className="mv-muted">No rate selected yet — nothing can be booked until one is.</span>
        )}
      </div>

      {open ? (
        <div className="mv-rate-overlay" role="dialog" aria-modal="true" aria-label="Select a carrier rate">
          <div className="mv-rate-dialog">
            <div className="mv-panel-header">
              <div>
                <h2>Select a carrier rate</h2>
                <p>
                  Choose the rate this {subject} will be booked at. Choosing records the choice and buys nothing —
                  the label is purchased on the booking confirmation, which states the full cost before it is
                  submitted.
                </p>
              </div>
            </div>
            <div className="mv-rate-list">
              {quotes.map((q) => {
                const blocked = refusal(q);
                return (
                  <label key={q.id} className={`mv-rate-row${chosen === q.id ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="rate-choice"
                      value={q.id}
                      checked={chosen === q.id}
                      disabled={blocked !== null}
                      onChange={() => setChosen(q.id)}
                    />
                    <span>
                      <strong>
                        {q.carrier} — {q.serviceName}
                        {cheapest?.id === q.id ? " · lowest cost" : ""}
                        {fastest?.id === q.id ? " · fastest (est.)" : ""}
                      </strong>
                      {/*
                        A rate is priced for one dock. Showing which one is
                        what stops an operator choosing the cheapest line for a
                        parcel that leaves from somewhere else.
                      */}
                      <small>
                        {q.originLocation
                          ? `from ${q.originLocation.code} — ${q.originLocation.name}`
                          : "not dock-scoped"}
                        {q.selected ? " · currently selected" : ""}
                      </small>
                    </span>
                    <span>
                      <strong>{money(q.totalAmount, q.currency)}</strong>
                      <small>{q.transitDays === null ? "Transit not stated" : `${q.transitDays} day(s)`}</small>
                    </span>
                    <span>
                      <small>Quoted {formatDateTime(q.quotedAt)}</small>
                      {blocked ? (
                        <small style={{ color: "#b91c1c" }}>{blocked}</small>
                      ) : (
                        /* Nullable because the provider does not always state
                           one. An absent expiry is not an expiry of "now". */
                        <small>{q.expiresAt ? `Expires ${formatDateTime(q.expiresAt)}` : "No stated expiry"}</small>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mv-rate-dialog-footer">
              <button type="button" className="mv-button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              {confirmable && chosenQuote ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="select_quote" />
                  <input type="hidden" name="quoteId" value={chosenQuote.id} />
                  <button type="submit" className="mv-button mv-button-dark">
                    Confirm rate – {money(chosenQuote.totalAmount, chosenQuote.currency)}
                  </button>
                </Form>
              ) : (
                <button type="button" className="mv-button mv-button-dark" disabled>
                  Confirm rate
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
