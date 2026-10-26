import { useSyncExternalStore } from "react";

/**
 * The section's disclosures: one preference each for the whole machine,
 * deliberately not host-scoped or per-project, so the section reads the same
 * from every window on every host. Every project view shares one storage
 * partition, so the key alone is enough.
 */
export const PROJECT_HOSTS_EXPANDED_KEY = "daintree_project_hosts_expanded";
/** Whether the hosts past the first few are shown. */
export const PROJECT_HOSTS_ALL_SHOWN_KEY = "daintree_project_hosts_all_shown";

interface DevicePreference {
  read(): boolean;
  subscribe(listener: () => void): () => void;
  set(value: boolean): void;
}

function devicePreference(key: string, fallback: boolean): DevicePreference {
  const listeners = new Set<() => void>();
  /** What this view was last set to when storage refused it. */
  let unpersisted: boolean | null = null;

  return {
    read() {
      if (unpersisted !== null) return unpersisted;
      try {
        // storage-key: daintree_project_hosts_expanded daintree_project_hosts_all_shown
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : stored === "true";
      } catch {
        return fallback;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      // Another view's change arrives as a storage event; this view's own, through the set.
      const onStorage = (event: StorageEvent) => {
        if (event.key !== key && event.key !== null) return;
        // Another view wrote it, so storage works again: what it holds now wins.
        unpersisted = null;
        listener();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    set(value) {
      try {
        // storage-key: daintree_project_hosts_expanded daintree_project_hosts_all_shown
        localStorage.setItem(key, String(value));
        unpersisted = null;
      } catch {
        // A session that cannot persist still gets the toggle, for this view.
        unpersisted = value;
      }
      for (const listener of listeners) listener();
    },
  };
}

const expanded = devicePreference(PROJECT_HOSTS_EXPANDED_KEY, true);
const allShown = devicePreference(PROJECT_HOSTS_ALL_SHOWN_KEY, false);

/** Open by default; a view that can't read storage stays open. */
export function useProjectHostsExpanded(): boolean {
  return useSyncExternalStore(expanded.subscribe, expanded.read, () => true);
}

export function setProjectHostsExpanded(value: boolean): void {
  expanded.set(value);
}

/** Folded by default: the first few hosts, then one row for the rest. */
export function useProjectHostsAllShown(): boolean {
  return useSyncExternalStore(allShown.subscribe, allShown.read, () => false);
}

export function setProjectHostsAllShown(value: boolean): void {
  allShown.set(value);
}
