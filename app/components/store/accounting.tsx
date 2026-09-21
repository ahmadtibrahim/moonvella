import type { CSSProperties } from "react";

/**
 * A store's money and its correspondence — the shape, drawn before the wiring.
 *
 * NONE OF THIS IS READ FROM A LEDGER. MoonVella has no accounting integration;
 * the invoices, payments, balances and messages below are a worked example of
 * the panels the owner asked for, so the layout can be agreed before anything
 * is connected to Odoo. Every panel that is a drawing says so, in the panel —
 * and the one number on this screen that *is* real says that too. A screen that
 * mixed the two silently would be worse than no screen at all, because the
 * first person to trust a sample balance would act on it.
 *
 * The figures are internally consistent on purpose. They are a ledger, not
 * decoration: the balances are derived from the rows beneath them by hand, and
 * the arithmetic is printed so a reader can check it. A layout that only looks
 * right with round numbers falls over the first time a real one arrives.
 *
 * When the integration exists, the shape stays and `SAMPLE_*` goes: each panel
 * takes its rows as a prop from the loader, and nothing else here changes.
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

const cell: CSSProperties = { fontSize: "0.8rem", color: "#334155" };
const head: CSSProperties = { fontSize: "0.68rem", color: MUTED, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" };

const row: CSSProperties = {
  display: "grid",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.45rem 0",
  borderBottom: `1px solid #f1f5f9`,
};

/**
 * Marks a figure or a row as designed rather than measured.
 *
 * It is a chip rather than a footnote because a footnote is read once and a
 * chip is read every time: a number somebody is about to send an email about
 * should say what it is on the line it sits on.
 */
