/** Agent lifecycle state: idle | working | waiting | directing | completed | exited */
export type AgentState = "idle" | "working" | "waiting" | "directing" | "completed" | "exited";

/** Agent states that indicate in-flight work — used to protect against eviction/hibernation */
export const ACTIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set([
  "working",
  "waiting",
  "directing",
]);

/**
 * Agent states that should trigger a close-confirmation dialog. Narrower than
 * ACTIVE_AGENT_STATES: only "working" represents in-flight computation that
 * would be lost on close. "waiting"/"directing" are agent-paused states where
 * stopping is not disruptive, so closing should not require confirmation.
 */
export const CLOSE_CONFIRM_AGENT_STATES: ReadonlySet<AgentState> = new Set(["working"]);

const CANONICAL_AGENT_STATES: ReadonlySet<AgentState> = new Set([
  "idle",
  "working",
  "waiting",
  "directing",
  "completed",
  "exited",
]);

/**
 * Normalise a possibly-legacy agent state value. The retired "running" state
 * (a pre-state-machine shell-process signal) collapses to "working"; unknown
 * values return undefined so callers can decide on a default.
 */
export function coerceAgentState(value: unknown): AgentState | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "running") return "working";
  return CANONICAL_AGENT_STATES.has(value as AgentState) ? (value as AgentState) : undefined;
}

/**
 * Classification of why an agent is in the "waiting" state.
 *
 * - `"prompt"` — empty input prompt visible; safe to auto-drive.
 * - `"question"` — agent asked a free-form question; verify before replying.
 * - `"approval"` — permission/approval selector visible (tool approval, y/n
 *   confirm, trust dialog); a specific choice is required, not free text.
 * - `"error"` — agent settled after a blocking error (auth failure, rate
 *   limit, network error, failed command); input may not unblock it.
 */
export type WaitingReason = "prompt" | "question" | "approval" | "error";

const WAITING_REASONS: ReadonlySet<WaitingReason> = new Set([
  "prompt",
  "question",
  "approval",
  "error",
]);

/**
 * Normalise a waiting reason coming off the wire (backend snapshots bypass
 * the zod event schema). Unknown values return undefined so callers fall
 * back to the generic "waiting for input" presentation instead of rendering
 * junk.
 */
export function coerceWaitingReason(value: unknown): WaitingReason | undefined {
  if (typeof value !== "string") return undefined;
  return WAITING_REASONS.has(value as WaitingReason) ? (value as WaitingReason) : undefined;
}

export type AgentId = string;

/** Valid triggers for agent state changes */
export type AgentStateChangeTrigger =
  | "input"
  | "output"
  | "heuristic"
  | "ai-classification"
  | "timeout"
  | "exit"
  | "activity"
  | "title";
