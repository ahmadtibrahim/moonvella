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
import { COUNTRIES } from "~/utils/countries";
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
  /**
   * Where Google put the address, when it put it anywhere. Null on an
   * unavailable verdict, on a match too coarse to carry a point, and on every
   * verdict recorded before these columns existed.
   */
  latitude: number | null;
  longitude: number | null;
  /** Components Google says are missing, e.g. subpremise for a unit number. */
  missingComponents: string[];
  reason: string | null;
  /** True when this outcome came from storage rather than a fresh call. */
  cached: boolean;
  checkedAt: Date;
}

/**
 * Normalise before comparing, so " 12 Main St " and "12  main st" are the same
 * address and do not each cost a call. Case and internal whitespace are
 * flattened; the STRUCTURE is not — merging street2 into street1 here would
 * make two different doors compare equal.
 */
export function normalizeAddressPart(value: string | null | undefined): string {
  return foldDiacritics((value ?? "").trim().replace(/\s+/g, " ")).toLowerCase();
}

/**
 * Accents folded away, so "Montréal" and "Montreal" are one place.
 *
 * NFD splits a letter from its accent and the combining marks are then dropped,
 * which is what makes the *comparison* accent-blind. The stored value is never
 * touched: an address keeps the accents somebody typed, and only the question
 * "are these the same address" is answered without them.
 */
function foldDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * The two spellings of a country are one country. Country text arrives from
 * three directions and none of them agrees with the others: the depot form has
 * always asked for a code, a Shopify order carries `countryCode`, and Google's
 * validation response answers with a display name. Comparing them as text makes
 * "CA" versus "Canada" look like a correction the operator has to accept, which
 * is exactly the formatting-only difference the directive forbids forcing an
 * override for.
 */
const COUNTRY_CODES = new Map<string, string>();
for (const country of COUNTRIES) {
  COUNTRY_CODES.set(normalizeAddressPart(country.name), country.code);
}

/** Spellings that name a country without being its name or its code. */
const COUNTRY_ALIASES: Record<string, string> = {
  america: "US",
  "united states of america": "US",
  "u.s.": "US",
  "u.s.a.": "US",
  us: "US",
  usa: "US",
  britain: "GB",
  "great britain": "GB",
  "u.k.": "GB",
  uk: "GB",
  "united kingdom of great britain and northern ireland": "GB",
};

/**
 * The two-letter code for any spelling of a country, or "" when the text names
 * no country this app knows.
 */
export function countryCodeFor(value: string | null | undefined): string {
  const part = normalizeAddressPart(value);
  if (!part) return "";
  const upper = part.toUpperCase();
  if (part.length === 2 && COUNTRIES.some((country) => country.code === upper)) return upper;
  return COUNTRY_CODES.get(part) ?? COUNTRY_ALIASES[part] ?? "";
}

/**
 * The country as this app stores and sends it: the code when the text names a
 * country we know, otherwise the text unchanged rather than mangled into a
 * pseudo-code.
 *
 * This is what makes Google's `country` component land in the record as "CA"
 * instead of "Canada", and it is also why `callGoogle` can put the value
 * straight into `regionCode` — a field that wants an ISO code and would be sent
 * "CANADA" by a naive `toUpperCase()`.
 */
export function canonicalCountry(value: string | null | undefined): string {
  return countryCodeFor(value) || (value ?? "").trim();
}

/**
 * Province and state names beside their codes, for the same reason countries
 * have them: Google answers with "Ontario" where the depot form stored "ON".
 *
 * The list covers the two countries this deployment ships between rather than
 * the world. An unrecognised name is compared as text, which is the behaviour
 * that existed before any of this — so an address in a country not listed here
 * is no worse off, it simply gets no folding.
 */
