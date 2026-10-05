/**
 * The seller's PAID Odoo invoice for a MoonVella order.
 *
 * This module is the whole carrier-handoff invoice flow: partner → sale order
 * created from the "MoonVella B2B Wholesale" quotation template → confirm →
 * invoice → post → payment ledger entry → branded email → link on the order.
 * It is called from exactly two places — the ODOO_INVOICE_SYNC job queued by
 * the handoff milestone, and the repair button on the order page — and it
 * always writes with `confirm: true`, because every caller has already decided
 * the invoice should exist.
 *
 * Three rules shape every decision here:
 *
 * 1. **The invoice is a financial record.** It is never created twice.
 *    `Order.odooInvoiceId` is the guard: once it is set, a re-run adopts the
 *    invoice it names — and when that invoice is gone from Odoo, the pipeline
 *    stops and says so rather than making another one.
 * 2. **Nothing is invented.** Lines come from the Odoo products the ordered
 *    SKUs name; a SKU without a product is an error, never a free-text line.
 *    Money comes from the captured Stripe amount, and a disagreement between
 *    that amount and the invoice total stops the pipeline rather than
 *    registering a payment that does not match the charge.
 * 3. **Odoo is not a payment rail here.** The Stripe charge happened before
 *    handoff; the payment written into Odoo is the ledger entry that records
 *    it. Nothing in this file calls a payment provider, and nothing can: the
 *    only writes it performs are the connector's guarded sale-order, invoice,
 *    payment-wizard and mail calls.
 *
 * Failure contract: a failure marks the order (`odooInvoiceError`), records an
 * audit row, and rethrows the original error untouched — the queue keys its
 * retry/permanent behaviour off that error, and the route answers with it.
 * `PermanentJobError` means retrying cannot help until a human changes
 * something (a missing product, a missing journal, a canceled invoice);
 * anything else is retried by the queue.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { PermanentJobError } from "./jobs.server";
import { chooseBusinessEmail, financialActionHold } from "./odooContacts.server";
import { getCredentials } from "./credentials.server";
import {
  OdooError,
  confirmSaleOrder,
  createInvoiceFromSaleOrder,
  createPartner,
  createSaleOrder,
  findContactTagByName,
  findInvoicesForSaleOrder,
  findJournalByName,
  findMailTemplateByName,
  findPartnerByEmail,
  findSaleOrderByClientOrderRef,
  findSaleOrderTemplateByName,
  getInvoiceState,
  postInvoice,
  registerPayment,
  resolveProductIdsBySku,
  sendInvoiceEmail,
  type OdooInvoiceState,
  type OdooJournalRef,
  type OdooMailTemplateRef,
  type OdooSaleOrderTemplateRef,
  type OdooWritePreview,
} from "./odoo.server";

/**
 * The quotation template the invoice is created from. Its name is the contract
 * here: the template is what stamps the brand and sales channel that decide
 * the PDF and the email, so the app looks it up by this exact name and fails
 * loudly when the row is missing or mis-stamped — it never sends the brand
 * literals itself.
 */
export const B2B_QUOTATION_TEMPLATE_NAME = "MoonVella B2B Wholesale";

/**
 * The branded mail template the invoice is sent with. Shipped by the
 * `prema_moonvella_documents` module; looked up by exact name because the
 * module is the source of its content (from-address, B2B report routing).
 */
export const B2B_INVOICE_MAIL_TEMPLATE_NAME =
  "MoonVella — B2B Wholesale Paid Invoice";

/**
 * The Settings field naming the Odoo journal the payment is registered in.
 * The journal is an accounting decision made in Odoo; the app stores which
 * NAME to use and resolves it at invoice time so a renamed journal is a
 * Settings edit, not a deploy.
 */
export const ODOO_INVOICE_JOURNAL_SETTING = "ODOO_INVOICE_JOURNAL";

