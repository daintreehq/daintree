export interface DevicePreference {
  read(): boolean;
  subscribe(listener: () => void): () => void;
  set(value: boolean): void;
}

/**
 * A boolean the whole machine shares: one preference over `localStorage`,
 * written by whichever view toggles it and followed by every other view
 * through the `storage` event. A view that can't persist still gets the
 * toggle for itself, until another view's write proves storage works again.
 * Every project view shares one storage partition, so the key alone scopes it.
 */
export function devicePreference(key: string, fallback: boolean): DevicePreference {
  const listeners = new Set<() => void>();
  /** What this view was last set to when storage refused it. */
  let unpersisted: boolean | null = null;

  return {
    read() {
      if (unpersisted !== null) return unpersisted;
      try {
        // storage-key: daintree_project_hosts_expanded daintree_project_hosts_all_shown daintree_agent_usage_expanded
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
        // storage-key: daintree_project_hosts_expanded daintree_project_hosts_all_shown daintree_agent_usage_expanded
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
