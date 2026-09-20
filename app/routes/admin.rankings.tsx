import { Link, useLoaderData } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: { request: Request }) {
  const user = await requireOwnerAuth(request as any);
  return { user };
}

export default function AdminRankings() {
  const { user } = useLoaderData();
  const { prisma } = await import("~/db.server");

  const topSellers = await prisma.seller.findMany({
    where: { status: "APPROVED" },
    orderBy: {
      orders: {
        _count: "desc",
      },
    },
    take: 10,
    select: {
      id: true,
      storeName: true,
      shopDomain: true,
      _count: { select: { orders: true } },
      orders: {
        where: { moonvellaTotal: { gt: 0 } },
        select: { moonvellaTotal: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // Calculate total sales per seller
  const sellersWithSales = topSellers.map(seller => ({
    ...seller,
    totalMoonvellaSales: seller.orders.reduce((sum, order) => sum + (order.moonvellaTotal || 0), 0),
  }));

  // Calculate overall stats
  const totalRevenue = sellersWithSales.reduce((sum, seller) => sum + seller.totalMoonvellaSales, 0);
  const totalOrders = sellersWithSales.reduce((sum, seller) => sum + seller._count.orders, 0);

  return {
    user,
    sellersWithSales,
    totalRevenue,
    totalOrders,
  };
}

export default function AdminRankingsPage() {
  const { sellersWithSales, totalRevenue, totalOrders } = useLoaderData();

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 0" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: "700", color: "#082a4a", marginBottom: "1rem" }}>
        Seller Rankings
      </h1>

      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Top performers in the MoonVella marketplace
      </p>

      {/* Stats Summary */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem", marginBottom: "2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "2rem", fontWeight: "700", color: "#082a4a" }}>
              {totalOrders}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Orders</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "2rem", fontWeight: "700", color: "#082a4a" }}>
              `$${(totalRevenue / 100).toLocaleString()}`
            </div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>MoonVella Sales</div>
          </div>
        </div>
      </div>

      {/* Rankings Table */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Rank</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Seller</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>MoonVella Sales</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Orders</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5px" }}>
          {sellersWithSales.map((seller, index) => {
            const rank = index + 1;
            const salesInDollars = (seller.totalMoonvellaSales / 100).toLocaleString();

            return (
              <div key={seller.id} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.75rem 1rem",
                background: rank % 2 === 0 ? "#f8fafc" : "white",
                borderBottom: "1px solid #e2e8f0",
              }}>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{rank}</span>
                <span style={{ fontSize: "0.75rem", color: "#1e293b", fontWeight: "500" }}>{seller.storeName}</span>
                <span style={{ fontSize: "0.75rem", color: "#082a4a", fontWeight: "600" }}>{salesInDollars}</span>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{seller._count.orders}</span>
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