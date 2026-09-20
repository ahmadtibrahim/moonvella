import { prisma } from "~/db.server";
import { setIntegrationState } from "./integrationHealth.server";

/**
 * Per-shop Shopify analytics for application review.
 *
 * - Sales/orders/refunds come from the Admin API `orders` query (paid orders).
 * - Sessions/visitors come from ShopifyQL (`FROM sessions`), which needs
 *   read_reports.
 * - Missing access or API errors are recorded per shop and surfaced as an
 *   accurate coverage state — never replaced with zero.
 *
 * Shopify order access covers ~60 days unless read_all_orders is approved, so a
 * 90-day request without that scope is labelled PARTIAL.
 */

export type Coverage = "FULL" | "PARTIAL" | "PERMISSION_REQUIRED" | "NOT_CONNECTED" | "ERROR";

export interface DailyPoint {
  date: string;
  sales: number; // cents
  orders: number;
}

export interface AnalyticsResult {
  shop: string;
  days: number;
  from: string;
  to: string;
  timezone: string;
  currency: string;
  coverage: Coverage;
  salesDefinition: string;
  sales: number | null;
  paidOrders: number | null;
  refunds: number | null;
  averageOrderValue: number | null;
  visitors: number | null;
  sessions: number | null;
  averageDailyVisitors: number | null;
  dailyTrend: DailyPoint[];
  grantedScopes: string[];
  lastSyncAt: string | null;
  notes: string[];
  error?: string;
}

