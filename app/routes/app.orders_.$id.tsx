/**
 * One order, for the seller who sold it.
 *
 * WHY A PAGE AND NOT AN EXPANDED ROW. The list shows a dozen orders; this page
 * shows one order's whole story — what was bought, where it is going, what was
 * charged, what the carrier is doing, what the invoice says, and what the seller
 * can do next. Those do not fit a row, and the list stops being scannable the
 * moment somebody tries.
 *
 * EVERYTHING HERE IS SCOPED TO THE SELLER. The order is read with
 * `sellerId: context.seller.id` in the WHERE, so an id from another store is not
 * a 403 — it is a 404, and the difference is not disclosed. The action resolves
 * the order through the seller again before charging, because a charge endpoint
 * that trusts an id from a form lets any store charge another's card.
 *
 * WHAT IS NOT SHOWN, ON PURPOSE. No payment-intent id, no Shopify GID, no
 * webhook payload, no provider exception text, no wholesale cost of goods. The
 * seller is told what they owe and what has happened to it — not how MoonVella's
 * machinery is wired.
 */

import React from "react";
import { Link, Form, useLoaderData, useActionData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { prisma } from "../db.server";
import { withMerchantAccess } from "../services/seller.server";
import { chargeSellerForOrder, safeFailureReason } from "../services/sellerCharge.server";
import { shopifyAdminAppUrl } from "../services/shopifyNavigation.server";
import {
  destinationOf,
  sellerPaymentStory,
  sellerFulfillmentStory,
  SHIPMENT_LABEL,
} from "../services/sellerOrderView.server";
import { formatDate } from "../utils/dates";
import { money } from "../utils/money";

export const loader = async ({ request, params }: LoaderFunctionArgs) =>
  withMerchantAccess(request, "VIEW", async (context) => {
    if (!context.seller) throw new Response("Not found", { status: 404 });
    const order = await prisma.order.findFirst({
      where: { id: String(params.id), sellerId: context.seller.id },
      include: {
        items: true,
        wholesalePayment: true,
        shipments: { include: { trackingEvents: { orderBy: { eventAt: "desc" }, take: 10 } }, orderBy: { createdAt: "asc" } },
        invoice: { include: { credits: { orderBy: { issuedAt: "asc" } } } },
        cancellation: true,
      },
    });
    // A 404 rather than a 403: an order id belonging to another store must not be
    // distinguishable from one that does not exist.
    if (!order) throw new Response("Not found", { status: 404 });

    const method = await prisma.sellerPaymentMethod.findFirst({
      where: { sellerId: context.seller.id, isDefault: true },
      select: { brand: true, last4: true },
    });

    return {
      canAct: context.access === "APPROVED",
      order: {
        id: order.id,
        name: order.shopifyOrderName || `#${order.shopifyOrderNumber}`,
        placedAt: order.shopifyCreatedAt.toISOString(),
        destination: destinationOf(order.shippingAddress),
        customer: order.customerName || null,
        currency: order.currency,
        lines: order.items.map((item) => ({
          id: item.id,
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          unit: item.wholesalePrice,
          line: item.wholesalePrice * item.quantity,
        })),
        subtotal: order.moonvellaSubtotal,
        shippingIncluded: true,
        tax: order.moonvellaTax,
        total: order.moonvellaTotal,
        charge: order.wholesalePayment
          ? {
              amount: order.wholesalePayment.amount,
              currency: order.wholesalePayment.currency,
              status: order.wholesalePayment.status,
              capturedAt: order.wholesalePayment.capturedAt?.toISOString() ?? null,
            }
          : null,
        payment: sellerPaymentStory({
          state: order.state,
          paymentStatus: order.wholesalePayment?.status ?? null,
          customerPaymentStatus: order.paymentStatus,
          failureReason: order.wholesalePayment?.failureMessage
            ? safeFailureReason(order.wholesalePayment.failureMessage)
            : null,
          hasMethod: Boolean(method),
        }),
        fulfillment: sellerFulfillmentStory({ state: order.state, status: order.fulfillmentStatus }),
        shipments: order.shipments.map((shipment) => ({
          id: shipment.id,
          status: shipment.status,
          label: SHIPMENT_LABEL[shipment.status] ?? shipment.status,
          carrier: shipment.carrier,
          service: shipment.serviceName,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          events: shipment.trackingEvents.map((event) => ({
            at: event.eventAt.toISOString(),
            description: event.description ?? event.statusText ?? "Carrier update",
            location: event.location ?? null,
          })),
        })),
        invoice: order.invoice
          ? {
              number: order.invoice.number,
              status: order.invoice.status,
              total: order.invoice.total,
              currency: order.invoice.currency,
              credits: order.invoice.credits.map((credit) => ({
                number: credit.number,
                amount: credit.amount,
                reason: credit.reason,
                issuedAt: credit.issuedAt.toISOString(),
              })),
            }
          : null,
        cancellation: order.cancellation
          ? {
              status: order.cancellation.status,
              reason: order.cancellation.reason,
              requestedAt: order.cancellation.requestedAt.toISOString(),
              paymentOutcome: order.cancellation.paymentOutcome,
              lastError: order.cancellation.lastError,
            }
          : null,
        card: method ? { brand: method.brand, last4: method.last4 } : null,
      },
    };
  });

export const action = async ({ request, params }: ActionFunctionArgs) =>
  withMerchantAccess(request, "BUSINESS", async (context) => {
    if (!context.seller) return { ok: false, error: "We could not find your store." };
    const form = await request.formData();
    if (String(form.get("intent") || "") !== "pay_now") {
      return { ok: false, error: "Unknown action.", sentence: "" };
    }
    // Resolved through the seller BEFORE the charge is asked for — see the
    // header. An id that is not this seller's matches no row.
    const owned = await prisma.order.findFirst({
      where: { id: String(params.id), sellerId: context.seller.id },
      select: { id: true },
    });
    if (!owned) return { ok: false, error: "We could not find that order in your store.", sentence: "" };

    const outcome = await chargeSellerForOrder({
      orderId: owned.id,
      trigger: "MANUAL",
      actor: { actorType: "MERCHANT", actorId: context.seller.id, actorName: context.seller.storeName },
      // A retry must be a second attempt rather than the stored refusal replayed.
      retry: true,
      setupReturnUrl: shopifyAdminAppUrl(context.shop, `/app/orders/${owned.id}`, request),
    });

    return {
      ok: outcome.ok,
      requiresPaymentMethod: outcome.requiresPaymentMethod ?? false,
      requiresAction: outcome.requiresAction ?? false,
      sentence: outcome.ok
        ? "Payment received. MoonVella will begin fulfilment."
        : outcome.requiresPaymentMethod
          ? "Add a payment method in Billing, then pay this order."
          : outcome.requiresAction
            ? "Your bank asked you to confirm this payment. Complete the verification they sent you, then try again."
            : "The payment could not be completed. You can try again.",
    };
  });

const card: React.CSSProperties = {
  background: "#FFFFFF",
  border: "1px solid #DCE3EB",
  borderRadius: 12,
  padding: "1.1rem 1.25rem",
  marginBottom: "1rem",
};

const h2: React.CSSProperties = { fontSize: "0.95rem", fontWeight: 600, color: "#172B4D", margin: "0 0 0.6rem" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.2rem 0", fontSize: "0.84rem" };
const key: React.CSSProperties = { color: "#52627A" };
const toneClass: Record<string, string> = {
  paid: "mv-badge mv-badge-success",
  pending: "mv-badge mv-badge-warning",
  processing: "mv-badge mv-badge-brand",
  failed: "mv-badge mv-badge-danger",
  cancelled: "",
};

export default function SellerOrderDetail() {
  const { order, canAct } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <p style={{ margin: "0 0 0.35rem", fontSize: "0.8rem" }}>
        <Link to="/app/orders">← All orders</Link>
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.25rem" }}>
        <h1 style={{ fontSize: 28, margin: 0, color: "#172B4D" }}>{order.name}</h1>
        <span className={toneClass[order.payment.tone]}>{order.payment.label}</span>
      </div>
      <p style={{ color: "#52627A", fontSize: "0.85rem", marginTop: 0 }}>
        Placed {formatDate(new Date(order.placedAt))}
        {order.customer ? ` · ${order.customer}` : ""} · {order.destination}
      </p>

      {actionData && actionData.error ? (
        <div role="alert" style={{ ...card, background: "#FEE2E2", borderColor: "#fecaca", color: "#B91C1C" }}>{actionData.error}</div>
      ) : null}
      {actionData && actionData.sentence ? (
        <div role="status" style={{ ...card, background: actionData.ok ? "#DCFCE7" : "#FEF3C7", borderColor: actionData.ok ? "#bbf7d0" : "#fcd34d", color: actionData.ok ? "#166534" : "#92400E" }}>
          {actionData.sentence}
        </div>
      ) : null}

      <section style={card}>
        <h2 style={h2}>Payment</h2>
        <p style={{ fontSize: "0.84rem", color: "#334155", marginTop: 0 }}>{order.payment.sentence}</p>
        {order.charge ? (
          <div style={{ marginTop: "0.5rem" }}>
            <div style={row}><span style={key}>Amount</span><span>{money(order.charge.amount, order.charge.currency)}</span></div>
            {order.card ? (
              <div style={row}>
                <span style={key}>Saved method</span>
                <span>{(order.card.brand || "card").toUpperCase()} •••• {order.card.last4}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
          {canAct && order.payment.action === "pay" ? (
            <Form method="post">
              <input type="hidden" name="intent" value="pay_now" />
              <button type="submit" className="mv-button mv-button-primary" disabled={busy}>
                {busy ? "Paying…" : "Pay now"}
              </button>
            </Form>
          ) : null}
          {canAct && order.payment.action === "retry" ? (
            <Form method="post">
              <input type="hidden" name="intent" value="pay_now" />
              <button type="submit" className="mv-button mv-button-primary" disabled={busy}>
                {busy ? "Trying…" : "Try the payment again"}
              </button>
            </Form>
          ) : null}
          {order.payment.action === "setup" ? (
            <Link to="/app/billing" className="mv-button">Add a payment method</Link>
          ) : null}
          <Link to="/app/billing" className="mv-button">Billing &amp; payment methods</Link>
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>MoonVella products</h2>
        <div className="mv-table-wrap">
          <table className="mv-table" style={{ width: "100%" }}>
            <thead>
              <tr><th>Item</th><th>SKU</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Partner price</th><th style={{ textAlign: "right" }}>Line</th></tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.name}</td>
                  <td className="mv-mono" style={{ color: "#52627A" }}>{line.sku}</td>
                  <td style={{ textAlign: "right" }}>{line.quantity}</td>
                  <td style={{ textAlign: "right" }}>{money(line.unit, order.currency)}</td>
                  <td style={{ textAlign: "right" }}>{money(line.line, order.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: "0.7rem", fontSize: "0.84rem" }}>
          <div style={row}><span style={key}>Subtotal</span><span>{money(order.subtotal, order.currency)}</span></div>
          {/* NOT "$0.00 shipping". Shipping is inside the partner price, and a
              zero row reads as a charge that was forgotten. */}
          <div style={row}><span style={key}>Shipping</span><span>Standard shipping included</span></div>
          {order.tax ? <div style={row}><span style={key}>Tax</span><span>{money(order.tax, order.currency)}</span></div> : null}
          <div style={{ ...row, borderTop: "1px solid #DCE3EB", marginTop: "0.3rem", paddingTop: "0.35rem", fontWeight: 700 }}>
            <span>Total payable to MoonVella</span><span>{money(order.total, order.currency)}</span>
          </div>
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>Delivery &amp; fulfilment</h2>
        <div style={row}><span style={key}>Destination</span><span>{order.destination}</span></div>
        <div style={row}><span style={key}>Fulfilment</span><span>{order.fulfillment.label}</span></div>
        <p style={{ fontSize: "0.8rem", color: "#52627A", marginBottom: 0 }}>{order.fulfillment.sentence}</p>

        {order.shipments.length === 0 ? (
          <p style={{ fontSize: "0.8rem", color: "#52627A", marginTop: "0.7rem", marginBottom: 0 }}>
            No parcel has been prepared for this order yet. MoonVella prepares the shipment once the wholesale payment clears.
          </p>
        ) : (
          <div style={{ marginTop: "0.7rem" }}>
            {order.shipments.map((shipment) => (
              <div key={shipment.id} style={{ borderTop: "1px solid #DCE3EB", paddingTop: "0.5rem", marginTop: "0.5rem" }}>
                <div style={row}>
                  <span style={key}>{shipment.carrier ? `${shipment.carrier} ${shipment.service ?? ""}`.trim() : "Carrier"}</span>
                  <span>{shipment.label}</span>
                </div>
                {shipment.trackingNumber ? (
                  <div style={row}>
                    <span style={key}>Tracking</span>
                    <span>
                      <span className="mv-mono">{shipment.trackingNumber}</span>{" "}
                      {shipment.trackingUrl ? (
                        <a href={shipment.trackingUrl} target="_blank" rel="noreferrer">Track</a>
                      ) : null}
                    </span>
                  </div>
                ) : null}
                {shipment.events.length > 0 ? (
                  <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.78rem", color: "#52627A" }}>
                    {shipment.events.map((event, index) => (
                      <li key={index}>
                        {formatDate(new Date(event.at))} — {event.description}
                        {event.location ? `, ${event.location}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={card}>
        <h2 style={h2}>Invoice &amp; credits</h2>
        {order.invoice ? (
          <>
            <div style={row}><span style={key}>Invoice</span><span className="mv-mono">{order.invoice.number}</span></div>
            <div style={row}><span style={key}>Status</span><span>{order.invoice.status.replace(/_/g, " ").toLowerCase()}</span></div>
            <div style={row}><span style={key}>Total</span><span>{money(order.invoice.total, order.invoice.currency)}</span></div>
            {order.invoice.credits.length > 0 ? (
              <div style={{ marginTop: "0.5rem" }}>
                {order.invoice.credits.map((credit) => (
                  <div key={credit.number} style={row}>
                    <span style={key}>
                      Credit <span className="mv-mono">{credit.number}</span>
                      <span style={{ display: "block", fontSize: "0.72rem" }}>{credit.reason}</span>
                    </span>
                    <span>{money(credit.amount, order.invoice!.currency)}</span>
                  </div>
                ))}
                <p style={{ fontSize: "0.75rem", color: "#52627A", marginBottom: 0 }}>
                  A credit reduces what you owe. It is not a refund — a refund returns money to your card, and the two are shown separately.
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <p style={{ fontSize: "0.8rem", color: "#52627A", margin: 0 }}>No invoice has been issued for this order yet.</p>
        )}
      </section>

      {order.cancellation ? (
        <section style={card}>
          <h2 style={h2}>Cancellation</h2>
          <div style={row}><span style={key}>Status</span><span>{order.cancellation.status}</span></div>
          <div style={row}><span style={key}>Reason</span><span>{order.cancellation.reason.replace(/_/g, " ").toLowerCase()}</span></div>
          <div style={row}><span style={key}>Requested</span><span>{formatDate(new Date(order.cancellation.requestedAt))}</span></div>
          {/* The refund state is shown separately from the cancellation, because
              a cancelled order with a pending refund is not a refunded order. */}
          <div style={row}><span style={key}>Refund</span><span>{order.cancellation.paymentOutcome.toLowerCase()}</span></div>
          {order.cancellation.lastError ? (
            <p style={{ fontSize: "0.78rem", color: "#B91C1C", marginBottom: 0 }}>{order.cancellation.lastError}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
