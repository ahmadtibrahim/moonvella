import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "~/db.server";
import { setIntegrationState } from "./integrationHealth.server";

/**
 * Plaid integration for linking a seller's OWN bank account.
 *
 * Security:
 * - The access token is encrypted at rest (AES-256-GCM) and is NEVER returned to
 *   the browser. Only masked account fields are exposed.
 * - Plaid credentials (PLAID_CLIENT_ID / PLAID_SECRET) are backend-only.
 * - Linking a bank account does NOT collect payment and must never mark an
 *   invoice paid or release a shipment.
 *
 * Env var names: PLAID_ENV (sandbox|development|production), PLAID_CLIENT_ID,
 * PLAID_SECRET, and optionally APP_ENCRYPTION_KEY for at-rest encryption.
 */

export function plaidConfigured(): boolean {
  return !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SECRET;
}

export function plaidEnv(): string {
  return process.env.PLAID_ENV || "sandbox";
}

function plaidBase(): string {
  const env = plaidEnv();
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

const CURRENT_KEY_ENV = "APP_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV = "APP_ENCRYPTION_KEY_PREVIOUS";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest().subarray(0, 32);
}

function currentKey(): Buffer {
  const secret = process.env[CURRENT_KEY_ENV];
  if (!secret) {
    throw new Error(
      "Bank token encryption is not configured. Set a dedicated, persistent APP_ENCRYPTION_KEY " +
        "(backend-only). The Plaid API secret is never used as the encryption key."
    );
  }
  return deriveKey(secret);
}

function previousKey(): Buffer | null {
  const secret = process.env[PREVIOUS_KEY_ENV];
  return secret ? deriveKey(secret) : null;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", currentKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Versioned format so a future key rotation can be detected safely.
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptToken(payload: string): string {
  const parts = payload.split(":");
  const isVersioned = parts.length === 4 && parts[0] === "v1";
  const [ivB64, tagB64, dataB64] = isVersioned ? parts.slice(1) : parts;

  // Try the current key, then the previous key (rotation). Existing records stay
  // readable during rotation.
  const candidates = [currentKey(), previousKey()].filter((k): k is Buffer => !!k);
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "Could not decrypt the stored bank token. If you rotated keys, set APP_ENCRYPTION_KEY_PREVIOUS to the old key."
  );
}

export function needsReEncryption(payload: string): boolean {
  return !payload.startsWith("v1:");
}

/**
 * Explicit key rotation. Set APP_ENCRYPTION_KEY to the new key and
 * APP_ENCRYPTION_KEY_PREVIOUS to the old key, then run this once. Existing
 * records remain readable throughout (decrypt falls back to the previous key)
 * and are re-encrypted with the current key.
 */
export async function rotateBankTokenKeys(): Promise<{ rotated: number }> {
  const rows = await prisma.sellerBankAccount.findMany({
    select: { id: true, encryptedAccessToken: true },
  });
  let rotated = 0;
  for (const row of rows) {
    if (!needsReEncryption(row.encryptedAccessToken)) continue;
    const plain = decryptToken(row.encryptedAccessToken);
    await prisma.sellerBankAccount.update({
      where: { id: row.id },
      data: { encryptedAccessToken: encryptToken(plain) },
    });
    rotated++;
  }
  return { rotated };
}

async function plaidPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${plaidBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
  });
  const json = await res.json();
  if (!res.ok) {
    // Never echo credentials; Plaid error messages are safe.
    throw new Error(json?.error_message || json?.error_code || `Plaid error ${res.status}`);
  }
  return json;
}

export async function createLinkToken(sellerId: string) {
  if (!plaidConfigured()) {
    await setIntegrationState("plaid", {
      status: "NOT_CONFIGURED",
      detail: "Simulated Plaid Link. Set PLAID_CLIENT_ID/PLAID_SECRET (PLAID_ENV=sandbox) for the real sandbox flow.",
    });
    return { simulated: true, linkToken: `link-sandbox-sim-${sellerId}` };
  }
  const json = await plaidPost("/link/token/create", {
    user: { client_user_id: sellerId },
    client_name: "MoonVella",
    products: ["auth"],
    country_codes: ["CA", "US"],
    language: "en",
  });
  await setIntegrationState("plaid", { status: "HEALTHY", detail: `Link token created (${plaidEnv()}).` });
  return { simulated: false, linkToken: json.link_token as string };
}

export async function exchangePublicToken(publicToken: string) {
  if (!plaidConfigured()) {
    return {
      simulated: true,
      accessToken: `access-sandbox-sim-${publicToken}`,
      itemId: `item-sim-${publicToken}`,
      accounts: [{ name: "Simulated Chequing", mask: "0000", type: "depository", subtype: "checking" }],
      institutionName: "Simulated Bank",
    };
  }
  const exchanged = await plaidPost("/item/public_token/exchange", { public_token: publicToken });
  const accounts = await plaidPost("/accounts/get", { access_token: exchanged.access_token });
  const first = accounts.accounts?.[0];
  const institutionName = (accounts.item?.institution_name as string) || "Bank";
  return {
    simulated: false,
    accessToken: exchanged.access_token as string,
    itemId: exchanged.item_id as string,
    accounts: (accounts.accounts ?? []).map((a: Record<string, unknown>) => ({
      name: a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
    })),
    institutionName,
    firstAccount: first,
  };
}

async function removePlaidItem(accessToken: string) {
  if (!plaidConfigured()) return { removed: true };
  await plaidPost("/item/remove", { access_token: accessToken });
  return { removed: true };
}

/** Store a linked bank account for a seller. Access token encrypted at rest. */
export async function storeBankAccount(
  sellerId: string,
  input: {
    accessToken: string;
    itemId: string | null;
    institutionName: string | null;
    accountName: string | null;
    accountMask: string | null;
    accountType: string | null;
    accountSubtype: string | null;
    simulated: boolean;
  }
) {
  return prisma.sellerBankAccount.create({
    data: {
      sellerId,
      provider: input.simulated ? "plaid_simulated" : "plaid",
      plaidItemId: input.itemId,
      encryptedAccessToken: encryptToken(input.accessToken),
      institutionName: input.institutionName,
      accountName: input.accountName,
      accountMask: input.accountMask,
      accountType: input.accountType,
      accountSubtype: input.accountSubtype,
      status: "CONNECTED",
    },
  });
}

/** Masked view for the UI — never includes the access token. */
export async function listBankAccounts(sellerId: string) {
  const rows = await prisma.sellerBankAccount.findMany({
    where: { sellerId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    institutionName: r.institutionName,
    accountName: r.accountName,
    accountMask: r.accountMask,
    accountType: r.accountType,
    accountSubtype: r.accountSubtype,
    status: r.status,
    provider: r.provider,
    connectedAt: r.createdAt,
  }));
}

export async function disconnectBankAccount(sellerId: string, id: string) {
  const row = await prisma.sellerBankAccount.findFirst({ where: { id, sellerId } });
  if (!row) throw new Error("Bank account not found.");
  try {
    await removePlaidItem(decryptToken(row.encryptedAccessToken));
  } catch {
    // Removal failure should not block local disconnect.
  }
  await prisma.sellerBankAccount.update({ where: { id }, data: { status: "DISCONNECTED" } });
  return { ok: true };
}
