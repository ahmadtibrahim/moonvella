import type {
  MediaCategory,
  MediaSubtype,
  DocumentType,
  ApprovalStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import type { CatalogActor } from "./products.server";
import {
  saveUpload,
  deleteObject,
  checksumOf,
  newStorageKey,
  sanitizeDisplayName,
  type StoredObject,
} from "./storage.server";
import { JOB_KIND, enqueueJob } from "./jobs.server";
import { videoProbeKey } from "./mediaProbe.server";

/**
 * Media, documents and marketing assets.
 *
 * Three ideas hold this module together.
 *
 * 1. A FILE IS STORED ONCE. A MediaAsset is the file; a MediaAssetAssignment is
 *    a claim on it, either by one variant or by the family (variantId null).
 *    Applying one photo to four variants writes four assignment rows and copies
 *    no bytes, which is why a five-size product does not cost five times the
 *    disk.
 *
 * 2. NOTHING IS VISIBLE BY ACCIDENT. Every asset starts UPLOADING/DRAFT and
 *    reaches a seller only when it is READY, APPROVED and sellerVisible. The
 *    three are independent because they answer different questions: has the
 *    file finished processing, has a person approved it, and should it be in
 *    the seller's kit at all.
 *
 * 3. HISTORY IS KEPT. Replacing a document writes a new asset that points back
 *    at the one it replaces rather than overwriting the old row, so a seller
 *    who downloaded version 1.1 last month can still be shown what they got.
 */

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export type MediaScope = "shared" | "variant";

export interface MediaAssetView {
  id: string;
  productId: string;
  category: MediaCategory;
  subtype: string | null;
  title: string;
  altText: string | null;
  originalFilename: string;
  /** Built from storageKey; the key itself never leaves the server. */
  url: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  aspectRatio: string | null;
  processingStatus: string;
  /**
   * Why processing stopped without finishing, when it stopped. Null while a
   * video is still being measured and after a measurement succeeds; the text
   * is fixed rather than a raw tool error, and it is what a failed tile shows
   * beside its Retry.
   */
  processingError: string | null;
  approvalStatus: ApprovalStatus;
  sellerVisible: boolean;
  documentType: string | null;
  version: string | null;
  effectiveDate: Date | null;
  language: string | null;
  supersedesId: string | null;
  downloadAllowed: boolean;
  instructions: string | null;
  templateUrl: string | null;
  createdAt: Date;
  /** Where this asset is attached. Empty only for a genuinely orphaned row. */
  assignments: { id: string; variantId: string | null; sortOrder: number; isPrimary: boolean }[];
  /** True when the file predates the storage pipeline and lives at a URL. */
  isLegacy: boolean;
}

const ASSET_SELECT = {
  id: true,
  productId: true,
  category: true,
  subtype: true,
  title: true,
  altText: true,
  originalFilename: true,
  storageKey: true,
  sourceUrl: true,
  mimeType: true,
  fileSize: true,
  checksum: true,
  width: true,
  height: true,
  durationSeconds: true,
  aspectRatio: true,
  processingStatus: true,
  processingError: true,
  approvalStatus: true,
  sellerVisible: true,
  documentType: true,
  version: true,
  effectiveDate: true,
  language: true,
  supersedesId: true,
  downloadAllowed: true,
  instructions: true,
  templateUrl: true,
  createdAt: true,
  assignments: {
    select: { id: true, variantId: true, sortOrder: true, isPrimary: true },
    orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }],
  },
} satisfies Prisma.MediaAssetSelect;

type AssetRow = Prisma.MediaAssetGetPayload<{ select: typeof ASSET_SELECT }>;

/**
 * URL for an asset.
 *
 * An uploaded asset is served from its own stored key. A migrated one has no
 * stored bytes — the file was never in our storage — so its original URL is
 * used instead and the interface marks it as legacy. Falling back to the key
 * would render a broken image and look like corruption rather than history.
 *
 * An editable template is a third case: it is a LINK, and its key names no
 * object at all. Handing back `/uploads/<key>` for one would be a URL that
 * 404s, so the link is returned instead — the only URL a template has ever
 * had. Nothing renders a template as an image, but a caller that did would
 * still get somewhere real.
 */
export function assetUrl(asset: {
  storageKey: string;
  sourceUrl: string | null;
  templateUrl?: string | null;
}): string {
  return (
    asset.sourceUrl?.trim() ||
    asset.templateUrl?.trim() ||
    `/uploads/${asset.storageKey}`
  );
}

function toView(asset: AssetRow): MediaAssetView {
  const { storageKey, sourceUrl, ...rest } = asset;
  return {
    ...rest,
    url: assetUrl(asset),
    isLegacy: Boolean(sourceUrl?.trim()),
  };
}

export async function listProductMedia(productId: string): Promise<MediaAssetView[]> {
  const assets = await prisma.mediaAsset.findMany({
    where: { productId },
    orderBy: [{ category: "asc" }, { createdAt: "asc" }],
    select: ASSET_SELECT,
  });
  return assets.map(toView);
}

