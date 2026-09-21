/**
 * The role vocabulary.
 *
 * Client-safe on purpose: the invitation form and the user detail page both
 * render a role picker by iterating this list. Importing it from a `.server`
 * module would pull that module into the browser bundle — see the note in
 * passwordPolicy.ts.
 *
 * The list mirrors the AdminRole enum in prisma/schema.prisma. It is duplicated
 * rather than derived because the generated enum is a runtime object only on
 * the server side of the Prisma client split, and importing it into a component
 * is exactly the mistake this file exists to avoid. A test asserts the two
 * agree.
 */

import type { AdminRole } from "@prisma/client";

/**
 * Every role, in descending order of authority. The order is what the pickers
 * render, so it is intentional: the most powerful role is first and the least
 * is last, which reads as a scale rather than an arbitrary list.
 */
export const ADMIN_ROLES: readonly AdminRole[] = [
  "OWNER",
  "ADMIN",
  "OPERATIONS",
  "CATALOG",
  "SUPPORT",
  "VIEWER",
];

/** Labels for display. Kept beside the roles so a new role cannot be added
 *  without the compiler pointing at the missing label. */
export const ROLE_LABEL: Record<AdminRole, string> = {
  OWNER: "Owner",
  ADMIN: "Administrator",
  OPERATIONS: "Operations",
  CATALOG: "Catalog",
  SUPPORT: "Support",
  VIEWER: "Viewer",
};

/**
 * Narrowing guard for values arriving from a form.
 *
 * Anything not in the list is rejected, which is what stops a submitted
 * `role=SUPERUSER` from reaching a query.
 */
export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}
