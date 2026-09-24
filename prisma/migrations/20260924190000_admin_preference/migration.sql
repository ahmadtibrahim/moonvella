-- One operator's answer to a question about the whole admin, stored by name.
--
-- The first one is "units": the operator on admin.moonvella.com asked to enter
-- a variant's measurements in inches and pounds by default, with a selector
-- between that pairing and centimetres/kilograms. The selector is a preference
-- about the interface, not about a store or a record, and there is no existing
-- row anywhere that could hold it — MoonVella's settings are per-seller, per-
-- integration or per-record.
--
-- WHAT THIS TABLE DOES NOT DO: it does not change how a measurement is stored.
-- ProductVariant.productLengthCm/productWeightKg and every packaging column
-- keep their canonical centimetres and kilograms, which is what shipping
-- quotes, order snapshots and the verify suites read. The preference chooses
-- what the form shows and accepts, and the route converts on the way in.
--
-- No rows are created here. A missing row means no preference has been
-- expressed, and the reading service answers with the default (inches and
-- pounds), so this migration adds an empty table and nothing else.

CREATE TABLE "AdminPreference" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminPreference_key_key" ON "AdminPreference"("key");
