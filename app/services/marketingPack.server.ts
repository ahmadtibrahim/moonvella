import type { MediaCategory, Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { readObject } from "./storage.server";
import { buildZip, type ZipEntry } from "~/utils/zip";

/**
 * The Marketing Pack: a seller downloads one ZIP containing everything they are
 * allowed to have for a product.
 *
 * THE ALLOWLIST IS THE SELECT. Everything this module is permitted to emit is
 * listed in `PACK_SELECT` below, field by field. Nothing is spread from a row
 * and nothing is "deleted from" an object on the way out, because a subtraction
 * silently stops working the moment someone adds a column — the new field is
 * simply absent from the deny list and ships. Here a new column is invisible
 * until someone deliberately adds it to the select and to the manifest writer,
 * which is a decision a person has to make on purpose.
 *
 * So acquisition cost, supplier notes, internal reference numbers, storage
 * object keys and other sellers' rows are not filtered out of this pack. They
 * are never loaded, and therefore cannot be forgotten about.
 */

/**
 * Categories a seller receives, and the folder each one lands in.
 *
 * A category absent from this map is not downloadable, whatever its approval
 * state — that is the default, so a category added to the schema later starts
 * private rather than starting shared.
 */
const PACK_FOLDERS: Partial<Record<MediaCategory, string>> = {
  WHITE_BACKGROUND_IMAGE: "Images/White Background",
  LIFESTYLE_IMAGE: "Images/Lifestyle",
  PRODUCT_VIDEO: "Video",
  DOCUMENT: "Documents",
  MARKETING_CREATIVE: "Marketing/Creatives",
  EDITABLE_TEMPLATE: "Marketing/Templates",
};

/**
 * Only the fields the pack actually writes.
 *
 * Note what is here: presentation data and file bytes. Note what is not:
 * `checksum` (used to de-duplicate, of no use to a seller), `supersedesId` and
 * every relation back into the admin side of the product.
 *
 * `sourceUrl` is loaded only so a migrated row can be told apart from a corrupt
 * one when its bytes are missing — "this file predates our storage" and "this
 * file is gone" need different answers. It is never written into the pack: the
 * manifest builder has its own allowlist and does not read this field.
 */
const PACK_SELECT = {
  id: true,
  category: true,
  subtype: true,
  title: true,
  altText: true,
  originalFilename: true,
  storageKey: true,
  sourceUrl: true,
  mimeType: true,
  fileSize: true,
  width: true,
  height: true,
  durationSeconds: true,
  processingStatus: true,
  approvalStatus: true,
  sellerVisible: true,
  documentType: true,
  version: true,
  effectiveDate: true,
  language: true,
  downloadAllowed: true,
  instructions: true,
  templateUrl: true,
  assignments: { select: { variantId: true } },
} satisfies Prisma.MediaAssetSelect;

type PackAsset = Prisma.MediaAssetGetPayload<{ select: typeof PACK_SELECT }>;

export interface PackFile {
  /** Path inside the ZIP. */
  path: string;
  assetId: string;
  title: string;
  bytes: number;
}

export interface PackLink {
  /** A template a seller customises in their own tool; there are no bytes. */
  title: string;
  url: string;
  instructions: string | null;
}

export interface MarketingPack {
  productCode: string;
  productName: string;
  filename: string;
  bytes: Uint8Array;
  files: PackFile[];
  links: PackLink[];
  /** Assets deliberately left out, and why — surfaced to staff, never to sellers. */
  excluded: { title: string; reason: string }[];
}

/**
 * A filename a seller can open on any platform.
 *
 * The stored name came from whoever uploaded the file, so it is treated as
 * untrusted text: separators, control characters and leading dots are removed,
 * length is capped, and an extension is taken from the identified MIME type
 * rather than from the uploader's claim about it. Kept identical in spirit to
 * the display-name sanitiser in storage.server, but separate because a ZIP
 * member name has stricter rules than a label in a table.
 */
function packFilename(asset: PackAsset, index: number): string {
  const extension = extensionFor(asset.mimeType);
  const base = asset.originalFilename
    .replace(/\.[^.]*$/, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80);

  const stem = base || `asset-${index + 1}`;
  return `${stem}${extension}`;
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    default:
      // A type we did not expect to be distributing. Better an unusable
      // extension than a guessed one that makes a reader execute the file.
      return ".bin";
  }
}

