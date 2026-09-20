import { prisma } from "~/db.server";

export type AuditActorType = "OWNER_USER" | "SYSTEM" | "MERCHANT" | "WEBHOOK";

export const AUDIT_ENTITY = {
  APPLICATION: "MerchantApplication",
  SELLER: "Seller",
  PRODUCT: "Product",
  SELLER_PRODUCT: "SellerProduct",
  ORDER: "Order",
  SHIPMENT: "Shipment",
  PAYMENT: "WholesalePayment",
  SETTINGS: "SellerSettings",
  OWNER_USER: "OwnerUser",
  INTEGRATION: "Integration",
  BILLING_SETTINGS: "SellerBillingSettings",
  PAYMENT_METHOD: "SellerPaymentMethod",
} as const;

export interface AuditInput {
  actorType: AuditActorType;
  actorId: string;
  actorName?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeData?: unknown;
  afterData?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type AuditClient = {
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
};

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Record an audit event. Entity type + entity id must always be supplied so a
 * single entityId never has to reference incompatible tables.
 * Pass a transaction client as the second argument to enrol in a transaction.
 */
export async function recordAudit(input: AuditInput, client: AuditClient = prisma as unknown as AuditClient) {
  return client.auditLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      actorName: input.actorName ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeData: serialize(input.beforeData),
      afterData: serialize(input.afterData),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

export function systemAudit(
  action: string,
  entityType: string,
  entityId: string,
  extra: Partial<AuditInput> = {}
) {
  return recordAudit({
    actorType: "SYSTEM",
    actorId: "system",
    actorName: "System",
    action,
    entityType,
    entityId,
    ...extra,
  });
}
