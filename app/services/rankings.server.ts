import { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";

/**
 * Ranking calculation definitions (documented so totals are reproducible):
 * - Period is applied to Order.shopifyCreatedAt and Refund.processedAt, inclusive.
 * - Timezone: UTC.
 * - Customer payment: only orders whose customer paid (PAID / PARTIALLY_REFUNDED).
 * - Cancelled orders are excluded.
 * - Test orders are excluded: order name starting with "TEST", or seller shop domain
 *   ending in "test.myshopify.com".
 * - MoonVella retail sales = sum(OrderItem.price * quantity) for MoonVella items only.
 * - MoonVella wholesale revenue = sum(OrderItem.wholesalePrice * quantity).
 * - Refunds subtract from the period in which the refund was processed.
 * - Currencies are never combined: aggregation is CAD-only (no FX source), and
 *   non-CAD orders are dropped and reported as a count.
 * - Aggregation, search, sorting and pagination all happen in SQLite; only the
 *   requested page of seller rows is materialised in memory.
 */

export type RankingSortKey =
  | "netRetail"
  | "retailSales"
  | "wholesaleRevenue"
  | "paidOrders"
  | "unitsSold"
  | "refunds";

export interface RankingRow {
  sellerId: string;
  storeName: string;
  shopDomain: string;
  status: string;
  retailSales: number;
  wholesaleRevenue: number;
  paidOrders: number;
  unitsSold: number;
  refunds: number;
  netRetail: number;
  currency: string;
  hasHistory: boolean;
}

export interface RankingTotals {
  retailSales: number;
  wholesaleRevenue: number;
  paidOrders: number;
  unitsSold: number;
  refunds: number;
  netRetail: number;
  sellers: number;
}

export interface RankingOptions {
  search?: string;
  sortKey?: RankingSortKey;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  all?: boolean;
}

export interface RankedResult {
  rows: RankingRow[];
  totals: RankingTotals;
  currency: string;
  mixedCurrencies: string[];
  droppedCurrencyOrders: number;
  totalRows: number;
  page: number;
  pageSize: number;
  sortKey: RankingSortKey;
  sortDir: "asc" | "desc";
  notes: string[];
}

const SORT_KEYS: RankingSortKey[] = [
  "netRetail",
  "retailSales",
  "wholesaleRevenue",
  "paidOrders",
  "unitsSold",
  "refunds",
];

const DEFAULT_PAGE_SIZE = 10;

function normalizeSortKey(key: string | undefined): RankingSortKey {
  return SORT_KEYS.includes(key as RankingSortKey) ? (key as RankingSortKey) : "netRetail";
}

function normalizeSortDir(dir: string | undefined): "asc" | "desc" {
  return dir === "asc" ? "asc" : "desc";
}

function num(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

interface RawRankingRow {
  sellerId: string;
  storeName: string;
  shopDomain: string;
  status: string;
  retailSales: number | bigint | null;
  wholesaleRevenue: number | bigint | null;
  paidOrders: number | bigint | null;
  unitsSold: number | bigint | null;
  refunds: number | bigint | null;
}

interface RawTotalsRow {
  retailSales: number | bigint | null;
  wholesaleRevenue: number | bigint | null;
  paidOrders: number | bigint | null;
  unitsSold: number | bigint | null;
  sellers: number | bigint | null;
}

const SORT_EXPRESSIONS: Record<RankingSortKey, Prisma.Sql> = {
  netRetail: Prisma.sql`(COALESCE(st."retailSales", 0) - COALESCE(rf.refunds, 0))`,
  retailSales: Prisma.sql`COALESCE(st."retailSales", 0)`,
  wholesaleRevenue: Prisma.sql`COALESCE(st."wholesaleRevenue", 0)`,
  paidOrders: Prisma.sql`COALESCE(st."paidOrders", 0)`,
  unitsSold: Prisma.sql`COALESCE(st."unitsSold", 0)`,
  refunds: Prisma.sql`COALESCE(rf.refunds, 0)`,
};

export async function computeRankings(
  from: Date,
  to: Date,
  currency = "CAD",
  options: RankingOptions = {}
): Promise<RankedResult> {
  const search = (options.search ?? "").trim();
  const sortKey = normalizeSortKey(options.sortKey);
  const sortDir = normalizeSortDir(options.sortDir);
  const pageSize = options.all ? 0 : Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
  const page = options.all ? 1 : Math.max(1, options.page ?? 1);

  // Every camelCase identifier below is double-quoted, and it has to be.
  // PostgreSQL folds an unquoted identifier to lower case, so `o.sellerId` is
  // read as `o.sellerid` and the query dies with 42703 ("column does not
  // exist"). Prisma creates these columns quoted and camelCase, so the quotes
  // are not optional here — the same applies to the aliases, because Prisma
  // returns the result-set column names verbatim and the mapping code below
  // reads `row.sellerId`, not `row.sellerid`.
  /**
   * WHICH SELLERS COUNT, AND WHY BLOCKED IS ON THE LIST.
   *
   * These three statuses are the ones whose orders are real. A seller that was
   * never approved has no orders to count; a blocked one has plenty, and they
   * are orders MoonVella accepted, fulfilled and invoiced. Excluding them would
   * not punish the seller — it would quietly shrink MoonVella's reported
   * wholesale revenue the moment an administrative action was taken, which is
   * a number the business makes decisions from. Blocking stops a store from
   * doing new business; it does not unmake what it already did, and the totals
   * query below is not even broken down by seller.
   */
  const qualifyingOrderWhere = Prisma.sql`
    o.currency = ${currency}
    AND o."shopifyCreatedAt" >= ${from}
    AND o."shopifyCreatedAt" <= ${to}
    AND o."cancelledAt" IS NULL
    AND o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')
    AND UPPER(o."shopifyOrderName") NOT LIKE 'TEST%'
    AND s."shopDomain" NOT LIKE '%test.myshopify.com'
  `;

  const statsSubquery = Prisma.sql`
    SELECT
      o."sellerId" AS "sellerId",
      SUM(CASE WHEN oi."isMoonvellaProduct" THEN oi.price * oi.quantity ELSE 0 END) AS "retailSales",
      SUM(CASE WHEN oi."isMoonvellaProduct" THEN oi."wholesalePrice" * oi.quantity ELSE 0 END) AS "wholesaleRevenue",
      SUM(CASE WHEN oi."isMoonvellaProduct" THEN oi.quantity ELSE 0 END) AS "unitsSold",
      COUNT(DISTINCT CASE WHEN oi."isMoonvellaProduct" THEN o.id END) AS "paidOrders"
    FROM "Order" o
    JOIN "OrderItem" oi ON oi."orderId" = o.id
    JOIN "Seller" s ON s.id = o."sellerId"
    WHERE ${qualifyingOrderWhere}
      AND s.status IN ('APPROVED', 'SUSPENDED', 'BLOCKED')
    GROUP BY o."sellerId"
  `;

  const refundsSubquery = Prisma.sql`
    SELECT o."sellerId" AS "sellerId", SUM(r.amount) AS refunds
    FROM "Refund" r
    JOIN "Order" o ON o.id = r."orderId"
    JOIN "Seller" s ON s.id = o."sellerId"
    WHERE r."processedAt" >= ${from}
      AND r."processedAt" <= ${to}
      AND o.currency = ${currency}
      AND s.status IN ('APPROVED', 'SUSPENDED', 'BLOCKED')
    GROUP BY o."sellerId"
  `;

  const like = `%${search.toLowerCase()}%`;
  const searchClause = search
    ? Prisma.sql`AND (LOWER(s."storeName") LIKE ${like} OR LOWER(s."shopDomain") LIKE ${like})`
    : Prisma.empty;
  const limitClause =
    pageSize > 0
      ? Prisma.sql`LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
      : Prisma.empty;
  const dirSql = Prisma.raw(sortDir === "asc" ? "ASC" : "DESC");

  const rowsQuery = Prisma.sql`
    SELECT
      s.id AS "sellerId",
      s."storeName" AS "storeName",
      s."shopDomain" AS "shopDomain",
      s.status AS status,
      COALESCE(st."retailSales", 0) AS "retailSales",
      COALESCE(st."wholesaleRevenue", 0) AS "wholesaleRevenue",
      COALESCE(st."paidOrders", 0) AS "paidOrders",
      COALESCE(st."unitsSold", 0) AS "unitsSold",
      COALESCE(rf.refunds, 0) AS refunds
    FROM "Seller" s
    LEFT JOIN (${statsSubquery}) st ON st."sellerId" = s.id
    LEFT JOIN (${refundsSubquery}) rf ON rf."sellerId" = s.id
    WHERE s.status IN ('APPROVED', 'SUSPENDED', 'BLOCKED')
      ${searchClause}
    ORDER BY ${SORT_EXPRESSIONS[sortKey]} ${dirSql}, s."storeName" ASC
    ${limitClause}
  `;

  const countQuery = Prisma.sql`
    SELECT COUNT(*) AS count
    FROM "Seller" s
    WHERE s.status IN ('APPROVED', 'SUSPENDED', 'BLOCKED')
      ${searchClause}
  `;

  const totalsQuery = Prisma.sql`
    SELECT
      COALESCE(SUM(CASE WHEN oi."isMoonvellaProduct" THEN oi.price * oi.quantity ELSE 0 END), 0) AS "retailSales",
      COALESCE(SUM(CASE WHEN oi."isMoonvellaProduct" THEN oi."wholesalePrice" * oi.quantity ELSE 0 END), 0) AS "wholesaleRevenue",
      COALESCE(SUM(CASE WHEN oi."isMoonvellaProduct" THEN oi.quantity ELSE 0 END), 0) AS "unitsSold",
      COUNT(DISTINCT CASE WHEN oi."isMoonvellaProduct" THEN o.id END) AS "paidOrders",
      COUNT(DISTINCT CASE WHEN oi."isMoonvellaProduct" THEN o."sellerId" END) AS sellers
    FROM "Order" o
    JOIN "OrderItem" oi ON oi."orderId" = o.id
    JOIN "Seller" s ON s.id = o."sellerId"
    WHERE ${qualifyingOrderWhere}
      AND s.status IN ('APPROVED', 'SUSPENDED', 'BLOCKED')
  `;

  const refundsTotalQuery = Prisma.sql`
    SELECT COALESCE(SUM(r.amount), 0) AS refunds
    FROM "Refund" r
    JOIN "Order" o ON o.id = r."orderId"
    JOIN "Seller" s ON s.id = o."sellerId"
    WHERE r."processedAt" >= ${from}
      AND r."processedAt" <= ${to}
      AND o.currency = ${currency}
      AND s.status IN ('APPROVED', 'SUSPENDED', 'BLOCKED')
  `;

  const droppedCurrenciesQuery = Prisma.sql`
    SELECT o.currency AS currency, COUNT(*) AS count
    FROM "Order" o
    JOIN "Seller" s ON s.id = o."sellerId"
    WHERE o.currency != ${currency}
      AND o."shopifyCreatedAt" >= ${from}
      AND o."shopifyCreatedAt" <= ${to}
      AND o."cancelledAt" IS NULL
      AND o."paymentStatus" IN ('PAID', 'PARTIALLY_REFUNDED')
      AND UPPER(o."shopifyOrderName") NOT LIKE 'TEST%'
      AND s."shopDomain" NOT LIKE '%test.myshopify.com'
    GROUP BY o.currency
  `;

  const [pageRows, countRows, totalsRows, refundsTotalRows, droppedRows] = await Promise.all([
    prisma.$queryRaw<RawRankingRow[]>(rowsQuery),
    prisma.$queryRaw<{ count: number | bigint }[]>(countQuery),
    prisma.$queryRaw<RawTotalsRow[]>(totalsQuery),
    prisma.$queryRaw<{ refunds: number | bigint | null }[]>(refundsTotalQuery),
    prisma.$queryRaw<{ currency: string; count: number | bigint }[]>(droppedCurrenciesQuery),
  ]);

  const rows: RankingRow[] = pageRows.map((row) => {
    const retailSales = num(row.retailSales);
    const wholesaleRevenue = num(row.wholesaleRevenue);
    const paidOrders = num(row.paidOrders);
    const unitsSold = num(row.unitsSold);
    const refunds = num(row.refunds);
    return {
      sellerId: row.sellerId,
      storeName: row.storeName,
      shopDomain: row.shopDomain,
      status: row.status,
      retailSales,
      wholesaleRevenue,
      paidOrders,
      unitsSold,
      refunds,
      netRetail: retailSales - refunds,
      currency,
      hasHistory: paidOrders > 0,
    };
  });

  const totalRow = totalsRows[0];
  const refundsTotal = num(refundsTotalRows[0]?.refunds);
  const totals: RankingTotals = {
    retailSales: num(totalRow?.retailSales),
    wholesaleRevenue: num(totalRow?.wholesaleRevenue),
    paidOrders: num(totalRow?.paidOrders),
    unitsSold: num(totalRow?.unitsSold),
    refunds: refundsTotal,
    netRetail: num(totalRow?.retailSales) - refundsTotal,
    sellers: num(totalRow?.sellers),
  };

  const mixedCurrencies = droppedRows.map((row) => row.currency).sort();
  const droppedCurrencyOrders = droppedRows.reduce((sum, row) => sum + num(row.count), 0);

  const notes = [
    "Retail sales are MoonVella item retail values; wholesale revenue is MoonVella cost snapshots.",
    "Refunds are attributed to the period in which they were processed.",
    "Cancelled orders and clearly-labelled test orders (name starting with TEST) are excluded.",
  ];
  if (droppedCurrencyOrders > 0) {
    notes.push(
      `Mixed currencies present (${mixedCurrencies.join(", ")}); ${droppedCurrencyOrders} order(s) excluded from ${currency} totals.`
    );
  }

  return {
    rows,
    totals,
    currency,
    mixedCurrencies,
    droppedCurrencyOrders,
    totalRows: num(countRows[0]?.count),
    page,
    pageSize: pageSize > 0 ? pageSize : Math.max(1, num(countRows[0]?.count)),
    sortKey,
    sortDir,
    notes,
  };
}

export function toCsv(rows: RankingRow[], currency: string, notes: string[] = []): string {
  const header = [
    "seller",
    "shopDomain",
    "status",
    `retailSales_${currency}`,
    `wholesaleRevenue_${currency}`,
    "paidOrders",
    "unitsSold",
    `refunds_${currency}`,
    `netRetail_${currency}`,
  ];
  const lines = rows.map((r) =>
    [
      `"${r.storeName.replace(/"/g, '""')}"`,
      r.shopDomain,
      r.status,
      (r.retailSales / 100).toFixed(2),
      (r.wholesaleRevenue / 100).toFixed(2),
      r.paidOrders,
      r.unitsSold,
      (r.refunds / 100).toFixed(2),
      (r.netRetail / 100).toFixed(2),
    ].join(",")
  );
  const body = [header.join(","), ...lines].join("\n");
  if (notes.length === 0) return body;
  return `${body}\n\n${notes.map((note) => `# ${note}`).join("\n")}`;
}

export function resolvePeriod(searchParams: URLSearchParams): { from: Date; to: Date; label: string } {
  const now = new Date();
  const to = new Date(now);
  const preset = searchParams.get("period") || "30";

  if (preset === "custom") {
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const from = fromParam ? new Date(fromParam) : new Date(now.getTime() - 30 * 86400000);
    const toDate = toParam ? new Date(toParam) : now;
    toDate.setHours(23, 59, 59, 999);
    return { from, to: toDate, label: `${from.toISOString().slice(0, 10)} to ${toDate.toISOString().slice(0, 10)}` };
  }

  const days = preset === "90" ? 90 : 30;
  const from = new Date(now.getTime() - days * 86400000);
  return { from, to, label: `Last ${days} days` };
}
