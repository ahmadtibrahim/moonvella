import { Form, Link, useActionData, useLoaderData, useSearchParams } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import {
  PresetValidationError,
  createPreset,
  deletePreset,
  listPresetsAll,
  setPresetActive,
  updatePreset,
} from "~/services/packaging.server";
import { getUnitsPreference } from "~/services/adminPreferences.server";
import { convertedDisplay, isUnitPreference, unitsView } from "~/utils/measurementUnits";
import {
  INK,
  MUTED,
  FAINT,
  card,
  input,
  label,
  helpText,
  btn,
  sectionTitle,
  sectionNote,
  EmptyState,
  ErrorBanner,
  ConfirmForm,
} from "~/components/product/ui";
import { preservePackagingRows } from "~/components/product/packagingRows";
import { PackagingValue } from "~/components/product/PackagingValue";

/**
 * THE BOXES THE OPERATOR ACTUALLY SHIPS IN, RECORDED ONCE.
 *
 * A carton is measured the same way for every variant that travels in it, and
 * typing those three numbers onto each variant is how a catalogue ends up with
 * two slightly different "medium boxes" and a quote that depends on which one
 * somebody picked. A pack is that box recorded once here, offered as a choice on
 * every packaging row.
 *
 * WHAT A PACK IS NOT: it is not a weight. It carries what the EMPTY box weighs
 * and the most it may hold, and both are facts about the box; the gross weight of
 * a parcel depends on what is inside it and stays on the row. Selecting a pack
 * therefore fills in the dimensions and nothing else.
 *
 * RETIRING IS NOT DELETING, AND NEITHER ONE DAMAGES A CARTON. A retired pack
 * disappears from the dropdowns but stays on the rows that already chose it,
 * marked as retired. Deleting one is offered with a second press because it is
 * permanent, and it is safe for the same reason: the dimensions were COPIED onto
 * each row when the pack was chosen, so the row keeps them and only the link is
 * severed (the foreign key is ON DELETE SET NULL).
 *
 * THE NUMBERS ARE STORED IN THE UNIT THEY WERE TYPED IN. "30 × 20 × 15" is saved
 * as those figures and the unit beside them, exactly as a carton row is, so a
 * pack entered in centimetres reads correctly on a page set to inches and its
 * stored measurements never move when the setting does.
 */

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "products.view");
  const url = new URL(request.url);

  const preference = await getUnitsPreference();
  const presets = await listPresetsAll();

  return {
    presets,
    units: unitsView(preference),
    editingId: url.searchParams.get("pack") ?? "",
    isNew: url.searchParams.get("new") === "1",
  };
}

export interface PackagingActionData {
  ok?: boolean;
  error?: string;
  message?: string;
}

