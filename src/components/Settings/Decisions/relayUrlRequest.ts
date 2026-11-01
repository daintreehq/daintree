type Listener = () => void;

const listeners = new Set<Listener>();
let pending = false;

/**
 * Ask Settings → Decisions to land on the relay URL field, for a guided deploy
 * that has shown its Worker URL. Connection renders only once Decisions has
 * read its status, and only while Decisions is on, so a landing target handed
 * to the dialog would be looked for before the field exists. Answered at once
 * when Connection is showing; otherwise held until it mounts, Decisions being
 * turned on first included.
 */
export function requestRelayUrl(): void {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  pending = false;
  for (const listener of [...listeners]) listener();
}

/** Whether a request came before Connection was showing; taking it clears it. */
export function takePendingRelayUrlRequest(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}

export function onRelayUrlRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
