import { useState, useSyncExternalStore } from "react";
import { usePluginKitViewHost, type PluginKitViewHost } from "@/components/PluginKit/kitViewHost";

/**
 * The prefix a remembered value's key takes in the panel's persisted bag, so
 * it cannot collide with keys the view persists itself.
 */
export const VIEW_STATE_KEY_PREFIX = "kit:viewState:";

interface ViewStateStore {
  /** Values set in this view since it mounted; restored values are read from the mount bag. */
  values: Map<string, { value: unknown }>;
  listeners: Map<string, Set<() => void>>;
}

function createStore(): ViewStateStore {
  return { values: new Map(), listeners: new Map() };
}

// One store per mounted view attempt, so every hook with the same key agrees,
// and a component that unmounts and comes back inside the same attempt sees
// what was set since the mount snapshot was taken.
const stores = new WeakMap<PluginKitViewHost, ViewStateStore>();
// Outside a plugin view (a test, a preview harness) values live for the document.
const detached = createStore();

function storeFor(host: PluginKitViewHost | null): ViewStateStore {
  if (!host) return detached;
  let store = stores.get(host);
  if (!store) {
    store = createStore();
    stores.set(host, store);
  }
  return store;
}

/** A value read back from disk still has the shape of the default it replaces. */
function sameShape<T>(saved: unknown, fallback: T): saved is T {
  if (saved === undefined) return false;
  if (fallback === null || fallback === undefined) return true;
  if (Array.isArray(fallback)) return Array.isArray(saved);
  if (typeof fallback === "object") {
    return typeof saved === "object" && saved !== null && !Array.isArray(saved);
  }
  return typeof saved === typeof fallback;
}

/** The value as it would come back from disk, or `undefined` when it cannot be stored. */
function roundTrip(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * A value this key's setter stored. Every hook sharing a key shares its type,
 * which is the one claim here the compiler cannot check.
 */
function isSetByThisKey<T>(_value: unknown): _value is T {
  return true;
}

function isUpdater<T>(value: T | ((current: T) => T)): value is (current: T) => T {
  return typeof value === "function";
}

/**
 * `useState` that the view remembers: a selected tab, a split size, a filter.
 * It survives the view unmounting (a sibling pane maximised, a dock tab left),
 * a reload and an app restart, stored on the panel through the host's
 * `persistState` under `key`. Values must be JSON; one that is not is kept
 * until the view unmounts. A saved value whose type no longer matches `initial`
 * (a string where a number is now expected) is ignored; the check is by
 * type only, not a deep shape. Where the host keeps no panel record, such as
 * a settings view, the value lasts until the view unmounts.
 */
export function usePersistentViewState<T>(
  key: string,
  initial: T | (() => T)
): [T, (next: T | ((current: T) => T)) => void] {
  const host = usePluginKitViewHost();
  const store = storeFor(host);
  const storageKey = VIEW_STATE_KEY_PREFIX + (typeof key === "string" ? key : String(key));

  // The default decides what shape a stored value must have to be used.
  const [fallback] = useState(() => (isUpdater(initial) ? initial() : initial));

  // Pure, and the same object until something is set: a value set since the
  // mount wins, else the restored one if it still has the default's shape,
  // else the default. Only restored data is checked; a set value is the hook's own.
  const read = (): T => {
    const entry = store.values.get(storageKey);
    if (entry && isSetByThisKey<T>(entry.value)) return entry.value;
    const saved = host?.initialArgs?.[storageKey];
    return sameShape(saved, fallback) ? saved : fallback;
  };

  const subscribe = (listener: () => void) => {
    let set = store.listeners.get(storageKey);
    if (!set) {
      set = new Set();
      store.listeners.set(storageKey, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

  const value = useSyncExternalStore(subscribe, read, read);

  const setValue = (next: T | ((current: T) => T)) => {
    const resolved = isUpdater(next) ? next(read()) : next;
    const entry = store.values.get(storageKey);
    if (entry && Object.is(resolved, entry.value)) return;
    store.values.set(storageKey, { value: resolved });
    const stored = roundTrip(resolved);
    if (stored === undefined) {
      if (import.meta.env.DEV) {
        console.warn(
          `[plugin-ui] usePersistentViewState("${key}"): the value is not JSON, so it is kept only until the view unmounts.`
        );
      }
    } else {
      host?.persistState?.({ [storageKey]: stored });
    }
    for (const listener of store.listeners.get(storageKey) ?? []) listener();
  };

  return [value, setValue];
}
