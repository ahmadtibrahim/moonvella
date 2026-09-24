import { prisma } from "~/db.server";
import { AUDIT_ENTITY, recordAudit, type AuditInput } from "~/services/audit.server";
import {
  DEFAULT_UNITS,
  isUnitPreference,
  UNITS_VALUES,
  type UnitPreference,
} from "~/utils/measurementUnits";

/**
 * The operator's own settings — the ones that belong to whoever is running the
 * admin rather than to a store, a seller or a record.
 *
 * The first is "units": whether measurements are entered and shown in inches
 * and pounds or in centimetres and kilograms. It changes what the product form
 * offers; it changes nothing about how a measurement is stored, which stays
 * canonical so the quoting, booking and snapshot paths keep reading one thing.
 * See `~/utils/measurementUnits` for the conversions themselves.
 */

/** The key this module owns. A preference is named by the question it answers. */
export const UNITS_KEY = "units";

export const UNITS_ACTION = {
  UPDATED: "admin_preference.units_updated",
} as const;

/**
 * Which units the admin is set to, defaulting to inches and pounds.
 *
 * A missing row is not an error and not an absence of an answer: it is a
 * deployment where nobody has chosen, and the default IS the answer. That is
 * why this returns a value rather than null — a caller that had to decide what
 * null meant would decide it in more than one place.
 *
 * A stored value the module does not recognise — a hand-edited row, a value
 * from a future version read by an older one — falls back the same way instead
 * of throwing on a page that has nothing to do with the problem.
 */
export async function getUnitsPreference(): Promise<UnitPreference> {
  const row = await prisma.adminPreference.findUnique({
    where: { key: UNITS_KEY },
    select: { value: true },
  });
  return isUnitPreference(row?.value) ? row.value : DEFAULT_UNITS;
}

/**
 * Change it, and record who changed it from what.
 *
 * The value is validated here rather than trusted: this is the only write path,
 * and a preference that decides which unit a number is interpreted in must not
 * be storable as anything the reader would then ignore. The audit carries the
 * before and after so "when did the admin start reading in centimetres" is
 * answerable later — the same reason the change is audited at all, since it
 * alters what every operator sees on every product page.
 */
export async function setUnitsPreference(
  value: unknown,
  actor: Pick<AuditInput, "actorType" | "actorId" | "actorName" | "ipAddress" | "userAgent">,
): Promise<UnitPreference> {
  if (!isUnitPreference(value)) {
    throw new Error(
      `"${String(value)}" is not a unit preference. Expected one of: ${UNITS_VALUES.join(", ")}.`,
    );
  }

  const before = await getUnitsPreference();

  const saved = await prisma.adminPreference.upsert({
    where: { key: UNITS_KEY },
    create: { key: UNITS_KEY, value },
    update: { value },
  });

  await recordAudit({
    ...actor,
    action: UNITS_ACTION.UPDATED,
    entityType: AUDIT_ENTITY.ADMIN_PREFERENCE,
    entityId: saved.id,
    beforeData: { [UNITS_KEY]: before },
    afterData: { [UNITS_KEY]: value },
  });

  return value;
}

/**
 * The sentence the settings page prints after the change.
 *
 * One place, and it names the surfaces rather than saying "measurements": the
 * setting also decides what unit a shipping carton and a saved pack are read in,
 * and an operator who was told only about product sizes would reasonably think
 * those were separate.
 */
export function unitsChangedMessage(value: UnitPreference): string {
  return value === "imperial"
    ? "Inches and pounds everywhere: product measurements, shipping cartons, saved packs and shipment parcels."
    : "Centimetres and kilograms everywhere: product measurements, shipping cartons, saved packs and shipment parcels.";
}
