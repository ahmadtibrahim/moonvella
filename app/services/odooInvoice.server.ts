/**
 * The seller's DRAFT Odoo invoice for a MoonVella order.
 *
 * This module is the whole carrier-handoff invoice flow: partner → sale order
 * created from the "MoonVella B2B Wholesale" quotation template → confirm →
 * DRAFT invoice → taxes cleared → the shipment's carrier/tracking facts written
 * onto it → linked on the order. It is called from exactly two places — the
 * ODOO_INVOICE_SYNC job queued by the handoff milestone, and the repair button
 * on the order page — and it always writes with `confirm: true`, because every
 * caller has already decided the draft should exist.
 *
 * Posting, payment registration and emailing are MANUAL steps in Odoo (owner
 * instruction, 2026-10-05). The Stripe charge happened before handoff and is
 * only ever READ (through the captured amount); the draft is left for a person
 * to review, post and send; and nothing in this file can mail the seller or
 * move money. The connector still ships the post/payment/email machinery the
 * earlier automatic flow used — it is simply not wired to anything here — and
 * three rules shape every decision that remains:
 *
 * 1. **The invoice is a financial record.** It is never created twice.
 *    `Order.odooInvoiceId` is the guard: once it is set, a re-run adopts the
 *    invoice it names — a DRAFT is refreshed in place with the shipment's
 *    facts, and anything a person has already posted is reported and left
 *    untouched. When the linked invoice is gone from Odoo, the pipeline stops
 *    and says so rather than making another one.
 * 2. **Nothing is invented.** Lines come from the Odoo products the ordered
 *    SKUs name; a SKU without a product is an error, never a free-text line.
 *    Money comes from the captured Stripe amount, and a fresh draft that does
 *    not total it is refused before it is decorated or linked. No tax is
 *    added: the draft's own lines are cleared of tax and then verified
 *    tax-free, because the seller already paid the whole wholesale price.
 * 3. **Odoo is not a payment rail here.** Nothing in this file calls a
 *    payment provider, and nothing can: the only writes it performs are the
 *    connector's guarded sale-order, invoice, tax-clear and chatter calls.
 *
 * Failure contract: a failure marks the order (`odooInvoiceError`), records an
 * audit row, and rethrows the original error untouched — the queue keys its
 * retry/permanent behaviour off that error, and the route answers with it.
 * `PermanentJobError` means retrying cannot help until a human changes
 * something (a missing product, a cancelled invoice); anything else is retried
 * by the queue.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { PermanentJobError } from "./jobs.server";
import { chooseBusinessEmail, financialActionHold } from "./odooContacts.server";
import {
  OdooError,
  clearInvoiceLineTaxes,
  confirmSaleOrder,
  createInvoiceFromSaleOrder,
  createPartner,
  createSaleOrder,
  findContactTagByName,
  findInvoicesForSaleOrder,
  findInvoiceNotes,
  findPartnerByEmail,
  findSaleOrderByClientOrderRef,
  findSaleOrderTemplateByName,
  getInvoiceState,
  postInvoiceNote,
  resolveProductIdsBySku,
  writeInvoiceTrackingRef,
  type OdooInvoiceState,
  type OdooSaleOrderTemplateRef,
  type OdooWritePreview,
} from "./odoo.server";

/**
 * The quotation template the draft is created from. Its name is the contract
 * here: the template is what stamps the brand and sales channel that decide
 * the PDF, so the app looks it up by this exact name and fails loudly when the
 * row is missing or mis-stamped — it never sends the brand literals itself.
 */
export const B2B_QUOTATION_TEMPLATE_NAME = "MoonVella B2B Wholesale";

/**
 * The marker that opens every chatter note this pipeline writes. Stable and
 * specific so the retry can find its OWN note among a person's comments —
 * and so a person reading the invoice's chatter knows where the block came
 * from. Also the search term: `findInvoiceNotes` matches bodies containing it.
 */
export const SHIPMENT_NOTE_MARKER = "[MoonVella shipment]";

