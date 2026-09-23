/**
 * "Preview Odoo import", then "Import as draft".
 *
 * Two steps, both visible, and the second one cannot do anything the first did
 * not show: the import re-reads Odoo at the moment it runs and refuses if the
 * read now reports a problem. A preview that could drift from the import would
 * be a screen that lies, and the whole point of previewing a catalogue import
 * is that nothing arrives in the catalogue that nobody looked at.
 *
 * The page shows what Odoo holds — including the things it does NOT hold, such
 * as a description on a template that has none — because the alternative is an
 * owner discovering a blank field after the fact and having to guess whether
 * MoonVella lost it or Odoo never had it.
 */

import { Form, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin } from "~/utils/adminAuth.server";
import { previewOdooImport, importOdooProducts } from "~/services/odooImport.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "products.view");
  const preview = await previewOdooImport();
  return { preview };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  await requirePermission(request, "products.manage");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent !== "import") return { error: "Unknown action." };

  try {
    const outcome = await importOdooProducts({ confirm: true });
    if (!outcome.executed) {
      return { error: "The import returned a preview instead of a result; nothing was written." };
    }
    return { imported: outcome.result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The import failed." };
  }
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};

function money(value: number, currency: string) {
  return `${currency} ${value.toFixed(2)}`;
}

