// UU Proxy — background service worker (MV3)
importScripts("data.js"); // CN_TLDS, GOOGLE_TLDS

const STORAGE_KEY = "uuProxyState";
const WORKER = "https://proxy-soft.19920806.xyz";

const DEFAULT_STATE = {
  proxies: [],
  currentProxyId: null,
  enabled: false,
  mode: "all",                 // "all" | "rules"
  rules: [],                   // [{ v, on, type:"proxy"|"direct" }]  (direct = 白名单)
  testUrl: "https://ip.cn/",
  cnDirect: true,              // 国内域名直连开关
  builtinRules: null           // { version, updatedAt, proxy:[{v,on}], direct:[{v,on}] }
};

let testingProxy = null;
const authAttempts = {};
let authCreds = null;
function setAuthCreds(proxy) {
  authCreds = (proxy && proxy.username) ? { username: proxy.username, password: proxy.password || "" } : null;
}

/* ---------------- state ---------------- */
function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => resolve(Object.assign({}, DEFAULT_STATE, res[STORAGE_KEY] || {})));
  });
}
function saveState(state) {
  return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve));
}

/* rules -> enabled values by type */
function customVals(rules, type) {
  return (rules || [])
    .map((r) => (typeof r === "string" ? { v: r, on: true, type: "proxy" } : r))
    .filter((r) => r && r.on !== false && (r.v || "").trim() && (r.type || "proxy") === type)
    .map((r) => r.v.trim().toLowerCase());
}
function builtinVals(builtin, key) {
  if (!builtin || !Array.isArray(builtin[key])) return [];
  return builtin[key]
    .map((r) => (typeof r === "string" ? { v: r, on: true } : r))
    .filter((r) => r && r.on !== false && (r.v || "").trim())
    .map((r) => r.v.trim().toLowerCase());
}

/* ---------------- proxy token ---------------- */
function pacToken(proxy) {
  const h = asciiHost(proxy.host);
  switch (proxy.protocol) {
    case "https":  return "HTTPS " + h + ":" + proxy.port;
    case "socks5": return "SOCKS5 " + h + ":" + proxy.port;
    default:       return "PROXY " + h + ":" + proxy.port;
  }
}

/* 把域名规则归一化为纯 ASCII（中文 IDN -> punycode），PAC 只接受 ASCII */
function asciiHost(v) {
  if (/^[\x00-\x7F]*$/.test(v)) return v; // 已是 ASCII
  const star = v.slice(0, 2) === "*.";
  let h = star ? v.slice(2) : v;
  try { h = new URL("http://" + h).hostname; } catch (e) {}
  return star ? "*." + h : h;
}
function asciiList(arr) { return arr.map(asciiHost); }

/* ---------------- PAC 生成 ---------------- */
function buildPac(proxy, state) {
  const token = pacToken(proxy);
  const cfg = {
    token: token,
    mode: state.mode,
    cnDirect: !!state.cnDirect,
    cnTlds: CN_TLDS,
    googleTlds: GOOGLE_TLDS,
    cProxy: asciiList(customVals(state.rules, "proxy")),
    cDirect: asciiList(customVals(state.rules, "direct")),
    bProxy: asciiList(builtinVals(state.builtinRules, "proxy")),
    bDirect: asciiList(builtinVals(state.builtinRules, "direct"))
  };
  return "var CFG=" + JSON.stringify(cfg) + ";\n" + PAC_BODY;
}

