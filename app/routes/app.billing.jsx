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
import { shopifyAdminAppUrl } from "../services/shopifyNavigation.server";
import { useCurrency } from "../components/CurrencyDisplay";

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
      // The order/shipping maximums and "hold for review" are retired; the
      // seller page no longer receives them.
      // `preferredShippingPolicy` and `autoBookShipment` are NOT sent to the
      // seller page any more. Cartier and service selection and shipment booking
      // are MoonVella's decisions, made in the operator panel; a merchant form
      // must not be able to state a preference for either, and the quickest way
      // to be sure of that is not to put the values in front of the form at all.
      // The columns remain on the row for the history that is already in them.
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

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "setup") {
      /*
       * The seller leaves the admin entirely to pay, so the address they come
       * back to has to put them into it again — see `shopifyAdminAppUrl`. A
       * return to this origin would be a bare top-level document with no frame
       * context, which is the dead end this codebase has already fixed once.
       */
      const returnUrl = shopifyAdminAppUrl(context.shop, "/app/billing", request);
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

const card = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.5rem", marginBottom: "1.5rem" };
const label = { display: "block", fontSize: "0.72rem", color: "#64748b", marginBottom: "0.25rem" };
const input = { padding: "0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.85rem", boxSizing: "border-box" };

export default function BillingPage() {
  const { access, settings, methods, invoices, attempts, stripe } = useLoaderData();
  const { format } = useCurrency();
  // An invoice's own currency is printed, and only Canadian amounts are
  // converted — the same rule the order history applies, for the same reason.
  const money = (cents, code) =>
    !code || code === "CAD" ? format(cents) : `${(cents / 100).toFixed(2)} ${code}`;
  const actionData = useActionData();
  const setupFetcher = useFetcher();
  const [mode, setMode] = React.useState(settings?.mode ?? "MANUAL");

  React.useEffect(() => {
    const url = setupFetcher.data?.setupUrl;
    if (!url || setupFetcher.data?.simulated) return;
    /*
     * THE TOP WINDOW, NEVER THIS ONE, AND THAT IS THE WHOLE BUG THIS REPLACES.
     *
     * This used to be `window.location.href = url`, which navigates the FRAME.
     * Stripe refuses to render Checkout in an iframe — "Stripe Checkout is not
     * able to run in an iFrame. Please redirect to Checkout at the top level."
     * — so the seller pressed Add payment method and the app's own panel went
     * blank, with the refusal in a console they had no reason to open.
     *
     * `_top` is a named, already-existing browsing context rather than a new
     * popup, so this is a navigation and not something a popup blocker is
     * entitled to swallow. It is also the one navigation this app is allowed to
     * make out of the frame, and it is deliberate: the card is entered on
     * Stripe's page, never on ours.
     */
    window.open(url, "_top");
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
                    <span
                      className={`mv-badge ${m.authorizedAt ? "mv-badge-success" : ""}`}
                      title={m.authorizedAt ? "This card is authorised for automatic charges." : "Not authorised for automatic charges."}
                    >
                      {m.authorizedAt ? "Authorized" : "Not authorized"}
                    </span>
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
              {/*
                TWO MODES, CHOSEN AS CARDS RATHER THAN A DROPDOWN.

                A select hides the choice that matters most on this page behind a
                click, and the two options are not a preference — they change when
                money leaves the seller's account. Cards keep both consequences on
                screen while the choice is made, which is the whole point of the
                helper text inside them.
              */}
              <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "0.75rem" }}>
                {[
                  {
                    value: "AUTOMATIC",
                    title: "Automatic payment",
                    body:
                      "MoonVella will automatically charge your saved payment method when an eligible " +
                      "MoonVella order is received. Fulfillment begins after payment succeeds. If payment " +
                      "fails, the order will remain awaiting payment and you will be notified.",
                  },
                  {
                    value: "MANUAL",
                    title: "Manual payment",
                    body:
                      "MoonVella will not charge you automatically. When a MoonVella order is received, " +
                      "open the order and select “Pay now.” MoonVella will begin fulfillment only after " +
                      "payment is completed.",
                  },
                ].map((option) => {
                  const selected = mode === option.value;
                  return (
                    <label
                      key={option.value}
                      style={{
                        display: "block",
                        border: `1px solid ${selected ? "#006E67" : "#DCE3EB"}`,
                        background: selected ? "#F0FAF8" : "#FFFFFF",
                        borderRadius: 12,
                        padding: "0.85rem 0.95rem",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600 }}>
                        <input
                          type="radio"
                          name="mode"
                          value={option.value}
                          checked={selected}
                          onChange={(e) => setMode(e.target.value)}
                        />
                        {option.title}
                      </span>
                      <span style={{ display: "block", marginTop: "0.4rem", fontSize: "0.8rem", color: "#52627A", lineHeight: 1.55 }}>
                        {option.body}
                      </span>
                    </label>
                  );
                })}
              </div>
              {mode === "AUTOMATIC" && (
                <>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <span style={label}>Authorisation</span>
                    <label className="mv-settings-checkbox">
                      <input type="checkbox" name="autoPayEnabled" defaultChecked={settings.autoPayEnabled} />
                      <span>
                        I authorize MoonVella to charge my saved payment method for eligible MoonVella
                        product orders.
                      </span>
                    </label>
                    <p style={{ fontSize: "0.78rem", color: "#52627A", margin: "0.35rem 0 0" }}>
                      Required for automatic payment. If a charge fails, the order stays{" "}
                      <strong>Awaiting payment</strong> and you will be notified — MoonVella does not retry
                      silently, and fulfilment does not begin. You can also pay any order by hand with{" "}
                      <strong>Pay now</strong>, whether this mode is Automatic or Manual.
                    </p>
                  </div>
                  {/*
                    THE THREE LIMIT SETTINGS ARE GONE, and the reason is a single
                    fact: shipping is inside MoonVella's partner price. A
                    "maximum shipping charge" therefore capped a cost that no
                    bill contains, and in practice never held anything because
                    the figure it compared against was not recorded. With no
                    shipping maximum and no per-order maximum there is nothing
                    left for "hold for review when limits are exceeded" to mean.

                    Automatic payment is now a single decision: either the seller
                    has authorised charges on the saved method, or they pay each
                    order by hand.
                  */}
                  {/*
                    THE SHIPPING CONTROLS USED TO BE HERE: a preferred-service
                    policy and a separate "book the shipment automatically after
                    payment" switch.

                    They are gone because they were never the seller's to decide.
                    Which carrier and service an order ships on, and whether a
                    label is bought at all, are MoonVella's operational
                    decisions — and offering them as merchant preferences split
                    one decision across two panels, with the seller's copy
                    sitting behind a payment setting that reads as if paying
                    authorises shipping. Authorising a charge is not authorising
                    a purchase from a carrier.

                    Nothing is left behind that a merchant can reach: the two
                    fields are not rendered, not posted, and not accepted by the
                    service behind this form.
                  */}
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
