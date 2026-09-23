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
  instructions: string | null;
  accessRequirements: string | null;
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
function windowIsOrdered(open: string, close: string): boolean {
  return normalizeClock(open) < normalizeClock(close);
}

export function normalizeClock(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return value.trim();
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}
