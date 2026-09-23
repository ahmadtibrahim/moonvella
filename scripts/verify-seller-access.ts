/**
 * The five seller access states, as the server enforces them.
 *
 * WHAT THIS SUITE IS FOR. A status is only real if the server acts on it. The
 * states in this directive — not applied, approved, rejected, deactivated,
 * blocked — are easy to render and hard to enforce, because rendering is one
 * `if` in a layout and enforcement is every loader, every action, every
 * background job and every direct URL. The gaps are exactly where a store
 * keeps a feature it is not entitled to: a child route whose loader still runs
 * because the layout hid a link, a queued job that fires after the approval it
 * was created under has been revoked, an "approved" screen that a merchant has
 * to reload to see.
 *
 * HOW IT CHECKS. Three levels, because the three fail differently:
 *
 *   1. `resolveSellerContext` — the four booleans every merchant route reads.
 *      Asserting these asserts pricing, importing, order history and new
 *      business at once, at the point every screen reads them.
 *   2. The transitions — through the real services, so the version bump and the
 *      job cancellation that make state changes take effect are exercised
 *      rather than assumed.
 *   3. The route list — a source walk asserting every merchant route calls a
 *      guard itself. This is the check for "do not rely solely on hiding
 *      navigation", and it is the only one here that would catch a NEW route
 *      being added without a guard, which is how this kind of enforcement is
 *      actually lost.
 *
 * WHAT IT DOES NOT DO. It contacts no external service: no Shopify, no Odoo,
 * no Stripe. The routes themselves need a live Shopify session to sign in with,
 * so the HTTP layer is covered by `verify-stores-ui.ts` instead.
 *
 * IT CREATES ROWS. Everything it makes goes in `cleanup()`, which runs even when
 * a check throws. Audit rows are not removed — AuditLog is append-only.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-seller-access.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { resolveSellerContext, BLOCKED_MESSAGE } from "~/services/seller.server";
import {
  approveApplication,
  blockSeller,
  deactivateSeller,
  rejectApplication,
  returnSellerToReview,
} from "~/services/application.server";
import { JOB_KIND, jobKey, runDueJobs, type JobHandler } from "~/services/jobs.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const STAMP = Date.now();

const SHOP_PENDING = `vsa-pending-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_APPROVED = `vsa-approved-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_REJECTED = `vsa-rejected-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_DEACTIVATED = `vsa-deactivated-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_BLOCKED = `vsa-blocked-${suffix.toLowerCase()}.myshopify.com`;
const SHOPS = [SHOP_PENDING, SHOP_APPROVED, SHOP_REJECTED, SHOP_DEACTIVATED, SHOP_BLOCKED];

/**
 * When the claim-time fixture is due, and the clock the runner is given.
 *
 * Both are in the past, and that is the point: the runner's claim is `runAt <=
 * now`, so passing a `now` from before this run started makes the batch consist
 * of jobs that already existed rather than of whatever the other suites have
 * queued since. A day back is further than any fixture of this suite's own, and
 * the queue is emptied by the runner rather than left to age.
 */
const STALE_RUN_AT = new Date(Date.now() - 24 * 60 * 60 * 1000);
const STALE_RUN_AT_NOW = new Date(STALE_RUN_AT.getTime() + 1000);

/**
 * The reviewing admin.
 *
 * `actorId` is a real AdminUser id rather than a label, because review actions
 * record who decided and `MerchantApplication.reviewedById` is a foreign key —
 * an invented id fails the constraint rather than recording a decision nobody
 * made. The name is this suite's own, so the audit rows it writes are
 * attributable to the run rather than to the person whose id it borrows.
 */
let actor = {
  actorId: "vsa-verify",
  actorName: "Seller Access Verify",
  actorType: "ADMIN_USER" as const,
};

let failures = 0;
let total = 0;
let expected = 0;

/**
 * Numbered, and the numbering is enforced: a dropped check fails the suite.
 *
 * A sub-number (10.1) may follow the step it belongs to without advancing the
 * sequence, so a check added to an existing step does not renumber the rest.
 */
