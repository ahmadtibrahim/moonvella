import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { can } from "~/services/permissions";
import { listUsers, setUserActive, revokeUserSessions } from "~/services/adminUsers.server";
import { createInvitation, cancelInvitation, listInvitations } from "~/services/invitations.server";
import { ADMIN_ROLES, ROLE_LABEL, isAdminRole } from "~/utils/adminRoles";
import type { AdminRole } from "@prisma/client";

export async function loader({ request }: LoaderFunctionArgs) {
  const viewer = await requirePermission(request, "users.view");

  const [users, invitations] = await Promise.all([listUsers(), listInvitations()]);

  return {
    users,
    invitations,
    viewerId: viewer.id,
    canManage: can(viewer.role, "users.manage"),
    canAssignRoles: can(viewer.role, "roles.assign"),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const actor = await requirePermission(request, "users.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const meta = { ip, userAgent };
  const who = { id: actor.id, name: actor.name };

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    switch (intent) {
      case "invite": {
        if (!can(actor.role, "roles.assign")) {
          throw new Error("Your role does not permit assigning roles.");
        }
        const role = String(form.get("role") || "");
        if (!isAdminRole(role)) throw new Error("Choose a valid role.");

        const result = await createInvitation(
          {
            email: String(form.get("email") || ""),
            name: String(form.get("name") || ""),
            role,
          },
          who,
          meta
        );

        if (!result.ok) return { error: result.error };

        // The only moment this URL exists. It is not stored, not logged, and
        // cannot be recovered — if it is lost, the fix is to cancel and reissue.
        const inviteUrl = new URL(
          `/admin/accept-invite?token=${encodeURIComponent(result.token)}`,
          request.url
        ).toString();

        return {
          success: `Invitation created for ${result.email}.`,
          inviteUrl,
          inviteEmail: result.email,
          inviteExpiresAt: result.expiresAt.toISOString(),
        };
      }

      case "cancel_invitation": {
        const result = await cancelInvitation(String(form.get("invitationId")), who, meta);
        if (!result.ok) return { error: result.error };
        return { success: "Invitation cancelled." };
      }

      case "set_active": {
        const isActive = String(form.get("isActive")) === "true";
        const result = await setUserActive(who, String(form.get("userId")), isActive, meta);
        if (!result.ok) return { error: result.error };
        return { success: result.message };
      }

      case "revoke_sessions": {
        const result = await revokeUserSessions(who, String(form.get("userId")), meta);
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

const ROLE_BLURB: Record<AdminRole, string> = {
  OWNER: "Full access, including staff and roles.",
  ADMIN: "Operations, products and merchants. No staff, secrets or payments.",
  OPERATIONS: "Orders and fulfilment workflow.",
  CATALOG: "Products and availability. No orders or payments.",
  SUPPORT: "Read-only on merchants and orders, plus internal notes.",
  VIEWER: "Read-only dashboard and reports.",
};

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

const smallButton: React.CSSProperties = {
  padding: "0.3rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  color: "#082a4a",
  fontSize: "0.7rem",
  fontWeight: 600,
  cursor: "pointer",
};

const USER_GRID = "1.6fr 1.9fr 130px 110px 150px 1.7fr";

function statusPill(active: boolean): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "0.1rem 0.45rem",
    borderRadius: 999,
    fontSize: "0.68rem",
    fontWeight: 700,
    background: active ? "#dcfce7" : "#fee2e2",
    color: active ? "#166534" : "#991b1b",
  };
}

export default function AdminUsers() {
  const { users, invitations, viewerId, canManage, canAssignRoles } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const pendingInvitations = invitations.filter((i) => i.isRedeemable);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Users
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Staff accounts and invitations. Accounts are created by invitation only.
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

      {/* The URL is rendered once, from the action's return value, and is gone on
          the next request. Nothing persists it — not the database, not a log. */}
      {actionData && "inviteUrl" in actionData && actionData.inviteUrl ? (
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 12, padding: "1.25rem", marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#1e3a8a", marginBottom: "0.35rem" }}>
            Invitation link for {actionData.inviteEmail}
          </div>
          <p style={{ fontSize: "0.78rem", color: "#1e40af", margin: "0 0 0.65rem" }}>
            Copy this now and send it to them yourself. It is shown only once and
            cannot be recovered. It expires{" "}
            {actionData.inviteExpiresAt
              ? new Date(actionData.inviteExpiresAt).toLocaleString()
              : "in 24 hours"}{" "}
            and works exactly once. No email has been sent.
          </p>
          <input
            readOnly
            value={actionData.inviteUrl}
            onFocus={(e) => e.currentTarget.select()}
            style={{ ...input, fontFamily: "monospace", fontSize: "0.75rem", background: "white" }}
          />
        </div>
      ) : null}

      {canManage ? (
        <div style={card}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
            Invite a staff member
          </h2>
          <Form method="post">
            <input type="hidden" name="intent" value="invite" />
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr auto", gap: "1rem", alignItems: "end" }}>
              <div>
                <label style={label} htmlFor="invite-name">Display name</label>
                <input style={input} id="invite-name" name="name" type="text" required />
              </div>
              <div>
                <label style={label} htmlFor="invite-email">Email address</label>
                <input style={input} id="invite-email" name="email" type="email" required />
              </div>
              <div>
                <label style={label} htmlFor="invite-role">Role</label>
                <select style={input} id="invite-role" name="role" defaultValue="OPERATIONS">
                  {ADMIN_ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={isSubmitting || !canAssignRoles}
                style={{
                  padding: "0.55rem 1.1rem",
                  background: "#082a4a",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  cursor: isSubmitting || !canAssignRoles ? "not-allowed" : "pointer",
                  opacity: isSubmitting || !canAssignRoles ? 0.6 : 1,
                }}
              >
                Create invitation
              </button>
            </div>
          </Form>
          <p style={{ fontSize: "0.7rem", color: "#94a3b8", marginTop: "0.65rem" }}>
            The invitation is valid for 24 hours and can be used once. The role is
            fixed at creation and cannot be changed by whoever accepts it. No
            outbound email is configured — you will be shown a link to send
            yourself.
          </p>
          <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.1rem", fontSize: "0.72rem", color: "#64748b" }}>
            {ADMIN_ROLES.map((r) => (
              <li key={r} style={{ marginBottom: "0.15rem" }}>
                <strong>{ROLE_LABEL[r]}</strong> — {ROLE_BLURB[r]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Staff accounts ({users.length})
        </h2>

        <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: USER_GRID, padding: "0.7rem 1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: "0.68rem", fontWeight: 700, color: "#082a4a" }}>
            <span>Name</span>
            <span>Email</span>
            <span>Role</span>
            <span>Status</span>
            <span>Last sign-in</span>
            <span>Actions</span>
          </div>

          {users.map((u) => {
            const isSelf = u.id === viewerId;
            return (
              <div key={u.id} style={{ display: "grid", gridTemplateColumns: USER_GRID, padding: "0.7rem 1rem", borderBottom: "1px solid #f1f5f9", fontSize: "0.78rem", alignItems: "center" }}>
                <span style={{ fontWeight: 600, color: "#1e293b" }}>
                  <Link to={`/admin/users/${u.id}`} style={{ color: "#082a4a" }}>
                    {u.name}
                  </Link>
                  {u.isPrimaryOwner ? (
                    <span style={{ marginLeft: "0.4rem", fontSize: "0.6rem", fontWeight: 700, color: "#7c3aed", border: "1px solid #ddd6fe", background: "#f5f3ff", borderRadius: 4, padding: "0.05rem 0.3rem" }}>
                      PRIMARY
                    </span>
                  ) : null}
                  {isSelf ? (
                    <span style={{ marginLeft: "0.4rem", fontSize: "0.6rem", color: "#94a3b8" }}>(you)</span>
                  ) : null}
                </span>
                <span style={{ color: "#64748b" }}>{u.email}</span>
                <span style={{ color: "#334155", fontWeight: 600 }}>{ROLE_LABEL[u.role]}</span>
                <span>
                  <span style={statusPill(u.isActive)}>{u.isActive ? "Active" : "Disabled"}</span>
                  {u.mustChangePassword ? (
                    <span style={{ display: "block", fontSize: "0.6rem", color: "#b45309", marginTop: "0.15rem" }}>
                      password reset pending
                    </span>
                  ) : null}
                </span>
                <span style={{ color: "#64748b", fontSize: "0.72rem" }}>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"}
                  <span style={{ display: "block", color: "#94a3b8" }}>
                    {u._count.sessions} active session(s)
                  </span>
                </span>
                <span style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                  <Link to={`/admin/users/${u.id}`} style={smallButton}>
                    Manage
                  </Link>
                  {canManage ? (
                    <>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="set_active" />
                        <input type="hidden" name="userId" value={u.id} />
                        <input type="hidden" name="isActive" value={u.isActive ? "false" : "true"} />
                        <button
                          type="submit"
                          style={smallButton}
                          disabled={isSubmitting || u.isPrimaryOwner || (isSelf && u.isActive)}
                          title={
                            u.isPrimaryOwner
                              ? "The primary owner cannot be disabled"
                              : isSelf && u.isActive
                                ? "You cannot disable your own account"
                                : undefined
                          }
                        >
                          {u.isActive ? "Disable" : "Reactivate"}
                        </button>
                      </Form>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="revoke_sessions" />
                        <input type="hidden" name="userId" value={u.id} />
                        <button type="submit" style={smallButton} disabled={isSubmitting || u._count.sessions === 0}>
                          Revoke sessions
                        </button>
                      </Form>
                    </>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Invitations
          {pendingInvitations.length ? (
            <span style={{ marginLeft: "0.5rem", fontSize: "0.72rem", fontWeight: 600, color: "#b45309" }}>
              {pendingInvitations.length} awaiting acceptance
            </span>
          ) : null}
        </h2>

        {invitations.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No invitations have been created.</p>
        ) : (
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1.9fr 120px 120px 170px 120px", padding: "0.7rem 1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", fontSize: "0.68rem", fontWeight: 700, color: "#082a4a" }}>
              <span>Name</span>
              <span>Email</span>
              <span>Role</span>
              <span>Status</span>
              <span>Expires</span>
              <span>Actions</span>
            </div>
            {invitations.map((inv) => {
              const effective = inv.isExpired ? "EXPIRED" : inv.status;
              const colour =
                effective === "PENDING" ? "#b45309"
                  : effective === "ACCEPTED" ? "#059669"
                    : effective === "EXPIRED" ? "#dc2626"
                      : "#64748b";
              return (
                <div key={inv.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 1.9fr 120px 120px 170px 120px", padding: "0.7rem 1rem", borderBottom: "1px solid #f1f5f9", fontSize: "0.78rem", alignItems: "center" }}>
                  <span style={{ fontWeight: 600, color: "#1e293b" }}>{inv.name}</span>
                  <span style={{ color: "#64748b" }}>{inv.email}</span>
                  <span style={{ color: "#334155" }}>{ROLE_LABEL[inv.role]}</span>
                  <span style={{ color: colour, fontWeight: 700, fontSize: "0.7rem" }}>{effective}</span>
                  <span style={{ color: "#64748b", fontSize: "0.72rem" }}>
                    {new Date(inv.expiresAt).toLocaleString()}
                    <span style={{ display: "block", color: "#94a3b8" }}>
                      by {inv.invitedBy?.name || "—"}
                    </span>
                  </span>
                  <span>
                    {canManage && inv.isRedeemable ? (
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="cancel_invitation" />
                        <input type="hidden" name="invitationId" value={inv.id} />
                        <button type="submit" style={smallButton} disabled={isSubmitting}>
                          Cancel
                        </button>
                      </Form>
                    ) : (
                      <span style={{ color: "#cbd5e1", fontSize: "0.7rem" }}>
                        {effective === "ACCEPTED" && inv.acceptedAt
                          ? new Date(inv.acceptedAt).toLocaleDateString()
                          : "—"}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p style={{ fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; Back to Dashboard
        </Link>
      </p>
    </div>
  );
}
