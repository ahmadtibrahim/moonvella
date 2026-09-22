import { Link, Form, useLoaderData, useActionData, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { toCm, toKg } from "~/services/packaging.server";
import { recordAudit, AUDIT_ENTITY } from "~/services/audit.server";
import {
  getQuotesForOrder,
  selectQuote,
  bookPreparedShipment,
  getShipmentLabel,
  getShipmentOrderDetails,
  getShipmentCustomsInvoice,
  syncTrackingForShipment,
  voidShipment,
  getReturnQuotesForOrder,
  bookReturnForOrder,
  schedulePickupForShipment,
  cancelPickupForShipment,
  getBillingReconciliation,
  reconcileCarrierInvoice,
  trackingLabel,
  pickCheapestQuote,
  pickFastestQuote,
} from "~/services/shipping.server";
import { advanceShipment, type ShipmentAdvanceEvent } from "~/services/fulfillment.server";
import { maskedEshipperAccount, eshipperMode } from "~/services/eshipper.server";
import { getIntegrationState } from "~/services/integrationHealth.server";

const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = [
  "packed",
  "handed_to_carrier",
  "shipped",
  "in_transit",
  "delivered",
  "exception",
];

function parseAddress(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");
  const shipmentId = String(params.shipmentId);
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      items: { include: { orderItem: true } },
      trackingEvents: { orderBy: { eventAt: "desc" }, take: 50 },
      order: {
        include: {
          seller: true,
          items: true,
          packages: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!shipment) throw new Response("Shipment not found", { status: 404 });

  const order = shipment.order;

  // Remaining quantity available to fulfil, counting every other non-cancelled
  // shipment so a partial order cannot be over-shipped.
  const others = await prisma.shipment.findMany({
    where: { orderId: order.id, id: { not: shipment.id }, status: { not: "CANCELLED" } },
    include: { items: true },
  });
  const allocated: Record<string, number> = {};
  for (const s of others) {
    for (const si of s.items) allocated[si.orderItemId] = (allocated[si.orderItemId] || 0) + si.quantity;
  }
  const items = order.items.map((i) => ({
    id: i.id,
    name: i.name,
    sku: i.sku,
    ordered: i.quantity,
    inThisShipment: shipment.items.find((si) => si.orderItemId === i.id)?.quantity ?? 0,
    remaining: i.quantity - (allocated[i.id] || 0),
  }));

  const [quotes, returnQuotes, billing, eshipper, shopifyFulfillment] = await Promise.all([
    prisma.shippingQuote.findMany({ where: { orderId: order.id, provider: "eshipper" }, orderBy: { totalAmount: "asc" } }),
    prisma.shippingQuote.findMany({ where: { orderId: order.id, provider: "eshipper-return" }, orderBy: { totalAmount: "asc" } }),
    getBillingReconciliation(shipmentId),
    getIntegrationState("eshipper"),
    getIntegrationState("shopify_fulfillment"),
  ]);

  const selectedQuote = quotes.find((q) => q.selected) ?? null;

  return {
    shipment: {
      id: shipment.id,
      reference: shipment.id.slice(0, 8),
      status: shipment.status,
      trackingStatus: shipment.trackingStatus,
      carrier: shipment.carrier,
      serviceCode: shipment.serviceCode,
      serviceName: shipment.serviceName,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      labelUrl: shipment.labelUrl,
      labelDocumentFormat: shipment.labelDocumentFormat,
      providerShipmentId: shipment.providerShipmentId,
      sellerShippingCharge: shipment.sellerShippingCharge,
      quotedCarrierCost: shipment.quotedCarrierCost,
      bookedCost: shipment.bookedCost,
      finalBilledCost: shipment.finalBilledCost,
      billingStatus: shipment.billingStatus,
      providerInvoiceNumber: shipment.providerInvoiceNumber,
      estimatedDelivery: shipment.estimatedDelivery,
      lastTrackingSyncAt: shipment.lastTrackingSyncAt,
      lastTrackingError: shipment.lastTrackingError,
      returnOfShipmentId: shipment.returnOfShipmentId,
      returnReason: shipment.returnReason,
      packageCount: shipment.packageCount,
      createdAt: shipment.createdAt,
      labelCreatedAt: shipment.labelCreatedAt,
      shopifyFulfillmentId: shipment.shopifyFulfillmentId,
    },
    order: {
      id: order.id,
      shopifyOrderName: order.shopifyOrderName,
      supplierReference: order.supplierReference,
      currency: order.currency,
      wholesalePaymentStatus: order.wholesalePaymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      moonvellaShipping: order.moonvellaShipping,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      shipTo: parseAddress(order.shippingAddress),
      billingAddress: parseAddress(order.billingAddress),
      seller: { id: order.seller.id, storeName: order.seller.storeName, currency: order.seller.currency },
    },
    items,
    packages: order.packages,
    quotes,
    returnQuotes,
    selectedQuote,
    billing,
    eshipper: { mode: eshipperMode(), account: maskedEshipperAccount(), state: eshipper.status, detail: eshipper.detail },
    shopifyFulfillment: { state: shopifyFulfillment.status, detail: shopifyFulfillment.detail },
    trackingEvents: shipment.trackingEvents,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const shipmentId = String(params.shipmentId);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const back = `/admin/shipping/${shipmentId}`;

  try {
    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new Error("Shipment not found.");
    const orderId = shipment.orderId;

    if (intent === "add_package") {
      const dimensionUnit = String(form.get("dimensionUnit") || "in");
      const weightUnit = String(form.get("weightUnit") || "lb");
      const length = Number(form.get("length"));
      const width = Number(form.get("width"));
      const height = Number(form.get("height"));
      const weight = Number(form.get("weight"));
      if (!(length > 0) || !(width > 0) || !(height > 0)) {
        throw new Error("Length, width and height must all be greater than zero.");
      }
      if (!(weight > 0)) throw new Error("Gross shipping weight must be greater than zero.");
      await prisma.orderPackage.create({
        data: {
          orderId,
          count: Math.max(1, Math.floor(Number(form.get("count") || 1))),
          length: Number(toCm(length, dimensionUnit).toFixed(2)),
          width: Number(toCm(width, dimensionUnit).toFixed(2)),
          height: Number(toCm(height, dimensionUnit).toFixed(2)),
          weight: Number(toKg(weight, weightUnit).toFixed(3)),
          units: "cm_kg",
        },
      });
      await recordAudit({
        actorType: "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "order.package_added",
        entityType: AUDIT_ENTITY.ORDER,
        entityId: orderId,
        afterData: { dimensionUnit, weightUnit },
        ipAddress: ip,
        userAgent: actor.userAgent,
      });
    } else if (intent === "remove_package") {
      const packageId = String(form.get("packageId"));
      const pkg = await prisma.orderPackage.findUnique({ where: { id: packageId } });
      if (!pkg || pkg.orderId !== orderId) throw new Error("Package not found for this order.");
      await prisma.orderPackage.delete({ where: { id: packageId } });
    } else if (intent === "get_quotes") {
      await getQuotesForOrder(orderId, actor);
    } else if (intent === "select_quote") {
      await selectQuote(orderId, String(form.get("quoteId")), actor);
    } else if (intent === "book_shipment") {
      await bookPreparedShipment(shipmentId, String(form.get("quoteId") || "") || undefined, actor);
    } else if (intent === "get_label") {
      const label = await getShipmentLabel(shipmentId, actor);
      if (!label.labelUrl) throw new Error("The provider did not return a label URL.");
      return redirect(label.labelUrl);
    } else if (intent === "order_details") {
      await getShipmentOrderDetails(shipmentId, actor);
      return redirect(`${back}?notice=shipment-details-fetched`);
    } else if (intent === "customs_invoice") {
      const invoice = await getShipmentCustomsInvoice(shipmentId, actor);
      if (!invoice.customsInvoiceUrl) throw new Error("The provider did not return a customs invoice.");
      return redirect(invoice.customsInvoiceUrl);
    } else if (intent === "sync_tracking") {
      await syncTrackingForShipment(shipmentId, actor);
    } else if (intent === "cancel_shipment") {
      const result = await voidShipment(shipmentId, actor);
      if (!result.cancelled) {
        return { error: `Cancellation outcome is not confirmed${result.providerMessage ? `: ${result.providerMessage}` : "."} The shipment is shown as an exception, not cancelled.` };
      }
    } else if (intent === "advance_shipment") {
      const event = String(form.get("event") || "");
      if (!ADVANCE_EVENTS.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      await advanceShipment(shipmentId, event as ShipmentAdvanceEvent, actor, {
        notifyCustomer: form.get("notifyCustomer") === "on",
      });
    } else if (intent === "return_quotes") {
      await getReturnQuotesForOrder(orderId, actor);
    } else if (intent === "book_return") {
      const returnItems: { orderItemId: string; quantity: number }[] = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith("ret_")) continue;
        const qty = Number(value);
        if (qty > 0) returnItems.push({ orderItemId: key.slice(4), quantity: qty });
      }
      if (returnItems.length === 0) throw new Error("Select at least one item quantity to return.");
      await bookReturnForOrder(
        orderId,
        shipmentId,
        {
          returnQuoteId: String(form.get("returnQuoteId") || ""),
          returnItems,
          reason: String(form.get("reason") || "") || "Not specified",
        },
        actor
      );
    } else if (intent === "schedule_pickup") {
      await schedulePickupForShipment(
        shipmentId,
        {
          pickupDate: String(form.get("pickupDate") || ""),
          pickupTimeWindow: String(form.get("pickupTimeWindow") || ""),
          notes: String(form.get("notes") || "") || undefined,
        },
        actor
      );
    } else if (intent === "cancel_pickup") {
      await cancelPickupForShipment(shipmentId, String(form.get("pickupId") || ""), actor);
    } else if (intent === "reconcile_billing") {
      const totalCents = Math.round(Number(form.get("total") || "0") * 100);
      await reconcileCarrierInvoice(
        shipmentId,
        {
          invoiceNumber: String(form.get("invoiceNumber") || ""),
          total: totalCents,
          currency: String(form.get("currency") || "CAD"),
        },
        actor
      );
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect(back);
}

const card: React.CSSProperties = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.25rem", marginBottom: "1.25rem" };
const h2: React.CSSProperties = { fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.6rem" };
const input: React.CSSProperties = { padding: "0.4rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.78rem", boxSizing: "border-box" };
const label: React.CSSProperties = { fontSize: "0.68rem", color: "#64748b", display: "block" };
const btn = (color: string): React.CSSProperties => ({ padding: "0.4rem 0.75rem", border: `1px solid ${color}`, borderRadius: 6, background: "white", color, fontSize: "0.72rem", fontWeight: 600, cursor: "pointer" });
const th: React.CSSProperties = { padding: "0.4rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };
const td: React.CSSProperties = { padding: "0.4rem", fontSize: "0.78rem" };

function money(cents: number | null | undefined, currency = "CAD") {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export default function AdminShipmentDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { shipment, order, items, packages, quotes, returnQuotes, selectedQuote, billing, eshipper, shopifyFulfillment, trackingEvents } = data;
  const addr = order.shipTo;
  const paid = order.wholesalePaymentStatus === "SUCCEEDED";
  const cheapest = pickCheapestQuote(quotes);
  const fastest = pickFastestQuote(quotes);
  const returnCheapest = pickCheapestQuote(returnQuotes);
  const canBook = !shipment.providerShipmentId && paid && packages.length > 0;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/shipping" style={{ color: "#082a4a" }}>&larr; All shipments</Link>
      </p>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Shipment {shipment.reference}{shipment.returnOfShipmentId ? " (return)" : ""}
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "1.25rem" }}>
        {order.shopifyOrderName} · {order.seller.storeName} · {order.supplierReference} · {trackingLabel(shipment.trackingStatus)} ({shipment.status})
      </p>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>{actionData.error}</div>
      ) : null}

      <div style={card}>
        <h2 style={h2}>Related order and remaining quantities</h2>
        <div style={{ fontSize: "0.8rem", lineHeight: 1.7, marginBottom: "0.5rem" }}>
          <div>Order: <Link to={`/admin/orders/${order.id}`} style={{ color: "#082a4a" }}>{order.shopifyOrderName}</Link> · Invoice ref: {order.supplierReference}</div>
          <div>Wholesale payment: <strong>{order.wholesalePaymentStatus}</strong> · Fulfillment: {order.fulfillmentStatus}</div>
          {shipment.returnOfShipmentId ? (
            <div style={{ color: "#b45309" }}>This is a return of shipment <Link to={`/admin/shipping/${shipment.returnOfShipmentId}`} style={{ color: "#b45309" }}>{shipment.returnOfShipmentId.slice(0, 8)}</Link>. Reason: {shipment.returnReason || "—"}. A return label is not a refund.</div>
          ) : null}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr><th style={th}>Item</th><th style={th}>SKU</th><th style={th}>Ordered</th><th style={th}>In this shipment</th><th style={th}>Remaining unshipped</th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={td}>{i.name}</td>
                <td style={td}>{i.sku}</td>
                <td style={td}>{i.ordered}</td>
                <td style={td}>{i.inThisShipment}</td>
                <td style={{ ...td, color: i.remaining > 0 ? "#b45309" : "#059669" }}>{i.remaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
        <div style={card}>
          <h2 style={h2}>Ship from</h2>
          <div style={{ fontSize: "0.78rem", lineHeight: 1.7 }}>
            <div>{process.env.MOONVELLA_SHIP_FROM_NAME || "MoonVella warehouse"}</div>
            <div>{process.env.MOONVELLA_SHIP_FROM_ADDRESS || "1 Warehouse Way"}</div>
            <div>
              {process.env.MOONVELLA_SHIP_FROM_CITY || "Toronto"}, {process.env.MOONVELLA_SHIP_FROM_PROVINCE || "ON"} {process.env.MOONVELLA_SHIP_FROM_POSTAL || "M5H 2N2"}
            </div>
            <div>{process.env.MOONVELLA_SHIP_FROM_COUNTRY || "CA"}</div>
            <div style={{ color: "#94a3b8" }}>{process.env.MOONVELLA_SHIP_FROM_PHONE || "no phone configured"}</div>
          </div>
        </div>
        <div style={card}>
          <h2 style={h2}>Ship to</h2>
          <div style={{ fontSize: "0.78rem", lineHeight: 1.7 }}>
            <div>{addr.name || order.customerName || "—"}</div>
            <div>{addr.address1 || addr.address || "—"}{addr.address2 ? `, ${addr.address2}` : ""}</div>
            <div>{[addr.city, addr.province || addr.provinceCode, addr.zip || addr.postalCode].filter(Boolean).join(", ") || "—"}</div>
            <div>{addr.country || addr.countryCode || "—"}</div>
            <div style={{ color: "#94a3b8" }}>{addr.residential === "false" ? "Commercial" : "Residential"} · {order.customerEmail || "no email"}</div>
            {addr.deliveryInstructions ? <div style={{ color: "#94a3b8" }}>Instructions: {addr.deliveryInstructions}</div> : null}
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Packages (packed dimensions and gross shipping weight)</h2>
        {packages.length === 0 ? (
          <p style={{ fontSize: "0.78rem", color: "#b45309" }}>No parcel dimensions recorded. Quoting is blocked until every parcel has length, width, height and gross shipping weight.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.6rem" }}>
            <thead>
              <tr><th style={th}>Count</th><th style={th}>Dimensions (cm)</th><th style={th}>Weight (kg)</th><th style={th}>Total weight</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>{p.count}</td>
                  <td style={td}>{p.length} × {p.width} × {p.height}</td>
                  <td style={td}>{p.weight}</td>
                  <td style={td}>{(p.weight * p.count).toFixed(3)}</td>
                  <td style={td}>
                    {!shipment.providerShipmentId ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove_package" />
                        <input type="hidden" name="packageId" value={p.id} />
                        <button type="submit" style={btn("#dc2626")}>Remove</button>
                      </Form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!shipment.providerShipmentId ? (
          <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <input type="hidden" name="intent" value="add_package" />
            <label style={label}>Count<br /><input style={{ ...input, width: 70 }} name="count" type="number" defaultValue={1} min={1} /></label>
            <label style={label}>Length<br /><input style={{ ...input, width: 80 }} name="length" type="number" step="0.01" required /></label>
            <label style={label}>Width<br /><input style={{ ...input, width: 80 }} name="width" type="number" step="0.01" required /></label>
            <label style={label}>Height<br /><input style={{ ...input, width: 80 }} name="height" type="number" step="0.01" required /></label>
            <label style={label}>Dimension unit<br />
              <select name="dimensionUnit" defaultValue="in" style={input}>
                <option value="in">in</option>
                <option value="cm">cm</option>
              </select>
            </label>
            <label style={label}>Gross weight<br /><input style={{ ...input, width: 90 }} name="weight" type="number" step="0.01" required /></label>
            <label style={label}>Weight unit<br />
              <select name="weightUnit" defaultValue="lb" style={input}>
                <option value="lb">lb</option>
                <option value="kg">kg</option>
              </select>
            </label>
            <button type="submit" style={btn("#0369a1")}>Add parcel</button>
          </Form>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={h2}>Rate comparison</h2>
        <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
          eShipper: {eshipper.mode === "real" ? `configured (${eshipper.account ?? "account"})` : "not configured — quotes are simulated"} · {eshipper.detail}
        </p>
        <Form method="post" style={{ marginBottom: "0.6rem" }}>
          <button type="submit" name="intent" value="get_quotes" style={btn("#0369a1")} disabled={packages.length === 0}>Get quotes</button>
        </Form>
        {quotes.length === 0 ? (
          <p style={{ fontSize: "0.78rem", color: "#64748b" }}>No quotes yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>Carrier</th><th style={th}>Service</th><th style={th}>Total</th><th style={th}>Base / surcharge / tax</th><th style={th}>Transit</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const raw = q.raw ? (JSON.parse(q.raw) as Record<string, unknown>) : {};
                return (
                  <tr key={q.id} style={{ borderTop: "1px solid #f1f5f9", background: q.selected ? "#f0fdf4" : undefined }}>
                    <td style={td}>{q.carrier}</td>
                    <td style={td}>
                      {q.serviceName}
                      {cheapest?.id === q.id ? " · cheapest" : ""}
                      {fastest?.id === q.id && q.transitDays !== null ? " · fastest" : ""}
                    </td>
                    <td style={td}>{money(q.totalAmount, q.currency)}</td>
                    <td style={{ ...td, color: "#94a3b8", fontSize: "0.68rem" }}>
                      {raw.baseCharge != null ? `base ${raw.baseCharge}` : "base n/a"}
                      {raw.surcharges != null ? ` · surcharges` : ""}
                      {raw.taxes != null ? ` · taxes` : ""}
                    </td>
                    <td style={td}>{q.transitDays === null ? "Estimate unavailable" : `${q.transitDays} day(s)`}</td>
                    <td style={td}>
                      <Form method="post">
                        <input type="hidden" name="intent" value="select_quote" />
                        <input type="hidden" name="quoteId" value={q.id} />
                        <button type="submit" style={btn("#082a4a")}>Select</button>
                      </Form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: "0.75rem", border: "1px dashed #cbd5e1", borderRadius: 8, padding: "0.6rem" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.3rem" }}>Final review before booking</div>
          {shipment.providerShipmentId ? (
            <p style={{ fontSize: "0.78rem", color: "#64748b" }}>This shipment is already booked. Reprinting the label does not create a new shipment.</p>
          ) : !paid ? (
            <p style={{ fontSize: "0.78rem", color: "#b45309" }}>Booking is blocked until the wholesale payment succeeds.</p>
          ) : !selectedQuote ? (
            <p style={{ fontSize: "0.78rem", color: "#b45309" }}>Select a quote above. Selecting does not book.</p>
          ) : (
            <>
              <p style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>
                Booking <strong>{selectedQuote.carrier} {selectedQuote.serviceName}</strong> at <strong>{money(selectedQuote.totalAmount, selectedQuote.currency)}</strong>.
                {selectedQuote.expiresAt ? ` Quote expires ${new Date(selectedQuote.expiresAt).toLocaleTimeString()}.` : ""}
                {shipment.quotedCarrierCost != null && shipment.quotedCarrierCost !== selectedQuote.totalAmount ? (
                  <span style={{ color: "#b45309" }}> The quote changed from {money(shipment.quotedCarrierCost)} since it was prepared.</span>
                ) : null}
              </p>
              <p style={{ fontSize: "0.7rem", color: "#64748b", marginBottom: "0.4rem" }}>
                This purchases a real label when eShipper is configured. The seller&apos;s fixed shipping charge is unchanged.
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="book_shipment" />
                <input type="hidden" name="quoteId" value={selectedQuote.id} />
                <button type="submit" style={btn("#059669")} disabled={!canBook}>Book shipment</button>
              </Form>
            </>
          )}
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Documents</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {shipment.labelUrl ? (
            <a href={shipment.labelUrl} target="_blank" rel="noreferrer" style={btn("#0369a1")}>Shipping label</a>
          ) : (
            <span style={{ ...btn("#94a3b8"), cursor: "not-allowed" }}>Shipping label (none yet)</span>
          )}
          {shipment.providerShipmentId ? (
            <>
              <Form method="post"><button type="submit" name="intent" value="get_label" style={btn("#0369a1")}>Retrieve label (no rebook)</button></Form>
              <Form method="post"><button type="submit" name="intent" value="order_details" style={btn("#082a4a")}>Shipment details</button></Form>
              <Form method="post"><button type="submit" name="intent" value="customs_invoice" style={btn("#082a4a")}>Customs invoice</button></Form>
            </>
          ) : null}
          <Link to={`/admin/orders/${order.id}`} style={{ ...btn("#082a4a"), textDecoration: "none" }}>Seller invoice (order)</Link>
        </div>
        {shipment.lastTrackingError ? (
          <p style={{ fontSize: "0.7rem", color: "#dc2626", marginTop: "0.5rem" }}>Carrier document/tracking error: {shipment.lastTrackingError}</p>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={h2}>Tracking</h2>
        <p style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>
          {shipment.trackingNumber || "no tracking number"} · {trackingLabel(shipment.trackingStatus)}
          {shipment.trackingUrl ? <> · <a href={shipment.trackingUrl} target="_blank" rel="noreferrer" style={{ color: "#0369a1" }}>carrier tracking</a></> : null}
        </p>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginBottom: "0.6rem" }}>
          Last successful update: {shipment.lastTrackingSyncAt ? new Date(shipment.lastTrackingSyncAt).toLocaleString() : "never"}
        </p>
        {shipment.providerShipmentId ? (
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <Form method="post"><button type="submit" name="intent" value="sync_tracking" style={btn("#0369a1")}>Sync tracking</button></Form>
            {shipment.status !== "CANCELLED" && shipment.status !== "DELIVERED" ? (
              <Form method="post" style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                <input type="hidden" name="intent" value="advance_shipment" />
                <select name="event" defaultValue="in_transit" style={input}>
                  {ADVANCE_EVENTS.map((ev) => (
                    <option key={ev} value={ev}>{ev.replace(/_/g, " ")}</option>
                  ))}
                </select>
                <label style={{ fontSize: "0.68rem", color: "#64748b" }}><input type="checkbox" name="notifyCustomer" /> notify</label>
                <button type="submit" style={btn("#082a4a")}>Record</button>
              </Form>
            ) : null}
          </div>
        ) : null}
        {trackingEvents.length === 0 ? (
          <p style={{ fontSize: "0.75rem", color: "#64748b" }}>No carrier events recorded yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>When</th><th style={th}>Location</th><th style={th}>Event</th><th style={th}>Code</th></tr></thead>
            <tbody>
              {trackingEvents.map((ev) => (
                <tr key={ev.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>{new Date(ev.eventAt).toLocaleString()}</td>
                  <td style={td}>{ev.location || "—"}</td>
                  <td style={td}>{ev.description || ev.statusText || "—"}</td>
                  <td style={td}>{ev.carrierEventCode || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={card}>
        <h2 style={h2}>Pickup</h2>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="schedule_pickup" />
          <label style={label}>Pickup date<br /><input type="date" name="pickupDate" style={input} required /></label>
          <label style={label}>Time window<br /><input name="pickupTimeWindow" placeholder="09:00-17:00" style={input} /></label>
          <label style={label}>Notes<br /><input name="notes" style={input} /></label>
          <button type="submit" style={btn("#0369a1")} disabled={!shipment.providerShipmentId}>Schedule pickup</button>
        </Form>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", marginTop: "0.5rem" }}>
          <input type="hidden" name="intent" value="cancel_pickup" />
          <label style={label}>Pickup id to cancel<br /><input name="pickupId" style={input} required /></label>
          <button type="submit" style={btn("#dc2626")}>Cancel pickup</button>
        </Form>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.4rem" }}>
          Pickup cancellation is separate from shipment cancellation and from any financial credit.
        </p>
      </div>

      {!shipment.returnOfShipmentId ? (
        <div style={card}>
          <h2 style={h2}>Return</h2>
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
            A return is a new shipment linked to this one. It does not refund, restock, mark received, or charge the seller.
          </p>
          <Form method="post" style={{ marginBottom: "0.6rem" }}>
            <button type="submit" name="intent" value="return_quotes" style={btn("#0369a1")}>Get return rates</button>
          </Form>
          {returnQuotes.length > 0 ? (
            <Form method="post">
              <input type="hidden" name="intent" value="book_return" />
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.5rem" }}>
                <thead><tr><th style={th}>Return</th><th style={th}>Carrier</th><th style={th}>Service</th><th style={th}>Cost</th><th style={th}>Transit</th></tr></thead>
                <tbody>
                  {returnQuotes.map((q) => (
                    <tr key={q.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={td}><input type="radio" name="returnQuoteId" value={q.id} defaultChecked={returnCheapest?.id === q.id} /></td>
                      <td style={td}>{q.carrier}</td>
                      <td style={td}>{q.serviceName}</td>
                      <td style={td}>{money(q.totalAmount, q.currency)}</td>
                      <td style={td}>{q.transitDays === null ? "Estimate unavailable" : `${q.transitDays} day(s)`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginBottom: "0.5rem" }}>
                <span style={{ ...label, marginBottom: "0.3rem" }}>Items to return</span>
                {items.map((i) => (
                  <label key={i.id} style={{ fontSize: "0.72rem", display: "block" }}>
                    <input type="number" name={`ret_${i.id}`} min={0} max={i.inThisShipment || i.ordered} defaultValue={0} style={{ ...input, width: 60, marginRight: "0.4rem" }} />
                    {i.name} ({i.sku})
                  </label>
                ))}
              </div>
              <label style={label}>Reason<br /><input name="reason" style={{ ...input, width: 320 }} /></label>
              <button type="submit" style={{ ...btn("#082a4a"), marginTop: "0.5rem" }}>Book return label</button>
            </Form>
          ) : null}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={h2}>Carrier billing and reconciliation</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.6rem", marginBottom: "0.6rem" }}>
          {[
            { k: "Seller shipping charge", v: money(billing.sellerShippingCharge, order.currency) },
            { k: "Quoted carrier cost", v: money(billing.quotedCarrierCost, order.currency) },
            { k: "Booked carrier cost", v: money(billing.bookedCarrierCost, order.currency) },
            { k: "Final billed carrier cost", v: billing.finalBilledCarrierCost == null ? "not billed yet" : money(billing.finalBilledCarrierCost, order.currency) },
            { k: "Shipping margin / loss", v: billing.margin == null ? "—" : money(billing.margin, order.currency) },
            { k: "Billing status", v: billing.status.replace(/_/g, " ") },
          ].map((row) => (
            <div key={row.k} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem" }}>
              <div style={{ fontSize: "0.65rem", color: "#64748b" }}>{row.k}</div>
              <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "#082a4a" }}>{row.v}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginBottom: "0.5rem" }}>
          A carrier adjustment changes MoonVella&apos;s cost only. The seller charge on the order never moves because of it.
        </p>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="reconcile_billing" />
          <label style={label}>Supplier invoice #<br /><input name="invoiceNumber" style={input} required /></label>
          <label style={label}>Invoice total<br /><input name="total" type="number" step="0.01" style={input} required /></label>
          <label style={label}>Currency<br /><input name="currency" defaultValue={order.currency} style={{ ...input, width: 70 }} /></label>
          <button type="submit" style={btn("#082a4a")}>Record supplier invoice</button>
        </Form>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.4rem" }}>
          This records a draft reconciliation only. It does not post an accounting document to Odoo.
        </p>
      </div>

      <div style={card}>
        <h2 style={h2}>Cancellation</h2>
        {shipment.status === "CANCELLED" ? (
          <p style={{ fontSize: "0.8rem", color: "#64748b" }}>Cancelled. Cancellation does not by itself guarantee a refund.</p>
        ) : shipment.providerShipmentId ? (
          <Form method="post">
            <input type="hidden" name="intent" value="cancel_shipment" />
            <button type="submit" style={btn("#dc2626")}>Cancel shipment</button>
          </Form>
        ) : (
          <p style={{ fontSize: "0.8rem", color: "#64748b" }}>Not booked, so there is nothing to cancel at the provider.</p>
        )}
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.4rem" }}>
          Cancel requested is shown until the provider confirms. Shipment cancellation does not cancel or refund the whole order.
        </p>
      </div>

      <div style={card}>
        <h2 style={h2}>Order and Shopify links</h2>
        <div style={{ fontSize: "0.78rem", lineHeight: 1.7 }}>
          <div>Shopify fulfillment order: {order.id ? "see order" : "—"}</div>
          <div>Shopify fulfillment id: {shipment.shopifyFulfillmentId || "not pushed"}</div>
          <div>Shopify fulfillment sync: {shopifyFulfillment.state} — {shopifyFulfillment.detail}</div>
          <div style={{ color: "#94a3b8" }}>Payment, order fulfillment and parcel tracking are separate statuses.</div>
        </div>
      </div>
    </div>
  );
}
