// Minimal change bus. Anything that mutates local data (a write, or a pull from the
// server) calls emitChange(); the useLiveQuery hook re-runs its fetcher on that signal.
// This keeps the whole app reading from IndexedDB with no extra state library.

type Listener = () => void;
const listeners = new Set<Listener>();

export function onDataChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitChange(): void {
  for (const fn of listeners) fn();
}
