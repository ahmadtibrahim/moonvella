import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerAuth(request);

  const [shipments, totalShipments, delivered, exceptions] = await Promise.all([
    prisma.shipment.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        trackingNumber: true,
        carrier: true,
        status: true,
        shippedAt: true,
        order: {
          select: {
            shopifyOrderName: true,
            seller: { select: { storeName: true } },
          },
        },
      },
    }),
    prisma.shipment.count(),
    prisma.shipment.count({ where: { status: "DELIVERED" } }),
    prisma.shipment.count({ where: { status: "EXCEPTION" } }),
  ]);

  return { shipments, totalShipments, delivered, exceptions };
}

const grid = "1.2fr 1.5fr 1fr 110px 140px";

const statusColor: Record<string, string> = {
  PENDING: "#b45309",
  SHIPPED: "#0369a1",
  DELIVERED: "#059669",
  EXCEPTION: "#dc2626",
  CANCELLED: "#64748b",
};

export default function AdminShipping() {
  const { shipments, totalShipments, delivered, exceptions } =
    useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Shipping
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Shipment tracking across all sellers
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Shipments</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a" }}>{totalShipments}</div>
        </div>
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Delivered</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#059669" }}>{delivered}</div>
        </div>
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Exceptions</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#dc2626" }}>{exceptions}</div>
        </div>
      </div>

      <div
        style={{
          background: "white",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: grid,
            padding: "1rem",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            fontSize: "0.7rem",
            fontWeight: 700,
            color: "#082a4a",
          }}
        >
          <span>Order</span>
          <span>Seller</span>
          <span>Tracking</span>
          <span>Carrier</span>
          <span>Status</span>
        </div>

        {shipments.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.875rem" }}>
            No shipments yet.
          </p>
        ) : (
          shipments.map((s) => (
            <div
              key={s.id}
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                padding: "0.75rem 1rem",
                borderBottom: "1px solid #f1f5f9",
                fontSize: "0.8rem",
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: 600, color: "#1e293b" }}>
                {s.order?.shopifyOrderName || "\u2014"}
              </span>
              <span style={{ color: "#64748b" }}>
                {s.order?.seller?.storeName || "Unknown"}
              </span>
              <span style={{ color: "#64748b" }}>{s.trackingNumber || "\u2014"}</span>
              <span style={{ color: "#64748b" }}>{s.carrier || "\u2014"}</span>
              <span style={{ color: statusColor[s.status] || "#64748b", fontWeight: 600 }}>
                {s.status}
              </span>
            </div>
          ))
        )}
      </div>

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; Back to Dashboard
        </Link>
      </p>
    </div>
  );
}
