import React from "react";
import { StatusBadge } from "../components/StatusBadge";
import { DataTable } from "../components/DataTable";
import { dummyOrders } from "../data/moonvillaData";
import { applicationStatus } from "../data/moonvellaState";

const isApproved = applicationStatus === "approved";

const orderStatuses = ["All", "Pending", "Processing", "Shipped", "Delivered", "Cancelled"];

export default function OrdersPage() {
  const [selectedStatus, setSelectedStatus] = React.useState("All");
  const [searchQuery, setSearchQuery] = React.useState("");

  const orders = dummyOrders;

  const filteredOrders = orders.filter((order) => {
    if (selectedStatus !== "All" && order.fulfillmentStatus !== selectedStatus) {
      return false;
    }

    if (searchQuery) {
      const lower = searchQuery.toLowerCase();
      return (
        order.retailTotal.toString().includes(lower) ||
        order.customer.toLowerCase().includes(lower) ||
        order.retailer.toLowerCase().includes(lower)
      );
    }

    return true;
  });

  if (!isApproved) {
    return (
      <s-page heading="Orders">
        <div className="mv-container">
          <div className="mv-page-header">
            <h2 className="mv-page-title">Orders</h2>
            <p className="mv-page-subtitle">
              Manage and track all MoonVella orders. View order details, fulfillment status, and billing information.
            </p>
          </div>

          <div className="mv-section-card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
            <div style={{ fontSize: '4rem', marginBottom: '1.5rem' }}>📋</div>
            <h2 className="mv-page-title" style={{ marginBottom: '1rem' }}>Orders will appear here after approval</h2>
            <p className="mv-page-subtitle" style={{ maxWidth: '500px', margin: '0 auto 2rem' }}>
              Orders will appear here after approval and after MoonVella products are imported.
            </p>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="mv-btn mv-btn-primary" onClick={() => window.location.href = "/app/status"}>
                View Application Status
              </button>
              <button className="mv-btn mv-btn-secondary" onClick={() => window.location.href = "/app/application"}>
                Edit Application
              </button>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    <s-page heading="Orders">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Orders</h2>
          <p className="mv-page-subtitle">
            Manage and track all MoonVella orders. View order details, fulfillment status, and billing information.
          </p>
        </div>

        <div className="mv-filter-row">
          <div className="mv-tab-nav" role="tablist">
            {orderStatuses.map((status) => (
              <button
                key={status}
                role="tab"
                aria-selected={selectedStatus === status}
                className={`mv-tab-btn ${selectedStatus === status ? "active" : ""}`}
                onClick={() => setSelectedStatus(status)}
              >
                {status}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="mv-search-input"
            placeholder="Search orders, customers, or products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="mv-section-card">
          <DataTable
            columns={[
              { key: "retailerOrder", label: "Retailer order #", type: "text" },
              { key: "customer", label: "Customer", type: "text" },
              { key: "items", label: "Items", type: "text" },
              { key: "retailTotal", label: "Retail total", type: "text" },
              { key: "moonvillaCost", label: "MoonVella cost", type: "text" },
              { key: "paymentStatus", label: "Payment status", type: "badge" },
              { key: "fulfillmentStatus", label: "Fulfillment status", type: "badge" },
              { key: "tracking", label: "Tracking", type: "text" },
              { key: "date", label: "Date", type: "text" },
              { key: "actions", label: "Actions", type: "action" },
            ]}
            rows={filteredOrders}
            selectable={false}
          />
        </div>

        {filteredOrders.length > 0 && (
          <div className="mv-dashboard-main">
            <div className="mv-dashboard-content">
              <div className="mv-section-card">
                <h3 className="mv-section-title">Order #{filteredOrders[0]?.id || 1028}</h3>
                <div className="mv-checklist" style={{ gap: '1rem' }}>
                  <div className="mv-checklist-item" style={{ padding: '1rem', background: 'var(--background)' }}>
                    <span style={{ fontWeight: '600', minWidth: '160px' }}>Customer:</span>
                    <span>{filteredOrders[0]?.customer || "John Smith"}</span>
                  </div>
                  <div className="mv-checklist-item" style={{ padding: '1rem', background: 'var(--background)' }}>
                    <span style={{ fontWeight: '600', minWidth: '160px' }}>Shipping:</span>
                    <span>Shipping address placeholder</span>
                  </div>
                  <div className="mv-checklist-item" style={{ padding: '1rem', background: 'var(--background)' }}>
                    <span style={{ fontWeight: '600', minWidth: '160px' }}>Items:</span>
                    <span>{filteredOrders[0]?.items || 3} items</span>
                  </div>
                  <div className="mv-checklist-item" style={{ padding: '1rem', background: 'var(--background)' }}>
                    <span style={{ fontWeight: '600', minWidth: '160px' }}>Retail total:</span>
                    <span>${(filteredOrders[0]?.retailTotal || 149).toFixed(2)}</span>
                  </div>
                  <div className="mv-checklist-item" style={{ padding: '1rem', background: 'var(--background)' }}>
                    <span style={{ fontWeight: '600', minWidth: '160px' }}>MoonVella cost:</span>
                    <span>${(filteredOrders[0]?.moonvillaCost || 92).toFixed(2)}</span>
                  </div>
                  <div className="mv-checklist-item" style={{ padding: '1rem', background: 'var(--background)' }}>
                    <span style={{ fontWeight: '600', minWidth: '160px' }}>Payment:</span>
                    <StatusBadge status={(filteredOrders[0]?.paymentStatus || "Paid").replace(" ", "")} />
                  </div>
                  <div className="mv-checklist-item" style={{ padding: '1rem', background: 'var(--background)' }}>
                    <span style={{ fontWeight: '600', minWidth: '160px' }}>Fulfillment:</span>
                    <StatusBadge status={(filteredOrders[0]?.fulfillmentStatus || "Processing").replace(" ", "")} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mv-section-card">
          <h3 className="mv-section-title">Recent charges</h3>
          <div className="mv-billing-table">
            <div className="mv-billing-header">
              <div className="mv-billing-col mv-col-sm">Order #</div>
              <div className="mv-billing-col">Amount</div>
              <div className="mv-billing-col mv-col-sm">Status</div>
            </div>
            {dummyOrders.slice(0, 5).map((order) => (
              <div key={order.id} className="mv-billing-row">
                <div className="mv-billing-col mv-col-sm">#{order.id}</div>
                <div className="mv-billing-col">${order.retailTotal.toFixed(2)}</div>
                <div className="mv-billing-col mv-col-sm">
                  <StatusBadge status={order.paymentStatus.replace(" ", "")} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </s-page>
  );
}