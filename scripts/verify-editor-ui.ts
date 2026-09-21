/**
 * The product editor's forms, over HTTP, against the running app.
 *
 * WHY THIS EXISTS SEPARATELY. `verify-product-system.ts` proves the model: that
 * the services refuse what they should refuse and store what they should store.
 * It cannot see a form. Two of the interface's promises are not about the model
 * at all — that a merchant can add a category the list does not know, and that
 * the carton measurements they type in inches are stored as centimetres — and
 * both fail silently. A wrong default does not throw; it writes 25.4 instead of
 * 10 and the error surfaces as a shipping quote weeks later.
 *
 * So every check here drives a real screen and then reads the database back.
 * What it asserts is the whole path a merchant's typing takes: form, action,
 * service, column.
 *
 * IT NEEDS A RUNNING SERVER AND AN ADMIN ACCOUNT. The throwaway OWNER account
 * is made by the harness that calls this (see `docker/verify-http.sh` in the
 * deployment notes), not here — the owner's own password is never read, asked
 * for or stored.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-editor-ui.ts
 */
import { PrismaClient } from "@prisma/client";
import { ADMIN_SESSION_COOKIE } from "~/utils/adminAuth.server";
// The same conversion the packing screen applies to a stored carton, so the
// check is about the application's arithmetic rather than a copy of it.
import { toCm, toKg } from "~/services/packaging.server";

const prisma = new PrismaClient();
const BASE = process.env.APP_BASE || "http://localhost:62259";
const EMAIL = process.env.OWNER_EMAIL || "";
const PASSWORD = process.env.OWNER_PASSWORD || "";
const CODE = `VERIFY-UI-${Date.now()}`;

let failures = 0;
let total = 0;

/** Numbered like the acceptance suite: a check cannot be dropped unnoticed. */
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${total}. ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
  });
  const cookies: string[] =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function get(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, html: await res.text() };
}

