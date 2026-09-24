/**
 * WHEN A DOCK CAN AND CANNOT BE COLLECTED FROM.
 *
 * This module answers one question — given a dock, its own exceptions and a
 * moment, which days may a carrier be asked to come? — and it answers it without
 * a date library, without reading the database, and without asking the network.
 * Everything it needs is passed in, which is what makes the answers testable and
 * what keeps a proposal from depending on the machine that produced it.
 *
 * THE CALENDAR IS COMPUTED, NOT STORED. Ontario's statutory holidays are rules
 * about the year ("the Monday immediately before 25 May"), so they are derived
 * from the year for any year. A stored copy would be right until it was not, and
 * the failure would be silent: a dock offered for collection on a day the
 * province closes. What IS stored is the owner's own dated exceptions, because
 * those are decisions rather than rules — see `LocationHoliday`.
 *
 * NO WEEKEND-SHIFTING IS APPLIED, DELIBERATELY. When a statutory holiday falls
 * on a Saturday or Sunday, the day employers observe moves, and it moves
 * differently for federally and provincially regulated workplaces. Guessing
 * would mean a dock closed on a day it is open, or open on a day it is closed,
 * with nobody able to see which rule was applied. So the computed list is the
 * statutory dates themselves, and an observed Monday is recorded as an
 * `EXTRA_CLOSURE` — where it is visible, dated and the owner's own decision.
 *
 * TIMES ARE INSTANTS, NEVER LOCAL STRINGS. Every comparison below happens on
 * `Date` values in UTC, and the dock's local calendar is derived from its IANA
 * zone at the moment of asking. That is what makes EST and EDT take care of
 * themselves: the same wall-clock time is a different instant in January and in
 * July, and nothing here ever compares wall-clock strings.
 */
/*
 * The zone arithmetic is NOT reimplemented here. `shippingLogic` already has the
 * three helpers that get this right — the local date of an instant, the instant
 * of a local time, and a zone's offset — and they are the ones the pickup-missed
 * check already uses. A second implementation would be a second answer to "what
 * time is it at the dock", and the day the two disagreed the proposal and the
 * missed-pickup flag would disagree with them.
 */
import { instantOfLocalTime, localDateIn } from "./shippingLogic";

/* -------------------------------------------------------------------------- *
 * Local calendar arithmetic.
 * -------------------------------------------------------------------------- */

/**
 * The weekday of a calendar date, 1 = Monday … 7 = Sunday.
 *
 * Parsed at FIXED NOON UTC rather than at midnight. `new Date("2026-03-08")` is
 * midnight UTC, which is the previous day in every zone behind UTC — so a date
 * string would name a different weekday depending on the offset of whatever
 * machine read it. Noon is far enough from both midnights that no zone can push
 * the parse across a day boundary, and the time of day is discarded immediately.
 */
export function weekdayOf(date: string): number {
  const at = new Date(`${date}T12:00:00Z`);
  const sundayZero = at.getUTCDay(); // 0 = Sunday
  return sundayZero === 0 ? 7 : sundayZero;
}

