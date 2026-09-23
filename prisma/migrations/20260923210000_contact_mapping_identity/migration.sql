-- Identity columns for a seller's external contact mappings.
--
-- The store's own identifiers — display name, Shopify shop id, myshopify domain
-- and the resolved tag id — are held on the mapping rather than written into the
-- Odoo partner. `res.partner.ref` already means something to whoever set it, and
-- a Shopify id stored there would make the one reference field a reader trusts
-- the one field that lies.
--
-- Additive only: four nullable columns. No existing column is altered, no default
-- is required, and every existing row keeps its values with the new columns null
-- until the next sync fills them.

-- AlterTable
ALTER TABLE "ExternalContactMapping" ADD COLUMN     "myshopifyDomain" TEXT,
ADD COLUMN     "odooTagId" INTEGER,
ADD COLUMN     "shopifyShopId" TEXT,
ADD COLUMN     "storeName" TEXT;
