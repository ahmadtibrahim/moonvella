import React from "react";
import { useFetcher, useLoaderData } from "react-router";
import { requireSellerContext } from "../services/seller.server";
import { listCatalog } from "../services/catalog.server";

export const loader = async ({ request }) => {
  const context = await requireSellerContext(request);
  const products = await listCatalog(context);

  return {
    access: context.access,
    canViewWholesale: context.canViewWholesale,
    canImport: context.canImport,
    products,
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

  const markupRaw = Number(formData.get("markupPercent") || 0);
  const markupPercent = Number.isFinite(markupRaw) && markupRaw >= 0 ? markupRaw : 0;
  const customWholesalePrice = parseOptionalCents(formData.get("customWholesalePrice"));
  const customRetailPrice = parseOptionalCents(formData.get("customRetailPrice"));

  const { admin } = await authenticate.admin(request);
  const result = await importProductForSeller(admin, context.seller.id, productId, {
    markupPercent,
    customWholesalePrice,
    customRetailPrice,
  });

  if (!result.ok) {
    return { ok: false, error: result.error || "Import failed." };
  }

  return {
    ok: true,
    updated: result.updated === true,
    alreadyImported: result.alreadyImported === true,
    shopifyProductId: result.shopifyProductId,
    warnings: result.warnings || [],
  };
};

function parseOptionalCents(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function CatalogPage() {
  const { access, canViewWholesale, canImport, products } = useLoaderData();
  const fetcher = useFetcher();

  const [search, setSearch] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState("");
  const [sortBy, setSortBy] = React.useState("name");

  const categories = Array.from(new Set(products.map((p) => p.category))).sort();

  const filtered = products.filter((product) => {
    const matchesSearch =
      product.name.toLowerCase().includes(search.toLowerCase()) ||
      (product.description || "").toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !selectedCategory || product.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "price-low" && canViewWholesale) {
      return a.wholesalePrice - b.wholesalePrice;
    }
    if (sortBy === "price-high" && canViewWholesale) {
      return b.wholesalePrice - a.wholesalePrice;
    }
    return a.name.localeCompare(b.name);
  });

  const statusMessage =
    access === "APPROVED"
      ? null
      : access === "SUSPENDED"
        ? "Your seller account is suspended. Wholesale pricing and importing are unavailable."
        : access === "REJECTED"
          ? "Your application was not approved. Wholesale pricing and importing are unavailable."
          : "Your application is under review. Wholesale pricing and importing unlock after approval.";

  return (
    <s-page heading="Product Catalog">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">
            {canViewWholesale ? "Product Catalog" : "Product Catalog Preview"}
          </h2>
          <p className="mv-page-subtitle">
            {canViewWholesale
              ? "Wholesale products from MoonVella. Import to your store and start selling."
              : "Browse MoonVella products. Wholesale pricing and import tools unlock after approval."}
          </p>
        </div>

        {statusMessage && (
          <div className="mv-section-card" style={{ marginBottom: "1.5rem" }}>
            <span
              className={`mv-badge ${
                access === "SUSPENDED" || access === "REJECTED"
                  ? "mv-badge-danger"
                  : "mv-badge-warning"
              }`}
            >
              {access}
            </span>
            <p className="mv-page-subtitle" style={{ marginTop: "0.75rem" }}>
              {statusMessage}
            </p>
          </div>
        )}

        <div className="mv-filter-row">
          <input
            type="text"
            className="mv-search-input"
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="mv-filter-group">
            <span className="mv-filter-label">Category</span>
            <select
              className="mv-filter-select"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="">All Categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          {canViewWholesale && (
            <div className="mv-filter-group">
              <span className="mv-filter-label">Sort</span>
              <select
                className="mv-filter-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="name">Sort by Name</option>
                <option value="price-low">Wholesale (Low to High)</option>
                <option value="price-high">Wholesale (High to Low)</option>
              </select>
            </div>
          )}
        </div>

        <div className="mv-product-grid">
          {sorted.map((product) => (
            <div className="mv-product-card" key={product.id}>
              <div className="mv-product-image">
                {product.image ? (
                  <img
                    src={product.image}
                    alt={product.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <span className="mv-product-placeholder">
                    {product.name.substring(0, 2)}
                  </span>
                )}
              </div>
              <div className="mv-product-info">
                <h4 className="mv-product-name">{product.name}</h4>
                <span className="mv-product-category">{product.category}</span>
              </div>

              <div className="mv-product-details">
                <div className="mv-product-detail-row">
                  <span className="mv-product-detail-label">Category</span>
                  <span className="mv-product-detail-value">{product.category}</span>
                </div>
                <div className="mv-product-detail-row">
                  <span className="mv-product-detail-label">Availability</span>
                  <span className="mv-product-detail-value">
                    <span
                      className={`mv-badge ${
                        product.availability === "AVAILABLE"
                          ? "mv-badge-instock"
                          : "mv-badge-danger"
                      }`}
                    >
                      {product.availability === "AVAILABLE" ? "Available" : "Unavailable"}
                    </span>
                  </span>
                </div>

                {canViewWholesale && (
                  <>
                    <div className="mv-product-detail-row">
                      <span className="mv-product-detail-label">Wholesale</span>
                      <span className="mv-product-detail-value">
                        {money(product.wholesalePrice)}
                      </span>
                    </div>
                    <div className="mv-product-detail-row">
                      <span className="mv-product-detail-label">Suggested retail</span>
                      <span className="mv-product-detail-value">
                        {money(product.suggestedRetailPrice)}
                      </span>
                    </div>
                    <div className="mv-product-detail-row">
                      <span className="mv-product-detail-label">Est. profit</span>
                      <span className="mv-product-detail-value">
                        {money(product.estimatedProfit)}
                      </span>
                    </div>
                    <div className="mv-product-detail-row">
                      <span className="mv-product-detail-label">Inventory</span>
                      <span className="mv-product-detail-value">{product.inventory}</span>
                    </div>
                  </>
                )}
              </div>

              <div className="mv-product-actions">
                {/* The marketing kit. Approved sellers only, and the route
                    behind the link re-checks that rather than trusting the
                    link: the archive is built from approved, seller-visible
                    records and must never be reachable by URL alone. */}
                {canViewWholesale ? (
                  <a
                    className="mv-import-btn"
                    style={{ display: "block", textAlign: "center", marginBottom: "0.4rem" }}
                    href={`/app/marketing-pack?productId=${encodeURIComponent(product.id)}`}
                  >
                    Download marketing pack
                  </a>
                ) : null}

                {canImport ? (
                  <fetcher.Form method="post">
                    <input type="hidden" name="productId" value={product.id} />
                    {canViewWholesale && (
                      <details className="mv-import-options">
                        <summary>Pricing options</summary>
                        <label className="mv-import-field">
                          <span>Markup %</span>
                          <input
                            type="number"
                            name="markupPercent"
                            min="0"
                            step="1"
                            placeholder="0"
                          />
                        </label>
                        <label className="mv-import-field">
                          <span>Custom wholesale ($)</span>
                          <input
                            type="number"
                            name="customWholesalePrice"
                            min="0"
                            step="0.01"
                            placeholder={(product.wholesalePrice / 100).toFixed(2)}
                          />
                        </label>
                        <label className="mv-import-field">
                          <span>Custom retail ($)</span>
                          <input
                            type="number"
                            name="customRetailPrice"
                            min="0"
                            step="0.01"
                            placeholder={(product.suggestedRetailPrice / 100).toFixed(2)}
                          />
                        </label>
                      </details>
                    )}
                    <button
                      type="submit"
                      className="mv-import-btn"
                      disabled={fetcher.state !== "idle"}
                    >
                      {fetcher.state !== "idle" ? "Importing..." : "Import to Store"}
                    </button>
                  </fetcher.Form>
                ) : (
                  <div
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "0.75rem",
                      textAlign: "center",
                    }}
                  >
                    Wholesale pricing and import unlock after approval.
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {sorted.length === 0 && (
          <div className="mv-section-card" style={{ textAlign: "center", padding: "3rem" }}>
            <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>
              No products found matching your criteria.
            </p>
          </div>
        )}

        {fetcher.data?.ok && (
          <div className="mv-section-card" style={{ marginTop: "1rem" }}>
            <p style={{ color: "#059669", fontSize: "0.875rem", margin: 0 }}>
              {fetcher.data.updated
                ? "Re-synced to your Shopify store — product, prices and inventory updated."
                : "Imported to your Shopify store. View it under My Products."}
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
