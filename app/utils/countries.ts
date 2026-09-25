/**
 * The country list the address forms offer, and the rule they all follow: show
 * a person the country's name, store the two-letter code.
 *
 * WHY A DROPDOWN AT ALL. Both address forms used to ask for a country code in a
 * free-text box, one of them hinting "Two letters, e.g. CA." A code is what
 * every downstream consumer wants — Google's `regionCode`, Shopify's
 * `countryCode`, Odoo's `res.country` — and a code is exactly what a person
 * should not have to remember. The failure it produced was quiet: "Ca" is
 * accepted by an upper-casing trim, "Can" and "Canada" are not, and an address
 * with an unusable country is one Google refuses to validate and no carrier can
 * route.
 *
 * THE LIST IS CURATED, NOT COMPLETE, AND SAYS SO. Every country in the world
 * would be 249 options in a dropdown on a form whose addresses are Canadian, and
 * a list that long is slower to use than the text box it replaced. What is here
 * covers the operating market, its neighbours and the economies a wholesale
 * order plausibly ships to. A stored value that is not in the list is kept as an
 * extra option rather than dropped, so opening one of these forms can never
 * silently rewrite the country on a record that is already in use — and adding
 * one is a single line here.
 */

export interface Country {
  /** ISO 3166-1 alpha-2, upper case. This is what is stored and sent. */
  code: string;
  /** The name a person reads. */
  name: string;
}

export const COUNTRIES: readonly Country[] = [
  { code: "CA", name: "Canada" },
  { code: "US", name: "United States" },
  { code: "MX", name: "Mexico" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "BE", name: "Belgium" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "PT", name: "Portugal" },
  { code: "AT", name: "Austria" },
  { code: "CH", name: "Switzerland" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },
  { code: "PL", name: "Poland" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "CN", name: "China" },
  { code: "HK", name: "Hong Kong" },
  { code: "SG", name: "Singapore" },
  { code: "IN", name: "India" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "BR", name: "Brazil" },
];

const BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country.name]));
const BY_NAME = new Map(COUNTRIES.map((country) => [country.name.trim().toLowerCase(), country.code]));

/** The full name for a stored code, or the code itself when it is not listed. */
export function countryName(code: string | null | undefined): string {
  const normalized = (code ?? "").trim().toUpperCase();
  if (!normalized) return "";
  return BY_CODE.get(normalized) ?? normalized;
}

/**
 * The option value that represents what is stored: the code when the text is
 * one of the codes or names in the list, otherwise the text itself.
 *
 * Records outlive forms, and a country was free text until this list existed —
 * so "Canada", "canada" and "CA" all have to land on the same option rather
 * than each becoming a puzzle for the next person who opens the record.
 */
export function countryValue(current?: string | null): string {
  const raw = (current ?? "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (BY_CODE.has(upper)) return upper;
  return BY_NAME.get(raw.toLowerCase()) ?? raw;
}

/**
 * The options a form renders: the list, plus the record's own value when the
 * list does not already carry it.
 *
 * The second half is what makes the dropdown safe to put on an existing record.
 * A `<select>` with no matching option renders the first option as selected, so
 * a record stored as "ZZ" would appear as "Canada" — and the next save would
 * write CA over a country nobody chose. Carrying the unknown value through
 * instead keeps the form honest about what the record holds.
 */
export function countryOptions(current?: string | null): Country[] {
  const options = [...COUNTRIES];
  const value = countryValue(current);
  if (value && !BY_CODE.has(value)) {
    options.unshift({ code: value, name: `${value} (not in the list)` });
  }
  return options;
}
