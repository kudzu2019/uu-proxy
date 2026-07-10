// UU Proxy — popup logic (v2: typed rules, builtin, 4 tabs)

const STORAGE_KEY = "uuProxyState";
const AUTH_KEY = "uuAuth";
const WORKER = "https://proxy-soft.19920806.xyz";
const DEFAULTS = {
  proxies: [], currentProxyId: null, enabled: false, mode: "all",
  rules: [], testUrl: "https://ip.cn/", cnDirect: true, builtinRules: null
};

let state = null;
let editingId = null;
const testingIds = new Set();
let ruleFilter = "all", ruleSearch = "";
let sysFilter = "all";
const $ = (s) => document.querySelector(s);

/* ---------------- storage ---------------- */
function loadState() {
  return new Promise((res) => chrome.storage.local.get(STORAGE_KEY, (r) => res(Object.assign({}, DEFAULTS, r[STORAGE_KEY] || {}))));
}
function persist(sync = true) {
  return new Promise((res) => chrome.storage.local.set({ [STORAGE_KEY]: state }, () => { if (sync) scheduleSync(); res(); }));
}
function persistNoSync() { return persist(false); }
function uid() { return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* rules -> [{v,on,type}] */
function normRules() {
  state.rules = (state.rules || []).map((r) => {
    if (typeof r === "string") return { v: r, on: true, type: "proxy" };
    return { v: (r.v || ""), on: r.on !== false, type: r.type === "direct" ? "direct" : "proxy" };
  }).filter((r) => (r.v || "").trim());
}
/* builtin -> {version,updatedAt,proxy:[{v,on}],direct:[{v,on}]} */
function normBuiltin(b) {
  if (!b) return null;
  const conv = (arr) => (arr || []).map((r) => (typeof r === "string" ? { v: r, on: true } : { v: (r.v || ""), on: r.on !== false })).filter((r) => (r.v || "").trim());
  return { version: b.version || 0, updatedAt: b.updatedAt || 0, proxy: conv(b.proxy), direct: conv(b.direct) };
}

/* ---------------- toast ---------------- */
function toast(msg, opts) {
  opts = opts || {};
  const t = document.createElement("div");
  t.className = "uu-toast" + (opts.kind ? " " + opts.kind : "");
  t.textContent = msg;
  $("#toastLayer").appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 260); }, opts.duration || 1600);
}
function confirmDialog(msg) {
  return new Promise((resolve) => {
    $("#confirmMsg").textContent = msg;
    $("#confirmOverlay").classList.add("show");
    const done = (v) => { $("#confirmOverlay").classList.remove("show"); $("#confirmYes").onclick = null; $("#confirmNo").onclick = null; resolve(v); };
    $("#confirmYes").onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
  });
}
function infoDialog(msg) {
  return new Promise((resolve) => {
    $("#confirmMsg").textContent = msg;
    $("#confirmNo").style.display = "none";
    $("#confirmYes").textContent = "知道了";
    $("#confirmOverlay").classList.add("show");
    const done = () => { $("#confirmOverlay").classList.remove("show"); $("#confirmYes").onclick = null; $("#confirmNo").style.display = ""; $("#confirmYes").textContent = "确定"; resolve(); };
    $("#confirmYes").onclick = done;
  });
}

/* ---------------- admin (system-rule management) ---------------- */
let adminKey = null;
function loadAdmin() { return new Promise((r) => chrome.storage.local.get("uuAdminKey", (d) => r(d.uuAdminKey || null))); }
function saveAdmin() { return new Promise((r) => chrome.storage.local.set({ uuAdminKey: adminKey }, r)); }
function clearAdmin() { adminKey = null; return new Promise((r) => chrome.storage.local.remove("uuAdminKey", r)); }
async function adminFetch(path, body) {
  const res = await fetch(WORKER + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey || "" }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) {}
  if (res.status === 403) throw new Error("管理密钥无效");
  if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
  return data;
}
function openAdmin() {
  if (adminKey) { switchTab("system"); toast("已在管理模式，可在系统规则页添加"); return; }
  $("#adminKeyInput").value = ""; $("#adminOverlay").classList.add("show"); setTimeout(() => $("#adminKeyInput").focus(), 40);
}
function closeAdmin() { $("#adminOverlay").classList.remove("show"); }
async function submitAdmin() {
  const k = $("#adminKeyInput").value.trim();
  if (!k) { toast("请输入管理密钥", { kind: "bad" }); return; }
  const btn = $("#adminSubmit"); btn.disabled = true;
  try {
    const res = await fetch(WORKER + "/builtin/verify", { method: "POST", headers: { "X-Admin-Key": k } });
    if (res.status !== 200) throw new Error("密钥无效");
    adminKey = k; await saveAdmin();
    closeAdmin(); renderAccount(); renderSystemTable(); switchTab("system");
    toast("管理已解锁", { kind: "ok" });
  } catch (e) { toast("解锁失败 · " + (e.message || ""), { kind: "bad" }); }
  finally { btn.disabled = false; }
}
async function exitAdmin() { await clearAdmin(); renderAccount(); renderSystemTable(); toast("已退出管理"); }


