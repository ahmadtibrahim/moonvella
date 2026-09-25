import { Link, Form } from "react-router";
import { PRODUCT_CODE_HELP } from "~/utils/productCode";
import {
  card,
  input,
  btn,
  CATEGORY_OPTIONS,
  CURRENCY_OPTIONS,
  CatalogueField,
  ListField,
  listLines,
  sectionTitle,
  sectionNote,
  Field,
  StatusChip,
  ConfirmForm,
  INK,
  MUTED,
  FAINT,
  LINE,
  helpText,
} from "./ui";

/**
 * Product Details — what the family *is*, as opposed to what is sold.
 *
 * The distinction the whole model turns on: this tab holds no price, no weight
 * and no stock, because none of those are properties of a family. A "Cooling
 * Pillow" is not $52; the queen size is. So the fields here are the ones that
 * are true of every variant, and anything else lives on the Variants tab.
 *
 * Everything is one form. The publication actions are submit buttons in that
 * same form rather than separate forms, so the values the merchant has just
 * typed are saved by the same press that publishes — a Publish button that
 * discarded unsaved edits would be a trap.
 */

type Readiness = {
  ready: boolean;
  checks: { key: string; label: string; ok: boolean; detail: string; tab: string }[];
  blockers: { key: string; label: string; detail: string; tab: string }[];
};

interface Variant {
  id: string;
  sku: string;
  name: string;
  wholesalePrice: number;
  suggestedRetailPrice: number;
  inventory: number;
  isActive: boolean;
  isDefault: boolean;
  variantOptions: { name: string; value: string }[];
}

interface Product {
  id: string;
  name: string;
  productCode: string;
  category: string;
  description: string | null;
  features: string | null;
  materials: string | null;
  careInstructions: string | null;
  currency: string;
  status: string;
  isArchived: boolean;
  variants: Variant[];
}

