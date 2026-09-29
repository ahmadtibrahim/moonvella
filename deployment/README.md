# Deploying this release

## The two migrations that must be applied first

This release adds two columns to `Shipment`, and **the application reads both on
every shipment page, every booking and every Shopify push**. Deploying the code
without applying them is not a partial failure — it is a hard failure on the
first shipment read, because Prisma names all mapped columns in the `SELECT`.

| Migration                                        | Column                  | Shape                     |
| ------------------------------------------------ | ----------------------- | ------------------------- |
| `20260928190000_booking_notification_intent`     | `notifyCustomerOnPush`  | `BOOLEAN NOT NULL DEFAULT false` |
| `20260928213000_packing_slip_message`            | `packingSlipMessage`    | `TEXT` (nullable)         |

Both are **additive and defaulted**, so they apply against a live database
without locking out reads and without invalidating a single existing row: a
shipment that predates them has not been asked the notification question and has
no message, and `false`/`NULL` is the truth about it rather than a placeholder.

### Order of operations

The image's `CMD` is `prisma migrate deploy && node server.js`, so a normal
container restart applies them before the application accepts a connection. When
that is **not** how the deploy is done — a hand-rolled restart, a rollback image,
a restored dump — apply them explicitly first:

```bash
# 1. Apply both migrations. Idempotent: prisma skips what is already applied.
docker run --rm --network host -e DATABASE_URL="$DATABASE_URL" \
  moonvella:local ./node_modules/.bin/prisma migrate deploy

# 2. Verify BOTH columns exist, before the application is restarted. The count
#    is the check: 2 means the release may proceed, anything else means stop.
psql "${DATABASE_URL%%\?*}" -Atc \
  "select count(*) from information_schema.columns
    where table_name = 'Shipment'
      and column_name in ('notifyCustomerOnPush','packingSlipMessage')"

# 3. Only then restart the application.
```

### Rolling back

Both columns are additive, so the previous image runs unchanged against a
database that has them: roll back by restoring the previous image and leaving
the columns in place. Dropping them is not part of a rollback — the data in them
would be the notification answers operators have already given.

## What must NOT be deployed from this branch

`bookReturn` purchases a return label through a save-then-create workflow that
has never been exercised against eShipper's sandbox. Purchasing is therefore
**hard-disabled** at the adapter (`RETURN_PURCHASING_ENABLED` in
`app/services/eshipper.server.ts`), and the gate is enforced at the purchase call
rather than only drawn on the page. Quoting a return stays open — it is read-only
and costs nothing.

Do not re-enable it, and do not deploy a build with it enabled, until the
save-then-create return workflow has been run against the sandbox and its
response recorded.
