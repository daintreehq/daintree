import { EventEmitter } from "events";
import type { NotificationPayload, AgentState, EventCategory } from "../types/index.js";
import type { EventContext } from "../../shared/types/events.js";
import type { WorktreeSnapshot as WorktreeState } from "../../shared/types/workspace-host.js";
import type {
  TerminalReliabilityMetricPayload,
  TerminalFlowStatus,
} from "../../shared/types/pty-host.js";
import type { ExitReason } from "./pty/types.js";

export type { EventCategory };

/**
 * Metadata for each event type.
 * Provides category mapping and context requirements for validation.
 */
export interface EventMetadata {
  category: EventCategory;
  requiresContext: boolean;
  requiresTimestamp: boolean;
  description: string;
}

/**
 * Metadata mapping for all event types.
 * Single source of truth for event categorization and validation requirements.
 */
export const EVENT_META: Record<keyof DaintreeEventMap, EventMetadata> = {
  // System events
  "sys:ready": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Application ready with initial working directory",
  },
  "sys:refresh": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Request to refresh worktree list",
  },
  "sys:quit": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Application quit requested",
  },
  "sys:config:reload": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Configuration reload requested",
  },
  "sys:worktree:switch": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: false,
    description: "Active worktree changed",
  },
  "sys:worktree:refresh": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Worktree list refresh requested",
  },
  "sys:worktree:cycle": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Cycle to next/previous worktree",
  },
  "sys:worktree:selectByName": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Select worktree by name pattern",
  },
  "sys:worktree:update": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Worktree state changed (files, branch, summary)",
  },
  "sys:worktree:remove": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Worktree was removed from monitoring",
  },
  "sys:pr:detected": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Pull request detected for worktree branch",
  },
  "sys:pr:cleared": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Pull request association cleared",
  },
  "sys:pr:detection-state": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: true,
    description: "PR detection circuit breaker tripped or recovered",
  },
  "sys:issue:detected": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Issue metadata detected for worktree branch",
  },
  "sys:issue:not-found": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Forge provider confirmed issue does not exist on current repo",
  },
  "sys:forge:remote-changed": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Repo's git remotes changed — forge provider must be re-resolved",
  },
  "sys:wake": {
    category: "system",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Machine resumed from sleep, after the host's settle delay",
  },

  // File events
  "file:open": {
    category: "file",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Open file in external editor",
  },
  "file:copy-tree": {
    category: "file",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Generate CopyTree context",
  },
  "file:copy-path": {
    category: "file",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Copy path to clipboard",
  },

  // UI events
  "ui:notify": {
    category: "ui",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Display notification to user",
  },
  "ui:filter:set": {
    category: "ui",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Set filter query",
  },
  "ui:filter:clear": {
    category: "ui",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Clear filter query",
  },
  "ui:modal:open": {
    category: "ui",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Open modal dialog",
  },
  "ui:modal:close": {
    category: "ui",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Close modal dialog",
  },

  // Watcher events
  "watcher:change": {
    category: "watcher",
    requiresContext: false,
    requiresTimestamp: false,
    description: "File system change detected",
  },

  // Agent events
  "agent:spawned": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Agent process spawned in terminal",
  },
  "agent:fallback-triggered": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Agent preset exited with a fallback-eligible error",
  },
  "agent:state-changed": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Agent state changed (idle, working, completed, etc.)",
  },
  "agent:state-transition-dropped": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description:
      "Agent state transition attempt was dropped (hysteresis, stale-session, schema-invalid, no-op) — diagnostics tier",
  },
  "agent:all-clear": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "All concurrent agents finished — workspace fully quiet",
  },
  "agent:detected": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Agent CLI detected in terminal process tree",
  },
  "agent:exited": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Agent CLI exited from terminal",
  },
  "agent:output": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Agent produced output (sanitized in EventBuffer)",
  },
  "agent:completed": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Agent completed work successfully",
  },
  "agent:killed": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Agent was killed (user or system action)",
  },

  // Artifact events
  "artifact:detected": {
    category: "artifact",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Code artifacts extracted from agent output",
  },

  // Action events
  "action:dispatched": {
    category: "ui",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Action dispatched by user, keybinding, menu, or agent",
  },

  // Terminal events
  "terminal:trashed": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Terminal moved to trash pending deletion",
  },
  "terminal:restored": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Terminal restored from trash",
  },
  "terminal:park-changed": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "A run was parked or unparked (user intent, not agent state)",
  },
  "terminal:title-changed": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "A panel was renamed and the authoritative record now agrees",
  },
  "terminal:worktree-changed": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "A run was re-filed onto another worktree (or none) and the record now agrees",
  },
  "terminal:park-released": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "A parked run was released because its gate terminal came free or closed",
  },
  "terminal:snooze-changed": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "A run was snoozed or unsnoozed (user intent, not agent state)",
  },
  "agent-session:captured": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: false,
    description: "Pty-host captured a resumable session; Main must persist it",
  },
  "agent-session:recorded": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "A close path journaled a resumable agent session",
  },
  "terminal:activity": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Terminal activity state changed with human-readable headlines",
  },
  "terminal:status": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Terminal flow control status changed (running, paused)",
  },
  "terminal:backgrounded": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Terminal backgrounded during project switch (kept alive but hidden)",
  },
  "terminal:foregrounded": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Terminal foregrounded during project switch (visible again)",
  },
  "terminal:reliability-metric": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Terminal reliability metric (pause/suspend/wake timing)",
  },
  "terminal:exited": {
    category: "agent",
    requiresContext: false,
    requiresTimestamp: true,
    description: "Terminal PTY exited (natural, kill, graceful-shutdown, or dispose)",
  },
};

