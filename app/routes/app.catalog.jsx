import React from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { products as moonvillaProducts } from "../data/moonvillaData";
import { applicationStatus } from "../data/moonvellaState";

const isApproved = applicationStatus === "approved";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    const { authenticate } = await import("../shopify.server");
    await authenticate.admin(request);
  }

  return null;
};

export default function CatalogPage() {
  const shopify = useAppBridge();
  const handleImport = (product) => {
    shopify.toast.show(
      `${product.name} added to My Products. Real Shopify product import will be connected later.`,
    );
  };

  const [search, setSearch] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState("");
  const [selectedSize, setSelectedSize] = React.useState("");
  const [selectedFeature, setSelectedFeature] = React.useState("");
  const [sortBy, setSortBy] = React.useState("name");

  const products = moonvillaProducts;

  const filteredProducts = products.filter((product) => {
    const matchesSearch =
      product.name.toLowerCase().includes(search.toLowerCase()) ||
      product.sku.toLowerCase().includes(search.toLowerCase());

    const matchesCategory =
      !selectedCategory || product.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  const sortedProducts = [...filteredProducts].sort((a, b) => {
    if (sortBy === "name") {
      return a.name.localeCompare(b.name);
    }
    if (sortBy === "price-low") {
      return a.wholesaleCost - b.wholesaleCost;
    }
    if (sortBy === "price-high") {
      return b.wholesaleCost - a.wholesaleCost;
    }
    return 0;
  });

  if (!isApproved) {
    return (
      <s-page heading="Product Catalog">
        <div className="mv-container">
          <div className="mv-page-header">
            <h2 className="mv-page-title">Product Catalog Preview</h2>
            <p className="mv-page-subtitle">
              Browse MoonVella products. Wholesale pricing and import tools unlock after approval.
            </p>
          </div>

          <div className="mv-section-card" style={{ textAlign: 'center', padding: '2rem' }}>
            <span className="mv-badge mv-badge-warning" style={{ fontSize: '0.875rem', padding: '0.5rem 1rem', marginBottom: '1rem', display: 'inline-block' }}>
              Preview Mode — Wholesale pricing locked
            </span>
          </div>

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
                <option value="Pillows">Pillows</option>
                <option value="Duvets">Duvets</option>
                <option value="Mattress Protectors">Mattress Protectors</option>
                <option value="Pillow Protectors">Pillow Protectors</option>
                <option value="Bundles">Bundles</option>
              </select>
            </div>
            <div className="mv-filter-group">
              <span className="mv-filter-label">Size</span>
              <select
                className="mv-filter-select"
                value={selectedSize}
                onChange={(e) => setSelectedSize(e.target.value)}
              >
                <option value="">All Sizes</option>
                <option value="Small">Small</option>
                <option value="Medium">Medium</option>
                <option value="Large">Large</option>
              </select>
            </div>
            <div className="mv-filter-group">
              <span className="mv-filter-label">Feature</span>
              <select
                className="mv-filter-select"
                value={selectedFeature}
                onChange={(e) => setSelectedFeature(e.target.value)}
              >
                <option value="">All Features</option>
                <option value="Bestseller">Bestseller</option>
                <option value="New">New</option>
                <option value="Popular">Popular</option>
                <option value="Hypoallergenic">Hypoallergenic</option>
              </select>
            </div>
            <div className="mv-filter-group">
              <span className="mv-filter-label">Sort</span>
              <select
                className="mv-filter-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="name">Sort by Name</option>
                <option value="price-low">Wholesale Cost (Low to High)</option>
                <option value="price-high">Wholesale Cost (High to Low)</option>
              </select>
            </div>
          </div>

          <div className="mv-product-grid">
            {sortedProducts.map((product) => (
              <div className="mv-product-card" key={product.id} style={{ opacity: 0.85 }}>
                <div className="mv-product-image">
                  <span className="mv-product-placeholder">{product.name.substring(0, 2)}</span>
                </div>
                <div className="mv-product-info">
                  <h4 className="mv-product-name">{product.name}</h4>
                  <p className="mv-product-sku">SKU: {product.sku}</p>
                  <span className="mv-product-category">{product.category}</span>
                </div>
                <div className="mv-product-details">
                  <div className="mv-product-detail-row">
                    <span className="mv-product-detail-label">Category</span>
                    <span className="mv-product-detail-value">{product.category}</span>
                  </div>
                  <div className="mv-product-detail-row">
                    <span className="mv-product-detail-label">Status</span>
                    <span className="mv-product-detail-value">
                      <span className="mv-badge mv-badge-instock">In Stock</span>
                    </span>
                  </div>
                </div>
                <div className="mv-product-tags">
                  {product.tags.map((tag, i) => (
                    <span key={i} className="mv-product-tag">{tag}</span>
                  ))}
                </div>
                <div className="mv-product-actions">
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textAlign: 'center', width: '100%' }}>
                    Wholesale pricing locked
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textAlign: 'center', width: '100%', marginTop: '0.25rem' }}>
                    Approved partners can view pricing and import this product.
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mv-section-card" style={{ textAlign: 'center', padding: '2rem', marginTop: '1.5rem' }}>
            <span className="mv-badge mv-badge-warning" style={{ fontSize: '0.875rem', padding: '0.5rem 1rem', display: 'inline-block', marginBottom: '1rem' }}>
              Preview Mode — Wholesale pricing locked
            </span>
            <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 1.5rem' }}>
              Approved partners can view wholesale pricing, profit estimates, and import products to their store.
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="mv-btn mv-btn-primary" onClick={() => window.location.href = "/app/status"}>
                View Application Status
              </button>
              <button className="mv-btn mv-btn-secondary" onClick={() => window.location.href = "/app/application"}>
                Edit Application
              </button>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    <s-page heading="Product Catalog">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Product Catalog</h2>
          <p className="mv-page-subtitle">
            Premium bedding products from trusted suppliers. Import to your store and start selling today.
          </p>
        </div>

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
              <option value="Pillows">Pillows</option>
              <option value="Duvets">Duvets</option>
              <option value="Mattress Protectors">Mattress Protectors</option>
              <option value="Pillow Protectors">Pillow Protectors</option>
              <option value="Bundles">Bundles</option>
            </select>
          </div>
          <div className="mv-filter-group">
            <span className="mv-filter-label">Size</span>
            <select
              className="mv-filter-select"
              value={selectedSize}
              onChange={(e) => setSelectedSize(e.target.value)}
            >
              <option value="">All Sizes</option>
              <option value="Small">Small</option>
              <option value="Medium">Medium</option>
              <option value="Large">Large</option>
            </select>
          </div>
          <div className="mv-filter-group">
            <span className="mv-filter-label">Feature</span>
            <select
              className="mv-filter-select"
              value={selectedFeature}
              onChange={(e) => setSelectedFeature(e.target.value)}
            >
              <option value="">All Features</option>
              <option value="Bestseller">Bestseller</option>
              <option value="New">New</option>
              <option value="Popular">Popular</option>
              <option value="Hypoallergenic">Hypoallergenic</option>
            </select>
          </div>
          <div className="mv-filter-group">
            <span className="mv-filter-label">Sort</span>
            <select
              className="mv-filter-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
            >
              <option value="name">Sort by Name</option>
              <option value="price-low">Wholesale Cost (Low to High)</option>
              <option value="price-high">Wholesale Cost (High to Low)</option>
            </select>
          </div>
        </div>

        <div className="mv-product-grid">
          {sortedProducts.map((product) => (
            <div className="mv-product-card" key={product.id}>
              <div className="mv-product-image">
                <span className="mv-product-placeholder">{product.name.substring(0, 2)}</span>
              </div>
              <div className="mv-product-info">
                <h4 className="mv-product-name">{product.name}</h4>
                <p className="mv-product-sku">SKU: {product.sku}</p>
                <span className="mv-product-category">{product.category}</span>
              </div>
              <div className="mv-product-details">
                <div className="mv-product-detail-row">
                  <span className="mv-product-detail-label">Wholesale</span>
                  <span className="mv-product-detail-value">${product.wholesaleCost.toFixed(2)}</span>
                </div>
                <div className="mv-product-detail-row">
                  <span className="mv-product-detail-label">Retail</span>
                  <span className="mv-product-detail-value">${product.suggestedRetail.toFixed(2)}</span>
                </div>
                <div className="mv-product-detail-row">
                  <span className="mv-product-detail-label">Profit</span>
                  <span className="mv-product-detail-value">${product.estimatedProfit.toFixed(2)}</span>
                </div>
                <div className="mv-product-detail-row">
                  <span className="mv-product-detail-label">Inventory</span>
                  <span className="mv-product-detail-value">{product.inventory}</span>
                </div>
              </div>
              <div className="mv-product-tags">
                {product.tags.map((tag, i) => (
                  <span key={i} className="mv-product-tag">{tag}</span>
                ))}
              </div>
              <div className="mv-product-actions">
                <button className="mv-import-btn" onClick={() => handleImport(product)}>
                  Import to Store
                </button>
              </div>
            </div>
          ))}
        </div>

        {sortedProducts.length === 0 && (
          <div className="mv-section-card" style={{ textAlign: 'center', padding: '3rem' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>No products found matching your criteria.</p>
          </div>
        )}
      </div>
    </s-page>
  );
}