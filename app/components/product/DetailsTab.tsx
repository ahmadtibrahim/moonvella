import { Link, Form } from "react-router";
import { PRODUCT_CODE_HELP } from "~/utils/productCode";
// Type-only, so nothing from the server module reaches the client bundle.
import type { MediaAssetView } from "~/services/media.server";
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
  money,
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
 * typed are saved by the same press that submits the product for approval —
 * "Submit for approval" that discarded unsaved edits would be a trap.
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

const IMAGE_CATEGORIES = ["WHITE_BACKGROUND_IMAGE", "LIFESTYLE_IMAGE"];

export default function DetailsTab({
  product,
  media,
  readiness,
  canManage,
  preview,
}: {
  product: Product;
  media: MediaAssetView[];
  readiness: Readiness;
  canManage: boolean;
  preview: boolean;
}) {
  const published = product.status === "PUBLISHED";
  const disabled = !canManage;

  return (
    <>
      <StatusPanel
        product={product}
        readiness={readiness}
        canManage={canManage}
      />

      {preview ? <SellerPreview product={product} media={media} /> : null}

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
              {!published ? (
                <button type="submit" name="intent" value="submit_for_approval" style={btn("#0369a1")}>
                  Submit for approval
                </button>
              ) : null}
              <button
                type="submit"
                name="intent"
                value={published ? "unpublish" : "publish"}
                style={btn(published ? "#92400e" : "#065f46")}
                title={
                  published
                    ? "Withdraw this product from sellers. Existing orders are unaffected."
                    : readiness.ready
                      ? "Make this product available to sellers."
                      : "This product does not meet the publication requirements yet."
                }
              >
                {published ? "Unpublish" : "Publish to sellers"}
              </button>
              <Link
                to={`?tab=details${preview ? "" : "&preview=1"}`}
                style={btn(MUTED)}
              >
                {preview ? "Hide seller view" : "Preview seller view"}
              </Link>
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
}: {
  product: Product;
  readiness: Readiness;
  canManage: boolean;
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

      {!canManage ? (
        <p style={{ ...helpText }}>Your role can view this product but cannot publish it.</p>
      ) : null}
      <p style={{ ...helpText, borderTop: `1px solid ${LINE}`, paddingTop: "0.5rem" }}>
        The publication checks run on the server each time Publish is pressed. A product that
        does not pass is refused here, and would be refused by any other caller too.
      </p>
    </div>
  );
}

/**
 * What a seller will see.
 *
 * Deliberately built from the same fields the seller's catalogue reads and from
 * nothing else, so this is a statement about the data rather than a mock-up:
 * if the preview shows no image, the catalogue will show no image, because
 * "no approved, seller-visible image" is one condition with one meaning.
 */
function SellerPreview({ product, media }: { product: Product; media: MediaAssetView[] }) {
  const images = media.filter(
    (asset) =>
      IMAGE_CATEGORIES.includes(asset.category) &&
      asset.approvalStatus === "APPROVED" &&
      asset.sellerVisible
  );
  const active = product.variants.filter((variant) => variant.isActive);
  const cheapest = active.reduce<Variant | null>(
    (best, variant) => (!best || variant.wholesalePrice < best.wholesalePrice ? variant : best),
    null
  );

  return (
    <div style={{ ...card, background: "#f8fafc" }}>
      <h2 style={sectionTitle}>Seller view</h2>
      <p style={sectionNote}>
        Exactly what an approved seller sees in their catalogue. Prices shown are the entry
        price — the cheapest active variant — which is the same rule the catalogue uses.
      </p>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          style={{
            width: 140,
            height: 140,
            borderRadius: 10,
            background: "white",
            border: `1px solid ${LINE}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: FAINT,
            fontSize: "0.75rem",
            overflow: "hidden",
          }}
        >
          {images.length ? (
            <img
              src={images[0].url}
              alt={images[0].altText ?? product.name}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            "No approved image"
          )}
        </div>

        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontWeight: 700, color: INK }}>{product.name}</div>
          <div style={{ fontSize: "0.75rem", color: MUTED, marginBottom: "0.5rem" }}>
            {product.category} &middot; {product.productCode}
          </div>
          <p style={{ fontSize: "0.82rem", color: MUTED, margin: "0 0 0.5rem" }}>
            {product.description || "No description yet."}
          </p>

          {cheapest ? (
            <div style={{ fontSize: "0.82rem", color: INK }}>
              From <strong>{money(cheapest.wholesalePrice, product.currency)}</strong> wholesale
              <span style={{ color: MUTED }}>
                {" "}
                &middot; suggested retail {money(cheapest.suggestedRetailPrice, product.currency)}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: "0.82rem", color: "#92400e" }}>
              No active variant, so there is no price to show.
            </div>
          )}

          {active.length > 1 ? (
            <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem", fontSize: "0.78rem", color: MUTED }}>
              {active.map((variant) => (
                <li key={variant.id}>
                  {variant.name} — {money(variant.wholesalePrice, product.currency)}
                  {variant.variantOptions.length
                    ? ` (${variant.variantOptions.map((o) => `${o.name}: ${o.value}`).join(", ")})`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}

          {product.status !== "PUBLISHED" ? (
            <p style={{ ...helpText, marginTop: "0.6rem" }}>
              This product is not published, so a seller cannot see it yet. This preview shows
              the draft.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
