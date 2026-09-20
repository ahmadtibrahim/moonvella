# MoonVella — Phase 11 Acceptance Report

Date: 2026-09-20
Scope: end-to-end acceptance test harness + factual status of Phases 3–11 (plus product grid / order packing).
Environment: local Windows dev checkout, Prisma + SQLite (`prisma/dev.sqlite`). The dev server was stopped throughout; no browser, no live provider, no `prisma generate`/`migrate` and no `npm run build` were run.

## 1. Architecture overview

- **Runtime**: React Router 7 (framework mode) + TypeScript strict. UI is split into an owner/admin surface (`app/routes/admin.*`) and a merchant/seller surface (`app/routes/app.*`), plus Shopify webhook routes (`app/routes/webhooks.*`).
- **Data**: Prisma + SQLite. Schema in `prisma/schema.prisma`; migrations in `prisma/migrations/` (notably `20260920195525_phase3_10_batch`). The app connects through the singleton in `app/db.server.ts`.
- **Domain services** (`app/services/*.server.ts`): business logic lives here and is called by route loaders/actions and webhooks. Cross-cutting concerns are `audit.server.ts` (audit trail), `integrationHealth.server.ts` (per-provider state) and `storage.server.ts` (image persistence).
- **Integrations** are boundary modules that run in a clearly-labelled **simulated mode** when credentials are absent: `payments.server.ts` / `sellerBilling.server.ts` (Stripe), `eshipper.server.ts` (rates/labels), `plaid.server.ts` (bank linking), and `shopifyImport.server.ts` / `shopifyFulfillment.server.ts` (Shopify Admin).
- **Auth**: two independent systems — owner auth (`app/services/ownerAuth.server.ts`, `app/utils/ownerAuth.server.ts`, cookie `owner_session`, RBAC `OWNER/OPERATIONS/REVIEWER/READONLY`) and Shopify session auth for the merchant surface (`app/services/seller.server.ts`, `app/shopify.server.js`).

## 2. Phase map

The repository does not label phases in code. The mapping below is inferred from the feature set and the existing verify-script names; the `phase3_10_batch` migration confirms phases 3–10 were delivered as one batch.

| Phase | Feature | Key implementation |
| --- | --- | --- |
| 1 | Owner auth, application review, seller lifecycle | `app/utils/ownerAuth.server.ts`, `app/services/ownerAuth.server.ts`, `app/services/application.server.ts`, `app/routes/admin_.login.tsx`, `admin.applications.tsx`, `admin.applications_.$id.tsx`, `admin.sellers.tsx` |
| 2 | Merchant app shell / dashboard | `app/routes/app.jsx`, `app._index.jsx`, `app/services/seller.server.ts` |
| 3 | Merchant onboarding intake + status | `app/routes/app.application.jsx`, `app.status.jsx` |
| 4 | Public + approved catalog | `app/services/catalog.server.ts`, `app/routes/app.catalog.jsx` |
| 5 | **Product grid** / catalog CRUD (variants, images, packaging) | `app/services/products.server.ts`, `packaging.server.ts`, `storage.server.ts`, `app/routes/admin.products.tsx`, `admin.products_.$id.tsx`, `uploads.$filename.tsx` |
| 6 | Product import to Shopify | `app/services/shopifyImport.server.ts`, `app/routes/app.catalog.jsx`, `app.products.jsx` |
| 7 | Order intake (webhooks) | `app/services/orderIntake.server.ts`, `app/routes/webhooks.orders.jsx` |
| 8 | Fulfillment requests + **order packing** | `app/services/fulfillmentRequest.server.ts`, `app/services/fulfillment.server.ts`, `app/services/packaging.server.ts`, `app/routes/admin.packing.$orderId.tsx` |
| 9 | Shipping quotes/booking + Shopify fulfillment sync | `app/services/shipping.server.ts`, `eshipper.server.ts`, `shopifyFulfillment.server.ts`, `app/routes/admin.shipping.tsx`, `admin.orders_.$id.tsx` |
| 10 | Wholesale payments + seller billing + Plaid bank linking | `app/services/payments.server.ts`, `sellerBilling.server.ts`, `plaid.server.ts`, `app/routes/app.billing.jsx`, `admin.orders_.$id.tsx`, `webhooks.stripe.tsx` |
| 11 | Rankings/analytics, audit, integration health, acceptance | `app/services/rankings.server.ts`, `analytics.server.ts`, `audit.server.ts`, `integrationHealth.server.ts`, `app/routes/admin.rankings.tsx`, `admin.rankings.csv.tsx`, `admin.audit.tsx`, `admin.settings.tsx` |

