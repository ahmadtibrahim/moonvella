import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { permissionsFor } from "~/services/permissions";
import {
  getProduct,
  updateProduct,
  setPublished,
  setArchived,
  duplicateProduct,
  addVariant,
  updateVariant,
  deleteVariant,
  setDefaultVariant,
} from "~/services/products.server";
import {
  listProductMedia,
  uploadMedia,
  attachMediaToVariants,
  updateMedia,
  setMediaApproval,
  deleteMedia,
  detachMedia,
  setPrimaryAssignment,
  reorderAssignment,
  supersedeDocument,
} from "~/services/media.server";
import { publicationReadiness } from "~/services/publication.server";
import { previewMarketingPack } from "~/services/marketingPack.server";
import {
  getProductPackages,
  listPresets,
  resolvePackagesForVariant,
  saveProductPackages,
  saveVariantPackages,
  copyVariantPackaging,
} from "~/services/packaging.server";
import {
  missingOriginFields,
  resolveOriginForVariant,
  saveOriginMappings,
  type OriginLocation,
} from "~/services/origins.server";
import { card, INK, MUTED, catalogueValue, listValue } from "~/components/product/ui";
import DetailsTab from "~/components/product/DetailsTab";
import VariantsTab from "~/components/product/VariantsTab";
import ShippingTab from "~/components/product/ShippingTab";
import MediaTab from "~/components/product/MediaTab";
import DocumentsTab from "~/components/product/DocumentsTab";
import MarketingTab from "~/components/product/MarketingTab";

export const TABS = ["details", "variants", "shipping", "media", "documents", "marketing"] as const;
export type TabKey = (typeof TABS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  details: "Product Details",
  variants: "Variants",
  shipping: "Shipping",
  media: "Media",
  documents: "Documents",
  marketing: "Marketing Kit",
};

function readTab(value: string | null | undefined): TabKey {
  return TABS.includes(value as TabKey) ? (value as TabKey) : "details";
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requirePermission(request, "products.view");
  const productId = String(params.id);
  const product = await getProduct(productId);
  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  const url = new URL(request.url);
  const tab = readTab(url.searchParams.get("tab"));
  const [presets, media, readiness, pack] = await Promise.all([
    listPresets(),
    listProductMedia(productId),
    publicationReadiness(productId),
    // Describes the seller's pack without opening any of its files, so the
    // Marketing tab can show what will be handed over rather than describe it.
    previewMarketingPack(productId),
  ]);

  const held = permissionsFor(user.role);

  return {
    product,
    presets,
    media,
    readiness,
    pack,
    /**
     * Resolving every variant's origin and packaging costs a query per variant
     * per question, so it is only done when the Shipping tab is open. It goes
     * through the same functions the quoting and booking paths call rather than
     * reading the columns here — the page must show what the gate will decide,
     * and a second implementation of "is this ready" is a second answer.
     */
    shipping: tab === "shipping" ? await shippingContext(product) : null,
    tab,
    /**
     * "Preview seller view" is a navigation rather than a client-side toggle, so
     * the preview is a URL someone can send to a colleague and reload.
     */
    preview: url.searchParams.get("preview") === "1",
    /**
     * What this person may do, resolved from their role. Used to decide which
     * controls are drawn — never as the control itself, which is the check in
     * the action and in the service behind it.
     */
    can: {
      manage: held.has("products.manage"),
      cost: held.has("products.cost.edit"),
    },
  };
}

type LoadedProduct = NonNullable<Awaited<ReturnType<typeof getProduct>>>;

/**
 * The packaging rows of a submitted form, zipped by index.
 *
 * The text and number fields are parallel arrays, because every row is in the
 * document in the same order and no row is added or removed without a round
 * trip. The two checkboxes are the exception: an unchecked box submits nothing
 * at all, so a row with the box off would shift every value after it by one.
 * They are named per row and read by index, which is the only way to know which
 * carton a missing value belongs to.
 *
 * EVERY COLUMN THE SERVICE STORES IS READ HERE, and that is not tidiness. Both
 * saves are whole-set replaces — the old rows are deleted and the submitted ones
 * created — so a field this function forgets is a field the save deletes. A
 * carton edited through the editor would quietly lose its declared value, its
 * description and its "ships separately" flag, and the quote would change
 * without anybody touching a number.
 */
