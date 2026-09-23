import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { getSellerDetail } from "~/services/seller.server";
import {
  blockSeller,
  deactivateSeller,
  reactivateSeller,
  suspendSeller,
  unblockSeller,
} from "~/services/application.server";
import { JOB_KIND, describeJob, enqueueJob, jobKey, openJobsFor } from "~/services/jobs.server";
import { archiveCounts, archiveWorklist, resetFailedArchives } from "~/services/productArchive.server";
import { financialActionHold } from "~/services/odooContacts.server";
import { BlockControl } from "~/components/store/BlockControl";
import { getShopAnalytics } from "~/services/analytics.server";
import {
  AccountingUnconnectedNotice,
  BalancesPanel,
  CommunicationsPanel,
  LedgerPanel,
  UninvoicedPanel,
} from "~/components/store/accounting";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "merchants.view");
  const id = String(params.id);

  const detail = await getSellerDetail(id);
  if (!detail) {
    throw new Response("Store not found", { status: 404 });
  }

  const url = new URL(request.url);
  const analyticsDays = url.searchParams.get("analytics") === "90" ? 90 : 30;
  const analytics = await getShopAnalytics(detail.seller.shopDomain, analyticsDays);

  const done = url.searchParams.get("done") || "";

  /*
   * The state of the seller's two integrations with the outside world.
   *
   * Both are read here rather than only after an action, because both are
   * things that happen without anybody pressing anything on this page: a
   * contact sync runs when an application is approved, and an archive run
   * follows a block. An owner looking at a store needs to see what those did,
   * including the failures, without having to go looking for them.
   */
  const [contactMappings, jobs, archives] = await Promise.all([
    prisma.externalContactMapping.findMany({
      where: { sellerId: id },
      orderBy: { role: "asc" },
    }),
    openJobsFor({ sellerId: id }, 10),
    archiveCounts(id),
  ]);
  const archiveList = archives.total > 0 ? await archiveWorklist(id, 25) : [];
  const financialHold = await financialActionHold(id);

  return {
    done: DONE_MESSAGES[done] ?? "",
    seller: detail.seller,
    application: detail.seller.application,
    orderCount: detail.orderCount,
    wholesaleRevenue: detail.wholesaleRevenue,
    history: detail.history,
    analytics,
    contactMappings,
    jobs: jobs.map((job) => ({ ...job, description: describeJob(job) })),
    archives,
    archiveList,
    financialHold,
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "merchants.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const reason = String(form.get("reason") || "").trim();
  const id = String(params.id);

  const actor = {
    actorType: "ADMIN_USER" as const,
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
    } else if (intent === "block") {
      // The modal asks for its own reason; the box above belongs to Deactivate.
      // Both are in this form, so the block reads its own field first.
      const blockReason = String(form.get("blockReason") || "").trim();
      await blockSeller(id, actor, blockReason || reason || "Blocked by owner");
    } else if (intent === "unblock") {
      await unblockSeller(id, actor);
    } else if (intent === "deactivate") {
      await deactivateSeller(id, actor, reason || "Deactivated by owner");
    } else if (intent === "retry-contact-sync") {
      await retryContactSync(id);
    } else if (intent === "retry-archives") {
      await retryArchives(id);
    } else {
      return { error: "Unknown action." };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The operation failed." };
  }

  return redirect(`/admin/stores/${id}?done=${intent}`);
}

/**
 * Queue the contact sync again, at the owner's request.
 *
 * The job carries the seller's CURRENT access version. Queueing it with a stale
 * one would be self-defeating: the runner cancels jobs whose version no longer
 * matches, so the retry would be refused before it ran and look like the button
 * does nothing.
 */
async function retryContactSync(sellerId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { accessVersion: true },
  });
  if (!seller) throw new Error("Seller not found");

  await enqueueJob({
    kind: JOB_KIND.ODOO_CONTACT_SYNC,
    idempotencyKey: jobKey(JOB_KIND.ODOO_CONTACT_SYNC, sellerId),
    sellerId,
    sellerAccessVersion: seller.accessVersion,
    payload: { sellerId },
  });
}

