/**
 * THE CLIENT HALF OF "A CARTON IS STORED AS IT WAS TYPED, IN THE UNIT IT WAS
 * TYPED IN".
 *
 * A packaging row keeps its own unit beside its numbers, and a shipping quote
 * converts once when it reads them. The admin now shows every row in the ONE
 * unit the Settings page sets, which puts the displayed figure and the stored
 * figure in different units — so something has to translate on the way out, and
 * this is that something.
 *
 * WHY IT REWRITES RATHER THAN DISABLES. The variant measurements next door solve
 * the same problem by disabling an untouched input, which removes it from the
 * submission and lets the route keep what is stored. That works because each
 * measurement is its own field. A carton row cannot do it: its values are
 * parallel arrays that the action zips by index, and a row with three fields
 * disabled and one enabled would still occupy a slot — the field is not the
 * unit, so a disabled field cannot express "this row was not touched, save it
 * exactly as it was".
 *
 * So the rule here is the other one, and it is applied per ROW:
 *
 *   NOTHING IN THE ROW WAS EDITED — every visible figure is put back to the
 *   value the row is stored with, and the row's unit stays the unit that value
 *   is in. The whole-set replace then recreates the row byte for byte, and a
 *   saved carton is never round-tripped through a display conversion just
 *   because somebody opened the page.
 *
 *   SOMETHING IN THE ROW WAS EDITED — the row is being recorded in the unit
 *   that is on screen, so the hidden unit follows it, and the figures the
 *   operator did NOT edit are re-expressed in that unit WITHOUT ROUNDING. That
 *   last part is the one that matters: the field shows 11.81 in for a 30 cm
 *   carton, and submitting the number that is displayed would store 29.9974 cm.
 *   Nobody would notice, and the carton would be quietly wrong. The value
 *   submitted is the exact conversion of what is stored, so the quantity is the
 *   one that was measured.
 *
 * Both functions are called from the form's own handlers, which react-router
 * runs BEFORE it serialises the form — the same reliance `VariantsTab`'s
 * `preserveUntouchedMeasurements` documents. Nothing here reads the network,
 * the database or the preference: every unit it needs is on the row it is
 * looking at.
 *
 * A "ROW" IS ANY ELEMENT CARRYING `data-pkg-row`, not a `<tr>` specifically. The
 * packaging editors group theirs in a table row; the page that edits a saved
 * pack wraps its measurements in a plain `<div>` and gets the same treatment,
 * because a pack's figures are the same kind of figure and must not move when
 * somebody opens the form and saves it again. Its unit fields are named the same
 * way for the same reason.
 */
import type { FormEvent } from "react";
import {
  convertedDisplay,
  convertedExact,
  type MeasureKind,
} from "~/utils/measurementUnits";

const DIMENSIONS = ["length", "width", "height"] as const;

function isMeasureKind(value: string | undefined): value is MeasureKind {
  return value === "length" || value === "weight";
}

/**
 * The unit this row is being SHOWN in, which is the unit an edited row is
 * stored in. It is on the row rather than read from anywhere else so that a
 * form opened before the preference changed still submits what its labels say.
 */
function shownUnit(row: HTMLElement, kind: MeasureKind): string {
  return (kind === "length" ? row.dataset.globalDim : row.dataset.globalWeight) ?? "";
}

function unitField(row: HTMLElement, name: string): HTMLInputElement | null {
  return row.querySelector<HTMLInputElement>(`input[name="${name}"]`);
}

/**
 * Every measurement of the row, found by the marker rather than by name.
 *
 * Names are the form's business — a carton row submits `pkg_length` and a pack
 * submits `length` — and matching on them here would make this module the second
 * place a field name is written down. The marker plus the row is enough to
 * identify a field, and the kind is what decides its unit.
 */
function measureInputs(row: HTMLElement): HTMLInputElement[] {
  return Array.from(row.querySelectorAll<HTMLInputElement>("input[data-kind]"));
}

/**
 * See the header. Wired as the packaging forms' `onSubmit`.
 */
export function preservePackagingRows(event: FormEvent<HTMLFormElement>) {
  const form = event.currentTarget;

  for (const row of form.querySelectorAll<HTMLElement>("[data-pkg-row]")) {
    const fields = measureInputs(row);
    if (fields.length === 0) continue;

    const edited = fields.some((field) => field.value !== (field.dataset.original ?? ""));

    if (!edited) {
      for (const field of fields) field.value = field.dataset.stored ?? "";
      continue;
    }

    /*
     * The unit fields move with the row, and they move for BOTH kinds even when
     * only one figure was touched — the row is stored as a whole, and a row
     * whose length is in inches and whose weight is in kilograms would be a row
     * whose weight nobody can read.
     */
    const dimensionUnit = shownUnit(row, "length");
    const weightUnit = shownUnit(row, "weight");
    const dimensionField = unitField(row, "pkg_dimUnit");
    const weightField = unitField(row, "pkg_weightUnit");
    if (dimensionField) dimensionField.value = dimensionUnit;
    if (weightField) weightField.value = weightUnit;

    for (const field of fields) {
      if (field.value !== (field.dataset.original ?? "")) continue;
      const kind = field.dataset.kind;
      if (!isMeasureKind(kind)) continue;
      field.value = convertedExact(
        field.dataset.stored,
        field.dataset.storedUnit ?? "",
        shownUnit(row, kind),
        kind,
      );
    }
  }
}

/**
 * Put a saved pack's measurements into the row the pack was chosen for.
 *
 * THREE DIMENSIONS ONLY, AND NEVER THE WEIGHT. That is the owner's rule and it
 * is also the true one: a pack describes the empty box, and the gross weight of
 * a parcel depends on what is inside it, which differs for every variant. A
 * weight copied from a pack would be a number about nothing.
 *
 * The filled fields are given the DISPLAY value to show and the EXACT value to
 * submit, so choosing a pack cannot drift the carton either — see the header.
 * The DIMENSION unit follows the fill, because the figures on screen are now in
 * the unit the pack was converted into and they are going to be stored in it.
 * The weight keeps everything it had, unit included: it was not touched, and a
 * field left alone is a field left alone. A row may therefore hold its
 * dimensions in inches and its weight in kilograms, which is a state the
 * editors have always allowed — each field carries its own unit — and which the
 * next edit of that row unifies when it re-records the row in the admin's unit.
 */
export function fillPackagingRow(select: HTMLSelectElement) {
  const row = select.closest<HTMLElement>("[data-pkg-row]");
  if (!row) return;

  // A blank choice unlinks the row from the pack and leaves its numbers alone:
  // removing a reference is not the same decision as erasing a measurement.
  const option = select.selectedOptions[0];
  if (!option || select.value === "") return;

  const packUnit = option.dataset.unit ?? "";
  const shown = shownUnit(row, "length");

  for (const dimension of DIMENSIONS) {
    const raw = option.dataset[dimension] ?? "";
    // A pack is stored with every dimension filled — the service refuses one
    // that is not — so this only guards a hand-edited document.
    if (raw === "") continue;

    const field = row.querySelector<HTMLInputElement>(`input[name="pkg_${dimension}"]`);
    if (!field) continue;

    const display = convertedDisplay(raw, packUnit, shown, "length");
    field.value = display;
    field.dataset.original = display;
    field.dataset.stored = convertedExact(raw, packUnit, shown, "length");
    field.dataset.storedUnit = shown;
  }

  const dimensionField = unitField(row, "pkg_dimUnit");
  if (dimensionField) dimensionField.value = shown;
}
