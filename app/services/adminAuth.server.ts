/**
 * Authentication and session lifecycle for the owner panel.
 *
 * Two things changed when the panel went multi-user, and both are security
 * fixes rather than features:
 *
 *   1. Session tokens are no longer stored. `AdminSession` holds a SHA-256
 *      digest, so a copy of that table yields nothing replayable. The raw token
 *      exists in exactly two places: the cookie sent to the browser, and the
 *      argument to the function that hashed it.
 *
 *   2. Sessions are revoked by event, not only by logout. Disabling an account,
 *      changing its role, and changing its password all destroy that user's
 *      sessions, so a permission change takes effect on the next request rather
 *      than whenever the holder next signs out.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AdminUser } from "@prisma/client";
import { prisma } from "~/db.server";
import { hashPassword, verifyPassword } from "~/utils/auth.server";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** How long a sign-in lasts. Also the cookie Max-Age; the two must agree. */
export const SESSION_TTL_DAYS = 30;

/** Sliding window and threshold for the database-backed login throttle. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

/** How long an invitation remains redeemable. */
export const INVITATION_TTL_HOURS = 24;

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A 256-bit random token, hex encoded. Used for session cookies and invitation
 * links. `randomBytes` is the CSPRNG; `Math.random` must never appear here.
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The stored form of a token.
 *
 * SHA-256, not bcrypt, and that is a deliberate choice rather than a shortcut.
 * These tokens are 256 bits of CSPRNG output — there is no dictionary, no
 * pattern, and no user-chosen entropy to slow an attacker down, so a work
 * factor buys nothing. What it would cost is real: this runs on every
 * authenticated request, where a slow KDF is a denial-of-service vector against
 * our own server. Passwords are a different problem and still use bcrypt.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of two token digests.
 *
 * Digests are fixed-length hex, so `timingSafeEqual` is safe to call directly.
 * A plain `===` here would leak, through response timing, how many leading
 * characters of a guessed digest were correct.
 */
export function tokenDigestMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Email is compared and stored one way only, so casing cannot fork an account. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Login throttling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Keyed on the email *and* the source address. Keying on the email alone would
 * let anyone lock a known colleague out from anywhere; keying on the address
 * alone would let one attacker spray many accounts from one host. The pair
 * means a flood against one account from one place is what gets stopped.
 */
function throttleKey(email: string, ip: string | null): string {
  return `${normalizeEmail(email)}|${ip ?? "unknown"}`;
}

export async function isLoginThrottled(email: string, ip: string | null): Promise<boolean> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { key: throttleKey(email, ip), createdAt: { gte: since } },
  });
  return count >= LOGIN_MAX_ATTEMPTS;
}

/**
 * Record a failure against the throttle.
 *
 * Called whether or not the account exists, so the throttle cannot be used to
 * probe for valid addresses: the number of attempts that triggers it is the
 * same either way.
 */
export async function recordFailedLogin(email: string, ip: string | null): Promise<void> {
  await prisma.loginAttempt.create({ data: { key: throttleKey(email, ip) } });
}

export async function clearLoginAttempts(email: string, ip: string | null): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { key: throttleKey(email, ip) } });
}

/** Drop attempts that have aged out of the window. Safe to call from cron. */
export async function pruneLoginAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_MS);
  const { count } = await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Issue a session and return the RAW token.
 *
 * This return value is the only moment the token exists in a recoverable form.
 * It goes into the response cookie and nowhere else — not into a log, not into
 * the database, not into an audit record.
 */
export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.adminSession.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: meta.ip ?? null,
      // Truncated: this is for "which device was that" in an audit view, not a
      // fingerprint, and user-agent strings can be arbitrarily long.
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 255) : null,
    },
  });

  return token;
}

/**
 * Resolve a session cookie to a user, or null.
 *
 * Returns null — and cleans up — for an expired session and for a user who has
 * been disabled. The disabled check is what makes "a disabled user must
 * immediately lose access even if they possess a previously valid session"
 * true: the cookie stays well-formed and unexpired, and is refused here on
 * every request.
 */
export async function validateSession(token: string): Promise<AdminUser | null> {
  if (!token) return null;

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;

  if (session.expiresAt <= new Date()) {
    await prisma.adminSession.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (!session.user.isActive) {
    // Drop every session this user holds, not merely the one presented: a
    // disabled account has no legitimate session anywhere.
    await prisma.adminSession.deleteMany({ where: { userId: session.userId } });
    return null;
  }

  // Refresh the activity stamp. Deliberately fire-and-forget: a failure to
  // update a "last seen" column must not fail an otherwise valid request.
  prisma.adminSession
    .update({ where: { id: session.id }, data: { lastAccessAt: new Date() } })
    .catch(() => undefined);

  return session.user;
}

/** Revoke one session by its raw token. Used by logout. */
export async function revokeSessionByToken(token: string): Promise<void> {
  await prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/**
 * Revoke every session for a user.
 *
 * Called on password change, on disable, and on any change to a user's role.
 * `exceptSessionId` exists for one case only: rotating the caller's own session
 * after they change their own password, where they are meant to stay signed in.
 */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const { count } = await prisma.adminSession.deleteMany({
    where: { userId, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) },
  });
  return count;
}

/**
 * Authenticate an email and password.
 *
 * Returns null for every failure — unknown address, wrong password, disabled
 * account — so the caller cannot accidentally report which it was.
 *
 * The bcrypt comparison is skipped when the account is unknown or has no
 * password set, which is a timing difference. That is deliberate and is why
 * the caller must keep the error message generic; the alternative, hashing
 * against a dummy value to equalise timing, costs a bcrypt round on every
 * probe and defends against an attacker who has already learned the address is
 * valid through some other means.
 */
export async function authenticate(
  email: string,
  password: string
): Promise<AdminUser | null> {
  const user = await prisma.adminUser.findUnique({
    where: { email: normalizeEmail(email) },
  });

  if (!user || !user.isActive || !user.passwordHash) return null;

  if (user.lockedUntil && user.lockedUntil > new Date()) return null;

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;

  return user;
}

/** Record a successful sign-in and clear the per-account failure tally. */
export async function markLoginSuccess(userId: string): Promise<void> {
  await prisma.adminUser.update({
    where: { id: userId },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });
}

/** Increment the durable per-account failure counter shown in the user list. */
export async function markLoginFailure(userId: string): Promise<void> {
  await prisma.adminUser
    .update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } })
    .catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Hash a password for storage.
 *
 * Delegates to the project's existing bcrypt helper rather than introducing a
 * second scheme. That helper is the one place the cost factor is set, so staff
 * passwords across invitation acceptance, self-service change and owner-issued
 * recovery are all hashed to the same standard.
 */
export async function hashUserPassword(password: string): Promise<string> {
  return hashPassword(password);
}

/**
 * Password strength lives in app/utils/passwordPolicy.ts and the role list in
 * app/utils/adminRoles.ts. Both are imported by components as well as by
 * services, so neither can live in a `.server` module. They are re-exported
 * here for callers that already reach for this module.
 */
export { MIN_PASSWORD_LENGTH, validatePasswordStrength } from "~/utils/passwordPolicy";
export { ADMIN_ROLES, isAdminRole } from "~/utils/adminRoles";
