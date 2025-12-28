import { EventEmitter } from "events";
import type {
  NotificationPayload,
  AgentState,
  TaskState,
  TerminalType,
  EventCategory,
} from "../types/index.js";
import type { EventContext } from "../../shared/types/events.js";
import type { WorktreeSnapshot as WorktreeState } from "../../shared/types/workspace-host.js";
import type { TerminalReliabilityMetricPayload } from "../../shared/types/pty-host.js";

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
export const EVENT_META: Record<keyof CanopyEventMap, EventMetadata> = {
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
  "sys:issue:detected": {
    category: "system",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Issue metadata detected for worktree branch",
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
  "agent:state-changed": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Agent state changed (idle, working, completed, etc.)",
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
  "agent:failed": {
    category: "agent",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Agent encountered error and stopped",
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

  // Task events
  "task:created": {
    category: "task",
    requiresContext: true,
    requiresTimestamp: true,
    description: "New task created",
  },
  "task:assigned": {
    category: "task",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Task assigned to agent",
  },
  "task:state-changed": {
    category: "task",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Task state changed",
  },
  "task:completed": {
    category: "task",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Task completed successfully",
  },
  "task:failed": {
    category: "task",
    requiresContext: true,
    requiresTimestamp: true,
    description: "Task failed",
  },
};

export function getEventCategory(eventType: keyof CanopyEventMap): EventCategory {
  return EVENT_META[eventType]?.category ?? "system";
}

export function getEventTypesForCategory(category: EventCategory): Array<keyof CanopyEventMap> {
  return (Object.keys(EVENT_META) as Array<keyof CanopyEventMap>).filter(
    (key) => EVENT_META[key].category === category
  );
}

export type WithBase<T> = T & BaseEventPayload;

/**
 * Use for events that require correlation context (worktreeId, agentId, etc.).
 * Note: Since BaseEventPayload now extends EventContext, this is equivalent to WithBase<T>.
 */
export type WithContext<T> = T & BaseEventPayload;

export type SystemEventType = Extract<keyof CanopyEventMap, `sys:${string}`>;
export type AgentEventType = Extract<keyof CanopyEventMap, `agent:${string}`>;
export type TaskEventType = Extract<keyof CanopyEventMap, `task:${string}`>;
export type FileEventType = Extract<keyof CanopyEventMap, `file:${string}`>;
export type UIEventType = Extract<keyof CanopyEventMap, `ui:${string}`>;

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
  | "activity";

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

export type CanopyEventMap = {
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
    prState: "open" | "merged" | "closed";
    prTitle?: string;
    issueNumber?: number;
    issueTitle?: string;
    timestamp: number;
  };
  "sys:pr:cleared": {
    worktreeId: string;
    timestamp: number;
  };

  "sys:issue:detected": {
    worktreeId: string;
    issueNumber: number;
    issueTitle: string;
    timestamp: number;
  };

  /**
   * Emitted when a new AI agent (Claude, Gemini, etc.) is spawned in a terminal.
   * Use this to track agent creation and associate agents with worktrees.
   */
  "agent:spawned": WithContext<{
    agentId: string;
    terminalId: string;
    type: TerminalType;
    worktreeId?: string;
  }>;

  /**
   * Emitted when an agent's state changes (e.g., idle → working → completed).
   * Use this for status indicators and monitoring agent activity.
   */
  "agent:state-changed": WithContext<{
    agentId: string;
    state: AgentState;
    previousState: AgentState;
    trigger: AgentStateChangeTrigger;
    confidence: number;
  }>;

  /**
   * Emitted when an agent CLI is detected running in a terminal.
   */
  "agent:detected": {
    terminalId: string;
    agentType: string;
    processName: string;
    timestamp: number;
  };

  /**
   * Emitted when an agent CLI exits from a terminal.
   */
  "agent:exited": {
    terminalId: string;
    agentType: string;
    timestamp: number;
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
   * Emitted when an agent encounters an error and cannot continue.
   */
  "agent:failed": WithContext<{
    agentId: string;
    error: string;
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
   * Emitted when an action is dispatched from the renderer.
   * Tracks user actions, keybindings, menu actions, context menus, and agent-driven actions.
   */
  "action:dispatched": {
    actionId: string;
    args?: unknown;
    source: "user" | "keybinding" | "menu" | "agent" | "context-menu";
    context: {
      projectId?: string;
      activeWorktreeId?: string;
      focusedTerminalId?: string;
    };
    timestamp: number;
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
    status: "running" | "paused-backpressure" | "paused-user" | "suspended";
    bufferUtilization?: number;
    pauseDuration?: number;
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

  // Task Lifecycle Events (Future-proof for task management)

  /**
   * Emitted when a new task is created.
   * Tasks are units of work that can be assigned to agents.
   * WARNING: The description field may contain sensitive information.
   * Consumers should sanitize before logging/persisting.
   */
  "task:created": WithContext<{
    taskId: string;
    description: string;
    worktreeId?: string;
  }>;

  /**
   * Emitted when a task is assigned to an agent.
   */
  "task:assigned": WithContext<{
    taskId: string;
    agentId: string;
  }>;

  /**
   * Emitted when a task's state changes.
   */
  "task:state-changed": WithContext<{
    taskId: string;
    state: TaskState;
    previousState?: TaskState;
  }>;

  /**
   * Emitted when a task is completed successfully.
   */
  "task:completed": WithContext<{
    taskId: string;
    agentId?: string;
    runId?: string;
    worktreeId?: string;
    result: string;
    artifacts?: string[];
  }>;

  /**
   * Emitted when a task fails.
   */
  "task:failed": WithContext<{
    taskId: string;
    agentId?: string;
    runId?: string;
    worktreeId?: string;
    error: string;
  }>;
};

export const ALL_EVENT_TYPES: Array<keyof CanopyEventMap> = [
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
  "sys:issue:detected",
  "agent:spawned",
  "agent:state-changed",
  "agent:detected",
  "agent:exited",
  "agent:output",
  "agent:completed",
  "agent:failed",
  "agent:killed",
  "artifact:detected",
  "action:dispatched",
  "terminal:trashed",
  "terminal:restored",
  "terminal:activity",
  "terminal:status",
  "terminal:backgrounded",
  "terminal:foregrounded",
  "terminal:reliability-metric",
  "task:created",
  "task:assigned",
  "task:state-changed",
  "task:completed",
  "task:failed",
];

export class TypedEventBus {
  private bus = new EventEmitter();

  private debugEnabled = process.env.CANOPY_DEBUG_EVENTS === "1";

  constructor() {
    this.bus.setMaxListeners(100);
  }

  on<K extends keyof CanopyEventMap>(
    event: K,
    listener: CanopyEventMap[K] extends void ? () => void : (payload: CanopyEventMap[K]) => void
  ) {
    this.bus.on(event, listener as (...args: any[]) => void);
    return () => {
      this.bus.off(event, listener as (...args: any[]) => void);
    };
  }

  off<K extends keyof CanopyEventMap>(
    event: K,
    listener: CanopyEventMap[K] extends void ? () => void : (payload: CanopyEventMap[K]) => void
  ) {
    this.bus.off(event, listener as (...args: any[]) => void);
  }

  emit<K extends keyof CanopyEventMap>(
    event: K,
    ...args: CanopyEventMap[K] extends void ? [] : [CanopyEventMap[K]]
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