export async function action({ request }: ActionFunctionArgs): Promise<PackagingActionData> {
  assertSameOrigin(request);
  const user = await requirePermission(request, "products.manage");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = {
    actorType: "ADMIN_USER" as const,
    actorId: user.id,
    actorName: user.name,
    ipAddress: ip,
    userAgent,
  };

  /**
   * The unit this form was drawn in, which is the unit its numbers are in.
   *
   * Carried back on submit for the same reason the product forms carry it: a
   * preference changed in another tab must not reinterpret a number somebody
   * typed while looking at a label in the old unit.
   *
   * The two unit fields beside the measurements are NOT read from here. They are
   * what the submit handler leaves behind — the unit the form was drawn in when
   * something was edited, and the unit the pack is already stored in when
   * nothing was — and the preference is only the fallback for a form that
   * arrived without them.
   */
  const submitted = form.get("units");
  const preference = isUnitPreference(submitted) ? submitted : await getUnitsPreference();
  const view = unitsView(preference);

  const text = (name: string) => String(form.get(name) ?? "").trim();

  try {
    switch (intent) {
      case "save_pack": {
        const editingId = text("packId");
        const values = {
          name: text("name"),
          packageType: text("packageType") || "carton",
          length: text("length"),
          width: text("width"),
          height: text("height"),
          dimensionUnit: text("pkg_dimUnit") || view.dimensionUnit,
          emptyWeight: text("emptyWeight"),
          weightUnit: text("pkg_weightUnit") || view.weightUnit,
          maxWeight: text("maxWeight"),
          // The hidden field is what makes "unchecked" distinguishable from
          // "not asked": without it an absent checkbox would read as active and
          // an operator could not retire a pack by unchecking the box.
          isActive: form.getAll("isActive").includes("true"),
        };

        const saved = editingId
          ? await updatePreset(editingId, values, actor)
          : await createPreset(values, actor);

        return { ok: true, message: `"${saved.name}" is saved.` };
      }

      case "set_active": {
        const packId = text("packId");
        const isActive = text("active") === "true";
        const saved = await setPresetActive(packId, isActive, actor);
        return {
          ok: true,
          message: isActive
            ? `"${saved.name}" is offered on packaging rows again.`
            : `"${saved.name}" is retired. Cartons already using it keep it, and it can no longer be chosen for a new one.`,
        };
      }

      case "delete_pack": {
        const packId = text("packId");
        const name = text("name");
        const { rowsThatKeptTheirNumbers } = await deletePreset(packId, actor);
        return {
          ok: true,
          message:
            rowsThatKeptTheirNumbers > 0
              ? `"${name}" is deleted. ${rowsThatKeptTheirNumbers} carton row${rowsThatKeptTheirNumbers === 1 ? "" : "s"} had chosen it and keep${rowsThatKeptTheirNumbers === 1 ? "s" : ""} the measurements it filled in.`
              : `"${name}" is deleted.`,
        };
      }

      default:
        return { ok: false, error: "Unknown action." };
    }
  } catch (error) {
    if (error instanceof PresetValidationError) {
      return { ok: false, error: error.problems.join(". ") + "." };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Operation failed." };
  }
}

export default function AdminPackaging() {
  const { presets, units, editingId, isNew } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [params] = useSearchParams();

  const editing = editingId || params.get("pack") || "";
  const selected = presets.find((preset) => preset.id === editing) ?? null;
  const open = isNew || Boolean(selected);

  return (
    <div style={{ padding: "2rem", maxWidth: 1100 }}>
      <h1 style={{ fontSize: "1.4rem", color: INK, marginBottom: "0.35rem" }}>Packaging</h1>
      <p style={{ ...sectionNote, maxWidth: 800 }}>
        The boxes and mailers used to ship an order. Save a size here once and it can be chosen on
        any carton row instead of being measured again for every variant. A pack records the empty
        box &mdash; its dimensions, what it weighs empty and the most it may hold. The gross weight
        of a parcel is a fact about what is inside it, so it stays on the variant.
      </p>

      {actionData?.error ? <ErrorBanner message={actionData.error} /> : null}
      {actionData?.ok && actionData.message ? (
        <div
          role="status"
          style={{
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            color: "#065f46",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.82rem",
          }}
        >
          {actionData.message}
        </div>
      ) : null}

      <p style={{ marginBottom: "1rem" }}>
        <Link to={isNew ? "?" : "?new=1"} style={{ ...btn(INK, { solid: !isNew }), lineHeight: "1.4" }}>
          {isNew ? "Cancel" : "Add a pack"}
        </Link>
      </p>

      {open ? <PackForm preset={selected} units={units} /> : null}

      {presets.length === 0 ? (
        <EmptyState>
          No packs yet. Nothing is broken without them &mdash; every carton row can still be measured
          by hand &mdash; but a box that ships on more than one variant is measured once here instead
          of on each of them.
        </EmptyState>
      ) : (
        presets.map((preset) => (
          <PackCard
            key={preset.id}
            // The row's own unit is what its numbers are in; the page's unit is
            // what they are read in.
            preset={preset}
            units={units}
            isEditing={editing === preset.id}
          />
        ))
      )}
    </div>
  );
}

type PresetRow = Awaited<ReturnType<typeof loader>>["presets"][number];
type Units = Awaited<ReturnType<typeof loader>>["units"];

function PackCard({
  preset,
  units,
  isEditing,
}: {
  preset: PresetRow;
  units: Units;
  isEditing: boolean;
}) {
  const usage = preset._count.packages + preset._count.productPackages;
  const dims = (["length", "width", "height"] as const)
    .map((dimension) => convertedDisplay(preset[dimension], preset.dimensionUnit, units.dimensionUnit, "length"))
    .join(" × ");
  const empty = convertedDisplay(preset.emptyWeight, preset.weightUnit, units.weightUnit, "weight");
  const max = convertedDisplay(preset.maxWeight, preset.weightUnit, units.weightUnit, "weight");

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: INK }}>{preset.name}</span>
            <code style={{ fontSize: "0.75rem", color: MUTED }}>{preset.packageType}</code>
            {!preset.isActive ? (
              <span
                style={{
                  display: "inline-block",
                  padding: "0.1rem 0.45rem",
                  borderRadius: 999,
                  border: "1px solid #fde68a",
                  background: "#fffbeb",
                  color: "#b45309",
                  fontSize: "0.68rem",
                  fontWeight: 700,
                }}
              >
                Retired
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: "0.8rem", color: MUTED, marginTop: "0.3rem" }}>
            {dims} {units.dimensionUnit}
            {empty ? ` · empty ${empty} ${units.weightUnit}` : ""}
            {max ? ` · holds up to ${max} ${units.weightUnit}` : ""}
          </div>
          <div style={{ fontSize: "0.72rem", color: FAINT, marginTop: "0.25rem" }}>
            {usage === 0
              ? "Not used on any carton row yet."
              : `Used on ${usage} carton row${usage === 1 ? "" : "s"}.`}
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
          <Link
            to={isEditing ? "?" : `?pack=${preset.id}`}
            style={{ ...btn(MUTED), lineHeight: "1.2" }}
          >
            {isEditing ? "Close" : "Edit"}
          </Link>
          <Form method="post">
            <input type="hidden" name="intent" value="set_active" />
            <input type="hidden" name="packId" value={preset.id} />
            <input type="hidden" name="active" value={preset.isActive ? "false" : "true"} />
            <button type="submit" style={btn(MUTED)}>
              {preset.isActive ? "Retire" : "Offer again"}
            </button>
          </Form>
          <ConfirmForm
            intent="delete_pack"
            fields={{ packId: preset.id, name: preset.name }}
            label="Delete"
            question={`Delete "${preset.name}"? Carton rows that chose it keep the measurements it filled in — the numbers were copied onto the row, not looked up from the pack.`}
            confirmLabel="Delete this pack"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The form a pack is created or changed with.
 *
 * Every measurement is typed in the unit the page is in, and saved with that
 * unit beside it — the same rule the carton rows follow, so a pack entered here
 * and a carton typed onto a variant are stored the same way and neither is
 * reinterpreted when the setting changes.
 */
