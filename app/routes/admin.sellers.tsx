import { Link, useLoaderData, redirect } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: { request: Request }) {
  const user = await requireOwnerAuth(request as any);
  return { user };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const action = formData.get("action") as string;
  const sellerId = formData.get("sellerId") as string;

  if (!sellerId || !action) {
    return { error: "Invalid request" };
  }

  if (action === "suspend") {
    await prisma.seller.update({
      where: { id: sellerId },
      data: { status: "SUSPENDED" },
    });
  } else if (action === "reactivate") {
    await prisma.seller.update({
      where: { id: sellerId },
      data: { status: "APPROVED" },
    });
  }

  return redirect("/admin/sellers");
}

export default function AdminSellers() {
  const { user } = useLoaderData();
  const { prisma } = await import("~/db.server");

  const [
    allSellers,
    pendingApplications,
  ] = await Promise.all([
    prisma.seller.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        storeName: true,
        shopDomain: true,
        status: true,
        _count: { select: { orders: true } },
      },
    }),
    prisma.merchantApplication.count({ where: { status: "PENDING" } }),
  ]);

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "2rem 0" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: "700", color: "#082a4a", marginBottom: "1rem" }}>
        Sellers Management
      </h1>

      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Manage approved sellers and review pending applications
      </p>

      {/* Pending Applications Section */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem", marginBottom: "2rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>Pending Applications ({pendingApplications})</h2>
        </div>

        {pendingApplications === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.875rem" }}>No pending applications</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {/* We'll add pending apps here if needed */}
          </div>
        )}

        <p style={{ fontSize: "0.75rem", color: "#64748b" }}>
          <Link to="/admin/applications" style={{ color: "#082a4a", fontWeight: "500" }}>
            Review applications →
          </Link>
        </p>
      </div>

      {/* Sellers List Section */}
      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: "600", color: "#082a4a" }}>All Sellers</h2>
          <div>
            <span style={{ fontSize: "0.75rem", color: "#64748b", marginRight: "0.5rem" }}>Total: {allSellers.length}</span>
            <span style={{ fontSize: "0.75rem", color: "#64748b", marginRight: "0.5rem" }}>Approved: {allSellers.filter(s => s.status === "APPROVED").length}</span>
            <span style={{ fontSize: "0.75rem", color: "#dc2626", marginRight: "0.5rem" }}>Suspended: {allSellers.filter(s => s.status === "SUSPENDED").length}</span>
          </div>
        </div>

        {allSellers.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.875rem", textAlign: "center", padding: "2rem" }}>No sellers found</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {allSellers.map((seller) => {
              const orderCount = seller._count.orders;
              const isApproved = seller.status === "APPROVED";
              const statusColor = isApproved ? "#059669" : "#dc2626";
              const statusText = isApproved ? "Active" : "Suspended";

              return (
                <div key={seller.id} style={{
                  padding: "1rem",
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: "600", fontSize: "0.875rem" }}>{seller.storeName}</div>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>{seller.shopDomain}</div>
                  </div>
                  <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
                    <span style={{
                      padding: "0.25rem 0.75rem",
                      borderRadius: "9999px",
                      fontSize: "0.625rem",
                      fontWeight: "600",
                      background: isApproved ? "#d1fae5" : "#fee2e2",
                      color: isApproved ? "#059669" : "#dc2626",
                    }}>
                      {statusText}
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "#64748b" }}>({orderCount} orders)</span>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    {isApproved ? (
                      <button
                        style={{
                          padding: "0.5rem 1rem",
                          border: "1px solid #dc2626",
                          borderRadius: "6px",
                          background: "white",
                          color: "#dc2626",
                          fontSize: "0.75rem",
                          fontWeight: "500",
                          cursor: "pointer",
                          transition: "all 0.15s",
                        }}
                        onClick={() => {
                          // Would trigger suspend action
                        }}
                      >
                        Suspend
                      </button>
                    ) : (
                      <button
                        style={{
                          padding: "0.5rem 1rem",
                          border: "1px solid #059669",
                          borderRadius: "6px",
                          background: "white",
                          color: "#059669",
                          fontSize: "0.75rem",
                          fontWeight: "500",
                          cursor: "pointer",
                          transition: "all 0.15s",
                        }}
                        onClick={() => {
                          // Would trigger reactivate action
                        }}
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
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