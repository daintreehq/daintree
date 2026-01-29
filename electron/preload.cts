/**
 * Built separately with NodeNext/ESM settings for Electron's preload.
 * Channel names are inlined to avoid module format conflicts with ESM main process.
 */

import { contextBridge, ipcRenderer } from "electron";
import { isTrustedRendererUrl } from "../shared/utils/trustedRenderer.js";

import type {
  WorktreeState,
  Project,
  ProjectSettings,
  TerminalSpawnOptions,
  CopyTreeOptions,
  CopyTreeProgress,
  AppState,
  LogEntry,
  LogFilterOptions,
  EventRecord,
  EventFilterOptions,
  RetryAction,
  AppError,
  ElectronAPI,
  CreateWorktreeOptions,
  IpcInvokeMap,
  IpcEventMap,
  AgentSettingsEntry,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  GitStatus,
  KeyAction,
  TerminalRecipe,
} from "../shared/types/index.js";
import type {
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  ArtifactDetectedPayload,
  SaveArtifactOptions,
  ApplyPatchOptions,
  DevPreviewStatusPayload,
  DevPreviewUrlPayload,
} from "../shared/types/ipc.js";
import type { TerminalActivityPayload } from "../shared/types/terminal.js";
import type { TerminalStatusPayload, SpawnResult } from "../shared/types/pty-host.js";

type SpawnResultPayload = SpawnResult;
import type {
  SidecarNewTabMenuAction,
  SidecarShowNewTabMenuPayload,
} from "../shared/types/sidecar.js";
import type { ShowContextMenuPayload } from "../shared/types/menu.js";

export type { ElectronAPI };

// Store MessagePort for direct Renderer ↔ Pty Host communication
// Note: We cannot return MessagePort via contextBridge (it's not cloneable/transferable via that API).
// Instead, we use window.postMessage to transfer it to the main world.

let cachedToken: string | null = null;

function isAllowedTerminalPortTarget(): boolean {
  return isTrustedRendererUrl(window.location.href);
}

ipcRenderer.on("terminal-port-token", (_event, payload: { token: string }) => {
  cachedToken = payload.token;

  if (window.top !== window) return;
  if (!isAllowedTerminalPortTarget()) return;

  window.postMessage({ type: "terminal-port-token", token: payload.token }, window.location.origin);
});

ipcRenderer.on("terminal-port", (event, payload: { token: string }) => {
  if (window.top !== window) {
    return;
  }

  if (!isAllowedTerminalPortTarget()) {
    console.error(
      "[Preload] Refusing to forward terminal MessagePort to untrusted origin:",
      window.location.href
    );
    return;
  }

  if (event.ports && event.ports.length > 0) {
    const port = event.ports[0];
    const token = payload?.token || cachedToken;

    if (!token) {
      console.error("[Preload] No handshake token available");
      return;
    }

    const targetOrigin = window.location.origin;
    window.postMessage({ type: "terminal-port", token }, targetOrigin, [port]);
    cachedToken = null;
    console.log("[Preload] MessagePort transferred to main world");
  }
});

function _typedInvoke<K extends Extract<keyof IpcInvokeMap, string>>(
  channel: K,
  ...args: IpcInvokeMap[K]["args"]
): Promise<IpcInvokeMap[K]["result"]> {
  return ipcRenderer.invoke(channel, ...args);
}

