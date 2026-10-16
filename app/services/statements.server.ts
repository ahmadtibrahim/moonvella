/**
 * Customer statements: what one company owes, over a period, and how old it is.
 *
 * GENERATED FROM THE SAME LEDGER AS THE INVOICES. Not from a summary table and
 * not from the order totals — from the invoices, the allocations and the credit
 * notes, which are the rows a reader can click through to. A statement that is
 * assembled from a different source than the documents it lists is a statement
 * that will eventually disagree with them, and the disagreement surfaces during
 * a collections call.
 *
 * THE RUNNING BALANCE IS THE POINT. A statement is not a list of invoices; it is
 * a story about a balance, and the balance after each line is what makes it
 * readable. Which means the lines must be ordered by date AND the opening
 * balance must include everything before the period — otherwise the first
 * running balance is wrong and every one after it inherits the error.
 *
 * THE ARITHMETIC IS A PURE FUNCTION, deliberately. Aging buckets and a running
 * balance are the parts that go quietly wrong — an invoice falling in the wrong
 * bucket, a credit counted twice — and as a pure function they can be checked
 * with stated inputs instead of by arranging a year of trading.
 */

import { prisma } from "~/db.server";
import { invoicePosition } from "./invoicing.server";

export type StatementLineKind = "INVOICE" | "PAYMENT" | "CREDIT";

export interface StatementLine {
  date: Date;
  kind: StatementLineKind;
  /** The document number a reader would quote: MV-2026-000004, CN-2026-000002. */
  reference: string;
  description: string;
  /** What the line adds to the balance. Invoices only. */
  debit: number;
  /** What it takes off. Payments and credit notes. */
  credit: number;
  /** The balance after this line. */
  balance: number;
  /** Where to go to see the underlying record. */
  href: string | null;
}

export interface AgingBuckets {
  /** Not yet due. */
  current: number;
  /** 1–30 days past due. */
  d1to30: number;
  d31to60: number;
  d61to90: number;
  over90: number;
  total: number;
}

export interface Statement {
  sellerId: string;
  company: string;
  currency: string;
  from: Date | null;
  to: Date;
  /** Everything owed before `from`, so the first running balance is true. */
  openingBalance: number;
  lines: StatementLine[];
  closingBalance: number;
  aging: AgingBuckets;
  /** Totals for the period, so a reader does not have to add the column up. */
  periodInvoiced: number;
  periodPaid: number;
  periodCredited: number;
}

export interface StatementSourceLine {
  date: Date;
  kind: StatementLineKind;
  reference: string;
  description: string;
  amount: number;
  href: string | null;
}

/**
 * Assemble a statement from its lines.
 *
 * ORDERING IS BY DATE, THEN BY KIND, THEN BY REFERENCE. The second and third
 * keys matter on a day when an invoice and its payment both land: without them
 * the order is whatever the database returned, and the same statement generated
 * twice could show the payment before the invoice it pays and a different
 * running balance each time.
 */
export function buildStatement(input: {
  sellerId: string;
  company: string;
  currency: string;
  from: Date | null;
  to: Date;
  lines: StatementSourceLine[];
  /** Open invoices with what is outstanding, for aging. Not for the running balance. */
  openInvoices: { number: string; dueDate: Date | null; outstanding: number }[];
}): Statement {
  const KIND_ORDER: Record<StatementLineKind, number> = { INVOICE: 0, CREDIT: 1, PAYMENT: 2 };

  const sorted = [...input.lines].sort((a, b) => {
    const byDate = a.date.getTime() - b.date.getTime();
    if (byDate !== 0) return byDate;
    const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return a.reference.localeCompare(b.reference);
  });

  const before = input.from ? sorted.filter((line) => line.date < input.from!) : [];
  const inPeriod = input.from ? sorted.filter((line) => line.date >= input.from!) : sorted;

  const signed = (line: StatementSourceLine) => (line.kind === "INVOICE" ? line.amount : -line.amount);
  const openingBalance = before.reduce((sum, line) => sum + signed(line), 0);

  let running = openingBalance;
  const lines: StatementLine[] = inPeriod.map((line) => {
    running += signed(line);
    return {
      date: line.date,
      kind: line.kind,
      reference: line.reference,
      description: line.description,
      debit: line.kind === "INVOICE" ? line.amount : 0,
      credit: line.kind === "INVOICE" ? 0 : line.amount,
      balance: running,
      href: line.href,
    };
  });

  return {
    sellerId: input.sellerId,
    company: input.company,
    currency: input.currency,
    from: input.from,
    to: input.to,
    openingBalance,
    lines,
    closingBalance: running,
    aging: agingBuckets(input.openInvoices, input.to),
    periodInvoiced: inPeriod.filter((l) => l.kind === "INVOICE").reduce((s, l) => s + l.amount, 0),
    periodPaid: inPeriod.filter((l) => l.kind === "PAYMENT").reduce((s, l) => s + l.amount, 0),
    periodCredited: inPeriod.filter((l) => l.kind === "CREDIT").reduce((s, l) => s + l.amount, 0),
  };
}

/**
 * How old the outstanding money is, as of a date.
 *
 * AGED FROM THE DUE DATE, not from the invoice date. Money is late when it is
 * past the term that was agreed, and an invoice issued on a 60-day term is not
 * "60 days old" in any sense a collections call cares about. An invoice with NO
 * due date falls in `current`: no term was agreed, so no term has been missed,
 * which is a different statement from "not yet due" and is reported the same way
 * because both mean the same thing to the person chasing it.
 */