function packageRows(form: FormData) {
  const at = (name: string, index: number) => String(form.getAll(name)[index] ?? "");
  return form.getAll("pkg_length").map((_, index) => ({
    label: at("pkg_label", index),
    packageType: at("pkg_packageType", index) || "carton",
    presetId: at("pkg_presetId", index) || null,
    length: at("pkg_length", index),
    width: at("pkg_width", index),
    height: at("pkg_height", index),
    // The forms default to inches and pounds; the service converts once, to the
    // canonical centimetres and kilograms, without rounding the stored value.
    dimensionUnit: at("pkg_dimUnit", index) || "in",
    grossWeight: at("pkg_weight", index),
    weightUnit: at("pkg_weightUnit", index) || "lb",
    unitsPerPackage: at("pkg_unitsPerPackage", index) || "1",
    packagesPerUnit: at("pkg_packagesPerUnit", index) || "1",
    description: at("pkg_description", index) || null,
    declaredValue: at("pkg_declaredValue", index) || null,
    shipsSeparately: form.get(`pkg_shipsSeparately_${index}`) === "true",
    // Defaults to allowed when the control is absent entirely, so a form that
    // predates the column cannot silently forbid consolidation.
    consolidatable: form.has(`pkg_consolidatable_${index}`)
      ? form.get(`pkg_consolidatable_${index}`) === "true"
      : true,
  }));
}

/**
 * Everything the Shipping tab shows, resolved the way the booking path resolves it.
 *
 * The variant rows carry the ANSWER ("inherits the product's packaging", "no
 * location mapped") rather than the raw foreign keys, because that answer is
 * what an operator is checking — a table of ids would be a table nobody can
 * read. `packages` is the product's own default rows, which is what the editor
 * edits; `variants[].packageCount` is what each variant would actually be
 * quoted from, which is not always the same number.
 */
async function shippingContext(product: LoadedProduct) {
  const [locations, packages] = await Promise.all([
    // Inactive locations are listed as well as active ones: a mapping that
    // points at a switched-off dock has to be visible in the select that set it,
    // otherwise the row looks unmapped and the mapping is quietly replaced.
    prisma.pickupLocation.findMany({ orderBy: [{ isActive: "desc" }, { code: "asc" }] }),
    getProductPackages(product.id),
  ]);

  const variants = await Promise.all(
    product.variants.map(async (variant) => {
      const [origin, packaging] = await Promise.all([
        resolveOriginForVariant(variant.id),
        resolvePackagesForVariant(variant.id),
      ]);
      return {
        id: variant.id,
        name: variant.name,
        sku: variant.sku,
        pickupLocationId: variant.pickupLocationId,
        originSource: origin.source,
        originReady: origin.ready,
        originReason: origin.reason,
        originName: origin.location?.name ?? null,
        packageSource: packaging.source,
        packageCount: packaging.packages.length,
      };
    })
  );

  return {
    locations: locations.map((location) => ({
      id: location.id,
      code: location.code,
      name: location.name,
      isActive: location.isActive,
      missing: missingOriginFields(location as OriginLocation),
    })),
    packages,
    variants,
  };
}

