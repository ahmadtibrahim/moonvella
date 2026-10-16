/**
 * The customer's statement, as a PDF.
 *
 * A RESOURCE ROUTE WITH NO COMPONENT, so the response is the file and nothing
 * else. It is reached by a plain link, which means the browser's own download
 * handling applies and no session token has to be put in a query string where it
 * would end up in a history entry.
 *
 * TENANT-SCOPED ON THE SERVER. `requirePermission` gates it on `finance.view`
 * and the seller id comes from the path — which an operator may read for any
 * company, and which a merchant cannot reach at all because this is the owner
 * surface. The merchant's own view of its balance lives on `/app/billing`, where
 * the seller id comes from the session rather than from the request.
 *
 * NOTHING IS SENT. Generating a document is not sending it; the work order is
 * explicit that opening a preview or downloading a PDF is not authorisation to
 * email anybody, and nothing here does.
 */

import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { statementFor } from "~/services/statements.server";
import { renderInvoicePdf } from "~/services/invoicePdf.server";
import { prisma } from "~/db.server";

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requirePermission(request, "finance.view");
  const sellerId = String(params.id);
  const url = new URL(request.url);

  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to")) ?? new Date();

  const statement = await statementFor(sellerId, { from, to });

  /*
   * `renderInvoicePdf` takes an Invoice for its currency, number and bill-to
   * block. A statement has no invoice of its own, so this is a synthetic
   * envelope carrying the company and currency — built here rather than
   * widening the renderer's signature to a union, which would push the
   * difference into every branch inside it.
   */
  const envelope = {
    id: `statement:${sellerId}`,
    number: `Statement ${to.toISOString().slice(0, 10)}`,
    orderId: "",
    sellerId,
    status: "ISSUED" as const,
    currency: statement.currency,
    issuedAt: to,
    dueDate: null,
    voidedAt: null,
    voidReason: null,
    subtotal: statement.periodInvoiced,
    adjustments: 0,
    taxTotal: 0,
    total: statement.closingBalance,
    billTo: {
      company: statement.company,
      contactName: null,
      contactEmail: null,
      phone: null,
      addressLines: [],
      country: null,
    } as never,
    shipTo: null,
    createdById: null,
    createdAt: to,
    updatedAt: to,
  };

  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { contactEmail: true, contactName: true },
  });

  const pdf = await renderInvoicePdf({
    invoice: envelope,
    lines: [],
    position: { paid: statement.periodPaid, credited: statement.periodCredited, balance: statement.closingBalance, status: "ISSUED", overdue: false },
    kind: "statement",
    statementLines: statement.lines.map((line) => ({
      date: line.date,
      kind: line.kind,
      reference: line.reference,
      description: line.description,
      debit: line.debit,
      credit: line.credit,
      balance: line.balance,
    })),
    statementTotals: {
      openingBalance: statement.openingBalance,
      closingBalance: statement.closingBalance,
      periodInvoiced: statement.periodInvoiced,
      periodPaid: statement.periodPaid,
      periodCredited: statement.periodCredited,
      periodFrom: statement.from,
      periodTo: statement.to,
    },
  });

  // The file name is built from the company and the period, never from anything
  // a request supplied, so it cannot carry a path or a header.
  const safeCompany = statement.company.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "statement";
  const stamp = to.toISOString().slice(0, 10);

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeCompany}-statement-${stamp}.pdf"`,
      // A billing document must not be held in a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
