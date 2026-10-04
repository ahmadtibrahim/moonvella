/**
 * Every date on a page reads the same on the server as in the browser.
 *
 * WHAT WAS WRONG. These pages are server-rendered and then hydrated in the
 * operator's browser, and `new Date(x).toLocaleString()` formats through the
 * LOCALE AND TIME ZONE OF WHOEVER RUNS IT. The two sides are different machines
 * and were measurably different environments: the app's server formats with
 * `en-US` in `UTC`, so it wrote `10/4/2026, 6:31:00 PM` for an instant that the
 * same code, run with a Canadian French locale in Toronto, wrote as
 * `2026-10-04 14 h 31 min 00 s`. React compares the server's markup with what
 * the browser would draw, fails the comparison with error #418 (and #423 when
 * the mismatch forces a re-render), and discards the server's HTML and redraws
 * the page on every load.
 *
 * The console error is the loud half. The quiet half is the DATE ITSELF: until
 * the mismatch is repaired the reader is shown whichever rendering won, so one
 * timestamp can read as two different days inside a single page load, and a
 * support answer built on it can be wrong by a day.
 *
 * WHY THE CHECK IS WRITTEN THIS WAY. The fix is `~/utils/dates`, which pins the
 * locale, pins the zone, and assembles its output from numeric parts so that no
 * engine-supplied text (month names, "p.m.", separators) can differ between the
 * two machines. A suite that only asserted "the formatter returns a string"
 * would pass on the broken code too, so this one does three different things:
 *
 *   A. It pins the formatter's own answers, including the two cases a naive
 *      implementation gets wrong: a calendar date read in the wrong zone
 *      (off by one day) and midnight rendered as `24:00`.
 *   B. It RUNS THE SAME CALLS IN A SECOND PROCESS configured with a different
 *      zone and a different locale, and requires the answers to be identical —
 *      and, in the same child, computes the OLD expression and requires it to
 *      DIFFER. That second half is what makes the check able to fail: it shows
 *      the defect is real in this environment rather than theoretical, and that
 *      the equality above is a property of the new code and not of the machine.
 *   C. It reads the routes and components for any `toLocale*` date call left
 *      behind, which is how the defect would come back — one page at a time.
 *
 * WHAT IT DOES NOT DO. It reaches nothing: no database, no provider, no
 * session. It is pure, so it can run anywhere, and it will keep running.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-hydration.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CALENDAR_DATE_TIME_ZONE, DISPLAY_TIME_ZONE, formatDate, formatDateTime, formatNumber } from "~/utils/dates";

let failures = 0;
let total = 0;
let lastNumber = 0;

function check(number: number, name: string, pass: boolean, detail: unknown = "") {
  total += 1;
  if (number <= lastNumber) {
    failures += 1;
    console.log(`FAIL  check #${number} is out of order — #${lastNumber} was already reported`);
    return;
  }
  lastNumber = number;
  if (!pass) failures += 1;
  const suffix = detail === "" || detail === undefined ? "" : ` — ${String(detail)}`;
  console.log(`${pass ? "PASS" : "FAIL"}  ${String(number).padStart(4)}. ${name}${suffix}`);
}

/** Source with comments removed, strings left intact. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      out += source.slice(start, i);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Every `.tsx`/`.jsx`/`.ts` file under a directory. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx|jsx|ts)$/.test(name)) out.push(full);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The samples: fixed instants with known answers in the company's zone        */
/* -------------------------------------------------------------------------- */

/*
 * Chosen so each one is a different kind of mistake when the zone is dropped:
 * an ordinary afternoon, an instant whose UTC DAY is the day AFTER the local
 * one, midnight (the `24:00` case), and the two sides of a daylight-saving
 * transition — where the same UTC clock time must read as two different local
 * times, which is only true if the offset is read per instant.
 */
const SAMPLES: { at: string; date: string; dateTime: string }[] = [
  { at: "2026-10-04T18:31:00Z", date: "2026-10-04", dateTime: "2026-10-04 14:31" },
  { at: "2026-03-05T03:30:00Z", date: "2026-03-04", dateTime: "2026-03-04 22:30" },
  { at: "2026-10-04T04:00:00Z", date: "2026-10-04", dateTime: "2026-10-04 00:00" },
  // 07:30 UTC the day before the spring-forward is 02:30 EST; the same 07:30 UTC
  // on the day of it is 03:30 EDT.
  { at: "2026-03-07T07:30:00Z", date: "2026-03-07", dateTime: "2026-03-07 02:30" },
  { at: "2026-03-08T07:30:00Z", date: "2026-03-08", dateTime: "2026-03-08 03:30" },
];

