/**
 * The Odoo catalogue sync: one read of Odoo, applied to MoonVella, on a clock.
 *
 * WHAT THIS ADDS TO THE IMPORT. `odooImport.server.ts` already reads the tagged
 * templates and writes them as drafts, idempotently, through the durable
 * mapping rows. Three things a scheduled sync needs are not part of "import the
 * catalogue", and they live here rather than being folded into the import so
 * that each has one place to be wrong:
 *
 *   1. THE DEFAULT PICKUP LOCATION. The owner named one Odoo warehouse — the
 *      Premafirm Inc. warehouse — as where MoonVella's stock leaves from. Its
 *      partner address is READ, never typed here, and becomes the one pickup
 *      location every shipment falls back to.
 *   2. WITHDRAWAL. A template that loses the MoonVella tag, or is archived in
 *      Odoo, must stop being available without its MoonVella product, its
 *      variants or its history disappearing. Nothing is deleted; the product is
 *      archived with the reason recorded.
 *   3. THE REPORT. Last run, next run, counts and the per-product reasons
 *      something was left out — the things that turn "it synced" into a fact an
 *      operator can check.
 *
 * NOTHING HERE WRITES TO ODOO. Every call is a search_read. The connection is
 * read-only by configuration as well — see `odooWriteBlockReason` — and this
 * module never asks for more.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { getCredential } from "./credentials.server";
import { JOB_KIND, enqueueJob } from "./jobs.server";
import { resolveOdooConfig, searchRead, type OdooRecord } from "./odoo.server";
import {
  WHOLESALE_CURRENCY,
  importOdooProducts,
  resolveReference,
  type ImportBlocker,
} from "./odooImport.server";
import { validateAddress, recordValidation, type StructuredAddress } from "./addressValidation.server";

export const WAREHOUSE_FIELD = "ODOO_WAREHOUSE";

const WAREHOUSE_MODEL = "stock.warehouse";
const PARTNER_MODEL = "res.partner";
const COUNTRY_MODEL = "res.country";
const STATE_MODEL = "res.country.state";

/** A value Odoo sends as `false` when the field is empty, narrowed to text. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Odoo many2one values arrive as `[id, name]` or `false`. */
function toId(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === "number") return value[0];
  if (typeof value === "number") return value;
  return null;
}

export interface DefaultPickupOutcome {
  locationId: string | null;
  /** What was read and where from, for the report. Null when nothing was read. */
  note: string | null;
  /** Set when the warehouse could not be resolved or read. Never fatal to a sync. */
  blocker: ImportBlocker | null;
  /** The address as Odoo holds it, so a caller can show what was read. */
  address: StructuredAddress | null;
  /** The Google verdict for the address, when one was reached. */
  verdict: string | null;
}

/**
 * Read the configured warehouse's own address out of Odoo and make it the
 * default pickup location.
 *
 * READ, NOT HARDCODED. The street, the unit, the city, the province, the postal
 * code and the country all come from the partner record behind the warehouse,
 * so a correction made in Odoo reaches MoonVella without anyone editing it
 * twice. The unit stays in its own column: a unit folded into the street line is
 * a different door to a carrier's routing, which is why `street2` is separate
 * here and separate on the row.
 *
 * WHAT A RE-SYNC REFRESHES, AND WHAT IT LEAVES ALONE. The address and the Odoo
 * identity are Odoo's to state and are rewritten every run, including to empty:
 * a street Odoo no longer holds is a street this row should no longer claim. The
 * contact details are rewritten only where Odoo states them, so an operator's
 * correction survives a sync that has nothing to say about it. The dock's
 * operating detail — collection window, appointment requirements, dock
 * instructions, pickup mode — is MoonVella's, is set by an operator, and is not
 * in either object, so a sync cannot blank work somebody did here. The same
 * discipline the product import uses, for the same reason.
 *
 * AND IT MUST COME BACK COMPLETE. A row the booking gate reports as "missing
 * contact phone" is a row nothing ships from, so the sync reads the fields the
 * gate demands — the warehouse's stock location, and the partner's own phone and
 * email — rather than leaving them for someone to notice. What Odoo does not
 * hold stays missing, and the gate says so in those words.
 *
 * IT IS FOUND BY ITS ODOO IDENTITY, not by its code or its name: both of those
 * are editable on the admin form, and a row somebody renamed is still the same
 * dock. Matching on a human-typed label would quietly create a second row with
 * the same address the first time anyone tidied it up. Two rows claiming one
 * warehouse is refused outright — "the default" would be a coin toss, and the
 * loser of that toss is a parcel collected from the wrong door.
 */
