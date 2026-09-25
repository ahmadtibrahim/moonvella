import { Link, Form, useSearchParams } from "react-router";
import type { MediaAssetView } from "~/services/media.server";
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
 * Documents — the PDFs a seller needs to sell the product.
 *
 * THREE RULES THIS SCREEN EXISTS TO KEEP.
 *
 * 1. A VERSION IS NEVER OVERWRITTEN. Replacing a document uploads a new file and
 *    points it back at the one it replaces. The old row, its bytes and its
 *    version number all survive, because "what did this seller receive in
 *    March?" is a question a version number is supposed to be able to answer,
 *    and it cannot if the March file was written over.
 *
 * 2. THE OLD VERSION STOPS BEING OFFERED. Keeping history is not the same as
 *    continuing to hand it out. Replacing a document withdraws the previous one
 *    from sellers in the same operation, so a pack can never contain two
 *    versions of the same warranty and leave the seller to guess.
 *
 * 3. A PDF IS NEVER RENDERED INSIDE THIS PAGE. There is no iframe, no embed and
 *    no object tag here: a PDF is an opaque file we store and hand over, and
 *    putting one inside our own document to be executed by the browser is a
 *    capability this application does not need. Files open in the browser's own
 *    viewer, from a link, or not at all.
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

const DOCUMENT_LABELS: Record<string, string> = {
  CARE_GUIDE: "Care guide",
  SPECIFICATION_SHEET: "Specification sheet",
  WARRANTY: "Warranty",
  CERTIFICATION: "Certification",
  PACKAGING_INSTRUCTIONS: "Packaging instructions",
  MARKETING_PDF: "Marketing PDF",
  OTHER: "Other document",
};

/**
 * The subtype that belongs to each document type.
 *
 * Two vocabularies that look alike but are separate columns: `documentType` is
 * what the document *is* to a reader, and the subtype is the slot it occupies in
 * the media model, whose list is shared with images. They are kept in step on
 * the way in so the two never disagree.
 */
const SUBTYPE_FOR_TYPE: Record<string, string> = {
  CARE_GUIDE: "CARE_GUIDE",
  SPECIFICATION_SHEET: "SPECIFICATION_SHEET",
  WARRANTY: "WARRANTY",
  CERTIFICATION: "CERTIFICATION",
  PACKAGING_INSTRUCTIONS: "PACKAGING_INSTRUCTIONS",
  MARKETING_PDF: "MARKETING_PDF",
  OTHER: "OTHER_DOCUMENT",
};

/** What each document is for, stated rather than assumed. */
const DOCUMENT_PURPOSE: Record<string, string> = {
  CARE_GUIDE: "How the customer washes, stores and uses it.",
  SPECIFICATION_SHEET: "Dimensions, materials and test results, for a retail buyer.",
  WARRANTY: "The terms the customer is promised, with the date they take effect.",
  CERTIFICATION: "Third-party certificates, test reports and compliance marks.",
  PACKAGING_INSTRUCTIONS: "How the seller packs it for the customer's order.",
  MARKETING_PDF: "A printable sheet a seller can hand to a customer.",
  OTHER: "Anything that does not fit the categories above.",
};

/** Offered as suggestions; the field stays free text because languages vary. */
const COMMON_LANGUAGES = ["en", "fr", "en-CA", "fr-CA", "es", "zh"];

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

