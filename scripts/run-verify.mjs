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
 * available in a bare dev checkout. An existing value always wins. The Plaid
 * key is a throwaway: `verify-plaid.ts` still deletes it to prove that missing
 * encryption configuration fails closed.
 */
const SCRIPT_ENV_DEFAULTS = {
  "verify-plaid.ts": {
    APP_ENCRYPTION_KEY:
      process.env.APP_ENCRYPTION_KEY || "verify-plaid-local-test-key-not-for-production",
  },
};

function envFor(scriptRel) {
  return SCRIPT_ENV_DEFAULTS[basename(scriptRel)];
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

function runScript(scriptRel, scriptArgs = []) {
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
    return runNode([outfile, ...scriptArgs], scriptRel, envFor(scriptRel));
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
  { name: "payments", kind: "ts", file: "scripts/verify-payments.ts" },
  { name: "wholesale", kind: "ts", file: "scripts/verify-wholesale.ts" },
  { name: "packaging", kind: "ts", file: "scripts/verify-packaging.ts", packaging: true },
  { name: "plaid", kind: "ts", file: "scripts/verify-plaid.ts" },
  { name: "e2e", kind: "ts", file: "scripts/verify-e2e.ts" },
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
];

async function runAll() {
  const results = [];

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
        status = runScript(item.file, [fixture.variantId]);
      } finally {
        await cleanupPackagingFixture(fixture);
      }
    } else {
      status = runScript(item.file, []);
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

  const scriptArgs = rest.slice(1);
  if (!seedPackaging) {
    process.exit(runScript(script, scriptArgs));
  }

  const fixture = await seedPackagingFixture();
  try {
    scriptArgs.unshift(fixture.variantId);
    process.exit(runScript(script, scriptArgs));
  } finally {
    await cleanupPackagingFixture(fixture);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
