-- ============================================================
-- Badminton Coach App — V1 Schema (run first, in the Supabase SQL editor)
-- Mirrors src/types/db.ts. All PKs are client-mintable UUIDs; every synced
-- table carries updated_at for last-write-wins.
-- ============================================================

-- ---- enums ----
create type player_status    as enum ('TRIAL', 'ACTIVE', 'PAUSED', 'DROPPED', 'ALUMNI');
create type billing_type     as enum ('MONTHLY', 'PACKAGE', 'DROP_IN');
create type dominant_hand    as enum ('LEFT', 'RIGHT');
create type attendance_status as enum ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');
create type due_status       as enum ('UNPAID', 'PARTIAL', 'PAID', 'WAIVED');
create type payment_mode     as enum ('CASH', 'UPI', 'BANK_TRANSFER');
create type ledger_type      as enum ('ADVANCE', 'OVERPAYMENT', 'REFUND', 'ADJUSTMENT', 'CONSUMED');
create type hold_policy      as enum ('FREE_FREEZE', 'RETAINER');

-- ---- shared updated_at trigger ----
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---- players ----
create table players (
  id                      uuid primary key default gen_random_uuid(),
  full_name               text not null,
  phone                   text,
  guardian_name           text,
  guardian_phone          text,
  date_of_birth           date,
  dominant_hand           dominant_hand,
  joining_date            date not null,
  status                  player_status not null default 'TRIAL',
  billing_type            billing_type  not null default 'MONTHLY',
  monthly_fee             numeric(10,2) default 0,
  emergency_contact_name  text,
  emergency_contact_phone text,
  medical_notes           text,
  drop_reason             text,
  dropped_date            date,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger t_players_updated before update on players
  for each row execute function set_updated_at();

-- ---- coaches ----
-- A real roster entity (name + active flag), managed under Settings. There is
-- still no per-coach login/PIN or permission model — this table just gives a
-- batch a real coach to point at instead of a free-text label. Deactivating a
-- coach (rather than deleting) keeps past batch assignments intact.
create table coaches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger t_coaches_updated before update on coaches
  for each row execute function set_updated_at();

-- ---- batches ----
create table batches (
  id            uuid primary key default gen_random_uuid(),
  batch_name    text not null,
  start_time    time not null,
  end_time      time not null,
  days_of_week  text[] not null,
  court_number  text,
  max_capacity  int,
  -- Who runs this batch. Nullable — a batch can be unassigned. Not a login:
  -- see the comment on the coaches table above.
  coach_id      uuid references coaches(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger t_batches_updated before update on batches
  for each row execute function set_updated_at();

-- ---- player_batches (a player can be in multiple batches) ----
create table player_batches (
  id            uuid primary key default gen_random_uuid(),
  player_id     uuid not null references players(id) on delete cascade,
  batch_id      uuid not null references batches(id) on delete cascade,
  assigned_date date not null default current_date,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (player_id, batch_id)
);
create trigger t_player_batches_updated before update on player_batches
  for each row execute function set_updated_at();

-- ---- attendance_logs ----
create table attendance_logs (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players(id) on delete cascade,
  batch_id    uuid not null references batches(id) on delete cascade,
  date        date not null,
  status      attendance_status not null default 'PRESENT',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (player_id, batch_id, date)
);
create trigger t_attendance_updated before update on attendance_logs
  for each row execute function set_updated_at();

-- ---- session_cancellations ----
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

-- ---- monthly_dues (invoices) ----
create table monthly_dues (
  id                uuid primary key default gen_random_uuid(),
  player_id         uuid not null references players(id) on delete cascade,
  billing_month     varchar(7) not null,
  base_fee          numeric(10,2) not null,
  discount          numeric(10,2) not null default 0,
  amount_paid       numeric(10,2) not null default 0,
  balance_due       numeric(10,2) not null default 0,
  status            due_status not null default 'UNPAID',
  generated_date    date not null default current_date,
  last_payment_date timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (player_id, billing_month)
);
create trigger t_dues_updated before update on monthly_dues
  for each row execute function set_updated_at();

-- ---- payment_transactions (append-only) ----
create sequence if not exists receipt_no_seq;

create table payment_transactions (
  id             uuid primary key default gen_random_uuid(),
  receipt_no     bigint,
  player_id      uuid not null references players(id) on delete cascade,
  monthly_due_id uuid references monthly_dues(id),
  amount         numeric(10,2) not null,
  payment_mode   payment_mode not null,
  payment_date   timestamptz not null default now(),
  receipt_note   text,
  created_at     timestamptz not null default now()
);

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

-- ---- credit_ledger (wallet, append-only) ----
create table credit_ledger (
  id                     uuid primary key default gen_random_uuid(),
  player_id              uuid not null references players(id) on delete cascade,
  entry_date             timestamptz not null default now(),
  amount                 numeric(10,2) not null,
  balance_after          numeric(10,2) not null,
  type                   ledger_type not null,
  reference_note         text,
  related_transaction_id uuid references payment_transactions(id),
  related_due_id         uuid references monthly_dues(id),
  created_at             timestamptz not null default now()
);

-- ---- session_packages ----
create table session_packages (
  id                 uuid primary key default gen_random_uuid(),
  player_id          uuid not null references players(id) on delete cascade,
  package_name       text not null,
  total_sessions     int  not null,
  sessions_remaining int  not null,
  amount_paid        numeric(10,2) not null default 0,
  purchase_date      date not null default current_date,
  expiry_date        date,
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
  unique (package_id, attendance_id)
);

-- ---- holds (pause / freeze) ----
create table holds (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references players(id) on delete cascade,
  start_date      date not null,
  end_date        date not null,
  reason          text,
  billing_policy  hold_policy not null default 'FREE_FREEZE',
  retainer_amount numeric(10,2),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger t_holds_updated before update on holds
  for each row execute function set_updated_at();

-- ---- app_settings (single row) ----
create table app_settings (
  id                  uuid primary key default gen_random_uuid(),
  academy_name        text,
  default_monthly_fee numeric(10,2),
  proration_mode      text not null default 'DAILY_PRORATE',
  grace_day           int  not null default 7,
  -- PIN lock: salted PBKDF2 hash (see src/lib/pin.ts), not a raw SHA-256
  -- digest — the salt and digit-length ride along, plus a persisted
  -- failed-attempt counter/lockout so brute-force lockout survives a reload.
  coach_pin_hash      text,
  coach_pin_salt      text,
  coach_pin_length    int,
  pin_fail_count      int  not null default 0,
  pin_lock_until      timestamptz,
  updated_at          timestamptz not null default now()
);
create trigger t_settings_updated before update on app_settings
  for each row execute function set_updated_at();

-- ---- stringing_jobs (racquet stringing queue) ----
-- Its own table rather than a JSON blob squeezed into app_settings: that
-- earlier design meant every stringing-board edit rewrote the *entire*
-- coach-settings row (dropping any field the write didn't know about) and
-- broke sync outright, since app_settings has no such column. A real table
-- gets each job its own row — synced and last-write-wins like everything
-- else — and lets the stringing board show up correctly on more than one
-- device.
create table stringing_jobs (
  id           uuid primary key default gen_random_uuid(),
  player_name  text not null,
  racquet      text,
  tension      text,
  gut          text,
  job_date     date not null default current_date,
  status       text not null default 'PENDING' check (status in ('PENDING', 'IN_PROGRESS', 'DONE')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger t_stringing_jobs_updated before update on stringing_jobs
  for each row execute function set_updated_at();

-- Fixed id, not gen_random_uuid()'s default: this table is a single-row
-- singleton, and the client (src/lib/settings.ts, SETTINGS_ID) writes to
-- this exact same id rather than inventing its own. If server and client
-- ever pick different ids for "the" settings row, sync ends up with two of
-- them and which one wins on any given read becomes unpredictable — see
-- sql/03-migrations.sql for the full story and the fix for a database that
-- already has the old random-id row.
insert into app_settings (id, proration_mode, grace_day)
  values ('00000000-0000-0000-0000-000000000001', 'DAILY_PRORATE', 7);

-- ============================================================
-- NOTE ON SECURITY (do before real data):
-- Enable Row Level Security on every table and add policies scoped to the
-- coach's auth user. For a single-user app the simplest correct setup is
-- "authenticated user only". Example for one table:
--
--   alter table players enable row level security;
--   create policy coach_all on players for all to authenticated
--     using (true) with check (true);
--
-- Repeat per table. Never ship with RLS disabled — these are minors' records.
-- ============================================================
