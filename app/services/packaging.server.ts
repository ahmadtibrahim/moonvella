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
  const problems: string[] = [];
  const name = row.label ? String(row.label) : `package ${index + 1}`;

  for (const field of REQUIRED_NUMERIC_FIELDS) {
    const raw = row[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      problems.push(`${name}: ${field} is required`);
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      problems.push(`${name}: ${field} is not a number`);
    } else if (value <= 0) {
      problems.push(`${name}: ${field} must be greater than zero`);
    }
  }

  const declared = row.declaredValue;
  if (declared !== undefined && declared !== null && String(declared).trim() !== "") {
    const value = Number(declared);
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`${name}: declared value cannot be negative`);
    }
  }

  return problems;
}

function packageData(row: PackageRowInput, sortOrder: number) {
  const declared =
    row.declaredValue === undefined || row.declaredValue === null || String(row.declaredValue).trim() === ""
      ? null
      : Math.round(Number(row.declaredValue) * 100);
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
    shipsSeparately: row.shipsSeparately === true || row.shipsSeparately === "true",
    // Consolidation defaults to allowed, so a row that predates the column and a
    // row that has never been asked both behave the way they always did.
    consolidatable: !(row.consolidatable === false || row.consolidatable === "false"),
    sortOrder,
  };
}

export class PackageValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Packaging is incomplete: ${problems.join("; ")}`);
    this.name = "PackageValidationError";
    this.problems = problems;
  }
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
export async function saveVariantPackages(variantId: string, rows: PackageRowInput[]) {
  const problems = rows.flatMap((row, index) => validatePackageRow(row, index));
  if (problems.length > 0) throw new PackageValidationError(problems);

  await prisma.$transaction([
    prisma.variantPackage.deleteMany({ where: { variantId } }),
    ...rows.map((row, index) =>
      prisma.variantPackage.create({ data: { variantId, ...packageData(row, index) } })
    ),
  ]);
  return rows.length;
}

export async function saveProductPackages(productId: string, rows: PackageRowInput[]) {
  const problems = rows.flatMap((row, index) => validatePackageRow(row, index));
  if (problems.length > 0) throw new PackageValidationError(problems);

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
  packages?: { count: number; length: number; width: number; height: number; weight: number; units: string }[];
}): Promise<{ packages: QuotePackage[]; missing: string[]; source: "manual" | "variant" | "product" }> {
  if (order.packages && order.packages.length > 0) {
    return {
      packages: order.packages.map((p) => ({
        count: p.count,
        length: p.length,
        width: p.width,
        height: p.height,
        weight: p.weight,
        units: p.units,
      })),
      missing: [],
      source: "manual",
    };
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

export interface PackageSnapshotRow extends QuotePackage {
  packageType: string;
  label: string | null;
  description: string | null;
  shipsSeparately: boolean;
  consolidatable: boolean;
  /** Which order lines, and how many of each, this package carries. */
  lines: { orderItemId: string; sku: string; quantity: number }[];
}

/**
 * Freeze the packages a shipment was quoted with.
 *
 * A quotation is an offer against a described parcel. If the packaging is
 * edited afterwards the offer no longer describes anything real, so the rows
 * that were sent are stored beside the quote rather than recomputed from the
 * current state — otherwise a later reproduction of the same quote would use
 * different dimensions and nobody could explain the difference in price.
 *
 * Quantity is allocated by order line, and the allocation is exact: every unit
 * of every line appears in exactly one package row. `packagesPerUnit` is how a
 * seller describes "one sold unit ships as two parcels", so it multiplies here
 * and nowhere else.
 */
export async function snapshotQuotePackages(
  items: { orderItemId: string; sku: string; quantity: number; variantId: string | null }[],
  options: { includeInherited?: boolean } = {}
): Promise<{ packages: PackageSnapshotRow[]; missing: string[] }> {
  const missing: string[] = [];
  const packages: PackageSnapshotRow[] = [];

  for (const item of items) {
    if (!item.variantId) {
      missing.push(`${item.sku}: no variant mapping`);
      continue;
    }
    const resolved = await resolvePackagesForVariant(item.variantId);
    if (resolved.source === "product" && options.includeInherited === false) {
      missing.push(`${item.sku}: packaging incomplete`);
      continue;
    }
    if (resolved.packages.length === 0) {
      missing.push(`${item.sku}: packaging incomplete`);
      continue;
    }
    for (const p of resolved.packages) {
      packages.push({
        count: item.quantity * p.packagesPerUnit,
        length: round2(toCm(p.length, p.dimensionUnit)),
        width: round2(toCm(p.width, p.dimensionUnit)),
        height: round2(toCm(p.height, p.dimensionUnit)),
        weight: round3(toKg(p.grossWeight, p.weightUnit)),
        units: "cm_kg",
        packageType: p.packageType,
        label: p.label,
        description: p.description,
        shipsSeparately: p.shipsSeparately,
        consolidatable: p.consolidatable,
        lines: [
          {
            orderItemId: item.orderItemId,
            sku: item.sku,
            quantity: item.quantity * p.packagesPerUnit,
          },
        ],
      });
    }
  }

  return { packages, missing };
}
