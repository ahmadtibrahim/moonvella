/**
 * What the two Google keys actually do, asked of Google rather than of the store.
 *
 * WHY THIS IS TWO CHECKS AND NOT ONE. The integration holds two credentials that
 * are not interchangeable, they are used by different code on different sides of
 * the network, and they fail for different reasons with different fixes:
 *
 *   * The BROWSER key is handed to a page. It is public by construction, its
 *     safety is its HTTP-referrer restriction, and it is only useful for Places
 *     autocomplete. If it fails, the address form stops helping — the operator
 *     sees a form that still accepts typing.
 *   * The SERVER key is never sent to a browser, it is restricted by IP, and it
 *     is the only thing that can produce an address verdict. If it fails, the
 *     booking gate stays shut.
 *
 * A single "Google: FAILED" would name neither the credential nor the fix, and
 * would be wrong in the common case where exactly one of the two is broken —
 * which is the case this module was written for. So each is probed and reported
 * on its own line.
 *
 * WHAT "VERIFIED" MEANS HERE, AND WHAT IT DOES NOT. Both probes are real calls to
 * Google with the stored value. The browser probe sends the request through the
 * SAME builder the page uses (`autocompleteRequest`) and adds the `Referer` a
 * browser on that origin would send, so what it proves is exactly: Google
 * accepted this key for a request claiming to come from this origin. It does NOT
 * prove the widget renders, and nothing here claims it does. The server probe is
 * a real `validateAddress` call, so a pass means the key can actually produce a
 * verdict. Neither probe reports a saved value as working, and a value that is
 * merely present is reported as present.
 *
 * COST. Places Autocomplete is billed per request and Address Validation per
 * successful validation. The probes are deliberately minimal — one short
 * autocomplete query per surface, and one validation of a fixed address — and
 * they run only from an operator's Test connection or a credential save, never
 * from a page render. A refused key is not a successful call and is not billed.
 */

import { getCredential, redactSecrets } from "./credentials.server";
import { autocompleteRequest, newSessionToken } from "~/utils/placesAddress";

const BROWSER_KEY_FIELD = "GOOGLE_MAPS_BROWSER_KEY";
const SERVER_KEY_FIELD = "GOOGLE_MAPS_SERVER_KEY";

const ADDRESS_VALIDATION_ENDPOINT = "https://addressvalidation.googleapis.com/v1:validateAddress";

/** Long enough for a slow provider, short enough that a hung one still answers. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The address the server key is proved with.
 *
 * Fixed, and deliberately not read from configuration. The probe is a question
 * about the KEY — "will Google accept this credential and answer?" — and an
 * address that came from a setting would make a bad setting look like a bad key.
 * This one is a real Canadian address; whether Google ACCEPTS it is not the
 * point, only that it answers at all. A verdict of CONFIRMATION_REQUIRED is a
 * pass here, because Google answered.
 */
const PROBE_ADDRESS = {
  regionCode: "CA",
  addressLines: ["994 Westport Cres", "Unit 7A"],
  locality: "Mississauga",
  administrativeArea: "ON",
  postalCode: "L5T 1G1",
};

/** A short query. Long enough for suggestions, short enough to be cheap. */
const PROBE_QUERY = "994 Westport";

