import { prisma } from "~/db.server";
import { setIntegrationState } from "./integrationHealth.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

/**
 * Whose shelf the goods are on, and who is allowed to ship them.
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE. When Shopify takes an order, it routes
 * each line to a location and wraps the result in a fulfillment order. A store
 * that has never been configured has exactly one location — "Shop location",
 * the merchant's own shelf — so every line is routed there, and the fulfillment
 * order assigned to it belongs to the MERCHANT. MoonVella is not the merchant:
 * it is a supplier shipping on the merchant's behalf, and it has no business
 * fulfilling out of a location the merchant believes holds their own stock.
 * Worse, the arrangement is a lie in both directions — the merchant's inventory
 * count includes goods that are not on their shelf, and MoonVella ships goods
 * the store's records say are somewhere else.
 *
 * THE SHAPE OF THE FIX. Each store gets one MoonVella fulfillment service with
 * its own dedicated location, created on first use and its ids saved on the
 * Seller row. MoonVella stock lives there and nowhere else, and the fulfillment
 * orders for MoonVella lines are moved there before anything is shipped. A
 * fulfillment order with no MoonVella lines on it is never touched: the
 * merchant has other suppliers and other products, and moving their fulfillment
 * orders to MoonVella's location would hand MoonVella the merchant's own
 * shipping.
 *
 * WHY THE IDS ARE SAVED RATHER THAN LOOKED UP. Both objects are created by
 * Shopify with generated ids. Re-resolving them by name on every run would
 * eventually meet a second location with a similar name — created by hand, by
 * another app, or by an earlier run that failed between creating and saving —
 * and pick the wrong one. An id saved on the seller row is unambiguous, and
 * `fulfillmentLocationCheckedAt` says when it was last confirmed to still
 * exist.
 *
 * EVERY FAILURE HERE IS REPORTED, NEVER WORKED AROUND. Creating a fulfillment
 * service needs `write_fulfillments`; moving a fulfillment order needs
 * `write_merchant_managed_fulfillment_orders`; reading either needs Protected
 * Customer Data approval. When one is missing, Shopify says so by name, and the
 * exact sentence is stored on the integration row and returned in the error.
 * Nothing in this file invents a location id, falls back to "Shop location",
 * or pretends a route happened.
 */

/**
 * The Shopify admin client, as this module uses it.
 *
 * Structurally the framework's own client — the same `graphql` call, the same
 * `Response` back — so passing the real one is always valid. It is named here
 * because the two functions below take one optionally, which is how a suite can
 * drive routing and service creation against a store that answers from a table
 * rather than from Shopify. That is not a testing convenience bolted on: the
 * question "does this fulfillment order get moved to MoonVella's location" is
 * about which call we build and how we read the answer, and both halves are
 * decidable without a merchant's store.
 */
export interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<Response>;
}

/**
 * The store's client, or the injected stand-in.
 *
 * Deliberately the only place that reaches for a session, so a suite that
 * injects a client cannot accidentally hit the real one from some other line.
 */
async function adminFor(shopDomain: string, override?: AdminClient): Promise<AdminClient> {
  if (override) return override;
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin as unknown as AdminClient;
}

export interface ResolvedFulfillmentItem {
  fulfillmentOrderLineItemId: string;
  lineItemId: string | null;
  variantId: string | null;
  remainingQuantity: number;
  totalQuantity: number;
  sku: string | null;
  name: string | null;
}

/**
 * Where one fulfillment order's goods are going.
 *
 * READ FROM THE SAME FULFILLMENT ORDER AS THE QUANTITIES, ALWAYS. Shopify splits
 * an order across fulfillment orders by location and by delivery group, and two
 * of them can carry different destinations — a gift to a second address, a
 * partial ship. A parcel fulfils one group's lines, so the address on the label
 * belongs to that group; taking the first destination seen and pairing it with
 * another group's quantities is how a box of one customer's goods gets sent to
 * another's address. This is carried on the group, beside the lines it came
 * with, rather than looked up separately by the caller.
 */
