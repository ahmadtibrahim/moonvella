/**
 * Supplier bills and expenses — the other side of the ledger.
 *
 * WHAT THIS IS FOR. MoonVella owes carriers, packaging suppliers and software
 * vendors. Those bills exist whether or not anything records them, and the thing
 * that goes wrong without a record is not the payment — it is the QUOTED cost
 * versus the BOOKED cost versus what was actually BILLED. A parcel quoted at
 * 6.93 and billed at 11.40 is a margin problem that surfaces at year end unless
 * somebody can see the three figures side by side.
 *
 * THAT IS WHY A BILL CAN NAME A SHIPMENT. `SupplierBill.shipmentId` is what
 * makes that comparison a query. A bill with no shipment is an expense that is
 * not attributable to a parcel, which is a normal thing for software.
 *
 * LOGGING A PAYMENT IS NOT CHARGING ONE. The distinction the work order asks for
 * lives in `SupplierBillPaymentMethod`:
 *
 *   LOGGED — the money already moved by another route and this records the fact.
 *            A bank transfer, a cheque, a card the operator holds themselves.
 *   CARD   — charge it now, through the provider.
 *
 * Without the distinction, one "Record payment" button either charges a card for
 * a bill that was already paid by transfer, or fails to charge one that has not
 * been paid at all. Both are worse than an extra choice on a form.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

export interface BillActor {
  id: string;
  name?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface BillPosition {
  paid: number;
  balance: number;
  status: "OPEN" | "PARTIAL" | "PAID" | "VOID";
  overdue: boolean;
  /** Days until due (positive) or since due (negative). Null with no due date. */
  daysToDue: number | null;
}

/**
 * What a bill still owes, derived rather than stored.
 *
 * Same rule as an invoice: `status` on the row is a convenience for the list
 * query and this is what a page shows, and they are computed from one place so
 * they cannot disagree.
 */
export function billPosition(
  bill: { status: string; total: number; dueDate: Date | null },
  payments: { amount: number }[],
  now: Date = new Date()
): BillPosition {
  const paid = payments.reduce((sum, row) => sum + row.amount, 0);
  const balance = bill.total - paid;

  let status: BillPosition["status"];
  if (bill.status === "VOID") status = "VOID";
  else if (balance <= 0) status = "PAID";
  else if (paid > 0) status = "PARTIAL";
  else status = "OPEN";

  const daysToDue = bill.dueDate
    ? Math.ceil((bill.dueDate.getTime() - now.getTime()) / 86_400_000)
    : null;

  return {
    paid,
    balance,
    status,
    overdue: status !== "PAID" && status !== "VOID" && balance > 0 && daysToDue !== null && daysToDue < 0,
    daysToDue,
  };
}

export const BILL_CATEGORIES = ["Shipping", "Packaging", "Software", "Utilities", "Other"] as const;

export interface CreateBillInput {
  supplier: string;
  reference?: string | null;
  category: string;
  currency?: string;
  total: number;
  issuedOn: Date;
  dueDate?: Date | null;
  notes?: string | null;
  shipmentId?: string | null;
  documentKey?: string | null;
  documentName?: string | null;
}

/**
 * Record a bill.
 *
 * NO UNIQUENESS ON (supplier, reference): a supplier legitimately reuses its own
 * numbering across years, and refusing the second one would leave a real
 * liability unrecorded. Duplicate detection is a person's job and the list shows
 * enough to do it.
 */
