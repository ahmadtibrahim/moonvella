import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "~/db.server";
import {
  ALL_CREDENTIAL_FIELD_NAMES,
  credentialFields,
  type CredentialKey,
} from "./integrationFields";

/**
 * Encrypted storage for operator-supplied provider credentials.
 *
 * Three things this module is responsible for, in order of how much they matter:
 *
 * 1. A secret never leaves the server in readable form. Values are encrypted
 *    with AES-256-GCM before they reach the database, decrypted only at the
 *    moment a provider call needs one, and never logged, audited, echoed into an
 *    error message, or rendered into the Settings page. The page learns only
 *    *whether* a secret is set.
 *
 * 2. Saving in Settings actually takes effect. A stored value wins over the
 *    environment, so what an operator saves is what the provider calls use.
 *
 * 3. Disconnect disables the provider for real. It cancels the environment too,
 *    because otherwise a provider configured through the environment would keep
 *    making live calls after an operator pressed Disconnect — the status would
 *    say NOT_CONFIGURED while shipments were still being booked.
 *
 * Encryption format is versioned (`v1:iv:tag:ciphertext`) and decrypt falls back
 * to APP_ENCRYPTION_KEY_PREVIOUS so a key rotation stays readable.
 */

const CURRENT_KEY_ENV = "APP_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV = "APP_ENCRYPTION_KEY_PREVIOUS";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest().subarray(0, 32);
}

function currentKey(): Buffer {
  const secret = process.env[CURRENT_KEY_ENV];
  if (!secret) {
    throw new Error(
      "Credential encryption is not configured. Set a persistent, backend-only " +
        "APP_ENCRYPTION_KEY; without it, stored provider credentials cannot be read."
    );
  }
  return deriveKey(secret);
}

function previousKey(): Buffer | null {
  const secret = process.env[PREVIOUS_KEY_ENV];
  return secret ? deriveKey(secret) : null;
}

function decryptWith(key: Buffer, payload: string): string {
  const parts = payload.split(":");
  const isVersioned = parts.length === 4 && parts[0] === "v1";
  const [ivB64, tagB64, dataB64] = isVersioned ? parts.slice(1) : parts;

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptCredential(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", currentKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  // Versioned so a future rotation can detect what it is reading.
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

/**
 * Note what the failure message does NOT contain: the ciphertext, the key, or
 * any part of the plaintext. A decryption failure is reported by field name.
 */
export function decryptCredential(payload: string): string {
  const candidates = [currentKey(), previousKey()].filter((k): k is Buffer => !!k);
  for (const key of candidates) {
    try {
      return decryptWith(key, payload);
    } catch {
      // Try the next candidate; the caller hears about it only if all fail.
    }
  }
  throw new Error(
    "Could not decrypt a stored credential. If APP_ENCRYPTION_KEY was rotated, set " +
      "APP_ENCRYPTION_KEY_PREVIOUS to the former key so existing records stay readable."
  );
}

export function needsReEncryption(payload: string): boolean {
  return !payload.startsWith("v1:");
}

/**
 * Mask anything credential-shaped in text that is about to be stored or shown:
 * a provider error body can quote the request back, and the request carried a
 * key. Applied before an error message becomes an integration detail.
 */
export function redactSecrets(text: string): string {
  return text
    .slice(0, 500)
    .replace(
      // The value runs to the end of its JSON string, to the next comma or
      // brace, or to the end of the line — WHITESPACE IS PART OF IT. An
      // `Authorization` value is `Bearer <token>`, so stopping at the first
      // space would leave the token itself, which is the only part that
      // matters, in the clear. A newline still ends the match, so a header line
      // cannot swallow the lines that follow it.
      /("?(?:token|access_?token|refresh_?token|password|secret|api[_-]?key|authorization|client_secret|key)"?\s*[:=]\s*"?)([^",}\n]+)/gi,
      "$1[redacted]"
    );
}

/** Only names this store knows may be read, so it cannot become an env reader. */
const FIELD_ALLOWLIST = new Set(ALL_CREDENTIAL_FIELD_NAMES);

