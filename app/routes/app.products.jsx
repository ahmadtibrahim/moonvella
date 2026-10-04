import { Link, useFetcher, useLoaderData } from "react-router";
import { withMerchantAccess } from "../services/seller.server";
import { loadLegacyFamilyRetailPrices, loadSellerRetailPrices } from "../services/sellerPricing.server";
import { useCurrency } from "../components/CurrencyDisplay";
import { prisma } from "../db.server";
import { formatDate } from "../utils/dates";

const SHOPIFY_PRODUCT_LINKS_QUERY = `#graphql
  query MoonVellaProductLinks($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        status
        onlineStoreUrl
        featuredImage { url altText }
      }
    }
  }
`;

async function loadShopifyProductLinks(request, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return { checked: true, products: new Map() };

  try {
    const { authenticate } = await import("../shopify.server");
    const { admin } = await authenticate.admin(request);
    const products = new Map();

    for (let start = 0; start < ids.length; start += 100) {
      const response = await admin.graphql(SHOPIFY_PRODUCT_LINKS_QUERY, {
        variables: { ids: ids.slice(start, start + 100) },
      });
      const json = await response.json();
      for (const product of json?.data?.nodes ?? []) {
        if (product?.id) products.set(product.id, product);
      }
    }

    return { checked: true, products };
  } catch {
    // A temporary Shopify read failure must not hide the merchant's MoonVella
    // records. The admin link can still be constructed from the stored id; the
    // storefront link stays unavailable until Shopify confirms it.
    return { checked: false, products: new Map() };
  }
}

/**
 * The imported-product list, with prices and SKUs, for approved sellers.
 *
 * The rows are only read when the caller may see wholesale figures. The page
 * already refused to render them for anybody else, but refusing to render is
 * not the same as not sending: a loader's return value is serialized into the
 * HTML as hydration data, so a suspended seller got the wholesale columns in
 * the page source with a message on top telling them pricing was locked. The
 * gate now sits on the query.
 */
export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async (context) => {
  let imported = [];
  if (context.seller && context.canViewWholesale) {
    const rows = await prisma.sellerProduct.findMany({
      where: { sellerId: context.seller.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        productId: true,
        shopifyProductId: true,
        isActive: true,
        importedAt: true,
        importStatus: true,
        lastImportError: true,
        /*
         * The family's legacy override is still read, and nothing writes it any
         * more: the screen that set it is gone, the price lives per variant now,
         * and a store that set a family price under the old screen must keep
         * being shown the price it is actually listed at. See
         * `loadLegacyFamilyRetailPrices`.
         */
        customWholesalePrice: true,
        // Prices and SKUs live on the sellable variant now, not on the family.
        // A family is a name and a code; the thing with a price is the variant.
        product: {
          select: {
            name: true,
            productCode: true,
            category: true,
            variants: {
              where: { isActive: true },
              orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
              select: {
                // The id, because the seller's prices are keyed on it.
                id: true,
                sku: true,
                wholesalePrice: true,
                suggestedRetailPrice: true,
                isDefault: true,
              },
            },
          },
        },
        variantMappings: {
          select: { productVariant: { select: { sku: true } } },
        },
      },
    });
    const shopify = await loadShopifyProductLinks(
      request,
      rows.map((row) => row.shopifyProductId)
    );

    /*
     * The seller's own prices, in two queries for the whole page. `?` because
     * the row below shows the entry variant's price, which is the figure a
     * family is listed from and the one a seller compares with the catalogue.
     */
    const [pricedByVariant, legacyByProduct] = await Promise.all([
      loadSellerRetailPrices(context.seller.id),
      loadLegacyFamilyRetailPrices(context.seller.id),
    ]);
    imported = rows.map((row) => {
      const variants = row.product.variants;
      // What the seller actually imported, when the import recorded it. Mappings
      // are written by the Shopify export path, so an older row may have none.
      const mapped = row.variantMappings
        .map((mapping) => mapping.productVariant.sku)
        .filter(Boolean);

      // A single SKU column is only honest when the row *is* one sellable item.
      // For a family with several variants the Product Code identifies the row
      // instead, and the count is shown so the row does not imply it is one.
      const singleSku = mapped.length === 1 ? mapped[0] : null;
      const sku = singleSku ?? (variants.length === 1 ? variants[0].sku : row.product.productCode);
      const extraVariants = singleSku
        ? 0
        : Math.max(0, (mapped.length || variants.length) - 1);

      // Family-level prices are the cheapest active variant's — the entry price
      // a seller can actually pay — matching the catalogue page.
      const cheapest = variants.reduce(
        (best, variant) => (!best || variant.wholesalePrice < best.wholesalePrice ? variant : best),
        null
      );
      const familyLegacy = legacyByProduct.get(row.productId) ?? null;
      const cheapestRetail = cheapest
        ? pricedByVariant.get(cheapest.id) ?? familyLegacy ?? cheapest.suggestedRetailPrice
        : 0;
      const remote = row.shopifyProductId
        ? shopify.products.get(row.shopifyProductId) ?? null
        : null;

      return {
        id: row.id,
        productId: row.productId,
        name: row.product.name,
        sku,
        extraVariants,
        category: row.product.category,
        shopifyProductId: row.shopifyProductId,
        shopifyExists: row.shopifyProductId ? (!shopify.checked || remote !== null) : false,
        shopifyChecked: shopify.checked,
        shopifyStatus: remote?.status ?? null,
        storefrontUrl: remote?.onlineStoreUrl ?? null,
        imageUrl: remote?.featuredImage?.url ?? null,
        imageAlt: remote?.featuredImage?.altText ?? row.product.name,
        importedAt: row.importedAt,
        importStatus: row.importStatus,
        lastImportError: row.lastImportError,
        retailPrice: cheapestRetail,
        // "Cost" is what MoonVella invoices the seller — never `costPrice`,
        // which is MoonVella's own acquisition cost and none of the seller's
        // business. See `sellerCostFor` in the import service.
        moonvillaCost: row.customWholesalePrice ?? cheapest?.wholesalePrice ?? 0,
        isActive: row.isActive,
      };
    });
  }

  return {
    access: context.access,
    canImport: context.canImport,
    imported,
    shopDomain: context.shop,
  };
  });

