import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { packingListFor, renderPackingList } from "~/services/packingList.server";

/**
 * The printable packing list for one shipment.
 *
 * A DOCUMENT, NOT A PAGE. It answers with HTML built for paper — no admin shell,
 * no navigation, no scripts — because it is opened to be printed or saved and
 * anything else on it would end up in the box. The route is a resource route
 * for the same reason: there is no UI here to render.
 *
 * It carries no money. Not the wholesale price, not the seller's shipping
 * charge, not the carrier cost — see packingList.server, where that is a
 * property of which columns are read rather than of the template.
 *
 * Gated on shipping.view to match the shipment page it is linked from. It reads
 * one shipment and discloses nothing the page does not already show, so an
 * operator who can see the shipment can print its paperwork.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");

  const list = await packingListFor(String(params.shipmentId));
  if (!list) throw new Response("Shipment not found", { status: 404 });

  // ?download=1 asks the browser to save the file rather than display it. Both
  // actions are offered on the document itself so the choice is made where the
  // operator is looking, not somewhere else that has to be remembered.
  const download = new URL(request.url).searchParams.get("download") === "1";
  const safeName = `${list.orderName}-${list.reference}`.replace(/[^A-Za-z0-9._-]+/g, "-");

  return new Response(renderPackingList(list), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Generated from live order data, so it is never cached: an intermediate
      // copy of a customer's name and address is not something to leave lying
      // around, and a stale packing list is worse than none.
      "Cache-Control": "no-store",
      ...(download ? { "Content-Disposition": `attachment; filename="packing-list-${safeName}.html"` } : {}),
    },
  });
}
