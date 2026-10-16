import "../styles/admin.css";
import { Form, Link, Outlet, useLoaderData, useLocation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireAuth } from "~/utils/adminAuth.server";
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
    environment: await describeEnvironment(),
  };
}

/**
 * WHAT THIS DEPLOYMENT ACTUALLY DOES, PER INTEGRATION — COMPUTED, NOT ASSERTED.
 *
 * The banner above the owner's screens was the literal string "TEST MODE — no
 * real payment or fulfillment". That is true of the card gateway and the
 * carrier and FALSE OF THE ERP: the effective Odoo mode is `live` against the
 * production database with writes permitted, because the stored credential
 * says so and ODOO_ALLOW_WRITES is set. A fixed sentence cannot be right about
 * a deployment whose integrations disagree, and the one it got wrong is the
 * one that can post to production accounting.
 *
 * So the sentence is derived from the switches the code itself enforces — the
 * connector's own mode classifier, the card key's own live/test prefix, the
 * carrier host actually configured — and it names the integration that is NOT
 * in test mode. A banner that cannot disagree with enforcement is the only kind
 * worth putting in front of an operator.
 */
async function describeEnvironment() {
  const { odooMode } = await import("~/services/odoo.server");
  const { stripeSecretKey, getCredentials } = await import("~/services/credentials.server");

  const [mode, stripeKey, eship] = await Promise.all([
    odooMode().catch(() => "disabled" as const),
    stripeSecretKey().catch(() => null),
    getCredentials("eshipper").catch(() => ({}) as Record<string, string>),
  ]);

  const carrierHost = (eship.ESHIPPER_BASE_URL ?? process.env.ESHIPPER_BASE_URL ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  return {
    erpMode: mode,
    erpLive: mode === "live",
    stripeLive: (stripeKey ?? "").trim().startsWith("sk_live_"),
    carrierHost: carrierHost || null,
  };
}

type NavItem = {
  href: string;
  label: string;
  icon: string;
  permission?: Permission;
  activePrefixes?: string[];
};

type NavGroup = { label?: string; items: NavItem[] };

/** Related queues live as tabs inside one operational workspace. */
const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: "/admin", label: "Dashboard", icon: "D", permission: "dashboard.view" },
      { href: "/admin/stores", label: "Stores", icon: "S", permission: "merchants.view", activePrefixes: ["/admin/applications"] },
      { href: "/admin/products", label: "Catalog", icon: "C", permission: "products.view", activePrefixes: ["/admin/packaging", "/admin/odoo"] },
      { href: "/admin/orders", label: "Orders", icon: "O", permission: "orders.view", activePrefixes: ["/admin/fulfillment"] },
      { href: "/admin/shipping", label: "Shipping", icon: "H", permission: "shipping.view", activePrefixes: ["/admin/pickups", "/admin/origins"] },
      { href: "/admin/returns", label: "Returns & claims", icon: "R", permission: "shipping.view", activePrefixes: ["/admin/claims"] },
      { href: "/admin/payments", label: "Billing", icon: "B", permission: "orders.view" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/admin/rankings", label: "Rankings", icon: "R", permission: "reports.view" },
      { href: "/admin/users", label: "Users", icon: "U", permission: "users.view" },
      { href: "/admin/settings", label: "Settings", icon: "G" },
      { href: "/admin/audit", label: "Audit", icon: "A", permission: "audit.view" },
    ],
  },
];

const ROLE_LABEL: Record<AdminRole, string> = {
  OWNER: "Owner",
  ADMIN: "Administrator",
  OPERATIONS: "Operations",
  CATALOG: "Catalog",
  SUPPORT: "Support",
  VIEWER: "Viewer",
};

function navItemIsActive(pathname: string, item: NavItem) {
  if (item.href === "/admin") return pathname === "/admin";
  return [item.href, ...(item.activePrefixes ?? [])].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export default function AdminLayout() {
  const { user, environment } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();

  return (
    <div className="mv-admin-shell">
      <aside className="mv-admin-sidebar">
        <Link to="/admin" className="mv-admin-brand" aria-label="MoonVella admin home">
          <span className="mv-admin-brand-mark">M</span>
          <span className="mv-admin-brand-copy">
            <strong>MoonVella</strong>
            <small>Operations</small>
          </span>
        </Link>

        <nav className="mv-admin-navigation" aria-label="Admin navigation">
          {NAV_GROUPS.map((group, groupIndex) => {
            const visible = group.items.filter(
              (item) => !item.permission || can(user.role, item.permission)
            );
            if (!visible.length) return null;
            return (
              <div className="mv-admin-nav-group" key={group.label ?? groupIndex}>
                {group.label ? <div className="mv-admin-nav-heading">{group.label}</div> : null}
                {visible.map((item) => {
                  const active = navItemIsActive(pathname, item);
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={`mv-admin-nav-link${active ? " is-active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="mv-admin-nav-icon" aria-hidden="true">{item.icon}</span>
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="mv-admin-profile">
          <span className="mv-admin-avatar" aria-hidden="true">
            {user?.name?.charAt(0)?.toUpperCase() || "?"}
          </span>
          <span className="mv-admin-profile-copy">
            <strong>{user?.name || "User"}</strong>
            <small>{user?.isPrimaryOwner ? "Primary Owner" : ROLE_LABEL[user?.role as AdminRole] || user?.role}</small>
          </span>
          <Form method="post" action="/admin/logout">
            <button type="submit" className="mv-admin-logout">Logout</button>
          </Form>
        </div>
      </aside>

      <main className="mv-admin-main">
        <header className="mv-admin-topbar">
          <div>
            <strong>Operations</strong>
            <span>Manage catalog, orders, shipping and seller payments</span>
          </div>
          <div className="mv-admin-environment" role="status">
            <span aria-hidden="true" /> {environment.erpLive ? "ERP LIVE" : "TEST MODE"}
          </div>
        </header>
        <div className="mv-admin-content">
          {environment.erpLive ? (
            /*
             * The ERP is the one integration that is NOT sandboxed, and it is
             * the one whose mistake is a posted accounting entry. So the banner
             * leads with it rather than burying it under a blanket "TEST MODE"
             * that the reader would take as covering everything on the page.
             */
            <div className="mv-admin-test-banner" role="status" data-tone="warning">
              Odoo is <strong>LIVE</strong> — database {environment.erpMode === "live" ? "and" : ""} writes permitted.
              {environment.stripeLive ? " The card gateway is LIVE too." : " Card payments are test mode."}
              {environment.carrierHost ? ` Carrier host: ${environment.carrierHost}.` : " No carrier host is configured."}
              {" "}Anything created here can reach production accounting.
            </div>
          ) : (
            <div className="mv-admin-test-banner" role="status">
              TEST MODE — no real payment or fulfillment
            </div>
          )}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
