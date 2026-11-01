type Listener = () => void;

const listeners = new Set<Listener>();
let pending = false;
let holds = 0;

/**
 * Ask Settings → Decisions to land on the relay URL field, for a guided deploy
 * that has shown its Worker URL. Connection renders only once Decisions has
 * read its status, and only while Decisions is on, so a landing target handed
 * to the dialog would be looked for before the field exists. Answered at once
 * when Connection is showing; otherwise held until it mounts, Decisions being
 * turned on first included, for as long as that opening of Settings lasts.
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

/**
 * Held by the Decisions page while it's mounted. A request still waiting when
 * the last hold goes (Settings closed before Connection showed) is dropped,
 * so it can't land in a later, unrelated visit. Checked a microtask later, so
 * StrictMode's remount, which releases and takes a hold back to back, keeps it.
 */
export function holdRelayUrlRequests(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    queueMicrotask(() => {
      if (holds === 0) pending = false;
    });
  };
}
