import { StatusBadge } from "./StatusBadge";
import PropTypes from "prop-types";

export const DataTable = ({ columns, rows, selectable = false, onRowSelect = null }) => {
  return (
    <div className="data-table">
      <table>
        <thead>
          <tr>
            {selectable && (
              <th><input type="checkbox" /></th>
            )}
            {columns.map((column) => (
              <th key={column.key} className="table-header">{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="table-row">
              {columns.map((column) => {
                const value = row[column.key];
                if (column.type === "badge" && value) {
                  return (
                    <td key={`${column.key}-${row.id}`}>
                      <StatusBadge status={value} />
                    </td>
                  );
                }
                if (column.type === "action" && onRowSelect) {
                  return (
                    <td key={`${column.key}-${row.id}`}>
                      <button className="action-btn" onClick={() => onRowSelect(row.id)}>
                        View
                      </button>
                    </td>
                  );
                }
                return (
                  <td key={`${column.key}-${row.id}`}>
                    {value !== undefined ? value : "-"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

DataTable.propTypes = {
  columns: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      type: PropTypes.string,
    })
  ).isRequired,
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  selectable: PropTypes.bool,
  onRowSelect: PropTypes.func,
};