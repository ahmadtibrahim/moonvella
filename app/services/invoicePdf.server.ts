/**
 * The invoice and statement, as PDFs.
 *
 * WHY PDFKIT AND NOT A BROWSER. The packing slip already renders this way, and
 * the reason holds here: it runs in the process, draws with the standard fonts
 * that ship inside the package, and makes no network call — so a document a
 * customer keeps is produced without a headless browser in the image and without
 * an external document service seeing MoonVella's billing. PDFKit embeds an
 * image by being handed a Buffer, which is why branding is stored as bytes
 * through the storage backend rather than as a URL a renderer cannot fetch.
 *
 * WHAT IS BRANDED AND WHAT IS NOT. The invoice is MoonVella's document — it is
 * the operator's own bill for goods the operator sold — so it carries MoonVella's
 * logo and name. The packing slip is the SELLER's document and carries the
 * seller's brand kit instead; the two are separate on purpose and the work order
 * is explicit that merchant identity and MoonVella identity are not merged.
 *
 * THE WHOLESALE COST IS NOT ON THIS DOCUMENT. An invoice to a seller shows what
 * the seller is charged. The supplier's cost of those goods is MoonVella's
 * business and appears nowhere a seller can read it — the same rule the packing
 * slip follows.
 *
 * NOTHING HERE SENDS ANYTHING. Rendering a PDF is not sending it: the work order
 * forbids treating a preview or a download as authorisation to email a customer.
 */

import PDFDocument from "pdfkit";
import type { Invoice, InvoiceLine } from "@prisma/client";
import { brandImageFor, getDisplayName } from "./branding.server";
// Re-exported so the PDF's own callers keep working; the definition lives in a
// client-safe module because routes render it in table cells.
import { money } from "~/utils/money";

export { money };

export interface InvoiceDocumentInput {
  invoice: Invoice;
  lines: InvoiceLine[];
  position: { paid: number; credited: number; balance: number; status: string; overdue: boolean };
  /** True for a statement rather than an invoice. */
  kind: "invoice" | "statement";
  /** Extra rows, for a statement's ledger. */
  statementLines?: {
    date: Date;
    kind: string;
    reference: string;
    description: string;
    debit: number;
    credit: number;
    balance: number;
  }[];
  statementTotals?: {
    openingBalance: number;
    closingBalance: number;
    periodInvoiced: number;
    periodPaid: number;
    periodCredited: number;
    periodFrom: Date | null;
    periodTo: Date;
  };
  brandColour?: string;
}


