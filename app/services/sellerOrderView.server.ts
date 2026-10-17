/**
 * The seller's vocabulary for one order, shared by the list and the details page.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ROUTE. The orders list and the order
 * details page answer the same question about the same order, and if each held
 * its own label maps the two would disagree the first time a state was added —
 * one saying "Payment failed" while the other said "Payment processing" about
 * the same bill.
 *
 * THE LIST STILL CARRIES ITS OWN COPY of these maps, deliberately: that file is
 * 1,100 lines of working, tested rendering, and moving its internals in the same
 * change as adding a new page would put a regression in the list on the critical
 * path of shipping the details page. The consolidation is a follow-up, and the
 * duplication is limited to label wording — no logic — with both copies saying
 * the same thing today.
 *
 * THE LANGUAGE RULE IS THE REASON THE SHAPE IS "STORY", NOT "STATUS". A seller
 * reads these pages to answer: which orders did I sell, what do I owe MoonVella,
 * and has the money moved. None of that is answerable in a provider's
 * vocabulary, so no payment-intent id, no Shopify GID, no webhook payload and no
 * provider exception text may reach the screen — not even in small print,
 * because small print is where a card-network identifier ends up in a screenshot
 * somebody emails to their accountant.
 */

import { MONEY_CLEARED, type OrderState } from "./orderState.server";

export const PAYMENT_ACTION_LABEL: Record<string, string> = {
  pay: "Pay now",
  verify: "Complete verification",
  retry: "Try the payment again",
  setup: "Add a payment method",
};

export const FULFILLMENT_LABEL: Record<string, string> = {
  PENDING: "Not shipped yet",
  PROCESSING: "Being prepared",
  PARTIAL: "Partly shipped",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export const SHIPMENT_LABEL: Record<string, string> = {
  PENDING: "Label being prepared",
  BOOKING: "Booking with the carrier",
  BOOKED: "Label created — waiting for the carrier",
  BOOKING_FAILED: "Booking failed — MoonVella is looking at it",
  BOOKING_UNKNOWN: "Booking is being confirmed with the carrier",
  CANCELLING: "Cancellation in progress",
  SHIPPED: "In transit",
  DELIVERED: "Delivered",
  EXCEPTION: "The carrier reported a problem",
  CANCELLED: "Cancelled",
};

/** City, region and country from the stored delivery address, and nothing else. */
export function destinationOf(raw: string | null): string {
  if (!raw) return "—";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "—";
  }
  if (!parsed || typeof parsed !== "object") return "—";
  const parts = [parsed.city, parsed.province || parsed.provinceCode, parsed.country || parsed.countryCode]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length ? parts.join(", ") : "—";
}

export interface PaymentStory {
  label: string;
  tone: "paid" | "pending" | "processing" | "failed" | "cancelled";
  sentence: string;
  action: "none" | "pay" | "verify" | "retry" | "setup";
  actionLabel: string | null;
  needsMethod: boolean;
}

/**
 * What the seller is told about one order's payment.
 *
 * TWO COLUMNS, NOT ONE. `Order.state` is the machine — what has been decided —
 * and `WholesalePayment.status` is what the provider last said. Read alone each
 * misleads: a bill left at FAILED under an order since paid is an old attempt,
 * not a failure.
 */
export function sellerPaymentStory(input: {
  state: OrderState;
  paymentStatus: string | null;
  customerPaymentStatus: string;
  failureReason: string | null;
  hasMethod: boolean;
}): PaymentStory {
  const story = (
    label: string,
    tone: PaymentStory["tone"],
    sentence: string,
    action: PaymentStory["action"]
  ): PaymentStory => {
    const needsMethod = !input.hasMethod && action !== "none";
    return {
      label,
      tone,
      sentence,
      action: needsMethod ? "setup" : action,
      actionLabel: PAYMENT_ACTION_LABEL[needsMethod ? "setup" : action] ?? null,
      needsMethod,
    };
  };

  if (MONEY_CLEARED.has(input.state)) {
    if (input.state === "REFUND_REVIEW") {
      return story(
        "Refund being reviewed",
        "processing",
        "This order was paid for and then cancelled. MoonVella is reviewing the refund and will contact you — nothing further is due right now.",
        "none"
      );
    }
    return story("Paid", "paid", "MoonVella has been paid for this order, so nothing further is due on it.", "none");
  }

  if (input.state === "CANCELLED") {
    return story("Cancelled", "cancelled", "This order was cancelled, so nothing is owed on it.", "none");
  }

  if (["REFUNDED", "PARTIALLY_REFUNDED", "VOIDED"].includes(input.customerPaymentStatus)) {
    return story(
      "Nothing to pay",
      "cancelled",
      "The customer's payment in your store was refunded or cancelled, so MoonVella has not billed you for this order.",
      "none"
    );
  }

  if (input.state === "PAYMENT_ACTION_REQUIRED" || input.paymentStatus === "REQUIRES_ACTION") {
    return story(
      "Confirmation needed",
      "processing",
      "Your bank asked you to confirm this payment and has not had an answer yet. The card is not charged until they say yes — complete the verification they sent you, then try the payment again.",
      "verify"
    );
  }

  if (input.state === "PAYMENT_FAILED" || input.paymentStatus === "FAILED") {
    return story(
      "Payment failed",
      "failed",
      input.failureReason || "The payment could not be completed. You can try again.",
      "retry"
    );
  }

  if (input.state === "PAYMENT_PROCESSING" || input.paymentStatus === "PROCESSING") {
    return story(
      "Payment processing",
      "processing",
      "MoonVella is taking this payment now. It usually finishes in a moment, and the order updates here as soon as the card network confirms it.",
      "none"
    );
  }

  if (input.customerPaymentStatus === "PAID") {
    return story(
      "Payment due",
      "pending",
      "The customer has paid you in your store, so MoonVella will take the wholesale amount for the goods it ships. You can pay now, or let automatic payment take it if it is switched on.",
      "pay"
    );
  }

  return story(
    "Waiting on the customer",
    "pending",
    "The customer has not paid for this order in your store yet. MoonVella only bills you once that payment clears — there is nothing for you to do.",
    "none"
  );
}

/** What the seller is told about an order's fulfilment. */
export function sellerFulfillmentStory(input: { state: OrderState; status: string }): {
  label: string;
  tone: "pending" | "processing" | "paid" | "cancelled";
  sentence: string;
} {
  const label = FULFILLMENT_LABEL[input.status] ?? "Not shipped yet";
  const tone =
    input.status === "DELIVERED" || input.status === "SHIPPED"
      ? ("paid" as const)
      : input.status === "CANCELLED"
        ? ("cancelled" as const)
        : input.status === "PROCESSING" || input.status === "PARTIAL"
          ? ("processing" as const)
          : ("pending" as const);

  if (input.status === "CANCELLED") return { label, tone, sentence: "This order will not ship." };
  if (!MONEY_CLEARED.has(input.state)) {
    return {
      label,
      tone,
      sentence: "MoonVella starts shipping an order once its wholesale payment has cleared.",
    };
  }
  if (input.status === "DELIVERED") return { label, tone, sentence: "The carrier has delivered this order." };
  if (input.status === "SHIPPED") return { label, tone, sentence: "This order is on its way; tracking is below." };
  return { label, tone, sentence: "MoonVella is preparing this order for shipment." };
}
