/**
 * The `app/scopes_update` subscription: that it is declared, that something
 * keeps it there, and that the handler behind it does the one thing it is for.
 *
 * WHY THIS EXISTS. The topic has been declared in `shopify.app.toml` since
 * 2026-09-19, the config has been deployed repeatedly, and the store had NO
 * subscription to it. The declaration was published — the active release's
 * `app_access` module carries it — and the subscription was simply absent,
 * because the sync that turns one into the other created `app/uninstalled` and
 * `routing_complete` on that store and skipped this one. Nothing in the app
 * could notice: it was the only declared topic with no runtime backstop, so
 * there was no sweep to repair it and no row that said it was missing.
 *
 * WHAT THAT WOULD HAVE COST. The two fulfillment scopes are requested at
 * runtime, behind a button, and the approval comes back as this event. With no
 * subscription, the approval would land at Shopify and stop there: the
 * session's `scope` string would keep the old grant, and the app would go on
 * reporting the scopes as missing to a merchant who had just granted them.
 * A silent failure with a working-looking app on top of it, which is the same
 * shape as the failure the order topics were given their sweep for.
 *
 * WHAT IS REAL AND WHAT IS FAKED. Real: the route, the framework's HMAC
 * verification over the raw body, the header checks, the offline-session
 * lookup, the database, and the write. Faked: nothing about the delivery, and
 * nothing about the store — no request leaves this process. What it does NOT
 * prove is that Shopify will deliver, which no test in this repository can:
 * that is the live subscription, and it is checked against the store itself.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-webhook-scopes.ts
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { APP_WEBHOOK_PATH, APP_WEBHOOK_TOPICS } from "~/services/shopifyWebhooks.server";

const prisma = new PrismaClient();

let total = 0;
let failures = 0;
let skipped = 0;
let lastNumber = 0;

/**
 * The number comes FIRST, and that is not a style choice.
 *
 * An earlier suite in this repo declared `(name, pass, detail)` while all 31 of
 * its call sites passed four arguments — so the number became the name, the
 * sentence became the condition, and every check passed because a non-empty
 * string is truthy. Taking the number first makes that mistake a compile error
 * instead of a green run.
 */
function check(number: number, name: string, pass: boolean, detail: unknown = "") {
  total += 1;
  if (number <= lastNumber) {
    failures += 1;
    console.log(`FAIL  check #${number} is out of order — #${lastNumber} was already reported`);
    return;
  }
  lastNumber = number;
  if (!pass) failures += 1;
  const suffix = detail === "" || detail === undefined ? "" : ` — ${String(detail)}`;
  console.log(`${pass ? "PASS" : "FAIL"}  ${String(number).padStart(4)}. ${name}${suffix}`);
}

/**
 * A skipped check is counted, unlike in the suites that came before this one.
 *
 * They leave a skip out of the tally, so a run that skipped everything prints
 * "all 3 checks passed" — which reads as coverage and is the opposite of it.
 * The count here is not a pass and not a failure; it is printed next to the
 * total so that a green run can be told from a run that never happened.
 */
function skip(number: number, name: string, why: string) {
  skipped += 1;
  lastNumber = number;
  console.log(`SKIP  ${String(number).padStart(4)}. ${name} — ${why}`);
}

/**
 * Remove comments while leaving string literals intact.
 *
 * A character scanner rather than a pair of regexes, for the reason the
 * checkout-frame suite gives: most of what this file asserts is that some text
 * is ABSENT, and a stripper that ate real code would turn a defect into a PASS.
 * Strings are preserved deliberately — `"./shopifyWebhooks.server"` is a value
 * this suite has to be able to see.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SHOP = `mv-scopes-${suffix}.myshopify.com`;
const OTHER_SHOP = `mv-scopes-other-${suffix}.myshopify.com`;
const NO_SESSION_SHOP = `mv-scopes-nosession-${suffix}.myshopify.com`;

/** The scope set a store holds before the fulfillment approval, and after it. */
const BEFORE = ["read_orders", "write_products"];
const AFTER = ["write_products", "read_orders", "write_fulfillments", "write_locations"];
/** The same set as AFTER, in the form a second delivery would carry it. */
const AFTER_AGAIN = ["write_locations", "write_fulfillments", "write_products", "read_orders", "write_locations"];

