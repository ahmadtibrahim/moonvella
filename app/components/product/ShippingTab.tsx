import { useRef, useState } from "react";
import { Form, Link } from "react-router";
import {
  INK,
  MUTED,
  FAINT,
  LINE,
  card,
  input,
  label,
  helpText,
  btn,
  sectionTitle,
  sectionNote,
  EmptyState,
} from "~/components/product/ui";
import { convertedDisplay, type UnitsView } from "~/utils/measurementUnits";
import {
  fieldError,
  fillPackagingRow,
  preservePackagingRows,
  refusedEditorRows,
  type EditorRowFields,
  type RefusedPackaging,
} from "./packagingRows";
import { PackagingValue } from "./PackagingValue";
import { DeclaredValueInput } from "./DeclaredValueInput";
import { PackagingFlags } from "./PackagingFlags";

/**
 * Where a product is collected from, and how it is packed.
 *
 * WHY THIS IS ITS OWN TAB. The two facts here decide what a carrier is told, and
 * both are inherited by everything underneath them: a variant with no location
 * of its own uses the product's, and a variant with no cartons of its own is
 * quoted from the product's. Putting them together lets the inheritance be shown
 * as what it is — one row that most variants follow and a few that do not —
 * instead of being scattered across a variant editor where the pattern is
 * invisible and the exceptions are undiscoverable.
 *
 * THE UNPACKED DIMENSIONS ARE NOT HERE, ON PURPOSE. A variant's own length,
 * width, height and weight describe the item on a shelf and are quoted on a
 * catalogue page; the numbers on this tab describe a boxed parcel and are what a
 * quote is billed on. They are different measurements of different things, they
 * live in different columns, and this tab only ever reads the packaging ones.
 */

export interface ShippingLocation {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  missing: string[];
}

/**
 * A saved carton size, as this tab needs it.
 *
 * Not the same list the variant editor gets: a pack is chosen here as well, and
 * the choice is offered the same way in both places so that "the medium box"
 * means one thing on every page of the admin. `isActive` is carried because a
 * retired pack must stay readable on the rows that already chose it.
 */
export interface ShippingPreset {
  id: string;
  name: string;
  length: number;
  width: number;
  height: number;
  dimensionUnit: string;
  isActive: boolean;
}

export interface ProductPackageRow {
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
  description: string | null;
  declaredValue: number | null;
  shipsSeparately: boolean;
  consolidatable: boolean;
}

export interface ShippingVariant {
  id: string;
  name: string;
  sku: string;
  pickupLocationId: string | null;
  /**
   * Which step answered: the variant's own mapping, the product's, the one
   * default location, or none.
   */
  originSource: "variant" | "product" | "default" | "missing";
  originReady: boolean;
  originReason: string | null;
  originName: string | null;
  /** Whether this variant has cartons of its own or is quoted from the product's. */
  packageSource: "variant" | "product" | "none";
  packageCount: number;
}

