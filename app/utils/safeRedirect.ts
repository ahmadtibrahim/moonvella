/**
 * Open-redirect guard.
 *
 * Client-safe because the login page re-validates the `next` parameter during
 * render — it renders it into a hidden form field, and rendering a value from a
 * `.server` module pulls that module into the browser bundle.
 *
 * Kept deliberately strict. A redirect target that can be made absolute points
 * somewhere the operator did not intend, and the whole value of a login form is
 * that the person using it can trust where it sends them.
 */
export function safeRedirectPath(value: string | null | undefined): string | null {
  if (!value) return null;
  // Must be a path, not a URL.
  if (!value.startsWith("/")) return null;
  // "//evil.com" and "/\evil.com" are both treated as protocol-relative by some
  // browsers, so a value that looks like a path can still leave the site.
  if (value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  // Catches "/x?y=http://evil" and anything else smuggling an absolute URL.
  if (value.includes("://")) return null;
  return value;
}