export async function createSupplierBill(input: CreateBillInput, actor: BillActor) {
  if (!Number.isInteger(input.total) || input.total <= 0) {
    throw new Error("A bill's total must be a positive whole number of minor units.");
  }
  if (!input.supplier.trim()) throw new Error("A bill needs a supplier.");
  if (!input.category.trim()) throw new Error("A bill needs a category.");

  const bill = await prisma.supplierBill.create({
    data: {
      supplier: input.supplier.trim(),
      reference: input.reference?.trim() || null,
      category: input.category.trim(),
      currency: input.currency || "CAD",
      total: input.total,
      issuedOn: input.issuedOn,
      dueDate: input.dueDate ?? null,
      notes: input.notes?.trim() || null,
      shipmentId: input.shipmentId ?? null,
      documentKey: input.documentKey ?? null,
      documentName: input.documentName ?? null,
      createdById: actor.id,
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "bill.created",
    entityType: AUDIT_ENTITY.PAYMENT,
    entityId: bill.id,
    afterData: {
      supplier: bill.supplier,
      reference: bill.reference,
      category: bill.category,
      total: bill.total,
      currency: bill.currency,
      shipmentId: bill.shipmentId,
    },
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });

  return bill;
}

/**
 * Record a payment against a bill.
 *
 * `method` decides whether money moves. LOGGED writes a row and nothing else;
 * CARD goes through the provider first and only records the payment if the
 * charge succeeded — a row saying "paid" for a charge that was declined is worse
 * than no row, because it closes the only signal that the bill is still open.
 *
 * The card path is deliberately NOT implemented here yet, and it REFUSES rather
 * than pretending: there is no supplier-charging integration configured, and a
 * function that writes a LOGGED row while claiming to charge a card would be the
 * exact confusion this field exists to prevent.
 */
export async function recordSupplierBillPayment(
  input: {
    billId: string;
    amount: number;
    method: "LOGGED" | "CARD";
    reference?: string | null;
    paidAt?: Date;
    note?: string | null;
    idempotencyKey?: string | null;
  },
  actor: BillActor
) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("A payment must be a positive whole number of minor units.");
  }

  const bill = await prisma.supplierBill.findUniqueOrThrow({
    where: { id: input.billId },
    include: { payments: { select: { amount: true } } },
  });
  if (bill.status === "VOID") throw new Error("This bill is void, so it cannot be paid.");

  if (input.method === "CARD") {
    throw new Error(
      "Charging a card is not available: no supplier-charging provider is configured. Record " +
        "the payment as LOGGED once the money has left by whatever route it left, or configure a " +
        "provider first — recording a card charge that never happened is worse than recording " +
        "nothing."
    );
  }

  const position = billPosition(bill, bill.payments);
  if (input.amount > position.balance) {
    throw new Error(
      `This payment is more than the bill still owes: ${position.balance} outstanding, ${input.amount} ` +
        `offered. Pay the outstanding amount, or record the extra against a different bill.`
    );
  }

  // Idempotent when the caller supplies a key. A bank reference is the natural
  // one: importing the same statement twice must not double-pay a bill.
  const key = input.idempotencyKey ?? null;
  if (key) {
    const existing = await prisma.supplierBillPayment.findUnique({ where: { idempotencyKey: key } });
    if (existing) {
      return { payment: existing, position: billPosition(bill, bill.payments), duplicate: true };
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.supplierBillPayment.create({
      data: {
        billId: bill.id,
        amount: input.amount,
        currency: bill.currency,
        method: input.method,
        reference: input.reference?.trim() || null,
        paidAt: input.paidAt ?? new Date(),
        recordedById: actor.id,
        note: input.note?.trim() || null,
        idempotencyKey: key,
      },
    });

    const all = await tx.supplierBillPayment.findMany({
      where: { billId: bill.id },
      select: { amount: true },
    });
    const next = billPosition(bill, all);
    const updated = await tx.supplierBill.update({
      where: { id: bill.id },
      data: { status: next.status === "VOID" ? "VOID" : next.status },
    });

    await recordAudit(
      {
        actorType: "ADMIN_USER",
        actorId: actor.id,
        actorName: actor.name ?? null,
        action: "bill.payment_recorded",
        entityType: AUDIT_ENTITY.PAYMENT,
        entityId: bill.id,
        afterData: {
          amount: input.amount,
          method: input.method,
          reference: payment.reference,
          balance: next.balance,
          status: next.status,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
      tx as never
    );

    return { payment, position: next, bill: updated, duplicate: false };
  });

  return result;
}

/**
 * The carrier reconciliation: what was quoted, what was booked, and what the
 * carrier actually invoiced, for one shipment.
 *
 * READ-ONLY AND INFORMATIONAL. It does not adjust the seller's charge, and it
 * must not: the seller was quoted a price and that price is theirs. A variance
 * is MoonVella's cost problem, and the moment this function wrote back to a
 * seller's charge every re-import of a carrier invoice would re-price a
 * customer's order.
 */
export async function shipmentBillingReconciliation(shipmentId: string) {
  const shipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: shipmentId },
    select: {
      id: true,
      carrier: true,
      serviceName: true,
      quotedCarrierCost: true,
      bookedCost: true,
      finalBilledCost: true,
      billingStatus: true,
      // Carrier costs are recorded in the ORDER's currency — a shipment has no
      // currency of its own, because a parcel is not a monetary document.
      order: { select: { currency: true } },
      sellerShippingCharge: true,
      supplierBills: {
        select: { id: true, supplier: true, reference: true, total: true, status: true, issuedOn: true },
      },
    },
  });

  const billed = shipment.supplierBills.reduce(
    (sum: number, bill: { total: number }) => sum + bill.total,
    0
  );
  const expected = shipment.bookedCost ?? shipment.quotedCarrierCost ?? null;

  return {
    shipment,
    billed,
    expected,
    /** booked or quoted, minus what the carrier actually invoiced. */
    variance: expected === null ? null : expected - billed,
    hasBills: shipment.supplierBills.length > 0,
  };
}
