import type { FormEvent } from "react";
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
  INK,
  MUTED,
  FAINT,
  LINE,
  helpText,
} from "./ui";
import {
  storedToDisplay,
  UNITS_VALUES,
  unitsView,
  type UnitsView,
} from "~/utils/measurementUnits";

/**
 * Variants — the things that are actually sold.
 *
 * A variant is where every commercial and physical fact lives: SKU, prices,
 * stock, measurements, the carton it ships in. The family above it is a name.
 * That is why this tab is the busiest one and why the product cannot be
 * published until at least one variant exists and has a default.
 *
 * MEASUREMENT UNITS. The canonical storage is centimetres and kilograms — that
 * is what a quote, a booking and an order snapshot read, and it does not change
 * here. What the operator SEES and TYPES is whichever unit the admin is set to,
 * chosen once on the Settings page or from the selector on this form, and
 * defaulting to inches and pounds.
 *
 * The ambiguity this used to guard against — "the number in the database
 * depends on which box was filled last" — is answered rather than avoided:
 * every measurement input submits its own unit alongside it, the route converts
 * once on the way in, and an input the operator did not touch is not submitted
 * at all, so a stored value is never rewritten by a display round trip. See
 * `~/utils/measurementUnits` for the conversions and the reasoning.
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
  units,
  canChangeUnits,
}: {
  product: Product;
  presets: Preset[];
  canEditCost: boolean;
  /** The admin's unit preference, resolved by the route and rendered here. */
  units: UnitsView;
  canChangeUnits: boolean;
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
          units={units}
          canChangeUnits={canChangeUnits}
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
            units={units}
            canChangeUnits={canChangeUnits}
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
            units={units}
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
  units,
}: {
  variant: Variant;
  currency: string;
  canEditCost: boolean;
  presets: Preset[];
  units: UnitsView;
}) {
  const carton = variant.packages[0] ?? null;
  const margin =
    variant.costPrice !== null ? variant.suggestedRetailPrice - variant.costPrice : null;

  // The three dimensions and the weight, read in whichever unit the admin is
  // set to. The size reads "not measured" unless all three are present, because
  // two of three is not a size — it is an unfinished measurement.
  const size = [
    storedToDisplay(variant.productLengthCm, "length", units.preference),
    storedToDisplay(variant.productWidthCm, "length", units.preference),
    storedToDisplay(variant.productHeightCm, "length", units.preference),
  ];
  const weight = storedToDisplay(variant.productWeightKg, "weight", units.preference);

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
          value={
            size.every(Boolean)
              ? `${size.join(" × ")} ${units.dimensionUnit}`
              : "not measured"
          }
        />
        <Fact
          label="Product weight"
          value={weight ? `${weight} ${units.weightUnit}` : "not measured"}
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

      <PackagingEditor variant={variant} presets={presets} units={units} />
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
 *
 * The unit is per row and stays per row: a carton keeps whichever unit it was
 * recorded in, because that is the unit its numbers were measured in and the
 * carrier reads the row as written. What the admin preference decides is only
 * what an EMPTY row starts as, so a new carton is offered in the unit the
 * operator is already thinking in.
 */
function PackagingEditor({
  variant,
  presets,
  units,
}: {
  variant: Variant;
  presets: Preset[];
  units: UnitsView;
}) {
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
                    defaultValue={row?.dimensionUnit ?? units.dimensionUnit}
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
                    defaultValue={row?.weightUnit ?? units.weightUnit}
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
  units,
  canChangeUnits,
  mode,
  variant,
}: {
  product: Product;
  presets: Preset[];
  canEditCost: boolean;
  units: UnitsView;
  canChangeUnits: boolean;
  mode: "add" | "edit";
  variant?: Variant;
}) {
  const currency = product.currency;
  // Only variants that already carry a carton are useful as a source: copying
  // from an empty one would offer to replace packaging with nothing.
  const copySources = product.variants.filter(
    (other) => other.id !== variant?.id && other.packages.length > 0
  );

  return (
    <div style={{ ...card, borderColor: INK }}>
      <h2 style={sectionTitle}>{mode === "add" ? "New variant" : `Editing ${variant?.name}`}</h2>
      <p style={sectionNote}>
        Prices are per unit. Measurements are entered and shown in {units.phrase}, and stored in
        centimetres and kilograms either way — a quote, a booking and an order snapshot all read
        the one canonical figure.
      </p>

      {/* The unit selector.

          It sits outside the variant form because a form cannot be nested in
          another, and it posts its own intent: choosing a unit is a preference,
          not a variant edit, and it must not save — or be blocked by — the
          half-filled variant beside it. The choice is global, so the note says
          so; without that, an operator reasonably reads it as a setting for
          this product only. */}
      <UnitsSelector units={units} canChange={canChangeUnits} />

      <Form method="post" onSubmit={preserveUntouchedMeasurements}>
        <input type="hidden" name="tab" value="variants" />
        {variant ? <input type="hidden" name="variantId" value={variant.id} /> : null}
        {/* The unit this form's labels and numbers were written in. Carried so
            the route converts in the same unit that was on screen, even if the
            preference changed in another tab while this one sat open. */}
        <input type="hidden" name="units" value={units.preference} />

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
          The unpacked product, not the carton. In {units.phrase}
          {units.preference === "imperial" ? ", converted and stored in centimetres and kilograms." : "."}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.85rem" }}>
          <MetricField id={`v-len-${variant?.id ?? "new"}`} name="productLengthCm" label={units.lengthLabel} value={storedToDisplay(variant?.productLengthCm, "length", units.preference)} />
          <MetricField id={`v-wid-${variant?.id ?? "new"}`} name="productWidthCm" label={units.widthLabel} value={storedToDisplay(variant?.productWidthCm, "length", units.preference)} />
          <MetricField id={`v-hei-${variant?.id ?? "new"}`} name="productHeightCm" label={units.heightLabel} value={storedToDisplay(variant?.productHeightCm, "length", units.preference)} />
          <MetricField id={`v-wt-${variant?.id ?? "new"}`} name="productWeightKg" label={units.weightLabel} value={storedToDisplay(variant?.productWeightKg, "weight", units.preference)} />
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
 * A measurement input, in whichever unit the admin is set to.
 *
 * The number in the box is a DISPLAY value — inches when the admin reads in
 * inches, centimetres when it reads in centimetres — and the route converts it
 * once on the way to the column that stores it. What makes that safe is
 * `data-measure-original`: the input carries the display value it was rendered
 * with, and the form's submit handler disables every input the operator has not
 * changed, so an untouched measurement is not submitted at all and the stored
 * canonical figure survives byte-exact. Without that, saving a price would
 * rewrite 60.96 cm as 24 in and back again, and the point of the canonical
 * column — that everyone downstream reads one number — would erode quietly.
 *
 * There is deliberately no second box showing the other unit. A second box
 * invites someone to type in it, and then the stored value depends on which of
 * the two was filled last, which is the defect this replaced.
 */
function MetricField({
  id,
  name,
  label,
  value,
}: {
  id: string;
  name: string;
  label: string;
  /** What the operator should see, already in their chosen unit. */
  value: string;
}) {
  return (
    <Field id={id} label={label}>
      <input
        style={input}
        id={id}
        name={name}
        inputMode="decimal"
        defaultValue={value}
        data-measure-original={value}
      />
    </Field>
  );
}

/**
 * Leave untouched measurements out of the submission.
 *
 * Runs before react-router reads the form (its `Form` calls this handler first
 * and only then serialises), and disabling an input removes it from the
 * submitted data. The route reads a measurement only when the field is present,
 * so absent means "keep what is stored" — which is the whole point, because the
 * value on screen has been through a conversion and back and re-saving it would
 * be a round trip nothing asked for.
 *
 * An emptied box is a change and is still submitted, which is how a measurement
 * is cleared.
 */
function preserveUntouchedMeasurements(event: FormEvent<HTMLFormElement>) {
  const form = event.currentTarget;
  for (const field of form.querySelectorAll<HTMLInputElement>("input[data-measure-original]")) {
    if (field.value === field.dataset.measureOriginal) field.disabled = true;
  }
}

/**
 * Inches or centimetres, applied to the whole admin.
 *
 * Rendered as a form of its own because a preference is not part of the variant
 * being edited: posting it must work on a form whose required fields are still
 * empty, and it must not save anything else. The pair is named in full — a
 * lone "CM" does not tell an operator that the weights follow it.
 */
function UnitsSelector({ units, canChange }: { units: UnitsView; canChange: boolean }) {
  if (!canChange) {
    return (
      <p style={{ ...helpText, marginBottom: "0.75rem" }}>
        Measurements are shown and entered in {units.phrase}.
      </p>
    );
  }

  return (
    <Form
      method="post"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        border: `1px solid ${LINE}`,
        borderRadius: 6,
        padding: "0.5rem 0.7rem",
        marginBottom: "0.9rem",
      }}
    >
      <input type="hidden" name="tab" value="variants" />
      <span style={{ fontSize: "0.78rem", color: MUTED }}>Measurements in:</span>
      {UNITS_VALUES.map((value) => (
        <label key={value} style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem", color: INK }}>
          <input
            type="radio"
            name="units"
            value={value}
            defaultChecked={value === units.preference}
          />
          {unitsView(value).phrase}
        </label>
      ))}
      <button type="submit" name="intent" value="set_units" style={btn(MUTED)}>
        Apply
      </button>
      <span style={{ fontSize: "0.72rem", color: FAINT }}>
        Applies to every product page in the admin.
      </span>
    </Form>
  );
}
