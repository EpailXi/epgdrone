// Cloudflare Worker: Feishu OAuth token exchange + CORS proxy for DroneOps.
// Secrets/vars: APP_ID, APP_SECRET, REDIRECT_URI, ALLOWED_ORIGIN (comma-separated).
// Optional KV binding TRAIN: shared AI training set for block auto-fill (/train).
const API = "https://open.feishu.cn";
const ALLOW = new Set([
  "/open-apis/drive/v1/files/upload_all",
  "/open-apis/drive/v1/files/upload_prepare",
  "/open-apis/drive/v1/files/upload_part",
  "/open-apis/drive/v1/files/upload_finish",
  "/open-apis/im/v1/chats/search",
  "/open-apis/im/v1/messages",
]);
const ALLOW_RE = /^\/open-apis\/drive\/v1\/permissions\/[A-Za-z0-9]+\/(members|public)$/;

const GROUPS = { KVTP: "吉隆坡KVTP-A ME项目", BTP: "BTP-A&B 项目管理" };
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
      // Caller must be a logged-in user of this app
      const me = await (await fetch(`${API}/open-apis/authen/v1/user_info`, {
        headers: { Authorization: req.headers.get("Authorization") || "" },
      })).json();
      if (me.code !== 0) return json({ code: 401, msg: "Not logged in" }, cors);
      const isImage = url.pathname === "/bot/image";
      const form = isImage ? await req.formData() : null;
      const body = isImage ? null : await req.json();
      const name = GROUPS[isImage ? form.get("project") : body.project];
      if (!name) return json({ code: 400, msg: "Unknown project" }, cors);
      const t = await (await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: env.APP_ID, app_secret: env.APP_SECRET }),
      })).json();
      const auth = { Authorization: `Bearer ${t.tenant_access_token}` };
      const bot = { ...auth, "Content-Type": "application/json; charset=utf-8" };
      let chatId = null, pageToken = "";
      do {
        const r = await (await fetch(`${API}/open-apis/im/v1/chats?page_size=100${pageToken ? "&page_token=" + pageToken : ""}`, { headers: bot })).json();
        if (r.code !== 0) return json(r, cors);
        chatId = (r.data.items || []).find(c => c.name === name)?.chat_id || null;
        pageToken = r.data.has_more ? r.data.page_token : "";
      } while (!chatId && pageToken);
      if (!chatId) return json({ code: 404, msg: `Bot is not in group "${name}"` }, cors);
      let msgType = "post", content = body?.content;
      if (isImage) {
        // Original photo as an image message (Feishu limit: 10 MB per image)
        const up = new FormData();
        up.append("image_type", "message");
        up.append("image", form.get("image"));
        const img = await (await fetch(`${API}/open-apis/im/v1/images`, { method: "POST", headers: auth, body: up })).json();
        if (img.code !== 0) return json(img, cors);
        msgType = "image";
        content = JSON.stringify({ image_key: img.data.image_key });
      }
      upstream = await fetch(`${API}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST", headers: bot, body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
      });
    } else if (url.pathname === "/train") {
      // Shared AI training set (block auto-fill). Needs a KV namespace bound as TRAIN.
      if (!env.TRAIN) return json({ code: 501, msg: "Shared training not set up (bind KV as TRAIN)" }, cors);
      const me = await (await fetch(`${API}/open-apis/authen/v1/user_info`, {
        headers: { Authorization: req.headers.get("Authorization") || "" },
      })).json();
      if (me.code !== 0) return json({ code: 401, msg: "Not logged in" }, cors);
      const stored = JSON.parse((await env.TRAIN.get("samples")) || "[]");
      if (req.method === "GET") return json({ code: 0, data: { samples: stored } }, cors);
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
      const b = await req.json();
      let samples = stored;
      if (Array.isArray(b.samples)) {
        const seen = new Set(samples.map(s => s.id));
        for (const s of b.samples.slice(0, 500)) {
          if (s && typeof s.n === "string" && s.n.length <= 80 && s.id && !seen.has(s.id)) { samples.push(s); seen.add(s.id); }
        }
      }
      // keep the newest 60 per label, 3000 overall
      const per = {};
      samples = samples.sort((x, y) => (y.t || 0) - (x.t || 0)).filter(s => (per[s.n] = (per[s.n] || 0) + 1) <= 60).slice(0, 3000);
      await env.TRAIN.put("samples", JSON.stringify(samples));
      return json({ code: 0, data: { count: samples.length } }, cors);
    } else if (ALLOW.has(url.pathname) || ALLOW_RE.test(url.pathname)) {
      const headers = { Authorization: req.headers.get("Authorization") || "" };
      const ct = req.headers.get("Content-Type");
      if (ct) headers["Content-Type"] = ct;
      upstream = await fetch(API + url.pathname + url.search, {
        method: req.method, headers, body: req.method === "GET" ? undefined : await req.arrayBuffer(),
      });
    } else {
      return new Response("Not found", { status: 404, headers: cors });
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  },
};
