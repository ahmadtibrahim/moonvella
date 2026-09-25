import { PrismaClient } from "@prisma/client";
import {
  toCm,
  toKg,
  validateVariantPackaging,
  buildQuotePackagesForOrder,
  getVariantPackages,
  saveVariantPackages,
  resolvePackagesForLines,
  parcelRowsToQuotePackages,
  PackageValidationError,
  PresetValidationError,
  createPreset,
  deletePreset,
  listPresetsAll,
  setPresetActive,
  updatePreset,
} from "../app/services/packaging.server";
// The editor's own function, not a copy of it: what a new carton row says is
// the editor's rule, and a second implementation here would agree with itself.
import { newCartonText } from "../app/components/product/packagingRows";

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
  /* What a new carton row starts out saying                               */
  /* -------------------------------------------------------------------- */
  /**
   * The row's label and description are seeded from facts that are already true
   * of it, and this is a PURE check: `newCartonText` is the same function the
   * editor calls, so what is asserted here is what the form is drawn from
   * rather than a description of it. The rendered result is checked over HTTP
   * in `verify-editor-ui`, where a blank row's two inputs are read out of the
   * page; this is the half that runs without a server.
   *
   * The fallbacks are the point. A variant always has a name in the editor, but
   * a row made by an import may not, and the description has only one source —
   * `ProductVariant` has no description column, so the family's is what the
   * directive's fallback resolves to in every reachable case.
   */
  check(
    "a new carton row is named after the variant, and described with the family's description",
    JSON.stringify(
      newCartonText({
        variantName: "Queen",
        productName: "Cooling Pillow",
        productDescription: "A pillow that stays cool.",
      }),
    ) === JSON.stringify({ label: "Queen", description: "A pillow that stays cool." }),
    JSON.stringify(newCartonText({ variantName: "Queen", productName: "Cooling Pillow" })),
  );
  check(
    "a variant with no name falls back to the family's, rather than leaving the box blank",
    newCartonText({ variantName: "   ", productName: "Cooling Pillow" }).label === "Cooling Pillow",
  );
  check(
    "a family with no description seeds an empty one, and does not invent one",
    newCartonText({ variantName: "Queen", productName: "Cooling Pillow", productDescription: null })
      .description === "",
  );
  check(
    "and a description is not padded with whitespace it was stored with",
    newCartonText({ productDescription: "  A pillow.  " }).description === "A pillow.",
    JSON.stringify(newCartonText({ productDescription: "  A pillow.  " }).description),
  );

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

  /* -------------------------------------------------------------------- */
  /* G. Saving, reloading, and what a refusal leaves behind                 */
  /* -------------------------------------------------------------------- */
  /**
   * The owner's report was "I enter dimensions and the page comes back to 0
   * cartons". The page is the visible half; this is the half that decides it.
   * What has to hold is that a save which is accepted is READ BACK IDENTICAL,
   * and that a save which is refused changes nothing at all — because the
   * failure mode that costs packaging is not the refusal, it is a replace that
   * half-applied.
   *
   * These run on a variant this section creates, not on the fixture row: the
   * checks above assert the fixture's exact measurements, and overwriting them
   * here would make this suite's own earlier sections depend on the order they
   * run in.
   */
  const parent = await prisma.productVariant.findUnique({
    where: { id: VV },
    select: { productId: true },
  });
  if (!parent) throw new Error("the packaging fixture variant is missing");
  const madeVariants: string[] = [];

  const makeVariant = async (suffix: string) => {
    const row = await prisma.productVariant.create({
      data: {
        productId: parent.productId,
        sku: `VERIFY-PKG-${stamp}-${suffix}`,
        name: `Verify ${suffix}`,
        wholesalePrice: 1299,
        suggestedRetailPrice: 4900,
        inventory: 10,
      },
    });
    madeVariants.push(row.id);
    return row.id;
  };

  try {
    const B = await makeVariant("B");

    /* ---- what a new row is, before anybody configures it ---- */
    const bare = await prisma.variantPackage.create({
      data: { variantId: B, length: 24, width: 18, height: 6, grossWeight: 2.5 },
    });
    check(
      "a carton recorded without being asked ships separately, may not be merged, and holds one unit",
      bare.shipsSeparately === true && bare.consolidatable === false && bare.unitsPerPackage === 1,
      `shipsSeparately=${bare.shipsSeparately}, consolidatable=${bare.consolidatable}, unitsPerPackage=${bare.unitsPerPackage}`,
    );
    const unpicked = await prisma.variantPackage.findMany({ where: { variantId: B } });
    check(
      "and it keeps the unit it was recorded in rather than being converted on the way in",
      unpicked[0]?.dimensionUnit === "cm" && unpicked[0]?.weightUnit === "kg",
      `${unpicked[0]?.dimensionUnit}/${unpicked[0]?.weightUnit}`,
    );
    await prisma.variantPackage.deleteMany({ where: { variantId: B } });

    /* ---- the round trip ---- */
    const entered = {
      label: "Verify carton",
      packageType: "carton",
      length: "24",
      width: "18",
      height: "6",
      dimensionUnit: "in",
      grossWeight: "2.5",
      weightUnit: "lb",
      unitsPerPackage: "2",
      packagesPerUnit: "1",
      shipsSeparately: "true",
    };
    const saved = await saveVariantPackages(B, [entered]);
    const readBack = await getVariantPackages(B);
    check(
      "a saved carton is one row, and reads back with every figure as entered",
      saved === 1 &&
        readBack.length === 1 &&
        readBack[0].length === 24 &&
        readBack[0].width === 18 &&
        readBack[0].height === 6 &&
        readBack[0].dimensionUnit === "in" &&
        Math.abs(readBack[0].grossWeight - 2.5) < 1e-9 &&
        readBack[0].weightUnit === "lb" &&
        readBack[0].unitsPerPackage === 2,
      `${readBack.length} row(s): ${readBack[0]?.length} × ${readBack[0]?.width} × ${readBack[0]?.height} ${readBack[0]?.dimensionUnit}, ${readBack[0]?.grossWeight} ${readBack[0]?.weightUnit}, ${readBack[0]?.unitsPerPackage}/package`,
    );
    check(
      "saving the same row again leaves one carton, not two (the replace is a replace)",
      (await saveVariantPackages(B, [entered])) === 1 && (await getVariantPackages(B)).length === 1,
    );

    /* ---- a refusal changes nothing ---- */
    let refusal: PackageValidationError | null = null;
    try {
      await saveVariantPackages(B, [
        entered,
        { ...entered, label: "No weight", grossWeight: "" },
      ]);
    } catch (error) {
      if (error instanceof PackageValidationError) refusal = error;
      else throw error;
    }
    const afterRefusal = await getVariantPackages(B);
    check(
      "a set with one incomplete row is refused, and the row is named with its field",
      refusal !== null &&
        refusal.details.some((d) => d.index === 1 && d.field === "grossWeight"),
      refusal ? refusal.details.map((d) => `#${d.index} ${d.field}`).join(", ") : "no refusal",
    );
    check(
      "and nothing was written: the carton that was already there is untouched",
      afterRefusal.length === 1 &&
        afterRefusal[0].length === 24 &&
        afterRefusal[0].dimensionUnit === "in" &&
        afterRefusal[0].unitsPerPackage === 2,
      `${afterRefusal.length} row(s), ${afterRefusal[0]?.length} ${afterRefusal[0]?.dimensionUnit}`,
    );

    /* ---- the empty save that deleted everything ---- */
    let droppedRows: PackageValidationError | null = null;
    try {
      await saveVariantPackages(B, [], { drawnRows: 1 });
    } catch (error) {
      if (error instanceof PackageValidationError) droppedRows = error;
      else throw error;
    }
    check(
      "a save that carries no rows although the page showed one is refused, not treated as a clear",
      droppedRows !== null && (await getVariantPackages(B)).length === 1,
      droppedRows ? `${(await getVariantPackages(B)).length} row(s) left` : "not refused",
    );
    let silentSave: PackageValidationError | null = null;
    try {
      await saveVariantPackages(B, []);
    } catch (error) {
      if (error instanceof PackageValidationError) silentSave = error;
      else throw error;
    }
    check(
      "a save that cannot say how many rows the page showed is refused too (the stale-page case)",
      silentSave !== null && (await getVariantPackages(B)).length === 1,
      silentSave ? `${(await getVariantPackages(B)).length} row(s) left` : "not refused",
    );
    check(
      "an empty save from a page that showed no rows is a clear, and it does clear",
      (await saveVariantPackages(B, [], { drawnRows: 0 })) === 0 &&
        (await getVariantPackages(B)).length === 0,
    );

    /* ---- a carton cannot both travel alone and be merged ---- */
    await saveVariantPackages(B, [{ ...entered, shipsSeparately: "true", consolidatable: "true" }]);
    const forced = (await getVariantPackages(B))[0];
    check(
      "a row that claims both is stored as travelling alone: the stronger flag wins",
      forced?.shipsSeparately === true && forced?.consolidatable === false,
      `shipsSeparately=${forced?.shipsSeparately}, consolidatable=${forced?.consolidatable}`,
    );
    let contradictionRefused = false;
    try {
      await prisma.variantPackage.update({
        where: { id: forced.id },
        data: { shipsSeparately: true, consolidatable: true },
      });
    } catch {
      contradictionRefused = true;
    }
    const stillForced = await prisma.variantPackage.findUnique({ where: { id: forced.id } });
    check(
      "and the database itself refuses the contradictory pair, even written by hand",
      contradictionRefused && stillForced?.consolidatable === false,
      contradictionRefused ? "refused by the constraint" : "accepted",
    );

    /* -------------------------------------------------------------------- */
    /* H. Two items, two parcels                                              */
    /* -------------------------------------------------------------------- */
    /**
     * "Quantity 2 → two packages with their own dimensions and gross weights."
     * The parcel count is what a carrier books, so this pins the arithmetic
     * that produces it and the assertion that nothing is dropped on the way:
     * every line asked about is either carried or refused with a reason, and
     * the parcelled total matches the per-line totals.
     */
    const packTwo = await saveVariantPackages(B, [
      {
        label: "Item box",
        packageType: "carton",
        length: "24",
        width: "18",
        height: "6",
        dimensionUnit: "in",
        grossWeight: "2.5",
        weightUnit: "lb",
        unitsPerPackage: "1",
        packagesPerUnit: "1",
        shipsSeparately: "true",
      },
      {
        label: "Outer box",
        packageType: "carton",
        length: "30",
        width: "20",
        height: "10",
        dimensionUnit: "cm",
        grossWeight: "1",
        weightUnit: "kg",
        unitsPerPackage: "1",
        packagesPerUnit: "1",
      },
    ]);
    const plan = await resolvePackagesForLines([
      { orderItemId: "line-B", sku: "VERIFY-B", quantity: 2, variantId: B },
    ]);
    check("both carton rows were stored for the item", packTwo === 2, `${packTwo} row(s)`);
    check(
      "quantity 2 of a two-box item is four parcels, each described in its own right",
      plan.packages.length === 2 &&
        plan.packages.every((p) => p.count === 2) &&
        plan.covered.length === 1 &&
        plan.covered[0].parcels === 4,
      plan.packages.map((p) => `${p.count}× ${p.length}×${p.width}×${p.height}`).join(" | "),
    );
    check(
      "no parcel is left out of the count the carrier is told",
      plan.packages.reduce((sum, p) => sum + p.count, 0) === plan.covered[0].parcels,
      `${plan.packages.reduce((sum, p) => sum + p.count, 0)} in rows vs ${plan.covered[0].parcels} per line`,
    );
    check(
      "each parcel carries its own dimensions and gross weight, converted once to cm/kg",
      plan.packages[0].length === 60.96 &&
        plan.packages[0].weight === 1.134 &&
        plan.packages[0].units === "cm_kg" &&
        plan.packages[1].length === 30 &&
        plan.packages[1].weight === 1,
      `${plan.packages[0].length}cm/${plan.packages[0].weight}kg and ${plan.packages[1].length}cm/${plan.packages[1].weight}kg`,
    );
    const storedAfterPlan = await getVariantPackages(B);
    check(
      "and the conversion is not written back: the stored row still says 24 in and 2.5 lb",
      storedAfterPlan[0].length === 24 &&
        storedAfterPlan[0].dimensionUnit === "in" &&
        Math.abs(storedAfterPlan[0].grossWeight - 2.5) < 1e-9,
      `${storedAfterPlan[0].length} ${storedAfterPlan[0].dimensionUnit}, ${storedAfterPlan[0].grossWeight} ${storedAfterPlan[0].weightUnit}`,
    );
    check(
      "one parcel travels alone and the other may be merged, and neither parcel mixes the two lines",
      plan.packages[0].shipsSeparately === true &&
        plan.packages[0].consolidatable === false &&
        plan.packages[1].shipsSeparately === false &&
        plan.packages.every((p) => p.lines.length === 1 && p.lines[0].orderItemId === "line-B"),
      plan.packages.map((p) => `ships=${p.shipsSeparately}/merge=${p.consolidatable}`).join(" | "),
    );

    /* ---- two lines on one order ---- */
    const both = await resolvePackagesForLines([
      { orderItemId: "line-A", sku: "VERIFY-A", quantity: 2, variantId: VV },
      { orderItemId: "line-B", sku: "VERIFY-B", quantity: 1, variantId: B },
    ]);
    check(
      "an order of two lines is described by both lines' parcels and by nothing else",
      both.missing.length === 0 &&
        both.covered.length === 2 &&
        both.packages.length === 3 &&
        both.packages.every((p) => p.units === "cm_kg"),
      `${both.packages.length} parcel row(s) over ${both.covered.length} line(s)`,
    );
    check(
      "each parcel is attributed to the line it came from, so a split order can be divided",
      both.packages.filter((p) => p.lines[0].orderItemId === "line-A").length === 1 &&
        both.packages.filter((p) => p.lines[0].orderItemId === "line-B").length === 2,
      both.packages.map((p) => p.lines[0].orderItemId).join(", "),
    );
    check(
      "the fixture line contributes its two units as one parcel count of two",
      both.packages.find((p) => p.lines[0].orderItemId === "line-A")?.count === 2,
      String(both.packages.find((p) => p.lines[0].orderItemId === "line-A")?.count),
    );

    const withUnknown = await resolvePackagesForLines([
      { orderItemId: "line-A", sku: "VERIFY-A", quantity: 1, variantId: VV },
      { orderItemId: "line-X", sku: "VERIFY-NO-PACKAGING", quantity: 1, variantId: "does-not-exist" },
    ]);
    check(
      "a line with no packaging is refused by name rather than quietly left out",
      withUnknown.missing.length === 1 &&
        withUnknown.missing[0].includes("VERIFY-NO-PACKAGING") &&
        withUnknown.packages.every((p) => p.lines[0].orderItemId !== "line-X"),
      withUnknown.missing.join("; "),
    );

    /* ---- what a stored parcel row means, and what happens when it means nothing we know ---- */
    const convertedRow = parcelRowsToQuotePackages([
      { id: "row-imperial", shipmentId: null, count: 1, length: 24, width: 18, height: 6, weight: 2.5, units: "in_lb" },
    ]);
    check(
      "a parcel row recorded in inches and pounds is converted, not passed through",
      convertedRow.refused.length === 0 &&
        convertedRow.packages.length === 1 &&
        convertedRow.packages[0].length === 60.96 &&
        convertedRow.packages[0].weight === 1.134 &&
        convertedRow.packages[0].units === "cm_kg",
      `${convertedRow.packages[0]?.length}cm / ${convertedRow.packages[0]?.weight}kg`,
    );
    const unknownUnit = parcelRowsToQuotePackages([
      { id: "row-metric-mm", shipmentId: null, count: 1, length: 600, width: 400, height: 300, weight: 12, units: "mm_kg" },
    ]);
    check(
      "a parcel row in a unit this system does not convert is refused by name, never sent as-is",
      unknownUnit.packages.length === 0 &&
        unknownUnit.refused.length === 1 &&
        unknownUnit.refused[0].includes("row-metric-mm") &&
        unknownUnit.refused[0].includes("mm_kg"),
      unknownUnit.refused.join("; "),
    );

    /* ---- the quote path reads a stored row the same way the booking does ---- */
    const manualQuote = await buildQuotePackagesForOrder({
      items: [],
      packages: [
        { id: "row-imperial", count: 1, length: 24, width: 18, height: 6, weight: 2.5, units: "in_lb" },
      ],
    });
    check(
      "a quote for a stored parcel converts it exactly as a booking would, so the two cannot disagree",
      manualQuote.missing.length === 0 &&
        manualQuote.packages.length === 1 &&
        manualQuote.packages[0].length === 60.96 &&
        manualQuote.packages[0].weight === 1.134,
      `${manualQuote.packages[0]?.length}cm / ${manualQuote.packages[0]?.weight}kg`,
    );
    const unreadableQuote = await buildQuotePackagesForOrder({
      items: [],
      packages: [
        { id: "row-metric-mm", count: 1, length: 600, width: 400, height: 300, weight: 12, units: "mm_kg" },
      ],
    });
    check(
      "and a quote is refused with the reason when a parcel row's unit cannot be read",
      unreadableQuote.packages.length === 0 &&
        unreadableQuote.missing.some((reason) => reason.includes("row-metric-mm")),
      unreadableQuote.missing.join("; "),
    );
  } finally {
    for (const id of madeVariants) {
      await prisma.variantPackage.deleteMany({ where: { variantId: id } });
      await prisma.productVariant.deleteMany({ where: { id } });
    }
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
