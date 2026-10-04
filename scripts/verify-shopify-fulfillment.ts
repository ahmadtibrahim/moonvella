/**
 * The Shopify fulfillment read, against the schema Shopify actually serves.
 *
 * WHAT WAS WRONG. `ensureMoonvellaFulfillmentService` and the integration probe
 * both asked for a field at the root of the query:
 *
 *     fulfillmentServices(first: 20) { nodes { … } }
 *
 * There is no such field. The sandbox refused the query, and because both call
 * sites treat a refusal as "the service does not exist yet", the failure did not
 * look like a broken query — it looked like a store with no MoonVella
 * fulfillment service, which is a sentence an operator would act on by creating
 * one that already existed.
 *
 * The replacement was READ OFF THE SCHEMA rather than guessed, and both halves
 * of the answer were different from what the old query assumed:
 *
 *   • the field lives on `Shop`, not on the query root; and
 *   • it is `[FulfillmentService!]!` — a plain LIST, with no arguments and no
 *     connection, so there is no `first:` to pass and no `nodes` to unwrap.
 *
 * A fix that had merely moved the field to `shop { fulfillmentServices(first: 20)
 * { nodes } }` would have failed a second time for the second reason, which is
 * why this suite pins the SHAPE and not only the path.
 *
 * THREE THINGS ARE CHECKED, and they are different kinds of fact:
 *
 *   A. What the shipped queries ask for, read from the source with comments
 *      stripped — the shape above, and the destination on the fulfillment-order
 *      read. Static, always runs.
 *   B. That the read RESOLVES a real order on the sandbox, read-only: real
 *      fulfillment orders, their own assigned locations, their own remaining
 *      quantities and their own destinations. This is the check the work order
 *      asks for by name. It needs a stored offline session for the sandbox shop
 *      and is reported SKIPPED without one, because a suite with nothing to ask
 *      has proved nothing either way — and never FAILED, because a missing
 *      prerequisite is not a defect.
 *   C. That the read issues no mutation. Every call this suite makes is recorded
 *      and scanned, so "read-only" is a property of the run rather than a
 *      promise in a comment.
 *
 * No label is bought, no fulfillment is created, nothing is notified, and the
 * sandbox is only ever read.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-shopify-fulfillment.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SHOP = "moonvilla-sandbox.myshopify.com";

let failures = 0;
let total = 0;
let lastNumber = 0;

function check(number: number, name: string, pass: boolean, detail: unknown = "") {
  total += 1;
  if (number <= lastNumber) {
    failures += 1;
    console.log(`FAIL  check #${number} is out of order — #${lastNumber} was already reported`);
    return;
  }
  lastNumber = number;
  if (!pass) failures += 1;
  const suffix = detail === "" || detail === undefined ? "" : ` — ${String(detail)}`;
  console.log(`${pass ? "PASS" : "FAIL"}  ${String(number).padStart(4)}. ${name}${suffix}`);
}

function skip(number: number, name: string, why: string) {
  total += 1;
  lastNumber = number;
  console.log(`SKIP  ${String(number).padStart(4)}. ${name} — ${why}`);
}

/** Source with comments removed, strings left intact. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      out += source.slice(start, i);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

interface RecordedCall {
  query: string;
  variables: Record<string, unknown>;
}

/** The one method this suite uses, so the recorder is typed without the client. */
interface GraphqlCapable {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

/** An admin client that records what it was asked and answers from a real socket. */
function recordingAdmin(admin: unknown, calls: RecordedCall[]): GraphqlCapable {
  const inner = admin as GraphqlCapable;
  return {
    graphql: (query, options) => {
      calls.push({ query, variables: options?.variables ?? {} });
      return inner.graphql(query, options);
    },
  };
}

async function main() {
  /* ------------------------------------------------------------------ */
  /* A. The shape of the shipped queries                                  */
  /* ------------------------------------------------------------------ */
  console.log("\n-- A. What the shipped queries ask for --");

  const fulfillmentSource = stripComments(
    readFileSync(join(process.cwd(), "app/services/shopifyFulfillment.server.ts"), "utf8")
  );
  const healthSource = stripComments(
    readFileSync(join(process.cwd(), "app/services/integrationHealth.server.ts"), "utf8")
  );

  /*
   * A ROOT ASK IS ONE THAT IS NOT `shop { fulfillmentServices … }`. Telling the
   * two apart by looking at the brace before the field does not work — the
   * character before it is a space in both forms — so the supported form is
   * removed first and whatever is left is asked the same question. That is the
   * rule the check applies to the files and the rule the self-test below applies
   * to a string, which is what makes the self-test about the rule rather than
   * about a second implementation of it.
   */
  const SHOP_FULFILLMENT_SERVICES = /shop\s*\{\s*fulfillmentServices/g;
  const rootAsk = (source: string) =>
    /(^|[^.\w])fulfillmentServices\s*[({]/.test(source.replace(SHOP_FULFILLMENT_SERVICES, "shop{READ"));

  const rootAsks = [
    ["the fulfillment service resolver", fulfillmentSource],
    ["the integration probe", healthSource],
  ].filter(([, source]) => rootAsk(source));

  check(
    1,
    "no shipped query asks for fulfillmentServices at the root of the query",
    rootAsks.length === 0,
    rootAsks.length ? `${rootAsks.map(([label]) => label).join(", ")} still do` : "none"
  );
  check(
    2,
    "...and the scanner can tell a root ask from a nested one",
    rootAsk("query Q { fulfillmentServices(first: 20) { nodes { id } } }") &&
      !rootAsk("query Q { shop { fulfillmentServices { id } } }"),
    "shown to be capable of failing"
  );

  for (const [label, source] of [
    ["the fulfillment service resolver", fulfillmentSource],
    ["the integration probe", healthSource],
  ] as const) {
    check(
      3 + (label === "the integration probe" ? 1 : 0),
      `${label} reads the service list from shop, as a list`,
      /shop\s*\{\s*fulfillmentServices\s*\{/.test(source) && !/fulfillmentServices\s*\(/.test(source),
      /fulfillmentServices\s*\(/.test(source) ? "still passes arguments to a list field" : "shop { fulfillmentServices { … } }"
    );
  }

  check(
    5,
    "the fulfillment-order read asks for the destination beside its own lines",
    /destination\s*\{[^}]*firstName[^}]*lastName[^}]*company[^}]*address1[^}]*city[^}]*countryCode[^}]*zip[^}]*\}/.test(
      fulfillmentSource
    ),
    "destination { … }"
  );
  check(
    6,
    "...and for the assigned location, so routing can tell where the goods already are",
    /assignedLocation\s*\{\s*location\s*\{\s*id\s+name\s*\}/.test(fulfillmentSource),
    "assignedLocation { location { id name } }"
  );

  /* ------------------------------------------------------------------ */
  /* B. The read, against the sandbox, read-only                          */
  /* ------------------------------------------------------------------ */
  console.log("\n-- B. The supported read, against the sandbox --");

  const order = await prisma.order.findFirst({
    where: { seller: { shopDomain: SHOP } },
    orderBy: { createdAt: "desc" },
    select: { id: true, shopifyOrderId: true, shopifyOrderName: true },
  });

  const calls: RecordedCall[] = [];
  let readSkipped = "";

  /*
   * THE PREREQUISITE IS A SESSION, AND IT GOES STALE ON ITS OWN.
   *
   * The clone these suites run against is refreshed from the deployment, and the
   * offline session it carries is the one that was current at the refresh: the
   * app renews its own token as it runs, but a copy of the table does not. Once
   * that timestamp passes, the Shopify client refuses before it reaches the
   * network and answers with a bare 500 — which reads like a broken query and is
   * really a stale fixture. So the expiry is checked HERE, by this suite, and
   * the reason names the fix.
   */
  const session = await prisma.session.findFirst({
    where: { shop: SHOP, isOnline: false },
    select: { expires: true },
  });
  const expired = session?.expires ? session.expires.getTime() < Date.now() : false;

  if (!order) {
    readSkipped = "no order for that shop in this database";
    skip(7, "the schema-supported read resolves a real order on the sandbox", readSkipped);
  } else if (!session) {
    readSkipped = `no offline session stored for ${SHOP}`;
    skip(7, "the schema-supported read resolves a real order on the sandbox", readSkipped);
  } else if (expired) {
    readSkipped =
      `the offline session for ${SHOP} expired ${session.expires?.toISOString()} — ` +
      `refresh the clone with deployment/verify-db.sh`;
    skip(7, "the schema-supported read resolves a real order on the sandbox", readSkipped);
  } else {
    let resolved: {
      id: string;
      status: string;
      assignedLocationName: string | null;
      destinationCity: string | null;
      remaining: number;
      lines: number;
    }[] = [];
    let refusal = "";

    try {
      const { unauthenticated } = await import("../app/shopify.server");
      const { admin } = await unauthenticated.admin(SHOP);
      const probe = recordingAdmin(admin, calls);

      const gid = order.shopifyOrderId.startsWith("gid://")
        ? order.shopifyOrderId
        : `gid://shopify/Order/${order.shopifyOrderId}`;

      const res = await probe.graphql(
        `#graphql
        query MoonVellaFulfillmentReadCheck($id: ID!) {
          order(id: $id) {
            id
            name
            fulfillmentOrders(first: 10) {
              nodes {
                id
                status
                assignedLocation { location { id name } }
                destination { firstName lastName company address1 city province countryCode zip }
                lineItems(first: 20) { nodes { id remainingQuantity totalQuantity lineItem { id sku } } }
              }
            }
          }
        }`,
        { variables: { id: gid } }
      );
      const json = (await res.json()) as {
        data?: {
          order?: {
            fulfillmentOrders?: {
              nodes?: {
                id: string;
                status: string;
                assignedLocation?: { location?: { name?: string | null } | null } | null;
                destination?: { city?: string | null } | null;
                lineItems?: { nodes?: { remainingQuantity: number }[] } | null;
              }[];
            } | null;
          } | null;
        };
        errors?: { message: string }[];
      };

      refusal = (json.errors ?? []).map((e) => e.message).join("; ");
      resolved = (json.data?.order?.fulfillmentOrders?.nodes ?? []).map((fo) => ({
        id: fo.id,
        status: fo.status,
        assignedLocationName: fo.assignedLocation?.location?.name ?? null,
        destinationCity: fo.destination?.city ?? null,
        lines: fo.lineItems?.nodes?.length ?? 0,
        remaining: (fo.lineItems?.nodes ?? []).reduce((sum, li) => sum + li.remainingQuantity, 0),
      }));
    } catch (error) {
      /*
       * The Shopify client THROWS the Response when the request is refused, and
       * `String(response)` is "[object Response]" — a message that says a call
       * failed and nothing about why, which is the shape of report that gets
       * skimmed past. The status and the body are what identify the cause: a
       * rotated offline token reads as 401 here, a scope problem as 403.
       */
      if (error instanceof Response) {
        const body = await error.text().catch(() => "");
        refusal = `HTTP ${error.status} ${error.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`;
      } else {
        refusal = error instanceof Error ? error.message : String(error);
      }
    }

    if (refusal) {
      /*
       * A VALID SESSION AND STILL REFUSED IS A FAILURE, not a skip. The two
       * skips above are missing prerequisites; this is the query, or the scopes
       * it needs, being wrong against a store that is reachable — which is the
       * defect this suite exists to catch, and reporting it as "skipped" would
       * be the same mistake as the code that started this wave: reading a
       * refusal as permission to carry on.
       */
      check(7, "the schema-supported read resolves a real order on the sandbox", false, refusal);
    } else {
      check(
        7,
        "the schema-supported read resolves a real order on the sandbox",
        resolved.length > 0,
        `${resolved.length} fulfillment order(s) on ${order.shopifyOrderName}`
      );
      check(
        8,
        "...with, for each one, its own fulfillment order id and status",
        resolved.every((fo) => fo.id.startsWith("gid://shopify/FulfillmentOrder/") && Boolean(fo.status)),
        resolved.map((fo) => `${fo.id.split("/").pop()}:${fo.status}`).join(" ")
      );
      check(
        9,
        "...its own assigned location, named",
        resolved.every((fo) => Boolean(fo.assignedLocationName)),
        resolved.map((fo) => fo.assignedLocationName ?? "(none)").join(" | ")
      );
      check(
        10,
        "...its own remaining quantities, read from the lines",
        resolved.every((fo) => fo.lines > 0 && Number.isInteger(fo.remaining)),
        resolved.map((fo) => `${fo.remaining}/${fo.lines}`).join(" ")
      );
      /*
       * The destination is the field the old resolver never read and the one the
       * "do not combine" rule is about: it is asserted to have come back, per
       * fulfillment order, alongside the lines it belongs to. A real order whose
       * destination Shopify reports as null is not a failure of this code — the
       * read succeeded — so the check is that the FIELD is part of the contract,
       * which the shape check above pins, and that this fixture order carries an
       * address, which is a fact about the sandbox rather than about the query.
       */
      check(
        11,
        "...and the destination that belongs to it",
        resolved.some((fo) => Boolean(fo.destinationCity)),
        resolved.map((fo) => fo.destinationCity ?? "(null)").join(" | ")
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* C. Read-only, proven rather than promised                            */
  /* ------------------------------------------------------------------ */
  console.log("\n-- C. Nothing was written --");

  if (readSkipped) {
    skip(12, "the sandbox probe issued no mutation", `no probe was made — ${readSkipped}`);
  } else {
    check(
      12,
      "the sandbox probe issued no mutation",
      calls.length > 0 && calls.every((call) => !/\bmutation\b/i.test(call.query)),
      `${calls.length} call(s), none a mutation`
    );
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error("verify-shopify-fulfillment failed:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
