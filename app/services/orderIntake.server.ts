import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";
import { resolvePackagesForVariant, toCm, toKg } from "./packaging.server";
import { addressMateriallyDiffers } from "./addressValidation.server";
import { invalidateQuotes, QUOTE_INVALIDATION } from "./shipping.server";
import {
  cancellationTarget,
  transitionOrder,
  MONEY_CLEARED,
  type OrderState,
  type StateActor,
} from "./orderState.server";
import { enqueueJob, JOB_KIND } from "./jobs.server";
import { numericId } from "./shopifyFulfillment.server";

/**
 * The Shopify topics this deployment acts on.
 *
 * Declared here rather than in the route because two things need to agree about
 * it: the route, which decides whether a delivery is worth recording, and
 * `shopify.app.toml`, whose subscription list must name the same events. A
 * topic that is subscribed but not listed here is a delivery the app
 * acknowledges and drops; one listed here but not subscribed is work that will
 * never be asked for.
 *
 * `orders/paid` is deliberately separate from `orders/create`. A great many
 * stores take payment asynchronously — a bank transfer, a manual capture, a
 * gateway callback that lands a minute after the order — and an order that is
 * created unpaid and paid later produces two events, only the second of which
 * means the seller's card may be charged.
 *
 * `fulfillment_orders/order_routing_complete` is here because Shopify decides
 * where an order's lines are routed, and it tells the app when it has finished
 * deciding. Until that event arrives there may be no fulfillment order to act
 * on, so an app that only listens to orders/paid races Shopify's own routing
 * and loses on the orders it most needs to win.
 */
export const WEBHOOK_TOPICS: ReadonlySet<string> = new Set([
  "ORDERS_CREATE",
  "ORDERS_PAID",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
  "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",
]);

/**
 * Where a delivery came from.
 *
 * A REPLAY is an operator asking the system to take in an order Shopify has
 * already told it about — or, in the case this was written for, never told it
 * about because the subscription did not exist. The path is the same code
 * deliberately: a replay that took a different route would be a second
 * implementation of intake, and the order it produced would be one nobody had
 * ever tested.
 */
export type IntakeSource = "WEBHOOK" | "REPLAY";

interface TaxLine {
  price?: string | null;
}

interface DiscountAllocation {
  amount?: string | null;
  amount_set?: { shop_money?: { amount?: string | null } | null } | null;
}

interface LineItem {
  id?: number | string;
  variant_id?: number | string | null;
  title?: string;
  sku?: string;
  quantity?: number;
  price?: string;
  tax_lines?: TaxLine[];
  discount_allocations?: DiscountAllocation[];
}

interface RefundLineItem {
  id?: number | string;
  line_item_id?: number | string;
  quantity?: number;
  subtotal?: string;
  line_item?: { id?: number | string };
}

interface RefundPayload {
  id: number | string;
  created_at?: string;
  note?: string | null;
  total_refunded?: string;
  refund_line_items?: RefundLineItem[];
}

interface MoneySet {
  shop_money?: { amount?: string | null } | null;
}

interface ShippingLine {
  price?: string;
}

interface OrderPayload {
  id: number;
  /**
   * The order a NON-order event belongs to.
   *
   * `refunds/create` and `fulfillment_orders/order_routing_complete` are about
   * a refund and a fulfillment order respectively, and both name the order in
   * this field. Their own `id` is a different object's id.
   */
  order_id?: number | string;
  name?: string;
  order_number?: number;
  email?: string;
  currency?: string;
  customer?: { first_name?: string; last_name?: string; email?: string; phone?: string };
  line_items?: LineItem[];
  shipping_address?: unknown;
  billing_address?: unknown;
  financial_status?: string;
  fulfillment_status?: string | null;
  total_tax?: string;
  total_discounts?: string;
  subtotal_price?: string;
  total_price?: string;
  total_shipping_price_set?: MoneySet;
  shipping_lines?: ShippingLine[];
  refunds?: RefundPayload[];
  created_at?: string;
  updated_at?: string;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
}

interface VariantMapping {
  productVariantId: string;
  sellerProductId: string;
  productVariant: VariantSnapshotSource;
}

/**
 * Everything the order line copies out of the variant at intake.
 *
 * These are read once, at the moment the order arrives, and written as literal
 * values onto the OrderItem. Nothing downstream re-reads the variant, which is
 * the whole point: renaming a colour, repricing a size or archiving a product
 * must not rewrite what a customer was told they bought last month.
 */
interface VariantSnapshotSource {
  productId: string;
  name: string;
  sku: string;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  productLengthCm: unknown;
  productWidthCm: unknown;
  productHeightCm: unknown;
  productWeightKg: unknown;
  unitsPerPackage: number;
  currency: string;
  variantOptions: { name: string; value: string }[];
  product: { productCode: string } | null;
}

/**
 * The one carton a line records, in whatever shape the resolver returned it.
 *
 * Structural rather than an import of the resolver's own type, for the same
 * reason `VariantSnapshotSource` is: this file only ever reads these four
 * measurements and the unit they are in, and naming exactly that keeps a
 * change to the packaging tables from reaching into order intake.
 */
interface ResolvedCarton {
  length: number;
  width: number;
  height: number;
  dimensionUnit: string;
  grossWeight: number;
  weightUnit: string;
  unitsPerPackage: number;
}

export interface IntakeResult {
  ok: boolean;
  reason?: string;
  duplicate?: boolean;
  orderId?: string;
  moonvellaItems?: number;
  updated?: boolean;
  refunds?: number;
  cancelled?: number;
}

interface BuiltItem {
  name: string;
  sku: string;
  quantity: number;
  price: number;
  wholesalePrice: number;
  totalDiscount: number;
  shopifyLineItemId: string;
  variantId: string;
  sellerProductId: string;
  /* --- variant snapshot, copied at intake ---------------------------------- */
  productId: string;
  productCode: string | null;
  variantName: string;
  /** Ordered options as JSON. A string, because the variant's own rows may change. */
  selectedOptions: string | null;
  /** What the seller was told to charge. Shopify's line price is what was charged. */
  sellerRetailPrice: number | null;
  currency: string | null;
  productLengthCm: string | null;
  productWidthCm: string | null;
  productHeightCm: string | null;
  productWeightKg: string | null;
  packageLengthCm: string | null;
  packageWidthCm: string | null;
  packageHeightCm: string | null;
  packagedWeightKg: string | null;
  unitsPerPackage: number | null;
}

interface BuiltItems {
  rows: BuiltItem[];
  moonvellaSubtotal: number;
  retailTotal: number;
  lineDiscountTotal: number;
  lineTaxTotal: number;
  /**
   * Where each line's wholesale unit price came from, by Shopify line item id:
   * the order's own recorded figure, or the catalogue as it stands now. Carried
   * out of the build because it is the first thing an operator needs when a
   * total moved — and the thing an audit entry has to say.
   */
  priceSource: Map<string, "SNAPSHOT" | "CATALOGUE">;
}

function cents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function sumTaxes(li: LineItem): number {
  return (li.tax_lines ?? []).reduce((sum, line) => sum + cents(line.price), 0);
}

