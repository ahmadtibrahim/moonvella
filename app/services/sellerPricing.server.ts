import { prisma } from "~/db.server";

/**
 * THE SELLER'S OWN RETAIL PRICE, PER SELLABLE UNIT.
 *
 * WHAT THIS NUMBER IS. It is what the seller's own customers pay — the price
 * their Shopify listing shows, and the price the import sends. It starts at the
 * catalogue's `ProductVariant.suggestedRetailPrice` and the seller may change it
 * to whatever they like, per variant, because a King and a Standard are not the
 * same product to a shopper.
 *
 * WHAT IT IS NOT, AND THE TWO THINGS IT IS EASY TO CONFUSE IT WITH:
 *
 *   • `ProductVariant.wholesalePrice` — what MoonVella invoices the seller. The
 *     seller may not change it, and it is read-only on every seller screen. The
 *     owner's instruction is exact: a seller can change what they charge and not
 *     what they are charged.
 *
 *   • `ProductVariant.costPrice` — what MoonVella paid for the goods. It is the
 *     merchant's own figure, kept behind an edit permission, and it is not sent
 *     to a seller's store as their cost. `sellerCostFor` in the import service
 *     carries that reasoning.
 *
 * WHY A TABLE RATHER THAN A COLUMN, in one line each: a `SellerProductVariant`
 * row is the mapping to a Shopify variant and cannot exist before the import,
 * which is exactly when the price is typed; a `SellerProduct` row is the family,
 * and one price for three sizes is the defect this table was built to fix. The
 * migration carries the full argument.
 *
 * A ROW IS NOT EVIDENCE OF AN IMPORT. The seller prices a product on the
 * catalogue card and imports it afterwards; the row written here is read by the
 * import on the way past. It is also not a snapshot: it is the live price, so a
 * seller who changes it after importing changes it for the next re-sync, and
 * `app.products` offers exactly that.
 *
 * THE FAMILY COLUMN IS STILL READ, AS A FALLBACK. `SellerProduct.customRetailPrice`
 * is the one-price-for-the-family control that this table replaced. Stores that
 * set it keep the price they set — on the catalogue card, in the import and on
 * My Products — for every variant that has no row here. See
 * `loadLegacyFamilyRetailPrices` for why it is read rather than migrated.
 */

/**
 * The largest price this application will store: one million dollars, in cents.
 *
 * A limit exists because the field is a free-text number box and `100000` typed
 * where `1000.00` was meant is a listing nobody can buy. The check is a typo
 * guard, not a business rule — it is far above any real product and far below
 * where a decimal point in the wrong place would land.
 */
export const MAX_RETAIL_CENTS = 100_000_000;

export interface RetailPriceWrite {
  sellerId: string;
  productVariantId: string;
  /** Cents, CAD. See the module note: nothing here is stored in any other currency. */
  retailPrice: number;
}

export type RetailPriceResult =
  | { ok: true; retailPrice: number }
  | { ok: false; error: string };

/**
 * The seller's prices for a set of variants, as a map.
 *
 * `variantIds` is optional and exists for the two callers' different shapes: the
 * catalogue wants every price the seller has set, one query for the whole page,
 * while the import wants the prices for one product's variants and nothing else.
 *
 * A variant with no row is simply absent from the map. That is the ordinary
 * state — it means the seller has no opinion and the catalogue figure applies —
 * so callers must not read absence as an error. `?? null` at the call site.
 */
export async function loadSellerRetailPrices(
  sellerId: string,
  variantIds?: string[]
): Promise<Map<string, number>> {
  if (variantIds && variantIds.length === 0) return new Map();

  const rows = await prisma.sellerVariantPrice.findMany({
    where: {
      sellerId,
      ...(variantIds ? { productVariantId: { in: variantIds } } : {}),
    },
    select: { productVariantId: true, retailPrice: true },
  });

  return new Map(rows.map((row) => [row.productVariantId, row.retailPrice]));
}

