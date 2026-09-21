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
import {
  buildSessionCookie,
  assertSameOrigin,
  getRequestMeta,
  getSessionToken,
  getCurrentUser,
} from "~/utils/adminAuth.server";
// Client-safe: the component re-validates `next` during render.
import { safeRedirectPath } from "~/utils/safeRedirect";
import {
  authenticate,
  clearLoginAttempts,
  createSession,
  isLoginThrottled,
  markLoginFailure,
  markLoginSuccess,
  recordFailedLogin,
  revokeSessionByToken,
} from "~/services/adminAuth.server";
import { recordAudit, SECURITY_ACTION, AUDIT_ENTITY } from "~/services/audit.server";

/**
 * One message for every failure.
 *
 * Wrong password, no such account, disabled account and throttled account all
 * produce the same sentence. That is not politeness — a distinct message for
 * "no such user" turns this form into an account-enumeration oracle, and the
 * only thing the person in front of it legitimately needs to know is that the
 * credentials did not work.
 */
const GENERIC_FAILURE = "Invalid email or password.";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getCurrentUser(request);
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
  const nextParam = safeRedirectPath(String(formData.get("next") || ""));
  const { ip, userAgent } = getRequestMeta(request);

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // Throttle before touching the password, so a flood costs one indexed count
  // rather than a bcrypt comparison per request.
  if (await isLoginThrottled(email, ip)) {
    await recordAudit({
      actorType: "SYSTEM",
      actorId: email,
      actorName: null,
      action: SECURITY_ACTION.LOGIN_THROTTLED,
      entityType: AUDIT_ENTITY.ADMIN_USER,
      entityId: email,
      ipAddress: ip,
      userAgent,
    });
    return { error: GENERIC_FAILURE };
  }

  const user = await authenticate(email, password);

  if (!user) {
    // Recorded whether or not the account exists, so the throttle behaves
    // identically for real and imaginary addresses and cannot be used to probe.
    await recordFailedLogin(email, ip);
    await markLoginFailure(email);

    await recordAudit({
      actorType: "SYSTEM",
      actorId: email,
      actorName: null,
      action: SECURITY_ACTION.LOGIN_FAILED,
      entityType: AUDIT_ENTITY.ADMIN_USER,
      entityId: email,
      ipAddress: ip,
      userAgent,
    });

    return { error: GENERIC_FAILURE };
  }

  await clearLoginAttempts(email, ip);
  await markLoginSuccess(user.id);

  /**
   * Rotate. Whatever session cookie arrived is discarded and a new token is
   * minted, so a session identifier that was valid before authentication does
   * not remain valid after it. That is the whole of session-fixation defence
   * and it costs one delete.
   */
  const presented = getSessionToken(request);
  if (presented) {
    await revokeSessionByToken(presented);
  }

  const token = await createSession(user.id, { ip, userAgent });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: user.id,
    actorName: user.name,
    action: SECURITY_ACTION.LOGIN,
    entityType: AUDIT_ENTITY.ADMIN_USER,
    entityId: user.id,
    ipAddress: ip,
    userAgent,
  });

  // A password reset issued by an owner takes precedence over wherever the user
  // was heading.
  const destination = user.mustChangePassword
    ? "/admin/settings?notice=password-change-required"
    : nextParam || "/admin";

  return redirect(destination, {
    headers: { "Set-Cookie": buildSessionCookie(token) },
  });
}

export default function AdminLogin() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const isSubmitting = navigation.state === "submitting";

  const notice =
    searchParams.get("notice") === "password-changed"
      ? "Password changed. Other sessions were signed out — please sign in again."
      : searchParams.get("notice") === "invitation-accepted"
        ? "Your account is ready. Sign in with the password you just chose."
        : null;

  const next = safeRedirectPath(searchParams.get("next"));

  return (
    <div className="admin-login-page">
      <div className="admin-login-card">
        <div className="admin-login-header">
          <div className="admin-login-logo">MoonVella</div>
          <h1 className="admin-login-title">Admin Login</h1>
          <p className="admin-login-subtitle">MoonVella Administration Panel</p>
        </div>

        <Form method="post" noValidate>
          {/* Carried through the form rather than left in the query string, so
              the destination cannot be swapped by editing the URL a submitted
              form points at. Re-validated server-side on the way back. */}
          {next ? <input type="hidden" name="next" value={next} /> : null}

          {actionData?.error ? (
            <div className="admin-login-error" role="alert">
              {actionData.error}
            </div>
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
              autoFocus
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
        <p className="admin-login-footer" style={{ marginTop: "0.5rem" }}>
          Accounts are created by invitation. There is no self-registration.
        </p>
      </div>
    </div>
  );
}
