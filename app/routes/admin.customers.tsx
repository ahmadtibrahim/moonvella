/**
 * Customers: the companies MoonVella bills.
 *
 * A "customer" here is a SELLER — a retail store that buys wholesale. The page
 * exists because an account is a thing people ring up about: what have we
 * invoiced them, what have they paid, what do they still owe and how old is it.
 *
 * CROSS-STORE FOR THE OPERATOR, AND ONLY THE OPERATOR. `requirePermission` gates
 * the whole route on `finance.view`, and there is no query parameter that can
 * widen or narrow the set — a seller reading their own balance goes through the
 * merchant surface, where the seller id comes from their session and never from
 * the request. That is the tenant boundary, and it is enforced here rather than
 * by hiding a link.
 */

import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { customerSummaries } from "~/services/statements.server";
import { money } from "~/utils/money";
import { formatDate } from "~/utils/dates";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "finance.view");
  const customers = await customerSummaries();
  return {
    customers: customers.map((row) => ({
      ...row,
      oldestDue: row.oldestDue ? row.oldestDue.toISOString() : null,
    })),
    totals: {
      outstanding: customers.reduce((sum, row) => sum + row.outstanding, 0),
      overdue: customers.filter((row) => row.overdue).length,
      companies: customers.length,
      currency: customers[0]?.currency ?? "CAD",
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

export default function AdminCustomers() {
  const { customers, totals } = useLoaderData<typeof loader>();

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>Customers</h1>
          <p>Every company with something on its account, and how old the oldest balance is.</p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Link to="/admin/invoices" className="mv-button">Orders &amp; invoices</Link>
          <Link to="/admin/bills" className="mv-button">Bills &amp; expenses</Link>
        </div>
      </div>

      <div className="mv-stat-grid">
        <div className="mv-stat"><span>Companies</span><strong>{totals.companies}</strong></div>
        <div className="mv-stat"><span>Outstanding</span><strong>{money(totals.outstanding, totals.currency)}</strong></div>
        <div className="mv-stat"><span>With an overdue balance</span><strong>{totals.overdue}</strong></div>
      </div>

      <section style={panel}>
        {customers.length === 0 ? (
          <p className="mv-muted" style={{ margin: 0 }}>
            No company has been invoiced yet. An invoice is issued automatically when a wholesale
            charge succeeds, and can be issued by hand from Orders &amp; invoices.
          </p>
        ) : (
          <div className="mv-table-wrap">
            <table className="mv-table" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Store</th>
                  <th style={{ textAlign: "right" }}>Invoices</th>
                  <th style={{ textAlign: "right" }}>Outstanding</th>
                  <th>Oldest due</th>
                  <th>Account</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {customers.map((row) => (
                  <tr key={row.id}>
                    <td><Link to={`/admin/customers/${row.id}`}>{row.company}</Link></td>
                    <td className="mv-muted mv-mono">{row.shopDomain}</td>
                    <td style={{ textAlign: "right" }}>{row.invoiceCount}</td>
                    <td style={{ textAlign: "right", fontWeight: row.outstanding > 0 ? 600 : 400 }}>
                      {money(row.outstanding, row.currency)}
                    </td>
                    <td className="mv-muted">
                      {row.oldestDue ? formatDate(new Date(row.oldestDue)) : "—"}
                    </td>
                    <td>
                      {row.outstanding <= 0 ? (
                        <span className="mv-badge mv-badge-success">Settled</span>
                      ) : row.overdue ? (
                        <span className="mv-badge mv-badge-danger">Overdue</span>
                      ) : (
                        <span className="mv-badge mv-badge-warning">Current</span>
                      )}
                    </td>
                    <td><Link to={`/admin/customers/${row.id}`} className="mv-button">Statement</Link></td>
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
