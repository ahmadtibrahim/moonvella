import { toCm, toKg, validateVariantPackaging, buildQuotePackagesForOrder } from "../app/services/packaging.server";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const VV = process.argv[2];

async function main() {
  check("imperial to metric length (10in -> 25.4cm)", Math.abs(toCm(10, "in") - 25.4) < 1e-9, String(toCm(10, "in")));
  check("metric length unchanged (40cm)", toCm(40, "cm") === 40);
  check("imperial to metric weight (1lb -> 0.45359237kg)", Math.abs(toKg(1, "lb") - 0.45359237) < 1e-9, String(toKg(1, "lb")));

  const v = await validateVariantPackaging(VV);
  check("variant packaging validates complete", v.complete === true && v.packageCount === 1, JSON.stringify(v.missing));

  const built = await buildQuotePackagesForOrder({
    items: [{ sku: "VERIFY", quantity: 2, variantId: VV }],
    packages: [],
  });
  check("quote packages derived from variant packaging", built.source === "variant" && built.packages.length === 1 && built.missing.length === 0, JSON.stringify(built.packages));
  check("quantity multiplies package count", built.packages[0]?.count === 2, String(built.packages[0]?.count));
  check("dimensions converted to cm", built.packages[0]?.length === 40 && built.packages[0]?.weight === 2.5, `${built.packages[0]?.length}/${built.packages[0]?.weight}`);

  const missing = await buildQuotePackagesForOrder({
    items: [{ sku: "NO-PACKAGING", quantity: 1, variantId: "does-not-exist" }],
    packages: [],
  });
  check("missing packaging is reported, not guessed", missing.packages.length === 0 && missing.missing.some((m) => m.includes("packaging incomplete")), JSON.stringify(missing.missing));

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
