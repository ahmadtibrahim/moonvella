import PropTypes from "prop-types";

export const ProductCard = ({ product, onImport = null, showActions = true }) => {
  const { name, sku, category, wholesaleCost, suggestedRetail, inventory, estimatedProfit, tags } = product;

  return (
    <div className="product-card">
      <div className="product-card-image">
        <div className="product-image-placeholder">
          {name.substring(0, 2)}
        </div>
      </div>
      <div className="product-card-info">
        <h3 className="product-card-name">{name}</h3>
        <p className="product-card-sku">SKU: {sku}</p>
        <p className="product-card-category">{category}</p>
      </div>
      <div className="product-card-details">
        <div className="product-detail-row">
          <span className="product-detail-label">Wholesale</span>
          <span className="product-detail-value">${wholesaleCost.toFixed(2)}</span>
        </div>
        <div className="product-detail-row">
          <span className="product-detail-label">Retail</span>
          <span className="product-detail-value">${suggestedRetail.toFixed(2)}</span>
        </div>
        <div className="product-detail-row">
          <span className="product-detail-label">Profit</span>
          <span className="product-detail-value">${estimatedProfit.toFixed(2)}</span>
        </div>
        <div className="product-detail-row">
          <span className="product-detail-label">Inventory</span>
          <span className="product-detail-value">{inventory}</span>
        </div>
      </div>
      <div className="product-card-tags">
        {tags.map((tag, i) => (
          <span key={i} className="product-tag">{tag}</span>
        ))}
      </div>
      {showActions && (
        <div className="product-card-actions">
          <button className="product-card-import-btn" onClick={() => onImport?.(product)}>
            Import to Store
          </button>
        </div>
      )}
    </div>
  );
};

ProductCard.propTypes = {
  product: PropTypes.shape({
    name: PropTypes.string.isRequired,
    sku: PropTypes.string.isRequired,
    category: PropTypes.string.isRequired,
    wholesaleCost: PropTypes.number.isRequired,
    suggestedRetail: PropTypes.number.isRequired,
    inventory: PropTypes.number.isRequired,
    estimatedProfit: PropTypes.number.isRequired,
    tags: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
  onImport: PropTypes.func,
  showActions: PropTypes.bool,
};