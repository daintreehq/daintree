/**
 * Durable run-history records for recipe and fleet automation outcomes (#9949).
 *
 * Recipe runs (`runRecipeWithResults`) and fleet broadcasts
 * (`tryFleetBroadcastFromEditor`) compute rich structured results at execution
 * time but historically discarded them. These records capture a per-run
 * snapshot so a completed run stays inspectable after the fact — surviving
 * reloads and the multi-window LRU eviction by living in the Main-process
 * `electron-store` ring buffer (mirrors `forgeAudit` / `mcpServer.auditLog`).
 *
 * References are stored as stale-tolerant snapshots: terminal ids and pane
 * titles are captured at run time and never re-resolved. A terminal that has
 * since closed or a worktree that was deleted leaves the record intact — the
 * UI renders the snapshotted title as plain text rather than dereferencing a
 * dead id. The records deliberately do NOT mirror terminal scrollback or git
 * state; they record only the automation outcome.
 */

export const RUN_HISTORY_SCHEMA_VERSION = 1;

/** Default ring-buffer cap. ~2KB/record → ~200KB on disk at the cap. */
export const RUN_HISTORY_DEFAULT_MAX_RECORDS = 100;

/** Cap on persisted free-text fields (rejection reasons, spawn errors). */
export const RUN_HISTORY_REASON_MAX_LENGTH = 500;

/** Cap on the snapshotted fleet draft preview. */
export const RUN_HISTORY_DRAFT_PREVIEW_MAX_LENGTH = 280;

/** Cap on snapshotted display strings (pane / recipe / worktree titles). */
export const RUN_HISTORY_TITLE_MAX_LENGTH = 200;

/** Hard cap on per-target entries persisted for a single run. */
export const RUN_HISTORY_MAX_TARGETS = 200;

/**
 * How a supervised fleet run ended (#10930). `completed` — every sent target
 * settled (left working/directing; `waiting` counts as settled). `cancelled` —
 * the user aborted mid-submission. `failed` — no target accepted the write.
 * `superseded` — a newer broadcast pre-empted the run before it settled.
 * Absent on records written before supervision landed.
 */
export type FleetRunOutcomeStatus = "completed" | "cancelled" | "failed" | "superseded";

/**
 * Per-target outcome snapshot, shared by recipe spawns and fleet sends. `title`
 * is the pane title captured at run time — it makes a record legible even after
 * the terminal closes. `reason` carries the rejection detail for failed sends
 * (capped to {@link RUN_HISTORY_REASON_MAX_LENGTH}). `failureKind` mirrors the
 * broadcast rejection classification (permanent = dead PTY, auto-disarmed;
 * transient = retryable). `finalAgentState` is the agent-FSM snapshot at run
 * finalize — a passive heuristic, NOT an authoritative exit status.
 */
export interface RunHistoryTargetOutcome {
  terminalId: string;
  title?: string;
  status: "fulfilled" | "rejected";
  reason?: string;
  failureKind?: "permanent" | "transient";
  finalAgentState?: string;
}

interface RunHistoryRecordBase {
  id: string;
  schemaVersion: number;
  /** Epoch ms when the run completed (stamped by the Main-process service). */
  timestamp: number;
  /** Wall-clock duration of the run, when the call site measured it. */
  durationMs?: number;
}

export interface RecipeRunHistoryRecord extends RunHistoryRecordBase {
  kind: "recipe";
  /** Resolved recipe id; absent for an in-memory / deleted recipe. */
  recipeId?: string;
  recipeName: string;
  worktreeId?: string;
  /** Snapshot of the worktree name/path at run time (stale-tolerant). */
  worktreeName?: string;
  /** Total terminals the recipe defined (not just the spawned subset). */
  totalTerminals: number;
  /** Successfully-spawned terminals, in recipe index order. */
  spawned: Array<{ index: number; terminalId: string; title?: string }>;
  /** Per-terminal spawn failures, in recipe index order. */
  failed: Array<{ index: number; error: string }>;
}

export interface FleetRunHistoryRecord extends RunHistoryRecordBase {
  kind: "fleet";
  /** Truncated snapshot of the broadcast payload (no scrollback duplication). */
  draftPreview?: string;
  targetCount: number;
  successCount: number;
  failureCount: number;
  cancelled: boolean;
  perTarget: RunHistoryTargetOutcome[];
  /** Renderer-minted run id correlating this record with the live supervised run. */
  runId?: string;
  /** Supervised-run outcome; absent on pre-supervision records. */
  status?: FleetRunOutcomeStatus;
  /** True when the run was started by `fleet.retryFailures`. */
  isRetry?: boolean;
}

export type RunHistoryRecord = RecipeRunHistoryRecord | FleetRunHistoryRecord;

/**
 * Payload the renderer sends to append a record. The Main-process service is
 * authoritative for `id`, `schemaVersion`, and `timestamp` — it stamps them so
 * a buggy/compromised renderer can't forge them — so callers omit those.
 */
export type RunHistoryAppendInput =
  | Omit<RecipeRunHistoryRecord, "id" | "schemaVersion" | "timestamp">
  | Omit<FleetRunHistoryRecord, "id" | "schemaVersion" | "timestamp">;
