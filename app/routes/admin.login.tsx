import { ActionFunctionArgs, LoaderFunctionArgs, redirect } from "react-router";
import { prisma } from "~/db.server";
import { authenticateOwner, createOwnerSession } from "~/services/ownerAuth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const cookieHeader = request.headers.get("Cookie");
  const cookies = parseCookies(cookieHeader || "");
  const sessionToken = cookies["owner_session"];

  if (sessionToken) {
    const { validateOwnerSession } = await import("~/services/ownerAuth.server");
    const user = await validateOwnerSession(sessionToken);
    if (user) {
      throw redirect("/admin");
    }
  }

  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required" };
  }

  const { authenticateOwner, createOwnerSession } = await import("~/services/ownerAuth.server");

  const user = await authenticateOwner(email, password);
  if (!user) {
    return { error: "Invalid email or password" };
  }

  const token = await createOwnerSession(user.id);

  const headers = new Headers();
  headers.append("Set-Cookie", `owner_session=${await createOwnerSession(user.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  headers.append("Location", "/admin");

  return redirect("/admin", { headers });
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

export default function AdminLogin() {
  return (
    <div className="login-page">
      <Form method="post" noValidate>
        {error && (
          <div className="form-error">{error}</div>
        )}
        <div className="form-group">
          <label className="form-label" htmlFor="email">Email</label>
          <input
            className="form-input"
            type="email"
            id="email"
            name="email"
            autoComplete="email"
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="password">Password</label>
          <input
            className="form-input"
            type="password"
            id="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button className="btn-primary" type="submit">
          Sign In
        </button>
      </Form>
    </div>
  );
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

export const Form = ({ method, children, noValidate }: { method: string; children: React.ReactNode; noValidate?: boolean }) => {
  return <form method={method} noValidate={noValidate}>{children}</form>;
};