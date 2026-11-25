/**
 * Whether this view's panels are all in its store (#18176), so a missing id
 * can be read as missing. A view that just took over an assistant is up
 * before its panels are, and an id it hasn't restored yet is not one the
 * close would miss for long.
 *
 * Every path that puts panels back holds the gate open while it runs: the
 * view's own restore, and the host read-backs of a view that regained it.
 * Emptying the store keeps it open until a restore next finishes. Nothing has
 * been restored until the first one does.
 */
let inFlight = 0;
let restored = false;

/** Hold the gate open for one restore; the returned call ends it, once. */
export function beginPanelRestore(): () => void {
  inFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight -= 1;
    restored = true;
  };
}

/** The store was emptied: nothing reads as missing until a restore finishes. */
export function markPanelsCleared(): void {
  restored = false;
}

export function arePanelsRestored(): boolean {
  return restored && inFlight === 0;
}
