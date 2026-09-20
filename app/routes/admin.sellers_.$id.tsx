import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireOwnerRole, assertSameOrigin, getRequestMeta } from "~/utils/ownerAuth.server";
import { getSellerDetail } from "~/services/seller.server";
import { suspendSeller, reactivateSeller } from "~/services/application.server";
import { getShopAnalytics } from "~/services/analytics.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireOwnerRole(request, ["OWNER", "OPERATIONS", "REVIEWER", "READONLY"]);
  const id = String(params.id);

  const detail = await getSellerDetail(id);
  if (!detail) {
    throw new Response("Seller not found", { status: 404 });
  }

  const analyticsDays = new URL(request.url).searchParams.get("analytics") === "90" ? 90 : 30;
  const analytics = await getShopAnalytics(detail.seller.shopDomain, analyticsDays);

  return {
    seller: detail.seller,
    application: detail.seller.application,
    orderCount: detail.orderCount,
    wholesaleRevenue: detail.wholesaleRevenue,
    history: detail.history,
    analytics,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requireOwnerRole(request, ["OWNER", "OPERATIONS"]);
  const { ip, userAgent } = getRequestMeta(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const reason = String(form.get("reason") || "").trim();
  const id = String(params.id);

  const actor = {
    actorType: "OWNER_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
  };

  try {
    if (intent === "suspend") {
      await suspendSeller(id, actor, reason || "Suspended by owner");
    } else if (intent === "reactivate") {
      await reactivateSeller(id, actor);
    } else {
      return { error: "Unknown action." };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The operation failed." };
  }

  return redirect(`/admin/sellers/${id}`);
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};
const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px 1fr",
  gap: "1rem",
  padding: "0.5rem 0",
  borderBottom: "1px solid #f1f5f9",
  fontSize: "0.85rem",
};
const keyStyle: React.CSSProperties = { color: "#64748b" };

const COVERAGE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  FULL: { bg: "#d1fae5", color: "#059669", label: "FULL" },
  PARTIAL: { bg: "#fef3c7", color: "#b45309", label: "PARTIAL" },
  PERMISSION_REQUIRED: { bg: "#dbeafe", color: "#1d4ed8", label: "PERMISSION REQUIRED" },
  NOT_CONNECTED: { bg: "#f1f5f9", color: "#64748b", label: "NOT CONNECTED" },
  ERROR: { bg: "#fee2e2", color: "#dc2626", label: "ERROR" },
};

function coverageBadge(coverage: string) {
  return COVERAGE_STYLES[coverage] ?? COVERAGE_STYLES.NOT_CONNECTED;
}

function permissionGuidance(coverage: string, scopes: string[]) {
  const hasReports = scopes.includes("read_reports") || scopes.includes("write_reports");
  const hasAllOrders = scopes.includes("read_all_orders");
  const messages: string[] = [];
  if (!hasReports) {
    messages.push("read_reports is required to read sessions and visitors via ShopifyQL.");
  }
  if (coverage === "PARTIAL" && !hasAllOrders) {
    messages.push("read_all_orders is required to cover the full 90-day order history.");
  }
  return messages;
}

function val(value: unknown) {
  if (value === null || value === undefined || value === "") return <span style={{ color: "#94a3b8" }}>Unknown</span>;
  return String(value);
}

