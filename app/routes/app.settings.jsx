import { useLoaderData, useActionData, useNavigation, Link, Form } from "react-router";
import { BLOCKED_MESSAGE, requireSellerContext } from "../services/seller.server";
import { prisma } from "../db.server";
import { recordAudit, AUDIT_ENTITY } from "../services/audit.server";

export const loader = async ({ request }) => {
  const context = await requireSellerContext(request);

  let settings = null;
  let paymentMethod = null;
  let billingMode = null;
  if (context.seller) {
    [settings, paymentMethod, billingMode] = await Promise.all([
      prisma.sellerSettings.findUnique({ where: { sellerId: context.seller.id } }),
      prisma.sellerPaymentMethod.findFirst({
        where: { sellerId: context.seller.id, status: "ACTIVE" },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        select: { brand: true, last4: true, isDefault: true },
      }),
      prisma.sellerBillingSettings
        .findUnique({ where: { sellerId: context.seller.id }, select: { mode: true } })
        .then((row) => row?.mode ?? "MANUAL"),
    ]);
  }

  const app = context.application;

  return {
    access: context.access,
    canEdit: context.canStartNewBusiness,
    store: {
      storeName: app?.storeName ?? context.seller?.storeName ?? null,
      shopDomain: context.shop,
      storeUrl: app?.storeUrl ?? context.seller?.storeUrl ?? null,
      contactEmail: app?.email ?? context.seller?.contactEmail ?? null,
      country: app?.country ?? context.seller?.country ?? null,
      currency: app?.currency ?? context.seller?.currency ?? null,
      shopifyPlan: app?.shopifyPlan ?? context.seller?.shopifyPlan ?? null,
    },
    paymentMethod: paymentMethod
      ? { brand: paymentMethod.brand, last4: paymentMethod.last4, isDefault: paymentMethod.isDefault }
      : null,
    billingMode,
    settings: settings
      ? {
          autoSyncInventory: settings.autoSyncInventory,
          quantityBuffer: settings.quantityBuffer,
          lowStockAlerts: settings.lowStockAlerts,
          autoImportOrders: settings.autoImportOrders,
          estimatedDeliveryMsg: settings.estimatedDeliveryMsg,
          defaultMarkup: settings.defaultMarkup,
        }
      : null,
  };
};

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const action = async ({ request }) => {
  const context = await requireSellerContext(request);
  if (!context.seller) return { error: "No seller account." };
  if (!context.canStartNewBusiness) {
    // Settings is where product sync is switched on, so a blocked store being
    // told to wait for approval would be doubly wrong: it is not pending, and
    // what it is asking for is the thing that was blocked.
    return {
      error:
        context.access === "BLOCKED"
          ? BLOCKED_MESSAGE
          : `Settings require an approved seller account (current status: ${context.access}).`,
    };
  }

  const form = await request.formData();
  const data = {
    autoSyncInventory: form.get("autoSyncInventory") === "on",
    quantityBuffer: clampInt(form.get("quantityBuffer"), 0, 10000, 5),
    lowStockAlerts: form.get("lowStockAlerts") === "on",
    autoImportOrders: form.get("autoImportOrders") === "on",
    estimatedDeliveryMsg:
      String(form.get("estimatedDeliveryMsg") || "").trim().slice(0, 300) ||
      "Typically ships within 2–4 business days.",
    defaultMarkup: clampInt(form.get("defaultMarkup"), 0, 100000, 200),
  };

  const before = await prisma.sellerSettings.findUnique({ where: { sellerId: context.seller.id } });
  const settings = await prisma.sellerSettings.upsert({
    where: { sellerId: context.seller.id },
    create: { sellerId: context.seller.id, ...data },
    update: data,
  });

  await recordAudit({
    actorType: "MERCHANT",
    actorId: context.seller.id,
    actorName: context.seller.storeName,
    action: "settings.updated",
    entityType: AUDIT_ENTITY.SETTINGS,
    entityId: settings.id,
    beforeData: before
      ? {
          autoSyncInventory: before.autoSyncInventory,
          quantityBuffer: before.quantityBuffer,
          lowStockAlerts: before.lowStockAlerts,
          autoImportOrders: before.autoImportOrders,
          estimatedDeliveryMsg: before.estimatedDeliveryMsg,
          defaultMarkup: before.defaultMarkup,
        }
      : null,
    afterData: data,
  });

  return { ok: true, message: "Settings saved." };
};

function valueOrUnknown(value) {
  return value === null || value === undefined || value === "" ? "Unknown" : value;
}

