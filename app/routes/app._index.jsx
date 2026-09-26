import { Link, useLoaderData } from "react-router";
import { BLOCKED_MESSAGE, requireMerchantAccess } from "../services/seller.server";
import { useCurrency } from "../components/CurrencyDisplay";
import { prisma } from "../db.server";

export const loader = async ({ request }) => {
  const context = await requireMerchantAccess(request, "VIEW");

  let stats = { imported: 0, orders: 0, unitsSold: 0, moonvellaSales: 0 };
  let recentOrders = [];

  /**
   * Order totals and the order list are gated on `canViewOrders`, not on the
   * mere existence of a seller row.
   *
   * This page previously loaded both for any seller at all, which meant a
   * blocked store — whose rules table says orders are not readable — was shown
   * its order count, its revenue and its last five orders. The block message
   * appeared at the top of the page and the numbers underneath contradicted it.
   * `requireMerchantAccess` refuses a blocked store before this line now; the
   * separate `canViewOrders` check is what keeps the two gates from having to
   * agree by coincidence.
   */
  if (context.seller && context.canViewOrders) {
    const [imported, orderAgg, units, recent] = await Promise.all([
      prisma.sellerProduct.count({ where: { sellerId: context.seller.id } }),
      prisma.order.aggregate({
        where: { sellerId: context.seller.id },
        _count: true,
        _sum: { moonvellaTotal: true },
      }),
      prisma.orderItem.aggregate({
        where: { order: { sellerId: context.seller.id } },
        _sum: { quantity: true },
      }),
      prisma.order.findMany({
        where: { sellerId: context.seller.id },
        orderBy: { shopifyCreatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          shopifyOrderName: true,
          customerName: true,
          moonvellaTotal: true,
          currency: true,
          fulfillmentStatus: true,
          shopifyCreatedAt: true,
        },
      }),
    ]);

    stats = {
      imported,
      orders: orderAgg._count,
      unitsSold: units._sum.quantity || 0,
      moonvellaSales: orderAgg._sum.moonvellaTotal || 0,
    };
    recentOrders = recent;
  }

  return {
    access: context.access,
    sellerName: context.seller?.storeName ?? context.application?.storeName ?? null,
    stats,
    recentOrders,
    blockedMessage: BLOCKED_MESSAGE,
  };
};

export default function DashboardPage() {
  const { access, sellerName, stats, recentOrders, blockedMessage } = useLoaderData();
  // Every amount on this page is Canadian and says so; the header's currency
  // control decides whether it is also shown in US dollars. See `utils/money`.
  const { format } = useCurrency();
  const isApproved = access === "APPROVED";
  const isBlocked = access === "BLOCKED";

  return (
    <s-page heading="Dashboard">
      <div className="mv-container">
        <div className="mv-hero">
          <h1 className="mv-hero-title">
            {isApproved
              ? `Welcome back${sellerName ? `, ${sellerName}` : ""}`
              : "Welcome to MoonVella"}
          </h1>
          <p className="mv-hero-subtitle">
            Canadian-made quality. Wholesale bedding for your Shopify store.
          </p>
          <div style={{ display: "flex", gap: "1rem", marginTop: "1rem", flexWrap: "wrap" }}>
            <Link className="mv-btn mv-btn-primary" to="/app/catalog">
              {isApproved ? "Browse catalog" : "Preview catalog"}
            </Link>
            <Link className="mv-btn mv-btn-secondary" to="/app/status">
              View application status
            </Link>
          </div>
        </div>

        {!isApproved && (
          <div className="mv-section-card" style={{ marginBottom: "1.5rem" }}>
            <span
              className={`mv-badge ${
                access === "SUSPENDED" || access === "REJECTED" || isBlocked
                  ? "mv-badge-danger"
                  : "mv-badge-warning"
              }`}
            >
              {access}
            </span>
            <p className="mv-page-subtitle" style={{ marginTop: "0.75rem" }}>
              {isBlocked
                ? blockedMessage
                : "Wholesale pricing, importing and order intake unlock once your application is approved."}
            </p>
          </div>
        )}

        <div className="mv-stats-grid">
          <div className="mv-stat-card">
            <div className="mv-stat-title">Imported products</div>
            <div className="mv-stat-value">{stats.imported}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">MoonVella orders</div>
            <div className="mv-stat-value">{stats.orders}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Units sold</div>
            <div className="mv-stat-value">{stats.unitsSold}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">MoonVella wholesale sales</div>
            <div className="mv-stat-value">{format(stats.moonvellaSales)}</div>
          </div>
        </div>

        <div className="mv-section-card">
          <h3 className="mv-section-title">Recent MoonVella orders</h3>
          {recentOrders.length === 0 ? (
            <p className="mv-page-subtitle">
              No MoonVella orders yet. Once a customer buys an imported MoonVella product, it
              appears here.
            </p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.5rem", fontWeight: 600 }}>
                      {order.shopifyOrderName}
                    </td>
                    <td style={{ padding: "0.5rem" }}>{order.customerName || "—"}</td>
                    <td style={{ padding: "0.5rem" }}>
                      {format(order.moonvellaTotal)}
                    </td>
                    <td style={{ padding: "0.5rem" }}>{order.fulfillmentStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </s-page>
  );
}
