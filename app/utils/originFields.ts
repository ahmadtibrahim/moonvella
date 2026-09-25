/**
 * What a pickup location must carry, and the check for whether it does.
 *
 * WHY THIS IS NOT IN A `.server` FILE. The admin form tells an operator which
 * fields a location is still missing *before* they submit, so the browser needs
 * the same list the server enforces. Keeping that list behind the server
 * boundary would mean either a second copy on the client — which drifts, and
 * drifts in the direction of a form that promises one set of fields while the
 * booking gate demands another — or a form that says nothing about what is
 * missing until it is too late to fix it.
 *
 * NOTHING HERE TOUCHES THE DATABASE OR A CREDENTIAL. It is a type, two lists and
 * pure functions over them, which is what makes it safe to send to a browser.
 * The reads and writes that use this verdict live in `origins.server.ts`.
 */

import type { PlaceAddressField } from "./placesAddress";

/** The shape of a location as this module reads it. */
export interface OriginLocation {
  id: string;
  code: string;
  name: string;
  /**
   * Read here so a deactivated dock can be refused by name. It is deliberately
   * NOT one of the required FIELDS: an inactive location is complete and
   * switched off, which is a different fact from an unfinished one, and the two
   * are reported with different messages.
   */
  isActive: boolean;
  /**
   * True for the one location every shipment falls back to.
   *
   * Read here because it is shown — the page marks it as the default, and a
   * form that offered "make this the default" without saying which one already
   * is would be asking a question it had the answer to. It is not a required
   * field: a location is usable whether or not it is the default.
   */
  isDefault: boolean;
  odooDatabase: string | null;
  odooCompanyId: number | null;
  odooWarehouseId: number | null;
  odooLocationId: number | null;
  odooPartnerId: number | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  timeZone: string | null;
  pickupOpenTime: string | null;
  pickupCloseTime: string | null;
  /**
   * Which weekdays this dock works, as ISO numbers 1 = Monday to 7 = Sunday,
   * joined with commas. Empty means it works no days.
   *
   * NOT a required field, and the empty string is a real answer rather than a
   * missing one — a location kept for records has no week. The column carries a
   * Monday-to-Friday default, so a dock that has never been asked the question
   * is assumed to work a normal week rather than to be permanently closed,
   * which would quietly remove it from every proposal.
   */
  workingDays: string;
  /**
   * How many days' notice a collection needs, or null for no requirement.
   *
   * NULL IS NOT ZERO. Zero would mean "a carrier can come today", which is a
   * promise nobody at this dock has made. Null says the question has not been
   * answered, and the proposal reads it as imposing no minimum — so an
   * unanswered field cannot make a date look available that a real lead time
   * would have excluded.
   */
  leadTimeDays: number | null;
  /**
   * "HH:MM" in `timeZone`, after which today can no longer be collected, or null
   * for no same-day cutoff. Separate from `leadTimeDays` because they are
   * separate facts: a dock with a two-day lead time has no same-day option at
   * all, whatever this field says.
   */
  sameDayDeadline: string | null;
  instructions: string | null;
  accessRequirements: string | null;
  /**
   * NEEDED | REGULAR | DROPOFF — how parcels leave this dock by default.
   *
   * Read here rather than only on the server because it is a fact the form has
   * to show and the booking has to copy onto the shipment; it is deliberately
   * NOT a required field, since a location that has never been asked the
   * question is NEEDED and that is a usable answer.
   */
  pickupMode: string;
}

/**
 * The fields a location must carry before it can be collected from.
 *
 * Order is the order they appear on the form, so the "missing" list reads the
 * way the operator scans the page rather than alphabetically.
 */
export const REQUIRED_ORIGIN_FIELDS: { field: keyof OriginLocation; label: string }[] = [
  { field: "name", label: "location name" },
  { field: "odooCompanyId", label: "Odoo company id" },
  { field: "odooWarehouseId", label: "Odoo warehouse id" },
  { field: "odooLocationId", label: "Odoo location id" },
  { field: "odooPartnerId", label: "Odoo address record id" },
  { field: "contactName", label: "contact name" },
  { field: "contactPhone", label: "contact phone" },
  { field: "contactEmail", label: "contact email" },
  { field: "street1", label: "street" },
  { field: "city", label: "city" },
  { field: "province", label: "province/state" },
  { field: "postalCode", label: "postal code" },
  { field: "country", label: "country" },
  { field: "timeZone", label: "time zone" },
  { field: "pickupOpenTime", label: "pickup opening time" },
  { field: "pickupCloseTime", label: "pickup closing time" },
];

/**
 * Fields that are genuinely optional for some docks, listed here so the
 * exclusion is a decision on the record rather than an oversight.
 */
export const OPTIONAL_ORIGIN_FIELDS: (keyof OriginLocation)[] = [
  "street2",
  "instructions",
  "accessRequirements",
];

/**
 * Where an accepted address suggestion lands on this form.
 *
 * A suggestion arrives in the application's own column names and the inputs on
 * this page have different ones, so the bridge is written down once, next to the
 * type it writes into.
 *
 * `addressLine2` is absent, and cannot be added: Street 2 is the unit, the unit
 * is the thing that decides which door a carrier is sent to, and nothing Google
 * offers may reach it. The suggestion type has no such field either, so this is
 * a second lock on the same door rather than the only one.
 */
