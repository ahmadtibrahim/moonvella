import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY, type AuditInput } from "~/services/audit.server";

/**
 * SHIPPING DIMENSIONS ARE PACKED DIMENSIONS. The product's own length, width,
 * height and weight — `productLengthCm` and friends on ProductVariant — describe
 * the unpacked item as it comes off the shelf, and they are what a catalogue
 * page quotes. They are NOT what a carrier is billed on and must never be
 * substituted for a package: a pillow measured flat is not a pillow in a box,
 * and the difference is volumetric weight. The two sets of numbers live on
 * different columns and this module only ever reads the packaging ones.
 */

/*
 * The converters live in `~/utils/measurementUnits` and are re-exported here,
 * because that module is isomorphic: the admin's unit preference is resolved in
 * a route and rendered in a component, and neither can import a `.server`
 * module. The definitions moved; the names did not, so every existing import
 * from this file still resolves to the same function.
 *
 * One home for the constants is the point. A second copy of 2.54 is how a
 * conversion ends up disagreeing with itself, and the display layer beside
 * these (`ui.tsx`) already carries its own for rendering — a third was not
 * going to make anything truer.
 */
import {
  fromCm,
  fromKg,
  round2,
  round3,
  toCm,
  toKg,
} from "~/utils/measurementUnits";

export { fromCm, fromKg, toCm, toKg };

/**
 * Conversions are exact both ways, and the guarantee is worth stating because
 * it is easy to lose.
 *
 * The failure this prevents: enter 24 in, store the canonical 60.96 cm rounded
 * to 2 places, edit the row later, display it back in inches as 24.0000 — fine
 * — but do it a few times and 24 becomes 23.9998, then 23.9996. Nothing
 * alerts; the label is simply wrong by a fraction of an inch until it is wrong
 * by enough.
 *
 * The rule that avoids it: a value keeps the unit it was entered in and is
 * converted ONCE, at the boundary that needs the other unit. These helpers
 * therefore never round. Rounding is the caller's decision and happens last,
 * on a value that is then sent and not stored.
 *
 * The tolerance is a comparison aid for tests and for the UI's "unchanged"
 * check; it is not applied to a stored value.
 */
export const ROUND_TRIP_EPSILON = 1e-9;

export function roundTripPreserved(entered: number, unit: string, kind: "length" | "weight"): boolean {
  const canonical = kind === "length" ? toCm(entered, unit) : toKg(entered, unit);
  const back = kind === "length" ? fromCm(canonical, unit) : fromKg(canonical, unit);
  return Math.abs(back - entered) <= ROUND_TRIP_EPSILON * Math.max(1, Math.abs(entered));
}

export async function listPresets() {
  return prisma.packagingPreset.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
}

/**
 * Every pack, retired ones included, for the dropdowns that offer one.
 *
 * Retired packs are in this list on purpose and it is not a leak: a carton row
 * that was filled from a pack before it was retired still points at it, and a
 * dropdown that could not show the row's own choice would silently reassign it
 * to whatever option happens to be first. The forms mark a retired pack and
 * refuse to offer it to a row that has not already chosen it; the filtering is
 * the form's job, and it can only do it with the row present.
 */
export async function listPresetsForChoice() {
  return prisma.packagingPreset.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] });
}

export async function getVariantPackages(variantId: string) {
  return prisma.variantPackage.findMany({ where: { variantId }, orderBy: { sortOrder: "asc" } });
}

export async function getProductPackages(productId: string) {
  return prisma.productPackage.findMany({ where: { productId }, orderBy: { sortOrder: "asc" } });
}

export interface PackageRowInput {
  label?: string | null;
  packageType?: string;
  presetId?: string | null;
  length: number | string;
  width: number | string;
  height: number | string;
  dimensionUnit?: string;
  grossWeight: number | string;
  weightUnit?: string;
  unitsPerPackage?: number | string;
  packagesPerUnit?: number | string;
  description?: string | null;
  declaredValue?: number | string | null;
  shipsSeparately?: boolean | string;
  consolidatable?: boolean | string;
}

/** The four numbers a package cannot be quoted without. */
const REQUIRED_NUMERIC_FIELDS = ["length", "width", "height", "grossWeight"] as const;

/**
 * One field of one submitted row, and what is wrong with it.
 *
 * The index and the field are what let the editor put the message under the
 * control that produced it; the message is what the operator reads. Both are
 * carried because neither is derivable from the other — the message names the
 * carton the way a person does, and the editor needs to know which row it is in.
 */
export interface PackageProblem {
  index: number;
  field: string;
  message: string;
}

/**
 * What a field is called in front of an operator.
 *
 * The column names are not words: "grossWeight is required" names a database
 * column to somebody who is looking at a form, and the fix has to be obvious
 * from the sentence.
 */
const FIELD_LABEL: Record<string, string> = {
  length: "Length",
  width: "Width",
  height: "Height",
  grossWeight: "Gross weight",
  declaredValue: "Declared value",
};

