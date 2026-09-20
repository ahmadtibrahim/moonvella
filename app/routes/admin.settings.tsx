import { Link, useLoaderData } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";

export async function loader({ request }: { request: Request }) {
  const user = await requireOwnerAuth(request as any);
  return { user };
}

export default function AdminSettings() {
  const { user } = useLoaderData();

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 0" }}>
      <h1>Settings</h1>

      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Account and system configuration
      </p>

      {/* User Information Section */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: 1.5, marginBottom: 2 }}>
        <h2>Owner Account</h2>

        <div style={{ display: "flex", gap: 1, marginBottom: 1 }}>
          <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 2, color: "#64748b" }}>
            {user?.name?.charAt(0) || "U"}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 1, color: "#1e293b" }}>{user?.name || "Owner"}</div>
            <div style={{ fontSize: 0.875, color: "#64748b" }}>{user?.email || ""}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          <div>
            <label>Password</label>
            <input style={{ width: "100%", padding: 0.5, border: "1px solid #cbd5e1", borderRadius: 6, background: "white", fontSize: 0.875 }} type="password" placeholder="Enter new password" />
          </div>
          <div>
            <label>Two-Factor Auth</label>
            <select style={{ width: "100%", padding: 0.5, border: "1px solid #cbd5e1", borderRadius: 6, background: "white", fontSize: 0.875 }}>
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 1, display: "flex", gap: 0.75 }}>
          <button style={{ flex: 1, padding: 0.75, background: "#10b981", color: "white", border: "none", borderRadius: 6, fontSize: 0.875, fontWeight: 500, cursor: "pointer", transition: "background 0.15s" }}>Save Changes</button>
          <button style={{ flex: 1, padding: 0.75, background: "white", color: "#374151", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 0.875, fontWeight: 500, cursor: "pointer", transition: "background 0.15s" }}>Cancel</button>
        </div>
      </div>

      {/* System Configuration Section */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: 1.5 }}>
        <h2>System Configuration</h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          <div>
            <label>Webhook URL</label>
            <input style={{ width: "100%", padding: 0.5, border: "1px solid #cbd5e1", borderRadius: 6, background: "white", fontSize: 0.875 }} type="text" placeholder="https://example.com/webhook" />
          </div>
          <div>
            <label>Auto-Approve New Sellers</label>
            <select style={{ width: "100%", padding: 0.5, border: "1px solid #cbd5e1", borderRadius: 6, background: "white", fontSize: 0.875 }}>
              <option value="disabled">Disabled</option>
              <option value="enabled">Enabled</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 1.5, padding: 1, background: "#f8fafc", borderRadius: 8 }}>
          <p style={{ fontSize: 0.75, color: "#64748b", marginBottom: 0.5 }}>Integration Settings</p>
          <p style={{ fontSize: 0.7, color: "#9ca3af" }}>
            Webhook endpoint for order notifications and inventory sync
          </p>
        </div>
      </div>

      <div style={{ marginTop: 2, paddingTop: 1, borderTop: "1px solid #e2e8f0" }}>
        <p style={{ fontSize: 0.75, color: "#64748b" }}>
          <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
            ← Back to Dashboard
          </Link>
        </p>
      </div>
    </div>
  );
}