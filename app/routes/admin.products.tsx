import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerAuth(request);

  const [products, totalProducts] = await Promise.all([
    prisma.product.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        name: true,
        sku: true,
        category: true,
        wholesalePrice: true,
        suggestedRetailPrice: true,
        isActive: true,
        _count: { select: { sellerProducts: true } },
      },
    }),
    prisma.product.count(),
  ]);

  return { products, totalProducts };
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AdminProducts() {
  const { products, totalProducts } = useLoaderData<typeof loader>();

  const headers = ["Name", "SKU", "Category", "Wholesale", "Retail", "Sellers", "Status"];
  const grid = "2fr 1fr 1fr 100px 100px 80px 90px";

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Products
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        MoonVella product catalog ({totalProducts} total)
      </p>

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
          {headers.map((h, i) => (
            <span key={h} style={{ textAlign: i >= 3 ? "right" : "left" }}>
              {h}
            </span>
          ))}
        </div>

        {products.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.875rem" }}>
            No products in the catalog yet.
          </p>
        ) : (
          products.map((p) => (
            <div
              key={p.id}
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                padding: "0.75rem 1rem",
                borderBottom: "1px solid #f1f5f9",
                fontSize: "0.8rem",
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: 600, color: "#1e293b" }}>{p.name}</span>
              <span style={{ color: "#64748b" }}>{p.sku}</span>
              <span style={{ color: "#64748b" }}>{p.category}</span>
              <span style={{ textAlign: "right" }}>{money(p.wholesalePrice)}</span>
              <span style={{ textAlign: "right" }}>{money(p.suggestedRetailPrice)}</span>
              <span style={{ textAlign: "right", color: "#64748b" }}>
                {p._count.sellerProducts}
              </span>
              <span
                style={{
                  textAlign: "right",
                  color: p.isActive ? "#059669" : "#dc2626",
                  fontWeight: 600,
                }}
              >
                {p.isActive ? "Active" : "Archived"}
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
