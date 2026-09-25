import { prisma } from "~/db.server";
import { assetUrl } from "./media.server";
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
  /** Option pairs, e.g. [{ name: "Size", value: "Queen" }]. */
  options: { name: string; value: string }[];
}

export interface ApprovedCatalogProduct extends PublicCatalogProduct {
  /** The family code. Not a SKU — each variant carries its own. */
  productCode: string;
  /**
   * The prices of the cheapest active variant, i.e. what a seller would pay to
   * start stocking the family. The family itself has no price; a product with
   * three sizes has three. The interface labels these as "from".
   */
  wholesalePrice: number;
  suggestedRetailPrice: number;
  estimatedProfit: number;
  /** Total across active variants. */
  inventory: number;
  variants: ApprovedCatalogVariant[];
}

export type CatalogProduct = PublicCatalogProduct | ApprovedCatalogProduct;

/**
 * Categories a seller may see. Documents and marketing creatives are delivered
 * through the marketing pack rather than shown inline in the catalog, and
 * neither is an image the catalog can render.
 */
const CATALOG_IMAGE_CATEGORIES = ["WHITE_BACKGROUND_IMAGE", "LIFESTYLE_IMAGE"] as const;

type MediaAssetWithAssignments = {
  id: string;
  storageKey: string;
  sourceUrl: string | null;
  category: string;
  assignments: { variantId: string | null; sortOrder: number; isPrimary: boolean }[];
};

/**
 * Chooses the image a seller sees for a family.
 *
 * Preference order is the order the merchant expressed: the product-level
 * primary image first, because it is the one picture they nominated for the
 * product as a whole, then the general gallery in its configured order, then
 * the default variant's own photograph, then any variant-scoped one. The
 * fallbacks matter because a product can legitimately carry only variant media,
 * and a card with no picture at all is worse than a picture of one size.
 *
 * IT RETURNS A URL, NOT A KEY. It used to return `storageKey`, which is 32 hex
 * characters and nothing else, and the catalog card rendered it directly as an
 * `src`. Every product image in the seller's catalogue was therefore a broken
 * image — the file was stored, approved and published, and the browser was
 * asked for a file called `9f2c…e1` relative to the current page. `assetUrl` is
 * the function that already knows what a row's address is, so this is now the
 * same answer the admin screens get.
 */
function pickPrimaryImage(
  assets: MediaAssetWithAssignments[],
  defaultVariantId: string | null
): string | null {
  const withImage = assets.filter((asset) => asset.storageKey);
  if (!withImage.length) return null;

  const byVariantOrder = (
    a: { assignments: MediaAssetWithAssignments["assignments"] },
    variantId: string | null
  ) => {
    const match = a.assignments.find((assignment) => assignment.variantId === variantId);
    return match ? match.sortOrder : Number.MAX_SAFE_INTEGER;
  };

  /*
   * THE PRODUCT'S OWN PRIMARY IMAGE COMES FIRST, and this is a change of order
   * rather than a change of preference.
   *
   * It used to lead with the default variant's own photograph, which made the
   * catalogue entry for a family a picture of one of its sizes: the King size
   * was pictured with the King shot, and which picture a seller saw depended on
   * which size happened to be marked default. The same product then had one
   * thumbnail in the catalogue, another on the Shopify product and a third in a
   * marketing email, because each of those walks its own list.
   *
   * The product-level primary is the merchant's explicit answer to "which
   * picture represents this product", set on the media tab and enforced to be
   * unique by the publication gate (`primary_image`). When it exists it is the
   * answer everywhere. The old preferences survive underneath it, for the
   * families that have not nominated one — a product with only variant
   * photographs still gets a picture rather than a blank card.
   */
  const productPrimary = withImage.find((asset) =>
    asset.assignments.some((assignment) => assignment.variantId === null && assignment.isPrimary)
  );
  if (productPrimary) return assetUrl(productPrimary);

  const shared = withImage
    .filter((asset) => asset.assignments.some((a) => a.variantId === null))
    .sort((a, b) => byVariantOrder(a, null) - byVariantOrder(b, null));
  if (shared.length) return assetUrl(shared[0]);

  if (defaultVariantId) {
    const own = withImage
      .filter((asset) => asset.assignments.some((a) => a.variantId === defaultVariantId))
      .sort((a, b) => byVariantOrder(a, defaultVariantId) - byVariantOrder(b, defaultVariantId));
    if (own.length) return assetUrl(own[0]);
  }

  const scoped = withImage
    .filter((asset) => asset.assignments.some((a) => a.variantId !== null))
    .sort((a, b) => {
      const aPrimary = a.assignments.some((x) => x.isPrimary) ? 0 : 1;
      const bPrimary = b.assignments.some((x) => x.isPrimary) ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return a.id.localeCompare(b.id);
    });
  if (scoped.length) return assetUrl(scoped[0]);

  return assetUrl(withImage[0]);
}

