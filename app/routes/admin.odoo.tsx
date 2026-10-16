/**
 * The retired Odoo integration, under Advanced settings.
 *
 * WHERE THIS PAGE CAME FROM. Until 2026-10-16 this was the Odoo catalogue page:
 * a live preview of the tagged ERP templates, a "Sync now" button, and a
 * six-hourly job behind both. The owner has moved MoonVella's catalogue and
 * accounting into this application, so all three of those are gone — and a page
 * that still showed a green "Connected" badge over a switched-off integration
 * was the specific complaint that started this work.
 *
 * WHAT IT IS NOW, AND WHAT IT DELIBERATELY IS NOT.
 *
 *   * It makes NO Odoo request. Not a connection probe, not a preview, not a
 *     read. `previewOdooImport` is not called, so opening this page cannot
 *     depend on an ERP being reachable — and the mode gate, which refuses even
 *     reads while disabled, is never approached.
 *   * It holds NO control that starts work. There is no sync button and no
 *     import button, because there is no longer any operation on the other side
 *     of them.
 *   * It REPORTS HISTORY. What ran, when, and what it left behind: the job rows
 *     are kept rather than deleted, which is what the work order requires, and
 *     the external ids the catalogue was migrated from are still on the records.
 *
 * THE BADGE SAYS DISABLED. The state comes from `listIntegrationStates`, which
 * reports a switched-off integration as DISABLED rather than HEALTHY — the
 * distinction that a whole migration was needed to make honest. The paragraph
 * beside it explains what is retained, so "disabled" cannot be read as "your
 * credentials were thrown away".
 *
 * WHY IT IS STILL REACHABLE AT ALL. The credentials, the external id mappings
 * and the job history are real records that somebody may need to consult — for
 * an audit, a reconciliation, or the question "what did the old sync actually
 * do". Deleting the surface would not delete the data; it would only make the
 * data unreachable.
 */

import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { maskedOdooConnection, classifyOdooMode } from "~/services/odoo.server";
import { getCredentials } from "~/services/credentials.server";
import { listIntegrationStates } from "~/services/integrationHealth.server";
import { formatDateTime } from "~/utils/dates";

/** Job kinds that belonged to the retired integration. History, read only. */
const RETIRED_KINDS = ["ODOO_CONTACT_SYNC", "ODOO_INVOICE_SYNC", "ODOO_PRODUCT_IMPORT", "ODOO_CATALOG_SYNC"];

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "products.view");

  // Local reads only. Nothing below reaches Odoo, so this page renders on a host
  // with no route to the ERP at all.
  const [masked, stored, states, jobs, mappings] = await Promise.all([
    maskedOdooConnection(),
    getCredentials("odoo"),
    listIntegrationStates(),
    prisma.backgroundJob.groupBy({
      by: ["kind", "status"],
      where: { kind: { in: RETIRED_KINDS } },
      _count: { _all: true },
      orderBy: { kind: "asc" },
    }),
    Promise.all([
      prisma.externalProductMapping.count({ where: { provider: "ODOO" } }),
      prisma.externalVariantMapping.count({ where: { provider: "ODOO" } }),
      // This table is Odoo-only — it has no `provider` column, because a contact
      // was never mirrored anywhere else. A null `odooPartnerId` is a mapping
      // that was never written, so it is counted as a link only once it has one.
      prisma.externalContactMapping.count({ where: { odooPartnerId: { not: null } } }),
    ]),
  ]);

  const mode = classifyOdooMode({
    configured: Boolean(masked),
    mode: stored.ODOO_MODE ?? null,
    // Read from the deployment, never from a form — the same two-key rule the
    // connector applies, so this page cannot report a mode the connector would
    // not actually permit.
    writesAllowed: process.env.ODOO_ALLOW_WRITES?.trim().toLowerCase() === "yes",
  });

  const state = states.find((entry) => entry.key === "odoo") ?? null;

  return {
    retained: {
      url: masked?.url ?? null,
      database: masked?.database ?? null,
      username: masked?.username ?? null,
      apiKeySet: Boolean(masked?.apiKeySet),
      mode,
    },
    state,
    jobs: jobs.map((row) => ({
      kind: row.kind,
      status: row.status,
      count: row._count._all,
    })),
    mappings: { products: mappings[0], variants: mappings[1], contacts: mappings[2] },
  };
}

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.5rem",
  marginBottom: "1.5rem",
};

const heading: React.CSSProperties = {
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "#082a4a",
  marginBottom: "0.75rem",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.82rem", padding: "0.2rem 0" }}>
      <div style={{ color: "#64748b", minWidth: 190 }}>{label}</div>
      <div style={{ color: "#172B4D" }}>{children}</div>
    </div>
  );
}

