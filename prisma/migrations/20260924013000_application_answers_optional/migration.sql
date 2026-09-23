-- A merchant application row can exist before the merchant has answered
-- anything. Opening /app/application caches the imported Shopify profile onto a
-- row so the page has a stored snapshot, a "last refreshed" time and a working
-- Refresh button — and that row cannot fill in answers nobody has given. The
-- four columns below are those answers, so the row that precedes them needs them
-- to be absent, which is what NULL means here and why `submittedAt` is the
-- column that says whether an application has actually been submitted.
--
-- This is what fixed the live "Application Error" on app.moonvella.com/
-- app/application: the first-visit import's INSERT was refused by the client
-- before it ever reached the database, because four required columns were not in
-- the payload (Prisma reports the first one, `contactName`). Existing rows keep
-- every value they have; nothing is dropped, defaulted or backfilled.

ALTER TABLE "MerchantApplication" ALTER COLUMN "contactName" DROP NOT NULL;
ALTER TABLE "MerchantApplication" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "MerchantApplication" ALTER COLUMN "legalBusinessName" DROP NOT NULL;
ALTER TABLE "MerchantApplication" ALTER COLUMN "productCategory" DROP NOT NULL;
