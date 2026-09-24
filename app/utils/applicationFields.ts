/**
 * Where each fact on the merchant application lives, and what the form starts
 * with.
 *
 * This module exists because the page read and wrote these values in three
 * different places and the three disagreed. The import wrote six columns by
 * hand and silently dropped four; the page read the row by the import's own
 * name for each fact, and four of those names are not column names, so the
 * myshopify domain, the storefront URL, the country and the Shopify plan
 * rendered blank while `profileFieldSources` recorded "SHOPIFY" against every
 * one of them; and the refresh action copied every name of the raw profile into
 * an update, five of which the database does not have, so it threw before
 * writing anything. One list now says where each value lives, and the write, the
 * read and the refresh all go through it.
 *
 * It is plain data and pure functions on purpose: the suite calls
 * `seedFormState` and `importedColumns` directly, so what the page renders and
 * what the import stores are checkable without a browser and without a Shopify
 * session.
 */

import type { ShopProfile } from "~/services/shopProfile.server";

export interface StoredField {
  /** The import's own name for the fact. Keys `profileFieldSources`. */
  key: string;
  /** The column the value is stored in. Not always the same as `key`. */
  column: string;
  label: string;
  /**
   * The row's identity column: set from the authenticated session's shop and
   * never written from an API value, because it is the key every query on this
   * page looks the row up by.
   */
  identity?: boolean;
  /** The merchant has to supply it before the application can be submitted. */
  required?: boolean;
}

/**
 * The imported store facts, in the order the page shows them.
 *
 * This list is what makes "every imported field explains itself" checkable: the
 * loader returns a note for each key named here, and the page renders the note
 * under the value.
 */
export const IMPORTED_FIELDS: StoredField[] = [
  { key: "storeName", column: "storeName", label: "Store display name" },
  { key: "shopifyShopId", column: "shopifyShopId", label: "Shopify shop ID" },
  { key: "myshopifyDomain", column: "shopDomain", label: "myshopify domain", identity: true },
  { key: "storefrontUrl", column: "storeUrl", label: "Storefront URL" },
  { key: "storeOwnerEmail", column: "storeOwnerEmail", label: "Store owner email" },
  { key: "storeContactEmail", column: "storeContactEmail", label: "Public store contact email" },
  { key: "countryCode", column: "country", label: "Country" },
  { key: "currency", column: "currency", label: "Currency" },
  { key: "plan", column: "shopifyPlan", label: "Shopify plan" },
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
export const ADDRESS_FIELDS: StoredField[] = [
  // `column` repeats `key` here: the import's name for an address fact and the
  // column holding it were chosen together. Stated rather than assumed so the
  // read and write loops treat every stored field the same way.
  { key: "addressLine1", column: "addressLine1", label: "Street 1", required: true },
  { key: "addressLine2", column: "addressLine2", label: "Street 2", required: false },
  { key: "addressCity", column: "addressCity", label: "City", required: true },
  { key: "addressProvinceCode", column: "addressProvinceCode", label: "Province / State", required: true },
  { key: "addressPostalCode", column: "addressPostalCode", label: "Postal / ZIP code", required: true },
  { key: "addressCountryCode", column: "addressCountryCode", label: "Country code", required: true },
];

/** Everything the page reads from a stored column. */
export const STORED_FIELDS: StoredField[] = [...IMPORTED_FIELDS, ...ADDRESS_FIELDS];

/**
 * What an import writes, keyed by column.
 *
 * Built from the list above rather than written out by hand: the hand-written
 * version named six columns and dropped the other four, which is how a
 * successful import produced a blank Storefront URL. The identity column is the
 * only field exempt, being the session's.
 */
export function importedColumns(
  profile: ShopProfile,
  shop: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of IMPORTED_FIELDS) {
    if (field.identity) continue;
    // `storeName` is NOT NULL, so an import that returned no name falls back to
    // the shop domain rather than writing null into a required column.
    out[field.column] =
      profile[field.key as keyof ShopProfile] || (field.key === "storeName" ? shop : null);
  }
  return out;
}

