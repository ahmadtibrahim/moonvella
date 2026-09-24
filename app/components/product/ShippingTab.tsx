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
import { fillPackagingRow, preservePackagingRows } from "./packagingRows";
import { PackagingValue } from "./PackagingValue";

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
}: {
  product: { id: string; name: string; pickupLocationId: string | null };
  variants: ShippingVariant[];
  locations: ShippingLocation[];
  packages: ProductPackageRow[];
  presets: ShippingPreset[];
  canManage: boolean;
  /** The admin's unit preference: what every carton row is shown in. */
  units: UnitsView;
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

            <h3 style={{ ...sectionTitle, marginTop: "1.5rem" }}>Variants</h3>
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
                  <th style={{ padding: "0.3rem" }}>Location</th>
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
                    <td style={{ padding: "0.35rem", maxWidth: 260 }}>
                      <input type="hidden" name="originVariantId" value={variant.id} />
                      <select
                        name="originLocationId"
                        style={input}
                        defaultValue={variant.pickupLocationId ?? ""}
                        disabled={!canManage}
                        aria-label={`Pickup location for ${variant.name}`}
                      >
                        <option value="">Inherit from the product</option>
                        {locations.map((location) => (
                          <option key={location.id} value={location.id}>
                            {optionLabel(location)}
                          </option>
                        ))}
                      </select>
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

            {canManage ? (
              <div style={{ marginTop: "0.9rem" }}>
                <button type="submit" name="intent" value="save_origin" style={btn(INK, { solid: true })}>
                  Save location mapping
                </button>
              </div>
            ) : null}
          </Form>
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
}: {
  packages: ProductPackageRow[];
  presets: ShippingPreset[];
  canManage: boolean;
  units: UnitsView;
}) {
  const [rows, setRows] = useState<(ProductPackageRow | null)[]>(() =>
    packages.length ? packages : [null]
  );
  // A name per row that survives its neighbours being removed. It starts past
  // the rows that are already on screen — a saved row's id, or the `new-0` an
  // empty table begins with — so a row added later can never take a name that
  // is already in use.
  const nextKey = useRef(packages.length > 0 ? packages.length : 1);
  const [keys, setKeys] = useState<string[]>(() => rows.map((row, index) => row?.id ?? `new-${index}`));

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
                  <input
                    style={input}
                    name="pkg_declaredValue"
                    inputMode="decimal"
                    defaultValue={row?.declaredValue === null || row?.declaredValue === undefined ? "" : (row.declaredValue / 100).toFixed(2)}
                    aria-label={`Carton ${index + 1} declared value`}
                    disabled={!canManage}
                  />
                </td>
                {/* Named per row: an unchecked box submits nothing, so a shared
                    name would shift every row after the first one that is off. */}
                <td style={{ padding: "0.2rem", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    name={`pkg_shipsSeparately_${index}`}
                    value="true"
                    defaultChecked={row?.shipsSeparately ?? false}
                    aria-label={`Carton ${index + 1} ships separately`}
                    disabled={!canManage}
                  />
                </td>
                <td style={{ padding: "0.2rem", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    name={`pkg_consolidatable_${index}`}
                    value="true"
                    defaultChecked={row?.consolidatable ?? true}
                    aria-label={`Carton ${index + 1} may be consolidated`}
                    disabled={!canManage}
                  />
                </td>
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
                  <input type="hidden" name="pkg_packagesPerUnit" value={row?.packagesPerUnit ?? 1} />
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

