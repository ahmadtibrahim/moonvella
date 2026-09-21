import { prisma } from "~/db.server";
import { generateSessionToken, hashPassword, verifyPassword } from "~/utils/auth.server";

// Login throttling, backed by the database so a container restart cannot be
// used to reset the counter. Nginx applies a second, coarser limit at the edge
// (see the app/admin vhosts), so a flood is absorbed before it reaches here.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

export async function isLoginThrottled(key: string): Promise<boolean> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const count = await prisma.loginAttempt.count({
    where: { key, createdAt: { gte: since } },
  });
  return count >= LOGIN_MAX_ATTEMPTS;
}

export async function recordFailedLogin(key: string): Promise<void> {
  await prisma.loginAttempt.create({ data: { key } });
}

export async function clearLoginAttempts(key: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { key } });
}

/** Drop attempts that have fallen out of the window. Safe to call from cron. */
export async function pruneLoginAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - LOGIN_WINDOW_MS);
  const { count } = await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

export async function createOwnerSession(userId: string, expiresInDays = 30) {
  const token = generateSessionToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  await prisma.ownerSession.create({
    data: {
      userId,
      token,
      expiresAt,
    },
  });

  return token;
}

export async function validateOwnerSession(token: string) {
  const session = await prisma.ownerSession.findUnique({
    where: { token },
    include: {
      user: true,
    },
  });

  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.ownerSession.delete({ where: { id: session.id } });
    return null;
  }

  // Deactivating an owner account must invalidate its sessions immediately.
  if (!session.user.isActive) {
    await prisma.ownerSession.deleteMany({ where: { userId: session.userId } });
    return null;
  }

  // Update last access time
  await prisma.ownerSession.update({
    where: { id: session.id },
    data: { lastAccessAt: new Date() },
  });

  return session.user;
}

export async function deleteOwnerSession(token: string) {
  await prisma.ownerSession.deleteMany({
    where: { token },
  });
}

export async function deleteAllOwnerSessions(userId: string) {
  await prisma.ownerSession.deleteMany({
    where: { userId },
  });
}

export async function createOwnerUser(email: string, password: string, name: string, role: "OWNER" | "OPERATIONS" | "REVIEWER" | "READONLY" = "OWNER") {
  const passwordHash = await hashPassword(password);

  return prisma.ownerUser.create({
    data: {
      email,
      passwordHash,
      name,
      role,
    },
  });
}

export async function authenticateOwner(email: string, password: string) {
  const user = await prisma.ownerUser.findUnique({
    where: { email },
  });

  if (!user || !user.isActive) {
    return null;
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    return null;
  }

  // Update last login
  await prisma.ownerUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return user;
}