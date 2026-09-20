import { applicationStatus, shopifyStoreProfile } from "../data/moonvellaState";

const isApproved = applicationStatus === "approved";

export default function SettingsPage() {
  return (
    <s-page heading="Settings">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Settings</h2>
          <p className="mv-page-subtitle">
            Configure how MoonVella products, orders, and inventory sync with your Shopify store.
          </p>
        </div>

        <div className="mv-section-card" style={{ marginBottom: '2rem' }}>
          <h3 className="mv-settings-title" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            Application Status
            <span className={`mv-badge ${isApproved ? "mv-badge-instock" : "mv-badge-pending"}`}>
              {isApproved ? "Approved" : "Pending Review"}
            </span>
          </h3>
          <p className="mv-branding-message" style={{ marginBottom: '1rem' }}>
            {isApproved 
              ? "Your store is approved. Full catalog access and product import are enabled." 
              : "Partner approval required before catalog access. "
            }
            {!isApproved && (
              <a href="/app/status" style={{ color: 'var(--primary-color)', fontWeight: '600' }}>View application status →</a>
            )}
          </p>
          {isApproved && (
            <p className="mv-branding-message" style={{ margin: 0 }}>
              Full catalog access and product import are enabled.
            </p>
          )}
        </div>

        <div className="mv-section-card" style={{ marginBottom: '2rem' }}>
          <h3 className="mv-settings-title">Store information detected from Shopify</h3>
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
          </div>
        </div>

        <div className="mv-settings-grid">
          <div className="mv-settings-card">
            <h3 className="mv-settings-title">Product Import Preferences</h3>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>Import product images</span>
            </label>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>Import product descriptions</span>
            </label>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Default price markup</span>
              <input type="number" className="mv-settings-input" defaultValue={2.0} step={0.1} disabled />
            </div>
          </div>

          <div className="mv-settings-card">
            <h3 className="mv-settings-title">Inventory & Sync</h3>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>Auto-sync inventory</span>
            </label>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Quantity buffer</span>
              <input type="number" className="mv-settings-input" defaultValue={5} disabled />
            </div>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>Low-stock alerts</span>
            </label>
          </div>

          <div className="mv-settings-card">
            <h3 className="mv-settings-title">Order Preferences</h3>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>Auto-import orders</span>
            </label>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Estimated delivery message</span>
              <input
                type="text"
                className="mv-settings-input"
                defaultValue="Typically ships within 2–4 business days."
                disabled
              />
            </div>
          </div>

          <div className="mv-settings-card">
            <h3 className="mv-settings-title">Billing & Payments</h3>
            <div className="mv-billing-info">
              <div className="mv-billing-text">
                <span className="mv-billing-card">VISA ending 4242</span>
                <span className="mv-billing-expiry">Expires 04/27</span>
              </div>
              <button className="mv-btn mv-btn-primary" disabled>Update</button>
            </div>
          </div>

          <div className="mv-settings-card">
            <h3 className="mv-settings-title">Notifications</h3>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>New order notifications</span>
            </label>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>Shipment updates</span>
            </label>
            <label className="mv-settings-checkbox">
              <input type="checkbox" checked disabled />
              <span>Payout and billing emails</span>
            </label>
          </div>
        </div>

        <div className="mv-branding-section">
          <h3 className="mv-branding-title">
            Branded Packing Slip
            <span className="mv-branding-status">Enabled</span>
          </h3>
          <p className="mv-branding-message">
            Enabled by default after approval. Your customers receive your store-branded packing slip while MoonVella remains behind the scenes.
          </p>
        </div>

        {/* TODO: MoonVella Admin Portal will be separate from merchant app and will manage:
          - Merchant approvals
          - Product publishing
          - Pricing management
          - Shipping zones configuration
          - Odoo catalog sync
        */}
      </div>
    </s-page>
  );
}