import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { withMerchantAccess } from "../services/seller.server";
import { listSelectableImages, saveImageSelection } from "../services/importMediaSelection.server";

/**
 * The images a seller may choose from, and the choice they made.
 *
 * A RESOURCE ROUTE RATHER THAN A PAGE. The catalogue is a grid of products and
 * choosing images is a decision about one of them, so the panel opens inside the
 * card that raised it and this route answers with data. Making it a page of its
 * own would send the seller away from the catalogue to decide and back again,
 * losing their filters and their place.
 *
 * WHAT IS OFFERED IS NOT WHAT EXISTS. Only images that are offered to sellers
 * — switched on, not withdrawn, finished processing (see `mediaState`) — are
 * listed, and only image categories, because a document or a marketing file is
 * not something a storefront shows. That filter is applied in the service, so
 * the list a seller chooses from and the list an import sends come from one
 * expression rather than two that have to be kept in step.
 *
 * READING IS A PREVIEW, WRITING IS A DECISION. A store that may look at the
 * catalogue but may not import it can open the panel (VIEW) and cannot save a
 * selection (BUSINESS) — the same pair of gates the import itself uses.
 */

/**
 * The seller record, or a refusal.
 *
 * `withMerchantAccess` guarantees the ACCESS but not the record: a selection is
 * stored against a seller, and an account without one cannot have a selection —
 * so it is refused rather than dereferenced. In practice an approved store
 * always has one, which is why this reads as a guard rather than a branch.
 */
function requireSeller(seller: { id: string } | null): string {
  if (!seller) throw new Response("This account has no seller record yet.", { status: 403 });
  return seller.id;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") ?? "";
  if (!productId) throw new Response("Missing product.", { status: 400 });

  return withMerchantAccess(request, "VIEW", async (context) => {
    const view = await listSelectableImages(requireSeller(context.seller), productId);
    // A `defaulted` view has no saved rows yet: every eligible image is offered
    // ticked, and the panel says so rather than implying a choice was made.
    return { ...view, productId };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const productId = String(form.get("productId") || "");
  if (!productId) return { ok: false, error: "Missing product." };

  return withMerchantAccess(request, "BUSINESS", async (context) => {
    const result = await saveImageSelection({
      sellerId: requireSeller(context.seller),
      productId,
      // Ticked images arrive as repeated `imageId` fields; an unticked one is
      // absent rather than false, which is what makes "not chosen" and "chosen
      // and then removed" distinguishable on the server: the second has a row.
      selectedMediaAssetIds: form.getAll("imageId").map(String).filter(Boolean),
      mainMediaAssetId: String(form.get("mainImageId") ?? "") || null,
      // The full display order, so a reordering survives the round trip. Ids the
      // service does not recognise are dropped there and reported back.
      order: form.getAll("orderedId").map(String).filter(Boolean),
    });

    return {
      ok: true,
      selected: result.selected,
      ignored: result.ignored,
      message:
        result.ignored.length > 0
          ? `${result.ignored.length} image${result.ignored.length === 1 ? " was" : "s were"} no longer available and could not be saved.`
          : `Saved: ${result.selected} image${result.selected === 1 ? "" : "s"} will be imported.`,
    };
  });
}
