import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireOwnerRole, assertSameOrigin, getRequestMeta } from "~/utils/ownerAuth.server";
import { hashPassword, verifyPassword } from "~/utils/auth.server";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "~/services/audit.server";
import {
  listIntegrationStates,
  refreshIntegration,
  clearIntegrationError,
  INTEGRATION_KEYS,
  type IntegrationKey,
} from "~/services/integrationHealth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireOwnerRole(request, ["OWNER"]);
  return {
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      lastLoginAt: user.lastLoginAt,
    },
    integrations: await listIntegrationStates(),
  };
}

function isIntegrationKey(value: string): value is IntegrationKey {
  return (INTEGRATION_KEYS as string[]).includes(value);
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requireOwnerRole(request, ["OWNER"]);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "change_password");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };

  if (intent === "refresh_integration") {
    const key = String(formData.get("key") || "");
    if (!isIntegrationKey(key)) return { error: "Unknown integration." };
    const state = await refreshIntegration(key, actor);
    return { success: `${key} re-checked: ${state.status}.` };
  }

  if (intent === "clear_integration_error") {
    const key = String(formData.get("key") || "");
    if (!isIntegrationKey(key)) return { error: "Unknown integration." };
    await clearIntegrationError(key, actor);
    return { success: `${key} error cleared.` };
  }

  const currentPassword = String(formData.get("currentPassword") || "");
  const newPassword = String(formData.get("newPassword") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (!currentPassword || !newPassword) {
    return { error: "All password fields are required." };
  }
  if (newPassword.length < 8) {
    return { error: "New password must be at least 8 characters." };
  }
  if (newPassword !== confirmPassword) {
    return { error: "New passwords do not match." };
  }

  const dbUser = await prisma.ownerUser.findUnique({ where: { id: user.id } });
  if (!dbUser || !(await verifyPassword(currentPassword, dbUser.passwordHash))) {
    return { error: "Current password is incorrect." };
  }

  await prisma.ownerUser.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  await recordAudit({
    actorType: "OWNER_USER",
    actorId: user.id,
    actorName: user.name,
    action: "owner.password_changed",
    entityType: AUDIT_ENTITY.OWNER_USER,
    entityId: user.id,
    ipAddress: ip,
    userAgent,
  });

  return { success: "Password updated successfully." };
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "2rem",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  color: "#64748b",
  marginBottom: "0.25rem",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const smallButton: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  color: "#082a4a",
  fontSize: "0.72rem",
  fontWeight: 600,
  cursor: "pointer",
};

function statusColor(status: string): string {
  if (status === "HEALTHY") return "#059669";
  if (status === "FAILED") return "#dc2626";
  if (status === "DELAYED") return "#b45309";
  return "#64748b";
}

export default function AdminSettings() {
  const { user, integrations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Settings
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Account and system configuration
      </p>

      {actionData && "error" in actionData && actionData.error ? (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "0.75rem 1rem",
            borderRadius: 8,
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          {actionData.error}
        </div>
      ) : null}
      {actionData && "success" in actionData && actionData.success ? (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#166534",
            padding: "0.75rem 1rem",
            borderRadius: 8,
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          {actionData.success}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Integration health
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {integrations.map((i) => (
            <div
              key={i.key}
              style={{
                display: "grid",
                gridTemplateColumns: "190px 110px 1fr auto",
                gap: "0.75rem",
                alignItems: "center",
                padding: "0.6rem 0.75rem",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                fontSize: "0.8rem",
              }}
            >
              <span style={{ fontWeight: 600, color: "#1e293b" }}>{i.key}</span>
              <span style={{ fontWeight: 600, color: statusColor(i.status) }}>{i.status}</span>
              <span style={{ color: "#64748b" }}>
                <span>{i.detail}</span>
                <span style={{ display: "block", fontSize: "0.68rem", color: "#94a3b8", marginTop: "0.15rem" }}>
                  {i.lastSuccessAt ? `Last success: ${new Date(i.lastSuccessAt).toLocaleString()}` : "No successful check yet"}
                  {i.lastErrorAt ? ` · Last error: ${new Date(i.lastErrorAt).toLocaleString()}` : ""}
                  {i.lastError ? ` · ${i.lastError}` : ""}
                </span>
              </span>
              <span style={{ display: "flex", gap: "0.35rem" }}>
                <Form method="post">
                  <input type="hidden" name="intent" value="refresh_integration" />
                  <input type="hidden" name="key" value={i.key} />
                  <button type="submit" style={smallButton} disabled={isSubmitting}>
                    Re-check
                  </button>
                </Form>
                {i.lastError || i.lastErrorAt ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="clear_integration_error" />
                    <input type="hidden" name="key" value={i.key} />
                    <button type="submit" style={smallButton} disabled={isSubmitting}>
                      Clear error
                    </button>
                  </Form>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1.5rem" }}>
          Owner Account
        </h2>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "#e2e8f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.5rem",
              color: "#64748b",
              fontWeight: 700,
            }}
          >
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{user.name}</div>
            <div style={{ fontSize: "0.85rem", color: "#64748b" }}>{user.email}</div>
            <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>Role: {user.role}</div>
          </div>
        </div>

        <Form method="post">
          <input type="hidden" name="intent" value="change_password" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem" }}>
            <div>
              <label style={label} htmlFor="currentPassword">Current Password</label>
              <input style={input} id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" />
            </div>
            <div>
              <label style={label} htmlFor="newPassword">New Password</label>
              <input style={input} id="newPassword" name="newPassword" type="password" autoComplete="new-password" />
            </div>
            <div>
              <label style={label} htmlFor="confirmPassword">Confirm New Password</label>
              <input style={input} id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" />
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              marginTop: "1rem",
              padding: "0.75rem 1.5rem",
              background: "#10b981",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: isSubmitting ? "not-allowed" : "pointer",
              opacity: isSubmitting ? 0.6 : 1,
            }}
          >
            {isSubmitting ? "Saving..." : "Update Password"}
          </button>
        </Form>
      </div>

      <p style={{ fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; Back to Dashboard
        </Link>
      </p>
    </div>
  );
}