export default function DetailsTab({
  product,
  readiness,
  canManage,
  canPublish,
}: {
  product: Product;
  readiness: Readiness;
  canManage: boolean;
  canPublish: boolean;
}) {
  const disabled = !canManage;

  return (
    <>
      <StatusPanel
        product={product}
        readiness={readiness}
        canManage={canManage}
        canPublish={canPublish}
      />

      <div style={card}>
        <h2 style={sectionTitle}>Product details</h2>
        <p style={sectionNote}>
          The family: the name and code that identify it, and the words that describe every
          size the same way.
        </p>

        <Form method="post" id="details-form">
          <input type="hidden" name="tab" value="details" />

          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.85rem" }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <Field id="d-name" label="Product name">
                <input
                  style={input}
                  id="d-name"
                  name="name"
                  required
                  disabled={disabled}
                  defaultValue={product.name}
                />
              </Field>
            </div>

            <Field id="d-code" label="Product Code" hint={PRODUCT_CODE_HELP}>
              <input
                style={input}
                id="d-code"
                name="productCode"
                required
                disabled={disabled}
                defaultValue={product.productCode}
              />
            </Field>

            <CatalogueField
              id="d-category"
              label="Category"
              name="category"
              options={CATEGORY_OPTIONS}
              value={product.category}
              disabled={disabled}
              hint="Or type a new one below — anything you type there is used instead."
              placeholder="e.g. Bedding"
            />

            <CatalogueField
              id="d-currency"
              label="Currency"
              name="currency"
              options={CURRENCY_OPTIONS}
              value={product.currency}
              disabled={disabled}
              hint="Prices on every variant are in this currency."
              placeholder="e.g. NZD"
            />

            <div />

            <div style={{ gridColumn: "1 / -1" }}>
              <Field
                id="d-description"
                label="Description"
                hint="What the product is. A family with no description cannot be published."
              >
                <textarea
                  style={input}
                  id="d-description"
                  name="description"
                  rows={4}
                  disabled={disabled}
                  defaultValue={product.description ?? ""}
                />
              </Field>
            </div>

            <div style={{ gridColumn: "1 / -1" }}>
              <ListField
                id="d-features"
                label="Features"
                name="features"
                values={listLines(product.features)}
                disabled={disabled}
                hint="One feature per box — what a seller reads on the product card. Add another for each one."
                placeholder="e.g. Keeps cool for up to 8 hours"
              />
            </div>

            <div style={{ gridColumn: "1 / -1" }}>
              <ListField
                id="d-materials"
                label="Materials"
                name="materials"
                values={listLines(product.materials)}
                disabled={disabled}
                hint="What it is made of, one per box."
                placeholder="e.g. 100% organic cotton"
                addLabel="Add material"
              />
            </div>

            <div style={{ gridColumn: "1 / -1" }}>
              <Field id="d-care" label="Care instructions">
                <textarea
                  style={input}
                  id="d-care"
                  name="careInstructions"
                  rows={2}
                  disabled={disabled}
                  defaultValue={product.careInstructions ?? ""}
                />
              </Field>
            </div>
          </div>

          {canManage ? (
            <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="submit" name="intent" value="update_details" style={btn(INK, { solid: true })}>
                Save draft
              </button>
              {/*
                No "Submit for approval", and no "Preview seller view".

                The approval step is gone because it never had anywhere to go:
                PENDING_APPROVAL was written by that button and read by nothing —
                no queue, no screen, no approver. A product sat in a state that
                meant "waiting for a person" and no person was ever shown it.
                The owner is the approver, so the button that asks them to wait
                for themselves is the button to delete.

                The preview is gone because it showed a rendering of the product
                that no seller would ever see — it was a picture built from the
                same rows the catalogue reads, drawn on a tab sellers cannot
                open. The catalogue itself is the honest answer to "what does a
                seller see", and it is one click away.

                NOR IS PUBLISH HERE ANY MORE. It is beside the product's name at
                the top of the page, where the state it changes is displayed —
                see the note at that control. It was duplicated in this form for
                a while, which is how the page came to have two buttons that
                could each be pressed with a form half-filled.
              */}
            </div>
          ) : (
            <p style={{ ...helpText, marginTop: "0.85rem" }}>
              Your role can view this product but not change it.
            </p>
          )}
        </Form>
      </div>

      <div style={card}>
        <h2 style={sectionTitle}>Lifecycle</h2>
        <p style={sectionNote}>
          Archiving hides a product everywhere without deleting it. Orders already placed keep
          their history.
        </p>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {canManage ? (
            <>
              {product.isArchived ? (
                // Restoring is the safe direction and is not asked twice. Only
                // the step that takes the product away from sellers is.
                <Form method="post">
                  <input type="hidden" name="tab" value="details" />
                  <button type="submit" name="intent" value="restore" style={btn("#065f46")}>
                    Restore
                  </button>
                </Form>
              ) : (
                <ConfirmForm
                  intent="archive"
                  fields={{ tab: "details" }}
                  label="Archive"
                  confirmLabel="Archive it"
                  question="Archive this product? Sellers stop seeing it."
                />
              )}
              <Form method="post">
                <input type="hidden" name="tab" value="details" />
                <button type="submit" name="intent" value="duplicate" style={btn(MUTED)}>
                  Duplicate product
                </button>
              </Form>
            </>
          ) : null}
          <Link to="/admin/products" style={{ ...btn(MUTED), lineHeight: "1.2" }}>
            Back to all products
          </Link>
        </div>

        {product.isArchived ? (
          <p style={{ ...helpText, marginTop: "0.75rem" }}>
            This product is archived. Restoring returns it to draft, so it has to pass the
            publication checks again before sellers see it.
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * The publication state, on the tab that owns it.
 *
 * The strip at the top of every tab says whether the product is ready. This
 * panel says what that means for *this* tab — the checks that a person fixes by
 * typing here — so a merchant is not sent hunting through four other tabs for
 * something that was on the page they were already reading.
 */
function StatusPanel({
  product,
  readiness,
  canManage,
  canPublish,
}: {
  product: Product;
  readiness: Readiness;
  canManage: boolean;
  canPublish: boolean;
}) {
  const mine = readiness.checks.filter((check) => check.tab === "details");
  const outstanding = mine.filter((check) => !check.ok);

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.5rem" }}>
        <h2 style={{ ...sectionTitle, marginBottom: 0 }}>Publication</h2>
        <StatusChip status={product.status} />
      </div>

      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", lineHeight: 1.7, color: MUTED }}>
        {mine.map((check) => (
          <li key={check.key} style={{ color: check.ok ? MUTED : "#92400e" }}>
            {check.label}
            {check.ok ? null : <span style={{ color: FAINT }}> — {check.detail}</span>}
          </li>
        ))}
      </ul>

      {outstanding.length === 0 ? (
        <p style={{ ...helpText, marginTop: "0.6rem" }}>
          Everything this tab is responsible for is done.
        </p>
      ) : (
        <p style={{ ...helpText, marginTop: "0.6rem" }}>
          {outstanding.length} item{outstanding.length === 1 ? "" : "s"} on this tab still to
          complete.
        </p>
      )}

      {/*
        Two different reasons a person cannot publish, and they need different
        sentences: "you cannot edit this at all" and "you can edit it, but an
        owner has to release it" are not the same problem and do not have the
        same remedy. The second case is the catalogue role, which writes every
        field on this page and does not decide when it goes live.
      */}
      {!canManage ? (
        <p style={{ ...helpText }}>Your role can view this product but cannot edit it.</p>
      ) : !canPublish ? (
        <p style={{ ...helpText }}>
          Your role can prepare this product but cannot publish it. When it is ready, an
          owner or administrator releases it to sellers.
        </p>
      ) : null}
      <p style={{ ...helpText, borderTop: `1px solid ${LINE}`, paddingTop: "0.5rem" }}>
        The publication checks run on the server each time Publish is pressed. A product that
        does not pass is refused here, and would be refused by any other caller too.
      </p>
    </div>
  );
}
