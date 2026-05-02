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

/** Classification of why an agent is in the "waiting" state */
export type WaitingReason = "prompt" | "question";

/** Task state: draft | queued | running | blocked | completed | failed | cancelled */
export type TaskState =
  | "draft"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/** Execution instance - individual attempt of a task */
export interface RunRecord {
  /** Unique identifier for this run */
  id: string;
  /** ID of the agent executing this run */
  agentId: string;
  /** ID of the task being executed (optional for ad-hoc runs) */
  taskId?: string;
  /** Unix timestamp (ms) when the run started */
  startTime: number;
  /** Unix timestamp (ms) when the run ended (undefined if still running) */
  endTime?: number;
  /** Current state of the run */
  state: "running" | "completed" | "failed" | "cancelled";
  /** Error message if state is 'failed' */
  error?: string;
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
