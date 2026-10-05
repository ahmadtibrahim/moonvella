/**
 * The automatic Odoo invoice at carrier handoff.
 *
 * This suite runs the REAL pipeline (`createOdooInvoiceForOrder`) against a
 * stubbed Odoo and asserts both outcomes and the exact RPC payloads — the
 * quotation-template id, the product ids behind the ordered SKUs, the journal
 * the payment is registered in, and the mail arguments. The stub's invoice
 * total is computed from the lines the pipeline sent, so the pipeline's own
 * money gate (invoice total vs the captured Stripe amount) is load-bearing
 * here rather than bypassed.
 *
 * What it proves, in the work order's terms:
 *
 *   • the invoice is created from the existing "MoonVella B2B Wholesale"
 *     template, and a template missing its MoonVella brand/channel stamps
 *     fails loudly instead of producing the wrong document;
 *   • lines are Odoo PRODUCTS resolved from the ordered SKUs — never a
 *     free-text line — and a SKU with no product is a named failure;
 *   • a retry never creates a second sale order, a second invoice, or a second
 *     payment, in the linked case AND in the crash-recovered case;
 *   • the payment is a ledger entry in the configured journal — the suite
 *     installs the provider guard, so a Stripe call anywhere in this run would
 *     throw rather than be stubbed;
 *   • the email is queued through the branded template, remembered on the
 *     order, and resumed (only it) when an earlier attempt reached the invoice
 *     but not the send;
 *   • the guard ladder holds: readonly refuses the first write with no write
 *     reaching Odoo at all, `Prod-db` is refused before a single byte is sent,
 *     and an unconfigured connector never calls out.
 *
 * It touches the ISOLATED verify database only, and it snapshots and restores
 * the `odoo` credential rows it configures.
 *
 * Run: through deployment/mv-verify.sh (or npm run verify -- odoo-invoice).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createOdooInvoiceForOrder } from "../app/services/odooInvoice.server";
import {
  OdooDatabaseBlockedError,
  OdooNotConfiguredError,
  OdooWriteBlockedError,
} from "../app/services/odoo.server";
import { PermanentJobError } from "../app/services/jobs.server";
import { forbidProviderCalls, providerGuardActive } from "./provider-guard";
import { installOdooJsonRpcStub, isOdooWrite, type OdooStubCall } from "./odoo-jsonrpc-stub";

const prisma = new PrismaClient();
const SHOP = "odoo-invoice-verify.myshopify.com";
const BILLING_EMAIL = "billing@odoo-invoice-verify.example";
const LEGAL_NAME = "Verify Wholesale Customer Ltd.";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const JOB_ACTOR = {
  actorType: "SYSTEM" as const,
  actorId: "job:verify",
  actorName: "Background job (Odoo invoice sync)",
};

const LINE_PILLOW = { sku: "MV-VERIFY-PILLOW", name: "Verify Pillow", quantity: 3, unitPriceMinor: 1299 };
const LINE_DUVET = { sku: "MV-VERIFY-DUVET", name: "Verify Duvet", quantity: 1, unitPriceMinor: 10550 };
const TOTAL_MINOR =
  LINE_PILLOW.quantity * LINE_PILLOW.unitPriceMinor +
  LINE_DUVET.quantity * LINE_DUVET.unitPriceMinor; // 14447
const TOTAL_MAJOR = TOTAL_MINOR / 100; // 144.47
/** The captured date the payment ledger entry must carry. */
const CAPTURED_AT = new Date("2026-10-03T14:30:00Z");
const CAPTURED_DATE = "2026-10-03";

const ODOO_ENV_KEYS = [
  "ODOO_URL",
  "ODOO_DATABASE",
  "ODOO_USERNAME",
  "ODOO_API_KEY",
  "ODOO_MODE",
  "ODOO_ALLOW_PROD_DB",
  "ODOO_ALLOW_WRITES",
  "ODOO_TIMEOUT_MS",
] as const;

function clearOdooEnv() {
  for (const key of ODOO_ENV_KEYS) delete process.env[key];
}

/** Strip comments so a static check inspects code, not the prose about it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function readStripped(relPath: string): string {
  return stripComments(readFileSync(resolve(relPath), "utf8"));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function payloadOf(call: OdooStubCall): Record<string, unknown> {
  return (call.args[0] ?? {}) as Record<string, unknown>;
}

/** `[field, operator, value]` clauses of a recorded search domain. */
function domainOf(call: OdooStubCall): unknown[][] {
  const domain = call.args[0];
  return Array.isArray(domain) ? (domain as unknown[][]) : [];
}

function searchedValue(call: OdooStubCall, field: string): unknown {
  return domainOf(call).find((clause) => clause[0] === field)?.[2];
}

let seq = 0;

async function makeOrder(
  sellerId: string,
  options: {
    lines?: { sku: string; name: string; quantity: number; unitPriceMinor: number }[];
    paymentStatus?: "SUCCEEDED" | "REQUIRES_PAYMENT" | "REFUNDED";
    snapshot?: boolean;
  } = {},
) {
  seq += 1;
  const lines = options.lines ?? [LINE_PILLOW, LINE_DUVET];
  const amount = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
  const withSnapshot = options.snapshot ?? true;

  return prisma.order.create({
    data: {
      sellerId,
      shopifyOrderId: `oi-${seq}`,
      shopifyOrderName: `#OI${seq}`,
      shopifyOrderNumber: seq,
      currency: "CAD",
      customerName: "Retail Customer",
      shippingAddress: JSON.stringify({
        name: "Retail Customer",
        address1: "1 Verify St",
        city: "Toronto",
        province: "ON",
        zip: "M5V 2T6",
        country: "CA",
      }),
      subtotal: amount,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: amount,
      moonvellaSubtotal: amount,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: amount,
      paymentStatus: "PAID",
      fulfillmentStatus: "PENDING",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      supplierReference: `${SHOP}#${seq}`,
      items: {
        create: lines.map((line, index) => ({
          name: line.name,
          sku: line.sku,
          quantity: line.quantity,
          price: line.unitPriceMinor * 2,
          wholesalePrice: line.unitPriceMinor,
          totalDiscount: 0,
          shopifyLineItemId: `oi-li-${seq}-${index}`,
        })),
      },
      wholesalePayment: {
        create: {
          sellerId,
          amount,
          currency: "CAD",
          provider: "stripe",
          status: options.paymentStatus ?? "SUCCEEDED",
          idempotencyKey: `odoo-invoice-verify:${seq}`,
          capturedAt: CAPTURED_AT,
          ...(withSnapshot
            ? {
                priceSnapshot: {
                  currency: "CAD",
                  subtotalMinor: amount,
                  totalMinor: amount,
                  treatment: {
                    tax: "NOT_ADDED_TO_WHOLESALE",
                    shipping: "INCLUDED_IN_SELLER_PRICE",
                  },
                  lines: lines.map((line) => ({
                    sku: line.sku,
                    name: line.name,
                    quantity: line.quantity,
                    unitPriceMinor: line.unitPriceMinor,
                    lineTotalMinor: line.quantity * line.unitPriceMinor,
                  })),
                },
              }
            : {}),
        },
      },
    },
  });
}

