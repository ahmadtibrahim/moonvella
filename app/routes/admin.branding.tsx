/**
 * Settings → Branding. Owner-only, and global.
 *
 * WHAT THIS PAGE OWNS. The logo in four slots, and the name the app calls
 * itself. Nothing else — no per-merchant brand, because a merchant's logo is
 * `SellerBrandKit` and mixing the two is how a seller's mark ends up on
 * MoonVella's invoice.
 *
 * WHY EVERY SLOT HAS A PREVIEW ON BOTH BACKGROUNDS. The most common way a logo
 * upload goes wrong is not a bad file, it is a good file that disappears: a navy
 * mark dropped onto the navy sidebar is a blank space that looks like a failed
 * upload, and the operator reasonably concludes the app is broken. Showing the
 * light and dark previews side by side answers that at the moment of upload
 * rather than after a deploy.
 *
 * WHY NOTHING HERE STRETCHES. Every preview is `object-fit: contain` on a fixed
 * box, and the server preserves the aspect ratio, so what is previewed is what
 * is stored. The stored width and height are shown as numbers as well, so an
 * operator can tell a 540 × 180 wordmark from a 2000 × 2000 square without
 * opening the file.
 *
 * WHAT IT DOES NOT CLAIM. Shopify's app icon lives in the Dev Dashboard and is
 * not changed by an upload here. The page produces the 1200 × 1200 file and says
 * where to put it, rather than implying the icon follows the logo.
 */

import { useState } from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import {
  BRAND_SLOT_SPECS,
  getBrandView,
  replaceBrandSlot,
  resetBrandSlot,
  restoreBrandVersion,
  setDisplayName,
  type BrandSlot,
} from "~/services/branding.server";
import { formatDateTime } from "~/utils/dates";

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "settings.general");
  const brand = await getBrandView();
  return { brand, slots: BRAND_SLOT_SPECS.map((spec) => ({ ...spec })) };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "settings.general");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { id: user.id, name: user.name, ipAddress: ip, userAgent };

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "display-name") {
    const name = await setDisplayName(String(form.get("displayName") || ""), actor);
    return { ok: `The app now calls itself “${name}”.` };
  }

  if (intent === "upload") {
    const slot = String(form.get("slot") || "") as BrandSlot;
    const file = form.get("file");
    if (!(file instanceof File)) return { error: "Choose an image to upload." };
    const result = await replaceBrandSlot(slot, file, actor);
    return result.ok
      ? { ok: `${slot} logo saved as version ${result.version}. The previous version is kept.` }
      : { error: result.error };
  }

  if (intent === "reset") {
    const slot = String(form.get("slot") || "") as BrandSlot;
    const result = await resetBrandSlot(slot, actor);
    return result.ok
      ? { ok: `${slot} is back to its default. The cleared version is kept and can be restored.` }
      : { error: result.error };
  }

  if (intent === "restore") {
    const slot = String(form.get("slot") || "") as BrandSlot;
    const version = Number(form.get("version"));
    const result = await restoreBrandVersion(slot, version, actor);
    return result.ok ? { ok: `${slot} restored to version ${version}.` } : { error: result.error };
  }

  return { error: "Unknown action." };
}

const panel: React.CSSProperties = {
  background: "white",
  border: "1px solid #DCE3EB",
  borderRadius: 12,
  padding: "1.25rem",
  marginBottom: "1.25rem",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "#172B4D",
  marginBottom: "0.3rem",
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  border: "1px solid #DCE3EB",
  borderRadius: 8,
  fontSize: "0.85rem",
  minHeight: 40,
};

function button(kind: "primary" | "plain" = "plain"): React.CSSProperties {
  return {
    padding: "0.5rem 0.9rem",
    borderRadius: 8,
    border: kind === "primary" ? "1px solid #006E67" : "1px solid #DCE3EB",
    background: kind === "primary" ? "#006E67" : "white",
    color: kind === "primary" ? "white" : "#172B4D",
    fontWeight: 600,
    fontSize: "0.8rem",
    cursor: "pointer",
    minHeight: 40,
  };
}

