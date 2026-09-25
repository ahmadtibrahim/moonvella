import { prisma } from "~/db.server";
import { isSellerFacing, type MediaStateFields } from "./mediaState";

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

/**
 * An image a seller could actually be shown.
 *
 * The moderation half of the question — switched on, not rejected — is answered
 * by `isSellerFacing`, which is the same function the catalogue, the file route
 * and the Shopify transfer use, so those four screens cannot disagree about a
 * file. This adds the category: a document is offered to a seller too, but it is
 * not a picture of the product.
 *
 * NOTE WHAT IS NOT ASKED FOR HERE. `approvalStatus === "APPROVED"` used to be
 * part of this test, and it is the reason a product full of finished
 * photographs could not be published: every file uploaded through the Admin
 * Panel was created a draft and stayed one until its uploader approved it.
 */
function isActiveImage(asset: { category: string } & MediaStateFields): boolean {
  return IMAGE_CATEGORIES.includes(asset.category) && isSellerFacing(asset);
}

/**
 * Whether the asset makes the product-family claim (`variantId === null`)
 * rather than one variant's.
 *
 * The product-level gallery is what a seller sees before choosing a size, and
 * what the catalogue card and the Shopify product are pictured with, so a
 * family that has only variant photographs has no picture of itself.
 */
function isProductLevel(asset: { assignments: { variantId: string | null; isPrimary: boolean }[] }): boolean {
  return asset.assignments.some((assignment) => assignment.variantId === null);
}

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

  /*
   * WHOLESALE ONLY, AND THAT IS THE WHOLE RULE.
   *
   * Wholesale is what a seller is charged, so a product without it must not
   * reach them. Suggested retail is a different field with a different owner:
   * it is MoonVella's own editorial suggestion, it is optional, and it is not
   * imported from Odoo — so it can legitimately be zero on a product that is
   * perfectly sellable. Blocking on it would mean a catalogue that cannot be
   * published until somebody names a retail price nobody requires, and the
   * remedy people reach for under that pressure is to copy the wholesale figure
   * into it, which is exactly the substitution this field was separated from.
   */
  const unpriced = active.filter((variant) => variant.wholesalePrice <= 0);
  checks.push({
    key: "variant_prices",
    label: "Every active variant has a wholesale price",
    ok: unpriced.length === 0,
    detail: unpriced.length
      ? `No wholesale price: ${unpriced.map((v) => v.sku).join(", ")}. This is what a seller is charged, so it cannot be blank.`
      : "Each active variant is priced above zero. Suggested retail is optional and set by the editor, not by an import.",
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

  /*
   * THE FAMILY NEEDS A PICTURE OF ITSELF, not just pictures of its sizes.
   *
   * This asks for a product-level image — one attached to the family rather
   * than to a variant — because that is the image the catalogue card, the
   * Shopify product and the gallery before any size is chosen are all built
   * from. A family whose only photographs hang off "Queen" has nothing to be
   * represented by, and the seller's first sight of it would be blank.
   *
   * It has to have finished processing, because a file still being measured
   * cannot be shipped to anyone yet.
   */
  const familyImages = product.mediaAssets.filter(
    (asset) => isActiveImage(asset) && isProductLevel(asset) && asset.processingStatus === "READY"
  );
  checks.push({
    key: "seller_image",
    label: "At least one active, seller-visible product image",
    ok: familyImages.length > 0,
    detail: familyImages.length
      ? "This is the picture the catalogue shows for the family."
      : "Upload an image for the product itself, not only for its sizes. It is what the catalogue card and the product page before a size is chosen are drawn from.",
    tab: "media",
  });

  // Alt text is an accessibility requirement that has to hold before an image
  // can be shown to a buyer, so it gates publication rather than being a
  // warning that is never acted on. It is checked across every seller-visible
  // image, not only the family ones: a variant's photograph reaches a shopper
  // the moment that size is selected.
  const sellerImages = product.mediaAssets.filter(isActiveImage);
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

  /*
   * EXACTLY ONE, and the count is the check. Zero means the catalogue has no
   * image to lead with. Two means the answer to "which picture represents this
   * product" depends on row order, which is how the same product ends up with
   * one thumbnail in the admin list, another on the Shopify product and a third
   * in a marketing email. `setPrimaryAssignment` clears the previous holder in
   * the same transaction, so two can only arise from a write that bypassed it.
   */
  const familyPrimaries = familyImages.filter((asset) =>
    asset.assignments.some((assignment) => assignment.variantId === null && assignment.isPrimary)
  );
  checks.push({
    key: "primary_image",
    label: "Exactly one primary product image is set",
    ok: familyPrimaries.length === 1,
    detail:
      familyPrimaries.length === 0
        ? "No product image is marked primary. The primary is the thumbnail for the catalogue, the seller's storefront and the marketing fallback."
        : familyPrimaries.length > 1
          ? `More than one image is primary: ${familyPrimaries.map((a) => a.title).join(", ")}. Keep one and the rest become part of the gallery.`
          : "The image a seller sees first, before choosing a size.",
    tab: "media",
  });

  const stuck = product.mediaAssets.filter(
    (asset) =>
      isSellerFacing(asset) &&
      asset.processingStatus !== "READY" &&
      asset.processingStatus !== "FAILED"
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
    (asset) => asset.category === "DOCUMENT" && isSellerFacing(asset)
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
/**
 * The refusal, carrying the checks that caused it.
 *
 * A message string was enough while the only thing done with a refusal was to
 * print it. It is not enough now: the page has to link each failed check to the
 * tab that resolves it, and the two renderings it used to produce — a yellow
 * readiness strip from the loader and a red alert repeating the same bullets
 * from the action — showed a merchant the same list twice, in two colours, with
 * only one of them clickable. The report travels with the refusal so the page
 * can draw it once.
 */
export class PublicationRefused extends Error {
  readonly report: ReadinessReport;

  constructor(report: ReadinessReport) {
    const lines = report.blockers.map((check) => `• ${check.label} — ${check.detail}`);
    super(`This product is not ready to publish:\n${lines.join("\n")}`);
    this.name = "PublicationRefused";
    this.report = report;
  }
}

export async function assertPublishable(productId: string): Promise<void> {
  const report = await publicationReadiness(productId);
  if (report.ready) return;

  throw new PublicationRefused(report);
}
