import { input } from "./ui";

/**
 * THE DECLARED VALUE OF A CARTON ROW — money, not a measurement.
 *
 * It sits beside `PackagingValue` because a carton row has exactly two kinds of
 * figure and they are not the same kind: a measurement is a quantity in a unit,
 * and this is an amount in the product's currency, stored in cents. Routing it
 * through the measurement component would mean teaching that component about a
 * unit called "dollars", and the whole point of that component is that it carries
 * one unit and converts once.
 *
 * The value is shown as a plain decimal — `12.35` — and submitted as typed; the
 * route turns it into cents. A refused save draws the field the way it draws a
 * refused measurement, and for the same reason: the sentence the service wrote
 * names a row and a column, and the operator should not have to work out which
 * box it means.
 */
export function DeclaredValueInput({
  cents,
  index,
  disabled = false,
  error,
}: {
  /** The stored amount in cents, or null when nothing is declared. */
  cents: number | null | undefined;
  /** Which carton this is, for the screen reader and the error's place. */
  index: number;
  disabled?: boolean;
  /** What is wrong with this figure, if this is the one that was refused. */
  error?: string;
}) {
  const bad = Boolean(error);
  return (
    <>
      <input
        style={bad ? { ...input, borderColor: "#dc2626", background: "#fef2f2" } : input}
        name="pkg_declaredValue"
        inputMode="decimal"
        defaultValue={cents === null || cents === undefined ? "" : (cents / 100).toFixed(2)}
        aria-label={`Carton ${index + 1} declared value`}
        aria-invalid={bad || undefined}
        disabled={disabled}
      />
      {error ? (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.62rem", margin: "0.15rem 0 0 0" }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
