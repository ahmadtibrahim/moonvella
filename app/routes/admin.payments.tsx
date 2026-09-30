import { Form, Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import type { Prisma, WholesalePaymentStatus } from "@prisma/client";
import { prisma } from "~/db.server";
import { requirePermission } from "~/utils/adminAuth.server";
import { stripeMode } from "~/services/payments.server";

const PAGE_SIZE = 100;

const STATUS_LABEL: Record<WholesalePaymentStatus, string> = {
  REQUIRES_PAYMENT: "Requires payment",
  PROCESSING: "Processing",
  REQUIRES_ACTION: "Seller action required",
  SUCCEEDED: "Captured",
  FAILED: "Failed",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
};

const STATUS_CLASS: Partial<Record<WholesalePaymentStatus, string>> = {
  SUCCEEDED: "mv-badge-success",
  PROCESSING: "mv-badge-brand",
  REQUIRES_ACTION: "mv-badge-warning",
  REQUIRES_PAYMENT: "mv-badge-warning",
  FAILED: "mv-badge-danger",
  PARTIALLY_REFUNDED: "mv-badge-warning",
  REFUNDED: "mv-badge-success",
  CANCELLED: "mv-badge-danger",
};

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(cents / 100);
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "orders.view");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const sellerId = url.searchParams.get("seller") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim();

  const where: Prisma.WholesalePaymentWhereInput = {};
  if (Object.values(STATUS_LABEL).length && status in STATUS_LABEL) {
    where.status = status as WholesalePaymentStatus;
  }
  if (sellerId) where.sellerId = sellerId;
  if (q) {
    where.OR = [
      { order: { shopifyOrderName: { contains: q, mode: "insensitive" } } },
      { order: { supplierReference: { contains: q, mode: "insensitive" } } },
      { seller: { storeName: { contains: q, mode: "insensitive" } } },
      { providerPaymentIntentId: { contains: q, mode: "insensitive" } },
    ];
  }

  const [payments, sellers, grouped, payouts, payoutGrouped, mode] = await Promise.all([
    prisma.wholesalePayment.findMany({
      where,
      take: PAGE_SIZE,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        capturedAt: true,
        paidAt: true,
        refundedAmount: true,
        requiresAction: true,
        failureMessage: true,
        billingMode: true,
        providerPaymentIntentId: true,
        providerChargeId: true,
        createdAt: true,
        updatedAt: true,
        seller: { select: { id: true, storeName: true, shopDomain: true } },
        order: { select: { id: true, shopifyOrderName: true, supplierReference: true } },
        attempts: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, createdAt: true } },
      },
    }),
    prisma.seller.findMany({ select: { id: true, storeName: true }, orderBy: { storeName: "asc" } }),
    prisma.wholesalePayment.groupBy({ by: ["status", "currency"], _count: { _all: true }, _sum: { amount: true, refundedAmount: true } }),
    prisma.stripePayout.findMany({ take: 50, orderBy: { createdAt: "desc" } }),
    prisma.stripePayout.groupBy({ by: ["status", "currency"], _count: { _all: true }, _sum: { amount: true } }),
    stripeMode(),
  ]);

  const summaries = grouped.reduce<Record<string, { count: number; amount: number; refunded: number; currency: string }>>(
    (result, row) => {
      result[row.status] = {
        count: row._count._all,
        amount: row._sum.amount ?? 0,
        refunded: row._sum.refundedAmount ?? 0,
        currency: row.currency,
      };
      return result;
    },
    {}
  );

  const payoutSummaries = payoutGrouped.map((row) => ({
    status: row.status,
    currency: row.currency,
    count: row._count._all,
    amount: row._sum.amount ?? 0,
  }));

  return { payments, sellers, summaries, payouts, payoutSummaries, mode, filters: { status, seller: sellerId, q } };
}

