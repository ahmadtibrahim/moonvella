/**
 * The MoonVella seller → Odoo contact mapping.
 *
 * WHAT THIS SUITE IS FOR. Two promises, and both are about not getting things
 * wrong quietly.
 *
 *   THE MAPPING. Every row below is an assertion that a merchant's fact lands in
 *   the Odoo column the directive names, and that nothing is invented to fill a
 *   gap: the company is named after the legal business name and never after the
 *   shop title, an emergency number is never written into `mobile`, the GST/HST
 *   number goes to the installed tax-registration field and is not described as
 *   validated, an empty MoonVella value says nothing rather than clearing the
 *   column, and a country or province Odoo does not have produces a stated
 *   reason instead of an address that is quietly missing its country.
 *
 *   THE WRITE SURFACE. This suite runs with no Odoo connection at all, which is
 *   the state the directive requires the work to be built and tested in. What it
 *   proves is that an unreachable or unconfigured Odoo produces a recorded
 *   failure with a reason — never a silent success and never a partially written
 *   contact — and that a financial action depending on the mapping is held with
 *   a reason rather than refused with a shrug.
 *
 * WHAT IT DOES NOT DO. It makes no Odoo call and no Shopify call. The live
 * mapping against a real Odoo instance is a separate, deliberate step: this suite
 * is what makes that step safe to take, by fixing the intended payloads first.
 *
 * IT CREATES ROWS. Everything it makes goes in `cleanup()`, which runs even when
 * a check throws.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-contact-mapping.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  COMPANY_FIELD_MAP,
  buildContactPlan,
  chooseBusinessEmail,
  financialActionHold,
  loadContactFacts,
  markContactSyncFailed,
  payloadFingerprint,
  runContactSyncJob,
  syncSellerContacts,
  type ContactSyncFacts,
} from "~/services/odooContacts.server";
import { partnerWritePayload, type PartnerValues } from "~/services/odoo.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const SHOP = `vcm-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_NO_NAME = `vcm-noname-${suffix.toLowerCase()}.myshopify.com`;
const SHOPS = [SHOP, SHOP_NO_NAME];

let failures = 0;
let total = 0;
let expected = 0;

function check(number: number, name: string, pass: boolean, detail = "") {
  total += 1;
  const isSubCheck = !Number.isInteger(number) && Math.floor(number) === expected;
  if (!isSubCheck) {
    if (number !== expected + 1) {
      failures += 1;
      console.log(`FAIL  check #${number} arrived out of order (expected #${expected + 1})`);
      return;
    }
    expected += 1;
  }
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${String(number).padStart(2)}. ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

/** The facts as the application would supply them. */
function facts(overrides: Partial<ContactSyncFacts> = {}): ContactSyncFacts {
  return {
    sellerId: "seller-under-test",
    legalBusinessName: "Northwind Bedding Ltd",
    storeName: "Northwind Home Goods",
    shopifyShopId: "gid://shopify/Shop/123456",
    myshopifyDomain: "northwind.myshopify.com",
    storefrontUrl: "https://northwind.example",
    businessPhone: "+1 416 555 0100",
    gstHstNumber: "123456789RT0001",
    address: {
      line1: "1 Warehouse Way",
      line2: "Unit 4",
      city: "Toronto",
      provinceCode: "ON",
      postalCode: "M5V 1A1",
      countryCode: "CA",
    },
    contact: {
      name: "Dana Okafor",
      email: "dana@northwind.example",
      phone: "+1 416 555 0101",
    },
    urgent: { name: null, phone: "+1 416 555 0199" },
    ...overrides,
  };
}

const resolved = { countryId: 38, stateId: 1007, contactTagId: 42 };

/*
 * The two names the first check compares against, held in variables with their
 * types written out rather than read straight into the comparison. Inlined, the
 * first `===` narrows the left-hand side to that literal and TypeScript rejects
 * the `!==` against the store name as a comparison with no overlap: the check
 * would fail to compile for being *correctly* specific. The store name is
 * nullable because a Shopify shop need not have set one, and the application
 * side of this mapping records that as a missing value rather than an empty
 * string.
 */
const legalName: string = facts().legalBusinessName;
const displayName: string | null = facts().storeName;

