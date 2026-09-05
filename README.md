# Coach — Badminton Academy

A coach-only, offline-first PWA for running a badminton academy: attendance,
billing/dues, payments, session packages, holds, and stringing jobs. Built with
React + Vite + TypeScript, IndexedDB as the local source of truth, and a small
Express server (`server/index.js`) that mimics enough of the Supabase/PostgREST
REST surface for `@supabase/supabase-js` to talk to plain Postgres. **This is not
real Supabase** — see CLAUDE.md's "What this project is" for why, and its
"Security / auth" section for what that does and doesn't protect against.

## Run it locally

```bash
npm install
npm run dev
```

It runs immediately with **no backend** — open the app and tap **Load demo data**
on the Today screen to populate batches, players, coaches, and open invoices.
Attendance and payments work fully offline against IndexedDB.

To connect the backend:

1. Create a Postgres database, then run `sql/01-schema.sql`, `sql/02-billing.sql`,
   then `sql/03-migrations.sql` (idempotent — safe even on a fresh database) against
   it. **This holds minors' records** — make sure the database itself isn't
   network-exposed beyond what you intend.
2. Copy `server/.env.example` to `server/.env` and fill in `DB_PASSWORD` (and set
   `API_KEY` explicitly rather than letting it auto-generate, once you have more
   than one place that needs to match it).
3. Copy `.env.example` to `.env.local`, set `VITE_SUPABASE_URL` to wherever
   `server/index.js` is reachable and `VITE_SUPABASE_ANON_KEY` to match `API_KEY`.
4. `npm run dev:all` (starts the Vite dev server + API server together). The app
   now syncs.

## Deploying

See **`DEPLOY.md`** for the actual deploy setup in use (self-hosted, fronted by
Tailscale for real HTTPS without exposing anything to the public internet, systemd
for process supervision, nightly `pg_dump` backups). `npm run build` produces the
static PWA in `dist/`; `server/index.js` serves it itself in production (one
process, one origin — see the "static app" section in that file) rather than
splitting the frontend onto a separate static host like Cloudflare Pages/Vercel,
which would put the API server back behind a mismatched HTTP/HTTPS origin.

## How the offline-first layer works

Everything reads and writes IndexedDB first, so the UI never waits on the network.

- **`src/lib/data.ts`** — `save()` / `remove()` write to the local mirror and queue a
  mutation in the outbox, then fire a sync. `getAll()` / `where()` read the mirror.
- **`src/lib/sync.ts`** — the outbox engine. On reconnect/focus/interval it pushes
  queued mutations in order, then pulls remote changes and merges last-write-wins.
- **`src/lib/idb.ts`** — the IndexedDB stores (one per table + `outbox` + `sync_meta`).
- **`src/hooks/useLiveQuery.ts`** — re-runs a reader whenever local data changes, so
  components stay in sync with no extra state library.

Key invariants (don't break these):

- **PKs are client-minted UUIDs** (`crypto.randomUUID()`), so records can be created
  offline without collisions.
- **Writes are idempotent** — IDB `put` is an upsert and the DB has unique constraints,
  so a mutation that syncs twice is harmless.
- **Money tables are append-only.** `payment_transactions` and `credit_ledger` are
  never edited; corrections are new rows. Receipt numbers are assigned server-side on
  insert (offline receipts show as pending until synced).

## Billing

`sql/02-billing.sql` holds the DAILY_PRORATE engine. `compute_month_fee` counts a
player's *billable days* (joined, not under a free-freeze hold), which covers mid-month
joins, partial holds, and mid-month resumes with one formula. `generate_monthly_invoices`
is idempotent and runs both via pg_cron (the 1st) and on app-open
(`src/lib/billing.ts` → `runMonthStartCatchUp`) as a catch-up.

## What's here / what's not

See `CLAUDE.md` for the full history (six passes: review, hardening, PIN +
responsive + seed data, an app_settings sync bug, wiring up the Batches
screen, and a real coaches table) and `STATUS.md` for a plain-language
snapshot of what's working right now. Short version: everything in the
original spec is built — attendance, billing/dues, payments, session
packages, holds, stringing jobs, CSV export, a mandatory coach PIN, and a
coaches roster. What's deliberately *not* built: per-coach login/accounts
(one PIN gates the whole app; see CLAUDE.md's "Coaches" section for why
that's not the same feature) and player-side batch assignment (only works
from the Batches screen's roster editor today).

## Stack notes

- System font stack on purpose — no external font fetch keeps it working offline.
- No `localStorage`/`sessionStorage` for data — all local data is in IndexedDB.
- Single accent colour (green) is spent on the primary action and the "present" state;
  everything else stays quiet.
