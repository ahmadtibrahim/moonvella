import { Link, useLoaderData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  requirePermission,
  assertSameOrigin,
  getRequestMeta,
} from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import {
  blockSeller,
  reactivateSeller,
  suspendSeller,
  unblockSeller,
} from "~/services/application.server";
import { BlockControl } from "~/components/store/BlockControl";
import {
  AccountingUnconnectedNotice,
  UnconnectedChip,
} from "~/components/store/accounting";

/**
 * Stores — the shops that sell MoonVella goods.
 *
 * This page used to be called Sellers, which named the row rather than the
 * thing: what the owner is looking at is a shop with a name, a domain and an
 * account, and "store" is the word every other screen in the panel already
 * uses (`storeName`, `storeUrl`, the store's own dashboard).
 *
 * The account columns are drawn, not read. MoonVella has no ledger; the notice
 * at the top of the page says so, and each sample figure carries its own chip.
 * The status, the order count and the controls are real and act on real rows.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "merchants.view");

  const [sellers, pendingCount] = await Promise.all([
    prisma.seller.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        storeName: true,
        shopDomain: true,
        status: true,
        suspensionReason: true,
        blockReason: true,
        currency: true,
        _count: { select: { orders: true } },
      },
    }),
    // Submitted only, for the same reason as the dashboard tile: a draft row is
    // written for every store that opens the application page.
    prisma.merchantApplication.count({
      where: { status: "PENDING", submittedAt: { not: null } },
    }),
  ]);

  const done = new URL(request.url).searchParams.get("done") || "";
  return { sellers, pendingCount, done: DONE_MESSAGES[done] ?? "" };
}

const DONE_MESSAGES: Record<string, string> = {
  suspend: "Store deactivated. It keeps its history and its orders are unaffected.",
  reactivate: "Store activated. It can sign in and order again.",
  block:
    "Store blocked. It has lost pricing, imports, order sync and its order history; MoonVella has kept all of them.",
  unblock: "Block lifted. The store is back to the status it held before it was blocked.",
};

/**
 * The four controls the owner asked for.
 *
 * Deactivate and Activate are wired to the suspension the application review
 * already uses, so a store switched off here is switched off everywhere.
 *
 * Block is the harder refusal and now a real status of its own. A suspended
 * store keeps read access to what it already sold, so a deactivation does not
 * look like data loss; a blocked one sees nothing — no pricing, no imports, no
 * new orders, no product sync, and no order history either. MoonVella keeps
 * all of it. The two are different answers to different problems, which is why
 * they are two buttons rather than one with a severity.
 */
function StoreControls({ seller }: { seller: { id: string; status: string } }) {
  const suspended = seller.status === "SUSPENDED";
  const approved = seller.status === "APPROVED";
  const blocked = seller.status === "BLOCKED";

  return (
    <Form method="post" style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
      <input type="hidden" name="sellerId" value={seller.id} />
      {approved ? (
        <>
          <input
            type="text"
            name="reason"
            placeholder="Reason"
            aria-label="Reason for deactivating this store"
            style={{
              padding: "0.35rem 0.55rem",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: "0.72rem",
              width: 130,
            }}
          />
          <button type="submit" name="intent" value="suspend" style={btn("#dc2626")}>
            Deactivate
          </button>
        </>
      ) : blocked ? null : (
        <button type="submit" name="intent" value="reactivate" style={btn("#059669")}>
          {suspended ? "Activate" : "Activate anyway"}
        </button>
      )}
      {/* One way back for a blocked store, so the operator is not choosing
          between two buttons that both mean "let them in again". */}
      <BlockControl status={seller.status} />
    </Form>
  );
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "merchants.manage");
  const { ip, userAgent } = getRequestMeta(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const sellerId = String(formData.get("sellerId") || "");
  const reason = String(formData.get("reason") || "").trim();

  if (!sellerId) {
    return { error: "Missing seller id." };
  }

  const actor = {
    actorType: "ADMIN_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
  };

  try {
    if (intent === "suspend") {
      await suspendSeller(sellerId, actor, reason || "Suspended by owner");
    } else if (intent === "reactivate") {
      await reactivateSeller(sellerId, actor);
    } else if (intent === "block") {
      // The row's reason box belongs to Deactivate and the modal asks for its
      // own; both fields are in this one form, so the block reads its own
      // first rather than whichever happens to come first in the document.
      const blockReason = String(formData.get("blockReason") || "").trim();
      await blockSeller(sellerId, actor, blockReason || reason || "Blocked by owner");
    } else if (intent === "unblock") {
      await unblockSeller(sellerId, actor);
    } else {
      return { error: "Unknown action." };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "The operation failed.",
    };
  }

  // Named in the URL so the roster can say what happened: the row's badge
  // changes either way, but only a reader who remembers the previous badge
  // would notice, and a control whose effect is invisible reads as broken.
  return redirect(`/admin/stores?done=${intent}`);
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
  flexWrap: "wrap",
};

