/**
 * Cross-process contract for the "Move or rename project" workflow (#11282,
 * phase 4). The reason union and preview shape are shared so the renderer dialog
 * can render an honest preview and branch on structured blockers without relying
 * on Error properties surviving IPC serialization.
 */

import type { ConversationContinuityTier } from "../config/agentRegistry.js";

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
 * Per-agent conversation-continuity outcome for the running terminals a
 * relocation would gracefully stop (#11282, phase 5). One entry per distinct
 * agent type; plain (non-agent) terminals are excluded because they carry no
 * conversation. The `tier` is computed live from the agent registry at preview
 * time via `resolveAgentContinuity` — never persisted, so it can't go stale.
 */
export interface AgentContinuitySummary {
  /** Agent registry id (e.g. `"claude"`). */
  agentId: string;
  /** Display name from the agent config (e.g. `"Claude Code"`). */
  agentName: string;
  /** How many running terminals of this agent the relocation would stop. */
  count: number;
  /** Whether — and how — this agent's conversation survives the move. */
  tier: ConversationContinuityTier;
  /** Optional provider-specific one-liner; falls back to a generic per-tier line. */
  detail?: string;
}

/**
 * Preview display order for continuity tiers — riskiest first, so the user sees
 * what WON'T survive before what will (#11282, phase 5). Lower rank sorts
 * earlier. Shared so the coordinator can pre-sort the breakdown deterministically
 * and tests don't depend on registry key order.
 */
export const CONTINUITY_TIER_ORDER: Record<ConversationContinuityTier, number> = {
  "provider-migration": 0,
  unavailable: 1,
  unverified: 2,
  "project-local": 3,
  preserved: 4,
};

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
  /**
   * Per-agent conversation-continuity breakdown for the running terminals
   * (#11282, phase 5). Empty when no agents are running (or on a closed
   * reattach, which stops nothing). Lets the dialog warn BEFORE the move when a
   * conversation can't be resumed at the new path.
   */
  agentContinuity: AgentContinuitySummary[];
  /** Absolute paths of the linked (non-main) worktrees that will be repaired. */
  linkedWorktrees: string[];
  /** Count of persisted panels whose stored working directory will be rewritten. */
  affectedPanelCount: number;
  /** Preflight failures; non-empty ⇒ the operation cannot proceed. */
  blockers: RelocationBlocker[];
}
