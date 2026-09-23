import { Form, Link, useSearchParams } from "react-router";
import {
  card,
  input,
  btn,
  sectionTitle,
  sectionNote,
  Field,
  StatusChip,
  EmptyState,
  ConfirmForm,
  money,
  centsToInput,
  cmToInches,
  kgToPounds,
  INK,
  MUTED,
  FAINT,
  LINE,
  helpText,
} from "./ui";

/**
 * Variants — the things that are actually sold.
 *
 * A variant is where every commercial and physical fact lives: SKU, prices,
 * stock, measurements, the carton it ships in. The family above it is a name.
 * That is why this tab is the busiest one and why the product cannot be
 * published until at least one variant exists and has a default.
 *
 * MEASUREMENT UNITS. The canonical storage is centimetres and kilograms, and
 * the inputs on this form are those. The inches and pounds beside each box are
 * computed for reading only — they are not submitted and cannot become the
 * stored value. The alternative, a unit toggle that converts on save, makes the
 * number in the database depend on which toggle was last touched, and that is
 * precisely the ambiguity the canonical unit exists to remove.
 */

interface VariantOption {
  id?: string;
  name: string;
  value: string;
}

interface Package {
  id: string;
  label: string | null;
  packageType: string;
  presetId: string | null;
  length: number;
  width: number;
  height: number;
  dimensionUnit: string;
  grossWeight: number;
  weightUnit: string;
  unitsPerPackage: number;
  packagesPerUnit: number;
  /** The four facts a quote may also be told about the parcel. */
  description: string | null;
  declaredValue: number | null;
  shipsSeparately: boolean;
  consolidatable: boolean;
}

interface Variant {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  costPrice: number | null;
  inventory: number;
  isActive: boolean;
  isDefault: boolean;
  productWeightKg: unknown;
  productLengthCm: unknown;
  productWidthCm: unknown;
  productHeightCm: unknown;
  unitsPerPackage: number;
  variantOptions: VariantOption[];
  packages: Package[];
}

/**
 * A standard carton, as stored.
 *
 * Note what it is not: it carries no gross weight and no units per carton,
 * because those belong to what is being shipped rather than to the box. A
 * preset is the empty carton — its measurements, its tare weight and the most
 * it may hold — and a variant fills in the rest.
 */
interface Preset {
  id: string;
  name: string;
  packageType: string;
  length: number;
  width: number;
  height: number;
  dimensionUnit: string;
  emptyWeight: number | null;
  weightUnit: string;
  maxWeight: number | null;
}

interface Product {
  id: string;
  currency: string;
  variants: Variant[];
}

