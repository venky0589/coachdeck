# Badminton Coach App — V1 Technical Spec

Single-user (coach-only) · Calendar-month billing · Offline-first PWA · Supabase (Postgres) backend

This document covers two things:
- **Part A** — the V1 database schema (Postgres DDL, ready to run in Supabase)
- **Part B** — the offline outbox sync pattern (IndexedDB + sync-on-reconnect)

A few design rules run through everything and are worth stating up front:

- **All primary keys are client-generated UUIDs.** Offline devices create records before the server sees them, so we can never rely on server auto-increment for a PK — two offline creates would collide. The client mints the UUID.
- **Every table carries `updated_at`.** This is the tiebreaker for last-write-wins during sync.
- **Money is append-only where it matters.** The credit ledger and payment transactions are never edited in place — corrections are new rows. This is what makes the financial history auditable.
- **Fees are snapshotted, not referenced.** An invoice copies the fee at the moment it's generated. Changing a player's fee later never rewrites a past invoice.

---

## Part A — Database Schema (V1)

### Enums

```sql
create type player_status    as enum ('TRIAL', 'ACTIVE', 'PAUSED', 'DROPPED', 'ALUMNI');
create type billing_type     as enum ('MONTHLY', 'PACKAGE', 'DROP_IN');
create type dominant_hand     as enum ('LEFT', 'RIGHT');
create type attendance_status as enum ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');
create type due_status        as enum ('UNPAID', 'PARTIAL', 'PAID', 'WAIVED');
create type payment_mode      as enum ('CASH', 'UPI', 'BANK_TRANSFER');
create type ledger_type       as enum ('ADVANCE', 'OVERPAYMENT', 'REFUND', 'ADJUSTMENT', 'CONSUMED');
create type hold_policy       as enum ('FREE_FREEZE', 'RETAINER');
```

### Shared `updated_at` trigger

Every table uses this so last-write-wins has a reliable timestamp.

```sql
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
```

### players

Note the changes from the original draft: `is_active` boolean is gone (replaced by the `status` enum), `batch_id` is gone (moved to a join table so a player can be in more than one batch), and emergency/medical fields are promoted into V1 for safety.

```sql
create table players (
  id                      uuid primary key default gen_random_uuid(),
  full_name               text not null,
  phone                   text,
  guardian_name           text,
  guardian_phone          text,
  date_of_birth           date,                       -- age category is COMPUTED from this, never stored
  dominant_hand           dominant_hand,
  joining_date            date not null,
  status                  player_status not null default 'TRIAL',
  billing_type            billing_type  not null default 'MONTHLY',
  monthly_fee             numeric(10,2) default 0,     -- only meaningful when billing_type = MONTHLY
  emergency_contact_name  text,
  emergency_contact_phone text,
  medical_notes           text,
  drop_reason             text,                        -- filled when status -> DROPPED
  dropped_date            date,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger t_players_updated before update on players
  for each row execute function set_updated_at();
```

Why these choices:
- **`status` enum instead of a boolean** lets a TRIAL player take attendance and appear in rosters without generating an invoice, and lets PAUSED/DROPPED be distinct states with different billing behaviour.
- **`drop_reason`** is the single most valuable retention dataset the coach will own over a year. Capture it every time.
- **age category is computed**, not stored, because U-13/U-15 shifts every tournament cycle and a stored value goes stale.

### batches

```sql
create table batches (
  id            uuid primary key default gen_random_uuid(),
  batch_name    text not null,                 -- "Morning Advanced"
  start_time    time not null,                 -- 06:00
  end_time      time not null,                 -- 07:30
  days_of_week  text[] not null,               -- ['MON','WED','FRI']
  court_number  text,
  max_capacity  int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger t_batches_updated before update on batches
  for each row execute function set_updated_at();
```

### player_batches (join — a player can be in multiple batches)

```sql
create table player_batches (
  id            uuid primary key default gen_random_uuid(),
  player_id     uuid not null references players(id) on delete cascade,
  batch_id      uuid not null references batches(id) on delete cascade,
  assigned_date date not null default current_date,
  is_active     boolean not null default true,   -- soft-remove from a batch without losing history
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (player_id, batch_id)
);
create trigger t_player_batches_updated before update on player_batches
  for each row execute function set_updated_at();
```

Even if the V1 UI keeps batch assignment feeling like "one batch per player," modelling it as a join table now means morning+evening players don't require a schema migration later.

### attendance_logs