export interface ResolvedFulfillmentDestination {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  countryCode: string | null;
  zip: string | null;
}

export interface ResolvedFulfillmentGroup {
  fulfillmentOrderId: string;
  status: string;
  assignedLocation: string | null;
  /** The location's id, so routing can tell whether it is already ours. */
  assignedLocationId: string | null;
  /** The destination belonging to THIS fulfillment order, with its own lines. */
  destination: ResolvedFulfillmentDestination | null;
  items: ResolvedFulfillmentItem[];
}

interface ShopifyFulfillmentOrderNode {
  id: string;
  status: string;
  assignedLocation?: {
    location?: { id?: string | null; name?: string | null } | null;
  } | null;
  destination?: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    countryCode?: string | null;
    zip?: string | null;
  } | null;
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

/**
 * The numeric tail of a Shopify id.
 *
 * Shopify writes the same object two ways in the same payload: a webhook says
 * `"id": 7343191818486` and GraphQL says `"id": "gid://shopify/LineItem/7343191818486"`.
 * The stored binding is the webhook's form and the comparison here is against
 * GraphQL's, so both are reduced to the number they share. Comparing the raw
 * strings is the bug this prevents — it never matches, and the failure surfaces
 * as "no MoonVella lines on this order" on an order that is entirely MoonVella
 * lines.
 *
 * It takes a number as well as a string because the two spellings are not the
 * only difference: the webhook's form is genuinely a JSON number, so a caller
 * that types its payload honestly — as intake does — holds a number and would
 * otherwise have to stringify it at each call site. Narrowing this to strings
 * pushed that conversion back out to the callers, which is how one of them
 * ends up doing it differently from the rest.
 */
export function numericId(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  if (!text) return "";
  const tail = text.startsWith("gid://") ? text.slice(text.lastIndexOf("/") + 1) : text;
  return tail.split("?")[0];
}

/**
 * Resolve Shopify fulfillment orders for a supplier order and map the MoonVella
 * lines on them, so routing and tracking can act on the right ones.
 *
 * WHICH LINES ARE OURS IS ANSWERED BY THE STORED BINDING, NOT BY THE SKU.
 *
 * The line the customer bought was matched to a MoonVella variant when the
 * order was taken in, and the Shopify line item id that matched it was written
 * onto the OrderItem. That is the authoritative statement of ownership: it was
 * made once, against the catalogue, and it does not change when somebody edits
 * a SKU or reuses one. Matching on the SKU instead — which is what this used to
 * do — means a merchant who happens to sell a product with the same SKU has
 * their line claimed by MoonVella, and a merchant who corrects a typo in their
 * SKU has their real MoonVella line silently dropped. SKU is kept only as a
 * FALLBACK for a line whose binding is missing, and every use of the fallback
 * is recorded in the audit so it can be reviewed rather than trusted.
 *
 * If scopes or protected customer data access block the call, the exact blocker
 * is surfaced and stored on the integration state — it is never bypassed.
 */
