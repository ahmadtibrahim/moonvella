/**
 * Odoo connector guard verification.
 *
 * These tests exercise the safety properties, not the network. Nothing here
 * contacts an Odoo server, and nothing here can: the connector is unconfigured
 * by default and the tests that configure it point at a throwaway hostname.
 *
 * The suite runs against the ISOLATED verify database. It saves and clears the
 * `odoo` credential rows to prove the Settings form is actually wired into the
 * connector, so it snapshots them first and restores them at the end.
 *
 * Run: npm run verify:odoo  (or through deployment/mv-verify.sh)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const ODOO_ENV_KEYS = [
  "ODOO_URL",
  "ODOO_DATABASE",
  "ODOO_USERNAME",
  "ODOO_API_KEY",
  "ODOO_MODE",
  "ODOO_ALLOW_PROD_DB",
  "ODOO_ALLOW_WRITES",
  "ODOO_TIMEOUT_MS",
] as const;

function clearOdooEnv() {
  for (const key of ODOO_ENV_KEYS) delete process.env[key];
}

function configureOdoo(overrides: Record<string, string> = {}) {
  clearOdooEnv();
  process.env.ODOO_URL = "https://odoo.invalid";
  process.env.ODOO_DATABASE = "moonvella";
  process.env.ODOO_USERNAME = "svc_moonvella";
  process.env.ODOO_API_KEY = "test-key-not-real";
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
}

/** Strip comments so a static check inspects code, not the prose about it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function main() {
  const odoo = await import("~/services/odoo.server");
  const prisma = new PrismaClient();

  /* ------------------------------------------------------------------ */
  /* 0a. The partner-match rule, exhaustively and without a network.     */
  /*     This decides whether a second record for the same company ever  */
  /*     gets written, so it is tested on its own.                       */
  /* ------------------------------------------------------------------ */
  const P = (id: number, name: string, email: string | false, vat: string | false = false) => ({
    id,
    name,
    email,
    vat,
  });
  const partnerCases: Array<[string, [Parameters<typeof odoo.decidePartnerAction>[0], Parameters<typeof odoo.decidePartnerAction>[1]], string]> = [
    ["nothing matches => CREATE", [{ name: "New Co", email: "a@b.ca", vat: "123" }, []], "CREATE"],
    [
      "tax ID AND email both agree => REUSE (this is what makes a re-sync idempotent)",
      [{ name: "Acme", email: "ap@acme.ca", vat: "123456" }, [P(7, "Acme Inc", "ap@acme.ca", "123456")]],
      "REUSE",
    ],
    [
      "email differs but the tax ID is the same => REVIEW, never a second record",
      [{ name: "Acme", email: "new-ap@acme.ca", vat: "123456" }, [P(7, "Acme Inc", "ap@acme.ca", "123456")]],
      "REVIEW",
    ],
    [
      "email matches but no tax ID was supplied to corroborate it => REVIEW",
      [{ name: "Acme", email: "ap@acme.ca" }, [P(7, "Acme Inc", "ap@acme.ca", false)]],
      "REVIEW",
    ],
    [
      "email matches and the tax IDs disagree => REVIEW",
      [{ name: "Acme", email: "ap@acme.ca", vat: "999" }, [P(7, "Acme Inc", "ap@acme.ca", "123456")]],
      "REVIEW",
    ],
    [
      "two partners are touched => REVIEW, because MoonVella never merges",
      [
        { name: "Acme", email: "ap@acme.ca", vat: "123456" },
        [P(7, "Acme Inc", "ap@acme.ca", "123456"), P(8, "Acme Ltd", "other@acme.ca", "123456")],
      ],
      "REVIEW",
    ],
    [
      "tax ID comparison ignores case and spacing",
      [{ name: "Acme", email: "ap@acme.ca", vat: " 123 456 " }, [P(7, "Acme Inc", "AP@ACME.CA", "123456")]],
      "REUSE",
    ],
    [
      "a blank email never matches a partner whose email is blank",
      [{ name: "Acme", email: "", vat: "123456" }, [P(7, "Acme Inc", false, "123456")]],
      "REVIEW",
    ],
  ];
  for (const [label, args, expected] of partnerCases) {
    const decision = odoo.decidePartnerAction(args[0], args[1]);
    check(
      `partner match: ${label}`,
      decision.action === expected,
      decision.action === expected ? "" : `got ${decision.action} — ${decision.reason}`,
    );
  }

  const reuse = odoo.decidePartnerAction(
    { name: "Acme", email: "ap@acme.ca", vat: "123456" },
    [P(7, "Acme Inc", "ap@acme.ca", "123456")],
  );
  check("REUSE names the partner to reuse", reuse.partnerId === 7, String(reuse.partnerId));
  check(
    "a CREATE decision carries no partner id",
    odoo.decidePartnerAction({ name: "X", email: "x@y.ca" }, []).partnerId === null,
  );
  check(
    "a REVIEW decision carries no partner id, so nothing is reused on a guess",
    odoo.decidePartnerAction({ name: "X", email: "x@y.ca" }, [P(1, "Y", "x@y.ca")]).partnerId === null,
  );
  check(
    "a REVIEW decision returns its candidates, so a person can look at them",
    odoo.decidePartnerAction({ name: "X", email: "x@y.ca" }, [P(1, "Y", "x@y.ca")]).candidates.length === 1,
  );
  check(
    "the connector offers a read-only partner lookup alongside the writer",
    typeof odoo.resolvePartner === "function",
  );

  /* ------------------------------------------------------------------ */
  /* 0. Snapshot the odoo integration rows, so the writes below are      */
  /*    reversible and this suite cannot leave the clone reconfigured.   */
  /* ------------------------------------------------------------------ */
  const savedState = await prisma.integrationState.findMany({ where: { key: "odoo" } });
  const savedCreds = await prisma.integrationCredential.findMany({ where: { key: "odoo" } });

  const clearOdooStore = async () => {
    await prisma.integrationCredential.deleteMany({ where: { key: "odoo" } });
    await prisma.integrationState.deleteMany({ where: { key: "odoo" } });
  };

  try {
    /* ---------------------------------------------------------------- */
    /* 1. The connector must contain no database access of any kind.     */
    /* ---------------------------------------------------------------- */
    const rawSource = readFileSync(resolve("app/services/odoo.server.ts"), "utf8");
    const source = stripComments(rawSource);
    const forbidden = [
      { pattern: /from\s+["']\.\/db\.server["']/, label: "import ~/db.server" },
      { pattern: /\bnew\s+PrismaClient\b/, label: "construct a PrismaClient" },
      { pattern: /from\s+["']pg["']/, label: "import pg" },
      { pattern: /\bSELECT\s+[\s\S]{0,40}\bFROM\b/i, label: "contain raw SQL" },
      { pattern: /DATABASE_URL/, label: "read DATABASE_URL" },
    ];
    for (const { pattern, label } of forbidden) {
      check(`connector does not ${label}`, !pattern.test(source));
    }
    check(
      "connector speaks JSON-RPC over the Odoo API",
      source.includes("/jsonrpc") && source.includes("execute_kw"),
    );

    /* ---------------------------------------------------------------- */
    /* 1b. No private (`_`-prefixed) model method may be called over RPC. */
    /*                                                                   */
    /* Odoo 18 refuses these outright: odoo/service/model.py execute_cr  */
    /* calls get_public_method(), which raises AccessError for any name  */
    /* starting with "_". A call would fail every time, for everyone,    */
    /* regardless of the account's permissions.                          */
    /* ---------------------------------------------------------------- */
    const quoted = source.match(/["'`][^"'`\n]*["'`]/g) ?? [];
    const privateCalls = quoted.filter((literal) => /^["'`]_[a-z]/i.test(literal));
    check(
      "connector never passes a private `_`-prefixed method name",
      privateCalls.length === 0,
      privateCalls.length ? `found ${privateCalls.join(", ")}` : "none",
    );
    check(
      "invoicing uses the public sale.advance.payment.inv wizard",
      source.includes("sale.advance.payment.inv") &&
        source.includes("create_invoices") &&
        !source.includes('"_create_invoices"'),
    );

    /* ---------------------------------------------------------------- */
    /* 2. Prod-db guard.                                                 */
    /* ---------------------------------------------------------------- */
    const protectedVariants = ["Prod-db", "prod-db", "PROD-DB", "  Prod-db  "];
    for (const variant of protectedVariants) {
      let threw = false;
      try {
        odoo.assertDatabaseAllowed(variant);
      } catch (error) {
        threw = error instanceof odoo.OdooDatabaseBlockedError;
      }
      check(`Prod-db guard blocks ${JSON.stringify(variant)}`, threw);
    }

    for (const safe of ["moonvella", "moonvella_uat", "Prod-db-test1a", "odoo_staging"]) {
      let allowed = true;
      try {
        odoo.assertDatabaseAllowed(safe);
      } catch {
        allowed = false;
      }
      check(`Prod-db guard allows ${JSON.stringify(safe)}`, allowed);
    }

    let overrideWorked = false;
    process.env.ODOO_ALLOW_PROD_DB = "yes";
    try {
      odoo.assertDatabaseAllowed("Prod-db");
      overrideWorked = true;
    } catch {
      overrideWorked = false;
    }
    check("explicit ODOO_ALLOW_PROD_DB=yes override is honoured", overrideWorked);
    delete process.env.ODOO_ALLOW_PROD_DB;

    /* ---------------------------------------------------------------- */
    /* 3. Unconfigured => disabled and inert.                            */
    /* ---------------------------------------------------------------- */
    await clearOdooStore();
    clearOdooEnv();
    check("unconfigured: odooConfigured() is false", (await odoo.odooConfigured()) === false);
    check("unconfigured: odooMode() is 'disabled'", (await odoo.odooMode()) === "disabled");

    let writeBlocked = false;
    try {
      await odoo.assertWriteAllowed("test write");
    } catch (error) {
      writeBlocked = error instanceof odoo.OdooWriteBlockedError;
    }
    check("unconfigured: writes are refused", writeBlocked);

    const health = await odoo.checkOdooHealth();
    check(
      "unconfigured: checkOdooHealth() reports not-configured without throwing",
      health.configured === false && health.ok === false,
    );

    /* ---------------------------------------------------------------- */
    /* 4. Placeholder values must count as unconfigured, not as real.     */
    /* ---------------------------------------------------------------- */
    clearOdooEnv();
    process.env.ODOO_URL = "https://odoo.invalid";
    process.env.ODOO_DATABASE = "moonvella";
    process.env.ODOO_USERNAME = "__REQUIRED_NOT_SET__";
    process.env.ODOO_API_KEY = "__REQUIRED_NOT_SET__";
    check(
      "placeholder credentials are treated as unconfigured",
      (await odoo.odooConfigured()) === false,
    );

    /* ---------------------------------------------------------------- */
    /* 5. Mode ladder: readonly by default, live only on request.         */
    /*    Writes need TWO independent keys.                               */
    /* ---------------------------------------------------------------- */
    configureOdoo();
    check(
      "configured with no ODOO_MODE: defaults to 'readonly'",
      (await odoo.odooMode()) === "readonly",
    );

    let readonlyBlocked = false;
    try {
      await odoo.assertWriteAllowed("test write");
    } catch (error) {
      readonlyBlocked = error instanceof odoo.OdooWriteBlockedError;
    }
    check("readonly mode refuses writes", readonlyBlocked);

    configureOdoo({ ODOO_MODE: "readonly" });
    check("ODOO_MODE=readonly is respected", (await odoo.odooMode()) === "readonly");

    // The two-key rule. ODOO_MODE is settable from the Settings form; the
    // deployment-only switch is not, so the form cannot grant writes alone.
    configureOdoo({ ODOO_MODE: "live" });
    check(
      "ODOO_MODE=live ALONE is not enough: still readonly without ODOO_ALLOW_WRITES",
      (await odoo.odooMode()) === "readonly",
    );
    let liveAloneBlocked = false;
    try {
      await odoo.assertWriteAllowed("test write");
    } catch (error) {
      liveAloneBlocked = error instanceof odoo.OdooWriteBlockedError;
    }
    check("live without the deployment switch refuses writes", liveAloneBlocked);

    configureOdoo({ ODOO_MODE: "live", ODOO_ALLOW_WRITES: "yes" });
    check(
      "ODOO_MODE=live + ODOO_ALLOW_WRITES=yes is honoured",
      (await odoo.odooMode()) === "live",
    );
    let liveAllowed = true;
    try {
      await odoo.assertWriteAllowed("test write");
    } catch {
      liveAllowed = false;
    }
    check("live + deployment switch permits writes", liveAllowed);

    configureOdoo({ ODOO_MODE: "disabled", ODOO_ALLOW_WRITES: "yes" });
    check(
      "ODOO_MODE=disabled wins over configured credentials and an open switch",
      (await odoo.odooMode()) === "disabled",
    );

    // Nonsense modes must fail closed to readonly, never open to live.
    configureOdoo({ ODOO_MODE: "LIVE please", ODOO_ALLOW_WRITES: "yes" });
    check("an unrecognised ODOO_MODE falls back to readonly", (await odoo.odooMode()) === "readonly");

    /* ---------------------------------------------------------------- */
    /* 5b. The same ladder, exhaustively, as a pure function.             */
    /* ---------------------------------------------------------------- */
    const ladder: Array<[Parameters<typeof odoo.classifyOdooMode>[0], string]> = [
      [{ configured: false, mode: "live", writesAllowed: true }, "disabled"],
      [{ configured: true, mode: null, writesAllowed: false }, "readonly"],
      [{ configured: true, mode: null, writesAllowed: true }, "readonly"],
      [{ configured: true, mode: "readonly", writesAllowed: true }, "readonly"],
      [{ configured: true, mode: "live", writesAllowed: false }, "readonly"],
      [{ configured: true, mode: "live", writesAllowed: true }, "live"],
      [{ configured: true, mode: "disabled", writesAllowed: true }, "disabled"],
      [{ configured: true, mode: "off", writesAllowed: true }, "disabled"],
      [{ configured: true, mode: " LIVE ", writesAllowed: true }, "live"],
      [{ configured: true, mode: "garbage", writesAllowed: true }, "readonly"],
    ];
    for (const [input, expected] of ladder) {
      const got = odoo.classifyOdooMode(input);
      check(
        `classifyOdooMode(${JSON.stringify(input.mode)}, writes=${input.writesAllowed}, cfg=${input.configured}) = ${expected}`,
        got === expected,
        got === expected ? "" : `got ${got}`,
      );
    }

    /* ---------------------------------------------------------------- */
    /* 6. Prod-db guard still applies when fully configured for live.     */
    /* ---------------------------------------------------------------- */
    configureOdoo({ ODOO_MODE: "live", ODOO_ALLOW_WRITES: "yes", ODOO_DATABASE: "Prod-db" });
    let liveButBlocked = false;
    try {
      await odoo.authenticate();
    } catch (error) {
      liveButBlocked = error instanceof odoo.OdooDatabaseBlockedError;
    }
    check(
      "live mode + Prod-db is still refused before any network call",
      liveButBlocked,
    );

    const blockedHealth = await odoo.checkOdooHealth();
    check(
      "health reports the Prod-db block explicitly",
      blockedHealth.databaseBlocked === true && blockedHealth.ok === false,
    );

    const described = await odoo.describeOdooIntegration();
    check(
      "integration panel reports BLOCKED for Prod-db",
      described.status === "BLOCKED",
    );

    /* ---------------------------------------------------------------- */
    /* 7. Write preview: unconfirmed writes describe, they do not execute. */
    /* ---------------------------------------------------------------- */
    configureOdoo({ ODOO_MODE: "live", ODOO_ALLOW_WRITES: "yes" });
    const preview = await odoo.createSaleOrder({
      partnerId: 1,
      lines: [{ productId: 2, quantity: 1, priceUnit: 10 }],
    });
    check(
      "unconfirmed createSaleOrder returns a preview",
      (preview as { executed?: boolean }).executed === false,
    );
    check(
      "preview names the operation and payload",
      (preview as { operation?: string }).operation === "sale.order.create" &&
        (preview as { payload?: unknown }).payload !== undefined,
    );

    const partnerPreview = await odoo.upsertPartner({
      name: "Test Co",
      email: "test@example.invalid",
    });
    check(
      "unconfirmed upsertPartner returns a preview",
      (partnerPreview as { executed?: boolean }).executed === false,
    );

    /* ---------------------------------------------------------------- */
    /* 7b. A permit is REQUIRED by the transport, so a forgotten await    */
    /*     fails closed instead of writing.                               */
    /* ---------------------------------------------------------------- */
    const permit = await odoo.assertWriteAllowed("test write");
    check(
      "assertWriteAllowed returns a permit when it passes",
      odoo.isWritePermit(permit) === true,
    );
    check(
      "a bare promise is not a permit (a missed await fails closed)",
      odoo.isWritePermit(Promise.resolve(permit)) === false,
    );
    check("undefined is not a permit", odoo.isWritePermit(undefined) === false);
    check("a plain object is not a permit", odoo.isWritePermit({ operation: "x" }) === false);

    /* ---------------------------------------------------------------- */
    /* 8. Invoice selection is scoped to the order and company, and can   */
    /*    never be "the most recent invoice in the database".             */
    /* ---------------------------------------------------------------- */
    const domainA = odoo.invoiceDomainForSaleOrder({ saleOrderId: 41, companyId: 1 });
    const domainB = odoo.invoiceDomainForSaleOrder({ saleOrderId: 42, companyId: 1 });
    const flatA = JSON.stringify(domainA);

    check(
      "invoice domain is scoped to the exact sale order",
      flatA.includes("line_ids.sale_line_ids.order_id") && flatA.includes("41"),
    );
    check(
      "invoice domain is scoped to the company",
      flatA.includes("company_id") && flatA.includes("1"),
    );
    check(
      "invoice domain asks only for customer invoices",
      flatA.includes("move_type") && flatA.includes("out_invoice"),
    );
    check(
      "invoice domain does not select by invoice_origin (a display string)",
      !flatA.includes("invoice_origin"),
    );
    check(
      "two different orders produce different domains (it cannot match another order)",
      JSON.stringify(domainA) !== JSON.stringify(domainB),
    );
    check(
      "the connector contains no order-by-recency fallback",
      !/order:\s*["']id desc["']/.test(source),
    );

    /* ---------------------------------------------------------------- */
    /* 9. Settings credentials actually reach the connector.              */
    /*    This is the wiring that the previous version lacked: the form    */
    /*    saved rows the connector never read.                            */
    /* ---------------------------------------------------------------- */
    const { saveCredentials, disconnectCredentials } = await import("~/services/credentials.server");

    await clearOdooStore();
    clearOdooEnv();
    check(
      "with nothing stored and no env, the connector is unconfigured",
      (await odoo.odooConfigured()) === false,
    );

    await saveCredentials("odoo", {
      ODOO_URL: "https://odoo-from-settings.invalid",
      ODOO_DATABASE: "moonvella_settings",
      ODOO_USERNAME: "svc_from_settings",
      ODOO_API_KEY: "key-from-settings",
      ODOO_MODE: "readonly",
    });

    const wired = await odoo.resolveOdooConfig();
    check(
      "a credential saved in Settings is picked up by the connector",
      wired !== null && wired.database === "moonvella_settings",
      wired ? `database=${wired.database}` : "null",
    );
    check(
      "the connector reads the stored username too",
      wired?.username === "svc_from_settings",
    );
    check(
      "stored mode is honoured without a deployment",
      (await odoo.odooMode()) === "readonly",
    );

    // Masking: the identifiers may be shown, the API key may not.
    const masked = await odoo.maskedOdooConnection();
    check(
      "masked connection exposes url/database/username but only WHETHER the key is set",
      masked?.database === "moonvella_settings" &&
        masked?.apiKeySet === true &&
        !JSON.stringify(masked).includes("key-from-settings"),
    );

    // Disconnect must genuinely suppress the store, exactly as it does for the
    // other providers.
    await disconnectCredentials("odoo");
    check(
      "Disconnect suppresses the stored credentials",
      (await odoo.odooConfigured()) === false,
    );

    /* ---------------------------------------------------------------- */
    /* 10. Unreachable host is reported, never silently swallowed.        */
    /* ---------------------------------------------------------------- */
    await clearOdooStore();
    configureOdoo({ ODOO_URL: "https://odoo.invalid", ODOO_MODE: "readonly" });
    const unreachable = await odoo.checkOdooHealth();
    check(
      "unreachable Odoo is reported as not-ok with an error",
      unreachable.ok === false && typeof unreachable.error === "string",
    );

    /* ---------------------------------------------------------------- */
    /* 11. "Test connection" performs real authentication.                */
    /* ---------------------------------------------------------------- */
    await clearOdooStore();
    clearOdooEnv();
    const noCreds = await odoo.testOdooConnection();
    check(
      "testOdooConnection reports not-configured without throwing",
      noCreds.ok === false && noCreds.configured === false,
    );

    configureOdoo({ ODOO_URL: "https://odoo.invalid", ODOO_MODE: "readonly" });
    const unreachableAuth = await odoo.testOdooConnection();
    check(
      "testOdooConnection reports a real failure against an unreachable host",
      unreachableAuth.ok === false && typeof unreachableAuth.reason === "string",
      unreachableAuth.reason ?? "",
    );
    check(
      "a failed test still reports the connection it tried",
      unreachableAuth.database === "moonvella" && unreachableAuth.username === "svc_moonvella",
    );

    // An unreachable host is not a configured-and-working one. This is the
    // distinction the previous presence-check could not make.
    check(
      "an unreachable host is NOT reported as ok",
      unreachableAuth.ok === false,
    );
  } finally {
    /* ------------------------------------------------------------------ */
    /* Restore whatever the clone had before this suite ran.               */
    /* ------------------------------------------------------------------ */
    await clearOdooStore();
    for (const row of savedCreds) {
      await prisma.integrationCredential.create({ data: { ...row, updatedAt: undefined } });
    }
    for (const row of savedState) {
      await prisma.integrationState.create({ data: { ...row, updatedAt: undefined } });
    }
    console.log(
      `\nrestored ${savedCreds.length} stored odoo credential(s) and ${savedState.length} state row(s).`,
    );
    await prisma.$disconnect();
  }

  clearOdooEnv();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failed > 0) {
    console.log(`\n${failed} FAILED:`);
    for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