export default function AdminSellerPayments() {
  const { payments, sellers, summaries, payouts, payoutSummaries, mode, filters } = useLoaderData<typeof loader>();
  const captured = summaries.SUCCEEDED;
  const outstanding = (summaries.REQUIRES_PAYMENT?.count ?? 0) + (summaries.REQUIRES_ACTION?.count ?? 0);
  const paidToBank = payoutSummaries.filter((row) => row.status === "PAID");
  const pendingPayouts = payoutSummaries.filter((row) => !["PAID", "FAILED", "CANCELED"].includes(row.status));
  const failedPayouts = payoutSummaries.filter((row) => ["FAILED", "CANCELED"].includes(row.status));
  const payoutTotal = (rows: typeof payoutSummaries) =>
    rows.length === 0
      ? "$0.00"
      : rows.map((row) => `${money(row.amount, row.currency)} ${row.currency}`).join(" · ");

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>Seller payments</h1>
          <p>Wholesale charges collected from Shopify sellers. Captured and bank-paid are intentionally different states.</p>
        </div>
        <span className={`mv-badge ${mode === "live" ? "mv-badge-danger" : "mv-badge-brand"}`}>Stripe {mode}</span>
      </div>

      <div className="mv-stat-grid">
        <div className="mv-stat"><span>Captured</span><strong>{captured ? money(captured.amount - captured.refunded, captured.currency) : "$0.00"}</strong></div>
        <div className="mv-stat"><span>Paid to bank</span><strong>{payoutTotal(paidToBank)}</strong></div>
        <div className="mv-stat"><span>Payouts pending</span><strong>{payoutTotal(pendingPayouts)}</strong></div>
        <div className="mv-stat"><span>Awaiting seller</span><strong>{outstanding}</strong></div>
        <div className="mv-stat"><span>Payouts failed</span><strong>{failedPayouts.reduce((sum, row) => sum + row.count, 0)}</strong></div>
      </div>

      <Form method="get" className="mv-filter-bar">
        <label className="mv-field">Search<input className="mv-input" name="q" defaultValue={filters.q} placeholder="Order, seller or Stripe reference" /></label>
        <label className="mv-field">Status<select className="mv-input" name="status" defaultValue={filters.status}><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="mv-field">Seller<select className="mv-input" name="seller" defaultValue={filters.seller}><option value="">All sellers</option>{sellers.map((seller) => <option value={seller.id} key={seller.id}>{seller.storeName}</option>)}</select></label>
        <button className="mv-button mv-button-dark" type="submit">Filter</button>
        <Link className="mv-button" to="/admin/payments">Clear</Link>
      </Form>

      <section className="mv-panel">
        <div className="mv-panel-header">
          <div><h2>Payment ledger</h2><p>Stripe webhook-confirmed order charges, refunds and failures</p></div>
          <span className="mv-badge">{payments.length} shown</span>
        </div>
        <div className="mv-table-wrap">
          <table className="mv-table">
            <thead><tr><th>Order</th><th>Seller</th><th>Amount</th><th>Status</th><th>Captured</th><th>Bank payout</th><th>Reference</th></tr></thead>
            <tbody>
              {payments.length === 0 ? <tr><td colSpan={7} className="mv-muted">No seller payments match these filters.</td></tr> : payments.map((payment) => (
                <tr key={payment.id}>
                  <td><Link to={`/admin/orders/${payment.order.id}`}>{payment.order.shopifyOrderName}</Link><div className="mv-muted">{payment.order.supplierReference}</div></td>
                  <td>{payment.seller.storeName}<div className="mv-muted">{payment.seller.shopDomain}</div></td>
                  <td><strong>{money(payment.amount, payment.currency)}</strong>{payment.refundedAmount > 0 ? <div className="mv-muted">{money(payment.refundedAmount, payment.currency)} refunded</div> : null}</td>
                  <td><span className={`mv-badge ${STATUS_CLASS[payment.status] ?? ""}`}>{STATUS_LABEL[payment.status]}</span>{payment.failureMessage ? <div className="mv-muted">{payment.failureMessage}</div> : null}</td>
                  <td>{payment.capturedAt ? new Date(payment.capturedAt).toLocaleString() : "—"}</td>
                  <td><span className="mv-badge">See payouts below</span><div className="mv-muted">Stripe combines multiple charges into each bank payout</div></td>
                  <td><details><summary>Technical details</summary><div className="mv-mono mv-muted">{payment.providerPaymentIntentId ?? "No Stripe intent"}</div>{payment.providerChargeId ? <div className="mv-mono mv-muted">{payment.providerChargeId}</div> : null}</details></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mv-panel">
        <div className="mv-panel-header">
          <div><h2>Bank payouts</h2><p>Stripe-confirmed transfers from your Stripe balance to your bank account</p></div>
          <span className="mv-badge">{payouts.length} shown</span>
        </div>
        <div className="mv-table-wrap">
          <table className="mv-table">
            <thead><tr><th>Payout</th><th>Amount</th><th>Status</th><th>Expected arrival</th><th>Paid</th><th>Failure</th></tr></thead>
            <tbody>
              {payouts.length === 0 ? (
                <tr><td colSpan={6} className="mv-muted">No Stripe payout events have been received yet. Seller charges may still be captured and waiting in your Stripe balance.</td></tr>
              ) : payouts.map((payout) => (
                <tr key={payout.id}>
                  <td><span className="mv-mono">{payout.providerPayoutId}</span></td>
                  <td><strong>{money(payout.amount, payout.currency)}</strong><div className="mv-muted">{payout.currency}</div></td>
                  <td><span className={`mv-badge ${payout.status === "PAID" ? "mv-badge-success" : payout.status === "FAILED" || payout.status === "CANCELED" ? "mv-badge-danger" : "mv-badge-warning"}`}>{payout.status.replaceAll("_", " ")}</span></td>
                  <td>{payout.arrivalDate ? new Date(payout.arrivalDate).toLocaleDateString() : "—"}</td>
                  <td>{payout.paidAt ? new Date(payout.paidAt).toLocaleString() : "—"}</td>
                  <td>{payout.failureMessage ?? payout.failureCode ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
