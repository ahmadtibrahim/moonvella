import { Form, Link, useActionData, useLoaderData, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, userCan } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "~/services/audit.server";
// The field lists come from the shared, client-safe module rather than from
// `origins.server`: this page renders them, and a route that reached into a
// `.server` module to lay out its own form would drag the database and the
// credential store into the browser bundle.
import {
  OPTIONAL_ORIGIN_FIELDS,
  REQUIRED_ORIGIN_FIELDS,
  SUGGESTION_TARGET_INPUTS,
  missingOriginFields,
  readPickupWindow,
  type OriginLocation,
} from "~/utils/originFields";
import { useEffect, useRef, useState } from "react";
import {
  AddressOverrideNotPermitted,
  addressStatus,
  applySuggestedAddress,
  browserKeyForPlaces,
  recordAddressOverride,
  recordValidation,
  validateAddress,
  type StructuredAddress,
} from "~/services/addressValidation.server";
// Names for the country list, codes for the value that is stored. The map is
// imported rather than duplicated so the dropdown on this form, the dropdown on
// the merchant application and the comparison rules the validator uses all read
// the same table of countries.
import { countryOptions, countryValue } from "~/utils/countries";
// The address entry aid. Every decision it makes lives in this typed module —
// Google's components are read, the country is pinned, street2 cannot be
// reached from a suggestion — and this page only assigns what comes back.
import { localDateIn } from "~/services/shippingLogic";
import {
  DEFAULT_TIME_ZONE,
  HOLIDAY_KINDS,
  HOLIDAY_KIND_LABEL,
  TIME_ZONE_CHOICES,
  WEEKDAY_NAMES,
  formatWorkingDays,
  ontarioHolidaysForYears,
  parseWorkingDays,
  timeZoneLabel,
  timeZoneIsDefault,
} from "~/services/holidays";
import { createAddressEntryAid } from "~/utils/placesEntryAid";
import type { PickedAddress } from "~/utils/placesAddress";
// The address verdict panel, shared with the booking screens rather than redrawn
// here. See the note where it is rendered.
import { AddressGateCard } from "~/components/AddressGateCard";
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
  ErrorBanner,
  Field,
} from "~/components/product/ui";

/**
 * Where goods are collected from.
 *
 * THIS PAGE EXISTS BECAUSE THE ALTERNATIVE IS A COPIED ADDRESS. A dock's address,
 * its contacts and its opening hours are entered once here and referenced from
 * products and variants; the moment the same address is typed onto each product,
 * correcting it becomes a hunt through the catalogue, and the parcel that ships
 * from the stale copy is discovered at the gate. The work order forbids
 * inferring an origin from a supplier's billing address, so nothing on this page
 * has a default — every field is either filled in or reported as missing.
 *
 * AN INCOMPLETE LOCATION IS NOT A BROKEN PAGE. It can be saved as a draft, and
 * it will refuse to be used for quoting or booking until it is finished: the
 * missing list shown below is the same list the resolver returns, so what is
 * displayed here and what blocks a booking cannot disagree.
 *
 * THE ADDRESS CHECK VALIDATES WHAT IS STORED, NOT WHAT IS TYPED. Saving and then
 * checking is deliberate — a check against a form that was never saved would
 * leave a passing verdict attached to an address nobody wrote down.
 *
 * AN OVERRIDE IS NEVER A VALIDATION. It is offered only to an owner, it demands
 * a reason, and the verdict it records says who accepted the address rather than
 * that Google passed it.
 */

/**
 * The three ways a parcel leaves a dock. §9's list, and the whole list.
 *
 * It is per dock because that is where the fact lives: a dock with a standing
 * collection is not asked for a one-off pickup, and a dock that hands parcels in
 * at the carrier's counter never has a truck sent at all. The same three words
 * are stored on the shipment when it is booked, so a dock's arrangement changing
 * later cannot re-answer the question for a parcel already prepared.
 */
const PICKUP_MODES = ["NEEDED", "REGULAR", "DROPOFF"] as const;

const LOCATION_SELECT = {
  id: true,
  code: true,
  isDefault: true,
  name: true,
  odooDatabase: true,
  odooCompanyId: true,
  odooWarehouseId: true,
  odooLocationId: true,
  odooPartnerId: true,
  contactName: true,
  contactPhone: true,
  contactEmail: true,
  street1: true,
  street2: true,
  city: true,
  province: true,
  postalCode: true,
  country: true,
  timeZone: true,
  pickupOpenTime: true,
  pickupCloseTime: true,
  workingDays: true,
  leadTimeDays: true,
  sameDayDeadline: true,
  instructions: true,
  accessRequirements: true,
  // Read here because missingOriginFields() takes the whole location shape and
  // the form has to show how parcels leave this dock; a select that omitted it
  // would make this page's verdict disagree with the booking gate's.
  pickupMode: true,
  isActive: true,
} as const;

/**
 * One shape for every path out of the action, so the page reads it without
 * narrowing a union. `ok` decides how the message is drawn: an address check
 * that came back "validation unavailable" is not a success and must not be
 * shown in the colour of one.
 */
export interface OriginsActionData {
  ok?: boolean;
  error?: string;
  message?: string;
  editing?: string;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requirePermission(request, "shipping.view");
  const url = new URL(request.url);

  const locations = await prisma.pickupLocation.findMany({
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
    select: {
      ...LOCATION_SELECT,
      _count: { select: { products: true, variants: true, shipmentOrigins: true } },
    },
  });

  /**
   * The verdict for each row comes from the same function the booking gate uses,
   * deliberately without pre-loading the address — a page that decided "is this
   * address current" for itself would eventually decide it differently from the
   * gate, and the disagreement would surface as a dock that looks ready and then
   * refuses to book.
   */
  const withStatus = await Promise.all(
    locations.map(async (location) => {
      const status = await addressStatus("PICKUP", location.id);
      return {
        ...location,
        missing: missingOriginFields(location),
        gate: {
          allowed: status.allowed,
          label: status.label,
          verdict: status.verdict,
          googleValidated: status.googleValidated,
          blockers: status.blockers,
          checkedAt: status.checkedAt ? status.checkedAt.toISOString() : null,
          differences: status.differences,
          overrideReason: status.overrideReason,
          overriddenBy: status.overriddenBy,
          canOverride: status.canOverride,
          /*
           * THE THREE FIELDS THE APPLY PANEL NEEDS, and their absence is why
           * this page could show a suggestion and offer no way to take it.
           *
           * `addressStatus` computes the full comparison — the suggestion, the
           * component differences, and whether the stored suggestion still
           * describes the address as it stands. This loader kept the difference
           * list and dropped the rest, so the shared `AddressGateCard` (which
           * requires `suggestionCurrent` and `suggested` before it will draw an
           * Apply button) rendered its table with no button under it: exactly
           * the "Google gave me an answer and I cannot use it" report.
           *
           * The values are Google's, read inside the service from the stored
           * verdict. Nothing here is assembled from the form.
           */
          suggested: status.suggested,
          suggestionCurrent: status.suggestionCurrent,
          original: status.original,
          latitude: status.latitude,
          longitude: status.longitude,
        },
      };
    })
  );

