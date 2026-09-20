import React from "react";
import "../styles/moonvilla.css";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { StatusBadge } from "../components/StatusBadge";
import { DataTable } from "../components/DataTable";
import { dummyOrders } from "../data/moonvillaData";
const orderStatuses = ["All", "Pending", "Processing", "Shipped", "Delivered", "Cancelled"];

export default function OrdersPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
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

  const statusBadges = {
    Paid: "status-badge status-paid",
    Pending: "status-badge status-pending",
    Failed: "status-badge status-fail",
    Processing: "status-badge status-processing",
    Shipped: "status-badge status-shipped",
    Delivered: "status-badge status-delivered",
    Cancelled: "status-badge status-cancelled",
  };

  const fulfillmentBadges = {
    Paid: "status-badge status-paid",
    Pending: "status-badge status-pending",
    Failed: "status-badge status-fail",
    Processing: "status-badge status-processing",
    Shipped: "status-badge status-shipped",
    Delivered: "status-badge status-delivered",
    Cancelled: "status-badge status-cancelled",
  };

  const paymentBadges = {
    Paid: "status-badge status-paid",
    Pending: "status-badge status-pending",
    Failed: "status-badge status-fail",
  };

  return (
    <s-page heading="Orders">
      <div className="page-content">
        <div className="page-header">
          <h2 className="page-header-title">Orders</h2>
          <p className="page-header-subtitle">
            Manage and track all Moonvilla orders. View order details, fulfillment status, and billing information.
          </p>
        </div>

        <div className="orders-controls">
          <div className="tab-nav">
            {orderStatuses.map((status) => (
              <button
                key={status}
                className={`tab-nav-btn ${selectedStatus === status ? "active" : ""}`}
                onClick={() => setSelectedStatus(status)}
              >
                {status}
              </button>
            ))}
          </div>

          <div className="search-wrapper">
            <input
              type="text"
              className="input-field"
              placeholder="Search orders, customers, or products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <DataTable
          columns={[
            { key: "retailerOrder", label: "Retailer order #", type: "text" },
            { key: "customer", label: "Customer", type: "text" },
            { key: "items", label: "Items", type: "text" },
            { key: "retailTotal", label: "Retail total", type: "text" },
            { key: "moonvillaCost", label: "Moonvilla cost", type: "text" },
            { key: "paymentStatus", label: "Payment status", type: "badge" },
            { key: "fulfillmentStatus", label: "Fulfillment status", type: "badge" },
            { key: "tracking", label: "Tracking", type: "text" },
            { key: "date", label: "Date", type: "text" },
            { key: "actions", label: "Actions", type: "action" },
          ]}
          rows={filteredOrders}
          selectable={false}
        />

        {filteredOrders.length > 0 && (
          <div className="order-detail-card">
            <div className="order-detail-header">
              <span>Order #{filteredOrders[0]?.id || 1028}</span>
            </div>
            <div className="order-detail-content">
              <p className="order-detail-customer">Customer name: {filteredOrders[0]?.customer || "John Smith"}</p>
              <p className="order-detail-address">Shipping address placeholder</p>
              <div className="order-detail-items">
                <strong>Items:</strong> {filteredOrders[0]?.items || 3} items
              </div>
              <div className="order-detail-totals">
                <span>Retail total: ${(filteredOrders[0]?.retailTotal || 149).toFixed(2)}</span>
                <span>Moonvilla cost: ${(filteredOrders[0]?.moonvillaCost || 92).toFixed(2)}</span>
              </div>
              <StatusBadge status={(filteredOrders[0]?.paymentStatus || "Paid").replace(" ", "")} />
              <StatusBadge status={(filteredOrders[0]?.fulfillmentStatus || "Processing").replace(" ", "")} />
            </div>
          </div>
        )}

        <div className="billing-activity">
          <h4>Recent charges</h4>
          <div className="billing-table">
            <div className="billing-row">
              <span>Order #</span>
              <span>Amount</span>
              <span>Status</span>
            </div>
            {dummyOrders.slice(0, 5).map((order) => (
              <div key={order.id} className="billing-row">
                <span>#{order.id}</span>
                <span>${order.retailTotal.toFixed(2)}</span>
                <StatusBadge status={order.paymentStatus.replace(" ", "")} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </s-page>
  );
}