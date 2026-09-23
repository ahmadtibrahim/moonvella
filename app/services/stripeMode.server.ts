/**
 * Stripe operating mode, resolved explicitly.
 *
 * Before this module the app decided "are we simulating?" from one fact: does a
 * secret key resolve. That conflates three different situations — there is no
 * key, there is a sandbox key, there is a live key — and it silently put a live
 * key on the same code path as a sandbox key. The URL-join defect in
 * sellerBilling.server.ts hid that for a while: every call was malformed, so the
 * live path was never actually reachable. Fixing the URL removes that accidental
 * protection, so the mode has to become explicit first.
 *
 * The mode is named, and the two ways to leave "no provider calls" — a sandbox
 * key and a live key — are treated as different modes with different gates:
 *
 *   simulated  no provider calls at all. The default when nothing is configured.
 *   test       a sandbox key (sk_test_ / rk_test_). Provider calls allowed.
 *   live       a live key (sk_live_ / rk_live_). Provider calls REFUSED unless
 *              MOONVELLA_ALLOW_LIVE_STRIPE is explicitly set. Charging a real
 *              card is never something this app does by accident.
 *   disabled   an operator disconnected the provider. Refused, and deliberately
 *              NOT turned into a simulation: a disconnected provider must not
 *              return a result that looks like it worked.
 *
 * MOONVELLA_STRIPE_MODE overrides the key-prefix derivation, which is what tests
 * use: a simulated suite sets it to `simulated` and then makes no external calls
 * even on a host that has a perfectly good sandbox key saved.
 *
 * Reading the prefix is not the "inferred from whether a key exists" pattern this
 * replaces — `sk_test_` is a marker Stripe itself issues. The override exists so
 * the mode can be pinned without touching the key.
 */

import { isProviderDisconnected, stripeSecretKey } from "./credentials.server";

export type StripeMode = "disabled" | "simulated" | "test" | "live";

/** The subset of modes in which a real HTTP call to Stripe may be made. */
export type StripeProviderMode = "test" | "live";

const OVERRIDE_VAR = "MOONVELLA_STRIPE_MODE";
const LIVE_OPT_IN_VAR = "MOONVELLA_ALLOW_LIVE_STRIPE";

const OVERRIDES: readonly StripeMode[] = ["disabled", "simulated", "test", "live"];

/**
 * Classify a key by the prefix Stripe issues. Returns null for a value that is
 * not recognisably a Stripe key, which callers must treat as "not usable" rather
 * than guessing.
 */
export function classifyStripeKey(key: string | null): StripeProviderMode | null {
  if (!key) return null;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return null;
}

function override(): StripeMode | null {
  const raw = (process.env[OVERRIDE_VAR] ?? "").trim().toLowerCase();
  if (!raw) return null;
  return (OVERRIDES as readonly string[]).includes(raw) ? (raw as StripeMode) : null;
}

/** True when an operator has explicitly authorised live provider calls. */
export function liveStripeAuthorized(): boolean {
  return (process.env[LIVE_OPT_IN_VAR] ?? "").trim().toLowerCase() === "true";
}

export interface StripeModeDetail {
  mode: StripeMode;
  /** Named so a caller can explain WHY, without ever naming the key itself. */
  source: "override" | "disconnect-flag" | "key-prefix" | "no-key" | "unrecognised-key";
  /** The key's own classification, independent of the override. */
  keyKind: StripeProviderMode | null;
}

/**
 * The full resolution, for callers that need to explain the mode rather than
 * branch on it. Never throws: this is display-safe.
 */
export async function stripeModeDetail(): Promise<StripeModeDetail> {
  const forced = override();
  const key = await stripeSecretKey();
  const keyKind = classifyStripeKey(key);

  if (await isProviderDisconnected("stripe")) {
    return { mode: "disabled", source: "disconnect-flag", keyKind };
  }
  if (forced) {
    return { mode: forced, source: "override", keyKind };
  }
  if (!key) {
    return { mode: "simulated", source: "no-key", keyKind: null };
  }
  if (keyKind) {
    return { mode: keyKind, source: "key-prefix", keyKind };
  }
  // A value is stored but is not a shape Stripe issues. Refuse rather than
  // assume: the previous behaviour would have called the API with it.
  return { mode: "disabled", source: "unrecognised-key", keyKind: null };
}

/** The mode, for branching. Display-safe; does not throw. */
export async function stripeMode(): Promise<StripeMode> {
  return (await stripeModeDetail()).mode;
}

/** True only in a mode where an outbound Stripe request is permitted. */
export async function stripeProviderCallsAllowed(): Promise<boolean> {
  const { mode, keyKind } = await stripeModeDetail();
  if (mode === "test") return keyKind === "test";
  if (mode === "live") return keyKind === "live" && liveStripeAuthorized();
  return false;
}

export class StripeModeError extends Error {
  readonly mode: StripeMode;
  constructor(mode: StripeMode, message: string) {
    super(message);
    this.name = "StripeModeError";
    this.mode = mode;
  }
}