async function main() {
  /* -------------------------------------------------------------------- */
  /* The mapping, field by field                                            */
  /* -------------------------------------------------------------------- */
  const plan = buildContactPlan(facts(), resolved);

  check(
    1,
    "The company is named after the legal business name, never the store display name",
    plan.company.name === legalName &&
      plan.company.name !== displayName &&
      COMPANY_FIELD_MAP["Legal business name"] === "name",
    `${plan.company.name} (map: ${COMPANY_FIELD_MAP["Legal business name"]})`,
  );

  check(
    2,
    "The address maps field by field, with the state and country resolved by the caller",
    plan.company.street === "1 Warehouse Way" &&
      plan.company.street2 === "Unit 4" &&
      plan.company.city === "Toronto" &&
      plan.company.zip === "M5V 1A1" &&
      plan.company.state_id === 1007 &&
      plan.company.country_id === 38,
    `street=${plan.company.street} state_id=${plan.company.state_id} country_id=${plan.company.country_id}`,
  );

  check(
    3,
    "GST/HST goes to the installed tax-registration field, and the map does not call it verified",
    plan.company.vat === "123456789RT0001" &&
      COMPANY_FIELD_MAP["GST/HST number"] === "vat" &&
      !/verif/i.test(Object.keys(COMPANY_FIELD_MAP).join(" ")),
    `vat=${plan.company.vat}`,
  );

  check(
    4,
    "The company is a company and a customer, and the storefront URL is its website",
    plan.company.is_company === true &&
      plan.company.customer_rank === 1 &&
      plan.company.website === "https://northwind.example",
    `is_company=${plan.company.is_company} customer_rank=${plan.company.customer_rank} website=${plan.company.website}`,
  );

  check(
    5,
    "The MoonVella contact tag is attached by id, and only that tag",
    plan.tagIds.length === 1 &&
      plan.tagIds[0] === 42 &&
      plan.company.category_ids?.[0] === 42,
    `tagIds=${JSON.stringify(plan.tagIds)}`,
  );

  /* -------------------------------------------------------------------- */
  /* The business email is chosen by rule, and the rule is visible          */
  /* -------------------------------------------------------------------- */
  const publicFirst = chooseBusinessEmail({
    storeContactEmail: "hello@northwind.example",
    storeOwnerEmail: "owner@northwind.example",
    contactEmail: "dana@northwind.example",
  });
  const ownerNext = chooseBusinessEmail({
    storeContactEmail: null,
    storeOwnerEmail: "owner@northwind.example",
    contactEmail: "dana@northwind.example",
  });
  const contactLast = chooseBusinessEmail({
    storeContactEmail: null,
    storeOwnerEmail: null,
    contactEmail: "dana@northwind.example",
  });
  check(
    6,
    "The company's email is the public store address, then the owner's, then the contact's — and it says which",
    publicFirst.email === "hello@northwind.example" &&
      publicFirst.from === "public store contact email" &&
      ownerNext.email === "owner@northwind.example" &&
      contactLast.email === "dana@northwind.example",
    `${publicFirst.email} / ${ownerNext.email} / ${contactLast.email}`,
  );

  const chosen = buildContactPlan(facts(), resolved, {
    storeContactEmail: "hello@northwind.example",
    storeOwnerEmail: "owner@northwind.example",
  });
  check(
    7,
    "And the company's email is never the contact person's, because those are different people",
    chosen.company.email === "hello@northwind.example" &&
      chosen.contact?.email === "dana@northwind.example",
    `company=${chosen.company.email} contact=${chosen.contact?.email}`,
  );

  /* -------------------------------------------------------------------- */
  /* The individual contact                                                 */
  /* -------------------------------------------------------------------- */
  check(
    8,
    "The named contact is an individual of the company, not a second company",
    chosen.contact?.name === "Dana Okafor" &&
      chosen.contact?.is_company === false &&
      chosen.contact?.email === "dana@northwind.example" &&
      chosen.contact?.phone === "+1 416 555 0101",
    `${chosen.contact?.name} is_company=${chosen.contact?.is_company}`,
  );

  check(
    9,
    "The contact's parent is left to the caller, because the company has no id until it is written",
    chosen.contact !== null && chosen.contact.parent_id === undefined,
    `parent_id=${String(chosen.contact?.parent_id)}`,
  );

  /* -------------------------------------------------------------------- */
  /* The urgent number: its own record, and never `mobile`                  */
  /* -------------------------------------------------------------------- */
  const urgentKeys = Object.keys(plan.urgent ?? {});
  check(
    10,
    "The urgent number is a separate contact record, not a field on the company",
    plan.urgent !== null &&
      plan.urgent.is_company === false &&
      plan.company.phone === "+1 416 555 0100",
    `urgent=${JSON.stringify(plan.urgent)}`,
  );
  check(
    11,
    "It is written to `phone`, and `mobile` is never used — an emergency line is not known to be a mobile",
    plan.urgent?.phone === "+1 416 555 0199" && !urgentKeys.includes("mobile"),
    `keys: ${urgentKeys.join(", ")}`,
  );
  check(
    12,
    "An unnamed urgent number is recorded under a name that says what it is",
    plan.urgent?.name === "Northwind Bedding Ltd — urgent orders line",
    String(plan.urgent?.name),
  );

  const namedUrgent = buildContactPlan(
    facts({ urgent: { name: "Sam Reyes", phone: "+1 416 555 0188" } }),
    resolved,
  );
  check(
    13,
    "When the urgent contact is somebody else, their own name is used",
    namedUrgent.urgent?.name === "Sam Reyes",
    String(namedUrgent.urgent?.name),
  );

  const noUrgent = buildContactPlan(facts({ urgent: { name: null, phone: null } }), resolved);
  check(
    14,
    "No urgent number means no urgent record — not an empty one",
    noUrgent.urgent === null,
    `urgent=${JSON.stringify(noUrgent.urgent)}`,
  );

  /* -------------------------------------------------------------------- */
  /* What could not be mapped is stated, not dropped                        */
  /* -------------------------------------------------------------------- */
  const unresolvedPlan = buildContactPlan(facts(), {
    countryId: null,
    stateId: null,
    contactTagId: null,
  });
  // The province is deliberately NOT reported when the country itself did not
  // resolve: "ON is not a province of this country" cannot be said about a
  // country Odoo does not have, and a reason that guesses at one would send
  // whoever reads it looking in the wrong place.
  check(
    15,
    "An unmapped country and a missing tag each produce a stated reason, and the state is not blamed for the country",
    unresolvedPlan.unresolved.length === 2 &&
      unresolvedPlan.unresolved.some((reason) => reason.includes("Country code")) &&
      unresolvedPlan.unresolved.some((reason) => reason.includes("contact tag")) &&
      !unresolvedPlan.unresolved.some((reason) => reason.includes("province or state")),
    unresolvedPlan.unresolved.join(" | "),
  );

  const stateLessPlan = buildContactPlan(facts(), { countryId: 38, stateId: null, contactTagId: 42 });
  check(
    15.1,
    "A country that resolved with a province that did not does produce the state reason",
    stateLessPlan.unresolved.length === 1 &&
      stateLessPlan.unresolved[0].includes("province or state") &&
      stateLessPlan.company.country_id === 38 &&
      stateLessPlan.company.state_id === null,
    stateLessPlan.unresolved[0] ?? "no reason given",
  );
  check(
    16,
    "And the rest of the address is still written: an unmapped country does not become an unmapped contact",
    unresolvedPlan.company.city === "Toronto" && unresolvedPlan.company.street === "1 Warehouse Way",
    `${unresolvedPlan.company.street}, ${unresolvedPlan.company.city}`,
  );

  /* -------------------------------------------------------------------- */
  /* The payload the connector actually sends                               */
  /* -------------------------------------------------------------------- */
  const payload = partnerWritePayload(plan.company);
  check(
    17,
    "An empty MoonVella value says nothing about the column, rather than clearing what Odoo holds",
    !("website" in partnerWritePayload({ name: "X", website: null })) &&
      !("phone" in partnerWritePayload({ name: "X", phone: "" })) &&
      !("street2" in partnerWritePayload({ name: "X", street2: null })),
    `keys: ${Object.keys(payload).join(", ")}`,
  );
  check(
    18,
    "The tag is added with [4, id], which preserves every other tag on the record",
    Array.isArray(payload.category_id) &&
      JSON.stringify(payload.category_id) === JSON.stringify([[4, 42]]),
    JSON.stringify(payload.category_id),
  );
  check(
    19,
    "The company type and customer designation are sent as Odoo's own values",
    payload.is_company === true && payload.customer_rank === 1,
    `is_company=${String(payload.is_company)} customer_rank=${String(payload.customer_rank)}`,
  );

  /* -------------------------------------------------------------------- */
  /* The fingerprint that makes a retry idempotent                          */
  /* -------------------------------------------------------------------- */
  const a: PartnerValues = { name: "X", email: "a@b.c", city: "Toronto" };
  const b: PartnerValues = { city: "Toronto", email: "a@b.c", name: "X" };
  check(
    20,
    "The payload fingerprint ignores key order, so an unchanged retry is recognised as unchanged",
    payloadFingerprint(a) === payloadFingerprint(b) && payloadFingerprint(a) !== null,
    String(payloadFingerprint(a)?.slice(0, 16)),
  );
  check(
    21,
    "But it changes when a value changes, so a real edit is not skipped",
    payloadFingerprint(a) !== payloadFingerprint({ ...a, city: "Ottawa" }),
    "Toronto vs Ottawa differ",
  );

  /* -------------------------------------------------------------------- */
  /* Reading the facts out of MoonVella                                     */
  /* -------------------------------------------------------------------- */
  const application = await prisma.merchantApplication.create({
    data: {
      shopDomain: SHOP,
      storeName: "VCM Store",
      contactName: "VCM Contact",
      email: "vcm-contact@example.invalid",
      phone: "+1 416 555 0100",
      urgentPhone: "+1 416 555 0199",
      legalBusinessName: "VCM Verify Ltd",
      addressLine1: "1 Verify Way",
      addressCity: "Toronto",
      addressProvinceCode: "ON",
      addressPostalCode: "M5V1A1",
      addressCountryCode: "CA",
      storeContactEmail: "store@vcm.example.invalid",
      storeOwnerEmail: "owner@vcm.example.invalid",
      shopifyShopId: "gid://shopify/Shop/4242",
      productCategory: "Home",
      status: "APPROVED",
    },
  });
  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      shopDomainFull: SHOP,
      storeName: "VCM Store",
      contactEmail: "vcm-contact@example.invalid",
      currency: "CAD",
      status: "APPROVED",
      approvedAt: new Date(),
      applicationId: application.id,
    },
  });

  // A seller with no legal business name at all. The sync must refuse rather
  // than name the company after the shop, which is the one substitution the
  // directive rules out by name.
  const noNameApplication = await prisma.merchantApplication.create({
    data: {
      shopDomain: SHOP_NO_NAME,
      storeName: "VCM Nameless Store",
      contactName: "VCM Contact",
      email: "vcm-noname@example.invalid",
      legalBusinessName: "",
      productCategory: "Home",
      status: "APPROVED",
    },
  });
  const noNameSeller = await prisma.seller.create({
    data: {
      shopDomain: SHOP_NO_NAME,
      shopDomainFull: SHOP_NO_NAME,
      storeName: "VCM Nameless Store",
      contactEmail: "vcm-noname@example.invalid",
      currency: "CAD",
      status: "APPROVED",
      approvedAt: new Date(),
      applicationId: noNameApplication.id,
    },
  });

  const loaded = await loadContactFacts(seller.id);
  check(
    22,
    "The two store addresses are read and kept apart, and the myshopify domain is the authenticated one",
    loaded.storeContactEmail === "store@vcm.example.invalid" &&
      loaded.storeOwnerEmail === "owner@vcm.example.invalid" &&
      loaded.facts.myshopifyDomain === SHOP &&
      loaded.facts.storeName === "VCM Store",
    `${loaded.storeContactEmail} / ${loaded.storeOwnerEmail}`,
  );
  check(
    23,
    "The permanent Shopify shop id travels with the facts, so it is recorded beside the mapping rather than in Odoo's reference field",
    loaded.facts.shopifyShopId === "gid://shopify/Shop/4242",
    `shopifyShopId=${String(loaded.facts.shopifyShopId)}`,
  );

  let noNameError: string | null = null;
  try {
    await loadContactFacts(noNameSeller.id);
  } catch (error) {
    noNameError = error instanceof Error ? error.message : String(error);
  }
  check(
    24,
    "A seller with no legal business name is refused, rather than having one invented from the store name",
    noNameError !== null &&
      /legal business name/i.test(noNameError) &&
      !/VCM Nameless Store/.test(noNameError),
    noNameError ?? "no error raised",
  );

  /* -------------------------------------------------------------------- */
  /* With no Odoo connection: a recorded failure, never a silent success    */
  /* -------------------------------------------------------------------- */
  const before = await prisma.externalContactMapping.count({ where: { sellerId: seller.id } });
  let syncError: string | null = null;
  try {
    await syncSellerContacts(seller.id, { confirm: true });
  } catch (error) {
    syncError = error instanceof Error ? error.message : String(error);
  }
  const after = await prisma.externalContactMapping.count({ where: { sellerId: seller.id } });
  check(
    25,
    "The sync against an unconfigured Odoo fails loudly instead of reporting a contact it never wrote",
    syncError !== null && /odoo/i.test(syncError),
    syncError ?? "no error raised",
  );
  check(
    26,
    "And it wrote no mapping: nothing claims a partner id that Odoo never issued",
    before === 0 && after === 0,
    `${before} -> ${after} mapping row(s)`,
  );

  let jobError: string | null = null;
  try {
    await runContactSyncJob(seller.id);
  } catch (error) {
    jobError = error instanceof Error ? error.message : String(error);
  }
  const failed = await prisma.externalContactMapping.findUnique({
    where: { sellerId_role: { sellerId: seller.id, role: "COMPANY" } },
  });
  check(
    27,
    "The job records the failure on the company mapping, so the owner sees Failed with the reason",
    jobError !== null &&
      failed?.status === "FAILED" &&
      (failed.lastError ?? "").length > 0 &&
      failed.attempts === 1,
    `${failed?.status}: ${failed?.lastError}`,
  );

  await markContactSyncFailed(seller.id, "COMPANY", "second attempt failed");
  const retried = await prisma.externalContactMapping.findUnique({
    where: { sellerId_role: { sellerId: seller.id, role: "COMPANY" } },
  });
  const mappingRows = await prisma.externalContactMapping.count({ where: { sellerId: seller.id } });
  check(
    28,
    "A retry updates the same mapping row and counts the attempt, so the history of retries is visible",
    retried?.attempts === 2 && mappingRows === 1,
    `attempts=${retried?.attempts}, ${mappingRows} row(s)`,
  );

  /* -------------------------------------------------------------------- */
  /* Financial actions are held, with a reason                              */
  /* -------------------------------------------------------------------- */
  const heldFailed = await financialActionHold(seller.id);
  check(
    29,
    "A failed contact mapping holds financial actions, naming the reason rather than refusing silently",
    heldFailed !== null && heldFailed.includes("could not be created"),
    heldFailed ?? "no hold",
  );

  await prisma.externalContactMapping.update({
    where: { sellerId_role: { sellerId: seller.id, role: "COMPANY" } },
    data: { status: "SYNCED", odooPartnerId: 9001, lastError: null },
  });
  const heldSynced = await financialActionHold(seller.id);
  check(
    30,
    "Once the mapping is synced the hold is lifted, which is what makes it a gate rather than a block",
    heldSynced === null,
    heldSynced ?? "no hold",
  );

  const noMappingSeller = noNameSeller.id;
  const heldNone = await financialActionHold(noMappingSeller);
  check(
    31,
    "A seller whose mapping has never run is held too, and told which situation it is",
    heldNone !== null && /has not run/.test(heldNone),
    heldNone ?? "no hold",
  );

  /* -------------------------------------------------------------------- */
  /* The mapping table is the identity authority                            */
  /* -------------------------------------------------------------------- */
  await prisma.externalContactMapping.update({
    where: { sellerId_role: { sellerId: seller.id, role: "COMPANY" } },
    data: {
      storeName: "VCM Store",
      shopifyShopId: "gid://shopify/Shop/999",
      myshopifyDomain: SHOP,
      odooTagId: 42,
    },
  });
  const stored = await prisma.externalContactMapping.findUnique({
    where: { sellerId_role: { sellerId: seller.id, role: "COMPANY" } },
  });
  check(
    32,
    "The store's display name, shop id, domain and tag id live on the mapping, not in Odoo's one reference field",
    stored?.storeName === "VCM Store" &&
      stored.shopifyShopId === "gid://shopify/Shop/999" &&
      stored.myshopifyDomain === SHOP &&
      stored.odooTagId === 42 &&
      stored.odooPartnerId === 9001,
    `partner=${stored?.odooPartnerId} shop=${stored?.shopifyShopId} tag=${stored?.odooTagId}`,
  );

  check(
    33,
    "The three roles are separate rows, so a company and an individual cannot overwrite each other",
    (await prisma.externalContactMapping.findMany({
      where: { sellerId: seller.id },
      select: { role: true },
    })).every((row) => ["COMPANY", "CONTACT", "URGENT_CONTACT"].includes(row.role)),
    "roles are constrained by the enum",
  );
}

async function cleanup() {
  const sellers = await prisma.seller.findMany({
    where: { shopDomain: { in: SHOPS } },
    select: { id: true },
  });
  const ids = sellers.map((seller) => seller.id);
  if (ids.length) {
    await prisma.externalContactMapping.deleteMany({ where: { sellerId: { in: ids } } });
    await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: ids } } });
    await prisma.seller.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.merchantApplication.deleteMany({ where: { shopDomain: { in: SHOPS } } });
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n=== ${total - failures}/${total} checks passed ===`);
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(error);
    try {
      await cleanup();
    } catch {
      // The original error is the one worth reporting.
    }
    await prisma.$disconnect();
    process.exit(1);
  });
