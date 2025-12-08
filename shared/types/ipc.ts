import type {
  TerminalType,
  TerminalLocation,
  DevServerState,
  WorktreeState,
  Project,
  ProjectSettings,
  RunCommand,
  GitStatus,
} from "./domain.js";
import type { TerminalActivityPayload } from "./terminal.js";
import type {
  AgentSettings,
  ClaudeSettings,
  GeminiSettings,
  CodexSettings,
} from "./agentSettings.js";
import type { TerminalGridConfig } from "./config.js";
import type { KeyAction } from "./keymap.js";

// Terminal IPC Types

/** Terminal spawn options */
export interface TerminalSpawnOptions {
  /** Optional custom ID for the terminal */
  id?: string;
  /** Working directory for the terminal */
  cwd?: string;
  /** Shell executable to use (defaults to user's shell) */
  shell?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Initial number of columns */
  cols: number;
  /** Initial number of rows */
  rows: number;
  /** Type of terminal */
  type?: TerminalType;
  /** Display title for the terminal */
  title?: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Command to execute after shell starts (e.g., 'claude' for AI agents) */
  command?: string;
}

/** Terminal state for app state persistence */
export interface TerminalState {
  /** Terminal ID */
  id: string;
  /** Terminal type */
  type: TerminalType;
  /** Display title */
  title: string;
  /** Current working directory */
  cwd: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Location in the UI - grid or dock */
  location?: TerminalLocation;
  /** Command to execute after shell starts (e.g., 'claude' for AI agents) */
  command?: string;
  /** Last detected agent type (for restoration hints) */
  lastDetectedAgent?: TerminalType;
  /** Last detected agent title (for restoration hints) */
  lastDetectedAgentTitle?: string;
}

/** Terminal data payload for IPC */
export interface TerminalDataPayload {
  id: string;
  data: string;
}

/** Terminal resize payload for IPC */
export interface TerminalResizePayload {
  id: string;
  cols: number;
  rows: number;
}

/** Terminal kill payload for IPC */
export interface TerminalKillPayload {
  id: string;
}

/** Terminal exit payload for IPC */
export interface TerminalExitPayload {
  id: string;
  exitCode: number;
}

/** Terminal error payload for IPC */
export interface TerminalErrorPayload {
  id: string;
  error: string;
}

/** Terminal info from backend for reconnection */
export interface BackendTerminalInfo {
  id: string;
  projectId?: string;
  type?: TerminalType;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: string;
  spawnedAt: number;
}

/** Result from terminal reconnect operation */
export interface TerminalReconnectResult {
  exists: boolean;
  id?: string;
  type?: TerminalType;
  cwd?: string;
  agentState?: string;
  error?: string;
}

/** Terminal information payload for diagnostic display */
export interface TerminalInfoPayload {
  id: string;
  projectId?: string;
  type?: TerminalType;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: import("./domain.js").AgentState;
  spawnedAt: number;
  lastInputTime: number;
  lastOutputTime: number;
  lastStateChange?: number;
  activityTier: "focused" | "visible" | "background";
  outputBufferSize: number;
  semanticBufferLines: number;
  restartCount: number;
}

// CopyTree IPC Types

/** CopyTree generation options */
export interface CopyTreeOptions {
  /** Output format */
  format?: "xml" | "json" | "markdown" | "tree" | "ndjson";

  /** Pattern filtering */
  filter?: string | string[];
  exclude?: string | string[];
  always?: string[];

  /** Explicit file/folder paths to include (used by file picker modal) */
  includePaths?: string[];

  /** Git filtering */
  modified?: boolean;
  changed?: string;

  /** Size limits */
  maxFileSize?: number;
  maxTotalSize?: number;
  maxFileCount?: number;

  /** Formatting */
  withLineNumbers?: boolean;
  charLimit?: number;

  /** Profile (load from .copytree file) - legacy option */
  profile?: string;
}

export interface CopyTreeGeneratePayload {
  worktreeId: string;
  options?: CopyTreeOptions;
}

export interface CopyTreeGenerateAndCopyFilePayload {
  worktreeId: string;
  options?: CopyTreeOptions;
}

/** Payload for injecting CopyTree context to terminal */
export interface CopyTreeInjectPayload {
  terminalId: string;
  worktreeId: string;
  options?: CopyTreeOptions;
}

/** Payload for getting file tree */
export interface CopyTreeGetFileTreePayload {
  worktreeId: string;
  /** Optional directory path relative to worktree root (defaults to root) */
  dirPath?: string;
}

/** Result from CopyTree generation */
export interface CopyTreeResult {
  /** Generated content */
  content: string;
  /** Number of files included */
  fileCount: number;
  /** Error message if generation failed */
  error?: string;
  /** Generation statistics */
  stats?: {
    totalSize: number;
    duration: number;
  };
}

/** Progress update during CopyTree generation */
export interface CopyTreeProgress {
  /** Current stage name (e.g., 'FileDiscoveryStage', 'FormatterStage') */
  stage: string;
  /** Progress percentage (0-1) */
  progress: number;
  /** Human-readable progress message */
  message: string;
  /** Files processed so far (if known) */
  filesProcessed?: number;
  /** Total files estimated (if known) */
  totalFiles?: number;
  /** Current file being processed (if known) */
  currentFile?: string;
  /** Optional trace ID to track event chains */
  traceId?: string;
}

/** File tree node for file picker */
export interface FileTreeNode {
  /** File/folder name */
  name: string;
  /** Relative path from worktree root */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** File size in bytes (directories have size 0) */
  size?: number;
  /** Children (only populated for directories if expanded) */
  children?: FileTreeNode[];
}

// Worktree IPC Payloads