export function getEventCategory(eventType: keyof DaintreeEventMap): EventCategory {
  return EVENT_META[eventType]?.category ?? "system";
}

export function getEventTypesForCategory(category: EventCategory): Array<keyof DaintreeEventMap> {
  return (Object.keys(EVENT_META) as Array<keyof DaintreeEventMap>).filter(
    (key) => EVENT_META[key].category === category
  );
}

export type WithBase<T> = T & BaseEventPayload;

/**
 * Use for events that require correlation context (worktreeId, agentId, etc.).
 * Note: Since BaseEventPayload now extends EventContext, this is equivalent to WithBase<T>.
 */
export type WithContext<T> = T & BaseEventPayload;

export type SystemEventType = Extract<keyof DaintreeEventMap, `sys:${string}`>;
export type AgentEventType = Extract<keyof DaintreeEventMap, `agent:${string}`>;
export type FileEventType = Extract<keyof DaintreeEventMap, `file:${string}`>;
export type UIEventType = Extract<keyof DaintreeEventMap, `ui:${string}`>;

export type ModalId = "worktree" | "command-palette";
export interface ModalContextMap {
  worktree: undefined;
  "command-palette": undefined;
}

/**
 * Trigger types for agent state changes.
 * Indicates what caused an agent's state to change.
 *
 * - `input`: User sent input to terminal (deterministic, confidence 1.0)
 * - `output`: PTY emitted output (deterministic, confidence 1.0)
 * - `heuristic`: Pattern matching detected prompt/busy (confidence 0.7-0.9)
 * - `ai-classification`: AI model classified state (confidence 0.8-0.95)
 * - `timeout`: Silence timeout triggered check (confidence varies)
 * - `exit`: Process exited (deterministic, confidence 1.0)
 * - `activity`: Activity monitor detected data flow or silence (confidence 1.0)
 */
export type AgentStateChangeTrigger =
  | "input"
  | "output"
  | "heuristic"
  | "ai-classification"
  | "timeout"
  | "exit"
  | "activity"
  | "title";

/**
 * Base event payload with optional trace correlation ID and event context.
 * All domain events extend this interface to enable filtering and correlation
 * across the event stream.
 *
 * @example
 * // Event payload with full context
 * const payload: BaseEventPayload = {
 *   timestamp: Date.now(),
 *   traceId: 'trace-123',
 *   worktreeId: 'wt-abc',
 *   agentId: 'agent-456',
 *   terminalId: 'term-789',
 * };
 */
export interface BaseEventPayload extends EventContext {
  /** UUID to track related events across the system */
  traceId?: string;
  /** Unix timestamp in milliseconds when the event occurred */
  timestamp: number;
}

