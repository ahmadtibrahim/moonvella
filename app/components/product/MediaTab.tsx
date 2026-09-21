import { Form, Link, useSearchParams } from "react-router";
import {
  card,
  input,
  btn,
  sectionTitle,
  sectionNote,
  Field,
  StatusChip,
  EmptyState,
  ConfirmForm,
  fileSize,
  duration,
  INK,
  MUTED,
  FAINT,
  LINE,
  helpText,
} from "./ui";
// Type-only: nothing from the server module reaches the client bundle.
import type { MediaAssetView } from "~/services/media.server";

/**
 * Media — the files, and which variants they belong to.
 *
 * THE CENTRAL IDEA. A file is stored once and *attached*. Applying one
 * photograph to four variants writes four assignment rows and copies no bytes.
 * So the interface has to answer two different questions about the same file:
 * "what is it?" (the asset) and "where does it apply?" (its assignments), and
 * an asset attached to nothing is a file that will never be seen.
 *
 * WHAT A PLACEHOLDER IS. A variant with no image shows a placeholder tile. That
 * placeholder is a *state of the interface* — there is no row behind it, no
 * storage object, no title to approve. Creating empty rows so the grid looks
 * full would put unreviewable records into the table that publishes products,
 * and the next "approve everything" would approve them.
 */

/** What each subtype is for, and the shape it should be. Stated, not implied. */
const SUBTYPE_SPEC: Record<string, { label: string; size: string }> = {
  WHITE_BACKGROUND: { label: "White background", size: "square, 2000 px or larger" },
  LIFESTYLE: { label: "Lifestyle", size: "landscape or square, 1600 px or larger" },
  PRODUCT_DEMO: { label: "Product demo", size: "16:9, up to 200 MB" },
  LIFESTYLE_VIDEO: { label: "Lifestyle video", size: "16:9, up to 200 MB" },
  SOCIAL_CLIP_VERTICAL: { label: "Social clip", size: "9:16 — 1080 × 1920" },
  SOCIAL_CLIP_SQUARE: { label: "Social clip", size: "1:1 — 1080 × 1080" },
  SQUARE_POST: { label: "Square post", size: "1080 × 1080" },
  STORY_REEL: { label: "Story / reel", size: "1080 × 1920" },
  BANNER: { label: "Banner", size: "1600 × 600" },
  LANDSCAPE_AD: { label: "Landscape ad", size: "1200 × 628" },
  SOCIAL_VIDEO: { label: "Social video", size: "1:1 or 9:16" },
  EDITABLE_TEMPLATE: { label: "Editable template", size: "link to a design file" },
  CARE_GUIDE: { label: "Care guide", size: "PDF" },
  SPECIFICATION_SHEET: { label: "Specification sheet", size: "PDF" },
  WARRANTY: { label: "Warranty", size: "PDF" },
  CERTIFICATION: { label: "Certification", size: "PDF" },
  PACKAGING_INSTRUCTIONS: { label: "Packaging instructions", size: "PDF" },
  MARKETING_PDF: { label: "Marketing PDF", size: "PDF" },
  OTHER_DOCUMENT: { label: "Other document", size: "PDF" },
};

const IMAGE_CATEGORIES = ["WHITE_BACKGROUND_IMAGE", "LIFESTYLE_IMAGE"];

const CATEGORY_LABELS: Record<string, string> = {
  WHITE_BACKGROUND_IMAGE: "Product image — white background",
  LIFESTYLE_IMAGE: "Product image — lifestyle",
  PRODUCT_VIDEO: "Product video",
  MARKETING_CREATIVE: "Marketing creative",
  EDITABLE_TEMPLATE: "Editable template",
};

/** The subtypes that belong to each category, in the order they are offered. */
const CATEGORY_SUBTYPES: Record<string, string[]> = {
  WHITE_BACKGROUND_IMAGE: ["WHITE_BACKGROUND"],
  LIFESTYLE_IMAGE: ["LIFESTYLE"],
  PRODUCT_VIDEO: ["PRODUCT_DEMO", "LIFESTYLE_VIDEO", "SOCIAL_CLIP_VERTICAL", "SOCIAL_CLIP_SQUARE"],
  MARKETING_CREATIVE: ["SQUARE_POST", "STORY_REEL", "BANNER", "LANDSCAPE_AD", "SOCIAL_VIDEO"],
  EDITABLE_TEMPLATE: ["EDITABLE_TEMPLATE"],
};

interface VariantRef {
  id: string;
  name: string;
  sku: string;
  isActive: boolean;
}

