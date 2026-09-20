import "../styles/moonvilla.css";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { StatusBadge } from "../components/StatusBadge";
import { StatCard } from "../components/StatCard";
import { ProductCard } from "../components/ProductCard";
import { products } from "../data/moonvillaData";
export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    const { authenticate } = await import("../shopify.server");
    await authenticate.admin(request);
  }

  return null;
};

export default function DashboardPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const importedProducts = 24;
  const ordersThisMonth = 8;
  const totalSalesRetail = 1284;
  const estimatedProfit = 771;

  const recommendedProducts = products.filter(
    (p) =>
      p.name === "Hotel Pillow" ||
      p.name === "All-Season Duvet" ||
      p.name === "Waterproof Mattress Protector",
  );

  return (
    <s-page heading="Dashboard">
      <div className="page-content">
        <div className="hero-banner">
          <div>
            <h1 className="hero-banner-title">Better sleep. Bigger possibilities.</h1>
            <p className="hero-banner-subtitle">
              Canadian-made quality. Dropship with confidence.
            </p>
          </div>
        </div>

        <div className="stats-section">
          <StatCard
            title="Imported products"
            value={importedProducts}
            subtitle=""
          />
          <StatCard
            title="Orders this month"
            value={ordersThisMonth}
            subtitle=""
          />
          <StatCard
            title="Total sales retail"
            value={`$${totalSalesRetail.toLocaleString()}`}
            subtitle=""
          />
          <StatCard
            title="Estimated profit"
            value={`$${estimatedProfit.toLocaleString()}`}
            subtitle=""
          />
        </div>

        <div className="sections-section">
          <div className="sales-trend">
            <h3>Sales trend chart</h3>
            <p className="chart-placeholder">Chart placeholder - real analytics will be connected later.</p>
          </div>

          <div className="recommended-products">
            <h3>Recommended products</h3>
            <div className="product-grid">
              {recommendedProducts.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  showActions
                />
              ))}
            </div>
          </div>

          <div className="setup-checklist">
            <h3>Setup checklist</h3>
            <ul>
              <li>
                <span>
                  <StatusBadge status="InStock" /> Connect Shopify store - complete
                </span>
              </li>
              <li>
                <span>
                  <StatusBadge status="InStock" /> Add payment method - complete
                </span>
              </li>
              <li>
                <span>
                  <StatusBadge status="InStock" /> Set up branding - complete
                </span>
              </li>
              <li>
                <span>
                  <StatusBadge status="InStock" /> Review shipping zones - complete
                </span>
              </li>
              <li>
                <span>
                  <StatusBadge status="Pending" /> Start importing products - pending
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </s-page>
  );
}