import React from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  shopifyStoreProfile,
  merchantContactProfile,
  shopifySalesReview,
} from "../data/moonvellaState";

const PRODUCT_CATEGORIES = [
  "Bedding & Bath",
  "Home Decor",
  "Furniture",
  "Health & Wellness",
  "Lifestyle & Gifts",
  "Other",
];

const CANADIAN_MARKETS = [
  "Ontario",
  "Quebec",
  "Western Canada",
  "Atlantic Canada",
  "Northern / Remote",
];

export default function ApplicationPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isSubmitting = fetcher.state === "submitting";

  const [formData, setFormData] = React.useState({
    contactName: merchantContactProfile.contactName,
    phone: merchantContactProfile.phone,
    urgentPhone: merchantContactProfile.urgentPhone,
    email: merchantContactProfile.email,
    legalBusinessName: merchantContactProfile.legalBusinessName,
    sellerAddress: merchantContactProfile.sellerAddress,
    gstHstNumber: merchantContactProfile.gstHstNumber,
    productCategory: "Bedding & Bath",
    markets: ["Ontario", "Quebec"],
  });

  const [errors, setErrors] = React.useState({});
  const [submitted, setSubmitted] = React.useState(false);

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  const handleMarketChange = (market) => {
    setFormData((prev) => {
      const current = prev.markets || [];
      const updated = current.includes(market)
        ? current.filter((m) => m !== market)
        : [...current, market];
      return { ...prev, markets: updated };
    });
  };

  const validate = () => {
    const newErrors = {};
    if (!formData.contactName?.trim()) {
      newErrors.contactName = "Contact name required";
    }
    if (!formData.email?.trim() || !formData.email.includes("@")) {
      newErrors.email = "Valid email required";
    }
    if (!formData.legalBusinessName?.trim()) {
      newErrors.legalBusinessName = "Legal business name required";
    }
    if (!formData.sellerAddress?.trim()) {
      newErrors.sellerAddress = "Business address required";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    fetcher.submit(formData, { method: "POST" });
    setSubmitted(true);
    shopify.toast.show("Application submitted. MoonVella will review your store before wholesale access is unlocked.");
  };

  if (submitted) {
    return (
      <s-page heading="Application Submitted">
        <div className="mv-container">
          <div className="mv-section-card" style={{ textAlign: 'center', padding: '3rem' }}>
            <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✓</div>
            <h2 className="mv-page-title" style={{ marginBottom: '1rem' }}>Application Submitted</h2>
            <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 2rem' }}>
              Application submitted. MoonVella will review your store before wholesale access is unlocked.
            </p>
            <button className="mv-btn mv-btn-primary" onClick={() => window.location.href = "/app/status"}>
              View Application Status
            </button>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    <s-page heading="Apply to sell MoonVella bedding">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Apply to sell MoonVella bedding</h2>
          <p className="mv-page-subtitle">
            We review each Shopify store before unlocking wholesale pricing and product import tools.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mv-section-card">
            <h3 className="mv-settings-title">Shopify store detected</h3>
            <p className="mv-branding-message" style={{ marginBottom: '1.5rem' }}>
              This information will be retrieved automatically from Shopify after installation.
            </p>
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store name</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifyStoreProfile.storeName}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Shop domain</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifyStoreProfile.shopDomain}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store email</span>
                <input
                  type="email"
                  className="mv-settings-input"
                  value={shopifyStoreProfile.contactEmail}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Country</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifyStoreProfile.country}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Currency</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifyStoreProfile.currency}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Shopify plan</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={shopifyStoreProfile.shopifyPlan}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store URL</span>
                <input
                  type="url"
                  className="mv-settings-input"
                  value={shopifyStoreProfile.storeUrl}
                  disabled
                />
              </div>
            </div>
          </div>

          <div className="mv-section-card">
            <h3 className="mv-settings-title">Partner contact information</h3>
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Contact name</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={formData.contactName}
                  onChange={(e) => handleChange("contactName", e.target.value)}
                  aria-invalid={!!errors.contactName}
                />
                {errors.contactName && <p style={{ color: 'var(--danger-red)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{errors.contactName}</p>}
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Phone number</span>
                <input
                  type="tel"
                  className="mv-settings-input"
                  value={formData.phone}
                  onChange={(e) => handleChange("phone", e.target.value)}
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Urgent contact phone</span>
                <input
                  type="tel"
                  className="mv-settings-input"
                  value={formData.urgentPhone}
                  onChange={(e) => handleChange("urgentPhone", e.target.value)}
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Email address</span>
                <input
                  type="email"
                  className="mv-settings-input"
                  value={formData.email}
                  onChange={(e) => handleChange("email", e.target.value)}
                  aria-invalid={!!errors.email}
                />
                {errors.email && <p style={{ color: 'var(--danger-red)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{errors.email}</p>}
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Legal business name</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={formData.legalBusinessName}
                  onChange={(e) => handleChange("legalBusinessName", e.target.value)}
                  aria-invalid={!!errors.legalBusinessName}
                />
                {errors.legalBusinessName && <p style={{ color: 'var(--danger-red)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{errors.legalBusinessName}</p>}
              </div>
              <div className="mv-settings-field" style={{ gridColumn: '1 / -1' }}>
                <span className="mv-settings-label">Seller/business address</span>
                <textarea
                  className="mv-settings-input"
                  value={formData.sellerAddress}
                  onChange={(e) => handleChange("sellerAddress", e.target.value)}
                  rows={2}
                  aria-invalid={!!errors.sellerAddress}
                />
                {errors.sellerAddress && <p style={{ color: 'var(--danger-red)', fontSize: '0.75rem', marginTop: '0.25rem' }}>{errors.sellerAddress}</p>}
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">GST/HST number (optional)</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={formData.gstHstNumber}
                  onChange={(e) => handleChange("gstHstNumber", e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </div>

          <div className="mv-section-card">
            <h3 className="mv-settings-title">Business fit</h3>
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Main product category</span>
                <select
                  className="mv-settings-input"
                  value={formData.productCategory}
                  onChange={(e) => handleChange("productCategory", e.target.value)}
                >
                  {PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="mv-settings-field" style={{ gridColumn: '1 / -1' }}>
                <span className="mv-settings-label">Main markets served</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {CANADIAN_MARKETS.map((market) => (
                    <label key={market} className="mv-settings-checkbox" style={{ background: formData.markets?.includes(market) ? 'var(--accent-blue)' : 'transparent', border: '1px solid var(--border-color)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={formData.markets?.includes(market)}
                        onChange={() => handleMarketChange(market)}
                      />
                      <span>{market}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="mv-section-card">
            <h3 className="mv-settings-title">Shopify sales review</h3>
            <p className="mv-branding-message" style={{ marginBottom: '1.5rem' }}>
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

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1.5rem' }}>
            <button type="button" className="mv-btn mv-btn-secondary" onClick={() => window.location.href = "/app/status"}>
              Save & Continue Later
            </button>
            <button type="submit" className="mv-btn mv-btn-primary" disabled={isSubmitting}>
              {isSubmitting ? "Submitting..." : "Submit Application"}
            </button>
          </div>
        </form>
      </div>
    </s-page>
  );
}