function sumDiscounts(li: LineItem): number {
  return (li.discount_allocations ?? []).reduce(
    (sum, allocation) => sum + cents(allocation.amount ?? allocation.amount_set?.shop_money?.amount),
    0
  );
}

/**
 * A Decimal column takes a string, and should.
 *
 * Prisma will accept a JavaScript number here and convert it, but that routes
 * an exact decimal through binary floating point first: 0.1 kg becomes
 * 0.1000000000000000055511151231257827 before it is rounded back to three
 * places. Passing the value's own decimal string through keeps the stored
 * number equal to the number that was entered.
 */
function decimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  return Number.isFinite(Number(text)) ? text : null;
}

/**
 * The carton actually used, resolved from the variant's first package.
 *
 * WHICH CARTON IS NOT A QUESTION THIS FILE ANSWERS ITSELF. It used to read the
 * variant's own rows and take the first, which was the whole answer while every
 * product could inherit a product-level default — the fallback rows were read by
 * the quote and never by the order line, so a simple product's orders recorded
 * no carton at all. One packaging editor per sellable configuration makes that
 * the ordinary case rather than an edge: a product whose sellers choose nothing
 * keeps its carton on the PRODUCT, and this must record it.
 *
 * So the resolution goes through `resolvePackagesForVariant` — the same function
 * the quote, the editors and the migration use. A second reading of "which
 * cartons apply" here is precisely the disagreement this change exists to
 * remove, and it would show up as an order line that quotes from one box and
 * records another.
 *
 * A package measured in inches is converted rather than copied, because the
 * snapshot columns are canonical cm/kg and a mixed-unit column would be
 * unreadable a year from now. The conversion is `packaging.server`'s, imported
 * rather than repeated: one unit conversion, in one place, is the only way the
 * quote and the order line can be guaranteed to agree.
 */
function snapshotFor(
  variant: VariantSnapshotSource,
  carton: ResolvedCarton | null,
  chargedRetailCents: number
) {
  const options = variant.variantOptions
    .filter((option) => option.name.trim() && option.value.trim())
    .map((option) => ({ name: option.name, value: option.value }));

  return {
    productId: variant.productId,
    // The family code, so an archived-and-reissued product can still be
    // recognised on an old order without joining back to a row that may have
    // been renamed.
    productCode: variant.product?.productCode ?? null,
    variantName: variant.name,
    selectedOptions: options.length ? JSON.stringify(options) : null,
    // What the seller was told to charge, as distinct from the price that was
    // charged. Kept only when the two differ in a way worth explaining: if
    // Shopify charged the catalogue price, recording it again adds nothing.
    sellerRetailPrice:
      variant.suggestedRetailPrice !== chargedRetailCents ? variant.suggestedRetailPrice : null,
    currency: variant.currency || null,
    productLengthCm: decimal(variant.productLengthCm),
    productWidthCm: decimal(variant.productWidthCm),
    productHeightCm: decimal(variant.productHeightCm),
    productWeightKg: decimal(variant.productWeightKg),
    packageLengthCm: carton ? toCm(carton.length, carton.dimensionUnit).toFixed(2) : null,
    packageWidthCm: carton ? toCm(carton.width, carton.dimensionUnit).toFixed(2) : null,
    packageHeightCm: carton ? toCm(carton.height, carton.dimensionUnit).toFixed(2) : null,
    packagedWeightKg: carton ? toKg(carton.grossWeight, carton.weightUnit).toFixed(3) : null,
    unitsPerPackage: carton?.unitsPerPackage ?? null,
  };
}

/**
 * Keep only line items mapped to a persisted MoonVella variant. Unrelated
 * products stay out of the supplier workflow.
 *
 * THE WHOLESALE UNIT PRICE IS A SNAPSHOT, NOT A LOOKUP. When `frozenUnitPrices`
 * carries a figure for a line, that figure is used and the catalogue is not
 * consulted at all — because the price on the line is what the seller was
 * charged, and a pricelist edit, a catalogue correction or a repricing must not
 * reach back into an order that has already been billed. A line the map does
 * not know is genuinely new, and it takes the price in force now.
 */
async function buildItems(
  items: LineItem[],
  byVariant: Map<string, VariantMapping>,
  frozenUnitPrices?: Map<string, number>
): Promise<BuiltItems> {
  // Read through the same normaliser the map was keyed with, so a line whose
  // variant arrives as a GID binds to a mapping stored as a number and the
  // other way round. See the note in `intakeOrder`.
  const moonvellaItems = items.filter((li) => li.variant_id && byVariant.has(numericId(li.variant_id)));
  let moonvellaSubtotal = 0;
  let retailTotal = 0;
  let lineDiscountTotal = 0;
  let lineTaxTotal = 0;
  const priceSource = new Map<string, "SNAPSHOT" | "CATALOGUE">();

  const rows = await Promise.all(moonvellaItems.map(async (li) => {
    const mapping = byVariant.get(numericId(li.variant_id))!;
    const variant = mapping.productVariant;
    const quantity = Number(li.quantity) || 0;
    const retailUnit = cents(li.price);
    const lineKey = String(li.id ?? "");
    const frozen = frozenUnitPrices?.get(lineKey);
    const wholesaleUnit = frozen ?? variant.wholesalePrice;
    priceSource.set(lineKey, frozen === undefined ? "CATALOGUE" : "SNAPSHOT");
    const lineDiscount = sumDiscounts(li);
    retailTotal += retailUnit * quantity;
    moonvellaSubtotal += wholesaleUnit * quantity;
    lineDiscountTotal += lineDiscount;
    lineTaxTotal += sumTaxes(li);
    /*
     * WHICH CARTON, ANSWERED BY THE ONE FUNCTION THAT ANSWERS IT. The resolver
     * reads the variant's own rows for a product sold in choices and the
     * product's for one sold as a single configuration, which is the rule the
     * editors enforce and the migration guarantees. Reading the variant's rows
     * here instead — as this did — recorded no carton at all for the second kind.
     */
    const resolved = await resolvePackagesForVariant(mapping.productVariantId);
    return {
      name: li.title || variant.name,
      sku: li.sku || variant.sku,
      quantity,
      price: retailUnit,
      wholesalePrice: wholesaleUnit,
      totalDiscount: lineDiscount,
      shopifyLineItemId: String(li.id ?? ""),
      variantId: mapping.productVariantId,
      sellerProductId: mapping.sellerProductId,
      ...snapshotFor(variant, resolved.packages[0] ?? null, retailUnit),
    };
  }));

  return { rows, moonvellaSubtotal, retailTotal, lineDiscountTotal, lineTaxTotal, priceSource };
}

/**
 * MoonVella-attributable money. Line-level tax/discount allocations are used
 * when Shopify supplies them; otherwise the order-level amount is allocated by
 * the MoonVella retail share of the order subtotal. Shipping is always an
 * order-level charge, so it is allocated proportionally. `moonvellaTotal` is the
 * wholesale cost plus the attributable adjustments.
 */
