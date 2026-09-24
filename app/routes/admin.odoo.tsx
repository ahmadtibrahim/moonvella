/**
 * The Odoo catalogue: what is connected, what is synced, and what was left out.
 *
 * TWO CONTROLS, ONE CODE PATH. "Sync now" and the six-hourly scheduled sync run
 * the same function — `syncOdooCatalog` — and both record a row in the job
 * table, so "when did this last run and what did it say" has one answer rather
 * than one per control. The preview above the button is the same read the sync
 * does, rendered before anybody presses anything.
 *
 * WHAT THIS PAGE OWES THE OPERATOR. Three things, and each of them is a thing
 * that goes wrong quietly without it: whether Odoo is actually connected (an
 * authenticated read, not "fields are filled in"), what the last run did and
 * when the next one is due, and — for every tagged product that was NOT written
 * — the reason, in the product's own name. A sync that reports "3 products" and
 * silently skips a fourth is worse than one that fails.
 *
 * It also shows what Odoo does NOT hold, such as a description on a template
 * that has none, because the alternative is an owner discovering a blank field
 * afterwards and having to guess whether MoonVella lost it or Odoo never had it.
 */

import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin } from "~/utils/adminAuth.server";
import { previewOdooImport } from "~/services/odooImport.server";
import { catalogSyncStatus, runCatalogSyncNow } from "~/services/odooSync.server";
import { RECURRING_JOBS, JOB_KIND } from "~/services/jobs.server";

const SYNC_EVERY_MS =
  RECURRING_JOBS.find((job) => job.kind === JOB_KIND.ODOO_CATALOG_SYNC)?.everyMs ?? 6 * 60 * 60 * 1000;

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "products.view");
  const [preview, sync] = await Promise.all([
    previewOdooImport(),
    catalogSyncStatus({ everyMs: SYNC_EVERY_MS }),
  ]);
  return { preview, sync, everyMs: SYNC_EVERY_MS };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  await requirePermission(request, "products.manage");
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent !== "sync") return { error: "Unknown action." };

  const outcome = await runCatalogSyncNow();
  if (!outcome.ok) return { error: outcome.error };
  return { synced: outcome.outcome };
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};

function money(value: number, currency: string) {
  return `${currency} ${value.toFixed(2)}`;
}

