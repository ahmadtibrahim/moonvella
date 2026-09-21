/**
 * Staff account administration.
 *
 * Every operation here is performed *by* someone *on* someone else, and the
 * rules that matter are about the target rather than the actor:
 *
 *   - the primary owner cannot be disabled, demoted, or deleted by anyone
 *   - nobody can disable themselves, or demote themselves out of the last
 *     owner seat
 *
 * Some of those are also enforced in the database (partial unique index, CHECK
 * constraints, a BEFORE DELETE trigger) so that a bug here, a careless
 * migration, or a manual UPDATE cannot produce an owner-less installation. The
 * checks in this file exist to turn those database errors into a sentence a
 * human can act on.
 */

import type { AdminRole, AdminUser } from "@prisma/client";
import { prisma } from "~/db.server";
import { hashPassword, verifyPassword } from "~/utils/auth.server";
import {
  hashToken,
  revokeAllSessions,
  validatePasswordStrength,
} from "./adminAuth.server";
import {
  SECURITY_ACTION,
  securityAudit,
  type AuditInput,
} from "./audit.server";

type Actor = { id: string; name: string };

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type AuditTx = Parameters<typeof securityAudit>[4];

export type OpResult = { ok: true; message?: string } | { ok: false; error: string };

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Fields safe to send to a browser. passwordHash is not among them. */
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  isPrimaryOwner: true,
  emailVerifiedAt: true,
  mustChangePassword: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
  failedLoginCount: true,
  lockedUntil: true,
  createdById: true,
} as const;

/**
 * Every staff account.
 *
 * Note the projection: `passwordHash` is not selected, so it cannot reach a
 * component even if someone later spreads this object into one. A select list
 * is a stronger guarantee than remembering to delete a field.
 */
export async function listUsers() {
  const users = await prisma.adminUser.findMany({
    orderBy: [{ isPrimaryOwner: "desc" }, { role: "asc" }, { name: "asc" }],
    select: {
      ...SAFE_USER_SELECT,
      _count: { select: { sessions: true } },
    },
  });
  return users;
}

