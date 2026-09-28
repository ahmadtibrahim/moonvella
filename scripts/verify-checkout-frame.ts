/**
 * Stripe Checkout is never rendered inside the Shopify admin's iframe.
 *
 * WHAT WENT WRONG. The seller pressed "Add payment method", the app asked the
 * server for a Checkout URL, and the route answered with a React Router
 * `redirect(session.url)` — which navigates the FRAME. Stripe refuses to render
 * Checkout in an iframe, so the panel went blank and the reason appeared only in
 * a console the seller had no reason to open:
 *
 *     Stripe Checkout is not able to run in an iFrame.
 *     Please redirect to Checkout at the top level.
 *
 * The fix has two halves and this suite checks both:
 *
 *   1. The URL is handed to the TOP window (`window.open(url, "_top")`), never
 *      to `window.location`, and never as a redirect from an action.
 *   2. The page the seller comes back to is a SHOPIFY ADMIN url, not one on this
 *      app's own origin. A top-level document on the app's origin is not the
 *      embedded app — no `host`, no `id_token`, no App Bridge — so returning
 *      there would replace the blank panel with "open MoonVella from your
 *      Shopify admin". Coming back through the admin re-establishes the frame.
 *
 * WHY THIS IS A SUITE AND NOT A COMMENT. Half of it is a negative assertion —
 * "no route navigates the frame to a provider URL" — and negative assertions are
 * exactly the kind that pass by accident. The failure it guards against has
 * already shipped once.
 *
 * THE COMMENT STRIPPER IS LOAD-BEARING, and the suite proves it rather than
 * asserting it. `app.billing.jsx` explains the bug it fixes by NAMING the old
 * code: a comment reading ``This used to be `window.location.href = url` ``. A
 * naive text scan would either fail on that comment or, if written to tolerate
 * it, quietly tolerate the real thing as well. So every source assertion runs on
 * comment-stripped text, and check 11 asserts that the stripper removes the
 * comment while the raw file still contains it — the check is shown to be
 * capable of failing.
 *
 * The stripper here is a character scanner rather than the two-regex helper the
 * older suites share, and checks 12 and 13 test it. The reason is the direction
 * this suite's assertions run: almost all of them are negative, so a stripper
 * that ate real code would show up as a PASS, over 64 files, in the one check
 * written to catch the next occurrence of a defect that has already shipped
 * once. The two-regex version survives `https://` by guarding on the preceding
 * `:` — which is exactly the kind of special case that stops being true.
 *
 * WHAT IT DOES NOT DO. It reaches no provider: no Stripe, no Shopify. The
 * hosted session is only ever CREATED by the code under test, and this suite
 * does not complete one — it has no browser. The server-side half of the same
 * defect, that a returned setup intent must belong to the seller who is saving
 * it, needs a real Stripe object to examine and so lives in
 * `verify-stripe-sandbox.ts` (section D) instead.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-checkout-frame.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { forbidProviderCalls } from "./provider-guard";
import { shopifyAdminAppUrl, storeHandle } from "~/services/shopifyNavigation.server";

// This suite must never reach a provider. Installing the guard states that as a
// property of the run rather than as an intention — see scripts/provider-guard.ts.
forbidProviderCalls("verify-checkout-frame");

let failures = 0;
let total = 0;
let lastNumber = 0;
/**
 * `number` is checked, not decorative.
 *
 * The first draft of this suite took `(name, pass, detail)` while every call
 * site was written `check(1, "…", condition, detail)` — so the number became the
 * name, the sentence became the condition, and all thirty-one checks passed
 * because a non-empty string is truthy. Thirty-one green lines describing
 * nothing, in a suite whose assertions are mostly negative and therefore have no
 * other way to fail visibly. Taking the number as the first parameter is what
 * turns that mismatch into a compile error instead of a silent pass, and the
 * monotonic guard below catches a number being reused.
 *
 * A sub-number (9.1) belongs to the step just above it, which is how a check
 * added inside a loop does not renumber everything after it.
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
 * Source with comments removed, strings left intact.
 *
 * Strings are copied verbatim on purpose: `window.open(url, "_top")` is only
 * recognisable if `"_top"` survives, and a scanner that tracked strings could
 * then never mistake a `//` inside `"https://…"` for the start of a comment.
 * What it does NOT model is a regex literal, so a `/…/` containing `//` would
 * be truncated to the end of its line. No file this suite reads contains one;
 * the cost if that changes is a check that fails to notice rather than one that
 * fails wrongly, and check 9's self-test is what keeps the stripper honest.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      out += source.slice(start, i);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The line a match sits on, for a failure message somebody can act on. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** Every `window.open(` call in a file, as `{ args, line }`. */