  // The browser key, read on the server from the encrypted store. Null unless
  // the owner has saved one, and the address fields are then exactly what they
  // were before the entry aid existed. The server-side key that can spend the
  // validation quota is not reachable from here.
  const browserKey = await browserKeyForPlaces();

  /*
   * THE CALENDAR AND THE EXCEPTIONS, SIDE BY SIDE.
   *
   * The statutory dates are COMPUTED here — this year and next, because a
   * December proposal reaches into January — and shown so the owner can read
   * what the system will exclude without having to trust it. The dock's own rows
   * are read from the database and shown beneath, because those are what it can
   * change.
   *
   * Both are passed as data rather than computed in the component: the component
   * runs in the browser too, where the clock and the zone may not be the dock's,
   * and a calendar that depended on the reader's machine would put two people
   * looking at the same dock on different days.
   */
  const thisYear = Number(localDateIn(DEFAULT_TIME_ZONE, new Date()).slice(0, 4));
  const statutory = ontarioHolidaysForYears([thisYear, thisYear + 1]);

  const holidayRows = await prisma.locationHoliday.findMany({
    orderBy: [{ date: "asc" }, { kind: "asc" }],
  });

  return {
    isOwner: user.role === "OWNER",
    canManage: userCan(user, "shipping.manage"),
    editingId: url.searchParams.get("location") ?? "",
    isNew: url.searchParams.get("new") === "1",
    browserKey,
    statutory,
    holidays: holidayRows.map((row) => ({
      id: row.id,
      locationId: row.locationId,
      date: row.date,
      kind: row.kind,
      name: row.name,
      openTime: row.openTime,
      closeTime: row.closeTime,
    })),
    locations: withStatus,
  };
}

/**
 * The structured address of a stored location.
 *
 * Every field is written back trimmed, so a stored address and this shape hash
 * identically — which is what lets the gate recognise the verdict a check made
 * here recorded. `street2` stays its own component: merging a unit into the
 * street line would make two different doors hash the same, and the work order
 * requires the unit to survive the round trip.
 */