/**
 * One preview box, on one background.
 *
 * `object-fit: contain` is doing real work: a logo previewed with `cover` or a
 * fixed width would be cropped or stretched, and the operator would approve a
 * shape that is not the one stored.
 */
function Preview({
  url,
  alt,
  background,
  tone,
  height = 84,
  whiteBacking = false,
}: {
  url: string | null;
  alt: string;
  background: string;
  tone: "light" | "dark";
  height?: number;
  /**
   * Draw the image on a white chip inside the box.
   *
   * THE PREVIEW HAS TO SHOW WHAT THE APP ACTUALLY DOES. On the navy sidebar a
   * logo with no dark-background variant is drawn on a white backing — see the
   * admin shell — and a preview that drew the WORDMARK instead would be telling
   * the operator one thing while the sidebar did another. It matters because the
   * whole point of the dark-background slot is that a navy mark on a navy bar
   * disappears, and the preview is where that is discovered.
   */
  whiteBacking?: boolean;
}) {
  return (
    <div
      style={{
        background,
        border: "1px solid #DCE3EB",
        borderRadius: 8,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0.5rem",
      }}
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          style={
            whiteBacking
              ? {
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  background: "#FFFFFF",
                  padding: 4,
                  borderRadius: 6,
                }
              : { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
          }
        />
      ) : (
        <span
          style={{
            fontSize: "0.78rem",
            fontWeight: 700,
            color: tone === "dark" ? "#EEBC3B" : "#142440",
          }}
        >
          {alt}
        </span>
      )}
    </div>
  );
}

