# CIP – Strike Cockpit (Base44 dev notes)

## What this is
A single-page Cloudflare Workers app. `public/index.html` is the full frontend
(443 KB, self-contained, no build step). `src/worker.js` is a thin API that
persists to Cloudflare D1 (SQLite). No package.json — the project runs via
`wrangler dev` with local D1.

## How it runs in Base44
- `docker-compose.base44.yml` uses `node:22-slim`, installs `wrangler@latest`
  globally, applies `migrations/0001_initial.sql` to a local SQLite D1, then
  starts `wrangler dev` on port 3000.
- No external secrets or credentials are needed. D1 runs locally via miniflare.
- Local D1 state lives in `.wrangler/` (gitignored).

## API surface (all same-origin, served on port 3000)
- `GET  /api/bootstrap` — full app state (no origin check)
- `POST /api/sync` — fine-grained mutations (same-origin check)
- `GET  /api/export` — JSON backup
- `POST /api/import` — full restore (same-origin check)
- `GET  /api/health` — status probe
- Everything else → `env.ASSETS.fetch(request)` serves `public/index.html`

## Known dev-preview limitation
The worker's `sameOrigin()` guard compares the browser `Origin` header against
`request.url`'s origin. The Base44 preview proxy rewrites the Host header, so
these differ and `POST /api/sync` / `POST /api/import` return 403. The app
falls back to "CLOUD OFFLINE – SAVED LOCALLY" mode (localStorage), so the UI is
fully interactive; changes just don't persist to D1. `GET /api/bootstrap` has
no origin check and works normally.

## Verification
- `curl http://localhost:3000/api/health` → `{"ok":true,"db":"ok",...}`
- `curl http://localhost:3000/` → serves `public/index.html`
