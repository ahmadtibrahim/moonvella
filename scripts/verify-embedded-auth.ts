/**
 * The embedded Shopify session, over HTTP, against the running app.
 *
 * WHAT WENT WRONG, AND WHY THIS SUITE EXISTS. A seller inside their own Shopify
 * admin was shown "MoonVella has to be opened from your Shopify admin". The
 * authentication was not the broken part: the session was created, the token
 * exchange ran, and the request was authenticated. The broken part was the hop
 * after it. `/app/application` sends an approved store to `/app` — and the
 * `redirect("/app")` it used produced a bare Location, dropping `shop`, `host`,
 * `embedded` and `id_token` on the floor. The next request therefore carried
 * nothing App Bridge or the server could authenticate, so `authenticate.admin`
 * answered with its bootstrap page and the layout's error boundary put the
 * sentence under it. Every visit. From inside the admin.
 *
 * So the thing this suite pins is not "the message is gone". It is that the
 * Shopify frame context SURVIVES EVERY INTERNAL HOP, because that context is
 * the only thing that authenticates a document load inside the iframe. Check
 * §1 is the regression: it walks the redirect the way a browser walks it and
 * asserts the frame parameters are still on the destination.
 *
 * THE SESSION IS MINTED, NOT BORROWED. A session token is an HS256 JWT signed
 * with the app's client secret — the same thing App Bridge mints in the browser,
 * made here so the server contract can be exercised without a Shopify admin to
 * click in. What this suite therefore CANNOT prove is the browser half: that
 * App Bridge mints a token, that the bounce page performs its redirect, and that
 * a click in the Shopify admin frame lands on the app. Those are Shopify's, not
 * the app's, and they are covered by the manual pass recorded with the work.
 *
 * A MINTED TOKEN CANNOT DO A TOKEN EXCHANGE. Shopify validates the subject token
 * server-side and would reject one it did not issue — which is why the fixture
 * writes the session row itself, exactly as a completed exchange would. That is
 * also why the token-exchange path is asserted by its absence-precondition: the
 * suite fails loudly if the row it wrote is not the row the app loaded.
 *
 * IT NEEDS A RUNNING SERVER, ON BOTH SURFACES. The merchant app answers on
 * APP_SURFACE_BASE and the owner panel on APP_BASE; the harness that calls this
 * provides both, plus the add-host entries that make the fixture hostnames
 * resolve. No credential is required and none is used: the Shopify side is
 * signed, not logged in.
 *
 * IT CREATES ROWS. Two stores, their sessions, applications and sellers, all
 * removed in `cleanup()`, which runs even when a check throws. Audit rows are
 * append-only and are deliberately left behind.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-embedded-auth.ts
 */
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** The merchant surface. The owner surface is APP_BASE, as every other suite reads it. */
const APP_BASE = process.env.APP_SURFACE_BASE || process.env.APP_BASE || "http://localhost:3100";
const ADMIN_BASE = process.env.APP_BASE || APP_BASE;
const API_KEY = process.env.SHOPIFY_API_KEY || "";
const API_SECRET = process.env.SHOPIFY_API_SECRET || "";

/**
 * A real browser's User-Agent, on every request.
 *
 * The framework refuses self-identifying bots before any session work with a
 * 410. That is correct and is pinned on its own below; sending a browser agent
 * everywhere else keeps the rest of the suite measuring the app rather than the
 * bot filter.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** The sentence a seller saw. Quoted once, so no check can drift from it. */
const SENTENCE = "MoonVella has to be opened from your Shopify admin";

const STAMP = Date.now().toString(36);
const SHOP_A = `mvembed-a-${STAMP}.myshopify.com`;
const SHOP_B = `mvembed-b-${STAMP}.myshopify.com`;
const NAME_A = `Embedded Auth Alpha ${STAMP}`;
const NAME_B = `Embedded Auth Bravo ${STAMP}`;

