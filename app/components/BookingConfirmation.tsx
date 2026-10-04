import { useState } from "react";
import { Form } from "react-router";
import { formatDateTime } from "~/utils/dates";
import { convertedDisplay } from "~/utils/measurementUnits";

/**
 * THE CONFIRMATION SCREEN — everything that is about to be bought, before it is.
 *
 * A booking spends money and cannot be undone from the page that made it. The
 * person pressing the button is not the person who set up the dock, chose the
 * carrier or typed the customer's address, so this is the one place where all of
 * those facts are on screen together and the answer is a deliberate yes: which
 * environment the call will reach, what it costs, where the parcel is collected,
 * where it is going, what is in it, and what Shopify will and will not be told.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 * It does not guess. Anything it cannot state is stated as unknown — an absent
 * transit estimate says so rather than showing a number nobody supplied, and a
 * shipment with no Shopify fulfillment order says tracking cannot be pushed
 * rather than implying it will be.
 *
 * It does not buy anything by opening, or by closing. The booking form exists
 * only while the panel is open, so Cancel is not a handler that declines to
 * submit — it unmounts the form, and there is nothing left to post. That is the
 * difference between "cancelling creates nothing" being a promise about our code
 * and being a property of the page.
 *
 * The notice choice is an INTENT, not an action: it is stored on the shipment
 * and used as the default when the tracking is actually pushed, which happens
 * when the parcel is handed to the carrier. A booked label is not a collected
 * parcel, and this screen must not present one as the other.
 */

/** Which host a booking would reach. The provider's own three-way answer. */
export type BookingEnvironment = "production" | "test" | "unconfigured";

export interface BookingAddressView {
  name: string;
  lines: string[];
}

export interface BookingParcelView {
  count: number;
  length: number;
  width: number;
  height: number;
  weight: number;
  units: string;
}

export interface BookingConfirmationProps {
  /** Which host the booking reaches — the fact the button's wording turns on. */
  environment: BookingEnvironment;
  /** The provider sentence the rest of the admin uses, verbatim. */
  environmentDetail: string;
  environmentHost: string | null;
  orderName: string;
  carrier: string;
  serviceName: string;
  /** Minor units, as every other amount in this app is stored. */
  totalCharge: number;
  currency: string;
  transitDays: number | null;
  /** When the price was quoted, and when it stops being spendable. */
  quotedAt: string | Date | null;
  expiresAt: string | Date | null;
  shipFrom: BookingAddressView | null;
  shipTo: BookingAddressView | null;
  /**
   * The recipient's phone, as recorded on the address.
   *
   * Stated here because it is a PREREQUISITE the carrier's save step enforces,
   * not a detail: a booking without one is refused after the operator has
   * already decided to buy. Showing it on the confirmation turns a refusal into
   * a fix. Nothing is substituted when it is missing — a placeholder number is
   * worse than no number, because the carrier would accept it.
   */
  shipToPhone: string | null;
  parcels: BookingParcelView[];
  units: { dimensionUnit: string; weightUnit: string };
  quoteId: string;
  /**
   * Whether this order has a fulfillment order to push tracking to. Not the same
   * question as "is the integration connected": an order ingested before the
   * fulfillment-service setup has none, and no amount of retrying will create
   * one here.
   */
  hasFulfillmentOrder: boolean;
  canBook: boolean;
  /** A previous attempt failed and nothing was purchased; this is the retry. */
  retrying: boolean;
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(8, 42, 74, 0.45)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "2rem 1rem",
  overflowY: "auto",
};

const panel: React.CSSProperties = {
  background: "white",
  borderRadius: 12,
  maxWidth: 660,
  width: "100%",
  padding: "1.25rem",
  boxShadow: "0 20px 50px rgba(8, 42, 74, 0.3)",
};