```sql
create table attendance_logs (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players(id) on delete cascade,
  batch_id    uuid not null references batches(id) on delete cascade,
  date        date not null,
  status      attendance_status not null default 'PRESENT',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (player_id, batch_id, date)             -- one record per player per batch per day
);
create trigger t_attendance_updated before update on attendance_logs
  for each row execute function set_updated_at();
```

The unique constraint makes roll-call **idempotent** — retapping a player just updates the existing row, which matters when the same offline action syncs twice.

### session_cancellations

Lets the coach cancel a session (rain, holiday, illness) so attendance reports and per-session accounting aren't distorted by a day that never happened.

```sql
create table session_cancellations (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references batches(id) on delete cascade,
  date        date not null,
  reason      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (batch_id, date)
);
create trigger t_cancellations_updated before update on session_cancellations
  for each row execute function set_updated_at();
```

### monthly_dues (auto-generated invoices)

```sql
create table monthly_dues (
  id                uuid primary key default gen_random_uuid(),
  player_id         uuid not null references players(id) on delete cascade,
  billing_month     varchar(7) not null,          -- '2026-09'
  base_fee          numeric(10,2) not null,        -- SNAPSHOT of monthly_fee at generation time
  discount          numeric(10,2) not null default 0,
  amount_paid       numeric(10,2) not null default 0,
  balance_due       numeric(10,2) not null default 0,
  status            due_status not null default 'UNPAID',
  generated_date    date not null default current_date,
  last_payment_date timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (player_id, billing_month)                -- prevents duplicate invoices for the same month
);
create trigger t_dues_updated before update on monthly_dues
  for each row execute function set_updated_at();
```

**Generation logic** (run on the 1st, and defensively on app-open in case the device was off):
- Only for players with `status = 'ACTIVE'` and `billing_type = 'MONTHLY'`. TRIAL, PAUSED, DROPPED are skipped.
- `base_fee` is copied from `players.monthly_fee` **now** and frozen.
- Mid-month join → prorate: `base_fee = round(monthly_fee * remaining_days / days_in_month)`, using the join date. (The proration mode is configurable in `app_settings` — daily-prorate / half-month / full-month.)
- Arrears carry over: any prior unpaid `balance_due` is *not* merged into the new invoice; instead "total payable" is computed at read time as the sum of all unpaid dues for the player. Keeping invoices per-month makes history and receipts clean.

### payment_transactions (append-only)

```sql
create sequence receipt_no_seq;   -- server-side, sequential, immutable

create table payment_transactions (
  id             uuid primary key default gen_random_uuid(),
  receipt_no     bigint,                          -- assigned on SYNC, not offline (see note)
  player_id      uuid not null references players(id) on delete cascade,
  monthly_due_id uuid references monthly_dues(id), -- nullable: an advance isn't tied to a specific due
  amount         numeric(10,2) not null,
  payment_mode   payment_mode not null,
  payment_date   timestamptz not null default now(),
  receipt_note   text,
  created_at     timestamptz not null default now()
);
```

Transactions are **never edited or deleted** — a mistake is corrected with a new offsetting transaction plus a ledger adjustment. That's what makes the money trail trustworthy.

**Receipt number + offline (important subtlety):** a sequential receipt number cannot be safely generated on an offline device. So the transaction's PK is a client UUID (created instantly, offline-safe), while `receipt_no` is left null and assigned from `receipt_no_seq` **when the row reaches the server**. Offline receipts display as "Receipt pending" until synced, then show their permanent number. Do this with a Supabase trigger:

```sql
create or replace function assign_receipt_no()
returns trigger as $$
begin
  if new.receipt_no is null then
    new.receipt_no := nextval('receipt_no_seq');
  end if;
  return new;
end;
$$ language plpgsql;

create trigger t_assign_receipt before insert on payment_transactions
  for each row execute function assign_receipt_no();
```

### credit_ledger (the player wallet — append-only)

This is the piece the original schema was missing. It represents money the academy *holds for* a player (advance, overpayment) or *owes back* (refund). A player's live credit balance is the running total.

```sql
create table credit_ledger (
  id                     uuid primary key default gen_random_uuid(),
  player_id              uuid not null references players(id) on delete cascade,
  entry_date             timestamptz not null default now(),
  amount                 numeric(10,2) not null,   -- +ve = credit added, -ve = credit consumed/refunded out
  balance_after          numeric(10,2) not null,   -- running balance for audit
  type                   ledger_type not null,
  reference_note         text,
  related_transaction_id uuid references payment_transactions(id),
  related_due_id         uuid references monthly_dues(id),
  created_at             timestamptz not null default now()
);
```

