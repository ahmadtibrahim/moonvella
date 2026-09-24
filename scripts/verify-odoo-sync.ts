/**
 * The scheduled Odoo catalogue sync, and the default pickup location.
 *
 * WHAT THIS SUITE IS FOR. The sync has three parts that are not "read the tag
 * and write a draft", and each of them fails quietly if it is wrong:
 *
 *   • THE SCHEDULE. A recurring job declared twice, or declared with the wrong
 *     bucket key, runs twice an hour or never again. The queue's own rules —
 *     one row per bucket, no retry inside a bucket — are checked here by running
 *     `ensureRecurringJobs` against the isolated database rather than by reading
 *     it.
 *   • WITHDRAWAL. A product whose Odoo template loses the tag must stop being
 *     offered WITHOUT disappearing: an archived row that historical orders still
 *     reference, with its inventory left at the last figure read. This is
 *     checked by running the withdrawal over rows this suite creates, because
 *     the alternative — a grep for "isArchived: true" — would pass just as
 *     happily if the function deleted the product afterwards.
 *   • THE DEFAULT PICKUP LOCATION. The owner named one warehouse as where every
 *     outbound shipment starts. The resolution order is checked by calling it:
 *     the variant wins, then the product, then the designated default, and a
 *     default that has been switched off is refused by name rather than used.
 *
 * The parts that need a live Odoo — reading the tag, reading the warehouse's
 * partner address — are checked by reading the code, and the figures themselves
 * are verified against production separately and read-only.
 *
 * IT CREATES ROWS. Everything it makes is prefixed, and `cleanup()` runs even
 * when a check throws.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-odoo-sync.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { JOB_KIND, RECURRING_JOBS, ensureRecurringJobs } from "~/services/jobs.server";
import { jobHandlers } from "~/services/jobHandlers.server";
import { withdrawUntaggedProducts } from "~/services/odooSync.server";
import { resolveOriginForVariant, resolveOriginForProduct } from "~/services/origins.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const CODE = `VOS-${suffix}`;
const ODOO_DB = `verify-sync-${suffix.toLowerCase()}`;
const TEMPLATE_PRESENT = 7001;
const TEMPLATE_WITHDRAWN = 7002;

const sourceOf = (name: string) => join(process.cwd(), "app", "services", name);
const SYNC_SOURCE = readFileSync(sourceOf("odooSync.server.ts"), "utf8");
const clean = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A pickup location carrying every field the booking gate demands. */
async function makeLocation(overrides: Record<string, unknown> = {}) {
  return prisma.pickupLocation.create({
    data: {
      code: `${CODE}-LOC-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      name: "VOS Test Dock",
      isActive: true,
      odooCompanyId: 1,
      odooWarehouseId: 1,
      odooLocationId: 8,
      odooPartnerId: 1,
      contactName: "PremaFirm Inc.",
      contactPhone: "+1 905 000 0000",
      contactEmail: "dock@example.invalid",
      street1: "994 Westport Cres",
      // The unit, as its own component: the point of the column, and the thing a
      // carrier routes on.
      street2: "Unit 7A",
      city: "Mississauga",
      province: "ON",
      postalCode: "L5T 1G1",
      country: "CA",
      timeZone: "America/Toronto",
      pickupOpenTime: "08:00",
      pickupCloseTime: "16:00",
      pickupMode: "NEEDED",
      ...overrides,
    },
  });
}

async function makeProduct(withMapping: number | null) {
  const product = await prisma.product.create({
    data: {
      name: "VOS Withdrawal Test",
      productCode: `${CODE}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      category: "Home",
      currency: "CAD",
      status: "PUBLISHED",
      isActive: true,
      isPublished: true,
      variants: {
        create: [
          {
            name: "One size",
            sku: `${CODE}-SKU-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
            wholesalePrice: 3999,
            suggestedRetailPrice: 5999,
            // The last figure read from Odoo. A withdrawal must not become a
            // stock count, so this is what has to still be here afterwards.
            inventory: 25,
            reserved: 3,
            isDefault: true,
          },
        ],
      },
    },
    include: { variants: true },
  });

  if (withMapping !== null) {
    await prisma.externalProductMapping.create({
      data: {
        productId: product.id,
        provider: "ODOO",
        shopDomain: ODOO_DB,
        externalProductId: String(withMapping),
        importStatus: "IMPORTED",
        lastSyncedAt: new Date(),
      },
    });
  }
  return product;
}

async function main() {
  /* -------------------------------------------------------------------- */
  console.log("A. The schedule");
  /* -------------------------------------------------------------------- */

  const recurring = RECURRING_JOBS.find((job) => job.kind === JOB_KIND.ODOO_CATALOG_SYNC);
  check(
    "The catalogue sync is a declared recurring job, six-hourly",
    recurring?.everyMs === 6 * 60 * 60 * 1000 && /Odoo catalogue/.test(recurring?.summary ?? ""),
    `every ${(recurring?.everyMs ?? 0) / 3600000}h — ${recurring?.summary ?? "not declared"}`
  );
  check(
    "And it is the only declaration of its kind, so it cannot run twice a tick",
    RECURRING_JOBS.filter((job) => job.kind === JOB_KIND.ODOO_CATALOG_SYNC).length === 1,
    `${RECURRING_JOBS.length} recurring job(s) declared`
  );
  check(
    "A handler is registered for it, and it is the same work the manual control runs",
    typeof jobHandlers[JOB_KIND.ODOO_CATALOG_SYNC] === "function" &&
      /\[JOB_KIND\.ODOO_CATALOG_SYNC\]: async \(\) => \{[\s\S]{0,120}syncOdooCatalog\(\)/.test(
        clean(readFileSync(sourceOf("jobHandlers.server.ts"), "utf8"))
      ) &&
      /const outcome = await syncOdooCatalog\(\)/.test(clean(SYNC_SOURCE)),
    "one implementation behind both controls"
  );

  /*
   * THE PRECONDITION IS "NO ROW FOR THIS BUCKET YET", AND IT IS STATED HERE.
   * The bucket is wall-clock, so a crashed run — or a second run of this suite
   * inside the same six hours — leaves behind the very row that says "already
   * queued". Clearing it is this suite resuming its own precondition, not the
   * assertion being weakened: the checks below still require that the first
   * tick creates the row, that it carries the bucket as its key, and that it
   * does not retry within the bucket.
   */
  await prisma.backgroundJob.deleteMany({ where: { kind: JOB_KIND.ODOO_CATALOG_SYNC } });
  const queuedFirst = await ensureRecurringJobs();
  const queuedAgain = await ensureRecurringJobs();
  const syncJobs = await prisma.backgroundJob.findMany({
    where: { kind: JOB_KIND.ODOO_CATALOG_SYNC },
    select: { idempotencyKey: true, maxAttempts: true, status: true, payload: true },
  });
  check(
    "A tick queues this bucket's sync once, and a second tick in the same bucket queues nothing",
    queuedFirst.some((key) => key.includes(JOB_KIND.ODOO_CATALOG_SYNC)) &&
      !queuedAgain.some((key) => key.includes(JOB_KIND.ODOO_CATALOG_SYNC)),
    `${queuedFirst.length} queued first, ${queuedAgain.length} on the second call`
  );
  check(
    "Its key is the bucket, so the next tick creates a new row rather than reviving this one",
    syncJobs.length === 1 &&
      /^recurring:ODOO_CATALOG_SYNC:\d+$/.test(syncJobs[0]?.idempotencyKey ?? ""),
    syncJobs[0]?.idempotencyKey ?? "none"
  );
  check(
    "And it does not retry inside its own bucket: the next tick is the retry",
    syncJobs[0]?.maxAttempts === 1,
    `maxAttempts ${syncJobs[0]?.maxAttempts}`
  );

  /* -------------------------------------------------------------------- */
  console.log("\nB. Withdrawal: the tag goes, the record stays");
  /* -------------------------------------------------------------------- */

  const kept = await makeProduct(TEMPLATE_PRESENT);
  const gone = await makeProduct(TEMPLATE_WITHDRAWN);
  const unmanaged = await makeProduct(null);
  const before = await prisma.product.count();
  const goneSku = gone.variants[0].sku;

  const first = await withdrawUntaggedProducts(ODOO_DB, {
    templates: [{ odooTemplateId: TEMPLATE_PRESENT }],
  });

  const keptAfter = await prisma.product.findUniqueOrThrow({ where: { id: kept.id } });
  const goneAfter = await prisma.product.findUniqueOrThrow({
    where: { id: gone.id },
    include: { variants: true, externalMappings: true },
  });
  const unmanagedAfter = await prisma.product.findUniqueOrThrow({ where: { id: unmanaged.id } });
  const after = await prisma.product.count();

  check(
    "A product whose template Odoo still returns is left exactly as it was",
    keptAfter.isArchived === false &&
      keptAfter.isActive === true &&
      keptAfter.isPublished === true &&
      keptAfter.status === "PUBLISHED",
    `${keptAfter.status}, published ${keptAfter.isPublished}`
  );
  check(
    "A product whose template is gone is archived, and stops being offered",
    goneAfter.isArchived === true &&
      goneAfter.isActive === false &&
      goneAfter.isPublished === false &&
      goneAfter.status === "ARCHIVED",
    `${goneAfter.status}, active ${goneAfter.isActive}, published ${goneAfter.isPublished}`
  );
  check(
    "It is archived and NOT deleted, so the orders that reference it still resolve",
    after === before && goneAfter.variants.length === 1,
    `${before} products before, ${after} after; ${goneAfter.variants.length} variant(s) kept`
  );
  check(
    "Its inventory is left at the last figure read: a withdrawal is not a stock count",
    goneAfter.variants[0]?.inventory === 25 && goneAfter.variants[0]?.reserved === 3,
    `${goneAfter.variants[0]?.inventory} on hand, ${goneAfter.variants[0]?.reserved} reserved`
  );
  check(
    "And its price, code and SKU are untouched, so a restore is a restore",
    goneAfter.variants[0]?.wholesalePrice === 3999 &&
      goneAfter.variants[0]?.sku === goneSku &&
      goneAfter.productCode.startsWith(CODE),
    `${goneAfter.variants[0]?.wholesalePrice} / ${goneAfter.variants[0]?.sku}`
  );
  check(
    "The mapping records the withdrawal, which is what lets the sync tell it from an operator's own archive",
    goneAfter.externalMappings[0]?.importStatus === "WITHDRAWN" &&
      /no longer carries/i.test(goneAfter.externalMappings[0]?.lastSyncError ?? ""),
    `${goneAfter.externalMappings[0]?.importStatus}`
  );
  check(
    "A product the sync never imported is not touched, however absent from Odoo it is",
    unmanagedAfter.isArchived === false && unmanagedAfter.isActive === true,
    `archived ${unmanagedAfter.isArchived}`
  );
  check(
    "The run reports what it withdrew, by name, and counts it",
    first.archived === 1 &&
      first.products.length === 1 &&
      first.products[0].productId === gone.id &&
      first.products[0].name === goneAfter.name,
    JSON.stringify(first.products)
  );

  const second = await withdrawUntaggedProducts(ODOO_DB, {
    templates: [{ odooTemplateId: TEMPLATE_PRESENT }],
  });
  check(
    "Running it again is a no-op: an already-archived product is not counted or rewritten",
    second.archived === 0 && second.products.length === 0,
    `${second.archived} archived on the second run`
  );

  const audit = await prisma.auditLog.findFirst({
    where: { action: "odoo.products_withdrawn", entityId: { contains: gone.id } },
    orderBy: { createdAt: "desc" },
  });
  check(
    "And the withdrawal is audited, with the reason and the product it affected",
    audit !== null && /archived here rather than deleted/i.test(JSON.stringify(audit?.afterData)),
    audit ? "audited as odoo.products_withdrawn" : "no audit row"
  );

  /* -------------------------------------------------------------------- */
  console.log("\nC. The default pickup location, and the order it loses in");
  /* -------------------------------------------------------------------- */

  const previousDefault = await prisma.pickupLocation.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  if (previousDefault) {
    await prisma.pickupLocation.update({
      where: { id: previousDefault.id },
      data: { isDefault: false },
    });
  }

  const unmapped = await makeProduct(null);
  const variantId = unmapped.variants[0].id;

  const nothingYet = await resolveOriginForVariant(variantId);
  check(
    "With no mapping and no default designated, the answer is still 'no origin', by name",
    nothingYet.source === "missing" &&
      nothingYet.ready === false &&
      /Pickup location required/.test(nothingYet.reason ?? ""),
    `${nothingYet.source}: ${(nothingYet.reason ?? "").slice(0, 60)}`
  );

  const dock = await makeLocation({ isDefault: true });
  const viaDefault = await resolveOriginForVariant(variantId);
  check(
    "A designated default answers for an item that has no mapping of its own",
    viaDefault.source === "default" && viaDefault.ready === true && viaDefault.location?.id === dock.id,
    `${viaDefault.source}, ready ${viaDefault.ready}, ${viaDefault.location?.name}`
  );
  check(
    "The unit stays its own component on the address the booking will snapshot",
    viaDefault.location?.street2 === "Unit 7A",
    String(viaDefault.location?.street2)
  );
  check(
    "And the default answers at product level too, so a product-level read agrees with the variant's",
    (await resolveOriginForProduct(unmapped.id)).source === "default",
    (await resolveOriginForProduct(unmapped.id)).source
  );

  const mapped = await makeLocation();
  await prisma.product.update({
    where: { id: unmapped.id },
    data: { pickupLocationId: mapped.id },
  });
  const viaProduct = await resolveOriginForVariant(variantId);
  check(
    "A product's own mapping still wins: the default is the last step, not the first",
    viaProduct.source === "product" && viaProduct.location?.id === mapped.id,
    `${viaProduct.source}, ${viaProduct.location?.name}`
  );

  await prisma.productVariant.update({ where: { id: variantId }, data: { pickupLocationId: dock.id } });
  const viaVariant = await resolveOriginForVariant(variantId);
  check(
    "And a variant's own mapping wins over both",
    viaVariant.source === "variant" && viaVariant.location?.id === dock.id,
    `${viaVariant.source}, ${viaVariant.location?.name}`
  );

  await prisma.productVariant.update({ where: { id: variantId }, data: { pickupLocationId: null } });
  await prisma.product.update({ where: { id: unmapped.id }, data: { pickupLocationId: null } });
  await prisma.pickupLocation.update({ where: { id: dock.id }, data: { isActive: false } });
  const switchedOff = await resolveOriginForVariant(variantId);
  check(
    "A default that has been switched off is refused by name, not quietly used",
    switchedOff.source === "default" &&
      switchedOff.ready === false &&
      switchedOff.location === null &&
      /switched off/.test(switchedOff.reason ?? ""),
    `${switchedOff.ready} — ${(switchedOff.reason ?? "").slice(0, 70)}`
  );

  await prisma.pickupLocation.update({ where: { id: dock.id }, data: { isActive: true, postalCode: null } });
  const incomplete = await resolveOriginForVariant(variantId);
  /*
   * `missing` carries the human labels, not the column names — it is read out in
   * the admin as a sentence — so the assertion is on the label, and on there
   * being exactly one: the row is complete in every other respect, and a report
   * that also named the fields it does have would be no report at all.
   */
  check(
    "And an incomplete one is refused with the fields it still needs, like any other location",
    incomplete.ready === false &&
      incomplete.missing.length === 1 &&
      /postal code/i.test(incomplete.missing[0] ?? "") &&
      /missing/i.test(incomplete.reason ?? ""),
    `${incomplete.missing.join(", ")}`
  );

  /* -------------------------------------------------------------------- */
  console.log("\nD. What the sync reads out of Odoo, and what it never does");
  /* -------------------------------------------------------------------- */

  const code = clean(SYNC_SOURCE);
  check(
    "The warehouse's address is READ from its partner, never typed into the module",
    /*
     * The field list is checked to START with the addressing fields and to
     * include the unit as its own column; the trailing contact fields are read
     * in the same call on purpose, so the pattern must not forbid them.
     */
    /PARTNER_MODEL,[\s\S]{0,200}\["id", "name", "street", "street2", "city", "zip", "country_id", "state_id"[^\]]*\]/.test(
      code
    ) &&
      /street1: text\(partner\?\.street\)/.test(code) &&
      /street2: text\(partner\?\.street2\)/.test(code) &&
      !/994 Westport/.test(code),
    "no address literal anywhere in the module"
  );
  check(
    "The warehouse itself is a configured reference, resolved by name or numeric id like the consignment fields",
    /export const WAREHOUSE_FIELD = "ODOO_WAREHOUSE"/.test(SYNC_SOURCE) &&
      /resolveReference\(\s*WAREHOUSE_MODEL,/.test(code),
    "ODOO_WAREHOUSE through the same resolver"
  );
  check(
    "The default row is found by its Odoo identity, not by a name an operator can retype",
    /odooDatabase: database, odooWarehouseId: warehouse\.id/.test(code) ||
      /where: identity,/.test(code),
    "keyed by (database, warehouse id)"
  );
  check(
    "Two rows claiming one warehouse is refused rather than resolved by a coin toss",
    /DEFAULT_WAREHOUSE_AMBIGUOUS/.test(code) && /cannot tell which one is the default/.test(code),
    "ambiguity is reported, not guessed"
  );
  check(
    "Exactly one row is left marked default: the flag is cleared and set in one transaction",
    /await tx\.pickupLocation\.updateMany\(\{[\s\S]{0,120}isDefault: false/.test(code) &&
      /\$transaction\(async \(tx\)/.test(code),
    "clear-then-set, atomically"
  );
  check(
    "The address is validated, and the verdict recorded against the row rather than assumed",
    /validateAddress\(address, \{/.test(code) &&
      /recordValidation\(\{ subjectType: "PICKUP"/.test(code) &&
      // Not `refresh: true`: a sync is not an operator asking for a re-check, and
      // re-verifying a stored verdict on every run would spend quota to say the
      // same thing.
      /refresh: false/.test(code),
    "verdict stored on the row"
  );
  check(
    "Nothing in the sync writes to Odoo: every call is a read",
    /searchRead/.test(code) &&
      !/assertWriteAllowed|createPartner|updatePartner|createSaleOrder|registerPayment/.test(code) &&
      !/ODOO_ALLOW_WRITES/.test(code),
    "reads only"
  );
  check(
    "And it does not touch MoonVella's own operating detail on the dock it keeps in step",
    !/pickupOpenTime|pickupCloseTime|pickupMode|instructions|accessRequirements/.test(code),
    "an operator's collection window is not in the update"
  );
  check(
    "The run records the scope its stock figures came from, and whose goods they were",
    /warehouse: preview\.warehouse/.test(code) && /stockOwners/.test(code),
    "warehouse and owners in the job detail"
  );
  check(
    "There is no global consignment owner left for a new vendor to have to change",
    !/CONSIGNMENT/.test(code),
    "no ODOO_CONSIGNMENT* reference in the sync"
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await cleanup({ dockId: dock.id, mappedId: mapped.id, previousDefaultId: previousDefault?.id ?? null });
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

async function cleanup(ids: {
  dockId: string;
  mappedId: string;
  previousDefaultId: string | null;
}) {
  const products = await prisma.product.findMany({
    where: { productCode: { startsWith: CODE } },
    select: { id: true, variants: { select: { id: true } } },
  });
  const productIds = products.map((item) => item.id);
  const variantIds = products.flatMap((item) => item.variants.map((variant) => variant.id));
  if (productIds.length) {
    await prisma.externalProductMapping.deleteMany({ where: { productId: { in: productIds } } });
  }
  if (variantIds.length) {
    await prisma.externalVariantMapping.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await prisma.product.deleteMany({ where: { productCode: { startsWith: CODE } } });
  await prisma.pickupLocation.deleteMany({ where: { id: { in: [ids.dockId, ids.mappedId] } } });
  await prisma.backgroundJob.deleteMany({ where: { kind: JOB_KIND.ODOO_CATALOG_SYNC } });
  // The suite is not the owner of the default flag: whatever held it before is
  // put back, so a later suite sees the database it expected.
  if (ids.previousDefaultId) {
    await prisma.pickupLocation.update({
      where: { id: ids.previousDefaultId },
      data: { isDefault: true },
    });
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    const leftovers = await prisma.product.findMany({
      where: { productCode: { startsWith: CODE } },
      select: { id: true, variants: { select: { id: true } } },
    });
    const productIds = leftovers.map((item) => item.id);
    const variantIds = leftovers.flatMap((item) => item.variants.map((variant) => variant.id));
    if (productIds.length) {
      await prisma.externalProductMapping.deleteMany({ where: { productId: { in: productIds } } });
    }
    if (variantIds.length) {
      await prisma.externalVariantMapping.deleteMany({ where: { variantId: { in: variantIds } } });
      await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    }
    await prisma.product.deleteMany({ where: { productCode: { startsWith: CODE } } });
    await prisma.pickupLocation.deleteMany({ where: { code: { startsWith: CODE } } });
  } catch {
    // The original error is the one worth reporting.
  }
  await prisma.$disconnect();
  process.exit(1);
});
