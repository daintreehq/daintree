import type {
  BulkWorktreeRunFailedStep,
  BulkWorktreeRunItemStage,
} from "@shared/types/ipc/bulkWorktreeRuns";

export type ItemStage = BulkWorktreeRunItemStage;

export interface ItemStatus {
  stage: ItemStage;
  attempt: number;
  /** Times Retry failed has run this item again. */
  retried?: number;
  error?: string;
  worktreeId?: string;
  worktreePath?: string;
  resolvedBranch?: string;
  failedTerminalIndices?: number[];
  spawnedTerminalIds?: string[];
  failedStep?: BulkWorktreeRunFailedStep;
}

export interface ProgressState {
  /**
   * `cancelling` waits for work already underway (a worktree create can't be
   * called back) before the run settles as `cancelled`.
   */
  phase: "idle" | "executing" | "cancelling" | "cancelled" | "done";
  total: number;
  items: Map<number, ItemStatus>;
}

export type ProgressAction =
  | { type: "START"; issueNumbers: number[] }
  | { type: "ITEM_WORKTREE_CREATING"; issueNumber: number; attempt: number }
  | {
      type: "ITEM_WORKTREE_CREATED";
      issueNumber: number;
      worktreeId: string;
      worktreePath: string;
      branch: string;
    }
  | { type: "ITEM_TERMINALS_SPAWNING"; issueNumber: number }
  | {
      type: "ITEM_TERMINALS_RESULT";
      issueNumber: number;
      spawnedTerminalIds: string[];
      failedTerminalIndices: number[];
    }
  | { type: "ITEM_ASSIGNING"; issueNumber: number }
  | { type: "ITEM_VERIFYING"; issueNumber: number }
  | { type: "ITEM_SUCCEEDED"; issueNumber: number }
  | {
      type: "ITEM_FAILED";
      issueNumber: number;
      error: string;
      attempts: number;
      failedStep?: BulkWorktreeRunFailedStep;
    }
  | { type: "DONE" }
  | { type: "CANCEL_REQUESTED" }
  | { type: "CANCELLED" }
  | { type: "RETRY_FAILED" }
  | { type: "RESET" };

export function progressReducer(state: ProgressState, action: ProgressAction): ProgressState {
  switch (action.type) {
    case "START": {
      const items = new Map<number, ItemStatus>();
      for (const n of action.issueNumbers) {
        const existing = state.items.get(n);
        items.set(n, existing?.stage === "succeeded" ? existing : { stage: "pending", attempt: 0 });
      }
      return { phase: "executing", total: action.issueNumbers.length, items };
    }
    case "ITEM_WORKTREE_CREATING": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      items.set(action.issueNumber, {
        ...prev,
        stage: "worktree-creating",
        attempt: action.attempt,
      });
      return { ...state, items };
    }
    case "ITEM_WORKTREE_CREATED": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      items.set(action.issueNumber, {
        ...prev,
        stage: "worktree-created",
        attempt: prev?.attempt ?? 1,
        worktreeId: action.worktreeId,
        worktreePath: action.worktreePath,
        resolvedBranch: action.branch,
      });
      return { ...state, items };
    }
    case "ITEM_TERMINALS_SPAWNING": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      items.set(action.issueNumber, {
        ...prev,
        stage: "terminals-spawning",
        attempt: prev?.attempt ?? 1,
      });
      return { ...state, items };
    }
    case "ITEM_TERMINALS_RESULT": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      if (action.failedTerminalIndices.length > 0) {
        items.set(action.issueNumber, {
          ...prev,
          stage: "terminals-error",
          attempt: prev?.attempt ?? 1,
          failedTerminalIndices: action.failedTerminalIndices,
          spawnedTerminalIds: [...(prev?.spawnedTerminalIds ?? []), ...action.spawnedTerminalIds],
          error: `${action.failedTerminalIndices.length} terminal(s) failed to spawn`,
        });
      } else {
        items.set(action.issueNumber, {
          ...prev,
          stage: "worktree-created",
          attempt: prev?.attempt ?? 1,
          spawnedTerminalIds: [...(prev?.spawnedTerminalIds ?? []), ...action.spawnedTerminalIds],
          failedTerminalIndices: [],
        });
      }
      return { ...state, items };
    }
    case "ITEM_ASSIGNING": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      items.set(action.issueNumber, { ...prev, stage: "assigning", attempt: prev?.attempt ?? 1 });
      return { ...state, items };
    }
    case "ITEM_VERIFYING": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      items.set(action.issueNumber, { ...prev, stage: "verifying", attempt: prev?.attempt ?? 1 });
      return { ...state, items };
    }
    case "ITEM_SUCCEEDED": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      items.set(action.issueNumber, { ...prev, stage: "succeeded", attempt: prev?.attempt ?? 1 });
      return { ...state, items };
    }
    case "ITEM_FAILED": {
      const items = new Map(state.items);
      const prev = items.get(action.issueNumber);
      items.set(action.issueNumber, {
        ...prev,
        stage: "failed",
        error: action.error,
        attempt: action.attempts,
        failedStep: action.failedStep,
      });
      return { ...state, items };
    }
    case "DONE":
      return { ...state, phase: "done" };
    case "CANCEL_REQUESTED":
      return state.phase === "executing" ? { ...state, phase: "cancelling" } : state;
    case "CANCELLED": {
      // Whatever didn't finish is cancelled, keeping the worktree it may
      // already have: a created worktree is reported as created.
      const items = new Map(state.items);
      for (const [key, val] of items) {
        if (val.stage !== "succeeded" && val.stage !== "failed") {
          items.set(key, { ...val, stage: "cancelled", error: undefined });
        }
      }
      return { ...state, phase: "cancelled", items };
    }
    case "RETRY_FAILED": {
      const items = new Map(state.items);
      let retryCount = 0;
      for (const [key, val] of items) {
        if (
          val.stage === "failed" ||
          val.stage === "terminals-error" ||
          val.stage === "worktree-error"
        ) {
          items.set(key, {
            ...val,
            stage: "pending",
            error: undefined,
            retried: (val.retried ?? 0) + 1,
          });
          retryCount++;
        }
      }
      return { ...state, phase: "executing", total: retryCount, items };
    }
    case "RESET":
      return { phase: "idle", total: 0, items: new Map() };
  }
}
