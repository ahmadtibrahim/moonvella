#!/usr/bin/env node
/**
 * Verify-script runner.
 *
 * The repository has no tsx/ts-node, so TypeScript verify scripts are
 * esbuild-bundled to a temporary `.mjs` (alias `~` -> `./app`,
 * `--packages=external`), executed with node, and the temp file is removed.
 * The child exit code is always propagated.
 *
 * It is also the runner for the repository's other TypeScript scripts — notably
 * `seed-test-product.ts` — because there is no tsx here and bundling is the
 * only way to run one. Those are named explicitly rather than listed in CHECKS:
 * CHECKS is what `--all` runs, and seeding is not a check.
 *
 * Usage:
 *   node scripts/run-verify.mjs scripts/verify-rankings.ts
 *   node scripts/run-verify.mjs scripts/verify-packaging.ts --seed-packaging
 *   node scripts/run-verify.mjs scripts/seed-test-product.ts
 *   node scripts/run-verify.mjs --all
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function esbuildArgs(entryAbs, outfile) {
  return [
    entryAbs,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--alias:~=./app",
    "--packages=external",
    `--outfile=${outfile}`,
  ];
}

const npxCmd = "npx";

/**
 * Test-only environment defaults for scripts whose real prerequisites are not
 * available in a bare dev checkout. An existing value always wins.
 *
 * Empty today: the key it carried belonged to the retired Plaid bank-linking
 * connector, which was removed along with its suite.
 */
const SCRIPT_ENV_DEFAULTS = {};

function envFor(scriptRel) {
  return SCRIPT_ENV_DEFAULTS[basename(scriptRel)];
}

/**
 * Every suite that touches payments declares which Stripe mode it runs in.
 *
 * The mode is pinned here rather than derived inside each suite, because
 * deriving it from "is a key saved" made the suites depend on deployment state:
 * once a real sandbox key was saved in Settings, verify-wholesale and verify-e2e
 * silently left the simulated branch and started making live Stripe calls
 * carrying fabricated `sim_seti_…` ids. The same source tree passed or failed
 * depending on what an operator had typed into a form.
 *
 *   MOONVELLA_STRIPE_MODE=simulated  no provider call is made at all.
 *   MOONVELLA_STRIPE_MODE=test       real sandbox objects, real returned ids.
 *
 * A suite that needs the other mode is a different suite, not a flag.
 */
const SIMULATED_STRIPE = { MOONVELLA_STRIPE_MODE: "simulated" };
const SANDBOX_STRIPE = { MOONVELLA_STRIPE_MODE: "test" };

/**
 * Refuse to run a verify suite against a database that is not a throwaway.
 *
 * The suites are not read-only: verify-payments and verify-wholesale call
 * deleteMany on IntegrationState, verify-wholesale books and voids a shipment,
 * and verify-credentials writes a deliberately-bad Stripe key through
 * saveCredentials to prove the store rejects it. Pointed at the deployed
 * database those are not tests, they are a second writer — and after the first
 * `verify:all` the live `stripe` health row had to be restored by hand.
 *
 * A name is accepted only when it ends in `_verify`, or when it matches
 * MOONVELLA_ALLOW_SHARED_DB exactly. The second form has to be typed on purpose,
 * so "run it against prod" cannot happen by inheriting the wrong environment.
 */
const ISOLATION_SUFFIX = "_verify";

function databaseName() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) return "";
  return (url.split("/").pop() ?? "").split("?")[0];
}

function isolationRefusal() {
  const name = databaseName();
  if (!name) return "DATABASE_URL is unset or has no database name";
  if (name.endsWith(ISOLATION_SUFFIX)) return null;
  if (process.env.MOONVELLA_ALLOW_SHARED_DB === name) return null;
  return `DATABASE_URL points at "${name}", which is not an isolated verify database`;
}

function refuseIfNotIsolated(scriptRel) {
  // Only the verify suites are gated. run-verify.mjs is also the runner for
  // seeders such as seed-test-product.ts, which are meant to write to whatever
  // database they are pointed at.
  if (!basename(scriptRel).startsWith("verify-")) return;
  const refusal = isolationRefusal();
  if (!refusal) return;
  console.error(`\n[run-verify] REFUSED — ${refusal}.`);
  console.error("[run-verify] These suites delete and rewrite integration rows.");
  console.error("[run-verify] Refresh the clone:  bash /opt/moonvella/deployment/verify-db.sh");
  console.error("[run-verify] Then run through:  bash /opt/moonvella/deployment/mv-verify.sh\n");
  process.exit(3);
}

