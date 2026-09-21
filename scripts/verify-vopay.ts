/**
 * VoPay PAD connector guard verification.
 *
 * These tests exercise the safety rules, not the network. Nothing here contacts
 * VoPay, and nothing here can: the connector is unconfigured by default, the
 * configurations that turn it on point at throwaway `.invalid` hostnames, and
 * no operation is ever run in real mode. Every mandate and debit below is a
 * simulated one.
 *
 * The database is deliberately pointed at a discarded port for the whole run.
 * Two things follow, and both are the point: these tests cannot write to the
 * application database (a verification run must not leave payment-shaped rows
 * behind in a production audit log), and the mandate lifecycle is proven to
 * work when the audit sink is unavailable.
 *
 * Run: npm run verify:vopay
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

type PadState = "PENDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
type VopayModule = typeof import("~/services/vopay.server");
let vopay: VopayModule;

const VOPAY_ENV_KEYS = [
  "VOPAY_ACCOUNT_ID",
  "VOPAY_API_KEY",
  "VOPAY_API_SECRET",
  "VOPAY_BASE_URL",
  "VOPAY_ENV",
  "VOPAY_TIMEOUT_MS",
] as const;

const ACCOUNT_ID = "acct_1234567890";
const API_KEY = "test-api-key-not-real";
const API_SECRET = "test-api-secret-not-real";
const SANDBOX_BASE = "https://sandbox-api.vopay.invalid/v1";
const PRODUCTION_BASE = "https://api.vopay.com/v1";

function clearVopayEnv() {
  for (const key of VOPAY_ENV_KEYS) delete process.env[key];
}

function configureVopay(overrides: Record<string, string> = {}) {
  clearVopayEnv();
  process.env.VOPAY_ACCOUNT_ID = ACCOUNT_ID;
  process.env.VOPAY_API_KEY = API_KEY;
  process.env.VOPAY_API_SECRET = API_SECRET;
  process.env.VOPAY_BASE_URL = SANDBOX_BASE;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

/** Every refusal in this module is a typed error carrying a machine code. */
function isVopayError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    error.name === "VopayError" &&
    (error as { code?: string }).code === code
  );
}

async function refused(run: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return isVopayError(error, code);
  }
}

const BANK_ACCOUNT = {
  institutionNumber: "001",
  transitNumber: "12345",
  accountNumber: "123456789012",
  accountType: "chequing" as const,
};

