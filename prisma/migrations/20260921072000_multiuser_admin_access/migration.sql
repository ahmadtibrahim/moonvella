-- ============================================================================
-- MoonVella — multi-user administrative access
--
-- Generated with `prisma migrate diff --from-url <live db> --to-schema-datamodel`
-- and then reviewed. The review added the four objects at the end of this file
-- that Prisma's schema language cannot express (a partial unique index, two
-- CHECK constraints and two triggers). Everything above them is Prisma's output,
-- unmodified.
--
-- SAFETY
--   * Touches ONLY the moonvella database. No statement here names Prod-db,
--     prod-db, or any Odoo database, and no statement is cross-database.
--   * The database was EMPTY when this ran. Every business table held 0 rows;
--     the only rows in the database were the 2 in _prisma_migrations. That is
--     what makes the following safe, and it is a precondition, not a detail:
--       - DROP TABLE "OwnerUser" / "OwnerSession" destroys no accounts,
--         because there were none.
--       - The ActorType enum is rewritten by casting through text. A row still
--         holding 'OWNER_USER' would make that cast FAIL. AuditLog had 0 rows,
--         so no such row existed.
--     Re-running this against a database that has owner accounts would lose
--     them. It is not idempotent and is not meant to be.
--
-- DRIFT WARNING — READ BEFORE RUNNING `prisma migrate dev`
--   Prisma does not model partial indexes, CHECK constraints or triggers. It
--   therefore reports them as drift and will offer to DROP them, which would
--   silently remove the single-primary-owner guarantee and the append-only
--   audit log. Do not accept that reconciliation. If drift is reported for
--   these objects, the correct response is to leave them in place. The
--   acceptance suite asserts their existence so that losing one fails loudly.
--
-- ROLLBACK
--   See /opt/moonvella/deployment/rollback-plan.txt, section 11. In short:
--   restore db-backups/moonvella-pre-multiuser-<ts>.dump, which was taken and
--   restore-tested immediately before this migration ran.
-- ============================================================================

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'ADMIN', 'OPERATIONS', 'CATALOG', 'SUPPORT', 'VIEWER');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'CANCELLED');

-- AlterEnum
BEGIN;
CREATE TYPE "ActorType_new" AS ENUM ('ADMIN_USER', 'SYSTEM', 'MERCHANT', 'WEBHOOK');
ALTER TABLE "AuditLog" ALTER COLUMN "actorType" TYPE "ActorType_new" USING ("actorType"::text::"ActorType_new");
ALTER TYPE "ActorType" RENAME TO "ActorType_old";
ALTER TYPE "ActorType_new" RENAME TO "ActorType";
DROP TYPE "public"."ActorType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "MerchantApplication" DROP CONSTRAINT "MerchantApplication_reviewedById_fkey";

-- DropForeignKey
ALTER TABLE "OwnerSession" DROP CONSTRAINT "OwnerSession_userId_fkey";

-- DropTable
DROP TABLE "OwnerSession";

-- DropTable
DROP TABLE "OwnerUser";

-- DropEnum
DROP TYPE "OwnerRole";

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "AdminRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimaryOwner" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdById" TEXT,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "invitedById" TEXT NOT NULL,

    CONSTRAINT "AdminInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminUser_isActive_idx" ON "AdminUser"("isActive");

-- CreateIndex
CREATE INDEX "AdminUser_role_idx" ON "AdminUser"("role");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_userId_idx" ON "AdminSession"("userId");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminInvitation_tokenHash_key" ON "AdminInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminInvitation_email_idx" ON "AdminInvitation"("email");

-- CreateIndex
CREATE INDEX "AdminInvitation_status_expiresAt_idx" ON "AdminInvitation"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminInvitation" ADD CONSTRAINT "AdminInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantApplication" ADD CONSTRAINT "MerchantApplication_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- The following objects are NOT generated by Prisma. They are hand-written and
-- reviewed. See the DRIFT WARNING above.
-- ============================================================================

-- Exactly one primary owner may exist.
--
-- A partial unique index over the flag: the index contains only rows where
-- isPrimaryOwner is true, so uniqueness within it caps that set at one. A plain
-- unique index would not work (it would also forbid the many rows where the
-- flag is false), and application code alone would only be as reliable as the
-- least careful caller.
CREATE UNIQUE INDEX "AdminUser_one_primary_owner_key"
  ON "AdminUser" ("isPrimaryOwner")
  WHERE "isPrimaryOwner";

-- The primary owner must always be an OWNER and must always be active.
-- Belt and braces with the application rules: those rules stop staff from
-- demoting or disabling the primary owner, and these stop anyone, including a
-- future migration or a manual SQL edit.
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_primary_owner_is_owner"
  CHECK (NOT "isPrimaryOwner" OR "role" = 'OWNER');

ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_primary_owner_is_active"
  CHECK (NOT "isPrimaryOwner" OR "isActive");

-- The primary owner cannot be deleted.
-- A CHECK constraint cannot express this, because it is evaluated per row on
-- write and DELETE has no prospective row to test. A trigger can.
CREATE OR REPLACE FUNCTION moonvella_guard_primary_owner_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."isPrimaryOwner" THEN
    RAISE EXCEPTION
      'the primary owner account cannot be deleted (attempted on id %)', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "AdminUser_guard_primary_owner_delete"
  BEFORE DELETE ON "AdminUser"
  FOR EACH ROW
  EXECUTE FUNCTION moonvella_guard_primary_owner_delete();

-- The audit log is append-only.
--
-- Enforced by trigger rather than by privileges because the application
-- connects as the role that owns this schema: any REVOKE could simply be
-- granted back, and the owner of a table can always alter it. A trigger binds
-- every role. INSERT is untouched; only UPDATE and DELETE raise.
CREATE OR REPLACE FUNCTION moonvella_auditlog_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'AuditLog is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION moonvella_auditlog_append_only();
