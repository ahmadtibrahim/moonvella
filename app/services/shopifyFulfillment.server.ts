import { prisma } from "~/db.server";
import { setIntegrationState } from "./integrationHealth.server";

/**
 * Resolve Shopify fulfillment orders for a supplier order and map MoonVella line
 * items, so tracking can later be pushed to the correct fulfillment order.
 *
 * Handles: correct seller/shop, assigned fulfillment orders, MoonVella line
 * items only, remaining (partial) quantities, and safe retry (idempotent).
 *
 * If scopes / protected customer data access block the call, the exact blocker
 * is surfaced and stored on the integration state — we never bypass it.
 */
export interface ResolvedFulfillmentItem {
  fulfillmentOrderLineItemId: string;
  lineItemId: string | null;
  variantId: string | null;
  remainingQuantity: number;
  totalQuantity: number;
  sku: string | null;
  name: string | null;
}

export interface ResolvedFulfillmentGroup {
  fulfillmentOrderId: string;
  status: string;
  assignedLocation: string | null;
  items: ResolvedFulfillmentItem[];
}

interface ShopifyFulfillmentOrderNode {
  id: string;
  status: string;
  assignedLocation?: { name?: string | null } | null;
  lineItems?: {
    nodes?: {
      id: string;
      remainingQuantity: number;
      totalQuantity: number;
      lineItem?: {
        id?: string | null;
        sku?: string | null;
        name?: string | null;
        variant?: { id?: string | null } | null;
      } | null;
    }[];
  } | null;
}

export async function resolveFulfillmentOrders(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { seller: true, items: true },
  });
  if (!order) throw new Error("Order not found.");

  const mappings = await prisma.sellerProductVariant.findMany({
    where: { sellerProduct: { sellerId: order.sellerId } },
    include: { productVariant: true },
  });
  const moonvellaSkus = new Set([
    ...order.items.map((i) => i.sku),
    ...mappings.map((m) => m.productVariant.sku),
  ]);

  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(order.seller.shopDomain);

    const gid = order.shopifyOrderId.startsWith("gid://")
      ? order.shopifyOrderId
      : `gid://shopify/Order/${order.shopifyOrderId}`;

    const query = `#graphql
      query MoonVellaResolveFO($id: ID!, $after: String) {
        order(id: $id) {
          id
          fulfillmentOrders(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              status
              assignedLocation { name }
              lineItems(first: 100) {
                nodes {
                  id
                  remainingQuantity
                  totalQuantity
                  lineItem { id sku name variant { id } }
                }
              }
            }
          }
        }
      }`;

    // Page through every fulfillment order so multi-location / multi-group
    // orders are not silently truncated.
    const nodes: ShopifyFulfillmentOrderNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await admin.graphql(query, { variables: { id: gid, after } });
      const json: {
        data?: {
          order?: {
            fulfillmentOrders?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
              nodes?: ShopifyFulfillmentOrderNode[];
            } | null;
          } | null;
        };
        errors?: { message: string }[];
      } = await res.json();
      if (Array.isArray(json?.errors) && json.errors.length) {
        throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
      }

      const connection = json?.data?.order?.fulfillmentOrders;
      nodes.push(...(connection?.nodes ?? []));
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor ?? null;
      if (!after) break;
    }

    const groups: ResolvedFulfillmentGroup[] = [];
    let primary: string | null = null;

    for (const fo of nodes) {
      const mvItems = (fo.lineItems?.nodes ?? []).filter(
        (li) => li.lineItem?.sku && moonvellaSkus.has(li.lineItem.sku)
      );
      if (mvItems.length === 0) continue;
      if (!primary) primary = fo.id;
      groups.push({
        fulfillmentOrderId: fo.id,
        status: fo.status,
        assignedLocation: fo.assignedLocation?.name ?? null,
        items: mvItems.map((li) => ({
          fulfillmentOrderLineItemId: li.id,
          lineItemId: li.lineItem?.id ?? null,
          variantId: li.lineItem?.variant?.id ?? null,
          remainingQuantity: li.remainingQuantity,
          totalQuantity: li.totalQuantity,
          sku: li.lineItem?.sku ?? null,
          name: li.lineItem?.name ?? null,
        })),
      });
    }

    if (primary) {
      await prisma.order.update({
        where: { id: orderId },
        data: { shopifyFulfillmentOrderId: primary },
      });
    }

    await setIntegrationState("shopify_fulfillment", {
      status: groups.length ? "HEALTHY" : "NOT_CONFIGURED",
      detail: groups.length
        ? `Resolved ${groups.length} fulfillment order group(s) with MoonVella items.`
        : "No fulfillment orders with MoonVella items were found yet (order may be unfulfilled/unassigned).",
    });

    return { fulfillmentOrderId: primary, groups, totalFulfillmentOrders: nodes.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "resolve failed";
    await setIntegrationState("shopify_fulfillment", { status: "FAILED", error: message });
    throw new Error(
      `Could not resolve Shopify fulfillment orders: ${message}. Required: ` +
        `the app must have the fulfillment-order scopes (read/write_merchant_managed_fulfillment_orders, ` +
        `read/write_assigned_fulfillment_orders), a stored offline session for ${order.seller.shopDomain}, ` +
        `and protected customer data approval for order/customer fields.`
    );
  }
}