function computeAmounts(payload: OrderPayload, built: BuiltItems) {
  const orderSubtotal = payload.subtotal_price ? cents(payload.subtotal_price) : built.retailTotal;
  const ratio =
    orderSubtotal > 0 ? Math.min(1, built.retailTotal / orderSubtotal) : built.retailTotal > 0 ? 1 : 0;
  const orderShipping = payload.total_shipping_price_set?.shop_money?.amount
    ? cents(payload.total_shipping_price_set.shop_money.amount)
    : (payload.shipping_lines ?? []).reduce((sum, line) => sum + cents(line.price), 0);
  const orderTax = cents(payload.total_tax);
  const orderDiscounts = cents(payload.total_discounts);

  const moonvellaTax = built.lineTaxTotal > 0 ? built.lineTaxTotal : Math.round(orderTax * ratio);
  const moonvellaDiscounts =
    built.lineDiscountTotal > 0 ? built.lineDiscountTotal : Math.round(orderDiscounts * ratio);
  const moonvellaShipping = Math.round(orderShipping * ratio);
  const moonvellaTotal = built.moonvellaSubtotal - moonvellaDiscounts + moonvellaTax + moonvellaShipping;
  const totalPrice = built.retailTotal - moonvellaDiscounts + moonvellaTax + moonvellaShipping;

  return {
    subtotal: built.retailTotal,
    totalTax: moonvellaTax,
    totalShipping: moonvellaShipping,
    totalDiscounts: moonvellaDiscounts,
    totalPrice,
    moonvellaSubtotal: built.moonvellaSubtotal,
    moonvellaTax,
    moonvellaShipping,
    moonvellaDiscounts,
    moonvellaTotal,
  };
}

/**
 * Create Refund/RefundItem rows for any refunds in the payload that are not yet
 * stored. Refunds are matched by (order, shopifyRefundId) and refund lines by
 * the originating Shopify line item id.
 */
async function reconcileRefunds(
  tx: Prisma.TransactionClient,
  orderId: string,
  refunds: RefundPayload[] | undefined
): Promise<number> {
  if (!refunds?.length) return 0;
  const orderItems = await tx.orderItem.findMany({ where: { orderId } });
  let created = 0;

  for (const refund of refunds) {
    const shopifyRefundId = String(refund.id);
    const existing = await tx.refund.findFirst({ where: { orderId, shopifyRefundId } });
    if (existing) continue;

    const lines = refund.refund_line_items ?? [];
    const amount =
      lines.reduce((sum, line) => sum + cents(line.subtotal), 0) || cents(refund.total_refunded);
    const reason = refund.note ?? null;

    await tx.refund.create({
      data: {
        orderId,
        shopifyRefundId,
        amount,
        reason,
        processedAt: refund.created_at ? new Date(refund.created_at) : new Date(),
        items: {
          create: lines.flatMap((line) => {
            const lineItemId = String(line.line_item_id ?? line.line_item?.id ?? "");
            const orderItem = orderItems.find((oi) => oi.shopifyLineItemId === lineItemId);
            if (!orderItem) return [];
            return [
              {
                orderItemId: orderItem.id,
                quantity: Number(line.quantity) || 0,
                amount: cents(line.subtotal),
                reason,
              },
            ];
          }),
        },
      },
    });
    created++;
  }
  return created;
}

function mapPaymentStatus(financialStatus?: string) {
  switch (financialStatus) {
    case "paid":
      return "PAID" as const;
    case "refunded":
      return "REFUNDED" as const;
    case "partially_refunded":
      return "PARTIALLY_REFUNDED" as const;
    case "voided":
      return "VOIDED" as const;
    default:
      return "PENDING" as const;
  }
}

function mapFulfillmentStatus(
  shopifyStatus: string | null | undefined,
  current: "PENDING" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "PARTIAL"
) {
  switch (shopifyStatus) {
    case "fulfilled":
      return current === "DELIVERED" ? "DELIVERED" : "SHIPPED";
    case "partial":
      return "PARTIAL";
    case "restocked":
      return "CANCELLED";
    default:
      return current;
  }
}

function customerName(payload: OrderPayload): string | null {
  if (!payload.customer) return null;
  const name = `${payload.customer.first_name ?? ""} ${payload.customer.last_name ?? ""}`.trim();
  return name || null;
}

function addressJson(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
}

/**
 * What is kept of a delivery once it has been processed.
 *
 * THE FULL BODY IS NOT KEPT. A Shopify order payload carries the customer's
 * name, email address, phone number and both addresses, and a `refunds/create`
 * carries the same again. That is the exact set of fields this app is trusted
 * with and the exact set that must not be sitting in a table nothing ever
 * prunes — a webhook log is read by more people than the order it describes,
 * and it outlives the order.
 *
 * What is kept is what an operator actually needs to answer "did we get this,
 * and what did we do with it": which store, which topic, which order, and the
 * three facts that say whether the payload was about money and fulfilment. All
 * of it is identifiers and states — no names, no addresses, no contact details.
 */
function redactedSummary(payload: OrderPayload): string {
  return JSON.stringify({
    redacted: true,
    id: payload?.id ?? null,
    name: payload?.name ?? null,
    order_number: payload?.order_number ?? null,
    financial_status: payload?.financial_status ?? null,
    fulfillment_status: payload?.fulfillment_status ?? null,
    current_total_price: payload?.total_price ?? null,
    currency: payload?.currency ?? null,
    line_item_count: payload?.line_items?.length ?? 0,
    note:
      "The full delivery was held only while it was being processed, then replaced by this summary. " +
      "Customer identity fields are not retained here.",
  });
}

async function finishEvent(id: string, status: "SUCCESS" | "FAILED", errorMessage?: string | null) {
  const current = await prisma.webhookEvent.findUnique({
    where: { id },
    select: { payload: true, retryCount: true },
  });
  let summary = "{}";
  try {
    summary = current ? redactedSummary(JSON.parse(current.payload) as OrderPayload) : "{}";
  } catch {
    // A body that will not parse is exactly the body not to keep a copy of.
    summary = JSON.stringify({ redacted: true, unparseable: true });
  }

  await prisma.webhookEvent.update({
    where: { id },
    data: {
      status,
      processedAt: new Date(),
      payload: summary,
      /*
       * A failure keeps the summary too. The operator needs to know the
       * delivery arrived and what it was about; they do not need the
       * customer's address to work out why intake refused it, and an error
       * message names the reason.
       */
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(status === "FAILED" ? { retryCount: (current?.retryCount ?? 0) + 1 } : {}),
    },
  });
}

/**
 * Idempotently ingest a Shopify order webhook.
 *
 * - orders/create (and orders/paid): create the supplier order, fulfillment
 *   request and wholesale invoice for the mapped MoonVella items.
 * - orders/updated: reconcile line items, refunds, statuses and money on the
 *   existing supplier order instead of ignoring the event.
 * - orders/cancelled: mark the order cancelled and cancel any open fulfillment
 *   request without deleting history.
 *
 * Dedup is durable per (shop, topic, order, payload version) so redeliveries are
 * ignored while genuine updates still apply.
 */
