import { prisma } from "~/db.server";

export function toCm(value: number, unit: string): number {
  return unit === "in" ? value * 2.54 : value;
}
export function toKg(value: number, unit: string): number {
  return unit === "lb" ? value * 0.45359237 : value;
}

export async function listPresets() {
  return prisma.packagingPreset.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
}

export async function getVariantPackages(variantId: string) {
  return prisma.variantPackage.findMany({ where: { variantId }, orderBy: { sortOrder: "asc" } });
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
}

export async function saveVariantPackages(variantId: string, rows: PackageRowInput[]) {
  const clean = rows.filter((r) => r.length !== "" && r.width !== "" && r.height !== "" && r.grossWeight !== "");
  await prisma.$transaction([
    prisma.variantPackage.deleteMany({ where: { variantId } }),
    ...clean.map((r, i) =>
      prisma.variantPackage.create({
        data: {
          variantId,
          label: r.label ? String(r.label) : null,
          packageType: r.packageType ? String(r.packageType) : "carton",
          presetId: r.presetId ? String(r.presetId) : null,
          length: Number(r.length),
          width: Number(r.width),
          height: Number(r.height),
          dimensionUnit: r.dimensionUnit === "in" ? "in" : "cm",
          grossWeight: Number(r.grossWeight),
          weightUnit: r.weightUnit === "lb" ? "lb" : "kg",
          unitsPerPackage: Math.max(1, Number(r.unitsPerPackage || 1)),
          packagesPerUnit: Math.max(1, Number(r.packagesPerUnit || 1)),
          sortOrder: i,
        },
      })
    ),
  ]);
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
    }))
  );
  return rows.length;
}

export async function validateVariantPackaging(variantId: string) {
  const pkgs = await getVariantPackages(variantId);
  const missing: string[] = [];
  if (pkgs.length === 0) missing.push("no package rows");
  for (const p of pkgs) {
    const name = p.label || p.id;
    if (!(p.length > 0)) missing.push(`${name}: length`);
    if (!(p.width > 0)) missing.push(`${name}: width`);
    if (!(p.height > 0)) missing.push(`${name}: height`);
    if (!(p.grossWeight > 0)) missing.push(`${name}: gross weight`);
  }
  return { complete: missing.length === 0, missing, packageCount: pkgs.length };
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
}): Promise<{ packages: QuotePackage[]; missing: string[]; source: "manual" | "variant" }> {
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
  for (const item of order.items) {
    if (!item.variantId) {
      missing.push(`${item.sku}: no variant mapping`);
      continue;
    }
    const rows = await getVariantPackages(item.variantId);
    if (rows.length === 0) {
      missing.push(`${item.sku}: packaging incomplete`);
      continue;
    }
    for (const p of rows) {
      packages.push({
        count: item.quantity * p.packagesPerUnit,
        length: Number(toCm(p.length, p.dimensionUnit).toFixed(2)),
        width: Number(toCm(p.width, p.dimensionUnit).toFixed(2)),
        height: Number(toCm(p.height, p.dimensionUnit).toFixed(2)),
        weight: Number(toKg(p.grossWeight, p.weightUnit).toFixed(3)),
        units: "cm_kg",
      });
    }
  }
  return { packages, missing, source: "variant" };
}
