import { Link, useLoaderData, redirect } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";
import { authenticateOwner, createOwnerSession } from "~/services/ownerAuth.server";

export async function loader({ request }: { request: Request }) {
  const user = await requireOwnerAuth(request as any);
  return { user };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const action = formData.get("action") as string;
  const appId = formData.get("appId") as string;

  if (!appId || !action) {
    return { error: "Invalid request" };
  }

  if (action === "approve") {
    await prisma.merchantApplication.update({
      where: { id: appId },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
  } else if (action === "reject") {
    await prisma.merchantApplication.update({
      where: { id: appId },
      data: { status: "REJECTED", rejectedAt: new Date() },
    });
  }

  return redirect("/admin/applications");
}

export default function AdminApplications() {
  const { user } = useLoaderData();
  const { prisma } = await import("~/db.server");

  const [
    pendingApplications,
    approvedSellers,
  ] = await Promise.all([
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
      },
    }),
    prisma.seller.count({ where: { status: "APPROVED" } }),
  ]);

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 0" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: "700", color: "#082a4a", marginBottom: "1rem" }}>
        Merchant Applications
      </h1>

      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Review pending merchant applications to onboard new sellers
      </p>

      {pendingApplications.length === 0 ? (
        <div style={{ textAlign: "center", padding: "3rem", color: "#64748b" }}>
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>✅</div>
          <p>No pending applications</p>
        </div>
      ) : (
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem", marginBottom: "2rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>Pending Applications ({pendingApplications.length})</h2>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {pendingApplications.map((app) => (
              <div key={app.id} style={{
                padding: "1rem",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: "600", fontSize: "0.875rem" }}>{app.storeName}</div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{app.shopDomain}</div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "0.25rem" }}>
                    Submitted {new Date(app.submittedAt).toLocaleDateString()} by {app.contactName}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.75rem" }}>
                  <button
                    style={{
                      padding: "0.5rem 1rem",
                      border: "1px solid #10b981",
                      borderRadius: "6px",
                      background: "white",
                      color: "#10b981",
                      fontSize: "0.75rem",
                      fontWeight: "500",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                    onClick={() => {
                      // Would trigger approve action
                    }}
                  >
                    Approve
                  </button>
                  <button
                    style={{
                      padding: "0.5rem 1rem",
                      border: "1px solid #ef4444",
                      borderRadius: "6px",
                      background: "white",
                      color: "#ef4444",
                      fontSize: "0.75rem",
                      fontWeight: "500",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>Approved Sellers ({approvedSellers})</h2>
        </div>
        <p style={{ fontSize: "0.75rem", color: "#64748b" }}>
          <Link to="/admin/sellers" style={{ color: "#082a4a", fontWeight: "500" }}>
            Manage sellers →
          </Link>
        </p>
      </div>
    </div>
  );
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    if (name && rest.length > 0) {
      cookies[name] = rest.join("=");
    }
  });
  return cookies;
}

export { parseCookies };