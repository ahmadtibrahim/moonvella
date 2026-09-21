/**
 * Invitation-only account creation.
 *
 * There is no public sign-up. An account comes into existence in exactly one
 * way: an owner with users.manage creates an invitation, and the person named
 * on it redeems the link and chooses their own password. Nobody — not the
 * owner, not an operator — ever chooses a password on someone else's behalf
 * through this path, so no one else ever knows it.
 *
 * Only the digest of an invitation token is stored, so a leaked database
 * snapshot yields no redeemable link. The consequence is that the link can be
 * shown exactly once, at creation; the owner copies it then. That is a real
 * usability cost and it is the intended trade.
 */

import type { AdminRole, AdminInvitation } from "@prisma/client";
import { prisma } from "~/db.server";
import { hashPassword } from "~/utils/auth.server";
import {
  INVITATION_TTL_HOURS,
  generateToken,
  hashToken,
  normalizeEmail,
  validatePasswordStrength,
} from "./adminAuth.server";
import {
  AUDIT_ENTITY,
  SECURITY_ACTION,
  securityAudit,
  type AuditInput,
} from "./audit.server";

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

type Actor = { id: string; name: string };

export type CreateInvitationResult =
  | {
      ok: true;
      /** The raw token. Exists here and in the returned URL, and nowhere else. */
      token: string;
      invitationId: string;
      email: string;
      name: string;
      role: AdminRole;
      expiresAt: Date;
    }
  | { ok: false; error: string };

/**
 * Create an invitation.
 *
 * Refuses when an *active* account already exists for the address. That is the
 * "no silent re-invite" rule: inviting a colleague who already has a working
 * account should never quietly mint a second credential for them. An *inactive*
 * account is allowed through on purpose — that is the recovery path when
 * someone is disabled and needs to be brought back, and it is deliberate
 * because it takes an explicit owner action.
 */
export async function createInvitation(
  input: { email: string; name: string; role: AdminRole },
  actor: Actor,
  meta: RequestMeta = {}
): Promise<CreateInvitationResult> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();

  if (!email || !email.includes("@")) {
    return { ok: false, error: "A valid email address is required." };
  }
  if (!name) {
    return { ok: false, error: "A display name is required." };
  }

  const existingUser = await prisma.adminUser.findUnique({ where: { email } });
  if (existingUser?.isActive) {
    return {
      ok: false,
      error:
        "An active account already exists for that address. Disable it first if you intend to re-invite, or ask the owner to reset its password.",
    };
  }

  const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
  const token = generateToken();

  const invitation = await prisma.$transaction(async (tx) => {
    // Supersede any earlier unused invitation for the same address, so only one
    // link is ever live. Leaving several valid links in circulation would make
    // "cancel the invitation" mean something weaker than it appears to.
    await tx.adminInvitation.updateMany({
      where: { email, status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    const created = await tx.adminInvitation.create({
      data: {
        email,
        name,
        role: input.role,
        tokenHash: hashToken(token),
        expiresAt,
        invitedById: actor.id,
      },
    });

    await securityAudit(
      SECURITY_ACTION.INVITATION_CREATED,
      actor,
      { id: created.id, name },
      {
        ip: meta.ip,
        userAgent: meta.userAgent,
        after: { email, role: input.role, expiresAt: expiresAt.toISOString() },
        entityType: AUDIT_ENTITY.INVITATION,
      },
      tx as unknown as Parameters<typeof securityAudit>[4]
    );

    return created;
  });

  return {
    ok: true,
    token,
    invitationId: invitation.id,
    email,
    name,
    role: input.role,
    expiresAt,
  };
}

/**
 * Cancel a pending invitation.
 *
 * The guarded updateMany is the whole point: it transitions PENDING ->
 * CANCELLED and reports whether it was the caller that made that transition.
 * A read-then-write would let two cancellations both believe they succeeded,
 * and would let an already-accepted invitation be "cancelled" after the fact.
 */
export async function cancelInvitation(
  invitationId: string,
  actor: Actor,
  meta: RequestMeta = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const invitation = await prisma.adminInvitation.findUnique({
    where: { id: invitationId },
  });

  if (!invitation) return { ok: false, error: "Invitation not found." };
  if (invitation.status !== "PENDING") {
    return { ok: false, error: `That invitation is already ${invitation.status.toLowerCase()}.` };
  }

  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.adminInvitation.updateMany({
      where: { id: invitationId, status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    if (result.count === 1) {
      await securityAudit(
        SECURITY_ACTION.INVITATION_CANCELLED,
        actor,
        { id: invitationId, name: invitation.name },
        {
          ip: meta.ip,
          userAgent: meta.userAgent,
          before: { status: "PENDING", email: invitation.email, role: invitation.role },
          entityType: AUDIT_ENTITY.INVITATION,
        },
        tx as unknown as Parameters<typeof securityAudit>[4]
      );
    }

    return result;
  });

  if (claimed.count !== 1) {
    return { ok: false, error: "That invitation was already used or cancelled." };
  }
  return { ok: true };
}

/** Invitations for the admin list, newest first. Never exposes token digests. */
export async function listInvitations(limit = 100) {
  const rows = await prisma.adminInvitation.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { invitedBy: { select: { id: true, name: true, email: true } } },
  });

  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    cancelledAt: row.cancelledAt,
    invitedBy: row.invitedBy,
    /**
     * Expiry is derived, not stored. A stored EXPIRED status would need a cron
     * job to stay true and would be wrong for the window between lapsing and
     * the job running; deriving it is always correct.
     */
    isExpired: row.status === "PENDING" && row.expiresAt <= now,
    isRedeemable: row.status === "PENDING" && row.expiresAt > now,
  }));
}

