import { openDB, type IDBPDatabase } from 'idb';
import { TABLE_NAMES } from '../types/db';

// One local object store per synced table (keyed by the row's UUID `id`), plus:
//   - `outbox`   : queue of not-yet-pushed mutations (auto-increment key)
//   - `sync_meta`: tiny key/value store (e.g. last successful pull cursor)
//
// We open the DB untyped (store names are dynamic) and enforce row types at the
// data-layer boundary in data.ts / sync.ts instead of via idb's DBSchema generic.
export interface OutboxItem {
  mutation_id?: number; // auto-increment
  table: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown> & { id: string };
  client_ts: string;
  synced: 0 | 1;
}

const DB_NAME = 'coach-app';
// Bump this whenever TABLE_NAMES changes — the upgrade() callback below only
// runs when opening with a version higher than what's already on the device,
// so a new table added without a version bump would never get its object
// store created for anyone who already has the app installed (v2: added
// stringing_jobs as its own store instead of a JSON blob in app_settings;
// v3: added coaches as a real table replacing the coach_name text label).
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        for (const t of TABLE_NAMES) {
          if (!db.objectStoreNames.contains(t)) {
            db.createObjectStore(t, { keyPath: 'id' });
          }
        }
        const outbox = db.createObjectStore('outbox', {
          keyPath: 'mutation_id',
          autoIncrement: true,
        });
        outbox.createIndex('by_synced', 'synced');
        db.createObjectStore('sync_meta', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}