async function post(path: string, cookie: string, data: Record<string, string>) {
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

/**
 * The attributes of the tag carrying this id, for asserting on the markup a
 * browser would actually receive rather than on the source that produced it.
 */
function tagById(html: string, id: string): string {
  const index = html.indexOf(`id="${id}"`);
  if (index === -1) return "";
  const start = html.lastIndexOf("<", index);
  const end = html.indexOf(">", index);
  return start === -1 || end === -1 ? "" : html.slice(start, end + 1);
}

/** An attribute-tag search that does not depend on where in the page it sits. */
function tagWithAttribute(html: string, attribute: string): string {
  const index = html.indexOf(attribute);
  if (index === -1) return "";
  const start = html.lastIndexOf("<", index);
  const end = html.indexOf(">", index);
  return start === -1 || end === -1 ? "" : html.slice(start, end + 1);
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Set OWNER_EMAIL and OWNER_PASSWORD.");
    process.exit(1);
  }

  const cookie = await login();
  check(
    "The throwaway owner can sign in, and the cookie is the app's own",
    cookie.includes(ADMIN_SESSION_COOKIE),
    cookie ? "session issued" : "no cookie"
  );

  // A family with one variant, made directly: these checks are about editing,
  // and a failure to create would be reported as the wrong defect.
  const product = await prisma.product.create({
    data: {
      name: "Verify Editor UI",
      productCode: CODE,
      // Deliberately not one of the offered categories: it is the value the
      // editor must show rather than reset.
      category: "Bedding",
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
    include: { variants: true },
  });
  const variant = product.variants[0];

  try {
    /* ------------------------------------------------------------------ */
    /* Category and currency are chosen, not typed                          */
    /* ------------------------------------------------------------------ */
    const details = await get(`/admin/products/${product.id}?tab=details`, cookie);
    check("The editor loads", details.status === 200, `HTTP ${details.status}`);

    const categorySelect = tagById(details.html, "d-category");
    const categoryNew = tagById(details.html, "d-category-new");
    const currencySelect = tagById(details.html, "d-currency");
    const currencyNew = tagById(details.html, "d-currency-new");

    check(
      "Category is offered as a list rather than as free text",
      categorySelect.startsWith("<select") && categorySelect.includes('name="category"'),
      categorySelect.slice(0, 60)
    );
    check(
      "The common categories are among the options",
      ["Clothing", "Accessories", "Home &amp; Garden", "Sports", "Electronics", "Other"].every(
        (category) => details.html.includes(category)
      )
    );
    check(
      "A new category can still be added without a redeploy",
      categoryNew.startsWith("<input") && categoryNew.includes('name="category_new"'),
      categoryNew.slice(0, 60)
    );
    check(
      "Currency is a list with the same escape hatch",
      currencySelect.startsWith("<select") &&
        currencyNew.includes('name="currency_new"') &&
        ["CAD", "USD", "EUR", "GBP", "AUD", "CHF"].every((code) => details.html.includes(code))
    );
    check(
      "The product's own category is the one shown, not the first option",
      /value="Bedding"[^>]*selected/.test(details.html),
      "a category outside the list must survive the round trip"
    );

    /* ------------------------------------------------------------------ */
    /* The override rule                                                    */
    /* ------------------------------------------------------------------ */
    await post(`/admin/products/${product.id}`, cookie, {
      intent: "update_details",
      tab: "details",
      name: "Verify Editor UI",
      productCode: CODE,
      category: "Clothing",
      category_new: "Bedding",
      currency: "CAD",
      currency_new: "nzd",
      description: "Written by verify-editor-ui.",
    });
    const afterOverride = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "Typing a new category overrides the list, and is what is stored",
      afterOverride?.category === "Bedding",
      `stored "${afterOverride?.category}"`
    );
    check(
      "The same rule applies to currency, normalised",
      afterOverride?.currency === "NZD",
      `stored "${afterOverride?.currency}"`
    );

    await post(`/admin/products/${product.id}`, cookie, {
      intent: "update_details",
      tab: "details",
      name: "Verify Editor UI",
      productCode: CODE,
      category: "Clothing",
      category_new: "",
      currency: "USD",
      currency_new: "",
    });
    const afterList = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "An empty box leaves the list's answer alone",
      afterList?.category === "Clothing" && afterList?.currency === "USD",
      `${afterList?.category} / ${afterList?.currency}`
    );

    /* ------------------------------------------------------------------ */
    /* Carton measurements                                                   */
    /* ------------------------------------------------------------------ */
    const variants = await get(`/admin/products/${product.id}?tab=variants`, cookie);
    const dimTag = tagWithAttribute(variants.html, 'name="pkg_dimUnit"');
    const weightTag = tagWithAttribute(variants.html, 'name="pkg_weightUnit"');
    const dims = variants.html.slice(
      variants.html.indexOf('name="pkg_dimUnit"') - 300,
      variants.html.indexOf('name="pkg_dimUnit"') + 300
    );
    const weights = variants.html.slice(
      variants.html.indexOf('name="pkg_weightUnit"') - 300,
      variants.html.indexOf('name="pkg_weightUnit"') + 300
    );
    check(
      "A new carton offers inches and pounds first",
      dims.indexOf('value="in"') !== -1 &&
        dims.indexOf('value="in"') < dims.indexOf('value="cm"') &&
        weights.indexOf('value="lb"') !== -1 &&
        weights.indexOf('value="lb"') < weights.indexOf('value="kg"'),
      `${dimTag.slice(0, 40)} / ${weightTag.slice(0, 40)}`
    );

    await post(`/admin/products/${product.id}`, cookie, {
      intent: "save_packaging",
      tab: "variants",
      variantId: variant.id,
      pkg_label: "Carton",
      pkg_packageType: "carton",
      pkg_presetId: "",
      pkg_length: "10",
      pkg_width: "8",
      pkg_height: "6",
      pkg_dimUnit: "in",
      pkg_weight: "5",
      pkg_weightUnit: "lb",
      pkg_unitsPerPackage: "1",
      pkg_packagesPerUnit: "1",
    });
    /**
     * A carton is stored as the number the merchant typed *and* the unit they
     * chose — `10` and `in`, not `25.4` and a remembered "was inches". The
     * conversion to canonical centimetres belongs to whoever reads it for a
     * quote, so that is where it is asserted: a save that converted here and a
     * quote that converted again would double the length of every parcel.
     */
    const stored = await prisma.variantPackage.findFirst({ where: { variantId: variant.id } });
    check(
      "A carton entered in inches and pounds keeps its unit beside the number",
      !!stored &&
        stored.dimensionUnit === "in" &&
        stored.weightUnit === "lb" &&
        Math.abs(stored.length - 10) < 0.01 &&
        Math.abs(stored.width - 8) < 0.01 &&
        Math.abs(stored.height - 6) < 0.01 &&
        Math.abs(stored.grossWeight - 5) < 0.01,
      stored
        ? `${stored.length} × ${stored.width} × ${stored.height} ${stored.dimensionUnit}, ${stored.grossWeight} ${stored.weightUnit}`
        : "no row written"
    );
    check(
      "And the conversion a shipping quote applies is right",
      !!stored &&
        Math.abs(toCm(stored.length, stored.dimensionUnit) - 25.4) < 0.01 &&
        Math.abs(toKg(stored.grossWeight, stored.weightUnit) - 2.268) < 0.01,
      stored
        ? `${toCm(stored.length, stored.dimensionUnit)} cm, ${toKg(stored.grossWeight, stored.weightUnit)} kg`
        : "no row to convert"
    );
    const afterPackaging = await get(`/admin/products/${product.id}?tab=variants`, cookie);
    check(
      "The editor then shows the carton in the units it was entered in",
      /10 × 8 × 6 in, 5 lb/.test(afterPackaging.html)
    );

    /* ------------------------------------------------------------------ */
    /* Alt text                                                             */
    /* ------------------------------------------------------------------ */
    const media = await get(`/admin/products/${product.id}?tab=media`, cookie);
    const altInput = tagById(media.html, "m-alt");
    check(
      "The upload form will not submit an image without alt text",
      altInput.startsWith("<input") && /\brequired\b/.test(altInput),
      altInput.slice(0, 80)
    );
    check("And says so in the label", /Alt text \*/.test(media.html));
    check(
      "The Media tab separates coverage from the publication checks",
      /Coverage and publication are two different questions/.test(media.html)
    );

    /* ------------------------------------------------------------------ */
    /* The catalogue list                                                    */
    /* ------------------------------------------------------------------ */
    const list = await get("/admin/products", cookie);
    check(
      "The list says what its media column counts",
      /variants with pictures/.test(list.html) && list.html.includes(CODE)
    );
  } finally {
    // Audit rows are append-only at the database level and are deliberately
    // left behind; everything else this suite made goes.
    await prisma.variantPackage.deleteMany({ where: { variantId: variant.id } });
    await prisma.productVariant.deleteMany({ where: { productId: product.id } });
    await prisma.product.deleteMany({ where: { id: product.id } });
    await prisma.$disconnect();
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
