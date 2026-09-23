/**
 * Approval-time contact sync: MoonVella seller → Odoo contact.
 *
 * WHAT THIS REPLACES. Until now nothing in MoonVella called the Odoo connector
 * at all — `upsertPartner` had no caller, and "partner sync" described a library
 * rather than a running process. This module is the caller, and it is
 * deliberately narrow: it writes one company contact and up to two child
 * contacts per approved seller, and nothing else in Odoo.
 *
 * THE SHAPE OF IT.
 *
 *   buildContactPlan   pure. Given the seller's facts and the Odoo ids they
 *                      resolve to, it produces exactly what would be written,
 *                      per role. No network, no database, so the mapping can be
 *                      asserted field by field in a test.
 *
 *   syncSellerContacts the caller. Resolves the reference ids, builds the plan,
 *                      writes through the connector's guarded functions, and
 *                      records the result on ExternalContactMapping.
 *
 * WHY THE MAPPING TABLE IS THE AUTHORITY. Identity is decided once — the first
 * time a seller is synced — and recorded. Every later run reads the recorded
 * partner ids and writes to them. That is what makes a retry, a reapplication
 * or a second approval update the same records instead of deciding afresh; and
 * it is why a retry never re-runs the identity judgement, which is the only
 * place a duplicate company could come from.
 *
 * WHAT IT WILL NOT DO. It does not merge. Two existing Odoo contacts that
 * disagree about a tax id are a finding for a person, and the sync fails with
 * the reason rather than picking one. It does not overwrite fields it does not
 * own: only the mapped columns are written, and an empty MoonVella value means
 * "say nothing", never "clear the column". It does not put the urgent number in
 * `mobile` — see `buildContactPlan`.
 */

import { createHash } from "node:crypto";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { PermanentJobError } from "./jobs.server";
import type { ContactRole } from "@prisma/client";
import {
  OdooError,
  createPartner,
  findContactTagByName,
  findCountryByCode,
  findStateByCode,
  readPartner,
  resolvePartner,
  updatePartner,
  type PartnerValues,
} from "./odoo.server";

/**
 * A failure that a retry cannot fix. Recorded once, then handed to a person.
 *
 * The `permanent` flag is inherited from `PermanentJobError` so the queue's
 * runner treats it as final without this module having to know how the runner
 * recognises one.
 */
export class ContactSyncBlockedError extends PermanentJobError {
  constructor(message: string) {
    super(message);
    this.name = "ContactSyncBlockedError";
  }
}

export interface ContactSyncFacts {
  sellerId: string;
  legalBusinessName: string;
  storeName: string | null;
  shopifyShopId: string | null;
  myshopifyDomain: string | null;
  storefrontUrl: string | null;
  businessPhone: string | null;
  gstHstNumber: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    provinceCode: string | null;
    postalCode: string | null;
    countryCode: string | null;
  };
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  urgent: {
    name: string | null;
    phone: string | null;
  };
}

export interface ResolvedReferences {
  countryId: number | null;
  stateId: number | null;
  /** `res.partner.category` id for the MoonVella contact tag. */
  contactTagId: number | null;
}

export interface ContactPlan {
  company: PartnerValues;
  /** The named contact. Null when the application gave no contact name. */
  contact: PartnerValues | null;
  /**
   * The urgent contact, as its own record. Null when no urgent number was given.
   *
   * WHY IT IS A SEPARATE RECORD. The directive is explicit that an emergency
   * number must not be written into `mobile` unless it is actually mobile, and
   * MoonVella has no way to know that it is. There is no installed Odoo field
   * for "urgent orders line" either — the only custom `res.partner` fields in
   * this database belong to PremaFirm's freight business. A child contact with
   * a person's name and the number in `phone` is the one honest place left:
   * `phone` is a general telephone field, the record is named, and it sits under
   * the company like any other contact.
   */
  urgent: PartnerValues | null;
  /** The tag ids to attach. Empty when the tag is not installed. */
  tagIds: number[];
  /** Facts that could not be mapped, each with the reason. */
  unresolved: string[];
}

