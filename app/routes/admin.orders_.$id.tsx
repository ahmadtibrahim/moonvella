import { Link, useLoaderData, useActionData, Form, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta, userCan } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import {
  createOrReuseWholesalePayment,
  applyStripeEvent,
  refundSellerCharge,
  stripeMode,
} from "~/services/payments.server";
import { isSimulatedId } from "~/services/stripeMode.server";
import { chargeWholesaleOrder, getBillingSettings } from "~/services/sellerBilling.server";
import { chargeSellerForOrder } from "~/services/sellerCharge.server";
import {
  MONEY_CLEARED,
  isFulfillmentUnlocked,
  nextStates,
  transitionOrder,
  type OrderState,
} from "~/services/orderState.server";
import { AUDIT_ENTITY } from "~/services/audit.server";
import {
  getQuotesForOrder,
  selectQuote,
  bookShipmentForOrder,
  voidShipment,
  syncShipmentTracking,
} from "~/services/shipping.server";
import { resolveFulfillmentOrders } from "~/services/shopifyFulfillment.server";
import { maskedEshipperAccount, eshipperMode } from "~/services/eshipper.server";
import {
  addManualShipment,
  addOrderPackage,
  advanceShipment,
  type ShipmentAdvanceEvent,
} from "~/services/fulfillment.server";
import {
  acceptFulfillmentRequest,
  rejectFulfillmentRequest,
  closeFulfillmentRequest,
  cancelFulfillmentRequest,
} from "~/services/fulfillmentRequest.server";
import { getIntegrationState } from "~/services/integrationHealth.server";
import { groupOrderLinesByOrigin } from "~/services/origins.server";
import {
  addressStatus,
  loadSubjectAddress,
  applySuggestedAddress,
  recordAddressOverride,
  recordValidation,
  validateAddress,
} from "~/services/addressValidation.server";
import { AddressGateCard } from "~/components/AddressGateCard";
import { addressSubject, addressSubjectLabel } from "~/utils/addressSubject";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requirePermission(request, "orders.view");
  const order = await prisma.order.findUnique({
    where: { id: String(params.id) },
    include: {
      seller: true,
      items: true,
      packages: true,
      // The dock is read with both: a shipment's card has to say where it was
      // collected from, and a quote is only valid for the dock it was priced
      // from — §1's rule that a quote, a booking and a collection are the same
      // question asked three times.
      shipments: { include: { items: true, originLocation: { select: { code: true, name: true } } } },
      shippingQuotes: { orderBy: { totalAmount: "asc" }, include: { originLocation: { select: { code: true, name: true } } } },
      wholesalePayment: {
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          subtotal: true,
          shippingAmount: true,
          taxAmount: true,
          requiresAction: true,
          failureMessage: true,
          provider: true,
          billingMode: true,
          // The two figures a refund is decided from: what was charged, and how
          // much of it has already gone back. Without them this page could only
          // offer a refund box with no ceiling on it.
          refundedAmount: true,
          providerPaymentIntentId: true,
          attempts: {
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, status: true, failureMessage: true, requiresAction: true, amount: true, createdAt: true },
          },
        },
      },
      fulfillmentRequest: true,
    },
  });
  if (!order) throw new Response("Order not found", { status: 404 });
  const billing = await getBillingSettings(order.sellerId);
  const shopifyFulfillment = await getIntegrationState("shopify_fulfillment");
  const mode = await stripeMode();
  const payment = order.wholesalePayment;

  /*
   * The order's two histories, read here and merged into one timeline.
   *
   * They are separate tables answering separate questions — OrderStateTransition
   * is "how did THIS order get here" and AuditLog is "what has this system been
   * doing" — and the operator reading this screen wants them interleaved, not
   * side by side. The alternative rejected is showing only the state machine:
   * every payment action is audited by the service that performs it, and a
   * timeline that omitted those rows would show an order reaching PAID with
   * nothing on the page saying who charged it.
   *
   * The payment row's own audit rows are included as well as the order's, and
   * that is not a tidiness choice: a charge and a refund are audited against the
   * PAYMENT record (that is the entity they change), so a timeline that read
   * only the order would leave the two actions this page performs — charge and
   * refund — invisible on the page that performed them.
   */
  const [stateTransitions, auditRows] = await Promise.all([
    prisma.orderStateTransition.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: AUDIT_ENTITY.ORDER, entityId: order.id },
          ...(payment ? [{ entityType: AUDIT_ENTITY.PAYMENT, entityId: payment.id }] : []),
        ],
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  /*
   * Merged into ISO strings rather than Date objects: the sort has to be total,
   * and the two sources come back from two different tables. Formatting happens
   * once, in the component, so the two kinds of row cannot end up rendered in
   * two different date styles.
   */
  const timeline = [
    ...stateTransitions.map((t) => ({
      kind: "state" as const,
      id: t.id,
      at: t.createdAt.toISOString(),
      fromState: t.fromState as OrderState | null,
      toState: t.toState as OrderState,
      actorType: t.actorType as string,
      actorName: t.actorName,
      reason: t.reason,
    })),
    ...auditRows.map((a) => ({
      kind: "audit" as const,
      id: a.id,
      at: a.createdAt.toISOString(),
      action: a.action,
      actorType: a.actorType as string,
      actorName: a.actorName,
      beforeData: a.beforeData,
      afterData: a.afterData,
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  /*
   * Which dock each line leaves from, resolved here so the page can SHOW the
   * split rather than let an operator discover it at the first booking refusal.
   *
   * §1 makes an order whose items come from two docks into two shipments, each
   * quoted and booked independently. Nothing about that is visible from the
   * order's own columns, so without this the second parcel is found only when
   * somebody asks why half the order has no label. A line with no resolvable
   * origin becomes its own group with `ready: false`, which is also how §1's
   * "Pickup location required, and booking is blocked" reaches this page.
   */
  const grouping = await groupOrderLinesByOrigin(
    order.items.map((item) => ({
      orderItemId: item.id,
      variantId: item.variantId,
      sku: item.sku,
      quantity: item.quantity,
    }))
  );

  /*
   * The addresses this order's labels will carry, with their verdicts. Read
   * here rather than in the component for the same reason the gate is: the page
   * must not draw a Book button it already knows will be refused, and the
   * delivery end belongs to the order while each pickup end belongs to a dock —
   * an order shipping from two docks has two of them and both have to be
   * accepted.
   */
  const collectionGroups = await Promise.all(
    grouping.groups.map(async (group) => ({
      key: group.key,
      ready: group.ready,
      reason: group.reason,
      code: group.location?.code ?? null,
      name: group.location?.name ?? null,
      lines: group.lines.length,
      quantity: group.lines.reduce((sum, line) => sum + line.quantity, 0),
      skus: [...new Set(group.lines.map((line) => line.sku))],
      locationId: group.location?.id ?? null,
      addressGate: group.location ? await addressStatus("PICKUP", group.location.id) : null,
    }))
  );

  const refundableMinor = payment ? Math.max(0, payment.amount - payment.refundedAmount) : 0;

  /*
   * WHY THERE IS NO REFUND BOX, when there is not one.
   *
   * Each of these is a condition under which `refundSellerCharge` refuses, and
   * the refusal is stated here in the same words so the screen and the refusal
   * agree. The service re-decides all of it against the same row — a stale page
   * and a concurrent refund both land on its guard, not on this one — so this is
   * display, and the display is deliberately the service's own sentence rather
   * than a softer one of our own.
   */
  let refundBlock: string | null = null;
  if (!payment) refundBlock = "This order has no wholesale charge to refund.";
  else if (payment.status !== "SUCCEEDED" && payment.status !== "PARTIALLY_REFUNDED")
    refundBlock = `Only a charge that succeeded can be refunded; this one is ${payment.status}.`;
  else if (refundableMinor <= 0) refundBlock = "The whole charge has already been refunded.";
  else if (!payment.providerPaymentIntentId)
    refundBlock = "This charge has no provider payment to refund against.";
  else if (isSimulatedId(payment.providerPaymentIntentId))
    refundBlock =
      "This is a simulated charge recorded while Stripe was in simulated mode. " +
      "There is no provider payment behind it, so there is nothing to refund.";
  else if (mode !== "test" && mode !== "live")
    refundBlock = `Stripe is in ${mode} mode, so a refund would be refused before it reached the provider.`;

  /*
   * WHY THE CHARGE BUTTON IS NOT DRAWN.
   *
   * Money that has already cleared is the one case the charge must never be
   * offered for, and it is asked of the state machine rather than of the payment
   * row: REFUND_REVIEW also means money moved, and a retry reasoned from
   * `status === "SUCCEEDED"` alone would re-charge an order that was refunded.
   * The customer's own payment is the second: MoonVella charges the seller for a
   * sale the store has been paid for, so an order whose Shopify payment has not
   * landed has nothing to charge yet — a "not yet" the service reports rather
   * than throws.
   */
  const moneyCleared = MONEY_CLEARED.has(order.state as OrderState);
  let chargeBlock: string | null = null;
  if (moneyCleared) chargeBlock = "The seller's money has already cleared on this order.";
  else if (order.state === "CANCELLED") chargeBlock = "This order was cancelled, so nothing is owed on it.";
  else if (order.paymentStatus !== "PAID")
    chargeBlock = "The store has not been paid for this order yet, so there is nothing to charge. The charge is made when the customer's payment clears.";

  return {
    order,
    collection: {
      split: grouping.split,
      blockers: grouping.blockers,
      groups: collectionGroups,
      deliveryGate: await addressStatus("DELIVERY", order.id),
    },
    mode,
    shopifyFulfillment,
    /*
     * Only the override control is gated on this, and the gate is drawn from it
     * for the same reason the shipment page draws it: an owner who is not told
     * they are the only one who can clear a refusal phones someone. The rule
     * itself is enforced in the service against the stored role, so a forged
     * form is refused whatever this flag says.
     */
    isOwner: user.role === "OWNER",
    /*
     * Fulfillment is its own capability (orders.fulfill), and it is asked here
     * rather than only in the action so a support user is not shown a button
     * that can only ever answer 403. The action asks again; hiding a control is
     * presentation, and presentation is not authorisation.
     */
    canFulfill: userCan(user, "orders.fulfill"),
    machine: {
      current: order.state as OrderState,
      legalNext: nextStates(order.state as OrderState),
      fulfillmentUnlocked: isFulfillmentUnlocked(order.state as OrderState),
      moneyCleared,
    },
    refund: {
      block: refundBlock,
      refundableMinor,
      chargedMinor: payment?.amount ?? 0,
      refundedMinor: payment?.refundedAmount ?? 0,
      currency: payment?.currency ?? order.currency,
    },
    chargeBlock,
    timeline,
    eshipper: { mode: await eshipperMode(), account: await maskedEshipperAccount() },
    billing: {
      mode: billing.mode,
      autoPayEnabled: billing.autoPayEnabled,
      maxAmountPerOrder: billing.maxAmountPerOrder,
      maxShippingCharge: billing.maxShippingCharge,
    },
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "orders.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const orderId = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  /*
   * Starting fulfilment is its own capability (orders.fulfill), and it is asked
   * BEFORE the try below for a reason that is easy to miss: requirePermission
   * signals a refusal by throwing a Response, and the catch that turns service
   * errors into a message on the page would turn a 403 into "Operation failed."
   * — a permission refusal reported as a system fault, which is exactly the
   * confusion the permission module exists to avoid.
   *
   * This is not an approval step. There is no second person and no second
   * request: the same operator who may charge this order may start it, and the
   * capability is the one the role table already grants for this action.
   */
  if (intent === "fulfill") await requirePermission(request, "orders.fulfill");

  try {
    if (intent === "add_package") {
      // Through the shared helper, which audits the change and withdraws the
      // quotes the change invalidated.
      await addOrderPackage(
        orderId,
        {
          count: Math.max(1, Number(form.get("count") || 1)),
          length: Number(form.get("length")),
          width: Number(form.get("width")),
          height: Number(form.get("height")),
          weight: Number(form.get("weight")),
        },
        actor
      );
    } else if (intent === "get_quotes") {
      await getQuotesForOrder(orderId, actor);
    } else if (intent === "select_quote") {
      await selectQuote(orderId, String(form.get("quoteId")), actor);
    } else if (intent === "create_payment") {
      await createOrReuseWholesalePayment(orderId);
    } else if (intent === "simulate_paid") {
      const payment = await prisma.wholesalePayment.findUnique({ where: { orderId } });
      if (!payment || !String(payment.providerPaymentIntentId || "").startsWith("sim_")) {
        throw new Error("Simulated events are only allowed for simulated intents.");
      }
      await applyStripeEvent({
        id: `sim_evt_${orderId}_${Date.now()}`,
        type: "payment_intent.succeeded",
        data: { object: { id: payment.providerPaymentIntentId, metadata: { orderId } } },
      });
    } else if (intent === "manual_pay") {
      const result = await chargeWholesaleOrder(orderId, { trigger: "MANUAL", actor });
      if (!result.ok) return { error: result.error || "Manual payment failed." };
    } else if (intent === "charge") {
      /*
       * THE RETRY FLAG IS DECIDED FROM THE STORED ROW, NEVER FROM THE FORM.
       *
       * `retry: true` bumps `paymentVersion`, and the version is half of the
       * Stripe idempotency key — so a flag the browser could set is a browser
       * choosing whether the next attempt is "the same charge again" or "a new
       * charge". A double-submitted form carrying that flag could produce two
       * PaymentIntents for one order. Read from the order instead: a charge that
       * is already marked FAILED is the one case Stripe will not reconsider
       * under the same key, and it is the only case where a retry is a retry.
       *
       * Everything else — whether money has cleared, whether the store has been
       * paid, whether the order is cancelled — is decided inside
       * `chargeSellerForOrder` from the same row, so a stale page cannot talk it
       * into a second charge either.
       */
      const current = await prisma.order.findUnique({
        where: { id: orderId },
        select: { state: true, wholesalePayment: { select: { status: true } } },
      });
      if (!current) throw new Error("That order does not exist.");
      const retry =
        current.state === "PAYMENT_FAILED" || current.wholesalePayment?.status === "FAILED";

      const outcome = await chargeSellerForOrder({
        orderId,
        trigger: "MANUAL",
        actor: { actorType: "ADMIN_USER", actorId: user.id, actorName: user.name },
        retry,
      });
      /*
       * `ok: false` is not always a failure. "The store has not been paid yet"
       * and "the seller has no saved card" are answers, and the operator needs
       * the sentence rather than a red box that reads as a system fault. The
       * messages are the service's own, and the provider's raw text stays on the
       * payment row where the attempts list below renders it.
       */
      if (!outcome.ok) return { error: outcome.message || "The charge was not completed." };
    } else if (intent === "refund") {
      const raw = String(form.get("amount") || "").trim();
      const reason = String(form.get("reason") || "").trim();
      if (!reason) {
        throw new Error("A refund reason is required: it is what the audit row and the provider's metadata will say this was for.");
      }
      const amountMinor = raw ? Math.round(Number(raw) * 100) : undefined;
      if (amountMinor !== undefined && (!Number.isFinite(amountMinor) || amountMinor <= 0)) {
        throw new Error("Enter a refund amount greater than zero, or leave it blank to refund the remainder.");
      }

      /*
       * The ceiling, checked here as well as in the service. The service is the
       * authority — it re-reads the payment row and refuses more than the
       * remainder, so a stale page or a concurrent refund cannot get past it —
       * and this check exists for the message: the operator is told the
       * arithmetic before a provider call is attempted at all.
       */
      const ceiling = await prisma.wholesalePayment.findUnique({
        where: { orderId },
        select: { amount: true, refundedAmount: true, currency: true },
      });
      if (!ceiling) throw new Error("This order has no charge to refund.");
      const refundable = ceiling.amount - ceiling.refundedAmount;
      const requested = amountMinor ?? refundable;
      if (requested > refundable) {
        throw new Error(
          `Refusing to refund ${(requested / 100).toFixed(2)} when only ${(refundable / 100).toFixed(2)} ` +
            `${ceiling.currency} of the ${(ceiling.amount / 100).toFixed(2)} charged remains refundable.`
        );
      }

      /*
       * No audit row is written here. `refundSellerCharge` writes one — with the
       * amount, the running total, the provider's refund id and the reason — and
       * a second row from this route would describe the same event twice in the
       * one place that is not allowed to be ambiguous.
       */
      await refundSellerCharge({
        orderId,
        amountMinor: requested,
        reason,
        actor: { actorType: "ADMIN_USER", actorId: user.id, actorName: user.name },
      });
    } else if (intent === "fulfill") {
      /*
       * §8'S GATE, ASKED OF THE STATE MACHINE.
       *
       * `isFulfillmentUnlocked` is the same question the shipping services ask,
       * and it is asked against the state read HERE rather than against anything
       * the form posted. The movement itself then goes through `transitionOrder`,
       * which re-reads the state inside its own transaction and refuses an edge
       * the graph does not contain — so an order that slid back to
       * PAYMENT_FAILED between this read and that write is stopped by the graph,
       * not by this check having been right a moment earlier.
       */
      const current = await prisma.order.findUnique({
        where: { id: orderId },
        select: { state: true },
      });
      if (!current) throw new Error("That order does not exist.");
      if (!isFulfillmentUnlocked(current.state as OrderState)) {
        throw new Error(
          `This order is in ${current.state}, so warehouse work cannot start on it. Fulfilment begins from ` +
            `READY_FOR_FULFILLMENT, FULFILLMENT_REQUESTED or IN_FULFILLMENT, and an order reaches those only ` +
            `after the seller's charge has succeeded.`
        );
      }
      await transitionOrder({
        orderId,
        to: "IN_FULFILLMENT",
        actor: { actorType: "ADMIN_USER", actorId: user.id, actorName: user.name },
        reason: "An operator started fulfilment.",
      });
    } else if (intent === "check_address") {
      // The same two intents the shipment page carries, on the screen where an
      // order is booked whole. A refusal names an address, so the address has to
      // be fixable where the refusal is read.
      const subject = addressSubject(form);
      const address = await loadSubjectAddress(subject.type, subject.id);
      if (!address) throw new Error("That address could not be found.");
      const outcome = await validateAddress(address, { refresh: true });
      await recordValidation({ subjectType: subject.type, subjectId: subject.id, outcome });
      if (outcome.verdict === "ACCEPTED") return redirect(`/admin/orders/${orderId}`);
      return {
        error: `${addressSubjectLabel(subject.type)}: ${
          outcome.reason ?? "the address needs review before it can be booked against."
        }`,
      };
    } else if (intent === "apply_suggestion") {
      /*
       * Google's own values, read back from the stored verdict inside the
       * service rather than posted by this form — a suggestion the browser
       * could supply is a suggestion Google never gave. The role rule is there
       * too, checked against the stored account.
       *
       * A successful apply redirects like the check above it: the address on
       * the page has changed, so the page has to be re-read rather than
       * annotated, and the panel then shows the new address under its new
       * verdict.
       */
      const subject = addressSubject(form);
      const result = await applySuggestedAddress({
        subjectType: subject.type,
        subjectId: subject.id,
        actorId: user.id,
      });
      if (!result.ok) return { error: result.error };
      return redirect(`/admin/orders/${orderId}`);
    } else if (intent === "override_address") {
      // The role check that matters is in the service, against the stored
      // account: a role posted by this form would be a role the submitter chose.
      const subject = addressSubject(form);
      const result = await recordAddressOverride({
        subjectType: subject.type,
        subjectId: subject.id,
        actorId: user.id,
        reason: String(form.get("reason") || ""),
      });
      if (!result.ok) return { error: result.error };
    } else if (intent === "book_shipment") {
      await bookShipmentForOrder(orderId, { quoteId: String(form.get("quoteId") || "") || undefined }, actor);
    } else if (intent === "void_shipment") {
      await voidShipment(String(form.get("shipmentId")), actor);
    } else if (intent === "retry_sync") {
      await syncShipmentTracking(String(form.get("shipmentId")), actor);
    } else if (intent === "resolve_fo") {
      await resolveFulfillmentOrders(orderId);
    } else if (intent === "manual_shipment") {
      await addManualShipment(
        orderId,
        {
          carrier: String(form.get("carrier") || ""),
          trackingNumber: String(form.get("trackingNumber") || ""),
          trackingUrl: String(form.get("trackingUrl") || "") || null,
          notifyCustomer: form.get("notifyCustomer") === "on",
        },
        actor
      );
    } else if (intent === "advance_shipment") {
      const event = String(form.get("event") || "");
      const allowed: ShipmentAdvanceEvent[] = [
        "packed",
        "handed_to_carrier",
        "shipped",
        "in_transit",
        "delivered",
        "exception",
      ];
      if (!allowed.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      await advanceShipment(String(form.get("shipmentId")), event as ShipmentAdvanceEvent, actor, {
        notifyCustomer: form.get("notifyCustomer") === "on",
      });
    } else if (intent === "accept_fr") {
      await acceptFulfillmentRequest(orderId, actor);
    } else if (intent === "reject_fr") {
      await rejectFulfillmentRequest(orderId, String(form.get("reason") || ""), actor);
    } else if (intent === "close_fr") {
      await closeFulfillmentRequest(orderId, actor);
    } else if (intent === "cancel_fr") {
      await cancelFulfillmentRequest(orderId, String(form.get("reason") || ""), actor);
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect(`/admin/orders/${orderId}`);
}

const card: React.CSSProperties = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" };
const input: React.CSSProperties = { padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.82rem", boxSizing: "border-box" };
const btn = (color: string): React.CSSProperties => ({ padding: "0.45rem 0.85rem", border: `1px solid ${color}`, borderRadius: 6, background: "white", color, fontSize: "0.72rem", fontWeight: 600, cursor: "pointer" });
const th: React.CSSProperties = { padding: "0.4rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };

/**
 * The provider mode is one of disabled | simulated | test | live. It used to be
 * a boolean-ish "real | simulated" that rendered as "Stripe test" whatever the
 * key was, which would have said "test" over a live key. Naming all four states
 * is the point of the mode.
 */
const STRIPE_MODE_LABEL: Record<string, string> = {
  test: "Stripe test (sandbox)",
  live: "Stripe LIVE",
  simulated: "simulated (no provider calls)",
  disabled: "disabled (Disconnect)",
};

function money(cents: number, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * THE PROVIDER MODE, AS A BADGE RATHER THAN A SENTENCE.
 *
 * §8 asks for a Stripe test/live indicator that is prominent, and prominence is
 * the whole feature: an operator pressing "Charge the seller" on a live key is
 * spending real money, and the difference between that and a sandbox has to be
 * readable from across a desk rather than found in a paragraph. The four words
 * are the four modes — a two-word "test / live" indicator would have to call
 * "no key configured" one of them, and both answers would be lies.
 */
const STRIPE_MODE_BADGE: Record<string, { text: string; background: string; border: string; color: string }> = {
  test: { text: "TEST MODE", background: "#fef3c7", border: "#fcd34d", color: "#92400e" },
  live: { text: "LIVE", background: "#fee2e2", border: "#fca5a5", color: "#991b1b" },
  simulated: { text: "SIMULATED", background: "#e0e7ff", border: "#a5b4fc", color: "#3730a3" },
  disabled: { text: "DISCONNECTED", background: "#e2e8f0", border: "#cbd5e1", color: "#334155" },
};

/** Where the order is in the pipeline, coloured the way the orders list colours it. */
const STATE_COLOR: Record<string, string> = {
  RECEIVED: "#64748b",
  AWAITING_SELLER_PAYMENT: "#b45309",
  PAYMENT_PROCESSING: "#0369a1",
  PAYMENT_ACTION_REQUIRED: "#b45309",
  PAYMENT_FAILED: "#dc2626",
  PAID: "#0369a1",
  READY_FOR_FULFILLMENT: "#059669",
  FULFILLMENT_REQUESTED: "#059669",
  IN_FULFILLMENT: "#059669",
  SHIPPED: "#0369a1",
  DELIVERED: "#059669",
  CANCELLED: "#64748b",
  REFUND_REVIEW: "#dc2626",
};

/**
 * The delivery address, as the order screen shows it.
 *
 * THIS RENDERING IS FOR THIS PAGE ONLY. The fulfillment queue deliberately does
 * not have it — see admin.fulfillment.tsx, where the destination is reduced to
 * city/region/country because that queue is read by people preparing a parcel,
 * not by people who need the customer's street, email or phone. Here the address
 * is what a label will carry and a booking refusal will name, so it is shown in
 * full, and the keys are read rather than the blob being spread into the DOM.
 */
function addressLines(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /*
     * A blob that will not parse is shown verbatim rather than dropped. It is
     * still the address the order was taken with, and a page that silently
     * rendered nothing would say "no address" about an order that has one.
     */
    return [raw];
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  const street = [text(parsed.address1) ?? text(parsed.address), text(parsed.address2)].filter(Boolean);
  const cityLine = [
    text(parsed.city),
    text(parsed.province) ?? text(parsed.provinceCode),
    text(parsed.zip) ?? text(parsed.postalCode),
  ]
    .filter(Boolean)
    .join(", ");
  return [
    text(parsed.name),
    text(parsed.company),
    ...street,
    cityLine || null,
    text(parsed.country) ?? text(parsed.countryCode),
  ].filter((line): line is string => Boolean(line));
}

/**
 * One audit row's payload, as key/value lines.
 *
 * The stored value is a JSON string. Rendered raw it is unreadable, and rendered
 * as an object it would not render at all — so it is parsed into lines, and a
 * payload that does not parse falls back to the string it was read from rather
 * than to nothing: the value is the historical record, and a timeline entry that
 * showed a dash where the detail was would be worse than a long line.
 */
function auditDetails(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (!parsed || typeof parsed !== "object") return [String(parsed)];
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
    const text =
      value === null || value === undefined
        ? "—"
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return `${key}: ${text}`;
  });
}

export default function AdminOrderDetail() {
  const { order, collection, mode, eshipper, billing, shopifyFulfillment, isOwner, canFulfill, machine, refund, chargeBlock, timeline } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const paid = order.wholesalePaymentStatus === "SUCCEEDED";
  const selectedQuote = order.shippingQuotes.find((q) => q.selected) ?? null;
  const cheapest = order.shippingQuotes[0] ?? null;
  const fastest = order.shippingQuotes.filter((q) => q.transitDays !== null).sort((a, b) => (a.transitDays! - b.transitDays!))[0] ?? null;
  const badge = STRIPE_MODE_BADGE[mode] ?? STRIPE_MODE_BADGE.disabled;
  const deliveryAddress = addressLines(order.shippingAddress);
  const payment = order.wholesalePayment;
  /*
   * The same rule the `charge` action applies, so the button's words and the
   * request it sends agree: a charge that is marked FAILED — in the payment row
   * or in the order's state — is the only one that becomes a deliberate retry,
   * and the retry is what changes the provider's idempotency key.
   */
  const chargeIsRetry = machine.current === "PAYMENT_FAILED" || payment?.status === "FAILED";

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/orders" style={{ color: "#082a4a" }}>&larr; All orders</Link>
      </p>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>{order.shopifyOrderName}</h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
        Seller: {order.seller.storeName} · {order.supplierReference}
      </p>
      {/* §8's test/live indicator, above everything an operator can press. */}
      <p style={{ marginBottom: "0.75rem", display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span
          role="status"
          style={{
            display: "inline-block",
            padding: "0.3rem 0.7rem",
            borderRadius: 999,
            border: `1px solid ${badge.border}`,
            background: badge.background,
            color: badge.color,
            fontSize: "0.72rem",
            fontWeight: 700,
            letterSpacing: "0.06em",
          }}
        >
          {badge.text}
        </span>
        <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
          Stripe provider mode: {STRIPE_MODE_LABEL[mode] ?? mode}
        </span>
      </p>
      <p style={{ marginBottom: "1.5rem" }}>
        <Link to={`/admin/packing/${order.id}`} className="mv-btn mv-btn-primary" style={{ display: "inline-block", padding: "0.45rem 0.9rem", background: "#082a4a", color: "white", borderRadius: 6, fontSize: "0.78rem", fontWeight: 600, textDecoration: "none" }}>
          Pack order
        </Link>
      </p>

      {actionData?.error ? <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>{actionData.error}</div> : null}

      {/* §8: the pipeline state, and whether fulfilment may start. The two are
          drawn together because the second is a fact about the first, and an
          operator who has to open another screen to learn why the button is
          missing will press it somewhere else instead. */}
      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Pipeline state</h2>
        <div style={{ fontSize: "0.85rem", lineHeight: 1.8 }}>
          <div>
            State: <strong style={{ color: STATE_COLOR[machine.current] ?? "#334155" }}>{machine.current}</strong>
            <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>
              {" "}· changed {new Date(order.stateChangedAt).toLocaleString()}
            </span>
          </div>
          <div style={{ fontSize: "0.78rem", color: "#64748b" }}>
            Legal next states from here: {machine.legalNext.length ? machine.legalNext.join(", ") : "none (terminal)"}
          </div>
          <div style={{ fontSize: "0.78rem", color: machine.moneyCleared ? "#059669" : "#b45309" }}>
            Seller&apos;s money cleared: {machine.moneyCleared ? "yes" : "no"}
          </div>
        </div>

        <div style={{ marginTop: "0.6rem", paddingTop: "0.6rem", borderTop: "1px solid #f1f5f9" }}>
          {machine.fulfillmentUnlocked ? (
            <>
              <p style={{ fontSize: "0.82rem", color: "#059669", marginBottom: "0.5rem" }}>
                This order is eligible for fulfilment — it is in {machine.current}.
              </p>
              {canFulfill ? (
                <>
                  <Form method="post">
                    <button type="submit" name="intent" value="fulfill" style={btn("#059669")}>
                      Start fulfilment
                    </button>
                  </Form>
                  {machine.current === "IN_FULFILLMENT" ? (
                    <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.4rem" }}>
                      Fulfilment is already under way; pressing this again changes nothing.
                    </p>
                  ) : null}
                </>
              ) : (
                <p style={{ fontSize: "0.78rem", color: "#b45309" }}>
                  Starting fulfilment needs the orders.fulfill capability, which your role does not have.
                </p>
              )}
            </>
          ) : (
            /*
             * The reason INSTEAD of the button, quoting the state — §8's rule,
             * and the reason is the state machine's own: no state at or past
             * READY_FOR_FULFILLMENT is reachable without passing through PAID,
             * so "not yet" is a fact about the graph and not a setting somebody
             * can turn off.
             */
            <p style={{ fontSize: "0.82rem", color: "#b45309" }} role="status">
              This order is <strong>{machine.current}</strong>, so it is not eligible for fulfilment. Fulfilment work
              starts from READY_FOR_FULFILLMENT, FULFILLMENT_REQUESTED or IN_FULFILLMENT, and an order reaches those
              only once {machine.moneyCleared ? "the order has been released" : "the seller's charge has succeeded"}.
            </p>
          )}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Order</h2>
        <div style={{ fontSize: "0.85rem", lineHeight: 1.7 }}>
          <div>Retail customer: {order.customerName || "—"} ({order.customerEmail || "—"})</div>
          {/* §8: the store and the reference it will be found by at Shopify. The
              Shopify order id is shown as well as the name, because the name is
              per store ("#1001") and a support conversation that quotes only it
              can be about two different orders. */}
          <div>
            Shopify store: <strong>{order.seller.storeName}</strong>{" "}
            <span style={{ color: "#64748b" }}>({order.seller.shopDomainFull || order.seller.shopDomain})</span>
          </div>
          <div>
            Shopify order: <strong>{order.shopifyOrderName}</strong>{" "}
            <span style={{ color: "#64748b" }}>{order.shopifyOrderId}</span>
          </div>
          <div>Supplier reference: {order.supplierReference || "—"}</div>
          <div>Order taken: {new Date(order.shopifyCreatedAt).toLocaleString()}</div>
          <div>Customer payment (seller&apos;s Shopify): <strong>{order.paymentStatus}</strong></div>
          <div>Wholesale payment to MoonVella: <strong style={{ color: paid ? "#059669" : "#b45309" }}>{order.wholesalePaymentStatus}</strong></div>
          <div>MoonVella total: <strong>{money(order.moonvellaTotal, order.currency)}</strong></div>
          <div>Fulfillment: {order.fulfillmentStatus}{order.shopifyFulfillmentState ? ` · Shopify says ${order.shopifyFulfillmentState}` : ""}</div>
          {order.cancelledAt ? (
            <div style={{ color: "#dc2626" }}>
              Cancelled {new Date(order.cancelledAt).toLocaleString()}
              {order.cancelReason ? ` — ${order.cancelReason}` : ""}
            </div>
          ) : null}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
          <thead><tr><th style={th}>Item</th><th style={th}>SKU</th><th style={th}>Qty</th><th style={th}>Retail</th><th style={th}>Wholesale</th></tr></thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id} style={{ borderTop: "1px solid #f1f5f9", fontSize: "0.8rem" }}>
                <td style={{ padding: "0.4rem" }}>{i.name}</td>
                <td style={{ padding: "0.4rem", color: "#64748b" }}>{i.sku}</td>
                <td style={{ padding: "0.4rem" }}>{i.quantity}</td>
                <td style={{ padding: "0.4rem" }}>{money(i.price, order.currency)}</td>
                <td style={{ padding: "0.4rem" }}>{money(i.wholesalePrice, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Shipping address</h2>
        {deliveryAddress.length ? (
          <address style={{ fontStyle: "normal", fontSize: "0.85rem", lineHeight: 1.7 }}>
            {deliveryAddress.map((line, index) => (
              <div key={`${index}-${line}`}>{line}</div>
            ))}
          </address>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#b45309" }}>
            No delivery address is stored on this order, so a label cannot be produced from it. The booking gate
            treats that as a refusal rather than as an empty address.
          </p>
        )}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Fulfillment request</h2>
        {order.fulfillmentRequest ? (
          <div style={{ fontSize: "0.82rem", lineHeight: 1.7 }}>
            <div>Status: <strong>{order.fulfillmentRequest.status}</strong></div>
            <div>Requested: {new Date(order.fulfillmentRequest.requestedAt).toLocaleString()}</div>
            {order.fulfillmentRequest.acceptedAt ? <div>Accepted: {new Date(order.fulfillmentRequest.acceptedAt).toLocaleString()}</div> : null}
            {order.fulfillmentRequest.rejectedAt ? (
              <div>
                Rejected: {new Date(order.fulfillmentRequest.rejectedAt).toLocaleString()}
                {order.fulfillmentRequest.rejectReason ? ` — ${order.fulfillmentRequest.rejectReason}` : ""}
              </div>
            ) : null}
            {order.fulfillmentRequest.closedAt ? <div>Closed: {new Date(order.fulfillmentRequest.closedAt).toLocaleString()}</div> : null}
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem", alignItems: "flex-end" }}>
              {order.fulfillmentRequest.status === "PENDING" ? (
                <>
                  <Form method="post"><button type="submit" name="intent" value="accept_fr" style={btn("#059669")}>Accept</button></Form>
                  <Form method="post" style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                    <input type="hidden" name="intent" value="reject_fr" />
                    <input style={input} name="reason" placeholder="Rejection reason" required />
                    <button type="submit" style={btn("#dc2626")}>Reject</button>
                  </Form>
                </>
              ) : null}
              {order.fulfillmentRequest.status === "ACCEPTED" ? (
                <Form method="post"><button type="submit" name="intent" value="close_fr" style={btn("#0369a1")}>Close</button></Form>
              ) : null}
              {order.fulfillmentRequest.status === "PENDING" || order.fulfillmentRequest.status === "ACCEPTED" ? (
                <Form method="post" style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                  <input type="hidden" name="intent" value="cancel_fr" />
                  <input style={input} name="reason" placeholder="Cancellation reason" />
                  <button type="submit" style={btn("#64748b")}>Cancel</button>
                </Form>
              ) : null}
            </div>
          </div>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No fulfillment request on this order.</p>
        )}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Wholesale payment</h2>
        <p style={{ fontSize: "0.82rem", color: "#64748b", marginBottom: "0.5rem" }}>
          Provider mode: {STRIPE_MODE_LABEL[mode] ?? mode} · Billing mode: {billing.mode}
          {billing.autoPayEnabled ? " (auto-enabled)" : ""}
        </p>

        {/* §8: the amount and its status, together and above the controls. The
            amount is the charge's own row, not the order's total — the two are
            computed from the same line prices and are shown apart so that a
            disagreement, if there ever is one, is visible instead of averaged. */}
        {payment ? (
          <div style={{ fontSize: "0.85rem", lineHeight: 1.7, marginBottom: "0.4rem" }}>
            <div>
              Amount charged: <strong>{money(payment.amount, payment.currency)}</strong> · status:{" "}
              <strong style={{ color: payment.status === "SUCCEEDED" ? "#059669" : payment.status === "FAILED" ? "#dc2626" : "#b45309" }}>
                {payment.status}
              </strong>
            </div>
            {payment.refundedAmount > 0 ? (
              <div style={{ color: "#64748b" }}>
                Refunded {money(payment.refundedAmount, payment.currency)} of {money(payment.amount, payment.currency)} ·
                still refundable <strong>{money(refund.refundableMinor, refund.currency)}</strong>
              </div>
            ) : null}
            {payment.providerPaymentIntentId ? (
              <div style={{ fontSize: "0.72rem", color: "#94a3b8" }}>
                Provider payment: {payment.providerPaymentIntentId} ({payment.provider})
              </div>
            ) : null}
          </div>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#64748b", marginBottom: "0.4rem" }}>
            No bill has been created on this order yet.
          </p>
        )}

        {order.wholesalePayment?.requiresAction ? (
          <p style={{ fontSize: "0.8rem", color: "#b45309", marginBottom: "0.4rem" }} role="status">
            Action required: the card issuer wants the seller to authenticate this payment, and only the seller can
            complete it. Fulfilment is held while it is outstanding.
          </p>
        ) : null}
        {order.wholesalePayment?.failureMessage ? (
          <p style={{ fontSize: "0.8rem", color: "#dc2626", marginBottom: "0.4rem" }} role="status">
            Last provider message: {order.wholesalePayment.failureMessage}
          </p>
        ) : null}

        {order.wholesalePayment?.attempts?.length ? (
          <div style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
            {order.wholesalePayment.attempts.map((a) => (
              <div key={a.id} style={{ color: a.status === "FAILED" ? "#dc2626" : a.requiresAction ? "#b45309" : "#64748b" }}>
                {a.status}{a.requiresAction ? " (action required)" : ""} {a.failureMessage || ""}
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Form method="post"><button type="submit" name="intent" value="create_payment" style={btn("#0369a1")}>Create invoice</button></Form>
          {/*
            The older charge path, drawn only while the money has not cleared and
            the order is live. It asks the payment row rather than the state
            machine, so on an order that was charged and then refunded it would
            find "not SUCCEEDED" and start again — the same shape of hole the
            state machine exists to close. Its deterministic idempotency key
            means Stripe would replay the original charge rather than make a
            second one, but a refunded order put back into PROCESSING is still a
            record that lies, and there is nothing this button can do for a paid
            order that the "Charge the seller" control below cannot.
          */}
          {!machine.moneyCleared && order.state !== "CANCELLED" ? (
            <Form method="post"><button type="submit" name="intent" value="manual_pay" style={btn("#082a4a")}>Pay this order (manual)</button></Form>
          ) : null}
          {mode === "simulated" && !paid && (
            <Form method="post"><button type="submit" name="intent" value="simulate_paid" style={btn("#059669")}>Simulate payment success (test)</button></Form>
          )}
        </div>
        {mode === "simulated" && <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.4rem" }}>Simulated mode — not a real charge.</p>}

        <div style={{ marginTop: "0.9rem", paddingTop: "0.75rem", borderTop: "1px solid #f1f5f9" }}>
          <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.35rem" }}>Charge the seller</div>
          {chargeBlock ? (
            /*
             * The reason instead of the button. Each one is a condition the
             * charge service answers the same way, and a page that offered the
             * button anyway would be inviting a click that can only come back
             * with a message.
             */
            <p style={{ fontSize: "0.78rem", color: "#b45309" }} role="status">{chargeBlock}</p>
          ) : (
            <>
              <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.4rem" }}>
                The seller owes the wholesale price of these lines. A charge is attempted against the card on file,
                and the order only reaches fulfilment once Stripe confirms it.
              </p>
              <Form method="post">
                <button type="submit" name="intent" value="charge" style={btn("#082a4a")}>
                  {chargeIsRetry ? "Retry the charge (new attempt)" : "Charge the seller now"}
                </button>
              </Form>
              {chargeIsRetry ? (
                <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.35rem" }}>
                  This is recorded as a deliberate retry, so the provider is asked for a new payment rather than for
                  the declined one again.
                </p>
              ) : null}
            </>
          )}
        </div>

        <div style={{ marginTop: "0.9rem", paddingTop: "0.75rem", borderTop: "1px solid #f1f5f9" }}>
          <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.35rem" }}>Refund the seller</div>
          {refund.block ? (
            <p style={{ fontSize: "0.78rem", color: "#b45309" }} role="status">{refund.block}</p>
          ) : (
            <>
              <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.4rem" }}>
                {money(refund.chargedMinor, refund.currency)} was charged and{" "}
                {money(refund.refundedMinor, refund.currency)} has been refunded, so at most{" "}
                <strong>{money(refund.refundableMinor, refund.currency)}</strong> can be refunded. Leaving the amount
                blank refunds the remainder.
              </p>
              <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                <input type="hidden" name="intent" value="refund" />
                <label style={{ fontSize: "0.7rem", color: "#64748b" }}>
                  Amount ({refund.currency})
                  <br />
                  {/* The ceiling is drawn on the input and checked again in the
                      action: a max attribute is a hint the browser applies, and
                      the check that matters is the one on the server. */}
                  <input
                    style={input}
                    name="amount"
                    type="number"
                    min={0.01}
                    max={(refund.refundableMinor / 100).toFixed(2)}
                    step="0.01"
                    defaultValue={(refund.refundableMinor / 100).toFixed(2)}
                  />
                </label>
                <label style={{ fontSize: "0.7rem", color: "#64748b" }}>
                  Reason (required)
                  <br />
                  <input style={{ ...input, width: 260 }} name="reason" placeholder="Why this refund is being made" required />
                </label>
                <button type="submit" style={btn("#dc2626")}>Refund</button>
              </Form>
            </>
          )}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Packages</h2>
        {order.packages.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>Add package dimensions and weight before quoting.</p>
        ) : (
          <ul style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            {order.packages.map((p) => (
              <li key={p.id}>{p.count} × {p.length}×{p.width}×{p.height} cm, {p.weight} kg</li>
            ))}
          </ul>
        )}
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="add_package" />
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Count<br /><input style={input} name="count" type="number" defaultValue={1} min={1} /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>L (cm)<br /><input style={input} name="length" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>W (cm)<br /><input style={input} name="width" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>H (cm)<br /><input style={input} name="height" type="number" required /></label>
          <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Weight (kg)<br /><input style={input} name="weight" type="number" step="0.01" required /></label>
          <button type="submit" style={btn("#0369a1")}>Add package</button>
        </Form>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>
          Collection{collection.groups.length > 1 ? ` — ${collection.groups.length} docks` : ""}
        </h2>
        {/*
          §1's split, on the page where it is decided. An order whose items come
          from two docks is two shipments, quoted and booked separately, and the
          operator has to be able to see that BEFORE booking the first half —
          otherwise the second half looks like an order that silently failed.
        */}
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem" }}>
          Each line leaves from the dock its product is mapped to in Odoo. An order containing more than one dock becomes one
          shipment per dock, each quoted and booked independently; the split does not add a charge of its own.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
          <thead>
            <tr><th style={th}>Dock</th><th style={th}>Lines</th><th style={th}>Units</th><th style={th}>Items</th><th style={th}>Ready</th></tr>
          </thead>
          <tbody>
            {collection.groups.map((group) => (
              <tr key={group.key} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "0.4rem" }}>
                  {group.code ? (
                    <>
                      <strong>{group.code}</strong>
                      <div style={{ color: "#94a3b8", fontSize: "0.7rem" }}>{group.name}</div>
                    </>
                  ) : (
                    <span style={{ color: "#b45309" }}>Pickup location required</span>
                  )}
                </td>
                <td style={{ padding: "0.4rem" }}>{group.lines}</td>
                <td style={{ padding: "0.4rem" }}>{group.quantity}</td>
                <td style={{ padding: "0.4rem", color: "#64748b" }}>{group.skus.join(", ")}</td>
                <td style={{ padding: "0.4rem", color: group.ready ? "#059669" : "#dc2626" }}>
                  {group.ready ? "Yes" : "No"}
                  {!group.ready && group.reason ? (
                    <div style={{ color: "#b45309", fontSize: "0.7rem" }}>{group.reason}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {collection.blockers.length > 0 ? (
          <p style={{ fontSize: "0.75rem", color: "#b45309", marginTop: "0.5rem" }} role="status">
            Booking is blocked for {collection.blockers.length === 1 ? "one dock" : `${collection.blockers.length} docks`} until the
            origin mapping is complete. No global address is substituted.
          </p>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Addresses on this label</h2>
        {/*
          * Every dock this order ships from, then the destination. Both ends,
          * because the booking refuses on either: a page that showed only the
          * customer's address would leave an operator reading "Pickup address —
          * Validation unavailable" with nothing on the screen to press.
          */}
        <p style={{ fontSize: "0.72rem", color: "#64748b", margin: "0 0 0.2rem" }}>
          Booking needs every address below accepted. A check that could not be performed is not an
          acceptance: it blocks the booking the same way a rejected address does.
        </p>
        {collection.groups.map((group) =>
          group.addressGate && group.locationId ? (
            <AddressGateCard
              key={group.key}
              title={`Pickup address — ${group.code ?? group.name ?? "dock"}`}
              subjectType="PICKUP"
              subjectId={group.locationId}
              status={group.addressGate}
              isOwner={isOwner}
              editHref="/admin/origins"
              editLabel="Edit this location's address"
            />
          ) : (
            <p key={group.key} style={{ fontSize: "0.78rem", color: "#b45309", marginTop: "0.8rem" }}>
              A pickup address could not be resolved for this order&apos;s lines, so there is nothing to
              check and booking is blocked until the origin mapping is complete.
            </p>
          )
        )}
        <AddressGateCard
          title="Delivery address"
          subjectType="DELIVERY"
          subjectId={order.id}
          status={collection.deliveryGate}
          isOwner={isOwner}
        />
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Shipping quotes</h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem" }}>
          eShipper: {eshipper.mode}{eshipper.account ? ` · account ${eshipper.account}` : ""}
        </p>
        <Form method="post" style={{ marginBottom: "0.75rem" }}>
          <button type="submit" name="intent" value="get_quotes" style={btn("#0369a1")}>Get shipping quotes</button>
        </Form>
        {/* Why the quotes are gone. "No quotes yet" and "the quotes were
            withdrawn because the packages changed" lead to different actions,
            and only one of them means somebody should press the button. */}
        {order.quotesInvalidatedAt ? (
          <p style={{ fontSize: "0.75rem", color: "#b45309", marginBottom: "0.5rem" }} role="status">
            Earlier quotes were withdrawn on {new Date(order.quotesInvalidatedAt).toLocaleString()}:{" "}
            {order.quoteInvalidationReason || "no reason recorded"}. Request quotes again.
          </p>
        ) : null}
        {order.shippingQuotes.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No quotes yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr><th style={th}>From dock</th><th style={th}>Carrier</th><th style={th}>Service</th><th style={th}>Cost</th><th style={th}>Transit</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {order.shippingQuotes.map((q) => (
                <tr key={q.id} style={{ borderTop: "1px solid #f1f5f9", background: q.selected ? "#f0fdf4" : undefined }}>
                  {/*
                    A quote is priced for one dock. Showing which one is what
                    stops an operator selecting the cheapest line for a shipment
                    that leaves from somewhere else — a booking that would have
                    been refused, or worse, accepted at the wrong address.
                  */}
                  <td style={{ padding: "0.4rem" }}>
                    {q.originLocation ? (
                      q.originLocation.code
                    ) : (
                      <span style={{ color: "#b45309" }} title="This quote predates dock-scoped quoting and cannot be matched to a dock.">not dock-scoped</span>
                    )}
                  </td>
                  <td style={{ padding: "0.4rem" }}>{q.carrier}</td>
                  <td style={{ padding: "0.4rem" }}>
                    {q.serviceName}
                    {cheapest?.id === q.id ? " · lowest cost" : ""}
                    {fastest?.id === q.id ? " · fastest (est.)" : ""}
                  </td>
                  <td style={{ padding: "0.4rem" }}>{money(q.totalAmount, q.currency)}</td>
                  <td style={{ padding: "0.4rem" }}>{q.transitDays === null ? "Estimate unavailable" : `${q.transitDays} day(s)`}</td>
                  <td style={{ padding: "0.4rem" }}>
                    <Form method="post"><input type="hidden" name="intent" value="select_quote" /><input type="hidden" name="quoteId" value={q.id} /><button type="submit" style={btn("#082a4a")}>Select</button></Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <Form method="post"><button type="submit" name="intent" value="book_shipment" disabled={!paid} style={btn(paid ? "#059669" : "#94a3b8")}>Book shipment{selectedQuote ? ` (${selectedQuote.carrier})` : ""}</button></Form>
        </div>
        {!paid && <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.4rem" }}>Booking is blocked until the wholesale payment succeeds.</p>}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Shipments &amp; tracking</h2>
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.25rem" }}>
          Shopify fulfillment order: {order.shopifyFulfillmentOrderId || "not resolved"}
        </p>
        <p
          style={{
            fontSize: "0.72rem",
            marginBottom: "0.5rem",
            color: shopifyFulfillment.status === "HEALTHY" ? "#059669" : shopifyFulfillment.status === "FAILED" ? "#dc2626" : "#b45309",
          }}
        >
          Shopify fulfillment sync: {shopifyFulfillment.status}
          {shopifyFulfillment.detail ? ` — ${shopifyFulfillment.detail}` : ""}
        </p>
        <Form method="post" style={{ marginBottom: "0.75rem" }}>
          <button type="submit" name="intent" value="resolve_fo" style={btn("#0369a1")}>Resolve Shopify fulfillment order</button>
        </Form>

        <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, padding: "0.6rem", marginBottom: "0.75rem" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.4rem" }}>Add manual shipment / tracking</div>
          <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <input type="hidden" name="intent" value="manual_shipment" />
            <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Carrier<br /><input style={input} name="carrier" required /></label>
            <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Tracking number<br /><input style={input} name="trackingNumber" required /></label>
            <label style={{ fontSize: "0.7rem", color: "#64748b" }}>Tracking URL (optional)<br /><input style={input} name="trackingUrl" /></label>
            <label style={{ fontSize: "0.72rem", color: "#64748b", display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <input type="checkbox" name="notifyCustomer" /> Notify customer
            </label>
            <button type="submit" disabled={!paid} style={btn(paid ? "#059669" : "#94a3b8")}>Create shipment</button>
          </Form>
          {!paid ? <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.3rem" }}>Fulfillment is held until the wholesale payment succeeds.</p> : null}
        </div>

        {order.shipments.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>No shipments booked.</p>
        ) : (
          order.shipments.map((s) => (
            <div key={s.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem", marginBottom: "0.5rem", fontSize: "0.8rem" }}>
              <div><strong>{s.carrier}</strong> {s.serviceName} · {s.status} · {s.trackingNumber || "no tracking"}</div>
              <div style={{ color: "#64748b" }}>
                {s.originLocation ? `from ${s.originLocation.code}` : "dock not recorded"} · booked cost {s.bookedCost != null ? money(s.bookedCost) : "—"}
                {s.shopifyFulfillmentId ? ` · Shopify fulfillment ${s.shopifyFulfillmentId}` : ""}
              </div>
              <div style={{ color: "#64748b" }}>
                pickup {s.pickupMode ?? "not recorded"}
                {s.pickupStatus ? ` · ${s.pickupStatus}` : ""}
                {s.status === "BOOKED" && !s.shopifyFulfillmentId ? " · Shopify push waits for dispatch" : ""}
              </div>
              <div style={{ color: "#94a3b8", fontSize: "0.7rem" }}>
                packed {s.packedAt ? new Date(s.packedAt).toLocaleDateString() : "—"} · shipped {s.shippedAt ? new Date(s.shippedAt).toLocaleDateString() : "—"} · in transit {s.inTransitAt ? new Date(s.inTransitAt).toLocaleDateString() : "—"} · delivered {s.deliveredAt ? new Date(s.deliveredAt).toLocaleDateString() : "—"}
              </div>
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
                {s.labelUrl && <a href={s.labelUrl} target="_blank" rel="noreferrer" style={btn("#0369a1")}>Label</a>}
                {s.trackingUrl && <a href={s.trackingUrl} target="_blank" rel="noreferrer" style={btn("#64748b")}>Tracking</a>}
                <Form method="post"><input type="hidden" name="intent" value="retry_sync" /><input type="hidden" name="shipmentId" value={s.id} /><button type="submit" style={btn("#082a4a")}>Retry Shopify sync</button></Form>
                <Form method="post"><input type="hidden" name="intent" value="void_shipment" /><input type="hidden" name="shipmentId" value={s.id} /><button type="submit" style={btn("#dc2626")}>Void/cancel</button></Form>
              </div>
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: "0.68rem", color: "#64748b" }}>Advance:</span>
                {(["packed", "handed_to_carrier", "shipped", "in_transit", "delivered", "exception"] as ShipmentAdvanceEvent[]).map((ev) => (
                  <Form method="post" key={ev}>
                    <input type="hidden" name="intent" value="advance_shipment" />
                    <input type="hidden" name="shipmentId" value={s.id} />
                    <input type="hidden" name="event" value={ev} />
                    <button type="submit" style={btn(ev === "exception" ? "#dc2626" : ev === "delivered" ? "#059669" : "#0369a1")}>{ev.replace(/_/g, " ")}</button>
                  </Form>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Audit timeline</h2>
        {/*
          §8's complete timeline, oldest first: every state move the order made
          and every audit row written against it, merged and ordered by time.
          Nothing is filtered out — a timeline that hid, say, the refused state
          changes would be a summary, and this is the screen somebody reads when
          they are trying to find out what actually happened.
        */}
        <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.6rem" }}>
          {timeline.length} entr{timeline.length === 1 ? "y" : "ies"} — every state move the order made, plus every audit
          row recorded against it and against its wholesale payment. Nothing here is written by this page: the charge,
          the refund and the state changes are audited by the service that performs them, so the row exists whether the
          action came from this screen, from a webhook or from a background job.
        </p>
        {timeline.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>Nothing recorded against this order yet.</p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {timeline.map((entry) => (
              <li key={`${entry.kind}-${entry.id}`} style={{ borderTop: "1px solid #f1f5f9", padding: "0.5rem 0", fontSize: "0.8rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.7rem", color: "#94a3b8", minWidth: 140 }}>
                    {new Date(entry.at).toLocaleString()}
                  </span>
                  {entry.kind === "state" ? (
                    <span style={{ fontWeight: 600, color: STATE_COLOR[entry.toState] ?? "#334155" }}>
                      {entry.fromState ? `${entry.fromState} → ${entry.toState}` : `created in ${entry.toState}`}
                    </span>
                  ) : (
                    <span style={{ fontWeight: 600, color: "#082a4a" }}>{entry.action}</span>
                  )}
                  <span style={{ fontSize: "0.7rem", color: "#64748b" }}>
                    {entry.actorType}
                    {entry.actorName ? ` · ${entry.actorName}` : ""}
                  </span>
                </div>
                {entry.kind === "state" && entry.reason ? (
                  <div style={{ color: "#64748b", fontSize: "0.75rem" }}>{entry.reason}</div>
                ) : null}
                {entry.kind === "audit" ? (
                  <div style={{ color: "#64748b", fontSize: "0.72rem" }}>
                    {auditDetails(entry.beforeData).length ? (
                      <div>before — {auditDetails(entry.beforeData).join(" · ")}</div>
                    ) : null}
                    {auditDetails(entry.afterData).length ? (
                      <div>after — {auditDetails(entry.afterData).join(" · ")}</div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
