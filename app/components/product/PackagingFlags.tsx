/**
 * THE TWO BOXES THAT SAY HOW A CARTON TRAVELS.
 *
 * They are one control because they are one decision seen from two sides, and
 * the page has to make that visible rather than leaving it to a validation
 * message after the save.
 *
 *   SHIPS SEPARATELY — this box is packed and collected on its own. It is the
 *   default for a new carton, because "one item, its own box" is how this
 *   catalogue ships and the opposite default meant every new carton silently
 *   invited itself to be merged with any other.
 *
 *   MAY CONSOLIDATE — this box is allowed to share a parcel with others. It is
 *   OFF by default and it is not a second opinion about the first box: a carton
 *   that ships separately is never merged, so the second control cannot say
 *   otherwise while the first is on.
 *
 * WHICH IS WHY IT GOES DISABLED RATHER THAN STAYING CLICKABLE. Two checkboxes
 * that contradict each other and are both operable are two checkboxes that will
 * eventually both be set — the state the database now refuses, and the state an
 * operator would have had to reason about to avoid. The second box turns grey,
 * unchecks itself, and the sentence beside it says why. A disabled checkbox
 * submits nothing, so the server never receives a contradictory pair to
 * interpret; it applies the same rule again on the way in, because a form is not
 * the only thing that can post to an action.
 *
 * The state is local and starts from the row, so a refusal that puts the
 * submission back on the screen draws these as they were sent — the row is
 * re-keyed when that happens, which remounts this component and re-seeds it.
 */
import { useState } from "react";

const CELL: React.CSSProperties = { padding: "0.2rem", textAlign: "center" };
const NOTE: React.CSSProperties = { display: "block", fontSize: "0.62rem", color: "#64748b" };

export function PackagingFlags({
  index,
  shipsSeparately,
  consolidatable,
  disabled,
}: {
  index: number;
  shipsSeparately: boolean;
  consolidatable: boolean;
  /** Set when the operator may not change packaging at all. */
  disabled?: boolean;
}) {
  const [ships, setShips] = useState(shipsSeparately);
  const [mayMerge, setMayMerge] = useState(consolidatable);
  const merge = ships ? false : mayMerge;

  return (
    <>
      <td style={CELL}>
        <input
          type="checkbox"
          name={`pkg_shipsSeparately_${index}`}
          value="true"
          checked={ships}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.checked;
            setShips(next);
            // Turning this on withdraws the permission next door rather than
            // leaving it set and hidden — the operator can see the consequence
            // of what they just did instead of finding it in the next save.
            if (next) setMayMerge(false);
          }}
          aria-label={`Carton ${index + 1} ships separately`}
        />
        <span style={NOTE}>own box</span>
      </td>
      <td style={CELL}>
        <input
          type="checkbox"
          name={`pkg_consolidatable_${index}`}
          value="true"
          checked={merge}
          disabled={disabled || ships}
          onChange={(event) => setMayMerge(event.target.checked)}
          aria-label={`Carton ${index + 1} may be consolidated`}
          title={
            ships
              ? "A carton that ships separately is never merged."
              : "This carton may share a parcel with others."
          }
        />
        <span style={NOTE}>{ships ? "never merged" : "may share"}</span>
      </td>
    </>
  );
}
