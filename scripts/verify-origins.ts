/**
 * Phase A verification: origin mappings, packaging, address validation and
 * image selection.
 *
 * WHAT THIS SUITE IS ALLOWED TO TOUCH. It runs only against a database whose
 * name ends in `_verify` (the runner refuses anything else) and it builds every
 * fixture it needs, tearing each one down in a `finally`. Nothing here reaches
 * a provider: the Google calls are made against a stubbed `fetch` that replaces
 * the global one, and no eShipper, Shopify or Odoo call is made at all. The
 * stub refuses any host that is not Google's address-validation API, so a check
 * that accidentally tried to reach a real provider would fail here loudly
 * instead of succeeding against an account.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. Every check below exercises the code
 * the routes call, so a PASS is evidence about the application. It is NOT
 * evidence that Google works, that a carrier accepts these packages, or that a
 * seller's store will take these images — none of those were contacted. That
 * distinction is stated here because a passing suite otherwise reads as an
 * end-to-end claim.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import {
  REQUIRED_ORIGIN_FIELDS,
  allocateSellerShippingCharge,
  groupOrderLinesByOrigin,
  missingOriginFields,
  resolveOriginForVariant,
  snapshotOrigin,
  stockAtOrigin,
  type OriginLocation,
} from "../app/services/origins.server";
import {
  PackageValidationError,
  ROUND_TRIP_EPSILON,
  buildQuotePackagesForOrder,
  fromCm,
  fromKg,
  resolvePackagesForVariant,
  roundTripPreserved,
  saveProductPackages,
  saveVariantPackages,
  toCm,
  toKg,
  validatePackageRow,
} from "../app/services/packaging.server";
import {
  addressGate,
  addressInputHash,
  browserKeyForPlaces,
  missingAddressFields,
  normalizeAddressPart,
  recordAddressOverride,
  recordValidation,
  validateAddress,
  verdictFromGoogle,
  verdictLabel,
  type StructuredAddress,
} from "../app/services/addressValidation.server";
import {
  listSelectableImages,
  recordImageOutcomes,
  resolveImagesForImport,
  saveImageSelection,
} from "../app/services/importMediaSelection.server";
import { saveCredentials } from "../app/services/credentials.server";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const prisma = new PrismaClient();
const suffix = Date.now().toString(36).toUpperCase();
const created = {
  productIds: [] as string[],
  variantIds: [] as string[],
  locationIds: [] as string[],
  sellerIds: [] as string[],
};

const BROWSER_KEY = `browser-key-${suffix}`;
const SERVER_KEY = `server-key-${suffix}`;

/* -------------------------------------------------------------------------- */
/* Google transport stub                                                      */
/* -------------------------------------------------------------------------- */

interface GoogleComponent {
  componentType: string;
  componentName: { text: string };
  confirmationLevel?: string;
  inferred?: boolean;
  replaced?: boolean;
  spellCorrected?: boolean;
}

/** The part of Google's response this application reads. Every field is optional. */
interface GoogleBody {
  result: {
    verdict: Record<string, unknown>;
    address: {
      formattedAddress: string;
      addressComponents: GoogleComponent[];
      missingComponentTypes: string[];
    };
    geocode: { placeId: string };
  };
}

const realFetch = globalThis.fetch;
let googleCalls: string[] = [];
let googleResponder: (url: string) => { status: number; body: unknown } | "throw" = () => ({
  status: 200,
  body: {},
});

function installGoogleStub() {
  googleCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input.url ?? "");
    if (!url.startsWith("https://addressvalidation.googleapis.com/")) {
      throw new Error(`verify-origins: refused a non-Google outbound call to ${url}`);
    }
    googleCalls.push(url);
    const outcome = googleResponder(url);
    if (outcome === "throw") throw new Error("simulated network failure");
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

/** A complete, accepted Google answer for one address. */
function googleAccepted(address: {
  street1: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  subpremise?: string;
}): GoogleBody {
  const components: GoogleComponent[] = [
    {
      componentType: "street_number",
      componentName: { text: address.street1.split(" ")[0] },
      confirmationLevel: "CONFIRMED",
    },
    {
      componentType: "route",
      componentName: { text: address.street1.split(" ").slice(1).join(" ") },
      confirmationLevel: "CONFIRMED",
    },
    { componentType: "locality", componentName: { text: address.city }, confirmationLevel: "CONFIRMED" },
    {
      componentType: "administrative_area_level_1",
      componentName: { text: address.province },
      confirmationLevel: "CONFIRMED",
    },
    {
      componentType: "postal_code",
      componentName: { text: address.postalCode },
      confirmationLevel: "CONFIRMED",
    },
    { componentType: "country", componentName: { text: address.country }, confirmationLevel: "CONFIRMED" },
  ];
  if (address.subpremise) {
    components.push({
      componentType: "subpremise",
      componentName: { text: address.subpremise },
      confirmationLevel: "CONFIRMED",
    });
  }
  return {
    result: {
      verdict: {
        validationGranularity: "PREMISE",
        geocodeGranularity: "PREMISE",
        addressComplete: true,
        hasUnconfirmedComponents: false,
        hasInferredComponents: false,
        hasReplacedComponents: false,
        possibleNextAction: "ACCEPT",
      },
      address: {
        formattedAddress: `${address.street1}, ${address.city}, ${address.province} ${address.postalCode}, ${address.country}`,
        addressComponents: components,
        missingComponentTypes: [],
      },
      geocode: { placeId: "ChIJverify0000000000000000" },
    },
  };
}

