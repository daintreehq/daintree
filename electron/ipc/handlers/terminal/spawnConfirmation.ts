/**
 * Bounded wait for the pty-host to answer a spawn (#12754).
 *
 * `terminal:spawn` returns once the request is dispatched, not once the host
 * has spawned anything, and the renderer marks the pane ready on that return.
 * If the host is wedged or too busy to answer, the pane is a blank xterm with
 * no banner. This arms a per-terminal timer at dispatch; the host's
 * `spawn-result` or a kill of the id settles it, and expiry reports what
 * was observed — no answer yet — through the renderer's existing spawn-error
 * path. A late real result still arrives and clears the banner on success.
 *
 * Reported only to the renderer, never re-emitted on the PtyClient: main-side
 * `spawn-result` listeners treat a failure as final (revoking the pane's MCP
 * config, releasing the handed-over session), and the spawn may yet land.
 */

import type { SpawnError } from "../../../../shared/types/pty-host.js";

// Not settled on `exit`: the public exit event carries no launch generation,
// and a restart's killed predecessor exits AFTER its successor has armed, which
// would silently disarm the successor's window.

// Matches the retry path's own spawn wait (errorHandlers.ts): long enough that
// a cold boot replaying many terminals through a busy host doesn't flash a
// banner that clears itself moments later.
export const SPAWN_CONFIRMATION_TIMEOUT_MS = 30_000;

type TimeoutHandler = (id: string, error: SpawnError) => void;

let timeoutHandler: TimeoutHandler | null = null;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Install the reporter. Returns a disposer that also drops every armed timer. */
export function setSpawnConfirmationTimeoutHandler(handler: TimeoutHandler): () => void {
  timeoutHandler = handler;
  return () => {
    if (timeoutHandler === handler) timeoutHandler = null;
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}

/**
 * Arm before dispatching the spawn: the host can reject synchronously
 * (PENDING_SPAWNS_CAPPED), and a settle that lands before the arm would leave
 * a timer nothing clears. Re-arming the same id replaces its timer.
 */
export function armSpawnConfirmation(
  id: string,
  timeoutMs: number = SPAWN_CONFIRMATION_TIMEOUT_MS
): void {
  if (!timeoutHandler) return;
  settleSpawnConfirmation(id);
  const timer = setTimeout(() => {
    if (pending.get(id) !== timer) return;
    pending.delete(id);
    timeoutHandler?.(id, {
      code: "SPAWN_TIMEOUT",
      message: `The terminal backend hasn't confirmed this launch after ${Math.round(timeoutMs / 1000)} seconds.`,
    });
  }, timeoutMs);
  timer.unref?.();
  pending.set(id, timer);
}

export function settleSpawnConfirmation(id: string): void {
  const timer = pending.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  pending.delete(id);
}
