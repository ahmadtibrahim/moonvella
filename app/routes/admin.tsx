import "../styles/admin.css";
import { Form, Link, Outlet, useLoaderData, useLocation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireAuth } from "~/utils/adminAuth.server";
import { can, type Permission } from "~/services/permissions";
import { getBrandView } from "~/services/branding.server";
import type { AdminRole } from "@prisma/client";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAuth(request);
  /*
   * The brand, on every admin request.
   *
   * Two small indexed reads, and deliberately NOT cached in a module-level
   * variable: a logo replaced five seconds ago has to be what the next page load
   * shows, or the operator presses Replace, still sees the old mark, and
   * concludes the upload failed. The URL carries the checksum of its bytes, so
   * the BROWSER still caches the images — only the lookup repeats.
   */
  const brand = await getBrandView();
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isPrimaryOwner: user.isPrimaryOwner,
    },
    brand: {
      displayName: brand.displayName,
      // The square icon, when there is one, is the right shape for the sidebar's
      // mark slot; otherwise the typographic initial stands in.
      mark: brand.slots.find((entry) => entry.slot === "SQUARE")?.live?.url ?? null,
      // The dark-background variant, which is the whole reason the slot exists:
      // a navy logo on the navy sidebar is an invisible logo.
      dark: brand.slots.find((entry) => entry.slot === "DARK")?.live?.url ?? null,
      primary: brand.slots.find((entry) => entry.slot === "PRIMARY")?.live?.url ?? null,
    },
  };
}

/**
 * The navigation icon, by name.
 *
 * THESE USED TO BE SINGLE LETTERS — "D" for Dashboard, "S" for Stores — drawn
 * inside a tinted tile. A letter is not an icon: it is a second, worse label
 * sitting beside the real one, it means nothing until it has been learned, and
 * ten of them in a column read as a wordsearch. These are line icons at the
 * same weight and size, drawn from `currentColor` so they inherit the link's
 * colour and its active state without a second rule.
 */
type NavIcon =
  | "dashboard" | "stores" | "catalog" | "orders" | "shipping" | "returns"
  | "invoices" | "bills" | "billing" | "rankings" | "users" | "settings" | "audit";

type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  permission?: Permission;
  activePrefixes?: string[];
};

type NavGroup = { label?: string; items: NavItem[] };

