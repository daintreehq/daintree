type Listener = () => void;

const listeners = new Set<Listener>();

/** The host chip listens while it is on screen; the "Switch host…" action asks it to open. */
export function onHostMenuRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open the host menu. False when no chip is showing to answer. */
export function requestHostMenu(): boolean {
  if (listeners.size === 0) return false;
  for (const listener of [...listeners]) listener();
  return true;
}
