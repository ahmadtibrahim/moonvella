import type { ShopifyTransferKind, ShopifyTransferStatus } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { readObject, sanitizeDisplayName } from "./storage.server";

/**
 * Sending one MoonVella file into a seller's own Shopify store, and remembering
 * that it happened.
 *
 * WHY A STAGED UPLOAD RATHER THAN A URL. Shopify fetches an image by URL, which
 * is why the product import can hand it a `sourceUrl`. That is the only thing it
 * can do for a video: hosted product video must arrive as bytes through a staged
 * upload — an external URL is accepted by the API and then never becomes
 * playable. This deployment binds to 127.0.0.1 and has no public origin, so
 * pointing Shopify at our own `/uploads/...` would be a link only we can open.
 * Staging the bytes is therefore not an optimisation, it is the only path that
 * works for every file a seller may take.
 *
 * ONE ROW PER ASSET PER SELLER PER KIND. `ShopifyFileTransfer` is unique on
 * (seller, asset, kind), so a second press cannot create a second copy in the
 * merchant's store. That is the whole dedupe mechanism: we do not look for the
 * file, we remember putting it there. The row is *verified* before it is
 * believed, though — a seller may delete the image from their storefront, and a
 * row that says SUCCEEDED about a file that is gone would lock them out of ever
 * restoring it.
 */

export type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

/**
 * The network seam for the byte upload.
 *
 * The GraphQL calls come through the authenticated admin client the session
 * already holds, but the staged upload is a plain HTTP POST to a storage bucket
 * that knows nothing about Shopify sessions — and it is the one call in this
 * file a test cannot fake with a GraphQL stub. Injected for exactly that reason.
 */
export type TransferFetch = (url: string, init: RequestInit) => Promise<Response>;

export type MediaContentType = "IMAGE" | "VIDEO";
export type StagedResource = "IMAGE" | "VIDEO" | "FILE";

export const PRODUCT_MEDIA_ADD = `#graphql
  mutation MoonVellaProductMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productUpdate(product: { id: $productId }, media: $media) {
      product { id }
      userErrors { field message }
    }
  }`;

const PRODUCT_MEDIA_IDS = `#graphql
  query MoonVellaProductMediaIds($id: ID!) {
    product(id: $id) { media(first: 250) { nodes { id } } }
  }`;

