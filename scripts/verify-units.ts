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
 *      one — which is a property of the form, not of any function.
 *
 * THE LAST ONE IS READ, NOT DRIVEN, and that is a limitation stated rather than
 * hidden. The product form needs a signed-in admin session, which the suites
 * that have one declare with `requires: ["OWNER_EMAIL", "OWNER_PASSWORD"]` and
 * which is skipped when there is none. What can be checked without a session is
 * that the mechanism is present in the code — the input carrying the value it
 * was rendered with, and the submit handler that leaves an untouched one out of
 * the submission. Comments are stripped before every source assertion, because
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
    "changing the unit from the product form is gated on the general-settings permission",
    arm(PRODUCTS_ROUTE, "set_units").includes('userCan(user, "settings.general")'),
  );
  check(
    "and so is changing it from the settings page",
    arm(SETTINGS_ROUTE, "set_units").includes('userCan(user, "settings.general")'),
  );
  check(
    "the settings page offers the same two choices from the same list",
    SETTINGS_ROUTE.includes('name="intent" value="set_units"') &&
      SETTINGS_ROUTE.includes("UNITS_VALUES.map") &&
      SETTINGS_ROUTE.includes("unitsChangedMessage"),
  );

  console.log(
    "\nNOTE  This suite reads the two forms rather than driving them: the product page needs an\n" +
      "      admin session, which is the editor-ui suite's prerequisite and is skipped without one.\n" +
      "      What it proves about the forms is that the mechanism is written; what it cannot prove\n" +
      "      here is that the browser runs it. The conversions above are the same functions those\n" +
      "      forms call, so a PASS is evidence about the arithmetic and about the code's shape.",
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
