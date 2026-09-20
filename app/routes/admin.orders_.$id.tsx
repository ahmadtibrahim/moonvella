import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireOwnerRole, assertSameOrigin, getRequestMeta } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";
import { createOrReuseWholesalePayment, applyStripeEvent, stripeMode } from "~/services/payments.server";
import { chargeWholesaleOrder, getBillingSettings } from "~/services/sellerBilling.server";
import {
  getQuotesForOrder,
  selectQuote,
  bookShipmentForOrder,
  voidShipment,
  syncShipmentTracking,
} from "~/services/shipping.server";
import { resolveFulfillmentOrders } from "~/services/shopifyFulfillment.server";
import { maskedEshipperAccount, eshipperMode } from "~/services/eshipper.server";
import { addManualShipment, advanceShipment, type ShipmentAdvanceEvent } from "~/services/fulfillment.server";
import {
  acceptFulfillmentRequest,
  rejectFulfillmentRequest,
  closeFulfillmentRequest,
  cancelFulfillmentRequest,
} from "~/services/fulfillmentRequest.server";
import { getIntegrationState } from "~/services/integrationHealth.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireOwnerRole(request, ["OWNER", "OPERATIONS", "REVIEWER", "READONLY"]);
  const order = await prisma.order.findUnique({
    where: { id: String(params.id) },
    include: {
      seller: true,
      items: true,
      packages: true,
      shipments: { include: { items: true } },
      shippingQuotes: { orderBy: { totalAmount: "asc" } },
      wholesalePayment: {
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          subtotal: true,
          shippingAmount: true,
          taxAmount: true,
          requiresAction: true,
          failureMessage: true,
          provider: true,
          billingMode: true,
          attempts: {
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, status: true, failureMessage: true, requiresAction: true, amount: true, createdAt: true },
          },
        },
      },
      fulfillmentRequest: true,
    },
  });
  if (!order) throw new Response("Order not found", { status: 404 });
  const billing = await getBillingSettings(order.sellerId);
  const shopifyFulfillment = await getIntegrationState("shopify_fulfillment");
  return {
    order,
    mode: stripeMode(),
    shopifyFulfillment,
    eshipper: { mode: eshipperMode(), account: maskedEshipperAccount() },
    billing: {
      mode: billing.mode,
      autoPayEnabled: billing.autoPayEnabled,
      maxAmountPerOrder: billing.maxAmountPerOrder,
      maxShippingCharge: billing.maxShippingCharge,
    },
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requireOwnerRole(request, ["OWNER", "OPERATIONS"]);
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "OWNER_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const orderId = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "add_package") {
      await prisma.orderPackage.create({
        data: {
          orderId,
          count: Math.max(1, Number(form.get("count") || 1)),
          length: Number(form.get("length")),
          width: Number(form.get("width")),
          height: Number(form.get("height")),
          weight: Number(form.get("weight")),
          units: "cm_kg",
        },
      });
    } else if (intent === "get_quotes") {
      await getQuotesForOrder(orderId, actor);
    } else if (intent === "select_quote") {
      await selectQuote(orderId, String(form.get("quoteId")), actor);
    } else if (intent === "create_payment") {
      await createOrReuseWholesalePayment(orderId);
    } else if (intent === "simulate_paid") {
      const payment = await prisma.wholesalePayment.findUnique({ where: { orderId } });
      if (!payment || !String(payment.providerPaymentIntentId || "").startsWith("sim_")) {
        throw new Error("Simulated events are only allowed for simulated intents.");
      }
      await applyStripeEvent({
        id: `sim_evt_${orderId}_${Date.now()}`,
        type: "payment_intent.succeeded",
        data: { object: { id: payment.providerPaymentIntentId, metadata: { orderId } } },
      });
    } else if (intent === "manual_pay") {
      const result = await chargeWholesaleOrder(orderId, { trigger: "MANUAL", actor });
      if (!result.ok) return { error: result.error || "Manual payment failed." };
    } else if (intent === "book_shipment") {
      await bookShipmentForOrder(orderId, { quoteId: String(form.get("quoteId") || "") || undefined }, actor);
    } else if (intent === "void_shipment") {
      await voidShipment(String(form.get("shipmentId")), actor);
    } else if (intent === "retry_sync") {
      await syncShipmentTracking(String(form.get("shipmentId")), actor);
    } else if (intent === "resolve_fo") {
      await resolveFulfillmentOrders(orderId);
    } else if (intent === "manual_shipment") {
      await addManualShipment(
        orderId,
        {
          carrier: String(form.get("carrier") || ""),
          trackingNumber: String(form.get("trackingNumber") || ""),
          trackingUrl: String(form.get("trackingUrl") || "") || null,
          notifyCustomer: form.get("notifyCustomer") === "on",
        },
        actor
      );
    } else if (intent === "advance_shipment") {
      const event = String(form.get("event") || "");
      const allowed: ShipmentAdvanceEvent[] = [
        "packed",
        "handed_to_carrier",
        "shipped",
        "in_transit",
        "delivered",
        "exception",
      ];
      if (!allowed.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      await advanceShipment(String(form.get("shipmentId")), event as ShipmentAdvanceEvent, actor, {
        notifyCustomer: form.get("notifyCustomer") === "on",
      });
    } else if (intent === "accept_fr") {
      await acceptFulfillmentRequest(orderId, actor);
    } else if (intent === "reject_fr") {
      await rejectFulfillmentRequest(orderId, String(form.get("reason") || ""), actor);
    } else if (intent === "close_fr") {
      await closeFulfillmentRequest(orderId, actor);
    } else if (intent === "cancel_fr") {
      await cancelFulfillmentRequest(orderId, String(form.get("reason") || ""), actor);
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect(`/admin/orders/${orderId}`);
}

const card: React.CSSProperties = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" };
const input: React.CSSProperties = { padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.82rem", boxSizing: "border-box" };
const btn = (color: string): React.CSSProperties => ({ padding: "0.45rem 0.85rem", border: `1px solid ${color}`, borderRadius: 6, background: "white", color, fontSize: "0.72rem", fontWeight: 600, cursor: "pointer" });
const th: React.CSSProperties = { padding: "0.4rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export default function AdminOrderDetail() {
  const { order, mode, eshipper, billing, shopifyFulfillment } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const paid = order.wholesalePaymentStatus === "SUCCEEDED";
  const selectedQuote = order.shippingQuotes.find((q) => q.selected) ?? null;
  const cheapest = order.shippingQuotes[0] ?? null;
  const fastest = order.shippingQuotes.filter((q) => q.transitDays !== null).sort((a, b) => (a.transitDays! - b.transitDays!))[0] ?? null;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/orders" style={{ color: "#082a4a" }}>&larr; All orders</Link>
      </p>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>{order.shopifyOrderName}</h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        Seller: {order.seller.storeName} · {order.supplierReference}
      </p>
      <p style={{ marginBottom: "1.5rem" }}>
        <Link to={`/admin/packing/${order.id}`} className="mv-btn mv-btn-primary" style={{ display: "inline-block", padding: "0.45rem 0.9rem", background: "#082a4a", color: "white", borderRadius: 6, fontSize: "0.78rem", fontWeight: 600, textDecoration: "none" }}>
          Pack order
        </Link>
      </p>

      {actionData?.error ? <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>{actionData.error}</div> : null}

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Order</h2>
        <div style={{ fontSize: "0.85rem", lineHeight: 1.7 }}>
          <div>Retail customer: {order.customerName || "—"} ({order.customerEmail || "—"})</div>
          <div>Customer payment (seller&apos;s Shopify): <strong>{order.paymentStatus}</strong></div>
          <div>Wholesale payment to MoonVella: <strong style={{ color: paid ? "#059669" : "#b45309" }}>{order.wholesalePaymentStatus}</strong></div>
          <div>MoonVella total: <strong>{money(order.moonvellaTotal, order.currency)}</strong></div>
          <div>Fulfillment: {order.fulfillmentStatus}</div>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
          <thead><tr><th style={th}>Item</th><th style={th}>SKU</th><th style={th}>Qty</th><th style={th}>Retail</th><th style={th}>Wholesale</th></tr></thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id} style={{ borderTop: "1px solid #f1f5f9", fontSize: "0.8rem" }}>
                <td style={{ padding: "0.4rem" }}>{i.name}</td>
                <td style={{ padding: "0.4rem", color: "#64748b" }}>{i.sku}</td>
                <td style={{ padding: "0.4rem" }}>{i.quantity}</td>
                <td style={{ padding: "0.4rem" }}>{money(i.price, order.currency)}</td>
                <td style={{ padding: "0.4rem" }}>{money(i.wholesalePrice, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Fulfillment request</h2>
        {order.fulfillmentRequest ? (
          <div style={{ fontSize: "0.82rem", lineHeight: 1.7 }}>
            <div>Status: <strong>{order.fulfillmentRequest.status}</strong></div>
            <div>Requested: {new Date(order.fulfillmentRequest.requestedAt).toLocaleString()}</div>
            {order.fulfillmentRequest.acceptedAt ? <div>Accepted: {new Date(order.fulfillmentRequest.acceptedAt).toLocaleString()}</div> : null}
            {order.fulfillmentRequest.rejectedAt ? (
              <div>
                Rejected: {new Date(order.fulfillmentRequest.rejectedAt).toLocaleString()}
                {order.fulfillmentRequest.rejectReason ? ` — ${order.fulfillmentRequest.rejectReason}` : ""}
              </div>
            ) : null}
            {order.fulfillmentRequest.closedAt ? <div>Closed: {new Date(order.fulfillmentRequest.closedAt).toLocaleString()}</div> : null}
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem", alignItems: "flex-end" }}>
              {order.fulfillmentRequest.status === "PENDING" ? (
                <>
                  <Form method="post"><button type="submit" name="intent" value="accept_fr" style={btn("#059669")}>Accept</button></Form>
                  <Form method="post" style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                    <input type="hidden" name="intent" value="reject_fr" />
                    <input style={input} name="reason" placeholder="Rejection reason" required />
                    <button type="submit" style={btn("#dc2626")}>Reject</button>
                  </Form>
                </>
              ) : null}
              {order.fulfillmentRequest.status === "ACCEPTED" ? (
                <Form method="post"><button type="submit" name="intent" value="close_fr" style={btn("#0369a1")}>Close</button></Form>
              ) : null}
              {order.fulfillmentRequest.status === "PENDING" || order.fulfillmentRequest.status === "ACCEPTED" ? (
                <Form method="post" style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                  <input type="hidden" name="intent" value="cancel_fr" />
                  <input style={input} name="reason" placeholder="Cancellation reason" />
                  <button type="submit" style={btn("#64748b")}>Cancel</button>
                </Form>
              ) : null}
            </div>
          </div>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No fulfillment request on this order.</p>
        )}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Wholesale payment</h2>
        <p style={{ fontSize: "0.82rem", color: "#64748b", marginBottom: "0.5rem" }}>
          Provider mode: {mode === "real" ? "Stripe test" : "simulated (no key)"} · Billing mode: {billing.mode}
          {billing.autoPayEnabled ? " (auto-enabled)" : ""}
        </p>
        {order.wholesalePayment?.attempts?.length ? (
          <div style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
            {order.wholesalePayment.attempts.map((a) => (
              <div key={a.id} style={{ color: a.status === "FAILED" ? "#dc2626" : a.requiresAction ? "#b45309" : "#64748b" }}>
                {a.status}{a.requiresAction ? " (action required)" : ""} {a.failureMessage || ""}
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Form method="post"><button type="submit" name="intent" value="create_payment" style={btn("#0369a1")}>Create invoice</button></Form>
          <Form method="post"><button type="submit" name="intent" value="manual_pay" style={btn("#082a4a")}>Pay this order (manual)</button></Form>
          {mode === "simulated" && !paid && (
            <Form method="post"><button type="submit" name="intent" value="simulate_paid" style={btn("#059669")}>Simulate payment success (test)</button></Form>
          )}
        </div>
        {mode === "simulated" && <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.4rem" }}>Simulated mode — not a real charge.</p>}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Packages</h2>
        {order.packages.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>Add package dimensions and weight before quoting.</p>
        ) : (
          <ul style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            {order.packages.map((p) => (
              <li key={p.id}>{p.count} × {p.length}×{p.width}×{p.height} cm, {p.weight} kg</li>
            ))}
          </ul>
        )}
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="add_package" />
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Count<br /><input style={input} name="count" type="number" defaultValue={1} min={1} /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>L (cm)<br /><input style={input} name="length" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>W (cm)<br /><input style={input} name="width" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>H (cm)<br /><input style={input} name="height" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Weight (kg)<br /><input style={input} name="weight" type="number" step="0.01" required /></label>
          <button type="submit" style={btn("#0369a1")}>Add package</button>
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Shipping quotes</h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem" }}>
          eShipper: {eshipper.mode}{eshipper.account ? ` · account ${eshipper.account}` : ""}
        </p>
        <Form method="post" style={{ marginBottom: "0.75rem" }}>
          <button type="submit" name="intent" value="get_quotes" style={btn("#0369a1")}>Get shipping quotes</button>
        </Form>
        {order.shippingQuotes.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No quotes yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr><th style={th}>Carrier</th><th style={th}>Service</th><th style={th}>Cost</th><th style={th}>Transit</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {order.shippingQuotes.map((q) => (
                <tr key={q.id} style={{ borderTop: "1px solid #f1f5f9", background: q.selected ? "#f0fdf4" : undefined }}>
                  <td style={{ padding: "0.4rem" }}>{q.carrier}</td>
                  <td style={{ padding: "0.4rem" }}>
                    {q.serviceName}
                    {cheapest?.id === q.id ? " · lowest cost" : ""}
                    {fastest?.id === q.id ? " · fastest (est.)" : ""}
                  </td>
                  <td style={{ padding: "0.4rem" }}>{money(q.totalAmount, q.currency)}</td>
                  <td style={{ padding: "0.4rem" }}>{q.transitDays === null ? "Estimate unavailable" : `${q.transitDays} day(s)`}</td>
                  <td style={{ padding: "0.4rem" }}>
                    <Form method="post"><input type="hidden" name="intent" value="select_quote" /><input type="hidden" name="quoteId" value={q.id} /><button type="submit" style={btn("#082a4a")}>Select</button></Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <Form method="post"><button type="submit" name="intent" value="book_shipment" disabled={!paid} style={btn(paid ? "#059669" : "#94a3b8")}>Book shipment{selectedQuote ? ` (${selectedQuote.carrier})` : ""}</button></Form>
        </div>
        {!paid && <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.4rem" }}>Booking is blocked until the wholesale payment succeeds.</p>}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Shipments &amp; tracking</h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.25rem" }}>
          Shopify fulfillment order: {order.shopifyFulfillmentOrderId || "not resolved"}
        </p>
        <p
          style={{
            fontSize: "0.72rem",
            marginBottom: "0.5rem",
            color: shopifyFulfillment.status === "HEALTHY" ? "#059669" : shopifyFulfillment.status === "FAILED" ? "#dc2626" : "#b45309",
          }}
        >
          Shopify fulfillment sync: {shopifyFulfillment.status}
          {shopifyFulfillment.detail ? ` — ${shopifyFulfillment.detail}` : ""}
        </p>
        <Form method="post" style={{ marginBottom: "0.75rem" }}>
          <button type="submit" name="intent" value="resolve_fo" style={btn("#0369a1")}>Resolve Shopify fulfillment order</button>
        </Form>

        <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, padding: "0.6rem", marginBottom: "0.75rem" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.4rem" }}>Add manual shipment / tracking</div>
          <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <input type="hidden" name="intent" value="manual_shipment" />
            <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Carrier<br /><input style={input} name="carrier" required /></label>
            <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Tracking number<br /><input style={input} name="trackingNumber" required /></label>
            <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Tracking URL (optional)<br /><input style={input} name="trackingUrl" /></label>
            <label style={{ fontSize: "0.72rem", color: "#64748b", display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <input type="checkbox" name="notifyCustomer" /> Notify customer
            </label>
            <button type="submit" disabled={!paid} style={btn(paid ? "#059669" : "#94a3b8")}>Create shipment</button>
          </Form>
          {!paid ? <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.3rem" }}>Fulfillment is held until the wholesale payment succeeds.</p> : null}
        </div>

        {order.shipments.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No shipments booked.</p>
        ) : (
          order.shipments.map((s) => (
            <div key={s.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem", marginBottom: "0.5rem", fontSize: "0.8rem" }}>
              <div><strong>{s.carrier}</strong> {s.serviceName} · {s.status} · {s.trackingNumber || "no tracking"}</div>
              <div style={{ color: "#64748b" }}>
                booked cost {s.bookedCost != null ? money(s.bookedCost) : "—"}
                {s.shopifyFulfillmentId ? ` · Shopify fulfillment ${s.shopifyFulfillmentId}` : ""}
              </div>
              <div style={{ color: "#94a3b8", fontSize: "0.7rem" }}>
                packed {s.packedAt ? new Date(s.packedAt).toLocaleDateString() : "—"} · shipped {s.shippedAt ? new Date(s.shippedAt).toLocaleDateString() : "—"} · in transit {s.inTransitAt ? new Date(s.inTransitAt).toLocaleDateString() : "—"} · delivered {s.deliveredAt ? new Date(s.deliveredAt).toLocaleDateString() : "—"}
              </div>
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
                {s.labelUrl && <a href={s.labelUrl} target="_blank" rel="noreferrer" style={btn("#0369a1")}>Label</a>}
                {s.trackingUrl && <a href={s.trackingUrl} target="_blank" rel="noreferrer" style={btn("#64748b")}>Tracking</a>}
                <Form method="post"><input type="hidden" name="intent" value="retry_sync" /><input type="hidden" name="shipmentId" value={s.id} /><button type="submit" style={btn("#082a4a")}>Retry Shopify sync</button></Form>
                <Form method="post"><input type="hidden" name="intent" value="void_shipment" /><input type="hidden" name="shipmentId" value={s.id} /><button type="submit" style={btn("#dc2626")}>Void/cancel</button></Form>
              </div>
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: "0.68rem", color: "#64748b" }}>Advance:</span>
                {(["packed", "handed_to_carrier", "shipped", "in_transit", "delivered", "exception"] as ShipmentAdvanceEvent[]).map((ev) => (
                  <Form method="post" key={ev}>
                    <input type="hidden" name="intent" value="advance_shipment" />
                    <input type="hidden" name="shipmentId" value={s.id} />
                    <input type="hidden" name="event" value={ev} />
                    <button type="submit" style={btn(ev === "exception" ? "#dc2626" : ev === "delivered" ? "#059669" : "#0369a1")}>{ev.replace(/_/g, " ")}</button>
                  </Form>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
