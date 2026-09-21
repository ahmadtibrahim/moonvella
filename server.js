/**
 * MoonVella production server.
 *
 * Replaces the stock `react-router-serve` CLI so that we can enforce, before
 * any route code runs:
 *
 *   1. A strict Host allowlist. The merchant app and the owner panel share one
 *      process but are reachable only on their own hostname. A request with an
 *      unrecognised Host is refused outright rather than being routed.
 *   2. Cross-surface isolation. `/admin/*` on the merchant host is redirected
 *      to the owner panel; merchant routes on the owner host 404.
 *   3. Graceful shutdown. On SIGTERM the listener stops accepting new
 *      connections, in-flight requests are allowed to finish, then the Prisma
 *      pool is closed before the process exits.
 *
 * Static assets are served from build/client with traversal protection. Nginx
 * terminates TLS, compression and caching in production; this server never
 * binds anything but the address Docker publishes, which is loopback-only.
 */
import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequestListener } from "@react-router/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// Loopback by default. The container runs with host networking (the host's
// nftables forward policy is DROP, so bridge networking has no egress at all),
// which means this bind address is the ONLY thing keeping the app off the
// public interface. Nginx proxies to 127.0.0.1:3000 on the same host.
// Overriding HOST to 0.0.0.0 would expose the app directly — don't.
const HOST = process.env.HOST || "127.0.0.1";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const CLIENT_DIR = path.join(__dirname, "build", "client");
const BUILD_PATH = path.join(__dirname, "build", "server", "index.js");

/* -------------------------------------------------------------------------- */
/* Host policy                                                                */
/* -------------------------------------------------------------------------- */

function parseHostList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const APP_HOSTS = parseHostList(process.env.APP_ALLOWED_HOSTS || "app.moonvella.com");
const ADMIN_HOSTS = parseHostList(process.env.ADMIN_ALLOWED_HOSTS || "admin.moonvella.com");
const ADMIN_ORIGIN = process.env.ADMIN_APP_URL || `https://${ADMIN_HOSTS[0] || "admin.moonvella.com"}`;

// Local development only. Never enabled in production, where the two allowed
// hostnames above are the complete set.
const DEV_HOSTS = IS_PRODUCTION ? [] : ["localhost", "127.0.0.1", "0.0.0.0", "::1"];

const ALLOWED_HOSTS = new Set([...APP_HOSTS, ...ADMIN_HOSTS, ...DEV_HOSTS]);

/** Strip the :port suffix and lowercase. Bracketed IPv6 is left intact. */
function normalizeHost(headerValue) {
  if (!headerValue) return "";
  const value = String(headerValue).trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

function surfaceForHost(host) {
  if (ADMIN_HOSTS.includes(host)) return "admin";
  if (APP_HOSTS.includes(host)) return "app";
  if (DEV_HOSTS.includes(host)) return "app"; // local smoke testing only
  return "unknown";
}

/**
 * Which surface a path belongs to. Anything not owner-specific is treated as
 * merchant-facing, so a path that is not explicitly recognised can never leak
 * onto the owner host by accident.
 */
function surfaceForPath(pathname) {
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  return "public";
}

/** Assets and the probe must work on both hosts for either surface to render. */
function isHostAgnostic(pathname) {
  return (
    pathname === "/health" ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/build/") ||
    pathname.startsWith("/uploads/")
  );
}

/* -------------------------------------------------------------------------- */
/* Static assets                                                              */
/* -------------------------------------------------------------------------- */

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve a file from build/client. Returns true when the request was handled.
 * Vite emits content-hashed filenames under /assets, so those are immutable.
 */
async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes("\0")) return false;

  const target = path.resolve(CLIENT_DIR, "." + decoded);
  // Reject anything that escapes the client build directory.
  if (target !== CLIENT_DIR && !target.startsWith(CLIENT_DIR + path.sep)) return false;

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  res.setHeader("Content-Type", CONTENT_TYPES[ext] || "application/octet-stream");
  res.setHeader(
    "Cache-Control",
    decoded.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600"
  );
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "HEAD") {
    res.writeHead(200).end();
    return true;
  }

  await new Promise((resolve) => {
    const stream = createReadStream(target);
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      resolve();
    });
    stream.on("end", resolve);
    stream.pipe(res);
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