export async function intakeOrder(input: {
  topic: string;
  shop: string;
  payload: OrderPayload;
  /**
   * Defaults to WEBHOOK. A replay says REPLAY so the audit distinguishes an
   * order that arrived by itself from one an operator asked for.
   */
  source?: IntakeSource;
  /**
   * The delivery row the webhook route already wrote, when there is one.
   *
   * Passing it means the delivery is marked finished rather than duplicated:
   * the route records a delivery before it knows whether the payload is one
   * this app acts on, and intake is what completes that record.
   */
  eventId?: string;
  /**
   * Why the order this event is about could not be read, when it had to be
   * fetched and the fetch did not produce one.
   *
   * It is passed in rather than discovered here because intake is a pure
   * function of its payload and has no client to fetch with — the fetch
   * belongs to the caller, and so does the obligation to say when it failed.
   * Given a reason, intake ends the delivery FAILED carrying it, rather than
   * reading an empty payload as an order with no MoonVella lines and closing
   * the delivery as a success. See `hydrateOrderPayload`.
   */
  orderUnavailable?: string | null;
}): Promise<IntakeResult> {
  const { topic, shop, payload } = input;
  const source: IntakeSource = input.source ?? "WEBHOOK";

  const isCancelled = topic === "ORDERS_CANCELLED";
  const isUpdated = topic === "ORDERS_UPDATED";
  const isRefund = topic === "REFUNDS_CREATE";
  const isRouting = topic === "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE";

  /*
   * WHICH ORDER THIS EVENT IS ABOUT.
   *
   * Three of the six topics carry an order as their subject and their `id` IS
   * the order id. The other three do not: a refund's `id` is the refund, and a
   * routing event's `id` is the fulfillment order. Both name the order they
   * belong to in `order_id`.
   *
   * Reading `payload.id` unconditionally — which is what this did — meant a
   * refund or a routing event would be filed against an order whose id was
   * really a refund id. Nothing would be found, nothing would be written, and
   * the event would be recorded as a successful no-op.
   */
  const orderId = isRefund || isRouting ? payload?.order_id : payload?.id;
  if (!orderId) {
    /*
     * The delivery row was written by the route before it knew what it had, so
     * an event that names no order leaves that row behind. Ending it here is
     * the difference between a delivery that says it was refused and one that
     * sits at PENDING forever looking like work still to do.
     */
    if (input.eventId) {
      await finishEvent(input.eventId, "FAILED", "The event names no order.");
    }
    return { ok: false, reason: "missing order id" };
  }
  const version = payload.updated_at ?? payload.cancelled_at ?? payload.created_at ?? "";
  const idempotencyKey = `${shop}:${topic}:${orderId}:${version}`;
  const already = await prisma.webhookEvent.findUnique({ where: { idempotencyKey } });
  if (already) {
    return { ok: true, duplicate: true };
  }

  let event: { id: string };
  if (input.eventId) {
    const claimed = await prisma.webhookEvent.findUnique({ where: { id: input.eventId } });
    /*
     * The route wrote this row moments ago and enqueued this job. If it is
     * already SUCCESS it has been processed — by an earlier run of this same
     * job, most likely — and there is nothing to do.
     */
    if (claimed && claimed.status === "SUCCESS") return { ok: true, duplicate: true };
    event = claimed
      ? await prisma.webhookEvent.update({
          where: { id: claimed.id },
          data: { status: "PROCESSING", source, errorMessage: null },
        })
      : await prisma.webhookEvent.create({
          data: {
            shopDomain: shop,
            topic,
            payload: JSON.stringify(payload),
            status: "PROCESSING",
            source,
            idempotencyKey,
          },
        });
  } else {
    event = await prisma.webhookEvent.create({
      data: {
        shopDomain: shop,
        topic,
        payload: JSON.stringify(payload),
        status: "PROCESSING",
        source,
        idempotencyKey,
      },
    });
  }

  try {
    /*
     * THE ORDER WAS NEVER OBTAINED. Checked before anything is created, because
     * every branch below reads the payload as though it were an order, and an
     * empty one would be taken as an order with nothing on it.
     */
    if (input.orderUnavailable) {
      await finishEvent(event.id, "FAILED", input.orderUnavailable);
      return { ok: false, reason: input.orderUnavailable };
    }

    const seller = await prisma.seller.findUnique({ where: { shopDomain: shop } });
    if (!seller) {
      await finishEvent(event.id, "FAILED", "No seller for shop");
      return { ok: false, reason: "no seller" };
    }

    const supplierReference = `${shop}#${orderId}`;
    const existingOrder = await prisma.order.findUnique({
      where: { supplierReference },
      include: { items: true, fulfillmentRequest: true },
    });

    if (isCancelled) {
      return await handleCancelled(event.id, shop, existingOrder, payload);
    }

    /*
     * A customer refund is not a MoonVella refund.
     *
     * Shopify's `refunds/create` says the SELLER gave the CUSTOMER their money
     * back. MoonVella is not a party to that transaction and has taken nothing
     * from the customer; what it may have taken is the seller's wholesale
     * payment. Whether the seller gets that back is MoonVella's decision, made
     * against its own rule, and it is never inferred from this event. What this
     * event does is make the question visible: once the seller has been
     * charged, a refunded order is money that may need to go back, so it is
     * held in REFUND_REVIEW for a person rather than quietly shipped.
     */
    if (isRefund) {
      return await handleRefund(event.id, shop, existingOrder, payload);
    }

    /*
     * Shopify has finished deciding where the order's lines are routed. The
     * fulfillment order this app needs may only exist from this moment, so a
     * paid order is handed to the fulfilment queue again rather than trusted to
     * have been routed when the payment cleared.
     */
    if (topic === "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE") {
      return await handleRoutingComplete(event.id, shop, existingOrder);
    }

    /**
     * A blocked store may not start new business with MoonVella.
     *
     * ONLY THE CREATE PATH IS REFUSED. An order that already exists is real:
     * the customer paid, the goods may already have shipped, and MoonVella is
     * on the hook for it. Refusing its updates would mean a blocked store's
     * cancellation never reaches the warehouse — and a block is exactly when
     * MoonVella most needs to hear that one of them was cancelled. So this
     * gate tests for the absence of a recorded order, not for the topic, and
     * `isUpdated` on an order we never took in is refused the same way a
     * create is, because it would create one.
     *
     * The refusal is recorded as a FAILED event rather than dropped quietly.
     * The seller's Shopify store has taken an order the MoonVella app did not
     * accept, and somebody has to be able to see that it happened and why.
     */
    if (seller.status === "BLOCKED" && !existingOrder) {
      const blockReason = seller.blockReason ? ` — ${seller.blockReason}` : "";
      await finishEvent(
        event.id,
        "FAILED",
        `Refused: seller is blocked${blockReason}. ${payload.name || `#${payload.order_number ?? orderId}`} was not created.`
      );
      return { ok: false, reason: "seller blocked" };
    }

    const items = payload.line_items ?? [];
    const variantIds = items
      .map((li) => (li.variant_id ? String(li.variant_id) : null))
      .filter((v): v is string => !!v);

    /*
     * THE SAME VARIANT, AND THE TWO WAYS SHOPIFY WRITES IT.
     *
     * A line item's variant arrives here as a number — `51750873071862` — both
     * from a webhook and from the fetch above, because the webhook says `id` and
     * the query is reshaped down to the number. The binding stored by the import
     * is the GID, because every Shopify mutation this app sends back (price,
     * inventory) needs one and the import reads it straight off GraphQL. So the
     * lookup compared `51750873071862` against
     * `gid://shopify/ProductVariant/51750873071862` and matched nothing.
     *
     * The cost was total and silent: every line of every real order failed to
     * bind, `buildItems` returned no rows, and the delivery was closed as the
     * SUCCESSFUL "No MoonVella items" — the one outcome that means "this order
     * is not ours", recorded against orders that were entirely ours. No order
     * was ever created, and nothing anywhere said so. The suite could not see it
     * because its fixtures wrote the mapping in the same spelling the lookup
     * used.
     *
     * Both spellings are therefore queried for, and the map below is keyed by
     * the number the two share — so the query and the lookup cannot disagree
     * again, whichever spelling the payload or the database happens to carry.
     * `numericId` is the existing normaliser for exactly this; it is imported
     * rather than reimplemented, because a second copy is how the two spellings
     * drift apart in the first place.
     */
    const numbers = [...new Set(variantIds.map((v) => numericId(v)).filter(Boolean))];
    const lookupKeys = [
      ...new Set([...variantIds, ...numbers.map((n) => `gid://shopify/ProductVariant/${n}`)]),
    ];

    const mappings = await prisma.sellerProductVariant.findMany({
      where: {
        sellerProduct: { sellerId: seller.id },
        shopifyVariantId: { in: lookupKeys },
      },
      // Read once, at intake, and copied onto the order line. The relations are
      // included because the snapshot needs the option pairs and the family
      // code — both of which can change later, which is exactly why the copy
      // exists. The carton is NOT included: it is resolved by
      // `resolvePackagesForVariant`, because for a product whose sellers choose
      // nothing it lives on the product rather than the variant.
      include: {
        productVariant: {
          include: {
            variantOptions: { orderBy: { sortOrder: "asc" } },
            product: { select: { productCode: true } },
          },
        },
        sellerProduct: true,
      },
    });
    // Keyed by the number both spellings share — see the note above the query.
    const byVariant = new Map<string, VariantMapping>();
    for (const mapping of mappings) {
      byVariant.set(numericId(mapping.shopifyVariantId), mapping);
    }

    if (isUpdated && existingOrder) {
      return await handleUpdated(event.id, shop, existingOrder, payload, byVariant);
    }

    const built = await buildItems(items, byVariant);
    if (built.rows.length === 0) {
      await finishEvent(event.id, "SUCCESS", "No MoonVella items");
      return { ok: true, moonvellaItems: 0 };
    }

    const duplicateOrder = await prisma.order.findUnique({
      where: { supplierReference },
      select: { id: true },
    });
    if (duplicateOrder) {
      await finishEvent(event.id, "SUCCESS", "Order exists");
      return { ok: true, duplicate: true };
    }

    const amounts = computeAmounts(payload, built);

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          sellerId: seller.id,
          shopifyOrderId: String(orderId),
          shopifyOrderName: payload.name || `#${payload.order_number ?? orderId}`,
          shopifyOrderNumber: payload.order_number ?? 0,
          customerEmail: payload.email ?? payload.customer?.email ?? null,
          customerName: customerName(payload),
          customerPhone: payload.customer?.phone ?? null,
          shippingAddress: addressJson(payload.shipping_address),
          billingAddress: addressJson(payload.billing_address),
          currency: payload.currency ?? "CAD",
          ...amounts,
          paymentStatus: mapPaymentStatus(payload.financial_status),
          fulfillmentStatus: mapFulfillmentStatus(payload.fulfillment_status, "PENDING"),
          financialStatus: payload.financial_status ?? null,
          shopifyCreatedAt: payload.created_at ? new Date(payload.created_at) : new Date(),
          shopifyUpdatedAt: payload.updated_at ? new Date(payload.updated_at) : new Date(),
          supplierReference,
          items: { create: built.rows },
        },
      });

      await tx.fulfillmentRequest.create({
        data: { orderId: created.id, status: "PENDING" },
      });

      /*
       * THE THREE LINES OF THE SELLER'S BILL, recorded when the bill is made.
       *
       * `amount` is untouched: it is what the seller is charged, and changing it
       * would change a price. What is new is that the bill now says what it is
       * made of, so the shipping the seller owes is visible on the record rather
       * than only in the shipment reconciliation.
       *
       * `shippingAmount` IS THE SELLER'S OWN SHIPPING CHARGE — the Shopify
       * shipping lines, scaled to MoonVella's share of the order by the same
       * ratio the rest of the bill uses. It is the zone-based price the seller
       * agreed to, and it is deliberately not the carrier's cost: what the
       * carrier charges MoonVella is MoonVella's business, and substituting it
       * here would hand the seller the carrier's bill instead of their own.
       *
       * Rows created before this keep their nulls. A null shipping amount means
       * "this bill was written before the line existed", which is true, and
       * which the auto-pay guard below already reads as zero — so no backfill is
       * needed and none is done.
       */
      await tx.wholesalePayment.create({
        data: {
          orderId: created.id,
          sellerId: seller.id,
          amount: built.moonvellaSubtotal,
          subtotal: built.moonvellaSubtotal,
          shippingAmount: amounts.moonvellaShipping,
          taxAmount: amounts.moonvellaTax,
          currency: payload.currency ?? "CAD",
          provider: "stripe",
          status: "REQUIRES_PAYMENT",
          idempotencyKey: `wholesale:${supplierReference}`,
        },
      });

      await reconcileRefunds(tx, created.id, payload.refunds);

      /*
       * RECEIVED lasts exactly as long as the transaction that creates the
       * order, and the reason it exists at all is that "an order row exists"
       * and "we know what to do with it" are different facts. The order has
       * been priced, so what it is waiting for is the seller's money.
       *
       * The first transition is written here, inside the same transaction, so
       * an order can never be observed with no history at all — a row whose
       * state is AWAITING_SELLER_PAYMENT and whose transition table is empty
       * would be an order nobody could explain.
       */
      await transitionOrder(
        {
          orderId: created.id,
          to: "AWAITING_SELLER_PAYMENT",
          actor: intakeActor(source, shop),
          reason:
            source === "REPLAY"
              ? "Order taken in by an operator replay."
              : `Received from Shopify (${topic}).`,
        },
        tx
      );

      return created;
    });

    await recordAudit(
      {
        actorType: "WEBHOOK",
        actorId: shop,
        actorName: shop,
        action: "order.intaken",
        entityType: AUDIT_ENTITY.ORDER,
        entityId: order.id,
        afterData: {
          supplierReference,
          moonvellaSubtotal: amounts.moonvellaSubtotal,
          moonvellaTax: amounts.moonvellaTax,
          moonvellaShipping: amounts.moonvellaShipping,
          moonvellaDiscounts: amounts.moonvellaDiscounts,
          moonvellaTotal: amounts.moonvellaTotal,
          items: built.rows.length,
        },
      },
      prisma as never
    );

    /*
     * THE SELLER IS CHARGED WITHOUT ANYBODY OPENING A PAGE.
     *
     * Queued here rather than in the webhook route because this is the first
     * moment there is an order to charge for, and queued rather than charged
     * inline because a Stripe call is a network call to a third party inside
     * the transaction that just created the order. The key is the order, not
     * the delivery, so the several events Shopify sends about one order — the
     * create, the paid, an update — all resolve to a single charge job.
     *
     * Queueing is not charging. Whether anything is actually charged is decided
     * by `chargeSellerForOrder`, which reads the order's state and the seller's
     * settings; an order that is unpaid queues the same job and the job
     * declines it.
     */
    await enqueueJob({
      kind: JOB_KIND.SHOPIFY_SELLER_CHARGE,
      idempotencyKey: `shopify-seller-charge:${order.id}`,
      sellerId: seller.id,
      sellerAccessVersion: seller.accessVersion,
      payload: { orderId: order.id, trigger: "AUTOMATIC" },
    });

    await setIntegrationState("shopify_orders", {
      status: "HEALTHY",
      detail: `Receiving order webhooks; ${built.rows.length} MoonVella line(s) taken in from ${shop}.`,
    });

    await finishEvent(event.id, "SUCCESS");
    return { ok: true, orderId: order.id, moonvellaItems: built.rows.length };
  } catch (error) {
    await finishEvent(
      event.id,
      "FAILED",
      error instanceof Error ? error.message : "unknown error"
    );
    await setIntegrationState("shopify_orders", {
      status: "FAILED",
      error: error instanceof Error ? error.message : "unknown error",
    });
    throw error;
  }
}

