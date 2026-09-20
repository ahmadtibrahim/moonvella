import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY, type AuditActorType } from "./audit.server";

export interface Actor {
  actorType?: AuditActorType;
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ProductInput {
  name: string;
  description?: string | null;
  category: string;
  sku: string;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  costPrice?: number | null;
  currency?: string;
  isPublished?: boolean;
}

export interface VariantInput {
  name: string;
  sku: string;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  costPrice?: number | null;
  inventory: number;
  weight?: number | null;
}

function validateMoney(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative dollar amount.`);
  }
  // Accept normal dollar amounts and convert to integer minor units on the server
  // (25.00 -> 2500). Existing stored amounts are already minor units.
  return Math.round(n * 100);
}

function validateQty(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("Inventory must be a non-negative whole number.");
  }
  return n;
}

function requireText(value: unknown, label: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label} is required.`);
  return s;
}

export interface ProductListFilters {
  search?: string;
  category?: string;
  status?: "ALL" | "PUBLISHED" | "UNPUBLISHED" | "ARCHIVED";
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
    where.OR = [{ name: { contains: search } }, { sku: { contains: search } }];
  }
  if (category && category !== "ALL") {
    where.category = category;
  }
  if (status === "PUBLISHED") {
    where.isPublished = true;
    where.isArchived = false;
  } else if (status === "UNPUBLISHED") {
    where.isPublished = false;
    where.isArchived = false;
  } else if (status === "ARCHIVED") {
    where.isArchived = true;
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
        sku: true,
        category: true,
        wholesalePrice: true,
        suggestedRetailPrice: true,
        currency: true,
        isActive: true,
        isPublished: true,
        isArchived: true,
        _count: { select: { variants: true, productImages: true } },
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
        orderBy: { createdAt: "asc" },
        include: { packages: { orderBy: { sortOrder: "asc" } } },
      },
      productImages: { orderBy: { sortOrder: "asc" } },
    },
  });
}

export async function createProduct(input: ProductInput, actor: Actor) {
  const data = {
    name: requireText(input.name, "Title"),
    sku: requireText(input.sku, "SKU"),
    category: requireText(input.category, "Category"),
    description: input.description ? String(input.description).trim() : null,
    wholesalePrice: validateMoney(input.wholesalePrice, "Wholesale price"),
    suggestedRetailPrice: validateMoney(input.suggestedRetailPrice, "Suggested retail price"),
    costPrice:
      input.costPrice === undefined || input.costPrice === null || input.costPrice === ("" as never)
        ? null
        : validateMoney(input.costPrice, "Cost price"),
    currency: input.currency ? String(input.currency).toUpperCase() : "CAD",
    isPublished: input.isPublished ?? true,
  };

  const product = await prisma.product.create({ data });

  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.created",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product.id,
    afterData: { name: product.name, sku: product.sku },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return product;
}

export async function updateProduct(id: string, input: ProductInput, actor: Actor) {
  const before = await prisma.product.findUnique({ where: { id } });
  if (!before) throw new Error("Product not found.");

  const data = {
    name: requireText(input.name, "Title"),
    sku: requireText(input.sku, "SKU"),
    category: requireText(input.category, "Category"),
    description: input.description ? String(input.description).trim() : null,
    wholesalePrice: validateMoney(input.wholesalePrice, "Wholesale price"),
    suggestedRetailPrice: validateMoney(input.suggestedRetailPrice, "Suggested retail price"),
    costPrice:
      input.costPrice === undefined || input.costPrice === null || input.costPrice === ("" as never)
        ? null
        : validateMoney(input.costPrice, "Cost price"),
    currency: input.currency ? String(input.currency).toUpperCase() : "CAD",
  };

  const product = await prisma.product.update({ where: { id }, data });

  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.updated",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: product.id,
    beforeData: { name: before.name, wholesalePrice: before.wholesalePrice },
    afterData: { name: product.name, wholesalePrice: product.wholesalePrice },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return product;
}

