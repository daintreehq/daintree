/**
 * Cross-process contract for the "Move or rename project" workflow (#11282,
 * phase 4). The reason union and preview shape are shared so the renderer dialog
 * can render an honest preview and branch on structured blockers without relying
 * on Error properties surviving IPC serialization.
 */

/** Why a relocation cannot proceed. Every reason maps to a user-facing message. */
export type ProjectRelocationReason =
  | "not-found"
  | "in-progress"
  | "cross-volume"
  | "assistant-active"
  | "invalid-destination"
  | "destination-exists"
  | "same-path";

/**
 * `"move"` performs a Daintree-managed `fs.rename` (same-volume only for the
 * first cut). `"reattach"` adopts a folder already sitting at the destination
 * (moved externally).
 */
export type ProjectRelocationMode = "move" | "reattach";

/** A preflight failure surfaced in the preview so the dialog can disable confirm. */
export interface RelocationBlocker {
  reason: ProjectRelocationReason;
  message: string;
}

/**
 * Renderer → main relocation request. Mirrors the coordinator's
 * `RelocateProjectRequest` minus `assistantDisposition` (which the dialog never
 * sets — it defaults to `"refuse"`).
 */
export interface RelocationRequest {
  projectId: string;
  mode: ProjectRelocationMode;
  /** Managed move: the full destination root. Reattach: where the folder is now. */
  newPath: string;
}

/**
 * Read-only description of everything a relocation would affect, gathered
 * without side effects. `blockers` is empty when the operation is clear to run;
 * a non-empty list means the dialog must keep confirm disabled.
 */
export interface RelocationPreview {
  mode: ProjectRelocationMode;
  /** The project's current folder. */
  oldPath: string;
  /** The normalized destination the operation would land at. */
  newPath: string;
  /** Terminals/agents that will be gracefully stopped and session-preserved. */
  runningTerminalCount: number;
  /** Absolute paths of the linked (non-main) worktrees that will be repaired. */
  linkedWorktrees: string[];
  /** Count of persisted panels whose stored working directory will be rewritten. */
  affectedPanelCount: number;
  /** Preflight failures; non-empty ⇒ the operation cannot proceed. */
  blockers: RelocationBlocker[];
}
