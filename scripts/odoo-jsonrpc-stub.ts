/**
 * A deterministic Odoo, in-process, for the handoff-invoice suite.
 *
 * The pipeline under test is a chain of guarded writes against a real ERP:
 * partner → sale order → invoice → post → payment → email. Pointing a
 * verification run at a real Odoo would be a live write to live books, so this
 * suite installs this instead. It wraps `globalThis.fetch`, answers Odoo's
 * JSON-RPC endpoint itself, and DELIBERATELY delegates every other URL to the
 * fetch it replaced — which in this suite is the provider guard, so Stripe,
 * eShipper and Google remain refused rather than stubbed.
 *
 * Two properties matter more than breadth of fidelity:
 *
 * - **A call the stub does not model is an ERROR, not a guess.** The stub knows
 *   the exact set of model.method pairs this pipeline may use. Anything else
 *   answers with a JSON-RPC error envelope, so a call the pipeline should not
 *   be making fails the suite loudly. There is no "return something plausible"
 *   branch anywhere below.
 * - **The invoice total is COMPUTED from the sale-order lines the pipeline
 *   sent**, exactly as Odoo computes it, rather than being a fixed number. That
 *   makes the pipeline's own money gate — invoice total vs the captured Stripe
 *   amount — load-bearing inside the suite: lines built from the wrong numbers
 *   fail the run instead of being papered over by the stub.
 *
 * The call log records method args as Odoo receives them (for `execute_kw`,
 * that is the args list after database/uid/api-key), so the suite asserts the
 * payloads — the template id, the journal, the mail arguments — and not only
 * the outcomes.
 *
 * This file is verification scaffolding. Nothing in `app/` imports it.
 */

/** The methods the connector may call without a write permit. Mirrors its own
 * allowlist; a local copy so the stub can tell reads from writes without
 * importing the module under test. */
const READ_METHODS = new Set([
  "search_read",
  "search_count",
  "search",
  "read",
  "fields_get",
  "name_get",
  "name_search",
]);

export interface OdooStubCall {
  url: string;
  service: "common" | "object";
  /** Model name for object calls; null for common (authenticate/version). */
  model: string | null;
  method: string;
  /** The method's positional args, as Odoo receives them. */
  args: unknown[];
  kwargs: Record<string, unknown>;
}

export interface OdooStubScenario {
  /** Whether the billing-email lookup finds an existing contact. */
  partner?: "none" | "existing";
  /** Per-SKU product-catalogue facts. Defaults: every SKU resolves, policy "order". */
  products?: {
    missing?: string[];
    ambiguous?: string[];
    deliveryPolicy?: string[];
  };
  /** The "MoonVella B2B Wholesale" quotation template. */
  template?: "ok" | "missing" | "unstamped" | "ambiguous";
  /** The branded invoice mail template. */
  mailTemplate?: "ok" | "missing" | "wrong-model" | "ambiguous";
  /** The payment journal named by the settings/default. */
  journal?: "ok" | "none" | "ambiguous";
  /** A sale order already carrying the order's reference (the crash-recovery path). */
  existingSaleOrder?: {
    id: number;
    state: string;
    clientOrderRef: string;
    partnerId?: number;
    partnerName?: string;
    lines?: { productId: number; quantity: number; priceUnit: number }[];
  } | null;
  /** An invoice the order row already links to (the email-resume path). */
  existingInvoice?: {
    id: number;
    state: string;
    paymentState?: string | false;
    name?: string | false;
    amountTotal: number;
    amountResidual?: number;
    currency?: string;
    companyId?: number;
  } | null;
}

export interface OdooJsonRpcStub {
  calls: OdooStubCall[];
  /** Mutable, so a scenario can be repaired mid-suite (a missing journal created). */
  scenario: OdooStubScenario;
  callsTo(model: string, method: string): OdooStubCall[];
  writes(): OdooStubCall[];
  restore(): void;
}

const COMPANY: [number, string] = [1, "PremaFirm Inc."];
const CURRENCY: [number, string] = [1, "CAD"];

interface StoredSaleOrder {
  id: number;
  name: string;
  state: string;
  client_order_ref: string | false;
  partner_id: [number, string] | false;
  companyId: number;
  lines: { productId: number; quantity: number; priceUnit: number }[];
}

