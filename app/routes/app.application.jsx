import React from "react";
import { Link, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

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

function safeParseArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin, session } = await authenticate.admin(request);
  const { prisma } = await import("../db.server");

  const profile = {
    storeName: session.shop,
    shopDomain: session.shop,
    contactEmail: "",
    country: "",
    currency: "",
    shopifyPlan: "",
    storeUrl: "",
  };

  try {
    const response = await admin.graphql(`#graphql
      query ApplicationShopProfile {
        shop {
          name
          myshopifyDomain
          email
          primaryDomain { url }
          currencyCode
          billingAddress { countryCodeV2 }
          plan { displayName }
        }
      }
    `);
    const json = await response.json();
    const shop = json?.data?.shop;
    if (shop) {
      profile.storeName = shop.name || profile.storeName;
      profile.shopDomain = shop.myshopifyDomain || profile.shopDomain;
      profile.contactEmail = shop.email || "";
      profile.country = shop.billingAddress?.countryCodeV2 || "";
      profile.currency = shop.currencyCode || "";
      profile.shopifyPlan = shop.plan?.displayName || "";
      profile.storeUrl = shop.primaryDomain?.url || "";
    }
  } catch {
    // Best effort: fall back to the authenticated session shop identity.
  }

  const application = await prisma.merchantApplication.findUnique({
    where: { shopDomain: session.shop },
  });

  return {
    profile,
    application: application
      ? {
          contactName: application.contactName,
          phone: application.phone ?? "",
          urgentPhone: application.urgentPhone ?? "",
          email: application.email,
          legalBusinessName: application.legalBusinessName,
          sellerAddress: application.sellerAddress,
          gstHstNumber: application.gstHstNumber ?? "",
          productCategory: application.productCategory,
          markets: safeParseArray(application.markets),
          status: application.status,
        }
      : null,
  };
}

function extractMarkets(formData) {
  let raw = formData.getAll("markets");
  if (raw.length === 0) {
    raw = formData.getAll("markets[]");
  }
  if (raw.length === 1) {
    const value = String(raw[0]).trim();
    if (value.startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map(String);
        }
      } catch {
        // fall through and treat as a plain value
      }
    }
  }
  return raw.map(String).filter(Boolean);
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();

  const contactName = String(formData.get("contactName") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const legalBusinessName = String(formData.get("legalBusinessName") || "").trim();
  const sellerAddress = String(formData.get("sellerAddress") || "").trim();

  if (!contactName || !email || !legalBusinessName || !sellerAddress) {
    return { ok: false, error: "Please complete all required fields." };
  }

  let storeName = shop;
  let storeUrl = "";
  let country = "";
  let currency = "";
  let shopifyPlan = "";

  try {
    const response = await admin.graphql(`#graphql
      query ShopProfile {
        shop {
          name
          myshopifyDomain
          primaryDomain { url }
          currencyCode
          billingAddress { countryCodeV2 }
          plan { displayName }
        }
      }
    `);
    const json = await response.json();
    const shopData = json?.data?.shop;
    if (shopData) {
      storeName = shopData.name || storeName;
      storeUrl = shopData.primaryDomain?.url || "";
      country = shopData.billingAddress?.countryCodeV2 || "";
      currency = shopData.currencyCode || "";
      shopifyPlan = shopData.plan?.displayName || "";
    }
  } catch {
    // Store profile is best-effort; fall back to the session shop domain.
  }

  const markets = extractMarkets(formData);
  const productCategory = String(formData.get("productCategory") || "Other");
  const phone = String(formData.get("phone") || "").trim() || null;
  const urgentPhone = String(formData.get("urgentPhone") || "").trim() || null;
  const gstHstNumber = String(formData.get("gstHstNumber") || "").trim() || null;

  const { prisma } = await import("../db.server");

  const existing = await prisma.merchantApplication.findUnique({
    where: { shopDomain: shop },
    select: { id: true, status: true },
  });

  // Editing contact details must not silently reset an approved or suspended
  // seller back into review. Only brand-new, rejected or needs-info
  // applications (re-)enter the pending queue.
  let status = existing?.status ?? "PENDING";
  if (
    !existing ||
    existing.status === "REJECTED" ||
    existing.status === "NEEDS_INFO"
  ) {
    status = "PENDING";
  }

  const data = {
    storeName,
    storeUrl,
    country,
    currency,
    shopifyPlan,
    contactName,
    email,
    phone,
    urgentPhone,
    legalBusinessName,
    sellerAddress,
    gstHstNumber,
    productCategory,
    markets: JSON.stringify(markets),
    status,
  };

  const saved = await prisma.merchantApplication.upsert({
    where: { shopDomain: shop },
    create: { shopDomain: shop, ...data, submittedAt: new Date() },
    update: data,
  });

  const { recordAudit, AUDIT_ENTITY } = await import("../services/audit.server");
  await recordAudit({
    actorType: "MERCHANT",
    actorId: shop,
    actorName: storeName,
    action: existing ? "application.updated" : "application.submitted",
    entityType: AUDIT_ENTITY.APPLICATION,
    entityId: saved.id,
    afterData: { status: saved.status, productCategory, markets },
  });

  return { ok: true };
}

