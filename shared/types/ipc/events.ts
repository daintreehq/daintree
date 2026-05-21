/** Event category for filtering */
export type EventCategory =
  | "system" // sys:* - core system state (worktrees, PR detection)
  | "agent" // agent:* - agent lifecycle and output
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