/** `'1,2,3,4,5'` → `[1,2,3,4,5]`. Anything unparseable is dropped, never guessed. */
export function parseWorkingDays(value: string | null | undefined): number[] {
  return String(value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
}

/** The inverse, for the form round trip. Sorted and de-duplicated. */
export function formatWorkingDays(days: number[]): string {
  return [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b).join(",");
}

export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/* -------------------------------------------------------------------------- *
 * The Ontario statutory calendar.
 * -------------------------------------------------------------------------- */

/**
 * Easter Sunday, by the Anonymous Gregorian algorithm.
 *
 * Hand-coded because it is the only date in the list that is not a fixed day or
 * a fixed weekday, and because the alternative — a date library — is a
 * dependency this module does not otherwise need for eleven dates a year.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(year, month, day);
}

/** "YYYY-MM-DD" from a year, a 1-based month and a day. */
export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Shift a calendar date by whole days, staying on the calendar. */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return isoDate(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/** The Nth given weekday of a month. `nthWeekday(2026, 2, 1, 3)` = 3rd Monday of Feb. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = isoDate(year, month, 1);
  const shift = (weekday - weekdayOf(first) + 7) % 7;
  return addDays(first, shift + (n - 1) * 7);
}

/**
 * The Monday immediately before 25 May — Victoria Day.
 *
 * Written as the rule rather than as "the third Monday", because the two differ:
 * in a year where 25 May is itself a Monday, the holiday is the 18th and the
 * third Monday would give the 25th. Both spellings appear in circulation, so the
 * one the province actually uses is the one implemented, and the suite pins a
 * year where they disagree.
 */
export function victoriaDay(year: number): string {
  const may25 = isoDate(year, 5, 25);
  const back = ((weekdayOf(may25) - 1 + 7) % 7) || 7;
  return addDays(may25, -back);
}

export interface StatutoryHoliday {
  /** "YYYY-MM-DD" in Ontario's own calendar. */
  date: string;
  name: string;
}

/**
 * Ontario's statutory holidays for one year.
 *
 * Remembrance Day is in the list because it is a federal statutory holiday that
 * Ontario observes for some employers, and leaving a date OUT of this list is
 * the unrecoverable direction of error: a dock offered on a day it cannot be
 * collected from produces a failed pickup nobody can explain. An owner who works
 * through a date on this list records it as `OPEN_ON_HOLIDAY`, which is one
 * visible row rather than an invisible omission.
 */
export function ontarioHolidays(year: number): StatutoryHoliday[] {
  const easter = easterSunday(year);
  return [
    { date: isoDate(year, 1, 1), name: "New Year's Day" },
    { date: nthWeekday(year, 2, 1, 3), name: "Family Day" },
    { date: addDays(easter, -2), name: "Good Friday" },
    { date: victoriaDay(year), name: "Victoria Day" },
    { date: isoDate(year, 7, 1), name: "Canada Day" },
    { date: nthWeekday(year, 8, 1, 1), name: "Civic Holiday" },
    { date: nthWeekday(year, 9, 1, 1), name: "Labour Day" },
    { date: nthWeekday(year, 10, 1, 2), name: "Thanksgiving" },
    { date: isoDate(year, 11, 11), name: "Remembrance Day" },
    { date: isoDate(year, 12, 25), name: "Christmas Day" },
    { date: isoDate(year, 12, 26), name: "Boxing Day" },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

/** The statutory holidays covering a span of years, for review on screen. */
export function ontarioHolidaysForYears(years: number[]): StatutoryHoliday[] {
  return [...new Set(years)].sort().flatMap((year) => ontarioHolidays(year));
}

/* -------------------------------------------------------------------------- *
 * The dock's own answers.
 * -------------------------------------------------------------------------- */

/**
 * The three ways a dated exception can differ from the computed calendar.
 *
 * The list is closed, and it is the same list the database constraint accepts.
 * A row of any other kind is one the proposal ignores without saying so — an
 * operator would record a closure and watch the date stay on offer — so an
 * unknown kind is refused at the form and again at the table.
 */
export const HOLIDAY_KINDS = ["OPEN_ON_HOLIDAY", "EXTRA_CLOSURE", "SPECIAL_HOURS"] as const;

export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

export const HOLIDAY_KIND_LABEL: Record<string, string> = {
  OPEN_ON_HOLIDAY: "Open on a holiday",
  EXTRA_CLOSURE: "Extra closure",
  SPECIAL_HOURS: "Special hours",
};

export interface LocationException {
  date: string;
  kind: string; // OPEN_ON_HOLIDAY | EXTRA_CLOSURE | SPECIAL_HOURS
  name?: string | null;
  openTime?: string | null;
  closeTime?: string | null;
}

export interface LocationSchedule {
  /** IANA zone. A dock with none is treated as Toronto, which is the default. */
  timeZone?: string | null;
  workingDays?: string | null;
  leadTimeDays?: number | null;
  sameDayDeadline?: string | null;
  exceptions?: LocationException[];
}

export const DEFAULT_TIME_ZONE = "America/Toronto";

/**
 * The zones this interface offers, in the owner's own language.
 *
 * A CURATED LIST RATHER THAN EVERY IANA NAME. There are six hundred of them, and
 * a searchable list of six hundred is one where the right answer and a plausible
 * wrong one sit next to each other — "America/Toronto" and "America/Tortola" are
 * two rows apart and differ by an hour and a half of someone's day. These are the
 * zones a dock that MoonVella ships from could actually be in, plus UTC, and the
 * list is one place to extend when a dock appears somewhere else.
 *
 * THE VALUE STORED IS THE IANA ID. The label is for reading; the id is what the
 * database, the proposal and the carrier all need, and storing the label would
 * mean parsing English back into a zone.
 */
export const TIME_ZONE_CHOICES: { id: string; label: string }[] = [
  { id: "America/St_Johns", label: "St. John's — Newfoundland Time" },
  { id: "America/Halifax", label: "Halifax — Atlantic Time" },
  { id: "America/Toronto", label: "Toronto — Eastern Time" },
  { id: "America/New_York", label: "New York — Eastern Time" },
  { id: "America/Winnipeg", label: "Winnipeg — Central Time" },
  { id: "America/Chicago", label: "Chicago — Central Time" },
  { id: "America/Edmonton", label: "Edmonton — Mountain Time" },
  { id: "America/Denver", label: "Denver — Mountain Time" },
  { id: "America/Phoenix", label: "Phoenix — Mountain Time (no daylight saving)" },
  { id: "America/Vancouver", label: "Vancouver — Pacific Time" },
  { id: "America/Los_Angeles", label: "Los Angeles — Pacific Time" },
  { id: "America/Anchorage", label: "Anchorage — Alaska Time" },
  { id: "Pacific/Honolulu", label: "Honolulu — Hawaii Time" },
  { id: "UTC", label: "UTC — Coordinated Universal Time" },
];

/**
 * What a stored zone is called on screen.
 *
 * AN UNLISTED ZONE IS SHOWN AS ITSELF. That is not a nicety: `zoneOf` reads the
 * stored string, so a dock holding a zone outside the offered list IS being read
 * in that zone, and labelling it "Toronto — Eastern Time" would describe a
 * window and a cutoff that the system is not using. The two cases are kept
 * apart — nothing stored is the default being applied, and something stored
 * that the list does not offer is a value to be looked at and re-picked from the
 * dropdown, flagged rather than replaced.
 */
export function timeZoneLabel(id: string | null | undefined): string {
  const stored = String(id ?? "").trim();
  if (!stored) {
    const fallback = TIME_ZONE_CHOICES.find((choice) => choice.id === DEFAULT_TIME_ZONE)!;
    return `${fallback.label} (default — this dock has no zone of its own)`;
  }
  const found = TIME_ZONE_CHOICES.find((choice) => choice.id === stored);
  if (found) return found.label;
  return `${stored} (not one of the zones offered here — choose it from the list to confirm)`;
}

/**
 * Whether a dock is being read in the default zone rather than one of its own.
 *
 * A dock that explicitly chose Toronto is NOT relying on the default: it has an
 * answer of its own, and it would keep it if the default ever moved.
 */
export function timeZoneIsDefault(id: string | null | undefined): boolean {
  return !String(id ?? "").trim();
}

export function zoneOf(location: LocationSchedule): string {
  return location.timeZone?.trim() || DEFAULT_TIME_ZONE;
}

/** The wall-clock time at a dock, "HH:MM", for an instant. */
export function localTimeIn(timeZone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    // Some ICU builds render midnight as "24" with `hour12: false`. The calendar
    // day is the same either way, but a comparison against a deadline is not.
    return `${hour === "24" ? "00" : hour}:${minute}`;
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

/** The dock's local calendar date and wall-clock time for an instant. */
export function localPartsAt(instant: Date, timeZone: string): { date: string; time: string } {
  return { date: localDateIn(timeZone, instant), time: localTimeIn(timeZone, instant) };
}

export interface ClosedReason {
  closed: boolean;
  /** Why, in the words an operator needs. Empty when the dock is open. */
  reasons: string[];
}

/**
 * Whether a dock is closed on a local date, and for which reasons.
 *
 * ALL the reasons are returned rather than the first one found, because "closed"
 * has three independent causes here and an operator fixing one of them should
 * not then be told about the next. `SPECIAL_HOURS` does NOT close a day — it
 * changes the window — so it is not a reason, and it is applied by the caller
 * that needs the window.
 */
export function closedOn(
  date: string,
  location: LocationSchedule,
  statutory: StatutoryHoliday[] = ontarioHolidays(Number(date.slice(0, 4))),
): ClosedReason {
  const reasons: string[] = [];
  const exceptions = location.exceptions ?? [];
  const onDate = (kind: string) => exceptions.filter((e) => e.date === date && e.kind === kind);

  const working = parseWorkingDays(location.workingDays);
  const weekday = weekdayOf(date);
  if (!working.includes(weekday)) {
    reasons.push(`closed ${WEEKDAY_NAMES[weekday - 1]}s`);
  }

  const statutoryHere = statutory.find((h) => h.date === date);
  if (statutoryHere && onDate("OPEN_ON_HOLIDAY").length === 0) {
    reasons.push(`${statutoryHere.name} (statutory holiday)`);
  }

  const extra = onDate("EXTRA_CLOSURE");
  for (const closure of extra) {
    reasons.push(closure.name ? `closed: ${closure.name}` : "closed by an exception on this date");
  }

  /*
   * An EXTRA_CLOSURE is reported even when the day was already closed for
   * another reason: the row exists, somebody made it on purpose, and hiding it
   * because another reason got there first is how a closure looks like it was
   * never recorded.
   */
  return { closed: reasons.length > 0, reasons };
}

/**
 * The window the dock is open on a local date, or null when it is closed.
 *
 * `SPECIAL_HOURS` wins over the dock's standing hours — that is what makes it an
 * exception rather than a note. A missing open or close leaves the standing
 * value in place, so "open late" can be expressed without also restating the
 * opening time.
 */
export function openingWindow(
  date: string,
  location: LocationSchedule,
  standing: { open: string | null | undefined; close: string | null | undefined },
): { open: string | null; close: string | null } | null {
  if (closedOn(date, location).closed) return null;
  const special = (location.exceptions ?? []).find(
    (e) => e.date === date && e.kind === "SPECIAL_HOURS",
  );
  return {
    open: special?.openTime || standing.open || null,
    close: special?.closeTime || standing.close || null,
  };
}

/* -------------------------------------------------------------------------- *
 * The proposal.
 * -------------------------------------------------------------------------- */

export interface PickupProposalDay {
  /** "YYYY-MM-DD" in the dock's own calendar. */
  date: string;
  /** The window on that date, when the dock has one on record. */
  window: { open: string | null; close: string | null } | null;
  /** The earliest instant a carrier may be asked to come on this date. */
  availableFrom: Date;
}

export interface PickupProposal {
  /** Dates that may be proposed, soonest first. */
  days: PickupProposalDay[];
  /** Why each earlier date was not offered, in order. */
  excluded: { date: string; reasons: string[] }[];
  /** The dock's local date and time when this was computed. */
  localNow: { date: string; time: string };
  /** Always present, and always last on screen. See the constant below. */
  caveat: string;
}

/** Whole calendar days from one date string to another. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00Z`).getTime();
  const b = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Why one date cannot be collected from, judged against the dock it belongs to.
 *
 * EXTRACTED SO THE OFFER AND THE REFUSAL CANNOT DISAGREE. The proposal walks a
 * range of dates and this same function decides each one, so a date the page
 * shows as available is a date a booking will accept, and a date the page omits
 * is a date the booking will refuse with the same words. Two implementations of
 * these rules would eventually differ, and the difference would show up as a
 * pickup the page offered and the server rejected — or worse, the reverse.
 *
 * A date the dock works, that is not a holiday or a closure, far enough ahead
 * and not today-after-cutoff, returns an empty list.
 */
export function pickupDateReasons(
  date: string,
  location: LocationSchedule,
  now: Date,
  localNow?: { date: string; time: string },
): string[] {
  const timeZone = zoneOf(location);
  const local = localNow ?? localPartsAt(now, timeZone);
  const offset = daysBetween(local.date, date);
  const reasons = closedOn(date, location).reasons.slice();

  if (offset < 0) {
    // The dock's own today, not the server's: a date that has already happened
    // where the goods are cannot be collected, whatever a clock elsewhere says.
    reasons.push(`that date has already passed where the dock is (today is ${local.date})`);
    return reasons;
  }

  const deadline =
    location.sameDayDeadline && /^\d{2}:\d{2}$/.test(location.sameDayDeadline)
      ? instantOfLocalTime(timeZone, local.date, location.sameDayDeadline)
      : null;
  if (offset === 0 && deadline && now.getTime() > deadline.getTime()) {
    reasons.push(`today's ${location.sameDayDeadline} cutoff has passed`);
  }

  const lead = location.leadTimeDays;
  if (typeof lead === "number" && Number.isFinite(lead) && offset < lead) {
    reasons.push(lead === 1 ? "this dock needs a day's notice" : `this dock needs ${lead} days' notice`);
  }

  return reasons;
}

/**
 * WHAT A PROPOSAL DOES NOT KNOW, and says out loud every time it is produced.
 *
 * Whether a carrier will actually collect on a given day is the carrier's
 * answer, not this dock's. A dock being open is necessary and is not sufficient,
 * and nothing in this system can check the second half — so a proposal that
 * presented an open day as a bookable collection would be making the carrier's
 * promise on its behalf.
 */
export const CARRIER_AVAILABILITY_CAVEAT =
  "Warehouse opening does not guarantee carrier pickup availability. The carrier confirms the collection.";

export const DEFAULT_PROPOSAL_DAYS = 5;
export const MAX_PROPOSAL_SCAN = 60;

/**
 * Which days a carrier may be asked to collect on, soonest first.
 *
 * THE RULES, in the order they are applied to a candidate day:
 *
 *   CLOSED      the weekday is not a working day, or a statutory holiday the
 *               dock has not opened on, or an extra closure. See `closedOn`.
 *
 *   LEAD TIME   the day is sooner than `leadTimeDays` away from the dock's own
 *               today. Zero or unset means no lead time, which is not the same
 *               as "today" — it means nothing has been configured, so no day is
 *               excluded for this reason.
 *
 *   CUTOFF      the day is the dock's today and its `sameDayDeadline` has
 *               already passed. A day with no deadline configured is never
 *               excluded here.
 *
 * TODAY IS NOT ASSUMED AWAY. A dock with no cutoff can be collected from today,
 * and refusing to offer it would be inventing a deadline. What is refused is
 * today AFTER a deadline the owner set, and the reason says so.
 *
 * `now` is a parameter rather than `new Date()` so the answer is testable and so
 * a caller that has already established the time does not have two of them.
 */
export function proposePickupDates(
  location: LocationSchedule,
  now: Date,
  opts: { count?: number; maxScan?: number; standing?: { open: string | null; close: string | null } } = {},
): PickupProposal {
  const timeZone = zoneOf(location);
  const localNow = localPartsAt(now, timeZone);
  const count = opts.count ?? DEFAULT_PROPOSAL_DAYS;
  const maxScan = opts.maxScan ?? MAX_PROPOSAL_SCAN;
  const standing = opts.standing ?? { open: null, close: null };

  const days: PickupProposalDay[] = [];
  const excluded: { date: string; reasons: string[] }[] = [];

  for (let offset = 0; offset < maxScan && days.length < count; offset += 1) {
    const date = addDays(localNow.date, offset);
    // The same rules the booking path applies to a single date, so the two
    // cannot come apart. See `pickupDateReasons`.
    const reasons = pickupDateReasons(date, location, now, localNow);

    if (reasons.length > 0) {
      excluded.push({ date, reasons });
      continue;
    }

    days.push({
      date,
      window: openingWindow(date, location, standing),
      /*
       * The earliest instant on that date a collection can be asked for: the
       * opening time where the dock has one, and the start of its day where it
       * does not. Local midnight is 00:00 through `instantOfLocalTime`, so a
       * date in a daylight-saving transition still resolves to the first instant
       * of that date in that zone rather than to a fixed UTC hour.
       */
      availableFrom: instantOfLocalTime(timeZone, date, standing.open ?? "00:00"),
    });
  }

  return { days, excluded, localNow, caveat: CARRIER_AVAILABILITY_CAVEAT };
}

/**
 * Whether a dock's own calendar can be proposed to at all, and why not.
 *
 * Reported separately from the proposal because it is a different problem: a
 * proposal that comes back with no days because every candidate was excluded is
 * a scheduling answer, and one that comes back empty because the dock works no
 * days at all is a misconfiguration. They need different sentences.
 */
export function scheduleProblem(location: LocationSchedule): string | null {
  if (parseWorkingDays(location.workingDays).length === 0) {
    return "This pickup location has no working days set, so no collection can be proposed. Set the days it is open.";
  }
  return null;
}
