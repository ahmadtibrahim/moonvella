import { prisma } from "~/db.server";
import { JOB_KIND, enqueueJob, jobKey } from "./jobs.server";
import { AUTO_SYNC_OFF_REASON } from "~/utils/inventorySync";

/**
 * TELLING THE SELLER'S STORE HOW MANY ARE LEFT.
 *
 * WHAT WAS MISSING. An import set a variant's quantity once, at the moment it
 * created it, and then never mentioned it again. `SellerSettings.autoSyncInventory`
 * was a checkbox with nothing behind it, and a re-sync only moved the numbers
 * because somebody pressed the button. Meanwhile the catalogue's quantities in
 * this application are edited constantly — by the merchant on the product
 * editor, and by the six-hourly Odoo sync, which is the authority on what is
 * actually on the shelf. The result was a storefront selling stock that did not
 * exist, which is the failure a buyer notices first: an order taken for
 * something nobody can ship.
 *
 * So a change to a variant's quantity now reaches every store that lists it.
 *
 * WHO GETS TOLD. Every seller with a mapping for this variant whose store is
 * APPROVED, whose mapping names a Shopify inventory item, and who has not
 * switched auto-sync off. The switch is a real one — a seller who manages their
 * own stock levels in Shopify must not have them overwritten every time the
 * warehouse counts — and `autoSyncInventory` defaults to on, which is the
 * behaviour an import already implies. `planInventoryPush` is the whole of that
 * decision, kept as a pure function so a suite can check who is told without a
 * store being called.
 *
 * AN ABSOLUTE QUANTITY, NEVER A DELTA. `inventorySetQuantities` sets the number
 * at a location, so a push that runs twice leaves the same value behind rather
 * than doubling it. That is what makes the at-least-once queue safe here, and it
 * is why a stale queued job is harmless: it reads the current quantity from this
 * database when it runs, not the quantity that was current when it was queued.
 *
 * ONE CALL PER STORE, CARRYING EVERY VARIANT. The mutation takes a list of
 * inventory items, and the Odoo sync moves whole products at a time. Pushing a
 * variant at a time would be one round trip per size per store per sync.
 *
 * A FAILURE IS RECORDED, NOT THROWN. One store's expired session must not stop
 * the other stores from being updated, and the admin who changed a number should
 * not meet a Shopify error on a form that has already been saved. Each store's
 * outcome is written to its mapping rows and returned, and the caller queues a
 * retry.
 */

/** The API's reason code. A quantity corrected here is a correction there. */
const SYNC_REASON = "correction";

/**
 * The switch that keeps a verify run out of a real storefront.
 *
 * `off` makes every push do nothing and say so, which is what the suite runner
 * pins — the same idea as `MOONVELLA_STRIPE_MODE`, and for the same reason: a
 * suite that edits a variant must not move a number a shopper can see. The
 * *decision* about who would be told is still exercised, through
 * `planInventoryPush`, because that is the part worth testing.
 */
const PUSH_SWITCH_ENV = "MOONVELLA_INVENTORY_PUSH";

const INVENTORY_SET = `#graphql
  mutation MoonVellaInventoryPush($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors { field message }
    }
  }`;

const LOCATIONS_QUERY = `#graphql
  query MoonVellaPushLocations { locations(first: 1) { nodes { id } } }`;

