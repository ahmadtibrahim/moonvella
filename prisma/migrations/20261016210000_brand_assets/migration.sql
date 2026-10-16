-- MoonVella's own brand images, versioned.
--
-- PURELY ADDITIVE. One new table and one new enum type, referenced by nothing
-- that exists. The deployed image neither reads nor writes either, so it keeps
-- working unchanged for the window between `migrate deploy` and the new
-- container taking traffic.
--
-- WHY A TABLE AND NOT A FILE. The logo has to reach four surfaces — the operator
-- sidebar and login page, the embedded Shopify app's content header, the
-- invoice and statement PDFs, and the favicon — and the PDF is the one that
-- settles it. The PDF renderer (PDFKit) reads bytes, not a URL: it embeds an
-- image by being handed a Buffer. A logo that lives only on disk as a file the
-- running process may or may not be able to reach is a logo that prints blank
-- on the one document a customer keeps. So the bytes are stored through the same
-- `StorageBackend` as media, and the ROW is what the renderer resolves.
--
-- WHY `version` AND `supersededAt` RATHER THAN ONE ROW PER SLOT. The owner asked
-- to be able to replace a logo and roll it back. One row per slot can be
-- replaced but not rolled back: the bytes are gone the moment the new file is
-- written. Keeping every version and marking the one in use makes the rollback a
-- fact about the data. Exactly one row per slot has `supersededAt` NULL at any
-- time; the partial unique index below is what enforces that, rather than
-- application code that a second concurrent upload could race.
--
-- NO SEED ROWS. The owner's own files are written by the application (see
-- `app/services/branding.server.ts`), because seeding them here would mean
-- embedding image bytes in SQL and would put a placeholder logo in front of the
-- owner before anybody had chosen one. An empty slot falls back to the
-- typographic wordmark, never to a mockup's M and crescent.

CREATE TYPE "BrandSlot" AS ENUM ('PRIMARY', 'DARK', 'SQUARE', 'INVOICE');

CREATE TABLE "BrandAsset" (
  "id"             TEXT NOT NULL,
  "slot"           "BrandSlot" NOT NULL,
  "version"        INTEGER NOT NULL,
  "storageKey"     TEXT NOT NULL,
  "contentType"    TEXT NOT NULL,
  "width"          INTEGER NOT NULL,
  "height"         INTEGER NOT NULL,
  "bytes"          INTEGER NOT NULL,
  "checksum"       TEXT NOT NULL,
  "originalName"   TEXT,
  "createdById"    TEXT,
  "createdByName"  TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt"   TIMESTAMP(3),

  CONSTRAINT "BrandAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BrandAsset_slot_version_key" ON "BrandAsset" ("slot", "version");

-- AT MOST ONE LIVE VERSION PER SLOT, enforced by the database.
--
-- A partial unique index: it constrains only the rows where `supersededAt` IS
-- NULL, so any number of superseded versions may exist while the in-use one
-- stays unique. Doing this in application code ("supersede the old one, then
-- insert") leaves a window in which two uploads racing each other both read the
-- same live row and both insert — and the slot then has two live versions, which
-- every reader resolves differently.
CREATE UNIQUE INDEX "BrandAsset_slot_live_key"
  ON "BrandAsset" ("slot")
  WHERE "supersededAt" IS NULL;

CREATE INDEX "BrandAsset_slot_supersededAt_idx" ON "BrandAsset" ("slot", "supersededAt");
