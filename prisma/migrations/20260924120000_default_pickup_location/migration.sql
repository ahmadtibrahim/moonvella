-- Which dock every outbound shipment starts from, when nothing more specific
-- says otherwise.
--
-- The owner named one warehouse — the Premafirm Inc. warehouse in Odoo, 994
-- Westport Cres, Unit 7A — as where MoonVella's stock leaves from, and the Odoo
-- connection now keeps a PickupLocation row built from that warehouse's own
-- partner address. This column marks that row, so origin resolution has one
-- unambiguous answer to fall back to instead of searching for "the row that
-- looks like Odoo". Products and variants keep their own mapping, and a mapping
-- still wins; only the case that used to resolve to nothing changes.
--
-- Every existing row is false, which is the correct state: nothing has been
-- designated yet, and the next catalogue sync designates the row it maintains.

ALTER TABLE "PickupLocation" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "PickupLocation_isDefault_idx" ON "PickupLocation"("isDefault");