function runNode(args, label, env) {
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (res.error) {
    console.error(`[run-verify] ${label} failed to start: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

function bundle(entryAbs, outfile) {
  const args = ["esbuild", ...esbuildArgs(entryAbs, outfile)];
  const res = spawnSync(npxCmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) {
    console.error(`[run-verify] esbuild failed to start: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

function runScript(scriptRel, scriptArgs = [], extraEnv = null) {
  const entryAbs = resolve(root, scriptRel);
  if (!existsSync(entryAbs)) {
    console.error(`[run-verify] script not found: ${scriptRel}`);
    return 1;
  }
  const safe = basename(scriptRel).replace(/[^a-zA-Z0-9._-]/g, "_");
  const outfile = resolve(root, "scripts", `.verify-${safe}-${process.pid}.mjs`);
  try {
    const build = bundle(entryAbs, outfile);
    if (build !== 0) return build;
    // The check's own env is the most specific, so it wins over the per-script
    // defaults; both are layered over the process environment rather than
    // replacing it.
    return runNode([outfile, ...scriptArgs], scriptRel, {
      ...envFor(scriptRel),
      ...(extraEnv ?? {}),
    });
  } finally {
    rmSync(outfile, { force: true });
  }
}

/**
 * Create a throwaway product/variant with complete packaging data so
 * `verify-packaging.ts` (which requires a variant id argv) is self-sufficient.
 */
async function seedPackagingFixture() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  // Prices belong to the variant; the family carries only its name and code.
  const product = await prisma.product.create({
    data: {
      name: "Verify Packaging Fixture",
      productCode: `VERIFY-PKG-${suffix}`,
      category: "Verification",
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: `VERIFY-PKG-${suffix}-V`,
      name: "Standard",
      wholesalePrice: 1299,
      suggestedRetailPrice: 4900,
      inventory: 10,
      isDefault: true,
    },
  });
  await prisma.variantPackage.create({
    data: {
      variantId: variant.id,
      label: "Fixture carton",
      packageType: "carton",
      length: 40,
      width: 30,
      height: 20,
      dimensionUnit: "cm",
      grossWeight: 2.5,
      weightUnit: "kg",
      unitsPerPackage: 1,
      packagesPerUnit: 1,
      sortOrder: 0,
    },
  });
  return { prisma, productId: product.id, variantId: variant.id };
}

async function cleanupPackagingFixture(fixture) {
  if (!fixture) return;
  const { prisma, productId } = fixture;
  try {
    await prisma.variantPackage.deleteMany({ where: { variant: { productId } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
  } finally {
    await prisma.$disconnect();
  }
}

const CHECKS = [
  {
    name: "phase1",
    kind: "mjs",
    file: "scripts/verify-phase1.mjs",
    requires: ["OWNER_EMAIL", "OWNER_PASSWORD"],
  },
  {
    name: "phase5",
    kind: "mjs",
    file: "scripts/verify-phase5.mjs",
    requires: ["OWNER_EMAIL", "OWNER_PASSWORD"],
  },
  { name: "rankings", kind: "ts", file: "scripts/verify-rankings.ts" },
  { name: "orders", kind: "ts", file: "scripts/verify-orders.ts" },
  // Simulated Stripe, pinned. These three assert the internal payment logic
  // against local records; none of them is a provider test, so none of them may
  // reach Stripe. Pinning the mode is what keeps that true when a real sandbox
  // key is saved in Settings.
  { name: "payments", kind: "ts", file: "scripts/verify-payments.ts", env: SIMULATED_STRIPE },
  { name: "wholesale", kind: "ts", file: "scripts/verify-wholesale.ts", env: SIMULATED_STRIPE },
  { name: "packaging", kind: "ts", file: "scripts/verify-packaging.ts", packaging: true },
  // Shipping and the eShipper adapter. The provider request-mapping checks use a
  // stubbed fetch, so this proves the calls WE build and never claims a real
  // sandbox booking. Needs no session and no credentials.
  { name: "shipping", kind: "ts", file: "scripts/verify-shipping.ts" },
  // The only suite allowed to reach Stripe. It creates REAL sandbox objects and
  // uses the ids Stripe returns; a simulated id handed to a provider call is
  // asserted to fail. It runs against the verify clone, so the objects it makes
  // are attached to throwaway sellers rather than to a real one.
  //
  // Ordered BEFORE credentials on purpose: verify-credentials swaps the stored
  // Stripe key for a deliberately-bad one to prove the store rejects it, and a
  // suite that needs a working key must not run while that is in place.
  //
  // Skipped, not failed, when no sandbox key resolves — a missing prerequisite
  // is not a defect, and reporting it as a failure would train whoever reads the
  // summary to ignore failures.
  { name: "stripe-sandbox", kind: "ts", file: "scripts/verify-stripe-sandbox.ts", env: SANDBOX_STRIPE },
  // Encrypted credential storage. Snapshots and restores the credential rows and
  // integration state it touches, so a credential saved in Settings survives the
  // run. Provider calls are stubbed; nothing is booked or charged.
  { name: "credentials", kind: "ts", file: "scripts/verify-credentials.ts" },
  // The Odoo connector's guards: the Prod-db refusal, the two-key write rule,
  // the write permit the transport demands, and the invoice lookup, which is
  // scoped to one sale order and company rather than to "the latest invoice".
  // Makes no Odoo call, and the one configured host it uses is `odoo.invalid`,
  // reserved by RFC 2606 and guaranteed not to resolve — which is how it proves
  // an unreachable instance is reported instead of silently passing.
  //
  // It saves and clears the `odoo` credential rows to prove the Settings form
  // reaches the connector, snapshotting them first, so it runs after
  // verify-credentials for the same reason that suite runs after stripe-sandbox:
  // it must not run while another suite holds a swapped credential in place.
  { name: "odoo", kind: "ts", file: "scripts/verify-odoo.ts" },
  { name: "e2e", kind: "ts", file: "scripts/verify-e2e.ts", env: SIMULATED_STRIPE },
  // The product/variant/media/document/marketing system. Last because it is
  // the longest, and it publishes a product of its own rather than depending on
  // anything an earlier suite leaves behind.
  { name: "product-system", kind: "ts", file: "scripts/verify-product-system.ts" },
  // The editor's forms, over HTTP, against a running server. It proves the two
  // interface promises that fail silently rather than loudly — that a category
  // outside the offered list is honoured, and that inches typed into a carton
  // are stored as centimetres — so it needs a session and is skipped without
  // one. Bundled rather than run raw, because it imports a TypeScript module.
  {
    name: "editor-ui",
    kind: "ts",
    file: "scripts/verify-editor-ui.ts",
    requires: ["OWNER_EMAIL", "OWNER_PASSWORD"],
  },
  // The Stores roster and a store's own page, over HTTP. Checks two different
  // things and is worth running for both: that Deactivate and Activate change
  // the seller's status rather than only returning a redirect, and that the
  // balances and invoices — which are drawn, not read, until Odoo is connected
  // — say so on the page instead of looking like a ledger.
  {
    name: "stores-ui",
    kind: "ts",
    file: "scripts/verify-stores-ui.ts",
    requires: ["OWNER_EMAIL", "OWNER_PASSWORD"],
  },
  // BLOCKED as a real status, at the level every merchant screen reads it.
  // Needs no session: it drives the services directly, which is the same code
  // the routes call, and it asserts the four permission booleans rather than
  // the screens because the screens need a live Shopify session to sign in.
  {
    name: "seller-block",
    kind: "ts",
    file: "scripts/verify-seller-block.ts",
    requires: [],
  },
  // The seller access states, as the server enforces them. Needs no session:
  // it drives the services the routes call, and it walks the route list to
  // assert that every merchant route guards itself rather than trusting the
  // layout — the check that catches a NEW route added without a guard.
  {
    name: "seller-access",
    kind: "ts",
    file: "scripts/verify-seller-access.ts",
    requires: [],
  },
  // The company and contact mapping written to Odoo on approval. The pure
  // mapping and decision points run for real; the database half asserts what
  // happens when Odoo is not configured, which is this environment and is the
  // case the directive requires to be an explicit hold rather than a silent
  // skip. Makes no Odoo call and writes no partner.
  {
    name: "contact-mapping",
    kind: "ts",
    file: "scripts/verify-contact-mapping.ts",
    requires: [],
  },
  // Archiving a blocked store's catalogue. Never reaches Shopify: the run it
  // drives is the one where Shopify cannot be reached, and what it asserts is
  // that this is reported as a failure with a reason rather than as completion.
  // Its fixtures are mapping rows that belong to no real shop.
  {
    name: "archive",
    kind: "ts",
    file: "scripts/verify-archive.ts",
    requires: [],
  },
  // The Odoo catalogue import. There is no Odoo connection here, and that is
  // the case it is written for: a genuine blocker, nothing invented to fill the
  // gap, and no row written while it refuses. The half that will run against a
  // real Odoo — prices, stock, drafts, media preservation — is checked by
  // reading the module.
  {
    name: "odoo-import",
    kind: "ts",
    file: "scripts/verify-odoo-import.ts",
    requires: [],
  },
  // The scheduled catalogue sync: the recurring bucket key, the lease and
  // attempt rules that make a crashed run resumable, the archive path for a
  // product whose tag was removed, and the refusal to turn a failed read into
  // zero stock. It drives the job machinery against the verify clone and makes
  // no Odoo call — the connection it uses is `odoo.invalid`, which RFC 2606
  // reserves and which therefore never resolves.
  //
  // It was written alongside the sync and is registered here for the same reason
  // the other suites are: an unregistered suite is not run by `--all`, and a
  // check nobody runs is indistinguishable from no check at all.
  {
    name: "odoo-sync",
    kind: "ts",
    file: "scripts/verify-odoo-sync.ts",
    requires: [],
  },
  // The wholesale price matcher: which row of the "MoonVella Wholesale"
  // pricelist prices a variant at quantity 1, and every case where the answer
  // is a refusal instead. It is a PURE suite — no database, no network, no
  // fixtures — because the module it tests is pure by design, and because the
  // rules it encodes are about money and deserve tests that always run rather
  // than tests that need a live Odoo. It follows odoo-import because it is the
  // half of that import that can be checked here.
  {
    name: "pricing",
    kind: "ts",
    file: "scripts/verify-pricing.ts",
    requires: [],
  },
  // The address entry aid: Google's Places suggestions on the merchant
  // application and the admin pickup form.
  //
  // It is PURE — no database, no fixture, no network — because the modules it
  // tests are pure by design: the parser, the request builders and the session
  // state machine. Google is never contacted; `fetch` is stubbed with the
  // documented response shapes AND with the way a real fetch rejects an aborted
  // request, so the checks about a refused key, a busy server and a superseded
  // keystroke are about this code rather than about the stub. It proves the
  // requests this code builds and nothing about Places itself — whether a key is
  // enabled, or a referrer allowed, is a console fact this cannot see.
  //
  // The two pages are checked by reading them, comments stripped: the merchant
  // application is a `.jsx` file, which this build never typechecks, so reading
  // it is the only automated check it gets.
  {
    name: "places",
    kind: "ts",
    file: "scripts/verify-places.ts",
    requires: [],
  },
  // Phase A of the shipping work: origin mappings, packaging inheritance,
  // address validation and image selection. It builds its own fixtures and
  // removes them, because the deployed catalogue has no pillow products to lean
  // on, and it stubs `fetch` for the Google calls — the stub REFUSES any host
  // that is not Google's address-validation API, so a check that tried to reach
  // a real provider fails here instead of succeeding against an account. No
  // eShipper, Shopify or Odoo call is made. It saves and clears the `google`
  // credential rows, snapshotting the integration row first, so it runs after
  // verify-credentials for the same reason verify-odoo does.
  {
    name: "origins",
    kind: "ts",
    file: "scripts/verify-origins.ts",
    requires: [],
  },
  // Phase B of the shipping work: choosing a quote, booking, the pickup that is
  // not implied by it, and the packing list.
  //
  // The checks that matter most are the two failure states booking used to
  // share. A provider that REFUSED must leave a retryable shipment; a provider
  // that never ANSWERED must leave one nobody retries, because a second attempt
  // is how an order gets two labels. Both are exercised here, along with the
  // double-click race, by stubbing `fetch` — the stub answers authentication
  // and REFUSES any host that is not the configured eShipper base URL, so the
  // suite proves the requests this code builds and nothing about eShipper, and
  // cannot book, cancel or charge anything. No Shopify or Odoo call is made.
  //
  // It reads the provider credential and writes no credentials of its own, so
  // it has no ordering constraint against verify-credentials.
  {
    name: "booking",
    kind: "ts",
    file: "scripts/verify-booking.ts",
    requires: [],
  },
  // Phase C of the shipping work: the tracking vocabulary, the polling
  // schedule, the dispatch milestone and the pickup window.
  //
  // Two of these are checked against rows rather than by reading the code,
  // because they are the ones that fail quietly: that each of the nine display
  // words is returned by exactly the rows that wear it, and that a refresh
  // which fails leaves the last good carrier status standing instead of
  // blanking the page. It stubs `fetch` the same way verify-booking does — the
  // stub answers authentication and REFUSES any host that is not the configured
  // eShipper base URL — so it proves what this code does and nothing about
  // eShipper, and cannot poll, book, cancel or charge anything real. No Shopify
  // or Odoo call is made.
  //
  // It reads the provider credential and writes none, so it has no ordering
  // constraint against verify-credentials. It creates seller, order, shipment
  // and dock fixtures and removes them.
  {
    name: "tracking",
    kind: "ts",
    file: "scripts/verify-tracking.ts",
    requires: [],
  },
];

async function runAll() {
  const results = [];

  const refusal = isolationRefusal();
  if (refusal) {
    console.error(`\n[run-verify] REFUSED — ${refusal}.`);
    console.error("[run-verify] `--all` runs suites that delete and rewrite integration rows.");
    console.error("[run-verify] Refresh the clone:  bash /opt/moonvella/deployment/verify-db.sh");
    console.error("[run-verify] Then run through:  bash /opt/moonvella/deployment/mv-verify.sh\n");
    process.exit(3);
  }

  for (const item of CHECKS) {
    console.log(`\n${"=".repeat(72)}\n== verify:${item.name} — ${item.file}\n${"=".repeat(72)}`);

    if (item.requires && item.requires.some((key) => !process.env[key])) {
      const missing = item.requires.filter((key) => !process.env[key]).join(", ");
      console.log(`SKIP  ${item.name} — missing env ${missing} (needs a running app server)`);
      results.push({ name: item.name, status: "skip" });
      continue;
    }

    let status;
    if (item.kind === "mjs") {
      status = runNode([item.file], item.name);
    } else if (item.packaging) {
      const fixture = await seedPackagingFixture();
      try {
        status = runScript(item.file, [fixture.variantId], item.env);
      } finally {
        await cleanupPackagingFixture(fixture);
      }
    } else {
      status = runScript(item.file, [], item.env);
    }

    results.push({ name: item.name, status: status === 0 ? "pass" : "fail" });
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  console.log(`\n${"=".repeat(72)}\n== verify:all summary\n${"=".repeat(72)}`);
  for (const r of results) {
    const label = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
    console.log(`${label}  ${r.name}`);
  }
  console.log(`\n=== ${passed}/${results.length} scripts passed (${failed} failed, ${skipped} skipped) ===`);

  return failed > 0 ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const seedPackaging = argv.includes("--seed-packaging");
  const rest = argv.filter((a) => a !== "--seed-packaging");

  if (rest[0] === "--all") {
    process.exit(await runAll());
  }

  const script = rest[0];
  if (!script) {
    console.error("Usage: node scripts/run-verify.mjs <script.ts> [--seed-packaging] [args...]");
    process.exit(2);
  }

  refuseIfNotIsolated(script);

  const scriptArgs = rest.slice(1);
  // A script named in CHECKS carries its own pinned environment, so running one
  // by path behaves exactly as `--all` would. A script run by path that is not
  // in CHECKS (a seeder) simply gets none.
  const declared = CHECKS.find((c) => c.file === script);
  const extraEnv = declared?.env ?? null;

  if (!seedPackaging) {
    process.exit(runScript(script, scriptArgs, extraEnv));
  }

  const fixture = await seedPackagingFixture();
  try {
    scriptArgs.unshift(fixture.variantId);
    process.exit(runScript(script, scriptArgs, extraEnv));
  } finally {
    await cleanupPackagingFixture(fixture);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
