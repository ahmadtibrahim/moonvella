-- Operator-supplied provider credentials, encrypted at rest, plus the flag that
-- makes Disconnect actually disable a provider.
--
-- Additive and idempotent: nothing existing is rewritten, and no production
-- record is removed. Credential values arrive only through the Settings form and
-- are encrypted by the application before they reach this table.

CREATE TABLE IF NOT EXISTS "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationCredential_key_field_key"
    ON "IntegrationCredential"("key", "field");

CREATE INDEX IF NOT EXISTS "IntegrationCredential_key_idx"
    ON "IntegrationCredential"("key");

-- Nullable, so every existing IntegrationState row keeps its meaning: NULL means
-- "never disconnected", not "unknown".
ALTER TABLE "IntegrationState" ADD COLUMN IF NOT EXISTS "disconnectedAt" TIMESTAMP(3);
