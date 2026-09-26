import { prisma } from "~/db.server";
import { searchRead } from "~/services/odoo.server";

/**
 * What one Canadian dollar is worth in US dollars, for reading prices aloud.
 *
 * WHERE THE NUMBER COMES FROM, AND WHY IT IS NOT TYPED IN HERE. The seller's
 * USD view is a conversion of a Canadian price, so it is only worth showing if
 * the rate is a real one. Odoo already holds MoonVella's rate table —
 * `res.currency.rate`, one row per currency per day, maintained by whoever
 * maintains the books — and the connection to it is live and already used for
 * the catalogue. Reading it means the number on a seller's screen is the same
 * number the invoices are written at, and it changes when the rate changes
 * rather than when somebody remembers to edit a setting.
 *
 * A CONFIGURED RATE WOULD BE A SECOND TRUTH. There is deliberately no field for
 * this in the admin settings, even though it would have been easier: a number
 * that can be typed cannot be trusted, and the failure mode is silent — a stale
 * rate does not look wrong on screen, it just quietly misprices every product
 * for a seller pricing into the United States.
 *
 * A STALE RATE IS STILL SHOWN, LABELLED WITH ITS DATE. If Odoo cannot be
 * reached, the last rate this deployment successfully read is used and the page
 * prints the day it was true. That is the honest version of the trade: the
 * alternative is to hide the USD view at exactly the moment somebody is looking
 * at it, and the alternative before that — showing the cached number with no
 * date — presents yesterday's rate as today's.
 *
 * NOTHING HERE IS EVER WRITTEN BACK, and the read is a plain Odoo search: the
 * `searchRead` helper refuses non-read methods without a write permit, so this
 * module cannot become a writer by accident.
 */

/** Where the last successfully read rate is kept between deployments. */
export const USD_RATE_KEY = "usd_rate";
export const USD_RATE_AS_OF_KEY = "usd_rate_as_of";

/**
 * How long a rate is trusted before Odoo is asked again.
 *
 * Six hours, the same beat as the catalogue sync, because that is how often the
 * data underneath can move. Long enough that a page load is not an outbound
 * call in the common case; short enough that a rate change is on the seller's
 * screen the same working day.
 */
const RATE_TTL_MS = 6 * 60 * 60 * 1000;

export interface UsdRate {
  /** USD per 1 CAD. */
  rate: number;
  /** The day the rate was true, as Odoo records it (YYYY-MM-DD). */
  asOf: string | null;
}

/**
 * The process-lifetime cache, and why it is not the only copy.
 *
 * A page load must not wait on an XML-RPC round trip to Odoo, so a read that
 * succeeded recently is reused without asking. The database row underneath is
 * what survives a restart: without it, the first page load after every deploy
 * would block on Odoo, and a deploy during an Odoo outage would take the USD
 * view away until Odoo came back.
 */
let cached: { value: UsdRate; readAt: number } | null = null;

/**
 * The rate to print, or null when there is none to print honestly.
 *
 * Null is a real answer and the interface acts on it: with no rate, the USD
 * option is not offered at all, rather than offered and silently ignored. It
 * happens when Odoo is unreachable AND this deployment has never read a rate —
 * a fresh install whose first page load coincided with an Odoo outage.
 */
export async function currentUsdRate(now: Date = new Date()): Promise<UsdRate | null> {
  if (cached && now.getTime() - cached.readAt < RATE_TTL_MS) return cached.value;

  const fromOdoo = await readRateFromOdoo();
  if (fromOdoo) {
    cached = { value: fromOdoo, readAt: now.getTime() };
    await persist(fromOdoo);
    return fromOdoo;
  }

  const stored = await readStoredRate();
  if (stored) {
    // Cached in memory too, so an Odoo outage does not mean a database read and
    // a failed outbound call on every page of every seller.
    cached = { value: stored, readAt: now.getTime() };
    return stored;
  }

  return null;
}

/**
 * Ask Odoo for the newest USD rate.
 *
 * The newest row, ordered by date, because the rate table is a history: reading
 * without an order would return whichever rows the database felt like, which
 * for a table that gains a row per currency per day is a rate from an arbitrary
 * day in the past.
 *
 * A rate that is not a positive finite number is discarded rather than
 * returned: a zero would divide a product's price to nothing and a negative
 * would invert it, and both would look like a price on the page.
 */
async function readRateFromOdoo(): Promise<UsdRate | null> {
  try {
    const rows = await searchRead<{ id: number; name: string; rate: number }>(
      "res.currency.rate",
      [["currency_id.name", "=", "USD"]],
      ["id", "name", "rate"],
      { limit: 1, order: "name desc" },
    );

    const row = rows[0];
    if (!row || typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0) {
      return null;
    }

    return { rate: row.rate, asOf: typeof row.name === "string" ? row.name : null };
  } catch {
    /*
     * Deliberately swallowed. This runs on a page that has already loaded its
     * own data, for a display preference: an Odoo outage must not turn a
     * seller's catalogue into an error page. The caller falls back to the last
     * known rate, and the page says which day that was.
     */
    return null;
  }
}

function parseStoredRate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readStoredRate(): Promise<UsdRate | null> {
  try {
    const rows = await prisma.adminPreference.findMany({
      where: { key: { in: [USD_RATE_KEY, USD_RATE_AS_OF_KEY] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    const rate = parseStoredRate(byKey.get(USD_RATE_KEY));
    if (rate === null) return null;
    return { rate, asOf: byKey.get(USD_RATE_AS_OF_KEY) ?? null };
  } catch {
    return null;
  }
}

/**
 * Keep the rate for the next process, and for a page that has to print the date
 * it was true.
 *
 * Written as two preferences rather than one JSON blob so a person reading the
 * table sees a rate and a date rather than an opaque string. A write failure is
 * swallowed for the same reason the read failure is: this is a cache, the
 * answer has already been returned, and failing the page over it would be a
 * worse outcome than re-reading Odoo after the next restart.
 */
async function persist(value: UsdRate): Promise<void> {
  const rounded = value.rate.toFixed(6);
  try {
    for (const [key, entry] of [
      [USD_RATE_KEY, rounded],
      [USD_RATE_AS_OF_KEY, value.asOf ?? ""],
    ] as const) {
      await prisma.adminPreference.upsert({
        where: { key },
        create: { key, value: entry },
        update: { value: entry },
      });
    }
  } catch {
    /* see the note above */
  }
}

/** Test seam: forget the in-process copy so the next call reads again. */
export function resetUsdRateCache(): void {
  cached = null;
}
