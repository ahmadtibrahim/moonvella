import type { CSSProperties, ReactNode } from "react";

/**
 * A store's money and its correspondence — the shape, drawn before the wiring.
 *
 * NOTHING HERE IS READ FROM A LEDGER, AND NOTHING HERE IS INVENTED EITHER.
 * MoonVella holds no ledger and has no accounting integration, so the invoices,
 * payments, credit notes and correspondence panels have no rows to show. They
 * are drawn, and they say so, in the panel.
 *
 * This file used to fill those panels with a worked example: five invoices, a
 * part-payment, a credit note, and a correspondence timeline naming a person,
 * an email address and a phone number. The arithmetic was internally consistent
 * and every panel carried a stamp saying it was sample data, which was the right
 * instinct — but the figures were still on screen, beside a real store's name,
 * in the store's own currency, and the roster printed the same two invented
 * balances on every row. A fabricated balance is indistinguishable from a real
 * one at a glance, and the first person to act on one would be acting on
 * nothing. The honest empty state is worth more than the convincing drawing.
 *
 * What remains is drawn from two sources only:
 *   - the shapes, which are a design the owner asked for and can be agreed now;
 *   - the one figure that is real — this store's order count and wholesale
 *     value, counted from MoonVella's own tables and labelled `Live`.
 *
 * When Odoo accounting is connected, each panel takes its rows as a prop from
 * the loader and the empty state below it is replaced. Nothing else changes.
 */

const INK = "#082a4a";
const MUTED = "#64748b";
const FAINT = "#94a3b8";
const LINE = "#e2e8f0";

const card: CSSProperties = {
  background: "white",
  border: `1px solid ${LINE}`,
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};

const title: CSSProperties = {
  fontSize: "0.95rem",
  fontWeight: 600,
  color: INK,
  marginBottom: "0.25rem",
};

const note: CSSProperties = {
  fontSize: "0.78rem",
  color: MUTED,
  marginBottom: "1rem",
  lineHeight: 1.5,
};

