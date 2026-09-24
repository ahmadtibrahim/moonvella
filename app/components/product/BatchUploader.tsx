import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useRevalidator } from "react-router";
import { card, input, btn, sectionTitle, sectionNote, Field, INK, MUTED, LINE, helpText } from "./ui";

/**
 * Uploading many files at once, with an answer for each one.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SINGLE-FILE FORM. That form posts the
 * whole page and answers with a redirect, which is right for one file and
 * useless for twelve: a redirect carries one outcome, so eleven files' results
 * would be thrown away to report the twelfth, and a batch of photographs would
 * have to be uploaded one reload at a time.
 *
 * SO EACH FILE IS ITS OWN REQUEST, and the answer comes back as JSON. One file
 * per request is not a limitation to work around — it is what makes the outcome
 * attributable. A request carrying twelve files can only fail or succeed as a
 * whole, and "three of these were rejected, guess which" is not a report anybody
 * can act on.
 *
 * WHAT IS RESET, AND WHEN. The shared fields at the top are defaults applied to
 * each file as it is added. When a run finishes with nothing left over, they go
 * back to a clean state and the assets list is revalidated, so the next batch
 * starts from nothing rather than from the last batch's answers — which is how a
 * photograph ends up titled after the one before it.
 *
 * WHAT IS KEPT, AND WHY. A file that fails keeps its bytes, its title, its alt
 * text and its variant selection, so Retry sends exactly what was typed. A file
 * that is refused as a duplicate is NOT a failure — the asset is already on the
 * product — so it is shown with a link to what it duplicates and is never
 * retried, because retrying it could only ever refuse again.
 */

export interface UploadCategory {
  value: string;
  label: string;
}

export interface UploadVariant {
  id: string;
  name: string;
  sku: string;
  isActive: boolean;
}

interface QueueCard {
  key: string;
  file: File;
  previewUrl: string | null;
  title: string;
  altText: string;
  category: string;
  scopeMode: "shared" | "variant";
  variantIds: string[];
  status: "queued" | "uploading" | "done" | "duplicate" | "failed";
  progress: number;
  error: string | null;
  duplicateOf: { assetId: string; title: string } | null;
}

/** Files the browser can draw a thumbnail of. Anything else shows its name. */
function previewable(file: File): boolean {
  return /^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type);
}

function readableSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

let keySeed = 0;