const REGION_NAMES: Record<string, string[]> = {
  // Canada
  AB: ["alberta"],
  BC: ["british columbia"],
  MB: ["manitoba"],
  NB: ["new brunswick"],
  NL: ["newfoundland and labrador", "newfoundland"],
  NS: ["nova scotia"],
  NT: ["northwest territories"],
  NU: ["nunavut"],
  ON: ["ontario"],
  PE: ["prince edward island"],
  QC: ["quebec"],
  SK: ["saskatchewan"],
  YT: ["yukon"],
  // United States
  AK: ["alaska"],
  AL: ["alabama"],
  AR: ["arkansas"],
  AZ: ["arizona"],
  CA: ["california"],
  CO: ["colorado"],
  CT: ["connecticut"],
  DC: ["district of columbia", "washington dc"],
  DE: ["delaware"],
  FL: ["florida"],
  GA: ["georgia"],
  HI: ["hawaii"],
  IA: ["iowa"],
  ID: ["idaho"],
  IL: ["illinois"],
  IN: ["indiana"],
  KS: ["kansas"],
  KY: ["kentucky"],
  LA: ["louisiana"],
  MA: ["massachusetts"],
  MD: ["maryland"],
  ME: ["maine"],
  MI: ["michigan"],
  MN: ["minnesota"],
  MO: ["missouri"],
  MS: ["mississippi"],
  MT: ["montana"],
  NC: ["north carolina"],
  ND: ["north dakota"],
  NE: ["nebraska"],
  NH: ["new hampshire"],
  NJ: ["new jersey"],
  NM: ["new mexico"],
  NV: ["nevada"],
  NY: ["new york"],
  OH: ["ohio"],
  OK: ["oklahoma"],
  OR: ["oregon"],
  PA: ["pennsylvania"],
  RI: ["rhode island"],
  SC: ["south carolina"],
  SD: ["south dakota"],
  TN: ["tennessee"],
  TX: ["texas"],
  UT: ["utah"],
  VA: ["virginia"],
  VT: ["vermont"],
  WA: ["washington"],
  WI: ["wisconsin"],
  WV: ["west virginia"],
  WY: ["wyoming"],
};

const REGION_CODES = new Map<string, string>();
for (const [code, names] of Object.entries(REGION_NAMES)) {
  for (const name of names) REGION_CODES.set(normalizeAddressPart(name), code);
}

/** The code a province or state name stands for, or "" when it is not listed. */
export function regionCodeFor(value: string | null | undefined): string {
  const part = normalizeAddressPart(value);
  if (!part) return "";
  const upper = part.toUpperCase();
  if (part.length === 2 && REGION_NAMES[upper]) return upper;
  return REGION_CODES.get(part) ?? "";
}

/**
 * A unit written five ways is one unit: "Unit 7A", "#7A", "Apt. 7A" and "7A" all
 * describe the same door, and which spelling a person or a feed chooses says
 * nothing about the address. The prefix is stripped repeatedly, because they
 * stack — "# Unit 7A" is not unusual in a hand-typed field.
 *
 * Only the unit field is compared this way. Applying it to street1 would make
 * "12 Main St Unit 7A" equal to "12 Main St", and those are deliberately
 * different: Google puts the unit in the subpremise component, the app keeps it
 * in its own column, and collapsing the two here would erase a real difference
 * instead of a cosmetic one.
 */
const UNIT_PREFIX = /^(?:unit|apt|apartment|suite|ste|flat|bldg|building|no|number|#)\s*[.:#-]?\s*/;

export function normalizeUnitPart(value: string | null | undefined): string {
  let part = normalizeAddressPart(value);
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = part.replace(UNIT_PREFIX, "").trim();
    // An empty result means the whole field was the prefix ("Unit"), which
    // carries no door number and is left as typed rather than folded to nothing.
    if (!stripped || stripped === part) break;
    part = stripped;
  }
  return part;
}

/** Punctuation and spacing in a postal code are presentation, not location. */
export function normalizePostalCode(value: string | null | undefined): string {
  return normalizeAddressPart(value).replace(/[^a-z0-9]/g, "");
}

/** Every field a verdict is about, in the order it is read and hashed. */
const ADDRESS_FIELDS: (keyof StructuredAddress)[] = [
  "street1",
  "street2",
  "city",
  "province",
  "postalCode",
  "country",
];

/**
 * The form of one field that is compared. Storage is never normalised — a
 * record keeps the text somebody entered, accents, prefixes and all — and this
 * is the only place the comparison rules live, so the hash, the cached lookup
 * and the difference list can never disagree about what counts as a change.
 */
export function comparisonForm(field: keyof StructuredAddress, value: string | null | undefined): string {
  switch (field) {
    case "country":
      return countryCodeFor(value) || normalizeAddressPart(value);
    case "province":
      return regionCodeFor(value) || normalizeAddressPart(value);
    case "postalCode":
      return normalizePostalCode(value);
    case "street2":
      return normalizeUnitPart(value);
    default:
      return normalizeAddressPart(value);
  }
}

