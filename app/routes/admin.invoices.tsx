/**
 * Orders & invoices — the accounting list.
 *
 * WHAT THIS ANSWERS. "What have we billed, what has been paid, and what is still
 * owed." One row per order, with the invoice that belongs to it, and it shows
 * the two badges the work order insists are INDEPENDENT: whether the money
 * arrived and whether the goods went. A paid order that has not shipped and a
 * shipped order nobody has paid for are different problems with different next
 * actions, and a single combined badge would hide one behind the other.
 *
 * AN ORDER WITH NO INVOICE IS SHOWN, NOT SKIPPED. That is the row an operator
 * most needs: a charge that succeeded but whose document does not exist is a
 * bookkeeping gap, and a list that only showed invoices would make it invisible.
 * The action that closes it is on the row.
 *
 * THE MONEY IS DERIVED ON EVERY RENDER, from the allocations and credit notes —
 * see `invoicePosition`. Nothing on this page reads a cached balance, so a
 * payment applied a second ago is in the totals.
 */

import { Link, Form, useLoaderData, useSearchParams, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { invoicePosition, issueInvoiceForOrder } from "~/services/invoicing.server";
import { money } from "~/utils/money";
import { formatDate } from "~/utils/dates";

const PAGE_SIZE = 25;

const FILTERS = [
  { value: "", label: "All" },
  { value: "unpaid", label: "Unpaid" },
  { value: "partial", label: "Partially paid" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "uninvoiced", label: "Not invoiced" },
] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "finance.view");
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));

  const where = {
    ...(q
      ? {
          OR: [
            { shopifyOrderName: { contains: q, mode: "insensitive" as const } },
            { seller: { storeName: { contains: q, mode: "insensitive" as const } } },
            { invoice: { number: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
    // Only orders that have reached the money. An order nobody has been charged
        // for is not yet a billing question, and listing it would bury the rows
        // that are.
    wholesalePaymentStatus: { in: ["SUCCEEDED", "PROCESSING", "REQUIRES_ACTION", "PARTIALLY_REFUNDED", "REFUNDED"] as never },
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        shopifyOrderName: true,
        shopifyOrderNumber: true,
        currency: true,
        moonvellaTotal: true,
        wholesalePaymentStatus: true,
        fulfillmentStatus: true,
        createdAt: true,
        seller: { select: { id: true, storeName: true } },
        invoice: {
          select: {
            id: true,
            number: true,
            total: true,
            currency: true,
            status: true,
            issuedAt: true,
            dueDate: true,
            allocations: { select: { amount: true } },
            credits: { select: { amount: true, status: true } },
          },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);

  const rows = orders.map((order) => {
    const invoice = order.invoice;
    const position = invoice
      ? invoicePosition(invoice, invoice.allocations, invoice.credits)
      : null;
    return {
      id: order.id,
      orderNumber: order.shopifyOrderName,
      store: order.seller.storeName,
      storeId: order.seller.id,
      createdAt: order.createdAt,
      currency: invoice?.currency ?? order.currency,
      amount: invoice?.total ?? order.moonvellaTotal,
      invoiceNumber: invoice?.number ?? null,
      invoiceId: invoice?.id ?? null,
      invoiceStatus: invoice?.status ?? null,
      dueDate: invoice?.dueDate ?? null,
      paid: position?.paid ?? 0,
      credited: position?.credited ?? 0,
      balance: position?.balance ?? order.moonvellaTotal,
      status: position?.status ?? null,
      overdue: position?.overdue ?? false,
      delivery: order.fulfillmentStatus,
      payment: order.wholesalePaymentStatus,
    };
  });

  // Filtering happens after the position is computed, because three of the six
  // filters are about derived money. A SQL filter would have to re-derive it and
  // would then be a second implementation of the same arithmetic.
  const filtered = rows.filter((row) => {
    switch (filter) {
      case "unpaid":
        return row.invoiceId !== null && row.balance > 0 && row.paid === 0 && row.credited === 0;
      case "partial":
        return row.balance > 0 && (row.paid > 0 || row.credited > 0);
      case "paid":
        return row.invoiceId !== null && row.balance <= 0;
      case "overdue":
        return row.overdue;
      case "uninvoiced":
        return row.invoiceId === null;
      default:
        return true;
    }
  });

  return {
    rows: filtered,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    filters: { filter, q },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "payments.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { id: user.id, name: user.name, ipAddress: ip, userAgent };

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const orderId = String(form.get("orderId") || "");

  if (intent !== "issue") return { error: "Unknown action." };

  try {
    const issued = await issueInvoiceForOrder(orderId, actor);
    return {
      ok: issued.existing
        ? `Order already has invoice ${issued.invoice.number}.`
        : `Issued invoice ${issued.invoice.number}.`,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not issue the invoice." };
  }
}

const panel: React.CSSProperties = {
  background: "white",
  border: "1px solid #DCE3EB",
  borderRadius: 12,
  padding: "1.25rem",
  marginBottom: "1.25rem",
};

function badge(text: string, tone: "paid" | "pending" | "late" | "info" | "muted"): React.CSSProperties {
  const palette: Record<string, [string, string]> = {
    paid: ["#DCFCE7", "#166534"],
    pending: ["#FEF3C7", "#92400E"],
    late: ["#FEE2E2", "#B91C1C"],
    info: ["#DBEAFE", "#1D4ED8"],
    muted: ["#F1F5F9", "#475569"],
  };
  const [background, color] = palette[tone];
  return {
    background,
    color,
    border: `1px solid ${background}`,
    borderRadius: 999,
    padding: "0.15rem 0.5rem",
    fontSize: "0.68rem",
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

export default function AdminInvoices() {
  const { rows, total, page, pageCount, filters } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  const qs = (overrides: Record<string, string>) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(overrides)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  };

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>Orders &amp; invoices</h1>
          <p>
            What has been billed, what has been paid, and what is still owed. Payment and delivery
            are shown separately: one is about money, the other about goods.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Link to="/admin/customers" className="mv-button">Customers</Link>
          <Link to="/admin/bills" className="mv-button">Bills &amp; expenses</Link>
        </div>
      </div>

      <nav className="mv-workspace-nav" aria-label="Invoice filters">
        {FILTERS.map((entry) => (
          <Link
            key={entry.value || "all"}
            to={`/admin/invoices${qs({ filter: entry.value, page: "" })}`}
            className={filters.filter === entry.value ? "is-active" : ""}
            aria-current={filters.filter === entry.value ? "page" : undefined}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      <Form method="get" className="mv-filter-bar">
        {filters.filter ? <input type="hidden" name="filter" value={filters.filter} /> : null}
        <label className="mv-field" htmlFor="invoice-q">
          Search
          <input
            id="invoice-q"
            className="mv-input"
            name="q"
            defaultValue={filters.q}
            placeholder="Order, store or invoice number"
          />
        </label>
        <button type="submit" className="mv-button mv-button-dark">Filter</button>
        <Link to="/admin/invoices" className="mv-button">Clear</Link>
      </Form>

      <section style={panel}>
        {loading ? (
          <p className="mv-muted" role="status" aria-live="polite">Loading invoices…</p>
        ) : rows.length === 0 ? (
          <p className="mv-muted">
            {filters.q || filters.filter
              ? "No orders match these filters."
              : "No orders have reached a charge yet. An order appears here once its wholesale payment is attempted."}
          </p>
        ) : (
          <div className="mv-table-wrap">
            <table className="mv-table" style={{ minWidth: 1180 }}>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Order</th>
                  <th>Store</th>
                  <th>Date</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th style={{ textAlign: "right" }}>Paid</th>
                  <th style={{ textAlign: "right" }}>Balance</th>
                  <th>Payment</th>
                  <th>Delivery</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.invoiceId ? (
                        <Link to={`/admin/invoices/${row.invoiceId}`} className="mv-mono">{row.invoiceNumber}</Link>
                      ) : (
                        <span className="mv-badge mv-badge-warning">Not invoiced</span>
                      )}
                      {row.dueDate ? (
                        <div className="mv-muted" style={{ fontSize: "0.72rem" }}>
                          Due {formatDate(row.dueDate)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Link to={`/admin/orders/${row.id}`}>{row.orderNumber}</Link>
                    </td>
                    <td className="mv-muted">
                      <Link to={`/admin/customers/${row.storeId}`}>{row.store}</Link>
                    </td>
                    <td className="mv-muted">{formatDate(row.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>{money(row.amount, row.currency)}</td>
                    <td style={{ textAlign: "right", color: "#166534" }}>
                      {row.paid ? money(row.paid, row.currency) : "—"}
                      {row.credited ? (
                        <div style={{ fontSize: "0.7rem", color: "#1D4ED8" }}>
                          + {money(row.credited, row.currency)} credited
                        </div>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: row.balance > 0 ? 600 : 400 }}>
                      {money(row.balance, row.currency)}
                    </td>
                    <td>
                      {/* INDEPENDENT OF DELIVERY, deliberately. The two badges
                          answer different questions and are never merged into
                          one word. */}
                      {row.invoiceId === null ? (
                        <span style={badge("No invoice", "muted")}>No invoice</span>
                      ) : row.balance <= 0 ? (
                        <span style={badge("Paid", "paid")}>Paid</span>
                      ) : row.overdue ? (
                        <span style={badge("Overdue", "late")}>Overdue</span>
                      ) : row.paid > 0 || row.credited > 0 ? (
                        <span style={badge("Partial", "pending")}>Partial</span>
                      ) : (
                        <span style={badge("Unpaid", "pending")}>Unpaid</span>
                      )}
                    </td>
                    <td>
                      <span
                        style={badge(
                          row.delivery === "DELIVERED" ? "Delivered" : row.delivery === "SHIPPED" ? "Shipped" : "Not shipped",
                          row.delivery === "DELIVERED" ? "paid" : row.delivery === "SHIPPED" ? "info" : "muted"
                        )}
                      >
                        {row.delivery === "DELIVERED" ? "Delivered" : row.delivery === "SHIPPED" ? "Shipped" : "Not shipped"}
                      </span>
                    </td>
                    <td>
                      {row.invoiceId ? (
                        <Link to={`/admin/invoices/${row.invoiceId}`} className="mv-button">View</Link>
                      ) : (
                        <Form method="post">
                          <input type="hidden" name="intent" value="issue" />
                          <input type="hidden" name="orderId" value={row.id} />
                          <button type="submit" className="mv-button mv-button-dark">Issue invoice</button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pageCount > 1 ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
            {page > 1 ? <Link to={`/admin/invoices${qs({ page: String(page - 1) })}`} className="mv-button">Previous</Link> : null}
            <span className="mv-muted" style={{ alignSelf: "center", fontSize: "0.78rem" }}>
              Page {page} of {pageCount} · {total} order(s)
            </span>
            {page < pageCount ? <Link to={`/admin/invoices${qs({ page: String(page + 1) })}`} className="mv-button">Next</Link> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
