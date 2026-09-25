import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY, type AuditActorType } from "./audit.server";
import { requireProductCode, normalizeProductCode } from "~/utils/productCode";
import type { Permission } from "./permissions";
import { assertPublishable } from "./publication.server";

export interface Actor {
  actorType?: AuditActorType;
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * An actor acting on the catalog, who therefore has permissions that can be
 * resolved. This is a separate type rather than a field on `Actor` so that the
 * compiler, not a code review, is what stops a caller forgetting to pass the
 * permissions: an optional field would make "forgot" and "holds nothing"
 * indistinguishable, and this module has to tell those apart to fail closed.
 *
 * Services that only write an audit row still take a plain `Actor`, so they do
 * not have to invent a permission set they never consult.
 */
export interface CatalogActor extends Actor {
  permissions: readonly Permission[];
}

/**
 * Acquisition cost is financial data, so writing it needs `products.cost.edit`
 * rather than the `products.manage` that CATALOG holds. Enforced here, in the
 * service, rather than only in the route: every caller — route, script, future
 * API — passes through this file, and a check that lives in one route is a
 * check every new route has to remember to repeat.
 */
function assertMayWriteCost(actor: CatalogActor, context: string) {
  if (!actor.permissions.includes("products.cost.edit")) {
    throw new Error(`Your role does not permit ${context}.`);
  }
}

/**
 * The catalog permission every write in this file needs, checked in the same
 * place and for the same reason as the cost check above.
 *
 * The routes do check it — each one calls `requirePermission(request,
 * "products.manage")` before it reaches this file. That check is not enough on
 * its own: it protects the requests that exist today, and does nothing for the
 * script, the cron job or the API route somebody adds next year. A viewer who
 * can reach one of these functions by any path must be refused by the function,
 * not by the caller's good manners.
 *
 * Reads are deliberately not gated here — `listProducts` and `getProduct` are
 * called by the seller-facing catalog as well as the admin, and the difference
 * between the two is which fields the caller is shown, which the route decides.
 * `products.view` is enforced at the route for every staff screen.
 */
function assertMayManage(actor: CatalogActor, context: string) {
  if (!actor.permissions.includes("products.manage")) {
    throw new Error(`Your role does not permit ${context}.`);
  }
}

/**
 * Publishing is its own permission, checked in the same place and for the same
 * reason as the cost check above.
 *
 * The owner removed the approval step that used to sit between preparing a
 * product and releasing it, so this is where "may this person put a product in
 * front of sellers" is answered. It is deliberately NOT products.manage:
 * CATALOG writes every field on the record and must not be able to publish it.
 * Unpublishing needs it too — withdrawing a product is no less consequential
 * than releasing one — but is never blocked by the readiness gate, because
 * taking something down must always be possible.
 */
function assertMayPublish(actor: CatalogActor, context: string) {
  if (!actor.permissions.includes("products.publish")) {
    throw new Error(`Your role does not permit ${context}.`);
  }
}

/** True when the actor supplied a cost at all, as opposed to leaving it blank. */
function costWasSupplied(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * The parent product is a family, not a thing you sell. It has no price, no
 * stock and no weight: those belong to the variant, which is the physical unit
 * that ships. Anything commercial passed here is a mistake, and the type says
 * so by not having the fields.
 */
export interface ProductInput {
  name: string;
  productCode: string;
  description?: string | null;
  category: string;
  features?: string | null;
  materials?: string | null;
  careInstructions?: string | null;
  currency?: string;
  /*
   * PUBLISHED is here because the editor saves and publishes in one press, so
   * the status travels with the rest of the fields. PENDING_APPROVAL is not:
   * nothing ever read that state, so the type no longer lets a caller park a
   * product in it. See the migration 20260925000000.
   */
  status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
}

export interface VariantOptionInput {
  name: string;
  value: string;
}

export interface VariantInput {
  name: string;
  sku: string;
  barcode?: string | null;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  costPrice?: number | null;
  inventory: number;
  currency?: string;
  trackInventory?: boolean;
  unitsPerPackage?: number;
  /** Unpacked measurements, in centimetres and kilograms. */
  productLengthCm?: string | number | null;
  productWidthCm?: string | number | null;
  productHeightCm?: string | number | null;
  productWeightKg?: string | number | null;
  options?: VariantOptionInput[];
}

export function validateMoney(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative dollar amount.`);
  }
  // Accept normal dollar amounts and convert to integer minor units on the server
  // (25.00 -> 2500). Existing stored amounts are already minor units.
  return Math.round(n * 100);
}

export function validateQty(value: unknown, label = "Inventory"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative whole number.`);
  }
  return n;
}