/** What the sync did, for the audit trail and the owner's screen. */
export interface ContactSyncResult {
  companyPartnerId: number;
  companyOutcome: "CREATED" | "UPDATED" | "UNCHANGED";
  contactPartnerId: number | null;
  urgentPartnerId: number | null;
  unresolved: string[];
  tagId: number | null;
}

/* -------------------------------------------------------------------------- */
/* The mapping, as data                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Exactly which MoonVella value lands in which Odoo column.
 *
 * A table rather than a function body, because the mapping is the thing that
 * gets reviewed: every row here is a claim about where a merchant's data ends
 * up, and a row that is wrong is wrong in the same way whether or not the code
 * around it changed.
 */
export const COMPANY_FIELD_MAP = {
  "Legal business name": "name",
  "Business email": "email",
  "Business phone": "phone",
  "GST/HST number": "vat",
  "Street 1": "street",
  "Street 2": "street2",
  City: "city",
  "Postal / ZIP code": "zip",
  "Province / State": "state_id (resolved within the country)",
  Country: "country_id (resolved by ISO code)",
  "Storefront URL": "website",
  "Company type": "is_company = true",
  "Customer designation": "customer_rank = 1",
  "MoonVella contact tag": "category_id (added, not replaced)",
} as const;

/**
 * The company's own email, chosen by rule rather than by whichever field was
 * longest.
 *
 * The public store contact address is the business's published address and is
 * preferred; the account owner's address is second, because it is a real
 * address belonging to the business even though it is personal; the contact
 * person's address is last, because it belongs to a person and may change with
 * them. Which one was used is returned so the mapping is never a guess the
 * operator cannot see.
 */
export function chooseBusinessEmail(facts: {
  storeContactEmail: string | null;
  storeOwnerEmail: string | null;
  contactEmail: string | null;
}): { email: string | null; from: string | null } {
  if (facts.storeContactEmail) {
    return { email: facts.storeContactEmail, from: "public store contact email" };
  }
  if (facts.storeOwnerEmail) {
    return { email: facts.storeOwnerEmail, from: "store owner email" };
  }
  if (facts.contactEmail) {
    return { email: facts.contactEmail, from: "application contact email" };
  }
  return { email: null, from: null };
}

/**
 * Build every payload the sync would write. Pure.
 *
 * `resolved` carries the Odoo ids, which is what keeps this function free of
 * I/O: resolving a country code needs a query, so the caller does it and this
 * function is left with the decisions — which are the part worth testing.
 */
export function buildContactPlan(
  facts: ContactSyncFacts,
  resolved: ResolvedReferences,
  extra: { storeContactEmail?: string | null; storeOwnerEmail?: string | null } = {},
): ContactPlan {
  const unresolved: string[] = [];
  const tagIds = resolved.contactTagId ? [resolved.contactTagId] : [];

  if (resolved.contactTagId === null) {
    unresolved.push(
      `The MoonVella contact tag ("Moonvella app" on res.partner.category) was not found in Odoo, so no tag was applied.`,
    );
  }
  if (facts.address.countryCode && resolved.countryId === null) {
    unresolved.push(
      `Country code "${facts.address.countryCode}" is not installed in Odoo, so the address has no country.`,
    );
  }
  if (facts.address.provinceCode && resolved.countryId !== null && resolved.stateId === null) {
    unresolved.push(
      `"${facts.address.provinceCode}" is not a province or state of the country on this address in Odoo, so the address has no state.`,
    );
  }

  const business = chooseBusinessEmail({
    storeContactEmail: extra.storeContactEmail ?? null,
    storeOwnerEmail: extra.storeOwnerEmail ?? null,
    contactEmail: facts.contact.email,
  });

  const company: PartnerValues = {
    // The legal business name, never the store display name: a shop title is
    // not a company, and Odoo's contact record is the company.
    name: facts.legalBusinessName,
    email: business.email,
    phone: facts.businessPhone,
    // The installed tax-registration field. NOT a custom field: this database
    // has no MoonVella field on res.partner, and the freight fields that do
    // exist are another business's.
    vat: facts.gstHstNumber,
    street: facts.address.line1,
    street2: facts.address.line2,
    city: facts.address.city,
    zip: facts.address.postalCode,
    state_id: resolved.stateId,
    country_id: resolved.countryId,
    website: facts.storefrontUrl,
    is_company: true,
    customer_rank: 1,
    category_ids: tagIds,
  };

  const contact: PartnerValues | null = facts.contact.name
    ? {
        name: facts.contact.name,
        email: facts.contact.email,
        phone: facts.contact.phone,
        is_company: false,
        category_ids: tagIds,
        // parent_id is filled in by the caller: it is the company's id, which
        // does not exist until the company has been written.
      }
    : null;

  const urgent: PartnerValues | null = facts.urgent.phone
    ? {
        name:
          facts.urgent.name ||
          // Named for what it is when the number belongs to the contact above.
          // A record called "Acme — urgent orders line" tells the next reader
          // why it exists; an unnamed one does not.
          `${facts.legalBusinessName} — urgent orders line`,
        // `phone`, deliberately not `mobile`.
        phone: facts.urgent.phone,
        is_company: false,
        category_ids: tagIds,
      }
    : null;

  return { company, contact, urgent, tagIds, unresolved };
}