/** Worktree removal payload */
export interface WorktreeRemovePayload {
  worktreeId: string;
}

/** Payload for setting active worktree */
export interface WorktreeSetActivePayload {
  worktreeId: string;
}

/** Payload for deleting a worktree */
export interface WorktreeDeletePayload {
  worktreeId: string;
  force?: boolean;
}

// Dev Server IPC Payloads

/** Dev server start payload */
export interface DevServerStartPayload {
  worktreeId: string;
  worktreePath: string;
  command?: string;
}

/** Payload for stopping a dev server */
export interface DevServerStopPayload {
  worktreeId: string;
}

/** Payload for toggling a dev server */
export interface DevServerTogglePayload {
  worktreeId: string;
  worktreePath: string;
  command?: string;
}

/** Payload for dev server error notification */
export interface DevServerErrorPayload {
  worktreeId: string;
  error: string;
}

// System IPC Payloads

/** Open external URL payload */
export interface SystemOpenExternalPayload {
  url: string;
}

/** Payload for opening a path */
export interface SystemOpenPathPayload {
  path: string;
}

/** System wake event payload */
export interface SystemWakePayload {
  /** Duration of sleep in milliseconds */
  sleepDuration: number;
  /** Timestamp when the system woke */
  timestamp: number;
}

/** CLI availability status for AI agents */
export interface CliAvailability {
  /** Whether the Claude CLI is available */
  claude: boolean;
  /** Whether the Gemini CLI is available */
  gemini: boolean;
  /** Whether the Codex CLI is available */
  codex: boolean;
}

// PR Detection IPC Payloads

/** PR detected payload */
export interface PRDetectedPayload {
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: string;
  issueNumber?: number;
}

/** Payload for PR cleared notification */
export interface PRClearedPayload {
  worktreeId: string;
}

// Project Close IPC Types

/** Result from project:close operation */
export interface ProjectCloseResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Total number of processes killed */
  processesKilled: number;
  /** Number of terminals killed */
  terminalsKilled: number;
  /** Number of dev servers stopped */
  serversStopped: number;
  /** Error message if operation failed */
  error?: string;
}

/** Project resource statistics */
export interface ProjectStats {
  /** Total number of running processes */
  processCount: number;
  /** Number of terminal processes */
  terminalCount: number;
  /** Number of dev server processes */
  serverCount: number;
  /** Estimated memory usage in MB */
  estimatedMemoryMB: number;
  /** Terminal types breakdown */
  terminalTypes: Record<string, number>;
  /** Process IDs of running terminals */
  processIds: number[];
}

// GitHub IPC Types

/** Repository stats from GitHub API */
export interface RepositoryStats {
  /** Total commit count for current branch */
  commitCount: number;
  /** Open issues count (null if unavailable) */
  issueCount: number | null;
  /** Open pull requests count (null if unavailable) */
  prCount: number | null;
  /** Whether stats are currently loading */
  loading: boolean;
  /** Error message if GitHub API failed */
  ghError?: string;
}

/** GitHub CLI availability check result */
export interface GitHubCliStatus {
  /** Whether gh CLI is available */
  available: boolean;
  /** Error message if not available */
  error?: string;
}

/** GitHub token configuration status */
export interface GitHubTokenConfig {
  /** Whether a token is configured */
  hasToken: boolean;
  /** Token scopes (only available after validation) */
  scopes?: string[];
  /** GitHub username (only available after validation) */
  username?: string;
}

/** GitHub token validation result */
export interface GitHubTokenValidation {
  /** Whether the token is valid */
  valid: boolean;
  /** Token scopes */
  scopes: string[];
  /** GitHub username */
  username?: string;
  /** Error message if validation failed */
  error?: string;
}

// Hibernation IPC Types

/** Configuration for auto-hibernation feature */
export interface HibernationConfig {
  /** Whether auto-hibernation is enabled */
  enabled: boolean;
  /** Hours of inactivity before a project is hibernated */
  inactiveThresholdHours: number;
}

// System Sleep IPC Types

/** Individual sleep period record */
export interface SleepPeriod {
  start: number;
  end: number;
  duration: number;
}

/** Metrics for system sleep tracking */
export interface SystemSleepMetrics {
  /** Total accumulated sleep time in milliseconds since service started */
  totalSleepMs: number;
  /** Array of recorded sleep periods */
  sleepPeriods: SleepPeriod[];
  /** Whether the system is currently sleeping */
  isCurrentlySleeping: boolean;
  /** Timestamp when current sleep started, if sleeping */
  currentSleepStart: number | null;
}

// App State IPC Types

/** Saved recipe terminal */
export interface SavedRecipeTerminal {
  /** Terminal type */
  type: "claude" | "gemini" | "codex" | "shell" | "custom";
  /** Optional title */
  title?: string;
  /** Optional command */
  command?: string;
  /** Optional environment variables */
  env?: Record<string, string>;
}

/** Saved terminal recipe */
export interface SavedRecipe {
  /** Recipe ID */
  id: string;
  /** Recipe name */
  name: string;
  /** Associated worktree ID */
  worktreeId?: string;
  /** Terminal definitions */
  terminals: SavedRecipeTerminal[];
  /** Creation timestamp */
  createdAt: number;
}

