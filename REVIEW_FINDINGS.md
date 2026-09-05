# Code Review — Badminton Coach App (against `badminton-coach-v1-spec.md`)

Reviewed: full `src/`, `server/`, `sql/`, `tests/`, config, and the spec/README against what's
actually implemented. The scaffold's reference patterns (offline write path, `data.ts`/`sync.ts`/
`idb.ts`, RollCall, CollectPayment) are solid and match the spec closely. The screens built *on
top* of that foundation (Batches, Holds, Packages, Settings, Stringing, the local API server)
introduce several real bugs — three of them serious enough to lose money, lose data, or expose
minors' PII. Findings below are ordered by severity, with file/line references.

---

## Critical

### 1. The "backend" is an unauthenticated Express server exposed on the LAN — not Supabase
`.env.local` points `VITE_SUPABASE_URL` at `http://192.168.0.156:3001`, and `server/index.js` is a
hand-written Express server (not Supabase) that mimics a slice of the PostgREST API. It has:
- **No authentication of any kind** — `GET/POST/DELETE /rest/v1/:table` accept any request from
  anyone who can reach that IP.
- **`app.use(cors())` with no origin restriction** — any website, from any device on the network,
  can call it cross-origin.
- A hardcoded default DB password (`123456`) and default `postgres` superuser.

The spec is explicit that this data — kids' medical notes, guardian phone numbers, payment
history — needs RLS ("**Never ship with RLS disabled — these are minors' records**"). The schema's
RLS note (`sql/01-schema.sql` bottom) is dead weight now: it only applies if you deploy to real
Supabase. As shipped, anyone on the same Wi-Fi as the coach (a badminton hall's guest network,
for instance) can read or edit every player's PII and every transaction with a single `curl`.
**This needs an auth layer (API key check, or actually deploying to Supabase with RLS) before
this touches real data.**

### 2. Editing basic Settings silently deletes all Stringing Board data
`StringingBoard.tsx` stores its jobs by piggy-backing an ad-hoc `stringing_jobs` JSON field onto
the single `app_settings` row (comment at the top says "no schema change needed").
`Settings.tsx`'s `saveSettings()` (src/screens/Settings.tsx:39-49) writes a **brand new object**
built from scratch — it does not spread `...settings` first, so any field not in that literal
(including `stringing_jobs`) is dropped:

