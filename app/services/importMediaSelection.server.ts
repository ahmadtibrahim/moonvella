/**
 * Which images an import is allowed to take, and what happened to each one.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE is that an exclusion sticks. A seller
 * who removes a photograph from the import list has made a decision about their
 * storefront, and the failure mode being guarded against is the quiet one:
 * the next sync sees the image is still approved and seller-visible, the form
 * is re-rendered from scratch, and the photograph the seller deleted is back on
 * their product page. Nobody gets an error; the seller just notices, weeks
 * later, that their store looks wrong.
 *
 * So the choice is stored per (seller, product, asset), and an import reads the
 * stored choice rather than recomputing one. The unique constraint is what makes
 * a retry safe: saving the same decision twice updates one row.
 *
 * THE ELIGIBILITY GATE IS THE SAME ONE THE IMPORT ALREADY USES — approved and
 * seller-visible — and it is applied here as well rather than trusted to the
 * caller. The preview a seller sees must not be able to offer an image the
 * import would then refuse, and the import must not be able to send an image
 * the review process has not cleared. Both sides read this function.
 *
 * NO STORED CHOICE MEANS EVERYTHING ELIGIBLE, AND SAYS SO. It would be easy to
 * make the first import import nothing until a choice is made, but that turns a
 * missing step into a broken product. Instead the first import behaves as it
 * always has, and the result carries `defaulted: true` so the interface can say
 * plainly that nothing has been chosen yet.
 */

import { prisma } from "~/db.server";
import { redactSecrets } from "./credentials.server";
import { listProductMedia, type MediaAssetView } from "./media.server";
import { transferFilename } from "./shopifyTransfer.server";

/** The categories an import may carry. Documents and marketing material are not images. */
export const IMPORTABLE_IMAGE_CATEGORIES = ["WHITE_BACKGROUND_IMAGE", "LIFESTYLE_IMAGE"] as const;

export interface SelectableImage {
  mediaAssetId: string;
  /** What the seller sees. Never a storage key. */
  url: string;
  title: string;
  altText: string | null;
  category: string;
  width: number | null;
  height: number | null;
  /** True when the file predates the storage pipeline and lives at a URL. */
  isLegacy: boolean;
  /** Variants this image is attached to; empty means the whole family. */
  variantIds: string[];
  /** Variants for which this is the primary image. */
  primaryForVariantIds: string[];
  selected: boolean;
  isMain: boolean;
  sortOrder: number;
  uploadStatus: string;
  providerMediaId: string | null;
  uploadAttempts: number;
  lastUploadError: string | null;
}

export interface SelectionView {
  productId: string;
  sellerId: string;
  images: SelectableImage[];
  /** True when nothing has been saved yet and the defaults below are in force. */
  defaulted: boolean;
  /** Images eligible for import but not selected. */
  excludedCount: number;
  selectedCount: number;
  /** Failures from a previous attempt, so a retry can be offered. */
  failures: { mediaAssetId: string; title: string; error: string | null; attempts: number }[];
}

/**
 * The eligible images for a product, with this seller's saved choices applied.
 *
 * A seller who has never saved a selection sees every eligible image ticked,
 * which is the behaviour the import already had. A seller who has saved one
 * sees exactly what they saved, including the images they removed — the rows
 * exist, they are simply `selected: false`, and they stay that way until
 * somebody ticks them again.
 */
