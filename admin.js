if (location.hostname === "xuxudong31.github.io") {
  location.replace("https://ethen-portfolio-analytics-xuxudong31.onrender.com/admin");
}

const $ = (selector) => document.querySelector(selector);
const state = { authenticated: false, loading: false, stats: null, timer: 0 };

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin(session = {}) {
  window.clearInterval(state.timer);
  state.timer = 0;
  state.authenticated = false;
  $("#bootState").hidden = true;
  $("#dashboardView").hidden = true;
  $("#loginView").hidden = false;
  $("#setupNote").hidden = session.configured !== false;
  $("#adminPassword").focus();
}

function showDashboard() {
  state.authenticated = true;
  $("#bootState").hidden = true;
  $("#loginView").hidden = true;
  $("#dashboardView").hidden = false;
}

function startAutoRefresh() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(() => {
    if (document.visibilityState === "visible") loadStats();
  }, 60_000);
}

function renderRankList(container, items) {
  container.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂时还没有数据";
    container.append(empty);
    return;
  }
  const maximum = Math.max(...items.map((item) => Number(item.count) || 0), 1);
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "rank-row";
    const labelLine = document.createElement("p");
    const label = document.createElement("span");
    const count = document.createElement("span");
    label.textContent = item.label || "未知";
    count.textContent = formatNumber(item.count);
    labelLine.append(label, count);
    const bar = document.createElement("div");
    bar.className = "rank-bar";
    const progress = document.createElement("i");
    progress.style.width = `${Math.max(3, (Number(item.count) / maximum) * 100)}%`;
    bar.append(progress);
    row.append(labelLine, bar);
    container.append(row);
  });
}

function renderRecentVisitors(items) {
  const container = $("#recentVisitorList");
  container.replaceChildren();
  if (!items?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "出现访问后会显示在这里";
    container.append(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = "recent-row";
    const identity = document.createElement("strong");
    identity.textContent = `访客 ${item.id}`;
    const environment = document.createElement("span");
    environment.textContent = `${item.device} · ${item.browser} · ${item.referrer}`;
    const detail = document.createElement("small");
    detail.textContent = `${formatNumber(item.totalVisits)} 次浏览 · 最后访问 ${formatTime(item.lastSeen)}`;
    row.append(identity, environment, detail);
    container.append(row);
  });
}