How it flows:
- Parent pays 3 months upfront → one `ADVANCE` entry (+amount). No pre-created future invoices.
- On the 1st, when a new invoice is generated and the player has credit, auto-apply it: a `CONSUMED` entry (−fee) and the due's `amount_paid` is set accordingly.
- Player overpays a due → `OVERPAYMENT` entry (+excess) instead of a negative balance.
- Player quits with credit left → `REFUND` entry (−amount) records money going back out.
- `balance_after` gives you the wallet balance without summing the whole table each read, and gives an audit trail if a number is ever disputed.

### session_packages (the "12-session card")

```sql
create table session_packages (
  id                 uuid primary key default gen_random_uuid(),
  player_id          uuid not null references players(id) on delete cascade,
  package_name       text not null,                 -- "12-Session Card"
  total_sessions     int  not null,
  sessions_remaining int  not null,
  amount_paid        numeric(10,2) not null default 0,
  purchase_date      date not null default current_date,
  expiry_date        date,                          -- nullable
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger t_packages_updated before update on session_packages
  for each row execute function set_updated_at();

create table session_package_usage (
  id            uuid primary key default gen_random_uuid(),
  package_id    uuid not null references session_packages(id) on delete cascade,
  attendance_id uuid references attendance_logs(id) on delete set null,
  used_date     date not null default current_date,
  created_at    timestamptz not null default now(),
  unique (package_id, attendance_id)               -- a given attendance decrements a package at most once
);
```

When a `billing_type = 'PACKAGE'` player is marked PRESENT, insert a usage row and decrement `sessions_remaining`. The `unique(package_id, attendance_id)` constraint makes this safe under duplicate sync. Warn on the dashboard when `sessions_remaining <= 2`.

### holds (pause / freeze)

```sql
create table holds (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references players(id) on delete cascade,
  start_date      date not null,
  end_date        date not null,
  reason          text,                            -- "exam leave", "vacation"
  billing_policy  hold_policy not null default 'FREE_FREEZE',
  retainer_amount numeric(10,2),                   -- used only when policy = RETAINER
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger t_holds_updated before update on holds
  for each row execute function set_updated_at();
```

Billing interaction:
- A hold covering a **full** calendar month → skip that month's invoice (or generate a retainer invoice if policy = RETAINER).
- Resume **mid-month** → prorate from the resume date, reusing the exact mid-month-join proration formula.
- Set the player's `status` to PAUSED for the hold's duration so it's visible everywhere; flip back to ACTIVE on resume.

### app_settings (single row of coach preferences)

```sql
create table app_settings (
  id              uuid primary key default gen_random_uuid(),
  academy_name    text,
  default_monthly_fee numeric(10,2),
  proration_mode  text not null default 'DAILY_PRORATE',  -- DAILY_PRORATE | HALF_MONTH | FULL_MONTH
  grace_day       int  not null default 7,                 -- day of month after which unpaid = OVERDUE
  coach_pin_hash  text,                                     -- app-level lock for the minors' PII
  updated_at      timestamptz not null default now()
);
create trigger t_settings_updated before update on app_settings
  for each row execute function set_updated_at();
```

---

## Part B — Offline Outbox Sync Pattern

Because there's exactly one user, we don't need conflict-free replicated data types or a real-time sync engine. The occasional case is the same coach on a phone and a laptop, almost never editing the same row at the same second. A plain **outbox queue with last-write-wins** is enough.

The shape of it:

```
User taps  ──▶  Write to IndexedDB (data store)   ──▶  UI re-renders instantly (optimistic)
                        │
                        └──▶  Append mutation to IndexedDB (outbox store)
                                        │
        online / focus / interval  ─────┘
                                        ▼
                              Drain outbox → push to Supabase
                                        ▼
                        Pull remote changes since last cursor → merge by updated_at
```

### IndexedDB setup (using the `idb` helper)

```js
import { openDB } from 'idb';

const db = await openDB('coach-app', 1, {
  upgrade(db) {
    // Local mirror of each synced table, keyed by the record's UUID.
    for (const t of [
      'players', 'batches', 'player_batches', 'attendance_logs',
      'session_cancellations', 'monthly_dues', 'payment_transactions',
      'credit_ledger', 'session_packages', 'session_package_usage',
      'holds', 'app_settings'
    ]) {
      db.createObjectStore(t, { keyPath: 'id' });
    }
    // The queue of not-yet-synced mutations.
    const outbox = db.createObjectStore('outbox', { keyPath: 'mutation_id', autoIncrement: true });
    outbox.createIndex('by_synced', 'synced');

    // A tiny store to remember the last successful pull time.
    db.createObjectStore('sync_meta', { keyPath: 'key' });
  },
});
```

