import React from "react";
import PropTypes from "prop-types";
import { Link, redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  asAccessResponse,
  requireMerchantAccess,
} from "../services/seller.server";
/*
 * Where each fact is stored, and what the form starts with. Shared with the
 * suite that checks them: the list is the one authority for the write, the read
 * and the refresh, and the seed is a plain function so the field values the page
 * renders can be asserted without a browser.
 */
import {
  ADDRESS_FIELDS,
  IMPORTED_FIELDS,
  STORED_FIELDS,
  contactEmailNote,
  contactEmailPrefill,
  importedColumns,
  isMerchantOwnedSource,
  seedFormState,
} from "../utils/applicationFields";
/*
 * The address entry aid. All of its logic is in the typed modules — this file
 * is `.jsx`, which this build never typechecks, so what it does with a picked
 * address is assigning values and nothing else.
 */
import { createAddressEntryAid } from "../utils/placesEntryAid";

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
          // Every imported value that has a column, from the one list that says
          // which is which. The fields are no longer named here one by one: the
          // last time they were, four of them were left out and the page showed
          // blank boxes for facts Shopify had answered.
          ...importedColumns(imported.profile, context.shop),
          profileFieldSources: imported.sources,
          shopifyProfileJson: imported.raw ?? {},
          profileRefreshedAt: new Date(),
          profileRefreshError: null,
        },
        update: {
          ...importedColumns(imported.profile, context.shop),
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

  // The browser key is read on the server, from the encrypted store, and only
  // its value crosses to the page. The server-side key — the one that can spend
  // the account's validation quota — is not reachable from here at all.
  const { browserKeyForPlaces } = await import("../services/addressValidation.server");
  const placesBrowserKey = await browserKeyForPlaces();

  return {
    // Serialized values only: the explanation of a blank field is data, so it
    // travels with the response rather than being computed by the component.
    // A `.server` module cannot be reached from client code in this build.
    apiVersion: SHOP_API_VERSION,
    imported: {
      // Read by column, not by the import's own name for the fact: four of the
      // nine are stored under a different one, which is what made them render
      // blank while their sources said "SHOPIFY".
      values: Object.fromEntries(
        IMPORTED_FIELDS.map((f) => [f.key, row?.[f.column] ?? null]),
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
    /*
     * The one credential this app deliberately hands to a page — a
     * referrer-restricted browser key whose only enabled API is Places. It is
     * null unless the owner has saved one, and the page renders exactly as it
     * does today when it is: no key, no suggestions, fields still typeable.
     */
    placesBrowserKey,
    // A row exists as soon as the page is opened, because the imported profile is
    // stored on it — but the merchant's own answers are only there once they have
    // submitted. Those come back as null on a draft and are rendered as empty
    // fields: an input holding the string "null" would be worse than a blank one,
    // and a select that pre-picks "Other" would claim an answer nobody gave.
    application: row
      ? {
          contactName: row.contactName ?? "",
          phone: row.phone ?? "",
          urgentPhone: row.urgentPhone ?? "",
          urgentContactName: row.urgentContactName ?? "",
          email: row.email ?? "",
          legalBusinessName: row.legalBusinessName ?? "",
          gstHstNumber: row.gstHstNumber ?? "",
          productCategory: row.productCategory ?? "",
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
  /*
   * Saving for later is not submitting.
   *
   * "Save & Continue Later" sent `intent=submit` and was then held to the
   * submission's rules, so the one button a merchant presses when they cannot
   * finish yet was the one that refused to save a half-finished form. A draft is
   * written with whatever is filled in; the required fields are enforced on the
   * submission, where they belong.
   */
  const savingDraft = intent === "save";

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

    /*
     * Written by column, from the same list the page reads.
     *
     * This loop used to copy every key of the imported profile straight into
     * `data`, so it asked the database to set `myshopifyDomain`, `storefrontUrl`,
     * `countryCode`, `plan` and `shopOwnerName` — five names that are not columns.
     * Prisma refuses the whole query over the first unknown argument, so
     * "Refresh from Shopify" failed every time it was pressed. The button a
     * merchant reaches for when a field looks wrong was the one control on the
     * page that could not work.
     */
    for (const field of STORED_FIELDS) {
      const key = field.key;
      // The identity column is the session's, not the response's.
      if (field.identity) continue;

      /*
       * A field the merchant typed is theirs, and so is one they chose from a
       * suggestion: both describe an address somebody settled on deliberately,
       * and a refresh must not quietly put Shopify's older value back. The two
       * differ only in where the value came from, which is why the test is one
       * shared rule rather than the word "MERCHANT" written out here — the last
       * time this comparison was spelled out by hand it did not know about the
       * second source at all. Clearing is available per field for when they want
       * Shopify's value back.
       */
      const overridden = isMerchantOwnedSource(storedSources[key]);
      if (overridden && onlyField !== key) continue;

      data[field.column] = imported.profile[key];
      nextSources[key] = imported.sources[key];
    }

    // `storeName` is NOT NULL and keeps its own fallback chain: the import, then
    // what is already stored, then the shop domain.
    data.storeName = imported.profile.storeName || existing?.storeName || shop;
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

  /*
   * The submission's requirements, enforced here rather than only in the form:
   * a browser is not the authority on what may be submitted. The legal business
   * name and a complete address are what the Odoo customer record and a carrier
   * label are built from, so an incomplete submission is refused with the list
   * of what is still missing. Street 2 and the GST/HST number are optional, and
   * a draft is not held to any of it.
   */
  const errors = {};
  if (!savingDraft) {
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
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, error: "Please correct the highlighted fields." };
  }

  /*
   * Provenance for each address column.
   *
   * A value equal to the one Shopify returned keeps its imported source; a
   * different one is the merchant's — typed by them, or chosen from a Google
   * suggestion, which the form marks with `source_<key>`. Comparing against the
   * *stored* import rather than re-reading Shopify here is deliberate: it keeps
   * submission from depending on a live API call, so a merchant can still apply
   * during a Shopify outage — and the stored import is the same snapshot they
   * were looking at when they typed.
   *
   * The marker is a claim only the page can make, and it is accepted because it
   * claims LESS than the alternative. "Chosen from a suggestion" is not a
   * statement that Google confirmed anything — it is the record of where the
   * value came from, which is exactly what a reviewer needs and what no verdict
   * is built on. Anything other than the one accepted word is ignored, so the
   * stored vocabulary stays closed.
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
      const marked = str(formData, `source_${field.key}`).toUpperCase();
      nextSources[field.key] = marked === "GOOGLE" ? "GOOGLE" : "MERCHANT";
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
  // again: its own state is the request to re-enter the queue. A draft save is
  // neither: unfinished work must not move a store through the queue, so a save
  // keeps whatever state the row already had.
  let status = existing?.status ?? "PENDING";
  if (
    !savingDraft &&
    (!existing ||
      existing.status === "REJECTED" ||
      existing.status === "NEEDS_INFO" ||
      existing.status === "DEACTIVATED")
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
    /*
     * `submittedAt` is the marker that separates a draft from an application:
     * it is set on the submission and never on a save, so "has this merchant
     * applied" is answerable from the row alone.
     *
     * It is written on BOTH branches, and that is the point. A row already
     * exists by the time anyone submits, because the first visit to this page
     * stores the imported Shopify profile on one — so the submission always
     * takes the update branch. That branch used to write the answers and leave
     * this column alone: the merchant was told "Application Submitted", their
     * details were saved, and the row stayed a draft for ever. The owner's
     * queue reads `submittedAt IS NOT NULL`, so it listed nothing at all while
     * the application sat there complete.
     *
     * An existing value is kept rather than overwritten: a merchant editing an
     * application they have already submitted has not un-submitted it, and the
     * date a reviewer reads should be the date it was first submitted.
     */
    create: { shopDomain: shop, ...data, submittedAt: savingDraft ? null : new Date() },
    update: savingDraft
      ? data
      : { ...data, submittedAt: existing?.submittedAt ?? new Date() },
  });

  const { recordAudit, AUDIT_ENTITY } = await import("../services/audit.server");
  await recordAudit({
    actorType: "MERCHANT",
    actorId: shop,
    actorName: storeName,
    action: savingDraft
      ? "application.draft_saved"
      : existing
        ? "application.updated"
        : "application.submitted",
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
      // Separated from the typed ones because the two are different facts: a
      // suggestion was offered and accepted, which says nothing about whether
      // the address is right — only where it came from.
      googleSuggested: Object.entries(nextSources)
        .filter(([, source]) => source === "GOOGLE")
        .map(([key]) => key),
      draft: savingDraft,
    },
  });

  // The two are answered differently by the page on purpose: a draft is saved,
  // an application is submitted for review, and a toast that says "will review
  // your store" after a half-finished save is a claim the row does not support.
  return savingDraft
    ? { ok: true, draft: true }
    : { ok: true, submitted: true, status: saved.status };
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
  const { imported, importedAddress, address, application, apiVersion, placesBrowserKey } =
    useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSubmitting = fetcher.state !== "idle";
  const submitted = fetcher.data?.submitted === true;
  const draftSaved = fetcher.data?.draft === true;
  const refreshed = fetcher.data?.refreshed === true;
  const serverError = fetcher.data?.error;
  /*
   * What the form found missing, before the request left. It holds the same
   * shape the action returns, so the fields render one set of messages whichever
   * side answered — and the server's answer replaces this one as soon as it
   * arrives, because the server is still the authority.
   */
  const [localErrors, setLocalErrors] = React.useState({});
  const fieldErrors = { ...localErrors, ...(fetcher.data?.errors || {}) };
  const [intent, setIntent] = React.useState("submit");

  React.useEffect(() => {
    if (submitted || draftSaved) {
      // The form's own findings are cleared once the server has accepted what
      // was sent: leaving them up would tell a merchant to fix something that
      // is no longer wrong.
      setLocalErrors({});
    }
    if (submitted) {
      shopify.toast.show(
        "Application submitted. MoonVella will review your store before wholesale access is unlocked.",
      );
      return;
    }
    if (draftSaved) {
      // Deliberately not the submission's sentence: nothing has been sent for
      // review, and saying otherwise would be a promise the row cannot keep.
      shopify.toast.show("Saved. You can finish your application later.");
      if (intent === "save") {
        navigate("/app/status");
      }
    }
  }, [submitted, draftSaved, intent, shopify, navigate]);

  React.useEffect(() => {
    if (refreshed) {
      shopify.toast.show("Store information refreshed from Shopify.");
    }
  }, [refreshed, shopify]);

  // Seeded by a function the suite calls too, so what the form starts with is
  // checkable without a browser — the prefill under the contact email is a
  // promise the page makes in writing, and it is asserted rather than assumed.
  const [formData, setFormData] = React.useState(() =>
    seedFormState(application, imported),
  );

  // The address is editable state so a merchant can complete a field Shopify
  // left blank. Seeded from whatever the last import (or their own edit) put
  // there.
  const [addressValues, setAddressValues] = React.useState(address.values);

  /*
   * Which address columns are holding a value the merchant chose from a Google
   * suggestion, and has not edited since.
   *
   * Editing a column clears its mark, so what is submitted is a claim about the
   * value actually in the box rather than about a suggestion that was once
   * taken: type over the city and the city is yours.
   */
  const [googleFields, setGoogleFields] = React.useState({});

  const [urgentIsDifferent, setUrgentIsDifferent] = React.useState(
    Boolean(application?.urgentContactName),
  );

  const handleChange = (field, value) =>
    setFormData((prev) => ({ ...prev, [field]: value }));

  const handleAddressChange = (field, value) => {
    setAddressValues((prev) => ({ ...prev, [field]: value }));
    setGoogleFields((prev) => (prev[field] ? { ...prev, [field]: false } : prev));
  };

  const contactEmailSource = contactEmailPrefill(application, imported);

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
    /*
     * Which button was pressed, read from the event rather than from state.
     *
     * The two buttons used to set a piece of state their own submit handler
     * then read, so whether a merchant saved a draft or submitted an
     * application depended on a re-render landing between the click and the
     * submit. Enter inside a field has no button behind it, and means submit.
     */
    const pressed =
      event.nativeEvent?.submitter?.getAttribute("value") === "save" ? "save" : "submit";
    setIntent(pressed);

    /*
     * The form states the submission's requirement before the request leaves.
     *
     * The same list the server enforces from — `required` on the address fields
     * in `ADDRESS_FIELDS`, and the four named answers — so the two cannot
     * disagree, and a merchant sees what is missing without a round trip. A
     * draft is checked against none of it: that is the whole point of saving one.
     */
    if (pressed === "submit") {
      const missing = {};
      if (!String(formData.legalBusinessName || "").trim()) {
        missing.legalBusinessName = "Legal business name is required.";
      }
      if (!String(formData.contactName || "").trim()) {
        missing.contactName = "Contact name is required.";
      }
      if (!isEmail(formData.email)) {
        missing.email = "A valid email address is required.";
      }
      for (const field of ADDRESS_FIELDS) {
        if (field.required && !String(addressValues[field.key] || "").trim()) {
          missing[field.key] = `${field.label} is required.`;
        }
      }
      if (
        urgentIsDifferent &&
        String(formData.urgentContactName || "").trim() &&
        !String(formData.urgentPhone || "").trim()
      ) {
        missing.urgentPhone =
          "An urgent contact name was given, so an urgent contact number is required.";
      }
      setLocalErrors(missing);
      if (Object.keys(missing).length > 0) return;
    } else {
      setLocalErrors({});
    }

    const payload = new FormData();
    payload.set("intent", pressed);
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
      // Only the columns still holding a suggestion the merchant accepted and
      // left alone carry the mark; an edited one is simply theirs.
      if (googleFields[field.key]) payload.set(`source_${field.key}`, "GOOGLE");
    }
    (formData.markets || []).forEach((market) => payload.append("markets", market));
    fetcher.submit(payload, { method: "POST" });
  };

  /*
   * The address entry aid, attached to Street 1.
   *
   * What it fills is the five address columns, one value each; what it never
   * touches is Street 2. The unit is the exact thing Google offers to fold into
   * a street line, and a unit lost that way is a delivery to a different door —
   * so the unit is reported as a sentence and the column stays the merchant's.
   *
   * The whole aid is inert without a key: `placesBrowserKey` is null until the
   * owner saves one, and the fields go on working as ordinary text boxes. The
   * render says so in as many words — a field that silently offers nothing is
   * indistinguishable from one that is broken, and the merchant can fix
   * neither. What must not change is the fallback: the fields render and behave
   * exactly as they did
   * before this existed.
   */
  const street1Ref = React.useRef(null);
  const suggestionListRef = React.useRef(null);
  const [aidStatus, setAidStatus] = React.useState("idle");
  const [aidReason, setAidReason] = React.useState(null);
  const [unitHint, setUnitHint] = React.useState(null);

  React.useEffect(() => {
    if (!placesBrowserKey || !street1Ref.current || !suggestionListRef.current) return undefined;
    const aid = createAddressEntryAid({
      apiKey: placesBrowserKey,
      input: street1Ref.current,
      list: suggestionListRef.current,
      onStatus: (status, reason) => {
        setAidStatus(status);
        setAidReason(reason ?? null);
      },
      onPick: (picked) => {
        const keys = Object.keys(picked.fields);
        setAddressValues((prev) => {
          const next = { ...prev };
          for (const key of keys) next[key] = picked.fields[key];
          return next;
        });
        setGoogleFields((prev) => {
          const next = { ...prev };
          for (const key of keys) next[key] = true;
          return next;
        });
        setUnitHint(picked.unitHint);
      },
    });
    return () => aid.destroy();
  }, [placesBrowserKey]);

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
              from. Street 1, city, province, postal code and country are required to submit;
              Street 2 and the GST/HST number are optional, and you can save a draft at any
              point.
            </p>
            {placesBrowserKey ? (
              <p className="mv-branding-message" style={{ marginBottom: "1rem" }}>
                Typing a street address offers Google’s suggestions. Choosing one fills the
                fields below so the province and postal code arrive in the form a carrier
                wants. This is an entry aid, not a check: a suggestion is not a confirmation
                that this is your registered address, nothing is verified by taking one, and
                your Unit / Street 2 line is never filled from it.
              </p>
            ) : (
              /*
               * Switched off, and said out loud.
               *
               * With no browser key the aid is inert: the street field became an
               * ordinary text box that offered nothing when typed into, and the
               * page said nothing about why. An entry aid that is missing and an
               * entry aid that is broken look identical from here, and the
               * merchant is the one person who cannot fix either — so the state
               * is named rather than left to be discovered by typing and waiting
               * for a list that never comes.
               */
              <p
                className="mv-branding-message"
                role="status"
                style={{ marginBottom: "1rem" }}
              >
                Address suggestions are switched off: this app has no Google Maps browser
                key configured. Type the full address into the fields below — they work
                exactly as they look, and nothing else about your application changes.
              </p>
            )}
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
                      ref={field.key === "addressLine1" ? street1Ref : undefined}
                    />
                    {field.key === "addressLine1" && placesBrowserKey && (
                      <>
                        <div
                          ref={suggestionListRef}
                          className="mv-place-suggestions"
                          style={{
                            marginTop: "0.25rem",
                            border: "1px solid var(--border-color, #e5e5e5)",
                            borderRadius: "var(--radius-md, 6px)",
                            background: "#fff",
                            overflow: "hidden",
                          }}
                        />
                        {aidStatus === "failed" && aidReason ? (
                          <p
                            role="status"
                            style={{
                              color: "var(--text-secondary)",
                              fontSize: "0.72rem",
                              marginTop: "0.25rem",
                            }}
                          >
                            Address suggestions are unavailable: {aidReason} Keep typing — the
                            fields above work as they always did.
                          </p>
                        ) : null}
                      </>
                    )}
                    {field.key === "addressLine2" && unitHint ? (
                      /*
                       * Google's unit, said rather than written. Filling Street 2
                       * from a suggestion would be this app deciding which door a
                       * shipment goes to on the strength of a record it has not
                       * checked, so the merchant is told and the column stays theirs.
                       */
                      <SourceNote
                        note={`Google’s record for the address you chose includes “${unitHint}”. Street 2 is left as you typed it — add it there if it belongs on your label.`}
                      />
                    ) : null}
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
                {/* Names the mailbox this box was actually filled from: the
                    seed falls back through the merchant's own answer, the
                    account owner's private address and the storefront's public
                    one, and one sentence cannot honestly describe all three. */}
                <SourceNote note={contactEmailNote(contactEmailSource)} />
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
              name="intent"
              value="save"
              className="mv-btn mv-btn-secondary"
              disabled={isSubmitting}
            >
              {isSubmitting && intent === "save" ? "Saving..." : "Save & Continue Later"}
            </button>
            <button
              type="submit"
              name="intent"
              value="submit"
              className="mv-btn mv-btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting && intent === "submit" ? "Submitting..." : "Submit Application"}
            </button>
          </div>
        </form>
      </div>
    </s-page>
  );
}
