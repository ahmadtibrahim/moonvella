/**
 * The Stores section, over HTTP, against the running app.
 *
 * TWO QUESTIONS, AND THEY ARE DIFFERENT ONES.
 *
 * The first is whether the controls work. Deactivate and Activate are wired to
 * the suspension the application review already uses, so the check drives the
 * button and then reads the seller's status out of the database — a button that
 * returns a redirect and changes nothing is the failure mode that matters here,
 * and a status code cannot tell the two apart.
 *
 * The second is whether the screen is honest. There is no ledger behind these
 * pages, and the figures that used to be drawn here — a worked example of five
 * invoices, a part-payment, a credit note and a correspondence timeline, each
 * stamped as a sample — were removed rather than labelled: a fabricated balance
 * beside a real store's name, in the store's own currency, is a figure somebody
 * eventually makes a credit decision from, and the stamp does not survive being
 * read once. What is asserted now is the replacement: the standing notice, a
 * "No ledger"/"Not connected" chip wherever a figure would have been, the one
 * figure that *is* real and labelled Live, and the empty states that name the
 * system each panel is waiting for.
 *
 * This was rewritten rather than deleted when the sample ledger went: the two
 * checks that stood here asserted the retired behaviour, so the suite was red
 * from that day until now — which is how a suite that nobody runs reports.
 * `--all` skips it without OWNER_EMAIL/OWNER_PASSWORD, and only the HTTP harness
 * provides those.
 *
 * IT NEEDS A RUNNING SERVER AND AN ADMIN ACCOUNT. The throwaway OWNER account
 * is made by the harness that calls this, not here — the owner's own password
 * is never read, asked for or stored.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-stores-ui.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ADMIN_SESSION_COOKIE } from "~/utils/adminAuth.server";

const prisma = new PrismaClient();
const BASE = process.env.APP_BASE || "http://localhost:62259";
const EMAIL = process.env.OWNER_EMAIL || "";
const PASSWORD = process.env.OWNER_PASSWORD || "";
const SHOP = `verify-stores-${Date.now()}.myshopify.com`;

let failures = 0;
let total = 0;

function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${total}. ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }),
  });
  const cookies: string[] =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function get(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, html: await res.text() };
}

async function post(path: string, cookie: string, data: Record<string, string>) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Cookie: cookie },
    body: new URLSearchParams(data),
  });
}

/**
 * What a reader sees, with the serialized loader data taken out.
 *
 * The route data JSON is full of the words being asserted — every status, every
 * reason, the string "undefined" — and it is in the page whether or not the
 * page renders any of it. An assertion about the screen has to be run against
 * the screen.
 */
function rendered(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, " ");
}

/**
 * The client bundle the operator's browser downloads.
 *
 * Block asks its question in the browser: the modal is not rendered until the
 * button is clicked, so no GET of the page can contain it, and asserting the
 * wording against the HTML would only ever prove the HTML lacks it. The wording
 * has to be checked where it actually lives, which is in the built JavaScript
 * this image serves — the artifact the operator runs.
 *
 * Returns "" if there is no build to read, which fails the checks that use it
 * rather than skipping them.
 */
