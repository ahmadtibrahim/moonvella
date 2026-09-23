/**
 * Archiving a blocked store's catalogue in Shopify.
 *
 * THE ONLY THING THIS MAY TOUCH. A product is archived here because a row in
 * `ExternalProductMapping` says MoonVella put it in that store — a
 * `(provider, shopDomain, productId)` triple that was written when the import
 * succeeded, and which no title, vendor, tag or resemblance can stand in for.
 * The directive is explicit that unrelated products must never be archived by
 * title, vendor name or tag alone, and the reason is that a merchant's store is
 * full of products MoonVella has never seen: a title match would archive their
 * own bestseller because it happens to be called the same thing.
 *
 * ARCHIVE, NEVER DELETE. `productUpdate` with `status: ARCHIVED` sets the
 * product aside; the merchant keeps the record, its history, its collections and
 * its URL. Nothing here calls `productDelete`, and nothing here touches orders,
 * refunds or fulfillment — a block removes the store's access to MoonVella, and
 * the directive is explicit that it must not delete financial history or cancel
 * paid orders.
 *
 * WHY IT IS A JOB AND NOT A STEP IN THE BLOCK. The block must be committed
 * whether or not Shopify is reachable — the store loses access either way, and
 * an owner who cannot block a store because Shopify is down has lost the
 * control exactly when they need it. So the block marks the rows PENDING and
 * queues this; the archiving then happens with per-product results, retries and
 * real counts.
 *
 * WHAT IT REFUSES TO CLAIM. A product is marked ARCHIVED only when Shopify
 * answered and accepted the change. A run that could not reach Shopify leaves
 * every row PENDING and fails the job with the reason, because "we could not
 * ask" and "it is archived" are different facts and only one of them is
 * reassuring.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { PermanentJobError } from "./jobs.server";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** How many times one product may be attempted before the owner is asked. */
const MAX_ARCHIVE_ATTEMPTS = 5;

const PRODUCT_ARCHIVE = `#graphql
  mutation MoonVellaProductArchive($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title status }
      userErrors { field message }
    }
  }`;

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
};

/** Shopify's answer for one product. */
type ProductOutcome = { ok: true } | { ok: false; message: string; permanent: boolean };

/**
 * Mark the products imported by this app as awaiting archive.
 *
 * Called inside the block transaction, so the owner's screen shows the work as
 * outstanding the moment the block is committed rather than after a worker
 * first looks at the queue. Rows that are already ARCHIVED are left alone: a
 * product archived on an earlier block is not archived again, and its count
 * stays true.
 */
export async function markArchivePending(sellerId: string, tx: Tx = prisma as unknown as Tx) {
  const seller = await tx.seller.findUnique({
    where: { id: sellerId },
    select: { shopDomain: true },
  });
  if (!seller) return { count: 0 };

  return tx.externalProductMapping.updateMany({
    where: {
      provider: "SHOPIFY",
      shopDomain: seller.shopDomain,
      externalProductId: { not: null },
      archiveStatus: { not: "ARCHIVED" },
    },
    data: { archiveStatus: "PENDING", archiveLastError: null },
  });
}

/** The counts the owner is shown: what is done, what is waiting, what failed. */
export async function archiveCounts(sellerId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { shopDomain: true },
  });
  if (!seller) return { archived: 0, pending: 0, failed: 0, total: 0 };

  const rows = await prisma.externalProductMapping.groupBy({
    by: ["archiveStatus"],
    where: {
      provider: "SHOPIFY",
      shopDomain: seller.shopDomain,
      externalProductId: { not: null },
    },
    _count: { _all: true },
  });

  const counts = { archived: 0, pending: 0, failed: 0, total: 0 };
  for (const row of rows) {
    counts.total += row._count._all;
    switch (row.archiveStatus) {
      case "ARCHIVED":
        counts.archived += row._count._all;
        break;
      case "FAILED":
        counts.failed += row._count._all;
        break;
      default:
        // NOT_APPLICABLE and PENDING both mean "not archived yet". A product
        // that has never been through a block is still outstanding work if the
        // store is blocked now, which is why it is not counted separately.
        counts.pending += row._count._all;
        break;
    }
  }
  return counts;
}

