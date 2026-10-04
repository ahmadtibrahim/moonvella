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
  bookPreparedShipment,
  voidShipment,
  syncShipmentTracking,
  recipientPhoneFor,
  recordRecipientPhone,
} from "~/services/shipping.server";
import { availableWarehouseEvents, orderBookingGate } from "~/services/shippingLogic";
import { resolveFulfillmentOrders } from "~/services/shopifyFulfillment.server";
import { describeEshipperStatus, eshipperStatus } from "~/services/eshipper.server";
import { advanceShipment, type ShipmentAdvanceEvent } from "~/services/fulfillment.server";
import {
  acceptFulfillmentRequest,
  rejectFulfillmentRequest,
  closeFulfillmentRequest,
  cancelFulfillmentRequest,
} from "~/services/fulfillmentRequest.server";
import { getIntegrationState } from "~/services/integrationHealth.server";
import { groupOrderLinesByOrigin } from "~/services/origins.server";
import { buildQuotePackagesForOrder } from "~/services/packaging.server";
import { orderProgress } from "~/services/orderProgress.server";
import { BookingConfirmation } from "~/components/BookingConfirmation";
import { OrderProgress, stageByKey } from "~/components/OrderProgress";
import { RateSelection } from "~/components/RateSelection";
import { getUnitsPreference } from "~/services/adminPreferences.server";
import { convertedDisplay, unitsView } from "~/utils/measurementUnits";

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
   * The dock groups, with the address the confirmation screen prints. Read
   * here rather than in the component so the panel names the same place the
   * label will carry; the dock's own address is trusted as stored.
   */
  const collectionGroups = grouping.groups.map((group) => ({
    key: group.key,
    ready: group.ready,
    reason: group.reason,
    code: group.location?.code ?? null,
    name: group.location?.name ?? null,
    lines: group.lines.length,
    quantity: group.lines.reduce((sum, line) => sum + line.quantity, 0),
    skus: [...new Set(group.lines.map((line) => line.sku))],
    locationId: group.location?.id ?? null,
    /*
     * The dock's address, as the confirmation screen prints it. Carried here
     * rather than looked up again there so the panel and this list name the
     * same place — this is the address the label will carry.
     */
    pickupAddress: group.location
      ? ([
          [group.location.street1, group.location.street2].filter(Boolean).join(", "),
          [group.location.city, group.location.province, group.location.postalCode].filter(Boolean).join(", "),
          group.location.country,
          [group.location.contactName, group.location.contactPhone].filter(Boolean).join(" · "),
        ].filter(Boolean) as string[])
      : [],
  }));

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

  /*
   * THE PARCELS THIS ORDER WILL BE QUOTED AND BOOKED WITH, resolved for display.
   *
   * This is the same call `getQuotesForOrder` and `bookShipmentForOrder` make,
   * against the same two inputs, so the card below cannot describe a different
   * set of boxes from the one the carrier is asked about. That matters because
   * the order-level parcel rows are OPTIONAL: the resolver falls back to the
   * packaging stored on the variant — or on the product, for a product with no
   * choices — and a page that reported "no parcels" for an order the quote path
   * prices happily would be asking an operator to retype dimensions the system
   * already holds.
   *
   * `missing` is the resolver's own list of lines it could not describe, in the
   * same words the refusal uses, so the screen and the refusal name the same
   * line the same way.
   */
  const parcels = await buildQuotePackagesForOrder({
    items: order.items.map((item) => ({ sku: item.sku, quantity: item.quantity, variantId: item.variantId })),
    packages: order.packages,
  });

  /*
   * WHICH PROVIDER AN OPERATOR IS ABOUT TO SPEND AGAINST.
   *
   * This used to be `eshipperMode()`, whose "real" means only "a credential is
   * configured" — so a deployment pointed at the account's TEST host told the
   * operator it was real, which is the one word they would read as "live". The
   * question the button below raises is which HOST a call reaches, and that is
   * what is carried now.
   *
   * The SENTENCE is built here rather than in the component on purpose: the
   * values come from a `.server` module, which React Router strips from the
   * client bundle, so a component that called the formatter itself would fail
   * the build. Resolved once — it reads the credential store.
   */
  const eshipper = await eshipperStatus();

  return {
    order,
    /*
     * THE NUMBER THE LABEL WILL CARRY, or null. Read through the same function
     * the booking gate uses, so the card below and the refusal agree: it is the
     * address's own phone, or the one recorded on the order, and never a
     * substitute for either.
     */
    recipientPhone: recipientPhoneFor(order),
    collection: {
      split: grouping.split,
      blockers: grouping.blockers,
      groups: collectionGroups,
    },
    parcels,
    /*
     * The admin's unit preference, read for the same reason the shipment page
     * reads it: the stored parcel columns are centimetres and kilograms and do
     * not move, and a confirmation that showed an operator working in inches a
     * box measured in centimetres would be showing them a parcel they did not
     * pack.
     */
    units: unitsView(await getUnitsPreference()),
    mode,
    shopifyFulfillment,
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
    /*
     * WHERE THE PARCELS ARE. One progression per shipment, or one about the
     * order alone when nothing has been booked yet. Read here rather than in the
     * component because it spans three tables — the shipments, the selected
     * quote and the audit log that supplies the actor — and the audit rows are
     * read once for the whole order instead of once per stage.
     */
    progress: await orderProgress(order.id),
    eshipper: { ...eshipper, description: describeEshipperStatus(eshipper) },
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
    if (intent === "get_quotes") {
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
    } else if (intent === "book_shipment") {
      /*
       * A BOOKING BUYS A LABEL, SO THE ORDER'S SHIPMENTS DECIDE WHETHER ONE MAY
       * BE STARTED — read here, from the database, not from anything the form
       * posted. The gate is the same function the page draws its controls from
       * (`orderBookingGate`), which is what makes a stale tab safe: a page
       * opened before a label existed and submitted after it did meets the
       * refusal, not a second purchase.
       *
       * Three answers, three destinations:
       *   first_booking — no live shipment, so the order-level booker runs.
       *   prepared / retry — a prepared box (or a failed attempt that bought
       *     nothing) has its own workflow; booking goes through
       *     `bookPreparedShipment`, which prices the box's own parcels, claims
       *     the row before calling the provider, and refuses the states where a
       *     label may already exist.
       *   blocked — BOOKING, BOOKING_UNKNOWN, BOOKED, a provider id, or an
       *     already-dispatched parcel: refused with the operator's sentence.
       */
      const liveShipments = await prisma.shipment.findMany({
        where: { orderId, status: { not: "CANCELLED" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, status: true, providerShipmentId: true },
      });
      const gate = orderBookingGate(liveShipments);
      if (gate.kind === "blocked") throw new Error(gate.refusal);

      /*
       * The confirmation screen's answer to "will Shopify notify the customer",
       * carried into the booking and stored on the shipment. Read as a VALUE
       * rather than as the presence of a tick: the modal always posts it, and
       * "not asked" (a caller that sends nothing) must stay distinguishable from
       * "asked, and the answer was no".
       */
      const notifyAnswer = form.get("notifyCustomer");
      const quoteId = String(form.get("quoteId") || "") || undefined;
      const notify =
        notifyAnswer === null ? {} : { notifyCustomerOnPush: notifyAnswer === "on" };

      if (gate.kind === "first_booking") {
        await bookShipmentForOrder(orderId, { quoteId, ...notify }, actor);
      } else {
        await bookPreparedShipment(gate.shipmentId, quoteId, actor, notify);
      }
    } else if (intent === "record_phone") {
      /*
       * The one remedy for the booking prerequisite stated on this page. The
       * service validates the shape and audits the change against the account
       * that made it; this branch does not re-check the role, because any
       * operator who can see the order is the one the carrier has to be given a
       * number by, and refusing here would leave the order unbookable.
       */
      await recordRecipientPhone(orderId, String(form.get("phone") || ""), actor);
    } else if (intent === "void_shipment") {
      await voidShipment(String(form.get("shipmentId")), actor);
    } else if (intent === "retry_sync") {
      await syncShipmentTracking(String(form.get("shipmentId")), actor);
    } else if (intent === "resolve_fo") {
      await resolveFulfillmentOrders(orderId);
    } else if (intent === "advance_shipment") {
      /*
       * ONLY THE TWO EVENTS AN OPERATOR IS IN A POSITION TO WITNESS.
       *
       * Packed and handed-to-carrier happen in this building and somebody sees
       * them happen. Everything after that — shipped, in transit, delivered,
       * an exception — is the carrier's own scan history, written by the
       * tracking sweep from the carrier's data. A page that let an operator
       * type those would be recording a guess in the same columns the
       * carrier's own facts land in.
       */
      const event = String(form.get("event") || "");
      const allowed: ShipmentAdvanceEvent[] = ["packed", "handed_to_carrier"];
      if (!allowed.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      /*
       * The notification answer travels only when it was actually asked for.
       * The stored preference — `notifyCustomerOnPush`, captured by the booking
       * confirmation — is the default; a choice made here overrides it for this
       * one push. An absent field must mean "use the stored preference", not
       * "no", which is why the control is a three-state select rather than a
       * checkbox that posts nothing when cleared.
       */
      const notifyAnswer = form.get("notifyCustomer");
      await advanceShipment(String(form.get("shipmentId")), event as ShipmentAdvanceEvent, actor, {
        ...(notifyAnswer === "on" ? { notifyCustomer: true } : {}),
        ...(notifyAnswer === "off" ? { notifyCustomer: false } : {}),
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

/**
 * Where the parcels on this order come from, said the way the card has to say it.
 *
 * `manual` is not "entered on this page" but "recorded for this order": the
 * packing workspace writes those rows, they replace the items' own packaging in
 * the resolved set, and the other two are read from the catalogue and follow
 * it. Naming the source is what tells an operator where a wrong box has to be
 * corrected.
 */
const PARCEL_SOURCE: Record<"manual" | "variant" | "product", string> = {
  manual: "from the parcel rows recorded for this order in the packing workspace",
  variant: "from the packaging stored on the ordered variants",
  product: "from the packaging stored on the products, because these items have no variant packaging of their own",
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

/**
 * The timeline entry types, as the loader returns them.
 */
type TimelineEntry = Awaited<ReturnType<typeof loader>>["timeline"][number];

/**
 * WHAT HAPPENED, IN WORDS SOMEBODY WHO WAS NOT THERE CAN READ.
 *
 * The stored codes (`shipping.quotes_requested`, `payment.charge_submitted`)
 * are precise, stable and meaningless to the person answering "why did this
 * order sit for a day". Each one these screens can produce is translated here;
 * anything else falls back to the code with its underscores opened out rather
 * than being hidden — an untranslated row is still true, and the raw code stays
 * under Technical details for anyone comparing against a log.
 */
const ACTIVITY_TEXT: Record<string, string> = {
  "order.intaken": "Order received from Shopify",
  "order.state_changed": "Order state changed",
  "order.state_change_refused": "A state change was refused",
  "order.money_updated": "Order totals updated",
  "order.paid_refused": "The store's customer payment was refused",
  "order.recipient_phone_recorded": "Delivery phone number recorded",
  "order.package_added": "Parcels recorded for this order",
  "order.package_removed": "Recorded parcel removed",
  "order.cancelled": "Order cancelled",
  "order.updated": "Order updated",
  "order.refund_recorded": "Refund recorded",
  "payment.charge_priced": "Seller charge priced",
  "payment.charge_submitted": "Seller's card charged",
  "payment.failed": "Seller charge failed",
  "payment.refund_issued": "Refund issued to the seller",
  "payment_method.added": "Payment method added",
  "shipping.quotes_requested": "Carrier rates requested",
  "shipping.quotes_invalidated": "Carrier rates withdrawn because the order changed",
  "shipping.quote_selected": "Carrier rate selected",
  "shipping.booked": "Shipping label booked",
  "shipping.cancelled": "Shipment cancelled",
  "shipping.tracking_synced": "Carrier tracking updated",
  "shipping.shopify_fulfilled": "Tracking pushed to Shopify",
  "shipping.billing_reconciled": "Carrier invoice reconciled",
  "shipping.booking_reconciled": "Booking reconciled with the carrier",
  "shipping.booking_resolved_by_hand": "Booking outcome resolved by an owner",
  "shipping.pickup_scheduled": "Carrier pickup scheduled",
  "shipping.pickup_cancelled": "Carrier pickup cancelled",
  "shipping.pickup_failed": "Carrier pickup failed",
  "shipping.pickup_missed": "Carrier pickup missed",
  "shipping.return_booked": "Return label booked",
  "shipment.created": "Shipment created",
  "shipment.packed": "Parcel marked packed",
  "shipment.handed_to_carrier": "Parcel handed to the carrier",
  "shipment.ready_to_ship": "Parcel marked ready to ship",
  "shipment.packing_created": "Packing shipment created",
};

function humanizeAction(action: string): string {
  const [entity, ...rest] = action.split(".");
  const words = (rest.length ? rest.join(" ") : entity).replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function activityText(entry: TimelineEntry): string {
  if (entry.kind === "state") {
    return entry.fromState
      ? `Order moved from ${entry.fromState} to ${entry.toState}`
      : `Order created in ${entry.toState}`;
  }
  return ACTIVITY_TEXT[entry.action] ?? humanizeAction(entry.action);
}

/**
 * The actor, named the way a row should read. A name when there is one; the
 * kind of actor when there is not — "SYSTEM" is not a thing a person reads.
 */
function activityActor(entry: TimelineEntry): string {
  if (entry.actorName) return entry.actorName;
  switch (entry.actorType) {
    case "ADMIN_USER":
      return "An administrator";
    case "SYSTEM":
      return "System";
    case "WEBHOOK":
      return "Shopify webhook";
    case "MERCHANT":
      return "The merchant";
    default:
      return entry.actorType;
  }
}

/**
 * The part of an audit payload a person needs on the line itself — a refusal
 * reason, a failure message — with the full payload kept under Technical
 * details. Only the first matching key is shown; the rest of the object is
 * evidence, not headline.
 */
function importantDetail(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object") return String(parsed);
  const record = parsed as Record<string, unknown>;
  for (const key of ["error", "failureMessage", "reason", "status", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export default function AdminOrderDetail() {
  const { order, recipientPhone, collection, parcels, units, mode, eshipper, billing, shopifyFulfillment, canFulfill, machine, refund, chargeBlock, timeline, progress } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const paid = order.wholesalePaymentStatus === "SUCCEEDED";
  const selectedQuote = order.shippingQuotes.find((q) => q.selected) ?? null;
  /*
   * When the batch on screen was priced.
   *
   * Every row here comes from ONE rate call, because a new request replaces the
   * old batch outright. Naming the time is what lets an operator tell "these are
   * the prices I just asked for" from "these are yesterday's and the page is
   * stale" without having to re-quote to find out.
   */
  const batchQuotedAt = order.shippingQuotes.reduce<Date | null>((newest, q) => {
    const at = new Date(q.quotedAt);
    return newest === null || at > newest ? at : newest;
  }, null);
  const badge = STRIPE_MODE_BADGE[mode] ?? STRIPE_MODE_BADGE.disabled;
  const deliveryAddress = addressLines(order.shippingAddress);
  /*
   * The same address, split the way the confirmation screen wants it: the
   * recipient's name on its own line, then the address. `addressLines` leads
   * with the name because that is how the card above renders it; the panel has
   * a labelled slot for the name and a block of lines for everything else.
   */
  const shipTo = { name: deliveryAddress[0] ?? order.customerName ?? "—", lines: deliveryAddress.slice(1) };
  const payment = order.wholesalePayment;
  /*
   * The same rule the `charge` action applies, so the button's words and the
   * request it sends agree: a charge that is marked FAILED — in the payment row
   * or in the order's state — is the only one that becomes a deliberate retry,
   * and the retry is what changes the provider's idempotency key.
   */
  const chargeIsRetry = machine.current === "PAYMENT_FAILED" || payment?.status === "FAILED";
  /*
   * WHAT STILL HOLDS THE BOOKING BUTTON SHUT, and nothing else.
   *
   * Both terms are refusals the service itself makes: every dock this order
   * collects from must be mapped (`collection.blockers`), and the parcels must
   * be describable (the quote path refuses when they are not). The Google
   * verdicts that used to be a third term are gone from this page: booking now
   * checks the fields a carrier needs (`assertCarrierAddressesReady`, which
   * names the missing field and which end it is on) and takes the customer's
   * address exactly as the seller supplied it.
   *
   * A verdict-powered term here would disable a booking the service would now
   * accept — a button that refuses where the service does not is the same
   * disagreement as before, pointing the other way.
   */
  const bookingGatesOpen = collection.blockers.length === 0;

  /*
   * The quote the booking would buy, decided the way `bookShipmentForOrder`
   * decides it.
   *
   * THE SAME THREE QUESTIONS, because a button is a promise about what the
   * service will do: a quote is SELECTED, it has not EXPIRED, and it is priced
   * for a dock this order actually collects from. The service refuses on all
   * three (`where: { orderId, selected: true, originLocationId: origin.location.id }`
   * then the expiry check), so a page that drew the button without them would be
   * selling a booking it already knows will be refused.
   *
   * The expiry half matters more than it looks: `expiresAt` is nullable because
   * the provider does not always issue one, and a quote with no expiry never
   * expires here — which is the same reading the service takes.
   */
  const now = Date.now();
  const quoteExpired = selectedQuote?.expiresAt != null && new Date(selectedQuote.expiresAt).getTime() < now;
  const orderDockIds = collection.groups.map((group) => group.locationId).filter((id): id is string => id !== null);
  const quoteDockMatches =
    selectedQuote?.originLocationId != null && orderDockIds.includes(selectedQuote.originLocationId);
  const quoteBookable = selectedQuote !== null && !quoteExpired && quoteDockMatches;

  /*
   * Said once, and in the words of the thing that is missing. "Select a service"
   * and "the price you chose has expired" send an operator to two different
   * buttons, and the second one is the reason the first would fail again.
   */
  const quoteBlock = !selectedQuote
    ? order.shippingQuotes.length > 0
      ? "Select a shipping service before booking."
      : "Request shipping quotes, then select a service, before booking."
    : quoteExpired
      ? "The selected quote has expired. Request quotes again and select a fresh one."
      : !quoteDockMatches
        ? `The selected quote was priced from a different pickup location than ${orderDockIds.length > 1 ? "the docks this order collects from" : "this order's dock"}. Select a quote priced from ${collection.groups[0]?.code ?? "the order's dock"}.`
        : null;

  const bookingReady = bookingGatesOpen && quoteBookable;

  /*
   * WHAT THE ORDER'S OWN SHIPMENTS SAY ABOUT BOOKING.
   *
   * Read from the same function the action enforces, so the panel below cannot
   * offer a booking the server would refuse — and cannot hide one it would
   * accept. A prepared box has its own workflow on the shipment page (its
   * parcels, its dock, its confirmation), a failed attempt is retried there
   * through that same safe path, and the states where a label may already
   * exist (BOOKING, BOOKING_UNKNOWN, BOOKED, a provider id) offer no booking
   * control at all.
   */
  const bookingGate = orderBookingGate(
    order.shipments.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      status: s.status,
      providerShipmentId: s.providerShipmentId,
    }))
  );

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>{order.shopifyOrderName}</h1>
          <p className="mv-muted">
            Seller: {order.seller.storeName} · {order.supplierReference}
          </p>
        </div>
        <div className="mv-actions">
          <Link to="/admin/orders" className="mv-button">&larr; All orders</Link>
        </div>
      </div>
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

      {/*
        THE PROGRESSION, above everything else on the page, because "where has
        this got to" is the question an operator arrives with. A split order
        draws one strip per parcel — a single bar would have to pick one of two
        journeys and be wrong about the other — and an order with nothing booked
        still draws one strip, from the rate that was chosen.
      */}
      {progress.map((entry, index) => (
        <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }} key={entry.shipmentId ?? "order"}>
          <OrderProgress
            title={
              progress.length > 1 && entry.shipmentId
                ? `Shipment ${index + 1} of ${progress.length}`
                : "Progress"
            }
            stages={entry.stages}
          />
        </div>
      ))}

      {actionData?.error ? <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>{actionData.error}</div> : null}

      {/* §8: the pipeline state, and whether fulfilment may start. The two are
          drawn together because the second is a fact about the first, and an
          operator who has to open another screen to learn why the button is
          missing will press it somewhere else instead. */}
      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">Pipeline state</h2>
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

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">Wholesale payment</h2>
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

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        {/* The progression links here for a booking retry, so that a retry
            reaches the one confirmation panel rather than a second form. */}
        <h2 id="book-shipment" style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Rates &amp; booking</h2>
        {/*
          The environment, not just "configured". A test host and a live one are
          both "real" to `eshipperMode()`, and the difference is the whole of what
          somebody needs to know before booking a label against it.

          The sentence is built in the loader and arrives as a string, because
          `describeEshipperStatus` lives in a `.server` module: React Router
          strips those from the client bundle, and calling one from a component
          fails the build rather than the request.
        */}
        <p
          style={{ fontSize: "0.75rem", color: eshipper.environment === "production" ? "#b91c1c" : "#64748b", marginBottom: "0.5rem" }}
        >
          eShipper: {eshipper.description}
        </p>
        <Form method="post" style={{ marginBottom: "0.75rem" }}>
          <button type="submit" name="intent" value="get_quotes" style={btn("#0369a1")}>Get shipping rates</button>
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
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>
            No rates yet. Asking for rates prices the parcels recorded on this order — it buys nothing.
          </p>
        ) : (
          <>
            <p style={{ fontSize: "0.75rem", color: "#475569", marginBottom: "0.4rem" }}>
              {order.shippingQuotes.length} rate{order.shippingQuotes.length === 1 ? "" : "s"} from the request at{" "}
              <strong>{batchQuotedAt?.toLocaleString() ?? "an unrecorded time"}</strong>. Requesting rates again
              replaces this batch and clears any selection made from it.
            </p>
            <RateSelection quotes={order.shippingQuotes} dockIds={orderDockIds} now={now} />
          </>
        )}
        {/*
          WHEN A SHIPMENT EXISTS, THE ANSWER IS ITS STATE — not a booking
          control. Nothing here can start a second purchase: the blocked
          states say why and open the shipment whose record is the reason, a
          prepared box is booked from its own page, and a failed attempt is
          retried there through the same prepared-shipment path. Only an order
          with no live shipment shows the booking confirmation.
        */}
        {bookingGate.kind === "blocked" ? (
          <div
            style={{ marginTop: "0.75rem", padding: "0.6rem 0.75rem", border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 8 }}
            role="status"
          >
            <p style={{ fontSize: "0.78rem", color: "#991b1b", margin: "0 0 0.5rem" }}>{bookingGate.refusal}</p>
            <Link to={`/admin/shipping/${bookingGate.shipmentId}`} className="mv-button">
              {bookingGate.linkLabel}
            </Link>
          </div>
        ) : bookingGate.kind === "prepared" || bookingGate.kind === "retry" ? (
          <div
            style={{ marginTop: "0.75rem", padding: "0.6rem 0.75rem", border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 8 }}
            role="status"
          >
            <p style={{ fontSize: "0.78rem", color: "#1e3a8a", margin: "0 0 0.5rem" }}>
              {bookingGate.kind === "retry"
                ? "The last booking attempt failed and bought nothing. Its label is retried from the shipment page, through the same confirmation, so the box's own parcels and dock decide the purchase."
                : "This order already has a prepared shipment. Its label is bought from the shipment page, where the box's own parcels, dock and confirmation are shown."}
            </p>
            <Link to={`/admin/shipping/${bookingGate.shipmentId}`} className="mv-button mv-button-dark">
              {bookingGate.kind === "retry" ? "Retry failed booking" : "Open prepared shipment"}
            </Link>
          </div>
        ) : (
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            {/*
              Disabled unless a valid, unexpired, correctly-priced quote is
              selected. An empty or failed quote response leaves no selected
              quote, so it cannot open this. Address verdicts are not part of
              `bookingReady` any more — see `bookingGatesOpen` above.
            */}
            {/*
              The confirmation screen, not a second booking path. This button used
              to post `book_shipment` directly, which meant the page with the least
              context was the one that spent the money without asking.
            */}
            {selectedQuote ? (
              <BookingConfirmation
                environment={eshipper.environment}
                environmentDetail={eshipper.description}
                environmentHost={eshipper.host}
                orderName={order.shopifyOrderName}
                carrier={selectedQuote.carrier}
                serviceName={selectedQuote.serviceName}
                totalCharge={selectedQuote.totalAmount}
                currency={selectedQuote.currency}
                transitDays={selectedQuote.transitDays}
                quotedAt={selectedQuote.quotedAt}
                expiresAt={selectedQuote.expiresAt}
                shipFrom={(() => {
                  // The dock the SELECTED QUOTE was priced from, which is the dock
                  // this booking would leave. Falling back to the first group
                  // would name a dock the price did not come from.
                  const group =
                    collection.groups.find((g) => g.locationId === selectedQuote.originLocationId) ?? collection.groups[0];
                  return group ? { name: `${group.name ?? "Pickup location"} (${group.code ?? "—"})`, lines: group.pickupAddress } : null;
                })()}
                shipTo={shipTo}
                shipToPhone={recipientPhone}
                parcels={parcels.packages}
                units={{ dimensionUnit: units.dimensionUnit, weightUnit: units.weightUnit }}
                hasFulfillmentOrder={Boolean(order.shopifyFulfillmentOrderId)}
                quoteId={selectedQuote.id}
                canBook={paid && bookingReady}
                // `first_booking` by construction here: a shipment in any other
                // bookable state is answered by the panel above, so this screen
                // never describes a retry.
                retrying={false}
              />
            ) : (
              <button type="button" disabled style={btn("#94a3b8")}>
                Book shipment
              </button>
            )}
          </div>
        )}
        {!paid && <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.4rem" }}>Booking is blocked until the wholesale payment succeeds.</p>}
        {paid && quoteBlock ? (
          <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.4rem" }}>{quoteBlock}</p>
        ) : null}
        {paid && !bookingGatesOpen ? (
          <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.4rem" }}>
            Booking is blocked until every dock this order ships from is mapped — see <em>Collection</em> below.
            Mapping the origin is what clears it; rates can be requested meanwhile, because pricing a parcel does not
            commit to collecting it.
          </p>
        ) : null}
      </div>

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        {/* Where the tracking push is retried from. Same reason as above. */}
        <h2 id="shipments" style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>Shipments, documents &amp; tracking</h2>
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

        {/*
          ONE PANEL PER SHIPMENT, and nothing on it is typed in by hand.

          Every fact below was written by the carrier or by a service that
          called the carrier — the booking, the tracking, the costs, the dock
          the label was priced from. There is deliberately no "add shipment"
          form: a shipment that did not come from a booking has no label, no
          tracking and no carrier behind it, and a record that copies those in
          by hand is a record that can disagree with the parcel on the dock.
        */}
        {order.shipments.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#64748b" }}>
            No shipment yet. A shipment row appears the moment a label is booked above; tracking and cost are then the
            carrier&apos;s own record, not a copy of anything typed here.
          </p>
        ) : (
          order.shipments.map((s) => (
            <div key={s.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.7rem", marginBottom: "0.6rem" }}>
              <div className="mv-order-overview">
                <div>
                  <small>Carrier &amp; service</small>
                  <strong>{[s.carrier, s.serviceName].filter(Boolean).join(" ") || "—"}</strong>
                </div>
                <div>
                  <small>Booking status</small>
                  <strong>{s.status}</strong>
                </div>
                {/*
                  THE TRACKING NUMBER, IMMEDIATELY (§2). It is known the moment
                  the label is bought — before packing, before the carrier has
                  the box — and an operator answering a customer's phone call
                  needs it in the first line, not spelled out of a status
                  sentence.
                */}
                <div>
                  <small>Tracking number</small>
                  <strong style={{ fontFamily: "ui-monospace, monospace" }}>
                    {s.trackingNumber ? (
                      s.trackingUrl ? (
                        <a href={s.trackingUrl} target="_blank" rel="noreferrer">{s.trackingNumber}</a>
                      ) : (
                        s.trackingNumber
                      )
                    ) : (
                      <span style={{ color: "#64748b" }}>not recorded yet</span>
                    )}
                  </strong>
                </div>
                <div>
                  <small>Tracking status</small>
                  <strong>{s.trackingStatus ?? (s.trackingNumber ? "Recorded" : "Not started")}</strong>
                </div>
                <div>
                  <small>Quoted cost</small>
                  <strong>{s.quotedCarrierCost != null ? money(s.quotedCarrierCost) : "—"}</strong>
                </div>
                <div>
                  <small>Booked cost</small>
                  <strong>{s.bookedCost != null ? money(s.bookedCost) : "—"}</strong>
                </div>
                <div>
                  <small>Pickup location</small>
                  <strong>
                    {s.originLocation ? `${s.originLocation.code ?? "—"} — ${s.originLocation.name ?? ""}`.trim() : "not recorded"}
                    {s.pickupMode ? ` · pickup ${s.pickupMode}${s.pickupStatus ? ` (${s.pickupStatus})` : ""}` : ""}
                  </strong>
                </div>
                <div>
                  <small>Warehouse state</small>
                  <strong>
                    {s.handedToCarrierAt
                      ? `Handed to carrier ${new Date(s.handedToCarrierAt).toLocaleString()}`
                      : s.packedAt
                        ? `Packed ${new Date(s.packedAt).toLocaleString()}`
                        : "Not packed yet"}
                  </strong>
                </div>
                <div>
                  <small>Shopify sync</small>
                  <strong>
                    {s.shopifySyncedAt
                      ? `Fulfilled ${new Date(s.shopifySyncedAt).toLocaleString()}`
                      : s.shopifySyncError
                        ? "Sync failed"
                        : "Awaiting handoff"}
                  </strong>
                </div>
              </div>

              {/*
                AND THE FACT THAT SHOPIFY HAS NOT BEEN TOLD YET, said plainly.
                A booked label is not a collected parcel: the fulfillment is
                created at the dispatch milestone because that is what marks the
                items fulfilled, so between the two the order is deliberately
                half-done and the screen has to say so or it reads as a fault.
              */}
              {(() => {
                // The stage's own words, so this card and the strip above it
                // cannot say different things about the same parcel.
                const stage = stageByKey(progress.find((p) => p.shipmentId === s.id)?.stages ?? [], "tracking_sent");
                if (!stage || stage.state === "done" || s.shopifySyncError) return null;
                return (
                  <div style={{ color: stage.state === "unknown" ? "#b45309" : "#92400e", fontWeight: 600, marginTop: "0.35rem" }}>
                    {stage.detail}
                  </div>
                );
              })()}
              {/*
                The stored errors, verbatim. These are the reason a control
                below is offered or withheld, so hiding them would leave an
                operator guessing why a button is missing.
              */}
              {s.lastBookingError ? (
                <div style={{ color: "#dc2626", fontSize: "0.75rem", marginTop: "0.35rem" }}>
                  Last booking error: {s.lastBookingError}
                </div>
              ) : null}
              {s.shopifySyncError ? (
                <div style={{ color: "#dc2626", fontSize: "0.75rem", marginTop: "0.35rem" }}>
                  Shopify sync error: {s.shopifySyncError}
                </div>
              ) : null}
              {s.shopifyFulfillmentId ? (
                <div style={{ color: "#64748b", fontSize: "0.72rem", marginTop: "0.25rem" }}>
                  Shopify fulfillment {s.shopifyFulfillmentId}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                {s.labelUrl && <a href={s.labelUrl} target="_blank" rel="noreferrer" style={btn("#0369a1")}>View label</a>}
                <a href={`/admin/packing-list/${s.id}`} target="_blank" rel="noreferrer" style={btn("#0369a1")}>Print packing slip</a>
                <a href={`/admin/packing-list/${s.id}?download=1`} style={btn("#0369a1")}>Download packing slip</a>
                {s.trackingUrl && <a href={s.trackingUrl} target="_blank" rel="noreferrer" style={btn("#64748b")}>Carrier tracking</a>}
                <a href={`/admin/shipping/${s.id}`} style={btn("#0369a1")}>Shipment details</a>
                {/* Retrying a push that has no stored error would ask Shopify a
                    question the record already answers; the control appears
                    only when the last attempt actually failed. */}
                {s.shopifySyncError ? (
                  <Form method="post"><input type="hidden" name="intent" value="retry_sync" /><input type="hidden" name="shipmentId" value={s.id} /><button type="submit" style={btn("#082a4a")}>Retry Shopify sync</button></Form>
                ) : null}
                {/* A label can be voided while it is a live booking — bought,
                    not yet delivered, not already cancelled. Delivered and
                    cancelled shipments have nothing left to void. */}
                {s.providerShipmentId && s.status !== "CANCELLED" && s.status !== "DELIVERED" ? (
                  <Form method="post"><input type="hidden" name="intent" value="void_shipment" /><input type="hidden" name="shipmentId" value={s.id} /><button type="submit" style={btn("#dc2626")}>Void label</button></Form>
                ) : null}
              </div>

              {/*
                THE TWO EVENTS AN OPERATOR CAN WITNESS, and the only two this
                page can record. Everything after handover — shipped, in
                transit, delivered, exception — belongs to the carrier's own
                scans, which arrive through tracking; a hand-set status here
                would only be a second, guessable version of that history.

                WHICH of the two is available is `availableWarehouseEvents`'
                answer, not this page's: packing only while packing can still
                be true, the handover only for a packed box still here. A
                SHIPPED, EXCEPTION, DELIVERED or CANCELLED shipment therefore
                shows no control at all — its remaining history is the
                carrier's record, and the server refuses the same movements
                this list omits.
              */}
              {availableWarehouseEvents(s).includes("packed") ? (
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="advance_shipment" />
                    <input type="hidden" name="shipmentId" value={s.id} />
                    <input type="hidden" name="event" value="packed" />
                    <button type="submit" style={btn("#0369a1")}>Mark packed</button>
                  </Form>
                  <span style={{ fontSize: "0.7rem", color: "#64748b" }}>No customer notification is sent for packing.</span>
                </div>
              ) : null}
              {availableWarehouseEvents(s).includes("handed_to_carrier") ? (
                <Form method="post" style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                  <input type="hidden" name="intent" value="advance_shipment" />
                  <input type="hidden" name="shipmentId" value={s.id} />
                  <input type="hidden" name="event" value="handed_to_carrier" />
                  <label style={{ fontSize: "0.7rem", color: "#64748b" }}>
                    Customer notification
                    <br />
                    {/* Blank means the shipment's stored preference decides —
                        the same answer the service already uses. An explicit
                        yes or no overrides it for this handoff only, and the
                        service still refuses to notify twice. */}
                    <select style={input} name="notifyCustomer" defaultValue="">
                      <option value="">Use the stored preference</option>
                      <option value="on">Notify the customer</option>
                      <option value="off">Do not notify</option>
                    </select>
                  </label>
                  <button type="submit" style={btn("#059669")}>Hand to carrier</button>
                </Form>
              ) : null}
              {s.handedToCarrierAt ? (
                <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.5rem" }}>
                  Handed to the carrier {new Date(s.handedToCarrierAt).toLocaleString()} — status from here follows the
                  carrier&apos;s own scans.
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">Order</h2>
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

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">Shipping address</h2>
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

        {/*
          THE CARRIER'S ONE MISSING FIELD, AND THE PLACE TO FIX IT.

          Booking is refused when the recipient has no phone, and the refusal
          says to record the customer's own number — so the page that states the
          prerequisite has to be the page where it can be met, or the message is
          an instruction to go somewhere that does not exist.

          Nothing is prefilled and nothing is suggested. The dock's number, the
          store's and a placeholder are all accepted by the carrier and all
          belong to somebody who is not receiving this parcel.
        */}
        <div style={{ marginTop: "0.6rem", paddingTop: "0.6rem", borderTop: "1px solid #f1f5f9", fontSize: "0.82rem" }}>
          {recipientPhone ? (
            <div>
              Delivery phone: <strong>{recipientPhone}</strong>
            </div>
          ) : (
            <>
              <p style={{ color: "#b45309", marginBottom: "0.4rem" }}>
                No delivery phone number is recorded. A carrier will not take this booking without one — the number is
                printed on the label and used to reach the recipient — so nothing is filled in on their behalf.
              </p>
              <Form method="post" style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                <input type="hidden" name="intent" value="record_phone" />
                <input
                  style={input}
                  name="phone"
                  placeholder="Customer's own number"
                  required
                  inputMode="tel"
                  aria-label="Delivery phone number"
                />
                <button type="submit" style={btn("#0369a1")}>
                  Save phone number
                </button>
              </Form>
            </>
          )}
        </div>
      </div>

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">Fulfillment request</h2>
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

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">Packages</h2>
        {/*
          WHAT WILL ACTUALLY BE SENT, READ BACK — NOT TYPED IN HERE.

          The resolved set is the parcel rows the packing workspace recorded for
          this order when there are any, and the packaging stored on the items
          otherwise; either way it is the exact set `getQuotesForOrder` and
          `bookShipmentForOrder` resolve, so this card cannot describe a
          different parcel from the one the carrier is asked about. There is no
          entry form: numbers typed by hand are the ones a carrier would later
          bill against, and a wrong box belongs to the catalogue record it came
          from, not to this page.

          The stored columns are centimetres and kilograms and do not move; the
          figures below are converted to the admin's unit preference read-only,
          and the source of each parcel is stated so a correction goes to the
          record that supplied it.
        */}
        {parcels.packages.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#b45309" }}>
            No packaging could be resolved for this order, so quoting is refused
            {parcels.missing.length > 0 ? (
              <>
                {" "}for: <strong>{parcels.missing.join(", ")}</strong>
              </>
            ) : (
              "."
            )}{" "}
            Complete the packaging on those items in the <Link to="/admin/products" style={{ color: "#082a4a" }}>Product Catalog</Link>{" "}
            — or in the <Link to="/admin/packaging" style={{ color: "#082a4a" }}>Packaging Library</Link> it draws on — then
            request rates again. Nothing on this page can supply the missing measurements.
          </p>
        ) : (
          <>
            <p style={{ fontSize: "0.78rem", color: "#334155", marginBottom: "0.35rem" }}>
              Quoting and booking will use{" "}
              <strong>
                {parcels.packages.reduce((n, p) => n + p.count, 0)} parcel
                {parcels.packages.reduce((n, p) => n + p.count, 0) === 1 ? "" : "s"}
              </strong>
              , {PARCEL_SOURCE[parcels.source]}.
            </p>
            <ul style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
              {parcels.packages.map((p, index) => (
                <li key={index}>
                  {p.count} × {convertedDisplay(p.length, "cm", units.dimensionUnit, "length")}×
                  {convertedDisplay(p.width, "cm", units.dimensionUnit, "length")}×
                  {convertedDisplay(p.height, "cm", units.dimensionUnit, "length")} {units.dimensionUnit},{" "}
                  {convertedDisplay(p.weight, "kg", units.weightUnit, "weight")} {units.weightUnit}
                </li>
              ))}
            </ul>
            <p className="mv-readonly-parcel">
              Read-only. The stored parcel record is centimetres and kilograms; these figures are converted to{" "}
              {units.phrase} for display only, and booking always sends the stored values. To change what is sent,
              correct the packaging on the item — there is no parcel entry form on this page.
            </p>
          </>
        )}
        {parcels.missing.length > 0 && parcels.packages.length > 0 ? (
          <p style={{ fontSize: "0.78rem", color: "#b45309", marginTop: "0.5rem" }}>
            These lines have no packaging and would be refused at quoting:{" "}
            <strong>{parcels.missing.join(", ")}</strong>. Complete their packaging in the{" "}
            <Link to="/admin/products" style={{ color: "#082a4a" }}>Product Catalog</Link> or the{" "}
            <Link to="/admin/packaging" style={{ color: "#082a4a" }}>Packaging Library</Link>.
          </p>
        ) : null}
      </div>

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">
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

      <div className="mv-panel mv-panel-body" style={{ marginBottom: "1.5rem", marginTop: 0 }}>
        <h2 className="mv-panel-title">Activity</h2>
        {/*
          THE SAME RECORDS, READ THE WAY A PERSON ASKS FOR THEM.

          Oldest first: every state move the order made and every audit row
          written against it, merged by time. Nothing is filtered out — a
          history that hid, say, the refused state changes would be a summary,
          and this is the screen somebody reads to find out what actually
          happened. Each row leads with what happened in words, then when and
          by whom; the stored code and the raw before/after payload stay under
          Technical details, because the audit records themselves are evidence
          and this page never rewrites or drops them.
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
          <ol className="mv-activity-list">
            {timeline.map((entry) => {
              const detail = entry.kind === "audit" ? importantDetail(entry.afterData) : null;
              return (
                <li key={`${entry.kind}-${entry.id}`} className="mv-activity-item">
                  <span style={{ color: "#94a3b8" }}>{new Date(entry.at).toLocaleString()}</span>
                  <div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
                      {/*
                        A state move reads as a sentence carrying the destination
                        state's own colour; every other row reads as its action
                        translated, or as the code with its underscores opened
                        out when it is one this page has no sentence for.
                      */}
                      <span
                        style={{
                          fontWeight: 600,
                          color: entry.kind === "state" ? STATE_COLOR[entry.toState] ?? "#334155" : "#082a4a",
                          fontSize: "0.78rem",
                        }}
                      >
                        {activityText(entry)}
                      </span>
                      <span style={{ fontSize: "0.7rem", color: "#64748b" }}>{activityActor(entry)}</span>
                    </div>
                    {entry.kind === "state" && entry.reason ? (
                      <div style={{ color: "#64748b", fontSize: "0.72rem", marginTop: "0.15rem" }}>{entry.reason}</div>
                    ) : null}
                    {/* The important part of the payload — a failure message,
                        a refusal reason — on the line itself; the rest stays
                        in the evidence below it. */}
                    {detail ? (
                      <div style={{ color: "#92400e", fontSize: "0.72rem", marginTop: "0.15rem" }}>{detail}</div>
                    ) : null}
                    {entry.kind === "audit" ? (
                      <details style={{ marginTop: "0.2rem" }}>
                        <summary style={{ fontSize: "0.68rem", color: "#64748b", cursor: "pointer" }}>
                          Technical details
                        </summary>
                        <div style={{ color: "#64748b", fontSize: "0.7rem", marginTop: "0.2rem" }}>
                          <div>{entry.action}</div>
                          {auditDetails(entry.beforeData).length ? (
                            <div>before — {auditDetails(entry.beforeData).join(" · ")}</div>
                          ) : null}
                          {auditDetails(entry.afterData).length ? (
                            <div>after — {auditDetails(entry.afterData).join(" · ")}</div>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