## 3. Verification

### 3.1 Harness

- `scripts/run-verify.mjs` — runner. Bundles a TS verify script with `npx esbuild` (`--bundle --platform=node --format=esm --target=node20 --alias:~=./app --packages=external`) to a temporary `scripts/.verify-*.mjs`, runs it with `node`, deletes the temp file and propagates the exit code. `--all` runs the whole suite; `--seed-packaging` creates (and removes) a throwaway product/variant/packaging row so `verify-packaging.ts` (which needs a variant id argv) is self-sufficient. When `APP_ENCRYPTION_KEY` is absent it injects a **test-only** key for `verify-plaid.ts` only.
- `scripts/verify-e2e.ts` — Phase 11 acceptance scenario (see 3.3).
- `package.json` — added `verify:phase5`, `verify:rankings`, `verify:orders`, `verify:payments`, `verify:wholesale`, `verify:packaging`, `verify:plaid`, `verify:e2e`, `verify:all` (existing scripts kept).

TypeScript gate: `npx tsc --noEmit` → clean (no output).

### 3.2 `npm run verify:all` results

Command: `npm run verify:all` → exit code **0**.

| Script | Kind | Result | Checks |
| --- | --- | --- | --- |
| `verify:phase1` | HTTP E2E (`mjs`) | **SKIPPED** | needs `OWNER_EMAIL`/`OWNER_PASSWORD` + running dev server |
| `verify:phase5` | HTTP E2E (`mjs`) | **SKIPPED** | same |
| `verify:rankings` | service-level | PASS | 29/29 |
| `verify:orders` | service-level | PASS | 41/41 |
| `verify:payments` | service-level (simulated Stripe) | PASS | 11/11 |
| `verify:wholesale` | service-level (simulated Stripe + eShipper) | PASS | 16/16 |
| `verify:packaging` | unit + service-level | PASS | 8/8 |
| `verify:plaid` | service-level (simulated Plaid, test key) | PASS | 11/11 |
| `verify:e2e` | service-level acceptance | PASS | 52/52 |

`=== 7/9 scripts passed (0 failed, 2 skipped) ===` — **168/168 executed checks passed**. The DB returned to its pre-run baseline after every script (7 products, 14 variants, 0 variant packages, 0 sellers, 0 orders, 0 webhook events), confirming self-cleanup.

### 3.3 Phase 11 E2E scenario (`scripts/verify-e2e.ts`) — 52/52

Runs against the real SQLite dev DB through the service layer and deletes everything it creates in a `finally` block (even on failure). It creates an isolated shop `e2e-<ts>.myshopify.com` (deliberately **not** `*.test.myshopify.com` so the rankings query includes it) and asserts:

- **(a) Application approval** — creates an `OwnerUser` + `MerchantApplication`, calls `approveApplication` (`app/services/application.server.ts`); asserts application `APPROVED` with reviewer/timestamp, seller `APPROVED` linked to the application, and an `application.approved` audit row.
- **(b) Product/variant/packaging** — `createProduct` + `addVariant` (`products.server.ts`) and `saveVariantPackages` (`packaging.server.ts`); asserts persistence, complete packaging, and `product.created` / `product.variant_added` audit rows.
- **(c) Order webhook intake** — calls `intakeOrder` (`orderIntake.server.ts`) directly with a realistic Shopify-shaped payload; asserts exactly one MoonVella `OrderItem`, computed `moonvellaSubtotal=2598`, `moonvellaShipping=1361`, `moonvellaTax=1274`, `moonvellaDiscounts=980`, `moonvellaTotal=4253`, a `FulfillmentRequest` (`PENDING`), a `WholesalePayment` (`REQUIRES_PAYMENT`), `order.intaken` audit, and a `SUCCESS` `WebhookEvent`.
- **(d) Fulfillment request transitions** — `acceptFulfillmentRequest` then `closeFulfillmentRequest`; asserts `ACCEPTED`/`CLOSED` with timestamps and audit rows.
- **(e) Packing/fulfillment** — `createPackingShipment`, `markShipmentPacked`, `addOrderPackage`, then (after payment) `addManualShipment` + `advanceShipment(..., "delivered")`; asserts `Shipment`/`ShipmentItem`/`OrderPackage` rows, `packedAt`, tracking, `DELIVERED` shipment and order status, and the packing/shipment audit rows.
- **(f) Simulated payment** — `getBillingSettings`, `savePaymentMethodFromSetupIntent`, `createOrReuseWholesalePayment`, `chargeWholesaleOrder` (`PROCESSING` + `PaymentAttempt`) then `applyStripeEvent("payment_intent.succeeded")`; asserts `WholesalePayment` → `SUCCEEDED` with `paidAt`, order `wholesalePaymentStatus` → `SUCCEEDED`, and audit rows.
- **(g) Rankings** — `computeRankings` (`rankings.server.ts`) returns the created seller with `retailSales=9800`, `wholesaleRevenue=2598`, `paidOrders=1`, `unitsSold=2`.
- **(h) Audit + integration state** — asserts audit rows for all key mutations and `IntegrationState` `shopify_orders=HEALTHY`, `stripe=HEALTHY`, `shopify_fulfillment=NOT_CONFIGURED`.

