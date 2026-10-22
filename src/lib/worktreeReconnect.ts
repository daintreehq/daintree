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