async function getAdmin(shop: string) {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

async function getGrantedScopes(admin: {
  graphql: (q: string) => Promise<Response>;
}): Promise<string[]> {
  try {
    const res = await admin.graphql(
      `#graphql query { currentAppInstallation { accessScopes { handle } } }`
    );
    const json = await res.json();
    return (json?.data?.currentAppInstallation?.accessScopes ?? []).map(
      (s: { handle: string }) => s.handle
    );
  } catch {
    return [];
  }
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Granted scopes from the stored offline session (reliable fallback). */
async function scopesFromSession(shop: string): Promise<string[]> {
  const s = await prisma.session.findFirst({ where: { shop, isOnline: false }, select: { scope: true } });
  return (s?.scope ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function fetchOrderSales(
  admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
  from: string,
  to: string
) {
  const query = `created_at:>='${from}' created_at:<='${to}' financial_status:paid`;
  const res = await admin.graphql(
    `#graphql
      query MoonVellaSales($query: String) {
        orders(first: 250, query: $query, sortKey: CREATED_AT) {
          nodes {
            id
            createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            totalRefundedSet { shopMoney { amount } }
          }
        }
      }`,
    { variables: { query } }
  );
  const json = await res.json();
  if (Array.isArray(json?.errors) && json.errors.length) {
    throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
  }
  const nodes: {
    createdAt: string;
    totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
    totalRefundedSet?: { shopMoney?: { amount?: string } };
  }[] = json?.data?.orders?.nodes ?? [];

  let sales = 0;
  let refunds = 0;
  let currency = "CAD";
  const daily = new Map<string, DailyPoint>();
  for (const o of nodes) {
    const amount = Number(o.totalPriceSet?.shopMoney?.amount ?? 0);
    const refund = Number(o.totalRefundedSet?.shopMoney?.amount ?? 0);
    currency = o.totalPriceSet?.shopMoney?.currencyCode ?? currency;
    const cents = Math.round(amount * 100);
    sales += cents;
    refunds += Math.round(refund * 100);
    const date = o.createdAt.slice(0, 10);
    const point = daily.get(date) ?? { date, sales: 0, orders: 0 };
    point.sales += cents;
    point.orders += 1;
    daily.set(date, point);
  }
  return {
    sales,
    refunds,
    paidOrders: nodes.length,
    currency,
    dailyTrend: Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date)),
    truncated: nodes.length >= 250,
  };
}

interface ShopifyQLTable {
  columns?: { name: string }[];
  rows?: (string | number | null)[][];
}

async function fetchSessionTotals(
  admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
  from: string,
  to: string
): Promise<{ sessions: number | null; visitors: number | null }> {
  const res = await admin.graphql(
    `#graphql
      query MoonVellaSessions($q: String!) {
        shopifyqlQuery(query: $q) {
          parseErrors { code message }
          tableData { columns { name } rows }
        }
      }`,
    { variables: { q: `FROM sessions SHOW sessions, visitors SINCE ${from} UNTIL ${to}` } }
  );
  const json = await res.json();
  const parseErrors = json?.data?.shopifyqlQuery?.parseErrors ?? [];
  if (parseErrors.length) {
    throw new Error(parseErrors.map((e: { message: string }) => e.message).join("; "));
  }
  const table: ShopifyQLTable | undefined = json?.data?.shopifyqlQuery?.tableData;
  if (!table?.columns || !table?.rows) return { sessions: null, visitors: null };
  const colIndex = (name: string) => (table.columns ?? []).findIndex((c) => c.name === name);
  const sIdx = colIndex("sessions");
  const vIdx = colIndex("visitors");
  const row = table.rows[0] ?? [];
  return {
    sessions: sIdx >= 0 ? Number(row[sIdx]) : null,
    visitors: vIdx >= 0 ? Number(row[vIdx]) : null,
  };
}

/**
 * Daily visitor counts from ShopifyQL. Kept separate from the period totals so
 * the average daily figure is a true mean of daily values rather than a
 * period-unique count divided by days.
 */
async function fetchDailyVisitors(
  admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
  from: string,
  to: string
): Promise<number[]> {
  try {
    const res = await admin.graphql(
      `#graphql
        query MoonVellaSessionTrend($q: String!) {
          shopifyqlQuery(query: $q) {
            parseErrors { code message }
            tableData { columns { name } rows }
          }
        }`,
      { variables: { q: `FROM sessions SHOW visitors TIMESERIES day SINCE ${from} UNTIL ${to} ORDER BY day ASC` } }
    );
    const json = await res.json();
    const parseErrors = json?.data?.shopifyqlQuery?.parseErrors ?? [];
    if (parseErrors.length) return [];
    const table: ShopifyQLTable | undefined = json?.data?.shopifyqlQuery?.tableData;
    if (!table?.columns || !table?.rows) return [];
    const vIdx = table.columns.findIndex((c) => c.name === "visitors");
    if (vIdx < 0) return [];
    return table.rows
      .map((r) => Number(r[vIdx]))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

async function fetchSessionsAndVisitors(
  admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
  from: string,
  to: string
): Promise<{ sessions: number | null; visitors: number | null; dailyVisitors: number[] }> {
  try {
    const totals = await fetchSessionTotals(admin, from, to);
    const dailyVisitors = await fetchDailyVisitors(admin, from, to);
    return { ...totals, dailyVisitors };
  } catch {
    return { sessions: null, visitors: null, dailyVisitors: [] };
  }
}

export async function getShopAnalytics(shop: string, days: 30 | 90): Promise<AnalyticsResult> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const fromStr = isoDate(from);
  const toStr = isoDate(to);

  const base: AnalyticsResult = {
    shop,
    days,
    from: fromStr,
    to: toStr,
    timezone: "UTC",
    currency: "CAD",
    coverage: "NOT_CONNECTED",
    salesDefinition:
      "Sales = sum of totalPrice for Shopify orders created in the period with financial status 'paid'. Refunds = sum of totalRefunded on those orders.",
    sales: null,
    paidOrders: null,
    refunds: null,
    averageOrderValue: null,
    visitors: null,
    sessions: null,
    averageDailyVisitors: null,
    dailyTrend: [],
    grantedScopes: [],
    lastSyncAt: null,
    notes: [],
  };

  try {
    const admin = await getAdmin(shop);
    let scopes = await getGrantedScopes(admin);
    if (scopes.length === 0) {
      scopes = await scopesFromSession(shop);
      if (scopes.length) {
        base.notes.push(
          "Granted scopes were read from the stored offline session (the scope API query returned none)."
        );
      }
    }
    base.grantedScopes = scopes;
    const canReadOrders = scopes.includes("read_orders") || scopes.includes("write_orders") || scopes.includes("read_all_orders");
    const canReadReports = scopes.includes("read_reports") || scopes.includes("write_reports");

    if (!canReadOrders) {
      base.coverage = "PERMISSION_REQUIRED";
      base.notes.push("Missing read_orders scope.");
    } else {
      const orderSales = await fetchOrderSales(admin, fromStr, toStr);
      base.sales = orderSales.sales;
      base.refunds = orderSales.refunds;
      base.paidOrders = orderSales.paidOrders;
      base.currency = orderSales.currency;
      base.dailyTrend = orderSales.dailyTrend;
      base.averageOrderValue = orderSales.paidOrders > 0 ? Math.round(orderSales.sales / orderSales.paidOrders) : null;
      base.coverage = "FULL";

      const hasAllOrders = scopes.includes("read_all_orders");
      if (days === 90 && !hasAllOrders) {
        base.coverage = "PARTIAL";
        base.notes.push(
          "90-day window requested without read_all_orders: Shopify only returns ~60 days of orders. Older days are excluded, not zero."
        );
      }
      if (orderSales.truncated) {
        base.coverage = "PARTIAL";
        base.notes.push("Order results were truncated at 250; values cover the most recent 250 paid orders.");
      }
    }

    if (canReadReports) {
      const sessions = await fetchSessionsAndVisitors(admin, fromStr, toStr);
      base.sessions = sessions.sessions;
      base.visitors = sessions.visitors;
      if (sessions.dailyVisitors.length > 0) {
        const total = sessions.dailyVisitors.reduce((sum, n) => sum + n, 0);
        base.averageDailyVisitors = Math.round(total / sessions.dailyVisitors.length);
        base.notes.push(
          `Average daily visitors = mean of ShopifyQL daily visitor counts across ${sessions.dailyVisitors.length} day(s) with data (not period-unique visitors ÷ days).`
        );
      } else if (sessions.visitors !== null) {
        base.coverage = base.coverage === "FULL" ? "PARTIAL" : base.coverage;
        base.notes.push(
          "ShopifyQL returned a period visitor total but no daily breakdown; average daily visitors is unavailable rather than estimated."
        );
      } else {
        base.coverage = base.coverage === "FULL" ? "PARTIAL" : base.coverage;
        base.notes.push("Sessions/visitors data was not returned by ShopifyQL (unavailable for this shop).");
      }
    } else {
      base.notes.push(
        "Missing read_reports scope: sessions/visitors unavailable. Grant read_reports and reauthorize to enable."
      );
      if (base.coverage === "FULL") base.coverage = "PARTIAL";
    }

    const lastSyncAt = new Date().toISOString();
    base.lastSyncAt = lastSyncAt;
    if (base.coverage === "FULL") base.coverage = "FULL";

    await prisma.analyticsSnapshot.upsert({
      where: { shop_source: { shop, source: `analytics_${days}` } },
      create: {
        shop,
        source: `analytics_${days}`,
        periodStart: from,
        periodEnd: to,
        coverage: base.coverage,
        metrics: JSON.stringify({
          sales: base.sales,
          paidOrders: base.paidOrders,
          refunds: base.refunds,
          averageOrderValue: base.averageOrderValue,
          visitors: base.visitors,
          sessions: base.sessions,
          averageDailyVisitors: base.averageDailyVisitors,
          dailyTrend: base.dailyTrend,
        }),
        lastSyncAt: new Date(),
      },
      update: {
        periodStart: from,
        periodEnd: to,
        coverage: base.coverage,
        metrics: JSON.stringify({
          sales: base.sales,
          paidOrders: base.paidOrders,
          refunds: base.refunds,
          averageOrderValue: base.averageOrderValue,
          visitors: base.visitors,
          sessions: base.sessions,
          averageDailyVisitors: base.averageDailyVisitors,
          dailyTrend: base.dailyTrend,
        }),
        lastSyncAt: new Date(),
        errorMessage: null,
      },
    });

    await setIntegrationState("shopify_analytics", {
      status: (base.coverage as Coverage) === "ERROR" ? "FAILED" : "HEALTHY",
      detail: `Analytics for ${shop} (${days}d): coverage ${base.coverage}.`,
    });

    return base;
  } catch (error) {
    const message = error instanceof Error ? error.message : "analytics failed";
    base.coverage = "ERROR";
    base.error = message;
    base.notes.push(
      "Could not retrieve analytics. This may be an API error, a missing offline session, or a permissions issue."
    );
    await prisma.analyticsSnapshot.upsert({
      where: { shop_source: { shop, source: `analytics_${days}` } },
      create: { shop, source: `analytics_${days}`, coverage: "ERROR", metrics: "{}", errorMessage: message },
      update: { coverage: "ERROR", errorMessage: message },
    });
    await setIntegrationState("shopify_analytics", { status: "FAILED", error: message });
    return base;
  }
}
