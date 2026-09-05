import { useEffect, useRef, useState } from 'react';
import { onDataChange } from '../lib/events';

/**
 * Reactive read from IndexedDB. Runs `fetcher` on mount and again whenever any local
 * data changes (a write or a pull). Keeps components free of manual refresh wiring.
 */
export function useLiveQuery<T>(fetcher: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [data, setData] = useState<T>();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    const run = () => {
      fetcherRef.current().then((r) => {
        if (alive) setData(r);
      });
    };
    run();
    const unsub = onDataChange(run);
    return () => {
      alive = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return data;
}