function dec(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export default function VariantsTab({
  product,
  presets,
  canEditCost,
}: {
  product: Product;
  presets: Preset[];
  canEditCost: boolean;
}) {
  const [params] = useSearchParams();
  // Which variant's editor is open. Held in the URL so a half-finished edit
  // survives a refresh — the directive's "do not lose work on refresh" applies
  // to an accidentally reloaded page as much as to a navigation.
  const editing = params.get("variant") ?? "";
  const adding = params.get("new") === "1";

  if (product.variants.length === 0 && !adding) {
    return (
      <div style={card}>
        <h2 style={sectionTitle}>Variants</h2>
        <EmptyState>
          This product has no variants yet, so there is nothing to sell. A product becomes
          sellable when it has at least one variant — a size, a colour, a pack — with its own SKU
          and prices.
        </EmptyState>
        <p style={{ marginTop: "0.85rem" }}>
          <Link to="?tab=variants&new=1" style={{ ...btn(INK, { solid: true }), lineHeight: "1.2" }}>
            Add the first variant
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem" }}>
          <div>
            <h2 style={sectionTitle}>Variants</h2>
            <p style={{ ...sectionNote, marginBottom: 0 }}>
              Each variant is one sellable item with its own SKU and price. The default is the one
              the catalogue shows when a seller does not choose.
            </p>
          </div>
          {!adding ? (
            <Link to="?tab=variants&new=1" style={{ ...btn(INK, { solid: true }), lineHeight: "1.2" }}>
              Add variant
            </Link>
          ) : null}
        </div>
      </div>

      {adding ? (
        <VariantForm
          product={product}
          presets={presets}
          canEditCost={canEditCost}
          mode="add"
        />
      ) : null}

      {product.variants.map((variant) =>
        editing === variant.id ? (
          <VariantForm
            key={variant.id}
            product={product}
            presets={presets}
            canEditCost={canEditCost}
            mode="edit"
            variant={variant}
          />
        ) : (
          <VariantCard
            key={variant.id}
            variant={variant}
            currency={product.currency}
            canEditCost={canEditCost}
            presets={presets}
          />
        )
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Read view                                                                  */
/* -------------------------------------------------------------------------- */

function VariantCard({
  variant,
  currency,
  canEditCost,
  presets,
}: {
  variant: Variant;
  currency: string;
  canEditCost: boolean;
  presets: Preset[];
}) {
  const carton = variant.packages[0] ?? null;
  const margin =
    variant.costPrice !== null ? variant.suggestedRetailPrice - variant.costPrice : null;

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: INK }}>{variant.name}</span>
            {variant.isDefault ? <StatusChip status="DEFAULT" /> : null}
            {!variant.isActive ? <StatusChip status="INACTIVE" /> : null}
          </div>
          <div style={{ fontSize: "0.78rem", color: MUTED, marginTop: "0.2rem" }}>
            <code>{variant.sku}</code>
            {variant.barcode ? <> &middot; {variant.barcode}</> : null}
          </div>
          {variant.variantOptions.length ? (
            <div style={{ fontSize: "0.75rem", color: MUTED, marginTop: "0.25rem" }}>
              {variant.variantOptions.map((option) => `${option.name}: ${option.value}`).join(" · ")}
            </div>
          ) : null}
        </div>

        <Link
          to={`?tab=variants&variant=${encodeURIComponent(variant.id)}`}
          style={{ ...btn(MUTED), lineHeight: "1.2" }}
        >
          Edit
        </Link>
      </div>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "0.6rem 1rem",
          margin: "0.85rem 0 0",
          fontSize: "0.8rem",
        }}
      >
        <Fact label="Wholesale" value={money(variant.wholesalePrice, currency)} />
        <Fact label="Suggested retail" value={money(variant.suggestedRetailPrice, currency)} />
        {canEditCost ? (
          <Fact
            label="Acquisition cost"
            value={
              variant.costPrice === null ? "not set" : money(variant.costPrice, currency)
            }
          />
        ) : null}
        {canEditCost && margin !== null ? (
          <Fact label="Margin at retail" value={money(margin, currency)} />
        ) : null}
        <Fact
          label="Inventory"
          value={`${variant.inventory}${variant.unitsPerPackage > 1 ? ` (${variant.unitsPerPackage} per unit)` : ""}`}
        />
        <Fact
          label="Product size"
          value={[
            dec(variant.productLengthCm),
            dec(variant.productWidthCm),
            dec(variant.productHeightCm),
          ].every(Boolean)
            ? `${dec(variant.productLengthCm)} × ${dec(variant.productWidthCm)} × ${dec(variant.productHeightCm)} cm`
            : "not measured"}
        />
        <Fact
          label="Product weight"
          value={variant.productWeightKg ? `${dec(variant.productWeightKg)} kg` : "not measured"}
        />
        <Fact
          label="Shipping carton"
          value={
            carton
              ? `${carton.length} × ${carton.width} × ${carton.height} ${carton.dimensionUnit}, ${carton.grossWeight} ${carton.weightUnit}`
              : "not set"
          }
        />
      </dl>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.85rem", flexWrap: "wrap" }}>
        {!variant.isDefault ? (
          <Form method="post">
            <input type="hidden" name="tab" value="variants" />
            <input type="hidden" name="variantId" value={variant.id} />
            <button type="submit" name="intent" value="set_default_variant" style={btn(MUTED)}>
              Make default
            </button>
          </Form>
        ) : null}
        <a href={`#packaging-${variant.id}`} style={{ ...btn(MUTED), lineHeight: "1.2" }}>
          Packaging
        </a>
      </div>

      <PackagingEditor variant={variant} presets={presets} />
    </div>
  );
}

function Fact({ label: text, value }: { label: string; value: string }) {
  return (
    <div>
      <dt style={{ fontSize: "0.68rem", color: FAINT, margin: 0 }}>{text}</dt>
      <dd style={{ margin: 0, color: INK }}>{value}</dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Packaging                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cartons, as a repeatable row.
 *
 * The rows are submitted as parallel arrays (`pkg_length`, `pkg_width`, …) that
 * the action zips by index. That works because every row is present in the
 * document in the same order — no row is added or removed without a round trip,
 * so the arrays cannot fall out of step.
 */
function PackagingEditor({ variant, presets }: { variant: Variant; presets: Preset[] }) {
  const rows = variant.packages.length ? variant.packages : [null];

  return (
    <details
      id={`packaging-${variant.id}`}
      style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.6rem" }}
    >
      <summary style={{ cursor: "pointer", fontSize: "0.78rem", color: INK, fontWeight: 600 }}>
        Shipping and packaging ({variant.packages.length} carton
        {variant.packages.length === 1 ? "" : "s"})
      </summary>
      <p style={{ ...helpText, marginTop: "0.4rem" }}>
        These measurements are what a shipping quote is calculated from, so an order records
        whichever carton is listed first.
      </p>

      <Form method="post">
        <input type="hidden" name="tab" value="variants" />
        <input type="hidden" name="variantId" value={variant.id} />

        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", marginTop: "0.5rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: FAINT }}>
              <th style={{ padding: "0.3rem" }}>Label</th>
              <th style={{ padding: "0.3rem" }}>Type</th>
              <th style={{ padding: "0.3rem" }}>Description</th>
              <th style={{ padding: "0.3rem" }}>L</th>
              <th style={{ padding: "0.3rem" }}>W</th>
              <th style={{ padding: "0.3rem" }}>H</th>
              <th style={{ padding: "0.3rem" }}>Unit</th>
              <th style={{ padding: "0.3rem" }}>Gross wt</th>
              <th style={{ padding: "0.3rem" }}>Unit</th>
              <th style={{ padding: "0.3rem" }}>Units/pkg</th>
              <th style={{ padding: "0.3rem" }}>Declared value</th>
              <th style={{ padding: "0.3rem" }}>Ships separately</th>
              <th style={{ padding: "0.3rem" }}>May consolidate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row?.id ?? `new-${index}`}>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_label"
                    defaultValue={row?.label ?? ""}
                    aria-label={`Carton ${index + 1} label`}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_packageType"
                    defaultValue={row?.packageType ?? "carton"}
                    aria-label={`Carton ${index + 1} type`}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_description"
                    defaultValue={row?.description ?? ""}
                    placeholder="what is in this box"
                    aria-label={`Carton ${index + 1} description`}
                  />
                </td>
                {(["length", "width", "height"] as const).map((dimension) => (
                  <td style={{ padding: "0.2rem" }} key={dimension}>
                    <input
                      style={input}
                      name={`pkg_${dimension}`}
                      inputMode="decimal"
                      defaultValue={row ? dec(row[dimension]) : ""}
                      aria-label={`Carton ${index + 1} ${dimension}`}
                    />
                  </td>
                ))}
                <td style={{ padding: "0.2rem" }}>
                  <select
                    style={input}
                    name="pkg_dimUnit"
                    defaultValue={row?.dimensionUnit ?? "in"}
                    aria-label={`Carton ${index + 1} dimension unit`}
                  >
                    <option value="in">in</option>
                    <option value="cm">cm</option>
                  </select>
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_weight"
                    inputMode="decimal"
                    defaultValue={row ? dec(row.grossWeight) : ""}
                    aria-label={`Carton ${index + 1} gross weight`}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <select
                    style={input}
                    name="pkg_weightUnit"
                    defaultValue={row?.weightUnit ?? "lb"}
                    aria-label={`Carton ${index + 1} weight unit`}
                  >
                    <option value="lb">lb</option>
                    <option value="kg">kg</option>
                  </select>
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_unitsPerPackage"
                    inputMode="numeric"
                    defaultValue={row?.unitsPerPackage ?? 1}
                    aria-label={`Carton ${index + 1} units per package`}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_declaredValue"
                    inputMode="decimal"
                    defaultValue={
                      row?.declaredValue === null || row?.declaredValue === undefined
                        ? ""
                        : (row.declaredValue / 100).toFixed(2)
                    }
                    aria-label={`Carton ${index + 1} declared value`}
                  />
                </td>
                {/* Named per row: an unchecked box submits nothing at all, so a
                    shared name would shift every row after the first one that is
                    off and silently reassign their values. */}
                <td style={{ padding: "0.2rem", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    name={`pkg_shipsSeparately_${index}`}
                    value="true"
                    defaultChecked={row?.shipsSeparately ?? false}
                    aria-label={`Carton ${index + 1} ships separately`}
                  />
                </td>
                <td style={{ padding: "0.2rem", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    name={`pkg_consolidatable_${index}`}
                    value="true"
                    defaultChecked={row?.consolidatable ?? true}
                    aria-label={`Carton ${index + 1} may be consolidated`}
                  />
                </td>
                {/* Inside a cell: an input that is a direct child of a `<tr>` is
                    invalid markup and browsers move it out of the table. */}
                <td style={{ display: "none" }}>
                  <input type="hidden" name="pkg_packagesPerUnit" value={row?.packagesPerUnit ?? 1} />
                  <input type="hidden" name="pkg_presetId" value={row?.presetId ?? ""} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        <div style={{ marginTop: "0.5rem" }}>
          <button type="submit" name="intent" value="save_packaging" style={btn(INK, { solid: true })}>
            Save packaging
          </button>
        </div>
      </Form>

      {variant.packages.length === 0 ? (
        <p style={{ ...helpText, marginTop: "0.5rem" }}>
          No carton yet. A shipping quote cannot be produced for a variant with no packaging.
        </p>
      ) : null}

      {presets.length ? (
        <details style={{ marginTop: "0.5rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.72rem", color: MUTED }}>
            Standard cartons ({presets.length}) — measurements to copy from
          </summary>
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.72rem", color: MUTED, lineHeight: 1.7 }}>
            {presets.map((preset) => (
              <li key={preset.id}>
                <strong>{preset.name}</strong> — {preset.length} × {preset.width} × {preset.height}{" "}
                {preset.dimensionUnit}
                {preset.emptyWeight !== null ? `, empty ${preset.emptyWeight} ${preset.weightUnit}` : ""}
                {preset.maxWeight !== null ? `, holds up to ${preset.maxWeight} ${preset.weightUnit}` : ""}
              </li>
            ))}
          </ul>
          <p style={{ ...helpText, paddingLeft: "1.1rem" }}>
            A preset describes the empty box. The weight and the number of units inside it are
            different for every variant, so they stay on the variant.
          </p>
        </details>
      ) : null}
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit view                                                                  */
/* -------------------------------------------------------------------------- */

function VariantForm({
  product,
  presets,
  canEditCost,
  mode,
  variant,
}: {
  product: Product;
  presets: Preset[];
  canEditCost: boolean;
  mode: "add" | "edit";
  variant?: Variant;
}) {
  const currency = product.currency;
  const weightKg = dec(variant?.productWeightKg);
  // Only variants that already carry a carton are useful as a source: copying
  // from an empty one would offer to replace packaging with nothing.
  const copySources = product.variants.filter(
    (other) => other.id !== variant?.id && other.packages.length > 0
  );

  return (
    <div style={{ ...card, borderColor: INK }}>
      <h2 style={sectionTitle}>{mode === "add" ? "New variant" : `Editing ${variant?.name}`}</h2>
      <p style={sectionNote}>
        Prices are per unit. Measurements are stored in centimetres and kilograms; the imperial
        figures beside each box are for reading and are not saved.
      </p>

      <Form method="post">
        <input type="hidden" name="tab" value="variants" />
        {variant ? <input type="hidden" name="variantId" value={variant.id} /> : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.85rem" }}>
          <Field id={`v-name-${variant?.id ?? "new"}`} label="Variant name">
            <input
              style={input}
              id={`v-name-${variant?.id ?? "new"}`}
              name="name"
              required
              defaultValue={variant?.name ?? ""}
              placeholder="Queen"
            />
          </Field>

          <Field id={`v-sku-${variant?.id ?? "new"}`} label="SKU">
            <input
              style={input}
              id={`v-sku-${variant?.id ?? "new"}`}
              name="sku"
              required
              defaultValue={variant?.sku ?? ""}
            />
          </Field>

          <Field id={`v-barcode-${variant?.id ?? "new"}`} label="Barcode (optional)">
            <input
              style={input}
              id={`v-barcode-${variant?.id ?? "new"}`}
              name="barcode"
              defaultValue={variant?.barcode ?? ""}
            />
          </Field>

          <Field id={`v-wholesale-${variant?.id ?? "new"}`} label="Wholesale price">
            <input
              style={input}
              id={`v-wholesale-${variant?.id ?? "new"}`}
              name="wholesalePrice"
              inputMode="decimal"
              required
              defaultValue={centsToInput(variant?.wholesalePrice)}
              placeholder="52.00"
            />
          </Field>

          <Field id={`v-retail-${variant?.id ?? "new"}`} label="Suggested retail price">
            <input
              style={input}
              id={`v-retail-${variant?.id ?? "new"}`}
              name="suggestedRetailPrice"
              inputMode="decimal"
              required
              defaultValue={centsToInput(variant?.suggestedRetailPrice)}
              placeholder="129.00"
            />
          </Field>

          {canEditCost ? (
            <Field
              id={`v-cost-${variant?.id ?? "new"}`}
              label="Acquisition cost"
              hint="Never shown to sellers or included in a marketing pack."
            >
              <input
                style={input}
                id={`v-cost-${variant?.id ?? "new"}`}
                name="costPrice"
                inputMode="decimal"
                defaultValue={centsToInput(variant?.costPrice)}
              />
            </Field>
          ) : (
            <Field
              id={`v-cost-hidden-${variant?.id ?? "new"}`}
              label="Acquisition cost"
              hint="Your role cannot view or change acquisition cost."
            >
              <input
                style={{ ...input, background: "#f1f5f9" }}
                id={`v-cost-hidden-${variant?.id ?? "new"}`}
                value="restricted"
                readOnly
                disabled
              />
            </Field>
          )}

          <Field id={`v-inventory-${variant?.id ?? "new"}`} label="Inventory">
            <input
              style={input}
              id={`v-inventory-${variant?.id ?? "new"}`}
              name="inventory"
              inputMode="numeric"
              defaultValue={variant?.inventory ?? 0}
            />
          </Field>

          <Field id={`v-upp-${variant?.id ?? "new"}`} label="Units per package">
            <input
              style={input}
              id={`v-upp-${variant?.id ?? "new"}`}
              name="unitsPerPackage"
              inputMode="numeric"
              defaultValue={variant?.unitsPerPackage ?? 1}
            />
          </Field>
        </div>

        <h3 style={{ ...sectionTitle, marginTop: "1.1rem" }}>Measurements</h3>
        <p style={{ ...sectionNote, marginBottom: "0.6rem" }}>
          The unpacked product, not the carton. Canonical units are cm and kg.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.85rem" }}>
          <MetricField id={`v-len-${variant?.id ?? "new"}`} name="productLengthCm" label="Length (cm)" value={dec(variant?.productLengthCm)} imperial={cmToInches(dec(variant?.productLengthCm))} unit="in" />
          <MetricField id={`v-wid-${variant?.id ?? "new"}`} name="productWidthCm" label="Width (cm)" value={dec(variant?.productWidthCm)} imperial={cmToInches(dec(variant?.productWidthCm))} unit="in" />
          <MetricField id={`v-hei-${variant?.id ?? "new"}`} name="productHeightCm" label="Height (cm)" value={dec(variant?.productHeightCm)} imperial={cmToInches(dec(variant?.productHeightCm))} unit="in" />
          <MetricField id={`v-wt-${variant?.id ?? "new"}`} name="productWeightKg" label="Weight (kg)" value={weightKg} imperial={kgToPounds(weightKg)} unit="lb" />
        </div>

        <h3 style={{ ...sectionTitle, marginTop: "1.1rem" }}>Options</h3>
        <p style={{ ...sectionNote, marginBottom: "0.6rem" }}>
          The pairs a seller picks between, for example Size: Queen. Leave both blank for a
          product sold in one configuration.
        </p>
        {(variant?.variantOptions.length ? variant.variantOptions : [{ name: "", value: "" }]).map(
          (option, index) => (
            <div
              key={option.id ?? `option-${index}`}
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.4rem" }}
            >
              <input
                style={input}
                name="optionName"
                defaultValue={option.name}
                placeholder="Size"
                aria-label={`Option ${index + 1} name`}
              />
              <input
                style={input}
                name="optionValue"
                defaultValue={option.value}
                placeholder="Queen"
                aria-label={`Option ${index + 1} value`}
              />
            </div>
          )
        )}

        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="submit"
            name="intent"
            value={mode === "add" ? "add_variant" : "update_variant"}
            style={btn(INK, { solid: true })}
          >
            {mode === "add" ? "Add variant" : "Save variant"}
          </button>
          <Link to="?tab=variants" style={{ ...btn(MUTED), lineHeight: "1.2" }}>
            Cancel
          </Link>
        </div>
      </Form>

      {mode === "edit" && variant ? (
        <div style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.75rem" }}>
          <ConfirmForm
            intent="delete_variant"
            fields={{ tab: "variants", variantId: variant.id }}
            label="Delete this variant"
            confirmLabel="Delete"
            question={
              variant.isDefault
                ? "Delete the default variant? The next one takes over as default."
                : "Delete this variant? Past orders keep their copy."
            }
          />
          <p style={{ ...helpText, marginTop: "0.4rem" }}>
            {variant.isDefault
              ? "This is the default variant; deleting it promotes the next one."
              : "Variants referenced by past orders keep their order history — the order line stored a copy, not a link."}
          </p>
        </div>
      ) : null}

      {mode === "edit" && variant && copySources.length ? (
        <div style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.75rem" }}>
          <h3 style={sectionTitle}>Copy packaging from another variant</h3>
          <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <input type="hidden" name="tab" value="variants" />
            <input type="hidden" name="toVariantId" value={variant.id} />
            <Field id={`v-copy-${variant.id}`} label="Source variant">
              <select style={input} id={`v-copy-${variant.id}`} name="fromVariantId" required>
                <option value="">Choose…</option>
                {copySources.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name} ({other.packages.length} carton
                    {other.packages.length === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" name="intent" value="copy_packaging" style={btn(MUTED)}>
              Copy packaging
            </button>
          </Form>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A measurement input whose canonical value is the one submitted.
 *
 * The imperial figure is rendered as text, not as a second input: a second
 * input invites someone to type in it, and then the stored value depends on
 * which box was filled last.
 */
function MetricField({
  id,
  name,
  label: text,
  value,
  imperial,
  unit,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  imperial: string;
  unit: string;
}) {
  return (
    <Field
      id={id}
      label={text}
      hint={imperial ? <>≈ {imperial} {unit}</> : "not measured"}
    >
      <input
        style={input}
        id={id}
        name={name}
        inputMode="decimal"
        defaultValue={value}
      />
    </Field>
  );
}
