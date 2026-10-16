/**
 * The DRAFT Odoo invoice at carrier handoff.
 *
 * This suite runs the REAL pipeline (`createOdooInvoiceForOrder`) against a
 * stubbed Odoo and asserts both outcomes and the exact RPC payloads — the
 * quotation-template id, the product ids behind the ordered SKUs, the empty
 * tax set stated on every line, the tracking write, and the chatter note. The
 * stub's invoice totals are computed from the lines the pipeline sent (through
 * the same tax model `compute_all` implements), so the pipeline's own money
 * gate — invoice total vs the captured Stripe amount, and no tax — is
 * load-bearing here rather than bypassed.
 *
 * What it proves, in the work order's terms:
 *
 *   • the invoice is created as a DRAFT from the existing "MoonVella B2B
 *     Wholesale" template, and a template missing its MoonVella brand/channel
 *     stamps fails loudly instead of producing the wrong document;
 *   • lines are Odoo PRODUCTS resolved from the ordered SKUs — never a
 *     free-text line — and a SKU with no product is a named failure;
 *   • no tax is added: every line is created with an explicit empty tax set,
 *     and even when Odoo applies the product's own taxes anyway (the stub's
 *     "ignore" scenario, both the adds-to-price and included-in-price shapes)
 *     the invoice's lines are cleared and RE-VERIFIED before the draft is
 *     linked, so it totals the captured charge with zero tax;
 *   • posting, payment registration and emailing never happen: the stub does
 *     not model `action_post`, `account.payment.register` or
 *     `mail.template.send_mail` at all, so a pipeline that reached for one
 *     would fail this run — and the payload assertions pin that none was
 *     called;
 *   • the shipment's carrier, service, tracking number and provider reference
 *     are written onto the draft (tracking into the module's own field, the
 *     whole block as one internal note carrying a stable marker), and a retry
 *     does not duplicate the note (the stub stores it as Odoo does — HTML —
 *     so the comparison is exercised against the real wrapped shape);
 *   • a retry never creates a second sale order or invoice: a linked DRAFT is
 *     refreshed in place (even when a person has edited its totals), and a
 *     linked POSTED invoice is reported and left completely untouched;
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
import { installOdooJsonRpcStub, type OdooStubCall } from "./odoo-jsonrpc-stub";

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
/** The captured date the payment record carries (no ledger entry is written). */
const CAPTURED_AT = new Date("2026-10-03T14:30:00Z");

/** The shipment fixture's facts — what must land on the draft. */
const CARRIER = "Purolator";
const SERVICE = "Purolator Ground";
const TRACKING = "MV123456789CA";
const PROVIDER_REF = "ESHP-9001";
const NOTE_BODY =
  `[MoonVella shipment] Carrier: ${CARRIER} · Service: ${SERVICE} · ` +
  `Tracking: ${TRACKING} · Provider ref: ${PROVIDER_REF}`;

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

/** The values argument of a `write` call — `args[0]` is the id list there. */
function writeValuesOf(call: OdooStubCall): Record<string, unknown> {
  return (call.args[1] ?? {}) as Record<string, unknown>;
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
    /** A shipment to describe on the draft; on by default (handoff implies one). */
    shipment?: boolean;
  } = {},
) {
  seq += 1;
  const lines = options.lines ?? [LINE_PILLOW, LINE_DUVET];
  const amount = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
  const withSnapshot = options.snapshot ?? true;
  const withShipment = options.shipment ?? true;

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
      ...(withShipment
        ? {
            shipments: {
              create: {
                status: "SHIPPED",
                carrier: CARRIER,
                serviceName: SERVICE,
                serviceCode: "PUR-GRD",
                trackingNumber: TRACKING,
                providerShipmentId: PROVIDER_REF,
                providerQuoteId: "QUOTE-7001",
                handedToCarrierAt: CAPTURED_AT,
              },
            },
          }
        : {}),
    },
  });
}