export function agingBuckets(
  invoices: { number: string; dueDate: Date | null; outstanding: number }[],
  asOf: Date
): AgingBuckets {
  const buckets: AgingBuckets = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, over90: 0, total: 0 };

  for (const invoice of invoices) {
    if (invoice.outstanding <= 0) continue;
    buckets.total += invoice.outstanding;
    if (!invoice.dueDate) {
      buckets.current += invoice.outstanding;
      continue;
    }
    const daysPastDue = Math.floor((asOf.getTime() - invoice.dueDate.getTime()) / 86_400_000);
    if (daysPastDue <= 0) buckets.current += invoice.outstanding;
    else if (daysPastDue <= 30) buckets.d1to30 += invoice.outstanding;
    else if (daysPastDue <= 60) buckets.d31to60 += invoice.outstanding;
    else if (daysPastDue <= 90) buckets.d61to90 += invoice.outstanding;
    else buckets.over90 += invoice.outstanding;
  }

  return buckets;
}

/**
 * One company's statement.
 *
 * THE BALANCE IS DERIVED, NEVER READ FROM A COLUMN. `Invoice.total` is the
 * document's own figure; what is outstanding is that figure minus what has been
 * allocated to it and minus its credit notes. Computing it here means a
 * statement cannot drift from the invoices it lists, and a payment applied
 * between two runs shows up in both without anything having to be recomputed.
 */
export async function statementFor(
  sellerId: string,
  opts: { from?: Date | null; to?: Date } = {}
): Promise<Statement> {
  const to = opts.to ?? new Date();
  const from = opts.from ?? null;

  const seller = await prisma.seller.findUniqueOrThrow({
    where: { id: sellerId },
    select: { id: true, storeName: true, currency: true },
  });

  const invoices = await prisma.invoice.findMany({
    where: { sellerId, status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } },
    include: {
      allocations: { select: { amount: true, allocatedAt: true, paymentId: true } },
      credits: { select: { amount: true, status: true, issuedAt: true, number: true, reason: true } },
    },
    orderBy: { issuedAt: "asc" },
  });

  const lines: StatementSourceLine[] = [];
  const openInvoices: { number: string; dueDate: Date | null; outstanding: number }[] = [];

  for (const invoice of invoices) {
    const position = invoicePosition(invoice, invoice.allocations, invoice.credits);
    lines.push({
      date: invoice.issuedAt ?? invoice.createdAt,
      kind: "INVOICE",
      reference: invoice.number,
      description: `Order ${invoice.orderId.slice(0, 8)}`,
      amount: invoice.total,
      href: `/admin/invoices/${invoice.id}`,
    });

    for (const allocation of invoice.allocations) {
      lines.push({
        date: allocation.allocatedAt,
        kind: "PAYMENT",
        reference: invoice.number,
        description: "Payment received",
        amount: allocation.amount,
        href: `/admin/invoices/${invoice.id}`,
      });
    }

    for (const credit of invoice.credits) {
      if (credit.status === "VOID") continue;
      lines.push({
        date: credit.issuedAt,
        kind: "CREDIT",
        reference: credit.number,
        description: credit.reason,
        amount: credit.amount,
        href: `/admin/invoices/${invoice.id}`,
      });
    }

    // Aggregated for aging only, at the statement date rather than at the
    // invoice's own last change: the question is "how old is what is owed now".
    if (position.balance > 0) {
      openInvoices.push({
        number: invoice.number,
        dueDate: invoice.dueDate,
        outstanding: position.balance,
      });
    }
  }

  return buildStatement({
    sellerId: seller.id,
    company: seller.storeName,
    currency: seller.currency,
    from,
    to,
    lines,
    openInvoices,
  });
}

/** Every company with something on its account, for the customer list. */
export async function customerSummaries() {
  const sellers = await prisma.seller.findMany({
    where: { invoices: { some: {} } },
    select: {
      id: true,
      storeName: true,
      shopDomainFull: true,
      currency: true,
      status: true,
      invoices: {
        where: { status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } },
        select: {
          id: true,
          number: true,
          total: true,
          dueDate: true,
          issuedAt: true,
          status: true,
          allocations: { select: { amount: true } },
          credits: { select: { amount: true, status: true } },
        },
      },
    },
    orderBy: { storeName: "asc" },
  });

  return sellers.map((seller) => {
    let outstanding = 0;
    let oldestDue: Date | null = null;
    for (const invoice of seller.invoices) {
      const position = invoicePosition(invoice, invoice.allocations, invoice.credits);
      if (position.balance <= 0) continue;
      outstanding += position.balance;
      if (invoice.dueDate && (!oldestDue || invoice.dueDate < oldestDue)) oldestDue = invoice.dueDate;
    }
    return {
      id: seller.id,
      company: seller.storeName,
      shopDomain: seller.shopDomainFull,
      currency: seller.currency,
      status: seller.status,
      invoiceCount: seller.invoices.length,
      outstanding,
      oldestDue,
      overdue: oldestDue !== null && oldestDue.getTime() < Date.now() && outstanding > 0,
    };
  });
}