function structuredFrom(location: {
  street1: string | null;
  street2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
}): StructuredAddress {
  return {
    street1: (location.street1 ?? "").trim(),
    street2: location.street2?.trim() || null,
    city: (location.city ?? "").trim(),
    province: (location.province ?? "").trim(),
    postalCode: (location.postalCode ?? "").trim(),
    country: (location.country ?? "").trim().toUpperCase(),
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<OriginsActionData> {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const text = (name: string) => String(form.get(name) ?? "").trim();
  /*
   * The address the two Google actions are about.
   *
   * Two field names for one value, because the shared `AddressGateCard` posts
   * `subjectId` — it serves a pickup location and an order's delivery address
   * from the same markup, so it cannot know the pickup screen calls the same
   * thing `id`. The other intents on this page post `id`, and both names are
   * read here rather than in each case so the two panels cannot be given
   * different locations to act on.
   */
  const subjectId = () => text("subjectId") || text("id");
  const orNull = (name: string) => {
    const value = text(name);
    return value === "" ? null : value;
  };
  const intOrNull = (name: string) => {
    const value = text(name);
    if (value === "") return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`${name} must be a whole number.`);
    return parsed;
  };

  /**
   * How this dock's parcels leave, refused rather than defaulted when it is not
   * one of the three answers.
   *
   * A blank means the question was never asked, and the schema's own default
   * (NEEDED — call a truck) is the safe reading of that. Anything else that is
   * not a mode is a malformed request, and silently turning it into NEEDED would
   * have a dock with a standing collection collecting one-off pickup requests
   * for every parcel, which is the exact confusion this column exists to stop.
   */
  const readPickupMode = () => {
    const value = text("pickupMode").toUpperCase();
    if (!value) return "NEEDED";
    if (!PICKUP_MODES.includes(value as (typeof PICKUP_MODES)[number])) {
      throw new Error(`Unknown pickup mode "${value}".`);
    }
    return value;
  };

  /**
   * How much notice this dock needs, or nothing at all.
   *
   * BLANK IS NOT ZERO. Blank means no lead time is configured, and the proposal
   * reads it as "any open day will do" rather than as "today, immediately" — a
   * dock that has never been asked the question has not answered it. Negative
   * notice is not a thing, so it is refused rather than stored.
   */
  const readLeadTime = () => {
    const value = text("leadTimeDays");
    if (value === "") return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("Lead time must be a whole number of days, 0 or more. Leave it blank for no lead time.");
    }
    return parsed;
  };

  /**
   * A wall-clock time, or nothing at all.
   *
   * The shape is checked here rather than trusted to the browser: a time input
   * is a convenience, not a guarantee, and a value like "10am" reaching the
   * proposal would fail its own regex there and be silently treated as no cutoff
   * — the deadline would disappear and every day would look available.
   */
  const readClock = (name: string) => {
    const value = text(name);
    if (value === "") return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new Error(`${name === "sameDayDeadline" ? "The same-day deadline" : name} must be a time like 10:00.`);
    }
    return value;
  };

  try {
    switch (intent) {
      case "save_location": {
        const id = text("id");
        /*
         * The two clock fields are read as a pair, because the rule is about the
         * pair: a window that closes before it opens is refused here with a
         * sentence naming both times, rather than stored and left for the booking
         * gate to reject silently weeks later. See `readPickupWindow`.
         */
        const window = readPickupWindow(text("pickupOpenTime"), text("pickupCloseTime"));
        const data = {
          code: text("code").toUpperCase(),
          name: text("name"),
          odooDatabase: orNull("odooDatabase"),
          odooCompanyId: intOrNull("odooCompanyId"),
          odooWarehouseId: intOrNull("odooWarehouseId"),
          odooLocationId: intOrNull("odooLocationId"),
          odooPartnerId: intOrNull("odooPartnerId"),
          contactName: orNull("contactName"),
          contactPhone: orNull("contactPhone"),
          contactEmail: orNull("contactEmail"),
          street1: orNull("street1"),
          street2: orNull("street2"),
          city: orNull("city"),
          province: orNull("province"),
          postalCode: orNull("postalCode"),
          country: text("country").toUpperCase() || null,
          timeZone: orNull("timeZone"),
          pickupOpenTime: window.open,
          pickupCloseTime: window.close,
          // Checkbox days arrive as repeated `workingDays` values, one per ticked
          // box; the service stores them as one comma-joined string. An empty
          // result is KEPT rather than defaulted — "this dock works no days" is
          // an answer, and quietly turning it into Monday-to-Friday is how a
          // dock nobody can collect from starts offering collections again.
          workingDays: formatWorkingDays(form.getAll("workingDays").map((v) => Number(v))),
          leadTimeDays: readLeadTime(),
          sameDayDeadline: readClock("sameDayDeadline"),
          pickupMode: readPickupMode(),
          instructions: orNull("instructions"),
          accessRequirements: orNull("accessRequirements"),
        };

        if (!data.code) throw new Error("A location needs a short code for products to reference.");
        if (!data.name) throw new Error("A location needs a name.");

        if (id) {
          const before = await prisma.pickupLocation.findUnique({
            where: { id },
            select: LOCATION_SELECT,
          });
          if (!before) throw new Error("That location no longer exists.");
          const updated = await prisma.pickupLocation.update({ where: { id }, data });
          await recordAudit({
            actorType: "ADMIN_USER",
            actorId: user.id,
            actorName: user.name,
            action: "origin.updated",
            entityType: AUDIT_ENTITY.PICKUP_LOCATION,
            entityId: id,
            beforeData: before,
            afterData: data,
          });
          return { ok: true, message: `Saved ${updated.name}.`, editing: id };
        }

        const created = await prisma.pickupLocation.create({ data });
        await recordAudit({
          actorType: "ADMIN_USER",
          actorId: user.id,
          actorName: user.name,
          action: "origin.created",
          entityType: AUDIT_ENTITY.PICKUP_LOCATION,
          entityId: created.id,
          afterData: data,
        });
        return {
          ok: true,
          message: `Created ${created.name}. Map it to a product before anything can ship from it.`,
          editing: created.id,
        };
      }

      case "check_address": {
        const id = subjectId();
        const location = await prisma.pickupLocation.findUnique({
          where: { id },
          select: {
            id: true,
            name: true,
            street1: true,
            street2: true,
            city: true,
            province: true,
            postalCode: true,
            country: true,
          },
        });
        if (!location) throw new Error("That location no longer exists.");

        // `refresh` because a person pressed a button that says check now. Every
        // page render goes through the cached path instead, so opening this page
        // a hundred times costs nothing and reuses the stored verdict.
        const outcome = await validateAddress(structuredFrom(location), { refresh: true });
        await recordValidation({ subjectType: "PICKUP", subjectId: id, outcome });

        if (outcome.verdict === "ACCEPTED") {
          return {
            ok: true,
            message: `${location.name}: Google accepted this address.`,
            editing: id,
          };
        }
        return {
          ok: false,
          message: `${location.name}: ${
            outcome.reason ?? "the address needs review before it can be booked against."
          }`,
          editing: id,
        };
      }

      case "apply_suggestion": {
        const id = subjectId();
        /*
         * The values written here come from the stored verdict, read inside the
         * service — never from this form. A suggestion the browser could supply
         * would be a suggestion Google never gave, and the whole point of the
         * comparison panel is that a person is agreeing to what Google said.
         * The role rule lives there too, against the stored account.
         */
        const result = await applySuggestedAddress({
          subjectType: "PICKUP",
          subjectId: id,
          actorId: user.id,
        });
        if (!result.ok) return { ok: false, error: result.error, editing: id };

        const named = await prisma.pickupLocation.findUnique({
          where: { id },
          select: { name: true },
        });
        return {
          ok: true,
          message: `${named?.name ?? "The location"}: ${result.message}`,
          editing: id,
        };
      }

      case "override_address": {
        /*
         * `subjectId`, like the other two address actions — this case read `id`
         * while the shared card posts `subjectId`, which meant the owner's
         * "Keep the entered address" button posted a form the action read an
         * empty subject out of and answered "that address could not be found."
         * The three actions are read through the same helper so they cannot
         * drift apart again.
         */
        const id = subjectId();
        // The role check that matters lives inside the service, against the
        // stored account — a role submitted by this form would be a role the
        // submitter chose.
        const result = await recordAddressOverride({
          subjectType: "PICKUP",
          subjectId: id,
          actorId: user.id,
          reason: text("reason"),
        });
        if (!result.ok) return { ok: false, error: result.error, editing: id };
        return {
          ok: true,
          message:
            "Recorded. This address is now accepted by an owner — it is not described " +
            "anywhere as validated by Google.",
          editing: id,
        };
      }

      /*
       * A DATED EXCEPTION AT ONE DOCK.
       *
       * Three kinds, and the kind is not decoration: it decides whether the date
       * is a closure, an opening or a different window. An unrecognised kind is
       * refused rather than stored, because a row the proposal does not
       * understand is a row that changes nothing while looking like it does —
       * an operator would record a closure and watch the date stay on offer.
       *
       * The date is kept as the "YYYY-MM-DD" string a date input produces, and
       * the shape is checked here as well as in the database so the message
       * names the field rather than the constraint.
       */
      case "add_holiday": {
        const locationId = text("locationId");
        const date = text("date");
        const kind = text("kind").toUpperCase();
        const name = orNull("name");
        /*
         * Special hours are a window like any other, and are read as one: a date
         * whose exception opens after it closes would replace the dock's real
         * hours for that day with a window that ends before it begins, and the
         * proposal would offer it. The pair is validated with the same rule the
         * dock's own hours go through, so the two cannot disagree about what a
         * window is — only the field names in the message differ.
         */
        const special = readPickupWindow(text("openTime"), text("closeTime"), {
          open: "Special opening time",
          close: "Special closing time",
        });
        const openTime = special.open;
        const closeTime = special.close;

        if (!locationId) throw new Error("Choose the pickup location this date applies to.");
        const location = await prisma.pickupLocation.findUnique({ where: { id: locationId }, select: { id: true, name: true } });
        if (!location) throw new Error("That pickup location no longer exists.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Choose a date.");
        if (!HOLIDAY_KINDS.includes(kind as (typeof HOLIDAY_KINDS)[number])) {
          throw new Error(`Unknown exception kind "${kind}".`);
        }
        if (kind === "SPECIAL_HOURS" && !openTime && !closeTime) {
          throw new Error(
            "Special hours need at least an opening or a closing time. To close the dock, record a closure instead.",
          );
        }

        const created = await prisma.locationHoliday.upsert({
          where: { locationId_date_kind: { locationId, date, kind } },
          create: {
            locationId,
            date,
            kind,
            name,
            // The times are dropped for the two closure kinds rather than
            // stored and ignored: a closure with an opening time on it reads as
            // a window to whoever finds the row next.
            openTime: kind === "SPECIAL_HOURS" ? openTime : null,
            closeTime: kind === "SPECIAL_HOURS" ? closeTime : null,
          },
          update: {
            name,
            openTime: kind === "SPECIAL_HOURS" ? openTime : null,
            closeTime: kind === "SPECIAL_HOURS" ? closeTime : null,
          },
        });
        await recordAudit({
          actorType: "ADMIN_USER",
          actorId: user.id,
          actorName: user.name,
          action: "origin.holiday_recorded",
          entityType: AUDIT_ENTITY.PICKUP_LOCATION,
          entityId: locationId,
          afterData: { id: created.id, date, kind, name, openTime, closeTime },
        });
        return {
          ok: true,
          message: `${HOLIDAY_KIND_LABEL[kind] ?? kind} recorded for ${date} at ${location.name}.`,
          editing: locationId,
        };
      }

      case "remove_holiday": {
        const id = text("id");
        const before = await prisma.locationHoliday.findUnique({ where: { id } });
        if (!before) throw new Error("That exception is already gone.");
        await prisma.locationHoliday.delete({ where: { id } });
        await recordAudit({
          actorType: "ADMIN_USER",
          actorId: user.id,
          actorName: user.name,
          action: "origin.holiday_removed",
          entityType: AUDIT_ENTITY.PICKUP_LOCATION,
          entityId: before.locationId,
          beforeData: { id: before.id, date: before.date, kind: before.kind, name: before.name },
        });
        return {
          ok: true,
          message: `Removed the ${before.date} exception. The computed calendar applies to that date again.`,
          editing: before.locationId,
        };
      }

      case "set_active": {
        const id = text("id");
        const active = text("active") === "true";
        const before = await prisma.pickupLocation.findUnique({
          where: { id },
          select: { name: true, isActive: true },
        });
        if (!before) throw new Error("That location no longer exists.");
        await prisma.pickupLocation.update({ where: { id }, data: { isActive: active } });
        await recordAudit({
          actorType: "ADMIN_USER",
          actorId: user.id,
          actorName: user.name,
          action: active ? "origin.activated" : "origin.deactivated",
          entityType: AUDIT_ENTITY.PICKUP_LOCATION,
          entityId: id,
          beforeData: { isActive: before.isActive },
          afterData: { isActive: active },
        });
        return {
          ok: true,
          message: active
            ? `${before.name} is active again.`
            : `${before.name} is off. Anything mapped to it now reports that a pickup ` +
              `location is required rather than shipping from somewhere else.`,
          editing: id,
        };
      }

      default:
        throw new Error("Unknown action.");
    }
  } catch (error) {
    if (error instanceof AddressOverrideNotPermitted) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Operation failed." };
  }
}