/* ---------------- custom dropdown (themed) ---------------- */
function enhanceSelect(sel) {
  const wrap = document.createElement("div");
  wrap.className = "uu-dd" + (sel.classList.contains("uu-mini-select") ? " mini" : " wide");
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "uu-dd-btn";
  const lab = document.createElement("span"); lab.className = "uu-dd-lab";
  const car = document.createElement("span"); car.className = "uu-dd-caret";
  btn.appendChild(lab); btn.appendChild(car);
  const menu = document.createElement("div"); menu.className = "uu-dd-menu";
  Array.from(sel.options).forEach((o) => {
    const it = document.createElement("div");
    it.className = "uu-dd-opt"; it.textContent = o.textContent; it.dataset.value = o.value;
    it.addEventListener("click", () => { setVal(o.value); wrap.classList.remove("open"); });
    menu.appendChild(it);
  });
  function setVal(v) { if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); } sync(); }
  function sync() {
    const cur = sel.options[sel.selectedIndex];
    lab.textContent = cur ? cur.textContent : "";
    Array.from(menu.children).forEach((c) => c.classList.toggle("sel", c.dataset.value === sel.value));
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !wrap.classList.contains("open");
    document.querySelectorAll(".uu-dd.open").forEach((d) => d.classList.remove("open"));
    if (willOpen) wrap.classList.add("open");
  });
  sel.classList.add("uu-dd-native");
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(btn); wrap.appendChild(menu); wrap.appendChild(sel);
  sel._dd = { sync };
  sync();
}
function initSelects() {
  document.querySelectorAll("select").forEach(enhanceSelect);
  document.addEventListener("click", () => document.querySelectorAll(".uu-dd.open").forEach((d) => d.classList.remove("open")));
}
function refreshSelect(id) { const el = $("#" + id); if (el && el._dd) el._dd.sync(); }


const TAB_ORDER = ["proxies", "custom", "system", "settings"];
function switchTab(tab) {
  document.querySelectorAll(".uu-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".uu-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + tab));
  $("#tabSlider").style.transform = "translateX(" + (Math.max(0, TAB_ORDER.indexOf(tab)) * 100) + "%)";
  if (tab === "custom") renderCustomTable();
  if (tab === "system") renderSystemTable();
  if (tab === "settings") renderSettings();
}

/* ---------------- render ---------------- */
function render() {
  $("#masterToggle").checked = !!state.enabled;
  renderFooter();
  renderProxies();
  if ($("#pane-custom").classList.contains("active")) renderCustomTable();
  if ($("#pane-system").classList.contains("active")) renderSystemTable();
  if ($("#pane-settings").classList.contains("active")) renderSettings();
}
function renderFooter() {
  document.querySelectorAll('input[name="mode"]').forEach((r) => (r.checked = r.value === state.mode));
  const cur = state.proxies.find((p) => p.id === state.currentProxyId);
  const foot = $("#footer");
  if (state.enabled && cur) { $("#footStatus").textContent = "已开启 · " + cur.name; foot.classList.add("on"); }
  else { $("#footStatus").textContent = state.enabled ? "已开启 · 未选择代理" : "已关闭 · 直连"; foot.classList.remove("on"); }
}
function renderProxies() {
  const list = $("#proxyList");
  if (!state.proxies.length) { list.innerHTML = '<div class="uu-empty"><span class="em">🛰️</span>还没有代理，点击上方「添加代理」</div>'; return; }
  list.innerHTML = state.proxies.map((p) => {
    const active = p.id === state.currentProxyId;
    const hasAuth = !!(p.username && p.username.length);
    let sp = '<span class="uu-speed idle">未测速</span>';
    if (testingIds.has(p.id)) sp = '<span class="uu-speed testing">测速中…</span>';
    else if (p.speed) sp = p.speed.status === "success" ? '<span class="uu-speed ok">● ' + p.speed.latency + 'ms</span>' : '<span class="uu-speed bad">● 失败</span>';
    return '<div class="uu-card' + (active ? " active" : "") + '" data-id="' + p.id + '">'
      + '<div class="uu-card-top"><div class="uu-card-name"><span class="uu-proto">' + esc(p.protocol) + '</span><span class="txt">' + esc(p.name) + '</span></div>'
      + (active ? '<span class="uu-badge-active">当前使用</span>' : '') + '</div>'
      + '<div class="uu-card-sub"><span class="uu-meta">' + esc(p.host) + ':' + esc(p.port) + '</span><span class="uu-dot">·</span>' + (hasAuth ? "🔐" : "🔓") + '<span class="uu-dot">·</span>' + sp + '</div>'
      + '<div class="uu-card-ops"><div class="uu-op" data-act="test" data-id="' + p.id + '">测速</div><div class="uu-op" data-act="edit" data-id="' + p.id + '">编辑</div><div class="uu-op del" data-act="del" data-id="' + p.id + '">删除</div></div>'
      + '</div>';
  }).join("");
}

function rowHtml(v, type, on, ds) {
  return '<div class="uu-trow' + (on ? "" : " off") + '">'
    + '<div class="uu-td-v" title="点击复制" data-copy="' + esc(v) + '">' + esc(v) + '</div>'
    + '<div class="uu-chip ' + type + '">' + (type === "proxy" ? "代理" : "直连") + '</div>'
    + '<button class="uu-tbtn toggle" ' + ds + '>' + (on ? "禁用" : "启用") + '</button>'
    + '<button class="uu-tbtn del" ' + ds + '>删除</button>'
    + '</div>';
}
function tableHead() { return '<div class="uu-thead"><div>域名</div><div>类型</div><div>状态</div><div>删除</div></div>'; }