interface Product {
  id: string;
  name: string;
  currency: string;
  variants: VariantRef[];
}

export default function MediaTab({
  product,
  media,
}: {
  product: Product;
  media: MediaAssetView[];
}) {
  const [params] = useSearchParams();
  const editing = params.get("asset") ?? "";

  const images = media.filter((asset) => IMAGE_CATEGORIES.includes(asset.category));
  const videos = media.filter((asset) => asset.category === "PRODUCT_VIDEO");
  const others = media.filter(
    (asset) => !IMAGE_CATEGORIES.includes(asset.category) && asset.category !== "PRODUCT_VIDEO"
  );

  return (
    <>
      <CoveragePanel product={product} media={media} />

      <UploadPanel product={product} />

      <Group
        title="Product images"
        note="The photographs a seller sees. A white-background image is required before the product can be published."
        assets={images}
        product={product}
        editing={editing}
        emptyText="No product images yet. Upload a white-background photograph of the product."
      />

      <Group
        title="Product video"
        note="Optional. A video whose length could not be measured stays in Processing until someone confirms it, rather than being treated as reviewed."
        assets={videos}
        product={product}
        editing={editing}
        emptyText="No video yet."
      />

      <Group
        title="Marketing creatives and templates"
        note="Assets for the seller's own marketing. A template is a link, not a file — there are no bytes to store."
        assets={others}
        product={product}
        editing={editing}
        emptyText="No marketing creatives yet."
      />

      {media.length === 0 ? null : (
        <p style={{ ...helpText, textAlign: "center" }}>
          {media.length} asset{media.length === 1 ? "" : "s"} on this product &middot;{" "}
          <Link to="?tab=documents" style={{ color: INK }}>
            Documents
          </Link>
        </p>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Which variant has what                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The gap report.
 *
 * With shared assets it is entirely possible to publish a product where one
 * size has photographs and another has none, and nothing would say so. This
 * panel exists to make that visible — including the honest case where the
 * product has no variants yet and the question does not apply.
 */
function CoveragePanel({ product, media }: { product: Product; media: MediaAssetView[] }) {
  const shared = media.filter(
    (asset) => asset.assignments.some((assignment) => assignment.variantId === null)
  );

  /**
   * What each variant would actually show.
   *
   * Own images come before shared ones, and within each the merchant's order
   * decides — the same rule the catalogue uses to build a gallery, expressed
   * here so this panel reports what will be seen rather than what is merely
   * attached.
   */
  const rows = product.variants.map((variant) => {
    const images = media.filter((asset) => IMAGE_CATEGORIES.includes(asset.category));
    const own = images
      .map((asset) => ({ asset, assignment: asset.assignments.find((a) => a.variantId === variant.id) }))
      .filter((row): row is { asset: MediaAssetView; assignment: NonNullable<typeof row.assignment> } =>
        Boolean(row.assignment)
      )
      .sort((a, b) => a.assignment.sortOrder - b.assignment.sortOrder);
    const inherited = images
      .map((asset) => ({ asset, assignment: asset.assignments.find((a) => a.variantId === null) }))
      .filter((row): row is { asset: MediaAssetView; assignment: NonNullable<typeof row.assignment> } =>
        Boolean(row.assignment)
      )
      .sort((a, b) => a.assignment.sortOrder - b.assignment.sortOrder);

    const shown = own[0] ?? inherited[0] ?? null;
    return {
      variant,
      count: own.length + inherited.length,
      ownCount: own.length,
      shown,
      source: own[0] ? ("own" as const) : inherited[0] ? ("shared" as const) : null,
    };
  });

  const uncovered = rows.filter((row) => !row.shown);

  return (
    <div style={card}>
      <h2 style={sectionTitle}>Coverage</h2>
      <p style={sectionNote}>
        A file is stored once and attached where it applies. An image attached to the whole
        product is shared, and every variant shows it without a second copy of the file.
      </p>

      {product.variants.length === 0 ? (
        <EmptyState>
          This product has no variants yet, so there is nothing for an image to apply to.
        </EmptyState>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
              gap: "0.6rem",
              marginBottom: "0.75rem",
            }}
          >
            {rows.map((row) =>
              row.shown ? (
                <div key={row.variant.id}>
                  <img
                    src={row.shown.asset.url}
                    alt={row.shown.asset.altText ?? row.shown.asset.title}
                    style={{
                      width: "100%",
                      height: 110,
                      objectFit: "cover",
                      borderRadius: 8,
                      border: `1px solid ${LINE}`,
                    }}
                  />
                  <div style={{ fontSize: "0.7rem", color: INK, marginTop: "0.25rem" }}>
                    {row.variant.name}
                  </div>
                  <div style={{ fontSize: "0.66rem", color: FAINT }}>
                    {row.count} image{row.count === 1 ? "" : "s"}
                    {row.source === "shared" ? " (shared)" : row.ownCount ? " (own)" : ""}
                  </div>
                </div>
              ) : (
                <PlaceholderTile key={row.variant.id} variantName={row.variant.name} />
              )
            )}
          </div>

          {uncovered.length ? (
            <p style={{ ...helpText, color: "#92400e" }}>
              {uncovered.map((row) => row.variant.name).join(", ")} would appear to a seller with
              no picture. The tiles above are drawn by this screen — there is no media row behind
              a missing image, and adding one would put an unreviewable record into the set that
              publication is decided from.
            </p>
          ) : (
            <p style={{ ...helpText }}>
              {shared.length} asset{shared.length === 1 ? "" : "s"} shared across the whole
              product; every active variant shows a picture.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

function UploadPanel({ product }: { product: Product }) {
  const [params] = useSearchParams();
  const scope = params.get("scope") ?? "shared";

  return (
    <div style={card}>
      <h2 style={sectionTitle}>Upload</h2>
      <p style={sectionNote}>
        The product must be saved before a file can be attached to it, which it already is on
        this screen. Choose the file, then choose what it applies to.
      </p>

      <Form method="post" encType="multipart/form-data">
        <input type="hidden" name="tab" value="media" />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.85rem" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field id="m-file" label="File" hint="Images up to 20 MB, PDFs up to 25 MB, video up to 200 MB.">
              <input
                style={input}
                id="m-file"
                name="file"
                type="file"
                required
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,video/mp4,video/webm"
              />
            </Field>
          </div>

          <Field id="m-category" label="Category">
            <select style={input} id="m-category" name="category" defaultValue="WHITE_BACKGROUND_IMAGE">
              {Object.entries(CATEGORY_LABELS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="m-subtype"
            label="Subtype"
            hint="Leave blank and the category decides. The subtype states the shape the asset should be."
          >
            <select style={input} id="m-subtype" name="subtype" defaultValue="">
              <option value="">Decide from the category</option>
              {Object.entries(SUBTYPE_SPEC)
                .filter(([key]) =>
                  Object.values(CATEGORY_SUBTYPES).some((list) => list.includes(key))
                )
                .map(([value, spec]) => (
                  <option key={value} value={value}>
                    {spec.label} — {spec.size}
                  </option>
                ))}
            </select>
          </Field>

          <Field id="m-title" label="Title">
            <input style={input} id="m-title" name="title" placeholder="Cooling pillow, front" />
          </Field>

          <Field
            id="m-alt"
            label="Alt text"
            hint="Required before an image can be published. Describe what the picture shows."
          >
            <input style={input} id="m-alt" name="altText" />
          </Field>
        </div>

        <fieldset
          style={{
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            padding: "0.75rem",
            marginTop: "0.85rem",
          }}
        >
          <legend style={{ fontSize: "0.72rem", color: MUTED, padding: "0 0.35rem" }}>
            Applies to
          </legend>
          <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.4rem" }}>
            <input type="radio" name="scopeMode" value="shared" defaultChecked={scope !== "variant"} />{" "}
            The whole product — one copy of the file, shown for every variant
          </label>
          <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            <input type="radio" name="scopeMode" value="variant" defaultChecked={scope === "variant"} />{" "}
            Selected variants
          </label>

          {product.variants.length ? (
            <div style={{ display: "flex", gap: "0.85rem", flexWrap: "wrap", paddingLeft: "1.4rem" }}>
              {product.variants
                .filter((variant) => variant.isActive)
                .map((variant) => (
                  <label key={variant.id} style={{ fontSize: "0.78rem", color: MUTED }}>
                    <input type="checkbox" name="scopeVariantIds" value={variant.id} /> {variant.name}
                  </label>
                ))}
            </div>
          ) : (
            <p style={{ ...helpText, paddingLeft: "1.4rem" }}>
              There are no variants to attach to yet, so this will be shared.
            </p>
          )}
        </fieldset>

        <div style={{ marginTop: "0.85rem" }}>
          <button type="submit" name="intent" value="media_upload" style={btn(INK, { solid: true })}>
            Upload
          </button>
        </div>
      </Form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Groups                                                                     */
/* -------------------------------------------------------------------------- */

function Group({
  title,
  note,
  assets,
  product,
  editing,
  emptyText,
}: {
  title: string;
  note: string;
  assets: MediaAssetView[];
  product: Product;
  editing: string;
  emptyText: string;
}) {
  return (
    <div style={card}>
      <h2 style={sectionTitle}>{title}</h2>
      <p style={sectionNote}>{note}</p>

      {assets.length === 0 ? (
        <EmptyState>{emptyText}</EmptyState>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
            gap: "0.85rem",
          }}
        >
          {assets.map((asset) =>
            editing === asset.id ? (
              <AssetEditor key={asset.id} asset={asset} product={product} />
            ) : (
              <AssetTile key={asset.id} asset={asset} product={product} />
            )
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A placeholder tile: a state of the interface, with no row behind it.
 *
 * Nothing is written to the database to make this appear. A row would be an
 * asset like any other — it would carry an approval status, count towards the
 * media totals, and be eligible for "approve everything", which is exactly what
 * must not happen to a picture that does not exist.
 */
function PlaceholderTile({ variantName }: { variantName: string }) {
  return (
    <div>
      <div
        style={{
          height: 110,
          border: `1px dashed ${LINE}`,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: FAINT,
          fontSize: "0.7rem",
          textAlign: "center",
          padding: "0.5rem",
          background: "#f8fafc",
        }}
      >
        No image
      </div>
      <div style={{ fontSize: "0.7rem", color: INK, marginTop: "0.25rem" }}>{variantName}</div>
      <div style={{ fontSize: "0.66rem", color: "#92400e" }}>nothing to show</div>
    </div>
  );
}

function AssetTile({ asset, product }: { asset: MediaAssetView; product: Product }) {
  const isPdf = asset.mimeType === "application/pdf";
  const isVideo = asset.category === "PRODUCT_VIDEO";
  const assignmentLabel = describeAssignments(asset, product);
  const legacy = asset.isLegacy;

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: "hidden", background: "white" }}>
      <div
        style={{
          height: 150,
          background: "#f8fafc",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {isVideo ? (
          <video
            src={asset.url}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            // Not autoPlayed: a grid of playing video is unreadable and would
            // fetch every stored byte on page load.
            controls
            preload="metadata"
          />
        ) : isPdf ? (
          <span style={{ color: MUTED, fontSize: "0.75rem" }}>PDF document</span>
        ) : (
          <img
            src={asset.url}
            alt={asset.altText ?? asset.title}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
        {legacy ? (
          <span
            style={{
              position: "absolute",
              top: 4,
              left: 4,
              background: "#fef3c7",
              color: "#92400e",
              fontSize: "0.6rem",
              padding: "0.1rem 0.3rem",
              borderRadius: 3,
            }}
          >
            legacy
          </span>
        ) : null}
      </div>

      <div style={{ padding: "0.6rem" }}>
        <div style={{ fontSize: "0.8rem", fontWeight: 600, color: INK, marginBottom: "0.25rem" }}>
          {asset.title}
        </div>
        <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
          <StatusChip status={asset.processingStatus} />
          <StatusChip status={asset.approvalStatus} />
          {!asset.sellerVisible ? <StatusChip status="INACTIVE" /> : null}
        </div>

        <div style={{ fontSize: "0.68rem", color: FAINT, lineHeight: 1.5 }}>
          {asset.width && asset.height ? (
            <>
              {asset.width} × {asset.height}
              {asset.aspectRatio ? ` (${asset.aspectRatio})` : ""}
              <br />
            </>
          ) : null}
          {isVideo ? (
            <>
              {duration(asset.durationSeconds)}
              <br />
            </>
          ) : null}
          {fileSize(asset.fileSize)}
          <br />
          {assignmentLabel}
        </div>

        {asset.subtype && SUBTYPE_SPEC[asset.subtype] ? (
          <div style={{ fontSize: "0.68rem", color: FAINT, marginTop: "0.2rem" }}>
            {SUBTYPE_SPEC[asset.subtype].label} — {SUBTYPE_SPEC[asset.subtype].size}
          </div>
        ) : null}

        {!asset.altText && IMAGE_CATEGORIES.includes(asset.category) ? (
          <div style={{ fontSize: "0.68rem", color: "#92400e", marginTop: "0.3rem" }}>
            No alt text — this image cannot be published.
          </div>
        ) : null}

        <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          <Link
            to={`?tab=media&asset=${encodeURIComponent(asset.id)}`}
            style={{ ...btn(MUTED), padding: "0.25rem 0.5rem" }}
          >
            Edit
          </Link>
          {asset.approvalStatus !== "APPROVED" ? (
            <Form method="post">
              <input type="hidden" name="tab" value="media" />
              <input type="hidden" name="assetId" value={asset.id} />
              <button
                type="submit"
                name="intent"
                value="media_approve"
                style={{ ...btn("#065f46"), padding: "0.25rem 0.5rem" }}
              >
                Approve
              </button>
            </Form>
          ) : null}
          {asset.approvalStatus !== "REJECTED" ? (
            <Form method="post">
              <input type="hidden" name="tab" value="media" />
              <input type="hidden" name="assetId" value={asset.id} />
              <button
                type="submit"
                name="intent"
                value="media_reject"
                style={{ ...btn("#92400e"), padding: "0.25rem 0.5rem" }}
              >
                Reject
              </button>
            </Form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** "Shared", or the names of the variants it is attached to. */
function describeAssignments(asset: MediaAssetView, product: Product): string {
  if (asset.assignments.length === 0) return "Attached to nothing — not visible";
  const shared = asset.assignments.some((assignment) => assignment.variantId === null);
  const names = asset.assignments
    .map((assignment) =>
      assignment.variantId
        ? product.variants.find((variant) => variant.id === assignment.variantId)?.name ?? "a removed variant"
        : null
    )
    .filter((name): name is string => Boolean(name));

  if (shared && names.length === 0) return "Shared with every variant";
  if (shared) return `Shared, plus ${names.join(", ")}`;
  return names.join(", ");
}

/* -------------------------------------------------------------------------- */
/* Per-asset editor                                                           */
/* -------------------------------------------------------------------------- */

function AssetEditor({
  asset,
  product,
}: {
  asset: MediaAssetView;
  product: Product;
}) {
  const attachedIds = new Set(
    asset.assignments
      .map((assignment) => assignment.variantId)
      .filter((id): id is string => Boolean(id))
  );
  const isShared = asset.assignments.some((assignment) => assignment.variantId === null);

  return (
    <div style={{ border: `2px solid ${INK}`, borderRadius: 10, padding: "0.75rem", gridColumn: "1 / -1" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
        <h3 style={{ ...sectionTitle, marginBottom: 0 }}>{asset.title}</h3>
        <Link to="?tab=media" style={{ fontSize: "0.72rem", color: MUTED }}>
          Done
        </Link>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
        <div style={{ width: 160 }}>
          {asset.category === "PRODUCT_VIDEO" ? (
            <video src={asset.url} style={{ width: "100%", borderRadius: 8 }} controls preload="metadata" />
          ) : asset.mimeType === "application/pdf" ? (
            <div style={{ ...helpText }}>PDF</div>
          ) : (
            <img
              src={asset.url}
              alt={asset.altText ?? asset.title}
              style={{ width: "100%", borderRadius: 8 }}
            />
          )}
          <div style={{ fontSize: "0.68rem", color: FAINT, marginTop: "0.35rem" }}>
            {asset.originalFilename}
            <br />
            {asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ""}
            {fileSize(asset.fileSize)}
            {asset.category === "PRODUCT_VIDEO" ? ` · ${duration(asset.durationSeconds)}` : ""}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 280 }}>
          <Form method="post">
            <input type="hidden" name="tab" value="media" />
            <input type="hidden" name="assetId" value={asset.id} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
              <Field id={`a-title-${asset.id}`} label="Title">
                <input style={input} id={`a-title-${asset.id}`} name="title" defaultValue={asset.title} />
              </Field>

              <Field
                id={`a-alt-${asset.id}`}
                label="Alt text"
                hint={
                  IMAGE_CATEGORIES.includes(asset.category)
                    ? "Required before publication."
                    : "Used where the asset is described."
                }
              >
                <input style={input} id={`a-alt-${asset.id}`} name="altText" defaultValue={asset.altText ?? ""} />
              </Field>

              <Field id={`a-subtype-${asset.id}`} label="Subtype">
                <select style={input} id={`a-subtype-${asset.id}`} name="subtype" defaultValue={asset.subtype ?? ""}>
                  <option value="">None</option>
                  {Object.entries(SUBTYPE_SPEC).map(([value, spec]) => (
                    <option key={value} value={value}>
                      {spec.label} — {spec.size}
                    </option>
                  ))}
                </select>
              </Field>

              <Field id={`a-visible-${asset.id}`} label="Visible to sellers">
                <select
                  style={input}
                  id={`a-visible-${asset.id}`}
                  name="sellerVisible"
                  defaultValue={asset.sellerVisible ? "true" : "false"}
                >
                  <option value="false">No — internal only</option>
                  <option value="true">Yes — include in the seller's kit</option>
                </select>
              </Field>
            </div>

            <div style={{ marginTop: "0.6rem" }}>
              <button type="submit" name="intent" value="media_update" style={btn(INK, { solid: true })}>
                Save
              </button>
            </div>
          </Form>

          <Form method="post" style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
            <input type="hidden" name="tab" value="media" />
            <input type="hidden" name="assetId" value={asset.id} />

            <div style={{ fontSize: "0.72rem", color: MUTED, marginBottom: "0.4rem" }}>
              Applies to
            </div>
            <label style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
              <input type="checkbox" name="scopeVariantIds" value="" defaultChecked={isShared} /> The
              whole product
            </label>
            {product.variants.map((variant) => (
              <label key={variant.id} style={{ display: "block", fontSize: "0.78rem" }}>
                <input
                  type="checkbox"
                  name="scopeVariantIds"
                  value={variant.id}
                  defaultChecked={attachedIds.has(variant.id)}
                />{" "}
                {variant.name}
              </label>
            ))}
            <div style={{ marginTop: "0.5rem" }}>
              <button type="submit" name="intent" value="media_attach" style={btn(MUTED)}>
                Update attachments
              </button>
            </div>
          </Form>
        </div>
      </div>

      <AssetAssignments asset={asset} product={product} />
    </div>
  );
}

/**
 * Where the file is attached, with the ordering controls.
 *
 * Order matters: the first attachment in a scope is the one the catalogue shows
 * first, so "move up" is not cosmetic here.
 */
function AssetAssignments({ asset, product }: { asset: MediaAssetView; product: Product }) {
  return (
    <div style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
      <div style={{ fontSize: "0.72rem", color: MUTED, marginBottom: "0.4rem" }}>
        Attachments ({asset.assignments.length})
      </div>

      {asset.assignments.length === 0 ? (
        <p style={{ ...helpText }}>
          This file is not attached anywhere, so no seller will see it. Attach it above.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "0.78rem" }}>
          {asset.assignments.map((assignment) => (
            <li
              key={assignment.id}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.25rem 0" }}
            >
              <span style={{ minWidth: 140 }}>
                {assignment.variantId
                  ? product.variants.find((variant) => variant.id === assignment.variantId)?.name ??
                    "a removed variant"
                  : "Whole product"}
              </span>
              {assignment.isPrimary ? <StatusChip status="DEFAULT" /> : null}
              <span style={{ color: FAINT }}>#{assignment.sortOrder + 1}</span>

              <Form method="post">
                <input type="hidden" name="tab" value="media" />
                <input type="hidden" name="assignmentId" value={assignment.id} />
                <button type="submit" name="intent" value="media_move_up" style={{ ...btn(MUTED), padding: "0.15rem 0.4rem" }}>
                  ↑
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="tab" value="media" />
                <input type="hidden" name="assignmentId" value={assignment.id} />
                <button type="submit" name="intent" value="media_move_down" style={{ ...btn(MUTED), padding: "0.15rem 0.4rem" }}>
                  ↓
                </button>
              </Form>
              {!assignment.isPrimary ? (
                <Form method="post">
                  <input type="hidden" name="tab" value="media" />
                  <input type="hidden" name="assignmentId" value={assignment.id} />
                  <button type="submit" name="intent" value="media_primary" style={{ ...btn(MUTED), padding: "0.15rem 0.4rem" }}>
                    Make primary
                  </button>
                </Form>
              ) : null}
              <Form method="post">
                <input type="hidden" name="tab" value="media" />
                <input type="hidden" name="assignmentId" value={assignment.id} />
                <button type="submit" name="intent" value="media_detach" style={{ ...btn("#92400e"), padding: "0.15rem 0.4rem" }}>
                  Detach
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: "0.6rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
        <ConfirmForm
          intent="media_delete"
          fields={{ tab: "media", assetId: asset.id }}
          label="Delete this file"
          confirmLabel="Delete"
          question="Delete this file? Variants showing it lose it."
        />
        {asset.isLegacy ? (
          <span style={{ ...helpText, display: "inline-block", marginLeft: "0.6rem" }}>
            This file predates the upload pipeline and lives at its original address; deleting
            the record does not delete it there.
          </span>
        ) : null}
      </div>
    </div>
  );
}
