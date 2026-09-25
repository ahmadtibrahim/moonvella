import { useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Form } from "react-router";

/**
 * Shared presentation for the product editor's five tabs.
 *
 * These are deliberately plain objects and small functions rather than a
 * component library: the owner panel is server-rendered forms, and a shared
 * style constant is enough to keep the tabs looking like one interface without
 * introducing a build step or a dependency.
 */

export const INK = "#082a4a";
export const MUTED = "#64748b";
export const FAINT = "#94a3b8";
export const LINE = "#e2e8f0";

export const card: CSSProperties = {
  background: "white",
  border: `1px solid ${LINE}`,
  borderRadius: 12,
  padding: "2rem",
  marginBottom: "1.5rem",
};

export const input: CSSProperties = {
  width: "100%",
  padding: "0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.9rem",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

export const label: CSSProperties = {
  display: "block",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "#334155",
  marginBottom: "0.3rem",
};

export const helpText: CSSProperties = {
  fontSize: "0.76rem",
  color: MUTED,
  marginTop: "0.25rem",
  lineHeight: 1.45,
};

export function btn(color: string, options: { solid?: boolean } = {}): CSSProperties {
  return {
    padding: "0.4rem 0.75rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: options.solid ? color : "white",
    color: options.solid ? "white" : color,
    fontSize: "0.72rem",
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "none",
    display: "inline-block",
  };
}

export const sectionTitle: CSSProperties = {
  fontSize: "0.95rem",
  fontWeight: 600,
  color: INK,
  marginBottom: "0.25rem",
};

export const sectionNote: CSSProperties = {
  fontSize: "0.8rem",
  color: MUTED,
  marginBottom: "1rem",
  lineHeight: 1.5,
};

/**
 * A labelled form control. The label is bound to the control by id rather than
 * by wrapping, because several of these sit in grids where a wrapping label
 * changes the box model.
 */
export function Field({
  id,
  label: text,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <label style={label} htmlFor={id}>
        {text}
      </label>
      {children}
      {hint ? <div style={helpText}>{hint}</div> : null}
    </div>
  );
}

/**
 * The values a merchant is offered before they are invited to invent one.
 *
 * These are suggestions, not an enum: the column is free text, and a catalog
 * that has to be redeployed before somebody can sell "Pet Supplies" is a worse
 * catalog. What the list buys is that the *common* answers agree with each
 * other — one "Clothing", not "Clothing", "clothing" and "Apparel" — because
 * filtering and the seller-facing categories only work if the words match.
 */
export const CATEGORY_OPTIONS = [
  "Clothing",
  "Accessories",
  "Home & Garden",
  "Sports",
  "Electronics",
  "Other",
];

export const CURRENCY_OPTIONS = ["CAD", "USD", "EUR", "GBP", "AUD", "CHF"];

/**
 * A catalogue value: a list of the usual answers, and a box for a new one.
 *
 * The box wins whenever it has anything in it. That rule is the whole design —
 * it is what lets both controls stay named, submit together, and behave
 * predictably with no JavaScript at all (see `catalogueValue` for the other
 * half of it). "I typed something here" reads as a deliberate override; a blank
 * box reads as "the list is right".
 *
 * The product's *current* value is added to the list when it is not already in
 * it, so editing a product categorised before this list existed shows that
 * category rather than silently resetting it to whatever is first.
 */
export function CatalogueField({
  id,
  label: text,
  name,
  options,
  value,
  disabled,
  hint,
  placeholder,
}: {
  id: string;
  label: string;
  name: string;
  options: string[];
  value: string | null | undefined;
  disabled?: boolean;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const current = (value ?? "").trim();
  return (
    <Field id={id} label={text} hint={hint}>
      <select style={input} id={id} name={name} disabled={disabled} defaultValue={current}>
        {current === "" ? <option value="">Choose…</option> : null}
        {current !== "" && !options.includes(current) ? (
          <option value={current}>{current}</option>
        ) : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <input
        style={{ ...input, marginTop: "0.3rem" }}
        id={`${id}-new`}
        name={`${name}_new`}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={`New ${text.toLowerCase()} — overrides the list above`}
      />
    </Field>
  );
}

/**
 * Reads a `CatalogueField` back out of a submitted form.
 *
 * Shares the field's one rule so the two routes that use it cannot drift apart:
 * the free-text box if it holds anything, otherwise the list.
 */
export function catalogueValue(form: FormData, name: string): string {
  const typed = String(form.get(`${name}_new`) ?? "").trim();
  if (typed) return typed;
  return String(form.get(name) ?? "").trim();
}

/**
 * A list that grows one box at a time: Features, Materials, and anything else
 * that is a handful of short lines rather than a paragraph.
 *
 * A textarea with "one per line" written underneath asks the writer to hold a
 * format in their head and shows them nothing about the shape of the answer;
 * five boxes show that five things go here and that a sixth is one press away.
 * The entries are still stored one per line, so nothing that already reads
 * these fields — the seller catalog, the marketing pack — has to change.
 *
 * Every box submits under the same name, so the action reads them as an array
 * and `listValue` puts them back together.
 */
export function ListField({
  id,
  label: text,
  name,
  values,
  disabled,
  hint,
  placeholder,
  addLabel = "Add another",
}: {
  id: string;
  label: string;
  name: string;
  /** The stored lines, already split. An empty list still shows one box. */
  values: string[];
  disabled?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  addLabel?: string;
}) {
  const [rows, setRows] = useState(() =>
    (values.length ? values : [""]).map((value, index) => ({ key: index, value }))
  );
  // Keys only have to be unique among the rows on screen, and this counter is
  // what stops React reusing the wrong box when one in the middle is removed.
  const nextKey = useRef(rows.length);

  const add = () => {
    nextKey.current += 1;
    setRows((current) => [...current, { key: nextKey.current, value: "" }]);
  };
  const remove = (key: number) => setRows((current) => current.filter((row) => row.key !== key));
  const change = (key: number, value: string) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, value } : row)));

  return (
    <Field id={id} label={text} hint={hint}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
        {rows.map((row, index) => (
          <div key={row.key} style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
            <input
              style={input}
              id={index === 0 ? id : `${id}-${index}`}
              name={name}
              value={row.value}
              disabled={disabled}
              placeholder={index === 0 ? placeholder : undefined}
              onChange={(event) => change(row.key, event.target.value)}
              aria-label={`${text} ${index + 1}`}
            />
            <button
              type="button"
              onClick={() => remove(row.key)}
              disabled={disabled || rows.length === 1}
              aria-label={`Remove ${text.toLowerCase()} ${index + 1}`}
              style={{
                ...btn("#64748b"),
                padding: "0.35rem 0.55rem",
                // A one-row list has nothing to remove; the control is present
                // so the shape does not jump when a second row appears.
                opacity: rows.length === 1 ? 0.35 : 1,
                cursor: rows.length === 1 ? "not-allowed" : "pointer",
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        style={{ ...btn(INK), marginTop: "0.4rem" }}
      >
        + {addLabel}
      </button>
    </Field>
  );
}

/**
 * Reads a `ListField` back out of a submitted form, in the format the column
 * has always used: one entry per line, blank lines dropped.
 *
 * A pasted paragraph splits on its own newlines rather than becoming one very
 * long feature, so the boxes are a convenience and never a trap.
 */
export function listValue(form: FormData, name: string): string | null {
  const lines = form
    .getAll(name)
    .flatMap((value) => String(value).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

/** The other half: a stored column back into the rows `ListField` draws. */
export function listLines(stored: string | null | undefined): string[] {
  return (stored ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function StatusChip({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    DRAFT: { bg: "#f1f5f9", fg: "#475569" },
    DEFAULT: { bg: "#e0e7ff", fg: "#3730a3" },
    INACTIVE: { bg: "#e2e8f0", fg: "#64748b" },
    // No PENDING_APPROVAL tone: the state is retired and no product carries it
    // after migration 20260925000000. A chip that still coloured it would be
    // the last place in the interface still treating it as a state someone
    // expects to see. The fallback below renders it plainly if a restored
    // database ever produces one.
    PUBLISHED: { bg: "#d1fae5", fg: "#065f46" },
    ARCHIVED: { bg: "#e2e8f0", fg: "#475569" },
    APPROVED: { bg: "#d1fae5", fg: "#065f46" },
    REJECTED: { bg: "#fee2e2", fg: "#991b1b" },
    READY: { bg: "#dbeafe", fg: "#1e40af" },
    PROCESSING: { bg: "#fef3c7", fg: "#92400e" },
    UPLOADING: { bg: "#f1f5f9", fg: "#475569" },
    FAILED: { bg: "#fee2e2", fg: "#991b1b" },
  };
  const tone = palette[status] ?? { bg: "#f1f5f9", fg: "#475569" };
  return (
    <span
      style={{
        background: tone.bg,
        color: tone.fg,
        fontSize: "0.62rem",
        fontWeight: 700,
        letterSpacing: "0.02em",
        padding: "0.15rem 0.4rem",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * An empty state that says what to do next rather than only that there is
 * nothing here. A bare "No media" leaves the reader to work out whether the
 * screen is broken, unfinished or simply new.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        color: MUTED,
        fontSize: "0.82rem",
        background: "#f8fafc",
        border: `1px dashed ${LINE}`,
        borderRadius: 8,
        padding: "1rem",
        margin: 0,
      }}
    >
      {children}
    </p>
  );
}

/** Renders a service error the same way everywhere. */
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        ...card,
        background: "#fef2f2",
        borderColor: "#fecaca",
        color: "#991b1b",
        fontSize: "0.85rem",
      }}
    >
      {message}
    </div>
  );
}

/**
 * A destructive action, asked twice.
 *
 * The first press arms it and the second carries it out, with the question
 * between them naming what is about to go. A browser `confirm()` box would be
 * quicker to write and worse to use: it cannot say which variant, cannot be
 * styled to look like the thing it is about to delete, and blocks the page
 * while it is open.
 *
 * The form is only drawn once armed, so an accidental Enter cannot submit it —
 * there is nothing to submit until somebody has answered the question.
 */
export function ConfirmForm({
  intent,
  fields,
  label,
  question,
  confirmLabel,
  tone = "#991b1b",
}: {
  intent: string;
  /** Hidden values the action needs to identify the target. */
  fields: Record<string, string>;
  /** The first button's text. */
  label: string;
  /** Asked once armed: "Delete this variant? Orders keep their own copy." */
  question: string;
  confirmLabel: string;
  tone?: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button type="button" style={btn(tone)} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }

  return (
    <Form
      method="post"
      style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {/* Announced as well as shown: a reader who cannot see the question
          appear would otherwise press one button and find the file gone. */}
      <span role="status" style={{ fontSize: "0.75rem", color: INK }}>
        {question}
      </span>
      <button type="submit" name="intent" value={intent} style={btn(tone, { solid: true })}>
        {confirmLabel}
      </button>
      <button type="button" style={btn(MUTED)} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </Form>
  );
}

/** Money is stored in integer cents; this is the only place it becomes a string. */
export function money(cents: number | null | undefined, currency = "CAD"): string {
  if (cents === null || cents === undefined) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function centsToInput(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

/**
 * Canonical measurements are centimetres and kilograms. The directive allows
 * the interface to show inches and pounds, so both are offered — but the
 * conversion happens here, in the display layer, and the canonical value in the
 * database is what the metric field submits.
 */
export const CM_PER_INCH = 2.54;
export const KG_PER_POUND = 0.45359237;

export function cmToInches(cm: string | number | null | undefined): string {
  if (cm === null || cm === undefined || cm === "") return "";
  const value = Number(cm);
  if (!Number.isFinite(value)) return "";
  return (value / CM_PER_INCH).toFixed(2);
}

export function kgToPounds(kg: string | number | null | undefined): string {
  if (kg === null || kg === undefined || kg === "") return "";
  const value = Number(kg);
  if (!Number.isFinite(value)) return "";
  return (value / KG_PER_POUND).toFixed(2);
}

/** Seconds to a readable clip length. */
export function duration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