export async function listSelectableImages(
  sellerId: string,
  productId: string
): Promise<SelectionView> {
  const [assets, saved] = await Promise.all([
    listProductMedia(productId),
    prisma.importMediaSelection.findMany({ where: { sellerId, productId } }),
  ]);

  const eligible = assets.filter(
    (asset) =>
      asset.approvalStatus === "APPROVED" &&
      asset.sellerVisible &&
      (IMPORTABLE_IMAGE_CATEGORIES as readonly string[]).includes(asset.category)
  );

  const savedByAsset = new Map(saved.map((row) => [row.mediaAssetId, row]));
  const defaulted = saved.length === 0;

  const images: SelectableImage[] = eligible.map((asset, index) => {
    const row = savedByAsset.get(asset.id);
    return {
      mediaAssetId: asset.id,
      url: asset.url,
      title: asset.title,
      altText: asset.altText,
      category: asset.category,
      width: asset.width,
      height: asset.height,
      isLegacy: asset.isLegacy,
      variantIds: asset.assignments
        .map((assignment) => assignment.variantId)
        .filter((id): id is string => id !== null),
      primaryForVariantIds: asset.assignments
        .filter((assignment) => assignment.isPrimary && assignment.variantId !== null)
        .map((assignment) => assignment.variantId as string),
      selected: row ? row.selected : true,
      isMain: row?.isMain ?? false,
      sortOrder: row?.sortOrder ?? index,
      uploadStatus: row?.uploadStatus ?? "PENDING",
      providerMediaId: row?.providerMediaId ?? null,
      uploadAttempts: row?.uploadAttempts ?? 0,
      lastUploadError: row?.lastUploadError ?? null,
    };
  });

  const failures = images
    .filter((image) => image.uploadStatus === "FAILED")
    .map((image) => ({
      mediaAssetId: image.mediaAssetId,
      title: image.title,
      error: image.lastUploadError,
      attempts: image.uploadAttempts,
    }));

  return {
    productId,
    sellerId,
    images,
    defaulted,
    selectedCount: images.filter((image) => image.selected).length,
    excludedCount: images.filter((image) => !image.selected).length,
    failures,
  };
}

export interface SaveSelectionInput {
  sellerId: string;
  productId: string;
  /** Every eligible asset id the seller wants imported. */
  selectedMediaAssetIds: string[];
  /** The chosen main image, or null to fall back to the first selected. */
  mainMediaAssetId?: string | null;
  /** Explicit order. Assets not listed keep their relative order after these. */
  order?: string[];
}

/**
 * Persist a selection.
 *
 * WRITTEN AS ONE TRANSACTION, because a half-saved selection is worse than none:
 * if the main image were cleared and the save then failed, the seller would be
 * left with no main image and no way to tell whether their exclusions had been
 * applied. The whole decision lands or none of it does.
 *
 * AN ASSET THE SELLER DROPPED KEEPS ITS ROW. Deleting it would look tidier and
 * would break the guarantee this module exists for — the row is the record that
 * this image was considered and refused, and without it the next import would
 * see an approved, seller-visible image and take it.
 *
 * A CHANGE OF SELECTION RESETS THE UPLOAD STATE ONLY FOR WHAT ACTUALLY CHANGED.
 * Re-ticking an image that failed keeps its `providerMediaId` and its attempt
 * count, so the retry is a retry. Ticking one that was never sent is PENDING.
 * Unticking one that already reached the store leaves the record that it is
 * there — removing an image from a storefront is a different operation from
 * never having sent it, and pretending otherwise would make the row lie.
 */
export interface SaveSelectionResult {
  /** Rows written, selected and excluded alike. */
  saved: number;
  selected: number;
  main: string | null;
  /** Submitted ids that are not eligible for this product, so were not recorded. */
  ignored: string[];
}

