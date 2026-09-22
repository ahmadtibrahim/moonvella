import { Link, useLoaderData } from "react-router";
import { BLOCKED_MESSAGE, requireSellerContext } from "../services/seller.server";
import { prisma } from "../db.server";

export const loader = async ({ request }) => {
  const context = await requireSellerContext(request);

  let orders = [];
  if (context.seller && context.canViewOrders) {
    const rows = await prisma.order.findMany({
      where: { sellerId: context.seller.id },
      orderBy: { shopifyCreatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        shopifyOrderName: true,
        customerName: true,
        moonvellaTotal: true,
        currency: true,
        paymentStatus: true,
        fulfillmentStatus: true,
        shopifyCreatedAt: true,
        _count: { select: { items: true } },
        shipments: {
          select: { trackingNumber: true, trackingUrl: true, carrier: true, status: true },
        },
      },
    });
    orders = rows.map((o) => ({
      id: o.id,
      name: o.shopifyOrderName,
      customer: o.customerName || "—",
      items: o._count.items,
      moonvellaTotal: o.moonvellaTotal,
      currency: o.currency,
      paymentStatus: o.paymentStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      createdAt: o.shopifyCreatedAt,
      shipments: o.shipments,
    }));
  }

  return {
    access: context.access,
    canViewOrders: context.canViewOrders,
    orders,
    blockedMessage: BLOCKED_MESSAGE,
  };
};

function money(cents, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export default function OrdersPage() {
  const { access, canViewOrders, orders, blockedMessage } = useLoaderData();
  const isBlocked = access === "BLOCKED";

  if (!canViewOrders) {
    return (
      <s-page heading="Orders">
        <div className="mv-container">
          <div className="mv-page-header">
            <h2 className="mv-page-title">Orders</h2>
            <p className="mv-page-subtitle">
              MoonVella orders appear here after your store is approved and products are imported.
            </p>
          </div>
          <div className="mv-section-card" style={{ textAlign: "center", padding: "4rem 2rem" }}>
            <div style={{ fontSize: "4rem", marginBottom: "1.5rem" }}>📋</div>
            <h2 className="mv-page-title" style={{ marginBottom: "1rem" }}>
              {isBlocked ? "Orders are unavailable" : "Orders will appear here after approval"}
            </h2>
            {/* A blocked store is told what happened to its access, not that it
                should wait for a review that has already been decided. */}
            <p
              className="mv-page-subtitle"
              style={{ maxWidth: "500px", margin: "0 auto 2rem" }}
              role={isBlocked ? "alert" : undefined}
            >
              {isBlocked ? blockedMessage : `Current status: ${access}.`}
            </p>
            <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
              <Link className="mv-btn mv-btn-primary" to="/app/status">
                View Application Status
              </Link>
              <Link className="mv-btn mv-btn-secondary" to="/app/application">
                Edit Application
              </Link>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    <s-page heading="Orders">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Orders</h2>
          <p className="mv-page-subtitle">
            MoonVella product orders placed in your store, and their fulfillment and tracking.
          </p>
        </div>

        {orders.length === 0 ? (
          <div className="mv-section-card" style={{ textAlign: "center", padding: "3rem" }}>
            <p className="mv-page-subtitle">
              No MoonVella orders yet. Orders appear here once a customer buys an imported
              MoonVella product.
            </p>
          </div>
        ) : (
          <div className="mv-section-card">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.7rem" }}>
                  <th style={{ padding: "0.5rem" }}>Order</th>
                  <th style={{ padding: "0.5rem" }}>Customer</th>
                  <th style={{ padding: "0.5rem" }}>Items</th>
                  <th style={{ padding: "0.5rem" }}>MoonVella total</th>
                  <th style={{ padding: "0.5rem" }}>Payment</th>
                  <th style={{ padding: "0.5rem" }}>Fulfillment</th>
                  <th style={{ padding: "0.5rem" }}>Tracking</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.5rem", fontWeight: 600 }}>{o.name}</td>
                    <td style={{ padding: "0.5rem" }}>{o.customer}</td>
                    <td style={{ padding: "0.5rem" }}>{o.items}</td>
                    <td style={{ padding: "0.5rem" }}>
                      {money(o.moonvellaTotal, o.currency)}
                    </td>
                    <td style={{ padding: "0.5rem" }}>{o.paymentStatus}</td>
                    <td style={{ padding: "0.5rem" }}>{o.fulfillmentStatus}</td>
                    <td style={{ padding: "0.5rem" }}>
                      {o.shipments.length === 0
                        ? "—"
                        : o.shipments
                            .map((s) => s.trackingNumber || s.status)
                            .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </s-page>
  );
}