const rowLabel: React.CSSProperties = { fontSize: "0.68rem", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.03em" };
const rowValue: React.CSSProperties = { fontSize: "0.82rem", color: "#0f172a" };

/**
 * The exact amount, in the words the button uses.
 *
 * §3 spells the live button "Buy shipping label – CA$XX.XX", and CA$ is not
 * decoration: an operator looking at a two-currency account has to be able to
 * tell this price from a US one without reading the column it came from.
 */
export function cashLabel(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === "CAD" ? `CA$${amount}` : `${amount} ${currency}`;
}

/**
 * The environment banner, which is the loudest thing in the panel on purpose.
 *
 * The failure this prevents is specific and has happened: a deployment pointed
 * at the account's test host reported itself as "real", because `real` answered
 * a different question (is a credential configured?) than the one the operator
 * was asking (will this spend money?). Both statements were true and only one
 * was useful.
 */
function banner(environment: BookingEnvironment, host: string | null) {
  const where = host ? ` (${host})` : "";
  if (environment === "production") {
    return {
      tone: { background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" },
      headline: "LIVE",
      text: `This booking goes to the production host${where} and buys a real shipping label.`,
    };
  }
  if (environment === "test") {
    return {
      tone: { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e" },
      headline: "TEST",
      text:
        `This booking goes to the account's test host${where}, not the production host. ` +
        "A test booking still creates a real shipment at the provider — it is a call, not a preview.",
    };
  }
  return {
    tone: { background: "#f1f5f9", border: "1px solid #cbd5e1", color: "#334155" },
    headline: "NOT CONFIGURED",
    text: "No provider credentials are configured, so this records a simulated booking. No label is bought and no carrier is called.",
  };
}

function Address({ title, value }: { title: string; value: BookingAddressView | null }) {
  return (
    <div>
      <div style={rowLabel}>{title}</div>
      {value ? (
        <div style={{ ...rowValue, lineHeight: 1.6 }}>
          <div>{value.name}</div>
          {value.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : (
        <div style={{ ...rowValue, color: "#b45309" }}>Not resolved.</div>
      )}
    </div>
  );
}

export function BookingConfirmation(props: BookingConfirmationProps) {
  const [open, setOpen] = useState(false);
  /*
   * LIVE starts on, because on a live store the customer expects the tracking
   * e-mail Shopify sends with a fulfillment and a switch that silently
   * withholds it is the surprise. TEST starts OFF: a test booking is not a real
   * parcel and the customer must never be written to about one.
   */
  const [notify, setNotify] = useState(props.environment === "production");

  const { environment, environmentHost, currency, totalCharge, units } = props;
  const words = banner(environment, environmentHost);

  /*
   * The three words, and what each one is claiming. Only the live one says
   * "buy", because it is the only one where that is true.
   */
  const finalLabel =
    environment === "production"
      ? `Buy shipping label – ${cashLabel(totalCharge, currency)}`
      : environment === "test"
        ? "Book test shipment"
        : "Record simulated booking";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!props.canBook}
        style={{
          padding: "0.4rem 0.75rem",
          border: "1px solid #059669",
          borderRadius: 6,
          background: "white",
          color: "#059669",
          fontSize: "0.72rem",
          fontWeight: 600,
          cursor: props.canBook ? "pointer" : "not-allowed",
          opacity: props.canBook ? 1 : 0.5,
        }}
      >
        {props.retrying ? "Retry booking…" : "Book shipment…"}
      </button>

      {open ? (
        <div style={overlay} role="dialog" aria-modal="true" aria-label="Confirm booking">
          <div style={panel}>
            <div style={{ ...words.tone, borderRadius: 8, padding: "0.6rem 0.75rem", marginBottom: "0.9rem" }}>
              <div style={{ fontSize: "0.95rem", fontWeight: 700, letterSpacing: "0.04em" }}>{words.headline}</div>
              <div style={{ fontSize: "0.75rem", marginTop: "0.15rem" }}>{words.text}</div>
              <div style={{ fontSize: "0.68rem", marginTop: "0.25rem", opacity: 0.85 }}>{props.environmentDetail}</div>
            </div>

            <h2 style={{ fontSize: "1rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.6rem" }}>
              {props.retrying ? "Confirm the retry" : "Confirm this booking"}
            </h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem 1rem", marginBottom: "0.9rem" }}>
              <div>
                <div style={rowLabel}>Order</div>
                <div style={rowValue}>{props.orderName}</div>
              </div>
              <div>
                <div style={rowLabel}>Carrier and service</div>
                <div style={rowValue}>
                  {props.carrier} — {props.serviceName}
                </div>
              </div>
              <div>
                <div style={rowLabel}>Shipping cost</div>
                <div style={{ ...rowValue, fontWeight: 700 }}>{cashLabel(totalCharge, currency)}</div>
              </div>
              <div>
                <div style={rowLabel}>Estimated transit</div>
                <div style={rowValue}>
                  {props.transitDays === null
                    ? "Not stated by the carrier"
                    : `${props.transitDays} day${props.transitDays === 1 ? "" : "s"}`}
                </div>
              </div>
              <div>
                <div style={rowLabel}>Quoted</div>
                <div style={rowValue}>{formatDateTime(props.quotedAt)}</div>
              </div>
              <div>
                <div style={rowLabel}>Quote expires</div>
                <div style={rowValue}>{formatDateTime(props.expiresAt, { fallback: "Not stated" })}</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem 1rem", marginBottom: "0.9rem" }}>
              <Address title="Pickup address" value={props.shipFrom} />
              <div>
                <Address title="Delivery address" value={props.shipTo} />
                {props.shipToPhone ? (
                  <div style={{ ...rowValue, marginTop: "0.2rem" }}>Phone {props.shipToPhone}</div>
                ) : (
                  <div style={{ ...rowValue, marginTop: "0.2rem", color: "#b45309" }}>
                    No phone number on this address. The carrier requires one, so this booking will be refused until it is
                    recorded — nothing is filled in on the customer&apos;s behalf.
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginBottom: "0.9rem" }}>
              <div style={rowLabel}>
                Parcels on this label —{" "}
                {props.parcels.reduce((sum, p) => sum + p.count, 0)} parcel
                {props.parcels.reduce((sum, p) => sum + p.count, 0) === 1 ? "" : "s"}
              </div>
              {props.parcels.length === 0 ? (
                <div style={{ ...rowValue, color: "#b45309" }}>
                  No parcels resolved — this booking has nothing to declare and will be refused.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.2rem" }}>
                  <thead>
                    <tr>
                      {["Count", `Dimensions (${units.dimensionUnit})`, `Weight each (${units.weightUnit})`, "Total weight"].map((h) => (
                        <th key={h} style={{ ...rowLabel, textAlign: "left", padding: "0.2rem 0.3rem" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {props.parcels.map((p, index) => {
                      const lengthUnit = p.units === "in_lb" ? "in" : "cm";
                      const weightUnit = p.units === "in_lb" ? "lb" : "kg";
                      return (
                        <tr key={`${p.length}x${p.width}x${p.height}-${index}`}>
                          <td style={{ ...rowValue, padding: "0.2rem 0.3rem" }}>{p.count}</td>
                          <td style={{ ...rowValue, padding: "0.2rem 0.3rem" }}>
                            {convertedDisplay(p.length, lengthUnit, units.dimensionUnit, "length")} ×{" "}
                            {convertedDisplay(p.width, lengthUnit, units.dimensionUnit, "length")} ×{" "}
                            {convertedDisplay(p.height, lengthUnit, units.dimensionUnit, "length")}
                          </td>
                          <td style={{ ...rowValue, padding: "0.2rem 0.3rem" }}>
                            {convertedDisplay(p.weight, weightUnit, units.weightUnit, "weight")}
                          </td>
                          <td style={{ ...rowValue, padding: "0.2rem 0.3rem" }}>
                            {convertedDisplay(p.weight * p.count, weightUnit, units.weightUnit, "weight")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "0.7rem", marginBottom: "0.9rem" }}>
              <div style={rowLabel}>Shopify</div>
              <div style={{ ...rowValue, lineHeight: 1.6 }}>
                {props.hasFulfillmentOrder ? (
                  <div>
                    Tracking <strong>will</strong> be pushed to Shopify once this parcel is marked as handed to the
                    carrier. Buying the label does not fulfil the order on its own.
                  </div>
                ) : (
                  <div style={{ color: "#b45309" }}>
                    Tracking <strong>cannot</strong> be pushed to Shopify: this order has no fulfillment order to push
                    it to. The label is still bought and the tracking number is still recorded here.
                  </div>
                )}
              </div>
              <label style={{ display: "flex", gap: "0.4rem", alignItems: "flex-start", fontSize: "0.8rem", marginTop: "0.5rem" }}>
                <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} style={{ marginTop: "0.15rem" }} />
                <span>
                  Ask Shopify to notify the customer when the tracking is pushed
                  <span style={{ display: "block", fontSize: "0.7rem", color: "#64748b" }}>
                    {environment === "production"
                      ? "On by default for a live booking. The customer is written to once, when the tracking is pushed — not now."
                      : "Off by default in TEST. A test booking is not a real parcel, so nobody is written to."}
                  </span>
                </span>
              </label>
            </div>

            {/*
              * The answer travels as a VALUE, not as the presence of a tick.
              * An unticked checkbox posts nothing at all, which is
              * indistinguishable from a form that never asked — and on a retry
              * that would silently keep a "yes" the operator had just cleared.
            */}
            <Form method="post" style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", alignItems: "center" }}>
              <input type="hidden" name="intent" value="book_shipment" />
              <input type="hidden" name="quoteId" value={props.quoteId} />
              <input type="hidden" name="notifyCustomer" value={notify ? "on" : "off"} />
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  padding: "0.45rem 0.9rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  background: "white",
                  color: "#334155",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!props.canBook}
                style={{
                  padding: "0.45rem 0.9rem",
                  border: `1px solid ${environment === "production" ? "#dc2626" : "#059669"}`,
                  borderRadius: 6,
                  background: "white",
                  color: environment === "production" ? "#dc2626" : "#059669",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  cursor: props.canBook ? "pointer" : "not-allowed",
                  opacity: props.canBook ? 1 : 0.5,
                }}
              >
                {finalLabel}
              </button>
            </Form>
            <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.5rem", textAlign: "right" }}>
              Cancel closes this without booking anything.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
