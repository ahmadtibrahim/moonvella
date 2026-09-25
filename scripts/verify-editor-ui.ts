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
// The verdict seed is the same helper the booking suites use, so a fixture
// written here cannot disagree with the gate about what "current" means.
import { recordVerdict } from "./verify-address-fixtures";
// The server-side Google key, read the way the application reads it, so the
// check that it never reaches a page is about the value that actually resolves
// rather than about a column that might be empty.
import { SERVER_KEY_FIELD } from "~/services/addressValidation.server";
import { getCredential } from "~/services/credentials.server";
// The same conversion the packing screen applies to a stored carton, so the
// check is about the application's arithmetic rather than a copy of it.
import { toCm, toKg } from "~/services/packaging.server";

const prisma = new PrismaClient();
const BASE = process.env.APP_BASE || "http://localhost:62259";
const EMAIL = process.env.OWNER_EMAIL || "";
const PASSWORD = process.env.OWNER_PASSWORD || "";
const CODE = `VERIFY-UI-${Date.now()}`;
// The pickup-location fixture's code, declared out here so the cleanup in the
// `finally` can find it even when a check above it threw.
const DOCK_CODE = `VERIFY-UI-DOCK-${Date.now().toString(36).toUpperCase()}`;

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

/*
 * Two real PNGs, one pixel each and deliberately different pictures.
 *
 * The upload path measures the image from its own header and refuses a file
 * whose contents do not match the type the form declared, so a fixture has to
 * be a genuine image rather than a buffer with a .png name. They differ because
 * the same bytes uploaded twice is a duplicate on the same product, whatever
 * the title says — that refusal has its own check in the product system suite,
 * and a fixture that tripped it here would report it as the wrong defect.
 */
const TINY_PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4IScHRAwQCgAfJgQRoo8irwAAAABJRU5ErkJggg==",
  "base64"
);
const TINY_PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGOQszkBQQxYWACTEgozKdnjIQAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * Post the media form the way a browser does — multipart, with a file — because
 * the path from the control to the row is the thing under test, and a JSON post
 * would start after the part that breaks.
 */
async function uploadMediaForm(
  productId: string,
  cookie: string,
  input: {
    fields: Record<string, string>;
    file: { name: string; type: string; bytes: Buffer };
  }
) {
  const body = new FormData();
  for (const [key, value] of Object.entries(input.fields)) body.append(key, value);
  body.append(
    "file",
    new Blob([new Uint8Array(input.file.bytes)], { type: input.file.type }),
    input.file.name
  );
  return fetch(`${BASE}/admin/products/${productId}`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: BASE, Cookie: cookie },
    body,
  });
}

/**
 * The words that would mean an approval step had come back.
 *
 * Matched as markup rather than as prose: a sentence explaining that an
 * administrator no longer approves their own upload is not a control, and a
 * check that failed on it would be failing on the comment that documents the
 * change.
 */
const MODERATION_CONTROLS = [
  'value="media_approve"',
  'value="media_reject"',
  'value="media_pending_approval"',
  ">Approve<",
  ">Reject<",
];

/**
 * The address panel belonging to one record, out of a page that draws one for
 * every location it lists.
 *
 * Each card names its own subject in a hidden field, and each begins with the
 * same heading, so the slice runs from this card's heading to the next one's.
 * Reading the whole page instead is how a check passes on a neighbour's
 * evidence: "there is an Apply button on this screen" is true of the page and
 * false of the record under test.
 */
function cardFor(html: string, subjectId: string): string {
  const starts = [...html.matchAll(/>Address check<\/strong>/g)].map((match) => match.index ?? -1);
  for (let index = 0; index < starts.length; index += 1) {
    const slice = html.slice(starts[index], starts[index + 1] ?? html.length);
    if (slice.includes(`name="subjectId" value="${subjectId}"`)) return slice;
  }
  return "";
}

/**
 * The verdict chip an address panel is showing, for a failure message that says
 * which verdict was rendered rather than only that the expected words were
 * absent.
 */
