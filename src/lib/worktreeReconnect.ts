// Past the worst-case ~14s workspace-host restart budget with room to spare,
// so a crash restart that is still on its way back never offers Retry.
const RECONNECT_STALLED_MS = 30_000;

/**
 * A worktree port lost for longer than any restart takes to put it back.
 * Nothing on its way will reconnect it, so the view needs a way out (#13748).
 */
export function isReconnectStalled(
  state: { isReconnecting: boolean; reconnectingAt: number | null },
  now: number = Date.now()
): boolean {
  return (
    state.isReconnecting &&
    state.reconnectingAt !== null &&
    now - state.reconnectingAt >= RECONNECT_STALLED_MS
  );
}

/** How long until a lost port counts as stalled: 0 once it has, or when none is lost. */
export function reconnectStallDelayMs(
  state: { isReconnecting: boolean; reconnectingAt: number | null },
  now: number = Date.now()
): number {
  if (!state.isReconnecting || state.reconnectingAt === null) return 0;
  return Math.max(0, state.reconnectingAt + RECONNECT_STALLED_MS - now);
}

/**
 * A stalled reconnect that is the user's to retry: automatic recovery is not
 * still working on it (#14313). A view that runs none stays `idle`, so this is
 * the plain stall there.
 */
export function needsReconnectRetry(
  state: {
    isReconnecting: boolean;
    reconnectingAt: number | null;
    reconnectRecovery: "idle" | "recovering" | "exhausted";
  },
  now: number = Date.now()
): boolean {
  return state.reconnectRecovery !== "recovering" && isReconnectStalled(state, now);
}
