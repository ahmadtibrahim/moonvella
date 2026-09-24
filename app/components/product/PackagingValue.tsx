import { input } from "./ui";
import { convertedDisplay, type MeasureKind } from "~/utils/measurementUnits";

/**
 * ONE MEASUREMENT OF SOMETHING SAVED, SHOWN IN THE ADMIN'S UNIT AND SUBMITTED IN
 * THE UNIT IT IS STORED IN.
 *
 * Used by all three surfaces that record a carton — a variant's packaging rows,
 * a product's packaging defaults and a saved pack — because they are the same
 * question asked in three places, and three copies of the answer is how one of
 * them ends up converting while another rounds.
 *
 * The three data attributes are the contract with `packagingRows`, and each
 * answers something the submit handler cannot work out for itself:
 *
 *   data-original    — what was on screen when the page was drawn, which is how
 *                      "did the operator touch this?" is decided;
 *   data-stored      — the exact figure the row holds;
 *   data-stored-unit — the unit that figure is in.
 *
 * The visible value is the stored one CONVERTED FOR THE EYE, and it is
 * deliberately not what gets stored when nothing was touched. See the module for
 * why that separation is what stands between a saved carton and a slow drift of
 * a few thousandths per edit.
 */
export function PackagingValue({
  name,
  kind,
  label,
  stored,
  storedUnit,
  shownUnit,
  disabled = false,
  error,
}: {
  name: string;
  kind: MeasureKind;
  /** Read out to a screen reader; the visible label is the caller's business. */
  label: string;
  stored: number | string | null | undefined;
  storedUnit: string;
  shownUnit: string;
  disabled?: boolean;
  /** What is wrong with this figure, if this is the one that was refused. */
  error?: string;
}) {
  const shown = convertedDisplay(stored, storedUnit, shownUnit, kind);
  const bad = Boolean(error);
  return (
    <div>
      {/* The unit travels with the control as well as with the column header.
          The header answers "inches or centimetres?" for the table; this
          answers it for a field somebody is looking at, which is the question
          that was being asked when the unit dropdowns rendered blank. */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
        <input
          style={bad ? { ...input, borderColor: "#dc2626", background: "#fef2f2" } : input}
          name={name}
          inputMode="decimal"
          defaultValue={shown}
          data-kind={kind}
          data-original={shown}
          data-stored={stored === null || stored === undefined ? "" : String(stored)}
          data-stored-unit={storedUnit}
          aria-label={label}
          aria-invalid={bad || undefined}
          disabled={disabled}
        />
        <span style={{ fontSize: "0.62rem", color: bad ? "#b91c1c" : "#94a3b8" }}>{shownUnit}</span>
      </div>
      {error ? (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.62rem", margin: "0.15rem 0 0 0" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