/**
 * Field-level validation, returning every problem rather than the first.
 *
 * A row of zeros is rejected rather than stored. Zero is what an unfilled
 * number input submits, and a package 0 × 0 × 0 weighing 0 is accepted by a
 * quote API and priced as if it were nothing — the resulting number is wrong
 * in a way that looks like a very good deal. Negative values are rejected for
 * the same reason and one more: a negative weight can reduce an order total.
 *
 * Values are checked as entered, in the row's own unit, so the message quotes
 * the number the operator typed rather than a converted one they have to
 * reverse.
 */
export function validatePackageRow(row: PackageRowInput, index: number): string[] {
  return packageProblems(row, index).map((problem) => problem.message);
}

/**
 * The same validation, addressed to the field that failed.
 *
 * `validatePackageRow` above is this function's messages alone, kept because a
 * screen that only has to refuse does not care which control to blame. A screen
 * that has to show the operator where to type does, so the editor is handed the
 * whole problem.
 */
export function packageProblems(row: PackageRowInput, index: number): PackageProblem[] {
  const problems: PackageProblem[] = [];
  const name = row.label ? String(row.label) : `package ${index + 1}`;
  const described = (field: string) => `${name}: ${FIELD_LABEL[field] ?? field}`;

  for (const field of REQUIRED_NUMERIC_FIELDS) {
    const raw = row[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      problems.push({ index, field, message: `${described(field)} is required` });
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      problems.push({ index, field, message: `${described(field)} is not a number` });
    } else if (value <= 0) {
      problems.push({ index, field, message: `${described(field)} must be greater than zero` });
    }
  }

  const declared = row.declaredValue;
  if (declared !== undefined && declared !== null && String(declared).trim() !== "") {
    const value = Number(declared);
    if (!Number.isFinite(value) || value < 0) {
      problems.push({ index, field: "declaredValue", message: `${described("declaredValue")} cannot be negative` });
    }
  }

  return problems;
}

function packageData(row: PackageRowInput, sortOrder: number) {
  const declared =
    row.declaredValue === undefined || row.declaredValue === null || String(row.declaredValue).trim() === ""
      ? null
      : Math.round(Number(row.declaredValue) * 100);
  const { shipsSeparately, consolidatable } = packageFlags(row);
  return {
    label: row.label ? String(row.label) : null,
    packageType: row.packageType ? String(row.packageType) : "carton",
    presetId: row.presetId ? String(row.presetId) : null,
    length: Number(row.length),
    width: Number(row.width),
    height: Number(row.height),
    dimensionUnit: row.dimensionUnit === "in" ? "in" : "cm",
    grossWeight: Number(row.grossWeight),
    weightUnit: row.weightUnit === "lb" ? "lb" : "kg",
    unitsPerPackage: Math.max(1, Number(row.unitsPerPackage || 1)),
    packagesPerUnit: Math.max(1, Number(row.packagesPerUnit || 1)),
    description: row.description ? String(row.description) : null,
    declaredValue: declared,
    shipsSeparately: shipsSeparately,
    consolidatable: consolidatable,
    sortOrder,
  };
}

/**
 * The two flags, made incapable of contradicting each other.
 *
 * "This box travels on its own" and "this box may be merged with another" are
 * opposites, and a row holding both is a row no packer can obey. The page
 * prevents the pair from being entered — checking the first unchecks and
 * disables the second — but a page is not a guarantee: a stale document, a
 * hand-written form or a direct call all reach this function, and the rules
 * that matter have to hold wherever the row came from.
 *
 * SHIPS-SEPARATELY WINS. It is the stronger statement and the safer reading:
 * the cost of honouring it wrongly is one parcel travelling alone, and the cost
 * of ignoring it is two parcels the seller said must not be combined arriving
 * as one. The database carries the same rule as a CHECK constraint, so a row
 * that contradicts itself cannot be written even by something that does not go
 * through here.
 */
function packageFlags(row: PackageRowInput): { shipsSeparately: boolean; consolidatable: boolean } {
  const shipsSeparately = row.shipsSeparately === true || row.shipsSeparately === "true";
  if (shipsSeparately) return { shipsSeparately: true, consolidatable: false };
  // A row that does not travel alone may be merged, and defaults to being
  // mergeable: that is the ordinary box, and it is what the column meant before
  // this rule existed.
  return {
    shipsSeparately: false,
    consolidatable: !(row.consolidatable === false || row.consolidatable === "false"),
  };
}

export class PackageValidationError extends Error {
  readonly problems: string[];
  readonly details: PackageProblem[];
  constructor(details: PackageProblem[]) {
    const problems = details.map((problem) => problem.message);
    super(`Packaging is incomplete: ${problems.join("; ")}`);
    this.name = "PackageValidationError";
    this.problems = problems;
    this.details = details;
  }
}

/**
 * What the form that sent these rows said about itself.
 *
 * `drawnRows` is the number of rows the page had on it when it was submitted —
 * a hidden field the editors render, and the only way to tell "the operator
 * removed every row and saved" apart from "the rows never arrived".
 */
export interface SavePackagesOptions {
  drawnRows?: number;
}

