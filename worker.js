// ============================================================================
// UU Proxy — Cloudflare Worker (后端)
// 绑定要求：D1 数据库绑定为 DB，KV 命名空间绑定为 CONFIG_KV
// 环境密钥：TOKEN_SECRET（登录 token 签名）、ADMIN_KEY（系统规则管理）
// ============================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Key",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

const te = new TextEncoder();
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function sha256Hex(str) {
  const b = await crypto.subtle.digest("SHA-256", te.encode(str));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function randHex(n = 16) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(username, secret) {
  const payload = b64u(te.encode(JSON.stringify({ u: username, t: Date.now() })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(payload));
  return payload + "." + b64u(sig);
}
async function verifyToken(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, sig] = token.split(".");
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64uToBytes(sig), te.encode(payload));
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(b64uToBytes(payload))).u; } catch (e) { return null; }
}
async function readUser(env, u) {
  return env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(u).first();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.TOKEN_SECRET) return json({ error: "server not configured: TOKEN_SECRET" }, 500);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    try {
      // -------------------- 注册 --------------------
      if (path === "/register" && request.method === "POST") {
        const { username, authHash } = await request.json();
        if (!username || !authHash) return json({ error: "参数缺失" }, 400);
        if (username.length < 3 || username.length > 32) return json({ error: "用户名长度需 3-32" }, 400);
        if (await readUser(env, username)) return json({ error: "用户名已存在" }, 409);
        const salt = randHex(16);
        const stored = await sha256Hex(authHash + ":" + salt);
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO users (username, auth_hash, server_salt, token, created_at, updated_at) VALUES (?,?,?,?,?,?)"
        ).bind(username, stored, salt, null, now, now).run();
        return json({ ok: true, token: await signToken(username, env.TOKEN_SECRET), username });
      }

      // -------------------- 登录 --------------------
      if (path === "/login" && request.method === "POST") {
        const { username, authHash } = await request.json();
        if (!username || !authHash) return json({ error: "参数缺失" }, 400);
        const user = await readUser(env, username);
        if (!user) return json({ error: "账号或密码错误" }, 401);
        if (await sha256Hex(authHash + ":" + user.server_salt) !== user.auth_hash)
          return json({ error: "账号或密码错误" }, 401);
        return json({ ok: true, token: await signToken(username, env.TOKEN_SECRET), username });
      }

      // -------------------- 鉴权（无状态签名 token，多设备互不影响）--------------------
      const authz = request.headers.get("Authorization") || "";
      const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
      const me = await verifyToken(token, env.TOKEN_SECRET);

      // -------------------- 下载用户配置 --------------------
      if (path === "/config" && request.method === "GET") {
        if (!me) return json({ error: "未登录或 token 失效" }, 401);
        const raw = await env.CONFIG_KV.get("cfg:" + me);
        return json({ ok: true, config: raw ? JSON.parse(raw) : null });
      }

      // -------------------- 上传用户配置（密文）--------------------
      if (path === "/config" && request.method === "PUT") {
        if (!me) return json({ error: "未登录或 token 失效" }, 401);
        const body = await request.json();
        if (!body || !body.cipher || !body.iv) return json({ error: "参数缺失" }, 400);
        await env.CONFIG_KV.put("cfg:" + me, JSON.stringify({
          cipher: body.cipher, iv: body.iv,
          updatedAt: body.updatedAt || Date.now(), version: body.version || 1
        }));
        return json({ ok: true, updatedAt: body.updatedAt || Date.now() });
      }

      // -------------------- 退出（无状态，客户端删本地 token 即可）--------------------
      if (path === "/logout" && request.method === "POST") return json({ ok: true });

      // -------------------- 内置规则：公开只读 --------------------
      if (path === "/builtin" && request.method === "GET") {
        const raw = await env.CONFIG_KV.get("builtin:rules");
        return json({ ok: true, builtin: raw ? JSON.parse(raw) : null });
      }

      // -------------------- 内置规则：整表覆盖（管理密钥）--------------------
      if (path === "/builtin" && request.method === "PUT") {
        const key = request.headers.get("X-Admin-Key") || "";
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "无权限" }, 403);
        const body = await request.json();
        if (!body || !Array.isArray(body.proxy) || !Array.isArray(body.direct)) return json({ error: "格式错误" }, 400);
        const data = { version: body.version || Date.now(), updatedAt: Date.now(), proxy: body.proxy, direct: body.direct };
        await env.CONFIG_KV.put("builtin:rules", JSON.stringify(data));
        return json({ ok: true, version: data.version, updatedAt: data.updatedAt });
      }

      // -------------------- 内置规则：校验管理密钥 --------------------
      if (path === "/builtin/verify" && request.method === "POST") {
        const key = request.headers.get("X-Admin-Key") || "";
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ ok: false }, 403);
        return json({ ok: true });
      }

      // -------------------- 内置规则：增加（一条或多条，自动去重）--------------------
      if (path === "/builtin/add" && request.method === "POST") {
        const key = request.headers.get("X-Admin-Key") || "";
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "无权限" }, 403);
        const body = await request.json();
        const type = body && body.type === "direct" ? "direct" : "proxy";
        const domains = (body && Array.isArray(body.domains) ? body.domains : [])
          .map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
        if (!domains.length) return json({ error: "无域名" }, 400);
        const raw = await env.CONFIG_KV.get("builtin:rules");
        const data = raw ? JSON.parse(raw) : { version: 0, proxy: [], direct: [] };
        data.proxy = data.proxy || []; data.direct = data.direct || [];
        const existProxy = new Set(data.proxy.map((v) => String(v).toLowerCase()));
        const existDirect = new Set(data.direct.map((v) => String(v).toLowerCase()));
        const added = [], skipped = [];
        for (const d of domains) {
          if (existProxy.has(d) || existDirect.has(d)) { skipped.push(d); continue; }
          data[type].push(d);
          (type === "proxy" ? existProxy : existDirect).add(d);
          added.push(d);
        }
        data.version = (data.version || 0) + 1; data.updatedAt = Date.now();
        await env.CONFIG_KV.put("builtin:rules", JSON.stringify(data));
        return json({ ok: true, added, skipped, version: data.version });
      }

      // -------------------- 内置规则：删除一条 --------------------
      if (path === "/builtin/remove" && request.method === "POST") {
        const key = request.headers.get("X-Admin-Key") || "";
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "无权限" }, 403);
        const body = await request.json();
        const domain = String(body && body.domain || "").trim().toLowerCase();
        if (!domain) return json({ error: "无域名" }, 400);
        const raw = await env.CONFIG_KV.get("builtin:rules");
        if (!raw) return json({ error: "内置为空" }, 400);
        const data = JSON.parse(raw);
        const before = (data.proxy || []).length + (data.direct || []).length;
        data.proxy = (data.proxy || []).filter((v) => String(v).toLowerCase() !== domain);
        data.direct = (data.direct || []).filter((v) => String(v).toLowerCase() !== domain);
        const removed = before - (data.proxy.length + data.direct.length);
        data.version = (data.version || 0) + 1; data.updatedAt = Date.now();
        await env.CONFIG_KV.put("builtin:rules", JSON.stringify(data));
        return json({ ok: true, removed, version: data.version });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "server error", detail: String(e && e.message || e) }, 500);
    }
  },
};
