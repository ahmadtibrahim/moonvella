import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import {
  listProducts,
  createProduct,
  setArchived,
  setPublished,
  deleteProduct,
  type ProductListFilters,
} from "~/services/products.server";

const STATUSES = ["ALL", "PUBLISHED", "UNPUBLISHED", "ARCHIVED"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "products.view");
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") || "ALL";
  const status = (STATUSES.includes(statusParam as (typeof STATUSES)[number])
    ? statusParam
    : "ALL") as ProductListFilters["status"];
  const result = await listProducts({
    search: url.searchParams.get("q") || "",
    category: url.searchParams.get("category") || "",
    status,
    page: Number(url.searchParams.get("page") || 1),
  });
  return {
    ...result,
    filters: {
      q: url.searchParams.get("q") || "",
      category: url.searchParams.get("category") || "",
      status: status ?? "ALL",
    },
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "products.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = {
    actorType: "ADMIN_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
  };

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const productId = String(form.get("productId") || "");

  try {
    if (intent === "create") {
      const product = await createProduct(
        {
          name: String(form.get("name") || ""),
          sku: String(form.get("sku") || ""),
          category: String(form.get("category") || ""),
          description: String(form.get("description") || ""),
          wholesalePrice: Number(form.get("wholesalePrice")),
          suggestedRetailPrice: Number(form.get("suggestedRetailPrice")),
          costPrice: form.get("costPrice") ? Number(form.get("costPrice")) : null,
          currency: String(form.get("currency") || "") || String(form.get("currency_new") || "CAD"),
          isPublished: true,
        },
        actor
      );
      return redirect(`/admin/products/${product.id}`);
    }
    if (intent === "archive") {
      await setArchived(productId, true, actor);
    } else if (intent === "restore") {
      await setArchived(productId, false, actor);
    } else if (intent === "publish") {
      await setPublished(productId, true, actor);
    } else if (intent === "unpublish") {
      await setPublished(productId, false, actor);
    } else if (intent === "delete") {
      await deleteProduct(productId, actor);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }

  const returnTo = String(form.get("returnTo") || "");
  return redirect(returnTo.startsWith("/admin/products") ? returnTo : "/admin/products");
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};
const input: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.85rem",
  boxSizing: "border-box",
};
const label: React.CSSProperties = { display: "block", fontSize: "0.72rem", color: "#64748b", marginBottom: "0.25rem" };

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

const gridCols: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2fr 1fr 110px 80px 70px 100px 260px",
  alignItems: "center",
  gap: "0.5rem",
};
const gridHead: React.CSSProperties = { fontSize: "0.7rem", color: "#64748b", fontWeight: 600 };

