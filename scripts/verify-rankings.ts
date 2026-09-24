import { PrismaClient } from "@prisma/client";
import { computeRankings, toCsv } from "../app/services/rankings.server";

const prisma = new PrismaClient();
const SHOP_A = "rank-a.myshopify.com";
const SHOP_B = "rank-b.myshopify.com";
let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * How many sellers the unfiltered export is supposed to return.
 *
 * Read from the database rather than hard-coded to the two this suite creates.
 * The export lists EVERY seller whose orders count — that is the product
 * behaviour, and the check below confirms it — so assuming the catalog holds
 * nobody but these two made the suite fail on the clone for a reason that has
 * nothing to do with rankings: the clone is a copy of the deployed database and
 * carries the sellers that are really in it. The assertion keeps its teeth
 * because the count still has to match exactly, whichever sellers exist.
 */
async function qualifyingSellerCount() {
  return prisma.seller.count({ where: { status: { in: ["APPROVED", "SUSPENDED", "BLOCKED"] } } });
}

async function cleanup() {
  for (const shop of [SHOP_A, SHOP_B]) {
    const seller = await prisma.seller.findUnique({ where: { shopDomain: shop } });
    if (seller) {
      const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
      const ids = orders.map((o) => o.id);
      await prisma.refund.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.order.deleteMany({ where: { sellerId: seller.id } });
      await prisma.seller.delete({ where: { id: seller.id } });
    }
  }
}