/**
 * Whether two addresses are the same address, under the rules above.
 *
 * A null on either side is never equivalent: an address that could not be read
 * cannot be compared, and answering "same" there would let a verdict about an
 * address nobody can parse stand in for one that was never read at all.
 */
export function addressesEquivalent(
  a: StructuredAddress | null | undefined,
  b: StructuredAddress | null | undefined
): boolean {
  if (!a || !b) return false;
  return ADDRESS_FIELDS.every(
    (field) => comparisonForm(field, a[field] as string | null) === comparisonForm(field, b[field] as string | null)
  );
}

export function addressInputHash(address: StructuredAddress): string {
  const material = ADDRESS_FIELDS.map((field) =>
    comparisonForm(field, address[field] as string | null)
  ).join("\u0000");
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
 * The key each structured field is written back to, in the order the stored JSON
 * may spell it. Shopify's names come first where they exist, because that is the
 * shape this column actually holds.
 */
const STORED_ADDRESS_KEYS: Record<keyof StructuredAddress, string[]> = {
  street1: ["address1", "address"],
  street2: ["address2"],
  city: ["city"],
  province: ["province", "provinceCode"],
  postalCode: ["zip", "postalCode"],
  country: ["country", "countryCode"],
};

/**
 * Write fields back into a stored shipping-address blob, leaving everything
 * else in it alone.
 *
 * A delivery address is not a row of five columns; it is the JSON a Shopify
 * order arrived with, and it carries a recipient name, a phone number, a
 * company and whatever else Shopify adds next. Rebuilding it from the five
 * fields this module understands would silently delete all of that, so the
 * object is edited in place instead.
 *
 * A field is written to every key it is already stored under, so a blob
 * carrying both `postalCode` and `zip` cannot keep a stale twin that the reader
 * then prefers. Returns null for a blob that cannot be read, which the caller
 * treats as a refusal rather than as an empty address.
 */
export function applyToStoredAddress(
  raw: string | null | undefined,
  patch: Partial<StructuredAddress>
): string | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  for (const [field, value] of Object.entries(patch)) {
    const keys = STORED_ADDRESS_KEYS[field as keyof StructuredAddress];
    if (!keys || value === undefined) continue;
    const present = keys.filter((candidate) => candidate in parsed);
    for (const key of present.length > 0 ? present : [keys[0]]) parsed[key] = value;
  }
  return JSON.stringify(parsed);
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
    geocode?: {
      placeId?: string;
      /** Where Google matched the address, when it matched it to a point. */
      location?: { latitude?: number; longitude?: number };
    };
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
      // The country is stored as its two-letter code wherever this app writes
      // one, so Google's display name is converted here rather than being
      // copied into a record that every other path expects to hold a code.
      result[field] = field === "country" ? canonicalCountry(text) : text;
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
    // Compared in the per-field form, so a disagreement about spelling — a
    // country written as a name on one side and a code on the other, a unit
    // written with a prefix on one side only — is not a difference at all.
    if (comparisonForm(field, before) === comparisonForm(field, after)) continue;
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
    latitude: coordinate(response.result?.geocode?.location?.latitude),
    longitude: coordinate(response.result?.geocode?.location?.longitude),
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
      // Refused before Google was asked, so it has no coordinates for it.
      latitude: null,
      longitude: null,
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
    latitude: row.latitude,
    longitude: row.longitude,
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
          // An ISO code, not the text somebody typed. A record holding "Canada"
          // would otherwise be sent as "CANADA", which Google cannot route as a
          // region — and the failure looks like a bad address rather than a bad
          // field.
          regionCode: canonicalCountry(address.country),
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
    // Nothing was checked, so there is nowhere Google said this address is.
    latitude: null,
    longitude: null,
    missingComponents: [],
    reason: `${reason} The address has not been checked, so it is not marked valid.`,
    cached: false,
    checkedAt: new Date(),
  };
}

/**
 * One half of a coordinate pair, or null.
 *
 * A response is untrusted input. `0` is a real coordinate and is kept — the
 * equator and the prime meridian are places — so this cannot use a truthiness
 * test, and a JSON body that sent a string or NaN is dropped rather than
 * written into a numeric column as a guess. Nothing is invented for the missing
 * half: a latitude with no longitude is not a location, and storing one would
 * invite a map to plot it at a longitude it made up.
 */
function coordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
      latitude: outcome.latitude,
      longitude: outcome.longitude,
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

  /*
   * The suggestion and the difference list are carried onto the override row so
   * the decision shows what was being accepted — but only when the row they came
   * from describes the address being overridden now. An owner may override an
   * address that was edited after it was last checked; copying across that edit
   * would attach Google's answer about the old address to a decision about the
   * new one, and the record would read as though the override were informed by a
   * check of an address it never saw.
   */
  const previousDescribesAddress = addressesEquivalent(
    previous?.originalAddress as unknown as StructuredAddress | null,
    address
  );

  const row = await prisma.addressValidation.create({
    data: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      inputHash: addressInputHash(address),
      verdict: "OVERRIDDEN",
      originalAddress: address as unknown as object,
      suggestedAddress: (previousDescribesAddress
        ? (previous?.suggestedAddress ?? undefined)
        : undefined) as object | undefined,
      differences: (previousDescribesAddress
        ? (previous?.differences ?? undefined)
        : undefined) as object | undefined,
      granularity: previousDescribesAddress ? (previous?.granularity ?? null) : null,
      placeId: previousDescribesAddress ? (previous?.placeId ?? null) : null,
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
      overriddenVerdict: previousDescribesAddress ? (previous?.verdict ?? "UNVALIDATED") : "UNVALIDATED",
    },
  });

  return { ok: true, validationId: row.id };
}

/* -------------------------------------------------------------------------- */
/* Accepting Google's suggestion                                              */
/* -------------------------------------------------------------------------- */

export interface AppliedChange {
  component: string;
  from: string | null;
  to: string | null;
}

export type ApplySuggestionResult =
  | {
      ok: true;
      /** The fields actually rewritten. Empty is impossible: a no-op is refused. */
      applied: AppliedChange[];
      /** The verdict for the address as it now stands, freshly checked. */
      outcome: ValidationOutcome;
      message: string;
    }
  | { ok: false; error: string; applied: [] };

/**
 * Write Google's suggestion into the stored address, then check the result.
 *
 * WHY THIS IS NOT JUST "SAVE THE FORM". The suggested address is read back from
 * the stored verdict rather than taken from the request, so the browser cannot
 * propose values Google never gave: the only address this can write is the one
 * the latest check produced for this exact record. That is also why a suggestion
 * that no longer describes the record's current address is refused outright
 * instead of being tidied up — see `addressStatus`.
 *
 * ONLY FIELDS THAT ACTUALLY DIFFER ARE WRITTEN. A field whose two spellings
 * compare equal ("ON" against "Ontario", "Unit 7A" against "#7A", the same
 * postal code with a space moved) is left exactly as the person entered it: the
 * point of the comparison rules is that a formatting difference is not a change,
 * and quietly rewriting a field to Google's spelling of a value that was already
 * correct is the churn the directive asks us not to do. The unit is therefore
 * preserved whenever it matches, which is the behaviour the directive requires,
 * and is not special-cased — it falls out of the same rule.
 *
 * The verdict is then re-checked and stored, because the address it described
 * is gone. This is a deliberately billable call on a deliberate click; it is not
 * a page render. If Google cannot be reached the address still changes — the
 * operator asked for that, and refusing to save it would lose the correction —
 * and the stored verdict comes back UNAVAILABLE, which the gate keeps shut. That
 * outcome is recorded rather than swallowed, so the panel says the save happened
 * and the check did not.
 *
 * A delivery address is edited inside the order's stored JSON, so a later
 * webhook may supersede it with the address the customer's own order carries.
 * That is correct — the order's address is the customer's to change — and it is
 * why the gate re-reads the address from the order every time rather than
 * trusting a copy.
 */
