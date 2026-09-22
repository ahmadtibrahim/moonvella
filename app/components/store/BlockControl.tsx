import { useEffect, useId, useState } from "react";

/**
 * Block, unblock, and the confirmation in front of them.
 *
 * WHY THIS IS A MODAL AND NOT `window.confirm()`. Delete in the product list
 * used to call `confirm()` and the owner reported it as broken, because it
 * was: once Chrome is told to "prevent this page from creating additional
 * dialogs", every later `confirm()` returns false *without appearing*, so the
 * button is dead and nothing on the page explains why. Anything destructive in
 * this panel asks in the page, where a suppressed question cannot silently
 * become a "no".
 *
 * The question is also long enough that a native dialog would truncate it, and
 * what it asks is not "are you sure" — it is a specific statement of what the
 * store loses and what it keeps, which the operator should be able to read
 * before answering.
 *
 * BLOCK IS OFFERED ONLY WHERE IT MEANS SOMETHING. A rejected or uninstalled
 * store has no access left to take away, so the control is disabled there with
 * the reason rather than hidden — a control that vanishes when you look for it
 * teaches nothing.
 */

/** The statuses a block can actually affect. */
const BLOCKABLE = ["APPROVED", "PENDING", "NEEDS_INFO"];

function btn(color: string, solid = false): React.CSSProperties {
  return {
    padding: "0.4rem 0.75rem",
    border: `1px solid ${color}`,
    borderRadius: 6,
    background: solid ? color : "white",
    color: solid ? "white" : color,
    fontSize: "0.72rem",
    fontWeight: 600,
    cursor: "pointer",
  };
}

/**
 * The question, in the owner's words, split at the question mark so it can be
 * a heading and a sentence. Rendered together they are the exact text: "Block
 * this seller? They will lose access to pricing, imports, and order sync, but
 * history will remain."
 */
const QUESTION = "Block this seller?";
const CONSEQUENCE =
  "They will lose access to pricing, imports, and order sync, but history will remain.";

export function BlockControl({
  sellerId,
  status,
  reasonField = true,
}: {
  sellerId: string;
  status: string;
  /** The detail page already renders a reason box above; do not draw a second. */
  reasonField?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const reasonId = useId();

  // Escape closes. A modal that can only be dismissed by finding the right
  // button is a modal somebody leaves open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (status === "BLOCKED") {
    return (
      <button
        type="submit"
        name="intent"
        value="unblock"
        style={btn("#059669")}
        title="Lift the block. The store returns to the status it held before it was blocked."
      >
        Unblock
      </button>
    );
  }

  const blockable = BLOCKABLE.includes(status);

  return (
    <>
      <button
        type="button"
        onClick={() => blockable && setOpen(true)}
        disabled={!blockable}
        style={
          blockable
            ? btn("#7f1d1d")
            : { ...btn("#7f1d1d"), color: "#cbd5e1", borderColor: "#e2e8f0", cursor: "not-allowed" }
        }
        title={
          blockable
            ? "Refuse this store: no pricing, no imports, no new orders, no sync. Its history stays with MoonVella."
            : `A ${status.toLowerCase()} store has no access left to block.`
        }
      >
        Block
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(event) => {
            // Only the backdrop itself — a click that started inside the panel
            // and ended on the backdrop is not a dismissal.
            if (event.target === event.currentTarget) setOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "white",
              borderRadius: 12,
              padding: "1.5rem",
              maxWidth: 460,
              width: "100%",
              boxShadow: "0 20px 50px rgba(15, 23, 42, 0.3)",
            }}
          >
            <h2
              id={titleId}
              style={{ fontSize: "1.1rem", fontWeight: 700, color: "#7f1d1d", marginBottom: "0.5rem" }}
            >
              {QUESTION}
            </h2>
            <p style={{ color: "#334155", fontSize: "0.85rem", lineHeight: 1.5, marginBottom: "1rem" }}>
              {CONSEQUENCE}
            </p>

            {reasonField && (
              <label
                htmlFor={reasonId}
                style={{ display: "block", fontSize: "0.72rem", color: "#64748b", marginBottom: "0.35rem" }}
              >
                Reason (kept on the store&rsquo;s record)
              </label>
            )}
            {reasonField && (
              <input
                id={reasonId}
                type="text"
                name="reason"
                placeholder="e.g. unpaid invoices"
                style={{
                  width: "100%",
                  padding: "0.5rem 0.6rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  fontSize: "0.8rem",
                  marginBottom: "1.25rem",
                }}
              />
            )}

            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              {/* Focus lands on Cancel, not on the button that does the thing. */}
              <button type="button" autoFocus onClick={() => setOpen(false)} style={btn("#64748b")}>
                Cancel
              </button>
              <button type="submit" name="intent" value="block" style={btn("#7f1d1d", true)}>
                Block store
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
