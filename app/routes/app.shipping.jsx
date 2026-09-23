import { useLoaderData } from "react-router";
import { prisma } from "../db.server";
import { withMerchantAccess } from "../services/seller.server";

/**
 * The shipping table is global data rather than this seller's, which is why
 * this loader used to read it without identifying the caller at all. Two things
 * were wrong with that: it is still a merchant surface, so a blocked store
 * could open it and see MoonVella's carrier costs, and a route that never
 * authenticates is one refactor away from serving data to anybody who knows the
 * URL. It now goes through the same gate as every other merchant page.
 */
export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async () => {
  const zones = await prisma.shippingZone.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  return {
    zones: zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      province: zone.province,
      supplierShippingCost: zone.supplierShippingCost,
      transit: zone.transit,
      freeShippingThreshold: zone.freeShippingThreshold,
      customerDisplay: zone.customerDisplay,
      status: zone.status,
    })),
  };
  });

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export default function ShippingPage() {
  const { zones } = useLoaderData();
  const previewZones = zones.slice(0, 3);

  return (
    <s-page heading="Shipping">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Shipping</h2>
          <p className="mv-page-subtitle">
            Shipping rates, zones, and rules for MoonVella products in your store.
          </p>
        </div>

        <div className="mv-section-card">
          <h3 className="mv-section-title">Shipping zones (Canada only)</h3>
          <p className="mv-branding-message" style={{ marginBottom: "1rem", fontSize: "0.875rem" }}>
            Zones are managed by MoonVella and shown here for your store preview.
          </p>

          {zones.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.875rem" }}>
              No shipping zones are configured yet. MoonVella will publish the Canadian zones before orders ship.
            </div>
          ) : (
            <div className="mv-table-wrapper">
              <table className="mv-table">
                <thead>
                  <tr>
                    <th>Zone / Province</th>
                    <th>Supplier Shipping Cost (CAD)</th>
                    <th>Transit Time</th>
                    <th>Free Shipping Threshold (CAD)</th>
                    <th>Customer Display</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {zones.map((zone) => (
                    <tr key={zone.id}>
                      <td>
                        {zone.name}
                        <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{zone.province}</div>
                      </td>
                      <td>{money(zone.supplierShippingCost)}</td>
                      <td>{zone.transit}</td>
                      <td>{zone.freeShippingThreshold > 0 ? money(zone.freeShippingThreshold) : "—"}</td>
                      <td>{zone.customerDisplay}</td>
                      <td>
                        <span className={`mv-badge ${zone.status === "Active" ? "mv-badge-instock" : "mv-badge-pending"}`}>
                          {zone.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mv-dashboard-main">
          <div className="mv-dashboard-content">
            <div className="mv-section-card">
              <h3 className="mv-section-title">Display options</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <label className="mv-settings-checkbox">
                  <input type="checkbox" checked disabled readOnly />
                  <span>Show calculated shipping rate</span>
                </label>
                <label className="mv-settings-checkbox">
                  <input type="checkbox" disabled readOnly />
                  <span>Include shipping in product price (not configurable)</span>
                </label>
                <label className="mv-settings-checkbox">
                  <input type="checkbox" checked disabled readOnly />
                  <span>Offer free shipping above threshold</span>
                </label>
              </div>
            </div>

            <div className="mv-section-card">
              <h3 className="mv-section-title">Customer checkout preview</h3>
              {previewZones.length === 0 ? (
                <p className="mv-branding-message" style={{ fontSize: "0.85rem" }}>
                  A checkout preview appears once shipping zones are configured.
                </p>
              ) : (
                <div className="mv-checkout-preview">
                  {previewZones.map((zone) => (
                    <div className="mv-checkout-row" key={zone.id}>
                      <span className="mv-checkout-label">
                        {zone.name} ({zone.transit})
                      </span>
                      <span className="mv-checkout-value">{money(zone.supplierShippingCost)}</span>
                    </div>
                  ))}
                  {previewZones
                    .filter((zone) => zone.freeShippingThreshold > 0)
                    .map((zone) => (
                      <div className="mv-checkout-row" key={`${zone.id}-free`}>
                        <span className="mv-checkout-label">
                          Free shipping ({zone.name}, orders over {money(zone.freeShippingThreshold)})
                        </span>
                        <span className="mv-checkout-value mv-free">Free</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>

          <div className="mv-dashboard-sidebar">
            <div className="mv-section-card">
              <h3 className="mv-section-title">Shipping rules</h3>
              <ul className="mv-rules-list">
                <li>Weight-based shipping</li>
                <li>Oversize items</li>
                <li>Northern / remote custom quote</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}