### Writing data (every create/update goes through here)

The record is written to the local mirror **and** enqueued in the outbox in a single transaction, so the UI and the pending queue can never disagree.

```js
import { v4 as uuidv4 } from 'uuid';

async function saveLocal(table, record, op = 'upsert') {
  // Always client-mint the id and stamp updated_at locally.
  record.id = record.id ?? uuidv4();
  record.updated_at = new Date().toISOString();

  const tx = db.transaction([table, 'outbox'], 'readwrite');
  await tx.objectStore(table).put(record);                // local mirror → instant UI read
  await tx.objectStore('outbox').add({
    table,
    op,                        // 'upsert' | 'delete'
    payload: record,
    client_ts: record.updated_at,
    synced: 0,
  });
  await tx.done;

  trySync();                   // fire-and-forget; safe to call any time
  return record;
}
```

So a court-side roll-call tap is: `saveLocal('attendance_logs', { player_id, batch_id, date, status: 'PRESENT' })`. It returns immediately whether or not there's signal.

### Draining the outbox (push)

```js
import { supabase } from './supabaseClient';

let syncing = false;

async function trySync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    await pushOutbox();
    await pullRemote();
  } catch (e) {
    // Leave the queue intact; we retry on the next trigger.
    console.warn('sync deferred:', e);
  } finally {
    syncing = false;
  }
}

async function pushOutbox() {
  const pending = await db.getAllFromIndex('outbox', 'by_synced', 0);
  // Preserve order: dependencies (e.g. a due before its payment) must sync first.
  pending.sort((a, b) => a.mutation_id - b.mutation_id);

  for (const m of pending) {
    if (m.op === 'delete') {
      const { error } = await supabase.from(m.table).delete().eq('id', m.payload.id);
      if (error) throw error;
    } else {
      // upsert is idempotent — a mutation that syncs twice is harmless.
      const { error } = await supabase.from(m.table).upsert(m.payload);
      if (error) throw error;
    }
    await db.delete('outbox', m.mutation_id);   // only remove after server confirms
  }
}
```

### Pulling remote changes (last-write-wins merge)

```js
const TABLES = [
  'players', 'batches', 'player_batches', 'attendance_logs',
  'session_cancellations', 'monthly_dues', 'payment_transactions',
  'credit_ledger', 'session_packages', 'session_package_usage',
  'holds', 'app_settings'
];

async function pullRemote() {
  const meta = await db.get('sync_meta', 'last_pull');
  const since = meta?.value ?? '1970-01-01T00:00:00Z';
  const now = new Date().toISOString();

  for (const table of TABLES) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .gt('updated_at', since);          // only rows changed since last pull
    if (error) throw error;

    for (const remote of data) {
      const local = await db.get(table, remote.id);
      // Last-write-wins: keep whichever version was updated most recently.
      if (!local || new Date(remote.updated_at) >= new Date(local.updated_at)) {
        await db.put(table, remote);
      }
    }
  }
  await db.put('sync_meta', { key: 'last_pull', value: now });
}
```

### When to trigger a sync

```js
window.addEventListener('online', trySync);          // connection returned
window.addEventListener('focus', trySync);           // user reopened the tab/app
document.addEventListener('visibilitychange', () => { // PWA brought to foreground
  if (document.visibilityState === 'visible') trySync();
});
setInterval(trySync, 60_000);                        // gentle safety net while open
```

### Things this pattern deliberately keeps simple

- **Conflict resolution is last-write-wins by `updated_at`.** With one user this is almost never exercised; the cost of anything fancier isn't justified.
- **`payment_transactions` and `credit_ledger` are append-only**, so they never conflict — two devices can only ever *add* rows, never fight over editing one.
- **Idempotency is enforced in the DB** (the `unique(...)` constraints on attendance, dues, package usage). That's the real safety net: even if a mutation is pushed twice after a flaky connection, the database rejects the duplicate rather than double-counting.
- **Receipt numbers are assigned server-side on insert**, so offline transactions get their permanent, gap-free number only once they land — which is the correct behaviour for a financial record.

---

## Backup note (don't skip this)

Supabase's free tier does not guarantee retained backups, and these are financial + minors' records. Build the CSV/Excel export (players, dues, transactions, ledger) early and schedule a weekly automated dump to object storage. The export doubles as the coach's portable backup and as disaster recovery — it's close to free and it's the difference between "annoying" and "catastrophic" if the project is ever lost.