export interface GoogleCheckResult {
  status: string;
  /** Two lines, one per credential. Rendered with `pre-line`. */
  detail: string;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Wrong-kind values, caught while they are still in the operator's hands      */
/* -------------------------------------------------------------------------- */

/**
 * Why a value sitting in a Google key field is the wrong KIND of Google value.
 *
 * This is the same failure the Stripe secret field already guards against, and
 * it arrives the same way: the Google Cloud console shows a project's API keys,
 * its OAuth client ID and its OAuth client secret on pages an operator reaches
 * from one another, and the OAuth client ID in particular is the longest and
 * most key-shaped string on the credentials screen. Pasting it into an API-key
 * field produces a stored value, a "saved" badge, and a provider that answers
 * `API key not valid. Please pass a valid API key.` — which names neither the
 * field nor the mistake, and sends the operator to look for a problem in the
 * mapping, where there is none.
 *
 * Every API key Google issues begins `AIza`. That is the whole test, and it is
 * stated as a prefix rather than as an exact length because the length is
 * Google's business and a future format must not be refused by this app. The
 * value is never echoed — only the shape of it, which is what the console
 * already prints above it.
 */
export function googleKeyKindProblem(field: string, value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;

  const label = field === SERVER_KEY_FIELD ? "server key" : "browser key";

  if (trimmed.endsWith(".apps.googleusercontent.com")) {
    return (
      `The saved value in the ${label} field is an OAuth client ID, not an API key. ` +
      "Client IDs identify an application to Google Sign-In and cannot authenticate an API call. " +
      "Use the AIza… API key from Google Cloud → APIs & Services → Credentials."
    );
  }
  if (trimmed.startsWith("GOCSPX-")) {
    return (
      `The saved value in the ${label} field is an OAuth client secret, not an API key. ` +
      "It is the pair of an OAuth client ID and is used for sign-in, not for calling an API."
    );
  }
  if (trimmed.startsWith("ya29.")) {
    return (
      `The saved value in the ${label} field is an OAuth access token, not an API key. ` +
      "Access tokens expire within the hour; an API key does not expire and is what belongs here."
    );
  }
  if (trimmed.startsWith("-----BEGIN")) {
    return (
      `The saved value in the ${label} field is a PEM private key, not an API key. ` +
      "A service-account key file cannot be pasted into this field."
    );
  }
  if (!trimmed.startsWith("AIza")) {
    return (
      `The saved value in the ${label} field does not look like a Google API key: ` +
      "every key Google issues begins with AIza. Check that the whole key was copied — " +
      "the console's copy button, not a drag-select."
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The origins autocomplete is actually served from                           */
/* -------------------------------------------------------------------------- */

/** An origin in the form a browser would put in a `Referer`, e.g. `https://app.moonvella.com/`. */
function originOf(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return `${url.protocol}//${url.host}/`;
  } catch {
    return null;
  }
}

/**
 * The origins that render autocomplete, and therefore the referrers the browser
 * key must allow.
 *
 * These are the two surfaces that call `createAddressEntryAid`: the embedded
 * merchant app and the owner's pickup-address form. The deployment names both,
 * and they are read from configuration rather than written here because a host
 * that has moved is exactly the change that would silently invalidate a
 * referrer restriction.
 */
export function placesReferrers(): string[] {
  const candidates = [
    originOf(process.env.SHOPIFY_APP_URL),
    originOf(process.env.ADMIN_APP_URL),
    ...(process.env.APP_ALLOWED_HOSTS ?? "").split(",").map((host) => originOf(host)),
  ].filter((origin): origin is string => !!origin);
  return Array.from(new Set(candidates));
}

/* -------------------------------------------------------------------------- */
/* The two probes                                                             */
/* -------------------------------------------------------------------------- */

interface ProbeOutcome {
  ok: boolean;
  /** Google's own words when it refused, already redacted. */
  message: string | null;
  /** A short human note about what was asked, for the pass case. */
  note: string;
}

/**
 * Google's message for a failed call, made safe to store and render.
 *
 * Google's error body is written for a developer and is the single most useful
 * sentence in a failure — it distinguishes a disabled API from a referrer that
 * is not allowed from a key that does not exist, and those three have three
 * different fixes. It is quoted, but never verbatim: `redactSecrets` runs over
 * it first, because the Address Validation call carries its key in the query
 * string and a rejected request can be echoed back inside its own error.
 */
function googleMessage(payload: unknown, httpStatus: number): string {
  const error = (payload as { error?: { message?: string; status?: string } })?.error;
  const message = redactSecrets(String(error?.message ?? "").trim()).slice(0, 240);
  const name = String(error?.status ?? "").trim();
  if (!message) return `Google returned HTTP ${httpStatus}.`;
  return name ? `${message} (${name}, HTTP ${httpStatus})` : `${message} (HTTP ${httpStatus})`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** One live Places autocomplete call, carrying the referrer that origin would send. */
async function probeBrowserKeyAt(key: string, referrer: string): Promise<ProbeOutcome> {
  const request = autocompleteRequest(key, PROBE_QUERY, newSessionToken(), ["ca"]);
  let response: Response;
  try {
    response = await fetch(request.url, {
      ...request.init,
      // The browser's own referrer, which is what the key's restriction is
      // written against. Strict-origin means the browser sends only the origin,
      // so that is what is sent here — anything longer would be a request no
      // browser makes.
      headers: { ...(request.init.headers as Record<string, string>), Referer: referrer },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Google could not be reached from this server: ${
        error instanceof Error ? error.message : "network error"
      }.`,
      note: "",
    };
  }

  const payload = await readJson(response);
  if (!response.ok) return { ok: false, message: googleMessage(payload, response.status), note: "" };

  const suggestions = (payload as { suggestions?: unknown[] })?.suggestions;
  const count = Array.isArray(suggestions) ? suggestions.length : 0;
  return {
    ok: true,
    message: null,
    note: `${count} suggestion${count === 1 ? "" : "s"} returned`,
  };
}

/** One live Address Validation call — the only thing that proves the server key works. */
async function probeServerKey(key: string): Promise<ProbeOutcome> {
  let response: Response;
  try {
    response = await fetch(
      `${ADDRESS_VALIDATION_ENDPOINT}?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: PROBE_ADDRESS }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }
    );
  } catch (error) {
    return {
      ok: false,
      message: `Google could not be reached from this server: ${
        error instanceof Error ? error.message : "network error"
      }.`,
      note: "",
    };
  }

  const payload = await readJson(response);
  if (!response.ok) return { ok: false, message: googleMessage(payload, response.status), note: "" };

  const granularity = (payload as { result?: { verdict?: { validationGranularity?: string } } })?.result
    ?.verdict?.validationGranularity;
  return {
    ok: true,
    message: null,
    note: granularity
      ? `Google answered with a verdict (granularity ${granularity})`
      : "Google answered with a verdict",
  };
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                */
/* -------------------------------------------------------------------------- */

/** The value of a secret field as the STORE sees it, never as the page sees it. */
async function secretShape(field: string): Promise<string> {
  const value = await getCredential("google", field);
  if (!value) return "absent";
  return `present, ${value.trim().length} characters`;
}

/**
 * Probe both credentials and compose the two-line verdict.
 *
 * The overall status is chosen so the chip above the sentence is not misleading:
 *
 *   * A credential Google REFUSED is FAILED, whoever else passed — something is
 *     broken and there is a value to replace.
 *   * Nothing refused but something missing is NOT_CONFIGURED, because nothing
 *     is broken; a field is empty.
 *   * Both accepted is HEALTHY.
 *
 * The detail names each credential's own outcome, so a FAILED chip never hides
 * which half is fine.
 */
export async function checkGoogle(): Promise<GoogleCheckResult> {
  const [browserKey, serverKey] = await Promise.all([
    getCredential("google", BROWSER_KEY_FIELD),
    getCredential("google", SERVER_KEY_FIELD),
  ]);

  const referrers = placesReferrers();

  const [browserProbe, serverProbe] = await Promise.all([
    browserKey
      ? Promise.all(referrers.map((referrer) => probeBrowserKeyAt(browserKey, referrer)))
      : Promise.resolve(null),
    serverKey ? probeServerKey(serverKey) : Promise.resolve(null),
  ]);

  const error = browserProbe?.find((probe) => !probe.ok)?.message ?? serverProbe?.message ?? null;

  // --- browser autocomplete -------------------------------------------------
  let browserLine: string;
  let browserFailed = false;
  if (!browserKey) {
    browserLine =
      `Browser autocomplete: NOT SET — no ${BROWSER_KEY_FIELD} is saved, so address ` +
      "autocomplete renders nothing and the address has to be typed in full.";
  } else if (!referrers.length) {
    browserLine =
      "Browser autocomplete: NOT CHECKED — the deployment names no app or admin URL to " +
      "test the key's referrer restriction against, so the saved key was not verified and " +
      "is not reported as working.";
  } else {
    const results = browserProbe ?? [];
    const refused = results
      .map((probe, index) => ({ probe, referrer: referrers[index] }))
      .filter((entry) => !entry.probe.ok);
    browserFailed = refused.length > 0;

    if (!browserFailed) {
      browserLine =
        `Browser autocomplete: HEALTHY — Google accepted the browser key for a request ` +
        `carrying each of ${referrers.join(", ")} as its referrer (${results[0]?.note ?? "answered"}). ` +
        "This is an entry aid only: the key is refused by the Address Validation API, so it " +
        "cannot produce or influence a verdict.";
    } else {
      browserLine =
        `Browser autocomplete: FAILED — Google refused the browser key for ` +
        `${refused.map((entry) => entry.referrer).join(", ")}. ${refused[0]?.probe.message ?? ""} ` +
        "Autocomplete will not appear in that surface; typing still works. If the message names a " +
        "referrer, the key's HTTP-referrer restriction does not list that host — change the key in " +
        "the Google Cloud console, not the host.";
    }
  }

  // --- server address validation --------------------------------------------
  let serverLine: string;
  let serverFailed = false;
  if (!serverKey) {
    serverLine =
      `Server Address Validation: NOT SET — no ${SERVER_KEY_FIELD} is saved, so no address ` +
      "can be validated and the booking gate stays shut. This is the key that produces a verdict.";
  } else if (!serverProbe) {
    serverLine = "Server Address Validation: NOT CHECKED.";
  } else if (serverProbe.ok) {
    serverLine =
      `Server Address Validation: HEALTHY — Google accepted the server key for a live ` +
      `validateAddress call (${serverProbe.note}). This is the credential that produces an ` +
      "address verdict.";
  } else {
    serverFailed = true;
    serverLine =
      `Server Address Validation: FAILED — Google refused the server key: ${serverProbe.message} ` +
      `The saved value is ${await secretShape(SERVER_KEY_FIELD)}, which is not a key Google ` +
      "accepts. Until it is replaced, every address comes back UNAVAILABLE and no booking can be " +
      "validated.";
  }

  const status =
    browserFailed || serverFailed
      ? "FAILED"
      : !browserKey || !serverKey
        ? "NOT_CONFIGURED"
        : "HEALTHY";

  return { status, detail: `${browserLine}\n${serverLine}`, error };
}
