import { Link, useActionData, useLoaderData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { permissionsFor } from "~/services/permissions";
import { createProduct } from "~/services/products.server";
import { PRODUCT_CODE_HELP, suggestProductCode } from "~/utils/productCode";
import {
  card,
  input,
  label,
  btn,
  sectionTitle,
  sectionNote,
  Field,
  CATEGORY_OPTIONS,
  CURRENCY_OPTIONS,
  CatalogueField,
  catalogueValue,
  INK,
  MUTED,
  helpText,
} from "~/components/product/ui";

/**
 * Creating a product.
 *
 * This page exists because a family cannot be described in one line of form
 * fields any more: a product is a name and a code, and everything a buyer
 * actually cares about — size, price, weight, photographs — belongs to a
 * variant that is added next. So the create step is deliberately small, and it
 * lands the merchant in the editor on the Variants tab rather than pretending
 * the product is finished.
 *
 * It also fixes an ordering problem the directive names: a product must exist
 * and be a draft before anything can be uploaded to it. Because the product is
 * created here and the editor only ever edits a stored row, there is no state
 * in which a merchant has attached a file to a product that was never saved.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "products.manage");
  return { exampleCode: suggestProductCode("Cooling Pillow") };
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
    permissions: [...permissionsFor(user.role)],
  };

  const form = await request.formData();

  try {
    const product = await createProduct(
      {
        name: String(form.get("name") || ""),
        productCode: String(form.get("productCode") || ""),
        category: catalogueValue(form, "category"),
        description: String(form.get("description") || "") || null,
        currency: catalogueValue(form, "currency") || "CAD",
      },
      actor
    );

    // Straight to Variants: a product with no variant cannot be published, and
    // it is the next thing that has to happen.
    return redirect(`/admin/products/${product.id}?tab=variants`);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "The product could not be created.",
      values: {
        name: String(form.get("name") || ""),
        productCode: String(form.get("productCode") || ""),
        category: catalogueValue(form, "category"),
        description: String(form.get("description") || ""),
        currency: catalogueValue(form, "currency") || "CAD",
      },
    };
  }
}

export default function AdminProductNew() {
  const actionData = useActionData<typeof action>();
  const { exampleCode } = useLoaderData<typeof loader>();

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/products" style={{ color: INK }}>
          &larr; All products
        </Link>
      </p>

      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: INK, marginBottom: "0.25rem" }}>
        New product
      </h1>
      <p style={{ ...sectionNote, marginBottom: "1.25rem" }}>
        A product is a family — for example, the MoonVella Cooling Pillow. Each size or
        colour you sell is a variant underneath it, with its own SKU and price. You will
        add those next.
      </p>

      {actionData?.error ? (
        <div
          role="alert"
          style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b", fontSize: "0.85rem" }}
        >
          {actionData.error}
        </div>
      ) : null}

      <div style={card}>
        <Form method="post" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.85rem" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <Field id="new-name" label="Product name">
              <input
                style={input}
                id="new-name"
                name="name"
                required
                autoFocus
                defaultValue={actionData?.values.name ?? ""}
                placeholder="MoonVella Cooling Pillow"
              />
            </Field>
          </div>

          <div>
            <Field id="new-code" label="Product Code" hint={PRODUCT_CODE_HELP}>
              <input
                style={input}
                id="new-code"
                name="productCode"
                required
                defaultValue={actionData?.values.productCode ?? ""}
                placeholder={exampleCode}
              />
            </Field>
          </div>

          <div>
            <CatalogueField
              id="new-category"
              label="Category"
              name="category"
              options={CATEGORY_OPTIONS}
              value={actionData?.values.category ?? ""}
              hint="Or type a new one below — anything you type there is used instead."
              placeholder="e.g. Bedding"
            />
          </div>

          <div>
            <CatalogueField
              id="new-currency"
              label="Currency"
              name="currency"
              options={CURRENCY_OPTIONS}
              value={actionData?.values.currency ?? "CAD"}
              hint="Prices on every variant are in this currency."
              placeholder="e.g. NZD"
            />
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <Field
              id="new-description"
              label="Description"
              hint="You can write this later, but a product with no description cannot be published."
            >
              <textarea
                style={input}
                id="new-description"
                name="description"
                rows={3}
                defaultValue={actionData?.values.description ?? ""}
              />
            </Field>
          </div>

          <div style={{ gridColumn: "1 / -1", display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <button type="submit" style={btn(INK, { solid: true })}>
              Create draft product
            </button>
            <Link to="/admin/products" style={{ ...btn(MUTED), lineHeight: "1.2" }}>
              Cancel
            </Link>
          </div>
        </Form>

        <p style={{ ...helpText, marginTop: "0.85rem" }}>
          The product is created as a draft. Nothing is visible to sellers until you
          approve its media and publish it from the Product Details tab.
        </p>
      </div>
    </div>
  );
}
