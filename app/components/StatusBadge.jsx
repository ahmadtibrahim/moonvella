import PropTypes from "prop-types";

export const StatusBadge = ({ status }) => {
  const statusClasses = {
    InStock: "status-badge status-instock",
    OutOfStock: "status-badge status-outstock",
    Pending: "status-badge status-pending",
    Processing: "status-badge status-processing",
    Shipped: "status-badge status-shipped",
    Delivered: "status-badge status-delivered",
    Cancelled: "status-badge status-cancelled",
    Paid: "status-badge status-paid",
    Fail: "status-badge status-fail",
  };

  const statusLabels = {
    InStock: "In Stock",
    OutOfStock: "Out of Stock",
    Pending: "Pending",
    Processing: "Processing",
    Shipped: "Shipped",
    Delivered: "Delivered",
    Cancelled: "Cancelled",
    Paid: "Paid",
    Fail: "Failed",
  };

  const className = statusClasses[status] || "status-badge";

  return <span className={className}>{statusLabels[status] || status}</span>;
};

StatusBadge.propTypes = {
  status: PropTypes.string.isRequired,
};