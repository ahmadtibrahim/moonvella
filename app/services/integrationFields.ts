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
      "an authenticated call to Stripe succeeds.",
    fields: [
      { name: "STRIPE_SECRET_KEY", label: "Secret key (test mode)", secret: true, type: "password", placeholder: "sk_test_…" },
      { name: "STRIPE_PUBLISHABLE_KEY", label: "Publishable key", secret: false, placeholder: "pk_test_…" },
      { name: "STRIPE_WEBHOOK_SECRET", label: "Webhook signing secret", secret: true, type: "password", placeholder: "whsec_…" },
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
      "THE WHOLESALE PRICELIST IS THE PRICING AUTHORITY: the price MoonVella charges a seller " +
      "is the fixed quantity-1 price from that pricelist, and never Odoo's list price, the " +
      "product's cost, or a quantity tier. It must be a CAD pricelist — MoonVella bills in CAD " +
      "and converts nothing — and a variant with no usable row is flagged and left out of the " +
      "import rather than priced by guesswork. Like the consignment pair it accepts a name or a " +
      "numeric id, and an ambiguous name is refused. " +
      "READ-ONLY IS THE DEFAULT: \"live\" mode alone does not enable writes — they also " +
      "require ODOO_ALLOW_WRITES=yes in the deployment environment, which this page cannot " +
      "set, so a form here can never authorise writing to the ERP. The database is reached " +
      "over JSON-RPC only, never as a PostgreSQL connection, and a database named Prod-db " +
      "is refused unless a deployment sets ODOO_ALLOW_PROD_DB=yes. Use a dedicated service " +
      "account — see the connection setup steps in the audit.",
    fields: [
      { name: "ODOO_URL", label: "Odoo URL", secret: false, placeholder: "https://erp.premafirm.com" },
      { name: "ODOO_DATABASE", label: "Database", secret: false, placeholder: "database name" },
      { name: "ODOO_USERNAME", label: "Username", secret: false, placeholder: "service account" },
      { name: "ODOO_API_KEY", label: "API key", secret: true, type: "password", placeholder: "API key" },
      {
        name: "ODOO_MODE",
        label: "Mode",
        secret: false,
        options: [
          { value: "readonly", label: "readonly (read-only)" },
          { value: "live", label: "live" },
          { value: "disabled", label: "disabled" },
        ],
      },
      {
        name: "ODOO_CONSIGNMENT_LOCATION",
        label: "Consignment location",
        secret: false,
        placeholder: "stock location name or numeric id",
      },
      {
        name: "ODOO_CONSIGNMENT_OWNER",
        label: "Consignment owner",
        secret: false,
        placeholder: "partner name or numeric id",
      },
      {
        // Offered as a picker of the pricelists read from the connected Odoo,
        // and as a plain text field when that read is unavailable — the same
        // name-or-id rule the consignment fields use, because it is the same
        // resolution. A name that matches more than one pricelist is refused.
        name: "ODOO_WHOLESALE_PRICELIST",
        label: "Wholesale pricelist",
        secret: false,
        placeholder: "pricelist name or numeric id",
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
      },
      {
        name: "GOOGLE_MAPS_SERVER_KEY",
        label: "Server key (Address Validation)",
        secret: true,
        type: "password",
        placeholder: "AIza… restricted by IP",
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
