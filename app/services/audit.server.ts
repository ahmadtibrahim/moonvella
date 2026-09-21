import { prisma } from "~/db.server";

export type AuditActorType = "ADMIN_USER" | "SYSTEM" | "MERCHANT" | "WEBHOOK";

export const AUDIT_ENTITY = {
  APPLICATION: "MerchantApplication",
  SELLER: "Seller",
  PRODUCT: "Product",
  MEDIA: "MediaAsset",
  SELLER_PRODUCT: "SellerProduct",
  ORDER: "Order",
  SHIPMENT: "Shipment",
  PAYMENT: "WholesalePayment",
  SETTINGS: "SellerSettings",
  ADMIN_USER: "AdminUser",
  INVITATION: "AdminInvitation",
  INTEGRATION: "Integration",
  BILLING_SETTINGS: "SellerBillingSettings",
  PAYMENT_METHOD: "SellerPaymentMethod",
} as const;

/**
 * Security events.
 *
 * Every one of these is a security-relevant change to who may do what, or to
 * the integrity of an account. They share the "security." prefix so the whole
 * class can be selected with one query.
 *
 * What may be recorded alongside them: the acting user, the target user, the
 * source address, the user agent, and the *names* of what changed — old role to
 * new role, which account was disabled. What may never be recorded: passwords,
 * password hashes, session tokens, invitation tokens, or the digests of any of
 * them. An audit log is read by more people than the accounts it describes, and
 * outlives them.
 */
export const SECURITY_ACTION = {
  LOGIN: "security.login",
  LOGIN_FAILED: "security.login_failed",
  LOGIN_THROTTLED: "security.login_throttled",
  LOGOUT: "security.logout",
  PRIMARY_OWNER_CREATED: "security.primary_owner_created",
  INVITATION_CREATED: "security.invitation_created",
  INVITATION_CANCELLED: "security.invitation_cancelled",
  INVITATION_ACCEPTED: "security.invitation_accepted",
  USER_ENABLED: "security.user_enabled",
  USER_DISABLED: "security.user_disabled",
  ROLE_CHANGED: "security.role_changed",
  PASSWORD_CHANGED: "security.password_changed",
  PASSWORD_RESET_BY_OWNER: "security.password_reset_by_owner",
  SESSIONS_REVOKED: "security.sessions_revoked",
} as const;

export type SecurityAction = (typeof SECURITY_ACTION)[keyof typeof SECURITY_ACTION];

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
 * Strip anything that looks like a credential before it reaches the log.
 *
 * Defence in depth. The callers are written not to pass secrets, but a log is
 * append-only and permanent — a mistake here cannot be corrected later, only
 * lived with. This removes the keys outright rather than redacting their
 * values, so the shape of the record does not hint at what was removed.
 */
const FORBIDDEN_KEYS = [
  "password",
  "newPassword",
  "currentPassword",
  "confirmPassword",
  "passwordHash",
  "token",
  "tokenHash",
  "sessionToken",
  "invitationToken",
  "secret",
  "apiKey",
  "cookie",
];

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.some((f) => key.toLowerCase().includes(f.toLowerCase()))) continue;
    out[key] = scrub(val, depth + 1);
  }
  return out;
}

function serializeScrubbed(value: unknown): string | null {
  return serialize(scrub(value));
}

/**
 * Record an audit event. Entity type and entity id must always be supplied so a
 * single entityId never has to reference incompatible tables.
 *
 * Pass a transaction client as the second argument to enrol in a transaction,
 * which is how invitation acceptance and role changes are recorded atomically
 * with the change they describe.
 */
export async function recordAudit(
  input: AuditInput,
  client: AuditClient = prisma as unknown as AuditClient
) {
  return client.auditLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      actorName: input.actorName ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeData: serializeScrubbed(input.beforeData),
      afterData: serializeScrubbed(input.afterData),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 255) : null,
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

/**
 * Record a security event.
 *
 * A thin, named wrapper so security calls read as what they are and cannot be
 * written with the wrong actor type. The actor is always a person.
 */
export function securityAudit(
  action: SecurityAction,
  actor: { id: string; name: string },
  target: { id: string; name?: string | null },
  meta: {
    ip?: string | null;
    userAgent?: string | null;
    before?: unknown;
    after?: unknown;
    entityType?: string;
  } = {},
  client?: AuditClient
) {
  return recordAudit(
    {
      actorType: "ADMIN_USER",
      actorId: actor.id,
      actorName: actor.name,
      action,
      entityType: meta.entityType ?? AUDIT_ENTITY.ADMIN_USER,
      entityId: target.id,
      beforeData: meta.before,
      afterData: meta.after,
      ipAddress: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
    client
  );
}
