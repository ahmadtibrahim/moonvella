import "../styles/admin.css";
import { Outlet, useLoaderData, useLocation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireAuth, userCan } from "~/utils/adminAuth.server";
import { can, type Permission } from "~/services/permissions";
import type { AdminRole } from "@prisma/client";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAuth(request);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isPrimaryOwner: user.isPrimaryOwner,
    },
  };
}

/**
 * Navigation, gated per entry.
 *
 * Hiding a link is presentation, not authorisation — every one of these routes
 * enforces its own permission in its loader and would return 403 if reached
 * directly. The gate here exists so an OPERATIONS user is not shown a door that
 * only ever opens onto an error.
 */
const NAV_ITEMS: { href: string; label: string; icon: string; permission?: Permission }[] = [
  { href: "/admin", label: "Dashboard", icon: "D", permission: "dashboard.view" },
  { href: "/admin/applications", label: "Applications", icon: "A", permission: "merchants.view" },
  { href: "/admin/stores", label: "Stores", icon: "S", permission: "merchants.view" },
  { href: "/admin/rankings", label: "Rankings", icon: "R", permission: "reports.view" },
  { href: "/admin/products", label: "Products", icon: "P", permission: "products.view" },
  { href: "/admin/orders", label: "Orders", icon: "O", permission: "orders.view" },
  { href: "/admin/shipping", label: "Shipping", icon: "H", permission: "shipping.view" },
  { href: "/admin/users", label: "Users", icon: "U", permission: "users.view" },
  // Settings has no permission gate: every signed-in user needs it to change
  // their own password. The sections inside it are gated individually.
  { href: "/admin/settings", label: "Settings", icon: "G" },
  { href: "/admin/audit", label: "Audit Log", icon: "L", permission: "audit.view" },
];

const ROLE_LABEL: Record<AdminRole, string> = {
  OWNER: "Owner",
  ADMIN: "Administrator",
  OPERATIONS: "Operations",
  CATALOG: "Catalog",
  SUPPORT: "Support",
  VIEWER: "Viewer",
};

export default function AdminLayout() {
  const { user } = useLoaderData<typeof loader>();
  const location = useLocation();

  const visible = NAV_ITEMS.filter(
    (item) => !item.permission || can(user.role, item.permission)
  );

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

        <nav style={{ flex: 1, overflowY: "auto" }}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {visible.map((item) => {
              const isActive =
                location.pathname === item.href ||
                (item.href !== "/admin" && location.pathname.startsWith(item.href + "/"));
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
              {user?.name?.charAt(0)?.toUpperCase() || "?"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 500,
                  color: "white",
                  fontSize: "0.8rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {user?.name || "User"}
              </div>
              <div style={{ fontSize: "0.625rem", color: "rgba(255,255,255,0.4)" }}>
                {user?.isPrimaryOwner ? "Primary Owner" : ROLE_LABEL[user?.role as AdminRole] || user?.role}
              </div>
            </div>
            {/* Logout is a POST: a link would be a state change a cross-site
                image tag could trigger. */}
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
        {/* Required by the controlled-testing phase: this panel is connected to
            Shopify development stores only. The banner is a reminder, not a
            control — the real protection is that no production credential is
            configured and the Odoo connector is not enabled. */}
        <div
          role="status"
          style={{
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            color: "#92400e",
            borderRadius: 8,
            padding: "0.6rem 0.9rem",
            marginBottom: "1.5rem",
            fontSize: "0.8rem",
            fontWeight: 600,
            letterSpacing: "0.01em",
          }}
        >
          TEST MODE — NO REAL PAYMENT OR FULFILLMENT
        </div>
        <Outlet />
      </main>
    </div>
  );
}
