import React from "react";
import { Link, useLoaderData, useActionData, useFetcher, Form } from "react-router";
import {
  withMerchantAccess,
  AccessError,
  requireMerchantAccess,
} from "../services/seller.server";
import { prisma } from "../db.server";
import {
  getBillingSettings,
  listPaymentMethods,
  createSetupSession,
  savePaymentMethodFromSetupIntent,
  updateBillingSettings,
  setDefaultPaymentMethod,
  removePaymentMethod,
} from "../services/sellerBilling.server";
import { isStripeConfigured } from "../services/payments.server";

export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async (context) => {
  // Key presence, from the encrypted credential store or the environment. It is
  // not a claim that the key works — that is the authenticated probe behind
  // Settings' "Connected".
  const stripeConfigured = await isStripeConfigured();
  if (!context.seller) {
    return { access: context.access, settings: null, methods: [], invoices: [], attempts: [], stripe: { configured: stripeConfigured, mode: stripeConfigured ? "real" : "simulated" } };
  }

  const [settings, methods, invoices, attempts] = await Promise.all([
    getBillingSettings(context.seller.id),
    listPaymentMethods(context.seller.id),
    prisma.wholesalePayment.findMany({
      where: { sellerId: context.seller.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        subtotal: true,
        shippingAmount: true,
        taxAmount: true,
        createdAt: true,
        order: { select: { shopifyOrderName: true } },
      },
    }),
    prisma.paymentAttempt.findMany({
      where: { payment: { sellerId: context.seller.id } },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, status: true, failureMessage: true, requiresAction: true, amount: true, createdAt: true },
    }),
  ]);

  return {
    access: context.access,
    settings: {
      mode: settings.mode,
      autoPayEnabled: settings.autoPayEnabled,
      maxAmountPerOrder: settings.maxAmountPerOrder,
      maxShippingCharge: settings.maxShippingCharge,
      preferredShippingPolicy: settings.preferredShippingPolicy,
      holdForReview: settings.holdForReview,
      autoBookShipment: settings.autoBookShipment,
    },
    // Only masked identifiers ever leave the server.
    methods: methods.map((m) => ({
      id: m.id,
      brand: m.brand,
      last4: m.last4,
      expMonth: m.expMonth,
      expYear: m.expYear,
      isDefault: m.isDefault,
      status: m.status,
      authorizedAt: m.authorizationConsentAt,
    })),
    invoices: invoices.map((i) => ({
      id: i.id,
      orderName: i.order?.shopifyOrderName ?? "—",
      amount: i.amount,
      currency: i.currency,
      status: i.status,
      subtotal: i.subtotal,
      shippingAmount: i.shippingAmount,
      taxAmount: i.taxAmount,
      createdAt: i.createdAt,
    })),
    attempts: attempts.map((a) => ({
      id: a.id,
      status: a.status,
      failureMessage: a.failureMessage,
      requiresAction: a.requiresAction,
      amount: a.amount,
      createdAt: a.createdAt,
    })),
    stripe: { configured: stripeConfigured, mode: stripeConfigured ? "real" : "simulated" },
  };
  });

export const action = async ({ request }) => {
  let context;
  try {
    context = await requireMerchantAccess(request, "BUSINESS");
  } catch (error) {
    if (error instanceof AccessError) {
      return { error: error.message };
    }
    throw error;
  }
  if (!context.seller) return { error: "No seller account." };

  const url = new URL(request.url);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "setup") {
      const returnUrl = `${url.origin}/app/billing`;
      const session = await createSetupSession(context.seller.id, returnUrl);
      return { setupUrl: session.url, simulated: session.simulated ?? false };
    }
    if (intent === "save_simulated") {
      // Simulated mode only: a real deployment completes setup via the provider.
      await savePaymentMethodFromSetupIntent(context.seller.id, `sim_${Date.now()}`);
      return { ok: true, message: "Simulated payment method saved (test only, not a real card)." };
    }
    if (intent === "update_settings") {
      const mode = String(form.get("mode") || "MANUAL") === "AUTOMATIC" ? "AUTOMATIC" : "MANUAL";
      await updateBillingSettings(context.seller.id, {
        mode,
        autoPayEnabled: mode === "AUTOMATIC" && form.get("autoPayEnabled") === "on",
        maxAmountPerOrder: form.get("maxAmountPerOrder") ? Math.round(Number(form.get("maxAmountPerOrder")) * 100) : null,
        maxShippingCharge: form.get("maxShippingCharge") ? Math.round(Number(form.get("maxShippingCharge")) * 100) : null,
        preferredShippingPolicy: String(form.get("preferredShippingPolicy") || "") || null,
        holdForReview: form.get("holdForReview") === "on",
        autoBookShipment: form.get("autoBookShipment") === "on",
      });
      return { ok: true, message: "Billing settings saved." };
    }
    if (intent === "set_default") {
      const id = String(form.get("methodId"));
      await setDefaultPaymentMethod(context.seller.id, id, {
        actorId: context.seller.id,
        actorName: context.seller.storeName,
      });
      return { ok: true, message: "Default payment method updated." };
    }
    if (intent === "remove") {
      const id = String(form.get("methodId"));
      await removePaymentMethod(context.seller.id, id, {
        actorId: context.seller.id,
        actorName: context.seller.storeName,
      });
      return { ok: true, message: "Payment method removed." };
    }
    return { error: "Unknown action." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
};