export default function AdminProducts() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const qs = (overrides: Record<string, string>) => {
    const params = new URLSearchParams();
    if (data.filters.q) params.set("q", data.filters.q);
    if (data.filters.category) params.set("category", data.filters.category);
    if (data.filters.status !== "ALL") params.set("status", data.filters.status);
    if (data.page > 1) params.set("page", String(data.page));
    for (const [k, v] of Object.entries(overrides)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  };
  const returnTo = `/admin/products${qs({})}`;
  const hasFilters = Boolean(data.filters.q || data.filters.category || data.filters.status !== "ALL");

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Products
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        MoonVella supplier catalog. The merchant catalog reads these same records.
      </p>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Add product
        </h2>
        <Form method="post" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
          <input type="hidden" name="intent" value="create" />
          <div>
            <label style={label} htmlFor="prod-name">Title</label>
            <input style={input} id="prod-name" name="name" required />
          </div>
          <div>
            <label style={label} htmlFor="prod-sku">SKU</label>
            <input style={input} id="prod-sku" name="sku" required />
          </div>
          <div>
            <label style={label} htmlFor="prod-category">Category</label>
            <input style={input} id="prod-category" name="category" required />
          </div>
          <div>
            <label style={label} htmlFor="prod-wholesalePrice">Wholesale price (CAD)</label>
            <input style={input} id="prod-wholesalePrice" name="wholesalePrice" type="number" min="0" step="0.01" placeholder="25.00" required />
          </div>
          <div>
            <label style={label} htmlFor="prod-suggestedRetailPrice">Suggested retail price (CAD)</label>
            <input style={input} id="prod-suggestedRetailPrice" name="suggestedRetailPrice" type="number" min="0" step="0.01" placeholder="49.00" required />
          </div>
          <div>
            <label style={label} htmlFor="prod-costPrice">Internal acquisition cost (CAD, owner-only)</label>
            <input style={input} id="prod-costPrice" name="costPrice" type="number" min="0" step="0.01" placeholder="12.00" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={label} htmlFor="prod-description">Description</label>
            <textarea style={input} id="prod-description" name="description" rows={2} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button
              type="submit"
              style={{
                padding: "0.6rem 1.2rem",
                background: "#082a4a",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Create product
            </button>
          </div>
        </Form>
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a" }}>
            Catalog ({data.total})
          </h2>
          <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
            page {data.page} of {data.totalPages}
          </span>
        </div>

        <Form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
          <div>
            <label style={label} htmlFor="product-filter-q">Search</label>
            <input id="product-filter-q" style={{ ...input, width: 220 }} name="q" defaultValue={data.filters.q} placeholder="Name or SKU" />
          </div>
          <div>
            <label style={label} htmlFor="product-filter-category">Category</label>
            <select id="product-filter-category" style={{ ...input, width: 160 }} name="category" defaultValue={data.filters.category}>
              <option value="">All categories</option>
              {data.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={label} htmlFor="product-filter-status">Status</label>
            <select id="product-filter-status" style={{ ...input, width: 150 }} name="status" defaultValue={data.filters.status}>
              <option value="ALL">All</option>
              <option value="PUBLISHED">Published</option>
              <option value="UNPUBLISHED">Unpublished</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
          <button type="submit" style={btn("#082a4a")}>
            Filter
          </button>
          {hasFilters ? (
            <Link to="/admin/products" style={{ ...btn("#64748b"), textDecoration: "none" }}>
              Clear
            </Link>
          ) : null}
        </Form>

        {data.products.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: "0.85rem" }}>No products match these filters.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={gridCols}>
              <span style={gridHead}>Product</span>
              <span style={gridHead}>SKU</span>
              <span style={gridHead}>Wholesale</span>
              <span style={gridHead}>Variants</span>
              <span style={gridHead}>Images</span>
              <span style={gridHead}>Status</span>
              <span style={gridHead}>Actions</span>
            </div>
            {data.products.map((p) => (
              <div
                key={p.id}
                style={{
                  ...gridCols,
                  padding: "0.6rem 0.75rem",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  fontSize: "0.82rem",
                  opacity: p.isArchived ? 0.55 : 1,
                }}
              >
                <Link to={`/admin/products/${p.id}`} style={{ fontWeight: 600, color: "#082a4a" }}>
                  {p.name}
                </Link>
                <span style={{ color: "#64748b" }}>{p.sku}</span>
                <span>{money(p.wholesalePrice, p.currency)}</span>
                <span style={{ color: "#64748b" }}>{p._count.variants}</span>
                <span style={{ color: "#64748b" }}>{p._count.productImages}</span>
                <span style={{ color: "#64748b", fontSize: "0.7rem" }}>(product images for publication)</span>
                <span style={{ color: p.isArchived ? "#64748b" : p.isPublished ? "#059669" : "#b45309" }}>
                  {p.isArchived ? "Archived" : p.isPublished ? "Published" : "Unpublished"}
                </span>
                <Form method="post" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                  <input type="hidden" name="productId" value={p.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button type="submit" name="intent" value={p.isPublished ? "unpublish" : "publish"} style={btn("#0369a1")}>
                    {p.isPublished ? "Unpublish" : "Publish"}
                  </button>
                  <button type="submit" name="intent" value={p.isArchived ? "restore" : "archive"} style={btn(p.isArchived ? "#059669" : "#dc2626")}>
                    {p.isArchived ? "Restore" : "Archive"}
                  </button>
                  <button
                    type="submit"
                    name="intent"
                    value="delete"
                    style={btn("#7f1d1d")}
                    onClick={(event) => {
                      if (!confirm(`Permanently delete "${p.name}"? This cannot be undone. Products referenced by orders must be archived instead.`)) {
                        event.preventDefault();
                      }
                    }}
                  >
                    Delete
                  </button>
                </Form>
              </div>
            ))}
          </div>
        )}

        {data.totalPages > 1 ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
            {data.page > 1 ? (
              <Link to={`/admin/products${qs({ page: String(data.page - 1) })}`} style={{ ...btn("#64748b"), textDecoration: "none" }}>
                Previous
              </Link>
            ) : null}
            {data.page < data.totalPages ? (
              <Link to={`/admin/products${qs({ page: String(data.page + 1) })}`} style={{ ...btn("#64748b"), textDecoration: "none" }}>
                Next
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    padding: "0.35rem 0.6rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: "white",
    color,
    fontSize: "0.68rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}
