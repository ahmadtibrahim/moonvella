/**
 * Customer invoicing: issuing a document, allocating money to it, and working
 * out what is still owed.
 *
 * THREE RULES, AND EVERY FUNCTION HERE EXISTS TO KEEP ONE OF THEM.
 *
 *   1. AN ISSUED INVOICE IS IMMUTABLE. It has a number, a due date, a snapshot
 *      of who it went to and lines that COPY the order rather than pointing at
 *      it. Nothing in this module edits an issued invoice. Corrections are a
 *      credit note or a new document; a document somebody has been sent may not
 *      change underneath them, and a change made silently is indistinguishable
 *      from a mistake.
 *
 *   2. MONEY IS ALLOCATED, NOT ACCUMULATED. "How much has been paid" is the sum
 *      of `PaymentAllocation` rows, not a comparison between a payment's order
 *      and an invoice's order — a comparison that cannot express a partial
 *      payment, a credit, or one payment covering two invoices.
 *
 *   3. NOTHING IS WRITTEN TWICE. Allocation is expressed as "this payment has
 *      this much applied to this invoice" and converges: setting the same
 *      amount twice changes nothing, which is what makes a replayed Stripe
 *      webhook safe. The unique key on the allocation row is the guard; a
 *      check-then-write in code loses that race.
 *
 * MONEY IS MINOR UNITS AND INTEGERS. Nothing here divides, nothing rounds
 * implicitly, and every row carries its currency. A percentage discount is
 * computed with an explicit rounding step so two runs of the same arithmetic
 * give the same answer.
 */

import { Prisma, type Invoice, type InvoiceLine } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

type Tx = Prisma.TransactionClient;
type Db = typeof prisma | Tx;

