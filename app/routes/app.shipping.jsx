import "../styles/moonvilla.css";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { ShippingZoneTable } from "../components/ShippingZoneTable";
import { shippingZones } from "../data/moonvillaData";
export default function ShippingPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  return (
    <s-page heading="Flexible shipping. Happier customers.">
      <div className="page-content">
        <div className="page-header">
          <h2 className="page-header-title">Flexible shipping. Happier customers.</h2>
        </div>

        <div className="shipping-main">
          <ShippingZoneTable zones={shippingZones} />

          <div className="display-options-card">
            <h3>Display options</h3>
            <label className="input-field">
              <input type="checkbox" checked disabled />
              Show calculated shipping rate
            </label>
            <label className="input-field">
              <input type="checkbox" checked disabled />
              Include shipping in product price
            </label>
            <label className="input-field">
              <input type="checkbox" checked disabled />
              Offer free shipping above threshold
            </label>
          </div>

          <div className="customer-checkout-preview">
            <h3>Customer checkout preview</h3>
            <div className="checkout-preview">
              <div className="checkout-preview-row">
                <span>Standard Shipping</span>
                <span>$9.99</span>
              </div>
              <div className="checkout-preview-row">
                <span>Express Shipping</span>
                <span>$24.99</span>
              </div>
              <div className="checkout-preview-row">
                <span>Free Shipping (orders over $99)</span>
                <span>Free</span>
              </div>
            </div>
          </div>
        </div>

        <div className="shipping-rules">
          <h3>Shipping rules</h3>
          <ul>
            <li>Weight-based shipping</li>
            <li>Oversize items</li>
            <li>Northern / remote custom quote</li>
          </ul>
        </div>
      </div>
    </s-page>
  );
}