export type InvitationLookup =
  | { state: "valid"; invitation: AdminInvitation }
  | { state: "invalid"; reason: "not_found" | "expired" | "used" | "cancelled" };

/**
 * Resolve a token for the acceptance page.
 *
 * The caller must render the same message for every failure — see the accept
 * route. Distinguishing "no such invitation" from "already used" in the page
 * text would let someone probe which addresses have been invited.
 */
export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  if (!token) return { state: "invalid", reason: "not_found" };

  const invitation = await prisma.adminInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  if (!invitation) return { state: "invalid", reason: "not_found" };
  if (invitation.status === "CANCELLED") return { state: "invalid", reason: "cancelled" };
  if (invitation.status === "ACCEPTED") return { state: "invalid", reason: "used" };
  if (invitation.expiresAt <= new Date()) return { state: "invalid", reason: "expired" };

  return { state: "valid", invitation };
}

export type RedeemResult =
  | { ok: true; userId: string; email: string; role: AdminRole }
  | { ok: false; error: string };

/**
 * Redeem an invitation and create the account.
 *
 * Single use is enforced by a conditional UPDATE rather than by reading the
 * row and then writing it. Two submissions of the same link therefore cannot
 * both succeed: the second UPDATE matches no PENDING row and reports zero, and
 * the transaction rolls back rather than creating a second account.
 *
 * The role comes from the invitation row and is never read from the request.
 * That is what stops an invitee accepting a CATALOG invitation as an OWNER by
 * editing the form.
 */
export async function redeemInvitation(
  token: string,
  password: string,
  meta: RequestMeta = {}
): Promise<RedeemResult> {
  const lookup = await lookupInvitation(token);
  if (lookup.state !== "valid") {
    return { ok: false, error: "This invitation link is not valid." };
  }

  const invitation = lookup.invitation;

  const strengthError = validatePasswordStrength(password);
  if (strengthError) return { ok: false, error: strengthError };

  const passwordHash = await hashPassword(password);

  try {
    const userId = await prisma.$transaction(async (tx) => {
      // Claim it. If another request got here first, count is 0 and we abort.
      const claimed = await tx.adminInvitation.updateMany({
        where: { id: invitation.id, status: "PENDING" },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });

      if (claimed.count !== 1) {
        throw new InvitationRaceLost();
      }

      const existing = await tx.adminUser.findUnique({ where: { email: invitation.email } });

      if (existing?.isActive) {
        // Became active between invitation and redemption. Refuse rather than
        // overwrite a working account's credentials.
        throw new InvitationRaceLost();
      }

      const user = existing
        ? await tx.adminUser.update({
            where: { id: existing.id },
            data: {
              name: invitation.name,
              passwordHash,
              role: invitation.role,
              isActive: true,
              emailVerifiedAt: new Date(),
              mustChangePassword: false,
              failedLoginCount: 0,
              lockedUntil: null,
            },
          })
        : await tx.adminUser.create({
            data: {
              email: invitation.email,
              name: invitation.name,
              passwordHash,
              role: invitation.role,
              emailVerifiedAt: new Date(),
              createdById: invitation.invitedById,
            },
          });

      // An account whose credentials just changed must not keep any session
      // that predates the change. A recovered (previously disabled) account in
      // particular could otherwise still hold a live cookie.
      await tx.adminSession.deleteMany({ where: { userId: user.id } });

      await securityAudit(
        SECURITY_ACTION.INVITATION_ACCEPTED,
        { id: invitation.invitedById, name: "Inviting owner" },
        { id: user.id, name: user.name },
        {
          ip: meta.ip,
          userAgent: meta.userAgent,
          after: { email: user.email, role: user.role, invitationId: invitation.id },
        },
        tx as unknown as Parameters<typeof securityAudit>[4]
      );

      return user.id;
    });

    return { ok: true, userId, email: invitation.email, role: invitation.role };
  } catch (error) {
    if (error instanceof InvitationRaceLost) {
      return { ok: false, error: "This invitation link is not valid." };
    }
    throw error;
  }
}

/** Internal signal for "another request won the race". Never escapes this file. */
class InvitationRaceLost extends Error {
  constructor() {
    super("invitation was already redeemed");
    this.name = "InvitationRaceLost";
  }
}

/**
 * Invitation rows for the security section of a user's audit view.
 * `tokenHash` is excluded at the query level so it cannot be rendered by
 * accident.
 */
export async function invitationsForUser(userId: string) {
  return prisma.adminInvitation.findMany({
    where: { invitedById: userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      acceptedAt: true,
    },
  });
}

/** Re-export so route modules import one place for audit typing. */
export type { AuditInput };
