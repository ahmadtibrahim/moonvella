/**
 * Make "a simulated suite makes no external call" an enforced property rather
 * than a claim in a comment.
 *
 * The simulated suites are supposed to exercise the internal payment logic with
 * no provider involved. They used to get that for free, because a simulated run
 * was whatever happened when no key resolved — and they lost it the moment a
 * real sandbox key was saved in Settings, at which point they left the simulated
 * branch and started calling Stripe with fabricated ids. Nothing failed loudly;
 * the suites simply stopped testing what they said they tested.
 *
 * `MOONVELLA_STRIPE_MODE=simulated` now keeps them on the simulated branch, and
 * this guard is the second line of defence: if any code under test ever reaches
 * for a provider host anyway, the request throws here with the URL attached
 * instead of silently succeeding against a real account.
 *
 * Only provider hosts are blocked. A suite is still free to talk to localhost or
 * to stub fetch entirely for its own purposes.
 */

const PROVIDER_HOSTS = [
  "api.stripe.com",
  "eshipper.com",
  // Google Maps Platform. Address validation and Places autocomplete are both
  // billable and both reachable from a code path a simulated suite can wander
  // into, so the guard covers them too rather than trusting the suite to
  // remember. The API host is separate from the Maps host on purpose: a suite
  // that stubs one and not the other would fail here rather than spend quota.
  "addressvalidation.googleapis.com",
  "maps.googleapis.com",
  "places.googleapis.com",
];

let installed = false;

export function forbidProviderCalls(label: string): void {
  if (installed) return;
  installed = true;

  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url ?? "");

    const host = PROVIDER_HOSTS.find((h) => {
      try {
        const parsed = new URL(url);
        return parsed.hostname === h || parsed.hostname.endsWith(`.${h}`);
      } catch {
        return url.includes(h);
      }
    });

    if (host) {
      throw new Error(
        `${label}: refused an outbound call to ${host} while running in simulated mode.\n` +
          `  ${url}\n` +
          `  A simulated suite must not touch a provider. Either the mode was not pinned ` +
          `(MOONVELLA_STRIPE_MODE=simulated) or a code path skipped the simulated branch.`
      );
    }
    return real(input as never, init);
  }) as typeof fetch;

  // Recorded so a suite can assert the guard was actually in place rather than
  // trusting that this function ran.
  (globalThis as { __providerGuard?: string }).__providerGuard = label;
}

/** Whether the guard is installed for this process. */
export function providerGuardActive(): boolean {
  return installed;
}
