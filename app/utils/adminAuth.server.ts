/**
 * Request-level authentication and authorisation for the owner panel.
 *
 * Routes import `requirePermission` from here and name the capability they
 * need. They never inspect `user.role` themselves — see permissions.server.ts
 * for why that matters.
 */

import { redirect } from "react-router";
import type { AdminUser } from "@prisma/client";
import { can, type Permission } from "~/services/permissions";
import { validateSession } from "~/services/adminAuth.server";
// Defined in a client-safe module and re-used here, because the login page
// needs the same function during render. See safeRedirect.ts.
import { safeRedirectPath } from "./safeRedirect";

export { safeRedirectPath };

export const ADMIN_SESSION_COOKIE = "admin_session";
export const ADMIN_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

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
  return parseCookies(cookieHeader)[ADMIN_SESSION_COOKIE];
}

/**
 * Build the session cookie.
 *
 * HttpOnly  — unreadable from JavaScript, so an XSS cannot exfiltrate it.
 * SameSite=Lax — sent on top-level navigations, withheld from cross-site
 *   subrequests, which is what blocks CSRF on state-changing POSTs without
 *   breaking a bookmark or a typed URL.
 * No Domain  — a host-only cookie, so it is offered to admin.moonvella.com and
 *   never to app.moonvella.com. The two surfaces share a process; this is what
 *   keeps the owner session off the merchant host.
 * Secure     — set in production so it never travels over plain HTTP.
 */
export function buildSessionCookie(token: string, maxAge = ADMIN_SESSION_MAX_AGE) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** The cleared cookie. Same attributes, so it is unset on the right host. */
export function clearSessionCookie() {
  return buildSessionCookie("", 0);
}

/** Resolve the current user, or null. Never throws. */
export async function getCurrentUser(request: Request): Promise<AdminUser | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  return validateSession(token);
}

/**
 * Require a signed-in, active user. Redirects to the sign-in page otherwise.
 *
 * `next` carries the originally requested path so the user lands where they
 * were going. It is validated before use — see safeRedirectPath — because an
 * unvalidated redirect target is an open redirect.
 */
export async function requireAuth(request: Request): Promise<AdminUser> {
  const user = await getCurrentUser(request);
  if (!user) {
    const url = new URL(request.url);
    const next = safeRedirectPath(url.pathname + url.search);
    throw redirect(`/admin/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  }
  return user;
}

/**
 * Require a specific permission.
 *
 * This is the guard every protected route should use. It answers a 403 rather
 * than redirecting: a signed-in user who lacks a permission has not lost their
 * session, and bouncing them to the sign-in page would be both confusing and a
 * way to mask an authorisation bug as an authentication one.
 */
export async function requirePermission(
  request: Request,
  permission: Permission
): Promise<AdminUser> {
  const user = await requireAuth(request);

  if (!can(user.role, permission)) {
    throw new Response(
      "Your role does not permit this. If you believe this is wrong, ask an owner to review your access.",
      { status: 403 }
    );
  }

  // A password reset issued by an owner forces a change before anything else.
  // Checked here, after authorisation, so an expired-password user still gets
  // an honest 403 rather than a redirect that reveals the route exists.
  if (user.mustChangePassword) {
    const path = new URL(request.url).pathname;
    if (path !== "/admin/settings" && path !== "/admin/logout") {
      throw redirect("/admin/settings?notice=password-change-required");
    }
  }

  return user;
}

/**
 * Non-throwing permission test, for rendering. A loader that wants to show a
 * control conditionally uses this and still gates the action that the control
 * triggers.
 */
export function userCan(user: Pick<AdminUser, "role">, permission: Permission): boolean {
  return can(user.role, permission);
}

/**
 * CSRF protection for state-changing requests.
 *
 * The Origin (or Referer) host must equal the request host. Browsers always
 * send Origin on cross-site POSTs, so a forged submission from another site is
 * rejected here even if it somehow carried a valid cookie. SameSite=Lax on the
 * cookie is the first line; this is the second.
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

/**
 * Source address and user agent, for the audit trail. Never a credential.
 *
 * The order here is a security decision, not a preference.
 *
 * `X-Forwarded-For` is a list the client can prepend to: nginx *appends* the
 * real peer address to whatever the client sent, so `XFF[0]` is attacker-chosen
 * text and taking it would let anyone write a false source address into the
 * audit log — precisely the record a reviewer consults after an incident.
 *
 * `X-Real-IP` is set by this host's nginx with `proxy_set_header`, which
 * overwrites any client-supplied value, so it is the authoritative one. The
 * fallback takes the *last* entry of XFF for the same reason: that is the one
 * nginx added. The value is only ever used for display and review; nothing is
 * authorised on the basis of it.
 */
export function getRequestMeta(request: Request) {
  const forwarded = request.headers.get("X-Forwarded-For");
  const lastForwarded = forwarded
    ? forwarded.split(",").map((v) => v.trim()).filter(Boolean).pop()
    : null;

  const ip = request.headers.get("X-Real-IP") || lastForwarded || null;
  const userAgent = request.headers.get("User-Agent") || null;
  return { ip, userAgent };
}