/**
 * Every write in the editor arrives here.
 *
 * One action for five tabs rather than five routes: the tabs share a product,
 * and a single action means one authorisation check, one actor, and one place
 * where an unknown intent is refused. A form that invents an intent it was not
 * given fails loudly instead of silently doing nothing.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "products.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = {
    actorType: "ADMIN_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
    permissions: [...permissionsFor(user.role)],
  };

  const productId = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const tab = readTab(String(form.get("tab") || ""));

  const text = (name: string) => String(form.get(name) || "");
  const optional = (name: string) => {
    const value = String(form.get(name) ?? "").trim();
    return value === "" ? null : value;
  };
  const variantScope = () =>
    form
      .getAll("scopeVariantIds")
      .map(String)
      .filter(Boolean);

  try {
    switch (intent) {
      /* ---------------------------------------------------------------- */
      /* Product details                                                   */
      /* ---------------------------------------------------------------- */
      case "update_details":
        await updateProduct(
          productId,
          {
            name: text("name"),
            productCode: text("productCode"),
            category: catalogueValue(form, "category"),
            description: optional("description"),
            features: listValue(form, "features"),
            materials: listValue(form, "materials"),
            careInstructions: optional("careInstructions"),
            currency: catalogueValue(form, "currency") || "CAD",
          },
          actor
        );
        break;

      case "submit_for_approval":
        await updateProduct(
          productId,
          {
            name: text("name"),
            productCode: text("productCode"),
            category: catalogueValue(form, "category"),
            description: optional("description"),
            features: listValue(form, "features"),
            materials: listValue(form, "materials"),
            careInstructions: optional("careInstructions"),
            currency: catalogueValue(form, "currency") || "CAD",
            status: "PENDING_APPROVAL",
          },
          actor
        );
        break;

      case "publish":
        await setPublished(productId, true, actor);
        break;
      case "unpublish":
        await setPublished(productId, false, actor);
        break;
      case "archive":
        await setArchived(productId, true, actor);
        break;
      case "restore":
        await setArchived(productId, false, actor);
        break;
      case "duplicate": {
        const copy = await duplicateProduct(productId, actor);
        return redirect(`/admin/products/${copy.id}?tab=details`);
      }

      /* ---------------------------------------------------------------- */
      /* Variants                                                          */
      /* ---------------------------------------------------------------- */
      case "add_variant":
      case "update_variant": {
        const variantInput = {
          name: text("name"),
          sku: text("sku"),
          barcode: optional("barcode"),
          wholesalePrice: Number(form.get("wholesalePrice")),
          suggestedRetailPrice: Number(form.get("suggestedRetailPrice")),
          // Absent means "not supplied" rather than zero, so a caller without
          // cost permission does not accidentally zero the figure.
          costPrice: form.has("costPrice") ? (optional("costPrice") as never) : undefined,
          inventory: Number(form.get("inventory") || 0),
          unitsPerPackage: Number(form.get("unitsPerPackage") || 1),
          productLengthCm: optional("productLengthCm"),
          productWidthCm: optional("productWidthCm"),
          productHeightCm: optional("productHeightCm"),
          productWeightKg: optional("productWeightKg"),
          options: form
            .getAll("optionName")
            .map((name, index) => ({
              name: String(name),
              value: String(form.getAll("optionValue")[index] ?? ""),
            }))
            .filter((option) => option.name.trim() && option.value.trim()),
        };

        if (intent === "add_variant") {
          await addVariant(productId, variantInput, actor);
        } else {
          await updateVariant(text("variantId"), variantInput, actor);
        }
        break;
      }

      case "delete_variant":
        await deleteVariant(text("variantId"), actor);
        break;
      case "set_default_variant":
        await setDefaultVariant(text("variantId"), actor);
        break;

      /* ---------------------------------------------------------------- */
      /* Media, documents and marketing share one set of writes            */
      /* ---------------------------------------------------------------- */
      case "media_upload": {
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) {
          throw new Error("Choose a file to upload.");
        }
        await uploadMedia(
          productId,
          file,
          {
            category: text("category") as never,
            subtype: optional("subtype"),
            title: optional("title"),
            altText: optional("altText"),
            variantIds: variantScope(),
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
        break;
      }

      case "document_supersede": {
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) {
          throw new Error("Choose the replacement file.");
        }
        await supersedeDocument(
          text("assetId"),
          file,
          {
            category: "DOCUMENT",
            subtype: optional("subtype"),
            title: optional("title"),
            altText: optional("altText"),
            variantIds: variantScope(),
            documentType: optional("documentType"),
            version: optional("version"),
            effectiveDate: optional("effectiveDate"),
            language: optional("language"),
          },
          actor
        );
        break;
      }

      case "media_update":
        await updateMedia(
          text("assetId"),
          {
            title: text("title"),
            altText: optional("altText"),
            category: form.has("category") ? (text("category") as never) : undefined,
            subtype: form.has("subtype") ? (optional("subtype") as never) : undefined,
            sellerVisible: form.has("sellerVisible") ? form.get("sellerVisible") === "true" : undefined,
            documentType: form.has("documentType") ? (optional("documentType") as never) : undefined,
            version: form.has("version") ? optional("version") : undefined,
            effectiveDate: form.has("effectiveDate") ? optional("effectiveDate") : undefined,
            language: form.has("language") ? optional("language") : undefined,
            downloadAllowed: form.has("downloadAllowed") ? form.get("downloadAllowed") === "true" : undefined,
            instructions: form.has("instructions") ? optional("instructions") : undefined,
            templateUrl: form.has("templateUrl") ? optional("templateUrl") : undefined,
          },
          actor
        );
        break;

      case "media_attach":
        await attachMediaToVariants(text("assetId"), variantScope(), actor);
        break;
      case "media_approve":
        await setMediaApproval(text("assetId"), "APPROVED", actor);
        break;
      case "media_reject":
        await setMediaApproval(text("assetId"), "REJECTED", actor);
        break;
      case "media_delete":
        await deleteMedia(text("assetId"), actor);
        break;
      case "media_detach":
        await detachMedia(text("assignmentId"), actor);
        break;
      case "media_primary":
        await setPrimaryAssignment(text("assignmentId"), actor);
        break;
      case "media_move_up":
        await reorderAssignment(text("assignmentId"), "up", actor);
        break;
      case "media_move_down":
        await reorderAssignment(text("assignmentId"), "down", actor);
        break;

      /* ---------------------------------------------------------------- */
      /* Shipping and packaging — a separate feature, kept working          */
      /* ---------------------------------------------------------------- */
      case "save_packaging":
        await saveVariantPackages(text("variantId"), packageRows(form));
        break;

      case "copy_packaging":
        await copyVariantPackaging(text("fromVariantId"), text("toVariantId"));
        break;

      /**
       * The product's own packaging defaults, and the origins the Shipping tab
       * sets. Both are written through services rather than here, so the
       * validation — every id checked before anything is written, every package
       * row refused as a set rather than filtered — lives in one place.
       */
      case "save_product_packages":
        await saveProductPackages(productId, packageRows(form));
        break;

      case "save_origin": {
        const locationIds = form.getAll("originLocationId").map(String);
        await saveOriginMappings(
          productId,
          {
            productLocationId: optional("pickupLocationId"),
            variantOverrides: form
              .getAll("originVariantId")
              .map(String)
              .filter(Boolean)
              .map((variantId, index) => ({
                variantId,
                locationId: (locationIds[index] ?? "").trim() || null,
              })),
          },
          { actorId: user.id, actorName: user.name }
        );
        break;
      }

      default:
        throw new Error("Unknown action.");
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Operation failed.",
      tab,
    };
  }

  // Back to the tab the form was on, so a save does not move the reader.
  return redirect(`/admin/products/${productId}?tab=${tab}`);
}

