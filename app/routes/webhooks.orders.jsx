import { authenticate } from "../shopify.server";
import { intakeOrder } from "../services/orderIntake.server";

export const action = async ({ request }) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "ORDERS_CREATE":
    case "ORDERS_UPDATED":
    case "ORDERS_PAID":
    case "ORDERS_CANCELLED":
      await intakeOrder({ topic, shop, payload });
      break;
    default:
      break;
  }

  return new Response();
};
