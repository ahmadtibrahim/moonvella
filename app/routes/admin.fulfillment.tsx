import { Link, Form, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import type { Prisma } from "@prisma/client";
import { ORDER_STATE, isFulfillmentUnlocked, type OrderState } from "~/services/orderState.server";

/**
 * THE WAREHOUSE QUEUE, AND WHY IT CANNOT SHOW AN ORDER NOBODY HAS PAID FOR.
 *
 * Two filters, and both are load-bearing:
 *
 *   1. `state in (READY_FOR_FULFILLMENT, FULFILLMENT_REQUESTED, IN_FULFILLMENT)`.
 *      These are the states in which warehouse work is permitted. They are
 *      derived from the state machine's own predicate below rather than typed
 *      out, because a list typed out here is a second copy of a rule that
 *      already exists — and the copy is the one that goes stale.
 *
 *   2. `wholesalePaymentStatus: "SUCCEEDED"`.
 *
 * Why the second one, when the first is already only reachable through PAID:
 * because the two are different columns written by different code. The state
 * machine is a property of the graph — nothing reaches READY_FOR_FULFILLMENT
 * except from PAID, and PAID is only ever written by the verified Stripe event.
 * `wholesalePaymentStatus` is the payment subsystem's own column, written by the
 * payment code. They agree today; they are not the same fact, and a queue is the
 * one screen where being wrong means goods leave the building against money that
 * never arrived.
 *
 * So the queue asks both questions, and an order has to answer both to appear.
 * That makes the failure mode "an order that should be here is missing" — which
 * somebody notices and reports — instead of "an order that should not be here is
 * being packed", which nobody notices until the invoice does not balance. The
 * state list is the rule; the payment status is the belt to that rule's braces,
 * and this comment is why it has not been removed as redundant.
 */
const QUEUE_LIMIT = 200;

/** Where the row's progress is, in the vocabulary the rest of the panel uses. */
const STATE_COLOR: Record<string, string> = {
  READY_FOR_FULFILLMENT: "#059669",
  FULFILLMENT_REQUESTED: "#0369a1",
  IN_FULFILLMENT: "#0369a1",
};

const th: React.CSSProperties = { padding: "0.5rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };
const td: React.CSSProperties = { padding: "0.5rem", fontSize: "0.78rem", verticalAlign: "top" };
const input: React.CSSProperties = { padding: "0.4rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.75rem", boxSizing: "border-box" };

/**
 * Where a parcel is going, reduced to the three fields a warehouse needs.
 *
 * THE STREET, THE RECIPIENT AND THE CONTACT DETAILS ARE NOT READ, LET ALONE
 * RENDERED. The stored column is the whole address blob as Shopify sent it, and
 * this queue is worked by people preparing a parcel — a job that needs a city
 * and a region, not a customer's phone number. The three keys are read one at a
 * time rather than the object being handed to the renderer, so a field Shopify
 * or our own address rewrite adds later cannot end up on this screen by default.
 * The order detail screen shows the full address, for the people who book the
 * label and have to read the refusal that names it.
 */
function destinationSummary(raw: string | null): string {
  if (!raw) return "Destination not recorded";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A blob that will not parse is not shown verbatim here, unlike on the order
    // screen: "we cannot read this" is all a warehouse needs, and the raw text is
    // the customer's address, which this queue does not display.
    return "Destination not readable";
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const parts = [
    text(parsed.city),
    text(parsed.province) ?? text(parsed.provinceCode),
    text(parsed.country) ?? text(parsed.countryCode),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : "Destination not recorded";
}

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "orders.view");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const sellerId = url.searchParams.get("seller") || "";

  /*
   * The stages are the state machine's answer to "may warehouse work begin",
   * asked of the machine itself. A where clause cannot call a predicate, so this
   * is the query's twin of `isFulfillmentUnlocked` — and it is computed from it
   * so the twin cannot drift.
   */
  const stages: OrderState[] = Object.values(ORDER_STATE).filter(isFulfillmentUnlocked);

  const where: Prisma.OrderWhereInput = {
    state: { in: stages },
    wholesalePaymentStatus: "SUCCEEDED",
  };
  if (stages.includes(state as OrderState)) where.state = state as OrderState;
  if (sellerId) where.sellerId = sellerId;

  const [orders, total, sellers, stageCounts] = await Promise.all([
    prisma.order.findMany({
      where,
      // Longest-waiting first. A queue sorted by anything else invites the newest
      // arrival to be picked up first, which is how a parcel ends up on a shelf
      // for a week while the board looks busy.
      orderBy: { stateChangedAt: "asc" },
      take: QUEUE_LIMIT,
      select: {
        id: true,
        shopifyOrderName: true,
        supplierReference: true,
        state: true,
        stateChangedAt: true,
        shippingAddress: true,
        fulfillmentStatus: true,
        shopifyFulfillmentOrderId: true,
        currency: true,
        moonvellaTotal: true,
        createdAt: true,
        seller: {
          select: {
            id: true,
            storeName: true,
            shopDomain: true,
            // The Shopify location MoonVella's fulfillment service owns for this
            // store. It is what "routed to us" means in practice, so a queue row
            // that shows a fulfillment order id and no location is telling the
            // operator the routing is incomplete.
            shopifyFulfillmentLocationId: true,
          },
        },
        // The amount and the status together: the status is what admits the row
        // to this queue and the amount is what the goods are worth to MoonVella.
        wholesalePayment: { select: { amount: true, currency: true, status: true, paidAt: true } },
        items: { select: { id: true, sku: true, name: true, quantity: true }, orderBy: { name: "asc" } },
      },
    }),
    prisma.order.count({ where }),
    prisma.seller.findMany({ select: { id: true, storeName: true }, orderBy: { storeName: "asc" } }),
    // Counted per stage for the whole queue rather than for the filtered view, so
    // the numbers on the cards mean "how many orders are in this state", which is
    // the question they are read for.
    Promise.all(
      stages.map((stage) =>
        prisma.order.count({ where: { state: stage, wholesalePaymentStatus: "SUCCEEDED" } })
      )
    ),
  ]);

  return {
    orders,
    total,
    truncated: total > orders.length,
    sellers,
    stages,
    stageCounts: stages.map((stage, index) => ({ stage, count: stageCounts[index] })),
    filters: { state, seller: sellerId },
    limit: QUEUE_LIMIT,
  };
}

export default function AdminFulfillmentQueue() {
  const { orders, total, truncated, sellers, stages, stageCounts, filters, limit } = useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>Fulfillment queue</h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1rem" }}>
        Orders the warehouse may work on: paid by the seller, and released for fulfillment. Longest-waiting first.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem", marginBottom: "1.25rem" }}>
        {stageCounts.map((entry) => (
          <div key={entry.stage} style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1rem" }}>
            <div style={{ fontSize: "0.72rem", color: "#64748b" }}>{entry.stage}</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 700, color: STATE_COLOR[entry.stage] ?? "#082a4a" }}>{entry.count}</div>
          </div>
        ))}
      </div>

      <Form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Stage
          <br />
          <select name="state" defaultValue={filters.state} style={input}>
            <option value="">All stages</option>
            {stages.map((stage) => (
              <option key={stage} value={stage}>{stage}</option>
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
        <button type="submit" style={{ padding: "0.45rem 0.85rem", border: "1px solid #082a4a", borderRadius: 6, background: "white", color: "#082a4a", fontSize: "0.72rem", fontWeight: 600, cursor: "pointer" }}>
          Filter
        </button>
        <Link to="/admin/fulfillment" style={{ fontSize: "0.72rem", color: "#64748b" }}>Clear</Link>
      </Form>

      {/* A queue that quietly stops at a limit is a queue somebody trusts and
          should not. The count is of everything the filters matched, so the note
          can say how much is not on the page. */}
      {truncated ? (
        <p style={{ fontSize: "0.75rem", color: "#b45309", marginBottom: "0.75rem" }} role="status">
          Showing the first {limit} of {total} orders waiting. Narrow the filters, or work the oldest rows and reload.
        </p>
      ) : null}

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              <th style={th}>Order</th>
              <th style={th}>Seller / store</th>
              <th style={th}>Destination</th>
              <th style={th}>Items</th>
              <th style={th}>Seller payment</th>
              <th style={th}>Shopify routing</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>
                  Nothing is waiting. An order appears here once the seller&apos;s charge has succeeded and the order has
                  been released for fulfillment.
                </td>
              </tr>
            ) : (
              orders.map((order) => (
                <tr key={order.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={td}>
                    <Link to={`/admin/orders/${order.id}`} style={{ fontWeight: 600, color: "#082a4a" }}>
                      {order.shopifyOrderName}
                    </Link>
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>{order.supplierReference}</div>
                    <div style={{ fontSize: "0.7rem", fontWeight: 600, color: STATE_COLOR[order.state] ?? "#334155" }}>
                      {order.state}
                    </div>
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                      since {new Date(order.stateChangedAt).toLocaleDateString()}
                    </div>
                  </td>
                  <td style={td}>
                    {order.seller.storeName}
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>{order.seller.shopDomain}</div>
                  </td>
                  {/* City, region and country only — see destinationSummary. */}
                  <td style={td}>{destinationSummary(order.shippingAddress)}</td>
                  <td style={td}>
                    {order.items.length === 0 ? (
                      <span style={{ color: "#b45309" }}>No lines on this order</span>
                    ) : (
                      order.items.map((item) => (
                        <div key={item.id}>
                          {item.quantity} × {item.sku}
                        </div>
                      ))
                    )}
                  </td>
                  <td style={{ ...td, color: "#059669" }}>
                    <strong>{order.wholesalePayment ? money(order.wholesalePayment.amount, order.wholesalePayment.currency) : "—"}</strong>
                    <div style={{ fontSize: "0.68rem", color: "#64748b" }}>
                      {order.wholesalePayment?.status ?? "no payment row"}
                      {order.wholesalePayment?.paidAt ? ` · ${new Date(order.wholesalePayment.paidAt).toLocaleDateString()}` : ""}
                    </div>
                  </td>
                  <td style={td}>
                    {order.shopifyFulfillmentOrderId ? (
                      <div style={{ fontSize: "0.72rem" }}>{order.shopifyFulfillmentOrderId}</div>
                    ) : (
                      <div style={{ fontSize: "0.72rem", color: "#b45309" }}>fulfillment order not resolved</div>
                    )}
                    <div style={{ fontSize: "0.68rem", color: "#64748b" }}>
                      {order.seller.shopifyFulfillmentLocationId
                        ? `MoonVella location ${order.seller.shopifyFulfillmentLocationId}`
                        : "no MoonVella location saved for this store"}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.75rem" }}>
        {total} order{total === 1 ? "" : "s"} waiting. Opening an order is where fulfilment is started, and where the
        state machine refuses it if the order has moved on since this page was read.
      </p>
    </div>
  );
}
