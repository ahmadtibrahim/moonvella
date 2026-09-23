import { Link, Form, useLoaderData, useActionData, useNavigation, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { advanceShipment, type ShipmentAdvanceEvent } from "~/services/fulfillment.server";
import { syncTrackingForShipment, voidShipment } from "~/services/shipping.server";
// trackingLabel is rendered by the component below, so it must come from the
// isomorphic module — importing it from shipping.server would pull server-only
// code into the client bundle, which React Router refuses at build time.
import { trackingLabel } from "~/services/shippingLogic";
import { maskedEshipperAccount, eshipperMode } from "~/services/eshipper.server";

const STATUSES = ["PENDING", "SHIPPED", "DELIVERED", "EXCEPTION", "CANCELLED"] as const;
const PAGE_SIZE = 25;

const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = [
  "packed",
  "handed_to_carrier",
  "shipped",
  "in_transit",
  "delivered",
  "exception",
];

function parseAddress(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const carrier = url.searchParams.get("carrier") || "";
  const sellerId = url.searchParams.get("seller") || "";
  const billingStatus = url.searchParams.get("billing") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const from = url.searchParams.get("from") || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));

  const and: Record<string, unknown>[] = [];
  if (STATUSES.includes(status as (typeof STATUSES)[number])) and.push({ status: status as never });
  if (carrier) and.push({ carrier: { contains: carrier, mode: "insensitive" } });
  if (billingStatus) and.push({ billingStatus });
  if (sellerId) and.push({ order: { sellerId } });
  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) and.push({ createdAt: { gte: fromDate } });
  }
  if (q) {
    and.push({
      OR: [
        { trackingNumber: { contains: q, mode: "insensitive" } },
        { providerShipmentId: { contains: q, mode: "insensitive" } },
        { order: { shopifyOrderName: { contains: q, mode: "insensitive" } } },
        { order: { supplierReference: { contains: q, mode: "insensitive" } } },
        { order: { seller: { storeName: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  const where = and.length ? { AND: and } : {};

  const [shipments, total, delivered, pending, exceptions, sellers, awaitingPrep] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        trackingNumber: true,
        trackingUrl: true,
        carrier: true,
        serviceName: true,
        status: true,
        trackingStatus: true,
        // The row gates its cancel control on this, and the search above matches
        // on it; without it in the select the row cannot render that control.
        providerShipmentId: true,
        sellerShippingCharge: true,
        quotedCarrierCost: true,
        bookedCost: true,
        finalBilledCost: true,
        billingStatus: true,
        estimatedDelivery: true,
        lastTrackingSyncAt: true,
        lastTrackingError: true,
        returnOfShipmentId: true,
        createdAt: true,
        order: {
          select: {
            id: true,
            shopifyOrderName: true,
            supplierReference: true,
            shippingAddress: true,
            currency: true,
            seller: { select: { id: true, storeName: true } },
          },
        },
      },
    }),
    prisma.shipment.count({ where }),
    prisma.shipment.count({ where: { ...where, status: "DELIVERED" } }),
    prisma.shipment.count({ where: { ...where, status: "PENDING" } }),
    prisma.shipment.count({ where: { ...where, status: "EXCEPTION" } }),
    prisma.seller.findMany({ select: { id: true, storeName: true }, orderBy: { storeName: "asc" } }),
    prisma.order.count({ where: { wholesalePaymentStatus: "SUCCEEDED", fulfillmentStatus: { in: ["PENDING", "PROCESSING", "PARTIAL"] } } }),
  ]);

  return {
    shipments,
    total,
    delivered,
    pending,
    exceptions,
    sellers,
    awaitingPrep,
    mode: await eshipperMode(),
    account: await maskedEshipperAccount(),
    filters: { status, carrier, seller: sellerId, billing: billingStatus, q, from },
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const shipmentId = String(form.get("shipmentId") || "");

  try {
    if (intent === "advance_shipment") {
      const event = String(form.get("event") || "");
      if (!ADVANCE_EVENTS.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      await advanceShipment(shipmentId, event as ShipmentAdvanceEvent, actor);
    } else if (intent === "sync_tracking") {
      await syncTrackingForShipment(shipmentId, actor);
    } else if (intent === "cancel_shipment") {
      const result = await voidShipment(shipmentId, actor);
      if (!result.cancelled) {
        return { error: `Cancellation was not confirmed${result.providerMessage ? `: ${result.providerMessage}` : "."}` };
      }
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect(request.url);
}

const th: React.CSSProperties = { padding: "0.5rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };
const td: React.CSSProperties = { padding: "0.5rem", fontSize: "0.78rem", verticalAlign: "top" };
const input: React.CSSProperties = { padding: "0.4rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.75rem", boxSizing: "border-box" };
const smallBtn = (color: string): React.CSSProperties => ({ padding: "0.2rem 0.45rem", border: `1px solid ${color}`, borderRadius: 4, background: "white", color, fontSize: "0.65rem", fontWeight: 600, cursor: "pointer" });

const statusColor: Record<string, string> = {
  PENDING: "#b45309",
  SHIPPED: "#0369a1",
  DELIVERED: "#059669",
  EXCEPTION: "#dc2626",
  CANCELLED: "#64748b",
};

function money(cents: number | null, currency = "CAD") {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export default function AdminShipping() {
  const { shipments, total, delivered, pending, exceptions, sellers, awaitingPrep, mode, account, filters, page, pageCount } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>Shipping</h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1rem" }}>
        One row per shipment, so a split order shows each parcel. Parsing, quoting and booking begin from a parcel.
      </p>
      <p style={{ fontSize: "0.75rem", marginBottom: "1rem" }}>
        <Link to="/admin/orders" style={{ color: "#0369a1", fontWeight: 600 }}>
          {awaitingPrep} order{awaitingPrep === 1 ? "" : "s"} awaiting shipment preparation &rarr;
        </Link>
      </p>

      {actionData?.error ? (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 8, padding: "0.75rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
          {actionData.error}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem", marginBottom: "1.25rem" }}>
        {[
          { label: "Total shipments", value: total, color: "#082a4a" },
          { label: "Awaiting booking", value: pending, color: "#b45309" },
          { label: "Delivered", value: delivered, color: "#059669" },
          { label: "Exceptions", value: exceptions, color: "#dc2626" },
        ].map((c) => (
          <div key={c.label} style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1rem" }}>
            <div style={{ fontSize: "0.72rem", color: "#64748b" }}>{c.label}</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 700, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      <Form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Search
          <br />
          <input name="q" defaultValue={filters.q} placeholder="Order, shipment, tracking, seller" style={{ ...input, width: 240 }} />
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Status
          <br />
          <select name="status" defaultValue={filters.status} style={input}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Carrier
          <br />
          <input name="carrier" defaultValue={filters.carrier} placeholder="Any" style={{ ...input, width: 120 }} />
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Seller
          <br />
          <select name="seller" defaultValue={filters.seller} style={input}>
            <option value="">All</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>{s.storeName}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Billing
          <br />
          <select name="billing" defaultValue={filters.billing} style={input}>
            <option value="">All</option>
            {["PENDING", "RECONCILED", "VARIANCE", "NEEDS_RECONCILIATION"].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Created from
          <br />
          <input type="date" name="from" defaultValue={filters.from} style={input} />
        </label>
        <button type="submit" style={{ ...input, background: "#082a4a", color: "white", border: "none", fontWeight: 600, cursor: "pointer" }}>Filter</button>
        <Link to="/admin/shipping" style={{ fontSize: "0.75rem", color: "#082a4a", paddingBottom: "0.4rem" }}>Reset</Link>
        <span style={{ fontSize: "0.68rem", color: mode === "real" ? "#64748b" : "#b45309", marginLeft: "auto", paddingBottom: "0.4rem" }}>
          eShipper: {mode === "real" ? account ?? "configured" : "not configured (simulated)"}
        </span>
      </Form>

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, overflowX: "auto" }}>
        {loading ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>Loading shipments…</p>
        ) : shipments.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>
            No shipments match. Shipments are created by booking a parcel from an order; none are created to fill this table.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th style={th}>Shipment</th>
                <th style={th}>Order</th>
                <th style={th}>Seller</th>
                <th style={th}>Destination</th>
                <th style={th}>Carrier / service</th>
                <th style={th}>Tracking</th>
                <th style={th}>Status</th>
                <th style={th}>Est. delivery</th>
                <th style={th}>Last sync</th>
                <th style={th}>Seller charge</th>
                <th style={th}>Carrier cost</th>
                <th style={th}>Billing</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => {
                const addr = parseAddress(s.order.shippingAddress);
                const dest = [addr.city, addr.province || addr.provinceCode, addr.zip || addr.postalCode].filter(Boolean).join(", ") || "—";
                const carrierCost = s.finalBilledCost ?? s.bookedCost;
                return (
                  <tr key={s.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={td}>
                      <Link to={`/admin/shipping/${s.id}`} style={{ fontWeight: 600, color: "#082a4a" }}>
                        {s.returnOfShipmentId ? "Return " : ""}{s.id.slice(0, 8)}
                      </Link>
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>{new Date(s.createdAt).toLocaleDateString()}</div>
                    </td>
                    <td style={td}>
                      <Link to={`/admin/orders/${s.order.id}`} style={{ color: "#082a4a" }}>{s.order.shopifyOrderName}</Link>
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>{s.order.supplierReference}</div>
                    </td>
                    <td style={td}>{s.order.seller.storeName}</td>
                    <td style={td}>{dest}</td>
                    <td style={td}>
                      {s.carrier || "—"}
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>{s.serviceName || "—"}</div>
                    </td>
                    <td style={td}>
                      {s.trackingNumber || "—"}
                      {s.trackingUrl ? (
                        <div>
                          <a href={s.trackingUrl} target="_blank" rel="noreferrer" style={{ fontSize: "0.65rem", color: "#0369a1" }}>Track</a>
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...td, color: statusColor[s.status] || "#64748b", fontWeight: 600 }}>
                      {trackingLabel(s.trackingStatus)}
                      <div style={{ fontSize: "0.62rem", color: "#94a3b8", fontWeight: 400 }}>{s.status}</div>
                    </td>
                    <td style={td}>{s.estimatedDelivery ? new Date(s.estimatedDelivery).toLocaleDateString() : "—"}</td>
                    <td style={td}>
                      {s.lastTrackingSyncAt ? new Date(s.lastTrackingSyncAt).toLocaleString() : "—"}
                      {s.lastTrackingError ? (
                        <div style={{ fontSize: "0.62rem", color: "#dc2626" }} title={s.lastTrackingError}>sync error</div>
                      ) : null}
                    </td>
                    <td style={td}>{money(s.sellerShippingCharge, s.order.currency)}</td>
                    <td style={td}>
                      {money(carrierCost, s.order.currency)}
                      {s.quotedCarrierCost != null && s.bookedCost != null && s.quotedCarrierCost !== s.bookedCost ? (
                        <div style={{ fontSize: "0.62rem", color: "#b45309" }}>quoted {money(s.quotedCarrierCost)}</div>
                      ) : null}
                    </td>
                    <td style={td}>
                      <span style={{ fontSize: "0.68rem", color: s.billingStatus === "RECONCILED" ? "#059669" : s.billingStatus === "VARIANCE" ? "#b45309" : "#64748b" }}>
                        {s.billingStatus.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                        <Link to={`/admin/shipping/${s.id}`} style={{ ...smallBtn("#082a4a"), textDecoration: "none" }}>Open</Link>
                        {s.status === "PENDING" && s.providerShipmentId ? (
                          <>
                            <Form method="post">
                              <input type="hidden" name="intent" value="sync_tracking" />
                              <input type="hidden" name="shipmentId" value={s.id} />
                              <button type="submit" style={smallBtn("#0369a1")}>Sync</button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="cancel_shipment" />
                              <input type="hidden" name="shipmentId" value={s.id} />
                              <button type="submit" style={smallBtn("#dc2626")}>Cancel</button>
                            </Form>
                          </>
                        ) : null}
                        {s.status === "SHIPPED" || s.status === "EXCEPTION" ? (
                          <Form method="post" style={{ display: "flex", gap: "0.2rem", alignItems: "center" }}>
                            <input type="hidden" name="intent" value="advance_shipment" />
                            <input type="hidden" name="shipmentId" value={s.id} />
                            <select name="event" defaultValue="in_transit" style={{ ...input, padding: "0.15rem 0.25rem", fontSize: "0.62rem" }}>
                              {ADVANCE_EVENTS.map((ev) => (
                                <option key={ev} value={ev}>{ev.replace(/_/g, " ")}</option>
                              ))}
                            </select>
                            <button type="submit" style={smallBtn("#082a4a")}>Go</button>
                          </Form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {pageCount > 1 ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "1rem", fontSize: "0.78rem" }}>
          {page > 1 ? (
            <Link to={`?${new URLSearchParams({ ...filters, page: String(page - 1) } as Record<string, string>).toString()}`} style={{ color: "#082a4a" }}>&larr; Previous</Link>
          ) : null}
          <span style={{ color: "#64748b" }}>Page {page} of {pageCount}</span>
          {page < pageCount ? (
            <Link to={`?${new URLSearchParams({ ...filters, page: String(page + 1) } as Record<string, string>).toString()}`} style={{ color: "#082a4a" }}>Next &rarr;</Link>
          ) : null}
        </div>
      ) : null}

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>&larr; Back to Dashboard</Link>
      </p>
    </div>
  );
}
