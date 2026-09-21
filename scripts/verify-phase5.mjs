/**
 * Admin product flow, over HTTP, against a running app.
 *
 * Rewritten for the product/variant model. The flow it drives changed shape:
 * creating a product no longer collects prices or an image URL, because those
 * belong to a sellable variant and to a media asset with real bytes. So this
 * now walks the interface a merchant actually walks — create the family, land
 * on the editor, add the variant — and asserts the same three things it always
 * did: the row exists, the database agrees, and the actions were audited.
 */
import { PrismaClient } from "@prisma/client";
// The cookie name is imported rather than written out, so renaming it in the
// app cannot leave this suite quietly asserting the wrong string.
import { ADMIN_SESSION_COOKIE } from "../app/utils/adminAuth.server";

const prisma = new PrismaClient();
const BASE = process.env.APP_BASE || "http://localhost:62259";
const EMAIL = process.env.OWNER_EMAIL || "";
const PASSWORD = process.env.OWNER_PASSWORD || "";
const SKU = `VERIFY-P5-${Date.now()}`;

let failures = 0;
let total = 0;
function check(name, pass, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login() {
  const res = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return cookie;
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

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Set OWNER_EMAIL and OWNER_PASSWORD.");
    process.exit(1);
  }
  const existing = await prisma.product.findUnique({ where: { productCode: SKU } });
  if (existing) await prisma.product.deleteMany({ where: { productCode: SKU } });

  const cookie = await login();
  check("owner login", cookie.includes(ADMIN_SESSION_COOKIE), cookie ? "session issued" : "no cookie");

  // The create step is its own page now; a product must exist and be a draft
  // before anything can be uploaded to it.
  const create = await post("/admin/products/new", cookie, {
    name: "Verification Product",
    productCode: SKU,
    category: "Pillows",
    description: "Created by verify-phase5",
    currency: "CAD",
  });
  const location = create.headers.get("location") || "";
  const productId = location.split("/")[3]?.split("?")[0] || "";
  check("create product redirects to the editor", create.status === 302 && !!productId, location);

  const dbProduct = await prisma.product.findUnique({ where: { id: productId } });
  check("product persisted in DB", !!dbProduct && dbProduct.productCode === SKU, dbProduct?.name);
  check("new product starts as a draft", dbProduct?.status === "DRAFT", dbProduct?.status);

  const list = await fetch(`${BASE}/admin/products`, { headers: { Cookie: cookie } });
  check("product list loads (200)", list.status === 200, `status ${list.status}`);

  const detail = await fetch(`${BASE}/admin/products/${productId}?tab=variants`, {
    headers: { Cookie: cookie },
  });
  const detailBody = await detail.text();
  check("detail page loads (200)", detail.status === 200);
  check("detail shows the new product", detailBody.includes("Verification Product"));

  const addVariant = await post(`/admin/products/${productId}`, cookie, {
    intent: "add_variant",
    tab: "variants",
    name: "Standard",
    sku: `${SKU}-STD`,
    wholesalePrice: "15.00",
    suggestedRetailPrice: "49.00",
    inventory: "25",
  });
  check("add variant redirects", addVariant.status === 302);
  const variantCount = await prisma.productVariant.count({ where: { productId } });
  check("variant persisted", variantCount === 1, `${variantCount} variant(s)`);

  const variant = await prisma.productVariant.findFirst({ where: { productId } });
  check("variant stored in cents", variant?.wholesalePrice === 1500, String(variant?.wholesalePrice));
  check("only variant is the default", variant?.isDefault === true);

  // Publishing is gated: no approved image and no written description means the
  // product must refuse to go live rather than appear half-built to a seller.
  const publish = await post(`/admin/products/${productId}`, cookie, { intent: "publish", tab: "details" });
  const refusedBody = await publish.text();
  const afterPublish = await prisma.product.findUnique({ where: { id: productId } });
  // Two things are being asserted, and the second is the one that matters: the
  // product did not go live, and the merchant was told why. A refusal that
  // redirects silently would satisfy the first and fail the person.
  const explained = refusedBody.includes('role="alert"');
  check(
    "publish is refused while the product is incomplete",
    afterPublish?.status !== "PUBLISHED" && explained,
    `${afterPublish?.status}, ${explained ? "explained on the page" : "no explanation returned"}`
  );

  const archive = await post(`/admin/products/${productId}`, cookie, { intent: "archive", tab: "details" });
  check("archive redirects", archive.status === 302);
  const archived = await prisma.product.findUnique({ where: { id: productId } });
  check("product archived + deactivated", archived?.isArchived === true && archived?.isActive === false);
  check("archived product is not published", archived?.status === "ARCHIVED", archived?.status);

  const auditCount = await prisma.auditLog.count({
    where: { entityType: "Product", entityId: productId },
  });
  check("audit events recorded for product", auditCount >= 3, `${auditCount} events`);

  await prisma.product.deleteMany({ where: { productCode: SKU } });

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