export async function applySuggestedAddress(input: {
  subjectType: "PICKUP" | "DELIVERY";
  subjectId: string;
  actorId: string;
}): Promise<ApplySuggestionResult> {
  const actor = await prisma.adminUser.findUnique({
    where: { id: input.actorId },
    select: { id: true, name: true, role: true, isActive: true },
  });
  if (!actor || !actor.isActive) return { ok: false, error: "Unknown or inactive user.", applied: [] };

  /*
   * The same role rule as recording an override, and for a related reason: both
   * write an address that a carrier will be handed, and both do it from a panel
   * rather than from the ordinary edit form. Widening this is a one-line change
   * here, and it should be widened here rather than checked at the button,
   * because a role submitted by a form is a role the submitter chose.
   */
  if (actor.role !== "OWNER") {
    return {
      ok: false,
      error: "Only an owner may apply a suggested address to a record.",
      applied: [],
    };
  }

  const current = await loadSubjectAddress(input.subjectType, input.subjectId);
  if (!current) {
    return { ok: false, error: "The address being corrected could not be found.", applied: [] };
  }

  const status = await addressStatus(input.subjectType, input.subjectId, current);
  if (!status.suggestionCurrent) {
    return {
      ok: false,
      error:
        "The stored suggestion is for an earlier version of this address. Check the " +
        "address again, then apply the new suggestion.",
      applied: [],
    };
  }
  const suggested = status.suggested;
  if (!suggested) {
    return {
      ok: false,
      error: "There is no suggestion stored for this address. Check it first.",
      applied: [],
    };
  }

  const applied: AppliedChange[] = [];
  const patch: Partial<StructuredAddress> = {};
  for (const field of ADDRESS_FIELDS) {
    const before = (current[field] ?? null) as string | null;
    const after = (suggested[field] ?? null) as string | null;
    if (comparisonForm(field, before) === comparisonForm(field, after)) continue;
    patch[field] = after ?? "";
    applied.push({ component: field, from: before, to: after });
  }

  if (applied.length === 0) {
    return {
      ok: false,
      error:
        "Google's suggestion differs from the stored address only in formatting, so there " +
        "is nothing to apply. If the address is correct as entered, record an override; " +
        "otherwise check it again.",
      applied: [],
    };
  }

  const next: StructuredAddress = { ...current, ...patch };
  try {
    if (input.subjectType === "PICKUP") {
      await prisma.pickupLocation.update({
        where: { id: input.subjectId },
        data: {
          street1: next.street1,
          street2: next.street2 ?? null,
          city: next.city,
          province: next.province,
          postalCode: next.postalCode,
          country: next.country,
        },
      });
    } else {
      const order = await prisma.order.findUnique({
        where: { id: input.subjectId },
        select: { shippingAddress: true },
      });
      const rewritten = applyToStoredAddress(order?.shippingAddress, patch);
      if (!rewritten) {
        return {
          ok: false,
          error:
            "This order's stored shipping address could not be read, so it cannot be " +
            "corrected here.",
          applied: [],
        };
      }
      await prisma.order.update({
        where: { id: input.subjectId },
        data: { shippingAddress: rewritten },
      });
    }
  } catch (error) {
    return {
      ok: false,
      error: `The corrected address could not be saved: ${
        error instanceof Error ? error.message : "unknown error"
      }.`,
      applied: [],
    };
  }

  const outcome = await validateAddress(next, { refresh: true });
  await recordValidation({ subjectType: input.subjectType, subjectId: input.subjectId, outcome });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name,
    action: "address.suggestion_applied",
    entityType: AUDIT_ENTITY.SETTINGS,
    entityId: input.subjectId,
    // Component names and the two values, which is the decision that was made.
    // Same reduced shape as the difference list the panel showed.
    afterData: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      applied,
      verdict: outcome.verdict,
    },
  });

  const what = applied.map((change) => change.component).join(", ");
  return {
    ok: true,
    applied,
    outcome,
    message:
      outcome.verdict === "ACCEPTED"
        ? `Applied Google's suggestion (${what}) and Google accepts the address as it now stands.`
        : `Applied Google's suggestion (${what}). The address is saved, but the check came back ${
            verdictLabel(outcome.verdict).toLowerCase()
          }.`,
  };
}

/**
 * The address a verdict is about, exactly as the gate reads it.
 *
 * Exported because a screen offering "check this now" has to check the same
 * address the booking will be judged on. A route that assembled its own copy
 * from the same row would be a second definition of the address, and the day
 * the two disagree the panel says ACCEPTED while the gate says the hash does
 * not match — the worst possible version of this feature.
 */
export async function loadSubjectAddress(
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

  /*
   * DELIVERY is keyed on the ORDER, not on a stored address record: the
   * destination exists only as the billing/shipping blob the order arrived
   * with, and there is nothing to point at but the order itself. An order with
   * no shipping address is returned as null rather than as an empty address, so
   * the gate refuses it with "could not be found" instead of asking Google to
   * validate a blank.
   */
  const order = await prisma.order.findUnique({
    where: { id: subjectId },
    select: { shippingAddress: true },
  });
  if (!order) return null;
  return structuredFromStoredAddress(order.shippingAddress);
}

/* -------------------------------------------------------------------------- */
/* The booking gate                                                           */
/* -------------------------------------------------------------------------- */