let failures = 0;
let total = 0;
let skipped = 0;

function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${total}. ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name: string, why: string) {
  skipped++;
  console.log(`SKIP  ${total}. ${name} — ${why}`);
}

/* -------------------------------------------------------------------------- */
/* Session tokens                                                             */
/* -------------------------------------------------------------------------- */

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The `host` parameter, which is the admin URL base64-encoded — the value
 * Shopify puts on the iframe URL. Built here rather than pasted so the two
 * halves cannot disagree.
 */
function hostParam(shop: string): string {
  return Buffer.from(`admin.shopify.com/store/${shop.replace(".myshopify.com", "")}`).toString(
    "base64"
  );
}

interface TokenOptions {
  /** Seconds from now; negative mints one that has already expired. */
  expiresIn?: number;
  secret?: string;
  key?: string;
  /** The shop the token names as its destination, when it is not the caller's. */
  dest?: string;
}

/**
 * A session token of the shape App Bridge mints: HS256 over the client secret,
 * `dest` naming the shop, `aud` naming the app. Anything the app trusts about
 * a request is derived from these claims and nothing else — which is the
 * property §4 and §5 below are about.
 */
function mintToken(shop: string, options: TokenOptions = {}): string {
  const { expiresIn = 600, secret = API_SECRET, key = API_KEY, dest } = options;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({
    iss: `https://${shop}/admin`,
    dest: `https://${dest ?? shop}`,
    aud: key,
    sub: "1",
    exp: now + expiresIn,
    nbf: now - 10,
    iat: now - 10,
    jti: `mvverify-${STAMP}-${expiresIn}`,
    sid: "1",
  });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

interface Ask {
  /** Where the token is presented: on the URL, as App Bridge's fetch sends it. */
  tokenIn?: "query" | "header" | "none";
  token?: string;
  shop?: string;
  embedded?: boolean;
  /** Extra query parameters, appended after the frame parameters. */
  params?: Record<string, string>;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  base?: string;
  /** Send a self-identifying bot agent instead of a browser's. */
  bot?: boolean;
  redirect?: RequestRedirect;
}

/**
 * One request, built the way the surface it is aimed at receives them.
 *
 * `base` defaults to the merchant surface because that is what most of this
 * suite is about; the owner-panel checks in §6 name the admin base explicitly.
 */
async function ask(path: string, options: Ask = {}) {
  const {
    tokenIn = "none",
    token,
    shop,
    embedded = true,
    params = {},
    headers = {},
    method = "GET",
    body,
    base = APP_BASE,
    bot = false,
    redirect = "manual",
  } = options;

  const search = new URLSearchParams();
  if (shop) {
    search.set("shop", shop);
    search.set("host", hostParam(shop));
  }
  if (embedded) search.set("embedded", "1");
  if (tokenIn === "query" && token) search.set("id_token", token);
  for (const [key, value] of Object.entries(params)) search.set(key, value);

  // Merged into the target rather than pasted on the end, so this can be handed
  // a Location that already carries the frame parameters — which is exactly what
  // "follow the redirect" means. Concatenating a second `?` instead swallows
  // every parameter after it into the value of the last one, and the token that
  // comes out the far side is not the token that went in: the suite then reports
  // a 302 as though the app had refused a valid session, when what it actually
  // sent was a malformed URL.
  const target = new URL(path, base);
  for (const [key, value] of search) {
    if (!target.searchParams.has(key)) target.searchParams.set(key, value);
  }

  const url = target.toString();
  const sent: Record<string, string> = {
    "User-Agent": bot ? "Googlebot/2.1 (+http://www.google.com/bot.html)" : BROWSER_UA,
    Accept: "text/html,application/xhtml+xml",
    ...headers,
  };
  if (tokenIn === "header" && token) sent.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { method, headers: sent, body, redirect });
  const html = await res.text();
  return { status: res.status, location: res.headers.get("location") || "", html, headers: res.headers };
}

