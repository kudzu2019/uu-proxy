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
  // Google/YouTube 国别域并入内置代理，一起参与"最长匹配"
  const bProxy = asciiList(builtinVals(state.builtinRules, "proxy")).concat(GOOGLE_TLDS);
  const cfg = {
    token: token,
    mode: state.mode,
    cProxy: asciiList(customVals(state.rules, "proxy")),
    cDirect: asciiList(customVals(state.rules, "direct")),
    bProxy: bProxy,
    bDirect: asciiList(builtinVals(state.builtinRules, "direct"))
  };
  return "var CFG=" + JSON.stringify(cfg) + ";\n" + PAC_BODY;
}

// PAC 主体（字符串，注入浏览器执行）——同层内"最长后缀匹配优先"
const PAC_BODY = [
  "var ipRe=/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/;",
  "var privRe=[/^10\\./,/^127\\./,/^192\\.168\\./,/^169\\.254\\./,/^172\\.(1[6-9]|2\\d|3[01])\\./,/^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\./];",
  "function isPriv(h){if(!ipRe.test(h))return false;for(var i=0;i<privRe.length;i++){if(privRe[i].test(h))return true;}return false;}",
  // 返回列表中命中该 host 的"最长"规则的域名长度；未命中返回 -1
  "function bestLen(h,l){var best=-1;for(var i=0;i<l.length;i++){var p=l[i];var b=(p.charCodeAt(0)===42&&p.charCodeAt(1)===46)?p.substring(2):p;if(h===b||(h.length>b.length&&h.substring(h.length-b.length-1)==='.'+b)){if(b.length>best)best=b.length;}}return best;}",
  // 在一组(代理列表, 直连列表)中按最长匹配决定类型；都不命中返回 null
  "function pick(h,pl,dl,token){var pp=bestLen(h,pl),dd=bestLen(h,dl);if(pp<0&&dd<0)return null;return pp>dd?token:'DIRECT';}",
  "function FindProxyForURL(url,host){",
  "  host=host.toLowerCase();",
  "  if(host.indexOf('.')<0||host==='localhost'||isPriv(host))return 'DIRECT';",
  // 自定义规则整体优先（内部最长匹配）
  "  var c=pick(host,CFG.cProxy,CFG.cDirect,CFG.token);",
  "  if(c!==null)return c;",
  "  if(CFG.mode==='all'){",
  "    if(bestLen(host,CFG.bDirect)>=0)return 'DIRECT';",  // 全局：内置白名单直连
  "    return CFG.token;",                                   // 其余全走代理
  "  }",
  // 规则模式：内置规则（内部最长匹配）
  "  var b=pick(host,CFG.bProxy,CFG.bDirect,CFG.token);",
  "  if(b!==null)return b;",
  "  return 'DIRECT';",                                      // 默认直连
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