function html(res, status, message) {
  const body = `<!doctype html><meta charset="utf-8"><title>${status}</title><p>${message}</p>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

let build;
try {
  build = await import(pathToFileURL(BUILD_PATH).href);
} catch (error) {
  console.error(
    `[moonvella] unable to load the server build at ${BUILD_PATH}:`,
    error?.message || error
  );
  process.exit(1);
}

const requestListener = createRequestListener({
  build,
  mode: IS_PRODUCTION ? "production" : "development",
});

/** In-flight requests, tracked so shutdown can wait for them. */
let inFlight = 0;
let shuttingDown = false;

const server = http.createServer(async (req, res) => {
  const pathname = (() => {
    try {
      return new URL(req.url, "http://internal").pathname;
    } catch {
      return "/";
    }
  })();

  // The probe is served directly and is exempt from the Host allowlist: it is
  // reachable only on the loopback address Docker publishes.
  if (pathname === "/health") {
    res.setHeader("Cache-Control", "no-store");
    return handleHealth(res);
  }

  const host = normalizeHost(req.headers.host);
  const hostSurface = surfaceForHost(host);

  if (hostSurface === "unknown" || !ALLOWED_HOSTS.has(host)) {
    // Refuse rather than route. A request arriving with an unexpected Host is
    // either misdirected or an attempt to reach the owner panel by another name.
    return html(res, 421, "Misdirected Request");
  }

  if (shuttingDown && !isHostAgnostic(pathname)) {
    res.setHeader("Connection", "close");
    return html(res, 503, "Service restarting");
  }

  const pathSurface = surfaceForPath(pathname);

  if (!isHostAgnostic(pathname)) {
    if (hostSurface === "app" && pathSurface === "admin") {
      // The owner panel lives on its own origin; keep owner cookies off the
      // merchant host entirely.
      res.writeHead(302, {
        Location: `${ADMIN_ORIGIN.replace(/\/$/, "")}${pathname}`,
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    if (hostSurface === "admin" && pathSurface !== "admin") {
      // Merchant application routes are not served on the owner origin.
      return html(res, 404, "Not Found");
    }
  }

  inFlight += 1;
  res.on("close", () => {
    inFlight -= 1;
  });

  try {
    if (await serveStatic(req, res, pathname)) return;
    await requestListener(req, res);
  } catch (error) {
    console.error("[moonvella] unhandled request error:", error?.message || error);
    if (!res.headersSent) html(res, 500, "Internal Server Error");
    else res.end();
  }
});

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

let prismaClient = null;

async function getPrisma() {
  if (prismaClient) return prismaClient;
  const { PrismaClient } = await import("@prisma/client");
  prismaClient = new PrismaClient();
  return prismaClient;
}

/**
 * Readiness probe. Confirms the process is up and that the database answers.
 * Reports status only — never configuration or credentials.
 */
async function handleHealth(res) {
  const body = {
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    checks: { database: "unknown" },
  };
  let code = 200;
  try {
    const prisma = await getPrisma();
    await prisma.$queryRaw`SELECT 1`;
    body.checks.database = "ok";
  } catch {
    body.checks.database = "unavailable";
    body.status = "degraded";
    code = 503;
  }
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 25000);

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[moonvella] ${signal} received — draining (${inFlight} in flight)`);

  const forceTimer = setTimeout(() => {
    console.error("[moonvella] drain timed out, exiting");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceTimer.unref();

  server.close(() => {});

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    if (prismaClient) await prismaClient.$disconnect();
  } catch (error) {
    console.error("[moonvella] prisma disconnect failed:", error?.message || error);
  }

  clearTimeout(forceTimer);
  console.log("[moonvella] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  console.log(
    `[moonvella] listening on ${HOST}:${PORT} — app hosts: ${APP_HOSTS.join(", ")} — admin hosts: ${ADMIN_HOSTS.join(", ")}`
  );
});
