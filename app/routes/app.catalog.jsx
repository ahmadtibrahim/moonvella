import React from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import { BLOCKED_MESSAGE, withMerchantAccess } from "../services/seller.server";
import { listCatalog } from "../services/catalog.server";
import { mintDownloadToken, downloadUrl } from "../services/downloadToken.server";
import { setSellerRetailPrice, clearSellerRetailPrice } from "../services/sellerPricing.server";
import { useCurrency } from "../components/CurrencyDisplay";
// The image chooser is its own typed component: `.jsx` in this project is never
// typechecked, and the panel holding a copy of somebody's catalogue images is
// the last place a typo should be found by a seller rather than by the compiler.
import ImagePicker from "../components/ImagePicker";
import RetailPriceField from "../components/RetailPriceField";

/**
 * The catalogue is a preview for anybody who is not blocked, and the list
 * itself decides what each caller is allowed to see.
 *
 * `withMerchantAccess` is what makes a blocked store's direct visit to
 * /app/catalog a refusal rather than a preview: the loader is the thing that
 * would have fetched the products, so the guard goes in front of it rather than
 * on top of the page it renders.
 *
 * THE TWO DOWNLOADS ARE LINKS TO ANOTHER WINDOW, not to this page. A merchant
 * app runs inside the Shopify admin's iframe, where two things are true that
 * break an ordinary link: a document navigation drops the frame parameters that
 * authenticate it, and `Content-Disposition: attachment` is blocked by the
 * frame's sandbox. So a download has to open a TOP-LEVEL window, which has no
 * Shopify session at all — and the permission therefore travels in the URL, as
 * a token minted here, for this product, for this seller, minutes ago.
 * `downloadToken.server.ts` carries the reasoning; the short version is that the
 * token replaces the session and never the authorization, and the seller named
 * in it is re-read from the database on the way through.
 *
 * The Files & videos page is a page, not a download, so it stays inside the app
 * and is reached with `<Link>` — a client-side navigation, which keeps the
 * frame parameters that a bare `<a href>` would drop.
 */
export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async (context) => {
    /*
     * The context carries `seller` (the whole row), never `sellerId` — so the
     * id is picked off here. Without it, `listCatalog` skips the seller-price
     * read and a price the seller saved shows as never set: the field falls
     * back to the suggestion and the "Use MoonVella's price" reset never
     * appears, even though the row is in `SellerVariantPrice`.
     */
    const products = await listCatalog({
      canViewWholesale: context.canViewWholesale,
      sellerId: context.seller?.id ?? null,
    });

    /*
     * The marketing pack URL is minted here rather than on the client, because
     * the signing key is the application's secret and exists only on the server.
     * A seller who may not see wholesale prices gets no URL at all: the pack is
     * a wholesale document, and minting a token for a store that cannot open it
     * would be handing out a capability nothing asked for.
     */
    const prepared = context.canViewWholesale && context.seller
      ? products.map((product) => ({
          ...product,
          marketingPackUrl: downloadUrl(
            "/app/marketing-pack",
            mintDownloadToken({
              kind: "marketing_pack",
              resourceId: product.id,
              sellerId: context.seller.id,
            }),
            { productId: product.id }
          ),
        }))
      : products;

    return {
      access: context.access,
      canViewWholesale: context.canViewWholesale,
      canImport: context.canImport,
      products: prepared,
      // Sent as a value rather than read from the server module on the client:
      // the sentence belongs to one constant, but it has to arrive serialized.
      blockedMessage: BLOCKED_MESSAGE,
    };
  });

