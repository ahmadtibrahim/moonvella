/**
 * One customer: who they are, what they owe, and their statement.
 *
 * THE STATEMENT IS GENERATED, NOT STORED — see `statements.server.ts`. Every
 * figure on this page comes from the invoices, allocations and credit notes, so
 * a payment applied one second ago changes the closing balance with nothing to
 * recompute and nothing to invalidate.
 *
 * THE AGING TABLE IS THE PART PEOPLE RING UP ABOUT, and it is aged from DUE
 * DATES rather than from invoice dates: money is late when it is past the agreed
 * term, and an invoice on a 60-day term is not "60 days old" in any sense a
 * collections call cares about. An invoice with no agreed term sits in `current`
 * — no term was agreed, so no term has been missed.
 *
 * THE PERIOD IS A FILTER, NOT A CUT. Choosing a period changes which lines the
 * running balance visits, and the opening balance carries everything before it,
 * so the closing balance is the same number whichever period you pick. A
 * statement whose total moves when you change the window is a statement nobody
 * can reconcile.
 */

import { Link, Form, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { statementFor } from "~/services/statements.server";
import { money } from "~/utils/money";
import { prisma } from "~/db.server";
import { formatDate } from "~/utils/dates";

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "finance.view");
  const sellerId = String(params.id);
  const url = new URL(request.url);

  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to")) ?? new Date();

  const statement = await statementFor(sellerId, { from, to });

  const [seller, invoices] = await Promise.all([
    prisma.seller.findUniqueOrThrow({
      where: { id: sellerId },
      select: {
        id: true,
        storeName: true,
        shopDomainFull: true,
        contactName: true,
        contactEmail: true,
        phone: true,
        country: true,
        status: true,
      },
    }),
    prisma.invoice.findMany({
      where: { sellerId },
      orderBy: { issuedAt: "desc" },
      take: 20,
      select: { id: true, number: true, total: true, currency: true, status: true, issuedAt: true, dueDate: true },
    }),
  ]);

  return {
    seller,
    invoices,
    statement: {
      ...statement,
      from: statement.from ? statement.from.toISOString() : null,
      to: statement.to.toISOString(),
      lines: statement.lines.map((line) => ({ ...line, date: line.date.toISOString() })),
    },
    filters: {
      from: url.searchParams.get("from") ?? "",
      to: url.searchParams.get("to") ?? "",
    },
  };
}

const panel: React.CSSProperties = {
  background: "white",
  border: "1px solid #DCE3EB",
  borderRadius: 12,
  padding: "1.25rem",
  marginBottom: "1.25rem",
};

