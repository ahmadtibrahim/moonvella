/**
 * The address entry aid: Google's suggestions, read and offered.
 *
 * WHAT THIS SUITE CAN PROVE, AND WHAT IT CANNOT. Google is never contacted. The
 * session checks drive `createSuggestionSession` with a stubbed `fetch` that
 * answers with the response shapes the Places API documents — including the way
 * a real `fetch` rejects an aborted request — so a PASS is evidence about this
 * code: the requests it builds, the components it reads, the token it reuses,
 * and the requests it declines to make. It is NOT evidence that Places works,
 * that a key is enabled, or that a referrer restriction is right. Those are
 * console-side facts, and the report that follows a run says so rather than
 * implying them.
 *
 * WHY IT IS PURE. No database, no fixture, no network. The parser, the request
 * builders and the session are all pure, and the two pages are checked by
 * reading them — the application page is `.jsx`, which this build never
 * typechecks, so reading it is the only automated check it gets. Comments are
 * stripped before every source assertion, because a rule written in a comment is
 * not code, and this repository has already had a suite pass on its own
 * explanation of a change rather than on the change.
 *
 * THE TWO THINGS IT IS REALLY ABOUT. That a suggestion can never reach Street 2
 * — the unit decides which door a carrier is sent to — and that taking one is
 * never reported as verification. Both are asserted by absence as well as by
 * presence: no `addressLine2` on the suggestion type, no target input for the
 * unit, and not one sentence anywhere that a merchant reads which claims a
 * suggestion was checked.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLACES_AUTOCOMPLETE_URL,
  PLACES_DETAILS_FIELD_MASK,
  addressFromPlaceComponents,
  autocompleteRequest,
  detailsRequest,
  isPermanentPlacesFailure,
  newSessionToken,
  placesFailure,
  readPlaceDetails,
  readSuggestions,
  type PlaceComponent,
} from "../app/utils/placesAddress";
import { createSuggestionSession } from "../app/utils/placesEntryAid";
import {
  ADDRESS_FIELDS,
  contactEmailNote,
  contactEmailPrefill,
  isMerchantOwnedSource,
} from "../app/utils/applicationFields";
import { SUGGESTION_TARGET_INPUTS } from "../app/utils/originFields";
import { explainSource } from "../app/services/shopProfile.server";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function readSource(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

const APP_SOURCE = (relative: string) => readSource(join("app", relative));

/**
 * Source with comments removed.
 *
 * Every source assertion below is about what the code does. These modules carry
 * long explanations — the house style here — and an explanation that happens to
 * contain the word being searched for would make a check pass with the behaviour
 * absent.
 */
