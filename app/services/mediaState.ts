/**
 * One answer to "may a seller be shown this file?", in one place.
 *
 * The question is asked in seven places — the catalogue, the seller's product
 * page, the file route that serves the bytes, the marketing pack, the Shopify
 * transfer, the import media picker, and the publication gate — and each of them
 * used to answer it with its own hand-written comparison. They drifted, and the
 * drift is exactly what the reported failures were made of: the gate asked for
 * `APPROVED` while an upload wrote `DRAFT`, so a product full of finished
 * photographs could not be published, and a file that an administrator could see
 * on the media tab was missing from the catalogue for the same reason.
 *
 * THERE ARE TWO QUESTIONS HERE, NOT ONE.
 *
 * `isSellerFacing` is the moderation question: has anybody withdrawn this file?
 * A file is withdrawn by rejecting it — which also clears `sellerVisible` — or
 * by switching it off directly. Nothing else takes it away from a seller.
 * `approvalStatus === "APPROVED"` is deliberately NOT required, because it is
 * not a separate decision for content uploaded from the Admin Panel: it is given
 * on arrival (see `uploadMedia`), and requiring it here would mean a row that
 * somehow arrived at DRAFT is invisible to the one person who could fix it.
 *
 * `isReadyForSellers` adds the processing question: a file nobody has finished
 * measuring must not be handed out, whatever its moderation says. The gate
 * blocks publication over such a file, so this is the second lock on the same
 * door — and the one that holds for a file that became visible after the
 * product was already published.
 *
 * This module is a LEAF on purpose. `publication.server.ts` needs it and is
 * itself imported by `products.server.ts`, so importing the media service to
 * reach these would close a cycle. Nothing here imports anything.
 */

/** The part of a media row these questions are decided from. */
export interface MediaStateFields {
  sellerVisible: boolean;
  approvalStatus: string;
  processingStatus: string;
}

/**
 * Has anybody withdrawn this file from sellers?
 *
 * Written as "not rejected" rather than "approved" so that a row in any other
 * moderation state is judged on the switch alone — which is the switch the
 * Admin Panel actually shows and the one an administrator actually flips.
 */
export function isSellerFacing(asset: Pick<MediaStateFields, "sellerVisible" | "approvalStatus">): boolean {
  return asset.sellerVisible && asset.approvalStatus !== "REJECTED";
}

/**
 * Is this file both offered to sellers and finished?
 *
 * Both halves matter and neither implies the other: an active file can still be
 * uploading, and a processed file can have been switched off.
 */
export function isReadyForSellers(asset: MediaStateFields): boolean {
  return isSellerFacing(asset) && asset.processingStatus === "READY";
}
