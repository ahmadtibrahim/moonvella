/**
 * Cancelling an order from the operator panel.
 *
 * WHAT THIS RELEASE SUPPORTS, AND WHAT IT REFUSES. An order with NO BOOKED
 * SHIPMENT can be cancelled outright. An order whose parcel carries a label, a
 * pickup or a handoff is REFUSED with an explanation, because cancelling it
 * means coordinating six things — the order, the label, the pickup, the
 * payment, the invoice credit and the stock — and doing four of them is worse
 * than doing none: the goods are written off while the label is still live and
 * the carrier still expects a parcel. README §11 records that workflow as
 * backlog; this file is the half that exists.
 *
 * FOUR SYSTEMS, FOUR OUTCOMES, ONE ROW. The payment provider, the inventory
 * holds and the invoice ledger each fail on their own schedule, and the state
 * after a cancellation is frequently "the order is cancelled and the refund is
 * pending". A single status cannot say that, and the version of a single status
 * that says CANCELLED anyway is the one that reports money returned before it
 * has been.
 *
 * NOTHING IS DELETED OR REWRITTEN. An issued invoice keeps its number, its lines
 * and its total; a correction is a credit note. A charge keeps its history; a
 * refund is a new fact recorded against it. The audit log is append-only and
 * this module only ever adds to it.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { transitionOrder } from "./orderState.server";
import { releaseHoldsForOrder } from "./inventory.server";
import { refundSellerCharge } from "./payments.server";
import { invoicePosition, issueCreditNote } from "./invoicing.server";
import { CANCELLATION_REASONS, reasonLabel, type CancellationReason } from "~/utils/cancellationFields";

export interface CancellationActor {
  id: string;
  name?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// The reason vocabulary lives in a client-safe module because the order page
// renders it in a <select>; a `.server` module cannot be imported by a route
// component. Re-exported here so the server API still reads as one surface.
export { CANCELLATION_REASONS, reasonLabel, type CancellationReason } from "~/utils/cancellationFields";

/** What the confirmation screen shows, and whether the action may proceed. */
export interface CancellationPreview {
  orderId: string;
  orderNumber: string;
  seller: string;
  currency: string;
  allowed: boolean;
  /** Why not, when it is not. Shown verbatim. */
  blocker: string | null;
  payment: { status: string; captured: boolean; action: string; description: string };
  shipment: { booked: boolean; count: number; description: string };
  inventory: { description: string };
  invoice: { number: string | null; balance: number; description: string };
  /** Set when a cancellation has already been taken for this order. */
  existing: {
    status: string;
    reason: string;
    requestedAt: string;
    paymentOutcome: string;
    inventoryOutcome: string;
    invoiceOutcome: string;
    lastError: string | null;
  } | null;
}

/**
 * What WOULD happen, computed without doing any of it.
 *
 * The confirmation screen is required to state the consequence before the
 * operator agrees to it, so the consequence has to be worked out by the same
 * code that will carry it out rather than by a paragraph beside the button that
 * can drift from it. `cancelOrder` calls this and then does what it said.
 */
