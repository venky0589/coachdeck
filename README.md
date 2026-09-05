# Coach — Badminton Academy (V1 scaffold)

A coach-only, offline-first PWA for a single badminton academy: court-side roster,
one-tap attendance, and fast fee collection. Calendar-month billing with daily
proration. Built with React + Vite + TypeScript + Supabase.

This is the **spec-critical foundation** — the parts that are fiddly to get right and
don't need a live backend to be correct. A coding agent (or you) can build the
remaining screens on top of these patterns. See "What's here / what's not" below.

## Run it

```bash
npm install
npm run dev
```

It runs immediately with **no backend** — open the app and tap **Load demo data** on
the Today screen to populate a batch, players, and open invoices. Attendance and
payments work fully offline against IndexedDB.

To connect Supabase:

1. Create a project at supabase.com.
2. In the SQL editor, run `sql/01-schema.sql` then `sql/02-billing.sql`.
3. Enable Row Level Security and add per-table policies (there's a note at the bottom
   of `01-schema.sql`). **Don't skip this — these are minors' records.**
4. Copy `.env.example` to `.env.local` and fill in your project URL and anon key.
5. Restart `npm run dev`. The app now syncs.

Build for deploy (static PWA — host on Cloudflare Pages / Vercel):

```bash
npm run build && npm run preview
```

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

Here (stable foundation):
- Full data-access + offline sync layer
- TypeScript types mirroring the schema (`src/types/db.ts`)
- Schema + billing SQL
- PWA config (installable, offline app shell)
- Two reference screens: **Roll call** (`src/screens/RollCall.tsx`) and
  **Collect payment** (`src/screens/CollectPayment.tsx`)

Not here (build next, copying the reference patterns):
- Player CRUD / profile, batch configurator
- Holds/pause UI, session-package UI, stringing board
- Dashboard "month-start collection bar", overdue list + WhatsApp reminders
- Auth screen + coach PIN lock
- CSV/Excel export (also serves as backup)

## Stack notes

- System font stack on purpose — no external font fetch keeps it working offline.
- No `localStorage`/`sessionStorage` for data — all local data is in IndexedDB.
- Single accent colour (green) is spent on the primary action and the "present" state;
  everything else stays quiet.
