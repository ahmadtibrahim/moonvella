/**
 * Asking Shopify to send MoonVella the order events.
 *
 * WHY THIS FILE EXISTS AT ALL, GIVEN THE TOML ALREADY DECLARES THE TOPICS.
 *
 * `shopify.app.toml` declares the six order topics, and a `shopify app deploy`
 * registers them. That is the intended path and it is the one that was missing
 * — its absence is why order #1001 was paid for and MoonVella was never told.
 * But the deploy is a go-live step, and it is currently BLOCKED: Shopify
 * refuses to register topics carrying protected customer data until the app is
 * approved for it, and that approval is a Partner Dashboard review that no
 * deploy can perform.
 *
 * The order in which those two things can happen is the whole reason this
 * module exists. If registration lives only in the deploy, then the sequence is
 * "get approved, then remember to re-deploy, then wait" — and the failure mode
 * of forgetting the middle step is silent and total, which is exactly the
 * failure being fixed. Instead the app asks for its own subscriptions at
 * runtime, on a schedule, so that the moment approval lands the next attempt
 * succeeds and delivery starts. Nobody has to remember anything.
 *
 * WHY IT IS SAFE TO CALL REPEATEDLY. Registering a topic that is already
 * registered creates a second subscription, and Shopify will then deliver the
 * same event twice to two endpoints — which the intake is idempotent against,
 * but which doubles the traffic and makes the subscription list a mess. So the
 * current subscriptions are read first and only the missing topics are created.
 *
 * WHAT IT DOES NOT DO. It does not swallow the refusal. When Shopify says the
 * app is not approved, that sentence is stored verbatim on the integration row
 * and returned, because it names the one action that unblocks the whole
 * pipeline and paraphrasing it would hide the fix.
 */

import { prisma } from "~/db.server";
import { setIntegrationState } from "./integrationHealth.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { classifyRefusal } from "./shopifyFulfillment.server";

/** The route that answers these deliveries. Must match the toml's `uri`. */
export const ORDER_WEBHOOK_PATH = "/webhooks/orders";

/**
 * The topics, and the same six the toml declares.
 *
 * Kept as one list because the two registrations — declarative and runtime —
 * have to agree. A topic added to one and not the other produces a subscription
 * that exists only after a deploy, or only after a retry, which is a difference
 * nobody would notice until an order went missing.
 */
export const ORDER_WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_PAID",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
  "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE",
] as const;

export type OrderWebhookTopic = (typeof ORDER_WEBHOOK_TOPICS)[number];

export interface WebhookSubscriptionOutcome {
  /** Topics Shopify is now delivering. */
  registered: string[];
  /** Topics that were already registered and were left alone. */
  alreadyPresent: string[];
  /** Topics this call could not register, with Shopify's own reason. */
  refused: { topic: string; reason: string }[];
  /**
   * Set when the whole call was refused before any topic could be created —
   * no session, no scope, or no Protected Customer Data approval.
   */
  blockedBy?: "SCOPE" | "PROTECTED_CUSTOMER_DATA" | "SESSION" | "OTHER";
  callbackUrl: string;
}

/**
 * The address Shopify should POST to.
 *
 * Derived from the configured app URL rather than hard-coded, so that a
 * staging deploy registers staging callbacks and doesn't quietly enlist the
 * production host for a test store.
 */
export function orderWebhookCallbackUrl(): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  return `${base}${ORDER_WEBHOOK_PATH}`;
}

interface SubscriptionNode {
  id: string;
  topic: string;
  endpoint?: { callbackUrl?: string | null } | null;
}

/**
 * Make sure this store is delivering all six order topics to this app.
 *
 * Returns what happened rather than throwing for a refusal, because a refusal
 * here is an expected state until the Partner Dashboard review completes and
 * the caller is a retry loop that must keep running. A refusal is still
 * recorded — on the integration row and in the audit log — so "we are not
 * receiving orders" is answerable without reading logs.
 */
