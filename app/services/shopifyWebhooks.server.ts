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
 *
 * TWO GROUPS, ONE SWEEP. The file also ensures the app-level topic the config
 * declares but the deploy's sync did not create — see APP_WEBHOOK_TOPICS for
 * that story. Both groups are the same operation over different topics, so they
 * share the read-then-create core below rather than being two copies that can
 * disagree about how "already registered" is decided.
 */

import { prisma } from "~/db.server";
import { setIntegrationState, type IntegrationKey } from "./integrationHealth.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { classifyRefusal } from "./shopifyFulfillment.server";

/** The route that answers the order deliveries. Must match the toml's `uri`. */
export const ORDER_WEBHOOK_PATH = "/webhooks/orders";

/**
 * The route that answers the app-level deliveries. Must match the toml's `uri`.
 *
 * A route file's name IS its path — `app/routes/webhooks.app.scopes_update.jsx`
 * is served at `/webhooks/app/scopes_update` — so this constant and the toml's
 * `uri` are two spellings of one address. When they disagree the delivery 404s,
 * which Shopify answers with a retry and a failed-delivery count rather than
 * with a message anybody reads.
 */
export const APP_WEBHOOK_PATH = "/webhooks/app/scopes_update";

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

/**
 * The app-level topics, and the same one the toml declares.
 *
 * WHY THIS LIST EXISTS AT ALL, GIVEN THE TOML ALREADY DECLARES THE TOPIC, and
 * why it is the same reason as the order topics above.
 *
 * `app/scopes_update` has been in `shopify.app.toml` since 2026-09-19 and the
 * config has been deployed repeatedly, and the store had NO subscription to it.
 * The toml block is a DECLARATION; a subscription is a separate record, created
 * by whichever sync runs at deploy. That sync created `app/uninstalled` and
 * `routing_complete` on this store and never created this one. Reading the
 * config back proves the declaration was published and proves nothing at all
 * about whether a subscription exists — they are two different stores, and only
 * one of them was wrong.
 *
 * Nothing in the app could notice, which is the part worth fixing. The six order
 * topics have the runtime backstop below, so a config sync that drops one of
 * them is repaired on the next sweep. This topic had no backstop: it was the
 * only declared topic whose existence depended entirely on a sync that had
 * already been observed to skip it. A merchant approving the fulfillment scopes
 * would then have had nothing listening, and the session's scope string would
 * have kept the old grant — the same silent, total failure the order topics were
 * given this file for.
 *
 * It is also safe to ask for, which was checked before it was written: the
 * `webhookSubscriptionCreate` call for this topic answers with a subscription id
 * and no user errors, unlike the order topics, which are refused on Protected
 * Customer Data until that review completes.
 */
export const APP_WEBHOOK_TOPICS = ["APP_SCOPES_UPDATE"] as const;

export type AppWebhookTopic = (typeof APP_WEBHOOK_TOPICS)[number];

/**
 * One route and the topics it answers.
 *
 * Both registrations have to agree about this pairing — the toml's and the
 * runtime one — so it is written once here and read by both, rather than
 * repeated per topic in two files that can drift.
 */
interface WebhookGroup {
  /** Named in the audit row, so the two sweeps are told apart when read back. */
  name: "orders" | "app";
  /** The route that answers these deliveries. Must match the toml's `uri`. */
  path: string;
  /** The topics, and the same set the toml declares for that path. */
  topics: readonly string[];
  /**
   * The integration row this sweep reports its health on, when it has one.
   *
   * It is deliberately absent for the app-level group. `shopify_orders` is a
   * pipeline of its own — Orders and Shipping read it — and letting an
   * app-level sweep write HEALTHY onto it would make one integration's health
   * row report another's condition. The app-level outcome is recorded in the
   * audit log and in the job summary instead; giving the operator a settings row
   * for a sweep with no credential and no control would be a control that does
   * nothing.
   */
  integrationKey?: IntegrationKey;
}

const ORDER_GROUP: WebhookGroup = {
  name: "orders",
  path: ORDER_WEBHOOK_PATH,
  topics: ORDER_WEBHOOK_TOPICS,
  integrationKey: "shopify_orders",
};

const APP_GROUP: WebhookGroup = {
  name: "app",
  path: APP_WEBHOOK_PATH,
  topics: APP_WEBHOOK_TOPICS,
};

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
function callbackUrlFor(path: string): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

export function orderWebhookCallbackUrl(): string {
  return callbackUrlFor(ORDER_WEBHOOK_PATH);
}

export function appWebhookCallbackUrl(): string {
  return callbackUrlFor(APP_WEBHOOK_PATH);
}

interface SubscriptionNode {
  id: string;
  topic: string;
  endpoint?: { callbackUrl?: string | null } | null;
}

/**
 * Make sure this store is delivering every topic in the group to this app.
 *
 * Returns what happened rather than throwing for a refusal, because a refusal
 * here is an expected state until the Partner Dashboard review completes and
 * the caller is a retry loop that must keep running. A refusal is still
 * recorded — on the integration row and in the audit log — so "we are not
 * receiving orders" is answerable without reading logs.
 */
async function ensureWebhookSubscriptions(
  sellerId: string,
  group: WebhookGroup
): Promise<WebhookSubscriptionOutcome> {
  const callbackUrl = callbackUrlFor(group.path);
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
    if (group.integrationKey) {
      await setIntegrationState(group.integrationKey, { status, detail });
    }
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

  for (const topic of group.topics) {
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
      ? `Could not register ${outcome.refused.length} of ${group.topics.length} ${group.name} topics. ` +
        `First reason: ${outcome.refused[0].reason}`
      : `All ${group.topics.length} ${group.name} topics are already registered.`;

  await recordAudit({
    actorType: "SYSTEM",
    actorId: "shopify-webhooks",
    actorName: "Shopify webhooks",
    action: "webhook.subscriptions_ensured",
    entityType: AUDIT_ENTITY.SELLER,
    entityId: sellerId,
    afterData: {
      group: group.name,
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

/**
 * The six order topics. This is the sweep that repaired the missing intake
 * subscriptions, and it reports on the `shopify_orders` integration row.
 */
export async function ensureOrderWebhookSubscriptions(
  sellerId: string
): Promise<WebhookSubscriptionOutcome> {
  return ensureWebhookSubscriptions(sellerId, ORDER_GROUP);
}

/**
 * The app-level topics — `app/scopes_update` today.
 *
 * Reached from the same scheduled sweep as the order topics, so a subscription
 * the config sync drops is re-created without anybody remembering to re-deploy.
 * It reports nothing to the integration table; see `WebhookGroup.integrationKey`.
 */
export async function ensureAppWebhookSubscriptions(
  sellerId: string
): Promise<WebhookSubscriptionOutcome> {
  return ensureWebhookSubscriptions(sellerId, APP_GROUP);
}
