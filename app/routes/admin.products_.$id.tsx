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
  uploadMediaBatch,
  attachMediaToVariants,
  updateMedia,
  resolveUploadScope,
  setMediaVisibility,
  deleteMedia,
  detachMedia,
  setPrimaryAssignment,
  reorderAssignment,
  supersedeDocument,
  createTemplateAsset,
} from "~/services/media.server";
import { retryVideoProbe } from "~/services/mediaProbe.server";
import { publicationReadiness, PublicationRefused } from "~/services/publication.server";
import { previewMarketingPack } from "~/services/marketingPack.server";
import {
  getProductPackages,
  listPresetsForChoice,
  PackageValidationError,
  productHasSelectableVariants,
  resolvePackagesForVariant,
  saveProductPackages,
  saveVariantPackages,
  copyVariantPackaging,
} from "~/services/packaging.server";
import {
  clearOriginOverrides,
  missingOriginFields,
  resolveOriginForVariant,
  saveOriginMappings,
  type OriginLocation,
} from "~/services/origins.server";
import { card, INK, MUTED, catalogueValue, listValue } from "~/components/product/ui";
// Reading the preference only. It is CHANGED on the Settings page and nowhere
// else: one choice for the whole admin, made once, which is what makes a
// measurement mean the same thing on every page.
import { getUnitsPreference } from "~/services/adminPreferences.server";
import {
  enteredToCanonical,
  isUnitPreference,
  unitsView,
  type MeasureKind,
  type UnitPreference,
} from "~/utils/measurementUnits";
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
  /*
   * Every saved pack, retired ones included. The editors need the retired ones
   * to keep showing the pack a row already chose — dropping it from the list
   * would make the dropdown fall back to its first option and quietly unlink the
   * row the next time somebody saved that page.
   */
  const [presets, media, readiness, pack] = await Promise.all([
    listPresetsForChoice(),
    listProductMedia(productId),
    publicationReadiness(productId),
    // Describes the seller's pack without opening any of its files, so the
    // Marketing tab can show what will be handed over rather than describe it.
    previewMarketingPack(productId),
  ]);

  const held = permissionsFor(user.role);

  /*
   * The admin's unit preference, resolved once and handed to both tabs that
   * show a measurement. The form also carries it back on submit, so a value is
   * always interpreted in the unit its own label was written in.
   */
  const unitsPreference = await getUnitsPreference();

  /*
   * WHICH OF THE TWO EDITORS THIS PAGE DRAWS.
   *
   * One packaging editor per sellable configuration is the owner's rule, and
   * this single boolean is what both tabs obey: a product the seller chooses
   * between options keeps its cartons on the variants, and a simple one keeps
   * its carton on the product. Resolved here rather than inside either tab so
   * the two cannot disagree about which page owns the cartons — the same call
   * the quoting resolver and the migration make, from the same function.
   */
  const selectable = await productHasSelectableVariants(productId);

  return {
    product,
    presets,
    media,
    readiness,
    pack,
    unitsPreference,
    units: unitsView(unitsPreference),
    selectable,
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
     * Which packaging a redirect just saved, so the page can say so.
     *
     * Named rather than merely "saved": a confirmation with no subject is the
     * kind of message an operator learns to ignore, and this one has to answer
     * "did my carton go in" at a glance.
     */
    savedPackaging: savedPackagingLabel(url.searchParams.get("saved")),
    /**
     * What this person may do, resolved from their role. Used to decide which
     * controls are drawn — never as the control itself, which is the check in
     * the action and in the service behind it.
     */
    can: {
      manage: held.has("products.manage"),
      cost: held.has("products.cost.edit"),
      /*
       * Publishing is its own permission since the approval step was removed.
       * Drawn from here so the buttons match the policy; the control itself is
       * the check in the action and in the service behind it.
       */
      publish: held.has("products.publish"),
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
 *
 * THE UNIT DEFAULTS COME FROM THE PREFERENCE the form was drawn in, and they are
 * only defaults: a row always submits its own unit beside its own numbers. What
 * they cover is the row that submits neither — an operator who typed dimensions
 * into a row whose hidden unit fields were somehow absent — and the right answer
 * for that row is the unit those numbers were on screen in, which is the one the
 * page was rendered with.
 */
function packageRows(form: FormData, unitsPref: UnitPreference) {
  const view = unitsView(unitsPref);
  const at = (name: string, index: number) => String(form.getAll(name)[index] ?? "");
  return form.getAll("pkg_length").map((_, index) => {
    const shipsSeparately = form.get(`pkg_shipsSeparately_${index}`) === "true";
    return {
      label: at("pkg_label", index),
      packageType: at("pkg_packageType", index) || "carton",
      presetId: at("pkg_presetId", index) || null,
      length: at("pkg_length", index),
      width: at("pkg_width", index),
      height: at("pkg_height", index),
      dimensionUnit: at("pkg_dimUnit", index) || view.dimensionUnit,
      grossWeight: at("pkg_weight", index),
      weightUnit: at("pkg_weightUnit", index) || view.weightUnit,
      unitsPerPackage: at("pkg_unitsPerPackage", index) || "1",
      packagesPerUnit: at("pkg_packagesPerUnit", index) || "1",
      description: at("pkg_description", index) || null,
      declaredValue: at("pkg_declaredValue", index) || null,
      shipsSeparately,
      // A CARTON THAT SHIPS SEPARATELY IS NEVER MERGED, applied here as well as
      // in the service. Two reasons for the second copy: what this function
      // returns is echoed back to the form on a refusal, so it has to be the
      // value that would be stored; and a form is not the only thing that can
      // post to an action. A checkbox that is off submits nothing, so absence
      // means off — which is also the column default, and the safe reading: "we
      // were not told this may be merged" is not permission to merge it.
      consolidatable: shipsSeparately
        ? false
        : form.get(`pkg_consolidatable_${index}`) === "true",
    };
  });
}

/** The two intents that save packaging rows, and so can be handed back to a form. */
const PACKAGING_INTENTS = new Set(["save_packaging", "save_product_packages"]);

/** The intents whose success is announced on the page they return to. */
const SAVED_INTENTS = new Set([
  ...PACKAGING_INTENTS,
  "clear_origin_overrides",
  /*
   * Publishing and unpublishing announce themselves too.
   *
   * They used to be the one pair that did not: the page came back with the
   * readiness strip recoloured, and a merchant who pressed Publish and looked
   * at the products they had just changed saw a green band where an amber one
   * had been. That is a state, not an answer to a press — and the reported
   * complaint was precisely that pressing Publish appeared to do nothing.
   */
  "publish",
  "unpublish",
]);

/**
 * The sentence to show after a save, from the redirect's own marker.
 *
 * It states what a reader of the page below can check for themselves — the
 * cartons and the mapping drawn there are read back from the database — rather
 * than asserting that all is well.
 */
function savedPackagingLabel(saved: string | null): string | null {
  if (saved === "save_packaging") {
    return "Variant packaging saved. The cartons below are what is stored, and what a shipping quote will use.";
  }
  if (saved === "save_product_packages") {
    // Only reachable for a product sold as one configuration — a product sold
    // in choices keeps its cartons on the variants, and the save is refused
    // there (see `assertOneEditor`). Saying "variants inherit these" would
    // describe a rule that no longer exists.
    return "Product packaging saved. This product is sold as a single configuration, so these cartons are what a shipping quote uses.";
  }
  if (saved === "clear_origin_overrides") {
    return "Overrides cleared. The variants below now inherit the product's pickup location, which is what the column shows.";
  }
  /*
   * A PUBLISH IS ANNOUNCED AS A FACT ABOUT SELLERS, not as "saved".
   *
   * The only thing the merchant cannot verify from this page is whether anyone
   * else can now see the product, so that is the sentence. It says what became
   * true, and it does not claim the catalogue has caught up — the seller list
   * is a separate read and saying "sellers can see it now" would be a promise
   * about a cache this page does not own.
   */
  if (saved === "publish") {
    return "Published. The product is now offered to sellers, and appears in the seller catalogue.";
  }
  if (saved === "unpublish") {
    return "Unpublished. The product is a draft again and is no longer offered to sellers. Orders already placed are unaffected.";
  }
  return null;
}

/**
 * How many rows the form says it drew, or nothing if it does not say.
 *
 * This is the difference between "the operator removed every carton and saved"
 * and "the cartons never arrived", and it is the only thing that tells them
 * apart — see `assertClearWasIntended` in the service, which is where the
 * refusal lives so that no caller can skip it.
 */
function drawnRows(form: FormData): number | undefined {
  const stated = form.get("pkg_rowCount");
  if (stated === null) return undefined;
  const parsed = Number(stated);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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
  let intent = String(form.get("intent") || "");
  const tab = readTab(String(form.get("tab") || ""));

  const text = (name: string) => String(form.get(name) || "");
  const optional = (name: string) => {
    const value = String(form.get(name) ?? "").trim();
    return value === "" ? null : value;
  };

  /*
   * WHICH UNIT A SUBMITTED MEASUREMENT IS IN, taken from the form itself.
   *
   * The form carries the preference it was RENDERED with, and that is the one
   * this uses — not a fresh read from the database. They are the same in every
   * ordinary case, and they differ exactly when it matters: if somebody changes
   * the admin's units while this page is open, the operator is still looking at
   * boxes labelled in the old unit, and their 24 means what the label beside it
   * said. Reading the row again here would reinterpret their number under them.
   *
   * A form that carries no preference (an older page, a hand-made request)
   * falls back to the stored one, and a value that is neither falls back the
   * same way rather than throwing: the unit a number is in should never be
   * guessed from an error path.
   */
  const submittedUnits = form.get("units");
  const unitsPref = isUnitPreference(submittedUnits)
    ? submittedUnits
    : await getUnitsPreference();

  /**
   * A measurement the operator typed, as the canonical column value.
   *
   * Metric passes through untouched, which is what this route did before the
   * preference existed; imperial converts once and rounds once, to the scale
   * the column and its validator use.
   *
   * THE THREE CASES ARE THREE DIFFERENT ANSWERS, and the difference is the whole
   * reason this does not go through `optional()` beside it:
   *
   *   field not in the form  ->  undefined, which `updateVariant` reads as "not
   *                              supplied" and leaves the stored value alone.
   *                              This is what an input the operator never
   *                              touched submits as, and it is how an untouched
   *                              measurement stays byte-exact instead of being
   *                              round-tripped through a display conversion.
   *   field present but empty -> null, which clears it. The operator deleted
   *                              the number, and that is a decision.
   *   field present with text -> the number, converted once.
   *
   * `optional()` collapses the first two into null. For every other field on
   * this form that is right — an absent value there means an empty one — but
   * for a measurement it would silently erase the figure on every save that did
   * not retype it.
   */
  const measurementFor = (name: string, kind: MeasureKind) => {
    if (!form.has(name)) return undefined;
    return enteredToCanonical(String(form.get(name) ?? ""), kind, unitsPref);
  };
  /**
   * The variants a NEW upload claims. Read by `resolveUploadScope`, which treats
   * the scope radio as the decision it looks like and refuses a variant-scoped
   * file that named no size.
   *
   * `media_attach` below does NOT use this. That intent re-points an EXISTING
   * asset and its form has no scope radio at all — the hidden empty checkbox is
   * how it says "the family" — so it reads the list as posted.
   */
  const uploadScope = () => resolveUploadScope(form);
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
          /*
           * The form shows measurements in the admin's preferred unit, and
           * these columns are centimetres and kilograms whatever that
           * preference is. The conversion therefore happens here, on the way
           * in, and never in the component: a value that reached the service
           * in inches would be stored as inches and read as centimetres by
           * every quote, snapshot and carrier request built from it.
           *
           * `enteredToCanonical` returns the raw text unchanged when the
           * preference is metric, when the box is empty (which is how a
           * measurement is cleared) and when the text is not a number — so the
           * service's own validator still produces its own message for a typo.
           *
           * An input the operator did not touch is not submitted at all; the
           * form disables it so `updateVariant`'s partial semantics keep the
           * stored value byte-exact instead of round-tripping it through a
           * display conversion.
           */
          productLengthCm: measurementFor("productLengthCm", "length"),
          productWidthCm: measurementFor("productWidthCm", "length"),
          productHeightCm: measurementFor("productHeightCm", "length"),
          productWeightKg: measurementFor("productWeightKg", "weight"),
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
            variantIds: uploadScope(),
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

      /*
       * ONE FILE PER REQUEST, AND AN ANSWER PER FILE.
       *
       * WHAT THIS CASE IS FOR, NOW THAT IT IS NOT WHAT THE UPLOADER CALLS. The
       * uploader sends each file on its own and parses the answer with
       * `JSON.parse`, which a rendered document defeats and which this action
       * ALSO cannot answer, whatever URL it is reached by: React Router
       * serialises an action's result into its own envelope for the editor's
       * path, and into the same envelope for its `.data` twin. Neither is JSON
       * the uploader can read — the `.data` body is a turbo-stream array, which
       * `JSON.parse` accepts and which then has no `ok` on it. Measured, both.
       *
       * So the uploader has its own endpoint — the resource route at
       * `/admin/products/:id/media-batch`, which returns `Response.json`
       * verbatim — and this case remains for the tab that is still holding the
       * previous bundle. It does the same work through the same shared
       * function, so the two doors cannot refuse different things.
       *
       * EVERY OUTCOME IS A 200 WITH `ok` IN THE BODY, including the refusals.
       * A non-2xx would be handled by the browser's XHR error path, where the
       * body is often not readable, and "this file is a duplicate" would arrive
       * as "upload failed" — the one message that would have the uploader retry
       * a file that can never succeed.
       */
      case "media_upload_batch":
        return Response.json(await uploadMediaBatch(productId, form, actor));

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
            /*
             * NOT READ FROM THE FORM. A replacement version inherits the scope
             * of the version it replaces, taken from the record — see
             * `supersedeDocument`, which overwrites whatever arrives here. The
             * replacement form has no scope control at all, and says so.
             */
            variantIds: [],
            documentType: optional("documentType"),
            version: optional("version"),
            effectiveDate: optional("effectiveDate"),
            language: optional("language"),
          },
          actor
        );
        break;
      }

      /*
       * A TEMPLATE HAS NO FILE TO UPLOAD.
       *
       * `media_upload` above insists on one, so a link with nothing behind it
       * had to be smuggled in as a throwaway file and then described as a
       * template — which is why the template section of the marketing tab was
       * effectively unreachable. This case writes the row the row is: a title
       * and a link, with no bytes anywhere.
       */
      case "media_upload_template":
        await createTemplateAsset(
          productId,
          {
            title: text("title"),
            templateUrl: text("templateUrl"),
            instructions: optional("instructions"),
            variantIds: uploadScope(),
            sellerVisible: form.get("sellerVisible") === "true",
          },
          actor
        );
        break;

      case "media_probe_retry":
        await retryVideoProbe(text("assetId"), actor);
        break;

      case "media_update":
        await updateMedia(
          text("assetId"),
          {
            title: text("title"),
            /*
             * PRESENT BUT EMPTY CLEARS IT; ABSENT LEAVES IT ALONE.
             *
             * `optional()` collapses both to null, and for every other caller of
             * that helper an absent field does mean an empty one — but the write
             * this feeds treats null as "erase", so a form posted to change one
             * thing (the seller-visibility switch below) was blanking the alt
             * text of an image it never mentioned.
             */
            altText: form.has("altText") ? optional("altText") : undefined,
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
      /*
       * THERE IS NO APPROVE OR REJECT INTENT, and that is the correction rather
       * than an omission. A file an administrator uploads here is decided on
       * arrival — see `uploadMedia`, which creates it approved and switched on —
       * so the only moderation the panel used to offer was asking an
       * administrator to countersign their own upload. The moderation itself is
       * not gone: `setMediaApproval` remains in the media service, unchanged,
       * because a seller-submitted file will need exactly that workflow. When
       * that path is built it gets its own intents, on the interface that
       * reviews those submissions.
       *
       * WITHDRAWING AN ASSET IS STILL POSSIBLE, and it is the honest name for
       * what an administrator actually wants here: Deactivate (`media_update`
       * with `sellerVisible=false`) takes a file out of the seller's gallery and
       * leaves it on the product; Delete removes it under the existing guard,
       * which refuses to remove a live asset from a published product.
       */
      /*
       * The tile's Activate/Deactivate switch. Its own intent rather than an
       * `media_update`, because that write describes a whole asset and a form
       * posting one switch would have to carry every other field back with it.
       */
      case "media_visibility":
        await setMediaVisibility(text("assetId"), form.get("sellerVisible") === "true", actor);
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
        await saveVariantPackages(text("variantId"), packageRows(form, unitsPref), {
          drawnRows: drawnRows(form),
        });
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
        await saveProductPackages(productId, packageRows(form, unitsPref), {
          drawnRows: drawnRows(form),
        });
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

      /*
       * REMOVING AN OVERRIDE IS ITS OWN INTENT.
       *
       * It could have been folded into `save_origin`, and that is exactly what
       * must not happen: that intent also writes the product's default, so a
       * form posted just to clear one variant would carry no product location
       * and unmap the product as a side effect. This intent can only set the
       * named variants back to null — see `clearOriginOverrides`, which refuses
       * a variant that is not part of this product and audits what it removed.
       */
      case "clear_origin_overrides": {
        const variantIds = form.getAll("variantId").map(String).filter(Boolean);
        if (variantIds.length === 0) throw new Error("No variant override was selected to clear.");
        await clearOriginOverrides(productId, variantIds, { actorId: user.id, actorName: user.name });
        intent = "clear_origin_overrides";
        break;
      }

      default:
        throw new Error("Unknown action.");
    }
  } catch (error) {
    /*
     * A refused packaging save comes back holding what was refused.
     *
     * The page is rendered from the loader, and the loader reads the database.
     * So a refusal used to re-render the form from what was stored BEFORE the
     * operator typed — one missing weight cost them every number on the page,
     * and the form gave no sign it had done it. The echo is the submission
     * itself, parsed by the same function the save uses, so what comes back is
     * exactly what was sent, in the units it was sent in.
     */
    if (error instanceof PackageValidationError) {
      return {
        error: error.message,
        publishRefused: false,
        tab,
        packageErrors: error.details,
        packageValues: PACKAGING_INTENTS.has(intent) ? packageRows(form, unitsPref) : null,
        // Which editor gets the echo back. A variant's rows belong to one
        // variant, and the page holds an editor per variant — so a variant save
        // that somehow arrived without one is treated as the product-level
        // editor's business rather than as every variant's.
        packageVariantId: intent === "save_packaging" ? text("variantId") || null : null,
      };
    }

    /*
     * A REFUSED PUBLISH IS DRAWN ONCE, AND THE STRIP IS WHERE.
     *
     * The refusal carries the same checks the readiness strip already renders
     * from the loader. Returning its message as `error` as well printed the
     * list twice on one screen — amber in the strip, red in the alert — with
     * only the amber copy linking to the tabs that fix anything. So no message
     * travels here: the flag says the press happened, and the strip is what
     * says why it did not take. `publishRefused` is what turns the strip from a
     * statement of readiness into the answer to a button press.
     */
    if (error instanceof PublicationRefused) {
      return {
        error: null,
        publishRefused: true,
        tab,
        packageErrors: null,
        packageValues: null,
        packageVariantId: null,
      };
    }

    return {
      error: error instanceof Error ? error.message : "Operation failed.",
      publishRefused: false,
      tab,
      packageErrors: null,
      packageValues: null,
      packageVariantId: null,
    };
  }

  /*
   * Back to the tab the form was on, so a save does not move the reader — and
   * carrying what was saved, so the page can say so. A redirect lands on a page
   * that looks identical to the one the button was pressed on, which makes a
   * save that worked and a save that silently did nothing impossible to tell
   * apart. That is how the reported failure stayed invisible.
   */
  const saved = SAVED_INTENTS.has(intent) ? `&saved=${intent}` : "";
  return redirect(`/admin/products/${productId}?tab=${tab}${saved}`);
}

