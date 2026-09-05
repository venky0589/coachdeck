// Minimal toast/notification bus — replaces the handful of blocking
// `alert()`/`confirm()` calls scattered around the app (e.g. the billing
// "Run now" button) with a non-blocking, dismissable message consistent with
// the rest of the UI.

export type ToastTone = 'default' | 'success' | 'error';
export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn([...items]);
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn);
  fn([...items]);
  return () => listeners.delete(fn);
}

export function toast(message: string, tone: ToastTone = 'default', durationMs = 3200): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  items = [...items, { id, message, tone }];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== id);
    emit();
  }, durationMs);
}

export function dismissToast(id: string): void {
  items = items.filter((i) => i.id !== id);
  emit();
}
