-- An optional seller/customer message printed on the packing slip.
--
-- Nullable with no default: "no message" is the ordinary case and is a
-- different thing from an empty message, which would print a labelled blank
-- block on a slip that is supposed to be silent about everything it does not
-- need to say.
ALTER TABLE "Shipment" ADD COLUMN "packingSlipMessage" TEXT;