export function SampleChip({ label = "Sample data" }: { label?: string }) {
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
 * The standing explanation, once per page rather than once per panel.
 *
 * It says what is not connected, what that means for the numbers, and what
 * will supply them — because "sample data" alone invites the reading that the
 * figures are placeholder values that are roughly right, when the truth is
 * that there is no ledger behind them at all.
 */
export function AccountingPreviewNotice({ currency }: { currency: string }) {
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
      <strong>Balances, invoices and messages on this page are a design preview.</strong>{" "}
      MoonVella holds no ledger, so nothing here is read from one — the rows below are worked
      examples showing the panels and the states they will need. The invoices, payments and
      correspondence are invented; the figures in {currency} do not describe this store&rsquo;s
      real position and must not be used to make a credit decision. When Odoo accounting is
      connected, these panels are fed from it and this notice goes.
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The ledger the panels are drawn from                                        */
/* -------------------------------------------------------------------------- */

type InvoiceStatus = "PAID" | "PARTIAL" | "UNPAID" | "OVERDUE";

type SampleInvoice = {
  number: string;
  issued: string;
  due: string;
  total: number;
  paid: number;
  status: InvoiceStatus;
};

/**
 * An invoice, and what is left on it.
 *
 * `balance` is derived rather than stored, in the sample as in the real thing:
 * a ledger that keeps a balance column and a payments column is a ledger that
 * eventually disagrees with itself.
 */
const SAMPLE_INVOICES: SampleInvoice[] = [
  { number: "INV-2019", issued: "2026-07-22", due: "2026-08-21", total: 1366.0, paid: 0, status: "OVERDUE" },
  { number: "INV-2041", issued: "2026-08-04", due: "2026-09-03", total: 3240.0, paid: 3240.0, status: "PAID" },
  { number: "INV-2056", issued: "2026-08-14", due: "2026-09-13", total: 1890.5, paid: 900.0, status: "PARTIAL" },
  { number: "INV-2073", issued: "2026-08-28", due: "2026-09-27", total: 2455.9, paid: 0, status: "UNPAID" },
  { number: "INV-2095", issued: "2026-09-08", due: "2026-10-08", total: 1460.0, paid: 1460.0, status: "PAID" },
];

/** Orders supplied but not yet invoiced — the other half of what a store owes. */
const SAMPLE_UNINVOICED = [
  { number: "ORD-5312", date: "2026-09-15", amount: 1180.0 },
  { number: "ORD-5327", date: "2026-09-18", amount: 960.0 },
];

const SAMPLE_PAYMENTS = [
  { date: "2026-08-09", reference: "PAY-3391", method: "E-transfer", amount: 3240.0, appliedTo: "INV-2041 in full" },
  { date: "2026-08-21", reference: "PAY-3468", method: "E-transfer", amount: 900.0, appliedTo: "INV-2056, part payment" },
  { date: "2026-09-08", reference: "PAY-3512", method: "Card", amount: 1460.0, appliedTo: "INV-2095 in full" },
];

const SAMPLE_CREDIT_NOTES = [
  { number: "CN-118", date: "2026-08-26", amount: 320.0, reason: "Two cartons crushed in transit" },
];

type Channel = "EMAIL" | "CALL" | "NOTE" | "SYSTEM";

type SampleMessage = {
  at: string;
  channel: Channel;
  direction: "IN" | "OUT" | "INTERNAL";
  who: string;
  subject: string;
  body: string;
};

const SAMPLE_MESSAGES: SampleMessage[] = [
  {
    at: "2026-09-18 09:12",
    channel: "EMAIL",
    direction: "IN",
    who: "Priya Raman · accounts@mapleandmain.ca",
    subject: "Re: INV-2019 — second reminder",
    body: "Asks for a copy of the packing slip before releasing the balance; says their AP run closes on the 25th.",
  },
  {
    at: "2026-09-16 16:40",
    channel: "NOTE",
    direction: "INTERNAL",
    who: "Credit control",
    subject: "Overdue balance flagged",
    body: "Third reminder due Friday. Hold new shipments on this account if INV-2019 is still unpaid on the 25th.",
  },
  {
    at: "2026-09-11 11:05",
    channel: "EMAIL",
    direction: "OUT",
    who: "to accounts@mapleandmain.ca",
    subject: "INV-2019 is 21 days overdue",
    body: "Second reminder with the invoice and the signed proof of delivery attached.",
  },
  {
    at: "2026-09-03 14:20",
    channel: "CALL",
    direction: "OUT",
    who: "Priya Raman · +1 416 555 0148",
    subject: "Warehouse delivery window",
    body: "Thursday delivery moved to 08:00 to avoid a dock conflict. No change to the order.",
  },
  {
    at: "2026-08-28 10:02",
    channel: "EMAIL",
    direction: "OUT",
    who: "to purchasing@mapleandmain.ca",
    subject: "INV-2073 and September pricing",
    body: "Invoice attached, with the September wholesale list and the new carton dimensions.",
  },
  {
    at: "2026-08-14 09:30",
    channel: "SYSTEM",
    direction: "INTERNAL",
    who: "MoonVella",
    subject: "Store approved",
    body: "Application APP-0042 approved. Store created and the catalogue opened to it.",
  },
];

/* -------------------------------------------------------------------------- */
/* Panels                                                                      */
/* -------------------------------------------------------------------------- */

const money = (amount: number, currency: string) =>
  `${amount.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const balanceOf = (invoice: SampleInvoice) => invoice.total - invoice.paid;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

const STATUS_TONES: Record<InvoiceStatus, { bg: string; fg: string; label: string }> = {
  PAID: { bg: "#d1fae5", fg: "#065f46", label: "Paid" },
  PARTIAL: { bg: "#fef3c7", fg: "#92400e", label: "Part paid" },
  UNPAID: { bg: "#e0e7ff", fg: "#3730a3", label: "Not paid" },
  OVERDUE: { bg: "#fee2e2", fg: "#991b1b", label: "Overdue" },
};

/**
 * The two balances, and the one figure that is real.
 *
 * Sales balance and account balance are different questions and they are drawn
 * differently: the first is what has been invoiced, the second is everything
 * owed including goods supplied before the invoice exists. Showing only one of
 * them is how a store that "owes nothing" still owes money.
 *
 * The arithmetic is printed rather than described. A balance a reader cannot
 * derive is a balance they have to trust, and the point of the panel is that
 * they should not have to.
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
  const outstanding = sum(SAMPLE_INVOICES.map(balanceOf));
  const uninvoiced = sum(SAMPLE_UNINVOICED.map((order) => order.amount));
  const credited = sum(SAMPLE_CREDIT_NOTES.map((note) => note.amount));
  const accountBalance = outstanding + uninvoiced - credited;
  const overdueCount = SAMPLE_INVOICES.filter((invoice) => invoice.status === "OVERDUE").length;

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Balances</h2>
        <SampleChip />
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
            <SampleChip />
          </div>
          <div style={{ fontSize: "1.6rem", fontWeight: 700, color: INK, marginTop: "0.15rem" }}>
            {money(outstanding, currency)}
          </div>
          <div style={{ fontSize: "0.74rem", color: MUTED, marginTop: "0.2rem" }}>
            Invoiced and not yet paid — {SAMPLE_INVOICES.filter((i) => balanceOf(i) > 0).length} invoices
            {overdueCount ? `, ${overdueCount} of them overdue` : ""}.
          </div>
        </div>

        <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: "0.9rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <span style={{ fontSize: "0.72rem", color: MUTED, fontWeight: 600 }}>Account balance</span>
            <SampleChip />
          </div>
          <div style={{ fontSize: "1.6rem", fontWeight: 700, color: INK, marginTop: "0.15rem" }}>
            {money(accountBalance, currency)}
          </div>
          <div style={{ fontSize: "0.74rem", color: MUTED, marginTop: "0.2rem" }}>
            Everything owed today, including goods supplied before they were invoiced.
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

      <div style={{ marginTop: "1rem" }}>
        <div style={{ ...head, marginBottom: "0.35rem" }}>How the account balance is made up</div>
        {[
          ["Invoices outstanding", outstanding, ""],
          ["Orders not yet invoiced", uninvoiced, ""],
          ["Credit notes issued", -credited, ""],
        ].map(([labelText, amount, suffix]) => (
          <div key={String(labelText)} style={{ ...row, gridTemplateColumns: "1fr 140px" }}>
            <span style={cell}>{labelText}</span>
            <span style={{ ...cell, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
              {Number(amount) < 0 ? `(${money(Math.abs(Number(amount)), currency)})` : money(Number(amount), currency)}
              {suffix}
            </span>
          </div>
        ))}
        <div style={{ ...row, gridTemplateColumns: "1fr 140px", borderBottom: "none", borderTop: `2px solid ${INK}`, marginTop: "0.2rem" }}>
          <span style={{ ...cell, fontWeight: 700, color: INK }}>Balance owed</span>
          <span style={{ ...cell, textAlign: "right", fontWeight: 700, color: INK, fontFamily: "ui-monospace, monospace" }}>
            {money(accountBalance, currency)}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Invoices, and the payments that have been applied to them. */
export function LedgerPanel({ currency }: { currency: string }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Invoices &amp; payments</h2>
        <SampleChip />
      </div>
      <p style={note}>
        Every invoice raised against this store, what has been paid against it, and what is left.
        A part-paid invoice is a state of its own: it is not unpaid, and it is not settled, and a
        list that shows only two of the three states sends somebody looking for money that arrived
        weeks ago.
      </p>

      <div style={{ ...row, ...head, gridTemplateColumns: "110px 100px 100px 1fr 1fr 1fr 90px" }}>
        <span>Invoice</span>
        <span>Issued</span>
        <span>Due</span>
        <span style={{ textAlign: "right" }}>Total</span>
        <span style={{ textAlign: "right" }}>Paid</span>
        <span style={{ textAlign: "right" }}>Balance</span>
        <span>Status</span>
      </div>

      {SAMPLE_INVOICES.map((invoice) => {
        const tone = STATUS_TONES[invoice.status];
        const balance = balanceOf(invoice);
        return (
          <div key={invoice.number} style={{ ...row, gridTemplateColumns: "110px 100px 100px 1fr 1fr 1fr 90px" }}>
            <span style={{ ...cell, fontWeight: 600, color: INK, fontFamily: "ui-monospace, monospace" }}>
              {invoice.number}
            </span>
            <span style={{ ...cell, color: MUTED }}>{invoice.issued}</span>
            <span style={{ ...cell, color: invoice.status === "OVERDUE" ? "#991b1b" : MUTED }}>{invoice.due}</span>
            <span style={{ ...cell, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
              {money(invoice.total, currency)}
            </span>
            <span style={{ ...cell, textAlign: "right", fontFamily: "ui-monospace, monospace", color: MUTED }}>
              {invoice.paid ? money(invoice.paid, currency) : "—"}
            </span>
            <span
              style={{
                ...cell,
                textAlign: "right",
                fontFamily: "ui-monospace, monospace",
                fontWeight: balance > 0 ? 700 : 400,
                color: balance > 0 ? INK : FAINT,
              }}
            >
              {balance > 0 ? money(balance, currency) : "—"}
            </span>
            <span>
              <span
                style={{
                  background: tone.bg,
                  color: tone.fg,
                  fontSize: "0.6rem",
                  fontWeight: 700,
                  padding: "0.15rem 0.4rem",
                  borderRadius: 4,
                  whiteSpace: "nowrap",
                }}
              >
                {tone.label}
              </span>
            </span>
          </div>
        );
      })}

      <div style={{ ...row, gridTemplateColumns: "110px 1fr 1fr" }}>
        <span style={{ ...cell, fontWeight: 700, color: INK }}>Total</span>
        <span style={{ ...cell, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
          paid {money(sum(SAMPLE_PAYMENTS.map((p) => p.amount)), currency)}
        </span>
        <span style={{ ...cell, textAlign: "right", fontWeight: 700, color: INK, fontFamily: "ui-monospace, monospace" }}>
          outstanding {money(sum(SAMPLE_INVOICES.map(balanceOf)), currency)}
        </span>
      </div>

      <h3 style={{ ...title, fontSize: "0.85rem", margin: "1.25rem 0 0.35rem" }}>Payments received</h3>
      <div style={{ ...row, ...head, gridTemplateColumns: "100px 110px 1fr 1fr 1fr" }}>
        <span>Date</span>
        <span>Reference</span>
        <span>Method</span>
        <span>Applied to</span>
        <span style={{ textAlign: "right" }}>Amount</span>
      </div>
      {SAMPLE_PAYMENTS.map((payment) => (
        <div key={payment.reference} style={{ ...row, gridTemplateColumns: "100px 110px 1fr 1fr 1fr" }}>
          <span style={{ ...cell, color: MUTED }}>{payment.date}</span>
          <span style={{ ...cell, fontWeight: 600, color: INK, fontFamily: "ui-monospace, monospace" }}>
            {payment.reference}
          </span>
          <span style={cell}>{payment.method}</span>
          <span style={{ ...cell, color: MUTED }}>{payment.appliedTo}</span>
          <span style={{ ...cell, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
            {money(payment.amount, currency)}
          </span>
        </div>
      ))}

      <h3 style={{ ...title, fontSize: "0.85rem", margin: "1.25rem 0 0.35rem" }}>Credit notes</h3>
      {SAMPLE_CREDIT_NOTES.map((note) => (
        <div key={note.number} style={{ ...row, gridTemplateColumns: "110px 100px 1fr 1fr" }}>
          <span style={{ ...cell, fontWeight: 600, color: INK, fontFamily: "ui-monospace, monospace" }}>
            {note.number}
          </span>
          <span style={{ ...cell, color: MUTED }}>{note.date}</span>
          <span style={{ ...cell, color: MUTED }}>{note.reason}</span>
          <span style={{ ...cell, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
            ({money(note.amount, currency)})
          </span>
        </div>
      ))}
    </div>
  );
}

/** Orders supplied but not yet invoiced. */
export function UninvoicedPanel({ currency }: { currency: string }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Awaiting invoice</h2>
        <SampleChip />
      </div>
      <p style={note}>
        Goods that have gone out and have not been billed yet. These are not overdue — nothing has
        been asked for — but they are owed, which is why they sit inside the account balance and
        outside the sales balance.
      </p>
      <div style={{ ...row, ...head, gridTemplateColumns: "1fr 1fr 1fr" }}>
        <span>Order</span>
        <span>Supplied</span>
        <span style={{ textAlign: "right" }}>Amount</span>
      </div>
      {SAMPLE_UNINVOICED.map((order) => (
        <div key={order.number} style={{ ...row, gridTemplateColumns: "1fr 1fr 1fr" }}>
          <span style={{ ...cell, fontWeight: 600, color: INK, fontFamily: "ui-monospace, monospace" }}>
            {order.number}
          </span>
          <span style={{ ...cell, color: MUTED }}>{order.date}</span>
          <span style={{ ...cell, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
            {money(order.amount, currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

const CHANNEL_TONES: Record<Channel, { bg: string; fg: string; label: string }> = {
  EMAIL: { bg: "#dbeafe", fg: "#1e40af", label: "Email" },
  CALL: { bg: "#ede9fe", fg: "#5b21b6", label: "Call" },
  NOTE: { bg: "#fef3c7", fg: "#92400e", label: "Note" },
  SYSTEM: { bg: "#f1f5f9", fg: "#475569", label: "System" },
};

const DIRECTION_LABELS: Record<SampleMessage["direction"], string> = {
  IN: "from the store",
  OUT: "to the store",
  INTERNAL: "internal",
};

/**
 * The whole correspondence with this store, in one place.
 *
 * Emails, calls, internal notes and what the system did, in the order they
 * happened — because the question this panel answers is never "what was the
 * last email", it is "what has passed between us", and the answer is usually
 * spread across a mailbox, somebody's memory and an audit log.
 */
export function CommunicationsPanel() {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <h2 style={{ ...title, marginBottom: 0 }}>Communication record</h2>
        <SampleChip />
      </div>
      <p style={note}>
        Everything that has passed between MoonVella and this store: email in both directions,
        calls, notes written by staff, and the system&rsquo;s own decisions. Nothing is editable
        here — a record that can be quietly rewritten is not a record.
      </p>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {SAMPLE_MESSAGES.map((message) => {
          const tone = CHANNEL_TONES[message.channel];
          return (
            <div
              key={`${message.at}-${message.subject}`}
              style={{ display: "grid", gridTemplateColumns: "120px 76px 1fr", gap: "0.6rem", padding: "0.6rem 0", borderBottom: "1px solid #f1f5f9" }}
            >
              <div style={{ fontSize: "0.74rem", color: FAINT, fontFamily: "ui-monospace, monospace" }}>
                {message.at}
              </div>
              <div>
                <span
                  style={{
                    background: tone.bg,
                    color: tone.fg,
                    fontSize: "0.6rem",
                    fontWeight: 700,
                    padding: "0.15rem 0.4rem",
                    borderRadius: 4,
                  }}
                >
                  {tone.label}
                </span>
              </div>
              <div>
                <div style={{ fontSize: "0.84rem", fontWeight: 600, color: INK }}>{message.subject}</div>
                <div style={{ fontSize: "0.72rem", color: MUTED, marginTop: "0.1rem" }}>
                  {message.who} · {DIRECTION_LABELS[message.direction]}
                </div>
                <div style={{ fontSize: "0.78rem", color: "#334155", marginTop: "0.2rem", lineHeight: 1.5 }}>
                  {message.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>

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

/**
 * Shared with the roster, so the figure in the list and the figure on the
 * store's own page are the same arithmetic rather than two calculations that
 * agree today.
 *
 * It takes the store's id only to keep the call sites honest about which store
 * they are describing — the sample ledger is one store's, and when the
 * integration lands this becomes a query keyed by exactly this argument.
 */
export function sampleBalances(sellerId: string): { sales: number; account: number } {
  void sellerId;
  const sales = sum(SAMPLE_INVOICES.map(balanceOf));
  const account =
    sales + sum(SAMPLE_UNINVOICED.map((order) => order.amount)) - sum(SAMPLE_CREDIT_NOTES.map((n) => n.amount));
  return { sales, account };
}
