import { Link } from "react-router";

export async function loader() {
  const { prisma } = await import("~/db.server");

  const [
    totalSellers,
    pendingApplications,
    approvedSellers,
    sellersWithSales,
    totalMoonvellaSales,
    totalOrders,
    recentApplications,
    topSellersBySales,
    integrationFailures,
    lastSync,
  ] = await Promise.all([
    prisma.seller.count(),
    prisma.merchantApplication.count({ where: { status: "PENDING" } }),
    prisma.seller.count({ where: { status: "APPROVED" } }),
    prisma.seller.count({
      where: { status: "APPROVED", orders: { some: {} } },
    }),
    prisma.order.aggregate({
      _sum: { moonvellaTotal: true },
      where: { moonvellaTotal: { gt: 0 } },
    }),
    prisma.order.count({ where: { moonvellaTotal: { gt: 0 } } }),
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
        email: true,
      },
    }),
    prisma.seller.findMany({
      where: { status: "APPROVED" },
      orderBy: {
        orders: {
          _count: "desc",
        },
      },
      take: 5,
      select: {
        id: true,
        storeName: true,
        shopDomain: true,
        status: true,
        _count: { select: { orders: true } },
        orders: {
          where: { moonvellaTotal: { gt: 0 } },
          select: { moonvellaTotal: true },
        },
      },
    }),
    prisma.webhookEvent.count({
      where: { status: "FAILED", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
    prisma.seller.aggregate({
      _max: { lastSyncAt: true },
    }),
  ]);

  const totalMoonvellaSalesAmount = totalMoonvellaSales._sum.moonvellaTotal || 0;

  return {
    stats: {
      totalSellers,
      pendingApplications,
      approvedSellers,
      sellersWithSales,
      totalMoonvellaSales: totalMoonvellaSalesAmount,
      totalOrders,
      integrationFailures,
      lastSync: lastSync._max.lastSyncAt,
    },
    recentApplications,
    topSellers: topSellersBySales.map(s => ({
      ...s,
      totalMoonvellaSales: s.orders.reduce((sum, o) => sum + o.moonvellaTotal, 0),
    })),
  };
}

