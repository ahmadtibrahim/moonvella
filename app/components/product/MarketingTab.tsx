import { Link, Form, useSearchParams } from "react-router";
import type { MediaAssetView } from "~/services/media.server";
import type { PackPreview } from "~/services/marketingPack.server";
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
  INK,
  MUTED,
  FAINT,
  LINE,
  helpText,
} from "./ui";

/**
 * Marketing Kit — the material a seller uses to sell the product themselves,
 * and a statement of exactly what they will and will not receive.
 *
 * THE PACK IS AN ALLOWLIST, AND THIS TAB SHOWS IT. Everything a seller downloads
 * is listed on this screen before it leaves the building: the files, the folders
 * they land in, the template links, and — with reasons — what was left out. The
 * alternative, a button that produces a ZIP nobody can inspect, means the first
 * person to notice an internal figure in a customer download is the customer.
 *
 * WHAT IS NEVER IN A PACK. Acquisition cost and supplier terms; wholesale price;
 * internal object keys and filesystem paths; anything unapproved, invisible or
 * still processing; and any other seller's records. Most of that is enforced by
 * the query rather than by a filter — the pack loads named columns and nothing
 * else, so a field added to the database tomorrow is absent from the pack until
 * somebody adds it on purpose.
 */

const CREATIVE_SUBTYPES = ["SQUARE_POST", "STORY_REEL", "BANNER", "LANDSCAPE_AD", "SOCIAL_VIDEO"] as const;

const SUBTYPE_LABELS: Record<string, string> = {
  SQUARE_POST: "Square post — 1080 × 1080",
  STORY_REEL: "Story / reel — 1080 × 1920",
  BANNER: "Banner — 1600 × 600",
  LANDSCAPE_AD: "Landscape ad — 1200 × 628",
  SOCIAL_VIDEO: "Social video — 1:1 or 9:16",
  EDITABLE_TEMPLATE: "Editable template",
};

interface VariantRef {
  id: string;
  name: string;
  isActive: boolean;
}

interface Product {
  id: string;
  name: string;
  productCode: string;
  currency: string;
  variants: VariantRef[];
}

