/**
 * Measurements in the operator's own unit, stored in one canonical unit.
 *
 * WHAT IS AT STAKE. A product's measurements are stored in centimetres and
 * kilograms because a quote, a booking and an order snapshot all read them from
 * there. The admin now lets an operator read and type inches and pounds
 * instead, which moves the interpretation of a number from the column to the
 * interface — and an interface that gets this wrong does not throw. It writes a
 * number that looks right and is 2.54 times too large, and the mistake surfaces
 * weeks later as a shipping quote for a box nobody has.
 *
 * So this suite checks the three places the interpretation happens, and it
 * checks them separately because passing one does not imply the others:
 *
 *   1. the conversion itself, where a value crosses between units;
 *   2. the preference, which decides which unit is in force and defaults to
 *      inches when nobody has chosen;
 *   3. the source of the two forms, because the failure this design is really
 *      guarding against is a display value being saved back over a canonical
 *      one — which is a property of the form, not of any function;
 *   4. the packaging rows, which keep their OWN unit beside their numbers and
 *      are now shown in the global one — the same failure, one step harder,
 *      because a row is a set of fields and the unit moves with the set;
 *   5. the packs a row can be filled from, which replace three typed numbers
 *      with three looked-up ones and must not move them in the process;
 *   6. the two submit handlers THEMSELVES, driven against a small DOM (see
 *      `scripts/tiny-dom.ts`), because the rule they implement is silent when it
 *      is wrong and the browser suite that would otherwise drive them does not
 *      run without the owner's password.
 *
 * THE TWO PAGES ARE READ, NOT DRIVEN, and that is a limitation stated rather than
 * hidden. The product form needs a signed-in admin session, which the suites
 * that have one declare with `requires: ["OWNER_EMAIL", "OWNER_PASSWORD"]` and
 * which is skipped when there is none. Point 6 is the exception — it drives the
 * two packaging handlers directly, against a shim rather than a browser. What can
 * be checked without a session is that the mechanism is present in the code — the
 * input carrying the value it was rendered with, and the submit handler that
 * leaves an untouched one out of the submission. Comments are stripped before
 * every source assertion, because
 * this repository carries long explanations and an explanation containing the
 * searched-for word would let a check pass with the behaviour absent — which is
 * a failure this project has already had once.
 *
 * IT WRITES ONE ROW AND PUTS IT BACK. The preference it sets is snapshotted
 * before and restored afterwards, in a `finally`, so a crash mid-suite does not
 * leave the clone, or a later suite, reading in centimetres. It makes no network
 * call, no Shopify call and no Odoo call.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-units.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  enteredToCanonical,
  storedToDisplay,
  unitsView,
  DEFAULT_UNITS,
  UNITS_VALUES,
} from "~/utils/measurementUnits";
import { getUnitsPreference, setUnitsPreference, UNITS_KEY } from "~/services/adminPreferences.server";
import { fillPackagingRow, preservePackagingRows } from "~/components/product/packagingRows";
import { h, select, type FakeElement, type FakeSelect } from "./tiny-dom";

const prisma = new PrismaClient();

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${total}. ${name}${detail ? ` — ${detail}` : ""}`);
}

const ACTOR = { actorType: "SYSTEM" as const, actorId: "verify-units", actorName: "Verify suite" };

function readSource(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

/** Source with comments removed. See the header: a comment is not code. */
function clean(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PRODUCTS_ROUTE = clean(readSource("app/routes/admin.products_.$id.tsx"));
const SETTINGS_ROUTE = clean(readSource("app/routes/admin.settings.tsx"));
const VARIANTS_TAB = clean(readSource("app/components/product/VariantsTab.tsx"));
const SHIPPING_TAB = clean(readSource("app/components/product/ShippingTab.tsx"));
const PACKAGING_ROWS = clean(readSource("app/components/product/packagingRows.ts"));
const PACKS_ROUTE = clean(readSource("app/routes/admin.packaging.tsx"));
const AUDIT_SERVICE = clean(readSource("app/services/audit.server.ts"));
const ADMIN_LAYOUT = clean(readSource("app/routes/admin.tsx"));

/**
 * The body of the branch that handles one intent.
 *
 * Used for the permission checks, where "the string appears in the file" is not
 * the claim: the claim is that THIS branch refuses without the permission, and a
 * gate sitting in a neighbouring branch would satisfy a whole-file search.
 *
 * Two shapes, because the two routes are written differently — the product route
 * dispatches on a `switch` and the settings page on `if (intent === …)` — and a
 * helper that understood only one of them would report the other's gate as
 * missing, which is a false failure and worse than no check. Either way the body
 * is taken by matching braces, so a gate inside a nested `try` still counts as
 * inside the branch and one in the next branch does not.
 */
function arm(source: string, name: string): string {
  const at = Math.max(
    source.indexOf(`case "${name}"`),
    source.indexOf(`intent === "${name}"`),
  );
  if (at < 0) return "";

  const open = source.indexOf("{", at);
  if (open < 0) return "";

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/**
 * The body of a named function, by matching braces.
 *
 * `arm` above picks one branch out of a dispatcher; this picks one function out
 * of a module, for the same reason. The claim being checked about the pack fill
 * is that it does NOT touch a weight, and a whole-file search cannot tell "the
 * weight is left alone" from "the weight is set two functions further down".
 */
function fn(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const open = source.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

async function main(): Promise<number> {
  /* -------------------------------------------------------------------------- */
  /* 1. The conversions                                                         */
  /* -------------------------------------------------------------------------- */

  console.log("\n— Conversion —");

  check(
    "24 inches is stored as 60.96 centimetres",
    enteredToCanonical("24", "length", "imperial") === "60.96",
    enteredToCanonical("24", "length", "imperial"),
  );
  check(
    "2.5 pounds is stored as 1.134 kilograms (three places, the weight column's scale)",
    enteredToCanonical("2.5", "weight", "imperial") === "1.134",
    enteredToCanonical("2.5", "weight", "imperial"),
  );
  check(
    "in metric the typed value is the stored value",
    enteredToCanonical("60.96", "length", "metric") === "60.96",
  );
  check(
    "an empty box stays empty — clearing a measurement is not a zero",
    enteredToCanonical("", "length", "imperial") === "",
  );
  check(
    "text that is not a number is passed through for the validator to refuse",
    enteredToCanonical("about 24", "length", "imperial") === "about 24",
  );
  check(
    "zero is not converted into a measurement",
    enteredToCanonical("0", "length", "imperial") === "0",
  );

  check(
    "60.96 cm reads as 24 in",
    storedToDisplay("60.96", "length", "imperial") === "24",
    storedToDisplay("60.96", "length", "imperial"),
  );
  check(
    "a stored value in metric is shown exactly as stored, unrounded",
    storedToDisplay("0.907", "weight", "metric") === "0.907",
    storedToDisplay("0.907", "weight", "metric"),
  );
  check(
    "a measurement that was never taken reads as empty, not as zero",
    storedToDisplay(null, "length", "imperial") === "",
  );
  check(
    "a value that cannot be read as a number reads as empty",
    storedToDisplay({}, "length", "imperial") === "",
  );
  check(
    "a displayed value typed back in lands on the stored figure",
    enteredToCanonical(storedToDisplay("60.96", "length", "imperial"), "length", "imperial") ===
      "60.96",
  );

  /* -------------------------------------------------------------------------- */
  /* 2. The preference                                                          */
  /* -------------------------------------------------------------------------- */

  console.log("\n— The preference —");

  const before = await prisma.adminPreference.findUnique({
    where: { key: UNITS_KEY },
    select: { value: true },
  });

  try {
    await prisma.adminPreference.deleteMany({ where: { key: UNITS_KEY } });

    check("a deployment that has never chosen reads in inches", (await getUnitsPreference()) === "imperial");
    check("and that default is the one the interface offers", DEFAULT_UNITS === "imperial");
    check("the two units are the two the forms render", UNITS_VALUES.join(",") === "imperial,metric");

    const imperialView = unitsView("imperial");
    check(
      "the imperial labels name the unit they hold",
      imperialView.lengthLabel === "Length (in)" && imperialView.weightLabel === "Weight (lb)",
      `${imperialView.lengthLabel} / ${imperialView.weightLabel}`,
    );
    check(
      "the metric labels name theirs",
      unitsView("metric").lengthLabel === "Length (cm)" && unitsView("metric").weightLabel === "Weight (kg)",
    );
    check(
      "the packaging tables are seeded with the matching unit strings",
      imperialView.dimensionUnit === "in" &&
        imperialView.weightUnit === "lb" &&
        unitsView("metric").dimensionUnit === "cm" &&
        unitsView("metric").weightUnit === "kg",
    );

    check("the preference is saved", (await setUnitsPreference("metric", ACTOR)) === "metric");
    check("and read back as saved", (await getUnitsPreference()) === "metric");

    const stored = await prisma.adminPreference.findUnique({
      where: { key: UNITS_KEY },
      select: { value: true },
    });
    check("one row holds it, keyed by the question it answers", stored?.value === "metric");

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "AdminPreference", action: "admin_preference.units_updated" },
      orderBy: { createdAt: "desc" },
      select: { beforeData: true, afterData: true },
    });
    check(
      "the change is audited with both the old and the new unit",
      Boolean(audit) &&
        String(audit?.beforeData).includes("imperial") &&
        String(audit?.afterData).includes("metric"),
      `${audit?.beforeData} → ${audit?.afterData}`,
    );

    let refused = false;
    try {
      await setUnitsPreference("cubits", ACTOR);
    } catch {
      refused = true;
    }
    check("a value that is not a unit is refused", refused);
    check("and the refusal changed nothing", (await getUnitsPreference()) === "metric");
  } finally {
    // Put the clone back exactly as it was found, so a later suite — and a second
    // run of this one — starts from the same place.
    if (before) {
      await prisma.adminPreference.update({ where: { key: UNITS_KEY }, data: { value: before.value } });
    } else {
      await prisma.adminPreference.deleteMany({ where: { key: UNITS_KEY } });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* 3. The forms and the routes                                                */
  /* -------------------------------------------------------------------------- */

  console.log("\n— The interface —");

  check(
    "the product route converts what was typed before it reaches the column",
    PRODUCTS_ROUTE.includes("enteredToCanonical("),
  );
  check(
    "an absent measurement is not in the submission, so the stored value is kept",
    /if \(!form\.has\(name\)\) return undefined;/.test(PRODUCTS_ROUTE),
  );
  check(
    "the form carries the unit it was drawn in, so a mid-edit change cannot reinterpret it",
    PRODUCTS_ROUTE.includes("isUnitPreference(submittedUnits)") &&
      /name="units"\s+value=\{units\.preference\}/.test(VARIANTS_TAB),
  );
  check(
    "an untouched measurement is disabled on submit, and disabling is what omits it",
    VARIANTS_TAB.includes("preserveUntouchedMeasurements") &&
      VARIANTS_TAB.includes("data-measure-original") &&
      /field\.value === field\.dataset\.measureOriginal\) field\.disabled = true;/.test(VARIANTS_TAB),
  );
  check(
    "the measurement labels come from the preference and not from a fixed string",
    VARIANTS_TAB.includes("units.lengthLabel") &&
      VARIANTS_TAB.includes("units.weightLabel") &&
      !VARIANTS_TAB.includes('label="Length (cm)"'),
  );
  check(
    "the read view shows stored measurements in the preferred unit",
    VARIANTS_TAB.includes('storedToDisplay(variant?.productLengthCm, "length", units.preference)'),
  );
  check(
    "a blank carton row starts in the preferred unit, while a saved row keeps its own",
    VARIANTS_TAB.includes("row?.dimensionUnit ?? units.dimensionUnit") &&
      VARIANTS_TAB.includes("row?.weightUnit ?? units.weightUnit") &&
      SHIPPING_TAB.includes("row?.dimensionUnit ?? units.dimensionUnit") &&
      SHIPPING_TAB.includes("row?.weightUnit ?? units.weightUnit"),
  );
  check(
    "the product form no longer carries a unit selector of its own — Settings is the only place",
    arm(PRODUCTS_ROUTE, "set_units") === "" &&
      !/name="intent"\s+value="set_units"/.test(PRODUCTS_ROUTE) &&
      !VARIANTS_TAB.includes("UNITS_VALUES"),
  );
  check(
    "the settings page still is that one place, behind the general-settings permission",
    arm(SETTINGS_ROUTE, "set_units").includes('userCan(user, "settings.general")'),
  );
  check(
    "the settings page offers the two choices from the same list, and says what it changes",
    SETTINGS_ROUTE.includes('name="intent" value="set_units"') &&
      SETTINGS_ROUTE.includes("UNITS_VALUES.map") &&
      SETTINGS_ROUTE.includes("unitsChangedMessage"),
  );

  /* -------------------------------------------------------------------------- */
  /* 4. The packaging rows, which used to disagree with it                      */
  /* -------------------------------------------------------------------------- */

  console.log("\n— Packaging follows the same unit —");

  check(
    "no packaging row is drawn with a unit chooser of its own",
    !/<select[^>]*name="pkg_dimUnit"/.test(VARIANTS_TAB) &&
      !/<select[^>]*name="pkg_weightUnit"/.test(VARIANTS_TAB) &&
      !/<select[^>]*name="pkg_dimUnit"/.test(SHIPPING_TAB) &&
      !/<select[^>]*name="pkg_weightUnit"/.test(SHIPPING_TAB),
  );
  check(
    "each row still carries the unit its numbers are STORED in, as a hidden field",
    VARIANTS_TAB.includes('name="pkg_dimUnit"') &&
      VARIANTS_TAB.includes('name="pkg_weightUnit"') &&
      SHIPPING_TAB.includes('name="pkg_dimUnit"') &&
      SHIPPING_TAB.includes('name="pkg_weightUnit"'),
  );
  check(
    "the row says which unit it is being SHOWN in, so its numbers can be translated on the way out",
    VARIANTS_TAB.includes("data-global-dim={units.dimensionUnit}") &&
      VARIANTS_TAB.includes("data-global-weight={units.weightUnit}") &&
      SHIPPING_TAB.includes("data-global-dim={units.dimensionUnit}") &&
      SHIPPING_TAB.includes("data-global-weight={units.weightUnit}"),
  );
  check(
    "both editors submit through the handler that saves an untouched row exactly as it was stored",
    /onSubmit=\{preservePackagingRows\}/.test(VARIANTS_TAB) &&
      /onSubmit=\{preservePackagingRows\}/.test(SHIPPING_TAB) &&
      /field\.value = field\.dataset\.stored \?\? ""/.test(PACKAGING_ROWS),
  );
  check(
    "an edited row re-expresses its untouched figures without rounding, so the display unit cannot drift the carton",
    /convertedExact\(\s*field\.dataset\.stored/.test(PACKAGING_ROWS) &&
      PACKAGING_ROWS.includes('field.dataset.storedUnit ?? ""'),
  );

  /* -------------------------------------------------------------------------- */
  /* 5. Packs: a box measured once, chosen by a dropdown                        */
  /* -------------------------------------------------------------------------- */

  console.log("\n— Packs —");

  const fill = fn(PACKAGING_ROWS, "fillPackagingRow");

  check(
    "both packaging editors choose a pack from a dropdown, wired to the shared fill",
    VARIANTS_TAB.includes('name="pkg_presetId"') &&
      SHIPPING_TAB.includes('name="pkg_presetId"') &&
      VARIANTS_TAB.includes("fillPackagingRow") &&
      SHIPPING_TAB.includes("fillPackagingRow"),
  );
  check(
    "choosing a pack fills the three dimensions and never the weight",
    PACKAGING_ROWS.includes('const DIMENSIONS = ["length", "width", "height"]') &&
      fill.includes("for (const dimension of DIMENSIONS)") &&
      fill !== "" &&
      !/weight/i.test(fill),
    fill === "" ? "fillPackagingRow not found" : "",
  );
  check(
    "a filled dimension carries the figure to show and the exact figure to store, so the pack's own number survives",
    fill.includes("field.dataset.stored = convertedExact(") &&
      fill.includes("field.dataset.storedUnit = shown") &&
      fill.includes("field.dataset.original = display"),
  );
  check(
    "clearing the choice unlinks the pack without erasing the row's numbers",
    /if \(!option \|\| select\.value === ""\) return;/.test(fill),
  );
  check(
    "a retired pack is still offered on the rows that already chose it",
    VARIANTS_TAB.includes("preset.isActive || preset.id === row?.presetId") &&
      SHIPPING_TAB.includes("preset.isActive || preset.id === row?.presetId"),
  );
  check(
    "the packs page reads behind products.view and writes behind products.manage, same-origin",
    PACKS_ROUTE.slice(
      PACKS_ROUTE.indexOf("export async function loader"),
      PACKS_ROUTE.indexOf("export async function action"),
    ).includes('requirePermission(request, "products.view")') &&
      PACKS_ROUTE.slice(PACKS_ROUTE.indexOf("export async function action")).includes(
        'requirePermission(request, "products.manage")',
      ) &&
      PACKS_ROUTE.slice(PACKS_ROUTE.indexOf("export async function action")).includes(
        "assertSameOrigin(request)",
      ),
  );
  check(
    "a pack change is audited against its own entity, and the page is in the navigation",
    AUDIT_SERVICE.includes('PACKAGING_PRESET: "PackagingPreset"') &&
      ADMIN_LAYOUT.includes('href: "/admin/packaging"'),
  );

  /* -------------------------------------------------------------------------- */
  /* 6. The handlers, driven                                                    */
  /* -------------------------------------------------------------------------- */
  /**
   * Everything above is a claim about the code's SHAPE. This part runs the two
   * handlers and reads what they left in the fields, which is what the browser
   * would submit.
   *
   * The row below is built by hand and the two figures on it are given
   * separately — the one that is stored and the one that is on screen — rather
   * than derived from each other. Deriving them would reproduce the conversion
   * under test, and a conversion that lost a decimal place would then agree with
   * itself and pass.
   */
  console.log("\n— The handlers, driven —");

  type Figure = {
    name: string;
    kind: "length" | "weight";
    stored: string;
    storedUnit: string;
    display: string;
  };

  /** A carton row as the editor draws it, with the two hidden unit fields. */
  function cartonRow(figures: Figure[], shown: { dim: string; weight: string }) {
    const form = h("form");
    const row = form.append(
      h("tr", {
        "data-pkg-row": "0",
        "data-global-dim": shown.dim,
        "data-global-weight": shown.weight,
      }),
    );
    const fields = new Map<string, ReturnType<typeof h>>();

    for (const figure of figures) {
      const field = h("input", {
        name: figure.name,
        "data-kind": figure.kind,
        "data-stored": figure.stored,
        "data-stored-unit": figure.storedUnit,
        "data-original": figure.display,
      });
      field.value = figure.display;
      fields.set(figure.name, row.append(field));
    }

    // A hidden input's value IS its attribute until something changes it, which
    // is how the editor seeds these two.
    const dimUnit = row.append(h("input", { name: "pkg_dimUnit" }));
    dimUnit.value = figures[0]?.storedUnit ?? "";
    const weightUnit = row.append(h("input", { name: "pkg_weightUnit" }));
    weightUnit.value = figures.find((figure) => figure.kind === "weight")?.storedUnit ?? "";
    fields.set("pkg_dimUnit", dimUnit);
    fields.set("pkg_weightUnit", weightUnit);

    return { form, fields, dimensionUnit: dimUnit, weightUnit };
  }

  /** What a field would carry into the FormData — the handlers write values. */
  const rendered = (field: { value: string }) => field.value;

  /**
   * The two casts the handlers' signatures make necessary. They take DOM types
   * because in the app they are DOM handlers; what is passed here is the shim
   * from `tiny-dom`, which implements the parts of those types they use.
   */
  const asForm = (form: FakeElement) =>
    ({ currentTarget: form }) as unknown as Parameters<typeof preservePackagingRows>[0];
  const asSelect = (element: FakeSelect) => element as unknown as HTMLSelectElement;

  // 30 × 20 × 10 cm and 5 kg, read by an admin set to inches and pounds.
  const IMPERIAL_ROW: Figure[] = [
    { name: "pkg_length", kind: "length", stored: "30", storedUnit: "cm", display: "11.81" },
    { name: "pkg_width", kind: "length", stored: "20", storedUnit: "cm", display: "7.87" },
    { name: "pkg_height", kind: "length", stored: "10", storedUnit: "cm", display: "3.94" },
    { name: "pkg_weight", kind: "weight", stored: "5", storedUnit: "kg", display: "11.023" },
  ];

  const untouched = cartonRow(IMPERIAL_ROW, { dim: "in", weight: "lb" });
  preservePackagingRows(asForm(untouched.form));
  check(
    "a row nobody touched is submitted with the figures it is STORED with, not the ones on screen",
    rendered(untouched.fields.get("pkg_length")!) === "30" &&
      rendered(untouched.fields.get("pkg_width")!) === "20" &&
      rendered(untouched.fields.get("pkg_height")!) === "10" &&
      rendered(untouched.fields.get("pkg_weight")!) === "5" &&
      untouched.dimensionUnit.value === "cm" &&
      untouched.weightUnit.value === "kg",
    `${rendered(untouched.fields.get("pkg_length")!)} × ${rendered(untouched.fields.get("pkg_width")!)} cm, ${rendered(untouched.fields.get("pkg_weight")!)} ${untouched.weightUnit.value}`,
  );

  const edited = cartonRow(IMPERIAL_ROW, { dim: "in", weight: "lb" });
  // The operator corrects the length and touches nothing else.
  edited.fields.get("pkg_length")!.value = "12";
  preservePackagingRows(asForm(edited.form));
  const eWidth = Number(rendered(edited.fields.get("pkg_width")!));
  const eWeight = Number(rendered(edited.fields.get("pkg_weight")!));
  check(
    "an edited row is saved in the unit on screen, and it says so",
    rendered(edited.fields.get("pkg_length")!) === "12" &&
      edited.dimensionUnit.value === "in" &&
      edited.weightUnit.value === "lb",
    `${rendered(edited.fields.get("pkg_length")!)} ${edited.dimensionUnit.value}`,
  );
  check(
    "the figures nobody edited keep their QUANTITY — 20 cm is submitted as the exact 7.8740… in, not the 7.87 on screen",
    rendered(edited.fields.get("pkg_width")!) !== "7.87" &&
      Math.abs(eWidth * 2.54 - 20) < 1e-9 &&
      Math.abs(eWeight * 0.45359237 - 5) < 1e-9,
    `${rendered(edited.fields.get("pkg_width")!)} in / ${rendered(edited.fields.get("pkg_weight")!)} lb`,
  );

  /* ---- and the pack a row can be filled from ---- */

  const packed = cartonRow(IMPERIAL_ROW, { dim: "in", weight: "lb" });
  const packSelect = packed.fields.get("pkg_length")!.parent!.append(select({ name: "pkg_presetId" }));
  packSelect.append(h("option", { value: "" }));
  packSelect.append(
    h("option", {
      value: "pack-1",
      "data-length": "30",
      "data-width": "20",
      "data-height": "15",
      "data-unit": "cm",
    }),
  );

  const weightBeforeFill = rendered(packed.fields.get("pkg_weight")!);
  fillPackagingRow(asSelect(packSelect));
  check(
    "choosing nothing unlinks the pack and leaves the row's numbers alone",
    rendered(packed.fields.get("pkg_length")!) === "11.81" &&
      rendered(packed.fields.get("pkg_weight")!) === weightBeforeFill,
  );

  packSelect.value = "pack-1";
  fillPackagingRow(asSelect(packSelect));
  check(
    "choosing a pack fills the three dimensions converted into the admin's unit",
    rendered(packed.fields.get("pkg_length")!) === "11.81" &&
      rendered(packed.fields.get("pkg_width")!) === "7.87" &&
      rendered(packed.fields.get("pkg_height")!) === "5.91",
    `${rendered(packed.fields.get("pkg_length")!)} × ${rendered(packed.fields.get("pkg_width")!)} × ${rendered(packed.fields.get("pkg_height")!)}`,
  );
  check(
    "and it does not touch the weight — neither its figure nor the unit it is stored in",
    rendered(packed.fields.get("pkg_weight")!) === weightBeforeFill &&
      packed.weightUnit.value === "kg",
    `${rendered(packed.fields.get("pkg_weight")!)} ${packed.weightUnit.value}`,
  );

  preservePackagingRows(asForm(packed.form));
  const fLength = Number(rendered(packed.fields.get("pkg_length")!));
  check(
    "and the figure the pack filled in survives the round trip — 30 cm comes back as 30 cm, not as the 11.81 that was displayed",
    rendered(packed.fields.get("pkg_length")!) !== "11.81" &&
      Math.abs(fLength * 2.54 - 30) < 1e-9 &&
      Math.abs(Number(rendered(packed.fields.get("pkg_height")!)) * 2.54 - 15) < 1e-9 &&
      packed.dimensionUnit.value === "in",
    `${rendered(packed.fields.get("pkg_length")!)} in = ${fLength * 2.54} cm`,
  );

  console.log(
    "\nNOTE  The measurements form is READ, not driven: that page needs an admin session, which is\n" +
      "      the editor-ui suite's prerequisite and is skipped without one. What is proved about it\n" +
      "      here is that the mechanism is written — the conversions it calls are the same functions\n" +
      "      checked above, so a PASS is evidence about the arithmetic and about the code's shape.\n" +
      "      The PACKAGING handlers ARE driven, through scripts/tiny-dom.ts, because the browser\n" +
      "      suite cannot run in this environment and the rule they implement is the one that fails\n" +
      "      silently. That shim is not a browser: it proves the two functions do what the checks\n" +
      "      say, on a row built the way the editor builds one, and nothing about React or events.",
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  return failures;
}

main()
  .then(async (failed) => {
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
