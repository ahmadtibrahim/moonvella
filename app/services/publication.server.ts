import { prisma } from "~/db.server";

/**
 * The publication gate.
 *
 * "Publish to Sellers" is the moment an unfinished product can become something
 * a merchant orders. Every rule that must hold before that happens is expressed
 * here, in one list, and every path to publishing runs through `assertPublishable`.
 *
 * WHY THIS IS NOT A DISABLED BUTTON. A disabled button is a hint to a person
 * using the interface as intended. It is not a control: the same POST can be
 * made directly, and a second caller — a script, a bulk action, a future API —
 * never sees the button at all. The button and this checklist both exist; only
 * this one is the control.
 *
 * This module reads the database directly rather than importing the media or
 * product services, so that the product service can import *it* without the two
 * forming a cycle.
 */

export interface ReadinessCheck {
  /** Stable key, so the interface can link a failure to the tab that fixes it. */
  key: string;
  label: string;
  ok: boolean;
  /** What to do about it. Present whether or not the check passed. */
  detail: string;
  /** Which editor tab resolves it. */
  tab: "details" | "variants" | "media" | "documents" | "marketing";
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheck[];
  /** The subset that is actually blocking, for a message. */
  blockers: ReadinessCheck[];
}

/** Categories a seller sees as product imagery, which therefore need alt text. */
const IMAGE_CATEGORIES = ["WHITE_BACKGROUND_IMAGE", "LIFESTYLE_IMAGE"];