/** Application state for persistence */
export interface AppState {
  /** Active terminal states */
  terminals: TerminalState[];
  /** Currently active worktree ID */
  activeWorktreeId?: string;
  /** Width of the sidebar in pixels */
  sidebarWidth: number;
  /** Whether focus mode is active (panels collapsed for max terminal space) */
  focusMode?: boolean;
  /** Saved panel state before entering focus mode (for restoration) */
  focusPanelState?: {
    sidebarWidth: number;
    diagnosticsOpen: boolean;
  };
  /** Height of the diagnostics dock in pixels */
  diagnosticsHeight?: number;
  /** Saved terminal recipes */
  recipes?: SavedRecipe[];
  /** Whether the user has seen the welcome screen */
  hasSeenWelcome?: boolean;
  /** Developer mode settings */
  developerMode?: {
    /** Master toggle for all debug features */
    enabled: boolean;
    /** Show state debug overlays in terminal headers */
    showStateDebug: boolean;
    /** Auto-open diagnostics dock on app startup */
    autoOpenDiagnostics: boolean;
    /** Focus events tab when diagnostics opens (requires autoOpenDiagnostics) */
    focusEventsTab: boolean;
  };
  /** Terminal grid layout configuration */
  terminalGridConfig?: TerminalGridConfig;
  /** Whether the terminal dock is collapsed */
  dockCollapsed?: boolean;
}

/** Result from app hydration */
export interface HydrateResult {
  appState: AppState;
  terminalConfig: TerminalConfig;
  project: Project | null;
  agentSettings: AgentSettings;
}

// Log IPC Types

/** Log level */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A log entry */
export interface LogEntry {
  /** Unique identifier */
  id: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Additional context */
  context?: Record<string, unknown>;
  /** Source of the log (component/service name) */
  source?: string;
}

/** Options for filtering logs */
export interface LogFilterOptions {
  /** Filter by log levels */
  levels?: LogLevel[];
  /** Filter by sources */
  sources?: string[];
  /** Search string */
  search?: string;
  /** Start time filter */
  startTime?: number;
  /** End time filter */
  endTime?: number;
}

// Event Inspector IPC Types

/** Event category for filtering */
export type EventCategory =
  | "system" // sys:* - core system state (worktrees, PR detection)
  | "agent" // agent:* - agent lifecycle and output
  | "task" // task:* - task orchestration
  | "server" // server:* - dev server state
  | "file" // file:* - file operations (copy-tree, open)
  | "ui" // ui:* - UI notifications/state
  | "watcher" // watcher:* - file watching
  | "artifact"; // artifact:* - detected artifacts

/** Common fields that may be present in event payloads */
export interface EventPayload {
  /** Worktree context */
  worktreeId?: string;
  /** Agent context */
  agentId?: string;
  /** Task context */
  taskId?: string;
  /** Run context */
  runId?: string;
  /** Terminal context */
  terminalId?: string;
  /** GitHub issue number */
  issueNumber?: number;
  /** GitHub PR number */
  prNumber?: number;
  /** Trace ID for event correlation */
  traceId?: string;
  /** Event timestamp (may be present in payload) */
  timestamp?: number;
  /** Additional fields are allowed */
  [key: string]: unknown;
}

/** A recorded event for debugging */
export interface EventRecord {
  /** Unique identifier */
  id: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Event type/channel name */
  type: string;
  /** Event category derived from EVENT_META */
  category: EventCategory;
  /** Event payload with common context fields */
  payload: EventPayload;
  /** Source of the event */
  source: "main" | "renderer";
}

/** Options for filtering events */
export interface EventFilterOptions {
  /** Filter by event types */
  types?: string[];
  /** Filter by event category (uses EVENT_META) */
  category?: EventCategory;
  /** Filter by multiple event categories */
  categories?: EventCategory[];
  /** Filter by worktree ID */
  worktreeId?: string;
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by task ID */
  taskId?: string;
  /** Filter by run ID (for multi-agent orchestration) */
  runId?: string;
  /** Filter by terminal ID */
  terminalId?: string;
  /** Filter by GitHub issue number */
  issueNumber?: number;
  /** Filter by GitHub PR number */
  prNumber?: number;
  /** Filter by trace ID */
  traceId?: string;
  /** Search string */
  search?: string;
  /** After timestamp filter */
  after?: number;
  /** Before timestamp filter */
  before?: number;
}

// Error IPC Types

/** Error type */
export type ErrorType = "git" | "process" | "filesystem" | "network" | "config" | "unknown";

/** Action that can be retried after an error */
export type RetryAction =
  | "copytree"
  | "devserver"
  | "terminal"
  | "git"
  | "worktree"
  | "injectContext";

/** Application error for UI display */
export interface AppError {
  /** Unique identifier */
  id: string;
  /** Timestamp when error occurred */
  timestamp: number;
  /** Error type category */
  type: ErrorType;
  /** User-friendly error message */
  message: string;
  /** Technical details */
  details?: string;
  /** Source of the error */
  source?: string;
  /** Context for debugging */
  context?: {
    worktreeId?: string;
    terminalId?: string;
    filePath?: string;
    command?: string;
  };
  /** Whether this error will auto-dismiss */
  isTransient: boolean;
  /** Whether user has dismissed this error */
  dismissed: boolean;
  /** Action that can be retried */
  retryAction?: RetryAction;
  /** Arguments for retry action */
  retryArgs?: Record<string, unknown>;
}

// Agent Session IPC Types

/** Transcript entry */
export interface TranscriptEntry {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Type of entry */
  type: "user" | "agent" | "system";
  /** Content of the entry */
  content: string;
}

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

/** A complete agent session with transcript and artifacts */
export interface AgentSession {
  /** Unique identifier */
  id: string;
  /** Type of agent */
  agentType: "claude" | "gemini" | "codex" | "custom";
  /** Associated worktree ID */
  worktreeId?: string;
  /** Start timestamp */
  startTime: number;
  /** End timestamp (if completed) */
  endTime?: number;
  /** Session state */
  state: "active" | "completed" | "failed";
  /** Full transcript */
  transcript: TranscriptEntry[];
  /** Extracted artifacts */
  artifacts: Artifact[];
  /** Session metadata */
  metadata: {
    terminalId: string;
    cwd: string;
    exitCode?: number;
  };
}