/** "in 3 h 20 min", or "now" when the moment has passed. */
function untilLabel(target: Date | null, now: number): string {
  if (!target) return "—";
  const ms = target.getTime() - now;
  if (ms <= 0) return "due now — the next cron tick picks it up";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours} h ${minutes % 60} min`;
}

function whenLabel(value: Date | null): string {
  return value ? new Date(value).toLocaleString() : "never";
}

export default function AdminOdooImport() {
  const { preview, sync, everyMs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const detail = sync.lastRun?.detail as
    | {
        blocked?: { odooTemplateId: number; name: string; problems: string[] }[];
        withdrawn?: { productId: string; name: string; reason: string }[];
        notes?: string[];
        created?: number;
        updated?: number;
        variants?: number;
        archived?: number;
        defaultPickupLocationId?: string | null;
      }
    | null
    | undefined;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Odoo catalogue
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.82rem", marginBottom: "1.25rem", lineHeight: 1.6 }}>
        Reads the Odoo products carrying the <strong>MoonVella App</strong> product tag and writes
        them into this catalogue as <strong>drafts</strong>. Nothing is published by a sync, and
        nothing in Odoo is changed — inventory and prices are read, never written. A seller is
        charged each <strong>variant&apos;s effective sales price</strong> in Odoo — the price on the
        variant&apos;s own form, which is the template&apos;s list price plus that variant&apos;s
        attribute price extras — and never the product&apos;s cost and never zero. Suggested retail
        is not imported: it stays MoonVella&apos;s own field, and nothing here writes a
        seller&apos;s storefront prices.
      </p>

      {actionData && "error" in actionData && actionData.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>
          {actionData.error}
        </div>
      ) : null}

      {actionData && "synced" in actionData && actionData.synced ? (
        <div style={{ ...card, background: "#f0fdf4", borderColor: "#bbf7d0", color: "#065f46" }}>
          <strong>{actionData.synced.summary}</strong>
        </div>
      ) : null}

      {/* Last run, next run and counts. The three questions an operator has
          about a scheduled job, answered from the job table rather than from a
          promise that it is running. */}
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>
              Automatic sync
            </h2>
            <div style={{ fontSize: "0.82rem", color: "#334155", lineHeight: 1.7 }}>
              <div>
                Runs every {Math.round(everyMs / 3600000)} hours through the job worker.{" "}
                {sync.running ? (
                  <strong style={{ color: "#b45309" }}>A run is queued or in progress now.</strong>
                ) : (
                  <>Next run {untilLabel(sync.nextRunAt, Date.now())}.</>
                )}
              </div>
            </div>
          </div>

          <Form method="post">
            <button
              type="submit"
              name="intent"
              value="sync"
              disabled={submitting || sync.running || preview.blockers.length > 0}
              style={{
                padding: "0.7rem 1.1rem",
                border: "1px solid #082a4a",
                borderRadius: 8,
                background: submitting || sync.running || preview.blockers.length > 0 ? "#f1f5f9" : "#082a4a",
                color: submitting || sync.running || preview.blockers.length > 0 ? "#94a3b8" : "white",
                fontWeight: 600,
                fontSize: "0.82rem",
                cursor: submitting || sync.running || preview.blockers.length > 0 ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Syncing…" : "Sync now"}
            </button>
          </Form>
        </div>

        <div style={{ marginTop: "0.9rem", fontSize: "0.82rem", color: "#334155", lineHeight: 1.7 }}>
          {sync.lastRun ? (
            <>
              <div>
                Last run: <strong>{sync.lastRun.status}</strong> · finished{" "}
                {whenLabel(sync.lastRun.finishedAt ?? sync.lastRun.startedAt)}
              </div>
              {sync.lastRun.summary ? <div>{sync.lastRun.summary}</div> : null}
              {sync.lastRun.status === "FAILED" && sync.lastRun.error ? (
                <div style={{ color: "#991b1b" }}>{sync.lastRun.error}</div>
              ) : null}
              {sync.lastRun.status === "SUCCEEDED" && !sync.lastRun.summary ? (
                <div style={{ color: "#92400e" }}>
                  This run predates the current sync report and has no counts recorded.
                </div>
              ) : null}
            </>
          ) : (
            <div style={{ color: "#64748b" }}>
              No sync has run yet. The first one is queued by the next cron tick, or press Sync now.
            </div>
          )}
        </div>

        {detail?.notes?.length ? (
          <div style={{ marginTop: "0.6rem" }}>
            {detail.notes.map((note) => (
              <div key={note} style={{ fontSize: "0.78rem", color: "#475569" }}>
                · {note}
              </div>
            ))}
          </div>
        ) : null}

        {/* A product Odoo cannot describe completely is skipped, not imported at
            a guess — and the reason belongs on a screen, in the product's name. */}
        {detail?.blocked?.length ? (
          <div style={{ marginTop: "0.75rem", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "0.7rem" }}>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#92400e", marginBottom: "0.3rem" }}>
              {detail.blocked.length} tagged product(s) were left out of the last sync
            </div>
            {detail.blocked.map((item) => (
              <div key={item.odooTemplateId} style={{ fontSize: "0.78rem", color: "#78350f", marginTop: "0.3rem" }}>
                <strong>{item.name}</strong> (Odoo template {item.odooTemplateId})
                {item.problems.map((problem) => (
                  <div key={problem}>· {problem}</div>
                ))}
              </div>
            ))}
          </div>
        ) : null}

        {detail?.withdrawn?.length ? (
          <div style={{ marginTop: "0.75rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.7rem" }}>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
              {detail.withdrawn.length} product(s) withdrawn from sale
            </div>
            {detail.withdrawn.map((item) => (
              <div key={item.productId} style={{ fontSize: "0.78rem", color: "#475569" }}>
                · <strong>{item.name}</strong> — {item.reason}. Archived, not deleted: existing
                orders still reference it, and its inventory is left at the last figure read.
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.75rem" }}>
          Connection
        </h2>
        <div style={{ fontSize: "0.82rem", color: "#334155", lineHeight: 1.7 }}>
          <div>
            URL: <strong>{preview.connection.url ?? "not configured"}</strong>
          </div>
          <div>
            Database: <strong>{preview.connection.database ?? "not configured"}</strong>
          </div>
          <div>
            Mode: <strong>{preview.connection.mode ?? "unknown"}</strong>
          </div>
          <div>
            Product tag:{" "}
            <strong>
              {preview.tag ? `${preview.tag.name} (id ${preview.tag.id})` : "not found in Odoo"}
            </strong>
          </div>
          <div>
            Fulfillment warehouse:{" "}
            <strong>
              {preview.warehouse
                ? `${preview.warehouse.name} (id ${preview.warehouse.id}) — locations under ${preview.warehouse.rootLocationName}`
                : "not configured"}
            </strong>
          </div>
          {/* The pricing authority, on the same card as the connection: what a
              seller is charged is decided by this sentence and by nothing else. */}
          <div>
            Sales price charged:{" "}
            <strong>{preview.pricing.currency}</strong>
          </div>
        </div>
        {preview.pricing.note ? (
          <p style={{ fontSize: "0.74rem", color: "#64748b", marginTop: "0.5rem" }}>
            {preview.pricing.note}
          </p>
        ) : null}
        {preview.warehouse?.note ? (
          <p style={{ fontSize: "0.74rem", color: "#64748b", marginTop: "0.5rem" }}>
            {preview.warehouse.note}
          </p>
        ) : null}
      </div>

      {preview.blockers.length > 0 ? (
        <div style={{ ...card, background: "#fffbeb", borderColor: "#fcd34d" }}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#92400e", marginBottom: "0.5rem" }}>
            The sync cannot run
          </h2>
          {preview.blockers.map((blocker) => (
            <div key={blocker.code} style={{ marginBottom: "0.6rem" }}>
              <div style={{ fontSize: "0.82rem", color: "#92400e", fontWeight: 600 }}>
                {blocker.message}
              </div>
              <div style={{ fontSize: "0.78rem", color: "#78350f" }}>{blocker.remedy}</div>
            </div>
          ))}
          <p style={{ fontSize: "0.75rem", color: "#78350f" }}>
            Nothing below runs until these are cleared, and no stock or price figure is substituted
            while Odoo cannot be read. A number that looks plausible but did not come from the
            source is worse than a missing one — so a variant whose sales price Odoo will not state
            is left out of the sync rather than arriving at the product&apos;s cost or at zero, and
            a failed stock read stops the run rather than being recorded as no stock.
          </p>
        </div>
      ) : null}

      {preview.templates.map((template) => (
        <div key={template.odooTemplateId} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a" }}>
                {template.odooName}
              </h2>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                Odoo template {template.odooTemplateId} · {template.odooCategory} ·{" "}
                storefront currency {template.currency}
              </div>
            </div>
            <div style={{ fontSize: "0.75rem", color: "#475569", textAlign: "right" }}>
              <div>
                Product Code <strong>{template.productCode}</strong>
              </div>
              <div style={{ color: "#94a3b8" }}>{template.codeSource}</div>
              <div style={{ color: template.existingProductId ? "#059669" : "#94a3b8" }}>
                {template.existingProductId
                  ? "already imported — this will update the existing product"
                  : "not imported yet — this will create a draft"}
              </div>
            </div>
          </div>

          <div style={{ fontSize: "0.78rem", color: "#334155", marginTop: "0.6rem" }}>
            <div>
              Description:{" "}
              {template.description ? (
                <span>{template.description}</span>
              ) : (
                <span style={{ color: "#b45309" }}>
                  none in Odoo — the draft&apos;s description is left empty
                </span>
              )}
            </div>
            <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{template.descriptionSource}</div>
          </div>

          {template.problems.length > 0 ? (
            <div style={{ marginTop: "0.6rem", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "0.6rem" }}>
              {template.problems.map((problem) => (
                <div key={problem} style={{ fontSize: "0.76rem", color: "#991b1b" }}>
                  · {problem}
                </div>
              ))}
            </div>
          ) : null}

          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem", fontSize: "0.79rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b", fontSize: "0.7rem" }}>
                <th style={th}>Variant</th>
                <th style={th}>SKU</th>
                <th style={th}>Attributes</th>
                <th style={th}>Sales price (charged)</th>
                <th style={th}>Cost</th>
                <th style={th}>Available</th>
              </tr>
            </thead>
            <tbody>
              {template.variants.map((variant) => (
                <tr key={variant.odooVariantId} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>
                    Odoo {variant.odooVariantId}
                    {variant.existingVariantId ? (
                      <span style={{ color: "#059669" }}> (existing)</span>
                    ) : null}
                  </td>
                  <td style={td}>
                    {variant.sku ?? <span style={{ color: "#b91c1c" }}>missing</span>}
                  </td>
                  <td style={td}>
                    {variant.attributes.length
                      ? variant.attributes
                          .map((attribute) => `${attribute.attribute}: ${attribute.value}`)
                          .join(", ")
                      : "—"}
                  </td>
                  {/* The figure a seller is charged, and where it came from so
                      it can be traced rather than taken on trust. This is the
                      variant's own effective sales price — list price plus its
                      attribute extras — read from Odoo, not computed here. A
                      variant with no such price shows that instead of a number,
                      and is left out of the sync. */}
                  <td style={td}>
                    {variant.wholesalePrice === null ? (
                      <span style={{ color: "#b91c1c" }}>no sales price</span>
                    ) : (
                      money(variant.wholesalePrice, variant.wholesaleCurrency ?? "")
                    )}
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                      Odoo effective sales price
                    </div>
                  </td>
                  <td style={td}>
                    {variant.cost === null ? "—" : money(variant.cost, template.currency)}
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>never charged</div>
                  </td>
                  {/* The total, and then every record it is made of. The
                      breakdown is the answer to "whose stock, and where" — a
                      total counted across a whole warehouse can be several
                      owners' goods and the company's own, and a figure nobody
                      can trace is a figure nobody can check. */}
                  <td style={td}>
                    <strong>{variant.available}</strong>
                    <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                      {variant.onHand} on hand − {variant.reserved} reserved
                    </div>
                    {variant.stock.length === 0 ? (
                      <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>
                        no stock at this warehouse
                      </div>
                    ) : (
                      variant.stock.map((record) => (
                        <div
                          key={`${record.locationId}-${record.ownerId ?? "company"}`}
                          style={{ fontSize: "0.68rem", color: "#94a3b8" }}
                        >
                          {record.quantity} at {record.locationName} ·{" "}
                          {record.ownerName ?? "company-owned"}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {preview.notes.length > 0 ? (
        <div style={card}>
          <h2 style={{ fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.5rem" }}>
            Notes
          </h2>
          {preview.notes.map((note) => (
            <div key={note} style={{ fontSize: "0.78rem", color: "#475569" }}>
              · {note}
            </div>
          ))}
        </div>
      ) : null}

      {/* The whole read, before it is written. Everything above this point is a
          preview of the same call the sync makes; pressing Sync once is the only
          thing that changes a row. */}
      <div style={card}>
        <Form method="post">
          <button
            type="submit"
            name="intent"
            value="sync"
            disabled={submitting || sync.running || preview.blockers.length > 0}
            style={{
              padding: "0.7rem 1.1rem",
              border: "1px solid #082a4a",
              borderRadius: 8,
              background: submitting || sync.running || preview.blockers.length > 0 ? "#f1f5f9" : "#082a4a",
              color: submitting || sync.running || preview.blockers.length > 0 ? "#94a3b8" : "white",
              fontWeight: 600,
              fontSize: "0.82rem",
              cursor: submitting || sync.running || preview.blockers.length > 0 ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Syncing…" : "Sync now"}
          </button>
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: "0.5rem" }}>
            Odoo is read again when this runs, and the same call runs automatically every{" "}
            {Math.round(everyMs / 3600000)} hours. If anything above has changed for the worse, the
            sync refuses rather than writing a partially-checked catalogue; if a single product is
            incomplete, that one is skipped and named.
          </p>
        </Form>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.3rem 0.4rem", fontWeight: 600 };
const td: React.CSSProperties = { padding: "0.4rem", verticalAlign: "top", color: "#334155" };
