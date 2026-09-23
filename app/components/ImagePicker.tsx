import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { SelectionView } from "~/services/importMediaSelection.server";

/**
 * The images that will be imported, and the seller's say over which.
 *
 * WHY THIS IS NOT A STEP IN A WIZARD. Importing is a decision about one product
 * in a list of many, and the seller is looking at that list while they make it.
 * The panel opens inside the card, the choice is saved against the product, and
 * the import that follows reads it — no navigation, and no losing the filter
 * that found the product in the first place.
 *
 * THE DEFAULT IS EVERYTHING, AND IT SAYS SO. A seller who never opens this panel
 * imports every approved, seller-visible image, exactly as they always did. Only
 * once a choice is saved does the import follow it, and `defaulted` is what
 * tells the panel which of those two states it is showing — a panel that
 * presented a default as a decision would be asking for confirmation of a
 * choice nobody made.
 *
 * NOTHING IS SENT FROM HERE. Saving a selection writes rows; the import reads
 * them. That separation is what stops a half-finished choice reaching a live
 * storefront, and it is why the button says "save" rather than "upload".
 *
 * This lives in a `.tsx` file rather than inside the catalogue route because
 * `.jsx` in this project is never typechecked — and a panel holding a working
 * copy of somebody's catalogue images is exactly the wrong place for a typo to
 * be found by a seller instead of by the compiler.
 */

/** The loader's answer, or the action's. The shape tells them apart. */
type PickerData = SelectionView | PickerResult;

interface PickerResult {
  ok?: boolean;
  error?: string;
  message?: string;
  selected?: number;
  ignored?: string[];
}

interface PickableImage {
  mediaAssetId: string;
  url: string;
  title: string;
  selected: boolean;
  isMain: boolean;
  variantIds: string[];
  uploadStatus: string;
  lastUploadError: string | null;
}

