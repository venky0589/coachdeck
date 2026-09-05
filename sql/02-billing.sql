-- ============================================================
-- Badminton Coach App — Billing Engine (DAILY_PRORATE)
-- Postgres / Supabase. Idempotent. Safe to run repeatedly.
-- ============================================================
--
-- Proration rule (DAILY_PRORATE):
--   fee = round( monthly_fee * billable_days / days_in_month )
--
-- "billable_days" = days in the month where the player is:
--   - already joined (day >= joining_date), AND
--   - not covered by a FREE_FREEZE hold.
--
-- This single definition automatically covers all three cases:
--   • mid-month join   → days before joining_date are excluded
--   • partial hold     → held days are excluded
--   • mid-month resume → held days before resume excluded, active days after billed
--
-- RETAINER holds are not "free": each retainer-held day adds
-- (retainer_amount / days_in_month) to the invoice, so the slot
-- is charged at the reduced rate while frozen.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Per-player monthly fee calculation
-- ------------------------------------------------------------
create or replace function compute_month_fee(p_player_id uuid, p_month date)
returns numeric as $$
declare
  v_first          date := date_trunc('month', p_month)::date;
  v_last           date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_days_in_month  int  := extract(day from v_last);
  v_monthly_fee    numeric;
  v_joining        date;
  v_billable_days  int := 0;
  v_retainer_total numeric := 0;
  d                date;
  v_hold_policy    hold_policy;
  v_retainer       numeric;
begin
  select monthly_fee, joining_date
    into v_monthly_fee, v_joining
  from players
  where id = p_player_id;

  if v_monthly_fee is null then
    return 0;
  end if;

  -- Walk each day of the month and classify it.
  for d in select generate_series(v_first, v_last, interval '1 day')::date loop

    -- Not enrolled yet on this day.
    if d < v_joining then
      continue;
    end if;

    -- Is this day covered by a hold?
    select h.billing_policy, h.retainer_amount
      into v_hold_policy, v_retainer
    from holds h
    where h.player_id = p_player_id
      and d between h.start_date and h.end_date
    order by h.start_date
    limit 1;

    if found then
      -- Held day. FREE_FREEZE contributes nothing; RETAINER contributes a prorated slice.
      if v_hold_policy = 'RETAINER' then
        v_retainer_total := v_retainer_total + (coalesce(v_retainer, 0) / v_days_in_month);
      end if;
    else
      -- Active, billable day.
      v_billable_days := v_billable_days + 1;
    end if;

  end loop;

  return round( (v_monthly_fee * v_billable_days / v_days_in_month) + v_retainer_total );
end;
$$ language plpgsql;


-- ------------------------------------------------------------
-- 2. Invoice generation for a whole month
--    Run on the 1st (pg_cron) AND defensively on app-open.
--    ON CONFLICT-style guard makes double runs harmless.
-- ------------------------------------------------------------
create or replace function generate_monthly_invoices(p_month date default current_date)
returns int as $$
declare
  v_first     date        := date_trunc('month', p_month)::date;
  v_month_str varchar(7)  := to_char(v_first, 'YYYY-MM');
  r           record;
  v_fee       numeric;
  v_credit    numeric;
  v_applied   numeric;
  v_due_id    uuid;
  v_count     int := 0;
begin
  for r in
    select id
    from players
    where status = 'ACTIVE'
      and billing_type = 'MONTHLY'
  loop
    -- Skip if this player already has an invoice for the month (idempotent).
    if exists (
      select 1 from monthly_dues
      where player_id = r.id and billing_month = v_month_str
    ) then
      continue;
    end if;

    -- What does this player owe for the month, after proration/holds?
    v_fee := compute_month_fee(r.id, v_first);

    -- A fully free-frozen month (or not-yet-joined) produces no invoice.
    if v_fee <= 0 then
      continue;
    end if;

    -- Auto-apply any wallet credit the player is holding.
    select coalesce(balance_after, 0)
      into v_credit
    from credit_ledger
    where player_id = r.id
    order by entry_date desc, created_at desc
    limit 1;
    v_credit  := coalesce(v_credit, 0);
    v_applied := least(greatest(v_credit, 0), v_fee);

    insert into monthly_dues (
      player_id, billing_month, base_fee, discount,
      amount_paid, balance_due, status, generated_date
    )
    values (
      r.id, v_month_str, v_fee, 0,
      v_applied, v_fee - v_applied,
      case
        when v_fee - v_applied <= 0 then 'PAID'::due_status
        when v_applied > 0          then 'PARTIAL'::due_status
        else 'UNPAID'::due_status
      end,
      current_date
    )
    returning id into v_due_id;

    -- Record the credit consumption as a ledger entry.
    if v_applied > 0 then
      insert into credit_ledger (
        player_id, amount, balance_after, type, reference_note, related_due_id
      )
      values (
        r.id, -v_applied, v_credit - v_applied, 'CONSUMED',
        'Auto-applied to invoice ' || v_month_str, v_due_id
      );
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;  -- number of invoices created this run
end;
$$ language plpgsql;


-- ------------------------------------------------------------
-- 3. Mark overdue invoices (run daily, or on app-open)
--    Anything unpaid/partial past the configured grace day.
-- ------------------------------------------------------------
create or replace function mark_overdue_invoices(p_today date default current_date)
returns int as $$
declare
  v_grace_day int;
  v_count     int := 0;
begin
  select coalesce(grace_day, 7) into v_grace_day from app_settings limit 1;
  v_grace_day := coalesce(v_grace_day, 7);

  -- Only relevant once we're past the grace day of the current month.
  if extract(day from p_today) <= v_grace_day then
    return 0;
  end if;

  -- We keep the enum as-is (UNPAID/PARTIAL); "overdue" is a derived flag in the UI:
  --   overdue = (status in ('UNPAID','PARTIAL')) AND (billing_month <= current month)
  --             AND (day-of-month > grace_day)
  -- If you prefer a stored flag, add monthly_dues.is_overdue boolean and set it here.
  select count(*) into v_count
  from monthly_dues
  where status in ('UNPAID', 'PARTIAL')
    and billing_month <= to_char(p_today, 'YYYY-MM');

  return v_count;  -- count of currently-overdue invoices
end;
$$ language plpgsql;


-- ------------------------------------------------------------
-- 4. Schedule the monthly run with pg_cron (Supabase supports it)
--    Fires at 00:05 on the 1st of every month.
-- ------------------------------------------------------------
-- select cron.schedule(
--   'monthly-invoice-generation',
--   '5 0 1 * *',
--   $$ select generate_monthly_invoices(current_date); $$
-- );


-- ============================================================
-- App-open defensive call (client side)
-- ------------------------------------------------------------
-- The cron job is the primary trigger, but a phone that was off
-- at midnight on the 1st must still catch up. Call this on launch;
-- it's idempotent, so it does nothing if invoices already exist:
--
--   await supabase.rpc('generate_monthly_invoices');
--   await supabase.rpc('mark_overdue_invoices');
--
-- Both are cheap for a single-user dataset and safe to call every open.
-- ============================================================
