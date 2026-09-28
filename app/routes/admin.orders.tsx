import { Link, Form, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import type { Prisma } from "@prisma/client";
import { ORDER_STATE, type OrderState } from "~/services/orderState.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "orders.view");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const sellerId = url.searchParams.get("seller") || "";
  const payment = url.searchParams.get("payment") || "";

  /*
   * The state vocabulary is read from the state machine rather than typed out
   * here. A filter list that is a second copy of the enum goes stale the moment
   * a state is added, and it goes stale silently — the new state's orders simply
   * become unreachable by filter, which reads as "no orders in that state".
   */
  const states: OrderState[] = Object.values(ORDER_STATE);

  const where: Prisma.OrderWhereInput = {};
  if (states.includes(state as OrderState)) where.state = state as OrderState;
  if (sellerId) where.sellerId = sellerId;
  /*
   * "Paid" is the wholesale side — the seller's own customer paying their store
   * is the other column and a different question. The pair is deliberately not
   * collapsed into one control: an order whose customer has paid and whose
   * seller has not is exactly the row somebody is looking for.
   */
  if (payment === "succeeded") where.wholesalePaymentStatus = "SUCCEEDED";
  else if (payment === "outstanding") where.wholesalePaymentStatus = { not: "SUCCEEDED" };

  const [orders, sellers] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        shopifyOrderName: true,
        supplierReference: true,
        currency: true,
        moonvellaTotal: true,
        customerName: true,
        paymentStatus: true,
        wholesalePaymentStatus: true,
        fulfillmentStatus: true,
        state: true,
        createdAt: true,
        seller: { select: { storeName: true } },
        // The amount actually charged, beside the status. A status alone cannot
        // answer "how much is this order worth to us", and a second query per
        // row to find out is how a list page becomes slow enough to stop being
        // read.
        wholesalePayment: { select: { amount: true, currency: true, status: true } },
        _count: { select: { items: true, shipments: true } },
      },
    }),
    prisma.seller.findMany({ select: { id: true, storeName: true }, orderBy: { storeName: "asc" } }),
  ]);

  return {
    orders,
    sellers,
    states,
    filters: { state, seller: sellerId, payment },
  };
}

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * Where an order is in the pipeline, as a colour an eye can sort by.
 *
 * Colored from the pipeline state and not from `fulfillmentStatus`, because the
 * two disagree in exactly the case that matters: an order whose parcels are all
 * PENDING and whose seller has not paid looks identical to one that is merely
 * waiting on a label. The state is the column that knows the difference.
 */
const STATE_COLOR: Record<string, string> = {
  RECEIVED: "#64748b",
  AWAITING_SELLER_PAYMENT: "#b45309",
  PAYMENT_PROCESSING: "#0369a1",
  PAYMENT_ACTION_REQUIRED: "#b45309",
  PAYMENT_FAILED: "#dc2626",
  PAID: "#0369a1",
  READY_FOR_FULFILLMENT: "#059669",
  FULFILLMENT_REQUESTED: "#059669",
  IN_FULFILLMENT: "#059669",
  SHIPPED: "#0369a1",
  DELIVERED: "#059669",
  CANCELLED: "#64748b",
  REFUND_REVIEW: "#dc2626",
};

const th: React.CSSProperties = { textAlign: "left", padding: "0.5rem", fontSize: "0.68rem", color: "#64748b" };
const td: React.CSSProperties = { padding: "0.5rem", fontSize: "0.8rem" };
const input: React.CSSProperties = { padding: "0.4rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.75rem", boxSizing: "border-box" };

export default function AdminOrders() {
  const { orders, sellers, states, filters } = useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Orders
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1rem" }}>
        MoonVella supplier orders created from verified Shopify order webhooks.
      </p>
      <p style={{ fontSize: "0.78rem", marginBottom: "1rem" }}>
        <Link to="/admin/fulfillment" style={{ color: "#0369a1", fontWeight: 600 }}>
          Fulfillment queue &rarr;
        </Link>
      </p>

      {/* A GET form, so a filtered list is a URL somebody can send to somebody
          else. The order-desk question "what is stuck waiting for money" is
          asked over and over, and it should not have to be re-clicked. */}
      <Form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          State
          <br />
          <select name="state" defaultValue={filters.state} style={input}>
            <option value="">All</option>
            {states.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Seller
          <br />
          <select name="seller" defaultValue={filters.seller} style={input}>
            <option value="">All</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>{s.storeName}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Wholesale payment
          <br />
          <select name="payment" defaultValue={filters.payment} style={input}>
            <option value="">All</option>
            <option value="succeeded">Paid by the seller</option>
            <option value="outstanding">Not paid by the seller</option>
          </select>
        </label>
        <button type="submit" style={{ padding: "0.45rem 0.85rem", border: "1px solid #082a4a", borderRadius: 6, background: "white", color: "#082a4a", fontSize: "0.72rem", fontWeight: 600, cursor: "pointer" }}>
          Filter
        </button>
        <Link to="/admin/orders" style={{ fontSize: "0.72rem", color: "#64748b" }}>Clear</Link>
      </Form>

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              <th style={th}>Order</th>
              <th style={th}>Seller</th>
              <th style={th}>Items</th>
              <th style={th}>MoonVella total</th>
              <th style={th}>State</th>
              <th style={th}>Customer paid</th>
              <th style={th}>Wholesale payment</th>
              <th style={th}>Paid</th>
              <th style={th}>Fulfillment</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>
                  No supplier orders match. They are created when a verified Shopify order contains an imported MoonVella product.
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr key={o.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={td}>
                    <Link to={`/admin/orders/${o.id}`} style={{ fontWeight: 600, color: "#082a4a" }}>
                      {o.shopifyOrderName}
                    </Link>
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>{o.supplierReference}</div>
                  </td>
                  <td style={td}>{o.seller?.storeName}</td>
                  <td style={td}>{o._count.items}</td>
                  <td style={td}>{money(o.moonvellaTotal, o.currency)}</td>
                  <td style={{ ...td, color: STATE_COLOR[o.state] ?? "#334155", fontWeight: 600 }}>{o.state}</td>
                  <td style={td}>{o.paymentStatus}</td>
                  <td style={td}>
                    <span style={{ color: o.wholesalePayment?.status === "SUCCEEDED" ? "#059669" : "#b45309", fontWeight: 600 }}>
                      {o.wholesalePayment?.status ?? o.wholesalePaymentStatus}
                    </span>
                    {o.wholesalePayment ? (
                      <div style={{ fontSize: "0.7rem", color: "#64748b" }}>
                        {money(o.wholesalePayment.amount, o.wholesalePayment.currency)}
                      </div>
                    ) : null}
                  </td>
                  {/* The one-word answer, spelled out. "Whether payment
                      succeeded" is the question the fulfillment queue is
                      filtered on, and an operator should be able to see the
                      same verdict here without knowing that SUCCEEDED is the
                      word for it. */}
                  <td style={{ ...td, color: o.wholesalePaymentStatus === "SUCCEEDED" ? "#059669" : "#dc2626", fontWeight: 600 }}>
                    {o.wholesalePaymentStatus === "SUCCEEDED" ? "Yes" : "No"}
                  </td>
                  <td style={td}>
                    {o.fulfillmentStatus} {o._count.shipments > 0 ? `(${o._count.shipments} shipment)` : ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
