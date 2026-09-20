import "../styles/admin.css";
import { Outlet, useLoaderData, useLocation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireOwnerAuth(request);
  return { user: { name: user.name, email: user.email, role: user.role } };
}

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: "D" },
  { href: "/admin/applications", label: "Applications", icon: "A" },
  { href: "/admin/sellers", label: "Sellers", icon: "S" },
  { href: "/admin/rankings", label: "Rankings", icon: "R" },
  { href: "/admin/products", label: "Products", icon: "P" },
  { href: "/admin/orders", label: "Orders", icon: "O" },
  { href: "/admin/shipping", label: "Shipping", icon: "H" },
  { href: "/admin/settings", label: "Settings", icon: "G" },
  { href: "/admin/audit", label: "Audit Log", icon: "L" },
];

export default function AdminLayout() {
  const { user } = useLoaderData<typeof loader>();
  const location = useLocation();

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#f6f8fb" }}>
      <aside
        style={{
          width: 260,
          background: "#082a4a",
          color: "white",
          padding: "1.5rem 1rem",
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          position: "fixed",
          left: 0,
          top: 0,
          zIndex: 50,
        }}
      >
        <div
          style={{
            padding: "0 1rem 1.5rem",
            borderBottom: "1px solid rgba(255,255,255,0.1)",
            marginBottom: "1.5rem",
          }}
        >
          <div style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            MoonVella
          </div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "rgba(255,255,255,0.5)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Admin Panel
          </div>
        </div>

        <nav style={{ flex: 1 }}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {NAV_ITEMS.map((item) => {
              const isActive =
                location.pathname === item.href ||
                location.pathname.startsWith(item.href + "/");
              return (
                <li key={item.href} style={{ marginBottom: "0.25rem" }}>
                  <a
                    href={item.href}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.75rem 1rem",
                      color: isActive ? "white" : "rgba(255,255,255,0.7)",
                      background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
                      textDecoration: "none",
                      fontSize: "0.875rem",
                      fontWeight: isActive ? 600 : 500,
                      borderRadius: 8,
                    }}
                  >
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: "rgba(255,255,255,0.12)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "0.7rem",
                        fontWeight: 700,
                      }}
                    >
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div style={{ paddingTop: "1.5rem", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.75rem",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: "rgba(255,255,255,0.1)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.875rem",
              }}
            >
              {user?.name?.charAt(0)?.toUpperCase() || "O"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, color: "white", fontSize: "0.8rem" }}>
                {user?.name || "Owner"}
              </div>
              <div style={{ fontSize: "0.625rem", color: "rgba(255,255,255,0.4)" }}>
                {user?.role || "OWNER"}
              </div>
            </div>
            <form method="post" action="/admin/logout" style={{ margin: 0 }}>
              <button
                type="submit"
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(255,255,255,0.6)",
                  fontSize: "0.75rem",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Logout
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main
        style={{
          flex: 1,
          marginLeft: 260,
          padding: "2rem",
          background: "#f6f8fb",
          minHeight: "100vh",
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
