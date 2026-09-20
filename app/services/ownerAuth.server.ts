import { prisma } from "~/db.server";
import { generateSessionToken, hashPassword, verifyPassword } from "~/utils/auth.server";

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