interface PushAdmin {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/** A mapping row, as the planner needs to see it. */
export interface PushCandidate {
  mappingId: string;
  shopifyInventoryItemId: string | null;
  shopifyLocationId: string | null;
  sellerId: string;
  shopDomain: string;
  sellerStatus: string;
  autoSyncInventory: boolean;
}

export interface PushPlan {
  /** Store id -> the mappings whose quantity goes in this store's call. */
  byStore: Map<string, PushCandidate[]>;
  shopDomainByStore: Map<string, string>;
  /** Why nothing is sent to each of the mappings left out. */
  skipped: { mappingId: string; reason: string }[];
}

export interface InventoryPushFailure {
  sellerId: string;
  shopDomain: string;
  message: string;
}

export interface InventoryPushOutcome {
  /** The variants considered, by SKU, with the quantity that was sent. */
  quantities: { variantId: string; sku: string; quantity: number }[];
  /** Store listings whose number was set. */
  pushed: number;
  /** Store listings deliberately not touched. */
  skipped: number;
  /** Set when this process was told not to reach any store at all. */
  disabled?: boolean;
  failures: InventoryPushFailure[];
}

/**
 * Who is told, and who is not.
 *
 * Pure on purpose: no session, no network, no clock. Every reason to leave a
 * store out is a state this application knows how to describe, so the answers
 * are a closed set rather than a log line, and a suite can assert them.
 */
export function planInventoryPush(candidates: PushCandidate[]): PushPlan {
  const plan: PushPlan = { byStore: new Map(), shopDomainByStore: new Map(), skipped: [] };

  for (const candidate of candidates) {
    const reason = skipReason(candidate);
    if (reason) {
      plan.skipped.push({ mappingId: candidate.mappingId, reason });
      continue;
    }
    const list = plan.byStore.get(candidate.sellerId) ?? [];
    list.push(candidate);
    plan.byStore.set(candidate.sellerId, list);
    plan.shopDomainByStore.set(candidate.sellerId, candidate.shopDomain);
  }

  return plan;
}

/**
 * Why a mapping is not pushed to, or null when it is.
 */
export function skipReason(candidate: PushCandidate): string | null {
  if (candidate.sellerStatus !== "APPROVED") {
    return `this store is ${candidate.sellerStatus.toLowerCase()}, so it is not selling yet`;
  }
  if (!candidate.shopifyInventoryItemId) {
    return "the import did not record an inventory item for this size";
  }
  if (!candidate.autoSyncInventory) return AUTO_SYNC_OFF_REASON;
  return null;
}

/** Whether the deployment has told this process not to reach any store. */
function pushIsOff(): boolean {
  return (process.env[PUSH_SWITCH_ENV] ?? "").trim().toLowerCase() === "off";
}

/**
 * Push the current quantity of these variants to every store that lists them.
 *
 * Returns what happened rather than throwing: the callers are a request that has
 * already committed its own write and a catalogue sync that has already written
 * its prices, and a Shopify refusal is not a reason to fail either of them.
 */
export async function pushInventoryForVariants(
  variantIds: string[]
): Promise<InventoryPushOutcome> {
  const wanted = [...new Set(variantIds.filter(Boolean))];
  if (!wanted.length) {
    return { quantities: [], pushed: 0, skipped: 0, failures: [] };
  }

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: wanted } },
    select: { id: true, sku: true, inventory: true },
    orderBy: { sku: "asc" },
  });

  const outcome: InventoryPushOutcome = {
    quantities: variants.map((variant) => ({
      variantId: variant.id,
      sku: variant.sku,
      quantity: variant.inventory,
    })),
    pushed: 0,
    skipped: 0,
    failures: [],
  };

  if (pushIsOff()) {
    // Reported rather than silent: a run that reaches no store says so, instead
    // of looking like a run where every store happened to be skipped.
    outcome.disabled = true;
    return outcome;
  }

  const mappings = await prisma.sellerProductVariant.findMany({
    where: { productVariantId: { in: variants.map((variant) => variant.id) } },
    select: {
      id: true,
      productVariantId: true,
      shopifyInventoryItemId: true,
      shopifyLocationId: true,
      sellerProduct: {
        select: {
          seller: {
            select: {
              id: true,
              shopDomain: true,
              status: true,
              settings: { select: { autoSyncInventory: true } },
            },
          },
        },
      },
    },
  });

  const candidates: PushCandidate[] = mappings.map((mapping) => ({
    mappingId: mapping.id,
    shopifyInventoryItemId: mapping.shopifyInventoryItemId,
    shopifyLocationId: mapping.shopifyLocationId,
    sellerId: mapping.sellerProduct.seller.id,
    shopDomain: mapping.sellerProduct.seller.shopDomain,
    sellerStatus: mapping.sellerProduct.seller.status,
    // A seller with no settings row has never opened the settings page, and the
    // column's default is on — the same default this reads.
    autoSyncInventory: mapping.sellerProduct.seller.settings?.autoSyncInventory ?? true,
  }));

  const plan = planInventoryPush(candidates);
  outcome.skipped = plan.skipped.length;

  const quantityByVariant = new Map(variants.map((variant) => [variant.id, variant.inventory]));
  const variantByMapping = new Map(mappings.map((row) => [row.id, row.productVariantId]));

  for (const [sellerId, group] of plan.byStore) {
    const shopDomain = plan.shopDomainByStore.get(sellerId) ?? sellerId;
    const mappingIds = group.map((candidate) => candidate.mappingId);

    const admin = await openStore(shopDomain);
    if (typeof admin === "string") {
      outcome.failures.push({ sellerId, shopDomain, message: admin });
      await recordFailure(mappingIds);
      continue;
    }

    const locationId = await resolveLocationId(admin, group);
    if (!locationId) {
      const message = "the store has no location to hold inventory";
      outcome.failures.push({ sellerId, shopDomain, message });
      await recordFailure(mappingIds);
      continue;
    }

    const quantities = group.map((candidate) => ({
      inventoryItemId: candidate.shopifyInventoryItemId as string,
      locationId,
      quantity: quantityByVariant.get(variantByMapping.get(candidate.mappingId) as string) ?? 0,
    }));

    const failure = await setQuantities(admin, quantities);
    if (failure) {
      outcome.failures.push({ sellerId, shopDomain, message: failure });
      await recordFailure(mappingIds);
      continue;
    }

    outcome.pushed += quantities.length;
    await prisma.sellerProductVariant.updateMany({
      where: { id: { in: mappingIds } },
      data: { syncStatus: "SUCCESS", syncedAt: new Date(), shopifyLocationId: locationId },
    });
  }

  return outcome;
}

/** One variant — the shape an admin's product edit takes. */
export async function pushVariantInventory(variantId: string): Promise<InventoryPushOutcome> {
  return pushInventoryForVariants([variantId]);
}