/** A hash of what would be written, so an unchanged retry can be skipped. */
export function payloadFingerprint(values: PartnerValues | null): string | null {
  if (!values) return null;
  const asRecord = values as unknown as Record<string, unknown>;
  const stable = Object.keys(asRecord)
    .sort()
    .map((key) => `${key}=${JSON.stringify(asRecord[key] ?? null)}`)
    .join("|");
  return createHash("sha256").update(stable).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Reading the facts out of MoonVella                                          */
/* -------------------------------------------------------------------------- */

export interface LoadedFacts {
  facts: ContactSyncFacts;
  /** Both store addresses, kept apart because they are different people. */
  storeContactEmail: string | null;
  storeOwnerEmail: string | null;
  /** False when the seller has no application row to read a legal name from. */
  hasApplication: boolean;
}

export async function loadContactFacts(sellerId: string): Promise<LoadedFacts> {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    include: { application: true },
  });
  if (!seller) throw new ContactSyncBlockedError(`Seller ${sellerId} does not exist.`);

  const application = seller.application;

  const legalBusinessName = application?.legalBusinessName?.trim();
  if (!legalBusinessName) {
    // The whole point of the sync is the company record, and Odoo will not
    // create a partner without a name. Failing here names the missing fact
    // instead of writing a contact called after the shop — which is the one
    // substitution the directive rules out by name.
    throw new ContactSyncBlockedError(
      "The application has no legal business name, so no company contact can be written. " +
        "The store must supply one before the sync can run.",
    );
  }

  return {
    hasApplication: application !== null,
    storeContactEmail: application?.storeContactEmail ?? null,
    storeOwnerEmail: application?.storeOwnerEmail ?? null,
    facts: {
      sellerId,
      legalBusinessName,
      // The store display name is carried alongside the legal name rather than
      // instead of it: the mapping records both, and the Odoo contact is named
      // after the company.
      storeName: seller.storeName,
      shopifyShopId: application?.shopifyShopId ?? null,
      // The authenticated shop domain IS the myshopify domain. It is what the
      // session proved, not something a form supplied.
      myshopifyDomain: seller.shopDomain,
      storefrontUrl: application?.storeUrl ?? seller.storeUrl ?? null,
      businessPhone: application?.phone ?? seller.phone ?? null,
      gstHstNumber: application?.gstHstNumber ?? null,
      address: {
        line1: application?.addressLine1 ?? null,
        line2: application?.addressLine2 ?? null,
        city: application?.addressCity ?? null,
        provinceCode: application?.addressProvinceCode ?? null,
        postalCode: application?.addressPostalCode ?? null,
        countryCode: application?.addressCountryCode ?? null,
      },
      contact: {
        name: application?.contactName ?? seller.contactName ?? null,
        email: application?.email ?? seller.contactEmail ?? null,
        phone: application?.phone ?? seller.phone ?? null,
      },
      urgent: {
        name: application?.urgentContactName ?? null,
        phone: application?.urgentPhone ?? null,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The sync                                                                    */
/* -------------------------------------------------------------------------- */

export interface SyncOptions {
  /** Must be true to write. False produces the plan and writes nothing. */
  confirm: boolean;
}

/**
 * Write (or preview) the seller's contacts into Odoo.
 *
 * Order matters: the company is written first because both children point at
 * it, and a child written before its parent would be an orphan record. If the
 * company write fails, nothing else is attempted and the error propagates to
 * the job runner, which records it and retries.
 */
export async function syncSellerContacts(
  sellerId: string,
  options: SyncOptions,
): Promise<ContactSyncResult | { preview: ContactPlan; executed: false }> {
  const loaded = await loadContactFacts(sellerId);
  const { facts } = loaded;

  // Resolve the references the write needs. Reads only.
  const country = facts.address.countryCode
    ? await findCountryByCode(facts.address.countryCode)
    : null;
  const state =
    country && facts.address.provinceCode
      ? await findStateByCode(country.id, facts.address.provinceCode)
      : null;
  const tag = await findContactTagByName();

  const resolved: ResolvedReferences = {
    countryId: country?.id ?? null,
    stateId: state?.id ?? null,
    contactTagId: tag?.id ?? null,
  };

  const plan = buildContactPlan(facts, resolved, {
    storeContactEmail: loaded.storeContactEmail,
    storeOwnerEmail: loaded.storeOwnerEmail,
  });

  if (!options.confirm) {
    return { preview: plan, executed: false };
  }

  const existing = await prisma.externalContactMapping.findMany({ where: { sellerId } });
  const byRole = new Map<ContactRole, (typeof existing)[number]>(
    existing.map((row) => [row.role, row]),
  );

  /* ---------------------------- company ---------------------------- */
  const companyMapping = byRole.get("COMPANY");
  const companyFingerprint = payloadFingerprint(plan.company);
  let companyPartnerId: number;
  let companyOutcome: ContactSyncResult["companyOutcome"];

  if (companyMapping?.odooPartnerId) {
    const current = await readPartner(companyMapping.odooPartnerId);
    if (!current) {
      // The mapped partner was deleted in Odoo. Writing to a missing id would
      // fail with an opaque RPC error, and re-deciding identity would be worse:
      // this needs a person to say whether the record moved or was removed.
      throw new ContactSyncBlockedError(
        `The mapped Odoo contact ${companyMapping.odooPartnerId} no longer exists. ` +
          `A person must decide whether the company was removed or merged before the sync is retried.`,
      );
    }
    if (companyMapping.payloadFingerprint === companyFingerprint) {
      companyPartnerId = companyMapping.odooPartnerId;
      companyOutcome = "UNCHANGED";
    } else {
      const written = await updatePartner(companyMapping.odooPartnerId, plan.company, {
        confirm: true,
      });
      if ("executed" in written) {
        throw new ContactSyncBlockedError(
          "The Odoo write was not executed. Writes require ODOO_MODE=live and ODOO_ALLOW_WRITES=yes.",
        );
      }
      companyPartnerId = written.id;
      companyOutcome = "UPDATED";
    }
  } else {
    // First sync. The identity decision happens once, here, and its result is
    // recorded so it never has to be made again.
    const decision = await resolvePartner({
      name: plan.company.name,
      email: plan.company.email ?? "",
      vat: plan.company.vat ?? undefined,
    });

    if (decision.action === "REVIEW") {
      // `permanent`: a person has to look at this. Retrying would re-ask the
      // same question of the same data.
      throw new ContactSyncBlockedError(
        `Odoo contact match needs a person: ${decision.reason}`,
      );
    }

    if (decision.action === "REUSE" && decision.partnerId !== null) {
      await updatePartner(decision.partnerId, plan.company, { confirm: true });
      companyPartnerId = decision.partnerId;
      companyOutcome = "UPDATED";
    } else {
      const created = await createPartner(plan.company, { confirm: true });
      if ("executed" in created) {
        throw new ContactSyncBlockedError(
          "The Odoo write was not executed. Writes require ODOO_MODE=live and ODOO_ALLOW_WRITES=yes.",
        );
      }
      companyPartnerId = created.id;
      companyOutcome = "CREATED";
    }
  }

  await recordMapping({
    sellerId,
    role: "COMPANY",
    odooPartnerId: companyPartnerId,
    name: plan.company.name,
    fingerprint: companyFingerprint,
    facts,
    tagId: resolved.contactTagId,
  });

  /* --------------------------- individual -------------------------- */
  let contactPartnerId: number | null = null;
  if (plan.contact) {
    const withParent: PartnerValues = { ...plan.contact, parent_id: companyPartnerId };
    contactPartnerId = await writeChild({
      sellerId,
      role: "CONTACT",
      values: withParent,
      existing: byRole.get("CONTACT"),
      facts,
      tagId: resolved.contactTagId,
    });
  }

  /* ----------------------------- urgent ---------------------------- */
  let urgentPartnerId: number | null = null;
  if (plan.urgent) {
    const withParent: PartnerValues = { ...plan.urgent, parent_id: companyPartnerId };
    urgentPartnerId = await writeChild({
      sellerId,
      role: "URGENT_CONTACT",
      values: withParent,
      existing: byRole.get("URGENT_CONTACT"),
      facts,
      tagId: resolved.contactTagId,
    });
  } else {
    // Nothing to sync is a real answer, distinct from a failure: the mapping is
    // marked NOT_REQUIRED so no screen shows it as pending work.
    await prisma.externalContactMapping.upsert({
      where: { sellerId_role: { sellerId, role: "URGENT_CONTACT" } },
      create: {
        sellerId,
        role: "URGENT_CONTACT",
        status: "NOT_REQUIRED",
        lastError: null,
        storeName: facts.storeName,
        shopifyShopId: facts.shopifyShopId,
        myshopifyDomain: facts.myshopifyDomain,
      },
      update: { status: "NOT_REQUIRED", lastError: null, odooPartnerId: null, odooName: null },
    });
  }

  await recordAudit({
    actorType: "SYSTEM",
    actorId: "odoo-contact-sync",
    actorName: "Odoo contact sync",
    action: "odoo.contacts_synced",
    entityType: AUDIT_ENTITY.SELLER,
    entityId: sellerId,
    afterData: {
      companyPartnerId,
      companyOutcome,
      contactPartnerId,
      urgentPartnerId,
      tagId: resolved.contactTagId,
      unresolved: plan.unresolved,
      fieldMap: COMPANY_FIELD_MAP,
    },
  });

  return {
    companyPartnerId,
    companyOutcome,
    contactPartnerId,
    urgentPartnerId,
    unresolved: plan.unresolved,
    tagId: resolved.contactTagId,
  };
}

/**
 * Write one child contact, creating it the first time and updating the mapped
 * record afterwards.
 *
 * The child carries `parent_id` = the company, which is the whole difference
 * between a contact of the company and a second company.
 */
async function writeChild(input: {
  sellerId: string;
  role: ContactRole;
  values: PartnerValues;
  existing: { odooPartnerId: number | null; payloadFingerprint: string | null } | undefined;
  facts: ContactSyncFacts;
  tagId: number | null;
}): Promise<number> {
  const fingerprint = payloadFingerprint(input.values);

  if (input.existing?.odooPartnerId) {
    const current = await readPartner(input.existing.odooPartnerId);
    if (!current) {
      throw new ContactSyncBlockedError(
        `The mapped Odoo contact ${input.existing.odooPartnerId} for role ${input.role} no longer exists.`,
      );
    }
    if (input.existing.payloadFingerprint !== fingerprint) {
      await updatePartner(input.existing.odooPartnerId, input.values, { confirm: true });
    }
    await recordMapping({
      sellerId: input.sellerId,
      role: input.role,
      odooPartnerId: input.existing.odooPartnerId,
      name: input.values.name,
      fingerprint,
      facts: input.facts,
      tagId: input.tagId,
    });
    return input.existing.odooPartnerId;
  }

  const created = await createPartner(input.values, { confirm: true });
  if ("executed" in created) {
    throw new ContactSyncBlockedError(
      "The Odoo write was not executed. Writes require ODOO_MODE=live and ODOO_ALLOW_WRITES=yes.",
    );
  }
  await recordMapping({
    sellerId: input.sellerId,
    role: input.role,
    odooPartnerId: created.id,
    name: input.values.name,
    fingerprint,
    facts: input.facts,
    tagId: input.tagId,
  });
  return created.id;
}

async function recordMapping(input: {
  sellerId: string;
  role: ContactRole;
  odooPartnerId: number;
  name: string;
  fingerprint: string | null;
  facts: ContactSyncFacts;
  tagId: number | null;
}) {
  // The two branches differ in exactly one field, and they must: a create
  // states an attempt count, an update increments one. Sharing a single `data`
  // object between them is how an `{ increment: 1 }` ends up as a literal
  // attempt count.
  const shared = {
    odooPartnerId: input.odooPartnerId,
    odooName: input.name,
    status: "SYNCED" as const,
    lastError: null,
    lastAttemptAt: new Date(),
    syncedAt: new Date(),
    payloadFingerprint: input.fingerprint,
    storeName: input.facts.storeName,
    shopifyShopId: input.facts.shopifyShopId,
    myshopifyDomain: input.facts.myshopifyDomain,
    odooTagId: input.tagId,
  };

  await prisma.externalContactMapping.upsert({
    where: { sellerId_role: { sellerId: input.sellerId, role: input.role } },
    create: { sellerId: input.sellerId, role: input.role, attempts: 1, ...shared },
    update: { ...shared, attempts: { increment: 1 } },
  });
}

/** Record a failed attempt, so a retry has a history and the owner can see it. */
export async function markContactSyncFailed(
  sellerId: string,
  role: ContactRole,
  message: string,
) {
  await prisma.externalContactMapping.upsert({
    where: { sellerId_role: { sellerId, role } },
    create: {
      sellerId,
      role,
      status: "FAILED",
      attempts: 1,
      lastError: message,
      lastAttemptAt: new Date(),
    },
    update: {
      status: "FAILED",
      attempts: { increment: 1 },
      lastError: message,
      lastAttemptAt: new Date(),
    },
  });
}

/**
 * The job handler. Registered under `ODOO_CONTACT_SYNC`.
 *
 * The mapping rows are marked FAILED here rather than inside the sync, because
 * the sync does not know which role failed when the company write is what threw
 * — and the company is the one that matters most, so it is the one that is
 * marked.
 */
export async function runContactSyncJob(sellerId: string): Promise<ContactSyncResult> {
  try {
    const result = await syncSellerContacts(sellerId, { confirm: true });
    if ("preview" in result) {
      throw new Error("The contact sync returned a preview in confirm mode.");
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markContactSyncFailed(sellerId, "COMPANY", message);
    throw error;
  }
}

/**
 * Whether a financial action may proceed for this seller.
 *
 * The directive puts financial actions that depend on an Odoo customer mapping
 * on hold until that mapping exists. Returning a reason rather than a boolean
 * is what lets the refusal say which of the three situations it is — never
 * attempted, attempted and failed, or attempted and waiting on Odoo — instead
 * of a bare "not available".
 */
export async function financialActionHold(sellerId: string): Promise<string | null> {
  const company = await prisma.externalContactMapping.findUnique({
    where: { sellerId_role: { sellerId, role: "COMPANY" } },
  });

  if (!company) {
    return (
      "This seller has no Odoo customer record yet. The contact sync runs when an " +
      "application is approved; it has not run for this seller."
    );
  }
  if (company.status === "SYNCED" && company.odooPartnerId) {
    return null;
  }
  if (company.status === "FAILED") {
    return (
      `The Odoo customer record could not be created: ${company.lastError ?? "no reason recorded"}. ` +
      `Financial actions are held until the customer mapping exists.`
    );
  }
  return (
    "The Odoo customer record is still being created, so financial actions are held. " +
    "This will clear on its own if Odoo can be reached."
  );
}

/**
 * Is the connector reachable right now? Used by the owner's screens to explain
 * a PENDING mapping rather than leaving it looking stuck.
 */
export async function odooReachable(): Promise<{ ok: boolean; reason: string | null }> {
  try {
    await findContactTagByName();
    return { ok: true, reason: null };
  } catch (error) {
    if (error instanceof OdooError) {
      return { ok: false, reason: error.message };
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

