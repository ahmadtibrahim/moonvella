import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
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
import {
  addManualShipment,
  addOrderPackage,
  advanceShipment,
  type ShipmentAdvanceEvent,
} from "~/services/fulfillment.server";
import {
  acceptFulfillmentRequest,
  rejectFulfillmentRequest,
  closeFulfillmentRequest,
  cancelFulfillmentRequest,
} from "~/services/fulfillmentRequest.server";
import { getIntegrationState } from "~/services/integrationHealth.server";
import { groupOrderLinesByOrigin } from "~/services/origins.server";
import {
  addressStatus,
  loadSubjectAddress,
  recordAddressOverride,
  recordValidation,
  validateAddress,
} from "~/services/addressValidation.server";
import { AddressGateCard } from "~/components/AddressGateCard";
import { addressSubject, addressSubjectLabel } from "~/utils/addressSubject";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requirePermission(request, "orders.view");
  const order = await prisma.order.findUnique({
    where: { id: String(params.id) },
    include: {
      seller: true,
      items: true,
      packages: true,
      // The dock is read with both: a shipment's card has to say where it was
      // collected from, and a quote is only valid for the dock it was priced
      // from — §1's rule that a quote, a booking and a collection are the same
      // question asked three times.
      shipments: { include: { items: true, originLocation: { select: { code: true, name: true } } } },
      shippingQuotes: { orderBy: { totalAmount: "asc" }, include: { originLocation: { select: { code: true, name: true } } } },
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

  /*
   * Which dock each line leaves from, resolved here so the page can SHOW the
   * split rather than let an operator discover it at the first booking refusal.
   *
   * §1 makes an order whose items come from two docks into two shipments, each
   * quoted and booked independently. Nothing about that is visible from the
   * order's own columns, so without this the second parcel is found only when
   * somebody asks why half the order has no label. A line with no resolvable
   * origin becomes its own group with `ready: false`, which is also how §1's
   * "Pickup location required, and booking is blocked" reaches this page.
   */
  const grouping = await groupOrderLinesByOrigin(
    order.items.map((item) => ({
      orderItemId: item.id,
      variantId: item.variantId,
      sku: item.sku,
      quantity: item.quantity,
    }))
  );

  /*
   * The addresses this order's labels will carry, with their verdicts. Read
   * here rather than in the component for the same reason the gate is: the page
   * must not draw a Book button it already knows will be refused, and the
   * delivery end belongs to the order while each pickup end belongs to a dock —
   * an order shipping from two docks has two of them and both have to be
   * accepted.
   */
  const collectionGroups = await Promise.all(
    grouping.groups.map(async (group) => ({
      key: group.key,
      ready: group.ready,
      reason: group.reason,
      code: group.location?.code ?? null,
      name: group.location?.name ?? null,
      lines: group.lines.length,
      quantity: group.lines.reduce((sum, line) => sum + line.quantity, 0),
      skus: [...new Set(group.lines.map((line) => line.sku))],
      locationId: group.location?.id ?? null,
      addressGate: group.location ? await addressStatus("PICKUP", group.location.id) : null,
    }))
  );

  return {
    order,
    collection: {
      split: grouping.split,
      blockers: grouping.blockers,
      groups: collectionGroups,
      deliveryGate: await addressStatus("DELIVERY", order.id),
    },
    mode: await stripeMode(),
    shopifyFulfillment,
    /*
     * Only the override control is gated on this, and the gate is drawn from it
     * for the same reason the shipment page draws it: an owner who is not told
     * they are the only one who can clear a refusal phones someone. The rule
     * itself is enforced in the service against the stored role, so a forged
     * form is refused whatever this flag says.
     */
    isOwner: user.role === "OWNER",
    eshipper: { mode: await eshipperMode(), account: await maskedEshipperAccount() },
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
  const user = await requirePermission(request, "orders.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const orderId = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "add_package") {
      // Through the shared helper, which audits the change and withdraws the
      // quotes the change invalidated.
      await addOrderPackage(
        orderId,
        {
          count: Math.max(1, Number(form.get("count") || 1)),
          length: Number(form.get("length")),
          width: Number(form.get("width")),
          height: Number(form.get("height")),
          weight: Number(form.get("weight")),
        },
        actor
      );
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
    } else if (intent === "check_address") {
      // The same two intents the shipment page carries, on the screen where an
      // order is booked whole. A refusal names an address, so the address has to
      // be fixable where the refusal is read.
      const subject = addressSubject(form);
      const address = await loadSubjectAddress(subject.type, subject.id);
      if (!address) throw new Error("That address could not be found.");
      const outcome = await validateAddress(address, { refresh: true });
      await recordValidation({ subjectType: subject.type, subjectId: subject.id, outcome });
      if (outcome.verdict === "ACCEPTED") return redirect(`/admin/orders/${orderId}`);
      return {
        error: `${addressSubjectLabel(subject.type)}: ${
          outcome.reason ?? "the address needs review before it can be booked against."
        }`,
      };
    } else if (intent === "override_address") {
      // The role check that matters is in the service, against the stored
      // account: a role posted by this form would be a role the submitter chose.
      const subject = addressSubject(form);
      const result = await recordAddressOverride({
        subjectType: subject.type,
        subjectId: subject.id,
        actorId: user.id,
        reason: String(form.get("reason") || ""),
      });
      if (!result.ok) return { error: result.error };
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

/**
 * The provider mode is one of disabled | simulated | test | live. It used to be
 * a boolean-ish "real | simulated" that rendered as "Stripe test" whatever the
 * key was, which would have said "test" over a live key. Naming all four states
 * is the point of the mode.
 */
const STRIPE_MODE_LABEL: Record<string, string> = {
  test: "Stripe test (sandbox)",
  live: "Stripe LIVE",
  simulated: "simulated (no provider calls)",
  disabled: "disabled (Disconnect)",
};

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export default function AdminOrderDetail() {
  const { order, collection, mode, eshipper, billing, shopifyFulfillment, isOwner } = useLoaderData<typeof loader>();
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
          Provider mode: {STRIPE_MODE_LABEL[mode] ?? mode} · Billing mode: {billing.mode}
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
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>
          Collection{collection.groups.length > 1 ? ` — ${collection.groups.length} docks` : ""}
        </h2>
        {/*
          §1's split, on the page where it is decided. An order whose items come
          from two docks is two shipments, quoted and booked separately, and the
          operator has to be able to see that BEFORE booking the first half —
          otherwise the second half looks like an order that silently failed.
        */}
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem" }}>
          Each line leaves from the dock its product is mapped to in Odoo. An order containing more than one dock becomes one
          shipment per dock, each quoted and booked independently; the split does not add a charge of its own.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
          <thead>
            <tr><th style={th}>Dock</th><th style={th}>Lines</th><th style={th}>Units</th><th style={th}>Items</th><th style={th}>Ready</th></tr>
          </thead>
          <tbody>
            {collection.groups.map((group) => (
              <tr key={group.key} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "0.4rem" }}>
                  {group.code ? (
                    <>
                      <strong>{group.code}</strong>
                      <div style={{ color: "#94a3b8", fontSize: "0.7rem" }}>{group.name}</div>
                    </>
                  ) : (
                    <span style={{ color: "#b45309" }}>Pickup location required</span>
                  )}
                </td>
                <td style={{ padding: "0.4rem" }}>{group.lines}</td>
                <td style={{ padding: "0.4rem" }}>{group.quantity}</td>
                <td style={{ padding: "0.4rem", color: "#64748b" }}>{group.skus.join(", ")}</td>
                <td style={{ padding: "0.4rem", color: group.ready ? "#059669" : "#dc2626" }}>
                  {group.ready ? "Yes" : "No"}
                  {!group.ready && group.reason ? (
                    <div style={{ color: "#b45309", fontSize: "0.7rem" }}>{group.reason}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {collection.blockers.length > 0 ? (
          <p style={{ fontSize: "0.75rem", color: "#b45309", marginTop: "0.5rem" }} role="status">
            Booking is blocked for {collection.blockers.length === 1 ? "one dock" : `${collection.blockers.length} docks`} until the
            origin mapping is complete. No global address is substituted.
          </p>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Addresses on this label</h2>
        {/*
          * Every dock this order ships from, then the destination. Both ends,
          * because the booking refuses on either: a page that showed only the
          * customer's address would leave an operator reading "Pickup address —
          * Validation unavailable" with nothing on the screen to press.
          */}
        <p style={{ fontSize: "0.72rem", color: "#64748b", margin: "0 0 0.2rem" }}>
          Booking needs every address below accepted. A check that could not be performed is not an
          acceptance: it blocks the booking the same way a rejected address does.
        </p>
        {collection.groups.map((group) =>
          group.addressGate && group.locationId ? (
            <AddressGateCard
              key={group.key}
              title={`Pickup address — ${group.code ?? group.name ?? "dock"}`}
              subjectType="PICKUP"
              subjectId={group.locationId}
              status={group.addressGate}
              isOwner={isOwner}
              editHref="/admin/origins"
              editLabel="Edit this location's address"
            />
          ) : (
            <p key={group.key} style={{ fontSize: "0.78rem", color: "#b45309", marginTop: "0.8rem" }}>
              A pickup address could not be resolved for this order&apos;s lines, so there is nothing to
              check and booking is blocked until the origin mapping is complete.
            </p>
          )
        )}
        <AddressGateCard
          title="Delivery address"
          subjectType="DELIVERY"
          subjectId={order.id}
          status={collection.deliveryGate}
          isOwner={isOwner}
        />
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Shipping quotes</h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem" }}>
          eShipper: {eshipper.mode}{eshipper.account ? ` · account ${eshipper.account}` : ""}
        </p>
        <Form method="post" style={{ marginBottom: "0.75rem" }}>
          <button type="submit" name="intent" value="get_quotes" style={btn("#0369a1")}>Get shipping quotes</button>
        </Form>
        {/* Why the quotes are gone. "No quotes yet" and "the quotes were
            withdrawn because the packages changed" lead to different actions,
            and only one of them means somebody should press the button. */}
        {order.quotesInvalidatedAt ? (
          <p style={{ fontSize: "0.75rem", color: "#b45309", marginBottom: "0.5rem" }} role="status">
            Earlier quotes were withdrawn on {new Date(order.quotesInvalidatedAt).toLocaleString()}:{" "}
            {order.quoteInvalidationReason || "no reason recorded"}. Request quotes again.
          </p>
        ) : null}
        {order.shippingQuotes.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No quotes yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr><th style={th}>From dock</th><th style={th}>Carrier</th><th style={th}>Service</th><th style={th}>Cost</th><th style={th}>Transit</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {order.shippingQuotes.map((q) => (
                <tr key={q.id} style={{ borderTop: "1px solid #f1f5f9", background: q.selected ? "#f0fdf4" : undefined }}>
                  {/*
                    A quote is priced for one dock. Showing which one is what
                    stops an operator selecting the cheapest line for a shipment
                    that leaves from somewhere else — a booking that would have
                    been refused, or worse, accepted at the wrong address.
                  */}
                  <td style={{ padding: "0.4rem" }}>
                    {q.originLocation ? (
                      q.originLocation.code
                    ) : (
                      <span style={{ color: "#b45309" }} title="This quote predates dock-scoped quoting and cannot be matched to a dock.">not dock-scoped</span>
                    )}
                  </td>
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
                {s.originLocation ? `from ${s.originLocation.code}` : "dock not recorded"} · booked cost {s.bookedCost != null ? money(s.bookedCost) : "—"}
                {s.shopifyFulfillmentId ? ` · Shopify fulfillment ${s.shopifyFulfillmentId}` : ""}
              </div>
              <div style={{ color: "#64748b" }}>
                pickup {s.pickupMode ?? "not recorded"}
                {s.pickupStatus ? ` · ${s.pickupStatus}` : ""}
                {s.status === "BOOKED" && !s.shopifyFulfillmentId ? " · Shopify push waits for dispatch" : ""}
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