export async function getMedia(assetId: string): Promise<MediaAssetView | null> {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId }, select: ASSET_SELECT });
  return asset ? toView(asset) : null;
}

/**
 * What a variant actually shows, in the order it should be shown.
 *
 * An asset attached to the variant itself comes first because it is the most
 * specific thing the merchant said about this variant; assets attached to the
 * family follow, because they apply to everything. An asset attached to *both*
 * is reported once, at its variant position — the alternative is the same
 * photograph appearing twice in one gallery.
 */
export function orderForVariant(
  assets: MediaAssetView[],
  variantId: string
): { asset: MediaAssetView; isOwn: boolean; isPrimary: boolean; sortOrder: number }[] {
  const rows: { asset: MediaAssetView; isOwn: boolean; isPrimary: boolean; sortOrder: number }[] = [];

  for (const asset of assets) {
    const own = asset.assignments.find((a) => a.variantId === variantId);
    const shared = asset.assignments.find((a) => a.variantId === null);
    if (!own && !shared) continue;

    const isOwn = Boolean(own);
    const chosen = own ?? shared!;
    rows.push({ asset, isOwn, isPrimary: chosen.isPrimary, sortOrder: chosen.sortOrder });
  }

  // Own before shared; within each, the merchant's order; then primary first.
  return rows.sort((a, b) => {
    if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return Number(b.isPrimary) - Number(a.isPrimary);
  });
}

/**
 * Whether any variant has an asset of its own, which is what distinguishes a
 * genuinely variant-specific gallery from one that is only inheriting.
 */
export function inheritanceSummary(assets: MediaAssetView[]): {
  shared: number;
  perVariant: Record<string, number>;
} {
  const shared = assets.filter(
    (asset) => asset.assignments.some((a) => a.variantId === null)
  ).length;
  const perVariant: Record<string, number> = {};
  for (const asset of assets) {
    for (const assignment of asset.assignments) {
      if (!assignment.variantId) continue;
      perVariant[assignment.variantId] = (perVariant[assignment.variantId] ?? 0) + 1;
    }
  }
  return { shared, perVariant };
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The bytes are already on this product.
 *
 * A refusal to store the file, but not a failure of the upload: the asset the
 * uploader wanted exists, and the useful thing to show is which one. Carried as
 * a type as well as a message so a batch caller can retire the file with a link
 * to the existing asset instead of offering a retry that would refuse again
 * every time it was pressed.
 */
export class DuplicateMediaError extends Error {
  readonly assetId: string;
  readonly existingTitle: string;

  constructor(assetId: string, existingTitle: string) {
    super(
      `This file is already on the product as "${existingTitle}". Attach the existing asset to more variants instead of uploading it again.`,
    );
    this.name = "DuplicateMediaError";
    this.assetId = assetId;
    this.existingTitle = existingTitle;
  }
}

export interface UploadMediaInput {
  category: MediaCategory;
  subtype?: string | null;
  title?: string | null;
  altText?: string | null;
  /** Which variants to attach to. Empty means the whole family. */
  variantIds?: string[];
  documentType?: string | null;
  version?: string | null;
  effectiveDate?: string | null;
  language?: string | null;
  downloadAllowed?: boolean;
  instructions?: string | null;
  templateUrl?: string | null;
}

/**
 * What the batch uploader is told about one file.
 *
 * A refusal is an ANSWER, not an error status. The uploader is a raw XHR: a
 * non-2xx lands in its error path, where the body is often unreadable, and
 * "this file is already on the product" would reach the operator as "upload
 * failed" — the one message that makes them retry a file that can never
 * succeed. So every outcome, including every refusal, travels as a result.
 *
 * `duplicate` is its own outcome rather than a failure because the two need
 * different treatment: a failed card is kept and offered for retry, a duplicate
 * is kept and never offered, because retrying it could only refuse again.
 */
export type BatchUploadOutcome =
  | { ok: true; assetId: string; title: string }
  | { ok: false; duplicate: true; assetId: string; title: string; error: string }
  | { ok: false; duplicate?: false; error: string };

/**
 * One file from the batch uploader.
 *
 * SHARED BY BOTH DOORS. The editor's action handles `media_upload_batch` for a
 * form post, and the resource route serves the uploader's own XHR; both call
 * this, so the two cannot drift into refusing different things. It lived in the
 * action first, and the uploader could not be answered with JSON from there —
 * see the note on the resource route for why that is a property of the router
 * and not of this code.
 *
 * The category is required rather than defaulted. It used to fall back to
 * `PRODUCT_IMAGE`, which is not a value the enum has, so a request that omitted
 * it was refused with "Unknown media category" — a message about the category
 * when the real problem was that none arrived.
 */
export async function uploadMediaBatch(
  productId: string,
  form: FormData,
  actor: CatalogActor
): Promise<BatchUploadOutcome> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No file arrived with this request. Choose it again." };
  }

  const optional = (name: string) => {
    const value = String(form.get(name) ?? "").trim();
    return value === "" ? null : value;
  };
  const category = optional("category");
  if (!category) return { ok: false, error: "Choose a category for this file." };

  try {
    const asset = await uploadMedia(
      productId,
      file,
      {
        category: category as MediaCategory,
        subtype: optional("subtype"),
        title: optional("title"),
        altText: optional("altText"),
        variantIds: form.getAll("scopeVariantIds").map(String).filter(Boolean),
        documentType: optional("documentType"),
        version: optional("version"),
        effectiveDate: optional("effectiveDate"),
        language: optional("language"),
        downloadAllowed: form.get("downloadAllowed") !== "false",
        instructions: optional("instructions"),
        templateUrl: optional("templateUrl"),
      },
      actor
    );
    return { ok: true, assetId: asset.id, title: asset.title };
  } catch (error) {
    if (error instanceof DuplicateMediaError) {
      // The asset it duplicates is named, so the uploader can offer to open it
      // instead of leaving the operator to guess what they already have.
      return {
        ok: false,
        duplicate: true,
        assetId: error.assetId,
        title: error.existingTitle,
        error: error.message,
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "That file could not be stored.",
    };
  }
}

