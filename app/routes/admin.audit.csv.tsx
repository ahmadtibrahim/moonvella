import type { LoaderFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { requireOwnerRole } from "~/utils/ownerAuth.server";
import { prisma } from "~/db.server";

function csvCell(value: string): string {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireOwnerRole(request, ["OWNER", "OPERATIONS", "READONLY", "REVIEWER"]);

  const url = new URL(request.url);
  const actor = url.searchParams.get("actor")?.trim() || "";
  const action = url.searchParams.get("action")?.trim() || "";
  const entityType = url.searchParams.get("entityType")?.trim() || "";
  const from = url.searchParams.get("from")?.trim() || "";
  const to = url.searchParams.get("to")?.trim() || "";

  const where: Prisma.AuditLogWhereInput = {};
  if (actor) where.OR = [{ actorId: { contains: actor } }, { actorName: { contains: actor } }];
  if (action) where.action = { contains: action };
  if (entityType) where.entityType = entityType;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const header = [
    "date",
    "actorType",
    "actorName",
    "actorId",
    "action",
    "entityType",
    "entityId",
    "ipAddress",
    "beforeData",
    "afterData",
  ];
  const lines = rows.map((r) =>
    [
      r.createdAt.toISOString(),
      r.actorType,
      r.actorName ?? "",
      r.actorId,
      r.action,
      r.entityType,
      r.entityId,
      r.ipAddress ?? "",
      r.beforeData ?? "",
      r.afterData ?? "",
    ]
      .map(csvCell)
      .join(",")
  );
  const csv = [header.join(","), ...lines].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="moonvella-audit-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
    },
  });
}