function renderCustomTable() {
  normRules();
  const wrap = $("#customTableWrap");
  const q = ruleSearch.trim().toLowerCase();
  const items = state.rules.map((r, i) => ({ r, i }))
    .filter(({ r }) => (ruleFilter === "all" ? true : ruleFilter === "on" ? r.on : !r.on))
    .filter(({ r }) => (q ? r.v.toLowerCase().indexOf(q) !== -1 : true));
  if (!state.rules.length) { wrap.innerHTML = '<div class="uu-table-empty">暂无自定义规则</div>'; return; }
  if (!items.length) { wrap.innerHTML = '<div class="uu-table-empty">没有匹配的规则</div>'; return; }
  wrap.innerHTML = tableHead() + items.map(({ r, i }) => rowHtml(r.v, r.type, r.on, 'data-i="' + i + '"')).join("");
}

function renderSystemTable() {
  const unlocked = !!adminKey;
  const bar = $("#sysAdminBar"); if (bar) bar.style.display = unlocked ? "" : "none";
  const ex = $("#sysAdminExit"); if (ex) ex.style.display = unlocked ? "" : "none";
  const wrap = $("#systemTableWrap");
  const b = state.builtinRules;
  if (!b) { wrap.innerHTML = '<div class="uu-table-empty">未加载内置规则，点「同步内置规则」</div>'; return; }
  let rows = [];
  b.proxy.forEach((r, i) => rows.push({ v: r.v, type: "proxy", on: r.on, src: "proxy", i }));
  b.direct.forEach((r, i) => rows.push({ v: r.v, type: "direct", on: r.on, src: "direct", i }));
  rows = rows.filter((r) => (sysFilter === "all" ? true : sysFilter === "on" ? r.on : !r.on));
  if (!rows.length) { wrap.innerHTML = '<div class="uu-table-empty">该筛选下没有规则</div>'; return; }
  wrap.innerHTML = tableHead() + rows.map((r) => rowHtml(r.v, r.type, r.on, 'data-src="' + r.src + '" data-i="' + r.i + '"')).join("");
}

function renderSettings() {
  renderAccount();
  $("#fTestUrl").value = state.testUrl || DEFAULTS.testUrl;
  $("#cnDirectToggle").checked = state.cnDirect !== false;
  const b = state.builtinRules;
  $("#builtinInfo").textContent = b ? ("内置版本 v" + b.version + " · 代理 " + b.proxy.length + " 条 · 直连 " + b.direct.length + " 条") : "未加载内置规则";
}

/* ---------------- proxy modal ---------------- */
function openProxyModal(proxy) {
  editingId = proxy ? proxy.id : null;
  $("#proxyModalTitle").textContent = proxy ? "编辑代理" : "添加代理";
  $("#parseInput").value = "";
  $("#fName").value = proxy ? proxy.name : "";
  $("#fProtocol").value = proxy ? proxy.protocol : "http";
  refreshSelect("fProtocol");
  $("#fHost").value = proxy ? proxy.host : "";
  $("#fPort").value = proxy ? proxy.port : "";
  $("#fUser").value = proxy ? (proxy.username || "") : "";
  $("#fPass").value = proxy ? (proxy.password || "") : "";
  $("#proxyOverlay").classList.add("show");
  setTimeout(() => $("#fName").focus(), 40);
}
function closeProxyModal() { $("#proxyOverlay").classList.remove("show"); }

