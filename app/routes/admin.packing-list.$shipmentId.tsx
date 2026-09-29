import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { packingListFor, renderPackingList, renderPackingSlipPdf } from "~/services/packingList.server";

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

  /*
   * TWO ACTIONS, TWO DOCUMENTS. Download is a real PDF with a .pdf name, because
   * it is the one that leaves this system and is opened somewhere else. Print is
   * the page itself, which needs no library and no network to render — the
   * warehouse's printer is not this server's problem. The content is the same
   * document either way: both are built from this one `PackingList`.
   */
  const download = new URL(request.url).searchParams.get("download") === "1";
  /*
   * The ORDER's name, and not the shipment's reference. This string becomes the
   * customer's own filename, and the reference is an internal id — the same
   * reason the document itself no longer prints one.
   */
  const safeName = list.orderName.replace(/[^A-Za-z0-9._-]+/g, "-");
  // Generated from live order data, so it is never cached: an intermediate copy
  // of a customer's name and address is not something to leave lying around, and
  // a stale packing list is worse than none.
  const cacheControl = { "Cache-Control": "no-store" };

  if (download) {
    const pdf = await renderPackingSlipPdf(list);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.byteLength),
        "Content-Disposition": `attachment; filename="packing-slip-${safeName}.pdf"`,
        ...cacheControl,
      },
    });
  }

  return new Response(renderPackingList(list), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...cacheControl },
  });
}