export default function AdminProductDetail() {
  const { product, presets, media, readiness, pack, shipping, tab, can, units, savedPackaging, selectable } =
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

        {/*
          THE PUBLISH CONTROL, BESIDE THE NAME AND THE STATE IT CHANGES.

          It used to live at the bottom of the Details tab, inside that tab's
          form, several screens below the readiness strip that explains it. Two
          things were wrong with that, and only one of them is cosmetic. The
          control was reachable only from one tab, so a merchant who fixed the
          last outstanding item on the Media tab had to navigate to Details to
          act on it; and "Publish to sellers" sat under a column of shipping
          fields, which is not where anybody looks for the switch that puts a
          product in front of buyers.

          Its own form, not a submit button on the details form: pressing it must
          not also save a half-typed description, and the details form has its
          own Save. `tab` travels with it so the page comes back where the
          reader was rather than jumping to Details.

          The label states the product's state rather than an action name —
          "Unpublish" when it is live — and the tooltip says what will happen to
          existing orders, which is the question sellers actually ask.
        */}
        {can.publish ? (
          <Form method="post" style={{ flexShrink: 0 }}>
            <input type="hidden" name="tab" value={tab} />
            <button
              type="submit"
              name="intent"
              value={product.status === "PUBLISHED" ? "unpublish" : "publish"}
              style={{
                padding: "0.55rem 1rem",
                border: `1px solid ${product.status === "PUBLISHED" ? "#92400e" : "#065f46"}`,
                borderRadius: 8,
                background: product.status === "PUBLISHED" ? "#fffbeb" : "#ecfdf5",
                color: product.status === "PUBLISHED" ? "#92400e" : "#065f46",
                fontSize: "0.82rem",
                fontWeight: 700,
                cursor: "pointer",
              }}
              title={
                product.status === "PUBLISHED"
                  ? "Withdraw this product from sellers. Existing orders are unaffected."
                  : readiness.ready
                    ? "Make this product available to sellers."
                    : "This product does not meet the publication requirements yet — the list below says what is missing."
              }
            >
              {product.status === "PUBLISHED" ? "Unpublish" : "Publish to sellers"}
            </button>
          </Form>
        ) : null}
      </div>

      {/* Publication state is shown on every tab, because "is this live?" is
          the question a merchant has most often and the answer must not depend
          on which tab they happen to be looking at. */}
      <ReadinessStrip
        readiness={readiness}
        status={product.status}
        refused={actionData?.publishRefused === true}
      />

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
          {/* Where the refusal was a packaging row, say which control to fix
              rather than leaving the operator to find it in the wall of text. */}
          {actionData.packageErrors?.length ? (
            <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
              {actionData.packageErrors.slice(0, 6).map((problem) => (
                <li key={`${problem.index}-${problem.field}`}>{problem.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* A save that worked has to look different from one that did nothing.
          See `savedPackagingLabel`. */}
      {savedPackaging ? (
        <div
          role="status"
          style={{
            ...card,
            background: "#f0fdf4",
            borderColor: "#bbf7d0",
            color: "#166534",
            fontSize: "0.85rem",
          }}
        >
          {savedPackaging}
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
          readiness={readiness}
          canManage={can.manage}
          canPublish={can.publish}
        />
      ) : null}
      {tab === "variants" ? (
        <VariantsTab
          product={product}
          presets={presets}
          canEditCost={can.cost}
          units={units}
          selectable={selectable}
          refused={
            actionData?.packageVariantId === null || actionData?.packageVariantId === undefined
              ? null
              : {
                  variantId: actionData.packageVariantId,
                  problems: actionData.packageErrors ?? [],
                  values: actionData.packageValues ?? null,
                }
          }
        />
      ) : null}
      {tab === "shipping" && shipping ? (
        <ShippingTab
          product={{
            id: product.id,
            name: product.name,
            // Read only to seed a new carton row's description — see
            // `newCartonText`. The narrow object is deliberate: this tab has no
            // business with the rest of the family record.
            description: product.description,
            pickupLocationId: product.pickupLocationId,
          }}
          variants={shipping.variants}
          locations={shipping.locations}
          packages={shipping.packages}
          presets={presets}
          canManage={can.manage}
          units={units}
          selectable={selectable}
          refused={
            !actionData?.packageVariantId && actionData?.packageValues
              ? { problems: actionData.packageErrors ?? [], values: actionData.packageValues }
              : null
          }
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
  refused,
}: {
  readiness: { ready: boolean; checks: { key: string; label: string; ok: boolean; detail: string; tab: TabKey }[]; blockers: { key: string; label: string; detail: string; tab: TabKey }[] };
  status: string;
  /** The last action was a Publish press that the gate refused. */
  refused: boolean;
}) {
  const published = status === "PUBLISHED";
  /*
   * REFUSED IS THE RED ONE, and it is the same list. A press that did not take
   * has to be distinguishable from a page that merely is not ready — otherwise
   * the button looks broken — and the way to distinguish it is the headline and
   * the colour, not a second copy of the reasons underneath.
   */
  const tone = published
    ? { bg: "#ecfdf5", border: "#a7f3d0", fg: "#065f46" }
    : refused
      ? { bg: "#fef2f2", border: "#fecaca", fg: "#991b1b" }
      : readiness.ready
        ? { bg: "#f0f9ff", border: "#bae6fd", fg: "#075985" }
        : { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" };

  return (
    <div
      role={refused ? "alert" : undefined}
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
          : refused
            ? `Publish was refused — ${readiness.blockers.length} check${readiness.blockers.length === 1 ? "" : "s"} did not pass. Nothing was changed.`
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
      {refused && readiness.blockers.length ? (
        <p style={{ margin: "0.5rem 0 0", opacity: 0.85 }}>
          Each line opens the tab that resolves it. The product is still a draft.
        </p>
      ) : null}
    </div>
  );
}
