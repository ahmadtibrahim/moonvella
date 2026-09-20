const canadianShippingZones = [
  { name: "Ontario / GTA", province: "Ontario", supplierShippingCost: 9.99, transit: "1-3 days", freeShippingThreshold: 99, customerDisplay: "Show calculated rate", status: "Active" },
  { name: "Ontario / Rest", province: "Ontario", supplierShippingCost: 14.99, transit: "2-4 days", freeShippingThreshold: 99, customerDisplay: "Show calculated rate", status: "Active" },
  { name: "Quebec", province: "Quebec", supplierShippingCost: 12.99, transit: "2-4 days", freeShippingThreshold: 99, customerDisplay: "Show calculated rate", status: "Active" },
  { name: "Western Canada", province: "BC, AB, SK, MB", supplierShippingCost: 16.99, transit: "3-5 days", freeShippingThreshold: 149, customerDisplay: "Show calculated rate", status: "Active" },
  { name: "Atlantic Canada", province: "NB, NS, PE, NL", supplierShippingCost: 18.99, transit: "4-7 days", freeShippingThreshold: 149, customerDisplay: "Show calculated rate", status: "Active" },
  { name: "Northern / Remote", province: "YT, NT, NU", supplierShippingCost: 24.99, transit: "5-10 days", freeShippingThreshold: 199, customerDisplay: "Custom quote", status: "Active" },
];

export default function ShippingPage() {

  return (
    <s-page heading="Shipping">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Shipping</h2>
          <p className="mv-page-subtitle">
            Configure shipping rates, zones, and rules for MoonVella products in your store.
          </p>
        </div>

        <div className="mv-section-card">
          <h3 className="mv-section-title">Shipping zones (Canada only)</h3>
          <p className="mv-branding-message" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
            Shipping zones are available for preview. Editing unlocks after approval.
          </p>
          <div style={{ opacity: 0.85 }}>
            <table className="mv-table">
              <thead>
                <tr>
                  <th>Zone / Province</th>
                  <th>Supplier Shipping Cost (CAD)</th>
                  <th>Transit Time</th>
                  <th>Free Shipping Threshold (CAD)</th>
                  <th>Customer Display</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {canadianShippingZones.map((zone) => (
                  <tr key={zone.name}>
                    <td>{zone.name}</td>
                    <td>${zone.supplierShippingCost.toFixed(2)}</td>
                    <td>{zone.transit}</td>
                    <td>${zone.freeShippingThreshold}</td>
                    <td>{zone.customerDisplay}</td>
                    <td><span className="mv-badge mv-badge-instock">{zone.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mv-dashboard-main">
          <div className="mv-dashboard-content">
            <div className="mv-section-card">
              <h3 className="mv-section-title">Display options</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <label className="mv-settings-checkbox">
                  <input type="checkbox" checked disabled />
                  <span>Show calculated shipping rate</span>
                </label>
                <label className="mv-settings-checkbox">
                  <input type="checkbox" checked disabled />
                  <span>Include shipping in product price</span>
                </label>
                <label className="mv-settings-checkbox">
                  <input type="checkbox" checked disabled />
                  <span>Offer free shipping above threshold</span>
                </label>
              </div>
            </div>

            <div className="mv-section-card">
              <h3 className="mv-section-title">Customer checkout preview</h3>
              <div className="mv-checkout-preview">
                <div className="mv-checkout-row">
                  <span className="mv-checkout-label">Standard Shipping (1–3 business days)</span>
                  <span className="mv-checkout-value">$9.99</span>
                </div>
                <div className="mv-checkout-row">
                  <span className="mv-checkout-label">Express Shipping (2–4 business days)</span>
                  <span className="mv-checkout-value">$24.99</span>
                </div>
                <div className="mv-checkout-row">
                  <span className="mv-checkout-label">Free Shipping (orders over $99)</span>
                  <span className="mv-checkout-value mv-free">Free</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mv-dashboard-sidebar">
            <div className="mv-section-card">
              <h3 className="mv-section-title">Shipping rules</h3>
              <ul className="mv-rules-list">
                <li>Weight-based shipping</li>
                <li>Oversize items</li>
                <li>Northern / remote custom quote</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}