/**
 * The payment statuses that mean the seller has been charged, or is being
 * charged right now.
 *
 * Past this line the money on the order is not a calculation any more — it is a
 * figure the seller's statement already carries. MoonVella may still owe the
 * seller a difference, or be owed one, but neither is something a webhook may
 * settle by quietly rewriting the amount that was billed.
 */
const CHARGED_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "REQUIRES_ACTION",
  "PROCESSING",
  "SUCCEEDED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

/**
 * Reconcile an order that Shopify says has changed.
 *
 * WHAT THE LINES KEEP. Every line already on the order is rebuilt at the
 * wholesale unit price recorded on that line, not at the price the catalogue
 * asks for today. A repricing, a corrected pricelist or a variant reinstated
 * under a new SKU must not reach back into an order and change what was billed;
 * the snapshot on the line is the receipt.
 *
 * WHAT THE TOTALS KEEP. If the seller has been charged, the money aggregates on
 * the order are left exactly as they were charged, and everything else — status,
 * addresses, line detail, the Shopify timestamps — still updates. A line that
 * genuinely arrived afterwards, or a quantity the customer really changed, is a
 * difference between what was billed and what is owed: it is computed, recorded
 * in the audit as an unbilled difference, and left for a person to bill or
 * credit deliberately. Rewriting the stored total would make the invoice and
 * the charge disagree in the one place nobody thinks to look.
 *
 * The key is Shopify's line item id, which is the same key the reconciliation
 * below matches on — so a line is frozen exactly as reliably as it is found,
 * and no more.
 */
