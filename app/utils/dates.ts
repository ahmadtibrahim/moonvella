/**
 * Dates and numbers said the same way by everybody.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT COSMETIC. `new Date(x).toLocaleString()`
 * formats through the LOCALE AND THE TIME ZONE OF WHOEVER RUNS IT. These pages
 * are rendered on the server and then hydrated in the operator's browser, and
 * those two are almost never the same machine: this deployment's server runs
 * with `en-US` and `UTC` (checked, not assumed), while the operator's browser
 * carries their own zone and language. The server writes "10/4/2026, 2:31:00 PM"
 * and the browser writes "2026-10-04, 14:31" — React fails the comparison with
 * error #418 ("text content does not match server-rendered HTML", #423 when the
 * mismatch forces a re-render), and the page throws away the server's markup and
 * redraws itself on every load.
 *
 * Two things are wrong there and this module addresses both. The loud one is
 * the console error. The quiet one is the DATE ITSELF: before the mismatch is
 * repaired, the reader is shown whichever of the two renderings won, so a
 * timestamp can read as one day and, in the same page load, as another.
 *
 * THE FORMATTERS ARE BUILT FROM NUMERIC PARTS, ON PURPOSE. Pinning a locale and
 * a zone is not enough on its own: `month: "short"` and `hour12` produce TEXT
 * from CLDR ("Oct", "p.m."), and that text is versioned data that can differ
 * between the ICU built into Node and the ICU built into the browser. Digits
 * cannot: they are assembled here from `formatToParts`, so the output is
 * byte-identical on every engine that can count to ten.
 *
 * THE ZONE IS THE COMPANY'S, NOT THE READER'S. `America/Toronto` is where this
 * business and its docks are; a shipment handed over at 14:31 should read 14:31
 * to the person who handed it over, on whatever machine they open. A value that
 * is a CALENDAR DATE rather than an instant — a carrier's delivery estimate, a
 * payout's arrival date, both of which arrive as "2026-10-07" and are parsed as
 * midnight UTC — is formatted in UTC instead, because shifting those by the
 * company's offset would print the day before (`formatDate` takes that as an
 * explicit option and each such call site says so).
 */

/** Anything these helpers will accept as a moment. */
export type DateLike = Date | string | number | null | undefined;

/**
 * The clock the app reads in: the company's own.
 *
 * Not the server's and not the reader's. The server's is UTC, which shows an
 * Ontario afternoon as the evening; the reader's would make one page say two
 * different things to two people looking at it together.
 */
export const DISPLAY_TIME_ZONE = "America/Toronto";

/**
 * For calendar dates that arrive as strings ("2026-10-07") rather than as
 * instants. `new Date("2026-10-07")` is midnight UTC, so reading it in any
 * western zone prints the 6th.
 */
export const CALENDAR_DATE_TIME_ZONE = "UTC";

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

const LONG_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
};

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  /*
   * `h23` rather than `hour12: false`, which is the setting that used to render
   * midnight as "24:00" on some engines. This is the one that says what it
   * means.
   */
  hourCycle: "h23",
};

/**
 * One formatter pair per zone, built once.
 *
 * The zone is fixed when a formatter is constructed, so a caller that wants UTC
 * needs its own; constructing these per call would mean building an ICU
 * formatter for every timestamp on a page.
 */
interface FormatterSet {
  date: Intl.DateTimeFormat;
  long: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
}

const FORMATTERS = new Map<string, FormatterSet>();

function formattersFor(timeZone: string): FormatterSet {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;
  const build = (zone: string): FormatterSet => ({
    date: new Intl.DateTimeFormat("en-CA", { ...DATE_OPTIONS, timeZone: zone }),
    long: new Intl.DateTimeFormat("en-CA", { ...LONG_DATE_OPTIONS, timeZone: zone }),
    time: new Intl.DateTimeFormat("en-CA", { ...TIME_OPTIONS, timeZone: zone }),
  });
  let built: FormatterSet;
  try {
    built = build(timeZone);
  } catch {
    // An unrecognised zone is a programming error, not a data one — the zone is
    // a constant or a literal at every call site. Falling back to UTC keeps the
    // page rendering instead of throwing inside a render pass.
    built = build("UTC");
  }
  FORMATTERS.set(timeZone, built);
  return built;
}

/** The named numeric parts of a formatted moment, missing ones as "". */
function numericParts(formatter: Intl.DateTimeFormat, at: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface FormatOptions {
  /** Defaults to the company's clock. */
  timeZone?: string;
  /** What to print for a value that is missing or unparseable. */
  fallback?: string;
}

export interface DateFormatOptions extends FormatOptions {
  /**
   * `iso` writes 2026-10-04; `long` writes October 4, 2026.
   *
   * Both are assembled from parts rather than taken from a locale pattern, so
   * the only engine-supplied text in either is a month name.
   */
  style?: "iso" | "long";
}

/** `2026-10-04` (or `October 4, 2026`), or the fallback for a missing value. */
export function formatDate(value: DateLike, options: DateFormatOptions = {}): string {
  const at = toDate(value);
  if (!at) return options.fallback ?? "—";
  const formatter = formattersFor(options.timeZone ?? DISPLAY_TIME_ZONE);
  if (options.style === "long") {
    const parts = numericParts(formatter.long, at);
    return `${parts.month} ${parts.day}, ${parts.year}`;
  }
  const parts = numericParts(formatter.date, at);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `2026-10-04 14:31`, or the fallback for a missing or unparseable value. */
export function formatDateTime(value: DateLike, options: FormatOptions = {}): string {
  const at = toDate(value);
  if (!at) return options.fallback ?? "—";
  const zone = options.timeZone ?? DISPLAY_TIME_ZONE;
  const date = numericParts(formattersFor(zone).date, at);
  const time = numericParts(formattersFor(zone).time, at);
  return `${date.year}-${date.month}-${date.day} ${time.hour}:${time.minute}`;
}

/**
 * A number with its thousands separators, in one locale.
 *
 * Not a date, but the same defect: `toLocaleString()` on a French browser
 * groups with a space and separates the decimals with a comma, so an amount
 * rendered on the server and hydrated in that browser is two different strings.
 * The locale is pinned here for the same reason the zone is above.
 */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-CA", options);
}
