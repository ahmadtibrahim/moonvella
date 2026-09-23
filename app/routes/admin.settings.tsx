import React from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  requireAuth,
  userCan,
  assertSameOrigin,
  getRequestMeta,
  getSessionToken,
} from "~/utils/adminAuth.server";
import { permissionsFor } from "~/services/permissions";
import { changeOwnPassword } from "~/services/adminUsers.server";
import {
  listIntegrationStates,
  refreshIntegration,
  clearIntegrationError,
  saveIntegrationCredentials,
  disconnectIntegration,
  CREDENTIAL_KEYS,
  OPERATIONAL_KEYS,
  INTEGRATION_KEYS,
  type IntegrationKey,
  // A type-only specifier: erased at build time, so this module is named in one
  // import statement while its server code still never reaches the client.
  type IntegrationStateView,
} from "~/services/integrationHealth.server";
// Isomorphic on purpose: field definitions only, no server imports, so the form
// and the store validate against the same list instead of two that drift.
import {
  CREDENTIAL_INTEGRATIONS,
  type CredentialKey,
  type CredentialOption,
} from "~/services/integrationFields";
// Server-only, and used only to READ the choices a picker offers. Nothing it
// returns is a credential, and a failure to read it falls back to the plain
// text field rather than failing the page.
import { listOdooPricelists } from "~/services/odoo.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Any signed-in user: everyone needs to be able to change their own password.
  const user = await requireAuth(request);

  // The integration panel is operational configuration, not account settings,
  // so it is gated separately. Someone without the permission never receives the
  // data — the section is absent from the payload, not merely hidden.
  const canSeeIntegrations = userCan(user, "settings.general");

  // Grouped here, on the server, so the page renders two sections without the
  // client bundle ever reaching into this server-only module for the key lists.
  // Credentials are configured with secrets; operational checks report whether
  // the Shopify scopes the connected app depends on are granted.
  const states = canSeeIntegrations ? await listIntegrationStates() : [];
  const credentialKeys = CREDENTIAL_KEYS as string[];
  const operationalKeys = OPERATIONAL_KEYS as string[];

  /*
   * A FEW FIELDS CHOOSE FROM WHAT THE PROVIDER ACTUALLY HOLDS. The wholesale
   * pricelist is one: it can be typed as a name or an id, but a list read from
   * Odoo is what stops a typo becoming a price list nobody can find.
   *
   * Read only when the Odoo integration ALREADY reports HEALTHY. Asking an
   * unreachable Odoo would stall this page for the length of the connector's
   * timeout to learn what the tile above already says, and the field falls back
   * to text input either way — which accepts exactly what the picker offers.
   */
  const odooHealthy = states.some((state) => state.key === "odoo" && state.status === "HEALTHY");
  const pricelists =
    canSeeIntegrations && odooHealthy ? await listOdooPricelists() : null;

  // Keyed by field, because an integration may later offer a picker for more
  // than one of its fields.
  const runtimeOptions: Record<string, CredentialOption[]> = {};
  if (pricelists?.length) {
    runtimeOptions["odoo:ODOO_WHOLESALE_PRICELIST"] = pricelists.map((row) => ({
      value: String(row.id),
      label: `${row.name} (id ${row.id})`,
    }));
  }

  return {
    runtimeOptions,
    user: {
      name: user.name,
      email: user.email,
      role: user.role,
      isPrimaryOwner: user.isPrimaryOwner,
      lastLoginAt: user.lastLoginAt,
      mustChangePassword: user.mustChangePassword,
    },
    permissions: [...permissionsFor(user.role)].sort(),
    canSeeIntegrations,
    credentialIntegrations: states.filter((s) => credentialKeys.includes(s.key)),
    operationalIntegrations: states.filter((s) => operationalKeys.includes(s.key)),
  };
}

