import {
  redirect,
  type ActionFunctionArgs,
} from "react-router";
import { prisma } from "~/db.server";
import { getSessionToken, buildSessionCookie } from "~/utils/ownerAuth.server";

export async function action({ request }: ActionFunctionArgs) {
  const token = getSessionToken(request);
  if (token) {
    await prisma.ownerSession.deleteMany({ where: { token } });
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
