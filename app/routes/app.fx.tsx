import type { LoaderFunctionArgs } from "react-router";
import { withMerchantAccess } from "../services/seller.server";
import { currentUsdRate } from "../services/fx.server";

/**
 * The exchange rate the seller's USD view is converted at.
 *
 * A RESOURCE ROUTE, ASKED FOR ON DEMAND. The rate comes from Odoo — see
 * `services/fx` — and putting that read on the page path would make every page
 * of every seller wait on an outbound call for a number most of them will never
 * print. The merchant layout therefore sends no rate at all, and the currency
 * control asks for one here the first time somebody selects US dollars.
 *
 * A MISSING RATE IS A 200, NOT AN ERROR. Null means "no rate could be read
 * honestly", which the interface acts on by keeping the Canadian view and saying
 * why. Answering with a failure status would turn a deployment without an Odoo
 * rate into a broken-looking merchant app.
 *
 * VIEW rather than BUSINESS: reading a rate decides nothing and prices nothing,
 * and a store that may look at the catalogue may look at it in either currency.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return withMerchantAccess(request, "VIEW", async () => {
    const rate = await currentUsdRate();
    return rate
      ? { rate: rate.rate, asOf: rate.asOf }
      : { rate: null, asOf: null };
  });
}
