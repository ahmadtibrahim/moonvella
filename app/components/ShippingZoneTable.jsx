import PropTypes from "prop-types";
import { DataTable } from "./DataTable";

export const ShippingZoneTable = ({ zones }) => {
  const columns = [
    { key: "name", label: "Zone / Province", type: "text" },
    { key: "supplierShippingCost", label: "Supplier Shipping Cost (CAD)", type: "text" },
    { key: "transit", label: "Transit Time", type: "text" },
    { key: "freeShippingThreshold", label: "Free Shipping Threshold (CAD)", type: "text" },
    { key: "customerDisplay", label: "Customer Display", type: "text" },
    { key: "status", label: "Status", type: "badge" },
    { key: "actions", label: "Actions", type: "action" },
  ];

  return (
    <div className="shipping-zone-table">
      <DataTable
        columns={columns}
        rows={zones}
        selectable={false}
        onRowSelect={null}
      />
    </div>
  );
};

ShippingZoneTable.propTypes = {
  zones: PropTypes.arrayOf(
    PropTypes.shape({
      name: PropTypes.string.isRequired,
      supplierShippingCost: PropTypes.number.isRequired,
      transit: PropTypes.string.isRequired,
      freeShippingThreshold: PropTypes.number.isRequired,
      customerDisplay: PropTypes.string.isRequired,
      status: PropTypes.string.isRequired,
    })
  ).isRequired,
};