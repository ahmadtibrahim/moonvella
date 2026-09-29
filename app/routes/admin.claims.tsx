import { Form, Link, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { ShippingClaimStatus } from "@prisma/client";
import { prisma } from "~/db.server";
import { ShippingOperationsNav } from "~/components/ShippingOperationsNav";
import { advanceShippingClaim } from "~/services/shippingOperations.server";
import { CLAIM_NEXT } from "~/services/shippingOperations";
import { assertSameOrigin, getRequestMeta, requirePermission } from "~/utils/adminAuth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") as ShippingClaimStatus | null;
  const claims = await prisma.shippingClaim.findMany({
    where: status && Object.hasOwn(CLAIM_NEXT, status) ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { shipment: { include: { order: { include: { seller: true } } } } },
  });
  return { claims, status: status || "" };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const form = await request.formData();
  const { ip, userAgent } = getRequestMeta(request);
  try {
    await advanceShippingClaim({ id: String(form.get("id") || ""), status: String(form.get("status") || "") as ShippingClaimStatus, carrierClaimNumber: String(form.get("carrierClaimNumber") || ""), resolutionNotes: String(form.get("resolutionNotes") || "") }, { actorType: "ADMIN_USER", actorId: user.id, actorName: user.name, ipAddress: ip, userAgent });
    return { ok: true };
  } catch (error) { return { error: error instanceof Error ? error.message : "Claim update failed." }; }
}

const card = { background: "white", border: "1px solid #dbe4ee", borderRadius: 12, padding: "1rem" } as const;
export default function AdminClaims() {
  const { claims, status } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <div style={{ maxWidth: 1180, margin: "0 auto" }}>
    <ShippingOperationsNav />
    <h1 style={{ fontSize: "1.5rem", color: "#082a4a", marginBottom: "0.25rem" }}>Carrier claims</h1>
    <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "1rem" }}>These are internal case files. “Submitted” is available only after the carrier gives you its claim number.</p>
    {actionData?.error ? <div style={{ ...card, borderColor: "#fecaca", background: "#fef2f2", color: "#991b1b", marginBottom: "0.75rem" }}>{actionData.error}</div> : null}
    <Form method="get" style={{ marginBottom: "0.75rem" }}><select name="status" defaultValue={status} style={{ padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 7 }}><option value="">All statuses</option>{Object.keys(CLAIM_NEXT).map((value) => <option key={value}>{value}</option>)}</select> <button style={{ padding: "0.5rem 0.8rem" }}>Filter</button></Form>
    <div style={{ display: "grid", gap: "0.75rem" }}>{claims.length === 0 ? <div style={card}>No claims found.</div> : claims.map((claim) => <article key={claim.id} style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}><div><strong style={{ color: "#082a4a" }}>{claim.claimNumber}</strong> · <Link to={`/admin/orders/${claim.shipment.orderId}`}>{claim.shipment.order.shopifyOrderName}</Link> · {claim.shipment.order.seller.storeName}<div style={{ color: "#64748b", fontSize: "0.75rem", marginTop: "0.25rem" }}>{claim.type.replaceAll("_", " ")} — {claim.description}</div></div><strong>{claim.status.replaceAll("_", " ")}</strong></div>
      <div style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.4rem" }}>Carrier: {claim.shipment.carrier || "—"} · Tracking: {claim.shipment.trackingNumber || "—"} · Requested amount: {claim.amount == null ? "not set" : `${(claim.amount / 100).toFixed(2)} ${claim.currency}`}{claim.carrierClaimNumber ? ` · Carrier claim ${claim.carrierClaimNumber}` : ""}</div>
      {CLAIM_NEXT[claim.status].length > 0 ? <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap", marginTop: "0.75rem" }}><input type="hidden" name="id" value={claim.id} /><label style={{ fontSize: "0.7rem" }}>Next status<br /><select name="status" style={{ padding: "0.45rem", border: "1px solid #cbd5e1", borderRadius: 7 }}>{CLAIM_NEXT[claim.status].map((next) => <option key={next}>{next}</option>)}</select></label><label style={{ fontSize: "0.7rem" }}>Carrier claim #<br /><input name="carrierClaimNumber" defaultValue={claim.carrierClaimNumber || ""} style={{ padding: "0.45rem", border: "1px solid #cbd5e1", borderRadius: 7 }} /></label><label style={{ fontSize: "0.7rem" }}>Resolution note<br /><input name="resolutionNotes" style={{ padding: "0.45rem", border: "1px solid #cbd5e1", borderRadius: 7 }} /></label><button style={{ padding: "0.48rem 0.75rem", background: "#082a4a", color: "white", border: 0, borderRadius: 7 }}>Update claim</button><Link to={`/admin/shipping/${claim.shipmentId}#claim`} style={{ fontSize: "0.75rem" }}>Open shipment</Link></Form> : null}
    </article>)}</div>
  </div>;
}
