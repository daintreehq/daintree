import type { MessagePort } from "node:worker_threads";

// Surface used by `fanoutEventToPorts`. Kept narrow so tests can mock it
// without dragging in `node:worker_threads` types.
export interface FanoutPort {
  postMessage(message: unknown): void;
  close(): void;
}

export interface FanoutLogger {
  error(...args: unknown[]): void;
}

/**
 * Fan an event out to every active worktree MessagePort.
 *
 * When `postMessage` throws (e.g. `DataCloneError` on a non-cloneable value,
 * or a closed channel), the port is removed from `ports` AND closed. The
 * close is the load-bearing change vs. the previous silent-drop behaviour:
 * the renderer-side `WorktreePortClient` only learns the channel is gone
 * via the `close` event, which triggers `_handlePortClose` and the broker
 * re-attach recovery path. Without the explicit `close()` the renderer would
 * wait for GC to reclaim the host-side port — non-deterministic and
 * effectively never under load.
 *
 * Order matters: splice BEFORE close. `close()` fires the `close` event on
 * both sides; the local listener installed by `attachWorktreePort` does its
 * own `indexOf`/`splice`, so removing the port first means that listener
 * sees `idx === -1` and no-ops instead of racing the reverse-iteration loop.
 */
export function fanoutEventToPorts<TPort extends FanoutPort, TEvent>(
  ports: TPort[],
  event: TEvent,
  logger: FanoutLogger = console
): void {
  for (let i = ports.length - 1; i >= 0; i--) {
    try {
      ports[i].postMessage({ type: "event", event });
    } catch (error) {
      const failedPort = ports[i];
      ports.splice(i, 1);
      try {
        failedPort.close();
      } catch {
        // Port may already be closed; the splice is what matters.
      }
      logger.error("[WorkspaceHost] sendToWorktreePorts: postMessage failed, closing port:", error);
    }
  }
}

// Convenience overload pinned to the `node:worker_threads` MessagePort type
// for the production call site. Re-uses the generic implementation above.
export function fanoutEventToWorktreePorts<TEvent>(ports: MessagePort[], event: TEvent): void {
  fanoutEventToPorts(ports as unknown as FanoutPort[], event);
}
