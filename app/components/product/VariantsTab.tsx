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
import { convertedDisplay, storedToDisplay, type UnitsView } from "~/utils/measurementUnits";
import {
  fieldError,
  fillPackagingRow,
  newCartonText,
  preservePackagingRows,
  refusedEditorRows,
  type EditorRowFields,
  type RefusedPackaging,
} from "./packagingRows";
import { PackagingValue } from "./PackagingValue";
import { DeclaredValueInput } from "./DeclaredValueInput";
import { PackagingFlags } from "./PackagingFlags";

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
 * chosen ONCE on the Settings page and defaulting to inches and pounds. There is
 * deliberately no second selector on this page: two places to change one global
 * setting is two places to disagree about it.
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
  /** Retired packs stay readable on the rows that already chose them. */
  isActive: boolean;
}

interface Product {
  id: string;
  currency: string;
  /**
   * Read for one purpose only: what a new carton row is called and described
   * before anyone types in it. See `newCartonText`.
   */
  name: string;
  description: string | null;
  variants: Variant[];
}

export default function VariantsTab({
  product,
  presets,
  canEditCost,
  units,
  refused = null,
}: {
  product: Product;
  presets: Preset[];
  canEditCost: boolean;
  /** The admin's unit preference, resolved by the route and rendered here. */
  units: UnitsView;
  /**
   * A packaging save that was refused, and the rows it was carrying.
   *
   * The page around this tab is drawn from the loader, and the loader reads the
   * database — so without this the form came back holding the figures that were
   * stored BEFORE the operator typed, and one blank weight cost them the whole
   * carton they had just measured. See `./packagingRows`.
   */
  refused?: (RefusedPackaging & { variantId: string }) | null;
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
            refused={refused && refused.variantId === variant.id ? refused : null}
            /*
              What a carton row added to THIS variant starts out saying. Built
              here, where the family and the variant are both in scope, rather
              than further down where only the variant is.
            */
            cartonDefaults={newCartonText({
              variantName: variant.name,
              productName: product.name,
              productDescription: product.description,
            })}
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
  refused,
  cartonDefaults,
}: {
  variant: Variant;
  currency: string;
  canEditCost: boolean;
  presets: Preset[];
  units: UnitsView;
  refused: RefusedPackaging | null;
  /** What a carton row added here starts out saying. See `newCartonText`. */
  cartonDefaults: { label: string; description: string };
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
        {/*
          * Shown in the admin's unit, converted from the unit the row is stored
          * in. A carton recorded in centimetres reads in inches on a page set to
          * inches, which is the point of the setting — and the conversion is for
          * reading only: nothing here is written back.
          */}
        <Fact
          label="Shipping carton"
          value={
            carton
              ? `${convertedDisplay(carton.length, carton.dimensionUnit, units.dimensionUnit, "length")} × ${convertedDisplay(carton.width, carton.dimensionUnit, units.dimensionUnit, "length")} × ${convertedDisplay(carton.height, carton.dimensionUnit, units.dimensionUnit, "length")} ${units.dimensionUnit}, ${convertedDisplay(carton.grossWeight, carton.weightUnit, units.weightUnit, "weight")} ${units.weightUnit}`
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

      <PackagingEditor
        variant={variant}
        presets={presets}
        units={units}
        refused={refused}
        // Only ever read by a row that does not exist yet — see `newCartonText`.
        defaults={cartonDefaults}
      />
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
 * THE UNIT IS THE ADMIN'S, NOT THE ROW'S. Every figure on this table is shown
 * and entered in the unit the Settings page sets, and the row's stored unit is
 * kept out of sight behind it — see `./packagingRows` for how a row that was
 * never touched is put back exactly as it is stored, and how a row that was
 * edited is re-expressed without drifting. A blank row starts in the admin's
 * unit because there is nothing stored for it yet.
 *
 * A PACK FILLS IN THE BOX, NOT THE PARCEL. Choosing one copies the three
 * dimensions and leaves the gross weight alone, because the weight of a shipment
 * is a fact about what is inside the box and that differs for every variant.
 *
 * The refusal messages come back naming a row and a column, which is what lets
 * each sentence sit under the control that has to change rather than in a list
 * at the top of the page — see `fieldError` in `./packagingRows`.
 */
function PackagingEditor({
  variant,
  presets,
  units,
  refused,
  defaults,
}: {
  variant: Variant;
  presets: Preset[];
  units: UnitsView;
  refused: RefusedPackaging | null;
  /** What a brand-new row starts out saying. See `newCartonText`. */
  defaults: { label: string; description: string };
}) {
  /*
   * WHICH ROWS THE TABLE DRAWS, and why a refused save changes the answer.
   *
   * With nothing refused the rows are what is stored. With a refusal they are
   * what was SUBMITTED — the same figures, at their own indexes, in the unit the
   * operator was reading them in. The two shapes are different types on purpose
   * (see `./packagingRows`), which is why the table reads each name once and
   * never branches per cell.
   */
  const stored = variant.packages.length ? variant.packages : [null];
  const rows: (EditorRowFields | null)[] =
    refused?.values?.length ? refusedEditorRows(refused.values) : stored;

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
        whichever carton is listed first. Everything here is in {units.phrase}, the unit set on
        the Settings page.
      </p>

      <Form method="post" onSubmit={preservePackagingRows}>
        <input type="hidden" name="tab" value="variants" />
        <input type="hidden" name="variantId" value={variant.id} />
        {/* The unit this table was drawn in, so a row is saved in the unit its
            own labels were written in even if the preference changed elsewhere
            while the page sat open. */}
        <input type="hidden" name="units" value={units.preference} />
        {/* HOW MANY ROWS THIS TABLE SHOWED. The save replaces the whole set, so
            the number of rows that arrive IS the number of rows that will exist
            afterwards — and a form that arrives with no rows at all therefore
            reads as "delete every carton", which is how a save the operator
            never intended became a wipe. The action refuses that combination
            unless this field says the table really was empty. */}
        <input type="hidden" name="pkg_rowCount" value={rows.length} />

        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", marginTop: "0.5rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: FAINT }}>
              {/* The pack comes first because it is the shortcut: pick the box
                  you ship in and the three measurements below fill in. */}
              <th style={{ padding: "0.3rem" }}>Pack</th>
              <th style={{ padding: "0.3rem" }}>Label</th>
              <th style={{ padding: "0.3rem" }}>Type</th>
              <th style={{ padding: "0.3rem" }}>Description</th>
              <th style={{ padding: "0.3rem" }}>L ({units.dimensionUnit})</th>
              <th style={{ padding: "0.3rem" }}>W ({units.dimensionUnit})</th>
              <th style={{ padding: "0.3rem" }}>H ({units.dimensionUnit})</th>
              <th style={{ padding: "0.3rem" }}>Gross wt ({units.weightUnit})</th>
              <th style={{ padding: "0.3rem" }}>Units/pkg</th>
              <th style={{ padding: "0.3rem" }}>Declared value</th>
              <th style={{ padding: "0.3rem" }}>Ships separately</th>
              <th style={{ padding: "0.3rem" }}>May consolidate</th>
            </tr>
            {/* WHAT THE THREE SETTINGS MEAN, said once above the boxes that set
                them. The pair on the right are one decision: a carton that
                travels on its own is never merged, so the second box goes grey
                while the first is on. */}
            <tr style={{ color: FAINT, fontSize: "0.66rem" }}>
              <td style={{ padding: "0.2rem" }} colSpan={8}>
                One row per carton. <strong>Units/pkg</strong> is how many sold units go in this
                carton; a row that says 2 makes two cartons per unit sold, each with the
                measurements on that row.
              </td>
              <td style={{ padding: "0.2rem" }} colSpan={2}>
                &nbsp;
              </td>
              <td style={{ padding: "0.2rem" }}>
                <strong>Own box.</strong> Not merged with anything else.
              </td>
              <td style={{ padding: "0.2rem" }}>
                <strong>May share</strong> a parcel with other cartons.
              </td>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row?.id ?? `new-${index}`}
                data-pkg-row={index}
                data-global-dim={units.dimensionUnit}
                data-global-weight={units.weightUnit}
              >
                <td style={{ padding: "0.2rem" }}>
                  <PackSelect row={row} presets={presets} units={units} index={index} />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_label"
                    defaultValue={row?.label ?? defaults.label}
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
                    defaultValue={row?.description ?? defaults.description}
                    placeholder="what is in this box"
                    aria-label={`Carton ${index + 1} description`}
                  />
                </td>
                {(["length", "width", "height"] as const).map((dimension) => (
                  <td style={{ padding: "0.2rem" }} key={dimension}>
                    <PackagingValue
                      name={`pkg_${dimension}`}
                      kind="length"
                      label={`Carton ${index + 1} ${dimension}`}
                      stored={row ? row[dimension] : null}
                      storedUnit={row?.dimensionUnit ?? units.dimensionUnit}
                      shownUnit={units.dimensionUnit}
                      error={fieldError(refused?.problems ?? [], index, dimension)}
                    />
                  </td>
                ))}
                <td style={{ padding: "0.2rem" }}>
                  <PackagingValue
                    name="pkg_weight"
                    kind="weight"
                    label={`Carton ${index + 1} gross weight`}
                    stored={row ? row.grossWeight : null}
                    storedUnit={row?.weightUnit ?? units.weightUnit}
                    shownUnit={units.weightUnit}
                    error={fieldError(refused?.problems ?? [], index, "grossWeight")}
                  />
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
                  <DeclaredValueInput
                    cents={row?.declaredValue}
                    index={index}
                    error={fieldError(refused?.problems ?? [], index, "declaredValue")}
                  />
                </td>
                {/* Named per row: an unchecked box submits nothing at all, so a
                    shared name would shift every row after the first one that is
                    off and silently reassign their values. The pair is drawn by
                    one component because the second box is a consequence of the
                    first — see `PackagingFlags`. */}
                <PackagingFlags
                  index={index}
                  // A NEW CARTON TRAVELS ALONE. The fallbacks are the defaults
                  // for a row that does not exist yet, and they match the
                  // column defaults in the database: one item, its own box.
                  shipsSeparately={row?.shipsSeparately ?? true}
                  consolidatable={row?.consolidatable ?? false}
                />
                {/* Inside a cell: an input that is a direct child of a `<tr>` is
                    invalid markup and browsers move it out of the table.

                    The two unit fields are here rather than in a column of their
                    own because they are no longer a choice — the admin's unit
                    decides what every row shows. What is submitted is the unit
                    the row's numbers are being SAVED in: the unit it is already
                    stored in when nothing was touched, and the unit on screen
                    when something was. `packagingRows` moves them. */}
                <td style={{ display: "none" }}>
                  <input
                    type="hidden"
                    name="pkg_packagesPerUnit"
                    defaultValue={row?.packagesPerUnit ?? 1}
                  />
                  <input
                    type="hidden"
                    name="pkg_dimUnit"
                    defaultValue={row?.dimensionUnit ?? units.dimensionUnit}
                  />
                  <input
                    type="hidden"
                    name="pkg_weightUnit"
                    defaultValue={row?.weightUnit ?? units.weightUnit}
                  />
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

    </details>
  );
}