function money(cents, currency = "CAD") {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

const card = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" };
const label = { display: "block", fontSize: "0.72rem", color: "#64748b", marginBottom: "0.25rem" };
const input = { padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.85rem", boxSizing: "border-box" };

export default function BillingPage() {
  const { access, settings, methods, invoices, attempts, stripe } = useLoaderData();
  const actionData = useActionData();
  const setupFetcher = useFetcher();
  const [mode, setMode] = React.useState(settings?.mode ?? "MANUAL");

  React.useEffect(() => {
    const url = setupFetcher.data?.setupUrl;
    if (url && !setupFetcher.data.simulated) window.location.href = url;
  }, [setupFetcher.data]);

  if (!settings) {
    return (
      <s-page heading="Billing & Payment Methods">
        <div className="mv-container">
          <div style={card}>
            <p className="mv-page-subtitle">
              Billing is available after your seller application is approved. Current status: {access}.
            </p>
            <Link className="mv-btn mv-btn-primary" to="/app/status">View application status</Link>
          </div>
        </div>
      </s-page>
    );
  }

  return (
    <s-page heading="Billing & Payment Methods">
      <div className="mv-container">
        <h2 className="mv-page-title">Billing &amp; Payment Methods</h2>
        <p className="mv-page-subtitle" style={{ marginBottom: "1.5rem" }}>
          Pay MoonVella for wholesale orders. Card details are entered on the payment provider&apos;s secure
          page — MoonVella never sees or stores them.
        </p>

        {actionData?.error ? <div style={{ ...card, color: "#991b1b", background: "#fef2f2" }}>{actionData.error}</div> : null}
        {actionData?.message ? <div style={{ ...card, color: "#166534", background: "#f0fdf4" }}>{actionData.message}</div> : null}
        {setupFetcher.data?.simulated ? (
          <div style={{ ...card, background: "#fffbeb", color: "#92400e" }}>
            Simulated setup — the hosted payment setup is not enabled yet. Contact MoonVella to connect a card securely.
          </div>
        ) : null}

        <div style={card}>
          <h3 className="mv-section-title">Payment method</h3>
          <p style={{ fontSize: "0.78rem", color: stripe?.configured ? "#059669" : "#b45309", marginBottom: "0.5rem" }}>
            {stripe?.configured
              ? "Real mode: card setup is handled by Stripe (test key). Card details never reach MoonVella."
              : "Simulated mode: STRIPE_SECRET_KEY is not set. Methods saved here are local test records and are not real cards."}
          </p>
          {methods.length === 0 ? (
            <p className="mv-page-subtitle">No payment method saved yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "0.75rem" }}>
              {methods.map((m) => (
                <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem 0.75rem", fontSize: "0.85rem" }}>
                  <span>
                    {(m.brand || "card").toUpperCase()} •••• {m.last4}
                    {m.expMonth ? ` · ${String(m.expMonth).padStart(2, "0")}/${m.expYear}` : ""}
                    {m.isDefault ? " · default" : ""}
                  </span>
                  <span style={{ display: "flex", gap: "0.4rem" }}>
                    <Link to="#" onClick={(e) => e.preventDefault()} className="mv-btn mv-btn-secondary" style={{ fontSize: "0.7rem", padding: "0.25rem 0.5rem" }}>
                      {m.authorizedAt ? "Authorized" : "Not authorized"}
                    </Link>
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="set_default" />
                      <input type="hidden" name="methodId" value={m.id} />
                      <button type="submit" className="mv-btn mv-btn-secondary" style={{ fontSize: "0.7rem", padding: "0.25rem 0.5rem" }}>Make default</button>
                    </Form>
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="methodId" value={m.id} />
                      <button type="submit" className="mv-btn mv-btn-secondary" style={{ fontSize: "0.7rem", padding: "0.25rem 0.5rem" }}>Remove</button>
                    </Form>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <setupFetcher.Form method="post">
              <input type="hidden" name="intent" value="setup" />
              <button type="submit" className="mv-btn mv-btn-primary" disabled={setupFetcher.state !== "idle"}>
                {setupFetcher.state !== "idle" ? "Opening…" : methods.length ? "Replace payment method" : "Add payment method"}
              </button>
            </setupFetcher.Form>
            {!stripe?.configured ? (
              <Form method="post">
                <input type="hidden" name="intent" value="save_simulated" />
                <button type="submit" className="mv-btn mv-btn-secondary" style={{ fontSize: "0.75rem" }}>Save simulated method (test only)</button>
              </Form>
            ) : null}
          </div>
        </div>

        <div style={card}>
          <h3 className="mv-section-title">Payment mode</h3>
          <Form method="post">
            <input type="hidden" name="intent" value="update_settings" />
            <div className="mv-settings-grid">
              <div>
                <span style={label}>Mode</span>
                <select name="mode" value={mode} onChange={(e) => setMode(e.target.value)} style={input}>
                  <option value="MANUAL">Manual — I approve and pay each order</option>
                  <option value="AUTOMATIC">Automatic — charge within my authorization</option>
                </select>
              </div>
              {mode === "AUTOMATIC" && (
                <>
                  <div>
                    <span style={label}>Authorize automatic payment</span>
                    <label className="mv-settings-checkbox">
                      <input type="checkbox" name="autoPayEnabled" defaultChecked={settings.autoPayEnabled} />
                      <span>I authorize MoonVella to charge my saved method for wholesale orders</span>
                    </label>
                  </div>
                  <div>
                    <span style={label}>Max total per order (CAD)</span>
                    <input style={input} name="maxAmountPerOrder" type="number" min="0" step="0.01" defaultValue={settings.maxAmountPerOrder ? settings.maxAmountPerOrder / 100 : ""} />
                  </div>
                  <div>
                    <span style={label}>Max shipping per order (CAD)</span>
                    <input style={input} name="maxShippingCharge" type="number" min="0" step="0.01" defaultValue={settings.maxShippingCharge ? settings.maxShippingCharge / 100 : ""} />
                  </div>
                  <div>
                    <span style={label}>Preferred shipping policy</span>
                    <select name="preferredShippingPolicy" defaultValue={settings.preferredShippingPolicy ?? "cheapest"} style={input}>
                      <option value="cheapest">Cheapest eligible</option>
                      <option value="fastest">Fastest with known estimate</option>
                      <option value="manual">Always wait for owner selection</option>
                    </select>
                  </div>
                  <div>
                    <span style={label}>Hold for review when limits exceeded</span>
                    <label className="mv-settings-checkbox">
                      <input type="checkbox" name="holdForReview" defaultChecked={settings.holdForReview} />
                      <span>Hold the order for owner review</span>
                    </label>
                  </div>
                  <div>
                    <span style={label}>Automatic shipment booking (separate)</span>
                    <label className="mv-settings-checkbox">
                      <input type="checkbox" name="autoBookShipment" defaultChecked={settings.autoBookShipment} />
                      <span>Let MoonVella book the shipment automatically after payment</span>
                    </label>
                  </div>
                </>
              )}
            </div>
            <button type="submit" className="mv-btn mv-btn-primary" style={{ marginTop: "0.75rem" }}>Save settings</button>
          </Form>
        </div>

        <div style={card}>
          <h3 className="mv-section-title">Invoices &amp; payment attempts</h3>
          {invoices.length === 0 ? (
            <p className="mv-page-subtitle">No wholesale invoices yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.7rem" }}>
                  <th style={{ padding: "0.4rem" }}>Order</th>
                  <th style={{ padding: "0.4rem" }}>Subtotal</th>
                  <th style={{ padding: "0.4rem" }}>Shipping</th>
                  <th style={{ padding: "0.4rem" }}>Tax</th>
                  <th style={{ padding: "0.4rem" }}>Total</th>
                  <th style={{ padding: "0.4rem" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.4rem" }}>{i.orderName}</td>
                    <td style={{ padding: "0.4rem" }}>{i.subtotal != null ? money(i.subtotal, i.currency) : "—"}</td>
                    <td style={{ padding: "0.4rem" }}>{i.shippingAmount != null ? money(i.shippingAmount, i.currency) : "—"}</td>
                    <td style={{ padding: "0.4rem" }}>{i.taxAmount != null ? money(i.taxAmount, i.currency) : "—"}</td>
                    <td style={{ padding: "0.4rem", fontWeight: 600 }}>{money(i.amount, i.currency)}</td>
                    <td style={{ padding: "0.4rem", color: i.status === "SUCCEEDED" ? "#059669" : i.status === "FAILED" ? "#dc2626" : "#b45309" }}>{i.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {attempts.some((a) => a.status === "FAILED" || a.requiresAction) && (
            <div style={{ marginTop: "0.75rem", fontSize: "0.8rem" }}>
              {attempts
                .filter((a) => a.status === "FAILED" || a.requiresAction)
                .map((a) => (
                  <p key={a.id} style={{ color: a.requiresAction ? "#b45309" : "#dc2626", margin: "0.2rem 0" }}>
                    {a.requiresAction ? "Payment action required" : "Payment failed"}: {a.failureMessage || "complete authentication"} ({money(a.amount)})
                  </p>
                ))}
            </div>
          )}
        </div>

        <p style={{ fontSize: "0.72rem", color: "#64748b" }}>
          MoonVella&apos;s provider credentials and webhook secrets are server-side only and are never shown here.
        </p>
      </div>
    </s-page>
  );
}