export default function AdminOrigins() {
  const { locations, isOwner, canManage, editingId, isNew, browserKey, statutory, holidays } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params] = useSearchParams();
  const editing = editingId || params.get("location") || "";
  const selected = locations.find((location) => location.id === editing) ?? null;

  return (
    <div style={{ padding: "2rem", maxWidth: 1100 }}>
      <h1 style={{ fontSize: "1.4rem", color: INK, marginBottom: "0.35rem" }}>Pickup locations</h1>
      <p style={{ ...sectionNote, maxWidth: 800 }}>
        Each dock, warehouse or supplier counter that goods are collected from. Products and
        variants point at one of these, so an address is corrected here once and everything mapped
        to it follows. Nothing is inferred from a supplier&apos;s billing address: an item with no
        location mapped cannot be quoted or booked, and says so by name.
      </p>

      {actionData?.error ? <ErrorBanner message={actionData.error} /> : null}
      {actionData?.message && !actionData?.error ? (
        <div
          role="status"
          style={{
            background: actionData.ok ? "#ecfdf5" : "#fffbeb",
            border: `1px solid ${actionData.ok ? "#a7f3d0" : "#fde68a"}`,
            color: actionData.ok ? "#065f46" : "#92400e",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.82rem",
          }}
        >
          {actionData.message}
        </div>
      ) : null}

      {canManage ? (
        <p style={{ marginBottom: "1rem" }}>
          <Link to={isNew ? "?" : "?new=1"} style={{ ...btn(INK, { solid: !isNew }), lineHeight: "1.4" }}>
            {isNew ? "Cancel" : "Add a pickup location"}
          </Link>
        </p>
      ) : null}

      {isNew || selected ? (
        <LocationForm
          location={selected}
          canManage={canManage}
          browserKey={browserKey}
          statutory={statutory}
          holidays={holidays}
        />
      ) : null}

      {locations.length === 0 ? (
        <div style={card}>
          <h2 style={sectionTitle}>No pickup locations yet</h2>
          <EmptyState>
            Until one is added and mapped to a product, nothing in the catalogue can be quoted or
            booked — the resolver reports &ldquo;Pickup location required&rdquo; rather than
            guessing an address for it.
          </EmptyState>
        </div>
      ) : null}

      {locations.map((location) => (
        <LocationCard
          key={location.id}
          location={location}
          isOwner={isOwner}
          canManage={canManage}
          open={editing === location.id}
        />
      ))}
    </div>
  );
}

type LocationRow = Awaited<ReturnType<typeof loader>>["locations"][number];

