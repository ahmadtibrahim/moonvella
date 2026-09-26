import { prisma } from "~/db.server";
import { loadSellerRetailPrices } from "./sellerPricing.server";
import { recordImageOutcomes, resolveImagesForImport } from "./importMediaSelection.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";
import { readObject } from "./storage.server";
import {
  addProductMedia,
  stageAndUpload,
  type AdminGraphql,
  type TransferFetch,
} from "./shopifyTransfer.server";

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
export interface ImportOptions {
  publish?: boolean;
  resync?: boolean;
  /**
   * The network seam for staged uploads, so a test can run an import that sends
   * a stored image without a Shopify account behind it. Absent in production.
   */
  transferFetch?: TransferFetch;
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
  /**
   * The seller's own price for this variant, already resolved against the
   * family's older override — the number their listing shows.
   *
   * Null means "no opinion", and the catalogue's suggested retail is used; see
   * `resolveRetailCents`. Resolved before it gets here rather than looked up
   * inside the price call, so that the refusal below and the price that is
   * actually sent are the same calculation. They used to be two.
   *
   * NOT `costPrice` AND NOT `wholesalePrice`. What the variant costs the seller
   * is theirs to see and not to set, and it is sent separately as the store's
   * "cost per item" — see `sellerCostFor`.
   */
  sellerRetailPrice?: number | null;
  /** Optional barcode/UPC, sent as the store variant's barcode when present. */
  barcode?: string | null;
  /**
   * The variant's own option pairs, e.g. Size = King. Empty for a product sold
   * as one thing, which the store then receives as a single "Title" option.
   */
  variantOptions?: { name: string; value: string }[];
  /** Canonical kilograms, converted from Odoo's weight at import. */
  productWeightKg?: number | string | { toString(): string } | null;
}

