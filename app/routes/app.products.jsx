import { DataTable } from "../components/DataTable";
import { products as moonvillaProducts } from "../data/moonvillaData";
import { lowStockProducts } from "../data/moonvillaData";
import { applicationStatus } from "../data/moonvellaState";

const isApproved = applicationStatus === "approved";

export default function ProductsPage() {
  if (!isApproved) {
    return (
      <s-page heading="My Products">
        <div className="mv-container">
          <div className="mv-page-header">
            <h2 className="mv-page-title">Your MoonVella Products</h2>
            <p className="mv-page-subtitle">
              Manage imported products, pricing, and inventory sync in one place.
            </p>
          </div>

          <div className="mv-section-card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
            <div style={{ fontSize: '4rem', marginBottom: '1.5rem' }}>📦</div>
            <h2 className="mv-page-title" style={{ marginBottom: '1rem' }}>No products yet</h2>
            <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 2rem' }}>
              Your catalog import access is pending MoonVella approval.
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

  const products = moonvillaProducts;

  const activeListings = products.filter(
    (p) => p.status === "In Stock",
  ).length;

  const unitsSoldLast30Days = 126;
  const estimatedMonthlyProfit = 771;

  const rowColumns = [
    { key: "id", label: "Product", type: "text" },
    { key: "sku", label: "SKU", type: "text" },
    { key: "retailPrice", label: "Retail", type: "text" },
    { key: "moonvillaCost", label: "MoonVella Cost", type: "text" },
    { key: "inventory", label: "Inventory", type: "text" },
    {
      key: "syncStatus",
      label: "Sync Status",
      type: "badge",
    },
    { key: "margin", label: "Margin", type: "text" },
    {
      key: "status",
      label: "Status",
      type: "badge",
    },
    {
      key: "actions",
      label: "Actions",
      type: "action",
    },
  ];

  return (
    <s-page heading="My Products">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Your MoonVella Products</h2>
          <p className="mv-page-subtitle">
            Manage imported products, pricing, and inventory sync in one place.
          </p>
        </div>

        <div className="mv-stats-grid">
          <div className="mv-stat-card">
            <div className="mv-stat-title">Total imported products</div>
            <div className="mv-stat-value">{products.length}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Active listings</div>
            <div className="mv-stat-value">{activeListings}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Units sold last 30 days</div>
            <div className="mv-stat-value">{unitsSoldLast30Days}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Estimated monthly profit</div>
            <div className="mv-stat-value">${estimatedMonthlyProfit}</div>
          </div>
        </div>

        {lowStockProducts.length > 0 && (
          <div className="mv-alert-banner">
            <p className="mv-alert-text">
              {lowStockProducts.length} products are low in stock and may need restocking soon.
            </p>
            <div className="mv-alert-actions">
              <button className="mv-btn mv-btn-warning">View Details</button>
              <button className="mv-btn mv-btn-secondary">Restock</button>
            </div>
          </div>
        )}

        <div className="mv-section-card">
          <DataTable
            columns={rowColumns}
            rows={products}
            selectable={false}
          />
        </div>
      </div>
    </s-page>
  );
}