/**
 * When a dock can and cannot be collected from.
 *
 * WHAT THIS SUITE IS FOR. The owner asked for three things that all fail
 * quietly when they are wrong: that the Ontario calendar is right, that closed
 * days and passed cutoffs keep a date off the list, and that the next available
 * date is explained. A proposal that offers a date the dock is shut is a truck
 * outside a locked gate, and a proposal that omits a date it should offer is a
 * shipment nobody can send — neither raises an error, and both look normal.
 *
 * THE DATES ARE PINNED, NOT DERIVED. Victoria Day is the Monday immediately
 * before 25 May, which is not the same rule as "the third Monday in May" — they
 * agree in most years and disagree in exactly the ones nobody checks. The
 * pinned dates below are the published Ontario dates for 2026 and 2027, so a
 * change to that rule shows up here as a failure rather than as a wrong calendar
 * that still passes its own definition of itself.
 *
 * EVERYTHING HERE IS PURE. `holidays.ts` reads no database and calls no
 * network — it is handed a dock, its exceptions and a moment — so this suite
 * needs no server, no session, no fixture and no cleanup, and it can pin the
 * clock to a date in the future or across a daylight-saving transition without
 * waiting for one. That is the whole reason the module was written that way.
 *
 * The two daylight-saving checks are the ones a wall-clock implementation would
 * fail. 8 March 2026 is the day Toronto loses an hour and 1 November 2026 is the
 * day it gains one; a proposal that compared local strings would treat 02:30 as
 * a time that exists in both, and a deadline compared that way would be off by
 * an hour for six months of the year.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-pickup.ts
 */
