import { redirect } from "react-router";
import { prisma } from "~/db.server";

export async function action({ request }: { request: Request }) {
  const cookieHeader = request.headers.get("Cookie");
  const cookies = parseCookies(cookieHeader || "");
  const sessionToken = cookies["owner_session"];

  if (sessionToken) {
    await prisma.ownerSession.deleteMany({
      where: { token: sessionToken },
    });
  }

  const headers = new Headers();
  headers.append("Set-Cookie", `owner_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  headers.append("Location", "/admin/login");

  return redirect("/admin/login", { headers });
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

export default function AdminLogout() {
  return null;
}