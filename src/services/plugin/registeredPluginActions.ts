/**
 * The plugin actions this renderer has registered with ActionService, as
 * id → title, for surfaces that must follow registrations as they happen.
 * ActionService itself has no change signal, and a menu reading it from render
 * would be cached by the React Compiler on its other inputs, so a plugin
 * registering an action late would never reach the menu that offers it.
 * `usePluginActions` publishes here after every sync.
 */

type Listener = () => void;

const EMPTY: ReadonlyMap<string, string> = new Map();
let snapshot: ReadonlyMap<string, string> = EMPTY;
const listeners = new Set<Listener>();

export function getRegisteredPluginActionsSnapshot(): ReadonlyMap<string, string> {
  return snapshot;
}

export function subscribeToRegisteredPluginActions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace the published set, notifying only when it actually changed. */
export function publishRegisteredPluginActions(entries: Iterable<readonly [string, string]>): void {
  const next = new Map(entries);
  if (next.size === snapshot.size) {
    let same = true;
    for (const [id, title] of next) {
      if (snapshot.get(id) !== title) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  snapshot = next.size === 0 ? EMPTY : next;
  for (const listener of [...listeners]) listener();
}