async function handleUpdated(
  eventId: string,
  shop: string,
  order: {
    id: string;
    items: {
      id: string;
      shopifyLineItemId: string;
      wholesalePrice: number;
      quantity: number;
    }[];
    financialStatus: string | null;
    state: OrderState;
    fulfillmentStatus: "PENDING" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "PARTIAL";
    wholesalePaymentStatus: string;
    moonvellaSubtotal: number;
    moonvellaTax: number;
    moonvellaShipping: number;
    moonvellaDiscounts: number;
    moonvellaTotal: number;
  },
  payload: OrderPayload,
  byVariant: Map<string, VariantMapping>
): Promise<IntakeResult> {
  const frozenUnitPrices = new Map(order.items.map((i) => [i.shopifyLineItemId, i.wholesalePrice]));
  const built = await buildItems(payload.line_items ?? [], byVariant, frozenUnitPrices);
  const amounts = computeAmounts(payload, built);
  const charged = CHARGED_PAYMENT_STATUSES.has(order.wholesalePaymentStatus);

  const storedLines = new Map(order.items.map((i) => [i.shopifyLineItemId, i]));
  const incoming = new Set(built.rows.map((row) => row.shopifyLineItemId));
  const addedLines = built.rows.filter((row) => !storedLines.has(row.shopifyLineItemId));
  const removedLines = order.items.filter((item) => !incoming.has(item.shopifyLineItemId));
  const quantityChanges = built.rows.flatMap((row) => {
    const stored = storedLines.get(row.shopifyLineItemId);
    if (!stored || stored.quantity === row.quantity) return [];
    return [{ id: row.shopifyLineItemId, sku: row.sku, from: stored.quantity, to: row.quantity }];
  });

  const storedTotals = {
    moonvellaSubtotal: order.moonvellaSubtotal,
    moonvellaTax: order.moonvellaTax,
    moonvellaShipping: order.moonvellaShipping,
    moonvellaDiscounts: order.moonvellaDiscounts,
    moonvellaTotal: order.moonvellaTotal,
  };
  const rebuiltTotals = {
    moonvellaSubtotal: amounts.moonvellaSubtotal,
    moonvellaTax: amounts.moonvellaTax,
    moonvellaShipping: amounts.moonvellaShipping,
    moonvellaDiscounts: amounts.moonvellaDiscounts,
    moonvellaTotal: amounts.moonvellaTotal,
  };
  const totalsMoved = (Object.keys(storedTotals) as (keyof typeof storedTotals)[]).some(
    (key) => storedTotals[key] !== rebuiltTotals[key]
  );
  const linesMoved = addedLines.length > 0 || removedLines.length > 0 || quantityChanges.length > 0;
  /**
   * Whether this event MOVED money, as opposed to leaving a difference standing.
   *
   * An unbilled order's money moves when its totals do, whatever the cause: a
   * changed line, or an adjustment Shopify made on its own. A charged order's
   * money cannot move, because it is not applied — what can move is the ground
   * the obligation stands on, which is the lines.
   *
   * Its computed total is therefore left out of this test on purpose. A charged
   * order with a standing difference would otherwise re-record the same
   * discrepancy on every routine webhook, and an audit that repeats itself is
   * an audit nobody reads. The consequence is stated rather than hidden: on a
   * charged order, an adjustment-only change is not given an entry of its own.
   * Every entry carries the full computed total beside the charged one, so
   * whichever entry is written last is a complete statement of the difference.
   */
  const moneyMoved = linesMoved || (!charged && totalsMoved);
  /**
   * What a fresh charge would come to, less what was charged. It is the whole
   * wholesale difference — the added lines, the changed quantities, and the tax
   * and shipping those lines carry — because that is the invoice a person would
   * have to raise, not just the subtotal.
   */
  const unbilledDifference = rebuiltTotals.moonvellaTotal - storedTotals.moonvellaTotal;

  let refundsCreated = 0;

  /*
   * Read before the write, so the comparison is against what the order said
   * when it was last quoted rather than against the value this same event is
   * about to store. A webhook that repeats an unchanged address must not
   * withdraw anything, or every routine update would empty the quote table.
   */
  const beforeUpdate = await prisma.order.findUnique({
    where: { id: order.id },
    select: { shippingAddress: true },
  });
  const addressChanged =
    Boolean(payload.shipping_address) &&
    addressMateriallyDiffers(beforeUpdate?.shippingAddress, payload.shipping_address);

  await prisma.$transaction(async (tx) => {
    for (const row of built.rows) {
      const existing = order.items.find((i) => i.shopifyLineItemId === row.shopifyLineItemId);
      if (existing) {
        await tx.orderItem.update({ where: { id: existing.id }, data: row });
      } else {
        await tx.orderItem.create({ data: { orderId: order.id, ...row } });
      }
    }

    for (const existing of order.items) {
      if (incoming.has(existing.shopifyLineItemId)) continue;
      const refundItems = await tx.refundItem.count({ where: { orderItemId: existing.id } });
      if (refundItems === 0) {
        await tx.orderItem.delete({ where: { id: existing.id } });
      }
    }

    await tx.order.update({
      where: { id: order.id },
      data: {
        /*
         * A charged order's money is left alone. Everything else on it — the
         * statuses, the addresses, the timestamps — is still brought up to
         * date, so the order tracks Shopify exactly as it did before; only the
         * figures the seller has already been billed for are held.
         */
        ...(charged ? {} : amounts),
        ...(payload.financial_status
          ? {
              financialStatus: payload.financial_status,
              paymentStatus: mapPaymentStatus(payload.financial_status),
            }
          : {}),
        fulfillmentStatus: mapFulfillmentStatus(payload.fulfillment_status, order.fulfillmentStatus),
        /*
         * Shopify's own word for the fulfilment state, kept verbatim beside
         * MoonVella's view of it. The two disagree constantly and for good
         * reason — MoonVella's advances when MoonVella ships, and Shopify has a
         * "restocked" this app has no equivalent for — so the only way to
         * compare them without inverting a lossy mapping is to keep both.
         */
        shopifyFulfillmentState: payload.fulfillment_status ?? null,
        customerEmail: payload.email ?? payload.customer?.email ?? undefined,
        customerName: customerName(payload) ?? undefined,
        customerPhone: payload.customer?.phone ?? undefined,
        ...(payload.shipping_address ? { shippingAddress: addressJson(payload.shipping_address) } : {}),
        ...(payload.billing_address ? { billingAddress: addressJson(payload.billing_address) } : {}),
        shopifyUpdatedAt: payload.updated_at ? new Date(payload.updated_at) : new Date(),
      },
    });

    refundsCreated = await reconcileRefunds(tx, order.id, payload.refunds);
  });

  await recordAudit(
    {
      actorType: "WEBHOOK",
      actorId: shop,
      actorName: shop,
      action: "order.updated",
      entityType: AUDIT_ENTITY.ORDER,
      entityId: order.id,
      afterData: {
        moonvellaSubtotal: amounts.moonvellaSubtotal,
        moonvellaTax: amounts.moonvellaTax,
        moonvellaShipping: amounts.moonvellaShipping,
        moonvellaDiscounts: amounts.moonvellaDiscounts,
        moonvellaTotal: amounts.moonvellaTotal,
        // Whether the figures above are what the order now carries, or what a
        // recompute would say while the charged totals were left in place. The
        // money entry below says the same thing in full; this is here so the
        // two entries can never be read apart.
        moneyApplied: charged ? "KEPT_CHARGED_TOTALS" : "RECOMPUTED",
        items: built.rows.length,
        refundsCreated,
      },
    },
    prisma as never
  );

  /*
   * The money trail. Written only when something money-relevant actually moved:
   * a webhook that changed an address or a fulfilment status leaves nothing
   * here, because an audit padded with no-ops is an audit nobody reads.
   *
   * Both sides are recorded — the figures the order carried, line by line, and
   * the figures the rebuild produced, line by line and flagged by origin. On a
   * charged order the two disagree by design, and `unbilledDifference` is that
   * disagreement stated in money: what a person would bill or credit if they
   * decided the added item was the customer's to pay for. Nothing here bills
   * it. The point is that the decision is visible, and cannot be made by
   * accident.
   */
  if (moneyMoved) {
    await recordAudit(
      {
        actorType: "WEBHOOK",
        actorId: shop,
        actorName: shop,
        action: "order.money_updated",
        entityType: AUDIT_ENTITY.ORDER,
        entityId: order.id,
        beforeData: {
          totals: storedTotals,
          lines: order.items.map((item) => ({
            id: item.shopifyLineItemId,
            wholesale: item.wholesalePrice,
            quantity: item.quantity,
          })),
        },
        afterData: {
          // What the order carries now. Equal to the recompute unless the
          // seller had already been charged.
          totals: charged ? storedTotals : rebuiltTotals,
          computedTotals: rebuiltTotals,
          chargedTotalsKept: charged,
          ...(charged ? { unbilledDifference } : {}),
          lines: built.rows.map((row) => ({
            id: row.shopifyLineItemId,
            wholesale: row.wholesalePrice,
            quantity: row.quantity,
            // SNAPSHOT: the line kept the price it was billed at. CATALOGUE:
            // the line is new, so it took the price in force today.
            priceSource: built.priceSource.get(row.shopifyLineItemId) ?? "CATALOGUE",
          })),
          addedLines: addedLines.map((row) => ({
            id: row.shopifyLineItemId,
            sku: row.sku,
            quantity: row.quantity,
            wholesale: row.wholesalePrice,
          })),
          removedLines: removedLines.map((item) => ({
            id: item.shopifyLineItemId,
            quantity: item.quantity,
            wholesale: item.wholesalePrice,
          })),
          quantityChanges,
        },
      },
      prisma as never
    );
  }

  /*
   * A quote prices the parcels AND the destination that existed when it was
   * asked for. If the customer's address changed, every quote on the order is a
   * price to somewhere else, so they are withdrawn — and the withdrawal is
   * recorded on the order, where the operator who wonders where the quotes went
   * is already looking.
   *
   * After the transaction rather than inside it, deliberately: this is the same
   * function the admin pages call, so there is one definition of what
   * withdrawing a quote means. Folding it into the transaction would mean a
   * second copy of that write, and the failure it guards against — a stale
   * quote surviving a crash in a sub-second window — is recoverable by
   * re-quoting, unlike a second definition that silently drifts.
   */
  if (addressChanged) {
    await invalidateQuotes(order.id, QUOTE_INVALIDATION.addressChanged, {
      actorId: shop,
      actorName: shop,
      actorType: "WEBHOOK",
    });
  }

  /*
   * THE CUSTOMER'S MONEY ARRIVING IS WHAT MAKES THE SELLER'S CHARGE DUE.
   *
   * An order that was created unpaid and paid later produces this update, not a
   * second create, and the charge job queued at intake has already run and
   * declined because nothing had been paid. Re-queueing under the same key
   * revives that finished row, so the seller is charged the moment the store
   * has the customer's money — without a second charge job ever existing, and
   * without anything having to notice that the first run declined.
   *
   * Only while the order is still waiting on the seller. An order that has
   * already been charged, or whose charge failed and is waiting for the
   * seller's own retry, must not be re-attempted by a routine update.
   */
  if (payload.financial_status === "paid" && order.state === "AWAITING_SELLER_PAYMENT") {
    await enqueueJob({
      kind: JOB_KIND.SHOPIFY_SELLER_CHARGE,
      idempotencyKey: `shopify-seller-charge:${order.id}`,
      sellerId: undefined,
      payload: { orderId: order.id, trigger: "AUTOMATIC" },
    });
  }

  await finishEvent(eventId, "SUCCESS");
  return { ok: true, orderId: order.id, updated: true, moonvellaItems: built.rows.length, refunds: refundsCreated };
}

