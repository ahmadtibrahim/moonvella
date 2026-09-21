import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { can } from "~/services/permissions";
import {
  getUserDetail,
  setUserRole,
  setUserActive,
  revokeUserSessions,
  resetUserPassword,
} from "~/services/adminUsers.server";
import { invitationsForUser } from "~/services/invitations.server";
import { ADMIN_ROLES, ROLE_LABEL, isAdminRole } from "~/utils/adminRoles";
import type { AdminRole } from "@prisma/client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const viewer = await requirePermission(request, "users.view");
  const userId = String(params.id || "");

  const user = await getUserDetail(userId);
  if (!user) {
    throw new Response("Account not found.", { status: 404 });
  }

  const invitations = await invitationsForUser(userId);

  return {
    user,
    invitations,
    viewerId: viewer.id,
    canManage: can(viewer.role, "users.manage"),
    canAssignRoles: can(viewer.role, "roles.assign"),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const actor = await requirePermission(request, "users.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const meta = { ip, userAgent };
  const who = { id: actor.id, name: actor.name };
  const targetId = String(params.id || "");

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    switch (intent) {
      case "set_role": {
        if (!can(actor.role, "roles.assign")) {
          throw new Error("Your role does not permit assigning roles.");
        }
        const role = String(form.get("role") || "");
        if (!isAdminRole(role)) throw new Error("Choose a valid role.");

        const result = await setUserRole(who, targetId, role as AdminRole, meta);
        if (!result.ok) return { error: result.error };
        return { success: result.message };
      }

      case "set_active": {
        const result = await setUserActive(
          who,
          targetId,
          String(form.get("isActive")) === "true",
          meta
        );
        if (!result.ok) return { error: result.error };
        return { success: result.message };
      }

      case "revoke_sessions": {
        const result = await revokeUserSessions(who, targetId, meta);
        if (!result.ok) return { error: result.error };
        return { success: result.message };
      }

      case "reset_password": {
        const newPassword = String(form.get("newPassword") || "");
        const confirm = String(form.get("confirmPassword") || "");
        if (newPassword !== confirm) throw new Error("The two passwords do not match.");

        const result = await resetUserPassword(who, targetId, newPassword, meta);
        if (!result.ok) return { error: result.error };
        return { success: result.message };
      }

      default:
        throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "2rem",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "0.72rem",
  color: "#64748b",
  marginBottom: "0.25rem",
};

const button: React.CSSProperties = {
  padding: "0.5rem 1rem",
  background: "#082a4a",
  color: "white",
  border: "none",
  borderRadius: 6,
  fontSize: "0.8rem",
  fontWeight: 600,
  cursor: "pointer",
};

const row: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "150px 1fr",
  gap: "0.75rem",
  padding: "0.5rem 0",
  borderBottom: "1px solid #f1f5f9",
  fontSize: "0.8rem",
};

function fmt(value: Date | string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function AdminUserDetail() {
  const { user, invitations, viewerId, canManage, canAssignRoles } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const isSelf = user.id === viewerId;
  // The primary owner's role and status controls are disabled here as well as in
  // the service. The service is the control; this is so the button does not
  // invite a click that can only end in an error message.
  const roleLocked = user.isPrimaryOwner;
  const statusLocked = user.isPrimaryOwner || (isSelf && user.isActive);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.75rem" }}>
        <Link to="/admin/users" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; All users
        </Link>
      </p>

      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        {user.name}
        {user.isPrimaryOwner ? (
          <span style={{ marginLeft: "0.6rem", fontSize: "0.7rem", fontWeight: 700, color: "#7c3aed", border: "1px solid #ddd6fe", background: "#f5f3ff", borderRadius: 4, padding: "0.1rem 0.4rem", verticalAlign: "middle" }}>
            PRIMARY OWNER
          </span>
        ) : null}
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        {user.email} &bull; {ROLE_LABEL[user.role]}
      </p>

      {actionData && "error" in actionData && actionData.error ? (
        <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
          {actionData.error}
        </div>
      ) : null}
      {actionData && "success" in actionData && actionData.success ? (
        <div role="status" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
          {actionData.success}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Account
        </h2>
        <div style={row}><span style={{ color: "#64748b" }}>Status</span><span style={{ fontWeight: 600, color: user.isActive ? "#166534" : "#991b1b" }}>{user.isActive ? "Active" : "Disabled"}</span></div>
        <div style={row}><span style={{ color: "#64748b" }}>Role</span><span>{ROLE_LABEL[user.role]}</span></div>
        <div style={row}><span style={{ color: "#64748b" }}>Created</span><span>{fmt(user.createdAt)}</span></div>
        <div style={row}><span style={{ color: "#64748b" }}>Invited by</span><span>{user.createdBy ? `${user.createdBy.name} (${user.createdBy.email})` : "—"}</span></div>
        <div style={row}><span style={{ color: "#64748b" }}>Email verified</span><span>{fmt(user.emailVerifiedAt)}</span></div>
        <div style={row}><span style={{ color: "#64748b" }}>Last sign-in</span><span>{fmt(user.lastLoginAt)}</span></div>
        <div style={row}><span style={{ color: "#64748b" }}>Failed sign-ins</span><span>{user.failedLoginCount}{user.lockedUntil ? ` · locked until ${fmt(user.lockedUntil)}` : ""}</span></div>
        <div style={row}><span style={{ color: "#64748b" }}>Password reset pending</span><span>{user.mustChangePassword ? "Yes — must change at next sign-in" : "No"}</span></div>
      </div>

      {canManage ? (
        <div style={card}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
            Administration
          </h2>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1.5rem" }}>
            <div>
              <h3 style={{ fontSize: "0.8rem", fontWeight: 700, color: "#334155", marginBottom: "0.5rem" }}>Role</h3>
              <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input type="hidden" name="intent" value="set_role" />
                <select name="role" defaultValue={user.role} style={{ ...input, flex: 1 }} disabled={roleLocked || !canAssignRoles}>
                  {ADMIN_ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
                <button type="submit" style={{ ...button, opacity: roleLocked || !canAssignRoles ? 0.5 : 1 }} disabled={isSubmitting || roleLocked || !canAssignRoles}>
                  Change
                </button>
              </Form>
              <p style={{ fontSize: "0.68rem", color: "#94a3b8", marginTop: "0.4rem" }}>
                {roleLocked
                  ? "The primary owner's role cannot be changed."
                  : !canAssignRoles
                    ? "Your role does not permit assigning roles."
                    : "Any role change signs the user out of all sessions."}
              </p>
            </div>

            <div>
              <h3 style={{ fontSize: "0.8rem", fontWeight: 700, color: "#334155", marginBottom: "0.5rem" }}>Access</h3>
              <Form method="post">
                <input type="hidden" name="intent" value="set_active" />
                <input type="hidden" name="isActive" value={user.isActive ? "false" : "true"} />
                <button type="submit" style={{ ...button, background: user.isActive ? "#b91c1c" : "#059669", opacity: statusLocked ? 0.5 : 1 }} disabled={isSubmitting || statusLocked}>
                  {user.isActive ? "Disable account" : "Reactivate account"}
                </button>
              </Form>
              <p style={{ fontSize: "0.68rem", color: "#94a3b8", marginTop: "0.4rem" }}>
                {user.isPrimaryOwner
                  ? "The primary owner cannot be disabled."
                  : isSelf && user.isActive
                    ? "You cannot disable your own account."
                    : user.isActive
                      ? "Disabling revokes every session immediately."
                      : "Reactivating does not restore the old sessions."}
              </p>
            </div>

            <div>
              <h3 style={{ fontSize: "0.8rem", fontWeight: 700, color: "#334155", marginBottom: "0.5rem" }}>Sessions</h3>
              <Form method="post">
                <input type="hidden" name="intent" value="revoke_sessions" />
                <button type="submit" style={button} disabled={isSubmitting || user.sessions.length === 0}>
                  Revoke all sessions ({user.sessions.length})
                </button>
              </Form>
              <p style={{ fontSize: "0.68rem", color: "#94a3b8", marginTop: "0.4rem" }}>
                The user must sign in again. Their password is unchanged.
              </p>
            </div>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "1.5rem 0" }} />

          <h3 style={{ fontSize: "0.8rem", fontWeight: 700, color: "#334155", marginBottom: "0.5rem" }}>
            Set a new password (recovery)
          </h3>
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: 0, marginBottom: "0.75rem" }}>
            Use this when someone is locked out. They will be required to choose
            their own password at next sign-in, so this one does not become
            permanent. It is never displayed again and is not written to the audit
            log.
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="reset_password" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "0.75rem", alignItems: "end" }}>
              <div>
                <label style={label} htmlFor="newPassword">Temporary password</label>
                <input style={input} id="newPassword" name="newPassword" type="password" autoComplete="new-password" />
              </div>
              <div>
                <label style={label} htmlFor="confirmPassword">Confirm</label>
                <input style={input} id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" />
              </div>
              <button type="submit" style={button} disabled={isSubmitting}>Reset password</button>
            </div>
          </Form>
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Active sessions ({user.sessions.length})
        </h2>
        {user.sessions.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No active sessions.</p>
        ) : (
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "170px 170px 150px 1fr", padding: "0.6rem 1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: "0.68rem", fontWeight: 700, color: "#082a4a" }}>
              <span>Started</span>
              <span>Last seen</span>
              <span>Expires</span>
              <span>Client</span>
            </div>
            {user.sessions.map((s) => (
              <div key={s.id} style={{ display: "grid", gridTemplateColumns: "170px 170px 150px 1fr", padding: "0.6rem 1rem", borderBottom: "1px solid #f1f5f9", fontSize: "0.72rem", color: "#475569" }}>
                <span>{fmt(s.createdAt)}</span>
                <span>{fmt(s.lastAccessAt)}</span>
                <span>{fmt(s.expiresAt)}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.userAgent || undefined}>
                  {s.ipAddress || "—"}
                  {s.userAgent ? ` · ${s.userAgent}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* No session identifier is shown, here or anywhere: a session id is a
            credential and the panel has no use for one. */}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Recent security events
        </h2>
        {user.recentSecurityEvents.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No security events recorded for this account.</p>
        ) : (
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "190px 200px 1fr 140px", padding: "0.6rem 1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: "0.68rem", fontWeight: 700, color: "#082a4a" }}>
              <span>When</span>
              <span>Event</span>
              <span>Detail</span>
              <span>Source</span>
            </div>
            {user.recentSecurityEvents.map((e) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "190px 200px 1fr 140px", padding: "0.6rem 1rem", borderBottom: "1px solid #f1f5f9", fontSize: "0.72rem", color: "#475569", alignItems: "start" }}>
                <span>{fmt(e.createdAt)}</span>
                <span><code style={{ fontSize: "0.68rem" }}>{e.action}</code></span>
                <span style={{ color: "#64748b" }}>
                  {e.actorName ? `by ${e.actorName}` : e.actorId ? `by ${e.actorId}` : null}
                  {e.afterData ? ` — ${JSON.stringify(e.afterData)}` : ""}
                </span>
                <span>{e.ipAddress || "—"}</span>
              </div>
            ))}
          </div>
        )}
        <p style={{ fontSize: "0.68rem", color: "#94a3b8", marginTop: "0.6rem" }}>
          The audit log is append-only and enforced at the database level. Records
          cannot be edited or deleted from this panel by any role.
        </p>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Invitations created by this account
        </h2>
        {invitations.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>None.</p>
        ) : (
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 130px 120px 170px", padding: "0.6rem 1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: "0.68rem", fontWeight: 700, color: "#082a4a" }}>
              <span>Email</span>
              <span>Role</span>
              <span>Status</span>
              <span>Created</span>
            </div>
            {invitations.map((inv) => (
              <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 130px 120px 170px", padding: "0.6rem 1rem", borderBottom: "1px solid #f1f5f9", fontSize: "0.72rem", color: "#475569" }}>
                <span>{inv.email}</span>
                <span>{ROLE_LABEL[inv.role]}</span>
                <span>{inv.status}</span>
                <span>{fmt(inv.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
