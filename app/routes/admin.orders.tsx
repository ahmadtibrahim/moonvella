import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "orders.view");
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      shopifyOrderName: true,
      supplierReference: true,
      currency: true,
      moonvellaTotal: true,
      customerName: true,
      paymentStatus: true,
      wholesalePaymentStatus: true,
      fulfillmentStatus: true,
      createdAt: true,
      seller: { select: { storeName: true } },
      _count: { select: { items: true, shipments: true } },
    },
  });
  return { orders };
}

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

const th: React.CSSProperties = { textAlign: "left", padding: "0.5rem", fontSize: "0.68rem", color: "#64748b" };
const td: React.CSSProperties = { padding: "0.5rem", fontSize: "0.8rem" };

export default function AdminOrders() {
  const { orders } = useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Orders
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        MoonVella supplier orders created from verified Shopify order webhooks.
      </p>

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              <th style={th}>Order</th>
              <th style={th}>Seller</th>
              <th style={th}>Items</th>
              <th style={th}>MoonVella total</th>
              <th style={th}>Customer paid</th>
              <th style={th}>Wholesale</th>
              <th style={th}>Fulfillment</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>
                  No supplier orders yet. They are created when a verified Shopify order contains an imported MoonVella product.
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr key={o.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={td}>
                    <Link to={`/admin/orders/${o.id}`} style={{ fontWeight: 600, color: "#082a4a" }}>
                      {o.shopifyOrderName}
                    </Link>
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>{o.supplierReference}</div>
                  </td>
                  <td style={td}>{o.seller?.storeName}</td>
                  <td style={td}>{o._count.items}</td>
                  <td style={td}>{money(o.moonvellaTotal, o.currency)}</td>
                  <td style={td}>{o.paymentStatus}</td>
                  <td style={{ ...td, color: o.wholesalePaymentStatus === "SUCCEEDED" ? "#059669" : "#b45309" }}>
                    {o.wholesalePaymentStatus}
                  </td>
                  <td style={td}>
                    {o.fulfillmentStatus} {o._count.shipments > 0 ? `(${o._count.shipments} shipment)` : ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