export async function publicationReadiness(productId: string): Promise<ReadinessReport> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      productCode: true,
      description: true,
      category: true,
      variants: {
        select: {
          id: true,
          sku: true,
          name: true,
          isActive: true,
          isDefault: true,
          wholesalePrice: true,
          suggestedRetailPrice: true,
          inventory: true,
          productWeightKg: true,
        },
      },
      mediaAssets: {
        select: {
          id: true,
          title: true,
          altText: true,
          category: true,
          processingStatus: true,
          approvalStatus: true,
          sellerVisible: true,
          documentType: true,
          version: true,
          durationSeconds: true,
          assignments: { select: { variantId: true, isPrimary: true } },
        },
      },
    },
  });

  if (!product) {
    return {
      ready: false,
      blockers: [
        {
          key: "missing",
          label: "Product exists",
          ok: false,
          detail: "This product could not be found.",
          tab: "details",
        },
      ],
      checks: [],
    };
  }

  const checks: ReadinessCheck[] = [];
  const active = product.variants.filter((variant) => variant.isActive);

  checks.push({
    key: "name",
    label: "Product has a name",
    ok: Boolean(product.name.trim()),
    detail: "The family name a seller sees.",
    tab: "details",
  });

  checks.push({
    key: "code",
    label: "Product Code is set",
    ok: Boolean(product.productCode.trim()),
    detail: "Internal code identifying this product family.",
    tab: "details",
  });

  checks.push({
    key: "category",
    label: "Category is set",
    ok: Boolean(product.category.trim()),
    detail: "Used to group the catalogue and to tag the Shopify export.",
    tab: "details",
  });

  checks.push({
    key: "description",
    label: "Description is written",
    ok: Boolean(product.description?.trim()),
    detail: "A family with no description gives a seller nothing to sell from.",
    tab: "details",
  });

  checks.push({
    key: "has_variant",
    label: "At least one active variant exists",
    ok: active.length > 0,
    detail:
      "The product is the family; the variant is the thing that ships. Add a size, colour or configuration.",
    tab: "variants",
  });

  checks.push({
    key: "default_variant",
    label: "A default variant is chosen",
    ok: active.some((variant) => variant.isDefault),
    detail: "The variant used when a seller does not pick one.",
    tab: "variants",
  });

  const unpriced = active.filter(
    (variant) => variant.wholesalePrice <= 0 || variant.suggestedRetailPrice <= 0
  );
  checks.push({
    key: "variant_prices",
    label: "Every active variant has both prices",
    ok: unpriced.length === 0,
    detail: unpriced.length
      ? `Missing a price: ${unpriced.map((v) => v.sku).join(", ")}.`
      : "Wholesale and suggested retail, each above zero.",
    tab: "variants",
  });

  const skus = active.map((variant) => variant.sku.trim().toUpperCase());
  const duplicateSkus = skus.filter((sku, index) => skus.indexOf(sku) !== index);
  checks.push({
    key: "variant_skus",
    label: "Variant SKUs are present and unique",
    ok: duplicateSkus.length === 0 && skus.every(Boolean),
    detail: duplicateSkus.length
      ? `Duplicate SKU(s): ${[...new Set(duplicateSkus)].join(", ")}.`
      : "Each sellable variant carries its own SKU.",
    tab: "variants",
  });

  const sellerImages = product.mediaAssets.filter(
    (asset) =>
      IMAGE_CATEGORIES.includes(asset.category) &&
      asset.approvalStatus === "APPROVED" &&
      asset.sellerVisible
  );
  checks.push({
    key: "seller_image",
    label: "At least one approved, seller-visible image",
    ok: sellerImages.length > 0,
    detail:
      "Approving an image is what lets it reach a seller; a draft image is visible only here.",
    tab: "media",
  });

  // Alt text is an accessibility requirement that has to hold before an image
  // can be shown to a buyer, so it gates publication rather than being a
  // warning that is never acted on.
  const missingAlt = sellerImages.filter((asset) => !asset.altText?.trim());
  checks.push({
    key: "alt_text",
    label: "Every seller-visible image has alt text",
    ok: missingAlt.length === 0,
    detail: missingAlt.length
      ? `Missing alt text: ${missingAlt.map((a) => a.title).join(", ")}.`
      : "Describes the image for a screen reader.",
    tab: "media",
  });

  const hasPrimary = product.mediaAssets.some(
    (asset) =>
      IMAGE_CATEGORIES.includes(asset.category) &&
      asset.approvalStatus === "APPROVED" &&
      asset.sellerVisible &&
      asset.assignments.some((assignment) => assignment.isPrimary)
  );
  checks.push({
    key: "primary_image",
    label: "A primary image is set",
    ok: hasPrimary,
    detail: "The image a seller sees first in the catalogue.",
    tab: "media",
  });

  const stuck = product.mediaAssets.filter(
    (asset) =>
      asset.sellerVisible && asset.processingStatus !== "READY" && asset.processingStatus !== "FAILED"
  );
  checks.push({
    key: "processing",
    label: "No seller-visible asset is still processing",
    ok: stuck.length === 0,
    detail: stuck.length
      ? `Still processing: ${stuck.map((a) => a.title).join(", ")}.`
      : "Every seller-visible file has finished processing.",
    tab: "media",
  });

  // A video whose length was never measured has not been reviewed. Without
  // ffprobe in the image this is the honest state, not an error.
  const unmeasuredVideo = product.mediaAssets.filter(
    (asset) => asset.sellerVisible && asset.category === "PRODUCT_VIDEO" && asset.durationSeconds === null
  );
  checks.push({
    key: "video_duration",
    label: "Every seller-visible video has a known length",
    ok: unmeasuredVideo.length === 0,
    detail: unmeasuredVideo.length
      ? `Length could not be measured: ${unmeasuredVideo.map((a) => a.title).join(", ")}.`
      : "Clip length is known.",
    tab: "media",
  });

  const sellerDocuments = product.mediaAssets.filter(
    (asset) => asset.category === "DOCUMENT" && asset.approvalStatus === "APPROVED" && asset.sellerVisible
  );
  const documentsMissingType = sellerDocuments.filter((asset) => !asset.documentType);
  checks.push({
    key: "document_type",
    label: "Every seller-visible document has a type",
    ok: documentsMissingType.length === 0,
    detail: documentsMissingType.length
      ? `No type set: ${documentsMissingType.map((a) => a.title).join(", ")}.`
      : "Care guide, specification sheet, warranty and so on.",
    tab: "documents",
  });

  const rejected = product.mediaAssets.filter((asset) => asset.approvalStatus === "REJECTED");
  checks.push({
    key: "no_rejected_visible",
    label: "No rejected asset is still seller-visible",
    ok: rejected.every((asset) => !asset.sellerVisible),
    detail: "Rejecting an asset withdraws it from sellers.",
    tab: "media",
  });

  const blockers = checks.filter((check) => !check.ok);
  return { ready: blockers.length === 0, checks, blockers };
}

/**
 * The control. Called before any write that would make a product visible to
 * sellers, whether it came from the editor, the list, or anything else.
 *
 * The message names every blocker rather than the first one, so a merchant
 * fixes the page in one pass instead of discovering the next problem each time
 * they press the button.
 */
export async function assertPublishable(productId: string): Promise<void> {
  const report = await publicationReadiness(productId);
  if (report.ready) return;

  const lines = report.blockers.map((check) => `• ${check.label} — ${check.detail}`);
  throw new Error(
    `This product is not ready to publish:\n${lines.join("\n")}`
  );
}
