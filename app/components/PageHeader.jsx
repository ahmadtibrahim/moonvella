import PropTypes from "prop-types";

export const PageHeader = ({ title, subtitle, actionText, onAction }) => {
  return (
    <div className="page-header">
      <h2 className="page-header-title">{title}</h2>
      {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
      {actionText && onAction && (
        <button className="page-header-action">{actionText}</button>
      )}
    </div>
  );
};

PageHeader.propTypes = {
  title: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  actionText: PropTypes.string,
  onAction: PropTypes.func,
};