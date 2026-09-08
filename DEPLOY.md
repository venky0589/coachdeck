# Deploying badminton-coach-helper

Chosen setup: **self-hosted on your own machine, reachable over your
Tailscale network** — not a public VPS. This keeps the app's actual
security model (a shared API key that's a deterrent, not real per-user
auth — see CLAUDE.md's "Security / auth" section) matched to who can reach
it: only devices on your tailnet, never the open internet.

## What's already done (this session)

- `server/index.js` now serves the built app itself (`express.static` +
  SPA fallback) when `dist/` exists, so the app and API are one process/
  one origin in production — no CORS needed, fewer moving parts.
- `server/index.js` loads `server/.env` relative to its own file location,
  not the caller's working directory — `npm run server` / `npm run
  dev:all` from the repo root previously never actually loaded
  `DB_PASSWORD`/`API_KEY` (dotenv looked for `.env` at the repo root,
  which doesn't exist). Fixed; verified by starting the server from the
  repo root and confirming `/health` and an API-key-gated request both
  work correctly.
- `server/.env` has a real `API_KEY` set (was unset before — the server
  would've auto-generated one on next start that wouldn't match the
  client's placeholder key).
- `.env.local`'s `VITE_SUPABASE_URL` points at this machine's Tailscale
  HTTPS name instead of a bare LAN IP:
  `https://venky-hp-zbook-firefly-14-inch-g8-mobile-workstation-pc.tail21ff79.ts.net`
  — and `VITE_SUPABASE_ANON_KEY` matches the new `API_KEY`.
- This repo is now a git repository with one initial commit (wasn't
  before). No remote configured — that's your call.
- `deploy/coach-api.service` (systemd unit) and `deploy/backup-db.sh`
  (nightly `pg_dump`) are written and ready, **not installed/enabled yet**
  — both need `sudo` / crontab edits, done below by you.

## What you still need to do

### 1. Let Tailscale issue a real HTTPS cert (needs root once)

```bash
sudo tailscale set --operator=$USER   # so future `tailscale` commands don't need sudo
```

Then start the HTTPS front for the API/app (Tailscale terminates TLS and
reverse-proxies to plain HTTP locally — no cert files for you to manage):

```bash
npm run build   # make sure dist/ is current
tailscale serve --bg --https=443 / http://127.0.0.1:3001
```

Check it:

```bash
tailscale serve status
curl https://venky-hp-zbook-firefly-14-inch-g8-mobile-workstation-pc.tail21ff79.ts.net/health
```

This only answers on your tailnet — devices without Tailscale can't reach
it at all, `tailscale serve` (not `tailscale funnel`) never touches the
public internet.

### 2. Start the API server (manually first, to confirm it's fine)

```bash
npm run build
node server/index.js
```

Open the Tailscale HTTPS URL above from your phone (with Tailscale
running on it too) and confirm the app loads and PIN unlock/sync work.

### 3. Install the systemd service, so it survives reboots/crashes

```bash
sudo cp deploy/coach-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coach-api
systemctl status coach-api
```

This matters specifically because monthly billing (`generate_monthly_
invoices`) runs off an in-process cron schedule inside this same Node
process — if the process isn't running at 06:00 on the 1st, that month's
run doesn't happen until the app-open catch-up.

### 4. Schedule nightly backups

```bash
crontab -e
# add:
0 3 * * * /home/venky/Development-Personal/badminton-coach-helper/deploy/backup-db.sh >> /home/venky/badminton-coach-backups/backup.log 2>&1
```

### 5. Known, deliberately deferred

- **`DB_PASSWORD=123456` in `server/.env`** — placeholder-strength,
  flagged but intentionally not changed this pass (would need an `ALTER
  USER` on the live Postgres role at the same time, which risks locking
  out anything else already connected with the old password — do this
  when you're at the machine and can immediately verify the server still
  connects). When you're ready: pick a strong password, `ALTER USER
  <role> WITH PASSWORD '<new>'`, update `server/.env`'s `DB_PASSWORD` to
  match, restart `coach-api`.
- **No per-coach login** — this deploy doesn't add multi-coach auth (see
  CLAUDE.md's "Coaches — a real roster entity, still not a login").

---

## Alternative: Render (app) + Neon (Postgres) — free tier

Chosen when the goal is $0 hosting without keeping a personal machine on,
at the cost of Render's free-tier sleep behavior (see the caveat below).
Same codebase, no architecture change — just different env values and
where things run.

### 1. Neon — free Postgres

1. Create a project at Neon. Copy the connection details it gives you
   (host, database, user, password — Neon shows a full connection string;
   the pieces after `postgres://user:password@host/dbname` map directly).
2. Run the schema against it with `psql` (or Neon's SQL editor in the
   dashboard), in order:
   ```bash
   psql "postgres://<user>:<password>@<host>/<dbname>?sslmode=require" \
     -f sql/01-schema.sql -f sql/02-billing.sql -f sql/03-migrations.sql
   ```
3. Note the host/user/password/dbname — you'll set these as Render env
   vars below, not in any file that gets committed.

### 2. Render — app + API

1. Create a new **Web Service** from this repo (Render's blueprint
   `render.yaml` at the repo root pre-fills most of this if you use
   "New from Blueprint" instead).
2. Build command: `npm install && npm run build`. Start command:
   `node server/index.js`.
3. Set these environment variables in Render's dashboard (Render exposes
   them at build time too, which matters for the `VITE_*` ones — Vite
   inlines them into the built bundle, so they must be set *before* the
   build runs, not just at runtime):
   - `HOST=0.0.0.0` — required; the server's default `127.0.0.1` is
     unreachable from outside the container and Render doesn't set `HOST`
     itself.
   - `DB_SSL=true` — Neon refuses plain TCP.
   - `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — from Neon, step 1.
     `DB_PORT=5432`.
   - `API_KEY` — pick a real value yourself (e.g.
     `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`).
   - `ALLOWED_ORIGINS=https://<your-service>.onrender.com` — your own
     Render URL. Without this, same-origin POST/PUT/DELETE calls the app
     makes to itself get rejected by the CORS allow-list, which only
     recognizes localhost/private-LAN origins by default.
   - `VITE_SUPABASE_URL=https://<your-service>.onrender.com` and
     `VITE_SUPABASE_ANON_KEY=<same value as API_KEY>` — app and API are
     one process/one origin here too, same as the Tailscale setup.
