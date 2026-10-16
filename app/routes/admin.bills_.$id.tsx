/**
 * One supplier bill: what it is, what has been paid, and how to record a payment.
 *
 * THE TWO PAYMENT METHODS ARE THE POINT OF THIS PAGE, and they are drawn as two
 * separate forms rather than one form with a dropdown, because they are two
 * different acts:
 *
 *   "Record an external payment" — the money already moved. A bank transfer, a
 *   cheque, a card the operator holds. This writes a row and nothing else.
 *
 *   "Charge this card" — the money has not moved and should. It is not
 *   implemented, and it REFUSES rather than quietly writing a LOGGED row: there
 *   is no supplier-charging provider configured, and a button that appears to
 *   charge while only recording is precisely the confusion the distinction
 *   exists to prevent.
 *
 * The card form is therefore present and disabled, with the reason, rather than
 * absent. An operator who cannot find it will look for it in the API; one who
 * finds it greyed out with a sentence knows the answer.
 */

import { Link, Form, useLoaderData, useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { billPosition, recordSupplierBillPayment, shipmentBillingReconciliation } from "~/services/bills.server";
import { money } from "~/utils/money";
import { formatDate, formatDateTime } from "~/utils/dates";
import { parseMajorUnits } from "~/utils/money";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "finance.view");
  const billId = String(params.id);

  const bill = await prisma.supplierBill.findUnique({
    where: { id: billId },
    include: {
      payments: { orderBy: { paidAt: "desc" } },
      shipment: { select: { id: true, carrier: true, serviceName: true, trackingNumber: true } },
    },
  });
  if (!bill) throw new Response("Not found", { status: 404 });

  const position = billPosition(bill, bill.payments);

  return {
    bill: {
      id: bill.id,
      supplier: bill.supplier,
      reference: bill.reference,
      category: bill.category,
      currency: bill.currency,
      total: bill.total,
      issuedOn: bill.issuedOn,
      dueDate: bill.dueDate,
      status: bill.status,
      notes: bill.notes,
      shipmentId: bill.shipmentId,
      documentName: bill.documentName,
    },
    shipment: bill.shipment,
    payments: bill.payments.map((row) => ({
      id: row.id,
      amount: row.amount,
      method: row.method,
      reference: row.reference,
      paidAt: row.paidAt,
      note: row.note,
    })),
    position,
    reconciliation: bill.shipmentId ? await shipmentBillingReconciliation(bill.shipmentId) : null,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "payments.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { id: user.id, name: user.name, ipAddress: ip, userAgent };
  const billId = String(params.id);

  const bill = await prisma.supplierBill.findUniqueOrThrow({
    where: { id: billId },
    select: { currency: true },
  });

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "pay") {
      const cents = parseMajorUnits(String(form.get("amount") || ""));
      if (cents === null) return { error: "Enter the amount as a figure like 114.40." };
      const result = await recordSupplierBillPayment(
        {
          billId,
          amount: cents,
          method: "LOGGED",
          reference: String(form.get("reference") || "") || null,
          note: String(form.get("note") || "") || null,
        },
        actor
      );
      return result.duplicate
        ? { ok: "That payment was already recorded — nothing was written twice." }
        : { ok: `Recorded a payment. Balance is now ${money(result.position.balance, bill.currency)}.` };
    }

    if (intent === "charge") {
      // Refused by the service, with the reason. Caught below and shown.
      await recordSupplierBillPayment({ billId, amount: 0, method: "CARD" }, actor);
      return { error: "Unreachable." };
    }

    return { error: "Unknown action." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That action failed." };
  }
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