/** Who asked for the invoice — the job runner or a signed-in admin. */
export interface OdooInvoiceActor {
  actorType: "ADMIN_USER" | "SYSTEM";
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * The shipment facts written onto the draft. Null fields mean the shipment
 * record does not hold that fact yet — nothing is written for them, and the
 * note shows only what is known.
 */
export interface InvoiceShipmentFacts {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  providerReference: string | null;
}

export interface OdooInvoiceOutcome {
  /**
   * CREATED  — this run built the draft (sale order, invoice, shipment block).
   * UPDATED  — the linked draft already existed and was refreshed in place.
   * POSTED   — the linked invoice has been posted (by a person, in Odoo);
   *            it was reported and deliberately left untouched.
   */
  status: "CREATED" | "UPDATED" | "POSTED";
  orderId: string;
  odooInvoiceId: number;
  odooInvoiceName: string | null;
  odooSaleOrderId: number | null;
  /** The invoice's live state in Odoo, re-read after the last write. */
  invoice: {
    state: string;
    paymentState: string | false;
    amountTotal: number;
    amountTax: number;
  };
  /** Set when this run resolved the customer partner; null on adopt/refresh. */
  partner: { id: number; name: string; outcome: "CREATED" | "REUSED" } | null;
  /**
   * The shipment facts this run put on the invoice, with what was actually
   * written; null when the order has no shipment row to describe yet.
   */
  shipment:
    | (InvoiceShipmentFacts & {
        trackingRefWritten: boolean;
        notePosted: boolean;
      })
    | null;
}

const invoiceOrderSelect = {
  id: true,
  sellerId: true,
  supplierReference: true,
  odooInvoiceId: true,
  odooInvoiceName: true,
  odooSaleOrderId: true,
  odooInvoiceSyncedAt: true,
  odooInvoiceState: true,
  odooInvoiceError: true,
  seller: {
    select: {
      storeName: true,
      contactEmail: true,
      application: {
        select: {
          legalBusinessName: true,
          storeContactEmail: true,
          storeOwnerEmail: true,
        },
      },
    },
  },
  items: {
    select: { sku: true, name: true, quantity: true, wholesalePrice: true },
  },
  /*
   * The shipment the draft describes: the most recently updated non-cancelled
   * one. At handoff that is the shipment that just moved — `advanceShipment`
   * stamps `handedToCarrierAt` (bumping `updatedAt`) before queueing this job,
   * and `addManualShipment` creates its row immediately before queueing — and
   * on a later refresh of a multi-box order the newest box's facts win, which
   * is the one a person opening the draft last recorded.
   */
  shipments: {
    where: { status: { not: "CANCELLED" } },
    orderBy: { updatedAt: "desc" },
    take: 1,
    select: {
      carrier: true,
      serviceName: true,
      serviceCode: true,
      trackingNumber: true,
      providerShipmentId: true,
      providerQuoteId: true,
    },
  },
  wholesalePayment: {
    select: {
      id: true,
      status: true,
      amount: true,
      currency: true,
      capturedAt: true,
      priceSnapshot: true,
    },
  },
} satisfies Prisma.OrderSelect;

type InvoiceOrder = Prisma.OrderGetPayload<{ select: typeof invoiceOrderSelect }>;
type CapturedPayment = NonNullable<InvoiceOrder["wholesalePayment"]>;

/**
 * Create (or refresh) the order's DRAFT Odoo invoice.
 *
 * Idempotent by construction: the order row's link columns decide what happens
 * — an unlinked order builds the draft, a linked draft is refreshed with the
 * shipment's facts, and a linked posted invoice is reported and untouched.
 */
export async function createOdooInvoiceForOrder(
  orderId: string,
  actor: OdooInvoiceActor,
): Promise<OdooInvoiceOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: invoiceOrderSelect,
  });
  if (!order) {
    throw new PermanentJobError(
      `Order ${orderId} does not exist; there is nothing to invoice.`,
    );
  }

  try {
    return await runInvoicePipeline(order, actor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // The order-page surface. Written best-effort: a failure to RECORD the
    // failure must not replace the real error the caller (and the job queue)
    // needs to see, so both writes swallow their own errors and the original
    // is rethrown untouched.
    await prisma.order
      .update({ where: { id: order.id }, data: { odooInvoiceError: message } })
      .catch(() => undefined);
    await recordAudit({
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorName: actor.actorName ?? null,
      action: "order.odoo_invoice_failed",
      entityType: AUDIT_ENTITY.ORDER,
      entityId: order.id,
      beforeData: { odooInvoiceId: order.odooInvoiceId },
      afterData: { error: message },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    }).catch(() => undefined);

    throw error;
  }
}

async function runInvoicePipeline(
  order: InvoiceOrder,
  actor: OdooInvoiceActor,
): Promise<OdooInvoiceOutcome> {
  const shipment = shipmentFactsFrom(order);

  // --- 1. An invoice is already linked -------------------------------------
  if (order.odooInvoiceId) {
    const state = await readLiveInvoice(order.odooInvoiceId);

    if (state.state === "draft") {
      // The owner's rule: the draft is refreshed in place — never a duplicate.
      // Amounts are NOT re-asserted here: a draft is a person's workspace in
      // Odoo once it exists, and refreshing the shipment block must not turn
      // an operator's edit into a pipeline failure.
      const written = await applyShipmentToDraft(order.odooInvoiceId, state, shipment);
      const invoiceName = invoiceNameOf(state);
      await writeOrderLink(order, {
        invoiceId: order.odooInvoiceId,
        invoiceName,
        saleOrderId: order.odooSaleOrderId,
        state: state.state,
      });
      await recordSync(order, actor, {
        status: "UPDATED",
        state,
        saleOrderId: order.odooSaleOrderId,
        saleOrderReused: null,
        partner: null,
        linesSource: null,
        shipment: written,
        mappingRepair: null,
        financialHold: null,
      });
      return {
        status: "UPDATED",
        orderId: order.id,
        odooInvoiceId: order.odooInvoiceId,
        odooInvoiceName: invoiceName,
        odooSaleOrderId: order.odooSaleOrderId,
        invoice: invoiceView(state),
        partner: null,
        shipment: written,
      };
    }

    // Posted (or paid): a person has taken it over in Odoo. Report the live
    // state — the synced-at and state columns refresh, a stale error clears —
    // and deliberately write NOTHING to the invoice: no shipment note, no
    // field, nothing. The draft-only rule is the owner's; this is where it
    // stops.
    const invoiceName = invoiceNameOf(state);
    await writeOrderLink(order, {
      invoiceId: order.odooInvoiceId,
      invoiceName,
      saleOrderId: order.odooSaleOrderId,
      state: state.state,
    });
    await recordSync(order, actor, {
      status: "POSTED",
      state,
      saleOrderId: order.odooSaleOrderId,
      saleOrderReused: null,
      partner: null,
      linesSource: null,
      shipment: null,
      mappingRepair: null,
      financialHold: null,
    });
    return {
      status: "POSTED",
      orderId: order.id,
      odooInvoiceId: order.odooInvoiceId,
      odooInvoiceName: invoiceName,
      odooSaleOrderId: order.odooSaleOrderId,
      invoice: invoiceView(state),
      partner: null,
      shipment: null,
    };
  }

  // --- 2. The money gate ---------------------------------------------------
  // A draft is created only for money that has actually been captured: it
  // bills the captured amount, and any other payment state (a failed card, a
  // refund) is a human's decision made in the app, not here.
  const payment = requireCapturedPayment(order);
  const financialHold = await financialActionHold(order.sellerId);

  // --- 3. Build it ---------------------------------------------------------
  return createFreshInvoice(order, actor, payment, financialHold, shipment);
}