### 3.4 Live HTTP smoke test (owner admin)

A dev server was started (`shopify app dev`, app port 58384) and the owner admin was exercised over HTTP with a real session cookie (login `302`, then authenticated GETs):

- All owner pages returned **200**: `/admin`, `/admin/applications`, `/admin/applications/:id`, `/admin/sellers`, `/admin/rankings`, `/admin/products`, `/admin/products/:id`, `/admin/orders`, `/admin/orders/:id`, `/admin/packing/:orderId`, `/admin/shipping`, `/admin/settings`, `/admin/audit`.
- Missing records are handled: `/admin/sellers/:unknown`, `/admin/orders/:unknown`, `/admin/packing/:unknown` return **404** (no 500).
- CSV exports return `text/csv` + `Content-Disposition: attachment`: `/admin/rankings/csv` and `/admin/audit/csv`.
- Order detail and packing pages were rendered against seeded temporary seller/product/order data (all rows removed afterwards; DB restored to 7 products / 0 sellers / 0 orders).

Embedded merchant pages (`/app/*`) were not browser-tested (they require the Shopify embedded session).

## 4. Verified vs simulated vs NOT executed

**Verified locally (service-level, real SQLite + owner-admin HTTP):** owner/seller/application lifecycle; product, variant, image ordering and packaging CRUD; order intake create/update/cancel + refund reconciliation; fulfillment-request state machine; packing shipments, order packages, manual shipments and lifecycle timestamps; rankings aggregation/search/sort/pagination/CSV; audit trail; integration-state transitions; Plaid token encryption (AES-256-GCM, no fallback to the Plaid secret); Stripe webhook signature verification.

**Simulated only (no live provider call):**
- **Stripe** — `STRIPE_SECRET_KEY` absent → `createOrReuseWholesalePayment`/`chargeWholesaleOrder`/`applyStripeEvent` operate on clearly-labelled local records. The E2E's "succeeded" event is a simulated `PaymentEvent`, not a real charge. The real `createStripeIntent` path (`payments.server.ts`) and `stripeForm`/`stripeGet` (`sellerBilling.server.ts`) were **not executed**.
- **eShipper** — no credentials → `getRates`/`bookShipment` return simulated rates/labels (`eshipper.server.ts`). No real quote or label purchase.
- **Plaid** — no credentials → `createLinkToken`/`exchangePublicToken` are simulated (`plaid.server.ts`). No Plaid API call.
- **Analytics** — `getShopAnalytics` (`analytics.server.ts`) requires the Shopify Admin API/ShopifyQL; not executed.

**Provider-sandbox/live — NOT executed:**
- Shopify product import (`shopifyImport.server.ts`) — no Admin API call.
- Shopify fulfillment propagation (`shopifyFulfillment.server.ts`, `syncShipmentTracking`) — the E2E leaves `shopifyFulfillmentOrderId` unset, so sync short-circuits to `NOT_CONFIGURED`; no `fulfillmentCreate` call.
- Real order webhook delivery / HMAC verification — `intakeOrder` was called directly; the HTTP webhook route was not exercised. The app-specific `orders/*` subscriptions in `shopify.app.toml` are **commented out**: Shopify rejects subscriptions containing protected customer data until the app is approved, and an unapproved subscription aborts `shopify app dev`. Uncomment the documented block after approval; the intake logic is complete.
- `verify:phase1` and `verify:phase5` (HTTP/UI flows) were skipped — they need `OWNER_EMAIL`/`OWNER_PASSWORD` and a running app server, which was out of scope.

