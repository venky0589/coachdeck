import { getAll, save, where, remove, newId, nowISO, today } from './data';
import type { SessionPackage } from '../types/db';

/** The player's active session package to draw down, preferring one with sessions left. */
export async function activePackage(playerId: string): Promise<SessionPackage | undefined> {
  const pkgs = await where('session_packages', (p) => p.player_id === playerId && p.is_active);
  const withSessions = pkgs.filter((p) => p.sessions_remaining > 0);
  const pool = withSessions.length ? withSessions : pkgs;
  return pool.sort((a, b) => b.purchase_date.localeCompare(a.purchase_date))[0];
}

/**
 * Consume one session from the player's active package for this attendance
 * record, per the spec: "When a billing_type = 'PACKAGE' player is marked
 * PRESENT, insert a usage row and decrement sessions_remaining." Idempotent —
 * checks for an existing session_package_usage row for this
 * (package_id, attendance_id) pair first, mirroring the DB's own unique
 * constraint, so a mutation that syncs twice (or a re-render that calls this
 * twice) never double-decrements.
 *
 * Returns the updated package (so callers can show a low-stock warning), or
 * null if the player has no package to draw from.
 */
export async function consumePackageSession(
  playerId: string,
  attendanceId: string,
): Promise<SessionPackage | null> {
  const pkg = await activePackage(playerId);
  if (!pkg) return null;

  const already = await where(
    'session_package_usage',
    (u) => u.attendance_id === attendanceId && u.package_id === pkg.id,
  );
  if (already.length) return pkg;

  await save('session_package_usage', {
    id: newId(),
    package_id: pkg.id,
    attendance_id: attendanceId,
    used_date: today(),
    created_at: nowISO(),
  });

  return save('session_packages', {
    ...pkg,
    sessions_remaining: Math.max(0, pkg.sessions_remaining - 1),
  });
}

/**
 * Reverse a session consumption for this attendance record — used when the
 * coach cycles a package player's attendance away from PRESENT after having
 * marked them present (a mis-tap, or a correction).
 */
export async function releasePackageSession(attendanceId: string): Promise<void> {
  const usageRows = await where('session_package_usage', (u) => u.attendance_id === attendanceId);
  if (!usageRows.length) return;

  const pkgs = await getAll('session_packages');
  for (const usage of usageRows) {
    const pkg = pkgs.find((p) => p.id === usage.package_id);
    if (pkg) {
      await save('session_packages', {
        ...pkg,
        sessions_remaining: Math.min(pkg.total_sessions, pkg.sessions_remaining + 1),
      });
    }
    await remove('session_package_usage', usage.id);
  }
}
