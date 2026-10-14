/**
 * The worktree snapshot this view is fetching, if any (#13348).
 *
 * A worktree port that arrives fires `fetchInitialState` and is confirmed to
 * main in the same turn, so main can dispatch an MCP action the moment the port
 * is confirmed — before `get-all-states` has answered. A background view whose
 * port was just restored would then run the action against the map it had
 * when it was cached. The dispatch handler waits for the fetch here first.
 *
 * Leaf module: one per view, like the worktree store it describes.
 */
let inFlight: Promise<void> | null = null;
let idle: { promise: Promise<void>; resolve: () => void } | null = null;

/** Record a snapshot fetch. A newer fetch replaces the one being waited on. */
export function trackWorktreeSnapshot(fetch: Promise<unknown>): void {
  const settled = fetch.then(
    () => undefined,
    () => undefined
  );
  inFlight = settled;
  void settled.then(() => {
    // A superseded fetch settling says nothing about the store: only the
    // newest one ends the wait, and it does so even if an older one is stuck.
    if (inFlight !== settled) return;
    inFlight = null;
    idle?.resolve();
    idle = null;
  });
}

/**
 * Resolves once the newest snapshot fetch settles, or after `timeoutMs` — the
 * associations read inside a fetch has no deadline of its own, and an action
 * that runs after main gave up on it is worse than one that reads a stale map.
 * Never rejects: a failed fetch leaves the store as it was, and the action
 * reports what it finds there. Null when nothing is in flight, so a caller can
 * stay synchronous.
 */
export function waitForWorktreeSnapshot(timeoutMs: number): Promise<void> | null {
  if (!inFlight) return null;
  if (!idle) {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    idle = { promise, resolve };
  }
  const settled = idle.promise;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function resetWorktreeSnapshotSyncForTesting(): void {
  inFlight = null;
  idle?.resolve();
  idle = null;
}