export async function saveImageSelection(input: SaveSelectionInput): Promise<SaveSelectionResult> {
  const view = await listSelectableImages(input.sellerId, input.productId);
  const eligibleById = new Map(view.images.map((image) => [image.mediaAssetId, image]));

  const requested = input.selectedMediaAssetIds.filter((id) => eligibleById.has(id));
  const rejected = input.selectedMediaAssetIds.filter((id) => !eligibleById.has(id));

  const order = (input.order ?? []).filter((id) => eligibleById.has(id));
  const ordered = [
    ...order,
    ...view.images.map((image) => image.mediaAssetId).filter((id) => !order.includes(id)),
  ];
  const sortIndex = new Map(ordered.map((id, index) => [id, index]));

  const mainCandidate =
    input.mainMediaAssetId && requested.includes(input.mainMediaAssetId)
      ? input.mainMediaAssetId
      : requested[0] ?? null;

  await prisma.$transaction(async (tx) => {
    for (const image of view.images) {
      const shouldSelect = requested.includes(image.mediaAssetId);
      const changed = shouldSelect !== image.selected;

      await tx.importMediaSelection.upsert({
        where: {
          sellerId_productId_mediaAssetId: {
            sellerId: input.sellerId,
            productId: input.productId,
            mediaAssetId: image.mediaAssetId,
          },
        },
        create: {
          sellerId: input.sellerId,
          productId: input.productId,
          mediaAssetId: image.mediaAssetId,
          selected: shouldSelect,
          isMain: image.mediaAssetId === mainCandidate,
          sortOrder: sortIndex.get(image.mediaAssetId) ?? 0,
        },
        update: {
          selected: shouldSelect,
          isMain: image.mediaAssetId === mainCandidate,
          sortOrder: sortIndex.get(image.mediaAssetId) ?? 0,
          // Only a genuine change of mind resets the upload state. Re-saving
          // the same selection must not turn a completed upload back into a
          // pending one, which would send the image a second time.
          ...(changed && !shouldSelect && image.uploadStatus !== "UPLOADED"
            ? { uploadStatus: "PENDING", lastUploadError: null }
            : {}),
        },
      });
    }
  });

  return {
    saved: view.images.length,
    selected: requested.length,
    main: mainCandidate,
    // An id that is not eligible was dropped rather than stored. Reported so a
    // stale form does not appear to have been accepted in full.
    ignored: rejected,
  };
}

export interface ResolvedImportImage {
  mediaAssetId: string;
  /**
   * The address the store can fetch the image from, when it has one.
   *
   * Null means the bytes are in this deployment's own storage instead — which
   * has no public origin — and `staged` says how to send them. It is null rather
   * than a `/uploads/...` path on purpose: a relative path is not something
   * Shopify can fetch, and handing one over would look like an address while
   * behaving like a 404.
   */
  url: string | null;
  /** Set when the file must be uploaded: the store cannot fetch our storage. */
  staged: { storageKey: string; filename: string; mimeType: string } | null;
  alt: string | null;
  sortOrder: number;
  isMain: boolean;
  variantIds: string[];
  /** Set when a previous attempt already put this image in the store. */
  alreadyUploadedAs: string | null;
}

export interface ResolvedImportImages {
  images: ResolvedImportImage[];
  /** Eligible and selected but with no addressable URL, so skipped. */
  unusable: { mediaAssetId: string; title: string; reason: string }[];
  /** True when no selection was stored and every eligible image is being sent. */
  defaulted: boolean;
}

/**
 * The images an import should send, in order, main first.
 *
 * `alreadyUploadedAs` is the anti-duplicate mechanism. A store's media API
 * rejects the same source twice in one call and silently accepts a duplicate
 * across calls, so an image that a previous attempt already placed is reported
 * with the store's own id for it and skipped by the caller. The store is not
 * ours to write twice, and a duplicate is visible to shoppers.
 */
