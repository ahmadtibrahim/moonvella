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
  missingOriginFields,
  type OriginLocation,
} from "~/utils/originFields";
import {
  AddressOverrideNotPermitted,
  addressStatus,
  recordAddressOverride,
  recordValidation,
  validateAddress,
  type StructuredAddress,
} from "~/services/addressValidation.server";
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
        },
      };
    })
  );

  return {
    isOwner: user.role === "OWNER",
    canManage: userCan(user, "shipping.manage"),
    editingId: url.searchParams.get("location") ?? "",
    isNew: url.searchParams.get("new") === "1",
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

  try {
    switch (intent) {
      case "save_location": {
        const id = text("id");
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
          pickupOpenTime: orNull("pickupOpenTime"),
          pickupCloseTime: orNull("pickupCloseTime"),
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
        const id = text("id");
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

      case "override_address": {
        const id = text("id");
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
  const { locations, isOwner, canManage, editingId, isNew } = useLoaderData<typeof loader>();
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

      {isNew || selected ? <LocationForm location={selected} canManage={canManage} /> : null}

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

      {location.gate.blockers.length > 0 && location.missing.length === 0 ? (
        <div style={{ marginTop: "0.9rem", fontSize: "0.78rem", color: "#92400e" }}>
          {location.gate.blockers.join(" ")}
        </div>
      ) : null}

      {location.gate.differences.length > 0 ? (
        <details style={{ marginTop: "0.7rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.78rem", color: INK, fontWeight: 600 }}>
            What Google would change ({location.gate.differences.length})
          </summary>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.76rem",
              marginTop: "0.4rem",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: FAINT }}>
                <th style={{ padding: "0.25rem" }}>Field</th>
                <th style={{ padding: "0.25rem" }}>Entered</th>
                <th style={{ padding: "0.25rem" }}>Suggested</th>
              </tr>
            </thead>
            <tbody>
              {location.gate.differences.map((difference, index) => (
                <tr key={`${difference.component}-${index}`}>
                  <td style={{ padding: "0.25rem" }}>{difference.component}</td>
                  <td style={{ padding: "0.25rem" }}>{difference.entered ?? "—"}</td>
                  <td style={{ padding: "0.25rem" }}>{difference.suggested ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={helpText}>
            Nothing is changed automatically — no city, postal code, unit or country is edited on
            your behalf. Correct the fields above and check again, or have an owner accept the
            address as it stands.
          </p>
        </details>
      ) : null}

      {location.gate.overrideReason ? (
        <p style={{ ...helpText, marginTop: "0.6rem" }}>
          <strong>Accepted by an owner</strong>
          {location.gate.overriddenBy ? ` (${location.gate.overriddenBy})` : ""}:{" "}
          {location.gate.overrideReason}
        </p>
      ) : null}

      {canManage ? (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
          <Form method="post">
            <input type="hidden" name="id" value={location.id} />
            <button
              type="submit"
              name="intent"
              value="check_address"
              style={btn(INK, { solid: true })}
            >
              Check address with Google
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="id" value={location.id} />
            <input type="hidden" name="active" value={location.isActive ? "false" : "true"} />
            <button type="submit" name="intent" value="set_active" style={btn(MUTED)}>
              {location.isActive ? "Turn off" : "Turn on"}
            </button>
          </Form>
        </div>
      ) : null}

      {canManage && isOwner && location.gate.canOverride ? (
        <Form
          method="post"
          style={{ marginTop: "1rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.8rem" }}
        >
          <input type="hidden" name="id" value={location.id} />
          <label style={label} htmlFor={`reason-${location.id}`}>
            Owner: accept this address without Google
          </label>
          <input
            id={`reason-${location.id}`}
            name="reason"
            style={input}
            placeholder="Why this address is known to be correct (at least 10 characters)"
          />
          <p style={helpText}>
            The address keeps an honest verdict: it is recorded as accepted by an owner and is never
            described as validated by Google. Your name and this reason are stored in the audit log,
            because this is the one route by which an unchecked address reaches a carrier.
          </p>
          <button
            type="submit"
            name="intent"
            value="override_address"
            style={{ ...btn("#b45309"), marginTop: "0.4rem" }}
          >
            Accept anyway
          </button>
        </Form>
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
function LocationForm({ location, canManage }: { location: LocationRow | null; canManage: boolean }) {
  const stored = (location ?? {}) as unknown as Record<string, unknown>;
  const value = (field: keyof OriginLocation): string => {
    const raw = stored[String(field)];
    return raw === null || raw === undefined ? "" : String(raw);
  };
  const required = new Set<string>(REQUIRED_ORIGIN_FIELDS.map((entry) => String(entry.field)));
  const optional = new Set<string>(OPTIONAL_ORIGIN_FIELDS.map((field) => String(field)));

  const field = (name: keyof OriginLocation, text: string, hint?: string) => (
    <Field
      id={`loc-${String(name)}`}
      label={`${text}${
        required.has(String(name)) ? " *" : optional.has(String(name)) ? " (optional)" : ""
      }`}
      hint={hint}
    >
      <input
        id={`loc-${String(name)}`}
        name={String(name)}
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

      <Form method="post">
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
          {field("street1", "Street address")}
          {field(
            "street2",
            "Unit / suite",
            "Kept separate from the street on purpose: a unit folded into the street line is a different door."
          )}
          {field("city", "City")}
          {field("province", "Province / state")}
          {field("postalCode", "Postal code")}
          {field("country", "Country code", "Two letters, e.g. CA.")}
          {field(
            "timeZone",
            "Time zone",
            "IANA name, e.g. America/Toronto. The window below is read in this zone."
          )}
          {field("pickupOpenTime", "Opens at", "HH:MM in the time zone above.")}
          {field("pickupCloseTime", "Closes at")}
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
    </div>
  );
}
