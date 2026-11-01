type Listener = () => void;

/**
 * How long a request waits for a Decisions page to open and claim it. One no
 * page claimed in that time came from a Settings opening that closed before
 * Decisions ever mounted, and must not land in a later, unrelated visit.
 */
export const UNCLAIMED_REQUEST_TTL_MS = 10_000;

const listeners = new Set<Listener>();
let pending: { at: number; claimed: boolean } | null = null;
let holds = 0;
let generation = 0;

/**
 * Ask Settings → Decisions to land on the relay URL field, for a guided deploy
 * that has shown its Worker URL. Connection renders only once Decisions has
 * read its status, and only while Decisions is on, so a landing target handed
 * to the dialog would be looked for before the field exists. Answered at once
 * when Connection is showing; otherwise held until it mounts, Decisions being
 * turned on first included, for as long as that opening of Settings lasts.
 */
export function requestRelayUrl(): void {
  generation += 1;
  if (listeners.size === 0) {
    pending = { at: Date.now(), claimed: holds > 0 };
    return;
  }
  pending = null;
  for (const listener of [...listeners]) listener();
}

/** Whether a request came before Connection was showing; taking it clears it. */
export function takePendingRelayUrlRequest(): boolean {
  const wasPending = pending !== null;
  pending = null;
  return wasPending;
}

export function onRelayUrlRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Held by the Decisions page while it's mounted, which claims a recent request
 * for this opening. A request still waiting when the last hold goes (Settings
 * closed before Connection showed) is dropped. Checked a microtask later, so
 * StrictMode's remount, which releases and takes a hold back to back, keeps
 * it, and only if no newer request came meanwhile.
 */
export function holdRelayUrlRequests(): () => void {
  if (pending && !pending.claimed) {
    if (Date.now() - pending.at > UNCLAIMED_REQUEST_TTL_MS) pending = null;
    else pending.claimed = true;
  }
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    const releasedAt = generation;
    queueMicrotask(() => {
      if (holds === 0 && generation === releasedAt) pending = null;
    });
  };
}
