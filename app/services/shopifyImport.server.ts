import { prisma } from "~/db.server";
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
  images: { originalSource: string; mediaContentType: "IMAGE"; alt?: string }[];
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

const PRODUCT_MEDIA_COUNT = `#graphql
  query MoonVellaProductMediaCount($id: ID!) {
    product(id: $id) { media(first: 1) { nodes { id } } }
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

/** Best effort; returns warning strings rather than throwing. */
async function addProductMedia(
  admin: AdminGraphql,
  productId: string,
  media: ResolvedPricing["images"]
): Promise<string[]> {
  if (!media.length) return [];
  try {
    const res = await admin.graphql(PRODUCT_MEDIA_ADD, {
      variables: { productId, media },
    });
    const json = await res.json();
    const errors = json?.data?.productUpdate?.userErrors ?? [];
    return errors.map(
      (e: { field?: unknown; message: string }) =>
        `Image skipped (${Array.isArray(e.field) ? e.field.join(".") : e.field ?? "media"}): ${e.message}`
    );
  } catch (error) {
    return [`Image upload failed: ${error instanceof Error ? error.message : "unknown error"}`];
  }
}

async function countProductMedia(admin: AdminGraphql, productId: string): Promise<number | null> {
  try {
    const res = await admin.graphql(PRODUCT_MEDIA_COUNT, { variables: { id: productId } });
    const json = await res.json();
    if (!json?.data?.product) return null;
    return json.data.product.media?.nodes?.length ?? 0;
  } catch {
    return null;
  }
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

  const warnings = await addProductMedia(admin, shopifyProductId, opts.images);

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

  if (opts.images.length && (await countProductMedia(admin, shopifyProductId)) === 0) {
    warnings.push(...(await addProductMedia(admin, shopifyProductId, opts.images)));
  }

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

  const opts: ResolvedPricing = {
    publish: options.publish,
    markupPercent: options.markupPercent ?? 0,
    customWholesalePrice,
    customRetailPrice,
    images: buildMediaInputs(collectProductImages(product)),
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
