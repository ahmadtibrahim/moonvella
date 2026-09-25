/*
 * Which address a posted form means.
 *
 * Shared by the booking screens because they post the same two intents, and a
 * second copy of this is a second answer to "which address did that button
 * mean" — the kind of divergence that shows up as a check that validated the
 * wrong end.
 *
 * A form that does not name an address is REFUSED, never defaulted. Defaulting
 * to the delivery end would make a truncated or mis-posted form quietly check
 * (and, with an owner's reason attached, quietly accept) an address nobody was
 * looking at.
 */

export type AddressSubjectType = "PICKUP" | "DELIVERY";

export function addressSubject(form: FormData): { type: AddressSubjectType; id: string } {
  const type = String(form.get("subjectType") || "");
  const id = String(form.get("subjectId") || "").trim();
  if (type !== "PICKUP" && type !== "DELIVERY") {
    throw new Error("No address was named to check. Reload the page and try again.");
  }
  if (!id) throw new Error("No address was named to check. Reload the page and try again.");
  return { type, id };
}

/** How the address is named to a person, in the words the panel uses. */
export function addressSubjectLabel(type: AddressSubjectType): string {
  return type === "PICKUP" ? "Pickup address" : "Delivery address";
}