function StatCard({ title, value, subtitle, icon, highlight, warning }) {
  return (
    <div style={{
      background: "white",
      border: "1px solid #e2e8f0",
      borderRadius: "12px",
      padding: "1.5rem",
      borderLeft: highlight ? "4px solid #f59e0b" : warning ? "4px solid #dc2626" : "4px solid #082a4a",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "0.75rem", color: "#64748b", fontWeight: "500", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {title}
        </div>
        <div style={{ fontSize: "1.5rem" }}>{icon}</div>
      </div>
      <div style={{ fontSize: "1.875rem", fontWeight: "700", color: "#082a4a", marginBottom: "0.25rem" }}>
        {value}
      </div>
      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{subtitle}</div>
    </div>
  );
}

function formatCurrency(cents: number) {
  return `$${(cents / 100).toLocaleString()}`;
}

function formatDate(date: Date | null) {
  if (!date) return "N/A";
  return new Date(date).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(date: Date | null) {
  if (!date) return "Never";
  return new Date(date).toLocaleString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminDashboard() {
  const { stats, recentApplications, topSellers } = useLoaderData();

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.75rem", fontWeight: "700", color: "#082a4a", marginBottom: "0.25rem" }}>
          Admin Dashboard
        </h1>
        <p style={{ color: "#64748b", fontSize: "0.875rem" }}>
          Overview of MoonVella marketplace activity
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1.5rem", marginBottom: "2rem" }}>
        <StatCard
          title="Total Sellers"
          value={stats.totalSellers}
          subtitle={`${stats.approvedSellers} approved, ${stats.pendingApplications} pending`}
          icon="🏪"
        />
        <StatCard
          title="Pending Applications"
          value={stats.pendingApplications}
          subtitle="Awaiting review"
          icon="📋"
          highlight={true}
        />
        <StatCard
          title="Approved Sellers"
          value={stats.approvedSellers}
          subtitle={`${stats.sellersWithSales} with sales`}
          icon="✅"
        />
        <StatCard
          title="MoonVella Net Sales"
          value={formatCurrency(stats.totalMoonvellaSales)}
          subtitle={`${stats.totalOrders} orders`}
          icon="💰"
        />
        <StatCard
          title="Total Orders"
          value={stats.totalOrders}
          subtitle="Across all sellers"
          icon="📋"
        />
        <StatCard
          title="Integration Failures (24h)"
          value={stats.integrationFailures}
          subtitle={stats.integrationFailures > 0 ? "Needs attention" : "All systems operational"}
          icon="⚠️"
          warning={stats.integrationFailures > 0}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: "1.5rem", marginBottom: "2rem" }}>
        <section style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>Pending Applications</h2>
            <Link to="/admin/applications" style={{ fontSize: "0.75rem", color: "#082a4a", fontWeight: "500" }}>
              View all →
            </Link>
          </div>
          {recentApplications.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: "0.875rem", textAlign: "center", padding: "2rem" }}>
              No pending applications
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {recentApplications.map((app) => (
                <div key={app.id} style={{
                  padding: "1rem",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}>
                  <div>
                    <div style={{ fontWeight: "600", fontSize: "0.875rem" }}>{app.storeName}</div>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{app.shopDomain}</div>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                      Submitted {formatDate(app.submittedAt)} by {app.contactName}
                    </div>
                  </div>
                  <span style={{
                    padding: "0.25rem 0.75rem",
                    borderRadius: "9999px",
                    fontSize: "0.625rem",
                    fontWeight: "600",
                    background: "#fef3c7",
                    color: "#92400e",
                  }}>
                    Pending Review
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>Top Sellers by Sales</h2>
            <Link to="/admin/rankings" style={{ fontSize: "0.75rem", color: "#082a4a", fontWeight: "500" }}>
              View all →
            </Link>
          </div>
          {topSellers.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: "0.875rem", textAlign: "center", padding: "2rem" }}>
              No sales data available
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {topSellers.map((seller, index) => (
                <div key={seller.id} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "1rem",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <div style={{
                      width: "32px",
                      height: "32px",
                      borderRadius: "50%",
                      background: "#082a4a",
                      color: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.75rem",
                      fontWeight: "600",
                    }}>
                      {index + 1}
                    </div>
                    <div>
                      <div style={{ fontWeight: "600", fontSize: "0.875rem" }}>{seller.storeName}</div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{seller.shopDomain}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>
                      ${(seller.totalMoonvellaSales / 100).toLocaleString()}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                      {seller._count.orders} orders
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>Integration Health</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem" }}>
          <div style={{ padding: "1rem", background: stats.integrationFailures > 0 ? "#fef2f2" : "#f0fdf4", border: "1px solid", borderColor: stats.integrationFailures > 0 ? "#fecaca" : "#bbf7d0", borderRadius: "8px" }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.25rem" }}>Failed Webhooks (24h)</div>
            <div style={{ fontSize: "1.5rem", fontWeight: "700", color: stats.integrationFailures > 0 ? "#dc2626" : "#0a8754" }}>
              {stats.integrationFailures}
            </div>
          </div>
          <div style={{ padding: "1rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.25rem" }}>Last Sync</div>
            <div style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>
              {stats.lastSync ? formatDateTime(stats.lastSync) : "Never"}
            </div>
          </div>
          <div style={{ padding: "1rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px" }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.25rem" }}>System Status</div>
            <div style={{ fontSize: "1rem", fontWeight: "600", color: stats.integrationFailures > 0 ? "#dc2626" : "#0a8754" }}>
              {stats.integrationFailures > 0 ? "Issues Detected" : "Operational"}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}