export async function setArchived(id: string, archived: boolean, actor: Actor) {
  const product = await prisma.product.update({
    where: { id },
    data: { isArchived: archived, isActive: !archived },
  });
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
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

export async function deleteProduct(id: string, actor: Actor) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: { id: true, name: true, sku: true },
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
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.deleted",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: id,
    beforeData: { name: product.name, sku: product.sku },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function setPublished(id: string, published: boolean, actor: Actor) {
  const product = await prisma.product.update({
    where: { id },
    data: { isPublished: published },
  });
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
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

export async function addVariant(productId: string, input: VariantInput, actor: Actor) {
  const data = {
    productId,
    name: requireText(input.name, "Variant name"),
    sku: requireText(input.sku, "Variant SKU"),
    wholesalePrice: validateMoney(input.wholesalePrice, "Wholesale price"),
    suggestedRetailPrice: validateMoney(input.suggestedRetailPrice, "Suggested retail price"),
    costPrice:
      input.costPrice === undefined || input.costPrice === null || input.costPrice === ("" as never)
        ? null
        : validateMoney(input.costPrice, "Cost price"),
    inventory: validateQty(input.inventory),
    weight: input.weight ? validateQty(input.weight) : null,
  };
  const variant = await prisma.productVariant.create({ data });
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
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

export async function updateVariant(variantId: string, input: VariantInput, actor: Actor) {
  const before = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!before) throw new Error("Variant not found.");
  const variant = await prisma.productVariant.update({
    where: { id: variantId },
    data: {
      name: requireText(input.name, "Variant name"),
      sku: requireText(input.sku, "Variant SKU"),
      wholesalePrice: validateMoney(input.wholesalePrice, "Wholesale price"),
      suggestedRetailPrice: validateMoney(input.suggestedRetailPrice, "Suggested retail price"),
      costPrice:
        input.costPrice === undefined || input.costPrice === null || input.costPrice === ("" as never)
          ? null
          : validateMoney(input.costPrice, "Cost price"),
      inventory: validateQty(input.inventory),
      weight: input.weight ? validateQty(input.weight) : null,
    },
  });
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.variant_updated",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: before.productId,
    beforeData: { inventory: before.inventory },
    afterData: { inventory: variant.inventory },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return variant;
}

export async function deleteVariant(variantId: string, actor: Actor) {
  const before = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!before) throw new Error("Variant not found.");
  await prisma.productVariant.delete({ where: { id: variantId } });
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
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

export async function addImage(productId: string, url: string, alt: string | null, actor: Actor) {
  const count = await prisma.productImage.count({ where: { productId } });
  const image = await prisma.productImage.create({
    data: { productId, url, alt, sortOrder: count },
  });
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.image_added",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: productId,
    afterData: { url },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return image;
}

export async function deleteImage(imageId: string, actor: Actor) {
  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image) throw new Error("Image not found.");
  await prisma.productImage.delete({ where: { id: imageId } });
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.image_deleted",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: image.productId,
    beforeData: { url: image.url },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

async function orderedImageIds(productId: string): Promise<string[]> {
  const images = await prisma.productImage.findMany({
    where: { productId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  return images.map((image) => image.id);
}

async function persistImageOrder(orderedIds: string[]): Promise<void> {
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.productImage.update({ where: { id }, data: { sortOrder: index } })
    )
  );
}

/**
 * Rewrites `sortOrder` for every image of a product. The first id becomes the
 * main catalog image (there is no dedicated `isMain` column in the schema).
 */
export async function reorderImages(productId: string, orderedIds: string[], actor: Actor) {
  const existing = await orderedImageIds(productId);
  const existingSet = new Set(existing);
  const next = orderedIds.filter((id) => existingSet.has(id));
  for (const id of existing) {
    if (!next.includes(id)) next.push(id);
  }
  await persistImageOrder(next);
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.images_reordered",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: productId,
    afterData: { order: next },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return next;
}

export async function setMainImage(imageId: string, actor: Actor) {
  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image) throw new Error("Image not found.");
  const existing = await orderedImageIds(image.productId);
  const next = [image.id, ...existing.filter((id) => id !== image.id)];
  await persistImageOrder(next);
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "product.image_set_main",
    entityType: AUDIT_ENTITY.PRODUCT,
    entityId: image.productId,
    afterData: { imageId: image.id, url: image.url },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return image;
}

export async function moveImage(imageId: string, direction: "up" | "down", actor: Actor) {
  const image = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!image) throw new Error("Image not found.");
  const order = await orderedImageIds(image.productId);
  const index = order.indexOf(image.id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index !== -1 && target >= 0 && target < order.length) {
    [order[index], order[target]] = [order[target], order[index]];
    await persistImageOrder(order);
    await recordAudit({
      actorType: actor.actorType ?? "OWNER_USER",
      actorId: actor.actorId,
      actorName: actor.actorName,
      action: "product.image_reordered",
      entityType: AUDIT_ENTITY.PRODUCT,
      entityId: image.productId,
      afterData: { imageId: image.id, direction },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }
  return image;
}