function fmtDate(value: Date | string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function markets(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function statusStyle(status: string): React.CSSProperties {
  const map: Record<string, { bg: string; color: string }> = {
    APPROVED: { bg: "#d1fae5", color: "#059669" },
    PENDING: { bg: "#fef3c7", color: "#b45309" },
    NEEDS_INFO: { bg: "#dbeafe", color: "#1d4ed8" },
    REJECTED: { bg: "#fee2e2", color: "#dc2626" },
    SUSPENDED: { bg: "#fee2e2", color: "#dc2626" },
    UNINSTALLED: { bg: "#f1f5f9", color: "#64748b" },
  };
  const s = map[status] ?? map.UNINSTALLED;
  return {
    padding: "0.25rem 0.75rem",
    borderRadius: 9999,
    fontSize: "0.625rem",
    fontWeight: 700,
    background: s.bg,
    color: s.color,
  };
}

export default function AdminSellerDetail() {
  const { seller, application, orderCount, wholesaleRevenue, history, analytics } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const isApproved = seller.status === "APPROVED";
  const badge = coverageBadge(analytics.coverage);
  const guidance = permissionGuidance(analytics.coverage, analytics.grantedScopes);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/sellers" style={{ color: "#082a4a" }}>
          &larr; All sellers
        </Link>
      </p>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        {seller.storeName}
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        {seller.shopDomain} &middot; <span style={statusStyle(seller.status)}>{seller.status}</span>
      </p>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Orders</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a" }}>{orderCount}</div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Wholesale revenue</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a" }}>
            {money(wholesaleRevenue, seller.currency)}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Last sync</div>
          <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "#082a4a" }}>
            {fmtDate(seller.lastSyncAt)}
          </div>
          <div style={{ fontSize: "0.72rem", color: "#64748b" }}>{seller.syncStatus}</div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Seller profile
        </h2>
        <div style={rowStyle}>
          <span style={keyStyle}>Store name</span>
          <span>{seller.storeName}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Shop domain</span>
          <span>{seller.shopDomainFull || seller.shopDomain}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Store URL</span>
          <span>
            {seller.storeUrl ? (
              <a href={seller.storeUrl} target="_blank" rel="noreferrer">
                {seller.storeUrl}
              </a>
            ) : (
              <span style={{ color: "#94a3b8" }}>Unknown</span>
            )}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Country / currency</span>
          <span>
            {val(seller.country)} / {val(seller.currency)}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Shopify plan</span>
          <span>{val(seller.shopifyPlan)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Created</span>
          <span>{fmtDate(seller.createdAt)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Approved</span>
          <span>{fmtDate(seller.approvedAt)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Installed</span>
          <span>{fmtDate(seller.installedAt)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Domain registered</span>
          <span>{fmtDate(seller.domainRegisteredAt)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Business start date</span>
          <span>{fmtDate(seller.businessStartDate)}</span>
        </div>
        {seller.suspendedAt ? (
          <div style={rowStyle}>
            <span style={keyStyle}>Suspended</span>
            <span>
              {fmtDate(seller.suspendedAt)}
              {seller.suspensionReason ? ` · ${seller.suspensionReason}` : ""}
            </span>
          </div>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Contact
        </h2>
        <div style={rowStyle}>
          <span style={keyStyle}>Contact name</span>
          <span>{val(seller.contactName)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Email</span>
          <span>{val(seller.contactEmail)}</span>
        </div>
        <div style={rowStyle}>
          <span style={keyStyle}>Phone</span>
          <span>{val(seller.phone)}</span>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Application history
        </h2>
        {application ? (
          <>
            <div style={rowStyle}>
              <span style={keyStyle}>Application</span>
              <span>
                <Link to={`/admin/applications/${application.id}`} style={{ color: "#082a4a", fontWeight: 600 }}>
                  {application.storeName} · {application.status} &rarr;
                </Link>
              </span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Submitted</span>
              <span>{fmtDate(application.submittedAt)}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Reviewed by</span>
              <span>{application.reviewedBy ? application.reviewedBy.name : "—"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Review date</span>
              <span>{fmtDate(application.reviewedAt)}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Product category</span>
              <span>{val(application.productCategory)}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Legal business name</span>
              <span>{val(application.legalBusinessName)}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Markets</span>
              <span>{markets(application.markets).join(", ") || "—"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>GST/HST</span>
              <span>{val(application.gstHstNumber)}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Rejection reason</span>
              <span>{val(application.rejectionReason)}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Internal notes</span>
              <span>{val(application.internalNotes)}</span>
            </div>
          </>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>
            No merchant application linked to this seller.
          </p>
        )}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Seller settings
        </h2>
        {seller.settings ? (
          <>
            <div style={rowStyle}>
              <span style={keyStyle}>Auto sync inventory</span>
              <span>{seller.settings.autoSyncInventory ? "On" : "Off"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Quantity buffer</span>
              <span>{seller.settings.quantityBuffer}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Low stock alerts</span>
              <span>{seller.settings.lowStockAlerts ? "On" : "Off"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Auto import orders</span>
              <span>{seller.settings.autoImportOrders ? "On" : "Off"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Default markup</span>
              <span>{seller.settings.defaultMarkup}%</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Estimated delivery</span>
              <span>{val(seller.settings.estimatedDeliveryMsg)}</span>
            </div>
          </>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No seller settings saved yet.</p>
        )}

        <h3 style={{ fontSize: "0.85rem", fontWeight: 600, color: "#082a4a", margin: "1rem 0 0.5rem" }}>
          Billing
        </h3>
        {seller.billingSettings ? (
          <>
            <div style={rowStyle}>
              <span style={keyStyle}>Mode</span>
              <span>{seller.billingSettings.mode}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Auto pay</span>
              <span>{seller.billingSettings.autoPayEnabled ? "On" : "Off"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Hold for review</span>
              <span>{seller.billingSettings.holdForReview ? "On" : "Off"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Auto book shipment</span>
              <span>{seller.billingSettings.autoBookShipment ? "On" : "Off"}</span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Max amount per order</span>
              <span>
                {seller.billingSettings.maxAmountPerOrder != null
                  ? money(seller.billingSettings.maxAmountPerOrder, seller.currency)
                  : "—"}
              </span>
            </div>
            <div style={rowStyle}>
              <span style={keyStyle}>Max shipping charge</span>
              <span>
                {seller.billingSettings.maxShippingCharge != null
                  ? money(seller.billingSettings.maxShippingCharge, seller.currency)
                  : "—"}
              </span>
            </div>
          </>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No billing settings saved yet.</p>
        )}

        <h3 style={{ fontSize: "0.85rem", fontWeight: 600, color: "#082a4a", margin: "1rem 0 0.5rem" }}>
          Payment methods &amp; bank accounts
        </h3>
        <div style={{ fontSize: "0.8rem", color: "#334155", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          {seller.paymentMethods.length === 0 && seller.bankAccounts.length === 0 ? (
            <span style={{ color: "#64748b" }}>None on file.</span>
          ) : null}
          {seller.paymentMethods.map((pm) => (
            <div key={pm.id}>
              Card · {pm.brand ?? pm.provider} ····{pm.last4 ?? "----"} · {pm.status}
              {pm.isDefault ? " · default" : ""}
            </div>
          ))}
          {seller.bankAccounts.map((ba) => (
            <div key={ba.id}>
              Bank · {ba.institutionName ?? ba.provider} · {ba.accountName ?? "account"} ····{ba.accountMask ?? "----"} ·{" "}
              {ba.status}
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a" }}>
            Shopify analytics — {seller.shopDomain}
          </h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Link to="?analytics=30" style={{ fontSize: "0.72rem", fontWeight: 600, color: "#082a4a" }}>
              30 days
            </Link>
            <Link to="?analytics=90" style={{ fontSize: "0.72rem", fontWeight: 600, color: "#082a4a" }}>
              90 days
            </Link>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
          <span
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: 9999,
              fontSize: "0.625rem",
              fontWeight: 700,
              background: badge.bg,
              color: badge.color,
            }}
          >
            {badge.label}
          </span>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            {analytics.from} → {analytics.to} · {analytics.timezone} · {analytics.currency} · Window: {analytics.days} days
          </span>
        </div>

        <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.75rem" }}>
          {analytics.lastSyncAt ? `Last sync ${fmtDate(analytics.lastSyncAt)}` : "Not synced"}
        </p>

        {guidance.length > 0 ? (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", padding: "0.6rem", borderRadius: 8, fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            {guidance.map((g) => (
              <div key={g}>· {g}</div>
            ))}
          </div>
        ) : null}

        {analytics.coverage === "NOT_CONNECTED" ? (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#475569", padding: "0.6rem", borderRadius: 8, fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            This shop has not connected analytics data. Order and session metrics stay unavailable — never zero — until
            the app is installed and authorized for this shop.
          </div>
        ) : null}

        {analytics.error ? (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "0.6rem", borderRadius: 8, fontSize: "0.8rem", marginBottom: "0.75rem" }}>
            {analytics.error}
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.6rem", marginBottom: "0.75rem" }}>
          {([
            ["Sales", analytics.sales, "money"],
            ["Paid orders", analytics.paidOrders, "int"],
            ["Average order value", analytics.averageOrderValue, "money"],
            ["Refund amount", analytics.refunds, "money"],
            ["Sessions", analytics.sessions, "int"],
            ["Visitors (period unique)", analytics.visitors, "int"],
            ["Avg daily visitors", analytics.averageDailyVisitors, "int"],
          ] as [string, number | null, string][]).map(([label, value, kind]) => (
            <div key={label} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem" }}>
              <div style={{ fontSize: "0.66rem", color: "#64748b" }}>{label}</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: value == null ? "#94a3b8" : "#082a4a" }}>
                {value == null ? "Unavailable" : kind === "money" ? money(value, analytics.currency) : String(value)}
              </div>
            </div>
          ))}
        </div>

        <p style={{ fontSize: "0.7rem", color: "#64748b", marginBottom: "0.5rem" }}>{analytics.salesDefinition}</p>

        {analytics.dailyTrend.length > 0 ? (
          <div style={{ fontSize: "0.72rem", color: "#334155", marginBottom: "0.5rem" }}>
            <div style={{ color: "#64748b", marginBottom: "0.25rem" }}>
              Daily trend ({analytics.dailyTrend.length} day(s) with paid orders)
            </div>
            {analytics.dailyTrend.map((d) => (
              <div key={d.date}>
                {d.date}: {money(d.sales, analytics.currency)} · {d.orders} orders
              </div>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
            No daily paid-order trend available for this window.
          </p>
        )}

        <div style={{ fontSize: "0.7rem", color: "#64748b" }}>
          <div>Granted scopes: {analytics.grantedScopes.length ? analytics.grantedScopes.join(", ") : "unavailable"}</div>
          {analytics.notes.map((n) => (
            <div key={n}>· {n}</div>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Seller actions
        </h2>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          {isApproved ? (
            <>
              <div style={{ flex: 1, minWidth: 260 }}>
                <label
                  htmlFor="suspension-reason"
                  style={{ display: "block", fontSize: "0.72rem", color: "#64748b", marginBottom: "0.25rem" }}
                >
                  Suspension reason
                </label>
                <input
                  id="suspension-reason"
                  name="reason"
                  style={{ width: "100%", padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, boxSizing: "border-box" }}
                />
              </div>
              <button type="submit" name="intent" value="suspend" style={btn("#dc2626")}>
                Suspend seller
              </button>
            </>
          ) : (
            <button type="submit" name="intent" value="reactivate" style={btn("#059669")}>
              Reactivate seller
            </button>
          )}
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Seller &amp; application history
        </h2>
        {history.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No decisions recorded yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {history.map((h) => (
              <div key={h.id} style={{ fontSize: "0.78rem", color: "#334155" }}>
                <span style={{ color: "#94a3b8" }}>{fmtDate(h.createdAt)}</span> · <strong>{h.action}</strong> by{" "}
                {h.actorName || h.actorId} ({h.actorType})
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    padding: "0.6rem 1rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: "white",
    color,
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}