export async function cancellationPreview(orderId: string): Promise<CancellationPreview> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      seller: { select: { storeName: true } },
      shipments: { select: { id: true, status: true, providerShipmentId: true, trackingNumber: true, pickupStatus: true } },
      wholesalePayment: { select: { id: true, amount: true, currency: true, status: true, capturedAt: true, refundedAmount: true } },
      invoice: {
        select: {
          id: true,
          number: true,
          total: true,
          currency: true,
          status: true,
          // Required by `invoicePosition`, which derives overdue from it.
          dueDate: true,
          allocations: { select: { amount: true } },
          credits: { select: { amount: true, status: true } },
        },
      },
      cancellation: true,
    },
  });

  const payment = order.wholesalePayment;
  const captured = Boolean(payment?.capturedAt) && payment?.status === "SUCCEEDED";

  /*
   * A LABEL IS THE LINE. A shipment with a provider id has been bought, and
   * `pickupStatus` says whether a collection has been arranged. Either is enough
   * to refuse — a booked parcel is the carrier's, and this action does not talk
   * to the carrier.
   */
  const booked = order.shipments.filter((s) => Boolean(s.providerShipmentId));
  const hasLabel = booked.length > 0;
  const hasPickup = order.shipments.some((s) => s.pickupStatus === "SCHEDULED");

  const paymentPlan = (() => {
    if (!payment) {
      return { action: "NONE", description: "No wholesale charge was ever attempted, so there is nothing to stop or refund." };
    }
    if (payment.status === "PROCESSING") {
      return {
        action: "RECONCILE",
        description:
          "A charge is with Stripe and its outcome is not known yet. Reconcile it before cancelling — " +
          "cancelling now could leave a charge with no order against it.",
      };
    }
    if (captured) {
      return {
        action: "REFUND_CAPTURED",
        description:
          `${(payment.amount - payment.refundedAmount) / 100} ${payment.currency} will be refunded to the ` +
          `seller's card. The refund shows as pending until Stripe confirms it.`,
      };
    }
    if (payment.status === "REQUIRES_ACTION") {
      return {
        action: "VOID_AUTHORIZATION",
        description: "The charge was authorised but not taken. The authorisation will be cancelled with the provider.",
      };
    }
    if (payment.status === "SUCCEEDED" && !captured) {
      return {
        action: "RECONCILE",
        description: "Stripe reports this charge as succeeded but no capture time is recorded. Reconcile it before cancelling.",
      };
    }
    return {
      action: "STOP_PENDING",
      description: `The charge is ${payment.status.toLowerCase().replace(/_/g, " ")} and no money was taken. Any pending attempt will be stopped.`,
    };
  })();

  const invoiceBalance = order.invoice
    ? invoicePosition(order.invoice, order.invoice.allocations, order.invoice.credits).balance
    : 0;

  const blocker = hasPickup
    ? `A pickup is scheduled for this order's parcel. Cancelling the collection has to be arranged with the carrier first — this action does not do it, and completing here would leave a truck expecting a parcel that no longer exists.`
    : hasLabel
      ? `A carrier label has been bought for this order (${booked[0].trackingNumber ?? "no tracking number"}). Cancelling the label has to go through the carrier first — this action does not do it, and marking the shipment cancelled without the carrier's confirmation would be a false record.`
      : paymentPlan.action === "RECONCILE"
        ? paymentPlan.description
        : null;

  return {
    orderId: order.id,
    orderNumber: order.shopifyOrderName,
    seller: order.seller.storeName,
    currency: order.currency,
    allowed: blocker === null,
    blocker,
    payment: {
      status: payment?.status ?? "NONE",
      captured,
      action: paymentPlan.action,
      description: paymentPlan.description,
    },
    shipment: {
      booked: hasLabel,
      count: order.shipments.length,
      description: hasLabel
        ? `${booked.length} shipment(s) already carry a carrier label.`
        : order.shipments.length > 0
          ? `${order.shipments.length} shipment record(s), none with a label — nothing has been bought.`
          : "No shipment has been prepared for this order.",
    },
    inventory: {
      description:
        "Any stock reserved for this order is released. Reservations are released at most once, so a repeated request gives nothing back twice.",
    },
    invoice: {
      number: order.invoice?.number ?? null,
      balance: invoiceBalance,
      description: order.invoice
        ? invoiceBalance > 0
          ? `${order.invoice.number} keeps its number, its lines and its total; a credit note is issued for the ${invoiceBalance / 100} ${order.invoice.currency} still outstanding. A credit is not a refund — it reduces what is owed and moves no money.`
          : `${order.invoice.number} is settled and is left exactly as issued; the correction is recorded against the refund.`
        : "No invoice has been issued for this order, so there is nothing to credit.",
    },
    existing: order.cancellation
      ? {
          status: order.cancellation.status,
          reason: reasonLabel(order.cancellation.reason),
          requestedAt: order.cancellation.requestedAt.toISOString(),
          paymentOutcome: order.cancellation.paymentOutcome,
          inventoryOutcome: order.cancellation.inventoryOutcome,
          invoiceOutcome: order.cancellation.invoiceOutcome,
          lastError: order.cancellation.lastError,
        }
      : null,
  };
}