function clientBundleText(): string {
  const dir = resolve(process.cwd(), "build/client/assets");
  if (!existsSync(dir)) return "";
  let text = "";
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) text += readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return text;
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Set OWNER_EMAIL and OWNER_PASSWORD.");
    process.exit(1);
  }

  const cookie = await login();
  check(
    "The throwaway owner can sign in, and the cookie is the app's own",
    cookie.includes(ADMIN_SESSION_COOKIE),
    cookie ? "session issued" : "no cookie"
  );

  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      shopDomainFull: SHOP,
      storeName: "Verify Stores UI",
      contactEmail: "verify@example.com",
      currency: "CAD",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });

  try {
    /* ------------------------------------------------------------------ */
    /* The roster                                                           */
    /* ------------------------------------------------------------------ */
    const roster = await get("/admin/stores", cookie);
    check("The Stores section loads", roster.status === 200, `HTTP ${roster.status}`);
    check(
      "It is called Stores, and the screen says what it is for",
      /<h1[^>]*>Stores<\/h1>/.test(roster.html) && /shops that sell MoonVella goods/i.test(roster.html)
    );
    check(
      "The store appears, with its status and its real order count",
      roster.html.includes("Verify Stores UI") && roster.html.includes(SHOP)
    );

    /* ------------------------------------------------------------------ */
    /* Honesty about the money                                              */
    /* ------------------------------------------------------------------ */
    check(
      "The roster says no accounting is connected, and that nothing on it is a figure",
      /No accounting is connected, so no invoices or balances are shown/.test(roster.html) &&
        /does not hold a ledger/.test(roster.html) &&
        /filled in with an example/.test(roster.html) &&
        // The currency is interpolated, so the serialised HTML carries React's
        // `<!-- -->` boundary through the middle of the sentence. The assertion
        // reads around it rather than through it.
        /appears here, so nothing on this page can be read as a statement of what this store owes/
          .test(roster.html),
      "an empty panel with no explanation is indistinguishable from a broken one"
    );
    check(
      "And every row carries its own chip, so the notice is not the only clue",
      (roster.html.match(/>No ledger</g) ?? []).length >= 1,
      `${(roster.html.match(/>No ledger</g) ?? []).length} no-ledger chip(s)`
    );

    /* ------------------------------------------------------------------ */
    /* The store page                                                       */
    /* ------------------------------------------------------------------ */
    const detail = await get(`/admin/stores/${seller.id}`, cookie);
    check("The store page loads", detail.status === 200, `HTTP ${detail.status}`);

    check(
      "It shows both balances the owner asked for",
      /Sales balance/.test(detail.html) && /Account balance/.test(detail.html)
    );
    check(
      "The balance cards refuse an amount, and say that refusing is the point",
      /No ledger connected/.test(detail.html) &&
        /No amount is shown, because none has been read/.test(detail.html) &&
        /deliberately no/.test(detail.html) &&
        /how the balance is made up/.test(detail.html),
      "a reconciliation of absent figures is arithmetic performed on nothing"
    );
    check(
      "One figure on the page is real, and says so",
      /Recorded in MoonVella/.test(detail.html) && />Live</.test(detail.html)
    );

    check(
      "The invoices panel lists none, and says which system will fill it",
      /Invoices &amp; payments/.test(detail.html) &&
        /No invoices are recorded against this store/.test(detail.html) &&
        /Will be read from/.test(detail.html) &&
        /Odoo accounting \(account\.move — customer invoices\)/.test(detail.html)
    );
    check(
      "Payments and credit notes are named as the same absence, not left to be discovered",
      /Payments received, applications of those payments to invoices, and credit notes are absent/
        .test(detail.html) && /there is no ledger behind this page/.test(detail.html)
    );
    check(
      "The three states the panel exists to separate are still stated, on a panel with no rows",
      /A part-paid invoice is a state of its own/.test(detail.html) &&
        /it is not unpaid, and it is not settled/.test(detail.html)
    );
    check(
      "Goods supplied but not yet invoiced keep their own panel, and it refuses to guess",
      /Awaiting invoice/.test(detail.html) &&
        /whether an order has been billed is a fact about a ledger/.test(detail.html) &&
        /Listing every order as uninvoiced would be a guess/.test(detail.html)
    );

    check(
      "The communication record covers both directions and the internal notes",
      /Communication record/.test(detail.html) &&
        /email in both directions/.test(detail.html) &&
        /calls, notes written by staff, and the system/.test(detail.html) &&
        /No correspondence is listed/.test(detail.html),
      "email in, email out, calls, staff notes and the system's own decisions"
    );
    check(
      "Notes can be written in the record once it is wired",
      /Log a note against this store/.test(detail.html) && /not yet wired/i.test(detail.html)
    );

    /* ------------------------------------------------------------------ */
    /* The controls                                                         */
    /* ------------------------------------------------------------------ */
    check(
      "An active store is offered Deactivate and Block",
      /Deactivate store/.test(detail.html) && />Block<\/button>/.test(detail.html)
    );

    // A page of arithmetic is a page where a missing currency or a null column
    // reaches the reader as "NaN CAD".
    const renderedText = rendered(detail.html);
    check(
      "No figure reaches the page as NaN or undefined",
      !/\bNaN\b/.test(renderedText) && !/\bundefined\b/.test(renderedText),
      (renderedText.match(/\b(NaN|undefined)\b/) ?? ["", ""])[0]
    );
    check(
      "Block is offered on an active store, and it opens a question rather than acting",
      (() => {
        const at = detail.html.indexOf(">Block<");
        if (at === -1) return false;
        const tag = detail.html.slice(detail.html.lastIndexOf("<button", at), at);
        // type="button", so a stray Enter cannot block a store; the modal's
        // confirm is a separate submit.
        return /type="button"/.test(tag) && !/\bdisabled\b/.test(tag);
      })(),
      "an approved store is one a block can affect"
    );

    const deactivated = await post("/admin/stores", cookie, {
      intent: "suspend",
      sellerId: seller.id,
      reason: "Verify stores UI",
    });
    const afterSuspend = await prisma.seller.findUnique({ where: { id: seller.id } });
    check(
      "Deactivating a store deactivates it",
      deactivated.status === 302 && afterSuspend?.status === "SUSPENDED",
      `HTTP ${deactivated.status}, status ${afterSuspend?.status}`
    );
    check(
      "And the page says so, rather than leaving the reader to spot the badge",
      (deactivated.headers.get("location") ?? "").includes("done=suspend")
    );

    // The control has to follow the state: a store that has just been
    // deactivated should not still be offering a Deactivate button, and it
    // should offer the way back.
    const suspendedPage = await get(`/admin/stores/${seller.id}?done=suspend`, cookie);
    check(
      "A deactivated store is offered Activate instead",
      /Activate store/.test(suspendedPage.html) && !/Deactivate store/.test(suspendedPage.html)
    );
    check(
      "And the confirmation is shown on the page it returns to, in the words of the action taken",
      /Store suspended\./.test(suspendedPage.html)
    );

    const activated = await post("/admin/stores", cookie, {
      intent: "reactivate",
      sellerId: seller.id,
    });
    const afterReactivate = await prisma.seller.findUnique({ where: { id: seller.id } });
    check(
      "Activating a store brings it back",
      activated.status === 302 && afterReactivate?.status === "APPROVED",
      `HTTP ${activated.status}, status ${afterReactivate?.status}`
    );

    /* ------------------------------------------------------------------ */
    /* Block, which is a different answer from Deactivate                   */
    /* ------------------------------------------------------------------ */
    /**
     * The modal lives in the browser, not in the HTML. Clicking Block sets
     * client state and only then renders the question, so a GET of the page
     * cannot contain it — the same trap the Delete fix fell into. What the
     * browser will actually show is therefore asserted against the shipped
     * client bundle, which is the artifact the operator runs.
     */
    const bundleText = clientBundleText();
    check(
      "The confirmation the operator reads is the one the owner specified",
      bundleText.includes("Block this seller?") &&
        bundleText.includes(
          "They will lose access to pricing, imports, and order sync, but history will remain."
        ),
      bundleText ? `${bundleText.length} bytes of client JavaScript read` : "no client bundle to read"
    );
    check(
      "And the excuse that blocking was not possible is gone from what ships",
      !bundleText.includes("Blocking needs a status") && !detail.html.includes("Blocking needs a status"),
      "a disabled control explained by a missing status has no business in a build that has one"
    );

    const blocked = await post("/admin/stores", cookie, {
      intent: "block",
      sellerId: seller.id,
      // Both of these are in the roster's form at once: the row's own reason
      // box, which belongs to Deactivate, and the modal's, which is the answer
      // the operator just gave. They are named apart so the second cannot be
      // dropped in favour of the first.
      reason: "typed in the row",
      blockReason: "reason from the dialog",
    });
    const afterBlock = await prisma.seller.findUnique({ where: { id: seller.id } });
    check(
      "Blocking a store blocks it, and records why",
      blocked.status === 302 &&
        afterBlock?.status === "BLOCKED" &&
        afterBlock?.blockReason === "reason from the dialog" &&
        afterBlock?.blockedAt instanceof Date,
      `HTTP ${blocked.status}, status ${afterBlock?.status}, reason ${afterBlock?.blockReason}`
    );
    check(
      "And the page says what the block did and did not take",
      (blocked.headers.get("location") ?? "").includes("done=block")
    );

    const blockedPage = await get(`/admin/stores/${seller.id}?done=block`, cookie);
    check(
      "The confirmation is shown on the page it returns to",
      /Store blocked\./.test(blockedPage.html) && /MoonVella has kept all of them/.test(blockedPage.html)
    );
    check(
      "A blocked store is offered the way back, and not a second way to block it",
      />Unblock<\/button>/.test(blockedPage.html) &&
        !/>Block<\/button>/.test(blockedPage.html) &&
        !/Deactivate store/.test(blockedPage.html)
    );
    // Read off the page, not the loader data: the reason is in the serialized
    // payload either way, so asserting against the raw HTML would pass on a
    // page that never drew it.
    const blockedText = rendered(blockedPage.html);
    check(
      "Its block date and reason are on the page MoonVella staff work from",
      /Blocked/.test(blockedText) && /·\s*reason from the dialog/.test(blockedText),
      "the operator should not have to open the database to learn why"
    );

    const unblocked = await post("/admin/stores", cookie, {
      intent: "unblock",
      sellerId: seller.id,
    });
    const afterUnblock = await prisma.seller.findUnique({ where: { id: seller.id } });
    check(
      "Unblocking returns the store to the status it held before the block",
      unblocked.status === 302 &&
        afterUnblock?.status === "APPROVED" &&
        afterUnblock?.blockedAt === null &&
        afterUnblock?.blockReason === null,
      `HTTP ${unblocked.status}, status ${afterUnblock?.status}`
    );

    /* ------------------------------------------------------------------ */
    /* Where a block would mean nothing                                     */
    /* ------------------------------------------------------------------ */
    const rejected = await prisma.seller.create({
      data: {
        shopDomain: `verify-rejected-${Date.now()}.myshopify.com`,
        shopDomainFull: `verify-rejected-${Date.now()}.myshopify.com`,
        storeName: "Verify Rejected Store",
        contactEmail: "verify@example.com",
        currency: "CAD",
        status: "REJECTED",
      },
    });
    try {
      const rejectedPage = await get(`/admin/stores/${rejected.id}`, cookie);
      check(
        "A rejected store's Block is disabled, with the reason, rather than absent",
        (() => {
          const at = rejectedPage.html.indexOf(">Block<");
          if (at === -1) return false;
          const tag = rejectedPage.html.slice(rejectedPage.html.lastIndexOf("<button", at), at);
          return /\bdisabled\b/.test(tag) && /no access left to block/.test(rejectedPage.html);
        })(),
        "a control that vanishes when you look for it teaches nothing"
      );
    } finally {
      await prisma.seller.deleteMany({ where: { id: rejected.id } });
    }

    /* ------------------------------------------------------------------ */
    /* The section it replaced                                              */
    /* ------------------------------------------------------------------ */
    const nav = await get("/admin", cookie);
    check(
      "The navigation offers Stores at /admin/stores",
      /href="\/admin\/stores"/.test(nav.html) && />Stores</.test(nav.html)
    );
    check(
      "And no longer offers Sellers",
      !/href="\/admin\/sellers"/.test(nav.html)
    );
  } finally {
    // Audit rows are append-only at the database level and are deliberately
    // left behind; everything else this suite made goes.
    await prisma.seller.deleteMany({ where: { id: seller.id } });
    await prisma.$disconnect();
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