// Agent State Change Payload

/** Agent state change trigger */
export type AgentStateChangeTrigger =
  | "input"
  | "output"
  | "heuristic"
  | "ai-classification"
  | "timeout"
  | "exit";

/** Payload for agent state change events */
export interface AgentStateChangePayload {
  /** Agent/terminal ID */
  agentId: string;
  /** New state */
  state: string;
  /** Previous state */
  previousState: string;
  /** Timestamp of state change */
  timestamp: number;
  /** Optional trace ID to track event chains */
  traceId?: string;
  /** What caused this state change */
  trigger: AgentStateChangeTrigger;
  /** Confidence in the state detection (0.0 = uncertain, 1.0 = certain) */
  confidence: number;
}

// Agent Detection IPC Types

/** Agent detected payload */
export interface AgentDetectedPayload {
  /** Terminal ID where agent was detected */
  terminalId: string;
  /** Type of agent detected */
  agentType: TerminalType;
  /** Process name that was detected */
  processName: string;
  /** Timestamp when detected */
  timestamp: number;
}

/** Payload for agent exited events */
export interface AgentExitedPayload {
  /** Terminal ID where agent exited */
  terminalId: string;
  /** Type of agent that exited */
  agentType: TerminalType;
  /** Timestamp when exited */
  timestamp: number;
}

// Artifact IPC Types

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

// Git IPC Types

/** Get file diff payload */
export interface GitGetFileDiffPayload {
  /** Working directory (worktree path) */
  cwd: string;
  /** Path to the file relative to worktree root */
  filePath: string;
  /** Git status of the file */
  status: GitStatus;
}

// Worktree Creation Types

export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
  remote?: string;
}

export interface CreateWorktreeOptions {
  baseBranch: string;
  newBranch: string;
  path: string;
  fromRemote?: boolean;
}

// Adaptive Backoff IPC Types

/** Adaptive backoff metrics */
export interface AdaptiveBackoffMetrics {
  lastOperationDuration: number;
  consecutiveFailures: number;
  circuitBreakerTripped: boolean;
  currentInterval: number;
}

/** Terminal configuration for scrollback, etc. */
export interface TerminalConfig {
  scrollbackLines: number; // -1 for unlimited, otherwise 100-100000
  performanceMode: boolean;
}

/** Worktree path pattern configuration */
export interface WorktreeConfig {
  pathPattern: string;
}

// IPC Contract Maps

/** Maps IPC channels to their args/result types for type-safe invoke/handle */
export interface IpcInvokeMap {
  // Worktree channels
  "worktree:get-all": {
    args: [];
    result: WorktreeState[];
  };
  "worktree:refresh": {
    args: [];
    result: void;
  };
  "worktree:pr-refresh": {
    args: [];
    result: void;
  };
  "worktree:set-active": {
    args: [payload: WorktreeSetActivePayload];
    result: void;
  };
  "worktree:create": {
    args: [payload: { rootPath: string; options: CreateWorktreeOptions }];
    result: void;
  };
  "worktree:list-branches": {
    args: [payload: { rootPath: string }];
    result: BranchInfo[];
  };
  "worktree:get-default-path": {
    args: [payload: { rootPath: string; branchName: string }];
    result: string;
  };
  "worktree:set-adaptive-backoff-config": {
    args: [payload: { enabled: boolean; maxInterval?: number; threshold?: number }];
    result: void;
  };
  "worktree:is-circuit-breaker-tripped": {
    args: [worktreeId: string];
    result: boolean;
  };
  "worktree:get-adaptive-backoff-metrics": {
    args: [worktreeId: string];
    result: AdaptiveBackoffMetrics | null;
  };
  "worktree:delete": {
    args: [payload: WorktreeDeletePayload];
    result: void;
  };

  // Dev server channels
  "devserver:start": {
    args: [payload: DevServerStartPayload];
    result: DevServerState;
  };
  "devserver:stop": {
    args: [payload: DevServerStopPayload];
    result: DevServerState;
  };
  "devserver:toggle": {
    args: [payload: DevServerTogglePayload];
    result: DevServerState;
  };
  "devserver:get-state": {
    args: [worktreeId: string];
    result: DevServerState;
  };
  "devserver:get-logs": {
    args: [worktreeId: string];
    result: string[];
  };
  "devserver:has-dev-script": {
    args: [worktreePath: string];
    result: boolean;
  };

  // Terminal channels
  "terminal:spawn": {
    args: [options: TerminalSpawnOptions];
    result: string;
  };
  "terminal:kill": {
    args: [id: string];
    result: void;
  };
  "terminal:trash": {
    args: [id: string];
    result: void;
  };
  "terminal:restore": {
    args: [id: string];
    result: boolean;
  };
  "terminal:set-buffering": {
    args: [payload: { id: string; enabled: boolean }];
    result: void;
  };
  "terminal:flush": {
    args: [id: string];
    result: void;
  };
  "terminal:get-for-project": {
    args: [projectId: string];
    result: BackendTerminalInfo[];
  };
  "terminal:reconnect": {
    args: [terminalId: string];
    result: TerminalReconnectResult;
  };
  "terminal:replay-history": {
    args: [payload: { terminalId: string; maxLines?: number }];
    result: { replayed: number };
  };
  "terminal:get-serialized-state": {
    args: [terminalId: string];
    result: string | null;
  };
  "terminal:get-shared-buffer": {
    args: [];
    result: SharedArrayBuffer | null;
  };
  "terminal:get-analysis-buffer": {
    args: [];
    result: SharedArrayBuffer | null;
  };
  "terminal:get-info": {
    args: [id: string];
    result: TerminalInfoPayload;
  };