const SECRET = process.env.SHOPIFY_API_SECRET || "";

let deliverySeq = 0;

/**
 * One delivery, signed the way Shopify signs them.
 *
 * The signature is over the raw body and nothing else — which is exactly why
 * the handler is not allowed to read the shop out of the payload. The shop is a
 * HEADER here, and the framework's verification is what decides which store a
 * delivery belongs to; the payload is only as trustworthy as the signature over
 * it, and that signature says nothing about a field naming a different store.
 */
async function deliver(
  shop: string,
  payload: unknown,
  options: { signed?: boolean } = {}
): Promise<Response | unknown> {
  const route = await import("../app/routes/webhooks.app.scopes_update.jsx");
  const body = JSON.stringify(payload);
  deliverySeq += 1;

  const request = new Request("https://app.moonvella.com/webhooks/app/scopes_update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": "app/scopes_update",
      "x-shopify-shop-domain": shop,
      // The library refuses a delivery that is missing any of the five it
      // requires, with a 400 rather than a 401 — so a suite that sent only the
      // signature would report a rejected delivery that was never checked.
      "x-shopify-api-version": "2026-10",
      "x-shopify-webhook-id": `mvverify-scopes-${suffix}-${deliverySeq}`,
      "x-shopify-hmac-sha256":
        options.signed === false
          ? "Zm9yZ2VkLXNpZ25hdHVyZQ=="
          : createHmac("sha256", SECRET).update(body, "utf8").digest("base64"),
    },
    body,
  });

  return route.action({ request } as never).catch((error: unknown) => error);
}

/** The status of a delivery, whether the route returned it or threw it. */
function statusOf(result: Response | unknown): number {
  return result instanceof Response ? result.status : 0;
}

/** The payload shape Shopify documents for this topic. */
function payloadFor(current: string[], previous: string[]) {
  return {
    id: 1,
    shop_id: "gid://shopify/Shop/548380009",
    previous,
    current,
    updated_at: new Date().toISOString(),
  };
}

/**
 * What a session row IS, written out rather than serialised whole.
 *
 * `JSON.stringify(row)` would throw on the BigInt `userId` column the moment a
 * fixture set it, and would silently start comparing a column added later. The
 * field list is the claim: a redelivery changes none of these.
 */
function snapshotOf(row: {
  id: string;
  shop: string;
  scope: string | null;
  isOnline: boolean;
  accessToken: string;
  expires: Date | null;
  refreshToken: string | null;
} | null): string {
  if (!row) return "(no session)";
  return JSON.stringify({
    id: row.id,
    shop: row.shop,
    scope: row.scope,
    isOnline: row.isOnline,
    accessToken: row.accessToken,
    expires: row.expires,
    refreshToken: row.refreshToken,
  });
}

function sessionFor(shop: string) {
  return prisma.session.findFirst({ where: { shop, isOnline: false } });
}

async function createSession(shop: string, scope: string[]) {
  return prisma.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "",
      isOnline: false,
      scope: scope.join(","),
      // Deliberately not a real token: no request leaves this process, and a
      // token that could work anywhere is a token worth not writing down.
      accessToken: "mvverify-not-a-real-token",
      expires: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
}

/**
 * Run one delivery with the console captured.
 *
 * Requirement: the handler logs the previous and the new scope set. Asserting
 * that a `console.log` exists in the file would pass on a line that is never
 * reached, so the assertion is made on what a real delivery actually printed.
 */
async function deliverCapturing<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  console.log = capture;
  console.warn = capture;
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

async function cleanup() {
  await prisma.session.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP, NO_SESSION_SHOP] } } });
}