export async function ensureOrderWebhookSubscriptions(
  sellerId: string
): Promise<WebhookSubscriptionOutcome> {
  const callbackUrl = orderWebhookCallbackUrl();
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, shopDomain: true },
  });
  if (!seller) throw new Error("No such seller.");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(seller.shopDomain);

  const readQuery = `#graphql
    query MoonVellaWebhookSubscriptions {
      webhookSubscriptions(first: 100) {
        nodes {
          id
          topic
          endpoint {
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }`;

  const createMutation = `#graphql
    mutation MoonVellaWebhookSubscribe($topic: WebhookSubscriptionTopic!, $url: URL!) {
      webhookSubscriptionCreate(
        topic: $topic
        webhookSubscription: { callbackUrl: $url, format: JSON }
      ) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`;

  const outcome: WebhookSubscriptionOutcome = {
    registered: [],
    alreadyPresent: [],
    refused: [],
    callbackUrl,
  };

  const finish = async (status: "HEALTHY" | "DEGRADED" | "FAILED", detail: string) => {
    await setIntegrationState("shopify_orders", { status, detail });
    return outcome;
  };

  let existing: SubscriptionNode[] = [];
  try {
    const res = await admin.graphql(readQuery);
    const json: {
      data?: { webhookSubscriptions?: { nodes?: SubscriptionNode[] } | null };
      errors?: { message: string }[];
    } = await res.json();
    if (Array.isArray(json?.errors) && json.errors.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    existing = json?.data?.webhookSubscriptions?.nodes ?? [];
  } catch (error) {
    const blocked = classifyRefusal(error instanceof Error ? error.message : String(error));
    outcome.blockedBy = blocked.blocker;
    return finish("FAILED", `Could not read webhook subscriptions. Blocked by ${blocked.blocker}.`);
  }

  const present = new Set(existing.map((node) => String(node.topic ?? "").toUpperCase()));

  for (const topic of ORDER_WEBHOOK_TOPICS) {
    if (present.has(topic)) {
      outcome.alreadyPresent.push(topic);
      continue;
    }
    try {
      const res = await admin.graphql(createMutation, {
        variables: { topic, url: callbackUrl },
      });
      const json: {
        data?: {
          webhookSubscriptionCreate?: {
            webhookSubscription?: { id: string } | null;
            userErrors?: { field?: string[] | null; message: string }[];
          } | null;
        };
        errors?: { message: string }[];
      } = await res.json();
      if (Array.isArray(json?.errors) && json.errors.length) {
        throw new Error(json.errors.map((e) => e.message).join("; "));
      }
      const userErrors = json?.data?.webhookSubscriptionCreate?.userErrors ?? [];
      if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join("; "));
      if (!json?.data?.webhookSubscriptionCreate?.webhookSubscription?.id) {
        throw new Error("Shopify accepted the subscription but returned no id.");
      }
      outcome.registered.push(topic);
    } catch (error) {
      const blocked = classifyRefusal(error instanceof Error ? error.message : String(error));
      if (blocked.blocker === "PROTECTED_CUSTOMER_DATA" || blocked.blocker === "SCOPE") {
        outcome.blockedBy = blocked.blocker;
      }
      outcome.refused.push({ topic, reason: blocked.message });
    }
  }

  const detail = outcome.registered.length
    ? `Registered ${outcome.registered.join(", ")}.`
    : outcome.refused.length
      ? `Could not register ${outcome.refused.length} of ${ORDER_WEBHOOK_TOPICS.length} order topics. ` +
        `First reason: ${outcome.refused[0].reason}`
      : `All ${ORDER_WEBHOOK_TOPICS.length} order topics are already registered.`;

  await recordAudit({
    actorType: "SYSTEM",
    actorId: "shopify-webhooks",
    actorName: "Shopify webhooks",
    action: "webhook.subscriptions_ensured",
    entityType: AUDIT_ENTITY.SELLER,
    entityId: sellerId,
    afterData: {
      registered: outcome.registered,
      alreadyPresent: outcome.alreadyPresent.length,
      refused: outcome.refused.map((r) => r.topic),
      blockedBy: outcome.blockedBy ?? null,
      callbackUrl,
    },
  });

  return finish(
    outcome.refused.length === 0 ? "HEALTHY" : outcome.registered.length ? "DEGRADED" : "FAILED",
    detail
  );
}
