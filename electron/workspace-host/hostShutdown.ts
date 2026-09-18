import { performance } from "node:perf_hooks";
import type {
  WorkspaceHostDisposePending,
  WorkspaceHostDisposePhase,
  WorkspaceHostEvent,
} from "../../shared/types/workspace-host.js";

/**
 * Hard ceiling on host teardown, armed before any cleanup runs. Electron's
 * ParentPort exposes no `close()`, so its listener keeps the event loop alive
 * and the host never drains on its own — something has to call exit. Budgeted
 * well under the parent's force-kill so a host that is merely slow still ends
 * itself.
 */
export const HOST_SHUTDOWN_EXIT_DEADLINE_MS = 500;

/**
 * How long teardown waits for native watcher release. Exiting while a parcel
 * unsubscribe is still running on a libuv worker can stall process exit
 * itself, which is what the parent's SIGKILL then lands on.
 */
export const HOST_SHUTDOWN_SETTLE_BUDGET_MS = 300;

export interface HostShutdownDeps {
  /** Synchronous disposers, run in order. One throwing does not skip the rest. */
  disposers: ReadonlyArray<() => void>;
  /** Resolves once native watcher release has finished. */
  settle: () => Promise<void>;
  getPending: () => WorkspaceHostDisposePending;
  send: (event: WorkspaceHostEvent) => void;
  exit: (code: number) => void;
  now?: () => number;
  exitDeadlineMs?: number;
  settleBudgetMs?: number;
}

/**
 * Idempotent host teardown shared by the parent's `dispose` message and
 * SIGTERM: cancel and dispose, wait a bounded time for watchers to release,
 * acknowledge, exit. Progress is reported before each step that can block, so
 * when the parent has to force-kill it can log what the host was stuck on.
 */
export function createHostShutdown(deps: HostShutdownDeps): () => Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const exitDeadlineMs = deps.exitDeadlineMs ?? HOST_SHUTDOWN_EXIT_DEADLINE_MS;
  const settleBudgetMs = deps.settleBudgetMs ?? HOST_SHUTDOWN_SETTLE_BUDGET_MS;
  let running: Promise<void> | null = null;

  const trySend = (event: WorkspaceHostEvent): void => {
    try {
      deps.send(event);
    } catch {
      // Reporting is diagnostic; a dead port must not stop the exit.
    }
  };

  const run = async (): Promise<void> => {
    const startedAt = now();
    const elapsedMs = (): number => Math.round(now() - startedAt);

    // Armed first: a disposer or a native unsubscribe can block this thread,
    // and the deadline has to be pending when it frees up. Unref'd only so it
    // cannot hold the loop open if the loop does drain.
    const deadline = setTimeout(() => deps.exit(0), exitDeadlineMs);
    deadline.unref?.();

    const report = (phase: WorkspaceHostDisposePhase): void =>
      trySend({
        type: "dispose-progress",
        phase,
        elapsedMs: elapsedMs(),
        pending: deps.getPending(),
      });

    report("disposing-services");
    for (const dispose of deps.disposers) {
      try {
        dispose();
      } catch (err) {
        console.warn("[WorkspaceHost] Error during shutdown:", err);
      }
    }

    report("settling");
    const settled = await settleWithin(deps.settle, settleBudgetMs);

    trySend({ type: "disposed", elapsedMs: elapsedMs(), settled, pending: deps.getPending() });
    // One turn so the ack is flushed before the process dies (#6895).
    setImmediate(() => deps.exit(0));
  };

  return () => {
    running ??= run();
    return running;
  };
}

async function settleWithin(settle: () => Promise<void>, budgetMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
    timer.unref?.();
  });
  const drained = Promise.resolve()
    .then(settle)
    .then(
      () => true,
      () => false
    );
  try {
    return await Promise.race([drained, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