function isHostPort(s) { const p = s.split(":"); return p.length === 2 && /^\d{1,5}$/.test(p[1].trim()); }
function parseProxy(input) {
  input = (input || "").trim(); if (!input) return null;
  let protocol = null;
  const scheme = input.match(/^(https?|socks5|socks)\s*:\/\//i);
  if (scheme) { protocol = scheme[1].toLowerCase(); if (protocol === "socks") protocol = "socks5"; input = input.slice(scheme[0].length).trim(); }
  let host = "", port = "", username = "", password = "";
  if (input.indexOf("##") !== -1) { const p = input.split("##").map((s) => s.trim()); const hp = p[0].split(":"); host = hp[0]; port = hp[1] || ""; username = p[1] || ""; password = p[2] || ""; }
  else if (input.indexOf(",") !== -1) { const p = input.split(",").map((s) => s.trim()); host = p[0]; port = p[1] || ""; username = p[2] || ""; password = p[3] || ""; }
  else if (input.indexOf("@") !== -1) {
    const seg = input.split("@").map((s) => s.trim()); const a = seg[0], b = seg[1] || "";
    let hostPart, authPart;
    if (isHostPort(b) && !isHostPort(a)) { hostPart = b; authPart = a; } else if (isHostPort(a) && !isHostPort(b)) { hostPart = a; authPart = b; } else { hostPart = b; authPart = a; }
    const hp = hostPart.split(":"); host = hp[0]; port = hp[1] || ""; const ap = authPart.split(":"); username = ap[0] || ""; password = ap[1] || "";
  } else { const p = input.split(":").map((s) => s.trim()); host = p[0]; port = p[1] || ""; username = p[2] || ""; password = p[3] || ""; }
  if (!host || !/^\d{1,5}$/.test(port)) return null;
  return { protocol: protocol || "http", host, port: parseInt(port, 10), username, password };
}
function doParse() {
  const parsed = parseProxy($("#parseInput").value);
  if (!parsed) { toast("无法解析，请检查格式", { kind: "bad" }); return; }
  $("#fHost").value = parsed.host; $("#fPort").value = parsed.port; $("#fUser").value = parsed.username; $("#fPass").value = parsed.password; $("#fProtocol").value = parsed.protocol; refreshSelect("fProtocol");
  if (!$("#fName").value.trim()) $("#fName").value = parsed.host + ":" + parsed.port;
  toast("解析成功");
}
function normalizeHostField() {
  let v = $("#fHost").value.trim(); if (!v) return;
  let scheme = null;
  const m = v.match(/^\s*(https?|socks5|socks):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); if (scheme === "socks") scheme = "socks5"; v = v.slice(m[0].length); }
  v = v.split(/[/?#]/)[0].trim();
  let host = v, port = "";
  const idx = v.lastIndexOf(":");
  if (idx > -1) { const maybe = v.slice(idx + 1); if (/^\d{1,5}$/.test(maybe)) { host = v.slice(0, idx); port = maybe; } }
  $("#fHost").value = host;
  if (port && !$("#fPort").value.trim()) $("#fPort").value = port;
  if (scheme) $("#fProtocol").value = scheme;
}

async function saveProxy() {
  normalizeHostField();
  const name = $("#fName").value.trim(), host = $("#fHost").value.trim(), portRaw = $("#fPort").value.trim();
  const protocol = $("#fProtocol").value, username = $("#fUser").value.trim(), password = $("#fPass").value;
  if (!host) { toast("请填写 IP / 域名", { kind: "bad" }); return; }
  if (!/^\d{1,5}$/.test(portRaw) || +portRaw < 1 || +portRaw > 65535) { toast("请填写有效端口 (1-65535)", { kind: "bad" }); return; }
  if ((username && !password) || (!username && password)) { toast("用户名和密码需同时填写或同时留空", { kind: "bad" }); return; }
  const port = parseInt(portRaw, 10), finalName = name || host + ":" + port;
  if (editingId) {
    const idx = state.proxies.findIndex((p) => p.id === editingId);
    if (idx !== -1) state.proxies[idx] = { ...state.proxies[idx], name: finalName, protocol, host, port, username, password, speed: null };
  } else {
    const p = { id: uid(), name: finalName, protocol, host, port, username, password, speed: null };
    state.proxies.push(p);
    if (!state.currentProxyId) state.currentProxyId = p.id;
  }
  await persist(); closeProxyModal(); render(); toast("代理已保存");
}
async function deleteProxy(id) {
  state.proxies = state.proxies.filter((p) => p.id !== id);
  if (state.currentProxyId === id) { state.currentProxyId = state.proxies.length ? state.proxies[0].id : null; if (!state.proxies.length) state.enabled = false; }
  await persist(); render(); toast("代理已删除");
}
async function switchProxy(id) { if (state.currentProxyId === id) return; state.currentProxyId = id; await persist(); render(); toast("已切换代理"); }
async function runTest(id) {
  if (testingIds.has(id)) return; testingIds.add(id); renderProxies();
  try {
    const result = await chrome.runtime.sendMessage({ type: "TEST_PROXY", proxyId: id });
    state = await loadState(); testingIds.delete(id); renderProxies();
    if (result && result.status === "success") toast("测速成功 · " + result.latency + "ms", { kind: "ok", duration: 5000 });
    else toast("测速失败 · " + ((result && result.error) || "未知错误"), { kind: "bad", duration: 5000 });
  } catch (e) { testingIds.delete(id); renderProxies(); toast("测速失败 · " + (e.message || "无法执行"), { kind: "bad", duration: 5000 }); }
}
async function onToggle(e) {
  const want = e.target.checked;
  if (want && !state.proxies.length) { e.target.checked = false; toast("请先添加代理", { kind: "bad" }); return; }
  if (want && !state.currentProxyId && state.proxies.length) state.currentProxyId = state.proxies[0].id;
  state.enabled = want; await persist(); render(); toast(want ? "代理已开启" : "代理已关闭");
}
async function onModeChange(e) { state.mode = e.target.value; await persist(); renderFooter(); toast(state.mode === "rules" ? "已切换：规则模式" : "已切换：全局模式"); }
async function onCnDirectChange(e) { state.cnDirect = e.target.checked; await persist(); toast(state.cnDirect ? "国内域名直连：开" : "国内域名直连：关"); }

/* ---------------- copy to clipboard ---------------- */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); }
    else { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    toast("已复制 " + text, { kind: "ok" });
  } catch (e) { toast("复制失败", { kind: "bad" }); }
}

/* ---------------- custom rules add ---------------- */
function isDomainLike(v) { return v.indexOf(".") !== -1 || (v.charCodeAt(0) === 42 && v.charCodeAt(1) === 46); }
function builtinTypeOf(domain) {
  const b = state.builtinRules; if (!b) return null;
  const d = domain.toLowerCase();
  if (b.proxy.some((r) => r.v.toLowerCase() === d)) return "proxy";
  if (b.direct.some((r) => r.v.toLowerCase() === d)) return "direct";
  return null;
}
function fmtAdded(list) { return list.length === 1 ? ("添加 " + list[0] + " 成功") : ("添加 " + list[0] + " 等 " + list.length + " 个成功"); }

