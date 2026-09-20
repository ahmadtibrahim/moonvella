import { prisma } from "~/db.server";
import type { SellerContext } from "./seller.server";

export interface PublicCatalogProduct {
  id: string;
  name: string;
  description: string | null;
  category: string;
  image: string | null;
  availability: "AVAILABLE" | "UNAVAILABLE";
}

export interface ApprovedCatalogVariant {
  id: string;
  sku: string;
  name: string;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  inventory: number;
  isActive: boolean;
}

export interface ApprovedCatalogProduct extends PublicCatalogProduct {
  sku: string;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  estimatedProfit: number;
  inventory: number;
  variants: ApprovedCatalogVariant[];
}

export type CatalogProduct = PublicCatalogProduct | ApprovedCatalogProduct;

function parseImages(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Returns the MoonVella catalog for a seller. Protected commercial fields
 * (wholesale cost, suggested retail, profit, exact inventory and variant
 * pricing) are *omitted from the returned objects* unless the seller is
 * approved, so they never reach a pending seller's response payload.
 */
export async function listCatalog(
  context: Pick<SellerContext, "canViewWholesale">
): Promise<CatalogProduct[]> {
  const products = await prisma.product.findMany({
    where: { isActive: true, isArchived: false },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      sku: true,
      wholesalePrice: true,
      suggestedRetailPrice: true,
      images: true,
      productImages: {
        orderBy: { sortOrder: "asc" },
        select: { url: true },
      },
      variants: {
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: {
          id: true,
          sku: true,
          name: true,
          wholesalePrice: true,
          suggestedRetailPrice: true,
          inventory: true,
          isActive: true,
        },
      },
    },
  });

  return products.map((product) => {
    const primaryImage =
      product.productImages[0]?.url ?? parseImages(product.images)[0] ?? null;
    const publicProduct: PublicCatalogProduct = {
      id: product.id,
      name: product.name,
      description: product.description,
      category: product.category,
      image: primaryImage,
      availability: product.variants.some((v) => v.inventory > 0)
        ? "AVAILABLE"
        : "UNAVAILABLE",
    };

    if (!context.canViewWholesale) {
      return publicProduct;
    }

    const inventory = product.variants.reduce((sum, v) => sum + v.inventory, 0);

    return {
      ...publicProduct,
      sku: product.sku,
      wholesalePrice: product.wholesalePrice,
      suggestedRetailPrice: product.suggestedRetailPrice,
      estimatedProfit: product.suggestedRetailPrice - product.wholesalePrice,
      inventory,
      variants: product.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        wholesalePrice: v.wholesalePrice,
        suggestedRetailPrice: v.suggestedRetailPrice,
        inventory: v.inventory,
        isActive: v.isActive,
      })),
    };
  });
}

export function isApprovedCatalogProduct(
  product: CatalogProduct
): product is ApprovedCatalogProduct {
  return "wholesalePrice" in product;
}