/**
 * Returns the MoonVella catalog for a seller. Protected commercial fields
 * (wholesale cost, suggested retail, profit, exact inventory and variant
 * pricing) are *omitted from the returned objects* unless the seller is
 * approved, so they never reach a pending seller's response payload.
 *
 * Only PUBLISHED families appear. That is the whole point of the publication
 * gate: a draft is visible to the merchant and to nobody else, so a half-built
 * product cannot be sold by accident. Archived families are excluded too, and
 * an inactive one is excluded by the same rule that hides it on the storefront.
 */
export async function listCatalog(
  context: Pick<SellerContext, "canViewWholesale">
): Promise<CatalogProduct[]> {
  const products = await prisma.product.findMany({
    where: { status: "PUBLISHED", isActive: true, isArchived: false },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      productCode: true,
      mediaAssets: {
        /*
         * The same pair of questions every seller-facing screen asks, in the
         * query rather than in JavaScript — see `mediaState`. Written out here
         * because a Prisma filter cannot call a function; the three clauses and
         * `isReadyForSellers` must change together.
         */
        where: {
          sellerVisible: true,
          approvalStatus: { not: "REJECTED" },
          processingStatus: "READY",
          category: { in: [...CATALOG_IMAGE_CATEGORIES] },
        },
        select: {
          id: true,
          storageKey: true,
          // Read so the URL below can be built. A migrated asset has a key that
          // names no object here and lives at its original address instead;
          // `assetUrl` is the one place that decides which of the two a row is,
          // and it needs both to decide.
          sourceUrl: true,
          category: true,
          assignments: {
            select: { variantId: true, sortOrder: true, isPrimary: true },
          },
        },
      },
      variants: {
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: {
          id: true,
          sku: true,
          name: true,
          wholesalePrice: true,
          suggestedRetailPrice: true,
          inventory: true,
          isActive: true,
          isDefault: true,
          variantOptions: { orderBy: { sortOrder: "asc" }, select: { name: true, value: true } },
        },
      },
    },
  });

  return products.map((product) => {
    const defaultVariant =
      product.variants.find((variant) => variant.isDefault) ?? product.variants[0] ?? null;
    const primaryImage = pickPrimaryImage(product.mediaAssets, defaultVariant?.id ?? null);

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

    // Prices shown at family level are the cheapest active variant's. A seller
    // reading "$52.00" needs it to be a price they can actually pay, and the
    // entry variant is that price.
    const cheapest = product.variants.reduce<(typeof product.variants)[number] | null>(
      (best, variant) => (!best || variant.wholesalePrice < best.wholesalePrice ? variant : best),
      null
    );

    return {
      ...publicProduct,
      productCode: product.productCode,
      wholesalePrice: cheapest?.wholesalePrice ?? 0,
      suggestedRetailPrice: cheapest?.suggestedRetailPrice ?? 0,
      estimatedProfit: cheapest
        ? cheapest.suggestedRetailPrice - cheapest.wholesalePrice
        : 0,
      inventory: product.variants.reduce((sum, v) => sum + v.inventory, 0),
      variants: product.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        wholesalePrice: v.wholesalePrice,
        suggestedRetailPrice: v.suggestedRetailPrice,
        inventory: v.inventory,
        isActive: v.isActive,
        options: v.variantOptions,
      })),
    };
  });
}

export function isApprovedCatalogProduct(
  product: CatalogProduct
): product is ApprovedCatalogProduct {
  return "wholesalePrice" in product;
}
