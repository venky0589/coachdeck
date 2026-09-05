import { getAll, save, remove, nowISO } from './data';
import type { AppSettings } from '../types/db';

// Fixed, well-known id for the app_settings singleton row — the client
// writes to *this exact id*, matching the row sql/01-schema.sql seeds
// server-side, rather than each side inventing its own random UUID.
//
// That's what used to happen: getSettings() minted a fresh random id the
// first time it ran locally, before any sync had connected to the server —
// which already had its own row, seeded with Postgres's default
// gen_random_uuid(). Once sync ran, the client ended up with two
// app_settings rows (the server's original, PIN-less one, and the client's
// with the coach PIN on it), and getAll('app_settings')[0] — IndexedDB
// iteration order, which follows primary-key sort, not recency — returned
// whichever one happened to sort first. Symptom: PIN setup looked like it
// silently didn't take, or a correct PIN got rejected, depending on which
// of the two rows a given reload happened to read. A fixed id closes that
// off entirely: there is only ever one row to find.
export const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

const DEFAULTS: Omit<AppSettings, 'id' | 'updated_at'> = {
  academy_name: null,
  default_monthly_fee: null,
  proration_mode: 'DAILY_PRORATE',
  grace_day: 7,
  coach_pin_hash: null,
  coach_pin_salt: null,
  coach_pin_length: null,
  pin_fail_count: 0,
  pin_lock_until: null,
};

/**
 * The single app_settings row, filled in with defaults for any field an
 * older row predates.
 *
 * Self-heals an install from before SETTINGS_ID existed, which may already
 * have more than one app_settings row: if the canonical row isn't there
 * yet but others are, this picks the best candidate — preferring one with
 * a PIN set, since that represents a real completed setup rather than a
 * blank default — saves it under the fixed id, and removes the stray
 * row(s), so this only ever has to happen once per device.
 */
export async function getSettings(): Promise<AppSettings> {
  const all = await getAll('app_settings');
  const canonical = all.find((r) => r.id === SETTINGS_ID);
  if (canonical) return { ...DEFAULTS, ...canonical } as AppSettings;

  if (all.length > 0) {
    const best =
      all.find((r) => r.coach_pin_hash) ??
      all.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    const consolidated = await save('app_settings', { ...best, id: SETTINGS_ID });
    await Promise.all(all.filter((r) => r.id !== SETTINGS_ID).map((r) => remove('app_settings', r.id)));
    return { ...DEFAULTS, ...consolidated } as AppSettings;
  }

  return { ...DEFAULTS, id: SETTINGS_ID, updated_at: nowISO() } as AppSettings;
}

/**
 * Merge `patch` into the current settings row and save it.
 *
 * Always reads the current row first, so a partial update (set the PIN,
 * bump the grace day, record a failed PIN attempt) can never silently drop
 * fields it didn't touch. Every write to app_settings should go through
 * this — writing a hand-built literal via `save('app_settings', {...})`
 * directly is what previously wiped unrelated fields on every autosave.
 * Always writes under SETTINGS_ID regardless of what `current.id` was, so
 * a legacy row this just consolidated (or is about to) always converges
 * onto the one canonical row.
 */
export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  return save('app_settings', { ...current, ...patch, id: SETTINGS_ID, updated_at: nowISO() });
}
