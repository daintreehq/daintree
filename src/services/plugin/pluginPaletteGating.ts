/**
 * The `when` / `enablement` clauses of the plugin commands this renderer has
 * registered, keyed by action id. The command palette alone reads them:
 * `ActionService.dispatch`, keybindings, context menus and MCP never do, so a
 * clause decides what the palette offers, not what can run. `usePluginActions`
 * publishes here after every sync, so a palette open at the time re-derives its
 * rows.
 */

export interface PluginPaletteGate {
  when?: string;
  enablement?: string;
}

type Listener = () => void;

const EMPTY: ReadonlyMap<string, PluginPaletteGate> = new Map();
let snapshot: ReadonlyMap<string, PluginPaletteGate> = EMPTY;
const listeners = new Set<Listener>();

export function getPluginPaletteGatesSnapshot(): ReadonlyMap<string, PluginPaletteGate> {
  return snapshot;
}

export function subscribeToPluginPaletteGates(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace the published set, notifying only when it actually changed. */
export function publishPluginPaletteGates(
  entries: Iterable<readonly [string, PluginPaletteGate]>
): void {
  const next = new Map<string, PluginPaletteGate>();
  for (const [id, gate] of entries) {
    if (gate.when !== undefined || gate.enablement !== undefined) next.set(id, gate);
  }
  if (next.size === snapshot.size) {
    let same = true;
    for (const [id, gate] of next) {
      const prev = snapshot.get(id);
      if (prev?.when !== gate.when || prev?.enablement !== gate.enablement) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  snapshot = next.size === 0 ? EMPTY : next;
  for (const listener of [...listeners]) listener();
}
