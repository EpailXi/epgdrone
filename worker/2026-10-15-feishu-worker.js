// Cloudflare Worker: Feishu OAuth token exchange + CORS proxy for DroneOps.
// Secrets/vars: APP_ID, APP_SECRET, REDIRECT_URI, ALLOWED_ORIGIN (comma-separated),
// ALLOWED_USERS (comma-separated open_ids allowed to post/train — get yours from GET /whoami),
// optional TENANT_KEY (also restrict to one company).
// Optional KV binding TRAIN: shared AI training set for block auto-fill (/train).
const API = "https://open.feishu.cn";

const GROUPS = { KVTP: "吉隆坡KVTP-A ME项目", BTP: "BTP-A&B 项目管理" };
// Per-isolate caches (Workers reuse isolates between requests)
const userCache = new Map();   // user token -> { me, exp }
let tenantTok = null;          // { token, exp }
const chatCache = new Map();   // group name -> { id, exp }

async function getUser(req) {
  const auth = req.headers.get("Authorization") || "";
  const c = userCache.get(auth);
  if (c && c.exp > Date.now()) return c.me;
  const me = await (await fetch(`${API}/open-apis/authen/v1/user_info`, { headers: { Authorization: auth } })).json();
  if (me.code === 0) {
    if (userCache.size > 500) userCache.clear();
    userCache.set(auth, { me, exp: Date.now() + 5 * 60e3 });
  }
  return me;
}
// Logged in AND an allowed user (blocks any other Feishu account, tenant or app)
async function checkUser(req, env) {
  const me = await getUser(req);
  if (me.code !== 0) return { code: 401, msg: "Not logged in" };
  if (env.TENANT_KEY && me.data?.tenant_key !== env.TENANT_KEY) return { code: 403, msg: "Not allowed (company)" };
  const users = (env.ALLOWED_USERS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (users.length && !users.includes(me.data?.open_id)) return { code: 403, msg: "Not allowed (user)" };
  return null;
}
async function tenantToken(env) {
  if (tenantTok && tenantTok.exp > Date.now()) return tenantTok.token;
  const t = await (await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.APP_ID, app_secret: env.APP_SECRET }),
  })).json();
  if (t.code !== 0) throw new Error(t.msg || "tenant token failed");
  tenantTok = { token: t.tenant_access_token, exp: Date.now() + (t.expire - 300) * 1000 };
  return tenantTok.token;
}
async function chatIdFor(name, bot) {
  const c = chatCache.get(name);
  if (c && c.exp > Date.now()) return c.id;
  let chatId = null, pageToken = "";
  do {
    const r = await (await fetch(`${API}/open-apis/im/v1/chats?page_size=100${pageToken ? "&page_token=" + pageToken : ""}`, { headers: bot })).json();
    if (r.code !== 0) throw new Error(r.msg || "chat list failed");
    chatId = (r.data.items || []).find(c => c.name === name)?.chat_id || null;
    pageToken = r.data.has_more ? r.data.page_token : "";
  } while (!chatId && pageToken);
  if (chatId) chatCache.set(name, { id: chatId, exp: Date.now() + 60 * 60e3 });
  return chatId;
}
// Keep only known sample fields with sane types/sizes
const num = v => (typeof v === "number" && isFinite(v) ? v : undefined);
function cleanSample(s) {
  if (!s || typeof s.id !== "string" || s.id.length > 300 || typeof s.n !== "string" || !s.n || s.n.length > 80) return null;
  const o = { id: s.id, n: s.n, t: Math.min(num(s.t) || 0, Date.now() + 86400e3) };
  if (typeof s.p === "string" && s.p.length <= 20) o.p = s.p;
  for (const k of ["lat", "lon", "alt", "yaw"]) if (num(s[k]) !== undefined) o[k] = s[k];
  if (typeof s.e === "string" && s.e.length <= 4096 && /^[A-Za-z0-9+/=]+$/.test(s.e)) o.e = s.e;
  return o.lat !== undefined || o.e ? o : null;
}

const json = (o, cors) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });

export default {
  async fetch(req, env) {
    const origins = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim());
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!origins.includes(origin)) return new Response("Forbidden", { status: 403, headers: cors });

    const url = new URL(req.url);
    let upstream;
    try {
    if (url.pathname === "/token" && req.method === "POST") {
      const b = await req.json();
      const body = { client_id: env.APP_ID, client_secret: env.APP_SECRET, grant_type: b.grant_type };
      if (b.grant_type === "authorization_code") Object.assign(body, { code: b.code, redirect_uri: env.REDIRECT_URI });
      else if (b.grant_type === "refresh_token") body.refresh_token = b.refresh_token;
      else return new Response("Bad grant", { status: 400, headers: cors });
      upstream = await fetch(`${API}/open-apis/authen/v2/oauth/token`, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body),
      });
    } else if ((url.pathname === "/bot/post" || url.pathname === "/bot/image") && req.method === "POST") {
      // Caller must be a logged-in user from our company
      const bad = await checkUser(req, env);
      if (bad) return json(bad, cors);
      const isImage = url.pathname === "/bot/image";
      const form = isImage ? await req.formData() : null;
      const body = isImage ? null : await req.json();
      const name = GROUPS[isImage ? form.get("project") : body.project];
      if (!name) return json({ code: 400, msg: "Unknown project" }, cors);
      const auth = { Authorization: `Bearer ${await tenantToken(env)}` };
      const bot = { ...auth, "Content-Type": "application/json; charset=utf-8" };
      const chatId = await chatIdFor(name, bot);
      if (!chatId) return json({ code: 404, msg: `Bot is not in group "${name}"` }, cors);
      let msgType = "post", content = body?.content;
      if (isImage) {
        // Original photo as an image message (Feishu limit: 10 MB per image)
        const up = new FormData();
        up.append("image_type", "message");
        up.append("image", form.get("image"));
        const img = await (await fetch(`${API}/open-apis/im/v1/images`, { method: "POST", headers: auth, body: up })).json();
        if (img.code !== 0) { if (img.code === 99991663 || img.code === 99991664) tenantTok = null; return json(img, cors); }
        msgType = "image";
        content = JSON.stringify({ image_key: img.data.image_key });
      }
      upstream = await fetch(`${API}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST", headers: bot, body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
      });
    } else if (url.pathname === "/train") {
      // Shared AI training set (block auto-fill). Needs a KV namespace bound as TRAIN.
      if (!env.TRAIN) return json({ code: 501, msg: "Shared training not set up (bind KV as TRAIN)" }, cors);
      const bad = await checkUser(req, env);
      if (bad) return json(bad, cors);
      const stored = JSON.parse((await env.TRAIN.get("samples")) || "[]");
      if (req.method === "GET") return json({ code: 0, data: { samples: stored } }, cors);
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
      const b = await req.json();
      let samples = stored;
      if (Array.isArray(b.samples)) {
        // newer copy of the same photo wins, so renamed/corrected labels replace old ones
        const byId = new Map(samples.map(s => [s.id, s]));
        for (const raw of b.samples.slice(0, 500)) {
          const s = cleanSample(raw);
          if (!s) continue;
          const cur = byId.get(s.id);
          if (!cur || s.t >= (cur.t || 0)) byId.set(s.id, s);
        }
        samples = [...byId.values()];
      }
      // keep the newest 60 per label, 3000 overall
      const per = {};
      samples = samples.sort((x, y) => (y.t || 0) - (x.t || 0)).filter(s => (per[s.n] = (per[s.n] || 0) + 1) <= 60).slice(0, 3000);
      await env.TRAIN.put("samples", JSON.stringify(samples));
      return json({ code: 0, data: { count: samples.length } }, cors);
    } else if (url.pathname === "/whoami" && req.method === "GET") {
      // Shows the logged-in user's open_id / tenant_key — copy into ALLOWED_USERS / TENANT_KEY
      const me = await getUser(req);
      if (me.code !== 0) return json({ code: 401, msg: "Not logged in" }, cors);
      return json({ code: 0, data: { name: me.data.name, open_id: me.data.open_id, tenant_key: me.data.tenant_key,
        locked: !!(env.ALLOWED_USERS || env.TENANT_KEY) } }, cors);
    } else {
      return new Response("Not found", { status: 404, headers: cors });
    }
    } catch (e) {
      return json({ code: 500, msg: `Worker error: ${e.message}` }, cors); // with CORS, so the page sees the reason
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  },
};
