/**
 * Google address validation, and the gate that keeps an unvalidated address out
 * of a booking.
 *
 * TWO CREDENTIALS, AND ONLY ONE OF THEM MAY BE PUBLIC. Places Autocomplete runs
 * in the browser, so its key is necessarily visible to anyone who opens the
 * page; it is stored as a non-secret and must be restricted by HTTP referrer in
 * the Google Cloud console. The Address Validation API is called from this
 * server, so its key is stored as a secret and is never sent to a browser, put
 * in a template, returned by a loader, or written to a log. They are separate
 * fields precisely so the browser key can be handed out without dragging the
 * server key along — one shared key would make every page render a disclosure.
 *
 * AUTOCOMPLETE IS AN ENTRY AID, NOT VALIDATION. What the seller picked from the
 * dropdown is not evidence that the address exists: the dropdown offers what
 * Google thinks was meant, the seller can ignore it, and the field can be typed
 * into without the widget ever running. The only thing this module treats as a
 * validation is a response from `validateAddress`.
 *
 * FOUR OUTCOMES, AND THREE OF THEM BLOCK. The directive names Accepted,
 * Confirmation required, Correction required and Validation unavailable, and
 * the reason they are enumerated rather than collapsed into a boolean is that
 * they call for different actions by different people. A confirmation is a
 * question for the seller; a correction is a change somebody has to agree to; an
 * outage is nobody's fault and must not be mistaken for a pass. `UNAVAILABLE`
 * therefore never gates open — the temptation during an outage is to treat "we
 * could not check" as "nothing was wrong", and that is the one reading the
 * directive forbids outright.
 *
 * WHAT IS NOT KEPT. Google's terms constrain how long a validation response may
 * be retained and what may be cached, so no response body is stored. A row holds
 * the verdict, the normalised address Google would use, the component-level
 * differences a person needs to read, the place id, and a hash of the input.
 * That last one is the whole duplicate-call strategy: an address that has not
 * changed reuses its verdict, so a page render or a second visit costs nothing
 * and only a material edit — which changes the hash — triggers a new billable
 * call.
 */

import { createHash } from "node:crypto";
import { prisma } from "~/db.server";
import { getCredential } from "./credentials.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

export const BROWSER_KEY_FIELD = "GOOGLE_MAPS_BROWSER_KEY";
export const SERVER_KEY_FIELD = "GOOGLE_MAPS_SERVER_KEY";

/** The one host this module will send a server key to. */
const ADDRESS_VALIDATION_ENDPOINT = "https://addressvalidation.googleapis.com/v1:validateAddress";

/**
 * How long a verdict may be reused before it must be checked again.
 *
 * Not because Google's answer goes stale quickly, but because an address
 * checked once and trusted forever is an address nobody looks at again — and
 * postal boundaries, street renumbering and municipality mergers all change the
 * right answer underneath a verdict that never expires.
 */
export const VALIDATION_TTL_DAYS = 30;