/**
 * Two things a seller can do on this page, and they are told apart by `intent`.
 *
 *   • `set-retail` / `reset-retail` write the seller's own price for ONE variant
 *     and never talk to Shopify. They are the seller pricing their own shop, so
 *     they need no store admin API and no product id — just the variant.
 *
 *   • The default intent is the import, and it is the only one that reaches
 *     Shopify.
 *
 * THE IMPORT NO LONGER CARRIES PRICES. The form used to post a markup percentage
 * and two overriding amounts, which made the import a second writer of numbers
 * the seller had just typed into their own fields. The price the store is listed
 * at now comes from `SellerVariantPrice`, read by the import itself.
 */
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
    // BUSINESS, not merely "approved": a blocked store is refused with the
    // block sentence rather than a message about wholesale access that would
    // describe a state it is not in.
    context = await requireMerchantAccess(request, "BUSINESS");
  } catch (error) {
    if (error instanceof AccessError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "import");

  if (intent === "set-retail" || intent === "reset-retail") {
    const sellerId = context.seller?.id;
    if (!sellerId) {
      return { ok: false, error: "This account has no seller record yet." };
    }
    const variantId = String(formData.get("variantId") || "");
    if (!variantId) {
      return { ok: false, error: "Missing variant." };
    }

    if (intent === "reset-retail") {
      await clearSellerRetailPrice(sellerId, variantId);
      return { ok: true, reset: true, variantId };
    }

    const amount = parseCents(formData.get("amount"));
    if (amount === null) {
      return {
        ok: false,
        variantId,
        error: "Enter a price as a number, for example 129.99.",
      };
    }

    const result = await setSellerRetailPrice({
      sellerId,
      productVariantId: variantId,
      retailPrice: amount,
    });
    return result.ok
      ? { ok: true, variantId, retailPrice: result.retailPrice }
      : { ok: false, variantId, error: result.error };
  }

  const productId = String(formData.get("productId") || "");
  if (!productId) {
    return { ok: false, error: "Missing product." };
  }

  const { admin } = await authenticate.admin(request);
  const result = await importProductForSeller(admin, context.seller.id, productId, {});

  if (!result.ok) {
    return { ok: false, error: result.error || "Import failed." };
  }

  return {
    ok: true,
    updated: result.updated === true,
    alreadyImported: result.alreadyImported === true,
    shopifyProductId: result.shopifyProductId,
    warnings: result.warnings || [],
  };
};

/**
 * A typed amount in cents, or null when it is not a usable one.
 *
 * A fraction of a cent is rounded rather than refused — `129.999` is a typo for
 * something and the nearest cent is the honest reading — but a value that is not
 * a number at all, or is negative, is refused here so the service's own refusal
 * is reserved for the cases that are about meaning rather than parsing. Zero
 * passes through this function and is refused by the service, which is where the
 * sentence explaining why lives.
 */
