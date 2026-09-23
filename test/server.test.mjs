import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAnalyticsService } from "../analytics.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(overrides = {}) {
  return {
    headers: {
      host: "127.0.0.1:4173",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      "x-forwarded-proto": "https",
      ...overrides,
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
}

test("匿名访客按浏览器 ID 去重，重试不会重复增加浏览量", async () => {
  const analytics = createAnalyticsService({
    adminPassword: "test-admin-password",
    sessionSecret: "test-session-secret",
    visitorSecret: "test-visitor-secret",
    timeZone: "Asia/Shanghai",
  });
  const desktop = request();
  const first = {
    visitorId: "visitor_1234567890abcdef",
    visitId: "visit_1234567890abcdef",
    path: "/Personal-Portfolio/",
    referrer: "https://example.com/design",
    currentHost: "xuxudong31.github.io",
  };
  assert.equal((await analytics.trackVisit(first, desktop)).tracked, true);
  assert.equal((await analytics.trackVisit(first, desktop)).tracked, false);
  assert.equal((await analytics.trackVisit({ ...first, visitId: "visit_abcdefghijklmnop" }, desktop)).tracked, true);
  assert.equal((await analytics.trackVisit({
    ...first,
    visitorId: "visitor_second_123456789",
    visitId: "visit_second_123456789",
    referrer: "",
  }, request({ "user-agent": "Mozilla/5.0 (iPhone) AppleWebKit/605.1 Safari/605.1" }))).tracked, true);

  const stats = await analytics.getStats(7);
  assert.equal(stats.storage, "memory");
  assert.equal(stats.overview.totalVisitors, 2);
  assert.equal(stats.overview.totalPageviews, 3);
  assert.equal(stats.overview.returningVisitors, 1);
  assert.equal(stats.daily.length, 7);
  assert.ok(stats.sources.some((item) => item.label === "example.com"));
  assert.ok(stats.devices.some((item) => item.label === "手机"));
});

test("同站 referrer 不会被误记成外部来源", async () => {
  const analytics = createAnalyticsService({ visitorSecret: "source-test" });
  await analytics.trackVisit({
    visitorId: "visitor_referrer_123456",
    visitId: "visit_referrer_12345678",
    path: "/Personal-Portfolio/",
    referrer: "https://xuxudong31.github.io/Personal-Portfolio/",
    currentHost: "xuxudong31.github.io",
  }, request());
  const stats = await analytics.getStats(7);
  assert.deepEqual(stats.sources, [{ label: "直接访问", count: 1 }]);
});

test("后台密码会签发安全会话 Cookie", () => {
  const analytics = createAnalyticsService({
    adminPassword: "correct-password",
    sessionSecret: "cookie-secret",
    visitorSecret: "visitor-secret",
  });
  assert.equal(analytics.login(request(), "wrong-password").status, 401);
  const login = analytics.login(request(), "correct-password");
  assert.equal(login.ok, true);
  assert.match(login.cookie, /^ethen_portfolio_admin=/);
  assert.match(login.cookie, /HttpOnly/);
  assert.match(login.cookie, /SameSite=Strict/);
  assert.match(login.cookie, /Secure/);
  const cookie = login.cookie.split(";", 1)[0];
  assert.equal(analytics.isAdmin(request({ cookie })), true);
});

test("Node 服务提供跨域统计与受保护后台，同时不公开服务端源码", async () => {
  const previous = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
    ANALYTICS_VISITOR_SECRET: process.env.ANALYTICS_VISITOR_SECRET,
    ANALYTICS_ALLOWED_ORIGINS: process.env.ANALYTICS_ALLOWED_ORIGINS,
  };
  process.env.ADMIN_PASSWORD = "integration-admin-password";
  process.env.ADMIN_SESSION_SECRET = "integration-session-secret";
  process.env.ANALYTICS_VISITOR_SECRET = "integration-visitor-secret";
  process.env.ANALYTICS_ALLOWED_ORIGINS = "https://xuxudong31.github.io";
  const module = await import(`../server.mjs?test=${Date.now()}`);
  const server = module.server;
  const address = await listen(server);
  const base = `http://127.0.0.1:${address.port}`;
  const origin = "https://xuxudong31.github.io";
  try {
    const [health, home, admin, rive, source, packageFile] = await Promise.all([
      fetch(`${base}/api/health`),
      fetch(`${base}/`),
      fetch(`${base}/admin/`),
      fetch(`${base}/assets/untitled.riv`, { method: "HEAD" }),
      fetch(`${base}/server.mjs`),
      fetch(`${base}/package.json`),
    ]);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).analytics.adminConfigured, true);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Ethen个人作品集未完成版/);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /作品集数据后台/);
    assert.equal(rive.status, 200);
    assert.match(rive.headers.get("content-type") || "", /octet-stream/);
    assert.equal(source.status, 404);
    assert.equal(packageFile.status, 404);

    const preflight = await fetch(`${base}/api/analytics/visit`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("vary") || "", /Origin/);

    const rejected = await fetch(`${base}/api/analytics/visit`, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId: "visitor_rejected_123456", visitId: "visit_rejected_12345678" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);

    for (const visitId of ["visit_integration_123456", "visit_integration_abcdef"]) {
      const visit = await fetch(`${base}/api/analytics/visit`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 Chrome/140 Safari/537.36" },
        body: JSON.stringify({
          visitorId: "visitor_integration_123456",
          visitId,
          path: "/Personal-Portfolio/",
          referrer: "",
          currentHost: "xuxudong31.github.io",
        }),
      });
      assert.equal(visit.status, 202);
      assert.equal(visit.headers.get("access-control-allow-origin"), origin);
    }

    const unauthorized = await fetch(`${base}/api/admin/stats`, { headers: { Origin: origin } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);

    const login = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify({ password: "integration-admin-password" }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /^ethen_portfolio_admin=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(";", 1)[0];

    const statsResponse = await fetch(`${base}/api/admin/stats?days=7`, { headers: { Cookie: cookie } });
    const stats = await statsResponse.json();
    assert.equal(statsResponse.status, 200);
    assert.equal(stats.overview.totalVisitors, 1);
    assert.equal(stats.overview.totalPageviews, 2);
    assert.equal(stats.overview.returningVisitors, 1);
    assert.equal(stats.daily.length, 7);

    const originalTrackVisit = module.analytics.store.trackVisit.bind(module.analytics.store);
    module.analytics.store.trackVisit = async () => { throw new Error("temporary database failure"); };
    const failedWrite = await fetch(`${base}/api/analytics/visit`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 Chrome/140 Safari/537.36" },
      body: JSON.stringify({
        visitorId: "visitor_failure_12345678",
        visitId: "visit_failure_1234567890",
        path: "/Personal-Portfolio/",
        referrer: "",
        currentHost: "xuxudong31.github.io",
      }),
    });
    module.analytics.store.trackVisit = originalTrackVisit;
    assert.equal(failedWrite.status, 503);
    assert.equal(failedWrite.headers.get("access-control-allow-origin"), origin);
  } finally {
    await close(server);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("前端埋点、后台页面和 Render Blueprint 已完整连接", async () => {
  const [home, tracker, admin, analyticsSource, render] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/analytics-client.js", import.meta.url), "utf8"),
    readFile(new URL("../admin.html", import.meta.url), "utf8"),
    readFile(new URL("../analytics.mjs", import.meta.url), "utf8"),
    readFile(new URL("../render.yaml", import.meta.url), "utf8"),
  ]);
  assert.match(home, /assets\/analytics-client\.js/);
  assert.match(tracker, /ethen_portfolio\.analytics\.visitor\.v1/);
  assert.match(tracker, /ethen-portfolio-analytics-xuxudong31\.onrender\.com/);
  assert.match(tracker, /credentials:\s*"omit"/);
  assert.match(admin, /id="totalVisitors"/);
  assert.match(admin, /id="trendChart"/);
  assert.match(admin, /ethen-portfolio-analytics-xuxudong31\.onrender\.com\/admin/);
  assert.match(analyticsSource, /portfolio_analytics_visitors/);
  assert.match(analyticsSource, /portfolio_analytics_pageviews/);
  assert.match(render, /ADMIN_PASSWORD/);
  assert.match(render, /fromDatabase/);
});

