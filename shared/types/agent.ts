/** Agent lifecycle state: idle | working | running | waiting | directing | completed */
export type AgentState = "idle" | "working" | "running" | "waiting" | "directing" | "completed";

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
