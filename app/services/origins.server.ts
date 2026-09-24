/**
 * Where a parcel is collected from, and who owns the stock that fills it.
 *
 * WHY THIS MODULE EXISTS AT ALL. "Pickup location" is the kind of fact that is
 * easy to fake: a supplier's billing address is right there on the partner
 * record, it usually looks plausible, and falling back to it would make every
 * quote succeed. That is exactly what must not happen. A parcel collected from
 * the address that happened to be on a billing record is a parcel collected
 * from the wrong dock, and the failure surfaces days later as a missed pickup
 * with a carrier already dispatched.
 *
 * So nothing here is inferred. An item resolves to a location through an
 * explicit mapping, or it resolves to nothing and the caller is told "pickup
 * location required" with the reason. The absence is a first-class result, not an
 * error to be smoothed over.
 *
 * THE RESOLUTION ORDER IS THREE STEPS, AND THE THIRD ONE IS NAMED. A variant may
 * override; the product supplies the default; and failing both, the ONE location
 * an operator has designated as the default answers. That third step is not the
 * fallback this file was written to refuse: the refused thing is an address that
 * happens to be lying around — a supplier's billing address, another location on
 * the account, the only dock that exists. This one is a row somebody chose, that
 * is visible on the Pickup locations page, whose address was read from the Odoo
 * warehouse the stock physically sits in, and which carries that warehouse's id
 * so it can be traced back to its source. Nothing is inherited from a category,
 * a supplier or a warehouse that was not designated.
 *
 * A DEFAULT THAT IS SWITCHED OFF IS STILL AN ANSWER, AND IT IS "NO". It comes
 * back unusable and named, exactly as a mapped location that was turned off does,
 * because the point of the switch is that nothing keeps shipping from a dock
 * somebody deactivated.
 *
 * WHAT A LOCATION MUST HAVE BEFORE IT CAN BE USED. `requiredFields` below is
 * deliberately the whole list from the work order rather than a comfortable
 * subset. A location that has a street but no closing time cannot be booked
 * against — the carrier needs to know when the door is open — and discovering
 * that at booking time, with a quote already chosen, is worse than discovering
 * it now. `street2`, `instructions` and `accessRequirements` are excluded on
 * purpose: unit numbers and gate codes genuinely do not exist at every dock,
 * and requiring them would train an operator to type a full stop into a field
 * to get past it.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { searchRead, type OdooRecord } from "./odoo.server";
// Imported for use here as well as re-exported below: the fields a location must
// carry, and the check that decides whether it can be collected from.
import { missingOriginFields, type OriginLocation } from "~/utils/originFields";

export type OriginSource = "variant" | "product" | "default" | "missing";

/**
 * The field lists and the completeness check live in `~/utils/originFields`
 * because the admin form renders them to the browser, and a form that promised
 * one set of fields while this gate demanded another would be worse than no form
 * at all. They are re-exported here so every existing importer keeps working and
 * there is still exactly one place that decides what "complete" means.
 */
export {
  REQUIRED_ORIGIN_FIELDS,
  OPTIONAL_ORIGIN_FIELDS,
  missingOriginFields,
  normalizeClock,
  type OriginLocation,
} from "~/utils/originFields";

/**
 * What "where does this item ship from" resolved to.
 *
 * Server-side by nature: it is the verdict handed to the booking gate, and the
 * location it carries is a database row. It stays here rather than travelling to
 * the browser with the field lists, because a page has no business holding a
 * location it did not ask for.
 */
export interface ResolvedOrigin {
  location: OriginLocation | null;
  source: OriginSource;
  /** Why the origin is missing or unusable. Null when everything resolved. */
  reason: string | null;
  /** Fields the location still has to be given. Empty when it is usable. */
  missing: string[];
  /** True only when a mapped, complete location was found. */
  ready: boolean;
}