export default function ShippingTab({
  product,
  variants,
  locations,
  packages,
  presets,
  canManage,
  units,
  refused = null,
}: {
  product: { id: string; name: string; pickupLocationId: string | null };
  variants: ShippingVariant[];
  locations: ShippingLocation[];
  packages: ProductPackageRow[];
  presets: ShippingPreset[];
  canManage: boolean;
  /** The admin's unit preference: what every carton row is shown in. */
  units: UnitsView;
  /** A refused packaging-defaults save, and which row and column it named. */
  refused?: RefusedPackaging | null;
}) {
  const unmapped = variants.filter((variant) => variant.originSource === "missing");
  const inheritingCartons = variants.filter((variant) => variant.packageSource !== "variant");

  return (
    <div>
      <div style={card}>
        <h2 style={sectionTitle}>Pickup location</h2>
        <p style={sectionNote}>
          Where this product is collected from. The default below applies to every variant that has
          no location of its own, and nothing here is ever guessed: an item with no mapping cannot
          be quoted or booked, and the reason is shown against it.
        </p>

        {locations.length === 0 ? (
          <EmptyState>
            No pickup locations exist yet.{" "}
            <Link to="/admin/origins" style={{ color: INK }}>
              Add one
            </Link>{" "}
            before quoting or booking anything.
          </EmptyState>
        ) : (
          <Form method="post">
            <input type="hidden" name="tab" value="shipping" />
            <input type="hidden" name="productId" value={product.id} />

            <div style={{ maxWidth: 420 }}>
              <label style={label} htmlFor="pickupLocationId">
                Product default
              </label>
              <select
                id="pickupLocationId"
                name="pickupLocationId"
                style={input}
                defaultValue={product.pickupLocationId ?? ""}
                disabled={!canManage}
              >
                <option value="">— none mapped —</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {optionLabel(location)}
                  </option>
                ))}
              </select>
              <p style={helpText}>
                Leaving this unset is allowed and means nothing can ship until it is set. It does
                not fall back to a supplier address or to another location on the account.
              </p>
            </div>

            {canManage ? (
              <div style={{ marginTop: "0.9rem" }}>
                <button type="submit" name="intent" value="save_origin" style={btn(INK, { solid: true })}>
                  Save location mapping
                </button>
              </div>
            ) : null}
          </Form>
        )}
      </div>

      {/*
        THE VARIANTS, READ-ONLY, WITH THEIR OVERRIDES MARKED.

        Every variant inherits the product's pickup location, and that is now the
        only way a location is chosen for goods: a second selector per variant
        was a second answer to the same question, and the one on the variant won
        silently. Nothing was deleted to get here — a variant that already had
        its own location keeps it and still ships from it — so the overrides that
        exist are shown in amber, one row each, with a Clear button, rather than
        being quietly dropped or quietly kept.

        The table sits outside the form above because clearing one override must
        not resubmit the product's default alongside it: a form that posts both
        can lose the default, and a mapping lost as a side effect of tidying up a
        variant is a bug nobody would look for here.
      */}
      <div style={card}>
        <h3 style={sectionTitle}>Variants</h3>
        <p style={sectionNote}>
          All of these inherit the product&apos;s pickup location. An override recorded on a variant
          before this page changed is kept and still decides where that variant ships from, and is
          listed here so it cannot go unnoticed.
        </p>
        {locations.length === 0 ? null : (
          <>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.78rem",
                marginTop: "0.4rem",
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: FAINT }}>
                  <th style={{ padding: "0.3rem" }}>Variant</th>
                  <th style={{ padding: "0.3rem" }}>Where it ships from</th>
                  <th style={{ padding: "0.3rem" }}>Readiness</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((variant) => (
                  <tr key={variant.id} style={{ borderTop: `1px solid ${LINE}` }}>
                    <td style={{ padding: "0.35rem" }}>
                      <div style={{ color: INK, fontWeight: 600 }}>{variant.name}</div>
                      <code style={{ fontSize: "0.72rem", color: MUTED }}>{variant.sku}</code>
                    </td>
                    <td style={{ padding: "0.35rem", maxWidth: 320 }}>
                      {variant.pickupLocationId ? (
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                          <span
                            style={{
                              background: "#fffbeb",
                              border: "1px solid #fde68a",
                              color: "#92400e",
                              borderRadius: 999,
                              padding: "0.1rem 0.5rem",
                              fontSize: "0.7rem",
                              fontWeight: 600,
                            }}
                          >
                            Override set on this variant — {variant.originName ?? "an unknown location"}
                          </span>
                          {canManage ? (
                            <Form method="post">
                              <input type="hidden" name="tab" value="shipping" />
                              <input type="hidden" name="productId" value={product.id} />
                              <input type="hidden" name="intent" value="clear_origin_overrides" />
                              <input type="hidden" name="variantId" value={variant.id} />
                              <button
                                type="submit"
                                style={{ ...btn("#92400e"), padding: "0.1rem 0.5rem", fontSize: "0.68rem" }}
                              >
                                Clear
                              </button>
                            </Form>
                          ) : null}
                        </div>
                      ) : (
                        <span style={{ color: MUTED }}>
                          Inherits the product default
                          {product.pickupLocationId
                            ? ` (${locations.find((l) => l.id === product.pickupLocationId)?.name ?? "set"})`
                            : " — none set yet"}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "0.35rem", fontSize: "0.75rem" }}>
                      {variant.originReady ? (
                        <span style={{ color: "#065f46" }}>
                          {variant.originName} —{" "}
                          {variant.originSource === "variant"
                            ? "set on this variant"
                            : variant.originSource === "default"
                              ? "the default pickup location"
                              : "inherited"}
                        </span>
                      ) : (
                        <span style={{ color: "#92400e" }}>{variant.originReason}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {canManage && variants.some((variant) => variant.pickupLocationId) ? (
              <Form method="post" style={{ marginTop: "0.9rem" }}>
                <input type="hidden" name="tab" value="shipping" />
                <input type="hidden" name="productId" value={product.id} />
                <input type="hidden" name="intent" value="clear_origin_overrides" />
                {variants
                  .filter((variant) => variant.pickupLocationId)
                  .map((variant) => (
                    <input key={variant.id} type="hidden" name="variantId" value={variant.id} />
                  ))}
                <button type="submit" style={btn("#92400e")}>
                  Clear all {variants.filter((variant) => variant.pickupLocationId).length} override
                  {variants.filter((variant) => variant.pickupLocationId).length === 1 ? "" : "s"}
                </button>
                <p style={helpText}>
                  Every one of these variants then inherits the product default above. The overrides
                  removed are kept on the product&apos;s history, so what each one was can still be
                  read afterwards.
                </p>
              </Form>
            ) : null}
          </>
        )}

        {unmapped.length > 0 ? (
          <div
            style={{
              marginTop: "1rem",
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 8,
              padding: "0.7rem 0.9rem",
              fontSize: "0.78rem",
              color: "#92400e",
            }}
          >
            <strong>Pickup location required</strong> for {unmapped.length} variant
            {unmapped.length === 1 ? "" : "s"} ({unmapped.map((variant) => variant.sku).join(", ")}).
            Quoting and booking stay blocked for them until a location is mapped.
          </div>
        ) : null}
      </div>

      <PackagingDefaults
        packages={packages}
        presets={presets}
        canManage={canManage}
        units={units}
        refused={refused}
      />

      <div style={card}>
        <h2 style={sectionTitle}>What each variant is quoted from</h2>
        <p style={sectionNote}>
          A variant with its own cartons is quoted from those; a variant without them is quoted from
          the product defaults above. Nothing is copied at save time, so changing a default changes
          the quote for every variant that inherits it — and leaves the ones that do not alone.
        </p>
        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.78rem", lineHeight: 1.8, color: MUTED }}>
          {variants.map((variant) => (
            <li key={variant.id}>
              <strong style={{ color: INK }}>{variant.sku}</strong> —{" "}
              {variant.packageSource === "variant"
                ? `its own packaging (${variant.packageCount} carton${variant.packageCount === 1 ? "" : "s"})`
                : variant.packageSource === "product"
                  ? `inherits the product defaults (${variant.packageCount} carton${variant.packageCount === 1 ? "" : "s"})`
                  : "no packaging at all — a quote cannot be produced"}
            </li>
          ))}
        </ul>
        {inheritingCartons.length > 0 ? (
          <p style={helpText}>
            To give a variant its own packaging, open{" "}
            <Link to={`/admin/products/${product.id}?tab=variants`} style={{ color: INK }}>
              the Variants tab
            </Link>
            .
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A location as it appears in a select, with anything wrong with it said here. */
function optionLabel(location: ShippingLocation): string {
  const notes: string[] = [];
  if (!location.isActive) notes.push("switched off");
  if (location.missing.length > 0) notes.push(`incomplete: ${location.missing.join(", ")}`);
  return notes.length > 0
    ? `${location.name} (${location.code}) — ${notes.join("; ")}`
    : `${location.name} (${location.code})`;
}

/**
 * The product's packaging defaults.
 *
 * Rows are added and removed on the client, and submitted as parallel arrays the
 * action zips by index — the same convention the variant editor uses, extended
 * with the buttons that editor lacks. Without them a product could only ever
 * have as many cartons as it was first saved with, which is not enough for the
 * "one sold unit ships as two parcels" case this exists to describe.
 *
 * ROWS CARRY A STABLE IDENTITY. The key used to be the row's index, which is
 * the one thing about a row that changes when another one is removed: deleting
 * the first of two unsaved rows left the survivor wearing the deleted row's key,
 * so React reused that row's DOM node and the numbers typed into one box
 * appeared in the other. A counter that only ever goes up gives every row a name
 * of its own, and the data attributes `packagingRows` reads travel with it.
 *
 * The hidden fields sit inside a cell rather than beside the row: an input that
 * is a direct child of a `<tr>` is not valid markup, and browsers move it out of
 * the table when they parse the page.
 */
function PackagingDefaults({
  packages,
  presets,
  canManage,
  units,
  refused,
}: {
  packages: ProductPackageRow[];
  presets: ShippingPreset[];
  canManage: boolean;
  units: UnitsView;
  /** A refused save: the rows it was carrying, and the messages about them. */
  refused: RefusedPackaging | null;
}) {
  const [rows, setRows] = useState<(EditorRowFields | null)[]>(() => {
    // A stored row and a refused submission are the same table drawn from two
    // sources; `EditorRowFields` is the shape they agree on. A null element is
    // the blank row a product with no defaults starts from.
    const stored: EditorRowFields[] = packages.length ? [...packages] : [];
    return stored.length ? stored : [null];
  });
  // A name per row that survives its neighbours being removed. It starts past
  // the rows that are already on screen — a saved row's id, or the `new-0` an
  // empty table begins with — so a row added later can never take a name that
  // is already in use.
  const nextKey = useRef(packages.length > 0 ? packages.length : 1);
  const [keys, setKeys] = useState<string[]>(() => rows.map((row, index) => row?.id ?? `new-${index}`));

  /*
   * A REFUSAL PUTS THE SUBMISSION BACK ON THE SCREEN.
   *
   * This table's rows live in state, so a refusal that arrives while it is open
   * usually finds the operator's own figures already sitting in it. That is not
   * something to rely on. Whether React keeps this component's state across an
   * action response is an implementation detail of the router, and the failure
   * mode if it ever changes is silent: one missing weight, and every number the
   * operator typed is replaced by what was stored before they started, with no
   * sign that anything was lost. So the echo is applied as well, and the table
   * is correct whichever way the router behaves.
   *
   * Applied ONCE PER REFUSAL, during render, using the pattern React documents
   * for state that has to follow a prop. Comparing against the last refusal seen
   * rather than against `refused` directly is what keeps it from re-seeding on
   * every render — which would undo the operator's next keystroke, and would be
   * a worse bug than the one this fixes.
   */
  const [seenRefusal, setSeenRefusal] = useState<RefusedPackaging | null>(null);
  if (refused !== seenRefusal) {
    setSeenRefusal(refused);
    if (refused?.values?.length) setRows(refusedEditorRows(refused.values));
  }

  const addRow = () => {
    setKeys((current) => [...current, `new-${nextKey.current}`]);
    nextKey.current += 1;
    setRows((current) => [...current, null]);
  };
  const removeRow = (index: number) => {
    setKeys((current) => current.filter((_, i) => i !== index));
    setRows((current) => current.filter((_, i) => i !== index));
  };

  return (
    <div style={card}>
      <h2 style={sectionTitle}>Packaging defaults</h2>
      <p style={sectionNote}>
        The packed measurements of this product — the box, not the item. A shipping quote is
        calculated from these, and every variant without cartons of its own is quoted from them.
        Everything here is in {units.phrase}, the unit set on the Settings page.
      </p>

      <Form method="post" onSubmit={preservePackagingRows}>
        <input type="hidden" name="tab" value="shipping" />
        {/* The unit this table was drawn in — see the variant editor. */}
        <input type="hidden" name="units" value={units.preference} />
        {/* How many rows this table is showing right now. The save replaces the
            whole set, so rows that arrive are rows that will exist — and a form
            arriving with none at all would otherwise read as "delete every
            carton". The action refuses that unless this field agrees the table
            really was empty. Here it never can be: the last row's remove button
            is disabled, so a product's defaults cannot be emptied by accident or
            on purpose. See `assertClearWasIntended` in the service. */}
        <input type="hidden" name="pkg_rowCount" value={rows.length} />

        {/* A carton row has a lot of columns and the table must not force the
            whole page sideways at a narrower window. */}
        <div style={{ overflowX: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", marginTop: "0.4rem" }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: FAINT }}>
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
              <th style={{ padding: "0.3rem" }} />
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
              <td style={{ padding: "0.2rem" }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={keys[index]}
                data-pkg-row={index}
                data-global-dim={units.dimensionUnit}
                data-global-weight={units.weightUnit}
              >
                <td style={{ padding: "0.2rem" }}>
                  <select
                    style={input}
                    name="pkg_presetId"
                    defaultValue={row?.presetId ?? ""}
                    aria-label={`Carton ${index + 1} pack`}
                    disabled={!canManage}
                    onChange={(event) => fillPackagingRow(event.currentTarget)}
                  >
                    <option value="">— none —</option>
                    {presets
                      .filter((preset) => preset.isActive || preset.id === row?.presetId)
                      .map((preset) => (
                        <option
                          key={preset.id}
                          value={preset.id}
                          data-length={preset.length}
                          data-width={preset.width}
                          data-height={preset.height}
                          data-unit={preset.dimensionUnit}
                        >
                          {preset.name} —{" "}
                          {(["length", "width", "height"] as const)
                            .map((dimension) =>
                              convertedDisplay(
                                preset[dimension],
                                preset.dimensionUnit,
                                units.dimensionUnit,
                                "length",
                              ),
                            )
                            .join(" × ")}{" "}
                          {units.dimensionUnit}
                          {preset.isActive ? "" : " (retired)"}
                        </option>
                      ))}
                  </select>
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_label"
                    defaultValue={row?.label ?? ""}
                    aria-label={`Carton ${index + 1} label`}
                    disabled={!canManage}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_packageType"
                    defaultValue={row?.packageType ?? "carton"}
                    aria-label={`Carton ${index + 1} type`}
                    disabled={!canManage}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <input
                    style={input}
                    name="pkg_description"
                    defaultValue={row?.description ?? ""}
                    placeholder="what is in this box"
                    aria-label={`Carton ${index + 1} description`}
                    disabled={!canManage}
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
                      disabled={!canManage}
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
                    disabled={!canManage}
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
                    disabled={!canManage}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <DeclaredValueInput
                    cents={row?.declaredValue}
                    index={index}
                    disabled={!canManage}
                    error={fieldError(refused?.problems ?? [], index, "declaredValue")}
                  />
                </td>
                {/* Named per row: an unchecked box submits nothing, so a shared
                    name would shift every row after the first one that is off.
                    A NEW CARTON TRAVELS ALONE — the fallbacks here match the
                    column defaults in the database. The pair is drawn by one
                    component because the second box is a consequence of the
                    first: see `PackagingFlags`. */}
                <PackagingFlags
                  index={index}
                  shipsSeparately={row?.shipsSeparately ?? true}
                  consolidatable={row?.consolidatable ?? false}
                  disabled={!canManage}
                />
                <td style={{ padding: "0.2rem" }}>
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    disabled={!canManage || rows.length === 1}
                    aria-label={`Remove carton ${index + 1}`}
                    style={{
                      ...btn(MUTED),
                      padding: "0.3rem 0.5rem",
                      opacity: rows.length === 1 ? 0.35 : 1,
                    }}
                  >
                    ×
                  </button>
                </td>
                {/* Inside a cell, so the parser keeps it in the row it belongs
                    to. `pkg_presetId` is no longer hidden — it is the pack
                    dropdown at the front of the row — and the two unit fields
                    are, because the admin's unit decides what every row shows
                    and only the unit a row is SAVED in needs submitting. */}
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

        <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" onClick={addRow} disabled={!canManage} style={btn(INK)}>
            + Add a carton
          </button>
          {canManage ? (
            <button
              type="submit"
              name="intent"
              value="save_product_packages"
              style={btn(INK, { solid: true })}
            >
              Save packaging defaults
            </button>
          ) : null}
        </div>

        <p style={helpText}>
          Zero or missing measurements are refused rather than stored: a parcel of 0 × 0 × 0 is
          priced by a carrier as if it weighed nothing, and the resulting quote looks like a bargain
          rather than a mistake. Choosing a pack fills in the box&rsquo;s dimensions and never its
          weight — the gross weight of a parcel is a fact about what is inside it. The figures above
          are the unit set on the Settings page, converted once for the carrier, and a carton that
          is not edited keeps the exact measurements it was saved with.
        </p>
      </Form>
    </div>
  );
}