const money = (amount: number, currency: string) =>
  `${amount.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/**
 * Marks a panel that is drawn but not fed.
 *
 * It is a chip rather than a footnote because a footnote is read once and a
 * chip is read every time. It says "Not connected", never "0.00": an empty
 * balance and an absent one are different facts, and only one of them means
 * this store owes nothing.
 */
export function UnconnectedChip({ label = "Not connected" }: { label?: string }) {
  return (
    <span
      style={{
        background: "#f1f5f9",
        color: "#475569",
        border: "1px solid #e2e8f0",
        fontSize: "0.6rem",
        fontWeight: 700,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        padding: "0.1rem 0.35rem",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/** The live counterpart: a figure read from MoonVella's own tables. */
function LiveChip() {
  return (
    <span
      style={{
        background: "#d1fae5",
        color: "#065f46",
        fontSize: "0.6rem",
        fontWeight: 700,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        padding: "0.1rem 0.35rem",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      Live
    </span>
  );
}

/**
 * Where a panel's rows will appear, said plainly.
 *
 * It takes the panel's subject as its text rather than a generic "no data", so
 * the reader learns which integration is missing and what will fill it — and it
 * deliberately renders no figure at all. A dash, a zero or an em-dash in a money
 * column all read as "nothing owed"; an absence reads as "nothing known".
 */
function PanelEmptyState({
  children,
  source,
}: {
  children: ReactNode;
  /** Which system will supply these rows. Named so the gap has an owner. */
  source: string;
}) {
  return (
    <div
      style={{
        background: "#f8fafc",
        border: `1px dashed ${LINE}`,
        borderRadius: 8,
        padding: "1rem",
      }}
    >
      <div style={{ fontSize: "0.82rem", color: "#334155", lineHeight: 1.55 }}>{children}</div>
      <div style={{ fontSize: "0.74rem", color: MUTED, marginTop: "0.45rem" }}>
        Will be read from {source}.
      </div>
    </div>
  );
}

/**
 * The standing explanation, once per page rather than once per panel.
 *
 * It says what is not connected, and what that means for the numbers — which is
 * that there are none. It no longer describes the panels as samples, because
 * there is nothing left to sample: the panels are empty, and this says why.
 */
export function AccountingUnconnectedNotice({ currency }: { currency: string }) {
  return (
    <div
      style={{
        ...card,
        background: "#fffbeb",
        borderColor: "#fde68a",
        color: "#92400e",
        fontSize: "0.82rem",
        lineHeight: 1.55,
        marginBottom: "1.5rem",
      }}
    >
      <strong>No accounting is connected, so no invoices or balances are shown.</strong>{" "}
      MoonVella does not hold a ledger, and Odoo accounting is not connected. Nothing on this
      page is estimated, carried over from a previous system, or filled in with an example — the
      panels below are empty because there is no source behind them yet, and an empty panel is
      the truthful thing to draw. In particular, no figure in {currency} appears here, so nothing
      on this page can be read as a statement of what this store owes. When Odoo accounting is
      connected these panels are fed from it and this notice goes.
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The two balances, and the one figure that is real.
 *
 * Sales balance and account balance are different questions, and they are still
 * drawn as two cards because the distinction is the point of the panel: what has
 * been invoiced, and everything owed including goods supplied before the invoice
 * exists. Neither has a value, because neither has a source. The third card is
 * counted from MoonVella's own records and is labelled Live.
 */
export function BalancesPanel({
  currency,
  liveOrders,
  liveRevenue,
}: {
  currency: string;
  /** Real: the count of orders MoonVella has recorded for this store. */
  liveOrders: number;
  /** Real: their wholesale total, in cents. */
  liveRevenue: number;
}) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Balances</h2>
        <UnconnectedChip />
        <LiveChip />
      </div>
      <p style={note}>
        What this store owes MoonVella, split the way a ledger splits it: what has been invoiced,
        and what has been supplied but not billed yet.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.75rem" }}>
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: "0.9rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ fontSize: "0.72rem", color: MUTED, fontWeight: 600 }}>Sales balance</span>
            <UnconnectedChip />
          </div>
          <div style={{ fontSize: "0.95rem", fontWeight: 600, color: FAINT, marginTop: "0.15rem" }}>
            No ledger connected
          </div>
          <div style={{ fontSize: "0.74rem", color: MUTED, marginTop: "0.2rem" }}>
            Invoiced and not yet paid. No amount is shown, because none has been read.
          </div>
        </div>

        <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: "0.9rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ fontSize: "0.72rem", color: MUTED, fontWeight: 600 }}>Account balance</span>
            <UnconnectedChip />
          </div>
          <div style={{ fontSize: "0.95rem", fontWeight: 600, color: FAINT, marginTop: "0.15rem" }}>
            No ledger connected
          </div>
          <div style={{ fontSize: "0.74rem", color: MUTED, marginTop: "0.2rem" }}>
            Everything owed today, including goods supplied before they were invoiced. No amount is
            shown, because none has been read.
          </div>
        </div>

        <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: "0.9rem", background: "#f8fafc" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ fontSize: "0.72rem", color: MUTED, fontWeight: 600 }}>Recorded in MoonVella</span>
            <LiveChip />
          </div>
          <div style={{ fontSize: "1.6rem", fontWeight: 700, color: INK, marginTop: "0.15rem" }}>
            {liveOrders} order{liveOrders === 1 ? "" : "s"}
          </div>
          <div style={{ fontSize: "0.74rem", color: MUTED, marginTop: "0.2rem" }}>
            {money(liveRevenue / 100, currency)} of wholesale value. This one is real — it is counted
            from MoonVella&rsquo;s own records, not from a ledger.
          </div>
        </div>
      </div>

      <p style={{ ...note, marginTop: "1rem", marginBottom: 0 }}>
        There is deliberately no &ldquo;how the balance is made up&rdquo; breakdown below these
        cards. That breakdown is a reconciliation, and a reconciliation of absent figures would be
        arithmetic performed on nothing.
      </p>
    </div>
  );
}

/** Invoices, and the payments that have been applied to them. */
export function LedgerPanel({ currency }: { currency: string }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Invoices &amp; payments</h2>
        <UnconnectedChip />
      </div>
      <p style={note}>
        Every invoice raised against this store, what has been paid against it, and what is left.
        A part-paid invoice is a state of its own: it is not unpaid, and it is not settled, and a
        list that shows only two of the three states sends somebody looking for money that arrived
        weeks ago.
      </p>

      <PanelEmptyState source="Odoo accounting (account.move — customer invoices)">
        No invoices are recorded against this store, so none are listed. Payments received,
        applications of those payments to invoices, and credit notes are absent for the same
        reason: they are all entries in a ledger, and there is no ledger behind this page. Nothing
        in {currency} is shown here.
      </PanelEmptyState>
    </div>
  );
}

/** Orders supplied but not yet invoiced. */
export function UninvoicedPanel({ currency }: { currency: string }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Awaiting invoice</h2>
        <UnconnectedChip />
      </div>
      <p style={note}>
        Goods that have gone out and have not been billed yet. These are not overdue — nothing has
        been asked for — but they are owed, which is why they sit inside the account balance and
        outside the sales balance.
      </p>

      <PanelEmptyState source="MoonVella orders reconciled against Odoo invoices">
        This store&rsquo;s orders are recorded in MoonVella, but whether an order has been billed
        is a fact about a ledger, and there is no ledger connected — so &ldquo;awaiting
        invoice&rdquo; cannot be answered yet, and no orders are listed. Listing every order as
        uninvoiced would be a guess in the direction of this store owing money, and no total in{" "}
        {currency} would be anything but that guess added up.
      </PanelEmptyState>
    </div>
  );
}

/**
 * The whole correspondence with this store, in one place.
 *
 * Emails, calls, internal notes and what the system did, in the order they
 * happened — because the question this panel answers is never "what was the
 * last email", it is "what has passed between us", and the answer is usually
 * spread across a mailbox, somebody's memory and an audit log.
 *
 * Nothing is listed yet. The record is fed by inbound mail and call logging,
 * neither of which is wired to this page.
 */
export function CommunicationsPanel() {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Communication record</h2>
        <UnconnectedChip />
      </div>
      <p style={note}>
        Everything that has passed between MoonVella and this store: email in both directions,
        calls, notes written by staff, and the system&rsquo;s own decisions. Nothing is editable
        here — a record that can be quietly rewritten is not a record.
      </p>

      <PanelEmptyState source="MoonVella&rsquo;s own audit log, inbound mail and call records">
        No correspondence is listed. This panel is fed by the audit log, the inbound mailbox and
        the call record, and none of the three is wired to it yet.
      </PanelEmptyState>

      <div style={{ marginTop: "1rem", background: "#f8fafc", border: `1px dashed ${LINE}`, borderRadius: 8, padding: "0.85rem" }}>
        <div style={{ fontSize: "0.78rem", fontWeight: 600, color: INK, marginBottom: "0.2rem" }}>
          Log a note against this store
        </div>
        <p style={{ fontSize: "0.75rem", color: MUTED, margin: "0 0 0.5rem", lineHeight: 1.5 }}>
          Drawn, not yet wired. When the record is live, a note written here is appended to the
          timeline above with the author&rsquo;s name and the time, and cannot be edited afterwards.
        </p>
        <textarea
          disabled
          rows={2}
          placeholder="Not connected yet — this box will save to the store's record."
          style={{
            width: "100%",
            padding: "0.5rem",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            fontSize: "0.82rem",
            fontFamily: "inherit",
            boxSizing: "border-box",
            background: "#f1f5f9",
            color: MUTED,
            resize: "vertical",
          }}
        />
        <button
          type="button"
          disabled
          style={{
            marginTop: "0.5rem",
            padding: "0.45rem 0.9rem",
            border: `1px solid ${FAINT}`,
            borderRadius: 6,
            background: "white",
            color: FAINT,
            fontSize: "0.75rem",
            fontWeight: 600,
            cursor: "not-allowed",
          }}
          title="The communication record is not connected yet."
        >
          Save note
        </button>
      </div>
    </div>
  );
}

/** A one-line balance for the roster, so the list answers the first question. */
export function MiniBalance({
  label,
  amount,
  currency,
}: {
  label: string;
  amount: number;
  currency: string;
}) {
  return (
    <div>
      <div style={{ fontSize: "0.62rem", color: MUTED }}>{label}</div>
      <div style={{ fontSize: "0.82rem", fontWeight: 600, color: INK, fontFamily: "ui-monospace, monospace" }}>
        {money(amount, currency)}
      </div>
    </div>
  );
}
