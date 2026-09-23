/**
 * Archiving a blocked store's catalogue.
 *
 * WHAT THIS SUITE IS FOR. Archiving is the only operation in MoonVella that
 * changes a merchant's public storefront, and it is triggered by an
 * administrative action that is itself the most consequential one in the
 * product. Two things therefore have to be true, and each is checked here:
 *
 *   IT TOUCHES ONLY WHAT THIS APP PUT THERE. The scope comes from
 *   `ExternalProductMapping` rows — the durable record of "MoonVella imported
 *   this product into this shop" — and from nothing else. A product that
 *   happens to share a title, a vendor or a tag is not in scope, and the checks
 *   below put a look-alike product in a second store and a look-alike row in the
 *   same store to prove neither is swept up.
 *
 *   IT DOES NOT CLAIM WHAT IT DID NOT DO. There is no Shopify session in this
 *   environment, which is exactly the situation the directive names: Shopify
 *   access being unavailable must not be reported as success. So the run below
 *   is expected to FAIL, to record the reason on every row it could not archive,
 *   and to leave every count honest — zero archived, and the store's work still
 *   outstanding.
 *
 * WHAT IT DOES NOT DO. It makes no Shopify call and never reaches a real store.
 * The mapping rows here are fixtures with ids that belong to no Shopify shop,
 * and the sellers are invented. A real archive is verified separately, against
 * an explicitly identified test seller and test products.
 *
 * IT CREATES ROWS. Everything it makes goes in `cleanup()`, which runs even when
 * a check throws. Audit rows are not removed — AuditLog is append-only.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-archive.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  archiveCounts,
  archiveSellerProducts,
  archiveWorklist,
  markArchivePending,
  resetFailedArchives,
} from "~/services/productArchive.server";
import { blockSeller, unblockSeller } from "~/services/application.server";
import { JOB_KIND, PermanentJobError } from "~/services/jobs.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const CODE = `VCA-${suffix}`;
const SHOP_A = `vca-a-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_B = `vca-b-${suffix.toLowerCase()}.myshopify.com`;
const SHOPS = [SHOP_A, SHOP_B];

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

const actor = {
  actorId: "vca-verify",
  actorName: "Archive Verify",
  actorType: "ADMIN_USER" as const,
};

/** Was this thrown as a failure a retry cannot fix? */
function isPermanent(error: unknown): boolean {
  return error instanceof PermanentJobError || (error as { permanent?: boolean })?.permanent === true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Source with its comments removed, for the checks that read it.
 *
 * The module documents at length what it refuses to do — "nothing here calls
 * `productDelete`" — and a check that searched the raw file would match that
 * sentence and fail on the strength of a promise rather than a fact. What is
 * being asserted is a property of the code, so the code is what gets searched.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function main() {
  const admin = await prisma.adminUser.findFirst({ select: { id: true } });
  if (admin) actor.actorId = admin.id;

  const product = await prisma.product.create({
    data: {
      name: "VCA Archive Family",
      productCode: CODE,
      category: "Home",
      currency: "CAD",
      variants: {
        create: [
          {
            name: "One size",
            sku: `${CODE}-1`,
            wholesalePrice: 1000,
            suggestedRetailPrice: 2000,
            isDefault: true,
          },
        ],
      },
    },
  });

  const blockedApplication = await prisma.merchantApplication.create({
    data: {
      shopDomain: SHOP_A,
      storeName: "VCA Blocked Store",
      contactName: "VCA Contact",
      email: "vca-a@example.invalid",
      legalBusinessName: "VCA Blocked Ltd",
      productCategory: "Home",
      status: "APPROVED",
    },
  });
  const blocked = await prisma.seller.create({
    data: {
      shopDomain: SHOP_A,
      shopDomainFull: SHOP_A,
      storeName: "VCA Blocked Store",
      contactEmail: "vca-a@example.invalid",
      currency: "CAD",
      status: "APPROVED",
      approvedAt: new Date(),
      applicationId: blockedApplication.id,
    },
  });

  const otherApplication = await prisma.merchantApplication.create({
    data: {
      shopDomain: SHOP_B,
      storeName: "VCA Open Store",
      contactName: "VCA Contact",
      email: "vca-b@example.invalid",
      legalBusinessName: "VCA Open Ltd",
      productCategory: "Home",
      status: "APPROVED",
    },
  });
  const open = await prisma.seller.create({
    data: {
      shopDomain: SHOP_B,
      shopDomainFull: SHOP_B,
      storeName: "VCA Open Store",
      contactEmail: "vca-b@example.invalid",
      currency: "CAD",
      status: "APPROVED",
      approvedAt: new Date(),
      applicationId: otherApplication.id,
    },
  });

  /*
   * Products in the blocked store's scope, plus rows that must NOT be in scope.
   * Every one of them carries the same name and the same category: if anything
   * matched on title, or on any other property of the product, the out-of-scope
   * rows would be marked too and checks 2 and 3 would fail.
   */
  const second = await prisma.product.create({
    data: { name: "VCA Archive Family", productCode: `${CODE}-2`, category: "Home", currency: "CAD" },
  });
  const third = await prisma.product.create({
    data: { name: "VCA Archive Family", productCode: `${CODE}-3`, category: "Home", currency: "CAD" },
  });
  const notImported = await prisma.product.create({
    data: { name: "VCA Archive Family", productCode: `${CODE}-4`, category: "Home", currency: "CAD" },
  });

  function map(sellerShop: string, productId: string, externalId: string | null) {
    return prisma.externalProductMapping.create({
      data: {
        productId,
        provider: "SHOPIFY",
        shopDomain: sellerShop,
        externalProductId: externalId,
        importStatus: externalId ? "IMPORTED" : "NOT_IMPORTED",
        lastSyncedAt: new Date(),
      },
    });
  }

  const inScope = await map(SHOP_A, product.id, `gid://shopify/Product/${suffix}A1`);
  const alsoInScope = await map(SHOP_A, second.id, `gid://shopify/Product/${suffix}A2`);
  await map(SHOP_A, third.id, `gid://shopify/Product/${suffix}A3`);
  // A row that exists but was never imported to Shopify: there is nothing in
  // the store to archive, so it must not be marked as awaiting archive.
  const neverImported = await map(SHOP_A, notImported.id, null);
  // The other store's row, for a product with the same name.
  const otherStore = await map(SHOP_B, product.id, `gid://shopify/Product/${suffix}B1`);

  try {
    /* ------------------------------------------------------------------ */
    /* Scope: the mapping table, and only the mapping table                 */
    /* ------------------------------------------------------------------ */
    await markArchivePending(blocked.id);

    const afterMark = await prisma.externalProductMapping.findMany({
      where: { id: { in: [inScope.id, alsoInScope.id, neverImported.id, otherStore.id] } },
      select: { id: true, archiveStatus: true },
    });
    const statusOf = (id: string) => afterMark.find((row) => row.id === id)?.archiveStatus;

    check(
      1,
      "The store's own imported products are marked as awaiting archive",
      statusOf(inScope.id) === "PENDING" && statusOf(alsoInScope.id) === "PENDING",
      `${statusOf(inScope.id)} / ${statusOf(alsoInScope.id)}`,
    );
    check(
      2,
      "Another store's mapping is untouched, even for a product with the same name",
      statusOf(otherStore.id) === "NOT_APPLICABLE",
      String(statusOf(otherStore.id)),
    );
    check(
      3,
      "A row that was never imported to Shopify is not marked as awaiting archive",
      statusOf(neverImported.id) === "NOT_APPLICABLE",
      String(statusOf(neverImported.id)),
    );

    const counts = await archiveCounts(blocked.id);
    check(
      4,
      "The counts the owner sees are drawn from those rows, and exclude the ones with nothing in Shopify",
      counts.pending === 3 && counts.archived === 0 && counts.failed === 0 && counts.total === 3,
      JSON.stringify(counts),
    );

    const worklist = await archiveWorklist(blocked.id);
    check(
      5,
      "The worklist names the products still outstanding, rather than showing a bare number",
      worklist.length === 3 && worklist.every((row) => row.shopifyProductId !== null),
      `${worklist.length} listed`,
    );

    /* ------------------------------------------------------------------ */
    /* The second lock: a store that is not blocked is never archived       */
    /* ------------------------------------------------------------------ */
    let refusal: unknown = null;
    try {
      await archiveSellerProducts(open.id);
    } catch (error) {
      refusal = error;
    }
    const openRow = await prisma.externalProductMapping.findUnique({ where: { id: otherStore.id } });
    check(
      6,
      "Archiving a store that is not blocked is refused outright, even though its mapping rows exist",
      messageOf(refusal).includes("not BLOCKED") && isPermanent(refusal),
      messageOf(refusal) || "no refusal",
    );
    check(
      7,
      "And the refusal wrote nothing to that store's rows",
      openRow?.archiveStatus === "NOT_APPLICABLE" && openRow.archiveAttempts === 0,
      `${openRow?.archiveStatus} attempts=${openRow?.archiveAttempts}`,
    );

    /* ------------------------------------------------------------------ */
    /* The run: no Shopify session means no archive, and it says so          */
    /* ------------------------------------------------------------------ */
    await blockSeller(blocked.id, actor, "archive scope check");
    const blockedAgain = await prisma.externalProductMapping.findMany({
      where: { shopDomain: SHOP_A, externalProductId: { not: null } },
      select: { archiveStatus: true },
    });
    check(
      8,
      "Blocking the store through the real service marks its imported products for archiving",
      blockedAgain.length === 3 && blockedAgain.every((row) => row.archiveStatus === "PENDING"),
      blockedAgain.map((row) => row.archiveStatus).join(", "),
    );

    let runError: unknown = null;
    try {
      await archiveSellerProducts(blocked.id);
    } catch (error) {
      runError = error;
    }
    const afterRun = await archiveCounts(blocked.id);
    check(
      9,
      "With no Shopify access the run fails loudly, rather than reporting a catalogue it could not reach",
      runError !== null && /Shopify/i.test(messageOf(runError)),
      messageOf(runError).slice(0, 120) || "no error",
    );
    check(
      10,
      "Nothing is counted as archived, and every product is still outstanding",
      afterRun.archived === 0 && afterRun.pending === 3,
      JSON.stringify(afterRun),
    );

    const storedReason = await prisma.externalProductMapping.findUnique({
      where: { id: inScope.id },
      select: { archiveLastError: true, archiveStatus: true, archivedAt: true },
    });
    check(
      11,
      "The reason is recorded on the row, so the owner sees why rather than a count that will not move",
      (storedReason?.archiveLastError ?? "").length > 0 &&
        storedReason?.archiveStatus === "PENDING" &&
        storedReason?.archivedAt === null,
      (storedReason?.archiveLastError ?? "no reason recorded").slice(0, 100),
    );

    // Running it twice must not double-count or claim a second archive.
    let secondRun: unknown = null;
    try {
      await archiveSellerProducts(blocked.id);
    } catch (error) {
      secondRun = error;
    }
    const afterSecond = await archiveCounts(blocked.id);
    check(
      12,
      "A second run archives nothing twice and leaves the counts exactly as they were",
      secondRun !== null && afterSecond.archived === 0 && afterSecond.pending === 3,
      JSON.stringify(afterSecond),
    );

    /* ------------------------------------------------------------------ */
    /* The exhausted state is a person's problem, and is reported as one    */
    /* ------------------------------------------------------------------ */
    await prisma.externalProductMapping.updateMany({
      where: { shopDomain: SHOP_A, externalProductId: { not: null } },
      data: { archiveAttempts: 5 },
    });
    let exhausted: unknown = null;
    try {
      await archiveSellerProducts(blocked.id);
    } catch (error) {
      exhausted = error;
    }
    check(
      13,
      "Products that have used every attempt stop being retried, and say a person has to resolve them",
      isPermanent(exhausted) &&
        /could not be archived/.test(messageOf(exhausted)) &&
        /still not archived/.test(messageOf(exhausted)),
      messageOf(exhausted).slice(0, 130) || "no error",
    );

    /* ------------------------------------------------------------------ */
    /* Resetting failures is owner-driven, and only for a blocked store     */
    /* ------------------------------------------------------------------ */
    await prisma.externalProductMapping.updateMany({
      where: { shopDomain: SHOP_A, externalProductId: { not: null } },
      data: { archiveStatus: "FAILED", archiveLastError: "Shopify said no." },
    });

    let resetRefusal: string | null = null;
    try {
      await resetFailedArchives(open.id);
    } catch (error) {
      resetRefusal = messageOf(error);
    }
    check(
      14,
      "Failed archives cannot be reset for a store that is not blocked",
      resetRefusal !== null && /Only a blocked store/.test(resetRefusal),
      resetRefusal ?? "no refusal",
    );

    const resetCount = await resetFailedArchives(blocked.id);
    const afterReset = await archiveCounts(blocked.id);
    check(
      15,
      "For a blocked store the owner can reset the failures, and they return to pending with a fresh attempt budget",
      resetCount === 3 && afterReset.failed === 0 && afterReset.pending === 3,
      `reset ${resetCount}, now ${JSON.stringify(afterReset)}`,
    );

    /* ------------------------------------------------------------------ */
    /* A store with nothing outstanding does not reach Shopify at all        */
    /* ------------------------------------------------------------------ */
    await prisma.externalProductMapping.updateMany({
      where: { shopDomain: SHOP_A, externalProductId: { not: null } },
      data: { archiveStatus: "ARCHIVED", archivedAt: new Date(), archiveLastError: null },
    });
    let cleanRun: unknown = null;
    let cleanResult: Awaited<ReturnType<typeof archiveSellerProducts>> | null = null;
    try {
      cleanResult = await archiveSellerProducts(blocked.id);
    } catch (error) {
      cleanRun = error;
    }
    const doneCounts = await archiveCounts(blocked.id);
    check(
      16,
      "A blocked store whose products are all archived runs to completion without touching Shopify",
      cleanRun === null && cleanResult?.total === 0 && doneCounts.archived === 3 && doneCounts.pending === 0,
      cleanRun ? messageOf(cleanRun) : `${cleanResult?.total} outstanding, archived=${doneCounts.archived}`,
    );

    /* ------------------------------------------------------------------ */
    /* Unblocking does not republish                                        */
    /* ------------------------------------------------------------------ */
    await unblockSeller(blocked.id, actor);
    const afterUnblock = await prisma.externalProductMapping.findMany({
      where: { shopDomain: SHOP_A, externalProductId: { not: null } },
      select: { archiveStatus: true, archivedAt: true },
    });
    const archiveJobsLeft = await prisma.backgroundJob.count({
      where: {
        sellerId: blocked.id,
        kind: JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS,
        status: { in: ["PENDING", "RUNNING"] },
      },
    });
    check(
      17,
      "Unblocking leaves the products archived: they are not republished by a status change",
      afterUnblock.length === 3 &&
        afterUnblock.every((row) => row.archiveStatus === "ARCHIVED" && row.archivedAt !== null),
      afterUnblock.map((row) => row.archiveStatus).join(", "),
    );
    check(
      17.1,
      "And the archiving work queued by the block is cancelled rather than left to run after the block is lifted",
      archiveJobsLeft === 0,
      `${archiveJobsLeft} archive job(s) still pending`,
    );

    /* ------------------------------------------------------------------ */
    /* Archive, never delete, and never overwrite                           */
    /* ------------------------------------------------------------------ */
    const source = stripComments(
      readFileSync(join(process.cwd(), "app", "services", "productArchive.server.ts"), "utf8"),
    );
    check(
      18,
      "The module archives by status and never deletes a product",
      !/productDelete/.test(source) && /status: "ARCHIVED"/.test(source),
      "no productDelete; productUpdate with status ARCHIVED only",
    );
    check(
      19,
      "It writes the id and the status and nothing else, so it cannot overwrite a merchant's own edits",
      /variables: \{ product: \{ id: productId, status: "ARCHIVED" \} \}/.test(source),
      "the mutation payload carries only id and status",
    );
    check(
      20,
      "And the archived status is read back off Shopify's answer, not assumed from the request",
      /product\.status === "ARCHIVED"/.test(source),
      "the response status is checked before anything is counted",
    );

    const applicationSource = stripComments(
      readFileSync(join(process.cwd(), "app", "services", "application.server.ts"), "utf8"),
    );
    check(
      21,
      "The service that lifts a block writes no product state at all, so an unblock cannot republish",
      /export async function unblockSeller/.test(applicationSource) &&
        !/productUpdate|isArchived|isPublished/.test(applicationSource),
      "unblockSeller moves a status and records why; nothing else",
    );

    /* ------------------------------------------------------------------ */
    /* The block itself does not depend on Shopify                          */
    /* ------------------------------------------------------------------ */
    const blockAudit = await prisma.auditLog.findFirst({
      where: { entityType: "Seller", entityId: blocked.id, action: "seller.blocked" },
      select: { id: true },
    });
    const archiveJob = await prisma.backgroundJob.findFirst({
      where: { sellerId: blocked.id, kind: JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS },
      select: { status: true, lastError: true },
    });
    check(
      22,
      "The block was committed and recorded while Shopify was unreachable: the store lost access without Shopify's cooperation",
      blockAudit !== null && archiveJob?.status === "CANCELLED",
      `block audited; archive job ${archiveJob?.status} (${(archiveJob?.lastError ?? "").slice(0, 60)})`,
    );
  } finally {
    await cleanup();
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

async function cleanup() {
  const sellers = await prisma.seller.findMany({
    where: { shopDomain: { in: SHOPS } },
    select: { id: true },
  });
  const ids = sellers.map((seller) => seller.id);
  if (ids.length) {
    await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: ids } } });
    await prisma.seller.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.externalProductMapping.deleteMany({ where: { shopDomain: { in: SHOPS } } });
  await prisma.merchantApplication.deleteMany({ where: { shopDomain: { in: SHOPS } } });

  const products = await prisma.product.findMany({
    where: { productCode: { startsWith: CODE } },
    select: { id: true, variants: { select: { id: true } } },
  });
  const variantIds = products.flatMap((item) => item.variants.map((variant) => variant.id));
  if (variantIds.length) {
    await prisma.variantPackage.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await prisma.product.deleteMany({ where: { productCode: { startsWith: CODE } } });
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // The original error is the one worth reporting.
  }
  await prisma.$disconnect();
  process.exit(1);
});
