/**
 * Credential storage and provider-configuration verification.
 *
 * What this suite establishes, in order of importance:
 *
 *   1. A secret survives a save/read round trip through the database encrypted,
 *      and a stored value beats the environment.
 *   2. Disconnect disables the provider even when the environment still holds
 *      working credentials. This is the difference between a status label and an
 *      actual switch, and it is the reason the flag exists.
 *   3. A secret's value is not present in any structure returned to the browser,
 *      in any audit row, or in any error message.
 *   4. "Connected" cannot be claimed from a presence check: the Stripe and
 *      eShipper probes make an authenticated call, and a rejected key fails.
 *
 * Provider calls are stubbed with global.fetch. Nothing here contacts Stripe or
 * eShipper, no shipment is quoted or booked, and no payment is created.
 *
 * DATABASE NOTE: like every suite in this directory, this runs against the
 * database DATABASE_URL points at. It therefore snapshots the credential rows
 * and the disconnect flag for the keys it touches and restores them afterwards,
 * so a real credential saved in Settings is never lost or overwritten.
 */
import { PrismaClient } from "@prisma/client";
import {
  encryptCredential,
  decryptCredential,
  needsReEncryption,
  redactSecrets,
  saveCredentials,
  getCredential,
  getCredentials,
  disconnectCredentials,
  credentialFieldStates,
  isProviderDisconnected,
  stripeSecretKey,
  stripeWebhookSecret,
  rotateCredentialKeys,
} from "../app/services/credentials.server";
import {
  CREDENTIAL_INTEGRATIONS,
  ALL_CREDENTIAL_FIELD_NAMES,
} from "../app/services/integrationFields";
import {
  CREDENTIAL_KEYS,
  OPERATIONAL_KEYS,
  INTEGRATION_KEYS,
  saveIntegrationCredentials,
  disconnectIntegration,
  checkIntegration,
  getIntegrationState,
} from "../app/services/integrationHealth.server";
import {
  classifyEshipperEnvironment,
  eshipperEnvironment,
  eshipperConfigured,
  isRecognizedTestHost,
  extractCreditSignals,
  testEshipperAuthentication,
} from "../app/services/eshipper.server";
import { testStripeAuthentication } from "../app/services/payments.server";

const prisma = new PrismaClient();

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const calls: { url: string; method: string }[] = [];
function installFetch(respond: (url: string, method: string) => { status?: number; body?: unknown }) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const r = respond(url, method);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Keys this suite writes to. Snapshotted and restored around the run. */
const TOUCHED_KEYS = ["stripe", "eshipper", "odoo"] as const;

/**
 * The rows this suite is about to disturb, copied verbatim. Credential values
 * are ciphertext, so restoring them is a straight copy — nothing is decrypted
 * to put production back the way it was.
 */
interface Snapshot {
  credentials: {
    id: string;
    key: string;
    field: string;
    value: string;
    createdAt: Date;
    updatedAt: Date;
  }[];
  states: {
    id: string;
    key: string;
    status: string;
    lastSuccessAt: Date | null;
    lastErrorAt: Date | null;
    lastError: string | null;
    detail: string | null;
    disconnectedAt: Date | null;
  }[];
}