export default function BatchUploader({
  categories,
  variants,
  defaultCategory,
}: {
  categories: UploadCategory[];
  variants: UploadVariant[];
  /** The category a new file starts as, before the operator changes anything. */
  defaultCategory: string;
}) {
  const location = useLocation();
  const revalidator = useRevalidator();

  /*
   * The shared defaults. They are the starting answer for each new file and are
   * cleared when a run ends cleanly; the values a file was actually uploaded
   * with live on its own card, so editing these after adding files does not
   * rewrite what those files will send.
   */
  const [category, setCategory] = useState(defaultCategory);
  const [scopeMode, setScopeMode] = useState<"shared" | "variant">("shared");
  const [scopeVariantIds, setScopeVariantIds] = useState<string[]>([]);
  const [cards, setCards] = useState<QueueCard[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /*
   * Object URLs are a browser-held reference to a file on disk, and nothing
   * frees them on its own — a page that made one per dropped photograph would
   * keep every one of them alive until the tab closed. They are tracked in a
   * ref rather than read back from state, because the revoking has to happen
   * when the component goes away, and a state read at that moment would be a
   * stale closure rather than the live list.
   */
  const previews = useRef<Set<string>>(new Set());

  const activeVariants = variants.filter((variant) => variant.isActive);

  const update = useCallback((key: string, patch: Partial<QueueCard>) => {
    setCards((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }, []);

  const makePreview = useCallback((file: File) => {
    if (!previewable(file)) return null;
    const url = URL.createObjectURL(file);
    previews.current.add(url);
    return url;
  }, []);

  const revokePreview = useCallback((url: string | null) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    previews.current.delete(url);
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files);
      if (incoming.length === 0) return;
      setCards((rows) => [
        ...rows,
        ...incoming.map((file) => ({
          key: `f${(keySeed += 1)}`,
          file,
          previewUrl: makePreview(file),
          title: "",
          altText: "",
          category,
          scopeMode,
          variantIds: scopeMode === "variant" ? scopeVariantIds : [],
          status: "queued" as const,
          progress: 0,
          error: null,
          duplicateOf: null,
        })),
      ]);
      // The picker is emptied here rather than after the upload, so choosing the
      // same file twice in a row is possible at all: an input still holding the
      // last selection fires no change event when the same file is picked again.
      if (inputRef.current) inputRef.current.value = "";
    },
    [category, makePreview, scopeMode, scopeVariantIds],
  );

  const removeCard = useCallback(
    (key: string) => {
      setCards((rows) => {
        const target = rows.find((row) => row.key === key);
        revokePreview(target?.previewUrl ?? null);
        return rows.filter((row) => row.key !== key);
      });
    },
    [revokePreview],
  );

  useEffect(() => {
    const open = previews.current;
    return () => {
      for (const url of open) URL.revokeObjectURL(url);
      open.clear();
    };
  }, []);

  const uploadOne = useCallback(
    (card: QueueCard) =>
      new Promise<void>((resolve) => {
        const body = new FormData();
        body.set("intent", "media_upload_batch");
        body.set("tab", "media");
        body.set("file", card.file, card.file.name);
        body.set("category", card.category);
        body.set("title", card.title);
        body.set("altText", card.altText);
        body.set("scopeMode", card.scopeMode);
        for (const id of card.variantIds) body.append("scopeVariantIds", id);

        const xhr = new XMLHttpRequest();
        // The action checks the request's origin, and the session cookie is what
        // says who is asking. Both are needed and neither is optional.
        xhr.open("POST", location.pathname);
        xhr.withCredentials = true;

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            update(card.key, { progress: Math.round((event.loaded / event.total) * 100) });
          }
        };

        xhr.onload = () => {
          let answer: {
            ok?: boolean;
            error?: string;
            duplicate?: boolean;
            assetId?: string;
            title?: string;
          } = {};
          try {
            answer = JSON.parse(xhr.responseText || "{}");
          } catch {
            // A body that is not JSON is not an answer this component can read —
            // most often an HTML error page from something in front of the app.
            // Reported as a failure of the file rather than as a silent success.
            answer = { ok: false, error: `The server replied with ${xhr.status} and no result for this file.` };
          }

          if (answer.ok) {
            setUploaded((count) => count + 1);
            update(card.key, { status: "done", progress: 100, error: null });
            removeCard(card.key);
          } else if (answer.duplicate) {
            update(card.key, {
              status: "duplicate",
              progress: 100,
              error: answer.error ?? "This file is already on the product.",
              duplicateOf: { assetId: String(answer.assetId ?? ""), title: String(answer.title ?? "") },
            });
          } else {
            update(card.key, {
              status: "failed",
              error: answer.error ?? `Upload failed (${xhr.status}).`,
            });
          }
          resolve();
        };

        xhr.onerror = () => {
          update(card.key, {
            status: "failed",
            error: "The connection dropped before the file was stored. Nothing was saved — try again.",
          });
          resolve();
        };
        xhr.onabort = () => {
          update(card.key, { status: "failed", error: "The upload was cancelled." });
          resolve();
        };

        update(card.key, { status: "uploading", progress: 0, error: null });
        xhr.send(body);
      }),
    [location.pathname, removeCard, update],
  );

  /*
   * ONE FILE AT A TIME, taken from the queue as it stands.
   *
   * Driven by an effect rather than by a loop so that a retry or a newly added
   * file is picked up without the component having to know it happened. Serial
   * rather than parallel: a dozen simultaneous multipart posts compete for the
   * same uplink, and the progress bars all stall together instead of filling one
   * after another.
   */
  useEffect(() => {
    if (busy) return;
    const next = cards.find((row) => row.status === "queued");
    if (!next) return;
    setBusy(true);
    void uploadOne(next).finally(() => setBusy(false));
  }, [busy, cards, uploadOne]);

  /*
   * A CLEAN FINISH PUTS THE FORM BACK TO NOTHING.
   *
   * The condition is that there is nothing left AND something was uploaded: an
   * empty queue on first render is not a finished batch, and clearing fields
   * somebody had already typed into would be the opposite of helpful. Failures
   * and duplicates keep their cards, so the queue is not empty in those cases
   * and nothing is cleared until a person has dealt with them.
   */
  useEffect(() => {
    if (cards.length > 0 || uploaded === 0) return;
    setCategory(defaultCategory);
    setScopeMode("shared");
    setScopeVariantIds([]);
    setUploaded(0);
    // The new assets are read back from the database rather than assumed, so the
    // grids below show exactly what was stored.
    revalidator.revalidate();
  }, [cards.length, defaultCategory, revalidator, uploaded]);

  const queued = cards.filter((row) => row.status === "queued" || row.status === "uploading").length;
  const failed = cards.filter((row) => row.status === "failed");
  const duplicates = cards.filter((row) => row.status === "duplicate");

  return (
    <div style={card}>
      <h2 style={sectionTitle}>Upload several files</h2>
      <p style={sectionNote}>
        Drop files here or choose them from the picker. Each file is uploaded on its own, so one
        rejection does not discard the rest — a failed file keeps everything you typed and can be
        retried, and a file that is already on the product says so instead of being stored twice.
      </p>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
        style={{
          border: `2px dashed ${dragging ? INK : LINE}`,
          borderRadius: 10,
          padding: "1.1rem",
          textAlign: "center",
          background: dragging ? "#f8fafc" : "transparent",
        }}
      >
        <input
          ref={inputRef}
          id="batch-files"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,video/mp4,video/webm"
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
          }}
          style={{ ...input, width: "auto" }}
        />
        <p style={{ ...helpText, marginTop: "0.4rem" }}>
          Images up to 20 MB, PDFs up to 25 MB, video up to 200 MB. Drag more files in at any time —
          they join the queue.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.85rem",
          marginTop: "0.85rem",
        }}
      >
        <Field
          id="b-category"
          label="Category for new files"
          hint="Each file keeps the category it had when it was added."
        >
          <select
            id="b-category"
            style={input}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            {categories.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="b-scope" label="Applies to, for new files">
          <label style={{ display: "block", fontSize: "0.78rem" }}>
            <input
              type="radio"
              name="batchScope"
              checked={scopeMode === "shared"}
              onChange={() => setScopeMode("shared")}
            />{" "}
            The whole product
          </label>
          <label style={{ display: "block", fontSize: "0.78rem" }}>
            <input
              type="radio"
              name="batchScope"
              checked={scopeMode === "variant"}
              onChange={() => setScopeMode("variant")}
            />{" "}
            Selected variants
          </label>
          {scopeMode === "variant" ? (
            activeVariants.length > 0 ? (
              <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
                {activeVariants.map((variant) => (
                  <label key={variant.id} style={{ fontSize: "0.74rem", color: MUTED }}>
                    <input
                      type="checkbox"
                      checked={scopeVariantIds.includes(variant.id)}
                      onChange={(event) =>
                        setScopeVariantIds((ids) =>
                          event.target.checked
                            ? [...ids, variant.id]
                            : ids.filter((id) => id !== variant.id),
                        )
                      }
                    />{" "}
                    {variant.name}
                  </label>
                ))}
              </div>
            ) : (
              <p style={{ ...helpText }}>There are no variants to attach to yet.</p>
            )
          ) : null}
        </Field>
      </div>

      {cards.length === 0 ? null : (
        <div style={{ marginTop: "1rem" }}>
          <div style={{ ...sectionNote, marginBottom: "0.4rem" }}>
            {queued > 0 ? `${queued} waiting · ` : ""}
            {cards.length} file{cards.length === 1 ? "" : "s"} in this batch
            {failed.length > 0 ? ` · ${failed.length} need attention` : ""}
            {duplicates.length > 0 ? ` · ${duplicates.length} already on the product` : ""}
          </div>

          {failed.length > 0 ? (
            <div style={{ marginBottom: "0.6rem" }}>
              <button
                type="button"
                style={btn(INK, { solid: true })}
                onClick={() =>
                  setCards((rows) =>
                    rows.map((row) =>
                      row.status === "failed"
                        ? { ...row, status: "queued", progress: 0, error: null }
                        : row,
                    ),
                  )
                }
              >
                Retry {failed.length} failed file{failed.length === 1 ? "" : "s"}
              </button>
            </div>
          ) : null}

          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {cards.map((row) => (
              <li
                key={row.key}
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "flex-start",
                  borderTop: `1px solid ${LINE}`,
                  padding: "0.7rem 0",
                  opacity: row.status === "duplicate" ? 0.75 : 1,
                }}
              >
                <div
                  style={{
                    width: 74,
                    height: 74,
                    flexShrink: 0,
                    border: `1px solid ${LINE}`,
                    borderRadius: 6,
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "#f8fafc",
                    fontSize: "0.62rem",
                    color: MUTED,
                    textAlign: "center",
                  }}
                >
                  {row.previewUrl ? (
                    <img
                      src={row.previewUrl}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <span>{row.file.name.split(".").pop()?.toUpperCase() ?? "FILE"}</span>
                  )}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.78rem", color: INK, wordBreak: "break-all" }}>
                    {row.file.name}{" "}
                    <span style={{ color: MUTED }}>· {readableSize(row.file.size)}</span>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: "0.4rem",
                      marginTop: "0.35rem",
                    }}
                  >
                    <input
                      style={input}
                      value={row.title}
                      placeholder="Title (defaults to the file name)"
                      onChange={(event) => update(row.key, { title: event.target.value })}
                      aria-label={`Title for ${row.file.name}`}
                    />
                    <input
                      style={input}
                      value={row.altText}
                      placeholder="Alt text"
                      onChange={(event) => update(row.key, { altText: event.target.value })}
                      aria-label={`Alt text for ${row.file.name}`}
                    />
                    <select
                      style={input}
                      value={row.category}
                      onChange={(event) => update(row.key, { category: event.target.value })}
                      aria-label={`Category for ${row.file.name}`}
                    >
                      {categories.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                    <select
                      style={input}
                      value={row.scopeMode}
                      onChange={(event) =>
                        update(row.key, {
                          scopeMode: event.target.value as "shared" | "variant",
                          variantIds:
                            event.target.value === "shared"
                              ? []
                              : row.variantIds.length > 0
                                ? row.variantIds
                                : scopeVariantIds,
                        })
                      }
                      aria-label={`Applies to, for ${row.file.name}`}
                    >
                      <option value="shared">The whole product</option>
                      <option value="variant">
                        {row.variantIds.length > 0
                          ? `${row.variantIds.length} variant(s)`
                          : "Selected variants"}
                      </option>
                    </select>
                  </div>

                  {row.scopeMode === "variant" && activeVariants.length > 0 ? (
                    <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap", marginTop: "0.3rem" }}>
                      {activeVariants.map((variant) => (
                        <label key={variant.id} style={{ fontSize: "0.72rem", color: MUTED }}>
                          <input
                            type="checkbox"
                            checked={row.variantIds.includes(variant.id)}
                            disabled={row.status !== "queued" && row.status !== "failed"}
                            onChange={(event) =>
                              update(row.key, {
                                variantIds: event.target.checked
                                  ? [...row.variantIds, variant.id]
                                  : row.variantIds.filter((id) => id !== variant.id),
                              })
                            }
                          />{" "}
                          {variant.name}
                        </label>
                      ))}
                    </div>
                  ) : null}

                  {row.status === "uploading" || (row.status === "queued" && row.progress > 0) ? (
                    <div
                      style={{
                        height: 5,
                        background: "#e2e8f0",
                        borderRadius: 3,
                        marginTop: "0.4rem",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${row.progress}%`,
                          height: "100%",
                          background: INK,
                          transition: "width 120ms linear",
                        }}
                      />
                    </div>
                  ) : null}

                  {row.status === "duplicate" ? (
                    <p role="status" style={{ fontSize: "0.72rem", color: "#92400e", margin: "0.35rem 0 0" }}>
                      Already on this product as{" "}
                      <strong>{row.duplicateOf?.title || row.file.name}</strong>. Nothing was stored
                      twice.{" "}
                      <Link to={`?tab=media&asset=${row.duplicateOf?.assetId ?? ""}`} style={{ color: INK }}>
                        Open that asset
                      </Link>{" "}
                      to attach it to more variants.
                    </p>
                  ) : null}

                  {row.status === "failed" && row.error ? (
                    <p role="alert" style={{ fontSize: "0.72rem", color: "#991b1b", margin: "0.35rem 0 0" }}>
                      {row.error}
                    </p>
                  ) : null}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  <button
                    type="button"
                    style={btn(MUTED)}
                    onClick={() => removeCard(row.key)}
                    disabled={row.status === "uploading"}
                  >
                    {row.status === "duplicate" ? "Dismiss" : "Remove"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
