import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import {
  getProduct,
  updateProduct,
  addVariant,
  updateVariant,
  deleteVariant,
  addImage,
  deleteImage,
  setMainImage,
  moveImage,
} from "~/services/products.server";
import { saveProductImage } from "~/services/storage.server";
import { listPresets, saveVariantPackages, copyVariantPackaging } from "~/services/packaging.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "products.view");
  const product = await getProduct(String(params.id));
  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }
  const presets = await listPresets();
  return { product, presets };
}

export async function action({ request, params }: ActionFunctionArgs) {
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
  const productId = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "update") {
      await updateProduct(
        productId,
        {
          name: String(form.get("name") || ""),
          sku: String(form.get("sku") || ""),
          category: String(form.get("category") || ""),
          description: String(form.get("description") || ""),
          wholesalePrice: Number(form.get("wholesalePrice")),
          suggestedRetailPrice: Number(form.get("suggestedRetailPrice")),
          costPrice: form.get("costPrice") ? Number(form.get("costPrice")) : null,
          currency: String(form.get("currency") || "CAD"),
        },
        actor
      );
    } else if (intent === "add_variant") {
      await addVariant(
        productId,
        {
          name: String(form.get("name") || ""),
          sku: String(form.get("sku") || ""),
          wholesalePrice: Number(form.get("wholesalePrice")),
          suggestedRetailPrice: Number(form.get("suggestedRetailPrice")),
          costPrice: form.get("costPrice") ? Number(form.get("costPrice")) : null,
          inventory: Number(form.get("inventory")),
          weight: form.get("weight") ? Number(form.get("weight")) : null,
        },
        actor
      );
    } else if (intent === "update_variant") {
      await updateVariant(
        String(form.get("variantId")),
        {
          name: String(form.get("name") || ""),
          sku: String(form.get("sku") || ""),
          wholesalePrice: Number(form.get("wholesalePrice")),
          suggestedRetailPrice: Number(form.get("suggestedRetailPrice")),
          costPrice: form.get("costPrice") ? Number(form.get("costPrice")) : null,
          inventory: Number(form.get("inventory")),
          weight: form.get("weight") ? Number(form.get("weight")) : null,
        },
        actor
      );
    } else if (intent === "delete_variant") {
      await deleteVariant(String(form.get("variantId")), actor);
    } else if (intent === "set_main_image") {
      await setMainImage(String(form.get("imageId")), actor);
    } else if (intent === "move_image_up") {
      await moveImage(String(form.get("imageId")), "up", actor);
    } else if (intent === "move_image_down") {
      await moveImage(String(form.get("imageId")), "down", actor);
    } else if (intent === "add_image_file") {
      const file = form.get("image");
      if (!(file instanceof File) || file.size === 0) {
        throw new Error("Choose an image file to upload.");
      }
      const stored = await saveProductImage(file);
      await addImage(productId, stored.url, String(form.get("alt") || "") || null, actor);
    } else if (intent === "add_image_url") {
      const url = String(form.get("imageUrl") || "").trim();
      if (!/^https?:\/\//.test(url)) throw new Error("Enter a valid http(s) image URL.");
      await addImage(productId, url, String(form.get("alt") || "") || null, actor);
    } else if (intent === "delete_image") {
      await deleteImage(String(form.get("imageId")), actor);
    } else if (intent === "save_packaging") {
      const variantId = String(form.get("variantId"));
      const lengths = form.getAll("pkg_length").map(String);
      const widths = form.getAll("pkg_width").map(String);
      const heights = form.getAll("pkg_height").map(String);
      const dimUnits = form.getAll("pkg_dimUnit").map(String);
      const weights = form.getAll("pkg_weight").map(String);
      const weightUnits = form.getAll("pkg_weightUnit").map(String);
      const unitsPerPackage = form.getAll("pkg_unitsPerPackage").map(String);
      const packagesPerUnit = form.getAll("pkg_packagesPerUnit").map(String);
      const labels = form.getAll("pkg_label").map(String);
      const types = form.getAll("pkg_packageType").map(String);
      const presetIds = form.getAll("pkg_presetId").map(String);
      const rows = lengths.map((l, i) => ({
        label: labels[i],
        packageType: types[i],
        presetId: presetIds[i] || null,
        length: l,
        width: widths[i],
        height: heights[i],
        dimensionUnit: dimUnits[i],
        grossWeight: weights[i],
        weightUnit: weightUnits[i],
        unitsPerPackage: unitsPerPackage[i],
        packagesPerUnit: packagesPerUnit[i],
      }));
      await saveVariantPackages(variantId, rows);
    } else if (intent === "copy_packaging") {
      await copyVariantPackaging(String(form.get("fromVariantId")), String(form.get("toVariantId")));
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }

  return redirect(`/admin/products/${productId}`);
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
const btn = (color: string): React.CSSProperties => ({
  padding: "0.4rem 0.75rem",
  border: `1px solid ${color}`,
  borderRadius: 6,
  background: "white",
  color,
  fontSize: "0.72rem",
  fontWeight: 600,
  cursor: "pointer",
});

export default function AdminProductDetail() {
  const { product, presets } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/products" style={{ color: "#082a4a" }}>
          &larr; All products
        </Link>
      </p>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        {product.name}
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "1.5rem" }}>
        {product.sku} &middot; {product.isArchived ? "Archived" : product.isPublished ? "Published" : "Unpublished"}
      </p>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Product details
        </h2>
        <Form method="post" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
          <input type="hidden" name="intent" value="update" />
          <div>
            <label style={label} htmlFor="edit-name">Title</label>
            <input style={input} id="edit-name" name="name" defaultValue={product.name} required />
          </div>
          <div>
            <label style={label} htmlFor="edit-sku">SKU</label>
            <input style={input} id="edit-sku" name="sku" defaultValue={product.sku} required />
          </div>
          <div>
            <label style={label} htmlFor="edit-category">Category</label>
            <input style={input} id="edit-category" name="category" defaultValue={product.category} required />
          </div>
          <div>
            <label style={label} htmlFor="edit-wholesalePrice">Wholesale price (CAD)</label>
            <input style={input} id="edit-wholesalePrice" name="wholesalePrice" type="number" min="0" step="0.01" defaultValue={(product.wholesalePrice / 100).toFixed(2)} required />
          </div>
          <div>
            <label style={label} htmlFor="edit-suggestedRetailPrice">Suggested retail price (CAD)</label>
            <input style={input} id="edit-suggestedRetailPrice" name="suggestedRetailPrice" type="number" min="0" step="0.01" defaultValue={(product.suggestedRetailPrice / 100).toFixed(2)} required />
          </div>
          <div>
            <label style={label} htmlFor="edit-costPrice">Internal acquisition cost (CAD, owner-only)</label>
            <input style={input} id="edit-costPrice" name="costPrice" type="number" min="0" step="0.01" defaultValue={product.costPrice != null ? (product.costPrice / 100).toFixed(2) : ""} />
          </div>
          <div>
            <label style={label} htmlFor="edit-currency">Currency</label>
            <input style={input} id="edit-currency" name="currency" defaultValue={product.currency} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={label} htmlFor="edit-description">Description</label>
            <textarea style={input} id="edit-description" name="description" rows={2} defaultValue={product.description ?? ""} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={btn("#082a4a")}>Save details</button>
          </div>
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Variants ({product.variants.length})
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1rem" }}>
          {product.variants.map((v) => (
            <Form
              key={v.id}
              method="post"
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 1fr 80px 80px 80px 70px 70px 70px",
                gap: "0.4rem",
                alignItems: "center",
              }}
            >
              <input type="hidden" name="intent" value="update_variant" />
              <input type="hidden" name="variantId" value={v.id} />
              <input style={input} name="name" defaultValue={v.name} title="Name" />
              <input style={input} name="sku" defaultValue={v.sku} title="SKU" />
              <input style={input} name="wholesalePrice" type="number" step="0.01" defaultValue={(v.wholesalePrice / 100).toFixed(2)} title="Wholesale" />
              <input style={input} name="suggestedRetailPrice" type="number" step="0.01" defaultValue={(v.suggestedRetailPrice / 100).toFixed(2)} title="Suggested retail" />
              <input style={input} name="costPrice" type="number" step="0.01" defaultValue={v.costPrice != null ? (v.costPrice / 100).toFixed(2) : ""} title="Cost" />
              <input style={input} name="weight" type="number" step="1" defaultValue={v.weight ?? ""} title="Weight" />
              <input style={input} name="inventory" type="number" defaultValue={v.inventory} title="Inventory" />
              <button type="submit" style={btn("#0369a1")}>Save</button>
            </Form>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {product.variants.map((v) => (
            <Form key={`del-${v.id}`} method="post">
              <input type="hidden" name="intent" value="delete_variant" />
              <input type="hidden" name="variantId" value={v.id} />
              <button type="submit" style={btn("#dc2626")}>
                Delete {v.name}
              </button>
            </Form>
          ))}
        </div>

        <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginTop: "1.25rem", marginBottom: "0.5rem" }}>
          Add variant
        </h3>
        <Form method="post" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr 1fr 1fr", gap: "0.4rem" }}>
          <input type="hidden" name="intent" value="add_variant" />
          <input style={input} name="name" placeholder="Name" required />
          <input style={input} name="sku" placeholder="SKU" required />
          <input style={input} name="wholesalePrice" type="number" placeholder="Wholesale" required />
          <input style={input} name="suggestedRetailPrice" type="number" placeholder="Retail" required />
          <input style={input} name="costPrice" type="number" placeholder="Cost" />
          <input style={input} name="weight" type="number" placeholder="Weight" />
          <input style={input} name="inventory" type="number" placeholder="Inventory" required />
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" style={btn("#059669")}>Add variant</button>
          </div>
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.25rem" }}>
          Shipping &amp; Packaging
        </h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "1rem" }}>
          Enter the outside dimensions and total weight of the package as it will be handed to the carrier. This is the
          default packaging used for quoting; it does not replace the actual measured packing of a multi-item order.
          Presets assist entry but never override measured values.
        </p>
        {product.variants.map((v) => {
          const blanks = Math.max(0, 2 - v.packages.length);
          const rows = [...v.packages, ...Array.from({ length: blanks }).map(() => null)];
          return (
            <div key={v.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.75rem", marginBottom: "0.75rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                {v.name} ({v.sku}) —{" "}
                {v.packages.length === 0 ? (
                  <span style={{ color: "#b45309" }}>Packaging incomplete</span>
                ) : (
                  `${v.packages.length} package row(s)`
                )}
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="save_packaging" />
                <input type="hidden" name="variantId" value={v.id} />
                {rows.map((pkg, i) => (
                  <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginBottom: "0.35rem", alignItems: "center" }}>
                    <input style={{ ...input, width: 110 }} name="pkg_label" placeholder="Label" defaultValue={pkg?.label ?? ""} />
                    <select style={{ ...input, width: 90 }} name="pkg_packageType" defaultValue={pkg?.packageType ?? "carton"}>
                      <option value="carton">Carton</option>
                      <option value="mailer">Mailer</option>
                      <option value="envelope">Envelope</option>
                      <option value="custom">Custom</option>
                    </select>
                    <input style={{ ...input, width: 60 }} name="pkg_length" type="number" step="0.01" placeholder="L" defaultValue={pkg?.length ?? ""} />
                    <input style={{ ...input, width: 60 }} name="pkg_width" type="number" step="0.01" placeholder="W" defaultValue={pkg?.width ?? ""} />
                    <input style={{ ...input, width: 60 }} name="pkg_height" type="number" step="0.01" placeholder="H" defaultValue={pkg?.height ?? ""} />
                    <select style={{ ...input, width: 60 }} name="pkg_dimUnit" defaultValue={pkg?.dimensionUnit ?? "cm"}>
                      <option value="cm">cm</option>
                      <option value="in">in</option>
                    </select>
                    <input style={{ ...input, width: 70 }} name="pkg_weight" type="number" step="0.001" placeholder="kg" defaultValue={pkg?.grossWeight ?? ""} />
                    <select style={{ ...input, width: 60 }} name="pkg_weightUnit" defaultValue={pkg?.weightUnit ?? "kg"}>
                      <option value="kg">kg</option>
                      <option value="lb">lb</option>
                    </select>
                    <input style={{ ...input, width: 60 }} name="pkg_unitsPerPackage" type="number" title="Units of product per package" defaultValue={pkg?.unitsPerPackage ?? 1} />
                    <input style={{ ...input, width: 60 }} name="pkg_packagesPerUnit" type="number" title="Packages per sellable unit" defaultValue={pkg?.packagesPerUnit ?? 1} />
                    <select style={{ ...input, width: 120 }} name="pkg_presetId" defaultValue={pkg?.presetId ?? ""}>
                      <option value="">Preset…</option>
                      {presets.map((pr) => (
                        <option key={pr.id} value={pr.id}>{pr.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
                <div style={{ fontSize: "0.66rem", color: "#94a3b8", marginBottom: "0.4rem" }}>
                  Columns: Label · Type · L · W · H · dim unit · gross weight · weight unit · units/package · packages/unit · preset
                </div>
                <button type="submit" style={btn("#082a4a")}>Save packaging</button>
              </Form>
              {product.variants.length > 1 && (
                <Form method="post" style={{ marginTop: "0.4rem", display: "flex", gap: "0.4rem", alignItems: "center" }}>
                  <input type="hidden" name="intent" value="copy_packaging" />
                  <input type="hidden" name="toVariantId" value={v.id} />
                  <span style={{ fontSize: "0.7rem", color: "#64748b" }}>Copy packaging from</span>
                  <select style={{ ...input, width: 160 }} name="fromVariantId">
                    {product.variants.filter((o) => o.id !== v.id).map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                  <button type="submit" style={btn("#64748b")}>Copy</button>
                </Form>
              )}
            </div>
          );
        })}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "1rem" }}>
          Images ({product.productImages.length})
        </h2>
        {product.productImages.length > 0 && (
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            {product.productImages.map((img, index) => (
              <div key={img.id} style={{ width: 140 }}>
                <div style={{ position: "relative" }}>
                  <img
                    src={img.url}
                    alt={img.alt || product.name}
                    style={{ width: 140, height: 140, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0" }}
                  />
                  {index === 0 ? (
                    <span
                      style={{
                        position: "absolute",
                        top: 6,
                        left: 6,
                        background: "#082a4a",
                        color: "white",
                        fontSize: "0.6rem",
                        fontWeight: 700,
                        padding: "0.15rem 0.4rem",
                        borderRadius: 4,
                      }}
                    >
                      Main
                    </span>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                  {index > 0 ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="set_main_image" />
                      <input type="hidden" name="imageId" value={img.id} />
                      <button type="submit" style={btn("#082a4a")}>Set main</button>
                    </Form>
                  ) : null}
                  {index > 0 ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="move_image_up" />
                      <input type="hidden" name="imageId" value={img.id} />
                      <button type="submit" style={btn("#64748b")} title="Move earlier">
                        &uarr;
                      </button>
                    </Form>
                  ) : null}
                  {index < product.productImages.length - 1 ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="move_image_down" />
                      <input type="hidden" name="imageId" value={img.id} />
                      <button type="submit" style={btn("#64748b")} title="Move later">
                        &darr;
                      </button>
                    </Form>
                  ) : null}
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete_image" />
                    <input type="hidden" name="imageId" value={img.id} />
                    <button type="submit" style={btn("#dc2626")}>Remove</button>
                  </Form>
                </div>
              </div>
            ))}
          </div>
        )}

        <Form method="post" encType="multipart/form-data" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <input type="hidden" name="intent" value="add_image_file" />
          <div>
            <label style={label} htmlFor="img-file">Upload image (PNG/JPEG/WEBP/GIF, max 5MB)</label>
            <input type="file" id="img-file" name="image" accept="image/png,image/jpeg,image/webp,image/gif" />
          </div>
          <div>
            <label style={label} htmlFor="img-alt">Alt text</label>
            <input style={input} id="img-alt" name="alt" />
          </div>
          <button type="submit" style={btn("#082a4a")}>Upload image</button>
        </Form>

        <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", marginTop: "0.75rem", flexWrap: "wrap" }}>
          <input type="hidden" name="intent" value="add_image_url" />
          <div>
            <label style={label} htmlFor="img-url">Or image URL</label>
            <input style={input} id="img-url" name="imageUrl" placeholder="https://..." />
          </div>
          <div>
            <label style={label} htmlFor="img-url-alt">Alt text</label>
            <input style={input} id="img-url-alt" name="alt" />
          </div>
          <button type="submit" style={btn("#082a4a")}>Add URL</button>
        </Form>
      </div>
    </div>
  );
}