export default function AdminBillDetail() {
  const { bill, shipment, payments, position, reconciliation } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <p className="mv-muted" style={{ margin: 0 }}>
            <Link to="/admin/bills">← Bills &amp; expenses</Link>
          </p>
          <h1 style={{ marginBottom: "0.15rem" }}>
            {bill.supplier}{" "}
            <span
              className={`mv-badge ${position.status === "PAID" ? "mv-badge-success" : position.overdue ? "mv-badge-danger" : "mv-badge-warning"}`}
            >
              {position.status}
            </span>
          </h1>
          <p className="mv-muted" style={{ margin: 0 }}>
            {bill.category}
            {bill.reference ? ` · their ref ${bill.reference}` : ""} · issued {formatDate(bill.issuedOn)} ·{" "}
            {bill.dueDate ? `due ${formatDate(bill.dueDate)}` : "no term agreed"}
          </p>
        </div>
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

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(300px, 1fr)", gap: "1.25rem", alignItems: "start" }}>
        <div>
          <section style={panel}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Payments recorded</h2>
            {payments.length === 0 ? (
              <p className="mv-muted" style={{ margin: 0 }}>Nothing has been paid against this bill.</p>
            ) : (
              <table className="mv-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Method</th>
                    <th>Reference</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.paidAt)}</td>
                      <td className="mv-muted">{row.method}</td>
                      <td className="mv-muted mv-mono">{row.reference ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>{money(row.amount, bill.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {reconciliation ? (
            <section style={panel}>
              <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>
                Carrier reconciliation
              </h2>
              <p className="mv-muted" style={{ fontSize: "0.8rem", marginTop: 0 }}>
                A variance is MoonVella&apos;s cost, not the seller&apos;s. Nothing here writes back
                to the seller&apos;s charge — the seller was quoted a price and that price is theirs.
              </p>
              <table className="mv-table" style={{ maxWidth: 640 }}>
                <tbody>
                  <tr>
                    <td>Quoted at booking</td>
                    <td style={{ textAlign: "right" }}>
                      {reconciliation.shipment.quotedCarrierCost != null
                        ? money(reconciliation.shipment.quotedCarrierCost, bill.currency)
                        : "—"}
                    </td>
                  </tr>
                  <tr>
                    <td>Booked</td>
                    <td style={{ textAlign: "right" }}>
                      {reconciliation.shipment.bookedCost != null
                        ? money(reconciliation.shipment.bookedCost, bill.currency)
                        : "—"}
                    </td>
                  </tr>
                  <tr>
                    <td>Billed by the carrier</td>
                    <td style={{ textAlign: "right" }}>{money(reconciliation.billed, bill.currency)}</td>
                  </tr>
                  <tr>
                    <td><strong>Variance against booked</strong></td>
                    <td
                      style={{
                        textAlign: "right",
                        fontWeight: 700,
                        color: reconciliation.variance && reconciliation.variance < 0 ? "#B91C1C" : "#166534",
                      }}
                    >
                      {reconciliation.variance === null ? "—" : money(reconciliation.variance, bill.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {shipment ? (
                <p style={{ fontSize: "0.8rem", marginBottom: 0 }}>
                  <Link to={`/admin/shipping/${shipment.id}`}>
                    {shipment.carrier ?? "Shipment"} {shipment.serviceName ?? ""} · {shipment.trackingNumber ?? "no tracking"}
                  </Link>
                </p>
              ) : null}
            </section>
          ) : null}
        </div>

        <div>
          <section style={panel}>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Summary</h2>
            <div style={{ fontSize: "0.85rem" }}>
              <Row label="Total" value={money(bill.total, bill.currency)} />
              <Row label="Paid" value={money(position.paid, bill.currency)} />
              <Row label="Balance" value={money(position.balance, bill.currency)} strong />
            </div>
          </section>

          {position.balance > 0 ? (
            <>
              <section style={panel}>
                <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>
                  Record an external payment
                </h2>
                <p className="mv-muted" style={{ fontSize: "0.78rem", marginTop: 0 }}>
                  For money that has already left — a bank transfer, a cheque, a card you hold. This
                  records the fact; it moves nothing.
                </p>
                <Form method="post">
                  <input type="hidden" name="intent" value="pay" />
                  <label style={label} htmlFor="pay-amount">Amount</label>
                  <input
                    id="pay-amount"
                    style={input}
                    name="amount"
                    required
                    inputMode="decimal"
                    placeholder={(position.balance / 100).toFixed(2)}
                    defaultValue={(position.balance / 100).toFixed(2)}
                  />
                  <label style={{ ...label, marginTop: "0.4rem" }} htmlFor="pay-reference">Reference</label>
                  <input id="pay-reference" style={input} name="reference" placeholder="Bank reference or cheque number" />
                  <button type="submit" className="mv-button mv-button-dark" style={{ marginTop: "0.5rem" }} disabled={busy}>
                    Record payment
                  </button>
                </Form>
              </section>

              <section style={{ ...panel, background: "#F8FAFC" }}>
                <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#52627A", marginTop: 0 }}>
                  Charge a card
                </h2>
                <p className="mv-muted" style={{ fontSize: "0.78rem", marginTop: 0 }}>
                  Not available: no supplier-charging provider is configured. Recording a card charge
                  that never happened would be worse than recording nothing, so this refuses rather
                  than pretending — use the form above once the money has moved.
                </p>
                <button type="button" className="mv-button" disabled>Charge this card</button>
              </section>
            </>
          ) : (
            <section style={panel}>
              <p className="mv-muted" style={{ margin: 0 }}>
                This bill is settled. There is nothing left to pay and no action here that would
                charge anything.
              </p>
            </section>
          )}

          {bill.notes ? (
            <section style={panel}>
              <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Notes</h2>
              <p className="mv-muted" style={{ margin: 0 }}>{bill.notes}</p>
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
