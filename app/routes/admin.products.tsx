import { Link, useLoaderData } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: { request: Request }) {
  const user = await requireOwnerAuth(request as any);
  return { user };
}

export default function AdminProducts() {
  const { user } = useLoaderData();
  const { prisma } = await import("~/db.server");

  const [
    allProducts,
    totalRevenue,
  ] = await Promise.all([
    prisma.product.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        name: true,
        sku: true,
        price: true,
        seller: {
          select: { storeName: true },
        },
        orders: {
          select: { _count: true },
        },
        _sum: { price: true },
      },
    }),
    prisma.product.aggregate({
      _sum: { price: true },
    }),
  ]);

  return { user, allProducts, totalRevenue: totalRevenue._sum.price || 0 };
}

export default function AdminProductsPage() {
  const { user, allProducts, totalRevenue } = useLoaderData();

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 0" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: "700", color: "#082a4a", marginBottom: "1rem" }}>
        Products
      </h1>

      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Product catalog management
      </p>

      {/* Stats */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem", marginBottom: "2rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "2rem", fontWeight: "700", color: "#082a4a" }}>{allProducts.length}</div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Products</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "2rem", fontWeight: "700", color: "#082a4a" }}>`${totalRevenue?.toLocaleString() || "0"}`</div>
            <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Revenue</div>
          </div>
        </div>
      </div>

      {/* Products Table */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Name</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>SKU</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Price</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Seller</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Orders</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5px" }}>
          {allProducts.map((product) => {
            const price = (product.price || 0) / 100;
            const orderCount = product._count.orders;

            return (
              <div key={product.id} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.75rem 1rem",
                background: "white",
                borderBottom: "1px solid #f1f5f9",
              }}>
                <span style={{ fontSize: "0.875rem", color: "#1e293b" }}>{product.name}</span>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{product.sku}</span>
                <span style={{ fontSize: "0.875rem", color: "#082a4a", fontWeight: "600" }}>${price.toFixed(2)}</span>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{product.seller?.storeName || "N/A"}</span>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>{orderCount}</span>
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