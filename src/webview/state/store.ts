import { useCallback, useSyncExternalStore } from 'react';

/**
 * A subscribe-with-a-selector store.
 *
 * The editor holds one large object and roughly eighty controls read from it.
 * With context, every keystroke would re-render all eighty. Here a control
 * subscribes to the one value it draws, so typing a host name re-renders the
 * host box, the summary line and the probe strip, and nothing else.
 */
export interface Store<S> {
  getState(): S;
  setState(update: (state: S) => S): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(update) {
      const next = update(state);
      if (next === state) {
        return;
      }
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

/**
 * Reads one derived value out of a store and re-renders when it changes.
 *
 * `select` has to keep its identity between renders. React reads the snapshot
 * during render and then, whenever the getter is a different function than
 * last time, schedules a passive effect and a store-consistency check that
 * call it twice more. A selector written inline is a new function every
 * render, so a page of eighty controls pays eighty of those on every pass —
 * never wrong, never warned about, and invisible until the page is large.
 *
 * Hold the selector at the call site with `useCallback`, or hoist it to module
 * scope when it closes over nothing. `useField` and the four sidebar hooks are
 * the sanctioned ways to read a per-item value, and each one does this.
 */
export function useStoreSelector<S, T>(store: Store<S>, select: (state: S) => T): T {
  const snapshot = useCallback(() => select(store.getState()), [store, select]);
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
