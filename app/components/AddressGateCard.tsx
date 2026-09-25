import { Form } from "react-router";

/*
 * One address, its verdict, and what a person can do about it.
 *
 * Shared between the booking screens rather than copied into each, because the
 * copy is where this kind of panel goes wrong: one screen learns to show the
 * reason the booking was refused and the other keeps saying "not validated"
 * with no way forward, and nobody notices until an operator is stuck.
 *
 * GOOGLE'S SUGGESTION IS STILL NOT WRITTEN BY ACCIDENT. Nothing on this panel
 * changes the address by itself: the differences are listed, the address that
 * would be written is shown field by field beside the one that is stored, and
 * the write happens only when somebody presses a button that says what it does.
 * The earlier version of this panel refused to write the suggestion at all, on
 * the grounds that an address which changes because a third party thought it
 * should is an address nobody chose — and that reasoning still holds. What
 * changed is that leaving the operator to retype Google's answer by hand was
 * not a safeguard, it was a transcription step: the correction got typed in
 * with a typo, or not at all, and the address that ended up on the label was
 * neither the one recorded nor the one Google proposed. The apply action is the
 * same decision made once, on the record, with the before and after kept.
 *
 * A SUGGESTION THAT IS NOT CURRENT IS NOT SHOWN. `suggestionCurrent` is the
 * server saying the stored suggestion describes the address as it stands now.
 * When it is false the suggestion belongs to an earlier version of the record
 * and applying it would write stale values over a newer address, so the table
 * is withheld rather than shown with a warning — a warning beside a plausible
 * looking table is a table somebody will act on.
 *
 * The override and apply forms are drawn only for an owner, but that is
 * cosmetic: both rules are enforced in the service against the stored account,
 * so a form posted by anyone else is refused regardless of what this page
 * rendered.
 */

export interface GateDifference {
  component: string;
  entered: string | null;
  suggested: string | null;
}

export interface GateAddress {
  street1: string;
  street2?: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

export interface GateStatus {
  allowed: boolean;
  verdict: string;
  label: string;
  googleValidated: boolean;
  checkedAt: Date | string | null;
  canOverride: boolean;
  blockers: string[];
  differences: GateDifference[];
  suggested?: GateAddress | null;
  /**
   * Whether the stored suggestion describes the address as it stands now.
   * Optional so a caller that predates the field still renders — absent is
   * treated as "not current", which hides the suggestion rather than offering
   * one that may be stale.
   */
  suggestionCurrent?: boolean;
  /** Where Google matched the address, when its answer carried a point. */
  latitude?: number | null;
  longitude?: number | null;
  overrideReason?: string | null;
  overriddenBy?: string | null;
  original?: GateAddress | null;
}

const INK = "#082a4a";
const LINE = "#e2e8f0";
const FAINT = "#64748b";

const chip = (background: string, color: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "0.15rem 0.5rem",
  borderRadius: 999,
  background,
  color,
  fontSize: "0.68rem",
  fontWeight: 600,
});

const helpText: React.CSSProperties = { fontSize: "0.7rem", color: FAINT, margin: "0.35rem 0 0" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.5rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: "0.78rem",
  boxSizing: "border-box",
};
const button = (color: string): React.CSSProperties => ({
  padding: "0.4rem 0.75rem",
  border: `1px solid ${color}`,
  borderRadius: 6,
  background: "white",
  color,
  fontSize: "0.72rem",
  fontWeight: 600,
  cursor: "pointer",
});

/** One line of an address, skipping the parts nobody filled in. */
function addressLine(address: GateAddress | null | undefined): string {
  if (!address) return "—";
  return [
    address.street1,
    address.street2,
    address.city,
    address.province,
    address.postalCode,
    address.country,
  ]
    .filter((part) => part && String(part).trim().length > 0)
    .join(", ");
}

function when(value: Date | string | null): string {
  if (!value) return "never";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" });
}