async function createFreshInvoice(
  order: InvoiceOrder,
  actor: OdooInvoiceActor,
  payment: CapturedPayment,
  financialHold: string | null,
  shipment: InvoiceShipmentFacts | null,
): Promise<OdooInvoiceOutcome> {
  const reference = order.supplierReference?.trim();
  if (!reference) {
    throw new PermanentJobError(
      `Order ${order.id} carries no supplier reference, which is the identity its ` +
        `sale order is matched by. Without it a retry could not tell its own sale ` +
        `order from a second one, so no invoice is created.`,
    );
  }

  // --- An earlier attempt may already have created the sale order ----------
  const existing = await findSaleOrderByClientOrderRef(reference);
  if (existing.length > 1) {
    throw new PermanentJobError(
      `More than one Odoo sale order carries the reference "${reference}", so which ` +
        `one belongs to this order cannot be told. Remove the duplicate's reference ` +
        `or the duplicate itself in Odoo, then retry.`,
    );
  }

  if (existing.length === 1) {
    const saleOrder = existing[0];
    if (saleOrder.state === "cancel") {
      throw new PermanentJobError(
        `Sale order ${saleOrder.name} for this order is cancelled in Odoo; nothing ` +
          `can be invoiced from it. Create a replacement by hand and correct its ` +
          `reference, then retry.`,
      );
    }
    if (saleOrder.state === "draft" || saleOrder.state === "sent") {
      expectWrite(
        await confirmSaleOrder(saleOrder.id, { confirm: true }),
        `Confirming Odoo sale order ${saleOrder.id}`,
      );
    }
    const invoiceId = await adoptOrCreateInvoice(saleOrder.id);
    // Best-effort contact-bookkeeping repair — see repairCompanyMapping.
    const partnerId = m2oId(saleOrder.partner_id);
    const mappingRepair =
      partnerId === null
        ? "no partner on the sale order"
        : await repairCompanyMapping(
            order.sellerId,
            partnerId,
            m2oName(saleOrder.partner_id) ?? "",
          );
    return finaliseDraft({
      order,
      actor,
      invoiceId,
      payment,
      saleOrderId: saleOrder.id,
      partner: null,
      saleOrderReused: true,
      linesSource: null,
      mappingRepair,
      financialHold,
      shipment,
    });
  }

  // --- First real attempt --------------------------------------------------
  const billing = chooseBusinessEmail({
    storeContactEmail: order.seller.application?.storeContactEmail ?? null,
    storeOwnerEmail: order.seller.application?.storeOwnerEmail ?? null,
    contactEmail: order.seller.contactEmail ?? null,
  });
  if (!billing.email) {
    throw new PermanentJobError(
      `No billing email is recorded for this seller, so the invoice could not be ` +
        `addressed. Record a store contact, store owner or application ` +
        `contact email, then retry.`,
    );
  }

  // Everything that can refuse on the catalogue — the template's brand/channel
  // stamps and the SKU resolution — is settled BEFORE the first write, so a
  // refusal leaves no half-made customer behind in Odoo for the operator to
  // clean up. These are reads; the order they run in costs nothing.
  const template = await resolveQuotationTemplate();
  const { lines, source } = invoiceLinesFrom(order);
  const saleOrderLines = await resolveInvoiceLines(lines, order);

  const partner = await resolveBillingPartner(order, billing.email);

  const created = expectWrite(
    await createSaleOrder(
      {
        partnerId: partner.id,
        clientOrderRef: reference,
        templateId: template.id,
        lines: saleOrderLines,
      },
      { confirm: true },
    ),
    `Creating the Odoo sale order for MoonVella order ${order.id}`,
  );
  expectWrite(
    await confirmSaleOrder(created.id, { confirm: true }),
    `Confirming Odoo sale order ${created.id}`,
  );

  const invoiceId = await adoptOrCreateInvoice(created.id);
  const mappingRepair = await repairCompanyMapping(
    order.sellerId,
    partner.id,
    partner.name,
  );

  return finaliseDraft({
    order,
    actor,
    invoiceId,
    payment,
    saleOrderId: created.id,
    partner: { id: partner.id, name: partner.name, outcome: partner.outcome },
    saleOrderReused: false,
    linesSource: source,
    mappingRepair,
    financialHold,
    shipment,
  });
}

