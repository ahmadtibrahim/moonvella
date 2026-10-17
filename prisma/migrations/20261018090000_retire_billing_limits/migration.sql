-- Retire the per-order and per-shipping maximums, and "hold for review".
--
-- NOTHING IS DROPPED. The three columns stay, and so does every value in them.
-- They are history: a seller once set a ceiling, and the audit trail already
-- records when it was set and by whom. Dropping the columns would destroy that
-- and buy nothing — a column nobody writes and nobody reads costs no behaviour.
--
-- WHY THE SETTINGS ARE RETIRED AT ALL. Shipping is inside MoonVella's partner
-- price, so a "maximum shipping charge" capped a cost no bill contains. It was
-- also unenforceable for most of its life: the amount it compared against
-- (`WholesalePayment.shippingAmount`) was never written, so every order compared
-- zero against the ceiling and passed. With no shipping maximum and no per-order
-- maximum, "hold for review when limits are exceeded" has nothing left to mean.
--
-- THE BEHAVIOUR IS RETIRED IN CODE, NOT HERE. `updateBillingSettings` refuses the
-- three fields, and `chargeWholesaleOrder` no longer holds an automatic charge
-- against either ceiling. This migration records the retirement where a person
-- reading the schema will find it, and does nothing else.
--
-- `COMMENT ON COLUMN` is metadata: it does not lock the table, does not rewrite
-- rows, and is idempotent when re-run.

COMMENT ON COLUMN "SellerBillingSettings"."maxAmountPerOrder" IS
  'RETIRED 2026-10-18. Historical only; nothing reads or writes it. Automatic payment has no amount ceiling.';
COMMENT ON COLUMN "SellerBillingSettings"."maxShippingCharge" IS
  'RETIRED 2026-10-18. Historical only; nothing reads or writes it. Shipping is included in MoonVella''s partner price, so there is no separate shipping charge to cap.';
COMMENT ON COLUMN "SellerBillingSettings"."holdForReview" IS
  'RETIRED 2026-10-18. Historical only; nothing reads or writes it. Kept because it is the record of what a seller had set, not because anything acts on it.';

COMMENT ON COLUMN "SellerBillingSettings"."mode" IS
  'The seller''s payment mode: AUTOMATIC or MANUAL. The single payment choice since 2026-10-18.';
COMMENT ON COLUMN "SellerBillingSettings"."autoPayEnabled" IS
  'The seller''s AUTHORISATION for automatic charges. Automatic charging requires mode=AUTOMATIC AND this to be true.';
