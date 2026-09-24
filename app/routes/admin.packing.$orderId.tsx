import { Link, Form, useLoaderData, useActionData, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "~/services/audit.server";
import { getVariantPackages, toCm, toKg } from "~/services/packaging.server";
import {
  createPackingShipment,
  markShipmentPacked,
  markOrderReadyToShip,
  deletePackingShipment,
  addOrderPackage,
  removeOrderPackage,
} from "~/services/fulfillment.server";
import { invalidateQuotes, QUOTE_INVALIDATION } from "~/services/shipping.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "orders.view");
  const orderId = String(params.orderId);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      seller: true,
      items: true,
      packages: true,
      shipments: { include: { items: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) throw new Response("Order not found", { status: 404 });

  const packedByItem: Record<string, number> = {};
  for (const s of order.shipments) {
    if (s.status === "CANCELLED") continue;
    for (const si of s.items) packedByItem[si.orderItemId] = (packedByItem[si.orderItemId] || 0) + si.quantity;
  }

  const variantPackaging: Record<string, { label: string | null; length: number; width: number; height: number; weight: number; dimensionUnit: string; weightUnit: string; count: number }[]> = {};
  await Promise.all(
    order.items.map(async (item) => {
      if (!item.variantId) return;
      const rows = await getVariantPackages(item.variantId);
      variantPackaging[item.id] = rows.map((r) => ({
        label: r.label,
        length: Number(toCm(r.length, r.dimensionUnit).toFixed(2)),
        width: Number(toCm(r.width, r.dimensionUnit).toFixed(2)),
        height: Number(toCm(r.height, r.dimensionUnit).toFixed(2)),
        weight: Number(toKg(r.grossWeight, r.weightUnit).toFixed(3)),
        dimensionUnit: r.dimensionUnit,
        weightUnit: r.weightUnit,
        count: item.quantity * r.packagesPerUnit,
      }));
    })
  );

  const items = order.items.map((i) => ({
    id: i.id,
    name: i.name,
    sku: i.sku,
    quantity: i.quantity,
    variantId: i.variantId,
    packed: packedByItem[i.id] || 0,
    remaining: i.quantity - (packedByItem[i.id] || 0),
    variantPackaging: variantPackaging[i.id] ?? [],
  }));

  return {
    order: {
      id: order.id,
      shopifyOrderName: order.shopifyOrderName,
      supplierReference: order.supplierReference,
      currency: order.currency,
      fulfillmentStatus: order.fulfillmentStatus,
      wholesalePaymentStatus: order.wholesalePaymentStatus,
      seller: { storeName: order.seller.storeName },
    },
    items,
    /*
     * `shipmentId` is the field that decides what a carrier is told. A carton
     * carrying one is described by that shipment's booking; a carton carrying
     * none is described by every shipment on the order that has no cartons of
     * its own. It is rendered so the assignment can be read, made and corrected
     * on this page — the alternative is an operator wondering why a box was
     * priced for three cartons when it holds one.
     */
    packages: order.packages.map((p) => ({
      id: p.id,
      shipmentId: p.shipmentId,
      count: p.count,
      length: p.length,
      width: p.width,
      height: p.height,
      weight: p.weight,
      units: p.units,
    })),
    shipments: order.shipments.map((s) => ({
      id: s.id,
      status: s.status,
      carrier: s.carrier,
      serviceName: s.serviceName,
      packedAt: s.packedAt,
      providerShipmentId: s.providerShipmentId,
      shopifyFulfillmentId: s.shopifyFulfillmentId,
      attachedPackageIds: order.packages.filter((p) => p.shipmentId === s.id).map((p) => p.id),
      items: s.items.map((si) => {
        const item = order.items.find((i) => i.id === si.orderItemId);
        return { orderItemId: si.orderItemId, name: item?.name ?? si.orderItemId, sku: item?.sku ?? "", quantity: si.quantity };
      }),
    })),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "orders.fulfill");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const orderId = String(params.orderId);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "add_package") {
      await addOrderPackage(
        orderId,
        {
          count: Number(form.get("count") || 1),
          length: Number(form.get("length")),
          width: Number(form.get("width")),
          height: Number(form.get("height")),
          weight: Number(form.get("weight")),
        },
        actor
      );
    } else if (intent === "remove_package") {
      await removeOrderPackage(orderId, String(form.get("packageId")), actor);
    } else if (intent === "add_variant_package") {
      const orderItemId = String(form.get("orderItemId"));
      const item = await prisma.orderItem.findUnique({ where: { id: orderItemId } });
      if (!item || item.orderId !== orderId) throw new Error("Order item not found.");
      if (!item.variantId) throw new Error("This item has no variant packaging to reference.");
      const rows = await getVariantPackages(item.variantId);
      if (rows.length === 0) throw new Error("No variant packaging rows exist for this item.");
      const created = await prisma.$transaction(
        rows.map((r) =>
          prisma.orderPackage.create({
            data: {
              orderId,
              count: Math.max(1, item.quantity * r.packagesPerUnit),
              length: Number(toCm(r.length, r.dimensionUnit).toFixed(2)),
              width: Number(toCm(r.width, r.dimensionUnit).toFixed(2)),
              height: Number(toCm(r.height, r.dimensionUnit).toFixed(2)),
              weight: Number(toKg(r.grossWeight, r.weightUnit).toFixed(3)),
              units: "cm_kg",
            },
          })
        )
      );
      await recordAudit({
        actorType: "ADMIN_USER",
        actorId: user.id,
        actorName: user.name,
        action: "order.package_from_variant",
        entityType: AUDIT_ENTITY.ORDER,
        entityId: orderId,
        afterData: { orderItemId, variantId: item.variantId, created: created.length },
        ipAddress: ip,
        userAgent,
      });
      // The one parcel write that does not go through addOrderPackage, because
      // it inserts several rows at once. Same rule, same reason: the quotes on
      // this order now price a different set of parcels.
      await invalidateQuotes(orderId, QUOTE_INVALIDATION.packagesChanged, actor);
    } else if (intent === "create_shipment") {
      const allocations: { orderItemId: string; quantity: number }[] = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith("qty_")) continue;
        const qty = Number(value);
        if (qty > 0) allocations.push({ orderItemId: key.slice(4), quantity: qty });
      }
      const selectedPackages = form.getAll("packageIds").map(String).filter(Boolean);
      await createPackingShipment(orderId, allocations, actor, {
        carrier: String(form.get("carrier") || "") || null,
        // The cartons the operator ticked for this box. Passed only when at
        // least one was ticked: ticking none is not a statement that the box is
        // empty, it is the state every caller was in before these boxes existed,
        // and the order's unassigned cartons are claimed by it — which is what a
        // one-box order wants.
        ...(selectedPackages.length > 0 ? { packageIds: selectedPackages } : {}),
      });
    } else if (intent === "mark_packed") {
      await markShipmentPacked(String(form.get("shipmentId")), actor);
    } else if (intent === "delete_packing") {
      await deletePackingShipment(String(form.get("shipmentId")), actor);
    } else if (intent === "mark_ready") {
      await markOrderReadyToShip(orderId, actor);
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect(`/admin/packing/${orderId}`);
}

