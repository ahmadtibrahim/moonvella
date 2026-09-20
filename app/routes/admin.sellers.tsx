import { Link, useLoaderData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerAuth(request);

  const [sellers, pendingCount] = await Promise.all([
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

  return { sellers, pendingCount };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireOwnerAuth(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const sellerId = String(formData.get("sellerId") || "");

  if (!sellerId) {
    return { error: "Missing seller id." };
  }

  if (intent === "suspend") {
    await prisma.seller.update({
      where: { id: sellerId },
      data: { status: "SUSPENDED", suspendedAt: new Date() },
    });
  } else if (intent === "reactivate") {
    await prisma.seller.update({
      where: { id: sellerId },
      data: { status: "APPROVED", suspendedAt: null, suspensionReason: null },
    });
  }

  return redirect("/admin/sellers");
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
};

const rowStyle: React.CSSProperties = {
  padding: "1rem",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
};

export default function AdminSellers() {
  const { sellers, pendingCount } = useLoaderData<typeof loader>();

  const approved = sellers.filter((s) => s.status === "APPROVED").length;
  const suspended = sellers.filter((s) => s.status === "SUSPENDED").length;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Sellers Management
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Manage approved sellers and pending applications
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
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Sellers</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a" }}>
            {sellers.length}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Approved</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#059669" }}>
            {approved}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Suspended</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#dc2626" }}>
            {suspended}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Pending Apps</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#b45309" }}>
            {pendingCount}
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          All Sellers
        </h2>

        {sellers.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.875rem" }}>No sellers yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {sellers.map((seller) => {
              const isApproved = seller.status === "APPROVED";
              return (
                <div key={seller.id} style={rowStyle}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                      {seller.storeName}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                      {seller.shopDomain} &middot; {seller._count.orders} orders
                    </div>
                  </div>
                  <span
                    style={{
                      padding: "0.25rem 0.75rem",
                      borderRadius: 9999,
                      fontSize: "0.625rem",
                      fontWeight: 700,
                      background: isApproved ? "#d1fae5" : "#fee2e2",
                      color: isApproved ? "#059669" : "#dc2626",
                    }}
                  >
                    {seller.status}
                  </span>
                  <Form method="post">
                    <input type="hidden" name="sellerId" value={seller.id} />
                    {isApproved ? (
                      <button
                        type="submit"
                        name="intent"
                        value="suspend"
                        style={{
                          padding: "0.5rem 1rem",
                          border: "1px solid #dc2626",
                          borderRadius: 6,
                          background: "white",
                          color: "#dc2626",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Suspend
                      </button>
                    ) : (
                      <button
                        type="submit"
                        name="intent"
                        value="reactivate"
                        style={{
                          padding: "0.5rem 1rem",
                          border: "1px solid #059669",
                          borderRadius: 6,
                          background: "white",
                          color: "#059669",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Reactivate
                      </button>
                    )}
                  </Form>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin/applications" style={{ color: "#082a4a", fontWeight: 500 }}>
          Review pending applications &rarr;
        </Link>
      </p>
    </div>
  );
}
