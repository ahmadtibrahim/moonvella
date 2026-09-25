import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { prisma } from "../db.server";
import { authenticate } from "../shopify.server";
import { listProductMedia } from "../services/media.server";
import { withMerchantAccess } from "../services/seller.server";
import {
  listTransferStates,
  mediaContentTypeFor,
  transferAsset,
} from "../services/shopifyTransfer.server";

/**
 * The files a seller may take from one product.
 *
 * WHY THIS PAGE EXISTS. A seller could see a product's photographs in the
 * catalogue and choose which ones an import should send, and that was all: a
 * video, a spec sheet or a marketing image was approved by the merchant, marked
 * seller-visible, and then visible to nobody. The marketing pack answered part
 * of it with one ZIP, which is the wrong shape for "put this video on my product
 * page" — the file has to arrive in the seller's own Shopify store, not in their
 * downloads folder.
 *
 * WHAT IS OFFERED IS WHAT WAS CLEARED. Only approved, seller-visible, finished
 * files on a published product appear, and the same three conditions are
 * re-checked here rather than trusted from the screen that drew the link: a URL
 * can be kept and replayed after an asset is withdrawn. The gate is the one the
 * catalogue and the marketing pack already apply, expressed once more because
 * this route can be reached directly.
 *
 * A FILE THAT CANNOT BE SENT SAYS SO. An unprocessed video, a file held back
 * from copying, a video on a product the seller has not imported yet — each is
 * listed with the reason instead of a disabled button. A button that does
 * nothing is indistinguishable from a broken page, and the seller's next move is
 * a support message rather than the one step that would fix it.
 *
 * NOTHING HERE PROMISES THEME PLACEMENT. The transfer uploads a file to the
 * merchant's Shopify store, into product media or into Files. It does not add a
 * section to their theme, and the copy says what it does.
 */

function requireSeller(seller: { id: string } | null): string {
  if (!seller) throw new Response("This account has no seller record yet.", { status: 403 });
  return seller.id;
}

/** Images, videos, documents and links are four different things to a page. */
type AssetKind = "IMAGE" | "VIDEO" | "DOCUMENT" | "LINK";

function kindOf(asset: { category: string; mimeType: string }): AssetKind {
  if (asset.category === "EDITABLE_TEMPLATE") return "LINK";
  const media = mediaContentTypeFor(asset.mimeType);
  if (media) return media;
  return "DOCUMENT";
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const productId = String(params.productId || "");
  if (!productId) throw new Response("Missing product.", { status: 400 });

  return withMerchantAccess(request, "VIEW", async (context) => {
    const sellerId = requireSeller(context.seller);

    // Published, active, not archived: the same gate the catalogue list applies.
    const product = await prisma.product.findFirst({
      where: { id: productId, status: "PUBLISHED", isActive: true, isArchived: false },
      select: { id: true, name: true, productCode: true },
    });
    if (!product) throw new Response("Product not available.", { status: 404 });

    const visible = (await listProductMedia(productId)).filter(
      (asset) => asset.approvalStatus === "APPROVED" && asset.sellerVisible
    );

    const [transfers, mapping] = await Promise.all([
      listTransferStates(
        sellerId,
        visible.map((asset) => asset.id)
      ),
      prisma.sellerProduct.findUnique({
        where: { sellerId_productId: { sellerId, productId } },
        select: { shopifyProductId: true },
      }),
    ]);
    const imported = Boolean(mapping?.shopifyProductId);

    const assets = visible.map((asset) => {
      const kind = kindOf(asset);
      const transferKind = kind === "IMAGE" || kind === "VIDEO" ? "MEDIA" : "FILE";
      const state = transfers.get(`${asset.id}:${transferKind}`) ?? null;

      /*
       * WHY A FILE CANNOT BE SENT, decided here rather than in the browser.
       *
       * The screen draws the same conclusion, but the answer has to exist on the
       * server first: the action re-derives it from the database, and a page that
       * invented its own rules would eventually disagree with the refusal a
       * seller actually meets.
       */
      let refusal: string | null = null;
      if (asset.processingStatus === "PROCESSING" || asset.processingStatus === "UPLOADING") {
        refusal = "This file is still being processed. Try again once it is ready.";
      } else if (asset.processingStatus === "FAILED") {
        refusal = asset.processingError
          ? `This file could not be processed: ${asset.processingError}`
          : "This file could not be processed, so it cannot be sent.";
      } else if (transferKind === "MEDIA" && !imported) {
        refusal = "Import this product to your store first — there is nothing here to attach it to.";
      } else if (transferKind === "FILE" && !asset.downloadAllowed) {
        refusal = "This file is marked as not downloadable, so it cannot be copied to your store.";
      }

      return {
        id: asset.id,
        title: asset.title,
        kind,
        transferKind,
        url: asset.url,
        /** Only for things a browser can display in place. */
        previewUrl: kind === "IMAGE" || kind === "VIDEO" ? asset.url : null,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
        width: asset.width,
        height: asset.height,
        durationSeconds: asset.durationSeconds,
        altText: asset.altText,
        instructions: asset.instructions,
        documentType: asset.documentType,
        version: asset.version,
        effectiveDate: asset.effectiveDate ? asset.effectiveDate.toISOString() : null,
        language: asset.language,
        isLegacy: asset.isLegacy,
        downloadAllowed: asset.downloadAllowed,
        processingStatus: asset.processingStatus,
        processingError: asset.processingError,
        refusal,
        transfer: state,
      };
    });

    // A seller who may read the catalogue but may not import it gets the page
    // and no buttons: the information is theirs, the actions are not.
    return {
      product,
      imported,
      canAct: context.canImport,
      assets,
    };
  });
}

