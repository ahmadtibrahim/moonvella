import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerAuth(request);

  const [
    totalSellers,
    pendingApplications,
    approvedSellers,
    ordersAgg,
    recentApplications,
    topSellersRaw,
    integrationFailures,
    lastSync,
  ] = await Promise.all([
    prisma.seller.count(),
    prisma.merchantApplication.count({ where: { status: "PENDING" } }),
    prisma.seller.count({ where: { status: "APPROVED" } }),
    prisma.order.aggregate({
      _sum: { moonvellaTotal: true },
      _count: true,
    }),
    prisma.merchantApplication.findMany({
      where: { status: "PENDING" },
      orderBy: { submittedAt: "desc" },
      take: 5,
      select: {
        id: true,
        storeName: true,
        shopDomain: true,
        submittedAt: true,
        contactName: true,
      },
    }),
    prisma.seller.findMany({
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
    }),
    prisma.webhookEvent.count({
      where: {
        status: "FAILED",
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.seller.aggregate({ _max: { lastSyncAt: true } }),
  ]);

  const topSellers = topSellersRaw
    .map((s) => ({
      id: s.id,
      storeName: s.storeName,
      shopDomain: s.shopDomain,
      orderCount: s._count.orders,
      revenue: s.orders.reduce((sum, o) => sum + (o.moonvellaTotal || 0), 0),
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return {
    stats: {
      totalSellers,
      pendingApplications,
      approvedSellers,
      moonvellaRevenue: ordersAgg._sum.moonvellaTotal || 0,
      totalOrders: ordersAgg._count,
      integrationFailures,
      lastSync: lastSync._max.lastSyncAt,
    },
    recentApplications,
    topSellers,
  };
}

function money(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateTime(date: Date | string | null) {
  if (!date) return "Never";
  return new Date(date).toLocaleString();
}

function StatCard({
  title,
  value,
  subtitle,
  accent,
}: {
  title: string;
  value: string | number;
  subtitle: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #e2e8f0",
        borderLeft: `4px solid ${accent || "#082a4a"}`,
        borderRadius: 12,
        padding: "1.5rem",
      }}
    >
      <div
        style={{
          fontSize: "0.7rem",
          color: "#64748b",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "0.75rem",
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        {value}
      </div>
      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{subtitle}</div>
    </div>
  );
}

const section: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
};

export default function AdminDashboard() {
  const { stats, recentApplications, topSellers } = useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
          Admin Dashboard
        </h1>
        <p style={{ color: "#64748b", fontSize: "0.875rem" }}>
          Overview of MoonVella marketplace activity
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "1.5rem",
          marginBottom: "2rem",
        }}
      >
        <StatCard
          title="Total Sellers"
          value={stats.totalSellers}
          subtitle={`${stats.approvedSellers} approved`}
        />
        <StatCard
          title="Pending Applications"
          value={stats.pendingApplications}
          subtitle="Awaiting review"
          accent="#f59e0b"
        />
        <StatCard
          title="MoonVella Revenue"
          value={money(stats.moonvellaRevenue)}
          subtitle={`${stats.totalOrders} orders`}
        />
        <StatCard
          title="Integration Failures (24h)"
          value={stats.integrationFailures}
          subtitle={stats.integrationFailures > 0 ? "Needs attention" : "All systems operational"}
          accent={stats.integrationFailures > 0 ? "#dc2626" : "#059669"}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: "1.5rem",
          marginBottom: "2rem",
        }}
      >
        <section style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a" }}>
              Pending Applications
            </h2>
            <Link to="/admin/applications" style={{ fontSize: "0.75rem", color: "#082a4a", fontWeight: 500 }}>
              View all &rarr;
            </Link>
          </div>
          {recentApplications.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: "0.875rem", textAlign: "center", padding: "2rem" }}>
              No pending applications
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {recentApplications.map((app) => (
                <div
                  key={app.id}
                  style={{
                    padding: "1rem",
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{app.storeName}</div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{app.shopDomain}</div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                    {app.contactName}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={section}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a" }}>
              Top Sellers by Sales
            </h2>
            <Link to="/admin/rankings" style={{ fontSize: "0.75rem", color: "#082a4a", fontWeight: 500 }}>
              View all &rarr;
            </Link>
          </div>
          {topSellers.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: "0.875rem", textAlign: "center", padding: "2rem" }}>
              No sales data available
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {topSellers.map((seller, index) => (
                <div
                  key={seller.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "1rem",
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: "#082a4a",
                        color: "white",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                      }}
                    >
                      {index + 1}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{seller.storeName}</div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{seller.shopDomain}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 600, fontSize: "0.875rem", color: "#082a4a" }}>
                      {money(seller.revenue)}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                      {seller.orderCount} orders
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section style={section}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Integration Health
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1rem",
          }}
        >
          <div
            style={{
              padding: "1rem",
              background: stats.integrationFailures > 0 ? "#fef2f2" : "#f0fdf4",
              border: `1px solid ${stats.integrationFailures > 0 ? "#fecaca" : "#bbf7d0"}`,
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Failed Webhooks (24h)</div>
            <div
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                color: stats.integrationFailures > 0 ? "#dc2626" : "#059669",
              }}
            >
              {stats.integrationFailures}
            </div>
          </div>
          <div style={{ padding: "1rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8 }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Last Sync</div>
            <div style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a" }}>
              {formatDateTime(stats.lastSync)}
            </div>
          </div>
          <div style={{ padding: "1rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8 }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>System Status</div>
            <div
              style={{
                fontSize: "1rem",
                fontWeight: 600,
                color: stats.integrationFailures > 0 ? "#dc2626" : "#059669",
              }}
            >
              {stats.integrationFailures > 0 ? "Issues Detected" : "Operational"}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
