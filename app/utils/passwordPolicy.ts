/**
 * Password rules.
 *
 * Deliberately NOT a `.server` module. The acceptance page and the settings
 * page both quote the minimum length in their markup, and a component that
 * imports from a `.server` module drags that module — and everything it
 * imports — into the browser bundle. React Router only strips server code from
 * `loader`, `action`, `middleware` and `headers` exports; a value used in JSX
 * is not strippable.
 *
 * Splitting the rule out is the correct fix rather than hard-coding "12" in two
 * places, because two copies of a policy drift and the one in the UI is the one
 * nobody re-reads.
 *
 * Nothing here is secret: these are the rules, not the hashes.
 */

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Longest password accepted, in bytes.
 *
 * bcrypt ignores everything past 72 bytes. Accepting more would mean hashing
 * something shorter than the user believes they set, and two passwords
 * differing only after byte 72 would be interchangeable at sign-in. Measured in
 * bytes rather than characters because an accented or non-Latin password
 * reaches the limit sooner than its length suggests.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Returns null when the password is acceptable, or a sentence explaining why
 * not. One function so invitation acceptance, self-service change and
 * owner-issued recovery all apply the same rule.
 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  // TextEncoder rather than Buffer.byteLength so this module is safe to import
  // from a component. Both are available in Node; only TextEncoder is
  // guaranteed in a browser.
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes (roughly ${MAX_PASSWORD_BYTES} characters).`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must contain at least one letter and one number.";
  }
  return null;
}