/**
 * Archive one product in Shopify.
 *
 * `productUpdate` is called with the id and the status and nothing else. Any
 * other field in the payload would be MoonVella writing over a merchant's own
 * edits — a title, a description, a tag — while doing something the merchant
 * did not ask for and cannot see.
 */
async function archiveOne(
  admin: AdminGraphql,
  productId: string,
  title: string,
): Promise<ProductOutcome> {
  let json: unknown;
  try {
    const res = await admin.graphql(PRODUCT_ARCHIVE, {
      variables: { product: { id: productId, status: "ARCHIVED" } },
    });
    json = await res.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A transport failure says nothing about the product, so it is retryable.
    return { ok: false, message, permanent: false };
  }

  const body = json as {
    data?: {
      productUpdate?: {
        product?: { id: string; status: string } | null;
        userErrors?: { field?: unknown; message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    const message = body.errors.map((e) => e.message).join("; ");
    // Shopify's top-level errors are where an access revocation lands. It is
    // not retryable in the sense that retrying fixes it, but it is also not a
    // fact about the product, so the row stays PENDING and the job fails with
    // the reason instead of claiming an archive that did not happen.
    return { ok: false, message, permanent: false };
  }

  const userErrors = body.data?.productUpdate?.userErrors ?? [];
  if (userErrors.length) {
    const message = userErrors.map((e) => e.message).join("; ");
    // "Product does not exist" means the merchant deleted it, or the id belongs
    // to another store. Neither will change by trying again. Whether Shopify
    // states it as a user error or as a null product is not something to guess
    // at, so both paths apply the same test.
    const permanent = /does not exist|not found|invalid id|access denied|not authorized/i.test(
      message,
    );
    return { ok: false, message, permanent };
  }

  const product = body.data?.productUpdate?.product;
  if (!product) {
    return {
      ok: false,
      message: `Shopify returned no product for ${title} (${productId}); nothing was archived.`,
      permanent: false,
    };
  }

  // Shopify answered, and the answer names the product. Only now is anything
  // recorded as archived — the status is read off the response rather than
  // assumed from the request, so "we asked" and "it is archived" cannot be
  // confused in the count.
  return product.status === "ARCHIVED"
    ? { ok: true }
    : {
        ok: false,
        message: `Shopify accepted the change but reports the product as ${product.status}.`,
        permanent: false,
      };
}

/** What a run did, for the job result and the audit trail. */
export interface ArchiveRunResult {
  total: number;
  archived: number;
  failed: number;
  /** Rows that have used every attempt and now need a person. */
  skipped: number;
  /** Still not archived anywhere in the store, from the counts after the run. */
  pending: number;
  errors: string[];
}

/**
 * The job handler for `SHOPIFY_ARCHIVE_PRODUCTS`.
 *
 * Idempotent by construction: a row already ARCHIVED is skipped, and archiving
 * an archived product in Shopify is a no-op that reports success. Running it
 * twice after a crash therefore archives nothing twice and counts nothing twice.
 *
 * A failure is thrown, not swallowed, so the queue retries with backoff. The
 * per-product outcomes are recorded first, so a retry resumes from the rows that
 * actually still need work rather than starting over.
 */
export async function archiveSellerProducts(sellerId: string): Promise<ArchiveRunResult> {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, shopDomain: true, storeName: true, status: true },
  });
  if (!seller) {
    throw new PermanentJobError(`Seller ${sellerId} does not exist.`);
  }

  /*
   * The second lock on the door, after the queue's access-version check.
   *
   * The version check is what normally stops this from running for a store that
   * is no longer blocked, and it is the one that matters. This check is here
   * because this is the only operation in the system that changes a merchant's
   * public storefront, and "the store is blocked" is cheap to re-read at the
   * moment of the write. If they disagree, the write does not happen.
   */
  if (seller.status !== "BLOCKED") {
    throw new PermanentJobError(
      `Refusing to archive the catalogue of ${seller.storeName}: the store is ${seller.status}, not BLOCKED.`,
    );
  }

  const mappings = await prisma.externalProductMapping.findMany({
    where: {
      provider: "SHOPIFY",
      shopDomain: seller.shopDomain,
      externalProductId: { not: null },
      archiveStatus: { in: ["PENDING", "NOT_APPLICABLE", "FAILED"] },
    },
    include: { product: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  const result: ArchiveRunResult = {
    total: mappings.length,
    archived: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    errors: [],
  };

  const due = mappings.filter((row) => row.archiveAttempts < MAX_ARCHIVE_ATTEMPTS);
  result.skipped = mappings.length - due.length;

  if (due.length === 0) {
    // Everything outstanding has already used its attempts. That is a state a
    // person has to resolve, and saying so is the whole point of the counts.
    const counts = await archiveCounts(sellerId);
    result.pending = counts.pending;
    if (counts.pending > 0) {
      throw new PermanentJobError(
        `${counts.failed} product(s) could not be archived after ${MAX_ARCHIVE_ATTEMPTS} attempts each; ` +
          `${counts.pending} of the store's imported products are still not archived. ` +
          `Retry the failed ones, or resolve them in Shopify, before this is considered done.`,
      );
    }
    return result;
  }

  const { unauthenticated } = await import("~/shopify.server");
  let admin: AdminGraphql;
  try {
    const offline = await unauthenticated.admin(seller.shopDomain);
    admin = offline.admin as unknown as AdminGraphql;
  } catch (error) {
    // No offline session means the app is not installed on that store any more
    // — the merchant uninstalled it, or the token was revoked. Nothing can be
    // archived, and no row may be marked as if it had been.
    const message = error instanceof Error ? error.message : String(error);
    await prisma.externalProductMapping.updateMany({
      where: { id: { in: due.map((row) => row.id) } },
      data: { archiveLastError: `Shopify could not be reached: ${message}` },
    });
    throw new Error(
      `Shopify refused the session for ${seller.shopDomain}, so no product could be archived: ${message}`,
    );
  }

  const account = await verifyProductAccess(admin, seller.shopDomain, due.length);
  if (account) {
    await prisma.externalProductMapping.updateMany({
      where: { id: { in: due.map((row) => row.id) } },
      data: { archiveLastError: account },
    });
    throw new Error(account);
  }

  for (const row of due) {
    const externalId = row.externalProductId as string;
    const outcome = await archiveOne(admin, externalId, row.product?.name ?? row.productId);

    if (outcome.ok) {
      await prisma.externalProductMapping.update({
        where: { id: row.id },
        data: {
          archiveStatus: "ARCHIVED",
          archivedAt: new Date(),
          archiveAttempts: { increment: 1 },
          archiveLastError: null,
          lastSyncedAt: new Date(),
        },
      });
      result.archived += 1;
      continue;
    }

    // A permanent failure stops being retried for this row, but it is not
    // hidden: the row is FAILED, its reason is stored, and the owner's counts
    // include it. What it does not do is fail the whole run, because one
    // product the merchant deleted must not stop the other ninety-nine from
    // being archived.
    await prisma.externalProductMapping.update({
      where: { id: row.id },
      data: {
        archiveStatus: "FAILED",
        // A permanent failure jumps straight to the cap, so the row is not
        // picked up again by the next pass. It stays FAILED and visible.
        archiveAttempts: outcome.permanent ? MAX_ARCHIVE_ATTEMPTS : { increment: 1 },
        archiveLastError: outcome.message,
      },
    });
    result.failed += 1;
    result.errors.push(`${row.product?.name ?? row.productId}: ${outcome.message}`);
  }

  const counts = await archiveCounts(sellerId);
  result.pending = counts.pending;

  await recordAudit({
    actorType: "SYSTEM",
    actorId: "product-archive",
    actorName: "Catalogue archiving",
    action: "shopify.products_archived",
    entityType: AUDIT_ENTITY.SELLER,
    entityId: sellerId,
    afterData: {
      shopDomain: seller.shopDomain,
      archived: result.archived,
      failed: result.failed,
      skipped: result.skipped,
      stillPending: counts.pending,
      errors: result.errors.slice(0, 20),
    },
  });

  if (result.failed > 0) {
    // Thrown after the successes are recorded, so the retry picks up only the
    // rows that still need it. The queue's backoff keeps this from hammering
    // Shopify, and its attempt cap ends the loop where a person is told.
    throw new Error(
      `${result.failed} of ${result.total} product(s) could not be archived: ` +
        result.errors.slice(0, 3).join(" | "),
    );
  }

  return result;
}

/**
 * Confirm the store still answers for products before archiving anything.
 *
 * This is the check behind "do not claim completion if Shopify access was
 * revoked". A revoked token does not always arrive as a thrown error — an
 * uninstalled app can be answered with a payload of permission errors per
 * product, and a run that treated those as per-product failures would report
 * "0 archived, 12 failed" for a reason that has nothing to do with the twelve.
 * Asking once, up front, whether the store answers a trivial product query
 * separates "this store is gone" from "this product is a problem".
 */
async function verifyProductAccess(
  admin: AdminGraphql,
  shopDomain: string,
  count: number,
): Promise<string | null> {
  if (count === 0) return null;
  try {
    const res = await admin.graphql(`#graphql
      query MoonVellaArchiveProbe { shop { name } }`);
    const json = (await res.json()) as {
      data?: { shop?: { name?: string } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      return `Shopify refused a read for ${shopDomain}: ${json.errors
        .map((e) => e.message)
        .join("; ")}. No product was archived.`;
    }
    if (!json.data?.shop?.name) {
      return `Shopify returned no shop for ${shopDomain}. No product was archived.`;
    }
    return null;
  } catch (error) {
    return (
      `Shopify could not be reached for ${shopDomain} (${
        error instanceof Error ? error.message : "unknown error"
      }). No product was archived.`
    );
  }
}

/**
 * Which products are in scope, for a screen that explains the counts.
 *
 * The owner is shown this rather than a bare number because "17 products are
 * pending" is not something anyone can act on, and the list of names is.
 */
export async function archiveWorklist(sellerId: string, take = 50) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { shopDomain: true },
  });
  if (!seller) return [];

  const rows = await prisma.externalProductMapping.findMany({
    where: {
      provider: "SHOPIFY",
      shopDomain: seller.shopDomain,
      externalProductId: { not: null },
      archiveStatus: { not: "ARCHIVED" },
    },
    include: { product: { select: { name: true } } },
    orderBy: [{ archiveStatus: "asc" }, { updatedAt: "desc" }],
    take,
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.product?.name ?? row.productId,
    shopifyProductId: row.externalProductId,
    status: row.archiveStatus,
    attempts: row.archiveAttempts,
    lastError: row.archiveLastError,
    archivedAt: row.archivedAt,
  }));
}

/** Re-queue a blocked store's failed archives, at the owner's request. */
export async function resetFailedArchives(sellerId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { shopDomain: true, status: true },
  });
  if (!seller) throw new Error("Seller not found");
  if (seller.status !== "BLOCKED") {
    throw new Error(
      "Only a blocked store's archives can be retried: the products of a store that is not blocked must not be archived.",
    );
  }

  const reset = await prisma.externalProductMapping.updateMany({
    where: {
      provider: "SHOPIFY",
      shopDomain: seller.shopDomain,
      externalProductId: { not: null },
      archiveStatus: "FAILED",
    },
    data: { archiveStatus: "PENDING", archiveAttempts: 0, archiveLastError: null },
  });

  return reset.count;
}
