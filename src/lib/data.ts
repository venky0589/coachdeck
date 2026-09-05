import { getDB } from './idb';
import { emitChange } from './events';
import { trySync } from './sync';
import type { Tables, TableName } from '../types/db';

// ---- helpers ---------------------------------------------------------------

export const newId = () => crypto.randomUUID();
export const nowISO = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
export const thisMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

// ---- writes ----------------------------------------------------------------

/**
 * Write a record local-first: it lands in IndexedDB immediately (so the UI updates
 * with zero latency, online or off) and is queued in the outbox for the next sync.
 * Returns the stored record (with id + updated_at filled in).
 *
 * Pass a partial record; id/updated_at are minted here if absent. Because IDB `put`
 * is an upsert and the DB has unique constraints, a mutation that syncs twice is safe.
 */
export async function save<T extends TableName>(
  table: T,
  record: Partial<Tables[T]> & Record<string, unknown>,
): Promise<Tables[T]> {
  const row = {
    ...record,
    id: (record.id as string) ?? newId(),
    updated_at: nowISO(),
  } as unknown as Tables[T] & { id: string; updated_at: string };

  const db = await getDB();
  const tx = db.transaction([table, 'outbox'], 'readwrite');
  await tx.objectStore(table).put(row);
  await tx.objectStore('outbox').add({
    table,
    op: 'upsert',
    payload: row as unknown as Record<string, unknown> & { id: string },
    client_ts: row.updated_at,
    synced: 0,
  });
  await tx.done;

  emitChange();
  void trySync(); // fire-and-forget; no-op when offline or backend not configured
  return row;
}

export async function remove(table: TableName, id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([table, 'outbox'], 'readwrite');
  await tx.objectStore(table).delete(id);
  await tx.objectStore('outbox').add({
    table,
    op: 'delete',
    payload: { id },
    client_ts: nowISO(),
    synced: 0,
  });
  await tx.done;

  emitChange();
  void trySync();
}

// ---- reads (from the local mirror) -----------------------------------------

export async function getAll<T extends TableName>(table: T): Promise<Tables[T][]> {
  const db = await getDB();
  return (await db.getAll(table)) as unknown as Tables[T][];
}

export async function getOne<T extends TableName>(
  table: T,
  id: string,
): Promise<Tables[T] | undefined> {
  const db = await getDB();
  return (await db.get(table, id)) as unknown as Tables[T] | undefined;
}

export async function where<T extends TableName>(
  table: T,
  predicate: (row: Tables[T]) => boolean,
): Promise<Tables[T][]> {
  const all = await getAll(table);
  return all.filter(predicate);
}
