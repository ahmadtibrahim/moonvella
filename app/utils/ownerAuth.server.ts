import { redirect } from "react-router";
import { prisma } from "~/db.server";
import { validateOwnerSession } from "~/services/ownerAuth.server";

export async function requireOwnerAuth(request: Request) {
  const cookieHeader = request.headers.get("Cookie");
  const cookies = parseCookies(cookieHeader || "");
  const sessionToken = cookies["owner_session"];

  if (!sessionToken) {
    throw redirect("/admin/login");
  }

  const user = await validateOwnerSession(sessionToken);
  if (!user) {
    throw redirect("/admin/login");
  }

  return user;
}

export async function getOwnerUser(request: Request) {
  const cookieHeader = request.headers.get("Cookie");
  const cookies = parseCookies(cookieHeader || "");
  const sessionToken = cookies["owner_session"];

  if (!sessionToken) {
    return null;
  }

  return validateOwnerSession(sessionToken);
}

export async function requireOwnerRole(
  request: Request,
  allowedRoles: ("OWNER" | "OPERATIONS" | "REVIEWER" | "READONLY")[]
) {
  const user = await requireOwnerAuth(request);

  if (!allowedRoles.includes(user.role)) {
    throw redirect("/admin");
  }

  return user;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    if (name && rest.length > 0) {
      cookies[name] = rest.join("=");
    }
  });
  return cookies;
}