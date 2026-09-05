import { getDB, type OutboxItem } from './idb';
import { emitChange } from './events';
import { supabase } from './supabase';
import { TABLE_NAMES } from '../types/db';

// Single-user app: no real concurrency, so conflict handling is deliberately simple —
// push the queued mutations in order, then pull anything the server changed since the
// last pull and merge by last-write-wins (newer updated_at wins). The database's own
// unique constraints are the real safety net against double-applied mutations.

let syncing = false;
let lastError: string | null = null;

export function getSyncError() {
  return lastError;
}

export async function trySync(): Promise<void> {
  if (syncing) return;
  if (!supabase) return; // backend not configured — stay fully offline
  if (!navigator.onLine) return;

  syncing = true;
  try {
    await pushOutbox();
    await pullRemote();
    lastError = null;
    emitChange();
  } catch (e) {
    // Leave the queue intact; we retry on the next trigger.
    lastError = e instanceof Error ? e.message : String(e);
    console.warn('[sync] deferred:', lastError);
  } finally {
    syncing = false;
  }
}

async function pushOutbox(): Promise<void> {
  const db = await getDB();
  const pending = (await db.getAllFromIndex('outbox', 'by_synced', 0)) as OutboxItem[];
  // Preserve insertion order so dependencies (a due before its payment) go first.
  pending.sort((a, b) => (a.mutation_id ?? 0) - (b.mutation_id ?? 0));

  for (const m of pending) {
    if (m.op === 'delete') {
      const { error } = await supabase!.from(m.table).delete().eq('id', m.payload.id);
      if (error) throw error;
    } else {
      const { error } = await supabase!.from(m.table).upsert(m.payload);
      if (error) throw error;
    }
    if (m.mutation_id != null) await db.delete('outbox', m.mutation_id); // only after server confirms
  }
}

async function pullRemote(): Promise<void> {
  const db = await getDB();
  const meta = await db.get('sync_meta', 'last_pull');
  const since = meta?.value ?? '1970-01-01T00:00:00Z';
  const nowStr = new Date().toISOString();

  for (const table of TABLE_NAMES) {
    // payment_transactions and credit_ledger are append-only and have no updated_at;
    // pull them by created_at instead.
    const cursorCol =
      table === 'payment_transactions' ||
      table === 'credit_ledger' ||
      table === 'session_package_usage'
        ? 'created_at'
        : 'updated_at';

    const { data, error } = await supabase!.from(table).select('*').gt(cursorCol, since);
    if (error) throw error;
    if (!data) continue;

    const tx = db.transaction(table, 'readwrite');
    const store = tx.objectStore(table);
    for (const remote of data as Array<Record<string, any>>) {
      const local = (await store.get(remote.id)) as Record<string, any> | undefined;
      const remoteTs = remote[cursorCol];
      const localTs = local?.[cursorCol];
      // Last-write-wins: keep whichever version is newer (or the remote if new to us).
      if (!local || !localTs || new Date(remoteTs) >= new Date(localTs)) {
        await store.put(remote);
      }
    }
    await tx.done;
  }

  await db.put('sync_meta', { key: 'last_pull', value: nowStr });
}

// ---- wiring: when to attempt a sync ----------------------------------------

let installed = false;
export function installSyncTriggers(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('online', () => void trySync());
  window.addEventListener('focus', () => void trySync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void trySync();
  });
  setInterval(() => void trySync(), 60_000); // gentle safety net while the app is open
  void trySync(); // initial sync on load
}
