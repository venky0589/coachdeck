import { supabase } from './supabase';
import { trySync } from './sync';

// Thin wrappers over the Postgres functions in sql/02-billing.sql.
// Both are idempotent, so calling them on every app-open is safe and cheap.
// The cron job (see the SQL) is the primary trigger; these are the catch-up path
// for a device that was off at midnight on the 1st.

export async function generateInvoicesForThisMonth(): Promise<number | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('generate_monthly_invoices');
  if (error) {
    console.warn('[billing] generate_monthly_invoices failed:', error.message);
    return null;
  }
  await trySync(); // pull the freshly-created invoices into the local mirror
  return data as number; // count of invoices created this run
}

export async function refreshOverdue(): Promise<number | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('mark_overdue_invoices');
  if (error) {
    console.warn('[billing] mark_overdue_invoices failed:', error.message);
    return null;
  }
  return data as number;
}

/** Call once on app launch. */
export async function runMonthStartCatchUp(): Promise<void> {
  await generateInvoicesForThisMonth();
  await refreshOverdue();
}