**Not verified:** embedded merchant (`/app/*`) rendering, form submissions beyond the owner-admin GET smoke test, navigation, or App Bridge behaviour.

## 5. Known limitations

- SQLite + single-process assumptions: owner login throttling is in-memory (`ownerAuth.server.ts`); no multi-instance story.
- `verify:phase1`/`verify:phase5` are server-dependent and are skipped in a bare checkout; `verify:all` reports them as `SKIP` (not failure).
- `verify:plaid` needs `APP_ENCRYPTION_KEY`; the runner injects a throwaway test key when the environment does not persist one. It still proves that a missing key fails closed.
- Provider modes are selected purely by credential presence; no live integration test exists for any provider.
- The E2E asserts `shopify_fulfillment = NOT_CONFIGURED`, i.e. it verifies the *local* fallback, not Shopify propagation.

## 6. Schema-change suggestions (surfaced, not applied)

1. **`ProductImage` has no `isMain`** — the main image is encoded as `sortOrder = 0` (`products.server.ts` `reorderImages`/`setMainImage`). An explicit `isMain Boolean @default(false)` would make "main image" unambiguous and query-able.
2. **`FulfillmentRequest` has no `cancelledAt`** — cancellation reuses `closedAt` (`fulfillmentRequest.server.ts` `cancelFulfillmentRequest`). A distinct `cancelledAt` (+ `cancelReason`) would separate "closed after fulfillment" from "cancelled".
3. **No `DISPUTED` value in `WholesalePaymentStatus`** — `charge.dispute.created` records the payment as `FAILED` and writes a `PaymentAttempt` with `status = "DISPUTED"` (`payments.server.ts`). A first-class `DISPUTED` status would avoid overloading `FAILED`.
4. **`OrderPackage` has no `shipmentId`** — packages are order-scoped only (`schema.prisma` `OrderPackage`, `fulfillment.server.ts` `addOrderPackage`), so a parcel cannot be tied to a specific `Shipment`. An optional `shipmentId` FK would support per-parcel packing/tracking.
5. **`PaymentAttempt.status` is an untyped `String`** — values such as `PROCESSING`/`DISPUTED`/`REQUIRES_ACTION` are string literals; an enum would make states explicit.

## 7. Fixes applied after the acceptance run

1. **Simulated payment intent id now persisted (fixed).** `createOrReuseWholesalePayment` (`payments.server.ts`) simulated branch used `upsert({ update: {} })`, so the `sim_<orderId>` intent id was dropped when `orderIntake.server.ts` had already created the row. The `update` now sets `providerPaymentIntentId`/`clientSecret` (preserving an in-flight status). Confirmed by the E2E run, which resolves the simulated `payment_intent.succeeded` event to `sim_<orderId>` → `SUCCEEDED`.
2. **Audit CSV export returned 500 (fixed).** `admin.audit.tsx` returned a raw CSV `Response` from a route that also renders a component, so the component read undefined loader data. The export was extracted to the resource route `app/routes/admin.audit.csv.tsx` (`/admin/audit/csv`), mirroring `admin.rankings.csv.tsx`; the audit page now links there. Verified over HTTP (`text/csv`, 200).
3. **Order webhooks gated on Shopify approval.** `orders/create|updated|cancelled` subscriptions in `shopify.app.toml` are commented out with an explanatory note; enabling them before protected-customer-data approval aborts `shopify app dev`.

## 8. Remaining observations (reported, not changed)

1. **`addManualShipment` stamps `packedAt` immediately.** It creates a shipment already `SHIPPED` with `labelCreatedAt`/`packedAt`/`handedToCarrierAt`/`shippedAt` all set at once (`fulfillment.server.ts`), so "manual" shipments skip the distinct packing → carrier lifecycle. This is by design but means the E2E cannot distinguish those transitions for manual shipments; the packing shipment path (`createPackingShipment`/`markShipmentPacked`) covers `packedAt`.

No schema or migration was modified.
