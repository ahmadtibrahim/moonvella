import { prisma } from "~/db.server";
import { recordImageOutcomes, resolveImagesForImport } from "./importMediaSelection.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";

/**
 * Import (or re-sync) a MoonVella product into a seller's Shopify store using
 * the GraphQL Admin API, and persist the product/variant/inventory/location
 * mappings.
 *
 * First import creates the Shopify product and its variants. When a mapping
 * already exists the same call updates the Shopify product, its variant prices
 * and inventory instead of returning early, so re-import is a real re-sync.
 *
 * Image upload is best effort: a failed media upload is recorded as a warning
 * and never fails the product import.
 *
 * NOTE: real verification requires a live embedded session + the
 * product/inventory/location/file scopes. Without them this path returns a
 * clear failure.
 */
type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export interface ImportOptions {
  publish?: boolean;
  markupPercent?: number;
  /** Minor units (cents). `null` clears, `undefined` keeps the stored value. */
  customWholesalePrice?: number | null;
  customRetailPrice?: number | null;
  resync?: boolean;
}

export interface ImportedVariant {
  productVariantId: string;
  shopifyVariantId: string;
  inventoryItemId: string | null;
}

export interface ImportResult {
  ok: boolean;
  sellerProductId?: string;
  shopifyProductId?: string;
  variants?: ImportedVariant[];
  alreadyImported?: boolean;
  updated?: boolean;
  warnings?: string[];
  error?: string;
}

interface ImportableVariant {
  id: string;
  name: string;
  sku: string;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  costPrice: number | null;
  inventory: number;
}

interface ImportableProduct {
  id: string;
  name: string;
  description: string | null;
  category: string;
  variants: ImportableVariant[];
  mediaAssets: ImportableMediaAsset[];
}

/**
 * The subset of a MediaAsset the Shopify export cares about. storageKey is
 * carried so a future deployment with a public origin can address the file;
 * sourceUrl is what can be sent today.
 */
interface ImportableMediaAsset {
  storageKey: string;
  sourceUrl: string | null;
  altText: string | null;
}

interface SellerLike {
  id: string;
  shopDomain: string;
  storeName: string;
}

interface ExistingMapping {
  shopifyProductId: string | null;
  customWholesalePrice: number | null;
  customRetailPrice: number | null;
  variantMappings: {
    productVariantId: string;
    shopifyVariantId: string;
    shopifyInventoryItemId: string | null;
  }[];
}

interface ResolvedPricing {
  publish?: boolean;
  markupPercent: number;
  customWholesalePrice: number | null;
  customRetailPrice: number | null;
  images: ImportImageRequest[];
}

/**
 * One image an import may send.
 *
 * `mediaAssetId` is carried through so the outcome of this attempt can be
 * recorded against the seller's own selection row — that is what makes a retry
 * retry only what failed, instead of resending everything.
 *
 * `alreadyUploadedAs` is the store's id for an image a previous attempt already
 * placed. A non-null value means the image is skipped: the store is not ours to
 * write twice, and a duplicate is visible to shoppers.
 */
interface ImportImageRequest {
  mediaAssetId: string | null;
  originalSource: string;
  mediaContentType: "IMAGE";
  alt?: string;
  /** MoonVella variant ids this image is attached to, for the store-side link. */
  variantIds: string[];
  alreadyUploadedAs: string | null;
}

interface ShopifyVariant {
  id: string;
  sku?: string | null;
  inventoryItem?: { id: string } | null;
}

const PRODUCT_CREATE = `#graphql
  mutation MoonVellaProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title }
      userErrors { field message }
    }
  }`;

const PRODUCT_UPDATE = `#graphql
  mutation MoonVellaProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title }
      userErrors { field message }
    }
  }`;

const PRODUCT_MEDIA_ADD = `#graphql
  mutation MoonVellaProductMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productUpdate(product: { id: $productId }, media: $media) {
      product { id }
      userErrors { field message }
    }
  }`;

/**
 * The ids of a product's media, so an upload can be identified by what appeared
 * rather than by what came back.
 *
 * WHY THIS EXISTS. `productUpdate(media:)` accepts a list and returns the
 * product, not the media it created — so after adding four images there is no
 * way to say which id belongs to which source. Uploading one at a time and
 * diffing this list is what makes a per-image result possible, and a per-image
 * result is what the work order requires: "report partial upload failures and
 * allow retry" is unimplementable if five uploads produce one undifferentiated
 * outcome.
 *
 * The alternative, `productCreateMedia`, does return the created media, but its
 * ordering is not documented to follow the input when some entries fail — and a
 * wrongly attributed id would mark the wrong image as uploaded, so a retry
 * would resend the one that succeeded and skip the one that failed.
 */
