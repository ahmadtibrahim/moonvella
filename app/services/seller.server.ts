import { prisma } from "~/db.server";
import { authenticate } from "~/shopify.server";
import type { MerchantApplication, Seller } from "@prisma/client";

export type SellerAccess =
  | "NONE"
  | "PENDING"
  | "NEEDS_INFO"
  | "REJECTED"
  | "APPROVED"
  | "SUSPENDED"
  | "BLOCKED";

/**
 * What a blocked store is told. One string, in one place, because it is a
 * promise about what has happened to their account and it appears on more than
 * one screen — two copies of it would eventually disagree.
 */
export const BLOCKED_MESSAGE =
  "Your MoonVella partner access has been blocked. Contact MoonVella support.";

export interface SellerContext {
  shop: string;
  application: MerchantApplication | null;
  seller: Seller | null;
  access: SellerAccess;
  /** Wholesale pricing, profit and exact inventory are only for approved sellers. */
  canViewWholesale: boolean;
  canImport: boolean;
  /** Suspended sellers may still see historical orders/tracking. */
  canViewOrders: boolean;
  /** Only approved sellers may start new business (import, new orders). */
  canStartNewBusiness: boolean;
}

/**
 * The tenant identifier is always the shop from the authenticated Shopify
 * session. A shop domain supplied by a form is never trusted for data access.
 */
export async function getAuthenticatedShop(request: Request): Promise<string> {
  const { session } = await authenticate.admin(request);
  return session.shop;
}

function accessFromStatus(status: string): SellerAccess {
  switch (status) {
    case "APPROVED":
      return "APPROVED";
    case "PENDING":
      return "PENDING";
    case "NEEDS_INFO":
      return "NEEDS_INFO";
    case "REJECTED":
      return "REJECTED";
    case "SUSPENDED":
      return "SUSPENDED";
    case "BLOCKED":
      return "BLOCKED";
    // An uninstalled app is a store that has gone, not one that was refused:
    // it is mapped to the recoverable state so reinstalling does not lose a
    // seller their order history.
    case "UNINSTALLED":
      return "SUSPENDED";
    default:
      return "NONE";
  }
}

/**
 * What each state may do, written out rather than derived.
 *
 * This used to be two booleans — `approved` and `suspended` — with the four
 * flags built from them. That works while there are two refusals. Block is a
 * third, and it differs from suspension in exactly the way a two-variable
 * expression cannot express: both refuse pricing and imports, but a suspended
 * store keeps read access to what it already sold, so a deactivation does not
 * look like data loss, while a blocked one sees nothing at all. Written as a
 * table, each row can be read on its own and an eighth status cannot inherit a
 * permission by falling through the wrong branch.
 */
const ACCESS_RULES: Record<
  SellerAccess,
  { wholesale: boolean; import: boolean; orders: boolean; newBusiness: boolean }
> = {
  NONE: { wholesale: false, import: false, orders: false, newBusiness: false },
  PENDING: { wholesale: false, import: false, orders: false, newBusiness: false },
  NEEDS_INFO: { wholesale: false, import: false, orders: false, newBusiness: false },
  REJECTED: { wholesale: false, import: false, orders: false, newBusiness: false },
  APPROVED: { wholesale: true, import: true, orders: true, newBusiness: true },
  // Recoverable. History stays readable.
  SUSPENDED: { wholesale: false, import: false, orders: true, newBusiness: false },
  // Not recoverable in the sense suspension is. The history still exists and
  // MoonVella staff can still see it; the store cannot.
  BLOCKED: { wholesale: false, import: false, orders: false, newBusiness: false },
};

export async function resolveSellerContext(shop: string): Promise<SellerContext> {
  const application = await prisma.merchantApplication.findUnique({
    where: { shopDomain: shop },
    include: { seller: true },
  });

  const seller =
    application?.seller ??
    (await prisma.seller.findUnique({ where: { shopDomain: shop } }));

  // A seller record is authoritative once it exists; otherwise fall back to the
  // application status so pending merchants are still recognised.
  const access = seller
    ? accessFromStatus(seller.status)
    : application
      ? accessFromStatus(application.status)
      : "NONE";

  const rules = ACCESS_RULES[access];

  return {
    shop,
    application: application ?? null,
    seller: seller ?? null,
    access,
    canViewWholesale: rules.wholesale,
    canImport: rules.import,
    canViewOrders: rules.orders,
    canStartNewBusiness: rules.newBusiness,
  };
}

export async function requireSellerContext(request: Request): Promise<SellerContext> {
  const shop = await getAuthenticatedShop(request);
  return resolveSellerContext(shop);
}

export class AccessError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = "AccessError";
    this.status = status;
  }
}

/**
 * Guard every protected merchant operation. Returns the context or throws a 403
 * AccessError, which route handlers translate into a real error response.
 */
export async function requireApprovedSeller(request: Request): Promise<SellerContext> {
  const context = await requireSellerContext(request);
  if (!context.canStartNewBusiness) {
    throw new AccessError(
      `MoonVella wholesale access requires an approved seller account (current status: ${context.access}).`
    );
  }
  return context;
}

/**
 * Owner-facing seller detail: profile, linked application, settings, order
 * aggregates (count + wholesale revenue in cents) and the seller/application
 * audit history. Returns null when the seller does not exist.
 */
export async function getSellerDetail(id: string) {
  const seller = await prisma.seller.findUnique({
    where: { id },
    include: {
      application: {
        include: { reviewedBy: { select: { name: true, email: true } } },
      },
      settings: true,
      billingSettings: true,
      paymentMethods: { orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] },
      bankAccounts: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!seller) return null;

  const [orderAgg, history] = await Promise.all([
    prisma.order.aggregate({
      where: { sellerId: id },
      _count: true,
      _sum: { moonvellaTotal: true },
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: "Seller", entityId: id },
          ...(seller.applicationId
            ? [{ entityType: "MerchantApplication", entityId: seller.applicationId }]
            : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return {
    seller,
    orderCount: orderAgg._count,
    wholesaleRevenue: orderAgg._sum.moonvellaTotal ?? 0,
    history,
  };
}

export type SellerDetail = NonNullable<Awaited<ReturnType<typeof getSellerDetail>>>;