function isIntegrationKey(value: string): value is IntegrationKey {
  return (INTEGRATION_KEYS as string[]).includes(value);
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requireAuth(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "change_password");
  const { ip, userAgent } = getRequestMeta(request);

  if (intent === "refresh_integration" || intent === "clear_integration_error" || intent === "save_credentials" || intent === "disconnect_integration") {
    if (!userCan(user, "settings.general")) {
      throw new Response("Your role does not permit this.", { status: 403 });
    }

    const key = String(formData.get("key") || "");
    if (!isIntegrationKey(key)) return { error: "Unknown integration." };

    const auditActor = {
      actorType: "ADMIN_USER" as const,
      actorId: user.id,
      actorName: user.name,
      ipAddress: ip,
      userAgent,
    };

    if (intent === "refresh_integration") {
      const state = await refreshIntegration(key, auditActor);
      return { success: `${key} re-checked: ${state.status}.` };
    }

    if (intent === "clear_integration_error") {
      await clearIntegrationError(key, auditActor);
      return { success: `${key} error cleared.` };
    }

    if (intent === "save_credentials") {
      // The values are forwarded to the store, which encrypts them before they
      // reach the database. Only field NAMES are ever audited: a credential
      // value must not appear in the audit log, in a response, or in an error.
      const submitted = Object.fromEntries(
        [...formData.entries()]
          .filter(([field]) => String(field).startsWith("secret_"))
          .map(([field, value]) => [String(field).slice("secret_".length), String(value)])
      );
      try {
        const state = await saveIntegrationCredentials(key, submitted, auditActor);
        return { success: `${key} credentials saved and re-checked: ${state.status}.` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Could not save credentials." };
      }
    }

    if (intent === "disconnect_integration") {
      try {
        await disconnectIntegration(key, auditActor);
        return { success: `${key} disconnected. Provider operations are disabled.` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Could not disconnect." };
      }
    }
  }

  const currentPassword = String(formData.get("currentPassword") || "");
  const newPassword = String(formData.get("newPassword") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (!currentPassword || !newPassword) {
    return { error: "All password fields are required." };
  }
  if (newPassword !== confirmPassword) {
    return { error: "New passwords do not match." };
  }

  const result = await changeOwnPassword(
    { id: user.id, name: user.name },
    currentPassword,
    newPassword,
    getSessionToken(request),
    { ip, userAgent }
  );

  if (!result.ok) return { error: result.error };

  return { success: result.message || "Password changed." };
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "2rem",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  color: "#64748b",
  marginBottom: "0.25rem",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const smallButton: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "white",
  color: "#082a4a",
  fontSize: "0.72rem",
  fontWeight: 600,
  cursor: "pointer",
};

function statusColor(status: string): string {
  if (status === "HEALTHY") return "#059669";
  if (status === "FAILED") return "#dc2626";
  if (status === "DELAYED") return "#b45309";
  return "#64748b";
}

export default function AdminSettings() {
  const {
    user,
    permissions,
    credentialIntegrations,
    operationalIntegrations,
    canSeeIntegrations,
    runtimeOptions,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const isSubmitting = navigation.state === "submitting";

  const forcedChange =
    searchParams.get("notice") === "password-change-required" || user.mustChangePassword;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Settings
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Account and system configuration
      </p>

      {forcedChange ? (
        <div
          role="alert"
          style={{
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            color: "#92400e",
            padding: "0.75rem 1rem",
            borderRadius: 8,
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          Your password was reset by an owner. Choose a new one below before
          continuing.
        </div>
      ) : null}

      {actionData && "error" in actionData && actionData.error ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "0.75rem 1rem",
            borderRadius: 8,
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          {actionData.error}
        </div>
      ) : null}
      {actionData && "success" in actionData && actionData.success ? (
        <div
          role="status"
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#166534",
            padding: "0.75rem 1rem",
            borderRadius: 8,
            fontSize: "0.85rem",
            marginBottom: "1rem",
          }}
        >
          {actionData.success}
        </div>
      ) : null}

      {canSeeIntegrations ? (
        <>
          <div style={card}>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>
              Integration credentials
            </h2>
            <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "1rem" }}>
              These integrations hold secrets MoonVella uses to reach a provider.
              Saved values are encrypted before they are written and are never sent
              back to this page — a secret field shows only whether a value is set.
              Saving also runs an authenticated check against the provider, so
              &ldquo;Connected&rdquo; means the credentials were accepted, not merely
              that something was typed. Disconnect deletes the stored credentials and
              suppresses the deployment environment for that integration, which stops
              live provider calls until credentials are saved again.
            </p>
            {credentialIntegrations.map((i) => (
              <DetailCard
                key={i.key}
                integration={i}
                isSubmitting={isSubmitting}
                runtimeOptions={runtimeOptions}
              />
            ))}
          </div>

          <div style={card}>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>
              System health
            </h2>
            <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "1rem" }}>
              Operational checks, not credentials. Each reports whether the Shopify
              scope the connected app depends on has actually been granted. Order
              intake, fulfillment sync, analytics and product import keep recording
              here whether or not anyone opens this page.
            </p>
            {operationalIntegrations.map((i) => (
              <DetailCard
                key={i.key}
                integration={i}
                isSubmitting={isSubmitting}
                runtimeOptions={runtimeOptions}
              />
            ))}
          </div>
        </>
      ) : null}

      <div style={card}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, color: "#082a4a", marginBottom: "1.5rem" }}>
          Your Account
        </h2>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "#e2e8f0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.5rem",
              color: "#64748b",
              fontWeight: 700,
            }}
          >
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div style={{ fontWeight: 600, color: "#1e293b" }}>{user.name}</div>
            <div style={{ fontSize: "0.85rem", color: "#64748b" }}>{user.email}</div>
            <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>
              Role: {user.role}
              {user.isPrimaryOwner ? " (primary owner — cannot be disabled or demoted)" : ""}
            </div>
            {user.lastLoginAt ? (
              <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>
                Last sign-in: {new Date(user.lastLoginAt).toLocaleString()}
              </div>
            ) : null}
          </div>
        </div>

        {/* Listing the effective permissions rather than only the role name lets
            someone confirm what they can do without asking, and makes an
            unexpected role change visible immediately. */}
        <details style={{ marginBottom: "1.5rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "#64748b", fontWeight: 600 }}>
            What your role permits ({permissions.length})
          </summary>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.75rem" }}>
            {permissions.map((p) => (
              <code
                key={p}
                style={{
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                  borderRadius: 4,
                  padding: "0.15rem 0.4rem",
                  fontSize: "0.7rem",
                  color: "#334155",
                }}
              >
                {p}
              </code>
            ))}
          </div>
        </details>

        <Form method="post">
          <input type="hidden" name="intent" value="change_password" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem" }}>
            <div>
              <label style={label} htmlFor="currentPassword">Current Password</label>
              <input style={input} id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" />
            </div>
            <div>
              <label style={label} htmlFor="newPassword">New Password</label>
              <input style={input} id="newPassword" name="newPassword" type="password" autoComplete="new-password" />
            </div>
            <div>
              <label style={label} htmlFor="confirmPassword">Confirm New Password</label>
              <input style={input} id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" />
            </div>
          </div>
          <p style={{ fontSize: "0.7rem", color: "#94a3b8", marginTop: "0.5rem" }}>
            At least 12 characters, including a letter and a number. Changing your
            password signs out your other sessions.
          </p>

          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              marginTop: "1rem",
              padding: "0.75rem 1.5rem",
              background: "#10b981",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: isSubmitting ? "not-allowed" : "pointer",
              opacity: isSubmitting ? 0.6 : 1,
            }}
          >
            {isSubmitting ? "Saving..." : "Update Password"}
          </button>
        </Form>
      </div>

      <p style={{ fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>
          &larr; Back to Dashboard
        </Link>
      </p>
    </div>
  );
}