export default function MarketingTab({
  product,
  media,
  pack,
}: {
  product: Product;
  media: MediaAssetView[];
  pack: PackPreview | null;
}) {
  const [params] = useSearchParams();
  const editing = params.get("creative") ?? "";

  const creatives = media.filter((asset) => asset.category === "MARKETING_CREATIVE");
  const templates = media.filter((asset) => asset.category === "EDITABLE_TEMPLATE");

  return (
    <>
      <PackPanel product={product} pack={pack} />

      <CreativeGroup
        title="Marketing creatives"
        note="Finished artwork a seller can post as it is. Uploaded at the size it should be used, and included in the pack for the whole product rather than for one variant."
        product={product}
        assets={creatives}
        editing={editing}
        category="MARKETING_CREATIVE"
        subtypes={CREATIVE_SUBTYPES}
        emptyText="No creatives yet."
      />

      <CreativeGroup
        title="Editable templates"
        note="A design a seller adapts in their own tool. These are links rather than files — there are no bytes to store, so the pack lists the address instead of a download."
        product={product}
        assets={templates}
        editing={editing}
        category="EDITABLE_TEMPLATE"
        subtypes={["EDITABLE_TEMPLATE"]}
        emptyText="No templates yet."
      />

      <div style={card}>
        <h2 style={sectionTitle}>Seller branding</h2>
        <p style={sectionNote}>
          Nothing on this product is specific to one seller today. Everything here is MoonVella's
          own material, and the manifest names MoonVella as the brand.
        </p>
        <p style={{ ...helpText }}>
          When sellers are given their own branding, it belongs at the point the pack is built for
          that seller — their logo, their contact block and their own price sheet — not on the
          product, which is shared. The manifest's brand block is the single place that would
          change, which is why it is a named field rather than interpolated text.
        </p>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The pack                                                                   */
/* -------------------------------------------------------------------------- */

function PackPanel({ product, pack }: { product: Product; pack: PackPreview | null }) {
  if (!pack) {
    return (
      <div style={card}>
        <h2 style={sectionTitle}>Marketing pack</h2>
        <EmptyState>
          This product could not be read, so its pack cannot be described. Reload the page.
        </EmptyState>
      </div>
    );
  }

  const folders = [...new Set(pack.files.map((file) => file.folder ?? "Other"))].sort();

  return (
    <div style={card}>
      <h2 style={sectionTitle}>Marketing pack</h2>
      <p style={sectionNote}>
        What an approved seller receives when they download this product's pack: one ZIP, one
        folder named after the product code, and a contents page inside it.
      </p>

      <div style={{ fontSize: "0.8rem", color: INK, marginBottom: "0.25rem" }}>
        <code>{pack.filename}</code>
      </div>
      <div style={{ fontSize: "0.72rem", color: MUTED, marginBottom: "0.6rem" }}>
        {pack.files.length} file{pack.files.length === 1 ? "" : "s"} ({fileSize(pack.totalBytes)})
        {pack.links.length ? `, ${pack.links.length} template link${pack.links.length === 1 ? "" : "s"}` : ""}
        {pack.excluded.length ? `, ${pack.excluded.length} asset${pack.excluded.length === 1 ? "" : "s"} left out` : ""}
      </div>

      {!pack.downloadable ? (
        <p style={{ ...helpText, color: "#92400e" }}>
          This product is not published, so a seller cannot download anything yet. The list below
          is what the pack will contain once it is published.
        </p>
      ) : null}

      {pack.files.length === 0 && pack.links.length === 0 ? (
        <EmptyState>
          The pack would be empty. Rather than send a seller an empty archive, the download is
          refused until there is something in it — approve and mark some media as visible to
          sellers on the Media tab.
        </EmptyState>
      ) : (
        <div style={{ marginTop: "0.5rem" }}>
          {folders.map((folder) => (
            <div key={folder} style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontSize: "0.75rem", fontWeight: 600, color: INK }}>
                <code>{folder}/</code>
              </div>
              <ul style={{ margin: "0.15rem 0 0", paddingLeft: "1.1rem", fontSize: "0.75rem", color: MUTED, lineHeight: 1.7 }}>
                {pack.files
                  .filter((file) => (file.folder ?? "Other") === folder)
                  .map((file) => (
                    <li key={`${folder}:${file.title}`}>
                      {file.title} <span style={{ color: FAINT }}>({fileSize(file.bytes)})</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}

          {pack.links.length ? (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontSize: "0.75rem", fontWeight: 600, color: INK }}>
                <code>Marketing/Templates/</code> — links, listed in the manifest
              </div>
              <ul style={{ margin: "0.15rem 0 0", paddingLeft: "1.1rem", fontSize: "0.75rem", color: MUTED, lineHeight: 1.7 }}>
                {pack.links.map((link) => (
                  <li key={`link:${link.title}`}>
                    {link.title} <span style={{ color: FAINT }}>({link.link})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      {pack.excluded.length ? (
        <details style={{ marginTop: "0.6rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
          <summary style={{ fontSize: "0.75rem", color: MUTED, cursor: "pointer" }}>
            {pack.excluded.length} asset{pack.excluded.length === 1 ? "" : "s"} not in the pack
          </summary>
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.72rem", color: MUTED, lineHeight: 1.7 }}>
            {pack.excluded.map((item, index) => (
              <li key={`${item.title}:${index}`}>
                {item.title} — {item.reason}
              </li>
            ))}
          </ul>
          <p style={{ ...helpText }}>
            A seller never sees this list; it is here so "why is that video missing" has an answer
            that is not a guess.
          </p>
        </details>
      ) : null}

      <div style={{ marginTop: "0.7rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 600, color: INK, marginBottom: "0.3rem" }}>
          Never included
        </div>
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.72rem", color: MUTED, lineHeight: 1.7 }}>
          <li>Acquisition cost, supplier terms and wholesale price</li>
          <li>Internal reference numbers, storage keys and filesystem paths</li>
          <li>Assets that are unapproved, invisible to sellers, or still processing</li>
          <li>Superseded document versions</li>
          <li>Anything belonging to another seller</li>
        </ul>
        <p style={{ ...helpText }}>
          These are not filtered out on the way to the archive. The pack loads named columns and
          nothing else, so a field added to the database later is absent from a seller's download
          until somebody adds it deliberately.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Creatives and templates                                                    */
/* -------------------------------------------------------------------------- */

function CreativeGroup({
  title,
  note,
  product,
  assets,
  editing,
  category,
  subtypes,
  emptyText,
}: {
  title: string;
  note: string;
  product: Product;
  assets: MediaAssetView[];
  editing: string;
  category: string;
  subtypes: readonly string[];
  emptyText: string;
}) {
  const isTemplate = category === "EDITABLE_TEMPLATE";

  return (
    <div style={card}>
      <h2 style={sectionTitle}>{title}</h2>
      <p style={sectionNote}>{note}</p>

      {assets.length ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
            gap: "0.75rem",
            marginBottom: "0.85rem",
          }}
        >
          {assets.map((asset) =>
            editing === asset.id ? (
              <CreativeEditor key={asset.id} asset={asset} subtypes={subtypes} />
            ) : (
              <CreativeTile key={asset.id} asset={asset} />
            )
          )}
        </div>
      ) : (
        <EmptyState>{emptyText}</EmptyState>
      )}

      <details style={{ borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
        <summary style={{ fontSize: "0.78rem", fontWeight: 600, color: INK, cursor: "pointer" }}>
          Add {isTemplate ? "a template" : "a creative"}
        </summary>

        <Form method="post" encType="multipart/form-data" style={{ marginTop: "0.6rem" }}>
          <input type="hidden" name="tab" value="marketing" />
          <input type="hidden" name="category" value={category} />
          {isTemplate ? null : <input type="hidden" name="scopeMode" value="shared" />}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
            {isTemplate ? null : (
              <div style={{ gridColumn: "1 / -1" }}>
                <Field id={`mk-file-${category}`} label="File" hint="Images up to 20 MB, video up to 200 MB.">
                  <input
                    style={input}
                    id={`mk-file-${category}`}
                    name="file"
                    type="file"
                    required
                    accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
                  />
                </Field>
              </div>
            )}

            <Field
              id={`mk-subtype-${category}`}
              label="Format"
              hint="Recorded so the seller knows where the asset is meant to be used."
            >
              <select style={input} id={`mk-subtype-${category}`} name="subtype" defaultValue={subtypes[0]}>
                {subtypes.map((subtype) => (
                  <option key={subtype} value={subtype}>
                    {SUBTYPE_LABELS[subtype] ?? subtype}
                  </option>
                ))}
              </select>
            </Field>

            <Field id={`mk-title-${category}`} label="Title">
              <input
                style={input}
                id={`mk-title-${category}`}
                name="title"
                placeholder={isTemplate ? "Instagram story template" : "Summer campaign, square"}
              />
            </Field>

            {isTemplate ? (
              <Field
                id={`mk-url-${category}`}
                label="Template link"
                hint="Where the seller copies the design from. Only http and https links are accepted."
              >
                <input style={input} id={`mk-url-${category}`} name="templateUrl" type="url" required />
              </Field>
            ) : null}

            <Field
              id={`mk-instructions-${category}`}
              label="Instructions"
              hint="Shown to the seller next to the asset, and in the pack manifest."
            >
              <input style={input} id={`mk-instructions-${category}`} name="instructions" />
            </Field>
          </div>

          <div style={{ marginTop: "0.7rem" }}>
            <button type="submit" name="intent" value="media_upload" style={btn(INK, { solid: true })}>
              Upload
            </button>
          </div>
        </Form>
      </details>
    </div>
  );
}

function CreativeTile({ asset }: { asset: MediaAssetView }) {
  const isLink = asset.category === "EDITABLE_TEMPLATE";

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: "hidden", background: "white" }}>
      <div
        style={{
          height: 120,
          background: "#f8fafc",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {isLink ? (
          <span style={{ fontSize: "0.72rem", color: MUTED, padding: "0.5rem", textAlign: "center" }}>
            Link only
          </span>
        ) : asset.mimeType.startsWith("video/") ? (
          <video
            src={asset.url}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            controls
            preload="metadata"
          >
            {/* Declared, empty: the merchant's own working file, with no
                captions to ship and no player that could show them. */}
            <track kind="captions" />
          </video>
        ) : (
          <img
            src={asset.url}
            alt={asset.altText ?? asset.title}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
      </div>

      <div style={{ padding: "0.55rem" }}>
        <div style={{ fontSize: "0.78rem", fontWeight: 600, color: INK }}>{asset.title}</div>
        <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", margin: "0.35rem 0" }}>
          <StatusChip status={asset.approvalStatus} />
          {!asset.sellerVisible ? <StatusChip status="INACTIVE" /> : null}
        </div>
        <div style={{ fontSize: "0.68rem", color: FAINT, lineHeight: 1.5 }}>
          {asset.subtype && SUBTYPE_LABELS[asset.subtype] ? SUBTYPE_LABELS[asset.subtype] : "no format recorded"}
          {isLink ? null : (
            <>
              <br />
              {asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ""}
              {fileSize(asset.fileSize)}
            </>
          )}
        </div>
        {asset.instructions ? (
          <div style={{ fontSize: "0.68rem", color: MUTED, marginTop: "0.3rem" }}>{asset.instructions}</div>
        ) : null}

        <div style={{ display: "flex", gap: "0.3rem", marginTop: "0.5rem" }}>
          <Link to={`?tab=marketing&creative=${encodeURIComponent(asset.id)}`} style={{ ...btn(MUTED), padding: "0.25rem 0.5rem" }}>
            Edit
          </Link>
          {asset.approvalStatus !== "APPROVED" ? (
            <Form method="post">
              <input type="hidden" name="tab" value="marketing" />
              <input type="hidden" name="assetId" value={asset.id} />
              <button type="submit" name="intent" value="media_approve" style={{ ...btn("#065f46"), padding: "0.25rem 0.5rem" }}>
                Approve
              </button>
            </Form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CreativeEditor({ asset, subtypes }: { asset: MediaAssetView; subtypes: readonly string[] }) {
  return (
    <div style={{ border: `2px solid ${INK}`, borderRadius: 10, padding: "0.7rem", gridColumn: "1 / -1" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ ...sectionTitle, marginBottom: 0, fontSize: "0.85rem" }}>{asset.title}</h3>
        <Link to="?tab=marketing" style={{ fontSize: "0.72rem", color: MUTED }}>
          Done
        </Link>
      </div>

      <Form method="post" style={{ marginTop: "0.6rem" }}>
        <input type="hidden" name="tab" value="marketing" />
        <input type="hidden" name="assetId" value={asset.id} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.6rem" }}>
          <Field id={`mk-e-title-${asset.id}`} label="Title">
            <input style={input} id={`mk-e-title-${asset.id}`} name="title" defaultValue={asset.title} />
          </Field>

          <Field id={`mk-e-subtype-${asset.id}`} label="Format">
            <select style={input} id={`mk-e-subtype-${asset.id}`} name="subtype" defaultValue={asset.subtype ?? ""}>
              <option value="">No format recorded</option>
              {subtypes.map((subtype) => (
                <option key={subtype} value={subtype}>
                  {SUBTYPE_LABELS[subtype] ?? subtype}
                </option>
              ))}
            </select>
          </Field>

          {asset.category === "EDITABLE_TEMPLATE" ? (
            <Field id={`mk-e-url-${asset.id}`} label="Template link">
              <input
                style={input}
                id={`mk-e-url-${asset.id}`}
                name="templateUrl"
                type="url"
                defaultValue={asset.templateUrl ?? ""}
              />
            </Field>
          ) : null}

          <Field id={`mk-e-instructions-${asset.id}`} label="Instructions for the seller">
            <input
              style={input}
              id={`mk-e-instructions-${asset.id}`}
              name="instructions"
              defaultValue={asset.instructions ?? ""}
            />
          </Field>

          <Field
            id={`mk-e-visible-${asset.id}`}
            label="Included in the pack"
            hint="An asset that is not approved is never included, whatever this says."
          >
            <select
              style={input}
              id={`mk-e-visible-${asset.id}`}
              name="sellerVisible"
              defaultValue={asset.sellerVisible ? "true" : "false"}
            >
              <option value="true">Yes</option>
              <option value="false">No — keep it internal for now</option>
            </select>
          </Field>
        </div>

        <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <button type="submit" name="intent" value="media_update" style={btn(INK, { solid: true })}>
            Save
          </button>
        </div>
      </Form>

      <div style={{ marginTop: "0.6rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.5rem" }}>
        <ConfirmForm
          intent="media_delete"
          fields={{ tab: "marketing", assetId: asset.id }}
          label="Delete"
          confirmLabel="Delete"
          question="Delete this creative? It leaves the pack."
        />
      </div>
    </div>
  );
}
