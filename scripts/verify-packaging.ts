import { PrismaClient } from "@prisma/client";
import {
  toCm,
  toKg,
  validateVariantPackaging,
  buildQuotePackagesForOrder,
  PresetValidationError,
  createPreset,
  deletePreset,
  listPresetsAll,
  setPresetActive,
  updatePreset,
} from "../app/services/packaging.server";

const prisma = new PrismaClient();
const ACTOR = {
  actorType: "SYSTEM" as const,
  actorId: "verify-packaging",
  actorName: "Verify suite",
};

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const VV = process.argv[2];

async function main() {
  check("imperial to metric length (10in -> 25.4cm)", Math.abs(toCm(10, "in") - 25.4) < 1e-9, String(toCm(10, "in")));
  check("metric length unchanged (40cm)", toCm(40, "cm") === 40);
  check("imperial to metric weight (1lb -> 0.45359237kg)", Math.abs(toKg(1, "lb") - 0.45359237) < 1e-9, String(toKg(1, "lb")));

  const v = await validateVariantPackaging(VV);
  check("variant packaging validates complete", v.complete === true && v.packageCount === 1, JSON.stringify(v.missing));

  const built = await buildQuotePackagesForOrder({
    items: [{ sku: "VERIFY", quantity: 2, variantId: VV }],
    packages: [],
  });
  check("quote packages derived from variant packaging", built.source === "variant" && built.packages.length === 1 && built.missing.length === 0, JSON.stringify(built.packages));
  check("quantity multiplies package count", built.packages[0]?.count === 2, String(built.packages[0]?.count));
  check("dimensions converted to cm", built.packages[0]?.length === 40 && built.packages[0]?.weight === 2.5, `${built.packages[0]?.length}/${built.packages[0]?.weight}`);

  const missing = await buildQuotePackagesForOrder({
    items: [{ sku: "NO-PACKAGING", quantity: 1, variantId: "does-not-exist" }],
    packages: [],
  });
  check("missing packaging is reported, not guessed", missing.packages.length === 0 && missing.missing.some((m) => m.includes("packaging incomplete")), JSON.stringify(missing.missing));

  /* -------------------------------------------------------------------- */
  /* Packs: a box recorded once, chosen by a dropdown                      */
  /* -------------------------------------------------------------------- */
  /**
   * A pack is where "30 × 20 × 15" stops being retyped onto every variant. What
   * has to hold is that it is an ordinary storage row — the numbers as typed,
   * the unit beside them — and that deleting one cannot damage a carton that
   * had chosen it, because the dimensions were COPIED onto the row rather than
   * looked up from the pack.
   *
   * The last check is the one worth the seeding: it points a real package row
   * at a real pack, deletes the pack, and reads the row back. The claim is about
   * a foreign key's ON DELETE behaviour, which only the database can answer.
   *
   * Everything this creates is removed in the `finally`, and the fixture row is
   * put back to having chosen no pack, so a second run starts where this one
   * did.
   */
  const stamp = Date.now().toString(36);
  const madePresets: string[] = [];

  try {
    const name = `Verify pack ${stamp}`;
    const pack = await createPreset(
      {
        name,
        packageType: "carton",
        length: "12",
        width: "10",
        height: "8",
        dimensionUnit: "in",
        emptyWeight: "1.5",
        weightUnit: "lb",
        maxWeight: "30",
        isActive: true,
      },
      ACTOR,
    );
    madePresets.push(pack.id);
    check(
      "a pack is stored as the numbers typed and the unit they were typed in",
      pack.length === 12 &&
        pack.width === 10 &&
        pack.height === 8 &&
        pack.dimensionUnit === "in" &&
        Math.abs((pack.emptyWeight ?? 0) - 1.5) < 1e-9 &&
        pack.weightUnit === "lb" &&
        Math.abs((pack.maxWeight ?? 0) - 30) < 1e-9,
      `${pack.length} × ${pack.width} × ${pack.height} ${pack.dimensionUnit}, empty ${pack.emptyWeight} ${pack.weightUnit}`,
    );

    let duplicateRefused = false;
    try {
      await createPreset(
        { name: name.toUpperCase(), length: "1", width: "1", height: "1" },
        ACTOR,
      );
    } catch (error) {
      duplicateRefused = error instanceof PresetValidationError;
    }
    // If the refusal were absent the row would exist; removing it here keeps the
    // failure from becoming a second failure in the next run.
    await prisma.packagingPreset.deleteMany({
      where: { name: { equals: name, mode: "insensitive" }, id: { not: pack.id } },
    });
    check("a pack cannot take a name another pack already has, whatever the case", duplicateRefused);

    let incompleteRefused = false;
    try {
      await createPreset({ name: `Verify pack short ${stamp}`, length: "12", width: "10" }, ACTOR);
    } catch (error) {
      incompleteRefused = error instanceof PresetValidationError;
    }
    await prisma.packagingPreset.deleteMany({ where: { name: `Verify pack short ${stamp}` } });
    check("a pack missing a dimension is refused", incompleteRefused);

    let invertedRefused = false;
    try {
      await updatePreset(
        pack.id,
        { name, length: "12", width: "10", height: "8", emptyWeight: "5", maxWeight: "2" },
        ACTOR,
      );
    } catch (error) {
      invertedRefused = error instanceof PresetValidationError;
    }
    const unchanged = await prisma.packagingPreset.findUnique({ where: { id: pack.id } });
    check(
      "a pack that could not hold what it weighs empty is refused, and the refusal stores nothing",
      invertedRefused && unchanged?.length === 12 && unchanged?.emptyWeight === 1.5,
    );

    const corrected = await updatePreset(
      pack.id,
      {
        name: `${name} (wide)`,
        packageType: "mailer",
        length: "24",
        width: "18",
        height: "6",
        dimensionUnit: "in",
        emptyWeight: "2",
        weightUnit: "lb",
        maxWeight: "40",
      },
      ACTOR,
    );
    check(
      "a pack can be corrected, and the correction is what is stored",
      corrected.name === `${name} (wide)` &&
        corrected.packageType === "mailer" &&
        corrected.length === 24 &&
        corrected.width === 18,
      `${corrected.name} / ${corrected.packageType} / ${corrected.length}`,
    );

    const retired = await setPresetActive(pack.id, false, ACTOR);
    const listedAfterRetiring = await listPresetsAll();
    check(
      "a retired pack keeps its numbers and is still listed, so it can be offered again",
      retired.isActive === false &&
        retired.length === 24 &&
        listedAfterRetiring.some((preset) => preset.id === pack.id && !preset.isActive),
    );
    await setPresetActive(pack.id, true, ACTOR);

    /* ---- the delete, against a row that chose the pack ---- */

    const fixtureRow = await prisma.variantPackage.findFirst({ where: { variantId: VV } });
    if (!fixtureRow) throw new Error("the packaging fixture row is missing");

    const linked = await prisma.variantPackage.update({
      where: { id: fixtureRow.id },
      data: { presetId: pack.id },
    });
    const counted = await listPresetsAll();
    check(
      "a row that chose a pack is counted against it, so the page can say what deleting costs",
      counted.find((preset) => preset.id === pack.id)?._count.packages === 1,
      String(counted.find((preset) => preset.id === pack.id)?._count.packages),
    );

    const { rowsThatKeptTheirNumbers } = await deletePreset(pack.id, ACTOR);
    madePresets.length = 0;
    const survivor = await prisma.variantPackage.findUnique({ where: { id: linked.id } });
    check(
      "deleting a pack severs the link and leaves the carton's measurements exactly as they were",
      !!survivor &&
        survivor.presetId === null &&
        survivor.length === linked.length &&
        survivor.width === linked.width &&
        survivor.height === linked.height &&
        survivor.dimensionUnit === linked.dimensionUnit,
      survivor
        ? `presetId=${survivor.presetId}, ${survivor.length} × ${survivor.width} × ${survivor.height} ${survivor.dimensionUnit}`
        : "the row is gone",
    );
    check(
      "and the page is told how many rows kept their numbers",
      rowsThatKeptTheirNumbers === 1,
      String(rowsThatKeptTheirNumbers),
    );

    await prisma.variantPackage.update({
      where: { id: linked.id },
      data: { presetId: null },
    });
  } finally {
    for (const id of madePresets) {
      await prisma.packagingPreset.deleteMany({ where: { id } });
    }
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