export class BookingAddressRefused extends Error {
  readonly blockers: string[];
  constructor(message: string, blockers: string[]) {
    super(message);
    this.name = "BookingAddressRefused";
    this.blockers = blockers;
  }
}

export interface BookingAddressCheck {
  allowed: boolean;
  /** Every reason the booking must not proceed, one line per end. Empty when open. */
  blockers: string[];
  pickup: AddressGate | null;
  delivery: AddressGate;
}

/**
 * Both ends of a booking, gated together.
 *
 * A LABEL CARRIES TWO ADDRESSES AND BOTH OF THEM PRINT. Gating only the dock
 * would leave the destination — the address the goods actually travel to, and
 * the one a customer typed into a checkout form — unchecked; gating only the
 * destination would leave the dock, which is the address that decides the
 * price, unchecked. So both are asked, and the booking is refused if either is
 * not accepted.
 *
 * WHAT "ACCEPTED" MEANS HERE. `addressGate` is the only judge: a current
 * ACCEPTED verdict for the address as it stands now, or a recorded owner
 * override of that same address. UNAVAILABLE is NOT a pass — it is the verdict
 * that says nobody checked, and treating an outage as consent is the one
 * reading the module's rules forbid. An address that was accepted and then
 * edited is not accepted either: the hash no longer matches, so the old verdict
 * describes a different address.
 *
 * The pickup end is null when no dock was resolved. That is not this function's
 * refusal to make — booking already refuses an order whose lines map to no dock,
 * and it says so first — but the null is reported rather than folded into a
 * pass, so a caller that somehow reaches here without one is refused too.
 */
export async function bookingAddressGate(input: {
  originLocationId: string | null | undefined;
  orderId: string;
}): Promise<BookingAddressCheck> {
  const [pickup, delivery] = await Promise.all([
    input.originLocationId ? addressGate("PICKUP", input.originLocationId) : Promise.resolve(null),
    addressGate("DELIVERY", input.orderId),
  ]);

  const blockers: string[] = [];
  if (!pickup) {
    blockers.push(
      "The pickup address could not be resolved, so it cannot be checked. Map the ordered items to a pickup location first."
    );
  } else if (!pickup.allowed) {
    blockers.push(`Pickup address — ${pickup.label}: ${pickup.blockers.join(" ")}`);
  }
  if (!delivery.allowed) {
    blockers.push(`Delivery address — ${delivery.label}: ${delivery.blockers.join(" ")}`);
  }

  return { allowed: blockers.length === 0, blockers, pickup, delivery };
}

/**
 * The same check, as the refusal a booking throws.
 *
 * The wording is load-bearing. It names which end failed, repeats the gate's own
 * reason rather than a generic one, and states the way out — check the address,
 * or have an owner record an override — because the alternative is an operator
 * who reads "refused" and looks for a way to make the screen stop refusing.
 * It does NOT name the address itself: the refusal travels into logs and audit
 * rows, and the screen it is rendered on already shows the address.
 */
export async function assertBookingAddressesBookable(input: {
  originLocationId: string | null | undefined;
  orderId: string;
}): Promise<BookingAddressCheck> {
  const gate = await bookingAddressGate(input);
  if (gate.allowed) return gate;

  throw new BookingAddressRefused(
    `Booking refused: ${gate.blockers.join(" ")} ` +
      `A booking needs an address Google accepts, or an owner override recorded with a reason. ` +
      `An address the validator could not check does not pass.`,
    gate.blockers
  );
}

/**
 * The destination end alone, for bookings that do not travel from a dock.
 *
 * A return label points from the configured return address BACK to the customer,
 * so its destination is the order's shipping address — the same address, under
 * the same subject, as the outbound delivery. It is checked for the same reason.
 *
 * The other end is deliberately NOT checked, and this is the honest limit of
 * this function rather than an oversight. A return's ship-from is
 * `configuredReturnAddress()` in shipping.server.ts: environment placeholders
 * that are not a PickupLocation and therefore have no record a verdict could
 * belong to. Gating it would refuse every return with no way to clear the
 * refusal. That address is already flagged in the code as Phase D work — the
 * day it becomes a real configured record, it becomes gateable, and this
 * function should grow the pickup half.
 */
