import { Link, Form, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "audit.view");

  const url = new URL(request.url);
  const actor = url.searchParams.get("actor")?.trim() || "";
  const action = url.searchParams.get("action")?.trim() || "";
  const entityType = url.searchParams.get("entityType")?.trim() || "";
  const from = url.searchParams.get("from")?.trim() || "";
  const to = url.searchParams.get("to")?.trim() || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(200, Math.max(10, Number(url.searchParams.get("pageSize") || "50") || 50));

  const where: Prisma.AuditLogWhereInput = {};
  if (actor) where.OR = [{ actorId: { contains: actor } }, { actorName: { contains: actor } }];
  if (action) where.action = { contains: action };
  if (entityType) where.entityType = entityType;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const [logs, total, entityTypeRows, actionRows] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      distinct: ["entityType"],
      select: { entityType: true },
      orderBy: { entityType: "asc" },
    }),
    prisma.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
      take: 200,
    }),
  ]);

  return {
    logs,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    filters: { actor, action, entityType, from, to },
    entityTypes: entityTypeRows.map((e) => e.entityType),
    actions: actionRows.map((a) => a.action),
  };
}

const grid = "170px 1.2fr 1fr 1.6fr";

const filterInput: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.8rem",
  boxSizing: "border-box",
};

const filterLabel: React.CSSProperties = {
  display: "block",
  fontSize: "0.7rem",
  color: "#64748b",
  marginBottom: "0.2rem",
};

export default function AdminAudit() {
  const { logs, total, page, pageSize, pages, filters, entityTypes, actions } =
    useLoaderData<typeof loader>();

  const query = new URLSearchParams();
  if (filters.actor) query.set("actor", filters.actor);
  if (filters.action) query.set("action", filters.action);
  if (filters.entityType) query.set("entityType", filters.entityType);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (pageSize !== 50) query.set("pageSize", String(pageSize));

  const pageLink = (target: number) => {
    const q = new URLSearchParams(query);
    q.set("page", String(target));
    return `/admin/audit?${q.toString()}`;
  };
  const exportQuery = new URLSearchParams(query);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Audit Log
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        System activity and administrator actions
      </p>

      <Form
        method="get"
        style={{
          background: "white",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          padding: "1rem",
          marginBottom: "1rem",
          display: "grid",
          gridTemplateColumns: "1.2fr 1.2fr 1fr 1fr 1fr auto",
          gap: "0.75rem",
          alignItems: "end",
        }}
      >
        <div>
          <label style={filterLabel} htmlFor="actor">Actor</label>
          <input style={filterInput} id="actor" name="actor" defaultValue={filters.actor} placeholder="name or id" />
        </div>
        <div>
          <label style={filterLabel} htmlFor="action">Action</label>
          <input style={filterInput} id="action" name="action" defaultValue={filters.action} placeholder="e.g. payment" list="audit-actions" />
          <datalist id="audit-actions">
            {actions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>
        <div>
          <label style={filterLabel} htmlFor="entityType">Entity type</label>
          <select style={filterInput} id="entityType" name="entityType" defaultValue={filters.entityType}>
            <option value="">All</option>
            {entityTypes.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={filterLabel} htmlFor="from">From</label>
          <input style={filterInput} id="from" name="from" type="date" defaultValue={filters.from} />
        </div>
        <div>
          <label style={filterLabel} htmlFor="to">To</label>
          <input style={filterInput} id="to" name="to" type="date" defaultValue={filters.to} />
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button
            type="submit"
            style={{
              padding: "0.45rem 0.9rem",
              background: "#082a4a",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Filter
          </button>
          <Link
            to="/admin/audit"
            style={{
              padding: "0.45rem 0.9rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: "0.8rem",
              color: "#082a4a",
              textDecoration: "none",
            }}
          >
            Reset
          </Link>
        </div>
      </Form>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
          {total.toLocaleString()} entries · page {page} of {pages}
        </span>
        <a
          href={`/admin/audit/csv?${exportQuery.toString()}`}
          style={{ fontSize: "0.78rem", color: "#082a4a", fontWeight: 600 }}
        >
          Export CSV
        </a>
      </div>

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
            No audit log entries match these filters.
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

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", alignItems: "center" }}>
        {page > 1 ? (
          <Link to={pageLink(page - 1)} style={{ fontSize: "0.8rem", color: "#082a4a", fontWeight: 600 }}>
            &larr; Newer
          </Link>
        ) : null}
        {page < pages ? (
          <Link to={pageLink(page + 1)} style={{ fontSize: "0.8rem", color: "#082a4a", fontWeight: 600 }}>
            Older &rarr;
          </Link>
        ) : null}
      </div>

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; Back to Dashboard
        </Link>
      </p>
    </div>
  );
}
