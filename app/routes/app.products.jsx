import { Link, useFetcher, useLoaderData } from "react-router";
import { withMerchantAccess } from "../services/seller.server";
import { prisma } from "../db.server";

/**
 * The imported-product list, with prices and SKUs, for approved sellers.
 *
 * The rows are only read when the caller may see wholesale figures. The page
 * already refused to render them for anybody else, but refusing to render is
 * not the same as not sending: a loader's return value is serialized into the
 * HTML as hydration data, so a suspended seller got the wholesale columns in
 * the page source with a message on top telling them pricing was locked. The
 * gate now sits on the query.
 */
export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async (context) => {
  let imported = [];
  if (context.seller && context.canViewWholesale) {
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
        // Prices and SKUs live on the sellable variant now, not on the family.
        // A family is a name and a code; the thing with a price is the variant.
        product: {
          select: {
            name: true,
            productCode: true,
            category: true,
            variants: {
              where: { isActive: true },
              orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
              select: {
                sku: true,
                wholesalePrice: true,
                suggestedRetailPrice: true,
                isDefault: true,
              },
            },
          },
        },
        variantMappings: {
          select: { productVariant: { select: { sku: true } } },
        },
      },
    });
    imported = rows.map((row) => {
      const variants = row.product.variants;
      // What the seller actually imported, when the import recorded it. Mappings
      // are written by the Shopify export path, so an older row may have none.
      const mapped = row.variantMappings
        .map((mapping) => mapping.productVariant.sku)
        .filter(Boolean);

      // A single SKU column is only honest when the row *is* one sellable item.
      // For a family with several variants the Product Code identifies the row
      // instead, and the count is shown so the row does not imply it is one.
      const singleSku = mapped.length === 1 ? mapped[0] : null;
      const sku = singleSku ?? (variants.length === 1 ? variants[0].sku : row.product.productCode);
      const extraVariants = singleSku
        ? 0
        : Math.max(0, (mapped.length || variants.length) - 1);

      // Family-level prices are the cheapest active variant's — the entry price
      // a seller can actually pay — matching the catalogue page.
      const cheapest = variants.reduce(
        (best, variant) => (!best || variant.wholesalePrice < best.wholesalePrice ? variant : best),
        null
      );

      return {
        id: row.id,
        productId: row.productId,
        name: row.product.name,
        sku,
        extraVariants,
        category: row.product.category,
        shopifyProductId: row.shopifyProductId,
        importedAt: row.importedAt,
        importStatus: row.importStatus,
        lastImportError: row.lastImportError,
        retailPrice: row.customRetailPrice ?? cheapest?.suggestedRetailPrice ?? 0,
        moonvillaCost: row.customWholesalePrice ?? cheapest?.wholesalePrice ?? 0,
        isActive: row.isActive,
      };
    });
  }

  return {
    access: context.access,
    canImport: context.canImport,
    imported,
  };
  });

export const action = async ({ request }) => {
  const { requireMerchantAccess, AccessError } = await import(
    "../services/seller.server"
  );
  const { authenticate } = await import("../shopify.server");
  const { importProductForSeller } = await import(
    "../services/shopifyImport.server"
  );

  let context;
  try {
    context = await requireMerchantAccess(request, "BUSINESS");
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
                    <td style={{ padding: "0.5rem", color: "#64748b" }}>
                      {p.sku}
                      {p.extraVariants > 0 ? (
                        <span
                          title={`This family contains ${p.extraVariants + 1} sellable variants.`}
                          style={{ color: "#94a3b8" }}
                        >
                          {" "}
                          +{p.extraVariants}
                        </span>
                      ) : null}
                    </td>
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