export default function DocumentsTab({
  product,
  media,
}: {
  product: Product;
  media: MediaAssetView[];
}) {
  const [params] = useSearchParams();
  const editing = params.get("doc") ?? "";

  const documents = media.filter((asset) => asset.category === "DOCUMENT");
  const chains = buildChains(documents);
  const languages = countLanguages(documents);

  const grouped = DOCUMENT_TYPES.map((type) => ({
    type: type as string,
    label: DOCUMENT_LABELS[type],
    purpose: DOCUMENT_PURPOSE[type],
    chains: chains.filter((chain) => (chain.head.documentType ?? "OTHER") === type),
  })).filter((group) => group.chains.length > 0);

  const unclassified = chains.filter(
    (chain) => !chain.head.documentType || !DOCUMENT_TYPES.includes(chain.head.documentType as never)
  );

  return (
    <>
      <div style={card}>
        <h2 style={sectionTitle}>Documents</h2>
        <p style={sectionNote}>
          Product documents for sellers: care guides, specification sheets, warranties,
          certifications and packaging instructions. All of them PDFs.
        </p>

        {documents.length ? (
          <p style={{ ...helpText }}>
            {documents.length} document{documents.length === 1 ? "" : "s"} across{" "}
            {chains.length} title{chains.length === 1 ? "" : "s"} &middot; languages:{" "}
            {Object.entries(languages)
              .map(([code, count]) => `${code} (${count})`)
              .join(", ")}
          </p>
        ) : null}

        <ul
          style={{
            margin: "0.5rem 0 0",
            paddingLeft: "1.1rem",
            fontSize: "0.78rem",
            lineHeight: 1.7,
            color: MUTED,
          }}
        >
          <li>
            Replacing a document keeps the previous version available to staff and withdraws it
            from sellers, so a pack never offers two versions of the same warranty.
          </li>
          <li>
            A document is not published until a person reads it and approves it. A PDF cannot be
            checked automatically, so nothing here is approved for you.
          </li>
          <li>
            <strong style={{ color: INK }}>View only</strong> keeps a document visible to sellers
            as a reference but excludes it from their downloads.
          </li>
        </ul>
      </div>

      <UploadPanel product={product} />

      {documents.length === 0 ? (
        <div style={card}>
          <EmptyState>
            No documents yet. A product can be published without documents, but a warranty or a
            specification sheet is usually what a seller asks for first.
          </EmptyState>
        </div>
      ) : null}

      {grouped.map((group) => (
        <div key={group.type} style={card}>
          <h2 style={sectionTitle}>{group.label}</h2>
          <p style={sectionNote}>{group.purpose}</p>
          {group.chains.map((chain) =>
            editing === chain.head.id ? (
              <DocumentEditor key={chain.head.id} chain={chain} product={product} />
            ) : (
              <DocumentRow key={chain.head.id} chain={chain} product={product} />
            )
          )}
        </div>
      ))}

      {unclassified.length ? (
        <div style={card}>
          <h2 style={sectionTitle}>Not classified</h2>
          <p style={sectionNote}>
            These documents have no type recorded, so a seller has no way to tell what they are.
          </p>
          {unclassified.map((chain) =>
            editing === chain.head.id ? (
              <DocumentEditor key={chain.head.id} chain={chain} product={product} />
            ) : (
              <DocumentRow key={chain.head.id} chain={chain} product={product} />
            )
          )}
        </div>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Version chains                                                             */
/* -------------------------------------------------------------------------- */

interface DocChain {
  /** The newest version — the one a seller would receive. */
  head: MediaAssetView;
  /** Older versions, newest first. Never empty-content: a chain of one has none. */
  history: MediaAssetView[];
}

/**
 * Group documents into version chains.
 *
 * A chain is walked backwards from the version nothing replaces. Documents
 * whose `supersedesId` points outside the product are treated as heads rather
 * than dropped, so a broken link shows the document instead of hiding it.
 */
function buildChains(documents: MediaAssetView[]): DocChain[] {
  const byId = new Map(documents.map((document) => [document.id, document]));

  const superseded = new Set<string>();
  for (const document of documents) {
    if (document.supersedesId && byId.has(document.supersedesId)) {
      superseded.add(document.supersedesId);
    }
  }

  const heads = documents.filter((document) => !superseded.has(document.id));

  return heads.map((head) => {
    const history: MediaAssetView[] = [];
    const seen = new Set<string>([head.id]);
    let cursor = head.supersedesId;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const previous = byId.get(cursor);
      if (!previous) break;
      history.push(previous);
      cursor = previous.supersedesId;
    }
    return { head, history };
  });
}

function countLanguages(documents: MediaAssetView[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const document of documents) {
    const code = document.language?.trim() || "no language recorded";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/** A calendar date, rendered as written rather than shifted by the reader's clock. */
function formatDate(value: Date | string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Effective dates are stored at midnight UTC. Formatting in the viewer's own
  // time zone would show the day before for anyone west of Greenwich, which is
  // the kind of off-by-one that makes a warranty look like it started early.
  return date.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function dateInputValue(value: Date | string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** Whether a document is in force yet, on the day it is being looked at. */
function effectiveState(document: MediaAssetView): "none" | "future" | "current" {
  if (!document.effectiveDate) return "none";
  const date = new Date(document.effectiveDate);
  if (Number.isNaN(date.getTime())) return "none";
  const today = new Date();
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return date.getTime() > midnight ? "future" : "current";
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function DocumentRow({ chain, product }: { chain: DocChain; product: Product }) {
  const { head, history } = chain;
  const state = effectiveState(head);
  const scope = describeScope(head, product);

  return (
    <div style={{ borderTop: `1px solid ${LINE}`, padding: "0.7rem 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ minWidth: 240 }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 600, color: INK }}>
            {head.title}{" "}
            {head.version ? (
              <span style={{ color: MUTED, fontWeight: 500 }}>v{head.version}</span>
            ) : (
              <span style={{ color: "#92400e", fontWeight: 500 }}>no version</span>
            )}
          </div>
          <div style={{ fontSize: "0.72rem", color: FAINT, marginTop: "0.15rem" }}>
            {head.originalFilename} &middot; {fileSize(head.fileSize)}
            {head.language ? ` · ${head.language}` : ""}
            {head.isLegacy ? " · uploaded before the current storage system" : ""}
          </div>
          <div style={{ fontSize: "0.72rem", color: FAINT, marginTop: "0.15rem" }}>
            {formatDate(head.effectiveDate)
              ? state === "future"
                ? `Takes effect ${formatDate(head.effectiveDate)}`
                : `In force since ${formatDate(head.effectiveDate)}`
              : "No effective date recorded"}
            {" · "}
            {scope}
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.3rem", alignItems: "flex-start", flexWrap: "wrap" }}>
          <StatusChip status={head.processingStatus} />
          <StatusChip status={head.approvalStatus} />
          {!head.sellerVisible ? <StatusChip status="INACTIVE" /> : null}
          {head.category === "DOCUMENT" && !head.downloadAllowed ? (
            <span
              title="Visible to sellers as a reference, excluded from their downloads."
              style={{
                fontSize: "0.62rem",
                fontWeight: 700,
                borderRadius: 4,
                padding: "0.12rem 0.35rem",
                background: "#fef3c7",
                color: "#92400e",
                textTransform: "uppercase",
              }}
            >
              View only
            </span>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
        {/*
          * APPROVE AND REJECT ARE GONE FROM HERE TOO — see `uploadMedia`. A
          * document uploaded from this panel is written approved and switched
          * on, so neither button had anything left to decide. The control that
          * does something is the switch below.
          */}
        <Form method="post">
          <input type="hidden" name="tab" value="documents" />
          <input type="hidden" name="assetId" value={head.id} />
          <input type="hidden" name="sellerVisible" value={head.sellerVisible ? "false" : "true"} />
          <button
            type="submit"
            name="intent"
            value="media_visibility"
            style={{ ...btn(head.sellerVisible ? "#92400e" : "#065f46"), padding: "0.25rem 0.5rem" }}
          >
            {head.sellerVisible ? "Deactivate" : "Activate"}
          </button>
        </Form>
        <Link
          to={`?tab=documents&doc=${encodeURIComponent(head.id)}`}
          style={{ ...btn(MUTED), padding: "0.25rem 0.5rem" }}
        >
          Edit and version
        </Link>
        <a
          href={head.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...btn(MUTED), padding: "0.25rem 0.5rem" }}
        >
          Open file
        </a>
      </div>

      {history.length ? (
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ fontSize: "0.72rem", color: MUTED, cursor: "pointer" }}>
            {history.length} earlier version{history.length === 1 ? "" : "s"} kept
          </summary>
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.72rem", color: MUTED, lineHeight: 1.7 }}>
            {history.map((version) => (
              <li key={version.id}>
                v{version.version ?? "unversioned"} — uploaded{" "}
                {formatDate(version.createdAt) ?? "at an unknown date"}, {fileSize(version.fileSize)},{" "}
                {version.sellerVisible ? "still offered to sellers" : "withdrawn from sellers"}{" "}
                <a href={version.url} target="_blank" rel="noopener noreferrer" style={{ color: INK }}>
                  open
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Which variants a document applies to, in words. */
function describeScope(asset: MediaAssetView, product: Product): string {
  if (asset.assignments.length === 0) return "attached to nothing";
  const general = asset.assignments.some((assignment) => assignment.variantId === null);
  const names = asset.assignments
    .map((assignment) =>
      assignment.variantId
        ? product.variants.find((variant) => variant.id === assignment.variantId)?.name ??
          "a removed variant"
        : null
    )
    .filter((name): name is string => Boolean(name));

  if (general && names.length === 0) return "applies to the product itself";
  if (general) return `applies to the product itself and ${names.join(", ")}`;
  return `applies to ${names.join(", ")}`;
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

function UploadPanel({ product }: { product: Product }) {
  const [params] = useSearchParams();
  const requested = params.get("docType") ?? "";

  return (
    <div style={card}>
      <h2 style={sectionTitle}>Add a document</h2>
      <p style={sectionNote}>
        A new document starts as a draft: stored and visible to staff, and offered to no seller
        until someone approves it.
      </p>

      <Form method="post" encType="multipart/form-data">
        <input type="hidden" name="tab" value="documents" />
        <input type="hidden" name="category" value="DOCUMENT" />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.85rem" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field id="doc-file" label="PDF file" hint="Up to 25 MB. Only PDF files are accepted for documents.">
              <input
                style={input}
                id="doc-file"
                name="file"
                type="file"
                required
                accept="application/pdf"
              />
            </Field>
          </div>

          <Field id="doc-type" label="Document type">
            <select style={input} id="doc-type" name="documentType" defaultValue={requested || "CARE_GUIDE"}>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {DOCUMENT_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>

          <Field id="doc-title" label="Title" hint="Left blank, the filename is used.">
            <input style={input} id="doc-title" name="title" placeholder="Cooling pillow care guide" />
          </Field>

          <Field
            id="doc-version"
            label="Version"
            hint="Your own numbering. A version can never be reused for the same title."
          >
            <input style={input} id="doc-version" name="version" list="doc-versions" placeholder="1.0" />
            <datalist id="doc-versions">
              <option value="1.0" />
              <option value="1.1" />
              <option value="2.0" />
            </datalist>
          </Field>

          <Field
            id="doc-effective"
            label="Effective date"
            hint="The date the document starts to apply, not the date you uploaded it."
          >
            <input style={input} id="doc-effective" name="effectiveDate" type="date" />
          </Field>

          <Field id="doc-language" label="Language">
            <input style={input} id="doc-language" name="language" list="doc-languages" placeholder="en" />
            <datalist id="doc-languages">
              {COMMON_LANGUAGES.map((code) => (
                <option key={code} value={code} />
              ))}
            </datalist>
          </Field>

          <Field id="doc-download" label="Sellers may download it">
            <select style={input} id="doc-download" name="downloadAllowed" defaultValue="true">
              <option value="true">Yes — include the file in their downloads</option>
              <option value="false">No — show it as a reference only</option>
            </select>
          </Field>
        </div>

        <ScopePicker product={product} />

        <div style={{ marginTop: "0.85rem" }}>
          <button type="submit" name="intent" value="media_upload" style={btn(INK, { solid: true })}>
            Upload document
          </button>
        </div>
      </Form>
    </div>
  );
}

/**
 * Which variants a document applies to.
 *
 * General means the file belongs to the product rather than to one size, and a
 * size with its own documents shows those instead — not both.
 */
function ScopePicker({ product, defaults }: { product: Product; defaults?: Set<string> }) {
  const [params] = useSearchParams();
  const scope = params.get("scope") ?? "general";

  return (
    <fieldset style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: "0.75rem", marginTop: "0.85rem" }}>
      <legend style={{ fontSize: "0.72rem", color: MUTED, padding: "0 0.35rem" }}>Applies to</legend>
      <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.4rem" }}>
        <input type="radio" name="scopeMode" value="general" defaultChecked={scope !== "variant"} />{" "}
        General product media — belongs to the product itself, not to any one size
      </label>
      <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
        <input type="radio" name="scopeMode" value="variant" defaultChecked={scope === "variant"} />{" "}
        Variant-specific media — belongs to the size(s) ticked below
      </label>

      {product.variants.length ? (
        <div style={{ display: "flex", gap: "0.85rem", flexWrap: "wrap", paddingLeft: "1.4rem" }}>
          {product.variants
            .filter((variant) => variant.isActive)
            .map((variant) => (
              <label key={variant.id} style={{ fontSize: "0.78rem", color: MUTED }}>
                <input
                  type="checkbox"
                  name="scopeVariantIds"
                  value={variant.id}
                  defaultChecked={defaults?.has(variant.id) ?? false}
                />{" "}
                {variant.name}
              </label>
            ))}
        </div>
      ) : (
        <p style={{ ...helpText, paddingLeft: "1.4rem" }}>
          This product has no active variants yet, so there is no size for this file to belong to.
          Leave the scope on general product media, or add a size first.
        </p>
      )}
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                     */
/* -------------------------------------------------------------------------- */

function DocumentEditor({ chain, product }: { chain: DocChain; product: Product }) {
  const { head, history } = chain;
  const attached = new Set(
    head.assignments
      .map((assignment) => assignment.variantId)
      .filter((id): id is string => Boolean(id))
  );

  return (
    <div style={{ border: `2px solid ${INK}`, borderRadius: 10, padding: "0.85rem", margin: "0.7rem 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
        <h3 style={{ ...sectionTitle, marginBottom: 0 }}>
          {head.title} {head.version ? `v${head.version}` : ""}
        </h3>
        <Link to="?tab=documents" style={{ fontSize: "0.72rem", color: MUTED }}>
          Done
        </Link>
      </div>

      <Form method="post" style={{ marginTop: "0.75rem" }}>
        <input type="hidden" name="tab" value="documents" />
        <input type="hidden" name="assetId" value={head.id} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.7rem" }}>
          <Field id={`doc-e-title-${head.id}`} label="Title">
            <input style={input} id={`doc-e-title-${head.id}`} name="title" defaultValue={head.title} />
          </Field>

          <Field id={`doc-e-type-${head.id}`} label="Document type">
            <select
              style={input}
              id={`doc-e-type-${head.id}`}
              name="documentType"
              defaultValue={head.documentType ?? "OTHER"}
            >
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {DOCUMENT_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>

          <Field id={`doc-e-version-${head.id}`} label="Version">
            <input style={input} id={`doc-e-version-${head.id}`} name="version" defaultValue={head.version ?? ""} />
          </Field>

          <Field id={`doc-e-effective-${head.id}`} label="Effective date">
            <input
              style={input}
              id={`doc-e-effective-${head.id}`}
              name="effectiveDate"
              type="date"
              defaultValue={dateInputValue(head.effectiveDate)}
            />
          </Field>

          <Field id={`doc-e-language-${head.id}`} label="Language">
            <input
              style={input}
              id={`doc-e-language-${head.id}`}
              name="language"
              list="doc-languages"
              defaultValue={head.language ?? ""}
            />
          </Field>

          <Field id={`doc-e-download-${head.id}`} label="Sellers may download it">
            <select
              style={input}
              id={`doc-e-download-${head.id}`}
              name="downloadAllowed"
              defaultValue={head.downloadAllowed ? "true" : "false"}
            >
              <option value="true">Yes — include in their downloads</option>
              <option value="false">No — reference only</option>
            </select>
          </Field>

          <Field
            id={`doc-e-visible-${head.id}`}
            label="Offered to sellers"
            hint="A document that is not approved is never offered, whatever this says."
          >
            <select
              style={input}
              id={`doc-e-visible-${head.id}`}
              name="sellerVisible"
              defaultValue={head.sellerVisible ? "true" : "false"}
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </Field>
        </div>

        <div style={{ marginTop: "0.7rem" }}>
          <button type="submit" name="intent" value="media_update" style={btn(INK, { solid: true })}>
            Save
          </button>
        </div>
      </Form>

      <Form method="post" style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
        <input type="hidden" name="tab" value="documents" />
        <input type="hidden" name="assetId" value={head.id} />

        <div style={{ fontSize: "0.72rem", color: MUTED, marginBottom: "0.4rem" }}>Applies to</div>
        <label style={{ display: "block", fontSize: "0.78rem", marginBottom: "0.3rem" }}>
          <input
            type="checkbox"
            name="scopeVariantIds"
            value=""
            defaultChecked={head.assignments.some((assignment) => assignment.variantId === null)}
          />{" "}
          General product media — the product itself
        </label>
        {product.variants.map((variant) => (
          <label key={variant.id} style={{ display: "block", fontSize: "0.78rem" }}>
            <input
              type="checkbox"
              name="scopeVariantIds"
              value={variant.id}
              defaultChecked={attached.has(variant.id)}
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

      <SupersedeForm document={head} product={product} />

      {history.length ? (
        <div style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
          <div style={{ fontSize: "0.72rem", color: MUTED, marginBottom: "0.35rem" }}>
            Earlier versions, kept as they were issued
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.75rem", color: MUTED, lineHeight: 1.8 }}>
            {history.map((version) => (
              <li key={version.id}>
                v{version.version ?? "unversioned"} — {fileSize(version.fileSize)}, uploaded{" "}
                {formatDate(version.createdAt) ?? "at an unknown date"},{" "}
                {version.sellerVisible ? "still offered to sellers" : "withdrawn from sellers"}{" "}
                <a href={version.url} target="_blank" rel="noopener noreferrer" style={{ color: INK }}>
                  open
                </a>
              </li>
            ))}
          </ul>
          <p style={{ ...helpText }}>
            These are records, not drafts. If one of them should be current again, upload it as a
            new version rather than editing it here — the point of the record is that it does not
            change.
          </p>
        </div>
      ) : null}

      <div style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
        <ConfirmForm
          intent="media_delete"
          fields={{ tab: "documents", assetId: head.id }}
          label="Delete this document"
          confirmLabel="Delete"
          question="Delete this version? Sellers stop receiving it."
        />
        {history.length ? (
          <span style={{ ...helpText, display: "inline-block", marginLeft: "0.6rem" }}>
            Deleting removes this version. Earlier versions stay in the record.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Replacing a document with a new version.
 *
 * Collapsed by default and deliberately not the first control on the row: this
 * is the action that changes what sellers receive, and it should be a decision
 * rather than a click that happens to be next to Save.
 */
function SupersedeForm({ document: doc, product }: { document: MediaAssetView; product: Product }) {
  return (
    <details style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}>
      <summary style={{ fontSize: "0.78rem", color: INK, cursor: "pointer", fontWeight: 600 }}>
        Replace with a new version
      </summary>

      <p style={{ ...helpText, marginTop: "0.5rem" }}>
        The file is never overwritten. This uploads the new file, records it as the version that
        replaces v{doc.version ?? "(unversioned)"}, and withdraws the old one from sellers — which
        stays downloadable here.
      </p>

      <Form method="post" encType="multipart/form-data" style={{ marginTop: "0.6rem" }}>
        <input type="hidden" name="tab" value="documents" />
        <input type="hidden" name="assetId" value={doc.id} />
        <input type="hidden" name="documentType" value={doc.documentType ?? "OTHER"} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.7rem" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field id={`doc-s-file-${doc.id}`} label="New PDF" hint="Up to 25 MB.">
              <input
                style={input}
                id={`doc-s-file-${doc.id}`}
                name="file"
                type="file"
                required
                accept="application/pdf"
              />
            </Field>
          </div>

          <Field
            id={`doc-s-version-${doc.id}`}
            label="New version"
            hint="Must differ from the version being replaced."
          >
            <input style={input} id={`doc-s-version-${doc.id}`} name="version" required placeholder="1.1" />
          </Field>

          <Field id={`doc-s-effective-${doc.id}`} label="Effective date">
            <input
              style={input}
              id={`doc-s-effective-${doc.id}`}
              name="effectiveDate"
              type="date"
              defaultValue={dateInputValue(doc.effectiveDate)}
            />
          </Field>

          <Field id={`doc-s-language-${doc.id}`} label="Language">
            <input
              style={input}
              id={`doc-s-language-${doc.id}`}
              name="language"
              list="doc-languages"
              defaultValue={doc.language ?? ""}
            />
          </Field>

          <Field id={`doc-s-title-${doc.id}`} label="Title" hint="Left blank, the current title is kept.">
            <input style={input} id={`doc-s-title-${doc.id}`} name="title" />
          </Field>
        </div>

        <p style={{ ...helpText, marginTop: "0.5rem" }}>
          Applies to {describeScope(doc, product)} — the same scope as the version being replaced,
          taken from the record rather than restated here.
        </p>

        <div style={{ marginTop: "0.7rem" }}>
          <button type="submit" name="intent" value="document_supersede" style={btn("#0369a1", { solid: true })}>
            Upload and replace
          </button>
        </div>
      </Form>
    </details>
  );
}
