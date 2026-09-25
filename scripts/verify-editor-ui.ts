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
import bcrypt from "bcryptjs";
import { ADMIN_SESSION_COOKIE } from "~/utils/adminAuth.server";
import { publicationReadiness } from "~/services/publication.server";
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

/**
 * Sign in, as the harness's throwaway owner by default or as an account this
 * suite made for itself. The role checks further down need two people at once,
 * and the harness provides exactly one — so the second account is created here
 * and removed in the cleanup, which is the same rule the harness states for
 * every other precondition: the suite's fixtures are its own.
 */
async function login(asEmail = EMAIL, asPassword = PASSWORD): Promise<string> {
  const res = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ email: asEmail, password: asPassword }),
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
 * A POST that can repeat a field. `Record<string, string>` cannot express the
 * list fields, and a form with two boxes named `features` is the whole point of
 * them — a helper that silently sent only the last value would make every check
 * about ordering pass for the wrong reason.
 */
async function postMulti(path: string, cookie: string, data: [string, string][]) {
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

/** How many controls in this page submit under one name. */
function countNamed(html: string, name: string): number {
  return (html.match(new RegExp(`name="${name}"`, "g")) ?? []).length;
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
      // Two stored lines, so the editor has to draw two boxes rather than one
      // textarea: that is the whole of the owner's request, in one assertion.
      features: "Keeps cool for up to 8 hours\nMachine-washable cover",
      materials: "Organic cotton",
      variants: {
        create: [
          {
            name: "One size",
            sku: `${CODE}-1`,
            wholesalePrice: 1000,
            suggestedRetailPrice: 2000,
            isDefault: true,
            // A choice for the seller to make, which is what puts this
            // product's cartons on its variants. The variant editor this
            // section is about is the one a product sold in choices gets;
            // without the pair the page would (correctly) point at the
            // Shipping tab instead, and the suite would be measuring its own
            // fixture rather than the application.
            variantOptions: { create: [{ name: "Size", value: "One size", sortOrder: 0 }] },
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
    /**
     * The family is given a description before the packaging rows are read, and
     * it is given it here rather than through the form above on purpose: the
     * carton default is seeded FROM this value, so a check that ran against a
     * blank one would pass on a row that was never seeded at all. The form's own
     * description handling is checked by the save-and-read-back above it.
     */
    const FAMILY_DESCRIPTION = "Written by verify-editor-ui.";
    await prisma.product.update({
      where: { id: product.id },
      data: { description: FAMILY_DESCRIPTION },
    });
    const variants = await get(`/admin/products/${product.id}?tab=variants`, cookie);
    const dimTag = tagWithAttribute(variants.html, 'name="pkg_dimUnit"');
    const weightTag = tagWithAttribute(variants.html, 'name="pkg_weightUnit"');
    /**
     * The unit is no longer chosen on the row. It is the admin's, set once on
     * the Settings page, and what the row submits instead is the unit its
     * numbers are STORED in — which for a row that has never been saved is the
     * admin's unit, carried on a hidden field rather than shown as a chooser.
     *
     * This clone has never chosen, so the global unit is the default and the
     * hidden fields say "in" and "lb".
     */
    check(
      "A new carton takes its unit from the admin setting, not from a chooser on the row",
      dimTag.startsWith("<input") &&
        /type="hidden"/.test(dimTag) &&
        /value="in"/.test(dimTag) &&
        weightTag.startsWith("<input") &&
        /type="hidden"/.test(weightTag) &&
        /value="lb"/.test(weightTag),
      `${dimTag.slice(0, 50)} / ${weightTag.slice(0, 50)}`
    );
    /**
     * And the row says which unit it is being SHOWN in, because the two can
     * differ: this row's numbers may be stored in centimetres while the page
     * reads in inches, and the submit handler needs the second one to translate
     * the figures the operator did not touch.
     */
    check(
      "The row records the unit it is shown in, and is marked as a packaging row",
      /data-pkg-row="0"[^>]*data-global-dim="in"/.test(variants.html) &&
        /data-pkg-row="0"[^>]*data-global-weight="lb"/.test(variants.html)
    );
    const packSelect = tagWithAttribute(variants.html, 'name="pkg_presetId"');
    check(
      "And chooses its box from a saved pack rather than typing the numbers",
      packSelect.startsWith("<select"),
      packSelect.slice(0, 60)
    );
    /**
     * The form states how many carton rows it drew. That number is what tells
     * an operator who removed every carton from a page whose cartons never
     * arrived — the two submits are identical otherwise, and the second one used
     * to delete the packaging it could not see.
     */
    const rowCountTag = tagWithAttribute(variants.html, 'name="pkg_rowCount"');
    check(
      "The form says how many carton rows it drew, so an empty submit is not read as a wipe",
      rowCountTag.startsWith("<input") &&
        /type="hidden"/.test(rowCountTag) &&
        /value="\d+"/.test(rowCountTag),
      rowCountTag.slice(0, 60)
    );

    /**
     * A BRAND-NEW CARTON ROW ARRIVES ALREADY SAYING SOMETHING.
     *
     * An empty label beside "Carton 1" tells the next person nothing, and the
     * packing list three months later reads "Box" for a carton that was
     * obviously the pillow. The row starts from facts that are already true —
     * the variant it belongs to, and the family's description — and both stay
     * editable, which the check after the save proves, because a default that
     * came back over a typed label would be worse than a blank one.
     */
    const labelTag = tagWithAttribute(variants.html, 'name="pkg_label"');
    const descriptionTag = tagWithAttribute(variants.html, 'name="pkg_description"');
    check(
      "A new carton row is named after the variant it belongs to",
      /value="One size"/.test(labelTag),
      labelTag.slice(0, 90)
    );
    check(
      "And described with the family's description",
      descriptionTag.includes(`value="${FAMILY_DESCRIPTION}"`),
      descriptionTag.slice(0, 90)
    );

    /**
     * ONE PACKAGING EDITOR PER SELLABLE CONFIGURATION, AS THE PAGE DRAWS IT.
     *
     * This product's sellers choose a size, so its cartons belong to the
     * variants and the Shipping tab must not offer a second, product-level
     * answer to a question already answered above — a fallback nobody is
     * looking at is the one that would be quoted. The check is on the rendered
     * control, not on a prop: a card that is merely hidden by CSS would still
     * be submitted by a browser.
     */
    const shipping = await get(`/admin/products/${product.id}?tab=shipping`, cookie);
    check(
      "A product sold in choices draws no product-level carton editor at all",
      tagWithAttribute(shipping.html, 'name="pkg_label"') === "" &&
        tagWithAttribute(shipping.html, 'name="pkg_description"') === "",
      tagWithAttribute(shipping.html, 'name="pkg_label"').slice(0, 60)
    );
    check(
      "And the page says where the cartons are instead, rather than leaving a gap",
      /Variants tab/.test(shipping.html),
      "the notice names the tab that owns them"
    );

    /**
     * THE OTHER HALF OF THE RULE, on a product with nothing for the seller to
     * choose. It is a second product because the two shapes are mutually
     * exclusive: one page draws the editor and the other must not, and a single
     * fixture cannot be both at once.
     */
    const simple = await prisma.product.create({
      data: {
        name: "Verify Editor UI Simple",
        productCode: `${CODE}-SIMPLE`,
        category: "Bedding",
        currency: "CAD",
        description: FAMILY_DESCRIPTION,
        variants: {
          create: [
            { name: "One size", sku: `${CODE}-SIMPLE-1`, wholesalePrice: 1000, suggestedRetailPrice: 2000, isDefault: true },
          ],
        },
      },
      include: { variants: true },
    });
    try {
      const simpleShipping = await get(`/admin/products/${simple.id}?tab=shipping`, cookie);
      const simpleLabel = tagWithAttribute(simpleShipping.html, 'name="pkg_label"');
      check(
        "A product with no choice for the seller keeps its one carton editor on the Shipping tab",
        simpleLabel.startsWith("<input") && /value="Verify Editor UI Simple"/.test(simpleLabel),
        simpleLabel.slice(0, 90)
      );
      check(
        "And it is described the same way a new row anywhere is",
        tagWithAttribute(simpleShipping.html, 'name="pkg_description"').includes(
          `value="${FAMILY_DESCRIPTION}"`
        ),
        tagWithAttribute(simpleShipping.html, 'name="pkg_description"').slice(0, 90)
      );
      const simpleVariants = await get(`/admin/products/${simple.id}?tab=variants`, cookie);
      check(
        "And the Variants tab draws no per-variant editor for it, but names the tab that has one",
        tagWithAttribute(simpleVariants.html, 'name="pkg_label"') === "" &&
          /Shipping tab/.test(simpleVariants.html),
        tagWithAttribute(simpleVariants.html, 'name="pkg_label"').slice(0, 60)
      );
    } finally {
      await prisma.productVariant.deleteMany({ where: { productId: simple.id } });
      await prisma.product.deleteMany({ where: { id: simple.id } });
    }

    await post(`/admin/products/${product.id}`, cookie, {
      intent: "save_packaging",
      tab: "variants",
      variantId: variant.id,
      // The count a browser sends with this one row. Stating it is what lets a
      // submit that arrives with no rows be told from a page that had none: the
      // save is a whole-set replace, so the two are the same request otherwise,
      // and the second one is how a variant silently lost its packaging.
      pkg_rowCount: "1",
      // Deliberately NOT the default: the reload check below proves the typed
      // label is what came back.
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
    /**
     * The default is a starting point, not a decision. A saved row that carried
     * a typed label comes back with the typed label — the check that fails if
     * the default is ever applied to a row that already exists.
     */
    const reloadedLabel = tagWithAttribute(afterPackaging.html, 'name="pkg_label"');
    check(
      "A saved row keeps the label somebody typed, rather than reverting to the default",
      /value="Carton"/.test(reloadedLabel) && !/value="One size"/.test(reloadedLabel),
      reloadedLabel.slice(0, 90)
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
    /* Features and materials: a list, not a paragraph                      */
    /* ------------------------------------------------------------------ */
    const boxes = countNamed(details.html, "features");
    check(
      "Each stored feature gets its own box",
      boxes === 2,
      `${boxes} box(es) for two stored lines`
    );
    check(
      "And its own remove control, with a way to add a third",
      /Remove features 1/.test(details.html) && /Add another/.test(details.html),
      "a list that cannot grow is a textarea with extra steps"
    );
    check(
      "Materials are drawn the same way",
      countNamed(details.html, "materials") === 1 && /Add material/.test(details.html)
    );

    await postMulti(`/admin/products/${product.id}`, cookie, [
      ["intent", "update_details"],
      ["tab", "details"],
      ["name", "Verify Editor UI"],
      ["productCode", CODE],
      ["category", "Clothing"],
      ["category_new", ""],
      ["currency", "CAD"],
      ["currency_new", ""],
      ["description", "Written by verify-editor-ui."],
      ["features", "Cool for eight hours"],
      ["features", "Washable cover"],
      ["materials", "Organic cotton"],
    ]);
    const afterTwoBoxes = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "Two boxes are stored as two lines, in the order they were filled in",
      afterTwoBoxes?.features === "Cool for eight hours\nWashable cover",
      JSON.stringify(afterTwoBoxes?.features)
    );

    // Somebody pasting a whole list into the first box should get a list, not
    // one very long feature.
    await postMulti(`/admin/products/${product.id}`, cookie, [
      ["intent", "update_details"],
      ["tab", "details"],
      ["name", "Verify Editor UI"],
      ["productCode", CODE],
      ["category", "Clothing"],
      ["category_new", ""],
      ["currency", "CAD"],
      ["currency_new", ""],
      ["features", "Cool for eight hours\nWashable cover\nNo chemical coolants"],
      ["materials", "Organic cotton"],
    ]);
    const afterPaste = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "A pasted list splits on its own line breaks",
      afterPaste?.features === "Cool for eight hours\nWashable cover\nNo chemical coolants",
      JSON.stringify(afterPaste?.features)
    );

    await postMulti(`/admin/products/${product.id}`, cookie, [
      ["intent", "update_details"],
      ["tab", "details"],
      ["name", "Verify Editor UI"],
      ["productCode", CODE],
      ["category", "Clothing"],
      ["category_new", ""],
      ["currency", "CAD"],
      ["currency_new", ""],
      ["features", "Only this one"],
      ["features", "   "],
      ["materials", "   "],
    ]);
    const afterBlank = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "An empty box adds nothing, so a blank row cannot become a blank feature",
      afterBlank?.features === "Only this one" && afterBlank?.materials === null,
      `${JSON.stringify(afterBlank?.features)} / ${JSON.stringify(afterBlank?.materials)}`
    );

    /* ------------------------------------------------------------------ */
    /* The catalogue list                                                    */
    /* ------------------------------------------------------------------ */
    const list = await get("/admin/products", cookie);
    check(
      "The list says what its media column counts",
      /variants with pictures/.test(list.html) && list.html.includes(CODE)
    );

    /* ------------------------------------------------------------------ */
    /* Delete, and the reason it stopped working                             */
    /* ------------------------------------------------------------------ */
    /**
     * Delete failed for the owner while its neighbours worked. The action was
     * fine — it was the browser dialog in front of it: once Chrome is told to
     * "prevent this page from creating additional dialogs", every later
     * `confirm()` returns false without being shown, so the button is dead and
     * nothing on the page explains why. The guard is therefore about the page:
     * a Delete that depends on `confirm()` will pass every server-side check
     * and still be broken.
     */
    check(
      "Delete does not depend on a browser dialog",
      !list.html.includes("confirm("),
      "a suppressed confirm() is a dead button that reports nothing"
    );
    check(
      "Delete is a button in the row that cannot submit until it is armed",
      (() => {
        // The arming press is client-side, so the server's HTML holds the first
        // state: a `type="button"` that submits nothing. If it came back as a
        // submit button, a stray Enter would delete a product.
        const at = list.html.indexOf(">Delete</button>");
        if (at === -1) return false;
        const tag = list.html.slice(list.html.lastIndexOf("<button", at), at);
        return /type="button"/.test(tag);
      })(),
      "the second press is the one that deletes"
    );

    const doomed = await prisma.product.create({
      data: {
        name: "Verify Delete Me",
        productCode: `${CODE}-DEL`,
        category: "Clothing",
        currency: "CAD",
        variants: {
          create: [{ name: "One size", sku: `${CODE}-DEL-1`, wholesalePrice: 100, suggestedRetailPrice: 200, isDefault: true }],
        },
      },
      include: { variants: true },
    });
    const deleteRes = await post("/admin/products", cookie, {
      intent: "delete",
      productId: doomed.id,
      returnTo: "/admin/products",
    });
    const gone = await prisma.product.findUnique({ where: { id: doomed.id } });
    check(
      "Deleting a product actually deletes it",
      deleteRes.status === 302 && gone === null,
      `HTTP ${deleteRes.status}, ${gone ? "still there" : "row gone"}`
    );

    // And the page says so, rather than silently re-rendering an identical list.
    const afterDelete = await get("/admin/products?done=delete", cookie);
    check(
      "And the list says what happened",
      /Deleted\./.test(afterDelete.html)
    );

    await prisma.variantPackage.deleteMany({ where: { variantId: doomed.variants[0].id } });
    await prisma.productVariant.deleteMany({ where: { productId: doomed.id } });
    await prisma.product.deleteMany({ where: { id: doomed.id } });

    /* ------------------------------------------------------------------ */
    /* Publishing is a permission, not a stage                              */
    /* ------------------------------------------------------------------ */

    /**
     * Two accounts, two roles, one product — because the question is not "does
     * Publish work" but "who does it work for", and a single signed-in person
     * cannot answer that.
     *
     * The product starts deliberately UNPUBLISHABLE. The first half of this
     * section is therefore about the gate refusing everyone, including the
     * owner: a permission that lets a person press a button is worthless if the
     * button ignores the readiness checks. Only once the product is made ready
     * does the role difference become visible at all.
     */
    const detailsBeforeReady = await get(`/admin/products/${product.id}?tab=details`, cookie);
    check(
      "A product with no image is told what it is missing, next to Publish",
      detailsBeforeReady.html.includes("At least one approved, seller-visible image") &&
        detailsBeforeReady.html.includes("Publish to sellers"),
      "the requirement and the control are on the same screen"
    );

    const ownerBlocked = await post(`/admin/products/${product.id}`, cookie, {
      intent: "publish",
      tab: "details",
    });
    const stillDraft = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "The owner is refused too while the product is not ready",
      ownerBlocked.status !== 302 && stillDraft?.status === "DRAFT",
      `HTTP ${ownerBlocked.status}, status ${stillDraft?.status}`
    );
    check(
      "And the refusal names the requirement rather than saying no",
      (await ownerBlocked.text()).includes("approved, seller-visible image"),
      "a refusal that does not say what to fix is a dead end"
    );

    // Make it publishable: a description, an approved seller-visible image with
    // alt text, and that image marked primary. Written directly, because the
    // media forms have their own suite and a failure there would be reported
    // here as the wrong defect.
    await prisma.product.update({
      where: { id: product.id },
      data: { description: "Written by verify-editor-ui." },
    });
    const image = await prisma.mediaAsset.create({
      data: {
        productId: product.id,
        category: "WHITE_BACKGROUND_IMAGE",
        title: "Verify Editor UI image",
        altText: "A pillow on a white background.",
        originalFilename: "verify-editor-ui.png",
        storageKey: `verify-editor-ui/${Date.now()}.png`,
        mimeType: "image/png",
        fileSize: 1024,
        checksum: `verify-editor-ui-${Date.now()}`,
        processingStatus: "READY",
        approvalStatus: "APPROVED",
        sellerVisible: true,
        assignments: { create: [{ variantId: null, isPrimary: true }] },
      },
    });
    const readyNow = await publicationReadiness(product.id);
    check(
      "The fixture is now publishable, so what follows is about permission",
      readyNow.ready,
      readyNow.blockers.map((blocker) => blocker.label).join("; ") || "ready"
    );

    const publishControl = (html: string) =>
      countNamed(html, "intent") > 0 && /value="publish"/.test(html);
    const withdrawControl = (html: string) => /value="unpublish"/.test(html);

    // A CATALOG account, made here and removed in the cleanup below. The hash
    // comes from the same bcrypt the app verifies with, so it cannot drift.
    const catalogEmail = `verify-catalog-${Date.now()}@mvverify.invalid`;
    const catalogPassword = `MvCatalog-${Math.random().toString(36).slice(2)}${Math.random()
      .toString(36)
      .slice(2)}`;
    const catalog = await prisma.adminUser.create({
      data: {
        email: catalogEmail,
        name: "Verify Catalog",
        role: "CATALOG",
        passwordHash: bcrypt.hashSync(catalogPassword, 12),
        emailVerifiedAt: new Date(),
      },
    });
    const catalogCookie = await login(catalogEmail, catalogPassword);
    check(
      "A catalogue-role account can sign in",
      catalogCookie.includes(ADMIN_SESSION_COOKIE),
      "the role that prepares the record"
    );

    const ownerList = await get("/admin/products", cookie);
    const catalogList = await get("/admin/products", catalogCookie);
    check(
      "The product list offers the owner a publish control",
      publishControl(ownerList.html),
      "the control exists — the difference below is the role"
    );
    check(
      "And offers the catalogue role none at all",
      !publishControl(catalogList.html) && !withdrawControl(catalogList.html),
      "a button that always answers 403 is worse than no button"
    );

    const catalogEditor = await get(`/admin/products/${product.id}?tab=details`, catalogCookie);
    check(
      "The catalogue role still gets the whole editor",
      catalogEditor.status === 200 && catalogEditor.html.includes("Save draft"),
      `HTTP ${catalogEditor.status}`
    );
    check(
      "But no Publish button on it",
      !publishControl(catalogEditor.html),
      "writing the record and releasing it are different decisions"
    );
    check(
      "And is told who does publish it, rather than left to guess",
      catalogEditor.html.includes("an owner or administrator releases it to sellers"),
      "the sentence that replaces the approval step"
    );

    const catalogPublish = await post(`/admin/products/${product.id}`, catalogCookie, {
      intent: "publish",
      tab: "details",
    });
    const afterCatalogPublish = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "A posted publish from the catalogue role is refused, not merely unrendered",
      catalogPublish.status !== 302 && afterCatalogPublish?.status === "DRAFT",
      `HTTP ${catalogPublish.status}, status ${afterCatalogPublish?.status}`
    );
    check(
      "And says why in the role's own terms",
      (await catalogPublish.text()).includes("does not permit publishing"),
      "hiding the button is a convenience; this is the control"
    );

    const ownerEditor = await get(`/admin/products/${product.id}?tab=details`, cookie);
    check(
      "The owner sees Publish on the same product",
      publishControl(ownerEditor.html),
      "same product, same page, different role"
    );

    const ownerPublish = await post(`/admin/products/${product.id}`, cookie, {
      intent: "publish",
      tab: "details",
    });
    const published = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "The owner's press publishes it",
      ownerPublish.status === 302 && published?.status === "PUBLISHED",
      `HTTP ${ownerPublish.status}, status ${published?.status}`
    );
    check(
      "And the flags the seller-facing queries read agree",
      published?.isPublished === true,
      "the gate is what keeps the status and the flag consistent"
    );

    const catalogWithdraw = await post(`/admin/products/${product.id}`, catalogCookie, {
      intent: "unpublish",
      tab: "details",
    });
    const stillPublished = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "Withdrawing is the same permission, and is refused the same way",
      catalogWithdraw.status !== 302 && stillPublished?.status === "PUBLISHED",
      `HTTP ${catalogWithdraw.status}, status ${stillPublished?.status}`
    );

    // The retired state must not come back through the editor: the field is
    // gone from the form, but a hand-made POST is the thing worth refusing.
    const parkAttempt = await post(`/admin/products/${product.id}`, cookie, {
      intent: "update_details",
      tab: "details",
      name: "Verify Editor UI",
      productCode: CODE,
      category: "Bedding",
      currency: "CAD",
      status: "PENDING_APPROVAL",
    });
    const afterPark = await prisma.product.findUnique({ where: { id: product.id } });
    check(
      "A hand-made POST cannot park a product in the retired approval state",
      parkAttempt.status !== 500 && afterPark?.status === "PUBLISHED",
      `HTTP ${parkAttempt.status}, status ${afterPark?.status}`
    );

    await prisma.mediaAssetAssignment.deleteMany({ where: { assetId: image.id } });
    await prisma.mediaAsset.deleteMany({ where: { id: image.id } });
    await prisma.adminSession.deleteMany({ where: { userId: catalog.id } });
    await prisma.adminUser.deleteMany({ where: { id: catalog.id } });
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