function windowOpenCalls(source: string): { args: string; line: number }[] {
  const calls: { args: string; line: number }[] = [];
  const pattern = /window\.open\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    // Balanced to the closing paren, so a nested call is reported whole.
    let depth = 1;
    let i = pattern.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    calls.push({ args: source.slice(pattern.lastIndex, i - 1).trim(), line: lineOf(source, match.index) });
  }
  return calls;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".jsx") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** A `Request` carrying the `host` query parameter the admin would send. */
function requestWithHost(host: string): Request {
  return new Request(`https://moonvella.example/app/billing?host=${encodeURIComponent(host)}`);
}

function main() {
  const APP_DIR = join(process.cwd(), "app");
  const routesDir = join(APP_DIR, "routes");
  const billingFile = join(routesDir, "app.billing.jsx");
  const ordersFile = join(routesDir, "app.orders.jsx");
  const billingRaw = readFileSync(billingFile, "utf8");
  const ordersRaw = readFileSync(ordersFile, "utf8");
  const billing = stripComments(billingRaw);
  const orders = stripComments(ordersRaw);

  const SHOP = "moonvilla-sandbox.myshopify.com";
  const CLIENT_ID = process.env.SHOPIFY_API_KEY ?? "";

  /* ------------------------------------------------------------------ */
  /* 1. The return URL is a Shopify ADMIN url, not one on this origin     */
  /* ------------------------------------------------------------------ */
  console.log("\n-- A. The seller comes back through the admin --------------------------");

  const derived = shopifyAdminAppUrl(SHOP, "/app/billing");
  check(
    1,
    "With no request, the return URL is the store's admin address for this app",
    derived === `https://admin.shopify.com/store/moonvilla-sandbox/apps/${CLIENT_ID}/app/billing`,
    derived
  );
  check(
    2,
    "The return URL is never on the app's own origin",
    /^https:\/\/admin\.(myshopify\.com|shopify\.com)/.test(derived) && !derived.includes("moonvella.example"),
    new URL(derived).origin
  );
  check(
    3,
    "The path the seller returns to is preserved, so they land back on Billing",
    derived.endsWith("/app/billing"),
    derived.split("/apps/")[1] ?? derived
  );
  check(
    4,
    "A path given without its leading slash still resolves inside the app",
    shopifyAdminAppUrl(SHOP, "app/billing") === derived,
    shopifyAdminAppUrl(SHOP, "app/billing")
  );
  check(
    5,
    "The store handle is the shop domain without its myshopify suffix",
    storeHandle("Foo-Bar.myshopify.com") === "foo-bar",
    storeHandle("Foo-Bar.myshopify.com")
  );
  check(
    6,
    "The client id in the URL is the configured one, which is what the admin resolves the app by",
    CLIENT_ID.length > 0 && derived.includes(`/apps/${CLIENT_ID}/`),
    CLIENT_ID ? "present" : "SHOPIFY_API_KEY is not set in this environment"
  );

  /* ------------------------------------------------------------------ */
  /* 2. The host parameter is preferred, and only when it is a real admin */
  /* ------------------------------------------------------------------ */
  console.log("\n-- B. The host parameter is followed only when it is safe ---------------");

  const adminHost = Buffer.from("admin.shopify.com/store/moonvilla-sandbox").toString("base64");
  check(
    7,
    "A valid host parameter is preferred over the derived address",
    shopifyAdminAppUrl(SHOP, "/app/billing", requestWithHost(adminHost)) === derived,
    shopifyAdminAppUrl(SHOP, "/app/billing", requestWithHost(adminHost))
  );

  // A custom domain is the case the parameter exists for: the store's handle is
  // not its address, so the derived URL would be wrong and only `host` is right.
  const customHost = Buffer.from("admin.shopify.com/store/a-different-store").toString("base64");
  const custom = shopifyAdminAppUrl("shop.example.com", "/app/billing", requestWithHost(customHost));
  check(
    8,
    "A host for a different store wins, because it is the authoritative statement of where the request came from",
    custom.includes("/store/a-different-store/") && !custom.includes("shop.example.com"),
    custom
  );

  /*
   * The refusals. Each of these is a `?host=` value an attacker can put on a
   * link to the app; the value this function returns becomes the `success_url`
   * of a real Stripe session, so following one would deliver a seller to the
   * attacker's page seconds after they typed a card number.
   */
  const hostile: [string, string][] = [
    ["a host that is a plain address", "evil.example.com/store/x"],
    ["a host that only ends in a Shopify domain", "admin.shopify.com.evil.example/store/x"],
    ["a full URL with a scheme", "https://evil.example/store/x"],
    ["a script URL", "javascript:alert(1)//store/x"],
    ["a host with no store segment", "admin.shopify.com"],
    ["a host whose store segment escapes upward", "admin.shopify.com/store/../../evil"],
    ["a host that is not base64 at all", "!!!"],
  ];
  hostile.forEach(([label, value], index) => {
    const encoded = Buffer.from(value).toString("base64");
    const url = shopifyAdminAppUrl(SHOP, "/app/billing", requestWithHost(encoded));
    check(
      Number(`9.${index + 1}`),
      `Refused: ${label}`,
      url === derived,
      url === derived ? "fell back to the derived admin address" : `FOLLOWED IT: ${url}`
    );
  });
  check(
    10,
    "A host parameter that is absent falls back rather than failing the seller's checkout",
    shopifyAdminAppUrl(SHOP, "/app/billing", new Request("https://moonvella.example/app/billing")) === derived,
    derived
  );

  /* ------------------------------------------------------------------ */
  /* 3. The stripper is capable of failing this suite                     */
  /* ------------------------------------------------------------------ */
  console.log("\n-- C. The source checks read code, not prose ----------------------------");

  /*
   * The one comment in the tree that names the defect, in the file that fixes
   * it. If the stripper did nothing, check 12 below would fail on this comment;
   * if it were written to tolerate the comment's exact wording, it would also
   * tolerate the real assignment. Asserting both halves is what makes the pair
   * mean something.
   */
  const rawHasIt = billingRaw.includes("window.location.href");
  const strippedHasIt = billing.includes("window.location.href");
  check(
    11,
    "The comment naming the old navigation is present in the raw file and gone from the stripped one",
    rawHasIt && !strippedHasIt,
    !rawHasIt
      ? "the comment this suite depends on is gone — update the check"
      : strippedHasIt
        ? "the phrase survives stripping, so the stripper is removing nothing"
        : "raw yes, stripped no"
  );
  const stripped = stripComments('const a = 1; /* window.location.href = x */\nconst b = 2;');
  check(
    12,
    "The stripper removes a block comment and leaves the code on both sides of it",
    !stripped.includes("window.location.href") && stripped.includes("const a = 1;") && stripped.includes("const b = 2;"),
    JSON.stringify(stripped)
  );
  check(
    13,
    "The stripper leaves a URL inside a string alone, so `//` in a literal is not a comment",
    stripComments('const u = "https://checkout.stripe.com/c/pay";').includes("https://checkout.stripe.com"),
    "string preserved"
  );

  /* ------------------------------------------------------------------ */
  /* 4. Neither route navigates the frame to a provider URL               */
  /* ------------------------------------------------------------------ */
  console.log("\n-- D. The provider page is handed to the top window ---------------------");

  const setupRoutes: [string, string, string][] = [
    ["app.billing.jsx", billing, billingRaw],
    ["app.orders.jsx", orders, ordersRaw],
  ];
  setupRoutes.forEach(([label, source, raw], index) => {
    // Five checks per route, numbered straight through rather than sub-numbered:
    // the per-file loop would otherwise emit 14.2 after 18.1, which the ordering
    // guard above is right to reject.
    const sub = (n: number) => 14 + index * 5 + (n - 14);
    const opens = windowOpenCalls(source);
    check(
      sub(14),
      `${label} opens the provider page in the top window`,
      opens.length > 0 && opens.every((call) => /,\s*"_top"\s*$/.test(call.args)),
      opens.length ? opens.map((c) => `L${c.line}: window.open(${c.args})`).join(" | ") : "no window.open call at all"
    );
    // The detail names what was FOUND, not what was hoped for. A fixed string
    // here reads as a verdict, and one that said "no location assignment" on the
    // line below a FAIL was actively misleading about which half disagreed.
    const assigned = /window\.location\s*(\.href\s*=|\.assign\s*\(|\.replace\s*\()/.exec(source);
    check(
      sub(15),
      `${label} never assigns a provider URL to window.location`,
      assigned === null,
      assigned ? `${assigned[0]} — this navigates the frame` : "no location assignment"
    );
    const redirectedFrame = /redirect\s*\([^)]*setupUrl/.exec(source) ?? /redirect\s*\([^)]*session\.url/.exec(source);
    check(
      sub(16),
      `${label} does not redirect the frame to the session — the action returns it as data`,
      redirectedFrame === null,
      redirectedFrame ? `${redirectedFrame[0]} — this navigates the frame` : "the setup branch returns JSON"
    );
    const fromOrigin = /returnUrl\s*=\s*[^;]*url\.origin/.exec(source);
    check(
      sub(17),
      `${label} builds the return URL through shopifyAdminAppUrl rather than from the request origin`,
      source.includes("shopifyAdminAppUrl(") && fromOrigin === null,
      fromOrigin
        ? `${fromOrigin[0]} — a top-level page on this origin is not the embedded app`
        : source.includes("shopifyAdminAppUrl(")
          ? "admin return URL"
          : "shopifyAdminAppUrl is not called at all"
    );
    check(
      sub(18),
      `${label} still contains the code the checks above looked for, so nothing passed by an empty file`,
      raw.length > 2000 && opens.length > 0,
      `${raw.split("\n").length} lines`
    );
  });

  /*
   * The whole tree, not just the two files that were fixed. This is the check
   * that catches the NEXT flow — a second provider page, a payout onboarding, an
   * identity check — being written the way this one was.
   */
  const files = sourceFiles(APP_DIR);
  const offenders: string[] = [];
  const sites: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const call of windowOpenCalls(source)) {
      const where = `${file.replace(`${APP_DIR}/`, "app/")}:${call.line}`;
      sites.push(`${where} -> ${call.args.split(",").slice(1).join(",").trim() || "(no target)"}`);
      if (!/,\s*"_top"\s*$/.test(call.args)) offenders.push(where);
    }
  }
  check(
    24,
    "Every window.open in the whole app names the top window, so no other flow can repeat this",
    offenders.length === 0,
    offenders.length ? `missing _top: ${offenders.join(", ")}` : `${sites.length} call site(s): ${sites.join(" | ")}`
  );

  /*
   * A `redirect(...)` is a navigation of the frame, so redirecting to a provider
   * URL is the original defect wearing different clothes.
   *
   * The pattern exempts `request.url` on purpose, and the exemption is not a
   * concession: `admin.shipping.tsx` redirects to its own request URL, which is
   * a POST-redirect-GET back into the admin. The first version of this check
   * matched it, and a negative assertion that fires on correct code is one
   * somebody deletes — which is how the real case stops being checked.
   */
  const PROVIDER_REDIRECT = /redirect\s*\(\s*(?!request\.)[A-Za-z_$][\w$]*\.url\b/;
  const redirected = files.filter((file) =>
    PROVIDER_REDIRECT.test(stripComments(readFileSync(file, "utf8")))
  );
  check(
    25,
    "No route anywhere redirects the frame to a URL that came from a provider",
    redirected.length === 0,
    redirected.length ? redirected.map((f) => f.replace(`${APP_DIR}/`, "app/")).join(", ") : `${files.length} files scanned`
  );

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main();
