import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  requirePermission,
  assertSameOrigin,
  getRequestMeta,
} from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import {
  approveApplication,
  rejectApplication,
  requestInformation,
} from "~/services/application.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "merchants.view");

  const [pendingApplications, approvedCount, rejectedCount, needsInfoCount] =
    await Promise.all([
      prisma.merchantApplication.findMany({
        where: { status: { in: ["PENDING", "NEEDS_INFO"] } },
        orderBy: { submittedAt: "desc" },
        select: {
          id: true,
          storeName: true,
          shopDomain: true,
          submittedAt: true,
          contactName: true,
          email: true,
          productCategory: true,
          country: true,
          status: true,
        },
      }),
      prisma.merchantApplication.count({ where: { status: "APPROVED" } }),
      prisma.merchantApplication.count({ where: { status: "REJECTED" } }),
      prisma.merchantApplication.count({ where: { status: "NEEDS_INFO" } }),
    ]);

  return { pendingApplications, approvedCount, rejectedCount, needsInfoCount };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "merchants.manage");
  const { ip, userAgent } = getRequestMeta(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const applicationId = String(formData.get("applicationId") || "");
  const reason = String(formData.get("reason") || "").trim();

  if (!applicationId) {
    return { error: "Missing application id." };
  }

  const actor = {
    actorType: "ADMIN_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
  };

  try {
    if (intent === "approve") {
      await approveApplication(applicationId, actor, reason || undefined);
    } else if (intent === "reject") {
      await rejectApplication(applicationId, actor, reason || "Not specified");
    } else if (intent === "request_info") {
      await requestInformation(applicationId, actor, reason || "Additional information required");
    } else {
      return { error: "Unknown action." };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "The operation failed.",
    };
  }

  return redirect("/admin/applications");
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
};

const row: React.CSSProperties = {
  padding: "1rem",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
};

const btn = (color: string): React.CSSProperties => ({
  padding: "0.5rem 1rem",
  border: `1px solid ${color}`,
  borderRadius: 6,
  background: "white",
  color,
  fontSize: "0.75rem",
  fontWeight: 600,
  cursor: "pointer",
});

export default function AdminApplications() {
  const { pendingApplications, approvedCount, rejectedCount, needsInfoCount } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Merchant Applications
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Review pending merchant applications to onboard new sellers
      </p>

      {actionData?.error ? (
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
          Operation failed: {actionData.error}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Awaiting review</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#b45309" }}>
            {pendingApplications.length}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Approved</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#059669" }}>
            {approvedCount}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Needs info</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#0369a1" }}>
            {needsInfoCount}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Rejected</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#dc2626" }}>
            {rejectedCount}
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Applications needing action ({pendingApplications.length})
        </h2>

        {pendingApplications.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.875rem" }}>
            No applications awaiting review.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {pendingApplications.map((app) => (
              <div key={app.id} style={row}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                    {app.storeName}{" "}
                    <span
                      style={{
                        fontSize: "0.6rem",
                        fontWeight: 700,
                        color: app.status === "NEEDS_INFO" ? "#0369a1" : "#b45309",
                      }}
                    >
                      {app.status}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{app.shopDomain}</div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                    {app.contactName} &middot; {app.email}
                    {app.country ? ` \u00b7 ${app.country}` : ""}
                  </div>
                  <div style={{ marginTop: "0.5rem" }}>
                    <Link
                      to={`/admin/applications/${app.id}`}
                      style={{ fontSize: "0.75rem", color: "#082a4a", fontWeight: 600 }}
                    >
                      Open full application &rarr;
                    </Link>
                  </div>
                </div>
                <Form
                  method="post"
                  style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: 260 }}
                >
                  <input type="hidden" name="applicationId" value={app.id} />
                  <input
                    type="text"
                    name="reason"
                    placeholder="Decision note (optional)"
                    style={{
                      padding: "0.4rem 0.6rem",
                      border: "1px solid #cbd5e1",
                      borderRadius: 6,
                      fontSize: "0.75rem",
                    }}
                  />
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button type="submit" name="intent" value="approve" style={btn("#059669")}>
                      Approve
                    </button>
                    <button type="submit" name="intent" value="reject" style={btn("#dc2626")}>
                      Reject
                    </button>
                    <button type="submit" name="intent" value="request_info" style={btn("#0369a1")}>
                      Request info
                    </button>
                  </div>
                </Form>
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin/stores" style={{ color: "#082a4a", fontWeight: 500 }}>
          Manage sellers &rarr;
        </Link>
      </p>
    </div>
  );
}