  // Agent channels
  "agent:get-state": {
    args: [agentId: string];
    result: string | null;
  };

  // Artifact channels
  "artifact:save-to-file": {
    args: [options: SaveArtifactOptions];
    result: SaveArtifactResult | null;
  };
  "artifact:apply-patch": {
    args: [options: ApplyPatchOptions];
    result: ApplyPatchResult;
  };

  // CopyTree channels
  "copytree:generate": {
    args: [payload: CopyTreeGeneratePayload];
    result: CopyTreeResult;
  };
  "copytree:generate-and-copy-file": {
    args: [payload: CopyTreeGenerateAndCopyFilePayload];
    result: CopyTreeResult;
  };
  "copytree:inject": {
    args: [payload: CopyTreeInjectPayload];
    result: CopyTreeResult;
  };
  "copytree:available": {
    args: [];
    result: boolean;
  };
  "copytree:cancel": {
    args: [];
    result: void;
  };
  "copytree:get-file-tree": {
    args: [payload: CopyTreeGetFileTreePayload];
    result: FileTreeNode[];
  };

  // System channels
  "system:open-external": {
    args: [payload: SystemOpenExternalPayload];
    result: void;
  };
  "system:open-path": {
    args: [payload: SystemOpenPathPayload];
    result: void;
  };
  "system:check-command": {
    args: [command: string];
    result: boolean;
  };
  "system:get-home-dir": {
    args: [];
    result: string;
  };
  "system:get-cli-availability": {
    args: [];
    result: CliAvailability;
  };
  "system:refresh-cli-availability": {
    args: [];
    result: CliAvailability;
  };

  // App state channels
  "app:get-state": {
    args: [];
    result: AppState;
  };
  "app:set-state": {
    args: [partialState: Partial<AppState>];
    result: void;
  };
  "app:get-version": {
    args: [];
    result: string;
  };
  "app:hydrate": {
    args: [];
    result: HydrateResult;
  };

  // Directory channels (legacy - migrated to Projects system)
  // Note: Directory channels have been removed as part of the migration
  // to the Projects system. Use project:* channels instead.

  // Logs channels
  "logs:get-all": {
    args: [filters?: LogFilterOptions];
    result: LogEntry[];
  };
  "logs:get-sources": {
    args: [];
    result: string[];
  };
  "logs:clear": {
    args: [];
    result: void;
  };
  "logs:open-file": {
    args: [];
    result: void;
  };
  "logs:set-verbose": {
    args: [enabled: boolean];
    result: { success: boolean };
  };
  "logs:get-verbose": {
    args: [];
    result: boolean;
  };

  // Error channels
  "error:retry": {
    args: [payload: { errorId: string; action: RetryAction; args?: Record<string, unknown> }];
    result: void;
  };
  "error:open-logs": {
    args: [];
    result: void;
  };

  // Event inspector channels
  "event-inspector:get-events": {
    args: [];
    result: EventRecord[];
  };
  "event-inspector:get-filtered": {
    args: [filters: EventFilterOptions];
    result: EventRecord[];
  };
  "event-inspector:clear": {
    args: [];
    result: void;
  };

  // Project channels
  "project:get-all": {
    args: [];
    result: Project[];
  };
  "project:get-current": {
    args: [];
    result: Project | null;
  };
  "project:add": {
    args: [path: string];
    result: Project;
  };
  "project:remove": {
    args: [projectId: string];
    result: void;
  };
  "project:update": {
    args: [projectId: string, updates: Partial<Project>];
    result: Project;
  };
  "project:switch": {
    args: [projectId: string];
    result: Project;
  };
  "project:open-dialog": {
    args: [];
    result: string | null;
  };
  "project:get-settings": {
    args: [projectId: string];
    result: ProjectSettings;
  };
  "project:save-settings": {
    args: [payload: { projectId: string; settings: ProjectSettings }];
    result: void;
  };
  "project:detect-runners": {
    args: [projectId: string];
    result: RunCommand[];
  };
  "project:close": {
    args: [projectId: string];
    result: ProjectCloseResult;
  };
  "project:get-stats": {
    args: [projectId: string];
    result: ProjectStats;
  };

  // GitHub channels
  "github:get-repo-stats": {
    args: [cwd: string];
    result: RepositoryStats;
  };
  "github:open-issues": {
    args: [cwd: string];
    result: void;
  };
  "github:open-prs": {
    args: [cwd: string];
    result: void;
  };
  "github:open-issue": {
    args: [payload: { cwd: string; issueNumber: number }];
    result: void;
  };
  "github:open-pr": {
    args: [prUrl: string];
    result: void;
  };
  "github:check-cli": {
    args: [];
    result: GitHubCliStatus;
  };
  "github:get-config": {
    args: [];
    result: GitHubTokenConfig;
  };
  "github:set-token": {
    args: [token: string];
    result: GitHubTokenValidation;
  };
  "github:clear-token": {
    args: [];
    result: void;
  };
  "github:validate-token": {
    args: [token: string];
    result: GitHubTokenValidation;
  };
  "github:list-issues": {
    args: [
      options: { cwd: string; search?: string; state?: "open" | "closed" | "all"; cursor?: string },
    ];
    result: import("./github.js").GitHubListResponse<import("./github.js").GitHubIssue>;
  };
  "github:list-prs": {
    args: [
      options: {
        cwd: string;
        search?: string;
        state?: "open" | "closed" | "merged" | "all";
        cursor?: string;
      },
    ];
    result: import("./github.js").GitHubListResponse<import("./github.js").GitHubPR>;
  };