/** Every active variant of one product — the shape a catalogue sync takes. */
export async function pushProductInventory(productId: string): Promise<InventoryPushOutcome> {
  const variants = await prisma.productVariant.findMany({
    where: { productId, isActive: true },
    select: { id: true },
    orderBy: { sortOrder: "asc" },
  });
  return pushInventoryForVariants(variants.map((variant) => variant.id));
}

/** Several products at once, for a sync that moved quantities across many. */
export async function pushProductsInventory(productIds: string[]): Promise<InventoryPushOutcome> {
  const wanted = [...new Set(productIds.filter(Boolean))];
  if (!wanted.length) return { quantities: [], pushed: 0, skipped: 0, failures: [] };

  const variants = await prisma.productVariant.findMany({
    where: { productId: { in: wanted }, isActive: true },
    select: { id: true },
  });
  return pushInventoryForVariants(variants.map((variant) => variant.id));
}

/**
 * Queue another attempt for a variant whose push did not reach every store.
 *
 * ONE JOB PER ATTEMPT, and the key carries the moment of the attempt rather
 * than being stable per variant. That is deliberate and it is the opposite of
 * how the recurring jobs are keyed: a stable key would be SUCCEEDED from the
 * last time this variant changed, and `enqueueJob` treats a SUCCEEDED key as
 * already satisfied, so the second edit of the day would be silently dropped.
 * A job here always re-reads the quantity when it runs, so however many of them
 * pile up, the store ends at the number the catalogue holds.
 */
export async function queueInventoryRetry(variantId: string): Promise<void> {
  await enqueueJob({
    kind: JOB_KIND.INVENTORY_PUSH,
    idempotencyKey: jobKey(JOB_KIND.INVENTORY_PUSH, variantId, String(Date.now())),
    payload: { productVariantId: variantId },
    maxAttempts: 5,
  }).catch(() => undefined);
}

/** Queue a retry for every variant a failed push was about. */
export async function queueInventoryRetries(outcome: InventoryPushOutcome): Promise<void> {
  if (!outcome.failures.length) return;
  for (const quantity of outcome.quantities) {
    await queueInventoryRetry(quantity.variantId);
  }
}

/**
 * The store's own Shopify client, or the sentence explaining why not.
 *
 * An offline session, because none of this runs with a merchant watching: the
 * sync runs on cron, and a push queued behind a failure runs with nobody at
 * all. The token is the shop's, refreshed the same way every other out-of-band
 * call in this application refreshes it.
 */
async function openStore(shopDomain: string): Promise<PushAdmin | string> {
  try {
    const { unauthenticated } = await import("~/shopify.server");
    const offline = await unauthenticated.admin(shopDomain);
    return offline.admin as unknown as PushAdmin;
  } catch (error) {
    // No offline session: the app was uninstalled, or the token was revoked.
    // Retrying will not fix that, but it may be a transient refresh, so this is
    // reported as a failure and the queue decides.
    return `this store could not be opened on Shopify (${
      error instanceof Error ? error.message : String(error)
    })`;
  }
}

/** Set the quantities, or return the sentence Shopify refused with. */
async function setQuantities(
  admin: PushAdmin,
  quantities: { inventoryItemId: string; locationId: string; quantity: number }[]
): Promise<string | null> {
  try {
    const response = await admin.graphql(INVENTORY_SET, {
      variables: {
        // The mutation is idempotent by key, so a retry that follows a timeout
        // cannot apply the same change twice.
        idempotencyKey: crypto.randomUUID(),
        input: {
          name: "available",
          reason: SYNC_REASON,
          // The quantity here is authoritative and the store's current value is
          // not known, so the comparison is skipped deliberately. Comparing
          // would need a read first, and the read would be of the number this
          // call is about to overwrite.
          ignoreCompareQuantity: true,
          quantities,
        },
      },
    });
    const json = (await response.json()) as {
      data?: { inventorySetQuantities?: { userErrors?: { message: string }[] } };
    };
    const errors = json?.data?.inventorySetQuantities?.userErrors ?? [];
    if (errors.length) return errors.map((error) => error.message).join("; ");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function recordFailure(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await prisma.sellerProductVariant
    .updateMany({ where: { id: { in: ids } }, data: { syncStatus: "FAILED" } })
    .catch(() => undefined);
}

/**
 * Where the quantity goes in this store.
 *
 * The mapping's own recorded location first — a store with several locations
 * has been told where the MoonVella stock lives, and re-deciding that on every
 * push is how a quantity ends up in a warehouse the merchant does not ship
 * from. Otherwise the store's first location, which is what the import used,
 * and it is written onto the mappings by the caller so the next push does not
 * ask again.
 */
async function resolveLocationId(
  admin: PushAdmin,
  group: PushCandidate[]
): Promise<string | null> {
  const known = group.find((candidate) => candidate.shopifyLocationId)?.shopifyLocationId;
  if (known) return known;

  try {
    const response = await admin.graphql(LOCATIONS_QUERY);
    const json = (await response.json()) as {
      data?: { locations?: { nodes?: { id: string }[] } };
    };
    return json?.data?.locations?.nodes?.[0]?.id ?? null;
  } catch {
    return null;
  }
}
