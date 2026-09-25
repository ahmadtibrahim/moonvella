/**
 * The single source of truth for what an administrative role may do.
 *
 * Every authorisation decision in the owner panel resolves through this file.
 * Routes do not compare roles themselves — they ask for a named permission —
 * so a route can never disagree with the policy, and changing who may do
 * something is a one-line edit here rather than a search across the codebase.
 *
 * Default deny. A permission that is not explicitly listed for a role is
 * denied, including for OWNER: if you add a capability and forget to grant it,
 * the failure mode is a 403 you will notice immediately, not a silent
 * authorisation hole. `can()` returns false for anything it does not
 * positively know.
 *
 * This module is NOT named `.server.ts`, and that is deliberate. The sidebar
 * filters its links with `can()` during render, so the policy does reach the
 * browser. Shipping it is harmless — it is a description of which buttons to
 * draw, not a secret, and an attacker who reads it learns only what they would
 * learn by being told "403" one request at a time.
 *
 * The control is elsewhere: every route calls `requirePermission` in its loader
 * or action, server-side, before touching data. Hiding a button is a
 * convenience; that call is the control. Nothing here should ever be the only
 * thing standing between a role and an action.
 */

import type { AdminRole } from "@prisma/client";

/* -------------------------------------------------------------------------- */
/* Permission vocabulary                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Named capabilities. Grouped by subject; the naming convention is
 * `<subject>.<verb>`.
 *
 * `delete` is deliberately absent for audit: audit records are append-only and
 * enforced as such in the database, so there is no capability to grant.
 */