/** The columns every read in this module selects, so the shape never varies. */
const ORIGIN_SELECT = {
  id: true,
  code: true,
  name: true,
  isActive: true,
  isDefault: true,
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
  // The schedule travels with the origin because the snapshot does: a shipment
  // booked in March has to be readable in August, after the dock's hours have
  // changed, and the only way that stays true is if the dock's answers were
  // copied onto the shipment at the time it was made.
  workingDays: true,
  leadTimeDays: true,
  sameDayDeadline: true,
  instructions: true,
  accessRequirements: true,
  pickupMode: true,
} as const;

function describe(location: OriginLocation, source: OriginSource): ResolvedOrigin {
  // A switched-off location is refused even though it is complete, and the
  // location comes back null rather than attached: every caller here — stock,
  // quoting, booking — treats a non-null location as one it may use, and the
  // point of the switch is that nothing keeps shipping from a dock somebody
  // turned off. (Prisma cannot filter a to-one relation, so this check has to
  // live here; selecting the column and forgetting to read it is exactly how a
  // deactivated dock would keep working.)
  if (!location.isActive) {
    return {
      location: null,
      source,
      missing: [],
      ready: false,
      reason:
        `Pickup location "${location.name}" (${location.code}) is switched off. ` +
        `Turn it on again, or map this item to a location that is in use.`,
    };
  }

  const missing = missingOriginFields(location);
  if (missing.length > 0) {
    return {
      location,
      source,
      missing,
      ready: false,
      reason:
        `Pickup location "${location.name}" (${location.code}) is missing ` +
        `${missing.join(", ")}.`,
    };
  }
  return { location, source, missing: [], ready: true, reason: null };
}

const MISSING_ORIGIN_REASON =
  "Pickup location required. This item has no collection address mapped to it, and " +
  "MoonVella will not guess one — not from the supplier's billing address, not from " +
  "another location on the account. Map a pickup location before quoting or booking.";

/**
 * Resolve the origin for one variant: the variant's own override, else the
 * product's default, else the designated default location, else nothing.
 *
 * The returned `source` says which step answered, because "inherited from the
 * product", "set on this variant" and "the default dock" are three different
 * facts and the interface shows them differently. `ready` is false whenever the
 * answer is a location that exists but cannot be collected from, which is a
 * different problem from having no location at all and gets a different message.
 */
export async function resolveOriginForVariant(variantId: string): Promise<ResolvedOrigin> {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: {
      id: true,
      pickupLocationId: true,
      pickupLocation: { select: ORIGIN_SELECT },
      product: {
        select: {
          id: true,
          name: true,
          pickupLocationId: true,
          pickupLocation: { select: ORIGIN_SELECT },
        },
      },
    },
  });

  if (!variant) {
    return { location: null, source: "missing", missing: [], ready: false, reason: "Unknown item." };
  }

  if (variant.pickupLocation) return describe(variant.pickupLocation, "variant");
  if (variant.product.pickupLocation) return describe(variant.product.pickupLocation, "product");

  // The foreign key is ON DELETE SET NULL, so this branch is a safety net rather
  // than the common path: it catches a mapping that survived its location.
  if (variant.pickupLocationId || variant.product.pickupLocationId) {
    return {
      location: null,
      source: "missing",
      missing: [],
      ready: false,
      reason:
        `Pickup location required. ${variant.product.name} points at a location that no ` +
        `longer exists.`,
    };
  }

  const fallback = await resolveDefaultOrigin();
  if (fallback) return fallback;

  return {
    location: null,
    source: "missing",
    missing: [],
    ready: false,
    reason: `${MISSING_ORIGIN_REASON} (${variant.product.name})`,
  };
}

