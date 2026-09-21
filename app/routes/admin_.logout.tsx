import {
  redirect,
  type ActionFunctionArgs,
} from "react-router";
import { prisma } from "~/db.server";
import {
  getSessionToken,
  buildSessionCookie,
  getOwnerUser,
  getRequestMeta,
} from "~/utils/ownerAuth.server";
import { recordAudit, AUDIT_ENTITY } from "~/services/audit.server";

export async function action({ request }: ActionFunctionArgs) {
  const token = getSessionToken(request);
  // Resolve the user before the session row is removed, so the audit record can
  // name who signed out. Never records the session token itself.
  const user = await getOwnerUser(request);
  const { ip, userAgent } = getRequestMeta(request);

  if (token) {
    await prisma.ownerSession.deleteMany({ where: { token } });
  }

  if (user) {
    await recordAudit({
      actorType: "OWNER_USER",
      actorId: user.id,
      actorName: user.name,
      action: "owner.logout",
      entityType: AUDIT_ENTITY.OWNER_USER,
      entityId: user.id,
      ipAddress: ip,
      userAgent,
    });
  }

  return redirect("/admin/login", {
    headers: { "Set-Cookie": buildSessionCookie("", 0) },
  });
}

export async function loader() {
  return redirect("/admin/login");
}

export default function AdminLogout() {
  return null;
}