export default function AdminOdooImport() {
  const { preview } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Odoo import
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.82rem", marginBottom: "1.25rem", lineHeight: 1.6 }}>
        Reads the Odoo products carrying the <strong>MoonVella App</strong> product tag and writes
        them into this catalogue as <strong>drafts</strong>. Nothing is published by an import, and
        nothing in Odoo is changed — inventory is read, never written.
      </p>

      {actionData && "error" in actionData && actionData.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

      {actionData && "imported" in actionData && actionData.imported ? (
        <div style={{ ...card, background: "#f0fdf4", borderColor: "#bbf7d0", color: "#065f46" }}>
          <strong>
            {actionData.imported.created} created, {actionData.imported.updated} updated,{" "}
            {actionData.imported.variantsWritten} variant(s) written.
          </strong>
          <div style={{ fontSize: "0.8rem", marginTop: "0.4rem" }}>
            {actionData.imported.templates.map((item) => (
              <div key={item.odooTemplateId}>
                · {item.outcome} <strong>{item.productCode}</strong> — {item.name} (
                {item.variants.length} variant(s))
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Connection
        </h2>
        <div style={{ fontSize: "0.82rem", color: "#334155", lineHeight: 1.7 }}>
          <div>
            URL: <strong>{preview.connection.url ?? "not configured"}</strong>
          </div>
          <div>
            Database: <strong>{preview.connection.database ?? "not configured"}</strong>
          </div>
          <div>
            Mode: <strong>{preview.connection.mode ?? "unknown"}</strong>
          </div>
          <div>
            Product tag:{" "}
            <strong>
              {preview.tag ? `${preview.tag.name} (id ${preview.tag.id})` : "not found in Odoo"}
            </strong>
          </div>
          <div>
            Consignment:{" "}
            <strong>
              {preview.consignment.location ?? "not configured"}
              {preview.consignment.locationId ? ` (location ${preview.consignment.locationId})` : ""}
              {" · "}
              {preview.consignment.owner ?? "not configured"}
              {preview.consignment.ownerId ? ` (owner ${preview.consignment.ownerId})` : ""}
            </strong>
          </div>
        </div>
        {preview.consignment.note ? (
          <p style={{ fontSize: "0.74rem", color: "#64748b", marginTop: "0.5rem" }}>
            {preview.consignment.note}
          </p>
        ) : null}
      </div>

      {preview.blockers.length > 0 ? (
        <div style={{ ...card, background: "#fffbeb", borderColor: "#fcd34d" }}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#92400e", marginBottom: "0.5rem" }}>
            The import cannot run
          </h2>
          {preview.blockers.map((blocker) => (
            <div key={blocker.code} style={{ marginBottom: "0.6rem" }}>
              <div style={{ fontSize: "0.82rem", color: "#92400e", fontWeight: 600 }}>
                {blocker.message}
              </div>
              <div style={{ fontSize: "0.78rem", color: "#78350f" }}>{blocker.remedy}</div>
            </div>
          ))}
          <p style={{ fontSize: "0.75rem", color: "#78350f" }}>
            No stock or price figures are substituted while Odoo cannot be read. A number that looks
            plausible but did not come from the source is worse than a missing one.
          </p>
        </div>
      ) : null}

      {preview.templates.map((template) => (
        <div key={template.odooTemplateId} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a" }}>
                {template.odooName}
              </h2>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                Odoo template {template.odooTemplateId} · {template.odooCategory} ·{" "}
                {template.currency}
              </div>
            </div>
            <div style={{ fontSize: "0.75rem", color: "#475569", textAlign: "right" }}>
              <div>
                Product Code <strong>{template.productCode}</strong>
              </div>
              <div style={{ color: "#94a3b8" }}>{template.codeSource}</div>
              <div style={{ color: template.existingProductId ? "#059669" : "#94a3b8" }}>
                {template.existingProductId
                  ? "already imported — this will update the existing product"
                  : "not imported yet — this will create a draft"}
              </div>
            </div>
          </div>

          <div style={{ fontSize: "0.78rem", color: "#334155", marginTop: "0.6rem" }}>
            <div>
              Description:{" "}
              {template.description ? (
                <span>{template.description}</span>
              ) : (
                <span style={{ color: "#b45309" }}>
                  none in Odoo — the draft&apos;s description is left empty
                </span>
              )}
            </div>
            <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{template.descriptionSource}</div>
          </div>

          {template.problems.length > 0 ? (
            <div style={{ marginTop: "0.6rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "0.6rem" }}>
              {template.problems.map((problem) => (
                <div key={problem} style={{ fontSize: "0.76rem", color: "#991b1b" }}>
                  · {problem}
                </div>
              ))}
            </div>
          ) : null}

          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem", fontSize: "0.79rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.7rem" }}>
                <th style={th}>Variant</th>
                <th style={th}>SKU</th>
                <th style={th}>Attributes</th>
                <th style={th}>List price</th>
                <th style={th}>Cost</th>
                <th style={th}>Available</th>
              </tr>
            </thead>
            <tbody>
              {template.variants.map((variant) => (
                <tr key={variant.odooVariantId} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>
                    Odoo {variant.odooVariantId}
                    {variant.existingVariantId ? (
                      <span style={{ color: "#059669" }}> (existing)</span>
                    ) : null}
                  </td>
                  <td style={td}>
                    {variant.sku ?? <span style={{ color: "#b91c1c" }}>missing</span>}
                  </td>
                  <td style={td}>
                    {variant.attributes.length
                      ? variant.attributes
                          .map(
                            (attribute) =>
                              `${attribute.attribute}: ${attribute.value}` +
                              (attribute.priceExtra
                                ? ` (+${money(attribute.priceExtra, template.currency)})`
                                : ""),
                          )
                          .join(", ")
                      : "—"}
                  </td>
                  <td style={td}>
                    {money(variant.listPrice, template.currency)}
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                      base {money(variant.basePrice, template.currency)}
                      {variant.priceExtra
                        ? ` + ${money(variant.priceExtra, template.currency)} in attributes`
                        : ""}
                    </div>
                  </td>
                  <td style={td}>
                    {variant.cost === null ? "—" : money(variant.cost, template.currency)}
                  </td>
                  <td style={td}>
                    <strong>{variant.available}</strong>
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                      {variant.onHand} on hand − {variant.reserved} reserved
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {preview.notes.length > 0 ? (
        <div style={card}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>
            Notes
          </h2>
          {preview.notes.map((note) => (
            <div key={note} style={{ fontSize: "0.78rem", color: "#475569" }}>
              · {note}
            </div>
          ))}
        </div>
      ) : null}

      <div style={card}>
        <Form method="post">
          <button
            type="submit"
            name="intent"
            value="import"
            disabled={preview.blockers.length > 0 || preview.templates.length === 0}
            style={{
              padding: "0.7rem 1.1rem",
              border: "1px solid #082a4a",
              borderRadius: 8,
              background: preview.blockers.length > 0 ? "#f1f5f9" : "#082a4a",
              color: preview.blockers.length > 0 ? "#94a3b8" : "white",
              fontWeight: 600,
              fontSize: "0.82rem",
              cursor: preview.blockers.length > 0 ? "not-allowed" : "pointer",
            }}
          >
            Import as draft
          </button>
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.5rem" }}>
            Odoo is read again when this runs. If anything has changed for the worse, the import
            refuses rather than writing a partially-checked catalogue.
          </p>
        </Form>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.3rem 0.4rem", fontWeight: 600 };
const td: React.CSSProperties = { padding: "0.4rem", verticalAlign: "top", color: "#334155" };
