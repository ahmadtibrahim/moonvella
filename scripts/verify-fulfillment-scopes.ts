/**
 * The fulfillment-permission gate: it asks Shopify, it asks ONCE, and it asks
 * because a person pressed a button.
 *
 * WHY THIS EXISTS. MoonVella needs `write_fulfillments` and `write_locations`
 * to own the fulfillment service and the location its stock ships from. The app
 * config declares them, the deploy published them — and the merchant opened the
 * app to NO permission screen at all, because `@shopify/shopify-app-react-router`
 * does not assert the configured scopes against the grant: `authenticate.admin`
 * builds the scopes API and never calls it, and the only caller of the grant
 * redirect is the opt-in `scopes.request()`. An app that declares more than it
 * holds serves normally and silently, forever. Asking is a thing the app has to
 * do deliberately.
 *
 * THE TWO WAYS ASKING GOES WRONG, and this suite is written against both:
 *
 *   1. ASKING FROM A LOADER. A page that requested the scopes whenever it
 *      noticed they were missing would send the merchant to Shopify's grant
 *      screen on every load. That is a loop, this app has already spent ten
 *      hours inside one, and it is why the request is an INTENT behind a button
 *      and the loader only ever READS. Checks 7-11 hold that line, and they are
 *      source assertions on purpose: the property is "no loader in this tree
 *      calls request", which is a statement about code that does not exist yet.
 *
 *   2. TRUSTING THE SESSION. The `Session.scope` column is written at install
 *      and by the `app/scopes_update` webhook; a stale value in it is
 *      indistinguishable from a current one by reading it. Detection goes to
 *      Shopify (`scopes.query()`), and checks 16-18 are what stop a later
 *      "optimisation" from quietly making the banner read a local string.
 *
 * WHAT IT DOES NOT DO. It reaches no provider — no Shopify, no Stripe. It
 * cannot prove the merchant will approve, and it cannot prove the approved
 * grant is effective on the wire.
 *
 * The half that needs a real store is proved instead by two probes run against
 * the live deployment from OUTSIDE this repo, because the verify harness is
 * forbidden a non-`_verify` database and these must read the merchant's own
 * session: one POSTs the grant intent with a signed session token and asserts
 * the answer is Shopify's reauth signal naming both scopes, and one makes the
 * two real calls with the offline token to show each scope works rather than
 * merely being listed. Both are written to fail before approval, so a green
 * result after it means something.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-fulfillment-scopes.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FULFILLMENT_SCOPES, missingFulfillmentScopes } from "~/services/shopifyScopes.server";

let total = 0;
let failures = 0;
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
 * Remove comments while leaving string literals intact.
 *
 * A character scanner rather than a pair of regexes, for the reason the
 * checkout-frame suite gives: most of what this file asserts is that some text
 * is ABSENT, and a stripper that ate real code would turn a defect into a PASS.
 * Strings are preserved deliberately — `"grant_fulfillment_scopes"` is a value
 * this suite has to be able to see, and a stripper that removed it would make
 * checks 12-14 pass by finding nothing.
 *
 * Check 19 is the stripper's own test: it is shown to remove a comment while
 * the raw text still contains it, so a stripper that silently did nothing —
 * or everything — cannot make this suite green.
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

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) found.push(full);
  }
  return found;
}

function main() {
  const APP_DIR = join(process.cwd(), "app");
  const ordersPath = join(APP_DIR, "routes", "app.orders.jsx");
  const scopesServicePath = join(APP_DIR, "services", "shopifyScopes.server.ts");

  const orders = stripComments(readFileSync(ordersPath, "utf8"));
  const scopesService = stripComments(readFileSync(scopesServicePath, "utf8"));

  /* ------------------------------------------------------------------ *
   * A. Which scopes are missing — the predicate, against real shapes.
   * ------------------------------------------------------------------ */

  /*
   * The grant Shopify actually returned for moonvilla-sandbox on 2026-09-28,
   * copied verbatim from `currentAppInstallation.accessScopes`. Every check in
   * this section is worth exactly as much as this fixture is real, so it is a
   * recording rather than something invented to make the code look right.
   */
  const REAL_GRANT = [
    "read_assigned_fulfillment_orders",
    "read_files",
    "read_inventory",
    "read_locations",
    "read_merchant_managed_fulfillment_orders",
    "read_metaobject_definitions",
    "read_metaobjects",
    "read_orders",
    "read_products",
    "read_reports",
    "write_assigned_fulfillment_orders",
    "write_files",
    "write_inventory",
    "write_merchant_managed_fulfillment_orders",
    "write_metaobject_definitions",
    "write_metaobjects",
    "write_products",
  ];

  check(
    1,
    "The two required scopes are named exactly once, in one place",
    FULFILLMENT_SCOPES.length === 2 &&
      FULFILLMENT_SCOPES[0] === "write_fulfillments" &&
      FULFILLMENT_SCOPES[1] === "write_locations",
    FULFILLMENT_SCOPES.join(", ")
  );

  const realMissing = missingFulfillmentScopes(REAL_GRANT);
  check(
    2,
    "Against the store's real 17-scope grant, exactly the two are reported missing",
    realMissing.length === 2 &&
      realMissing.includes("write_fulfillments") &&
      realMissing.includes("write_locations"),
    realMissing.join(", ")
  );

  /*
   * The trap this check exists for: the real grant CONTAINS `read_locations`.
   * A predicate written as a substring test — "does any granted scope mention
   * locations?" — answers NO for this fixture, reports nothing missing, hides
   * the banner, and leaves the app unable to fulfill with no way for anyone to
   * find out why.
   */
  check(
    3,
    "`read_locations` being granted does NOT satisfy `write_locations`",
    missingFulfillmentScopes(["read_locations"]).includes("write_locations"),
    `read_locations alone -> ${JSON.stringify(missingFulfillmentScopes(["read_locations"]))}`
  );

  check(
    4,
    "A grant holding both reports nothing missing",
    missingFulfillmentScopes([...REAL_GRANT, "write_fulfillments", "write_locations"]).length === 0
  );

  check(
    5,
    "A grant holding only one reports only the other",
    JSON.stringify(missingFulfillmentScopes([...REAL_GRANT, "write_fulfillments"])) ===
      JSON.stringify(["write_locations"]),
    JSON.stringify(missingFulfillmentScopes([...REAL_GRANT, "write_fulfillments"]))
  );

  check(
    6,
    "Handles are compared case-insensitively and duplicates do not confuse it",
    missingFulfillmentScopes(["WRITE_FULFILLMENTS", "Write_Locations", "write_locations"]).length === 0
  );

  /* ------------------------------------------------------------------ *
   * B. The request is made from the action, and from nowhere else.
   * ------------------------------------------------------------------ */

  const loaderAt = orders.indexOf("export const loader");
  const actionAt = orders.indexOf("export const action");

  check(
    7,
    "The orders route still has both a loader and an action, loader first",
    loaderAt !== -1 && actionAt !== -1 && loaderAt < actionAt,
    `loader@${loaderAt} action@${actionAt}`
  );

  const requestSites: number[] = [];
  for (let at = orders.indexOf("scopes.request("); at !== -1; at = orders.indexOf("scopes.request(", at + 1)) {
    requestSites.push(at);
  }

  check(
    8,
    "The orders route calls `scopes.request` exactly once",
    requestSites.length === 1,
    requestSites.length ? `at ${requestSites.join(", ")}` : "none found"
  );

  /*
   * THE LOOP CHECK. Everything above `actionAt` is loader code — and, in this
   * file, module-level constants. A `scopes.request` anywhere in there means the
   * scopes are requested on a page load, which is the ten-hour loop.
   */
  check(
    9,
    "Every `scopes.request` call sits in the action, never in the loader",
    requestSites.length > 0 && requestSites.every((at) => at > actionAt),
    requestSites.length
      ? requestSites.map((at) => (at > actionAt ? "action" : "LOADER")).join(", ")
      : "no call sites"
  );

  check(
    10,
    "The loader READS the granted scopes (detection) but never requests them",
    orders.includes("readFulfillmentScopes(") &&
      orders.indexOf("readFulfillmentScopes(") < actionAt,
    `read at ${orders.indexOf("readFulfillmentScopes(")}`
  );

  /*
   * The tree sweep. One file, one call site: a second caller anywhere — a
   * helper, another route, a component — is the beginning of "the merchant is
   * asked again from somewhere nobody remembered".
   */
  const requestFiles = sourceFiles(APP_DIR).filter((file) =>
    stripComments(readFileSync(file, "utf8")).includes("scopes.request(")
  );
  check(
    11,
    "Exactly one file in the whole app requests scopes",
    requestFiles.length === 1 && requestFiles[0] === ordersPath,
    requestFiles.length
      ? requestFiles.map((f) => f.replace(`${APP_DIR}/`, "app/")).join(", ")
      : "none found"
  );

  /* ------------------------------------------------------------------ *
   * C. The button: one action, correctly labelled, correctly wired.
   * ------------------------------------------------------------------ */

  check(
    12,
    "The page renders the grant action only when a scope is missing",
    /missingScopes\.length > 0 \?/.test(orders),
    orders.includes("missingScopes") ? "missingScopes present" : "missingScopes ABSENT"
  );

  check(
    13,
    "The action is labelled exactly \"Grant fulfillment permissions\"",
    orders.includes("Grant fulfillment permissions"),
    "label"
  );

  /*
   * The intent string has to match on both sides. A form posting one name and
   * an action testing another is a button that does nothing, visibly, with no
   * error — which is the failure mode a source check is actually good at.
   */
  const formIntent = /name="intent"\s+value="(grant_fulfillment_scopes)"/.exec(orders);
  const actionIntent = /intent === "(grant_fulfillment_scopes)"/.exec(orders);
  check(
    14,
    "The form's intent name is the name the action tests",
    Boolean(formIntent) && Boolean(actionIntent) && formIntent![1] === actionIntent![1],
    `form=${formIntent?.[1] ?? "MISSING"} action=${actionIntent?.[1] ?? "MISSING"}`
  );

  check(
    15,
    "The grant form is submitted by POST to this route, not linked to",
    /<Form method="post">\s*<input type="hidden" name="intent" value="grant_fulfillment_scopes"/.test(
      orders
    ),
    "Form method=post"
  );

  /* ------------------------------------------------------------------ *
   * D. Detection asks Shopify, not the session row.
   * ------------------------------------------------------------------ */

  check(
    16,
    "The scope service reads through `scopes.query()`, Shopify's own live API",
    scopesService.includes("scopes.query()"),
    "scopes.query()"
  );

  /*
   * The session's stored grant must not be the source of truth. This reads the
   * service and the route for any mention of the session's `scope` field — the
   * column that is stale by construction after a scope change until the
   * `app/scopes_update` webhook lands.
   */
  const sessionScopeOffenders = [
    ["services/shopifyScopes.server.ts", scopesService],
    ["routes/app.orders.jsx", orders],
  ].filter(([, text]) => /session\.scope/.test(text));
  check(
    17,
    "Nothing in the gate reads the session's stored `scope` string",
    sessionScopeOffenders.length === 0,
    sessionScopeOffenders.length
      ? sessionScopeOffenders.map(([name]) => name).join(", ")
      : "no session.scope reads in either file"
  );

  check(
    18,
    "A cached read is dropped when the grant action runs, so approval is not outlived",
    scopesService.includes("export function forgetFulfillmentScopes") &&
      orders.includes("forgetFulfillmentScopes("),
    "cache invalidation wired"
  );

  /* ------------------------------------------------------------------ *
   * E. The stripper can fail, so the checks above mean something.
   * ------------------------------------------------------------------ */

  const rawComment = 'const x = 1; // scopes.request(injected)\nconst y = 2;';
  const stripped = stripComments(rawComment);
  check(
    19,
    "The comment stripper removes a comment while the raw text still has it",
    rawComment.includes("scopes.request(") && !stripped.includes("scopes.request("),
    `raw has it: ${rawComment.includes("scopes.request(")}, stripped has it: ${stripped.includes("scopes.request(")}`
  );

  const rawString = 'const intent = "grant_fulfillment_scopes";';
  check(
    20,
    "The comment stripper keeps string literals, so the intent checks can see them",
    stripComments(rawString).includes("grant_fulfillment_scopes"),
    "literal survived"
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main();
