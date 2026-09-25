/**
 * Sending a file from MoonVella into a seller's own Shopify store.
 *
 * WHAT THIS SUITE IS ALLOWED TO TOUCH. It runs only against a database whose
 * name ends in `_verify` (the runner refuses anything else) and it removes every
 * row and every stored object it creates in a `finally`. It makes no network
 * call: the Shopify admin client is a function that answers from a table, and
 * the staged upload goes through the injectable fetch this service exists with.
 * No Shopify, no Google, no Odoo, no carrier.
 *
 * WHAT IS REAL AND WHAT IS FAKED. Real: the asset rows, the stored bytes, the
 * storage read, the transfer rows, the audit rows, the refusal decisions, the
 * dedupe, and every field of every GraphQL request this code builds. Faked: the
 * store's answers. So this suite proves what we send and how we read the reply —
 * which is the half that can be pinned without a merchant session — and it
 * proves nothing about whether Shopify accepts it. That claim needs a live
 * storefront and is not made here.
 *
 * THE BYTES ARE NOT A REAL VIDEO, DELIBERATELY. A video row here points at a
 * small PNG under a key of its own, with `mimeType` set to `video/mp4` and its
 * status set to READY. Nothing in the transfer path looks inside the file — it
 * reads the object and uploads it — and inside is exactly what `verify-media`
 * already covers with real ffmpeg output. Encoding a second real clip here would
 * cost seconds per run to re-prove the part that is not under test.
 */

import { PrismaClient } from "@prisma/client";
import { listCatalog } from "../app/services/catalog.server";
import { resolveImagesForImport } from "../app/services/importMediaSelection.server";
import {
  addProductMedia,
  mediaContentTypeFor,
  stagedResourceFor,
  transferAsset,
  transferFilename,
} from "../app/services/shopifyTransfer.server";
import { deleteObject, saveUpload } from "../app/services/storage.server";

const prisma = new PrismaClient();

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created = {
  productIds: [] as string[],
  assetIds: [] as string[],
  keys: [] as string[],
  sellerIds: [] as string[],
};

/** A 1×1 PNG. The smallest thing that is genuinely a file of the type it claims. */
const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

interface GraphqlCall {
  query: string;
  variables?: Record<string, unknown>;
}

/**
 * A Shopify admin client that answers from a table.
 *
 * The mutation name is read out of the query text rather than matched against
 * the whole document, so a comment or a reordering in the real query does not
 * silently stop matching — a stub that matches nothing would otherwise answer
 * `undefined` and look like a store that said nothing.
 */
function makeAdmin(handlers: {
  staged?: (variables: Record<string, unknown>) => unknown;
  mediaAdd?: (variables: Record<string, unknown>) => unknown;
  mediaIds?: () => string[];
  fileCreate?: (variables: Record<string, unknown>) => unknown;
  fileStatus?: (id: string) => unknown;
}) {
  const calls: GraphqlCall[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const variables = opts?.variables ?? {};
      calls.push({ query, variables });
      let payload: unknown;
      if (query.includes("stagedUploadsCreate")) {
        payload = handlers.staged
          ? handlers.staged(variables)
          : {
              data: {
                stagedUploadsCreate: {
                  stagedTargets: [
                    {
                      url: "https://staged.example.invalid/upload",
                      resourceUrl: "https://staged.example.invalid/resource/abc",
                      parameters: [
                        { name: "policy", value: "POLICY" },
                        { name: "signature", value: "SIG" },
                      ],
                    },
                  ],
                  userErrors: [],
                },
              },
            };
      } else if (query.includes("productUpdate")) {
        payload = handlers.mediaAdd
          ? handlers.mediaAdd(variables)
          : { data: { productUpdate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } } };
      } else if (query.includes("product(id:")) {
        const nodes = (handlers.mediaIds?.() ?? []).map((id) => ({ id }));
        payload = { data: { product: { media: { nodes } } } };
      } else if (query.includes("fileCreate")) {
        payload = handlers.fileCreate
          ? handlers.fileCreate(variables)
          : {
              data: {
                fileCreate: { files: [{ id: "gid://shopify/GenericFile/9", fileStatus: "READY" }], userErrors: [] },
              },
            };
      } else if (query.includes("node(id:")) {
        const id = String(variables.id ?? "");
        payload = handlers.fileStatus
          ? handlers.fileStatus(id)
          : { data: { node: { id, fileStatus: "READY" } } };
      } else {
        throw new Error(`the stub does not recognise this query: ${query.slice(0, 80)}`);
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  return { admin, calls };
}

/** The staged upload's HTTP request, recorded rather than sent. */
function makeUploader(status = 201) {
  const uploads: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    uploads.push({ url, init });
    return new Response(status === 201 ? "" : "refused", { status });
  };
  return { uploads, fetchImpl: fetchImpl as never };
}

