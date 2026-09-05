import { getAll, save, today } from './data';

/**
 * Reconcile player status against holds for "today":
 *   - an ACTIVE player whose hold now covers today → PAUSED
 *   - a PAUSED player with no hold covering today, but who *has* hold
 *     history → ACTIVE (resume)
 *
 * Previously HoldForm only ever paused a player at the moment a hold was
 * created that already covered today — a hold scheduled to start later
 * never paused anyone until the coach happened to revisit that form, and
 * nothing ever flipped a player back once their hold ended. That second gap
 * matters for billing: generate_monthly_invoices() (sql/02-billing.sql)
 * only processes `status = 'ACTIVE'` players, so a player stuck at PAUSED
 * after their hold ended was silently excluded from every invoice after
 * that until someone noticed and fixed it by hand.
 *
 * Deliberately conservative about "resume": a PAUSED player with *no* hold
 * record at all is left alone — that's a coach manually pausing someone
 * outside the holds feature, and this sweep has no way to know that isn't
 * intentional, so it only ever resumes a pause it can trace to a hold that
 * has now ended.
 */
export async function sweepHolds(): Promise<{ paused: number; resumed: number }> {
  const d = today();
  const [players, holds] = await Promise.all([getAll('players'), getAll('holds')]);

  let paused = 0;
  let resumed = 0;

  for (const p of players) {
    if (p.status !== 'ACTIVE' && p.status !== 'PAUSED') continue; // TRIAL/DROPPED/ALUMNI untouched

    const holdsForPlayer = holds.filter((h) => h.player_id === p.id);
    const onHoldToday = holdsForPlayer.some((h) => h.start_date <= d && d <= h.end_date);

    if (p.status === 'ACTIVE' && onHoldToday) {
      await save('players', { ...p, status: 'PAUSED' });
      paused++;
    } else if (p.status === 'PAUSED' && !onHoldToday && holdsForPlayer.length > 0) {
      await save('players', { ...p, status: 'ACTIVE' });
      resumed++;
    }
  }

  return { paused, resumed };
}

// ---- wiring: check on the same cadence as sync (app-open, focus, daily-ish) ----

let installed = false;
export function installHoldSweepTriggers(): void {
  if (installed) return;
  installed = true;
  void sweepHolds();
  window.addEventListener('focus', () => void sweepHolds());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sweepHolds();
  });
  // A hold boundary only ever matters once a day (dates, not times) — no need
  // for anything near sync's 60s cadence; this just catches an app left open
  // across midnight.
  setInterval(() => void sweepHolds(), 30 * 60_000);
}
