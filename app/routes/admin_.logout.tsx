import { redirect, type ActionFunctionArgs } from "react-router";
import {
  assertSameOrigin,
  clearSessionCookie,
  getRequestMeta,
  getSessionToken,
  getCurrentUser,
} from "~/utils/adminAuth.server";
import { revokeSessionByToken } from "~/services/adminAuth.server";
import { recordAudit, SECURITY_ACTION, AUDIT_ENTITY } from "~/services/audit.server";

/**
 * Sign out.
 *
 * POST only, with the same origin guard the other mutating routes use. An
 * unguarded GET sign-out is a real, if minor, nuisance: any page on the
 * internet can embed a link or an image pointing at it, and the owner finds
 * themselves signed out with no explanation.
 *
 * No permission guard: signing out is never something a role should be able to
 * lose. It also has to work for a session that is already invalid — which is
 * precisely the state someone is in when they most want to clear the cookie.
 */
export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);

  const token = getSessionToken(request);
  // Resolve the user before the session row is removed, so the audit entry can
  // name who signed out. The token itself is never recorded.
  const user = await getCurrentUser(request);
  const { ip, userAgent } = getRequestMeta(request);

  if (token) {
    await revokeSessionByToken(token);
  }

  if (user) {
    await recordAudit({
      actorType: "ADMIN_USER",
      actorId: user.id,
      actorName: user.name,
      action: SECURITY_ACTION.LOGOUT,
      entityType: AUDIT_ENTITY.ADMIN_USER,
      entityId: user.id,
      ipAddress: ip,
      userAgent,
    });
  }

  return redirect("/admin/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

export async function loader() {
  return redirect("/admin/login");
}

export default function AdminLogout() {
  return null;
}