function clean(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * True when a text never claims a check happened.
 *
 * "Not verified" and "does not verify" are the honest sentences this app is
 * supposed to print, so the words themselves cannot be forbidden — what is
 * forbidden is an unnegated one. Every sentence mentioning verification has to
 * deny it.
 */
function deniesVerification(text: string): boolean {
  const sentences = text.match(/[^.!?]*\bverif\w*[^.!?]*/gi) ?? [];
  return sentences.every((sentence) => /\b(not|never|no|nobody|neither)\b/i.test(sentence));
}

/* -------------------------------------------------------------------------- */
/* 1. Google's components, read into columns                                  */
/* -------------------------------------------------------------------------- */

/** The Places API (New) shape. */
const NEW_API: PlaceComponent[] = [
  { longText: "7A", shortText: "7A", types: ["subpremise"] },
  { longText: "994", shortText: "994", types: ["street_number"] },
  { longText: "Westport Crescent", shortText: "Westport Cres", types: ["route"] },
  { longText: "Mississauga", shortText: "Mississauga", types: ["locality", "political"] },
  { longText: "Ontario", shortText: "ON", types: ["administrative_area_level_1", "political"] },
  { longText: "L5T 1G1", shortText: "L5T 1G1", types: ["postal_code"] },
  { longText: "Canada", shortText: "CA", types: ["country", "political"] },
];

/** The same record as an older client spells it. */
const LEGACY_API: PlaceComponent[] = [
  { long_name: "7A", short_name: "7A", types: ["subpremise"] },
  { long_name: "994", short_name: "994", types: ["street_number"] },
  { long_name: "Westport Crescent", short_name: "Westport Cres", types: ["route"] },
  { long_name: "Mississauga", short_name: "Mississauga", types: ["locality"] },
  { long_name: "Ontario", short_name: "ON", types: ["administrative_area_level_1"] },
  { long_name: "L5T 1G1", short_name: "L5T 1G1", types: ["postal_code"] },
  { long_name: "Canada", short_name: "CA", types: ["country"] },
];

function componentsSection() {
  const parsed = addressFromPlaceComponents(NEW_API);

  check(
    "1 the five address columns come back filled, one value each",
    parsed.fields.addressLine1 === "994 Westport Crescent" &&
      parsed.fields.addressCity === "Mississauga" &&
      parsed.fields.addressProvinceCode === "ON" &&
      parsed.fields.addressPostalCode === "L5T 1G1" &&
      parsed.fields.addressCountryCode === "CA",
    JSON.stringify(parsed.fields)
  );

  check(
    "2 and the unit is reported as a sentence rather than written into a field",
    parsed.unitHint === "Unit 7A" &&
      !Object.values(parsed.fields).some((value) => /7A/.test(String(value))),
    String(parsed.unitHint)
  );

  check(
    "3 the suggestion type cannot express Street 2 at all",
    !Object.prototype.hasOwnProperty.call(parsed.fields, "addressLine2") &&
      Object.keys(parsed.fields).every((key) =>
        [
          "addressLine1",
          "addressCity",
          "addressProvinceCode",
          "addressPostalCode",
          "addressCountryCode",
        ].includes(key)
      ),
    Object.keys(parsed.fields).join(", ")
  );

  const legacy = addressFromPlaceComponents(LEGACY_API);
  check(
    "4 an older response spelling reads the same as the current one",
    JSON.stringify(legacy.fields) === JSON.stringify(parsed.fields),
    JSON.stringify(legacy.fields)
  );

  // A city-only prediction. A partial answer has to stay partial, or choosing
  // one would blank the street the operator had already typed.
  const partial = addressFromPlaceComponents([
    { longText: "Mississauga", shortText: "Mississauga", types: ["locality"] },
    { longText: "Ontario", shortText: "ON", types: ["administrative_area_level_1"] },
  ]);
  check(
    "5 a partial answer fills only what Google answered with",
    Object.keys(partial.fields).length === 2 &&
      partial.fields.addressCity === "Mississauga" &&
      partial.fields.addressLine1 === undefined &&
      partial.fields.addressPostalCode === undefined,
    JSON.stringify(partial.fields)
  );

  // Google uses different types for a settlement depending on the record. Which
  // one wins is a decision, so it is asserted rather than assumed.
  const town = addressFromPlaceComponents([
    {
      longText: "Rural Municipality of X",
      shortText: "RM X",
      types: ["administrative_area_level_2"],
    },
    { longText: "Village of Y", shortText: "Y", types: ["postal_town"] },
  ]);
  check(
    "6 the city falls back through Google's settlement types in a fixed order",
    town.fields.addressCity === "Village of Y",
    String(town.fields.addressCity)
  );

  const spelledOut = addressFromPlaceComponents([
    { longText: "Quebec", shortText: "", types: ["administrative_area_level_1"] },
    { longText: "Canada", shortText: "", types: ["country"] },
  ]);
  check(
    "7 a province with no short form is stored as Google wrote it, not mapped through a table this app would keep",
    spelledOut.fields.addressProvinceCode === "Quebec" &&
      spelledOut.fields.addressCountryCode === "Canada",
    `${spelledOut.fields.addressProvinceCode} / ${spelledOut.fields.addressCountryCode}`
  );

  const details = readPlaceDetails({
    addressComponents: NEW_API,
    formattedAddress: "994 Westport Crescent, Mississauga, ON L5T 1G1, Canada",
  });
  check(
    "8 the details response parses through the same code, and its display text never lands in a column",
    details.fields.addressLine1 === "994 Westport Crescent" &&
      details.formattedAddress === "994 Westport Crescent, Mississauga, ON L5T 1G1, Canada" &&
      !Object.values(details.fields).includes(details.formattedAddress ?? ""),
    String(details.formattedAddress)
  );
}

/* -------------------------------------------------------------------------- */
/* 2. What is sent                                                            */
/* -------------------------------------------------------------------------- */

function requestSection() {
  const key = "AIzaTESTKEY0000000000000000000000000";
  const token = "session-token-1";
  const { url, init } = autocompleteRequest(key, "994 Westport", token);
  const headers = (init.headers ?? {}) as Record<string, string>;
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;

  check(
    "9 autocomplete posts to Places, pins the country, and carries the session",
    url === PLACES_AUTOCOMPLETE_URL &&
      init.method === "POST" &&
      Array.isArray(body.includedRegionCodes) &&
      body.includedRegionCodes[0] === "ca" &&
      body.input === "994 Westport" &&
      body.sessionToken === token,
    url
  );

  check(
    "10 the key travels in a header, never in the URL that history and referrers keep",
    headers["X-Goog-Api-Key"] === key && !url.includes(key) && !url.includes("key="),
    url.includes(key) ? "the key is in the URL" : "header only"
  );

  const pick = detailsRequest(key, "ChIJ5YQQf1GHhYARPKG7WLIaOko", token);
  const pickHeaders = (pick.init.headers ?? {}) as Record<string, string>;
  check(
    "11 the details call asks for exactly its two fields and reuses the same session",
    pick.url.startsWith("https://places.googleapis.com/v1/places/ChIJ5YQQf1GHhYARPKG7WLIaOko") &&
      pick.url.includes(`sessionToken=${token}`) &&
      pickHeaders["X-Goog-FieldMask"] === PLACES_DETAILS_FIELD_MASK &&
      PLACES_DETAILS_FIELD_MASK === "addressComponents,formattedAddress",
    pickHeaders["X-Goog-FieldMask"] ?? ""
  );

  const escaped = detailsRequest(key, "places/../evil", token);
  check(
    "12 a place id cannot reshape the request path",
    !escaped.url.includes("places/..") && escaped.url.includes("places%2F..%2Fevil"),
    escaped.url
  );

  const tokens = new Set([newSessionToken(), newSessionToken(), newSessionToken()]);
  check("13 each entry session gets its own token", tokens.size === 3, `${tokens.size} distinct`);

  const suggestions = readSuggestions({
    suggestions: [
      {
        placePrediction: {
          placeId: "ChIJ1",
          text: { text: "994 Westport Cres, Mississauga, ON, Canada" },
          structuredFormat: {
            mainText: { text: "994 Westport Cres" },
            secondaryText: { text: "Mississauga, ON, Canada" },
          },
        },
      },
      // A typed query rather than a place: it has no id and cannot be resolved,
      // so offering it would put a row in the list that does nothing when picked.
      { queryPrediction: { text: { text: "pillow suppliers" } } },
      { placePrediction: { text: { text: "no id here" } } },
    ],
  });
  check(
    "14 a suggestion with no place id is dropped rather than offered",
    suggestions.length === 1 &&
      suggestions[0].placeId === "ChIJ1" &&
      suggestions[0].mainText === "994 Westport Cres" &&
      suggestions[0].secondaryText === "Mississauga, ON, Canada",
    JSON.stringify(suggestions)
  );

  const plain = readSuggestions({
    suggestions: [{ placePrediction: { placeId: "ChIJ2", text: { text: "Somewhere" } } }],
  });
  check(
    "15 a suggestion without the structured pair still shows its text",
    plain.length === 1 && plain[0].mainText === "Somewhere",
    JSON.stringify(plain)
  );

  const failure = placesFailure(403, {
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Places API (New) has not been used in project 43 before or it is disabled.",
    },
  });
  check(
    "16 a refusal is reported with Google's own reason, and a bad key is not retried while a busy server is",
    failure.message.startsWith("Places API (New) has not been used") &&
      isPermanentPlacesFailure(403) &&
      isPermanentPlacesFailure(400) &&
      !isPermanentPlacesFailure(500) &&
      !isPermanentPlacesFailure(429),
    failure.message.slice(0, 60)
  );

  const huge = placesFailure(500, { error: { message: "x".repeat(2000) } });
  check(
    "17 an oversized failure body is trimmed rather than rendered whole",
    huge.message.length <= 240,
    `${huge.message.length} chars`
  );
}