function _typedOn<K extends Extract<keyof IpcEventMap, string>>(
  channel: K,
  callback: (payload: IpcEventMap[K]) => void
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: IpcEventMap[K]) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Inlined to avoid runtime module resolution issues with CommonJS
const CHANNELS = {
  // Worktree channels
  WORKTREE_GET_ALL: "worktree:get-all",
  WORKTREE_REFRESH: "worktree:refresh",
  WORKTREE_SET_ACTIVE: "worktree:set-active",
  WORKTREE_UPDATE: "worktree:update",
  WORKTREE_REMOVE: "worktree:remove",
  WORKTREE_CREATE: "worktree:create",
  WORKTREE_LIST_BRANCHES: "worktree:list-branches",
  WORKTREE_PR_REFRESH: "worktree:pr-refresh",
  WORKTREE_PR_STATUS: "worktree:pr-status",
  WORKTREE_GET_DEFAULT_PATH: "worktree:get-default-path",
  WORKTREE_GET_AVAILABLE_BRANCH: "worktree:get-available-branch",
  WORKTREE_DELETE: "worktree:delete",

  // Terminal channels
  TERMINAL_SPAWN: "terminal:spawn",
  TERMINAL_SPAWN_RESULT: "terminal:spawn-result",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_INPUT: "terminal:input",
  TERMINAL_SUBMIT: "terminal:submit",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_EXIT: "terminal:exit",
  TERMINAL_ERROR: "terminal:error",
  TERMINAL_TRASH: "terminal:trash",
  TERMINAL_RESTORE: "terminal:restore",
  TERMINAL_TRASHED: "terminal:trashed",
  TERMINAL_RESTORED: "terminal:restored",
  TERMINAL_SET_ACTIVITY_TIER: "terminal:set-activity-tier",
  TERMINAL_WAKE: "terminal:wake",
  TERMINAL_GET_FOR_PROJECT: "terminal:get-for-project",
  TERMINAL_RECONNECT: "terminal:reconnect",
  TERMINAL_REPLAY_HISTORY: "terminal:replay-history",
  TERMINAL_GET_SERIALIZED_STATE: "terminal:get-serialized-state",
  TERMINAL_GET_SHARED_BUFFERS: "terminal:get-shared-buffers",
  TERMINAL_GET_ANALYSIS_BUFFER: "terminal:get-analysis-buffer",
  TERMINAL_GET_INFO: "terminal:get-info",
  TERMINAL_ACKNOWLEDGE_DATA: "terminal:acknowledge-data",
  TERMINAL_FORCE_RESUME: "terminal:force-resume",
  TERMINAL_STATUS: "terminal:status",
  TERMINAL_BACKEND_CRASHED: "terminal:backend-crashed",
  TERMINAL_BACKEND_READY: "terminal:backend-ready",
  TERMINAL_SEND_KEY: "terminal:send-key",

  // Files channels
  FILES_SEARCH: "files:search",

  // Agent state channels
  AGENT_STATE_CHANGED: "agent:state-changed",
  AGENT_DETECTED: "agent:detected",
  AGENT_EXITED: "agent:exited",

  // Terminal activity channels
  TERMINAL_ACTIVITY: "terminal:activity",

  // Artifact channels
  ARTIFACT_DETECTED: "artifact:detected",
  ARTIFACT_SAVE_TO_FILE: "artifact:save-to-file",
  ARTIFACT_APPLY_PATCH: "artifact:apply-patch",

  // CopyTree channels
  COPYTREE_GENERATE: "copytree:generate",
  COPYTREE_GENERATE_AND_COPY_FILE: "copytree:generate-and-copy-file",
  COPYTREE_INJECT: "copytree:inject",
  COPYTREE_AVAILABLE: "copytree:available",
  COPYTREE_PROGRESS: "copytree:progress",
  COPYTREE_CANCEL: "copytree:cancel",
  COPYTREE_GET_FILE_TREE: "copytree:get-file-tree",
  COPYTREE_TEST_CONFIG: "copytree:test-config",

  // System channels
  SYSTEM_OPEN_EXTERNAL: "system:open-external",
  SYSTEM_OPEN_PATH: "system:open-path",
  SYSTEM_CHECK_COMMAND: "system:check-command",
  SYSTEM_CHECK_DIRECTORY: "system:check-directory",
  SYSTEM_GET_HOME_DIR: "system:get-home-dir",
  SYSTEM_GET_CLI_AVAILABILITY: "system:get-cli-availability",
  SYSTEM_REFRESH_CLI_AVAILABILITY: "system:refresh-cli-availability",
  SYSTEM_GET_AGENT_VERSIONS: "system:get-agent-versions",
  SYSTEM_REFRESH_AGENT_VERSIONS: "system:refresh-agent-versions",
  SYSTEM_GET_AGENT_UPDATE_SETTINGS: "system:get-agent-update-settings",
  SYSTEM_SET_AGENT_UPDATE_SETTINGS: "system:set-agent-update-settings",
  SYSTEM_START_AGENT_UPDATE: "system:start-agent-update",
  SYSTEM_WAKE: "system:wake",

  // PR detection channels
  PR_DETECTED: "pr:detected",
  PR_CLEARED: "pr:cleared",
  ISSUE_DETECTED: "issue:detected",

  // GitHub channels
  GITHUB_GET_REPO_STATS: "github:get-repo-stats",
  GITHUB_OPEN_ISSUES: "github:open-issues",
  GITHUB_OPEN_PRS: "github:open-prs",
  GITHUB_OPEN_ISSUE: "github:open-issue",
  GITHUB_OPEN_PR: "github:open-pr",
  GITHUB_CHECK_CLI: "github:check-cli",
  GITHUB_GET_CONFIG: "github:get-config",
  GITHUB_SET_TOKEN: "github:set-token",
  GITHUB_CLEAR_TOKEN: "github:clear-token",
  GITHUB_VALIDATE_TOKEN: "github:validate-token",
  GITHUB_LIST_ISSUES: "github:list-issues",
  GITHUB_LIST_PRS: "github:list-prs",
  GITHUB_ASSIGN_ISSUE: "github:assign-issue",
  GITHUB_GET_ISSUE_TOOLTIP: "github:get-issue-tooltip",
  GITHUB_GET_PR_TOOLTIP: "github:get-pr-tooltip",
  GITHUB_GET_ISSUE_URL: "github:get-issue-url",

  // Notes channels
  NOTES_CREATE: "notes:create",
  NOTES_READ: "notes:read",
  NOTES_WRITE: "notes:write",
  NOTES_LIST: "notes:list",
  NOTES_DELETE: "notes:delete",
  NOTES_SEARCH: "notes:search",
  NOTES_UPDATED: "notes:updated",

  // Dev Preview channels
  DEV_PREVIEW_START: "dev-preview:start",
  DEV_PREVIEW_STOP: "dev-preview:stop",
  DEV_PREVIEW_RESTART: "dev-preview:restart",
  DEV_PREVIEW_SET_URL: "dev-preview:set-url",
  DEV_PREVIEW_STATUS: "dev-preview:status",
  DEV_PREVIEW_URL: "dev-preview:url",

  // App state channels
  APP_GET_STATE: "app:get-state",
  APP_SET_STATE: "app:set-state",
  APP_GET_VERSION: "app:get-version",
  APP_HYDRATE: "app:hydrate",
  APP_QUIT: "app:quit",
  APP_FORCE_QUIT: "app:force-quit",
  MENU_ACTION: "menu:action",
  MENU_SHOW_CONTEXT: "menu:show-context",

  // Logs channels
  LOGS_GET_ALL: "logs:get-all",
  LOGS_GET_SOURCES: "logs:get-sources",
  LOGS_CLEAR: "logs:clear",
  LOGS_ENTRY: "logs:entry",
  LOGS_BATCH: "logs:batch",
  LOGS_OPEN_FILE: "logs:open-file",
  LOGS_SET_VERBOSE: "logs:set-verbose",
  LOGS_GET_VERBOSE: "logs:get-verbose",
  LOGS_WRITE: "logs:write",

  // Error channels
  ERROR_NOTIFY: "error:notify",
  ERROR_RETRY: "error:retry",
  ERROR_OPEN_LOGS: "error:open-logs",

  // Event Inspector channels
  EVENT_INSPECTOR_GET_EVENTS: "event-inspector:get-events",
  EVENT_INSPECTOR_GET_FILTERED: "event-inspector:get-filtered",
  EVENT_INSPECTOR_CLEAR: "event-inspector:clear",
  EVENT_INSPECTOR_EVENT: "event-inspector:event",
  EVENT_INSPECTOR_SUBSCRIBE: "event-inspector:subscribe",
  EVENT_INSPECTOR_UNSUBSCRIBE: "event-inspector:unsubscribe",
  EVENTS_EMIT: "events:emit",

  // Project channels
  PROJECT_GET_ALL: "project:get-all",
  PROJECT_GET_CURRENT: "project:get-current",
  PROJECT_ADD: "project:add",
  PROJECT_REMOVE: "project:remove",
  PROJECT_UPDATE: "project:update",
  PROJECT_SWITCH: "project:switch",
  PROJECT_OPEN_DIALOG: "project:open-dialog",
  PROJECT_ON_SWITCH: "project:on-switch",
  PROJECT_GET_SETTINGS: "project:get-settings",
  PROJECT_SAVE_SETTINGS: "project:save-settings",
  PROJECT_DETECT_RUNNERS: "project:detect-runners",
  PROJECT_CLOSE: "project:close",
  PROJECT_REOPEN: "project:reopen",
  PROJECT_GET_STATS: "project:get-stats",
  PROJECT_INIT_GIT: "project:init-git",
  PROJECT_GET_RECIPES: "project:get-recipes",
  PROJECT_SAVE_RECIPES: "project:save-recipes",
  PROJECT_ADD_RECIPE: "project:add-recipe",
  PROJECT_UPDATE_RECIPE: "project:update-recipe",
  PROJECT_DELETE_RECIPE: "project:delete-recipe",
  PROJECT_GET_TERMINALS: "project:get-terminals",
  PROJECT_SET_TERMINALS: "project:set-terminals",
  PROJECT_GET_TAB_GROUPS: "project:get-tab-groups",
  PROJECT_SET_TAB_GROUPS: "project:set-tab-groups",
  PROJECT_GET_FOCUS_MODE: "project:get-focus-mode",
  PROJECT_SET_FOCUS_MODE: "project:set-focus-mode",

  // Agent settings channels
  AGENT_SETTINGS_GET: "agent-settings:get",
  AGENT_SETTINGS_SET: "agent-settings:set",
  AGENT_SETTINGS_RESET: "agent-settings:reset",

  AGENT_HELP_GET: "agent-help:get",

  // User agent registry channels
  USER_AGENT_REGISTRY_GET: "user-agent-registry:get",
  USER_AGENT_REGISTRY_ADD: "user-agent-registry:add",
  USER_AGENT_REGISTRY_UPDATE: "user-agent-registry:update",
  USER_AGENT_REGISTRY_REMOVE: "user-agent-registry:remove",

  // Terminal config channels
  TERMINAL_CONFIG_GET: "terminal-config:get",
  TERMINAL_CONFIG_SET_SCROLLBACK: "terminal-config:set-scrollback",
  TERMINAL_CONFIG_SET_PERFORMANCE_MODE: "terminal-config:set-performance-mode",
  TERMINAL_CONFIG_SET_FONT_SIZE: "terminal-config:set-font-size",
  TERMINAL_CONFIG_SET_FONT_FAMILY: "terminal-config:set-font-family",
  TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED: "terminal-config:set-hybrid-input-enabled",
  TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS: "terminal-config:set-hybrid-input-auto-focus",

  // Git channels
  GIT_GET_FILE_DIFF: "git:get-file-diff",
  GIT_GET_PROJECT_PULSE: "git:get-project-pulse",
  GIT_LIST_COMMITS: "git:list-commits",

  // Sidecar channels
  SIDECAR_CREATE: "sidecar:create",
  SIDECAR_SHOW: "sidecar:show",
  SIDECAR_HIDE: "sidecar:hide",
  SIDECAR_RESIZE: "sidecar:resize",
  SIDECAR_CLOSE_TAB: "sidecar:close-tab",
  SIDECAR_NAVIGATE: "sidecar:navigate",
  SIDECAR_GO_BACK: "sidecar:go-back",
  SIDECAR_GO_FORWARD: "sidecar:go-forward",
  SIDECAR_RELOAD: "sidecar:reload",
  SIDECAR_SHOW_NEW_TAB_MENU: "sidecar:show-new-tab-menu",
  SIDECAR_NAV_EVENT: "sidecar:nav-event",
  SIDECAR_FOCUS: "sidecar:focus",
  SIDECAR_BLUR: "sidecar:blur",
  SIDECAR_NEW_TAB_MENU_ACTION: "sidecar:new-tab-menu-action",

  // Hibernation channels
  HIBERNATION_GET_CONFIG: "hibernation:get-config",
  HIBERNATION_UPDATE_CONFIG: "hibernation:update-config",

  // System Sleep channels
  SYSTEM_SLEEP_GET_METRICS: "system-sleep:get-metrics",
  SYSTEM_SLEEP_GET_AWAKE_TIME: "system-sleep:get-awake-time",
  SYSTEM_SLEEP_RESET: "system-sleep:reset",
  SYSTEM_SLEEP_ON_WAKE: "system-sleep:on-wake",

  // Keybinding channels
  KEYBINDING_GET_OVERRIDES: "keybinding:get-overrides",
  KEYBINDING_SET_OVERRIDE: "keybinding:set-override",
  KEYBINDING_REMOVE_OVERRIDE: "keybinding:remove-override",
  KEYBINDING_RESET_ALL: "keybinding:reset-all",

  // Worktree Config channels
  WORKTREE_CONFIG_GET: "worktree-config:get",
  WORKTREE_CONFIG_SET_PATTERN: "worktree-config:set-pattern",

  // Window channels
  WINDOW_FULLSCREEN_CHANGE: "window:fullscreen-change",
  WINDOW_TOGGLE_FULLSCREEN: "window:toggle-fullscreen",
  WINDOW_RELOAD: "window:reload",
  WINDOW_FORCE_RELOAD: "window:force-reload",
  WINDOW_TOGGLE_DEVTOOLS: "window:toggle-devtools",
  WINDOW_ZOOM_IN: "window:zoom-in",
  WINDOW_ZOOM_OUT: "window:zoom-out",
  WINDOW_ZOOM_RESET: "window:zoom-reset",
  WINDOW_CLOSE: "window:close",

  // Notification channels
  NOTIFICATION_UPDATE: "notification:update",

  // Slash command channels
  SLASH_COMMANDS_LIST: "slash-commands:list",

  // Gemini channels
  GEMINI_GET_STATUS: "gemini:get-status",
  GEMINI_ENABLE_ALTERNATE_BUFFER: "gemini:enable-alternate-buffer",

  // Commands channels
  COMMANDS_LIST: "commands:list",
  COMMANDS_GET: "commands:get",
  COMMANDS_EXECUTE: "commands:execute",
  COMMANDS_GET_BUILDER: "commands:get-builder",

  // App Agent channels
  APP_AGENT_RUN_ONE_SHOT: "app-agent:run-one-shot",
  APP_AGENT_GET_CONFIG: "app-agent:get-config",
  APP_AGENT_SET_CONFIG: "app-agent:set-config",
  APP_AGENT_HAS_API_KEY: "app-agent:has-api-key",
  APP_AGENT_TEST_API_KEY: "app-agent:test-api-key",
  APP_AGENT_TEST_MODEL: "app-agent:test-model",
  APP_AGENT_CANCEL: "app-agent:cancel",
  APP_AGENT_DISPATCH_ACTION: "app-agent:dispatch-action",

  // Assistant channels
  ASSISTANT_SEND_MESSAGE: "assistant:send-message",
  ASSISTANT_CANCEL: "assistant:cancel",
  ASSISTANT_CHUNK: "assistant:chunk",
  ASSISTANT_HAS_API_KEY: "assistant:has-api-key",
} as const;

