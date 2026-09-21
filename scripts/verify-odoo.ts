/**
 * Odoo connector guard verification.
 *
 * These tests exercise the safety properties, not the network. Nothing here
 * contacts an Odoo server, and nothing here can: the connector is unconfigured
 * by default and the tests that configure it point at a throwaway hostname.
 *
 * Run: npm run verify:odoo
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

async function main() {
  const odoo = await import("~/services/odoo.server");

  /* ------------------------------------------------------------------ */
  /* 1. The connector must contain no database access of any kind.       */
  /* ------------------------------------------------------------------ */
  const source = readFileSync(resolve("app/services/odoo.server.ts"), "utf8");
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

  /* ------------------------------------------------------------------ */
  /* 2. Prod-db guard.                                                   */
  /* ------------------------------------------------------------------ */
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

  /* ------------------------------------------------------------------ */
  /* 3. Unconfigured => disabled and inert.                              */
  /* ------------------------------------------------------------------ */
  clearOdooEnv();
  check("unconfigured: odooConfigured() is false", odoo.odooConfigured() === false);
  check("unconfigured: odooMode() is 'disabled'", odoo.odooMode() === "disabled");

  let writeBlocked = false;
  try {
    odoo.assertWriteAllowed("test write");
  } catch (error) {
    writeBlocked = error instanceof odoo.OdooWriteBlockedError;
  }
  check("unconfigured: writes are refused", writeBlocked);

  const health = await odoo.checkOdooHealth();
  check(
    "unconfigured: checkOdooHealth() reports not-configured without throwing",
    health.configured === false && health.ok === false,
  );

  /* ------------------------------------------------------------------ */
  /* 4. Placeholder values must count as unconfigured, not as real.      */
  /* ------------------------------------------------------------------ */
  clearOdooEnv();
  process.env.ODOO_URL = "https://odoo.invalid";
  process.env.ODOO_DATABASE = "moonvella";
  process.env.ODOO_USERNAME = "__REQUIRED_NOT_SET__";
  process.env.ODOO_API_KEY = "__REQUIRED_NOT_SET__";
  check(
    "placeholder credentials are treated as unconfigured",
    odoo.odooConfigured() === false,
  );

  /* ------------------------------------------------------------------ */
  /* 5. Mode ladder: readonly by default, live only on request.          */
  /* ------------------------------------------------------------------ */
  configureOdoo();
  check("configured with no ODOO_MODE: defaults to 'readonly'", odoo.odooMode() === "readonly");

  let readonlyBlocked = false;
  try {
    odoo.assertWriteAllowed("test write");
  } catch (error) {
    readonlyBlocked = error instanceof odoo.OdooWriteBlockedError;
  }
  check("readonly mode refuses writes", readonlyBlocked);

  configureOdoo({ ODOO_MODE: "readonly" });
  check("ODOO_MODE=readonly is respected", odoo.odooMode() === "readonly");

  configureOdoo({ ODOO_MODE: "live" });
  check("ODOO_MODE=live is respected", odoo.odooMode() === "live");
  let liveAllowed = true;
  try {
    odoo.assertWriteAllowed("test write");
  } catch {
    liveAllowed = false;
  }
  check("live mode permits writes", liveAllowed);

  configureOdoo({ ODOO_MODE: "disabled" });
  check("ODOO_MODE=disabled wins over configured credentials", odoo.odooMode() === "disabled");

  // Nonsense modes must fail closed to readonly, never open to live.
  configureOdoo({ ODOO_MODE: "LIVE please" });
  check("an unrecognised ODOO_MODE falls back to readonly", odoo.odooMode() === "readonly");

  /* ------------------------------------------------------------------ */
  /* 6. Prod-db guard still applies when fully configured for live.      */
  /* ------------------------------------------------------------------ */
  configureOdoo({ ODOO_MODE: "live", ODOO_DATABASE: "Prod-db" });
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

  const described = odoo.describeOdooIntegration();
  check(
    "integration panel reports BLOCKED for Prod-db",
    described.status === "BLOCKED",
  );

  /* ------------------------------------------------------------------ */
  /* 7. Write preview: unconfirmed writes describe, they do not execute. */
  /* ------------------------------------------------------------------ */
  configureOdoo({ ODOO_MODE: "live" });
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

  /* ------------------------------------------------------------------ */
  /* 8. Unreachable host is reported, never silently swallowed.          */
  /* ------------------------------------------------------------------ */
  configureOdoo({ ODOO_URL: "https://odoo.invalid", ODOO_MODE: "readonly" });
  const unreachable = await odoo.checkOdooHealth();
  check(
    "unreachable Odoo is reported as not-ok with an error",
    unreachable.ok === false && typeof unreachable.error === "string",
  );

  /* ------------------------------------------------------------------ */
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