export async function resolveFulfillmentOrders(orderId: string, adminOverride?: AdminClient) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { seller: true, items: true },
  });
  if (!order) throw new Error("Order not found.");

  const boundLineItemIds = new Set(order.items.map((i) => numericId(i.shopifyLineItemId)));
  const boundSkus = new Set(order.items.map((i) => i.sku).filter(Boolean));

  try {
    const admin = await adminFor(order.seller.shopDomain, adminOverride);

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
              assignedLocation { location { id name } }
              # The destination of THIS fulfillment order, read beside its own
              # lines and carried on the group with them rather than looked up
              # separately by the caller. See ResolvedFulfillmentDestination.
              destination { firstName lastName company address1 address2 city province countryCode zip }
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
    const matchedByFallback: string[] = [];
    let primary: string | null = null;

    for (const fo of nodes) {
      const mvItems: ResolvedFulfillmentItem[] = [];
      for (const li of fo.lineItems?.nodes ?? []) {
        const lineItemId = li.lineItem?.id ?? null;
        const byBinding = boundLineItemIds.has(numericId(lineItemId));
        const bySkuFallback = !byBinding && Boolean(li.lineItem?.sku) && boundSkus.has(li.lineItem!.sku!);
        if (!byBinding && !bySkuFallback) continue;
        if (bySkuFallback) matchedByFallback.push(li.lineItem?.sku ?? "(no sku)");
        mvItems.push({
          fulfillmentOrderLineItemId: li.id,
          lineItemId,
          variantId: li.lineItem?.variant?.id ?? null,
          remainingQuantity: li.remainingQuantity,
          totalQuantity: li.totalQuantity,
          sku: li.lineItem?.sku ?? null,
          name: li.lineItem?.name ?? null,
        });
      }
      if (mvItems.length === 0) continue;
      if (!primary) primary = fo.id;
      const destination = fo.destination ?? null;
      groups.push({
        fulfillmentOrderId: fo.id,
        status: fo.status,
        assignedLocation: fo.assignedLocation?.location?.name ?? null,
        assignedLocationId: fo.assignedLocation?.location?.id ?? null,
        // `?? null` on each field rather than `Boolean(...)`: an empty string is
        // what Shopify sends for a field the customer left blank, and turning
        // that into null here would be this code inventing a value's absence.
        destination: destination
          ? {
              firstName: destination.firstName ?? null,
              lastName: destination.lastName ?? null,
              company: destination.company ?? null,
              address1: destination.address1 ?? null,
              address2: destination.address2 ?? null,
              city: destination.city ?? null,
              province: destination.province ?? null,
              countryCode: destination.countryCode ?? null,
              zip: destination.zip ?? null,
            }
          : null,
        items: mvItems,
      });
    }

    if (primary) {
      await prisma.order.update({
        where: { id: orderId },
        data: { shopifyFulfillmentOrderId: primary },
      });
    }

    if (matchedByFallback.length) {
      await recordAudit(
        {
          actorType: "SYSTEM",
          actorId: "shopify-fulfillment",
          actorName: "Shopify fulfillment",
          action: "fulfillment.matched_by_sku",
          entityType: AUDIT_ENTITY.ORDER,
          entityId: orderId,
          afterData: {
            skus: matchedByFallback,
            note:
              "These lines matched by SKU because no stored Shopify line-item binding was found for them. " +
              "The binding is authoritative; a SKU match is a diagnosis, not ownership.",
          },
        },
        prisma as never
      );
    }

    await setIntegrationState("shopify_fulfillment", {
      status: groups.length ? "HEALTHY" : "NOT_CONFIGURED",
      detail: groups.length
        ? `Resolved ${groups.length} fulfillment order group(s) with MoonVella items` +
          (matchedByFallback.length ? ` (${matchedByFallback.length} matched by SKU fallback).` : ".")
        : "No fulfillment orders with MoonVella items were found yet (order may be unfulfilled/unassigned).",
    });

    return {
      fulfillmentOrderId: primary,
      groups,
      totalFulfillmentOrders: nodes.length,
      matchedByFallback,
    };
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

/* -------------------------------------------------------------------------- */
/* The MoonVella fulfillment service and its location                          */
/* -------------------------------------------------------------------------- */

/** What the store's MoonVella fulfillment service is called, on both sides. */
export const MOONVELLA_FULFILLMENT_SERVICE_NAME = "MoonVella";

export interface FulfillmentLocation {
  serviceId: string;
  locationId: string;
  locationName: string;
  /** True when this call created the service rather than finding it. */
  created: boolean;
}

export class FulfillmentSetupBlocked extends Error {
  readonly permanent = true;
  constructor(
    message: string,
    readonly blocker: "SCOPE" | "PROTECTED_CUSTOMER_DATA" | "SESSION" | "OTHER"
  ) {
    super(message);
    this.name = "FulfillmentSetupBlocked";
  }
}

/**
 * Classify Shopify's refusal, so the operator is told which door is shut.
 *
 * The three refusals this code can meet look nothing alike in the API and are
 * easy to conflate in a message, and they are fixed in three different places:
 * a scope is a config change, Protected Customer Data is a Partner Dashboard
 * review, and a missing session is an app reinstall. A single "access denied"
 * message sends the operator to the wrong one of those two times out of three.
 */
export function classifyRefusal(message: string): FulfillmentSetupBlocked {
  const text = message.toLowerCase();
  /*
   * TWO SPELLINGS, AND THE SECOND IS THE ONE THAT MATTERS HERE.
   *
   * Registering a subscription is refused with "...topics containing protected
   * customer data". READING an object is refused with "This app is not approved
   * to access the Order object. See https://shopify.dev/docs/apps/launch/
   * protected-customer-data" — a hyphenated URL, so the phrase with spaces
   * never appears and the refusal that blocks the whole pipeline was classified
   * as OTHER. A blocked read and an unclassified error look the same to
   * whoever has to fix it, and only one of them names the fix.
   */
  if (
    text.includes("protected customer data") ||
    text.includes("protected-customer-data") ||
    text.includes("not approved to access")
  ) {
    return new FulfillmentSetupBlocked(
      `${message} — this app must be approved for Protected Customer Data in the Shopify Partner Dashboard ` +
        `before it can read orders or fulfillment orders.`,
      "PROTECTED_CUSTOMER_DATA"
    );
  }
  if (text.includes("access scope") || text.includes("access denied")) {
    return new FulfillmentSetupBlocked(
      `${message} — this store's installation predates the write_fulfillments and write_locations permissions; the merchant must approve the newly required scopes through Shopify's app-update prompt in their admin.`,
      "SCOPE"
    );
  }
  if (text.includes("session") || text.includes("offline")) {
    return new FulfillmentSetupBlocked(
      `${message} — there is no usable offline session for this store; the app must be reinstalled.`,
      "SESSION"
    );
  }
  return new FulfillmentSetupBlocked(message, "OTHER");
}

/**
 * Ensure this store has a MoonVella fulfillment service with a location of its
 * own, and return its ids.
 *
 * Idempotent in both directions: the ids on the Seller row short-circuit the
 * work entirely once they exist, and the lookup by name means a run that
 * created the service but died before saving its id adopts the service it made
 * rather than creating a second one. Shopify does not prevent two fulfillment
 * services with the same name, so a duplicate would be created silently and
 * would be very hard to unpick afterwards — half the catalogue's stock at one
 * and half at the other.
 *
 * THE LOCATION IS NOT CREATED SEPARATELY. `fulfillmentServiceCreate` makes one
 * as part of the service, and that is the location MoonVella stock belongs at.
 * Creating a second location by hand would give MoonVella two places to put the
 * same goods, which is exactly the "inventory at both locations" this must not
 * do.
 */
export async function ensureMoonvellaFulfillmentService(
  sellerId: string,
  adminOverride?: AdminClient
): Promise<FulfillmentLocation | null> {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller) throw new Error("Seller not found.");

  if (seller.shopifyFulfillmentServiceId && seller.shopifyFulfillmentLocationId) {
    return {
      serviceId: seller.shopifyFulfillmentServiceId,
      locationId: seller.shopifyFulfillmentLocationId,
      locationName: `${MOONVELLA_FULFILLMENT_SERVICE_NAME} fulfillment`,
      created: false,
    };
  }

  const admin = await adminFor(seller.shopDomain, adminOverride);

  /*
   * WHERE THE FIELD ACTUALLY IS, read from the schema rather than guessed.
   *
   * This asked `QueryRoot.fulfillmentServices(first: 50) { nodes { … } }`, and
   * the sandbox refused it: there is no such root field. Introspection at this
   * app's API version (2026-10) gives both halves of the answer, and both are
   * different from what the old query assumed — `fulfillmentServices` is a field
   * of `Shop`, and it is `[FulfillmentService!]!`: a plain list with no
   * arguments and no connection. So there is no `first:` to pass and no `nodes`
   * to unwrap.
   */
  const readServices = `#graphql
    query MoonVellaFulfillmentServices {
      shop {
        fulfillmentServices { id serviceName handle location { id name } }
      }
    }`;

  const createService = `#graphql
    mutation MoonVellaFulfillmentServiceCreate($name: String!) {
      fulfillmentServiceCreate(name: $name, inventoryManagement: true, trackingSupport: true) {
        fulfillmentService { id serviceName handle location { id name } }
        userErrors { field message }
      }
    }`;

  try {
    const existingRes = await admin.graphql(readServices);
    const existingJson: {
      data?: {
        shop?: {
          fulfillmentServices?: {
            id: string;
            serviceName?: string | null;
            handle?: string | null;
            location?: { id?: string | null; name?: string | null } | null;
          }[] | null;
        } | null;
      };
      errors?: { message: string }[];
    } = await existingRes.json();
    if (Array.isArray(existingJson?.errors) && existingJson.errors.length) {
      throw new Error(existingJson.errors.map((e) => e.message).join("; "));
    }

    const wanted = MOONVELLA_FULFILLMENT_SERVICE_NAME.toLowerCase();
    const found = (existingJson?.data?.shop?.fulfillmentServices ?? []).find(
      (service) =>
        String(service.serviceName ?? "").toLowerCase() === wanted ||
        String(service.handle ?? "").toLowerCase() === wanted
    );

    let serviceId = found?.id ?? "";
    let locationId = found?.location?.id ?? "";
    let locationName = found?.location?.name ?? `${MOONVELLA_FULFILLMENT_SERVICE_NAME} fulfillment`;
    let created = false;

    if (!serviceId) {
      const createRes = await admin.graphql(createService, {
        variables: { name: MOONVELLA_FULFILLMENT_SERVICE_NAME },
      });
      const createJson: {
        data?: {
          fulfillmentServiceCreate?: {
            fulfillmentService?: {
              id: string;
              location?: { id?: string | null; name?: string | null } | null;
            } | null;
            userErrors?: { field?: string[] | null; message: string }[];
          } | null;
        };
        errors?: { message: string }[];
      } = await createRes.json();
      if (Array.isArray(createJson?.errors) && createJson.errors.length) {
        throw new Error(createJson.errors.map((e) => e.message).join("; "));
      }
      const userErrors = createJson?.data?.fulfillmentServiceCreate?.userErrors ?? [];
      if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));

      const service = createJson?.data?.fulfillmentServiceCreate?.fulfillmentService;
      serviceId = service?.id ?? "";
      locationId = service?.location?.id ?? "";
      locationName = service?.location?.name ?? locationName;
      created = true;
    }

    if (!serviceId || !locationId) {
      throw new Error(
        `Shopify returned a fulfillment service (${serviceId || "none"}) with no location ` +
          `(${locationId || "none"}). MoonVella stock needs a location of its own; without one there is ` +
          `nowhere to hold it that is not the merchant's own shelf.`
      );
    }

    await prisma.seller.update({
      where: { id: sellerId },
      data: {
        shopifyFulfillmentServiceId: serviceId,
        shopifyFulfillmentLocationId: locationId,
        fulfillmentLocationCheckedAt: new Date(),
      },
    });

    await recordAudit(
      {
        actorType: "SYSTEM",
        actorId: "shopify-fulfillment",
        actorName: "Shopify fulfillment",
        action: created ? "fulfillment.service_created" : "fulfillment.service_adopted",
        entityType: AUDIT_ENTITY.SELLER,
        entityId: sellerId,
        afterData: {
          serviceId,
          locationId,
          locationName,
          shopDomain: seller.shopDomain,
          note:
            "MoonVella ships these products, so its stock lives at this location and the fulfillment " +
            "orders for MoonVella lines are routed to it.",
        },
      },
      prisma as never
    );

    await setIntegrationState("shopify_fulfillment", {
      status: "HEALTHY",
      detail: created
        ? `Created the MoonVella fulfillment service and its location (${locationId}).`
        : `Adopted the existing MoonVella fulfillment service and its location (${locationId}).`,
    });

    return { serviceId, locationId, locationName, created };
  } catch (error) {
    if (error instanceof FulfillmentSetupBlocked) {
      await setIntegrationState("shopify_fulfillment", {
        status: "FAILED",
        error: error.message,
        detail: `Blocked by ${error.blocker}.`,
      });
      throw error;
    }
    const blocked = classifyRefusal(error instanceof Error ? error.message : String(error));
    await setIntegrationState("shopify_fulfillment", {
      status: "FAILED",
      error: blocked.message,
      detail: `Blocked by ${blocked.blocker}.`,
    });
    throw blocked;
  }
}

