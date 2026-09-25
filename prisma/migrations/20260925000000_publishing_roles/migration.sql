-- Publishing roles: retire PENDING_APPROVAL as a reachable state.
--
-- WHAT THIS DOES, AND WHY IT IS ONLY THIS.
--
-- A product used to be able to sit in PENDING_APPROVAL, written by a "Submit
-- for approval" button on the product editor. Nothing ever read that state.
-- There was no approver queue, no screen listing parked products, no
-- notification, no second person: the button asked the owner to wait for the
-- owner. A product that was "awaiting approval" was, in every way the
-- application consults, a draft that happened to have a different word in its
-- status column.
--
-- The button is gone, and publishing is now a permission (products.publish,
-- granted to OWNER and ADMIN) rather than a state to be parked in. That leaves
-- the rows that were already parked. Left alone they would be drafts wearing a
-- label no screen offers, invisible to the status filter in the product list
-- and reachable by nothing — a state that exists only to confuse the next
-- person who reads the table.
--
-- So they become what they always were: drafts.
--
-- ONE WAY. This is a data migration, not a schema change: the enum value
-- PENDING_APPROVAL survives, because Postgres cannot drop a value from a
-- populated enum without rewriting the type, and because rows written before
-- today are history. It must never be re-added to a form, a filter or a
-- service check. If a real approval workflow is ever wanted, it needs an
-- approver and a queue first; the state is not the feature.
--
-- The product's own record is otherwise untouched. `updatedAt` is deliberately
-- NOT bumped: nothing about the product changed, only the word used to describe
-- a state it was already in, and moving the timestamp would misreport when the
-- catalogue last edited it.

UPDATE "Product"
SET status = 'DRAFT'
WHERE status = 'PENDING_APPROVAL';