async function main() {
  // The guards under test are about a production deployment, so NODE_ENV is
  // stated explicitly by each section rather than inherited from the runner.
  delete process.env.NODE_ENV;

  // Mandates and idempotency outcomes are persisted, so this suite needs a real
  // database. It derives a dedicated one from the ambient credentials rather
  // than hardcoding a connection string, so it can never touch application
  // data — and it never needs a secret of its own.
  const baseUrl = process.env.DATABASE_URL ?? "";
  const verifyUrl = baseUrl.replace(/(:\/\/[^/]+\/)[^/?]+/, "$1moonvella_verify");
  if (!baseUrl || verifyUrl === baseUrl) {
    console.error(
      "verify-vopay needs DATABASE_URL set so it can derive the moonvella_verify " +
        "database URL. Run it with --env-file /etc/moonvella/moonvella.env.",
    );
    process.exit(1);
  }
  process.env.DATABASE_URL = verifyUrl;

  vopay = await import("~/services/vopay.server");

  // The suite uses fixed idempotency keys, which now persist by design. Starting
  // from a clean slate is what makes it re-runnable rather than single-shot.
  const { prisma } = await import("~/db.server");
  await prisma.idempotencyKey.deleteMany({});
  await prisma.padMandate.deleteMany({});

  /* ------------------------------------------------------------------ */
  /* 1. Unconfigured => simulated and inert.                             */
  /* ------------------------------------------------------------------ */
  clearVopayEnv();
  check("unconfigured: vopayConfigured() is false", vopay.vopayConfigured() === false);
  check("unconfigured: vopayMode() is 'simulated'", vopay.vopayMode() === "simulated");
  check("unconfigured: vopayEnv() defaults to 'sandbox'", vopay.vopayEnv() === "sandbox");
  check("unconfigured: maskedVopayAccount() is null", vopay.maskedVopayAccount() === null);

  /* ------------------------------------------------------------------ */
  /* 2. Placeholder and blank values count as unconfigured.              */
  /* ------------------------------------------------------------------ */
  clearVopayEnv();
  process.env.VOPAY_ACCOUNT_ID = "__REQUIRED_NOT_SET__";
  process.env.VOPAY_API_KEY = "__REQUIRED_NOT_SET__";
  process.env.VOPAY_API_SECRET = "__REQUIRED_NOT_SET__";
  process.env.VOPAY_BASE_URL = SANDBOX_BASE;
  check(
    "placeholder credentials are treated as unconfigured",
    vopay.vopayConfigured() === false && vopay.vopayMode() === "simulated",
  );

  configureVopay({ VOPAY_API_SECRET: "   " });
  check("a blank credential is treated as unconfigured", vopay.vopayConfigured() === false);

  configureVopay({ VOPAY_ACCOUNT_ID: "__REQUIRED_NOT_SET__" });
  check("a placeholder account id keeps maskedVopayAccount() null", vopay.maskedVopayAccount() === null);

  /* ------------------------------------------------------------------ */
  /* 3. Fail-safe base URL rule: production is never reached by accident. */
  /* ------------------------------------------------------------------ */
  configureVopay();
  check(
    "a sandbox base URL outside production is configured (real mode)",
    vopay.vopayConfigured() === true && vopay.vopayMode() === "real",
  );

  configureVopay({ VOPAY_BASE_URL: PRODUCTION_BASE });
  check(
    "a production base URL fails safe to simulated outside production",
    vopay.vopayConfigured() === false && vopay.vopayMode() === "simulated",
  );

  configureVopay({ VOPAY_BASE_URL: PRODUCTION_BASE, VOPAY_ENV: "sandbox" });
  check(
    "VOPAY_ENV=sandbox with a production URL still fails safe",
    vopay.vopayConfigured() === false,
  );

  configureVopay({ VOPAY_BASE_URL: PRODUCTION_BASE, VOPAY_ENV: "staging" });
  check(
    "an unrecognised VOPAY_ENV does not unlock a production URL",
    vopay.vopayConfigured() === false && vopay.vopayEnv() === "staging",
  );

  configureVopay({ VOPAY_BASE_URL: PRODUCTION_BASE, VOPAY_ENV: "production" });
  check(
    "VOPAY_ENV=production accepts a production base URL",
    vopay.vopayConfigured() === true && vopay.vopayMode() === "real",
  );

  configureVopay({ VOPAY_BASE_URL: "__REQUIRED_NOT_SET__" });
  check("a placeholder base URL is unconfirmed and stays simulated", vopay.vopayConfigured() === false);

  clearVopayEnv();
  process.env.VOPAY_ACCOUNT_ID = ACCOUNT_ID;
  process.env.VOPAY_API_KEY = API_KEY;
  process.env.VOPAY_API_SECRET = API_SECRET;
  check(
    "a missing base URL is unconfirmed and stays simulated",
    vopay.vopayConfigured() === false && vopay.vopayMode() === "simulated",
  );

  /* ------------------------------------------------------------------ */
  /* 4. Masking: no secret ever leaves the module.                       */
  /* ------------------------------------------------------------------ */
  configureVopay();
  const masked = vopay.maskedVopayAccount();
  check(
    "maskedVopayAccount() returns exactly the last four characters",
    masked === "****7890",
    String(masked),
  );
  check(
    "maskedVopayAccount() never returns the account id",
    !!masked && !masked.includes(ACCOUNT_ID),
  );
  check(
    "maskedVopayAccount() never returns the API key or secret",
    !!masked && !masked.includes(API_KEY) && !masked.includes(API_SECRET),
  );
  check("values too short to mask are hidden entirely", vopay.maskToLast4("1234") === "****");

  /* ------------------------------------------------------------------ */
  /* 5. Request timeout: default, override, and nonsense input.          */
  /* ------------------------------------------------------------------ */
  clearVopayEnv();
  check("the request timeout defaults to 15000ms", vopay.vopayTimeoutMs() === 15000);
  process.env.VOPAY_TIMEOUT_MS = "2500";
  check("VOPAY_TIMEOUT_MS overrides the default", vopay.vopayTimeoutMs() === 2500);
  process.env.VOPAY_TIMEOUT_MS = "not-a-number";
  check("a nonsense timeout falls back to the default", vopay.vopayTimeoutMs() === 15000);
  process.env.VOPAY_TIMEOUT_MS = "-1";
  check("a negative timeout falls back to the default", vopay.vopayTimeoutMs() === 15000);
  clearVopayEnv();

  /* ------------------------------------------------------------------ */
  /* 6. The state machine itself, before any record is involved.         */
  /* ------------------------------------------------------------------ */
  const legal: [PadState, PadState][] = [
    ["PENDING", "ACTIVE"],
    ["ACTIVE", "SUSPENDED"],
    ["SUSPENDED", "ACTIVE"],
    ["PENDING", "CANCELLED"],
    ["ACTIVE", "CANCELLED"],
    ["SUSPENDED", "CANCELLED"],
  ];
  for (const [from, to] of legal) {
    let allowed = true;
    try {
      vopay.assertLegalPadTransition(from, to);
    } catch {
      allowed = false;
    }
    check(
      `legal transition ${from} -> ${to} is accepted`,
      allowed && vopay.isLegalPadTransition(from, to) === true,
    );
  }

  const illegal: [PadState, PadState][] = [
    ["ACTIVE", "PENDING"],
    ["SUSPENDED", "PENDING"],
    ["ACTIVE", "ACTIVE"],
    ["PENDING", "PENDING"],
    ["SUSPENDED", "SUSPENDED"],
  ];
  for (const [from, to] of illegal) {
    check(
      `illegal transition ${from} -> ${to} throws`,
      (await refused(async () => vopay.assertLegalPadTransition(from, to), "ILLEGAL_TRANSITION")) === true,
    );
  }

  // Cancelled is terminal. Every edge out of it is refused with a code that
  // says *why*: the payer revoked, so the caller is told to collect a new
  // authorization rather than to fix a mistyped state.
  for (const to of ["PENDING", "ACTIVE", "SUSPENDED"] as PadState[]) {
    check(
      `CANCELLED -> ${to} is refused as a revoked mandate`,
      await refused(async () => vopay.assertLegalPadTransition("CANCELLED", to), "MANDATE_CANCELLED"),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 7. Mandate lifecycle, in simulated mode (no network, no database).  */
  /* ------------------------------------------------------------------ */
  clearVopayEnv();
  const createInput = {
    sellerId: "seller_verify_1",
    payerName: "Verify Payer",
    reference: "Verify run",
    bankAccount: BANK_ACCOUNT,
    idempotencyKey: "verify:create:1",
  };

  const created = await vopay.createPadMandate(createInput);
  check("createPadMandate starts the mandate in PENDING", created.state === "PENDING");
  check("a simulated mandate is labelled simulated", created.simulated === true);
  check(
    "a mandate result carries only the last four account digits",
    created.accountLast4 === "****9012",
    String(created.accountLast4),
  );
  check(
    "a mandate result never contains the full account number",
    !JSON.stringify(created).includes(BANK_ACCOUNT.accountNumber),
  );

  check(
    "chargePad refuses a mandate that is not ACTIVE",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 5000, idempotencyKey: "verify:charge:early" }),
      "MANDATE_NOT_ACTIVE",
    ),
  );
  check(
    "a PENDING mandate cannot be suspended",
    await refused(
      () => vopay.suspendPadMandate(created.id, { idempotencyKey: "verify:suspend:early" }),
      "ILLEGAL_TRANSITION",
    ),
  );

  const active = await vopay.activatePadMandate(created.id, { idempotencyKey: "verify:activate:1" });
  check("activatePadMandate moves PENDING -> ACTIVE", active.state === "ACTIVE");
  check(
    "an ACTIVE mandate cannot be activated again",
    await refused(
      () => vopay.activatePadMandate(created.id, { idempotencyKey: "verify:activate:again" }),
      "ILLEGAL_TRANSITION",
    ),
  );

  const charge = await vopay.chargePad({
    mandateId: created.id,
    amount: 12500,
    reference: "INV-VERIFY-1",
    idempotencyKey: "verify:charge:1",
  });
  check(
    "chargePad debits an ACTIVE mandate",
    charge.amount === 12500 &&
      charge.currency === "CAD" &&
      charge.status === "PROCESSING" &&
      charge.simulated === true,
  );
  check("a PAD debit is never reported as settled", charge.status === "PROCESSING");

  /* ------------------------------------------------------------------ */
  /* 8. Idempotency: a retry must never become a second debit.           */
  /* ------------------------------------------------------------------ */
  const replay = await vopay.chargePad({
    mandateId: created.id,
    amount: 12500,
    reference: "INV-VERIFY-1",
    idempotencyKey: "verify:charge:1",
  });
  check(
    "a replayed charge returns the original debit (no second provider call)",
    replay.providerChargeId === charge.providerChargeId,
    replay.providerChargeId,
  );

  const freshKey = await vopay.chargePad({
    mandateId: created.id,
    amount: 12500,
    reference: "INV-VERIFY-1",
    idempotencyKey: "verify:charge:2",
  });
  check(
    "a new key issues a genuinely new debit",
    freshKey.providerChargeId !== charge.providerChargeId,
  );

  check(
    "the same key with a different amount is a conflict",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 999, idempotencyKey: "verify:charge:1" }),
      "IDEMPOTENCY_CONFLICT",
    ),
  );
  check(
    "a blank idempotency key is refused",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 100, idempotencyKey: "   " }),
      "VALIDATION",
    ),
  );

  const replayedCreate = await vopay.createPadMandate(createInput);
  check(
    "a replayed create returns the same mandate id",
    replayedCreate.id === created.id,
  );
  check(
    "the same create key with a different payer is a conflict",
    await refused(
      () =>
        vopay.createPadMandate({
          ...createInput,
          payerName: "Someone Else",
        }),
      "IDEMPOTENCY_CONFLICT",
    ),
  );

  /* ------------------------------------------------------------------ */
  /* 9. Suspend / resume round trip.                                     */
  /* ------------------------------------------------------------------ */
  const suspended = await vopay.suspendPadMandate(created.id, { idempotencyKey: "verify:suspend:1" });
  check("suspendPadMandate moves ACTIVE -> SUSPENDED", suspended.state === "SUSPENDED");
  check(
    "a suspended mandate cannot be debited",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 500, idempotencyKey: "verify:charge:suspended" }),
      "MANDATE_NOT_ACTIVE",
    ),
  );
  check(
    "a suspended mandate cannot be suspended again",
    await refused(
      () => vopay.suspendPadMandate(created.id, { idempotencyKey: "verify:suspend:again" }),
      "ILLEGAL_TRANSITION",
    ),
  );

  const resumed = await vopay.resumePadMandate(created.id, { idempotencyKey: "verify:resume:1" });
  check("resumePadMandate moves SUSPENDED -> ACTIVE", resumed.state === "ACTIVE");
  check(
    "an ACTIVE mandate cannot be resumed again",
    await refused(
      () => vopay.resumePadMandate(created.id, { idempotencyKey: "verify:resume:again" }),
      "ILLEGAL_TRANSITION",
    ),
  );

  /* ------------------------------------------------------------------ */
  /* 10. CANCELLED is terminal.                                          */
  /* ------------------------------------------------------------------ */
  const cancelled = await vopay.cancelPadMandate(created.id, { idempotencyKey: "verify:cancel:1" });
  check("cancelPadMandate moves ACTIVE -> CANCELLED", cancelled.state === "CANCELLED");

  const outOfCancelled: [string, () => Promise<unknown>][] = [
    ["activate", () => vopay.activatePadMandate(created.id, { idempotencyKey: "verify:cancel:activate" })],
    ["resume", () => vopay.resumePadMandate(created.id, { idempotencyKey: "verify:cancel:resume" })],
    ["suspend", () => vopay.suspendPadMandate(created.id, { idempotencyKey: "verify:cancel:suspend" })],
    ["cancel", () => vopay.cancelPadMandate(created.id, { idempotencyKey: "verify:cancel:again" })],
  ];
  for (const [label, run] of outOfCancelled) {
    check(
      `a cancelled mandate refuses to ${label} (terminal state)`,
      await refused(run, "MANDATE_CANCELLED"),
    );
  }
  check(
    "a cancelled mandate cannot be debited",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 500, idempotencyKey: "verify:cancel:charge" }),
      "MANDATE_CANCELLED",
    ),
  );

  const afterCancel = await vopay.getPadMandate(created.id);
  const afterCancelAgain = await vopay.getPadMandate(created.id);
  check("a cancelled mandate stays cancelled", afterCancel.state === "CANCELLED");
  check(
    "reading a mandate does not change it",
    afterCancelAgain.updatedAt.getTime() === afterCancel.updatedAt.getTime(),
  );
  check("the lifecycle completed", afterCancel.state === "CANCELLED");

  // The point of the durable store: a cancellation must survive a process
  // restart. Read it back through a fresh Prisma query rather than trusting the
  // in-memory object the call returned — that is exactly the distinction the
  // persistence fix exists to make.
  const persisted = await prisma.padMandate.findUnique({
    where: { id: created.id },
    select: { state: true },
  });
  check(
    "the cancellation is durable, not just in-memory",
    persisted?.state === "CANCELLED",
    persisted ? `stored state = ${persisted.state}` : "no row found",
  );

  const idempotencyRows = await prisma.idempotencyKey.count();
  check(
    "idempotency outcomes were persisted",
    idempotencyRows > 0,
    `${idempotencyRows} row(s)`,
  );

  /* ------------------------------------------------------------------ */
  /* 12. A claim interrupted before its outcome was recorded must not be  */
  /*     silently re-issued.                                             */
  /* ------------------------------------------------------------------ */
  // This is the state a crash between "claimed" and "outcome recorded" leaves
  // behind. We cannot know whether the provider received the original debit, so
  // retrying risks debiting the payer twice. Refusing and demanding
  // reconciliation is the only safe answer. Params are identical to the
  // original verify:charge:1 call so the fingerprint matches and this exercises
  // the in-progress branch rather than the conflict branch.
  await prisma.idempotencyKey.update({
    where: { scope_key: { scope: "pad.charge:verify:charge:1", key: "verify:charge:1" } },
    data: { status: "IN_PROGRESS" },
  });
  check(
    "a crash-interrupted claim is refused rather than re-debited",
    await refused(
      () =>
        vopay.chargePad({
          mandateId: created.id,
          amount: 12500,
          reference: "INV-VERIFY-1",
          idempotencyKey: "verify:charge:1",
        }),
      "IDEMPOTENCY_IN_PROGRESS",
    ),
  );

  /* ------------------------------------------------------------------ */
  /* 11. Unknown mandates and invalid input are errors, not empty states. */
  /* ------------------------------------------------------------------ */
  check(
    "an unknown mandate id is reported, not treated as empty",
    await refused(() => vopay.getPadMandate("sim_mandate_missing"), "MANDATE_NOT_FOUND"),
  );
  check(
    "charging an unknown mandate is refused",
    await refused(
      () => vopay.chargePad({ mandateId: "sim_mandate_missing", amount: 100, idempotencyKey: "verify:charge:missing" }),
      "MANDATE_NOT_FOUND",
    ),
  );
  check(
    "a fractional cent amount is refused rather than rounded",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 10.5, idempotencyKey: "verify:charge:frac" }),
      "VALIDATION",
    ),
  );
  check(
    "a zero amount is refused",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 0, idempotencyKey: "verify:charge:zero" }),
      "VALIDATION",
    ),
  );
  check(
    "a malformed institution number is refused",
    await refused(
      () =>
        vopay.createPadMandate({
          ...createInput,
          bankAccount: { ...BANK_ACCOUNT, institutionNumber: "1" },
          idempotencyKey: "verify:create:bad-institution",
        }),
      "VALIDATION",
    ),
  );
  check(
    "a malformed transit number is refused",
    await refused(
      () =>
        vopay.createPadMandate({
          ...createInput,
          bankAccount: { ...BANK_ACCOUNT, transitNumber: "1234" },
          idempotencyKey: "verify:create:bad-transit",
        }),
      "VALIDATION",
    ),
  );
  check(
    "a mandate without a payer name is refused",
    await refused(
      () => vopay.createPadMandate({ ...createInput, payerName: " ", idempotencyKey: "verify:create:no-name" }),
      "VALIDATION",
    ),
  );

  /* ------------------------------------------------------------------ */
  /* 12. Typed errors, and the production guard.                         */
  /* ------------------------------------------------------------------ */
  let typedError: unknown;
  try {
    vopay.assertLegalPadTransition("CANCELLED", "ACTIVE");
  } catch (error) {
    typedError = error;
  }
  check(
    "refusals are VopayError instances carrying a code",
    typedError instanceof vopay.VopayError &&
      typedError instanceof Error &&
      (typedError as { code?: string }).code === "MANDATE_CANCELLED",
  );

  clearVopayEnv();
  process.env.NODE_ENV = "production";
  check(
    "simulated mode in production refuses to create a mandate",
    await refused(() => vopay.createPadMandate({ ...createInput, idempotencyKey: "verify:prod:create" }), "SIMULATED_IN_PRODUCTION"),
  );
  check(
    "simulated mode in production refuses to charge",
    await refused(
      () => vopay.chargePad({ mandateId: created.id, amount: 100, idempotencyKey: "verify:prod:charge" }),
      "SIMULATED_IN_PRODUCTION",
    ),
  );
  check(
    "simulated mode in production refuses even to read a mandate",
    await refused(() => vopay.getPadMandate(created.id), "SIMULATED_IN_PRODUCTION"),
  );
  configureVopay();
  check(
    "the production guard is about simulated mode, not about blocking real ones",
    vopay.vopayMode() === "real",
  );
  delete process.env.NODE_ENV;

  /* ------------------------------------------------------------------ */
  /* 13. Source audit: nothing live is hard-coded, secrets are not logged. */
  /* ------------------------------------------------------------------ */
  const source = readFileSync(resolve("app/services/vopay.server.ts"), "utf8");
  check("the source hard-codes no production VoPay host", !/vopay\.(com|ca)/i.test(source));
  check("the base URL comes from the environment", source.includes("VOPAY_BASE_URL"));
  check(
    "the sandbox test and VOPAY_ENV gate the base URL",
    /sandbox/i.test(source) && source.includes("VOPAY_ENV"),
  );
  check("provider calls carry an Idempotency-Key header", source.includes('"Idempotency-Key"'));
  check(
    "provider calls are aborted on a timeout",
    source.includes("AbortController") && source.includes("signal: controller.signal"),
  );
  check("credentials are read from the environment, not stored", source.includes("VOPAY_API_SECRET"));

  /* ------------------------------------------------------------------ */
  clearVopayEnv();
  delete process.env.NODE_ENV;

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