/** Who a delivery is attributed to. A replay is still Shopify's event, run by a person. */
function intakeActor(source: IntakeSource, shop: string): StateActor {
  return source === "REPLAY"
    ? { actorType: "ADMIN_USER", actorId: "replay", actorName: "Operator replay" }
    : { actorType: "WEBHOOK", actorId: shop, actorName: shop };
}

/**
 * A cancellation, which means two different things depending on the money.
 *
 * BEFORE THE CHARGE it is simply the end of the order: the customer withdrew,
 * MoonVella never took anything from the seller, and there is nothing to give
 * back. The order is cancelled, the warehouse is told to stop, and that is the
 * whole of it.
 *
 * AFTER THE CHARGE the seller has paid for goods nobody is going to ship, and
 * MoonVella is holding money for a sale that no longer exists. That is not a
 * state a webhook may resolve by itself — refunding is MoonVella's decision to
 * make deliberately, on its own rule — so the order is held in REFUND_REVIEW,
 * which does nothing except be visible. `cancellationTarget` is what decides
 * between the two, so the rule lives in one place rather than in a condition
 * repeated at every caller that can see a cancellation.
 *
 * THE CHARGE IS NOT CANCELLED AUTOMATICALLY IN EITHER CASE. A PaymentIntent
 * that has succeeded cannot be un-succeeded, and cancelling one that is merely
 * pending is a decision about money that a customer's change of mind does not
 * make for MoonVella.
 */