export async function assertDeliveryAddressBookable(
  orderId: string,
  context = "Booking"
): Promise<AddressGate> {
  const delivery = await addressGate("DELIVERY", orderId);
  if (delivery.allowed) return delivery;

  throw new BookingAddressRefused(
    `${context} refused: Delivery address — ${delivery.label}: ${delivery.blockers.join(" ")} ` +
      `A booking needs an address Google accepts, or an owner override recorded with a reason. ` +
      `An address the validator could not check does not pass.`,
    [`Delivery address — ${delivery.label}: ${delivery.blockers.join(" ")}`]
  );
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

  /*
   * A material edit invalidates the verdict: it now describes a different
   * address, and reusing it would let an unchecked address through on the
   * strength of an old check.
   *
   * THE ROW'S OWN ADDRESS IS COMPARED, NOT ITS HASH, and the difference matters.
   * A hash is only comparable against a hash produced by the same version of the
   * normaliser. The normaliser deliberately changes — country names fold to
   * codes, units fold to their number — so an address nobody touched can hash
   * differently to the way it hashed when its verdict was written, and a hash
   * comparison would then announce that the address had changed and demand a
   * re-check. The row stores the address it was computed for, so comparing that
   * address to the current one under the same rules answers the question the
   * hash was standing in for — and answers it for rows written by any earlier
   * version. The hash keeps its real job: the cache lookup that stops an
   * unchanged address costing a second call.
   */
  if (!addressesEquivalent(row.originalAddress as unknown as StructuredAddress | null, current)) {
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

  /*
   * UNAVAILABLE is asked about BEFORE the expiry test, and the order matters.
   *
   * An unavailable verdict is stored with `expiresAt = checkedAt`, so it is
   * always already expired — which means the expiry branch would answer for it,
   * and the operator would be told "the last check of this address has expired,
   * check it again". That is true and useless: it reads as housekeeping, and it
   * hides the fact that the validator never answered, which is the thing worth
   * knowing. The check is what failed; the row says so; so the gate says so.
   */
  if (row.verdict === "UNAVAILABLE") {
    return {
      allowed: false,
      verdict: "UNAVAILABLE",
      blockers: [
        row.unavailableReason ??
          "The address could not be checked. Booking stays blocked until it is.",
      ],
      label: verdictLabel("UNAVAILABLE"),
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

  // What is left is a verdict that asks for a person: Google could not confirm
  // the address, or it wants a component corrected. UNAVAILABLE cannot reach
  // here — it is answered above, before the expiry test.
  return {
    allowed: false,
    verdict: row.verdict,
    blockers: [
      `This address needs attention before it can be booked against (${verdictLabel(row.verdict)}).`,
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
  const current = currentAddress ?? (await loadSubjectAddress(subjectType, subjectId));
  const gate = await addressGate(subjectType, subjectId, { currentAddress: current });
  const latest = await prisma.addressValidation.findFirst({
    where: { subjectType, subjectId },
    orderBy: { checkedAt: "desc" },
  });

  /*
   * A SUGGESTION BELONGS TO THE ADDRESS IT WAS COMPUTED FOR. Once the record is
   * edited, the newest row describes the address as it was before the edit, and
   * its suggestion is Google's answer about that older address. Showing it
   * beside the new one invites somebody to accept a correction to something
   * they are no longer looking at, and applying it would write those old values
   * over the new address. So a suggestion that no longer matches is withheld
   * entirely rather than shown with a caveat, and `suggestionCurrent` records
   * which of the two happened.
   */
  const latestAddress = (latest?.originalAddress as unknown as StructuredAddress | null) ?? null;
  const describesCurrent = addressesEquivalent(latestAddress, current);

  return {
    ...gate,
    suggested: describesCurrent
      ? ((latest?.suggestedAddress as unknown as StructuredAddress | null) ?? null)
      : null,
    differences: describesCurrent
      ? ((latest?.differences as unknown as AddressDifference[] | null) ?? [])
      : [],
    suggestionCurrent: describesCurrent,
    /*
     * Where the last check put this address. Withheld on the same rule as the
     * suggestion: coordinates belong to the address they were computed for, and
     * showing a point from before an edit beside the edited address would put a
     * confident-looking position next to an address nobody has located.
     */
    latitude: describesCurrent ? (latest?.latitude ?? null) : null,
    longitude: describesCurrent ? (latest?.longitude ?? null) : null,
    overrideReason: latest?.overrideReason ?? null,
    overriddenBy: latest?.overriddenByName ?? null,
    original: describesCurrent ? latestAddress : (current ?? null),
  };
}
