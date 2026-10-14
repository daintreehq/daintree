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

/** Record a snapshot fetch. A newer fetch replaces the one being waited on. */
export function trackWorktreeSnapshot(fetch: Promise<unknown>): void {
  const settled = fetch.then(
    () => undefined,
    () => undefined
  );
  inFlight = settled;
  void settled.then(() => {
    if (inFlight === settled) inFlight = null;
  });
}

/**
 * Resolves once no snapshot fetch is outstanding, following any fetch that
 * supersedes the one it started on. Never rejects: a failed fetch leaves the
 * store as it was, and the action reports what it finds there. Null when
 * nothing is in flight, so a caller can stay synchronous.
 */
export function pendingWorktreeSnapshot(): Promise<void> | null {
  if (!inFlight) return null;
  return (async () => {
    while (inFlight) await inFlight;
  })();
}

export function resetWorktreeSnapshotSyncForTesting(): void {
  inFlight = null;
}