async function addRules() {
  const type = $("#ruleType").value === "direct" ? "direct" : "proxy";
  const parts = $("#ruleInput").value.split(/[\s,;|#，；]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) { toast("请输入域名", { kind: "bad" }); return; }
  if (parts.some((v) => !isDomainLike(v))) { toast("请填写完整域名，如 google.com（不支持关键词）", { kind: "bad" }); return; }
  normRules();
  const existAny = (d) => state.rules.some((r) => r.v.toLowerCase() === d.toLowerCase());
  const normal = [], dup = [], bSame = [], bOpp = [];
  const seen = new Set();
  parts.forEach((v) => {
    const d = v.toLowerCase(); if (seen.has(d)) return; seen.add(d);
    if (existAny(v)) { dup.push(v); return; }
    const bt = builtinTypeOf(v);
    if (bt === type) { bSame.push(v); return; }
    if (bt && bt !== type) { bOpp.push(v); return; }
    normal.push(v);
  });

  const added = [];
  normal.slice().reverse().forEach((v) => { state.rules.unshift({ v, on: true, type }); added.push(v); });

  // 自定义内部重复 -> 确认框
  if (dup.length) {
    const ok = await confirmDialog("以下域名已在自定义规则中：\n" + dup.slice(0, 8).join("、") + (dup.length > 8 ? " …" : "") + "\n是否仍要添加？（将更新为当前类型并置顶）");
    if (ok) dup.slice().reverse().forEach((v) => { const d = v.toLowerCase(); state.rules = state.rules.filter((r) => r.v.toLowerCase() !== d); state.rules.unshift({ v, on: true, type }); added.push(v); });
  }
  // 与系统规则方向相反 -> 确认框（自定义覆盖系统）
  if (bOpp.length) {
    const ok = await confirmDialog("以下域名在系统规则里方向相反：\n" + bOpp.slice(0, 8).join("、") + (bOpp.length > 8 ? " …" : "") + "\n自定义规则优先级更高会覆盖系统规则，确认添加为「" + (type === "proxy" ? "代理" : "直连") + "」？");
    if (ok) bOpp.slice().reverse().forEach((v) => { if (!existAny(v)) { state.rules.unshift({ v, on: true, type }); added.push(v); } });
  }
  // 与系统规则相同 -> 告知框 + 清空输入
  if (bSame.length) {
    await infoDialog("系统规则已包含以下域名，无需重复添加：\n" + bSame.slice(0, 10).join("、") + (bSame.length > 10 ? " …" : ""));
  }

  $("#ruleInput").value = "";
  if (added.length) { await persist(); renderCustomTable(); toast(fmtAdded(added), { kind: "ok" }); }
  else if (!bSame.length && !dup.length && !bOpp.length) toast("无变化");
}
async function toggleCustom(i) { normRules(); if (state.rules[i]) { state.rules[i].on = !state.rules[i].on; await persist(); renderCustomTable(); } }
async function delCustom(i) { normRules(); state.rules.splice(i, 1); await persist(); renderCustomTable(); toast("规则已删除"); }
async function toggleBuiltin(src, i) { const b = state.builtinRules; if (b && b[src] && b[src][i]) { b[src][i].on = !b[src][i].on; await persistNoSync(); renderSystemTable(); } }
async function delBuiltin(src, i) {
  const b = state.builtinRules; if (!b || !b[src] || !b[src][i]) return;
  const domain = b[src][i].v;
  if (adminKey) {
    try { await adminFetch("/builtin/remove", { domain }); await reloadBuiltin(); toast("已从系统规则删除 " + domain, { kind: "ok" }); }
    catch (e) { if (/密钥|无权限|403/.test(e.message || "")) { await clearAdmin(); renderAccount(); renderSystemTable(); } toast("删除失败 · " + (e.message || ""), { kind: "bad" }); }
  } else { b[src].splice(i, 1); await persistNoSync(); renderSystemTable(); toast("已本地移除（同步后恢复）"); }
}

/* ---------------- system rules admin add ---------------- */
async function sysAddRules() {
  if (!adminKey) { toast("请先解锁管理", { kind: "bad" }); return; }
  const type = $("#sysRuleType").value === "direct" ? "direct" : "proxy";
  const parts = $("#sysRuleInput").value.split(/[\s,;|#，；]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) { toast("请输入域名", { kind: "bad" }); return; }
  if (parts.some((v) => !isDomainLike(v))) { toast("请填写完整域名，如 t.me", { kind: "bad" }); return; }
  const b = state.builtinRules || { proxy: [], direct: [] };
  const existSet = new Set([...(b.proxy || []).map((r) => r.v.toLowerCase()), ...(b.direct || []).map((r) => r.v.toLowerCase())]);
  const dups = parts.filter((v) => existSet.has(v.toLowerCase()));
  if (dups.length) {
    const ok = await confirmDialog("以下域名系统规则已存在，将被忽略：\n" + dups.slice(0, 8).join("、") + (dups.length > 8 ? " …" : "") + "\n是否继续添加其余域名？");
    if (!ok) return;
  }
  try {
    const res = await adminFetch("/builtin/add", { type, domains: parts });
    await reloadBuiltin();
    $("#sysRuleInput").value = "";
    if (res.added && res.added.length) toast(fmtAdded(res.added), { kind: "ok" });
    else toast("没有新增（均已存在）");
  } catch (e) { if (/密钥|无权限|403/.test(e.message || "")) { await clearAdmin(); renderAccount(); renderSystemTable(); } toast("添加失败 · " + (e.message || ""), { kind: "bad" }); }
}
async function reloadBuiltin() {
  const res = await fetch(WORKER + "/builtin", { cache: "no-store" });
  const data = await res.json();
  if (data && data.ok && data.builtin) { state.builtinRules = normBuiltin(data.builtin); await persistNoSync(); renderSystemTable(); renderSettings(); }
}

/* ---------------- builtin sync ---------------- */
async function syncBuiltin() {
  try {
    const res = await fetch(WORKER + "/builtin", { cache: "no-store" });
    const data = await res.json();
    if (!data || !data.ok || !data.builtin) throw new Error("无数据");
    state.builtinRules = normBuiltin(data.builtin);
    await persistNoSync();
    renderSystemTable(); renderSettings();
    toast("内置规则已同步 v" + state.builtinRules.version, { kind: "ok" });
  } catch (e) { toast("同步内置规则失败 · " + (e.message || ""), { kind: "bad" }); }
}
async function autoLoadBuiltin() {
  if (state.builtinRules) return;
  try {
    const res = await fetch(WORKER + "/builtin", { cache: "no-store" });
    const data = await res.json();
    if (data && data.ok && data.builtin) { state.builtinRules = normBuiltin(data.builtin); await persistNoSync(); }
  } catch (e) { /* 静默，可手动同步 */ }
}

/* ======================= cloud sync (user config) ======================= */
let auth = null, encKeyObj = null, syncTimer = null;
const _te = new TextEncoder(), _td = new TextDecoder();
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function sha256Bytes(str) { return new Uint8Array(await crypto.subtle.digest("SHA-256", _te.encode(str))); }
async function deriveAuthHash(u, p) { const salt = await sha256Bytes("uuproxy-auth:" + u); const km = await crypto.subtle.importKey("raw", _te.encode(p), "PBKDF2", false, ["deriveBits"]); return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256)); }
async function deriveEncKey(u, p) { const salt = await sha256Bytes("uuproxy-enc:" + u); const km = await crypto.subtle.importKey("raw", _te.encode(p), "PBKDF2", false, ["deriveKey"]); return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); }
async function exportKey(k) { return b64(await crypto.subtle.exportKey("raw", k)); }
async function importKey(s) { return crypto.subtle.importKey("raw", unb64(s), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]); }
async function encryptJSON(k, o) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, _te.encode(JSON.stringify(o))); return { cipher: b64(ct), iv: b64(iv) }; }
async function decryptJSON(k, c, iv) { const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, k, unb64(c)); return JSON.parse(_td.decode(pt)); }
async function ensureKey() { if (!encKeyObj && auth && auth.keyB64) encKeyObj = await importKey(auth.keyB64); }
function loadAuth() { return new Promise((r) => chrome.storage.local.get(AUTH_KEY, (d) => r(d[AUTH_KEY] || null))); }
function saveAuth() { return new Promise((r) => chrome.storage.local.set({ [AUTH_KEY]: auth }, r)); }
function clearAuthLocal() { auth = null; encKeyObj = null; return new Promise((r) => chrome.storage.local.remove(AUTH_KEY, r)); }
async function api(path, method, body, useAuth) {
  const headers = { "Content-Type": "application/json" };
  if (useAuth && auth && auth.token) headers["Authorization"] = "Bearer " + auth.token;
  const res = await fetch(WORKER + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
  return data;
}
function syncPayload() { return { proxies: state.proxies, currentProxyId: state.currentProxyId, enabled: state.enabled, mode: state.mode, rules: state.rules, testUrl: state.testUrl, cnDirect: state.cnDirect }; }
function applyPayload(o) {
  state = Object.assign({}, DEFAULTS, {
    proxies: Array.isArray(o.proxies) ? o.proxies : [], currentProxyId: o.currentProxyId || null,
    enabled: !!o.enabled, mode: o.mode === "rules" ? "rules" : "all", rules: o.rules || [],
    testUrl: o.testUrl || DEFAULTS.testUrl, cnDirect: o.cnDirect !== false, builtinRules: state.builtinRules
  });
  normRules();
}
async function uploadNow() {
  if (!auth) return; await ensureKey();
  const { cipher, iv } = await encryptJSON(encKeyObj, syncPayload());
  const updatedAt = Date.now();
  await api("/config", "PUT", { cipher, iv, updatedAt, version: 1 }, true);
  auth.lastSync = updatedAt; await saveAuth(); renderAccount();
}
function scheduleSync() {
  if (!auth) return; clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { uploadNow().catch(async (e) => { if (/401|token/i.test(e.message || "")) { await clearAuthLocal(); renderAccount(); render(); toast("登录已失效，请重新登录", { kind: "bad" }); } else setSyncStatus("同步失败，点「⬆ 上传到云端」重试"); }); }, 2000);
}
function setSyncStatus(t) { const el = document.querySelector(".uu-acc-sync"); if (el) el.textContent = t; }
function renderAccount() {
  const box = $("#account"); if (!box) return;
  if (auth && auth.username) {
    const last = auth.lastSync ? new Date(auth.lastSync).toLocaleString() : "尚未同步";
    box.className = "uu-account";
    box.innerHTML = '<div class="uu-acc-row"><span class="uu-acc-user">👤 ' + esc(auth.username) + '</span><div class="uu-acc-btns"><button class="uu-btn uu-btn-ghost uu-btn-sm" data-acc="manage">' + (adminKey ? "管理中" : "管理") + '</button><button class="uu-btn uu-btn-ghost uu-btn-sm" data-acc="logout">退出</button></div></div>'
      + '<div class="uu-acc-actions"><button class="uu-btn uu-btn-primary uu-btn-sm" data-acc="upload">⬆ 上传到云端</button><button class="uu-btn uu-btn-ghost uu-btn-sm" data-acc="download">⬇ 从云端恢复</button></div>'
      + '<div class="uu-acc-sync">上次同步：' + esc(last) + '</div>';
  } else {
    box.className = "uu-account guest";
    box.innerHTML = '<div class="uu-acc-row"><span class="uu-acc-user">未登录</span><div class="uu-acc-btns"><button class="uu-btn uu-btn-primary uu-btn-sm" data-acc="login">登录</button><button class="uu-btn uu-btn-ghost uu-btn-sm" data-acc="register">注册</button></div></div>'
      + '<div class="uu-acc-sync">登录后配置自动云端同步</div>';
  }
}
let authMode = "login";
function openAuth(mode) { authMode = mode; $("#authTitle").textContent = mode === "login" ? "登录" : "注册"; $("#authUser").value = ""; $("#authPass").value = ""; $("#authOverlay").classList.add("show"); setTimeout(() => $("#authUser").focus(), 40); }
function closeAuth() { $("#authOverlay").classList.remove("show"); }
async function submitAuth() {
  const u = $("#authUser").value.trim(), p = $("#authPass").value;
  if (u.length < 3 || u.length > 32) { toast("账号需 3-32 位", { kind: "bad" }); return; }
  if (!p) { toast("请输入密码", { kind: "bad" }); return; }
  const btn = $("#authSubmit"); btn.disabled = true;
  try {
    const authHash = await deriveAuthHash(u, p);
    const data = await api(authMode === "register" ? "/register" : "/login", "POST", { username: u, authHash }, false);
    const key = await deriveEncKey(u, p);
    auth = { username: u, token: data.token, keyB64: await exportKey(key), lastSync: 0 };
    encKeyObj = key; await saveAuth();
    if (authMode === "register") await uploadNow(); else await pullAndApply();
    closeAuth(); renderAccount(); render();
    toast(authMode === "register" ? "注册成功，已同步" : "登录成功", { kind: "ok" });
  } catch (e) { toast((authMode === "register" ? "注册失败 · " : "登录失败 · ") + (e.message || ""), { kind: "bad" }); }
  finally { btn.disabled = false; }
}
async function pullAndApply() {
  await ensureKey();
  const data = await api("/config", "GET", null, true);
  if (!data.config) { await uploadNow(); toast("云端暂无配置，已上传本地", { kind: "ok" }); return; }
  const remote = await decryptJSON(encKeyObj, data.config.cipher, data.config.iv);
  applyPayload(remote); await persistNoSync();
  auth.lastSync = data.config.updatedAt || Date.now(); await saveAuth(); render();
  toast("已从云端恢复配置", { kind: "ok" });
}
async function doLogout() { try { await api("/logout", "POST", null, true); } catch (e) {} await clearAuthLocal(); renderAccount(); toast("已退出登录"); }
async function handleApiErr(e, prefix) { const msg = (e && e.message) || ""; if (/401|token/i.test(msg)) { await clearAuthLocal(); renderAccount(); render(); toast("登录已失效，请重新登录", { kind: "bad" }); } else toast(prefix + " · " + msg, { kind: "bad" }); }
async function uploadManual() {
  try { await ensureKey(); const data = await api("/config", "GET", null, true);
    if (data.config && data.config.updatedAt && auth.lastSync && data.config.updatedAt > auth.lastSync) { const ok = await confirmDialog("云端有更新的版本，确定用本地覆盖云端吗？"); if (!ok) return; }
    await uploadNow(); toast("已上传到云端", { kind: "ok" });
  } catch (e) { handleApiErr(e, "上传失败"); }
}
async function downloadManual() {
  try { await ensureKey(); const data = await api("/config", "GET", null, true);
    if (!data.config) { toast("云端暂无配置", { kind: "bad" }); return; }
    const ok = await confirmDialog("将用云端配置覆盖本地，确定？"); if (!ok) return;
    const remote = await decryptJSON(encKeyObj, data.config.cipher, data.config.iv);
    applyPayload(remote); await persistNoSync(); auth.lastSync = data.config.updatedAt || Date.now(); await saveAuth(); render();
    toast("已从云端恢复", { kind: "ok" });
  } catch (e) { handleApiErr(e, "恢复失败"); }
}