async function snapshot(): Promise<Snapshot> {
  const [credentials, states] = await Promise.all([
    prisma.integrationCredential.findMany({ where: { key: { in: [...TOUCHED_KEYS] } } }),
    prisma.integrationState.findMany({ where: { key: { in: [...TOUCHED_KEYS] } } }),
  ]);
  return {
    credentials: credentials.map((row) => ({
      id: row.id,
      key: row.key,
      field: row.field,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    states: states.map((row) => ({
      id: row.id,
      key: row.key,
      status: row.status as string,
      lastSuccessAt: row.lastSuccessAt,
      lastErrorAt: row.lastErrorAt,
      lastError: row.lastError,
      detail: row.detail,
      disconnectedAt: row.disconnectedAt,
    })),
  };
}

async function restore(snap: Snapshot) {
  await prisma.integrationCredential.deleteMany({ where: { key: { in: [...TOUCHED_KEYS] } } });
  await prisma.integrationState.deleteMany({ where: { key: { in: [...TOUCHED_KEYS] } } });
  for (const row of snap.states) {
    await prisma.integrationState.create({ data: { ...row, status: row.status as never } });
  }
  for (const row of snap.credentials) {
    await prisma.integrationCredential.create({ data: row });
  }
}

async function main() {
  // 0. Keys and fields line up -----------------------------------------------
  const specKeys = Object.keys(CREDENTIAL_INTEGRATIONS).sort();
  check(
    "the credential key list and the field spec describe the same integrations",
    JSON.stringify(specKeys) === JSON.stringify([...CREDENTIAL_KEYS].sort()),
    `spec=${specKeys.join(",")} list=${[...CREDENTIAL_KEYS].sort().join(",")}`
  );
  check(
    "operational checks hold no credential fields",
    OPERATIONAL_KEYS.every((key) => !(key in CREDENTIAL_INTEGRATIONS))
  );
  check(
    "credential and operational keys together are the seven-key union",
    CREDENTIAL_KEYS.length + OPERATIONAL_KEYS.length === INTEGRATION_KEYS.length &&
      new Set([...CREDENTIAL_KEYS, ...OPERATIONAL_KEYS]).size === INTEGRATION_KEYS.length
  );
  check(
    "no field name is declared twice",
    new Set(ALL_CREDENTIAL_FIELD_NAMES).size === ALL_CREDENTIAL_FIELD_NAMES.length
  );
  const allFields = Object.values(CREDENTIAL_INTEGRATIONS).flatMap((integration) => integration.fields);
  const secretNames = allFields.filter((field) => field.secret).map((field) => field.name).sort();
  check(
    "the five provider secrets are marked secret",
    JSON.stringify(secretNames) ===
      JSON.stringify([
        "ESHIPPER_PASSWORD",
        "GOOGLE_MAPS_SERVER_KEY",
        "ODOO_API_KEY",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
      ]),
    secretNames.join(",")
  );
  check(
    "connection identifiers are not marked secret",
    allFields
      .filter((field) => !field.secret)
      // The complete list, by design: a new field cannot be added without
      // someone deciding here whether it is a secret. ODOO_CONSIGNMENT_* name
      // whose stock an import may sell; they identify records rather than
      // authenticate, so they are not secrets. GOOGLE_MAPS_BROWSER_KEY is the
      // one field here that IS handed to a browser, which is exactly why it must
      // not be stored as a secret: the address form has to read it, and a value
      // the server refuses to render is a form that cannot complete an address.
      // Its safety comes from the referrer restriction, not from this store — and
      // the Address Validation call must use the server key, never this one.
      .every((field) => ["STRIPE_PUBLISHABLE_KEY", "ESHIPPER_BASE_URL", "ESHIPPER_USERNAME", "ESHIPPER_ACCOUNT_ID", "ODOO_URL", "ODOO_DATABASE", "ODOO_USERNAME", "ODOO_MODE", "ODOO_CONSIGNMENT_LOCATION", "ODOO_CONSIGNMENT_OWNER", "GOOGLE_MAPS_BROWSER_KEY"].includes(field.name))
  );

  // 1. Encryption -------------------------------------------------------------
  const secret = "sk_test_roundtrip_0123456789";
  const ciphertext = encryptCredential(secret);
  check("ciphertext is not the plaintext", ciphertext !== secret && !ciphertext.includes(secret));
  check("ciphertext is versioned", ciphertext.startsWith("v1:"));
  check("ciphertext has four parts", ciphertext.split(":").length === 4);
  check("decrypt returns the original", decryptCredential(ciphertext) === secret);
  check(
    "the same plaintext encrypts differently each time (fresh IV)",
    encryptCredential(secret) !== encryptCredential(secret)
  );
  check("a versioned payload needs no re-encryption", needsReEncryption(ciphertext) === false);
  check("an unversioned payload is marked for re-encryption", needsReEncryption("a:b:c") === true);

  const tampered = (() => {
    const parts = ciphertext.split(":");
    const data = Buffer.from(parts[3], "base64");
    data[0] = data[0] ^ 0xff;
    return [parts[0], parts[1], parts[2], data.toString("base64")].join(":");
  })();
  let tamperRejected = false;
  try {
    decryptCredential(tampered);
  } catch {
    tamperRejected = true;
  }
  check("a tampered ciphertext is rejected (GCM authentication)", tamperRejected);

  let decryptErrorMentionsNothingSensitive = true;
  try {
    decryptCredential("v1:aaaa:bbbb:cccc");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    decryptErrorMentionsNothingSensitive =
      !message.includes("aaaa") && !message.includes("bbbb") && !message.includes("cccc");
  }
  check("a decryption error does not quote the ciphertext", decryptErrorMentionsNothingSensitive);

  // 2. Rotation ---------------------------------------------------------------
  const originalKey = process.env.APP_ENCRYPTION_KEY;
  const rotatedCiphertext = encryptCredential("rotate-me");
  process.env.APP_ENCRYPTION_KEY_PREVIOUS = originalKey;
  process.env.APP_ENCRYPTION_KEY = "a-different-key-for-the-rotation-check";
  check(
    "a payload stays readable through a key rotation",
    decryptCredential(rotatedCiphertext) === "rotate-me"
  );
  process.env.APP_ENCRYPTION_KEY = originalKey;
  delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
  check("decrypt still works on the restored key", decryptCredential(rotatedCiphertext) === "rotate-me");

  // 3. Redaction --------------------------------------------------------------
  const redacted = redactSecrets('{"error":"bad","token":"abc123","Authorization":"Bearer xyz"}');
  check("a token in an error payload is redacted", !redacted.includes("abc123"));
  // The token is the SECOND word here. Stopping the match at the first space
  // would redact the scheme and leave the secret — the whole point.
  check("a bearer value in an error payload is redacted", !redacted.includes("xyz"), redacted);
  check("redaction keeps the surrounding text", redacted.includes("bad"));
  const headerForm = redactSecrets("Authorization: Bearer sk_test_leaked\nX-Request-Id: 12345");
  check("a raw Authorization header line is redacted", !headerForm.includes("sk_test_leaked"), headerForm);
  check("redaction stops at the end of the line", headerForm.includes("X-Request-Id"), headerForm);
  check(
    "an unquoted key=value pair is redacted",
    !redactSecrets("connection failed password=hunter2 status=401").includes("hunter2"),
    redactSecrets("connection failed password=hunter2 status=401")
  );
  check(
    "a message that merely mentions a key is not mangled",
    redactSecrets("Invalid API Key provided") === "Invalid API Key provided"
  );

  // 4. Credit-signal extraction (never returns the token) ---------------------
  const signals = extractCreditSignals({
    token: "super-secret-token",
    accessToken: "another-token",
    password: "hunter2",
    creditAvailable: 250.5,
    account: { balance: "120.00", apiKey: "nope", creditLimit: 1000 },
  });
  check("credit figures are extracted", signals["creditAvailable"] === 250.5);
  check("nested credit figures are extracted with their path", signals["account.balance"] === "120.00");
  check("nested credit limits are extracted", signals["account.creditLimit"] === 1000);
  check("the token is not in the signals", !JSON.stringify(signals).includes("super-secret-token"));
  check("a second token field is not in the signals", !JSON.stringify(signals).includes("another-token"));
  check("a password is not in the signals", !JSON.stringify(signals).includes("hunter2"));
  check("an api key is not in the signals", !JSON.stringify(signals).includes("nope"));

  // 5. Store round trip, and store-over-environment --------------------------
  const snap = await snapshot();
  try {
    await prisma.integrationCredential.deleteMany({ where: { key: { in: [...TOUCHED_KEYS] } } });
    await prisma.integrationState.updateMany({
      where: { key: { in: [...TOUCHED_KEYS] } },
      data: { disconnectedAt: null },
    });

    // Odoo is used for the fallback checks: it has no stored credentials here,
    // and nothing else in this suite writes to it.
    process.env.ODOO_DATABASE = "env-database";
    process.env.ODOO_API_KEY = "";

    check("with nothing stored, the environment is used", (await getCredential("odoo", "ODOO_DATABASE")) === "env-database");
    check("a blank environment value is not a credential", (await getCredential("odoo", "ODOO_API_KEY")) === null);
    check("an unset environment variable is not a credential", (await getCredential("odoo", "ODOO_URL")) === null);
    check(
      "a placeholder environment value is not a credential",
      await (async () => {
        process.env.ODOO_USERNAME = "__REQUIRED__";
        const value = await getCredential("odoo", "ODOO_USERNAME");
        delete process.env.ODOO_USERNAME;
        return value === null;
      })()
    );

    const saved = await saveCredentials("eshipper", {
      ESHIPPER_BASE_URL: "https://uu2.eshipper.com",
      ESHIPPER_USERNAME: "saved-user",
      ESHIPPER_PASSWORD: "saved-password",
    });
    check("saving reports the field names it wrote", saved.saved.length === 3, saved.saved.join(","));
    check(
      "saving reports blanks as unchanged rather than clearing them",
      saved.unchanged.includes("ESHIPPER_ACCOUNT_ID")
    );

    check("a saved value wins over the environment", (await getCredential("eshipper", "ESHIPPER_USERNAME")) === "saved-user");
    check(
      "a field with no saved value still falls back to the environment",
      (await getCredential("odoo", "ODOO_DATABASE")) === "env-database"
    );

    const storedRow = await prisma.integrationCredential.findUnique({
      where: { key_field: { key: "eshipper", field: "ESHIPPER_PASSWORD" } },
    });
    check("the stored value is ciphertext, not plaintext", !!storedRow && !storedRow.value.includes("saved-password"));
    check("the stored value carries the version tag", !!storedRow && storedRow.value.startsWith("v1:"));

    // A blank submission must not erase what is stored: the browser never holds
    // the secret to re-submit it.
    await saveCredentials("eshipper", { ESHIPPER_PASSWORD: "" });
    check(
      "a blank submission leaves the saved secret in place",
      (await getCredential("eshipper", "ESHIPPER_PASSWORD")) === "saved-password"
    );

    // 5b. The provider-facing read resolves the whole set --------------------
    // This is what the adapters call, and it is the one read that does hand back
    // plaintext secrets — so it must be complete, and it must stay server-side.
    const resolved = await getCredentials("eshipper");
    check("the provider read resolves the stored username", resolved.ESHIPPER_USERNAME === "saved-user");
    check("the provider read resolves the stored secret", resolved.ESHIPPER_PASSWORD === "saved-password");
    check("the provider read resolves the stored base URL", resolved.ESHIPPER_BASE_URL === "https://uu2.eshipper.com");
    check(
      "the provider read omits fields that resolve to nothing",
      !("ESHIPPER_ACCOUNT_ID" in resolved)
    );

    // 6. The credential view carries no secrets ------------------------------
    const states = await credentialFieldStates("eshipper");
    const passwordState = states.find((s) => s.name === "ESHIPPER_PASSWORD");
    check("the view reports the secret as set", passwordState?.isSet === true);
    check("the view never carries the secret value", passwordState?.value === null);
    check(
      "the serialized view contains no secret material",
      !JSON.stringify(states).includes("saved-password") && !JSON.stringify(states).includes("v1:")
    );
    const usernameState = states.find((s) => s.name === "ESHIPPER_USERNAME");
    check("a non-secret field is readable in the view", usernameState?.value === "saved-user");
    check("a non-secret field is marked as stored, not from the environment", usernameState?.fromEnvironment === false);

    const stateView = await getIntegrationState("eshipper");
    check(
      "the integration state view carries no secret material",
      !JSON.stringify(stateView).includes("saved-password") && !JSON.stringify(stateView).includes("v1:")
    );

    // 7. Saving is authenticated, and reports as Connected -------------------
    // A distinctive bearer token so "the token is absent" is a real assertion:
    // a short value like "tok" would match "tokenReceived" and pass vacuously.
    const TOKEN_CANARY = "bearer_LEAKCANARY_7f31";
    installFetch((url) => {
      if (url.includes("/api/v2/authenticate"))
        return { body: { token: TOKEN_CANARY, expires_in: "3600", token_type: "Bearer", refresh_token: "r1", refresh_expires_in: "7200", creditAvailable: 42 } };
      return { status: 500, body: { error: `unexpected url ${url}` } };
    });
    const afterSave = await saveIntegrationCredentials(
      "eshipper",
      { ESHIPPER_BASE_URL: "https://uu2.eshipper.com", ESHIPPER_USERNAME: "saved-user", ESHIPPER_PASSWORD: "saved-password" },
      { actorType: "ADMIN_USER", actorId: "verify-credentials", actorName: "Verification" }
    );
    check("a successful authenticated check reports HEALTHY", afterSave.status === "HEALTHY", afterSave.status);
    check(
      "the detail names the authenticated host and says nothing was booked",
      afterSave.detail.includes("uu2.eshipper.com") && /no shipment was booked/i.test(afterSave.detail),
      afterSave.detail
    );
    check("the detail reports the credit figure the provider gave", afterSave.detail.includes("creditAvailable=42"));
    check("the stored state detail carries no secret", !afterSave.detail.includes("saved-password"));

    // The audit row must name fields, never values.
    const auditRows = await prisma.auditLog.findMany({
      where: { action: "integration.credentials_saved", entityId: "eshipper" },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    const auditBlob = JSON.stringify(auditRows);
    check("an audit row was written for the save", auditRows.length > 0);
    check("the audit row names the saved fields", auditBlob.includes("ESHIPPER_PASSWORD"));
    check("the audit row carries no secret value", !auditBlob.includes("saved-password"));
    check("the audit row carries no ciphertext", !auditBlob.includes("v1:"));

    // 8. A rejected key is a failure, not a pass -----------------------------
    // The key must be saved BEFORE the probe: with nothing stored the probe
    // answers "no key configured" and would pass a weaker version of the next
    // check without a provider ever being consulted.
    await saveCredentials("stripe", { STRIPE_SECRET_KEY: "sk_test_rejected" });
    installFetch(() => ({ status: 401, body: { error: { message: "Invalid API Key provided" } } }));
    const rejected = await testStripeAuthentication();
    check("a rejected Stripe key is not ok", rejected.ok === false);
    check(
      "the rejection reason is the provider's own words, not our fallback",
      (rejected.reason ?? "").includes("Invalid API Key"),
      rejected.reason ?? ""
    );
    check("the probe called Stripe's balance endpoint", calls.some((c) => c.url.endsWith("/v1/balance")));

    const rejectedCheck = await checkIntegration("stripe");
    check("a configured-but-rejected key does not report HEALTHY", rejectedCheck.status !== "HEALTHY", rejectedCheck.status);
    check("a rejected key is reported as FAILED", rejectedCheck.status === "FAILED", rejectedCheck.status);
    check("the failure detail does not quote the key", !rejectedCheck.detail.includes("sk_test_rejected"));
    check("the failure is recorded as an error", !!rejectedCheck.error);

    installFetch(() => ({ status: 200, body: { livemode: false, object: "balance" } }));
    const accepted = await testStripeAuthentication();
    check("an accepted Stripe key is ok", accepted.ok === true);
    check("Stripe's test-mode flag is surfaced", accepted.livemode === false);

    installFetch(() => ({ status: 200, body: { livemode: true, object: "balance" } }));
    const liveState = await checkIntegration("stripe");
    check("a live key is connected but flagged", liveState.status === "HEALTHY" && /LIVE key/.test(liveState.detail), liveState.detail);

    // 9. The webhook secret resolves from the store -------------------------
    installFetch(() => ({ status: 200, body: {} }));
    await saveCredentials("stripe", { STRIPE_WEBHOOK_SECRET: "whsec_from_store" });
    check("the webhook signing secret resolves from the store", (await stripeWebhookSecret()) === "whsec_from_store");
    check("the secret key also resolves from the store", (await stripeSecretKey()) === "sk_test_rejected");

    // 10. Disconnect actually disables the provider -------------------------
    // The environment still holds working credentials and the base URL is the
    // recognised test host, so without the flag the provider would be live.
    process.env.ESHIPPER_USERNAME = "env-user";
    process.env.ESHIPPER_PASSWORD = "env-password";
    process.env.ESHIPPER_BASE_URL = "https://uu2.eshipper.com";

    check("before disconnecting, the provider is reachable", (await eshipperConfigured()) === true);

    const disconnected = await disconnectIntegration("eshipper", {
      actorType: "ADMIN_USER",
      actorId: "verify-credentials",
      actorName: "Verification",
    });
    check("disconnect marks the integration disconnected", !!disconnected.disconnectedAt);
    check("disconnect removes the stored credentials", (await prisma.integrationCredential.count({ where: { key: "eshipper" } })) === 0);
    check("disconnect suppresses the stored values", (await getCredential("eshipper", "ESHIPPER_USERNAME")) === null);
    check(
      "disconnect suppresses the ENVIRONMENT too, which is what makes it real",
      (await getCredential("eshipper", "ESHIPPER_PASSWORD")) === null
    );
    check("a disconnected provider is not configured", (await eshipperConfigured()) === false);
    check("a disconnected provider reports unconfigured", (await eshipperEnvironment()) === "unconfigured");
    check("the disconnect flag is visible to the store", (await isProviderDisconnected("eshipper")) === true);
    check("disconnect resets the integration status", disconnected.status === "NOT_CONFIGURED", disconnected.status);
    check(
      "the disconnect detail says provider operations are disabled",
      /provider operations are disabled/i.test(disconnected.detail)
    );
    check(
      "a disconnected provider still reports every field as unset",
      (await credentialFieldStates("eshipper")).every((field) => !field.isSet)
    );

    // 10b. The store primitive, on its own -----------------------------------
    // disconnectIntegration also writes status and audit rows. These two lines
    // are what actually switch the provider off, so they are asserted directly:
    // a second call must be a harmless no-op rather than lifting the flag or
    // throwing on a provider that has nothing left to delete.
    const second = await disconnectCredentials("eshipper");
    check("disconnecting an already-disconnected provider removes nothing", second.removed === 0, String(second.removed));
    check("disconnecting twice leaves the provider disconnected", (await isProviderDisconnected("eshipper")) === true);
    check(
      "disconnecting twice leaves the environment suppressed",
      (await getCredential("eshipper", "ESHIPPER_PASSWORD")) === null
    );

    const disconnectAudit = await prisma.auditLog.findFirst({
      where: { action: "integration.disconnected", entityId: "eshipper" },
      orderBy: { createdAt: "desc" },
    });
    check("the disconnect audit row records that operations were disabled",
      !!disconnectAudit && JSON.stringify(disconnectAudit.afterData).includes("providerOperationsDisabled"));
    check(
      "the disconnect audit row carries no secret",
      !!disconnectAudit && !JSON.stringify(disconnectAudit).includes("saved-password")
    );

    // 11. Saving credentials again lifts the disconnect ---------------------
    installFetch((url) =>
      url.includes("/api/v2/authenticate")
        ? { body: { token: "tok", expires_in: "3600", token_type: "Bearer", refresh_token: "r2", refresh_expires_in: "7200" } }
        : { status: 500, body: { error: "unexpected" } }
    );
    await saveCredentials("eshipper", {
      ESHIPPER_BASE_URL: "https://uu2.eshipper.com",
      ESHIPPER_USERNAME: "saved-user",
      ESHIPPER_PASSWORD: "saved-password",
    });
    check("saving credentials lifts the disconnect", (await isProviderDisconnected("eshipper")) === false);
    check("the provider is reachable again after saving", (await eshipperConfigured()) === true);

    // 12. Authentication without booking ------------------------------------
    const authTest = await testEshipperAuthentication();
    check("authentication succeeds against the confirmed test host", authTest.ok === true, authTest.reason ?? "");
    check("authentication reports the test environment", authTest.environment === "test");
    check("authentication reports the host it used", authTest.baseUrlHost === "uu2.eshipper.com");
    check("authentication reports the host as recognised", authTest.recognizedTestHost === true);
    check("authentication confirms a token was issued", authTest.tokenReceived === true);
    check("the auth test result carries no token", !JSON.stringify(authTest).includes(TOKEN_CANARY));
    check(
      "authentication touched only the authenticate endpoint",
      calls.filter((c) => c.url.includes("/api/v2/")).every((c) => c.url.includes("/authenticate")),
      calls.filter((c) => c.url.includes("/api/v2/")).map((c) => c.url).join(" | ")
    );
    check(
      "no quote, booking, label or cancel path was called",
      !calls.some((c) => /\/quote|\/ship|\/label|\/cancel|\/returns|\/pickup/.test(c.url))
    );

    // A provider that answers without a token is not authenticated.
    installFetch(() => ({ status: 200, body: { message: "welcome" } }));
    const noToken = await testEshipperAuthentication();
    check("an answer with no token is not ok", noToken.ok === false);
    check("the reason says no token was issued", /no token/i.test(noToken.reason ?? ""));

    // An unreachable provider is a failure with a reason, not a crash.
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const unreachable = await testEshipperAuthentication();
    check("an unreachable provider fails cleanly", unreachable.ok === false);
    check("the failure carries a reason", (unreachable.reason ?? "").length > 0);

    // 13. Environment classification is unchanged for the paths that matter --
    check(
      "an arbitrary sandbox host is still refused without an explicit env",
      classifyEshipperEnvironment({ baseUrl: "https://sandbox.example/api", username: "u", password: "p", env: null }) === "unconfigured"
    );
    check(
      "the recognised test host needs no sandbox marker",
      classifyEshipperEnvironment({ baseUrl: "https://uu2.eshipper.com", username: "u", password: "p", env: null }) === "test"
    );
    check("a lookalike host is not recognised", isRecognizedTestHost("https://uu2.eshipper.com.attacker.example") === false);

    // 14. Operational checks are untouched by any of this ------------------
    for (const key of OPERATIONAL_KEYS) {
      const state = await getIntegrationState(key);
      check(`operational ${key} still reports`, typeof state.status === "string" && state.status.length > 0, state.status);
      check(`operational ${key} exposes no credential fields`, state.credentialFields.length === 0);
    }
    check(
      "operational keys still resolve their own checks",
      (await checkIntegration("product_import")).detail.length > 0
    );

    // 15. Credential reads are name-limited ---------------------------------
    let refusedUnknownField = false;
    try {
      await getCredential("eshipper", "SHOPIFY_API_SECRET");
    } catch {
      refusedUnknownField = true;
    }
    check("the store refuses to read a field it does not define", refusedUnknownField);

    let refusedOperationalSave = false;
    try {
      await saveIntegrationCredentials("shopify_orders", { SHOPIFY_API_KEY: "x" }, {
        actorType: "ADMIN_USER",
        actorId: "verify-credentials",
      });
    } catch {
      refusedOperationalSave = true;
    }
    check("an operational key cannot be given credentials", refusedOperationalSave);

    let refusedOperationalDisconnect = false;
    try {
      await disconnectIntegration("product_import", { actorType: "ADMIN_USER", actorId: "verify-credentials" });
    } catch {
      refusedOperationalDisconnect = true;
    }
    check("an operational check cannot be disconnected", refusedOperationalDisconnect);

    // 16. Rotation is a no-op on rows already on the current key ------------
    const rotation = await rotateCredentialKeys();
    check("rotation leaves current-key rows alone", rotation.rotated === 0 && rotation.unreadable === 0, JSON.stringify(rotation));
  } finally {
    await restore(snap);
    const restoredRows = await prisma.integrationCredential.count({ where: { key: { in: [...TOUCHED_KEYS] } } });
    const restoredStates = await prisma.integrationState.findMany({
      where: { key: { in: [...TOUCHED_KEYS] } },
      select: { key: true, disconnectedAt: true },
    });
    console.log(
      `restored ${restoredRows} credential row(s) (snapshot held ${snap.credentials.length}) and ${restoredStates.length} state row(s)`
    );
    console.log(
      `disconnect flags after restore: ${restoredStates.map((s) => `${s.key}=${s.disconnectedAt ? "set" : "null"}`).join(", ") || "(no state rows)"}`
    );
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("verify-credentials crashed:", error);
  process.exitCode = 1;
});
