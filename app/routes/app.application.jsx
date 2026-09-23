import React from "react";
import PropTypes from "prop-types";
import { Link, redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  asAccessResponse,
  requireMerchantAccess,
} from "../services/seller.server";

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

/**
 * The business address, as separate columns.
 *
 * It used to be one free-text box. A single string cannot be mapped onto Odoo's
 * street / street2 / city / zip / state / country without guessing where one
 * ends and the next begins, so the guess would land in the customer record as
 * fact. Five columns and a country code can be mapped exactly, and a country
 * code is what `res.country` is resolved against.
 */
const ADDRESS_FIELDS = [
  { key: "addressLine1", label: "Street 1", required: true },
  { key: "addressLine2", label: "Street 2", required: false },
  { key: "addressCity", label: "City", required: true },
  { key: "addressProvinceCode", label: "Province / State", required: true },
  { key: "addressPostalCode", label: "Postal / ZIP code", required: true },
  { key: "addressCountryCode", label: "Country code", required: true },
];

/**
 * The imported store facts, in the order the page shows them.
 *
 * This list is what makes "every imported field explains itself" checkable: the
 * loader returns a note for each key named here, and the page renders the note
 * under the value. A key added here without a note renders an empty
 * explanation, which the suite treats as a failure.
 */
const IMPORTED_FIELDS = [
  { key: "storeName", label: "Store display name" },
  { key: "shopifyShopId", label: "Shopify shop ID" },
  { key: "myshopifyDomain", label: "myshopify domain" },
  { key: "storefrontUrl", label: "Storefront URL" },
  { key: "storeOwnerEmail", label: "Store owner email" },
  { key: "storeContactEmail", label: "Public store contact email" },
  { key: "countryCode", label: "Country" },
  { key: "currency", label: "Currency" },
  { key: "plan", label: "Shopify plan" },
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

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

const ADDRESS_KEYS = ADDRESS_FIELDS.map((f) => f.key);

function readAddress(row) {
  const out = {};
  for (const key of ADDRESS_KEYS) out[key] = row?.[key] ?? "";
  return out;
}

function readSources(value) {
  const parsed =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  for (const key of Object.keys(parsed)) {
    out[key] = String(parsed[key]);
  }
  return out;
}

export async function loader({ request }) {
  // A blocked store is refused the page outright. The layout renders the block
  // sentence; this is what stops the loader having already read a row.
  const context = await requireMerchantAccess(request, "VIEW").catch(asAccessResponse);

  // An approved seller has no application to edit. The page stays reachable by
  // URL for anyone who bookmarked it, so it redirects rather than showing a
  // form whose submission the action would refuse to accept.
  if (context.access === "APPROVED") {
    throw redirect("/app");
  }

  const { fetchShopProfile, explainSource, SHOP_API_VERSION } = await import(
    "../services/shopProfile.server"
  );
  const { prisma } = await import("../db.server");
  const { authenticate } = await import("../shopify.server");

  const { admin } = await authenticate.admin(request);
  const application = await prisma.merchantApplication.findUnique({
    where: { shopDomain: context.shop },
  });

  /*
   * The import runs once, on the first visit, when nothing has been stored yet.
   *
   * It is a write in a loader, which is worth naming: it is the app caching
   * facts about the shop that it read from Shopify under its own session, not
   * the merchant's data, and it happens at most once per store. After that the
   * stored snapshot is what the page shows, which is what gives "last
   * refreshed" and the Refresh button something to mean — a page that re-read
   * Shopify on every render would make both of them decoration.
   *
   * What the import read is not kept in a local here: it is written below and
   * then re-read with the merchant's own stored row, so the page shows one
   * record — the stored one — rather than a fetched copy that could differ from
   * it by the time the response is rendered.
   */
  if (!application?.profileRefreshedAt) {
    const imported = await fetchShopProfile(admin);

    if (!imported.error) {
      await prisma.merchantApplication.upsert({
        where: { shopDomain: context.shop },
        create: {
          shopDomain: context.shop,
          storeName: imported.profile.storeName || context.shop,
          shopifyShopId: imported.profile.shopifyShopId,
          storeOwnerEmail: imported.profile.storeOwnerEmail,
          storeContactEmail: imported.profile.storeContactEmail,
          addressLine1: imported.profile.addressLine1,
          addressLine2: imported.profile.addressLine2,
          addressCity: imported.profile.addressCity,
          addressProvinceCode: imported.profile.addressProvinceCode,
          addressPostalCode: imported.profile.addressPostalCode,
          addressCountryCode: imported.profile.addressCountryCode,
          profileFieldSources: imported.sources,
          shopifyProfileJson: imported.raw ?? {},
          profileRefreshedAt: new Date(),
          profileRefreshError: null,
        },
        update: {
          storeName: imported.profile.storeName || context.shop,
          shopifyShopId: imported.profile.shopifyShopId,
          storeOwnerEmail: imported.profile.storeOwnerEmail,
          storeContactEmail: imported.profile.storeContactEmail,
          addressLine1: imported.profile.addressLine1,
          addressLine2: imported.profile.addressLine2,
          addressCity: imported.profile.addressCity,
          addressProvinceCode: imported.profile.addressProvinceCode,
          addressPostalCode: imported.profile.addressPostalCode,
          addressCountryCode: imported.profile.addressCountryCode,
          profileFieldSources: imported.sources,
          shopifyProfileJson: imported.raw ?? {},
          profileRefreshedAt: new Date(),
          profileRefreshError: null,
        },
      });
    } else {
      // The failure is recorded, not swallowed: the page has to be able to say
      // the request failed rather than showing a form of empty boxes that look
      // like a shop with nothing in it.
      await prisma.merchantApplication.upsert({
        where: { shopDomain: context.shop },
        create: {
          shopDomain: context.shop,
          storeName: context.shop,
          profileRefreshError: imported.error,
        },
        update: { profileRefreshError: imported.error },
      });
    }
  }

  const row =
    (await prisma.merchantApplication.findUnique({
      where: { shopDomain: context.shop },
    })) ?? application;

  const storedSources = readSources(row?.profileFieldSources);
  const notes = {};
  for (const key of [...IMPORTED_FIELDS.map((f) => f.key), ...ADDRESS_KEYS]) {
    notes[key] = explainSource(storedSources[key] ?? "IMPORT_FAILED");
  }

  /*
   * What Shopify said about the address, taken from the stored raw snapshot
   * rather than from the columns — the columns may since have been edited by
   * the merchant, and "Shopify has X" has to mean Shopify's X.
   */
  const rawBilling =
    row?.shopifyProfileJson && typeof row.shopifyProfileJson === "object"
      ? row.shopifyProfileJson.billingAddress ?? {}
      : {};
  const importedAddress = {
    addressLine1: rawBilling.address1 ?? null,
    addressLine2: rawBilling.address2 ?? null,
    addressCity: rawBilling.city ?? null,
    addressProvinceCode: rawBilling.provinceCode ?? null,
    addressPostalCode: rawBilling.zip ?? null,
    addressCountryCode: rawBilling.countryCodeV2 ?? null,
  };

  return {
    // Serialized values only: the explanation of a blank field is data, so it
    // travels with the response rather than being computed by the component.
    // A `.server` module cannot be reached from client code in this build.
    apiVersion: SHOP_API_VERSION,
    imported: {
      values: Object.fromEntries(
        IMPORTED_FIELDS.map((f) => [f.key, row?.[f.key] ?? null]),
      ),
      sources: Object.fromEntries(
        IMPORTED_FIELDS.map((f) => [f.key, storedSources[f.key] ?? "IMPORT_FAILED"]),
      ),
      notes,
      refreshedAt: row?.profileRefreshedAt ? row.profileRefreshedAt.toISOString() : null,
      error: row?.profileRefreshError ?? null,
    },
    importedAddress,
    address: {
      values: readAddress(row),
      sources: Object.fromEntries(
        ADDRESS_KEYS.map((k) => [k, storedSources[k] ?? "IMPORT_FAILED"]),
      ),
    },
    application: row
      ? {
          contactName: row.contactName,
          phone: row.phone ?? "",
          urgentPhone: row.urgentPhone ?? "",
          urgentContactName: row.urgentContactName ?? "",
          email: row.email,
          legalBusinessName: row.legalBusinessName,
          gstHstNumber: row.gstHstNumber ?? "",
          productCategory: row.productCategory,
          markets: safeParseArray(row.markets),
          status: row.status,
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

const str = (formData, name) => String(formData.get(name) ?? "").trim();

export async function action({ request }) {
  const context = await requireMerchantAccess(request, "VIEW").catch(asAccessResponse);
  if (context.access === "APPROVED") {
    throw redirect("/app");
  }

  const { authenticate } = await import("../shopify.server");
  const { prisma } = await import("../db.server");
  const { fetchShopProfile, SHOP_API_VERSION } = await import(
    "../services/shopProfile.server"
  );

  // The session's shop, never a submitted field. A form that names a different
  // store cannot make this action write against it.
  const shop = context.shop;
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = str(formData, "intent") || "submit";

  const existing = await prisma.merchantApplication.findUnique({
    where: { shopDomain: shop },
  });

  /* ------------------------------------------------------------------ *
   * Refresh: re-read Shopify and merge, keeping what the merchant typed.
   * ------------------------------------------------------------------ */
  if (intent === "refresh" || intent === "clear_field") {
    const imported = await fetchShopProfile(admin);

    if (imported.error) {
      await prisma.merchantApplication.update({
        where: { shopDomain: shop },
        data: { profileRefreshError: imported.error },
      });
      return { ok: false, error: `Shopify could not be read: ${imported.error}` };
    }

    const storedSources = readSources(existing?.profileFieldSources);
    const nextSources = { ...storedSources };
    const data = {};
    const onlyField = intent === "clear_field" ? str(formData, "field") : null;

    for (const [key, value] of Object.entries(imported.profile)) {
      /*
       * A field the merchant typed is theirs. Refreshing is not a reason to
       * overwrite an answer somebody gave deliberately — the note under an
       * overridden field says exactly that, and this is the code that makes the
       * sentence true. Clearing is available per field for when they want
       * Shopify's value back.
       */
      const overridden = storedSources[key] === "MERCHANT";
      if (overridden && onlyField !== key) continue;

      data[key] = value;
      nextSources[key] = imported.sources[key];
    }

    // Identity columns the import owns outright.
    data.storeName = imported.profile.storeName || existing?.storeName || shop;
    data.shopifyShopId = imported.profile.shopifyShopId;
    data.storeOwnerEmail = imported.profile.storeOwnerEmail;
    data.storeContactEmail = imported.profile.storeContactEmail;
    data.profileFieldSources = nextSources;
    data.shopifyProfileJson = imported.raw ?? {};
    data.profileRefreshedAt = new Date();
    data.profileRefreshError = null;

    await prisma.merchantApplication.update({ where: { shopDomain: shop }, data });

    const { recordAudit, AUDIT_ENTITY } = await import("../services/audit.server");
    await recordAudit({
      actorType: "MERCHANT",
      actorId: shop,
      actorName: data.storeName,
      action: onlyField ? "application.field_reimported" : "application.profile_refreshed",
      entityType: AUDIT_ENTITY.APPLICATION,
      entityId: existing?.id,
      afterData: {
        refreshedAt: data.profileRefreshedAt,
        field: onlyField ?? null,
        apiVersion: SHOP_API_VERSION,
      },
    });

    return { ok: true, refreshed: true };
  }

  /* ------------------------------------------------------------------ *
   * Submit.
   * ------------------------------------------------------------------ */
  const contactName = str(formData, "contactName");
  const email = str(formData, "email");
  const phone = str(formData, "phone") || null;
  const urgentPhone = str(formData, "urgentPhone") || null;
  const urgentContactName = str(formData, "urgentContactName") || null;
  const legalBusinessName = str(formData, "legalBusinessName");
  const gstHstNumber = str(formData, "gstHstNumber") || null;
  const productCategory = str(formData, "productCategory") || "Other";

  const submittedAddress = {};
  for (const field of ADDRESS_FIELDS) {
    submittedAddress[field.key] = str(formData, field.key);
  }

  const errors = {};
  if (!contactName) errors.contactName = "Contact name is required.";
  if (!isEmail(email)) errors.email = "A valid email address is required.";
  if (!legalBusinessName) {
    errors.legalBusinessName = "Legal business name is required.";
  }
  for (const field of ADDRESS_FIELDS) {
    if (field.required && !submittedAddress[field.key]) {
      errors[field.key] = `${field.label} is required.`;
    }
  }
  if (urgentContactName && !urgentPhone) {
    errors.urgentPhone =
      "An urgent contact name was given, so an urgent contact number is required.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, error: "Please correct the highlighted fields." };
  }

  /*
   * Provenance for each address column.
   *
   * A value equal to the one Shopify returned keeps its imported source; a
   * different one is the merchant's. Comparing against the *stored* import
   * rather than re-reading Shopify here is deliberate: it keeps submission from
   * depending on a live API call, so a merchant can still apply during a
   * Shopify outage — and the stored import is the same snapshot they were
   * looking at when they typed.
   */
  const storedSources = readSources(existing?.profileFieldSources);
  const nextSources = { ...storedSources };
  const addressData = {};

  for (const field of ADDRESS_FIELDS) {
    const submitted = submittedAddress[field.key];
    const stored = existing?.[field.key] ?? null;
    addressData[field.key] = submitted || null;

    if (!submitted) {
      // Cleared by the merchant: whatever Shopify said no longer describes
      // this column, and the page must say so rather than crediting Shopify.
      nextSources[field.key] = "SHOPIFY_EMPTY";
      continue;
    }
    if (storedSources[field.key] === "MERCHANT" || submitted !== stored) {
      nextSources[field.key] = "MERCHANT";
    } else {
      nextSources[field.key] = storedSources[field.key] ?? "MERCHANT";
    }
  }

  /*
   * Identity fields are not part of the submission. They come from the stored
   * import, whose values were read from the Admin API under this session, and
   * from nowhere else. When there is no import yet — the merchant submitted
   * before the page could reach Shopify — the shop domain from the session is
   * used and nothing else is invented. In particular the legal name is NOT
   * derived from the store name.
   */
  const storeName = existing?.storeName || shop;

  // Editing contact details must not silently reset an approved or suspended
  // seller back into review. A deactivated store, by contrast, is applying
  // again: its own state is the request to re-enter the queue.
  let status = existing?.status ?? "PENDING";
  if (
    !existing ||
    existing.status === "REJECTED" ||
    existing.status === "NEEDS_INFO" ||
    existing.status === "DEACTIVATED"
  ) {
    status = "PENDING";
  }

  const markets = extractMarkets(formData);

  const data = {
    storeName,
    contactName,
    email,
    phone,
    urgentPhone,
    // Stored only when it names somebody other than the main contact. An
    // urgent number that belongs to the contact above needs no second name,
    // and writing one would imply a separate person exists.
    urgentContactName: urgentPhone ? urgentContactName : null,
    legalBusinessName,
    gstHstNumber,
    productCategory,
    markets: JSON.stringify(markets),
    status,
    profileFieldSources: nextSources,
    ...addressData,
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
    afterData: {
      status: saved.status,
      productCategory,
      markets,
      // Which columns the merchant supplied themselves, so a later reviewer can
      // tell an imported address from a typed one without opening the form.
      merchantSupplied: Object.entries(nextSources)
        .filter(([, source]) => source === "MERCHANT")
        .map(([key]) => key),
    },
  });

  return { ok: true, status: saved.status };
}

/** The reason a field is blank, rendered under it. */
function SourceNote({ note }) {
  if (!note) return null;
  return (
    <p className="mv-field-note" style={{ fontSize: "0.72rem", color: "var(--text-secondary)", margin: "0.25rem 0 0" }}>
      {note}
    </p>
  );
}

function ImportedValue({ label, value, note }) {
  return (
    <div className="mv-settings-field">
      <span className="mv-settings-label">{label}</span>
      <input
        type="text"
        className="mv-settings-input"
        value={value ?? ""}
        placeholder="Not provided by Shopify"
        disabled
        readOnly
      />
      <SourceNote note={note} />
    </div>
  );
}

SourceNote.propTypes = {
  // The reason the field above is blank, when there is one.
  note: PropTypes.string,
};

ImportedValue.propTypes = {
  label: PropTypes.string.isRequired,
  // Absent when Shopify did not supply the field — shown as an empty box
  // rather than as a value nobody entered.
  value: PropTypes.string,
  note: PropTypes.string,
};

export default function ApplicationPage() {
  const { imported, importedAddress, address, application, apiVersion } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSubmitting = fetcher.state !== "idle";
  const submitted = fetcher.data?.ok === true && !fetcher.data?.refreshed;
  const refreshed = fetcher.data?.refreshed === true;
  const serverError = fetcher.data?.error;
  const fieldErrors = fetcher.data?.errors || {};
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

  React.useEffect(() => {
    if (refreshed) {
      shopify.toast.show("Store information refreshed from Shopify.");
    }
  }, [refreshed, shopify]);

  const [formData, setFormData] = React.useState(() => ({
    contactName: application?.contactName ?? "",
    phone: application?.phone ?? "",
    urgentPhone: application?.urgentPhone ?? "",
    urgentContactName: application?.urgentContactName ?? "",
    // Prefilled from the store's own email as a convenience. It stays a field
    // the applicant can change: the person MoonVella should call about this
    // account is often not the mailbox the storefront publishes.
    email: application?.email ?? imported.values.storeOwnerEmail ?? "",
    legalBusinessName: application?.legalBusinessName ?? "",
    gstHstNumber: application?.gstHstNumber ?? "",
    productCategory: application?.productCategory ?? "Bedding & Bath",
    markets:
      application?.markets && application.markets.length
        ? application.markets
        : ["Ontario"],
  }));

  // The address is editable state so a merchant can complete a field Shopify
  // left blank. Seeded from whatever the last import (or their own edit) put
  // there.
  const [addressValues, setAddressValues] = React.useState(address.values);

  const [urgentIsDifferent, setUrgentIsDifferent] = React.useState(
    Boolean(application?.urgentContactName),
  );

  const handleChange = (field, value) =>
    setFormData((prev) => ({ ...prev, [field]: value }));

  const handleAddressChange = (field, value) =>
    setAddressValues((prev) => ({ ...prev, [field]: value }));

  const handleMarketChange = (market) => {
    setFormData((prev) => {
      const current = prev.markets || [];
      const updated = current.includes(market)
        ? current.filter((m) => m !== market)
        : [...current, market];
      return { ...prev, markets: updated };
    });
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const payload = new FormData();
    payload.set("intent", "submit");
    payload.set("contactName", formData.contactName || "");
    payload.set("phone", formData.phone || "");
    payload.set("urgentPhone", formData.urgentPhone || "");
    payload.set(
      "urgentContactName",
      urgentIsDifferent ? formData.urgentContactName || "" : "",
    );
    payload.set("email", formData.email || "");
    payload.set("legalBusinessName", formData.legalBusinessName || "");
    payload.set("gstHstNumber", formData.gstHstNumber || "");
    payload.set("productCategory", formData.productCategory || "Other");
    for (const field of ADDRESS_FIELDS) {
      payload.set(field.key, addressValues[field.key] || "");
    }
    (formData.markets || []).forEach((market) => payload.append("markets", market));
    fetcher.submit(payload, { method: "POST" });
  };

  const refreshFromShopify = () =>
    fetcher.submit({ intent: "refresh" }, { method: "POST" });

  const clearField = (field) =>
    fetcher.submit({ intent: "clear_field", field }, { method: "POST" });

  const refreshedLabel = imported.refreshedAt
    ? new Date(imported.refreshedAt).toLocaleString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  if (submitted) {
    return (
      <s-page heading="Application Submitted">
        <div className="mv-container">
          <div className="mv-section-card" style={{ textAlign: "center", padding: "3rem" }}>
            <div style={{ fontSize: "4rem", marginBottom: "1rem" }}>✓</div>
            <h2 className="mv-page-title" style={{ marginBottom: "1rem" }}>Application Submitted</h2>
            <p className="mv-page-subtitle" style={{ maxWidth: "500px", margin: "0 auto 2rem" }}>
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
    <s-page heading="Apply to access MoonVella">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Apply to access MoonVella</h2>
          <p className="mv-page-subtitle">
            Submit your business details to access MoonVella&rsquo;s wholesale catalog and seller
            tools.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {/* ---------------------------------------------------------- *
            * 1. What Shopify knows about this store. Read-only.
            * ---------------------------------------------------------- */}
          <div className="mv-section-card">
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "1rem",
                flexWrap: "wrap",
              }}
            >
              <div>
                <h3 className="mv-settings-title" style={{ marginBottom: "0.25rem" }}>
                  Store information imported from Shopify
                </h3>
                <p className="mv-branding-message" style={{ margin: 0 }}>
                  {refreshedLabel
                    ? `Imported from Shopify. Last refreshed ${refreshedLabel}.`
                    : "Not yet imported from Shopify."}
                </p>
              </div>
              <button
                type="button"
                className="mv-btn mv-btn-secondary"
                onClick={refreshFromShopify}
                disabled={isSubmitting}
              >
                {isSubmitting ? "Contacting Shopify…" : "Refresh from Shopify"}
              </button>
            </div>

            {/*
              * Deliberately not "Shopify verified": these are the values Shopify
              * holds, read over the app's own authenticated session. MoonVella
              * has taken no step to confirm them against any registry, and a
              * badge claiming otherwise would be a claim the app cannot support.
              */}
            <p className="mv-branding-message" style={{ marginTop: "0.75rem" }}>
              These are the values your Shopify store holds, read through your authenticated
              session. MoonVella has not independently verified them. Read over Admin API
              version {apiVersion}.
            </p>

            {imported.error && (
              <p
                role="alert"
                style={{ color: "var(--danger-red)", fontSize: "0.8125rem", marginTop: "0.75rem" }}
              >
                The last import did not complete: {imported.error} Use “Refresh from Shopify”
                to try again.
              </p>
            )}

            <div className="mv-settings-grid" style={{ marginTop: "1.25rem" }}>
              {IMPORTED_FIELDS.map((field) => (
                <ImportedValue
                  key={field.key}
                  label={field.label}
                  value={imported.values[field.key]}
                  note={imported.notes[field.key]}
                />
              ))}
              {/* Both emails are shown side by side on purpose: they are
                  different mailboxes and the page must not imply one. */}
            </div>

            <p className="mv-branding-message" style={{ marginTop: "0.75rem" }}>
              The store owner email and the public store contact email are stored separately.
              The owner email identifies the account; the public address is the one your
              storefront publishes.
            </p>
          </div>

          {/* ---------------------------------------------------------- *
            * 2. Company details and the registered address.
            * ---------------------------------------------------------- */}
          <div className="mv-section-card">
            <h3 className="mv-settings-title">Company details</h3>
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Legal business name</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={formData.legalBusinessName}
                  onChange={(e) => handleChange("legalBusinessName", e.target.value)}
                  aria-invalid={!!fieldErrors.legalBusinessName}
                />
                {/*
                  * Left blank rather than prefilled from the store display name.
                  * "Baxter's Bedding" is a shop title; the registered company may
                  * be "Baxter Household Goods Inc." Guessing would put an
                  * invented legal name into the Odoo customer record.
                  */}
                <SourceNote note="The name on your business registration. This is not the same as your Shopify store display name above." />
                {fieldErrors.legalBusinessName && (
                  <p style={{ color: "var(--danger-red)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {fieldErrors.legalBusinessName}
                  </p>
                )}
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
                {/* Recorded, not checked. There is no validation service behind
                    this field and no status column that claims otherwise. */}
                <SourceNote note="Recorded as you enter it. MoonVella does not validate this number, so it is not shown as verified." />
              </div>
            </div>

            <h3 className="mv-settings-title" style={{ marginTop: "1.5rem" }}>
              Business address
            </h3>
            <p className="mv-branding-message" style={{ marginBottom: "1rem" }}>
              Imported from your Shopify store’s billing address where it is set. Complete any
              field Shopify left blank — each one says below it where its current value came
              from.
            </p>
            <div className="mv-settings-grid">
              {ADDRESS_FIELDS.map((field) => {
                const source = address.sources[field.key];
                const importedValue = importedAddress[field.key];
                return (
                  <div className="mv-settings-field" key={field.key}>
                    <span className="mv-settings-label">
                      {field.label}
                      {!field.required && " (optional)"}
                    </span>
                    <input
                      type="text"
                      className="mv-settings-input"
                      value={addressValues[field.key] ?? ""}
                      onChange={(e) => handleAddressChange(field.key, e.target.value)}
                      aria-invalid={!!fieldErrors[field.key]}
                    />
                    <SourceNote note={imported.notes[field.key]} />
                    {source === "MERCHANT" && (
                      <button
                        type="button"
                        className="mv-link-button"
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          marginTop: "0.25rem",
                          color: "var(--primary-color)",
                          fontSize: "0.72rem",
                          cursor: "pointer",
                          textDecoration: "underline",
                        }}
                        onClick={() => clearField(field.key)}
                        disabled={isSubmitting}
                      >
                        Clear and re-import this field
                        {importedValue ? ` (Shopify has “${importedValue}”)` : ""}
                      </button>
                    )}
                    {fieldErrors[field.key] && (
                      <p style={{ color: "var(--danger-red)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                        {fieldErrors[field.key]}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ---------------------------------------------------------- *
            * 3. The person MoonVella deals with.
            * ---------------------------------------------------------- */}
          <div className="mv-section-card">
            <h3 className="mv-settings-title">Partner contact information</h3>
            <p className="mv-branding-message" style={{ marginBottom: "1rem" }}>
              The person MoonVella should contact about this account. This is kept separate from
              the Shopify store addresses shown above.
            </p>
            <div className="mv-settings-grid">
              <div className="mv-settings-field">
                <span className="mv-settings-label">Contact name</span>
                <input
                  type="text"
                  className="mv-settings-input"
                  value={formData.contactName}
                  onChange={(e) => handleChange("contactName", e.target.value)}
                  aria-invalid={!!fieldErrors.contactName}
                />
                {fieldErrors.contactName && (
                  <p style={{ color: "var(--danger-red)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {fieldErrors.contactName}
                  </p>
                )}
              </div>

              <div className="mv-settings-field">
                <span className="mv-settings-label">Contact email</span>
                <input
                  type="email"
                  className="mv-settings-input"
                  value={formData.email}
                  onChange={(e) => handleChange("email", e.target.value)}
                  aria-invalid={!!fieldErrors.email}
                />
                <SourceNote note="Prefilled from your store email for convenience. Enter the address of the person named above if that is somebody else." />
                {fieldErrors.email && (
                  <p style={{ color: "var(--danger-red)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {fieldErrors.email}
                  </p>
                )}
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
                  aria-invalid={!!fieldErrors.urgentPhone}
                />
                <SourceNote note="For urgent issues related to orders, fulfillment or delivery." />
                {fieldErrors.urgentPhone && (
                  <p style={{ color: "var(--danger-red)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                    {fieldErrors.urgentPhone}
                  </p>
                )}
              </div>
            </div>

            <label
              className="mv-settings-checkbox"
              style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}
            >
              <input
                type="checkbox"
                checked={urgentIsDifferent}
                onChange={(e) => setUrgentIsDifferent(e.target.checked)}
              />
              <span>The urgent contact is a different person from the contact above</span>
            </label>

            {urgentIsDifferent && (
              <div className="mv-settings-grid" style={{ marginTop: "0.75rem" }}>
                <div className="mv-settings-field">
                  <span className="mv-settings-label">Urgent contact name</span>
                  <input
                    type="text"
                    className="mv-settings-input"
                    value={formData.urgentContactName}
                    onChange={(e) => handleChange("urgentContactName", e.target.value)}
                  />
                  {/*
                    * A name is asked for because a number alone does not answer
                    * "who do we call". It is stored in its own column rather
                    * than being written into the main contact's name.
                    */}
                  <SourceNote note="Who MoonVella should ask for on the urgent number." />
                </div>
              </div>
            )}
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
            <p className="mv-branding-message">
              MoonVella reads recent Shopify activity with reporting permissions on this shop
              during review. Nothing is asked of you here.
            </p>
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
            <button
              type="submit"
              className="mv-btn mv-btn-primary"
              onClick={() => setIntent("submit")}
              disabled={isSubmitting}
            >
              {isSubmitting ? "Submitting..." : "Submit Application"}
            </button>
          </div>
        </form>
      </div>
    </s-page>
  );
}
