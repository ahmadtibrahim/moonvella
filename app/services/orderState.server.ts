/**
 * The MoonVella order state machine.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. No order may be fulfilled before
 * the seller's wholesale charge has succeeded. That rule is not a check on the
 * shipping button — it is a property of the graph below: READY_FOR_FULFILLMENT
 * and everything after it are reachable only from PAID, and PAID is only ever
 * written by `markPaid`, whose only caller is the verified Stripe webhook path.
 * A caller that wants to ship an unpaid order has to move it to a state that
 * cannot legally precede shipping, and that move is refused here rather than by
 * whoever wrote the button.
 *
 * WHY EVERY MOVE GOES THROUGH ONE FUNCTION. There are four writers of order
 * state — the Shopify webhook path, the Stripe webhook path, the background
 * queue, and an operator in the admin panel — and they run concurrently. Each
 * one writing `order.state` directly would be four copies of the same rule and
 * four chances to forget the audit row. Funnelling them through `transitionOrder`
 * makes "every move is recorded, and no move is illegal" a property of the
 * code's shape rather than of everyone's diligence.
 *
 * WHY A MOVE TO THE STATE IT IS ALREADY IN IS NOT AN ERROR. Every caller is
 * driven by an external event that can arrive twice — Stripe redelivers for 72
 * hours, the job queue is at-least-once, an operator can press a button twice.
 * Returning `moved: false` and writing nothing makes every one of those callers
 * idempotent for free, and it keeps the transition table a record of what
 * happened rather than of how many times something was asked for.
 */

import { prisma } from "~/db.server";
import type { ActorType, MoonvellaOrderState, Prisma } from "@prisma/client";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

export type OrderState = MoonvellaOrderState;

/** Named so call sites read as states rather than as strings. */
export const ORDER_STATE = {
  RECEIVED: "RECEIVED",
  AWAITING_SELLER_PAYMENT: "AWAITING_SELLER_PAYMENT",
  PAYMENT_PROCESSING: "PAYMENT_PROCESSING",
  PAYMENT_ACTION_REQUIRED: "PAYMENT_ACTION_REQUIRED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAID: "PAID",
  READY_FOR_FULFILLMENT: "READY_FOR_FULFILLMENT",
  FULFILLMENT_REQUESTED: "FULFILLMENT_REQUESTED",
  IN_FULFILLMENT: "IN_FULFILLMENT",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  REFUND_REVIEW: "REFUND_REVIEW",
} as const satisfies Record<string, OrderState>;

/**
 * Which states may follow which.
 *
 * Written as an allow-list rather than a deny-list on purpose: a deny-list lets
 * a state added later be reachable from everywhere by default, which is the
 * wrong default for a rule about money. Here, a new state is unreachable until
 * somebody says how it is reached.
 *
 * The edges that are deliberately absent:
 *   * Nothing reaches PAID except `markPaid`, which the Stripe webhook calls.
 *   * Nothing reaches READY_FOR_FULFILLMENT except from PAID. This is the
 *     fulfilment gate, and it is the absence of an edge rather than a check.
 *   * DELIVERED is reachable only from SHIPPED. A parcel that never shipped
 *     cannot have been delivered, whatever a carrier sweep claims.
 *   * CANCELLED and REFUND_REVIEW are reachable from most places because a
 *     cancellation can arrive at any time; what changes is what they MEAN, and
 *     that is decided by where the order was when it arrived.
 */
