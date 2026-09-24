/**
 * Google's address suggestions, read without a browser.
 *
 * WHAT THIS IS AND IS NOT. Typing a business address into a form is where a
 * wrong address is born: a unit number folded into the street line, a province
 * spelled out where the carrier wants a code, a postal code typed as "L5T1G1"
 * where the label needs "L5T 1G1". Places Autocomplete (New) answers that by
 * offering the components Google already holds, laid out one per column. It is
 * an ENTRY AID. It is not validation: nothing here says an address is correct,
 * deliverable, or the merchant's registered place of business, and nothing here
 * may set a verdict. The one path that produces a verdict is
 * `validateAddress()` in addressValidation.server.ts, which calls Address
 * Validation on the server with a key that never reaches a page.
 *
 * WHY THE PARSING IS HERE AND NOT IN THE COMPONENT. Two pages use this — the
 * embedded merchant application and the admin pickup-address form — and one of
 * them is a `.jsx` file, which this build never typechecks. Everything with a
 * decision in it therefore lives in this typed module, and the pages are left
 * with listening and assigning.
 *
 * NO `addressLine2`, EVER. The unit belongs to Street 2, on its own, and this
 * module cannot produce one: `addressLine1` is rebuilt from `street_number` +
 * `route` rather than taken from Google's formatted text, so the unit cannot be
 * folded into the street line; and a `subpremise` component comes back as
 * `unitHint` — a sentence for a human — never as a value for a field. Street 2
 * is the one column the merchant always owns.
 *
 * The request builders are pure so the shape of what is sent is checkable: the
 * key travels in a header, the region is pinned, and the field mask asks for
 * the two fields this code reads and nothing else.
 */

/** One entry of Google's `addressComponents`. */
export interface PlaceComponent {
  /**
   * Places API (New) spells these `longText` / `shortText`; an older response,
   * or a legacy-shaped fixture, spells them `long_name` / `short_name`. Both are
   * read, because a component this code cannot read is a component silently
   * dropped — a missing city looks exactly like Google not knowing one.
   */
  longText?: string | null;
  shortText?: string | null;
  long_name?: string | null;
  short_name?: string | null;
  types?: string[] | null;
}

/**
 * The five address columns a suggestion may fill.
 *
 * `addressLine2` is absent by construction. Adding it here would be the first
 * step towards the merge this module exists to prevent.
 */
export type PlaceAddressField =
  | "addressLine1"
  | "addressCity"
  | "addressProvinceCode"
  | "addressPostalCode"
  | "addressCountryCode";

export interface PickedAddress {
  /**
   * Only the fields Google actually answered with. A field left out is not sent
   * as an empty string: overwriting a merchant's city with "" because Google was
   * silent about it is the same bug as overwriting it with a wrong one.
   */
  fields: Partial<Record<PlaceAddressField, string>>;
  /**
   * The unit Google knows about, if any — a sentence, not a value. Street 2 is
   * left exactly as the merchant typed it, and this is how the page can mention
   * what Google holds without writing it anywhere.
   */
  unitHint: string | null;
  /** Google's own rendering of the whole address, for the confirmation line. */
  formattedAddress: string | null;
}

