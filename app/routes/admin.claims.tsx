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

export default function AdminClaims() {
  const { claims, status } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <div className="mv-page-wide">
      <ShippingOperationsNav />

      <div className="mv-page-header">
        <div>
          <h1>Carrier claims</h1>
          <p>These are internal case files. “Submitted” is available only after the carrier gives you its claim number.</p>
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
            {Object.keys(CLAIM_NEXT).map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <button type="submit" className="mv-button mv-button-dark">Filter</button>
      </Form>

      <section className="mv-panel">
        <div className="mv-table-wrap">
          <table className="mv-table">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Status</th>
                <th>Shipment</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {claims.length === 0 ? (
                <tr>
                  <td colSpan={4} className="mv-muted" style={{ padding: "2rem", textAlign: "center" }}>
                    No claims found.
                  </td>
                </tr>
              ) : claims.map((claim) => (
                <tr key={claim.id}>
                  <td>
                    <strong>{claim.claimNumber}</strong>
                    <div><Link to={`/admin/orders/${claim.shipment.orderId}`}>{claim.shipment.order.shopifyOrderName}</Link></div>
                    <div className="mv-muted">{claim.shipment.order.seller.storeName}</div>
                    <div className="mv-muted">{claim.type.replaceAll("_", " ")} — {claim.description}</div>
                  </td>
                  <td><span className="mv-badge">{claim.status.replaceAll("_", " ")}</span></td>
                  <td>
                    <span className="mv-muted">
                      Carrier: {claim.shipment.carrier || "—"} · Tracking: {claim.shipment.trackingNumber || "—"} · Requested amount: {claim.amount == null ? "not set" : `${(claim.amount / 100).toFixed(2)} ${claim.currency}`}
                      {claim.carrierClaimNumber ? ` · Carrier claim ${claim.carrierClaimNumber}` : ""}
                    </span>
                  </td>
                  <td>
                    {CLAIM_NEXT[claim.status].length > 0 ? (
                      <Form method="post" className="mv-actions" style={{ alignItems: "flex-end" }}>
                        <input type="hidden" name="id" value={claim.id} />
                        <label className="mv-field">Next status
                          <select name="status" className="mv-input">
                            {CLAIM_NEXT[claim.status].map((next) => <option key={next}>{next}</option>)}
                          </select>
                        </label>
                        <label className="mv-field">Carrier claim #
                          <input name="carrierClaimNumber" defaultValue={claim.carrierClaimNumber || ""} className="mv-input" />
                        </label>
                        <label className="mv-field">Resolution note
                          <input name="resolutionNotes" className="mv-input" />
                        </label>
                        <button type="submit" className="mv-button mv-button-dark">Update claim</button>
                        <Link to={`/admin/shipping/${claim.shipmentId}#claim`} className="mv-button">Open shipment</Link>
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
