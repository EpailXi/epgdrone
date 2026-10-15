// Cloudflare Worker: Feishu OAuth token exchange + CORS proxy for DroneOps.
// Secrets/vars: APP_ID, APP_SECRET, REDIRECT_URI, ALLOWED_ORIGIN (comma-separated).
const API = "https://open.feishu.cn";
const ALLOW = new Set([
  "/open-apis/drive/v1/files/upload_all",
  "/open-apis/drive/v1/files/upload_prepare",
  "/open-apis/drive/v1/files/upload_part",
  "/open-apis/drive/v1/files/upload_finish",
  "/open-apis/im/v1/chats/search",
  "/open-apis/im/v1/messages",
]);

export default {
  async fetch(req, env) {
    const origins = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim());
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    } else if (ALLOW.has(url.pathname)) {
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
