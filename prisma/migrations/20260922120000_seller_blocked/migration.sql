-- ============================================================================
-- BLOCKED as a real seller and application status
-- ============================================================================
--
-- Adds a seventh state to the seller lifecycle. Suspending a store pauses it —
-- the store keeps read access to what it already sold, so a deactivation does
-- not look like data loss. Blocking is the harder refusal the owner asked for:
-- no wholesale pricing, no imports, no new orders, no product sync, and no
-- order history either. The two are not the same control, so they are not the
-- same value.
--
-- WHY THIS FILE IS SAFE ON A POPULATED DATABASE
--
--   Every statement is additive. `ALTER TYPE ... ADD VALUE` adds a label to the
--   type without touching a single row: the six existing statuses keep their
--   meaning and every existing seller keeps its status. The two new columns are
--   nullable with no default, so they cost nothing on write and read as NULL for
--   sellers that predate them — which is exactly correct, because a seller that
--   has never been blocked has no block date and no block reason.
--
--   Nothing here writes 'BLOCKED' into any row. That matters beyond caution:
--   Postgres will not let a transaction use a value it added in the same
--   transaction, so a backfill into the new label would fail and take the whole
--   migration with it. The status is written by application code, later, in its
--   own transaction.
--
-- APPLIED IN A TRANSACTION on PostgreSQL 16. `ALTER TYPE ... ADD VALUE` inside a
-- transaction block is allowed from PG 12 onward provided the new value is not
-- used before commit — see above.
--
-- See rollback.sql beside this file. The short version: it is not reversible in
-- place, and it does not need to be.
-- ============================================================================

-- 1. The two enums. Additive; existing rows unaffected.
ALTER TYPE "SellerStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'BLOCKED';

-- 2. The block's own record. Nullable, so 0 rows are rewritten and every
--    existing seller simply has neither.
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "blockedAt" TIMESTAMP(3);
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "blockReason" TEXT;