export interface CopyTreePayload {
  rootPath?: string;
  profile?: string;
  extraArgs?: string[];
  files?: string[];
}

export interface CopyPathPayload {
  path: string;
}

export type UIModalOpenPayload = {
  [Id in ModalId]: { id: Id; context?: ModalContextMap[Id] };
}[ModalId];

export interface UIModalClosePayload {
  id?: ModalId; // If omitted, close all
}

export interface WatcherChangePayload {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  path: string;
}

export interface WorktreeCyclePayload {
  direction: number;
}

export interface WorktreeSelectByNamePayload {
  query: string;
}

export type DaintreeEventMap = {
  "sys:ready": { cwd: string };
  "sys:refresh": void;
  "sys:quit": void;
  "sys:config:reload": void;

  "file:open": { path: string };
  "file:copy-tree": CopyTreePayload;
  "file:copy-path": CopyPathPayload;

  "ui:notify": NotificationPayload;
  "ui:filter:set": { query: string };
  "ui:filter:clear": void;
  "ui:modal:open": UIModalOpenPayload;
  "ui:modal:close": UIModalClosePayload;

  "sys:worktree:switch": { worktreeId: string };
  "sys:worktree:refresh": void;
  "sys:worktree:cycle": WorktreeCyclePayload;
  "sys:worktree:selectByName": WorktreeSelectByNamePayload;
  "sys:worktree:update": WorktreeState;
  "sys:worktree:remove": { worktreeId: string; timestamp: number };

  "watcher:change": WatcherChangePayload;

  "sys:pr:detected": {
    worktreeId: string;
    prNumber: number;
    prUrl: string;
    prState: import("../../shared/types/forge.js").NormalizedPRState;
    prCiStatus?: import("../../shared/types/forge.js").CIStatusState;
    /**
     * True on the synchronous phase-1 emit that precedes a fire-and-forget CI
     * enrichment; signals the receiver to keep its prior `prCiStatus` rather
     * than blink it to `undefined` before the phase-2 emit lands.
     */
    isCiStatusLoading?: boolean;
    prTitle?: string;
    issueNumber?: number;
    issueTitle?: string;
    /** Branch the lookup was initiated against; receivers drop the overlay if the worktree's branch has changed. */
    branchName?: string;
    /** Provider that resolved the PR (e.g. `"daintree.github.github"`). */
    providerId: string;
    /** Canonical repository owner the PR/issue belongs to. */
    owner: string;
    /** Canonical repository name the PR/issue belongs to. */
    repo: string;
    /** Provider-agnostic CI status (forge format). */
    ciStatus?: import("../../shared/types/forge.js").CIStatus;
    /** Branch the PR merges into (e.g. "develop"); drives base-branch divergence display. */
    baseRef?: string;
    timestamp: number;
  };
  "sys:pr:cleared": {
    worktreeId: string;
    /** Branch the clear was initiated against; receivers drop the overlay if the worktree's branch has changed. */
    branchName?: string;
    /** Provider whose linkage was cleared. */
    providerId?: string;
    timestamp: number;
  };
  "sys:pr:detection-state": {
    /** True when the circuit breaker has tripped (detection paused); false on recovery. */
    tripped: boolean;
    timestamp: number;
  };

  "sys:issue:detected": {
    worktreeId: string;
    issueNumber: number;
    issueTitle: string;
    /** Branch the lookup was initiated against; receivers drop the overlay if the worktree's branch has changed. */
    branchName?: string;
    /** Provider that resolved the issue (e.g. `"daintree.github.github"`). */
    providerId: string;
    /** Canonical repository owner the issue belongs to. */
    owner: string;
    /** Canonical repository name the issue belongs to. */
    repo: string;
    timestamp: number;
  };

  "sys:issue:not-found": {
    worktreeId: string;
    issueNumber: number;
    timestamp: number;
  };

  /**
   * The repo's git remote table changed (`git remote add` / `set-url` /
   * `remove`), detected from a `.git/config` write (#11155). Repo-level, so it
   * carries no worktree id. Deliberately distinct from `sys:worktree:update`:
   * `PullRequestService` pauses provider resolution forever on a "no-match"
   * (#9997), and only a signal this narrow may release that pause — a generic
   * worktree update must not.
   */
  "sys:forge:remote-changed": {
    timestamp: number;
  };

  /**
   * Machine resumed from sleep, emitted from the same debounced resume handler
   * that pushes `system:wake` to the renderer — after the pty and workspace
   * hosts have been resynced, so a listener that re-reads state sees post-wake
   * data. `sleepDuration` is `0` when the matching suspend edge was never
   * observed, which means "unknown", not "a short sleep".
   */
  "sys:wake": {
    sleepDuration: number;
    timestamp: number;
  };

  /**
   * Emitted when a new AI agent (Claude, Gemini, etc.) is spawned in a terminal.
   * Use this to track agent creation and associate agents with worktrees.
   */
  "agent:spawned": WithContext<{
    agentId: string;
    terminalId: string;
    worktreeId?: string;
  }>;

  /**
   * Emitted when an agent's state changes (e.g., idle → working → completed).
   * Use this for status indicators and monitoring agent activity.
   *
   * The optional `temperature`/`heatAdded`/`changedChars` fields are populated
   * only for transitions that flow through `handleActivityState` — i.e. when
   * the activity detector's live temperature reading was the proximate cause
   * of the transition. They are absent for transitions sourced from
   * `transitionState` (the external observer path), which has no temperature.
   */
  "agent:state-changed": WithContext<{
    agentId?: string;
    state: AgentState;
    previousState: AgentState;
    trigger: AgentStateChangeTrigger;
    confidence: number;
    /** Terminal working directory (the worktree root in the typical case). */
    cwd?: string;
    waitingReason?: import("../../shared/types/agent.js").WaitingReason;
    sessionCost?: number;
    sessionTokens?: number;
    /** Process exit code on completed/exited transitions; null on a signal kill with no numeric code. */
    exitCode?: number | null;
    /** Raw OS signal number on completed/exited transitions, when applicable. */
    exitSignal?: number;
    /** Live activity-temperature reading at the moment the transition was committed. */
    temperature?: number;
    /** Heat impulse that drove the live temperature sample. */
    heatAdded?: number;
    /** Number of changed characters in the most recent sample. */
    changedChars?: number;
    /** Parsed test/lint/build result captured at this transition (#10682). Best-effort, not an authoritative exit code. */
    lastCheckResult?: import("../../shared/types/checkResult.js").TerminalCheckResult;
  }>;

  /**
   * Emitted when an agent state transition *attempt* is dropped before it can
   * land. Distinct from `agent:state-changed` — `state-changed` fires for
   * accepted transitions; this fires for rejected attempts. Diagnostics tier
   * only; the event inspector surfaces it.
   */
  "agent:state-transition-dropped": WithContext<{
    /** Terminal ID the drop applies to. */
    terminalId: string;
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
    /** Human-readable explanation. */
    reason?: string;
    /** Zod issue messages for `schema-invalid` drops. */
    validationErrors?: string[];
  }>;

  /**
   * Emitted when all concurrent agents finish and the workspace becomes fully quiet.
   * Requires ≥2 agents to have been concurrently active in the session.
   */
  "agent:all-clear": {
    timestamp: number;
  };

  /**
   * Emitted when an agent CLI (or a recognised plain process) is detected
   * running in a terminal. `defaultTitle` lets the renderer sync its default
   * title to the live chrome identity in lockstep with the store update.
   */
  "agent:detected": {
    terminalId: string;
    agentType?: string;
    processIconId?: string;
    processName: string;
    defaultTitle?: string;
    timestamp: number;
  };

  /**
   * Emitted when an agent CLI (or a live-detected process icon) exits from
   * a terminal. `exitKind: "subcommand"` means the shell PTY survived and
   * returned to a prompt. `exitKind: "terminal"` means the PTY itself exited
   * and this event is clearing live renderer identity before preservation.
   */
  "agent:exited": {
    terminalId: string;
    agentType?: string;
    defaultTitle?: string;
    timestamp: number;
    exitKind?: "subcommand" | "terminal";
  };

  /**
   * Emitted when an agent produces output.
   * Note: This is separate from terminal data and may be parsed/structured.
   * WARNING: The data field may contain sensitive information (API keys, secrets, etc.).
   * Consumers should sanitize or redact before logging/persisting.
   */
  "agent:output": WithContext<{
    agentId: string;
    data: string;
    terminalId?: string;
    worktreeId?: string;
  }>;

  /**
   * Emitted when an agent completes its work successfully.
   */
  "agent:completed": WithContext<{
    agentId: string;
    exitCode: number;
    duration: number;
    terminalId?: string;
    worktreeId?: string;
  }>;

  /**
   * Emitted when an agent is explicitly killed (by user action or system).
   */
  "agent:killed": WithContext<{
    agentId: string;
    reason?: string;
    terminalId?: string;
    worktreeId?: string;
  }>;

  /**
   * Emitted when an agent PTY exits with output matching a fallback-eligible
   * error class (connection failure or hard auth). The renderer consumes this
   * to walk the preset's `fallbacks` chain and respawn.
   */
  "agent:fallback-triggered": {
    terminalId: string;
    agentId: string;
    fromPresetId: string;
    originalPresetId?: string;
    reason: "connection" | "auth";
    exitCode: number;
    timestamp: number;
  };

  /**
   * Emitted when artifacts (code blocks or patches) are extracted from agent output.
   */
  "artifact:detected": WithContext<{
    agentId: string;
    terminalId: string;
    worktreeId?: string;
    artifacts: Array<{
      id: string;
      type: "code" | "patch" | "file" | "summary" | "other";
      language?: string;
      filename?: string;
      content: string;
      extractedAt: number;
    }>;
  }>;

  /**
   * Emitted after an action completes successfully from the renderer.
   * Tracks user actions, keybindings, menu actions, context menus, and agent-driven actions.
   */
  "action:dispatched": {
    actionId: string;
    args?: unknown;
    /**
     * Allowlist-filtered args derived from ActionDefinition.safeBreadcrumbArgs.
     * Safe to surface in Sentry breadcrumbs. Separate from `args`, which is
     * redacted but not allowlisted.
     */
    safeArgs?: Record<string, unknown>;
    source: "user" | "keybinding" | "menu" | "agent" | "context-menu";
    context: {
      projectId?: string;
      activeWorktreeId?: string;
      focusedTerminalId?: string;
    };
    timestamp: number;
    category: string;
    durationMs: number;
    danger: "safe" | "confirm" | "restricted";
    /** True when an agent explicitly confirmed a danger:"confirm" action. Absent for user-source and safe actions. */
    confirmed?: boolean;
    /**
     * Contributing plugin id when this action was registered by a plugin
     * (`ActionDefinition.pluginId`). Absent for built-in actions. Drives the
     * plugin-action audit log — the main-side `PluginActionAuditService`
     * appends a record only when this is present.
     */
    pluginId?: string;
    /**
     * SHA-256 hex digest of the (redacted) dispatch args, computed in the
     * renderer. Only set for plugin actions. Persisted in the audit record
     * so raw args need never cross IPC for fingerprinting.
     */
    argsHash?: string;
  };

  // Terminal Trash Events

  /**
   * Emitted when a terminal is moved to trash (pending deletion).
   */
  "terminal:trashed": {
    id: string;
    expiresAt: number;
  };

  /**
   * Emitted when a terminal is restored from trash.
   */
  "terminal:restored": {
    id: string;
  };

  /**
   * Emitted whenever a run's park record is created, replaced or removed —
   * by the user or by an automatic release. Attention projections
   * (`FleetSnapshotService`) subscribe to recompute; the payload deliberately
   * carries only the id so no consumer is tempted to bypass the service as the
   * single reader of park state.
   */
  "terminal:park-changed": {
    id: string;
    parked: boolean;
    timestamp: number;
  };

  /**
   * A rename reached the authoritative terminal record. The fleet projection
   * subscribes because the row's title changed; nothing else about the run
   * moved, so no other feed would report it and the 5s poll would otherwise
   * own the latency of a hand rename (#11830).
   */
  "terminal:title-changed": {
    id: string;
    timestamp: number;
  };

  /**
   * A cross-worktree move reached the authoritative terminal record. The fleet
   * projection subscribes because the row's worktree grouping changed; no agent
   * state moved, so no other feed reports it and the 5s poll would otherwise own
   * the latency of a drag the user just made (#12060).
   */
  "terminal:worktree-changed": {
    id: string;
    timestamp: number;
  };

  /**
   * Emitted whenever a run's snooze record is created, replaced or removed —
   * by the user, or automatically when they typed at the run. Both attention
   * projections subscribe: `ProjectStatsService` because a snooze changes the
   * project's counts, `FleetSnapshotService` because it changes the row.
   *
   * Expiry deliberately emits NOTHING. A lapsed snooze stops applying because
   * the next read resolves it against the clock, which is why the feature owns
   * no timers; an expiry event would need one to fire.
   */
  "terminal:snooze-changed": {
    id: string;
    snoozed: boolean;
    timestamp: number;
  };

  /**
   * Emitted when a park is lifted automatically rather than by hand: the gate
   * terminal finished its stint (busy → ready) or was closed. Carries the note
   * so the "this run is ready for you again" surface can say why the run was
   * waiting without a second read.
   */
  "terminal:park-released": {
    id: string;
    gateRunId: string;
    note?: string;
    reason: "gate-ready" | "gate-closed";
    timestamp: number;
  };

  /**
   * Emitted in the pty-host when a capture path finds a resumable session —
   * trash expiry, a natural agent exit, or a `/quit`-style demotion — and
   * re-emitted on the Main bus by PtyEventsBridge. Main persists the record
   * (single journal writer — the pty-host writing the file itself would race
   * Main's own close-path writes) and then emits `agent-session:recorded`.
   */
  "agent-session:captured": {
    /** Terminal whose close produced the record — keys ledger dedupe. */
    terminalId: string;
    /**
     * Launch generation of that terminal incarnation, when known. `null`
     * deliberately opts out of generation gating for a capture that is not a
     * terminal close (a demotion), where one generation can legitimately
     * produce several records.
     */
    launchGeneration?: number | null;
    record: Omit<
      import("../../shared/types/ipc/agentSessionHistory.js").AgentSessionRecord,
      "savedAt"
    >;
  };

  /**
   * Emitted after a close path journals a resumable agent session (trash
   * expiry via `agent-session:captured`, or the main-process kill /
   * gracefulKill handlers). Resume surfaces refetch on it so a session that
   * leaves the trash appears in the list right away.
   */
  "agent-session:recorded": {
    sessionId: string;
    worktreeId: string | null;
    projectId: string | null;
    timestamp: number;
  };

  /**
   * Emitted when a terminal's activity state changes (busy/idle).
   * For shell terminals, this uses process tree inspection for accuracy.
   * For agent terminals, this includes human-readable status headlines.
   */
  "terminal:activity": {
    terminalId: string;
    headline: string;
    status: "working" | "waiting" | "success" | "failure";
    type: "interactive" | "background" | "idle";
    confidence: number;
    timestamp: number;
    worktreeId?: string;
    lastCommand?: string;
  };

  /**
   * Emitted when a terminal's flow control status changes.
   * Indicates whether the terminal is paused due to backpressure.
   */
  "terminal:status": {
    id: string;
    status: TerminalFlowStatus;
    bufferUtilization?: number;
    pauseDuration?: number;
    reason?: string;
    /** Byte count discarded — only set when status is "data-loss". */
    droppedBytes?: number;
    timestamp: number;
  };

  /**
   * Emitted when a terminal is backgrounded during project switch.
   * The process stays alive but is hidden from the UI.
   */
  "terminal:backgrounded": {
    id: string;
    projectId: string;
    timestamp: number;
  };

  /**
   * Emitted when a terminal is foregrounded during project switch.
   * The terminal becomes visible again in the UI.
   */
  "terminal:foregrounded": {
    id: string;
    projectId: string;
    timestamp: number;
  };

  /**
   * Emitted when a terminal reliability metric is recorded.
   * Includes pause, suspend, and wake latency metrics.
   */
  "terminal:reliability-metric": TerminalReliabilityMetricPayload;

  /**
   * Emitted exactly once per `TerminalProcess` lifetime when the PTY
   * transitions out of `alive`. Subscribers handle forensics logging,
   * agent completion emission, and fallback classification — work that
   * previously lived inline inside the PTY exit handler.
   *
   * `code` is `null` only when `dispose()` is called without a prior
   * natural exit (e.g. LRU eviction). `recentOutput` is captured before
   * the headless buffer is torn down so subscribers can scan exit-time
   * output without racing teardown.
   */
  "terminal:exited": {
    terminalId: string;
    /**
     * Session-scoped token (the spawning timestamp) that distinguishes
     * different `TerminalProcess` instances which happen to share an `id`
     * — e.g. when `PtyManager.spawn(id)` kills the prior terminal and
     * respawns under the same id. Subscribers must filter on both
     * `terminalId` AND `spawnedAt` to avoid firing the new instance's
     * handlers on the old PTY's exit.
     */
    spawnedAt: number;
    code: number | null;
    signal?: number;
    reason: ExitReason;
    recentOutput: string;
    hadAgent: boolean;
    liveAgentAtExit?: string;
    launchAgentId?: string;
    agentPresetId?: string;
    originalAgentPresetId?: string;
    timestamp: number;
  };

  // Task Lifecycle Events (Future-proof for task management)
};

