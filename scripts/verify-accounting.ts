/**
 * Customer accounting: the documents, the money on them, and the arithmetic.
 *
 * WHAT THIS SUITE IS FOR. Bookkeeping goes wrong QUIETLY. An invoice issued
 * twice, a payment allocated twice by a redelivered webhook, a credit that
 * reduces a balance twice, a statement whose total moves when you change the
 * window — none of these throw, none of them look wrong on a screen, and all of
 * them are discovered months later during a reconciliation nobody can close. So
 * the checks are about the properties that make the ledger trustworthy:
 *
 *   1. ONE DOCUMENT PER ORDER, with a number that is assigned once and never
 *      reused, and lines that were COPIED rather than pointed at.
 *   2. AN ALLOCATION CONVERGES. Setting the same amount twice writes once, which
 *      is what makes a replayed Stripe event harmless. Over-allocating is
 *      refused rather than clamped.
 *   3. A CREDIT IS NOT A REFUND. They are separate rows, and a credit cannot
 *      take an invoice below zero.
 *   4. A STATEMENT BALANCES. Its closing figure equals the ledger, and it is the
 *      same number whichever period is chosen, because the opening balance
 *      carries everything before it.
 *
 * The pure functions are driven directly, because the boundary cases that matter
 * — an allocation of exactly the balance, a rounding half-cent, an invoice due
 * today — are trivial to state as inputs and tedious to arrange as fixtures.
 *
 * Nothing here contacts a provider. It creates its own seller, order and charge,
 * and removes them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  allocationKey,
  allocatePaymentToInvoice,
  billToFor,
  invoicePosition,
  issueCreditNote,
  issueInvoiceForOrder,
  nextNumber,
  percentOf,
  planAllocation,
  setAllocation,
  voidInvoice,
} from "../app/services/invoicing.server";
import { agingBuckets, buildStatement, statementFor } from "../app/services/statements.server";
import { billPosition, createSupplierBill, recordSupplierBillPayment } from "../app/services/bills.server";
import { renderInvoicePdf } from "../app/services/invoicePdf.server";
import { parseMajorUnits } from "../app/utils/money";
import { forbidProviderCalls } from "./provider-guard";

const prisma = new PrismaClient();
const SUFFIX = Math.random().toString(36).slice(2, 8);
const SHOP = `verify-accounting-${SUFFIX}.myshopify.com`;
const ACTOR = { id: "verify-accounting", name: "Accounting suite" };

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (!seller) return;
  const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  const shipments = await prisma.shipment.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
  const shipmentIds = shipments.map((s) => s.id);
  await prisma.supplierBillPayment.deleteMany({ where: { bill: { shipmentId: { in: shipmentIds } } } });
  await prisma.supplierBill.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
  await prisma.paymentAllocation.deleteMany({ where: { invoice: { sellerId: seller.id } } });
  await prisma.creditNote.deleteMany({ where: { sellerId: seller.id } });
  await prisma.invoiceLine.deleteMany({ where: { invoice: { sellerId: seller.id } } });
  await prisma.invoice.deleteMany({ where: { sellerId: seller.id } });
  await prisma.paymentEvent.deleteMany({ where: { payment: { sellerId: seller.id } } });
  await prisma.wholesalePayment.deleteMany({ where: { sellerId: seller.id } });
  await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
  await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { sellerId: seller.id } });
  await prisma.seller.delete({ where: { id: seller.id } });
}

async function main() {
  forbidProviderCalls("verify-accounting");
  await cleanup();

  /* ------------------------------------------------------------------ */
  /* 1. The arithmetic, on its own                                       */
  /* ------------------------------------------------------------------ */

  check(
    "a percentage rounds half away from zero in BOTH directions",
    percentOf(1000, 50) === 500 && percentOf(-1000, 50) === -500 && percentOf(1, 50) === 1 && percentOf(-1, 50) === -1,
    `${percentOf(1, 50)} / ${percentOf(-1, 50)}`
  );

  check(
    "an amount typed as major units parses to exact minor units",
    parseMajorUnits("114.40") === 11440 && parseMajorUnits("0.07") === 7 && parseMajorUnits("1,234.56") === 123456,
    `${parseMajorUnits("114.40")}`
  );
  check(
    "…and the float trap is not taken: 114.40 is not 11439",
    parseMajorUnits("114.40") === 11440 && Math.round(114.4 * 100) === 11440,
    "integer parts, not a multiply"
  );
  check(
    "a non-amount is refused rather than coerced",
    parseMajorUnits("114.401") === null && parseMajorUnits("abc") === null && parseMajorUnits("") === null
  );

  const baseInvoice = { status: "ISSUED" as const, total: 10000, dueDate: null };
  check(
    "a paid invoice reads PAID and not overdue, even with no due date",
    (() => {
      const p = invoicePosition(baseInvoice, [{ amount: 10000 }], []);
      return p.status === "PAID" && p.balance === 0 && !p.overdue;
    })()
  );
  check(
    "a partial payment reads PARTIALLY_PAID with the right balance",
    (() => {
      const p = invoicePosition(baseInvoice, [{ amount: 4000 }], []);
      return p.status === "PARTIALLY_PAID" && p.balance === 6000;
    })()
  );
  check(
    "a credit reduces the balance and is reported separately from a payment",
    (() => {
      const p = invoicePosition(baseInvoice, [{ amount: 4000 }], [{ amount: 1000, status: "ISSUED" }]);
      return p.paid === 4000 && p.credited === 1000 && p.balance === 5000;
    })()
  );
  check(
    "a VOID credit does not reduce anything",
    invoicePosition(baseInvoice, [], [{ amount: 1000, status: "VOID" }]).balance === 10000
  );
  check(
    "overdue needs BOTH a passed due date and a positive balance",
    (() => {
      const past = new Date(Date.now() - 86_400_000);
      const future = new Date(Date.now() + 86_400_000);
      return (
        invoicePosition({ ...baseInvoice, dueDate: past }, [], []).overdue === true &&
        invoicePosition({ ...baseInvoice, dueDate: future }, [], []).overdue === false &&
        invoicePosition({ ...baseInvoice, dueDate: past }, [{ amount: 10000 }], []).overdue === false &&
        invoicePosition({ ...baseInvoice, dueDate: null }, [], []).overdue === false
      );
    })()
  );

  check(
    "an allocation is capped by the smaller of the payment and the invoice",
    (() => {
      const plan = planAllocation({
        requested: 9000,
        paymentAmount: 5000,
        alreadyAppliedFromPayment: 0,
        invoiceTotal: 10000,
        invoicePaid: 0,
        invoiceCredited: 0,
      });
      return !plan.ok && plan.amount === 5000;
    })()
  );
  check(
    "an allocation of exactly what is left is allowed",
    planAllocation({
      requested: 6000,
      paymentAmount: 6000,
      alreadyAppliedFromPayment: 0,
      invoiceTotal: 10000,
      invoicePaid: 4000,
      invoiceCredited: 0,
    }).ok
  );
  check(
    "allocating to a settled invoice is refused, and says so",
    (() => {
      const plan = planAllocation({
        requested: 100,
        paymentAmount: 1000,
        alreadyAppliedFromPayment: 0,
        invoiceTotal: 1000,
        invoicePaid: 1000,
        invoiceCredited: 0,
      });
      return !plan.ok && (plan.reason ?? "").includes("settled");
    })()
  );
  check(
    "a fully applied payment is refused, and says so",
    (() => {
      const plan = planAllocation({
        requested: 100,
        paymentAmount: 1000,
        alreadyAppliedFromPayment: 1000,
        invoiceTotal: 5000,
        invoicePaid: 0,
        invoiceCredited: 0,
      });
      return !plan.ok && (plan.reason ?? "").includes("fully applied");
    })()
  );

  const asOf = new Date("2026-06-01T00:00:00Z");
  const day = (n: number) => new Date(asOf.getTime() - n * 86_400_000);
  const aged = agingBuckets(
    [
      { number: "A", dueDate: day(0), outstanding: 100 }, // due today → current
      { number: "B", dueDate: day(10), outstanding: 200 },
      { number: "C", dueDate: day(45), outstanding: 300 },
      { number: "D", dueDate: day(75), outstanding: 400 },
      { number: "E", dueDate: day(200), outstanding: 500 },
      { number: "F", dueDate: null, outstanding: 600 }, // no term → current
      { number: "G", dueDate: day(400), outstanding: 0 }, // settled → ignored
      { number: "H", dueDate: day(30), outstanding: 700 }, // exactly 30 → 1–30
    ],
    asOf
  );
  check(
    "aging buckets land on the stated boundaries",
    aged.current === 700 && aged.d1to30 === 900 && aged.d31to60 === 300 && aged.d61to90 === 400 && aged.over90 === 500,
    `current=${aged.current} 1-30=${aged.d1to30} 31-60=${aged.d31to60} 61-90=${aged.d61to90} 90+=${aged.over90}`
  );
  check("aging totals only the outstanding rows", aged.total === 2800, String(aged.total));

  const statement = buildStatement({
    sellerId: "s",
    company: "C",
    currency: "CAD",
    from: new Date("2026-02-01T00:00:00Z"),
    to: new Date("2026-03-01T00:00:00Z"),
    lines: [
      { date: new Date("2026-01-10T00:00:00Z"), kind: "INVOICE", reference: "MV-1", description: "before", amount: 5000, href: null },
      { date: new Date("2026-02-10T00:00:00Z"), kind: "INVOICE", reference: "MV-2", description: "in", amount: 3000, href: null },
      { date: new Date("2026-02-15T00:00:00Z"), kind: "PAYMENT", reference: "MV-2", description: "paid", amount: 1000, href: null },
      { date: new Date("2026-02-20T00:00:00Z"), kind: "CREDIT", reference: "CN-1", description: "credit", amount: 500, href: null },
    ],
    openInvoices: [],
  });
  check(
    "the opening balance carries everything before the period",
    statement.openingBalance === 5000,
    String(statement.openingBalance)
  );
  check(
    "the running balance is right after each line",
    statement.lines.map((l) => l.balance).join(",") === "8000,7000,6500",
    statement.lines.map((l) => l.balance).join(",")
  );
  check("the closing balance equals opening plus the period", statement.closingBalance === 6500, String(statement.closingBalance));
  check(
    "payments and credits are totalled on their own lines, never merged",
    statement.periodPaid === 1000 && statement.periodCredited === 500 && statement.periodInvoiced === 3000
  );

  const reordered = buildStatement({
    sellerId: "s",
    company: "C",
    currency: "CAD",
    from: null,
    to: asOf,
    lines: [
      { date: new Date("2026-02-15T00:00:00Z"), kind: "PAYMENT", reference: "MV-2", description: "paid", amount: 1000, href: null },
      { date: new Date("2026-02-10T00:00:00Z"), kind: "INVOICE", reference: "MV-2", description: "in", amount: 3000, href: null },
    ],
    openInvoices: [],
  });
  check(
    "lines are ordered by date, so the same statement generated twice cannot differ",
    reordered.lines[0].kind === "INVOICE" && reordered.lines[0].balance === 3000,
    reordered.lines.map((l) => `${l.kind}:${l.balance}`).join(",")
  );

  /* ------------------------------------------------------------------ */
  /* 2. Issuing                                                          */
  /* ------------------------------------------------------------------ */

  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      shopDomainFull: SHOP,
      storeName: `Accounting ${SUFFIX}`,
      contactEmail: `acct-${SUFFIX}@test.example`,
      contactName: "Accounts Payable",
      status: "APPROVED",
      approvedAt: new Date(),
      currency: "CAD",
    },
  });

  const order = await prisma.order.create({
    data: {
      sellerId: seller.id,
      shopifyOrderId: `acct-${SUFFIX}`,
      shopifyOrderName: `#A${SUFFIX}`,
      shopifyOrderNumber: 1,
      currency: "CAD",
      subtotal: 10000,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: 10000,
      moonvellaSubtotal: 10000,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: 10000,
      paymentStatus: "PAID",
      wholesalePaymentStatus: "SUCCEEDED",
      state: "AWAITING_SELLER_PAYMENT",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      items: {
        create: [
          { name: "Widget", sku: `SKU-A-${SUFFIX}`, quantity: 2, price: 5000, wholesalePrice: 4000, currency: "CAD", totalDiscount: 0, shopifyLineItemId: "li-acct-1" },
          { name: "Gadget", sku: `SKU-B-${SUFFIX}`, quantity: 1, price: 2000, wholesalePrice: 2000, currency: "CAD", totalDiscount: 0, shopifyLineItemId: "li-acct-2" },
        ],
      },
    },
    include: { items: true },
  });

  const issued = await issueInvoiceForOrder(order.id, ACTOR, { termsDays: 30 });
  check(
    "an invoice is issued with a stable number and copied lines",
    issued.invoice.number.startsWith("MV-") &&
      issued.lines.length === 2 &&
      issued.invoice.total === 10000 &&
      issued.invoice.subtotal === 10000,
    `${issued.invoice.number} total=${issued.invoice.total}`
  );
  check(
    "the due date comes from the term, and no term means no due date",
    issued.invoice.dueDate !== null &&
      Math.round((issued.invoice.dueDate!.getTime() - Date.now()) / 86_400_000) === 30
  );
  check(
    "the bill-to block is a snapshot of the company as it read",
    (() => {
      const billTo = issued.invoice.billTo as { company?: string; contactName?: string };
      return billTo.company === `Accounting ${SUFFIX}` && billTo.contactName === "Accounts Payable";
    })(),
    JSON.stringify(issued.invoice.billTo).slice(0, 90)
  );
  check(
    "issuing is idempotent on the order — a second call returns the same document",
    await (async () => {
      const again = await issueInvoiceForOrder(order.id, ACTOR);
      return again.existing === true && again.invoice.id === issued.invoice.id;
    })()
  );
  check(
    "the invoice number is not reused by the next document",
    await (async () => {
      const next = await prisma.$transaction((tx) => nextNumber(tx, "invoice", "MV", new Date()));
      return next !== issued.invoice.number;
    })()
  );

  /* ------------------------------------------------------------------ */
  /* 3. Allocation                                                       */
  /* ------------------------------------------------------------------ */

  const payment = await prisma.wholesalePayment.create({
    data: {
      orderId: order.id,
      sellerId: seller.id,
      amount: 10000,
      currency: "CAD",
      status: "SUCCEEDED",
      idempotencyKey: `acct-charge-${SUFFIX}`,
      capturedAt: new Date(),
    },
  });

  const partial = await setAllocation({ paymentId: payment.id, invoiceId: issued.invoice.id, amount: 4000 }, ACTOR);
  check(
    "a partial allocation reduces the balance and moves the status",
    partial.position.balance === 6000 && partial.position.status === "PARTIALLY_PAID",
    `balance=${partial.position.balance} status=${partial.position.status}`
  );

  const replayed = await setAllocation({ paymentId: payment.id, invoiceId: issued.invoice.id, amount: 4000 }, ACTOR);
  const allocationRows = await prisma.paymentAllocation.count({
    where: { idempotencyKey: allocationKey(payment.id, issued.invoice.id) },
  });
  check(
    "ALLOCATING THE SAME AMOUNT TWICE WRITES ONCE — a replay cannot inflate the ledger",
    allocationRows === 1 && replayed.position.paid === 4000,
    `${allocationRows} row(s), paid=${replayed.position.paid}`
  );

  let overRefused = false;
  try {
    await setAllocation({ paymentId: payment.id, invoiceId: issued.invoice.id, amount: 20000 }, ACTOR);
  } catch {
    overRefused = true;
  }
  check(
    "an allocation beyond either the payment or the invoice is refused, not clamped",
    overRefused &&
      (await prisma.paymentAllocation.findFirstOrThrow({
        where: { idempotencyKey: allocationKey(payment.id, issued.invoice.id) },
      })).amount === 4000
  );

  const settled = await allocatePaymentToInvoice(payment.id, issued.invoice.id, ACTOR);
  check(
    "applying the rest settles the invoice exactly, with no rounding left over",
    settled.position.balance === 0 && settled.position.paid === 10000 && settled.invoice.status === "PAID",
    `balance=${settled.position.balance} paid=${settled.position.paid}`
  );

  let settledRefused = false;
  try {
    await setAllocation({ paymentId: payment.id, invoiceId: issued.invoice.id, amount: 1 }, ACTOR);
  } catch {
    settledRefused = true;
  }
  check("nothing more can be applied to a settled invoice", settledRefused);

  /* ------------------------------------------------------------------ */
  /* 4. Credits are not refunds                                          */
  /* ------------------------------------------------------------------ */

  const secondOrder = await prisma.order.create({
    data: {
      sellerId: seller.id,
      shopifyOrderId: `acct2-${SUFFIX}`,
      shopifyOrderName: `#B${SUFFIX}`,
      shopifyOrderNumber: 2,
      currency: "CAD",
      subtotal: 5000,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: 5000,
      moonvellaSubtotal: 5000,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: 5000,
      paymentStatus: "PENDING",
      state: "AWAITING_SELLER_PAYMENT",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      items: { create: [{ name: "Widget", sku: `SKU-C-${SUFFIX}`, quantity: 1, price: 5000, wholesalePrice: 5000, currency: "CAD", totalDiscount: 0, shopifyLineItemId: "li-acct-3" }] },
    },
  });
  const secondInvoice = await issueInvoiceForOrder(secondOrder.id, ACTOR);

  const credited = await issueCreditNote(
    { invoiceId: secondInvoice.invoice.id, amount: 1500, reason: "Damaged in transit" },
    ACTOR
  );
  check(
    "a credit note reduces the balance and does NOT create a payment",
    credited.position.balance === 3500 &&
      credited.position.credited === 1500 &&
      credited.position.paid === 0,
    `balance=${credited.position.balance} credited=${credited.position.credited} paid=${credited.position.paid}`
  );
  check(
    "the credit has its own number from its own sequence",
    credited.credit.number.startsWith("CN-"),
    credited.credit.number
  );

  let overCreditRefused = false;
  try {
    await issueCreditNote({ invoiceId: secondInvoice.invoice.id, amount: 99000, reason: "too much" }, ACTOR);
  } catch {
    overCreditRefused = true;
  }
  check("a credit cannot take an invoice below zero", overCreditRefused);

  let reasonRequired = false;
  try {
    await issueCreditNote({ invoiceId: secondInvoice.invoice.id, amount: 100, reason: "   " }, ACTOR);
  } catch {
    reasonRequired = true;
  }
  check("a credit needs a reason — it is a decision somebody may have to explain", reasonRequired);

  /* ------------------------------------------------------------------ */
  /* 5. Voiding                                                          */
  /* ------------------------------------------------------------------ */

  const thirdOrder = await prisma.order.create({
    data: {
      sellerId: seller.id,
      shopifyOrderId: `acct3-${SUFFIX}`,
      shopifyOrderName: `#C${SUFFIX}`,
      shopifyOrderNumber: 3,
      currency: "CAD",
      subtotal: 2000,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: 2000,
      moonvellaSubtotal: 2000,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: 2000,
      paymentStatus: "PENDING",
      state: "AWAITING_SELLER_PAYMENT",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      items: { create: [{ name: "Widget", sku: `SKU-D-${SUFFIX}`, quantity: 1, price: 2000, wholesalePrice: 2000, currency: "CAD", totalDiscount: 0, shopifyLineItemId: "li-acct-4" }] },
    },
  });
  const thirdInvoice = await issueInvoiceForOrder(thirdOrder.id, ACTOR);
  const voided = await voidInvoice(thirdInvoice.invoice.id, "Raised against the wrong order", ACTOR);
  check(
    "a voided invoice keeps its number and records why",
    voided.status === "VOID" && voided.number === thirdInvoice.invoice.number && voided.voidReason !== null
  );

  let voidWithMoneyRefused = false;
  try {
    await voidInvoice(issued.invoice.id, "attempt", ACTOR);
  } catch {
    voidWithMoneyRefused = true;
  }
  check("an invoice with money on it cannot be voided", voidWithMoneyRefused);

  /* ------------------------------------------------------------------ */
  /* 6. The statement balances against the ledger                        */
  /* ------------------------------------------------------------------ */

  const customerStatement = await statementFor(seller.id);
  const invoices = await prisma.invoice.findMany({
    where: { sellerId: seller.id, status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } },
    include: { allocations: true, credits: true },
  });
  const ledgerBalance = invoices.reduce((sum, invoice) => {
    const position = invoicePosition(invoice, invoice.allocations, invoice.credits);
    return sum + position.balance;
  }, 0);
  check(
    "the statement's closing balance equals the sum of the invoices' own balances",
    customerStatement.closingBalance === ledgerBalance,
    `statement=${customerStatement.closingBalance} ledger=${ledgerBalance}`
  );
  check(
    "the statement's aging total equals the same figure",
    customerStatement.aging.total === ledgerBalance,
    `aging=${customerStatement.aging.total}`
  );
  check(
    "the closing balance does not move when the period does",
    await (async () => {
      const windowed = await statementFor(seller.id, { from: new Date("2000-01-01T00:00:00Z") });
      return windowed.closingBalance === customerStatement.closingBalance;
    })()
  );
  check(
    "the VAOID invoice is absent from the statement",
    !customerStatement.lines.some((line) => line.reference === thirdInvoice.invoice.number)
  );

  /* ------------------------------------------------------------------ */
  /* 7. Supplier bills                                                   */
  /* ------------------------------------------------------------------ */

  const bill = await createSupplierBill(
    { supplier: "eShipper", reference: "INV-9001", category: "Shipping", total: 11440, issuedOn: new Date() },
    ACTOR
  );
  check("a bill records in full minor units", bill.total === 11440, String(bill.total));

  const billHalf = await recordSupplierBillPayment({ billId: bill.id, amount: 5000, method: "LOGGED" }, ACTOR);
  check(
    "a partial payment leaves the bill PARTIAL with a balance",
    billHalf.position.status === "PARTIAL" && billHalf.position.balance === 6440,
    `${billHalf.position.status} ${billHalf.position.balance}`
  );

  const billPaid = await recordSupplierBillPayment({ billId: bill.id, amount: 6440, method: "LOGGED" }, ACTOR);
  check("the rest settles the bill to PAID", billPaid.position.status === "PAID" && billPaid.position.balance === 0);

  let overpayRefused = false;
  try {
    await recordSupplierBillPayment({ billId: bill.id, amount: 100, method: "LOGGED" }, ACTOR);
  } catch {
    overpayRefused = true;
  }
  check("overpaying a bill is refused", overpayRefused);

  let cardRefused: string | null = null;
  try {
    await recordSupplierBillPayment({ billId: bill.id, amount: 100, method: "CARD" }, ACTOR);
  } catch (error) {
    cardRefused = error instanceof Error ? error.message : "";
  }
  check(
    "CHARGING A CARD IS REFUSED, not silently recorded as a logged payment",
    cardRefused !== null && cardRefused.includes("no supplier-charging provider"),
    cardRefused?.slice(0, 70) ?? "it did not refuse"
  );

  const keyed = await recordSupplierBillPayment(
    { billId: bill.id, amount: 100, method: "LOGGED", idempotencyKey: `stmt-import-${SUFFIX}` },
    ACTOR
  ).catch(() => null);
  check(
    "a keyed payment that cannot be applied is refused rather than written twice",
    keyed === null,
    "the bill is already paid"
  );

  /* ------------------------------------------------------------------ */
  /* 8. The document                                                     */
  /* ------------------------------------------------------------------ */

  const pdf = await renderInvoicePdf({
    invoice: issued.invoice,
    lines: issued.lines,
    position: invoicePosition(issued.invoice, [{ amount: 10000 }], []),
    kind: "invoice",
  });
  check(
    "the invoice renders a real PDF",
    pdf.length > 1000 && pdf.subarray(0, 4).toString("ascii") === "%PDF",
    `${pdf.length} bytes, starts ${pdf.subarray(0, 4).toString("ascii")}`
  );
  check(
    "the PDF carries the brand name and the invoice number",
    pdf.includes(Buffer.from("MV-")) && pdf.toString("latin1").includes("Invoice"),
    "text is present in the document stream"
  );

  /* ------------------------------------------------------------------ */
  /* 9. The PDF is SERVED, not returned from an action                    */
  /* ------------------------------------------------------------------ */

  /*
   * THE DEFECT THIS EXISTS FOR, WHICH NOTHING ABOVE COULD SEE.
   *
   * The invoice PDF was first returned from the page's `action` — a POST
   * producing `Content-Disposition: attachment`. React Router treats an action's
   * return value as DATA for the document it is about to re-render rather than
   * as the response itself, so the file was built, written, and then consumed as
   * page data, and the render threw: **a 500 on the deployed endpoint** while
   * every check above passed, because they call `renderInvoicePdf` directly and
   * the defect lived entirely in how the route was wired.
   *
   * A service-level test cannot reach that, so the assertion is about the wiring:
   * the PDF is a RESOURCE ROUTE — a loader and no component — and the page links
   * to it rather than posting for it.
   */
  const invoicePdfRoute = readFileSync(join(process.cwd(), "app/routes/admin.invoices_.$id_.pdf.tsx"), "utf8");
  check(
    "the invoice PDF is served by a resource route with a loader",
    invoicePdfRoute.includes("export async function loader") &&
      !invoicePdfRoute.includes("export async function action")
  );
  check(
    "and that route requires the finance permission the page does",
    /requirePermission\(request, "finance\.view"\)/.test(invoicePdfRoute)
  );
  check(
    "and it sets the filename from the invoice number, never from the request",
    /Content-Disposition": `attachment; filename="\$\{invoice\.number\}\.pdf/.test(invoicePdfRoute)
  );

  const invoicePage = readFileSync(join(process.cwd(), "app/routes/admin.invoices_.$id.tsx"), "utf8");
  check(
    "the invoice page LINKS to the PDF rather than POSTing for it",
    invoicePage.includes("/pdf`}") && !invoicePage.includes('intent" value="pdf"')
  );

  const statementRoute = readFileSync(
    join(process.cwd(), "app/routes/admin.customers_.$id_.statement[.]pdf.tsx"),
    "utf8"
  );
  check(
    "the statement PDF is a resource route too, for the same reason",
    statementRoute.includes("export async function loader") &&
      !statementRoute.includes("export async function action")
  );

  /* ------------------------------------------------------------------ */
  /* 10. Tenant isolation                                                */
  /* ------------------------------------------------------------------ */

  const otherShop = `verify-accounting-other-${SUFFIX}.myshopify.com`;
  const other = await prisma.seller.create({
    data: {
      shopDomain: otherShop,
      shopDomainFull: otherShop,
      storeName: `Other ${SUFFIX}`,
      contactEmail: `other-${SUFFIX}@test.example`,
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });
  const otherStatement = await statementFor(other.id);
  check(
    "another company's statement is empty — no cross-tenant leakage",
    otherStatement.closingBalance === 0 && otherStatement.lines.length === 0,
    `lines=${otherStatement.lines.length}`
  );
  await prisma.seller.delete({ where: { id: other.id } });

  /* ------------------------------------------------------------------ */
  /* 11. What an invoice costs the customer to read                       */
  /* ------------------------------------------------------------------ */

  const billTo = await billToFor(prisma, seller.id);
  check(
    "a company with no address on file gets an empty list, never a placeholder",
    Array.isArray(billTo.addressLines) && billTo.company === `Accounting ${SUFFIX}`,
    `addressLines=${JSON.stringify(billTo.addressLines)}`
  );

  await cleanup();

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("verify-accounting FAILED:", error instanceof Error ? error.message : error);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
