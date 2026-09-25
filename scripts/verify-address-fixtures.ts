/**
 * Address verdicts, for suites that book.
 *
 * WHY THIS FILE EXISTS. Booking now refuses unless BOTH addresses on the label
 * carry a current verdict — an accepted one, or an owner's recorded override —
 * and refusing is the whole point: a suite that books without seeding verdicts
 * is a suite that stopped exercising the booking path and started exercising
 * the refusal. Rather than let each suite invent its own row (and invent it
 * slightly differently, so one of them seeds a hash the gate disagrees with and
 * fails for a reason that looks like a product defect), the seed lives here,
 * computed with **the same functions the gate uses**. `loadSubjectAddress`
 * reads the address and `addressInputHash` hashes it, so a fixture's verdict
 * matches by construction rather than by a copy of the rule.
 *
 * These helpers write verdicts and nothing else. A suite that wants to prove
 * the gate REFUSES should seed what it wants to refuse with — an UNAVAILABLE
 * row, a stale hash, an expiry — using `recordVerdict` below, which is
 * deliberately able to express every verdict the schema allows.
 *
 * NOT FOR PRODUCTION. This is a verification fixture; nothing in `app/` imports
 * it.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  addressInputHash,
  loadSubjectAddress,
  type StructuredAddress,
} from "../app/services/addressValidation.server";

type SubjectType = "PICKUP" | "DELIVERY";

/** The address as the gate will read it, hashed the way the gate hashes it. */
async function hashedAddress(subjectType: SubjectType, subjectId: string) {
  const address = await loadSubjectAddress(subjectType, subjectId);
  if (!address) {
    throw new Error(
      `verify-address-fixtures: no ${subjectType} address resolves for ${subjectId}, so no verdict can be recorded for it.`
    );
  }
  return { address, inputHash: addressInputHash(address) };
}

/**
 * Record any verdict a suite needs, with a hash that matches the address as it
 * stands right now.
 *
 * The hash is computed here for the same reason it is in `acceptAddresses`: a
 * fixture that passes a hand-written hash is testing the hash comparison, which
 * is fine when that is the point — but it must be the suite's decision, not an
 * accident of how the row was written.
 */
export async function recordVerdict(
  client: PrismaClient,
  input: {
    subjectType: SubjectType;
    subjectId: string;
    verdict: "ACCEPTED" | "CONFIRMATION_REQUIRED" | "CORRECTION_REQUIRED" | "UNAVAILABLE" | "OVERRIDDEN";
    /** Required for UNAVAILABLE to be a faithful copy of what the service stores. */
    unavailableReason?: string;
    /** Override the hash deliberately — for the "address edited since check" case. */
    inputHash?: string;
    /** A past date makes an otherwise acceptable verdict expire. */
    expiresAt?: Date | null;
    suggestedAddress?: StructuredAddress | null;
    differences?: unknown;
  }
): Promise<{ id: string; inputHash: string }> {
  const { address, inputHash } = await hashedAddress(input.subjectType, input.subjectId);
  const row = await client.addressValidation.create({
    data: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      inputHash: input.inputHash ?? inputHash,
      verdict: input.verdict,
      originalAddress: address as unknown as Prisma.InputJsonValue,
      suggestedAddress: (input.suggestedAddress ?? undefined) as Prisma.InputJsonValue | undefined,
      differences: (input.differences ?? undefined) as Prisma.InputJsonValue | undefined,
      unavailableReason: input.unavailableReason ?? null,
      checkedAt: new Date(),
      // ACCEPTED ages out the way the service lets it: a fixture that does not
      // say otherwise gets a verdict that is current now.
      expiresAt:
        input.expiresAt === undefined
          ? input.verdict === "UNAVAILABLE"
            ? new Date()
            : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          : input.expiresAt,
    },
  });
  return { id: row.id, inputHash: row.inputHash };
}

/** An accepted verdict for one address — the precondition for booking it. */
export async function acceptAddress(
  client: PrismaClient,
  subjectType: SubjectType,
  subjectId: string
): Promise<string> {
  const { id } = await recordVerdict(client, { subjectType, subjectId, verdict: "ACCEPTED" });
  return id;
}

/**
 * Both ends of a booking, accepted.
 *
 * The pickup end is skipped when there is no dock, rather than throwing: a
 * suite that deliberately builds an order with no origin is testing the origin
 * gate, and it should fail on THAT refusal, not on this helper.
 */
export async function acceptBookingAddresses(
  client: PrismaClient,
  input: { originLocationId?: string | null; orderId: string }
): Promise<void> {
  if (input.originLocationId) await acceptAddress(client, "PICKUP", input.originLocationId);
  await acceptAddress(client, "DELIVERY", input.orderId);
}

/** Remove the verdicts a suite seeded, so a re-run starts from nothing. */
export async function clearAddressVerdicts(
  client: PrismaClient,
  input: { subjectType: SubjectType; subjectId: string }
): Promise<void> {
  await client.addressValidation.deleteMany({
    where: { subjectType: input.subjectType, subjectId: input.subjectId },
  });
}
