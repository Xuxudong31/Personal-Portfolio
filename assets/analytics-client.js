(() => {
  "use strict";

  const REMOTE_ANALYTICS_ORIGIN = "https://ethen-portfolio-analytics-xuxudong31.onrender.com";
  const VISITOR_STORAGE_KEY = "ethen_portfolio.analytics.visitor.v1";
  const localHost = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  if (!/^https?:$/.test(location.protocol) || (localHost && location.port !== "4173")) return;

  const sameBackend = localHost || location.hostname === "ethen-portfolio-analytics-xuxudong31.onrender.com";
  const apiOrigin = sameBackend ? "" : REMOTE_ANALYTICS_ORIGIN;

  function randomId(prefix) {
    const value = typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}_${value}`;
  }

  function getVisitorId() {
    try {
      const existing = localStorage.getItem(VISITOR_STORAGE_KEY);
      if (existing && /^[a-zA-Z0-9_-]{16,80}$/.test(existing)) return existing;
      const visitorId = randomId("visitor");
      localStorage.setItem(VISITOR_STORAGE_KEY, visitorId);
      return visitorId;
    } catch (_) {
      return randomId("visitor_session");
    }
  }

  const visitorId = getVisitorId();
  const visitId = randomId("visit");

  async function post(path, payload) {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId, ...payload }),
    });
    if (!response.ok) throw new Error(`Analytics ${response.status}`);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function recordVisit() {
    const payload = {
      visitId,
      path: location.pathname.slice(0, 160),
      referrer: document.referrer,
      currentHost: location.hostname,
    };
    const retryDelays = [0, 5_000, 20_000];
    for (const wait of retryDelays) {
      if (wait) await delay(wait);
      try {
        await post("/api/analytics/visit", payload);
        return;
      } catch (_) {}
    }
  }

  function start() {
    recordVisit();
    const heartbeat = () => {
      if (document.visibilityState === "visible") {
        post("/api/analytics/heartbeat", {}).catch(() => {});
      }
    };
    const timer = window.setInterval(heartbeat, 60_000);
    document.addEventListener("visibilitychange", heartbeat);
    window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
  }

  if (document.visibilityState === "visible") start();
  else document.addEventListener("visibilitychange", start, { once: true });
})();

