import { Link, useLoaderData } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";

export async function loader({ request }: { request: Request }) {
  const user = await requireOwnerAuth(request as any);
  return { user };
}

export default function AdminAuditLog() {
  const { user } = useLoaderData();

  // Mock audit log data - in production this would come from a database
  const auditLogs = [
    {
      id: 1,
      action: "Merchant application approved",
      user: "System",
      details: "Application ID: APP-001 approved by owner",
      timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    },
    {
      id: 2,
      action: "Seller suspended",
      user: "owner@moonvella.com",
      details: "Seller: LuxeStyle suspended for policy violation",
      timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    },
    {
      id: 3,
      action: "Order processed",
      user: "System",
      details: "Order #12345 processed successfully",
      timestamp: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    },
    {
      id: 4,
      action: "Webhook failed",
      user: "System",
      details: "Webhook failed for order #12345, retry scheduled",
      timestamp: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    },
    {
      id: 5,
      action: "Seller reactivated",
      user: "owner@moonvella.com",
      details: "Seller: BloomBoutique reactivated",
      timestamp: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    },
  ];

  return { user, auditLogs };
}

export default function AdminAuditLogPage() {
  const { user, auditLogs } = useLoaderData();

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 0" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: "700", color: "#082a4a", marginBottom: "1rem" }}>
        Audit Log
      </h1>

      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        System activity and administrator actions log
      </p>

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1rem", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Date</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Action</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>User</span>
          <span style={{ fontWeight: "600", fontSize: "0.875rem", color: "#082a4a" }}>Details</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.5px" }}>
          {auditLogs.map((log) => {
            return (
              <div key={log.id} style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.75rem 1rem",
                background: "white",
                borderBottom: "1px solid #f1f5f9",
              }}>
                <span style={{ fontSize: "0.7rem", color: "#64748b" }}>{formatTimestamp(log.timestamp)}</span>
                <span style={{ fontSize: "0.7rem", color: "#1e293b", fontWeight: "500" }}>{log.action}</span>
                <span style={{ fontSize: "0.7rem", color: "#64748b" }}>{log.user}</span>
                <span style={{ fontSize: "0.7rem", color: "#64748b" }}>{log.details}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #e2e8f0" }}>
        <p style={{ fontSize: "0.75rem", color: "#64748b" }}>
          <Link to="/admin" style={{ color: "#082a4a", fontWeight: "500" }}>
            ← Back to Dashboard
          </Link>
        </p>
      </div>
    </div>
  );
}