/**
 * From a confirmed sale order to a draft invoice id: adopt what the order
 * already owns (a retry after a crash between create and link), else invoice
 * it through Odoo's public wizard. The dedupe preference — a draft, else the
 * newest — is the connector's documented rule, kept in one place.
 */
async function adoptOrCreateInvoice(saleOrderId: number): Promise<number> {
  const invoices = await findInvoicesForSaleOrder({ saleOrderId });
  if (invoices.length > 0) {
    const draft = invoices.filter((invoice) => invoice.state === "draft");
    const pool = draft.length ? draft : invoices;
    return pool[pool.length - 1].id;
  }

  const created = expectWrite(
    await createInvoiceFromSaleOrder(saleOrderId, { confirm: true }),
    `Creating the Odoo invoice for sale order ${saleOrderId}`,
  );
  return created.id;
}

interface FinaliseInput {
  order: InvoiceOrder;
  actor: OdooInvoiceActor;
  invoiceId: number;
  payment: CapturedPayment;
  saleOrderId: number | null;
  partner: OdooInvoiceOutcome["partner"];
  saleOrderReused: boolean | null;
  linesSource: "SNAPSHOT" | "ITEMS" | null;
  mappingRepair: string | null;
  financialHold: string | null;
  shipment: InvoiceShipmentFacts | null;
}

/**
 * Everything downstream of "a draft invoice id exists on the fresh path":
 * clear the tax, verify the total against the captured charge, write the
 * shipment facts, link it on the order, audit it.
 *
 * An invoice adopted from an earlier attempt is only prepared when it is
 * still a draft. One that a person has already posted (or that an earlier
 * incarnation of this pipeline posted) is reported and left exactly as it
 * is — the pipeline's job ended when somebody else's began.
 */
async function finaliseDraft(input: FinaliseInput): Promise<OdooInvoiceOutcome> {
  const { order, invoiceId } = input;
  let state = await readLiveInvoice(invoiceId);

  let shipment: OdooInvoiceOutcome["shipment"] = null;
  if (state.state === "draft") {
    // The owner's "no tax added" rule, enforced on OUR OWN fresh draft: the
    // catalogue's taxes and any fiscal position Odoo applied are cleared from
    // the invoice lines, and the totals are verified after the write — never
    // assumed. (A tax-free draft writes nothing here.)
    expectWrite(
      await clearInvoiceLineTaxes(invoiceId, { confirm: true }),
      `Clearing the taxes on Odoo invoice ${invoiceId}`,
    );
    state = await readLiveInvoice(invoiceId);
    assertDraftMatchesPayment(invoiceId, state, input.payment);

    shipment = await applyShipmentToDraft(invoiceId, state, input.shipment);
  }

  const invoiceName = invoiceNameOf(state);
  await writeOrderLink(order, {
    invoiceId,
    invoiceName,
    saleOrderId: input.saleOrderId,
    state: state.state,
  });
  const status = state.state === "draft" ? "CREATED" : "POSTED";
  await recordSync(order, input.actor, {
    status,
    state,
    saleOrderId: input.saleOrderId,
    saleOrderReused: input.saleOrderReused,
    partner: input.partner,
    linesSource: input.linesSource,
    shipment,
    mappingRepair: input.mappingRepair,
    financialHold: input.financialHold,
    payment: input.payment,
  });

  return {
    status,
    orderId: order.id,
    odooInvoiceId: invoiceId,
    odooInvoiceName: invoiceName,
    odooSaleOrderId: input.saleOrderId,
    invoice: invoiceView(state),
    partner: input.partner,
    shipment,
  };
}

/**
 * Writes the order's shipment facts onto a DRAFT invoice, each part only when
 * it changes something:
 *
 *  - the tracking number goes to the invoice's own `mv_shipping_tracking_ref`
 *    field, and only when it differs from what the field already holds;
 *  - the whole block (carrier, service, tracking, provider reference) goes to
 *    the chatter as ONE internal note, posted only when its text is not
 *    already there. The note carries a stable marker, so the retry finds its
 *    own note rather than a person's comment, and comparing the normalised
 *    text is what stops a retry from stacking duplicate notes.
 *
 * With nothing to say (no shipment row, or one with all four facts blank)
 * this is a no-op — null — and no write of any kind reaches Odoo.
 */
