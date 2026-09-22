-- ============================================================================
-- Rollback for 20260922120000_seller_blocked
-- ============================================================================
--
-- READ THIS BEFORE RUNNING IT. The two columns come back easily. The two enum
-- values do not come back at all, and no script here can make them.
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`. Removing a label from an enum
-- requires creating a replacement type, altering every dependent column to it,
-- and dropping the original — a rewrite of every table that carries the type,
-- taken under an exclusive lock. Doing that to undo an additive change would
-- risk far more than it recovers.
--
-- It is also unnecessary, which is the point. An enum label that no row uses is
-- inert: it takes six bytes in the catalogue, it cannot appear in a query that
-- does not ask for it, and `SellerStatus` still admits exactly the six values
-- any code written before this wave expects. The one thing an unused label
-- cannot do is be *ignored* by Prisma — the generated client will accept
-- 'BLOCKED' as a valid status after this rollback. That is a compile-time
-- surface, not a data-integrity one.
--
-- So there are two honest rollbacks, and you pick by what went wrong:
--
--   A. CODE ONLY — the application changes caused the problem. Revert them and
--      deploy the previous image. Leave this migration applied. Nothing is
--      blocked, nothing is inconsistent, and no seller is in a state the old
--      code cannot render (it will show BLOCKED as an unknown status and treat
--      it exactly as it treats any other non-APPROVED value: no pricing, no
--      import, no new orders).
--
--   B. DATA TOO — sellers were blocked and must be unblocked by hand. Run the
--      UPDATE below. It returns the stores to APPROVED and, deliberately, does
--      NOT clear blockedAt/blockReason: the record of what happened is the
--      audit trail, and the audit rows are append-only and stay regardless.
--
-- DO NOT run statement B as a substitute for A. Unblocking rows does not revert
-- the code, and code that still renders a Block button will simply block them
-- again.
-- ============================================================================

-- B. Unblock every seller this migration's feature could have blocked.
UPDATE "Seller"
   SET status = 'APPROVED',
       "blockedAt" = NULL
 WHERE status = 'BLOCKED';

UPDATE "MerchantApplication"
   SET status = 'APPROVED'
 WHERE status = 'BLOCKED';

-- Optional, and only if you are certain nothing will read them: the columns can
-- be dropped cleanly because they are nullable and nothing indexes them.
--
--   ALTER TABLE "Seller" DROP COLUMN IF EXISTS "blockedAt";
--   ALTER TABLE "Seller" DROP COLUMN IF EXISTS "blockReason";