function isoDate(value: Date | null | undefined): string {
  if (!value) return "—";
  // Formatted in UTC from the parts, never through `toLocaleDateString`: a
  // server in one zone and a reader in another must not see different days on a
  // document with a due date on it.
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, "0");
  const d = String(value.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function renderInvoicePdf(input: InvoiceDocumentInput): Promise<Buffer> {
  const brandColour = input.brandColour ?? "#142440";
  const displayName = await getDisplayName();
  // Through the FALLBACK CHAIN — an empty invoice slot prints the primary logo
  // rather than a blank space in the header.
  const logo = await brandImageFor("INVOICE").catch(() => null);

  const title = input.kind === "invoice" ? "Invoice" : "Statement";

  const doc = new PDFDocument({
    size: "LETTER",
    margin: 54,
    info: {
      Title: `${title} ${input.kind === "invoice" ? input.invoice.number : ""}`.trim(),
      Creator: displayName,
      Producer: displayName,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // ---- header -------------------------------------------------------------
  if (logo) {
    try {
      // Bounded and scaled with `fit`, so a wide wordmark and a square mark both
      // keep their proportions. `fit` never stretches.
      doc.image(logo, left, doc.y, { fit: [170, 48] });
      doc.y += 56;
    } catch {
      // A corrupt stored image must not take the whole document down; the name
      // below still identifies the sender.
      doc.y += 4;
    }
  }
  doc.fontSize(20).fillColor(brandColour).text(displayName, left, doc.y);
  doc.moveDown(0.8);

  const headerTop = doc.y;
  doc.fontSize(16).fillColor("#172B4D").text(title, left, headerTop, { width, align: "right" });

  if (input.kind === "invoice") {
    const meta = [
      `Number ${input.invoice.number}`,
      `Issued ${isoDate(input.invoice.issuedAt)}`,
      `Due ${isoDate(input.invoice.dueDate)}`,
      `Status ${input.position.status.replace(/_/g, " ").toLowerCase()}`,
    ];
    doc.fontSize(9).fillColor("#52627A");
    let y = headerTop + 22;
    for (const row of meta) {
      doc.text(row, left, y, { width, align: "right" });
      y += 12;
    }
    doc.y = Math.max(doc.y, y) + 10;
  } else if (input.statementTotals) {
    const totals = input.statementTotals;
    doc.fontSize(9).fillColor("#52627A");
    let y = headerTop + 22;
    for (const row of [
      `Period ${isoDate(totals.periodFrom)} to ${isoDate(totals.periodTo)}`,
      `Opening balance ${money(totals.openingBalance, input.invoice.currency)}`,
      `Closing balance ${money(totals.closingBalance, input.invoice.currency)}`,
    ]) {
      doc.text(row, left, y, { width, align: "right" });
      y += 12;
    }
    doc.y = Math.max(doc.y, y) + 10;
  }

  // ---- bill to ------------------------------------------------------------
  const billTo = (input.invoice.billTo ?? {}) as {
    company?: string;
    contactName?: string | null;
    contactEmail?: string | null;
    phone?: string | null;
    addressLines?: string[];
    country?: string | null;
  };

  const boxTop = doc.y;
  doc.fontSize(8).fillColor("#52627A").text("BILL TO", left, boxTop);
  doc.fontSize(11).fillColor("#172B4D").text(billTo.company ?? "—", left, boxTop + 13);
  doc.fontSize(9).fillColor("#334155");
  const billLines = [
    billTo.contactName,
    ...(billTo.addressLines ?? []),
    billTo.country,
    billTo.contactEmail,
    billTo.phone,
  ].filter((line): line is string => Boolean(line && String(line).trim()));
  doc.text(billLines.join("\n"), left, boxTop + 29);
  doc.y = Math.max(doc.y, boxTop + 29 + billLines.length * 11) + 16;

  // ---- the ledger ---------------------------------------------------------
  const colX = { date: left, ref: left + 62, desc: left + 148, debit: right - 190, credit: right - 108, balance: right - 26 };
  const rowTop = doc.y;

  doc.fontSize(7).fillColor("#64748B");
  doc.text("DATE", colX.date, rowTop);
  doc.text("REFERENCE", colX.ref, rowTop);
  doc.text(input.kind === "invoice" ? "DESCRIPTION" : "DETAIL", colX.desc, rowTop);
  doc.text("DEBIT", colX.debit, rowTop, { width: 76, align: "right" });
  doc.text("CREDIT", colX.credit, rowTop, { width: 76, align: "right" });
  doc.text("BALANCE", colX.balance, rowTop, { width: 76, align: "right" });

  doc.moveTo(left, rowTop + 11).lineTo(right, rowTop + 11).strokeColor("#DCE3EB").stroke();
  let y = rowTop + 17;

  const row = (cells: [string, string, string, string, string, string]) => {
    if (y > doc.page.height - 140) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.fontSize(9).fillColor("#172B4D");
    doc.text(cells[0], colX.date, y, { width: 58 });
    doc.text(cells[1], colX.ref, y, { width: 82 });
    doc.text(cells[2], colX.desc, y, { width: colX.debit - colX.desc - 8 });
    doc.fillColor("#166534");
    doc.text(cells[3], colX.debit, y, { width: 76, align: "right" });
    doc.fillColor("#1D4ED8");
    doc.text(cells[4], colX.credit, y, { width: 76, align: "right" });
    doc.fillColor("#172B4D");
    doc.text(cells[5], colX.balance, y, { width: 76, align: "right" });
    y += 15;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor("#F1F5F9").stroke();
  };

  if (input.kind === "invoice") {
    for (const line of input.lines) {
      row([
        isoDate(input.invoice.issuedAt),
        line.sku ?? "—",
        `${line.description}${line.quantity !== 1 ? ` × ${line.quantity}` : ""}`,
        money(line.amount, input.invoice.currency),
        "",
        "",
      ]);
    }
  } else {
    for (const line of input.statementLines ?? []) {
      row([
        isoDate(line.date),
        line.reference,
        line.description,
        line.debit ? money(line.debit, input.invoice.currency) : "",
        line.credit ? money(line.credit, input.invoice.currency) : "",
        money(line.balance, input.invoice.currency),
      ]);
    }
  }

  // ---- the money, at the foot --------------------------------------------
  y += 8;
  const totalRow = (label: string, value: string, bold = false) => {
    doc.fontSize(bold ? 11 : 9).fillColor(bold ? "#172B4D" : "#334155");
    doc.text(label, colX.debit - 120, y, { width: 190, align: "right" });
    doc.text(value, colX.credit, y, { width: 152, align: "right" });
    y += bold ? 18 : 13;
  };

  if (input.kind === "invoice") {
    totalRow("Subtotal", money(input.invoice.subtotal, input.invoice.currency));
    if (input.invoice.adjustments !== 0) {
      totalRow("Adjustments", money(input.invoice.adjustments, input.invoice.currency));
    }
    // PRINTED ONLY WHEN THERE IS TAX. A zero-tax line is a statement about the
    // transaction — this document prints what was charged and invents no policy,
    // and a "Tax 0.00" row on every invoice would assert a tax treatment nobody
    // decided.
    if (input.invoice.taxTotal !== 0) {
      totalRow("Tax", money(input.invoice.taxTotal, input.invoice.currency));
    }
    totalRow("Total", money(input.invoice.total, input.invoice.currency), true);
    if (input.position.paid) totalRow("Payments applied", money(input.position.paid, input.invoice.currency));
    if (input.position.credited) totalRow("Credits applied", money(input.position.credited, input.invoice.currency));
    totalRow("Balance due", money(input.position.balance, input.invoice.currency), true);
    if (input.position.overdue) {
      doc.fontSize(9).fillColor("#B91C1C").text("This invoice is past its due date.", colX.debit - 120, y, {
        width: 342,
        align: "right",
      });
      y += 14;
    }
  } else if (input.statementTotals) {
    const totals = input.statementTotals;
    totalRow("Opening balance", money(totals.openingBalance, input.invoice.currency));
    totalRow("Invoiced in period", money(totals.periodInvoiced, input.invoice.currency));
    totalRow("Paid in period", money(totals.periodPaid, input.invoice.currency));
    if (totals.periodCredited) totalRow("Credited in period", money(totals.periodCredited, input.invoice.currency));
    totalRow("Closing balance", money(totals.closingBalance, input.invoice.currency), true);
  }

  doc.fontSize(8).fillColor("#64748B").text(
    "This document is generated by MoonVella and is not a tax invoice unless a tax number is shown above.",
    left,
    doc.page.height - doc.page.margins.bottom - 20,
    { width }
  );

  doc.end();
  return finished;
}