/** Used when the setting is empty. The owner creates this journal in Odoo. */
export const DEFAULT_INVOICE_JOURNAL_NAME = "MoonVella Stripe";

/** Who asked for the invoice — the job runner or a signed-in admin. */
export interface OdooInvoiceActor {
  actorType: "ADMIN_USER" | "SYSTEM";
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface OdooInvoiceOutcome {
  status: "CREATED" | "ALREADY_CREATED";
  orderId: string;
  odooInvoiceId: number;
  odooInvoiceName: string | null;
  odooSaleOrderId: number | null;
  /** The invoice's live state in Odoo, re-read after the last write. */
  invoice: {
    state: string;
    paymentState: string | false;
    amountTotal: number;
  };
  /** Set when this run resolved the customer partner; null on adopt/resume. */
  partner: { id: number; name: string; outcome: "CREATED" | "REUSED" } | null;
  /** The ledger entry this run registered; null when it was already paid. */
  payment: {
    journalId: number;
    journalName: string;
    amount: number;
    paymentDate: string;
  } | null;
  /** The queued email this run sent; null when it had already been sent. */
  email: { templateId: number; mailId: number } | null;
}

const invoiceOrderSelect = {
  id: true,
  sellerId: true,
  supplierReference: true,
  odooInvoiceId: true,
  odooInvoiceName: true,
  odooSaleOrderId: true,
  odooInvoiceSyncedAt: true,
  odooInvoiceEmailSentAt: true,
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
 * Create (or adopt) the order's paid Odoo invoice.
 *
 * Idempotent by construction: the order row's link columns decide what happens
 * — a fully linked order is reported, a linked order missing only its email is
 * resumed, and only an unlinked order builds anything new.
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
  // --- 1. Already done, or nearly done ------------------------------------
  if (order.odooInvoiceId) {
    const state = await getInvoiceState(order.odooInvoiceId);
    if (!state) {
      // Never auto-recreate. The row says an invoice exists; if Odoo
      // disagrees, which of the two is wrong is a decision for a person.
      throw new PermanentJobError(
        `Order ${order.id} is linked to Odoo invoice ` +
          `${order.odooInvoiceName ?? order.odooInvoiceId}, but that invoice no longer ` +
          `exists in Odoo. It is not recreated automatically — restore it, or clear ` +
          `the link (invoice id/name on the order) after deciding what the order's ` +
          `invoice should be, then retry.`,
      );
    }

    if (order.odooInvoiceEmailSentAt) {
      // Everything already happened. Report the live state; clear a stale
      // error if one was left behind by something else.
      if (order.odooInvoiceError) {
        await prisma.order.update({
          where: { id: order.id },
          data: { odooInvoiceError: null },
        });
      }
      return {
        status: "ALREADY_CREATED",
        orderId: order.id,
        odooInvoiceId: order.odooInvoiceId,
        odooInvoiceName: state.name === false ? null : state.name,
        odooSaleOrderId: order.odooSaleOrderId,
        invoice: {
          state: state.state,
          paymentState: state.payment_state,
          amountTotal: state.amount_total,
        },
        partner: null,
        payment: null,
        email: null,
      };
    }

    // Linked but not emailed: the last step failed after the invoice existed.
    // Resume from the stored link — post/pay only if still needed, then email.
    const payment = requireCapturedPayment(order);
    const financialHold = await financialActionHold(order.sellerId);
    return settleInvoice({
      order,
      actor,
      invoiceId: order.odooInvoiceId,
      payment,
      resumed: true,
      saleOrderId: order.odooSaleOrderId,
      partner: null,
      saleOrderReused: null,
      linesSource: null,
      mappingRepair: null,
      financialHold,
    });
  }

  // --- 2. The money gate ---------------------------------------------------
  // A paid invoice is created only for money that has actually been captured.
  // Any other state is a human's decision (a failed card is retried in the
  // app; a refunded charge is reconciled by hand).
  const payment = requireCapturedPayment(order);
  const financialHold = await financialActionHold(order.sellerId);

  // --- 3. Build it ---------------------------------------------------------
  return createFreshInvoice(order, actor, payment, financialHold);
}

async function createFreshInvoice(
  order: InvoiceOrder,
  actor: OdooInvoiceActor,
  payment: CapturedPayment,
  financialHold: string | null,
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
    return settleInvoice({
      order,
      actor,
      invoiceId,
      payment,
      resumed: false,
      saleOrderId: saleOrder.id,
      partner: null,
      saleOrderReused: true,
      linesSource: null,
      mappingRepair,
      financialHold,
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
        `addressed or sent. Record a store contact, store owner or application ` +
        `contact email, then retry.`,
    );
  }

  const partner = await resolveBillingPartner(order, billing.email);
  const template = await resolveQuotationTemplate();

  const { lines, source } = invoiceLinesFrom(order);
  const saleOrderLines = await resolveInvoiceLines(lines, order);

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

  return settleInvoice({
    order,
    actor,
    invoiceId,
    payment,
    resumed: false,
    saleOrderId: created.id,
    partner: { id: partner.id, name: partner.name, outcome: partner.outcome },
    saleOrderReused: false,
    linesSource: source,
    mappingRepair,
    financialHold,
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

interface SettleInput {
  order: InvoiceOrder;
  actor: OdooInvoiceActor;
  invoiceId: number;
  payment: CapturedPayment;
  /** True when the invoice id came from the order row, not from this run. */
  resumed: boolean;
  saleOrderId: number | null;
  partner: OdooInvoiceOutcome["partner"];
  saleOrderReused: boolean | null;
  linesSource: "SNAPSHOT" | "ITEMS" | null;
  mappingRepair: string | null;
  financialHold: string | null;
}

/**
 * Everything downstream of "a draft invoice id exists": post it, register the
 * payment that records the already-captured charge, email it, link it on the
 * order, audit it. Shared by the create and resume paths so the payment
 * guards and the email-remembering order apply identically to both.
 */
async function settleInvoice(input: SettleInput): Promise<OdooInvoiceOutcome> {
  const { order, invoiceId } = input;

  let state = await readLiveInvoice(invoiceId);

  if (state.state !== "posted") {
    expectWrite(
      await postInvoice(invoiceId, { confirm: true }),
      `Posting Odoo invoice ${invoiceId}`,
    );
    // Re-read: posting is what assigns the invoice number.
    state = await readLiveInvoice(invoiceId);
  }

  const paymentOutcome = await ensurePaymentRegistered(input, state);
  if (paymentOutcome) {
    // Re-read so the audit records the state the payment moved it to.
    state = await readLiveInvoice(invoiceId);
  }

  let emailOutcome: OdooInvoiceOutcome["email"] = null;
  let emailSentAt = order.odooInvoiceEmailSentAt;
  if (!emailSentAt) {
    const template = await resolveInvoiceMailTemplate();
    const sent = expectWrite(
      await sendInvoiceEmail(template.id, invoiceId, { confirm: true }),
      `Sending Odoo invoice ${invoiceId} by email`,
    );
    // Remembered before anything else can fail. Sending is the one step with
    // an external effect that cannot be undone, so the order must record that
    // it happened even if the process dies on the next line.
    emailSentAt = new Date();
    await prisma.order.update({
      where: { id: order.id },
      data: { odooInvoiceEmailSentAt: emailSentAt },
    });
    emailOutcome = { templateId: template.id, mailId: sent.mailId };
  }

  const invoiceName = state.name === false ? null : state.name;
  await prisma.order.update({
    where: { id: order.id },
    data: {
      odooInvoiceId: invoiceId,
      odooInvoiceName: invoiceName,
      odooSaleOrderId: input.saleOrderId,
      odooInvoiceSyncedAt: order.odooInvoiceSyncedAt ?? new Date(),
      odooInvoiceEmailSentAt: emailSentAt,
      odooInvoiceError: null,
    },
  });

  await recordAudit({
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    actorName: input.actor.actorName ?? null,
    action: "order.odoo_invoice_created",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: order.id,
    beforeData: {
      odooInvoiceId: order.odooInvoiceId,
      odooInvoiceError: order.odooInvoiceError,
    },
    afterData: {
      resumed: input.resumed,
      odooInvoiceId: invoiceId,
      odooInvoiceName: invoiceName,
      odooSaleOrderId: input.saleOrderId,
      invoiceState: state.state,
      invoicePaymentState: state.payment_state,
      amountTotal: state.amount_total,
      currency: m2oName(state.currency_id),
      companyId: m2oId(state.company_id),
      partner: input.partner,
      saleOrderReused: input.saleOrderReused,
      linesSource: input.linesSource,
      payment: paymentOutcome,
      email: emailOutcome,
      capturedAt: input.payment.capturedAt?.toISOString() ?? null,
      // Recorded, deliberately NOT enforced: the goods have shipped and the
      // money has moved, so a hold from approval time must not strand the
      // invoice — but the operator should be able to see it existed.
      financialHold: input.financialHold,
      mappingRepair: input.mappingRepair,
    },
    ipAddress: input.actor.ipAddress ?? null,
    userAgent: input.actor.userAgent ?? null,
  });

  return {
    status: "CREATED",
    orderId: order.id,
    odooInvoiceId: invoiceId,
    odooInvoiceName: invoiceName,
    odooSaleOrderId: input.saleOrderId,
    invoice: {
      state: state.state,
      paymentState: state.payment_state,
      amountTotal: state.amount_total,
    },
    partner: input.partner,
    payment: paymentOutcome,
    email: emailOutcome,
  };
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
        `so it cannot be posted, paid or emailed. Cancel the link by hand and ` +
        `decide what the order's invoice should be.`,
    );
  }
  return state;
}

/**
 * Register the ledger entry recording the captured charge, unless the invoice
 * is already paid. Two guards run first, because this is the step that writes
 * money numbers into the books:
 *
 * - the invoice total must equal the captured amount (to the cent), so a sale
 *   order whose price drifted from the charge cannot be "paid" by a payment
 *   that does not match it;
 * - the currencies must be the same, or "equal amounts" would compare two
 *   different things.
 */
async function ensurePaymentRegistered(
  input: SettleInput,
  state: OdooInvoiceState,
): Promise<OdooInvoiceOutcome["payment"]> {
  const alreadyPaid = ["paid", "in_payment", "partial"].includes(
    state.payment_state || "",
  );
  if (alreadyPaid) return null;

  const { payment } = input;
  const expected = payment.amount / 100;

  const invoiceCurrency = m2oName(state.currency_id);
  if (invoiceCurrency && invoiceCurrency !== payment.currency) {
    throw new PermanentJobError(
      `Odoo invoice ${state.name === false ? input.invoiceId : state.name} is in ` +
        `${invoiceCurrency} but the captured wholesale payment is in ` +
        `${payment.currency}. Registering one as a payment of the other would ` +
        `misstate both ledgers — reconcile by hand.`,
    );
  }
  if (Math.abs(state.amount_total - expected) > 0.005) {
    throw new PermanentJobError(
      `Odoo invoice ${state.name === false ? input.invoiceId : state.name} totals ` +
        `${state.amount_total.toFixed(2)} but the captured wholesale payment is ` +
        `${expected.toFixed(2)} ${payment.currency}. The invoice is not marked paid ` +
        `— the sale order and the charge disagree, and reconciling them is a ` +
        `human decision.`,
    );
  }

  const journal = await resolvePaymentJournal();
  const paymentDate = (payment.capturedAt ?? new Date()).toISOString().slice(0, 10);
  expectWrite(
    await registerPayment(
      {
        invoiceId: input.invoiceId,
        journalId: journal.id,
        amount: expected,
        paymentDate,
      },
      { confirm: true },
    ),
    `Registering the payment for Odoo invoice ${input.invoiceId}`,
  );

  return {
    journalId: journal.id,
    journalName: journal.name,
    amount: expected,
    paymentDate,
  };
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
        `so a PAID invoice is not created. If the payment succeeds later, the ` +
        `invoice is created then (the handoff retry or the button on the order ` +
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
 */
async function resolveInvoiceLines(
  lines: InvoiceLineSource[],
  order: InvoiceOrder,
): Promise<{ productId: number; quantity: number; priceUnit: number }[]> {
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
  const resolved: { productId: number; quantity: number; priceUnit: number }[] = [];

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
 * MoonVella stamps. The stamps are what route the invoice PDF and the email,
 * so a template without them is not this template no matter what it is named
 * — and it is fixed in Odoo, not worked around here.
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
        `invoice PDF and email are routed by these.`,
    );
  }
  return template;
}

/**
 * The journal named by the Settings field (default "MoonVella Stripe"),
 * required to resolve to exactly one bank or cash journal. Resolved by NAME
 * because choosing the journal is the owner's accounting decision — the app
 * never picks among candidates.
 */
async function resolvePaymentJournal(): Promise<OdooJournalRef> {
  const credentials = await getCredentials("odoo");
  const configured = (credentials[ODOO_INVOICE_JOURNAL_SETTING] ?? "").trim();
  const name = configured || DEFAULT_INVOICE_JOURNAL_NAME;

  const journals = await findJournalByName(name);
  const usable = journals.filter(
    (journal) => journal.type === "bank" || journal.type === "cash",
  );

  if (usable.length === 0) {
    throw new PermanentJobError(
      `No Odoo journal named "${name}" exists as a bank or cash journal, so the ` +
        `invoice's payment cannot be recorded. Create that journal in Odoo ` +
        `(Accounting → Configuration → Journals), or point the ` +
        `"${ODOO_INVOICE_JOURNAL_SETTING}" field in Settings at the journal's real ` +
        `name.` +
        (configured
          ? ""
          : ` ("${DEFAULT_INVOICE_JOURNAL_NAME}" is only the default — nothing has ` +
            `been configured yet.)`),
    );
  }
  if (usable.length > 1) {
    throw new PermanentJobError(
      `More than one bank or cash journal in Odoo is named "${name}"; the journal ` +
        `the payment is recorded in must be unambiguous. Rename one of them, or ` +
        `point "${ODOO_INVOICE_JOURNAL_SETTING}" at the intended journal's name.`,
    );
  }
  return usable[0];
}

async function resolveInvoiceMailTemplate(): Promise<OdooMailTemplateRef> {
  const templates = await findMailTemplateByName(B2B_INVOICE_MAIL_TEMPLATE_NAME);
  if (templates.length === 0) {
    throw new PermanentJobError(
      `No Odoo mail template named "${B2B_INVOICE_MAIL_TEMPLATE_NAME}" exists, so ` +
        `the invoice email cannot be sent. It ships with the ` +
        `prema_moonvella_documents module — upgrade that module, then retry.`,
    );
  }
  if (templates.length > 1) {
    throw new PermanentJobError(
      `More than one Odoo mail template is named "${B2B_INVOICE_MAIL_TEMPLATE_NAME}"; ` +
        `the one to send must be unambiguous.`,
    );
  }

  const template = templates[0];
  const model = Array.isArray(template.model_id) ? template.model_id[1] : "";
  if (model !== "account.move") {
    throw new PermanentJobError(
      `Mail template "${B2B_INVOICE_MAIL_TEMPLATE_NAME}" is attached to model ` +
        `"${model || "none"}" instead of account.move, so it cannot render this ` +
        `invoice. Fix the template in Odoo, then retry.`,
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
