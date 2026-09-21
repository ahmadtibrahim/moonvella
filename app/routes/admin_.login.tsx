import "../styles/admin.css";
import {
  Form,
  redirect,
  useActionData,
  useNavigation,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { getOwnerUser, buildSessionCookie, assertSameOrigin, getRequestMeta } from "~/utils/ownerAuth.server";
import {
  authenticateOwner,
  createOwnerSession,
  isLoginThrottled,
  recordFailedLogin,
  clearLoginAttempts,
} from "~/services/ownerAuth.server";
import { recordAudit, AUDIT_ENTITY } from "~/services/audit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getOwnerUser(request);
  if (user) {
    throw redirect("/admin");
  }
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);

  const formData = await request.formData();
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const { ip, userAgent } = getRequestMeta(request);

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const throttleKey = `${email}|${ip ?? "unknown"}`;
  if (await isLoginThrottled(throttleKey)) {
    return {
      error: "Too many failed sign-in attempts. Please wait a few minutes and try again.",
    };
  }

  const user = await authenticateOwner(email, password);
  if (!user) {
    await recordFailedLogin(throttleKey);
    await recordAudit({
      actorType: "SYSTEM",
      actorId: email,
      actorName: email,
      action: "owner.login_failed",
      entityType: AUDIT_ENTITY.OWNER_USER,
      entityId: email,
      ipAddress: ip,
      userAgent,
    });
    return { error: "Invalid email or password." };
  }

  await clearLoginAttempts(throttleKey);
  const token = await createOwnerSession(user.id);

  await recordAudit({
    actorType: "OWNER_USER",
    actorId: user.id,
    actorName: user.name,
    action: "owner.login",
    entityType: AUDIT_ENTITY.OWNER_USER,
    entityId: user.id,
    ipAddress: ip,
    userAgent,
  });

  return redirect("/admin", {
    headers: {
      "Set-Cookie": buildSessionCookie(token),
    },
  });
}

export default function AdminLogin() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const isSubmitting = navigation.state === "submitting";
  const notice =
    searchParams.get("notice") === "password-changed"
      ? "Password changed. All sessions were signed out — please sign in again."
      : null;

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <div className="admin-login-header">
          <div className="admin-login-logo">MoonVella</div>
          <h1 className="admin-login-title">Admin Login</h1>
          <p className="admin-login-subtitle">MoonVella Administration Panel</p>
        </div>

        <Form method="post" noValidate>
          {actionData?.error ? (
            <div className="admin-login-error">{actionData.error}</div>
          ) : null}

          {!actionData?.error && notice ? (
            <div
              className="admin-login-notice"
              role="status"
              style={{
                background: "#eef7f0",
                border: "1px solid #bfe3c8",
                color: "#1c5c31",
                borderRadius: 8,
                padding: "0.75rem 0.9rem",
                marginBottom: "1rem",
                fontSize: "0.875rem",
              }}
            >
              {notice}
            </div>
          ) : null}

          <div className="admin-login-group">
            <label className="admin-login-label" htmlFor="email">
              Email
            </label>
            <input
              className="admin-login-input"
              type="email"
              id="email"
              name="email"
              autoComplete="email"
              required
            />
          </div>

          <div className="admin-login-group">
            <label className="admin-login-label" htmlFor="password">
              Password
            </label>
            <input
              className="admin-login-input"
              type="password"
              id="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </div>

          <button
            className="admin-login-button"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Signing in..." : "Sign In"}
          </button>
        </Form>

        <p className="admin-login-footer">
          MoonVella Administration Panel &bull; Private Access Only
        </p>
      </div>
    </div>
  );
}