/** Wrap a body as a 200 response for the stub. */
function respond(body: GoogleBody) {
  return { status: 200, body };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function locationData(
  overrides: Partial<Prisma.PickupLocationUncheckedCreateInput> = {}
): Prisma.PickupLocationUncheckedCreateInput {
  return {
    code: `VFA-${suffix}-${created.locationIds.length}`,
    name: "Verify Dock",
    odooDatabase: "verify_db",
    odooCompanyId: 1,
    odooWarehouseId: 1,
    odooLocationId: 25,
    odooPartnerId: 145,
    contactName: "Dock Receiver",
    contactPhone: "+1 555 0100",
    contactEmail: "dock@example.test",
    street1: "12 Main St",
    city: "Toronto",
    province: "ON",
    postalCode: "M5H 2N2",
    country: "CA",
    timeZone: "America/Toronto",
    pickupOpenTime: "09:00",
    pickupCloseTime: "16:00",
    ...overrides,
  };
}

async function createLocation(overrides: Partial<Prisma.PickupLocationUncheckedCreateInput> = {}) {
  const location = await prisma.pickupLocation.create({ data: locationData(overrides) });
  created.locationIds.push(location.id);
  return location;
}

/**
 * A product and its variants, with or without a choice for the seller to make.
 *
 * `selectable` is the difference between the two packaging shapes, and the
 * option row it writes is the whole of that difference: an ACTIVE variant
 * carrying a non-blank option pair is what `productHasSelectableVariants`
 * reads, and what decides whether the cartons belong to the variants or to the
 * product. Defaults to false because most of this suite's fixtures are about
 * origins, where nothing packaging-shaped is being asserted.
 */
async function createProductWithVariants(names: string[], selectable = false) {
  const product = await prisma.product.create({
    data: {
      name: `Verify Origin ${suffix}`,
      productCode: `VFA-P-${suffix}-${created.productIds.length}`,
      category: "Verification",
    },
  });
  created.productIds.push(product.id);

  const variants = [];
  for (const [index, name] of names.entries()) {
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `VFA-${suffix}-${created.productIds.length}-${index}`,
        name,
        wholesalePrice: 1200,
        suggestedRetailPrice: 2900,
        inventory: 10,
        isDefault: index === 0,
        sortOrder: index,
        variantOptions: selectable
          ? { create: [{ name: "Size", value: name, sortOrder: 0 }] }
          : undefined,
      },
    });
    created.variantIds.push(variant.id);
    variants.push(variant);
  }
  return { product, variants };
}

async function createSeller(label: string) {
  const shopDomain = `verify-origins-${label}-${suffix.toLowerCase()}.myshopify.com`;
  const seller = await prisma.seller.create({
    data: {
      shopDomain,
      shopDomainFull: `https://${shopDomain}`,
      storeName: `Verify Origins ${label}`,
      contactEmail: `verify-${label}-${suffix.toLowerCase()}@example.test`,
      status: "APPROVED",
      accessVersion: 1,
    },
  });
  created.sellerIds.push(seller.id);
  return seller;
}