function stagedInput(call: GraphqlCall): Record<string, unknown> {
  const input = call.variables?.input;
  return (Array.isArray(input) ? input[0] : {}) as Record<string, unknown>;
}

function mediaInput(call: GraphqlCall): Record<string, unknown> {
  const media = call.variables?.media;
  return (Array.isArray(media) ? media[0] : {}) as Record<string, unknown>;
}

function fileInput(call: GraphqlCall): Record<string, unknown> {
  const files = call.variables?.files;
  return (Array.isArray(files) ? files[0] : {}) as Record<string, unknown>;
}

async function main() {
  // ---- helpers: build the rows this suite needs -------------------------
  async function makeProduct(name: string) {
    const product = await prisma.product.create({
      data: {
        name,
        category: "Bedding",
        productCode: `VERIFY-TR-${suffix}-${created.productIds.length}`,
        status: "DRAFT",
        description: "Transfer suite fixture.",
      },
    });
    created.productIds.push(product.id);
    return product;
  }

  async function makeAsset(input: {
    productId: string;
    category:
      | "WHITE_BACKGROUND_IMAGE"
      | "LIFESTYLE_IMAGE"
      | "PRODUCT_VIDEO"
      | "DOCUMENT"
      | "EDITABLE_TEMPLATE";
    mimeType: string;
    approvalStatus?: "APPROVED" | "DRAFT" | "REJECTED";
    sellerVisible?: boolean;
    downloadAllowed?: boolean;
    processingStatus?: "READY" | "PROCESSING" | "FAILED";
    processingError?: string | null;
    sourceUrl?: string | null;
    templateUrl?: string | null;
    withBytes?: boolean;
  }) {
    const stored =
      input.withBytes === false
        ? null
        : await saveUpload(new File([TINY_PNG], `fixture-${suffix}.png`, { type: "image/png" }));
    if (stored) created.keys.push(stored.key);

    const asset = await prisma.mediaAsset.create({
      data: {
        productId: input.productId,
        category: input.category,
        title: `Fixture ${suffix}`,
        originalFilename: `fixture-${suffix}.png`,
        storageKey: stored?.key ?? `none-${suffix}-${created.assetIds.length}`,
        mimeType: input.mimeType,
        fileSize: stored?.size ?? 0,
        checksum: stored?.checksum ?? `none-${suffix}-${created.assetIds.length}`,
        sourceUrl: input.sourceUrl ?? null,
        templateUrl: input.templateUrl ?? null,
        processingStatus: input.processingStatus ?? "READY",
        processingError: input.processingError ?? null,
        approvalStatus: input.approvalStatus ?? "APPROVED",
        sellerVisible: input.sellerVisible ?? true,
        downloadAllowed: input.downloadAllowed ?? true,
      },
    });
    created.assetIds.push(asset.id);
    return asset;
  }

  async function makeSeller(label: string) {
    const shop = `verify-tr-${label}-${suffix}.myshopify.com`;
    const seller = await prisma.seller.create({
      data: {
        shopDomain: shop,
        shopDomainFull: shop,
        storeName: `Verify ${label} ${suffix}`,
        contactEmail: `verify-tr-${label}@example.invalid`,
        status: "APPROVED",
      },
    });
    created.sellerIds.push(seller.id);
    return seller;
  }

  async function mapProduct(sellerId: string, productId: string, shopifyProductId: string | null) {
    await prisma.sellerProduct.upsert({
      where: { sellerId_productId: { sellerId, productId } },
      create: { sellerId, productId, shopifyProductId },
      update: { shopifyProductId },
    });
  }

  try {
    // =====================================================================
    // The decisions that do not need a store
    // =====================================================================
    check("an image mime type is product media", mediaContentTypeFor("image/png") === "IMAGE");
    check("a video mime type is product media", mediaContentTypeFor("video/mp4") === "VIDEO");
    check(
      "a document is not product media",
      mediaContentTypeFor("application/pdf") === null,
      "a PDF must never be offered as an image"
    );
    check("a document stages as a file", stagedResourceFor("FILE", "application/pdf") === "FILE");
    check(
      "a document stages as a file even beside an image mime type",
      stagedResourceFor("FILE", "image/png") === "FILE"
    );
    check(
      "a PDF cannot be staged as product media",
      stagedResourceFor("MEDIA", "application/pdf") === null
    );

    check(
      "a filename with a path in it is reduced to its last segment",
      !transferFilename({ originalFilename: "../../etc/passwd" }).includes("/"),
      transferFilename({ originalFilename: "../../etc/passwd" })
    );
    check(
      "an ordinary filename survives",
      transferFilename({ originalFilename: "spec-sheet.pdf" }) === "spec-sheet.pdf"
    );
    check(
      "an unnamed video still gets a usable name and an extension",
      transferFilename({ originalFilename: "", title: "", mimeType: "video/mp4" }) === "upload.mp4",
      transferFilename({ originalFilename: "", title: "", mimeType: "video/mp4" })
    );
    check(
      "an unnamed document gets its own extension, not the video's",
      transferFilename({ originalFilename: "", title: "", mimeType: "application/pdf" }) === "upload.pdf",
      transferFilename({ originalFilename: "", title: "", mimeType: "application/pdf" })
    );
    check(
      "a name that already has an extension is left alone",
      transferFilename({ originalFilename: "shot.png", mimeType: "video/mp4" }) === "shot.png"
    );

    // =====================================================================
    // An image whose bytes are ours
    // =====================================================================
    const product = await makeProduct("Transfer fixture product");
    const seller = await makeSeller("main");
    await mapProduct(seller.id, product.id, "gid://shopify/Product/77");
    const image = await makeAsset({
      productId: product.id,
      category: "WHITE_BACKGROUND_IMAGE",
      mimeType: "image/png",
    });

    const mediaIds: string[] = [];
    let nextMedia = 1;
    const imageStore = makeAdmin({
      mediaIds: () => [...mediaIds],
      mediaAdd: () => {
        mediaIds.push(`gid://shopify/MediaImage/${nextMedia++}`);
        return { data: { productUpdate: { product: { id: "gid://shopify/Product/77" }, userErrors: [] } } };
      },
    });
    const imageUpload = makeUploader();

    const imageOutcome = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: image.id,
      kind: "MEDIA",
      admin: imageStore.admin,
      fetchImpl: imageUpload.fetchImpl,
    });

    const stagedCall = imageStore.calls.find((call) => call.query.includes("stagedUploadsCreate"));
    const imageStaged = stagedCall ? stagedInput(stagedCall) : {};
    check(
      "an image is staged before it is sent",
      Boolean(stagedCall),
      stagedCall ? "stagedUploadsCreate called" : "no staged upload was created"
    );
    check("the staged resource is an image", imageStaged.resource === "IMAGE");
    check("the staged upload carries the file size", imageStaged.fileSize === String(TINY_PNG.byteLength));
    check("the staged upload carries the mime type", imageStaged.mimeType === "image/png");
    check("the staged upload is a POST", imageStaged.httpMethod === "POST");

    check("the bytes are uploaded to the staged url", imageUpload.uploads.length === 1);
    const upload = imageUpload.uploads[0];
    check("the upload goes to the address the store gave", upload?.url === "https://staged.example.invalid/upload");
    check("the upload uses the method the store asked for", (upload?.init?.method as string) === "POST");
    const form = upload?.init?.body as FormData;
    const keys = form ? [...form.keys()] : [];
    check(
      "the authentication parameters are sent before the file",
      keys.length >= 3 && keys[keys.length - 1] === "file",
      keys.join(",")
    );
    check("the file part is named file", keys[keys.length - 1] === "file");
    const filePart = form?.get("file") as File | null;
    check("the file part carries the real filename", filePart?.name === `fixture-${suffix}.png`, filePart?.name);
    check("the file part carries the bytes", filePart?.size === TINY_PNG.byteLength);

    const mediaAddCall = imageStore.calls.find((call) => call.query.includes("productUpdate"));
    const imageMedia = mediaAddCall ? mediaInput(mediaAddCall) : {};
    check(
      "the image is attached from the staged resource, not from a URL of ours",
      imageMedia.originalSource === "https://staged.example.invalid/resource/abc",
      String(imageMedia.originalSource)
    );
    check("the image is sent as an image", imageMedia.mediaContentType === "IMAGE");
    check("the transfer succeeded", imageOutcome.ok, imageOutcome.error ?? "");
    check(
      "the outcome names the media the store created",
      imageOutcome.providerObjectId === "gid://shopify/MediaImage/1",
      String(imageOutcome.providerObjectId)
    );

    const imageRow = await prisma.shopifyFileTransfer.findUnique({
      where: {
        sellerId_mediaAssetId_kind: { sellerId: seller.id, mediaAssetId: image.id, kind: "MEDIA" },
      },
    });
    check("the transfer was recorded as succeeded", imageRow?.status === "SUCCEEDED", String(imageRow?.status));
    check("the record holds the store's id", imageRow?.providerObjectId === "gid://shopify/MediaImage/1");
    check("a successful transfer records no error", imageRow?.error === null);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: image.id, action: "media.sent_to_store" },
    });
    check("the transfer is audited", Boolean(audit), audit ? "audit row written" : "no audit row");

    // ---- sending it again sends nothing --------------------------------
    const secondUpload = makeUploader();
    const repeat = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: image.id,
      kind: "MEDIA",
      admin: imageStore.admin,
      fetchImpl: secondUpload.fetchImpl,
    });
    check("a second send reports the file is already there", repeat.alreadyTransferred === true);
    check("a second send uploads nothing", secondUpload.uploads.length === 0, `${secondUpload.uploads.length} uploads`);
    check("a second send creates no second transfer row", (await prisma.shopifyFileTransfer.count({
      where: { sellerId: seller.id, mediaAssetId: image.id, kind: "MEDIA" },
    })) === 1);

    /*
     * ---- an EDIT, then a republish -------------------------------------
     *
     * "Republishing must not create duplicates" is a claim about what the
     * mapping is keyed to. It is keyed to (seller, asset, kind) — the identity
     * of the file, not the description of it — so retitling a photograph,
     * rewriting its alt text or moving it to another size leaves the store's
     * copy findable. Writing it against anything editable would have made a
     * routine edit look like a new file, and the store would collect a second
     * copy of the same photograph on every republish.
     */
    await prisma.mediaAsset.update({
      where: { id: image.id },
      data: { title: `Retitled ${suffix}`, altText: "A description written after the first send" },
    });
    const republishUpload = makeUploader();
    const republished = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: image.id,
      kind: "MEDIA",
      admin: imageStore.admin,
      fetchImpl: republishUpload.fetchImpl,
    });
    check(
      "an edited file is still recognised as already in the store",
      republished.alreadyTransferred === true && republishUpload.uploads.length === 0,
      `alreadyTransferred=${republished.alreadyTransferred}, ${republishUpload.uploads.length} upload(s)`
    );
    check(
      "and the edit added no second mapping row",
      (await prisma.shopifyFileTransfer.count({
        where: { sellerId: seller.id, mediaAssetId: image.id, kind: "MEDIA" },
      })) === 1
    );

    // ---- a row for a file the seller deleted ---------------------------
    // The store keeps the id in the row; if the media is no longer on the
    // product, the row is stale and the file is sent again.
    mediaIds.length = 0;
    const staleUpload = makeUploader();
    const resent = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: image.id,
      kind: "MEDIA",
      admin: imageStore.admin,
      fetchImpl: staleUpload.fetchImpl,
    });
    check(
      "a record for a file that is gone is not believed",
      resent.alreadyTransferred === false && resent.ok,
      `alreadyTransferred=${resent.alreadyTransferred} ok=${resent.ok}`
    );
    check("the deleted file is uploaded again", staleUpload.uploads.length === 1);
    check(
      "the retry updates one row rather than creating another",
      (await prisma.shopifyFileTransfer.count({
        where: { sellerId: seller.id, mediaAssetId: image.id, kind: "MEDIA" },
      })) === 1
    );

    // =====================================================================
    // A video
    // =====================================================================
    const video = await makeAsset({
      productId: product.id,
      category: "PRODUCT_VIDEO",
      mimeType: "video/mp4",
    });
    const videoUpload = makeUploader();
    // The product already holds one media id, so the new one can be told apart
    // by difference — which is how the id is attributed at all.
    const videoMediaIds = ["gid://shopify/MediaImage/1"];
    const videoStore2 = makeAdmin({
      mediaIds: () => videoMediaIds,
      mediaAdd: () => {
        videoMediaIds.push("gid://shopify/Video/5");
        return { data: { productUpdate: { product: { id: "x" }, userErrors: [] } } };
      },
    });
    const videoOutcome = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: video.id,
      kind: "MEDIA",
      admin: videoStore2.admin,
      fetchImpl: videoUpload.fetchImpl,
    });
    const videoStagedCall = videoStore2.calls.find((call) => call.query.includes("stagedUploadsCreate"));
    check("a video is staged", Boolean(videoStagedCall));
    check("the staged resource for a video is VIDEO", stagedInput(videoStagedCall!).resource === "VIDEO");
    check(
      "a video's staged upload carries a size, which the API requires",
      typeof stagedInput(videoStagedCall!).fileSize === "string" && stagedInput(videoStagedCall!).fileSize !== ""
    );
    const videoMediaCall = videoStore2.calls.filter((call) => call.query.includes("productUpdate"))[0];
    check(
      "a video is attached as a video",
      mediaInput(videoMediaCall!).mediaContentType === "VIDEO",
      String(mediaInput(videoMediaCall!).mediaContentType)
    );
    check("the video transfer succeeded", videoOutcome.ok, videoOutcome.error ?? "");
    check(
      "the video's own id is recorded, not the image's",
      videoOutcome.providerObjectId === "gid://shopify/Video/5",
      String(videoOutcome.providerObjectId)
    );

    // =====================================================================
    // A document, into Files
    // =====================================================================
    const doc = await makeAsset({
      productId: product.id,
      category: "DOCUMENT",
      mimeType: "application/pdf",
    });
    const docStore = makeAdmin({});
    const docUpload = makeUploader();
    const docOutcome = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: doc.id,
      kind: "FILE",
      admin: docStore.admin,
      pollAttempts: 1,
      sleep: async () => undefined,
      fetchImpl: docUpload.fetchImpl,
    });
    const docStagedCall = docStore.calls.find((call) => call.query.includes("stagedUploadsCreate"));
    check("a document is staged too", Boolean(docStagedCall));
    check("a document's staged resource is FILE", stagedInput(docStagedCall!).resource === "FILE");

    const fileCreateCall = docStore.calls.find((call) => call.query.includes("fileCreate"));
    const fileInputValue = fileCreateCall ? fileInput(fileCreateCall) : {};
    check("fileCreate is called", Boolean(fileCreateCall));
    check("the document is created as a file", fileInputValue.contentType === "FILE");
    check(
      "the file is created from the staged resource",
      fileInputValue.originalSource === "https://staged.example.invalid/resource/abc",
      String(fileInputValue.originalSource)
    );
    check(
      "a duplicate is refused rather than silently appended",
      fileInputValue.duplicateResolutionMode === "RAISE_ERROR",
      String(fileInputValue.duplicateResolutionMode)
    );
    check(
      "the filename is not sent again, which is what breaks fileCreate",
      !("filename" in fileInputValue),
      Object.keys(fileInputValue).join(",")
    );
    check("the document transfer succeeded", docOutcome.ok, docOutcome.error ?? "");
    check(
      "the document's file id is recorded",
      docOutcome.providerObjectId === "gid://shopify/GenericFile/9",
      String(docOutcome.providerObjectId)
    );
    check(
      "the document is recorded under its own kind",
      (await prisma.shopifyFileTransfer.findUnique({
        where: { sellerId_mediaAssetId_kind: { sellerId: seller.id, mediaAssetId: doc.id, kind: "FILE" } },
      }))?.status === "SUCCEEDED"
    );

    // =====================================================================
    // Failures are reported, recorded, and retryable
    // =====================================================================
    const failing = await makeAsset({
      productId: product.id,
      category: "WHITE_BACKGROUND_IMAGE",
      mimeType: "image/png",
    });
    const refuseStore = makeAdmin({
      mediaIds: () => [],
      mediaAdd: () => ({
        data: {
          productUpdate: {
            product: null,
            userErrors: [{ field: ["media", "0", "originalSource"], message: "Invalid image URL" }],
          },
        },
      }),
    });
    const refused = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: failing.id,
      kind: "MEDIA",
      admin: refuseStore.admin,
      fetchImpl: makeUploader().fetchImpl,
    });
    check("a store refusal is a failure", refused.ok === false);
    check(
      "the store's own message is what the seller is shown",
      (refused.error ?? "").includes("Invalid image URL"),
      refused.error ?? ""
    );
    const refusedRow = await prisma.shopifyFileTransfer.findUnique({
      where: {
        sellerId_mediaAssetId_kind: { sellerId: seller.id, mediaAssetId: failing.id, kind: "MEDIA" },
      },
    });
    check("a failed attempt is recorded, not swallowed", refusedRow?.status === "FAILED");
    check("the recorded failure carries the reason", (refusedRow?.error ?? "").includes("Invalid image URL"));

    // ---- an empty fileCreate payload with no complaint is a retry -------
    const emptyFile = await makeAsset({
      productId: product.id,
      category: "DOCUMENT",
      mimeType: "application/pdf",
    });
    const emptyStore = makeAdmin({
      fileCreate: () => ({ data: { fileCreate: { files: null, userErrors: [] } } }),
    });
    const emptyOutcome = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: emptyFile.id,
      kind: "FILE",
      admin: emptyStore.admin,
      fetchImpl: makeUploader().fetchImpl,
    });
    check("an empty answer from fileCreate is not counted as success", emptyOutcome.ok === false);
    check(
      "and it says to try again rather than reporting a hard failure",
      /try again/i.test(emptyOutcome.error ?? ""),
      emptyOutcome.error ?? ""
    );

    // ---- a file the store accepted and then failed -----------------------
    const failedLater = await makeAsset({
      productId: product.id,
      category: "DOCUMENT",
      mimeType: "application/pdf",
    });
    const laterStore = makeAdmin({ fileStatus: (id) => ({ data: { node: { id, fileStatus: "FAILED" } } }) });
    const laterOutcome = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: failedLater.id,
      kind: "FILE",
      admin: laterStore.admin,
      pollAttempts: 2,
      pollDelayMs: 1,
      fetchImpl: makeUploader().fetchImpl,
    });
    check("a file the store reports as failed is a failure", laterOutcome.ok === false, laterOutcome.error ?? "");

    // ---- a retry after a failure clears the old error --------------------
    const recoveredIds: string[] = [];
    const recoverStore = makeAdmin({
      mediaIds: () => [...recoveredIds],
      mediaAdd: () => {
        recoveredIds.push("gid://shopify/MediaImage/88");
        return { data: { productUpdate: { product: { id: "x" }, userErrors: [] } } };
      },
    });
    const recovered = await transferAsset({
      sellerId: seller.id,
      productId: product.id,
      mediaAssetId: failing.id,
      kind: "MEDIA",
      admin: recoverStore.admin,
      fetchImpl: makeUploader().fetchImpl,
    });
    const recoveredRow = await prisma.shopifyFileTransfer.findUnique({
      where: {
        sellerId_mediaAssetId_kind: { sellerId: seller.id, mediaAssetId: failing.id, kind: "MEDIA" },
      },
    });
    check("a retry can succeed", recovered.ok, recovered.error ?? "");
    check("a successful retry clears the previous error", recoveredRow?.error === null, String(recoveredRow?.error));
    check(
      "and replaces the recorded status",
      recoveredRow?.status === "SUCCEEDED" && recoveredRow?.providerObjectId === "gid://shopify/MediaImage/88"
    );

    // =====================================================================
    // Refusals: what must never be sent
    // =====================================================================
    // A const arrow rather than a function declaration: this helper belongs
    // with the refusals it drives, which are inside the fixture's `try` block,
    // and this repo refuses a function declared inside a block. It closes over
    // the product and the run's asset list it was written against, so moving it
    // up to the body root would mean threading both through as arguments.
    const refusalFor = async (input: {
      category: "WHITE_BACKGROUND_IMAGE" | "DOCUMENT" | "PRODUCT_VIDEO";
      mimeType: string;
      kind: "MEDIA" | "FILE";
      approvalStatus?: "APPROVED" | "DRAFT" | "REJECTED";
      sellerVisible?: boolean;
      downloadAllowed?: boolean;
      processingStatus?: "READY" | "PROCESSING" | "FAILED";
      processingError?: string | null;
      imported?: boolean;
      otherProduct?: boolean;
    }): Promise<{ called: number; error: string | null }> => {
      const owner = input.otherProduct ? await makeProduct("Other product") : product;
      const asset = await makeAsset({
        productId: owner.id,
        category: input.category,
        mimeType: input.mimeType,
        approvalStatus: input.approvalStatus,
        sellerVisible: input.sellerVisible,
        downloadAllowed: input.downloadAllowed,
        processingStatus: input.processingStatus,
        processingError: input.processingError,
      });
      const target = await makeSeller(`refusal-${created.assetIds.length}`);
      if (input.imported !== false) await mapProduct(target.id, product.id, "gid://shopify/Product/99");
      const store = makeAdmin({ mediaIds: () => [] });
      const outcome = await transferAsset({
        sellerId: target.id,
        // Always the product the caller claims. For the cross-product check the
        // asset deliberately lives on a different one.
        productId: product.id,
        mediaAssetId: asset.id,
        kind: input.kind,
        admin: store.admin,
        fetchImpl: makeUploader().fetchImpl,
      });
      return { called: store.calls.length, error: outcome.error };
    };

    /*
     * A WITHDRAWN FILE, NOT AN UNAPPROVED ONE. Nothing an administrator uploads
     * is unapproved any more — it is written approved and switched on — so the
     * only state that still stops a transfer on moderation grounds is a
     * rejection, which is the deliberate "no" and clears `sellerVisible` with
     * it. The check below is the same guard the panel has always had; only the
     * state that trips it has changed name.
     */
    const withdrawn = await refusalFor({
      category: "WHITE_BACKGROUND_IMAGE",
      mimeType: "image/png",
      kind: "MEDIA",
      approvalStatus: "REJECTED",
    });
    check("a withdrawn file is refused", withdrawn.called === 0 && Boolean(withdrawn.error), withdrawn.error ?? "");
    check(
      "and the refusal says it has been withdrawn",
      /withdrawn/i.test(withdrawn.error ?? ""),
      withdrawn.error ?? ""
    );

    const hidden = await refusalFor({
      category: "WHITE_BACKGROUND_IMAGE",
      mimeType: "image/png",
      kind: "MEDIA",
      sellerVisible: false,
    });
    check("a file held back from sellers is refused", hidden.called === 0 && Boolean(hidden.error), hidden.error ?? "");

    const notReady = await refusalFor({
      category: "PRODUCT_VIDEO",
      mimeType: "video/mp4",
      kind: "MEDIA",
      processingStatus: "PROCESSING",
    });
    check(
      "a file still processing is refused with that reason",
      notReady.called === 0 && /still being processed/i.test(notReady.error ?? ""),
      notReady.error ?? ""
    );

    const broken = await refusalFor({
      category: "PRODUCT_VIDEO",
      mimeType: "video/mp4",
      kind: "MEDIA",
      processingStatus: "FAILED",
      processingError: "no video stream was found in this file",
    });
    check(
      "an unprocessable file is refused and says why",
      broken.called === 0 && (broken.error ?? "").includes("no video stream"),
      broken.error ?? ""
    );

    const unimported = await refusalFor({
      category: "WHITE_BACKGROUND_IMAGE",
      mimeType: "image/png",
      kind: "MEDIA",
      imported: false,
    });
    check(
      "product media is refused until the product is in the store",
      unimported.called === 0 && /import this product/i.test(unimported.error ?? ""),
      unimported.error ?? ""
    );

    const notDownloadable = await refusalFor({
      category: "DOCUMENT",
      mimeType: "application/pdf",
      kind: "FILE",
      downloadAllowed: false,
    });
    check(
      "a file the merchant did not share for copying is refused",
      notDownloadable.called === 0 && Boolean(notDownloadable.error),
      notDownloadable.error ?? ""
    );

    const foreign = await refusalFor({
      category: "WHITE_BACKGROUND_IMAGE",
      mimeType: "image/png",
      kind: "MEDIA",
      otherProduct: true,
    });
    check(
      "a file on another product is refused",
      foreign.called === 0 && Boolean(foreign.error),
      foreign.error ?? ""
    );

    // A document does not need the product to be imported: Files is the
    // store's, not the listing's.
    const fileWithoutImport = await refusalFor({
      category: "DOCUMENT",
      mimeType: "application/pdf",
      kind: "FILE",
      imported: false,
    });
    check(
      "a document can go to Files before the product is imported",
      fileWithoutImport.called > 0,
      fileWithoutImport.error ?? "no refusal"
    );

    // =====================================================================
    // The pipeline images an import used to refuse
    // =====================================================================
    const importProduct = await makeProduct("Import selection fixture");
    const importSeller = await makeSeller("import");
    const pipelineImage = await makeAsset({
      productId: importProduct.id,
      category: "WHITE_BACKGROUND_IMAGE",
      mimeType: "image/png",
    });
    const legacyImage = await makeAsset({
      productId: importProduct.id,
      category: "LIFESTYLE_IMAGE",
      mimeType: "image/png",
      sourceUrl: `https://legacy.example.invalid/${suffix}.png`,
      withBytes: false,
    });

    const selection = await resolveImagesForImport(importSeller.id, importProduct.id);
    const pipelineResolved = selection.images.find((row) => row.mediaAssetId === pipelineImage.id);
    const legacyResolved = selection.images.find((row) => row.mediaAssetId === legacyImage.id);
    check(
      "an uploaded image is no longer refused as unusable",
      Boolean(pipelineResolved),
      selection.unusable.map((row) => row.reason).join("; ")
    );
    check("and it carries the key its bytes are stored under", Boolean(pipelineResolved?.staged?.storageKey));
    check(
      "and it claims no address, because it has none the store could fetch",
      pipelineResolved?.url === null,
      String(pipelineResolved?.url)
    );
    check(
      "and its staged filename and type come from the asset",
      pipelineResolved?.staged?.filename === `fixture-${suffix}.png` &&
        pipelineResolved?.staged?.mimeType === "image/png"
    );
    check(
      "a legacy image still travels by URL",
      legacyResolved?.url === `https://legacy.example.invalid/${suffix}.png` && legacyResolved?.staged === null
    );
    check("nothing in the selection is unusable", selection.unusable.length === 0, selection.unusable.length + " unusable");

    // =====================================================================
    // The catalogue's own images are addresses
    // =====================================================================
    await prisma.product.update({
      where: { id: importProduct.id },
      data: { status: "PUBLISHED", isActive: true },
    });
    const catalog = await listCatalog({ canViewWholesale: false });
    const catalogEntry = catalog.find((row) => row.id === importProduct.id);
    const catalogImage = catalogEntry?.image ?? "";
    check(
      "the catalogue gives the browser a URL",
      /^\/uploads\/[0-9a-f]{32}\.[a-z0-9]{2,5}$/.test(catalogImage),
      catalogImage
    );
    check(
      "and never a bare storage key, which is what broke every product image",
      catalogImage !== pipelineResolved?.staged?.storageKey,
      catalogImage
    );

    // =====================================================================
    // addProductMedia on its own: the extraction the import now uses
    // =====================================================================
    const directIds: string[] = [];
    const directStore = makeAdmin({
      mediaIds: () => [...directIds],
      mediaAdd: () => {
        directIds.push("gid://shopify/MediaImage/400");
        return { data: { productUpdate: { product: { id: "x" }, userErrors: [] } } };
      },
    });
    const direct = await addProductMedia({
      admin: directStore.admin,
      shopifyProductId: "gid://shopify/Product/77",
      originalSource: "https://legacy.example.invalid/x.png",
      mediaContentType: "IMAGE",
      known: null,
    });
    check("the shared media primitive reports the id it created", direct.ok && direct.mediaId === "gid://shopify/MediaImage/400");
    check("and hands back what the product now holds", direct.ok && direct.known?.has("gid://shopify/MediaImage/400") === true);

    const missingStore = makeAdmin({
      mediaIds: () => [],
      mediaAdd: () => ({ data: { productUpdate: { product: { id: "x" }, userErrors: [] } } }),
    });
    const missing = await addProductMedia({
      admin: missingStore.admin,
      shopifyProductId: "gid://shopify/Product/77",
      originalSource: "https://legacy.example.invalid/x.png",
      mediaContentType: "IMAGE",
      known: new Set<string>(),
    });
    check(
      "a media the store accepted but never created is a failure",
      missing.ok === false && /did not appear/i.test(missing.error),
      missing.ok ? "reported ok" : missing.error
    );

  } finally {
    // ---- remove everything this suite created ---------------------------
    try {
      await prisma.shopifyFileTransfer.deleteMany({
        where: { OR: [{ mediaAssetId: { in: created.assetIds } }, { sellerId: { in: created.sellerIds } }] },
      });
      // The audit rows are deliberately left behind. `AuditLog` carries a
      // database trigger that refuses DELETE — it is append-only by design, and
      // a suite that asked for an exemption would be asking to weaken the one
      // guarantee the table exists to provide. What that costs is a handful of
      // rows in a throwaway clone referring to assets this run removed.
      await prisma.sellerProduct.deleteMany({ where: { sellerId: { in: created.sellerIds } } });
      await prisma.seller.deleteMany({ where: { id: { in: created.sellerIds } } });
      await prisma.mediaAsset.deleteMany({ where: { id: { in: created.assetIds } } });
      await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    } catch (error) {
      console.error("cleanup: rows could not all be removed", error);
    }
    for (const key of created.keys) {
      await deleteObject(key).catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
