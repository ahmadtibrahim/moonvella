import PropTypes from "prop-types";

export const StatCard = ({ title, value, subtitle = "", className = "" }) => {
  return (
    <div className={`stat-card ${className}`}>
      <span className="stat-card-title">{title}</span>
      <span className="stat-card-value">{value}</span>
      {subtitle && <span className="stat-card-subtitle">{subtitle}</span>}
    </div>
  );
};

StatCard.propTypes = {
  title: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  subtitle: PropTypes.string,
  className: PropTypes.string,
};