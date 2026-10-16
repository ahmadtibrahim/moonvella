/**
 * The invoice, as a PDF.
 *
 * A RESOURCE ROUTE WITH A LOADER, NOT AN ACTION, and that distinction is the
 * whole reason this file exists separately from the page.
 *
 * The first version of this returned the PDF from the invoice page's `action` —
 * a POST that produced `Content-Disposition: attachment`. It rendered the
 * document correctly, wrote the bytes, and then answered **500**. React Router
 * treats an action's return value as DATA for the document it is about to
 * re-render, not as the response itself: the file was built, handed back, and
 * then consumed as if it were the page's data, and rendering the page against a
 * consumed stream threw. The service-level suite never saw it, because it calls
 * `renderInvoicePdf` directly — the defect lived entirely in how the route was
 * wired, which is the part a unit test cannot reach.
 *
 * So the PDF is fetched, not posted: a GET on a route with no component, whose
 * loader's Response IS the response. The page links to it, and the browser's own
 * download handling applies — no session token in a query string, no POST, and
 * no way for the router to mistake a document for page data.
 *
 * WHAT IT WILL NOT DO. It does not email anything, and it does not create or
 * change anything: rendering a document is not sending it, and opening one is
 * not authorisation to send one.
 */

import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { invoicePosition } from "~/services/invoicing.server";
import { renderInvoicePdf } from "~/services/invoicePdf.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  // Reads a financial document, so it needs the same permission the page does —
  // an unguessable id is a locator, not a permission.
  await requirePermission(request, "finance.view");
  const invoiceId = String(params.id);

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, allocations: true, credits: true },
  });
  if (!invoice) throw new Response("Not found", { status: 404 });

  const position = invoicePosition(invoice, invoice.allocations, invoice.credits);

  const pdf = await renderInvoicePdf({ invoice, lines: invoice.lines, position, kind: "invoice" });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // The number is generated from a sequence and matches [A-Z]+-\d{4}-\d{6},
      // but it is stated as a shape anyway: the filename must never be built from
      // anything a request supplied.
      "Content-Disposition": `attachment; filename="${invoice.number}.pdf"`,
      // A billing document must not sit in a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
