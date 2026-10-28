# Feishu auto-post setup

## 1. Feishu app (open.feishu.cn → 开发者后台)
1. Create **企业自建应用**; note **App ID** + **App Secret**.
2. 安全设置 → 重定向URL: `https://epailxi.github.io/epgdrone/`
3. 权限管理 → add **user** scopes: `drive:drive`, `im:message.send_as_user`, `im:chat:readonly`, `offline_access`.
4. Add features: **Bot** + **Web app** (homepage `https://epailxi.github.io/epgdrone/`).
5. Tenant scopes: `im:message:send_as_bot`, `im:chat:readonly`, `im:resource` (upload photos as image messages).
6. Publish a version; admin approves.
7. Add the bot to both groups (group → Settings → Bots → Add Bot → EPG Drone Photo Poster).

## 2. Cloudflare Worker
1. dash.cloudflare.com → Workers → Create → name `epg-feishu` → paste `2026-10-15-feishu-worker.js` → Deploy.
2. Settings → Variables:
   - `APP_ID` = App ID
   - `APP_SECRET` = App Secret (**Secret** type)
   - `REDIRECT_URI` = `https://epailxi.github.io/epgdrone/`
   - `ALLOWED_ORIGIN` = `https://epailxi.github.io`
3. (Optional, shared AI training) Workers → KV → Create namespace `epg-drone-ai` → Worker Settings → Bindings → KV namespace, variable name `TRAIN`. Without it the AI learns per device only.

## 3. index.html
Set `FEISHU.APP_ID` and `FEISHU.WORKER` (Worker URL).

## Use
Login with Feishu (before loading photos) → load photos → pick KVTP/BTP → **Post to Feishu**.
ZIP goes to the Drive folder; a link is posted in the project group as you.
