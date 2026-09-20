import { Link, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerAuth(request);

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return { logs };
}

const grid = "170px 1.2fr 1fr 1.6fr";

export default function AdminAudit() {
  const { logs } = useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Audit Log
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        System activity and administrator actions
      </p>

      <div
        style={{
          background: "white",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: grid,
            padding: "1rem",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            fontSize: "0.7rem",
            fontWeight: 700,
            color: "#082a4a",
          }}
        >
          <span>Date</span>
          <span>Action</span>
          <span>Actor</span>
          <span>Entity</span>
        </div>

        {logs.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.875rem" }}>
            No audit log entries yet.
          </p>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                padding: "0.75rem 1rem",
                borderBottom: "1px solid #f1f5f9",
                fontSize: "0.8rem",
                alignItems: "center",
              }}
            >
              <span style={{ color: "#64748b" }}>
                {new Date(log.createdAt).toLocaleString()}
              </span>
              <span style={{ fontWeight: 600, color: "#1e293b" }}>{log.action}</span>
              <span style={{ color: "#64748b" }}>
                {log.actorName || log.actorId} ({log.actorType})
              </span>
              <span style={{ color: "#64748b" }}>
                {log.entityType} &middot; {log.entityId}
              </span>
            </div>
          ))
        )}
      </div>

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; Back to Dashboard
        </Link>
      </p>
    </div>
  );
}