const STAGED_UPLOADS_CREATE = `#graphql
  mutation MoonVellaStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

/**
 * `filename` IS DELIBERATELY ABSENT.
 *
 * For a staged upload the name was already given to `stagedUploadsCreate`, and
 * passing it again here is the documented way to make `fileCreate` fail. The
 * only thing this call needs to identify the bytes is the `resourceUrl` the
 * staging step returned.
 *
 * `RAISE_ERROR` ON DUPLICATES. Shopify's default appends a UUID and quietly
 * creates a second copy of a file the store already has. A duplicate here is a
 * second MoonVella document in the seller's Files with the same name and no way
 * to tell them apart, so a collision is surfaced as a failure the seller can
 * read instead.
 */
const FILE_CREATE = `#graphql
  mutation MoonVellaFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message }
    }
  }`;

const FILE_STATUS = `#graphql
  query MoonVellaFileStatus($id: ID!) {
    node(id: $id) {
      ... on GenericFile { id fileStatus }
      ... on MediaImage { id fileStatus }
      ... on Video { id fileStatus }
    }
  }`;

export function joinUserErrors(
  errors: { field?: unknown; message: string }[] | undefined,
  fallback: string
): string {
  const message = (errors ?? [])
    .map((error) => {
      const field = Array.isArray(error.field) ? error.field.join(".") : error.field;
      return field ? `${String(field)}: ${error.message}` : error.message;
    })
    .filter(Boolean)
    .join("; ");
  return message || fallback;
}

/**
 * Which kind of product media a mime type is, or null when it is neither.
 *
 * Null is the important half: a PDF must not be sent as product media. Shopify
 * would accept it as far as the mutation and then the listing would carry a file
 * shoppers cannot see, which reads as a broken product rather than a wrong
 * button.
 */
export function mediaContentTypeFor(mimeType: string): MediaContentType | null {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "IMAGE";
  if (normalized.startsWith("video/")) return "VIDEO";
  return null;
}

/** The `resource` a staged upload is created for. */
export function stagedResourceFor(
  kind: ShopifyTransferKind,
  mimeType: string
): StagedResource | null {
  if (kind === "FILE") return "FILE";
  return mediaContentTypeFor(mimeType);
}

function isAbsoluteUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** The extension a stored type is known by. Nothing is guessed from a name. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

/**
 * A filename Shopify will accept.
 *
 * The uploader's own name is used where there is one, because that is what the
 * merchant will recognise in their Files list. It is sanitized rather than
 * trusted: it is a string a browser chose, and it becomes a store-side display
 * name.
 *
 * AN EXTENSION IS ADDED WHEN THERE IS NONE, from the type we measured rather
 * than from anything the uploader claimed. `sanitizeDisplayName` answers
 * "upload" for a name it had to reject entirely, and a file called plain
 * "upload" arrives in the merchant's Files as something their machine cannot
 * open — a document with no extension is not a document to most desktops. It is
 * only added when there is no extension already, so a real name is never
 * rewritten into a different one.
 */
export function transferFilename(asset: {
  originalFilename?: string | null;
  title?: string | null;
  mimeType?: string | null;
}): string {
  const candidate = sanitizeDisplayName(asset.originalFilename ?? asset.title ?? "");
  if (/\.[a-z0-9]{2,5}$/i.test(candidate)) return candidate;
  const extension = EXTENSIONS[asset.mimeType?.trim().toLowerCase() ?? ""];
  return extension ? `${candidate}.${extension}` : candidate;
}

export interface StagedUploadTarget {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

/**
 * Create a staged target and put the bytes in it. Returns what Shopify will read
 * the file back from.
 *
 * THE PARAMETERS ARE FORM FIELDS AND THEY COME FIRST. They carry the storage
 * signature; the file part has to follow them. Sending the file first is a
 * documented way to get "Cannot create buckets using a POST" — a message that
 * says nothing about the real mistake, which is why the order is asserted in the
 * verification suite rather than left to the platform's default ordering.
 */
export async function stageAndUpload(input: {
  admin: AdminGraphql;
  filename: string;
  mimeType: string;
  resource: StagedResource;
  bytes: Uint8Array;
  fetchImpl?: TransferFetch;
}): Promise<{ ok: true; resourceUrl: string; target: StagedUploadTarget } | { ok: false; error: string }> {
  const doFetch: TransferFetch = input.fetchImpl ?? ((url, init) => fetch(url, init));

  let target: StagedUploadTarget;
  try {
    const res = await input.admin.graphql(STAGED_UPLOADS_CREATE, {
      variables: {
        input: [
          {
            resource: input.resource,
            filename: input.filename,
            mimeType: input.mimeType,
            // Required for VIDEO. Sent for every resource: it is optional
            // elsewhere and a size the store can trust is never wrong.
            fileSize: String(input.bytes.byteLength),
            httpMethod: "POST",
          },
        ],
      },
    });
    const json = await res.json();
    const errors = json?.data?.stagedUploadsCreate?.userErrors ?? [];
    if (errors.length) {
      return { ok: false, error: joinUserErrors(errors, "the store refused to accept the file") };
    }
    const staged = json?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!staged?.url || !staged?.resourceUrl) {
      return {
        ok: false,
        error: "the store did not return an address to upload the file to",
      };
    }
    target = {
      url: staged.url,
      resourceUrl: staged.resourceUrl,
      parameters: staged.parameters ?? [],
    };
  } catch (error) {
    return {
      ok: false,
      error: `could not reach the store to stage the file: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  try {
    const form = new FormData();
    for (const parameter of target.parameters) {
      form.append(parameter.name, parameter.value);
    }
    form.append(
      "file",
      new Blob([input.bytes as BlobPart], { type: input.mimeType }),
      input.filename
    );

    const res = await doFetch(target.url, { method: "POST", body: form });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
      return {
        ok: false,
        error: `the upload was rejected (${res.status}${detail ? `: ${detail}` : ""})`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `the upload did not complete: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  return { ok: true, resourceUrl: target.resourceUrl, target };
}

/** Media ids currently on a product, or null when the store did not answer. */
export async function productMediaIds(
  admin: AdminGraphql,
  productId: string
): Promise<Set<string> | null> {
  try {
    const res = await admin.graphql(PRODUCT_MEDIA_IDS, { variables: { id: productId } });
    const json = await res.json();
    const nodes = json?.data?.product?.media?.nodes ?? [];
    return new Set<string>(nodes.map((node: { id: string }) => node.id));
  } catch {
    return null;
  }
}

export type AddMediaResult =
  | { ok: true; mediaId: string; known: Set<string> | null }
  | { ok: false; error: string; known: Set<string> | null };

/**
 * Attach one image or video to a product, and say which media it became.
 *
 * ONE CALL PER MEDIA, DELIBERATELY. `productUpdate(media:)` takes a list and
 * answers with the product, not with the media it created, so after adding four
 * images there is no way to say which id belongs to which source. Uploading one
 * at a time and diffing this list is what makes a per-file result possible — and
 * a per-file result is what lets a retry retry only what failed.
 *
 * The alternative, `productCreateMedia`, does return the media it created — but
 * it is deprecated as of the 2026-07 Admin API, and its ordering is not
 * documented to follow the input when some entries fail. A wrongly attributed
 * id would mark the wrong file as sent, so a retry would resend the one that
 * worked and skip the one that did not. A deprecated mutation whose failure mode
 * is a silent mismatch is not worth the round trip it saves.
 *
 * WHEN THE STORE ACCEPTS A REQUEST BUT NO NEW MEDIA APPEARS, that is reported as
 * a failure. Counting the request as done would leave the seller with a file
 * that is not in their store and a row saying it was sent, and the retry that
 * should have followed never happens.
 *
 * `known` is threaded through rather than refetched so a caller adding a run of
 * media pays for one lookup instead of two per file. It is returned on both
 * branches because even a failed call may have changed what is on the product.
 */
export async function addProductMedia(input: {
  admin: AdminGraphql;
  shopifyProductId: string;
  originalSource: string;
  mediaContentType: MediaContentType;
  alt?: string | null;
  known: Set<string> | null;
}): Promise<AddMediaResult> {
  // A null set means "look it up", not "assume the product is empty". Assuming
  // it would make every added file look like the only one there, and then the
  // diff a line below would find nothing new and report a failure for a file
  // the store had just accepted.
  let known = input.known ?? (await productMediaIds(input.admin, input.shopifyProductId));
  try {
    const res = await input.admin.graphql(PRODUCT_MEDIA_ADD, {
      variables: {
        productId: input.shopifyProductId,
        media: [
          {
            originalSource: input.originalSource,
            mediaContentType: input.mediaContentType,
            ...(input.alt ? { alt: input.alt } : {}),
          },
        ],
      },
    });
    const json = await res.json();
    const errors = json?.data?.productUpdate?.userErrors ?? [];
    if (errors.length) {
      return {
        ok: false,
        error: joinUserErrors(errors, "the store refused the file"),
        known,
      };
    }

    const after = await productMediaIds(input.admin, input.shopifyProductId);
    // Held in a local so the narrowing survives into the closure below; a `let`
    // narrowed by a preceding check is not narrowed inside a callback.
    const before = known;
    const added = after && before ? [...after].filter((id) => !before.has(id)) : [];
    if (after) known = after;

    if (added.length === 1) return { ok: true, mediaId: added[0], known };

    return {
      ok: false,
      error:
        added.length === 0
          ? "the store accepted the file but it did not appear on the product"
          : `the store reported ${added.length} new files for one upload, so the new file could not be identified`,
      known,
    };
  } catch (error) {
    return {
      ok: false,
      error: `could not reach the store: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      known,
    };
  }
}