/**
 * The default origin: the dock every shipment starts from when nothing more
 * specific says otherwise.
 *
 * THE OWNER NAMED ONE. MoonVella's stock leaves from the Premafirm Inc.
 * warehouse in Odoo — 994 Westport Cres, Unit 7A — and the Odoo sync keeps a
 * pickup location in step with that warehouse's own partner address. This is
 * where it is used: after the variant's override and the product's mapping have
 * both declined to answer, the default answers.
 *
 * WHY THIS IS NOT THE "GLOBAL DEFAULT" THE SCHEMA WARNS ABOUT. `Product.
 * pickupLocationId` is null when nobody has said where that product ships from,
 * and inventing an address for it is the failure that warning prevents. This is
 * a different thing: an address that was READ from the warehouse the stock
 * physically sits in, that an operator can see on the Pickup locations page, and
 * that carries an Odoo warehouse id so it is traceable to its source. A product
 * with a genuinely different dock still overrides it, and a product mapped to a
 * dock that has been switched off is still refused by name rather than quietly
 * falling back here.
 *
 * Returns null when no default is designated, which leaves the caller's
 * "no origin" answer exactly as it was.
 */
export async function resolveDefaultOrigin(): Promise<ResolvedOrigin | null> {
  const location = await prisma.pickupLocation.findFirst({
    where: { isDefault: true },
    select: ORIGIN_SELECT,
  });
  if (!location) return null;

  const resolved = describe(location, "default");
  return {
    ...resolved,
    reason:
      resolved.reason ??
      (resolved.ready
        ? null
        : `The default pickup location "${location.name}" (${location.code}) is not usable.`),
  };
}

export async function resolveOriginForProduct(productId: string): Promise<ResolvedOrigin> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, pickupLocationId: true, pickupLocation: { select: ORIGIN_SELECT } },
  });
  if (!product) {
    return { location: null, source: "missing", missing: [], ready: false, reason: "Unknown product." };
  }
  if (product.pickupLocation) return describe(product.pickupLocation, "product");

  const fallback = await resolveDefaultOrigin();
  if (fallback) return fallback;

  return { location: null, source: "missing", missing: [], ready: false, reason: MISSING_ORIGIN_REASON };
}

/* -------------------------------------------------------------------------- */
/* Writing the mapping                                                        */
/* -------------------------------------------------------------------------- */

export class OriginMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginMappingError";
  }
}

export interface OriginMappingChange {
  /** The product's default, or null to clear it. */
  productLocationId: string | null;
  /** Per-variant overrides; a null location clears the override (back to inherited). */
  variantOverrides: { variantId: string; locationId: string | null }[];
}

/**
 * Write a product's origin mapping in one pass.
 *
 * VALIDATED AGAINST THE DATABASE BEFORE ANYTHING IS WRITTEN. A mapping is a
 * foreign key, and Prisma's own error for a bad one names a constraint rather
 * than the dock somebody meant to pick; worse, in a form that sets several rows
 * at once, a failure part-way through leaves half the mapping applied. Every id
 * is checked first, then the rows are written in one transaction.
 *
 * AN INACTIVE LOCATION IS ACCEPTED BUT NOT ENDORSED. Mapping to a dock that is
 * switched off is sometimes exactly right — goods are moving to it next week —
 * so it is allowed here. It is not silently usable: `resolveOriginForVariant`
 * refuses it by name, and the page that offers the choice shows the dock as off.
 *
 * ONE AUDIT ENTRY PER SAVE, summarising the whole change. An entry per row would
 * bury the decision ("this product now ships from Mississauga") under the
 * bookkeeping of how many selects the form had.
 */
