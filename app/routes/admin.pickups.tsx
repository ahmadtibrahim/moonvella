import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { ShippingOperationsNav } from "~/components/ShippingOperationsNav";
import { requirePermission } from "~/utils/adminAuth.server";
import { formatDateTime } from "~/utils/dates";

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

/**
 * The provider's confirmation word, in the colour the queue already gave it:
 * a collection nobody made is the loudest thing on the row, a scheduled one is
 * settled, and everything else is still waiting on somebody.
 */
function pickupBadge(pickupStatus: string | null): string {
  if (pickupStatus === "SCHEDULED") return "mv-badge-success";
  if (["FAILED", "MISSED", "UNKNOWN"].includes(pickupStatus || "")) return "mv-badge-danger";
  return "mv-badge-warning";
}

export default function AdminPickups() {
  const { needsPickup, scheduled, problems, shipments } = useLoaderData<typeof loader>();
  return (
    <div className="mv-page-wide">
      <ShippingOperationsNav />

      <div className="mv-page-header">
        <div>
          <h1>Pickups</h1>
          <p>Labels and pickups are separate. Open one shipment to schedule, reschedule, or cancel its carrier collection.</p>
        </div>
      </div>

      <div className="mv-stat-grid">
        <div className="mv-stat"><span>Needs scheduling</span><strong>{needsPickup}</strong></div>
        <div className="mv-stat"><span>Scheduled</span><strong>{scheduled}</strong></div>
        <div className="mv-stat"><span>Needs attention</span><strong>{problems}</strong></div>
      </div>

      <section className="mv-panel">
        <div className="mv-table-wrap">
          <table className="mv-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Carrier</th>
                <th>Pickup location</th>
                <th>Plan</th>
                <th>Carrier confirmation</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shipments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="mv-muted" style={{ padding: "2rem", textAlign: "center" }}>
                    No pickups need attention.
                  </td>
                </tr>
              ) : shipments.map((shipment) => (
                <tr key={shipment.id}>
                  <td>
                    <strong>{shipment.order.shopifyOrderName}</strong>
                    <div className="mv-muted">{shipment.order.seller.storeName}</div>
                  </td>
                  <td>
                    {shipment.carrier || "—"}
                    <div className="mv-muted">{shipment.serviceName || "—"}</div>
                  </td>
                  <td>{shipment.originLocation ? `${shipment.originLocation.code} — ${shipment.originLocation.name}` : "Origin snapshot on shipment"}</td>
                  <td>{shipment.pickupMode === "REGULAR" ? "Regular pickup" : shipment.pickupMode === "DROPOFF" ? "Drop-off" : "One-off pickup"}</td>
                  <td>
                    <span className={`mv-badge ${pickupBadge(shipment.pickupStatus)}`}>{shipment.pickupStatus || "Not scheduled"}</span>
                    {shipment.pickupScheduledFor ? <div className="mv-muted">{formatDateTime(shipment.pickupScheduledFor)}</div> : null}
                    {shipment.pickupLastError ? <div style={{ color: "var(--mv-admin-danger)" }}>{shipment.pickupLastError}</div> : null}
                  </td>
                  <td><Link to={`/admin/shipping/${shipment.id}#pickup`}>Manage</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
