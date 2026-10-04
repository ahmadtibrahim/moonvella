/**
 * The fulfillment-permission gate: it reads Shopify, it never asks, and it
 * cannot ask.
 *
 * WHY THIS EXISTS. MoonVella needs `write_fulfillments` and `write_locations`
 * to own the fulfillment service and the location its stock ships from. The app
 * config declares them, the deploy published them — and the merchant opened the
 * app to NO permission screen at all, because `@shopify/shopify-app-react-router`
 * does not assert the configured scopes against the grant: `authenticate.admin`
 * builds the scopes API and never calls it, and the only caller of the grant
 * redirect is the opt-in `scopes.request()`. An app that declares more than it
 * holds serves normally and silently, forever.
 *
 * THE REPAIR THAT DOES NOT EXIST, AND WHY THIS SUITE EXISTS TO KEEP IT GONE.
 * The first answer to that silence was an in-app repair: a button that called
 * `scopes.request(FULFILLMENT_SCOPES)` and carried the resulting grant url back
 * to the page. It could not have worked. Shopify accepts a dynamic
 * `scopes.request()` ONLY for scopes declared as OPTIONAL, and these two are
 * required installation scopes — the platform does not offer the call for them.
 * An installed store approves newly required scopes through Shopify's OWN
 * managed installation / reauthorization flow, which belongs to Shopify and the
 * Partner Dashboard and is not drivable from inside an app. So the request path
 * is removed rather than repaired, and the two failure modes this suite is
 * written against are:
 *
 *   1. SOMEONE PUTS IT BACK. A `scopes.request()` for a required scope is a
 *      button that fails on the wire, and it fails as a consent screen that
 *      never appears. Section B sweeps the whole tree for the call, and section
 *      E is the detector's own test: an injected
 *      `scopes.request(["write_fulfillments"])` fixture MUST be caught, so a
 *      detector that silently matched nothing cannot make this suite green.
 *
 *   2. TRUSTING THE SESSION. The `Session.scope` column is written at install
 *      and by the `app/scopes_update` webhook; a stale value in it is
 *      indistinguishable from a current one by reading it. Detection goes to
 *      Shopify (`scopes.query()`), and checks 19-20 are what stop a later
 *      "optimisation" from quietly making the banner read a local string.
 *
 * WHAT IT DOES NOT DO. It reaches no provider — no Shopify, no Stripe. It
 * cannot prove the merchant will approve, and it cannot prove the approved
 * grant is effective on the wire.
 *
 * The half that needs a real store is proved instead by probes run against a
 * live deployment from OUTSIDE this repo, because the verify harness is
 * forbidden a non-`_verify` database and these must read the merchant's own
 * session: one POSTs the re-check intent with a signed session token and
 * asserts the answer is JSON — a plain object naming what Shopify reports, with
 * no reauthorization header on it, since this route no longer has a grant
 * screen to send anyone to — and one makes the two real calls with the offline
 * token to show each scope works rather than merely being listed. The second is
 * written to fail before approval, so a green result after it means something.
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
 * Strings are preserved deliberately — `"recheck_fulfillment_scopes"` is a
 * value this suite has to be able to see, and a stripper that removed it would
 * make the intent checks pass by finding nothing.
 *
 * Check 25 is the stripper's own test: it is shown to remove a comment while
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

/** The argument text of every `scopes.request(...)` call in a source string. */
function requestArgs(source: string): string[] {
  const needle = "scopes.request(";
  const out: string[] = [];
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    let i = at + needle.length;
    let depth = 1;
    let args = "";
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      args += ch;
      i += 1;
    }
    out.push(args);
  }
  return out;
}

/**
 * WHICH REQUESTS ARE ILLEGAL, stated once so both the live sweep and the
 * self-tests read the same rule.
 *
 * A dynamic request is legal only for an OPTIONAL scope. Both scopes here are
 * REQUIRED installation scopes, so any `scopes.request()` that names one of
 * them — as a literal, or by naming the `FULFILLMENT_SCOPES` tuple that holds
 * exactly them — is a call the platform will refuse, and returns the scope's
 * handle so a failure says which one.
 */