  // Agent settings channels
  "agent-settings:get": {
    args: [];
    result: AgentSettings;
  };
  "agent-settings:set": {
    args: [
      payload: { agentType: "claude" | "gemini" | "codex"; settings: Record<string, unknown> },
    ];
    result: AgentSettings;
  };
  "agent-settings:reset": {
    args: [agentType?: "claude" | "gemini" | "codex"];
    result: AgentSettings;
  };

  // Terminal config channels
  "terminal-config:get": {
    args: [];
    result: TerminalConfig;
  };
  "terminal-config:set-scrollback": {
    args: [scrollbackLines: number];
    result: void;
  };
  "terminal-config:set-performance-mode": {
    args: [performanceMode: boolean];
    result: void;
  };

  // Git channels
  "git:get-file-diff": {
    args: [payload: GitGetFileDiffPayload];
    result: string;
  };

  // Sidecar channels
  "sidecar:create": {
    args: [payload: import("./sidecar.js").SidecarCreatePayload];
    result: void;
  };
  "sidecar:show": {
    args: [payload: import("./sidecar.js").SidecarShowPayload];
    result: void;
  };
  "sidecar:hide": {
    args: [];
    result: void;
  };
  "sidecar:resize": {
    args: [bounds: import("./sidecar.js").SidecarBounds];
    result: void;
  };
  "sidecar:close-tab": {
    args: [payload: import("./sidecar.js").SidecarCloseTabPayload];
    result: void;
  };
  "sidecar:navigate": {
    args: [payload: import("./sidecar.js").SidecarNavigatePayload];
    result: void;
  };
  "sidecar:go-back": {
    args: [tabId: string];
    result: boolean;
  };
  "sidecar:go-forward": {
    args: [tabId: string];
    result: boolean;
  };
  "sidecar:reload": {
    args: [tabId: string];
    result: void;
  };

  // System Sleep channels
  "system-sleep:get-metrics": {
    args: [];
    result: SystemSleepMetrics;
  };
  "system-sleep:get-awake-time": {
    args: [startTimestamp: number];
    result: number;
  };
  "system-sleep:reset": {
    args: [];
    result: void;
  };

  // Keybinding channels
  "keybinding:get-overrides": {
    args: [];
    result: Record<KeyAction, string[]>;
  };
  "keybinding:set-override": {
    args: [payload: { actionId: KeyAction; combo: string[] }];
    result: void;
  };
  "keybinding:remove-override": {
    args: [actionId: KeyAction];
    result: void;
  };
  "keybinding:reset-all": {
    args: [];
    result: void;
  };

  // Worktree Config channels
  "worktree-config:get": {
    args: [];
    result: WorktreeConfig;
  };
  "worktree-config:set-pattern": {
    args: [payload: { pattern: string }];
    result: WorktreeConfig;
  };

  // History channels
  "history:get-all": {
    args: [];
    result: AgentSession[];
  };
  "history:get-session": {
    args: [id: string];
    result: AgentSession | null;
  };
  "history:delete": {
    args: [id: string];
    result: void;
  };
  "history:export": {
    args: [id: string];
    result: string | null;
  };
}

/**
 * IPC Event Contract Map
 *
 * Maps event channel names to their payload types for send/on patterns.
 * Used to type-check ipcRenderer.on callbacks and webContents.send payloads.
 *
 * Usage in preload (subscribing):
 * ```typescript
 * function typedOn<K extends keyof IpcEventMap>(
 *   channel: K,
 *   callback: (payload: IpcEventMap[K]) => void
 * ): () => void {
 *   const handler = (_event: IpcRendererEvent, payload: IpcEventMap[K]) => callback(payload);
 *   ipcRenderer.on(channel, handler);
 *   return () => ipcRenderer.removeListener(channel, handler);
 * }
 * ```
 *
 * Usage in main (sending):
 * ```typescript
 * function typedSend<K extends keyof IpcEventMap>(
 *   window: BrowserWindow,
 *   channel: K,
 *   payload: IpcEventMap[K]
 * ): void {
 *   window.webContents.send(channel, payload);
 * }
 * ```
 */
export interface IpcEventMap {
  // Worktree events
  "worktree:update": WorktreeState;
  "worktree:remove": { worktreeId: string };

  // Dev server events
  "devserver:update": DevServerState;
  "devserver:error": DevServerErrorPayload;

  // Terminal events (these have multiple arguments, represented as tuples)
  "terminal:data": [id: string, data: string];
  "terminal:exit": [id: string, exitCode: number];
  "terminal:error": [id: string, error: string];
  "terminal:trashed": { id: string; expiresAt: number };
  "terminal:restored": { id: string };

  // Agent events
  "agent:state-changed": AgentStateChangePayload;
  "agent:detected": AgentDetectedPayload;
  "agent:exited": AgentExitedPayload;

  // Terminal activity events
  "terminal:activity": TerminalActivityPayload;

  // Artifact events
  "artifact:detected": ArtifactDetectedPayload;

  // CopyTree events
  "copytree:progress": CopyTreeProgress;

  // PR detection events
  "pr:detected": PRDetectedPayload;
  "pr:cleared": PRClearedPayload;

  // Error events
  "error:notify": AppError;

  // Log events
  "logs:entry": LogEntry;

  // Event inspector events
  "event-inspector:event": EventRecord;

  // Project events
  "project:on-switch": Project;

  // System events
  "system:wake": SystemWakePayload;

  // Sidecar events
  "sidecar:nav-event": import("./sidecar.js").SidecarNavEvent;

  // System Sleep events
  "system-sleep:on-wake": number;
}

/**
 * Helper type to extract argument types from IpcInvokeMap
 */