/**
 * An environment value that is blank or a `__REQUIRED…` placeholder is not a
 * credential. Credentials are read by name, so their values are trimmed here
 * rather than at each call site.
 */
function fromEnvironment(field: string): string | null {
  const raw = process.env[field];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("__REQUIRED")) return null;
  return trimmed;
}

export async function isProviderDisconnected(key: CredentialKey): Promise<boolean> {
  const row = await prisma.integrationState.findUnique({
    where: { key },
    select: { disconnectedAt: true },
  });
  return !!row?.disconnectedAt;
}

interface ResolveContext {
  disconnected: boolean;
  stored: Map<string, string>;
}

/**
 * One read of everything resolution needs, so a caller that wants every field
 * (the Settings page) costs two queries instead of two per field, and so the
 * precedence below exists in exactly one place.
 */
async function loadContext(key: CredentialKey): Promise<ResolveContext> {
  const [state, rows] = await Promise.all([
    prisma.integrationState.findUnique({ where: { key }, select: { disconnectedAt: true } }),
    prisma.integrationCredential.findMany({ where: { key }, select: { field: true, value: true } }),
  ]);
  return {
    disconnected: !!state?.disconnectedAt,
    stored: new Map(rows.map((row) => [row.field, row.value])),
  };
}

/**
 * Resolve one credential. Order: Disconnect, then the encrypted store, then the
 * environment. Disconnect is checked first deliberately — it is what makes an
 * operator's Disconnect stronger than a deployment's environment.
 */
