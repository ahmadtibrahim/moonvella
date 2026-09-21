/**
 * Product Code — the internal identifier for a product *family*.
 *
 * It is not a SKU. A SKU belongs to one sellable variant; the Product Code
 * names the family that those variants belong to. MV-COOL-PILLOW is the family
 * that contains MV-COOL-PILLOW-STD and MV-COOL-PILLOW-QN.
 *
 * Codes are normalised to upper case and trimmed on the way in, so that
 * `mv-cool-pillow` and `MV-COOL-PILLOW ` are the same code rather than two
 * rows that both look correct on screen. The unique index on the column is the
 * real guard; this module exists so a person gets a sentence explaining the
 * problem instead of a constraint violation.
 */

/** Long enough for a readable code, short enough to stay a code. */
export const PRODUCT_CODE_MAX_LENGTH = 64;

export const PRODUCT_CODE_HELP =
  "Internal code identifying this product family. Each sellable variant has its own SKU.";

/**
 * Codes are written as words joined by separators: MV-COOL-PILLOW. Letters,
 * digits, hyphen, underscore and dot are allowed. Whitespace is not, because a
 * code is something people read aloud and type into other systems, and an
 * invisible difference between two codes is exactly the kind of mistake that
 * costs an afternoon to find.
 */
const ALLOWED = /^[A-Z0-9._-]+$/;

/**
 * Uppercases and trims. Deliberately does NOT strip disallowed characters:
 * silently rewriting input can turn two distinct codes into one, and it hides
 * the problem from the person who typed it.
 */
export function normalizeProductCode(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase();
}

export interface ProductCodeCheck {
  ok: boolean;
  /** The normalised code, present whether or not the check passed. */
  code: string;
  error?: string;
}

export function checkProductCode(raw: unknown): ProductCodeCheck {
  const code = normalizeProductCode(raw);

  if (!code) {
    return { ok: false, code, error: "Product Code is required." };
  }
  if (code.length > PRODUCT_CODE_MAX_LENGTH) {
    return {
      ok: false,
      code,
      error: `Product Code must be ${PRODUCT_CODE_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (!ALLOWED.test(code)) {
    return {
      ok: false,
      code,
      error: "Product Code may contain only letters, digits, hyphen, underscore and dot.",
    };
  }
  return { ok: true, code };
}

/** Throws with the human-readable reason. For server-side callers. */
export function requireProductCode(raw: unknown): string {
  const result = checkProductCode(raw);
  if (!result.ok) throw new Error(result.error);
  return result.code;
}

/**
 * A starting code suggested from a product name, for the create form's
 * placeholder. It is a suggestion the person can overwrite, never a value
 * written behind their back — two products with the same name would otherwise
 * collide on the unique index with no explanation.
 */
export function suggestProductCode(name: unknown): string {
  return String(name ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PRODUCT_CODE_MAX_LENGTH);
}