/** One account, with its active session list, safe for display. */
export async function getUserDetail(userId: string) {
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: {
      ...SAFE_USER_SELECT,
      createdBy: { select: { id: true, name: true, email: true } },
      sessions: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          lastAccessAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
        },
      },
      // `tokenHash` is deliberately absent: it is a credential-equivalent value
      // and has no business in a rendered page.
    },
  });

  if (!user) return null;

  const recentSecurityEvents = await prisma.auditLog.findMany({
    where: {
      OR: [
        { entityType: "AdminUser", entityId: userId },
        { actorId: userId, action: { startsWith: "security." } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      action: true,
      actorId: true,
      actorName: true,
      createdAt: true,
      ipAddress: true,
      beforeData: true,
      afterData: true,
    },
  });

  return { ...user, recentSecurityEvents };
}

/** Active OWNER count, used to protect the last owner seat. */
async function countActiveOwners(client: Tx | typeof prisma = prisma): Promise<number> {
  return client.adminUser.count({ where: { role: "OWNER", isActive: true } });
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Enable or disable an account.
 *
 * Disabling revokes every session immediately, which is what makes the
 * requirement "a disabled user must immediately lose access even if they
 * possess a previously valid session" hold in practice. `validateSession`
 * refuses a disabled user on every request as well, so the revocation is the
 * belt and the validation is the braces.
 */
export async function setUserActive(
  actor: Actor,
  targetId: string,
  isActive: boolean,
  meta: RequestMeta = {}
): Promise<OpResult> {
  const target = await prisma.adminUser.findUnique({ where: { id: targetId } });
  if (!target) return { ok: false, error: "Account not found." };

  if (target.isPrimaryOwner && !isActive) {
    return { ok: false, error: "The primary owner account cannot be disabled." };
  }
  if (target.id === actor.id && !isActive) {
    return { ok: false, error: "You cannot disable your own account." };
  }
  if (!isActive && target.role === "OWNER" && (await countActiveOwners()) <= 1) {
    return { ok: false, error: "This is the last active owner account and cannot be disabled." };
  }

  const revoked = await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: targetId }, data: { isActive } });

    // Explicitly typed as a number: re-enabling revokes nothing, so the two
    // branches do not have to return the same shape for this to read clearly.
    let sessionsRevoked = 0;
    if (!isActive) {
      const removed = await tx.adminSession.deleteMany({ where: { userId: targetId } });
      sessionsRevoked = removed.count;
    }

    await securityAudit(
      isActive ? SECURITY_ACTION.USER_ENABLED : SECURITY_ACTION.USER_DISABLED,
      actor,
      { id: targetId, name: target.name },
      {
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: { isActive: target.isActive, role: target.role },
        after: { isActive, sessionsRevoked },
      },
      tx as unknown as AuditTx
    );

    return sessionsRevoked;
  });

  return {
    ok: true,
    message: isActive
      ? `${target.name} has been reactivated.`
      : `${target.name} has been disabled${revoked ? ` and ${revoked} session(s) revoked` : ""}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Role                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Change a user's role.
 *
 * Every role change revokes that user's sessions — not only reductions. A
 * promotion is also a change to what an existing cookie can do, and the
 * simplest rule that cannot be got wrong is "a role change is a new session".
 * The cost is that the person signs in again.
 */
export async function setUserRole(
  actor: Actor,
  targetId: string,
  role: AdminRole,
  meta: RequestMeta = {}
): Promise<OpResult> {
  const target = await prisma.adminUser.findUnique({ where: { id: targetId } });
  if (!target) return { ok: false, error: "Account not found." };

  if (target.role === role) {
    return { ok: false, error: `${target.name} already has the ${role} role.` };
  }

  if (target.isPrimaryOwner) {
    return { ok: false, error: "The primary owner's role cannot be changed." };
  }

  if (target.id === actor.id && target.role === "OWNER" && (await countActiveOwners()) <= 1) {
    return { ok: false, error: "You are the last active owner; changing your role would remove all owner access." };
  }

  // Demoting the last owner is the same hazard even when it is not yourself:
  // it would leave the installation with no owner at all.
  if (target.role === "OWNER" && role !== "OWNER" && (await countActiveOwners()) <= 1) {
    return { ok: false, error: "This is the last active owner account; it cannot be changed to another role." };
  }

  const revoked = await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: targetId }, data: { role } });
    const sessionsRemoved = await tx.adminSession.deleteMany({ where: { userId: targetId } });

    await securityAudit(
      SECURITY_ACTION.ROLE_CHANGED,
      actor,
      { id: targetId, name: target.name },
      {
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: { role: target.role },
        after: { role, sessionsRevoked: sessionsRemoved.count },
      },
      tx as unknown as AuditTx
    );

    return sessionsRemoved.count;
  });

  return {
    ok: true,
    message: `${target.name} is now ${role}. ${revoked} session(s) revoked — they will need to sign in again.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/** Revoke every session a user holds, without changing anything else. */
export async function revokeUserSessions(
  actor: Actor,
  targetId: string,
  meta: RequestMeta = {}
): Promise<OpResult> {
  const target = await prisma.adminUser.findUnique({ where: { id: targetId } });
  if (!target) return { ok: false, error: "Account not found." };

  const count = await revokeAllSessions(targetId);

  await securityAudit(
    SECURITY_ACTION.SESSIONS_REVOKED,
    actor,
    { id: targetId, name: target.name },
    {
      ip: meta.ip,
      userAgent: meta.userAgent,
      after: { sessionsRevoked: count },
    }
  );

  return { ok: true, message: `${count} session(s) revoked for ${target.name}.` };
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Change your own password.
 *
 * Requires the current password, so a borrowed session cannot be used to lock
 * the real owner out. Every other session is revoked; the caller's own session
 * survives because they are the one asking. Weakening that to "revoke
 * everything" would sign the user out of the page they are standing on, which
 * trains people to expect it and dulls the signal when it matters.
 */
export async function changeOwnPassword(
  actor: { id: string; name: string },
  currentPassword: string,
  newPassword: string,
  currentSessionToken: string | undefined,
  meta: RequestMeta = {}
): Promise<OpResult> {
  const user = await prisma.adminUser.findUnique({ where: { id: actor.id } });
  if (!user || !user.passwordHash) {
    return { ok: false, error: "Account not found." };
  }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, error: "Current password is incorrect." };
  }

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return { ok: false, error: strengthError };

  if (currentPassword === newPassword) {
    return { ok: false, error: "The new password must differ from the current one." };
  }

  const passwordHash = await hashPassword(newPassword);

  // Identify the session making this request so it can be spared. Without a
  // resolvable session token we revoke everything, which is the safe direction
  // to fail: the user signs in again, and no stale session survives a password
  // change. The dangerous outcome would be the opposite default.
  const currentSession = currentSessionToken
    ? await prisma.adminSession.findUnique({
        where: { tokenHash: hashToken(currentSessionToken) },
        select: { id: true, userId: true },
      })
    : null;

  const keepSessionId =
    currentSession && currentSession.userId === actor.id ? currentSession.id : null;

  const revoked = await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id: actor.id },
      data: { passwordHash, mustChangePassword: false },
    });

    const removed = await tx.adminSession.deleteMany({
      where: {
        userId: actor.id,
        ...(keepSessionId ? { NOT: { id: keepSessionId } } : {}),
      },
    });

    await securityAudit(
      SECURITY_ACTION.PASSWORD_CHANGED,
      actor,
      { id: actor.id, name: actor.name },
      {
        ip: meta.ip,
        userAgent: meta.userAgent,
        after: {
          sessionsRevoked: removed.count,
          // Recorded so the log shows whether the caller kept their own
          // session or was signed out with everyone else.
          keptCurrentSession: Boolean(keepSessionId),
        },
      },
      tx as unknown as AuditTx
    );

    return removed.count;
  });

  return { ok: true, message: `Password changed. ${revoked} other session(s) were signed out.` };
}