/** The screen, with the serialized loader data and every script taken out. */
function rendered(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * The App Bridge bootstrap page the framework throws when it cannot
 * authenticate, told apart from the app it is bootstrapping.
 *
 * Both carry the script tag — `AppProvider` renders App Bridge on every page of
 * the app, which is the whole point of it — so a check for the script alone
 * matches both and is worth nothing. What the bootstrap page does not have is
 * any of the app: it is a document whose only job is to mint a token and
 * redirect. The nav is the cheapest thing to look for, and it is present on
 * every merchant page because the layout renders it.
 */
function isBootstrap(html: string): boolean {
  return html.includes("app-bridge.js") && !html.includes("<s-app-nav");
}

/** Whether the merchant app itself rendered, rather than a bootstrap or an error. */
function isApp(html: string): boolean {
  return html.includes("<s-app-nav");
}

function frameOf(location: string): URLSearchParams {
  return new URL(location, APP_BASE).searchParams;
}

/**
 * Where a redirect points, as a path this suite can ask for.
 *
 * Resolved rather than string-sliced: the destination of the hop under test is
 * `/app`, and reading the parameters off the end of a Location while asking for
 * a different path is how the first run of this suite reported the app as broken
 * when it was the harness asking the wrong question.
 */
function nextPath(location: string): string {
  const url = new URL(location, APP_BASE);
  return `${url.pathname}${url.search}`;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A store the app will authenticate, written the way a finished token exchange
 * leaves it: the offline session row the library's own id scheme names.
 */
async function seedStore(shop: string, storeName: string, contactName: string) {
  // The application first, with the seller created through it: that is the
  // direction the link is stored in (`Seller.applicationId`), so writing it this
  // way leaves the same shape an approval leaves behind rather than a pair of
  // rows that merely happen to share a domain.
  const application = await prisma.merchantApplication.create({
    data: {
      shopDomain: shop,
      storeName,
      status: "APPROVED",
      contactName,
      email: `${shop.replace(/[^a-z0-9]/gi, "-")}@mvverify.invalid`,
      seller: {
        create: {
          shopDomain: shop,
          storeName,
          shopDomainFull: `https://${shop}`,
          contactEmail: `${shop.replace(/[^a-z0-9]/gi, "-")}@mvverify.invalid`,
          contactName,
          status: "APPROVED",
        },
      },
    },
  });
  const seller = await prisma.seller.findUniqueOrThrow({ where: { shopDomain: shop } });
  await prisma.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "",
      isOnline: false,
      scope: process.env.SCOPES || "",
      accessToken: "mvverify-not-a-real-token",
      expires: new Date(Date.now() + 6 * 60 * 60 * 1000),
    },
  });
  return { seller, application };
}

async function cleanup() {
  const shops = [SHOP_A, SHOP_B];
  await prisma.session.deleteMany({ where: { shop: { in: shops } } });
  const sellers = await prisma.seller.findMany({
    where: { shopDomain: { in: shops } },
    select: { id: true },
  });
  const ids = sellers.map((row) => row.id);
  if (ids.length) await prisma.sellerSettings.deleteMany({ where: { sellerId: { in: ids } } });
  await prisma.merchantApplication.deleteMany({ where: { shopDomain: { in: shops } } });
  await prisma.seller.deleteMany({ where: { shopDomain: { in: shops } } });
}

