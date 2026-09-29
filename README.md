# MoonVella

A Shopify app for wholesale (B2B) commerce. Sellers apply for access, an owner
reviews the application, and approved sellers get a wholesale catalog, import
products into their own Shopify store, receive orders back through webhooks, and
pay for goods through the app. The owner side handles the catalog, packing,
shipping (eShipper), billing, and audit.

This is the only document in the repository. It describes how the app is set up
and how it is meant to work — and, in [Guards](#guards--do-not-do-this), the
things that must not be done to it.

---

## 1. What it is built on

| Concern        | Choice                                                              |
| -------------- | ------------------------------------------------------------------- |
| Runtime        | Node 22 (Alpine), React Router 7 in framework mode, TypeScript strict |
| Data           | Prisma + **PostgreSQL 16** (host-native, no DB container)            |
| UI             | Two surfaces: owner/admin (`/admin/*`) and merchant/seller (`/app/*`) |
| Hosting        | Docker container on the same host as Postgres, fronted by Nginx      |
| Public hosts   | `app.moonvella.com` (embedded), `admin.moonvella.com` (owner)        |

Business logic lives in `app/services/*.server.ts` and is called by route
loaders/actions and by webhooks. Routes stay thin.

### The two surfaces, and the two auth systems

They are independent and must not be conflated:

- **Owner/admin** — `app/services/ownerAuth.server.ts`, `app/utils/ownerAuth.server.ts`.
  Cookie `owner_session`, RBAC roles `OWNER` / `OPERATIONS` / `REVIEWER` / `READONLY`.
  Served on `admin.moonvella.com`, which is framed `DENY`.
- **Merchant/seller** — Shopify session auth (`app/shopify.server.ts`), embedded in
  the Shopify admin iframe on `app.moonvella.com`. That host deliberately has **no**
  `X-Frame-Options` and a CSP `frame-ancestors` limited to `*.myshopify.com` and
  `admin.shopify.com`, so the iframe renders.

Both hosts proxy to the **same** process on `127.0.0.1:3000`. The hostname, not the
port, decides which surface is being served.

### Integrations

Each lives in `app/services/` as a boundary module and runs in a clearly-labelled
**simulated mode when its credentials are absent** — that is how the test suites
exercise them without touching a live provider.

| Service file                  | Provider                        |
| ----------------------------- | ------------------------------- |
| `payments.server.ts`, `sellerBilling.server.ts` | Stripe        |
| `eshipper.server.ts`          | eShipper (rates, labels)        |
| `shopifyImport.server.ts`     | Shopify Admin (product import)  |
| `shopifyFulfillment.server.ts`| Shopify Admin (fulfillment sync)|
| `odoo.server.ts` and friends  | Odoo (ERP)                      |
| `plaid.server.ts`             | Plaid — **retired**, see below  |

`plaid.server.ts` and the `PLAID_*` env keys still exist, but Plaid was retired
(along with VoPay) in favour of Stripe. Do not build on it.

Cross-cutting: `audit.server.ts` (audit trail), `integrationHealth.server.ts`
(per-provider state), `storage.server.ts` (image persistence).

---

## 2. How the app runs

The container is defined in **`/opt/moonvella/docker-compose.yml`** (outside this
repo, alongside the other operational tooling).

| Property         | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| Image            | `${MOONVELLA_IMAGE:-moonvella:local}`                         |
| Container name   | `moonvella-app`                                               |
| Network          | **host** — there is no `ports:` mapping, and none is wanted    |
| Bind             | `HOST=127.0.0.1`, `PORT=3000`                                 |
| Env file         | `/etc/moonvella/moonvella.env` (mode `0600`)                  |
| Uploads          | `/var/lib/moonvella/uploads` → `/app/uploads`                 |
| User             | `10001:10001`, unprivileged                                   |
| Restart          | `unless-stopped`                                              |
| Hardening        | `read_only` rootfs, `--cap-drop ALL`, `no-new-privileges`, private IPC |
| Healthcheck      | `wget -qO- http://127.0.0.1:3000/health`, 30s interval        |

### Two properties are load-bearing, not stylistic

**Host networking is required.** This host has an nftables `inet filter` table
whose `forward` chain is `policy drop` with no rules, and whose `input` chain
accepts only a fixed port allowlist. The consequence, verified empirically:
bridge networking has **no egress at all** — no DNS, no `1.1.1.1:443`, not even
the Docker gateway. Host networking is the only configuration that works. Because
of it, there is no `ports:` mapping; the app binds loopback exclusively, so it is
reachable from Nginx on this host and from nowhere else.

**The loopback bind is the only thing keeping the app off the public interface.**
There is no firewall rule behind it doing that job. The monitor script treats a
publicly-bound port as a hard failure (it exits 2) precisely so a regression here
surfaces loudly rather than silently.

### The image's own CMD is part of the update mechanism

```sh
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node server.js"]
```

Migrations run at **every container start**, and a non-zero migration exit means
the container never serves. This is why the deploy scripts that point at a
non-production database re-parse the final `DATABASE_URL` and refuse to run
unless it names the database they expect — the image will migrate whatever it is
pointed at.

---

## 3. Configuration

Runtime configuration is a single env file, `/etc/moonvella/moonvella.env`
(mode `0600 root:root`). **Only the key names are listed here; no values belong
in this repository** — it is public.

<details>
<summary>Key names</summary>

`ADMIN_ALLOWED_HOSTS`, `ADMIN_APP_URL`, `APP_ALLOWED_HOSTS`,
`APP_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEY_PREVIOUS`, `DATABASE_URL`,
`ESHIPPER_ACCOUNT_ID`, `ESHIPPER_BASE_URL`, `ESHIPPER_ENV`,
`ESHIPPER_PASSWORD`, `ESHIPPER_RATE_PATH`, `ESHIPPER_USERNAME`,
`MOONVELLA_SHIP_FROM_*` (address, city, country, name, postal, province),
`MV_JOB_RUNNER_SECRET`, `NODE_ENV`, `ODOO_ALLOW_PROD_DB`, `ODOO_API_KEY`,
`ODOO_DATABASE`, `ODOO_MODE`, `ODOO_URL`, `ODOO_USERNAME`, `OWNER_EMAIL`,
`OWNER_NAME`, `OWNER_PASSWORD_HASH`, `OWNER_ROLE`, `PLAID_*` (retired),
`PORT`, `SCOPES`, `SESSION_SECRET`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_APP_URL`, `SHOP_CUSTOM_DOMAIN`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `UPLOAD_DIR`, `VOPAY_*` (retired).

</details>

`HOST` is deliberately **absent** from that file: the compose file and
`mv-recreate.sh` both pin it to `127.0.0.1` explicitly, so it cannot drift.

Credentials entered through the admin UI are stored encrypted in the database
(AES-256-GCM, keyed by `APP_ENCRYPTION_KEY`), not in the env file.

---

## 4. How a release is deployed

There is **no single deploy script**. The sequence is deliberately explicit, and
every step has a reason.

```bash
# 0. Pin the outgoing image so there is something to roll back to.
docker tag moonvella:local moonvella:local-$(docker inspect \
  --format '{{.Id}}' moonvella:local | cut -c8-14)

# 1. Build. --network host is REQUIRED: the Docker daemon cannot resolve DNS
#    from a build container on this host.
docker build --network host -t moonvella:local /opt/moonvella/app

# 2. Recreate the container. Either:
MOONVELLA_IMAGE=moonvella:local \
  docker compose -f /opt/moonvella/docker-compose.yml up -d --force-recreate
# ...or:
bash /opt/moonvella/deployment/mv-recreate.sh [image-tag]
```

### `mv-recreate.sh` — the hardened path

`/opt/moonvella/deployment/mv-recreate.sh` recreates `moonvella-app` and is the
recommended way to do it by hand. It:

1. Refuses to run if the env file is unreadable.
2. **Inspects the image before stopping the container** — a bad tag fails closed
   without touching the live app.
3. Prints a banner naming the production database it is about to act on.
4. Stops and removes the old container.
5. Runs the new one with exactly the hardening described in §2.
6. Polls health for up to 120s; on failure it dumps the container log rather than
   leaving you guessing.

It does **not** build, tag a rollback image, take a backup, or migrate —
migrations come from the image CMD.

> **Watch the tag.** The running container is not compose-managed (`docker
> compose ps` is empty; it was created by `docker run`). `mv-recreate.sh` with no
> argument defaults to `moonvella:local`, and `docker compose up -d` defaults to
> `${MOONVELLA_IMAGE:-moonvella:local}`. Both will silently switch production to
> a *different build* than the one running if you do not pass the intended tag.

### Rolling back

Restore the previous image and leave the schema alone. Migrations in this repo
are written additively and defaulted, so the previous image runs unchanged
against a database that has the newer columns. **Dropping columns is not part of
a rollback** — the data in them is real operator input.

Because `docker image prune` deletes unused tags (see §6), the durable rollback
artifacts are the `docker save` tarballs in `/opt/moonvella/deployment/`
(`rollback-*.tar`, ~1.27 GB each):

```bash
docker load -i /opt/moonvella/deployment/rollback-<change>.tar
```

---

## 5. Database, backups, and the verify clone

### Production

PostgreSQL 16 on the host. Database `moonvella`, owner `moonvella`. The app
reaches it on `127.0.0.1:5432` via `DATABASE_URL`.

Migrations live in `prisma/migrations/` and are applied by the image CMD.

### Backups

`/opt/moonvella/backup-moonvella-db.sh`, driven by
`moonvella-backup.timer` (daily ~02:37, `RandomizedDelaySec=600`):

- `pg_dump --format=custom` into `/var/lib/moonvella/backups`, plus a tarball of
  `uploads/`, each with a `.sha256`.
- Verifies the dump with `pg_restore --list` before keeping it.
- `flock`-guarded, so overlapping ticks cannot run.
- Refuses any database whose name matches `prod-db|prod_db|prod*` — it will not
  dump the Odoo production database by accident.
- Retains **14 days**, then prunes dumps and uploads together.

Restore is manual:

```bash
pg_restore --clean --if-exists --no-owner \
  --host=127.0.0.1 --port=5432 --username=moonvella --dbname=moonvella \
  /var/lib/moonvella/backups/moonvella-<stamp>.dump
```

There is **no offsite copy**. If you need one, that is an open gap.

### The verify clone

Verification never runs against production. `verify-db.sh` builds
`moonvella_verify` as a physical copy of `moonvella` (safe while the app runs),
strips leftover test sellers **from the clone only**, and optionally seeds the
catalog.

The clone is restored from a dump of the live database, so it lags production by
up to one migration wave. `mv-verify.sh` compensates by running
`prisma migrate deploy` against the clone first.

> `moonvella_pa_test` also exists on the cluster, owned by `moonvella`, and is
> referenced by no script in the deployment tree. It is an unmanaged spare.

---

## 6. Scheduled work and monitoring

| Schedule                | Source                          | What it does                                  |
| ----------------------- | ------------------------------- | --------------------------------------------- |
| `2-59/5 * * * *`        | `/etc/cron.d/moonvella-jobs`    | `mv-jobs.sh` → `POST /jobs/run`               |
| `12 0 * * *`            | `/etc/cron.d/docker-image-prune`| `docker image prune -af --filter until=24h`   |
| Mon 02:20               | `/etc/cron.d/docker-builder-prune` | `docker builder prune -f`                  |
| Daily ~02:37            | `moonvella-backup.timer`        | Database + uploads backup                     |
| Every 5 min             | `moonvella-monitor.timer`       | Health, exposure, cert and disk checks        |

The app has **no scheduler of its own**. Deferred work (Odoo contact sync,
archiving a blocked store's catalogue) runs only when the five-minute tick calls
`POST /jobs/run`. The tick authenticates with `MV_JOB_RUNNER_SECRET`, which
`mv-jobs.sh` passes via a mode-600 `curl` config file so it never appears in
`argv`. The job queue is therefore as available as this cron entry — if `mv-jobs.sh`
stops running, deferred work silently stops with it.

The monitor restarts `moonvella-app` when it is down or unhealthy (budgeted at 3
restarts/hour), checks `https://app.moonvella.com/health` for
`"status":"ok"` and `"database":"ok"`, alerts on certificate expiry under 21 days
and disk over 90%, and — as noted in §2 — **fails the unit if the app is bound to
anything other than loopback**.

---

## 7. Building and verifying

All commands run **inside the image** (`moonvella:local`). The host has no
`node_modules`, and a host `npx` would fetch a different ESLint than the one the
project pins.

| Script               | Command                                        |
| -------------------- | ---------------------------------------------- |
| `npm run build`      | `react-router build`                           |
| `npm run typecheck`  | `react-router typegen && tsc --noEmit`         |
| `npm run lint`       | `eslint --ignore-path .gitignore --cache ...`  |
| `npm run db:deploy`  | `prisma migrate deploy`                        |
| `npm run verify:all` | the whole verification suite                   |

The scripts are `mv-typecheck.sh`, `mv-verify.sh` (offline suites) and
`mv-verify-http.sh` (HTTP suites) in `/opt/moonvella/deployment/`. They bind-mount
source directories over the image — never the repository root, which would shadow
the image's `node_modules` with the host's empty one.

The verify harness is `scripts/run-verify.mjs`. It bundles each TypeScript suite
with esbuild to a temporary `.mjs`, runs it, and propagates the exit code. `--all`
runs 36 suites, 22 of which declare credentials they need and are skipped without
them. Stripe mode is pinned by the harness (`MOONVELLA_STRIPE_MODE=simulated|test`)
so that a saved sandbox key cannot silently move a suite onto live calls.

Shell-level acceptance suites — `acceptance-tests.sh` and
`multiuser-acceptance-tests.sh` — run against the deployed hosts and are
read-only. They check the container's uid, dropped capabilities,
`no-new-privileges`, read-only rootfs, loopback-only bind, TLS versions, host-header
handling, and that `/health` is refused from the public internet.

### `.jsx` files are never typechecked

`tsconfig.json` includes `**/*.tsx`, so `.jsx` routes escape `tsc` entirely. Only
`npm run build` catches a dead import in one. Do not rely on typecheck alone
before a release.

### Test environment

`mv-test-up.sh` brings up a second container, `moonvella-test`, on
`127.0.0.1:3100` pointed at `moonvella_verify`, with the unresolvable hosts
`admin.mvtest.invalid` / `app.mvtest.invalid`. It re-derives the database name
from the final URL and **refuses to start unless it is exactly
`moonvella_verify`** — because the image CMD would migrate whatever it is given.
`mv-verify-http.sh` refuses to run at all if that container is not up, rather
than falling back to production.

---

## 8. Repository layout

```
app/
  routes/          admin.* (owner), app.* (seller), webhooks.*
  services/        business logic (*.server.ts)
  utils/           shared helpers
  db.server.ts     Prisma singleton
  shopify.server.ts
prisma/
  schema.prisma
  migrations/            PostgreSQL — the real baseline
  migrations-sqlite-legacy/   retired, see Guards
deployment/        settings-wip archive (in-repo)
scripts/           run-verify.mjs and the verify suites
server.js          entry point
```

The operational tooling — compose file, deploy scripts, backups, rollback
tarballs — lives in **`/opt/moonvella/`**, outside this repository.

---

## 9. Guards — do not do this

Four things in and around this repository are traps. Each is here because it has
already cost time or come close to costing a release.

### 9.1 Apply the two booking migrations before the code that reads them

This release adds two columns to `Shipment`, and **the application reads both on
every shipment page, every booking and every Shopify push**. Deploying the code
without applying them is not a partial failure — it is a hard failure on the
first shipment read, because Prisma names all mapped columns in the `SELECT`.

| Migration                                    | Column                 | Shape                            |
| -------------------------------------------- | ---------------------- | -------------------------------- |
| `20260928190000_booking_notification_intent` | `notifyCustomerOnPush` | `BOOLEAN NOT NULL DEFAULT false` |
| `20260928213000_packing_slip_message`        | `packingSlipMessage`   | `TEXT` (nullable)                |

Both are additive and defaulted: a shipment predating them has not been asked the
notification question and has no message, and `false`/`NULL` is the truth about
it rather than a placeholder.

The image CMD applies them on a normal restart. When the deploy is **not** a
normal restart — a hand-rolled restart, a rollback image, a restored dump —
apply them explicitly first:

```bash
# 1. Apply both. Idempotent: prisma skips what is already applied.
docker run --rm --network host -e DATABASE_URL="$DATABASE_URL" \
  moonvella:local ./node_modules/.bin/prisma migrate deploy

# 2. Verify BOTH columns exist, before the application is restarted.
#    The count is the check: 2 means proceed, anything else means stop.
psql "${DATABASE_URL%%\?*}" -Atc \
  "select count(*) from information_schema.columns
    where table_name = 'Shipment'
      and column_name in ('notifyCustomerOnPush','packingSlipMessage')"

# 3. Only then restart the application.
```

### 9.2 Return-label purchasing stays disabled

`bookReturn` purchases a return label through a save-then-create workflow that
has **never been exercised against eShipper's sandbox**. Purchasing is therefore
hard-disabled at the adapter (`RETURN_PURCHASING_ENABLED` in
`app/services/eshipper.server.ts`), and the gate is enforced at the purchase call
rather than only drawn on the page.

Quoting a return stays open — it is read-only and costs nothing.

**Do not re-enable it, and do not deploy a build with it enabled, until the
save-then-create return workflow has been run against the sandbox and its
response recorded.**

### 9.3 `admin.settings.tsx.wip` must never become a route

`deployment/settings-wip/admin.settings.tsx.wip` is an unfinished rewrite of
`app/routes/admin.settings.tsx`, archived as-is. The `.wip` extension is what
keeps it out of React Router's route glob and out of `tsc`.

**Do not rename it to `.tsx` under `app/routes/`, and do not deploy it.** It
fails `npm run typecheck` with 17 errors that are not cosmetic — functions called
but never imported (ReferenceError on credential save), a `.filter` on a
`FormDataIterator`, form fields that do not match the `secret_*` prefix the action
filters on, and a stub component that returns `null`. It is two half-drafts
spliced together.

The live route already implements all four intents correctly. Finishing the draft
means choosing between its two designs and rewriting the credential forms — not a
mechanical repair.

### 9.4 Never move the SQLite migrations into `prisma/migrations/`

`prisma/migrations-sqlite-legacy/` holds migrations generated against the original
SQLite datasource. They contain SQLite-specific syntax (`DATETIME`, `TEXT PRIMARY
KEY`, `AUTOINCREMENT`) and **cannot be applied to PostgreSQL**.

They are retained for historical reference only. The production baseline for
PostgreSQL is `prisma/migrations/`. Do not move them back.

### 9.5 And two operational traps

- **`docker image prune -af --filter "until=24h"` runs daily at 00:12.** The `-a`
  flag removes all unused images, and `until=24h` is an *age* filter, not a
  protection for tagged images. A rollback tag survives only while a container
  references it or while it is under 24 hours old. **A tag does not protect an
  image.** The `rollback-*.tar` files are the durable artifact.
- **`mv-verify.sh` warns and continues if `migrate deploy` fails against the
  clone.** A green run can therefore be against a stale schema. Read its output
  rather than trusting only the exit code.

---

## 10. Conventions

- Business logic goes in `app/services/*.server.ts`; routes load and act.
- Every mutation writes an audit row (`audit.server.ts`).
- Provider modules must keep working in simulated mode when credentials are
  absent — that is what makes the suites runnable without live keys.
- Never commit a secret. Configuration values live in
  `/etc/moonvella/moonvella.env` or the encrypted credential store, never here.