export type IpcInvokeArgs<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["args"];

/**
 * Helper type to extract result type from IpcInvokeMap
 */
export type IpcInvokeResult<K extends keyof IpcInvokeMap> = IpcInvokeMap[K]["result"];

/**
 * Helper type to extract payload type from IpcEventMap
 */
export type IpcEventPayload<K extends keyof IpcEventMap> = IpcEventMap[K];

// ElectronAPI Type (exposed via preload)

/** Complete Electron API exposed to renderer */
export interface ElectronAPI {
  worktree: {
    getAll(): Promise<WorktreeState[]>;
    refresh(): Promise<void>;
    refreshPullRequests(): Promise<void>;
    setActive(worktreeId: string): Promise<void>;
    create(options: CreateWorktreeOptions, rootPath: string): Promise<void>;
    listBranches(rootPath: string): Promise<BranchInfo[]>;
    getDefaultPath(rootPath: string, branchName: string): Promise<string>;
    setAdaptiveBackoffConfig(
      enabled: boolean,
      maxInterval?: number,
      threshold?: number
    ): Promise<void>;
    isCircuitBreakerTripped(worktreeId: string): Promise<boolean>;
    getAdaptiveBackoffMetrics(worktreeId: string): Promise<AdaptiveBackoffMetrics | null>;
    delete(worktreeId: string, force?: boolean): Promise<void>;
    onUpdate(callback: (state: WorktreeState) => void): () => void;
    onRemove(callback: (data: { worktreeId: string }) => void): () => void;
  };
  devServer: {
    start(worktreeId: string, worktreePath: string, command?: string): Promise<DevServerState>;
    stop(worktreeId: string): Promise<DevServerState>;
    toggle(worktreeId: string, worktreePath: string, command?: string): Promise<DevServerState>;
    getState(worktreeId: string): Promise<DevServerState>;
    getLogs(worktreeId: string): Promise<string[]>;
    hasDevScript(worktreePath: string): Promise<boolean>;
    onUpdate(callback: (state: DevServerState) => void): () => void;
    onError(callback: (data: { worktreeId: string; error: string }) => void): () => void;
  };
  terminal: {
    spawn(options: TerminalSpawnOptions): Promise<string>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<void>;
    trash(id: string): Promise<void>;
    restore(id: string): Promise<boolean>;
    setBuffering(id: string, enabled: boolean): Promise<void>;
    flush(id: string): Promise<void>;
    acknowledgeData(id: string, length: number): void;
    setActivityTier(id: string, tier: "focused" | "visible" | "background"): void;
    getForProject(projectId: string): Promise<BackendTerminalInfo[]>;
    reconnect(terminalId: string): Promise<TerminalReconnectResult>;
    replayHistory(terminalId: string, maxLines?: number): Promise<{ replayed: number }>;
    getSerializedState(terminalId: string): Promise<string | null>;
    getSharedBuffer(): Promise<SharedArrayBuffer | null>;
    getAnalysisBuffer(): Promise<SharedArrayBuffer | null>;
    getInfo(id: string): Promise<TerminalInfoPayload>;
    getMessagePort(): Promise<any | null>;
    isMessagePortAvailable(): boolean;
    onData(id: string, callback: (data: string | Uint8Array) => void): () => void;
    onExit(callback: (id: string, exitCode: number) => void): () => void;
    onAgentStateChanged(callback: (data: AgentStateChangePayload) => void): () => void;
    onAgentDetected(callback: (data: AgentDetectedPayload) => void): () => void;
    onAgentExited(callback: (data: AgentExitedPayload) => void): () => void;
    onActivity(callback: (data: TerminalActivityPayload) => void): () => void;
    onTrashed(callback: (data: { id: string; expiresAt: number }) => void): () => void;
    onRestored(callback: (data: { id: string }) => void): () => void;
  };
  artifact: {
    onDetected(callback: (data: ArtifactDetectedPayload) => void): () => void;
    saveToFile(options: SaveArtifactOptions): Promise<SaveArtifactResult | null>;
    applyPatch(options: ApplyPatchOptions): Promise<ApplyPatchResult>;
  };
  copyTree: {
    generate(worktreeId: string, options?: CopyTreeOptions): Promise<CopyTreeResult>;
    generateAndCopyFile(worktreeId: string, options?: CopyTreeOptions): Promise<CopyTreeResult>;
    injectToTerminal(
      terminalId: string,
      worktreeId: string,
      options?: CopyTreeOptions
    ): Promise<CopyTreeResult>;
    isAvailable(): Promise<boolean>;
    cancel(): Promise<void>;
    getFileTree(worktreeId: string, dirPath?: string): Promise<FileTreeNode[]>;
    onProgress(callback: (progress: CopyTreeProgress) => void): () => void;
  };
  system: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    checkCommand(command: string): Promise<boolean>;
    getHomeDir(): Promise<string>;
    getCliAvailability(): Promise<CliAvailability>;
    refreshCliAvailability(): Promise<CliAvailability>;
    onWake(callback: (data: SystemWakePayload) => void): () => void;
  };
  app: {
    getState(): Promise<AppState>;
    setState(partialState: Partial<AppState>): Promise<void>;
    getVersion(): Promise<string>;
    hydrate(): Promise<HydrateResult>;
  };
  logs: {
    getAll(filters?: LogFilterOptions): Promise<LogEntry[]>;
    getSources(): Promise<string[]>;
    clear(): Promise<void>;
    openFile(): Promise<void>;
    setVerbose(enabled: boolean): Promise<{ success: boolean }>;
    getVerbose(): Promise<boolean>;
    onEntry(callback: (entry: LogEntry) => void): () => void;
  };
  errors: {
    onError(callback: (error: AppError) => void): () => void;
    retry(errorId: string, action: RetryAction, args?: Record<string, unknown>): Promise<void>;
    openLogs(): Promise<void>;
  };
  eventInspector: {
    getEvents(): Promise<EventRecord[]>;
    getFiltered(filters: EventFilterOptions): Promise<EventRecord[]>;
    clear(): Promise<void>;
    subscribe(): void;
    unsubscribe(): void;
    onEvent(callback: (event: EventRecord) => void): () => void;
  };
  project: {
    getAll(): Promise<Project[]>;
    getCurrent(): Promise<Project | null>;
    add(path: string): Promise<Project>;
    remove(projectId: string): Promise<void>;
    update(projectId: string, updates: Partial<Project>): Promise<Project>;
    switch(projectId: string): Promise<Project>;
    openDialog(): Promise<string | null>;
    onSwitch(callback: (project: Project) => void): () => void;
    getSettings(projectId: string): Promise<ProjectSettings>;
    saveSettings(projectId: string, settings: ProjectSettings): Promise<void>;
    detectRunners(projectId: string): Promise<RunCommand[]>;
    close(projectId: string): Promise<ProjectCloseResult>;
    getStats(projectId: string): Promise<ProjectStats>;
  };
  agentSettings: {
    get(): Promise<AgentSettings>;
    setClaude(settings: Partial<ClaudeSettings>): Promise<AgentSettings>;
    setGemini(settings: Partial<GeminiSettings>): Promise<AgentSettings>;
    setCodex(settings: Partial<CodexSettings>): Promise<AgentSettings>;
    reset(agentType?: "claude" | "gemini" | "codex"): Promise<AgentSettings>;
  };
  github: {
    getRepoStats(cwd: string): Promise<RepositoryStats>;
    openIssues(cwd: string): Promise<void>;
    openPRs(cwd: string): Promise<void>;
    openIssue(cwd: string, issueNumber: number): Promise<void>;
    openPR(prUrl: string): Promise<void>;
    checkCli(): Promise<GitHubCliStatus>;
    getConfig(): Promise<GitHubTokenConfig>;
    setToken(token: string): Promise<GitHubTokenValidation>;
    clearToken(): Promise<void>;
    validateToken(token: string): Promise<GitHubTokenValidation>;
    listIssues(options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "all";
      cursor?: string;
    }): Promise<import("./github.js").GitHubListResponse<import("./github.js").GitHubIssue>>;
    listPullRequests(options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "merged" | "all";
      cursor?: string;
    }): Promise<import("./github.js").GitHubListResponse<import("./github.js").GitHubPR>>;
    onPRDetected(callback: (data: PRDetectedPayload) => void): () => void;
    onPRCleared(callback: (data: PRClearedPayload) => void): () => void;
  };
  git: {
    getFileDiff(cwd: string, filePath: string, status: GitStatus): Promise<string>;
  };
  terminalConfig: {
    get(): Promise<TerminalConfig>;
    setScrollback(scrollbackLines: number): Promise<void>;
    setPerformanceMode(performanceMode: boolean): Promise<void>;
  };
  sidecar: {
    create(payload: import("./sidecar.js").SidecarCreatePayload): Promise<void>;
    show(payload: import("./sidecar.js").SidecarShowPayload): Promise<void>;
    hide(): Promise<void>;
    resize(bounds: import("./sidecar.js").SidecarBounds): Promise<void>;
    closeTab(payload: import("./sidecar.js").SidecarCloseTabPayload): Promise<void>;
    navigate(payload: import("./sidecar.js").SidecarNavigatePayload): Promise<void>;
    goBack(tabId: string): Promise<boolean>;
    goForward(tabId: string): Promise<boolean>;
    reload(tabId: string): Promise<void>;
    onNavEvent(callback: (data: import("./sidecar.js").SidecarNavEvent) => void): () => void;
  };
  hibernation: {
    getConfig(): Promise<HibernationConfig>;
    updateConfig(config: Partial<HibernationConfig>): Promise<HibernationConfig>;
  };
  systemSleep: {
    /** Get metrics about system sleep tracking */
    getMetrics(): Promise<SystemSleepMetrics>;
    /** Get elapsed awake time since timestamp, excluding sleep periods */
    getAwakeTimeSince(startTimestamp: number): Promise<number>;
    /** Reset accumulated sleep tracking */
    reset(): Promise<void>;
    /** Subscribe to wake events with sleep duration */
    onWake(callback: (sleepDurationMs: number) => void): () => void;
  };
  keybinding: {
    /** Get current keybinding overrides */
    getOverrides(): Promise<Record<KeyAction, string[]>>;
    /** Set override for a specific action */
    setOverride(actionId: KeyAction, combo: string[]): Promise<void>;
    /** Remove override for a specific action (revert to default) */
    removeOverride(actionId: KeyAction): Promise<void>;
    /** Reset all overrides to defaults */
    resetAll(): Promise<void>;
  };
  worktreeConfig: {
    /** Get worktree path pattern configuration */
    get(): Promise<WorktreeConfig>;
    /** Set worktree path pattern */
    setPattern(pattern: string): Promise<WorktreeConfig>;
  };
  window: {
    /** Subscribe to fullscreen state changes */
    onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void;
  };
  history: {
    /** Get all saved agent sessions */
    getAll(): Promise<AgentSession[]>;
    /** Get a specific session by ID */
    getSession(id: string): Promise<AgentSession | null>;
    /** Delete a session by ID */
    deleteSession(id: string): Promise<void>;
    /** Export a session to markdown file, returns the file path or null if cancelled */
    exportSession(id: string): Promise<string | null>;
  };
}