function verdictOnPanel(card: string): string {
  const match = card.match(/Address check<\/strong><span style="[^"]*">([^<]+)<\/span>/);
  return match?.[1] ?? "(no verdict chip found in this dock's panel)";
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
      detailsBeforeReady.html.includes("At least one active, seller-visible product image") &&
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
      (await ownerBlocked.text()).includes("active, seller-visible product image"),
      "a refusal that does not say what to fix is a dead end"
    );

    // Make it publishable: a description, a seller-visible image with alt text,
    // and that image marked primary. Written directly, because the media forms
    // have their own suite and a failure there would be reported here as the
    // wrong defect. The row is written the way an admin upload now arrives —
    // approved, switched on, finished — so this fixture is what the real editor
    // produces rather than a shape nothing writes.
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

    /*
     * THE CONTROL NAMES THE CHANGE IT WOULD MAKE. A page that says Published
     * and offers a button marked Publish is a page asking its reader to guess
     * whether the press is a no-op, a re-publish or a duplicate — and the
     * answer changes what they do next. So the same control is asserted in both
     * directions, and each is asserted on the page whose badge says the state
     * it belongs to.
     */
    const ownerAfterPublish = await get(`/admin/products/${product.id}?tab=details`, cookie);
    check(
      "Once published, the control reads Unpublish rather than Publish",
      withdrawControl(ownerAfterPublish.html) && !publishControl(ownerAfterPublish.html),
      "the label follows the state beside it"
    );

    /*
     * A SECOND PRESS IS NOT A SECOND PUBLICATION. What must not change is the
     * product's state and its media: a re-publish that re-ran an export and
     * attached the image a second time would double the gallery on every
     * impatient click, and the seller would see the same shirt twice. An audit
     * row per press is deliberate and is not counted here — the record of who
     * asked is not a side effect.
     */
    const secondPublish = await post(`/admin/products/${product.id}`, cookie, {
      intent: "publish",
      tab: "details",
    });
    const afterSecond = await prisma.product.findUnique({ where: { id: product.id } });
    const primaryRows = await prisma.mediaAssetAssignment.count({
      where: { asset: { productId: product.id }, isPrimary: true, variantId: null },
    });
    check(
      "A second Publish changes nothing — still published, still one primary, no second copy of the image",
      secondPublish.status === 302 &&
        afterSecond?.status === "PUBLISHED" &&
        afterSecond?.isPublished === true &&
        primaryRows === 1,
      `HTTP ${secondPublish.status}, ${afterSecond?.status}, ${primaryRows} product primary row(s)`
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

    /* ------------------------------------------------------------------ */
    /* Uploading from the Admin Panel, and the scope the file is given      */
    /* ------------------------------------------------------------------ */

    /*
     * TWO PROMISES, DRIVEN THROUGH THE REAL FORM.
     *
     * The first is that an administrator's upload needs no approval: the file
     * arrives finished, switched on and already approved, because asking an
     * administrator to approve the file they just chose themselves is the same
     * person pressing a second button. The failure this guards against is not
     * loud — a row that landed DRAFT looks healthy on the media tab and simply
     * never reaches a seller, and the "product image" check keeps refusing the
     * product for a reason nobody can see on the tab they are looking at.
     *
     * The second is that the scope radio decides what the file belongs to: a
     * general upload is a claim by the product family with no variant on it,
     * and a variant upload is a claim by the size(s) ticked. Getting that
     * backwards is how one size's photograph ends up in every other size's
     * gallery.
     *
     * The bytes are real PNGs, because the upload path reads the header to
     * measure the image and refuses a file whose contents do not match what it
     * declared — a fixture that skipped that would be testing a path no browser
     * can reach. Two different pictures, because the same bytes twice is a
     * duplicate and is refused by design.
     */
    const mediaBefore = await get(`/admin/products/${product.id}?tab=media`, cookie);
    const moderation = MODERATION_CONTROLS.filter((needle) => mediaBefore.html.includes(needle));
    check(
      "The media tab offers no Approve and no Reject — there is no moderation step left to press",
      moderation.length === 0 &&
        mediaBefore.html.includes('value="media_visibility"') &&
        mediaBefore.html.includes(">Edit<"),
      `moderation controls found: ${moderation.join(", ") || "none"}; the actions it offers instead are Edit and Activate/Deactivate`
    );

    const generalUpload = await uploadMediaForm(product.id, cookie, {
      fields: {
        tab: "media",
        intent: "media_upload",
        category: "WHITE_BACKGROUND_IMAGE",
        title: "General upload",
        altText: "One pixel of product, at the family level.",
        scopeMode: "general",
      },
      file: { name: "general.png", type: "image/png", bytes: TINY_PNG_A },
    });
    const generalAsset = await prisma.mediaAsset.findFirst({
      where: { productId: product.id, title: "General upload" },
      include: { assignments: true },
    });
    check(
      "An image uploaded from the Admin Panel arrives READY, switched on and approved, with no second press",
      generalUpload.status === 302 &&
        generalAsset?.processingStatus === "READY" &&
        generalAsset?.sellerVisible === true &&
        generalAsset?.approvalStatus === "APPROVED",
      `HTTP ${generalUpload.status}, ${generalAsset?.processingStatus}/${generalAsset?.approvalStatus}, visible=${generalAsset?.sellerVisible}`
    );
    check(
      "And it is the product family's own image — a general upload is assigned to no variant",
      generalAsset?.assignments.length === 1 && generalAsset.assignments[0].variantId === null,
      `${generalAsset?.assignments.length ?? 0} claim(s), variant=${generalAsset?.assignments[0]?.variantId ?? "none"}`
    );

    const variantUpload = await uploadMediaForm(product.id, cookie, {
      fields: {
        tab: "media",
        intent: "media_upload",
        category: "WHITE_BACKGROUND_IMAGE",
        title: "Size upload",
        altText: "One pixel of product, on one size.",
        scopeMode: "variant",
        scopeVariantIds: variant.id,
      },
      file: { name: "size.png", type: "image/png", bytes: TINY_PNG_B },
    });
    const sizeAsset = await prisma.mediaAsset.findFirst({
      where: { productId: product.id, title: "Size upload" },
      include: { assignments: true },
    });
    check(
      "A variant-specific upload is claimed by the size that was ticked, and is just as ready",
      variantUpload.status === 302 &&
        sizeAsset?.assignments.length === 1 &&
        sizeAsset.assignments[0].variantId === variant.id &&
        sizeAsset?.sellerVisible === true,
      `HTTP ${variantUpload.status}, ${sizeAsset?.assignments.length ?? 0} claim(s) on ${sizeAsset?.assignments[0]?.variantId === variant.id ? "the ticked size" : "the wrong row"}`
    );
    check(
      "And the two uploads did not become each other — the family claim is not on the size",
      generalAsset?.assignments[0]?.variantId === null && sizeAsset?.assignments[0]?.variantId !== null,
      "the radio, not the last file, decides the scope"
    );

    /*
     * THE FILE'S OWN SCREEN, WHICH IS WHERE THE REAL ACTIONS ARE. The tab shows
     * Edit and Activate/Deactivate; the editor behind Edit is where a file is
     * renamed, made primary, detached or deleted — and those four are asserted
     * here because they are what replaced Approve and Reject. The general
     * upload is used rather than the size one: it is the second file in its
     * scope, so it is not already primary, and "Make primary" is on the screen
     * rather than correctly absent.
     */
    const assetEditor = await get(
      `/admin/products/${product.id}?tab=media&asset=${generalAsset?.id ?? ""}`,
      cookie
    );
    const editorModeration = MODERATION_CONTROLS.filter((needle) => assetEditor.html.includes(needle));
    const editorActions = ["media_update", "media_primary", "media_detach"].filter((intent) =>
      assetEditor.html.includes(`value="${intent}"`)
    );
    /*
     * Delete is asserted by its arming button rather than by its submit, which
     * the same control deliberately withholds until it is armed — see the
     * product-list checks above, where the two presses are driven in full. What
     * this check is for is that the file's screen offers the four actions
     * instead of the two that were removed.
     */
    check(
      "The file's own screen offers Edit, Make primary, Detach and Delete — and still no moderation",
      editorModeration.length === 0 &&
        editorActions.length === 3 &&
        assetEditor.html.includes("Delete this file"),
      `moderation controls found: ${editorModeration.join(", ") || "none"}; actions found: ${editorActions.join(", ")}, plus the armed Delete`
    );

    /* ------------------------------------------------------------------ */
    /* The pickup location's hours, through the form a person uses          */
    /* ------------------------------------------------------------------ */

    /*
     * A DOCK WITH NO HOURS IS CREATED FIRST, and it is the case that matters
     * most: the directive is that warehouse hours are never invented, and the
     * way that fails is a form that prefills a plausible window. The check is on
     * the markup a browser receives — an input carrying a value the dock does
     * not have would be a made-up opening time in the control that a carrier's
     * window is read from.
     */
    await post("/admin/origins", cookie, {
      intent: "save_location",
      code: DOCK_CODE,
      name: "Verify UI dock",
      timeZone: "America/Toronto",
    });
    const dock = await prisma.pickupLocation.findFirst({ where: { code: DOCK_CODE } });
    check(
      "A pickup location saves from the form, with no hours recorded",
      dock !== null && dock.pickupOpenTime === null && dock.pickupCloseTime === null,
      `open=${dock?.pickupOpenTime ?? "-"} close=${dock?.pickupCloseTime ?? "-"}`
    );

    const dockPage = await get(`/admin/origins?location=${dock?.id ?? ""}`, cookie);
    const openTag = tagById(dockPage.html, "loc-pickupOpenTime");
    const closeTag = tagById(dockPage.html, "loc-pickupCloseTime");
    const deadlineTag = tagById(dockPage.html, "loc-sameDayDeadline");
    check(
      "Opens at and Closes at are the same time control the same-day deadline uses",
      openTag.includes('type="time"') &&
        closeTag.includes('type="time"') &&
        deadlineTag.includes('type="time"'),
      `${openTag.slice(0, 50)} | ${closeTag.slice(0, 50)} | ${deadlineTag.slice(0, 50)}`
    );
    check(
      "And neither of them is prefilled — a dock with no hours recorded shows empty boxes",
      !/value="[^"]+"/.test(openTag) && !/value="[^"]+"/.test(closeTag),
      `${openTag} | ${closeTag}`
    );

    const zoneTag = tagById(dockPage.html, "loc-timeZone");
    // The datalist's own tag carries no values — its options are children — so
    // the list is asserted from the page, and the input is asserted separately.
    const zoneListTag = tagWithAttribute(dockPage.html, 'id="loc-timeZone-list"');
    check(
      "The time zone is chosen from the searchable list, and Toronto is what it starts on",
      zoneTag.includes('list="loc-timeZone-list"') &&
        zoneTag.includes('value="America/Toronto"') &&
        zoneListTag.startsWith("<datalist") &&
        dockPage.html.includes('<option value="America/Toronto">') &&
        dockPage.html.includes("Eastern Time"),
      zoneTag.slice(0, 80)
    );
    check(
      "The working days are boxes to tick, and a new dock starts on a working week",
      countNamed(dockPage.html, "workingDays") === 7,
      `${countNamed(dockPage.html, "workingDays")} day boxes`
    );

    const inverted = await post("/admin/origins", cookie, {
      intent: "save_location",
      id: dock?.id ?? "",
      code: DOCK_CODE,
      name: "Verify UI dock",
      timeZone: "America/Toronto",
      pickupOpenTime: "17:00",
      pickupCloseTime: "08:00",
    });
    const invertedHtml = await inverted.text();
    const afterInverted = await prisma.pickupLocation.findUnique({ where: { id: dock?.id ?? "" } });
    check(
      "A window that closes before it opens is refused by the form, and nothing is written",
      invertedHtml.includes("is not after Opens at") &&
        afterInverted?.pickupOpenTime === null &&
        afterInverted?.pickupCloseTime === null,
      `HTTP ${inverted.status}, open=${afterInverted?.pickupOpenTime ?? "-"}`
    );

    const savedDock = await post("/admin/origins", cookie, {
      intent: "save_location",
      id: dock?.id ?? "",
      code: DOCK_CODE,
      name: "Verify UI dock",
      timeZone: "America/Toronto",
      pickupOpenTime: "08:30",
      pickupCloseTime: "16:45",
    });
    const afterStored = await prisma.pickupLocation.findUnique({ where: { id: dock?.id ?? "" } });
    check(
      "A window that makes sense is saved, and the saved window is shown back",
      savedDock.status === 200 &&
        afterStored?.pickupOpenTime === "08:30" &&
        afterStored?.pickupCloseTime === "16:45",
      `HTTP ${savedDock.status}, ${afterStored?.pickupOpenTime}–${afterStored?.pickupCloseTime}`
    );
    const reread = await get(`/admin/origins?location=${dock?.id ?? ""}`, cookie);
    check(
      "And it comes back in the two time controls, not in a sentence",
      tagById(reread.html, "loc-pickupOpenTime").includes('value="08:30"') &&
        tagById(reread.html, "loc-pickupCloseTime").includes('value="16:45"'),
      `${tagById(reread.html, "loc-pickupOpenTime").slice(0, 60)}`
    );

    /* ------------------------------------------------------------------ */
    /* The address check, and the button that applies Google's answer       */
    /* ------------------------------------------------------------------ */

    /*
     * THE DEFECT THIS SECTION EXISTS FOR. The panel used to print Google's
     * suggestion as text and leave the operator to retype it — a suggestion
     * with no way to accept it is worse than none, because it looks like an
     * action and is a paragraph. What is asserted here is the whole of the
     * corrected behaviour on the screen a person actually uses: the address as
     * entered and the address Google would have, side by side, with a control
     * that writes it.
     *
     * THE VERDICT IS SEEDED, NOT REQUESTED. Google is not configured in this
     * deployment and must not be called from a test suite; the stored verdict
     * is the same shape `recordValidation` writes, and the call itself is the
     * subject of the places suite. What is under test here is what the screen
     * does with a verdict once it has one.
     */
    const address = {
      street1: "1200 Water Street",
      // The unit is the field the directive names by hand, and it is the one a
      // naive implementation loses: Google returns a street, not an apartment,
      // so anything that rebuilds the address from its answer drops it.
      street2: "Unit 7B",
      city: "Kelowna",
      /*
       * SPELLED OUT, WHERE GOOGLE ABBREVIATES. "British Columbia" and "BC" are
       * the same province, and the comparison rules say so — a spelling
       * difference is not a change, so this field must NOT appear among the
       * differences and must NOT be rewritten by Apply. Written as the long
       * form so that the check below ("left as the person spelled it") is a
       * real one rather than a comparison of a value with itself.
       */
      province: "British Columbia",
      // A wrong last character, which is the kind of postal mistake a person
      // makes and Google corrects. Not a formatting difference, so it belongs
      // in the difference list and is one of the fields Apply writes.
      postalCode: "V1Y 6V8",
      country: "CA",
    };
    await post("/admin/origins", cookie, {
      intent: "save_location",
      id: dock?.id ?? "",
      code: DOCK_CODE,
      name: "Verify UI dock",
      timeZone: "America/Toronto",
      ...address,
    });
    const addressed = await prisma.pickupLocation.findUnique({ where: { id: dock?.id ?? "" } });
    check(
      "The dock's address saves from the form, with its unit kept as its own component",
      addressed?.street1 === address.street1 && addressed?.street2 === address.street2,
      `${addressed?.street1 ?? "-"} / ${addressed?.street2 ?? "-"}`
    );

    const suggestion = {
      street1: "1200 Water St",
      /*
       * THE UNIT CARRIES THROUGH UNCHANGED, and it is written that way here
       * because that is what the application produces rather than a kindness in
       * the fixture. Google's components are applied over the address as
       * entered (`suggestedFromComponents` starts from the fallback and
       * overwrites only the components Google returned), so a suggestion talks
       * about the street and leaves the apartment alone. A fixture that nulled
       * this field would be modelling "Google replaced the unit with nothing" —
       * a thing the API cannot say — and would then be testing that the apply
       * step writes the blank it had been handed.
       */
      street2: "Unit 7B",
      city: "Kelowna",
      province: "BC",
      postalCode: "V1Y 6V7",
      country: "CA",
    };
    /*
     * The row is written through the shared fixture, which hashes the address
     * the record actually holds — so `suggestionCurrent` is true by
     * construction rather than by a copy of the comparison rule. The verdict,
     * the suggestion, the differences and the coordinates are the shape
     * `recordValidation` stores when Google answers a check with CORRECTION_REQUIRED.
     */
    await recordVerdict(prisma, {
      subjectType: "PICKUP",
      subjectId: dock?.id ?? "",
      verdict: "CORRECTION_REQUIRED",
      suggestedAddress: suggestion,
      /*
       * THE TWO COMPONENTS THAT GENUINELY DIFFER, and no others. This list is
       * what the panel prints and what Apply writes, so padding it with the
       * province — which the comparison rules treat as the same value spelled
       * differently — would be seeding a verdict the application cannot
       * produce, and the check that Apply leaves the province alone would then
       * be measuring the fixture instead of the rule.
       */
      differences: [
        { component: "street1", entered: address.street1, suggested: suggestion.street1 },
        { component: "postalCode", entered: address.postalCode, suggested: suggestion.postalCode },
      ],
    });
    // The geocode columns are not part of the shared fixture's contract — it
    // serves suites that book, which never read them — so the point Google
    // would have returned is attached here, to the row just written.
    await prisma.addressValidation.updateMany({
      where: { subjectType: "PICKUP", subjectId: dock?.id ?? "" },
      data: { latitude: 49.888, longitude: -119.496, granularity: "PREMISE", placeId: "verify-editor-ui-place" },
    });

    /*
     * SCOPED TO THIS DOCK'S OWN PANEL, NOT TO THE PAGE. The origins screen
     * draws an address card for every location it lists, so "the page contains
     * an Apply button" is a statement about whichever dock happens to have a
     * suggestion — it would pass for a dock with none, and pass here for the
     * wrong record. Every assertion below reads the card whose own hidden
     * subject id is this dock's.
     */
    const panel = await get(`/admin/origins?location=${dock?.id ?? ""}`, cookie);
    const card = cardFor(panel.html, dock?.id ?? "");
    check(
      "The panel shows the address as entered and the address Google suggests, both as addresses",
      card.includes("Address entered:") &&
        card.includes("Google suggests:") &&
        card.includes(address.street1) &&
        card.includes(suggestion.street1),
      `this dock's panel found: ${card.length > 0}; ${card.length} characters`
    );
    check(
      "And offers a button that applies it, rather than the text alone",
      card.includes('value="apply_suggestion"') && card.includes("Apply Google suggestion and save"),
      "the functional control the reported defect was missing"
    );
    check(
      "The unit is shown in both versions, so it is visibly not part of what would change",
      (card.match(/Unit 7B/g) ?? []).length >= 2,
      `${(card.match(/Unit 7B/g) ?? []).length} occurrence(s) in this dock's panel`
    );
    check(
      "And the postal code is the row that is called out, because it is the one that moves a parcel",
      card.includes("postalCode") &&
        card.includes("V1Y 6V7") &&
        card.includes('background:#fef3c7'),
      "the difference table marks it"
    );

    /*
     * NO SECRET IN THE PAGE. The browser key is a referrer-restricted key that
     * is meant to be public; the SERVER key is the one that must never leave
     * the credential store, and the address panel is the screen most likely to
     * leak it by printing the settings it read. Neither is asserted by name
     * here — the check is that nothing shaped like the stored secret appears at
     * all, which holds whether or not one is configured.
     */
    const serverKey = await getCredential("google", SERVER_KEY_FIELD);
    check(
      "The page carries no Google server key, whether it was configured or resolved from the environment",
      serverKey === null || !panel.html.includes(serverKey),
      serverKey ? "a server key resolves, and it is not in the markup" : "no server key configured"
    );

    const applied = await post("/admin/origins", cookie, {
      intent: "apply_suggestion",
      subjectType: "PICKUP",
      subjectId: dock?.id ?? "",
    });
    const corrected = await prisma.pickupLocation.findUnique({ where: { id: dock?.id ?? "" } });
    check(
      "Pressing Apply writes Google's structured address onto the record",
      corrected?.street1 === suggestion.street1 &&
        corrected?.city === suggestion.city &&
        corrected?.postalCode === suggestion.postalCode,
      `${corrected?.street1 ?? "-"}, ${corrected?.city ?? "-"} ${corrected?.province ?? "-"} ${corrected?.postalCode ?? "-"}`
    );
    check(
      "And the unit is preserved — Google asked to change nothing about it, so nothing was written to it",
      corrected?.street2 === address.street2,
      `street2 = ${corrected?.street2 ?? "(lost)"}`
    );
    check(
      "The province Google abbreviates is left exactly as the person spelled it",
      corrected?.province === address.province,
      `province = ${corrected?.province ?? "(lost)"} — "BC" is the same province, so it is not a correction`
    );
    check(
      "And the postal code Google returned is stored in the form Google wrote it",
      corrected?.postalCode === suggestion.postalCode,
      `postal = ${corrected?.postalCode ?? "(lost)"}`
    );
    /*
     * AND ONLY AN OWNER CAN DO IT. The card withholds the button from anyone
     * else, but a button that is merely absent is not a control — this posts
     * the same form as a signed-in catalogue-role account and asserts the
     * address did not move. Whichever layer answers first (the page's
     * permission, or the OWNER-only rule inside the service), the record is
     * what is checked, because the record is what a carrier is handed.
     */
    const notOwner = await post("/admin/origins", catalogCookie, {
      intent: "apply_suggestion",
      subjectType: "PICKUP",
      subjectId: dock?.id ?? "",
    });
    const afterNotOwner = await prisma.pickupLocation.findUnique({ where: { id: dock?.id ?? "" } });
    check(
      "A non-owner cannot apply a suggestion by posting the form themselves",
      notOwner.status !== 302 &&
        afterNotOwner?.street1 === corrected?.street1 &&
        afterNotOwner?.postalCode === corrected?.postalCode,
      `HTTP ${notOwner.status}, address unchanged=${afterNotOwner?.street1 === corrected?.street1}`
    );
    const verdictsAfterApply = await prisma.addressValidation.count({
      where: { subjectType: "PICKUP", subjectId: dock?.id ?? "" },
    });
    const revalidation = await prisma.addressValidation.findFirst({
      where: { subjectType: "PICKUP", subjectId: dock?.id ?? "" },
      orderBy: { checkedAt: "desc" },
    });
    /*
     * RE-CHECKED, AND THE ROW SAYS WHICH ADDRESS. A second verdict is the
     * promise ("the address is saved and then checked with Google"); that its
     * `originalAddress` is the CORRECTED address is the part that makes the
     * second verdict about the right thing — a re-check that re-validated the
     * address it had just replaced would record a verdict for a label nobody
     * will print.
     */
    const revalidated = (revalidation?.originalAddress as Record<string, string> | null) ?? null;
    check(
      "The applied address is re-checked, and the new verdict describes the corrected address",
      verdictsAfterApply >= 2 &&
        revalidated?.street1 === suggestion.street1 &&
        revalidated?.postalCode === suggestion.postalCode,
      `${verdictsAfterApply} verdict(s); latest for ${revalidated?.street1 ?? "?"}, ${revalidated?.postalCode ?? "?"}`
    );
    check(
      "The panel answers the press instead of failing silently",
      applied.status !== 500,
      `HTTP ${applied.status}`
    );

    /*
     * THE OTHER DIRECTION, AND IT MATTERS AS MUCH. Google answering "this is
     * already right" must not leave an Apply button on screen: the server
     * refuses a no-op apply ("differs only in formatting"), so a button that
     * renders anyway is a control whose only outcome is an error message.
     */
    const accepted = await recordVerdict(prisma, {
      subjectType: "PICKUP",
      subjectId: dock?.id ?? "",
      verdict: "ACCEPTED",
      suggestedAddress: null,
      differences: [],
    });
    /*
     * THE ROW JUST WRITTEN IS MADE UNMISTAKABLY THE NEWEST — by pushing the
     * others back, not by dating this one forward. The panel renders the newest
     * verdict and the press above has just written one; the two can land in the
     * same millisecond, and a tie would let either be drawn. A row dated in the
     * future would fix this check and silently break the next one, which writes
     * a newer verdict of its own and would then not be the newest at all.
     */
    await prisma.addressValidation.updateMany({
      where: { subjectType: "PICKUP", subjectId: dock?.id ?? "", id: { not: accepted.id } },
      data: { checkedAt: new Date(Date.now() - 60_000) },
    });
    const acceptedPanel = await get(`/admin/origins?location=${dock?.id ?? ""}`, cookie);
    const acceptedCard = cardFor(acceptedPanel.html, dock?.id ?? "");
    check(
      "An address Google accepted shows no Apply button — there is nothing to apply",
      acceptedCard.length > 0 &&
        !acceptedCard.includes('value="apply_suggestion"') &&
        acceptedCard.includes("Accepted by Google"),
      `verdict on this dock's panel: ${verdictOnPanel(acceptedCard)}; Apply offered: ${acceptedCard.includes('value="apply_suggestion"')}`
    );

    /*
     * AND AN ERROR DOES NOT EAT THE ADDRESS. With no Google key configured the
     * check cannot be made; the one thing that must not happen is the address
     * being cleared, replaced or half-written on the way to that answer. This
     * is the failure mode of "save what the provider returned" — a provider
     * that returned nothing.
     */
    const beforeFailedCheck = await prisma.pickupLocation.findUnique({
      where: { id: dock?.id ?? "" },
    });
    await post("/admin/origins", cookie, {
      intent: "check_address",
      subjectType: "PICKUP",
      subjectId: dock?.id ?? "",
    });
    const afterFailedCheck = await prisma.pickupLocation.findUnique({
      where: { id: dock?.id ?? "" },
    });
    check(
      "A check that cannot be made leaves the address exactly as it was",
      afterFailedCheck?.street1 === beforeFailedCheck?.street1 &&
        afterFailedCheck?.street2 === beforeFailedCheck?.street2 &&
        afterFailedCheck?.city === beforeFailedCheck?.city &&
        afterFailedCheck?.province === beforeFailedCheck?.province &&
        afterFailedCheck?.postalCode === beforeFailedCheck?.postalCode,
      `${afterFailedCheck?.street1 ?? "-"} / ${afterFailedCheck?.street2 ?? "-"}`
    );
    const stillShown = await get(`/admin/origins?location=${dock?.id ?? ""}`, cookie);
    check(
      "And the entered address is still the one on the screen",
      stillShown.html.includes(afterFailedCheck?.street1 ?? "\u0000") &&
        stillShown.html.includes(afterFailedCheck?.street2 ?? "\u0000"),
      "the form does not empty itself when the provider is unreachable"
    );

    /*
     * THE OTHER DECISION THE PANEL HAS TO OFFER, posted the way the panel posts
     * it. The card's override form carries the subject in `subjectId` — it
     * serves an order's delivery address as well as a dock, so it cannot know
     * that this page calls the same thing `id` — and the action read `id`. That
     * mismatch is invisible in the markup and fatal in the press: the owner's
     * "Keep the entered address" arrived with an empty subject and was answered
     * "that address could not be found." Asserting on the recorded row rather
     * than on the button is what catches it, because the button looked right
     * the whole time.
     */
    const override = await post("/admin/origins", cookie, {
      intent: "override_address",
      subjectType: "PICKUP",
      subjectId: dock?.id ?? "",
      reason: "The dock is known to the carrier by this address, checked on site.",
    });
    const overrideHtml = await override.text();
    const overridden = await prisma.addressValidation.findFirst({
      where: { subjectType: "PICKUP", subjectId: dock?.id ?? "", verdict: "OVERRIDDEN" },
      orderBy: { checkedAt: "desc" },
    });
    const overriddenLocation = await prisma.pickupLocation.findUnique({ where: { id: dock?.id ?? "" } });
    check(
      "Keep the entered address records an owner's acceptance, from the form the panel actually posts",
      override.status === 200 &&
        overrideHtml.includes("accepted by an owner") &&
        overridden !== null &&
        Boolean(overridden.overrideReason) &&
        overriddenLocation?.addressOverridden === true,
      `HTTP ${override.status}, override row=${overridden !== null}, flagged on the dock=${overriddenLocation?.addressOverridden}`
    );
    const overridePanel = await get(`/admin/origins?location=${dock?.id ?? ""}`, cookie);
    const overrideCard = cardFor(overridePanel.html, dock?.id ?? "");
    check(
      "And the panel says it was accepted by an owner, never that Google validated it",
      overrideCard.includes("Accepted by an owner") && !overrideCard.includes("Accepted by Google"),
      `verdict on this dock's panel: ${verdictOnPanel(overrideCard)}`
    );

    // The verdicts this section seeded belong to the dock and go with it. They
    // are removed by subject rather than by id so a check that threw above
    // cannot leave one behind for the next run to read as a real result.
    await prisma.addressValidation.deleteMany({
      where: { subjectType: "PICKUP", subjectId: dock?.id ?? "" },
    });
    await prisma.locationHoliday.deleteMany({ where: { locationId: dock?.id ?? "" } });
    await prisma.pickupLocation.deleteMany({ where: { code: DOCK_CODE } });

    await prisma.mediaAssetAssignment.deleteMany({ where: { assetId: image.id } });
    await prisma.mediaAsset.deleteMany({ where: { id: image.id } });
    await prisma.adminSession.deleteMany({ where: { userId: catalog.id } });
    await prisma.adminUser.deleteMany({ where: { id: catalog.id } });
  } finally {
    // Audit rows are append-only at the database level and are deliberately
    // left behind; everything else this suite made goes. The dock is deleted
    // here as well as at the end of the checks, so a failure part-way through
    // does not leave a pickup location behind for the next run to trip over.
    await prisma.locationHoliday.deleteMany({ where: { location: { code: DOCK_CODE } } });
    await prisma.pickupLocation.deleteMany({ where: { code: DOCK_CODE } });
    // Every asset this suite uploaded, by product rather than by the ids a
    // check happened to keep — a failure part-way through the media section
    // must not leave a stored file and a row behind for the next run.
    await prisma.mediaAssetAssignment.deleteMany({ where: { asset: { productId: product.id } } });
    await prisma.mediaAsset.deleteMany({ where: { productId: product.id } });
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