/**
 * Upload a file and attach it.
 *
 * The bytes are stored first and the row written second, so a row never points
 * at an object that does not exist. The reverse failure — an object with no row
 * — is possible if the insert fails, and is the one worth having: it is
 * invisible, harmless, and reclaimable, whereas a row with no object is a
 * broken image in a seller's catalogue. Reclaimable is not the same as
 * reclaimed, though, so the write below removes the object it just stored if
 * the row cannot be written. Nothing points at those bytes either way, and
 * leaving them would mean the only record of a rejected upload is a file on
 * disk that no screen will ever show anyone.
 *
 * The category and document type are checked here, before anything is written.
 * `updateMedia` has always done this; the upload path did not, so a value that
 * is not on the enum travelled all the way to the database and came back as a
 * raw driver error — after the file had been stored.
 */
export async function uploadMedia(
  productId: string,
  file: File,
  input: UploadMediaInput,
  actor: CatalogActor
): Promise<MediaAssetView> {
  if (!MEDIA_CATEGORIES.includes(input.category)) throw new Error("Unknown media category.");
  const subtype = normalizeSubtype(input.category, input.subtype);
  const documentType = normalizeDocumentType(input.documentType);

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, variants: { select: { id: true } } },
  });
  if (!product) throw new Error("Product not found.");

  const variantIds = await resolveVariantIds(product.variants.map((v) => v.id), input.variantIds);

  const stored = await saveUpload(file);

  // Duplicate detection. The same bytes uploaded twice is nearly always a
  // double-submit rather than two deliberate copies, so it is refused with the
  // name of the asset it matches rather than silently stored again.
  const duplicate = await prisma.mediaAsset.findFirst({
    where: { productId, checksum: stored.checksum },
    select: { id: true, title: true },
  });
  if (duplicate) {
    await deleteObject(stored.key);
    /*
     * TYPED, NOT JUST A MESSAGE. A batch uploader sends many files and has to
     * tell one outcome from another to decide what to keep on screen: a
     * duplicate is a file that IS on the product (so the card can be retired
     * with a link to it), while a rejection is a file that is not (so the card
     * stays and offers a retry). Reading that off a message string would break
     * the moment the sentence was reworded, and the reworded version would look
     * like a failure to retry forever.
     */
    throw new DuplicateMediaError(duplicate.id, duplicate.title);
  }

  let asset: string;
  try {
    asset = await prisma.$transaction(async (tx) => {
      const created = await tx.mediaAsset.create({
        data: {
          productId,
          category: input.category,
          subtype,
          title: (input.title || "").trim() || stored.originalFilename,
          altText: (input.altText || "").trim() || null,
          originalFilename: stored.originalFilename,
          storageKey: stored.key,
          mimeType: stored.mimeType,
          fileSize: stored.size,
          checksum: stored.checksum,
          width: stored.width,
          height: stored.height,
          durationSeconds: stored.durationSeconds,
          aspectRatio: aspectRatioOf(stored.width, stored.height),
          // A video whose length could not be measured stays PROCESSING rather
          // than being called READY on the strength of an assumption.
          processingStatus:
            stored.kind === "video" && stored.durationSeconds === null ? "PROCESSING" : "READY",
          approvalStatus: "DRAFT",
          sellerVisible: false,
          documentType,
          version: (input.version || "").trim() || null,
          effectiveDate: parseDate(input.effectiveDate),
          language: (input.language || "").trim() || null,
          downloadAllowed: input.downloadAllowed ?? true,
          instructions: (input.instructions || "").trim() || null,
          templateUrl: validateTemplateUrl(input.templateUrl),
          createdById: actor.actorId,
        },
        select: { id: true },
      });

      await attach(tx, created.id, productId, variantIds);
      return created.id;
    });
  } catch (error) {
    // The row was not written, so nothing references the bytes just stored.
    // They are removed rather than left on disk for nobody to see. The delete
    // is best-effort: whether it succeeds or not, the original error is the
    // one the uploader needs to see.
    await deleteObject(stored.key).catch(() => undefined);
    throw error;
  }

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.uploaded",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: asset,
    afterData: {
      productId,
      category: input.category,
      mimeType: stored.mimeType,
      fileSize: stored.size,
      variants: variantIds.length,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  /*
   * A video that the upload path could not measure goes on the queue, because
   * "PROCESSING" is a promise that something is still working on it. The
   * enqueue is best-effort on purpose: the bytes are stored and the row is
   * written, and failing the whole upload because the queue was unreachable
   * would lose work over a step the five-minute sweep repeats anyway.
   */
  if (stored.kind === "video" && stored.durationSeconds === null) {
    await enqueueJob({
      kind: JOB_KIND.MEDIA_VIDEO_PROBE,
      idempotencyKey: videoProbeKey(asset),
      payload: { assetId: asset, upload: true },
    }).catch(() => undefined);
  }

  const view = await getMedia(asset);
  if (!view) throw new Error("The upload could not be read back.");
  return view;
}

