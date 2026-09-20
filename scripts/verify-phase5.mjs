import { PrismaClient } from "@prisma/client";

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
  await prisma.product.deleteMany({ where: { sku: SKU } });

  const cookie = await login();
  check("owner login", cookie.includes("owner_session"));

  const create = await post("/admin/products", cookie, {
    intent: "create",
    name: "Verification Product",
    sku: SKU,
    category: "Pillows",
    wholesalePrice: "1500",
    suggestedRetailPrice: "4900",
    costPrice: "900",
    description: "Created by verify-phase5",
  });
  const location = create.headers.get("location") || "";
  const productId = location.split("/").pop();
  check("create product redirects to detail", create.status === 302 && !!productId, location);

  const dbProduct = await prisma.product.findUnique({ where: { id: productId } });
  check("product persisted in DB", !!dbProduct && dbProduct.sku === SKU, dbProduct?.name);

  const list = await fetch(`${BASE}/admin/products`, { headers: { Cookie: cookie } });
  check("product list loads (200)", list.status === 200, `status ${list.status}`);

  const detail = await fetch(`${BASE}/admin/products/${productId}`, { headers: { Cookie: cookie } });
  const detailBody = await detail.text();
  check("detail page loads (200)", detail.status === 200);
  check("detail shows the new product", detailBody.includes("Verification Product"));

  const addVariant = await post(`/admin/products/${productId}`, cookie, {
    intent: "add_variant",
    name: "Standard",
    sku: `${SKU}-STD`,
    wholesalePrice: "1500",
    suggestedRetailPrice: "4900",
    inventory: "25",
  });
  check("add variant redirects", addVariant.status === 302);
  const variantCount = await prisma.productVariant.count({ where: { productId } });
  check("variant persisted", variantCount === 1, `${variantCount} variant(s)`);

  const addImage = await post(`/admin/products/${productId}`, cookie, {
    intent: "add_image_url",
    imageUrl: "https://example.com/verify.jpg",
    alt: "Verification",
  });
  check("add image redirects", addImage.status === 302);
  const images = await prisma.productImage.findMany({ where: { productId } });
  check("image persisted", images.length === 1 && images[0].url === "https://example.com/verify.jpg");

  const archive = await post("/admin/products", cookie, {
    intent: "archive",
    productId,
  });
  check("archive redirects", archive.status === 302);
  const archived = await prisma.product.findUnique({ where: { id: productId } });
  check("product archived + deactivated", archived?.isArchived === true && archived?.isActive === false);

  const auditCount = await prisma.auditLog.count({
    where: { entityType: "Product", entityId: productId },
  });
  check("audit events recorded for product", auditCount >= 3, `${auditCount} events`);

  await prisma.product.deleteMany({ where: { sku: SKU } });

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
