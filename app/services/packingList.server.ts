/**
 * The packing list — the document that goes in the box.
 *
 * TWO THINGS DEFINE IT, and both are about who ends up holding it. It carries
 * the seller's branding, because the seller is who the customer bought from and
 * the slip inside the carton is the seller's, not MoonVella's. And it carries
 * NO MONEY AT ALL — not the wholesale price, not the seller's shipping charge,
 * not the carrier cost, not the customer's item price. Every one of those is on
 * some other document; the point of this one is that a warehouse worker, a
 * customs officer or the customer can read it without learning what anybody
 * paid anybody.
 *
 * WHY THAT IS A PROPERTY OF THE QUERY, not of the template. The projection
 * below names the columns it wants, so a price column added to OrderItem later
 * cannot appear here by default — the failure mode this avoids is a template
 * that renders "the whole item" and quietly starts printing costs the day
 * somebody adds a field.
 *
 * The logo is deliberately absent. `SellerBrandKit.logoStorageKey` exists but
 * nothing writes it and no public URL serves it, so rendering an image here
 * would produce a broken link on a printed page — worse than a text brand. The
 * store name in the brand's colour is used instead.
 */

import PDFDocument from "pdfkit";
import { prisma } from "~/db.server";
import { DEFAULT_TIME_ZONE } from "~/services/holidays";
import { localDateIn } from "~/services/shippingLogic";

/**
 * The sentence both renderers end with, written once.
 *
 * It is on the document because a packing list found in a carton is the kind of
 * paper somebody tries to file as an invoice or present to a customs officer.
 * Two renderers meant two copies of it, and a copy that drifted would be one
 * that made a claim the other did not.
 */
const PACKING_LIST_NOTE =
  "This is a packing list. It is not a carrier document, not an invoice, and not a customs declaration, and it states " +
  "no prices. Retail pricing is on the customer's receipt; carrier charges are on the carrier's own invoice.";

export interface PackingListLine {
  name: string;
  sku: string;
  quantity: number;
  /** The ordered options at purchase, as sold — a packer picks the right one by these. */
  options: string | null;
}

export interface PackingList {
  /**
   * The shipment this list belongs to, for the route and for the scope check.
   *
   * There is deliberately no short "reference" to go with it. There was one —
   * `id.slice(0, 8)` — and it was printed in the header, in the `<title>` and in
   * the saved filename until §5 was read as a list of what may NOT appear: an
   * internal id on a page the customer receives names a row in our database, and
   * the filename travels home with them. A field nothing renders and everything
   * may reach for is how it comes back, so it is gone rather than unused.
   */
  shipmentId: string;
  sellerId: string;
  brandName: string;
  brandColour: string;
  orderName: string;
  customerName: string;
  shipTo: string[];
  lines: PackingListLine[];
  /**
   * An optional note the operator typed for this box, printed under the
   * contents. Null when there is none, which prints nothing at all — an empty
   * heading would be a piece of the document that says "there is nothing here".
   */
  message: string | null;
  packages: { count: number; length: number; width: number; height: number; weight: number }[];
  /** Parcels in this shipment, from the shipment itself rather than recounted. */
  packageCount: number;
  totalUnits: number;
  /**
   * The dock's calendar day the parcel was packed (YYYY-MM-DD), or null when no
   * packing has been recorded for it.
   */
  packedOn: string | null;
  /** The dock's calendar day this document was produced (YYYY-MM-DD). */
  preparedOn: string;
}

/**
 * The line under the order number: when the box was packed, or when this sheet
 * was prepared.
 *
 * THE TWO ARE NOT INTERCHANGEABLE. "Packed" is a claim about a warehouse step,
 * and printing it for a parcel whose packing has not been recorded is the
 * document asserting work nobody has done — the slip is printed before the box
 * is closed, which is exactly when it goes in. So a parcel with no `packedAt`
 * gets "Prepared", which says what is true of the paper in the reader's hand.
 *
 * ONE FUNCTION FOR BOTH RENDERERS, for the reason the footer sentence above is
 * written once: two copies of this choice drift, and the copy that drifts is
 * the one making a claim the other does not.
 */
