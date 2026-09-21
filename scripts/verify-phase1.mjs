import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
// Imported rather than written out: a renamed cookie must not leave this suite
// asserting a string that no longer exists.
import { ADMIN_SESSION_COOKIE } from "../app/utils/adminAuth.server";

const prisma = new PrismaClient();
const BASE = process.env.APP_BASE || "http://localhost:61784";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "";
const TEST_SHOP = "phase1-test-seller.myshopify.com";
const TEST_SHOP_2 = "phase1-test-seller-b.myshopify.com";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(email, password) {
  const res = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
    },
    body: new URLSearchParams({ email, password }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie };
}

async function post(path, cookie, data) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
      Cookie: cookie,
    },
    body: new URLSearchParams(data),
  });
}

async function createOwner(email, password, role, isActive = true) {
  const passwordHash = await bcrypt.hash(password, 12);
  return prisma.adminUser.upsert({
    where: { email },
    create: { email, passwordHash, name: `Test ${role}`, role, isActive },
    update: { passwordHash, role, isActive },
  });
}

async function cleanup() {
  // Audit rows are deliberately NOT deleted, and could not be: the AuditLog
  // table is append-only at the database level, enforced by the trigger
  // AuditLog_append_only, which raises restrict_violation on any DELETE or
  // UPDATE. A harness that removed its own audit trail would be exercising
  // exactly the capability the trail exists to deny. This run therefore leaves
  // its audit rows behind; everything else it creates is removed.
  await prisma.seller.deleteMany({ where: { shopDomain: { in: [TEST_SHOP, TEST_SHOP_2] } } });
  await prisma.merchantApplication.deleteMany({
    where: { shopDomain: { in: [TEST_SHOP, TEST_SHOP_2] } },
  });
  await prisma.adminUser.deleteMany({
    where: { email: { in: ["phase1-readonly@example.com", "phase1-inactive@example.com"] } },
  });
}

async function main() {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) {
    console.error('Set OWNER_EMAIL and OWNER_PASSWORD environment variables before running.');
    process.exit(1);
  }
  await cleanup();
  await createOwner(OWNER_EMAIL, OWNER_PASSWORD, "OWNER");

  const application = await prisma.merchantApplication.create({
    data: {
      shopDomain: TEST_SHOP,
      storeName: "Phase 1 Test Seller",
      contactName: "Test Contact",
      email: "test@phase1.example",
      legalBusinessName: "Phase 1 Test Inc.",
      sellerAddress: "1 Test St, Toronto, ON",
      productCategory: "Bedding & Bath",
      markets: JSON.stringify(["Ontario"]),
      status: "PENDING",
      submittedAt: new Date(),
    },
  });

  // 1. Login
  const ownerLogin = await login(OWNER_EMAIL, OWNER_PASSWORD);
  check(
    "owner login returns redirect + cookie",
    ownerLogin.status === 302 && ownerLogin.cookie.includes(ADMIN_SESSION_COOKIE),
    `status ${ownerLogin.status}, cookie ${ownerLogin.cookie.includes(ADMIN_SESSION_COOKIE) ? "issued" : "absent"}`
  );

  // 2. Approve
  const approveRes = await post("/admin/applications", ownerLogin.cookie, {
    intent: "approve",
    applicationId: application.id,
    reason: "Verified in Phase 1 test",
  });
  const appAfter = await prisma.merchantApplication.findUnique({ where: { id: application.id } });
  const sellerAfter = await prisma.seller.findUnique({ where: { shopDomain: TEST_SHOP } });
  const approveAudit = await prisma.auditLog.findFirst({
    where: { action: "application.approved", entityId: application.id },
  });
  check("approve: application status APPROVED", appAfter?.status === "APPROVED", appAfter?.status);
  check("approve: seller created APPROVED", sellerAfter?.status === "APPROVED", sellerAfter?.status);
  check("approve: reviewer recorded", !!appAfter?.reviewedById && !!appAfter?.reviewedAt);
  check("approve: audit event written", !!approveAudit, approveAudit?.action);

  // 3. Re-approve should not duplicate seller
  await post("/admin/applications", ownerLogin.cookie, {
    intent: "approve",
    applicationId: application.id,
  });
  const sellerCount = await prisma.seller.count({ where: { shopDomain: TEST_SHOP } });
  check("approve twice: single seller record", sellerCount === 1, `${sellerCount} seller(s)`);

  // 4. Suspend
  await post("/admin/stores", ownerLogin.cookie, {
    intent: "suspend",
    sellerId: sellerAfter.id,
    reason: "Phase 1 test suspend",
  });
  const sellerSuspended = await prisma.seller.findUnique({ where: { id: sellerAfter.id } });
  const appSuspended = await prisma.merchantApplication.findUnique({ where: { id: application.id } });
  const suspendAudit = await prisma.auditLog.findFirst({
    where: { action: "seller.suspended", entityId: sellerAfter.id },
  });
  check("suspend: seller SUSPENDED", sellerSuspended?.status === "SUSPENDED", sellerSuspended?.status);
  check("suspend: application SUSPENDED", appSuspended?.status === "SUSPENDED", appSuspended?.status);
  check("suspend: audit event written", !!suspendAudit);

  // 5. Reactivate
  await post("/admin/stores", ownerLogin.cookie, {
    intent: "reactivate",
    sellerId: sellerAfter.id,
  });
  const sellerReactivated = await prisma.seller.findUnique({ where: { id: sellerAfter.id } });
  check("reactivate: seller APPROVED", sellerReactivated?.status === "APPROVED", sellerReactivated?.status);

  // 6. VIEWER cannot approve
  await createOwner("phase1-readonly@example.com", "readonly123", "VIEWER");
  const readonlyLogin = await login("phase1-readonly@example.com", "readonly123");
  const application2 = await prisma.merchantApplication.create({
    data: {
      shopDomain: TEST_SHOP_2,
      storeName: "Phase 1 Test Seller B",
      contactName: "Test Contact",
      email: "test@phase1.example",
      legalBusinessName: "Phase 1 Test Inc.",
      sellerAddress: "1 Test St, Toronto, ON",
      productCategory: "Bedding & Bath",
      status: "PENDING",
      submittedAt: new Date(),
    },
  });
  const readonlyApprove = await post("/admin/applications", readonlyLogin.cookie, {
    intent: "approve",
    applicationId: application2.id,
  });
  const app2After = await prisma.merchantApplication.findUnique({ where: { id: application2.id } });
  check("VIEWER approve blocked (403)", readonlyApprove.status === 403, `status ${readonlyApprove.status}`);
  check("VIEWER approve had no effect", app2After?.status === "PENDING", app2After?.status);

  // 7. Inactive owner cannot log in
  await createOwner("phase1-inactive@example.com", "inactive123", "OWNER", false);
  const inactiveLogin = await login("phase1-inactive@example.com", "inactive123");
  const inactiveBody = await inactiveLogin.cookie;
  check("inactive owner cannot authenticate", inactiveLogin.status !== 302 && !inactiveBody.includes("owner_session"), `status ${inactiveLogin.status}`);

  // 8. CSRF: cross-origin approve rejected
  const crossOrigin = await fetch(`${BASE}/admin/applications`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "http://evil.example.com",
      Cookie: ownerLogin.cookie,
    },
    body: new URLSearchParams({ intent: "approve", applicationId: application2.id }),
  });
  check("cross-origin POST rejected", crossOrigin.status === 403 || crossOrigin.status === 400, `status ${crossOrigin.status}`);

  await cleanup();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
