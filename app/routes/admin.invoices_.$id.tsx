/**
 * One invoice, as a document.
 *
 * IT SHOWS WHAT WAS ISSUED, NOT WHAT IS TRUE NOW. The lines, the address and the
 * total come from the snapshot taken at issue. The balance is the one thing
 * computed live, because the balance is a fact about payments received rather
 * than about the document — an invoice does not change when it is paid, but what
 * is owed on it does.
 *
 * NO CHARGE ACTION ON A SETTLED INVOICE, and that is a rule rather than a
 * disabled button: the action itself refuses. A page that hides a control is not
 * a guard, because the form can be posted by hand.
 *
 * EVERYTHING HERE IS AUDITED. Issuing, allocating, crediting and voiding each
 * write an audit row inside their own transaction, so an action that failed
 * leaves no audit row claiming it succeeded — see the services.
 */

import { Link, Form, useLoaderData, useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import {
  invoicePosition,
  issueCreditNote,
  setAllocation,
  voidInvoice,
} from "~/services/invoicing.server";
import { money } from "~/utils/money";
import { formatDate, formatDateTime } from "~/utils/dates";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "finance.view");
  const invoiceId = String(params.id);

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      allocations: {
        orderBy: { allocatedAt: "asc" },
        include: { payment: { select: { id: true, amount: true, status: true, providerPaymentIntentId: true, capturedAt: true } } },
      },
      credits: { orderBy: { issuedAt: "asc" } },
      order: { select: { id: true, shopifyOrderName: true, shopifyOrderNumber: true, fulfillmentStatus: true } },
      seller: { select: { id: true, storeName: true, shopDomainFull: true } },
    },
  });
  if (!invoice) throw new Response("Not found", { status: 404 });

  const position = invoicePosition(invoice, invoice.allocations, invoice.credits);

  /*
   * What the payment could still be applied. The invoice page is where somebody
   * notices a charge that was never allocated — a payment recorded before the
   * invoice existed, or one whose allocation failed — so the control belongs
   * here rather than only in a script.
   */
  const payment = await prisma.wholesalePayment.findUnique({
    where: { orderId: invoice.orderId },
    select: {
      id: true,
      amount: true,
      status: true,
      capturedAt: true,
      // Every allocation this payment has, INCLUDING this invoice's, so the
      // unapplied remainder is the payment minus all of them rather than minus
      // the ones that happen to be on another document.
      allocations: { select: { invoiceId: true, amount: true } },
    },
  });
  const allocatedToThis = payment
    ? payment.allocations
        .filter((row) => row.invoiceId === invoice.id)
        .reduce((sum, row) => sum + row.amount, 0)
    : 0;
  const allocatedAnywhere = payment
    ? payment.allocations.reduce((sum, row) => sum + row.amount, 0)
    : 0;

  const history = await prisma.auditLog.findMany({
    where: { entityType: "Order", entityId: invoice.orderId },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, action: true, actorName: true, actorType: true, createdAt: true, afterData: true },
  });

  return {
    invoice: {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      issuedAt: invoice.issuedAt,
      dueDate: invoice.dueDate,
      voidedAt: invoice.voidedAt,
      voidReason: invoice.voidReason,
      subtotal: invoice.subtotal,
      adjustments: invoice.adjustments,
      taxTotal: invoice.taxTotal,
      total: invoice.total,
      billTo: invoice.billTo,
      shipTo: invoice.shipTo,
    },
    lines: invoice.lines,
    allocations: invoice.allocations.map((row) => ({
      id: row.id,
      amount: row.amount,
      allocatedAt: row.allocatedAt,
      paymentStatus: row.payment.status,
      capturedAt: row.payment.capturedAt,
    })),
    credits: invoice.credits,
    position,
    order: invoice.order,
    seller: invoice.seller,
    payment: payment
      ? {
          id: payment.id,
          amount: payment.amount,
          status: payment.status,
          // What is left of the payment after everything it is already applied
          // to, capped by what this invoice still owes.
          available: Math.max(0, payment.amount - allocatedAnywhere),
          allocatedHere: allocatedToThis,
        }
      : null,
    history: history.map((row) => ({
      id: row.id,
      action: row.action,
      actorName: row.actorName,
      actorType: row.actorType,
      createdAt: row.createdAt,
    })),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "payments.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { id: user.id, name: user.name, ipAddress: ip, userAgent };
  const invoiceId = String(params.id);

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "allocate") {
      const amount = Number(form.get("amount"));
      const paymentId = String(form.get("paymentId") || "");
      if (!paymentId) return { error: "There is no payment recorded for this order to apply." };
      const result = await setAllocation({ paymentId, invoiceId, amount }, actor);
      return {
        ok: `Applied ${money(planAmount(amount), result.invoice.currency)}. Balance is now ${money(
          result.position.balance,
          result.invoice.currency
        )}.`,
      };
    }

    if (intent === "credit") {
      const amount = Number(form.get("amount"));
      const reason = String(form.get("reason") || "");
      const result = await issueCreditNote({ invoiceId, amount, reason }, actor);
      return {
        ok: `Credit ${result.credit.number} issued for ${money(result.credit.amount, result.credit.currency)}.`,
      };
    }

    if (intent === "void") {
      const reason = String(form.get("reason") || "");
      if (!reason.trim()) return { error: "A void needs a reason." };
      const voided = await voidInvoice(invoiceId, reason, actor);
      return { ok: `${voided.number} voided.` };
    }

    return { error: "Unknown action." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That action failed." };
  }
}