/**
 * Refuse a save that would delete every row without anybody asking it to.
 *
 * Both saves are whole-set replaces, so an empty submission is a delete of the
 * entire set. That is a legitimate operation — the product's packaging editor
 * can remove its last default row — but only when the form that sent it had no
 * rows to send. A form that drew rows and submitted none has lost them on the
 * way, and the difference between those two cases is the only thing standing
 * between a stale page and a variant that quietly has no packaging.
 *
 * A form that cannot say how many rows it drew is treated as having drawn some,
 * because the two mistakes do not cost the same: refusing a legitimate clear
 * costs one retry, and allowing an accidental one costs the packaging. This is
 * the case the deployed build was in — a bundle from before the hidden field
 * existed posted a form whose packaging controls were not in it at all, and the
 * replace deleted the rows and reported success.
 */
function assertClearWasIntended(submitted: number, drawnRows: number | undefined) {
  if (submitted > 0 || drawnRows === 0) return;

  throw new PackageValidationError([
    {
      index: -1,
      field: "pkg_rowCount",
      message:
        drawnRows === undefined
          ? "No carton rows arrived with this save, and the page could not say how many it showed. Nothing has been changed — reload the page and try again."
          : `This save carried no carton rows, but the page showed ${drawnRows}. Nothing has been changed — reload the page and try again.`,
    },
  ]);
}

/**
 * Replace a variant's package rows.
 *
 * Rows are rejected as a set, before anything is deleted. The previous version
 * filtered out incomplete rows and saved the rest, which turned a mistyped
 * weight into a silently package-less variant — the packaging looked saved and
 * quoting then failed somewhere else entirely. Throwing here keeps the failure
 * next to its cause.
 */
export async function saveVariantPackages(
  variantId: string,
  rows: PackageRowInput[],
  options: SavePackagesOptions = {}
) {
  const problems = rows.flatMap((row, index) => packageProblems(row, index));
  if (problems.length > 0) throw new PackageValidationError(problems);
  assertClearWasIntended(rows.length, options.drawnRows);

  await prisma.$transaction([
    prisma.variantPackage.deleteMany({ where: { variantId } }),
    ...rows.map((row, index) =>
      prisma.variantPackage.create({ data: { variantId, ...packageData(row, index) } })
    ),
  ]);
  return rows.length;
}

export async function saveProductPackages(
  productId: string,
  rows: PackageRowInput[],
  options: SavePackagesOptions = {}
) {
  const problems = rows.flatMap((row, index) => packageProblems(row, index));
  if (problems.length > 0) throw new PackageValidationError(problems);
  assertClearWasIntended(rows.length, options.drawnRows);

  await prisma.$transaction([
    prisma.productPackage.deleteMany({ where: { productId } }),
    ...rows.map((row, index) =>
      prisma.productPackage.create({ data: { productId, ...packageData(row, index) } })
    ),
  ]);
  return rows.length;
}

export async function copyVariantPackaging(fromVariantId: string, toVariantId: string) {
  const rows = await getVariantPackages(fromVariantId);
  await saveVariantPackages(
    toVariantId,
    rows.map((r) => ({
      label: r.label,
      packageType: r.packageType,
      presetId: r.presetId,
      length: r.length,
      width: r.width,
      height: r.height,
      dimensionUnit: r.dimensionUnit,
      grossWeight: r.grossWeight,
      weightUnit: r.weightUnit,
      unitsPerPackage: r.unitsPerPackage,
      packagesPerUnit: r.packagesPerUnit,
      // The newer columns are carried too. A copy that silently dropped the
      // declared value or the "ships separately" flag would produce a variant
      // that looks identical on the form and quotes differently.
      description: r.description,
      declaredValue: r.declaredValue === null ? null : r.declaredValue / 100,
      shipsSeparately: r.shipsSeparately,
      consolidatable: r.consolidatable,
    }))
  );
  return rows.length;
}

/* -------------------------------------------------------------------------- *
 * The packs a carton row can be filled from.
 * -------------------------------------------------------------------------- */

/**
 * A SAVED CARTON IS A MEASUREMENT, NOT A PRICE. A pack records the dimensions
 * of a box the operator buys in quantity, so the same box does not have to be
 * typed onto every variant that ships in it. It carries what the empty box
 * weighs and the most it is rated to hold, and neither of those is the parcel's
 * weight: the gross weight of a shipment depends on what is inside, so it stays
 * on the row and the pack never supplies it.
 *
 * The numbers keep the unit they were entered in, exactly as a carton row does,
 * because that is the unit they were measured in. A pack saved in centimetres
 * reads correctly on a page set to inches — the conversion happens in the
 * display layer, once, and the stored figure does not move.
 */
export interface PresetInput {
  name?: string | null;
  packageType?: string | null;
  length?: number | string | null;
  width?: number | string | null;
  height?: number | string | null;
  dimensionUnit?: string | null;
  emptyWeight?: number | string | null;
  weightUnit?: string | null;
  maxWeight?: number | string | null;
  isActive?: boolean | string;
}

