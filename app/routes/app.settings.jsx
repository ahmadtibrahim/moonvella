import "../styles/moonvilla.css";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { SettingsCard } from "../components/SettingsCard";
export default function SettingsPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const markupDefaults = {
    defaultMarkup: 2.0,
    quantityBuffer: 5,
  };

  return (
    <s-page heading="Tailor Moonvilla to your store.">
      <div className="page-content">
        <div className="page-header">
          <h2 className="page-header-title">Tailor Moonvilla to your store.</h2>
        </div>

        <div className="settings-grid">
          <SettingsCard title="Store Profile">
            <div>
              <label className="input-field">
                Store name
                <input type="text" className="input-field" defaultValue="My Shopify Store" disabled />
              </label>
              <label className="input-field">
                Support email
                <input type="email" className="input-field" defaultValue="support@example.com" disabled />
              </label>
              <label className="input-field">
                Store logo upload placeholder
                <input type="text" className="input-field" defaultValue="logo.png" disabled />
              </label>
            </div>
          </SettingsCard>

          <SettingsCard title="Product Import Preferences">
            <div>
              <label className="input-field">
                <input type="checkbox" checked disabled /> Import product images
              </label>
              <label className="input-field">
                <input type="checkbox" checked disabled /> Import product descriptions
              </label>
              <label className="input-field">
                <input type="number" className="input-field" defaultValue={2.0} disabled />
                Default price markup
              </label>
            </div>
          </SettingsCard>

          <SettingsCard title="Inventory & Sync">
            <div>
              <label className="input-field">
                <input type="checkbox" checked disabled /> Auto-sync inventory
              </label>
              <label className="input-field">
                <input type="number" className="input-field" defaultValue={5} disabled />
                Quantity buffer
              </label>
              <label className="input-field">
                <input type="checkbox" checked disabled /> Low-stock alerts
              </label>
            </div>
          </SettingsCard>

          <SettingsCard title="Order Preferences">
            <div>
              <label className="input-field">
                <input type="checkbox" checked disabled /> Auto-import orders
              </label>
              <label className="input-field">
                <input type="text" className="input-field"
                  defaultValue="Typically ships within 2–4 business days."
                  disabled />
                Estimated delivery message
              </label>
            </div>
          </SettingsCard>

          <SettingsCard title="Billing & Payments">
            <div>
              <div className="billing-info">
                <span>VISA ending 4242</span>
                <span>Expires 04/27</span>
              </div>
              <button className="btn-primary" disabled>Update</button>
            </div>
          </SettingsCard>

          <SettingsCard title="Notifications">
            <div>
              <label className="input-field">
                <input type="checkbox" checked disabled /> New order notifications
              </label>
              <label className="input-field">
                <input type="checkbox" checked disabled /> Shipment updates
              </label>
              <label className="input-field">
                <input type="checkbox" checked disabled /> Payout and billing emails
              </label>
            </div>
          </SettingsCard>
        </div>

        <div className="branding-section">
          <h3>Branded Packing Slip</h3>
          <div className="branding-status">
            <span>Status: Enabled</span>
          </div>
          <div className="branding-message">
            Your customers receive your store-branded packing slip. Moonvilla remains behind the scenes.
          </div>
        </div>
      </div>
    </s-page>
  );
}