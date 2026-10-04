import { Link, Form, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import type { Prisma } from "@prisma/client";
import { ORDER_STATE, type OrderState } from "~/services/orderState.server";
// The decision itself lives in the isomorphic module: the queue renders it,
// and a verifier drives it as a function — one definition, so the badge an
// operator clicks and the rule the server enforces cannot drift apart.
import { nextQueueAction, type QueueAction } from "~/services/shippingLogic";

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
   * "Seller payment" is the wholesale side — the store's customer paying the
   * store is the other column and a different question. The pair is deliberately
   * not collapsed into one control: an order whose customer has paid and whose
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
        customerEmail: true,
        paymentStatus: true,
        wholesalePaymentStatus: true,
        fulfillmentStatus: true,
        state: true,
        createdAt: true,
        seller: { select: { storeName: true } },
        // The newest shipment is the one every "where is this order" question
        // is about: a cancelled label is replaced by a new shipment row, so the
        // latest row is the live one without having to filter by status.
        shipments: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            carrier: true,
            serviceName: true,
            trackingNumber: true,
            trackingUrl: true,
            packedAt: true,
            handedToCarrierAt: true,
            deliveredAt: true,
            // Read by `nextQueueAction`'s milestone facts: "a label has been
            // bought" is a provider identifier, not only a status.
            providerShipmentId: true,
          },
        },
        // The amount actually charged, beside the status. A status alone cannot
        // answer "how much is this order worth to us", and a second query per
        // row to find out is how a list page becomes slow enough to stop being
        // read.
        wholesalePayment: { select: { amount: true, currency: true, status: true } },
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

const NEXT_ACTION_CLASS: Record<QueueAction["tone"], string> = {
  brand: "mv-badge mv-badge-brand",
  warning: "mv-badge mv-badge-warning",
  success: "mv-badge mv-badge-success",
  danger: "mv-badge mv-badge-danger",
  muted: "mv-badge",
};

export default function AdminOrders() {
  const { orders, sellers, states, filters } = useLoaderData<typeof loader>();

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>Orders</h1>
          <p className="mv-muted">
            MoonVella supplier orders created from verified Shopify order webhooks. The newest 100
            are shown.
          </p>
        </div>
        <div className="mv-actions">
          <Link to="/admin/fulfillment" className="mv-button">
            Fulfillment queue
          </Link>
        </div>
      </div>

      {/* A GET form, so a filtered list is a URL somebody can send to somebody
          else. The order-desk question "what is stuck waiting for money" is
          asked over and over, and it should not have to be re-clicked. */}
      <Form method="get" className="mv-filter-bar">
        <div className="mv-field">
          <label htmlFor="filter-state">Order state</label>
          <select id="filter-state" name="state" defaultValue={filters.state} className="mv-input">
            <option value="">All</option>
            {states.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="mv-field">
          <label htmlFor="filter-seller">Seller</label>
          <select id="filter-seller" name="seller" defaultValue={filters.seller} className="mv-input">
            <option value="">All</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>{s.storeName}</option>
            ))}
          </select>
        </div>
        <div className="mv-field">
          <label htmlFor="filter-payment">Seller payment</label>
          <select id="filter-payment" name="payment" defaultValue={filters.payment} className="mv-input">
            <option value="">All</option>
            <option value="succeeded">Paid by the seller</option>
            <option value="outstanding">Not paid by the seller</option>
          </select>
        </div>
        <button type="submit" className="mv-button mv-button-dark">Filter</button>
        <Link to="/admin/orders" className="mv-muted">Clear</Link>
      </Form>

      <div className="mv-panel">
        <div className="mv-table-wrap">
          <table className="mv-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Seller</th>
                <th>Customer</th>
                <th>Seller payment</th>
                <th>Next action</th>
                <th>Shipping</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="mv-muted" style={{ padding: "2rem", textAlign: "center" }}>
                    No supplier orders match. They are created when a verified Shopify order
                    contains an imported MoonVella product.
                  </td>
                </tr>
              ) : (
                orders.map((o) => {
                  const next = nextQueueAction({
                    state: o.state,
                    wholesalePaymentStatus: o.wholesalePaymentStatus,
                    shipment: o.shipments[0] ?? null,
                  });
                  const shipment = o.shipments[0] ?? null;
                  const sellerPaid = o.wholesalePaymentStatus === "SUCCEEDED";
                  return (
                    <tr key={o.id}>
                      <td>
                        <Link to={`/admin/orders/${o.id}`} style={{ fontWeight: 600 }}>
                          {o.shopifyOrderName}
                        </Link>
                        <div className="mv-muted">{o.supplierReference}</div>
                      </td>
                      <td>{o.seller?.storeName ?? <span className="mv-muted">—</span>}</td>
                      <td>
                        <div>{o.customerName ?? <span className="mv-muted">—</span>}</div>
                        {/* The store's customer, and what THEY paid the STORE —
                            a different question from the seller's payment to
                            MoonVella beside it, and labelled so it cannot be
                            misread as the same thing. */}
                        <div className="mv-muted">Shopify: {o.paymentStatus}</div>
                      </td>
                      <td>
                        <span className={`mv-badge mv-badge-${sellerPaid ? "success" : "warning"}`}>
                          {o.wholesalePayment?.status ?? o.wholesalePaymentStatus}
                        </span>
                        {o.wholesalePayment ? (
                          <div className="mv-muted">
                            {money(o.wholesalePayment.amount, o.wholesalePayment.currency)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {/*
                          Some next actions ARE a door — a prepared shipment's
                          label, a failed attempt's retry, a reconciliation —
                          and those carry the shipment page they open. The
                          rest are statements about the order ("Booking in
                          progress"), rendered as plain badges because there
                          is nothing safe for a click to do.
                        */}
                        {next.to ? (
                          <Link to={next.to} className={NEXT_ACTION_CLASS[next.tone]}>
                            {next.label}
                          </Link>
                        ) : (
                          <span className={NEXT_ACTION_CLASS[next.tone]}>{next.label}</span>
                        )}
                      </td>
                      <td>
                        {shipment ? (
                          <>
                            <div>
                              {shipment.carrier
                                ? [shipment.carrier, shipment.serviceName].filter(Boolean).join(" ")
                                : shipment.status}
                            </div>
                            <div className="mv-muted">
                              {shipment.trackingNumber ? (
                                shipment.trackingUrl ? (
                                  <a href={shipment.trackingUrl} target="_blank" rel="noreferrer">
                                    {shipment.trackingNumber}
                                  </a>
                                ) : (
                                  shipment.trackingNumber
                                )
                              ) : (
                                shipment.status
                              )}
                            </div>
                          </>
                        ) : (
                          <span className="mv-muted">No shipment yet</span>
                        )}
                      </td>
                      <td>
                        <Link to={`/admin/orders/${o.id}`} className="mv-button mv-button-dark">
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
