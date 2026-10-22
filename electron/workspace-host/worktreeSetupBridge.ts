import { randomUUID } from "node:crypto";
import type {
  WorkspaceHostEvent,
  WorktreeSetupStepDescriptor,
  WorktreeSetupStepRunOutcome,
  WorktreeSetupStepTarget,
} from "../../shared/types/workspace-host.js";

type SendEvent = (event: WorkspaceHostEvent) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup?: () => void;
}

const LIST_TIMEOUT_MS = 30_000;

/**
 * Main enforces each step's own timeout and answers `timed-out` itself, but
 * starts that clock only once the plugin is active, which can mean booting its
 * worker. This is how much longer the host waits for the answer before
 * deciding main is not going to give one.
 */
export const RUN_ANSWER_GRACE_MS = 60_000;

/**
 * The workspace host's client for plugin worktree setup steps (#13807). The
 * host has no plugin loader, so it asks main which steps its project declares
 * and to run each one, over the parent port like `ForgeBridge`.
 *
 * Unlike the forge bridge, nothing is coalesced: a run mutates the world, and
 * two identical calls are two runs.
 */
export class WorktreeSetupBridge {
  private pending = new Map<string, PendingCall>();
  // Request ids outlive a host restart on main's side, so they must not repeat
  // across host processes the way a bare counter would.
  private readonly idPrefix = randomUUID();
  private counter = 0;

  constructor(private readonly sendEvent: SendEvent) {}

  listSteps(): Promise<WorktreeSetupStepDescriptor[]> {
    return this.call<WorktreeSetupStepDescriptor[]>(
      (setupRequestId) => ({ type: "worktree-setup:list", setupRequestId }),
      LIST_TIMEOUT_MS
    );
  }

  /**
   * Run one step. Never rejects for the step's own failure — that is an
   * outcome — only when main does not answer, or `signal` aborts first.
   */
  runStep(
    step: WorktreeSetupStepDescriptor,
    target: WorktreeSetupStepTarget,
    signal?: AbortSignal
  ): Promise<WorktreeSetupStepRunOutcome> {
    return this.call<WorktreeSetupStepRunOutcome>(
      (setupRequestId) => ({ type: "worktree-setup:run", setupRequestId, step, target }),
      step.timeoutMs + RUN_ANSWER_GRACE_MS,
      signal
    );
  }

  /** Settle the call `worktree-setup:result` answers. A late answer finds nothing. */
  handleResult(
    result:
      | { setupRequestId: string; ok: true; value: unknown }
      | { setupRequestId: string; ok: false; error: string }
  ): void {
    const pending = this.pending.get(result.setupRequestId);
    if (!pending) return;
    this.settle(result.setupRequestId, pending);
    if (result.ok) pending.resolve(result.value);
    else pending.reject(new Error(result.error));
  }

  /** Reject every pending call. Used on workspace-host shutdown. */
  dispose(): void {
    for (const [id, pending] of [...this.pending]) {
      this.settle(id, pending);
      pending.reject(new Error("Worktree setup bridge disposed"));
    }
  }

  private settle(id: string, pending: PendingCall): void {
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup?.();
  }

  private call<T>(
    build: (setupRequestId: string) => WorkspaceHostEvent,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    const setupRequestId = `setup-${this.idPrefix}-${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingCall = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          if (this.pending.get(setupRequestId) !== pending) return;
          this.settle(setupRequestId, pending);
          this.sendEvent({ type: "worktree-setup:cancel", setupRequestId });
          reject(new Error(`No answer from the app after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs),
      };
      if (signal) {
        const onAbort = (): void => {
          if (this.pending.get(setupRequestId) !== pending) return;
          this.settle(setupRequestId, pending);
          this.sendEvent({ type: "worktree-setup:cancel", setupRequestId });
          reject(new Error("Cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(setupRequestId, pending);
      this.sendEvent(build(setupRequestId));
    });
  }
}

let _bridge: WorktreeSetupBridge | null = null;

/** Create the workspace-host's singleton bridge. Called once during bootstrap. */
export function initWorktreeSetupBridge(sendEvent: SendEvent): WorktreeSetupBridge {
  if (_bridge !== null) throw new Error("WorktreeSetupBridge already initialized");
  _bridge = new WorktreeSetupBridge(sendEvent);
  return _bridge;
}

/** The bridge, or `null` before bootstrap — a host without one runs no plugin steps. */
export function getWorktreeSetupBridge(): WorktreeSetupBridge | null {
  return _bridge;
}

/** Test-only reset. */
export function _resetWorktreeSetupBridgeForTests(): void {
  _bridge?.dispose();
  _bridge = null;
}
