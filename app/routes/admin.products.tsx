import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import {
  listProducts,
  setArchived,
  setPublished,
  deleteProduct,
  duplicateProduct,
  type ProductListFilters,
} from "~/services/products.server";
import { permissionsFor } from "~/services/permissions";

const STATUSES = ["ALL", "DRAFT", "PENDING_APPROVAL", "PUBLISHED", "ARCHIVED"] as const;

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending approval",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

const STATUS_COLOURS: Record<string, string> = {
  DRAFT: "#64748b",
  PENDING_APPROVAL: "#b45309",
  PUBLISHED: "#059669",
  ARCHIVED: "#94a3b8",
};

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
    // Resolved from the role rather than trusted from the request, so the
    // service layer's cost check is answering to the policy and not to a
    // field an attacker could set.
    permissions: [...permissionsFor(user.role)],
  };

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const productId = String(form.get("productId") || "");

  try {
    // Creating a product now means setting up a family and then giving it at
    // least one sellable variant, which needs the tabbed editor rather than one
    // line of form fields. The list only routes there; /admin/products/new
    // performs the create.
    if (intent === "duplicate") {
      const copy = await duplicateProduct(productId, actor);
      return redirect(`/admin/products/${copy.id}`);
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
            Products
          </h1>
          <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
            MoonVella supplier catalog. A product is a family; each sellable size or
            colour underneath it is a variant with its own SKU and price. The Media
            column counts the files attached to the product — it is not a count of
            variants with pictures, which is shown on the product&rsquo;s Media tab.
          </p>
        </div>
        <Link to="/admin/products/new" style={{ ...btn("#082a4a"), textDecoration: "none", padding: "0.6rem 1.1rem", fontSize: "0.8rem" }}>
          New product
        </Link>
      </div>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

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
            <input id="product-filter-q" style={{ ...input, width: 220 }} name="q" defaultValue={data.filters.q} placeholder="Name, code or variant SKU" />
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
              {STATUSES.filter((s) => s !== "ALL").map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
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
              <span style={gridHead}>Code</span>
              <span style={gridHead}>Category</span>
              <span style={gridHead}>Variants</span>
              <span style={gridHead}>Media</span>
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
                <span style={{ color: "#64748b", fontFamily: "ui-monospace, monospace", fontSize: "0.78rem" }}>
                  {p.productCode}
                </span>
                <span style={{ color: "#64748b" }}>{p.category}</span>
                <span style={{ color: p._count.variants === 0 ? "#b45309" : "#64748b" }}>
                  {p._count.variants === 0 ? "none yet" : p._count.variants}
                </span>
                <span style={{ color: "#64748b" }}>
                  {p._count.mediaAssets}{" "}
                  <span style={{ fontSize: "0.7rem" }}>(media assets for publication)</span>
                </span>
                <span style={{ color: STATUS_COLOURS[p.status] ?? "#64748b", fontWeight: 600 }}>
                  {STATUS_LABELS[p.status] ?? p.status}
                </span>
                <Form method="post" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                  <input type="hidden" name="productId" value={p.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <button
                    type="submit"
                    name="intent"
                    value={p.status === "PUBLISHED" ? "unpublish" : "publish"}
                    style={btn("#0369a1")}
                  >
                    {p.status === "PUBLISHED" ? "Unpublish" : "Publish"}
                  </button>
                  <Link to={`/admin/products/${p.id}`} style={{ ...btn("#64748b"), textDecoration: "none" }}>
                    Edit
                  </Link>
                  <button type="submit" name="intent" value="duplicate" style={btn("#64748b")}>
                    Duplicate
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
