-- ============================================================
-- Incremental migrations for a database that already ran 01-schema.sql
-- before this change. Safe to run multiple times (IF NOT EXISTS guards).
-- A brand-new database only needs 01-schema.sql + 02-billing.sql — these
-- columns are already in 01-schema.sql there.
-- ============================================================

alter table app_settings add column if not exists coach_pin_salt text;
alter table app_settings add column if not exists coach_pin_length int;
alter table app_settings add column if not exists pin_fail_count int not null default 0;
alter table app_settings add column if not exists pin_lock_until timestamptz;

-- The PIN hashing scheme changed from a raw unsalted SHA-256 digest to
-- salted PBKDF2 (src/lib/pin.ts). An old coach_pin_hash value is not a valid
-- PBKDF2 digest and will never match again — clear it so the app treats the
-- account as "no PIN set" instead of permanently locking the coach out.
-- Re-set the PIN from Settings → Security after running this.
update app_settings set coach_pin_hash = null where coach_pin_salt is null and coach_pin_hash is not null;

-- Stringing Board moved off the app_settings JSON blob into its own table.
create table if not exists stringing_jobs (
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
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 't_stringing_jobs_updated') then
    create trigger t_stringing_jobs_updated before update on stringing_jobs
      for each row execute function set_updated_at();
  end if;
end $$;

-- Consolidate app_settings onto a fixed, well-known id ----------------------
-- app_settings is documented as "single row" but 01-schema.sql's seed
-- insert let Postgres pick a random id (gen_random_uuid()), and the client
-- (src/lib/settings.ts) independently picked its *own* random id the first
-- time it ran locally before any sync had happened. Once synced, the
-- client ended up with two app_settings rows — the server's original,
-- PIN-less one and the client's with the coach PIN on it — and
-- getAll('app_settings')[0] on the client (IndexedDB iteration order,
-- which follows primary-key sort, not recency) picked whichever one
-- sorted first, unpredictably. That's what made PIN setup look broken: a
-- reload could read back the *other* row, with no PIN on it, or with a
-- salt/hash pair that doesn't match what the coach just typed. This block
-- (and the matching client-side fix using the same fixed id) makes both
-- sides converge on one row. Safe to run more than once.
do $$
declare
  keeper uuid;
  fixed_id constant uuid := '00000000-0000-0000-0000-000000000001';
begin
  if (select count(*) from app_settings) = 0 then
    insert into app_settings (id, proration_mode, grace_day) values (fixed_id, 'DAILY_PRORATE', 7);
    return;
  end if;

  if exists (select 1 from app_settings where id = fixed_id) then
    keeper := fixed_id;
  else
    -- Prefer whichever existing row actually has a PIN set — that's a real
    -- completed setup, not a blank default — else the most recently touched one.
    select id into keeper from app_settings
      order by (coach_pin_hash is not null) desc, updated_at desc
      limit 1;
  end if;

  delete from app_settings where id <> keeper;
  update app_settings set id = fixed_id where id = keeper and id <> fixed_id;
end $$;

-- Free-text "who runs this batch" label — not a coach account/login, see
-- the comment on this column in 01-schema.sql.
alter table batches add column if not exists coach_name text;

-- Coaches as a real entity ---------------------------------------------------
-- batches.coach_name started as a free-text label (no coach accounts existed
-- yet). Now that a real coaches table exists (id, name, active flag — still
-- no login/PIN per coach, just a roster Settings manages), batches should
-- point at a coach_id instead. This block creates the table if it isn't
-- there yet, adds coach_id, backfills it from any existing coach_name text
-- (creating a coach row per distinct name if needed), then drops coach_name.
-- Safe to run more than once.
create table if not exists coaches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 't_coaches_updated') then
    create trigger t_coaches_updated before update on coaches
      for each row execute function set_updated_at();
  end if;
end $$;

alter table batches add column if not exists coach_id uuid references coaches(id) on delete set null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'batches' and column_name = 'coach_name'
  ) then
    -- One coach row per distinct existing coach_name, reusing a coach that
    -- already has that name (in case this block runs after a partial
    -- earlier attempt) rather than creating duplicates.
    insert into coaches (name)
    select distinct b.coach_name
    from batches b
    where b.coach_name is not null
      and not exists (select 1 from coaches c where c.name = b.coach_name);

    update batches b
    set coach_id = c.id
    from coaches c
    where b.coach_name is not null
      and b.coach_id is null
      and c.name = b.coach_name;

    alter table batches drop column coach_name;
  end if;
end $$;