async function applyShipmentToDraft(
  invoiceId: number,
  state: OdooInvoiceState,
  facts: InvoiceShipmentFacts | null,
): Promise<OdooInvoiceOutcome["shipment"]> {
  if (!facts) return null;

  let trackingRefWritten = false;
  if (facts.trackingNumber && state.mv_shipping_tracking_ref !== facts.trackingNumber) {
    expectWrite(
      await writeInvoiceTrackingRef(invoiceId, facts.trackingNumber, { confirm: true }),
      `Writing the tracking number onto Odoo invoice ${invoiceId}`,
    );
    trackingRefWritten = true;
  }

  const body = shipmentNoteBody(facts);
  const wanted = normaliseNoteBody(body);
  const notes = await findInvoiceNotes(invoiceId, SHIPMENT_NOTE_MARKER);
  const alreadyThere = notes.some(
    (note) => typeof note.body === "string" && normaliseNoteBody(note.body) === wanted,
  );

  let notePosted = false;
  if (!alreadyThere) {
    expectWrite(
      await postInvoiceNote(invoiceId, body, { confirm: true }),
      `Recording the shipment details on Odoo invoice ${invoiceId}`,
    );
    notePosted = true;
  }

  return { ...facts, trackingRefWritten, notePosted };
}

/** The one line the chatter note opens with — also the search marker. */
function shipmentNoteBody(facts: InvoiceShipmentFacts): string {
  const parts = [
    facts.carrier ? `Carrier: ${facts.carrier}` : null,
    facts.service ? `Service: ${facts.service}` : null,
    facts.trackingNumber ? `Tracking: ${facts.trackingNumber}` : null,
    facts.providerReference ? `Provider ref: ${facts.providerReference}` : null,
  ].filter((part): part is string => part !== null);
  return `${SHIPMENT_NOTE_MARKER} ${parts.join(" · ")}`;
}

/**
 * What Odoo stores for a posted string is HTML (`<p>…</p>`, entities
 * escaped), so the comparison strips tags, decodes the entities a name can
 * realistically contain, and collapses whitespace. Comparing raw HTML would
 * make every retry re-post a note that is already there.
 */