export async function saveOriginMappings(
  productId: string,
  change: OriginMappingChange,
  actor: { actorId: string; actorName?: string | null }
): Promise<{ product: string | null; variants: number }> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, pickupLocationId: true },
  });
  if (!product) throw new OriginMappingError("That product no longer exists.");

  const variantIds = change.variantOverrides.map((entry) => entry.variantId);
  if (variantIds.length > 0) {
    const owned = await prisma.productVariant.findMany({
      where: { id: { in: variantIds }, productId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((row) => row.id));
    const stray = variantIds.find((id) => !ownedIds.has(id));
    if (stray) throw new OriginMappingError("One of those variants is not part of this product.");
  }

  const referenced = [change.productLocationId, ...change.variantOverrides.map((entry) => entry.locationId)]
    .filter((id): id is string => Boolean(id));
  if (referenced.length > 0) {
    const found = await prisma.pickupLocation.findMany({
      where: { id: { in: [...new Set(referenced)] } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((row) => row.id));
    const missing = [...new Set(referenced)].find((id) => !foundIds.has(id));
    if (missing) throw new OriginMappingError("That pickup location no longer exists.");
  }

  const before = {
    productLocationId: product.pickupLocationId,
    overrides: await prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, pickupLocationId: true },
    }),
  };

  await prisma.$transaction([
    prisma.product.update({
      where: { id: productId },
      data: { pickupLocationId: change.productLocationId },
    }),
    ...change.variantOverrides.map((entry) =>
      prisma.productVariant.update({
        where: { id: entry.variantId },
        data: { pickupLocationId: entry.locationId },
      })
    ),
  ]);

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName ?? null,
    action: "origin.mapping_changed",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: productId,
    beforeData: before,
    afterData: {
      productLocationId: change.productLocationId,
      overrides: change.variantOverrides,
    },
  });

  return { product: change.productLocationId, variants: change.variantOverrides.length };
}

/**
 * Remove the per-variant pickup overrides named, and nothing else.
 *
 * A SEPARATE OPERATION FROM `saveOriginMappings`, on purpose. That function
 * writes the product's own default AND the variant overrides in one call, and a
 * caller that only wants to clear overrides has no value to put in the product
 * slot — passing null there to mean "I am not saying" would silently unmap the
 * product. So this narrows the reach instead: it can only ever set these
 * variants' mappings to null, it refuses any variant that is not part of the
 * product, and it touches no other column.
 *
 * CLEARING IS NOT THE SAME AS IGNORING. The overrides removed are read first and
 * written to the audit entry, because the whole reason a variant-level mapping
 * was removed from the screen is that it must not quietly keep deciding where a
 * parcel ships from — and equally must not quietly vanish. An operator who needs
 * one back can read what it was.
 */
export async function clearOriginOverrides(
  productId: string,
  variantIds: string[],
  actor: { actorId: string; actorName?: string | null },
): Promise<{ cleared: { variantId: string; was: string | null }[] }> {
  const wanted = [...new Set(variantIds.filter(Boolean))];
  if (wanted.length === 0) return { cleared: [] };

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: wanted }, productId },
    select: { id: true, pickupLocationId: true },
  });
  const foundIds = new Set(variants.map((row) => row.id));
  const stray = wanted.find((id) => !foundIds.has(id));
  if (stray) throw new OriginMappingError("One of those variants is not part of this product.");

  const withOverride = variants.filter((row) => row.pickupLocationId !== null);
  if (withOverride.length === 0) return { cleared: [] };

  await prisma.productVariant.updateMany({
    where: { id: { in: withOverride.map((row) => row.id) } },
    data: { pickupLocationId: null },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName ?? null,
    action: "origin.overrides_cleared",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: productId,
    beforeData: { overrides: withOverride },
    afterData: { overrides: withOverride.map((row) => ({ variantId: row.id, locationId: null })) },
  });

  return { cleared: withOverride.map((row) => ({ variantId: row.id, was: row.pickupLocationId })) };
}

/* -------------------------------------------------------------------------- */
/* Shipment groups                                                            */
/* -------------------------------------------------------------------------- */

export interface OriginOrderLine {
  /** The order line's own identity, so allocation names the line not the SKU. */
  orderItemId: string;
  variantId: string | null;
  sku: string;
  quantity: number;
  /** Pre-computed billed weight in kg, used only to apportion the flat charge. */
  billedWeightKg?: number | null;
}

export interface ShipmentGroup {
  /** Stable key for this run: the location id, or `unmapped:<lineId>` set. */
  key: string;
  locationId: string | null;
  location: OriginLocation | null;
  source: OriginSource;
  ready: boolean;
  reason: string | null;
  missing: string[];
  lines: OriginOrderLine[];
}