export async function syncDefaultPickupLocation(): Promise<DefaultPickupOutcome> {
  const value = await getCredential("odoo", WAREHOUSE_FIELD);

  const warehouse = await resolveReference(
    WAREHOUSE_MODEL,
    value ?? "",
    [{ field: "name", label: "name" }],
    ["id", "name", "partner_id", "company_id", "lot_stock_id"],
    "Warehouse",
  );
  if ("code" in warehouse) {
    return { locationId: null, note: null, blocker: warehouse, address: null, verdict: null };
  }

  const [row] = await searchRead<OdooRecord>(
    WAREHOUSE_MODEL,
    [["id", "=", warehouse.id]],
    ["id", "name", "partner_id", "company_id", "lot_stock_id"],
    { limit: 1 },
  );
  const partnerId = toId(row?.partner_id);
  const companyId = toId(row?.company_id);
  /*
   * The warehouse's own stock location — `lot_stock_id`, the WH/Stock the
   * quantities are held under. A pickup location has to carry an Odoo location
   * id to be bookable, and this is the only one that belongs to this row: the
   * warehouse is where the parcel is collected, and its stock location is where
   * the stock it comes from sits.
   */
  const locationId = toId(row?.lot_stock_id);

  if (partnerId === null) {
    return {
      locationId: null,
      note: null,
      address: null,
      verdict: null,
      blocker: {
        code: "WAREHOUSE_WITHOUT_ADDRESS",
        message:
          `The Odoo warehouse "${warehouse.name}" has no address record (res.partner) behind it, ` +
          `so there is no address to collect from.`,
        remedy:
          "Give the warehouse an address in Odoo (Warehouse settings), or point the Odoo " +
          "integration's Warehouse field at one that has an address.",
      },
    };
  }

  const [partner] = await searchRead<OdooRecord>(
    PARTNER_MODEL,
    [["id", "=", partnerId]],
    ["id", "name", "street", "street2", "city", "zip", "country_id", "state_id", "phone", "email"],
    { limit: 1 },
  );

  const countryId = toId(partner?.country_id);
  const stateId = toId(partner?.state_id);
  const [[country], [state]] = await Promise.all([
    countryId === null
      ? Promise.resolve([])
      : searchRead<OdooRecord>(COUNTRY_MODEL, [["id", "=", countryId]], ["id", "code"], { limit: 1 }),
    stateId === null
      ? Promise.resolve([])
      : searchRead<OdooRecord>(STATE_MODEL, [["id", "=", stateId]], ["id", "code"], { limit: 1 }),
  ]);

  /*
   * Odoo sends `false` for an empty field and `undefined` when the field was not
   * in the read; both mean the same thing here. They become empty strings rather
   * than nulls because that is the shape the address validator and the hash
   * work in — a null would make an absent unit and an absent city hash the same,
   * and the missing-component report would lose the difference.
   */
  const address: StructuredAddress = {
    street1: text(partner?.street) ?? "",
    // The unit, kept as the unit. Present or not, it is never folded in.
    street2: text(partner?.street2),
    city: text(partner?.city) ?? "",
    province: text(state?.code) ?? text(state?.name) ?? "",
    postalCode: text(partner?.zip) ?? "",
    country: (text(country?.code) ?? "").toUpperCase(),
  };

  const config = await resolveOdooConfig();
  const database = config?.database ?? null;
  if (!database) {
    return {
      locationId: null,
      note: null,
      address: null,
      verdict: null,
      blocker: {
        code: "ODOO_DATABASE_UNKNOWN",
        message:
          "The Odoo database name could not be read, so the default pickup location cannot be " +
          "attributed to a warehouse.",
        remedy: "Set ODOO_DATABASE on the Odoo integration, then sync again.",
      },
    };
  }

  const identity = { odooDatabase: database, odooWarehouseId: warehouse.id };
  const found = await prisma.pickupLocation.findMany({
    where: identity,
    select: { id: true, code: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  if (found.length > 1) {
    return {
      locationId: null,
      note: null,
      address: null,
      verdict: null,
      blocker: {
        code: "DEFAULT_WAREHOUSE_AMBIGUOUS",
        message:
          `${found.length} pickup locations already claim Odoo warehouse ${warehouse.id} ` +
          `(${found.map((item) => `${item.name} [${item.code}]`).join(", ")}), so MoonVella ` +
          `cannot tell which one is the default.`,
        remedy:
          "Delete or re-point the duplicate locations on the Pickup locations page, then sync again.",
      },
    };
  }

  /*
   * What the row stores. An empty component is stored as null rather than as an
   * empty string: the column means "Odoo holds nothing here", and the
   * completeness check reports a null as a missing field rather than accepting a
   * blank one.
   */
  const addressFields = {
    street1: address.street1 || null,
    street2: address.street2 || null,
    city: address.city || null,
    province: address.province || null,
    postalCode: address.postalCode || null,
    country: address.country || null,
  };

  /*
   * The dock's contact details, which Odoo usually knows and the booking gate
   * requires. Written only when Odoo states them: `undefined` leaves the column
   * alone, so an operator's correction survives a sync that has nothing to say
   * about it, and Odoo's own correction replaces a stale one. The address above
   * is different and is always rewritten — that column is Odoo's to state.
   */
  const contactFields = {
    contactName: text(partner?.name) ?? undefined,
    contactPhone: text(partner?.phone) ?? undefined,
    contactEmail: text(partner?.email) ?? undefined,
  };

  const saved = await prisma.$transaction(async (tx) => {
    // Exactly one default. Cleared first so the flag cannot end up on two rows
    // if the warehouse is ever re-pointed at a different location.
    await tx.pickupLocation.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });

    if (found.length === 1) {
      return tx.pickupLocation.update({
        where: { id: found[0].id },
        data: {
          ...addressFields,
          ...identity,
          ...contactFields,
          odooCompanyId: companyId,
          odooLocationId: locationId,
          odooPartnerId: partnerId,
          isDefault: true,
        },
      });
    }

    return tx.pickupLocation.create({
      data: {
        // A code, because the column is unique and every location needs one to
        // be referenced. It is derived from the warehouse so it is stable across
        // re-creations rather than random.
        code: `ODOO-WH-${warehouse.id}`,
        name: warehouse.name,
        ...addressFields,
        ...identity,
        ...contactFields,
        odooCompanyId: companyId,
        odooLocationId: locationId,
        odooPartnerId: partnerId,
        isDefault: true,
        isActive: true,
      },
    });
  });

  /*
   * The address is checked against Google, and the verdict is stored as
   * evidence on the row. A missing Google key is not a failure of this sync: the
   * row is created and left UNVALIDATED, which is exactly what the booking gate
   * reads as "not checked yet" — the gate stays shut and says why.
   */
  const outcome = await validateAddress(address, {
    refresh: false,
    onFresh: async (fresh) => {
      await recordValidation({ subjectType: "PICKUP", subjectId: saved.id, outcome: fresh });
    },
  });

  await recordAudit({
    actorType: "SYSTEM",
    actorId: "odoo-sync",
    actorName: "Odoo catalog sync",
    action: "origin.synced_from_odoo",
    entityType: AUDIT_ENTITY.PICKUP_LOCATION,
    entityId: saved.id,
    afterData: {
      odooDatabase: database,
      odooWarehouseId: warehouse.id,
      odooPartnerId: partnerId,
      address: addressFields,
      isDefault: true,
      created: found.length === 0,
      addressVerdict: outcome.verdict,
    },
  });

  return {
    locationId: saved.id,
    note:
      `Default pickup location read from Odoo warehouse "${warehouse.name}" ` +
      `(id ${warehouse.id}): ${[
        address.street1,
        address.street2,
        address.city,
        address.province,
        address.postalCode,
        address.country,
      ]
        .filter(Boolean)
        .join(", ")}.`,
    blocker: null,
    address,
    verdict: outcome.verdict,
  };
}

export interface CatalogSyncResult {
  /** One line, shown to the owner. */
  summary: string;
  /** Everything an operator might need, stored as the job's result. */
  detail: Record<string, unknown>;
}

/**
 * One full sync: the pickup location, the catalogue, then withdrawal.
 *
 * THE ORDER MATTERS ONCE. The pickup location is resolved first so that the
 * catalogue write can record which dock its products leave from; the withdrawal
 * pass runs last, so a template that failed to read this run is still tagged and
 * is therefore not treated as withdrawn. Nothing is inferred from a failed read:
 * the catalogue import refuses to write at all when the read itself did not
 * succeed.
 */
export async function syncOdooCatalog(): Promise<CatalogSyncResult> {
  const pickup = await syncDefaultPickupLocation();

  const outcome = await importOdooProducts({ confirm: true });
  if (!outcome.executed) {
    throw new Error("The Odoo sync returned a preview instead of a result; nothing was written.");
  }
  const { result, preview } = outcome;

  const withdrawn = await withdrawUntaggedProducts(preview.connection.database ?? "", result);

  const notes: string[] = [];
  if (pickup.blocker) {
    notes.push(`Default pickup location: ${pickup.blocker.message} ${pickup.blocker.remedy}`);
  } else if (pickup.note) {
    notes.push(pickup.note);
  }
  if (pickup.verdict && pickup.verdict !== "ACCEPTED") {
    notes.push(
      `The default pickup address is recorded as ${pickup.verdict}; a booking from it stays ` +
        `gated until it is accepted or an owner overrides it.`,
    );
  }

  /*
   * Whose stock this run counted. Not a filter — the sync never filters by owner
   * — but the record of what was in scope, so a catalogue figure can be read
   * back as "25 on hand, made of these owners' goods" rather than as a number
   * that appeared. Company-owned stock is named as such: Odoo reports it as no
   * owner at all, and "no owner" printed as an empty string would look like a
   * missing value rather than the company's own goods.
   */
  const stockOwners = [
    ...new Set(
      result.templates.flatMap((template) =>
        template.variants.flatMap((variant) =>
          variant.stock.map((record) => record.ownerName ?? "Company-owned"),
        ),
      ),
    ),
  ].sort();

  const summary =
    `${result.created} created, ${result.updated} updated, ${result.variantsWritten} variant(s); ` +
    `${result.blocked.length} product(s) skipped, ${withdrawn.archived} withdrawn` +
    (result.restored > 0 ? `, ${result.restored} restored` : "") +
    `. Prices are each variant's effective sales price in ${WHOLESALE_CURRENCY}.`;

  return {
    summary,
    detail: {
      database: preview.connection.database,
      created: result.created,
      updated: result.updated,
      variants: result.variantsWritten,
      archived: withdrawn.archived,
      restored: result.restored,
      blocked: result.blocked,
      templates: result.templates.map((template) => ({
        odooTemplateId: template.odooTemplateId,
        productCode: template.productCode,
        outcome: template.outcome,
      })),
      withdrawn: withdrawn.products,
      priceSource: "ODOO_EFFECTIVE_SALES_PRICE",
      priceCurrency: WHOLESALE_CURRENCY,
      // The scope the stock figures were counted in, and whose goods they were.
      warehouse: preview.warehouse
        ? {
            id: preview.warehouse.id,
            name: preview.warehouse.name,
            rootLocationId: preview.warehouse.rootLocationId,
            rootLocationName: preview.warehouse.rootLocationName,
          }
        : null,
      stockOwners,
      defaultPickupLocationId: pickup.locationId,
      notes,
    },
  };
}

/**
 * Archive the MoonVella products whose Odoo template is no longer eligible.
 *
 * "NO LONGER ELIGIBLE" IS EXACTLY TWO THINGS: the tag was removed in Odoo, or
 * the template was archived there. Both mean the same thing to a seller — this
 * is not something MoonVella sells any more — and both are read the same way,
 * because an archived template simply does not appear in a search for tagged
 * templates.
 *
 * WHAT HAPPENS TO THE RECORD, AND WHY. It is archived, not deleted: orders
 * already placed reference these variants, and a catalogue sync that removed
 * the rows would leave historical orders pointing at products that no longer
 * exist. Inventory is left at its last synced figure and is never rewritten to
 * zero here — a withdrawal is not a stock count. Nothing new can be imported
 * from it, and it stops being offered, because an archived product is excluded
 * from the seller catalogue by the same rule that excludes every other archived
 * product.
 *
 * IT COMES BACK. If the tag is restored in Odoo, the next sync finds the same
 * mapping row — which is marked WITHDRAWN, so the sync can tell the product it
 * hid from a product an operator hid — and writes it again as a DRAFT, never as
 * published: publication is a decision someone makes with the current state in
 * front of them.
 *
 * EXPORTED FOR THE SUITE, and deliberately: it takes plain data — a database
 * name and the templates Odoo returned — and its whole effect is on rows the
 * suite can create and clean up. A rule about what disappears from a catalogue
 * when a tag is removed is exactly the kind of thing that should be watched
 * running rather than read about.
 */
export async function withdrawUntaggedProducts(
  database: string,
  result: { templates: { odooTemplateId: number }[] },
): Promise<{
  archived: number;
  products: { productId: string; name: string; reason: string }[];
}> {
  if (!database) return { archived: 0, products: [] };

  /*
   * The templates Odoo returned this run, tagged ones included. Anything mapped
   * that is ABSENT from this set has either lost the tag or been archived at the
   * source — a search for tagged templates returns neither.
   *
   * `result.templates` carries every template the preview built, INCLUDING the
   * ones skipped for a problem: a product with no SKU is still tagged, and
   * withdrawing it would be the sync punishing a product for its own refusal to
   * import it.
   */
  const taggedTemplateIds = new Set(result.templates.map((template) => template.odooTemplateId));

  const mapped = await prisma.externalProductMapping.findMany({
    where: { provider: "ODOO", shopDomain: database },
    select: {
      id: true,
      externalProductId: true,
      productId: true,
      product: { select: { id: true, name: true, isArchived: true } },
    },
  });

  const withdrawn: { productId: string; name: string; reason: string }[] = [];
  let archived = 0;

  for (const row of mapped) {
    const productId = row.productId;
    const templateId = Number(row.externalProductId);
    if (Number.isFinite(templateId) && taggedTemplateIds.has(templateId)) continue;
    if (row.product.isArchived) continue;

    /*
     * The same four columns `setArchived` writes, and deliberately not that
     * function: it takes an operator and asserts `products.manage` against them,
     * and a sync has no operator. Granting one to a background job so it could
     * pass its own permission check would make the check meaningless.
     */
    await prisma.product.update({
      where: { id: productId },
      data: { isArchived: true, isActive: false, isPublished: false, status: "ARCHIVED" },
    });
    await prisma.externalProductMapping.update({
      where: { id: row.id },
      data: {
        importStatus: "WITHDRAWN",
        lastSyncedAt: new Date(),
        lastSyncError: "No longer carries the MoonVella App tag in Odoo, or is archived there.",
      },
    });
    archived += 1;
    withdrawn.push({
      productId,
      name: row.product.name,
      reason: "No longer tagged in Odoo (or archived there)",
    });
  }

  if (archived > 0) {
    await recordAudit({
      actorType: "SYSTEM",
      actorId: "odoo-sync",
      actorName: "Odoo catalog sync",
      action: "odoo.products_withdrawn",
      entityType: AUDIT_ENTITY.PRODUCT,
      entityId: withdrawn.map((item) => item.productId).join(","),
      afterData: {
        database,
        archived,
        reason:
          "The template no longer carries the MoonVella App tag in Odoo, or has been archived " +
          "there. The product is archived here rather than deleted: historical orders reference " +
          "it, and its inventory is left at the last figure read from Odoo.",
        products: withdrawn,
      },
    });
  }

  return { archived, products: withdrawn };
}

/**
 * "Sync now": run the same sync the clock runs, in the operator's request.
 *
 * THE SAME WORK, AND A ROW IN THE SAME TABLE. A manual run is recorded as an
 * `ODOO_CATALOG_SYNC` job so that "when did this last run, and what did it say"
 * has ONE answer. A separate counter for manual runs would be a second answer
 * that can disagree with the first, and the disagreement would surface as a
 * report that looks current while the catalogue is a week old.
 *
 * It runs inline rather than being queued because the operator is standing
 * there: a queued job would sit until the next cron tick and the page would say
 * "queued" to somebody who asked for it now. The idempotency key carries the
 * instant, so two runs are two rows rather than one that silently stands for
 * both — and a run already in flight is refused instead of doubled.
 */
export async function runCatalogSyncNow(): Promise<
  { ok: true; outcome: CatalogSyncResult } | { ok: false; error: string }
> {
  if (await catalogSyncRunning()) {
    return {
      ok: false,
      error:
        "A catalogue sync is already queued or running. Nothing was started; wait for it to " +
        "finish, then sync again.",
    };
  }

  const job = await enqueueJob({
    kind: JOB_KIND.ODOO_CATALOG_SYNC,
    idempotencyKey: `odoo:catalog-sync:manual:${new Date().toISOString()}`,
    maxAttempts: 1,
    payload: { trigger: "MANUAL" },
  });

  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", startedAt: new Date(), attempts: 1 },
  });

  try {
    const outcome = await syncOdooCatalog();
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        lastError: null,
        result: outcome as never,
      },
    });
    return { ok: true, outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), lastError: message },
    });
    return { ok: false, error: message };
  }
}