/* -------------------------------------------------------------------------- */
/* 3. The session, driven with a stubbed network                              */
/* -------------------------------------------------------------------------- */

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * A stubbed fetch that records what was asked for.
 *
 * It emulates the one piece of real `fetch` semantics this code depends on: an
 * already-aborted signal rejects with an AbortError rather than returning a
 * response. A stub that answered normally would make the "a superseded keystroke
 * is not a failure" check pass against code that never handled aborts at all.
 */
function stubFetch(handler: (call: Call) => { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const signal = (init?.signal ?? null) as AbortSignal | null;
    if (signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const AUTOCOMPLETE_OK = {
  status: 200,
  body: {
    suggestions: [
      {
        placePrediction: {
          placeId: "ChIJ1",
          structuredFormat: {
            mainText: { text: "994 Westport Cres" },
            secondaryText: { text: "Mississauga" },
          },
        },
      },
    ],
  },
};

const DETAILS_OK = {
  status: 200,
  body: { addressComponents: NEW_API, formattedAddress: "994 Westport Crescent" },
};

async function sessionSection() {
  // --- one session per address -------------------------------------------
  const { fetchImpl, calls } = stubFetch((call) =>
    call.url.includes(":autocomplete") ? AUTOCOMPLETE_OK : DETAILS_OK
  );
  const session = createSuggestionSession({ apiKey: "AIzaTEST", fetchImpl });

  const first = await session.search("994 Westport");
  const second = await session.search("994 Westport Cres");
  const firstToken = JSON.parse(String(calls[0].init.body)).sessionToken as string;
  const secondToken = JSON.parse(String(calls[1].init.body)).sessionToken as string;

  check(
    "18 typing reuses one session token, which is what makes a lookup bill once",
    first.ok && second.ok && firstToken === secondToken && firstToken.length > 8,
    firstToken === secondToken ? "one token across keystrokes" : "tokens differ"
  );

  const picked = await session.pick("ChIJ1");
  const detailsToken = calls[2].url.split("sessionToken=")[1] ?? "";
  check(
    "19 the choice consumes that session, and the components come back parsed",
    picked.ok &&
      picked.value.fields.addressLine1 === "994 Westport Crescent" &&
      picked.value.unitHint === "Unit 7A" &&
      detailsToken === firstToken,
    detailsToken === firstToken ? "same token on the details call" : "token changed early"
  );

  await session.search("994 Westport");
  const thirdToken = JSON.parse(String(calls[3].init.body)).sessionToken as string;
  check(
    "20 the next address is a new session, because the last one ended at the choice",
    thirdToken !== firstToken,
    thirdToken === firstToken ? "token reused after a pick" : "rotated"
  );

  // --- a refused key stops the asking -------------------------------------
  const refused = stubFetch(() => ({
    status: 403,
    body: {
      error: { status: "PERMISSION_DENIED", message: "API key not valid. Please pass a valid API key." },
    },
  }));
  const blocked = createSuggestionSession({ apiKey: "AIzaWRONG", fetchImpl: refused.fetchImpl });
  const denied = await blocked.search("994 Westport");
  const afterDenial = await blocked.search("994 Westport Cres");
  check(
    "21 a refused key is reported, and then not retried once per keystroke",
    denied.ok === false &&
      /API key not valid/.test(denied.reason) &&
      blocked.stopped === true &&
      afterDenial.ok === false &&
      refused.calls.length === 1,
    `${refused.calls.length} request(s) made for 2 searches`
  );

  // --- a blip is not a refusal -------------------------------------------
  const flaky = stubFetch(() => ({ status: 503, body: { error: { message: "Backend unavailable" } } }));
  const flakySession = createSuggestionSession({ apiKey: "AIzaTEST", fetchImpl: flaky.fetchImpl });
  const blip = await flakySession.search("994 Westport");
  check(
    "22 a temporary failure is reported as one failure, not as a dead key",
    blip.ok === false && flakySession.stopped === false && flakySession.failure !== null,
    String(flakySession.failure)
  );

  // --- success clears the record ------------------------------------------
  let attempt = 0;
  const recovering = stubFetch(() => {
    attempt += 1;
    return attempt === 1 ? { status: 503, body: { error: { message: "Backend unavailable" } } } : AUTOCOMPLETE_OK;
  });
  const recoveringSession = createSuggestionSession({
    apiKey: "AIzaTEST",
    fetchImpl: recovering.fetchImpl,
  });
  await recoveringSession.search("994");
  const recovered = await recoveringSession.search("994 Westport");
  check(
    "23 a later success clears the failure that was recorded",
    recovered.ok === true && recoveringSession.failure === null,
    String(recoveringSession.failure)
  );

  // --- an abort is the operator still typing ------------------------------
  const aborted = stubFetch(() => AUTOCOMPLETE_OK);
  const abortedSession = createSuggestionSession({
    apiKey: "AIzaTEST",
    fetchImpl: aborted.fetchImpl,
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await abortedSession.search("994", controller.signal);
  check(
    "24 a superseded keystroke is not recorded as a failure",
    cancelled.ok === false &&
      cancelled.reason === "aborted" &&
      abortedSession.failure === null &&
      abortedSession.stopped === false,
    cancelled.ok === false ? cancelled.reason : "reported as ok"
  );

  // --- an unreachable Google is not a misconfigured key --------------------
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  const offlineSession = createSuggestionSession({ apiKey: "AIzaTEST", fetchImpl: offline });
  const unreachable = await offlineSession.search("994 Westport");
  check(
    "25 a network failure says the service is unreachable instead of blaming the key",
    unreachable.ok === false &&
      /could not be reached/.test(unreachable.reason) &&
      offlineSession.stopped === false,
    unreachable.ok === false ? unreachable.reason.slice(0, 60) : "reported as ok"
  );
}

/* -------------------------------------------------------------------------- */
/* 4. The pages that use it                                                   */
/* -------------------------------------------------------------------------- */

function pageSection() {
  const application = clean(APP_SOURCE("routes/app.application.jsx"));
  const origins = clean(APP_SOURCE("routes/admin.origins.tsx"));
  const entryAid = clean(APP_SOURCE("utils/placesEntryAid.ts"));
  const entryAidRaw = APP_SOURCE("utils/placesEntryAid.ts");

  check(
    "26 the application offers the page the browser key and nothing else",
    /browserKeyForPlaces\(\)/.test(application) &&
      /placesBrowserKey/.test(application) &&
      !/GOOGLE_MAPS_SERVER_KEY/.test(application),
    "the server key is not reachable from this page"
  );

  check(
    "27 no page renders the aid without a key, so the fields are what they were when Google is unconfigured",
    /field\.key === "addressLine1" && placesBrowserKey/.test(application) &&
      /\{browserKey \? \(/.test(origins),
    "conditional on the key in both pages"
  );

  /*
   * Unconfigured is a state the page has to NAME.
   *
   * With no key the aid is inert by design, and the page said nothing at all:
   * the street field became an ordinary text box that offered no suggestions and
   * gave no reason. A missing entry aid and a broken one look identical from
   * there, and the merchant — who can fix neither — is the one person looking at
   * it. So the aid staying inert is check 27's job; saying why is this one's.
   */
  const noticeAt = application.indexOf("Address suggestions are switched off");
  const unconfiguredNotice = application.slice(Math.max(0, noticeAt - 300), noticeAt + 400);
  check(
    "27.1 with no browser key the page says suggestions are off instead of looking like a field that does nothing",
    unconfiguredNotice.length > 40 &&
      /role="status"/.test(unconfiguredNotice) &&
      /placesBrowserKey \?/.test(application) &&
      !/GOOGLE_MAPS_BROWSER_KEY/.test(application),
    "the operator-facing key name is not the merchant's problem, and is not printed"
  );

  check(
    "28 choosing a suggestion marks the columns it filled, and typing in one clears the mark",
    /payload\.set\(`source_\$\{field\.key\}`, "GOOGLE"\)/.test(application) &&
      /if \(googleFields\[field\.key\]\)/.test(application) &&
      /setGoogleFields\(\(prev\) => \(prev\[field\] \?/.test(application),
    "source_ markers travel with the value"
  );

  check(
    "29 the fill loop writes only what a suggestion can carry, and Street 2 is not among them",
    /const keys = Object\.keys\(picked\.fields\)/.test(application) &&
      /for \(const key of keys\) next\[key\] = picked\.fields\[key\]/.test(application) &&
      Object.keys(SUGGESTION_TARGET_INPUTS).join(",") ===
        "addressLine1,addressCity,addressProvinceCode,addressPostalCode,addressCountryCode" &&
      Object.values(SUGGESTION_TARGET_INPUTS).join(",") ===
        "street1,city,province,postalCode,country",
    Object.entries(SUGGESTION_TARGET_INPUTS)
      .map(([from, to]) => `${from}->${to}`)
      .join(", ")
  );

  check(
    "30 the unit is reported in both pages instead of being written",
    /unitHint/.test(application) &&
      /Street 2 is left as you typed it/.test(application) &&
      /unitHint/.test(origins) &&
      /left as you typed it/.test(origins),
    "reported, never filled"
  );

  check(
    "31 the admin form posts natively, so a pick writes by name and cannot reach another field",
    /formRef/.test(origins) &&
      /form\.elements\.namedItem\(String\(target\)\)/.test(origins) &&
      /instanceof HTMLInputElement/.test(origins) &&
      /SUGGESTION_TARGET_INPUTS/.test(origins),
    "named lookup only"
  );

  check(
    "31.1 a long-form country from a suggestion lands on the matching option instead of emptying the select",
    // The country control is a list of two-letter codes; the aid can carry
    // "Canada" when Google's record has no short form. A select assigned a value
    // no option holds ends up with nothing selected, so the field would post
    // empty — the pick would blank the country the dock is in. Both pages
    // therefore fold the value through the same list the options come from.
    /target === "country" \? countryValue\(next\) : next/.test(origins) &&
      /value=\{countryValue\(addressValues\[field\.key\]\)\}/.test(application) &&
      /countryOptions\(addressValues\[field\.key\]\)/.test(application),
    "folded through the option list on both pages"
  );

  check(
    "32 both pages destroy the aid, so no listener outlives the form it was attached to",
    /return \(\) => aid\.destroy\(\);/.test(application) &&
      /return \(\) => aid\.destroy\(\);/.test(origins),
    "destroy on unmount"
  );

  check(
    "33 the list is built from text, never from markup that arrived over the network",
    /textContent = suggestion\.mainText/.test(entryAid) &&
      !/innerHTML/.test(entryAid) &&
      !/insertAdjacentHTML/.test(entryAid),
    "textContent"
  );

  check(
    "34 the aid never writes to the field it listens to, and is inert without a key",
    !/input\.value\s*=[^=]/.test(entryAid) &&
      /if \(!browserKey\) return undefined;/.test(origins) &&
      /never writes to it/.test(entryAidRaw),
    "listens, does not write"
  );

  check(
    "35 the entry aid cannot set a verdict: nothing on this path reaches the validation module",
    !/addressValidation/.test(clean(APP_SOURCE("utils/placesAddress.ts"))) &&
      !/addressValidation/.test(entryAid) &&
      !/\bverdict\b/i.test(clean(APP_SOURCE("utils/placesAddress.ts"))) &&
      !/\bverdict\b/i.test(entryAid),
    "no verdict path from a suggestion"
  );

  check(
    "36 no key material is pasted into a module, and Odoo's geolocate key is not reachable",
    !/AIza[A-Za-z0-9_-]{10,}/.test(APP_SOURCE("utils/placesAddress.ts")) &&
      !/AIza[A-Za-z0-9_-]{10,}/.test(entryAidRaw) &&
      !/google_maps_api_key/.test(APP_SOURCE("utils/placesAddress.ts")) &&
      !/google_maps_api_key/.test(entryAidRaw),
    "no key in client code"
  );

  check(
    "37 not one sentence on either page claims anything was verified",
    deniesVerification(application) &&
      deniesVerification(origins) &&
      /This is an entry aid, not a check/.test(application),
    "every mention of verification denies it"
  );
}

/* -------------------------------------------------------------------------- */
/* 5. What the operator is told                                               */
/* -------------------------------------------------------------------------- */

function copySection() {
  const googleNote = explainSource("GOOGLE");
  check(
    "38 a chosen suggestion is described as where the value came from, never as a verification",
    /Google address suggestion/.test(googleNote) &&
      /does not verify/.test(googleNote) &&
      deniesVerification(googleNote),
    googleNote
  );

  const merchantNote = explainSource("MERCHANT");
  check(
    "39 and a refresh is told to leave both of them alone",
    isMerchantOwnedSource("MERCHANT") &&
      isMerchantOwnedSource("GOOGLE") &&
      !isMerchantOwnedSource("SHOPIFY") &&
      !isMerchantOwnedSource(null) &&
      !isMerchantOwnedSource(undefined) &&
      /will not overwrite it/.test(merchantNote),
    "MERCHANT | GOOGLE belong to the merchant"
  );

  const rows: {
    application: { email?: string | null } | null;
    imported: { values?: Record<string, string | null> } | null;
    expected: string;
  }[] = [
    { application: { email: "a@b.c" }, imported: { values: {} }, expected: "ANSWER" },
    {
      application: null,
      imported: { values: { storeOwnerEmail: "owner@shop" } },
      expected: "OWNER",
    },
    {
      application: null,
      imported: { values: { storeContactEmail: "hello@shop" } },
      expected: "STORE",
    },
    { application: null, imported: { values: {} }, expected: "NONE" },
    // The seed's own fallback order, so the note cannot name a mailbox the
    // value did not come from.
    {
      application: null,
      imported: { values: { storeOwnerEmail: "owner@shop", storeContactEmail: "hello@shop" } },
      expected: "OWNER",
    },
  ];
  const prefills = rows.map((row) => contactEmailPrefill(row.application, row.imported));
  check(
    "40 the contact email note names the mailbox the value actually came from",
    rows.every((row, index) => prefills[index] === row.expected),
    prefills.join(", ")
  );

  const notes = [
    contactEmailNote("ANSWER"),
    contactEmailNote("OWNER"),
    contactEmailNote("STORE"),
    contactEmailNote("NONE"),
  ];
  check(
    "41 the three prefill notes are four different sentences, each naming its mailbox",
    new Set(notes).size === 4 &&
      /private and is not the one your storefront publishes/.test(contactEmailNote("OWNER")) &&
      /public contact email/.test(contactEmailNote("STORE")) &&
      /returned no email address/.test(contactEmailNote("NONE")) &&
      notes.every(deniesVerification),
    "four distinct, none claiming a check"
  );

  check(
    "42 the required set is one list: five address columns required, Street 2 and the tax number optional",
    ADDRESS_FIELDS.filter((field) => field.required)
      .map((field) => field.key)
      .join(",") === "addressLine1,addressCity,addressProvinceCode,addressPostalCode,addressCountryCode" &&
      ADDRESS_FIELDS.find((field) => field.key === "addressLine2")?.required === false,
    `${ADDRESS_FIELDS.filter((field) => field.required).length} required, ${ADDRESS_FIELDS.filter((field) => !field.required).length} optional`
  );
}

/* -------------------------------------------------------------------------- */
/* 6. Saving a draft is not submitting                                        */
/* -------------------------------------------------------------------------- */

function draftSection() {
  const application = clean(APP_SOURCE("routes/app.application.jsx"));

  check(
    "43 the button decides the intent, read from the event rather than from a re-render",
    /nativeEvent\?\.submitter\?\.getAttribute\("value"\) === "save"/.test(application) &&
      /name="intent"\s+value="save"/.test(application) &&
      /name="intent"\s+value="submit"/.test(application),
    "submitter value"
  );

  check(
    "44 an incomplete draft saves, and the required fields are enforced on the submission",
    /const savingDraft = intent === "save";/.test(application) &&
      /const errors = \{\};\s*if \(!savingDraft\) \{/.test(application) &&
      /errors\.legalBusinessName = "Legal business name is required\."/.test(application) &&
      /errors\[field\.key\] = `\$\{field\.label\} is required\.`/.test(application),
    "validation gated on the intent"
  );

  check(
    "45 a saved draft is not marked as submitted, and is not moved through the review queue",
    /submittedAt: savingDraft \? null : new Date\(\)/.test(application) &&
      /if \(\s*!savingDraft &&/.test(application),
    "submittedAt is the draft marker"
  );

  check(
    "46 the answer says which of the two happened, and the audit records them apart",
    /return savingDraft\s*\?\s*\{ ok: true, draft: true \}/.test(application) &&
      /\{ ok: true, submitted: true, status: saved\.status \};/.test(application) &&
      /const draftSaved = fetcher\.data\?\.draft === true;/.test(application) &&
      /const submitted = fetcher\.data\?\.submitted === true;/.test(application) &&
      /googleSuggested:/.test(application) &&
      /draft: savingDraft,/.test(application),
    "draft vs submitted"
  );

  check(
    "47 a draft is not announced as an application under review",
    /Saved\. You can finish your application later\./.test(application) &&
      /Application submitted\. MoonVella will review your store/.test(application),
    "two different sentences"
  );

  check(
    "48 the form states the requirement before the request leaves, from the same list the server enforces",
    /if \(pressed === "submit"\) \{\s*const missing = \{\};/.test(application) &&
      /for \(const field of ADDRESS_FIELDS\) \{\s*if \(field\.required && !String\(addressValues\[field\.key\]/.test(
        application
      ) &&
      /setLocalErrors\(missing\);/.test(application) &&
      /if \(Object\.keys\(missing\)\.length > 0\) return;/.test(application) &&
      /setLocalErrors\(\{\}\);/.test(application),
    "one required list, checked on both sides"
  );

  /*
   * A native `required` attribute would be blocked by the browser before the
   * submit event fires, which would take the draft button with it: the one
   * control a merchant presses when the form is incomplete is the one the
   * browser would refuse to send. The slice is the address block itself, so the
   * assertion is about those inputs rather than about the word appearing
   * somewhere in the file.
   */
  const addressBlock = application.slice(
    application.indexOf("{ADDRESS_FIELDS.map((field) => {"),
    application.indexOf("Clear and re-import this field")
  );
  check(
    "49 no native required attribute sits on an address input, so a draft is never blocked by the browser",
    addressBlock.length > 200 && !/required/.test(addressBlock.replace(/field\.required/g, "")),
    `${addressBlock.length} chars of address JSX, no native required`
  );

  check(
    "50 the refresh path leaves a Google-chosen value alone, and clearing a field still re-imports it",
    /const overridden = isMerchantOwnedSource\(storedSources\[key\]\)/.test(application) &&
      /if \(overridden && onlyField !== key\) continue;/.test(application),
    "isMerchantOwnedSource in the refresh loop"
  );

  /*
   * The write itself, read as one block rather than as a word somewhere in the
   * file.
   *
   * Check 45 above pins the create branch — and it passed for a whole wave while
   * the update branch, which is the branch a submission actually takes, wrote
   * every answer and left `submittedAt` alone. A merchant was told "Application
   * Submitted"; the row stayed a draft; the owner's queue reads
   * `submittedAt IS NOT NULL` and showed nothing. So the assertions below are
   * about the branch that runs, not about the marker existing.
   */
  const writeAt = application.indexOf(
    "const saved = await prisma.merchantApplication.upsert({"
  );
  const write = application.slice(
    writeAt,
    // The audit that follows the write, so the slice is this one call. The
    // anchor is `const saved = …` rather than the call alone because the LOADER
    // upserts the imported profile on the same table, and the first match would
    // have been that one — a slice of the wrong branch, passing on the wrong
    // code.
    application.indexOf("const { recordAudit, AUDIT_ENTITY }", writeAt)
  );

  check(
    "51 a submission marks an existing row as submitted, because every submission arrives on an existing row",
    write.length > 100 &&
      /create:\s*\{[^}]*submittedAt:\s*savingDraft\s*\?\s*null\s*:\s*new Date\(\)/.test(write) &&
      /update:\s*savingDraft\s*\?\s*data\s*:\s*\{[^}]*submittedAt:/.test(write),
    `${write.length} chars of upsert, both branches carry the marker`
  );

  check(
    "52 and the date a reviewer reads is the first submission's, not the latest edit's",
    /submittedAt:\s*existing\?\.submittedAt\s*\?\?\s*new Date\(\)/.test(write),
    "an existing value is kept"
  );

  check(
    "53 the answers object carries no submittedAt, so a draft save cannot mark a row by carrying it in",
    (() => {
      const answers = application.slice(
        application.indexOf("const data = {"),
        application.indexOf("const saved = await prisma.merchantApplication.upsert(")
      );
      return answers.length > 100 && !/submittedAt/.test(answers);
    })(),
    "only the two branches that decide the intent write it"
  );
}

async function main() {
  componentsSection();
  requestSection();
  await sessionSection();
  pageSection();
  copySection();
  draftSection();

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  return failures;
}

main()
  .then((failed) => {
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
