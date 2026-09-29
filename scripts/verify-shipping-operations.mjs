import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = read("prisma/schema.prisma");
const service = read("app/services/shippingOperations.server.ts");
const transitions = read("app/services/shippingOperations.ts");
const shipment = read("app/routes/admin.shipping_.$shipmentId.tsx");
const pickups = read("app/routes/admin.pickups.tsx");
const returns = read("app/routes/admin.returns.tsx");
const claims = read("app/routes/admin.claims.tsx");
const navigation = read("app/components/ShippingOperationsNav.tsx");

const checks = [
  [schema.includes("model ReturnRequest {"), "return authorization is persisted separately from a shipment"],
  [schema.includes("model ShippingClaim {"), "carrier claim case file is persisted"],
  [schema.includes("returnShipmentId   String?"), "return authorization can later link to a separately purchased return label"],
  [service.includes('action: "return.requested"'), "return creation is audited"],
  [service.includes('action: "claim.created"'), "claim creation is audited"],
  [service.includes("if (input.status === \"SUBMITTED\" && !carrierClaimNumber)"), "a claim cannot look submitted without the carrier's id"],
  [!service.includes("bookReturnForOrder") && !service.includes("syncShipmentTracking"), "case-file writes do not buy labels or tell Shopify"],
  [transitions.includes('APPROVED: ["LABEL_PENDING", "IN_TRANSIT", "CANCELLED"]'), "approved return remains separate from label purchase"],
  [transitions.includes('READY_TO_SUBMIT: ["SUBMITTED", "CANCELLED"]'), "claim submission is an explicit operator transition"],
  [shipment.includes('name="intent" value="create_return_request"'), "shipment page can open an RMA"],
  [shipment.includes('name="intent" value="create_claim"'), "shipment page can open a claim draft"],
  [shipment.includes("A return request is an approval record") || shipment.includes("This record does not buy a label"), "return side effects are stated on screen"],
  [pickups.includes("Labels and pickups are separate"), "pickup queue states the label/pickup boundary"],
  [returns.includes("does not buy a label, refund, restock, or update Shopify"), "return queue states its boundaries"],
  [claims.includes("internal case files"), "claim queue does not pretend an internal record was submitted"],
  [["/admin/shipping", "/admin/pickups", "/admin/returns", "/admin/claims", "/admin/origins"].every((href) => navigation.includes(`href: "${href}"`)), "operations navigation exposes all five manual queues"],
];

for (const [condition, message] of checks) assert.equal(condition, true, message);
console.log(`shipping operations: ${checks.length}/${checks.length} checks passed`);