/** Folders cannot collide, but two files in one folder can. */
function uniquePath(folder: string, filename: string, taken: Set<string>): string {
  let candidate = `${folder}/${filename}`;
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  let counter = 2;
  do {
    candidate = `${folder}/${stem} (${counter})${extension}`;
    counter += 1;
  } while (taken.has(candidate));
  taken.add(candidate);
  return candidate;
}

/**
 * Why an asset was left out. Returned to staff so "why is this video missing
 * from my pack" has an answer that is not a guess.
 */
function exclusionReason(asset: PackAsset): string | null {
  if (asset.approvalStatus !== "APPROVED") {
    return `Not approved (${asset.approvalStatus.toLowerCase().replace("_", " ")}).`;
  }
  if (!asset.sellerVisible) return "Not marked visible to sellers.";
  if (asset.processingStatus === "FAILED") return "Processing failed.";
  if (asset.processingStatus === "UPLOADING") return "Upload did not finish.";
  if (asset.processingStatus === "PROCESSING") return "Still being processed.";
  if (asset.category === "DOCUMENT" && !asset.downloadAllowed) {
    return "This document is view-only.";
  }
  return null;
}

/**
 * Builds the pack.
 *
 * `generatedAt` is passed in so a caller can make the archive reproducible;
 * two builds of unchanged content with the same timestamp are byte-identical.
 */