function drawTrendChart(items) {
  const canvas = $("#trendChart");
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const padding = { top: 16, right: 16, bottom: 30, left: 34 };
  const chartWidth = Math.max(1, width - padding.left - padding.right);
  const chartHeight = Math.max(1, height - padding.top - padding.bottom);
  const values = items.flatMap((item) => [Number(item.visitors) || 0, Number(item.pageviews) || 0]);
  const maxValue = Math.max(4, ...values);
  context.clearRect(0, 0, width, height);
  context.font = "10px ui-monospace, monospace";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let line = 0; line <= 4; line += 1) {
    const y = padding.top + (chartHeight / 4) * line;
    context.strokeStyle = "rgba(255,255,255,.07)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillStyle = "#73798d";
    context.fillText(String(Math.round(maxValue * (1 - line / 4))), padding.left - 8, y);
  }
  if (!items.length) return;
  const pointX = (index) => padding.left + (items.length === 1 ? chartWidth / 2 : (index / (items.length - 1)) * chartWidth);
  const pointY = (value) => padding.top + chartHeight - (Number(value || 0) / maxValue) * chartHeight;
  const drawLine = (key, color, fill) => {
    const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
    gradient.addColorStop(0, fill);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.beginPath();
    items.forEach((item, index) => {
      const x = pointX(index);
      const y = pointY(item[key]);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.lineTo(pointX(items.length - 1), padding.top + chartHeight);
    context.lineTo(pointX(0), padding.top + chartHeight);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();
    context.beginPath();
    items.forEach((item, index) => {
      const x = pointX(index);
      const y = pointY(item[key]);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.stroke();
  };
  drawLine("pageviews", "#42d7ff", "rgba(66,215,255,.12)");
  drawLine("visitors", "#5368ff", "rgba(83,104,255,.2)");
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillStyle = "#73798d";
  const labelStep = Math.max(1, Math.ceil(items.length / 7));
  items.forEach((item, index) => {
    if (index % labelStep === 0 || index === items.length - 1) {
      context.fillText(item.label, pointX(index), height - 19);
    }
  });
}

function renderStats(data) {
  state.stats = data;
  const { overview } = data;
  $("#todayVisitors").textContent = formatNumber(overview.todayVisitors);
  $("#todayPageviews").textContent = formatNumber(overview.todayPageviews);
  $("#onlineVisitors").textContent = formatNumber(overview.onlineVisitors);
  $("#totalVisitors").textContent = formatNumber(overview.totalVisitors);
  $("#totalPageviews").textContent = formatNumber(overview.totalPageviews);
  $("#todayVisitorsCompare").textContent = `昨日 ${formatNumber(overview.yesterdayVisitors)} 人`;
  $("#todayPageviewsCompare").textContent = `昨日 ${formatNumber(overview.yesterdayPageviews)} 次`;
  $("#returningVisitors").textContent = formatNumber(overview.returningVisitors);
  $("#returningRate").textContent = overview.totalVisitors
    ? `${Math.round((overview.returningVisitors / overview.totalVisitors) * 100)}%`
    : "0%";
  $("#lastUpdated").textContent = `更新于 ${formatTime(data.generatedAt)} · 每分钟自动刷新`;
  const persistent = data.storage === "postgres";
  $("#storageBadge").textContent = persistent ? "PostgreSQL 持久存储" : "临时内存存储";
  $("#storageBadge").classList.toggle("memory", !persistent);
  $("#databaseWarning").hidden = persistent;
  renderRankList($("#sourceList"), data.sources);
  renderRankList($("#deviceList"), data.devices);
  renderRankList($("#browserList"), data.browsers);
  renderRecentVisitors(data.recentVisitors);
  requestAnimationFrame(() => drawTrendChart(data.daily || []));
}

async function loadStats() {
  if (state.loading || !state.authenticated) return;
  state.loading = true;
  $("#refreshButton").disabled = true;
  try {
    const data = await api(`/api/admin/stats?days=${encodeURIComponent($("#rangeSelect").value)}`);
    renderStats(data);
  } catch (error) {
    if (error.status === 401) showLogin({ configured: true });
    else $("#lastUpdated").textContent = error.message;
  } finally {
    state.loading = false;
    $("#refreshButton").disabled = false;
  }
}

async function boot() {
  try {
    const session = await api("/api/admin/session");
    if (session.authenticated) {
      showDashboard();
      await loadStats();
      startAutoRefresh();
    } else showLogin(session);
  } catch (error) {
    showLogin({ configured: true });
    $("#loginError").textContent = `后台连接失败：${error.message}`;
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("#adminPassword").value;
  $("#loginError").textContent = "";
  $("#loginButton").disabled = true;
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
    $("#adminPassword").value = "";
    showDashboard();
    await loadStats();
    startAutoRefresh();
  } catch (error) {
    $("#loginError").textContent = error.message;
  } finally {
    $("#loginButton").disabled = false;
  }
});

$("#togglePassword").addEventListener("click", () => {
  const input = $("#adminPassword");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  $("#togglePassword").textContent = visible ? "显示" : "隐藏";
});
$("#refreshButton").addEventListener("click", loadStats);
$("#rangeSelect").addEventListener("change", loadStats);
$("#logoutButton").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST", body: "{}" }).catch(() => {});
  window.clearInterval(state.timer);
  showLogin({ configured: true });
});
window.addEventListener("resize", () => {
  if (state.stats) drawTrendChart(state.stats.daily || []);
});

boot();

