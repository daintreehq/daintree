import { performance } from "node:perf_hooks";
import type {
  WorkspaceHostDisposePending,
  WorkspaceHostDisposePhase,
  WorkspaceHostEvent,
} from "../../shared/types/workspace-host.js";

/**
 * Earliest the host acks and exits. Nothing tracks the fire-and-forget write
 * tail a just-created worktree starts with (the `.daintree` copy), so exiting
 * the moment watchers drain would truncate it; this keeps the best-effort
 * window the fixed exit timer used to give it. Not a guarantee.
 */
export const HOST_SHUTDOWN_WRITE_TAIL_MS = 500;

/**
 * How long teardown waits for native watcher release. Exiting while a parcel
 * unsubscribe is still running on a libuv worker can stall process exit
 * itself, which is what the parent's SIGKILL then lands on.
 */
export const HOST_SHUTDOWN_SETTLE_BUDGET_MS = 300;

/**
 * Hard ceiling, armed before any cleanup runs. Electron's ParentPort exposes no
 * `close()`, so its listener keeps the event loop alive and the host never
 * drains on its own — if the ack path stalls, this is the exit. Budgeted under
 * the parent's force-kill so a host that is merely slow still ends itself.
 */
export const HOST_SHUTDOWN_EXIT_DEADLINE_MS = 1_000;

export interface HostShutdownDeps {
  /** Synchronous disposers, run in order. One throwing does not skip the rest. */
  disposers: ReadonlyArray<() => void>;
  /** Resolves once native watcher release has finished. */
  settle: () => Promise<void>;
  getPending: () => WorkspaceHostDisposePending;
  send: (event: WorkspaceHostEvent) => void;
  exit: (code: number) => void;
  now?: () => number;
  writeTailMs?: number;
  settleBudgetMs?: number;
  exitDeadlineMs?: number;
}

/**
 * Idempotent host teardown shared by the parent's `dispose` message and
 * SIGTERM: cancel and dispose, wait a bounded time for watchers to release,
 * acknowledge, exit. Progress is reported before each step that can block, so
 * when the parent has to force-kill it can log what the host was stuck on.
 */
export function createHostShutdown(deps: HostShutdownDeps): () => Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const writeTailMs = deps.writeTailMs ?? HOST_SHUTDOWN_WRITE_TAIL_MS;
  const settleBudgetMs = deps.settleBudgetMs ?? HOST_SHUTDOWN_SETTLE_BUDGET_MS;
  const exitDeadlineMs = deps.exitDeadlineMs ?? HOST_SHUTDOWN_EXIT_DEADLINE_MS;
  let running: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    const startedAt = now();

    // Armed first: a disposer or a native unsubscribe can block this thread,
    // and the deadline has to be pending when it frees up. Unref'd only so it
    // cannot hold the loop open if the loop does drain.
    const deadline = setTimeout(() => deps.exit(0), exitDeadlineMs);
    deadline.unref?.();
    const writeTail = sleep(writeTailMs);

    // Reporting is diagnostic: a dead port or a failing snapshot must not
    // stop the exit.
    const report = (build: (elapsedMs: number) => WorkspaceHostEvent): void => {
      try {
        deps.send(build(Math.round(now() - startedAt)));
      } catch {
        // Nothing to do; the parent falls back to its own timer.
      }
    };
    const progress = (phase: WorkspaceHostDisposePhase): void =>
      report((elapsedMs) => ({
        type: "dispose-progress",
        phase,
        elapsedMs,
        pending: deps.getPending(),
      }));

    progress("disposing-services");
    for (const dispose of deps.disposers) {
      try {
        dispose();
      } catch (err) {
        console.warn("[WorkspaceHost] Error during shutdown:", err);
      }
    }

    progress("settling");
    const settled = await settleWithin(deps.settle, settleBudgetMs);

    progress("write-tail");
    await writeTail;

    report((elapsedMs) => ({
      type: "disposed",
      elapsedMs,
      settled,
      pending: deps.getPending(),
    }));
    // One turn so the ack is flushed before the process dies (#6895).
    setImmediate(() => deps.exit(0));
  };

  return () => {
    running ??= run();
    return running;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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