export async function action({ params, request }: ActionFunctionArgs) {
  const productId = String(params.productId || "");
  if (!productId) return { ok: false, error: "Missing product." };

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const mediaAssetId = String(form.get("mediaAssetId") || "");
  if (!mediaAssetId) return { ok: false, error: "Missing file." };
  if (intent !== "transfer") return { ok: false, error: "Unknown action." };

  try {
    return await withMerchantAccess(request, "BUSINESS", async (context) => {
      const sellerId = requireSeller(context.seller);
      const kind = String(form.get("kind") || "") === "FILE" ? "FILE" : "MEDIA";
      const { admin } = await authenticate.admin(request);

      const outcome = await transferAsset({
        sellerId,
        productId,
        mediaAssetId,
        kind,
        admin,
      });

      if (!outcome.ok) return { ok: false, error: outcome.error || "The file could not be sent." };

      return {
        ok: true,
        mediaAssetId,
        kind,
        alreadyTransferred: outcome.alreadyTransferred,
        message: outcome.alreadyTransferred
          ? "This file is already in your store."
          : kind === "MEDIA"
            ? "Added to the product in your store. Shopify may take a moment to show it."
            : "Uploaded to your store's Files. Find it under Content → Files.",
      };
    });
  } catch (error) {
    // An access refusal is a message the seller can act on, not a crash. The
    // `AccessError` name is checked rather than the class so the module graph
    // stays one-way; anything else is a real failure and is rethrown.
    if (error instanceof Error && error.name === "AccessError") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes ? `${minutes}m ${whole % 60}s` : `${whole}s`;
}

const KIND_LABELS: Record<AssetKind, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  DOCUMENT: "Document",
  LINK: "Editable template",
};