/** The structured address this module validates. Unit is preserved, never merged. */
export interface StructuredAddress {
  street1: string;
  /** Apartment, unit, suite. Deliberately its own field: folding it into
   *  street1 loses the distinction between "12 Main St" and "12 Main St Apt 4",
   *  which are two different doors. */
  street2?: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

export type Verdict =
  | "UNVALIDATED"
  | "ACCEPTED"
  | "CONFIRMATION_REQUIRED"
  | "CORRECTION_REQUIRED"
  | "UNAVAILABLE"
  | "OVERRIDDEN";

export interface AddressDifference {
  /** "postalCode", "city", "subpremise" — the component, not the prose. */
  component: string;
  entered: string | null;
  suggested: string | null;
  /** Google's own confirmation level for this component, when it gave one. */
  confirmation: string | null;
}

export interface ValidationOutcome {
  verdict: Verdict;
  /** The address as entered. */
  original: StructuredAddress;
  /** The address as Google would normalise it. Null when it did not answer. */
  suggested: StructuredAddress | null;
  formattedAddress: string | null;
  differences: AddressDifference[];
  /** Deliverability of Google's answer: SUB_PREMISE and PREMISE are doors. */
  granularity: string | null;
  placeId: string | null;
  /** Components Google says are missing, e.g. subpremise for a unit number. */
  missingComponents: string[];
  reason: string | null;
  /** True when this outcome came from storage rather than a fresh call. */
  cached: boolean;
  checkedAt: Date;
}

/**
 * Normalise before hashing, so " 12 Main St " and "12  main st" are the same
 * address and do not each cost a call. Case and internal whitespace are
 * flattened; the STRUCTURE is not — merging street2 into street1 here would
 * make two different doors hash identically.
 */
export function normalizeAddressPart(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function addressInputHash(address: StructuredAddress): string {
  const material = [
    normalizeAddressPart(address.street1),
    normalizeAddressPart(address.street2),
    normalizeAddressPart(address.city),
    normalizeAddressPart(address.province),
    normalizeAddressPart(address.postalCode),
    normalizeAddressPart(address.country).toUpperCase(),
  ].join("\u0000");
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Read an address stored in this app's own shipping-address column — the shape
 * a Shopify order payload arrives in — as a StructuredAddress.
 *
 * It exists so that "did the address materially change?" is answered by
 * `addressInputHash` rather than by comparing JSON strings, which would call
 * any reordering or reformatting a change and any real change a change alike.
 * The field names differ because Shopify's are its own; the mapping is the only
 * place that translation happens.
 */
export function structuredFromStoredAddress(raw: string | null | undefined): StructuredAddress | null {
  if (!raw) return null;
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
  return {
    street1: parsed.address1 || parsed.address || "",
    street2: parsed.address2 || null,
    city: parsed.city || "",
    province: parsed.province || parsed.provinceCode || "",
    postalCode: parsed.zip || parsed.postalCode || "",
    country: parsed.country || parsed.countryCode || "",
  };
}

/**
 * The same reading, for an address that has not been stored yet. A webhook
 * carries the object; this app stores the string.
 */
export function structuredFromShopifyAddress(value: unknown): StructuredAddress | null {
  if (!value || typeof value !== "object") return null;
  return structuredFromStoredAddress(JSON.stringify(value));
}

/**
 * Whether an incoming address differs from the stored one in any way that would
 * change where a parcel goes. Anything unknown counts as a change: a comparison
 * that cannot be made must not be reported as "no change", because the cost of
 * being wrong is booking a label to the old address.
 */
export function addressMateriallyDiffers(stored: string | null | undefined, incoming: unknown): boolean {
  const before = structuredFromStoredAddress(stored);
  const after = structuredFromShopifyAddress(incoming);
  if (!before || !after) return true;
  return addressInputHash(before) !== addressInputHash(after);
}

/** Which required fields are absent. An incomplete address is not worth calling about. */
export function missingAddressFields(address: StructuredAddress): string[] {
  const missing: string[] = [];
  if (!address.street1?.trim()) missing.push("street");
  if (!address.city?.trim()) missing.push("city");
  if (!address.province?.trim()) missing.push("province/state");
  if (!address.postalCode?.trim()) missing.push("postal code");
  if (!address.country?.trim()) missing.push("country");
  return missing;
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

export async function googleConfigured(): Promise<{
  browserKey: boolean;
  serverKey: boolean;
}> {
  const [browserKey, serverKey] = await Promise.all([
    getCredential("google", BROWSER_KEY_FIELD),
    getCredential("google", SERVER_KEY_FIELD),
  ]);
  return { browserKey: !!browserKey, serverKey: !!serverKey };
}

/**
 * The browser key, for a loader that must hand it to the page.
 *
 * This is the ONE credential this codebase deliberately sends to a browser, so
 * it is spelled out here rather than left to a caller: the value must be a
 * referrer-restricted browser key, and the matching server key is never
 * reachable through this function.
 */
export async function browserKeyForPlaces(): Promise<string | null> {
  return getCredential("google", BROWSER_KEY_FIELD);
}

/* -------------------------------------------------------------------------- */
/* The call                                                                   */
/* -------------------------------------------------------------------------- */

interface GoogleAddressComponent {
  componentName?: { text?: string };
  componentType?: string;
  confirmationLevel?: string;
  inferred?: boolean;
  replaced?: boolean;
  spellCorrected?: boolean;
}

interface GoogleValidationResponse {
  responseId?: string;
  result?: {
    verdict?: {
      validationGranularity?: string;
      geocodeGranularity?: string;
      addressComplete?: boolean;
      hasUnconfirmedComponents?: boolean;
      hasInferredComponents?: boolean;
      hasReplacedComponents?: boolean;
      hasSpellCorrectedComponents?: boolean;
      possibleNextAction?: string;
    };
    address?: {
      formattedAddress?: string;
      postalAddress?: {
        regionCode?: string;
        postalCode?: string;
        administrativeArea?: string;
        locality?: string;
        addressLines?: string[];
        sublocality?: string;
      };
      addressComponents?: GoogleAddressComponent[];
      unconfirmedComponentTypes?: string[];
      missingComponentTypes?: string[];
    };
    geocode?: { placeId?: string };
  };
}

/** Component types this module maps onto the structured fields it stores. */
const COMPONENT_TO_FIELD: Record<string, keyof StructuredAddress> = {
  route: "street1",
  street_number: "street1",
  subpremise: "street2",
  locality: "city",
  postal_town: "city",
  administrative_area_level_1: "province",
  postal_code: "postalCode",
  country: "country",
};

/**
 * Read Google's component list back into the five fields we store.
 *
 * street1 is rebuilt from street_number and route rather than taken from
 * addressLines, because addressLines is display text and can carry the unit
 * inside it — which is exactly the merge the directive forbids. The subpremise
 * component is the unit, and it lands in street2 where it belongs.
 */
export function suggestedFromComponents(
  components: GoogleAddressComponent[],
  fallback: StructuredAddress
): StructuredAddress {
  const result: StructuredAddress = { ...fallback };
  let streetNumber = "";
  let route = "";

  for (const component of components) {
    const type = component.componentType ?? "";
    const text = component.componentName?.text?.trim() ?? "";
    if (!text) continue;
    if (type === "street_number") {
      streetNumber = text;
      continue;
    }
    if (type === "route") {
      route = text;
      continue;
    }
    const field = COMPONENT_TO_FIELD[type];
    if (field && field !== "street1") {
      result[field] = text;
    }
  }

  if (streetNumber || route) {
    result.street1 = [streetNumber, route].filter(Boolean).join(" ");
  }
  return result;
}

function collectDifferences(
  entered: StructuredAddress,
  suggested: StructuredAddress,
  components: GoogleAddressComponent[]
): AddressDifference[] {
  const differences: AddressDifference[] = [];
  const fields: (keyof StructuredAddress)[] = ["street1", "street2", "city", "province", "postalCode", "country"];

  for (const field of fields) {
    const before = (entered[field] ?? "") as string;
    const after = (suggested[field] ?? "") as string;
    if (normalizeAddressPart(before) === normalizeAddressPart(after)) continue;
    // The confirmation level for the component Google changed, so the reader
    // can tell "corrected with confidence" from "guessed".
    const componentType = field === "street2" ? "subpremise" : undefined;
    const component = componentType
      ? components.find((entry) => entry.componentType === componentType)
      : undefined;
    differences.push({
      component: field,
      entered: before || null,
      suggested: after || null,
      confirmation: component?.confirmationLevel ?? null,
    });
  }

  // A component Google flagged as unconfirmed is a difference even when the text
  // matches, because "we could not confirm this" is what the reader has to act
  // on — not a change they can see.
  for (const component of components) {
    const type = component.componentType ?? "";
    if (
      component.confirmationLevel === "UNCONFIRMED_AND_SUSPICIOUS" ||
      component.confirmationLevel === "UNCONFIRMED_BUT_PLAUSIBLE" ||
      component.inferred ||
      component.replaced
    ) {
      const already = differences.some((difference) => difference.component === COMPONENT_TO_FIELD[type]);
      if (!already) {
        differences.push({
          component: COMPONENT_TO_FIELD[type] ?? type,
          entered: component.componentName?.text ?? null,
          suggested: component.componentName?.text ?? null,
          confirmation: component.confirmationLevel ?? null,
        });
      }
    }
  }

  return differences;
}

/**
 * Map a Google verdict onto the four outcomes.
 *
 * The order of these tests is the whole logic, so it is stated once here rather
 * than inferred from the code below:
 *
 *   1. Nothing answered            -> UNAVAILABLE. Never a pass.
 *   2. Google changed or supplied  -> CORRECTION_REQUIRED. `replaced` means it
 *      substituted a different value; `inferred` means it filled a blank. Both
 *      alter where the parcel goes, so a person has to agree to it.
 *   3. Google could not confirm    -> CONFIRMATION_REQUIRED. This covers an
 *      incomplete address, an unconfirmed component, and a missing subpremise
 *      where Google explicitly asks for a unit.
 *   4. Otherwise                   -> ACCEPTED, and only when Google named a
 *      deliverable granularity. A route-level match ("Main Street", no number)
 *      is not a door, and a label printed for it reaches the wrong building.
 */
export function verdictFromGoogle(result: GoogleValidationResponse["result"]): {
  verdict: Verdict;
  reason: string | null;
} {
  const verdict = result?.verdict;
  if (!verdict) return { verdict: "UNAVAILABLE", reason: "Google returned no verdict." };

  if (verdict.hasReplacedComponents || verdict.hasInferredComponents || verdict.hasSpellCorrectedComponents) {
    const what = [
      verdict.hasReplacedComponents ? "replaced a component" : null,
      verdict.hasInferredComponents ? "inferred a component that was not supplied" : null,
      verdict.hasSpellCorrectedComponents ? "corrected the spelling of a component" : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      verdict: "CORRECTION_REQUIRED",
      reason: `Google ${what}. Review the suggestion before this address is used.`,
    };
  }

  if (verdict.addressComplete === false) {
    return {
      verdict: "CONFIRMATION_REQUIRED",
      reason: "Google could not confirm the whole address, so part of it is unverified.",
    };
  }

  if (verdict.hasUnconfirmedComponents) {
    return {
      verdict: "CONFIRMATION_REQUIRED",
      reason: "Google could not confirm every component of this address.",
    };
  }

  if (verdict.possibleNextAction === "FIX") {
    return {
      verdict: "CORRECTION_REQUIRED",
      reason: "Google reports this address needs correcting before it can be used.",
    };
  }

  if (verdict.possibleNextAction === "CONFIRM_ADD_SUBPREMISES") {
    return {
      verdict: "CONFIRMATION_REQUIRED",
      reason:
        "Google has placed the street but cannot identify the unit. A parcel without a " +
        "unit number may be refused at the door.",
    };
  }

  const granularity = verdict.validationGranularity ?? "";
  const deliverable = granularity === "SUB_PREMISE" || granularity === "PREMISE";
  if (!deliverable) {
    return {
      verdict: "CONFIRMATION_REQUIRED",
      reason:
        `Google matched this address only to ${granularity || "an unknown level"}, which is ` +
        `not a specific building.`,
    };
  }

  return { verdict: "ACCEPTED", reason: null };
}

/** Turn a Google response into the outcome this module stores. */
export function outcomeFromResponse(
  entered: StructuredAddress,
  response: GoogleValidationResponse
): ValidationOutcome {
  const { verdict, reason } = verdictFromGoogle(response.result);
  const components = response.result?.address?.addressComponents ?? [];
  const suggested =
    verdict === "UNAVAILABLE" ? null : suggestedFromComponents(components, entered);

  return {
    verdict,
    original: entered,
    suggested,
    formattedAddress: response.result?.address?.formattedAddress ?? null,
    differences: suggested ? collectDifferences(entered, suggested, components) : [],
    granularity: response.result?.verdict?.validationGranularity ?? null,
    placeId: response.result?.geocode?.placeId ?? null,
    missingComponents: response.result?.address?.missingComponentTypes ?? [],
    reason,
    cached: false,
    checkedAt: new Date(),
  };
}

/**
 * Calls in flight, keyed by input hash.
 *
 * A page that validates on save can be submitted twice; so can a retry. Google
 * bills per call, and the second call has the same answer as the first, so the
 * second caller waits for the first rather than paying for a duplicate. The map
 * is per-process, which is honest about what it is: a guard against a
 * double-submit, not a distributed lock.
 */
const inFlight = new Map<string, Promise<ValidationOutcome>>();

export interface ValidateOptions {
  /**
   * Force a fresh call even when a usable verdict is stored. Set by an explicit
   * "check again" action, never by a page render.
   */
  refresh?: boolean;
  /** Called after a fresh call, for the caller to persist. Not called on a cache hit. */
  onFresh?: (outcome: ValidationOutcome) => Promise<void>;
}

/**
 * Validate an address, reusing a stored verdict when the address has not
 * changed.
 *
 * Returns UNAVAILABLE rather than throwing when the provider cannot be reached.
 * A thrown error would be caught by whatever route called it and rendered as a
 * generic failure, which reads as "the button is broken" — and the operator
 * would try again, and again, through the outage. A returned UNAVAILABLE says
 * what happened and keeps the booking gate shut.
 */
export async function validateAddress(
  address: StructuredAddress,
  options: ValidateOptions = {}
): Promise<ValidationOutcome> {
  const missing = missingAddressFields(address);
  if (missing.length > 0) {
    return {
      verdict: "CONFIRMATION_REQUIRED",
      original: address,
      suggested: null,
      formattedAddress: null,
      differences: [],
      granularity: null,
      placeId: null,
      missingComponents: missing,
      reason: `This address is incomplete: ${missing.join(", ")}.`,
      cached: false,
      checkedAt: new Date(),
    };
  }

  const hash = addressInputHash(address);

  if (!options.refresh) {
    const stored = await findStoredVerdict(hash);
    if (stored) return stored;
  }

  const existing = inFlight.get(hash);
  if (existing) return existing;

  const run = (async (): Promise<ValidationOutcome> => {
    const outcome = await callGoogle(address);
    if (options.onFresh && outcome.verdict !== "UNAVAILABLE") await options.onFresh(outcome);
    return outcome;
  })();

  inFlight.set(hash, run);
  try {
    return await run;
  } finally {
    inFlight.delete(hash);
  }
}

/**
 * The stored verdict for an unchanged address, or null.
 *
 * A verdict older than the TTL is not returned: an expired answer is not an
 * answer, and returning it would let a check from six months ago gate a booking
 * today without anyone noticing it had aged out.
 */
async function findStoredVerdict(hash: string): Promise<ValidationOutcome | null> {
  const row = await prisma.addressValidation.findFirst({
    where: {
      inputHash: hash,
      verdict: { in: ["ACCEPTED", "CONFIRMATION_REQUIRED", "CORRECTION_REQUIRED"] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { checkedAt: "desc" },
  });
  if (!row) return null;

  const original = row.originalAddress as unknown as StructuredAddress;
  const suggested = (row.suggestedAddress as unknown as StructuredAddress | null) ?? null;
  return {
    verdict: row.verdict,
    original,
    suggested,
    formattedAddress: null,
    differences: (row.differences as unknown as AddressDifference[] | null) ?? [],
    granularity: row.granularity,
    placeId: row.placeId,
    missingComponents: [],
    reason: null,
    cached: true,
    checkedAt: row.checkedAt,
  };
}

async function callGoogle(address: StructuredAddress): Promise<ValidationOutcome> {
  const key = await getCredential("google", SERVER_KEY_FIELD);
  if (!key) {
    return unavailable(address, "Google address validation is not configured.");
  }

  let response: Response;
  try {
    response = await fetch(`${ADDRESS_VALIDATION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: {
          regionCode: address.country.trim().toUpperCase(),
          addressLines: [address.street1.trim(), address.street2?.trim()].filter(Boolean),
          locality: address.city.trim(),
          administrativeArea: address.province.trim(),
          postalCode: address.postalCode.trim(),
        },
      }),
    });
  } catch (error) {
    return unavailable(
      address,
      `Google could not be reached: ${error instanceof Error ? error.message : "network error"}.`
    );
  }

  if (!response.ok) {
    // The body can echo the request, which carried the key in its query string.
    // The status is quoted; the body is not.
    return unavailable(address, `Google returned HTTP ${response.status}.`);
  }

  let payload: GoogleValidationResponse;
  try {
    payload = (await response.json()) as GoogleValidationResponse;
  } catch {
    return unavailable(address, "Google returned a response that could not be read.");
  }

  return outcomeFromResponse(address, payload);
}

function unavailable(address: StructuredAddress, reason: string): ValidationOutcome {
  return {
    verdict: "UNAVAILABLE",
    original: address,
    suggested: null,
    formattedAddress: null,
    differences: [],
    granularity: null,
    placeId: null,
    missingComponents: [],
    reason: `${reason} The address has not been checked, so it is not marked valid.`,
    cached: false,
    checkedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export interface RecordValidationInput {
  subjectType: "PICKUP" | "DELIVERY";
  subjectId: string;
  outcome: ValidationOutcome;
}

/**
 * Store a verdict as evidence.
 *
 * Only the reduced shape is written — verdict, normalised suggestion, the
 * component differences, the place id and the hash. The response body is not
 * kept: Google's terms limit how long one may be retained, and nothing in this
 * application needs it, because every screen reads the reduced shape.
 */
export async function recordValidation(input: RecordValidationInput) {
  const { outcome } = input;
  const expiresAt = new Date(outcome.checkedAt.getTime() + VALIDATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const row = await prisma.addressValidation.create({
    data: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      inputHash: addressInputHash(outcome.original),
      verdict: outcome.verdict,
      originalAddress: outcome.original as unknown as object,
      suggestedAddress: (outcome.suggested ?? undefined) as unknown as object | undefined,
      differences: outcome.differences as unknown as object,
      granularity: outcome.granularity,
      placeId: outcome.placeId,
      unavailableReason: outcome.verdict === "UNAVAILABLE" ? outcome.reason : null,
      checkedAt: outcome.checkedAt,
      // An unavailable verdict expires immediately: it is a record that a check
      // failed, and it must never be reused as though it were a result.
      expiresAt: outcome.verdict === "UNAVAILABLE" ? outcome.checkedAt : expiresAt,
    },
  });

  if (input.subjectType === "PICKUP") {
    await prisma.pickupLocation.update({
      where: { id: input.subjectId },
      data: {
        addressVerdict: outcome.verdict,
        addressCheckedAt: outcome.checkedAt,
        // A fresh check clears an earlier override: the override was acceptance
        // of a problem, and if the problem is gone the override is a stale
        // claim that the address is questionable when it no longer is.
        ...(outcome.verdict === "ACCEPTED"
          ? { addressOverridden: false, addressOverrideReason: null }
          : {}),
      },
    });
  }

  return row;
}

/* -------------------------------------------------------------------------- */
/* Owner-reviewed exception                                                   */
/* -------------------------------------------------------------------------- */

export class AddressOverrideNotPermitted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressOverrideNotPermitted";
  }
}

/**
 * Accept an address Google would not accept, on the record.
 *
 * OWNER ONLY, and the check is against the stored role rather than anything the
 * caller passed in — a role supplied by a form is a role the submitter chose.
 * The reason is required and non-trivial: an override is the one path by which
 * an unvalidated address reaches a carrier, so the question "who decided this
 * was fine, and why" must have an answer that is not "the box was empty".
 *
 * The stored verdict is OVERRIDDEN, never ACCEPTED. An override that read as a
 * validation would be repeated by every screen as a Google-passed address, and
 * the whole value of the override workflow is that the label stays honest.
 */
export async function recordAddressOverride(input: {
  subjectType: "PICKUP" | "DELIVERY";
  subjectId: string;
  actorId: string;
  reason: string;
}): Promise<{ ok: true; validationId: string } | { ok: false; error: string }> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return {
      ok: false,
      error: "An override needs a reason of at least 10 characters, so the decision can be reviewed.",
    };
  }

  const actor = await prisma.adminUser.findUnique({
    where: { id: input.actorId },
    select: { id: true, name: true, role: true, isActive: true },
  });
  if (!actor || !actor.isActive) return { ok: false, error: "Unknown or inactive user." };
  if (actor.role !== "OWNER") {
    throw new AddressOverrideNotPermitted(
      "Only an owner may override an address that failed validation."
    );
  }

  const address = await loadSubjectAddress(input.subjectType, input.subjectId);
  if (!address) return { ok: false, error: "The address being overridden could not be found." };

  const previous = await prisma.addressValidation.findFirst({
    where: { subjectType: input.subjectType, subjectId: input.subjectId },
    orderBy: { checkedAt: "desc" },
  });

  const row = await prisma.addressValidation.create({
    data: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      inputHash: addressInputHash(address),
      verdict: "OVERRIDDEN",
      originalAddress: address as unknown as object,
      suggestedAddress: (previous?.suggestedAddress ?? undefined) as object | undefined,
      differences: (previous?.differences ?? undefined) as object | undefined,
      granularity: previous?.granularity ?? null,
      placeId: previous?.placeId ?? null,
      overriddenById: actor.id,
      overriddenByName: actor.name,
      overrideReason: reason,
      checkedAt: new Date(),
      // An override does not age out on a timer: it is a decision, and a
      // decision does not expire. It ends when the address is edited, which
      // changes the hash, or when the owner revisits it.
      expiresAt: null,
    },
  });

  if (input.subjectType === "PICKUP") {
    await prisma.pickupLocation.update({
      where: { id: input.subjectId },
      data: {
        addressVerdict: "OVERRIDDEN",
        addressCheckedAt: row.checkedAt,
        addressOverridden: true,
        addressOverrideReason: reason,
      },
    });
  }

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name,
    action: "address.override_recorded",
    entityType: AUDIT_ENTITY.SETTINGS,
    entityId: row.id,
    // The reason is the point of the record, so it is stored verbatim rather
    // than summarised. The address itself is not repeated here — it is on the
    // validation row this entry points at.
    afterData: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reason,
      overriddenVerdict: previous?.verdict ?? "UNVALIDATED",
    },
  });

  return { ok: true, validationId: row.id };
}

async function loadSubjectAddress(
  subjectType: "PICKUP" | "DELIVERY",
  subjectId: string
): Promise<StructuredAddress | null> {
  if (subjectType === "PICKUP") {
    const location = await prisma.pickupLocation.findUnique({
      where: { id: subjectId },
      select: { street1: true, street2: true, city: true, province: true, postalCode: true, country: true },
    });
    if (!location) return null;
    return {
      street1: location.street1 ?? "",
      street2: location.street2,
      city: location.city ?? "",
      province: location.province ?? "",
      postalCode: location.postalCode ?? "",
      country: location.country ?? "",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

export interface AddressGate {
  /** False when a booking must not proceed. */
  allowed: boolean;
  verdict: Verdict;
  /** Every reason the gate is shut. Empty when it is open. */
  blockers: string[];
  /** Shown on the screen: the human label for the verdict. */
  label: string;
  /** True only for a genuine Google ACCEPTED. An override is never this. */
  googleValidated: boolean;
  checkedAt: Date | null;
  canOverride: boolean;
}

/**
 * The human label for a verdict.
 *
 * `OVERRIDDEN` is worded so it can never be mistaken for a pass: it says who
 * accepted the risk, not that an address passed a check.
 */
export function verdictLabel(verdict: Verdict): string {
  switch (verdict) {
    case "ACCEPTED":
      return "Accepted by Google";
    case "CONFIRMATION_REQUIRED":
      return "Confirmation required";
    case "CORRECTION_REQUIRED":
      return "Correction required";
    case "UNAVAILABLE":
      return "Validation unavailable";
    case "OVERRIDDEN":
      return "Accepted by an owner, not validated by Google";
    default:
      return "Not validated";
  }
}

/**
 * Decide whether an address may be booked against.
 *
 * THE DEFAULT IS CLOSED. Every path that is not a fresh, current, accepted
 * verdict — or a recorded owner override of the current address — comes back
 * `allowed: false`. That includes the case that matters most: the stored
 * verdict may have been ACCEPTED, but if the address has been edited since, its
 * hash no longer matches and the acceptance describes a different address. That
 * check is why the hash is stored at all.
 *
 * A carrier's own serviceability check is separate and is not performed here.
 * Google accepting an address says the address is real; it says nothing about
 * whether a carrier serves it, and conflating the two would let a deliverable
 * address look like a serviceable one.
 */
export async function addressGate(
  subjectType: "PICKUP" | "DELIVERY",
  subjectId: string,
  options: { currentAddress?: StructuredAddress | null } = {}
): Promise<AddressGate> {
  const current = options.currentAddress ?? (await loadSubjectAddress(subjectType, subjectId));

  if (!current) {
    return {
      allowed: false,
      verdict: "UNVALIDATED",
      blockers: ["The address for this record could not be found."],
      label: verdictLabel("UNVALIDATED"),
      googleValidated: false,
      checkedAt: null,
      canOverride: false,
    };
  }

  const row = await prisma.addressValidation.findFirst({
    where: { subjectType, subjectId },
    orderBy: { checkedAt: "desc" },
  });

  if (!row) {
    return {
      allowed: false,
      verdict: "UNVALIDATED",
      blockers: ["This address has never been checked."],
      label: verdictLabel("UNVALIDATED"),
      googleValidated: false,
      checkedAt: null,
      canOverride: true,
    };
  }

  // A material edit invalidates the verdict: it now describes a different
  // address, and reusing it would let an unchecked address through on the
  // strength of an old check.
  if (row.inputHash !== addressInputHash(current)) {
    return {
      allowed: false,
      verdict: "UNVALIDATED",
      blockers: [
        "This address has changed since it was last checked, so the earlier result no " +
          "longer applies. Check it again before booking.",
      ],
      label: verdictLabel("UNVALIDATED"),
      googleValidated: false,
      checkedAt: row.checkedAt,
      canOverride: true,
    };
  }

  const expired = row.expiresAt !== null && row.expiresAt <= new Date();
  if (expired) {
    return {
      allowed: false,
      verdict: row.verdict,
      blockers: ["The last check of this address has expired. Check it again before booking."],
      label: verdictLabel(row.verdict),
      googleValidated: false,
      checkedAt: row.checkedAt,
      canOverride: true,
    };
  }

  if (row.verdict === "ACCEPTED") {
    return {
      allowed: true,
      verdict: "ACCEPTED",
      blockers: [],
      label: verdictLabel("ACCEPTED"),
      googleValidated: true,
      checkedAt: row.checkedAt,
      canOverride: false,
    };
  }

  if (row.verdict === "OVERRIDDEN") {
    return {
      allowed: true,
      verdict: "OVERRIDDEN",
      blockers: [],
      // The distinction the directive insists on, in one boolean.
      label: verdictLabel("OVERRIDDEN"),
      googleValidated: false,
      checkedAt: row.checkedAt,
      canOverride: false,
    };
  }

  return {
    allowed: false,
    verdict: row.verdict,
    blockers: [
      row.verdict === "UNAVAILABLE"
        ? row.unavailableReason ?? "The address could not be checked."
        : `This address needs attention before it can be booked against (${verdictLabel(row.verdict)}).`,
    ],
    label: verdictLabel(row.verdict),
    googleValidated: false,
    checkedAt: row.checkedAt,
    canOverride: true,
  };
}

/** The status of an address without making a call. For page renders. */
export async function addressStatus(
  subjectType: "PICKUP" | "DELIVERY",
  subjectId: string,
  currentAddress?: StructuredAddress | null
) {
  const gate = await addressGate(subjectType, subjectId, { currentAddress });
  const latest = await prisma.addressValidation.findFirst({
    where: { subjectType, subjectId },
    orderBy: { checkedAt: "desc" },
  });
  return {
    ...gate,
    suggested: (latest?.suggestedAddress as unknown as StructuredAddress | null) ?? null,
    differences: (latest?.differences as unknown as AddressDifference[] | null) ?? [],
    overrideReason: latest?.overrideReason ?? null,
    overriddenBy: latest?.overriddenByName ?? null,
    original: (latest?.originalAddress as unknown as StructuredAddress | null) ?? currentAddress ?? null,
  };
}
