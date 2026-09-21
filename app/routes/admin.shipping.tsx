import { Link, Form, useLoaderData, useActionData, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { advanceShipment, type ShipmentAdvanceEvent } from "~/services/fulfillment.server";

const STATUSES = ["PENDING", "SHIPPED", "DELIVERED", "EXCEPTION", "CANCELLED"];

const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = ["packed", "handed_to_carrier", "shipped", "in_transit", "delivered", "exception"];

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const where = STATUSES.includes(status) ? { status: status as never } : {};

  const [shipments, totalShipments, delivered, exceptions] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        trackingNumber: true,
        carrier: true,
        status: true,
        shippedAt: true,
        order: {
          select: {
            id: true,
            shopifyOrderName: true,
            seller: { select: { storeName: true } },
          },
        },
      },
    }),
    prisma.shipment.count(),
    prisma.shipment.count({ where: { status: "DELIVERED" } }),
    prisma.shipment.count({ where: { status: "EXCEPTION" } }),
  ]);

  return { shipments, totalShipments, delivered, exceptions, status };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "advance_shipment") {
      const event = String(form.get("event") || "");
      if (!ADVANCE_EVENTS.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      await advanceShipment(String(form.get("shipmentId")), event as ShipmentAdvanceEvent, actor);
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect("/admin/shipping");
}

const grid = "1.2fr 1.5fr 1fr 110px 140px 240px";

const statusColor: Record<string, string> = {
  PENDING: "#b45309",
  SHIPPED: "#0369a1",
  DELIVERED: "#059669",
  EXCEPTION: "#dc2626",
  CANCELLED: "#64748b",
};

export default function AdminShipping() {
  const { shipments, totalShipments, delivered, exceptions, status } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Shipping
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Shipment tracking across all sellers
      </p>

      {actionData?.error ? (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 8, padding: "0.75rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
          {actionData.error}
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
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Total Shipments</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a" }}>{totalShipments}</div>
        </div>
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Delivered</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#059669" }}>{delivered}</div>
        </div>
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Exceptions</div>
          <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#dc2626" }}>{exceptions}</div>
        </div>
      </div>

      <Form
        method="get"
        style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem" }}
      >
        <label htmlFor="status" style={{ fontSize: "0.8rem", color: "#64748b" }}>
          Status
        </label>
        <select
          id="status"
          name="status"
          defaultValue={status}
          style={{ padding: "0.45rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.8rem" }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="submit"
          style={{
            padding: "0.45rem 0.9rem",
            background: "#082a4a",
            color: "white",
            border: "none",
            borderRadius: 6,
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Filter
        </button>
        {status ? (
          <Link to="/admin/shipping" style={{ fontSize: "0.8rem", color: "#082a4a" }}>
            Reset
          </Link>
        ) : null}
      </Form>

      <div
        style={{
          background: "white",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: grid,
            padding: "1rem",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            fontSize: "0.7rem",
            fontWeight: 700,
            color: "#082a4a",
          }}
        >
          <span>Order</span>
          <span>Seller</span>
          <span>Tracking</span>
          <span>Carrier</span>
          <span>Status</span>
          <span>Actions</span>
        </div>

        {shipments.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.875rem" }}>
            {status ? `No shipments with status ${status}.` : "No shipments yet."}
          </p>
        ) : (
          shipments.map((s) => (
            <div
              key={s.id}
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                padding: "0.75rem 1rem",
                borderBottom: "1px solid #f1f5f9",
                fontSize: "0.8rem",
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: 600 }}>
                {s.order?.id ? (
                  <Link to={`/admin/orders/${s.order.id}`} style={{ color: "#082a4a" }}>
                    {s.order.shopifyOrderName || "View order"}
                  </Link>
                ) : (
                  <span style={{ color: "#1e293b" }}>{"\u2014"}</span>
                )}
              </span>
              <span style={{ color: "#64748b" }}>
                {s.order?.seller?.storeName || "Unknown"}
              </span>
              <span style={{ color: "#64748b" }}>{s.trackingNumber || "\u2014"}</span>
              <span style={{ color: "#64748b" }}>{s.carrier || "\u2014"}</span>
              <span style={{ color: statusColor[s.status] || "#64748b", fontWeight: 600 }}>
                {s.status}
              </span>
              <span style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", alignItems: "center" }}>
                {s.order?.id ? (
                  <Link to={`/admin/packing/${s.order.id}`} style={{ fontSize: "0.68rem", color: "#0369a1", fontWeight: 600 }}>
                    Pack
                  </Link>
                ) : null}
                <Form method="post" style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
                  <input type="hidden" name="intent" value="advance_shipment" />
                  <input type="hidden" name="shipmentId" value={s.id} />
                  <select name="event" defaultValue="in_transit" style={{ padding: "0.2rem", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: "0.68rem" }}>
                    {ADVANCE_EVENTS.map((ev) => (
                      <option key={ev} value={ev}>{ev.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                  <button type="submit" style={{ padding: "0.2rem 0.45rem", border: "1px solid #082a4a", borderRadius: 4, background: "white", color: "#082a4a", fontSize: "0.68rem", fontWeight: 600, cursor: "pointer" }}>
                    Advance
                  </button>
                </Form>
              </span>
            </div>
          ))
        )}
      </div>

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; Back to Dashboard
        </Link>
      </p>
    </div>
  );
}