```ts
async function saveSettings() {
    await save('app_settings', {
        id: settings?.id ?? newId(),
        academy_name: academyName || null,
        default_monthly_fee: ...,
        proration_mode: proration,
        grace_day: ...,
        coach_pin_hash: settings?.coach_pin_hash ?? null,
        updated_at: new Date().toISOString(),
    });
}
```
`save()` → IndexedDB `put()` **replaces the whole record** (it's not a merge). This function
fires `onBlur` on the academy-name and fee inputs, and on every proration-mode click — i.e. on
nearly every visit to Settings. The first time a coach tweaks the academy name after adding a
stringing job, every stringing job on the board disappears with no warning. (`setPinHash()` right
below it does this correctly, by spreading `...settings` first — so the bug is inconsistent
within the same file, not a deliberate design choice.)

**Fix:** spread `...settings` in `saveSettings()`, or better, stop overloading `app_settings` for
unrelated data — give Stringing Board its own IDB store (it doesn't need to sync to Postgres at
all if it's meant to stay device-local).

### 3. That same ad-hoc field will jam the sync queue for everything once a backend is connected
`stringing_jobs` isn't a column in `sql/01-schema.sql`'s `app_settings` table. `pushOutbox()`
(src/lib/sync.ts:44-53) processes the outbox **in strict order** and `throw`s on the first
server error without removing that item from the queue:
```ts
for (const m of pending) {
  ...
  const { error } = await supabase!.from(m.table).upsert(m.payload);
  if (error) throw error;          // <- aborts the whole push
  if (m.mutation_id != null) await db.delete('outbox', m.mutation_id);
}
```
The moment a `stringing_jobs`-bearing `app_settings` mutation reaches the outbox, the server
(real Supabase *or* the local Express server, both backed by the real Postgres schema) will
reject it with "column stringing_jobs does not exist." That mutation is never removed from the
queue, so it head-of-line-blocks every mutation queued after it — attendance, payments, everything
— forever, on every sync attempt. Same root cause as #2; same fix.

### 4. Overpayments and advance payments vanish — the credit ledger is dead code
`collectPayment()` (src/lib/payments.ts:19-73) returns `{ appliedToDues, excess }`, and the
comment says recording `excess` as an `OVERPAYMENT` ledger entry was "kept out of here to keep the
reference simple." But `CollectPayment.tsx:44` calls it and **discards the return value entirely**
— it's never wired up anywhere. Search the whole `src/` tree for `credit_ledger` writes: there are
none. The only place a `credit_ledger` row is ever created is server-side, inside
`generate_monthly_invoices()` (`sql/02-billing.sql`) — and that function only ever *consumes*
credit, never *creates* it. So:
- A parent who pays 3 months upfront (spec's own example) has that money recorded only as a plain
  `payment_transactions` row with no `monthly_due_id` — it's not lost from the till, but it will
  never auto-apply to next month's invoice, and the coach has no "wallet balance" visibility into
  it (`PlayerProfile.tsx` wallet card will always read ₹0).
- A parent who overpays a due by ₹200 has that ₹200 silently disappear from tracking — not
  refunded, not credited, not visible anywhere.

This is the exact feature the spec calls "the piece the original schema was missing" — it's
modeled correctly in the schema but has no client code path that ever populates it.

**Fix:** in `collectPayment()`, when `excess > 0`, write a `credit_ledger` row
(`type: 'ADVANCE'` or `'OVERPAYMENT'`, `balance_after` = prior balance + excess), and surface it
in `CollectPayment.tsx`'s confirmation screen.

---

## High

### 5. Roll call only ever works for one batch — multi-batch academies can't take attendance
`Batches.tsx` is a full batch CRUD screen with per-batch roster assignment, clearly built to
support multiple batches (morning/evening, different courts). But `RollCall` is mounted in
`App.tsx:113` as `<RollCall />` with **no `batchId` passed**, and there is no batch picker inside
`RollCall.tsx` itself. Its batch-resolution logic:
```ts
const batch = batches?.find((b) => (batchId ? b.id === batchId : true));
```
With `batchId` always `undefined`, this always resolves to `batches[0]` — whichever batch happens
to come back first from IndexedDB. There is no navigation path from `Batches.tsx` (or anywhere
else) into `RollCall` with a specific batch selected. The moment a coach creates a second batch,
that batch's roll call becomes permanently unreachable from the UI — attendance can only ever be
taken for one arbitrary batch. Same gap in `HoldForm`/`Batches` roster flows is fine (they're
per-player or per-batch screens reached directly), but the daily "take attendance" workflow — the
app's headline use case — silently breaks for any academy with more than one batch.

**Fix:** add a batch selector to `RollCall` (mirroring the one already built in
`AttendanceReport.tsx`), and pass the active batch id through.

### 6. Client-side "catch-up" billing never runs against the actual backend
The spec calls for `generate_monthly_invoices`/`mark_overdue_invoices` to run defensively on
app-open, for a phone that was off at midnight on the 1st. `src/lib/billing.ts` implements this
via `supabase.rpc('generate_monthly_invoices')`, which POSTs to `/rest/v1/rpc/generate_monthly_invoices`
(standard PostgREST RPC convention). **`server/index.js` has no `/rest/v1/rpc/*` route at all** —
only `GET/POST/DELETE /rest/v1/:table`. So every app-open catch-up call 404s, is caught, logged as
a warning, and silently does nothing. In practice invoices only get generated by the Express
server's own internal `node-cron` job or its own catch-up-on-startup check — never by the client,
regardless of how many times the app is opened. If the coach's laptop (running `server/index.js`)
is off on the 1st and stays off, invoices for that month never generate until someone thinks to
hit the "Run now" button in Settings.

**Fix:** either add `/rest/v1/rpc/:fn` handling to `server/index.js` (proxy to `pool.query('select
<fn>($1)', ...)`), or drop the client-side RPC calls and rely solely on the server's cron + manual
trigger.

### 7. Session packages never decrement — the whole "12-session card" feature is inert
`PackageForm.tsx` creates a `session_packages` row with `sessions_remaining = total_sessions`.
Nothing else in the codebase ever writes to `session_package_usage` or decrements
`sessions_remaining` — `RollCall.tsx`'s `cycle()`/`markAllPresent()` mark attendance without ever
checking `player.billing_type === 'PACKAGE'`. Per spec: "When a `billing_type = 'PACKAGE'` player
is marked PRESENT, insert a usage row and decrement `sessions_remaining`." As shipped, a
package-billed player can attend forever and their card never runs low — the low-stock warning in
`PlayerProfile.tsx` (`sessions_remaining <= 2`) can never trigger truthfully, and there is no way
to reconcile package usage against actual attendance at all.

**Fix:** in `RollCall`'s attendance-save path, when the player's `billing_type === 'PACKAGE'`,
look up their active `session_packages` row and, on transition to `PRESENT`, `save()` a decrement
plus a `session_package_usage` row (respecting the `unique(package_id, attendance_id)` constraint
the spec calls out for idempotency).

### 8. Holds never resume the player back to ACTIVE — and that silently stops future billing
`HoldForm.tsx:43-53` flips a player to `PAUSED` when a hold covers today, but nothing in the app
ever flips them back to `ACTIVE` when the hold's `end_date` passes (there's no scheduled check —
this is a client with no background job). This isn't just cosmetic: `generate_monthly_invoices()`
(`sql/02-billing.sql:104`) only processes `where status = 'ACTIVE'`. A player stuck at `PAUSED`
after their hold ends is **silently excluded from all future invoice generation** — even though
`compute_month_fee()`'s day-by-day walk would correctly bill their active days — until the coach
notices (there's no dashboard signal for this) and manually edits their status in `PlayerForm`.
For a paying academy this is a quiet revenue leak.

**Fix:** on app-open (or whenever `PlayerProfile`/`Home` loads), sweep holds whose `end_date` has
passed for `PAUSED` players and flip them back to `ACTIVE`; same sweep should also catch
future-dated holds that have now started (today's code only pauses at hold-creation time, not
when the start date later arrives).

---

## Medium

### 9. `sql/run-billing.sql` references a column that doesn't exist
```sql
SELECT p.full_name, md.billing_month, md.gross_amount, md.balance_due, md.status
FROM monthly_dues md ...
```
`monthly_dues` has no `gross_amount` column (it's `base_fee`/`discount`/`amount_paid`/
`balance_due`, per both `sql/01-schema.sql` and `src/types/db.ts`). Running this script as
documented (`psql ... -f sql/run-billing.sql`) fails on the verification `SELECT` after the
invoices are generated. Should be `md.base_fee` (or `md.base_fee - md.discount`).

### 10. Settings' "Run now" billing button is hardcoded to `localhost:3001`
```ts
const r = await fetch('http://localhost:3001/api/billing/run-now', { method: 'POST' });
```
`.env.local` deliberately points the sync layer at a LAN IP (`192.168.0.156`) so a phone on the
same Wi-Fi can reach the coach's laptop — but this button ignores that and always calls
`localhost`, which only resolves to *the device the button is tapped on*. From any phone, this
will always fail with "Server not reachable," even when the server is up and sync is otherwise
working fine. Should read `import.meta.env.VITE_SUPABASE_URL` instead of the literal.

### 11. `billing-engine.sql` is a duplicate of `sql/02-billing.sql`
Byte-identical (confirmed via diff) but lives at the project root outside `sql/`, with no
indication of which is authoritative. Harmless today, but two agents editing "the billing engine"
in two different files is a guaranteed future drift bug. Worth deleting one and keeping the copy
under `sql/`.

---

## Low

### 12. `tests/app.spec.ts` doesn't match the actual UI — it can't be passing
Checked every locator against the real screens:
- `text=Badminton Coach` — no such string anywhere in `src/` (Home's header is "Today").
- `h2:has-text('Roll Call')` — `RollCall.tsx` renders the batch name as its `<h2>`, never the
  literal "Roll Call".
- `h2:has-text('Collect Fee')` — `CollectPayment.tsx` renders `<h2>Collect payment</h2>` (and
  then the player's name), never "Collect Fee".
- `h2:has-text('Active Players')` — `PlayerList.tsx` renders `<h2>Players</h2>`.
- `.player-list-item` — this class does not exist anywhere in the codebase (rows are plain
  `<li><button class="row ...">`), so that count assertion is always `0`, always failing
  `toBeGreaterThan(5)`.

Only the Stringing-tab and Settings-tab assertions line up with the real markup. This suggests the
test file was written against an earlier or intended UI and never re-run against the finished
screens — as it stands it documents nothing and would fail CI immediately if wired up.

### 13. Minor: `RollCall` roll-call actions stay enabled during a cancelled session
When `isCancelled` is true, a banner shows, but the roster list below it is still fully tappable
and `markAllPresent` is still available — nothing stops the coach from recording attendance for a
day already marked cancelled. Probably fine to leave as a soft warning rather than a hard block,
but worth a deliberate decision either way rather than leaving it implicit.

---

## What's solid (for context)

- The core offline write path (`data.ts` → IndexedDB `put` + outbox enqueue in one transaction,
  `emitChange()`, `trySync()`) matches the spec's pattern exactly and looks correct.
- `sql/02-billing.sql`'s `compute_month_fee()` day-by-day walk correctly unifies mid-month joins,
  partial holds, and mid-month resumes into one formula, exactly as the spec describes, and its
  RETAINER proration math is right.
- `payment_transactions`/`credit_ledger` are correctly treated as append-only everywhere they're
  touched (nothing calls `remove()` on them — in fact `remove()` isn't called anywhere in the app).
- Receipt-number deferral (`receipt_no: null` client-side, assigned by the `t_assign_receipt`
  trigger server-side) is implemented correctly per spec.
- CSV export/backup (`export.ts`, `Settings.tsx`) covers the tables the spec's "don't skip this"
  backup note asks for.

## Suggested fix order
1. Lock down `server/index.js` (auth + origin restriction) before any real player data touches it — #1.
2. Fix `saveSettings()`'s missing spread — #2/#3, one-line fix, stops active data loss.
3. Wire `collectPayment()`'s `excess` into a `credit_ledger` write — #4.
4. Add a batch selector to `RollCall` — #5.
5. Add package decrement on PRESENT, hold-resume sweep, RPC route (or drop client RPC calls) — #6/#7/#8.
6. Clean up the SQL/test loose ends — #9–#13.