export interface CancellationResult {
  ok: boolean;
  status: string;
  message: string;
  paymentOutcome: string;
  inventoryOutcome: string;
  invoiceOutcome: string;
}

/**
 * Cancel an order that has no booked shipment.
 *
 * THE ORDER OF OPERATIONS IS DELIBERATE, and it is the order that makes a
 * repeated request safe:
 *
 *   1. The row is written FIRST, with `orderId` unique. Two concurrent requests
 *      therefore converge on one row instead of racing, and the loser adopts the
 *      winner's — the same shape the invoice and the reservation use.
 *   2. The order is moved to CANCELLED, which is what stops a charge or a
 *      booking that is already in flight. `bookShipmentForOrder` refuses a
 *      cancelled order explicitly as well, because the state alone is a race.
 *   3. The holds are released, then the money is dealt with. Stock first, because
 *      a failed refund is recoverable by a person and stock held by a cancelled
 *      order is not visible to anybody.
 *   4. Every outcome is written to the row as it happens, so an interruption
 *      leaves a record of how far it got rather than a row that claims it
 *      finished.
 */
export async function cancelOrder(
  orderId: string,
  input: { reason: string; explanation?: string | null },
  actor: CancellationActor
): Promise<CancellationResult> {
  const reason = input.reason as CancellationReason;
  if (!CANCELLATION_REASONS.some((entry) => entry.value === reason)) {
    throw new Error("Choose a cancellation reason.");
  }
  const explanation = (input.explanation ?? "").trim();
  if (reason === "OTHER" && !explanation) {
    // "Other" with no explanation is not a reason, it is a refusal to give one.
    throw new Error("An explanation is required when the reason is Other.");
  }

  const preview = await cancellationPreview(orderId);
  if (preview.existing && preview.existing.status === "CANCELLED") {
    return {
      ok: true,
      status: "CANCELLED",
      message: `${preview.orderNumber} was already cancelled on ${preview.existing.requestedAt.slice(0, 10)}.`,
      paymentOutcome: preview.existing.paymentOutcome,
      inventoryOutcome: preview.existing.inventoryOutcome,
      invoiceOutcome: preview.existing.invoiceOutcome,
    };
  }
  if (!preview.allowed) throw new Error(preview.blocker ?? "This order cannot be cancelled.");

  // 1. The row, then the state, in one transaction.
  const cancellation = await prisma.$transaction(async (tx) => {
    const row = await tx.orderCancellation.upsert({
      where: { orderId },
      create: {
        orderId,
        sellerId: (await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { sellerId: true } })).sellerId,
        reason,
        explanation: explanation || null,
        status: "PROCESSING",
        requestedById: actor.id,
        requestedByName: actor.name ?? null,
        paymentAction:
          preview.payment.action === "REFUND_CAPTURED"
            ? "REFUND_CAPTURED"
            : preview.payment.action === "VOID_AUTHORIZATION"
              ? "VOID_AUTHORIZATION"
              : preview.payment.action === "STOP_PENDING"
                ? "STOP_PENDING"
                : "NONE",
      },
      update: { status: "PROCESSING", reason, explanation: explanation || null },
    });

    await transitionOrder(
      { orderId, to: "CANCELLED", actor: { actorType: "ADMIN_USER", actorId: actor.id, actorName: actor.name ?? null }, reason: `Cancelled: ${reasonLabel(reason)}` },
      tx
    );
    return row;
  });

  // 2. Stock back, at most once.
  let inventoryOutcome = "NOT_APPLICABLE";
  try {
    const released = await prisma.$transaction((tx) =>
      releaseHoldsForOrder(tx, orderId, `Order cancelled: ${reasonLabel(reason)}.`)
    );
    inventoryOutcome = released.released.length > 0 ? "SUCCEEDED" : "NOT_APPLICABLE";
  } catch (error) {
    inventoryOutcome = "FAILED";
    await note(cancellation.id, "inventoryOutcome", inventoryOutcome, error);
  }

  // 3. The money.
  let paymentOutcome = "NOT_APPLICABLE";
  let stripeRefundId: string | null = null;
  let paymentNote: string | null = null;
  try {
    if (preview.payment.action === "REFUND_CAPTURED") {
      const refund = await refundSellerCharge({
        orderId,
        reason: `Order cancelled: ${reasonLabel(reason)}`,
        actor: { actorType: "ADMIN_USER", actorId: actor.id, actorName: actor.name ?? null },
      });
      stripeRefundId = (refund as { refundId?: string })?.refundId ?? null;
      /*
       * PENDING, NOT SUCCEEDED. A refund the provider has accepted is not money
       * that has arrived — the webhook is what confirms it, and this row says so
       * until then. Reporting it as done is how a seller is told they have been
       * repaid before they have.
       */
      paymentOutcome = "PENDING";
      paymentNote = "Refund initiated with the provider; awaiting confirmation.";
    } else if (preview.payment.action === "STOP_PENDING" || preview.payment.action === "VOID_AUTHORIZATION") {
      // Nothing was captured, so no money moves. The order is cancelled, which
      // is what stops the automatic charge from being attempted again.
      paymentOutcome = "SUCCEEDED";
      paymentNote = "No money had been taken, so none is returned.";
    }
  } catch (error) {
    paymentOutcome = "FAILED";
    paymentNote = error instanceof Error ? error.message : "The refund could not be started.";
    await note(cancellation.id, "paymentOutcome", paymentOutcome, error, paymentNote);
  }

  // 4. The ledger: a credit note, never a rewrite of the invoice.
  let invoiceOutcome = "NOT_APPLICABLE";
  let creditNoteId: string | null = null;
  if (preview.invoice.number && preview.invoice.balance > 0) {
    try {
      const credit = await issueCreditNote(
        {
          invoiceId: (await prisma.invoice.findUniqueOrThrow({ where: { orderId }, select: { id: true } })).id,
          amount: preview.invoice.balance,
          reason: `Order cancelled: ${reasonLabel(reason)}${explanation ? ` — ${explanation}` : ""}`,
        },
        actor
      );
      creditNoteId = credit.credit.id;
      invoiceOutcome = "SUCCEEDED";
    } catch (error) {
      invoiceOutcome = "FAILED";
      await note(cancellation.id, "invoiceOutcome", invoiceOutcome, error);
    }
  }

  const status =
    paymentOutcome === "FAILED" || inventoryOutcome === "FAILED" || invoiceOutcome === "FAILED"
      ? "NEEDS_ATTENTION"
      : paymentOutcome === "PENDING"
        ? "CANCELLED"
        : "CANCELLED";

  const finished = await prisma.orderCancellation.update({
    where: { id: cancellation.id },
    data: {
      status,
      paymentOutcome: paymentOutcome as never,
      inventoryOutcome: inventoryOutcome as never,
      invoiceOutcome: invoiceOutcome as never,
      stripeRefundId,
      paymentNote,
      creditNoteId,
      completedAt: new Date(),
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "order.cancelled",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    afterData: {
      reason,
      explanation: explanation || null,
      status,
      paymentAction: preview.payment.action,
      paymentOutcome,
      inventoryOutcome,
      invoiceOutcome,
      stripeRefundId,
      creditNoteId,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return {
    ok: true,
    status: finished.status,
    message: messageFor(finished.status, preview, paymentOutcome),
    paymentOutcome,
    inventoryOutcome,
    invoiceOutcome,
  };
}

/* -------------------------------------------------------------------------- */
/* Resuming, and reconciling an outcome nobody answered                       */
/* -------------------------------------------------------------------------- */

/**
 * Finish a cancellation that was interrupted.
 *
 * WHY A UNIQUE `orderId` IS NOT ENOUGH, which is the point the review makes and
 * the reason this function exists. The unique index proves that ONE cancellation
 * row exists; it proves nothing about whether the work behind it finished. A
 * crash between the row and the refund leaves a row saying PROCESSING with money
 * taken and nothing returned, and a row that says "cancelled" while that is true
 * is the most expensive lie this module could tell.
 *
 * So every side is retried here, and each retry is decided by looking at what
 * the PROVIDER and the LEDGER say rather than at what this row last wrote:
 *
 *   • inventory — releasing is conditional on the row still being HELD, so a
 *     resume releases nothing the first attempt already released.
 *   • payment   — `reconcilePayment` reads the charge's own refunded amount,
 *     which the webhook maintains. A refund that succeeded while our request
 *     timed out is therefore FOUND, not repeated.
 *   • invoice   — a credit note already issued for this cancellation is adopted
 *     by its recorded id rather than issued twice.
 *
 * It is safe to call at any time, including on a healthy cancellation: every
 * side that is already terminal is skipped.
 */
export async function resumeCancellation(orderId: string, actor: CancellationActor) {
  const row = await prisma.orderCancellation.findUnique({ where: { orderId } });
  if (!row) throw new Error("This order has no cancellation to resume.");
  if (row.status === "CANCELLED" && row.paymentOutcome !== "PENDING" && row.paymentOutcome !== "FAILED") {
    return { resumed: false, reason: "already complete" as const, row };
  }

  const preview = await cancellationPreview(orderId);
  let inventoryOutcome = row.inventoryOutcome as string;
  let paymentOutcome = row.paymentOutcome as string;
  let invoiceOutcome = row.invoiceOutcome as string;
  let stripeRefundId = row.stripeRefundId;
  let paymentNote = row.paymentNote;
  let creditNoteId = row.creditNoteId;

  if (inventoryOutcome !== "SUCCEEDED") {
    try {
      const released = await prisma.$transaction((tx) =>
        releaseHoldsForOrder(tx, orderId, "Order cancelled (resumed).")
      );
      inventoryOutcome = released.released.length > 0 ? "SUCCEEDED" : "NOT_APPLICABLE";
    } catch (error) {
      inventoryOutcome = "FAILED";
      await note(row.id, "inventoryOutcome", inventoryOutcome, error);
    }
  }

  if (paymentOutcome !== "SUCCEEDED" && paymentOutcome !== "NOT_APPLICABLE") {
    const reconciled = await reconcilePayment(orderId, preview.payment.action);
    if (reconciled.done) {
      paymentOutcome = "SUCCEEDED";
      paymentNote = reconciled.note;
    } else if (reconciled.retryable) {
      try {
        const refund = await refundSellerCharge({
          orderId,
          reason: `Order cancelled: ${reasonLabel(row.reason)}`,
          actor: { actorType: "ADMIN_USER", actorId: actor.id, actorName: actor.name ?? null },
        });
        stripeRefundId = (refund as { refundId?: string })?.refundId ?? stripeRefundId;
        paymentOutcome = "PENDING";
        paymentNote = "Refund initiated with the provider; awaiting confirmation.";
      } catch (error) {
        const message = error instanceof Error ? error.message : "The refund could not be started.";
        // A refusal that says the charge is ALREADY refunded is success arriving
        // late, not a failure to report.
        if (/already|nothing left to refund/i.test(message)) {
          paymentOutcome = "SUCCEEDED";
          paymentNote = "The charge was already refunded.";
        } else {
          paymentOutcome = "FAILED";
          paymentNote = message;
          await note(row.id, "paymentOutcome", paymentOutcome, error, message);
        }
      }
    } else {
      paymentOutcome = reconciled.outcome;
      paymentNote = reconciled.note;
    }
  }

  if (invoiceOutcome !== "SUCCEEDED" && preview.invoice.number && preview.invoice.balance > 0) {
    if (creditNoteId) {
      invoiceOutcome = "SUCCEEDED";
    } else {
      try {
        const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId }, select: { id: true } });
        const credit = await issueCreditNote(
          {
            invoiceId: invoice.id,
            amount: preview.invoice.balance,
            reason: `Order cancelled: ${reasonLabel(row.reason)}`,
          },
          actor
        );
        creditNoteId = credit.credit.id;
        invoiceOutcome = "SUCCEEDED";
      } catch (error) {
        invoiceOutcome = "FAILED";
        await note(row.id, "invoiceOutcome", invoiceOutcome, error);
      }
    }
  }

  const status =
    paymentOutcome === "FAILED" || inventoryOutcome === "FAILED" || invoiceOutcome === "FAILED"
      ? "NEEDS_ATTENTION"
      : "CANCELLED";

  const updated = await prisma.orderCancellation.update({
    where: { id: row.id },
    data: {
      status,
      paymentOutcome: paymentOutcome as never,
      inventoryOutcome: inventoryOutcome as never,
      invoiceOutcome: invoiceOutcome as never,
      stripeRefundId,
      paymentNote,
      creditNoteId,
      completedAt: new Date(),
    },
  });

  return { resumed: true, reason: status === "CANCELLED" ? ("complete" as const) : ("attention" as const), row: updated };
}