const PRODUCT_MEDIA_IDS = `#graphql
  query MoonVellaProductMediaIds($id: ID!) {
    product(id: $id) { media(first: 100) { nodes { id } } }
  }`;

const VARIANTS_BULK_CREATE = `#graphql
  mutation MoonVellaVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id sku inventoryItem { id } }
      userErrors { field message }
    }
  }`;

const VARIANTS_BULK_UPDATE = `#graphql
  mutation MoonVellaVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price inventoryItem { id } }
      userErrors { field message }
    }
  }`;

const INVENTORY_SET = `#graphql
  mutation MoonVellaInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors { field message }
    }
  }`;

const LOCATIONS_QUERY = `#graphql
  query MoonVellaLocations { locations(first: 1) { nodes { id } } }`;

/**
 * Shopify fetches media by URL, so an asset can only be exported when it has an
 * absolute one. `sourceUrl` holds the URL a legacy asset came from, which is
 * exactly what Shopify needs. An asset uploaded through the new pipeline has no
 * sourceUrl: it is addressed by a storage key and this deployment has no public
 * origin configured for it, so inventing one would send Shopify a broken link.
 * Such assets are skipped here and wait for the storage origin to exist.
 *
 * Duplicates are removed because Shopify rejects the same originalSource twice.
 */
export function collectProductImages(product: {
  mediaAssets?: ImportableMediaAsset[];
}): { url: string; alt: string | null }[] {
  const sources = (product.mediaAssets ?? [])
    .filter((asset) => typeof asset.sourceUrl === "string" && asset.sourceUrl.trim().length > 0)
    .map((asset) => ({ url: asset.sourceUrl!.trim(), alt: asset.altText ?? null }));

  const seen = new Set<string>();
  const result: { url: string; alt: string | null }[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
  }
  return result;
}

