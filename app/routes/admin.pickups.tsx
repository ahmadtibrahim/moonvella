import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { ShippingOperationsNav } from "~/components/ShippingOperationsNav";
import { requirePermission } from "~/utils/adminAuth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");
  const base: Prisma.ShipmentWhereInput = { status: { in: ["BOOKED", "SHIPPED", "EXCEPTION"] } };
  const [needsPickup, scheduled, problems, shipments] = await Promise.all([
    prisma.shipment.count({ where: { ...base, pickupMode: "NEEDED", OR: [{ pickupStatus: null }, { pickupStatus: { in: ["NONE", "FAILED", "MISSED", "CANCELLED"] } }] } }),
    prisma.shipment.count({ where: { ...base, pickupStatus: "SCHEDULED" } }),
    prisma.shipment.count({ where: { ...base, pickupStatus: { in: ["FAILED", "MISSED", "UNKNOWN"] } } }),
    prisma.shipment.findMany({
      where: { ...base, OR: [{ pickupMode: "NEEDED" }, { pickupStatus: { in: ["SCHEDULED", "FAILED", "MISSED", "UNKNOWN"] } }] },
      orderBy: [{ pickupScheduledFor: "asc" }, { createdAt: "asc" }],
      take: 100,
      include: { originLocation: true, order: { include: { seller: true } } },
    }),
  ]);
  return { needsPickup, scheduled, problems, shipments };
}

const card = { background: "white", border: "1px solid #dbe4ee", borderRadius: 12, padding: "1rem" } as const;
const th = { textAlign: "left", padding: "0.65rem", fontSize: "0.68rem", color: "#64748b", textTransform: "uppercase" } as const;
const td = { padding: "0.7rem 0.65rem", fontSize: "0.76rem", verticalAlign: "top" } as const;

export default function AdminPickups() {
  const { needsPickup, scheduled, problems, shipments } = useLoaderData<typeof loader>();
  return <div style={{ maxWidth: 1180, margin: "0 auto" }}>
    <ShippingOperationsNav />
    <h1 style={{ fontSize: "1.5rem", color: "#082a4a", marginBottom: "0.25rem" }}>Pickup queue</h1>
    <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "1rem" }}>Labels and pickups are separate. Open one shipment to schedule, reschedule, or cancel its carrier collection.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
      {[{ label: "Needs scheduling", value: needsPickup, color: "#b45309" }, { label: "Scheduled", value: scheduled, color: "#059669" }, { label: "Needs attention", value: problems, color: "#dc2626" }].map((item) => <div key={item.label} style={card}><div style={{ color: "#64748b", fontSize: "0.7rem" }}>{item.label}</div><div style={{ color: item.color, fontSize: "1.6rem", fontWeight: 750 }}>{item.value}</div></div>)}
    </div>
    <div style={{ ...card, padding: 0, overflowX: "auto" }}>
      {shipments.length === 0 ? <p style={{ padding: "1rem", color: "#64748b", fontSize: "0.8rem" }}>No pickups need attention.</p> : <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={th}>Order</th><th style={th}>Carrier</th><th style={th}>Pickup location</th><th style={th}>Plan</th><th style={th}>Carrier confirmation</th><th style={th}></th></tr></thead>
        <tbody>{shipments.map((shipment) => <tr key={shipment.id} style={{ borderTop: "1px solid #eef2f7" }}>
          <td style={td}><strong>{shipment.order.shopifyOrderName}</strong><br /><span style={{ color: "#64748b" }}>{shipment.order.seller.storeName}</span></td>
          <td style={td}>{shipment.carrier || "—"}<br /><span style={{ color: "#64748b" }}>{shipment.serviceName || "—"}</span></td>
          <td style={td}>{shipment.originLocation ? `${shipment.originLocation.code} — ${shipment.originLocation.name}` : "Origin snapshot on shipment"}</td>
          <td style={td}>{shipment.pickupMode === "REGULAR" ? "Regular pickup" : shipment.pickupMode === "DROPOFF" ? "Drop-off" : "One-off pickup"}</td>
          <td style={td}><strong style={{ color: ["FAILED", "MISSED", "UNKNOWN"].includes(shipment.pickupStatus || "") ? "#dc2626" : shipment.pickupStatus === "SCHEDULED" ? "#059669" : "#b45309" }}>{shipment.pickupStatus || "Not scheduled"}</strong>{shipment.pickupScheduledFor ? <><br />{new Date(shipment.pickupScheduledFor).toLocaleString()}</> : null}{shipment.pickupLastError ? <><br /><span style={{ color: "#dc2626" }}>{shipment.pickupLastError}</span></> : null}</td>
          <td style={td}><Link to={`/admin/shipping/${shipment.id}#pickup`} style={{ color: "#0369a1", fontWeight: 650 }}>Manage</Link></td>
        </tr>)}</tbody>
      </table>}
    </div>
  </div>;
}