export default function ApplicationPage() {
  const { profile, application } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSubmitting = fetcher.state !== "idle";
  const submitted = fetcher.data?.ok === true;
  const serverError = fetcher.data?.error;
  const [intent, setIntent] = React.useState("submit");

  React.useEffect(() => {
    if (submitted) {
      shopify.toast.show(
        "Application saved. MoonVella will review your store before wholesale access is unlocked.",
      );
      if (intent === "save") {
        navigate("/app/status");
      }
    }
  }, [submitted, intent, shopify, navigate]);

  const [formData, setFormData] = React.useState(() => ({
    contactName: application?.contactName ?? "",
    phone: application?.phone ?? "",
    urgentPhone: application?.urgentPhone ?? "",
    email: application?.email ?? profile.contactEmail ?? "",
    legalBusinessName: application?.legalBusinessName ?? "",
    sellerAddress: application?.sellerAddress ?? "",
    gstHstNumber: application?.gstHstNumber ?? "",
    productCategory: application?.productCategory ?? "Bedding & Bath",
    markets:
      application?.markets && application.markets.length
        ? application.markets
        : ["Ontario"],
  }));

  const [errors, setErrors] = React.useState({});

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

    const payload = new FormData();
    payload.set("contactName", formData.contactName || "");
    payload.set("phone", formData.phone || "");
    payload.set("urgentPhone", formData.urgentPhone || "");
    payload.set("email", formData.email || "");
    payload.set("legalBusinessName", formData.legalBusinessName || "");
    payload.set("sellerAddress", formData.sellerAddress || "");
    payload.set("gstHstNumber", formData.gstHstNumber || "");
    payload.set("productCategory", formData.productCategory || "Other");
    (formData.markets || []).forEach((market) => payload.append("markets", market));

    fetcher.submit(payload, { method: "POST" });
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
            <Link to="/app/status" className="mv-btn mv-btn-primary">
              View Application Status
            </Link>
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
            <h3 className="mv-settings-title">Store information from your Shopify shop</h3>
            <p className="mv-branding-message" style={{ marginBottom: '1.5rem' }}>
              Loaded from your connected Shopify shop. A field shows Unknown if the app does not
              yet have permission for it.
            </p>
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store name</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={profile.storeName}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Shop domain</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={profile.shopDomain}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store email</span>
                <input
                  type="email"
                  className="mv-settings-input"
                  value={profile.contactEmail}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Country</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={profile.country}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Currency</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={profile.currency}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Shopify plan</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={profile.shopifyPlan}
                  disabled
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Store URL</span>
                <input
                  type="url"
                  className="mv-settings-input"
                  value={profile.storeUrl}
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
              MoonVella reviews recent Shopify activity before approving wholesale access. These
              analytics require reporting permissions on this shop.
            </p>
            <div className="mv-settings-grid" style={{ opacity: 0.7 }}>
              {["Last 90 days sales", "Paid order count", "Average order value", "Main markets"].map(
                (label) => (
                  <div className="mv-settings-field" key={label}>
                    <span className="mv-settings-label">{label}</span>
                    <input
                      type="text"
                      className="mv-settings-input"
                      value="Collected during review"
                      disabled
                    />
                  </div>
                )
              )}
            </div>
          </div>

          {serverError && (
            <p style={{ color: 'var(--danger-red)', fontSize: '0.875rem', marginTop: '0.5rem', textAlign: 'right' }}>
              {serverError}
            </p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1.5rem' }}>
            <button
              type="submit"
              className="mv-btn mv-btn-secondary"
              onClick={() => setIntent("save")}
              disabled={isSubmitting}
            >
              Save &amp; Continue Later
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