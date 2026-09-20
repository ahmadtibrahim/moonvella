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
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${OWNER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
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

/**
 * Enforce role restrictions on protected loaders and actions. An owner whose
 * role is not permitted receives a real 403 rather than a silent redirect.
 */
export async function requireOwnerRole(
  request: Request,
  allowedRoles: OwnerRole[]
) {
  const user = await requireOwnerAuth(request);
  if (!allowedRoles.includes(user.role as OwnerRole)) {
    throw new Response("Your owner role is not permitted to perform this action.", {
      status: 403,
    });
  }
  return user;
}

/**
 * CSRF protection for state-changing owner requests: the Origin (or Referer)
 * host must match the request host. Browsers always send Origin on cross-site
 * POSTs, and send it on same-origin POSTs too.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const host = request.headers.get("Host");
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const candidate = origin || referer;

  if (!candidate || !host) {
    throw new Response("Missing request origin.", { status: 403 });
  }

  let candidateHost: string;
  try {
    candidateHost = new URL(candidate).host;
  } catch {
    throw new Response("Invalid request origin.", { status: 403 });
  }

  if (candidateHost !== host) {
    throw new Response("Cross-origin request rejected.", { status: 403 });
  }
}

export function getRequestMeta(request: Request) {
  const forwarded = request.headers.get("X-Forwarded-For");
  const ip =
    (forwarded ? forwarded.split(",")[0].trim() : null) ||
    request.headers.get("X-Real-IP") ||
    null;
  const userAgent = request.headers.get("User-Agent") || null;
  return { ip, userAgent };
}