interface DetailCardProps {
  integration: IntegrationStateView;
  isSubmitting: boolean;
  /** Choices read live from the provider, keyed `"<integrationKey>:<fieldName>"`. */
  runtimeOptions: Record<string, CredentialOption[]>;
}

/** Display names. A raw key like "shopify_fulfillment" is not a label. */
const INTEGRATION_LABEL: Record<string, string> = {
  stripe: "Stripe",
  eshipper: "eShipper",
  odoo: "Odoo",
  google: "Google Maps Platform",
  shopify_orders: "Shopify orders",
  shopify_fulfillment: "Shopify fulfillment",
  shopify_analytics: "Shopify analytics",
  product_import: "Product import",
};

function DetailCard({ integration, isSubmitting, runtimeOptions }: DetailCardProps) {
  // Taken from the row rather than a props name of "key", which React reserves.
  const key = integration.key;

  return (
    <div style={{
      marginBottom: "1.5rem",
      padding: "1rem",
      border: "1px solid #e2e8f0",
      borderRadius: 8,
      background: "white",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <span style={{ fontWeight: 600, color: "#1e293b" }}>{INTEGRATION_LABEL[key] ?? key}</span>
        <span style={{ fontSize: "0.7rem", color: statusColor(integration.status) }}>
          {/* A credential integration claims "Connected" only on HEALTHY, and
              HEALTHY now only comes from an authenticated provider call. The
              wording states the evidence rather than asserting a connection. */}
          {integration.status === "HEALTHY" && isCredentialIntegrationKey(key)
            ? "CONNECTED — VERIFIED"
            : integration.status}
        </span>
      </div>
      <p style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem" }}>
        {integration.detail}
      </p>

      {/* A disconnected integration is a different state from one that was never
          configured, and the difference matters: this one was switched off. */}
      {integration.disconnectedAt ? (
        <p style={{ fontSize: "0.75rem", color: "#b45309", marginBottom: "0.5rem" }}>
          Disconnected {new Date(integration.disconnectedAt).toLocaleString()} — provider operations are
          disabled, and the deployment environment is suppressed for this integration until credentials
          are saved again.
        </p>
      ) : null}

      {/* Credential forms belong to the integrations that hold secrets. An
          operational check has nothing to configure, so it never renders one. */}
      {isCredentialIntegrationKey(key) ? (
        <CredentialsForm
          integrationKey={key}
          integration={integration}
          isSubmitting={isSubmitting}
          runtimeOptions={runtimeOptions}
        />
      ) : null}

      {/* Action buttons. Saving and disconnecting live inside each credential
          form, where the fields they submit actually are. */}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <Form method="post">
          <input type="hidden" name="intent" value="refresh_integration" />
          <input type="hidden" name="key" value={key} />
          <button type="submit" style={smallButton} disabled={isSubmitting}>
            Re-check
          </button>
        </Form>
        {integration.lastError || integration.lastErrorAt ? (
          <Form method="post">
            <input type="hidden" name="intent" value="clear_integration_error" />
            <input type="hidden" name="key" value={key} />
            <button type="submit" style={smallButton} disabled={isSubmitting}>
              Clear error
            </button>
          </Form>
        ) : null}
      </div>

      {/* Credential hints. Multi-line by design, hence pre-line. */}
      {integration.credentialHints ? (
        <p style={{ fontSize: "0.65rem", color: "#64748b", marginTop: "0.3rem", whiteSpace: "pre-line" }}>
          {integration.credentialHints}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------
 * Credential forms — one per integration that holds secrets.
 *
 * Each is an ordinary <Form method="post">, so the action receives the fields,
 * records that credentials were supplied and re-checks the integration. Nothing
 * secret is ever rendered back: the only honest thing this page can say about a
 * secret is whether the server-side check found it configured, and that is the
 * status line on the card, not a value echoed into an input.
 * --------------------------------------------------------------- */

/**
 * One credential form, rendered from the shared field spec.
 *
 * What each field shows is decided by the server, not here: a secret arrives
 * with `value: null` and only `isSet`, so this component has no secret to leak
 * even if it tried. Non-secret fields (a base URL, an account name) are
 * prefilled from the saved value so an operator can see what they are changing.
 */
function CredentialsForm({
  integrationKey,
  integration,
  isSubmitting,
  runtimeOptions,
}: {
  integrationKey: CredentialKey;
  integration: IntegrationStateView;
  isSubmitting: boolean;
  runtimeOptions: Record<string, CredentialOption[]>;
}) {
  const spec = CREDENTIAL_INTEGRATIONS[integrationKey];
  const stateByName = new Map(integration.credentialFields.map((field) => [field.name, field]));

  return (
    <div style={{ marginTop: "1rem" }}>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600, color: "#082a4a" }}>
          {spec.label} credentials
        </summary>
        <p style={{ fontSize: "0.7rem", color: "#64748b" }}>{spec.note}</p>

        <Form method="post">
          <input type="hidden" name="intent" value="save_credentials" />
          <input type="hidden" name="key" value={integrationKey} />
          {spec.fields.map((field) => {
            const state = stateByName.get(field.name);
            const statusText = state?.problem
              ? state.problem
              : state?.isSet
                ? `Saved${state.fromEnvironment ? " (from the deployment environment)" : ""}${
                    state.updatedAt ? ` ${new Date(state.updatedAt).toLocaleString()}` : ""
                  }`
                : "Not set";
            const statusTone = state?.problem ? "#dc2626" : state?.isSet ? "#059669" : "#94a3b8";

            /*
             * Live choices win over the static ones, and both are optional: a
             * field with neither is a text input.
             *
             * The saved value is kept as an option even when the read did not
             * return it. It can be a name where the list offers ids, or a
             * pricelist that was renamed or hidden since it was saved — and a
             * select whose value is not among its options silently shows the
             * first one instead, so simply opening this form and saving would
             * quietly repoint pricing at a different pricelist. It is offered
             * back verbatim, labelled as what it is.
             */
            const options = runtimeOptions[`${integrationKey}:${field.name}`] ?? field.options;
            const savedValue = state?.value ?? null;
            const savedNotListed =
              !!options && !!savedValue && !options.some((option) => option.value === savedValue);

            return (
              <div key={field.name}>
                <label
                  htmlFor={`${integrationKey}-${field.name}`}
                  style={{ display: "block", fontSize: "0.7rem", color: "#334155", marginTop: "0.5rem" }}
                >
                  {field.label}
                  <span style={{ marginLeft: "0.4rem", fontWeight: 400, color: statusTone }}>
                    {statusText}
                  </span>
                </label>
                {options ? (
                  <select
                    style={input}
                    id={`${integrationKey}-${field.name}`}
                    name={`secret_${field.name}`}
                    // An empty first option when nothing is saved, so that
                    // saving this form does not silently choose for the
                    // operator: the first entry in a list they have not read is
                    // still a choice, and for a pricelist it is the price every
                    // seller is charged.
                    defaultValue={savedValue ?? ""}
                  >
                    {!savedValue ? <option value="">— not set —</option> : null}
                    {savedNotListed && savedValue ? (
                      <option value={savedValue}>
                        {savedValue} — saved, and not in the list just read from Odoo
                      </option>
                    ) : null}
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    style={input}
                    id={`${integrationKey}-${field.name}`}
                    name={`secret_${field.name}`}
                    type={field.type ?? "text"}
                    placeholder={state?.isSet ? "•••••• (leave blank to keep)" : field.placeholder}
                    // A secret is never written into the DOM. A non-secret field
                    // is prefilled so it can be edited without retyping.
                    defaultValue={field.secret ? undefined : (state?.value ?? undefined)}
                    autoComplete="off"
                  />
                )}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
            <button type="submit" style={smallButton} disabled={isSubmitting}>
              Save credentials
            </button>
          </div>
        </Form>

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <Form method="post">
            <input type="hidden" name="intent" value="refresh_integration" />
            <input type="hidden" name="key" value={integrationKey} />
            <button type="submit" style={smallButton} disabled={isSubmitting}>
              Test connection
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="disconnect_integration" />
            <input type="hidden" name="key" value={integrationKey} />
            <button type="submit" style={smallButton} disabled={isSubmitting}>
              Disconnect
            </button>
          </Form>
        </div>
      </details>
    </div>
  );
}

/** Every credential key, in the order the page presents them. Adding one here is
 *  what makes its card render — the list is deliberately explicit rather than
 *  derived from CREDENTIAL_INTEGRATIONS, so a key added to the field definitions
 *  cannot appear on a live settings page without this line being changed too. */
const CREDENTIAL_KEY_ORDER: CredentialKey[] = ["stripe", "eshipper", "odoo", "google"];

function isCredentialIntegrationKey(key: string): key is CredentialKey {
  return (CREDENTIAL_KEY_ORDER as string[]).includes(key);
}