function requiredScopesAskedFor(source: string, required: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const args of requestArgs(source)) {
    if (/FULFILLMENT_SCOPES/.test(args)) offenders.push(`FULFILLMENT_SCOPES → scopes.request(${args.trim()})`);
    for (const scope of required) {
      if (args.includes(`"${scope}"`) || args.includes(`'${scope}'`) || args.includes("`" + scope + "`")) {
        offenders.push(`${scope} → scopes.request(${args.trim()})`);
      }
    }
  }
  return offenders;
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
   * B. Nothing asks. The request path is gone from the tree.
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

  /*
   * ZERO, and the earlier version of this check asserted one. The one call that
   * used to be here asked for `write_fulfillments` and `write_locations` —
   * required scopes, which Shopify will not accept a dynamic request for. A
   * route that keeps the call keeps a button that cannot work.
   */
  check(
    8,
    "The orders route makes no dynamic scope request at all",
    requestSites.length === 0,
    requestSites.length ? `at ${requestSites.join(", ")}` : "no call sites"
  );

  /*
   * THE TREE SWEEP, RUN THROUGH THE DETECTOR rather than a bare substring test.
   * One file, one call site was the property before; the property now is that
   * no file asks for a scope the app cannot run without, and that is a rule
   * about arguments rather than about a call existing.
   */
  const treeOffenders: string[] = [];
  for (const file of sourceFiles(APP_DIR)) {
    const offenders = requiredScopesAskedFor(stripComments(readFileSync(file, "utf8")), FULFILLMENT_SCOPES);
    for (const offender of offenders) treeOffenders.push(`${file.replace(`${APP_DIR}/`, "app/")}: ${offender}`);
  }
  check(
    9,
    "No file in the app requests a required scope dynamically",
    treeOffenders.length === 0,
    treeOffenders.length ? treeOffenders.join("; ") : "none found"
  );

  /*
   * The transport that carried the old throw is gone with it: a header constant
   * and a reader that only made sense while a 401 could be produced. Their
   * names must not survive as decoration, because a reader who finds
   * `REAUTHORIZE_URL_HEADER` has found the first half of a path that no longer
   * has a second half.
   */
  check(
    10,
    "The reauth transport is gone from the service, not merely unused",
    !/REAUTHORIZE_URL_HEADER/.test(scopesService) &&
      !/reauthorizeUrl/.test(scopesService) &&
      !/X-Shopify-API-Request-Failure-Reauthorize-Url/.test(scopesService) &&
      !/X-Shopify-API-Request-Failure-Reauthorize-Url/.test(orders),
    "no constant, no reader, no header literal"
  );

  check(
    11,
    "The loader READS the granted scopes (detection) but never requests them",
    orders.includes("readFulfillmentScopes(") && orders.indexOf("readFulfillmentScopes(") < actionAt,
    `read at ${orders.indexOf("readFulfillmentScopes(")}`
  );

  /* ------------------------------------------------------------------ *
   * C. The button and the action: a re-check, not a grant.
   * ------------------------------------------------------------------ */

  check(
    12,
    "The page renders the permission card only when a scope is missing",
    /missingScopes\.length > 0 \?/.test(orders),
    orders.includes("missingScopes") ? "missingScopes present" : "missingScopes ABSENT"
  );

  /*
   * The intent string has to match on both sides. A form posting one name and
   * an action testing another is a button that does nothing, visibly, with no
   * error — which is the failure mode a source check is actually good at. The
   * name itself is checked too: it is a RE-check, and a name that still says
   * "grant" would outlive the mechanism it describes.
   */
  const formIntent = /name="intent"\s+value="(recheck_fulfillment_scopes)"/.exec(orders);
  const actionIntent = /intent === "(recheck_fulfillment_scopes)"/.exec(orders);
  check(
    13,
    "The form's intent name is the name the action tests, and it is the re-check",
    Boolean(formIntent) && Boolean(actionIntent) && formIntent![1] === actionIntent![1],
    `form=${formIntent?.[1] ?? "MISSING"} action=${actionIntent?.[1] ?? "MISSING"}`
  );

  check(
    14,
    "The re-check form is submitted by POST to this route, not linked to",
    /<Form method="post">\s*<input type="hidden" name="intent" value="recheck_fulfillment_scopes"/.test(
      orders
    ),
    "Form method=post"
  );

  /*
   * THE ANSWER IS WHAT SHOPIFY SAYS, AND THE REFUSAL BRANCH IS THE PROOF.
   * An action that answered "granted" without asking would be the original
   * silence in a new shape; one that reads and then reports only success would
   * hide a merchant who declined. So the action must read, and it must have a
   * branch that returns the missing handles when the read still finds them.
   */
  const actionBody = orders.slice(actionAt);
  check(
    15,
    "The action reads Shopify and reports what it found, including \"still missing\"",
    actionBody.includes("readFulfillmentScopes(") &&
      /state\.missing\.length > 0/.test(actionBody) &&
      /missing: state\.missing/.test(actionBody),
    "read + refusal branch + live handles"
  );

  check(
    16,
    "The button offers a check, not a grant that cannot happen",
    orders.includes("Check again") && !orders.includes("Grant fulfillment permissions"),
    "label"
  );

  check(
    17,
    "The card names the permissions and points at Shopify's own approval flow",
    orders.includes("newly required permissions") &&
      /app-update flow/.test(orders) &&
      /Shopify admin/.test(orders),
    "newly required permissions + Shopify admin flow"
  );

  /*
   * NOTHING LEFT TO NAVIGATE TO. The page used to open the grant url in the top
   * window, keyed on a per-ask stamp. With no request there is no url and no
   * stamp, and a leftover effect keyed on one would be a navigation that fires
   * on an action result that no longer carries it.
   */
  check(
    18,
    "The page has no grant navigation left — no url, no ask stamp, no window.open",
    !/grantUrl/.test(orders) && !/grantAsk/.test(orders) && !/window\.open\(grantUrl/.test(orders),
    "no grantUrl, no grantAsk"
  );

  /* ------------------------------------------------------------------ *
   * D. Detection asks Shopify, not the session row.
   * ------------------------------------------------------------------ */

  check(
    19,
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
    20,
    "Nothing in the gate reads the session's stored `scope` string",
    sessionScopeOffenders.length === 0,
    sessionScopeOffenders.length
      ? sessionScopeOffenders.map(([name]) => name).join(", ")
      : "no session.scope reads in either file"
  );

  /*
   * The cache is dropped by the ACTION, never by the loader: the merchant
   * presses the button precisely because they have just approved, and a loader
   * that dropped the cache would put an uncached Shopify call on the layout's
   * 30-second revalidation timer. Anything above `actionAt` is loader or
   * module-level code, so that is the line the position is compared against.
   */
  const forgetAt = orders.indexOf("forgetFulfillmentScopes(");
  check(
    21,
    "The cached read is dropped by the re-check action, never on a page load",
    forgetAt > actionAt && actionAt !== -1,
    `forget at ${forgetAt}, action at ${actionAt}`
  );

  /* ------------------------------------------------------------------ *
   * E. The detector can fail, so the checks above mean something.
   *
   * This is the required-scope rule's own test. The fixture is the call that
   * actually shipped in this repo — `scopes.request([...FULFILLMENT_SCOPES])` —
   * plus the bare-literal form a later author would more likely type. A
   * detector that matched nothing, or matched everything, is caught here rather
   * than at the merchant.
   * ------------------------------------------------------------------ */

  const literalFixture = 'await scopes.request(["write_fulfillments"]);';
  const literalHits = requiredScopesAskedFor(literalFixture, FULFILLMENT_SCOPES);
  check(
    22,
    "An injected `scopes.request([\"write_fulfillments\"])` is caught and names the scope",
    literalHits.length === 1 && literalHits[0].includes("write_fulfillments"),
    literalHits.join("; ") || "NOTHING CAUGHT"
  );

  const spreadFixture = "await scopes.request([...FULFILLMENT_SCOPES]);";
  const spreadHits = requiredScopesAskedFor(spreadFixture, FULFILLMENT_SCOPES);
  check(
    23,
    "An injected `scopes.request([...FULFILLMENT_SCOPES])` is caught through the tuple",
    spreadHits.length === 1 && spreadHits[0].includes("FULFILLMENT_SCOPES"),
    spreadHits.join("; ") || "NOTHING CAUGHT"
  );

  /*
   * The negative control. A detector that fired on every request would pass
   * both checks above while proving nothing — a request for a scope the app does
   * NOT require is exactly the legal case this rule must leave alone.
   */
  const optionalFixture = 'await scopes.request(["write_discounts"]);';
  check(
    24,
    "The detector leaves a request for a scope the app does not require alone",
    requiredScopesAskedFor(optionalFixture, FULFILLMENT_SCOPES).length === 0,
    requiredScopesAskedFor(optionalFixture, FULFILLMENT_SCOPES).join("; ") || "not flagged"
  );

  const rawComment = 'const x = 1; // scopes.request([...FULFILLMENT_SCOPES])\nconst y = 2;';
  const stripped = stripComments(rawComment);
  check(
    25,
    "The comment stripper removes a comment while the raw text still has it",
    requestArgs(rawComment).length === 1 &&
      requiredScopesAskedFor(stripComments(rawComment), FULFILLMENT_SCOPES).length === 0 &&
      stripped.includes("const y = 2;"),
    `raw args: ${requestArgs(rawComment).length}, stripped offenders: ${requiredScopesAskedFor(stripped, FULFILLMENT_SCOPES).length}`
  );

  const rawString = 'const intent = "recheck_fulfillment_scopes";';
  check(
    26,
    "The comment stripper keeps string literals, so the intent checks can see them",
    stripComments(rawString).includes("recheck_fulfillment_scopes"),
    "literal survived"
  );

  /* ------------------------------------------------------------------ *
   * F. The configuration that makes the two scopes legal.
   *
   * Both are REQUIRED installation scopes: the workflow cannot finish an order
   * without them, so a new installation is asked for them on the install screen,
   * and they are deliberately NOT duplicated as optional — a scope declared in
   * both places is ambiguous, an optional declaration would describe them as
   * permissions the merchant may decline, and it is the optional declaration
   * that would make a dynamic request legal where a required one is not.
   * ------------------------------------------------------------------ */

  const toml = readFileSync(join(process.cwd(), "shopify.app.toml"), "utf8");
  const requiredLines = [...toml.matchAll(/^scopes\s*=\s*"([^"]*)"/gm)];
  const optionalLines = [...toml.matchAll(/^optional_scopes\s*=\s*\[([^\]]*)\]/gm)];
  /*
   * Read EVERY occurrence, and refuse a duplicate. A defect injection proved
   * this matters: a second `scopes =` line left the first one intact, the
   * check below read the first, and it passed while the file declared the two
   * as required in a second key that TOML would resolve differently than this
   * test did. A config that says two things about the same key is a config
   * error whether or not the parser complains, so it fails here first.
   */
  const required = (requiredLines[0]?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const optional = (optionalLines[0]?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  check(
    27,
    "The config declares `scopes` and `optional_scopes` once each",
    requiredLines.length === 1 && optionalLines.length === 1,
    `scopes x${requiredLines.length}, optional_scopes x${optionalLines.length}`
  );

  check(
    28,
    "Both scopes are declared as required installation scopes in the app configuration",
    FULFILLMENT_SCOPES.every((scope) => required.includes(scope)),
    `${required.length} required scope(s)`
  );

  check(
    29,
    "Neither is duplicated as an optional scope",
    !FULFILLMENT_SCOPES.some((scope) => optional.includes(scope)),
    `optional_scopes = ${optional.join(", ") || "(absent)"}`
  );

  /*
   * `read_locations` stays required and that is not an oversight: the catalog
   * uses it to know where stock is. It is the READ half of the location
   * permissions, and it was never the half that went missing.
   */
  check(
    30,
    "read_locations stays required — the read half never changed",
    required.includes("read_locations"),
    required.includes("read_locations") ? "read_locations required" : "read_locations MISSING"
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main();
