import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// The app is offline-first: it must run before a backend is configured. When the
// env vars are absent, `supabase` is null and the sync layer simply stays idle —
// every write still lands in IndexedDB and the UI works normally.
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

export const isBackendConfigured = () => supabase !== null;

/**
 * Build a URL against the configured backend for a plain `fetch()` call
 * outside the supabase-js client (e.g. the billing "Run now" button).
 * Reads the same VITE_SUPABASE_URL the client itself was created with,
 * instead of a hardcoded `localhost` — which only ever resolves to whichever
 * device the button is tapped on, not necessarily the machine running the
 * server (the whole reason .env.local points at a LAN IP in the first
 * place: so a coach's phone can reach a laptop running the API server).
 */
export function apiUrl(path: string): string {
  const base = (url ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

/** Headers a raw fetch() needs to pass the server's API-key check (see server/index.js). */
export function apiHeaders(): HeadersInit {
  return anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {};
}