/**
 * The saved pack a carton row was filled from.
 *
 * A pack that has been retired is still OFFERED on a row that already points at
 * it, marked as retired, because the alternative is worse than it sounds: the
 * select would fall back to its first option, and saving the row would silently
 * unlink a carton from the pack it was built from. A retired pack cannot be
 * chosen for a row that does not already use it.
 */
function PackSelect({
  row,
  presets,
  units,
  index,
}: {
  /** Stored or refused — both agree on this one field (see `./packagingRows`). */
  row: EditorRowFields | null;
  presets: Preset[];
  units: UnitsView;
  index: number;
}) {
  const options = presets.filter((preset) => preset.isActive || preset.id === row?.presetId);

  return (
    <select
      style={input}
      name="pkg_presetId"
      defaultValue={row?.presetId ?? ""}
      aria-label={`Carton ${index + 1} pack`}
      onChange={(event) => fillPackagingRow(event.currentTarget)}
    >
      <option value="">— none —</option>
      {options.map((preset) => (
        <option
          key={preset.id}
          value={preset.id}
          data-length={preset.length}
          data-width={preset.width}
          data-height={preset.height}
          data-unit={preset.dimensionUnit}
        >
          {packLabel(preset, units)}
        </option>
      ))}
    </select>
  );
}