const api: ElectronAPI = {
  // Worktree API
  worktree: {
    getAll: () => _typedInvoke(CHANNELS.WORKTREE_GET_ALL),

    refresh: () => _typedInvoke(CHANNELS.WORKTREE_REFRESH),

    refreshPullRequests: () => _typedInvoke(CHANNELS.WORKTREE_PR_REFRESH),

    getPRStatus: () => _typedInvoke(CHANNELS.WORKTREE_PR_STATUS),

    setActive: (worktreeId: string) => _typedInvoke(CHANNELS.WORKTREE_SET_ACTIVE, { worktreeId }),

    create: (options: CreateWorktreeOptions, rootPath: string): Promise<string> =>
      _typedInvoke(CHANNELS.WORKTREE_CREATE, { rootPath, options }),

    listBranches: (rootPath: string) => _typedInvoke(CHANNELS.WORKTREE_LIST_BRANCHES, { rootPath }),

    getDefaultPath: (rootPath: string, branchName: string): Promise<string> =>
      _typedInvoke(CHANNELS.WORKTREE_GET_DEFAULT_PATH, { rootPath, branchName }),

    getAvailableBranch: (rootPath: string, branchName: string): Promise<string> =>
      _typedInvoke(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH, { rootPath, branchName }),

    delete: (worktreeId: string, force?: boolean, deleteBranch?: boolean) =>
      _typedInvoke(CHANNELS.WORKTREE_DELETE, { worktreeId, force, deleteBranch }),

    onUpdate: (callback: (state: WorktreeState) => void) =>
      _typedOn(CHANNELS.WORKTREE_UPDATE, callback),

    onRemove: (callback: (data: { worktreeId: string }) => void) =>
      _typedOn(CHANNELS.WORKTREE_REMOVE, callback),
  },

  // Terminal API
  terminal: {
    spawn: (options: TerminalSpawnOptions) => _typedInvoke(CHANNELS.TERMINAL_SPAWN, options),

    write: (id: string, data: string) => ipcRenderer.send(CHANNELS.TERMINAL_INPUT, id, data),

    submit: (id: string, text: string) => _typedInvoke(CHANNELS.TERMINAL_SUBMIT, id, text),

    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send(CHANNELS.TERMINAL_RESIZE, { id, cols, rows }),

    kill: (id: string) => _typedInvoke(CHANNELS.TERMINAL_KILL, id),

    // Tuple payload [id, data] requires per-terminal filtering
    // Accepts both string and Uint8Array/Buffer (binary optimization for reduced GC pressure)
    onData: (id: string, callback: (data: string | Uint8Array) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, terminalId: unknown, data: unknown) => {
        if (typeof terminalId !== "string" || terminalId !== id) {
          return;
        }
        // Accept string, Uint8Array, or Buffer (Node.js extends Uint8Array)
        if (typeof data === "string" || data instanceof Uint8Array || Buffer.isBuffer(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(CHANNELS.TERMINAL_DATA, handler);
      return () => ipcRenderer.removeListener(CHANNELS.TERMINAL_DATA, handler);
    },

    // Tuple payload [id, exitCode] requires special handling
    onExit: (callback: (id: string, exitCode: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: unknown, exitCode: unknown) => {
        if (typeof id === "string" && typeof exitCode === "number") {
          callback(id, exitCode);
        }
      };
      ipcRenderer.on(CHANNELS.TERMINAL_EXIT, handler);
      return () => ipcRenderer.removeListener(CHANNELS.TERMINAL_EXIT, handler);
    },

    onAgentStateChanged: (callback: (data: AgentStateChangePayload) => void) =>
      _typedOn(CHANNELS.AGENT_STATE_CHANGED, callback),

    onAgentDetected: (callback: (data: AgentDetectedPayload) => void) =>
      _typedOn(CHANNELS.AGENT_DETECTED, callback),

    onAgentExited: (callback: (data: AgentExitedPayload) => void) =>
      _typedOn(CHANNELS.AGENT_EXITED, callback),

    onActivity: (callback: (data: TerminalActivityPayload) => void) =>
      _typedOn(CHANNELS.TERMINAL_ACTIVITY, callback),

    trash: (id: string) => _typedInvoke(CHANNELS.TERMINAL_TRASH, id),

    restore: (id: string) => _typedInvoke(CHANNELS.TERMINAL_RESTORE, id),

    onTrashed: (callback: (data: { id: string; expiresAt: number }) => void) =>
      _typedOn(CHANNELS.TERMINAL_TRASHED, callback),

    onRestored: (callback: (data: { id: string }) => void) =>
      _typedOn(CHANNELS.TERMINAL_RESTORED, callback),

    setActivityTier: (id: string, tier: "active" | "background") =>
      ipcRenderer.send(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, { id, tier }),

    wake: (id: string): Promise<{ state: string | null; warnings?: string[] }> =>
      _typedInvoke(CHANNELS.TERMINAL_WAKE, id),

    acknowledgeData: (id: string, length: number) =>
      ipcRenderer.send(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, { id, length }),

    getForProject: (projectId: string) =>
      ipcRenderer.invoke(CHANNELS.TERMINAL_GET_FOR_PROJECT, projectId),

    reconnect: (terminalId: string) => ipcRenderer.invoke(CHANNELS.TERMINAL_RECONNECT, terminalId),

    replayHistory: (terminalId: string, maxLines?: number) =>
      ipcRenderer.invoke(CHANNELS.TERMINAL_REPLAY_HISTORY, { terminalId, maxLines }),

    getSerializedState: (terminalId: string) =>
      _typedInvoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, terminalId),

    getInfo: (id: string) => _typedInvoke(CHANNELS.TERMINAL_GET_INFO, id),

    getSharedBuffers: (): Promise<{
      visualBuffers: SharedArrayBuffer[];
      signalBuffer: SharedArrayBuffer | null;
    }> => ipcRenderer.invoke(CHANNELS.TERMINAL_GET_SHARED_BUFFERS),

    getAnalysisBuffer: (): Promise<SharedArrayBuffer | null> =>
      ipcRenderer.invoke(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER),

    forceResume: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.TERMINAL_FORCE_RESUME, id),

    onStatus: (callback: (data: TerminalStatusPayload) => void) =>
      _typedOn(CHANNELS.TERMINAL_STATUS, callback),

    onBackendCrashed: (
      callback: (data: {
        crashType: string;
        code: number | null;
        signal: string | null;
        timestamp: number;
      }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { crashType: string; code: number | null; signal: string | null; timestamp: number }
      ) => callback(data);
      ipcRenderer.on(CHANNELS.TERMINAL_BACKEND_CRASHED, handler);
      return () => ipcRenderer.removeListener(CHANNELS.TERMINAL_BACKEND_CRASHED, handler);
    },

    onBackendReady: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on(CHANNELS.TERMINAL_BACKEND_READY, handler);
      return () => ipcRenderer.removeListener(CHANNELS.TERMINAL_BACKEND_READY, handler);
    },

    sendKey: (id: string, key: string) => ipcRenderer.send(CHANNELS.TERMINAL_SEND_KEY, id, key),

    onSpawnResult: (callback: (id: string, result: SpawnResultPayload) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: unknown, result: unknown) => {
        if (typeof id === "string" && typeof result === "object" && result !== null) {
          callback(id, result as SpawnResultPayload);
        }
      };
      ipcRenderer.on(CHANNELS.TERMINAL_SPAWN_RESULT, handler);
      return () => ipcRenderer.removeListener(CHANNELS.TERMINAL_SPAWN_RESULT, handler);
    },
  },

  // Files API
  files: {
    search: (payload) => _typedInvoke(CHANNELS.FILES_SEARCH, payload),
  },

  // Slash Commands API
  slashCommands: {
    list: (payload) => _typedInvoke(CHANNELS.SLASH_COMMANDS_LIST, payload),
  },

  // Artifact API
  artifact: {
    onDetected: (callback: (data: ArtifactDetectedPayload) => void) =>
      _typedOn(CHANNELS.ARTIFACT_DETECTED, callback),

    saveToFile: (options: SaveArtifactOptions) =>
      _typedInvoke(CHANNELS.ARTIFACT_SAVE_TO_FILE, options),

    applyPatch: (options: ApplyPatchOptions) =>
      _typedInvoke(CHANNELS.ARTIFACT_APPLY_PATCH, options),
  },

  // CopyTree API
  copyTree: {
    generate: (worktreeId: string, options?: CopyTreeOptions) =>
      _typedInvoke(CHANNELS.COPYTREE_GENERATE, { worktreeId, options }),

    generateAndCopyFile: (worktreeId: string, options?: CopyTreeOptions) =>
      _typedInvoke(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, { worktreeId, options }),

    injectToTerminal: (
      terminalId: string,
      worktreeId: string,
      options?: CopyTreeOptions,
      injectionId?: string
    ) => _typedInvoke(CHANNELS.COPYTREE_INJECT, { terminalId, worktreeId, options, injectionId }),

    isAvailable: () => _typedInvoke(CHANNELS.COPYTREE_AVAILABLE),

    cancel: (injectionId?: string) => _typedInvoke(CHANNELS.COPYTREE_CANCEL, { injectionId }),

    getFileTree: (worktreeId: string, dirPath?: string) =>
      _typedInvoke(CHANNELS.COPYTREE_GET_FILE_TREE, { worktreeId, dirPath }),

    testConfig: (worktreeId: string, options?: CopyTreeOptions) =>
      _typedInvoke(CHANNELS.COPYTREE_TEST_CONFIG, { worktreeId, options }),

    onProgress: (callback: (progress: CopyTreeProgress) => void) =>
      _typedOn(CHANNELS.COPYTREE_PROGRESS, callback),
  },

  // System API
  system: {
    openExternal: (url: string) => _typedInvoke(CHANNELS.SYSTEM_OPEN_EXTERNAL, { url }),

    openPath: (path: string) => _typedInvoke(CHANNELS.SYSTEM_OPEN_PATH, { path }),

    checkCommand: (command: string) => _typedInvoke(CHANNELS.SYSTEM_CHECK_COMMAND, command),

    checkDirectory: (path: string) => _typedInvoke(CHANNELS.SYSTEM_CHECK_DIRECTORY, path),

    getHomeDir: () => _typedInvoke(CHANNELS.SYSTEM_GET_HOME_DIR),

    getCliAvailability: () => _typedInvoke(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY),

    refreshCliAvailability: () => _typedInvoke(CHANNELS.SYSTEM_REFRESH_CLI_AVAILABILITY),

    getAgentVersions: () => _typedInvoke(CHANNELS.SYSTEM_GET_AGENT_VERSIONS),

    refreshAgentVersions: () => _typedInvoke(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS),

    getAgentUpdateSettings: () => _typedInvoke(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS),

    setAgentUpdateSettings: (settings: {
      autoCheck: boolean;
      checkFrequencyHours: number;
      lastAutoCheck: number | null;
    }) => _typedInvoke(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS, settings),

    startAgentUpdate: (payload: { agentId: string; method?: string }) =>
      _typedInvoke(CHANNELS.SYSTEM_START_AGENT_UPDATE, payload),

    onWake: (callback: (data: { sleepDuration: number; timestamp: number }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sleepDuration: number; timestamp: number }
      ) => callback(data);
      ipcRenderer.on(CHANNELS.SYSTEM_WAKE, handler);
      return () => ipcRenderer.removeListener(CHANNELS.SYSTEM_WAKE, handler);
    },
  },

  // App State API
  app: {
    getState: () => _typedInvoke(CHANNELS.APP_GET_STATE),

    setState: (partialState: Partial<AppState>) =>
      _typedInvoke(CHANNELS.APP_SET_STATE, partialState),

    getVersion: () => _typedInvoke(CHANNELS.APP_GET_VERSION),

    hydrate: () => _typedInvoke(CHANNELS.APP_HYDRATE),

    quit: () => _typedInvoke(CHANNELS.APP_QUIT),

    forceQuit: () => _typedInvoke(CHANNELS.APP_FORCE_QUIT),

    onMenuAction: (callback: (action: string) => void) => _typedOn(CHANNELS.MENU_ACTION, callback),
  },

  menu: {
    showContext: (payload: ShowContextMenuPayload) =>
      _typedInvoke(CHANNELS.MENU_SHOW_CONTEXT, payload),
  },

  // Logs API
  logs: {
    getAll: (filters?: LogFilterOptions) => _typedInvoke(CHANNELS.LOGS_GET_ALL, filters),

    getSources: () => _typedInvoke(CHANNELS.LOGS_GET_SOURCES),

    clear: () => _typedInvoke(CHANNELS.LOGS_CLEAR),

    openFile: () => _typedInvoke(CHANNELS.LOGS_OPEN_FILE),

    setVerbose: (enabled: boolean) => _typedInvoke(CHANNELS.LOGS_SET_VERBOSE, enabled),

    getVerbose: () => _typedInvoke(CHANNELS.LOGS_GET_VERBOSE),

    onEntry: (callback: (entry: LogEntry) => void) => {
      const offEntry = _typedOn(CHANNELS.LOGS_ENTRY, callback);
      const offBatch = _typedOn(CHANNELS.LOGS_BATCH, (entries) => {
        for (const entry of entries) callback(entry);
      });
      return () => {
        offEntry();
        offBatch();
      };
    },

    onBatch: (callback: (entries: LogEntry[]) => void) => _typedOn(CHANNELS.LOGS_BATCH, callback),

    write: (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      context?: Record<string, unknown>
    ) => _typedInvoke(CHANNELS.LOGS_WRITE, { level, message, context }),
  },

  // Error API
  errors: {
    onError: (callback: (error: AppError) => void) => _typedOn(CHANNELS.ERROR_NOTIFY, callback),

    retry: (errorId: string, action: RetryAction, args?: Record<string, unknown>) =>
      _typedInvoke(CHANNELS.ERROR_RETRY, { errorId, action, args }),

    openLogs: () => _typedInvoke(CHANNELS.ERROR_OPEN_LOGS),
  },

  // Event Inspector API
  eventInspector: {
    getEvents: () => _typedInvoke(CHANNELS.EVENT_INSPECTOR_GET_EVENTS),

    getFiltered: (filters: EventFilterOptions) =>
      _typedInvoke(CHANNELS.EVENT_INSPECTOR_GET_FILTERED, filters),

    clear: () => _typedInvoke(CHANNELS.EVENT_INSPECTOR_CLEAR),

    subscribe: () => ipcRenderer.send(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE),

    unsubscribe: () => ipcRenderer.send(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE),

    onEvent: (callback: (event: EventRecord) => void) =>
      _typedOn(CHANNELS.EVENT_INSPECTOR_EVENT, callback),
  },

  events: {
    emit: (eventType: string, payload: unknown) =>
      _typedInvoke(CHANNELS.EVENTS_EMIT, eventType, payload),
  },

  // Project API
  project: {
    getAll: () => _typedInvoke(CHANNELS.PROJECT_GET_ALL),

    getCurrent: () => _typedInvoke(CHANNELS.PROJECT_GET_CURRENT),

    add: (path: string) => _typedInvoke(CHANNELS.PROJECT_ADD, path),

    remove: (projectId: string) => _typedInvoke(CHANNELS.PROJECT_REMOVE, projectId),

    update: (projectId: string, updates: Partial<Project>) =>
      _typedInvoke(CHANNELS.PROJECT_UPDATE, projectId, updates),

    switch: (projectId: string) => _typedInvoke(CHANNELS.PROJECT_SWITCH, projectId),

    openDialog: () => _typedInvoke(CHANNELS.PROJECT_OPEN_DIALOG),

    onSwitch: (callback: (payload: { project: Project; switchId: string }) => void) =>
      _typedOn(CHANNELS.PROJECT_ON_SWITCH, callback),

    getSettings: (projectId: string) => _typedInvoke(CHANNELS.PROJECT_GET_SETTINGS, projectId),

    saveSettings: (projectId: string, settings: ProjectSettings) =>
      _typedInvoke(CHANNELS.PROJECT_SAVE_SETTINGS, { projectId, settings }),

    detectRunners: (projectId: string) => _typedInvoke(CHANNELS.PROJECT_DETECT_RUNNERS, projectId),

    close: (projectId: string, options?: { killTerminals?: boolean }) =>
      ipcRenderer.invoke(CHANNELS.PROJECT_CLOSE, projectId, options),

    reopen: (projectId: string) => ipcRenderer.invoke(CHANNELS.PROJECT_REOPEN, projectId),

    getStats: (projectId: string) => ipcRenderer.invoke(CHANNELS.PROJECT_GET_STATS, projectId),

    initGit: (directoryPath: string) =>
      ipcRenderer.invoke(CHANNELS.PROJECT_INIT_GIT, directoryPath),

    getRecipes: (projectId: string): Promise<TerminalRecipe[]> =>
      _typedInvoke(CHANNELS.PROJECT_GET_RECIPES, projectId),

    saveRecipes: (projectId: string, recipes: TerminalRecipe[]): Promise<void> =>
      _typedInvoke(CHANNELS.PROJECT_SAVE_RECIPES, { projectId, recipes }),

    addRecipe: (projectId: string, recipe: TerminalRecipe): Promise<void> =>
      _typedInvoke(CHANNELS.PROJECT_ADD_RECIPE, { projectId, recipe }),

    updateRecipe: (
      projectId: string,
      recipeId: string,
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
    ): Promise<void> =>
      _typedInvoke(CHANNELS.PROJECT_UPDATE_RECIPE, { projectId, recipeId, updates }),

    deleteRecipe: (projectId: string, recipeId: string): Promise<void> =>
      _typedInvoke(CHANNELS.PROJECT_DELETE_RECIPE, { projectId, recipeId }),

    getTerminals: (
      projectId: string
    ): Promise<import("../shared/types/index.js").TerminalSnapshot[]> =>
      _typedInvoke(CHANNELS.PROJECT_GET_TERMINALS, projectId),

    setTerminals: (
      projectId: string,
      terminals: import("../shared/types/index.js").TerminalSnapshot[]
    ): Promise<void> => _typedInvoke(CHANNELS.PROJECT_SET_TERMINALS, { projectId, terminals }),

    getTabGroups: (projectId: string): Promise<import("../shared/types/index.js").TabGroup[]> =>
      _typedInvoke(CHANNELS.PROJECT_GET_TAB_GROUPS, projectId),

    setTabGroups: (
      projectId: string,
      tabGroups: import("../shared/types/index.js").TabGroup[]
    ): Promise<void> => _typedInvoke(CHANNELS.PROJECT_SET_TAB_GROUPS, { projectId, tabGroups }),

    getFocusMode: (
      projectId: string
    ): Promise<{
      focusMode: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    }> => _typedInvoke(CHANNELS.PROJECT_GET_FOCUS_MODE, projectId),

    setFocusMode: (
      projectId: string,
      focusMode: boolean,
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean }
    ): Promise<void> =>
      _typedInvoke(CHANNELS.PROJECT_SET_FOCUS_MODE, { projectId, focusMode, focusPanelState }),
  },

  // Agent Settings API
  agentSettings: {
    get: () => _typedInvoke(CHANNELS.AGENT_SETTINGS_GET),

    set: (agentId: string, settings: Partial<AgentSettingsEntry>) =>
      _typedInvoke(CHANNELS.AGENT_SETTINGS_SET, { agentType: agentId, settings }),

    reset: (agentType?: string) => _typedInvoke(CHANNELS.AGENT_SETTINGS_RESET, agentType),
  },

  userAgentRegistry: {
    get: () => _typedInvoke(CHANNELS.USER_AGENT_REGISTRY_GET),

    add: (config: import("../shared/types/index.js").UserAgentConfig) =>
      _typedInvoke(CHANNELS.USER_AGENT_REGISTRY_ADD, config),

    update: (id: string, config: import("../shared/types/index.js").UserAgentConfig) =>
      _typedInvoke(CHANNELS.USER_AGENT_REGISTRY_UPDATE, { id, config }),

    remove: (id: string) => _typedInvoke(CHANNELS.USER_AGENT_REGISTRY_REMOVE, id),
  },

  agentHelp: {
    get: (request: import("../shared/types/ipc/agent.js").AgentHelpRequest) =>
      _typedInvoke(CHANNELS.AGENT_HELP_GET, request),
  },

  // GitHub API
  github: {
    getRepoStats: (cwd: string, bypassCache?: boolean) =>
      _typedInvoke(CHANNELS.GITHUB_GET_REPO_STATS, cwd, bypassCache),

    openIssues: (cwd: string) => _typedInvoke(CHANNELS.GITHUB_OPEN_ISSUES, cwd),

    openPRs: (cwd: string) => _typedInvoke(CHANNELS.GITHUB_OPEN_PRS, cwd),

    openIssue: (cwd: string, issueNumber: number) =>
      _typedInvoke(CHANNELS.GITHUB_OPEN_ISSUE, { cwd, issueNumber }),

    openPR: (prUrl: string) => _typedInvoke(CHANNELS.GITHUB_OPEN_PR, prUrl),

    checkCli: () => _typedInvoke(CHANNELS.GITHUB_CHECK_CLI),

    getConfig: () => _typedInvoke(CHANNELS.GITHUB_GET_CONFIG),

    setToken: (token: string) => _typedInvoke(CHANNELS.GITHUB_SET_TOKEN, token),

    clearToken: () => _typedInvoke(CHANNELS.GITHUB_CLEAR_TOKEN),

    validateToken: (token: string) => _typedInvoke(CHANNELS.GITHUB_VALIDATE_TOKEN, token),

    listIssues: (options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "all";
      cursor?: string;
    }) => ipcRenderer.invoke(CHANNELS.GITHUB_LIST_ISSUES, options),

    listPullRequests: (options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "merged" | "all";
      cursor?: string;
    }) => ipcRenderer.invoke(CHANNELS.GITHUB_LIST_PRS, options),

    assignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.GITHUB_ASSIGN_ISSUE, { cwd, issueNumber, username }),

    getIssueTooltip: (cwd: string, issueNumber: number) =>
      ipcRenderer.invoke(CHANNELS.GITHUB_GET_ISSUE_TOOLTIP, { cwd, issueNumber }),

    getPRTooltip: (cwd: string, prNumber: number) =>
      ipcRenderer.invoke(CHANNELS.GITHUB_GET_PR_TOOLTIP, { cwd, prNumber }),

    getIssueUrl: (cwd: string, issueNumber: number): Promise<string | null> =>
      _typedInvoke(CHANNELS.GITHUB_GET_ISSUE_URL, { cwd, issueNumber }),

    onPRDetected: (callback: (data: PRDetectedPayload) => void) =>
      _typedOn(CHANNELS.PR_DETECTED, callback),

    onPRCleared: (callback: (data: PRClearedPayload) => void) =>
      _typedOn(CHANNELS.PR_CLEARED, callback),

    onIssueDetected: (callback: (data: IssueDetectedPayload) => void) =>
      _typedOn(CHANNELS.ISSUE_DETECTED, callback),
  },

  // Notes API
  notes: {
    create: (title: string, scope: "worktree" | "project", worktreeId?: string) =>
      _typedInvoke(CHANNELS.NOTES_CREATE, title, scope, worktreeId),

    read: (notePath: string) => _typedInvoke(CHANNELS.NOTES_READ, notePath),

    write: (
      notePath: string,
      content: string,
      metadata: {
        id: string;
        title: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
      },
      expectedLastModified?: number
    ) => _typedInvoke(CHANNELS.NOTES_WRITE, notePath, content, metadata, expectedLastModified),

    list: () => _typedInvoke(CHANNELS.NOTES_LIST),

    delete: (notePath: string) => _typedInvoke(CHANNELS.NOTES_DELETE, notePath),

    search: (query: string) => _typedInvoke(CHANNELS.NOTES_SEARCH, query),

    onUpdated: (
      callback: (data: {
        notePath: string;
        title: string;
        action: "created" | "updated" | "deleted";
      }) => void
    ) => _typedOn(CHANNELS.NOTES_UPDATED, callback),
  },

  // Dev Preview API
  devPreview: {
    start: (panelId: string, cwd: string, cols: number, rows: number, devCommand?: string) =>
      _typedInvoke(CHANNELS.DEV_PREVIEW_START, panelId, cwd, cols, rows, devCommand),

    stop: (panelId: string) => _typedInvoke(CHANNELS.DEV_PREVIEW_STOP, panelId),

    restart: (panelId: string) => _typedInvoke(CHANNELS.DEV_PREVIEW_RESTART, panelId),

    setUrl: (panelId: string, url: string) =>
      _typedInvoke(CHANNELS.DEV_PREVIEW_SET_URL, panelId, url),

    onStatus: (callback: (payload: DevPreviewStatusPayload) => void) =>
      _typedOn(CHANNELS.DEV_PREVIEW_STATUS, callback),

    onUrl: (callback: (payload: DevPreviewUrlPayload) => void) =>
      _typedOn(CHANNELS.DEV_PREVIEW_URL, callback),
  },

  // Git API
  git: {
    getFileDiff: (cwd: string, filePath: string, status: GitStatus) =>
      _typedInvoke(CHANNELS.GIT_GET_FILE_DIFF, { cwd, filePath, status }),

    getProjectPulse: (options: {
      worktreeId: string;
      rangeDays: 60 | 120 | 180;
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    }) => ipcRenderer.invoke(CHANNELS.GIT_GET_PROJECT_PULSE, options),

    listCommits: (options: {
      cwd: string;
      search?: string;
      branch?: string;
      skip?: number;
      limit?: number;
    }) => ipcRenderer.invoke(CHANNELS.GIT_LIST_COMMITS, options),
  },

  // Terminal Config API
  terminalConfig: {
    get: () => _typedInvoke(CHANNELS.TERMINAL_CONFIG_GET),

    setScrollback: (scrollbackLines: number) =>
      _typedInvoke(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK, scrollbackLines),

    setPerformanceMode: (performanceMode: boolean) =>
      _typedInvoke(CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE, performanceMode),

    setFontSize: (fontSize: number) =>
      _typedInvoke(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE, fontSize),

    setFontFamily: (fontFamily: string) =>
      _typedInvoke(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY, fontFamily),

    setHybridInputEnabled: (enabled: boolean) =>
      _typedInvoke(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED, enabled),

    setHybridInputAutoFocus: (enabled: boolean) =>
      _typedInvoke(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS, enabled),
  },

  // Sidecar API
  sidecar: {
    create: (payload: { tabId: string; url: string }) =>
      ipcRenderer.invoke(CHANNELS.SIDECAR_CREATE, payload),

    show: (payload: {
      tabId: string;
      bounds: { x: number; y: number; width: number; height: number };
    }) => ipcRenderer.invoke(CHANNELS.SIDECAR_SHOW, payload),

    hide: () => ipcRenderer.invoke(CHANNELS.SIDECAR_HIDE),

    resize: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(CHANNELS.SIDECAR_RESIZE, bounds),

    closeTab: (payload: { tabId: string }) =>
      ipcRenderer.invoke(CHANNELS.SIDECAR_CLOSE_TAB, payload),

    navigate: (payload: { tabId: string; url: string }) =>
      ipcRenderer.invoke(CHANNELS.SIDECAR_NAVIGATE, payload),

    goBack: (tabId: string) => ipcRenderer.invoke(CHANNELS.SIDECAR_GO_BACK, tabId),

    goForward: (tabId: string) => ipcRenderer.invoke(CHANNELS.SIDECAR_GO_FORWARD, tabId),

    reload: (tabId: string) => ipcRenderer.invoke(CHANNELS.SIDECAR_RELOAD, tabId),

    showNewTabMenu: (payload: SidecarShowNewTabMenuPayload) =>
      _typedInvoke(CHANNELS.SIDECAR_SHOW_NEW_TAB_MENU, payload),

    onNavEvent: (callback: (data: { tabId: string; title: string; url: string }) => void) =>
      _typedOn(CHANNELS.SIDECAR_NAV_EVENT, callback),

    onFocus: (callback: () => void) => _typedOn(CHANNELS.SIDECAR_FOCUS, callback),

    onBlur: (callback: () => void) => _typedOn(CHANNELS.SIDECAR_BLUR, callback),

    onNewTabMenuAction: (callback: (action: SidecarNewTabMenuAction) => void) =>
      _typedOn(CHANNELS.SIDECAR_NEW_TAB_MENU_ACTION, callback),
  },

  // Hibernation API
  hibernation: {
    getConfig: (): Promise<{ enabled: boolean; inactiveThresholdHours: number }> =>
      ipcRenderer.invoke(CHANNELS.HIBERNATION_GET_CONFIG),

    updateConfig: (
      config: Partial<{ enabled: boolean; inactiveThresholdHours: number }>
    ): Promise<{ enabled: boolean; inactiveThresholdHours: number }> =>
      ipcRenderer.invoke(CHANNELS.HIBERNATION_UPDATE_CONFIG, config),
  },

  // System Sleep API
  systemSleep: {
    getMetrics: () => _typedInvoke(CHANNELS.SYSTEM_SLEEP_GET_METRICS),

    getAwakeTimeSince: (startTimestamp: number) =>
      _typedInvoke(CHANNELS.SYSTEM_SLEEP_GET_AWAKE_TIME, startTimestamp),

    reset: () => _typedInvoke(CHANNELS.SYSTEM_SLEEP_RESET),

    onWake: (callback: (sleepDurationMs: number) => void) =>
      _typedOn(CHANNELS.SYSTEM_SLEEP_ON_WAKE, callback),
  },

  // Keybinding API
  keybinding: {
    getOverrides: () => _typedInvoke(CHANNELS.KEYBINDING_GET_OVERRIDES),

    setOverride: (actionId: KeyAction, combo: string[]) =>
      _typedInvoke(CHANNELS.KEYBINDING_SET_OVERRIDE, { actionId, combo }),

    removeOverride: (actionId: KeyAction) =>
      _typedInvoke(CHANNELS.KEYBINDING_REMOVE_OVERRIDE, actionId),

    resetAll: () => _typedInvoke(CHANNELS.KEYBINDING_RESET_ALL),
  },

  // Worktree Config API
  worktreeConfig: {
    get: () => _typedInvoke(CHANNELS.WORKTREE_CONFIG_GET),

    setPattern: (pattern: string) =>
      _typedInvoke(CHANNELS.WORKTREE_CONFIG_SET_PATTERN, { pattern }),
  },

  // Window API
  window: {
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) =>
        callback(isFullscreen);
      ipcRenderer.on(CHANNELS.WINDOW_FULLSCREEN_CHANGE, handler);
      return () => ipcRenderer.removeListener(CHANNELS.WINDOW_FULLSCREEN_CHANGE, handler);
    },
    toggleFullscreen: (): Promise<boolean> => _typedInvoke(CHANNELS.WINDOW_TOGGLE_FULLSCREEN),
    reload: (): Promise<void> => _typedInvoke(CHANNELS.WINDOW_RELOAD),
    forceReload: (): Promise<void> => _typedInvoke(CHANNELS.WINDOW_FORCE_RELOAD),
    toggleDevTools: (): Promise<void> => _typedInvoke(CHANNELS.WINDOW_TOGGLE_DEVTOOLS),
    zoomIn: (): Promise<void> => _typedInvoke(CHANNELS.WINDOW_ZOOM_IN),
    zoomOut: (): Promise<void> => _typedInvoke(CHANNELS.WINDOW_ZOOM_OUT),
    zoomReset: (): Promise<void> => _typedInvoke(CHANNELS.WINDOW_ZOOM_RESET),
    close: (): Promise<void> => _typedInvoke(CHANNELS.WINDOW_CLOSE),
  },

  // Notification API
  notification: {
    updateBadge: (state: { waitingCount: number; failedCount: number }) =>
      ipcRenderer.send(CHANNELS.NOTIFICATION_UPDATE, state),
  },

  // Gemini API
  gemini: {
    getStatus: () => _typedInvoke(CHANNELS.GEMINI_GET_STATUS),

    enableAlternateBuffer: () => _typedInvoke(CHANNELS.GEMINI_ENABLE_ALTERNATE_BUFFER),
  },

  // Commands API
  commands: {
    list: (context?: {
      terminalId?: string;
      worktreeId?: string;
      projectId?: string;
      cwd?: string;
      agentId?: string;
    }) => ipcRenderer.invoke(CHANNELS.COMMANDS_LIST, context),

    get: (payload: {
      commandId: string;
      context?: {
        terminalId?: string;
        worktreeId?: string;
        projectId?: string;
        cwd?: string;
        agentId?: string;
      };
    }) => ipcRenderer.invoke(CHANNELS.COMMANDS_GET, payload),

    execute: (payload: {
      commandId: string;
      context: {
        terminalId?: string;
        worktreeId?: string;
        projectId?: string;
        cwd?: string;
        agentId?: string;
      };
      args?: Record<string, unknown>;
    }) => ipcRenderer.invoke(CHANNELS.COMMANDS_EXECUTE, payload),

    getBuilder: (commandId: string) => ipcRenderer.invoke(CHANNELS.COMMANDS_GET_BUILDER, commandId),
  },

  // App Agent API
  appAgent: {
    runOneShot: (payload: {
      request: { prompt: string; clarificationChoice?: string };
      actions: Array<{
        id: string;
        name: string;
        title: string;
        description: string;
        category: string;
        kind: string;
        danger: string;
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        enabled: boolean;
        disabledReason?: string;
      }>;
      context: {
        projectId?: string;
        activeWorktreeId?: string;
        focusedWorktreeId?: string;
        focusedTerminalId?: string;
      };
    }) => ipcRenderer.invoke(CHANNELS.APP_AGENT_RUN_ONE_SHOT, payload),

    getConfig: () => ipcRenderer.invoke(CHANNELS.APP_AGENT_GET_CONFIG),

    setConfig: (config: { provider?: string; model?: string; apiKey?: string; baseUrl?: string }) =>
      ipcRenderer.invoke(CHANNELS.APP_AGENT_SET_CONFIG, config),

    hasApiKey: () => ipcRenderer.invoke(CHANNELS.APP_AGENT_HAS_API_KEY),

    testApiKey: (apiKey: string) => ipcRenderer.invoke(CHANNELS.APP_AGENT_TEST_API_KEY, apiKey),

    testModel: (model: string) => ipcRenderer.invoke(CHANNELS.APP_AGENT_TEST_MODEL, model),

    cancel: () => ipcRenderer.invoke(CHANNELS.APP_AGENT_CANCEL),

    dispatchAction: (payload: {
      actionId: string;
      args?: Record<string, unknown>;
      context: {
        projectId?: string;
        activeWorktreeId?: string;
        focusedWorktreeId?: string;
        focusedTerminalId?: string;
      };
    }) => ipcRenderer.invoke(CHANNELS.APP_AGENT_DISPATCH_ACTION, payload),

    // Listen for action dispatch requests from main process (for multi-step execution)
    onDispatchActionRequest: (
      callback: (payload: {
        requestId: string;
        actionId: string;
        args?: Record<string, unknown>;
        context: {
          projectId?: string;
          activeWorktreeId?: string;
          focusedWorktreeId?: string;
          focusedTerminalId?: string;
        };
      }) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: {
          requestId: string;
          actionId: string;
          args?: Record<string, unknown>;
          context: {
            projectId?: string;
            activeWorktreeId?: string;
            focusedWorktreeId?: string;
            focusedTerminalId?: string;
          };
        }
      ) => callback(payload);
      ipcRenderer.on("app-agent:dispatch-action-request", handler);
      return () => ipcRenderer.removeListener("app-agent:dispatch-action-request", handler);
    },

    // Send action dispatch response back to main process
    sendDispatchActionResponse: (payload: {
      requestId: string;
      result: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    }) => ipcRenderer.send("app-agent:dispatch-action-response", payload),
  },

  // Assistant API
  assistant: {
    sendMessage: (payload: {
      sessionId: string;
      messages: Array<{
        id: string;
        role: "user" | "assistant";
        content: string;
        toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
        toolResults?: Array<{ toolCallId: string; result: unknown; error?: string }>;
        createdAt: string;
      }>;
      context?: {
        projectId?: string;
        activeWorktreeId?: string;
        focusedTerminalId?: string;
      };
    }) => ipcRenderer.invoke(CHANNELS.ASSISTANT_SEND_MESSAGE, payload),

    cancel: (sessionId: string) => ipcRenderer.invoke(CHANNELS.ASSISTANT_CANCEL, sessionId),

    hasApiKey: () => ipcRenderer.invoke(CHANNELS.ASSISTANT_HAS_API_KEY),

    onChunk: (
      callback: (data: {
        sessionId: string;
        chunk: {
          type: "text" | "tool_call" | "tool_result" | "error" | "done";
          content?: string;
          toolCall?: { id: string; name: string; args: Record<string, unknown> };
          toolResult?: { toolCallId: string; result: unknown; error?: string };
          error?: string;
          finishReason?: string;
        };
      }) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          sessionId: string;
          chunk: {
            type: "text" | "tool_call" | "tool_result" | "error" | "done";
            content?: string;
            toolCall?: { id: string; name: string; args: Record<string, unknown> };
            toolResult?: { toolCallId: string; result: unknown; error?: string };
            error?: string;
            finishReason?: string;
          };
        }
      ) => callback(data);
      ipcRenderer.on(CHANNELS.ASSISTANT_CHUNK, handler);
      return () => ipcRenderer.removeListener(CHANNELS.ASSISTANT_CHUNK, handler);
    },
  },
};

// Expose the API to the renderer process only for trusted origins in the main frame
if (window.top === window && isTrustedRendererUrl(window.location.href)) {
  contextBridge.exposeInMainWorld("electron", api);
} else {
  if (window.top !== window) {
    console.error(
      "[Preload] Refusing to expose window.electron API to subframe:",
      window.location.href
    );
  } else {
    console.error(
      "[Preload] Refusing to expose window.electron API to untrusted origin:",
      window.location.href
    );
  }
}
