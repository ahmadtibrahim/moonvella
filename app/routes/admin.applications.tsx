import { Link, useLoaderData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerAuth(request);

  const [pendingApplications, approvedCount, rejectedCount] = await Promise.all([
    prisma.merchantApplication.findMany({
      where: { status: "PENDING" },
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
      },
    }),
    prisma.merchantApplication.count({ where: { status: "APPROVED" } }),
    prisma.merchantApplication.count({ where: { status: "REJECTED" } }),
  ]);

  return { pendingApplications, approvedCount, rejectedCount };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireOwnerAuth(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const applicationId = String(formData.get("applicationId") || "");

  if (!applicationId) {
    return { error: "Missing application id." };
  }

  if (intent === "approve") {
    await prisma.merchantApplication.update({
      where: { id: applicationId },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
  } else if (intent === "reject") {
    await prisma.merchantApplication.update({
      where: { id: applicationId },
      data: { status: "REJECTED", reviewedAt: new Date() },
    });
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
  const { pendingApplications, approvedCount, rejectedCount } =
    useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Merchant Applications
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Review pending merchant applications to onboard new sellers
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Pending</div>
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
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Rejected</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#dc2626" }}>
            {rejectedCount}
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Pending Applications ({pendingApplications.length})
        </h2>

        {pendingApplications.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.875rem" }}>
            No pending applications.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {pendingApplications.map((app) => (
              <div key={app.id} style={row}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{app.storeName}</div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{app.shopDomain}</div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                    {app.contactName} &middot; {app.email}
                    {app.country ? ` \u00b7 ${app.country}` : ""}
                  </div>
                </div>
                <Form method="post" style={{ display: "flex", gap: "0.5rem" }}>
                  <input type="hidden" name="applicationId" value={app.id} />
                  <button type="submit" name="intent" value="approve" style={btn("#059669")}>
                    Approve
                  </button>
                  <button type="submit" name="intent" value="reject" style={btn("#dc2626")}>
                    Reject
                  </button>
                </Form>
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin/sellers" style={{ color: "#082a4a", fontWeight: 500 }}>
          Manage sellers &rarr;
        </Link>
      </p>
    </div>
  );
}