/**
 * Ask the provider what actually happened, before doing anything again.
 *
 * A refund request that timed out is the case this exists for: our row does not
 * know whether Stripe created the refund, and retrying blind is how a seller is
 * refunded twice. The charge's own `refundedAmount` is maintained by the webhook,
 * which is the provider's word rather than our request's, so it decides.
 */
export async function reconcilePayment(
  orderId: string,
  expectedAction: string
): Promise<{ done: boolean; retryable: boolean; outcome: string; note: string }> {
  const payment = await prisma.wholesalePayment.findUnique({
    where: { orderId },
    select: { amount: true, refundedAmount: true, status: true, capturedAt: true },
  });
  if (!payment) {
    return { done: true, retryable: false, outcome: "NOT_APPLICABLE", note: "No charge was recorded for this order." };
  }

  if (expectedAction === "REFUND_CAPTURED" || Boolean(payment.capturedAt)) {
    if (payment.refundedAmount >= payment.amount && payment.amount > 0) {
      return { done: true, retryable: false, outcome: "SUCCEEDED", note: "The provider confirms the charge was refunded." };
    }
    if (payment.refundedAmount > 0) {
      return {
        done: false,
        retryable: true,
        outcome: "PENDING",
        note: `A partial refund of ${payment.refundedAmount} is recorded; the remainder is being requested.`,
      };
    }
    return { done: false, retryable: true, outcome: "PENDING", note: "No refund is recorded yet; requesting it." };
  }

  return { done: true, retryable: false, outcome: "SUCCEEDED", note: "No money had been taken, so none is returned." };
}

/** Record a failure on the row without losing the outcomes that did succeed. */
async function note(
  id: string,
  field: "inventoryOutcome" | "paymentOutcome" | "invoiceOutcome",
  outcome: string,
  error: unknown,
  detail?: string | null
) {
  await prisma.orderCancellation.update({
    where: { id },
    data: {
      [field]: outcome as never,
      lastError: (detail ?? (error instanceof Error ? error.message : "unknown error")).slice(0, 500),
    } as never,
  });
}

function messageFor(status: string, preview: CancellationPreview, paymentOutcome: string): string {
  if (status === "NEEDS_ATTENTION") {
    return `${preview.orderNumber} is cancelled, but something did not finish. Open the order to see which side needs attention — the order is cancelled, and that is not the same as the money having moved.`;
  }
  if (paymentOutcome === "PENDING") {
    return `${preview.orderNumber} is cancelled. The refund is pending with the provider and will show as confirmed when it settles.`;
  }
  return `${preview.orderNumber} is cancelled.`;
}