export function AddressGateCard({
  title,
  subjectType,
  subjectId,
  status,
  isOwner,
  canManage = true,
  editHref,
  editLabel,
  children,
}: {
  title: string;
  subjectType: "PICKUP" | "DELIVERY";
  subjectId: string;
  status: GateStatus;
  isOwner: boolean;
  canManage?: boolean;
  /** Where the address itself is edited, when that is somewhere else. */
  editHref?: string;
  editLabel?: string;
  children?: React.ReactNode;
}) {
  const tone = status.allowed
    ? status.googleValidated
      ? { background: "#dcfce7", color: "#166534" }
      : { background: "#fef3c7", color: "#92400e" }
    : { background: "#fee2e2", color: "#991b1b" };

  return (
    <div
      style={{
        border: `1px solid ${status.allowed ? LINE : "#fecaca"}`,
        borderRadius: 10,
        padding: "0.9rem",
        marginTop: "0.8rem",
        background: status.allowed ? "white" : "#fff7f7",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
        <strong style={{ fontSize: "0.82rem", color: INK }}>{title}</strong>
        <span style={chip(tone.background, tone.color)}>{status.label}</span>
        <span style={{ fontSize: "0.68rem", color: FAINT }}>checked {when(status.checkedAt)}</span>
      </div>

      <p style={{ fontSize: "0.78rem", color: INK, margin: "0.45rem 0 0" }}>
        {addressLine(status.original)}
      </p>

      {/*
        The entered address is shown rather than a summary of the verdict, so
        that "what will be printed on the label" is the thing the verdict is
        read against. A panel that says ACCEPTED without showing what was
        accepted asks the reader to trust it.
      */}
      {status.overrideReason ? (
        <p style={{ ...helpText, marginTop: "0.5rem" }}>
          <strong>Accepted by an owner</strong>
          {status.overriddenBy ? ` (${status.overriddenBy})` : ""}: {status.overrideReason}
        </p>
      ) : null}

      {status.blockers.length > 0 ? (
        <p style={{ fontSize: "0.78rem", color: "#92400e", margin: "0.5rem 0 0" }}>
          {status.blockers.join(" ")}
        </p>
      ) : null}

      {/*
        GOOGLE'S ANSWER IN FULL, THEN COMPONENT BY COMPONENT.
        The table underneath is the part that decides whether to press Apply, so
        it is the part that has to be readable — but a table of five rows is not
        an address somebody can look at and recognise. The whole suggestion is
        printed first, as Google formatted it, and the table says which parts of
        it differ. Both, because either one alone has been the reason a person
        clicked Apply on the wrong address: a bare field list reads as a diff
        against nothing, and a bare sentence hides that the postal code moved.
      */}
      {status.suggestionCurrent && status.suggested && status.differences.length > 0 ? (
        <div style={{ marginTop: "0.6rem", border: `1px solid ${LINE}`, borderRadius: 8, padding: "0.6rem 0.7rem", background: "#f8fafc" }}>
          <p style={{ ...helpText, marginTop: 0 }}>
            <strong style={{ color: INK }}>Address entered:</strong> {addressLine(status.original)}
          </p>
          <p style={{ ...helpText, marginTop: "0.25rem" }}>
            <strong style={{ color: INK }}>Google suggests:</strong>{" "}
            {addressLine(status.suggested)}
          </p>
          {/*
            The coordinates are not an alternative address, they are the evidence
            that Google matched this one to a point on the map rather than to a
            name that reads correctly. Shown only when a check returned them.
          */}
          {typeof status.latitude === "number" && typeof status.longitude === "number" ? (
            <p style={{ ...helpText, marginTop: "0.25rem" }}>
              Google matched this address at {status.latitude.toFixed(6)},{" "}
              {status.longitude.toFixed(6)}.
            </p>
          ) : null}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.76rem", marginTop: "0.45rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: FAINT }}>
                <th style={{ padding: "0.25rem" }}>Field</th>
                <th style={{ padding: "0.25rem" }}>Entered</th>
                <th style={{ padding: "0.25rem" }}>Suggested</th>
              </tr>
            </thead>
            <tbody>
              {status.differences.map((difference, index) => (
                <tr
                  key={`${difference.component}-${index}`}
                  style={
                    difference.component === "postalCode"
                      ? { background: "#fef3c7", fontWeight: 700 }
                      : { background: "#ffffff" }
                  }
                >
                  <td style={{ padding: "0.25rem" }}>{difference.component}</td>
                  <td style={{ padding: "0.25rem" }}>{difference.entered ?? "—"}</td>
                  <td style={{ padding: "0.25rem" }}>{difference.suggested ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/*
        A SUGGESTION THAT IS NOT CURRENT SAYS SO.
        The server withholds the table when the stored suggestion describes an
        older version of the address (see `suggestionCurrent`), which is right —
        but a panel that silently shows nothing reads as "Google had no
        complaint", and the operator stops looking. So the absence is explained,
        with the one action that resolves it.
      */}
      {status.differences.length === 0 && !status.suggestionCurrent && status.checkedAt ? (
        <p style={{ ...helpText, marginTop: "0.5rem" }}>
          This address has changed since it was last checked, so the earlier suggestion no longer
          describes it and is not shown. Check it again to compare.
        </p>
      ) : null}

      {/*
        The write itself, and the only place on this panel that changes anything.
        The list is the before-and-after rather than a count of changes: an
        operator agreeing to "3 changes" is agreeing to something they have not
        read, and the postal code is the one that quietly puts a parcel in the
        wrong city, so it is called out.
      */}
      {canManage && isOwner && status.suggestionCurrent && status.suggested && status.differences.length > 0 ? (
        <Form method="post" style={{ marginTop: "0.7rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.7rem" }}>
          <input type="hidden" name="subjectType" value={subjectType} />
          <input type="hidden" name="subjectId" value={subjectId} />
          <p style={{ fontSize: "0.72rem", color: INK, margin: 0, fontWeight: 600 }}>
            Applying writes these values to the stored address:
          </p>
          <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", fontSize: "0.74rem", color: INK }}>
            {status.differences.map((difference, index) => (
              <li
                key={`apply-${difference.component}-${index}`}
                style={difference.component === "postalCode" ? { fontWeight: 700 } : undefined}
              >
                {difference.component}: {difference.entered ?? "—"} →{" "}
                <strong>{difference.suggested ?? "—"}</strong>
              </li>
            ))}
          </ul>
          <p style={helpText}>
            Fields Google did not ask to change are left exactly as entered, including the unit.
            The address is saved and then checked with Google: if that check cannot be made, the
            correction stays saved and the booking stays blocked.
          </p>
          <button
            type="submit"
            name="intent"
            value="apply_suggestion"
            style={{ ...button(INK), marginTop: "0.4rem" }}
          >
            Apply Google suggestion and save
          </button>
          {/*
            The other decision, and it has to be offered next to this one. An
            operator who does not want Google's version is not asking for the
            suggestion to be applied — they are saying the entered address is the
            right one, which is the override below, recorded with a reason and a
            name. Naming it here rather than leaving the panel to imply that
            "Apply" is the only way forward is the difference between an owner
            accepting an address on purpose and an owner accepting it because
            the panel offered nothing else.
          */}
          {status.canOverride && isOwner ? (
            <p style={helpText}>
              Prefer the address as entered? Keep it with{" "}
              <strong>Keep the entered address</strong> below — an owner records why, and the
              address stays exactly as it is.
            </p>
          ) : null}
        </Form>
      ) : null}

      {children}

      {canManage ? (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <Form method="post">
            <input type="hidden" name="subjectType" value={subjectType} />
            <input type="hidden" name="subjectId" value={subjectId} />
            <button type="submit" name="intent" value="check_address" style={button(INK)}>
              {status.checkedAt ? "Check again with Google" : "Check address with Google"}
            </button>
          </Form>
          {editHref ? (
            <a href={editHref} style={{ fontSize: "0.72rem", color: INK }}>
              {editLabel ?? "Edit the address"}
            </a>
          ) : null}
        </div>
      ) : null}

      {canManage && status.canOverride && isOwner ? (
        <Form method="post" style={{ marginTop: "0.85rem", borderTop: `1px solid ${LINE}`, paddingTop: "0.7rem" }}>
          <input type="hidden" name="subjectType" value={subjectType} />
          <input type="hidden" name="subjectId" value={subjectId} />
          <label style={{ fontSize: "0.68rem", color: FAINT, display: "block" }} htmlFor={`reason-${subjectType}-${subjectId}`}>
            Owner: accept this address without Google
          </label>
          <input
            id={`reason-${subjectType}-${subjectId}`}
            name="reason"
            style={input}
            placeholder="Why this address is known to be correct (at least 10 characters)"
          />
          <p style={helpText}>
            Recorded as accepted by an owner, never as validated by Google. Your name, the reason
            and the address as it stands are kept in the audit log — this is the one route by which
            an unchecked address reaches a carrier, and booking will not proceed without it.
          </p>
          <button type="submit" name="intent" value="override_address" style={{ ...button("#b45309"), marginTop: "0.4rem" }}>
            Keep the entered address
          </button>
        </Form>
      ) : null}

      {canManage && status.canOverride && !isOwner ? (
        <p style={{ ...helpText, marginTop: "0.7rem" }}>
          This address has to be accepted by an owner before the booking will go through. Anyone
          can check it with Google; only an owner can accept it without Google.
        </p>
      ) : null}
    </div>
  );
}
