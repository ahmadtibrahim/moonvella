import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerAuth(request);

  const sellers = await prisma.seller.findMany({
    where: { status: "APPROVED" },
    select: {
      id: true,
      storeName: true,
      shopDomain: true,
      _count: { select: { orders: true } },
      orders: {
        where: { moonvellaTotal: { gt: 0 } },
        select: { moonvellaTotal: true },
      },
    },
  });

  const ranked = sellers
    .map((s) => ({
      id: s.id,
      storeName: s.storeName,
      shopDomain: s.shopDomain,
      orderCount: s._count.orders,
      revenue: s.orders.reduce((sum, o) => sum + (o.moonvellaTotal || 0), 0),
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 25);

  const totalRevenue = ranked.reduce((sum, s) => sum + s.revenue, 0);
  const totalOrders = ranked.reduce((sum, s) => sum + s.orderCount, 0);

  return { ranked, totalRevenue, totalOrders };
}

function money(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AdminRankings() {
  const { ranked, totalRevenue, totalOrders } = useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Seller Rankings
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Top performers in the MoonVella marketplace
      </p>

      <div
        style={{
          background: "white",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          padding: "1.5rem",
          marginBottom: "2rem",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "1rem",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#082a4a" }}>
            {totalOrders}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Orders</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "2rem", fontWeight: 700, color: "#082a4a" }}>
            {money(totalRevenue)}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>MoonVella Sales</div>
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
            gridTemplateColumns: "60px 1fr 160px 100px",
            padding: "1rem",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            fontSize: "0.75rem",
            fontWeight: 700,
            color: "#082a4a",
          }}
        >
          <span>Rank</span>
          <span>Seller</span>
          <span style={{ textAlign: "right" }}>MoonVella Sales</span>
          <span style={{ textAlign: "right" }}>Orders</span>
        </div>

        {ranked.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.875rem" }}>
            No sales data yet.
          </p>
        ) : (
          ranked.map((seller, index) => (
            <div
              key={seller.id}
              style={{
                display: "grid",
                gridTemplateColumns: "60px 1fr 160px 100px",
                padding: "0.75rem 1rem",
                borderBottom: "1px solid #f1f5f9",
                fontSize: "0.8rem",
                alignItems: "center",
              }}
            >
              <span style={{ color: "#64748b" }}>{index + 1}</span>
              <span>
                <span style={{ fontWeight: 600, color: "#1e293b" }}>{seller.storeName}</span>
                <span style={{ color: "#94a3b8" }}> &middot; {seller.shopDomain}</span>
              </span>
              <span style={{ textAlign: "right", fontWeight: 700, color: "#082a4a" }}>
                {money(seller.revenue)}
              </span>
              <span style={{ textAlign: "right", color: "#64748b" }}>{seller.orderCount}</span>
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
