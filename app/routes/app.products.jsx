import { Link, useFetcher, useLoaderData } from "react-router";
import { requireSellerContext } from "../services/seller.server";
import { prisma } from "../db.server";

export const loader = async ({ request }) => {
  const context = await requireSellerContext(request);

  let imported = [];
  if (context.seller) {
    const rows = await prisma.sellerProduct.findMany({
      where: { sellerId: context.seller.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        productId: true,
        shopifyProductId: true,
        isActive: true,
        importedAt: true,
        importStatus: true,
        lastImportError: true,
        customRetailPrice: true,
        customWholesalePrice: true,
        product: {
          select: {
            name: true,
            sku: true,
            category: true,
            images: true,
            wholesalePrice: true,
            suggestedRetailPrice: true,
          },
        },
      },
    });
    imported = rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      name: row.product.name,
      sku: row.product.sku,
      category: row.product.category,
      shopifyProductId: row.shopifyProductId,
      importedAt: row.importedAt,
      importStatus: row.importStatus,
      lastImportError: row.lastImportError,
      retailPrice: row.customRetailPrice ?? row.product.suggestedRetailPrice,
      moonvillaCost: row.customWholesalePrice ?? row.product.wholesalePrice,
      isActive: row.isActive,
    }));
  }

  return {
    access: context.access,
    canImport: context.canImport,
    imported,
  };
};

export const action = async ({ request }) => {
  const { requireApprovedSeller, AccessError } = await import(
    "../services/seller.server"
  );
  const { authenticate } = await import("../shopify.server");
  const { importProductForSeller } = await import(
    "../services/shopifyImport.server"
  );

  let context;
  try {
    context = await requireApprovedSeller(request);
  } catch (error) {
    if (error instanceof AccessError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");
  if (!productId) {
    return { ok: false, error: "Missing product." };
  }

  const { admin } = await authenticate.admin(request);
  const result = await importProductForSeller(admin, context.seller.id, productId, {
    resync: true,
  });

  if (!result.ok) {
    return { ok: false, error: result.error || "Re-sync failed." };
  }

  return {
    ok: true,
    updated: result.updated === true,
    warnings: result.warnings || [],
  };
};

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

const SYNC_LABELS = {
  NEVER: "Never synced",
  SYNCING: "Syncing",
  SUCCESS: "Synced",
  FAILED: "Failed",
};

function syncBadgeClass(status) {
  if (status === "SUCCESS") return "mv-badge mv-badge-instock";
  if (status === "FAILED") return "mv-badge mv-badge-danger";
  return "mv-badge mv-badge-warning";
}

export default function ProductsPage() {
  const { access, canImport, imported } = useLoaderData();
  const fetcher = useFetcher();

  if (!canImport) {
    return (
      <s-page heading="My Products">
        <div className="mv-container">
          <div className="mv-page-header">
            <h2 className="mv-page-title">Your MoonVella Products</h2>
            <p className="mv-page-subtitle">
              Manage imported products, pricing, and inventory sync in one place.
            </p>
          </div>
          <div className="mv-section-card" style={{ textAlign: "center", padding: "4rem 2rem" }}>
            <div style={{ fontSize: "4rem", marginBottom: "1.5rem" }}>📦</div>
            <h2 className="mv-page-title" style={{ marginBottom: "1rem" }}>
              No products yet
            </h2>
            <p className="mv-page-subtitle" style={{ maxWidth: "500px", margin: "0 auto 2rem" }}>
              Product import is available to approved MoonVella sellers. Current status: {access}.
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

  const activeListings = imported.filter((p) => p.isActive).length;

  return (
    <s-page heading="My Products">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Your MoonVella Products</h2>
          <p className="mv-page-subtitle">
            Products imported to your Shopify store from the MoonVella catalog.
          </p>
        </div>

        <div className="mv-stats-grid">
          <div className="mv-stat-card">
            <div className="mv-stat-title">Imported products</div>
            <div className="mv-stat-value">{imported.length}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Active listings</div>
            <div className="mv-stat-value">{activeListings}</div>
          </div>
        </div>

        {imported.length === 0 ? (
          <div className="mv-section-card" style={{ textAlign: "center", padding: "3rem" }}>
            <p className="mv-page-subtitle" style={{ marginBottom: "1.5rem" }}>
              You have not imported any MoonVella products yet.
            </p>
            <Link className="mv-btn mv-btn-primary" to="/app/catalog">
              Browse the catalog
            </Link>
          </div>
        ) : (
          <div className="mv-section-card">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.7rem" }}>
                  <th style={{ padding: "0.5rem" }}>Product</th>
                  <th style={{ padding: "0.5rem" }}>SKU</th>
                  <th style={{ padding: "0.5rem" }}>Retail</th>
                  <th style={{ padding: "0.5rem" }}>MoonVella cost</th>
                  <th style={{ padding: "0.5rem" }}>Sync</th>
                  <th style={{ padding: "0.5rem" }}>Shopify</th>
                  <th style={{ padding: "0.5rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {imported.map((p) => (
                  <tr key={p.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.5rem", fontWeight: 600 }}>{p.name}</td>
                    <td style={{ padding: "0.5rem", color: "#64748b" }}>{p.sku}</td>
                    <td style={{ padding: "0.5rem" }}>{money(p.retailPrice)}</td>
                    <td style={{ padding: "0.5rem" }}>{money(p.moonvillaCost)}</td>
                    <td style={{ padding: "0.5rem" }}>
                      <span
                        className={syncBadgeClass(p.importStatus)}
                        title={p.lastImportError || undefined}
                      >
                        {SYNC_LABELS[p.importStatus] || p.importStatus}
                      </span>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {p.shopifyProductId ? (
                        <a
                          href={`shopify:admin/products/${p.shopifyProductId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View in Shopify
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {p.shopifyProductId ? (
                        <fetcher.Form method="post">
                          <input type="hidden" name="productId" value={p.productId} />
                          <button
                            type="submit"
                            className="mv-btn mv-btn-secondary"
                            style={{ fontSize: "0.75rem", padding: "0.3rem 0.75rem" }}
                            disabled={fetcher.state !== "idle"}
                          >
                            {fetcher.state !== "idle" ? "Syncing..." : "Re-sync"}
                          </button>
                        </fetcher.Form>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {fetcher.data?.ok && (
          <div className="mv-section-card" style={{ marginTop: "1rem" }}>
            <p style={{ color: "#059669", fontSize: "0.875rem", margin: 0 }}>
              {fetcher.data.updated
                ? "Re-synced with Shopify — prices and inventory updated."
                : "Re-sync completed."}
            </p>
            {fetcher.data.warnings?.length > 0 && (
              <ul
                style={{
                  margin: "0.5rem 0 0",
                  paddingLeft: "1.25rem",
                  color: "var(--text-secondary)",
                  fontSize: "0.8rem",
                }}
              >
                {fetcher.data.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {fetcher.data?.error && (
          <div className="mv-section-card" style={{ marginTop: "1rem" }}>
            <p style={{ color: "var(--danger-red)", fontSize: "0.875rem", margin: 0 }}>
              {fetcher.data.error}
            </p>
          </div>
        )}
      </div>
    </s-page>
  );
}