export default function ImagePicker({
  productId,
  disabled,
}: {
  productId: string;
  /** True while the catalogue's import is in flight, so the two cannot race. */
  disabled: boolean;
}) {
  const fetcher = useFetcher<PickerData>();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PickableImage[] | null>(null);

  // A loader answer carries `images`; an action answer does not. Reading the
  // shape rather than tracking a mode keeps the two from being confused when one
  // fetcher answers both.
  const data = fetcher.data;
  const view =
    data && "images" in data && Array.isArray(data.images) ? (data as SelectionView) : null;
  const result = data && "images" in data ? null : (data as PickerResult | undefined);

  useEffect(() => {
    if (view) {
      setRows(
        view.images.map((image) => ({
          mediaAssetId: image.mediaAssetId,
          url: image.url,
          title: image.title,
          selected: image.selected,
          isMain: image.isMain,
          variantIds: image.variantIds,
          uploadStatus: image.uploadStatus,
          lastUploadError: image.lastUploadError,
        }))
      );
    }
  }, [view]);

  const load = () =>
    fetcher.load(`/app/catalog-images?productId=${encodeURIComponent(productId)}`);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    // Loaded once, on first open. Re-loading on every open would re-fetch a list
    // the seller may have just rearranged and throw the arrangement away.
    if (next && !rows) load();
  };

  const setAll = (selected: boolean) =>
    setRows((current) => (current ?? []).map((row) => ({ ...row, selected })));

  /**
   * Move a row one place, taking the main image with it.
   *
   * The order here is the order the store receives, and the bottom of the list
   * is the least important image — so the arrows move an image towards the front
   * rather than towards a number nobody can see.
   */
  const move = (index: number, delta: number) =>
    setRows((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const markMain = (mediaAssetId: string) =>
    setRows((current) =>
      (current ?? []).map((row) => ({ ...row, isMain: row.mediaAssetId === mediaAssetId }))
    );

  const selectedRows = rows ? rows.filter((row) => row.selected) : [];
  const hasMain = rows ? rows.some((row) => row.isMain && row.selected) : false;
  const failures = view ? view.failures : [];

  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <button
        type="button"
        className="mv-import-btn"
        style={{ display: "block", width: "100%", textAlign: "center", marginBottom: "0.4rem" }}
        onClick={toggleOpen}
        aria-expanded={open}
      >
        {open ? "Hide images" : "Choose images"}
        {rows ? ` (${selectedRows.length} of ${rows.length})` : ""}
      </button>

      {open ? (
        <div className="mv-section-card" style={{ padding: "0.75rem", marginBottom: "0.5rem" }}>
          {result?.error ? (
            <p style={{ color: "var(--danger-red)", fontSize: "0.8rem", margin: 0 }}>{result.error}</p>
          ) : null}

          {fetcher.state !== "idle" && !rows ? (
            <p className="mv-page-subtitle" style={{ margin: 0 }}>
              Loading images…
            </p>
          ) : null}

          {rows ? (
            rows.length === 0 ? (
              <p className="mv-page-subtitle" style={{ margin: 0 }}>
                No images are available for this product yet.
              </p>
            ) : (
              <fetcher.Form method="post" action="/app/catalog-images">
                <input type="hidden" name="productId" value={productId} />
                {/* The display order, submitted exactly as it is shown, so what
                    the seller arranged and what the store receives are one list. */}
                {rows.map((row) => (
                  <input
                    key={`order-${row.mediaAssetId}`}
                    type="hidden"
                    name="orderedId"
                    value={row.mediaAssetId}
                  />
                ))}

                <p className="mv-page-subtitle" style={{ marginTop: 0 }}>
                  {view?.defaulted
                    ? "Every available image is ticked. Untick the ones you do not want, then save."
                    : "These are the images your store will have. Importing again will not bring back the ones you removed."}
                </p>

                <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem" }}>
                  <button
                    type="button"
                    className="mv-import-btn"
                    style={{ padding: "0.25rem 0.5rem", fontSize: "0.72rem" }}
                    onClick={() => setAll(true)}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="mv-import-btn"
                    style={{ padding: "0.25rem 0.5rem", fontSize: "0.72rem" }}
                    onClick={() => setAll(false)}
                  >
                    Select none
                  </button>
                </div>

                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {rows.map((row, index) => (
                    <li
                      key={row.mediaAssetId}
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                        padding: "0.35rem 0",
                        borderTop: index === 0 ? "none" : "1px solid var(--border-color, #e2e8f0)",
                      }}
                    >
                      <input
                        type="checkbox"
                        name="imageId"
                        value={row.mediaAssetId}
                        checked={row.selected}
                        aria-label={`Import ${row.title}`}
                        onChange={() =>
                          setRows((current) =>
                            (current ?? []).map((item) =>
                              item.mediaAssetId === row.mediaAssetId
                                ? { ...item, selected: !item.selected }
                                : item
                            )
                          )
                        }
                      />
                      <img
                        src={row.url}
                        alt=""
                        style={{
                          width: 44,
                          height: 44,
                          objectFit: "cover",
                          borderRadius: 4,
                          opacity: row.selected ? 1 : 0.4,
                        }}
                      />
                      <span style={{ flex: 1, fontSize: "0.75rem" }}>
                        {row.title}
                        {row.variantIds.length > 0 ? (
                          <span className="mv-page-subtitle" style={{ display: "block", margin: 0 }}>
                            used for {row.variantIds.length} variant
                            {row.variantIds.length === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {row.uploadStatus === "UPLOADED" ? (
                          <span className="mv-page-subtitle" style={{ display: "block", margin: 0 }}>
                            already in your store
                          </span>
                        ) : null}
                        {row.uploadStatus === "FAILED" ? (
                          <span
                            style={{
                              display: "block",
                              color: "var(--danger-red)",
                              fontSize: "0.72rem",
                            }}
                          >
                            last import did not take this one:{" "}
                            {row.lastUploadError || "the store refused it"}
                          </span>
                        ) : null}
                      </span>
                      <span style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                        <button
                          type="button"
                          className="mv-import-btn"
                          style={{ padding: "0.1rem 0.35rem", fontSize: "0.7rem" }}
                          onClick={() => move(index, -1)}
                          disabled={index === 0}
                          aria-label={`Move ${row.title} earlier`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="mv-import-btn"
                          style={{ padding: "0.1rem 0.35rem", fontSize: "0.7rem" }}
                          onClick={() => move(index, 1)}
                          disabled={index === rows.length - 1}
                          aria-label={`Move ${row.title} later`}
                        >
                          ↓
                        </button>
                      </span>
                      <label
                        style={{
                          fontSize: "0.7rem",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.2rem",
                        }}
                      >
                        <input
                          type="radio"
                          name="mainImageId"
                          value={row.mediaAssetId}
                          checked={
                            (row.isMain && row.selected) ||
                            (!hasMain && selectedRows[0]?.mediaAssetId === row.mediaAssetId)
                          }
                          disabled={!row.selected}
                          onChange={() => markMain(row.mediaAssetId)}
                        />
                        main
                      </label>
                    </li>
                  ))}
                </ul>

                {failures.length > 0 ? (
                  <p className="mv-page-subtitle" style={{ marginBottom: 0 }}>
                    {failures.length} image{failures.length === 1 ? "" : "s"} did not reach your store
                    last time. Importing again retries {failures.length === 1 ? "it" : "them"} and
                    skips the ones that already arrived.
                  </p>
                ) : null}

                <button
                  type="submit"
                  className="mv-import-btn"
                  style={{ marginTop: "0.5rem" }}
                  disabled={disabled || fetcher.state !== "idle"}
                  name="intent"
                  value="save_selection"
                >
                  {fetcher.state !== "idle" ? "Saving…" : "Save image selection"}
                </button>

                {result?.message ? (
                  <p style={{ color: "#059669", fontSize: "0.75rem", margin: "0.4rem 0 0" }}>
                    {result.message}
                  </p>
                ) : null}
              </fetcher.Form>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
