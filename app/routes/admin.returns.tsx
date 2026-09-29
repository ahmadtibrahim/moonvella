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

const card = { background: "white", border: "1px solid #dbe4ee", borderRadius: 12, padding: "1rem" } as const;
export default function AdminReturns() {
  const { requests, status } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <div style={{ maxWidth: 1180, margin: "0 auto" }}>
    <ShippingOperationsNav />
    <h1 style={{ fontSize: "1.5rem", color: "#082a4a", marginBottom: "0.25rem" }}>Return authorizations</h1>
    <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "1rem" }}>A return request is an approval record. It does not buy a label, refund, restock, or update Shopify.</p>
    {actionData?.error ? <div style={{ ...card, borderColor: "#fecaca", background: "#fef2f2", color: "#991b1b", marginBottom: "0.75rem" }}>{actionData.error}</div> : null}
    <Form method="get" style={{ marginBottom: "0.75rem" }}><select name="status" defaultValue={status} style={{ padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 7 }}><option value="">All statuses</option>{Object.keys(RETURN_NEXT).map((value) => <option key={value}>{value}</option>)}</select> <button style={{ padding: "0.5rem 0.8rem" }}>Filter</button></Form>
    <div style={{ display: "grid", gap: "0.75rem" }}>{requests.length === 0 ? <div style={card}>No return requests found.</div> : requests.map((item) => <article key={item.id} style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}><div><strong style={{ color: "#082a4a" }}>{item.rmaNumber}</strong> · <Link to={`/admin/orders/${item.orderId}`}>{item.order.shopifyOrderName}</Link> · {item.order.seller.storeName}<div style={{ color: "#64748b", fontSize: "0.75rem", marginTop: "0.25rem" }}>{item.reason}</div></div><strong>{item.status.replaceAll("_", " ")}</strong></div>
      <div style={{ fontSize: "0.75rem", marginTop: "0.6rem" }}>{item.items.map((line) => `${line.quantity} × ${line.orderItem.name} (${line.orderItem.sku})`).join(" · ")}</div>
      <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.35rem" }}>Return shipping payer: {item.shippingPayer.replaceAll("_", " ")} · Opened by {item.createdByName || item.createdById}</div>
      {RETURN_NEXT[item.status].length > 0 ? <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.75rem" }}><input type="hidden" name="id" value={item.id} /><select name="status" style={{ padding: "0.45rem", border: "1px solid #cbd5e1", borderRadius: 7 }}>{RETURN_NEXT[item.status].map((next) => <option key={next}>{next}</option>)}</select><button style={{ padding: "0.45rem 0.75rem", background: "#082a4a", color: "white", border: 0, borderRadius: 7 }}>Update status</button><Link to={`/admin/shipping/${item.originalShipmentId}#return`} style={{ fontSize: "0.75rem" }}>Open shipment</Link></Form> : null}
    </article>)}</div>
  </div>;
}
