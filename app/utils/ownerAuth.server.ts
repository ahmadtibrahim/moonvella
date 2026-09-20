import { redirect } from "react-router";
import { validateOwnerSession } from "~/services/ownerAuth.server";

export const OWNER_SESSION_COOKIE = "owner_session";
export const OWNER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export type OwnerRole = "OWNER" | "OPERATIONS" | "REVIEWER" | "READONLY";

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    if (name && rest.length > 0) {
      cookies[name] = rest.join("=");
    }
  });
  return cookies;
}

export function getSessionToken(request: Request): string | undefined {
  const cookieHeader = request.headers.get("Cookie") || "";
  return parseCookies(cookieHeader)[OWNER_SESSION_COOKIE];
}

export function buildSessionCookie(token: string, maxAge = OWNER_SESSION_MAX_AGE) {
  return `${OWNER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function requireOwnerAuth(request: Request) {
  const token = getSessionToken(request);
  if (!token) {
    throw redirect("/admin/login");
  }

  const user = await validateOwnerSession(token);
  if (!user) {
    throw redirect("/admin/login");
  }

  return user;
}

export async function getOwnerUser(request: Request) {
  const token = getSessionToken(request);
  if (!token) return null;
  return validateOwnerSession(token);
}

export async function requireOwnerRole(
  request: Request,
  allowedRoles: OwnerRole[]
) {
  const user = await requireOwnerAuth(request);
  if (!allowedRoles.includes(user.role as OwnerRole)) {
    throw redirect("/admin");
  }
  return user;
}