async function cleanup() {
  try {
    if (created.sellerIds.length) {
      await prisma.importMediaSelection.deleteMany({ where: { sellerId: { in: created.sellerIds } } });
      await prisma.seller.deleteMany({ where: { id: { in: created.sellerIds } } });
    }
    if (created.locationIds.length) {
      await prisma.addressValidation.deleteMany({ where: { subjectId: { in: created.locationIds } } });
    }
    if (created.variantIds.length) {
      await prisma.variantPackage.deleteMany({ where: { variantId: { in: created.variantIds } } });
    }
    if (created.productIds.length) {
      await prisma.productPackage.deleteMany({ where: { productId: { in: created.productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    }
    if (created.locationIds.length) {
      await prisma.pickupLocation.deleteMany({ where: { id: { in: created.locationIds } } });
    }
  } catch (error) {
    console.error("cleanup failed:", error);
  }
}

/* -------------------------------------------------------------------------- */
/* §1 origins                                                                 */
/* -------------------------------------------------------------------------- */

async function originChecks() {
  console.log("\n--- origins: resolution, grouping and snapshots ---");

  const dockA = await createLocation({ code: `VFA-${suffix}-A`, name: "Dock A" });
  const dockB = await createLocation({
    code: `VFA-${suffix}-B`,
    name: "Dock B",
    street1: "400 Industrial Rd",
    city: "Mississauga",
    postalCode: "L5T 1A1",
    odooLocationId: 26,
  });

  const { product, variants } = await createProductWithVariants(["Standard", "King"]);

  // Resolution walks variant -> product -> the DESIGNATED DEFAULT dock, so what
  // an unmapped variant answers depends on whether any location currently
  // carries isDefault. A live database has one: the Odoo sync keeps a pickup
  // location in step with the Premafirm Inc. warehouse, and that dock answers
  // here before the "missing" branch can. Asserting only the missing branch
  // would therefore pass on an empty database and fail everywhere else, which
  // reads as a defect in the application when it is a defect in the check.
  //
  // So BOTH branches are pinned, by controlling isDefault instead of assuming
  // it: with no dock designated the variant must resolve to nothing and name
  // the missing pickup location; with one designated it must resolve to that
  // dock and say the source is "default". Whatever was designated before is put
  // back, so no later check sees a changed default.
  const ambientDefaults = (
    await prisma.pickupLocation.findMany({ where: { isDefault: true }, select: { id: true } })
  ).map((row) => row.id);
  let noDefault: Awaited<ReturnType<typeof resolveOriginForVariant>> | undefined;
  let designated: Awaited<ReturnType<typeof resolveOriginForVariant>> | undefined;
  try {
    await prisma.pickupLocation.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    noDefault = await resolveOriginForVariant(variants[0].id);

    await prisma.pickupLocation.update({ where: { id: dockA.id }, data: { isDefault: true } });
    designated = await resolveOriginForVariant(variants[0].id);
  } finally {
    await prisma.pickupLocation.update({ where: { id: dockA.id }, data: { isDefault: false } });
    if (ambientDefaults.length) {
      await prisma.pickupLocation.updateMany({
        where: { id: { in: ambientDefaults } },
        data: { isDefault: true },
      });
    }
  }
  check(
    "1  unmapped: NO location when no default dock is designated, the designated dock when one is",
    noDefault?.location === null &&
      noDefault?.ready === false &&
      noDefault?.source === "missing" &&
      (noDefault?.reason ?? "").includes("Pickup location required") &&
      designated?.location?.id === dockA.id &&
      designated?.source === "default" &&
      designated?.ready === true,
    `no default: source=${noDefault?.source} ready=${noDefault?.ready} reason=${noDefault?.reason ?? "-"} | designated: source=${designated?.source} ready=${designated?.ready} id=${designated?.location?.id ?? "-"}`
  );

  await prisma.product.update({ where: { id: product.id }, data: { pickupLocationId: dockA.id } });
  const inherited = await resolveOriginForVariant(variants[0].id);
  check(
    "2  a variant with no override inherits the product's default, and the source says so",
    inherited.location?.id === dockA.id && inherited.source === "product" && inherited.ready === true,
    `source=${inherited.source}`
  );

  await prisma.productVariant.update({ where: { id: variants[1].id }, data: { pickupLocationId: dockB.id } });
  const overridden = await resolveOriginForVariant(variants[1].id);
  check(
    "3  a variant override wins over the product default",
    overridden.location?.id === dockB.id && overridden.source === "variant",
    `source=${overridden.source}`
  );

  const incomplete = await createLocation({
    code: `VFA-${suffix}-INC`,
    name: "Dock Incomplete",
    postalCode: null,
  });
  await prisma.productVariant.update({ where: { id: variants[1].id }, data: { pickupLocationId: incomplete.id } });
  const incompleteResult = await resolveOriginForVariant(variants[1].id);
  check(
    "4  a mapped but incomplete location is unusable, lists what is missing, and is NOT swapped for a complete one",
    incompleteResult.ready === false &&
      incompleteResult.location?.id === incomplete.id &&
      incompleteResult.missing.includes("postal code") &&
      incompleteResult.location?.id !== dockA.id,
    `missing=${JSON.stringify(incompleteResult.missing)}`
  );
  await prisma.productVariant.update({ where: { id: variants[1].id }, data: { pickupLocationId: dockB.id } });

  const labels = REQUIRED_ORIGIN_FIELDS.map((entry) => entry.label);
  check(
    "5  every field the work order requires is actually required",
    [
      "location name",
      "Odoo company id",
      "Odoo warehouse id",
      "Odoo location id",
      "Odoo address record id",
      "contact name",
      "contact phone",
      "contact email",
      "street",
      "city",
      "province/state",
      "postal code",
      "country",
      "time zone",
      "pickup opening time",
      "pickup closing time",
    ].every((label) => labels.includes(label)),
    `${labels.length} required fields`
  );
  check(
    "6  a pickup window that closes before it opens is rejected",
    missingOriginFields({
      ...(dockA as unknown as OriginLocation),
      pickupOpenTime: "16:00",
      pickupCloseTime: "09:00",
    }).some((entry) => entry.includes("pickup window"))
  );

  const grouping = await groupOrderLinesByOrigin([
    { orderItemId: "line-a", variantId: variants[0].id, sku: "A", quantity: 3 },
    { orderItemId: "line-b", variantId: variants[1].id, sku: "B", quantity: 2 },
    { orderItemId: "line-c", variantId: "does-not-exist", sku: "C", quantity: 1 },
  ]);
  check(
    "7  an order whose items come from two docks splits into two ready groups plus one blocked group",
    grouping.split === true && grouping.groups.length === 3 && grouping.blockers.length === 1,
    `groups=${grouping.groups.length} blockers=${grouping.blockers.length}`
  );

  const allocated = grouping.groups.flatMap((group) => group.lines);
  check(
    "8  every order line is allocated exactly once, in full, to exactly one group",
    allocated.length === 3 &&
      new Set(allocated.map((line) => line.orderItemId)).size === 3 &&
      allocated.find((line) => line.orderItemId === "line-a")?.quantity === 3,
    JSON.stringify(allocated.map((line) => [line.orderItemId, line.quantity]))
  );
  check(
    "9  a line with no origin does NOT ride along with a mapped dock",
    grouping.groups.every((group) =>
      group.lines.some((line) => line.orderItemId === "line-c") ? group.locationId === null : true
    )
  );

  const shares = allocateSellerShippingCharge(1000, [
    { key: "a", billedWeightKg: 3 },
    { key: "b", billedWeightKg: 1 },
    { key: "c", billedWeightKg: 1 },
  ]);
  check(
    "10 splitting an order never adds a charge: weighted shares sum to the original exactly",
    shares.allocations.reduce((sum, entry) => sum + entry.amount, 0) === 1000 &&
      shares.basis === "weight" &&
      shares.allocations.find((entry) => entry.key === "a")?.amount === 600,
    JSON.stringify(shares)
  );
  const evenShares = allocateSellerShippingCharge(1000, [{ key: "a" }, { key: "b" }, { key: "c" }]);
  check(
    "11 with no weights the split is even, and still sums exactly (largest-remainder, not per-part rounding)",
    evenShares.basis === "equal" &&
      evenShares.allocations.reduce((sum, entry) => sum + entry.amount, 0) === 1000,
    JSON.stringify(evenShares.allocations.map((entry) => entry.amount))
  );

  const snapshot = snapshotOrigin(dockA as unknown as OriginLocation);
  await prisma.pickupLocation.update({
    where: { id: dockA.id },
    data: { postalCode: "M5H 9Z9", street1: "99 Elsewhere Ave" },
  });
  const reread = await prisma.pickupLocation.findUnique({ where: { id: dockA.id } });
  check(
    "12 a shipment's origin snapshot does not change when the live location is edited",
    snapshot.address.postalCode === "M5H 2N2" &&
      snapshot.address.street1 === "12 Main St" &&
      reread?.postalCode === "M5H 9Z9",
    `snapshot=${snapshot.address.postalCode} live=${reread?.postalCode}`
  );
  await prisma.pickupLocation.update({
    where: { id: dockA.id },
    data: { postalCode: "M5H 2N2", street1: "12 Main St" },
  });

  // A switched-off dock must stop shipping. Prisma cannot filter a to-one
  // relation, so this can only be enforced after the row is read — which means
  // selecting `isActive` and then forgetting to look at it is a live failure
  // mode, and is why it is checked rather than assumed.
  await prisma.pickupLocation.update({ where: { id: dockA.id }, data: { isActive: false } });
  const switchedOff = await resolveOriginForVariant(variants[0].id);
  const offStock = await stockAtOrigin(variants[0].id);
  check(
    "12b a location that has been switched off is refused by name, and no stock is read from it",
    switchedOff.location === null &&
      switchedOff.ready === false &&
      (switchedOff.reason ?? "").includes("switched off") &&
      offStock.locationId === null &&
      offStock.available === null &&
      offStock.reason !== null,
    `ready=${switchedOff.ready} reason=${switchedOff.reason}`
  );
  await prisma.pickupLocation.update({ where: { id: dockA.id }, data: { isActive: true } });
}

/* -------------------------------------------------------------------------- */
/* §3 packaging                                                               */
/* -------------------------------------------------------------------------- */

async function packagingChecks() {
  console.log("\n--- packaging: conversions, inheritance, validation ---");

  check(
    "13 inch/cm round trips exactly, in both directions",
    roundTripPreserved(24, "in", "length") &&
      Math.abs(fromCm(toCm(24, "in"), "in") - 24) <= ROUND_TRIP_EPSILON &&
      roundTripPreserved(0.5, "in", "length"),
    `24in -> ${toCm(24, "in")}cm -> ${fromCm(toCm(24, "in"), "in")}in`
  );
  check(
    "14 lb/kg round trips exactly, in both directions",
    roundTripPreserved(2, "lb", "weight") &&
      Math.abs(fromKg(toKg(2, "lb"), "lb") - 2) <= ROUND_TRIP_EPSILON &&
      roundTripPreserved(0.25, "lb", "weight"),
    `2lb -> ${toKg(2, "lb")}kg -> ${fromKg(toKg(2, "lb"), "lb")}lb`
  );
  check(
    "15 ten round trips do not drift",
    (() => {
      let value = 24;
      for (let i = 0; i < 10; i++) value = fromCm(toCm(value, "in"), "in");
      return Math.abs(value - 24) <= ROUND_TRIP_EPSILON;
    })()
  );
  check(
    "16 a value already in the canonical unit is not converted at all",
    toCm(40, "cm") === 40 && toKg(2.5, "kg") === 2.5
  );

  const zero = validatePackageRow({ length: 0, width: 10, height: 10, grossWeight: 1 }, 0);
  check(
    "17 a zero dimension is rejected rather than stored",
    zero.length === 1 && zero[0].includes("greater than zero"),
    JSON.stringify(zero)
  );
  check(
    "18 a negative weight, a negative width and a missing height are each rejected and all three are reported",
    validatePackageRow({ length: 10, width: -1, height: "", grossWeight: -2 }, 0).length === 3,
    JSON.stringify(validatePackageRow({ length: 10, width: -1, height: "", grossWeight: -2 }, 0))
  );

  /*
   * WHICH PRODUCT THESE RUN ON IS NOW PART OF THE CHECK.
   *
   * One packaging editor per sellable configuration (see
   * `productHasSelectableVariants`) means the two shapes answer differently, so
   * pinning only one of them would pin half the rule. The pair below carries
   * options, so its cartons live on the variants; the pair at the end carries
   * none, so its cartons live on the product and a variant-level write is
   * refused. Before this change both were the same product shape and the
   * resolver's fallback was the whole story.
   */
  const { product, variants } = await createProductWithVariants(["Inherits", "Overrides"], true);

  const noneYet = await resolvePackagesForVariant(variants[0].id);
  check(
    "19 a variant with no packaging of its own and no product default reports none",
    noneYet.source === "none" && noneYet.packages.length === 0,
    `source=${noneYet.source}`
  );

  /*
   * A PRODUCT SOLD IN CHOICES IS NOT SAVED FROM THE PRODUCT ANY MORE.
   *
   * This used to write a product default and assert that a variant without rows
   * inherited it. That fallback is exactly what the one-editor rule removes: for
   * a product whose sellers pick between variants, a product-level row is a
   * second answer that only some variants read, and it is invisible on the page
   * that edits the cartons. So the write is refused, and the refusal is what is
   * asserted — the message has to name where the cartons actually go, because
   * "not permitted" on its own leaves the operator nowhere to go.
   */
  let productWriteRefused: PackageValidationError | null = null;
  try {
    await saveProductPackages(product.id, [
      {
        label: "Product default carton",
        length: "24",
        width: "16",
        height: "6",
        dimensionUnit: "in",
        grossWeight: "2",
        weightUnit: "lb",
        unitsPerPackage: "1",
        packagesPerUnit: "1",
        shipsSeparately: "false",
        consolidatable: "true",
        declaredValue: "150.00",
      },
    ]);
  } catch (error) {
    if (error instanceof PackageValidationError) productWriteRefused = error;
    else throw error;
  }
  const afterRefusedProductWrite = await resolvePackagesForVariant(variants[0].id);
  check(
    "20 a product-level carton is refused for a product sold in choices, nothing is written, and the message names the Variants tab",
    productWriteRefused !== null &&
      afterRefusedProductWrite.source === "none" &&
      afterRefusedProductWrite.productDefault === null &&
      productWriteRefused.details.some((problem) => problem.message.includes("Variants tab")),
    `refused=${productWriteRefused !== null}, source=${afterRefusedProductWrite.source}`
  );

  await saveVariantPackages(variants[0].id, [
    {
      label: "Inherits carton",
      length: "24",
      width: "16",
      height: "6",
      dimensionUnit: "in",
      grossWeight: "2",
      weightUnit: "lb",
      unitsPerPackage: "1",
      packagesPerUnit: "1",
      shipsSeparately: "false",
      consolidatable: "true",
      declaredValue: "150.00",
    },
  ]);
  const chosen = await resolvePackagesForVariant(variants[0].id);
  check(
    "21 a variant of a product sold in choices reads its own cartons, and there is no product default behind them",
    chosen.source === "variant" &&
      chosen.packages.length === 1 &&
      chosen.packages[0].length === 24 &&
      chosen.packages[0].dimensionUnit === "in" &&
      chosen.productDefault === null,
    `source=${chosen.source}, productDefault=${chosen.productDefault === null ? "null" : "present"}`
  );
  check(
    "22 a declared value is stored in minor units, not as a float",
    chosen.packages[0].declaredValue === 15000,
    String(chosen.packages[0].declaredValue)
  );

  await saveVariantPackages(variants[1].id, [
    {
      label: "Variant override",
      length: "12",
      width: "12",
      height: "12",
      dimensionUnit: "in",
      grossWeight: "1.5",
      weightUnit: "lb",
      unitsPerPackage: "2",
      packagesPerUnit: "1",
      shipsSeparately: "true",
      consolidatable: "false",
    },
  ]);
  const overridden = await resolvePackagesForVariant(variants[1].id);
  check(
    "23 each variant reads its own cartons and nobody else's — the two do not see one another",
    overridden.source === "variant" &&
      overridden.packages[0].length === 12 &&
      chosen.packages[0].length === 24,
    `source=${overridden.source}, ${overridden.packages[0].length} vs ${chosen.packages[0].length}`
  );
  check(
    "24 ships-separately and consolidatable are carried through as booleans",
    overridden.packages[0].shipsSeparately === true && overridden.packages[0].consolidatable === false
  );

  let threw = false;
  let problems: string[] = [];
  try {
    await saveVariantPackages(variants[0].id, [
      {
        label: "Good",
        length: "10",
        width: "10",
        height: "10",
        dimensionUnit: "in",
        grossWeight: "1",
        weightUnit: "lb",
      },
      { label: "Bad", length: "10", width: "10", height: "", dimensionUnit: "in", grossWeight: "1", weightUnit: "lb" },
    ]);
  } catch (error) {
    threw = error instanceof PackageValidationError;
    problems = error instanceof PackageValidationError ? error.problems : [];
  }
  const afterRefusal = await resolvePackagesForVariant(variants[0].id);
  check(
    "25 an incomplete row is refused as a set, and nothing is written — not even the good row beside it",
    threw &&
      problems.length === 1 &&
      afterRefusal.source === "variant" &&
      afterRefusal.packages.length === 1 &&
      afterRefusal.packages[0].length === 24,
    `threw=${threw} problems=${JSON.stringify(problems)} sourceAfter=${afterRefusal.source} rows=${afterRefusal.packages.length}`
  );

  const quote = await buildQuotePackagesForOrder({
    items: [{ sku: "INHERITS", quantity: 3, variantId: variants[0].id }],
    packages: [],
  });
  check(
    "26 a quote built from a variant's carton converts once, rounds once, and reports where it came from",
    quote.source === "variant" &&
      quote.packages.length === 1 &&
      quote.packages[0].length === 60.96 &&
      quote.packages[0].weight === 0.907 &&
      quote.packages[0].count === 3,
    JSON.stringify(quote.packages[0])
  );

  const twoPackages = await buildQuotePackagesForOrder({
    items: [
      { sku: "INHERITS", quantity: 1, variantId: variants[0].id },
      { sku: "OVERRIDES", quantity: 1, variantId: variants[1].id },
    ],
    packages: [],
  });
  check(
    "27 two packages stay two packages: dimensions are never added together",
    twoPackages.packages.length === 2 && twoPackages.missing.length === 0,
    JSON.stringify(twoPackages.packages.map((entry) => entry.length))
  );

  /*
   * THE OTHER HALF OF THE RULE. A product whose variants carry no options is
   * sold as one thing however many rows sit underneath it, so its carton lives
   * on the product and the variants read it. The mirror of check 20 is that a
   * variant-level write is refused here, for the same reason and with the same
   * kind of message — otherwise the two editors exist again, one of them on a
   * page that no longer draws it.
   */
  const simple = await createProductWithVariants(["Only"], false);

  await saveProductPackages(simple.product.id, [
    {
      label: "The one carton",
      length: "40",
      width: "30",
      height: "20",
      dimensionUnit: "cm",
      grossWeight: "2.5",
      weightUnit: "kg",
      unitsPerPackage: "1",
      packagesPerUnit: "1",
      shipsSeparately: "false",
      consolidatable: "true",
    },
  ]);
  const simpleResolved = await resolvePackagesForVariant(simple.variants[0].id);
  check(
    "27a a product with no selectable configuration keeps its carton on the product, and its variant reads it",
    simpleResolved.source === "product" &&
      simpleResolved.packages.length === 1 &&
      simpleResolved.packages[0].length === 40 &&
      simpleResolved.productDefault?.length === 1,
    `source=${simpleResolved.source} rows=${simpleResolved.packages.length}`
  );

  let simpleRefused: PackageValidationError | null = null;
  try {
    await saveVariantPackages(simple.variants[0].id, [
      {
        label: "Variant carton",
        length: "10",
        width: "10",
        height: "10",
        dimensionUnit: "cm",
        grossWeight: "1",
        weightUnit: "kg",
      },
    ]);
  } catch (error) {
    if (error instanceof PackageValidationError) simpleRefused = error;
    else throw error;
  }
  const stillProduct = await resolvePackagesForVariant(simple.variants[0].id);
  check(
    "27b a variant-level carton is refused for a product with no selectable configuration, and the message names the Shipping tab",
    simpleRefused !== null &&
      stillProduct.source === "product" &&
      stillProduct.packages[0].length === 40 &&
      simpleRefused.details.some((problem) => problem.message.includes("Shipping tab")),
    `refused=${simpleRefused !== null}, source=${stillProduct.source}`
  );
}

/* -------------------------------------------------------------------------- */
/* §2 address validation                                                      */
/* -------------------------------------------------------------------------- */

const GOOD_ADDRESS: StructuredAddress = {
  street1: "12 Main St",
  street2: "Unit 4",
  city: "Toronto",
  province: "ON",
  postalCode: "M5H 2N2",
  country: "CA",
};

async function addressChecks() {
  console.log("\n--- address validation: outcomes, cache, gate and override ---");

  const dock = await createLocation({ code: `VFA-${suffix}-ADDR`, name: "Dock Addressed", street2: "Unit 4" });

  check(
    "28 an address missing required parts is not sent anywhere",
    missingAddressFields({ ...GOOD_ADDRESS, city: "" }).includes("city")
  );
  check(
    "29 normalisation folds case and spacing but keeps the unit separate",
    normalizeAddressPart("  12   MAIN st ") === "12 main st" &&
      addressInputHash({ ...GOOD_ADDRESS, street2: null }) !== addressInputHash(GOOD_ADDRESS),
    "street2 participates in the hash"
  );

  // A call is only attempted when the server key resolves, so the credential is
  // saved before the transport is stubbed. It is removed again in the `finally`,
  // and the integration row is restored to whatever it held before.
  const stateBefore = await prisma.integrationState.findUnique({ where: { key: "google" } });
  await saveCredentials("google", {
    GOOGLE_MAPS_BROWSER_KEY: BROWSER_KEY,
    GOOGLE_MAPS_SERVER_KEY: SERVER_KEY,
  });

  installGoogleStub();
  try {
    // --- outage ----------------------------------------------------------
    googleResponder = () => "throw";
    const outage = await validateAddress(GOOD_ADDRESS, { refresh: true });
    await recordValidation({ subjectType: "PICKUP", subjectId: dock.id, outcome: outage });
    const outageGate = await addressGate("PICKUP", dock.id);
    check(
      "30 a Google outage is UNAVAILABLE, never ACCEPTED, and the booking gate stays shut",
      outage.verdict === "UNAVAILABLE" &&
        outageGate.allowed === false &&
        outageGate.googleValidated === false &&
        outageGate.verdict !== "ACCEPTED",
      `verdict=${outage.verdict} allowed=${outageGate.allowed} label=${outageGate.label}`
    );

    // --- incomplete ------------------------------------------------------
    const callsBeforeIncomplete = googleCalls.length;
    const incomplete = await validateAddress({ ...GOOD_ADDRESS, street1: "" });
    check(
      "31 an incomplete address is reported without calling Google at all",
      incomplete.verdict === "CONFIRMATION_REQUIRED" && googleCalls.length === callsBeforeIncomplete,
      `newCalls=${googleCalls.length - callsBeforeIncomplete}`
    );

    // --- accepted --------------------------------------------------------
    googleResponder = () => respond(googleAccepted({ ...GOOD_ADDRESS, subpremise: "Unit 4" }));
    const accepted = await validateAddress(GOOD_ADDRESS, { refresh: true });
    await recordValidation({ subjectType: "PICKUP", subjectId: dock.id, outcome: accepted });
    const acceptedGate = await addressGate("PICKUP", dock.id);
    check(
      "32 a premise-level Google answer is ACCEPTED, and only then is the gate open",
      accepted.verdict === "ACCEPTED" &&
        acceptedGate.allowed === true &&
        acceptedGate.googleValidated === true &&
        acceptedGate.label === verdictLabel("ACCEPTED"),
      `verdict=${accepted.verdict} label=${acceptedGate.label}`
    );
    check(
      "33 the suggestion keeps the unit out of the street line",
      accepted.suggested?.street2 === "Unit 4" && accepted.suggested?.street1 === "12 Main St",
      JSON.stringify(accepted.suggested)
    );

    // --- cache -----------------------------------------------------------
    const callsBeforeCache = googleCalls.length;
    const cached = await validateAddress(GOOD_ADDRESS);
    check(
      "34 an unchanged address reuses its stored verdict and makes no second billable call",
      cached.cached === true && googleCalls.length === callsBeforeCache,
      `newCalls=${googleCalls.length - callsBeforeCache}`
    );

    // --- material edit invalidates ---------------------------------------
    await prisma.pickupLocation.update({ where: { id: dock.id }, data: { postalCode: "M5H 9Z9" } });
    const editedGate = await addressGate("PICKUP", dock.id);
    check(
      "35 editing the address invalidates the stored verdict and shuts the gate again",
      editedGate.allowed === false && editedGate.blockers.join(" ").includes("changed since"),
      `allowed=${editedGate.allowed}`
    );
    await prisma.pickupLocation.update({ where: { id: dock.id }, data: { postalCode: "M5H 2N2" } });

    // --- correction required ---------------------------------------------
    googleResponder = () => {
      const body = googleAccepted({ ...GOOD_ADDRESS, subpremise: "Unit 4" });
      body.result.verdict.hasReplacedComponents = true;
      body.result.verdict.possibleNextAction = "FIX";
      body.result.address.addressComponents[3].componentName.text = "Ontario";
      return respond(body);
    };
    const corrected = await validateAddress({ ...GOOD_ADDRESS, postalCode: "M5H 3N3" }, { refresh: true });
    check(
      "36 a replaced component is CORRECTION_REQUIRED, with the change listed side by side",
      corrected.verdict === "CORRECTION_REQUIRED" &&
        corrected.differences.some((entry) => entry.component === "province" && entry.entered === "ON"),
      JSON.stringify(corrected.differences)
    );

    // --- confirmation required: a missing unit ---------------------------
    googleResponder = () => {
      const body = googleAccepted({
        street1: "12 Main St",
        city: "Toronto",
        province: "ON",
        postalCode: "M5H 4N4",
        country: "CA",
      });
      body.result.verdict.possibleNextAction = "CONFIRM_ADD_SUBPREMISES";
      return respond(body);
    };
    const noUnit = await validateAddress(
      { ...GOOD_ADDRESS, street2: null, postalCode: "M5H 4N4" },
      { refresh: true }
    );
    check(
      "37 an address Google can place but not to a unit asks for the unit rather than passing",
      noUnit.verdict === "CONFIRMATION_REQUIRED" && (noUnit.reason ?? "").toLowerCase().includes("unit"),
      `verdict=${noUnit.verdict}`
    );

    // --- confirmation required: a unit Google does not trust ---------------
    googleResponder = () => {
      const body = googleAccepted({ ...GOOD_ADDRESS, subpremise: "Unit 999" });
      body.result.verdict.hasUnconfirmedComponents = true;
      body.result.verdict.addressComplete = false;
      body.result.address.addressComponents[6].confirmationLevel = "UNCONFIRMED_AND_SUSPICIOUS";
      return respond(body);
    };
    const badUnit = await validateAddress(
      { ...GOOD_ADDRESS, street2: "Unit 999", postalCode: "M5H 6N6" },
      { refresh: true }
    );
    check(
      "38 an apartment component Google could not confirm is CONFIRMATION_REQUIRED, and the unit is named in the differences",
      badUnit.verdict === "CONFIRMATION_REQUIRED" &&
        badUnit.differences.some((entry) => entry.component === "street2"),
      JSON.stringify(badUnit.differences)
    );

    // --- HTTP failure ----------------------------------------------------
    googleResponder = () => ({ status: 500, body: { error: "boom" } });
    const failed = await validateAddress({ ...GOOD_ADDRESS, postalCode: "M5H 5N5" }, { refresh: true });
    check(
      "39 an HTTP failure is UNAVAILABLE, and the reason quotes the status rather than the response body",
      failed.verdict === "UNAVAILABLE" &&
        (failed.reason ?? "").includes("HTTP 500") &&
        !(failed.reason ?? "").includes(SERVER_KEY),
      failed.reason ?? ""
    );

    check(
      "40 the verdict mapping cannot produce ACCEPTED from an empty or route-level answer",
      verdictFromGoogle(undefined).verdict === "UNAVAILABLE" &&
        verdictFromGoogle({ verdict: { validationGranularity: "ROUTE", addressComplete: true } }).verdict ===
          "CONFIRMATION_REQUIRED"
    );

    // --- which key went where --------------------------------------------
    const callsWithServerKey = googleCalls.filter((url) => url.includes(encodeURIComponent(SERVER_KEY)));
    const callsWithBrowserKey = googleCalls.filter((url) => url.includes(encodeURIComponent(BROWSER_KEY)));
    check(
      "41 the address calls carried the server key, and the browser key was never sent to Google",
      callsWithServerKey.length > 0 && callsWithBrowserKey.length === 0,
      `${callsWithServerKey.length} calls with the server key, ${callsWithBrowserKey.length} with the browser key`
    );

    const browserFacing = await browserKeyForPlaces();
    check(
      "42 the function a page loader calls returns the browser key and never the server key",
      browserFacing === BROWSER_KEY && !String(browserFacing).includes(SERVER_KEY),
      `returned=${browserFacing === BROWSER_KEY ? "the browser key" : String(browserFacing).slice(0, 12)}`
    );
  } finally {
    restoreFetch();
    await prisma.integrationCredential.deleteMany({ where: { key: "google" } });
    if (stateBefore) {
      await prisma.integrationState.update({
        where: { key: "google" },
        data: { disconnectedAt: stateBefore.disconnectedAt },
      });
    } else {
      await prisma.integrationState.deleteMany({ where: { key: "google" } });
    }
  }

  // --- owner override -----------------------------------------------------
  const owner = await prisma.adminUser.create({
    data: {
      email: `verify-owner-${suffix.toLowerCase()}@example.test`,
      name: "Verify Owner",
      role: "OWNER",
      isActive: true,
    },
  });
  const viewer = await prisma.adminUser.create({
    data: {
      email: `verify-viewer-${suffix.toLowerCase()}@example.test`,
      name: "Verify Viewer",
      role: "VIEWER",
      isActive: true,
    },
  });

  try {
    const dock2 = await createLocation({ code: `VFA-${suffix}-OVR`, name: "Dock Override" });

    let viewerRefused = false;
    try {
      await recordAddressOverride({
        subjectType: "PICKUP",
        subjectId: dock2.id,
        actorId: viewer.id,
        reason: "The viewer would like this address to be accepted please.",
      });
    } catch (error) {
      viewerRefused = error instanceof Error && error.name === "AddressOverrideNotPermitted";
    }
    check("43 a non-owner cannot override a failed address", viewerRefused);

    const shortReason = await recordAddressOverride({
      subjectType: "PICKUP",
      subjectId: dock2.id,
      actorId: owner.id,
      reason: "ok",
    });
    check("44 an override with no real reason is refused", shortReason.ok === false, JSON.stringify(shortReason));

    const before = await addressGate("PICKUP", dock2.id);
    const override = await recordAddressOverride({
      subjectType: "PICKUP",
      subjectId: dock2.id,
      actorId: owner.id,
      reason: `Confirmed with the dock by phone on ${new Date().toISOString().slice(0, 10)}; Google has not indexed this address yet.`,
    });
    const after = await addressGate("PICKUP", dock2.id);
    check(
      "45 an owner override opens the gate, but is labelled as an override and never as Google validated",
      before.allowed === false &&
        override.ok === true &&
        after.allowed === true &&
        after.googleValidated === false &&
        after.verdict === "OVERRIDDEN" &&
        after.label === verdictLabel("OVERRIDDEN") &&
        after.label !== verdictLabel("ACCEPTED") &&
        !after.label.startsWith("Accepted by Google"),
      `label=${after.label}`
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: "address.override_recorded", actorId: owner.id },
      orderBy: { createdAt: "desc" },
    });
    check(
      "46 the override is recorded in the audit trail with its reason",
      audit !== null && JSON.stringify(audit?.afterData ?? {}).includes("Confirmed with the dock by phone"),
      audit ? `audit ${audit.id}` : "no audit row"
    );
  } finally {
    // The audit rows are NOT removed, and cannot be: the database carries a
    // trigger that refuses DELETE on AuditLog, which this suite discovered by
    // trying. That is the right behaviour for an evidence table, so the entries
    // this run wrote are left in the clone as the record they are. Only the
    // fixture accounts go, and they are identified by a per-run address so a
    // later run's rows cannot be mistaken for this one's.
    await prisma.adminUser.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
  }
}

/* -------------------------------------------------------------------------- */
/* §4 image selection                                                         */
/* -------------------------------------------------------------------------- */

async function imageSelectionChecks() {
  console.log("\n--- image selection: eligibility, persistence, retry ---");

  const { product, variants } = await createProductWithVariants(["Imaged"]);
  const sellerA = await createSeller("A");
  const sellerB = await createSeller("B");

  const approved = await prisma.mediaAsset.create({
    data: {
      productId: product.id,
      category: "WHITE_BACKGROUND_IMAGE",
      title: "Approved and visible",
      originalFilename: "a.png",
      storageKey: `verify-origins-${suffix}-a`,
      mimeType: "image/png",
      fileSize: 1024,
      checksum: `checksum-a-${suffix}`,
      sourceUrl: "https://example.test/a.png",
      processingStatus: "READY",
      approvalStatus: "APPROVED",
      sellerVisible: true,
    },
  });
  await prisma.mediaAsset.create({
    data: {
      productId: product.id,
      category: "WHITE_BACKGROUND_IMAGE",
      title: "Approved but not seller-visible",
      originalFilename: "b.png",
      storageKey: `verify-origins-${suffix}-b`,
      mimeType: "image/png",
      fileSize: 1024,
      checksum: `checksum-b-${suffix}`,
      sourceUrl: "https://example.test/b.png",
      processingStatus: "READY",
      approvalStatus: "APPROVED",
      sellerVisible: false,
    },
  });
  await prisma.mediaAsset.create({
    data: {
      productId: product.id,
      category: "WHITE_BACKGROUND_IMAGE",
      title: "Draft",
      originalFilename: "c.png",
      storageKey: `verify-origins-${suffix}-c`,
      mimeType: "image/png",
      fileSize: 1024,
      checksum: `checksum-c-${suffix}`,
      sourceUrl: "https://example.test/c.png",
      processingStatus: "READY",
      approvalStatus: "DRAFT",
      sellerVisible: true,
    },
  });
  await prisma.mediaAssetAssignment.create({
    data: { assetId: approved.id, variantId: variants[0].id, sortOrder: 0, isPrimary: true },
  });

  const initial = await listSelectableImages(sellerA.id, product.id);
  check(
    "47 only approved, seller-visible images are offered",
    initial.images.length === 1 && initial.images[0].mediaAssetId === approved.id,
    `offered=${initial.images.map((image) => image.title).join(", ")}`
  );
  check(
    "48 with nothing saved, every eligible image is selected and the view says it is a default",
    initial.defaulted === true && initial.images[0].selected === true
  );
  check(
    "49 the variant association and the primary flag are retained on the offered image",
    initial.images[0].variantIds.includes(variants[0].id) &&
      initial.images[0].primaryForVariantIds.includes(variants[0].id)
  );

  await saveImageSelection({
    sellerId: sellerA.id,
    productId: product.id,
    selectedMediaAssetIds: [],
    mainMediaAssetId: null,
  });
  const excluded = await listSelectableImages(sellerA.id, product.id);
  check(
    "50 an excluded image stays excluded on a later read — it is not silently reselected",
    excluded.defaulted === false && excluded.images[0].selected === false && excluded.excludedCount === 1
  );

  await saveImageSelection({
    sellerId: sellerA.id,
    productId: product.id,
    selectedMediaAssetIds: [approved.id],
    mainMediaAssetId: approved.id,
  });
  const chosen = await resolveImagesForImport(sellerA.id, product.id);
  check(
    "51 the saved selection is what the import sends, with the chosen main image first",
    chosen.images.length === 1 &&
      chosen.images[0].isMain === true &&
      chosen.images[0].alreadyUploadedAs === null &&
      chosen.defaulted === false
  );

  await recordImageOutcomes(sellerA.id, product.id, [
    {
      mediaAssetId: approved.id,
      ok: false,
      error: `The store rejected the upload (HTTP 422): {"access_token":"shpss_abc123def456ghi789","message":"invalid image"}`,
    },
  ]);
  const afterFailure = await listSelectableImages(sellerA.id, product.id);
  check(
    "52 a partial failure is recorded against the image, with the reason and an attempt count",
    afterFailure.failures.length === 1 &&
      afterFailure.failures[0].attempts === 1 &&
      (afterFailure.failures[0].error ?? "").includes("422"),
    JSON.stringify(afterFailure.failures)
  );
  check(
    "53 a credential-shaped value quoted back by the provider is redacted before it is stored",
    !(afterFailure.failures[0].error ?? "").includes("shpss_abc123def456ghi789") &&
      (afterFailure.failures[0].error ?? "").includes("[redacted]"),
    afterFailure.failures[0].error ?? ""
  );

  const retryable = await resolveImagesForImport(sellerA.id, product.id);
  check(
    "54 an image that failed is still sent on the next attempt",
    retryable.images.length === 1 && retryable.images[0].alreadyUploadedAs === null
  );

  await recordImageOutcomes(sellerA.id, product.id, [
    { mediaAssetId: approved.id, ok: true, providerMediaId: "gid://shopify/MediaImage/1" },
  ]);
  const afterSuccess = await resolveImagesForImport(sellerA.id, product.id);
  check(
    "55 an image already in the store is reported with the store's own id and is not sent again",
    afterSuccess.images.length === 1 &&
      afterSuccess.images[0].alreadyUploadedAs === "gid://shopify/MediaImage/1",
    String(afterSuccess.images[0].alreadyUploadedAs)
  );

  await saveImageSelection({
    sellerId: sellerA.id,
    productId: product.id,
    selectedMediaAssetIds: [approved.id],
    mainMediaAssetId: approved.id,
  });
  const afterResave = await listSelectableImages(sellerA.id, product.id);
  check(
    "56 re-saving the same selection does not reset a completed upload back to pending",
    afterResave.images[0].uploadStatus === "UPLOADED" &&
      afterResave.images[0].providerMediaId === "gid://shopify/MediaImage/1",
    `status=${afterResave.images[0].uploadStatus}`
  );

  const allAssets = await prisma.mediaAsset.findMany({ where: { productId: product.id }, select: { id: true } });
  const ineligible = allAssets
    .map((asset) => asset.id)
    .filter((id) => !afterResave.images.some((image) => image.mediaAssetId === id));
  const ignored = await saveImageSelection({
    sellerId: sellerA.id,
    productId: product.id,
    selectedMediaAssetIds: [approved.id, ...ineligible],
    mainMediaAssetId: null,
  });
  check(
    "57 an ineligible image id submitted by a stale form is dropped, not recorded",
    ignored.selected === 1 && ignored.ignored.length === 2 && ineligible.length === 2,
    JSON.stringify(ignored.ignored)
  );

  const otherSeller = await listSelectableImages(sellerB.id, product.id);
  check(
    "58 another seller sees their own defaults, not this seller's exclusions",
    otherSeller.defaulted === true && otherSeller.images.length === 1 && otherSeller.images[0].selected === true
  );

  await saveImageSelection({
    sellerId: sellerB.id,
    productId: product.id,
    selectedMediaAssetIds: [],
    mainMediaAssetId: null,
  });
  const sellerAStill = await listSelectableImages(sellerA.id, product.id);
  const sellerBAfter = await listSelectableImages(sellerB.id, product.id);
  check(
    "59 one seller excluding an image does not change another seller's selection",
    sellerAStill.images[0].selected === true && sellerBAfter.images[0].selected === false
  );
}

async function main() {
  await originChecks();
  await packagingChecks();
  await addressChecks();
  await imageSelectionChecks();

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  if (failures > 0) {
    console.log("Fixtures are cleaned up either way; see any cleanup output above.");
  }
  return failures;
}

main()
  .then(async (failed) => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup();
    await prisma.$disconnect();
    process.exit(1);
  });
