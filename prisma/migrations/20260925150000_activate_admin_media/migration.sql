-- EVERY ADMIN FILE THAT FINISHED PROCESSING IS USABLE. Repair the ones that are not.
--
-- THE DEFECT THIS REPAIRS. An upload through the Admin Panel was created as
-- `approvalStatus = DRAFT` and `sellerVisible = false`, and it stayed that way
-- until somebody pressed Approve on the tile. The person who had to press it was
-- the person who had just uploaded the file: the merchant approved their own
-- photograph, and until they did, the file was invisible to sellers, invisible
-- to the catalogue, and a blocker on the publication gate. Worse, a file whose
-- processing had finished (READY) was listed as draft, so the screen said
-- "Ready — Draft" about a file that was in fact finished and merely unclicked.
--
-- The approval step is now gone from the Admin Panel: a file uploaded by an
-- authenticated administrator is trusted on arrival and lands APPROVED,
-- seller-visible, the moment its processing succeeds (see `uploadMedia` in
-- `app/services/media.server.ts`). That change fixes every FUTURE upload. It
-- cannot fix a row that was written before it, and those rows are the ones the
-- merchant is looking at: pictures that are processed, correct, and switched
-- off.
--
-- WHAT IS SWITCHED ON, AND WHAT IS DELIBERATELY NOT.
--
--   READY + DRAFT                  -> APPROVED, sellerVisible = true
--   READY + APPROVED + invisible   -> sellerVisible = true
--
-- Both are the same story: the file finished processing, nobody ever rejected
-- it, and the only thing standing between it and a seller was a flag left at
-- its default. The order names both shapes and this covers both in one
-- statement, because they are one condition on the data.
--
-- EVERYTHING ELSE IS LEFT ALONE, ON PURPOSE:
--
--   * Not READY. A file that is still UPLOADING or PROCESSING has not been
--     measured and has no dimensions; activating it would put a half-processed
--     row in front of a seller. A file that FAILED stays failed — the honest
--     state, with its `processingError` still on the row, and switching it on
--     would offer a seller a file that does not open. A retry that succeeds
--     goes through the normal path and arrives approved.
--   * REJECTED. A rejection is a decision somebody made. It is the one state
--     here that carries intent, and re-activating those rows would overrule the
--     merchant's own action. The publication gate separately refuses a product
--     with a rejected file still switched on, so this is not a hole.
--   * SUPERSEDED. A document version that was replaced is kept for traceability
--     (`supersedesId`) and must stay dark: switching it on would offer a seller
--     an out-of-date warranty alongside its replacement. This is the closest
--     thing this schema has to an archive, and it is excluded by name.
--   * DELETED. There is nothing to repair — rows are hard-deleted, so a file the
--     merchant deleted is not here to be found.
--
-- NOTHING IS PUBLISHED. This statement writes media flags and touches no
-- product's `status`. A product that is DRAFT stays DRAFT after this runs, so
-- the merchant can look at the corrected media tab, see the readiness list go
-- green, and press Publish themselves. Publishing a product as a side effect of
-- a data repair would put a catalogue entry in front of sellers with nobody
-- having decided it was finished.
--
-- IDEMPOTENT. It is a WHERE clause over a state, not a script with a cursor: a
-- second run matches only rows a later upload has since left draft, and matches
-- nothing it already repaired. Re-running it after a partial failure completes
-- the remainder. There is no version marker to get out of step with the data.
--
-- ONE STATEMENT, so a failure leaves the table exactly as it was rather than
-- half repaired.

UPDATE "MediaAsset" AS m
   SET "approvalStatus" = 'APPROVED',
       "sellerVisible"  = true,
       "updatedAt"      = CURRENT_TIMESTAMP
 WHERE m."processingStatus" = 'READY'
   AND m."approvalStatus" <> 'REJECTED'
   AND (m."approvalStatus" = 'DRAFT' OR m."sellerVisible" = false)
   AND NOT EXISTS (
         SELECT 1
           FROM "MediaAsset" AS replacement
          WHERE replacement."supersedesId" = m."id"
       );