function resolveField(field: string, context: ResolveContext): string | null {
  if (!FIELD_ALLOWLIST.has(field)) {
    throw new Error(`Refusing to read an unknown credential field: ${field}`);
  }
  if (context.disconnected) return null;

  const stored = context.stored.get(field);
  if (stored !== undefined) {
    let plain: string;
    try {
      plain = decryptCredential(stored).trim();
    } catch (error) {
      // Re-thrown with the field named and nothing else added: the operator
      // needs to know which credential is unreadable, not what it contained.
      throw new Error(
        `${field} is stored but could not be decrypted: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
    if (plain !== "") return plain;
  }

  return fromEnvironment(field);
}

export async function getCredential(key: CredentialKey, field: string): Promise<string | null> {
  return resolveField(field, await loadContext(key));
}

/** Every configured field for one integration. Absent fields are simply omitted. */
export async function getCredentials(key: CredentialKey): Promise<Record<string, string>> {
  const context = await loadContext(key);
  const resolved: Record<string, string> = {};
  for (const spec of credentialFields(key)) {
    const value = resolveField(spec.name, context);
    if (value !== null) resolved[spec.name] = value;
  }
  return resolved;
}

export interface CredentialFieldState {
  name: string;
  isSet: boolean;
  /**
   * Present ONLY for non-secret fields (a base URL, an account name). For a
   * secret this is always null, whatever the field holds.
   */
  value: string | null;
  updatedAt: Date | null;
  /** True when the value came from the environment rather than this store. */
  fromEnvironment: boolean;
  /**
   * Set when a stored value could not be decrypted. The Settings page shows this
   * instead of failing outright: a key rotation the server cannot follow is
   * something an operator needs to see on the page, not a 500.
   */
  problem: string | null;
}

/**
 * The only shape in which credential state may reach the browser. A secret's
 * `value` is null unconditionally — not masked, not truncated, null — so no
 * rendering mistake can turn this into a disclosure.
 */
export async function credentialFieldStates(key: CredentialKey): Promise<CredentialFieldState[]> {
  const [context, rows] = await Promise.all([
    loadContext(key),
    prisma.integrationCredential.findMany({
      where: { key },
      select: { field: true, updatedAt: true },
    }),
  ]);
  const storedAt = new Map(rows.map((row) => [row.field, row.updatedAt]));

  return credentialFields(key).map((spec) => {
    let resolved: string | null = null;
    let problem: string | null = null;
    try {
      resolved = resolveField(spec.name, context);
    } catch (error) {
      // Reported on the field rather than thrown: the page must still render so
      // the operator can see which credential is unreadable and re-save it.
      problem = error instanceof Error ? error.message : "This value could not be read.";
    }
    return {
      name: spec.name,
      // A value that exists but cannot be read is still a set value; saying
      // "not set" would invite an operator to overwrite something recoverable.
      isSet: resolved !== null || problem !== null,
      value: spec.secret ? null : resolved,
      updatedAt: storedAt.get(spec.name) ?? null,
      fromEnvironment: resolved !== null && !storedAt.has(spec.name),
      problem,
    };
  });
}

export interface SaveCredentialsResult {
  /** Field names written. Never values. */
  saved: string[];
  /** Fields left alone because the submission was blank. */
  unchanged: string[];
}

/**
 * Persist submitted credentials.
 *
 * A blank field means "leave what is saved alone", not "erase it": the browser
 * never receives a secret to re-submit, so treating blank as erase would wipe a
 * working credential every time an operator changed only the base URL.
 * Non-secret fields are prefilled with their current value, so blank there is
 * equally unambiguous.
 *
 * Nothing in this function logs, audits or returns a submitted value.
 */
export async function saveCredentials(
  key: CredentialKey,
  values: Record<string, string>
): Promise<SaveCredentialsResult> {
  const saved: string[] = [];
  const unchanged: string[] = [];

  for (const spec of credentialFields(key)) {
    const submitted = values[spec.name];
    if (submitted === undefined || submitted.trim() === "") {
      unchanged.push(spec.name);
      continue;
    }
    const encrypted = encryptCredential(submitted.trim());
    await prisma.integrationCredential.upsert({
      where: { key_field: { key, field: spec.name } },
      create: { key, field: spec.name, value: encrypted },
      update: { value: encrypted },
    });
    saved.push(spec.name);
  }

  // Saving credentials is an explicit act of configuring a provider, so it lifts
  // an earlier Disconnect. Without this, a disconnected provider could never be
  // brought back from the Settings page.
  if (saved.length > 0) {
    await prisma.integrationState.upsert({
      where: { key },
      create: { key, disconnectedAt: null },
      update: { disconnectedAt: null },
    });
  }

  return { saved, unchanged };
}

/**
 * Disconnect: remove this store's credentials AND set the flag that suppresses
 * the environment. Either half alone would leave the provider reachable.
 */
export async function disconnectCredentials(key: CredentialKey): Promise<{ removed: number }> {
  const { count } = await prisma.integrationCredential.deleteMany({ where: { key } });
  await prisma.integrationState.upsert({
    where: { key },
    create: { key, disconnectedAt: new Date() },
    update: { disconnectedAt: new Date() },
  });
  return { removed: count };
}

/** Convenience wrappers so the two Stripe modules share one resolution path. */
export async function stripeSecretKey(): Promise<string | null> {
  return getCredential("stripe", "STRIPE_SECRET_KEY");
}

export async function stripeWebhookSecret(): Promise<string | null> {
  return getCredential("stripe", "STRIPE_WEBHOOK_SECRET");
}

/**
 * Key rotation. Set APP_ENCRYPTION_KEY to the new key and
 * APP_ENCRYPTION_KEY_PREVIOUS to the old one, run this once, then clear the
 * previous key. Records stay readable throughout: anything already on the
 * current key is left untouched.
 */
export async function rotateCredentialKeys(): Promise<{ rotated: number; unreadable: number }> {
  const rows = await prisma.integrationCredential.findMany({
    select: { id: true, value: true },
  });
  let rotated = 0;
  let unreadable = 0;

  for (const row of rows) {
    try {
      decryptWith(currentKey(), row.value);
      continue; // Already on the current key.
    } catch {
      // Fall through to the previous key.
    }
    const previous = previousKey();
    let plain: string | null = null;
    if (previous) {
      try {
        plain = decryptWith(previous, row.value);
      } catch {
        plain = null;
      }
    }
    if (plain === null) {
      unreadable++;
      continue;
    }
    await prisma.integrationCredential.update({
      where: { id: row.id },
      data: { value: encryptCredential(plain) },
    });
    rotated++;
  }

  return { rotated, unreadable };
}
