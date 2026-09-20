import { PrismaClient } from "@prisma/client";
import {
  createLinkToken,
  exchangePublicToken,
  storeBankAccount,
  listBankAccounts,
  disconnectBankAccount,
  decryptToken,
  encryptToken,
  plaidConfigured,
} from "../app/services/plaid.server";

const prisma = new PrismaClient();
const SHOP_A = "plaid-a.myshopify.com";
const SHOP_B = "plaid-b.myshopify.com";
let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function cleanup() {
  for (const shop of [SHOP_A, SHOP_B]) {
    const s = await prisma.seller.findUnique({ where: { shopDomain: shop } });
    if (s) {
      await prisma.sellerBankAccount.deleteMany({ where: { sellerId: s.id } });
      await prisma.seller.delete({ where: { id: s.id } });
    }
  }
  await prisma.integrationState.deleteMany({ where: { key: "plaid" } });
}

async function mkSeller(shop: string, name: string) {
  return prisma.seller.create({
    data: { shopDomain: shop, storeName: name, shopDomainFull: shop, contactEmail: `${name}@t.example`, status: "APPROVED", approvedAt: new Date() },
  });
}

async function main() {
  await cleanup();
  const a = await mkSeller(SHOP_A, "Plaid A");
  const b = await mkSeller(SHOP_B, "Plaid B");

  check("plaid reports unconfigured (simulated) without credentials", plaidConfigured() === false);

  const link = await createLinkToken(a.id);
  check("link token created (simulated, labelled)", link.simulated === true && !!link.linkToken);

  const exchanged = await exchangePublicToken("public-sandbox-token");
  check("public token exchanged (simulated)", exchanged.simulated === true && !!exchanged.accessToken);

  const stored = await storeBankAccount(a.id, {
    accessToken: exchanged.accessToken,
    itemId: exchanged.itemId,
    institutionName: exchanged.institutionName,
    accountName: exchanged.accounts?.[0]?.name ?? null,
    accountMask: exchanged.accounts?.[0]?.mask ?? null,
    accountType: exchanged.accounts?.[0]?.type ?? null,
    accountSubtype: exchanged.accounts?.[0]?.subtype ?? null,
    simulated: true,
  });

  const raw = await prisma.sellerBankAccount.findUnique({ where: { id: stored.id } });
  check("access token stored encrypted (not plaintext)", !!raw && raw.encryptedAccessToken !== exchanged.accessToken && raw.encryptedAccessToken.includes(":"));
  check("encrypted token is versioned (v1:)", !!raw && raw.encryptedAccessToken.startsWith("v1:"));
  check("encrypted token decrypts to the original", decryptToken(raw!.encryptedAccessToken) === exchanged.accessToken);

  // No silent fallback to the Plaid API secret as an encryption key.
  {
    const saved = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    process.env.PLAID_SECRET = "plaid-secret-must-not-be-the-key";
    let threw = false;
    try {
      encryptToken("x");
    } catch {
      threw = true;
    }
    process.env.APP_ENCRYPTION_KEY = saved;
    delete process.env.PLAID_SECRET;
    check("no fallback to PLAID_SECRET for encryption", threw === true);
  }

  const listA = await listBankAccounts(a.id);
  check("masked view has no access token field", listA.length === 1 && !("accessToken" in listA[0]) && !("encryptedAccessToken" in listA[0]));
  check("masked view shows institution/mask", listA[0].institutionName === "Simulated Bank" && listA[0].accountMask === "0000");

  const listB = await listBankAccounts(b.id);
  check("tenant isolation: seller B sees no seller A accounts", listB.length === 0);

  await disconnectBankAccount(a.id, stored.id);
  const after = await prisma.sellerBankAccount.findUnique({ where: { id: stored.id } });
  check("disconnect marks account DISCONNECTED", after?.status === "DISCONNECTED");

  await cleanup();
  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
