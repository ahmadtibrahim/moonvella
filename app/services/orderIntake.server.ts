import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";
import { toCm, toKg } from "./packaging.server";

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
  packages: {
    length: number;
    width: number;
    height: number;
    dimensionUnit: string;
    grossWeight: number;
    weightUnit: string;
    unitsPerPackage: number;
    sortOrder: number;
  }[];
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
 * Packaging is stored per variant and a variant may have several cartons; the
 * first is the one the shipping feature quotes from, so it is the one an order
 * should record. A package measured in inches is converted rather than copied,
 * because the snapshot columns are canonical cm/kg and a mixed-unit column
 * would be unreadable a year from now.
 *
 * The conversion itself is `packaging.server`'s, imported rather than repeated:
 * one unit conversion, in one place, is the only way the quote and the order
 * line can be guaranteed to agree.
 */
function snapshotFor(variant: VariantSnapshotSource, chargedRetailCents: number) {
  const packages = [...variant.packages].sort((a, b) => a.sortOrder - b.sortOrder);
  const carton = packages[0] ?? null;
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
 */
function buildItems(items: LineItem[], byVariant: Map<string, VariantMapping>): BuiltItems {
  const moonvellaItems = items.filter((li) => li.variant_id && byVariant.has(String(li.variant_id)));
  let moonvellaSubtotal = 0;
  let retailTotal = 0;
  let lineDiscountTotal = 0;
  let lineTaxTotal = 0;

  const rows = moonvellaItems.map((li) => {
    const mapping = byVariant.get(String(li.variant_id))!;
    const variant = mapping.productVariant;
    const quantity = Number(li.quantity) || 0;
    const retailUnit = cents(li.price);
    const wholesaleUnit = variant.wholesalePrice;
    const lineDiscount = sumDiscounts(li);
    retailTotal += retailUnit * quantity;
    moonvellaSubtotal += wholesaleUnit * quantity;
    lineDiscountTotal += lineDiscount;
    lineTaxTotal += sumTaxes(li);
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
      ...snapshotFor(variant, retailUnit),
    };
  });

  return { rows, moonvellaSubtotal, retailTotal, lineDiscountTotal, lineTaxTotal };
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

async function finishEvent(id: string, status: "SUCCESS" | "FAILED", errorMessage?: string | null) {
  await prisma.webhookEvent.update({
    where: { id },
    data: {
      status,
      processedAt: new Date(),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
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
export async function intakeOrder(input: { topic: string; shop: string; payload: OrderPayload }): Promise<IntakeResult> {
  const { topic, shop, payload } = input;
  const orderId = payload?.id;
  if (!orderId) {
    return { ok: false, reason: "missing order id" };
  }

  const isCancelled = topic === "ORDERS_CANCELLED";
  const isUpdated = topic === "ORDERS_UPDATED";
  const version = payload.updated_at ?? payload.cancelled_at ?? payload.created_at ?? "";
  const idempotencyKey = `${shop}:${topic}:${orderId}:${version}`;
  const already = await prisma.webhookEvent.findUnique({ where: { idempotencyKey } });
  if (already) {
    return { ok: true, duplicate: true };
  }

  const event = await prisma.webhookEvent.create({
    data: {
      shopDomain: shop,
      topic,
      payload: JSON.stringify(payload),
      status: "PROCESSING",
      idempotencyKey,
    },
  });

  try {
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

    const items = payload.line_items ?? [];
    const variantIds = items
      .map((li) => (li.variant_id ? String(li.variant_id) : null))
      .filter((v): v is string => !!v);

    const mappings = await prisma.sellerProductVariant.findMany({
      where: {
        sellerProduct: { sellerId: seller.id },
        shopifyVariantId: { in: variantIds },
      },
      // Read once, at intake, and copied onto the order line. The relations are
      // included because the snapshot needs the option pairs, the family code
      // and the carton — all of which can change later, which is exactly why
      // the copy exists.
      include: {
        productVariant: {
          include: {
            variantOptions: { orderBy: { sortOrder: "asc" } },
            product: { select: { productCode: true } },
            packages: { orderBy: { sortOrder: "asc" } },
          },
        },
        sellerProduct: true,
      },
    });
    const byVariant = new Map<string, VariantMapping>();
    for (const mapping of mappings) {
      byVariant.set(mapping.shopifyVariantId, mapping);
    }

    if (isUpdated && existingOrder) {
      return await handleUpdated(event.id, shop, existingOrder, payload, byVariant);
    }

    const built = buildItems(items, byVariant);
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

      await tx.wholesalePayment.create({
        data: {
          orderId: created.id,
          sellerId: seller.id,
          amount: built.moonvellaSubtotal,
          currency: payload.currency ?? "CAD",
          provider: "stripe",
          status: "REQUIRES_PAYMENT",
          idempotencyKey: `wholesale:${supplierReference}`,
        },
      });

      await reconcileRefunds(tx, created.id, payload.refunds);
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

    await setIntegrationState("shopify_orders", {
      status: "HEALTHY",
      detail: "Receiving order webhooks and creating supplier orders.",
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

async function handleUpdated(
  eventId: string,
  shop: string,
  order: {
    id: string;
    items: { id: string; shopifyLineItemId: string }[];
    financialStatus: string | null;
    fulfillmentStatus: "PENDING" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "PARTIAL";
  },
  payload: OrderPayload,
  byVariant: Map<string, VariantMapping>
): Promise<IntakeResult> {
  const built = buildItems(payload.line_items ?? [], byVariant);
  const amounts = computeAmounts(payload, built);
  let refundsCreated = 0;

  await prisma.$transaction(async (tx) => {
    const incoming = new Set(built.rows.map((row) => row.shopifyLineItemId));
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
        ...amounts,
        ...(payload.financial_status
          ? {
              financialStatus: payload.financial_status,
              paymentStatus: mapPaymentStatus(payload.financial_status),
            }
          : {}),
        fulfillmentStatus: mapFulfillmentStatus(payload.fulfillment_status, order.fulfillmentStatus),
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
        items: built.rows.length,
        refundsCreated,
      },
    },
    prisma as never
  );

  await finishEvent(eventId, "SUCCESS");
  return { ok: true, orderId: order.id, updated: true, moonvellaItems: built.rows.length, refunds: refundsCreated };
}

async function handleCancelled(
  eventId: string,
  shop: string,
  order: {
    id: string;
    fulfillmentRequest: { id: string; status: string } | null;
  } | null,
  payload: OrderPayload
): Promise<IntakeResult> {
  if (!order) {
    await finishEvent(eventId, "SUCCESS", "Order not found for cancellation");
    return { ok: true, cancelled: 0 };
  }

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
  });

  await recordAudit(
    {
      actorType: "WEBHOOK",
      actorId: shop,
      actorName: shop,
      action: "order.cancelled",
      entityType: AUDIT_ENTITY.ORDER,
      entityId: order.id,
      afterData: { cancelReason: payload.cancel_reason ?? null },
    },
    prisma as never
  );

  await finishEvent(eventId, "SUCCESS");
  return { ok: true, orderId: order.id, cancelled: 1 };
}
