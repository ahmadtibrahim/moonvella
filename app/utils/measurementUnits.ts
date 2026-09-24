/**
 * MEASUREMENTS HAVE ONE CANONICAL FORM, AND THIS IS WHERE THE OTHER ONE IS
 * PRODUCED.
 *
 * Centimetres and kilograms are what the database stores, what a shipping quote
 * is built from, what an order snapshots and what every verify suite reads —
 * `ProductVariant.productLengthCm`, `productWeightKg` and the packaging columns
 * beside them. The operator may enter and read inches and pounds instead, and
 * that preference is an interface choice: it decides what the form shows and
 * what it accepts, and the route converts on the way in. Nothing downstream
 * ever sees a pound.
 *
 * WHY THE RULE IS "CONVERT ONCE, AT THE EDGE". A value that is displayed in
 * inches and saved back as centimetres drifts: 24 in becomes 60.96 cm, which
 * reads back as 24.00 and re-saves as 60.96 only while the rounding holds, and
 * a few edit cycles later the label is wrong by a fraction and nothing has
 * alerted anybody. The protection is two-part and both parts are used here: a
 * stored value that the operator did not touch is never re-submitted (the form
 * disables the input), and a value that was touched is converted exactly once
 * and rounded exactly once, at the boundary that needs the column's own scale.
 *
 * This module is isomorphic on purpose — pure constants and pure functions, no
 * database and no server import — so the route, the service and the components
 * share one definition, and the conversions are testable without a browser or a
 * connection.
 */

const INCHES_PER_CM = 2.54;
/** International avoirdupois pound, exact by definition. */
const KG_PER_LB = 0.45359237;

/** Which column a number is destined for, which is what decides its scale. */
export type MeasureKind = "length" | "weight";

export function toCm(value: number, unit: string): number {
  return unit === "in" ? value * INCHES_PER_CM : value;
}
export function toKg(value: number, unit: string): number {
  return unit === "lb" ? value * KG_PER_LB : value;
}
export function fromCm(value: number, unit: string): number {
  return unit === "in" ? value / INCHES_PER_CM : value;
}
export function fromKg(value: number, unit: string): number {
  return unit === "lb" ? value / KG_PER_LB : value;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* -------------------------------------------------------------------------- *
 * The operator's preference.
 * -------------------------------------------------------------------------- */

/**
 * IMPERIAL IS THE DEFAULT, and that is the owner's instruction rather than a
 * guess about the audience: the request was "make it in Inches by default".
 * It is also what a deployment that has expressed no preference gets, which is
 * why the reading service treats a missing row as this value and not as an
 * error.
 */
export type UnitPreference = "imperial" | "metric";

export const DEFAULT_UNITS: UnitPreference = "imperial";
export const UNITS_VALUES: readonly UnitPreference[] = ["imperial", "metric"];

export function isUnitPreference(value: unknown): value is UnitPreference {
  return value === "imperial" || value === "metric";
}

export interface UnitsView {
  preference: UnitPreference;
  /** The unit string the packaging tables store: "in" or "cm". */
  dimensionUnit: "in" | "cm";
  /** The unit string the packaging tables store: "lb" or "kg". */
  weightUnit: "lb" | "kg";
  lengthLabel: string;
  widthLabel: string;
  heightLabel: string;
  weightLabel: string;
  /** The pair as a sentence fragment: "inches and pounds". */
  phrase: string;
}

/**
 * One preference, read out in every form the interface needs.
 *
 * The labels are built here rather than at each call site so "Length (in)" and
 * "Weight (lb)" cannot end up beside a field that is actually holding
 * centimetres — the failure this whole change is about, in reverse.
 */
export function unitsView(preference: UnitPreference): UnitsView {
  const imperial = preference === "imperial";
  const dimensionUnit = imperial ? "in" : "cm";
  const weightUnit = imperial ? "lb" : "kg";
  return {
    preference,
    dimensionUnit,
    weightUnit,
    lengthLabel: `Length (${dimensionUnit})`,
    widthLabel: `Width (${dimensionUnit})`,
    heightLabel: `Height (${dimensionUnit})`,
    weightLabel: `Weight (${weightUnit})`,
    phrase: imperial ? "inches and pounds" : "centimetres and kilograms",
  };
}

/* -------------------------------------------------------------------------- *
 * The two conversions the route and the form need.
 * -------------------------------------------------------------------------- */

/**
 * What the operator typed, as the canonical value the column stores.
 *
 * Returns the raw text unchanged in three cases, and each is deliberate:
 *
 *  - the preference is metric, in which case there is nothing to convert and
 *    today's behaviour is preserved exactly;
 *  - the field is empty, which is how a measurement is CLEARED — converting it
 *    would turn a deliberate blank into a number;
 *  - the text is not a plain positive decimal, which is left alone so the
 *    service's own validator produces the message it already produces
 *    ("Product length must be a positive number.") rather than this function
 *    inventing a second, differently-worded refusal for the same mistake.
 *
 * The result is rounded to the column's own scale — two places for a length,
 * three for a weight — because those are the scales the validator enforces and
 * a conversion that overshoots them would be rejected for a reason that has
 * nothing to do with what the operator typed. Rounding happens here and only
 * here, on a value that is about to be stored.
 */
export function enteredToCanonical(
  raw: string,
  kind: MeasureKind,
  preference: UnitPreference,
): string {
  if (preference === "metric") return raw;

  const text = raw.trim();
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return raw;

  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return raw;

  const canonical = kind === "length" ? round2(toCm(value, "in")) : round3(toKg(value, "lb"));
  return String(canonical);
}

/**
 * A stored canonical value, as the operator's chosen unit shows it.
 *
 * Empty for a measurement that has never been taken, so a box that holds
 * nothing stays empty rather than reading "0" — the difference matters, because
 * zero is a measurement and "not measured" is not.
 *
 * A converted figure is trimmed of trailing zeroes, so 60.96 cm reads "24" in
 * inches and 2.5 lb stays "2.5". In metric the stored value is returned as it
 * is, untouched and unrounded — the column's own scale is the display's scale
 * there, and rounding it would be the very drift this module exists to prevent.
 *
 * What is displayed is NOT what is stored: the form submits this text only when
 * the operator has changed it, and the stored value is left untouched
 * otherwise, which is what keeps an untouched measurement exact.
 */
export function storedToDisplay(
  /*
   * Deliberately `unknown`. A stored measurement arrives as a Prisma Decimal
   * over the loader boundary, as a number from the packaging tables and as a
   * string from a seed, and every caller would otherwise have to narrow it
   * first only for this function to widen it again. It is total over unknown by
   * construction: anything that is not a finite number reads as "not measured",
   * which is the true answer for a value that cannot be read as one.
   */
  value: unknown,
  kind: MeasureKind,
  preference: UnitPreference,
): string {
  if (value === null || value === undefined || value === "") return "";
  const canonical = Number(value);
  if (!Number.isFinite(canonical)) return "";

  /*
   * In metric the stored value IS the display value, and it is returned
   * untouched. Rounding it here would be the drift this module exists to
   * prevent, in miniature: a weight column holds three places, so pushing
   * 0.907 kg through a two-place rounding to make it "tidy" would show the
   * operator 0.91 and save that back over their 907 grams.
   */
  if (preference === "metric") return String(value);

  const shown = kind === "length" ? fromCm(canonical, "in") : fromKg(canonical, "lb");
  return String(kind === "length" ? round2(shown) : round3(shown));
}