export async function buildMarketingPack(
  productId: string,
  generatedAt: Date = new Date()
): Promise<MarketingPack | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId, status: "PUBLISHED", isActive: true, isArchived: false },
    select: {
      name: true,
      productCode: true,
      category: true,
      description: true,
      features: true,
      materials: true,
      careInstructions: true,
      currency: true,
      variants: {
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: {
          name: true,
          sku: true,
          suggestedRetailPrice: true,
          variantOptions: {
            orderBy: { sortOrder: "asc" },
            select: { name: true, value: true },
          },
        },
      },
      mediaAssets: {
        where: { category: { in: Object.keys(PACK_FOLDERS) as MediaCategory[] } },
        orderBy: [{ category: "asc" }, { title: "asc" }],
        select: PACK_SELECT,
      },
    },
  });

  if (!product) return null;

  const excluded: { title: string; reason: string }[] = [];
  const entries: ZipEntry[] = [];
  const files: PackFile[] = [];
  const links: PackLink[] = [];
  const taken = new Set<string>();

  const eligible: PackAsset[] = [];
  for (const asset of product.mediaAssets) {
    const reason = exclusionReason(asset);
    if (reason) {
      excluded.push({ title: asset.title, reason });
      continue;
    }
    eligible.push(asset);
  }

  for (const asset of eligible) {
    // An editable template has no file of ours: it points at a design the
    // seller copies in their own tool. Listing it as a download would produce
    // an empty or broken file, so it becomes a link in the manifest instead.
    if (asset.category === "EDITABLE_TEMPLATE" || !asset.storageKey) {
      if (asset.templateUrl) {
        links.push({
          title: asset.title,
          url: asset.templateUrl,
          instructions: asset.instructions,
        });
      } else {
        excluded.push({
          title: asset.title,
          reason: "No template link was set.",
        });
      }
      continue;
    }

    // Decided from the record, before reading anything. A migrated row's key
    // names no object — its file still lives at the address it had before this
    // system existed — so there is nothing to read and nothing went wrong.
    // Asking the record rather than the disk keeps this identical to what the
    // preview reports, and keeps one legacy photograph from failing the whole
    // archive.
    if (!hasStoredBytes(asset)) {
      excluded.push({ title: asset.title, reason: LEGACY_REASON });
      continue;
    }

    const bytes = await readObject(asset.storageKey);
    if (!bytes) {
      // Approved, visible, and expected in storage, but there are no bytes
      // under that key. Reported, not silently omitted: a missing file in a
      // pack a seller paid attention to is worse than a line in a report.
      excluded.push({ title: asset.title, reason: "The stored file could not be read." });
      continue;
    }

    const folder = PACK_FOLDERS[asset.category] ?? "Other";
    const path = uniquePath(folder, packFilename(asset, files.length), taken);
    entries.push({ path, bytes });
    files.push({ path, assetId: asset.id, title: asset.title, bytes: bytes.length });
  }

  // Every path gains the product's own root folder, so a seller who unzips three
  // packs into one Downloads folder gets three folders rather than a merger.
  const root = `MoonVella-${slug(product.productCode)}`;
  const placed: PackFile[] = files.map((file) => ({ ...file, path: `${root}/${file.path}` }));
  const placedEntries = entries.map((entry) => ({ ...entry, path: `${root}/${entry.path}` }));

  // Built from `placed`, so the contents page describes the same paths the
  // seller will actually see rather than the ones used internally.
  const manifest = buildManifest(product, placed, links, excluded, generatedAt);
  placedEntries.push({
    path: `${root}/README.txt`,
    bytes: new TextEncoder().encode(renderReadme(product, placed, links)),
  });
  placedEntries.push({
    path: `${root}/manifest.json`,
    bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  return {
    productCode: product.productCode,
    productName: product.name,
    filename: `${slug(product.productCode)}-marketing-pack.zip`,
    bytes: buildZip(placedEntries, generatedAt),
    files: placed,
    links,
    excluded,
  };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "product"
  );
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the pack would contain, without opening a single file.
 *
 * Staff need to see the pack before a seller does — "why is this video missing"
 * should be answerable from the admin screen. Building the real archive to
 * answer that would read every byte of a product's media on a page load, which
 * is why this exists: it runs the same `exclusionReason` and the same folder
 * map, and reports the same lists, but stops short of the read.
 *
 * The one thing it can only predict is whether a stored file is really on disk.
 * `hasStoredBytes` below draws the same line the archive does, so the two agree
 * about migrated rows; a file that vanishes between the preview and the download
 * is still reported honestly by the archive, which is the one that matters.
 */
export interface PackPreviewItem {
  title: string;
  category: MediaCategory;
  /** Where it lands in the ZIP. Null for a link, which has no file. */
  folder: string | null;
  link: string | null;
  bytes: number;
}

export interface PackPreview {
  /** False when the product is not published: no pack can be produced at all. */
  downloadable: boolean;
  productCode: string;
  productName: string;
  filename: string;
  files: PackPreviewItem[];
  links: PackPreviewItem[];
  excluded: { title: string; reason: string }[];
  totalBytes: number;
}

export async function previewMarketingPack(productId: string): Promise<PackPreview | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId },
    select: {
      name: true,
      productCode: true,
      status: true,
      isActive: true,
      isArchived: true,
      mediaAssets: {
        where: { category: { in: Object.keys(PACK_FOLDERS) as MediaCategory[] } },
        orderBy: [{ category: "asc" }, { title: "asc" }],
        select: PACK_SELECT,
      },
    },
  });
  if (!product) return null;

  const files: PackPreviewItem[] = [];
  const links: PackPreviewItem[] = [];
  const excluded: { title: string; reason: string }[] = [];

  for (const asset of product.mediaAssets) {
    const reason = exclusionReason(asset);
    if (reason) {
      excluded.push({ title: asset.title, reason });
      continue;
    }
    if (asset.category === "EDITABLE_TEMPLATE" || !asset.storageKey) {
      if (asset.templateUrl) {
        links.push({
          title: asset.title,
          category: asset.category,
          folder: null,
          link: asset.templateUrl,
          bytes: 0,
        });
      } else {
        excluded.push({ title: asset.title, reason: "No template link was set." });
      }
      continue;
    }
    if (!hasStoredBytes(asset)) {
      excluded.push({ title: asset.title, reason: LEGACY_REASON });
      continue;
    }
    files.push({
      title: asset.title,
      category: asset.category,
      folder: PACK_FOLDERS[asset.category] ?? "Other",
      link: null,
      bytes: asset.fileSize,
    });
  }

  return {
    downloadable: product.status === "PUBLISHED" && product.isActive && !product.isArchived,
    productCode: product.productCode,
    productName: product.name,
    filename: `${slug(product.productCode)}-marketing-pack.zip`,
    files,
    links,
    excluded,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

const LEGACY_REASON =
  "Uploaded before the current storage system; re-upload this file to include it.";

/**
 * Whether this row has bytes in our storage at all.
 *
 * A migrated row keeps the address its file had before this system existed and
 * was never copied into object storage, so its key names nothing. The archive
 * confirms this by reading; the preview needs the answer without reading, and
 * this is the closest it can get — a row that predates storage cannot have an
 * object in it.
 */
function hasStoredBytes(asset: { storageKey: string | null; sourceUrl: string | null }): boolean {
  return Boolean(asset.storageKey) && !asset.sourceUrl;
}

type ManifestProduct = {
  name: string;
  productCode: string;
  category: string;
  description: string | null;
  features: string | null;
  materials: string | null;
  careInstructions: string | null;
  currency: string;
  variants: {
    name: string;
    sku: string;
    suggestedRetailPrice: number;
    variantOptions: { name: string; value: string }[];
  }[];
};

/**
 * The machine-readable contents page.
 *
 * Built field by field for the same reason the select is: a JSON.stringify of a
 * database row is how internal columns end up in a customer download.
 *
 * Note that wholesale price is deliberately absent. A seller's own cost is
 * shown to *them* in the catalogue, under their own session; a file that leaves
 * the building should not carry the commercial terms, because a file gets
 * forwarded.
 */
function buildManifest(
  product: ManifestProduct,
  files: PackFile[],
  links: PackLink[],
  excluded: { title: string; reason: string }[],
  generatedAt: Date
) {
  return {
    brand: "MoonVella",
    generatedAt: generatedAt.toISOString(),
    product: {
      name: product.name,
      code: product.productCode,
      category: product.category,
      currency: product.currency,
      description: product.description,
      features: product.features,
      materials: product.materials,
      careInstructions: product.careInstructions,
    },
    variants: product.variants.map((variant) => ({
      name: variant.name,
      sku: variant.sku,
      suggestedRetailPrice: variant.suggestedRetailPrice,
      options: variant.variantOptions.map((option) => `${option.name}: ${option.value}`),
    })),
    files: files.map((file) => ({ path: file.path, title: file.title, bytes: file.bytes })),
    templateLinks: links.map((link) => ({
      title: link.title,
      url: link.url,
      instructions: link.instructions,
    })),
    // Counted, not listed. The reasons name internal states ("not approved") and
    // an omitted asset's title is not the seller's business.
    omittedCount: excluded.length,
  };
}

function renderReadme(
  product: { name: string; productCode: string; description: string | null },
  files: PackFile[],
  links: PackLink[]
): string {
  const lines: string[] = [];
  lines.push(`MoonVella — ${product.name}`);
  lines.push(`Product code: ${product.productCode}`);
  lines.push("");
  if (product.description) {
    lines.push(product.description);
    lines.push("");
  }
  lines.push("What is in this pack");
  lines.push("-------------------");
  // Depth varies by folder ("Video" is one level, "Images/Lifestyle" is two),
  // so the folder is everything before the final segment.
  const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");
  for (const folder of [...new Set(files.map((file) => folderOf(file.path)))].sort()) {
    lines.push(`  ${folder}/`);
    for (const file of files.filter((f) => folderOf(f.path) === folder)) {
      lines.push(`    ${file.path.split("/").pop()}`);
    }
  }
  if (links.length) {
    lines.push("  (template links are listed in manifest.json)");
    for (const link of links) {
      lines.push(`    ${link.title}`);
    }
  }
  lines.push("");
  lines.push("Images supplied here are approved for use in your own listings and");
  lines.push("marketing for this product. Please do not alter the product itself.");
  lines.push("");
  lines.push("Suggested retail prices in manifest.json are a recommendation, not a");
  lines.push("condition of sale.");
  return lines.join("\n");
}
