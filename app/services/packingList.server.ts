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

import { prisma } from "~/db.server";

export interface PackingListLine {
  name: string;
  sku: string;
  quantity: number;
  /** The ordered options at purchase, as sold — a packer picks the right one by these. */
  options: string | null;
}

export interface PackingList {
  shipmentId: string;
  reference: string;
  sellerId: string;
  brandName: string;
  brandColour: string;
  orderName: string;
  customerName: string;
  shipTo: string[];
  lines: PackingListLine[];
  packages: { count: number; length: number; width: number; height: number; weight: number }[];
  /** Parcels in this shipment, from the shipment itself rather than recounted. */
  packageCount: number;
  totalUnits: number;
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
      // The shipment's own parcel count, not the order's: an order can be split
      // across shipments, and the slip goes in one box.
      packageCount: true,
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
  return {
    shipmentId: shipment.id,
    reference: shipment.id.slice(0, 8),
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
    packages: shipment.order.packages,
    packageCount: shipment.packageCount || shipment.order.packages.reduce((sum, p) => sum + p.count, 0),
    totalUnits: shipment.items.reduce((sum, item) => sum + item.quantity, 0),
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
<title>Packing list ${escape(list.reference)} — ${escape(list.orderName)}</title>
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
      Shipment ${escape(list.reference)}<br />
      Packed ${new Date().toLocaleDateString()}
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
      <div style="color:#64748b">Fulfilled by MoonVella</div>
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

  <div class="note">
    This is a packing list. It is not a carrier document, not an invoice, and not a customs declaration, and it states no
    prices. Retail pricing is on the customer's receipt; carrier charges are on the carrier's own invoice.
  </div>
</body>
</html>`;
}