function normaliseNoteBody(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the order's most recent shipment says, trimmed; null when it says nothing. */
function shipmentFactsFrom(order: InvoiceOrder): InvoiceShipmentFacts | null {
  const shipment = order.shipments[0];
  if (!shipment) return null;
  const facts: InvoiceShipmentFacts = {
    carrier: trimmed(shipment.carrier),
    service: trimmed(shipment.serviceName) ?? trimmed(shipment.serviceCode),
    trackingNumber: trimmed(shipment.trackingNumber),
    // The provider's own identifier for the booked shipment — the reference a
    // person quotes to the carrier. The booking's quote id is the fallback,
    // because it is the reference that exists when the shipment id does not.
    providerReference:
      trimmed(shipment.providerShipmentId) ?? trimmed(shipment.providerQuoteId),
  };
  if (!facts.carrier && !facts.service && !facts.trackingNumber && !facts.providerReference) {
    return null;
  }
  return facts;
}

function trimmed(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

/** A draft's `name` is "/" until it is posted; that is not a number to show. */
function invoiceNameOf(state: OdooInvoiceState): string | null {
  const name = typeof state.name === "string" ? state.name.trim() : "";
  return name && name !== "/" ? name : null;
}

function invoiceView(state: OdooInvoiceState): OdooInvoiceOutcome["invoice"] {
  return {
    state: state.state,
    paymentState: state.payment_state,
    amountTotal: state.amount_total,
    amountTax: state.amount_tax,
  };
}

/** The link columns + the state the last sync observed, cleared error. */
async function writeOrderLink(
  order: InvoiceOrder,
  data: {
    invoiceId: number;
    invoiceName: string | null;
    saleOrderId: number | null;
    state: string;
  },
): Promise<void> {
  await prisma.order.update({
    where: { id: order.id },
    data: {
      odooInvoiceId: data.invoiceId,
      odooInvoiceName: data.invoiceName,
      odooSaleOrderId: data.saleOrderId,
      odooInvoiceState: data.state,
      // Bumped on every write, including a refresh: it means "this is when the
      // state column was last verified against Odoo", and the order page shows
      // the pair together.
      odooInvoiceSyncedAt: new Date(),
      odooInvoiceError: null,
    },
  });
}

interface SyncAudit {
  status: OdooInvoiceOutcome["status"];
  state: OdooInvoiceState;
  saleOrderId: number | null;
  saleOrderReused: boolean | null;
  partner: OdooInvoiceOutcome["partner"];
  linesSource: "SNAPSHOT" | "ITEMS" | null;
  shipment: OdooInvoiceOutcome["shipment"];
  mappingRepair: string | null;
  financialHold: string | null;
  payment?: CapturedPayment;
}

async function recordSync(
  order: InvoiceOrder,
  actor: OdooInvoiceActor,
  input: SyncAudit,
): Promise<void> {
  await recordAudit({
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorName: actor.actorName ?? null,
    action:
      input.status === "CREATED"
        ? "order.odoo_invoice_created"
        : "order.odoo_invoice_updated",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: order.id,
    beforeData: {
      odooInvoiceId: order.odooInvoiceId,
      odooInvoiceState: order.odooInvoiceState,
      odooInvoiceSyncedAt: order.odooInvoiceSyncedAt?.toISOString() ?? null,
      odooInvoiceError: order.odooInvoiceError,
    },
    afterData: {
      status: input.status,
      odooInvoiceId: input.state.id,
      odooInvoiceName: invoiceNameOf(input.state),
      odooSaleOrderId: input.saleOrderId,
      invoiceState: input.state.state,
      invoicePaymentState: input.state.payment_state,
      amountTotal: input.state.amount_total,
      amountTax: input.state.amount_tax,
      currency: m2oName(input.state.currency_id),
      companyId: m2oId(input.state.company_id),
      partner: input.partner,
      saleOrderReused: input.saleOrderReused,
      linesSource: input.linesSource,
      shipment: input.shipment,
      capturedAt: input.payment?.capturedAt?.toISOString() ?? null,
      // Recorded, deliberately NOT enforced: the goods have shipped and the
      // money has moved, so a hold from approval time must not strand the
      // draft — but the operator should be able to see it existed.
      financialHold: input.financialHold,
      mappingRepair: input.mappingRepair,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });
}

async function readLiveInvoice(invoiceId: number): Promise<OdooInvoiceState> {
  const state = await getInvoiceState(invoiceId);
  if (!state) {
    throw new PermanentJobError(
      `Odoo invoice ${invoiceId} does not exist (it was deleted after being ` +
        `linked, or the link is wrong). Nothing is recreated automatically.`,
    );
  }
  if (state.state === "cancel") {
    throw new PermanentJobError(
      `Odoo invoice ${state.name === false ? invoiceId : state.name} is cancelled, ` +
        `so it cannot be reviewed or linked. Decide what the order's invoice ` +
        `should be, then clear or correct the link (invoice id/name on the order).`,
    );
  }
  return state;
}

/**
 * The numbers that must agree on a FRESH draft, verified after the tax clear:
 * it must carry no tax at all, and it must total exactly the amount that was
 * captured, in the same currency. A draft that disagrees is left unlinked and
 * unreported — reconciling the sale order and the charge is a human decision.
 *
 * Deliberately NOT run when an already-linked draft is merely being refreshed
 * with shipment facts: by then the draft is a person's workspace in Odoo, and
 * a note refresh must not fail on an edit they made on purpose.
 */
function assertDraftMatchesPayment(
  invoiceId: number,
  state: OdooInvoiceState,
  payment: CapturedPayment,
): void {
  const label = state.name === false ? invoiceId : state.name;
  const expected = payment.amount / 100;

  const invoiceCurrency = m2oName(state.currency_id);
  if (invoiceCurrency && invoiceCurrency !== payment.currency) {
    throw new PermanentJobError(
      `Odoo invoice ${label} is in ${invoiceCurrency} but the captured wholesale ` +
        `payment is in ${payment.currency}. One cannot bill the other, so the ` +
        `draft was left unlinked for a person to reconcile.`,
    );
  }
  if (Math.abs(state.amount_tax) > 0.005) {
    throw new PermanentJobError(
      `Odoo invoice ${label} still carries ${state.amount_tax.toFixed(2)} of tax ` +
        `after its draft lines were cleared, so it was left unlinked. Nothing is ` +
        `sent and nothing is posted — review the invoice in Odoo.`,
    );
  }
  if (Math.abs(state.amount_total - expected) > 0.005) {
    throw new PermanentJobError(
      `Odoo invoice ${label} totals ${state.amount_total.toFixed(2)} but the ` +
        `captured wholesale payment is ${expected.toFixed(2)} ${payment.currency}. ` +
        `The sale order and the charge disagree, and reconciling them is a human ` +
        `decision — the draft was left unlinked for review.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Lookups and line building                                                  */
/* -------------------------------------------------------------------------- */

function requireCapturedPayment(order: InvoiceOrder): CapturedPayment {
  const payment = order.wholesalePayment;
  if (!payment) {
    throw new PermanentJobError(
      `Order ${order.id} has no wholesale payment, so there is no captured ` +
        `charge to invoice.`,
    );
  }
  if (payment.status !== "SUCCEEDED") {
    throw new PermanentJobError(
      `Order ${order.id}'s wholesale payment is ${payment.status}, not SUCCEEDED, ` +
        `so no invoice draft is created. If the payment succeeds later, the ` +
        `draft is created then (the handoff retry or the button on the order ` +
        `page).`,
    );
  }
  return payment;
}

interface InvoiceLineSource {
  sku: string;
  quantity: number;
  unitPriceMinor: number;
}

/**
 * The lines the invoice must carry, from the price snapshot the charge was
 * computed from — the same numbers Stripe captured. The snapshot's treatment
 * is asserted rather than assumed: a wholesale invoice bills the lines only
 * (tax and shipping are already inside the seller's price), so a snapshot that
 * says otherwise is a shape this pipeline does not know how to bill and it
 * refuses to guess.
 *
 * Orders placed before snapshots existed fall back to the order's own line
 * rows, which hold the same four numbers.
 */
function invoiceLinesFrom(order: InvoiceOrder): {
  lines: InvoiceLineSource[];
  source: "SNAPSHOT" | "ITEMS";
} {
  const snapshot = order.wholesalePayment?.priceSnapshot;

  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const record = snapshot as Record<string, unknown>;
    const rawLines = record.lines;
    if (Array.isArray(rawLines) && rawLines.length > 0) {
      const treatment = (record.treatment ?? {}) as Record<string, unknown>;
      if (
        treatment.tax !== "NOT_ADDED_TO_WHOLESALE" ||
        treatment.shipping !== "INCLUDED_IN_SELLER_PRICE"
      ) {
        throw new PermanentJobError(
          `The price snapshot behind order ${order.id}'s charge records a ` +
            `tax/shipping treatment the invoice cannot reproduce (tax: ` +
            `${String(treatment.tax)}, shipping: ${String(treatment.shipping)}). ` +
            `A wholesale invoice bills the lines only — tax and shipping are ` +
            `already inside the seller's price — so the pipeline refuses to ` +
            `guess which lines to write.`,
        );
      }
      const lines = rawLines.map((line, index) => {
        const parsed = parseSnapshotLine(line);
        if (!parsed) {
          throw new PermanentJobError(
            `Line ${index + 1} of order ${order.id}'s price snapshot is not a ` +
              `readable charge line, so the invoice lines cannot be trusted.`,
          );
        }
        return parsed;
      });
      return { lines, source: "SNAPSHOT" };
    }
  }

  const lines = order.items.map((item) => ({
    sku: item.sku,
    quantity: item.quantity,
    unitPriceMinor: item.wholesalePrice,
  }));
  if (lines.length === 0) {
    throw new PermanentJobError(
      `Order ${order.id} has no items, so there is nothing to invoice.`,
    );
  }
  return { lines, source: "ITEMS" };
}

function parseSnapshotLine(value: unknown): InvoiceLineSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  const sku = typeof line.sku === "string" ? line.sku.trim() : "";
  const { quantity, unitPriceMinor } = line;
  if (!sku) return null;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  if (typeof unitPriceMinor !== "number" || !Number.isFinite(unitPriceMinor)) {
    return null;
  }
  return { sku, quantity, unitPriceMinor };
}

/**
 * Ordered SKUs → Odoo product ids, with every failure named at once so one
 * run tells the operator everything that is missing. No branch here can
 * produce a line without a product: the work order's rule is that a matching
 * Odoo product is used, and a SKU without one is an error.
 *
 * Every line is sent with an EXPLICIT EMPTY sale-tax set (`tax_id: [(6,0,[])]`).
 * That is the owner's "no tax added" rule stated at the source, and it is why
 * the old catalogue-tax refusal is gone: the draft no longer has to hope the
 * products are tax-free — it states it on the line, and the invoice's own
 * lines are then cleared and verified tax-free regardless
 * (`finaliseDraft`), so the outcome does not depend on the catalogue at all.
 */
async function resolveInvoiceLines(
  lines: InvoiceLineSource[],
  order: InvoiceOrder,
): Promise<{ productId: number; quantity: number; priceUnit: number; taxIds: number[] }[]> {
  const products = await resolveProductIdsBySku(lines.map((line) => line.sku));

  const bySku = new Map<string, typeof products>();
  for (const product of products) {
    const code = typeof product.default_code === "string" ? product.default_code.trim() : "";
    if (!code) continue;
    const list = bySku.get(code) ?? [];
    list.push(product);
    bySku.set(code, list);
  }

  const missing: string[] = [];
  const ambiguous: string[] = [];
  const wrongPolicy: string[] = [];
  const resolved: { productId: number; quantity: number; priceUnit: number; taxIds: number[] }[] = [];

  for (const line of lines) {
    const matches = bySku.get(line.sku) ?? [];
    if (matches.length === 0) {
      missing.push(line.sku);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(line.sku);
      continue;
    }
    const product = matches[0];
    if (product.invoice_policy !== "order") {
      wrongPolicy.push(`${line.sku} (${product.invoice_policy || "blank"})`);
      continue;
    }
    resolved.push({
      productId: product.id,
      quantity: line.quantity,
      priceUnit: line.unitPriceMinor / 100,
      taxIds: [],
    });
  }

  if (missing.length || ambiguous.length || wrongPolicy.length) {
    const reasons = [
      missing.length
        ? `no Odoo product carries the SKU(s) ${missing.join(", ")} — a free-text ` +
          `line is not created in their place`
        : null,
      ambiguous.length
        ? `more than one Odoo product carries the SKU(s) ${ambiguous.join(", ")}`
        : null,
      wrongPolicy.length
        ? `the product(s) ${wrongPolicy.join(", ")} have an Invoicing Policy other ` +
          `than "Ordered quantities", which the automatic invoice requires (it has ` +
          `no delivery to invoice against)`
        : null,
    ].filter((reason): reason is string => reason !== null);

    throw new PermanentJobError(
      `Order ${order.id} cannot be invoiced from its Odoo catalogue: ` +
        `${reasons.join("; ")}. Fix the catalogue in Odoo, then retry.`,
    );
  }

  return resolved;
}

async function resolveBillingPartner(
  order: InvoiceOrder,
  billingEmail: string,
): Promise<{ id: number; name: string; outcome: "CREATED" | "REUSED" }> {
  const existing = await findPartnerByEmail(billingEmail);
  if (existing) {
    return { id: existing.id, name: existing.name, outcome: "REUSED" };
  }

  const legalName = order.seller.application?.legalBusinessName?.trim();
  if (!legalName) {
    throw new PermanentJobError(
      `No Odoo contact uses ${billingEmail}, and the seller's application records ` +
        `no legal business name — so there is no name the invoice's customer could ` +
        `be created under. Fill the legal business name on the application, then ` +
        `retry.`,
    );
  }

  // The same MoonVella tag the contact sync adds, so a contact born here is
  // recognisable as an app contact to whoever reads the Odoo address book.
  // Best-effort: a missing tag is not a reason to strand a financial record.
  const tag = await findContactTagByName().catch(() => null);

  const created = expectWrite(
    await createPartner(
      {
        name: legalName,
        email: billingEmail,
        is_company: true,
        customer_rank: 1,
        ...(tag ? { category_ids: [tag.id] } : {}),
      },
      { confirm: true },
    ),
    `Creating the Odoo contact "${legalName}"`,
  );
  return { id: created.id, name: legalName, outcome: "CREATED" };
}

/**
 * The "MoonVella B2B Wholesale" quotation template, asserted to carry the
 * MoonVella stamps. The stamps are what route the invoice PDF, so a template
 * without them is not this template no matter what it is named — and it is
 * fixed in Odoo, not worked around here.
 */
async function resolveQuotationTemplate(): Promise<OdooSaleOrderTemplateRef> {
  const templates = await findSaleOrderTemplateByName(B2B_QUOTATION_TEMPLATE_NAME);
  if (templates.length === 0) {
    throw new PermanentJobError(
      `No Odoo quotation template named "${B2B_QUOTATION_TEMPLATE_NAME}" exists, so ` +
        `the invoice cannot be created from it. Create/restore the template in ` +
        `Odoo, then retry.`,
    );
  }
  if (templates.length > 1) {
    throw new PermanentJobError(
      `More than one Odoo quotation template is named ` +
        `"${B2B_QUOTATION_TEMPLATE_NAME}"; the one to invoice from must be ` +
        `unambiguous.`,
    );
  }

  const template = templates[0];
  if (
    template.prema_operating_brand !== "moonvella" ||
    template.prema_sales_channel !== "direct_b2b"
  ) {
    throw new PermanentJobError(
      `Quotation template "${B2B_QUOTATION_TEMPLATE_NAME}" (id ${template.id}) does ` +
        `not carry the MoonVella stamps the invoice document depends on: it has ` +
        `prema_operating_brand=${JSON.stringify(template.prema_operating_brand)} and ` +
        `prema_sales_channel=${JSON.stringify(template.prema_sales_channel)}, ` +
        `expected "moonvella" and "direct_b2b". Fix the template in Odoo — the ` +
        `invoice PDF is routed by these.`,
    );
  }
  return template;
}

/**
 * Best-effort repair of the seller's COMPANY contact mapping: fill a missing
 * `odooPartnerId` with the partner this invoice actually went to, and nothing
 * else. Status, error and sync timestamps are left untouched — a FAILED
 * mapping stays FAILED and visible — and a mapping that points at a different
 * partner is reported, not overwritten. Never throws: contact bookkeeping must
 * not strand a financial record, and the outcome string lands in the audit.
 */
async function repairCompanyMapping(
  sellerId: string,
  partnerId: number,
  partnerName: string,
): Promise<string> {
  try {
    const mapping = await prisma.externalContactMapping.findUnique({
      where: { sellerId_role: { sellerId, role: "COMPANY" } },
    });
    if (!mapping) {
      return "no COMPANY contact mapping exists; the contact sync will create it";
    }
    if (mapping.odooPartnerId) {
      return mapping.odooPartnerId === partnerId
        ? "mapping already points at this partner"
        : `mapping points at Odoo partner ${mapping.odooPartnerId}, not ${partnerId}`;
    }
    await prisma.externalContactMapping.update({
      where: { id: mapping.id },
      data: { odooPartnerId: partnerId, odooName: partnerName },
    });
    return `filled missing partner id ${partnerId} (status left as ${mapping.status})`;
  } catch (error) {
    return `mapping repair failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/* -------------------------------------------------------------------------- */
/* Small shared shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A confirmed write that answered with a preview means the guard refused it.
 * Today `assertWriteAllowed` throws before that can happen, so this is
 * defence in depth — but the union type says the preview is possible, and
 * continuing past one would half-build an invoice.
 */
function expectWrite<T extends object>(result: T | OdooWritePreview, what: string): T {
  const preview = result as Partial<OdooWritePreview>;
  if (preview.executed === false && typeof preview.operation === "string") {
    throw new OdooError(
      `${what} was not executed: the write guard refused it (operation ` +
        `"${preview.operation}"). Writes need ODOO_MODE=live and ` +
        `ODOO_ALLOW_WRITES=yes.`,
      "WRITE_NOT_EXECUTED",
    );
  }
  return result as T;
}

function m2oId(value: [number, string] | false | null | undefined): number | null {
  return Array.isArray(value) && typeof value[0] === "number" ? value[0] : null;
}

function m2oName(value: [number, string] | false | null | undefined): string | null {
  return Array.isArray(value) && typeof value[1] === "string" ? value[1] : null;
}
