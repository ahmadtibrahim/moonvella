import { useState } from "react";
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
  padding: "1.5rem",
  marginBottom: "1.5rem",
};

export const input: CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.85rem",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

export const label: CSSProperties = {
  display: "block",
  fontSize: "0.72rem",
  color: MUTED,
  marginBottom: "0.25rem",
};

export const helpText: CSSProperties = {
  fontSize: "0.7rem",
  color: FAINT,
  marginTop: "0.2rem",
  lineHeight: 1.4,
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
  fontSize: "0.75rem",
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

export function StatusChip({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    DRAFT: { bg: "#f1f5f9", fg: "#475569" },
    DEFAULT: { bg: "#e0e7ff", fg: "#3730a3" },
    INACTIVE: { bg: "#e2e8f0", fg: "#64748b" },
    PENDING_APPROVAL: { bg: "#fef3c7", fg: "#92400e" },
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