export function packingStatusLine(list: Pick<PackingList, "packedOn" | "preparedOn">): string {
  return list.packedOn ? `Packed ${list.packedOn}` : `Prepared ${list.preparedOn}`;
}

/**
 * The zone the sheet's dates are read in: the dock's.
 *
 * The frozen pickup facts answer first for a booked parcel, then the location
 * row, then the company's own default. A box packed at 9pm in Vancouver must not
 * be dated tomorrow by a server whose clock is UTC, and a document whose date
 * depends on WHERE it was rendered is a document that cannot be checked.
 *
 * THE LAST FALLBACK IS THE COMPANY'S ZONE, NOT THE SERVER'S. A sheet printed
 * before the parcel is booked has no dock to ask — and it is printed exactly
 * then, which is why "Prepared" exists. Answering "UTC" would date every slip
 * drawn after 8pm Eastern with tomorrow, which is the same defect as reading the
 * renderer's locale, only quieter. An unconfigured dock is Toronto everywhere
 * else in this system (`DEFAULT_TIME_ZONE`), so it is Toronto here too.
 */
function dockTimeZone(originSnapshot: unknown, liveTimeZone: string | null): string {
  const snapshot = originSnapshot as { pickup?: { timeZone?: unknown } } | null;
  const frozen = snapshot && typeof snapshot === "object" ? snapshot.pickup?.timeZone : null;
  if (typeof frozen === "string" && frozen.trim()) return frozen.trim();
  if (liveTimeZone && liveTimeZone.trim()) return liveTimeZone.trim();
  return DEFAULT_TIME_ZONE;
}

/** The seller's brand colour, if they have set one. */
function brandColourOf(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "#082a4a";
  const colours = raw as Record<string, unknown>;
  for (const key of ["primary", "Primary", "brand", "main"]) {
    const value = colours[key];
    // Only a plain hex colour: this string is interpolated into a style
    // attribute, and a value from the brand kit is data, not code.
    if (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())) return value.trim();
  }
  return "#082a4a";
}

export function parseAddressLines(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    return [];
  }
  const street = [parsed.address1 || parsed.address, parsed.address2].filter(Boolean);
  const city = [parsed.city, parsed.province || parsed.provinceCode, parsed.zip || parsed.postalCode]
    .filter(Boolean)
    .join(", ");
  return [parsed.name, ...street, city, parsed.country || parsed.countryCode].filter(Boolean) as string[];
}

/**
 * Load one shipment as a packing list.
 *
 * `scope.sellerId` is applied to the QUERY, not to the result: a merchant
 * asking for another seller's shipment matches no row and gets nothing to leak,
 * which is the only version of this check that cannot be undone by a later
 * early return. The admin surface passes no scope and is gated by permission at
 * the route.
 */
