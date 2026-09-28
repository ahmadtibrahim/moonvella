import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

/**
 * The app/scopes_update webhook endpoint: POST /webhooks/app/scopes_update
 *
 * WHAT THIS EVENT IS, AND WHY IT IS THE ONLY PLACE THAT KNOWS IT.
 *
 * When a merchant approves a scope change — the fulfillment grant this app asks
 * for behind its own button, rather than from a loader — Shopify updates the
 * installation and sends this event. The new grant is not derivable from
 * anything local: the config declares what was ASKED for, a deploy does not
 * change a grant in either direction, and `authenticate.admin` never compares
 * the two. So the session's stored scope string goes stale the moment an
 * approval lands, unless something writes the new one, and this delivery is
 * that something.
 *
 * WHAT THE STOCK HANDLER GOT WRONG, because this file was the template's copy:
 *
 *   - It wrote `payload.current.toString()` unconditionally. On a delivery with
 *     no `current` — a shape this event has had variants of — that writes the
 *     literal string "undefined" into the session. The column is nullable, and
 *     the reader (`scopesFromSession` in analytics) splits it on commas, so the
 *     result is a scope list containing one scope named "undefined": worse than
 *     the stale list it replaced, and indistinguishable from a real one.
 *   - It wrote on every delivery, so Shopify's at-least-once redelivery — a slow
 *     answer, a deploy, a retry — re-wrote an identical row with nothing to say
 *     it was identical.
 *   - It logged the topic and the shop, and neither scope set. The one event
 *     that explains why a session's scopes changed left no record of the change.
 *
 * THE SHOP IS NEVER READ FROM THE PAYLOAD, and that is a deliberate line rather
 * than a style. The HMAC covers the body, not the headers, so the domain a
 * delivery is filed under comes from the framework's verification and from
 * nowhere else — and a payload field claiming to be a different store is a
 * claim the signature over that payload does not make. Every row this handler
 * can touch is selected by that verified domain, which is what makes "a
 * delivery for one shop cannot write another shop's session" a property of the
 * query rather than a convention someone has to remember.
 *
 * WHY IT ANSWERS 200 FOR EVERYTHING IT DOES NOT ACT ON. A delivery it cannot
 * use is not a delivery Shopify should send again: no scope list, or no session
 * to write it to, will be just as true of the copy. A 5xx asks for a redelivery
 * that is guaranteed to be dropped in the same way, and fills the failed-delivery
 * count with noise. A failure to WRITE is different and is left to throw, because
 * that one has changed nothing and a retry is exactly the right response to it.
 */

/**
 * A scope list in the form the session column stores: sorted, comma-joined,
 * with no duplicates or blanks.
 *
 * Two shapes arrive here. The payload carries an array of strings; the session
 * column carries the compressed string OAuth uses. Normalising BOTH through this
 * one function is what makes the "nothing changed" comparison below meaningful —
 * comparing an array against a string would never match, and the handler would
 * write on every delivery while appearing to check.
 */
function scopeSet(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(",");
  const cleaned = parts.map((scope) => String(scope).trim()).filter(Boolean);
  return [...new Set(cleaned)].sort();
}

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  const current = scopeSet(payload?.current);
  const reported = scopeSet(payload?.previous);
  const nextScope = current.join(",");

  /*
   * An event carrying no scope list is not an instruction to clear the stored
   * one. Refusing to write is the whole point: the empty string would read back
   * as "this app holds no scopes", which is a bigger lie than a stale list, and
   * nothing downstream could tell the two apart.
   */
  if (!current.length) {
    console.warn(
      `${topic} for ${shop} carried no scope list, so the stored scopes were left alone.`,
    );
    return new Response(null, { status: 200 });
  }

  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: { id: true, scope: true },
  });

  if (!session) {
    console.log(`${topic} for ${shop}: no offline session is stored, so there is nothing to update.`);
    return new Response(null, { status: 200 });
  }

  const stored = scopeSet(session.scope);

  /*
   * Both scope sets are logged, and they are not the same pair. `stored` is
   * what this app believed a moment ago; `reported` is what Shopify says the
   * previous set was. Logging only Shopify's pair would hide a session that had
   * drifted, which is the state this handler exists to correct.
   */
  console.log(
    `${topic} for ${shop}: session ${session.id} scopes ` +
      `[${stored.join(", ") || "(none)"}] -> [${current.join(", ")}] ` +
      `(Shopify reported the previous set as [${reported.join(", ") || "(none)"}])`,
  );

  /*
   * IDEMPOTENT, AND OBSERVABLY SO. Shopify delivers at least once, so the same
   * event can arrive twice; the second copy must be a no-op rather than a write
   * that looks identical in the log to a real change. Comparing the normalised
   * sets is what makes that true, and the log line above is what makes the
   * difference visible.
   */
  if (stored.join(",") === nextScope) {
    return new Response(null, { status: 200 });
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { scope: nextScope },
  });

  return new Response(null, { status: 200 });
};
