import "../styles/admin.css";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { MIN_PASSWORD_LENGTH } from "~/utils/passwordPolicy";
import { lookupInvitation, redeemInvitation } from "~/services/invitations.server";
import type { AdminRole } from "@prisma/client";

/**
 * Invitation acceptance. The only unauthenticated page that creates anything.
 *
 * The token travels in the query string, and that is the single unavoidable
 * exception to "no credentials in URLs" — there is no other way to hand someone
 * a link. Two things follow from it:
 *
 *   - the nginx access log for this exact path is configured to record the path
 *     without the query string, so the token never lands in a log file
 *   - the page is served no-store, and redeemed tokens are single-use, so a
 *     token recovered from browser history or a proxy cache is worthless after
 *     first use
 *
 * The POST submits to the bare path with the token in the body, so the token
 * appears in exactly one logged-by-nothing request rather than two.
 */

const ROLE_LABEL: Record<AdminRole, string> = {
  OWNER: "Owner",
  ADMIN: "Administrator",
  OPERATIONS: "Operations",
  CATALOG: "Catalog",
  SUPPORT: "Support",
  VIEWER: "Viewer",
};

/**
 * One message for every failure.
 *
 * Not-found, expired, cancelled, already-used and lost-the-race all render the
 * same sentence. Telling them apart would turn this page into an oracle for
 * "which addresses have been invited" and "has this person signed up yet",
 * which is exactly what the owner does not want published.
 */
const GENERIC_INVALID =
  "This invitation link is not valid or has expired. Ask an owner to send you a new one.";

export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const lookup = await lookupInvitation(token);

  return {
    valid: lookup.state === "valid",
    // Rendered into the form so the browser can post it back in the request
    // body. It is the same token that is already in this page's URL, so putting
    // it in the HTML discloses nothing new — and unlike reading window.location
    // it works with JavaScript disabled.
    token: lookup.state === "valid" ? token : null,
    // Shown only to someone already holding a valid token, so it discloses
    // nothing they could not learn by using it.
    name: lookup.state === "valid" ? lookup.invitation.name : null,
    email: lookup.state === "valid" ? lookup.invitation.email : null,
    role: lookup.state === "valid" ? lookup.invitation.role : null,
    expiresAt: lookup.state === "valid" ? lookup.invitation.expiresAt : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);

  const form = await request.formData();
  const token = String(form.get("token") || "");
  const password = String(form.get("password") || "");
  const confirm = String(form.get("confirmPassword") || "");
  const { ip, userAgent } = getRequestMeta(request);

  if (!token) return { error: GENERIC_INVALID };
  if (password !== confirm) return { error: "The two passwords do not match." };

  const result = await redeemInvitation(token, password, { ip, userAgent });
  if (!result.ok) {
    // Password-strength messages are about the password the person just typed,
    // so they are safe and useful to return verbatim. Everything else collapses
    // to the generic message.
    const isPasswordAdvice = result.error.includes("password") || result.error.includes("Password");
    return { error: isPasswordAdvice ? result.error : GENERIC_INVALID };
  }

  // No session is issued here. The new account signs in through the ordinary
  // login form, which is the only place a session is ever created.
  return redirect("/admin/login?notice=invitation-accepted");
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.75rem",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  color: "#64748b",
  marginBottom: "0.25rem",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

export default function AcceptInvite() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f6f8fb",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem 1rem",
      }}
    >
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "1.35rem", fontWeight: 700, color: "#082a4a" }}>MoonVella</div>
          <div style={{ fontSize: "0.8rem", color: "#64748b" }}>Administration Panel</div>
        </div>

        <div style={card}>
          {!data.valid ? (
            <>
              <h1 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.5rem" }}>
                Invitation link not usable
              </h1>
              <p style={{ fontSize: "0.85rem", color: "#475569", margin: 0 }}>{GENERIC_INVALID}</p>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: "1.1rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.35rem" }}>
                Set your password
              </h1>
              <p style={{ fontSize: "0.85rem", color: "#64748b", marginTop: 0, marginBottom: "1.25rem" }}>
                Welcome, {data.name}. Your account{" "}
                <strong>{data.email}</strong> is being created with the{" "}
                <strong>{data.role ? ROLE_LABEL[data.role] : ""}</strong> role.
                {data.expiresAt ? (
                  <>
                    {" "}
                    This link expires{" "}
                    {new Date(data.expiresAt).toLocaleString()}.
                  </>
                ) : null}
              </p>

              {actionData?.error ? (
                <div
                  role="alert"
                  style={{
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    color: "#991b1b",
                    borderRadius: 8,
                    padding: "0.7rem 0.9rem",
                    marginBottom: "1rem",
                    fontSize: "0.82rem",
                  }}
                >
                  {actionData.error}
                </div>
              ) : null}

              {/* Posts to the bare path: the token goes in the body, not the
                  URL, so it is not repeated in a second request line. */}
              <Form method="post" action="/admin/accept-invite" noValidate>
                <input type="hidden" name="token" value={data.token || ""} />

                <div style={{ marginBottom: "0.9rem" }}>
                  <label style={label} htmlFor="password">Choose a password</label>
                  <input
                    style={input}
                    type="password"
                    id="password"
                    name="password"
                    autoComplete="new-password"
                    autoFocus
                    required
                  />
                </div>
                <div style={{ marginBottom: "0.5rem" }}>
                  <label style={label} htmlFor="confirmPassword">Confirm password</label>
                  <input
                    style={input}
                    type="password"
                    id="confirmPassword"
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                  />
                </div>
                <p style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "0.5rem" }}>
                  At least {MIN_PASSWORD_LENGTH} characters, including a letter
                  and a number. Nobody else — including the owner who invited you
                  — will be able to see it.
                </p>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    marginTop: "1rem",
                    width: "100%",
                    padding: "0.7rem 1.5rem",
                    background: "#082a4a",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    fontSize: "0.9rem",
                    fontWeight: 600,
                    cursor: isSubmitting ? "not-allowed" : "pointer",
                    opacity: isSubmitting ? 0.6 : 1,
                  }}
                >
                  {isSubmitting ? "Creating your account..." : "Create my account"}
                </button>
              </Form>
            </>
          )}
        </div>

        <p style={{ textAlign: "center", fontSize: "0.75rem", color: "#94a3b8", marginTop: "1.25rem" }}>
          Already have an account?{" "}
          <Link to="/admin/login" style={{ color: "#082a4a", fontWeight: 500 }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