export const ALL_EVENT_TYPES: Array<keyof DaintreeEventMap> = [
  "sys:ready",
  "sys:refresh",
  "sys:quit",
  "sys:config:reload",
  "file:open",
  "file:copy-tree",
  "file:copy-path",
  "ui:notify",
  "ui:filter:set",
  "ui:filter:clear",
  "ui:modal:open",
  "ui:modal:close",
  "sys:worktree:switch",
  "sys:worktree:refresh",
  "sys:worktree:cycle",
  "sys:worktree:selectByName",
  "sys:worktree:update",
  "sys:worktree:remove",
  "watcher:change",
  "sys:pr:detected",
  "sys:pr:cleared",
  "sys:pr:detection-state",
  "sys:issue:detected",
  "sys:issue:not-found",
  "sys:wake",
  "agent:spawned",
  "agent:state-changed",
  "agent:state-transition-dropped",
  "agent:all-clear",
  "agent:detected",
  "agent:exited",
  "agent:output",
  "agent:completed",
  "agent:killed",
  "agent:fallback-triggered",
  "artifact:detected",
  "action:dispatched",
  "terminal:trashed",
  "terminal:restored",
  "terminal:park-changed",
  "terminal:park-released",
  "terminal:title-changed",
  "terminal:worktree-changed",
  "terminal:snooze-changed",
  "agent-session:captured",
  "agent-session:recorded",
  "terminal:activity",
  "terminal:status",
  "terminal:backgrounded",
  "terminal:foregrounded",
  "terminal:reliability-metric",
  "terminal:exited",
];

export class TypedEventBus {
  private bus = new EventEmitter();

  private debugEnabled = process.env.DAINTREE_DEBUG_EVENTS === "1";

  constructor() {
    this.bus.setMaxListeners(100);
  }

  on<K extends keyof DaintreeEventMap>(
    event: K,
    listener: DaintreeEventMap[K] extends void ? () => void : (payload: DaintreeEventMap[K]) => void
  ) {
    this.bus.on(event, listener as (...args: any[]) => void);
    return () => {
      this.bus.off(event, listener as (...args: any[]) => void);
    };
  }

  off<K extends keyof DaintreeEventMap>(
    event: K,
    listener: DaintreeEventMap[K] extends void ? () => void : (payload: DaintreeEventMap[K]) => void
  ) {
    this.bus.off(event, listener as (...args: any[]) => void);
  }

  emit<K extends keyof DaintreeEventMap>(
    event: K,
    ...args: DaintreeEventMap[K] extends void ? [] : [DaintreeEventMap[K]]
  ) {
    if (this.debugEnabled) {
      console.log("[events]", event, args[0]);
    }
    this.bus.emit(event, ...(args as any[]));
  }

  removeAllListeners() {
    this.bus.removeAllListeners();
  }
}

export const events = new TypedEventBus();