const ALLOWED: Record<OrderState, readonly OrderState[]> = {
  RECEIVED: ["AWAITING_SELLER_PAYMENT", "CANCELLED", "PAYMENT_FAILED"],
  AWAITING_SELLER_PAYMENT: [
    "PAYMENT_PROCESSING",
    "PAYMENT_ACTION_REQUIRED",
    "PAYMENT_FAILED",
    "PAID",
    "CANCELLED",
  ],
  PAYMENT_PROCESSING: [
    "PAID",
    "PAYMENT_ACTION_REQUIRED",
    "PAYMENT_FAILED",
    "CANCELLED",
    "REFUND_REVIEW",
  ],
  PAYMENT_ACTION_REQUIRED: [
    "PAYMENT_PROCESSING",
    "PAID",
    "PAYMENT_FAILED",
    "CANCELLED",
    "REFUND_REVIEW",
  ],
  PAYMENT_FAILED: ["PAYMENT_PROCESSING", "PAID", "PAYMENT_ACTION_REQUIRED", "CANCELLED"],
  PAID: ["READY_FOR_FULFILLMENT", "CANCELLED", "REFUND_REVIEW"],
  READY_FOR_FULFILLMENT: ["FULFILLMENT_REQUESTED", "IN_FULFILLMENT", "CANCELLED", "REFUND_REVIEW"],
  FULFILLMENT_REQUESTED: ["IN_FULFILLMENT", "CANCELLED", "REFUND_REVIEW"],
  IN_FULFILLMENT: ["SHIPPED", "REFUND_REVIEW"],
  SHIPPED: ["DELIVERED", "REFUND_REVIEW"],
  DELIVERED: ["REFUND_REVIEW"],
  // Terminal. A cancelled order that starts moving again is a new order.
  CANCELLED: [],
  // Terminal by design: it exists to be noticed. Once a person has decided what
  // happens to the money they move the order themselves, to SHIPPED, DELIVERED
  // or CANCELLED — all of which are reachable from nowhere else, so the decision
  // is the only way forward.
  REFUND_REVIEW: ["CANCELLED", "SHIPPED", "DELIVERED"],
};

/**
 * The states in which the seller's money has cleared, or is past the point of
 * being a question.
 *
 * `REFUND_REVIEW` is included deliberately. It is a state reached AFTER money
 * moved — a cancellation or a refund that needs a person — and treating it as
 * "not paid" would let a cancelled-but-charged order be re-charged by a retry
 * path that reasons from the state alone.
 */
export const MONEY_CLEARED: ReadonlySet<OrderState> = new Set<OrderState>([
  "PAID",
  "READY_FOR_FULFILLMENT",
  "FULFILLMENT_REQUESTED",
  "IN_FULFILLMENT",
  "SHIPPED",
  "DELIVERED",
  "REFUND_REVIEW",
]);

/** States from which nothing further will be asked of the warehouse. */
export const TERMINAL_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  "CANCELLED",
  "DELIVERED",
]);

export function canTransition(from: OrderState, to: OrderState): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

/** Every state an order in `from` could legally move to next. */
export function nextStates(from: OrderState): readonly OrderState[] {
  return ALLOWED[from];
}

/**
 * The states fulfilment work may begin from.
 *
 * Exported because the shipping services gate on it directly, and because a
 * test asserting "an unpaid order cannot be shipped" is only meaningful if it
 * asks the same question the shipping code asks.
 */
export function isFulfillmentUnlocked(state: OrderState): boolean {
  return (
    state === "READY_FOR_FULFILLMENT" ||
    state === "FULFILLMENT_REQUESTED" ||
    state === "IN_FULFILLMENT"
  );
}

export interface StateActor {
  actorType: ActorType;
  actorId: string;
  actorName?: string | null;
}

export class IllegalTransitionError extends Error {
  readonly permanent = true;
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
    detail?: string
  ) {
    super(
      `An order in ${from} cannot move to ${to}.` +
        (detail ? ` ${detail}` : "") +
        ` Legal next states from ${from}: ${ALLOWED[from].join(", ") || "none"}.`
    );
    this.name = "IllegalTransitionError";
  }
}

/** The subset of the Prisma client this file needs, so it works in a transaction. */
type StateClient = {
  order: {
    findUnique: (args: { where: { id: string }; select: { state: true } }) => Promise<{ state: OrderState } | null>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
  };
  orderStateTransition: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
};

export function defaultStateClient(client?: Prisma.TransactionClient): StateClient {
  return (client ?? prisma) as unknown as StateClient;
}

