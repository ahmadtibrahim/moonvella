import { Link, useLocation } from "react-router";

const ITEMS = [
  { href: "/admin/shipping", label: "Shipments" },
  { href: "/admin/pickups", label: "Pickups" },
  { href: "/admin/returns", label: "Returns" },
  { href: "/admin/claims", label: "Claims" },
  { href: "/admin/origins", label: "Pickup locations" },
] as const;

/** The manual logistics workspace. Every tab is a queue, not an automation. */
export function ShippingOperationsNav() {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Shipping operations" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginBottom: "1.25rem", paddingBottom: "0.75rem", borderBottom: "1px solid #dbe4ee" }}>
      {ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} to={item.href} style={{ padding: "0.55rem 0.8rem", borderRadius: 8, textDecoration: "none", fontSize: "0.78rem", fontWeight: 650, color: active ? "white" : "#334155", background: active ? "#082a4a" : "white", border: `1px solid ${active ? "#082a4a" : "#cbd5e1"}` }}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