export async function packingListFor(
  shipmentId: string,
  scope: { sellerId?: string } = {}
): Promise<PackingList | null> {
  const shipment = await prisma.shipment.findFirst({
    where: {
      id: shipmentId,
      ...(scope.sellerId ? { order: { sellerId: scope.sellerId } } : {}),
    },
    select: {
      id: true,
      createdAt: true,
      /*
       * When this parcel was packed, so the sheet can say "Packed" only about a
       * box somebody has actually packed. Null on a slip printed ahead of the
       * packing step, which is the ordinary case: the paper goes in the carton.
       */
      packedAt: true,
      // The dock's own calendar, for that date and for this document's. Read
      // from the frozen facts first, exactly as the pickup sweep reads them.
      originSnapshot: true,
      originLocation: { select: { timeZone: true } },
      // The shipment's own parcel count, not the order's: an order can be split
      // across shipments, and the slip goes in one box.
      packageCount: true,
      // This shipment's note, for the same reason: a split order has one slip
      // per box and each can say something different.
      packingSlipMessage: true,
      items: {
        select: {
          quantity: true,
          orderItem: {
            select: { name: true, sku: true, selectedOptions: true },
          },
        },
      },
      order: {
        select: {
          shopifyOrderName: true,
          customerName: true,
          shippingAddress: true,
          seller: {
            select: { id: true, storeName: true, brandKit: { select: { storeName: true, brandColours: true } } },
          },
          packages: {
            select: { count: true, length: true, width: true, height: true, weight: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });
  if (!shipment) return null;

  const brandKit = shipment.order.seller.brandKit;
  const zone = dockTimeZone(shipment.originSnapshot, shipment.originLocation?.timeZone ?? null);
  return {
    shipmentId: shipment.id,
    sellerId: shipment.order.seller.id,
    brandName: brandKit?.storeName?.trim() || shipment.order.seller.storeName,
    brandColour: brandColourOf(brandKit?.brandColours),
    orderName: shipment.order.shopifyOrderName,
    customerName: shipment.order.customerName || "",
    shipTo: parseAddressLines(shipment.order.shippingAddress),
    lines: shipment.items.map((item) => ({
      name: item.orderItem.name,
      sku: item.orderItem.sku,
      quantity: item.quantity,
      options: item.orderItem.selectedOptions,
    })),
    message: shipment.packingSlipMessage?.trim() || null,
    packages: shipment.order.packages,
    packageCount: shipment.packageCount || shipment.order.packages.reduce((sum, p) => sum + p.count, 0),
    totalUnits: shipment.items.reduce((sum, item) => sum + item.quantity, 0),
    packedOn: shipment.packedAt ? localDateIn(zone, shipment.packedAt) : null,
    // Resolved ONCE, on the object both renderers read, so the printable copy
    // and the downloadable PDF cannot name different days — and so neither
    // names the locale of whatever machine drew it.
    preparedOn: localDateIn(zone, new Date()),
  };
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The document itself: one printable page, no scripts, no external assets.
 *
 * WHAT IT MUST NOT CARRY, read as a list and checked against the output rather
 * than against this code. §5 forbids the wholesale price, the Stripe charge,
 * internal profit, supplier information and internal IDs. Two of those were on
 * this slip until it was read that way:
 *
 *   * "Shipment <first eight characters>" — this shipment's cuid, printed on a
 *     page that goes to a customer. An internal identifier, and one that names a
 *     row in our database.
 *   * "Fulfilled by MoonVella" — the supplier, named on the seller's own
 *     paperwork. The customer bought from the seller, the slip goes in the
 *     seller's box, and telling the recipient who else was involved discloses a
 *     wholesale relationship that is not ours to disclose.
 *
 * What remains is structural rather than editorial: this document is built from
 * `packingListFor`, which selects the seller's brand, the order name, the
 * shipping address and the ordered lines — and selects no money column at all.
 * A price cannot leak through a template that was never given one.
 *
 * Self-contained on purpose. A printed slip must render with the warehouse's
 * internet down, so there is no font to fetch and no stylesheet to load, and
 * the print rules are inline so "Print / Save as PDF" is the browser's own —
 * which is also why nothing here claims to be a carrier document. This is a
 * packing list, and the page says so.
 */
export function renderPackingList(list: PackingList): string {
  const options = (raw: string | null): string => {
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) =>
            typeof entry === "string"
              ? entry
              : `${(entry as Record<string, unknown>).name ?? ""}: ${(entry as Record<string, unknown>).value ?? ""}`
          )
          .filter(Boolean)
          .join(", ");
      }
      return "";
    } catch {
      return "";
    }
  };

  const rows = list.lines
    .map(
      (line, index) => `
      <tr>
        <td class="num">${index + 1}</td>
        <td>${escape(line.name)}${options(line.options) ? `<div class="opt">${escape(options(line.options))}</div>` : ""}</td>
        <td class="mono">${escape(line.sku)}</td>
        <td class="num qty">${line.quantity}</td>
      </tr>`
    )
    .join("");

  const parcelRows = list.packages
    .map(
      (pkg) => `
      <tr>
        <td class="num">${pkg.count}</td>
        <td>${pkg.length} × ${pkg.width} × ${pkg.height} cm</td>
        <td>${pkg.weight} kg</td>
        <td>${(pkg.weight * pkg.count).toFixed(3)} kg</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<!--
  The title names the ORDER, not the shipment. It is also the browser's default
  filename when this is saved as a PDF, so an internal id here would end up on
  the customer's own copy of the file.
-->
<title>Packing list — ${escape(list.orderName)}</title>
<style>
  :root { --brand: ${list.brandColour}; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 2rem; font-size: 13px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid var(--brand); padding-bottom: 0.75rem; }
  .brand { font-size: 1.4rem; font-weight: 700; color: var(--brand); }
  .doc { text-align: right; color: #64748b; }
  .doc strong { display: block; font-size: 1.05rem; color: #0f172a; }
  .grid { display: flex; gap: 2rem; margin: 1.25rem 0; }
  .grid > div { flex: 1; }
  h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; margin: 0 0 0.35rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th { text-align: left; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 1px solid #cbd5e1; padding: 0.35rem; }
  td { padding: 0.4rem 0.35rem; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .num { text-align: right; }
  .qty { font-weight: 700; font-size: 14px; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  .opt { color: #64748b; font-size: 11px; }
  .totals { margin-top: 0.75rem; text-align: right; font-weight: 600; }
  .msg { margin-top: 1.5rem; border: 1px solid #e2e8f0; border-left: 3px solid var(--brand); border-radius: 4px; padding: 0.6rem 0.75rem; }
  .note { margin-top: 1.5rem; border-top: 1px solid #e2e8f0; padding-top: 0.75rem; color: #64748b; font-size: 11px; }
  .toolbar { margin-bottom: 1.25rem; }
  .toolbar a, .toolbar button { font: inherit; padding: 0.4rem 0.75rem; border: 1px solid var(--brand); border-radius: 6px; background: white; color: var(--brand); font-weight: 600; cursor: pointer; text-decoration: none; margin-right: 0.4rem; }
  @media print {
    body { padding: 0; font-size: 12px; }
    .toolbar { display: none; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <a href="?download=1">Download HTML</a>
  </div>

  <div class="head">
    <div>
      <div class="brand">${escape(list.brandName)}</div>
      <div style="color:#64748b">Packing list</div>
    </div>
    <div class="doc">
      <strong>${escape(list.orderName)}</strong>
      ${escape(packingStatusLine(list))}
    </div>
  </div>

  <div class="grid">
    <div>
      <h2>Ship to</h2>
      <div>${list.shipTo.map((line) => escape(line)).join("<br />") || "—"}</div>
    </div>
    <div>
      <h2>Ship from</h2>
      <div>${escape(list.brandName)}</div>
    </div>
  </div>

  <h2>Contents</h2>
  <table>
    <thead>
      <tr><th class="num">#</th><th>Item</th><th>SKU</th><th class="num">Qty</th></tr>
    </thead>
    <tbody>${rows || `<tr><td colspan="4">No items recorded on this shipment.</td></tr>`}</tbody>
  </table>
  <div class="totals">${list.totalUnits} unit${list.totalUnits === 1 ? "" : "s"} in ${list.packageCount || 1} parcel(s)</div>

  ${
    parcelRows
      ? `<h2 style="margin-top:1.5rem">Parcels</h2>
  <table>
    <thead><tr><th class="num">Count</th><th>Dimensions</th><th>Gross weight</th><th>Total weight</th></tr></thead>
    <tbody>${parcelRows}</tbody>
  </table>`
      : ""
  }

  ${
    /*
     * The operator's own words, escaped, and nothing else. No signature, no
     * reference number and no generated sentence: §5 asks for an OPTIONAL
     * seller/customer message, and a template that filled the space when nobody
     * had anything to say would be the document inventing content.
     */
    list.message
      ? `<div class="msg"><h2>Message</h2><div>${escape(list.message).replace(/\n/g, "<br />")}</div></div>`
      : ""
  }

  <div class="note">${PACKING_LIST_NOTE}</div>

</body>
</html>`;
}

/**
 * The same document as a real file.
 *
 * WHY TWO RENDERERS AND NOT TWO FORMATS OF ONE. The two actions have different
 * jobs. PRINT opens a page the warehouse can read and send to a printer from
 * whatever machine is in front of them, and HTML does that with no dependency at
 * all — the print rules are inline so it works with the internet down. DOWNLOAD
 * produces a file that leaves this system and is opened somewhere else, possibly
 * on a machine that has never heard of this app, and §4 asks for a genuine PDF
 * with a .pdf name. Those are different requirements and they are met by
 * different code; the content is held identical by both reading the same
 * `PackingList` and by the checks in verify-booking that assert it of both.
 *
 * PDFKIT, AND WHY THAT LIBRARY. It runs here — no network call, no external
 * document service, no headless browser — and it draws with the standard 14
 * fonts, whose metrics ship inside the package, so nothing has to be uploaded or
 * licensed and the file is self-contained. Its dependencies are pure JavaScript
 * (fontkit, fflate, png-js), so it installs on the musl image the same way it
 * installs anywhere, with no native build step.
 */
export function renderPackingSlipPdf(list: PackingList): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margin: 54,
    // Named for what it is. This string is what a PDF reader shows in its title
    // bar and what a "Save as" dialog offers, and it is the customer's document,
    // so it names the order and never a row in our database.
    info: { Title: `Packing list — ${list.orderName}`, Creator: list.brandName, Producer: list.brandName },
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

  const options = (raw: string | null): string => {
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return "";
      return parsed
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : `${(entry as Record<string, unknown>).name ?? ""}: ${(entry as Record<string, unknown>).value ?? ""}`
        )
        .filter(Boolean)
        .join(", ");
    } catch {
      return "";
    }
  };

  /* --- the heading: the seller's brand, then what the sheet is ------------ */
  doc.font("Helvetica-Bold").fontSize(20).fillColor(list.brandColour).text(list.brandName, left, doc.y, { width: width * 0.6 });
  doc.font("Helvetica").fontSize(11).fillColor("#64748b").text("Packing list", { width: width * 0.6 });

  const headingBottom = doc.y;
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text(list.orderName, left, headingBottom - 34, {
    width,
    align: "right",
  });
  doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(packingStatusLine(list), {
    width,
    align: "right",
  });

  doc.moveTo(left, doc.y + 10).lineTo(right, doc.y + 10).lineWidth(2).strokeColor(list.brandColour).stroke();
  doc.y += 22;

  /* --- both ends ---------------------------------------------------------- */
  const halfWidth = (width - 24) / 2;
  const blockTop = doc.y;
  const sectionLabel = (text: string, x: number, y: number) => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b").text(text.toUpperCase(), x, y, { width: halfWidth });
  };

  sectionLabel("Ship to", left, blockTop);
  doc.font("Helvetica").fontSize(10).fillColor("#0f172a");
  const toLines = list.shipTo.length ? list.shipTo : ["—"];
  toLines.forEach((line, index) => {
    doc.text(line, left, blockTop + 14 + index * 13, { width: halfWidth });
  });

  sectionLabel("Ship from", left + halfWidth + 24, blockTop);
  doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(list.brandName, left + halfWidth + 24, blockTop + 14, {
    width: halfWidth,
  });

  doc.y = blockTop + 14 + toLines.length * 13 + 18;

  /* --- the contents ------------------------------------------------------- */
  const columns = [left, left + 24, right - 120, right - 58];
  const rowTop = () => doc.y;

  const header = (top: number) => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b");
    doc.text("CONTENTS", left, top);
    doc.y = top + 14;
  };
  header(doc.y);

  doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b");
  const columnHead = rowTop();
  doc.text("#", columns[0], columnHead, { width: 20, align: "right" });
  doc.text("ITEM", columns[1], columnHead, { width: columns[2] - columns[1] - 8 });
  doc.text("SKU", columns[2], columnHead, { width: columns[3] - columns[2] - 8 });
  doc.text("QTY", columns[3], columnHead, { width: right - columns[3], align: "right" });
  doc.y = columnHead + 12;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
  doc.y += 6;

  if (list.lines.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text("No items recorded on this shipment.", left, doc.y);
  }
  list.lines.forEach((line, index) => {
    const top = doc.y;
    const label = options(line.options);
    doc.font("Helvetica").fontSize(10).fillColor("#0f172a");
    doc.text(String(index + 1), columns[0], top, { width: 20, align: "right" });
    doc.text(line.name, columns[1], top, { width: columns[2] - columns[1] - 8 });
    const afterName = doc.y;
    if (label) {
      doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(label, columns[1], afterName, {
        width: columns[2] - columns[1] - 8,
      });
    }
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(line.sku, columns[2], top, {
      width: columns[3] - columns[2] - 8,
    });
    doc.font("Helvetica-Bold").fontSize(11).text(String(line.quantity), columns[3], top, {
      width: right - columns[3],
      align: "right",
    });
    doc.y = Math.max(doc.y, top + 13) + 5;
    doc.moveTo(left, doc.y - 3).lineTo(right, doc.y - 3).lineWidth(0.5).strokeColor("#e2e8f0").stroke();
  });

  doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text(
    `${list.totalUnits} unit${list.totalUnits === 1 ? "" : "s"} in ${list.packageCount || 1} parcel(s)`,
    left,
    doc.y + 4,
    { width, align: "right" }
  );
  doc.y += 16;

  /* --- the parcels -------------------------------------------------------- */
  if (list.packages.length > 0) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b").text("PARCELS", left, doc.y + 8);
    doc.y += 20;
    const parcelColumns = [left, left + 60, left + 220, right - 110];
    const head = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b");
    doc.text("COUNT", parcelColumns[0], head);
    doc.text("DIMENSIONS", parcelColumns[1], head);
    doc.text("GROSS WEIGHT", parcelColumns[2], head);
    doc.text("TOTAL WEIGHT", parcelColumns[3], head, { width: right - parcelColumns[3], align: "right" });
    doc.y = head + 12;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor("#cbd5e1").stroke();
    doc.y += 6;
    list.packages.forEach((pkg) => {
      const top = doc.y;
      doc.font("Helvetica").fontSize(10).fillColor("#0f172a");
      doc.text(String(pkg.count), parcelColumns[0], top);
      doc.text(`${pkg.length} × ${pkg.width} × ${pkg.height} cm`, parcelColumns[1], top);
      doc.text(`${pkg.weight} kg`, parcelColumns[2], top);
      doc.text(`${(pkg.weight * pkg.count).toFixed(3)} kg`, parcelColumns[3], top, {
        width: right - parcelColumns[3],
        align: "right",
      });
      doc.y = top + 18;
    });
  }

  /* --- the operator's own words, verbatim and only when there are some ---- */
  if (list.message) {
    doc.y += 12;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#64748b").text("MESSAGE", left, doc.y);
    doc.y += 12;
    doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(list.message, left, doc.y, { width });
  }

  /* --- and what the sheet is not ------------------------------------------ */
  doc.y += 22;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor("#e2e8f0").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(PACKING_LIST_NOTE, left, doc.y + 8, { width });

  doc.end();
  return finished;
}