/**
 * The last run of the catalogue sync, however it was started, and when the next
 * scheduled one is due.
 *
 * Read from the job table rather than a counter of this module's own: a manual
 * "Sync now" and a scheduled tick are the same kind of job, so there is one
 * answer to "when did this last run" rather than two that can disagree.
 */
export interface CatalogSyncStatus {
  lastRun: {
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    summary: string | null;
    error: string | null;
    detail: Record<string, unknown> | null;
  } | null;
  /** True while a run is queued or in flight, so the page can say so. */
  running: boolean;
  nextRunAt: Date | null;
}

export async function catalogSyncStatus(recurring: { everyMs: number }): Promise<CatalogSyncStatus> {
  const [job, open] = await Promise.all([
    prisma.backgroundJob.findFirst({
      // Not PENDING: a queued run has not happened yet, and showing it as the
      // last run would date the report to a moment nothing was read.
      where: { kind: "ODOO_CATALOG_SYNC", status: { not: "PENDING" } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.backgroundJob.findFirst({
      where: { kind: "ODOO_CATALOG_SYNC", status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true },
    }),
  ]);

  const bucket = Math.floor(Date.now() / recurring.everyMs);

  return {
    lastRun: job
      ? {
          status: job.status,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          summary: (job.result as { summary?: string } | null)?.summary ?? null,
          error: job.lastError,
          detail: (job.result as { detail?: Record<string, unknown> } | null)?.detail ?? null,
        }
      : null,
    running: open !== null,
    // The bucket nobody has queued yet: the next tick creates it.
    nextRunAt: new Date((bucket + 1) * recurring.everyMs),
  };
}

/**
 * Whether a sync is running right now, so a manual run can refuse rather than
 * start a second read of the whole catalogue on top of the first.
 */
export async function catalogSyncRunning(): Promise<boolean> {
  const row = await prisma.backgroundJob.findFirst({
    where: { kind: "ODOO_CATALOG_SYNC", status: { in: ["PENDING", "RUNNING"] } },
    select: { id: true },
  });
  return Boolean(row);
}