/** What a template needs: a title, and the link the seller will open. */
export interface CreateTemplateInput {
  title: string;
  templateUrl: string;
  instructions?: string | null;
  variantIds?: string[] | null;
  sellerVisible?: boolean;
}

/**
 * Create an editable-template asset.
 *
 * A template is a link to a design file — a Canva board, a Figma page — and
 * there is nothing to upload. Until now the only way to get one was to upload
 * some file first and then paste a link into the row, which is why the
 * template section of the marketing tab was effectively unreachable. This
 * writes the row without pretending a file exists behind it: READY, because
 * there is nothing to process, and no bytes anywhere.
 *
 * The row still gets a storage key, because the column is unique and not
 * nullable, and the key is a real random key of the usual shape that names no
 * object — the uploads route answers 404 for it, which is the truthful answer
 * to "give me the file under this key". The checksum is taken over the link
 * itself, so the same template pasted twice is caught by the same duplicate
 * rule as a file uploaded twice.
 */
export async function createTemplateAsset(
  productId: string,
  input: CreateTemplateInput,
  actor: CatalogActor
): Promise<MediaAssetView> {
  const title = (input.title || "").trim();
  if (!title) throw new Error("A template needs a title.");

  const templateUrl = validateTemplateUrl(input.templateUrl);
  if (!templateUrl) throw new Error("An editable template needs the link the seller will open.");

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, variants: { select: { id: true } } },
  });
  if (!product) throw new Error("Product not found.");

  const variantIds = await resolveVariantIds(product.variants.map((v) => v.id), input.variantIds ?? []);

  const parsed = new URL(templateUrl);
  const host = parsed.hostname.replace(/^www\./, "");
  const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();

  const duplicate = await prisma.mediaAsset.findFirst({
    where: { productId, mimeType: TEMPLATE_MIME, checksum: checksumOf(Buffer.from(templateUrl)) },
    select: { id: true, title: true },
  });
  if (duplicate) throw new DuplicateMediaError(duplicate.id, duplicate.title);

  const asset = await prisma.$transaction(async (tx) => {
    const created = await tx.mediaAsset.create({
      data: {
        productId,
        category: "EDITABLE_TEMPLATE",
        subtype: "EDITABLE_TEMPLATE",
        title,
        altText: null,
        originalFilename: sanitizeDisplayName(lastSegment ? `${host}-${lastSegment}` : host),
        storageKey: newStorageKey(),
        mimeType: TEMPLATE_MIME,
        // No bytes, so no size. Zero is the honest number for "nothing was
        // uploaded", and every screen that shows a size says "link" instead.
        fileSize: 0,
        checksum: checksumOf(Buffer.from(templateUrl)),
        processingStatus: "READY",
        approvalStatus: "DRAFT",
        sellerVisible: input.sellerVisible ?? false,
        instructions: (input.instructions || "").trim() || null,
        templateUrl,
        createdById: actor.actorId,
      },
      select: { id: true },
    });

    await attach(tx, created.id, productId, variantIds);
    return created.id;
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.template_created",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: asset,
    // The link is a URL the owner put on a seller's screen, not a credential,
    // and it is the only thing that distinguishes one template row from
    // another in the audit trail.
    afterData: { productId, templateUrl, variants: variantIds.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const view = await getMedia(asset);
  if (!view) throw new Error("The template could not be read back.");
  return view;
}

/**
 * Apply an asset that already exists to more variants.
 *
 * This is the operation the directive calls out by name: the same file for
 * several variants must not become several files. Nothing is copied here — only
 * assignment rows are written.
 */
export async function attachMediaToVariants(
  assetId: string,
  variantIds: string[],
  actor: CatalogActor
): Promise<MediaAssetView> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { id: true, productId: true },
  });
  if (!asset) throw new Error("Asset not found.");

  const product = await prisma.product.findUnique({
    where: { id: asset.productId },
    select: { variants: { select: { id: true } } },
  });
  const resolved = await resolveVariantIds(
    (product?.variants ?? []).map((v) => v.id),
    variantIds
  );

  await prisma.$transaction(async (tx) => {
    await attach(tx, assetId, asset.productId, resolved);
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.attached",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assetId,
    afterData: { productId: asset.productId, variants: resolved.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const view = await getMedia(assetId);
  if (!view) throw new Error("The asset could not be read back.");
  return view;
}

/**
 * Every variant id must belong to this product. A variant from another family
 * would attach an asset to a product it is not part of, which is a
 * cross-tenant leak waiting to happen, so it is refused rather than skipped.
 */
async function resolveVariantIds(
  productVariantIds: string[],
  requested: string[] | undefined
): Promise<string[]> {
  const wanted = [...new Set((requested ?? []).map((id) => String(id).trim()).filter(Boolean))];
  const known = new Set(productVariantIds);
  for (const id of wanted) {
    if (!known.has(id)) throw new Error("A selected variant does not belong to this product.");
  }
  return wanted;
}

/**
 * Write the assignment rows for one asset.
 *
 * An empty variant list means the family, which is a single shared row. Ordering
 * continues from whatever the target scope already holds so a newly attached
 * asset lands at the end of the gallery rather than on top of it.
 */
async function attach(
  tx: Prisma.TransactionClient,
  assetId: string,
  productId: string,
  variantIds: string[]
): Promise<void> {
  const scopes: (string | null)[] = variantIds.length ? variantIds : [null];

  for (const variantId of scopes) {
    // findFirst, not findUnique on the compound key: the family scope is
    // `variantId: null`, and Prisma refuses to look up a compound unique with a
    // null in it — it raises rather than returning no row. A `as string` cast
    // would silence the compiler while leaving the null in place, which is how
    // this shipped. `findFirst` treats the null as SQL `IS NULL`, which is what
    // "is this asset already attached to the family?" actually means.
    const existing = await tx.mediaAssetAssignment.findFirst({
      where: { assetId, variantId },
      select: { id: true },
    });
    if (existing) continue;

    const highest = await tx.mediaAssetAssignment.aggregate({
      where: {
        variantId,
        asset: { productId },
      },
      _max: { sortOrder: true },
    });
    const nextOrder = (highest._max.sortOrder ?? -1) + 1;

    // The first asset in a scope becomes its primary. Otherwise a product with
    // media would have none, and every consumer would need a fallback.
    const isFirst = nextOrder === 0;

    await tx.mediaAssetAssignment.create({
      data: { assetId, variantId, sortOrder: nextOrder, isPrimary: isFirst },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                       */
/* -------------------------------------------------------------------------- */

export interface UpdateMediaInput {
  title?: string;
  altText?: string | null;
  category?: MediaCategory;
  subtype?: string | null;
  sellerVisible?: boolean;
  documentType?: string | null;
  version?: string | null;
  effectiveDate?: string | null;
  language?: string | null;
  downloadAllowed?: boolean;
  instructions?: string | null;
  templateUrl?: string | null;
}

/**
 * The type recorded for an editable template.
 *
 * A template is a link, not a file, so there is no media type to record — but
 * the column is not nullable and "application/pdf" or "image/*" would be a
 * lie that a screen might act on. `text/uri-list` is the registered type for a
 * list of URIs, which is exactly what the row holds, and it is deliberately
 * not an image or a video so nothing can mistake it for one.
 */
const TEMPLATE_MIME = "text/uri-list";

const MEDIA_CATEGORIES: MediaCategory[] = [
  "WHITE_BACKGROUND_IMAGE",
  "LIFESTYLE_IMAGE",
  "PRODUCT_VIDEO",
  "DOCUMENT",
  "MARKETING_CREATIVE",
  "EDITABLE_TEMPLATE",
];

/**
 * The subtypes that belong to each category — the whole enum, partitioned.
 *
 * The Media tab has carried this same table for as long as it has offered the
 * choice, but only in the browser. A form field is not a boundary: the value
 * arrives here from whatever posted it, and until it is checked against the
 * category it was sent with, the two can disagree and the disagreement is
 * written down. This is the copy that decides.
 */
const SUBTYPES_BY_CATEGORY: Record<MediaCategory, readonly string[]> = {
  WHITE_BACKGROUND_IMAGE: ["WHITE_BACKGROUND"],
  LIFESTYLE_IMAGE: ["LIFESTYLE"],
  PRODUCT_VIDEO: ["PRODUCT_DEMO", "LIFESTYLE_VIDEO", "SOCIAL_CLIP_VERTICAL", "SOCIAL_CLIP_SQUARE"],
  DOCUMENT: [
    "CARE_GUIDE",
    "SPECIFICATION_SHEET",
    "WARRANTY",
    "CERTIFICATION",
    "PACKAGING_INSTRUCTIONS",
    "MARKETING_PDF",
    "OTHER_DOCUMENT",
  ],
  MARKETING_CREATIVE: ["SQUARE_POST", "STORY_REEL", "BANNER", "LANDSCAPE_AD", "SOCIAL_VIDEO"],
  EDITABLE_TEMPLATE: ["EDITABLE_TEMPLATE"],
};

/**
 * The document kinds a DOCUMENT asset may carry.
 *
 * A blank value is not an error: a file may be uploaded before anyone has
 * decided what to call it, and the Documents tab is where that gets settled.
 * Anything else has to name a real kind, because the value goes to a database
 * enum that will reject it — and by then the file is already stored.
 *
 * `MediaSubtype` and `DocumentType` share seven near-identical names and
 * disagree about one of them — a document's "other" is OTHER here and
 * OTHER_DOCUMENT there — so a caller can be forgiven for sending the wrong
 * one. It cannot be forgiven silently, which is what this catches.
 */
const DOCUMENT_TYPES = [
  "CARE_GUIDE",
  "SPECIFICATION_SHEET",
  "WARRANTY",
  "CERTIFICATION",
  "PACKAGING_INSTRUCTIONS",
  "MARKETING_PDF",
  "OTHER",
] as const;

function normalizeDocumentType(value: string | null | undefined): DocumentType | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (!(DOCUMENT_TYPES as readonly string[]).includes(trimmed)) {
    throw new Error(
      "Unknown document type. A document is a care guide, a specification sheet, a warranty, a certification, packaging instructions, a marketing PDF, or other."
    );
  }
  // Checked against the list above, which is the enum spelled out. The cast
  // records that, rather than pretending the check happened elsewhere.
  return trimmed as DocumentType;
}

function normalizeSubtype(
  category: MediaCategory,
  value: string | null | undefined
): MediaSubtype | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (!SUBTYPES_BY_CATEGORY[category].includes(trimmed)) {
    throw new Error("That subtype does not belong to the media category it was sent with.");
  }
  return trimmed as MediaSubtype;
}

export async function updateMedia(
  assetId: string,
  input: UpdateMediaInput,
  actor: CatalogActor
): Promise<MediaAssetView> {
  const before = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
  if (!before) throw new Error("Asset not found.");

  const category = input.category ?? before.category;
  if (!MEDIA_CATEGORIES.includes(category)) throw new Error("Unknown media category.");

  // A subtype already on the row was checked when it was written; one arriving
  // with this edit is checked against the category the row will end up with,
  // which is the category it was sent with when that is part of the edit.
  const subtype =
    input.subtype === undefined ? before.subtype : normalizeSubtype(category, input.subtype);
  const documentType =
    input.documentType === undefined
      ? before.documentType
      : normalizeDocumentType(input.documentType);

  const asset = await prisma.mediaAsset.update({
    where: { id: assetId },
    data: {
      title: input.title === undefined ? before.title : String(input.title).trim() || before.title,
      altText:
        input.altText === undefined ? before.altText : String(input.altText ?? "").trim() || null,
      category,
      subtype,
      sellerVisible: input.sellerVisible ?? before.sellerVisible,
      documentType,
      version: input.version === undefined ? before.version : String(input.version ?? "").trim() || null,
      effectiveDate: input.effectiveDate === undefined ? before.effectiveDate : parseDate(input.effectiveDate),
      language:
        input.language === undefined ? before.language : String(input.language ?? "").trim() || null,
      downloadAllowed: input.downloadAllowed ?? before.downloadAllowed,
      instructions:
        input.instructions === undefined
          ? before.instructions
          : String(input.instructions ?? "").trim() || null,
      templateUrl:
        input.templateUrl === undefined ? before.templateUrl : validateTemplateUrl(input.templateUrl),
    },
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.updated",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assetId,
    beforeData: {
      title: before.title,
      category: before.category,
      approvalStatus: before.approvalStatus,
      sellerVisible: before.sellerVisible,
    },
    afterData: {
      title: asset.title,
      category: asset.category,
      approvalStatus: asset.approvalStatus,
      sellerVisible: asset.sellerVisible,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const view = await getMedia(assetId);
  if (!view) throw new Error("The asset could not be read back.");
  return view;
}

/**
 * Approve or reject an asset.
 *
 * Approval is what lets an asset reach a seller, so it is recorded with its own
 * audit action rather than folded into an edit — "who approved this, and when"
 * is a question that gets asked after something wrong has been published.
 */
export async function setMediaApproval(
  assetId: string,
  approval: ApprovalStatus,
  actor: CatalogActor
): Promise<MediaAssetView> {
  const before = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { id: true, approvalStatus: true, sellerVisible: true, processingStatus: true },
  });
  if (!before) throw new Error("Asset not found.");

  // A file that never finished processing has not been looked at, so it cannot
  // be approved. Rejecting it is allowed: that is how a broken upload is closed.
  if (approval === "APPROVED" && before.processingStatus !== "READY") {
    throw new Error("This asset has not finished processing and cannot be approved yet.");
  }

  const asset = await prisma.mediaAsset.update({
    where: { id: assetId },
    data: {
      approvalStatus: approval,
      // Rejecting withdraws it from sellers in the same stroke. Leaving it
      // visible would make "rejected" mean nothing.
      sellerVisible: approval === "APPROVED" ? before.sellerVisible : false,
    },
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: `media.${approval.toLowerCase()}`,
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assetId,
    beforeData: { approvalStatus: before.approvalStatus, sellerVisible: before.sellerVisible },
    afterData: { approvalStatus: asset.approvalStatus, sellerVisible: asset.sellerVisible },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const view = await getMedia(assetId);
  if (!view) throw new Error("The asset could not be read back.");
  return view;
}

/**
 * Delete an asset and its stored object.
 *
 * Refused while it is approved and seller-visible on a published product:
 * deleting there would pull an image out of a live catalogue with no warning.
 * Withdraw it first, which is a decision someone makes on purpose.
 */
export async function deleteMedia(
  assetId: string,
  actor: CatalogActor
): Promise<{ deleted: boolean; objectRemoved: boolean }> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      title: true,
      storageKey: true,
      sourceUrl: true,
      approvalStatus: true,
      sellerVisible: true,
      product: { select: { status: true, name: true } },
    },
  });
  if (!asset) throw new Error("Asset not found.");

  if (asset.approvalStatus === "APPROVED" && asset.sellerVisible && asset.product.status === "PUBLISHED") {
    throw new Error(
      `"${asset.title}" is approved and visible on the published product "${asset.product.name}". Unpublish or withdraw it before deleting.`
    );
  }

  await prisma.mediaAsset.delete({ where: { id: assetId } });

  // The row is gone either way; the object is removed only when we own it. A
  // migrated asset's bytes were never in our storage, so there is nothing here
  // to delete — and deleting the key would be deleting someone else's file.
  let objectRemoved = false;
  if (!asset.sourceUrl?.trim()) {
    objectRemoved = await deleteObject(asset.storageKey);
  }

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.deleted",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assetId,
    beforeData: { title: asset.title, objectRemoved },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { deleted: true, objectRemoved };
}

export async function detachMedia(
  assignmentId: string,
  actor: CatalogActor
): Promise<{ detached: boolean }> {
  const assignment = await prisma.mediaAssetAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, assetId: true, variantId: true, isPrimary: true },
  });
  if (!assignment) throw new Error("Attachment not found.");

  await prisma.$transaction(async (tx) => {
    await tx.mediaAssetAssignment.delete({ where: { id: assignmentId } });
    // Removing the primary would leave the scope without one, so the next
    // asset in line is promoted rather than leaving a gallery with no lead.
    if (assignment.isPrimary) {
      const next = await tx.mediaAssetAssignment.findFirst({
        where: { variantId: assignment.variantId },
        orderBy: { sortOrder: "asc" },
        select: { id: true },
      });
      if (next) {
        await tx.mediaAssetAssignment.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.detached",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assignment.assetId,
    beforeData: { assignmentId, variantId: assignment.variantId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { detached: true };
}

/**
 * Make an assignment the primary for its scope.
 *
 * Clears the previous holder in the same transaction. For a variant scope the
 * database's partial unique index would reject a second primary anyway; for the
 * shared scope nothing does, so this is the only thing keeping the invariant.
 */
export async function setPrimaryAssignment(
  assignmentId: string,
  actor: CatalogActor
): Promise<{ ok: true }> {
  const assignment = await prisma.mediaAssetAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, assetId: true, variantId: true },
  });
  if (!assignment) throw new Error("Attachment not found.");

  await prisma.$transaction(async (tx) => {
    await tx.mediaAssetAssignment.updateMany({
      where: { variantId: assignment.variantId, isPrimary: true, id: { not: assignmentId } },
      data: { isPrimary: false },
    });
    await tx.mediaAssetAssignment.update({ where: { id: assignmentId }, data: { isPrimary: true } });
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.primary_set",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assignment.assetId,
    afterData: { assignmentId, variantId: assignment.variantId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { ok: true };
}

/**
 * Move an assignment within its scope.
 *
 * Rewrites the whole scope's order rather than swapping two rows, because a
 * swap would also swap primacy and quietly change which image a seller sees
 * first.
 */
export async function reorderAssignment(
  assignmentId: string,
  direction: "up" | "down",
  actor: CatalogActor
): Promise<{ ok: true }> {
  const assignment = await prisma.mediaAssetAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, variantId: true, assetId: true },
  });
  if (!assignment) throw new Error("Attachment not found.");

  await prisma.$transaction(async (tx) => {
    const siblings = await tx.mediaAssetAssignment.findMany({
      where: { variantId: assignment.variantId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const index = siblings.findIndex((row) => row.id === assignmentId);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= siblings.length) return;

    const reordered = [...siblings];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    for (let position = 0; position < reordered.length; position += 1) {
      await tx.mediaAssetAssignment.update({
        where: { id: reordered[position].id },
        data: { sortOrder: position },
      });
    }
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.reordered",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: assignment.assetId,
    afterData: { assignmentId, direction },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Documents — versioning                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Replace a document with a new version.
 *
 * The old row is left exactly as it was and the new one points at it, so the
 * previous version stays downloadable and traceable. Overwriting the old row
 * would destroy the record of what a seller was given last month, which is the
 * thing a version number exists to preserve.
 */
export async function supersedeDocument(
  previousAssetId: string,
  file: File,
  input: UploadMediaInput,
  actor: CatalogActor
): Promise<MediaAssetView> {
  const previous = await prisma.mediaAsset.findUnique({
    where: { id: previousAssetId },
    select: {
      id: true,
      productId: true,
      category: true,
      documentType: true,
      language: true,
      version: true,
      assignments: { select: { variantId: true } },
    },
  });
  if (!previous) throw new Error("The document being replaced was not found.");
  if (previous.category !== "DOCUMENT") {
    throw new Error("Only documents are versioned.");
  }
  if (input.version && previous.version && input.version === previous.version) {
    throw new Error(`Version ${input.version} already exists. Give the new file a new version.`);
  }

  /*
   * Where a document applies is part of what it is, so the replacement inherits
   * the scope of the version it replaces rather than taking it from the caller.
   * A form that had to restate "and the same four variants, please" would be a
   * chance to get it wrong, and the failure — a warranty that applies to one
   * size instead of all of them — is silent.
   */
  const scopeVariants = previous.assignments
    .map((assignment) => assignment.variantId)
    .filter((id): id is string => Boolean(id));
  const wasShared = previous.assignments.some((assignment) => assignment.variantId === null);

  const replacement = await uploadMedia(
    previous.productId,
    file,
    {
      ...input,
      category: "DOCUMENT",
      documentType: input.documentType ?? previous.documentType,
      language: input.language ?? previous.language,
      variantIds: scopeVariants,
    },
    actor
  );

  // A document can apply to the whole product *and* to particular variants. The
  // upload attaches one or the other, so the shared row is added back here when
  // the version being replaced had both.
  if (wasShared && scopeVariants.length) {
    await prisma.$transaction(async (tx) => {
      await attach(tx, replacement.id, previous.productId, []);
    });
  }

  await prisma.mediaAsset.update({
    where: { id: replacement.id },
    data: { supersedesId: previous.id },
  });

  /*
   * Withdraw the old version from sellers as part of replacing it.
   *
   * A superseded document is history, and history must not be handed out as if
   * it were current — a seller packaging a product with last year's warranty is
   * a worse failure than a missing file, because nothing looks wrong. Doing it
   * here rather than filtering superseded rows out of the marketing pack keeps
   * the pack's rule a simple allowlist of visible records, and makes the state
   * something the merchant can see and reverse on the Documents tab rather than
   * a hidden consequence of an id column.
   */
  await prisma.mediaAsset.update({
    where: { id: previous.id },
    data: { sellerVisible: false },
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "media.document_superseded",
    entityType: AUDIT_ENTITY.MEDIA,
    entityId: replacement.id,
    beforeData: { supersededId: previous.id, version: previous.version },
    afterData: { version: replacement.version, previousSellerVisible: false },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  const view = await getMedia(replacement.id);
  if (!view) throw new Error("The new version could not be read back.");
  return view;
}

/** Version history for an asset, newest first, following supersedesId links. */
export async function documentHistory(assetId: string): Promise<MediaAssetView[]> {
  const chain: MediaAssetView[] = [];
  const seen = new Set<string>();

  let cursor: string | null = assetId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const view = await getMedia(cursor);
    if (!view) break;
    chain.push(view);
    cursor = view.supersedesId;
  }

  // Walk forward too: the caller may have asked about an older version.
  const successors = await prisma.mediaAsset.findMany({
    where: { supersedesId: assetId },
    select: { id: true },
  });
  for (const successor of successors) {
    if (seen.has(successor.id)) continue;
    chain.push(...(await documentHistory(successor.id)));
  }

  return chain;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function aspectRatioOf(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dates arrive as `YYYY-MM-DD` from a date input, which `new Date()` reads as
 * midnight UTC. Parsing it here rather than letting the column coerce a string
 * keeps an unparseable value an error instead of an Invalid Date.
 */
function parseDate(value: string | null | undefined): Date | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!ISO_DATE.test(raw)) throw new Error("Dates must be given as YYYY-MM-DD.");
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error("That date could not be read.");
  return parsed;
}

/**
 * Editable templates are links, so the only safe scheme is https. Anything else
 * — javascript:, data:, a bare path — is refused rather than stored and later
 * rendered into a page.
 */
function validateTemplateUrl(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The template link must be a full URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("The template link must use https.");
  }
  return parsed.toString();
}

/** Re-exported so a caller can store a StoredObject without importing storage. */
export type { StoredObject };
