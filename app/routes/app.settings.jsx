import { useLoaderData, useActionData, useNavigation, Link, Form } from "react-router";
import { requireMerchantAccess, withMerchantAccess, AccessError } from "../services/seller.server";
import { prisma } from "../db.server";
import { recordAudit, AUDIT_ENTITY } from "../services/audit.server";
import { JOB_KIND, enqueueJob, jobKey } from "../services/jobs.server";
import { AUTO_SYNC_DESCRIPTION } from "../utils/inventorySync";

export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async (context) => {
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
    // The people we call about an order. Kept editable in Settings for as long
    // as the store can see the app at all, because the person who answers the
    // phone for a delivery changes far more often than an application does.
    contact: {
      name: app?.contactName ?? context.seller?.contactName ?? null,
      email: app?.email ?? context.seller?.contactEmail ?? null,
      phone: app?.phone ?? context.seller?.phone ?? null,
      urgentName: app?.urgentContactName ?? null,
      urgentPhone: app?.urgentPhone ?? null,
    },
    // Shown beside the fields, never merged into them: the storefront's public
    // address and the person who handles deliveries are usually different
    // mailboxes, and an app that treats one as the other sends the wrong
    // message to the wrong place.
    shopifyEmails: {
      contact: app?.storeContactEmail ?? null,
      owner: app?.storeOwnerEmail ?? null,
    },
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
        }
      : null,
  };
  });

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Who we call about an order.
 *
 * A separate write from the sync preferences, and deliberately a separate
 * access level: a store that is still pending, or one that has been
 * deactivated and may apply again, has no wholesale tools but does still own
 * the answer to "which number should the driver ring". Refusing them that
 * would leave the wrong number on the record until somebody is approved.
 */
async function saveContactDetails(context, form) {
  const seller = context.seller;
  const application = context.application;

  const name = String(form.get("contactName") || "").trim().slice(0, 200);
  const email = String(form.get("contactEmail") || "").trim().slice(0, 320);
  const phone = String(form.get("contactPhone") || "").trim().slice(0, 60);
  const urgentPhone = String(form.get("urgentPhone") || "").trim().slice(0, 60);
  const urgentName = String(form.get("urgentContactName") || "").trim().slice(0, 200);

  // The application row declares these as required, and a blank contact name
  // is not a correction — it is the removal of the only person we know to
  // call. Refused by name rather than accepted and rendered as an empty box.
  if (!name) return { error: "A contact name is required — this is the person we call about an order." };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "A valid contact email is required." };
  }

  const before = {
    name: application?.contactName ?? seller.contactName ?? null,
    email: application?.email ?? seller.contactEmail ?? null,
    phone: application?.phone ?? seller.phone ?? null,
    urgentName: application?.urgentContactName ?? null,
    urgentPhone: application?.urgentPhone ?? null,
  };

  await prisma.$transaction(async (tx) => {
    if (application) {
      await tx.merchantApplication.update({
        where: { id: application.id },
        data: {
          contactName: name,
          email,
          phone: phone || null,
          urgentPhone: urgentPhone || null,
          urgentContactName: urgentName || null,
        },
      });
    }
    // Mirrored onto the seller so the two screens that read a seller row —
    // the owner's store detail and the contact sync — do not disagree with the
    // application about who the contact is.
    await tx.seller.update({
      where: { id: seller.id },
      data: { contactName: name, contactEmail: email, phone: phone || null },
    });
  });

  await recordAudit({
    actorType: "MERCHANT",
    actorId: seller.id,
    actorName: seller.storeName,
    action: "seller.contact_updated",
    entityType: AUDIT_ENTITY.SELLER,
    entityId: seller.id,
    beforeData: before,
    afterData: { name, email, phone: phone || null, urgentName: urgentName || null, urgentPhone: urgentPhone || null },
  });

  // The Odoo contact is only written for a store that has been approved, so
  // the queue entry is only useful there. Before approval the change is simply
  // recorded; approval queues a sync that reads the current values, so nothing
  // is lost by not queueing one now. Queueing one for a pending store would
  // have the runner create an Odoo partner for a company nobody has approved.
  let queued = false;
  if (seller.status === "APPROVED") {
    const current = await prisma.seller.findUnique({
      where: { id: seller.id },
      select: { accessVersion: true },
    });
    await enqueueJob({
      kind: JOB_KIND.ODOO_CONTACT_SYNC,
      idempotencyKey: jobKey(JOB_KIND.ODOO_CONTACT_SYNC, seller.id),
      sellerId: seller.id,
      sellerAccessVersion: current?.accessVersion ?? 1,
      payload: { sellerId: seller.id },
    });
    queued = true;
  }

  return {
    ok: true,
    message: queued
      ? "Contact details saved. The Odoo contact will be updated shortly."
      : "Contact details saved.",
  };
}

