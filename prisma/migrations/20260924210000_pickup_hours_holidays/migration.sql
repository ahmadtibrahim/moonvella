-- Pickup hours, working days, cutoffs and dated closures.
--
-- ADDITIVE ONLY. Every column added here is nullable or carries a default that
-- reproduces today's behaviour exactly, so a dock that nobody has touched keeps
-- behaving as it does now: open whenever a carrier will come, closed on no day,
-- with no cutoff. Nothing already recorded is reinterpreted, and nothing needs
-- to be supplied before the app runs.
--
-- 1. WORKING DAYS. ISO weekday numbers, 1 = Monday through 7 = Sunday, joined
--    with commas. A STRING rather than a set of booleans or an integer array,
--    because this is a calendar fact about a place and it is read and written
--    as one value by one form. `''` is meaningful and is not the same as the
--    default: it says the dock never works, which is a real answer for a
--    location kept for records. The default is Monday to Friday.
--
-- 2. THE TWO CUTOFFS, both optional and both OFF until the owner sets them:
--
--      leadTimeDays      how many days' notice a collection needs. NULL = none.
--      sameDayDeadline   "HH:MM" in the dock's own zone, after which today can
--                        no longer be collected. NULL = no same-day cutoff.
--
--    They are SEPARATE FIELDS because they are separate facts. A dock that can
--    take a same-day collection if asked before 10:00 still cannot take one on a
--    day it is closed, and a dock with a two-day lead time may have no same-day
--    option at all. Collapsing them into one "cutoff" would make one of the two
--    answers unrepresentable.
--
--    Both NULL is the state every dock is in now, and it is not "closed": it
--    means no cutoff is configured, which the proposal reads as "any open day
--    will do" rather than inventing a deadline the owner never set.
--
-- 3. DATED EXCEPTIONS, in their own table. The Ontario statutory calendar is
--    COMPUTED, not stored — see `holidays.server.ts` — so what a dock needs to
--    record is only where it DIFFERS from that calendar: open on a day the
--    calendar closes, closed on a day it does not, or open for different hours.
--    Storing the computed calendar as rows would mean a date could exist twice
--    and disagree with itself, and the disagreement would be invisible.
--
--    `date` IS A CALENDAR STRING, not a timestamp, and that is deliberate. A
--    closure on 2026-12-25 is a fact about a date, not about an instant; stored
--    as a timestamp it would be 2026-12-24 in one zone and 2026-12-26 in
--    another, and the closure would land on the wrong day depending on who read
--    it. `openTime`/`closeTime` are ignored for the two closure kinds and are
--    the whole point of SPECIAL_HOURS.
--
--    The unique key is (location, date, kind): a dock may be open on a holiday
--    AND have special hours that day, but it may not say "extra closure" twice —
--    a duplicate there is two rows that can be removed independently, which is
--    how a closure comes back by accident.

ALTER TABLE "PickupLocation" ADD COLUMN "workingDays" TEXT NOT NULL DEFAULT '1,2,3,4,5';
ALTER TABLE "PickupLocation" ADD COLUMN "leadTimeDays" INTEGER;
ALTER TABLE "PickupLocation" ADD COLUMN "sameDayDeadline" TEXT;

CREATE TABLE "LocationHoliday" (
  "id"         TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "date"       TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "name"       TEXT,
  "openTime"   TEXT,
  "closeTime"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocationHoliday_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocationHoliday_locationId_date_kind_key"
  ON "LocationHoliday"("locationId", "date", "kind");

CREATE INDEX "LocationHoliday_locationId_date_idx"
  ON "LocationHoliday"("locationId", "date");

ALTER TABLE "LocationHoliday"
  ADD CONSTRAINT "LocationHoliday_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "PickupLocation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The kinds, refused to anything else at the database rather than only in the
-- form. An unrecognised kind would be a row the proposal silently ignores —
-- an operator would add a closure and see the date still offered.
ALTER TABLE "LocationHoliday"
  ADD CONSTRAINT "LocationHoliday_kind_check"
  CHECK ("kind" IN ('OPEN_ON_HOLIDAY', 'EXTRA_CLOSURE', 'SPECIAL_HOURS'));

-- A calendar date, not a moment. The shape is enforced so "2026-1-5" cannot be
-- stored as a second spelling of 2026-01-05 and then fail to match itself.
ALTER TABLE "LocationHoliday"
  ADD CONSTRAINT "LocationHoliday_date_check"
  CHECK ("date" ~ '^\d{4}-\d{2}-\d{2}$');