function btn(color: string): React.CSSProperties {
  return {
    padding: "0.4rem 0.75rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: "white",
    color,
    fontSize: "0.72rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}

export default function AdminStores() {
  const { sellers, pendingCount, done } = useLoaderData<typeof loader>();

  const approved = sellers.filter((s) => s.status === "APPROVED").length;
  const suspended = sellers.filter((s) => s.status === "SUSPENDED").length;
  const blocked = sellers.filter((s) => s.status === "BLOCKED").length;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Stores
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        The shops that sell MoonVella goods, and the state of their accounts.
      </p>

      {done ? (
        <div
          role="status"
          style={{
            ...card,
            background: "#f0fdf4",
            borderColor: "#bbf7d0",
            color: "#065f46",
            fontSize: "0.85rem",
            marginBottom: "1.5rem",
          }}
        >
          {done}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Stores</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a" }}>
            {sellers.length}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Active</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#059669" }}>
            {approved}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Deactivated</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#dc2626" }}>
            {suspended}
          </div>
        </div>
        {/* Blocked stores get their own count rather than being folded into
            Deactivated: they are not paused, and an operator scanning the page
            should be able to see how many were refused outright. */}
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Blocked</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#7f1d1d" }}>
            {blocked}
          </div>
        </div>
        <div style={card}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Pending applications</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#b45309" }}>
            {pendingCount}
          </div>
        </div>
      </div>

      <AccountingUnconnectedNotice currency="CAD" />

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.25rem" }}>
          All stores
        </h2>
        <p style={{ fontSize: "0.78rem", color: "#64748b", marginBottom: "1rem" }}>
          Open a store to see its balances, invoices and correspondence.
        </p>

        {sellers.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.875rem" }}>
            No stores yet. A store appears here when an application is approved on the
            Applications page.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {sellers.map((seller) => {
              const isApproved = seller.status === "APPROVED";
              return (
                <div key={seller.id} style={rowStyle}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Link
                      to={`/admin/stores/${seller.id}`}
                      style={{ fontWeight: 600, fontSize: "0.9rem", color: "#082a4a" }}
                    >
                      {seller.storeName}
                    </Link>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                      {seller.shopDomain} &middot; {seller._count.orders} orders
                    </div>
                    {/* A block has its own reason column, so it needs its own
                        line — falling back to the suspension one would print
                        nothing for a blocked store and leave the operator
                        wondering why it was refused. */}
                    {seller.status === "BLOCKED" && seller.blockReason ? (
                      <div style={{ fontSize: "0.7rem", color: "#7f1d1d" }}>
                        Blocked &middot; {seller.blockReason}
                      </div>
                    ) : null}
                    {seller.suspensionReason ? (
                      <div style={{ fontSize: "0.7rem", color: "#dc2626" }}>
                        {seller.suspensionReason}
                      </div>
                    ) : null}
                  </div>

                  {/* Two balances used to be printed here, from a sample
                      ledger that ignored the store it was handed — so every
                      row in this list showed the same invented figures, in each
                      store's own currency. There is no ledger to read, and a
                      row that said "0.00" would read as "owes nothing", which
                      is a claim this page cannot make. It says so instead. */}
                  <div style={{ display: "flex", gap: "1.25rem", alignItems: "center" }}>
                    <UnconnectedChip label="No ledger" />
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
                  <StoreControls seller={seller} />
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
