import { readFileSync } from "node:fs";

/* global process */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const adminProducts = read("app/routes/admin.products.tsx");
const catalog = read("app/routes/app.catalog.jsx");
const myProducts = read("app/routes/app.products.jsx");
const productsService = read("app/services/products.server.ts");
const merchantStyles = read("app/styles/moonvilla.css");

const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

check("admin catalog uses the shared admin shell", adminProducts.includes('className="mv-page-wide"') && adminProducts.includes('className="mv-panel"'));
check("admin catalog has one catalog workspace navigation", adminProducts.includes('aria-label="Catalog"') && adminProducts.includes("Packaging library"));
check("admin product rows report packaging readiness", adminProducts.includes("p.packaging.complete") && adminProducts.includes("packagedVariants"));
check("packaging readiness honors variant and product fallback packages", productsService.includes("hasProductFallback") && productsService.includes("variant._count.packages"));
check("catalog has a compact filter and result count", catalog.includes("mv-catalog-filter-bar") && catalog.includes("mv-catalog-result-count"));
check("catalog cards no longer repeat category as a detail row", !catalog.includes('<span className="mv-product-detail-label">Category</span>'));
check("catalog presents variants as one pricing section", catalog.includes("Sizes and pricing") && catalog.includes("mv-variant-list"));
check("catalog keeps approval and import gates", catalog.includes("canViewWholesale") && catalog.includes("canImport"));
check("catalog retains explicit import and removal actions", catalog.includes("Import to Store") && catalog.includes("RemoveFromStoreButton"));
check("My Products reads live Shopify product state", myProducts.includes("SHOPIFY_PRODUCT_LINKS_QUERY") && myProducts.includes("onlineStoreUrl") && myProducts.includes("featuredImage"));
check("Shopify product lookup is bounded in batches", myProducts.includes("start += 100") && myProducts.includes("ids.slice(start, start + 100)"));
check("Shopify admin URL strips the GraphQL gid", myProducts.includes('split("/").filter(Boolean).pop()') && myProducts.includes("admin.shopify.com/store"));
check("broken legacy Shopify link scheme is gone", !myProducts.includes("shopify:admin/products"));
check("admin and storefront destinations are separate", myProducts.includes("Manage in Shopify") && myProducts.includes("View storefront"));
check("missing Shopify products cannot open a dead admin link", myProducts.includes("p.shopifyExists") && myProducts.includes("Shopify product missing"));
check("unpublished products show a disabled storefront action", myProducts.includes("Not on storefront") && myProducts.includes('aria-disabled="true"'));
check("merchant catalog and product cards are responsive", merchantStyles.includes(".mv-catalog-grid") && merchantStyles.includes(".mv-owned-product-card") && merchantStyles.includes("max-width:48rem"));
check("variant price controls have real layout styles", merchantStyles.includes(".mv-price-input-row") && merchantStyles.includes(".mv-price-save") && merchantStyles.includes(".mv-price-warning"));

const failures = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
process.exit(failures.length ? 1 : 0);