async function shipmentIdFor(orderId: string): Promise<string> {
  const shipment = await prisma.shipment.findFirst({ where: { orderId } });
  if (!shipment) throw new Error(`fixture: order ${orderId} has no shipment`);
  return shipment.id;
}

const linkSelect = {
  odooInvoiceId: true,
  odooInvoiceName: true,
  odooSaleOrderId: true,
  odooInvoiceSyncedAt: true,
  odooInvoiceState: true,
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
    await prisma.shipment.deleteMany({ where: { orderId: { in: ids } } });
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
    // hold must be RECORDED and must not strand the draft.
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
    /* 1. Happy path: a DRAFT, every payload asserted, nothing posted,     */
    /*    paid or emailed.                                                 */
    /* ------------------------------------------------------------------ */
    const stub = installOdooJsonRpcStub();
    await configureOdoo();
    const order1 = await makeOrder(seller.id);

    const outcome = await createOdooInvoiceForOrder(order1.id, JOB_ACTOR);

    check("happy path: the draft invoice was created", outcome.status === "CREATED", outcome.status);
    check(
      "happy path: the invoice is a DRAFT and unpaid in Odoo — nothing was posted or paid",
      outcome.invoice.state === "draft" && outcome.invoice.paymentState === false,
      `${outcome.invoice.state}/${String(outcome.invoice.paymentState)}`,
    );
    check(
      "happy path: the invoice totals the captured charge with ZERO tax",
      Math.abs(outcome.invoice.amountTotal - TOTAL_MAJOR) < 0.005 &&
        Math.abs(outcome.invoice.amountTax) < 0.005,
      `${outcome.invoice.amountTotal} / tax ${outcome.invoice.amountTax}`,
    );
    check(
      "happy path: the customer contact was created from the application's legal name",
      outcome.partner?.outcome === "CREATED" &&
        outcome.partner.id === 700 &&
        outcome.partner.name === LEGAL_NAME,
      JSON.stringify(outcome.partner),
    );
    check(
      "happy path: the shipment facts are ON the draft — tracking ref written, note posted",
      outcome.shipment?.carrier === CARRIER &&
        outcome.shipment.service === SERVICE &&
        outcome.shipment.trackingNumber === TRACKING &&
        outcome.shipment.providerReference === PROVIDER_REF &&
        outcome.shipment.trackingRefWritten === true &&
        outcome.shipment.notePosted === true,
      JSON.stringify(outcome.shipment),
    );

    const link1 = await readLink(order1.id);
    check(
      "happy path: the order is linked to the Odoo draft (id, state, sale order)",
      link1?.odooInvoiceId === 1001 &&
        link1.odooInvoiceName === null && // a draft has no number yet ("/")
        link1.odooSaleOrderId === 900 &&
        link1.odooInvoiceState === "draft" &&
        link1.odooInvoiceError === null,
      JSON.stringify(link1),
    );
    check(
      "happy path: the sync timestamp was recorded",
      link1?.odooInvoiceSyncedAt !== null,
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
    check(
      "every line states an EXPLICIT EMPTY tax set — the 'no tax added' rule at the source",
      lineValues.length === 2 &&
        lineValues.every((line) => JSON.stringify(line.tax_id) === "[[6,0,[]]]"),
      JSON.stringify(lineValues.map((line) => line.tax_id)),
    );

    const templateSearches = stub.callsTo("sale.order.template", "search_read");
    check(
      "the quotation template was searched for by its exact name",
      templateSearches.length === 1 &&
        searchedValue(templateSearches[0], "name") === "MoonVella B2B Wholesale",
      String(templateSearches.length ? searchedValue(templateSearches[0], "name") : "no search"),
    );

    const trackingWrites = stub.callsTo("account.move", "write");
    check(
      "the tracking number was written ONCE, into the module's own field",
      trackingWrites.length === 1 &&
        JSON.stringify(writeValuesOf(trackingWrites[0])) ===
          JSON.stringify({ mv_shipping_tracking_ref: TRACKING }),
      JSON.stringify(trackingWrites.map((call) => writeValuesOf(call))),
    );

    const notePosts = stub.callsTo("account.move", "message_post");
    check(
      "the shipment block was posted ONCE as an internal note carrying the marker",
      notePosts.length === 1 &&
        notePosts[0].kwargs.subtype_xmlid === "mail.mt_note" &&
        notePosts[0].kwargs.body === NOTE_BODY,
      JSON.stringify(notePosts.map((call) => call.kwargs)),
    );

    check(
      "no tax clear was needed — the invoice was born tax-free, so no line write happened",
      stub.callsTo("account.move.line", "write").length === 0,
    );

    check(
      "NOTHING was posted, paid or emailed — the draft-only rule, proven by the call log",
      stub.callsTo("account.move", "action_post").length === 0 &&
        stub.callsTo("account.payment.register", "create").length === 0 &&
        stub.calls.filter((call) => call.model === "mail.template").length === 0 &&
        stub.calls.filter((call) => call.model === "account.payment").length === 0 &&
        stub.calls.filter((call) => call.model === "account.journal").length === 0,
      JSON.stringify(stub.writes().map((call) => `${call.model}.${call.method}`)),
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
    check("the draft was audited against the order", audit !== null);
    check(
      "the audit records the CREATED status, the company and the currency",
      auditAfter?.status === "CREATED" &&
        auditAfter?.companyId === 1 &&
        auditAfter?.currency === "CAD" &&
        auditAfter?.invoiceState === "draft",
      JSON.stringify({ status: auditAfter?.status, companyId: auditAfter?.companyId }),
    );
    check(
      "the financial hold was RECORDED on the audit and did not stop the draft",
      typeof auditAfter?.financialHold === "string",
      JSON.stringify(auditAfter?.financialHold),
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
    /* 2. Idempotency: a second run refreshes, duplicates nothing, and     */
    /*    performs no write at all (the note is already there, compared    */
    /*    through Odoo's HTML storage).                                    */
    /* ------------------------------------------------------------------ */
    const writesBefore = stub.writes().length;
    const second = await createOdooInvoiceForOrder(order1.id, JOB_ACTOR);
    const link2 = await readLink(order1.id);
    check("a second run reports UPDATED (the draft already existed)", second.status === "UPDATED", second.status);
    check(
      "a second run performs no write of any kind — no duplicate note, no duplicate ref write",
      stub.writes().length === writesBefore,
      `${stub.writes().length} vs ${writesBefore}`,
    );
    check(
      "there is still exactly one sale order, one invoice, one tracking write and one note",
      stub.callsTo("sale.order", "create").length === 1 &&
        stub.callsTo("sale.advance.payment.inv", "create_invoices").length === 1 &&
        stub.callsTo("account.move", "write").length === 1 &&
        stub.callsTo("account.move", "message_post").length === 1,
    );
    check(
      "the link still points at the same draft, error-free",
      link2?.odooInvoiceId === 1001 &&
        link2.odooInvoiceState === "draft" &&
        link2.odooInvoiceError === null,
      JSON.stringify(link2),
    );

    /* ------------------------------------------------------------------ */
    /* 2b. A tracking change on the shipment refreshes the SAME draft.     */
    /* ------------------------------------------------------------------ */
    const NEW_TRACKING = "MV999999999CA";
    await prisma.shipment.update({
      where: { id: await shipmentIdFor(order1.id) },
      data: { trackingNumber: NEW_TRACKING },
    });
    const refreshed = await createOdooInvoiceForOrder(order1.id, JOB_ACTOR);
    check(
      "a tracking change refreshes the draft in place — UPDATED, not a second invoice",
      refreshed.status === "UPDATED" &&
        refreshed.odooInvoiceId === 1001 &&
        refreshed.shipment?.trackingRefWritten === true &&
        refreshed.shipment?.notePosted === true,
      JSON.stringify({ status: refreshed.status, shipment: refreshed.shipment }),
    );
    const newTrackingWrites = stub.callsTo("account.move", "write");
    check(
      "the new tracking number was written to the field and the new note carries it",
      newTrackingWrites.length === 2 &&
        JSON.stringify(writeValuesOf(newTrackingWrites[1])) ===
          JSON.stringify({ mv_shipping_tracking_ref: NEW_TRACKING }) &&
        String(stub.callsTo("account.move", "message_post")[1]?.kwargs.body ?? "").includes(NEW_TRACKING),
      JSON.stringify(newTrackingWrites.map((call) => writeValuesOf(call))),
    );
    check(
      "still exactly one invoice was ever created from the sale order",
      stub.callsTo("sale.advance.payment.inv", "create_invoices").length === 1,
    );
    stub.restore();

    /* ------------------------------------------------------------------ */
    /* 2c. A linked invoice a person has POSTED is reported and left       */
    /*     completely untouched — no field, no note, no write at all.      */
    /* ------------------------------------------------------------------ */
    const stub2c = installOdooJsonRpcStub({
      existingInvoice: {
        id: 1002,
        state: "posted",
        paymentState: "not_paid",
        name: "INV/2026/00042",
        amountTotal: TOTAL_MAJOR,
        amountUntaxed: TOTAL_MAJOR,
        amountTax: 0,
        amountResidual: TOTAL_MAJOR,
      },
    });
    await configureOdoo();
    const order2c = await makeOrder(seller.id);
    await prisma.order.update({
      where: { id: order2c.id },
      data: {
        odooInvoiceId: 1002,
        odooInvoiceName: "INV/2026/00042",
        odooSaleOrderId: 902,
        odooInvoiceState: "draft",
        odooInvoiceError: "an earlier run stopped before the shipment facts",
      },
    });
    const outcome2c = await createOdooInvoiceForOrder(order2c.id, JOB_ACTOR);
    const link2c = await readLink(order2c.id);
    check(
      "a posted invoice is reported as POSTED, not re-created",
      outcome2c.status === "POSTED" &&
        outcome2c.odooInvoiceId === 1002 &&
        outcome2c.invoice.state === "posted",
      JSON.stringify({ status: outcome2c.status, state: outcome2c.invoice.state }),
    );
    check(
      "not one write reached a posted invoice — no ref, no note, nothing",
      stub2c.writes().length === 0,
      JSON.stringify(stub2c.writes().map((call) => `${call.model}.${call.method}`)),
    );
    check(
      "the link now records the observed state and clears the stale error",
      link2c?.odooInvoiceState === "posted" &&
        link2c.odooInvoiceName === "INV/2026/00042" &&
        link2c.odooInvoiceError === null,
      JSON.stringify(link2c),
    );
    const audit2c = await prisma.auditLog.findFirst({
      where: { action: "order.odoo_invoice_updated", entityId: order2c.id },
      orderBy: { createdAt: "desc" },
    });
    const audit2cAfter =
      audit2c?.afterData && typeof audit2c.afterData === "string"
        ? (JSON.parse(audit2c.afterData) as Record<string, unknown>)
        : null;
    check(
      "the POSTED outcome is audited as such",
      audit2cAfter?.status === "POSTED",
      JSON.stringify(audit2cAfter?.status),
    );
    stub2c.restore();

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
    /* 3b. A payment that is not SUCCEEDED: no draft is created at all.    */
    /* ------------------------------------------------------------------ */
    const stub3b = installOdooJsonRpcStub();
    const order3b = await makeOrder(seller.id, { paymentStatus: "REFUNDED" });
    const error3b = await catchError(() => createOdooInvoiceForOrder(order3b.id, JOB_ACTOR));
    check(
      "a refunded (not SUCCEEDED) wholesale payment creates no invoice draft",
      error3b instanceof PermanentJobError &&
        (error3b as Error).message.includes("REFUNDED") &&
        (error3b as Error).message.includes("no invoice draft"),
      describe(error3b),
    );
    check(
      "nothing at all was sent to Odoo for the un-charged order — not even a read",
      stub3b.calls.length === 0,
      JSON.stringify(stub3b.calls.map((call) => `${call.model}.${call.method}`)),
    );
    stub3b.restore();

    /* ------------------------------------------------------------------ */
    /* 3c. The catalogue's taxes DON'T ride onto the draft. Even when      */
    /*     Odoo applies them anyway (the stub's "ignore" scenario), the    */
    /*     invoice's own lines are cleared and RE-VERIFIED, so the draft   */
    /*     totals the captured charge with zero tax.                       */
    /* ------------------------------------------------------------------ */
    const stub3c = installOdooJsonRpcStub({
      products: { taxes: [{ sku: LINE_PILLOW.sku, taxIds: [7] }] }, // 13% HST, adds to price
      saleOrderLineTax: "ignore", // Odoo applies the product tax despite the empty set
    });
    await configureOdoo();
    const order3c = await makeOrder(seller.id);
    const outcome3c = await createOdooInvoiceForOrder(order3c.id, JOB_ACTOR);
    check(
      "even when Odoo taxes the lines anyway, the linked draft is tax-free and totals the charge",
      outcome3c.status === "CREATED" &&
        Math.abs(outcome3c.invoice.amountTax) < 0.005 &&
        Math.abs(outcome3c.invoice.amountTotal - TOTAL_MAJOR) < 0.005,
      JSON.stringify(outcome3c.invoice),
    );
    const lineWrites3c = stub3c.callsTo("account.move.line", "write");
    check(
      "the taxed line was cleared to the empty tax set — one write, only the taxed line",
      lineWrites3c.length === 1 &&
        JSON.stringify(lineWrites3c[0].args[1]) === JSON.stringify({ tax_ids: [[6, 0, []]] }) &&
        Array.isArray(lineWrites3c[0].args[0]) &&
        (lineWrites3c[0].args[0] as unknown[]).length === 1,
      JSON.stringify(lineWrites3c.map((call) => call.args)),
    );
    check(
      "the draft is linked as a draft, not left half-made",
      (await readLink(order3c.id))?.odooInvoiceState === "draft" &&
        (await readLink(order3c.id))?.odooInvoiceError === null,
      JSON.stringify(await readLink(order3c.id)),
    );
    stub3c.restore();

    const stub3d = installOdooJsonRpcStub({
      products: { taxes: [{ sku: LINE_PILLOW.sku, taxIds: [69] }] }, // 13% HST, included in price
      saleOrderLineTax: "ignore",
    });
    await configureOdoo();
    const order3d = await makeOrder(seller.id);
    const outcome3d = await createOdooInvoiceForOrder(order3d.id, JOB_ACTOR);
    check(
      "the included-in-price tax shape is cleared too — zero tax, exact total",
      outcome3d.status === "CREATED" &&
        Math.abs(outcome3d.invoice.amountTax) < 0.005 &&
        Math.abs(outcome3d.invoice.amountTotal - TOTAL_MAJOR) < 0.005 &&
        stub3d.callsTo("account.move.line", "write").length === 1,
      JSON.stringify(outcome3d.invoice),
    );
    stub3d.restore();

    /* ------------------------------------------------------------------ */
    /* 3e. The money gate: an invoice whose total disagrees with the       */
    /*     charge is refused before it is linked — and nothing was posted, */
    /*     paid or emailed on the way.                                     */
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
        message3e.includes("left unlinked"),
      describe(error3e),
    );
    check(
      "the disagreeing draft was not posted, paid or emailed",
      stub3e.callsTo("account.move", "action_post").length === 0 &&
        stub3e.callsTo("account.payment.register", "create").length === 0 &&
        stub3e.calls.filter((call) => call.model === "mail.template").length === 0,
    );
    check(
      "no shipment note decorates a draft that failed the money gate",
      stub3e.callsTo("account.move", "write").length === 0 &&
        stub3e.callsTo("account.move", "message_post").length === 0,
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
      "the adopted sale order still yields exactly one invoice, posted and paid by nobody",
      stub5c.callsTo("sale.advance.payment.inv", "create_invoices").length === 1 &&
        stub5c.callsTo("account.payment.register", "create").length === 0 &&
        stub5c.callsTo("account.move", "action_post").length === 0,
    );
    check(
      "the adopted draft still gets the shipment facts",
      stub5c.callsTo("account.move", "write").length === 1 &&
        stub5c.callsTo("account.move", "message_post").length === 1,
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
    /* 6. A linked DRAFT is refreshed in place — and its amounts are NOT   */
    /*    re-asserted: once it exists, the draft is a person's workspace   */
    /*    in Odoo, and a shipment-fact refresh must not fail on an edit    */
    /*    they made on purpose.                                            */
    /* ------------------------------------------------------------------ */
    const stub6 = installOdooJsonRpcStub({
      existingInvoice: {
        id: 1003,
        state: "draft",
        name: "/",
        // Deliberately NOT the captured total: a person edited this draft.
        amountTotal: TOTAL_MAJOR + 5,
        amountUntaxed: TOTAL_MAJOR + 5,
        amountTax: 0,
        amountResidual: TOTAL_MAJOR + 5,
        trackingRef: false,
      },
    });
    await configureOdoo();
    const order6 = await makeOrder(seller.id);
    await prisma.order.update({
      where: { id: order6.id },
      data: {
        odooInvoiceId: 1003,
        odooSaleOrderId: 903,
        odooInvoiceState: "draft",
        odooInvoiceError: "an earlier run stopped before the shipment facts",
      },
    });
    const outcome6 = await createOdooInvoiceForOrder(order6.id, JOB_ACTOR);
    const link6 = await readLink(order6.id);
    check(
      "a linked draft is refreshed — UPDATED, and its edited total is NOT re-asserted",
      outcome6.status === "UPDATED" && outcome6.odooInvoiceId === 1003,
      JSON.stringify({
        status: outcome6.status,
        total: outcome6.invoice.amountTotal,
      }),
    );
    check(
      "the refresh wrote exactly the tracking ref and the note — no tax clear, no amount write",
      stub6.callsTo("account.move", "write").length === 1 &&
        stub6.callsTo("account.move", "message_post").length === 1 &&
        stub6.callsTo("account.move.line", "write").length === 0,
      JSON.stringify(stub6.writes().map((call) => `${call.model}.${call.method}`)),
    );
    check(
      "the draft's numberless state was stored honestly — no '/' as a name",
      link6?.odooInvoiceName === null &&
        link6.odooInvoiceState === "draft" &&
        link6.odooInvoiceError === null,
      JSON.stringify(link6),
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
    const connectorSource = readStripped("app/services/odoo.server.ts");
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
    check(
      "the draft-only rule is structural: the orchestrator cannot post, pay or email",
      !/\b(postInvoice|sendInvoiceEmail|registerPayment|findPaymentsByIds|computeTaxTotals|findTaxesByIds|findJournalByName|findMailTemplateByName)\b/.test(
        invoiceSource,
      ) &&
        !/action_post|send_mail|account\.payment\.register/.test(invoiceSource),
    );
    check(
      "the orchestrator states an explicit empty tax set on every line it creates",
      invoiceSource.includes("taxIds: []"),
    );
    check(
      "a linked draft is refreshed in place and a posted one is reported untouched",
      invoiceSource.includes("applyShipmentToDraft") &&
        invoiceSource.includes('status: "POSTED"'),
    );

    check(
      "the tracking write targets the module's own field and nothing else",
      connectorSource.includes("mv_shipping_tracking_ref") &&
        connectorSource.includes('"invoice.tracking_ref"'),
    );
    check(
      "the tax clear writes the empty triple and skips a tax-free invoice with NO write",
      connectorSource.includes("tax_ids: [[6, 0, []]]") &&
        connectorSource.includes("return { cleared: 0 }"),
    );
    check(
      "the shipment note is posted as an internal note, never an emailing comment",
      connectorSource.includes('"mail.mt_note"'),
    );

    const stubSource = readStripped("scripts/odoo-jsonrpc-stub.ts");
    check(
      "the stub cannot serve a post, a payment registration or an email — reaching for one fails the suite",
      !/method === "action_post"/.test(stubSource) &&
        !/model === "account\.payment\.register"/.test(stubSource) &&
        !/model === "mail\.template"/.test(stubSource),
    );

    const fieldsSource = readStripped("app/services/integrationFields.ts");
    check(
      "the journal setting is kept (dormant), so its stored value survives the draft-only change",
      fieldsSource.includes('name: "ODOO_INVOICE_JOURNAL"'),
    );

    const jobsSource = readStripped("app/services/jobs.server.ts");
    const handlersSource = readStripped("app/services/jobHandlers.server.ts");
    /*
     * THE WIRING IS NOW ASSERTED AS SEVERED, WHICH IS THE SAME COVERAGE READ
     * THE OTHER WAY.
     *
     * The pipeline itself is still exercised above, against the stub — that is
     * why `odooInvoice.server.ts` is kept rather than deleted. What these
     * checks are for is the part that decides whether it ever RUNS, and the
     * answer must now be no from every direction: no enqueue site, no handler
     * that reaches it, no control on the page that asks for it. A suite that
     * only tested the pipeline would stay green while the workflow was quietly
     * reconnected, which is exactly the failure mode this guards.
     */
    check(
      "the ODOO_INVOICE_SYNC handler exists but REFUSES rather than calling the pipeline",
      /\bODOO_INVOICE_SYNC\b/.test(jobsSource) &&
        handlersSource.includes("JOB_KIND.ODOO_INVOICE_SYNC") &&
        !handlersSource.includes("createOdooInvoiceForOrder") &&
        /PermanentJobError/.test(handlersSource),
    );

    const fulfillmentSource = readStripped("app/services/fulfillment.server.ts");
    // Counted as enqueue sites rather than as raw occurrences, because a site
    // would name the kind twice (kind + idempotency key).
    const invoiceEnqueueSites = fulfillmentSource
      .split("enqueueJob(")
      .filter((segment) => segment.includes("ODOO_INVOICE_SYNC")).length;
    check(
      "NO handoff path queues an accounting job",
      invoiceEnqueueSites === 0,
      `${invoiceEnqueueSites} enqueue site(s)`,
    );
    check(
      "…and no handoff path queues an Odoo customer sync either",
      !fulfillmentSource.includes("ODOO_CONTACT_SYNC"),
    );

    const appSource = readStripped("app/services/application.server.ts");
    check(
      "approving, unblocking and reactivating a store queue no Odoo contact sync",
      !appSource.includes("ODOO_CONTACT_SYNC"),
    );

    const routeSource = readStripped("app/routes/admin.orders_.$id.tsx");
    check(
      "the order page no longer offers the manual create/refresh action",
      !routeSource.includes("create_odoo_invoice") &&
        !routeSource.includes("createOdooInvoiceForOrder"),
    );
    check(
      "the order page no longer shows an Odoo invoice panel or links out to Odoo",
      !routeSource.includes("odooInvoiceState") &&
        !routeSource.includes("Open in Odoo") &&
        !routeSource.includes("odooWebBaseUrl"),
    );
    check(
      "the retailer's contact-save no longer queues an Odoo update",
      !readStripped("app/routes/app.settings.jsx").includes("ODOO_CONTACT_SYNC"),
    );
    check(
      "the owner's store page no longer offers a contact-sync button",
      !readStripped("app/routes/admin.stores_.$id.tsx").includes("retry-contact-sync"),
    );
    check(
      "the page no longer claims anything is posted, paid or emailed automatically",
      !routeSource.includes("emailed to the seller") &&
        !routeSource.includes("odooInvoiceEmailSentAt"),
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
