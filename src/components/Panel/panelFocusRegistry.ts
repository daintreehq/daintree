/**
 * Panel-id → "focus your primary target" handoff, keyed by panel id and blind
 * to panel kind. Each mounted panel owns exactly one entry: TerminalPane
 * registers a handler that honors the user's preferred terminal sub-target,
 * ContentPanel registers the panel root for every non-PTY kind, and ReviewPane
 * (which bypasses ContentPanel) registers its own container.
 *
 * Handlers report whether a live target actually took focus. Callers use that
 * to decide whether a focus handoff completed — a panel whose focus target is
 * not mounted yet (lazy chunk still loading, terminal with no live xterm)
 * returns `false` rather than silently swallowing the request.
 */
type FocusHandler = () => boolean;

const registry = new Map<string, FocusHandler>();

export function registerPanelFocusHandler(id: string, handler: FocusHandler): () => void {
  registry.set(id, handler);
  return () => {
    // Identity check: a remount can register the replacement before the old
    // effect's cleanup runs, and deleting blindly would drop the live handler.
    if (registry.get(id) === handler) {
      registry.delete(id);
    }
  };
}

/** Returns whether a live focus target accepted the handoff. */
export function focusPanelInput(id: string): boolean {
  return registry.get(id)?.() ?? false;
}
