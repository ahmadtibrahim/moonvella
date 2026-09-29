import type { LoaderFunctionArgs } from "react-router";
import { withMerchantAccess } from "../services/seller.server";
import { packingListFor, renderPackingList, renderPackingSlipPdf } from "../services/packingList.server";

/**
 * The packing list, from the seller's side.
 *
 * OWNERSHIP IS THE FIRST THING DECIDED. The seller id is passed into the query
 * rather than compared with the result, so a seller asking for somebody else's
 * shipment matches no row and there is nothing loaded to leak by a later edit.
 * The store must also still be allowed to read its orders — a blocked store is
 * refused by the gate, a suspended one keeps its history, which is the same
 * rule its order list already follows.
 *
 * What it shows is what the buyer sees in the box: the seller's branding, the
 * items, the quantities and the parcels. No prices of any kind — not the
 * wholesale price, not the shipping charge, not the carrier cost.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) =>
  withMerchantAccess(request, "VIEW", async (context) => {
    if (!context.seller || !context.canViewOrders) {
      throw new Response("Packing lists are not available for this account.", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const list = await packingListFor(String(params.shipmentId), { sellerId: context.seller.id });
    if (!list) throw new Response("Shipment not found", { status: 404 });

    /*
     * Download answers with a real PDF and Print with the page, the same two
     * answers the admin route gives — a seller and an operator must not get
     * different documents for the same button, and this is the copy that ends up
     * in the customer's hands.
     */
    const download = new URL(request.url).searchParams.get("download") === "1";
    /*
     * The ORDER's name and not the shipment's reference: this string becomes the
     * customer's own filename, and the reference is an internal id — the same
     * reason the document itself no longer prints one.
     */
    const safeName = list.orderName.replace(/[^A-Za-z0-9._-]+/g, "-");
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
  });
