import type { ProgressStage, ProgressState } from "~/services/orderProgress.server";

/**
 * The six stages of a parcel, drawn left to right.
 *
 * WHY IT IS A STRIP AND NOT A STATUS WORD. An operator asking "where is this
 * order" is not asking for one word — they are asking what has happened, when,
 * and by whom, and what happens next. Six stages in physical order answer all
 * four questions at a glance, and the timestamp and the name under each stage
 * are what turn "Packed" from a claim into a record.
 *
 * WHAT IT WILL NOT DO: offer a retry of its own. The retry on a failed stage is
 * a LINK to the action that already exists on the page — the confirmation panel
 * for a booking, the shipment card for a tracking push — because a retry that
 * posts its own form is a second way to spend money, and on this app that is the
 * exact defect the confirmation panel was introduced to remove. The one retry
 * that gets no link at all is an unanswered booking: there is no safe action to
 * offer, and a button there would be offering a second label.
 *
 * Colour is never the only signal. Each state also carries a word — "Waiting",
 * "Not yet", "Failed", "Check" — because a strip that means something only when
 * it is green is a strip that means nothing to a colour-blind operator.
 */

const TONE: Record<ProgressState, { dot: string; ring: string; text: string; word: string }> = {
  done: { dot: "#059669", ring: "#a7f3d0", text: "#065f46", word: "Done" },
  current: { dot: "#0369a1", ring: "#bae6fd", text: "#075985", word: "Waiting" },
  pending: { dot: "#cbd5e1", ring: "#e2e8f0", text: "#64748b", word: "Not yet" },
  failed: { dot: "#dc2626", ring: "#fecaca", text: "#991b1b", word: "Failed" },
  unknown: { dot: "#d97706", ring: "#fde68a", text: "#92400e", word: "Check" },
};

/** Where each kind of retry lives on the page that draws this. */
const RETRY_HREF: Record<string, string> = {
  booking: "#book-shipment",
  shopify_sync: "#shipments",
};

function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * One stage out of a strip, for a page that wants to state its detail on its own.
 *
 * It exists so the two screens that talk about the Shopify push — the order page
 * and the shipment page — do not each decide when a parcel is "waiting for
 * dispatch". That rule has a subtle case (a parcel already handed over is not
 * waiting, it is overdue) and a second copy of it is a second answer.
 */
export function stageByKey(stages: ProgressStage[], key: string): ProgressStage | null {
  return stages.find((stage) => stage.key === key) ?? null;
}

export function OrderProgress({ stages, title }: { stages: ProgressStage[]; title?: string }) {
  return (
    <div>
      {title ? <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>{title}</div> : null}
      <ol
        style={{
          display: "flex",
          gap: 0,
          listStyle: "none",
          margin: 0,
          padding: 0,
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        {stages.map((stage, index) => {
          const tone = TONE[stage.state];
          return (
            <li key={stage.key} style={{ flex: "1 1 0", minWidth: 130, position: "relative", paddingRight: "0.35rem" }}>
              {/* The connector between stages, drawn behind the dot. It stops at
                  the last stage rather than running off the edge. */}
              {index < stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 7,
                    left: "50%",
                    right: "-50%",
                    height: 2,
                    background: stage.state === "done" ? "#a7f3d0" : "#e2e8f0",
                  }}
                />
              ) : null}
              <span
                aria-hidden="true"
                style={{
                  position: "relative",
                  display: "block",
                  width: 14,
                  height: 14,
                  margin: "0 auto 0.35rem",
                  borderRadius: "50%",
                  background: tone.dot,
                  border: `3px solid ${tone.ring}`,
                  boxSizing: "content-box",
                }}
              />
              <div style={{ textAlign: "center", fontSize: "0.7rem", fontWeight: 600, color: tone.text, lineHeight: 1.25 }}>
                {stage.label}
              </div>
              <div style={{ textAlign: "center", fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.06em", color: tone.text, textTransform: "uppercase", marginTop: "0.1rem" }}>
                {tone.word}
              </div>
              {/*
                The record: when, and who. Both are absent rather than guessed —
                an audit row that has been pruned or a stage performed by a
                background job has no actor, and inventing "system" for it would
                be inventing a fact about who did something.
              */}
              {stage.at ? <div style={{ textAlign: "center", fontSize: "0.62rem", color: "#64748b", marginTop: "0.15rem" }}>{when(stage.at)}</div> : null}
              {stage.actor ? <div style={{ textAlign: "center", fontSize: "0.62rem", color: "#475569" }}>by {stage.actor}</div> : null}
              {stage.detail ? (
                <div style={{ textAlign: "center", fontSize: "0.62rem", color: tone.text, marginTop: "0.2rem", lineHeight: 1.35 }}>{stage.detail}</div>
              ) : null}
              {/*
                The retry. `reconcile` is deliberately rendered as a note with no
                link: the only safe answer to an unanswered booking is a human
                looking at the carrier's own records, and the note says so.
              */}
              {stage.retry ? (
                <div style={{ textAlign: "center", marginTop: "0.3rem" }}>
                  {RETRY_HREF[stage.retry.kind] ? (
                    <a
                      href={RETRY_HREF[stage.retry.kind]}
                      style={{
                        display: "inline-block",
                        padding: "0.2rem 0.5rem",
                        border: `1px solid ${tone.dot}`,
                        borderRadius: 6,
                        color: tone.text,
                        fontSize: "0.65rem",
                        fontWeight: 600,
                        textDecoration: "none",
                      }}
                      title={stage.retry.note}
                    >
                      {stage.retry.label} &darr;
                    </a>
                  ) : (
                    <div style={{ fontSize: "0.62rem", color: "#92400e", fontWeight: 600 }}>{stage.retry.label}</div>
                  )}
                  <div style={{ fontSize: "0.6rem", color: "#64748b", marginTop: "0.2rem", lineHeight: 1.3 }}>{stage.retry.note}</div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
