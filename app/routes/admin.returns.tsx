import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { ReturnRequestStatus } from "@prisma/client";
import { prisma } from "~/db.server";
import { ShippingOperationsNav } from "~/components/ShippingOperationsNav";
import { advanceReturnRequest } from "~/services/shippingOperations.server";
import { RETURN_NEXT } from "~/services/shippingOperations";
import { assertSameOrigin, getRequestMeta, requirePermission } from "~/utils/adminAuth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") as ReturnRequestStatus | null;
  const requests = await prisma.returnRequest.findMany({
    where: status && Object.hasOwn(RETURN_NEXT, status) ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { items: { include: { orderItem: true } }, order: { include: { seller: true } }, originalShipment: true },
  });
  return { requests, status: status || "" };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const form = await request.formData();
  const { ip, userAgent } = getRequestMeta(request);
  try {
    await advanceReturnRequest(String(form.get("id") || ""), String(form.get("status") || "") as ReturnRequestStatus, { actorType: "ADMIN_USER", actorId: user.id, actorName: user.name, ipAddress: ip, userAgent });
    return { ok: true };
  } catch (error) { return { error: error instanceof Error ? error.message : "Return update failed." }; }
}

export default function AdminReturns() {
  const { requests, status } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <div className="mv-page-wide">
      <ShippingOperationsNav />

      <div className="mv-page-header">
        <div>
          <h1>Return authorizations</h1>
          <p>A return request is an approval record. It does not buy a label, refund, restock, or update Shopify.</p>
        </div>
      </div>

      {actionData?.error ? (
        <div style={{ background: "#fff0ee", border: "1px solid #fecaca", color: "#b42318", borderRadius: 12, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
          {actionData.error}
        </div>
      ) : null}

      <Form method="get" className="mv-filter-bar">
        <label className="mv-field">
          Status
          <select name="status" defaultValue={status} className="mv-input">
            <option value="">All statuses</option>
            {Object.keys(RETURN_NEXT).map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <button type="submit" className="mv-button mv-button-dark">Filter</button>
      </Form>

      <section className="mv-panel">
        <div className="mv-table-wrap">
          <table className="mv-table">
            <thead>
              <tr>
                <th>Return</th>
                <th>Status</th>
                <th>Items</th>
                <th>Return shipping payer</th>
                <th>Opened by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="mv-muted" style={{ padding: "2rem", textAlign: "center" }}>
                    No return requests found.
                  </td>
                </tr>
              ) : requests.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.rmaNumber}</strong>
                    <div><Link to={`/admin/orders/${item.orderId}`}>{item.order.shopifyOrderName}</Link></div>
                    <div className="mv-muted">{item.order.seller.storeName}</div>
                    <div className="mv-muted">{item.reason}</div>
                  </td>
                  <td><span className="mv-badge">{item.status.replaceAll("_", " ")}</span></td>
                  <td>{item.items.map((line) => `${line.quantity} × ${line.orderItem.name} (${line.orderItem.sku})`).join(" · ")}</td>
                  <td><span className="mv-muted">{item.shippingPayer.replaceAll("_", " ")}</span></td>
                  <td><span className="mv-muted">{item.createdByName || item.createdById}</span></td>
                  <td>
                    {RETURN_NEXT[item.status].length > 0 ? (
                      <Form method="post" className="mv-actions">
                        <input type="hidden" name="id" value={item.id} />
                        <select name="status" className="mv-input">
                          {RETURN_NEXT[item.status].map((next) => <option key={next}>{next}</option>)}
                        </select>
                        <button type="submit" className="mv-button mv-button-dark">Update status</button>
                        <Link to={`/admin/shipping/${item.originalShipmentId}#return`} className="mv-button">Open shipment</Link>
                      </Form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