async function main() {
  /* ====================================================================== */
  console.log("\n--- 1. the declaration and the address it is served at -----------");
  /* ====================================================================== */

  /*
   * The topic has two spellings and they are not the same spelling. The toml
   * says `app/scopes_update`, the GraphQL enum says `APP_SCOPES_UPDATE`, and a
   * subscription is created from the enum while a config sync reads the string
   * — so the two have to be checked as a pair rather than each on its own. It
   * is the same class of mismatch as the order id that travelled as a GID in
   * one place and a number in another, which failed silently for a day.
   */
  const toml = readFileSync(join(process.cwd(), "shopify.app.toml"), "utf8");
  const blocks = toml.split("[[webhooks.subscriptions]]").slice(1);
  const declared = blocks.filter((block) => block.includes("app/scopes_update"));

  check(
    1,
    "The app config declares app/scopes_update exactly once",
    declared.length === 1,
    `found in ${declared.length} of ${blocks.length} subscription block(s)`
  );

  const block = declared[0] ?? "";
  const uri = block.match(/^\s*uri\s*=\s*"([^"]*)"/m)?.[1] ?? "";
  /*
   * The `topics` array specifically, not every quoted string in the block. The
   * first version of this check matched all of them and read the `uri` in as a
   * topic — which failed, and would have gone on failing in a way that looked
   * like a declaration problem rather than a parser problem.
   */
  const topicList = block.match(/^\s*topics\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
  const topics = [...topicList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  check(
    2,
    "and points it at the route the app serves",
    uri === APP_WEBHOOK_PATH,
    `uri "${uri}" vs APP_WEBHOOK_PATH "${APP_WEBHOOK_PATH}"`
  );

  check(
    3,
    "the declared topic and the runtime topic are the same topic",
    topics.length === 1 &&
      APP_WEBHOOK_TOPICS.length === 1 &&
      topics[0].toUpperCase().replace(/\//g, "_") === APP_WEBHOOK_TOPICS[0],
    `toml "${topics.join(", ")}" vs runtime "${APP_WEBHOOK_TOPICS.join(", ")}"`
  );

  /*
   * The declaration is not the subscription. A config sync drops this topic on
   * this store, so the sweep is the thing that keeps it there — and a sweep
   * that defines the function without calling it is the same silence with more
   * code in it. A source assertion, deliberately: the property is "the
   * scheduled job reaches this", which is a statement about a call site, and
   * running the job for real would need a Seller, a session and an admin client
   * it builds itself.
   */
  const jobSource = stripComments(
    readFileSync(join(process.cwd(), "app", "services", "jobHandlers.server.ts"), "utf8")
  );
  check(
    4,
    "the scheduled sweep imports the app-level ensure",
    /import\s*\{[^}]*\bensureAppWebhookSubscriptions\b[^}]*\}\s*from\s*"\.\/shopifyWebhooks\.server"/.test(jobSource),
    "app/services/jobHandlers.server.ts"
  );
  // Exactly one, for the reason the fulfillment-scopes suite gives about the
  // scope request: a second call site is the beginning of "it is ensured from
  // somewhere nobody remembered", and a sweep is the one place it belongs.
  const appEnsureCalls = jobSource.match(/ensureAppWebhookSubscriptions\(\s*seller\.id\s*\)/g) ?? [];
  check(
    5,
    "and calls it once, for the store it is sweeping",
    appEnsureCalls.length === 1,
    `${appEnsureCalls.length} call site(s)`
  );

  /* ====================================================================== */
  console.log("\n--- 2. a signed delivery writes the scope set Shopify sent -------");
  /* ====================================================================== */

  await createSession(SHOP, BEFORE);
  await createSession(OTHER_SHOP, BEFORE);
  // NO_SESSION_SHOP deliberately gets no session: a store that uninstalled the
  // app leaves a Seller row behind, and a delivery can still arrive for it.

  if (!SECRET) {
    /*
     * Without the secret the route cannot verify anything, so every check below
     * would pass or fail for a reason that has nothing to do with the handler.
     * They are reported as skipped rather than omitted, because a run that
     * silently checked nothing is the failure this whole work order is about.
     */
    for (const [number, name] of [
      [6, "a valid signed delivery answers 200"],
      [7, "the offline session takes the scope set from the payload"],
      [8, "the stored set is normalised — sorted, deduped, comma-joined"],
      [9, "the delivery logs the previous and the new scope set"],
      [10, "a redelivery that differs only in order and duplicates changes nothing"],
      [11, "a delivery that changes the set again still writes"],
      [12, "an invalid HMAC is refused with 401"],
      [13, "and the forged delivery leaves the session untouched"],
      [14, "a delivery for one shop does not touch another shop's session"],
      [15, "a delivery carrying no scope list does not clear the stored scopes"],
      [16, "a delivery for a shop with no session answers 200 and writes nothing"],
    ] as const) {
      skip(number, name, "SHOPIFY_API_SECRET is not set, so the route cannot verify anything");
    }
    return;
  }

  const first = await deliverCapturing(() => deliver(SHOP, payloadFor(AFTER, BEFORE)));
  check(6, "a valid signed delivery answers 200", statusOf(first.result) === 200, `status ${statusOf(first.result)}`);

  const afterFirst = await sessionFor(SHOP);
  check(
    7,
    "the offline session takes the scope set from the payload",
    [...AFTER].sort().join(",") === (afterFirst?.scope ?? ""),
    `stored "${afterFirst?.scope ?? "(none)"}"`
  );

  /*
   * The stored form is asserted exactly, not as a set membership. Two shapes
   * meet in this handler — an array from the payload, a compressed string in
   * the column — and the comparison that makes a redelivery a no-op only works
   * if both are normalised the same way. A handler that wrote the payload's
   * order through would still pass a membership check and would write on every
   * delivery forever.
   */
  check(
    8,
    "the stored set is normalised — sorted, deduped, comma-joined",
    (afterFirst?.scope ?? "") === [...AFTER].sort().join(","),
    `"${afterFirst?.scope ?? "(none)"}"`
  );

  const changeLine = first.lines.find((line) => line.includes(BEFORE[1]) && line.includes("write_fulfillments"));
  check(
    9,
    "the delivery logs the previous and the new scope set",
    Boolean(changeLine),
    changeLine ? `"${changeLine}"` : `nothing logged mentioning both sets (${first.lines.length} line(s))`
  );

  /* ---------------------------------------------------------------------- */

  const beforeRepeat = snapshotOf(await sessionFor(SHOP));
  /*
   * The same event as Shopify would send it twice: at least once is the
   * delivery guarantee, and a retry after a slow answer carries the payload it
   * always carried. The second copy here is re-ordered and carries a duplicate,
   * so a handler that compared the raw string would find a difference and write
   * — which is the defect this check exists to catch.
   */
  const repeat = await deliverCapturing(() => deliver(SHOP, payloadFor(AFTER_AGAIN, BEFORE)));
  const afterRepeat = snapshotOf(await sessionFor(SHOP));

  check(
    10,
    "a redelivery that differs only in order and duplicates leaves the row identical",
    /*
     * The third clause is not decoration. A row that is unchanged because the
     * handler never processed the delivery is not idempotence, it is a handler
     * that returned early — and the log line is the only evidence from outside
     * that it got as far as deciding.
     */
    statusOf(repeat.result) === 200 && beforeRepeat === afterRepeat && repeat.lines.length > 0,
    statusOf(repeat.result) !== 200
      ? `status ${statusOf(repeat.result)}`
      : beforeRepeat !== afterRepeat
        ? `row changed to "${afterRepeat}"`
        : repeat.lines.length === 0
          ? "the handler logged nothing, so it may not have processed the delivery at all"
          : "row identical, delivery processed"
  );

  /*
   * And the no-op above is not a handler that never writes. A third delivery
   * that really does change the set has to land, or "unchanged" would be true
   * of a handler that did nothing at all.
   */
  const changed = await deliver(SHOP, payloadFor(BEFORE, AFTER));
  const afterChange = await sessionFor(SHOP);
  check(
    11,
    "a delivery that changes the set again still writes",
    statusOf(changed) === 200 && (afterChange?.scope ?? "") === [...BEFORE].sort().join(","),
    `stored "${afterChange?.scope ?? "(none)"}"`
  );

  /* ====================================================================== */
  console.log("\n--- 3. a forged delivery is refused and changes nothing ----------");
  /* ====================================================================== */

  const beforeForged = snapshotOf(await sessionFor(SHOP));
  const forged = await deliver(SHOP, payloadFor(AFTER, BEFORE), { signed: false });
  const afterForged = snapshotOf(await sessionFor(SHOP));

  check(12, "an invalid HMAC is refused with 401", statusOf(forged) === 401, `status ${statusOf(forged)}`);
  check(
    13,
    "and the forged delivery leaves the session untouched",
    beforeForged === afterForged,
    beforeForged === afterForged ? "" : `"${afterForged}"`
  );

  /* ====================================================================== */
  console.log("\n--- 4. a delivery writes one shop's session and no other ---------");
  /* ====================================================================== */

  /*
   * The property is not "the payload usually names the right shop". It is that
   * the row written is chosen by the domain the framework verified, so a
   * delivery for one store cannot reach another store's session even when the
   * payload says otherwise. Both are asserted below from the same delivery.
   */
  const beforeOther = snapshotOf(await sessionFor(SHOP));
  const other = await deliver(OTHER_SHOP, payloadFor(AFTER, BEFORE));
  const otherRow = await sessionFor(OTHER_SHOP);

  check(
    14,
    "a valid delivery updates the shop it was signed for, and only that shop",
    statusOf(other) === 200 &&
      (otherRow?.scope ?? "") === [...AFTER].sort().join(",") &&
      snapshotOf(await sessionFor(SHOP)) === beforeOther,
    `other "${otherRow?.scope ?? "(none)"}", this shop unchanged: ${snapshotOf(await sessionFor(SHOP)) === beforeOther}`
  );

  /* ====================================================================== */
  console.log("\n--- 5. the deliveries that must not do anything ------------------");
  /* ====================================================================== */

  /*
   * The stock template wrote `payload.current.toString()` unconditionally. On
   * a delivery with no `current` that stores the literal string "undefined",
   * which reads back as a scope list containing one scope named "undefined" —
   * worse than the stale list it replaced, and indistinguishable from a real
   * one by anything that reads the column.
   */
  const beforeEmpty = snapshotOf(await sessionFor(SHOP));
  const empty = await deliver(SHOP, { id: 1, shop_id: "gid://shopify/Shop/548380009", previous: BEFORE });
  check(
    15,
    "a delivery carrying no scope list does not clear the stored scopes",
    statusOf(empty) === 200 && snapshotOf(await sessionFor(SHOP)) === beforeEmpty,
    `status ${statusOf(empty)}, stored "${(await sessionFor(SHOP))?.scope ?? "(none)"}"`
  );

  const noSession = await deliver(NO_SESSION_SHOP, payloadFor(AFTER, BEFORE));
  check(
    16,
    "a delivery for a shop with no session answers 200 and writes nothing",
    statusOf(noSession) === 200 && (await sessionFor(NO_SESSION_SHOP)) === null,
    `status ${statusOf(noSession)}`
  );
}

main()
  .catch(async (error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error("cleanup failed:", error);
      failures += 1;
    }
    console.log(
      failures
        ? `\n=== ${total - failures}/${total} checks passed, ${failures} failure(s)${skipped ? `, ${skipped} skipped` : ""} ===`
        : `\n=== all ${total} checks passed${skipped ? `, ${skipped} skipped` : ""} ===`
    );
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