/**
 * An owner sets a new password for someone else.
 *
 * This is the recovery path when a staff member is locked out. It sets
 * mustChangePassword so the temporary password cannot become permanent, and
 * revokes every session. The new password is chosen by the owner; it is never
 * generated here and never returned for display.
 */
export async function resetUserPassword(
  actor: Actor,
  targetId: string,
  newPassword: string,
  meta: RequestMeta = {}
): Promise<OpResult> {
  const target = await prisma.adminUser.findUnique({ where: { id: targetId } });
  if (!target) return { ok: false, error: "Account not found." };

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return { ok: false, error: strengthError };

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id: targetId },
      data: {
        passwordHash,
        mustChangePassword: true,
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    const removed = await tx.adminSession.deleteMany({ where: { userId: targetId } });

    await securityAudit(
      SECURITY_ACTION.PASSWORD_RESET_BY_OWNER,
      actor,
      { id: targetId, name: target.name },
      {
        ip: meta.ip,
        userAgent: meta.userAgent,
        after: { sessionsRevoked: removed.count, mustChangePassword: true },
      },
      tx as unknown as AuditTx
    );
  });

  return {
    ok: true,
    message: `Password reset for ${target.name}. They must change it at next sign-in.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Creation (CLI path)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Create the primary owner.
 *
 * Used only by scripts/create-admin.mjs. There is deliberately no HTTP route
 * that reaches this — the first account must be created by someone with
 * database access, not by anyone who can reach a URL.
 */
export async function createPrimaryOwner(email: string, passwordHash: string, name: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.adminUser.findFirst({ where: { isPrimaryOwner: true } });
    if (existing) {
      throw new Error(
        "A primary owner already exists. Use the admin panel to manage accounts."
      );
    }

    const user = await tx.adminUser.create({
      data: {
        email: email.trim().toLowerCase(),
        name,
        passwordHash,
        role: "OWNER",
        isPrimaryOwner: true,
        isActive: true,
        emailVerifiedAt: new Date(),
      },
    });

    await securityAudit(
      SECURITY_ACTION.PRIMARY_OWNER_CREATED,
      { id: user.id, name: user.name },
      { id: user.id, name: user.name },
      { after: { email: user.email, role: user.role }, entityType: "AdminUser" },
      tx as unknown as AuditTx
    );

    return user;
  });
}

export type { AdminUser };