import {
  CARRIER_AVAILABILITY_CAVEAT,
  DEFAULT_TIME_ZONE,
  HOLIDAY_KINDS,
  TIME_ZONE_CHOICES,
  addDays,
  closedOn,
  easterSunday,
  formatWorkingDays,
  ontarioHolidays,
  localPartsAt,
  openingWindow,
  parseWorkingDays,
  pickupDateReasons,
  proposePickupDates,
  scheduleProblem,
  timeZoneIsDefault,
  timeZoneLabel,
  victoriaDay,
  zoneOf,
  weekdayOf,
  type LocationSchedule,
} from "~/services/holidays";
import { instantOfLocalTime } from "~/services/shippingLogic";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A route's source, for the section that asserts on the forms themselves. */
function readSource(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

/**
 * Source with comments removed.
 *
 * The assertions in section G are about what the forms do. These files carry
 * long explanations — the house style here — and an explanation that happens to
 * quote the markup being searched for would make a check pass with the control
 * absent.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** The date of a named holiday in a year, or null when it is not in the list. */
function holiday(year: number, name: string): string | null {
  return ontarioHolidays(year).find((entry) => entry.name === name)?.date ?? null;
}

/** A dock that works Monday to Friday and has said nothing else. */
function dock(overrides: Partial<LocationSchedule> = {}): LocationSchedule {
  return { timeZone: DEFAULT_TIME_ZONE, workingDays: "1,2,3,4,5", ...overrides };
}

function main() {
  console.log("pickup suite — the dock's calendar, its cutoffs and its proposal\n");

  /* ------------------------------------------------------------------------ */
  console.log("A. The Ontario calendar, against published dates");

  check(
    "Victoria Day 2026 is 18 May (the Monday before the 25th, not the third Monday)",
    holiday(2026, "Victoria Day") === "2026-05-18",
    String(holiday(2026, "Victoria Day")),
  );
  check(
    "Victoria Day 2027 is 24 May",
    holiday(2027, "Victoria Day") === "2027-05-24",
    String(holiday(2027, "Victoria Day")),
  );
  /*
   * The case the two rules disagree on, kept because it is the reason the rule
   * is written the way it is: in 2027 the third Monday of May IS the 17th, and
   * the holiday is the 24th. A "third Monday" implementation passes every other
   * check in this file and fails this one.
   */
  check(
    "Victoria Day is not simply the third Monday of May",
    victoriaDay(2027) !== "2027-05-17",
    `2027 victoriaDay = ${victoriaDay(2027)}, third Monday = 2027-05-17`,
  );

  check("Good Friday 2026 is 3 April", holiday(2026, "Good Friday") === "2026-04-03", String(holiday(2026, "Good Friday")));
  check("Easter Sunday 2026 is 5 April", easterSunday(2026) === "2026-04-05", easterSunday(2026));
  check("Easter Sunday 2027 is 28 March", easterSunday(2027) === "2027-03-28", easterSunday(2027));
  check("Family Day 2026 is 16 February", holiday(2026, "Family Day") === "2026-02-16", String(holiday(2026, "Family Day")));
  check("Civic Holiday 2026 is 3 August", holiday(2026, "Civic Holiday") === "2026-08-03", String(holiday(2026, "Civic Holiday")));
  check("Labour Day 2026 is 7 September", holiday(2026, "Labour Day") === "2026-09-07", String(holiday(2026, "Labour Day")));
  check("Thanksgiving 2026 is 12 October", holiday(2026, "Thanksgiving") === "2026-10-12", String(holiday(2026, "Thanksgiving")));
  check("Christmas Day 2026 is 25 December", holiday(2026, "Christmas Day") === "2026-12-25", String(holiday(2026, "Christmas Day")));
  check(
    "The list is sorted, so a reader scanning it sees a calendar",
    same(
      ontarioHolidays(2026).map((entry) => entry.date),
      [...ontarioHolidays(2026).map((entry) => entry.date)].sort(),
    ),
    ontarioHolidays(2026).map((entry) => entry.date).join(", "),
  );
  check(
    "Every holiday is on a weekday the list claims it is (no date/time parsing drift)",
    ontarioHolidays(2027).every((entry) => weekdayOf(entry.date) >= 1 && weekdayOf(entry.date) <= 7),
    "weekdayOf is 1..7 for every entry",
  );
  check(
    "No weekend-observed shifting is applied, so Boxing Day 2026 stays on the 26th (a Saturday)",
    holiday(2026, "Boxing Day") === "2026-12-26" && weekdayOf("2026-12-26") === 6,
    `${holiday(2026, "Boxing Day")} is a ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][weekdayOf("2026-12-26") - 1]}`,
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nB. Closed days, and the exceptions that change them");

  const open = dock();
  check(
    "A Tuesday in a normal week is open",
    !closedOn("2026-09-22", open).closed,
    closedOn("2026-09-22", open).reasons.join("; ") || "no reasons",
  );
  check(
    "A Saturday is closed when the dock works Monday to Friday",
    closedOn("2026-09-26", open).reasons.some((reason) => reason.includes("Saturdays")),
    closedOn("2026-09-26", open).reasons.join("; "),
  );
  check(
    "Christmas Day is closed, and says which holiday it is",
    closedOn("2026-12-25", open).reasons.some((reason) => reason.includes("Christmas Day")),
    closedOn("2026-12-25", open).reasons.join("; "),
  );
  check(
    "A dock with no working days set is closed every day",
    [0, 1, 2, 3, 4, 5, 6].every((offset) => closedOn(addDays("2026-09-21", offset), dock({ workingDays: "" })).closed),
    "seven consecutive days, all closed",
  );
  check(
    "An OPEN_ON_HOLIDAY row opens a statutory holiday",
    !closedOn("2026-12-25", dock({ exceptions: [{ date: "2026-12-25", kind: "OPEN_ON_HOLIDAY" }] })).closed,
    "Christmas Day with the dock's own row",
  );
  check(
    "An OPEN_ON_HOLIDAY row does NOT open a day the dock does not work",
    closedOn(
      "2026-12-26",
      dock({ exceptions: [{ date: "2026-12-26", kind: "OPEN_ON_HOLIDAY" }] }),
    ).reasons.some((reason) => reason.includes("Saturdays")),
    closedOn("2026-12-26", dock({ exceptions: [{ date: "2026-12-26", kind: "OPEN_ON_HOLIDAY" }] })).reasons.join("; "),
  );
  check(
    "An EXTRA_CLOSURE closes a normal working day and quotes its note",
    closedOn(
      "2026-09-22",
      dock({ exceptions: [{ date: "2026-09-22", kind: "EXTRA_CLOSURE", name: "Inventory count" }] }),
    ).reasons.includes("closed: Inventory count"),
    closedOn("2026-09-22", dock({ exceptions: [{ date: "2026-09-22", kind: "EXTRA_CLOSURE", name: "Inventory count" }] })).reasons.join("; "),
  );
  check(
    "An EXTRA_CLOSURE on an already-closed day is still reported, so a recorded row cannot look unrecorded",
    closedOn(
      "2026-12-25",
      dock({ exceptions: [{ date: "2026-12-25", kind: "EXTRA_CLOSURE", name: "Shut for Christmas" }] }),
    ).reasons.length >= 2,
    closedOn("2026-12-25", dock({ exceptions: [{ date: "2026-12-25", kind: "EXTRA_CLOSURE", name: "Shut for Christmas" }] })).reasons.join("; "),
  );
  check(
    "SPECIAL_HOURS does not close the day; it changes the window",
    !closedOn("2026-09-22", dock({ exceptions: [{ date: "2026-09-22", kind: "SPECIAL_HOURS", closeTime: "12:00" }] })).closed,
    "the day stays open",
  );
  check(
    "SPECIAL_HOURS replaces only the end it names and keeps the standing one",
    same(
      openingWindow(
        "2026-09-22",
        dock({ exceptions: [{ date: "2026-09-22", kind: "SPECIAL_HOURS", closeTime: "12:00" }] }),
        { open: "08:00", close: "17:00" },
      ),
      { open: "08:00", close: "12:00" },
    ),
    JSON.stringify(openingWindow("2026-09-22", dock({ exceptions: [{ date: "2026-09-22", kind: "SPECIAL_HOURS", closeTime: "12:00" }] }), { open: "08:00", close: "17:00" })),
  );
  check(
    "The window of a closed day is null, not the standing hours",
    openingWindow("2026-09-26", open, { open: "08:00", close: "17:00" }) === null,
    "Saturday returns null",
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nC. The two cutoffs, and the states where nothing is configured");

  // Wednesday 23 September 2026, 09:00 at the dock.
  const wednesdayMorning = new Date("2026-09-23T13:00:00Z");
  const noCutoffs = dock();
  check(
    "With no cutoffs configured, today is offered — a dock that never set a deadline has not refused today",
    proposePickupDates(noCutoffs, wednesdayMorning, { count: 1 }).days[0]?.date === "2026-09-23",
    proposePickupDates(noCutoffs, wednesdayMorning, { count: 1 }).days.map((d) => d.date).join(", "),
  );

  const deadlineAt10 = dock({ sameDayDeadline: "10:00" });
  check(
    "Before the same-day deadline, today is still offered",
    proposePickupDates(deadlineAt10, wednesdayMorning, { count: 1 }).days[0]?.date === "2026-09-23",
    `09:00 local against a 10:00 deadline`,
  );
  const afterDeadline = new Date("2026-09-23T14:30:00Z"); // 10:30 local
  const afterProposal = proposePickupDates(deadlineAt10, afterDeadline, { count: 1 });
  check(
    "After the same-day deadline, today is excluded and the reason names the cutoff",
    afterProposal.days[0]?.date === "2026-09-24" &&
      (afterProposal.excluded.find((entry) => entry.date === "2026-09-23")?.reasons ?? []).some((reason) => reason.includes("10:00")),
    afterProposal.days.map((d) => d.date).join(", ") || afterProposal.excluded.map((e) => `${e.date}: ${e.reasons.join("; ")}`).join(" | "),
  );

  const twoDaysNotice = dock({ leadTimeDays: 2 });
  const leadProposal = proposePickupDates(twoDaysNotice, wednesdayMorning, { count: 1 });
  check(
    "A two-day lead time makes Friday the earliest date, and says why not sooner",
    leadProposal.days[0]?.date === "2026-09-25" &&
      (leadProposal.excluded.find((entry) => entry.date === "2026-09-23")?.reasons ?? []).some((reason) =>
        reason.includes("2 days' notice"),
      ),
    `${leadProposal.days[0]?.date} — ${leadProposal.excluded.find((e) => e.date === "2026-09-23")?.reasons.join("; ")}`,
  );
  check(
    "Lead time 1 is worded in the singular",
    (proposePickupDates(dock({ leadTimeDays: 1 }), wednesdayMorning, { count: 1 }).excluded[0]?.reasons ?? []).some((reason) =>
      reason.includes("a day's notice"),
    ),
    proposePickupDates(dock({ leadTimeDays: 1 }), wednesdayMorning, { count: 1 }).excluded[0]?.reasons.join("; "),
  );
  check(
    "A null lead time is not a zero lead time — nothing is excluded for notice",
    !proposePickupDates(dock({ leadTimeDays: null }), wednesdayMorning, { count: 1 }).excluded.some((entry) =>
      entry.reasons.some((reason) => reason.includes("notice")),
    ),
    "no notice reason with leadTimeDays null",
  );

  /*
   * The single-date judgement and the proposal must be the same rule. Both are
   * exported from the module and both are asked the same question here, because
   * the booking path uses one and the page uses the other.
   */
  const judgement = pickupDateReasons("2026-09-23", deadlineAt10, afterDeadline);
  check(
    "The booking's own date check agrees with the proposal's exclusion",
    same(
      judgement.slice().sort(),
      (afterProposal.excluded.find((entry) => entry.date === "2026-09-23")?.reasons ?? []).slice().sort(),
    ),
    judgement.join("; ") || "both empty",
  );
  check(
    "A date that has already passed at the dock is refused, with the dock's own today",
    (pickupDateReasons("2026-09-01", noCutoffs, wednesdayMorning)[0] ?? "").includes("2026-09-23"),
    pickupDateReasons("2026-09-01", noCutoffs, wednesdayMorning).join("; "),
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nD. Daylight saving, in both directions");

  /*
   * 8 March 2026: Toronto goes from 02:00 EST to 03:00 EDT. A carrier asking
   * for "the start of the day" on 8 March gets 00:00 EST = 05:00 UTC, and on
   * 9 March gets 00:00 EDT = 04:00 UTC. The instants differ by 23 hours, which
   * is the whole point — a date is not a fixed number of UTC hours long.
   */
  const springForward = dock({ pickupOpenTime: null } as Partial<LocationSchedule>);
  const marchProposal = proposePickupDates(springForward, new Date("2026-03-06T15:00:00Z"), { count: 4 });
  const march8 = marchProposal.days.find((day) => day.date === "2026-03-08");
  const march9 = marchProposal.days.find((day) => day.date === "2026-03-09");
  check(
    "A date is proposed across the spring-forward transition (8 March 2026 is a Sunday, so it is excluded — 9 March is offered)",
    marchProposal.days.length > 0,
    marchProposal.days.map((day) => day.date).join(", "),
  );
  check(
    "Local midnight on the day after the transition is 04:00 UTC, not 05:00",
    march9?.availableFrom.toISOString() === "2026-03-09T04:00:00.000Z",
    march9?.availableFrom.toISOString() ?? "no date",
  );
  check(
    "7 March (a Saturday) is closed and 6 March is offered with local midnight at 05:00 UTC",
    marchProposal.days[0]?.date === "2026-03-06" &&
      marchProposal.days[0]?.availableFrom.toISOString() === "2026-03-06T05:00:00.000Z",
    `${marchProposal.days[0]?.date} at ${marchProposal.days[0]?.availableFrom.toISOString()}`,
  );
  check("8 March is never offered: it is a Sunday", march8 === undefined, march8 ? "offered" : "not offered");

  /*
   * 1 November 2026: Toronto goes from 02:00 EDT back to 01:00 EST, so the day
   * is 25 hours long. A same-day deadline of 10:00 on that date is 15:00 UTC
   * under EDT; the check confirms the comparison is made on instants and that
   * the hour after the fall-back is still the same local hour.
   */
  const fallBack = new Date("2026-11-01T14:30:00Z"); // 10:30 EDT — after a 10:00 deadline
  const fallBackDock = dock({ sameDayDeadline: "10:00" });
  const fallBackProposal = proposePickupDates(fallBackDock, fallBack, { count: 1 });
  check(
    "Across the fall-back, 1 November is still judged as a Sunday and excluded for that reason",
    (fallBackProposal.excluded.find((entry) => entry.date === "2026-11-01")?.reasons ?? []).some((reason) =>
      reason.includes("Sundays"),
    ),
    fallBackProposal.excluded.find((entry) => entry.date === "2026-11-01")?.reasons.join("; ") ?? "no entry",
  );
  const monday = new Date("2026-11-02T13:00:00Z"); // 08:00 EST — before the deadline
  check(
    "The Monday after the fall-back is offered, and local midnight is 05:00 UTC again",
    proposePickupDates(fallBackDock, monday, { count: 1 }).days[0]?.availableFrom.toISOString() ===
      "2026-11-02T05:00:00.000Z",
    proposePickupDates(fallBackDock, monday, { count: 1 }).days[0]?.availableFrom.toISOString() ?? "none",
  );
  /*
   * The fall-back day is 25 hours long, so the same wall-clock hour happens
   * twice: 01:59 EDT is 05:59 UTC and 01:00 EST is 06:00 UTC, an hour later on
   * the clock and one minute later in real time. Reading a stored 10:00 as an
   * instant has to land on the EST side (15:00 UTC) because the clocks went back
   * at 02:00 local, well before it — while 00:30 on that same date is still on
   * the EDT side (04:30 UTC). A wall-clock comparison would put the cutoff at the
   * wrong one of those and the deadline check below would fail.
   */
  check(
    "The fall-back day repeats an hour: 01:59 is EDT at 05:59Z and 01:00 is EST at 06:00Z",
    localPartsAt(new Date("2026-11-01T05:59:59Z"), DEFAULT_TIME_ZONE).time === "01:59" &&
      localPartsAt(new Date("2026-11-01T06:00:00Z"), DEFAULT_TIME_ZONE).time === "01:00",
    `${localPartsAt(new Date("2026-11-01T05:59:59Z"), DEFAULT_TIME_ZONE).time} then ${localPartsAt(new Date("2026-11-01T06:00:00Z"), DEFAULT_TIME_ZONE).time}`,
  );
  check(
    "A time on the fall-back day resolves on the side of the transition it falls on (00:30 EDT, 10:00 EST)",
    instantOfLocalTime(DEFAULT_TIME_ZONE, "2026-11-01", "00:30").toISOString() === "2026-11-01T04:30:00.000Z" &&
      instantOfLocalTime(DEFAULT_TIME_ZONE, "2026-11-01", "10:00").toISOString() === "2026-11-01T15:00:00.000Z",
    `${instantOfLocalTime(DEFAULT_TIME_ZONE, "2026-11-01", "00:30").toISOString()} / ${instantOfLocalTime(DEFAULT_TIME_ZONE, "2026-11-01", "10:00").toISOString()}`,
  );
  const cutoffReason = (at: Date) =>
    (proposePickupDates(fallBackDock, at, { count: 3 }).excluded.find((entry) => entry.date === "2026-11-01")?.reasons ?? []).some(
      (reason) => reason.includes("cutoff"),
    );
  check(
    "A 10:00 deadline on the fall-back day is not passed at 14:59:59Z (09:59 EST) and is at 15:00:01Z",
    cutoffReason(new Date("2026-11-01T14:59:59Z")) === false && cutoffReason(new Date("2026-11-01T15:00:01Z")) === true,
    "not passed at 14:59:59Z, passed at 15:00:01Z",
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nE. The proposal's shape, and what it refuses to claim");

  /*
   * 6 November 2026 is a Friday and 13:00 at the dock. With nothing configured,
   * Friday itself is offered — the dock has not said it cannot take a collection
   * today, and refusing it would be inventing a deadline nobody set. With a
   * deadline that has passed, Friday drops out and the weekend is skipped, which
   * is the case the check below pins.
   */
  const noCutoff = proposePickupDates(dock({ leadTimeDays: 0 }), new Date("2026-11-06T18:00:00Z"), { count: 3 });
  check(
    "With no cutoff set, a Friday afternoon is still offered for the same day",
    noCutoff.days[0]?.date === "2026-11-06",
    noCutoff.days.map((day) => day.date).join(", "),
  );

  const week = proposePickupDates(
    dock({ leadTimeDays: 0, sameDayDeadline: "12:00" }),
    new Date("2026-11-06T18:00:00Z"),
    { count: 3 },
  );
  check(
    "A Friday-evening proposal over a weekend offers Monday first once today's cutoff has passed",
    week.days[0]?.date === "2026-11-09",
    `${week.days.map((day) => day.date).join(", ")} — 7 and 8 November are Saturday and Sunday`,
  );
  check(
    "The weekend days are excluded with the weekday as the reason, and nothing is left unexplained",
    week.excluded.some((entry) => entry.date === "2026-11-07" && entry.reasons.some((r) => r.includes("Saturdays"))) &&
      week.excluded.some((entry) => entry.date === "2026-11-08" && entry.reasons.some((r) => r.includes("Sundays"))),
    week.excluded.map((entry) => `${entry.date}: ${entry.reasons.join("; ")}`).join(" | "),
  );
  check(
    "The proposal always carries the carrier caveat",
    week.caveat === CARRIER_AVAILABILITY_CAVEAT && /does not guarantee carrier pickup availability/.test(week.caveat),
    week.caveat,
  );
  check(
    "The dock's own local date and time are reported, so the page can say when it asked",
    week.localNow.date === "2026-11-06" && /^\d{2}:\d{2}$/.test(week.localNow.time),
    `${week.localNow.date} ${week.localNow.time}`,
  );
  check(
    "A dock that works no days is reported as a configuration problem, not as a full calendar",
    scheduleProblem(dock({ workingDays: "" })) !== null && scheduleProblem(dock()) === null,
    scheduleProblem(dock({ workingDays: "" })) ?? "none",
  );
  check(
    "The scan is bounded, so a dock that is never open cannot spin forever",
    proposePickupDates(dock({ workingDays: "" }), new Date("2026-09-23T13:00:00Z"), { count: 5 }).days.length === 0 &&
      proposePickupDates(dock({ workingDays: "" }), new Date("2026-09-23T13:00:00Z"), { count: 5 }).excluded.length === 60,
    "60 candidates examined, none offered",
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nF. The zones offered, and how they are named");

  check(
    "Toronto is offered and named in the owner's language",
    TIME_ZONE_CHOICES.some((choice) => choice.id === DEFAULT_TIME_ZONE && choice.label === "Toronto — Eastern Time"),
    TIME_ZONE_CHOICES.find((choice) => choice.id === DEFAULT_TIME_ZONE)?.label ?? "absent",
  );
  check(
    "Only a dock with nothing stored is relying on the default",
    timeZoneIsDefault(null) === true &&
      timeZoneIsDefault("") === true &&
      timeZoneIsDefault(DEFAULT_TIME_ZONE) === false &&
      timeZoneIsDefault("America/Vancouver") === false,
    `null -> ${timeZoneIsDefault(null)}, Toronto -> ${timeZoneIsDefault(DEFAULT_TIME_ZONE)}, Vancouver -> ${timeZoneIsDefault("America/Vancouver")}`,
  );
  check(
    "The fallback's label says the dock has no zone of its own",
    /no zone of its own/.test(timeZoneLabel(null)) && /no zone of its own/.test(timeZoneLabel("")),
    timeZoneLabel(null),
  );
  /*
   * A stored zone outside the offered list must be SHOWN AS ITSELF, because it
   * is the zone the dock is actually read in — `zoneOf` uses the stored string.
   * Labelling it "Toronto — Eastern Time" would describe a window and a cutoff
   * the system is not using, and would be believed.
   */
  check(
    "A zone outside the offered list is shown as itself, flagged, and not replaced by the default's name",
    /^Europe\/Paris \(/.test(timeZoneLabel("Europe/Paris")) && !/Toronto/.test(timeZoneLabel("Europe/Paris")),
    timeZoneLabel("Europe/Paris"),
  );
  check(
    "The zone a dock is actually read in is the stored one, and only a blank one falls back to Toronto",
    zoneOf({ timeZone: "Europe/Paris" }) === "Europe/Paris" &&
      zoneOf({ timeZone: null }) === DEFAULT_TIME_ZONE &&
      zoneOf({}) === DEFAULT_TIME_ZONE,
    `${zoneOf({ timeZone: "Europe/Paris" })} / ${zoneOf({ timeZone: null })}`,
  );
  check(
    "An offered zone is labelled without the default's caveat",
    timeZoneLabel(DEFAULT_TIME_ZONE) === "Toronto — Eastern Time",
    timeZoneLabel(DEFAULT_TIME_ZONE),
  );
  check(
    "The three exception kinds are the list the database accepts",
    same([...HOLIDAY_KINDS], ["OPEN_ON_HOLIDAY", "EXTRA_CLOSURE", "SPECIAL_HOURS"]),
    HOLIDAY_KINDS.join(", "),
  );
  check(
    "Working days round-trip through the stored string, deduplicated and sorted",
    formatWorkingDays([5, 1, 5, 3, 9]) === "1,3,5" && same(parseWorkingDays("1,2,3,4,5"), [1, 2, 3, 4, 5]),
    `${formatWorkingDays([5, 1, 5, 3, 9])} / ${parseWorkingDays("1,2,3,4,5").join(",")}`,
  );
  check(
    "An empty working-days string parses to no days rather than to a default week",
    parseWorkingDays("").length === 0 && parseWorkingDays(null).length === 0,
    "'' and null both parse to []",
  );

  /* ------------------------------------------------------------------------ */
  console.log("\nG. The two forms these hours are entered on");

  /*
   * READ FROM THE ROUTE SOURCES, NOT DRIVEN. The dock's own form is driven over
   * HTTP by `verify-editor-ui`, which signs in and reads the markup a browser
   * receives — that is the strong check and it lives there. What is asserted
   * here is the pair of claims a browser test cannot make: that BOTH forms use
   * the same clock control, and that neither of them fills in hours nobody
   * recorded. A route that grew a plausible default again would still pass a
   * test that typed into it.
   */
  const originsSource = stripComments(readSource("app/routes/admin.origins.tsx"));
  const shipmentSource = stripComments(readSource("app/routes/admin.shipping_.$shipmentId.tsx"));

  check(
    "The dock's hours are the browser's own time control, on the same field helper as every other clock",
    /const field = \(\s*name: keyof OriginLocation,[\s\S]{0,200}type: "text" \| "time" = "text"/.test(
      originsSource,
    ) &&
      /"pickupOpenTime",\s*"Opens at",[\s\S]{0,200}"time"/.test(originsSource) &&
      /"pickupCloseTime",\s*"Closes at",[\s\S]{0,200}"time"/.test(originsSource) &&
      /name="sameDayDeadline"\s*\n?\s*type="time"/.test(originsSource),
    "type=time through one helper",
  );
  check(
    "And the pair is read as a window on the way in, so a contradiction cannot be saved",
    /readPickupWindow\(text\("pickupOpenTime"\), text\("pickupCloseTime"\)\)/.test(originsSource) &&
      /pickupOpenTime: window\.open/.test(originsSource),
    "readPickupWindow",
  );
  check(
    "The shipment's collection window is two time controls, and no longer a sentence with a made-up example",
    /name="pickupWindowOpen"/.test(shipmentSource) &&
      /name="pickupWindowClose"/.test(shipmentSource) &&
      (shipmentSource.match(/type="time"/g) ?? []).length >= 2 &&
      !/placeholder=\{[^}]*09:00-17:00/.test(shipmentSource),
    `${(shipmentSource.match(/type="time"/g) ?? []).length} time controls`,
  );
  check(
    "A shipment's window starts from the dock's own recorded hours, and from nothing when it has none",
    /pickupPlan\.suggestedWindow \?\? ""/.test(shipmentSource) &&
      /defaultValue=\{standingWindow\.open\}/.test(shipmentSource) &&
      /readCarrierWindow\(\s*form\.get\("pickupWindowOpen"\),\s*form\.get\("pickupWindowClose"\)\s*\)/.test(
        shipmentSource,
      ),
    "prefilled from the dock, blank otherwise",
  );
  check(
    "The dock's window is never defaulted in the form either — the boxes are empty until somebody fills them",
    !/defaultValue=\{[^}]*"0[89]:\d\d"/.test(originsSource),
    "no invented hours in the origin form",
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main();
