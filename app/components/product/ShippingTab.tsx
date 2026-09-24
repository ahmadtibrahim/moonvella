import { useState } from "react";
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
import type { UnitsView } from "~/utils/measurementUnits";

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
  presets: { id: string; name: string; length: number; width: number; height: number; dimensionUnit: string }[];
  canManage: boolean;
  /** The admin's unit preference, used only to seed a blank carton row. */
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
 * The hidden `packagesPerUnit` and `presetId` fields sit inside a cell rather
 * than beside the row: an input that is a direct child of a `<tr>` is not valid
 * markup, and browsers move it out of the table when they parse the page.
 */
function PackagingDefaults({
  packages,
  presets,
  canManage,
  units,
}: {
  packages: ProductPackageRow[];
  presets: { id: string; name: string; length: number; width: number; height: number; dimensionUnit: string }[];
  canManage: boolean;
  units: UnitsView;
}) {
  const [rows, setRows] = useState<(ProductPackageRow | null)[]>(() =>
    packages.length ? packages : [null]
  );

  const addRow = () => setRows((current) => [...current, null]);
  const removeRow = (index: number) => setRows((current) => current.filter((_, i) => i !== index));

  return (
    <div style={card}>
      <h2 style={sectionTitle}>Packaging defaults</h2>
      <p style={sectionNote}>
        The packed measurements of this product — the box, not the item. A shipping quote is
        calculated from these, and every variant without cartons of its own is quoted from them.
      </p>

      <Form method="post">
        <input type="hidden" name="tab" value="shipping" />

        {/* A carton row has a lot of columns and the table must not force the
            whole page sideways at a narrower window. */}
        <div style={{ overflowX: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", marginTop: "0.4rem" }}
        >
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
              <th style={{ padding: "0.3rem" }} />
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
                    <input
                      style={input}
                      name={`pkg_${dimension}`}
                      inputMode="decimal"
                      defaultValue={row ? dec(row[dimension]) : ""}
                      aria-label={`Carton ${index + 1} ${dimension}`}
                      disabled={!canManage}
                    />
                  </td>
                ))}
                <td style={{ padding: "0.2rem" }}>
                  <select
                    style={input}
                    name="pkg_dimUnit"
                    defaultValue={row?.dimensionUnit ?? units.dimensionUnit}
                    aria-label={`Carton ${index + 1} dimension unit`}
                    disabled={!canManage}
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
                    disabled={!canManage}
                  />
                </td>
                <td style={{ padding: "0.2rem" }}>
                  <select
                    style={input}
                    name="pkg_weightUnit"
                    defaultValue={row?.weightUnit ?? units.weightUnit}
                    aria-label={`Carton ${index + 1} weight unit`}
                    disabled={!canManage}
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
                {/* Inside a cell, so the parser keeps it in the row it belongs to. */}
                <td style={{ display: "none" }}>
                  <input type="hidden" name="pkg_packagesPerUnit" value={row?.packagesPerUnit ?? 1} />
                  <input type="hidden" name="pkg_presetId" value={row?.presetId ?? ""} />
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
          rather than a mistake. Inches and pounds are converted once, on the way to a carrier, and
          the value you typed stays in the unit you typed it in.
        </p>
      </Form>

      {presets.length ? (
        <details style={{ marginTop: "0.7rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.75rem", color: MUTED }}>
            Standard cartons ({presets.length}) — measurements to copy from
          </summary>
          <ul
            style={{
              margin: "0.4rem 0 0",
              paddingLeft: "1.1rem",
              fontSize: "0.75rem",
              color: MUTED,
              lineHeight: 1.7,
            }}
          >
            {presets.map((preset) => (
              <li key={preset.id}>
                <strong>{preset.name}</strong> — {preset.length} × {preset.width} × {preset.height}{" "}
                {preset.dimensionUnit}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Two decimals at most, and never a trailing ".00" the eye has to skip. */
function dec(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.round(number * 100) / 100);
}