export interface MoneyActor {
  id: string;
  name?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A percentage of an amount, in minor units, rounded half away from zero.
 *
 * `Math.round` on a negative number rounds toward positive infinity, so a
 * discount and a surcharge of the same size would round differently — the kind
 * of asymmetry that shows up as a one-cent disagreement between two documents
 * that should mirror each other.
 */
export function percentOf(amount: number, percent: number): number {
  const raw = (amount * percent) / 100;
  return raw < 0 ? -Math.round(-raw) : Math.round(raw);
}

/** The next number in a sequence, allocated once. See the note on NumberSequence. */
export async function nextNumber(tx: Tx, key: string, prefix: string, stamp: Date): Promise<string> {
  const row = await tx.numberSequence.upsert({
    where: { key },
    create: { key, nextValue: 1 },
    update: {},
    select: { id: true },
  });
  const bumped = await tx.numberSequence.update({
    where: { id: row.id },
    data: { nextValue: { increment: 1 } },
    select: { nextValue: true },
  });
  const allocated = bumped.nextValue - 1;
  const year = stamp.getUTCFullYear();
  return `${prefix}-${year}-${String(allocated).padStart(6, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* Reading an invoice                                                         */
/* -------------------------------------------------------------------------- */

export interface InvoicePosition {
  /** Allocated from payments. */
  paid: number;
  /** Credit notes issued against this invoice and not voided. */
  credited: number;
  /** total − paid − credited. Never negative: an overpayment is a credit. */
  balance: number;
  /** Derived, so it cannot disagree with the arithmetic that produced it. */
  status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "VOID";
  /** Past its due date with something still owed. */
  overdue: boolean;
}

/**
 * Everything a reader needs about one invoice's money, computed in one place.
 *
 * DERIVED, NOT STORED, and derived THE SAME WAY EVERYWHERE. The invoice's
 * `status` column is a convenience for querying a list; this is what a page
 * shows and what a statement adds up. If the two were computed separately they
 * would eventually disagree, and the page would be the one that was wrong.
 */
export function invoicePosition(
  invoice: Pick<Invoice, "status" | "total" | "dueDate">,
  allocations: { amount: number }[],
  credits: { amount: number; status: string }[]
): InvoicePosition {
  const paid = allocations.reduce((sum, row) => sum + row.amount, 0);
  const credited = credits
    .filter((row) => row.status !== "VOID")
    .reduce((sum, row) => sum + row.amount, 0);
  const balance = invoice.total - paid - credited;

  let status: InvoicePosition["status"];
  if (invoice.status === "DRAFT") status = "DRAFT";
  else if (invoice.status === "VOID") status = "VOID";
  else if (balance <= 0) status = "PAID";
  else if (paid + credited > 0) status = "PARTIALLY_PAID";
  else status = "ISSUED";

  // OVERDUE IS DERIVED, not a status of its own: it is a fact about the due date
  // and the balance, and storing it would need a job to keep it true. An invoice
  // with no due date is never overdue — the question was never answered, and
  // "past a deadline nobody set" is not a thing.
  const overdue =
    status !== "PAID" &&
    status !== "VOID" &&
    status !== "DRAFT" &&
    invoice.dueDate !== null &&
    invoice.dueDate.getTime() < Date.now() &&
    balance > 0;

  return { paid, credited, balance, status, overdue };
}

/** Load one invoice with everything the position needs. */
export async function loadInvoicePosition(db: Db, invoiceId: string) {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { allocations: { select: { amount: true } }, credits: { select: { amount: true, status: true } } },
  });
  if (!invoice) return null;
  return { invoice, position: invoicePosition(invoice, invoice.allocations, invoice.credits) };
}

/* -------------------------------------------------------------------------- */
/* Issuing                                                                    */
/* -------------------------------------------------------------------------- */

/** The billing identity, as it read when the invoice was issued. */
export interface BillTo {
  company: string;
  contactName: string | null;
  contactEmail: string | null;
  phone: string | null;
  addressLines: string[];
  country: string | null;
}

/**
 * The billing identity of a seller, for the snapshot.
 *
 * IT READS WHAT EXISTS AND INVENTS NOTHING. A seller with no address on file
 * gets an empty address list rather than a placeholder, because a placeholder on
 * a document is a false statement about where a company is.
 */
export async function billToFor(db: Db, sellerId: string): Promise<BillTo> {
  const seller = await db.seller.findUniqueOrThrow({
    where: { id: sellerId },
    select: {
      storeName: true,
      contactName: true,
      contactEmail: true,
      phone: true,
      country: true,
      applicationId: true,
    },
  });

  /*
   * The structured address comes from the APPLICATION, which is where the
   * operator typed it and where it was checked against Google. `sellerAddress`
   * on the same row is a single free-text line and is used only when the
   * structured columns are empty — preferring it would put an unparsed string on
   * a document that has a proper address available.
   */
  const app = seller.applicationId
    ? await db.merchantApplication.findUnique({
        where: { id: seller.applicationId },
        select: {
          legalBusinessName: true,
          addressLine1: true,
          addressLine2: true,
          addressCity: true,
          addressProvinceCode: true,
          addressPostalCode: true,
          addressCountryCode: true,
          sellerAddress: true,
        },
      })
    : null;

  const structured = app
    ? [app.addressLine1, app.addressLine2, app.addressCity, app.addressProvinceCode, app.addressPostalCode]
        .map((part) => (part ?? "").trim())
        .filter(Boolean)
    : [];
  const addressLines = structured.length > 0 ? structured : (app?.sellerAddress ?? "").trim() ? [app!.sellerAddress!.trim()] : [];

  return {
    company: app?.legalBusinessName?.trim() || seller.storeName,
    contactName: seller.contactName ?? null,
    contactEmail: seller.contactEmail ?? null,
    phone: seller.phone ?? null,
    addressLines,
    country: (app?.addressCountryCode ?? seller.country ?? null) || null,
  };
}

export interface IssueResult {
  invoice: Invoice;
  lines: InvoiceLine[];
  /** True when an invoice for this order already existed and was returned as-is. */
  existing: boolean;
}

/**
 * Issue the invoice for an order — once.
 *
 * IDEMPOTENT ON THE ORDER, which is the whole of the replay story: `Invoice.orderId`
 * is UNIQUE, the lookup happens first, and a second call returns the document that
 * already exists rather than issuing another. Two concurrent calls are separated by
 * the unique index, not by the lookup — the loser of the race gets a constraint
 * violation and re-reads.
 *
 * THE LINES ARE COPIED FROM THE ORDER, at the moment of issue. Later re-pricing of
 * the catalogue, or a change to the order, cannot reach back into a document that
 * has been sent. `OrderItem.wholesalePrice` is itself already a snapshot — this
 * takes a copy of that copy, because the order line is still a live row.
 *
 * TAX IS CARRIED, NOT DECIDED. `Order.moonvellaTax` is what was actually charged;
 * this copies it. Nothing here applies a rate, and nothing hard-codes a zero-tax
 * rule — presentation is conditional on the transaction, and the transaction is
 * whatever the order says.
 */
export async function issueInvoiceForOrder(
  orderId: string,
  actor: MoneyActor,
  opts: { dueDate?: Date | null; termsDays?: number | null } = {}
): Promise<IssueResult> {
  const existing = await prisma.invoice.findUnique({
    where: { orderId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (existing) return { invoice: existing, lines: existing.lines, existing: true };

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      seller: { select: { id: true, currency: true } },
    },
  });

  const billTo = await billToFor(prisma, order.sellerId);
  const now = new Date();

  /*
   * The due date is a TERM. Explicit wins; a number of days is applied to today;
   * neither leaves it null, which means "no agreed term" rather than "due now".
   * An invoice with no term is never overdue — see `invoicePosition`.
   */
  const dueDate =
    opts.dueDate ?? (opts.termsDays != null ? new Date(now.getTime() + opts.termsDays * 86_400_000) : null);

  const lines = order.items.map((item, index) => {
    const amount = item.wholesalePrice * item.quantity;
    return {
      // `OrderItem.name` is the ORIGINAL product name, snapshotted at intake and
      // kept there deliberately. Reading the live catalogue instead would put a
      // renamed product on an old invoice.
      description: item.name || item.sku,
      sku: item.sku,
      quantity: item.quantity,
      unitAmount: item.wholesalePrice,
      amount,
      sourceType: "OrderItem",
      sourceId: item.id,
      sortOrder: index,
    };
  });

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const shipTo = order.shippingAddress
    ? (JSON.parse(order.shippingAddress) as Record<string, unknown>)
    : null;

  try {
    return await prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, "invoice", "MV", now);
      const invoice = await tx.invoice.create({
        data: {
          number,
          orderId,
          sellerId: order.sellerId,
          status: "ISSUED",
          currency: order.currency || order.seller.currency || "CAD",
          issuedAt: now,
          dueDate,
          subtotal,
          // The order's own discount and shipping are already inside the line
          // prices this application charges, so they are not added again. An
          // explicit adjustment is a deliberate act and arrives through a credit.
          adjustments: 0,
          taxTotal: order.moonvellaTax,
          total: subtotal + order.moonvellaTax,
          billTo: billTo as unknown as Prisma.InputJsonValue,
          shipTo: (shipTo ?? undefined) as Prisma.InputJsonValue | undefined,
          createdById: actor.id,
          lines: { create: lines },
        },
        include: { lines: { orderBy: { sortOrder: "asc" } } },
      });

      await recordAudit(
        {
          actorType: "ADMIN_USER",
          actorId: actor.id,
          actorName: actor.name ?? null,
          action: "invoice.issued",
          entityType: AUDIT_ENTITY.ORDER,
          entityId: orderId,
          afterData: {
            invoiceNumber: invoice.number,
            total: invoice.total,
            currency: invoice.currency,
            lines: lines.length,
            dueDate: dueDate?.toISOString() ?? null,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        },
        tx as never
      );

      return { invoice, lines: invoice.lines, existing: false };
    });
  } catch (error) {
    // The unique index on `orderId` is the real guard. A concurrent issue loses
    // here and adopts the winner's document rather than reporting a failure.
    if (isUniqueViolation(error)) {
      const concurrent = await prisma.invoice.findUniqueOrThrow({
        where: { orderId },
        include: { lines: { orderBy: { sortOrder: "asc" } } },
      });
      return { invoice: concurrent, lines: concurrent.lines, existing: true };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Void an invoice, with a reason.
 *
 * THE ROW IS KEPT and its number is never reissued. A voided invoice is a fact
 * about the account — somebody was sent it and it was withdrawn — and deleting
 * it would erase that fact while leaving the number unaccounted for.
 */
export async function voidInvoice(invoiceId: string, reason: string, actor: MoneyActor) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { allocations: { select: { amount: true } } },
  });
  if (invoice.status === "VOID") return invoice;
  if (invoice.allocations.length > 0) {
    throw new Error(
      `${invoice.number} has money applied to it, so it cannot be voided. Reverse the allocation ` +
        `or issue a credit note instead — a voided invoice with payments against it cannot be ` +
        `reconciled.`
    );
  }

  const voided = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "VOID", voidedAt: new Date(), voidReason: reason },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "invoice.voided",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: voided.orderId,
    beforeData: { status: invoice.status },
    afterData: { status: "VOID", reason, invoiceNumber: voided.number },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return voided;
}

/* -------------------------------------------------------------------------- */
/* Allocation                                                                 */
/* -------------------------------------------------------------------------- */

export interface AllocationPlan {
  ok: boolean;
  amount: number;
  reason: string | null;
}

/**
 * What an allocation of `requested` would be allowed to be.
 *
 * PURE, so the boundary cases can be stated as inputs rather than arranged as
 * fixtures: a payment that is already fully applied, an invoice already settled,
 * a credit that has absorbed part of the balance, and an over-allocation that
 * must be refused rather than clamped to something the caller did not ask for.
 *
 * `requested` is capped by the SMALLER of what the payment has left and what the
 * invoice still owes. A caller asking for more than either is refused with the
 * number it could have had, because silently applying less than was asked for
 * and reporting success is how a reconciliation ends up wrong by a few dollars
 * nobody can locate.
 */
export function planAllocation(input: {
  requested: number;
  paymentAmount: number;
  alreadyAppliedFromPayment: number;
  invoiceTotal: number;
  invoicePaid: number;
  invoiceCredited: number;
}): AllocationPlan {
  const paymentLeft = input.paymentAmount - input.alreadyAppliedFromPayment;
  const invoiceLeft = input.invoiceTotal - input.invoicePaid - input.invoiceCredited;

  if (input.requested < 0) return { ok: false, amount: 0, reason: "An allocation cannot be negative." };
  if (input.requested === 0) return { ok: true, amount: 0, reason: null };
  if (paymentLeft <= 0) {
    return { ok: false, amount: 0, reason: "This payment is already fully applied to invoices." };
  }
  if (invoiceLeft <= 0) {
    return { ok: false, amount: 0, reason: "This invoice is already settled." };
  }
  const limit = Math.min(paymentLeft, invoiceLeft);
  if (input.requested > limit) {
    return {
      ok: false,
      amount: limit,
      reason:
        `At most ${limit} minor units can be applied here: the payment has ${paymentLeft} left and ` +
        `the invoice has ${invoiceLeft} outstanding.`,
    };
  }
  return { ok: true, amount: input.requested, reason: null };
}

/** The key that makes one payment's application to one invoice a single fact. */
export function allocationKey(paymentId: string, invoiceId: string): string {
  return `alloc:${paymentId}:${invoiceId}`;
}

/**
 * Set how much of a payment is applied to an invoice.
 *
 * CONVERGENT, NOT ADDITIVE. Calling this twice with the same amount writes once
 * and reports the same result; that is what makes it safe to run from a webhook
 * that is delivered at least once. An increase is an explicit new amount, not a
 * second increment — so a replay cannot inflate the allocation by arriving
 * twice, which an "increment by" API could not prevent.
 *
 * It refuses to exceed either the payment or the invoice, and it refuses to
 * allocate against anything that is not ISSUED or PARTIALLY_PAID — applying
 * money to a draft or a voided document is a mistake that would then be
 * invisible.
 */
export async function setAllocation(
  input: {
    paymentId: string;
    invoiceId: string;
    amount: number;
    note?: string | null;
  },
  actor: MoneyActor
) {
  const [payment, invoice] = await Promise.all([
    prisma.wholesalePayment.findUniqueOrThrow({
      where: { id: input.paymentId },
      include: { allocations: { select: { amount: true } } },
    }),
    prisma.invoice.findUniqueOrThrow({
      where: { id: input.invoiceId },
      include: {
        allocations: { select: { amount: true, paymentId: true } },
        credits: { select: { amount: true, status: true } },
      },
    }),
  ]);

  if (invoice.status !== "ISSUED" && invoice.status !== "PARTIALLY_PAID") {
    throw new Error(
      `Money cannot be applied to ${invoice.number}: it is ${invoice.status.toLowerCase()}. Only an ` +
        `issued invoice can be paid.`
    );
  }
  if (payment.currency !== invoice.currency) {
    throw new Error(
      `This payment is in ${payment.currency} and the invoice is in ${invoice.currency}, and ` +
        `MoonVella does not convert between currencies.`
    );
  }

  // What this payment has applied ELSEWHERE, so the cap is about the payment as
  // a whole rather than about this one invoice.
  const appliedElsewhere = payment.allocations.reduce((sum, row) => sum + row.amount, 0);
  const appliedHere = invoice.allocations
    .filter((row) => row.paymentId === input.paymentId)
    .reduce((sum, row) => sum + row.amount, 0);

  const plan = planAllocation({
    requested: input.amount,
    paymentAmount: payment.amount,
    alreadyAppliedFromPayment: appliedElsewhere - appliedHere,
    invoiceTotal: invoice.total,
    invoicePaid: invoice.allocations
      .filter((row) => row.paymentId !== input.paymentId)
      .reduce((sum, row) => sum + row.amount, 0),
    invoiceCredited: invoice.credits
      .filter((row) => row.status !== "VOID")
      .reduce((sum, row) => sum + row.amount, 0),
  });
  if (!plan.ok) throw new Error(plan.reason ?? "That allocation is not allowed.");

  const key = allocationKey(input.paymentId, input.invoiceId);

  return prisma.$transaction(async (tx) => {
    if (plan.amount === 0) {
      await tx.paymentAllocation.deleteMany({ where: { idempotencyKey: key } });
    } else {
      await tx.paymentAllocation.upsert({
        where: { idempotencyKey: key },
        create: {
          paymentId: input.paymentId,
          invoiceId: input.invoiceId,
          amount: plan.amount,
          currency: invoice.currency,
          idempotencyKey: key,
          allocatedById: actor.id,
          note: input.note ?? null,
        },
        update: { amount: plan.amount, allocatedById: actor.id, note: input.note ?? null },
      });
    }

    // The invoice's own status column is a convenience for the list query; the
    // arithmetic above is what pages read. Both are updated here so they cannot
    // drift apart by a step.
    const after = await tx.invoice.findUniqueOrThrow({
      where: { id: input.invoiceId },
      include: { allocations: { select: { amount: true } }, credits: { select: { amount: true, status: true } } },
    });
    const position = invoicePosition(after, after.allocations, after.credits);
    const updated = await tx.invoice.update({
      where: { id: input.invoiceId },
      data: { status: position.status === "DRAFT" || position.status === "VOID" ? after.status : position.status },
    });

    await recordAudit(
      {
        actorType: "ADMIN_USER",
        actorId: actor.id,
        actorName: actor.name ?? null,
        action: "invoice.payment_allocated",
        entityType: AUDIT_ENTITY.ORDER,
        entityId: after.orderId,
        beforeData: { allocatedHere: appliedHere },
        afterData: {
          allocatedHere: plan.amount,
          invoiceNumber: after.number,
          paid: position.paid,
          balance: position.balance,
          status: position.status,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
      tx as never
    );

    return { invoice: updated, position };
  });
}

/**
 * Apply as much of a payment as the invoice can take.
 *
 * The convenience the charge path uses: a Stripe payment that succeeded for an
 * order settles that order's invoice in full, and the amount is not restated by
 * the caller because the caller does not know it — the invoice does.
 */
export async function allocatePaymentToInvoice(paymentId: string, invoiceId: string, actor: MoneyActor) {
  const [payment, invoice] = await Promise.all([
    prisma.wholesalePayment.findUniqueOrThrow({
      where: { id: paymentId },
      // `invoiceId` is selected because this function computes a TOTAL for one
      // pair, not an increment — see below.
      include: { allocations: { select: { invoiceId: true, amount: true } } },
    }),
    prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { allocations: { select: { amount: true } }, credits: { select: { amount: true, status: true } } },
    }),
  ]);

  const position = invoicePosition(invoice, invoice.allocations, invoice.credits);

  /*
   * A TOTAL FOR THIS PAIR, NOT AN INCREMENT.
   *
   * `setAllocation` is convergent — it says "this payment has this much applied
   * to this invoice" — so handing it the free remainder REPLACES any existing
   * allocation rather than adding to it. The first version of this function did
   * exactly that: after a partial 4000 had been applied by hand, "apply the
   * rest" set the allocation to 6000 instead of 10000, and the invoice was left
   * 4000 short with a paid figure that looked entirely plausible. The suite
   * caught it on the check that asserts the invoice settles EXACTLY.
   */
  const alreadyHere = payment.allocations
    .filter((row) => row.invoiceId === invoiceId)
    .reduce((sum, row) => sum + row.amount, 0);
  const freeOnPayment = payment.amount - payment.allocations.reduce((sum, row) => sum + row.amount, 0);
  const amount = alreadyHere + Math.max(0, Math.min(freeOnPayment, position.balance));

  return setAllocation({ paymentId, invoiceId, amount, note: "Applied from the successful charge." }, actor);
}

/* -------------------------------------------------------------------------- */
/* Credits                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Issue a credit note against an invoice.
 *
 * A CREDIT IS NOT A REFUND. This reduces what is owed; it moves no money. When
 * both happen they are recorded separately and linked, which is why
 * `stripeRefundId` exists here and why a refund does not create a credit on its
 * own — the business decision to give money back and the bookkeeping entry that
 * reduces the balance are two decisions, and only one of them requires a card.
 */
export async function issueCreditNote(
  input: {
    invoiceId: string;
    amount: number;
    reason: string;
    stripeRefundId?: string | null;
    refundId?: string | null;
  },
  actor: MoneyActor
) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("A credit note must be a positive whole number of minor units.");
  }
  if (!input.reason.trim()) {
    throw new Error("A credit note needs a reason — it is a decision somebody may have to explain.");
  }

  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: input.invoiceId },
    include: { allocations: { select: { amount: true } }, credits: { select: { amount: true, status: true } } },
  });
  if (invoice.status === "VOID") throw new Error(`${invoice.number} is void, so it cannot be credited.`);

  const position = invoicePosition(invoice, invoice.allocations, invoice.credits);
  if (input.amount > position.balance) {
    throw new Error(
      `A credit of ${input.amount} would take ${invoice.number} below zero; ${position.balance} is ` +
        `outstanding. Credit at most that, or leave the remainder as an account credit.`
    );
  }

  const now = new Date();
  const credit = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, "credit", "CN", now);
    const created = await tx.creditNote.create({
      data: {
        number,
        invoiceId: invoice.id,
        sellerId: invoice.sellerId,
        currency: invoice.currency,
        amount: input.amount,
        reason: input.reason,
        status: "APPLIED",
        appliedAt: now,
        issuedById: actor.id,
        stripeRefundId: input.stripeRefundId ?? null,
        refundId: input.refundId ?? null,
      },
    });

    const after = await tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: { allocations: { select: { amount: true } }, credits: { select: { amount: true, status: true } } },
    });
    const next = invoicePosition(after, after.allocations, after.credits);
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: next.status === "DRAFT" || next.status === "VOID" ? after.status : next.status },
    });

    await recordAudit(
      {
        actorType: "ADMIN_USER",
        actorId: actor.id,
        actorName: actor.name ?? null,
        action: "invoice.credited",
        entityType: AUDIT_ENTITY.ORDER,
        entityId: invoice.orderId,
        afterData: {
          creditNumber: created.number,
          amount: input.amount,
          reason: input.reason,
          invoiceNumber: invoice.number,
          balance: next.balance,
          stripeRefundId: input.stripeRefundId ?? null,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
      tx as never
    );

    return { credit: created, invoice: updated, position: next };
  });

  return credit;
}

/** Every credit note against one invoice. */
export async function creditsForInvoice(invoiceId: string) {
  return prisma.creditNote.findMany({ where: { invoiceId }, orderBy: { issuedAt: "asc" } });
}