function PackForm({ preset, units }: { preset: PresetRow | null; units: Units }) {
  /*
   * The unit this pack's figures are STORED in, which is the unit an untouched
   * form saves them back in. It is the pack's own unit on an edit and the page's
   * on a new pack, because a new pack has nothing stored yet.
   */
  const storedDimensionUnit = preset?.dimensionUnit ?? units.dimensionUnit;
  const storedWeightUnit = preset?.weightUnit ?? units.weightUnit;

  return (
    <div style={{ ...card, borderColor: INK }}>
      <h2 style={sectionTitle}>{preset ? `Editing ${preset.name}` : "New pack"}</h2>
      <p style={{ ...sectionNote, marginBottom: "0.85rem" }}>
        Measurements are in {units.phrase}. The empty weight and the maximum weight are optional and
        are not copied onto a carton row &mdash; they are here so the choice can be made by reading.
      </p>

      <Form method="post" onSubmit={preservePackagingRows}>
        <input type="hidden" name="intent" value="save_pack" />
        <input type="hidden" name="units" value={units.preference} />
        {preset ? <input type="hidden" name="packId" value={preset.id} /> : null}
        {/* Read back with the checkbox below: an absent checkbox means "not
            asked" everywhere else on this form, and here it has to mean "no". */}
        <input type="hidden" name="isActive" value="false" />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "0.85rem",
          }}
        >
          <label style={label}>
            Name
            <input style={input} name="name" required defaultValue={preset?.name ?? ""} placeholder="Medium carton" />
          </label>
          <label style={label}>
            Type
            <input style={input} name="packageType" defaultValue={preset?.packageType ?? "carton"} />
          </label>
        </div>

        {/*
          * THE MEASUREMENTS ARE ONE ROW, and it is the same kind of row the
          * packaging editors use — hence the marker and the two hidden unit
          * fields. Re-saving a pack without touching its numbers must not move
          * them: the page shows inches and the pack may be stored in
          * centimetres, and writing the displayed figure back would turn a
          * 30 cm box into 29.9974 cm every time somebody opened this form and
          * pressed save. `packagingRows` puts the stored figure back instead.
          */}
        <div
          data-pkg-row="0"
          data-global-dim={units.dimensionUnit}
          data-global-weight={units.weightUnit}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "0.85rem",
            marginTop: "0.85rem",
          }}
        >
          {(["length", "width", "height"] as const).map((dimension) => (
            <label style={label} key={dimension}>
              {dimension[0].toUpperCase() + dimension.slice(1)} ({units.dimensionUnit})
              <PackagingValue
                name={dimension}
                kind="length"
                label={`Pack ${dimension} in ${units.dimensionUnit}`}
                stored={preset ? preset[dimension] : null}
                storedUnit={storedDimensionUnit}
                shownUnit={units.dimensionUnit}
              />
            </label>
          ))}
          <input type="hidden" name="pkg_dimUnit" defaultValue={storedDimensionUnit} />
          <label style={label}>
            Empty weight ({units.weightUnit})
            <PackagingValue
              name="emptyWeight"
              kind="weight"
              label={`Pack empty weight in ${units.weightUnit}`}
              stored={preset?.emptyWeight ?? null}
              storedUnit={storedWeightUnit}
              shownUnit={units.weightUnit}
            />
          </label>
          <label style={label}>
            Holds up to ({units.weightUnit})
            <PackagingValue
              name="maxWeight"
              kind="weight"
              label={`Pack maximum weight in ${units.weightUnit}`}
              stored={preset?.maxWeight ?? null}
              storedUnit={storedWeightUnit}
              shownUnit={units.weightUnit}
            />
          </label>
          <input type="hidden" name="pkg_weightUnit" defaultValue={storedWeightUnit} />
        </div>

        <label
          style={{
            ...label,
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            marginTop: "0.85rem",
          }}
        >
          <input type="checkbox" name="isActive" value="true" defaultChecked={preset?.isActive ?? true} />
          Offered when choosing a pack
        </label>

        <div style={{ marginTop: "0.85rem" }}>
          <button type="submit" style={btn(INK, { solid: true })}>
            {preset ? "Save this pack" : "Save pack"}
          </button>
        </div>

        <p style={helpText}>
          A pack is offered on the packaging rows of every product. Retiring one leaves it on the
          rows that already chose it, marked as retired, and stops it being chosen for a new one.
        </p>
      </Form>
    </div>
  );
}