export default function SettingsPage() {
  const { access, canEdit, store, settings, paymentMethod, billingMode } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isApproved = access === "APPROVED";
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Settings">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Settings</h2>
          <p className="mv-page-subtitle">
            Configure how MoonVella products, orders, and inventory sync with your Shopify store.
          </p>
        </div>

        {actionData?.error ? (
          <div className="mv-section-card" style={{ marginBottom: "1rem", color: "#991b1b", background: "#fef2f2" }}>
            {actionData.error}
          </div>
        ) : null}
        {actionData?.message ? (
          <div className="mv-section-card" style={{ marginBottom: "1rem", color: "#166534", background: "#f0fdf4" }}>
            {actionData.message}
          </div>
        ) : null}

        <div className="mv-section-card" style={{ marginBottom: "2rem" }}>
          <h3 className="mv-settings-title" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            Application Status
            <span className={`mv-badge ${isApproved ? "mv-badge-instock" : "mv-badge-pending"}`}>
              {access}
            </span>
          </h3>
          <p className="mv-branding-message" style={{ marginBottom: "1rem" }}>
            {isApproved
              ? "Your store is approved. Full catalog access and product import are enabled."
              : "Wholesale catalog access and product import require an approved account."}
          </p>
          <Link to="/app/status" style={{ color: "var(--primary-color)", fontWeight: "600" }}>
            View application status →
          </Link>
        </div>

        <div className="mv-section-card" style={{ marginBottom: "2rem" }}>
          <h3 className="mv-settings-title">Store information from your Shopify shop</h3>
          <div className="mv-settings-grid">
            <div className="mv-settings-field">
              <span className="mv-settings-label">Store name</span>
              <input type="text" className="mv-settings-input" value={valueOrUnknown(store.storeName)} disabled />
            </div>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Shop domain</span>
              <input type="text" className="mv-settings-input" value={store.shopDomain} disabled />
            </div>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Store URL</span>
              <input type="text" className="mv-settings-input" value={valueOrUnknown(store.storeUrl)} disabled />
            </div>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Contact email</span>
              <input type="email" className="mv-settings-input" value={valueOrUnknown(store.contactEmail)} disabled />
            </div>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Country</span>
              <input type="text" className="mv-settings-input" value={valueOrUnknown(store.country)} disabled />
            </div>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Currency</span>
              <input type="text" className="mv-settings-input" value={valueOrUnknown(store.currency)} disabled />
            </div>
            <div className="mv-settings-field">
              <span className="mv-settings-label">Shopify plan</span>
              <input type="text" className="mv-settings-input" value={valueOrUnknown(store.shopifyPlan)} disabled />
            </div>
          </div>
          <p className="mv-branding-message" style={{ marginTop: "1rem", fontSize: "0.75rem" }}>
            Values come from your submitted MoonVella application and cannot be edited here. Live Shopify
            profile sync is completed in the application phase.
          </p>
        </div>

        <Form method="post">
          <div className="mv-settings-grid">
            <div className="mv-settings-card">
              <h3 className="mv-settings-title">Product Import Preferences</h3>
              <label className="mv-settings-checkbox">
                <input type="checkbox" disabled readOnly />
                <span>Import product images (not configurable yet)</span>
              </label>
              <label className="mv-settings-checkbox">
                <input type="checkbox" disabled readOnly />
                <span>Import product descriptions (not configurable yet)</span>
              </label>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Default price markup (%)</span>
                <input
                  type="number"
                  min="0"
                  max="100000"
                  step="1"
                  className="mv-settings-input"
                  name="defaultMarkup"
                  defaultValue={settings ? settings.defaultMarkup : 200}
                  disabled={!canEdit}
                />
              </div>
            </div>

            <div className="mv-settings-card">
              <h3 className="mv-settings-title">Inventory &amp; Sync</h3>
              <label className="mv-settings-checkbox">
                <input
                  type="checkbox"
                  name="autoSyncInventory"
                  defaultChecked={settings ? settings.autoSyncInventory : true}
                  disabled={!canEdit}
                />
                <span>Auto-sync inventory</span>
              </label>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Quantity buffer</span>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="1"
                  className="mv-settings-input"
                  name="quantityBuffer"
                  defaultValue={settings ? settings.quantityBuffer : 5}
                  disabled={!canEdit}
                />
              </div>
              <label className="mv-settings-checkbox">
                <input
                  type="checkbox"
                  name="lowStockAlerts"
                  defaultChecked={settings ? settings.lowStockAlerts : true}
                  disabled={!canEdit}
                />
                <span>Low-stock alerts</span>
              </label>
            </div>

            <div className="mv-settings-card">
              <h3 className="mv-settings-title">Order Preferences</h3>
              <label className="mv-settings-checkbox">
                <input
                  type="checkbox"
                  name="autoImportOrders"
                  defaultChecked={settings ? settings.autoImportOrders : true}
                  disabled={!canEdit}
                />
                <span>Auto-import orders</span>
              </label>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Estimated delivery message</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  name="estimatedDeliveryMsg"
                  maxLength={300}
                  defaultValue={settings ? settings.estimatedDeliveryMsg : "Typically ships within 2–4 business days."}
                  disabled={!canEdit}
                />
              </div>
            </div>

            <div className="mv-settings-card">
              <h3 className="mv-settings-title">Billing &amp; Payments</h3>
              <div className="mv-billing-info">
                <div className="mv-billing-text">
                  <span className="mv-billing-card">
                    {paymentMethod
                      ? `${(paymentMethod.brand || "card").toUpperCase()} •••• ${paymentMethod.last4}${paymentMethod.isDefault ? " (default)" : ""}`
                      : "No wholesale payment method connected"}
                  </span>
                  <span className="mv-billing-expiry">
                    Mode: {billingMode === "AUTOMATIC" ? "Automatic" : "Manual"}
                  </span>
                </div>
              </div>
              <Link to="/app/billing" style={{ color: "var(--primary-color)", fontWeight: "600", fontSize: "0.85rem" }}>
                Manage billing &amp; payment methods →
              </Link>
            </div>
          </div>

          {canEdit ? (
            <button
              type="submit"
              className="mv-btn mv-btn-primary"
              style={{ marginTop: "1.5rem" }}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Saving…" : "Save settings"}
            </button>
          ) : (
            <p className="mv-branding-message" style={{ marginTop: "1.5rem", fontSize: "0.8rem" }}>
              Settings are read-only until your seller account is approved.
            </p>
          )}
        </Form>

        <div className="mv-branding-section">
          <h3 className="mv-branding-title">
            Branded Packing Slip
            <span className="mv-branding-status">{isApproved ? "Enabled" : "Locked"}</span>
          </h3>
          <p className="mv-branding-message">
            {isApproved
              ? "Enabled. Your customers receive your store-branded packing slip while MoonVella remains behind the scenes."
              : "Available after approval."}
          </p>
        </div>
      </div>
    </s-page>
  );
}