/* ---------------- import / export ---------------- */
function exportConfig() {
  const payload = Object.assign({ _app: "uuproxy", _ts: Date.now() }, syncPayload());
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "uu-proxy-config.json"; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); toast("已导出，请妥善保管");
}
function importConfig(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try { const obj = JSON.parse(reader.result);
      if (!obj || typeof obj !== "object" || !Array.isArray(obj.proxies)) throw new Error("格式不正确");
      applyPayload(obj); await persist(); render(); toast("导入成功", { kind: "ok" });
    } catch (e) { toast("导入失败 · " + (e.message || "无效文件"), { kind: "bad" }); }
  };
  reader.readAsText(file);
}

/* ---------------- events ---------------- */
function bindEvents() {
  document.querySelectorAll(".uu-tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#masterToggle").addEventListener("change", onToggle);
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", onModeChange));
  $("#addBtn").addEventListener("click", () => openProxyModal(null));

  // proxy modal
  $("#parseBtn").addEventListener("click", doParse);
  $("#parseInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doParse(); });
  $("#proxySaveBtn").addEventListener("click", saveProxy);
  $("#fPort").addEventListener("input", () => { let v = $("#fPort").value.replace(/\D/g, ""); if (v) v = String(Math.min(parseInt(v, 10), 65535)); $("#fPort").value = v; });
  $("#fHost").addEventListener("blur", normalizeHostField);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeProxyModal));
  $("#proxyOverlay").addEventListener("click", (e) => { if (e.target === $("#proxyOverlay")) closeProxyModal(); });

  // custom rules
  $("#ruleAddBtn").addEventListener("click", addRules);
  $("#ruleInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addRules(); });
  $("#ruleFilterSel").addEventListener("change", (e) => { ruleFilter = e.target.value; renderCustomTable(); });
  $("#ruleSearch").addEventListener("input", (e) => { ruleSearch = e.target.value; renderCustomTable(); });
  $("#customTableWrap").addEventListener("click", (e) => {
    const cp = e.target.closest(".uu-td-v"); if (cp) { copyText(cp.dataset.copy); return; }
    const b = e.target.closest(".uu-tbtn"); if (!b) return; const i = +b.dataset.i;
    if (b.classList.contains("toggle")) toggleCustom(i); else if (b.classList.contains("del")) delCustom(i);
  });

  // system rules
  $("#sysFilterSel").addEventListener("change", (e) => { sysFilter = e.target.value; renderSystemTable(); });
  $("#sysSyncBtn").addEventListener("click", syncBuiltin);
  $("#sysRuleAddBtn").addEventListener("click", sysAddRules);
  $("#sysRuleInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sysAddRules(); });
  $("#sysAdminExit").addEventListener("click", exitAdmin);
  // admin modal
  $("#adminSubmit").addEventListener("click", submitAdmin);
  $("#adminKeyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdmin(); });
  document.querySelectorAll("[data-close-admin]").forEach((b) => b.addEventListener("click", closeAdmin));
  $("#adminOverlay").addEventListener("click", (e) => { if (e.target === $("#adminOverlay")) closeAdmin(); });
  $("#systemTableWrap").addEventListener("click", (e) => {
    const cp = e.target.closest(".uu-td-v"); if (cp) { copyText(cp.dataset.copy); return; }
    const b = e.target.closest(".uu-tbtn"); if (!b) return; const src = b.dataset.src, i = +b.dataset.i;
    if (b.classList.contains("toggle")) toggleBuiltin(src, i); else if (b.classList.contains("del")) delBuiltin(src, i);
  });

  // settings
  $("#fTestUrl").addEventListener("change", async () => { let u = $("#fTestUrl").value.trim() || DEFAULTS.testUrl; if (!/^https?:\/\//i.test(u)) u = "https://" + u; state.testUrl = u; $("#fTestUrl").value = u; await persist(); toast("已保存测速网站"); });
  $("#cnDirectToggle").addEventListener("change", onCnDirectChange);
  $("#setSyncBtn").addEventListener("click", syncBuiltin);
  $("#exportBtn").addEventListener("click", exportConfig);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) importConfig(e.target.files[0]); e.target.value = ""; });

  // account + auth
  $("#account").addEventListener("click", (e) => { const b = e.target.closest("[data-acc]"); if (!b) return; const a = b.dataset.acc; if (a === "login") openAuth("login"); else if (a === "register") openAuth("register"); else if (a === "logout") doLogout(); else if (a === "upload") uploadManual(); else if (a === "download") downloadManual(); else if (a === "manage") openAdmin(); });
  $("#authSubmit").addEventListener("click", submitAuth);
  $("#authPass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
  document.querySelectorAll("[data-close-auth]").forEach((b) => b.addEventListener("click", closeAuth));
  $("#authOverlay").addEventListener("click", (e) => { if (e.target === $("#authOverlay")) closeAuth(); });

  // proxy list
  $("#proxyList").addEventListener("click", (e) => {
    const op = e.target.closest(".uu-op");
    if (op) { e.stopPropagation(); const id = op.dataset.id, act = op.dataset.act; if (act === "test") runTest(id); else if (act === "edit") openProxyModal(state.proxies.find((p) => p.id === id)); else if (act === "del") deleteProxy(id); return; }
    const card = e.target.closest(".uu-card"); if (card) switchProxy(card.dataset.id);
  });
}

/* ---------------- init ---------------- */
async function init() {
  state = await loadState();
  normRules();
  if (state.builtinRules) state.builtinRules = normBuiltin(state.builtinRules);
  auth = await loadAuth();
  adminKey = await loadAdmin();
  if (auth && auth.keyB64) { try { encKeyObj = await importKey(auth.keyB64); } catch (e) { encKeyObj = null; } }
  render();
  bindEvents();
  initSelects();
  await autoLoadBuiltin();   // 首次无内置则自动拉取
  if ($("#pane-system").classList.contains("active")) renderSystemTable();
  if ($("#pane-settings").classList.contains("active")) renderSettings();
}
document.addEventListener("DOMContentLoaded", init);
