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
