import { products } from "../data/moonvillaData";
import { applicationStatus, shopifyStoreProfile, shopifySalesReview } from "../data/moonvellaState";

const isApproved = applicationStatus === "approved";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    const { authenticate } = await import("../shopify.server");
    await authenticate.admin(request);
  }

  return null;
};

export default function DashboardPage() {
  const salesRetail = 1284;
  const profit = 771;
  const formattedSalesRetail = `$${salesRetail.toLocaleString()}`;
  const formattedProfit = `$${profit.toLocaleString()}`;

  if (!isApproved) {
    return (
      <s-page heading="Dashboard">
        <div className="mv-container">
          <div className="mv-hero">
            <h1 className="mv-hero-title">Welcome to MoonVella</h1>
            <p className="mv-hero-subtitle">
              Canadian-made quality. Dropship with confidence.
            </p>
          </div>

          <div className="mv-section-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '3rem' }}>📋</div>
              <div>
                <h2 className="mv-page-title" style={{ marginBottom: '0.5rem' }}>Application Pending Review</h2>
                <p className="mv-page-subtitle">
                  Your MoonVella dropship partner application is under review. 
                  Full dashboard access will unlock once approved.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
              <span className="mv-badge mv-badge-pending" style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}>
                Status: Pending Review
              </span>
              <span className="mv-badge mv-badge-processing" style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}>
                Submitted: January 15, 2025
              </span>
            </div>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button className="mv-btn mv-btn-primary" onClick={() => window.location.href = "/app/status"}>
                View Application Status
              </button>
              <button className="mv-btn mv-btn-secondary" onClick={() => window.location.href = "/app/application"}>
                Edit Application
              </button>
            </div>
          </div>

          <div className="mv-section-card">
            <h3 className="mv-section-title">Shopify store detected</h3>
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store name</span>
                <input type="text" className="mv-settings-input" value={shopifyStoreProfile.storeName} disabled />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Shop domain</span>
                <input type="text" className="mv-settings-input" value={shopifyStoreProfile.shopDomain} disabled />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Contact email</span>
                <input type="email" className="mv-settings-input" value={shopifyStoreProfile.contactEmail} disabled />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Country</span>
                <input type="text" className="mv-settings-input" value={shopifyStoreProfile.country} disabled />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Currency</span>
                <input type="text" className="mv-settings-input" value={shopifyStoreProfile.currency} disabled />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Shopify plan</span>
                <input type="text" className="mv-settings-input" value={shopifyStoreProfile.shopifyPlan} disabled />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store URL</span>
                <input type="url" className="mv-settings-input" value={shopifyStoreProfile.storeUrl} disabled />
              </div>
            </div>
          </div>

          <div className="mv-section-card">
            <h3 className="mv-section-title">Shopify sales review</h3>
            <p className="mv-branding-message" style={{ marginBottom: '1rem' }}>
              MoonVella will review recent Shopify activity before approving wholesale access.
            </p>
            <div className="mv-settings-grid" style={{ opacity: 0.7 }}>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Last 3 months sales</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifySalesReview.lastThreeMonthsSales ? `$${shopifySalesReview.lastThreeMonthsSales.toLocaleString()}` : "Available after connection"}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Last 3 months orders</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifySalesReview.lastThreeMonthsOrders ? shopifySalesReview.lastThreeMonthsOrders.toLocaleString() : "Available after connection"}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Average order value</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifySalesReview.averageOrderValue ? `$${shopifySalesReview.averageOrderValue.toLocaleString()}` : "Available after connection"}
                  disabled
                />
              </div>
              <div className="mv-settings-field" style={{ gridColumn: '1 / -1' }}>
                <span className="mv-settings-label">Main markets</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifySalesReview.mainMarkets.join(", ")}
                  disabled
                />
              </div>
            </div>
          </div>

          <div className="mv-section-card">
            <h3 className="mv-section-title">Product preview access</h3>
            <p className="mv-branding-message" style={{ marginBottom: '1rem' }}>
              You can preview the product catalog, but wholesale pricing and import tools unlock after approval.
            </p>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button className="mv-btn mv-btn-primary" onClick={() => window.location.href = "/app/catalog"}>
                View Product Preview
              </button>
              <button className="mv-btn mv-btn-secondary" onClick={() => window.location.href = "/app/status"}>
                View Application Status
              </button>
            </div>
          </div>

          <div className="mv-section-card" style={{ background: 'var(--accent-blue)', borderColor: 'var(--primary-color)' }}>
            <h3 className="mv-section-title" style={{ color: 'var(--primary-color)' }}>Quick actions</h3>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button className="mv-btn mv-btn-primary" onClick={() => window.location.href = "/app/status"}>
                Check Application Status
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

  const recommendedProducts = products.filter(
    (p) =>
      p.name === "Hotel Pillow" ||
      p.name === "All-Season Duvet" ||
      p.name === "Waterproof Mattress Protector",
  );

  return (
    <s-page heading="Dashboard">
      <div className="mv-container">
        <div className="mv-hero">
          <h1 className="mv-hero-title">Better sleep. Bigger possibilities.</h1>
          <p className="mv-hero-subtitle">
            Canadian-made quality. Dropship with confidence.
          </p>
        </div>

        <div className="mv-stats-grid">
          <div className="mv-stat-card">
            <div className="mv-stat-title">Imported products</div>
            <div className="mv-stat-value">{24}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Orders this month</div>
            <div className="mv-stat-value">{8}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Total sales retail</div>
            <div className="mv-stat-value">{formattedSalesRetail}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Estimated profit</div>
            <div className="mv-stat-value">{formattedProfit}</div>
          </div>
        </div>

        <div className="mv-dashboard-main">
          <div className="mv-dashboard-content">
            <div className="mv-section-card">
              <h3 className="mv-section-title">Sales trend</h3>
              <div className="mv-chart-placeholder">
                <div className="mv-chart-icon">📈</div>
                <p>Chart placeholder - real analytics will be connected later.</p>
              </div>
            </div>

            <div className="mv-section-card">
              <div className="mv-recommended-header">
                <h3 className="mv-recommended-title">Recommended products</h3>
              </div>
              <div className="mv-product-grid">
                {recommendedProducts.map((product) => (
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
                      <button className="mv-import-btn">Import to Store</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mv-dashboard-sidebar">
            <div className="mv-section-card">
              <h3 className="mv-section-title">Setup checklist</h3>
              <ul className="mv-checklist">
                <li className="mv-checklist-item">
                  <span className="mv-checklist-badge mv-done">✓</span>
                  <span className="mv-checklist-text">
                    <span className="mv-complete">Connect Shopify store</span> - complete
                  </span>
                </li>
                <li className="mv-checklist-item">
                  <span className="mv-checklist-badge mv-done">✓</span>
                  <span className="mv-checklist-text">
                    <span className="mv-complete">Add payment method</span> - complete
                  </span>
                </li>
                <li className="mv-checklist-item">
                  <span className="mv-checklist-badge mv-done">✓</span>
                  <span className="mv-checklist-text">
                    <span className="mv-complete">Set up branding</span> - complete
                  </span>
                </li>
                <li className="mv-checklist-item">
                  <span className="mv-checklist-badge mv-done">✓</span>
                  <span className="mv-checklist-text">
                    <span className="mv-complete">Review shipping zones</span> - complete
                  </span>
                </li>
                <li className="mv-checklist-item">
                  <span className="mv-checklist-badge mv-pending">!</span>
                  <span className="mv-checklist-text">
                    <span className="mv-pending">Start importing products</span> - pending
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}