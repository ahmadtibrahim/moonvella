/**
 * The address entry aid as it runs in a page: the calls, and the list.
 *
 * THE SPLIT. `placesAddress.ts` knows what Google's answer means; this file
 * knows when to ask and how to show the answer. The asking half is a plain
 * object with an injectable `fetch`, so a suite can drive the whole flow —
 * including the parts that cost money, like the session token and the refusal to
 * retry a rejected key — without a browser. The showing half is a thin DOM
 * adapter, and it is thin on purpose: the code with decisions in it is the half
 * the suite can run.
 *
 * WHAT IT NEVER DOES. It does not write to any form field. A picked address is
 * handed to `onPick` as data, and the page decides which column each component
 * belongs in — which is what keeps Street 2 out of every path that Google can
 * reach, and what lets the admin form, whose inputs are uncontrolled, write the
 * DOM values itself.
 */

import {
  autocompleteRequest,
  detailsRequest,
  isPermanentPlacesFailure,
  newSessionToken,
  placesFailure,
  readPlaceDetails,
  readSuggestions,
  type PickedAddress,
  type PlaceSuggestion,
} from "./placesAddress";

export type AidResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** What the page may want to say about the aid's state. */
export type EntryAidStatus = "idle" | "searching" | "ready" | "failed";

const UNREACHABLE =
  "Google's address service could not be reached from this page. The address fields still work — type the address in full.";
const ABORTED = "aborted";

export interface SuggestionSessionOptions {
  apiKey: string;
  /** Injected so the suite can run the flow without a network. */
  fetchImpl?: typeof fetch;
  regionCodes?: string[];
}

/**
 * One address-entry session: the keystrokes the operator typed, and the one
 * place they chose.
 *
 * The session token is what makes that a single billed lookup rather than a
 * lookup per keystroke, so it is created once, reused by every search, and
 * passed to the details call of the chosen place. It is rotated after a pick,
 * because the next address typed is a different lookup.
 */
export interface SuggestionSession {
  search(text: string, signal?: AbortSignal): Promise<AidResult<PlaceSuggestion[]>>;
  pick(placeId: string): Promise<AidResult<PickedAddress>>;
  /** The sanitized reason for the last failure, or null. */
  readonly failure: string | null;
  /** True once Google has refused the key itself: no further calls are made. */
  readonly stopped: boolean;
}