/** The child's job: the same calls, plus the expression the code used to use. */
const CHILD_SCRIPT = `
const mod = await import(${JSON.stringify("FILE_URL")});
const samples = ${JSON.stringify(SAMPLES.map((s) => s.at))};
const out = {
  zone: mod.DISPLAY_TIME_ZONE,
  dates: samples.map((s) => mod.formatDate(s)),
  dateTimes: samples.map((s) => mod.formatDateTime(s)),
  long: mod.formatDate("2026-10-04T18:31:00Z", { style: "long" }),
  calendar: mod.formatDate("2026-10-07", { timeZone: mod.CALENDAR_DATE_TIME_ZONE }),
  number: mod.formatNumber(1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  // THE OLD EXPRESSION, computed here so the suite can show it disagreeing.
  legacy: samples.map((s) => new Date(s).toLocaleString()),
  legacyZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  legacyLocale: Intl.DateTimeFormat().resolvedOptions().locale,
};
process.stdout.write(JSON.stringify(out));
`;

interface ChildOutput {
  zone: string;
  dates: string[];
  dateTimes: string[];
  long: string;
  calendar: string;
  number: string;
  legacy: string[];
  legacyZone: string;
  legacyLocale: string;
}

/** Run the sample calls in a process configured like another machine. */
function runInChild(env: Record<string, string>): { out: ChildOutput | null; error: string } {
  const moduleUrl = `file://${join(process.cwd(), "app/utils/dates.ts")}`;
  const script = CHILD_SCRIPT.replace('"FILE_URL"', JSON.stringify(moduleUrl));
  const res = spawnSync(process.execPath, ["--experimental-strip-types", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (res.error) return { out: null, error: res.error.message };
  if (res.status !== 0) return { out: null, error: (res.stderr || "").trim().split("\n").slice(-3).join(" ") };
  try {
    return { out: JSON.parse(res.stdout) as ChildOutput, error: "" };
  } catch {
    return { out: null, error: `unparseable child output: ${res.stdout.slice(0, 120)}` };
  }
}

function main() {
  console.log("\n-- A. The formatter's own answers -------------------------------------");

  check(
    1,
    "an ordinary instant reads as the company's local time",
    formatDateTime("2026-10-04T18:31:00Z") === "2026-10-04 14:31",
    formatDateTime("2026-10-04T18:31:00Z")
  );

  check(
    2,
    "the zone is applied rather than the reader's: a UTC day is not the local day",
    formatDate("2026-03-05T03:30:00Z") === "2026-03-04",
    `${formatDate("2026-03-05T03:30:00Z")} (UTC would be 2026-03-05)`
  );

  check(
    3,
    "midnight is 00:00, never 24:00",
    formatDateTime("2026-10-04T04:00:00Z") === "2026-10-04 00:00",
    formatDateTime("2026-10-04T04:00:00Z")
  );

  /*
   * The offset is read for the instant being formatted, not fixed once. The two
   * samples are the same UTC clock time on consecutive days across the
   * spring-forward, so a formatter using a constant offset gets one of them
   * wrong — and "the times are an hour out for half the year" is exactly the
   * kind of defect that survives a casual reading.
   */
  const beforeDst = formatDateTime("2026-03-07T07:30:00Z");
  const afterDst = formatDateTime("2026-03-08T07:30:00Z");
  check(
    4,
    "the same UTC time on either side of a daylight-saving change reads as two local times",
    beforeDst === "2026-03-07 02:30" && afterDst === "2026-03-08 03:30",
    `${beforeDst} / ${afterDst}`
  );

  check(
    5,
    "the long style is assembled, not taken from a locale pattern",
    formatDate("2026-10-04T18:31:00Z", { style: "long" }) === "October 4, 2026",
    formatDate("2026-10-04T18:31:00Z", { style: "long" })
  );

  /*
   * A carrier's delivery estimate and a payout's arrival date arrive as calendar
   * dates ("2026-10-07"), which `new Date(...)` reads as midnight UTC. Read in
   * the company's zone, every one of them west of Greenwich prints the day
   * before — a warranty that starts early, an ETA that promises the wrong day.
   */
  const calendar = formatDate("2026-10-07", { timeZone: CALENDAR_DATE_TIME_ZONE });
  const calendarInCompanyZone = formatDate("2026-10-07");
  check(
    6,
    "a calendar date read in UTC keeps its day",
    calendar === "2026-10-07",
    calendar
  );
  check(
    7,
    "...and the suite can tell the two readings apart",
    calendarInCompanyZone === "2026-10-06",
    `the company's zone says ${calendarInCompanyZone}`
  );

  check(
    8,
    "a missing or unreadable value gives the caller's fallback, never 'Invalid Date'",
    formatDateTime(null) === "—" &&
      formatDateTime(undefined, { fallback: "never" }) === "never" &&
      formatDateTime("not a date", { fallback: "never" }) === "never" &&
      formatDate("", { fallback: "" }) === "",
    [formatDateTime(null), formatDateTime("not a date", { fallback: "never" })].join(" | ")
  );

  check(
    9,
    "numbers are formatted in one locale, so a French browser cannot regroup them",
    formatNumber(1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) === "1,234.50",
    formatNumber(1234.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );

  /* ------------------------------------------------------------------ */
  /* B. The same answers from a differently configured process            */
  /* ------------------------------------------------------------------ */
  console.log("\n-- B. The same calls, on a machine configured like somebody else's --");

  const here = runInChild({});
  const abroad = runInChild({ TZ: "Asia/Tokyo", LANG: "fr_CA.UTF-8", LC_ALL: "fr_CA.UTF-8" });

  check(10, "the samples can be run in a child process at all", here.out !== null && abroad.out !== null, here.error || abroad.error);

  if (here.out && abroad.out) {
    check(
      11,
      "a differently configured process resolves a different zone and locale",
      here.out.legacyZone !== abroad.out.legacyZone && here.out.legacyLocale !== abroad.out.legacyLocale,
      `${here.out.legacyZone}/${here.out.legacyLocale} vs ${abroad.out.legacyZone}/${abroad.out.legacyLocale}`
    );

    /*
     * THE HALF THAT MAKES THIS SUITE ABLE TO FAIL. The old expression is
     * computed inside each child, on that child's own machine, and it must
     * disagree with itself — otherwise the environment is not varied enough for
     * the equality below to mean anything, and this suite would be measuring
     * nothing.
     */
    check(
      12,
      "the expression that used to be on the pages still disagrees across those processes (the defect is real here)",
      JSON.stringify(here.out.legacy) !== JSON.stringify(abroad.out.legacy),
      `${here.out.legacy[0]} vs ${abroad.out.legacy[0]}`
    );

    check(
      13,
      "...and the shared formatter does not: identical dates, identical times",
      JSON.stringify(here.out.dates) === JSON.stringify(abroad.out.dates) &&
        JSON.stringify(here.out.dateTimes) === JSON.stringify(abroad.out.dateTimes),
      `${here.out.dateTimes[0]} vs ${abroad.out.dateTimes[0]}`
    );

    check(
      14,
      "...for every sample, including the long style, the calendar date and the number",
      abroad.out.long === here.out.long &&
        abroad.out.calendar === here.out.calendar &&
        abroad.out.number === here.out.number,
      [abroad.out.long, abroad.out.calendar, abroad.out.number].join(" | ")
    );

    check(
      15,
      "and the answers are the ones the suite pins, not merely equal to each other",
      JSON.stringify(abroad.out.dates) === JSON.stringify(SAMPLES.map((s) => s.date)) &&
        JSON.stringify(abroad.out.dateTimes) === JSON.stringify(SAMPLES.map((s) => s.dateTime)),
      abroad.out.dateTimes.join(" | ")
    );

    check(
      16,
      "the zone is a named constant, so a page cannot inherit the server's",
      abroad.out.zone === DISPLAY_TIME_ZONE && here.out.zone === DISPLAY_TIME_ZONE,
      `${DISPLAY_TIME_ZONE}`
    );
  }

  /* ------------------------------------------------------------------ */
  /* C. What is left in the pages                                         */
  /* ------------------------------------------------------------------ */
  console.log("\n-- C. The pages themselves --------------------------------------------");

  const files = [...sourceFiles(join(process.cwd(), "app/routes")), ...sourceFiles(join(process.cwd(), "app/components"))];
  const LOCALE_CALL = /\.toLocale(String|DateString|TimeString)\s*\(/;
  const offenders: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (LOCALE_CALL.test(source)) offenders.push(file.replace(`${process.cwd()}/`, ""));
  }

  /*
   * The scanner is shown to be capable of failing, and to not be fooled by a
   * comment: `admin.shipping.tsx` explains in prose why it no longer formats
   * dates itself, and a scanner that counted that sentence as a call site would
   * be one somebody deletes rather than one they fix.
   */
  const syntheticCall = "const s = new Date(x).toLocaleString();";
  const syntheticComment = "// this used to be new Date(x).toLocaleString()";
  check(
    17,
    "the scanner recognises a real call and ignores the same text in a comment",
    LOCALE_CALL.test(syntheticCall) && !LOCALE_CALL.test(stripComments(syntheticComment)),
    `${files.length} files scanned`
  );

  check(
    18,
    "no route or component formats a date through the runtime's own locale",
    offenders.length === 0,
    offenders.length ? offenders.join(", ") : "0 call sites"
  );

  /*
   * The one place that may call `toLocaleString` is the number formatter in the
   * shared module, and only with a pinned locale. Checked here so the rule the
   * suite enforces on every page is the same rule the shared module keeps.
   */
  const shared = stripComments(readFileSync(join(process.cwd(), "app/utils/dates.ts"), "utf8"));
  const unpinned = /\.toLocale(String|DateString|TimeString)\s*\(\s*(?!")/.test(shared);
  check(
    19,
    "the shared module's own formatter pins its locale rather than inheriting one",
    !unpinned && shared.includes('"en-CA"'),
    unpinned ? "an unpinned toLocale call remains" : "locale pinned"
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main();