export default function AdminCustomerDetail() {
  const { seller, invoices, statement, filters } = useLoaderData<typeof loader>();

  const aging = statement.aging;
  const currency = statement.currency;

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <p className="mv-muted" style={{ margin: 0 }}>
            <Link to="/admin/customers">← Customers</Link>
          </p>
          <h1 style={{ marginBottom: "0.15rem" }}>{seller.storeName}</h1>
          <p className="mv-muted" style={{ margin: 0 }}>
            {seller.contactName ? `${seller.contactName} · ` : ""}
            {seller.contactEmail}
            {seller.phone ? ` · ${seller.phone}` : ""} · {seller.shopDomainFull}
          </p>
        </div>
        {/* A statement download is a resource route, so the browser's own
            download machinery handles it and no session token has to travel in a
            query string. */}
        <a
          className="mv-button mv-button-dark"
          href={`/admin/customers/${seller.id}/statement.pdf${filters.from || filters.to ? `?from=${filters.from}&to=${filters.to}` : ""}`}
        >
          Download statement PDF
        </a>
      </div>

      <div className="mv-stat-grid">
        <div className="mv-stat"><span>Closing balance</span><strong>{money(statement.closingBalance, currency)}</strong></div>
        <div className="mv-stat"><span>Opening balance</span><strong>{money(statement.openingBalance, currency)}</strong></div>
        <div className="mv-stat"><span>Invoiced in period</span><strong>{money(statement.periodInvoiced, currency)}</strong></div>
        <div className="mv-stat"><span>Paid in period</span><strong>{money(statement.periodPaid, currency)}</strong></div>
      </div>

      <section style={panel}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Aging</h2>
        <p className="mv-muted" style={{ marginTop: 0, fontSize: "0.8rem" }}>
          Aged from each invoice&apos;s due date. An invoice with no agreed payment term is never
          overdue, so it appears under Current.
        </p>
        <div className="mv-table-wrap">
          <table className="mv-table" style={{ maxWidth: 720 }}>
            <thead>
              <tr>
                <th>Current</th>
                <th style={{ textAlign: "right" }}>1–30 days</th>
                <th style={{ textAlign: "right" }}>31–60 days</th>
                <th style={{ textAlign: "right" }}>61–90 days</th>
                <th style={{ textAlign: "right" }}>Over 90</th>
                <th style={{ textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{money(aging.current, currency)}</td>
                <td style={{ textAlign: "right" }}>{money(aging.d1to30, currency)}</td>
                <td style={{ textAlign: "right" }}>{money(aging.d31to60, currency)}</td>
                <td style={{ textAlign: "right" }}>{money(aging.d61to90, currency)}</td>
                <td style={{ textAlign: "right", color: aging.over90 ? "#B91C1C" : undefined }}>
                  {money(aging.over90, currency)}
                </td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{money(aging.total, currency)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Statement</h2>
          <Form method="get" className="mv-actions" style={{ alignItems: "flex-end" }}>
            <label className="mv-field">
              From
              <input className="mv-input" type="date" name="from" defaultValue={filters.from} />
            </label>
            <label className="mv-field">
              To
              <input className="mv-input" type="date" name="to" defaultValue={filters.to} />
            </label>
            <button type="submit" className="mv-button mv-button-dark">Apply</button>
            <Link to={`/admin/customers/${seller.id}`} className="mv-button">Clear</Link>
          </Form>
        </div>

        {statement.lines.length === 0 ? (
          <p className="mv-muted">Nothing on this account in the chosen period.</p>
        ) : (
          <div className="mv-table-wrap">
            <table className="mv-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Detail</th>
                  <th style={{ textAlign: "right" }}>Debit</th>
                  <th style={{ textAlign: "right" }}>Credit</th>
                  <th style={{ textAlign: "right" }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line, index) => (
                  <tr key={`${line.reference}-${line.kind}-${index}`}>
                    <td className="mv-muted">{formatDate(new Date(line.date))}</td>
                    <td className="mv-mono">{line.href ? <Link to={line.href}>{line.reference}</Link> : line.reference}</td>
                    <td>{line.description}</td>
                    <td style={{ textAlign: "right", color: "#166534" }}>
                      {line.debit ? money(line.debit, currency) : "—"}
                    </td>
                    <td style={{ textAlign: "right", color: "#1D4ED8" }}>
                      {line.credit ? money(line.credit, currency) : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>{money(line.balance, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mv-muted" style={{ fontSize: "0.78rem" }}>
          Credits reduce the balance and are shown separately from payments because they are not the
          same thing: a payment is money received, a credit is money no longer owed.
        </p>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>Recent invoices</h2>
        {invoices.length === 0 ? (
          <p className="mv-muted" style={{ margin: 0 }}>No invoices for this company yet.</p>
        ) : (
          <table className="mv-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td><Link to={`/admin/invoices/${invoice.id}`} className="mv-mono">{invoice.number}</Link></td>
                  <td className="mv-muted">{invoice.issuedAt ? formatDate(invoice.issuedAt) : "—"}</td>
                  <td className="mv-muted">{invoice.dueDate ? formatDate(invoice.dueDate) : "no term"}</td>
                  <td className="mv-muted">{invoice.status}</td>
                  <td style={{ textAlign: "right" }}>{money(invoice.total, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