export const action = async ({ request }) => {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  let context;
  try {
    // Settings is where product sync is switched on, so a blocked store being
    // told to wait for approval would be doubly wrong: it is not pending, and
    // what it is asking for is the thing that was blocked.
    context = await requireMerchantAccess(request, intent === "contact" ? "VIEW" : "BUSINESS");
  } catch (error) {
    if (error instanceof AccessError) {
      return { error: error.message };
    }
    throw error;
  }
  if (!context.seller) return { error: "No seller account." };

  if (intent === "contact") {
    return saveContactDetails(context, form);
  }

  const data = {
    autoSyncInventory: form.get("autoSyncInventory") === "on",
    quantityBuffer: clampInt(form.get("quantityBuffer"), 0, 10000, 5),
    lowStockAlerts: form.get("lowStockAlerts") === "on",
    autoImportOrders: form.get("autoImportOrders") === "on",
    estimatedDeliveryMsg:
      String(form.get("estimatedDeliveryMsg") || "").trim().slice(0, 300) ||
      "Typically ships within 2–4 business days.",
    /*
     * `defaultMarkup` IS NOT WRITTEN, AND NOT SENT. The field is gone from this
     * form, and a save that wrote a default for it would be inventing a value
     * for a setting nobody can see. The column keeps whatever it holds until a
     * migration removes it; nothing reads it.
     */
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
  const { access, canEdit, store, contact, shopifyEmails, settings, paymentMethod, billingMode } =
    useLoaderData();
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

        <div className="mv-section-card" style={{ marginBottom: "2rem" }}>
          <h3 className="mv-settings-title">Who we contact about your orders</h3>
          <p className="mv-branding-message" style={{ marginBottom: "1rem", fontSize: "0.8rem" }}>
            These are the people MoonVella calls about an order, a pickup or a delivery. They are
            kept separately from the addresses your Shopify store publishes — the storefront address
            is often a shared inbox that nobody watches when a truck is at the door.
          </p>

          <Form method="post">
            <input type="hidden" name="intent" value="contact" />
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Contact name</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  name="contactName"
                  maxLength={200}
                  defaultValue={contact.name ?? ""}
                  required
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Contact email</span>
                <input
                  type="email"
                  className="mv-settings-input"
                  name="contactEmail"
                  maxLength={320}
                  defaultValue={contact.email ?? ""}
                  required
                />
                <span className="mv-branding-message" style={{ fontSize: "0.72rem" }}>
                  {shopifyEmails.contact
                    ? `Your storefront publishes ${shopifyEmails.contact}. Enter the address for ${
                        contact.name ? contact.name : "the order contact"
                      } here if it is different.`
                    : "The address of the person who handles orders, if it is not your storefront's."}
                </span>
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Phone</span>
                <input
                  type="tel"
                  className="mv-settings-input"
                  name="contactPhone"
                  maxLength={60}
                  defaultValue={contact.phone ?? ""}
                />
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Urgent contact phone</span>
                <input
                  type="tel"
                  className="mv-settings-input"
                  name="urgentPhone"
                  maxLength={60}
                  defaultValue={contact.urgentPhone ?? ""}
                />
                <span className="mv-branding-message" style={{ fontSize: "0.72rem" }}>
                  For urgent issues related to orders, fulfillment or delivery.
                </span>
              </div>
              <div className="mv-settings-field">
                <span className="mv-settings-label">Name for the urgent number (if it is somebody else)</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  name="urgentContactName"
                  maxLength={200}
                  defaultValue={contact.urgentName ?? ""}
                />
                <span className="mv-branding-message" style={{ fontSize: "0.72rem" }}>
                  Leave blank if the urgent number is the contact above.
                </span>
              </div>
            </div>

            <button type="submit" className="mv-btn mv-btn-primary" style={{ marginTop: "1.25rem" }}>
              Save contact details
            </button>
          </Form>
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
              {/*
                THERE IS NO MARKUP SETTING ANY MORE, AND NO PRICE SETTING HERE
                AT ALL. A percentage applied to every variant was a second,
                invisible opinion about what a product should cost, and it could
                not express "the King is ten dollars more" in any case — it
                multiplies, so it moves the dearest variant furthest. The price
                is now a figure the seller chooses per size, on the product's
                own card in the catalog, which is the screen that knows what the
                sizes are. A note here says where, because a seller who set a
                markup on this page will come back to it looking for the field.
              */}
              <p className="mv-branding-message" style={{ fontSize: "0.78rem", margin: 0 }}>
                Retail prices are set per size on each product&rsquo;s card in the{" "}
                {/* A Link, not an anchor: a document navigation inside the
                    admin's frame loses the parameters that authenticate it. */}
                <Link to="/app/catalog">Product Catalog</Link>, where you can see
                MoonVella&rsquo;s suggested price and set your own.
              </p>
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
              {/* The sentence the push service uses for this switch, so the
                  description and the behaviour cannot drift apart. */}
              <p className="mv-settings-hint">{AUTO_SYNC_DESCRIPTION}</p>
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
                {/* Stored, and not applied to anything. Said out loud rather
                    than left to look like a setting that works: a seller who
                    sets a buffer of 5 and watches their storefront keep the
                    full quantity would reasonably conclude the sync is broken,
                    when the number has simply never been used. */}
                <p className="mv-settings-hint">
                  Saved, but not applied yet: quantities are pushed exactly as the catalogue
                  holds them. Tell MoonVella if you want the buffer subtracted from what your
                  store shows.
                </p>
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