export interface GroupingResult {
  groups: ShipmentGroup[];
  /** Reasons any group cannot be booked. Empty means every group is ready. */
  blockers: string[];
  /** True when the order's items leave from more than one dock. */
  split: boolean;
}

/**
 * Split an order's lines into one group per collection address.
 *
 * ALLOCATION IS EXACT AND PER LINE. An order line is never divided between two
 * groups — the whole quantity goes to the origin its variant maps to, and the
 * allocation is by line id rather than by SKU, because two lines can share a
 * SKU and a quantity written back against the wrong one is a shipment that
 * cannot be reconciled. The caller receives every line exactly once.
 *
 * A line whose origin cannot be resolved gets a group of its own with
 * `ready: false`. It is deliberately NOT added to any mapped group: a parcel of
 * unmapped goods riding along with a mapped one is the silent fallback this
 * module exists to prevent, and it would only be discovered at the dock.
 */
export async function groupOrderLinesByOrigin(
  lines: OriginOrderLine[]
): Promise<GroupingResult> {
  const resolved = await Promise.all(
    lines.map(async (line) => ({
      line,
      origin: line.variantId
        ? await resolveOriginForVariant(line.variantId)
        : ({
            location: null,
            source: "missing" as OriginSource,
            missing: [],
            ready: false,
            reason: `Pickup location required. ${line.sku} has no variant mapped to an Odoo product.`,
          } satisfies ResolvedOrigin),
    }))
  );

  const groups = new Map<string, ShipmentGroup>();
  for (const { line, origin } of resolved) {
    const key = origin.location ? `loc:${origin.location.id}` : `line:${line.orderItemId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.lines.push(line);
      // A group is ready only if every line in it resolved to a usable
      // location; one bad line makes the whole dock un-bookable, which is the
      // honest answer because the carrier is collecting from that dock.
      if (!origin.ready) {
        existing.ready = false;
        existing.reason = existing.reason ?? origin.reason;
        existing.missing = [...new Set([...existing.missing, ...origin.missing])];
      }
      continue;
    }
    groups.set(key, {
      key,
      locationId: origin.location?.id ?? null,
      location: origin.location,
      source: origin.source,
      ready: origin.ready,
      reason: origin.reason,
      missing: origin.missing,
      lines: [line],
    });
  }

  const list = [...groups.values()];
  const blockers = list
    .filter((group) => !group.ready)
    .map((group) => group.reason ?? "Pickup location required.");

  return { groups: list, blockers, split: list.length > 1 };
}

/**
 * The dock a parcel is being prepared from, resolved once and handed to the
 * quote, the booking and the pickup.
 *
 * WHY THIS IS ONE ANSWER AND NOT THREE LOOKUPS. Quoting, booking and collection
 * are the same question asked at three moments: where does a truck go. Resolving
 * them separately is how a quote ends up priced from one address and a label
 * bought against another, and the discrepancy is invisible until a driver is
 * sent to the wrong door. The resolution therefore returns the group as well as
 * the location, so the caller can say which OTHER docks the shipment is mixed
 * with rather than only that something is wrong.
 */
export interface ShipmentOrigin {
  /** The single dock these lines leave from. Null when nothing usable resolved. */
  location: OriginLocation | null;
  /** The frozen copy written onto a shipment, so later edits cannot move it. */
  snapshot: OriginSnapshot | null;
  ready: boolean;
  reason: string | null;
  missing: string[];
  /** Every dock named by these lines, in the order they were first seen. */
  groups: ShipmentGroup[];
  /** True when the lines leave from more than one dock. */
  split: boolean;
}

/**
 * Resolve the origin for a set of order lines.
 *
 * One dock or nothing. A set of lines that resolves to two docks is refused
 * rather than assigned to either: the work order's answer to a mixed order is
 * to split it into one shipment per origin, and a shipment that quietly shipped
 * half its goods from the wrong address would be a worse outcome than an
 * operator being told to split it.
 */
export async function resolveOriginForLines(lines: OriginOrderLine[]): Promise<ShipmentOrigin> {
  const grouping = await groupOrderLinesByOrigin(lines);

  if (grouping.groups.length === 0) {
    return {
      location: null,
      snapshot: null,
      ready: false,
      missing: [],
      reason:
        "Pickup location required. This shipment has no items allocated to it, so there is " +
        "nothing to collect and no dock to collect it from.",
      groups: [],
      split: false,
    };
  }

  if (grouping.split) {
    const named = grouping.groups
      .map((group) =>
        group.location
          ? `${group.location.name} (${group.location.code})`
          : `an unmapped item (${group.lines.map((line) => line.sku).join(", ")})`
      )
      .join(" and ");
    return {
      location: null,
      snapshot: null,
      ready: false,
      missing: [],
      reason:
        `These items leave from ${grouping.groups.length} different docks: ${named}. ` +
        `Split this into one shipment per dock and quote each one — a single shipment ` +
        `collected from two addresses cannot be priced or booked honestly.`,
      groups: grouping.groups,
      split: true,
    };
  }

  const group = grouping.groups[0];
  if (!group.ready || !group.location) {
    return {
      location: null,
      snapshot: null,
      ready: false,
      missing: group.missing,
      reason: group.reason ?? MISSING_ORIGIN_REASON,
      groups: grouping.groups,
      split: false,
    };
  }

  return {
    location: group.location,
    snapshot: snapshotOrigin(group.location),
    ready: true,
    reason: null,
    missing: [],
    groups: grouping.groups,
    split: false,
  };
}

/** The address a carrier is given, once an origin has been resolved. */
export interface CarrierShipFrom {
  name: string;
  /** Street and unit in one line: carriers take a single address field. */
  address: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  /**
   * Optional, because not every address a carrier is given has them: a return
   * destination configured as an address alone is still a destination, and
   * inventing a phone number for it would put a wrong number on a label.
   */
  phone?: string | null;
  email?: string | null;
}

/**
 * Turn a frozen origin into the address a carrier is sent to.
 *
 * `street2` is joined onto `street1` rather than dropped, because at a dock with
 * units the unit number is the difference between a collection and a wasted
 * trip, and the carrier's request has one address line to put it on. The contact
 * name is preferred over the location name for the same reason: the label is
 * read by a driver looking for a person.
 */
export function carrierShipFrom(snapshot: OriginSnapshot): CarrierShipFrom {
  const unit = snapshot.address.street2?.trim();
  const street = snapshot.address.street1?.trim() ?? "";
  return {
    name: snapshot.contact.name?.trim() || snapshot.name,
    address: unit ? `${street}, ${unit}` : street,
    city: snapshot.address.city?.trim() ?? "",
    province: snapshot.address.province?.trim() ?? "",
    postalCode: snapshot.address.postalCode?.trim() ?? "",
    country: snapshot.address.country?.trim() ?? "",
    phone: snapshot.contact.phone?.trim() || null,
    email: snapshot.contact.email?.trim() || null,
  };
}

/**
 * Apportion a single flat shipping charge across the groups of one order.
 *
 * THE RULE THE WORK ORDER SETS IS NEGATIVE: splitting must not add a charge.
 * The strongest way to guarantee that is arithmetic rather than policy — the
 * parts are made to sum to the original total exactly, so no arrangement of
 * groups can produce a penny more.
 *
 * Largest-remainder rather than naive rounding, because rounding each share
 * independently loses or invents cents (three equal shares of 1000 are 333.33
 * each; rounded, that is 999 and the order is a cent short). Shares are
 * weighted by billed weight when it is known and split evenly when it is not —
 * and the `basis` says which, so a surprising split can be explained.
 */
export function allocateSellerShippingCharge(
  totalCents: number,
  groups: { key: string; billedWeightKg?: number | null }[]
): { allocations: { key: string; amount: number }[]; basis: "weight" | "equal" } {
  if (groups.length === 0) return { allocations: [], basis: "equal" };
  if (groups.length === 1) {
    return { allocations: [{ key: groups[0].key, amount: totalCents }], basis: "equal" };
  }

  const weights = groups.map((group) =>
    typeof group.billedWeightKg === "number" && group.billedWeightKg > 0
      ? group.billedWeightKg
      : 0
  );
  const weighted = weights.every((weight) => weight > 0);
  const basis: "weight" | "equal" = weighted ? "weight" : "equal";
  const totals = weighted ? weights : groups.map(() => 1);
  const sum = totals.reduce((a, b) => a + b, 0);

  const exact = totals.map((share) => (totalCents * share) / sum);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = totalCents - floors.reduce((a, b) => a + b, 0);

  // Hand the leftover cents to the largest fractional parts first, so the
  // rounding error goes where it is proportionally smallest.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const amounts = [...floors];
  for (const entry of order) {
    if (remainder <= 0) break;
    amounts[entry.index] += 1;
    remainder -= 1;
  }

  return {
    allocations: groups.map((group, index) => ({ key: group.key, amount: amounts[index] })),
    basis,
  };
}

/* -------------------------------------------------------------------------- */
/* Snapshotting                                                               */
/* -------------------------------------------------------------------------- */

export interface OriginSnapshot {
  locationId: string;
  code: string;
  name: string;
  odoo: {
    database: string | null;
    companyId: number | null;
    warehouseId: number | null;
    locationId: number | null;
    partnerId: number | null;
  };
  contact: { name: string | null; phone: string | null; email: string | null };
  address: {
    street1: string | null;
    street2: string | null;
    city: string | null;
    province: string | null;
    postalCode: string | null;
    country: string | null;
  };
  pickup: {
    timeZone: string | null;
    openTime: string | null;
    closeTime: string | null;
    /**
     * The week the dock worked on the day this snapshot was taken, and the
     * notice it asked for, so a pickup proposed months later is judged against
     * the dock's answers AT THE TIME rather than the ones it happens to have
     * now. Additive: snapshots already stored do not carry these keys, and a
     * reader that finds them missing must read that as "not recorded", never as
     * "no restrictions". See `scheduleFromSnapshot`.
     */
    workingDays?: string | null;
    leadTimeDays?: number | null;
    sameDayDeadline?: string | null;
    instructions: string | null;
    accessRequirements: string | null;
  };
  capturedAt: string;
}

/**
 * Freeze a location's facts onto a shipment.
 *
 * The live row stays the source of truth for anything new; this exists so an
 * operator correcting a dock's postal code next month cannot retroactively
 * rewrite where a parcel that already shipped was collected from. Without it
 * the carrier's record, the label and our own history stop agreeing, and the
 * disagreement shows up as an audit finding rather than as a bug report.
 */
export function snapshotOrigin(location: OriginLocation): OriginSnapshot {
  return {
    locationId: location.id,
    code: location.code,
    name: location.name,
    odoo: {
      database: location.odooDatabase,
      companyId: location.odooCompanyId,
      warehouseId: location.odooWarehouseId,
      locationId: location.odooLocationId,
      partnerId: location.odooPartnerId,
    },
    contact: {
      name: location.contactName,
      phone: location.contactPhone,
      email: location.contactEmail,
    },
    address: {
      street1: location.street1,
      street2: location.street2,
      city: location.city,
      province: location.province,
      postalCode: location.postalCode,
      country: location.country,
    },
    pickup: {
      timeZone: location.timeZone,
      openTime: location.pickupOpenTime,
      closeTime: location.pickupCloseTime,
      workingDays: location.workingDays,
      leadTimeDays: location.leadTimeDays,
      sameDayDeadline: location.sameDayDeadline,
      instructions: location.instructions,
      accessRequirements: location.accessRequirements,
    },
    capturedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Stock at the mapped origin                                                 */
/* -------------------------------------------------------------------------- */

export interface OriginStock {
  available: number | null;
  onHand: number;
  reserved: number;
  locationId: number | null;
  ownerId: number | null;
  /** Set when stock could not be read, so absence is never shown as zero. */
  reason: string | null;
}

/**
 * Read on-hand stock for a variant at the location it is actually collected
 * from, for the owner whose stock is sellable there.
 *
 * THE LOCATION IS THE MAPPED ONE, NOT THE CONFIGURED ONE. The import module
 * counts the whole fulfillment warehouse, because a catalogue figure answers
 * "how much do we have anywhere we ship from"; a shipment is a different
 * question, because a product mapped to a second warehouse must be filled from
 * that warehouse. So the mapping decides the location.
 *
 * THE OWNER IS THE LOCATION'S, WHEN IT HAS ONE. `PickupLocation.odooPartnerId`
 * is the owner of the goods at that dock, and it is the only owner consulted:
 * there used to be a global "consignment owner" setting behind it, and a global
 * default that silently applied to every dock is exactly what made adding a
 * vendor a whole-catalogue decision. With no owner on the location, every quant
 * at it is counted — which for a dock holding one vendor's consignment is that
 * vendor's stock, and for the company's own dock is the company's.
 *
 * An unreadable stock figure is null with a reason, never 0. Zero and "we
 * could not ask" look identical in a number field and mean opposite things:
 * one refuses a sale correctly, the other refuses a sale that was possible.
 */
export async function stockAtOrigin(variantId: string): Promise<OriginStock> {
  const origin = await resolveOriginForVariant(variantId);
  if (!origin.location) {
    return {
      available: null,
      onHand: 0,
      reserved: 0,
      locationId: null,
      ownerId: null,
      reason: origin.reason ?? MISSING_ORIGIN_REASON,
    };
  }
  const odooLocationId = origin.location.odooLocationId;
  if (odooLocationId === null) {
    return {
      available: null,
      onHand: 0,
      reserved: 0,
      locationId: null,
      ownerId: null,
      reason: `Pickup location "${origin.location.name}" has no Odoo location id, so stock cannot be read from it.`,
    };
  }

  // The Odoo mapping is the ExternalVariantMapping row the import writes, keyed
  // by provider ODOO. A variant with no such row has never been in Odoo, so it
  // has no quant to read and saying "0 available" would be a claim about a
  // record that does not exist.
  const mapping = await prisma.externalVariantMapping.findFirst({
    where: { variantId, provider: "ODOO" },
    select: { externalVariantId: true },
  });
  const odooProductId = mapping?.externalVariantId ? Number(mapping.externalVariantId) : NaN;
  if (!Number.isInteger(odooProductId)) {
    return {
      available: null,
      onHand: 0,
      reserved: 0,
      locationId: odooLocationId,
      ownerId: null,
      reason: "This item has no Odoo product mapping, so its stock cannot be read.",
    };
  }

  // The location's own owner, or null for "every owner at this dock". There is
  // no global fallback: the dock says whose stock it holds, or the dock holds
  // everybody's.
  const ownerId = origin.location.odooPartnerId;

  try {
    const domain: unknown[] = [
      ["product_id", "=", odooProductId],
      ["location_id", "=", odooLocationId],
    ];
    if (ownerId !== null) domain.push(["owner_id", "=", ownerId]);
    const quants = await searchRead<OdooRecord>("stock.quant", domain, [
      "id",
      "quantity",
      "reserved_quantity",
    ]);
    const onHand = quants.reduce((sum, quant) => sum + Number(quant.quantity ?? 0), 0);
    const reserved = quants.reduce((sum, quant) => sum + Number(quant.reserved_quantity ?? 0), 0);
    return {
      available: onHand - reserved,
      onHand,
      reserved,
      locationId: odooLocationId,
      ownerId,
      reason: null,
    };
  } catch (error) {
    return {
      available: null,
      onHand: 0,
      reserved: 0,
      locationId: odooLocationId,
      ownerId,
      reason: `Stock could not be read from Odoo: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
}