export class PresetValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The pack could not be saved: ${problems.join("; ")}`);
    this.name = "PresetValidationError";
    this.problems = problems;
  }
}

/**
 * Every reason a pack is not savable, returned together.
 *
 * The name is checked case-insensitively against the others even though the
 * column's constraint is not: two packs called "Small carton" and "small
 * carton" are one pack to everybody reading a dropdown, and the second one is
 * always a mistake. Refusing it here says so in a sentence; letting the
 * database refuse it would say it in a stack trace.
 */
export function validatePreset(input: PresetInput, otherNames: string[]): string[] {
  const problems: string[] = [];
  const name = String(input.name ?? "").trim();

  if (!name) {
    problems.push("a pack needs a name");
  } else if (otherNames.some((other) => other.trim().toLowerCase() === name.toLowerCase())) {
    problems.push(`"${name}" is already the name of another pack`);
  }

  for (const field of ["length", "width", "height"] as const) {
    const raw = input[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      problems.push(`${field} is required`);
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) problems.push(`${field} is not a number`);
    else if (value <= 0) problems.push(`${field} must be greater than zero`);
  }

  const empty = optionalWeight(input.emptyWeight);
  if (empty === "not a number") problems.push("the empty weight is not a number");
  else if (typeof empty === "number" && empty < 0) problems.push("the empty weight cannot be negative");

  const max = optionalWeight(input.maxWeight);
  if (max === "not a number") problems.push("the maximum weight is not a number");
  else if (typeof max === "number" && max < 0) problems.push("the maximum weight cannot be negative");

  if (typeof empty === "number" && typeof max === "number" && max < empty) {
    problems.push("a pack cannot hold less than it weighs empty");
  }

  return problems;
}

/** A weight the operator may leave blank, read as a number or as a refusal. */
function optionalWeight(raw: number | string | null | undefined): number | null | "not a number" {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : "not a number";
}

/**
 * The row a pack is stored as. Every caller has validated first, so the "not a
 * number" case the reader above can return is unreachable here and is stored as
 * "not recorded" rather than as a NaN the column would keep.
 */
function presetData(input: PresetInput) {
  const empty = optionalWeight(input.emptyWeight);
  const max = optionalWeight(input.maxWeight);
  return {
    name: String(input.name ?? "").trim(),
    packageType: input.packageType ? String(input.packageType) : "carton",
    length: Number(input.length),
    width: Number(input.width),
    height: Number(input.height),
    dimensionUnit: input.dimensionUnit === "in" ? "in" : "cm",
    emptyWeight: typeof empty === "number" ? empty : null,
    weightUnit: input.weightUnit === "lb" ? "lb" : "kg",
    maxWeight: typeof max === "number" ? max : null,
    isActive: !(input.isActive === false || input.isActive === "false"),
  };
}

/**
 * Every pack, active and retired, with how many carton rows point at each.
 *
 * The count is the reason this is not `listPresets`, which is what the packaging
 * editors read: an operator deciding whether to delete a pack needs to know how
 * many rows chose it, and a page that showed the packs without that would make
 * "delete" look like it costs nothing.
 */
export async function listPresetsAll() {
  return prisma.packagingPreset.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { _count: { select: { packages: true, productPackages: true } } },
  });
}

export async function createPreset(
  input: PresetInput,
  actor: Pick<AuditInput, "actorType" | "actorId" | "actorName" | "ipAddress" | "userAgent">,
) {
  const existing = await prisma.packagingPreset.findMany({ select: { name: true } });
  const problems = validatePreset(input, existing.map((row) => row.name));
  if (problems.length > 0) throw new PresetValidationError(problems);

  const created = await prisma.packagingPreset.create({ data: presetData(input) });

  await recordAudit({
    ...actor,
    action: "preset.created",
    entityType: AUDIT_ENTITY.PACKAGING_PRESET,
    entityId: created.id,
    afterData: created,
  });
  return created;
}

export async function updatePreset(
  id: string,
  input: PresetInput,
  actor: Pick<AuditInput, "actorType" | "actorId" | "actorName" | "ipAddress" | "userAgent">,
) {
  const before = await prisma.packagingPreset.findUnique({ where: { id } });
  if (!before) throw new Error("That pack no longer exists.");

  const existing = await prisma.packagingPreset.findMany({
    where: { id: { not: id } },
    select: { name: true },
  });
  const problems = validatePreset(input, existing.map((row) => row.name));
  if (problems.length > 0) throw new PresetValidationError(problems);

  const after = await prisma.packagingPreset.update({ where: { id }, data: presetData(input) });

  await recordAudit({
    ...actor,
    action: "preset.updated",
    entityType: AUDIT_ENTITY.PACKAGING_PRESET,
    entityId: id,
    beforeData: before,
    afterData: after,
  });
  return after;
}

export async function setPresetActive(
  id: string,
  isActive: boolean,
  actor: Pick<AuditInput, "actorType" | "actorId" | "actorName" | "ipAddress" | "userAgent">,
) {
  const before = await prisma.packagingPreset.findUnique({ where: { id } });
  if (!before) throw new Error("That pack no longer exists.");

  const after = await prisma.packagingPreset.update({ where: { id }, data: { isActive } });

  await recordAudit({
    ...actor,
    action: isActive ? "preset.activated" : "preset.deactivated",
    entityType: AUDIT_ENTITY.PACKAGING_PRESET,
    entityId: id,
    beforeData: { isActive: before.isActive },
    afterData: { isActive: after.isActive },
  });
  return after;
}

/**
 * Remove a pack.
 *
 * THE ROWS THAT CHOSE IT KEEP THEIR NUMBERS. The foreign key is ON DELETE SET
 * NULL, so a variant package loses the LINK to the pack and not the dimensions
 * that were copied from it — a carton that had been filled from "Medium carton"
 * still weighs what it weighs. That is what makes deleting safe, and it is why
 * the page can offer it at all: the alternative, refusing to delete a pack that
 * is in use, would leave a mistyped one in every dropdown forever.
 */
export async function deletePreset(
  id: string,
  actor: Pick<AuditInput, "actorType" | "actorId" | "actorName" | "ipAddress" | "userAgent">,
) {
  const before = await prisma.packagingPreset.findUnique({
    where: { id },
    include: { _count: { select: { packages: true, productPackages: true } } },
  });
  if (!before) throw new Error("That pack no longer exists.");

  await prisma.packagingPreset.delete({ where: { id } });

  await recordAudit({
    ...actor,
    action: "preset.deleted",
    entityType: AUDIT_ENTITY.PACKAGING_PRESET,
    entityId: id,
    beforeData: before,
  });
  return { rowsThatKeptTheirNumbers: before._count.packages + before._count.productPackages };
}

/** The package fields every resolution reads, from either table. */
const PACKAGE_SELECT = {
  id: true,
  label: true,
  packageType: true,
  presetId: true,
  length: true,
  width: true,
  height: true,
  dimensionUnit: true,
  grossWeight: true,
  weightUnit: true,
  unitsPerPackage: true,
  packagesPerUnit: true,
  description: true,
  declaredValue: true,
  shipsSeparately: true,
  consolidatable: true,
  sortOrder: true,
} as const;

export interface ResolvedPackages {
  /**
   * Which row answered. "variant" means this variant has its own package rows,
   * "product" means it inherits the product's defaults, "none" means neither
   * exists and quoting must be blocked.
   */
  source: "variant" | "product" | "none";
  packages: {
    id: string;
    label: string | null;
    packageType: string;
    presetId: string | null;
    length: number;
    width: number;
    height: number;
    dimensionUnit: string;
    grossWeight: number;
    weightUnit: string;
    unitsPerPackage: number;
    packagesPerUnit: number;
    description: string | null;
    declaredValue: number | null;
    shipsSeparately: boolean;
    consolidatable: boolean;
    sortOrder: number;
  }[];
  /**
   * The product's default rows, present even when the variant overrides them,
   * so the interface can show what would be inherited and offer a reset. Null
   * when there is no product default to point at.
   */
  productDefault: ResolvedPackages["packages"] | null;
}

/**
 * Resolve packaging for one variant: its own rows, else the product's.
 *
 * INHERITANCE IS WHOLE-ROW, NOT PER-FIELD, and that is a deliberate limit
 * rather than a shortcut. A VariantPackage row carries all four numbers as
 * required columns, so a variant row that inherited only the weight would have
 * to leave its own dimensions null — and a null dimension is exactly the
 * "quoted as nothing" failure the validation above exists to stop. So a
 * variant either has its own complete packaging or it inherits the product's
 * complete packaging, and `productDefault` is returned alongside so the
 * interface can say which and show the difference.
 */
export async function resolvePackagesForVariant(variantId: string): Promise<ResolvedPackages> {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, productId: true },
  });
  if (!variant) return { source: "none", packages: [], productDefault: null };

  const [variantRows, productRows] = await Promise.all([
    prisma.variantPackage.findMany({
      where: { variantId },
      orderBy: { sortOrder: "asc" },
      select: PACKAGE_SELECT,
    }),
    prisma.productPackage.findMany({
      where: { productId: variant.productId },
      orderBy: { sortOrder: "asc" },
      select: PACKAGE_SELECT,
    }),
  ]);

  const productDefault = productRows.length > 0 ? productRows : null;
  if (variantRows.length > 0) {
    return { source: "variant", packages: variantRows, productDefault };
  }
  if (productDefault) return { source: "product", packages: productDefault, productDefault };
  return { source: "none", packages: [], productDefault: null };
}

/**
 * Packaging readiness for one variant, in the shape callers already consume.
 *
 * Kept as a thin wrapper over `resolvePackagesForVariant` so a variant that
 * inherits the product's packaging reports as complete. The previous version
 * read only the variant's own rows, so an inherited product reported "no
 * package rows" and blocked a quote that was perfectly quotable.
 */
export async function validateVariantPackaging(variantId: string) {
  const resolved = await resolvePackagesForVariant(variantId);
  const missing: string[] = [];
  if (resolved.packages.length === 0) {
    missing.push("no package rows");
  }
  for (const p of resolved.packages) {
    const name = p.label || p.id;
    if (!(p.length > 0)) missing.push(`${name}: length`);
    if (!(p.width > 0)) missing.push(`${name}: width`);
    if (!(p.height > 0)) missing.push(`${name}: height`);
    if (!(p.grossWeight > 0)) missing.push(`${name}: gross weight`);
  }
  return {
    complete: missing.length === 0,
    missing,
    packageCount: resolved.packages.length,
    source: resolved.source,
  };
}

export interface QuotePackage {
  count: number;
  length: number;
  width: number;
  height: number;
  weight: number;
  units: string;
}

/**
 * Build eShipper quote packages for an order. Uses owner-entered order packages
 * when present; otherwise derives per-variant package rows (units converted to
 * cm/kg). Never invents dimensions. Returns missing-data reasons so callers can
 * block quoting with specific field errors.
 */
export async function buildQuotePackagesForOrder(order: {
  items: { sku: string; quantity: number; variantId: string | null }[];
  packages?: {
    id?: string;
    shipmentId?: string | null;
    count: number;
    length: number;
    width: number;
    height: number;
    weight: number;
    units: string;
  }[];
}): Promise<{ packages: QuotePackage[]; missing: string[]; source: "manual" | "variant" | "product" }> {
  if (order.packages && order.packages.length > 0) {
    /*
     * THROUGH THE SAME CONVERSION THE BOOKING USES, not around it.
     *
     * These rows used to be handed to the provider exactly as they were stored,
     * including the unit label beside the four numbers — a label the carrier does
     * not read. A row recorded in inches and pounds was therefore QUOTED as
     * though those numbers were centimetres and kilograms: the seller was shown a
     * price for a parcel less than half the size of the one that would later be
     * labelled, and the two documents disagreed without either of them being
     * wrong in isolation. The booking path had already been taught to convert
     * (`parcelRowsToQuotePackages`); this is the other half of the same order, and
     * leaving it behind meant a quote and a label could describe different boxes.
     *
     * A row whose unit label is not one this system converts is refused with the
     * reason rather than sent, so the failure lands on the order desk as a
     * sentence about the parcel instead of as a wrong price from a carrier.
     */
    const { packages, refused } = parcelRowsToQuotePackages(
      order.packages.map((p) => ({
        id: p.id ?? "(parcel row)",
        shipmentId: p.shipmentId ?? null,
        count: p.count,
        length: p.length,
        width: p.width,
        height: p.height,
        weight: p.weight,
        units: p.units,
      })),
    );
    return { packages, missing: refused, source: "manual" };
  }

  const missing: string[] = [];
  const packages: QuotePackage[] = [];
  // The weakest source in play, so a mixed order reports the one an operator
  // most needs to look at rather than whichever variant happened to be first.
  let source: "variant" | "product" = "variant";

  for (const item of order.items) {
    if (!item.variantId) {
      missing.push(`${item.sku}: no variant mapping`);
      continue;
    }
    const resolved = await resolvePackagesForVariant(item.variantId);
    if (resolved.packages.length === 0) {
      missing.push(`${item.sku}: packaging incomplete`);
      continue;
    }
    if (resolved.source === "product") source = "product";

    for (const p of resolved.packages) {
      packages.push({
        count: item.quantity * p.packagesPerUnit,
        // CONVERTED ONCE, ROUNDED ONCE, AND THIS IS THE ONLY ROUNDING. The
        // stored value keeps the unit it was entered in, so entering 24 in and
        // reading 24 in back is exact; the two-place rounding below happens on
        // the way out to a provider that bills in centimetres, and the rounded
        // figure is never written back over the stored one.
        length: round2(toCm(p.length, p.dimensionUnit)),
        width: round2(toCm(p.width, p.dimensionUnit)),
        height: round2(toCm(p.height, p.dimensionUnit)),
        weight: round3(toKg(p.grossWeight, p.weightUnit)),
        units: "cm_kg",
      });
    }
  }
  return { packages, missing, source };
}

/*
 * The rounding those two helpers did is the same rounding the entry form now
 * applies to an imperial measurement, so it comes from the shared module
 * instead of being written out twice.
 */

/**
 * A parcel row stored against an ORDER, as the database holds it.
 *
 * `units` is the row's own record of what its four numbers mean. It is stored
 * with the figures precisely so those figures never have to be guessed at, and
 * this is the one place that record is read.
 */
export interface StoredParcelRow {
  id: string;
  /** The shipment this parcel belongs to, or null while it is unassigned. */
  shipmentId: string | null;
  count: number;
  length: number;
  width: number;
  height: number;
  weight: number;
  units: string;
}

/**
 * What a set of stored parcel rows amounts to in the units a carrier bills in,
 * or the reasons none of it can be sent.
 *
 * THE ROWS ARE NOT SENT VERBATIM, AND THAT IS THE WHOLE POINT. A carrier reads a
 * bare number as centimetres and kilograms; an order parcel row that was stored
 * in inches and pounds would therefore be quoted and labelled as a carton less
 * than half the size it is, and nothing anywhere would report a problem. So the
 * unit a row carries is either one this function knows how to convert, or the
 * row is refused and named.
 *
 * `cm_kg` is this application's own label for centimetres and kilograms and is
 * what every writer stores, so the ordinary case is a pass-through. `in_lb` is
 * converted. EVERYTHING ELSE IS REFUSED — a blank, a typo, a unit somebody adds
 * later without teaching this function about it — because the alternative to
 * refusing is inventing a unit, and an invented unit is a wrong label.
 *
 * A non-empty `refused` means the caller must not send any of it: the parcels
 * are a set, and sending the readable half of a set is how a package goes
 * missing from a booking without anyone deciding to leave it out.
 */
export function parcelRowsToQuotePackages(rows: StoredParcelRow[]): {
  packages: QuotePackage[];
  refused: string[];
} {
  const packages: QuotePackage[] = [];
  const refused: string[] = [];

  for (const row of rows) {
    // The stored label is the row's own word for its numbers; the converters
    // speak in single units, so this is where the two vocabularies meet. It is
    // deliberately a two-branch map with no other way through: a label that is
    // not one of these does not reach a converter at all.
    const unit = String(row.units ?? "").trim().toLowerCase();
    if (unit !== "cm_kg" && unit !== "in_lb") {
      refused.push(
        `parcel ${row.id} is recorded in "${row.units}", which is not a unit this system converts ` +
          `(expected "cm_kg" or "in_lb") — correct the parcel before it is sent to a carrier`,
      );
      continue;
    }
    const dimensionUnit = unit === "in_lb" ? "in" : "cm";
    const weightUnit = unit === "in_lb" ? "lb" : "kg";
    const number = (value: number, kind: "length" | "weight") => {
      const raw = Number(value);
      if (!Number.isFinite(raw)) return null;
      return kind === "length" ? round2(toCm(raw, dimensionUnit)) : round3(toKg(raw, weightUnit));
    };

    const length = number(row.length, "length");
    const width = number(row.width, "length");
    const height = number(row.height, "length");
    const weight = number(row.weight, "weight");
    if (length === null || width === null || height === null || weight === null) {
      refused.push(`parcel ${row.id} has a measurement that is not a number`);
      continue;
    }

    packages.push({
      // A parcel count of zero is not a parcel. The floor of 1 matches what the
      // writers already enforce, so this only catches a hand-edited row.
      count: Math.max(1, Math.floor(Number(row.count) || 1)),
      length,
      width,
      height,
      weight,
      units: "cm_kg",
    });
  }

  return { packages, refused };
}

export interface LinePackageRow extends QuotePackage {
  packageType: string;
  label: string | null;
  description: string | null;
  declaredValue: number | null;
  shipsSeparately: boolean;
  consolidatable: boolean;
  /**
   * Which order line this parcel group describes, and THE WHOLE QUANTITY of it.
   *
   * The quantity is the line's own, not a share of it, and that is not an
   * oversight: when one sold unit needs two different boxes, both boxes carry
   * the whole order line between them — the unit is not split across them, it
   * is packed in both. The row that says which ITEMS are inside a given box is
   * `unitsPerPackage`, and it is the packer's instruction rather than a
   * quantity this module divides up.
   */
  lines: { orderItemId: string; sku: string; quantity: number }[];
  /** The packaging row this came from, so the packing page can point back at it. */
  sourcePackageId: string;
}

/**
 * What one order line's packaging amounts to, in parcels.
 *
 * `parcelsPerUnit` is the number of boxes ONE sold unit needs, which is the sum
 * of its packaging rows' `packagesPerUnit` — two differently-sized boxes each
 * needed once per unit is two parcels per unit, exactly as one row that says
 * "two of these per unit" is. `parcels` is that multiplied by the line's
 * quantity, and it is the number a carrier books.
 */
export interface LinePackagePlanEntry {
  orderItemId: string;
  sku: string;
  quantity: number;
  parcelsPerUnit: number;
  parcels: number;
  source: "variant" | "product";
}

export interface LinePackagePlan {
  /** Every parcel group, already converted to the units a carrier bills in. */
  packages: LinePackageRow[];
  /** Every line that contributed parcels, and how many it contributed. */
  covered: LinePackagePlanEntry[];
  /**
   * Lines that contributed NOTHING, with the reason. A caller that books an
   * order while this is non-empty is booking around a parcel the seller is
   * expecting to be collected.
   */
  missing: string[];
}

export interface PackageLineInput {
  orderItemId: string;
  sku: string;
  quantity: number;
  variantId: string | null;
}

/**
 * Turn order lines into the parcels a carrier will be told about.
 *
 * ONE CONVERSION POINT. A stored row keeps the unit it was entered in; this is
 * where those figures become centimetres and kilograms, once, and the rounded
 * result is what is sent and never written back. Two callers converting in two
 * places is how the same carton ends up 60.96 cm on a quote and 61 cm on a
 * booking.
 *
 * NOTHING IS SILENTLY DROPPED, and that is enforced rather than intended. A
 * line with no packaging goes into `missing`; a line with packaging must appear
 * in `covered` with every one of its boxes; and the assertion at the end fails
 * loudly if a line that was asked about ends up in neither. The failure this
 * prevents is the quiet one — a quote that is cheap because the second parcel
 * was never in it, and a pickup request for a box nobody described.
 *
 * The ORDER of the rows is the order of the lines and then the order of each
 * variant's packaging rows, which is stable for a given order, so a stored
 * package snapshot and a freshly derived plan of an unchanged order agree
 * element for element.
 */
export async function resolvePackagesForLines(
  items: PackageLineInput[],
  options: { includeInherited?: boolean } = {}
): Promise<LinePackagePlan> {
  const uncovered: { orderItemId: string; reason: string }[] = [];
  const packages: LinePackageRow[] = [];
  const covered: LinePackagePlanEntry[] = [];

  for (const item of items) {
    if (item.quantity <= 0) continue;
    const refuse = (reason: string) => uncovered.push({ orderItemId: item.orderItemId, reason });

    if (!item.variantId) {
      refuse(`${item.sku}: no variant mapping`);
      continue;
    }

    const resolved = await resolvePackagesForVariant(item.variantId);
    if (resolved.source === "none" || resolved.packages.length === 0) {
      refuse(`${item.sku}: packaging incomplete`);
      continue;
    }
    if (resolved.source === "product" && options.includeInherited === false) {
      refuse(`${item.sku}: packaging incomplete`);
      continue;
    }
    // Read once and narrowed here rather than trusted later: `none` with rows
    // present would mean the resolver contradicts itself, and it is better for
    // that to be impossible to express than to be handled.
    const source: "variant" | "product" = resolved.source === "product" ? "product" : "variant";

    const parcelsPerUnit = resolved.packages.reduce(
      (sum, p) => sum + Math.max(1, p.packagesPerUnit),
      0
    );

    for (const p of resolved.packages) {
      packages.push({
        count: item.quantity * Math.max(1, p.packagesPerUnit),
        // CONVERTED ONCE, ROUNDED ONCE, AND THIS IS THE ONLY ROUNDING. The
        // stored value keeps the unit it was entered in, so entering 24 in and
        // reading 24 in back is exact; the rounding below happens on the way
        // out to a provider that bills in centimetres, and the rounded figure
        // is never written back over the stored one.
        length: round2(toCm(p.length, p.dimensionUnit)),
        width: round2(toCm(p.width, p.dimensionUnit)),
        height: round2(toCm(p.height, p.dimensionUnit)),
        weight: round3(toKg(p.grossWeight, p.weightUnit)),
        units: "cm_kg",
        packageType: p.packageType,
        label: p.label,
        description: p.description,
        declaredValue: p.declaredValue,
        shipsSeparately: p.shipsSeparately,
        consolidatable: p.consolidatable,
        lines: [{ orderItemId: item.orderItemId, sku: item.sku, quantity: item.quantity }],
        sourcePackageId: p.id,
      });
    }

    covered.push({
      orderItemId: item.orderItemId,
      sku: item.sku,
      quantity: item.quantity,
      parcelsPerUnit,
      parcels: item.quantity * parcelsPerUnit,
      source,
    });
  }

  assertPlanCoversItems(items, packages, covered, uncovered);
  return { packages, covered, missing: uncovered.map((u) => u.reason) };
}

/**
 * A line is either accounted for in parcels or refused with a reason. Never
 * neither, and never both.
 *
 * This is the "do not silently omit a package" guarantee written as a check
 * rather than as a comment. It is a cheap comparison over data already in hand,
 * and it runs on every plan, so the day somebody adds a `continue` to the loop
 * above without adding a `missing.push`, the failure is a thrown error at the
 * call site instead of a shipment with one parcel fewer than the seller sold.
 */
function assertPlanCoversItems(
  items: PackageLineInput[],
  packages: LinePackageRow[],
  covered: LinePackagePlanEntry[],
  uncovered: { orderItemId: string; reason: string }[]
) {
  const shippable = items.filter((item) => item.quantity > 0);
  const accounted = new Set([
    ...covered.map((entry) => entry.orderItemId),
    ...uncovered.map((entry) => entry.orderItemId),
  ]);

  // 1. EVERY line asked about is either carried or refused, exactly once.
  for (const item of shippable) {
    const times = Number(covered.some((c) => c.orderItemId === item.orderItemId)) +
      uncovered.filter((u) => u.orderItemId === item.orderItemId).length;
    if (times === 0) {
      throw new Error(
        `Packaging plan is incomplete: order line ${item.sku} contributed no parcel and no reason. ` +
          `Refusing to quote or book a shipment that does not describe what was sold.`
      );
    }
    if (times > 1) {
      throw new Error(
        `Packaging plan is inconsistent: order line ${item.sku} is accounted for ${times} times.`
      );
    }
  }
  for (const id of accounted) {
    if (!shippable.some((item) => item.orderItemId === id)) {
      throw new Error(`Packaging plan is inconsistent: unknown order line ${id}.`);
    }
  }

  // 2. A covered line has the parcels it claims, and every parcel reaches a
  //    covered line. The two halves of the plan have to agree.
  const withParcels = new Map<string, number>();
  for (const row of packages) {
    for (const line of row.lines) {
      withParcels.set(line.orderItemId, (withParcels.get(line.orderItemId) ?? 0) + row.count);
    }
  }
  for (const entry of covered) {
    const parcels = withParcels.get(entry.orderItemId) ?? 0;
    if (parcels !== entry.parcels) {
      throw new Error(
        `Packaging plan is inconsistent: line ${entry.sku} is reported as ${entry.parcels} parcel(s) ` +
          `but describes ${parcels}.`
      );
    }
    if (entry.parcels <= 0) {
      throw new Error(`Packaging plan is inconsistent: line ${entry.sku} covers no parcels.`);
    }
  }
  for (const id of withParcels.keys()) {
    if (!covered.some((entry) => entry.orderItemId === id)) {
      throw new Error(
        `Packaging plan is inconsistent: order line ${id} has parcel rows but is not reported as covered.`
      );
    }
  }
}