function check(number: number, name: string, pass: boolean, detail = "") {
  total += 1;
  // `expected` counts checks already seen, so the next whole number is
  // expected + 1; a sub-number belongs to the step just seen.
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

/** An application plus its seller, in the state the caller names. */
async function makeStore(shop: string, label: string, status: "PENDING" | "APPROVED") {
  const application = await prisma.merchantApplication.create({
    data: {
      shopDomain: shop,
      storeName: `${label} Store`,
      contactName: `${label} Contact`,
      email: `${shop.split(".")[0]}@example.invalid`,
      legalBusinessName: `${label} Ltd`,
      productCategory: "Home",
      status,
      submittedAt: new Date(),
    },
  });
  const seller = await prisma.seller.create({
    data: {
      shopDomain: shop,
      shopDomainFull: shop,
      storeName: `${label} Store`,
      contactEmail: `${shop.split(".")[0]}@example.invalid`,
      currency: "CAD",
      status,
      approvedAt: status === "APPROVED" ? new Date() : null,
      applicationId: application.id,
    },
  });
  return { application, seller };
}

/** The four permissions, as a compact string, for failure messages. */
function flags(context: Awaited<ReturnType<typeof resolveSellerContext>>) {
  return `wholesale=${context.canViewWholesale} import=${context.canImport} orders=${context.canViewOrders} newBusiness=${context.canStartNewBusiness}`;
}

async function main() {
  const admin = await prisma.adminUser.findFirst({ select: { id: true } });
  if (admin) actor = { ...actor, actorId: admin.id };

  // `rejected` is not taken: the rejected store is checked through
  // `resolveSellerContext`, by shop, like every other state here.
  const { approved, deactivated, blocked, blockedSeller } = await seedFixtures();

  try {
    /* ------------------------------------------------------------------ */
    /* 1. The states, at the point every screen reads them                  */
    /* ------------------------------------------------------------------ */

    const pendingContext = await resolveSellerContext(SHOP_PENDING);
    check(
      1,
      "NOT APPLIED / PENDING keeps the application visible and product preview, but no pricing and no import",
      pendingContext.access === "PENDING" &&
        !pendingContext.canViewWholesale &&
        !pendingContext.canImport &&
        !pendingContext.canStartNewBusiness,
      `${pendingContext.access} ${flags(pendingContext)}`,
    );

    const approvedContext = await resolveSellerContext(SHOP_APPROVED);
    check(
      2,
      "APPROVED unlocks pricing, import and new business",
      approvedContext.access === "APPROVED" &&
        approvedContext.canViewWholesale &&
        approvedContext.canImport &&
        approvedContext.canStartNewBusiness,
      `${approvedContext.access} ${flags(approvedContext)}`,
    );

    const rejectedContext = await resolveSellerContext(SHOP_REJECTED);
    check(
      3,
      "REJECTED shows the outcome and keeps pricing and import locked",
      rejectedContext.access === "REJECTED" &&
        !rejectedContext.canViewWholesale &&
        !rejectedContext.canImport &&
        !rejectedContext.canStartNewBusiness,
      `${rejectedContext.access} ${flags(rejectedContext)}`,
    );

    const blockedContext = await resolveSellerContext(SHOP_BLOCKED);
    check(
      4,
      "BLOCKED refuses everything, including order history",
      blockedContext.access === "BLOCKED" &&
        !blockedContext.canViewWholesale &&
        !blockedContext.canImport &&
        !blockedContext.canViewOrders &&
        !blockedContext.canStartNewBusiness,
      `${blockedContext.access} ${flags(blockedContext)}`,
    );
    check(
      5,
      "And the only thing a blocked store is told is the owner's sentence",
      BLOCKED_MESSAGE === "This app is not available for your store.",
      JSON.stringify(BLOCKED_MESSAGE),
    );

    /* ------------------------------------------------------------------ */
    /* 2. Deactivation: revoked, reapplyable, history intact                */
    /* ------------------------------------------------------------------ */
    await deactivateSeller(deactivated.seller.id, actor, "annual review");
    const deactivatedContext = await resolveSellerContext(SHOP_DEACTIVATED);
    check(
      6,
      "DEACTIVATED revokes approved access: no pricing, no import, no new business",
      deactivatedContext.access === "DEACTIVATED" &&
        !deactivatedContext.canViewWholesale &&
        !deactivatedContext.canImport &&
        !deactivatedContext.canStartNewBusiness,
      `${deactivatedContext.access} ${flags(deactivatedContext)}`,
    );
    check(
      7,
      "But order history stays readable — withdrawing it would look like the records were deleted",
      deactivatedContext.canViewOrders === true,
      `orders=${deactivatedContext.canViewOrders}`,
    );

    const deactivatedApplication = await prisma.merchantApplication.findUnique({
      where: { id: deactivated.application.id },
    });
    check(
      8,
      "The application is shown again, DEACTIVATED rather than REJECTED, so it can be resubmitted",
      deactivatedApplication?.status === "DEACTIVATED",
      `application status ${deactivatedApplication?.status}`,
    );

    const deactivateAudit = await prisma.auditLog.findFirst({
      where: { entityType: "Seller", entityId: deactivated.seller.id, action: "seller.deactivated" },
      orderBy: { createdAt: "desc" },
    });
    let deactivateAfter: Record<string, unknown> = {};
    try {
      deactivateAfter = JSON.parse(deactivateAudit?.afterData ?? "{}") as Record<string, unknown>;
    } catch {
      deactivateAfter = {};
    }
    check(
      9,
      "The audit says the store may apply again, so the policy is recorded rather than implied",
      deactivateAfter.mayReapply === true && deactivateAfter.reason === "annual review",
      JSON.stringify(deactivateAfter),
    );

    // The reapplication path itself: a resubmission returns the store to review,
    // and review — not the store — is what approves it again.
    await returnSellerToReview(deactivated.seller.id);
    const reapplied = await resolveSellerContext(SHOP_DEACTIVATED);
    check(
      10,
      "Reapplying returns the store to PENDING, and PENDING is not delivery of access",
      reapplied.access === "PENDING" && !reapplied.canViewWholesale && !reapplied.canImport,
      `${reapplied.access} ${flags(reapplied)}`,
    );

    const awaitingDecision = await prisma.seller.findUnique({
      where: { id: deactivated.seller.id },
      select: { status: true },
    });
    check(
      10.1,
      "And it stays there: resubmitting does not approve the store by itself",
      awaitingDecision?.status === "PENDING",
      `status after resubmission: ${awaitingDecision?.status}`,
    );

    await approveApplication(deactivated.application.id, actor);
    const reApproved = await resolveSellerContext(SHOP_DEACTIVATED);
    check(
      10.2,
      "An owner approving the reapplication restores access, so deactivation is not a dead end",
      reApproved.access === "APPROVED" && reApproved.canViewWholesale && reApproved.canImport,
      `${reApproved.access} ${flags(reApproved)}`,
    );

    /* ------------------------------------------------------------------ */
    /* 3. Stale authorization is invalidated, not merely hidden             */
    /* ------------------------------------------------------------------ */
    const versionBefore = (await prisma.seller.findUnique({
      where: { id: approved.seller.id },
      select: { accessVersion: true },
    }))?.accessVersion;

    // A job queued while the store was approved, carrying that version.
    await prisma.backgroundJob.deleteMany({
      where: { idempotencyKey: jobKey(JOB_KIND.ODOO_CONTACT_SYNC, approved.seller.id) },
    });
    await prisma.backgroundJob.create({
      data: {
        kind: JOB_KIND.ODOO_CONTACT_SYNC,
        idempotencyKey: `vsa-stale-${suffix}`,
        sellerId: approved.seller.id,
        sellerAccessVersion: versionBefore ?? 1,
        status: "PENDING",
        runAt: new Date(Date.now() - 1000),
        payload: { sellerId: approved.seller.id },
      },
    });

    await blockSeller(approved.seller.id, actor, "stale authorization check");
    const versionAfter = (await prisma.seller.findUnique({
      where: { id: approved.seller.id },
      select: { accessVersion: true },
    }))?.accessVersion;
    check(
      11,
      "A status change bumps the access version, which is what invalidates deferred work",
      typeof versionAfter === "number" && typeof versionBefore === "number" && versionAfter > versionBefore,
      `${versionBefore} -> ${versionAfter}`,
    );

    const archiveJob = await prisma.backgroundJob.findFirst({
      where: { idempotencyKey: jobKey(JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS, blocked.seller.id) },
    });
    check(
      12,
      "Blocking queues the archiving work instead of doing it in the request that blocked the store",
      archiveJob?.kind === JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS &&
        archiveJob.status === "PENDING" &&
        archiveJob.sellerAccessVersion === blockedSeller.accessVersion &&
        archiveJob.payload !== null,
      `${archiveJob?.kind} ${archiveJob?.status} v${archiveJob?.sellerAccessVersion} (blocked at v${blockedSeller.accessVersion})`,
    );

    /*
     * Two mechanisms revoke deferred work, and they are checked separately
     * because they fail separately.
     *
     * The first is eager: a status change cancels the store's pending jobs, so
     * work does not wait for the next tick to learn it is no longer wanted. The
     * second is the runner's own version check, which is what catches a job that
     * escaped the first — one written in the window between the check and the
     * write, or by a caller that does not go through the status-change path.
     * Asserting only the second with a job the first had already cancelled
     * proves nothing about it: the row reads CANCELLED either way.
     */
    const staleJob = await prisma.backgroundJob.findUnique({
      where: { idempotencyKey: `vsa-stale-${suffix}` },
    });
    check(
      13,
      "Blocking cancels the store's pending work in the same transaction, so none of it waits for a tick",
      // The reason the block itself gives, not the runner's wording about
      // versions — which is how this asserts the status-change path did it.
      staleJob?.status === "CANCELLED" && (staleJob.lastError ?? "").toLowerCase().includes("blocked"),
      `status=${staleJob?.status} reason=${JSON.stringify(staleJob?.lastError ?? "")}`,
    );

    /*
     * A job that reaches the runner still carrying a superseded version. It is
     * written AFTER the status change, so the eager cancellation above has
     * already run and cannot be what cancels this one — only the claim-time
     * comparison can.
     */
    const blockVersion = blockedSeller.accessVersion;
    const staleClaimJob = await prisma.backgroundJob.create({
      data: {
        kind: JOB_KIND.ODOO_CONTACT_SYNC,
        idempotencyKey: `vsa-stale-claim-${suffix}`,
        sellerId: blocked.seller.id,
        sellerAccessVersion: blockVersion - 1,
        status: "PENDING",
        runAt: STALE_RUN_AT,
        payload: { sellerId: blocked.seller.id },
      },
    });

    /*
     * The batch is bounded twice over, so the assertion means what it says and
     * the run touches nothing that is not this suite's:
     *
     *   `now` is the fixture's own runAt, in the past, so a job another suite
     *   enqueued since then is not yet due; and `limit` is 1, so at most one row
     *   is claimed either way.
     *
     * The spy records WHICH job it was handed rather than a bare boolean. A
     * boolean claimed "no handler ran for anything", which a stray due job from
     * an earlier run turns into a failure that says nothing about this check —
     * and the run would also have marked that stray job SUCCEEDED.
     */
    const ran: string[] = [];
    const spy: JobHandler = async (job) => {
      ran.push(job.id);
      return { summary: "should not have run" };
    };
    const run = await runDueJobs(
      { [JOB_KIND.ODOO_CONTACT_SYNC]: spy },
      { limit: 1, now: STALE_RUN_AT_NOW },
    );
    const afterRun = await prisma.backgroundJob.findUnique({ where: { id: staleClaimJob.id } });
    check(
      13.1,
      "And a job that escaped it is cancelled at claim time, by the version it was queued under",
      run.claimed === 1 &&
        run.cancelled === 1 &&
        afterRun?.status === "CANCELLED" &&
        !ran.includes(staleClaimJob.id) &&
        (afterRun.lastError ?? "").includes(`version ${blockVersion - 1}`),
      `status=${afterRun?.status} ran=${JSON.stringify(ran)} claimed=${run.claimed} cancelled=${run.cancelled}`,
    );

    /* ------------------------------------------------------------------ */
    /* 4. Every merchant route guards itself                                */
    /* ------------------------------------------------------------------ */
    const routesDir = join(process.cwd(), "app", "routes");
    const merchantRoutes = readdirSync(routesDir).filter(
      (name) =>
        name.startsWith("app.") &&
        (name.endsWith(".jsx") || name.endsWith(".tsx")) &&
        name !== "app.jsx",
    );

    check(
      14,
      "There is more than one merchant route to check, so this is a real sweep",
      merchantRoutes.length >= 6,
      `${merchantRoutes.length} routes: ${merchantRoutes.join(", ")}`,
    );

    const unguarded = merchantRoutes.filter((name) => {
      const source = readFileSync(join(routesDir, name), "utf8");
      return !/requireMerchantAccess|withMerchantAccess|requireApprovedSeller/.test(source);
    });
    check(
      15,
      "Every merchant route calls the access guard itself, rather than relying on the layout's navigation",
      unguarded.length === 0,
      unguarded.length ? `unguarded: ${unguarded.join(", ")}` : `${merchantRoutes.length} routes guarded`,
    );

    /*
     * The layout is a second line of defence and the routes are the first, which
     * is the opposite of the usual arrangement and worth stating explicitly:
     * React Router runs parent and child loaders in parallel, so a page loader
     * that trusts the layout has already fetched its rows.
     */
    const layout = readFileSync(join(routesDir, "app.jsx"), "utf8");
    check(
      16,
      "The layout renders the block sentence instead of the outlet, so no route can render past it",
      /if \(blocked\)/.test(layout) && /BlockedScreen/.test(layout),
      "app.jsx replaces the outlet when blocked",
    );
    check(
      17,
      "The layout re-reads access on a timer, so an approval arrives without a manual refresh",
      /setInterval/.test(layout) && /revalidat/i.test(layout),
      "poll + revalidate on visibility",
    );

    const applicationRoute = readFileSync(join(routesDir, "app.application.jsx"), "utf8");
    check(
      18,
      "An approved store is redirected away from the application screen rather than shown an empty form",
      /access === "APPROVED"/.test(applicationRoute) && /redirect\(/.test(applicationRoute),
      "app.application.jsx redirects an approved store",
    );

    /* ------------------------------------------------------------------ */
    /* 5. Nothing was deleted along the way                                 */
    /* ------------------------------------------------------------------ */
    const stillThere = await prisma.seller.findMany({
      where: { shopDomain: { in: SHOPS } },
      select: { shopDomain: true, status: true },
    });
    check(
      19,
      "Every store still has its row and its application through all of these transitions",
      stillThere.length === SHOPS.length,
      `${stillThere.length}/${SHOPS.length} rows: ${stillThere.map((s) => `${s.shopDomain.split("-")[1]}=${s.status}`).join(" ")}`,
    );

    const applicationsLeft = await prisma.merchantApplication.count({
      where: { shopDomain: { in: SHOPS } },
    });
    check(
      20,
      "And the previous applications are preserved, not replaced by the latest decision",
      applicationsLeft === SHOPS.length,
      `${applicationsLeft} application(s)`,
    );
  } finally {
    await cleanup();
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

/**
 * Build the five fixture stores and put the rejected and blocked ones through
 * the real transitions.
 *
 * Its own try/catch, because this runs BEFORE the checks' try/finally: created
 * outside it, a failure here leaves five sellers behind, and in a database the
 * other suites share that residue is not inert. verify-rankings counts the
 * roster it can see, and a `--all` run did fail there because an earlier run of
 * this suite had thrown before reaching its cleanup. `cleanup()` deletes by shop
 * domain, so it is safe to call against a partial set.
 */
async function seedFixtures() {
  try {
    await makeStore(SHOP_PENDING, "VSA Pending", "PENDING");
    const approved = await makeStore(SHOP_APPROVED, "VSA Approved", "APPROVED");
    const rejected = await makeStore(SHOP_REJECTED, "VSA Rejected", "PENDING");
    const deactivated = await makeStore(SHOP_DEACTIVATED, "VSA Deactivated", "APPROVED");
    const blocked = await makeStore(SHOP_BLOCKED, "VSA Blocked", "APPROVED");

    await rejectApplication(rejected.application.id, actor, "outside our category");
    // Through the real service, so the archive marking and the queued job are
    // exercised rather than simulated by a direct status write.
    const blockedSeller = await blockSeller(blocked.seller.id, actor, "blocked store check");

    return { approved, rejected, deactivated, blocked, blockedSeller };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function cleanup() {
  const sellers = await prisma.seller.findMany({
    where: { shopDomain: { in: SHOPS } },
    select: { id: true },
  });
  const sellerIds = sellers.map((seller) => seller.id);
  if (sellerIds.length) {
    await prisma.externalContactMapping.deleteMany({ where: { sellerId: { in: sellerIds } } });
    await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: sellerIds } } });
    await prisma.seller.deleteMany({ where: { id: { in: sellerIds } } });
  }
  await prisma.backgroundJob.deleteMany({ where: { idempotencyKey: `vsa-stale-${suffix}` } });
  await prisma.merchantApplication.deleteMany({ where: { shopDomain: { in: SHOPS } } });
  void STAMP;
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
