/**
 * The credential field definitions, in a module both sides may import.
 *
 * This file is deliberately isomorphic — no server imports, no `process.env`
 * reads, no Prisma. The Settings page renders from it in the browser, and
 * credentials.server.ts validates against it on the server, so a field can never
 * be renderable but unsaveable, or saveable but unrenderable.
 *
 * `secret: true` marks a field whose VALUE may never leave the server: the
 * Settings page learns only whether it is set. Fields marked `secret: false` are
 * connection identifiers (a base URL, an account name), which are prefilled so an
 * operator can see what they are editing without retyping it.
 */

export type CredentialKey = "stripe" | "eshipper" | "odoo" | "google";

export interface CredentialOption {
  value: string;
  label: string;
}

export interface CredentialFieldSpec {
  /** Environment-variable-shaped name; also the storage field name. */
  name: string;
  label: string;
  secret: boolean;
  type?: "text" | "password";
  placeholder?: string;
  options?: CredentialOption[];
  /**
   * What to put in this field, shown while it is unset.
   *
   * This is where the console-side setup is written down: which API to enable
   * on the key, which restriction to apply, which value the deployment expects.
   * It is per FIELD because a missing credential is per field — "Google is not
   * configured" names a state, not the two keys it is waiting for — and it is
   * here rather than in the page because this file is the one authority for what
   * a field is.
   */
  hint?: string;
}

export interface CredentialIntegrationSpec {
  label: string;
  /** Shown under the form. Says plainly what saving does, and what it does not. */
  note: string;
  fields: CredentialFieldSpec[];
}

