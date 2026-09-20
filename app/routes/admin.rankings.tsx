import { Link, useLoaderData, Form } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerRole } from "~/utils/ownerAuth.server";
import {
  computeRankings,
  resolvePeriod,
  type RankingSortKey,
} from "~/services/rankings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerRole(request, ["OWNER", "OPERATIONS", "REVIEWER", "READONLY"]);
  const url = new URL(request.url);
  const { from, to, label } = resolvePeriod(url.searchParams);

  const search = url.searchParams.get("q") || "";
  const sortKey = url.searchParams.get("sort") || "netRetail";
  const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = 10;

  const result = await computeRankings(from, to, "CAD", {
    search,
    sortKey: sortKey as RankingSortKey,
    sortDir: dir,
    page,
    pageSize,
  });

  return {
    label,
    period: url.searchParams.get("period") || "30",
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    rows: result.rows,
    totals: result.totals,
    notes: result.notes,
    currency: result.currency,
    mixedCurrencies: result.mixedCurrencies,
    droppedCurrencyOrders: result.droppedCurrencyOrders,
    totalRows: result.totalRows,
    page: result.page,
    pageSize: result.pageSize,
    sortKey: result.sortKey,
    dir: result.sortDir,
    search,
  };
}

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const th: React.CSSProperties = { textAlign: "right", padding: "0.5rem", fontSize: "0.7rem", color: "#64748b" };
const td: React.CSSProperties = { textAlign: "right", padding: "0.5rem", fontSize: "0.82rem" };