/** One row of the suggestion list. */
export interface PlaceSuggestion {
  placeId: string;
  mainText: string;
  secondaryText: string;
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

function text(component: PlaceComponent, which: "long" | "short"): string {
  const value = which === "long" ? component.longText ?? component.long_name : component.shortText ?? component.short_name;
  return (value ?? "").trim();
}

function findComponent(components: PlaceComponent[], type: string): PlaceComponent | null {
  for (const component of components) {
    if (component.types?.includes(type)) return component;
  }
  return null;
}

/** The first component of any of these types, in the order given. */
function findFirst(components: PlaceComponent[], types: string[]): PlaceComponent | null {
  for (const type of types) {
    const found = findComponent(components, type);
    if (found) return found;
  }
  return null;
}

/**
 * Google's component list, read into the columns this app stores.
 *
 * The city comes from whichever of Google's several "city" types the record
 * actually carries — a locality where the address has one, and a postal town or
 * a sublocality in the rural and municipal cases where it does not. The order is
 * deliberate and is not a guess: each fallback is a type Google uses for a
 * settlement, and a record with none of them gets no city rather than the
 * nearest thing.
 */
export function addressFromPlaceComponents(components: PlaceComponent[]): PickedAddress {
  const fields: Partial<Record<PlaceAddressField, string>> = {};

  const streetNumber = findComponent(components, "street_number");
  const route = findComponent(components, "route");
  const street1 = [streetNumber ? text(streetNumber, "long") : "", route ? text(route, "long") : ""]
    .filter(Boolean)
    .join(" ")
    .trim();
  // A record with neither is a record this module cannot lay out — a
  // city-centre prediction, a plus code — so Street 1 is left out and whatever
  // the merchant typed stands.
  if (street1) fields.addressLine1 = street1;

  const city = findFirst(components, [
    "locality",
    "postal_town",
    "sublocality_level_1",
    "administrative_area_level_3",
    "administrative_area_level_2",
  ]);
  if (city) {
    const value = text(city, "long");
    if (value) fields.addressCity = value;
  }

  const province = findComponent(components, "administrative_area_level_1");
  if (province) {
    // The short form is the code a carrier wants ("ON"); a record carrying only
    // the long form is stored as it stands rather than mapped through a table
    // this app would have to keep.
    const value = text(province, "short") || text(province, "long");
    if (value) fields.addressProvinceCode = value;
  }

  const postal = findComponent(components, "postal_code");
  if (postal) {
    const value = text(postal, "long");
    if (value) fields.addressPostalCode = value;
  }

  const country = findComponent(components, "country");
  if (country) {
    const value = text(country, "short") || text(country, "long");
    if (value) fields.addressCountryCode = value;
  }

  const subpremise = findComponent(components, "subpremise");
  const unit = subpremise ? text(subpremise, "long") : "";

  return {
    fields,
    unitHint: unit ? `Unit ${unit}` : null,
    formattedAddress: null,
  };
}

/** Attach Google's own rendering of the address to a parsed result. */
export function withFormattedAddress(
  picked: PickedAddress,
  formattedAddress: string | null | undefined,
): PickedAddress {
  const value = (formattedAddress ?? "").trim();
  return { ...picked, formattedAddress: value || null };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

export const PLACES_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";

/**
 * The field mask on the details call.
 *
 * Places API has no default field list and bills by what is asked for, so this
 * names the two fields the parser reads and nothing else. `addressComponents`
 * is the structured form; `formattedAddress` is only ever shown to the person
 * who is typing, never stored in a column.
 */
export const PLACES_DETAILS_FIELD_MASK = "addressComponents,formattedAddress";

export function placesDetailsUrl(placeId: string): string {
  return `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
}

/**
 * The key travels in a header rather than the query string: a URL is written to
 * browser history, referrer headers and server logs, and this key is the one
 * credential the app hands to a page at all.
 */
export function placesHeaders(apiKey: string, fieldMask?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
  };
  if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;
  return headers;
}

export interface PlacesRequest {
  url: string;
  init: RequestInit;
}

/**
 * An autocomplete query, pinned to one country.
 *
 * `includedRegionCodes` is not a preference: this app ships to Canadian
 * addresses, and without the pin a typed street in a border town can be offered
 * in another province of a different country, which then arrives as a country
 * code the rest of the pipeline has no rate for.
 */
export function autocompleteRequest(
  apiKey: string,
  input: string,
  sessionToken: string,
  regionCodes: string[] = ["ca"],
): PlacesRequest {
  return {
    url: PLACES_AUTOCOMPLETE_URL,
    init: {
      method: "POST",
      headers: placesHeaders(apiKey),
      body: JSON.stringify({
        input,
        includedRegionCodes: regionCodes,
        sessionToken,
      }),
    },
  };
}

/**
 * The details call for one chosen suggestion.
 *
 * The session token is the same one the typing used, which is what makes the
 * keystrokes and the choice bill as one session instead of as a call per
 * keystroke. It is passed as a query parameter because that is where the
 * endpoint documents it.
 */
export function detailsRequest(
  apiKey: string,
  placeId: string,
  sessionToken: string,
): PlacesRequest {
  const url = `${placesDetailsUrl(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}`;
  return {
    url,
    init: { method: "GET", headers: placesHeaders(apiKey, PLACES_DETAILS_FIELD_MASK) },
  };
}

/**
 * A session token for one address-entry session.
 *
 * The value is opaque to Google; what matters is that it is unique per session
 * and not reused across unrelated lookups, so it is random rather than derived
 * from anything about the store.
 */
export function newSessionToken(): string {
  const globalCrypto = typeof globalThis === "undefined" ? undefined : globalThis.crypto;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  if (globalCrypto?.getRandomValues) {
    const bytes = globalCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // A browser without Web Crypto is one old enough to matter only as a fallback:
  // the token's only job is to keep two lookups from being billed as one.
  return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The suggestion rows out of an autocomplete response.
 *
 * A query prediction has no place id and cannot be resolved to components, so
 * it is dropped rather than shown: a row that does nothing when picked is worse
 * than a shorter list.
 */
export function readSuggestions(payload: unknown): PlaceSuggestion[] {
  const suggestions = (payload as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(suggestions)) return [];
  const out: PlaceSuggestion[] = [];
  for (const entry of suggestions) {
    const prediction = (entry as { placePrediction?: Record<string, unknown> })?.placePrediction;
    if (!prediction) continue;
    const placeId = String(prediction.placeId ?? "").trim();
    if (!placeId) continue;
    const structured = prediction.structuredFormat as
      | { mainText?: { text?: string }; secondaryText?: { text?: string } }
      | undefined;
    // `text` is an object (`{ text }`) and is only a fallback: the structured
    // form is what splits the row into the two lines the list renders.
    const plain = prediction.text as { text?: string } | undefined;
    const mainText = String(structured?.mainText?.text ?? plain?.text ?? "").trim();
    const secondaryText = String(structured?.secondaryText?.text ?? "").trim();
    if (!mainText) continue;
    out.push({ placeId, mainText, secondaryText });
  }
  return out;
}

/** A parsed details response: the address columns, and the unit as a sentence. */
export function readPlaceDetails(payload: unknown): PickedAddress {
  const place = payload as { addressComponents?: PlaceComponent[]; formattedAddress?: string };
  const components = Array.isArray(place?.addressComponents) ? place.addressComponents : [];
  return withFormattedAddress(addressFromPlaceComponents(components), place?.formattedAddress);
}

/**
 * Why a Places call failed, in a sentence that can be shown to an operator.
 *
 * Google's status names the real cause in a way the console matches — the API
 * disabled on the key, a referrer the key does not allow, a quota. The message
 * is trimmed and the body is never echoed wholesale: a response that did not
 * parse could contain anything, and this string is rendered.
 */
export function placesFailure(status: number, payload: unknown): { status: number; message: string } {
  const error = (payload as { error?: { message?: string; status?: string } })?.error;
  const message = String(error?.message ?? "").trim().slice(0, 240);
  return {
    status,
    message: message || `Google returned HTTP ${status}.`,
  };
}

/**
 * A rejected key is not retried on every keystroke.
 *
 * A 400/403 from Places is a statement about the key, the API enablement or the
 * referrer — none of which typing changes. Retrying turns one misconfiguration
 * into a request per character, so the entry aid stops asking and the page says
 * what happened.
 */
export function isPermanentPlacesFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}