export function createSuggestionSession(
  options: SuggestionSessionOptions,
): SuggestionSession {
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  const regionCodes = options.regionCodes ?? ["ca"];

  let sessionToken = newSessionToken();
  let failure: string | null = null;
  let stopped = false;

  async function call(url: string, init: RequestInit): Promise<AidResult<unknown>> {
    if (!fetchImpl) return { ok: false, reason: UNREACHABLE };
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      // An aborted request is the operator still typing, not a fault: it must
      // not be recorded as a failure, or a fast typist would see an error
      // message appear and vanish as they type.
      if ((init.signal as AbortSignal | undefined)?.aborted || (error as Error)?.name === "AbortError") {
        return { ok: false, reason: ABORTED };
      }
      failure = UNREACHABLE;
      return { ok: false, reason: UNREACHABLE };
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const { message } = placesFailure(response.status, payload);
      failure = message;
      // A key, an API or a referrer the console refuses will refuse every
      // request, so the aid stops asking rather than turning one
      // misconfiguration into a request per character typed.
      if (isPermanentPlacesFailure(response.status)) stopped = true;
      return { ok: false, reason: message };
    }

    failure = null;
    return { ok: true, value: payload };
  }

  return {
    get failure() {
      return failure;
    },
    get stopped() {
      return stopped;
    },
    async search(text, signal) {
      if (stopped) return { ok: false, reason: failure ?? UNREACHABLE };
      const { url, init } = autocompleteRequest(apiKey, text, sessionToken, regionCodes);
      const result = await call(url, { ...init, signal });
      if (!result.ok) return result;
      return { ok: true, value: readSuggestions(result.value) };
    },
    async pick(placeId) {
      if (stopped) return { ok: false, reason: failure ?? UNREACHABLE };
      const { url, init } = detailsRequest(apiKey, placeId, sessionToken);
      const result = await call(url, init);
      // The next address is a new session either way: a token reused across two
      // addresses would bill them as one, and Google's session semantics are
      // that a session ends at the choice.
      sessionToken = newSessionToken();
      if (!result.ok) return result;
      return { ok: true, value: readPlaceDetails(result.value) };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The list                                                                   */
/* -------------------------------------------------------------------------- */

export interface AddressEntryAidOptions extends SuggestionSessionOptions {
  /** The field the operator types into. The aid never writes to it. */
  input: HTMLInputElement;
  /** Where the suggestions are rendered. Emptied when there are none. */
  list: HTMLElement;
  onPick: (picked: PickedAddress) => void;
  onStatus?: (status: EntryAidStatus, reason?: string | null) => void;
  /** Characters below which no request is made. */
  minLength?: number;
  debounceMs?: number;
}

export interface AddressEntryAid {
  destroy(): void;
}

export function createAddressEntryAid(options: AddressEntryAidOptions): AddressEntryAid {
  const { input, list, onPick, onStatus } = options;
  const minLength = options.minLength ?? 3;
  const debounceMs = options.debounceMs ?? 250;
  const session = createSuggestionSession(options);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let suggestions: PlaceSuggestion[] = [];
  let activeIndex = -1;

  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  list.setAttribute("role", "listbox");
  list.hidden = true;

  function report(status: EntryAidStatus, reason?: string | null) {
    onStatus?.(status, reason ?? null);
  }

  function close() {
    suggestions = [];
    activeIndex = -1;
    list.replaceChildren();
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function render() {
    const nodes = suggestions.map((suggestion, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
      button.tabIndex = -1;
      Object.assign(button.style, {
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "0.5rem 0.6rem",
        border: "none",
        borderBottom: "1px solid var(--border-color, #e5e5e5)",
        background: index === activeIndex ? "var(--accent-blue, #eef4ff)" : "transparent",
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
      } satisfies Partial<CSSStyleDeclaration>);

      const main = document.createElement("span");
      // textContent, never innerHTML: this text came from a network response.
      main.textContent = suggestion.mainText;
      main.style.display = "block";
      button.appendChild(main);

      if (suggestion.secondaryText) {
        const secondary = document.createElement("span");
        secondary.textContent = suggestion.secondaryText;
        Object.assign(secondary.style, {
          display: "block",
          fontSize: "0.72rem",
          color: "var(--text-secondary, #6b7280)",
        } satisfies Partial<CSSStyleDeclaration>);
        button.appendChild(secondary);
      }

      return button;
    });

    list.replaceChildren(...nodes);
    list.hidden = nodes.length === 0;
    input.setAttribute("aria-expanded", nodes.length === 0 ? "false" : "true");
  }

  async function run(text: string) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    report("searching");
    const result = await session.search(text, current.signal);
    // A late answer to a superseded query must not render over a newer one, and
    // an abort is the next keystroke arriving rather than an outcome to report.
    if (current.signal.aborted) return;
    if (!result.ok) {
      if (result.reason === ABORTED) return;
      close();
      report("failed", result.reason);
      return;
    }
    suggestions = result.value;
    activeIndex = suggestions.length > 0 ? 0 : -1;
    if (suggestions.length === 0) {
      close();
      report("idle");
      return;
    }
    render();
    report("ready");
  }

  async function choose(suggestion: PlaceSuggestion | undefined) {
    if (!suggestion) return;
    const text = input.value;
    close();
    report("idle");
    const result = await session.pick(suggestion.placeId);
    if (!result.ok) {
      report("failed", result.reason);
      return;
    }
    // The field the operator was typing in is left holding what they typed: the
    // page decides which column each component goes to, and a page that wants
    // Street 1 replaced does it itself.
    if (input.value !== text) return;
    onPick(result.value);
  }

  function onInput() {
    if (timer) clearTimeout(timer);
    const text = input.value.trim();
    if (session.stopped) {
      close();
      report("failed", session.failure);
      return;
    }
    if (text.length < minLength) {
      controller?.abort();
      close();
      report("idle");
      return;
    }
    timer = setTimeout(() => {
      void run(text);
    }, debounceMs);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      close();
      report("idle");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + delta + suggestions.length) % suggestions.length;
      render();
      return;
    }
    if (event.key === "Enter") {
      if (suggestions.length === 0) return;
      // Only when the list is open: otherwise Enter is the form's, and
      // swallowing it would make the button next to it the only way to submit.
      event.preventDefault();
      void choose(suggestions[activeIndex] ?? suggestions[0]);
    }
  }

  function onMouseDown(event: MouseEvent) {
    const target = (event.target as HTMLElement | null)?.closest("button");
    if (!target || !list.contains(target)) return;
    // Keeping focus in the input means the click is not lost to a blur that
    // closes the list before the click lands.
    event.preventDefault();
    const index = Array.prototype.indexOf.call(list.children, target);
    void choose(suggestions[index]);
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  list.addEventListener("mousedown", onMouseDown);

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      controller?.abort();
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      list.removeEventListener("mousedown", onMouseDown);
      close();
    },
  };
}