/** Re-queue the archives that failed, then let the runner pick them up. */
async function retryArchives(sellerId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { accessVersion: true },
  });
  if (!seller) throw new Error("Seller not found");

  // Refuses unless the store is blocked, which is the same rule the archive
  // handler enforces: a store that is not blocked must not have its catalogue
  // archived, however the button was reached.
  await resetFailedArchives(sellerId);
  await enqueueJob({
    kind: JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS,
    idempotencyKey: jobKey(JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS, sellerId),
    sellerId,
    sellerAccessVersion: seller.accessVersion,
    payload: { sellerId },
  });
}

const DONE_MESSAGES: Record<string, string> = {
  suspend: "Store suspended. It keeps its history and its orders are unaffected.",
  deactivate:
    "Store deactivated. Approved access is revoked, the application is shown to the store again, and its orders and accounting history are untouched.",
  "retry-contact-sync": "Contact sync queued. It will run on the next tick of the job runner.",
  "retry-archives": "Failed archives queued again. They will run on the next tick of the job runner.",
  reactivate: "Store activated. It can sign in and order again.",
  block:
    "Store blocked. It has lost pricing, imports, order sync and its order history; MoonVella has kept all of them.",
  unblock: "Block lifted. The store is back to the status it held before it was blocked.",
};

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
    DEACTIVATED: { bg: "#ffedd5", color: "#b45309" },
    BLOCKED: { bg: "#7f1d1d", color: "#fef2f2" },
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

const ROLE_LABELS: Record<string, string> = {
  COMPANY: "Company contact",
  CONTACT: "Contact person",
  URGENT_CONTACT: "Urgent orders line",
};

/** The same badge vocabulary for sync state and archive state. */
function syncStyle(status: string): React.CSSProperties {
  const map: Record<string, { bg: string; color: string }> = {
    SYNCED: { bg: "#d1fae5", color: "#059669" },
    ARCHIVED: { bg: "#d1fae5", color: "#059669" },
    PENDING: { bg: "#fef3c7", color: "#b45309" },
    FAILED: { bg: "#fee2e2", color: "#dc2626" },
    NOT_REQUIRED: { bg: "#f1f5f9", color: "#64748b" },
  };
  const s = map[status] ?? map.NOT_REQUIRED;
  return {
    padding: "0.15rem 0.5rem",
    borderRadius: 9999,
    fontSize: "0.62rem",
    fontWeight: 700,
    background: s.bg,
    color: s.color,
  };
}