/**
 * Values the merchant owns, as opposed to values an import supplied.
 *
 * GOOGLE belongs on this side: the merchant chose the suggestion and kept it, so
 * a refresh must not overwrite it with Shopify's older value — the same rule
 * that already protects a typed one. The two differ only in where the value came
 * from, which is what `explainSource` is for; they behave identically.
 */
export function isMerchantOwnedSource(source: string | null | undefined): boolean {
  return source === "MERCHANT" || source === "GOOGLE";
}

/**
 * Which mailbox the contact email box is holding.
 *
 * The note under that field used to say the value came from "your Shopify
 * store's own email address" whatever it actually held — and the seed falls back
 * through three different mailboxes, one of which (the account owner's) is
 * private and is not the address the storefront publishes. Naming the mailbox
 * the value really came from is the difference between a note and a claim.
 */
export type ContactEmailPrefill = "ANSWER" | "OWNER" | "STORE" | "NONE";

export function contactEmailPrefill(
  application: ApplicationAnswers | null | undefined,
  imported: { values?: Record<string, string | null> } | null | undefined,
): ContactEmailPrefill {
  const values = imported?.values ?? {};
  if (application?.email) return "ANSWER";
  if (values.storeOwnerEmail) return "OWNER";
  if (values.storeContactEmail) return "STORE";
  return "NONE";
}

const CONTACT_EMAIL_NOTES: Record<ContactEmailPrefill, string> = {
  ANSWER:
    "The address you saved with this application. MoonVella has not verified it.",
  OWNER:
    "Prefilled from the email address that owns your Shopify account. That mailbox is private and is not the one your storefront publishes — replace it with the address of the person named above if they are somebody else.",
  STORE:
    "Prefilled from the public contact email your Shopify storefront publishes. Replace it if the person named above uses a different address.",
  NONE:
    "Shopify returned no email address for this store, so enter the address MoonVella should use.",
};

export function contactEmailNote(prefill: ContactEmailPrefill): string {
  return CONTACT_EMAIL_NOTES[prefill];
}

/** The merchant's own answers, as the loader sends them. Empty on a draft. */
export interface ApplicationAnswers {
  contactName?: string | null;
  phone?: string | null;
  urgentPhone?: string | null;
  urgentContactName?: string | null;
  email?: string | null;
  legalBusinessName?: string | null;
  gstHstNumber?: string | null;
  productCategory?: string | null;
  markets?: string[] | null;
}

export interface ApplicationFormState {
  contactName: string;
  phone: string;
  urgentPhone: string;
  urgentContactName: string;
  email: string;
  legalBusinessName: string;
  gstHstNumber: string;
  productCategory: string;
  markets: string[];
}

/**
 * What the form starts with.
 *
 * `application` holds the merchant's own answers and is empty on a draft, which
 * is why the two fields the page offers a default for use `||` rather than `??`:
 * an empty answer has to fall back the same way a missing row does, or a store
 * would be shown an empty box where a new one is offered its own store email,
 * and a category select holding a value that matches no option.
 *
 * The contact email is prefilled from whichever mailbox Shopify answered with,
 * and the note under that field names that mailbox — derived by
 * `contactEmailPrefill` rather than written by hand, because the hand-written
 * version named one mailbox while the seed could fill the box from any of three.
 * It stays editable: the person MoonVella should call about an account is often
 * not the mailbox the storefront publishes.
 */
export function seedFormState(
  application: ApplicationAnswers | null | undefined,
  imported: { values?: Record<string, string | null> } | null | undefined,
): ApplicationFormState {
  const values = imported?.values ?? {};
  return {
    contactName: application?.contactName ?? "",
    phone: application?.phone ?? "",
    urgentPhone: application?.urgentPhone ?? "",
    urgentContactName: application?.urgentContactName ?? "",
    email:
      application?.email ||
      values.storeOwnerEmail ||
      values.storeContactEmail ||
      "",
    legalBusinessName: application?.legalBusinessName ?? "",
    gstHstNumber: application?.gstHstNumber ?? "",
    productCategory: application?.productCategory || "Bedding & Bath",
    markets:
      application?.markets && application.markets.length
        ? application.markets
        : ["Ontario"],
  };
}
