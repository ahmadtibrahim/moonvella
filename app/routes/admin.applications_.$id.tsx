import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireOwnerRole, assertSameOrigin, getRequestMeta } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";
import {
  approveApplication,
  rejectApplication,
  requestInformation,
} from "~/services/application.server";
import { getShopAnalytics } from "~/services/analytics.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireOwnerRole(request, ["OWNER", "REVIEWER", "OPERATIONS", "READONLY"]);
  const id = String(params.id);

  const application = await prisma.merchantApplication.findUnique({
    where: { id },
    include: { seller: true, reviewedBy: { select: { name: true, email: true } } },
  });
  if (!application) {
    throw new Response("Application not found", { status: 404 });
  }

  const history = await prisma.auditLog.findMany({
    where: {
      OR: [
        { entityType: "MerchantApplication", entityId: application.id },
        ...(application.seller ? [{ entityType: "Seller", entityId: application.seller.id }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const analyticsDays = new URL(request.url).searchParams.get("analytics") === "90" ? 90 : 30;
  const analytics = await getShopAnalytics(application.shopDomain, analyticsDays);

  return { application, history, analytics };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requireOwnerRole(request, ["OWNER", "REVIEWER"]);
  const { ip, userAgent } = getRequestMeta(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const reason = String(form.get("reason") || "").trim();
  const id = String(params.id);

  const actor = {
    actorType: "OWNER_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
  };

  try {
    if (intent === "approve") {
      await approveApplication(id, actor, reason || undefined);
    } else if (intent === "reject") {
      await rejectApplication(id, actor, reason || "Not specified");
    } else if (intent === "request_info") {
      await requestInformation(id, actor, reason || "Additional information required");
    } else {
      return { error: "Unknown action." };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }

  return redirect(`/admin/applications/${id}`);
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};
const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px 1fr",
  gap: "1rem",
  padding: "0.5rem 0",
  borderBottom: "1px solid #f1f5f9",
  fontSize: "0.85rem",
};
const keyStyle: React.CSSProperties = { color: "#64748b" };

function val(value: unknown, extra = "") {
  if (value === null || value === undefined || value === "") return <span style={{ color: "#94a3b8" }}>Unknown</span>;
  if (extra === "money") return `${(Number(value) / 100).toFixed(2)}`;
  return String(value);
}

function fmtDate(value: Date | string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function markets(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const COVERAGE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  FULL: { bg: "#d1fae5", color: "#059669", label: "FULL" },
  PARTIAL: { bg: "#fef3c7", color: "#b45309", label: "PARTIAL" },
  PERMISSION_REQUIRED: { bg: "#dbeafe", color: "#1d4ed8", label: "PERMISSION REQUIRED" },
  NOT_CONNECTED: { bg: "#f1f5f9", color: "#64748b", label: "NOT CONNECTED" },
  ERROR: { bg: "#fee2e2", color: "#dc2626", label: "ERROR" },
};

function coverageBadge(coverage: string) {
  return COVERAGE_STYLES[coverage] ?? COVERAGE_STYLES.NOT_CONNECTED;
}

function permissionGuidance(coverage: string, scopes: string[]) {
  const hasReports = scopes.includes("read_reports") || scopes.includes("write_reports");
  const hasAllOrders = scopes.includes("read_all_orders");
  const messages: string[] = [];
  if (!hasReports) {
    messages.push("read_reports is required to read sessions and visitors via ShopifyQL.");
  }
  if (coverage === "PARTIAL" && !hasAllOrders) {
    messages.push("read_all_orders is required to cover the full 90-day order history.");
  }
  return messages;
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: "0.72rem",
    fontWeight: 600,
    color: active ? "white" : "#082a4a",
    background: active ? "#082a4a" : "transparent",
    border: "1px solid #082a4a",
    borderRadius: 9999,
    padding: "0.2rem 0.7rem",
    textDecoration: "none",
  };
}

export default function ApplicationDetail() {
  const { application, history, analytics } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const app = application;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/applications" style={{ color: "#082a4a" }}>
          &larr; All applications
        </Link>
      </p>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        {app.storeName}
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        {app.shopDomain} &middot; Status: <strong>{app.status}</strong>
        {app.seller ? ` · Seller: ${app.seller.status}` : " · No seller record yet"}
      </p>

      <div style={{ marginBottom: "1.25rem" }}>
        <span style={{ display: "inline-block", background: "#eaf4ff", color: "#082a4a", fontWeight: 700, fontSize: "0.8rem", padding: "0.35rem 0.8rem", borderRadius: 9999 }}>
          Product category (merchant-declared): {app.productCategory || "Unknown"}
        </span>
      </div>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Store &amp; business
        </h2>
        <div style={rowStyle}>
          <span style={keyStyle}>Website</span>
          <span>
            {app.storeUrl ? (
              <a href={app.storeUrl} target="_blank" rel="noreferrer">
                {app.storeUrl}
              </a>
            ) : (
              <span style={{ color: "#94a3b8" }}>Unknown</span>
            )}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Legal business name</span>
          <span>{val(app.legalBusinessName)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Address</span>
          <span>{val(app.sellerAddress)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Country / currency</span>
          <span>
            {val(app.country)} / {val(app.currency)}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Shopify plan</span>
          <span>{val(app.shopifyPlan)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Product category</span>
          <span>{val(app.productCategory)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Markets</span>
          <span>{markets(app.markets).join(", ") || "—"}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Business start date</span>
          <span>{app.businessStartDate ? fmtDate(app.businessStartDate) : "Unknown"}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>MoonVella installation</span>
          <span>{app.seller?.installedAt ? fmtDate(app.seller.installedAt) : "Unknown"}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Custom domain registered</span>
          <span>{app.seller?.domainRegisteredAt ? fmtDate(app.seller.domainRegisteredAt) : "Unknown"}</span>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Contact
        </h2>
        <div style={rowStyle}>
          <span style={keyStyle}>Contact name</span>
          <span>{val(app.contactName)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Email</span>
          <span>{val(app.email)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Phone</span>
          <span>{val(app.phone)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Urgent phone</span>
          <span>{val(app.urgentPhone)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>GST/HST</span>
          <span>{val(app.gstHstNumber)}</span>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Review
        </h2>
        <div style={rowStyle}>
          <span style={keyStyle}>Submitted</span>
          <span>{fmtDate(app.submittedAt)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Reviewed by</span>
          <span>{app.reviewedBy ? app.reviewedBy.name : "—"}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Review date</span>
          <span>{fmtDate(app.reviewedAt)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Rejection reason</span>
          <span>{val(app.rejectionReason)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Internal notes</span>
          <span>{val(app.internalNotes)}</span>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a" }}>
            Store analytics (application review) — {application.shopDomain}
          </h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Link to="?analytics=30" style={toggleStyle(analytics.days === 30)}>30 days</Link>
            <Link to="?analytics=90" style={toggleStyle(analytics.days === 90)}>90 days</Link>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
          <span
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: 9999,
              fontSize: "0.625rem",
              fontWeight: 700,
              background: coverageBadge(analytics.coverage).bg,
              color: coverageBadge(analytics.coverage).color,
            }}
          >
            {coverageBadge(analytics.coverage).label}
          </span>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            {analytics.from} → {analytics.to} · {analytics.timezone} · {analytics.currency} · Window: {analytics.days} days
          </span>
        </div>

        <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.75rem" }}>
          {analytics.lastSyncAt ? `Last sync ${fmtDate(analytics.lastSyncAt)}` : "Not synced"}
        </p>

        {permissionGuidance(analytics.coverage, analytics.grantedScopes).length > 0 ? (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", padding: "0.6rem", borderRadius: 8, fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            {permissionGuidance(analytics.coverage, analytics.grantedScopes).map((g) => (
              <div key={g}>· {g}</div>
            ))}
          </div>
        ) : null}

        {analytics.coverage === "NOT_CONNECTED" ? (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#475569", padding: "0.6rem", borderRadius: 8, fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            This shop has not connected analytics data. Metrics stay unavailable — never zero — until the app is
            installed and authorized for this shop.
          </div>
        ) : null}

        {analytics.error ? (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.6rem", borderRadius: 8, fontSize: "0.8rem", marginBottom: "0.75rem" }}>
            {analytics.error}
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.6rem", marginBottom: "0.75rem" }}>
          {([
            ["Sales", analytics.sales, "money"],
            ["Paid orders", analytics.paidOrders, "int"],
            ["Average order value", analytics.averageOrderValue, "money"],
            ["Refund amount", analytics.refunds, "money"],
            ["Sessions", analytics.sessions, "int"],
            ["Visitors (period unique)", analytics.visitors, "int"],
            ["Avg daily visitors", analytics.averageDailyVisitors, "int"],
          ] as [string, number | null, string][]).map(([label, value, kind]) => (
            <div key={label} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem" }}>
              <div style={{ fontSize: "0.66rem", color: "#64748b" }}>{label}</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: value == null ? "#94a3b8" : "#082a4a" }}>
                {value == null ? "Unavailable" : kind === "money" ? money(value, analytics.currency) : String(value)}
              </div>
            </div>
          ))}
        </div>

        <p style={{ fontSize: "0.7rem", color: "#64748b", marginBottom: "0.5rem" }}>{analytics.salesDefinition}</p>

        {analytics.dailyTrend.length > 0 ? (
          <div style={{ fontSize: "0.72rem", color: "#334155", marginBottom: "0.5rem" }}>
            <div style={{ color: "#64748b", marginBottom: "0.25rem" }}>
              Daily trend ({analytics.dailyTrend.length} day(s) with paid orders)
            </div>
            {analytics.dailyTrend.map((d) => (
              <div key={d.date}>
                {d.date}: {money(d.sales, analytics.currency)} · {d.orders} orders
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
            No daily paid-order trend available for this window.
          </p>
        )}

        <div style={{ fontSize: "0.7rem", color: "#64748b" }}>
          <div>Granted scopes: {analytics.grantedScopes.length ? analytics.grantedScopes.join(", ") : "unavailable"}</div>
          {analytics.notes.map((n) => (
            <div key={n}>· {n}</div>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Decision
        </h2>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label
              htmlFor="decision-reason"
              style={{ display: "block", fontSize: "0.72rem", color: "#64748b", marginBottom: "0.25rem" }}
            >
              Decision note / reason
            </label>
            <input
              id="decision-reason"
              name="reason"
              style={{ width: "100%", padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, boxSizing: "border-box" }}
            />
          </div>
          <button type="submit" name="intent" value="approve" style={btn("#059669")}>
            Approve
          </button>
          <button type="submit" name="intent" value="request_info" style={btn("#0369a1")}>
            Request info
          </button>
          <button type="submit" name="intent" value="reject" style={btn("#dc2626")}>
            Reject
          </button>
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Decision history
        </h2>
        {history.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No decisions recorded yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {history.map((h) => (
              <div key={h.id} style={{ fontSize: "0.78rem", color: "#334155" }}>
                <span style={{ color: "#94a3b8" }}>{fmtDate(h.createdAt)}</span> · <strong>{h.action}</strong> by{" "}
                {h.actorName || h.actorId} ({h.actorType})
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    padding: "0.6rem 1rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: "white",
    color,
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}