/**
 * Gate every outbound Stripe request through this. Returns the secret key only
 * when the mode permits the call, so there is no path that reads the key and
 * skips the check.
 *
 * The error text names modes and environment variables only — never the key, not
 * even a prefix of it.
 */
/**
 * The gate itself, as a pure function of the four facts it depends on.
 *
 * Pure on purpose. The decision that matters most — "a live key is stored, so
 * this must not run" — is the one that cannot be exercised against a real system
 * without doing the thing it forbids. Split out from the resolution, every
 * combination can be asserted directly, which is why verify-stripe-sandbox can
 * prove the live refusal without a live key ever existing.
 *
 * Returns null when the call is permitted, or the refusal to raise.
 */
export function providerRefusal(
  mode: StripeMode,
  keyKind: StripeProviderMode | null,
  liveAuthorized: boolean,
  operation: string,
  source: StripeModeDetail["source"]
): { mode: StripeMode; message: string } | null {
  if (mode === "simulated") {
    return {
      mode,
      message:
        `Stripe is in simulated mode, so "${operation}" was not sent to Stripe. No secret key resolves. ` +
        `Save one in Settings, or set ${OVERRIDE_VAR}=test to require a sandbox key.`,
    };
  }
  if (mode === "disabled") {
    return {
      mode,
      message:
        source === "disconnect-flag"
          ? `Stripe is disconnected, so "${operation}" is refused. Reconnect it in Settings to re-enable provider operations.`
          : `The stored Stripe secret key is not a key shape Stripe issues, so "${operation}" is refused. ` +
            `Save a valid key in Settings (sk_test_… for sandbox).`,
    };
  }
  if (mode === "test" && keyKind !== "test") {
    return {
      mode,
      message:
        `${OVERRIDE_VAR}=test requires a sandbox key (sk_test_…), but the stored key is not one, ` +
        `so "${operation}" is refused.`,
    };
  }
  if (mode === "live" && keyKind !== "live") {
    return {
      mode,
      message:
        `${OVERRIDE_VAR}=live requires a live key (sk_live_…), but the stored key is not one, ` +
        `so "${operation}" is refused.`,
    };
  }
  if (mode === "live" && !liveAuthorized) {
    return {
      mode,
      message:
        `A live Stripe key is stored and "${operation}" would move real money, so it is refused. ` +
        `Set ${LIVE_OPT_IN_VAR}=true to authorise live provider calls.`,
    };
  }
  return null;
}

export async function requireStripeProvider(
  operation: string
): Promise<{ key: string; mode: StripeProviderMode }> {
  const { mode, source, keyKind } = await stripeModeDetail();

  const refusal = providerRefusal(mode, keyKind, liveStripeAuthorized(), operation, source);
  if (refusal) throw new StripeModeError(refusal.mode, refusal.message);

  const key = await stripeSecretKey();
  if (!key) {
    // Only reachable if the key changed between the two resolutions.
    throw new StripeModeError("simulated", `Stripe key vanished mid-operation; "${operation}" was not sent.`);
  }
  return { key, mode: mode as StripeProviderMode };
}

/**
 * Refuse when the provider is disabled, without demanding a provider call.
 *
 * For operations that have a legitimate simulated form: simulated is a real
 * answer ("no provider was contacted"), disabled is not. A disconnected provider
 * must never be silently downgraded into a simulation, because a simulation
 * returns a result that looks like it worked.
 */
export async function assertNotDisabled(operation: string): Promise<StripeMode> {
  const { mode, source } = await stripeModeDetail();
  if (mode === "disabled") {
    throw new StripeModeError(
      mode,
      source === "disconnect-flag"
        ? `Stripe is disconnected, so "${operation}" is refused. Reconnect it in Settings first.`
        : `The stored Stripe secret key is not a key shape Stripe issues, so "${operation}" is refused. ` +
          `Save a valid key in Settings (sk_test_… for sandbox).`
    );
  }
  return mode;
}

/**
 * Guard against a fabricated identifier reaching Stripe.
 *
 * The simulated branch writes ids like `sim_pm_…` and `sim_seti_…` so that local
 * records stay self-describing. Those ids exist nowhere but our own database. If
 * one is ever handed to a real call, Stripes's answer is a confusing 404 that
 * reads like a missing object rather than what it is — a test that leaked out of
 * simulation. Fail loudly and locally instead.
 */
export function assertProviderId(id: string, kind: string, operation: string): string {
  const value = String(id ?? "").trim();
  if (!value) {
    throw new Error(`${operation}: no ${kind} was given.`);
  }
  if (value.startsWith("sim_")) {
    throw new Error(
      `${operation}: "${kind}" is a simulated identifier (${value.slice(0, 3)}…) and does not exist at Stripe. ` +
        `Simulated objects can only be used while Stripe is in simulated mode.`
    );
  }
  return value;
}

/** True when an identifier is one this app fabricated rather than one Stripe returned. */
export function isSimulatedId(id: string | null | undefined): boolean {
  return String(id ?? "").trim().startsWith("sim_");
}