async function main() {
  if (!API_KEY || !API_SECRET) {
    throw new Error(
      "verify-embedded-auth needs SHOPIFY_API_KEY and SHOPIFY_API_SECRET to mint a session; " +
        "the HTTP harness passes the deployment's own environment."
    );
  }

  const a = await seedStore(SHOP_A, NAME_A, "Alpha Contact");
  const b = await seedStore(SHOP_B, NAME_B, "Bravo Contact");

  const tokenA = mintToken(SHOP_A);
  const tokenB = mintToken(SHOP_B);

  try {
    /* ------------------------------------------------------------------ */
    /* 1. The defect: an internal hop must keep the Shopify frame context  */
    /* ------------------------------------------------------------------ */
    /*
     * This is the check that would have caught the bug, and it is written the
     * way a browser experiences it: ask for the page, then ask for the page the
     * answer points at, and look at what the second request carries.
     */
    const application = await ask("/app/application", {
      shop: SHOP_A,
      token: tokenA,
      tokenIn: "query",
    });
    const landed = frameOf(application.location);

    check(
      "An approved store asking for /app/application is redirected",
      application.status >= 300 && application.status < 400 && application.location !== "",
      `${application.status} ${application.location.slice(0, 80)}`
    );
    check(
      "The redirect still names the store (shop)",
      landed.get("shop") === SHOP_A,
      landed.get("shop") || "(none)"
    );
    check(
      "The redirect still names the admin frame (host)",
      landed.get("host") === hostParam(SHOP_A),
      landed.get("host") || "(none)"
    );
    check("The redirect still declares the app embedded", landed.get("embedded") === "1");
    check(
      "The redirect still carries the session token App Bridge minted",
      landed.get("id_token") === tokenA,
      landed.get("id_token") ? "present" : "(none)"
    );

    const afterHop = await ask(nextPath(application.location), {
      shop: SHOP_A,
      token: tokenA,
      tokenIn: "query",
    });
    const hopText = rendered(afterHop.html);
    check(
      "Following that hop lands on the seller app, not on the sentence",
      isApp(afterHop.html) && !hopText.includes(SENTENCE),
      `HTTP ${afterHop.status}`
    );

    /*
     * The same rule on the first hop of every session. This route runs before
     * there is any session to read, so its only job is to not lose the context.
     */
    const entry = await ask("/", { shop: SHOP_A, token: tokenA, tokenIn: "query" });
    const entryFrame = frameOf(entry.location);
    check(
      "The app's entry route hands the frame context on, unaltered",
      entry.status >= 300 &&
        entry.status < 400 &&
        entryFrame.get("shop") === SHOP_A &&
        entryFrame.get("host") === hostParam(SHOP_A) &&
        entryFrame.get("embedded") === "1" &&
        entryFrame.get("id_token") === tokenA,
      entry.location.slice(0, 80)
    );

    /* ------------------------------------------------------------------ */
    /* 2. A valid embedded session loads the seller application            */
    /* ------------------------------------------------------------------ */
    const dashboard = await ask("/app", { shop: SHOP_A, token: tokenA, tokenIn: "query" });
    const dashboardText = rendered(dashboard.html);
    check(
      "A valid embedded session renders the seller application",
      dashboard.status === 200 && isApp(dashboard.html),
      `HTTP ${dashboard.status}`
    );
    check("And it names the store the token names", dashboardText.includes(NAME_A));
    check("And it does not show the sentence", !dashboardText.includes(SENTENCE));
    check("And it is not the App Bridge bootstrap page", !isBootstrap(dashboard.html));
    check(
      "And it offers the seller navigation",
      ["/app/catalog", "/app/status", "/app/settings", "/app/orders"].every((href) =>
        dashboard.html.includes(`href="${href}"`)
      )
    );

    /* ------------------------------------------------------------------ */
    /* 3. Missing query parameters do not break a valid session            */
    /* ------------------------------------------------------------------ */
    /*
     * App Bridge's fetch sends the token as a header on the client-side
     * navigations React Router makes after the document has loaded. Those
     * requests carry no `shop`, no `host` and no `embedded` — the URL is
     * `/app/catalog.data` and nothing else. If the server needed those
     * parameters to authenticate, every click in the app would break.
     */
    const bare = await ask("/app", { token: tokenA, tokenIn: "header", embedded: false, shop: "" });
    check(
      "A token in the header authenticates with no shop/host/embedded on the URL",
      bare.status === 200 && isApp(bare.html) && rendered(bare.html).includes(NAME_A),
      `HTTP ${bare.status}`
    );

    const dataRequest = await ask("/app/catalog.data", {
      token: tokenA,
      tokenIn: "header",
      embedded: false,
      shop: "",
      headers: { Accept: "application/json" },
    });
    check(
      "The data request behind a client-side navigation is authenticated too",
      dataRequest.status === 200 && !isBootstrap(dataRequest.html),
      `HTTP ${dataRequest.status}`
    );

    /* ------------------------------------------------------------------ */
    /* 4. The token decides the store, never the query parameter           */
    /* ------------------------------------------------------------------ */
    const asB = await ask("/app", { shop: SHOP_B, token: tokenB, tokenIn: "query" });
    check(
      "A second store's token renders that store's data",
      isApp(asB.html) && rendered(asB.html).includes(NAME_B),
      `HTTP ${asB.status}`
    );

    /*
     * The forged-parameter case: a valid token for A, and a `shop` naming B.
     * The shop is read from the verified token's `dest`, so the parameter is
     * inert — and this is the check that fails if anyone ever "simplifies"
     * the server into reading the store out of the URL.
     */
    const forged = await ask("/app", { shop: SHOP_B, token: tokenA, tokenIn: "query" });
    const forgedText = rendered(forged.html);
    check(
      "A `shop` parameter cannot redirect a valid token to another store",
      isApp(forged.html) && forgedText.includes(NAME_A) && !forgedText.includes(NAME_B),
      `HTTP ${forged.status}`
    );

    const listA = await ask("/app/status", { shop: SHOP_A, token: tokenA, tokenIn: "query" });
    check(
      "Another store's records are not in the page at all",
      !rendered(listA.html).includes(NAME_B) && !listA.html.includes(SHOP_B)
    );

    /* ------------------------------------------------------------------ */
    /* 5. An invalid token is refused                                      */
    /* ------------------------------------------------------------------ */
    const wrongSignature = await ask("/app", {
      shop: SHOP_A,
      token: mintToken(SHOP_A, { secret: `${API_SECRET}-not-the-secret` }),
      tokenIn: "query",
    });
    check(
      "A token signed with the wrong secret is refused",
      !isApp(wrongSignature.html) && !rendered(wrongSignature.html).includes(NAME_A),
      `HTTP ${wrongSignature.status}`
    );

    const wrongAudience = await ask("/app", {
      shop: SHOP_A,
      token: mintToken(SHOP_A, { key: "00000000000000000000000000000000" }),
      tokenIn: "query",
    });
    check(
      "A token minted for a different app is refused",
      !isApp(wrongAudience.html),
      `HTTP ${wrongAudience.status}`
    );

    const noToken = await ask("/app", { shop: SHOP_A, tokenIn: "none" });
    check(
      "An embedded request with no token at all is bounced, not rendered",
      noToken.status >= 300 && noToken.status < 400 && !isApp(noToken.html),
      `HTTP ${noToken.status}`
    );

    /* ------------------------------------------------------------------ */
    /* 6. An expired token recovers the supported way                      */
    /* ------------------------------------------------------------------ */
    const expired = await ask("/app", {
      shop: SHOP_A,
      token: mintToken(SHOP_A, { expiresIn: -120 }),
      tokenIn: "query",
    });
    const expiredTo = frameOf(expired.location);
    check(
      "An expired token on a document request goes to the bounce page",
      expired.status >= 300 && expired.status < 400 && expired.location.startsWith("/auth/session-token"),
      `HTTP ${expired.status} ${expired.location.slice(0, 60)}`
    );
    check(
      "And the bounce names the page to come back to",
      (expiredTo.get("shopify-reload") || "").includes("/app"),
      expiredTo.get("shopify-reload") || "(none)"
    );

    const bounce = await ask(
      `/auth/session-token${expired.location.includes("?") ? expired.location.slice(expired.location.indexOf("?")) : ""}`,
      { shop: SHOP_A, tokenIn: "none" }
    );
    check(
      "The bounce page carries App Bridge and the app's client id",
      bounce.status === 200 && bounce.html.includes('data-api-key="') && bounce.html.includes(API_KEY),
      `HTTP ${bounce.status}`
    );
    check(
      "And it carries the client SECRET nowhere",
      !bounce.html.includes(API_SECRET),
      "a secret in HTML is a secret in the browser"
    );

    const expiredData = await ask("/app.data", {
      token: mintToken(SHOP_A, { expiresIn: -120 }),
      tokenIn: "header",
      embedded: false,
      shop: "",
      headers: { Accept: "application/json" },
    });
    check(
      "An expired token on a data request asks App Bridge to retry with a fresh one",
      expiredData.status === 401 &&
        expiredData.headers.get("X-Shopify-Retry-Invalid-Session-Request") === "1",
      `HTTP ${expiredData.status}`
    );

    /* ------------------------------------------------------------------ */
    /* 7. Direct external access sees nothing                              */
    /* ------------------------------------------------------------------ */
    /*
     * The explanatory sentence belongs here and only here. What must not happen
     * is any of the store's own facts arriving with it.
     */
    for (const path of ["/app", "/app/catalog", "/app/orders", "/app/application"]) {
      const external = await ask(path, { tokenIn: "none", embedded: false, shop: "" });
      const text = rendered(external.html);
      check(
        `A direct visit to ${path} exposes no seller data`,
        !isApp(external.html) &&
          !text.includes(NAME_A) &&
          !text.includes(NAME_B) &&
          !text.includes(SHOP_A) &&
          !text.includes(SHOP_B),
        `HTTP ${external.status}`
      );
    }

    const doorway = await ask("/app/orders", { shop: SHOP_A, tokenIn: "none", embedded: false });
    check(
      "A store-named visit from outside the frame is sent to the admin entry point",
      doorway.status >= 300 &&
        doorway.status < 400 &&
        doorway.location.startsWith(`https://admin.shopify.com/store/${SHOP_A.replace(".myshopify.com", "")}/apps/`),
      doorway.location || "(none)"
    );

    const tokenOutside = await ask("/app/orders", {
      shop: SHOP_A,
      token: tokenA,
      tokenIn: "query",
      embedded: false,
    });
    check(
      "A valid token does not make a non-embedded visit an embedded one",
      tokenOutside.status >= 300 &&
        tokenOutside.status < 400 &&
        !isApp(tokenOutside.html),
      `HTTP ${tokenOutside.status}`
    );

    /* ------------------------------------------------------------------ */
    /* 8. Refresh, and a second refresh                                    */
    /* ------------------------------------------------------------------ */
    /*
     * What a refresh is: the browser re-asks the URL it is sitting on, which is
     * the destination of §1's hop, token and all. Nothing is consumed by the
     * first render, so the second one behaves identically.
     */
    const landing = nextPath(application.location);
    const first = await ask(landing, { shop: SHOP_A, token: tokenA, tokenIn: "query" });
    const second = await ask(landing, { shop: SHOP_A, token: tokenA, tokenIn: "query" });
    check(
      "Refreshing the embedded page renders the app again",
      first.status === 200 && isApp(first.html) && rendered(first.html).includes(NAME_A),
      `HTTP ${first.status}`
    );
    check(
      "And it still does on a second refresh",
      second.status === 200 && isApp(second.html) && rendered(second.html).includes(NAME_A),
      `HTTP ${second.status}`
    );

    /* ------------------------------------------------------------------ */
    /* 9. No cookie is involved                                            */
    /* ------------------------------------------------------------------ */
    /*
     * Nothing in this suite has a cookie jar, so every check above is already
     * "works without cookies". This one states the stronger half: the merchant
     * app does not hand one out either, so there is no third-party cookie for a
     * browser to withhold.
     */
    const setCookie = dashboard.headers.getSetCookie
      ? dashboard.headers.getSetCookie()
      : [dashboard.headers.get("set-cookie")].filter((value): value is string => value !== null);
    check(
      "The merchant app sets no session cookie at all",
      !setCookie.some((cookie) => /session|auth|token/i.test(cookie)),
      setCookie.join("; ").slice(0, 80) || "(none)"
    );

    /* ------------------------------------------------------------------ */
    /* 10. A self-identifying bot is refused before any session work       */
    /* ------------------------------------------------------------------ */
    const bot = await ask("/app", { shop: SHOP_A, token: tokenA, tokenIn: "query", bot: true });
    check(
      "A crawler is refused before authentication even starts",
      bot.status === 410,
      `HTTP ${bot.status}`
    );

    /* ------------------------------------------------------------------ */
    /* 11. Webhooks and the job runner are untouched by any of this        */
    /* ------------------------------------------------------------------ */
    const noHmac = await ask("/webhooks/app/uninstalled", {
      method: "POST",
      tokenIn: "none",
      embedded: false,
      shop: "",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    check(
      "A webhook with no HMAC is still refused",
      noHmac.status === 401 || noHmac.status === 400,
      `HTTP ${noHmac.status}`
    );

    const unconfiguredJobs = await ask("/jobs/run", {
      method: "POST",
      tokenIn: "none",
      embedded: false,
      shop: "",
    });
    check(
      "The job runner still fails closed without its secret",
      unconfiguredJobs.status === 401 || unconfiguredJobs.status === 503,
      `HTTP ${unconfiguredJobs.status}`
    );

    /* ------------------------------------------------------------------ */
    /* 12. The owner panel is a separate door                              */
    /* ------------------------------------------------------------------ */
    const adminLogin = await ask("/admin/login", { base: ADMIN_BASE, tokenIn: "none", embedded: false, shop: "" });
    check(
      "The owner panel still answers on its own host",
      adminLogin.status === 200 && !isApp(adminLogin.html),
      `HTTP ${adminLogin.status}`
    );

    const adminOnAppHost = await ask("/admin", { base: APP_BASE, tokenIn: "none", embedded: false, shop: "" });
    check(
      "Owner routes are not served on the merchant host",
      adminOnAppHost.status === 302 && adminOnAppHost.location.startsWith("http"),
      `HTTP ${adminOnAppHost.status} ${adminOnAppHost.location.slice(0, 50)}`
    );

    const adminWithShopifyToken = await ask("/admin", {
      base: ADMIN_BASE,
      token: tokenA,
      tokenIn: "header",
      embedded: false,
      shop: "",
    });
    check(
      "A Shopify session token is not an owner session",
      adminWithShopifyToken.status >= 300 && adminWithShopifyToken.status < 400,
      `HTTP ${adminWithShopifyToken.status}`
    );

    if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
      const login = await fetch(`${ADMIN_BASE}/admin/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ADMIN_BASE, "User-Agent": BROWSER_UA },
        body: new URLSearchParams({
          email: process.env.OWNER_EMAIL,
          password: process.env.OWNER_PASSWORD,
        }),
      });
      const cookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [];
      const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
      const merchantWithAdminCookie = await ask("/app", {
        tokenIn: "none",
        embedded: false,
        shop: "",
        headers: cookie ? { Cookie: cookie } : {},
      });
      check(
        "An owner session cookie opens nothing in the merchant app",
        cookie !== "" && !isApp(merchantWithAdminCookie.html),
        cookie ? `HTTP ${merchantWithAdminCookie.status}` : "login produced no cookie"
      );
    } else {
      skip(
        "An owner session cookie opens nothing in the merchant app",
        "no OWNER_EMAIL/OWNER_PASSWORD — only the HTTP harness provides those"
      );
    }

    /* ------------------------------------------------------------------ */
    /* 13. The rule, for the route that has not been written yet           */
    /* ------------------------------------------------------------------ */
    /*
     * Every check above pins a behaviour. This one pins the SOURCE, because the
     * way this defect comes back is somebody adding a route next year and
     * reaching for the shortest redirect in the language. A bare
     * `redirect("/app/...")` under the merchant app is the bug, in one line.
     */
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const routeDir = join(process.cwd(), "app", "routes");
    const offenders: string[] = [];
    for (const entry of readdirSync(routeDir)) {
      // `$` is in the class because a dynamic segment is a legal part of a
      // route filename (`app.packing-list.$shipmentId.tsx`) and such a route is
      // exactly as able to drop the frame context as any other.
      if (!/^app[.\w$-]*\.(jsx|tsx|ts|js)$/.test(entry)) continue;
      const source = readFileSync(join(routeDir, entry), "utf8");
      // A redirect to an internal merchant path, built inline rather than
      // through merchantRedirect, is the defect. Comments are stripped first so
      // that a rule written down in prose is not mistaken for a call.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\bredirect\(\s*[`"']\/app/.test(code)) offenders.push(entry);
    }
    check(
      "No merchant route redirects internally with a bare path",
      offenders.length === 0,
      offenders.join(", ") || "every internal redirect goes through merchantRedirect"
    );

    /* ------------------------------------------------------------------ */
    /* The fixtures are the fixtures                                       */
    /* ------------------------------------------------------------------ */
    /*
     * The suite is only measuring the app if the session row it wrote is the
     * row the app loaded. If the library's id scheme ever changes, the checks
     * above would silently be measuring a token exchange that a minted token
     * cannot survive — so this states the precondition rather than assuming it.
     */
    const stale = await prisma.session.findMany({
      where: { shop: { in: [SHOP_A, SHOP_B] } },
      select: { id: true, expires: true, accessToken: true },
    });
    check(
      "Both fixture sessions are still the ones written (nothing re-exchanged)",
      stale.length === 2 &&
        stale.every((row) => row.accessToken === "mvverify-not-a-real-token"),
      stale.map((row) => row.id).join(", ")
    );
    check(
      "And neither store's application was touched by a read",
      (await prisma.merchantApplication.count({
        where: { shopDomain: SHOP_A, contactName: "Alpha Contact" },
      })) === 1
    );

    /* ------------------------------------------------------------------ */
    /* The write side: a store cannot act as another                       */
    /* ------------------------------------------------------------------ */
    /*
     * Read isolation is §4. This is the other half: an action that writes,
     * driven with A's token and a body that names B. The action takes its
     * store from the session, so B is untouched — and A, which really did make
     * the request, is written.
     */
    const write = await ask("/app/settings", {
      method: "POST",
      token: tokenA,
      tokenIn: "header",
      shop: SHOP_B,
      embedded: false,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: APP_BASE },
      body: new URLSearchParams({
        intent: "contact",
        contactName: "Written By Alpha",
        contactEmail: "alpha@mvverify.invalid",
        contactPhone: "555-0100",
      }).toString(),
    });
    const writtenA = await prisma.merchantApplication.findUnique({ where: { id: a.application.id } });
    const writtenB = await prisma.merchantApplication.findUnique({ where: { id: b.application.id } });
    check(
      "An action writes the store the token names",
      writtenA?.contactName === "Written By Alpha",
      `HTTP ${write.status}`
    );
    check(
      "And cannot write the store the body names",
      writtenB?.contactName === "Bravo Contact",
      writtenB?.contactName || "(missing)"
    );
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(
    `\n=== ${total - failures}/${total} checks passed${skipped ? `, ${skipped} skipped` : ""} ===`
  );
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