/**
 * Where MoonVella stock belongs in this store, or null when it cannot be known.
 *
 * The difference between this and `ensureMoonvellaFulfillmentService` is who it
 * is for. That function is the setup step and an operator is watching: a
 * refusal there is a fact to report, and it throws. This one is called by the
 * import and by the inventory push, which run on a queue with nobody watching
 * and whose job is to put a number on a shelf. For them a refusal is not an
 * error to raise, it is an answer — "MoonVella does not yet have its own
 * location here" — and the caller falls back to the merchant's shelf exactly as
 * it did before this existed.
 *
 * It is deliberately NOT a silent fallback inside the callers. The returned
 * reason is a sentence they can act on (a missing scope is a config change, a
 * missing Protected Customer Data approval is a Partner Dashboard review), and
 * the two are fixed in different places.
 */
export async function moonvellaStockLocationId(
  sellerId: string
): Promise<{ locationId: string | null; reason: string | null }> {
  try {
    const location = await ensureMoonvellaFulfillmentService(sellerId);
    if (!location) {
      return {
        locationId: null,
        reason: "The MoonVella fulfillment service could not be established for this store.",
      };
    }
    return { locationId: location.locationId, reason: null };
  } catch (error) {
    return {
      locationId: null,
      reason:
        error instanceof Error ? error.message : "The MoonVella fulfillment location could not be resolved.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

export interface RoutingOutcome {
  /** Fulfillment orders that were already at MoonVella's location. */
  alreadyRouted: string[];
  /** Fulfillment orders this run moved there. */
  moved: string[];
  /** Fulfillment orders Shopify refused to move, with its reason. */
  refused: { fulfillmentOrderId: string; reason: string }[];
  /** Fulfillment orders left alone because no MoonVella line is on them. */
  untouched: number;
  locationId: string | null;
  blocked?: string;
}

/**
 * Move the fulfillment orders that carry MoonVella lines to MoonVella's
 * location, and leave every other one exactly where it is.
 *
 * `resolveFulfillmentOrders` has already decided which lines are MoonVella's, by
 * the stored binding. This takes that answer — it does not re-derive it, because
 * two places deciding which goods are ours is two places that can disagree, and
 * the disagreement would show up as a merchant's own product being shipped by
 * MoonVella.
 *
 * A refusal by Shopify is reported, not worked around. The fulfillment orders
 * that could not be moved stay where they are, which means the shipment step
 * will find them assigned to the merchant's location and refuse to fulfill —
 * the correct outcome, because the alternative is shipping from a shelf that is
 * not MoonVella's.
 */
export async function routeFulfillmentOrdersToMoonvella(
  orderId: string,
  adminOverride?: AdminClient
): Promise<RoutingOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { seller: true },
  });
  if (!order) throw new Error("Order not found.");

  const location = await ensureMoonvellaFulfillmentService(order.sellerId, adminOverride);
  if (!location) {
    return {
      alreadyRouted: [],
      moved: [],
      refused: [],
      untouched: 0,
      locationId: null,
      blocked: "The MoonVella fulfillment service could not be created or found for this store.",
    };
  }

  const resolved = await resolveFulfillmentOrders(orderId, adminOverride);
  const ourIds = new Set(
    resolved.groups.map((g) => numericId(g.fulfillmentOrderId))
  );

  const alreadyRouted: string[] = [];
  const moved: string[] = [];
  const refused: { fulfillmentOrderId: string; reason: string }[] = [];

  const moveMutation = `#graphql
    mutation MoonVellaMoveFO($id: ID!, $newLocationId: ID!) {
      fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
        movedFulfillmentOrder { id status assignedLocation { location { id name } } }
        userErrors { field message }
      }
    }`;

  for (const group of resolved.groups) {
    if (numericId(group.assignedLocationId) === numericId(location.locationId)) {
      alreadyRouted.push(group.fulfillmentOrderId);
      continue;
    }
    try {
      const admin = await adminFor(order.seller.shopDomain, adminOverride);
      const res = await admin.graphql(moveMutation, {
        variables: { id: group.fulfillmentOrderId, newLocationId: location.locationId },
      });
      const json: {
        data?: {
          fulfillmentOrderMove?: {
            movedFulfillmentOrder?: { id: string } | null;
            userErrors?: { field?: string[] | null; message: string }[];
          } | null;
        };
        errors?: { message: string }[];
      } = await res.json();
      if (Array.isArray(json?.errors) && json.errors.length) {
        refused.push({
          fulfillmentOrderId: group.fulfillmentOrderId,
          reason: json.errors.map((e) => e.message).join("; "),
        });
        continue;
      }
      const userErrors = json?.data?.fulfillmentOrderMove?.userErrors ?? [];
      if (userErrors.length) {
        refused.push({
          fulfillmentOrderId: group.fulfillmentOrderId,
          reason: userErrors.map((e) => e.message).join("; "),
        });
        continue;
      }
      moved.push(group.fulfillmentOrderId);
    } catch (error) {
      refused.push({
        fulfillmentOrderId: group.fulfillmentOrderId,
        reason: error instanceof Error ? error.message : "move failed",
      });
    }
  }

  const untouched = Math.max(0, resolved.totalFulfillmentOrders - ourIds.size);

  await recordAudit(
    {
      actorType: "SYSTEM",
      actorId: "shopify-fulfillment",
      actorName: "Shopify fulfillment",
      action: "fulfillment.routed",
      entityType: AUDIT_ENTITY.ORDER,
      entityId: orderId,
      afterData: {
        locationId: location.locationId,
        alreadyRouted,
        moved,
        refused,
        // Stated explicitly so a reader can see the merchant's own fulfillment
        // orders were considered and deliberately left alone.
        untouchedNotMoonvella: untouched,
      },
    },
    prisma as never
  );

  await setIntegrationState("shopify_fulfillment", {
    status: refused.length ? "FAILED" : "HEALTHY",
    ...(refused.length
      ? { error: refused.map((r) => `${r.fulfillmentOrderId}: ${r.reason}`).join(" | ") }
      : {
          detail:
            `MoonVella fulfillment orders at location ${location.locationId}: ` +
            `${alreadyRouted.length} already there, ${moved.length} moved. ` +
            `${untouched} fulfillment order(s) left untouched because no MoonVella line is on them.`,
        }),
  });

  return { alreadyRouted, moved, refused, untouched, locationId: location.locationId };
}