function AssetCard({
  asset,
  canAct,
}: {
  asset: ReturnType<typeof useLoaderData<typeof loader>>["assets"][number];
  canAct: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const transfer = asset.transfer;

  return (
    <div className="mv-asset-card">
      <div className="mv-asset-preview">
        {asset.kind === "VIDEO" && asset.previewUrl ? (
          <video controls preload="metadata" width="100%" src={asset.previewUrl}>
            {/* Product video has no captions track: it is the merchant's own
                footage, uploaded as a single file and sent to Shopify as it is.
                The element is keyboard-operable and labelled by its title. */}
            <track kind="captions" />
          </video>
        ) : asset.kind === "IMAGE" && asset.previewUrl ? (
          <img src={asset.previewUrl} alt={asset.altText || asset.title} />
        ) : (
          <div className="mv-asset-preview-file">
            <span>{asset.kind === "LINK" ? "Template" : "Document"}</span>
            <span className="mv-asset-ext">
              {(asset.mimeType.split("/")[1] || asset.mimeType).toUpperCase()}
            </span>
          </div>
        )}
      </div>

      <div className="mv-asset-body">
        <h4 className="mv-asset-title">{asset.title}</h4>
        <div className="mv-asset-meta">
          <span className="mv-badge mv-badge-neutral">{KIND_LABELS[asset.kind]}</span>
          {asset.documentType ? <span>{asset.documentType}</span> : null}
          {asset.version ? <span>Version {asset.version}</span> : null}
          {asset.language ? <span>{asset.language}</span> : null}
          {asset.width && asset.height ? (
            <span>
              {asset.width}×{asset.height}
            </span>
          ) : null}
          {asset.durationSeconds ? <span>{formatDuration(asset.durationSeconds)}</span> : null}
          <span>{formatSize(asset.fileSize)}</span>
        </div>
        {asset.altText ? <p className="mv-asset-note">{asset.altText}</p> : null}
        {asset.instructions ? <p className="mv-asset-note">{asset.instructions}</p> : null}

        {asset.processingStatus === "FAILED" ? (
          <p className="mv-asset-error">
            {asset.processingError || "This file did not finish processing."}
          </p>
        ) : null}

        {transfer && transfer.status === "SUCCEEDED" ? (
          <p className="mv-asset-ok">
            {asset.transferKind === "MEDIA"
              ? "Added to this product in your store."
              : "Uploaded to your store's Files."}
          </p>
        ) : null}
        {transfer && transfer.status === "FAILED" && transfer.error ? (
          <p className="mv-asset-error">{transfer.error}</p>
        ) : null}

        {result && !result.ok && "error" in result && result.error ? (
          <p className="mv-asset-error">{result.error}</p>
        ) : null}
        {result && result.ok && "message" in result && result.message ? (
          <p className="mv-asset-ok">{result.message}</p>
        ) : null}

        <div className="mv-asset-actions">
          {/* A download is a link to the file's own address. It is offered for
              anything the merchant marked downloadable, and it is the original
              file — not a re-encode or a thumbnail. */}
          {asset.downloadAllowed ? (
            <a
              className="mv-asset-link"
              href={asset.url}
              target="_blank"
              rel="noreferrer"
              download
            >
              Download
            </a>
          ) : null}

          {canAct && !asset.refusal ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="transfer" />
              <input type="hidden" name="mediaAssetId" value={asset.id} />
              <input type="hidden" name="kind" value={asset.transferKind} />
              <button className="mv-import-btn" type="submit" disabled={busy}>
                {busy
                  ? "Sending…"
                  : asset.transferKind === "MEDIA"
                    ? transfer?.status === "SUCCEEDED"
                      ? "Send again"
                      : "Add to my Shopify product"
                    : transfer?.status === "SUCCEEDED"
                      ? "Upload again"
                      : "Upload to my Shopify files"}
              </button>
            </fetcher.Form>
          ) : null}
        </div>

        {canAct && asset.refusal ? <p className="mv-asset-note">{asset.refusal}</p> : null}
        {!canAct ? (
          <p className="mv-asset-note">
            Your account can view these files. Importing them into your store needs approved
            seller access.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function ProductAssets() {
  const { product, imported, canAct, assets } = useLoaderData<typeof loader>();

  const groups: { key: AssetKind | "OTHER"; label: string; hint: string }[] = [
    {
      key: "VIDEO",
      label: "Videos",
      hint: "Sent to your store as product media. Hosted video is uploaded, not linked.",
    },
    {
      key: "IMAGE",
      label: "Images",
      hint: "Sent to your store as product media.",
    },
    {
      key: "DOCUMENT",
      label: "Documents",
      hint: "Uploaded to your store's Files and downloadable here.",
    },
    {
      key: "LINK",
      label: "Editable templates",
      hint: "Uploaded to your store's Files as a link.",
    },
  ];

  return (
    <div className="mv-page">
      <div className="mv-asset-header">
        <div>
          <Link className="mv-asset-back" to="/app/catalog">
            ← Back to catalogue
          </Link>
          <h2 className="mv-page-title">{product.name}</h2>
          <p className="mv-asset-note">
            Files the merchant has shared with sellers. Nothing here changes your theme — a file
            is added to your product or to your store&apos;s Files.
          </p>
        </div>
        {!imported ? (
          <p className="mv-asset-note">
            This product is not in your store yet, so images and videos cannot be attached. Import
            it from the catalogue first.
          </p>
        ) : null}
      </div>

      {assets.length === 0 ? (
        <p className="mv-asset-note">
          This product has no files shared with sellers yet. They appear here once the merchant
          approves them.
        </p>
      ) : null}

      {groups.map((group) => {
        const items = assets.filter((asset) => asset.kind === group.key);
        if (!items.length) return null;
        return (
          <section className="mv-asset-section" key={group.key}>
            <h3 className="mv-asset-section-title">
              {group.label} <span className="mv-asset-count">{items.length}</span>
            </h3>
            <p className="mv-asset-note">{group.hint}</p>
            <div className="mv-asset-grid">
              {items.map((asset) => (
                <AssetCard key={asset.id} asset={asset} canAct={canAct} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
