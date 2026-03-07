import type { AgentId } from "../domain.js";

/** An artifact extracted from an agent session */
export interface Artifact {
  /** Unique identifier */
  id: string;
  /** Type of artifact */
  type: "code" | "patch" | "file" | "summary" | "other";
  /** Programming language (for code artifacts) */
  language?: string;
  /** Filename (for file artifacts) */
  filename?: string;
  /** Content of the artifact */
  content: string;
  /** Timestamp when extracted */
  extractedAt: number;
}

/** Agent state change trigger */
export type AgentStateChangeTrigger =
  | "input"
  | "output"
  | "heuristic"
  | "ai-classification"
  | "timeout"
  | "exit"
  | "activity";

/** Agent state */
export type AgentState = "idle" | "working" | "running" | "waiting" | "completed" | "failed";

/** Payload for agent state change events */
export interface AgentStateChangePayload {
  /** Agent ID (e.g., "claude", "gemini") - identifies the agent type. May be undefined for non-agent terminals. */
  agentId?: AgentId;
  /** Terminal ID (unique identifier for this terminal instance) */
  terminalId: string;
  /** Worktree ID (if terminal is associated with a worktree) */
  worktreeId?: string;
  /** New state */
  state: AgentState;
  /** Previous state */
  previousState: AgentState;
  /** Timestamp of state change */
  timestamp: number;
  /** Optional trace ID to track event chains */
  traceId?: string;
  /** What caused this state change */
  trigger: AgentStateChangeTrigger;
  /** Confidence in the state detection (0.0 = uncertain, 1.0 = certain) */
  confidence: number;
}

/** Agent detected payload */
export interface AgentDetectedPayload {
  /** Terminal ID where agent was detected */
  terminalId: string;
  /** Type of agent detected (undefined for non-agent process detections) */
  agentType?: AgentId;
  /** Icon identifier for the detected process (e.g., "npm", "python", "docker") */
  processIconId?: string;
  /** Process name that was detected */
  processName: string;
  /** Timestamp when detected */
  timestamp: number;
}

/** Payload for agent exited events */
export interface AgentExitedPayload {
  /** Terminal ID where agent exited */
  terminalId: string;
  /** Type of agent that exited (undefined for non-agent process exits) */
  agentType?: AgentId;
  /** Timestamp when exited */
  timestamp: number;
}

/** Artifact detected payload */
export interface ArtifactDetectedPayload {
  /** Agent ID that generated the artifacts */
  agentId: string;
  /** Terminal ID where the artifacts appeared */
  terminalId: string;
  /** Associated worktree ID (if any) */
  worktreeId?: string;
  /** Array of detected artifacts */
  artifacts: Artifact[];
  /** Timestamp when artifacts were detected */
  timestamp: number;
}

/** Options for saving an artifact to a file */
export interface SaveArtifactOptions {
  /** Artifact content to save */
  content: string;
  /** Suggested filename */
  suggestedFilename?: string;
  /** Working directory for the save dialog */
  cwd?: string;
}

/** Result from saving an artifact */
export interface SaveArtifactResult {
  /** Path where the file was saved */
  filePath: string;
  /** Whether the operation succeeded */
  success: boolean;
}

/** Options for applying a patch */
export interface ApplyPatchOptions {
  /** Patch content in unified diff format */
  patchContent: string;
  /** Working directory to apply the patch in */
  cwd: string;
}

/** Result from applying a patch */
export interface ApplyPatchResult {
  /** Whether the patch applied successfully */
  success: boolean;
  /** Error message if the patch failed */
  error?: string;
  /** Files that were modified */
  modifiedFiles?: string[];
}

export interface AgentHelpRequest {
  agentId: string;
  refresh?: boolean;
}

export interface AgentHelpResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated?: boolean;
}