export default function AdminProductDetail() {
  const { product, presets, media, readiness, pack, shipping, tab, can, preview } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const href = (key: TabKey) => `/admin/products/${product.id}?tab=${key}`;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/products" style={{ color: INK }}>
          &larr; All products
        </Link>
      </p>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: INK, marginBottom: "0.25rem" }}>
            {product.name}
          </h1>
          <p style={{ color: MUTED, fontSize: "0.8rem", marginBottom: 0 }}>
            <code>{product.productCode}</code> &middot; {product.variants.length} variant
            {product.variants.length === 1 ? "" : "s"} &middot; {media.length} media asset
            {media.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {/* Publication state is shown on every tab, because "is this live?" is
          the question a merchant has most often and the answer must not depend
          on which tab they happen to be looking at. */}
      <ReadinessStrip readiness={readiness} status={product.status} />

      {actionData?.error ? (
        <div
          role="alert"
          style={{
            ...card,
            background: "#fef2f2",
            borderColor: "#fecaca",
            color: "#991b1b",
            fontSize: "0.85rem",
            whiteSpace: "pre-wrap",
          }}
        >
          {actionData.error}
        </div>
      ) : null}

      <nav
        aria-label="Product sections"
        style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid #e2e8f0", marginBottom: "1.25rem", flexWrap: "wrap" }}
      >
        {TABS.map((key) => {
          const active = key === tab;
          return (
            <Link
              key={key}
              to={href(key)}
              aria-current={active ? "page" : undefined}
              style={{
                padding: "0.55rem 0.9rem",
                fontSize: "0.82rem",
                fontWeight: active ? 700 : 500,
                color: active ? INK : MUTED,
                textDecoration: "none",
                borderBottom: active ? `2px solid ${INK}` : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {TAB_LABELS[key]}
            </Link>
          );
        })}
      </nav>

      {tab === "details" ? (
        <DetailsTab
          product={product}
          media={media}
          readiness={readiness}
          canManage={can.manage}
          preview={preview}
        />
      ) : null}
      {tab === "variants" ? (
        <VariantsTab product={product} presets={presets} canEditCost={can.cost} />
      ) : null}
      {tab === "shipping" && shipping ? (
        <ShippingTab
          product={{ id: product.id, name: product.name, pickupLocationId: product.pickupLocationId }}
          variants={shipping.variants}
          locations={shipping.locations}
          packages={shipping.packages}
          presets={presets}
          canManage={can.manage}
        />
      ) : null}
      {tab === "media" ? <MediaTab product={product} media={media} /> : null}
      {tab === "documents" ? <DocumentsTab product={product} media={media} /> : null}
      {tab === "marketing" ? <MarketingTab product={product} media={media} pack={pack} /> : null}

      {/* A hidden form carrying the current tab, so every control that needs to
          post the tab back can copy it from one place. */}
      <Form method="post" id="tab-context" style={{ display: "none" }}>
        <input type="hidden" name="tab" value={tab} />
      </Form>
    </div>
  );
}

/**
 * The publication state, and — when it is not publishable — why not.
 *
 * The reasons are listed rather than counted: "4 problems" tells a merchant
 * nothing they can act on, and each line links to the tab that resolves it.
 */
function ReadinessStrip({
  readiness,
  status,
}: {
  readiness: { ready: boolean; checks: { key: string; label: string; ok: boolean; detail: string; tab: TabKey }[]; blockers: { key: string; label: string; detail: string; tab: TabKey }[] };
  status: string;
}) {
  const published = status === "PUBLISHED";
  const tone = published
    ? { bg: "#ecfdf5", border: "#a7f3d0", fg: "#065f46" }
    : readiness.ready
      ? { bg: "#f0f9ff", border: "#bae6fd", fg: "#075985" }
      : { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" };

  return (
    <div
      style={{
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.fg,
        borderRadius: 10,
        padding: "0.75rem 1rem",
        margin: "1rem 0 1.25rem",
        fontSize: "0.8rem",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: readiness.blockers.length ? "0.4rem" : 0 }}>
        {published
          ? "Published to sellers."
          : readiness.ready
            ? "Ready to publish."
            : `Not ready to publish — ${readiness.blockers.length} item${readiness.blockers.length === 1 ? "" : "s"} outstanding.`}
      </div>
      {!published && readiness.blockers.length ? (
        <ul style={{ margin: 0, paddingLeft: "1.1rem", lineHeight: 1.6 }}>
          {readiness.blockers.map((blocker) => (
            <li key={blocker.key}>
              <a href={`?tab=${blocker.tab}`} style={{ color: "inherit", fontWeight: 600 }}>
                {blocker.label}
              </a>{" "}
              — {blocker.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