interface StoredInvoice {
  id: number;
  name: string | false;
  state: string;
  payment_state: string | false;
  amount_total: number;
  amount_residual: number;
  invoice_origin: string | false;
  saleOrderId: number | null;
  currency: string;
  companyId: number;
}

/** The `=` value of the first domain clause on `field`, whatever the operator. */
function predicateValue(domain: unknown, field: string): unknown {
  if (!Array.isArray(domain)) return undefined;
  for (const clause of domain) {
    if (Array.isArray(clause) && clause[0] === field) return clause[2];
  }
  return undefined;
}

function applyLimit<T>(rows: T[], limit: unknown): T[] {
  return typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
}

export function installOdooJsonRpcStub(scenario: OdooStubScenario = {}): OdooJsonRpcStub {
  const calls: OdooStubCall[] = [];
  const real = globalThis.fetch;

  const productIdBySku = new Map<string, number>();
  /** Names for partners the stub itself created, so sale orders show a name. */
  const partnerNames = new Map<number, string>();
  const saleOrders = new Map<number, StoredSaleOrder>();
  const saleOrderIdByRef = new Map<string, number>();
  const invoices = new Map<number, StoredInvoice>();
  /** Wizard id → the sale order it will invoice. */
  const invoiceWizards = new Map<number, number>();
  /** Wizard id → the invoice it will pay. */
  const paymentWizards = new Map<number, number>();

  let nextProductId = 300;
  let nextSaleOrderId = 900;
  let nextInvoiceId = 1001;
  let nextWizardId = 550;
  let nextPaymentWizardId = 600;
  let nextPartnerId = 700;
  let nextMailId = 990;
  let postedCount = 0;

  const productIdFor = (sku: string): number => {
    const existing = productIdBySku.get(sku);
    if (existing !== undefined) return existing;
    const id = nextProductId++;
    productIdBySku.set(sku, id);
    return id;
  };

  if (scenario.existingSaleOrder) {
    const seed = scenario.existingSaleOrder;
    saleOrders.set(seed.id, {
      id: seed.id,
      name: `S0${seed.id}`,
      state: seed.state,
      client_order_ref: seed.clientOrderRef,
      partner_id: [seed.partnerId ?? 705, seed.partnerName ?? "Reused Verify Customer"],
      companyId: 1,
      lines: seed.lines ?? [],
    });
    saleOrderIdByRef.set(seed.clientOrderRef, seed.id);
  }

  if (scenario.existingInvoice) {
    const seed = scenario.existingInvoice;
    invoices.set(seed.id, {
      id: seed.id,
      name: seed.name ?? `INV/2026/${String(seed.id).padStart(5, "0")}`,
      state: seed.state,
      payment_state: seed.paymentState ?? false,
      amount_total: seed.amountTotal,
      amount_residual: seed.amountResidual ?? seed.amountTotal,
      invoice_origin: false,
      saleOrderId: null,
      currency: seed.currency ?? "CAD",
      companyId: seed.companyId ?? 1,
    });
  }

  function invoiceRow(invoice: StoredInvoice): Record<string, unknown> {
    return {
      id: invoice.id,
      name: invoice.name,
      state: invoice.state,
      payment_state: invoice.payment_state,
      amount_total: invoice.amount_total,
      amount_residual: invoice.amount_residual,
      invoice_origin: invoice.invoice_origin,
      currency_id: CURRENCY,
      company_id: COMPANY,
    };
  }

  function saleOrderRow(order: StoredSaleOrder): Record<string, unknown> {
    return {
      id: order.id,
      name: order.name,
      state: order.state,
      client_order_ref: order.client_order_ref,
      partner_id: order.partner_id,
      company_id: COMPANY,
    };
  }

  /** Odoo's own arithmetic: the invoice totals the order's lines. */
  function totalOf(order: StoredSaleOrder | undefined): number {
    const sum = (order?.lines ?? []).reduce(
      (acc, line) => acc + line.quantity * line.priceUnit,
      0,
    );
    return Math.round(sum * 100) / 100;
  }

  function createInvoiceForSaleOrder(saleOrderId: number): number {
    const order = saleOrders.get(saleOrderId);
    const total = totalOf(order);
    const id = nextInvoiceId++;
    invoices.set(id, {
      id,
      name: false,
      state: "draft",
      payment_state: false,
      amount_total: total,
      amount_residual: total,
      invoice_origin: order?.name ?? false,
      saleOrderId,
      currency: "CAD",
      companyId: order?.companyId ?? 1,
    });
    return id;
  }

  /** The stub's answer to one execute_kw, before it becomes an envelope. */
  function respondObject(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): { result?: unknown; error?: string } {
    if (method === "search_read") {
      const domain = args[0];
      const limit = kwargs.limit;

      if (model === "res.partner") {
        const email = predicateValue(domain, "email");
        if (scenario.partner === "existing") {
          return {
            result: applyLimit(
              [{ id: 700, name: "Existing Verify Customer", email }],
              limit,
            ),
          };
        }
        return { result: [] };
      }

      if (model === "res.partner.category") {
        return {
          result: applyLimit(
            [{ id: 248, name: predicateValue(domain, "name") ?? "Moonvella app" }],
            limit,
          ),
        };
      }

      if (model === "product.product") {
        const codes = predicateValue(domain, "default_code");
        const list = Array.isArray(codes) ? codes.filter((c): c is string => typeof c === "string") : [];
        const facts = scenario.products ?? {};
        const rows: unknown[] = [];
        for (const code of list) {
          if (facts.missing?.includes(code)) continue;
          const id = productIdFor(code);
          const invoice_policy = facts.deliveryPolicy?.includes(code) ? "delivery" : "order";
          rows.push({ id, default_code: code, name: `Verify product ${code}`, invoice_policy });
          if (facts.ambiguous?.includes(code)) {
            rows.push({ id: id + 10000, default_code: code, name: `Verify product ${code} (duplicate)`, invoice_policy });
          }
        }
        return { result: applyLimit(rows, limit) };
      }

      if (model === "sale.order.template") {
        const name = predicateValue(domain, "name");
        const row = (id: number, brand: string | false, channel: string | false) => ({
          id,
          name,
          company_id: COMPANY,
          prema_operating_brand: brand,
          prema_sales_channel: channel,
        });
        if (scenario.template === "missing") return { result: [] };
        if (scenario.template === "unstamped") return { result: [row(5, false, false)] };
        if (scenario.template === "ambiguous") {
          return { result: [row(5, "moonvella", "direct_b2b"), row(6, "moonvella", "direct_b2b")] };
        }
        return { result: [row(5, "moonvella", "direct_b2b")] };
      }

      if (model === "sale.order") {
        const byId = predicateValue(domain, "id");
        if (typeof byId === "number") {
          const order = saleOrders.get(byId);
          return { result: order ? [saleOrderRow(order)] : [] };
        }
        const ref = predicateValue(domain, "client_order_ref");
        const id = typeof ref === "string" ? saleOrderIdByRef.get(ref) : undefined;
        const order = id === undefined ? undefined : saleOrders.get(id);
        return { result: applyLimit(order ? [saleOrderRow(order)] : [], limit) };
      }

      if (model === "account.move") {
        const invoiceId = predicateValue(domain, "id");
        if (typeof invoiceId === "number") {
          const invoice = invoices.get(invoiceId);
          return { result: invoice ? [invoiceRow(invoice)] : [] };
        }
        const saleOrderId = predicateValue(domain, "line_ids.sale_line_ids.order_id");
        const companyId = predicateValue(domain, "company_id");
        const rows = [...invoices.values()]
          .filter((invoice) => invoice.saleOrderId === saleOrderId)
          .filter((invoice) => typeof companyId !== "number" || invoice.companyId === companyId)
          .sort((a, b) => a.id - b.id)
          .map(invoiceRow);
        return { result: applyLimit(rows, limit) };
      }

      if (model === "account.journal") {
        const name = predicateValue(domain, "name");
        const row = (id: number) => ({ id, name, type: "bank", company_id: COMPANY });
        if (scenario.journal === "none") return { result: [] };
        if (scenario.journal === "ambiguous") return { result: [row(77), row(78)] };
        return { result: [row(77)] };
      }

      if (model === "mail.template") {
        const name = predicateValue(domain, "name");
        if (scenario.mailTemplate === "missing") return { result: [] };
        if (scenario.mailTemplate === "wrong-model") {
          return { result: [{ id: 88, name, model_id: [3, "res.partner"] }] };
        }
        if (scenario.mailTemplate === "ambiguous") {
          return {
            result: [
              { id: 88, name, model_id: [2, "account.move"] },
              { id: 89, name, model_id: [2, "account.move"] },
            ],
          };
        }
        return { result: [{ id: 88, name, model_id: [2, "account.move"] }] };
      }
    }

    if (model === "res.partner" && method === "create") {
      const values = (args[0] ?? {}) as Record<string, unknown>;
      const id = nextPartnerId++;
      partnerNames.set(id, typeof values.name === "string" ? values.name : "Unnamed");
      return { result: id };
    }

    if (model === "sale.order" && method === "create") {
      const values = (args[0] ?? {}) as Record<string, unknown>;
      const id = nextSaleOrderId++;
      const rawLines = Array.isArray(values.order_line) ? values.order_line : [];
      const lines = rawLines.map((entry) => {
        const triple = Array.isArray(entry) ? (entry[2] as Record<string, unknown>) : {};
        return {
          productId: typeof triple.product_id === "number" ? triple.product_id : 0,
          quantity: typeof triple.product_uom_qty === "number" ? triple.product_uom_qty : 0,
          priceUnit: typeof triple.price_unit === "number" ? triple.price_unit : 0,
        };
      });
      const partnerId = typeof values.partner_id === "number" ? values.partner_id : 0;
      const order: StoredSaleOrder = {
        id,
        name: `S0${id}`,
        state: "draft",
        client_order_ref:
          typeof values.client_order_ref === "string" ? values.client_order_ref : false,
        partner_id: [partnerId, partnerNames.get(partnerId) ?? "Unnamed"],
        companyId: 1,
        lines,
      };
      saleOrders.set(id, order);
      if (typeof order.client_order_ref === "string") {
        saleOrderIdByRef.set(order.client_order_ref, id);
      }
      return { result: id };
    }

    if (model === "sale.order" && method === "action_confirm") {
      const id = Array.isArray(args[0]) ? (args[0][0] as number) : NaN;
      const order = saleOrders.get(id);
      if (!order) return { error: `The stub has no sale order ${String(id)} to confirm.` };
      order.state = "sale";
      return { result: true };
    }

    if (model === "sale.advance.payment.inv" && method === "create") {
      const context = (kwargs.context ?? {}) as { active_ids?: unknown };
      const saleOrderId = Array.isArray(context.active_ids)
        ? (context.active_ids[0] as number)
        : NaN;
      if (!Number.isFinite(saleOrderId)) {
        return { error: "The invoice wizard was created without active_ids in its context." };
      }
      const wizardId = nextWizardId++;
      invoiceWizards.set(wizardId, saleOrderId);
      return { result: wizardId };
    }

    if (model === "sale.advance.payment.inv" && method === "create_invoices") {
      const wizardId = Array.isArray(args[0]) ? (args[0][0] as number) : NaN;
      const saleOrderId = invoiceWizards.get(wizardId);
      if (saleOrderId === undefined) {
        return { error: `The stub has no invoice wizard ${String(wizardId)}.` };
      }
      createInvoiceForSaleOrder(saleOrderId);
      return { result: true };
    }

    if (model === "account.move" && method === "action_post") {
      const id = Array.isArray(args[0]) ? (args[0][0] as number) : NaN;
      const invoice = invoices.get(id);
      if (!invoice) return { error: `The stub has no invoice ${String(id)} to post.` };
      invoice.state = "posted";
      postedCount += 1;
      invoice.name = `INV/2026/${String(postedCount).padStart(5, "0")}`;
      return { result: true };
    }

    if (model === "account.payment.register" && method === "create") {
      const context = (kwargs.context ?? {}) as { active_ids?: unknown };
      const invoiceId = Array.isArray(context.active_ids)
        ? (context.active_ids[0] as number)
        : NaN;
      if (!invoices.has(invoiceId)) {
        return { error: `The payment wizard names invoice ${String(invoiceId)}, which the stub does not have.` };
      }
      const wizardId = nextPaymentWizardId++;
      paymentWizards.set(wizardId, invoiceId);
      return { result: wizardId };
    }

    if (model === "account.payment.register" && method === "action_create_payments") {
      const wizardId = Array.isArray(args[0]) ? (args[0][0] as number) : NaN;
      const invoiceId = paymentWizards.get(wizardId);
      if (invoiceId === undefined) {
        return { error: `The stub has no payment wizard ${String(wizardId)}.` };
      }
      const invoice = invoices.get(invoiceId);
      if (!invoice) return { error: `The stub has no invoice ${String(invoiceId)}.` };
      invoice.payment_state = "paid";
      invoice.amount_residual = 0;
      return { result: true };
    }

    if (model === "mail.template" && method === "send_mail") {
      const templateIds = Array.isArray(args[0]) ? args[0] : [];
      const invoiceId = args[1];
      if (templateIds.length !== 1 || typeof invoiceId !== "number") {
        return {
          error:
            "The stub only models the record-method shape send_mail([[templateId]], resId); " +
            `it received ${JSON.stringify(args)}.`,
        };
      }
      return { result: nextMailId++ };
    }

    return {
      error:
        `The Odoo stub does not model ${model}.${method}. This suite answers only the calls the ` +
        `handoff-invoice pipeline is known to make; an unmodelled call is either a new call that ` +
        `needs a deliberate answer here, or a call this pipeline should not be making.`,
    };
  }

  function respond(
    request: { params: { service: string; method: string; args: unknown[] } },
  ): { result?: unknown; error?: string } {
    const { service, method, args } = request.params;

    if (service === "common" && method === "authenticate") {
      return { result: 2 };
    }
    if (service === "common" && method === "version") {
      return { result: { server_version: "18.0" } };
    }

    if (service === "object" && method === "execute_kw") {
      const model = args[3];
      const objectMethod = args[4];
      const methodArgs = Array.isArray(args[5]) ? (args[5] as unknown[]) : [];
      const kwargs = (args[6] ?? {}) as Record<string, unknown>;
      if (typeof model !== "string" || typeof objectMethod !== "string") {
        return { error: "execute_kw arrived without a model name or method name." };
      }
      return respondObject(model, objectMethod, methodArgs, kwargs);
    }

    return {
      error: `The Odoo stub does not model ${service}.${method}.`,
    };
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url ?? "");

    if (!url.includes("/jsonrpc")) {
      // Anything that is not Odoo's RPC endpoint belongs to the fetch this stub
      // replaced — in this suite, the provider guard. Delegating (rather than
      // answering) is what keeps Stripe refused while Odoo is stubbed.
      return real(input as never, init);
    }

    const request = JSON.parse(String(init?.body ?? "{}")) as {
      id: number;
      params: { service: string; method: string; args: unknown[] };
    };

    const { service, method, args } = request.params;
    const model = service === "object" ? (args[3] as string) : null;
    const objectMethod = service === "object" ? (args[4] as string) : method;

    calls.push({
      url,
      service: service === "common" ? "common" : "object",
      model: typeof model === "string" ? model : null,
      method: typeof objectMethod === "string" ? objectMethod : method,
      args: service === "object" && Array.isArray(args[5]) ? (args[5] as unknown[]) : args,
      kwargs: service === "object" ? ((args[6] ?? {}) as Record<string, unknown>) : {},
    });

    const outcome = respond(request);
    const body =
      outcome.error === undefined
        ? { jsonrpc: "2.0", id: request.id, result: outcome.result }
        : {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: 200,
              message: "Odoo Server Error",
              data: { message: outcome.error },
            },
          };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    scenario,
    callsTo: (model, method) =>
      calls.filter((call) => call.model === model && call.method === method),
    writes: () =>
      calls.filter(
        (call) => call.service === "object" && !READ_METHODS.has(call.method),
      ),
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** Whether a recorded call is a write. Exported for assertions that need to
 * describe a call rather than just count it. */
export function isOdooWrite(call: OdooStubCall): boolean {
  return call.service === "object" && !READ_METHODS.has(call.method);
}