export async function resolveImagesForImport(
  sellerId: string,
  productId: string
): Promise<ResolvedImportImages> {
  const view = await listSelectableImages(sellerId, productId);
  const selected = view.images.filter((image) => image.selected);

  // The storage keys are read here, on the server, and they are the one thing a
  // view deliberately withholds — it reports a URL instead, so that a key never
  // travels to a browser. The import is the caller that needs the bytes, so this
  // is where they are looked up.
  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: selected.map((image) => image.mediaAssetId) } },
    select: {
      id: true,
      storageKey: true,
      mimeType: true,
      originalFilename: true,
      title: true,
    },
  });
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const images: ResolvedImportImage[] = [];
  const unusable: ResolvedImportImages["unusable"] = [];

  for (const image of selected) {
    if (image.uploadStatus === "UPLOADED" && image.providerMediaId) {
      images.push({
        mediaAssetId: image.mediaAssetId,
        url: image.url,
        staged: null,
        alt: image.altText,
        sortOrder: image.sortOrder,
        isMain: image.isMain,
        variantIds: image.variantIds,
        alreadyUploadedAs: image.providerMediaId,
      });
      continue;
    }
    if (/^https?:\/\//i.test(image.url)) {
      images.push({
        mediaAssetId: image.mediaAssetId,
        url: image.url,
        staged: null,
        alt: image.altText,
        sortOrder: image.sortOrder,
        isMain: image.isMain,
        variantIds: image.variantIds,
        alreadyUploadedAs: null,
      });
      continue;
    }

    // No address the store can fetch. That used to end the story for every
    // image uploaded through the new pipeline: it was reported as unusable and
    // skipped, so a merchant could approve a photograph, tick it for import, and
    // watch it never arrive. The bytes are in our storage, and a staged upload
    // is how they get out — the store will accept them even though it cannot
    // reach us, because the upload comes from here.
    const row = rowById.get(image.mediaAssetId);
    if (row?.storageKey) {
      images.push({
        mediaAssetId: image.mediaAssetId,
        url: null,
        staged: {
          storageKey: row.storageKey,
          filename: transferFilename(row),
          mimeType: row.mimeType,
        },
        alt: image.altText,
        sortOrder: image.sortOrder,
        isMain: image.isMain,
        variantIds: image.variantIds,
        alreadyUploadedAs: null,
      });
      continue;
    }

    unusable.push({
      mediaAssetId: image.mediaAssetId,
      title: image.title,
      reason: "This image's file is no longer in MoonVella's storage, so there is nothing to send.",
    });
  }

  images.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.sortOrder - b.sortOrder;
  });

  return { images, unusable, defaulted: view.defaulted };
}

/**
 * Record what happened to each image, so a retry retries only what failed.
 *
 * Partial failure is the normal case for an image import: the store accepts
 * four images and rejects the fifth for a reason that has nothing to do with
 * the other four. Reporting that as one success or one failure loses the
 * distinction, so each asset gets its own outcome and the failures carry a
 * reason a person can act on.
 *
 * Provider messages are redacted before storage. A media API's error body can
 * quote the request back, and the request carries the store's token.
 */
export async function recordImageOutcomes(
  sellerId: string,
  productId: string,
  outcomes: { mediaAssetId: string; ok: boolean; providerMediaId?: string | null; error?: string | null }[]
): Promise<{ uploaded: number; failed: number }> {
  let uploaded = 0;
  let failed = 0;

  for (const outcome of outcomes) {
    const where = {
      sellerId_productId_mediaAssetId: { sellerId, productId, mediaAssetId: outcome.mediaAssetId },
    };
    const existing = await prisma.importMediaSelection.findUnique({ where });
    if (!existing) continue;

    if (outcome.ok) {
      uploaded++;
      await prisma.importMediaSelection.update({
        where,
        data: {
          uploadStatus: "UPLOADED",
          providerMediaId: outcome.providerMediaId ?? existing.providerMediaId,
          uploadedAt: new Date(),
          uploadAttempts: existing.uploadAttempts + 1,
          lastUploadError: null,
        },
      });
      continue;
    }

    failed++;
    await prisma.importMediaSelection.update({
      where,
      data: {
        uploadStatus: "FAILED",
        uploadAttempts: existing.uploadAttempts + 1,
        lastUploadError: redactSecrets(outcome.error ?? "The store rejected this image."),
      },
    });
  }

  return { uploaded, failed };
}

/** Which stored image a provider media id belongs to, for a later sync. */
export async function findSelectionByProviderMediaId(
  sellerId: string,
  providerMediaId: string
) {
  return prisma.importMediaSelection.findFirst({ where: { sellerId, providerMediaId } });
}

/** The seller's chosen main image, if one has been saved. */
export async function mainImageFor(sellerId: string, productId: string) {
  return prisma.importMediaSelection.findFirst({
    where: { sellerId, productId, isMain: true, selected: true },
  });
}

export type { MediaAssetView };
