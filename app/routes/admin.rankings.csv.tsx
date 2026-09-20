import type { LoaderFunctionArgs } from "react-router";
import { requireOwnerRole } from "~/utils/ownerAuth.server";
import {
  computeRankings,
  resolvePeriod,
  toCsv,
  type RankingSortKey,
} from "~/services/rankings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerRole(request, ["OWNER", "OPERATIONS", "REVIEWER", "READONLY"]);
  const url = new URL(request.url);
  const { from, to } = resolvePeriod(url.searchParams);

  const search = url.searchParams.get("q") || "";
  const sortKey = url.searchParams.get("sort") || "netRetail";
  const sortDir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
  const result = await computeRankings(from, to, "CAD", {
    search,
    sortKey: sortKey as RankingSortKey,
    sortDir,
    all: true,
  });

  return new Response(toCsv(result.rows, result.currency, result.notes), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="moonvella-rankings-${from
        .toISOString()
        .slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`,
    },
  });
}
