/**
 * Bills & expenses: what MoonVella owes its own suppliers.
 *
 * THE HEADLINE FIGURE IS NOT THE TOTAL — it is what is OVERDUE, because that is
 * the one with a consequence. A list that sorts by amount buries the bill that
 * was due last week behind one for a larger sum due next month.
 *
 * THE CARRIER RECONCILIATION IS THE REASON THIS PAGE IS WORTH HAVING. A bill can
 * name a shipment, and where it does, this page shows the three figures the work
 * order asks for side by side: what the carrier QUOTED, what was BOOKED, and
 * what was actually BILLED. A parcel quoted at 6.93 and invoiced at 11.40 is a
 * margin problem that is invisible until year end without all three in one place.
 *
 * IT NEVER TOUCHES THE SELLER'S CHARGE. A variance is MoonVella's cost problem;
 * the seller was quoted a price and that price is theirs. Writing a variance
 * back onto a customer's charge would re-price an order every time a carrier
 * invoice was re-imported.
 */

import { useState } from "react";
import { Link, Form, useLoaderData, useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { BILL_CATEGORIES, billPosition, createSupplierBill } from "~/services/bills.server";
import { money } from "~/utils/money";
import { formatDate } from "~/utils/dates";
import { parseMajorUnits } from "~/utils/money";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "finance.view");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";

  const bills = await prisma.supplierBill.findMany({
    orderBy: [{ dueDate: "asc" }, { issuedOn: "desc" }],
    include: {
      payments: { select: { amount: true, method: true } },
      shipment: { select: { id: true, carrier: true, serviceName: true, quotedCarrierCost: true, bookedCost: true } },
    },
  });

  const rows = bills
    .map((bill) => {
      const position = billPosition(bill, bill.payments);
      return {
        id: bill.id,
        supplier: bill.supplier,
        reference: bill.reference,
        category: bill.category,
        currency: bill.currency,
        total: bill.total,
        issuedOn: bill.issuedOn,
        dueDate: bill.dueDate,
        paid: position.paid,
        balance: position.balance,
        status: position.status,
        overdue: position.overdue,
        daysToDue: position.daysToDue,
        shipmentId: bill.shipmentId,
        shipmentLabel: bill.shipment
          ? `${bill.shipment.carrier ?? "carrier"} ${bill.shipment.serviceName ?? ""}`.trim()
          : null,
        // The three figures, when the bill is attributable to a parcel.
        quoted: bill.shipment?.quotedCarrierCost ?? null,
        booked: bill.shipment?.bookedCost ?? null,
      };
    })
    .filter((row) => (status ? row.status === status : true));

  return {
    rows,
    filter: status,
    totals: {
      outstanding: rows.filter((r) => r.balance > 0).reduce((sum, r) => sum + r.balance, 0),
      overdue: rows.filter((r) => r.overdue).reduce((sum, r) => sum + r.balance, 0),
      count: rows.length,
      currency: rows[0]?.currency ?? "CAD",
    },
    categories: BILL_CATEGORIES,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "payments.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { id: user.id, name: user.name, ipAddress: ip, userAgent };

  const form = await request.formData();
  if (String(form.get("intent") || "") !== "create") return { error: "Unknown action." };

  const totalRaw = String(form.get("total") || "").trim();
  // The form takes a major-unit string ("114.40") and this converts once, at the
  // boundary, so no other part of the module has to think about it. Parsed from
  // the string rather than from a float: `Math.round(114.40 * 100)` is 11439.
  const cents = parseMajorUnits(totalRaw);
  if (cents === null) return { error: "Enter the total as an amount like 114.40." };

  const issuedOn = String(form.get("issuedOn") || "");
  const dueDate = String(form.get("dueDate") || "");

  try {
    const bill = await createSupplierBill(
      {
        supplier: String(form.get("supplier") || ""),
        reference: String(form.get("reference") || "") || null,
        category: String(form.get("category") || "Other"),
        total: cents,
        issuedOn: issuedOn ? new Date(`${issuedOn}T00:00:00.000Z`) : new Date(),
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`) : null,
        notes: String(form.get("notes") || "") || null,
        shipmentId: String(form.get("shipmentId") || "") || null,
      },
      actor
    );
    return { ok: `Recorded a ${bill.category.toLowerCase()} bill from ${bill.supplier}.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not record the bill." };
  }
}

const panel: React.CSSProperties = {
  background: "white",
  border: "1px solid #DCE3EB",
  borderRadius: 12,
  padding: "1.25rem",
  marginBottom: "1.25rem",
};

const label: React.CSSProperties = { display: "block", fontSize: "0.75rem", color: "#52627A", marginBottom: "0.2rem" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.55rem",
  border: "1px solid #DCE3EB",
  borderRadius: 8,
  fontSize: "0.85rem",
  minHeight: 40,
};

export default function AdminBills() {
  const { rows, filter, totals, categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>Bills &amp; expenses</h1>
          <p>
            What MoonVella owes carriers, suppliers and vendors — and, where a bill belongs to a
            parcel, how the carrier&apos;s invoice compares with what was quoted and booked.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Link to="/admin/invoices" className="mv-button">Orders &amp; invoices</Link>
          <button type="button" className="mv-button mv-button-dark" onClick={() => setShowForm((open) => !open)}>
            {showForm ? "Cancel" : "Record a bill"}
          </button>
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

      {showForm ? (
        <section style={panel}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Record a bill</h2>
          <Form method="post" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.75rem" }}>
            <input type="hidden" name="intent" value="create" />
            <div>
              <label style={label} htmlFor="bill-supplier">Supplier</label>
              <input id="bill-supplier" style={input} name="supplier" required placeholder="eShipper" />
            </div>
            <div>
              <label style={label} htmlFor="bill-reference">Their document number</label>
              <input id="bill-reference" style={input} name="reference" placeholder="Optional" />
            </div>
            <div>
              <label style={label} htmlFor="bill-category">Category</label>
              <select id="bill-category" style={input} name="category" defaultValue="Shipping">
                {categories.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={label} htmlFor="bill-total">Total</label>
              <input id="bill-total" style={input} name="total" required placeholder="114.40" inputMode="decimal" />
            </div>
            <div>
              <label style={label} htmlFor="bill-issued">Issued on</label>
              <input id="bill-issued" style={input} type="date" name="issuedOn" required />
            </div>
            <div>
              <label style={label} htmlFor="bill-due">Due date</label>
              <input id="bill-due" style={input} type="date" name="dueDate" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={label} htmlFor="bill-shipment">Shipment id (optional — links this bill to a parcel)</label>
              <input id="bill-shipment" style={input} name="shipmentId" placeholder="Only when the bill is for one shipment" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={label} htmlFor="bill-notes">Notes</label>
              <input id="bill-notes" style={input} name="notes" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <button type="submit" className="mv-button mv-button-dark" disabled={busy}>Record bill</button>
            </div>
          </Form>
        </section>
      ) : null}

      <div className="mv-stat-grid">
        <div className="mv-stat"><span>Bills shown</span><strong>{totals.count}</strong></div>
        <div className="mv-stat"><span>Outstanding</span><strong>{money(totals.outstanding, totals.currency)}</strong></div>
        <div className="mv-stat"><span>Overdue</span><strong>{money(totals.overdue, totals.currency)}</strong></div>
      </div>

      <nav className="mv-workspace-nav" aria-label="Bill filters">
        {[
          { value: "", label: "All" },
          { value: "OPEN", label: "Open" },
          { value: "PARTIAL", label: "Partially paid" },
          { value: "PAID", label: "Paid" },
        ].map((entry) => (
          <Link
            key={entry.value || "all"}
            to={entry.value ? `/admin/bills?status=${entry.value}` : "/admin/bills"}
            className={filter === entry.value ? "is-active" : ""}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      <section style={panel}>
        {rows.length === 0 ? (
          <p className="mv-muted" style={{ margin: 0 }}>
            No bills recorded{filter ? " with that status" : ""}. Carrier invoices, packaging and
            software all belong here.
          </p>
        ) : (
          <div className="mv-table-wrap">
            <table className="mv-table" style={{ minWidth: 1080 }}>
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Category</th>
                  <th>Reference</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                  <th style={{ textAlign: "right" }}>Balance</th>
                  <th>Carrier: quoted / booked</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td><Link to={`/admin/bills/${row.id}`}>{row.supplier}</Link></td>
                    <td className="mv-muted">{row.category}</td>
                    <td className="mv-muted mv-mono">{row.reference ?? "—"}</td>
                    <td className="mv-muted">{formatDate(row.issuedOn)}</td>
                    <td className="mv-muted">{row.dueDate ? formatDate(row.dueDate) : "no term"}</td>
                    <td style={{ textAlign: "right" }}>{money(row.total, row.currency)}</td>
                    <td style={{ textAlign: "right", fontWeight: row.balance > 0 ? 600 : 400 }}>
                      {money(row.balance, row.currency)}
                    </td>
                    {/* The three-way comparison, only where a shipment is named.
                        It never writes back to the seller's charge. */}
                    <td className="mv-muted">
                      {row.shipmentId ? (
                        <>
                          <Link to={`/admin/shipping/${row.shipmentId}`}>{row.shipmentLabel}</Link>
                          <div style={{ fontSize: "0.72rem" }}>
                            quoted {row.quoted != null ? money(row.quoted, row.currency) : "—"} · booked{" "}
                            {row.booked != null ? money(row.booked, row.currency) : "—"} · billed{" "}
                            {money(row.total, row.currency)}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {row.status === "PAID" ? (
                        <span className="mv-badge mv-badge-success">Paid</span>
                      ) : row.overdue ? (
                        <span className="mv-badge mv-badge-danger">
                          Overdue{row.daysToDue !== null ? ` ${Math.abs(row.daysToDue)}d` : ""}
                        </span>
                      ) : row.status === "PARTIAL" ? (
                        <span className="mv-badge mv-badge-warning">Partial</span>
                      ) : (
                        <span className="mv-badge">Open</span>
                      )}
                    </td>
                    <td><Link to={`/admin/bills/${row.id}`} className="mv-button">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