function shopifyProductAdminUrl(shopDomain, productGid) {
  const productId = String(productGid || "").split("/").filter(Boolean).pop();
  const storeHandle = String(shopDomain || "").replace(/\.myshopify\.com$/i, "");
  if (!/^\d+$/.test(productId || "") || !storeHandle) return null;
  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/products/${productId}`;
}

export const action = async ({ request }) => {
  const { requireMerchantAccess, AccessError } = await import(
    "../services/seller.server"
  );
  const { authenticate } = await import("../shopify.server");
  const { importProductForSeller } = await import(
    "../services/shopifyImport.server"
  );

  let context;
  try {
    context = await requireMerchantAccess(request, "BUSINESS");
  } catch (error) {
    if (error instanceof AccessError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");
  if (!productId) {
    return { ok: false, error: "Missing product." };
  }

  const { admin } = await authenticate.admin(request);
  const result = await importProductForSeller(admin, context.seller.id, productId, {
    resync: true,
  });

  if (!result.ok) {
    return { ok: false, productId, error: result.error || "Re-sync failed." };
  }

  return {
    ok: true,
    productId,
    updated: result.updated === true,
    warnings: result.warnings || [],
  };
};

const SYNC_LABELS = {
  NEVER: "Never synced",
  SYNCING: "Syncing",
  SUCCESS: "Synced",
  FAILED: "Failed",
};

function syncBadgeClass(status) {
  if (status === "SUCCESS") return "mv-badge mv-badge-instock";
  if (status === "FAILED") return "mv-badge mv-badge-danger";
  return "mv-badge mv-badge-warning";
}

function storeBadge(product) {
  if (!product.shopifyChecked) {
    return { label: "Shopify status unavailable", className: "mv-badge mv-badge-neutral" };
  }
  if (product.shopifyChecked && !product.shopifyExists) {
    return { label: "Missing in Shopify", className: "mv-badge mv-badge-danger" };
  }
  if (product.storefrontUrl) {
    return { label: "Live on storefront", className: "mv-badge mv-badge-instock" };
  }
  if (product.shopifyStatus === "DRAFT") {
    return { label: "Shopify draft", className: "mv-badge mv-badge-warning" };
  }
  return { label: "Not published online", className: "mv-badge mv-badge-neutral" };
}

export default function ProductsPage() {
  const { access, canImport, imported, shopDomain } = useLoaderData();
  const fetcher = useFetcher();
  const currency = useCurrency();

  if (!canImport) {
    return (
      <s-page heading="My Products">
        <div className="mv-container">
          <div className="mv-page-header">
            <h2 className="mv-page-title">Your MoonVella Products</h2>
            <p className="mv-page-subtitle">
              Manage imported products, pricing, and inventory sync in one place.
            </p>
          </div>
          <div className="mv-section-card" style={{ textAlign: "center", padding: "4rem 2rem" }}>
            <div style={{ fontSize: "4rem", marginBottom: "1.5rem" }}>📦</div>
            <h2 className="mv-page-title" style={{ marginBottom: "1rem" }}>
              No products yet
            </h2>
            <p className="mv-page-subtitle" style={{ maxWidth: "500px", margin: "0 auto 2rem" }}>
              Product import is available to approved MoonVella sellers. Current status: {access}.
            </p>
            <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
              <Link className="mv-btn mv-btn-primary" to="/app/status">
                View Application Status
              </Link>
              <Link className="mv-btn mv-btn-secondary" to="/app/application">
                Edit Application
              </Link>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  const liveListings = imported.filter((p) => Boolean(p.storefrontUrl)).length;
  const needsAttention = imported.filter(
    (p) => p.importStatus === "FAILED" || (p.shopifyChecked && !p.shopifyExists)
  ).length;

  return (
    <s-page heading="My Products">
      <div className="mv-container">
        <div className="mv-page-header mv-page-header-split">
          <div>
            <h2 className="mv-page-title">My Products</h2>
            <p className="mv-page-subtitle">
              Manage the MoonVella products connected to your Shopify store.
            </p>
          </div>
          <Link className="mv-btn mv-btn-primary" to="/app/catalog">
            Add products
          </Link>
        </div>

        <div className="mv-stats-grid mv-stats-grid-compact">
          <div className="mv-stat-card">
            <div className="mv-stat-title">Imported products</div>
            <div className="mv-stat-value">{imported.length}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Live storefront</div>
            <div className="mv-stat-value">{liveListings}</div>
          </div>
          <div className="mv-stat-card">
            <div className="mv-stat-title">Needs attention</div>
            <div className="mv-stat-value">{needsAttention}</div>
          </div>
        </div>

        {imported.length === 0 ? (
          <div className="mv-section-card" style={{ textAlign: "center", padding: "3rem" }}>
            <p className="mv-page-subtitle" style={{ marginBottom: "1.5rem" }}>
              You have not imported any MoonVella products yet.
            </p>
            <Link className="mv-btn mv-btn-primary" to="/app/catalog">
              Browse the catalog
            </Link>
          </div>
        ) : (
          <div className="mv-owned-product-grid">
            {imported.map((p) => {
              const adminUrl = shopifyProductAdminUrl(shopDomain, p.shopifyProductId);
              const shopify = storeBadge(p);
              const syncing = fetcher.state !== "idle" && fetcher.formData?.get("productId") === p.productId;

              return (
                <article className="mv-owned-product-card" key={p.id}>
                  <div className="mv-owned-product-image">
                    {p.imageUrl ? <img src={p.imageUrl} alt={p.imageAlt} /> : <span>{p.name.slice(0, 2)}</span>}
                  </div>
                  <div className="mv-owned-product-body">
                    <div className="mv-owned-product-heading">
                      <div>
                        <span className="mv-product-category">{p.category}</span>
                        <h3>{p.name}</h3>
                        <p className="mv-owned-product-sku">
                          {p.sku}{p.extraVariants > 0 ? ` +${p.extraVariants} variants` : ""}
                        </p>
                      </div>
                      <span className={shopify.className}>{shopify.label}</span>
                    </div>

                    <div className="mv-owned-product-prices">
                      <div><span>Your retail from</span><strong>{currency.format(p.retailPrice)}</strong></div>
                      <div><span>MoonVella cost from</span><strong>{currency.format(p.moonvillaCost)}</strong></div>
                    </div>

                    <div className="mv-owned-product-sync">
                      <span className={syncBadgeClass(p.importStatus)} title={p.lastImportError || undefined}>
                        {SYNC_LABELS[p.importStatus] || p.importStatus}
                      </span>
                      <span>Imported {p.importedAt ? formatDate(p.importedAt) : "date unavailable"}</span>
                    </div>
                    {p.lastImportError ? <p className="mv-inline-error">{p.lastImportError}</p> : null}

                    <div className="mv-owned-product-actions">
                      {adminUrl && p.shopifyExists ? (
                        <a className="mv-btn mv-btn-secondary" href={adminUrl} target="_blank" rel="noreferrer">
                          Manage in Shopify
                        </a>
                      ) : (
                        <span className="mv-btn mv-btn-disabled" aria-disabled="true">Shopify product missing</span>
                      )}
                      {p.storefrontUrl ? (
                        <a className="mv-btn mv-btn-secondary" href={p.storefrontUrl} target="_blank" rel="noreferrer">
                          View storefront
                        </a>
                      ) : (
                        <span className="mv-btn mv-btn-disabled" aria-disabled="true" title="Publish this product to the Online Store sales channel in Shopify first.">
                          Not on storefront
                        </span>
                      )}
                      {p.shopifyProductId ? (
                        <fetcher.Form method="post">
                          <input type="hidden" name="productId" value={p.productId} />
                          <button type="submit" className="mv-btn mv-btn-primary" disabled={fetcher.state !== "idle"}>
                            {syncing ? "Syncing…" : "Re-sync"}
                          </button>
                        </fetcher.Form>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {fetcher.data?.ok && (
          <div className="mv-section-card" style={{ marginTop: "1rem" }}>
            <p style={{ color: "#059669", fontSize: "0.875rem", margin: 0 }}>
              {fetcher.data.updated
                ? "Re-synced with Shopify — prices and inventory updated."
                : "Re-sync completed."}
            </p>
            {fetcher.data.warnings?.length > 0 && (
              <ul
                style={{
                  margin: "0.5rem 0 0",
                  paddingLeft: "1.25rem",
                  color: "var(--text-secondary)",
                  fontSize: "0.8rem",
                }}
              >
                {fetcher.data.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {fetcher.data?.error && (
          <div className="mv-section-card" style={{ marginTop: "1rem" }}>
            <p style={{ color: "var(--danger-red)", fontSize: "0.875rem", margin: 0 }}>
              {fetcher.data.error}
            </p>
          </div>
        )}
      </div>
    </s-page>
  );
}