const card: React.CSSProperties = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" };
const input: React.CSSProperties = { padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.82rem", boxSizing: "border-box" };
const btn = (color: string): React.CSSProperties => ({ padding: "0.4rem 0.75rem", border: `1px solid ${color}`, borderRadius: 6, background: "white", color, fontSize: "0.72rem", fontWeight: 600, cursor: "pointer" });
const th: React.CSSProperties = { padding: "0.4rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };

export default function AdminPacking() {
  const { order, items, packages, shipments } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const totalOrdered = items.reduce((s, i) => s + i.quantity, 0);
  const totalPacked = items.reduce((s, i) => s + i.packed, 0);
  const hasPending = shipments.some((s) => s.status === "PENDING");

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to={`/admin/orders/${order.id}`} style={{ color: "#082a4a" }}>&larr; Back to order</Link>
      </p>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Pack {order.shopifyOrderName}
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "1.5rem" }}>
        {order.seller.storeName} · {order.supplierReference} · fulfillment {order.fulfillmentStatus} · payment {order.wholesalePaymentStatus}
      </p>

      {actionData?.error ? <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>{actionData.error}</div> : null}

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <div style={{ ...card, marginBottom: 0, minWidth: 160 }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b" }}>Ordered</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "#082a4a" }}>{totalOrdered}</div>
        </div>
        <div style={{ ...card, marginBottom: 0, minWidth: 160 }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b" }}>Packed</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "#059669" }}>{totalPacked}</div>
        </div>
        <div style={{ ...card, marginBottom: 0, minWidth: 160 }}>
          <div style={{ fontSize: "0.72rem", color: "#64748b" }}>Remaining</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, color: totalOrdered - totalPacked > 0 ? "#b45309" : "#059669" }}>{totalOrdered - totalPacked}</div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Items</h2>
        {/* The id is what lets the carton tick-boxes in the card below submit
            with THIS form: they are outside it in the document, and a carton is
            a property of the box being created, not a separate action. */}
        <Form method="post" id="packing-form">
          <input type="hidden" name="intent" value="create_shipment" />
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.75rem" }}>
            <thead>
              <tr><th style={th}>Item</th><th style={th}>SKU</th><th style={th}>Ordered</th><th style={th}>Packed</th><th style={th}>Remaining</th><th style={th}>Pack now</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} style={{ borderTop: "1px solid #f1f5f9", fontSize: "0.8rem" }}>
                  <td style={{ padding: "0.4rem" }}>{i.name}</td>
                  <td style={{ padding: "0.4rem", color: "#64748b" }}>{i.sku}</td>
                  <td style={{ padding: "0.4rem" }}>{i.quantity}</td>
                  <td style={{ padding: "0.4rem" }}>{i.packed}</td>
                  <td style={{ padding: "0.4rem", color: i.remaining > 0 ? "#b45309" : "#059669" }}>{i.remaining}</td>
                  <td style={{ padding: "0.4rem" }}>
                    <input style={{ ...input, width: 70 }} type="number" min={0} max={i.remaining} defaultValue={i.remaining} name={`qty_${i.id}`} disabled={i.remaining <= 0} />
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    {i.variantPackaging.length > 0 ? (
                      <span style={{ fontSize: "0.7rem", color: "#64748b" }}>
                        {i.variantPackaging.map((p) => `${p.count}× ${p.length.toFixed(2)}×${p.width.toFixed(2)}×${p.height.toFixed(2)} ${p.dimensionUnit}${p.count > 1 ? " set" : ""} ${p.weight.toFixed(3)}${p.weightUnit}`).join("; ")}
                      </span>
                    ) : (
                      <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>no variant packaging</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Carrier (optional)<br /><input style={input} name="carrier" /></label>
            <button type="submit" style={btn("#082a4a")}>Create packing shipment</button>
          </div>
        </Form>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
          {items.filter((i) => i.variantId).map((i) => (
            <Form method="post" key={i.id}>
              <input type="hidden" name="intent" value="add_variant_package" />
              <input type="hidden" name="orderItemId" value={i.id} />
              <button type="submit" style={btn("#0369a1")} disabled={i.variantPackaging.length === 0}>Use variant packaging: {i.sku}</button>
            </Form>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Consolidated parcel review</h2>
        <p style={{ fontSize: "0.72rem", color: "#64748b", margin: 0, marginBottom: "0.5rem" }}>
          Ticking a carton assigns it to the box being created. A carton assigned to a box is what
          that box&apos;s carrier booking describes; an unassigned carton is described by every box
          that has none of its own. Nothing is merged or moved by ticking &mdash; it only records
          which parcels a booking is allowed to declare.
        </p>
        {packages.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No parcel dimensions recorded.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.75rem" }}>
            <thead>
              <tr><th style={th}>Add</th><th style={th}>Count</th><th style={th}>Dimensions (cm)</th><th style={th}>Weight (kg)</th><th style={th}>Total weight</th><th style={th}>Box</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid #f1f5f9", fontSize: "0.8rem" }}>
                  <td style={{ padding: "0.4rem" }}>
                    <input type="checkbox" form="packing-form" name="packageIds" value={p.id} aria-label={`Assign carton ${p.id} to the new box`} />
                  </td>
                  <td style={{ padding: "0.4rem" }}>{p.count}</td>
                  <td style={{ padding: "0.4rem" }}>{p.length}×{p.width}×{p.height}</td>
                  <td style={{ padding: "0.4rem" }}>{p.weight}</td>
                  <td style={{ padding: "0.4rem" }}>{(p.weight * p.count).toFixed(2)}</td>
                  <td style={{ padding: "0.4rem" }}>
                    {p.shipmentId ? (
                      <span style={{ fontSize: "0.7rem", color: "#0369a1" }}>
                        in box {shipments.findIndex((s) => s.id === p.shipmentId) + 1 || "?"}
                      </span>
                    ) : (
                      <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>unassigned</span>
                    )}
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove_package" />
                      <input type="hidden" name="packageId" value={p.id} />
                      <button type="submit" style={btn("#dc2626")}>Remove</button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="add_package" />
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Count<br /><input style={input} name="count" type="number" defaultValue={1} min={1} /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>L (cm)<br /><input style={input} name="length" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>W (cm)<br /><input style={input} name="width" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>H (cm)<br /><input style={input} name="height" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Weight (kg)<br /><input style={input} name="weight" type="number" step="0.01" required /></label>
          <button type="submit" style={btn("#0369a1")}>Add parcel</button>
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Packing shipments</h2>
        {shipments.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No packing shipments yet.</p>
        ) : (
          shipments.map((s) => (
            <div key={s.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem", marginBottom: "0.5rem", fontSize: "0.8rem" }}>
              <div>
                <strong>{s.status}</strong> · {s.carrier || "no carrier"} · {s.packedAt ? `packed ${new Date(s.packedAt).toLocaleString()}` : "not packed"}
                {s.providerShipmentId ? ` · provider ${s.providerShipmentId}` : ""}
                {s.shopifyFulfillmentId ? ` · Shopify ${s.shopifyFulfillmentId}` : ""}
              </div>
              <ul style={{ margin: "0.3rem 0 0.3rem 1rem", padding: 0 }}>
                {s.items.map((si) => (
                  <li key={si.orderItemId}>{si.quantity} × {si.name} ({si.sku})</li>
                ))}
              </ul>
              <div style={{ fontSize: "0.72rem", color: s.attachedPackageIds.length > 0 ? "#0369a1" : "#b45309", marginBottom: "0.3rem" }}>
                {s.attachedPackageIds.length > 0
                  ? `Cartons in this box: ${s.attachedPackageIds
                      .map((id) => {
                        const p = packages.find((row) => row.id === id);
                        return p ? `${p.count}× ${p.length}×${p.width}×${p.height}` : id;
                      })
                      .join("; ")}`
                  : "No carton assigned — a booking of this box would describe every carton on the order."}
              </div>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {!s.packedAt ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="mark_packed" />
                    <input type="hidden" name="shipmentId" value={s.id} />
                    <button type="submit" style={btn("#059669")}>Mark packed</button>
                  </Form>
                ) : null}
                {s.status === "PENDING" && !s.providerShipmentId && !s.shopifyFulfillmentId ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete_packing" />
                    <input type="hidden" name="shipmentId" value={s.id} />
                    <button type="submit" style={btn("#dc2626")}>Delete packing</button>
                  </Form>
                ) : null}
              </div>
            </div>
          ))
        )}
        <Form method="post" style={{ marginTop: "0.5rem" }}>
          <input type="hidden" name="intent" value="mark_ready" />
          <button type="submit" style={btn("#082a4a")} disabled={!hasPending}>Mark ready to ship</button>
        </Form>
        <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.4rem" }}>
          Booking a carrier label and pushing Shopify fulfillment happens on the order page. Shopify sync reports NOT_CONFIGURED until a fulfillment order is resolved.
        </p>
      </div>
    </div>
  );
}