export function buildMediaInputs(
  images: { url: string; alt?: string | null }[]
): { originalSource: string; mediaContentType: "IMAGE"; alt?: string }[] {
  return images
    .filter((image) => /^https?:\/\//i.test(image.url))
    .map((image) => ({
      originalSource: image.url,
      mediaContentType: "IMAGE" as const,
      ...(image.alt ? { alt: image.alt } : {}),
    }));
}

export function retailPriceFor(
  suggestedRetailCents: number,
  markupPercent = 0,
  customRetailPrice?: number | null
): string {
  if (customRetailPrice != null) return (customRetailPrice / 100).toFixed(2);
  return ((suggestedRetailCents * (100 + markupPercent)) / 100 / 100).toFixed(2);
}

export function wholesaleCostFor(
  wholesaleCents: number,
  customWholesalePrice?: number | null
): number {
  if (customWholesalePrice != null) return customWholesalePrice / 100;
  return wholesaleCents / 100;
}

function joinErrors(errors: { message: string }[] | undefined, fallback: string): string {
  const message = (errors ?? []).map((e) => e.message).join("; ");
  return message || fallback;
}

async function markImportFailed(sellerId: string, productId: string, message: string): Promise<void> {
  await prisma.sellerProduct
    .upsert({
      where: { sellerId_productId: { sellerId, productId } },
      create: { sellerId, productId, importStatus: "FAILED", lastImportError: message },
      update: { importStatus: "FAILED", lastImportError: message },
    })
    .catch(() => undefined);
}

/**
 * Write each image's outcome back to the seller's selection row.
 *
 * Wrapped so a bookkeeping failure cannot fail an import that has already
 * succeeded: the images are in the store, and rolling that back is not possible
 * from here. A row that did not get written means the next run resends one
 * image, which the store will accept as a duplicate — visible and fixable.
 * Losing the whole import would be neither.
 */
async function persistMediaOutcomes(
  sellerId: string,
  productId: string,
  outcomes: MediaUploadOutcome[]
): Promise<void> {
  if (!outcomes.length) return;
  const recordable = outcomes.filter((outcome) => outcome.mediaAssetId !== null);
  if (!recordable.length) return;
  try {
    await recordImageOutcomes(
      sellerId,
      productId,
      recordable.map((outcome) => ({
        mediaAssetId: outcome.mediaAssetId as string,
        ok: outcome.ok,
        providerMediaId: outcome.providerMediaId,
        error: outcome.error,
      }))
    );
  } catch {
    // Deliberately silent: see the note above. The import's own warnings
    // already carry the per-image result the operator needs.
  }
}

/** Media ids currently on the product, or null when the store did not answer. */
async function productMediaIds(admin: AdminGraphql, productId: string): Promise<Set<string> | null> {
  try {
    const res = await admin.graphql(PRODUCT_MEDIA_IDS, { variables: { id: productId } });
    const json = await res.json();
    const nodes = json?.data?.product?.media?.nodes ?? [];
    return new Set<string>(nodes.map((node: { id: string }) => node.id));
  } catch {
    return null;
  }
}

export interface MediaUploadOutcome {
  mediaAssetId: string | null;
  ok: boolean;
  providerMediaId: string | null;
  error: string | null;
  /** The store's id for an image that was already there and was not resent. */
  skippedExistingId: string | null;
}

export interface MediaUploadResult {
  outcomes: MediaUploadOutcome[];
  warnings: string[];
  /** The store id for each MoonVella asset that now has one. */
  mediaIdByAsset: Map<string, string>;
}

/**
 * Send the selected images, one at a time, and report on each.
 *
 * ONE CALL PER IMAGE, DELIBERATELY. The batch form is faster and would report a
 * single outcome for the whole set, which is exactly the report the work order
 * rules out: when four images survive and the fifth is rejected, "the image
 * upload failed" is a lie about the four that worked, and the operator has no
 * way to know which one to fix. The cost is one extra round trip per image, on
 * an operation that runs once per product per import.
 *
 * AN IMAGE A PREVIOUS ATTEMPT ALREADY PLACED IS NOT SENT AGAIN, and that is
 * decided from our own record of the store's id, not by comparing URLs or
 * filenames — both of which the seller may change, and neither of which is
 * unique. The store's id is.
 *
 * When the store accepts a request but no new media id appears, that is
 * reported as a failure rather than a success. Counting the request as done
 * would leave the seller with an image that is not in their store and a row
 * saying it was uploaded, and the retry that should have followed never
 * happens.
 */
async function addSelectedProductMedia(
  admin: AdminGraphql,
  shopifyProductId: string,
  images: ResolvedPricing["images"]
): Promise<MediaUploadResult> {
  const outcomes: MediaUploadOutcome[] = [];
  const warnings: string[] = [];
  const mediaIdByAsset = new Map<string, string>();
  if (!images.length) return { outcomes, warnings, mediaIdByAsset };

  let known = await productMediaIds(admin, shopifyProductId);

  for (const image of images) {
    const label = image.alt?.trim() || image.originalSource;

    if (image.alreadyUploadedAs) {
      outcomes.push({
        mediaAssetId: image.mediaAssetId,
        ok: true,
        providerMediaId: image.alreadyUploadedAs,
        error: null,
        skippedExistingId: image.alreadyUploadedAs,
      });
      if (image.mediaAssetId) mediaIdByAsset.set(image.mediaAssetId, image.alreadyUploadedAs);
      continue;
    }

    try {
      const res = await admin.graphql(PRODUCT_MEDIA_ADD, {
        variables: {
          productId: shopifyProductId,
          media: [
            {
              originalSource: image.originalSource,
              mediaContentType: image.mediaContentType,
              ...(image.alt ? { alt: image.alt } : {}),
            },
          ],
        },
      });
      const json = await res.json();
      const errors = json?.data?.productUpdate?.userErrors ?? [];
      if (errors.length) {
        const message = errors
          .map((e: { field?: unknown; message: string }) =>
            `${Array.isArray(e.field) ? e.field.join(".") : e.field ?? "media"}: ${e.message}`
          )
          .join("; ");
        outcomes.push({
          mediaAssetId: image.mediaAssetId,
          ok: false,
          providerMediaId: null,
          error: message,
          skippedExistingId: null,
        });
        warnings.push(`Image not uploaded (${label}): ${message}`);
        continue;
      }

      const after = await productMediaIds(admin, shopifyProductId);
      // Held in a local so the narrowing survives into the closure below; a
      // `let` narrowed by a preceding check is not narrowed inside a callback.
      const before = known;
      const added = after && before ? [...after].filter((id) => !before.has(id)) : [];
      if (after) known = after;

      if (added.length === 1) {
        outcomes.push({
          mediaAssetId: image.mediaAssetId,
          ok: true,
          providerMediaId: added[0],
          error: null,
          skippedExistingId: null,
        });
        if (image.mediaAssetId) mediaIdByAsset.set(image.mediaAssetId, added[0]);
        continue;
      }

      const message =
        added.length === 0
          ? "the store accepted the image but it did not appear on the product"
          : `the store reported ${added.length} new images for one upload, so the new image could not be identified`;
      outcomes.push({
        mediaAssetId: image.mediaAssetId,
        ok: false,
        providerMediaId: null,
        error: message,
        skippedExistingId: null,
      });
      warnings.push(`Image not confirmed (${label}): ${message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      outcomes.push({
        mediaAssetId: image.mediaAssetId,
        ok: false,
        providerMediaId: null,
        error: message,
        skippedExistingId: null,
      });
      warnings.push(`Image upload failed (${label}): ${message}`);
    }
  }

  return { outcomes, warnings, mediaIdByAsset };
}

/**
 * Attach each uploaded image to the variants it belonged to in MoonVella.
 *
 * The association is MoonVella's own — an asset is attached to a variant by a
 * MediaAssetAssignment — and dropping it here would mean a seller who picks a
 * subset of images silently loses the variant pictures along with it. The link
 * is made with the store's media id, so it survives the seller renaming or
 * reordering anything.
 *
 * A link that cannot be made is a warning, not a failure: the image is already
 * in the store and usable, and the seller can attach it by hand. Failing the
 * whole import over a variant link would be a worse trade.
 */
async function linkVariantImages(
  admin: AdminGraphql,
  shopifyProductId: string,
  images: ResolvedPricing["images"],
  mediaIdByAsset: Map<string, string>,
  shopifyVariantByLocal: Map<string, string>
): Promise<string[]> {
  const warnings: string[] = [];
  const updates: { id: string; mediaId: string }[] = [];

  for (const image of images) {
    if (!image.mediaAssetId || image.variantIds.length === 0) continue;
    const mediaId = mediaIdByAsset.get(image.mediaAssetId);
    if (!mediaId) continue;
    for (const localVariantId of image.variantIds) {
      const shopifyVariantId = shopifyVariantByLocal.get(localVariantId);
      if (!shopifyVariantId) continue;
      updates.push({ id: shopifyVariantId, mediaId });
    }
  }
  if (!updates.length) return warnings;

  try {
    const res = await admin.graphql(VARIANTS_BULK_UPDATE, {
      variables: { productId: shopifyProductId, variants: updates },
    });
    const json = await res.json();
    const errors = json?.data?.productVariantsBulkUpdate?.userErrors ?? [];
    for (const error of errors) {
      warnings.push(`Variant image not linked: ${error.message}`);
    }
  } catch (error) {
    warnings.push(
      `Variant images not linked: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  return warnings;
}

async function fetchFirstLocationId(admin: AdminGraphql): Promise<string | null> {
  try {
    const res = await admin.graphql(LOCATIONS_QUERY);
    const json = await res.json();
    return json?.data?.locations?.nodes?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Best effort; returns warning strings rather than throwing. */
async function setInventoryQuantities(
  admin: AdminGraphql,
  quantities: { inventoryItemId: string; locationId: string; quantity: number }[]
): Promise<string[]> {
  if (!quantities.length) return [];
  try {
    const res = await admin.graphql(INVENTORY_SET, {
      variables: {
        idempotencyKey: crypto.randomUUID(),
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities,
        },
      },
    });
    const json = await res.json();
    const errors = json?.data?.inventorySetQuantities?.userErrors ?? [];
    return errors.map((e: { message: string }) => `Inventory not synced: ${e.message}`);
  } catch (error) {
    return [`Inventory sync failed: ${error instanceof Error ? error.message : "unknown error"}`];
  }
}

function productInput(product: ImportableProduct, opts: ResolvedPricing, includeId?: string) {
  return {
    ...(includeId ? { id: includeId } : {}),
    title: product.name,
    descriptionHtml: product.description ?? "",
    status: opts.publish === false ? "DRAFT" : "ACTIVE",
    tags: ["MoonVella", product.category],
  };
}

function variantPriceInput(variant: ImportableVariant, opts: ResolvedPricing) {
  return {
    price: retailPriceFor(variant.suggestedRetailPrice, opts.markupPercent, opts.customRetailPrice),
    inventoryItem: {
      tracked: true,
      cost: wholesaleCostFor(variant.costPrice ?? variant.wholesalePrice, opts.customWholesalePrice),
      sku: variant.sku,
    },
  };
}

/**
 * Writes the record of what was imported, in the seller's own store.
 *
 * Two levels, and both are needed:
 *
 *   • SellerProduct / SellerProductVariant answer "what does this merchant have,
 *     and what did it sell for there?" — that is commercial state, per seller.
 *
 *   • ExternalProductMapping / ExternalVariantMapping answer "which Shopify
 *     object is this MoonVella product?" — that is identity, and it is written
 *     inside the same transaction as the commercial record so the two cannot
 *     disagree. A mapping that exists without its SellerProduct would point at
 *     a store object nobody owns; a SellerProduct without its mapping could
 *     never be resynced.
 *
 * The external tables carry no prices. A merchant's pricing is theirs and lives
 * in SellerProduct; these rows are identifiers only, which is also why they are
 * safe to keep if a merchant's commercial terms are ever reset.
 */
function persistMappings(
  seller: { id: string; shopDomain: string },
  product: ImportableProduct,
  shopifyProductId: string,
  locationId: string | null,
  resolved: { local: ImportableVariant; shopifyVariant: ShopifyVariant | null }[],
  opts: ResolvedPricing
) {
  const sellerId = seller.id;
  const provider = "SHOPIFY";
  const shopDomain = seller.shopDomain;
  const shopifyVariantIds = resolved
    .filter((item) => item.shopifyVariant)
    .map((item) => item.shopifyVariant!.id);

  return prisma.$transaction(async (tx) => {
    const sellerProduct = await tx.sellerProduct.upsert({
      where: { sellerId_productId: { sellerId, productId: product.id } },
      create: {
        sellerId,
        productId: product.id,
        shopifyProductId,
        importedAt: new Date(),
        importStatus: "SUCCESS",
        isActive: true,
        shopifyVariantIds: JSON.stringify(shopifyVariantIds),
        customWholesalePrice: opts.customWholesalePrice,
        customRetailPrice: opts.customRetailPrice,
      },
      update: {
        shopifyProductId,
        importedAt: new Date(),
        importStatus: "SUCCESS",
        lastImportError: null,
        isActive: true,
        shopifyVariantIds: JSON.stringify(shopifyVariantIds),
        customWholesalePrice: opts.customWholesalePrice,
        customRetailPrice: opts.customRetailPrice,
      },
    });

    const mappings: ImportedVariant[] = [];
    for (const item of resolved) {
      const shopifyVariant = item.shopifyVariant;
      if (!shopifyVariant) continue;
      const inventoryItemId = shopifyVariant.inventoryItem?.id ?? null;
      await tx.sellerProductVariant.upsert({
        where: {
          sellerProductId_productVariantId: {
            sellerProductId: sellerProduct.id,
            productVariantId: item.local.id,
          },
        },
        create: {
          sellerProductId: sellerProduct.id,
          productVariantId: item.local.id,
          shopifyProductId,
          shopifyVariantId: shopifyVariant.id,
          shopifyInventoryItemId: inventoryItemId,
          shopifyLocationId: locationId,
          syncStatus: "SUCCESS",
          syncedAt: new Date(),
        },
        update: {
          shopifyProductId,
          shopifyVariantId: shopifyVariant.id,
          shopifyInventoryItemId: inventoryItemId,
          shopifyLocationId: locationId,
          syncStatus: "SUCCESS",
          syncedAt: new Date(),
        },
      });
      // The identity row for this variant, in the same transaction as the
      // commercial one above.
      await tx.externalVariantMapping.upsert({
        where: {
          provider_shopDomain_variantId: { provider, shopDomain, variantId: item.local.id },
        },
        create: {
          provider,
          shopDomain,
          variantId: item.local.id,
          externalProductId: shopifyProductId,
          externalVariantId: shopifyVariant.id,
          importStatus: "IMPORTED",
          lastSyncedAt: new Date(),
        },
        update: {
          externalProductId: shopifyProductId,
          externalVariantId: shopifyVariant.id,
          importStatus: "IMPORTED",
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });

      mappings.push({
        productVariantId: item.local.id,
        shopifyVariantId: shopifyVariant.id,
        inventoryItemId,
      });
    }

    await tx.externalProductMapping.upsert({
      where: { provider_shopDomain_productId: { provider, shopDomain, productId: product.id } },
      create: {
        provider,
        shopDomain,
        productId: product.id,
        externalProductId: shopifyProductId,
        importStatus: mappings.length === resolved.length ? "IMPORTED" : "PARTIAL",
        lastSyncedAt: new Date(),
      },
      update: {
        externalProductId: shopifyProductId,
        importStatus: mappings.length === resolved.length ? "IMPORTED" : "PARTIAL",
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    });

    return { sellerProduct, mappings };
  });
}

async function createNewProduct(
  admin: AdminGraphql,
  seller: SellerLike,
  product: ImportableProduct,
  opts: ResolvedPricing
): Promise<ImportResult> {
  const createRes = await admin.graphql(PRODUCT_CREATE, {
    variables: { product: productInput(product, opts) },
  });
  const createJson = await createRes.json();
  const createErrors = createJson?.data?.productCreate?.userErrors ?? [];
  if (createErrors.length || !createJson?.data?.productCreate?.product?.id) {
    const message = joinErrors(createErrors, "productCreate failed");
    await setIntegrationState("product_import", { status: "FAILED", error: message });
    await markImportFailed(seller.id, product.id, message);
    return { ok: false, error: message };
  }
  const shopifyProductId: string = createJson.data.productCreate.product.id;

  const upload = await addSelectedProductMedia(admin, shopifyProductId, opts.images);
  const warnings = [...upload.warnings];

  const variantInputs = product.variants.map((variant) => ({
    optionValues: [{ optionName: "Title", name: variant.name }],
    sku: variant.sku,
    ...variantPriceInput(variant, opts),
  }));

  let createdVariants: ShopifyVariant[] = [];
  if (variantInputs.length) {
    const variantRes = await admin.graphql(VARIANTS_BULK_CREATE, {
      variables: { productId: shopifyProductId, variants: variantInputs },
    });
    const variantJson = await variantRes.json();
    const variantErrors = variantJson?.data?.productVariantsBulkCreate?.userErrors ?? [];
    createdVariants = variantJson?.data?.productVariantsBulkCreate?.productVariants ?? [];
    if (variantErrors.length && createdVariants.length === 0) {
      const message = joinErrors(variantErrors, "productVariantsBulkCreate failed");
      await setIntegrationState("product_import", { status: "FAILED", error: message });
      await markImportFailed(seller.id, product.id, message);
      return { ok: false, error: message };
    }
  }

  const locationId = await fetchFirstLocationId(admin);
  if (locationId) {
    const quantities = product.variants
      .map((variant, index) => ({
        inventoryItemId: createdVariants[index]?.inventoryItem?.id,
        locationId,
        quantity: variant.inventory,
      }))
      .filter((q): q is { inventoryItemId: string; locationId: string; quantity: number } =>
        Boolean(q.inventoryItemId)
      );
    warnings.push(...(await setInventoryQuantities(admin, quantities)));
  }

  const resolved = product.variants.map((local, index) => ({
    local,
    shopifyVariant: createdVariants[index] ?? null,
  }));

  // Variant links come after the variants exist, which is why this is here and
  // not beside the upload: a media id can be attached to a variant only once
  // the store has told us the variant's own id.
  const shopifyVariantByLocal = new Map(
    resolved
      .filter((item): item is { local: ImportableVariant; shopifyVariant: ShopifyVariant } =>
        Boolean(item.shopifyVariant)
      )
      .map((item) => [item.local.id, item.shopifyVariant.id])
  );
  warnings.push(
    ...(await linkVariantImages(admin, shopifyProductId, opts.images, upload.mediaIdByAsset, shopifyVariantByLocal))
  );

  await persistMediaOutcomes(seller.id, product.id, upload.outcomes);

  const result = await persistMappings(
    seller,
    product,
    shopifyProductId,
    locationId,
    resolved,
    opts
  );

  await recordAudit({
    actorType: "MERCHANT",
    actorId: seller.shopDomain,
    actorName: seller.storeName,
    action: "product.imported",
    entityType: AUDIT_ENTITY.SELLER_PRODUCT,
    entityId: result.sellerProduct.id,
    afterData: {
      shopifyProductId,
      variants: result.mappings.length,
      warnings: warnings.length,
    },
  });

  await setIntegrationState("product_import", {
    status: "HEALTHY",
    detail: `Imported "${product.name}" to Shopify (product ${shopifyProductId})${
      warnings.length ? ` with ${warnings.length} warning(s).` : "."
    }`,
  });

  return {
    ok: true,
    sellerProductId: result.sellerProduct.id,
    shopifyProductId,
    variants: result.mappings,
    warnings,
  };
}

async function resyncExistingProduct(
  admin: AdminGraphql,
  seller: SellerLike,
  product: ImportableProduct,
  existing: ExistingMapping,
  opts: ResolvedPricing
): Promise<ImportResult> {
  const shopifyProductId = existing.shopifyProductId as string;
  const warnings: string[] = [];

  const updateRes = await admin.graphql(PRODUCT_UPDATE, {
    variables: { product: productInput(product, opts, shopifyProductId) },
  });
  const updateJson = await updateRes.json();
  const updateErrors = updateJson?.data?.productUpdate?.userErrors ?? [];
  if (updateErrors.length) {
    const message = joinErrors(updateErrors, "productUpdate failed");
    await setIntegrationState("product_import", { status: "FAILED", error: message });
    await markImportFailed(seller.id, product.id, message);
    return { ok: false, error: message };
  }

  /*
   * The previous version of this branch sent the images only when the product
   * had NO media at all, which was a crude stand-in for "have we done this
   * already". It got the interesting case exactly backwards: a seller who had
   * added one image by hand, or excluded one earlier, had a product with media,
   * so a newly selected image was never sent — and there was no record of which
   * images had been sent, so there was no way to tell.
   *
   * The check is now per image and comes from our own record of the store's id
   * for each one. An image already placed is skipped and reported; an image
   * that failed is retried; an image the seller excluded is not in the list at
   * all and cannot reappear.
   */
  const upload = await addSelectedProductMedia(admin, shopifyProductId, opts.images);
  warnings.push(...upload.warnings);

  const mappingByVariant = new Map(
    existing.variantMappings.map((mapping) => [mapping.productVariantId, mapping])
  );

  const updateInputs: Record<string, unknown>[] = [];
  const createInputs: Record<string, unknown>[] = [];
  for (const variant of product.variants) {
    const mapping = mappingByVariant.get(variant.id);
    if (mapping) {
      updateInputs.push({ id: mapping.shopifyVariantId, ...variantPriceInput(variant, opts) });
    } else {
      createInputs.push({
        optionValues: [{ optionName: "Title", name: variant.name }],
        sku: variant.sku,
        ...variantPriceInput(variant, opts),
      });
    }
  }

  const updatedVariants = new Map<string, ShopifyVariant>();
  const createdVariants: ShopifyVariant[] = [];

  if (updateInputs.length) {
    const res = await admin.graphql(VARIANTS_BULK_UPDATE, {
      variables: { productId: shopifyProductId, variants: updateInputs },
    });
    const json = await res.json();
    const errors = json?.data?.productVariantsBulkUpdate?.userErrors ?? [];
    const variants: ShopifyVariant[] = json?.data?.productVariantsBulkUpdate?.productVariants ?? [];
    if (errors.length && variants.length === 0) {
      const message = joinErrors(errors, "productVariantsBulkUpdate failed");
      await setIntegrationState("product_import", { status: "FAILED", error: message });
      await markImportFailed(seller.id, product.id, message);
      return { ok: false, error: message };
    }
    for (const variant of variants) updatedVariants.set(variant.id, variant);
  }

  if (createInputs.length) {
    const res = await admin.graphql(VARIANTS_BULK_CREATE, {
      variables: { productId: shopifyProductId, variants: createInputs },
    });
    const json = await res.json();
    const errors = json?.data?.productVariantsBulkCreate?.userErrors ?? [];
    const variants: ShopifyVariant[] = json?.data?.productVariantsBulkCreate?.productVariants ?? [];
    if (errors.length && variants.length === 0) {
      const message = joinErrors(errors, "productVariantsBulkCreate failed");
      await setIntegrationState("product_import", { status: "FAILED", error: message });
      await markImportFailed(seller.id, product.id, message);
      return { ok: false, error: message };
    }
    createdVariants.push(...variants);
  }

  let createdCursor = 0;
  const resolved = product.variants.map((local) => {
    const mapping = mappingByVariant.get(local.id);
    if (mapping) {
      const updated = updatedVariants.get(mapping.shopifyVariantId);
      return {
        local,
        shopifyVariant:
          updated ??
          ({
            id: mapping.shopifyVariantId,
            inventoryItem: mapping.shopifyInventoryItemId
              ? { id: mapping.shopifyInventoryItemId }
              : null,
          } as ShopifyVariant),
      };
    }
    const created = createdVariants[createdCursor] ?? null;
    createdCursor += 1;
    return { local, shopifyVariant: created };
  });

  const locationId = await fetchFirstLocationId(admin);
  if (locationId) {
    const quantities = resolved
      .map((item) => ({
        inventoryItemId: item.shopifyVariant?.inventoryItem?.id,
        locationId,
        quantity: item.local.inventory,
      }))
      .filter((q): q is { inventoryItemId: string; locationId: string; quantity: number } =>
        Boolean(q.inventoryItemId)
      );
    warnings.push(...(await setInventoryQuantities(admin, quantities)));
  }

  const shopifyVariantByLocal = new Map(
    resolved
      .filter((item): item is { local: ImportableVariant; shopifyVariant: ShopifyVariant } =>
        Boolean(item.shopifyVariant)
      )
      .map((item) => [item.local.id, item.shopifyVariant.id])
  );
  warnings.push(
    ...(await linkVariantImages(admin, shopifyProductId, opts.images, upload.mediaIdByAsset, shopifyVariantByLocal))
  );

  await persistMediaOutcomes(seller.id, product.id, upload.outcomes);

  const result = await persistMappings(
    seller,
    product,
    shopifyProductId,
    locationId,
    resolved,
    opts
  );

  await recordAudit({
    actorType: "MERCHANT",
    actorId: seller.shopDomain,
    actorName: seller.storeName,
    action: "product.resynced",
    entityType: AUDIT_ENTITY.SELLER_PRODUCT,
    entityId: result.sellerProduct.id,
    afterData: {
      shopifyProductId,
      variants: result.mappings.length,
      warnings: warnings.length,
    },
  });

  await setIntegrationState("product_import", {
    status: "HEALTHY",
    detail: `Re-synced "${product.name}" to Shopify (product ${shopifyProductId})${
      warnings.length ? ` with ${warnings.length} warning(s).` : "."
    }`,
  });

  return {
    ok: true,
    updated: true,
    alreadyImported: true,
    sellerProductId: result.sellerProduct.id,
    shopifyProductId,
    variants: result.mappings,
    warnings,
  };
}

export async function importProductForSeller(
  admin: AdminGraphql,
  sellerId: string,
  productId: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) return { ok: false, error: "Seller not found." };
  if (seller.status !== "APPROVED") {
    return { ok: false, error: `Import requires an approved seller (current: ${seller.status}).` };
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      variants: { where: { isActive: true }, orderBy: { sku: "asc" } },
      // Only approved, seller-visible images may leave for a merchant store,
      // which is the same gate the seller catalog applies.
      mediaAssets: {
        where: {
          approvalStatus: "APPROVED",
          sellerVisible: true,
          category: { in: ["WHITE_BACKGROUND_IMAGE", "LIFESTYLE_IMAGE"] },
        },
        orderBy: { createdAt: "asc" },
        select: { storageKey: true, sourceUrl: true, altText: true },
      },
    },
  });
  if (!product || product.isArchived) return { ok: false, error: "Product not available." };

  const existing = await prisma.sellerProduct.findUnique({
    where: { sellerId_productId: { sellerId, productId } },
    include: { variantMappings: true },
  });

  const customWholesalePrice =
    options.customWholesalePrice !== undefined
      ? options.customWholesalePrice
      : existing?.customWholesalePrice ?? null;
  const customRetailPrice =
    options.customRetailPrice !== undefined
      ? options.customRetailPrice
      : existing?.customRetailPrice ?? null;

  /*
   * WHICH IMAGES GO IS THE SELLER'S DECISION, NOT THIS FUNCTION'S.
   *
   * The eligible set is still approved-and-seller-visible, and that gate is
   * applied inside `resolveImagesForImport` so the preview a seller chooses from
   * and the list this function sends cannot disagree. What changes here is that
   * the list is the seller's saved selection rather than every eligible image:
   * an image they removed stays removed on the next import, and an image a
   * previous attempt already placed is carried with the store's own id for it
   * so it is not sent a second time.
   *
   * With no stored selection the behaviour is what it always was — every
   * eligible image — and `defaulted` says so, so the interface can tell the
   * seller nothing has been chosen yet. Importing nothing until a choice is
   * made would turn a missing step into a broken product.
   */
  const selection = await resolveImagesForImport(sellerId, productId);
  const opts: ResolvedPricing = {
    publish: options.publish,
    markupPercent: options.markupPercent ?? 0,
    customWholesalePrice,
    customRetailPrice,
    images: [
      ...selection.images.map((image) => ({
        mediaAssetId: image.mediaAssetId,
        originalSource: image.url,
        mediaContentType: "IMAGE" as const,
        ...(image.alt ? { alt: image.alt } : {}),
        variantIds: image.variantIds,
        alreadyUploadedAs: image.alreadyUploadedAs,
      })),
      // Legacy assets are included only when no selection has been saved, so a
      // seller who has chosen a set does not receive extras they never saw.
      ...(selection.defaulted
        ? buildMediaInputs(collectProductImages(product)).map((image) => ({
            mediaAssetId: null,
            originalSource: image.originalSource,
            mediaContentType: "IMAGE" as const,
            ...(image.alt ? { alt: image.alt } : {}),
            variantIds: [] as string[],
            alreadyUploadedAs: null,
          }))
        : []),
    ],
  };

  try {
    if (existing?.shopifyProductId && existing.variantMappings.length > 0) {
      return await resyncExistingProduct(admin, seller, product, existing, opts);
    }
    return await createNewProduct(admin, seller, product, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    await setIntegrationState("product_import", { status: "FAILED", error: message });
    await markImportFailed(sellerId, productId, message);
    return { ok: false, error: message };
  }
}