// PAC 主体（字符串，注入到浏览器执行）
const PAC_BODY = [
  "var ipRe=/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/;",
  "var privRe=[/^10\\./,/^127\\./,/^192\\.168\\./,/^169\\.254\\./,/^172\\.(1[6-9]|2\\d|3[01])\\./,/^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\./];",
  "function isPriv(h){if(!ipRe.test(h))return false;for(var i=0;i<privRe.length;i++){if(privRe[i].test(h))return true;}return false;}",
  "function inList(h,l){for(var i=0;i<l.length;i++){var p=l[i];if(p.charCodeAt(0)===42&&p.charCodeAt(1)===46){var b=p.substring(2);if(h===b||h.length>b.length&&h.substring(h.length-b.length-1)==='.'+b)return true;}else{if(h===p||h.length>p.length&&h.substring(h.length-p.length-1)==='.'+p)return true;}}return false;}",
  "function endTld(h,l){for(var i=0;i<l.length;i++){var t=l[i];if(h===t||h.length>t.length&&h.substring(h.length-t.length-1)==='.'+t)return true;}return false;}",
  "function FindProxyForURL(url,host){",
  "  host=host.toLowerCase();",
  "  if(host.indexOf('.')<0||host==='localhost'||isPriv(host))return 'DIRECT';",
  "  if(CFG.mode==='all'){",
  "    if(inList(host,CFG.cDirect))return 'DIRECT';",
  "    if(inList(host,CFG.bDirect))return 'DIRECT';",
  "    if(CFG.cnDirect&&endTld(host,CFG.cnTlds))return 'DIRECT';",
  "    return CFG.token;",
  "  }",
  "  if(inList(host,CFG.cDirect))return 'DIRECT';",
  "  if(inList(host,CFG.cProxy))return CFG.token;",
  "  if(CFG.cnDirect&&endTld(host,CFG.cnTlds))return 'DIRECT';",
  "  if(inList(host,CFG.bDirect))return 'DIRECT';",
  "  if(inList(host,CFG.bProxy)||endTld(host,CFG.googleTlds))return CFG.token;",
  "  return 'DIRECT';",
  "}"
].join("\n");

function setChromeProxy(config) {
  return new Promise((r) => chrome.proxy.settings.set({ value: config, scope: "regular" }, r));
}
function clearChromeProxy() {
  return new Promise((r) => chrome.proxy.settings.clear({ scope: "regular" }, r));
}

async function applyProxy() {
  const state = await getState();
  const proxy = state.proxies.find((p) => p.id === state.currentProxyId);
  setAuthCreds(state.enabled ? proxy : null);
  if (!state.enabled || !proxy) { await clearChromeProxy(); return; }
  await setChromeProxy({ mode: "pac_script", pacScript: { data: buildPac(proxy, state), mandatory: false } });
}

/* ---------------- proxy auth ---------------- */
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    const creds = testingProxy ? { username: testingProxy.username, password: testingProxy.password || "" } : authCreds;
    if (!creds || !creds.username) { callback({}); return; }
    const n = (authAttempts[details.requestId] || 0) + 1;
    authAttempts[details.requestId] = n;
    if (n > 2) { delete authAttempts[details.requestId]; callback({}); return; }
    callback({ authCredentials: { username: creds.username, password: creds.password } });
  },
  { urls: ["<all_urls>"] }, ["asyncBlocking"]
);
function clearAuthAttempt(d) { delete authAttempts[d.requestId]; }
chrome.webRequest.onCompleted.addListener(clearAuthAttempt, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(clearAuthAttempt, { urls: ["<all_urls>"] });

/* ---------------- speed test ---------------- */
async function testProxy(proxyId) {
  const state = await getState();
  const proxy = state.proxies.find((p) => p.id === proxyId);
  if (!proxy) return { status: "fail", error: "代理不存在" };
  testingProxy = proxy;
  await setChromeProxy({ mode: "fixed_servers", rules: { singleProxy: { scheme: proxy.protocol, host: proxy.host, port: Number(proxy.port) }, bypassList: [] } });
  const url = state.testUrl || DEFAULT_STATE.testUrl;
  const bust = url + (url.indexOf("?") === -1 ? "?" : "&") + "_uu=" + Date.now();
  const start = Date.now();
  let result;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    await fetch(bust, { signal: controller.signal, cache: "no-store", redirect: "follow", mode: "no-cors" });
    clearTimeout(timer);
    result = { status: "success", latency: Date.now() - start, ts: Date.now() };
  } catch (e) {
    result = { status: "fail", error: e && e.name === "AbortError" ? "请求超时" : ((e && e.message) || "连接失败"), ts: Date.now() };
  } finally {
    testingProxy = null;
    await applyProxy();
  }
  const fresh = await getState();
  const idx = fresh.proxies.findIndex((p) => p.id === proxyId);
  if (idx !== -1) { fresh.proxies[idx].speed = result; await saveState(fresh); }
  return result;
}

/* ---------------- messaging ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "TEST_PROXY") { testProxy(msg.proxyId).then(sendResponse); return true; }
  if (msg.type === "APPLY_PROXY") { applyProxy().then(() => sendResponse({ ok: true })); return true; }
});

/* ---------------- lifecycle ---------------- */
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[STORAGE_KEY]) applyProxy(); });
chrome.runtime.onInstalled.addListener(() => applyProxy());
chrome.runtime.onStartup.addListener(() => applyProxy());
applyProxy();