/**
 * The old family-level price, keyed by product, for the variants that have no
 * row of their own.
 *
 * READ, NOT MIGRATED, AND THAT IS DELIBERATE. The obvious migration is to copy
 * each family's price onto all of its variants and delete the column — but a
 * family price was chosen while there was only one box to choose in, and
 * duplicating it across three sizes would present a single decision as three,
 * then let the seller edit each one as though they had meant them to differ.
 * Leaving the fallback in place costs one extra query on two pages and keeps
 * every store at the price it is actually listed at.
 *
 * A zero is carried through rather than filtered. It is not a usable price and
 * the import will refuse it, which is correct: the seller typed it under the old
 * screen, and substituting the catalogue's figure would list a product at a
 * price nobody chose. The card shows it as needing a price, and the refusal
 * names the variant.
 */
export async function loadLegacyFamilyRetailPrices(sellerId: string): Promise<Map<string, number>> {
  const rows = await prisma.sellerProduct.findMany({
    where: { sellerId, customRetailPrice: { not: null } },
    select: { productId: true, customRetailPrice: true },
  });

  return new Map(
    rows.map((row) => [row.productId, row.customRetailPrice as number])
  );
}

/**
 * Set the seller's price for one variant.
 *
 * REFUSES ZERO, AND REFUSES A NEGATIVE OR A FRACTION. A zero is not "unset" —
 * it is a price, and a live one: Shopify accepts it, the listing shows the
 * product as free, and it takes real orders at nothing. Clearing a price is a
 * different operation with a different name (`clearSellerRetailPrice`), so that
 * a form that arrives with an empty or unreadable number cannot be mistaken for
 * an instruction to sell at zero. The form is parsed by the caller; this
 * function is the last place the number can be wrong, so it checks it anyway.
 *
 * THE PRODUCT GATE IS RE-CHECKED HERE. The page only offers a price box on a
 * published, active, unarchived product, but a form can be replayed and a
 * product can be withdrawn between the page being drawn and the button being
 * pressed. A price stored against a variant the seller can no longer be shown is
 * not harmful in itself — it is a number they typed — but accepting it would
 * mean this function answers to any variant id in the table, which is a write
 * nobody's screen offered. The refusal says what happened rather than pretending
 * the variant is missing.
 *
 * APPROVAL IS NOT CHECKED HERE. It is the caller's gate (`requireMerchantAccess`
 * with BUSINESS), because this function has no request to read a session from;
 * an unapproved seller cannot reach it through the application.
 */
export async function setSellerRetailPrice({
  sellerId,
  productVariantId,
  retailPrice,
}: RetailPriceWrite): Promise<RetailPriceResult> {
  if (!Number.isInteger(retailPrice) || retailPrice <= 0) {
    return {
      ok: false,
      error: "Enter a retail price greater than zero. To go back to MoonVella's suggested price, use Reset.",
    };
  }
  if (retailPrice > MAX_RETAIL_CENTS) {
    return {
      ok: false,
      error: `That price looks like a typo. The most this field accepts is ${(MAX_RETAIL_CENTS / 100).toLocaleString(
        "en-CA",
        { style: "currency", currency: "CAD" }
      )}.`,
    };
  }

  const variant = await prisma.productVariant.findFirst({
    where: {
      id: productVariantId,
      isActive: true,
      product: { status: "PUBLISHED", isActive: true, isArchived: false },
    },
    select: { id: true },
  });
  if (!variant) {
    return { ok: false, error: "That variant is not in the catalogue any more." };
  }

  await prisma.sellerVariantPrice.upsert({
    where: { sellerId_productVariantId: { sellerId, productVariantId } },
    create: { sellerId, productVariantId, retailPrice },
    update: { retailPrice },
  });

  return { ok: true, retailPrice };
}

/**
 * Go back to the catalogue's suggested price for one variant.
 *
 * DELETES THE ROW RATHER THAN WRITING THE SUGGESTED FIGURE INTO IT, because the
 * two are not the same state. A row holding today's suggested price is a
 * decision the seller made; tomorrow, when the merchant revises the
 * recommendation, it keeps the old number and the seller never learns the
 * catalogue moved. No row means "whatever MoonVella suggests", which is what the
 * Reset button is offering.
 *
 * Idempotent: resetting a variant that has no row is a no-op, not an error,
 * because the state asked for is the state it is already in.
 */
export async function clearSellerRetailPrice(
  sellerId: string,
  productVariantId: string
): Promise<void> {
  await prisma.sellerVariantPrice.deleteMany({ where: { sellerId, productVariantId } });
}