const linkSelect = {
  odooInvoiceId: true,
  odooInvoiceName: true,
  odooSaleOrderId: true,
  odooInvoiceSyncedAt: true,
  odooInvoiceEmailSentAt: true,
  odooInvoiceError: true,
} as const;

async function readLink(orderId: string) {
  return prisma.order.findUnique({ where: { id: orderId }, select: linkSelect });
}

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (seller) {
    const orders = await prisma.order.findMany({
      where: { sellerId: seller.id },
      select: { id: true },
    });
    const ids = orders.map((order) => order.id);
    await prisma.wholesalePayment.deleteMany({ where: { sellerId: seller.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.order.deleteMany({ where: { sellerId: seller.id } });
    await prisma.externalContactMapping.deleteMany({ where: { sellerId: seller.id } });
    await prisma.seller.delete({ where: { id: seller.id } });
  }
  const application = await prisma.merchantApplication.findUnique({
    where: { shopDomain: SHOP },
  });
  if (application) {
    await prisma.merchantApplication.delete({ where: { id: application.id } });
  }
}

async function main() {
  // This suite must not reach a provider. It also must not be ABLE to: the
  // guard wraps the real fetch first, and every Odoo stub below delegates
  // non-Odoo URLs back through it, so a Stripe call anywhere in the pipeline
  // throws with the URL attached instead of being stubbed into a false pass.
  forbidProviderCalls("verify-odoo-invoice");

  const { saveCredentials, disconnectCredentials } = await import(
    "../app/services/credentials.server"
  );

  /** Point the connector at the stub, through the credential store (Settings). */
  async function configureOdoo(overrides: Record<string, string> = {}) {
    clearOdooEnv();
    process.env.ODOO_ALLOW_WRITES = "yes";
    await saveCredentials("odoo", {
      ODOO_URL: "https://odoo.invalid",
      ODOO_DATABASE: "moonvella_verify",
      ODOO_USERNAME: "svc_moonvella",
      ODOO_API_KEY: "verify-key-not-real",
      ODOO_MODE: "live",
      ...overrides,
    });
  }

  const savedState = await prisma.integrationState.findMany({ where: { key: "odoo" } });
  const savedCreds = await prisma.integrationCredential.findMany({ where: { key: "odoo" } });
  const savedWritesFlag = process.env.ODOO_ALLOW_WRITES;

  const clearOdooStore = async () => {
    await prisma.integrationCredential.deleteMany({ where: { key: "odoo" } });
    await prisma.integrationState.deleteMany({ where: { key: "odoo" } });
  };

  try {
    await cleanup();

    const application = await prisma.merchantApplication.create({
      data: {
        shopDomain: SHOP,
        storeName: "Odoo Invoice Verify",
        legalBusinessName: LEGAL_NAME,
        storeContactEmail: BILLING_EMAIL,
        status: "APPROVED",
      },
    });
    const seller = await prisma.seller.create({
      data: {
        shopDomain: SHOP,
        shopDomainFull: SHOP,
        storeName: "Odoo Invoice Verify",
        contactEmail: "owner@odoo-invoice-verify.example",
        status: "APPROVED",
        approvedAt: new Date(),
        applicationId: application.id,
      },
    });
    // A FAILED COMPANY mapping with no partner id: the state the repair path
    // exists for, and the state that puts a financial hold on the seller. The
    // hold must be RECORDED and must not strand the invoice.
    await prisma.externalContactMapping.create({
      data: {
        sellerId: seller.id,
        role: "COMPANY",
        status: "FAILED",
        attempts: 2,
        lastError: "verify fixture: the customer record was never created",
        lastAttemptAt: new Date(),
        storeName: "Odoo Invoice Verify",
        myshopifyDomain: SHOP,
      },
    });

    /* ------------------------------------------------------------------ */
    /* 1. Happy path: the whole chain, every payload asserted.             */
    /* ------------------------------------------------------------------ */
    const stub = installOdooJsonRpcStub();
    await configureOdoo();
    const order1 = await makeOrder(seller.id);

    const outcome = await createOdooInvoiceForOrder(order1.id, JOB_ACTOR);

    check("happy path: the invoice was created", outcome.status === "CREATED", outcome.status);
    check(
      "happy path: the invoice is posted and paid in Odoo",
      outcome.invoice.state === "posted" && outcome.invoice.paymentState === "paid",
      `${outcome.invoice.state}/${String(outcome.invoice.paymentState)}`,
    );
    check(
      "happy path: the invoice totals the captured charge",
      Math.abs(outcome.invoice.amountTotal - TOTAL_MAJOR) < 0.005,
      `${outcome.invoice.amountTotal} vs ${TOTAL_MAJOR}`,
    );
    check(
      "happy path: the customer contact was created from the application's legal name",
      outcome.partner?.outcome === "CREATED" &&
        outcome.partner.id === 700 &&
        outcome.partner.name === LEGAL_NAME,
      JSON.stringify(outcome.partner),
    );
    check(
      "happy path: the payment ledger entry names the default journal and the captured date",
      outcome.payment?.journalId === 77 &&
        outcome.payment.journalName === "MoonVella Stripe" &&
        Math.abs(outcome.payment.amount - TOTAL_MAJOR) < 0.005 &&
        outcome.payment.paymentDate === CAPTURED_DATE,
      JSON.stringify(outcome.payment),
    );
    check(
      "happy path: the branded mail template was the one sent",
      outcome.email?.templateId === 88 && outcome.email.mailId === 990,
      JSON.stringify(outcome.email),
    );

    const link1 = await readLink(order1.id);
    check(
      "happy path: the order is linked to the Odoo invoice id and number",
      link1?.odooInvoiceId === 1001 &&
        link1.odooInvoiceName === "INV/2026/00001" &&
        link1.odooSaleOrderId === 900,
      JSON.stringify(link1),
    );
    check(
      "happy path: link timestamps recorded, no error left behind",
      link1?.odooInvoiceSyncedAt !== null &&
        link1?.odooInvoiceEmailSentAt !== null &&
        link1?.odooInvoiceError === null,
    );

    const saleOrderCreates = stub.callsTo("sale.order", "create");
    const salePayload = saleOrderCreates.length === 1 ? payloadOf(saleOrderCreates[0]) : {};
    check(
      "the sale order was created FROM the 'MoonVella B2B Wholesale' template",
      saleOrderCreates.length === 1 && salePayload.sale_order_template_id === 5,
      String(salePayload.sale_order_template_id),
    );
    check(
      "the sale order carries the order's supplier reference",
      salePayload.client_order_ref === order1.supplierReference,
      String(salePayload.client_order_ref),
    );

    const rawLines = Array.isArray(salePayload.order_line)
      ? (salePayload.order_line as unknown[][])
      : [];
    const lineValues = rawLines.map((entry) => (entry[2] ?? {}) as Record<string, unknown>);
    check(
      "the sale order lines are Odoo PRODUCTS — no free-text line is created",
      lineValues.length === 2 && lineValues.every((line) => !("name" in line)),
      JSON.stringify(lineValues),
    );
    check(
      "product ids are what Odoo returned for the ordered SKUs",
      lineValues[0]?.product_id === 300 && lineValues[1]?.product_id === 301,
      JSON.stringify(lineValues.map((line) => line.product_id)),
    );
    check(
      "quantities and prices come from the captured charge snapshot",
      lineValues[0]?.product_uom_qty === 3 &&
        lineValues[0]?.price_unit === 12.99 &&
        lineValues[1]?.product_uom_qty === 1 &&
        lineValues[1]?.price_unit === 105.5,
      JSON.stringify(lineValues),
    );

    const templateSearches = stub.callsTo("sale.order.template", "search_read");
    check(
      "the quotation template was searched for by its exact name",
      templateSearches.length === 1 &&
        searchedValue(templateSearches[0], "name") === "MoonVella B2B Wholesale",
      String(templateSearches.length ? searchedValue(templateSearches[0], "name") : "no search"),
    );

    const posts = stub.callsTo("account.move", "action_post");
    check(
      "the invoice was posted once, with the abnormal-invoice wizard suppressed",
      posts.length === 1 &&
        (posts[0].kwargs.context as Record<string, unknown> | undefined)
          ?.disable_abnormal_invoice_detection === true,
      JSON.stringify(posts[0]?.kwargs ?? {}),
    );

    const registerCreates = stub.callsTo("account.payment.register", "create");
    const registerPayload = registerCreates.length ? payloadOf(registerCreates[0]) : {};
    check(
      "the payment was registered in the journal, for the captured amount and date",
      registerCreates.length === 1 &&
        registerPayload.journal_id === 77 &&
        registerPayload.amount === TOTAL_MAJOR &&
        registerPayload.payment_date === CAPTURED_DATE,
      JSON.stringify(registerPayload),
    );
    check(
      "the payment wizard names the invoice through its context",
      (registerCreates[0]?.kwargs.context as { active_ids?: number[] } | undefined)
        ?.active_ids?.[0] === 1001,
    );

    const journalSearches = stub.callsTo("account.journal", "search_read");
    check(
      "the journal search used the default name, nothing was guessed",
      journalSearches.length === 1 &&
        searchedValue(journalSearches[0], "name") === "MoonVella Stripe",
      String(journalSearches.length ? searchedValue(journalSearches[0], "name") : "no search"),
    );

    const mailTemplateSearches = stub.callsTo("mail.template", "search_read");
    check(
      "the mail template was found by its exact MoonVella name",
      mailTemplateSearches.length === 1 &&
        searchedValue(mailTemplateSearches[0], "name") ===
          "MoonVella — B2B Wholesale Paid Invoice",
      String(
        mailTemplateSearches.length ? searchedValue(mailTemplateSearches[0], "name") : "no search",
      ),
    );

    const mailSends = stub.callsTo("mail.template", "send_mail");
    check(
      "one email was queued through the template, for the invoice",
      // The full record-method shape: the ids list first, the res_id second.
      mailSends.length === 1 && JSON.stringify(mailSends[0].args) === "[[88],1001]",
      JSON.stringify(mailSends[0]?.args ?? []),
    );
    check(
      "the email was queued (not sent inline), so invoice creation is decoupled from SMTP",
      mailSends[0]?.kwargs.force_send === false,
    );

    const partnerCreates = stub.callsTo("res.partner", "create");
    const partnerPayload = partnerCreates.length ? payloadOf(partnerCreates[0]) : {};
    check(
      "the contact is a company with customer_rank 1, built from the application",
      partnerCreates.length === 1 &&
        partnerPayload.name === LEGAL_NAME &&
        partnerPayload.email === BILLING_EMAIL &&
        partnerPayload.is_company === true &&
        partnerPayload.customer_rank === 1,
      JSON.stringify(partnerPayload),
    );
    check(
      "the contact carries the MoonVella contact tag, added rather than replacing others",
      JSON.stringify(partnerPayload.category_id) === "[[4,248]]",
      JSON.stringify(partnerPayload.category_id),
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: "order.odoo_invoice_created", entityId: order1.id },
      orderBy: { createdAt: "desc" },
    });
    const auditAfter =
      audit?.afterData && typeof audit.afterData === "string"
        ? (JSON.parse(audit.afterData) as Record<string, unknown>)
        : null;
    check("the invoice was audited against the order", audit !== null);
    check(
      "the financial hold was RECORDED on the audit and did not stop the invoice",
      typeof auditAfter?.financialHold === "string",
      JSON.stringify(auditAfter?.financialHold),
    );
    check(
      "the audit names the issuing company and the invoice currency",
      auditAfter?.companyId === 1 && auditAfter?.currency === "CAD",
      JSON.stringify({ companyId: auditAfter?.companyId, currency: auditAfter?.currency }),
    );

    const mapping = await prisma.externalContactMapping.findUnique({
      where: { sellerId_role: { sellerId: seller.id, role: "COMPANY" } },
    });
    check(
      "the missing COMPANY partner id was filled in best-effort",
      mapping?.odooPartnerId === 700 && mapping.odooName === LEGAL_NAME,
      JSON.stringify({ id: mapping?.odooPartnerId, name: mapping?.odooName }),
    );
    check(
      "the mapping's FAILED status was left exactly as it was",
      mapping?.status === "FAILED" && mapping.lastError === "verify fixture: the customer record was never created",
      String(mapping?.status),
    );

    check(
      "no provider was reachable during the run (the guard was in place)",
      providerGuardActive(),
    );

    /* ------------------------------------------------------------------ */
    /* 2. Idempotency: a second run writes nothing at all.                 */
    /* ------------------------------------------------------------------ */
    const writesBefore = stub.writes().length;
    const second = await createOdooInvoiceForOrder(order1.id, JOB_ACTOR);
    const link2 = await readLink(order1.id);
    check("a second run reports ALREADY_CREATED", second.status === "ALREADY_CREATED", second.status);
    check(
      "a second run performs no write of any kind",
      stub.writes().length === writesBefore,
      `${stub.writes().length} vs ${writesBefore}`,
    );
    check(
      "there is still exactly one sale order, one invoice and one email",
      stub.callsTo("sale.order", "create").length === 1 &&
        stub.callsTo("sale.advance.payment.inv", "create_invoices").length === 1 &&
        stub.callsTo("account.move", "action_post").length === 1 &&
        stub.callsTo("mail.template", "send_mail").length === 1,
    );
    check(
      "the email timestamp was not rewritten",
      link2?.odooInvoiceEmailSentAt?.getTime() === link1?.odooInvoiceEmailSentAt?.getTime(),
    );
    stub.restore();

    /* ------------------------------------------------------------------ */
    /* 3. A SKU with no Odoo product: named failure, no free-text line.    */
    /* ------------------------------------------------------------------ */
    const stub3 = installOdooJsonRpcStub({ products: { missing: [LINE_DUVET.sku] } });
    await configureOdoo();
    const order3 = await makeOrder(seller.id);
    const error3 = await catchError(() => createOdooInvoiceForOrder(order3.id, JOB_ACTOR));
    const error3Message = error3 instanceof Error ? error3.message : String(error3);
    check(
      "a SKU with no Odoo product is a PERMANENT failure naming the SKU",
      error3 instanceof PermanentJobError && error3Message.includes(LINE_DUVET.sku),
      describe(error3),
    );
    check(
      "the failure says why replacing it with a free-text line is not done",
      error3Message.includes("free-text"),
    );
    check(
      "no sale order is created when a SKU is missing",
      stub3.callsTo("sale.order", "create").length === 0,
    );
    check(
      "the order is not linked to any invoice by the failed run",
      (await readLink(order3.id))?.odooInvoiceId === null,
    );
    check(
      "the failure is written onto the order for the operator",
      ((await readLink(order3.id))?.odooInvoiceError ?? "").includes(LINE_DUVET.sku),
    );
    stub3.restore();

    /* ------------------------------------------------------------------ */
    /* 3b. A payment that is not SUCCEEDED: a PAID invoice is not created. */
    /* ------------------------------------------------------------------ */
    const stub3b = installOdooJsonRpcStub();
    const order3b = await makeOrder(seller.id, { paymentStatus: "REFUNDED" });
    const error3b = await catchError(() => createOdooInvoiceForOrder(order3b.id, JOB_ACTOR));
    check(
      "a refunded (not SUCCEEDED) wholesale payment creates no paid invoice",
      error3b instanceof PermanentJobError &&
        (error3b as Error).message.includes("REFUNDED"),
      describe(error3b),
    );
    check(
      "nothing at all was written for the un-charged order",
      stub3b.writes().length === 0,
      JSON.stringify(stub3b.writes().map((call) => `${call.model}.${call.method}`)),
    );
    stub3b.restore();

    /* ------------------------------------------------------------------ */
    /* 3c. The catalogue's taxes. The seller paid the snapshot price, so   */
    /*     a tax that would raise the invoice above it is refused BEFORE   */
    /*     any document exists — and the tax is never silently overridden. */
    /* ------------------------------------------------------------------ */
    const stub3c = installOdooJsonRpcStub({
      products: { taxes: [{ sku: LINE_PILLOW.sku, taxIds: [7] }] },
    });
    await configureOdoo();
    const order3c = await makeOrder(seller.id);
    const error3c = await catchError(() => createOdooInvoiceForOrder(order3c.id, JOB_ACTOR));
    const message3c = error3c instanceof Error ? error3c.message : String(error3c);
    check(
      "a sale tax that adds to the wholesale price is a PERMANENT failure naming the tax",
      error3c instanceof PermanentJobError &&
        message3c.includes(LINE_PILLOW.sku) &&
        message3c.includes("13% HST"),
      describe(error3c),
    );
    check(
      "the refusal shows what the tax would do and both ways to fix the catalogue",
      message3c.includes("38.97") &&
        message3c.includes("44.04") &&
        message3c.includes("no sale tax") &&
        message3c.includes("included in the price"),
      message3c,
    );
    check(
      "the taxed order is refused before ANY write: no sale order, no invoice",
      stub3c.writes().length === 0,
      JSON.stringify(stub3c.writes().map((call) => `${call.model}.${call.method}`)),
    );
    check(
      "Odoo answered the question itself — one compute_all read, and only for the taxed SKU",
      stub3c.callsTo("account.tax", "compute_all").length === 1 &&
        !isOdooWrite(stub3c.callsTo("account.tax", "compute_all")[0]),
      JSON.stringify({
        calls: stub3c.callsTo("account.tax", "compute_all").length,
        lines: 2,
      }),
    );
    check(
      "the refusal reached the order, not just the job",
      ((await readLink(order3c.id))?.odooInvoiceError ?? "").includes("13% HST"),
    );
    stub3c.restore();

    /* ------------------------------------------------------------------ */
    /* 3d. Taxes that do NOT raise the price are accepted: included in it, */
    /*     or zero-rated. A tax GROUP that adds is refused by its effect,  */
    /*     not by the group's own rate.                                    */
    /* ------------------------------------------------------------------ */
    const stub3d = installOdooJsonRpcStub({
      products: { taxes: [{ sku: LINE_PILLOW.sku, taxIds: [69] }] },
    });
    await configureOdoo();
    const order3d = await makeOrder(seller.id);
    const outcome3d = await createOdooInvoiceForOrder(order3d.id, JOB_ACTOR);
    check(
      "a tax configured as included in the price is accepted — the invoice bills the captured amount",
      outcome3d.status === "CREATED" && outcome3d.invoice?.amountTotal === TOTAL_MAJOR,
      JSON.stringify({ status: outcome3d.status, total: outcome3d.invoice?.amountTotal }),
    );
    const saleOrder3d = payloadOf(stub3d.callsTo("sale.order", "create")[0]);
    check(
      "the line carries no tax instruction at all — the catalogue's tax is Odoo's to apply, never the app's to set or clear",
      JSON.stringify(saleOrder3d).includes("order_line") &&
        !JSON.stringify(saleOrder3d).includes("tax"),
      JSON.stringify(saleOrder3d.order_line),
    );
    stub3d.restore();

    const stub3d2 = installOdooJsonRpcStub({
      products: { taxes: [{ sku: LINE_PILLOW.sku, taxIds: [15] }] },
    });
    await configureOdoo();
    const order3d2 = await makeOrder(seller.id);
    const outcome3d2 = await createOdooInvoiceForOrder(order3d2.id, JOB_ACTOR);
    check(
      "a zero-rated sale tax is accepted",
      outcome3d2.status === "CREATED",
      outcome3d2.status,
    );
    stub3d2.restore();

    const stub3d3 = installOdooJsonRpcStub({
      products: { taxes: [{ sku: LINE_PILLOW.sku, taxIds: [10] }] },
    });
    await configureOdoo();
    const order3d3 = await makeOrder(seller.id);
    const error3d3 = await catchError(() => createOdooInvoiceForOrder(order3d3.id, JOB_ACTOR));
    check(
      "a tax GROUP that adds is refused by its effect, not by its own (100) rate",
      error3d3 instanceof PermanentJobError &&
        (error3d3 as Error).message.includes("11% GST+PST SK") &&
        stub3d3.writes().length === 0,
      describe(error3d3),
    );
    stub3d3.restore();

    /* ------------------------------------------------------------------ */
    /* 3e. The last line of defence: an invoice whose total disagrees with */
    /*     the charge is refused BEFORE it is posted — the second layer,   */
    /*     for anything the catalogue check above cannot see.              */
    /* ------------------------------------------------------------------ */
    const stub3e = installOdooJsonRpcStub({
      invoiceTotalOverride: Math.round((TOTAL_MAJOR + 13) * 100) / 100,
    });
    await configureOdoo();
    const order3e = await makeOrder(seller.id);
    const error3e = await catchError(() => createOdooInvoiceForOrder(order3e.id, JOB_ACTOR));
    const message3e = error3e instanceof Error ? error3e.message : String(error3e);
    check(
      "an invoice that does not total the captured amount is refused, naming both",
      error3e instanceof PermanentJobError &&
        message3e.includes("157.47") &&
        message3e.includes("144.47") &&
        message3e.includes("a draft, unposted"),
      describe(error3e),
    );
    check(
      "the disagreeing invoice was NOT posted",
      stub3e.callsTo("account.move", "action_post").length === 0,
      JSON.stringify(stub3e.callsTo("account.move", "action_post").length),
    );
    check(
      "no payment was registered and no email was sent for it",
      stub3e.callsTo("account.payment.register", "create").length === 0 &&
        stub3e.callsTo("mail.template", "send_mail").length === 0,
    );
    const link3e = await readLink(order3e.id);
    check(
      "the order records the failure and stays unlinked",
      link3e?.odooInvoiceId === null &&
        (link3e?.odooInvoiceError ?? "").includes("157.47"),
      JSON.stringify({ id: link3e?.odooInvoiceId, error: link3e?.odooInvoiceError }),
    );
    stub3e.restore();

    /* ------------------------------------------------------------------ */
    /* 4. The journal: a missing one is permanent; a repaired one resumes  */
    /*    from the SAME invoice (no duplicate on retry).                   */
    /* ------------------------------------------------------------------ */
    const stub4 = installOdooJsonRpcStub({ journal: "none" });
    await configureOdoo();
    const order4 = await makeOrder(seller.id);
    const error4 = await catchError(() => createOdooInvoiceForOrder(order4.id, JOB_ACTOR));
    const error4Message = error4 instanceof Error ? error4.message : String(error4);
    check(
      "a missing journal is a PERMANENT failure naming the setting and the name",
      error4 instanceof PermanentJobError &&
        error4Message.includes("ODOO_INVOICE_JOURNAL") &&
        error4Message.includes("MoonVella Stripe"),
      describe(error4),
    );
    check(
      "no payment is registered when no journal matches",
      stub4.callsTo("account.payment.register", "create").length === 0,
    );
    check(
      "the invoice itself was posted before the stop, so a retry can adopt it",
      stub4.callsTo("account.move", "action_post").length === 1,
    );

    // The owner creates the journal in Odoo; the retry is the same call.
    stub4.scenario.journal = "ok";
    const retry4 = await createOdooInvoiceForOrder(order4.id, JOB_ACTOR);
    check(
      "after the journal exists, the retry completes from the SAME invoice",
      retry4.status === "CREATED" && retry4.odooInvoiceId === 1001,
      JSON.stringify({ status: retry4.status, id: retry4.odooInvoiceId }),
    );
    check(
      "the retry created no second sale order, invoice or post",
      stub4.callsTo("sale.order", "create").length === 1 &&
        stub4.callsTo("sale.advance.payment.inv", "create_invoices").length === 1 &&
        stub4.callsTo("account.move", "action_post").length === 1,
      JSON.stringify({
        saleOrders: stub4.callsTo("sale.order", "create").length,
        invoices: stub4.callsTo("sale.advance.payment.inv", "create_invoices").length,
        posts: stub4.callsTo("account.move", "action_post").length,
      }),
    );
    stub4.restore();

    /* ------------------------------------------------------------------ */
    /* 4b. A configured journal name is the one resolved and used.         */
    /* ------------------------------------------------------------------ */
    const stub4b = installOdooJsonRpcStub();
    await configureOdoo({ ODOO_INVOICE_JOURNAL: "Custom Settlement Co" });
    const order4b = await makeOrder(seller.id);
    const outcome4b = await createOdooInvoiceForOrder(order4b.id, JOB_ACTOR);
    const journalSearches4b = stub4b.callsTo("account.journal", "search_read");
    check(
      "the configured journal name — not the default — is the one searched and used",
      journalSearches4b.length === 1 &&
        searchedValue(journalSearches4b[0], "name") === "Custom Settlement Co" &&
        outcome4b.payment?.journalName === "Custom Settlement Co",
      JSON.stringify({
        searched: journalSearches4b.length
          ? searchedValue(journalSearches4b[0], "name")
          : null,
        used: outcome4b.payment?.journalName,
      }),
    );
    stub4b.restore();

    /* ------------------------------------------------------------------ */
    /* 4c. A registered payment that settled NOTHING is a failure, not a   */
    /*     success. Odoo 18 skips the journal entry for a payment whose    */
    /*     journal's payment method line has no outstanding account, and   */
    /*     the invoice then reads "in_payment" with the full residual      */
    /*     still outstanding — observed on stage2, where the pipeline had  */
    /*     reported the invoice paid.                                      */
    /* ------------------------------------------------------------------ */
    const stub4c = installOdooJsonRpcStub({ paymentSettlement: "unsettled" });
    await configureOdoo();
    const order4c = await makeOrder(seller.id);
    const error4c = await catchError(() => createOdooInvoiceForOrder(order4c.id, JOB_ACTOR));
    const error4cMessage = error4c instanceof Error ? error4c.message : String(error4c);
    check(
      "a payment that left the invoice unsettled is a PERMANENT failure naming the fix",
      error4c instanceof PermanentJobError &&
        error4cMessage.includes("outstanding") &&
        error4cMessage.includes("payment method line"),
      describe(error4c),
    );
    check(
      "the unsettled invoice is not emailed as paid",
      stub4c.callsTo("mail.template", "send_mail").length === 0,
    );
    check(
      "the unsettled failure is recorded on the order for the repair action",
      ((await readLink(order4c.id))?.odooInvoiceError ?? "").includes("outstanding"),
      JSON.stringify(await readLink(order4c.id)),
    );

    /* 4d. The retry after the operator fixes the journal: the invoice reads
     *     "in_payment" on the ghost, so the resume must look past the payment
     *     state, see that nothing reached the books, and register the payment
     *     — not skip it and link an unpaid invoice as settled. */
    stub4c.scenario.paymentSettlement = "ok";
    const retry4c = await createOdooInvoiceForOrder(order4c.id, JOB_ACTOR);
    check(
      "with the journal fixed, the retry registers the payment and settles the invoice",
      retry4c.status === "CREATED" && retry4c.payment !== null,
      JSON.stringify({ status: retry4c.status, payment: retry4c.payment }),
    );
    check(
      "the retry registered exactly one more payment — the ghost settled nothing",
      stub4c.callsTo("account.payment.register", "create").length === 2,
      String(stub4c.callsTo("account.payment.register", "create").length),
    );
    stub4c.restore();

    /* 4e. A POSTED payment with the invoice still open is money that already
     *     exists: the retry must refuse rather than pay twice. */
    const stub4e = installOdooJsonRpcStub({ paymentSettlement: "unsettled-real" });
    await configureOdoo();
    const order4e = await makeOrder(seller.id);
    const first4e = await catchError(() => createOdooInvoiceForOrder(order4e.id, JOB_ACTOR));
    check(
      "a posted payment that leaves the residual open still fails the settlement check",
      first4e instanceof PermanentJobError &&
        (first4e as Error).message.includes("outstanding"),
      describe(first4e),
    );
    const error4e = await catchError(() => createOdooInvoiceForOrder(order4e.id, JOB_ACTOR));
    const error4eMessage = error4e instanceof Error ? error4e.message : String(error4e);
    check(
      "the retry finds the posted payment and refuses a second one, naming it",
      error4e instanceof PermanentJobError &&
        error4eMessage.includes("posted payment") &&
        error4eMessage.includes("PAY/"),
      describe(error4e),
    );
    check(
      "no second payment was registered on top of real money",
      stub4e.callsTo("account.payment.register", "create").length === 1,
      String(stub4e.callsTo("account.payment.register", "create").length),
    );
    stub4e.restore();

    /* ------------------------------------------------------------------ */
    /* 5. The template: missing, or present but not stamped MoonVella.     */
    /* ------------------------------------------------------------------ */
    const stub5 = installOdooJsonRpcStub({ template: "missing" });
    await configureOdoo();
    const order5 = await makeOrder(seller.id);
    const error5 = await catchError(() => createOdooInvoiceForOrder(order5.id, JOB_ACTOR));
    check(
      "a missing 'MoonVella B2B Wholesale' template is a PERMANENT failure naming it",
      error5 instanceof PermanentJobError &&
        (error5 as Error).message.includes("MoonVella B2B Wholesale"),
      describe(error5),
    );
    check(
      "no sale order is created without the template",
      stub5.callsTo("sale.order", "create").length === 0,
    );
    stub5.restore();

    const stub5b = installOdooJsonRpcStub({ template: "unstamped" });
    const order5b = await makeOrder(seller.id);
    const error5b = await catchError(() => createOdooInvoiceForOrder(order5b.id, JOB_ACTOR));
    check(
      "a template without the MoonVella brand/channel stamps is refused, not used",
      error5b instanceof PermanentJobError &&
        (error5b as Error).message.includes("prema_operating_brand") &&
        (error5b as Error).message.includes("direct_b2b"),
      describe(error5b),
    );
    check(
      "no sale order is created from an unstamped template",
      stub5b.callsTo("sale.order", "create").length === 0,
    );
    stub5b.restore();

    /* ------------------------------------------------------------------ */
    /* 5d. The mail template's model is compared by its TECHNICAL name.    */
    /*     Odoo 18 renders account.move's ir.model display name as         */
    /*     "Journal Entry", and the stub now answers exactly that — so the */
    /*     happy path above proves the correct template is accepted, and   */
    /*     this proves a genuinely wrong model is still refused.           */
    /* ------------------------------------------------------------------ */
    const stub5d = installOdooJsonRpcStub({ mailTemplate: "wrong-model" });
    await configureOdoo();
    const order5d = await makeOrder(seller.id);
    const error5d = await catchError(() => createOdooInvoiceForOrder(order5d.id, JOB_ACTOR));
    check(
      "a mail template attached to another model is refused, naming that model",
      error5d instanceof PermanentJobError &&
        (error5d as Error).message.includes("res.partner"),
      describe(error5d),
    );
    check(
      "no mail is sent through a template bound to another model",
      stub5d.callsTo("mail.template", "send_mail").length === 0,
    );
    stub5d.restore();

    /* ------------------------------------------------------------------ */
    /* 5c. A sale order already carrying the reference is ADOPTED, never   */
    /*     duplicated (the crash-between-create-and-link recovery).        */
    /* ------------------------------------------------------------------ */
    const stub5c = installOdooJsonRpcStub({
      existingSaleOrder: {
        id: 890,
        state: "draft",
        clientOrderRef: `${SHOP}#adopt-me`,
        partnerId: 705,
        partnerName: "Reused Verify Customer",
        lines: [
          { productId: 300, quantity: 3, priceUnit: 12.99 },
          { productId: 301, quantity: 1, priceUnit: 105.5 },
        ],
      },
    });
    const order5c = await makeOrder(seller.id);
    await prisma.order.update({
      where: { id: order5c.id },
      data: { supplierReference: `${SHOP}#adopt-me` },
    });
    const outcome5c = await createOdooInvoiceForOrder(order5c.id, JOB_ACTOR);
    check(
      "an existing sale order for the reference is adopted, not duplicated",
      outcome5c.status === "CREATED" &&
        outcome5c.odooSaleOrderId === 890 &&
        stub5c.callsTo("sale.order", "create").length === 0,
      JSON.stringify({
        saleOrderId: outcome5c.odooSaleOrderId,
        creates: stub5c.callsTo("sale.order", "create").length,
      }),
    );
    check(
      "a draft adopted sale order is confirmed first",
      stub5c.callsTo("sale.order", "action_confirm").length === 1,
    );
    check(
      "the adopted sale order still yields exactly one invoice and one payment",
      stub5c.callsTo("sale.advance.payment.inv", "create_invoices").length === 1 &&
        stub5c.callsTo("account.payment.register", "create").length === 1,
    );
    const mapping5c = await prisma.externalContactMapping.findUnique({
      where: { sellerId_role: { sellerId: seller.id, role: "COMPANY" } },
    });
    check(
      "a mapping pointing at a different partner is reported, never overwritten",
      mapping5c?.odooPartnerId === 700,
      String(mapping5c?.odooPartnerId),
    );
    stub5c.restore();

    /* ------------------------------------------------------------------ */
    /* 6. Linked but not emailed: the resume sends ONLY the email.         */
    /* ------------------------------------------------------------------ */
    const stub6 = installOdooJsonRpcStub({
      existingInvoice: {
        id: 1001,
        state: "posted",
        paymentState: "paid",
        name: "INV/2026/00001",
        amountTotal: TOTAL_MAJOR,
        // A paid invoice has nothing outstanding; the guard now checks this,
        // because a payment that settled nothing also reads "in_payment".
        amountResidual: 0,
      },
    });
    await configureOdoo();
    const order6 = await makeOrder(seller.id);
    const syncedAt = new Date("2026-10-03T15:00:00Z");
    await prisma.order.update({
      where: { id: order6.id },
      data: {
        odooInvoiceId: 1001,
        odooInvoiceName: "INV/2026/00001",
        odooSaleOrderId: 900,
        odooInvoiceSyncedAt: syncedAt,
        odooInvoiceError: "an earlier run stopped before the email",
      },
    });
    const outcome6 = await createOdooInvoiceForOrder(order6.id, JOB_ACTOR);
    const link6 = await readLink(order6.id);
    check(
      "a linked-but-unemailed order resumes and sends only the email",
      outcome6.status === "CREATED" &&
        stub6.writes().length === 1 &&
        stub6.writes()[0].method === "send_mail",
      JSON.stringify(stub6.writes().map((call) => `${call.model}.${call.method}`)),
    );
    check(
      "the resume neither re-posted nor re-paid the invoice",
      stub6.callsTo("account.move", "action_post").length === 0 &&
        stub6.callsTo("account.payment.register", "create").length === 0,
    );
    check(
      "the resume cleared the recorded error and kept the original sync time",
      link6?.odooInvoiceError === null &&
        link6?.odooInvoiceSyncedAt?.getTime() === syncedAt.getTime() &&
        link6?.odooInvoiceEmailSentAt !== null,
    );
    stub6.restore();

    /* ------------------------------------------------------------------ */
    /* 7. The guard ladder.                                                */
    /* ------------------------------------------------------------------ */
    const stub7a = installOdooJsonRpcStub();
    await configureOdoo({ ODOO_MODE: "readonly" });
    const order7a = await makeOrder(seller.id);
    const error7a = await catchError(() => createOdooInvoiceForOrder(order7a.id, JOB_ACTOR));
    check(
      "readonly mode refuses the write",
      error7a instanceof OdooWriteBlockedError,
      describe(error7a),
    );
    check(
      "not one write reached Odoo, though reads did (it stopped AT the write)",
      stub7a.writes().length === 0 && stub7a.calls.length > 0,
      JSON.stringify({
        writes: stub7a.writes().length,
        calls: stub7a.calls.length,
      }),
    );
    stub7a.restore();

    const stub7b = installOdooJsonRpcStub();
    await configureOdoo({ ODOO_DATABASE: "Prod-db" });
    const order7b = await makeOrder(seller.id);
    const error7b = await catchError(() => createOdooInvoiceForOrder(order7b.id, JOB_ACTOR));
    check(
      "the Prod-db guard refuses before a single byte is sent",
      error7b instanceof OdooDatabaseBlockedError && stub7b.calls.length === 0,
      describe(error7b),
    );
    stub7b.restore();

    const stub7c = installOdooJsonRpcStub();
    await disconnectCredentials("odoo");
    clearOdooEnv();
    const order7c = await makeOrder(seller.id);
    const error7c = await catchError(() => createOdooInvoiceForOrder(order7c.id, JOB_ACTOR));
    check(
      "an unconfigured connector is refused as not-configured, with no call",
      error7c instanceof OdooNotConfiguredError && stub7c.calls.length === 0,
      describe(error7c),
    );
    stub7c.restore();

    /* ------------------------------------------------------------------ */
    /* 8. Static couplings that a refactor could silently break.           */
    /* ------------------------------------------------------------------ */
    const invoiceSource = readStripped("app/services/odooInvoice.server.ts");
    check(
      "the orchestrator uses only the connector's public surface",
      !/\b(executeKw|guardedWrite|callOdoo|assertWriteAllowed)\b/.test(invoiceSource),
    );
    check(
      "the orchestrator contains no private (underscore) Odoo method literal",
      !/["'`]_[a-zA-Z]/.test(invoiceSource),
    );
    check(
      "the orchestrator imports no payment module — Odoo is not a payment rail",
      !/from\s+["'][^"']*(stripe|payments\.server|sellerBilling)[^"']*["']/i.test(invoiceSource),
    );

    const connectorSource = readStripped("app/services/odoo.server.ts");
    check(
      "the connector sends send_mail in Odoo's record-method shape, queued",
      connectorSource.includes("[[templateId], invoiceId]") &&
        connectorSource.includes("force_send: false"),
    );
    check(
      "action_post disables the abnormal-invoice wizard",
      connectorSource.includes("disable_abnormal_invoice_detection"),
    );
    check(
      "the catalogue's tax question goes to Odoo's own arithmetic, not a reimplementation",
      connectorSource.includes('"compute_all"') &&
        connectorSource.includes("TAX_MODEL"),
    );
    check(
      "the product lookup reads the taxes the check rests on",
      connectorSource.includes('"invoice_policy", "taxes_id"'),
    );
    check(
      "the orchestrator checks the tax and never overrides it with a tax_id of its own",
      invoiceSource.includes("computeTaxTotals") &&
        invoiceSource.includes("findTaxesByIds") &&
        !/tax_id\s*:/.test(invoiceSource),
    );
    check(
      "the total/currency guard runs on the draft BEFORE posting, and again at payment time",
      invoiceSource.includes(
        "assertInvoiceMatchesPayment(invoiceId, state, input.payment)",
      ) &&
        invoiceSource.includes(
          "assertInvoiceMatchesPayment(input.invoiceId, state, payment)",
        ),
    );

    const fieldsSource = readStripped("app/services/integrationFields.ts");
    check(
      "the journal setting name is the same string on both sides",
      fieldsSource.includes('name: "ODOO_INVOICE_JOURNAL"') &&
        invoiceSource.includes("ODOO_INVOICE_JOURNAL"),
    );

    const jobsSource = readStripped("app/services/jobs.server.ts");
    const handlersSource = readStripped("app/services/jobHandlers.server.ts");
    check(
      "the ODOO_INVOICE_SYNC job kind exists and its handler calls the pipeline",
      /\bODOO_INVOICE_SYNC\b/.test(jobsSource) &&
        handlersSource.includes("createOdooInvoiceForOrder") &&
        handlersSource.includes("JOB_KIND.ODOO_INVOICE_SYNC"),
    );

    const fulfillmentSource = readStripped("app/services/fulfillment.server.ts");
    // One enqueue per handoff path: the fulfillment milestone and a manually
    // added shipment. Counted as enqueue sites rather than as raw occurrences,
    // because each site names the kind twice (kind + idempotency key).
    const invoiceEnqueueSites = fulfillmentSource
      .split("enqueueJob(")
      .filter((segment) => segment.includes("ODOO_INVOICE_SYNC")).length;
    check(
      "both handoff paths queue the invoice job (milestone and manual shipment)",
      invoiceEnqueueSites === 2,
      `${invoiceEnqueueSites} enqueue site(s)`,
    );

    const routeSource = readStripped("app/routes/admin.orders_.$id.tsx");
    check(
      "the order page offers the manual repair/retry action",
      routeSource.includes('"create_odoo_invoice"') &&
        routeSource.includes("createOdooInvoiceForOrder"),
    );
    check(
      "the Stripe 'Create invoice' action is untouched alongside it",
      routeSource.includes("create_payment"),
    );
  } finally {
    // Restore whatever the clone had before this suite ran — the store rows AND
    // the state rows (the guard scenarios write a disconnect marker).
    await clearOdooStore();
    for (const row of savedCreds) {
      await prisma.integrationCredential.create({ data: { ...row, updatedAt: undefined } });
    }
    for (const row of savedState) {
      await prisma.integrationState.create({ data: { ...row, updatedAt: undefined } });
    }
    if (savedWritesFlag === undefined) delete process.env.ODOO_ALLOW_WRITES;
    else process.env.ODOO_ALLOW_WRITES = savedWritesFlag;
    clearOdooEnv();

    await prisma.$disconnect();
  }

  const passed = total - failures;
  console.log(`\n${passed}/${total} checks passed`);
  if (failures > 0) {
    console.log(`\n${failures} FAILED.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