export interface TransitionResult {
  moved: boolean;
  from: OrderState;
  to: OrderState;
}

/**
 * Move an order to `to`, recording who did it and why.
 *
 * Refuses an edge that is not in ALLOWED. Returns `moved: false` for a move to
 * the state the order is already in, which is what makes every caller that is
 * driven by an at-least-once event safe to retry.
 *
 * Reading the current state inside the same transaction as the write is what
 * keeps two concurrent writers from both believing they saw the old value: the
 * second one's read is serialised behind the first one's write, so it sees the
 * new state and either finds its own move already done (`moved: false`) or finds
 * it illegal.
 */
export async function transitionOrder(
  input: {
    orderId: string;
    to: OrderState;
    actor: StateActor;
    reason?: string;
  },
  client?: Prisma.TransactionClient
): Promise<TransitionResult> {
  const db = defaultStateClient(client);

  const order = await db.order.findUnique({
    where: { id: input.orderId },
    select: { state: true },
  });
  if (!order) throw new Error(`Order ${input.orderId} does not exist.`);

  const from = order.state as OrderState;
  if (from === input.to) {
    return { moved: false, from, to: input.to };
  }
  if (!canTransition(from, input.to)) {
    throw new IllegalTransitionError(from, input.to);
  }

  await db.order.update({
    where: { id: input.orderId },
    data: { state: input.to, stateChangedAt: new Date() },
  });
  await db.orderStateTransition.create({
    data: {
      orderId: input.orderId,
      fromState: from,
      toState: input.to,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      actorName: input.actor.actorName ?? null,
      reason: input.reason ?? null,
    },
  });

  /*
   * The audit entry is written alongside the transition row, not instead of it.
   * The two are read by different people for different reasons — the transition
   * table answers "how did this order get here", the audit log answers "what has
   * this system been doing" — and a single write that fed both would have to be
   * one shape, which would make one of them useless.
   */
  await recordAudit(
    {
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      actorName: input.actor.actorName ?? null,
      action: "order.state_changed",
      entityType: AUDIT_ENTITY.ORDER,
      entityId: input.orderId,
      beforeData: { state: from },
      afterData: { state: input.to, reason: input.reason ?? null },
    },
    (client ?? prisma) as never
  );

  return { moved: true, from, to: input.to };
}

/**
 * Move to PAID, and nothing else may.
 *
 * A named function rather than a bare `transitionOrder(..., "PAID")` so that the
 * one write in the system that unlocks fulfilment is findable by name. Its
 * callers are the verified Stripe event handler and the simulated-payment path
 * used by the suites; there is no other route to this state, and the transition
 * graph is what enforces that.
 */
export async function markPaid(
  input: {
    orderId: string;
    actor: StateActor;
    reason?: string;
  },
  client?: Prisma.TransactionClient
): Promise<TransitionResult> {
  return transitionOrder({ ...input, to: "PAID" }, client);
}

/**
 * The states a cancelled order is allowed to land in, decided by whether money
 * moved.
 *
 * Shopify's cancellation is the customer's relationship with the seller and
 * MoonVella is not a party to it; what MoonVella must decide is whether it has
 * already taken the seller's money. Before a charge, a cancellation is simply
 * the end of the order. After one, the seller has paid for goods nobody will
 * ship, and that is a refund decision a person has to make — so the order goes
 * to REFUND_REVIEW, which does nothing on its own.
 */
export function cancellationTarget(state: OrderState): OrderState {
  return MONEY_CLEARED.has(state) ? "REFUND_REVIEW" : "CANCELLED";
}

/**
 * Where a refund that needs a decision lands.
 *
 * After shipment MoonVella does not refund automatically: the goods are with the
 * carrier and the seller may still want them. The order is held for a person
 * instead.
 */
export function refundTarget(state: OrderState): OrderState {
  return state === "SHIPPED" || state === "DELIVERED" ? "REFUND_REVIEW" : "REFUND_REVIEW";
}