export type FileCreateResult = { ok: true; fileId: string } | { ok: false; error: string };

/**
 * Put a document in the seller's Files.
 *
 * A NULL `files` WITH NO `userErrors` IS RETRYABLE, NOT A SUCCESS. The Admin API
 * is known to answer `fileCreate` with an empty payload and no complaint when
 * the write did not take. Treating that as done would tell the seller their
 * document is in their store when nothing is there — so it is reported as a
 * failure whose message says to try again.
 */
export async function createStoreFile(input: {
  admin: AdminGraphql;
  resourceUrl: string;
  alt?: string | null;
}): Promise<FileCreateResult> {
  try {
    const res = await input.admin.graphql(FILE_CREATE, {
      variables: {
        files: [
          {
            originalSource: input.resourceUrl,
            contentType: "FILE",
            duplicateResolutionMode: "RAISE_ERROR",
            ...(input.alt ? { alt: input.alt } : {}),
          },
        ],
      },
    });
    const json = await res.json();
    const payload = json?.data?.fileCreate;
    const errors = payload?.userErrors ?? [];
    if (errors.length) {
      return { ok: false, error: joinUserErrors(errors, "the store refused the file") };
    }

    const file = payload?.files?.[0];
    if (!file?.id) {
      return {
        ok: false,
        error: "the store did not confirm the file; it may not have been saved, so try again",
      };
    }
    if (file.fileStatus === "FAILED") {
      return { ok: false, error: "the store could not process this file" };
    }
    return { ok: true, fileId: file.id };
  } catch (error) {
    return {
      ok: false,
      error: `could not reach the store: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
}

/**
 * Whether a recorded object is still in the seller's store.
 *
 * `true` means it is there, `false` means it is gone or unusable, and `null`
 * means the store did not answer — which is treated as "still there", because
 * the alternative is to re-send a file every time the API hiccups and the
 * seller ends up with duplicates. A wrong "still there" is recoverable by hand;
 * a duplicate is not.
 */
export async function objectStillPresent(
  admin: AdminGraphql,
  objectId: string
): Promise<boolean | null> {
  try {
    const res = await admin.graphql(FILE_STATUS, { variables: { id: objectId } });
    const json = await res.json();
    const node = json?.data?.node;
    if (!node) return false;
    if (node.fileStatus === "FAILED") return false;
    return true;
  } catch {
    return null;
  }
}

export interface TransferOutcome {
  ok: boolean;
  kind: ShopifyTransferKind;
  mediaAssetId: string;
  providerObjectId: string | null;
  error: string | null;
  /** Nothing was sent: this file is already in the seller's store. */
  alreadyTransferred: boolean;
}

export interface TransferInput {
  sellerId: string;
  productId: string;
  mediaAssetId: string;
  kind: ShopifyTransferKind;
  admin: AdminGraphql;
  /** Injectable for the staged PUT; see `TransferFetch`. */
  fetchImpl?: TransferFetch;
  /** Bounded polling of an async store-side job. */
  pollAttempts?: number;
  pollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_ATTEMPTS = 5;
const DEFAULT_POLL_DELAY_MS = 400;

async function persistTransfer(input: {
  sellerId: string;
  mediaAssetId: string;
  kind: ShopifyTransferKind;
  status: ShopifyTransferStatus;
  providerObjectId: string | null;
  error: string | null;
}): Promise<void> {
  const key = {
    sellerId: input.sellerId,
    mediaAssetId: input.mediaAssetId,
    kind: input.kind,
  };
  await prisma.shopifyFileTransfer.upsert({
    where: { sellerId_mediaAssetId_kind: key },
    create: {
      ...key,
      status: input.status,
      providerObjectId: input.providerObjectId,
      error: input.error,
    },
    update: {
      status: input.status,
      providerObjectId: input.providerObjectId,
      // Assigned rather than left alone: a successful retry has to clear the
      // message from the attempt before it, or the screen keeps showing an
      // error about a file that is now in the store.
      error: input.error,
    },
  });
}

/**
 * Move one asset into a seller's store, or say why it could not be moved.
 *
 * EVERY ATTEMPT WRITES THE TRANSFER ROW, including the ones that fail and the
 * ones that send nothing. The row is what the seller's screen reads to decide
 * whether to offer the button again, so a failure that is not recorded is a
 * button that keeps promising something that keeps not working.
 */
export async function transferAsset(input: TransferInput): Promise<TransferOutcome> {
  const fail = async (error: string): Promise<TransferOutcome> => {
    await persistTransfer({
      sellerId: input.sellerId,
      mediaAssetId: input.mediaAssetId,
      kind: input.kind,
      status: "FAILED",
      providerObjectId: null,
      error,
    }).catch(() => undefined);
    return {
      ok: false,
      kind: input.kind,
      mediaAssetId: input.mediaAssetId,
      providerObjectId: null,
      error,
      alreadyTransferred: false,
    };
  };

  const asset = await prisma.mediaAsset.findFirst({
    where: { id: input.mediaAssetId, productId: input.productId },
    select: {
      id: true,
      title: true,
      category: true,
      mimeType: true,
      fileSize: true,
      storageKey: true,
      sourceUrl: true,
      templateUrl: true,
      originalFilename: true,
      processingStatus: true,
      processingError: true,
      approvalStatus: true,
      sellerVisible: true,
      downloadAllowed: true,
      altText: true,
    },
  });
  if (!asset) return fail("That file is no longer part of this product.");

  // Re-checked here rather than trusted from the screen that drew the button:
  // the panel is a rendering of an earlier read, and approval or visibility can
  // be withdrawn between the two. Sending a file the merchant has since hidden
  // would be the one mistake this whole surface exists to prevent.
  if (asset.approvalStatus !== "APPROVED") {
    return fail("This file is not approved, so it cannot be sent to your store.");
  }
  if (!asset.sellerVisible) {
    return fail("This file is not shared with sellers.");
  }
  if (input.kind === "FILE" && !asset.downloadAllowed) {
    return fail("This file is marked as not downloadable, so it cannot be copied to your store.");
  }
  if (asset.processingStatus === "FAILED") {
    return fail(
      asset.processingError
        ? `This file could not be processed: ${asset.processingError}`
        : "This file could not be processed, so it cannot be sent."
    );
  }
  if (asset.processingStatus !== "READY") {
    return fail("This file is still being processed. Try again once it is ready.");
  }

  const resource = stagedResourceFor(input.kind, asset.mimeType);
  if (!resource) {
    return fail("This file is not an image or a video, so it cannot be added to a product.");
  }

  const sellerProduct = await prisma.sellerProduct.findUnique({
    where: { sellerId_productId: { sellerId: input.sellerId, productId: input.productId } },
    select: { shopifyProductId: true },
  });

  // A document goes to Files, which belongs to the store rather than to a
  // product, so it needs no listing. Product media does: there is nothing to
  // attach it to until the product itself has been imported.
  const shopifyProductId = sellerProduct?.shopifyProductId ?? null;
  if (input.kind === "MEDIA" && !shopifyProductId) {
    return fail(
      "Import this product to your store first — there is nothing here to attach the file to."
    );
  }

  const existing = await prisma.shopifyFileTransfer.findUnique({
    where: {
      sellerId_mediaAssetId_kind: {
        sellerId: input.sellerId,
        mediaAssetId: input.mediaAssetId,
        kind: input.kind,
      },
    },
    select: { status: true, providerObjectId: true },
  });

  // Only an object we can still find counts as done. `null` from either check
  // means the store did not answer, and that is left as "done" on purpose: see
  // `objectStillPresent`.
  let knownMediaIds: Set<string> | null = null;
  if (existing?.status === "SUCCEEDED" && existing.providerObjectId) {
    if (input.kind === "MEDIA" && shopifyProductId) {
      knownMediaIds = await productMediaIds(input.admin, shopifyProductId);
      if (knownMediaIds === null || knownMediaIds.has(existing.providerObjectId)) {
        return {
          ok: true,
          kind: input.kind,
          mediaAssetId: input.mediaAssetId,
          providerObjectId: existing.providerObjectId,
          error: null,
          alreadyTransferred: true,
        };
      }
    } else {
      const present = await objectStillPresent(input.admin, existing.providerObjectId);
      if (present !== false) {
        return {
          ok: true,
          kind: input.kind,
          mediaAssetId: input.mediaAssetId,
          providerObjectId: existing.providerObjectId,
          error: null,
          alreadyTransferred: true,
        };
      }
    }
    // The seller deleted it. The row is stale from here on and the file is sent
    // again, updating the same row rather than creating a second one.
  }

  const stored = asset.storageKey && !asset.templateUrl ? await readObject(asset.storageKey) : null;

  // Prefer the bytes we hold. The only assets without any are the ones migrated
  // out of the old flat model, whose file was never in this deployment's
  // storage — for those the original address is all there is, and for an image
  // it is enough. A video has no such fallback: the store will only take one
  // through a staged upload.
  let originalSource: string;
  if (stored) {
    const staged = await stageAndUpload({
      admin: input.admin,
      filename: transferFilename(asset),
      mimeType: asset.mimeType,
      resource,
      bytes: stored,
      fetchImpl: input.fetchImpl,
    });
    if (!staged.ok) return fail(staged.error);
    originalSource = staged.resourceUrl;
  } else if (isAbsoluteUrl(asset.sourceUrl)) {
    if (resource === "VIDEO") {
      return fail(
        "This video's file is not in MoonVella's storage and only a stored video can be sent. Re-upload it to make it transferable."
      );
    }
    originalSource = asset.sourceUrl.trim();
  } else if (isAbsoluteUrl(asset.templateUrl)) {
    originalSource = asset.templateUrl.trim();
  } else {
    return fail("MoonVella no longer has this file, so there is nothing to send.");
  }

  if (input.kind === "MEDIA") {
    const mediaContentType = resource === "VIDEO" ? "VIDEO" : "IMAGE";
    const added = await addProductMedia({
      admin: input.admin,
      shopifyProductId: shopifyProductId as string,
      originalSource,
      mediaContentType,
      alt: asset.altText,
      known: knownMediaIds,
    });
    if (!added.ok) return fail(added.error);

    await persistTransfer({
      sellerId: input.sellerId,
      mediaAssetId: input.mediaAssetId,
      kind: input.kind,
      status: "SUCCEEDED",
      providerObjectId: added.mediaId,
      error: null,
    }).catch(() => undefined);
    await auditTransfer(input, added.mediaId);
    return {
      ok: true,
      kind: input.kind,
      mediaAssetId: input.mediaAssetId,
      providerObjectId: added.mediaId,
      error: null,
      alreadyTransferred: false,
    };
  }

  const created = await createStoreFile({
    admin: input.admin,
    resourceUrl: originalSource,
    alt: asset.altText,
  });
  if (!created.ok) return fail(created.error);

  // The store works on a file after accepting it, so "created" is not the same
  // as "usable". Bounded: a seller pressing a button should not wait on a job
  // that may take minutes. A file still processing when the budget runs out is
  // reported as sent, because it is — it is in their Files either way.
  const attempts = Math.max(1, input.pollAttempts ?? DEFAULT_POLL_ATTEMPTS);
  const delay = input.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await sleep(delay);
    const present = await objectStillPresent(input.admin, created.fileId);
    if (present === false) {
      return fail("the store accepted the file and then reported it as failed");
    }
  }

  await persistTransfer({
    sellerId: input.sellerId,
    mediaAssetId: input.mediaAssetId,
    kind: input.kind,
    status: "SUCCEEDED",
    providerObjectId: created.fileId,
    error: null,
  }).catch(() => undefined);
  await auditTransfer(input, created.fileId);
  return {
    ok: true,
    kind: input.kind,
    mediaAssetId: input.mediaAssetId,
    providerObjectId: created.fileId,
    error: null,
    alreadyTransferred: false,
  };
}

async function auditTransfer(input: TransferInput, providerObjectId: string): Promise<void> {
  try {
    const seller = await prisma.seller.findUnique({
      where: { id: input.sellerId },
      select: { shopDomain: true, storeName: true },
    });
    await recordAudit({
      actorType: "MERCHANT",
      actorId: seller?.shopDomain ?? input.sellerId,
      actorName: seller?.storeName ?? null,
      action: input.kind === "MEDIA" ? "media.sent_to_store" : "file.sent_to_store",
      entityType: AUDIT_ENTITY.MEDIA,
      entityId: input.mediaAssetId,
      afterData: { kind: input.kind, providerObjectId, productId: input.productId },
    });
  } catch {
    // Bookkeeping must not turn a completed transfer into a reported failure:
    // the file is in the store, and nothing here can take it back out.
  }
}

export interface TransferState {
  kind: ShopifyTransferKind;
  status: ShopifyTransferStatus;
  providerObjectId: string | null;
  error: string | null;
}

/** What has already been sent, keyed `${assetId}:${kind}`, for the seller screen. */
export async function listTransferStates(
  sellerId: string,
  mediaAssetIds: string[]
): Promise<Map<string, TransferState>> {
  const states = new Map<string, TransferState>();
  if (!mediaAssetIds.length) return states;

  const rows = await prisma.shopifyFileTransfer.findMany({
    where: { sellerId, mediaAssetId: { in: mediaAssetIds } },
    select: {
      mediaAssetId: true,
      kind: true,
      status: true,
      providerObjectId: true,
      error: true,
    },
  });
  for (const row of rows) {
    states.set(`${row.mediaAssetId}:${row.kind}`, {
      kind: row.kind,
      status: row.status,
      providerObjectId: row.providerObjectId,
      error: row.error,
    });
  }
  return states;
}