export default function AdminOdooLegacy() {
  const { retained, state, jobs, mappings } = useLoaderData<typeof loader>();

  const isDisabled = retained.mode === "disabled";

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: "#142440", margin: 0 }}>
          Odoo (retired)
        </h1>
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            padding: "0.25rem 0.6rem",
            borderRadius: 999,
            background: isDisabled ? "#F1F5F9" : "#FEF3C7",
            color: isDisabled ? "#475569" : "#92400E",
            border: `1px solid ${isDisabled ? "#DCE3EB" : "#fcd34d"}`,
          }}
        >
          {isDisabled ? "Disabled" : `Mode: ${retained.mode}`}
        </span>
      </div>

      <p style={{ color: "#52627A", fontSize: "0.85rem", marginTop: "0.6rem", lineHeight: 1.7 }}>
        MoonVella&apos;s catalogue and customer accounting are its own. No product, price, stock
        figure, customer record or invoice is read from or written to Odoo by this application, and
        nothing is queued to do so later. This page is kept so the retained records stay reachable.
      </p>

      <div style={card}>
        <h2 style={heading}>What is retained</h2>
        <div style={{ fontSize: "0.82rem", color: "#334155", lineHeight: 1.8 }}>
          <div>
            · <strong>Credentials</strong> — the saved Odoo URL, database, username and API key are
            kept, encrypted, exactly as they were. Nothing reads them. They were not deleted,
            because deleting them was not asked for and a credential that is gone cannot be
            audited.
          </div>
          <div>
            · <strong>External id mappings</strong> — {mappings.products} product,{" "}
            {mappings.variants} variant and {mappings.contacts} contact mapping(s) record which Odoo
            record each MoonVella row came from. Historical metadata: no decision reads them.
          </div>
          <div>
            · <strong>Job history</strong> — every sync, import and invoice job that ever ran, with
            what it did and what it said. Retained; a job that was queued but never ran is
            cancelled with the reason recorded rather than deleted.
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={heading}>Stored connection</h2>
        {retained.url ? (
          <>
            <Row label="URL">{retained.url}</Row>
            <Row label="Database">{retained.database ?? "not set"}</Row>
            <Row label="Username">{retained.username ?? "not set"}</Row>
            <Row label="API key">{retained.apiKeySet ? "set (value not shown)" : "not set"}</Row>
            <Row label="Mode">{retained.mode}</Row>
          </>
        ) : (
          <p style={{ fontSize: "0.82rem", color: "#52627A", margin: 0 }}>
            No Odoo connection was ever saved.
          </p>
        )}
        <p style={{ fontSize: "0.75rem", color: "#64748B", marginTop: "0.75rem", marginBottom: 0, lineHeight: 1.6 }}>
          The mode above is the stored setting, read locally. No connection is attempted from this
          page, so a saved-but-unreachable ERP is reported here as disabled rather than as an error —
          which is what it is: switched off, not broken.
        </p>
      </div>

      {state ? (
        <div style={card}>
          <h2 style={heading}>Last recorded health</h2>
          <Row label="Status">{state.status}</Row>
          <Row label="Summary">{state.message}</Row>
          <Row label="Last recorded">
            {state.lastSuccessAt
              ? formatDateTime(new Date(state.lastSuccessAt))
              : state.lastErrorAt
                ? `${formatDateTime(new Date(state.lastErrorAt))} (failed)`
                : "never"}
          </Row>
        </div>
      ) : null}

      <div style={card}>
        <h2 style={heading}>Retired job history</h2>
        {jobs.length === 0 ? (
          <p style={{ fontSize: "0.82rem", color: "#52627A", margin: 0 }}>
            No jobs were ever recorded for the retired flows.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#52627A", fontSize: "0.72rem" }}>
                <th style={th}>Job kind</th>
                <th style={th}>Status</th>
                <th style={th}>Rows</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((row) => (
                <tr key={`${row.kind}-${row.status}`} style={{ borderTop: "1px solid #DCE3EB" }}>
                  <td style={td}>{row.kind}</td>
                  <td style={td}>{row.status}</td>
                  <td style={td}>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ fontSize: "0.75rem", color: "#64748B", marginTop: "0.75rem", marginBottom: 0, lineHeight: 1.6 }}>
          A cancelled row means the flow it belonged to was removed before the job ran. It is kept as
          the honest record of that, rather than as a deletion.
        </p>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.35rem 0.4rem", fontWeight: 600 };
const td: React.CSSProperties = { padding: "0.45rem", color: "#172B4D" };
