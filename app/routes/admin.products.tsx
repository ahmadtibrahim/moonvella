import { useState } from "react";
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

/*
 * PENDING_APPROVAL is absent on purpose. Nothing ever read it — there was no
 * approver queue to read it from — so the filter offered a view of products
 * that were, in every way the app consults, drafts. The enum value survives in
 * the database for history and for rows that were parked there before this
 * change; no screen offers it, and none should.
 */
const STATUSES = ["ALL", "DRAFT", "PUBLISHED", "ARCHIVED"] as const;

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

const STATUS_COLOURS: Record<string, string> = {
  DRAFT: "#64748b",
  PUBLISHED: "#059669",
  ARCHIVED: "#94a3b8",
};

/**
 * What to say after an action, so a press that worked does not look like a
 * press that did nothing.
 *
 * A redirect back to the same list is invisible: the row's status changes, but
 * only if the reader happens to remember what it said before. Each action
 * therefore names itself in the URL and the list says it back in words.
 */
const DONE_MESSAGES: Record<string, string> = {
  publish: "Published to sellers.",
  unpublish: "Withdrawn from sellers. Existing orders are unaffected.",
  archive: "Archived. Sellers no longer see it.",
  restore: "Restored as a draft, so it has to pass the publication checks again before sellers see it.",
  delete: "Deleted.",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requirePermission(request, "products.view");
  const held = permissionsFor(user.role);
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
  const done = url.searchParams.get("done") || "";
  return {
    ...result,
    done: DONE_MESSAGES[done] ?? "",
    // Whether to draw the Publish and Withdraw buttons at all. The control is
    // the check in the action and the service behind it, not this flag.
    canPublish: held.has("products.publish"),
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
  const base = returnTo.startsWith("/admin/products") ? returnTo : "/admin/products";
  return redirect(`${base}${base.includes("?") ? "&" : "?"}done=${intent}`);
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};
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
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>Product catalog</h1>
          <p>Products, variants, media and the packaging each order will use.</p>
        </div>
        <Link to="/admin/products/new" className="mv-button mv-button-dark">
          New product
        </Link>
      </div>

      <nav className="mv-workspace-nav" aria-label="Catalog">
        <Link to="/admin/products" className="is-active">Products</Link>
        <Link to="/admin/packaging">Packaging library</Link>
        <Link to="/admin/odoo">Odoo import</Link>
      </nav>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

      {data.done ? (
        <div
          role="status"
          style={{ ...card, background: "#f0fdf4", borderColor: "#bbf7d0", color: "#065f46", fontSize: "0.85rem", marginBottom: "1rem" }}
        >
          {data.done}
        </div>
      ) : null}

      <Form method="get" className="mv-filter-bar">
          <label className="mv-field" htmlFor="product-filter-q">Search
            <input id="product-filter-q" className="mv-input" name="q" defaultValue={data.filters.q} placeholder="Name, code or variant SKU" />
          </label>
          <label className="mv-field" htmlFor="product-filter-category">Category
            <select id="product-filter-category" className="mv-input" name="category" defaultValue={data.filters.category}>
              <option value="">All categories</option>
              {data.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="mv-field" htmlFor="product-filter-status">Status
            <select id="product-filter-status" className="mv-input" name="status" defaultValue={data.filters.status}>
              <option value="ALL">All</option>
              {STATUSES.filter((s) => s !== "ALL").map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="mv-button mv-button-dark">Filter</button>
          {hasFilters ? (
            <Link to="/admin/products" className="mv-button">Clear</Link>
          ) : null}
      </Form>

      <section className="mv-panel">
        <div className="mv-panel-header">
          <div><h2>Products</h2><p>{data.total} catalog products</p></div>
          <span className="mv-badge">Page {data.page} of {data.totalPages}</span>
        </div>
        {data.products.length === 0 ? (
          <div className="mv-panel-body mv-muted">No products match these filters.</div>
        ) : (
          <div className="mv-table-wrap">
            <table className="mv-table mv-catalog-table">
              <thead><tr><th>Product</th><th>Category</th><th>Variants</th><th>Media</th><th>Packaging</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>{data.products.map((p) => (
              <tr key={p.id} style={{ opacity: p.isArchived ? 0.55 : 1 }}>
                <td><Link to={`/admin/products/${p.id}`}>{p.name}</Link><div className="mv-muted mv-mono">{p.productCode}</div></td>
                <td className="mv-muted">{p.category}</td>
                <td className="mv-muted">{p._count.variants === 0 ? "None" : p._count.variants}</td>
                <td className="mv-muted">{p._count.mediaAssets}</td>
                <td><span className={p.packaging.complete ? "mv-badge mv-badge-success" : "mv-badge mv-badge-warning"}>
                  {p.packaging.complete ? "Ready" : p.packaging.totalVariants === 0 ? "No variants" : `${p.packaging.packagedVariants}/${p.packaging.totalVariants}`}
                </span></td>
                <td><span className="mv-badge" style={{ color: STATUS_COLOURS[p.status] ?? "#64748b" }}>{STATUS_LABELS[p.status] ?? p.status}</span></td>
                <td><Form method="post" className="mv-actions">
                  <input type="hidden" name="productId" value={p.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  {/*
                    Publishing is a separate permission from editing, so this
                    button is drawn only for the roles that hold it. A row
                    without it is still fully editable — the catalogue role
                    prepares the record, an owner or administrator releases it.
                  */}
                  {data.canPublish ? (
                    <button
                      type="submit"
                      name="intent"
                      value={p.status === "PUBLISHED" ? "unpublish" : "publish"}
                      className="mv-button mv-button-primary"
                    >
                      {p.status === "PUBLISHED" ? "Unpublish" : "Publish"}
                    </button>
                  ) : null}
                  <Link to={`/admin/products/${p.id}`} className="mv-button">Edit</Link>
                  <button type="submit" name="intent" value="duplicate" className="mv-button">Duplicate</button>
                  <button type="submit" name="intent" value={p.isArchived ? "restore" : "archive"} className={p.isArchived ? "mv-button" : "mv-button mv-button-danger"}>
                    {p.isArchived ? "Restore" : "Archive"}
                  </button>
                  <ArmedDelete name={p.name} />
                </Form></td>
              </tr>
            ))}</tbody></table>
          </div>
        )}

        {data.totalPages > 1 ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
            {data.page > 1 ? (
              <Link to={`/admin/products${qs({ page: String(data.page - 1) })}`} className="mv-button">
                Previous
              </Link>
            ) : null}
            {data.page < data.totalPages ? (
              <Link to={`/admin/products${qs({ page: String(data.page + 1) })}`} className="mv-button">
                Next
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function btn(color: string, solid = false): React.CSSProperties {
  return {
    padding: "0.35rem 0.6rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: solid ? color : "white",
    color: solid ? "white" : color,
    fontSize: "0.68rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}

/**
 * Delete, asked twice — and never through a browser dialog.
 *
 * This button used to open a `confirm()` box. Chrome offers "Prevent this page
 * from creating additional dialogs" the second or third time a page asks, and
 * once that is ticked every later `confirm()` returns false *without ever
 * appearing* — so Delete stops working while its confirm-free neighbours carry
 * on, and the page offers no reason why. That is exactly the report this
 * replaced. The question is asked inside the row instead, which nothing can
 * switch off.
 *
 * It submits the row's own form rather than a nested one: a form inside a form
 * is invalid HTML, and the inner one would swallow the productId the action
 * needs to know what to delete.
 */
function ArmedDelete({ name }: { name: string }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button type="button" style={btn("#7f1d1d")} onClick={() => setArmed(true)}>
        Delete
      </button>
    );
  }

  return (
    <>
      {/* Announced as well as shown, so the second press is never a surprise. */}
      <span role="status" style={{ fontSize: "0.68rem", color: "#7f1d1d", maxWidth: 170 }}>
        Delete &ldquo;{name}&rdquo; for good? Products on orders must be archived instead.
      </span>
      <button type="submit" name="intent" value="delete" style={btn("#7f1d1d", true)}>
        Yes, delete
      </button>
      <button type="button" style={btn("#64748b")} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </>
  );
}
