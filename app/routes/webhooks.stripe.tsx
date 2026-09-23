import type { ActionFunctionArgs } from "react-router";
import { verifyStripeSignature, applyStripeEvent } from "~/services/payments.server";
import { stripeWebhookSecret } from "~/services/credentials.server";

/**
 * Stripe webhook endpoint: POST /webhooks/stripe
 *
 * Public by necessity — Stripe cannot authenticate as an admin. The signature is
 * the authentication, which is why the raw body is read before anything parses
 * it and why a request that fails verification never reaches applyStripeEvent.
 *
 * The signing secret is resolved per request from the encrypted credential store
 * (saved in Settings) or the environment, so rotating it does not need a
 * redeploy.
 *
 * Failure responses are deliberately vague. An anonymous caller learns that the
 * signature was rejected, not whether a secret is configured, which secret, or
 * how far verification got.
 */
export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text();
  const signature = request.headers.get("Stripe-Signature");

  const secret = await stripeWebhookSecret();
  const verification = verifyStripeSignature(raw, signature, secret ?? undefined);
  if (!verification.valid) {
    return new Response("Signature verification failed", { status: 400 });
  }

  let event: { id: string; type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    await applyStripeEvent(event);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Processing failed", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