function parseCents(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

/**
 * What to call a variant on the card.
 *
 * The option values, not the option names: the product's name has already said
 * what the product is, so "King · Firm" identifies the row and "Size: King ·
 * Firmness: Firm" repeats the schema at the reader. A product sold as one thing
 * has no options at all, and falls back to the variant's own name.
 */
function variantLabel(variant) {
  const values = (variant.options ?? []).map((option) => option.value).filter(Boolean);
  return values.length ? values.join(" · ") : variant.name;
}

export default function CatalogPage() {
  const { access, canViewWholesale, canImport, products, blockedMessage } = useLoaderData();
  const fetcher = useFetcher();
  const currency = useCurrency();

  const [search, setSearch] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState("");
  const [sortBy, setSortBy] = React.useState("name");

  const categories = Array.from(new Set(products.map((p) => p.category))).sort();

  const filtered = products.filter((product) => {
    const matchesSearch =
      product.name.toLowerCase().includes(search.toLowerCase()) ||
      (product.description || "").toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !selectedCategory || product.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "price-low" && canViewWholesale) {
      return a.wholesalePrice - b.wholesalePrice;
    }
    if (sortBy === "price-high" && canViewWholesale) {
      return b.wholesalePrice - a.wholesalePrice;
    }
    return a.name.localeCompare(b.name);
  });

  const statusMessage =
    access === "APPROVED"
      ? null
      : access === "BLOCKED"
        ? blockedMessage
        : access === "SUSPENDED"
        ? "Your seller account is suspended. Wholesale pricing and importing are unavailable."
        : access === "REJECTED"
          ? "Your application was not approved. Wholesale pricing and importing are unavailable."
          : access === "DEACTIVATED"
            ? "Your seller access has been deactivated. Wholesale pricing and importing are locked until MoonVella approves a new application."
            : access === "NEEDS_INFO"
              ? "MoonVella needs more information before deciding your application. Wholesale pricing and importing unlock after approval."
              : "Your application is under review. Wholesale pricing and importing unlock after approval.";

  return (
    <s-page heading="Product Catalog">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">
            {canViewWholesale ? "Product Catalog" : "Product Catalog Preview"}
          </h2>
          <p className="mv-page-subtitle">
            {canViewWholesale
              ? "Wholesale products from MoonVella. Import to your store and start selling."
              : "Browse MoonVella products. Wholesale pricing and import tools unlock after approval."}
          </p>
        </div>

        {statusMessage && (
          <div className="mv-section-card" style={{ marginBottom: "1.5rem" }}>
            <span
              className={`mv-badge ${
                access === "SUSPENDED" ||
                access === "REJECTED" ||
                access === "DEACTIVATED" ||
                access === "BLOCKED"
                  ? "mv-badge-danger"
                  : "mv-badge-warning"
              }`}
            >
              {access}
            </span>
            <p className="mv-page-subtitle" style={{ marginTop: "0.75rem" }}>
              {statusMessage}
            </p>
          </div>
        )}

        <div className="mv-filter-row">
          <input
            type="text"
            className="mv-search-input"
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="mv-filter-group">
            <span className="mv-filter-label">Category</span>
            <select
              className="mv-filter-select"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="">All Categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          {canViewWholesale && (
            <div className="mv-filter-group">
              <span className="mv-filter-label">Sort</span>
              <select
                className="mv-filter-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                <option value="name">Sort by Name</option>
                <option value="price-low">Cost (Low to High)</option>
                <option value="price-high">Cost (High to Low)</option>
              </select>
            </div>
          )}
        </div>

        <div className="mv-product-grid">
          {sorted.map((product) => {
            const unpriced = (product.variants ?? []).filter((v) => v.needsRetailPrice);

            return (
              <div className="mv-product-card" key={product.id}>
                <div className="mv-product-image">
                  {product.image ? (
                    <img
                      src={product.image}
                      alt={product.name}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <span className="mv-product-placeholder">
                      {product.name.substring(0, 2)}
                    </span>
                  )}
                </div>
                <div className="mv-product-info">
                  <h4 className="mv-product-name">{product.name}</h4>
                  <span className="mv-product-category">{product.category}</span>
                </div>

                <div className="mv-product-details">
                  <div className="mv-product-detail-row">
                    <span className="mv-product-detail-label">Category</span>
                    <span className="mv-product-detail-value">{product.category}</span>
                  </div>
                  <div className="mv-product-detail-row">
                    <span className="mv-product-detail-label">Availability</span>
                    <span className="mv-product-detail-value">
                      <span
                        className={`mv-badge ${
                          product.availability === "AVAILABLE"
                            ? "mv-badge-instock"
                            : "mv-badge-danger"
                        }`}
                      >
                        {product.availability === "AVAILABLE" ? "Available" : "Unavailable"}
                      </span>
                    </span>
                  </div>

                  {canViewWholesale && (
                    <div className="mv-product-detail-row">
                      <span className="mv-product-detail-label">Inventory</span>
                      <span className="mv-product-detail-value">{product.inventory}</span>
                    </div>
                  )}
                </div>

                {/*
                  COST AND SUGGESTED RETAIL, PER SELLABLE SIZE.
                  There is no family-level price box any more, and no markup:
                  a product with three sizes has three prices, the seller sets
                  each one, and the only figure they cannot change is what the
                  item costs them — which is why Cost is text and not an input.
                */}
                {canViewWholesale && (product.variants ?? []).length > 0 && (
                  <div className="mv-variant-list">
                    {product.variants.map((variant) => (
                      <div className="mv-variant-row" key={variant.id}>
                        <div className="mv-variant-head">
                          <span className="mv-variant-name">{variantLabel(variant)}</span>
                          <span className="mv-variant-sku">{variant.sku}</span>
                        </div>

                        <div className="mv-variant-cost">
                          <span className="mv-variant-cost-label">Cost $</span>
                          <span className="mv-variant-cost-value">
                            {currency.format(variant.wholesalePrice)}
                          </span>
                        </div>

                        {canImport ? (
                          <RetailPriceField
                            variantId={variant.id}
                            amount={variant.retailPrice}
                            suggested={variant.suggestedRetailPrice}
                            // A price equal to the suggestion is not a change,
                            // even though it is stored as one row: the badge is
                            // about what the seller decided, not about which
                            // table the number came from.
                            hasOverride={
                              variant.hasRetailOverride &&
                              variant.retailPrice !== variant.suggestedRetailPrice
                            }
                            needsRetailPrice={variant.needsRetailPrice}
                            usdRate={currency.usdRate}
                            displayUsd={currency.display === "USD"}
                            disabled={fetcher.state !== "idle"}
                          />
                        ) : (
                          <div className="mv-variant-retail">
                            <span className="mv-variant-cost-label">Suggested Retail $</span>
                            <span className="mv-variant-cost-value">
                              {currency.format(variant.retailPrice)}
                              {variant.hasRetailOverride ? " (set by you)" : ""}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="mv-product-actions">
                  {/* The marketing kit. Approved sellers only, and the route
                      behind the link re-checks that rather than trusting the
                      link: the archive is built from approved, seller-visible
                      records and must never be reachable by URL alone. Opens a
                      top-level window, because a download cannot happen inside
                      the admin's frame. */}
                  {canViewWholesale && product.marketingPackUrl ? (
                    <a
                      className="mv-import-btn"
                      style={{ display: "block", textAlign: "center", marginBottom: "0.4rem" }}
                      href={product.marketingPackUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download marketing pack
                    </a>
                  ) : null}

                  {/* Videos, documents and everything else the merchant has
                      shared. Separate from the image picker because that one
                      decides what an import sends, while this one sends a single
                      file on demand — and a video cannot go through the import.
                      A Link, not an anchor: this is a page inside the app, and a
                      document navigation would drop the frame's parameters and
                      land on the App Bridge bootstrap page. */}
                  <Link
                    className="mv-import-btn"
                    style={{ display: "block", textAlign: "center", marginBottom: "0.4rem" }}
                    to={`/app/product-assets/${encodeURIComponent(product.id)}`}
                  >
                    Files &amp; videos
                  </Link>

                  {canImport ? (
                    <ImagePicker productId={product.id} disabled={fetcher.state !== "idle"} />
                  ) : null}

                  {canImport ? (
                    <fetcher.Form method="post">
                      <input type="hidden" name="productId" value={product.id} />
                      {/*
                        An import that cannot succeed is not offered. Every
                        variant needs a price, a store cannot list one at zero,
                        and the import refuses the whole product if any variant
                        is missing one — so the button waits until the price
                        boxes above have been filled in. The refusal still
                        exists in the service: this is the page agreeing with
                        it, not replacing it.
                      */}
                      <button
                        type="submit"
                        className="mv-import-btn"
                        disabled={fetcher.state !== "idle" || unpriced.length > 0}
                        title={
                          unpriced.length > 0
                            ? "Set a Suggested Retail for every size first."
                            : undefined
                        }
                      >
                        {fetcher.state !== "idle"
                          ? "Importing..."
                          : unpriced.length > 0
                            ? "Set prices to import"
                            : "Import to Store"}
                      </button>
                    </fetcher.Form>
                  ) : (
                    <div
                      style={{
                        color: "var(--text-secondary)",
                        fontSize: "0.75rem",
                        textAlign: "center",
                      }}
                    >
                      Wholesale pricing and import unlock after approval.
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {sorted.length === 0 && (
          <div className="mv-section-card" style={{ textAlign: "center", padding: "3rem" }}>
            <p style={{ color: "var(--text-secondary)", fontSize: "1rem" }}>
              No products found matching your criteria.
            </p>
          </div>
        )}

        {fetcher.data?.ok && fetcher.data?.variantId ? (
          <div className="mv-section-card" style={{ marginTop: "1rem" }}>
            <p style={{ color: "#059669", fontSize: "0.875rem", margin: 0 }}>
              {fetcher.data.reset
                ? "Back to MoonVella's suggested price. Import the product again to update your store."
                : "Retail price saved. Import the product again to update your store."}
            </p>
          </div>
        ) : null}

        {fetcher.data?.ok && !fetcher.data?.variantId && (
          <div className="mv-section-card" style={{ marginTop: "1rem" }}>
            <p style={{ color: "#059669", fontSize: "0.875rem", margin: 0 }}>
              {fetcher.data.updated
                ? "Re-synced to your Shopify store — product, prices and inventory updated."
                : "Imported to your Shopify store. View it under My Products."}
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