function LocationCard({
  location,
  isOwner,
  canManage,
  open,
}: {
  location: LocationRow;
  isOwner: boolean;
  canManage: boolean;
  open: boolean;
}) {
  const addressShort = [
    location.street1,
    location.street2,
    location.city,
    location.province,
    location.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
  const usage = location._count.products + location._count.variants;

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: INK }}>{location.name}</span>
            <code style={{ fontSize: "0.75rem", color: MUTED }}>{location.code}</code>
            {!location.isActive ? (
              <span
                style={{
                  display: "inline-block",
                  padding: "0.1rem 0.45rem",
                  borderRadius: 999,
                  border: "1px solid #fde68a",
                  background: "#fffbeb",
                  color: "#b45309",
                  fontSize: "0.68rem",
                  fontWeight: 700,
                }}
              >
                Off
              </span>
            ) : null}
            {/*
              * Which dock every shipment without a mapping of its own is
              * collected from. It is shown because it is the answer to "where do
              * unmapped items leave from", and an operator reading this page has
              * no other way to see it — the alternative is a default nobody can
              * name, which is how a shipment ends up booked from the wrong door.
              */}
            {location.isDefault ? (
              <span
                style={{
                  display: "inline-block",
                  padding: "0.1rem 0.45rem",
                  borderRadius: 999,
                  border: `1px solid ${LINE}`,
                  background: "#f8fafc",
                  color: INK,
                  fontSize: "0.68rem",
                  fontWeight: 700,
                }}
              >
                Default pickup
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: "0.78rem", color: MUTED, marginTop: "0.25rem" }}>
            {addressShort || "no address yet"}
            {location.timeZone ? ` · ${location.timeZone}` : ""}
          </div>
        </div>
        {canManage ? (
          <Link
            to={open ? "?" : `?location=${encodeURIComponent(location.id)}`}
            style={{ ...btn(MUTED), lineHeight: "1.4" }}
          >
            {open ? "Close" : "Edit"}
          </Link>
        ) : null}
      </div>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: "0.6rem 1rem",
          margin: "0.9rem 0 0",
          fontSize: "0.78rem",
        }}
      >
        <Fact
          label="Booking gate"
          value={location.gate.allowed ? location.gate.label : `${location.gate.label} — booking blocked`}
        />
        <Fact
          label="Address check"
          value={
            location.gate.checkedAt
              ? `${location.gate.checkedAt.slice(0, 10)}${
                  location.gate.googleValidated ? " · accepted by Google" : ""
                }`
              : "never checked"
          }
        />
        <Fact
          label="Odoo identity"
          value={
            location.odooLocationId !== null
              ? `${location.odooDatabase ?? "database not named"} · location ${location.odooLocationId}`
              : "not mapped"
          }
        />
        <Fact
          label="Collection window"
          value={
            location.pickupOpenTime && location.pickupCloseTime
              ? `${location.pickupOpenTime}–${location.pickupCloseTime}`
              : "not set"
          }
        />
        <Fact label="Contact" value={location.contactName ?? "not set"} />
        <Fact label="Used by" value={usage === 0 ? "nothing yet" : `${usage} item(s)`} />
      </dl>

      {location.missing.length > 0 ? (
        <div
          style={{
            marginTop: "0.9rem",
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: 8,
            padding: "0.7rem 0.9rem",
            fontSize: "0.78rem",
            color: "#92400e",
          }}
        >
          <strong>Pickup location required.</strong> Still missing: {location.missing.join(", ")}.
          Anything mapped here cannot be quoted or booked until these are filled in.
        </div>
      ) : null}

      {/*
        ONE ADDRESS PANEL, SHARED WITH THE BOOKING SCREENS.
        This block used to be a copy: the same verdict, the same difference
        table, and none of the actions — while `/admin/orders/:id` and the
        shipment screen drew the shared card, which does have them. The copy is
        exactly where the reported defect lived. An owner checking a dock's
        address here saw Google's correction listed, read "nothing is changed
        automatically", and had no button to apply it: the panel showed the
        answer and withheld the one action the page exists for. Applying meant
        going to a booking screen and finding the same address there, which is
        not a workflow anybody discovers.
        The card brings its own check button, Apply button and override form, so
        the copies of those below are gone rather than kept in parallel — two
        renderings of one verdict is how the two drift apart again.
      */}
      <AddressGateCard
        title="Address check"
        subjectType="PICKUP"
        subjectId={location.id}
        status={location.gate}
        isOwner={isOwner}
        canManage={canManage}
      />

      {canManage ? (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
          <Form method="post">
            <input type="hidden" name="id" value={location.id} />
            <input type="hidden" name="active" value={location.isActive ? "false" : "true"} />
            <button type="submit" name="intent" value="set_active" style={btn(MUTED)}>
              {location.isActive ? "Turn off" : "Turn on"}
            </button>
          </Form>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label: text, value }: { label: string; value: string }) {
  return (
    <div>
      <dt style={{ fontSize: "0.7rem", color: FAINT, margin: 0 }}>{text}</dt>
      <dd style={{ margin: 0, color: INK }}>{value}</dd>
    </div>
  );
}

/**
 * The form for one location.
 *
 * Every required field is marked, because the resolver refuses an incomplete
 * location and it is better to see the list here than to discover it at booking
 * time. The required set is read from the resolver's own constant rather than
 * typed out again, so the asterisks cannot drift from the rule that enforces it.
 */