function requireText(value: unknown, label: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label} is required.`);
  return s;
}

function optionalText(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s ? s : null;
}

/**
 * Measurements are exact decimals, never floats. Prisma accepts a string for a
 * Decimal column and passes it through to PostgreSQL unchanged, so a value the
 * merchant typed as "12.5" stays 12.5 rather than becoming 12.499999999999998
 * on the way to the database.
 *
 * The scale is fixed by the column: 2 for centimetres, 3 for kilograms. A value
 * with more precision than the column holds is rejected rather than rounded,
 * because rounding a measurement silently is how a shipping quote ends up
 * wrong.
 */
function optionalMeasure(
  value: unknown,
  label: string,
  scale: 2 | 3
): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`${label} must be a positive number.`);
  }
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  if (decimals > scale) {
    throw new Error(`${label} cannot have more than ${scale} decimal place(s).`);
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return raw;
}

/** Trims, upper-cases and rejects anything that is not a usable barcode. */
function optionalBarcode(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
    throw new Error("Barcode may contain only letters, digits, hyphen, underscore and dot.");
  }
  return raw.toUpperCase();
}

async function replaceVariantOptions(
  tx: Prisma.TransactionClient,
  variantId: string,
  options: VariantOptionInput[] | undefined
): Promise<void> {
  if (!options) return;

  // Rebuild rather than merge: the form submits the complete set, and a merge
  // would leave behind an option the merchant just deleted.
  const cleaned = options
    .map((option) => ({
      name: String(option?.name ?? "").trim(),
      value: String(option?.value ?? "").trim(),
    }))
    .filter((option) => option.name && option.value);

  const seen = new Set<string>();
  for (const option of cleaned) {
    const key = option.name.toUpperCase();
    if (seen.has(key)) {
      throw new Error(`Option "${option.name}" is listed twice on the same variant.`);
    }
    seen.add(key);
  }

  await tx.variantOption.deleteMany({ where: { variantId } });
  if (cleaned.length) {
    await tx.variantOption.createMany({
      data: cleaned.map((option, index) => ({
        variantId,
        name: option.name,
        value: option.value,
        sortOrder: index,
      })),
    });
  }
}

export interface ProductListFilters {
  search?: string;
  category?: string;
  // No PENDING_APPROVAL: the list filter stopped offering it, and a filter that
  // can be typed into a URL but never drawn in the interface is a state kept
  // alive by accident. See app/routes/admin.products.tsx.
  status?: "ALL" | "DRAFT" | "PUBLISHED" | "ARCHIVED";
  page?: number;
  pageSize?: number;
}

export async function listProducts(filters: ProductListFilters = {}) {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(filters.pageSize ?? 20)));
  const search = (filters.search ?? "").trim();
  const category = (filters.category ?? "").trim();
  const status = filters.status ?? "ALL";

  const where: Prisma.ProductWhereInput = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { productCode: { contains: search, mode: "insensitive" } },
      // Searching a variant SKU should find the family it belongs to — that is
      // the search a person actually performs when they are holding a box.
      { variants: { some: { sku: { contains: search, mode: "insensitive" } } } },
    ];
  }
  if (category && category !== "ALL") {
    where.category = category;
  }
  if (status !== "ALL") {
    where.status = status;
  }

  const [products, total, categoryRows] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        productCode: true,
        category: true,
        currency: true,
        status: true,
        isActive: true,
        isPublished: true,
        isArchived: true,
        updatedAt: true,
        _count: { select: { variants: true, mediaAssets: true } },
      },
    }),
    prisma.product.count({ where }),
    prisma.product.findMany({
      distinct: ["category"],
      orderBy: { category: "asc" },
      select: { category: true },
    }),
  ]);

  return {
    products,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    categories: categoryRows.map((row) => row.category),
  };
}

export async function getProduct(id: string) {
  return prisma.product.findUnique({
    where: { id },
    include: {
      variants: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: {
          packages: { orderBy: { sortOrder: "asc" } },
          variantOptions: { orderBy: { sortOrder: "asc" } },
        },
      },
      mediaAssets: {
        orderBy: { createdAt: "asc" },
        include: { assignments: true },
      },
      externalMappings: true,
    },
  });
}

/** The variant the interface shows when a product has no obvious choice. */
export async function getDefaultVariant(productId: string) {
  return prisma.productVariant.findFirst({
    where: { productId },
    orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function createProduct(input: ProductInput, actor: CatalogActor) {
  assertMayManage(actor, "creating a product");

  const productCode = requireProductCode(input.productCode);

  // Checked here as well as by the unique index so the person gets a sentence
  // rather than a Prisma error code, and so the check reads the normalised
  // value — "mv-cool-pillow" must collide with "MV-COOL-PILLOW".
  const clash = await prisma.product.findUnique({ where: { productCode } });
  if (clash) {
    throw new Error(`Product Code ${productCode} is already used by "${clash.name}".`);
  }

  const product = await prisma.product.create({
    data: {
      name: requireText(input.name, "Title"),
      productCode,
      category: requireText(input.category, "Category"),
      description: optionalText(input.description),
      features: optionalText(input.features),
      materials: optionalText(input.materials),
      careInstructions: optionalText(input.careInstructions),
      currency: input.currency ? String(input.currency).toUpperCase() : "CAD",
      // Always DRAFT, whatever the caller asked for. A product that has just
      // been created has no variants and no media, so it cannot pass the
      // readiness checklist — accepting `status: "PUBLISHED"` here would be a
      // way to publish that never meets the gate. Publishing is its own action
      // and there is exactly one of those.
      status: "DRAFT",
      isPublished: false,
      createdById: actor.actorId,
      updatedById: actor.actorId,
    },
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.created",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product.id,
    afterData: { name: product.name, productCode: product.productCode },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return product;
}

export async function updateProduct(id: string, input: ProductInput, actor: CatalogActor) {
  assertMayManage(actor, "editing a product");

  const before = await prisma.product.findUnique({ where: { id } });
  if (!before) throw new Error("Product not found.");

  const productCode = requireProductCode(input.productCode);
  if (productCode !== normalizeProductCode(before.productCode)) {
    const clash = await prisma.product.findUnique({ where: { productCode } });
    if (clash && clash.id !== id) {
      throw new Error(`Product Code ${productCode} is already used by "${clash.name}".`);
    }
  }

  // Status changes are routed through the same rules as the Publish action:
  // the same permission, and the same readiness gate. Editing the details form
  // while setting status to PUBLISHED would otherwise be a second way into a
  // published state, checked by nothing — and a way for a role that cannot
  // publish to publish, by saving a form.
  const nextStatus = input.status ?? before.status;
  const changesPublication = (nextStatus === "PUBLISHED") !== (before.status === "PUBLISHED");
  if (changesPublication) {
    assertMayPublish(actor, nextStatus === "PUBLISHED" ? "publishing a product" : "unpublishing a product");
  }
  if (nextStatus === "PUBLISHED" && before.status !== "PUBLISHED") {
    await assertPublishable(id);
  }

  const product = await prisma.product.update({
    where: { id },
    data: {
      name: requireText(input.name, "Title"),
      productCode,
      category: requireText(input.category, "Category"),
      description: optionalText(input.description),
      features: optionalText(input.features),
      materials: optionalText(input.materials),
      careInstructions: optionalText(input.careInstructions),
      currency: input.currency ? String(input.currency).toUpperCase() : "CAD",
      status: nextStatus,
      isPublished: nextStatus === "PUBLISHED",
      updatedById: actor.actorId,
    },
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.updated",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product.id,
    beforeData: { name: before.name, productCode: before.productCode },
    afterData: { name: product.name, productCode: product.productCode },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return product;
}

/**
 * Archive or restore.
 *
 * `status` is kept in step with the flags rather than left behind: archiving a
 * published product while `status` still said PUBLISHED would show "Published"
 * on a row that is not for sale, and two columns disagreeing about the same
 * fact is how the wrong one gets read.
 *
 * Restoring returns a product to DRAFT, not to PUBLISHED. Archiving discards no
 * data, but it does withdraw the product from sellers, and coming back from
 * that should be a decision someone makes with the current state in front of
 * them — which also means the readiness gate runs again.
 */
export async function setArchived(id: string, archived: boolean, actor: CatalogActor) {
  assertMayManage(actor, archived ? "archiving a product" : "restoring a product");

  const product = await prisma.product.update({
    where: { id },
    data: {
      isArchived: archived,
      isActive: !archived,
      isPublished: false,
      status: archived ? "ARCHIVED" : "DRAFT",
    },
  });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: archived ? "product.archived" : "product.restored",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: id,
    afterData: { isArchived: archived },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return product;
}

export async function deleteProduct(id: string, actor: CatalogActor) {
  assertMayManage(actor, "deleting a product");

  const product = await prisma.product.findUnique({
    where: { id },
    select: { id: true, name: true, productCode: true },
  });
  if (!product) throw new Error("Product not found.");

  const orderItemCount = await prisma.orderItem.count({
    where: { OR: [{ productId: id }, { variant: { productId: id } }] },
  });
  if (orderItemCount > 0) {
    throw new Error(
      `Cannot delete "${product.name}": it is referenced by ${orderItemCount} order item(s). Archive it instead to hide it from the catalog while preserving order history.`
    );
  }

  await prisma.product.delete({ where: { id } });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.deleted",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: id,
    beforeData: { name: product.name, productCode: product.productCode },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

/**
 * Flips the merchant-facing flag. Setting a product to published without going
 * through the publication gate is possible here, so callers that face a person
 * should use the gate instead, which refuses while blockers remain and records
 * what they were.
 */
export async function setPublished(id: string, published: boolean, actor: CatalogActor) {
  assertMayPublish(actor, published ? "publishing a product" : "unpublishing a product");

  // The gate is here, not in the route, so that every caller passes through it:
  // the editor's Publish button, the list's Publish button, and anything added
  // later. Unpublishing is never gated — withdrawing a product must always be
  // possible, including when it is the thing that resolves a mistake.
  if (published) {
    await assertPublishable(id);
  }

  const product = await prisma.product.update({
    where: { id },
    data: { isPublished: published, status: published ? "PUBLISHED" : "DRAFT" },
  });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: published ? "product.published" : "product.unpublished",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: id,
    afterData: { isPublished: published },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return product;
}

export async function addVariant(productId: string, input: VariantInput, actor: CatalogActor) {
  assertMayManage(actor, "adding a variant");

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, currency: true, _count: { select: { variants: true } } },
  });
  if (!product) throw new Error("Product not found.");

  const sku = requireText(input.sku, "Variant SKU").toUpperCase();
  const clash = await prisma.productVariant.findUnique({ where: { sku } });
  if (clash) throw new Error(`SKU ${sku} is already used by another variant.`);

  if (costWasSupplied(input.costPrice)) {
    assertMayWriteCost(actor, "setting acquisition cost");
  }

  const data = {
    productId,
    name: requireText(input.name, "Variant name"),
    sku,
    barcode: optionalBarcode(input.barcode),
    wholesalePrice: validateMoney(input.wholesalePrice, "Wholesale price"),
    suggestedRetailPrice: validateMoney(input.suggestedRetailPrice, "Suggested retail price"),
    costPrice: costWasSupplied(input.costPrice)
      ? validateMoney(input.costPrice, "Cost price")
      : null,
    inventory: validateQty(input.inventory),
    currency: input.currency ? String(input.currency).toUpperCase() : product.currency,
    trackInventory: input.trackInventory ?? true,
    unitsPerPackage: Math.max(1, validateQty(input.unitsPerPackage ?? 1, "Units per package")),
    productLengthCm: optionalMeasure(input.productLengthCm, "Product length", 2),
    productWidthCm: optionalMeasure(input.productWidthCm, "Product width", 2),
    productHeightCm: optionalMeasure(input.productHeightCm, "Product height", 2),
    productWeightKg: optionalMeasure(input.productWeightKg, "Product weight", 3),
    sortOrder: product._count.variants,
    // The first variant of a product is the one it sells as by default. The
    // partial unique index allows only one, so this is guarded by the count
    // rather than set optimistically.
    isDefault: product._count.variants === 0,
  };

  const variant = await prisma.$transaction(async (tx) => {
    const created = await tx.productVariant.create({ data });
    await replaceVariantOptions(tx, created.id, input.options);
    return created;
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.variant_added",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: productId,
    afterData: { variantSku: variant.sku, inventory: variant.inventory },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return variant;
}

export async function updateVariant(variantId: string, input: VariantInput, actor: CatalogActor) {
  assertMayManage(actor, "editing a variant");

  const before = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!before) throw new Error("Variant not found.");

  const sku = requireText(input.sku, "Variant SKU").toUpperCase();
  if (sku !== before.sku) {
    const clash = await prisma.productVariant.findUnique({ where: { sku } });
    if (clash && clash.id !== variantId) {
      throw new Error(`SKU ${sku} is already used by another variant.`);
    }
  }

  // Same rule as the measurements below: an omitted barcode is not a request to
  // remove one, and the unique-clash check must not be skipped on the strength
  // of a value the caller never sent.
  const barcode = input.barcode === undefined ? before.barcode : optionalBarcode(input.barcode);
  if (barcode && barcode !== before.barcode) {
    const clash = await prisma.productVariant.findUnique({ where: { barcode } });
    if (clash && clash.id !== variantId) {
      throw new Error(`Barcode ${barcode} is already used by another variant.`);
    }
  }

  const mayWriteCost = actor.permissions.includes("products.cost.edit");
  const costSupplied = costWasSupplied(input.costPrice);
  const nextCost = costSupplied ? validateMoney(input.costPrice, "Cost price") : null;

  // Without cost permission the field is not drawn, so a submission that omits
  // it must leave the stored value alone — otherwise correcting a typo in the
  // name would silently erase the margin. A submission that *changes* it is
  // refused outright rather than quietly ignored: a write that reports success
  // and does nothing is harder to notice than an error.
  if (!mayWriteCost && costSupplied && nextCost !== before.costPrice) {
    assertMayWriteCost(actor, "changing acquisition cost");
  }

  const variant = await prisma.$transaction(async (tx) => {
    const updated = await tx.productVariant.update({
      where: { id: variantId },
      data: {
        name: requireText(input.name, "Variant name"),
        sku,
        barcode,
        wholesalePrice: validateMoney(input.wholesalePrice, "Wholesale price"),
        suggestedRetailPrice: validateMoney(input.suggestedRetailPrice, "Suggested retail price"),
        costPrice: mayWriteCost ? nextCost : before.costPrice,
        inventory: validateQty(input.inventory),
        trackInventory: input.trackInventory ?? before.trackInventory,
        unitsPerPackage: Math.max(
          1,
          validateQty(input.unitsPerPackage ?? before.unitsPerPackage, "Units per package")
        ),
        // Omitted means "this edit is not about that field", and the stored
        // measurement stands. Only an empty value clears it. Treating an
        // omitted field as an empty one makes every partial update — a rename,
        // a price correction, an import that only carries a SKU — silently
        // blank the dimensions and the weight, and nothing reports it, because
        // from the caller's side the write succeeded.
        productLengthCm:
          input.productLengthCm === undefined
            ? before.productLengthCm
            : optionalMeasure(input.productLengthCm, "Product length", 2),
        productWidthCm:
          input.productWidthCm === undefined
            ? before.productWidthCm
            : optionalMeasure(input.productWidthCm, "Product width", 2),
        productHeightCm:
          input.productHeightCm === undefined
            ? before.productHeightCm
            : optionalMeasure(input.productHeightCm, "Product height", 2),
        productWeightKg:
          input.productWeightKg === undefined
            ? before.productWeightKg
            : optionalMeasure(input.productWeightKg, "Product weight", 3),
      },
    });
    await replaceVariantOptions(tx, variantId, input.options);
    return updated;
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.variant_updated",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: before.productId,
    beforeData: { sku: before.sku, inventory: before.inventory },
    afterData: { sku: variant.sku, inventory: variant.inventory },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return variant;
}

export async function deleteVariant(variantId: string, actor: CatalogActor) {
  assertMayManage(actor, "deleting a variant");

  const before = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!before) throw new Error("Variant not found.");

  const [orderItemCount, sellerCount] = await Promise.all([
    prisma.orderItem.count({ where: { variantId } }),
    prisma.sellerProductVariant.count({ where: { productVariantId: variantId } }),
  ]);
  if (orderItemCount > 0) {
    throw new Error(
      `Cannot delete SKU ${before.sku}: it is referenced by ${orderItemCount} order item(s). Deactivate it instead so order history stays intact.`
    );
  }
  if (sellerCount > 0) {
    throw new Error(
      `Cannot delete SKU ${before.sku}: ${sellerCount} seller listing(s) reference it. Remove those listings first.`
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.productVariant.delete({ where: { id: variantId } });
    // Deleting the default would leave the product with variants but no default
    // and no way for the interface to pick one. Promote the next variant.
    if (before.isDefault) {
      const next = await tx.productVariant.findFirst({
        where: { productId: before.productId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });
      if (next) {
        await tx.productVariant.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.variant_deleted",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: before.productId,
    beforeData: { sku: before.sku },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

/**
 * Makes `variantId` the one the product sells as. Runs in a transaction that
 * clears the old default first: the partial unique index permits only one row
 * per product with isDefault, so setting the new one before clearing the old
 * would be rejected.
 */
export async function setDefaultVariant(variantId: string, actor: CatalogActor) {
  assertMayManage(actor, "changing the default variant");

  const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!variant) throw new Error("Variant not found.");

  await prisma.$transaction(async (tx) => {
    await tx.productVariant.updateMany({
      where: { productId: variant.productId, isDefault: true },
      data: { isDefault: false },
    });
    await tx.productVariant.update({ where: { id: variantId }, data: { isDefault: true } });
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.variant_set_default",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: variant.productId,
    afterData: { sku: variant.sku },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return variant;
}

/**
 * Duplicates a product as a new draft family, including its variants, their
 * options and its media assignments. Media *files* are not copied: the new
 * product's assignments point at the same stored objects, because duplicating a
 * 20 MB photograph to describe the same photograph twice wastes storage and
 * makes the two copies diverge.
 */
export async function duplicateProduct(id: string, actor: CatalogActor): Promise<{ id: string }> {
  assertMayManage(actor, "duplicating a product");

  const source = await prisma.product.findUnique({
    where: { id },
    include: {
      variants: { include: { variantOptions: { orderBy: { sortOrder: "asc" } } } },
      mediaAssets: { include: { assignments: true } },
    },
  });
  if (!source) throw new Error("Product not found.");

  // A copy reproduces the original's cost, so the copy is a way of writing cost
  // that never passed through the variant form. Without the permission the copy
  // is still made — duplicating a product is `products.manage` — but it carries
  // no acquisition cost, which is the part this actor may not hold.
  const mayWriteCost = actor.permissions.includes("products.cost.edit");

  // Derive an unused code rather than guessing once and failing on the unique
  // index if the copy already exists from an earlier attempt.
  const base = `${source.productCode}-COPY`;
  let productCode = base;
  for (let n = 2; n <= 50; n += 1) {
    const taken = await prisma.product.findUnique({ where: { productCode } });
    if (!taken) break;
    productCode = `${base}-${n}`;
  }

  const copy = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        name: `${source.name} (copy)`,
        productCode,
        description: source.description,
        category: source.category,
        currency: source.currency,
        features: source.features,
        materials: source.materials,
        careInstructions: source.careInstructions,
        // A copy is never born published, whatever the original was.
        status: "DRAFT",
        isPublished: false,
        isActive: true,
        isArchived: false,
        createdById: actor.actorId,
        updatedById: actor.actorId,
      },
    });

    const skuMap = new Map<string, string>();
    for (const variant of source.variants) {
      let sku = `${variant.sku}-COPY`;
      for (let n = 2; n <= 50; n += 1) {
        const taken = await tx.productVariant.findUnique({ where: { sku } });
        if (!taken) break;
        sku = `${variant.sku}-COPY-${n}`;
      }
      const created = await tx.productVariant.create({
        data: {
          productId: product.id,
          sku,
          name: variant.name,
          wholesalePrice: variant.wholesalePrice,
          suggestedRetailPrice: variant.suggestedRetailPrice,
          costPrice: mayWriteCost ? variant.costPrice : null,
          // Stock is not copied. The copy has none of the original's units on
          // the shelf, and carrying the number over would overstate inventory.
          inventory: 0,
          currency: variant.currency,
          trackInventory: variant.trackInventory,
          unitsPerPackage: variant.unitsPerPackage,
          productLengthCm: variant.productLengthCm,
          productWidthCm: variant.productWidthCm,
          productHeightCm: variant.productHeightCm,
          productWeightKg: variant.productWeightKg,
          sortOrder: variant.sortOrder,
          isDefault: variant.isDefault,
          isActive: variant.isActive,
        },
      });
      skuMap.set(variant.id, created.id);

      if (variant.variantOptions.length) {
        await tx.variantOption.createMany({
          data: variant.variantOptions.map((option, index) => ({
            variantId: created.id,
            name: option.name,
            value: option.value,
            sortOrder: index,
          })),
        });
      }
    }

    // Shared assets are referenced, not cloned. Variant-scoped assignments are
    // remapped onto the copied variants.
    for (const asset of source.mediaAssets) {
      for (const assignment of asset.assignments) {
        const targetVariant = assignment.variantId ? skuMap.get(assignment.variantId) : null;
        if (assignment.variantId && !targetVariant) continue;
        await tx.mediaAssetAssignment.create({
          data: {
            assetId: asset.id,
            variantId: targetVariant ?? null,
            sortOrder: assignment.sortOrder,
            isPrimary: assignment.isPrimary,
          },
        });
      }
    }

    return product;
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.duplicated",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: copy.id,
    beforeData: { sourceId: source.id, sourceCode: source.productCode },
    afterData: { productCode: copy.productCode },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { id: copy.id };
}
