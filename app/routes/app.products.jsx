import React from "react";
import "../styles/moonvilla.css";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { StatCard } from "../components";
import { DataTable } from "../components/DataTable";
import { products as moonvillaProducts } from "../data/moonvillaData";
import { lowStockProducts } from "../data/moonvillaData";
export default function ProductsPage() {
  const products = moonvillaProducts;
  const [selectedTab, setSelectedTab] = React.useState("all");

  const activeListings = products.filter(
    (p) => p.status === "In Stock",
  ).length;

  const unitsSoldLast30Days = 126;

  const estimatedMonthlyProfit = 771;

  const columns = [
    { key: "id", label: "Product", type: "text" },
    { key: "sku", label: "SKU", type: "text" },
    { key: "retailPrice", label: "Retail Price", type: "text" },
    { key: "moonvillaCost", label: "Moonvilla Cost", type: "text" },
    { key: "inventory", label: "Inventory", type: "text" },
    { key: "syncStatus", label: "Sync Status", type: "badge" },
    { key: "margin", label: "Margin", type: "text" },
    { key: "status", label: "Status", type: "badge" },
    { key: "actions", label: "Actions", type: "action" },
  ];

  const rowColumns = [
    { key: "id", label: "Product", type: "text" },
    { key: "sku", label: "SKU", type: "text" },
    { key: "retailPrice", label: "Retail", type: "text" },
    { key: "moonvillaCost", label: "Moonvilla Cost", type: "text" },
    { key: "inventory", label: "Inventory", type: "text" },
    {
      key: "syncStatus",
      label: "Sync Status",
      type: "badge",
    },
    { key: "margin", label: "Margin", type: "text" },
    {
      key: "status",
      label: "Status",
      type: "badge",
    },
    {
      key: "actions",
      label: "Actions",
      type: "action",
    },
  ];

  const statusMap = {
    InStock: "In Stock",
    OutOfStock: "Out of Stock",
    Pending: "Pending",
    Processing: "Processing",
    Shipped: "Shipped",
    Delivered: "Delivered",
    Cancelled: "Cancelled",
  };

  return (
    <s-page heading="My Products">
      <div className="page-content">
        <div className="page-header">
          <h2 className="page-header-title">Your Moonvilla Products</h2>
          <p className="page-header-subtitle">
            Manage imported products, pricing, and inventory sync in one place.
          </p>
        </div>

        <div className="stats-section">
          <StatCard title="Total imported products" value={products.length} subtitle="" />
          <StatCard title="Active listings" value={activeListings} subtitle="" />
          <StatCard title="Units sold last 30 days" value={unitsSoldLast30Days} subtitle="" />
          <StatCard title="Estimated monthly profit" value="${estimatedMonthlyProfit}" subtitle="" />
        </div>

        {lowStockProducts.length > 0 && (
          <div className="low-stock-banner">
            <span className="low-stock-banner-text">
              3 products are low in stock and may need restocking soon.
            </span>
            <div className="low-stock-banner-actions">
              <button className="btn-warning">View Details</button>
              <button className="btn-secondary">Restock</button>
            </div>
          </div>
        )}

        <DataTable
          columns={rowColumns}
          rows={products}
          selectable={false}
        />
      </div>
    </s-page>
  );
}