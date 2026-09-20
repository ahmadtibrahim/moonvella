import { Outlet, Link, useLocation } from "react-router";
import { useLoaderData } from "react-router";
import { requireOwnerAuth } from "~/utils/ownerAuth.server";

export async function loader({ request }: { request: Request }) {
  const { requireOwnerAuth: requireAuth } = await import("~/utils/ownerAuth.server");
  const user = await requireAuth(request as any);
  return { user };
}

const navigation = [
  { href: "/admin", label: "Dashboard", icon: "📊" },
  { href: "/admin/applications", label: "Applications", icon: "📋" },
  { href: "/admin/sellers", label: "Sellers", icon: "🏪" },
  { href: "/admin/rankings", label: "Rankings", icon: "📈" },
  { href: "/admin/products", label: "Products", icon: "📦" },
  { href: "/admin/orders", label: "Orders", icon: "📋" },
  { href: "/admin/shipping", label: "Shipping", icon: "🚚" },
  { href: "/admin/settings", label: "Settings", icon: "⚙️" },
  { href: "/admin/audit", label: "Audit Log", icon: "📜" },
];

function AdminLayout() {
  const { user } = useLoaderData();
  const location = useLocation();

  const navigation = [
    { href: "/admin", label: "Dashboard", icon: "📊" },
    { href: "/admin/applications", label: "Applications", icon: "📋" },
    { href: "/admin/sellers", label: "Sellers", icon: "🏪" },
    { href: "/admin/rankings", label: "Rankings", icon: "📈" },
    { href: "/admin/products", label: "Products", icon: "📦" },
    { href: "/admin/orders", label: "Orders", icon: "📋" },
    { href: "/admin/shipping", label: "Shipping", icon: "🚚" },
    { href: "/admin/settings", label: "Settings", icon: "⚙️" },
    { href: "/admin/audit", label: "Audit Log", icon: "📜" },
  ];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#f6f8fb" }}>
      <aside style={{
        width: "260px",
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
      }}>
        <div style={{ padding: "0 1rem 1.5rem", borderBottom: "1px solid rgba(255,255,255,0.1)", marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "1.25rem", fontWeight: "700", marginBottom: "0.25rem" }}>MoonVella</div>
          <div style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Admin Panel</div>
        </div>

        <nav style={{ flex: 1 }}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {navigation.map((item) => {
              const isActive = location.pathname === item.href || location.pathname.startsWith(item.href + "/");
              return (
                <li key={item.href} style={{ marginBottom: "0.25rem" }}>
                  <a
                    href={item.href}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.75rem 1rem",
                      borderRadius: "8px",
                      color: location.pathname === item.href || location.pathname.startsWith(item.href + "/") ? "white" : "rgba(255,255,255,0.7)",
                      background: location.pathname === item.href || location.pathname.startsWith(item.href + "/") ? "rgba(255,255,255,0.1)" : "transparent",
                      textDecoration: "none",
                      fontSize: "0.875rem",
                      fontWeight: location.pathname === item.href || location.pathname.startsWith(item.href + "/") ? "600" : "500",
                      borderRadius: "8px",
                      transition: "all 0.15s",
                    }}
                  >
                    <span style={{ fontSize: "1.125rem" }}>{item.icon}</span>
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div style={{ paddingTop: "1.5rem", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem", color: "rgba(255,255,255,0.6)", fontSize: "0.75rem" }}>
            <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.875rem" }}>
              A
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: "500", color: "white" }}>Admin</div>
              <div style={{ fontSize: "0.625rem", color: "rgba(255,255,255,0.4)" }}>Owner</div>
            </div>
            <a href="/admin/logout" style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.75rem", textDecoration: "none", marginLeft: "auto" }}>Logout</a>
          </div>
        </div>
      </aside>

      <main style={{
        flex: 1,
        marginLeft: "260px",
        padding: "2rem",
        background: "#f6f8fb",
        minHeight: "100vh",
      }}>
        <Outlet />
      </main>
    </div>
  );
}

export default function AdminLayout() {
  return <AdminLayout />;
}