import React from "react";
import "../styles/moonvilla.css";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { ProductCard } from "../components/ProductCard";
import { products as moonvillaProducts } from "../data/moonvillaData";
export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    const { authenticate } = await import("../shopify.server");
    await authenticate.admin(request);
  }

  return null;
};

export default function CatalogPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [search, setSearch] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState("");
  const [selectedSize, setSelectedSize] = React.useState("");
  const [selectedFeature, setSelectedFeature] = React.useState("");
  const [sortBy, setSortBy] = React.useState("name");

  const products = moonvillaProducts;

  const filteredProducts = products.filter((product) => {
    const matchesSearch =
      product.name.toLowerCase().includes(search.toLowerCase()) ||
      product.sku.toLowerCase().includes(search.toLowerCase());

    const matchesCategory =
      !selectedCategory || product.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  const sortedProducts = [...filteredProducts].sort((a, b) => {
    if (sortBy === "name") {
      return a.name.localeCompare(b.name);
    }
    if (sortBy === "price-low") {
      return a.wholesaleCost - b.wholesaleCost;
    }
    if (sortBy === "price-high") {
      return b.wholesaleCost - a.wholesaleCost;
    }
    return 0;
  });

  const handleImport = (product) => {
    shopify.toast.show(
      `${product.name} added to My Products. Real Shopify product import will be connected later.`,
    );
  };

  return (
    <s-page heading="Product Catalog">
      <div className="page-content">
        <div className="page-header">
          <h2 className="page-header-title">Product Catalog</h2>
          <p className="page-header-subtitle">
            Premium bedding products from trusted suppliers. Import to your store and start selling today.
          </p>
        </div>

        <div className="features-section">
          <div className="search-wrapper">
            <input
              type="text"
              className="input-field"
              placeholder="Search products..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="filter-wrapper">
            <select
              className="input-field"
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="">Category</option>
              <option value="Pillows">Pillows</option>
              <option value="Duvets">Duvets</option>
              <option value="Mattress Protectors">Mattress Protectors</option>
              <option value="Pillow Protectors">Pillow Protectors</option>
              <option value="Bundles">Bundles</option>
              <option value="All">All</option>
            </select>
          </div>

          <div className="filter-wrapper">
            <select className="input-field" onChange={(e) => setSelectedSize(e.target.value)}>
              <option value="">Size</option>
              <option value="Small">Small</option>
              <option value="Medium">Medium</option>
              <option value="Large">Large</option>
              <option value="All">All</option>
            </select>
          </div>

          <div className="filter-wrapper">
            <select className="input-field" onChange={(e) => setSelectedFeature(e.target.value)}>
              <option value="">Feature</option>
              <option value="Bestseller">Bestseller</option>
              <option value="New">New</option>
              <option value="Popular">Popular</option>
              <option value="Hypoallergenic">Hypoallergenic</option>
            </select>
          </div>

          <div className="filter-wrapper">
            <select className="input-field" onChange={(e) => setSortBy(e.target.value)}>
              <option value="name">Sort by Name</option>
              <option value="price-low">Sort by Wholesale Cost (Low to High)</option>
              <option value="price-high">Sort by Wholesale Cost (High to Low)</option>
            </select>
          </div>
        </div>

        <div className="product-grid">
          {sortedProducts.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onImport={() => handleImport(product)}
            />
          ))}
        </div>
      </div>
    </s-page>
  );
}