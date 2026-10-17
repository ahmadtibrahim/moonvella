/**
 * Branding: validation, re-encoding, versioning and the fallback chain.
 *
 * WHAT THIS SUITE IS FOR. A logo is the one upload whose failure mode is a blank
 * space: nothing errors, the page renders, and the mark is simply not there — on
 * a customer's PDF, or on the sign-in page, or in the sidebar where a navy logo
 * has vanished into a navy bar. So the parts that have to be pinned are the ones
 * that decide what is STORED and what is SERVED:
 *
 *   1. WHAT IS REFUSED. SVG (a document that can carry script, served from the
 *      app's own origin), executables, a declared type that disagrees with the
 *      bytes, an oversized file, and a header that cannot be read.
 *   2. WHAT IS STORED. Not the upload — a re-encode. Metadata stripped, pixel
 *      dimensions bounded by scaling rather than by refusal, and PNG for a source
 *      that may carry transparency, because JPEG would flatten it to black.
 *   3. WHAT IS SERVED. A replaced logo is a NEW URL (the path carries the
 *      checksum of the bytes), exactly one version per slot is live, and an empty
 *      invoice slot serves the primary logo rather than nothing.
 *
 * The sanitizer is driven BOTH ways: with an injected runner, so the decisions
 * can be asserted exactly rather than on whatever the installed ffmpeg happens
 * to produce, and once end-to-end through the real ffmpeg, because a decision
 * suite that never runs the encoder proves nothing about the encoder.
 *
 * It creates brand rows and stored objects under a fixed actor name and removes
 * both. No provider is reached.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  BRAND_SLOTS,
  BRAND_SLOT_SPECS,
  brandAssetPath,
  brandImageFor,
  brandImageUrl,
  detectBrandSignature,
  effectiveSlot,
  getBrandView,
  readImageSize,
  replaceBrandSlot,
  resetBrandSlot,
  restoreBrandVersion,
  sanitizeImage,
  setDisplayName,
  type ImageRunner,
} from "../app/services/branding.server";
import { getStorage, saveUpload } from "../app/services/storage.server";
import { forbidProviderCalls } from "./provider-guard";

const prisma = new PrismaClient();
const ACTOR = { id: "verify-branding", name: "Branding suite" };

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Every brand row and stored object this suite created, so it can be undone. */
const createdKeys: string[] = [];

async function cleanup() {
  const rows = await prisma.brandAsset.findMany({ where: { createdById: ACTOR.id } });
  for (const row of rows) createdKeys.push(row.storageKey);
  await prisma.brandAsset.deleteMany({ where: { createdById: ACTOR.id } });
  await prisma.adminPreference.deleteMany({ where: { key: "brand_display_name" } });
  for (const key of new Set(createdKeys)) {
    await getStorage().remove(key).catch(() => {});
  }
}

/** A real image, produced by the same ffmpeg the application uses. */
async function makePng(
  width: number,
  height: number,
  withExif = false,
  format: "png" | "jpg" = "png"
): Promise<Buffer> {
  const workspace = await mkdtemp(join(tmpdir(), "mv-brand-suite-"));
  try {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", `color=c=navy:s=${width}x${height}:d=1`,
      "-frames:v", "1",
    ];
    if (withExif) {
      // A comment tag is enough to prove the strip: ffmpeg writes it into the
      // container, and the re-encode must not carry it across.
      args.push("-metadata", "comment=SHOULD-NOT-SURVIVE");
    }
    args.push(format === "png" ? "out.png" : "out.jpg");
    const code = await new Promise<number>((resolve) => {
      const child = spawn("ffmpeg", args, { cwd: workspace, stdio: "ignore" });
      child.on("error", () => resolve(-1));
      child.on("close", (value) => resolve(value ?? -1));
    });
    if (code !== 0) throw new Error("the suite could not produce a test image");
    return await readFile(join(workspace, format === "png" ? "out.png" : "out.jpg"));
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Attach a real PNG `tEXt` chunk to an encoded image.
 *
 * WHY THIS IS DONE BY HAND. The first version of this suite asked ffmpeg to
 * write `-metadata comment=…` and then asserted the marker was gone afterwards.
 * It was gone — because ffmpeg had never written it. The check passed for a
 * reason unrelated to the property, and the "the re-encode changed the bytes"
 * check failed beside it for the same reason. Injecting the chunk makes the
 * precondition a fact about the input rather than an assumption about the
 * encoder.
 */
function injectPngText(png: Buffer, keyword: string, text: string): Buffer {
  const chunkData = Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]),
    Buffer.from(text, "latin1"),
  ]);
  const chunk = Buffer.concat([
    Buffer.from([0, 0, 0, chunkData.length]),
    Buffer.from("tEXt", "latin1"),
    chunkData,
    Buffer.from([0, 0, 0, 0]), // CRC — ffmpeg does not verify it, and neither do we.
  ]);
  // Immediately before IEND: the last 12 bytes of a PNG are the empty IEND chunk.
  return Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
}