export const PERMISSIONS = [
  // Dashboard — the landing page. Everyone gets it; it shows aggregates only,
  // and each panel on it is separately gated by the permission behind it.
  "dashboard.view",

  // Staff administration.
  "users.view",
  "users.manage",
  "roles.assign",

  // Settings, split so operational configuration can be delegated without
  // handing over security-critical configuration.
  "settings.general",
  "settings.security",

  // Secrets: Shopify credentials, payment credentials, API keys. Viewing is
  // separated from changing because the distinction matters for support work.
  "secrets.view",
  "secrets.manage",

  // Money.
  "payments.view",
  "payments.manage",
  "finance.view",

  // Catalog.
  "products.view",
  "products.manage",
  // Cost and margin are financial data wearing a product's clothes, so this is
  // its own permission rather than part of products.manage.
  "products.cost.edit",
  /*
   * Publishing to sellers, split out of products.manage.
   *
   * Curating a product and DECIDING THAT SELLERS MAY SEE IT are different
   * acts, and the second one is the one with consequences: a published
   * product leaves this building. The catalogue role still writes every word,
   * image and carton on the record — it just does not get to say when the
   * record goes live. See the CATALOG grant below.
   */
  "products.publish",

  // Orders and fulfilment.
  "orders.view",
  "orders.manage",
  "orders.fulfill",
  "orders.notes.add",

  // Merchants.
  "merchants.view",
  "merchants.manage",

  // Shipping and logistics.
  "shipping.view",
  "shipping.manage",

  // Reporting and the audit trail.
  "reports.view",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/* -------------------------------------------------------------------------- */
/* The policy                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Role grants.
 *
 * These follow the agreed role definitions directly, and are written to be
 * read as the answer to "what is this role for". Where a capability was
 * arguably implied but not stated, it is NOT granted — see the notes.
 */
const GRANTS: Record<AdminRole, readonly Permission[]> = {
  /**
   * OWNER — full access. Exactly one account normally carries this role, and
   * the primary owner flag additionally makes it undeletable and
   * undemotable; see the AdminUser model and its database constraints.
   */
  OWNER: [
    "dashboard.view",
    "users.view",
    "users.manage",
    "roles.assign",
    "settings.general",
    "settings.security",
    "secrets.view",
    "secrets.manage",
    "payments.view",
    "payments.manage",
    "finance.view",
    "products.view",
    "products.manage",
    "products.cost.edit",
    "products.publish",
    "orders.view",
    "orders.manage",
    "orders.fulfill",
    "orders.notes.add",
    "merchants.view",
    "merchants.manage",
    "shipping.view",
    "shipping.manage",
    "reports.view",
    "audit.view",
  ],

  /**
   * ADMIN — operational administration.
   *
   * Deliberately withheld: users.view/users.manage and roles.assign (may not
   * create, disable or promote owners), secrets.view and secrets.manage (may
   * not see or change raw credentials), payments.manage and finance.view (may
   * not change payment credentials or read financials), settings.security (may
   * not move security-critical configuration).
   *
   * audit.view is granted: an administrator may read the trail, and cannot
   * alter it — that is a database-level guarantee, not a permission.
   */
  ADMIN: [
    "dashboard.view",
    "settings.general",
    "payments.view",
    "products.view",
    "products.manage",
    "products.cost.edit",
    "products.publish",
    "orders.view",
    "orders.manage",
    "orders.fulfill",
    "orders.notes.add",
    "merchants.view",
    "merchants.manage",
    "shipping.view",
    "shipping.manage",
    "reports.view",
    "audit.view",
  ],

  /**
   * OPERATIONS — the order desk.
   *
   * Makes and fulfils orders and works the shipping queue. Cannot touch users,
   * payment settings, credentials or product cost, and has no system settings.
   *
   * reports.view is NOT granted: operations was specified as managing orders,
   * and reports were not among its capabilities. This is the default-deny rule
   * applied literally — if you want the order desk to see the reports section,
   * add it here and nothing else needs to change.
   */
  OPERATIONS: [
    "dashboard.view",
    "products.view",
    "orders.view",
    "orders.manage",
    "orders.fulfill",
    "orders.notes.add",
    "merchants.view",
    "shipping.view",
    "shipping.manage",
  ],

  /**
   * CATALOG — product content.
   *
   * Curates the catalogue but is kept away from orders, money and admin.
   *
   * products.cost.edit is NOT granted. Cost is financial data, and catalog's
   * remit was the product record — descriptions, images, variants,
   * availability and export data — not its margin. Give OWNER or ADMIN the
   * cost change if it is needed.
   *
   * products.publish is NOT granted either, and for a plainer reason: writing
   * a product and releasing it to sellers are different decisions, and only
   * the second one sends work out of the building. The owner removed the
   * approval step that used to sit between them, so the separation now lives
   * here — catalog prepares the record, an owner or administrator publishes
   * it. Everything else on the product still belongs to catalog.
   */
  CATALOG: [
    "dashboard.view",
    "products.view",
    "products.manage",
  ],

  /**
   * SUPPORT — merchant-facing help.
   *
   * Sees merchants and orders and can leave internal notes. Explicitly cannot
   * fulfil orders, change payments or costs, change roles, or reach settings
   * or secrets.
   *
   * orders.manage is withheld as well as orders.fulfill: support updates a
   * conversation, not an order's state.
   */
  SUPPORT: [
    "dashboard.view",
    "orders.view",
    "orders.notes.add",
    "merchants.view",
  ],

  /**
   * VIEWER — read-only.
   *
   * Dashboard and reports, nothing else. Notably this does not include
   * merchants.view or orders.view: "read-only access to non-secret dashboard
   * information and reports" is narrower than read access to the business.
   */
  VIEWER: [
    "dashboard.view",
    "reports.view",
  ],
};

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pre-computed sets.
 *
 * A Map rather than a Record built with Object.fromEntries: `get` on a Map
 * returns `undefined` for a key that is not present, which is precisely the
 * default-deny behaviour wanted below. A Record would need a cast to satisfy
 * the compiler that every role is present, and that cast is exactly the
 * assertion this module should not be making.
 */
const GRANT_SETS: ReadonlyMap<AdminRole, ReadonlySet<Permission>> = new Map(
  (Object.keys(GRANTS) as AdminRole[]).map(
    (role): [AdminRole, ReadonlySet<Permission>] => [role, new Set(GRANTS[role])]
  )
);

/** Shared empty set, so an unknown role costs no allocation. */
const NO_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>();

/**
 * Every permission a user holds. Returns an empty set for a role the policy
 * does not mention, so an unrecognised value from the database denies
 * everything rather than granting everything.
 */
export function permissionsFor(role: AdminRole | string): ReadonlySet<Permission> {
  return GRANT_SETS.get(role as AdminRole) ?? NO_PERMISSIONS;
}

/** The whole policy, for rendering the role matrix in the user interface. */
export function allGrants(): Record<AdminRole, readonly Permission[]> {
  return GRANTS;
}

/**
 * Does this role hold this permission?
 *
 * Default deny: unknown permission strings and unknown roles both return false.
 */
export function can(role: AdminRole | string, permission: Permission): boolean {
  if (!isPermission(permission)) return false;
  return permissionsFor(role).has(permission);
}

/** Does this role hold at least one of these permissions? */
export function canAny(role: AdminRole | string, permissions: readonly Permission[]): boolean {
  const held = permissionsFor(role);
  return permissions.some((p) => isPermission(p) && held.has(p));
}

/** Runtime guard so a typo in a permission name is a loud failure, not a 403. */
export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * A note on where the primary-owner protections live.
 *
 * It is tempting to add a list here of permissions only the primary owner may
 * exercise. That would be wrong, and worth stating so nobody adds it later.
 *
 * The rules the primary owner needs — cannot be deleted, cannot be disabled,
 * cannot be demoted, cannot be left without owner access — are properties of
 * the *account being acted on*, not of the role doing the acting. Any OWNER may
 * manage staff, and a second OWNER created later is a full owner; what no one
 * may do, whatever their role, is damage the primary owner account or remove
 * the last owner. Those checks therefore live with the operations that could
 * violate them (app/services/adminUsers.server.ts) and, decisively, in the
 * database constraints created by the multiuser migration.
 *
 * Right now the two happen to be indistinguishable, because the primary owner
 * is the only OWNER account. They are not the same rule, and encoding them as
 * if they were would quietly break the moment a second owner is appointed.
 */