export default function AdminBranding() {
  const { brand, slots } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [showHistory, setShowHistory] = useState<string | null>(null);
  // Which slot's reset is armed. One at a time, so a stray second press cannot
  // reset a different logo than the one being confirmed.
  const [armedReset, setArmedReset] = useState<string | null>(null);

  return (
    <div className="mv-page-wide">
      <div className="mv-page-header">
        <div>
          <h1>Branding</h1>
          <p>
            The logo and the name MoonVella shows on its own surfaces: the admin sidebar and
            sign-in page, the embedded Shopify app, invoices and statements, and the favicon.
          </p>
        </div>
        <Link to="/admin/settings" className="mv-button">
          Back to settings
        </Link>
      </div>

      {actionData && "error" in actionData && actionData.error ? (
        <div
          role="alert"
          style={{ ...panel, background: "#FEE2E2", borderColor: "#fecaca", color: "#B91C1C" }}
        >
          {actionData.error}
        </div>
      ) : null}
      {actionData && "ok" in actionData && actionData.ok ? (
        <div
          role="status"
          style={{ ...panel, background: "#DCFCE7", borderColor: "#bbf7d0", color: "#166534" }}
        >
          {actionData.ok}
        </div>
      ) : null}

      <section style={panel}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>
          App name
        </h2>
        <p style={{ fontSize: "0.8rem", color: "#52627A", marginTop: 0 }}>
          Shown beside the logo and used as the fallback when a slot has no image. Leave it blank
          to use the default, <strong>{brand.defaultDisplayName}</strong>.
        </p>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <input type="hidden" name="intent" value="display-name" />
          <div style={{ flex: "1 1 260px" }}>
            <label style={label} htmlFor="brand-display-name">
              Display name
            </label>
            <input
              id="brand-display-name"
              name="displayName"
              style={input}
              defaultValue={brand.displayName}
              maxLength={60}
              placeholder={brand.defaultDisplayName}
            />
          </div>
          <button type="submit" style={button("primary")} disabled={busy}>
            Save name
          </button>
        </Form>
      </section>

      {slots.map((spec) => {
        const state = brand.slots.find((entry) => entry.slot === spec.slot);
        const fallbackState = spec.fallback
          ? brand.slots.find((entry) => entry.slot === spec.fallback)
          : null;
        const shown = state?.live?.url ?? fallbackState?.live?.url ?? null;
        const usingFallback = !state?.live && !!fallbackState?.live;

        return (
          <section key={spec.slot} style={panel}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 320px" }}>
                <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0, marginBottom: "0.2rem" }}>
                  {spec.label}
                </h2>
                <p style={{ fontSize: "0.8rem", color: "#52627A", margin: "0 0 0.35rem" }}>{spec.purpose}</p>
                <p style={{ fontSize: "0.74rem", color: "#64748B", margin: 0 }}>{spec.shape}</p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    padding: "0.25rem 0.6rem",
                    borderRadius: 999,
                    background: state?.live ? "#DCFCE7" : "#F1F5F9",
                    color: state?.live ? "#166534" : "#475569",
                    border: `1px solid ${state?.live ? "#bbf7d0" : "#DCE3EB"}`,
                    alignSelf: "flex-start",
                  }}
                >
                  {state?.live
                    ? `Uploaded · v${state.live.version} · ${state.live.width}×${state.live.height}`
                    : usingFallback
                      ? `Using the ${spec.fallback!.toLowerCase()} logo`
                      : "Using the wordmark"}
                </span>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "0.75rem",
                margin: "0.9rem 0",
              }}
            >
              <div>
                <div style={{ ...label, color: "#52627A" }}>On light</div>
                <Preview url={shown} alt={brand.displayName} background="#FFFFFF" tone="light" />
              </div>
              <div>
                <div style={{ ...label, color: "#52627A" }}>On the navy sidebar</div>
                {state?.slot === "DARK" && state.live ? (
                  <Preview
                    url={state.live.url}
                    alt={brand.displayName}
                    background="#142440"
                    tone="dark"
                  />
                ) : (
                  /*
                   * No dark-background variant: the app draws THIS slot's image on
                   * a white chip inside the navy bar, so that is what is previewed.
                   * A square slot shows its square mark, not the primary logo —
                   * the fallback is per slot, and drawing the primary here would
                   * misrepresent the other three.
                   */
                  <Preview
                    url={shown}
                    alt={brand.displayName}
                    background="#142440"
                    tone="dark"
                    whiteBacking
                  />
                )}
                <p style={{ fontSize: "0.7rem", color: "#64748B", margin: "0.3rem 0 0" }}>
                  {state?.slot === "DARK" && state.live
                    ? "A dark-background logo is set, so it is used as-is."
                    : "No dark-background logo is set, so this image is shown on a white backing — the sidebar draws it exactly like this."}
                </p>
              </div>
            </div>

            <Form
              method="post"
              encType="multipart/form-data"
              style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}
            >
              <input type="hidden" name="intent" value="upload" />
              <input type="hidden" name="slot" value={spec.slot} />
              <div style={{ flex: "1 1 280px" }}>
                <label style={label} htmlFor={`brand-file-${spec.slot}`}>
                  {state?.live ? "Replace with" : "Upload"} — PNG, JPEG or WebP, up to 5 MB
                </label>
                <input
                  id={`brand-file-${spec.slot}`}
                  type="file"
                  name="file"
                  accept="image/png,image/jpeg,image/webp"
                  required
                  style={{ ...input, padding: "0.35rem" }}
                />
              </div>
              <button type="submit" style={button("primary")} disabled={busy}>
                {busy ? "Uploading…" : state?.live ? "Replace" : "Upload"}
              </button>
            </Form>

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
              {state?.live ? (
                /*
                 * RESET ASKS FIRST, INSIDE THE PAGE. Not `window.confirm` — a
                 * browser dialog can be suppressed permanently by "prevent this
                 * page from creating additional dialogs", after which the button
                 * silently stops working and reports nothing. The arming press is
                 * local state, so it cannot be switched off.
                 *
                 * It resets THIS slot only, and the slot is the hidden field, so
                 * the request says exactly which one it is about.
                 */
                <Form method="post">
                  <input type="hidden" name="intent" value="reset" />
                  <input type="hidden" name="slot" value={spec.slot} />
                  {armedReset === spec.slot ? (
                    <>
                      <span role="status" style={{ fontSize: "0.75rem", color: "#92400E", marginRight: "0.4rem" }}>
                        Reset {spec.label.toLowerCase()} to the default?
                      </span>
                      <button type="submit" style={button()} disabled={busy}>
                        Yes, reset
                      </button>
                      <button
                        type="button"
                        style={button()}
                        onClick={() => setArmedReset(null)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" style={button()} onClick={() => setArmedReset(spec.slot)} disabled={busy}>
                      Reset to default
                    </button>
                  )}
                </Form>
              ) : null}
              {state && state.history.length > 0 ? (
                <button
                  type="button"
                  style={button()}
                  onClick={() => setShowHistory(showHistory === spec.slot ? null : spec.slot)}
                >
                  {showHistory === spec.slot ? "Hide" : "Show"} previous versions ({state.history.length})
                </button>
              ) : null}
            </div>

            {showHistory === spec.slot && state ? (
              <div style={{ marginTop: "0.75rem", borderTop: "1px solid #DCE3EB", paddingTop: "0.6rem" }}>
                {state.history.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "center",
                      fontSize: "0.78rem",
                      padding: "0.3rem 0",
                      flexWrap: "wrap",
                    }}
                  >
                    <img
                      src={entry.url}
                      alt={`${spec.label} version ${entry.version}`}
                      style={{ height: 32, maxWidth: 120, objectFit: "contain", background: "#F5F7FA", padding: 2, borderRadius: 4 }}
                    />
                    <span style={{ color: "#52627A" }}>
                      v{entry.version} · {entry.width}×{entry.height} · {formatDateTime(entry.createdAt)}
                      {entry.createdByName ? ` · ${entry.createdByName}` : ""}
                    </span>
                    <Form method="post">
                      <input type="hidden" name="intent" value="restore" />
                      <input type="hidden" name="slot" value={spec.slot} />
                      <input type="hidden" name="version" value={entry.version} />
                      <button type="submit" style={button()} disabled={busy}>
                        Restore this version
                      </button>
                    </Form>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}

      <section style={panel}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#142440", marginTop: 0 }}>
          Shopify app icon
        </h2>
        <p style={{ fontSize: "0.82rem", color: "#52627A", lineHeight: 1.7 }}>
          Shopify&apos;s app icon is configured in the <strong>Shopify Dev Dashboard</strong>, under
          your app&apos;s Settings ▸ Branding. An upload here does <strong>not</strong> change it,
          and it does not change the icon shown in the Shopify admin navigation — those are
          Shopify&apos;s own surfaces.
        </p>
        <p style={{ fontSize: "0.82rem", color: "#52627A", lineHeight: 1.7 }}>
          Download the square logo prepared at 1200 × 1200, then upload it there. The mark is
          padded onto a white square rather than stretched, so it keeps its proportions.
        </p>
        {/*
          A LINK, NOT A FORM. This control used to POST an `intent` whose action
          returned the PNG bytes — and React Router treats an action's return
          value as page data, so the page received an image where it expected a
          result, threw `Cannot use 'in' operator to search for 'error' in <PNG>`,
          and rendered the artwork as garbled text under "Application Error!".
          The download is a resource route now and this navigates to it.
        */}
        <a
          href="/admin/branding/icon.png"
          download
          className="mv-button"
          style={{
            marginTop: "0.5rem",
            display: "inline-flex",
            ...(brand.slots.find((entry) => entry.slot === "SQUARE")?.live ? {} : { pointerEvents: "none", opacity: 0.5 }),
          }}
          aria-disabled={!brand.slots.find((entry) => entry.slot === "SQUARE")?.live}
        >
          Download 1200 × 1200 PNG
        </a>
        {!brand.slots.find((entry) => entry.slot === "SQUARE")?.live ? (
          <p style={{ fontSize: "0.74rem", color: "#92400E", marginTop: "0.4rem" }}>
            Upload the square icon first.
          </p>
        ) : null}
        <p style={{ fontSize: "0.72rem", color: "#64748B", marginTop: "0.75rem", lineHeight: 1.6 }}>
          Every upload is decoded and re-encoded on the server, which strips camera and location
          metadata and proves the file really is an image before it is stored. SVG is not accepted.
        </p>
      </section>
    </div>
  );
}
