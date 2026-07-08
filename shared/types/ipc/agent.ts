import type { AgentId, AgentState, AgentStateChangeTrigger, WaitingReason } from "../agent.js";
import type { TerminalCheckResult } from "../checkResult.js";

export type { AgentState, AgentStateChangeTrigger };

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

/** Payload for agent state change events */
export interface AgentStateChangePayload {
  /** Agent ID (e.g., "claude", "gemini") - identifies the agent type. May be undefined for non-agent terminals. */
  agentId?: AgentId;
  /** Terminal ID (unique identifier for this terminal instance) */
  terminalId: string;
  /** Worktree ID (if terminal is associated with a worktree — renderer-originated only; no longer emitted by backend) */
  worktreeId?: string;
  /** Terminal working directory (the worktree root in the typical case) */
  cwd?: string;
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
  /** Why the agent is waiting (only present when state is "waiting") */
  waitingReason?: WaitingReason;
  /** Extracted session cost in dollars (only present when state is "completed" or "exited") */
  sessionCost?: number;
  /** Extracted session token count (only present when state is "completed" or "exited" and legacy format is used) */
  sessionTokens?: number;
  /**
   * Numeric process exit code, present only on "completed"/"exited" transitions
   * driven by the PTY exit event. `null` when the process was terminated by a
   * signal without a numeric code. Lets MCP subscribers learn pass/fail on the
   * event rather than scraping output.
   */
  exitCode?: number | null;
  /**
   * Raw OS signal number that terminated the process, when applicable (present
   * only on "completed"/"exited"). Taken directly from node-pty — no POSIX
   * 128+signum decoding (that is wrong on Windows, lesson #7028).
   */
  exitSignal?: number;
  /**
   * Parsed test/lint/build result captured at this transition (issue #10682).
   * Best-effort, derived from recognized tool summary lines — NOT an
   * authoritative exit code (see `TerminalCheckResult`). Present only on
   * settling transitions where a NEW recognized check summary was detected;
   * absence does not mean "no check ran". Lets MCP subscribers learn check
   * pass/fail on the event rather than scraping output.
   */
  lastCheckResult?: TerminalCheckResult;
  /**
   * Live activity-temperature reading at the moment the transition was
   * committed. Present only on transitions that flow through the activity
   * detector (i.e. `handleActivityState`). Higher temperature = more visible
   * content churn immediately before the transition; useful for the diagnostics
   * event inspector to disambiguate `working` from `flapping`.
   *
   * Intentionally NOT exposed: the resize `suppressed` flag from
   * `AgentActivityObservationResult` is a separate signal (resize-quiet
   * observation) that would conflate with transition semantics here.
   */
  temperature?: number;
  /** Heat impulse that drove the live temperature sample. Paired with `temperature`. */
  heatAdded?: number;
  /** Number of changed characters in the most recent sample. Paired with `temperature`. */
  changedChars?: number;
}

/**
 * Payload for `agent:state-transition-dropped` events. Records every
 * transition attempt the `AgentStateService` rejected (hysteresis, stale
 * session, schema validation, or no-op). Diagnostics tier — the event
 * inspector surfaces it; no user-visible UI consumes it.
 */
export interface AgentStateTransitionDroppedPayload {
  /** Terminal ID the drop applies to. */
  terminalId: string;
  /** Optional agent identity for inspector grouping. */
  agentId?: AgentId;
  /** Why the transition was dropped. */
  outcome: "no-op" | "hysteresis" | "stale-session" | "schema-invalid";
  /** State the terminal was in when the drop fired. */
  currentState: AgentState;
  /** The state we attempted to transition to. */
  attemptedState?: AgentState;
  /** Trigger that drove the attempt. */
  trigger?: AgentStateChangeTrigger;
  /** Confidence the attempt was made with. */
  confidence?: number;
  /** CWD at the time of the drop. */
  cwd?: string;
  /** Session token the attempt carried (stale-session drops). */
  spawnedAt?: number;
  /** Live session token (stale-session drops). */
  terminalSpawnedAt?: number;
  /** Human-readable explanation — validation error text for `schema-invalid`. */
  reason?: string;
  /** Zod issue messages for `schema-invalid` drops. */
  validationErrors?: string[];
  /** Trace ID for correlation with related events. */
  traceId?: string;
  /** Unix timestamp in milliseconds when the drop was recorded. */
  timestamp: number;
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
  /**
   * Identifies the kind of exit. `"subcommand"` means the detected agent
   * process stopped while the shell PTY is still alive (user quit to shell,
   * process-tree demotion). `"terminal"` means the PTY itself exited but the
   * preserved panel still needs renderer-side live identity cleared.
   *
   * The `agent:exited` channel is dual-purpose: it ALSO fires to clear
   * renderer-side live-detection fields when a plain process icon
   * (npm/vite/etc.) exits. In that case both `agentType` and `exitKind`
   * are undefined, and consumers that care only about actual agent exits
   * should gate on `exitKind === "subcommand" || exitKind === "terminal"`
   * or `agentType !== undefined`.
   * #5807
   */
  exitKind?: "subcommand" | "terminal";
}

/**
 * Emitted when an agent PTY exits with an error classified as fallback-eligible
 * (connection failure or hard auth). The renderer consumes this to walk the
 * preset's `fallbacks` chain and respawn the panel with the next preset.
 */
export interface AgentFallbackTriggeredPayload {
  terminalId: string;
  agentId: string;
  /** Preset that was active when the PTY exited. */
  fromPresetId: string;
  /** Original user-selected preset ID; unchanged across fallback hops. */
  originalPresetId?: string;
  /** Why the classifier decided this was a fallback-eligible exit. */
  reason: "connection" | "auth";
  exitCode: number;
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

/** Result from saving an artifact. `null` is returned when the user cancels the save dialog; failures throw `AppError`. */
export interface SaveArtifactResult {
  /** Path where the file was saved */
  filePath: string;
}

/** Options for applying a patch */
export interface ApplyPatchOptions {
  /** Patch content in unified diff format */
  patchContent: string;
  /** Working directory to apply the patch in */
  cwd: string;
}

/** Result from applying a patch. Failures throw `AppError`. */
export interface ApplyPatchResult {
  /** Files that were modified */
  modifiedFiles: string[];
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