/** Wrap bytes so the service's `File`-shaped checks pass. */
function asFile(bytes: Buffer, type: string, name = "logo.png"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** A runner that writes back whatever bytes it is handed, and records the args. */
function stubRunner(output: Buffer, calls: string[][] = []): ImageRunner {
  const runner = (async (args: string[]) => {
    calls.push(args);
    runner.output = output;
  }) as ImageRunner;
  runner.output = undefined;
  return runner;
}

async function main() {
  forbidProviderCalls("verify-branding");
  await cleanup();

  /* ------------------------------------------------------------------ */
  /* 1. Header parsing                                                   */
  /* ------------------------------------------------------------------ */

  const png = await makePng(300, 120);
  check(
    "the PNG header is parsed for its exact size",
    (() => {
      const size = readImageSize(png, "image/png");
      return size?.width === 300 && size?.height === 120;
    })(),
    JSON.stringify(readImageSize(png, "image/png"))
  );

  check(
    "the PNG signature is recognised",
    detectBrandSignature(png) === "image/png"
  );
  check(
    "an ELF is not an image",
    detectBrandSignature(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])) === null
  );
  check(
    "an SVG is not an image",
    detectBrandSignature(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) === null
  );
  check(
    "a truncated PNG yields no size rather than a guess",
    readImageSize(png.subarray(0, 12), "image/png") === null
  );

  /* ------------------------------------------------------------------ */
  /* 2. What the sanitizer decides, with the encoder controlled          */
  /* ------------------------------------------------------------------ */

  const tallPng = await makePng(100, 4000);
  const calls: string[][] = [];
  const oversized = await sanitizeImage({
    bytes: tallPng,
    contentType: "image/png",
    runner: stubRunner(png, calls),
  });
  check(
    "an image taller than the bound is SCALED, not refused",
    oversized.status === "ok",
    oversized.status === "refused" ? oversized.reason : ""
  );
  check(
    "and the scale filter is asked for the bounded height",
    calls.some((args) => args.join(" ").includes("scale=")) &&
      calls.some((args) => /scale=\d+:-2/.test(args.join(" "))),
    calls.map((args) => args[args.indexOf("-vf") + 1]).join(" | ")
  );
  check(
    "every run strips container metadata",
    calls.every((args) => args.includes("-map_metadata") && args.includes("-1")),
    "map_metadata -1"
  );
  check(
    "and takes exactly one frame, so an animated source cannot produce a sequence",
    calls.every((args) => args.includes("-frames:v") && args.includes("1"))
  );

  const jpeg = await makePng(200, 90, false, "jpg");
  const jpegCalls: string[][] = [];
  const fromJpeg = await sanitizeImage({
    bytes: jpeg,
    contentType: "image/jpeg",
    // The stub must answer in the format the encoder would: handing back PNG
    // bytes for a JPEG job fails the read-back, which is the service correctly
    // refusing to store something it cannot parse.
    runner: stubRunner(jpeg, jpegCalls),
  });
  check(
    "a JPEG source re-encodes to JPEG — the output format is chosen from the source",
    fromJpeg.status === "ok" && fromJpeg.contentType === "image/jpeg" && jpegCalls.length > 0,
    fromJpeg.status === "ok" ? fromJpeg.contentType : fromJpeg.reason
  );

  const pngToPng = await sanitizeImage({
    bytes: png,
    contentType: "image/png",
    runner: stubRunner(png),
  });
  check(
    "a PNG source stays PNG, so a transparent logo is not flattened to black",
    pngToPng.status === "ok" && pngToPng.contentType === "image/png",
    pngToPng.status === "ok" ? pngToPng.contentType : pngToPng.reason
  );

  const webpToPng = await sanitizeImage({
    bytes: png,
    contentType: "image/webp",
    runner: stubRunner(png),
  });
  check(
    "PNG bytes declared as WebP are refused — the declaration is checked against the bytes",
    webpToPng.status === "refused"
  );

  const refused = await sanitizeImage({
    bytes: Buffer.from("not an image at all"),
    contentType: "image/png",
    runner: stubRunner(png),
  });
  check(
    "bytes whose header cannot be read are refused before the encoder runs",
    refused.status === "refused" && refused.reason.includes("header")
  );

  /* ------------------------------------------------------------------ */
  /* 3. What an upload is allowed to be                                  */
  /* ------------------------------------------------------------------ */

  const svg = await replaceBrandSlot(
    "PRIMARY",
    new File([new TextEncoder().encode("<svg/>")], "logo.svg", { type: "image/svg+xml" }),
    ACTOR
  );
  check(
    "an SVG upload is refused, with the reason",
    !svg.ok && svg.error.includes("SVG"),
    svg.ok ? "accepted" : svg.error.slice(0, 70)
  );

  const wrongType = await replaceBrandSlot("PRIMARY", asFile(png, "image/jpeg", "x.jpg"), ACTOR);
  check(
    "a file whose bytes disagree with its declared type is refused",
    !wrongType.ok && wrongType.error.includes("do not match"),
    wrongType.ok ? "accepted" : wrongType.error
  );

  const pdf = await replaceBrandSlot(
    "PRIMARY",
    new File([new TextEncoder().encode("%PDF-1.4")], "x.pdf", { type: "application/pdf" }),
    ACTOR
  );
  check("a PDF is refused — a brand slot is an image and only an image", !pdf.ok);

  const oversizedFile = await replaceBrandSlot(
    "PRIMARY",
    new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" }),
    ACTOR
  );
  check(
    "a file over 5 MB is refused before its bytes are decoded",
    !oversizedFile.ok && oversizedFile.error.includes("5 MB"),
    oversizedFile.ok ? "accepted" : oversizedFile.error
  );

  /* ------------------------------------------------------------------ */
  /* 4. The real pipeline, end to end                                    */
  /* ------------------------------------------------------------------ */

  const withExif = injectPngText(
    await makePng(200, 200),
    "Comment",
    "SHOULD-NOT-SURVIVE"
  );
  check(
    "the test upload really does carry the metadata it is about to be stripped of",
    withExif.includes("SHOULD-NOT-SURVIVE"),
    `${withExif.length} bytes with a tEXt chunk`
  );
  const stamped = await replaceBrandSlot("PRIMARY", asFile(withExif, "image/png", "original.png"), ACTOR);
  check("a real PNG uploads through the real encoder", stamped.ok, stamped.ok ? `v${stamped.version}` : stamped.error);

  const live = await prisma.brandAsset.findFirst({
    where: { slot: "PRIMARY", supersededAt: null },
  });
  if (live) createdKeys.push(live.storageKey);

  const storedAtUpload = live ? await getStorage().get(live.storageKey) : null;
  const stored = storedAtUpload;

  check(
    "the stored object is NOT the uploaded bytes — a re-encode happened",
    Boolean(live) && storedAtUpload !== null && !Buffer.from(storedAtUpload).equals(withExif),
    live ? `uploaded ${withExif.length} bytes → stored ${live.bytes} bytes` : "no row"
  );
  check(
    "the stored bytes are PNG and carry a checksum of what was stored",
    live?.contentType === "image/png" &&
      stored !== null &&
      live.checksum === createHash("sha256").update(Buffer.from(stored)).digest("hex"),
    live?.checksum.slice(0, 12)
  );
  check(
    "the metadata tag the upload carried is GONE from the stored bytes",
    stored !== null && !Buffer.from(stored).includes("SHOULD-NOT-SURVIVE"),
    "comment=SHOULD-NOT-SURVIVE"
  );
  check(
    "the URL carries the checksum, so replacing a logo changes the URL",
    Boolean(live) && brandAssetPath("PRIMARY", live!.version, live!.checksum).includes(live!.checksum.slice(0, 12)),
    live ? brandAssetPath("PRIMARY", live.version, live.checksum) : ""
  );

  /* ------------------------------------------------------------------ */
  /* 5. Versioning, rollback and the one-live-row rule                   */
  /* ------------------------------------------------------------------ */

  const second = await replaceBrandSlot(
    "PRIMARY",
    asFile(await makePng(240, 80), "image/png", "second.png"),
    ACTOR
  );
  check("replacing a slot bumps the version", second.ok && second.version === (stamped.ok ? stamped.version + 1 : -1));

  const rows = await prisma.brandAsset.findMany({ where: { slot: "PRIMARY" }, orderBy: { version: "asc" } });
  rows.forEach((row) => createdKeys.push(row.storageKey));
  check(
    "the previous version is KEPT, not deleted",
    rows.length >= 2,
    `${rows.length} version(s)`
  );
  check(
    "exactly one version is live",
    rows.filter((row) => row.supersededAt === null).length === 1
  );

  const rolledBack = await restoreBrandVersion("PRIMARY", stamped.ok ? stamped.version : 1, ACTOR);
  const afterRollback = await prisma.brandAsset.findMany({ where: { slot: "PRIMARY" } });
  check(
    "an earlier version can be restored, and the slot still has exactly one live row",
    rolledBack.ok && afterRollback.filter((row) => row.supersededAt === null).length === 1
  );

  // The database, not the application, is what refuses a second live version.
  let dbRefused = false;
  try {
    await prisma.brandAsset.create({
      data: {
        slot: "PRIMARY",
        version: 9999,
        storageKey: "0".repeat(32) + ".png",
        contentType: "image/png",
        width: 1,
        height: 1,
        bytes: 1,
        checksum: "x",
        createdById: ACTOR.id,
        supersededAt: null,
      },
    });
  } catch {
    dbRefused = true;
  }
  check(
    "two live versions of one slot are impossible even by direct insert",
    dbRefused,
    "the partial unique index is the guard, not application code"
  );
  await prisma.brandAsset.deleteMany({ where: { version: 9999 } });

  /* ------------------------------------------------------------------ */
  /* 6. The fallback chain                                               */
  /* ------------------------------------------------------------------ */

  /*
   * THE FALLBACK CHAIN IS TESTED FROM A KNOWN STATE, not from whatever the
   * clone happens to hold.
   *
   * This section used to assert that DARK, SQUARE and INVOICE were empty and
   * therefore resolved to PRIMARY — which passed on a freshly cloned database
   * and failed the moment anything else had put a logo in one of those slots.
   * It broke exactly that way, on a fixture another tool had left behind, and a
   * check that depends on unrelated state is a check that will fail for reasons
   * that have nothing to do with the code.
   *
   * So every slot is superseded first, the chain is asserted against a state the
   * suite owns, and the previous state is restored afterwards.
   */
  const liveBefore = await prisma.brandAsset.findMany({
    where: { supersededAt: null, slot: { in: ["DARK", "SQUARE", "INVOICE"] } },
    select: { id: true, slot: true },
  });
  // ONLY the three slots the chain is about. PRIMARY is left alone because it is
  // the fallback every one of these resolves TO — superseding it too would leave
  // nothing to fall back to and turn three correct answers into three nulls.
  await prisma.brandAsset.updateMany({
    where: { supersededAt: null, slot: { in: ["DARK", "SQUARE", "INVOICE"] } },
    data: { supersededAt: new Date() },
  });

  check(
    "an empty INVOICE slot resolves to PRIMARY",
    (await effectiveSlot("INVOICE")) === "PRIMARY",
    String(await effectiveSlot("INVOICE"))
  );
  check(
    "an empty DARK slot resolves to PRIMARY",
    (await effectiveSlot("DARK")) === "PRIMARY"
  );
  check(
    "an empty SQUARE slot resolves to PRIMARY",
    (await effectiveSlot("SQUARE")) === "PRIMARY"
  );
  check(
    "and with nothing live at all, no slot resolves — the chain terminates",
    await (async () => {
      const primaryLive = await prisma.brandAsset.findMany({
        where: { slot: "PRIMARY", supersededAt: null },
        select: { id: true },
      });
      await prisma.brandAsset.updateMany({ where: { slot: "PRIMARY", supersededAt: null }, data: { supersededAt: new Date() } });
      const resolved = await effectiveSlot("PRIMARY");
      for (const row of primaryLive) {
        await prisma.brandAsset.update({ where: { id: row.id }, data: { supersededAt: null } });
      }
      return resolved === null;
    })()
  );
  check(
    "the invoice PDF gets bytes, through the fallback",
    (await brandImageFor("INVOICE")) !== null
  );
  check(
    "the fallback chain is declared for every slot and never points at itself",
    BRAND_SLOT_SPECS.every((spec) => spec.fallback !== spec.slot)
  );

  const url = await brandImageUrl("INVOICE");
  check(
    "the served URL for a fallback slot names the slot that actually has the asset",
    url !== null && url.startsWith("/brand/primary/"),
    url ?? "none"
  );

  /* ------------------------------------------------------------------ */
  /* 7. Reset, and the name                                              */
  /* ------------------------------------------------------------------ */

  const reset = await resetBrandSlot("PRIMARY", ACTOR);
  check("a slot can be reset to its default", reset.ok);
  check(
    "a reset slot keeps its versions, so the reset is reversible",
    (await prisma.brandAsset.count({ where: { slot: "PRIMARY" } })) >= 2
  );

  const named = await setDisplayName("  MoonVella Test  ", ACTOR);
  check("the display name is trimmed and stored", named === "MoonVella Test", named);
  const cleared = await setDisplayName("", ACTOR);
  check("an empty display name falls back to the default", cleared === "MoonVella", cleared);

  const view = await getBrandView();
  check(
    "the brand view covers every slot exactly once",
    view.slots.length === BRAND_SLOTS.length &&
      BRAND_SLOTS.every((slot) => view.slots.filter((entry) => entry.slot === slot).length === 1)
  );

  /* ------------------------------------------------------------------ */
  /* 8. The route the browser actually asks for                          */
  /* ------------------------------------------------------------------ */

  /*
   * `/brand/` MUST BE HOST-AGNOSTIC, AND THIS IS NOT A STYLE CHECK.
   *
   * `server.js` splits the two surfaces by PATH as well as by hostname, and a
   * path it does not recognise is treated as a merchant path — which the admin
   * host answers with a 404. The brand route matches no `/admin/` prefix, so
   * without an entry in `isHostAgnostic` the operator's own logo 404s on the
   * operator's own sidebar and sign-in page, and the browser reports it as a
   * missing file rather than as a routing rule.
   *
   * That is exactly what happened on the first deploy of this feature, and it
   * was found by fetching the URL rather than by any of the checks above.
   */
  /* ------------------------------------------------------------------ */
  /* 10. No mutation on this page may return binary.                      */
  /* ------------------------------------------------------------------ */

  /*
   * THE DEFECT THIS EXISTS FOR. The page's action returned
   * `new Response(pngBytes)` for the app-icon download. React Router treats an
   * action's return value as DATA for the document it is about to re-render, so
   * the page received a PNG where it expected a result, ran its own
   * `"error" in actionData` against the bytes, and threw
   * `TypeError: Cannot use 'in' operator to search for 'error' in <PNG IHDR…>`
   * — "Application Error!" with the artwork rendered as garbled text.
   *
   * A source check is the right shape here: the defect is not a value the code
   * computes, it is the TYPE of thing the action is allowed to return, and no
   * fixture can make an action return a Response.
   */
  const wiring = readFileSync(join(process.cwd(), "app/routes/admin.branding.tsx"), "utf8");
  check(
    "10  no branding ACTION returns a Response — that is page data, not a file",
    !/export async function action[\s\S]{0,4000}?return new Response\(/.test(wiring),
    /return new Response\(/.test(wiring) ? "an action still returns a Response" : "actions return data only"
  );
  check(
    "10b the app-icon download is a RESOURCE ROUTE with a loader",
    (() => {
      const route = readFileSync(join(process.cwd(), "app/routes/admin.branding_.icon[.]png.tsx"), "utf8");
      return route.includes("export async function loader") && !route.includes("export async function action");
    })()
  );
  check(
    "10c and the page LINKS to it rather than posting for it",
    wiring.includes("/admin/branding/icon.png") && !wiring.includes('intent" value="app-icon"')
  );
  check(
    "10d the download route is gated on the same permission as the page",
    /requirePermission\(request, "settings\.general"\)/.test(
      readFileSync(join(process.cwd(), "app/routes/admin.branding_.icon[.]png.tsx"), "utf8")
    )
  );
  check(
    "10e a reset asks for confirmation inside the page, never window.confirm",
    /*
     * COMMENTS ARE STRIPPED FIRST. The page documents this rule in prose that
     * contains the literal `window.confirm`, so asserting on the raw source
     * failed on code that was correct — twice, once for a regex matching the
     * word "confirmation". The question is what the CODE does, and the code is
     * what is left after the comments come out.
     */
    (() => {
      const code = wiring
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return code.includes("armedReset") && !code.includes("window.confirm") && !code.includes("confirm(");
    })(),
    "no browser dialog can be suppressed and leave a dead button"
  );

  const serverSource = readFileSync(join(process.cwd(), "server.js"), "utf8");
  const agnosticBlock = serverSource.slice(
    serverSource.indexOf("function isHostAgnostic"),
    serverSource.indexOf("function isProviderCallback")
  );
  check(
    "8  /brand/ is served on BOTH hosts — the sidebar and the sign-in page are on the admin host",
    agnosticBlock.includes('pathname.startsWith("/brand/")'),
    agnosticBlock.includes("/brand/") ? "declared" : "MISSING — the logo will 404 on the admin host"
  );

  /* ------------------------------------------------------------------ */
  /* 9. The media library is unaffected                                  */
  /* ------------------------------------------------------------------ */

  const media = await saveUpload(asFile(png, "image/png", "not-a-logo.png"));
  createdKeys.push(media.key);
  check(
    "an ordinary media upload still works beside the brand path",
    typeof media.key === "string" && media.key.length > 0
  );

  await cleanup();
  /*
   * Put back the slots this suite hid. The suite's own rows are deleted by
   * `cleanup`; this restores anything that was live BEFORE it ran, so running
   * the suite does not leave the clone's branding reset for whatever runs next.
   */
  for (const row of liveBefore) {
    await prisma.brandAsset.update({ where: { id: row.id }, data: { supersededAt: null } }).catch(() => {});
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("verify-branding FAILED:", error instanceof Error ? error.message : error);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
