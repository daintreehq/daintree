/**
 * "Where projects are open" may have changed (#12597). An invalidation only —
 * listeners re-read the live state rather than being told what moved, because
 * the state has too many writers for a delta to stay honest (#10808).
 *
 * Fired from the few places every ownership change passes through: a view
 * manager's inventory and active pointer, activation claims, and window
 * registration. A leaf with no Electron imports, so each of those can reach it.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function notifyProjectPresenceChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // A listener runs inside a view-manager mutation. It must never be able
      // to abort one halfway.
      console.error("[projectPresence] change listener threw:", error);
    }
  }
}

export function onProjectPresenceChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