interface ImportableProduct {
  id: string;
  name: string;
  description: string | null;
  category: string;
  /** The family code, sent to the store as a metafield. Not a SKU. */
  productCode: string;
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

/**
 * What a previous import left behind: which store product it created, and which
 * store variant each MoonVella variant became.
 *
 * NO PRICES, AND THEIR ABSENCE IS THE POINT. These rows used to carry the
 * seller's retail override too, which made the import a second writer of a
 * number the seller owns — and an import called without a price would have wiped
 * one. The seller's price lives in `SellerVariantPrice` now and is read from
 * there by `importProductForSeller`, so this interface is identity only, which
 * is all a mapping ever was.
 */
interface ExistingMapping {
  shopifyProductId: string | null;
  variantMappings: {
    productVariantId: string;
    shopifyVariantId: string;
    shopifyInventoryItemId: string | null;
  }[];
}

interface ResolvedPricing {
  publish?: boolean;
  images: ImportImageRequest[];
  /** Test seam for staged uploads; see `ImportOptions.transferFetch`. */
  transferFetch?: TransferFetch;
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
  /** Null when the bytes must be staged; `staged` then says where they are. */
  originalSource: string | null;
  staged: { storageKey: string; filename: string; mimeType: string } | null;
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
 * The option structure a store product already has.
 *
 * Read only on the re-sync path, and only to answer one question: can this
 * product accept the options the catalogue now describes? A product's options
 * are fixed at creation — every variant must carry one value per option — so a
 * product imported before this mapping existed has a single "Title" option, and
 * sending a new variant with `Size` would ask the store to add an option that
 * its existing variants have no value for.
 */
const PRODUCT_OPTIONS_QUERY = `#graphql
  query MoonVellaProductOptions($id: ID!) {
    product(id: $id) { options { name } }
  }`;

/**
 * The price a variant is listed at, as a Shopify decimal string.
 *
 * THREE SOURCES, IN THE ORDER THE SELLER'S OWN DECISION COMES FIRST:
 *
 *   1. the variant's own price, which is what the seller typed in the app;
 *   2. the family's older override, which is where that number used to live and
 *      is still honoured so a store that set one keeps the price it has;
 *   3. the catalogue's suggested retail.
 *
 * The first two are resolved into `sellerRetailPrice` before this is called —
 * see `importProductForSeller` — so by the time a price is formatted the choice
 * has already been made, once, for the guard and for the mutation alike.
 *
 * NO MARKUP TERM. There used to be a fourth path — a percentage applied to the
 * suggested retail — and it has been removed rather than defaulted to zero. The
 * seller's price is a number the seller chose, and the catalogue's figure is
 * the default they start from; a multiplier on top of that is a second,
 * invisible opinion about what the product should cost, and it cannot express
 * "the King size is ten dollars more" in any case, because it moves the dearest
 * variant furthest. The owner's instruction is that the suggested retail *is*
 * the listed price and that the seller may change it, which leaves no room for
 * a percentage of anything.
 */
export function retailPriceFor(
  suggestedRetailCents: number,
  sellerRetailPrice?: number | null
): string {
  const resolved = resolveRetailCents(suggestedRetailCents, sellerRetailPrice);
  return (resolved / 100).toFixed(2);
}

/** The same resolution in cents, for the checks that must reason about it. */
export function resolveRetailCents(
  suggestedRetailCents: number,
  sellerRetailPrice?: number | null
): number {
  if (sellerRetailPrice != null) return sellerRetailPrice;
  return suggestedRetailCents;
}

/**
 * The variants a store cannot be given a price for.
 *
 * A SHOPIFY LISTING NEEDS A PRICE, AND IT HAS TO BE THE SELLER'S. Suggested
 * retail is optional in MoonVella — a product can be perfectly sellable there
 * with none — but a store cannot be handed a variant with no price, and the two
 * things a number could be borrowed from are both wrong:
 *
 *   • Zero is not "unset". It is a price, and a live one: it would list the
 *     product as free and take orders for it.
 *   • The wholesale price is what the seller pays MoonVella. Setting it as the
 *     retail price would sell at cost, and it would also do it silently, which
 *     is how a shop ends up losing money on every unit without anyone having
 *     chosen to.
 *
 * So the answer is a refusal naming the variants, not a default. A price the
 * seller set is used when it is set, including when it is set to something
 * unusable — an explicit zero is a decision, and a decision to sell at zero is
 * refused rather than quietly replaced by the catalogue figure. (The action that
 * writes a price refuses a zero as well, so a zero can only reach here from the
 * old family-level screen. It is still refused rather than defaulted below,
 * because that column is a price somebody chose.)
 *
 * PER VARIANT, because the price is per variant. It used to take one number for
 * the whole family, which meant a family of three sizes was refused or accepted
 * as a unit: the seller could not list the two sizes they had priced without
 * also listing the one they had not. Now each variant is judged on its own
 * price, and the refusal names the ones that are missing.
 */
export function unpricedRetailVariants(
  variants: { sku: string; name: string; suggestedRetailPrice: number; sellerRetailPrice?: number | null }[]
): { sku: string; name: string }[] {
  return variants
    .filter((variant) => !(resolveRetailCents(variant.suggestedRetailPrice, variant.sellerRetailPrice) > 0))
    .map((variant) => ({ sku: variant.sku, name: variant.name }));
}

/**
 * The refusal, in the seller's terms: what is missing and what to do about it.
 *
 * IT NAMES THE CONTROL THAT FIXES IT. The refusal is read on the catalogue page
 * by somebody who is holding a product card, and "set a suggested retail price"
 * is only useful if it says where. The seller's screen now has one field per
 * variant for exactly this, so the message points at it — and at the fact that
 * the other variants are already fine, because a refusal that reads like the
 * whole product failed is what makes a seller abandon an import that was one
 * number away from working.
 */
export function retailPriceRefusal(unpriced: { sku: string; name: string }[]): string {
  const who = unpriced.map((variant) => variant.sku).join(", ");
  return (
    `Import refused: ${unpriced.length} variant(s) have no suggested retail price to sell at — ${who}. ` +
    `A store must show a price for every variant, so MoonVella will not list these at zero and ` +
    `will not use your cost as the retail price. Set the Suggested Retail for ` +
    `${unpriced.length === 1 ? "that variant" : "those variants"} on the product card, then import again.`
  );
}

/**
 * What the variant costs the seller, as a Shopify decimal string.
 *
 * THIS IS WHAT THE SELLER PAYS, WHICH IS NOT THE SAME NUMBER AS WHAT MOONVELLA
 * PAID. It used to send `costPrice ?? wholesalePrice`: `costPrice` is
 * MoonVella's acquisition cost, recorded in the admin behind an
 * edit-cost permission, and it was being written into the merchant's own
 * Shopify product as "cost per item" — visible to them, and the basis of every
 * margin report their store produces. A seller whose Shopify admin says a
 * pillow cost them $30 when they paid MoonVella $59.99 has a store that
 * believes it is profitable on every unit it loses money on.
 *
 * `wholesalePrice` is the invoice price, and it is the only figure of the two
 * the seller is entitled to see. There is no override: the owner's instruction
 * is that the seller cannot change what the item costs them, and a per-store
 * cost that only one side can see is the shape a billing dispute takes.
 */
export function sellerCostFor(wholesaleCents: number): number {
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
 * happens. That check, and the id diff that makes it possible, live in
 * `addProductMedia` — this function owns the loop, the report and the staging
 * decision, and nothing else.
 *
 * AN IMAGE WITH NO ADDRESS IS STAGED, NOT SKIPPED. An image uploaded through the
 * pipeline has its bytes in this deployment's storage and no public URL; the
 * store cannot fetch it, but it will accept an upload of it. Sending the bytes
 * is what turns "approved and ticked" into "in the seller's store".
 */
async function addSelectedProductMedia(
  admin: AdminGraphql,
  shopifyProductId: string,
  images: ResolvedPricing["images"],
  transferFetch?: TransferFetch
): Promise<MediaUploadResult> {
  const outcomes: MediaUploadOutcome[] = [];
  const warnings: string[] = [];
  const mediaIdByAsset = new Map<string, string>();
  if (!images.length) return { outcomes, warnings, mediaIdByAsset };

  // Fetched once and threaded through the loop: an import of six images pays
  // for one lookup of what the product already holds instead of two per image.
  let known: Set<string> | null = null;

  for (const image of images) {
    const label = image.alt?.trim() || image.originalSource || "image";
    const fail = (message: string, warning: string) => {
      outcomes.push({
        mediaAssetId: image.mediaAssetId,
        ok: false,
        providerMediaId: null,
        error: message,
        skippedExistingId: null,
      });
      warnings.push(warning);
    };

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

    let originalSource = image.originalSource;
    if (!originalSource && image.staged) {
      const bytes = await readObject(image.staged.storageKey).catch(() => null);
      if (!bytes) {
        fail(
          "the stored file could not be read",
          `Image not uploaded (${label}): the stored file could not be read`
        );
        continue;
      }
      const staged = await stageAndUpload({
        admin,
        filename: image.staged.filename,
        mimeType: image.staged.mimeType,
        resource: "IMAGE",
        bytes,
        fetchImpl: transferFetch,
      });
      if (!staged.ok) {
        fail(staged.error, `Image not uploaded (${label}): ${staged.error}`);
        continue;
      }
      originalSource = staged.resourceUrl;
    }
    if (!originalSource) {
      fail(
        "this image has no address and no stored file",
        `Image not uploaded (${label}): this image has no address and no stored file`
      );
      continue;
    }

    const added = await addProductMedia({
      admin,
      shopifyProductId,
      originalSource,
      mediaContentType: image.mediaContentType,
      alt: image.alt,
      known,
    });
    known = added.known;

    if (!added.ok) {
      fail(added.error, `Image not uploaded (${label}): ${added.error}`);
      continue;
    }

    outcomes.push({
      mediaAssetId: image.mediaAssetId,
      ok: true,
      providerMediaId: added.mediaId,
      error: null,
      skippedExistingId: null,
    });
    if (image.mediaAssetId) mediaIdByAsset.set(image.mediaAssetId, added.mediaId);
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

/**
 * The names of the options a store product already has, sorted.
 *
 * Best effort, like the location lookup: a store that cannot answer means the
 * catalogue's mapping is sent, and a mismatch comes back as a userError naming
 * the option rather than as an import that quietly did nothing.
 */
async function fetchProductOptionNames(
  admin: AdminGraphql,
  shopifyProductId: string
): Promise<string[]> {
  try {
    const res = await admin.graphql(PRODUCT_OPTIONS_QUERY, {
      variables: { id: shopifyProductId },
    });
    const json = await res.json();
    const options = json?.data?.product?.options ?? [];
    return options
      .map((option: { name?: string }) => option.name)
      .filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
      .sort();
  } catch {
    return [];
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

/**
 * The product fields the store receives.
 *
 * WHAT IS SENT AND WHY EACH ONE IS HERE. `title` and `descriptionHtml` are the
 * listing; `status` is whether shoppers can see it; `tags` are how the merchant
 * finds the MoonVella lines in their own admin afterwards. The rest closes gaps
 * that made an imported product a stranger in the store it was imported into:
 *
 *   • `productType` was not sent, so every product landed with an empty type
 *     while the merchant's own products had one, and their collections and
 *     filters — which read the type — quietly skipped everything MoonVella.
 *   • `vendor` was not sent either. MoonVella is the vendor; a store where the
 *     brand column is blank cannot answer "what do I stock from MoonVella".
 *   • `seo` was not sent, so the search result for the listing was whatever the
 *     store guessed from the body text. The product already has a name and a
 *     description; the title and the first line of the description are the
 *     honest summary of them, and they cost nothing to send.
 *   • `productCode` goes as a metafield rather than into `sku`, because it
 *     identifies the family and not the sellable unit — the schema comment on
 *     `Product.productCode` says exactly this and has been waiting for it. A
 *     store that later reads MoonVella's code off a product can match it to the
 *     right family rather than to whichever size happened to be imported first.
 */
function productInput(product: ImportableProduct, opts: ResolvedPricing, includeId?: string) {
  const description = (product.description ?? "").trim();

  return {
    ...(includeId ? { id: includeId } : {}),
    title: product.name,
    descriptionHtml: product.description ?? "",
    status: opts.publish === false ? "DRAFT" : "ACTIVE",
    tags: ["MoonVella", product.category],
    productType: product.category,
    vendor: MOONVELLA_VENDOR,
    seo: {
      title: product.name,
      description: (description || product.name).slice(0, 320),
    },
    metafields: [
      {
        namespace: "moonvella",
        key: "product_code",
        value: product.productCode,
        type: "single_line_text_field",
      },
    ],
  };
}

/**
 * The variant's option values, as the store's own option structure.
 *
 * A SHOPIFY OPTION IS A NAME AND A SET OF VALUES, and `productVariantsBulkCreate`
 * builds them from the `optionName` on each variant. Every MoonVella variant
 * therefore has to say which option it belongs to and what its value is: a
 * pillow sold in three sizes is ONE option called "Size" with three values, not
 * three unrelated variants.
 *
 * WHAT WAS SENT BEFORE. Every variant was sent as `Title = <variant name>`,
 * which the store accepts and which produces a product whose only option is
 * "Title" with a value per variant. It looks plausible in the admin and is
 * wrong in the two places it matters: the storefront renders a variant picker
 * labelled "Title" holding "Standard", "Queen" and "King", and any collection
 * or report that groups by option sees one meaningless option instead of a
 * size. It also cannot express a second dimension — a colour and a size would
 * both have had to be folded into the variant's name.
 *
 * The fallback to `Title` is deliberate and is not a leftover: a product sold
 * as a single thing has no option rows, and Shopify requires at least one
 * option value per variant. For those, the variant's own name is the honest
 * value — it is what the seller sees in the catalogue.
 *
 * SORTED, so the store's option values come out in the order the merchant
 * arranged them rather than in whatever order the rows were read.
 */
function mappedOptionValues(
  variant: ImportableVariant
): { optionName: string; name: string }[] {
  const options = (variant.variantOptions ?? []).filter(
    (option) => option.name?.trim() && option.value?.trim()
  );

  if (!options.length) return [{ optionName: "Title", name: variant.name }];

  return options.map((option) => ({ optionName: option.name, name: option.value }));
}

/**
 * The option values to send for a variant being ADDED to a product that already
 * exists, given the options the store product already has.
 *
 * The catalogue's mapping is used when it matches, which is the normal case for
 * a product imported by this code: a re-sync that meets a new size sends
 * `Size = Queen` and the store files it under the option it already has.
 *
 * When it does not match, the store's own single option wins. That is not a
 * fallback for convenience — a product whose only option is "Title" cannot
 * accept a second option without every existing variant being given a value for
 * it, and `productVariantsBulkCreate` will not do that. Sending the compatible
 * shape keeps the variant creation working and leaves the option structure
 * alone, which is the most that can be done from here.
 *
 * A product with several options that match nothing is sent the catalogue's
 * mapping anyway. There is no compatible value to guess — the merchant chose
 * those options by hand in their own admin — and an honest userError naming the
 * mismatch is a better outcome than a variant silently filed under the wrong
 * one.
 */
function optionValuesForStore(
  storeOptionNames: string[],
  variant: ImportableVariant
): { optionName: string; name: string }[] {
  const mapped = mappedOptionValues(variant);
  const mappedNames = [...new Set(mapped.map((option) => option.optionName))].sort();

  if (sameNames(mappedNames, storeOptionNames)) return mapped;
  if (storeOptionNames.length === 1) {
    return [{ optionName: storeOptionNames[0], name: variant.name }];
  }
  return mapped;
}

function sameNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((name, index) => name === b[index]);
}

/**
 * The weight, in the unit the store's API expects.
 *
 * Stored canonically in kilograms (see `ProductVariant.productWeightKg`) and
 * sent as KILOGRAMS rather than converted: the number the merchant typed is the
 * number the carrier bills on, and round-tripping it through pounds to satisfy
 * an imperial default would put a rounding error into a shipping label. A
 * missing weight sends nothing at all — an absent weight is a fact about the
 * record, and a zero would be read by the store as a product that weighs
 * nothing.
 */
function weightMeasurement(variant: ImportableVariant): Record<string, unknown> {
  const raw = variant.productWeightKg;
  if (raw === null || raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return {};
  return { measurement: { weight: { value, unit: "KILOGRAMS" } } };
}

function variantPriceInput(variant: ImportableVariant) {
  const barcode = variant.barcode?.trim();

  return {
    price: retailPriceFor(variant.suggestedRetailPrice, variant.sellerRetailPrice),
    inventoryItem: {
      tracked: true,
      cost: sellerCostFor(variant.wholesalePrice),
      sku: variant.sku,
      ...weightMeasurement(variant),
    },
    ...(barcode ? { barcode } : {}),
  };
}

/** The vendor every imported product carries. */
const MOONVELLA_VENDOR = "MoonVella";

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
  resolved: { local: ImportableVariant; shopifyVariant: ShopifyVariant | null }[]
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
      },
      /*
       * THE PRICES ARE NOT WRITTEN HERE, AND THAT IS THE POINT.
       *
       * `SellerProduct.customWholesalePrice` and `customRetailPrice` are the
       * family-level overrides from the screen that had one price box per
       * product. They used to be overwritten with whatever the import was
       * passed, which was harmless only because the form sent back the same
       * numbers. Now that the seller's price lives on the variant row and is
       * written by the action that edits it, an import that echoed a value back
       * would be a second writer of a price the seller owns — and an import
       * called with no price at all would wipe a legacy override that a store
       * is still listed at.
       *
       * So the import reads prices and writes mappings, and nothing else. The
       * family columns keep whatever they were set to; see `customRetailPrice`
       * on the interface for why they are still read.
       */
      update: {
        shopifyProductId,
        importedAt: new Date(),
        importStatus: "SUCCESS",
        lastImportError: null,
        isActive: true,
        shopifyVariantIds: JSON.stringify(shopifyVariantIds),
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

  const upload = await addSelectedProductMedia(admin, shopifyProductId, opts.images, opts.transferFetch);
  const warnings = [...upload.warnings];

  const variantInputs = product.variants.map((variant) => ({
    optionValues: mappedOptionValues(variant),
    sku: variant.sku,
    ...variantPriceInput(variant),
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

  const result = await persistMappings(seller, product, shopifyProductId, locationId, resolved);

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

  // Read before anything is sent, because it decides the shape of the variant
  // inputs below and the product update above it is not reversible in the
  // meantime. A store that does not answer leaves the list empty, which sends
  // the catalogue's mapping — see `optionValuesForStore`.
  const storeOptionNames = await fetchProductOptionNames(admin, shopifyProductId);

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
  const upload = await addSelectedProductMedia(admin, shopifyProductId, opts.images, opts.transferFetch);
  warnings.push(...upload.warnings);

  const mappingByVariant = new Map(
    existing.variantMappings.map((mapping) => [mapping.productVariantId, mapping])
  );

  const updateInputs: Record<string, unknown>[] = [];
  const createInputs: Record<string, unknown>[] = [];
  for (const variant of product.variants) {
    const mapping = mappingByVariant.get(variant.id);
    if (mapping) {
      updateInputs.push({ id: mapping.shopifyVariantId, ...variantPriceInput(variant) });
    } else {
      createInputs.push({
        optionValues: optionValuesForStore(storeOptionNames, variant),
        sku: variant.sku,
        ...variantPriceInput(variant),
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

  const result = await persistMappings(seller, product, shopifyProductId, locationId, resolved);

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
      variants: {
        where: { isActive: true },
        orderBy: { sku: "asc" },
        include: {
          // The variant's own option pairs — Size = King — which become the
          // store product's option structure. Ordered the way the merchant
          // arranged them so the storefront's picker matches the catalogue's.
          variantOptions: { orderBy: { sortOrder: "asc" }, select: { name: true, value: true } },
        },
      },
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

  /*
   * THE SELLER'S PRICE FOR EACH VARIANT, READ AND RESOLVED ONCE, HERE.
   *
   * Three sources, in the order the seller's own decision comes first: the price
   * the seller set for this variant, then the family's older override, then the
   * catalogue's suggested retail — which `resolveRetailCents` applies at the
   * moment a price is formatted, so a variant with neither simply carries null.
   *
   * IT IS READ FROM THE DATABASE ON EVERY IMPORT, INCLUDING A RE-SYNC, rather
   * than passed in. That is what makes the number typed on the catalogue card
   * the number the store is listed at, and it is why an import cannot be talked
   * into a price by whatever a form happened to post.
   *
   * Resolving it here rather than inside the price call is what makes the guard
   * below and the price that is actually sent the same calculation. They were
   * two, once: the guard took one family-level number while the price call
   * applied a markup on top of the catalogue figure, so a variant the guard had
   * approved could still be listed at a number nobody chose.
   */
  const sellerPriceByVariant = await loadSellerRetailPrices(
    sellerId,
    product.variants.map((variant) => variant.id)
  );
  const familyRetailOverride = existing?.customRetailPrice ?? null;

  const variants: ImportableVariant[] = product.variants.map((variant) => ({
    ...variant,
    sellerRetailPrice:
      sellerPriceByVariant.get(variant.id) ?? familyRetailOverride ?? null,
  }));

  /*
   * EVERY VARIANT MUST HAVE A RETAIL PRICE BEFORE ANYTHING IS SENT.
   *
   * Checked here rather than left to the price call because the price call
   * cannot refuse — it formats a number, and given nothing it formats "0.00",
   * which Shopify accepts. A store listed at zero takes real orders at zero.
   *
   * A price the seller set for this store is read from the stored record on
   * every import, so a re-sync never re-derives it from the catalogue: a retail
   * price set for one store survives every later import of the same product.
   */
  const unpriced = unpricedRetailVariants(variants);
  if (unpriced.length > 0) {
    const message = retailPriceRefusal(unpriced);
    await markImportFailed(sellerId, productId, message);
    await setIntegrationState("product_import", { status: "FAILED", error: message });
    return { ok: false, error: message };
  }

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
   *
   * ONE LIST, NOT TWO. A legacy image used to be added a second time from the
   * product's own media, because the selection could only speak for assets with
   * a fetchable URL and those were left to a separate path. The selection now
   * covers every eligible image, including the pipeline ones it used to refuse;
   * keeping the old path as well would have sent the same photograph twice, once
   * by URL and once by upload.
   */
  const selection = await resolveImagesForImport(sellerId, productId);
  const opts: ResolvedPricing = {
    publish: options.publish,
    ...(options.transferFetch ? { transferFetch: options.transferFetch } : {}),
    images: selection.images.map((image) => ({
      mediaAssetId: image.mediaAssetId,
      originalSource: image.url,
      staged: image.staged,
      mediaContentType: "IMAGE" as const,
      ...(image.alt ? { alt: image.alt } : {}),
      variantIds: image.variantIds,
      alreadyUploadedAs: image.alreadyUploadedAs,
    })),
  };

  /*
   * The product the rest of this function works on carries the resolved
   * per-variant price, not the catalogue's raw one. The guard above and the
   * price that gets sent are then the same number by construction.
   */
  const priced: ImportableProduct = { ...product, variants };

  try {
    if (existing?.shopifyProductId && existing.variantMappings.length > 0) {
      return await resyncExistingProduct(admin, seller, priced, existing, opts);
    }
    return await createNewProduct(admin, seller, priced, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    await setIntegrationState("product_import", { status: "FAILED", error: message });
    await markImportFailed(sellerId, productId, message);
    return { ok: false, error: message };
  }
}