async function handleCancelled(
  eventId: string,
  shop: string,
  order: {
    id: string;
    state: OrderState;
    fulfillmentRequest: { id: string; status: string } | null;
  } | null,
  payload: OrderPayload
): Promise<IntakeResult> {
  if (!order) {
    /*
     * A cancellation for an order this app never took in. That is a real
     * answer, not a failure: the order was never MoonVella's, so there is
     * nothing to cancel. It is recorded as a SUCCESS with the reason, because
     * an operator asking "did we get the cancellation" needs to see that we
     * did and what we did with it.
     */
    await finishEvent(eventId, "SUCCESS", "Order not found for cancellation");
    return { ok: true, cancelled: 0 };
  }

  const target = cancellationTarget(order.state);

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        cancelledAt: payload.cancelled_at ? new Date(payload.cancelled_at) : new Date(),
        cancelReason: payload.cancel_reason ?? null,
        fulfillmentStatus: "CANCELLED",
      },
    });

    if (
      order.fulfillmentRequest &&
      (order.fulfillmentRequest.status === "PENDING" || order.fulfillmentRequest.status === "ACCEPTED")
    ) {
      await tx.fulfillmentRequest.update({
        where: { id: order.fulfillmentRequest.id },
        data: { status: "CANCELLED" },
      });
    }

    await transitionOrder(
      {
        orderId: order.id,
        to: target,
        actor: { actorType: "WEBHOOK", actorId: shop, actorName: shop },
        reason:
          target === "REFUND_REVIEW"
            ? `Cancelled after the seller was charged (${order.state}); the wholesale payment needs a decision.`
            : `Cancelled by the customer while still unpaid (${order.state}).`,
      },
      tx
    );
  });

  /*
   * Nothing more is queued for a cancelled order. A charge job already waiting
   * will find a CANCELLED order and decline — see `chargeSellerForOrder` — so
   * the cancellation does not need to hunt down the queue to be safe.
   */
  await recordAudit(
    {
      actorType: "WEBHOOK",
      actorId: shop,
      actorName: shop,
      action: "order.cancelled",
      entityType: AUDIT_ENTITY.ORDER,
      entityId: order.id,
      afterData: {
        cancelReason: payload.cancel_reason ?? null,
        fromState: MONEY_CLEARED.has(order.state) ? "CHARGED" : "UNCHARGED",
        landedIn: target,
      },
    },
    prisma as never
  );

  await finishEvent(eventId, "SUCCESS");
  return { ok: true, orderId: order.id, cancelled: 1 };
}

/**
 * A customer refund, which is the seller's transaction and not MoonVella's.
 *
 * The Refund row is written so the order's page shows what the customer got
 * back, and the order is held in REFUND_REVIEW when — and only when — the
 * seller's own charge has already cleared. Nothing is sent to Stripe from here
 * in any case: whether MoonVella gives the seller back the wholesale price of
 * goods the customer refused is MoonVella's decision, made deliberately, and
 * `refundSellerCharge` is the only thing that makes it.
 */
async function handleRefund(
  eventId: string,
  shop: string,
  order: { id: string; state: OrderState } | null,
  payload: OrderPayload
): Promise<IntakeResult> {
  if (!order) {
    await finishEvent(eventId, "SUCCESS", "Refund for an order this app does not have");
    return { ok: true, refunds: 0 };
  }

  const refundsCreated = await prisma.$transaction((tx) =>
    reconcileRefunds(tx, order.id, [payload as unknown as RefundPayload])
  );

  let landedIn: OrderState | null = null;
  if (MONEY_CLEARED.has(order.state)) {
    const target = cancellationTarget(order.state);
    await transitionOrder({
      orderId: order.id,
      to: target,
      actor: { actorType: "WEBHOOK", actorId: shop, actorName: shop },
      reason: "The customer was refunded after the seller had been charged.",
    }).catch(() => undefined);
    landedIn = target;
  }

  await recordAudit(
    {
      actorType: "WEBHOOK",
      actorId: shop,
      actorName: shop,
      action: "order.refund_recorded",
      entityType: AUDIT_ENTITY.ORDER,
      entityId: order.id,
      afterData: {
        refundsCreated,
        orderWasCharged: MONEY_CLEARED.has(order.state),
        landedIn,
        note:
          "A customer refund does not move MoonVella money. Whether the seller's wholesale charge " +
          "is refunded is a separate decision, recorded on the payment when it is made.",
      },
    },
    prisma as never
  );

  await finishEvent(eventId, "SUCCESS");
  return { ok: true, orderId: order.id, refunds: refundsCreated };
}

/**
 * Shopify has finished routing the order's lines.
 *
 * The routing event is the earliest moment a fulfillment order for this order
 * may exist, so this is where a paid order gets handed to the fulfilment queue.
 * An unpaid order is left alone — the fulfilment handler refuses it anyway, and
 * queueing work that is certain to be refused only fills the queue with
 * failures an operator has to read past.
 */
async function handleRoutingComplete(
  eventId: string,
  shop: string,
  order: { id: string; state: OrderState } | null
): Promise<IntakeResult> {
  if (!order) {
    await finishEvent(eventId, "SUCCESS", "Routing completed for an order this app does not have");
    return { ok: true };
  }

  if (MONEY_CLEARED.has(order.state)) {
    await enqueueJob({
      kind: JOB_KIND.SHOPIFY_FULFILLMENT_SUBMIT,
      idempotencyKey: `shopify-fulfillment-submit:${order.id}`,
      payload: { orderId: order.id, reason: "order_routing_complete" },
    });
  }

  await finishEvent(eventId, "SUCCESS");
  return { ok: true, orderId: order.id };
}