export default function AdminStoreDetail() {
  const {
    seller,
    application,
    orderCount,
    wholesaleRevenue,
    history,
    analytics,
    done,
    contactMappings,
    jobs,
    archives,
    archiveList,
    financialHold,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const isApproved = seller.status === "APPROVED";
  const isBlocked = seller.status === "BLOCKED";
  const badge = coverageBadge(analytics.coverage);
  const guidance = permissionGuidance(analytics.coverage, analytics.grantedScopes);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/stores" style={{ color: "#082a4a" }}>
          &larr; All stores
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

      {done ? (
        <div
          role="status"
          style={{ ...card, background: "#f0fdf4", borderColor: "#bbf7d0", color: "#065f46", fontSize: "0.85rem" }}
        >
          {done}
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

      {/*
        The account comes before the paperwork. The question that brings someone
        to a store's page is almost always about money — what is owed, what has
        been paid, what was said about it — and the profile, the application and
        the connection settings are answers to questions asked less often.
      */}
      <AccountingUnconnectedNotice currency={seller.currency ?? "CAD"} />
      <BalancesPanel
        currency={seller.currency ?? "CAD"}
        liveOrders={orderCount}
        liveRevenue={wholesaleRevenue}
      />
      <LedgerPanel currency={seller.currency ?? "CAD"} />
      <UninvoicedPanel currency={seller.currency ?? "CAD"} />
      <CommunicationsPanel />

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Store profile
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
        {/* Shown even when the block has been lifted is NOT the behaviour here:
            unblocking clears both columns, so this row exists only while the
            store is actually blocked. The history of both events is in the
            audit log below, which is append-only. */}
        {seller.blockedAt ? (
          <div style={rowStyle}>
            <span style={keyStyle}>Blocked</span>
            <span>
              {fmtDate(seller.blockedAt)}
              {seller.blockReason ? ` · ${seller.blockReason}` : ""}
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
          Store settings
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
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No store settings saved yet.</p>
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

      {/*
        Odoo contact mapping. Three roles, each with its own record and its own
        outcome, because they are three different writes: the company, the named
        contact, and the urgent orders line. Showing them together as one
        "synced" tick would hide which one actually failed.
      */}
      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.25rem" }}>
          Odoo contact
        </h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.75rem", lineHeight: 1.5 }}>
          The company contact is written when an application is approved. Later approvals, retries
          and reapplications update the same records — the mapping below is what makes that true.
          {financialHold ? (
            <>
              {" "}
              <strong style={{ color: "#b45309" }}>Financial actions are held for this store:</strong>{" "}
              {financialHold}
            </>
          ) : (
            " Financial actions are not held: the customer record exists in Odoo."
          )}
        </p>

        {contactMappings.length === 0 ? (
          <p style={{ fontSize: "0.8rem", color: "#64748b" }}>
            No contact sync has been attempted for this store yet.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.75rem" }}>
            {contactMappings.map((mapping) => (
              <div key={mapping.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "#334155" }}>
                    {ROLE_LABELS[mapping.role] ?? mapping.role}
                  </span>
                  <span style={syncStyle(mapping.status)}>{mapping.status}</span>
                  {mapping.odooPartnerId ? (
                    <span style={{ fontSize: "0.72rem", color: "#475569" }}>
                      Odoo partner {mapping.odooPartnerId}
                      {mapping.odooName ? ` — ${mapping.odooName}` : ""}
                    </span>
                  ) : null}
                  {mapping.odooTagId ? (
                    <span style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                      tag {mapping.odooTagId} applied
                    </span>
                  ) : null}
                  <span style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                    {mapping.attempts} attempt(s)
                    {mapping.syncedAt ? ` · synced ${fmtDate(mapping.syncedAt)}` : ""}
                    {mapping.lastAttemptAt && !mapping.syncedAt
                      ? ` · last tried ${fmtDate(mapping.lastAttemptAt)}`
                      : ""}
                  </span>
                </div>
                {mapping.lastError ? (
                  <div style={{ fontSize: "0.72rem", color: "#b91c1c", marginTop: "0.3rem" }}>
                    {mapping.lastError}
                  </div>
                ) : null}
                <div style={{ fontSize: "0.68rem", color: "#94a3b8", marginTop: "0.3rem" }}>
                  Store {mapping.storeName ?? "—"} · Shopify shop {mapping.shopifyShopId ?? "—"} ·{" "}
                  {mapping.myshopifyDomain ?? "—"}
                </div>
              </div>
            ))}
          </div>
        )}

        {jobs.length > 0 ? (
          <div style={{ fontSize: "0.72rem", color: "#475569", marginBottom: "0.6rem" }}>
            <div style={{ color: "#64748b", marginBottom: "0.2rem" }}>Queued work</div>
            {jobs.map((job) => (
              <div key={job.id}>
                · <strong>{job.kind}</strong> — {job.description}
              </div>
            ))}
          </div>
        ) : null}

        <Form method="post">
          <button type="submit" name="intent" value="retry-contact-sync" style={btn("#1d4ed8")}>
            Sync contact now
          </button>
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.25rem" }}>
          Catalogue archiving
        </h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.75rem", lineHeight: 1.5 }}>
          When a store is blocked, the products MoonVella imported into its Shopify store are
          archived — set aside, never deleted. Only products with a recorded import mapping are
          touched; nothing is matched by title, vendor or tag. Products are not republished if the
          block is later lifted.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: "0.6rem",
            marginBottom: "0.75rem",
          }}
        >
          {(
            [
              ["Archived", archives.archived, "#059669"],
              ["Pending", archives.pending, "#b45309"],
              ["Failed", archives.failed, "#dc2626"],
              ["Imported products", archives.total, "#334155"],
            ] as [string, number, string][]
          ).map(([label, value, color]) => (
            <div key={label} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem" }}>
              <div style={{ fontSize: "0.66rem", color: "#64748b" }}>{label}</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>

        {archiveList.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginBottom: "0.75rem" }}>
            {archiveList.map((item) => (
              <div key={item.id} style={{ fontSize: "0.74rem", color: "#334155" }}>
                <span style={syncStyle(item.status === "ARCHIVED" ? "SYNCED" : item.status === "FAILED" ? "FAILED" : "PENDING")}>
                  {item.status}
                </span>{" "}
                {item.name}
                <span style={{ color: "#94a3b8" }}>
                  {" "}
                  · {item.attempts} attempt(s)
                  {item.lastError ? ` · ${item.lastError}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {isBlocked ? (
          <Form method="post">
            <button type="submit" name="intent" value="retry-archives" style={btn("#1d4ed8")}>
              Retry failed archives
            </button>
          </Form>
        ) : (
          <p style={{ fontSize: "0.72rem", color: "#64748b" }}>
            Archiving runs when a store is blocked, so there is nothing to retry while this store is{" "}
            {seller.status}.
          </p>
        )}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.25rem" }}>
          Store controls
        </h2>
        <p style={{ fontSize: "0.78rem", color: "#64748b", marginBottom: "0.85rem", lineHeight: 1.5 }}>
          Three refusals, and they differ in who reopens the store. <strong>Suspending</strong>{" "}
          pauses it and signs it out; it keeps read access to what it already sold, and Activating
          reverses it — the store is not asked to do anything. <strong>Deactivating</strong> revokes
          approved access too, but the store reopens it by applying again: the application is shown
          prefilled and a resubmission returns to review. <strong>Blocking</strong> refuses the store
          outright — no wholesale pricing, no imports, no new orders, no product sync and no order
          history either — and archives the products MoonVella imported into its Shopify store. Every
          record stays here, with MoonVella, in all three cases; unblocking returns the store to the
          status it held before it was blocked, and never republishes its catalogue.
        </p>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          {isApproved ? (
            <>
              <div style={{ flex: 1, minWidth: 260 }}>
                <label
                  htmlFor="suspension-reason"
                  style={{ display: "block", fontSize: "0.72rem", color: "#64748b", marginBottom: "0.25rem" }}
                >
                  Reason (recorded against whichever control you use)
                </label>
                <input
                  id="suspension-reason"
                  name="reason"
                  style={{ width: "100%", padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, boxSizing: "border-box" }}
                />
              </div>
              <button type="submit" name="intent" value="suspend" style={btn("#dc2626")}>
                Suspend store
              </button>
              <button type="submit" name="intent" value="deactivate" style={btn("#b45309")}>
                Deactivate store (may reapply)
              </button>
            </>
          ) : isBlocked ? null : (
            <button type="submit" name="intent" value="reactivate" style={btn("#059669")}>
              {seller.status === "SUSPENDED" ? "Activate store" : "Activate this store"}
            </button>
          )}
          {/* The reason box above belongs to Deactivate and is only drawn for an
              approved store, so the modal asks for its own. */}
          <BlockControl status={seller.status} />
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Store &amp; application history
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