/**
 * A pack in a dropdown: its name and the box it actually is.
 *
 * The dimensions are converted into the unit the page is in, so the choice can
 * be made by reading rather than by remembering which pack is which — two packs
 * whose names differ by one word are told apart by their measurements, which are
 * the thing being chosen.
 */
function packLabel(preset: Preset, units: UnitsView): string {
  const dims = (["length", "width", "height"] as const)
    .map((dimension) => convertedDisplay(preset[dimension], preset.dimensionUnit, units.dimensionUnit, "length"))
    .join(" × ");
  return `${preset.name} — ${dims} ${units.dimensionUnit}${preset.isActive ? "" : " (retired)"}`;
}

/* -------------------------------------------------------------------------- */
/* Edit view                                                                  */
/* -------------------------------------------------------------------------- */

function VariantForm({
  product,
  presets,
  canEditCost,
  units,
  mode,
  variant,
}: {
  product: Product;
  presets: Preset[];
  canEditCost: boolean;
  units: UnitsView;
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

/*
 * The unit selector that used to sit here is gone, and its absence is the
 * feature: the unit is set once on the Settings page and every page in the
 * admin reads it. Two selectors for one preference is how an operator ends up
 * changing it in the place that does not save, or believing the choice applies
 * to the product they are looking at when it applies to all of them.
 */