/** Kept out of the JSX so the success message and the write agree. */
function planAmount(requested: number): number {
  return Number.isFinite(requested) ? requested : 0;
}

const panel: React.CSSProperties = {
  background: "white",
  border: "1px solid #DCE3EB",
  borderRadius: 12,
  padding: "1.25rem",
  marginBottom: "1.25rem",
};

const label: React.CSSProperties = { display: "block", fontSize: "0.75rem", color: "#52627A", marginBottom: "0.25rem" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  border: "1px solid #DCE3EB",
  borderRadius: 8,
  fontSize: "0.85rem",
  minHeight: 40,
};

export default function AdminInvoiceDetail() {
  const { invoice, lines, allocations, credits, position, order, seller, payment, history } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const billTo = invoice.billTo as {
    company?: string;
    contactName?: string | null;
    contactEmail?: string | null;
    phone?: string | null;
    addressLines?: string[];
    country?: string | null;
  };

  const settled = position.balance <= 0;
  const canAllocate = payment !== null && payment.available > 0 && !settled && invoice.status !== "VOID";

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <p className="mv-muted" style={{ margin: 0 }}>
            <Link to="/admin/invoices">← Orders &amp; invoices</Link>
          </p>
          <h1 style={{ marginBottom: "0.15rem" }}>
            {invoice.number}{" "}
            <span
              className={`mv-badge ${settled ? "mv-badge-success" : position.overdue ? "mv-badge-danger" : "mv-badge-warning"}`}
            >
              {position.status.replace(/_/g, " ")}
            </span>
          </h1>
          <p className="mv-muted" style={{ margin: 0 }}>
            For <Link to={`/admin/orders/${order.id}`}>{order.shopifyOrderName}</Link> ·{" "}
            <Link to={`/admin/customers/${seller.id}`}>{seller.storeName}</Link> · issued{" "}
            {invoice.issuedAt ? formatDate(invoice.issuedAt) : "—"}
            {invoice.dueDate ? ` · due ${formatDate(invoice.dueDate)}` : " · no payment term agreed"}
          </p>
        </div>
        {/*
          A LINK, NOT A FORM. The PDF is served by its own resource route — see
          `admin.invoices_.$id_.pdf.tsx` for why returning it from this page's
          action produced a 500 — so this navigates rather than posting, and the
          browser handles the download.
        */}
        <a className="mv-button mv-button-dark" href={`/admin/invoices/${invoice.id}/pdf`}>
          Download PDF
        </a>
      </div>

      {actionData && "error" in actionData && actionData.error ? (
        <div role="alert" style={{ ...panel, background: "#FEE2E2", borderColor: "#fecaca", color: "#B91C1C" }}>
          {actionData.error}
        </div>
      ) : null}
      {actionData && "ok" in actionData && actionData.ok ? (
        <div role="status" style={{ ...panel, background: "#DCFCE7", borderColor: "#bbf7d0", color: "#166534" }}>
          {actionData.ok}
        </div>
      ) : null}

      {invoice.status === "VOID" ? (
        <div style={{ ...panel, background: "#F1F5F9", color: "#475569" }}>
          This invoice was voided on {invoice.voidedAt ? formatDateTime(invoice.voidedAt) : "—"}
          {invoice.voidReason ? `: ${invoice.voidReason}` : "."} It is kept with its number so the
          sequence has no gap and the withdrawal is on the record.
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(300px, 1fr)", gap: "1.25rem", alignItems: "start" }}>
        <div>
          <section style={panel}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Lines as issued</h2>
            <div className="mv-table-wrap">
              <table className="mv-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th>SKU</th>
                    <th style={{ textAlign: "right" }}>Qty</th>
                    <th style={{ textAlign: "right" }}>Unit</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.description}</td>
                      <td className="mv-muted mv-mono">{line.sku ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>{line.quantity}</td>
                      <td style={{ textAlign: "right" }}>{money(line.unitAmount, invoice.currency)}</td>
                      <td style={{ textAlign: "right" }}>{money(line.amount, invoice.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: "0.9rem", marginLeft: "auto", width: 320, fontSize: "0.85rem" }}>
              <Row label="Subtotal" value={money(invoice.subtotal, invoice.currency)} />
              {invoice.adjustments !== 0 ? (
                <Row label="Adjustments" value={money(invoice.adjustments, invoice.currency)} />
              ) : null}
              {/* Printed only when there IS tax. A zero row would assert a tax
                  treatment nobody decided — the document reports the transaction. */}
              {invoice.taxTotal !== 0 ? <Row label="Tax" value={money(invoice.taxTotal, invoice.currency)} /> : null}
              <Row label="Total" value={money(invoice.total, invoice.currency)} strong />
              {position.paid ? <Row label="Payments applied" value={`− ${money(position.paid, invoice.currency)}`} /> : null}
              {position.credited ? <Row label="Credits applied" value={`− ${money(position.credited, invoice.currency)}`} /> : null}
              <Row label="Balance due" value={money(position.balance, invoice.currency)} strong />
            </div>
          </section>

          <section style={panel}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Payments applied</h2>
            {allocations.length === 0 ? (
              <p className="mv-muted" style={{ margin: 0 }}>Nothing has been applied to this invoice yet.</p>
            ) : (
              <table className="mv-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th>Provider state</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.allocatedAt)}</td>
                      <td style={{ textAlign: "right" }}>{money(row.amount, invoice.currency)}</td>
                      <td className="mv-muted">{row.paymentStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {credits.length > 0 ? (
            <section style={panel}>
              <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>
                Credit notes
              </h2>
              <p className="mv-muted" style={{ marginTop: 0, fontSize: "0.8rem" }}>
                A credit reduces what is owed. It is not a refund — a refund moves money back to a
                card, and these are tracked separately because they are different amounts to
                different parties.
              </p>
              <table className="mv-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Reason</th>
                    <th>Issued</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {credits.map((credit) => (
                    <tr key={credit.id}>
                      <td className="mv-mono">{credit.number}</td>
                      <td>{credit.reason}</td>
                      <td className="mv-muted">{formatDate(credit.issuedAt)}</td>
                      <td style={{ textAlign: "right" }}>{money(credit.amount, invoice.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <section style={panel}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Audit history</h2>
            {history.length === 0 ? (
              <p className="mv-muted" style={{ margin: 0 }}>Nothing recorded against this order yet.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "#334155" }}>
                {history.map((row) => (
                  <li key={row.id} style={{ marginBottom: "0.2rem" }}>
                    <strong>{row.action}</strong> · {formatDateTime(row.createdAt)} ·{" "}
                    {row.actorName ?? row.actorType}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div>
          <section style={panel}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Billed to</h2>
            <div style={{ fontSize: "0.85rem", color: "#334155", lineHeight: 1.6 }}>
              <div><strong>{billTo.company ?? seller.storeName}</strong></div>
              {billTo.contactName ? <div>{billTo.contactName}</div> : null}
              {(billTo.addressLines ?? []).map((line) => (
                <div key={line}>{line}</div>
              ))}
              {billTo.country ? <div>{billTo.country}</div> : null}
              {billTo.contactEmail ? <div>{billTo.contactEmail}</div> : null}
              {billTo.phone ? <div>{billTo.phone}</div> : null}
            </div>
          </section>

          <section style={panel}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Apply a payment</h2>
            {invoice.status === "VOID" ? (
              <p className="mv-muted" style={{ margin: 0 }}>This invoice is void, so nothing can be applied to it.</p>
            ) : settled ? (
              <p className="mv-muted" style={{ margin: 0 }}>
                This invoice is settled. There is nothing left to apply and no action here that
                would charge anything.
              </p>
            ) : !payment ? (
              <p className="mv-muted" style={{ margin: 0 }}>
                No payment is recorded for this order yet, so there is nothing to allocate.
              </p>
            ) : !canAllocate ? (
              <p className="mv-muted" style={{ margin: 0 }}>
                The payment on this order is already fully applied.
              </p>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="allocate" />
                <input type="hidden" name="paymentId" value={payment.id} />
                <p className="mv-muted" style={{ fontSize: "0.78rem", marginTop: 0 }}>
                  {money(payment.available, invoice.currency)} of this payment is unapplied.
                </p>
                <label style={label} htmlFor="alloc-amount">Amount to apply</label>
                <input
                  id="alloc-amount"
                  style={input}
                  name="amount"
                  type="number"
                  min={1}
                  max={Math.min(payment.available, position.balance)}
                  defaultValue={Math.min(payment.available, position.balance)}
                  required
                />
                <button type="submit" className="mv-button mv-button-dark" style={{ marginTop: "0.5rem" }} disabled={busy}>
                  Apply to invoice
                </button>
              </Form>
            )}
          </section>

          {!settled && invoice.status !== "VOID" ? (
            <section style={panel}>
              <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Credit or void</h2>
              <Form method="post">
                <input type="hidden" name="intent" value="credit" />
                <label style={label} htmlFor="credit-amount">Credit amount (minor units)</label>
                <input id="credit-amount" style={input} name="amount" type="number" min={1} max={position.balance} required />
                <label style={{ ...label, marginTop: "0.4rem" }} htmlFor="credit-reason">Reason</label>
                <input id="credit-reason" style={input} name="reason" required placeholder="Why this credit is owed" />
                <button type="submit" className="mv-button" style={{ marginTop: "0.5rem" }} disabled={busy}>
                  Issue credit note
                </button>
              </Form>
              <hr style={{ margin: "1rem 0", border: 0, borderTop: "1px solid #DCE3EB" }} />
              <Form method="post">
                <input type="hidden" name="intent" value="void" />
                <label style={label} htmlFor="void-reason">Void reason</label>
                <input id="void-reason" style={input} name="reason" placeholder="Why this invoice is withdrawn" />
                <button type="submit" className="mv-button mv-button-danger" style={{ marginTop: "0.5rem" }} disabled={busy}>
                  Void invoice
                </button>
              </Form>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ label: text, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "0.2rem 0",
        fontWeight: strong ? 700 : 400,
        borderTop: strong ? "1px solid #DCE3EB" : undefined,
      }}
    >
      <span style={{ color: strong ? "#172B4D" : "#52627A" }}>{text}</span>
      <span>{value}</span>
    </div>
  );
}
