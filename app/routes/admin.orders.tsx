import { Link, useLoaderData } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: { request: Request }) {
  const user = await requireOwnerAuth(request as any);
  return { user };
}

export default function AdminOrders() {
  const { user } = useLoaderData();
  const { prisma } = await import("~/db.server");

  const allOrders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      moonvellaTotal: true,
      createdAt: true,
      seller: {
        select: { storeName: true },
      },
    },
  });

  const totalRevenue = allOrders.reduce((sum, order) => sum + (order.moonvellaTotal || 0), 0);

  return { user, allOrders, totalRevenue };
}

export default function AdminOrdersPage() {
  const { user, allOrders, totalRevenue } = useLoaderData();

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 0" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: "700", color: "#082a4a", marginBottom: "1rem" }}>
        Orders
      </h1>

      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Order management and tracking
      </p>

      {/* Stats */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem", marginBottom: "2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "2rem", fontWeight: "700", color: "#082a4a" }}>{allOrders.length}</div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Orders</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "2rem", fontWeight: "700", color: "#dc2626" }}>`$${(totalRevenue / 100).toLocaleString()}`</div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>MoonVella Revenue</div>
          </div>
        </div>
      </div>

      {/* Orders Table */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Order #</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Seller</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>MoonVella</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Date</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5px" }}>
          {allOrders.map((order) => {
            const date = new Date(order.createdAt).toLocaleDateString();
            const price = (order.moonvellaTotal || 0) / 100;

            return (
              <div key={order.id} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.75rem 1rem",
                background: "white",
                borderBottom: "1px solid #f1f5f9",
              }}>
                <span style={{ fontSize: "0.75rem", color: "#1e293b" }}>#{order.id}</span>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{order.seller?.storeName || "Unknown"}</span>
                <span style={{ fontSize: "0.875rem", color: "#dc2626", fontWeight: "600" }}>`$${price.toFixed(2)}`</span>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{date}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #e2e8f0" }}>
        <p style={{ fontSize: "0.75rem", color: "#64748b" }}>
          <Link to="/admin" style={{ color: "#082a4a", fontWeight: "500" }}>
            ← Back to Dashboard
          </Link>
        </p>
      </div>
    </div>
  );
}