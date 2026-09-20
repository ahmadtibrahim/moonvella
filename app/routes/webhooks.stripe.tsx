import type { ActionFunctionArgs } from "react-router";
import { verifyStripeSignature, applyStripeEvent } from "~/services/payments.server";

export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text();
  const signature = request.headers.get("Stripe-Signature");

  const verification = verifyStripeSignature(raw, signature, process.env.STRIPE_WEBHOOK_SECRET);
  if (!verification.valid) {
    return new Response(`Signature verification failed: ${verification.reason}`, { status: 400 });
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