/** Related queues live as tabs inside one operational workspace. */
const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: "/admin", label: "Dashboard", icon: "dashboard", permission: "dashboard.view" },
      { href: "/admin/stores", label: "Stores", icon: "stores", permission: "merchants.view", activePrefixes: ["/admin/applications"] },
      { href: "/admin/products", label: "Catalog", icon: "catalog", permission: "products.view", activePrefixes: ["/admin/packaging", "/admin/odoo"] },
      { href: "/admin/orders", label: "Orders", icon: "orders", permission: "orders.view", activePrefixes: ["/admin/fulfillment"] },
      { href: "/admin/shipping", label: "Shipping", icon: "shipping", permission: "shipping.view", activePrefixes: ["/admin/pickups", "/admin/origins"] },
      { href: "/admin/returns", label: "Returns & claims", icon: "returns", permission: "shipping.view", activePrefixes: ["/admin/claims"] },
      /*
       * ACCOUNTING IS THREE PAGES, AND THEY ARE ONE SECTION.
       *
       * Invoices are what MoonVella billed; Customers is who owes it and how old
       * it is; Bills is what MoonVella itself owes. They are separate routes
       * because they answer different questions, and one entry because an
       * operator moving between them is doing one job.
       *
       * `finance.view` rather than `orders.view`: balances and statements are
       * financial data, and the roles that see orders are not all roles that
       * should see the ledger. The old Billing entry pointed at
       * `/admin/payments`, which still exists for the Stripe charge history —
       * it is listed under it rather than replacing it.
       */
      { href: "/admin/invoices", label: "Invoices", icon: "invoices", permission: "finance.view", activePrefixes: ["/admin/customers"] },
      { href: "/admin/bills", label: "Bills & expenses", icon: "bills", permission: "finance.view" },
      { href: "/admin/payments", label: "Billing", icon: "billing", permission: "orders.view" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/admin/rankings", label: "Rankings", icon: "rankings", permission: "reports.view" },
      { href: "/admin/users", label: "Users", icon: "users", permission: "users.view" },
      { href: "/admin/settings", label: "Settings", icon: "settings" },
      { href: "/admin/audit", label: "Audit", icon: "audit", permission: "audit.view" },
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
  const { user, brand } = useLoaderData<typeof loader>();
  const { pathname } = useLocation();

  return (
    <div className="mv-admin-shell">
      <aside className="mv-admin-sidebar">
        <Link to="/admin" className="mv-admin-brand" aria-label={`${brand.displayName} admin home`}>
          {/*
            The uploaded mark when there is one, the initial when there is not.
            Both live in the same box so the sidebar's layout does not shift when
            a logo is uploaded — a nav that reflows on a branding change is a nav
            that looks broken at the moment the operator is looking at it.

            The dark-background variant is used when it exists; otherwise the
            primary logo goes on a white backing, because a navy mark on a navy
            bar is a blank space.
          */}
          <span className="mv-admin-brand-mark">
            {brand.dark ? (
              <img src={brand.dark} alt="" className="mv-admin-brand-img" />
            ) : brand.mark ? (
              <img src={brand.mark} alt="" className="mv-admin-brand-img mv-admin-brand-img-backing" />
            ) : (
              brand.displayName.slice(0, 1).toUpperCase()
            )}
          </span>
          <span className="mv-admin-brand-copy">
            <strong>{brand.displayName}</strong>
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
                      <span className="mv-admin-nav-icon" aria-hidden="true">
                        <NavGlyph name={item.icon} />
                      </span>
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
            <span aria-hidden="true" /> TEST MODE
          </div>
        </header>
        <div className="mv-admin-content">
          <div className="mv-admin-test-banner" role="status">
            TEST MODE — no real payment or fulfillment
          </div>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/**
 * The line icons, one path per navigation item.
 *
 * 24×24 with a 1.75 stroke and round joins, so they sit on the same optical
 * weight as the 15px label beside them. Drawn with `stroke="currentColor"` and
 * no `fill`, which is what lets a single rule colour them for the resting and
 * the selected state instead of one rule per state per icon.
 *
 * `aria-hidden` on the wrapper, because every one of these sits directly beside
 * the word it stands for — a screen reader announcing "Dashboard, dashboard" is
 * worse than it announcing one of them.
 */
function NavGlyph({ name }: { name: NavIcon }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const paths: Record<NavIcon, React.ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
    stores: <><path d="M3 9.5 5 4h14l2 5.5" /><path d="M4 9.5h16V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M9.5 20v-5.5h5V20" /></>,
    catalog: <><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14z" /></>,
    orders: <><path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14.5 3v4.5H19" /><path d="M8.5 12.5h7M8.5 16h4.5" /></>,
    shipping: <><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></>,
    returns: <><path d="M3.5 8.5h13a4 4 0 0 1 0 8H8" /><path d="M7 5 3.5 8.5 7 12" /></>,
    invoices: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9.5 8.5h5M9.5 12.5h5" /></>,
    bills: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H18v16H6.5A2.5 2.5 0 0 1 4 17.5z" /><path d="M8 9h6M8 13h6" /></>,
    billing: <><rect x="2.5" y="5.5" width="19" height="13" rx="2.5" /><path d="M2.5 10h19" /><path d="M6.5 14.5h3" /></>,
    rankings: <><path d="M4.5 20V11M10.5 20V4M16.5 20v-6" /><path d="M20 20H4" /></>,
    users: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.3M17.6 15.2l2.2 1.3M4.2 16.5l2.2-1.3M17.6 8.8l2.2-1.3" /></>,
    audit: <><path d="M12 3 4.5 6v6c0 4.4 3.1 7.9 7.5 9 4.4-1.1 7.5-4.6 7.5-9V6z" /><path d="M9 12.2l2.2 2.2L15.5 10" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}