export default function AdminRankings() {
  const data = useLoaderData<typeof loader>();
  const totalPages = Math.max(1, Math.ceil(data.totalRows / data.pageSize));
  const qs = (overrides: Record<string, string>) => {
    const params = new URLSearchParams({
      period: data.period,
      from: data.from,
      to: data.to,
      sort: data.sortKey,
      dir: data.dir,
      q: data.search,
    });
    for (const [k, v] of Object.entries(overrides)) params.set(k, v);
    return `?${params.toString()}`;
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Seller Rankings
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        Net MoonVella retail sales, {data.label} · currency {data.currency}
      </p>

      {data.droppedCurrencyOrders > 0 && (
        <div
          style={{
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            borderRadius: 8,
            padding: "0.6rem 0.8rem",
            fontSize: "0.75rem",
            color: "#92400e",
            marginBottom: "1rem",
          }}
        >
          {data.droppedCurrencyOrders} paid order(s) in {data.mixedCurrencies.join(", ")} were excluded —
          rankings are {data.currency} only (no FX source).
        </div>
      )}

      <Form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
        <div>
          <label htmlFor="rankings-period" style={{ display: "block", fontSize: "0.7rem", color: "#64748b" }}>Period</label>
          <select id="rankings-period" name="period" defaultValue={data.period} style={inputStyle}>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        <div>
          <label htmlFor="rankings-from" style={{ display: "block", fontSize: "0.7rem", color: "#64748b" }}>From</label>
          <input id="rankings-from" type="date" name="from" defaultValue={data.from} style={inputStyle} />
        </div>
        <div>
          <label htmlFor="rankings-to" style={{ display: "block", fontSize: "0.7rem", color: "#64748b" }}>To</label>
          <input id="rankings-to" type="date" name="to" defaultValue={data.to} style={inputStyle} />
        </div>
        <div>
          <label htmlFor="rankings-q" style={{ display: "block", fontSize: "0.7rem", color: "#64748b" }}>Search seller</label>
          <input id="rankings-q" name="q" placeholder="store or domain" defaultValue={data.search} style={inputStyle} />
        </div>
        <button type="submit" style={btn("#082a4a")}>Apply</button>
        <a href={`/admin/rankings/csv${qs({})}`} style={{ ...btn("#0369a1"), textDecoration: "none" }}>
          Export CSV
        </a>      </Form>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem", marginBottom: "1.25rem" }}>
        <Summary label="Sellers with sales" value={String(data.totals.sellers)} />
        <Summary label="Paid orders" value={String(data.totals.paidOrders)} />
        <Summary label="Units sold" value={String(data.totals.unitsSold)} />
        <Summary label="MoonVella retail" value={money(data.totals.retailSales, data.currency)} />
        <Summary label="MoonVella wholesale" value={money(data.totals.wholesaleRevenue, data.currency)} />
        <Summary label="Refunds" value={money(data.totals.refunds, data.currency)} />
        <Summary label="Net retail" value={money(data.totals.netRetail, data.currency)} />
      </div>

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              <th style={{ ...th, textAlign: "left" }}>Seller</th>
              <SortHeader label="Net retail" k="netRetail" data={data} qs={qs} />
              <SortHeader label="Retail" k="retailSales" data={data} qs={qs} />
              <SortHeader label="Wholesale" k="wholesaleRevenue" data={data} qs={qs} />
              <SortHeader label="Orders" k="paidOrders" data={data} qs={qs} />
              <SortHeader label="Units" k="unitsSold" data={data} qs={qs} />
              <SortHeader label="Refunds" k="refunds" data={data} qs={qs} />
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>
                  No qualifying MoonVella sales in this period.
                </td>
              </tr>
            ) : (
              data.rows.map((r) => (
                <tr key={r.sellerId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "0.5rem", fontSize: "0.82rem" }}>
                    <Link to={`/admin/sellers/${r.sellerId}`} style={{ fontWeight: 600, color: "#082a4a" }}>
                      {r.storeName}
                    </Link>
                    <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{r.shopDomain}</div>
                  </td>
                  <td style={td}>{r.hasHistory ? money(r.netRetail, data.currency) : "No history"}</td>
                  <td style={td}>{money(r.retailSales, data.currency)}</td>
                  <td style={td}>{money(r.wholesaleRevenue, data.currency)}</td>
                  <td style={td}>{r.paidOrders}</td>
                  <td style={td}>{r.unitsSold}</td>
                  <td style={td}>{money(r.refunds, data.currency)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem", fontSize: "0.8rem" }}>
        <span style={{ color: "#64748b" }}>
          {data.totalRows} sellers · page {data.page} of {totalPages}
        </span>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {data.page > 1 && (
            <a href={qs({ page: String(data.page - 1) })} style={{ ...btn("#64748b"), textDecoration: "none" }}>
              Previous
            </a>
          )}
          {data.page < totalPages && (
            <a href={qs({ page: String(data.page + 1) })} style={{ ...btn("#64748b"), textDecoration: "none" }}>
              Next
            </a>
          )}
        </div>
      </div>

      <ul style={{ marginTop: "1.25rem", fontSize: "0.72rem", color: "#64748b" }}>
        {data.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.8rem",
};

function btn(color: string): React.CSSProperties {
  return {
    padding: "0.5rem 0.9rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: "white",
    color,
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.75rem" }}>
      <div style={{ fontSize: "0.68rem", color: "#64748b" }}>{label}</div>
      <div style={{ fontSize: "1rem", fontWeight: 700, color: "#082a4a" }}>{value}</div>
    </div>
  );
}

function SortHeader({
  label,
  k,
  data,
  qs,
}: {
  label: string;
  k: string;
  data: { sortKey: string; dir: string };
  qs: (o: Record<string, string>) => string;
}) {
  const active = data.sortKey === k;
  const nextDir = active && data.dir === "desc" ? "asc" : "desc";
  return (
    <th style={{ ...th, cursor: "pointer" }}>
      <a href={qs({ sort: k, dir: nextDir })} style={{ color: active ? "#082a4a" : "#64748b", textDecoration: "none" }}>
        {label}
        {active ? (data.dir === "desc" ? " \u25bc" : " \u25b2") : ""}
      </a>
    </th>
  );
}