function LocationForm({
  location,
  canManage,
  browserKey,
  statutory,
  holidays,
}: {
  location: LocationRow | null;
  canManage: boolean;
  browserKey: string | null;
  statutory: { date: string; name: string }[];
  holidays: {
    id: string;
    locationId: string;
    date: string;
    kind: string;
    name: string | null;
    openTime: string | null;
    closeTime: string | null;
  }[];
}) {
  const stored = (location ?? {}) as unknown as Record<string, unknown>;
  const value = (field: keyof OriginLocation): string => {
    const raw = stored[String(field)];
    return raw === null || raw === undefined ? "" : String(raw);
  };
  const required = new Set<string>(REQUIRED_ORIGIN_FIELDS.map((entry) => String(entry.field)));
  const optional = new Set<string>(OPTIONAL_ORIGIN_FIELDS.map((field) => String(field)));

  /*
   * The address entry aid.
   *
   * This form posts natively and its inputs are uncontrolled — that is what
   * makes it work before the JavaScript does — so the suggestion fills the DOM
   * values directly rather than going through state. The aid is given the street
   * input and the list and nothing else: it cannot write anywhere the mapping
   * above does not name, and that mapping has no entry for the unit.
   */
  const formRef = useRef<HTMLFormElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [aidReason, setAidReason] = useState<string | null>(null);
  const [unitHint, setUnitHint] = useState<string | null>(null);

  useEffect(() => {
    if (!browserKey) return undefined;
    const form = formRef.current;
    const list = listRef.current;
    const input = form?.elements.namedItem("street1");
    if (!form || !list || !(input instanceof HTMLInputElement)) return undefined;

    const aid = createAddressEntryAid({
      apiKey: browserKey,
      input,
      list,
      onStatus: (_status, reason) => setAidReason(reason ?? null),
      onPick: (picked: PickedAddress) => {
        for (const [field, target] of Object.entries(SUGGESTION_TARGET_INPUTS)) {
          const next = picked.fields[field as keyof typeof SUGGESTION_TARGET_INPUTS];
          if (!next) continue;
          const element = form.elements.namedItem(String(target));
          // A control this does not recognise is skipped rather than forced,
          // which is why the type is checked at all.
          if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) {
            continue;
          }
          // The country is a select over two-letter codes, and the aid carries
          // whichever spelling Google answered with — normally the code, but
          // "Canada" when the record has no short form. Assigning a value no
          // option holds leaves a select with nothing selected, so the field
          // would post empty: the pick would blank a country the dock is in.
          // Folding through the same list the options come from lands the long
          // form on the code that spells it, and leaves a country the list does
          // not carry as it is — the same rule the form's own default follows.
          element.value = target === "country" ? countryValue(next) : next;
        }
        // Reported, never written: Street 2 is the unit, and the unit is the
        // dock's own line.
        setUnitHint(picked.unitHint);
      },
    });
    return () => aid.destroy();
  }, [browserKey]);

  /**
   * One field of the form.
   *
   * `type` exists for the clocks. Every time on this page is entered with the
   * browser's own time control — the same one the same-day deadline uses — and
   * the server checks the shape again regardless, because a picker is a
   * convenience and a posted value is the fact.
   */
  const field = (
    name: keyof OriginLocation,
    label: string,
    hint?: string,
    type: "text" | "time" = "text"
  ) => (
    <Field
      id={`loc-${String(name)}`}
      label={`${label}${
        required.has(String(name)) ? " *" : optional.has(String(name)) ? " (optional)" : ""
      }`}
      hint={hint}
    >
      <input
        id={`loc-${String(name)}`}
        name={String(name)}
        type={type}
        style={input}
        defaultValue={value(name)}
        disabled={!canManage}
      />
    </Field>
  );

  return (
    <div style={card}>
      <h2 style={sectionTitle}>{location ? `Edit ${location.name}` : "New pickup location"}</h2>
      <p style={sectionNote}>
        The Odoo identifiers are how stock is read from the right place: inventory is resolved at
        this location and for the owner configured on it, not from a pooled total. The contact, the
        address and the collection window are what a carrier is given, so they are required.
      </p>

      <Form method="post" ref={formRef}>
        <input type="hidden" name="id" value={location?.id ?? ""} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "0.9rem",
          }}
        >
          <Field id="loc-code" label="Code *">
            <input
              id="loc-code"
              name="code"
              style={input}
              defaultValue={location?.code ?? ""}
              placeholder="YARD-A"
              disabled={!canManage}
            />
          </Field>
          {field("name", "Location name")}
          {field("odooDatabase", "Odoo database")}
          {field("odooCompanyId", "Odoo company id", "The company the warehouse belongs to.")}
          {field("odooWarehouseId", "Odoo warehouse id")}
          {field("odooLocationId", "Odoo stock location id", "Stock is read from this location.")}
          {field(
            "odooPartnerId",
            "Odoo address record id",
            "The res.partner behind the address, where Odoo models one."
          )}
          {field("contactName", "Contact name")}
          {field("contactPhone", "Contact phone")}
          {field("contactEmail", "Contact email")}
          {/*
            * Street 1 carries the entry aid, so it is written out rather than
            * rendered by the helper above: an operator typing a dock address by
            * hand is how a postal code ends up in the wrong format, and the
            * suggestion fills the five address fields one value each.
            */}
          <Field
            id="loc-street1"
            label={`Street address${required.has("street1") ? " *" : ""}`}
          >
            <input
              id="loc-street1"
              name="street1"
              style={input}
              defaultValue={value("street1")}
              disabled={!canManage}
            />
            {browserKey ? (
              <div
                ref={listRef}
                style={{ border: `1px solid ${LINE}`, borderRadius: 6, background: "#fff", overflow: "hidden" }}
              />
            ) : null}
            {aidReason ? (
              <div style={helpText} role="status">
                Address suggestions are unavailable: {aidReason} The fields work as they always
                did.
              </div>
            ) : (
              <div style={helpText}>
                {browserKey
                  ? "Typing offers Google's suggestions, which fill the street, city, province, postal code and country. A suggestion is a convenience, not a check: the gate below still validates the saved address, and the unit is never filled from a suggestion."
                  : "Type the address in full."}
              </div>
            )}
          </Field>
          {field(
            "street2",
            "Unit / suite",
            "Kept separate from the street on purpose: a unit folded into the street line is a different door."
          )}
          {unitHint ? (
            <div style={{ ...helpText, gridColumn: "1 / -1" }}>
              Google&apos;s record for the address you chose includes “{unitHint}”. Unit / suite is
              left as you typed it — add it there if it belongs on the label.
            </div>
          ) : null}
          {field("city", "City")}
          {field("province", "Province / state")}
          {field("postalCode", "Postal code")}
          {/* A LIST, NOT A TEXT BOX, AND THE NAME ON IT IS NOT WHAT IS STORED.
              A code is what Google, Shopify, the carrier and the Odoo address
              record all want, and it is exactly what a person should not have
              to remember: the old box took "Ca" but not "Can" or "Canada", and
              an address whose country cannot be read is one nothing downstream
              will route. The options show the name and carry the code, and a
              record holding a value that is not in the list keeps that value as
              an extra option — so opening this form cannot rewrite a country
              nobody chose. */}
          <Field
            id="loc-country"
            label={`Country${required.has("country") ? " *" : ""}`}
            hint="Shown by name; stored and sent as the two-letter code."
          >
            <select
              id="loc-country"
              name="country"
              style={input}
              defaultValue={countryValue(value("country"))}
              disabled={!canManage}
            >
              {countryOptions(value("country")).map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </Field>
          {/* A LIST, NOT A TEXT BOX. An IANA name typed by hand is one typo away
              from a dock whose calendar is a different country's, and nothing on
              this page would look wrong — the window would simply be read in a
              zone nobody chose. The names shown are the owner's language
              ("Toronto — Eastern Time"); the values stored are the IANA ids. */}
          <Field
            id="loc-timeZone"
            label="Time zone"
            hint="Searchable. The opening and closing times below, the working days and every pickup date are read in this zone, so daylight saving is handled for you."
          >
            <input
              id="loc-timeZone"
              name="timeZone"
              list="loc-timeZone-list"
              style={input}
              defaultValue={value("timeZone") || DEFAULT_TIME_ZONE}
              placeholder="Search, e.g. Toronto"
              disabled={!canManage}
            />
            <datalist id="loc-timeZone-list">
              {TIME_ZONE_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </datalist>
            <div style={helpText}>
              Shown as: {timeZoneLabel(value("timeZone") || DEFAULT_TIME_ZONE)}. Toronto is Eastern
              Time: EST in winter, EDT in summer, chosen automatically.
              {location && timeZoneIsDefault(value("timeZone"))
                ? " This dock has no zone of its own saved, so it is being read in Toronto's."
                : ""}
            </div>
          </Field>
          {/*
            THE DOCK'S OWN HOURS, IN THE DOCK'S OWN ZONE, and read as one window:
            a closing time earlier than the opening time is refused on save with
            a sentence naming both. They are the hours a collection may be
            scheduled within and the window a carrier is told, so they are never
            filled in for the operator — a dock whose hours nobody has recorded
            has an empty field rather than a plausible one.
          */}
          {field(
            "pickupOpenTime",
            "Opens at",
            "A time in the zone above. Used to propose pickup dates and as the window a carrier is given.",
            "time"
          )}
          {field(
            "pickupCloseTime",
            "Closes at",
            "Must be later than Opens at, on the same day.",
            "time"
          )}
          <Field
            id="loc-leadTimeDays"
            label="Notice needed (days)"
            hint="How many days ahead a collection must be asked for. Leave blank for no notice requirement — that is not the same as zero."
          >
            <input
              id="loc-leadTimeDays"
              name="leadTimeDays"
              type="number"
              min={0}
              step={1}
              style={input}
              defaultValue={value("leadTimeDays") ?? ""}
              disabled={!canManage}
            />
          </Field>
          <Field
            id="loc-sameDayDeadline"
            label="Same-day deadline"
            hint="The time after which today can no longer be collected. Leave blank if this dock has no same-day cutoff."
          >
            <input
              id="loc-sameDayDeadline"
              name="sameDayDeadline"
              type="time"
              style={input}
              defaultValue={value("sameDayDeadline") ?? ""}
              disabled={!canManage}
            />
          </Field>
          <Field
            id="loc-workingDays"
            label="Days this dock works"
            hint="A pickup is only proposed on a ticked day that is not a statutory holiday or a closure below."
          >
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              {WEEKDAY_NAMES.map((name, index) => {
                const day = index + 1;
                // A LOCATION THAT DOES NOT EXIST YET STILL HAS TO SHOW A WEEK,
                // and the week it shows is Monday to Friday — the same default
                // the column carries. An existing dock's own answer is used as
                // it stands, INCLUDING an empty one: a dock that works no days
                // has to come back with no boxes ticked, or the next save would
                // silently give it a working week nobody chose.
                const ticked = parseWorkingDays(
                  location ? value("workingDays") : "1,2,3,4,5",
                ).includes(day);
                return (
                  <label key={name} style={{ fontSize: "0.7rem", display: "flex", gap: "0.25rem", alignItems: "center" }}>
                    <input
                      type="checkbox"
                      name="workingDays"
                      value={String(day)}
                      defaultChecked={ticked}
                      disabled={!canManage}
                    />
                    {name.slice(0, 3)}
                  </label>
                );
              })}
            </div>
          </Field>
          <Field
            id="loc-pickupMode"
            label="How parcels leave this dock"
            hint="A dock with a standing collection is never asked for a one-off pickup; a drop-off never has a truck sent. Defaults to Pickup needed."
          >
            <select
              id="loc-pickupMode"
              name="pickupMode"
              style={input}
              defaultValue={value("pickupMode") || "NEEDED"}
              disabled={!canManage}
            >
              <option value="NEEDED">Pickup needed — call a truck per shipment</option>
              <option value="REGULAR">Existing regular pickup — a standing collection takes it</option>
              <option value="DROPOFF">Drop-off — handed in at the carrier&apos;s depot</option>
            </select>
          </Field>
          {field("instructions", "Driver instructions")}
          {field(
            "accessRequirements",
            "Access requirements",
            "Dock height, forklift, tail-lift, appointment needed."
          )}
        </div>

        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {canManage ? (
            <button type="submit" name="intent" value="save_location" style={btn(INK, { solid: true })}>
              {location ? "Save location" : "Create location"}
            </button>
          ) : null}
          <Link to="?" style={{ ...btn(MUTED), lineHeight: "1.4" }}>
            Done
          </Link>
        </div>
      </Form>

      <p style={helpText}>
        A location can be saved before it is finished — it simply cannot be quoted or booked against
        until every field marked * is filled in. The booking gate reads the same list of fields, so
        this list is the whole of the requirement.
      </p>

      <HolidayPanel
        location={location}
        canManage={canManage}
        statutory={statutory}
        holidays={holidays}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * The calendar, and where this dock differs from it.
 * -------------------------------------------------------------------------- */

/**
 * THE COMPUTED CALENDAR IS SHOWN, NOT JUST APPLIED.
 *
 * A proposal that silently excludes 25 December is indistinguishable from one
 * that lost a date. So the dates the system computes are printed here in full —
 * this year and next — with the ones this dock already answers for marked, and
 * the dock's own rows sit underneath where they can be removed.
 *
 * The two halves cannot be edited into disagreement with each other either: the
 * statutory list is computed on the server from the same function the proposal
 * calls, so what is on screen is what will be excluded, and the only rows stored
 * are the differences. A date cannot exist twice with two different meanings,
 * because the computed half is not stored at all.
 *
 * THIS FORM IS SEPARATE FROM THE ONE ABOVE, deliberately. Adding a closure is
 * not a field of the location — it is a row, and rows are added and removed one
 * at a time. Folding it into `save_location` would mean a form submit that both
 * rewrites the address and rewrites the calendar, and a validation failure on
 * either would discard the other.
 */
function HolidayPanel({
  location,
  canManage,
  statutory,
  holidays,
}: {
  location: LocationRow | null;
  canManage: boolean;
  statutory: { date: string; name: string }[];
  holidays: {
    id: string;
    locationId: string;
    date: string;
    kind: string;
    name: string | null;
    openTime: string | null;
    closeTime: string | null;
  }[];
}) {
  const [kind, setKind] = useState<string>("EXTRA_CLOSURE");
  const mine = location ? holidays.filter((row) => row.locationId === location.id) : [];
  const openOn = new Set(
    mine.filter((row) => row.kind === "OPEN_ON_HOLIDAY").map((row) => row.date),
  );
  const years = [...new Set(statutory.map((h) => h.date.slice(0, 4)))];

  const describe = (row: (typeof mine)[number]) => {
    if (row.kind === "SPECIAL_HOURS") {
      const window = [row.openTime, row.closeTime].filter(Boolean).join("–");
      return window ? `open ${window}` : "special hours";
    }
    return row.name ?? "no note";
  };

  return (
    <div style={{ marginTop: "1.5rem", borderTop: `1px solid ${LINE}`, paddingTop: "1rem" }}>
      <h3 style={{ ...sectionTitle, fontSize: "1rem" }}>Holidays and closures</h3>
      <p style={{ ...sectionNote, maxWidth: 780 }}>
        The statutory calendar below is computed for Ontario, Canada — this year and next — and every
        date on it is excluded from pickup proposals. Easter moves, so Good Friday and Victoria Day
        are worked out from the calendar rather than remembered. Weekend holidays are not shifted to
        the following Monday: if this dock closes that Monday too, record it as an extra closure and
        it will be visible as a row.
      </p>

      {years.map((year) => (
        <div key={year} style={{ marginTop: "0.75rem" }}>
          <div style={{ ...label, marginBottom: "0.3rem" }}>{year} statutory holidays</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "0.3rem 0.75rem",
            }}
          >
            {statutory
              .filter((holiday) => holiday.date.startsWith(year))
              .map((holiday) => (
                <div
                  key={holiday.date}
                  style={{ fontSize: "0.75rem", color: INK, display: "flex", gap: "0.4rem" }}
                >
                  <span style={{ color: MUTED, minWidth: "5.5rem" }}>{holiday.date}</span>
                  <span>{holiday.name}</span>
                  {openOn.has(holiday.date) ? (
                    <span style={{ color: "#92400e", fontWeight: 600 }}>· you work this day</span>
                  ) : null}
                </div>
              ))}
          </div>
        </div>
      ))}

      {!location ? (
        <p style={{ ...helpText, marginTop: "0.9rem" }}>
          Save this location first, then its own exceptions can be recorded here. The calendar above
          already applies to it.
        </p>
      ) : (
        <>
          <div style={{ ...label, marginTop: "1.1rem", marginBottom: "0.3rem" }}>
            This dock&apos;s own exceptions
          </div>
          {mine.length === 0 ? (
            <p style={{ ...helpText, marginTop: 0 }}>
              None recorded. This dock follows the whole calendar above and its working days.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.6rem" }}>
              {mine.map((row) => (
                <li
                  key={row.id}
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "baseline",
                    flexWrap: "wrap",
                    fontSize: "0.78rem",
                    color: INK,
                    padding: "0.3rem 0",
                    borderBottom: `1px solid ${LINE}`,
                  }}
                >
                  <span style={{ color: MUTED, minWidth: "5.5rem" }}>{row.date}</span>
                  <span style={{ fontWeight: 600 }}>
                    {HOLIDAY_KIND_LABEL[row.kind] ?? row.kind}
                  </span>
                  <span style={{ color: MUTED }}>{describe(row)}</span>
                  {canManage ? (
                    <Form method="post" style={{ marginLeft: "auto" }}>
                      <input type="hidden" name="intent" value="remove_holiday" />
                      <input type="hidden" name="id" value={row.id} />
                      <button
                        type="submit"
                        style={{ ...btn(MUTED), padding: "0.15rem 0.5rem", fontSize: "0.72rem" }}
                      >
                        Remove
                      </button>
                    </Form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {canManage ? (
            <Form method="post">
              <input type="hidden" name="locationId" value={location.id} />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: "0.6rem",
                  alignItems: "end",
                }}
              >
                <Field id="hol-date" label="Date">
                  <input id="hol-date" name="date" type="date" style={input} required />
                </Field>
                <Field id="hol-kind" label="What happens">
                  <select
                    id="hol-kind"
                    name="kind"
                    style={input}
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    <option value="EXTRA_CLOSURE">Closed — extra closure</option>
                    <option value="OPEN_ON_HOLIDAY">Open — we work this holiday</option>
                    <option value="SPECIAL_HOURS">Different hours that day</option>
                  </select>
                </Field>
                <Field id="hol-name" label="Note">
                  <input id="hol-name" name="name" style={input} placeholder="Inventory count" />
                </Field>
                {/* The times are only offered for the kind that uses them. Shown
                    for a closure they would be filled in and then ignored, and
                    a closure carrying an opening time reads as a window to
                    whoever finds the row next. */}
                {kind === "SPECIAL_HOURS" ? (
                  <>
                    <Field id="hol-open" label="Opens at">
                      <input id="hol-open" name="openTime" type="time" style={input} />
                    </Field>
                    <Field id="hol-close" label="Closes at">
                      <input id="hol-close" name="closeTime" type="time" style={input} />
                    </Field>
                  </>
                ) : null}
                <div>
                  <button type="submit" name="intent" value="add_holiday" style={btn(INK, { solid: true })}>
                    Record
                  </button>
                </div>
              </div>
            </Form>
          ) : null}

          <p style={{ ...helpText, marginTop: "0.6rem" }}>
            A pickup is proposed only on a ticked working day that is not a statutory holiday and has
            no closure on it. Recording this dock as open on a holiday adds it back as a normal
            working day — the standing opening and closing times still apply unless you record
            different hours for it.
          </p>
        </>
      )}
    </div>
  );
}
