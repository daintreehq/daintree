import { useSyncExternalStore } from "react";

/**
 * One preference for the whole machine, deliberately not host-scoped or
 * per-project: the section reads the same from every window on every host.
 * Every project view shares one storage partition, so the key alone is enough.
 */
export const PROJECT_HOSTS_EXPANDED_KEY = "daintree_project_hosts_expanded";

const listeners = new Set<() => void>();

/** What this view was last set to when storage refused it. */
let unpersisted: boolean | null = null;

function read(): boolean {
  if (unpersisted !== null) return unpersisted;
  try {
    return localStorage.getItem(PROJECT_HOSTS_EXPANDED_KEY) !== "false";
  } catch {
    return true;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another view's change arrives as a storage event; this view's own, through the set.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PROJECT_HOSTS_EXPANDED_KEY && event.key !== null) return;
    // Another view wrote it, so storage works again: what it holds now wins.
    unpersisted = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setProjectHostsExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(PROJECT_HOSTS_EXPANDED_KEY, String(expanded));
    unpersisted = null;
  } catch {
    // A session that cannot persist still gets the toggle, for this view.
    unpersisted = expanded;
  }
  for (const listener of listeners) listener();
}

/** Open by default; a view that can't read storage stays open. */
export function useProjectHostsExpanded(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
