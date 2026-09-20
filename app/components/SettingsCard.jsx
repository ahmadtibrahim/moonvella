import PropTypes from "prop-types";

export const SettingsCard = ({ title, children }) => {
  return (
    <div className="settings-card">
      <h3 className="settings-card-title">{title}</h3>
      <div className="settings-card-content">{children}</div>
    </div>
  );
};

SettingsCard.propTypes = {
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
};