4. Deploy. Check `https://<your-service>.onrender.com/health`, then open
   the app and confirm PIN setup and sync work.

### 3. Known limitation — free-tier sleep breaks the billing cron

Render's free web services spin down after ~15 minutes of no incoming
requests, and cold-start on the next request. Two consequences:

- The in-process `node-cron` job (`0 6 1 * *` in `server/index.js`) only
  fires if the process happens to be awake at 06:00 on the 1st — on a
  sleeping free instance, it usually won't be.
- The app-open catch-up (`if (new Date().getDate() === 1) runBilling()`
  at server start) only helps if *something* wakes the service on the
  1st — opening the app yourself, or an external request.

Not fixed here — this is inherent to Render's free tier, not a bug in
this codebase. If it matters, options (your call, not done in this pass):
- Hit `/api/billing/run-now` yourself from Settings on the 1st.
- Point a free uptime pinger (e.g. UptimeRobot, cron-job.org) at `/health`
  every ~10 minutes, which incidentally keeps the service awake and lets
  the real cron fire — but that's a third-party dependency, worth
  deciding deliberately rather than wiring up as a drive-by.
- Move to a host without idle-sleep (Fly.io, a small always-on VM, or the
  self-hosted+Tailscale setup above) if the monthly cron needs to be
  reliable without manual intervention.
