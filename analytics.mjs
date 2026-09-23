import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const ADMIN_COOKIE = "ethen_portfolio_admin";
const SESSION_SECONDS = 12 * 60 * 60;
const VISITOR_ID_RE = /^[a-zA-Z0-9_-]{16,80}$/;
const BOT_RE = /bot|spider|crawler|headless|preview|facebookexternalhit|slurp|bingpreview/i;

function cleanText(value, maxLength = 120) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function normalizeVisitorId(value) {
  const visitorId = cleanText(value, 80);
  return VISITOR_ID_RE.test(visitorId) ? visitorId : "";
}

function normalizePath(value) {
  const path = cleanText(value || "/", 160);
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [part, ""];
      const value = part.slice(index + 1);
      try { return [part.slice(0, index), decodeURIComponent(value)]; }
      catch (_) { return [part.slice(0, index), value]; }
    }));
}

function safeEqualText(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function visitorMetadata(body, req) {
  const userAgent = cleanText(req.headers["user-agent"], 260);
  let device = "电脑";
  if (/ipad|tablet|kindle/i.test(userAgent)) device = "平板";
  else if (/mobile|android|iphone|ipod/i.test(userAgent)) device = "手机";

  let browser = "其他浏览器";
  if (/MicroMessenger/i.test(userAgent)) browser = "微信";
  else if (/Edg\//i.test(userAgent)) browser = "Edge";
  else if (/OPR\//i.test(userAgent)) browser = "Opera";
  else if (/Firefox\//i.test(userAgent)) browser = "Firefox";
  else if (/Chrome\//i.test(userAgent)) browser = "Chrome";
  else if (/Safari\//i.test(userAgent)) browser = "Safari";

  let referrer = "直接访问";
  const rawReferrer = cleanText(body.referrer, 500);
  if (rawReferrer) {
    try {
      const referrerUrl = new URL(rawReferrer);
      const currentHost = cleanText(body.currentHost, 160);
      if (referrerUrl.hostname && referrerUrl.hostname !== currentHost) {
        referrer = referrerUrl.hostname.slice(0, 120);
      }
    } catch (_) {}
  }

  return { device, browser, referrer, isBot: BOT_RE.test(userAgent) };
}

function dayKey(value, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function countBy(items, getLabel, limit = 6) {
  const counts = new Map();
  items.forEach((item) => {
    const label = getLabel(item) || "未知";
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"))
    .slice(0, limit);
}

class MemoryAnalyticsStore {
  constructor({ timeZone }) {
    this.kind = "memory";
    this.timeZone = timeZone;
    this.visitors = new Map();
    this.pageviews = [];
    this.visitEvents = new Set();
  }

  async ready() {}

  async trackVisit(record) {
    if (this.visitEvents.has(record.visitHash)) return false;
    this.visitEvents.add(record.visitHash);
    const now = Date.now();
    const existing = this.visitors.get(record.visitorHash);
    this.visitors.set(record.visitorHash, {
      ...record,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
      totalVisits: (existing?.totalVisits || 0) + 1,
      referrer: existing?.referrer === "直接访问" && record.referrer !== "直接访问"
        ? record.referrer
        : existing?.referrer || record.referrer,
    });
    this.pageviews.push({ ...record, createdAt: now });
    return true;
  }

  async heartbeat(visitorHash) {
    const visitor = this.visitors.get(visitorHash);
    if (visitor) visitor.lastSeen = Date.now();
  }

  async getStats(days) {
    const now = Date.now();
    const today = dayKey(now, this.timeZone);
    const yesterday = dayKey(now - 86_400_000, this.timeZone);
    const todayViews = this.pageviews.filter((view) => dayKey(view.createdAt, this.timeZone) === today);
    const yesterdayViews = this.pageviews.filter((view) => dayKey(view.createdAt, this.timeZone) === yesterday);
    const daily = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = dayKey(now - offset * 86_400_000, this.timeZone);
      const views = this.pageviews.filter((view) => dayKey(view.createdAt, this.timeZone) === date);
      daily.push({
        date,
        label: date.slice(5),
        visitors: new Set(views.map((view) => view.visitorHash)).size,
        pageviews: views.length,
      });
    }
    const visitors = [...this.visitors.values()];
    return {
      generatedAt: new Date(now).toISOString(),
      days,
      storage: this.kind,
      overview: {
        totalVisitors: visitors.length,
        totalPageviews: this.pageviews.length,
        todayVisitors: new Set(todayViews.map((view) => view.visitorHash)).size,
        todayPageviews: todayViews.length,
        yesterdayVisitors: new Set(yesterdayViews.map((view) => view.visitorHash)).size,
        yesterdayPageviews: yesterdayViews.length,
        onlineVisitors: visitors.filter((visitor) => visitor.lastSeen >= now - 5 * 60_000).length,
        returningVisitors: visitors.filter((visitor) => visitor.totalVisits > 1).length,
      },
      daily,
      sources: countBy(visitors, (visitor) => visitor.referrer),
      devices: countBy(visitors, (visitor) => visitor.device),
      browsers: countBy(visitors, (visitor) => visitor.browser),
      recentVisitors: visitors
        .sort((left, right) => right.lastSeen - left.lastSeen)
        .slice(0, 12)
        .map((visitor) => ({
          id: visitor.visitorHash.slice(0, 8),
          firstSeen: new Date(visitor.firstSeen).toISOString(),
          lastSeen: new Date(visitor.lastSeen).toISOString(),
          totalVisits: visitor.totalVisits,
          path: visitor.path,
          referrer: visitor.referrer,
          device: visitor.device,
          browser: visitor.browser,
        })),
    };
  }
}

class PostgresAnalyticsStore {
  constructor({ databaseUrl, timeZone }) {
    this.kind = "postgres";
    this.timeZone = timeZone;
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 });
    this.schemaPromise = null;
  }

  ready() {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(`
        CREATE TABLE IF NOT EXISTS portfolio_analytics_visitors (
          visitor_hash CHAR(64) PRIMARY KEY,
          first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          total_visits INTEGER NOT NULL DEFAULT 1,
          last_path VARCHAR(160) NOT NULL DEFAULT '/',
          referrer_host VARCHAR(120) NOT NULL DEFAULT '直接访问',
          device_type VARCHAR(32) NOT NULL DEFAULT '电脑',
          browser_name VARCHAR(48) NOT NULL DEFAULT '其他浏览器'
        );
        CREATE TABLE IF NOT EXISTS portfolio_analytics_pageviews (
          id BIGSERIAL PRIMARY KEY,
          visit_hash CHAR(64) UNIQUE NOT NULL,
          visitor_hash CHAR(64) NOT NULL,
          path VARCHAR(160) NOT NULL DEFAULT '/',
          referrer_host VARCHAR(120) NOT NULL DEFAULT '直接访问',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS portfolio_analytics_pageviews_created_idx ON portfolio_analytics_pageviews (created_at DESC);
        CREATE INDEX IF NOT EXISTS portfolio_analytics_pageviews_visitor_idx ON portfolio_analytics_pageviews (visitor_hash);
        CREATE INDEX IF NOT EXISTS portfolio_analytics_visitors_last_seen_idx ON portfolio_analytics_visitors (last_seen DESC);
      `).catch((error) => {
        this.schemaPromise = null;
        throw error;
      });
    }
    return this.schemaPromise;
  }

  async trackVisit(record) {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const pageview = await client.query(`
        INSERT INTO portfolio_analytics_pageviews (visit_hash, visitor_hash, path, referrer_host)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (visit_hash) DO NOTHING
        RETURNING id
      `, [record.visitHash, record.visitorHash, record.path, record.referrer]);
      if (!pageview.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(`
        INSERT INTO portfolio_analytics_visitors
          (visitor_hash, first_seen, last_seen, total_visits, last_path, referrer_host, device_type, browser_name)
        VALUES ($1, NOW(), NOW(), 1, $2, $3, $4, $5)
        ON CONFLICT (visitor_hash) DO UPDATE SET
          last_seen = NOW(),
          total_visits = portfolio_analytics_visitors.total_visits + 1,
          last_path = EXCLUDED.last_path,
          referrer_host = CASE
            WHEN portfolio_analytics_visitors.referrer_host = '直接访问' AND EXCLUDED.referrer_host <> '直接访问'
              THEN EXCLUDED.referrer_host
            ELSE portfolio_analytics_visitors.referrer_host
          END,
          device_type = EXCLUDED.device_type,
          browser_name = EXCLUDED.browser_name
      `, [record.visitorHash, record.path, record.referrer, record.device, record.browser]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(visitorHash) {
    await this.ready();
    await this.pool.query("UPDATE portfolio_analytics_visitors SET last_seen = NOW() WHERE visitor_hash = $1", [visitorHash]);
  }

  async getStats(days) {
    await this.ready();
    const [overviewResult, dailyResult, sourceResult, deviceResult, browserResult, recentResult] = await Promise.all([
      this.pool.query(`
        SELECT
          (SELECT COUNT(*) FROM portfolio_analytics_visitors) AS total_visitors,
          (SELECT COUNT(*) FROM portfolio_analytics_pageviews) AS total_pageviews,
          (SELECT COUNT(DISTINCT visitor_hash) FROM portfolio_analytics_pageviews WHERE timezone($1, created_at)::date = timezone($1, NOW())::date) AS today_visitors,
          (SELECT COUNT(*) FROM portfolio_analytics_pageviews WHERE timezone($1, created_at)::date = timezone($1, NOW())::date) AS today_pageviews,
          (SELECT COUNT(DISTINCT visitor_hash) FROM portfolio_analytics_pageviews WHERE timezone($1, created_at)::date = timezone($1, NOW())::date - 1) AS yesterday_visitors,
          (SELECT COUNT(*) FROM portfolio_analytics_pageviews WHERE timezone($1, created_at)::date = timezone($1, NOW())::date - 1) AS yesterday_pageviews,
          (SELECT COUNT(*) FROM portfolio_analytics_visitors WHERE last_seen >= NOW() - INTERVAL '5 minutes') AS online_visitors,
          (SELECT COUNT(*) FROM portfolio_analytics_visitors WHERE total_visits > 1) AS returning_visitors
      `, [this.timeZone]),
      this.pool.query(`
        WITH days AS (
          SELECT generate_series(
            timezone($1, NOW())::date - ($2::integer - 1),
            timezone($1, NOW())::date,
            INTERVAL '1 day'
          )::date AS day
        )
        SELECT
          TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
          TO_CHAR(days.day, 'MM-DD') AS label,
          COUNT(DISTINCT pageviews.visitor_hash) AS visitors,
          COUNT(pageviews.id) AS pageviews
        FROM days
        LEFT JOIN portfolio_analytics_pageviews pageviews
          ON timezone($1, pageviews.created_at)::date = days.day
        GROUP BY days.day
        ORDER BY days.day
      `, [this.timeZone, days]),
      this.pool.query("SELECT referrer_host AS label, COUNT(*) AS count FROM portfolio_analytics_visitors GROUP BY referrer_host ORDER BY count DESC LIMIT 6"),
      this.pool.query("SELECT device_type AS label, COUNT(*) AS count FROM portfolio_analytics_visitors GROUP BY device_type ORDER BY count DESC LIMIT 6"),
      this.pool.query("SELECT browser_name AS label, COUNT(*) AS count FROM portfolio_analytics_visitors GROUP BY browser_name ORDER BY count DESC LIMIT 6"),
      this.pool.query(`
        SELECT visitor_hash, first_seen, last_seen, total_visits, last_path,
          referrer_host, device_type, browser_name
        FROM portfolio_analytics_visitors
        ORDER BY last_seen DESC
        LIMIT 12
      `),
    ]);
    const number = (value) => Number(value || 0);
    const overview = overviewResult.rows[0] || {};
    return {
      generatedAt: new Date().toISOString(),
      days,
      storage: this.kind,
      overview: {
        totalVisitors: number(overview.total_visitors),
        totalPageviews: number(overview.total_pageviews),
        todayVisitors: number(overview.today_visitors),
        todayPageviews: number(overview.today_pageviews),
        yesterdayVisitors: number(overview.yesterday_visitors),
        yesterdayPageviews: number(overview.yesterday_pageviews),
        onlineVisitors: number(overview.online_visitors),
        returningVisitors: number(overview.returning_visitors),
      },
      daily: dailyResult.rows.map((row) => ({
        ...row,
        visitors: number(row.visitors),
        pageviews: number(row.pageviews),
      })),
      sources: sourceResult.rows.map((row) => ({ label: row.label, count: number(row.count) })),
      devices: deviceResult.rows.map((row) => ({ label: row.label, count: number(row.count) })),
      browsers: browserResult.rows.map((row) => ({ label: row.label, count: number(row.count) })),
      recentVisitors: recentResult.rows.map((row) => ({
        id: String(row.visitor_hash).slice(0, 8),
        firstSeen: new Date(row.first_seen).toISOString(),
        lastSeen: new Date(row.last_seen).toISOString(),
        totalVisits: number(row.total_visits),
        path: row.last_path,
        referrer: row.referrer_host,
        device: row.device_type,
        browser: row.browser_name,
      })),
    };
  }

  async close() {
    await this.pool.end();
  }
}

function clientAttemptKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const address = forwarded || req.socket?.remoteAddress || "unknown";
  return createHash("sha256").update(address).digest("hex").slice(0, 20);
}

function isSecureRequest(req) {
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

export function createAnalyticsService(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? "";
  const timeZone = options.timeZone ?? process.env.ANALYTICS_TIME_ZONE ?? "Asia/Shanghai";
  const sessionSecret = options.sessionSecret || process.env.ADMIN_SESSION_SECRET || adminPassword || randomBytes(32).toString("hex");
  const visitorSecret = options.visitorSecret || process.env.ANALYTICS_VISITOR_SECRET || sessionSecret;
  const store = databaseUrl
    ? new PostgresAnalyticsStore({ databaseUrl, timeZone })
    : new MemoryAnalyticsStore({ timeZone });
  const attempts = new Map();

  const visitorHash = (visitorId) => createHmac("sha256", visitorSecret).update(visitorId).digest("hex");

  function createSessionCookie(req) {
    const expires = Date.now() + SESSION_SECONDS * 1000;
    const signature = createHmac("sha256", sessionSecret).update(`admin:${expires}`).digest("base64url");
    const secure = isSecureRequest(req) ? "; Secure" : "";
    return `${ADMIN_COOKIE}=${expires}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`;
  }

  function clearSessionCookie(req) {
    const secure = isSecureRequest(req) ? "; Secure" : "";
    return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }

  function isAdmin(req) {
    const token = parseCookies(req)[ADMIN_COOKIE] || "";
    const separator = token.indexOf(".");
    if (separator < 1) return false;
    const expires = Number(token.slice(0, separator));
    const signature = token.slice(separator + 1);
    if (!Number.isFinite(expires) || expires <= Date.now() || !signature) return false;
    const expected = createHmac("sha256", sessionSecret).update(`admin:${expires}`).digest("base64url");
    return safeEqualText(signature, expected);
  }

  function login(req, password) {
    if (!adminPassword) {
      return { ok: false, status: 503, error: "后台密码尚未配置，请先在 Render 中设置 ADMIN_PASSWORD。" };
    }
    const key = clientAttemptKey(req);
    const state = attempts.get(key) || { failures: 0, lockedUntil: 0 };
    if (state.lockedUntil > Date.now()) {
      return { ok: false, status: 429, error: "密码尝试次数过多，请 15 分钟后再试。" };
    }
    if (!safeEqualText(password, adminPassword)) {
      state.failures += 1;
      if (state.failures >= 5) state.lockedUntil = Date.now() + 15 * 60_000;
      attempts.set(key, state);
      return { ok: false, status: 401, error: "后台密码不正确。" };
    }
    attempts.delete(key);
    return { ok: true, cookie: createSessionCookie(req) };
  }

  async function trackVisit(body, req) {
    const visitorId = normalizeVisitorId(body.visitorId);
    const visitId = normalizeVisitorId(body.visitId);
    const metadata = visitorMetadata(body, req);
    if (!visitorId || !visitId || metadata.isBot) return { tracked: false };
    const tracked = await store.trackVisit({
      visitorHash: visitorHash(visitorId),
      visitHash: visitorHash(`visit:${visitId}`),
      path: normalizePath(body.path),
      referrer: metadata.referrer,
      device: metadata.device,
      browser: metadata.browser,
    });
    return { tracked, storage: store.kind };
  }

  async function heartbeat(body, req) {
    const visitorId = normalizeVisitorId(body.visitorId);
    if (!visitorId || BOT_RE.test(cleanText(req.headers["user-agent"], 260))) return { tracked: false };
    await store.heartbeat(visitorHash(visitorId));
    return { tracked: true };
  }

  return {
    store,
    timeZone,
    get configured() { return Boolean(adminPassword); },
    get storage() { return store.kind; },
    ready: () => store.ready(),
    isAdmin,
    login,
    clearSessionCookie,
    trackVisit,
    heartbeat,
    getStats: (days) => store.getStats(Math.max(7, Math.min(30, Number(days) || 14))),
  };
}