export const SUGGESTION_TARGET_INPUTS: Record<PlaceAddressField, keyof OriginLocation> = {
  addressLine1: "street1",
  addressCity: "city",
  addressProvinceCode: "province",
  addressPostalCode: "postalCode",
  addressCountryCode: "country",
};

/** A value counts as present only when it is not blank after trimming. */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function missingOriginFields(location: OriginLocation): string[] {
  const missing = REQUIRED_ORIGIN_FIELDS.filter((entry) => !isPresent(location[entry.field])).map(
    (entry) => entry.label
  );
  // A window that opens after it closes is not a window. Caught here rather
  // than at pickup time, where the only symptom is a driver at a locked gate.
  if (
    isPresent(location.pickupOpenTime) &&
    isPresent(location.pickupCloseTime) &&
    !windowIsOrdered(location.pickupOpenTime!, location.pickupCloseTime!)
  ) {
    missing.push("pickup window (closing time is not after opening time)");
  }
  return missing;
}

/** "HH:MM" strings compare correctly as strings once zero-padded. */
export function windowIsOrdered(open: string, close: string): boolean {
  return normalizeClock(open) < normalizeClock(close);
}

export function normalizeClock(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return value.trim();
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/**
 * The shape every clock on these forms has to arrive in.
 *
 * 24-hour, zero-padded, and nothing else. The pickers produce this and a hand
 * made request does not have to: a value like "10am" reaching the proposal would
 * fail its own regex there and be read as no cutoff at all, which is a deadline
 * that silently disappears.
 */
export const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A refusal an operator can act on, as opposed to a stack trace.
 *
 * Its own class so a caller can tell "the window you typed is not usable" apart
 * from a database error, and print the first while reporting the second.
 */
export class PickupWindowError extends Error {}

function readClockPart(value: unknown, label: string): string | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  if (!CLOCK_PATTERN.test(text)) {
    throw new PickupWindowError(`${label} must be a time of day like 08:30 (24-hour), or left blank.`);
  }
  return text;
}

/**
 * The dock's standing hours, as the form posts them.
 *
 * BOTH ENDS ARE READ TOGETHER BECAUSE THE RULE IS ABOUT THE PAIR. A window that
 * closes before it opens is not a window, and the failure it causes is invisible
 * at the form and expensive later: the proposal would offer a day and the carrier
 * would arrive to a locked gate. The booking gate already refuses such a dock
 * (`missingOriginFields` reports "closing time is not after opening time"), which
 * is exactly why the form must not store one — an operator who can save it has
 * been told the value is fine.
 *
 * A HALF WINDOW IS ALLOWED HERE and refused by the gate. A dock being written
 * down for the first time has one of the two times before it has the other, and
 * refusing to save that would lose the rest of the form with it; the incomplete
 * row is then unusable for collection, which is the honest state.
 *
 * AN OVERNIGHT WINDOW IS NOT EXPRESSIBLE, and is refused rather than stored and
 * ignored: "22:00 to 06:00" would compare as closing before it opens. The message
 * says so, because an operator whose dock really does work nights needs to know
 * that this field cannot record it rather than watch the value come back wrong.
 */
export function readPickupWindow(
  openValue: unknown,
  closeValue: unknown,
  labels: { open: string; close: string } = { open: "Opens at", close: "Closes at" }
): { open: string | null; close: string | null } {
  const open = readClockPart(openValue, labels.open);
  const close = readClockPart(closeValue, labels.close);
  if (open && close && !windowIsOrdered(open, close)) {
    // The labels are the field names the form itself shows, quoted verbatim
    // rather than folded into the sentence: an operator reading "Special
    // closing time" back is looking at a field with that label above it.
    throw new PickupWindowError(
      `${labels.close} (${close}) is not after ${labels.open} (${open}). A ` +
        `collection window has to end later on the same day than it starts; a window running ` +
        `past midnight cannot be recorded here. Correct one of the two times, or clear both ` +
        `until the hours are known.`
    );
  }
  return { open, close };
}

/**
 * The window a carrier is asked to collect within, for one shipment.
 *
 * BOTH ENDS OR NEITHER, unlike the dock's own hours. This one is not a record of
 * how a warehouse runs — it is what the carrier is told, and half of it is not an
 * instruction anybody can follow. Blank means "use the dock's recorded hours",
 * which the scheduling service derives from the origin snapshot and refuses
 * outright when the dock has none recorded: a window nobody stated is never
 * invented here.
 */
export function readCarrierWindow(openValue: unknown, closeValue: unknown): string | null {
  const open = readClockPart(openValue, "The collection window's start");
  const close = readClockPart(closeValue, "The collection window's end");
  if (!open && !close) return null;
  if (!open || !close) {
    throw new PickupWindowError(
      "A collection window needs both a start and an end. Fill in both times, or leave both " +
        "blank to use the times recorded on the pickup location."
    );
  }
  if (!windowIsOrdered(open, close)) {
    throw new PickupWindowError(
      `The collection window ends (${close}) before it starts (${open}). Give a window that ` +
        `ends later on the same day.`
    );
  }
  return `${open}-${close}`;
}
