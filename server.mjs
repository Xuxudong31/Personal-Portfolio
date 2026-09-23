import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnalyticsService } from "./analytics.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(ROOT, ".env");
const startupEnv = readEnv(ENV_FILE);
const PORT = Number(process.env.PORT || startupEnv.PORT || 4173);
const HOST = process.env.HOST || startupEnv.HOST || "127.0.0.1";
const MAX_BODY_BYTES = 16_000;
const ANALYTICS_WRITES_PER_MINUTE = 120;
const DEFAULT_ANALYTICS_ORIGINS = "https://xuxudong31.github.io";
const PUBLIC_FILES = new Set(["index.html", "admin.html", "admin.css", "admin.js"]);
const analyticsWriteWindows = new Map();
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".riv": "application/octet-stream",
};

function readEnv(file) {
  const values = {};
  if (!existsSync(file)) return values;
  const source = readFileSync(file, "utf8");
  source.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  });
  return values;
}

const analytics = createAnalyticsService({
  databaseUrl: process.env.DATABASE_URL || startupEnv.DATABASE_URL || "",
  adminPassword: process.env.ADMIN_PASSWORD || startupEnv.ADMIN_PASSWORD || "",
  sessionSecret: process.env.ADMIN_SESSION_SECRET || startupEnv.ADMIN_SESSION_SECRET || "",
  visitorSecret: process.env.ANALYTICS_VISITOR_SECRET || startupEnv.ANALYTICS_VISITOR_SECRET || "",
  timeZone: process.env.ANALYTICS_TIME_ZONE || startupEnv.ANALYTICS_TIME_ZONE || "Asia/Shanghai",
});

const allowedAnalyticsOrigins = new Set(
  (process.env.ANALYTICS_ALLOWED_ORIGINS || startupEnv.ANALYTICS_ALLOWED_ORIGINS || DEFAULT_ANALYTICS_ORIGINS)
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function requestOrigin(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${protocol}://${host}` : "";
}

function analyticsCors(req) {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");
  if (!origin) return { allowed: true, headers: {} };
  const localOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin);
  const allowed = origin === requestOrigin(req) || allowedAnalyticsOrigins.has(origin)
    || (process.env.NODE_ENV !== "production" && localOrigin);
  return {
    allowed,
    headers: allowed ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    } : {},
  };
}

function allowAnalyticsWrite(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const address = forwarded || req.socket?.remoteAddress || "unknown";
  const key = createHash("sha256").update(address).digest("hex").slice(0, 20);
  const now = Date.now();
  const state = analyticsWriteWindows.get(key);
  if (!state || state.startedAt <= now - 60_000) {
    analyticsWriteWindows.set(key, { startedAt: now, count: 1 });
    if (analyticsWriteWindows.size > 2_000) {
      for (const [entryKey, entry] of analyticsWriteWindows) {
        if (entry.startedAt <= now - 60_000) analyticsWriteWindows.delete(entryKey);
      }
    }
    return true;
  }
  state.count += 1;
  return state.count <= ANALYTICS_WRITES_PER_MINUTE;
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error("请求内容过大"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (_) {
    throw Object.assign(new Error("请求不是有效的 JSON"), { status: 400 });
  }
}

async function handleAnalyticsApi(req, res, url) {
  const cors = analyticsCors(req);
  if (!cors.allowed) {
    json(res, 403, { error: "该来源不能写入统计数据。" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors.headers);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "只允许 POST 请求。" }, cors.headers);
    return;
  }
  if (!allowAnalyticsWrite(req)) {
    json(res, 202, { ok: true, tracked: false, reason: "rate_limited" }, cors.headers);
    return;
  }
  const body = await readJsonBody(req);
  try {
    const result = url.pathname === "/api/analytics/visit"
      ? await analytics.trackVisit(body, req)
      : url.pathname === "/api/analytics/heartbeat"
        ? await analytics.heartbeat(body, req)
        : null;
    if (!result) {
      json(res, 404, { error: "接口不存在。" }, cors.headers);
      return;
    }
    json(res, 202, { ok: true, ...result }, cors.headers);
  } catch (error) {
    console.error(`[analytics] 写入失败：${error.message}`);
    json(res, 503, { ok: false, tracked: false, error: "统计服务暂时不可用。" }, cors.headers);
  }
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith("/api/analytics/")) {
    await handleAnalyticsApi(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    try {
      await analytics.ready();
      json(res, 200, {
        ok: true,
        service: "Ethen Portfolio Analytics",
        analytics: { storage: analytics.storage, adminConfigured: analytics.configured },
      });
    } catch (error) {
      console.error(`[analytics] 健康检查失败：${error.message}`);
      json(res, 503, {
        ok: false,
        service: "Ethen Portfolio Analytics",
        analytics: { storage: analytics.storage, adminConfigured: analytics.configured },
      });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/admin/session") {
    json(res, 200, {
      ok: true,
      authenticated: analytics.isAdmin(req),
      configured: analytics.configured,
      storage: analytics.storage,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readJsonBody(req);
    const result = analytics.login(req, String(body.password || ""));
    if (!result.ok) {
      json(res, result.status, { error: result.error });
      return;
    }
    res.setHeader("Set-Cookie", result.cookie);
    json(res, 200, { ok: true, storage: analytics.storage });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    res.setHeader("Set-Cookie", analytics.clearSessionCookie(req));
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/admin/stats") {
    if (!analytics.isAdmin(req)) {
      json(res, 401, { error: "请先登录数据后台。" });
      return;
    }
    try {
      json(res, 200, { ok: true, ...(await analytics.getStats(url.searchParams.get("days"))) });
    } catch (error) {
      console.error(`[analytics] 读取失败：${error.message}`);
      json(res, 503, { error: "统计数据库暂时不可用，请稍后刷新。" });
    }
    return;
  }
  json(res, 404, { error: "接口不存在。" });
}

function isPublicFile(relativeFile) {
  if (PUBLIC_FILES.has(relativeFile)) return true;
  return relativeFile === "assets" || relativeFile.startsWith(`assets${sep}`);
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("请求地址无效");
    return;
  }
  const requested = pathname === "/"
    ? "index.html"
    : pathname === "/admin" || pathname === "/admin/"
      ? "admin.html"
      : pathname.replace(/^\/+/, "");
  const file = resolve(ROOT, requested);
  const relativeFile = relative(ROOT, file);
  if (relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("禁止访问");
    return;
  }
  if (!isPublicFile(relativeFile) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("页面不存在");
    return;
  }
  const headers = {
    "Content-Type": MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": relativeFile.startsWith(`assets${sep}`) ? "public, max-age=86400" : "no-cache",
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    const status = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}: ${error.message}`);
    if (!res.headersSent) json(res, status, { error: status >= 500 ? "服务器处理失败。" : error.message });
    else res.end();
  }
});

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  server.listen(PORT, HOST, () => {
    console.log(`PORTFOLIO_ANALYTICS_READY http://${HOST}:${PORT}`);
    console.log(`数据后台：${analytics.configured ? "已配置密码" : "等待配置 ADMIN_PASSWORD"} · ${analytics.storage}`);
    analytics.ready().catch((error) => console.error(`[analytics] 数据库初始化失败：${error.message}`));
  });
}

export { analytics, server };