export const CREDENTIAL_INTEGRATIONS: Record<CredentialKey, CredentialIntegrationSpec> = {
  stripe: {
    label: "Stripe",
    note:
      "Values are encrypted before they are stored and are never sent back to this page. " +
      "Leave a field blank to keep the value already saved. \"Connected\" appears only after " +
      "an authenticated call to Stripe succeeds. " +
      "EACH FIELD TAKES ONE KIND OF VALUE, and a value of the wrong kind is refused when it " +
      "is saved rather than stored and left to fail later: the secret field takes an sk_… " +
      "secret key (or an rk_… restricted key, which authenticates identically). A " +
      "publishable key (pk_…) belongs in the publishable field and can never authenticate, " +
      "and a webhook signing secret (whsec_…) belongs in the signing-secret field.",
    fields: [
      {
        name: "STRIPE_SECRET_KEY",
        label: "Secret key (test mode)",
        secret: true,
        type: "password",
        placeholder: "sk_test_…",
        hint: "sk_test_… from the dashboard's test-mode API keys. This is the only field that authenticates MoonVella to Stripe; an rk_… restricted key works here too, and a pk_… publishable key is refused.",
      },
      {
        name: "STRIPE_PUBLISHABLE_KEY",
        label: "Publishable key",
        secret: false,
        placeholder: "pk_test_…",
        hint: "pk_test_… Optional, and used by the browser in test mode. It cannot authenticate anything.",
      },
      {
        name: "STRIPE_WEBHOOK_SECRET",
        label: "Webhook signing secret",
        secret: true,
        type: "password",
        placeholder: "whsec_…",
        hint: "whsec_… for the endpoint POST /webhooks/stripe. It verifies that an incoming event really came from Stripe.",
      },
    ],
  },
  eshipper: {
    label: "eShipper",
    note:
      "The confirmed test host is https://uu2.eshipper.com — it is recognised by name, so no " +
      "\"sandbox\" in the hostname is required. Live bookings still require ESHIPPER_ENV=production " +
      "in the deployment environment, which is deliberately not settable from this page. " +
      "Authentication uses the documented AuthenticationRequest fields: the username is sent as " +
      "\"principal\" and the password as \"credential\". Account ID is not part of authentication " +
      "and is not sent with it. " +
      "Leave a field blank to keep the value already saved.",
    fields: [
      { name: "ESHIPPER_BASE_URL", label: "Base URL", secret: false, placeholder: "https://uu2.eshipper.com" },
      { name: "ESHIPPER_USERNAME", label: "Username (principal)", secret: false, placeholder: "API user" },
      { name: "ESHIPPER_PASSWORD", label: "Password (credential)", secret: true, type: "password", placeholder: "API secret" },
      { name: "ESHIPPER_ACCOUNT_ID", label: "Account ID (not used for authentication)", secret: false, placeholder: "optional" },
    ],
  },
  odoo: {
    label: "Odoo",
    note:
      "Values are encrypted before they are stored and are never sent back to this page. " +
      "\"Connected\" appears only after MoonVella authenticates against Odoo with these " +
      "credentials. Leave a field blank to keep the value already saved. " +
      "The consignment location and owner say WHOSE stock is sellable: an import reads the " +
      "quantities held at that location for that owner and nothing else, so stock belonging " +
      "to the company or to another supplier is never offered for sale. Both accept a name " +
      "or a numeric id, and a name that matches more than one record is refused rather than " +
      "guessed at. " +
      "THE PRICE MOONVELLA CHARGES A SELLER IS EACH VARIANT'S EFFECTIVE SALES PRICE IN ODOO — " +
      "the price on the variant's own form, which is the template's list price plus that " +
      "variant's attribute price extras. There is nothing to configure for it: it is read as " +
      "Odoo computes it, never as the product's cost and never as zero, and a variant Odoo " +
      "cannot price stops the import instead of arriving at a guess. MoonVella bills in CAD and " +
      "converts nothing, so a product priced in another currency is refused. " +
      "READ-ONLY IS THE DEFAULT: \"live\" mode alone does not enable writes — they also " +
      "require ODOO_ALLOW_WRITES=yes in the deployment environment, which this page cannot " +
      "set, so a form here can never authorise writing to the ERP. The database is reached " +
      "over JSON-RPC only, never as a PostgreSQL connection, and a database named Prod-db " +
      "is refused unless a deployment sets ODOO_ALLOW_PROD_DB=yes. Use a dedicated service " +
      "account — see the connection setup steps in the audit.",
    fields: [
      {
        name: "ODOO_URL",
        label: "Odoo URL",
        secret: false,
        placeholder: "https://erp.premafirm.com",
        hint: "https://erp.premafirm.com — the instance MoonVella reads, with no trailing slash.",
      },
      {
        name: "ODOO_DATABASE",
        label: "Database",
        secret: false,
        placeholder: "database name",
        hint: "Prod-db for the live ERP. A name that matches no database is refused rather than guessed at.",
      },
      {
        name: "ODOO_USERNAME",
        label: "Username",
        secret: false,
        placeholder: "service account",
        hint: "A dedicated service account, not a person's login — its access can then be narrowed and revoked on its own.",
      },
      {
        name: "ODOO_API_KEY",
        label: "API key",
        secret: true,
        type: "password",
        placeholder: "API key",
        hint: "That account's own API key (Odoo → Preferences → Account Security → New API Key). Stored encrypted and never shown again.",
      },
      {
        name: "ODOO_MODE",
        label: "Mode",
        secret: false,
        options: [
          { value: "readonly", label: "readonly (read-only)" },
          { value: "live", label: "live" },
          { value: "disabled", label: "disabled" },
        ],
        hint: "readonly reads the catalogue and writes nothing back. Choosing live does not by itself permit a write — that also needs ODOO_ALLOW_WRITES in the deployment environment, which this page cannot set.",
      },
      {
        // One setting covers both jobs, because they are the same fact: which
        // warehouse MoonVella ships from. Its locations are where stock is
        // counted, and its address is where a shipment is collected.
        //
        // The address is read, never typed: the pickup location MoonVella books
        // against is built from this warehouse's own partner address in Odoo, so
        // a change made there reaches a booking without anyone editing it twice.
        name: "ODOO_WAREHOUSE",
        label: "Fulfillment warehouse",
        secret: false,
        placeholder: "warehouse name or numeric id",
        hint: "“Premafirm Inc.” — the warehouse at 994 Westport Cres, Unit 7A, Mississauga. Stock is counted across its locations for every owner (company-owned and consigned alike, less reservations), and its Odoo address becomes the pickup address of every outbound shipment. There is no separate consignment owner to set: adding a vendor never means changing a global.",
      },
    ],
  },
  google: {
    label: "Google Maps Platform",
    note:
      "TWO KEYS, AND THEY ARE NOT INTERCHANGEABLE. The browser key is handed to the " +
      "page that renders address autocomplete, so it is public by construction — " +
      "restrict it by HTTP referrer in the Google Cloud console, and enable only " +
      "Places API (New) on it. The server key is used only by this server for Address " +
      "Validation; it is encrypted, never rendered on this page, never sent to a " +
      "browser, and should be restricted by IP address. Enabling validation on the " +
      "browser key would let anyone who views the page spend the account's quota.",
    fields: [
      {
        name: "GOOGLE_MAPS_BROWSER_KEY",
        label: "Browser key (Places autocomplete)",
        secret: false,
        placeholder: "AIza… restricted by referrer",
        hint:
          "Create a key in the Google Cloud project that already serves MoonVella. Enable Places API (New) on it and nothing else, then restrict it by HTTP referrer to " +
          "https://app.moonvella.com/* and https://admin.moonvella.com/*. This key is sent to the page that runs autocomplete, so the referrer restriction is the only thing protecting it. " +
          "Odoo's own google_maps_api_key is a server-side geolocate key with no website restriction — it is NOT this key and must not be used here.",
      },
      {
        name: "GOOGLE_MAPS_SERVER_KEY",
        label: "Server key (Address Validation)",
        secret: true,
        type: "password",
        placeholder: "AIza… restricted by IP",
        hint:
          "A second key in the same project: enable Address Validation API, and restrict it by IP address. It is called only from this server and is never sent to a browser.",
      },
    ],
  },
};

/**
 * Every field name the store will accept, across all credential keys. The store
 * resolves environment variables by name, so an unlisted name is rejected rather
 * than silently read — otherwise the (permissive) save path would be a way to
 * read any environment variable on the host.
 */
export const ALL_CREDENTIAL_FIELD_NAMES: string[] = Object.values(CREDENTIAL_INTEGRATIONS).flatMap(
  (integration) => integration.fields.map((field) => field.name)
);

export function credentialFields(key: CredentialKey): CredentialFieldSpec[] {
  return CREDENTIAL_INTEGRATIONS[key].fields;
}

/** True when the named field is stored but may never be rendered. */
export function isSecretField(key: CredentialKey, field: string): boolean {
  return credentialFields(key).some((spec) => spec.name === field && spec.secret);
}