async function makeSeller(shop: string, name: string) {
  return prisma.seller.create({
    data: {
      shopDomain: shop,
      storeName: name,
      shopDomainFull: shop,
      contactEmail: `${name}@test.example`,
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });
}

async function makeOrder(
  sellerId: string,
  name: string,
  currency: string,
  items: { price: number; wholesale: number; qty: number }[],
  opts: { cancelled?: boolean; paymentStatus?: "PAID" | "PENDING" } = {}
) {
  const now = new Date();
  const retail = items.reduce((s, i) => s + i.price * i.qty, 0);
  const wholesale = items.reduce((s, i) => s + i.wholesale * i.qty, 0);
  return prisma.order.create({
    data: {
      sellerId,
      shopifyOrderId: `rank-${Math.random().toString(36).slice(2)}`,
      shopifyOrderName: name,
      shopifyOrderNumber: 1,
      currency,
      subtotal: retail,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: retail,
      moonvellaSubtotal: wholesale,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: wholesale,
      paymentStatus: opts.paymentStatus ?? "PAID",
      fulfillmentStatus: "PENDING",
      shopifyCreatedAt: now,
      shopifyUpdatedAt: now,
      cancelledAt: opts.cancelled ? now : null,
      items: {
        create: items.map((i) => ({
          name: "Test item",
          sku: "RANK-TEST",
          quantity: i.qty,
          price: i.price,
          wholesalePrice: i.wholesale,
          totalDiscount: 0,
          shopifyLineItemId: `li-${Math.random().toString(36).slice(2)}`,
          isMoonvellaProduct: true,
        })),
      },
    },
  });
}

async function main() {
  await cleanup();
  const a = await makeSeller(SHOP_A, "Rank Seller A");
  const b = await makeSeller(SHOP_B, "Rank Seller B");

  // A: retail 9800, wholesale 2598
  await makeOrder(a.id, "#A1", "CAD", [{ price: 4900, wholesale: 1299, qty: 2 }]);
  // A: TEST order (excluded)
  await makeOrder(a.id, "TEST-ORDER", "CAD", [{ price: 9900, wholesale: 3000, qty: 1 }]);
  // B: retail 6900, wholesale 1899
  await makeOrder(b.id, "#B1", "CAD", [{ price: 6900, wholesale: 1899, qty: 1 }]);
  // B: cancelled (excluded)
  await makeOrder(b.id, "#B2", "CAD", [{ price: 5000, wholesale: 1000, qty: 1 }], { cancelled: true });
  // B: unpaid (excluded)
  await makeOrder(b.id, "#B3", "CAD", [{ price: 5000, wholesale: 1000, qty: 1 }], { paymentStatus: "PENDING" });

  // Refund 1000 on A
  const orderA = await prisma.order.findFirst({ where: { sellerId: a.id, shopifyOrderName: "#A1" } });
  await prisma.refund.create({
    data: { orderId: orderA!.id, shopifyRefundId: "r1", amount: 1000, processedAt: new Date() },
  });

  const from = new Date(Date.now() - 30 * 86400000);
  const to = new Date(Date.now() + 60000);
  const result = await computeRankings(from, to, "CAD", { all: true });

  const rowA = result.rows.find((r) => r.sellerId === a.id)!;
  const rowB = result.rows.find((r) => r.sellerId === b.id)!;

  check("A retail sales = 9800", rowA.retailSales === 9800, String(rowA.retailSales));
  check("A wholesale revenue = 2598", rowA.wholesaleRevenue === 2598, String(rowA.wholesaleRevenue));
  check("A refund = 1000", rowA.refunds === 1000, String(rowA.refunds));
  check("A net retail = 8800", rowA.netRetail === 8800, String(rowA.netRetail));
  check("B retail sales excludes cancelled/unpaid = 6900", rowB.retailSales === 6900, String(rowB.retailSales));
  check("TEST order excluded from A", rowA.paidOrders === 1, `${rowA.paidOrders} paid order(s)`);
  check("Ranking order: A before B", result.rows.findIndex((r) => r.sellerId === a.id) < result.rows.findIndex((r) => r.sellerId === b.id));
  check("Totals: paid orders = 2", result.totals.paidOrders === 2, String(result.totals.paidOrders));
  check("Totals: net retail = 15700", result.totals.netRetail === 15700, String(result.totals.netRetail));
  check("Totals: units = 3", result.totals.unitsSold === 3, String(result.totals.unitsSold));
  check("Sellers with history = 2", result.totals.sellers === 2, String(result.totals.sellers));
  const sellerRows = await qualifyingSellerCount();
  check(
    "Total rows = every seller whose orders count, not just these two",
    result.totalRows === sellerRows,
    `${result.totalRows} row(s), ${sellerRows} qualifying seller(s) in this database`,
  );
  check("hasHistory set for A", rowA.hasHistory === true);
  check("No dropped currencies yet", result.droppedCurrencyOrders === 0, String(result.droppedCurrencyOrders));

  // DB-level search
  const searchA = await computeRankings(from, to, "CAD", { search: "seller a", all: true });
  check("Search by store name returns only A", searchA.rows.length === 1 && searchA.rows[0].sellerId === a.id, `${searchA.rows.length} row(s)`);
  const searchDomain = await computeRankings(from, to, "CAD", { search: "rank-b", all: true });
  check("Search by shop domain returns only B", searchDomain.rows.length === 1 && searchDomain.rows[0].sellerId === b.id, `${searchDomain.rows.length} row(s)`);
  check("Search totalRows reflects filter", searchA.totalRows === 1, String(searchA.totalRows));

  // DB-level sort
  const ascRetail = await computeRankings(from, to, "CAD", { sortKey: "retailSales", sortDir: "asc", all: true });
  check("Sort retailSales asc puts B before A", ascRetail.rows.findIndex((r) => r.sellerId === b.id) < ascRetail.rows.findIndex((r) => r.sellerId === a.id));
  const descRefund = await computeRankings(from, to, "CAD", { sortKey: "refunds", sortDir: "desc", all: true });
  check("Sort refunds desc puts A before B", descRefund.rows.findIndex((r) => r.sellerId === a.id) < descRefund.rows.findIndex((r) => r.sellerId === b.id));

  // DB-level pagination (page size 1 over the two sellers)
  const page1 = await computeRankings(from, to, "CAD", { search: "Rank Seller", pageSize: 1, page: 1 });
  const page2 = await computeRankings(from, to, "CAD", { search: "Rank Seller", pageSize: 1, page: 2 });
  check("Pagination: page 1 returns 1 row", page1.rows.length === 1, `${page1.rows.length} row(s)`);
  check("Pagination: totalRows = 2", page1.totalRows === 2, String(page1.totalRows));
  check("Pagination: page 2 returns the other row", page2.rows.length === 1 && page2.rows[0].sellerId !== page1.rows[0].sellerId);
  check("Pagination: pageSize reported as 1", page1.pageSize === 1, String(page1.pageSize));

  // CSV exports the full filtered/sorted set, not just a page
  const csv = toCsv(result.rows, result.currency);
  check("CSV contains both sellers", csv.includes("Rank Seller A") && csv.includes("Rank Seller B"));
  check(
    "CSV has a header and one row per sold-to seller",
    csv.split("\n").length === sellerRows + 1,
    `${csv.split("\n").length} line(s) for ${sellerRows} seller(s)`,
  );

  // Currency separation
  await makeOrder(a.id, "#A-EUR", "EUR", [{ price: 1000, wholesale: 100, qty: 1 }]);
  const result2 = await computeRankings(from, to, "CAD", { all: true });
  const rowA2 = result2.rows.find((r) => r.sellerId === a.id)!;
  check("Mixed currency not combined into CAD totals", rowA2.retailSales === 9800 && result2.mixedCurrencies.includes("EUR"), `retail ${rowA2.retailSales} mixed=${JSON.stringify(result2.mixedCurrencies)}`);
  check("Dropped currency order count = 1", result2.droppedCurrencyOrders === 1, String(result2.droppedCurrencyOrders));
  check("Dropped currency excluded from CAD totals", result2.totals.retailSales === 16700, String(result2.totals.retailSales));
  const csv2 = toCsv(result2.rows, result2.currency, result2.notes);
  check("CSV note surfaces dropped currency count", csv2.includes("EUR") && csv2.includes("1 order(s) excluded"), csv2.split("\n").slice(-2).join(" | "));

  await cleanup();
  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
