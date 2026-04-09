/**
 * Built separately with NodeNext/ESM settings for Electron's preload.
 * Channel names are inlined to avoid module format conflicts with ESM main process.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { isTrustedRendererUrl } from "../shared/utils/trustedRenderer.js";
import { isIpcEnvelope } from "../shared/types/ipc/errors.js";
import { deserializeError } from "../shared/utils/ipcErrorSerialization.js";

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
  RetryProgressPayload,
  AppError,
  ElectronAPI,
  CreateWorktreeOptions,
  IpcInvokeMap,
  IpcEventMap,
  AgentSettingsEntry,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
  GitStatus,
  KeyAction,
  TerminalRecipe,
  AttachIssuePayload,
  IssueAssociation,
  VoiceInputStatus,
  ChecklistItemId,
} from "../shared/types/index.js";
import type { ColorVisionMode, AppColorScheme } from "../shared/types/appTheme.js";
import type {
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  ArtifactDetectedPayload,
  SaveArtifactOptions,
  ApplyPatchOptions,
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewSessionState,
  DevPreviewStateChangedPayload,
} from "../shared/types/ipc.js";
import type { TerminalActivityPayload } from "../shared/types/terminal.js";
import type {
  TerminalStatusPayload,
  SpawnResult,
  TerminalResourceBatchPayload,
} from "../shared/types/pty-host.js";

type SpawnResultPayload = SpawnResult;
import type {
  PortalNewTabMenuAction,
  PortalShowNewTabMenuPayload,
} from "../shared/types/portal.js";
import type { ShowContextMenuPayload } from "../shared/types/menu.js";
import type { ResourceProfilePayload } from "../shared/types/resourceProfile.js";

export type { ElectronAPI };

const isDemoMode =
  !process.argv.some((a) => a.includes("app.asar")) && process.argv.includes("--demo-mode");

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

// Direct MessagePort from workspace host for worktree/PR/issue events.
// Events arrive as WorkspaceHostEvent objects and are re-emitted on ipcRenderer
// so existing contextBridge-exposed listeners work transparently.
let workspacePort: MessagePort | null = null;

ipcRenderer.on("workspace-port", (event: Electron.IpcRendererEvent) => {
  if (!event.ports || event.ports.length === 0) return;

  if (workspacePort) {
    try {
      workspacePort.close();
    } catch {
      /* ignore */
    }
  }

  workspacePort = event.ports[0];
  workspacePort.onmessage = (msg: MessageEvent) => {
    const data = msg.data;
    if (!data?.type) return;

    // Re-emit as ipcRenderer events so existing on*/subscribe handlers fire
    const fakeEvent = {} as Electron.IpcRendererEvent;
    switch (data.type) {
      case "worktree-update":
        ipcRenderer.emit(CHANNELS.WORKTREE_UPDATE, fakeEvent, {
          worktree: data.worktree,
        });
        break;
      case "worktree-removed":
        ipcRenderer.emit(CHANNELS.WORKTREE_REMOVE, fakeEvent, {
          worktreeId: data.worktreeId,
        });
        break;
      case "pr-detected":
        ipcRenderer.emit(CHANNELS.PR_DETECTED, fakeEvent, {
          worktreeId: data.worktreeId,
          prNumber: data.prNumber,
          prUrl: data.prUrl,
          prState: data.prState,
          prTitle: data.prTitle,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
          timestamp: Date.now(),
        });
        break;
      case "pr-cleared":
        ipcRenderer.emit(CHANNELS.PR_CLEARED, fakeEvent, {
          worktreeId: data.worktreeId,
          timestamp: Date.now(),
        });
        break;
      case "issue-detected":
        ipcRenderer.emit(CHANNELS.ISSUE_DETECTED, fakeEvent, {
          worktreeId: data.worktreeId,
          issueNumber: data.issueNumber,
          issueTitle: data.issueTitle,
        });
        break;
      case "issue-not-found":
        ipcRenderer.emit(CHANNELS.ISSUE_NOT_FOUND, fakeEvent, {
          worktreeId: data.worktreeId,
          issueNumber: data.issueNumber,
          timestamp: Date.now(),
        });
        break;
    }
  };
  console.log("[Preload] Workspace direct port connected");
});

// ── Worktree Port Client (Phase 1) ──────────────────────────────────────────
// New dedicated port for worktree data with request/response correlation.
// Coexists with the legacy workspace-port above — both work independently.

type WorktreePortEventCallback = (data: unknown) => void;

class WorktreePortClient {
  private port: MessagePort | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private eventListeners = new Map<string, Set<WorktreePortEventCallback>>();
  private readyCallbacks: Array<() => void> = [];
  private _isReady = false;

  attach(newPort: MessagePort): void {
    // Close old port and reject pending requests
    if (this.port) {
      this.detach();
    }

    this.port = newPort;
    this._isReady = true;

    this.port.onmessage = (msg: MessageEvent) => {
      const data = msg.data;
      if (!data) return;

      // Response to a request
      if (data.id && this.pending.has(data.id)) {
        const entry = this.pending.get(data.id)!;
        clearTimeout(entry.timeout);
        this.pending.delete(data.id);

        if (data.error) {
          entry.reject(new Error(data.error));
        } else {
          entry.resolve(data.result);
        }
        return;
      }

      // Spontaneous event from host
      if (data.type === "event" && data.event?.type) {
        const listeners = this.eventListeners.get(data.event.type);
        if (listeners) {
          for (const cb of listeners) {
            try {
              cb(data.event);
            } catch {
              // Don't let listener errors crash the port
            }
          }
        }
      }
    };

    // Fire ready callbacks (kept for re-attach — not cleared)
    for (const cb of this.readyCallbacks) {
      try {
        cb();
      } catch {
        // ignore
      }
    }

    console.log("[Preload] Worktree port connected");
  }

  private detach(): void {
    if (!this.port) return;

    try {
      this.port.close();
    } catch {
      // ignore
    }

    // Reject all pending requests
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Worktree port replaced"));
    }
    this.pending.clear();

    this.port = null;
    this._isReady = false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(action: string, payload?: Record<string, unknown>, timeoutMs = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error("Worktree port not ready"));
        return;
      }

      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worktree port request timed out: ${action}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        this.port.postMessage({ id, action, payload: payload || {} });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(type: string, callback: WorktreePortEventCallback): () => void {
    let listeners = this.eventListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(type, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners!.delete(callback);
      if (listeners!.size === 0) {
        this.eventListeners.delete(type);
      }
    };
  }

  isReady(): boolean {
    return this._isReady;
  }

  onReady(callback: () => void): () => void {
    if (this._isReady) {
      callback();
    }
    // Always register for future re-attaches (port replacement on host restart)
    this.readyCallbacks.push(callback);
    return () => {
      const idx = this.readyCallbacks.indexOf(callback);
      if (idx >= 0) this.readyCallbacks.splice(idx, 1);
    };
  }
}

const worktreePortClient = new WorktreePortClient();

ipcRenderer.on("worktree-port", (event: Electron.IpcRendererEvent) => {
  if (!event.ports || event.ports.length === 0) return;
  worktreePortClient.attach(event.ports[0]);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches ipcRenderer.invoke return type
async function _unwrappingInvoke(channel: string, ...args: unknown[]): Promise<any> {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (isIpcEnvelope(response)) {
    if (!response.ok) throw deserializeError(response.error);
    return response.data;
  }
  return response;
}

function _typedInvoke<K extends Extract<keyof IpcInvokeMap, string>>(
  channel: K,
  ...args: IpcInvokeMap[K]["args"]
): Promise<IpcInvokeMap[K]["result"]> {
  return _unwrappingInvoke(channel, ...args) as Promise<IpcInvokeMap[K]["result"]>;
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
  WORKTREE_ACTIVATED: "worktree:activated",
  WORKTREE_CREATE: "worktree:create",
  WORKTREE_LIST_BRANCHES: "worktree:list-branches",
  WORKTREE_FETCH_PR_BRANCH: "worktree:fetch-pr-branch",
  WORKTREE_GET_RECENT_BRANCHES: "worktree:get-recent-branches",
  WORKTREE_PR_REFRESH: "worktree:pr-refresh",
  WORKTREE_PR_STATUS: "worktree:pr-status",
  WORKTREE_GET_DEFAULT_PATH: "worktree:get-default-path",
  WORKTREE_GET_AVAILABLE_BRANCH: "worktree:get-available-branch",
  WORKTREE_DELETE: "worktree:delete",
  WORKTREE_CREATE_FOR_TASK: "worktree:create-for-task",
  WORKTREE_GET_BY_TASK_ID: "worktree:get-by-task-id",
  WORKTREE_CLEANUP_TASK: "worktree:cleanup-task",
  WORKTREE_ATTACH_ISSUE: "worktree:attach-issue",
  WORKTREE_DETACH_ISSUE: "worktree:detach-issue",
  WORKTREE_GET_ISSUE_ASSOCIATION: "worktree:get-issue-association",
  WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS: "worktree:get-all-issue-associations",

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
  TERMINAL_GET_AVAILABLE: "terminal:get-available",
  TERMINAL_GET_BY_STATE: "terminal:get-by-state",
  TERMINAL_GET_ALL: "terminal:get-all",
  TERMINAL_RECONNECT: "terminal:reconnect",
  TERMINAL_REPLAY_HISTORY: "terminal:replay-history",
  TERMINAL_GET_SERIALIZED_STATE: "terminal:get-serialized-state",
  TERMINAL_GET_SERIALIZED_STATES: "terminal:get-serialized-states",
  TERMINAL_GET_SHARED_BUFFERS: "terminal:get-shared-buffers",
  TERMINAL_GET_ANALYSIS_BUFFER: "terminal:get-analysis-buffer",
  TERMINAL_GET_INFO: "terminal:get-info",
  TERMINAL_ACKNOWLEDGE_DATA: "terminal:acknowledge-data",
  TERMINAL_FORCE_RESUME: "terminal:force-resume",
  TERMINAL_GRACEFUL_KILL: "terminal:graceful-kill",
  TERMINAL_STATUS: "terminal:status",
  TERMINAL_BACKEND_CRASHED: "terminal:backend-crashed",
  TERMINAL_BACKEND_READY: "terminal:backend-ready",
  TERMINAL_SEND_KEY: "terminal:send-key",
  TERMINAL_AGENT_TITLE_STATE: "terminal:agent-title-state",
  TERMINAL_REDUCE_SCROLLBACK: "terminal:reduce-scrollback",
  TERMINAL_RESTORE_SCROLLBACK: "terminal:restore-scrollback",
  TERMINAL_RESTART_SERVICE: "terminal:restart-service",

  // Agent session history channels
  AGENT_SESSION_LIST: "agent-session:list",
  AGENT_SESSION_CLEAR: "agent-session:clear",

  // Files channels
  FILES_SEARCH: "files:search",
  FILES_READ: "files:read",

  // Agent state channels
  AGENT_STATE_CHANGED: "agent:state-changed",
  AGENT_ALL_CLEAR: "agent:all-clear",
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

  // Editor channels
  EDITOR_GET_CONFIG: "editor:get-config",
  EDITOR_SET_CONFIG: "editor:set-config",
  EDITOR_DISCOVER: "editor:discover",

  // System channels
  SYSTEM_OPEN_EXTERNAL: "system:open-external",
  SYSTEM_OPEN_PATH: "system:open-path",
  SYSTEM_OPEN_IN_EDITOR: "system:open-in-editor",
  SYSTEM_CHECK_COMMAND: "system:check-command",
  SYSTEM_CHECK_DIRECTORY: "system:check-directory",
  SYSTEM_GET_HOME_DIR: "system:get-home-dir",
  SYSTEM_GET_TMP_DIR: "system:get-tmp-dir",
  SYSTEM_GET_CLI_AVAILABILITY: "system:get-cli-availability",
  SYSTEM_REFRESH_CLI_AVAILABILITY: "system:refresh-cli-availability",
  SYSTEM_GET_AGENT_VERSIONS: "system:get-agent-versions",
  SYSTEM_REFRESH_AGENT_VERSIONS: "system:refresh-agent-versions",
  SYSTEM_GET_AGENT_UPDATE_SETTINGS: "system:get-agent-update-settings",
  SYSTEM_SET_AGENT_UPDATE_SETTINGS: "system:set-agent-update-settings",
  SYSTEM_START_AGENT_UPDATE: "system:start-agent-update",
  SETUP_AGENT_INSTALL: "setup:agent-install",
  SETUP_AGENT_INSTALL_PROGRESS: "setup:agent-install-progress",

  SYSTEM_HEALTH_CHECK: "system:health-check",
  SYSTEM_HEALTH_CHECK_SPECS: "system:health-check-specs",
  SYSTEM_CHECK_TOOL: "system:check-tool",
  SYSTEM_DOWNLOAD_DIAGNOSTICS: "system:download-diagnostics",
  SYSTEM_GET_APP_METRICS: "system:get-app-metrics",
  SYSTEM_GET_HARDWARE_INFO: "system:get-hardware-info",
  DIAGNOSTICS_GET_PROCESS_METRICS: "diagnostics:get-process-metrics",
  DIAGNOSTICS_GET_HEAP_STATS: "diagnostics:get-heap-stats",
  DIAGNOSTICS_GET_INFO: "diagnostics:get-info",
  SYSTEM_WAKE: "system:wake",

  // PR detection channels
  PR_DETECTED: "pr:detected",
  PR_CLEARED: "pr:cleared",
  ISSUE_DETECTED: "issue:detected",
  ISSUE_NOT_FOUND: "issue:not-found",

  // GitHub channels
  GITHUB_GET_REPO_STATS: "github:get-repo-stats",
  GITHUB_GET_PROJECT_HEALTH: "github:get-project-health",
  GITHUB_OPEN_ISSUES: "github:open-issues",
  GITHUB_OPEN_PRS: "github:open-prs",
  GITHUB_OPEN_COMMITS: "github:open-commits",
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
  GITHUB_GET_ISSUE_BY_NUMBER: "github:get-issue-by-number",
  GITHUB_GET_PR_BY_NUMBER: "github:get-pr-by-number",
  GITHUB_LIST_REMOTES: "github:list-remotes",

  // Notes channels
  NOTES_CREATE: "notes:create",
  NOTES_READ: "notes:read",
  NOTES_WRITE: "notes:write",
  NOTES_LIST: "notes:list",
  NOTES_DELETE: "notes:delete",
  NOTES_SEARCH: "notes:search",
  NOTES_UPDATED: "notes:updated",

  // Dev Preview channels
  DEV_PREVIEW_ENSURE: "dev-preview:ensure",
  DEV_PREVIEW_RESTART: "dev-preview:restart",
  DEV_PREVIEW_STOP: "dev-preview:stop",
  DEV_PREVIEW_STOP_BY_PANEL: "dev-preview:stop-by-panel",
  DEV_PREVIEW_GET_STATE: "dev-preview:get-state",
  DEV_PREVIEW_STATE_CHANGED: "dev-preview:state-changed",

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
  ERROR_RETRY_CANCEL: "error:retry-cancel",
  ERROR_RETRY_PROGRESS: "error:retry-progress",
  ERROR_OPEN_LOGS: "error:open-logs",
  ERROR_GET_PENDING: "error:get-pending",

  // Event Inspector channels
  EVENT_INSPECTOR_GET_EVENTS: "event-inspector:get-events",
  EVENT_INSPECTOR_GET_FILTERED: "event-inspector:get-filtered",
  EVENT_INSPECTOR_CLEAR: "event-inspector:clear",
  EVENT_INSPECTOR_EVENT: "event-inspector:event",
  EVENT_INSPECTOR_EVENT_BATCH: "event-inspector:event-batch",
  EVENT_INSPECTOR_SUBSCRIBE: "event-inspector:subscribe",
  EVENT_INSPECTOR_UNSUBSCRIBE: "event-inspector:unsubscribe",
  EVENTS_EMIT: "events:emit",

  // Project channels
  PROJECT_GET_ALL: "project:get-all",
  PROJECT_GET_CURRENT: "project:get-current",
  PROJECT_ADD: "project:add",
  PROJECT_REMOVE: "project:remove",
  PROJECT_UPDATE: "project:update",
  PROJECT_UPDATED: "project:updated",
  PROJECT_REMOVED: "project:removed",
  PROJECT_SWITCH: "project:switch",
  PROJECT_OPEN_DIALOG: "project:open-dialog",
  PROJECT_ON_SWITCH: "project:on-switch",
  PROJECT_GET_SETTINGS: "project:get-settings",
  PROJECT_SAVE_SETTINGS: "project:save-settings",
  PROJECT_DETECT_RUNNERS: "project:detect-runners",
  PROJECT_CLOSE: "project:close",
  PROJECT_REOPEN: "project:reopen",
  PROJECT_GET_STATS: "project:get-stats",
  PROJECT_GET_BULK_STATS: "project:get-bulk-stats",
  PROJECT_STATS_UPDATED: "project:stats-updated",
  PROJECT_CREATE_FOLDER: "project:create-folder",
  PROJECT_INIT_GIT: "project:init-git",
  PROJECT_INIT_GIT_GUIDED: "project:init-git-guided",
  PROJECT_INIT_GIT_PROGRESS: "project:init-git-progress",
  PROJECT_CLONE_REPO: "project:clone-repo",
  PROJECT_CLONE_PROGRESS: "project:clone-progress",
  PROJECT_CLONE_CANCEL: "project:clone-cancel",
  PROJECT_GET_RECIPES: "project:get-recipes",
  PROJECT_SAVE_RECIPES: "project:save-recipes",
  PROJECT_ADD_RECIPE: "project:add-recipe",
  PROJECT_UPDATE_RECIPE: "project:update-recipe",
  PROJECT_DELETE_RECIPE: "project:delete-recipe",
  RECIPE_EXPORT_FILE: "recipe:export-file",
  RECIPE_IMPORT_FILE: "recipe:import-file",
  PROJECT_GET_INREPO_RECIPES: "project:get-inrepo-recipes",
  PROJECT_SYNC_INREPO_RECIPES: "project:sync-inrepo-recipes",
  PROJECT_UPDATE_INREPO_RECIPE: "project:update-inrepo-recipe",
  PROJECT_DELETE_INREPO_RECIPE: "project:delete-inrepo-recipe",
  GLOBAL_GET_RECIPES: "global:get-recipes",
  GLOBAL_ADD_RECIPE: "global:add-recipe",
  GLOBAL_UPDATE_RECIPE: "global:update-recipe",
  GLOBAL_DELETE_RECIPE: "global:delete-recipe",
  PROJECT_GET_TERMINALS: "project:get-terminals",
  PROJECT_SET_TERMINALS: "project:set-terminals",
  PROJECT_GET_TERMINAL_SIZES: "project:get-terminal-sizes",
  PROJECT_SET_TERMINAL_SIZES: "project:set-terminal-sizes",
  PROJECT_GET_DRAFT_INPUTS: "project:get-draft-inputs",
  PROJECT_SET_DRAFT_INPUTS: "project:set-draft-inputs",
  PROJECT_GET_TAB_GROUPS: "project:get-tab-groups",
  PROJECT_SET_TAB_GROUPS: "project:set-tab-groups",
  PROJECT_GET_FOCUS_MODE: "project:get-focus-mode",
  PROJECT_SET_FOCUS_MODE: "project:set-focus-mode",
  PROJECT_READ_CLAUDE_MD: "project:read-claude-md",
  PROJECT_WRITE_CLAUDE_MD: "project:write-claude-md",
  PROJECT_ENABLE_IN_REPO_SETTINGS: "project:enable-in-repo-settings",
  PROJECT_DISABLE_IN_REPO_SETTINGS: "project:disable-in-repo-settings",
  PROJECT_CHECK_MISSING: "project:check-missing",
  PROJECT_LOCATE: "project:locate",
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
  TERMINAL_CONFIG_SET_COLOR_SCHEME: "terminal-config:set-color-scheme",
  TERMINAL_CONFIG_SET_CUSTOM_SCHEMES: "terminal-config:set-custom-schemes",
  TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS: "terminal-config:set-recent-scheme-ids",
  TERMINAL_CONFIG_IMPORT_COLOR_SCHEME: "terminal-config:import-color-scheme",
  TERMINAL_CONFIG_SET_SCREEN_READER_MODE: "terminal-config:set-screen-reader-mode",
  TERMINAL_CONFIG_SET_RESOURCE_MONITORING: "terminal-config:set-resource-monitoring",
  TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION: "terminal-config:set-memory-leak-detection",
  TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART: "terminal-config:set-memory-leak-auto-restart",
  TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS: "terminal-config:set-cached-project-views",

  TERMINAL_RESOURCE_METRICS: "terminal:resource-metrics",

  ACCESSIBILITY_GET_ENABLED: "accessibility:get-enabled",
  ACCESSIBILITY_SUPPORT_CHANGED: "accessibility:support-changed",

  // Git channels
  GIT_GET_FILE_DIFF: "git:get-file-diff",
  GIT_GET_PROJECT_PULSE: "git:get-project-pulse",
  GIT_LIST_COMMITS: "git:list-commits",
  GIT_STAGE_FILE: "git:stage-file",
  GIT_UNSTAGE_FILE: "git:unstage-file",
  GIT_STAGE_ALL: "git:stage-all",
  GIT_UNSTAGE_ALL: "git:unstage-all",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_GET_STAGING_STATUS: "git:get-staging-status",
  GIT_COMPARE_WORKTREES: "git:compare-worktrees",
  GIT_GET_USERNAME: "git:get-username",
  GIT_GET_WORKING_DIFF: "git:get-working-diff",
  GIT_SNAPSHOT_GET: "git:snapshot-get",
  GIT_SNAPSHOT_LIST: "git:snapshot-list",
  GIT_SNAPSHOT_REVERT: "git:snapshot-revert",
  GIT_SNAPSHOT_DELETE: "git:snapshot-delete",

  // Portal channels
  PORTAL_CREATE: "portal:create",
  PORTAL_SHOW: "portal:show",
  PORTAL_HIDE: "portal:hide",
  PORTAL_RESIZE: "portal:resize",
  PORTAL_CLOSE_TAB: "portal:close-tab",
  PORTAL_NAVIGATE: "portal:navigate",
  PORTAL_GO_BACK: "portal:go-back",
  PORTAL_GO_FORWARD: "portal:go-forward",
  PORTAL_RELOAD: "portal:reload",
  PORTAL_SHOW_NEW_TAB_MENU: "portal:show-new-tab-menu",
  PORTAL_NAV_EVENT: "portal:nav-event",
  PORTAL_FOCUS: "portal:focus",
  PORTAL_BLUR: "portal:blur",
  PORTAL_NEW_TAB_MENU_ACTION: "portal:new-tab-menu-action",
  PORTAL_TAB_EVICTED: "portal:tab-evicted",
  PORTAL_TABS_EVICTED: "portal:tabs-evicted",

  // Webview channels
  WEBVIEW_SET_LIFECYCLE_STATE: "webview:set-lifecycle-state",
  WEBVIEW_REGISTER_PANEL: "webview:register-panel",
  WEBVIEW_DIALOG_REQUEST: "webview:dialog-request",
  WEBVIEW_DIALOG_RESPONSE: "webview:dialog-response",
  WEBVIEW_FIND_SHORTCUT: "webview:find-shortcut",
  WEBVIEW_NAVIGATION_BLOCKED: "webview:navigation-blocked",
  WEBVIEW_OAUTH_LOOPBACK: "webview:oauth-loopback",
  WEBVIEW_START_CONSOLE_CAPTURE: "webview:start-console-capture",
  WEBVIEW_STOP_CONSOLE_CAPTURE: "webview:stop-console-capture",
  WEBVIEW_CLEAR_CONSOLE_CAPTURE: "webview:clear-console-capture",
  WEBVIEW_GET_CONSOLE_PROPERTIES: "webview:get-console-properties",
  WEBVIEW_CONSOLE_MESSAGE: "webview:console-message",
  WEBVIEW_CONSOLE_CONTEXT_CLEARED: "webview:console-context-cleared",

  // Hibernation channels
  HIBERNATION_GET_CONFIG: "hibernation:get-config",
  HIBERNATION_UPDATE_CONFIG: "hibernation:update-config",
  HIBERNATION_PROJECT_HIBERNATED: "hibernation:project-hibernated",

  // Idle terminal notification channels
  IDLE_TERMINAL_GET_CONFIG: "idle-terminal:get-config",
  IDLE_TERMINAL_UPDATE_CONFIG: "idle-terminal:update-config",
  IDLE_TERMINAL_CLOSE_PROJECT: "idle-terminal:close-project",
  IDLE_TERMINAL_DISMISS_PROJECT: "idle-terminal:dismiss-project",
  IDLE_TERMINAL_NOTIFY: "idle-terminal:notify",

  // System Sleep channels
  SYSTEM_SLEEP_GET_METRICS: "system-sleep:get-metrics",
  SYSTEM_SLEEP_GET_AWAKE_TIME: "system-sleep:get-awake-time",
  SYSTEM_SLEEP_RESET: "system-sleep:reset",
  SYSTEM_SLEEP_ON_SUSPEND: "system-sleep:on-suspend",
  SYSTEM_SLEEP_ON_WAKE: "system-sleep:on-wake",

  // Keybinding channels
  KEYBINDING_GET_OVERRIDES: "keybinding:get-overrides",
  KEYBINDING_SET_OVERRIDE: "keybinding:set-override",
  KEYBINDING_REMOVE_OVERRIDE: "keybinding:remove-override",
  KEYBINDING_RESET_ALL: "keybinding:reset-all",
  KEYBINDING_EXPORT_PROFILE: "keybinding:export-profile",
  KEYBINDING_IMPORT_PROFILE: "keybinding:import-profile",

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
  WINDOW_NEW: "window:new",
  WINDOW_RECLAIM_MEMORY: "window:reclaim-memory",
  WINDOW_DESTROY_HIDDEN_WEBVIEWS: "window:destroy-hidden-webviews",
  WINDOW_DISK_SPACE_STATUS: "window:disk-space-status",

  // Notification channels
  SOUND_TRIGGER: "sound:trigger",
  SOUND_CANCEL: "sound:cancel",
  SOUND_GET_DIR: "sound:get-dir",

  NOTIFICATION_UPDATE: "notification:update",
  NOTIFICATION_SETTINGS_GET: "notification:settings-get",
  NOTIFICATION_SETTINGS_SET: "notification:settings-set",
  NOTIFICATION_PLAY_SOUND: "notification:play-sound",
  NOTIFICATION_SHOW_NATIVE: "notification:show-native",
  NOTIFICATION_SHOW_WATCH: "notification:show-watch",
  NOTIFICATION_WATCH_NAVIGATE: "notification:watch-navigate",
  NOTIFICATION_SYNC_WATCHED: "notification:sync-watched",
  NOTIFICATION_WAITING_ACKNOWLEDGE: "notification:waiting-acknowledge",
  NOTIFICATION_WORKING_PULSE_ACKNOWLEDGE: "notification:working-pulse-acknowledge",
  NOTIFICATION_SHOW_TOAST: "notification:show-toast",

  SOUND_PLAY_UI_EVENT: "sound:play-ui-event",

  // Auto-update channels
  UPDATE_AVAILABLE: "update:available",
  UPDATE_DOWNLOAD_PROGRESS: "update:download-progress",
  UPDATE_DOWNLOADED: "update:downloaded",
  UPDATE_QUIT_AND_INSTALL: "update:quit-and-install",
  UPDATE_CHECK_FOR_UPDATES: "update:check-for-updates",
  UPDATE_GET_CHANNEL: "update:get-channel",
  UPDATE_SET_CHANNEL: "update:set-channel",

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
  APP_AGENT_GET_CONFIG: "app-agent:get-config",
  APP_AGENT_SET_CONFIG: "app-agent:set-config",
  APP_AGENT_HAS_API_KEY: "app-agent:has-api-key",
  APP_AGENT_TEST_API_KEY: "app-agent:test-api-key",
  APP_AGENT_TEST_MODEL: "app-agent:test-model",

  // Agent Capabilities channels
  AGENT_CAPABILITIES_GET_REGISTRY: "agent-capabilities:get-registry",
  AGENT_CAPABILITIES_GET_AGENT_IDS: "agent-capabilities:get-agent-ids",
  AGENT_CAPABILITIES_GET_AGENT_METADATA: "agent-capabilities:get-agent-metadata",
  AGENT_CAPABILITIES_IS_AGENT_ENABLED: "agent-capabilities:is-agent-enabled",

  // Help workspace channels
  HELP_GET_FOLDER_PATH: "help:get-folder-path",
  HELP_MARK_TERMINAL: "help:mark-terminal",
  HELP_UNMARK_TERMINAL: "help:unmark-terminal",

  // Clipboard channels
  CLIPBOARD_SAVE_IMAGE: "clipboard:save-image",
  CLIPBOARD_THUMBNAIL_FROM_PATH: "clipboard:thumbnail-from-path",
  CLIPBOARD_WRITE_IMAGE: "clipboard:write-image",

  // App Theme channels
  APP_THEME_GET: "app-theme:get",
  APP_THEME_SET_COLOR_SCHEME: "app-theme:set-color-scheme",
  APP_THEME_SET_CUSTOM_SCHEMES: "app-theme:set-custom-schemes",
  APP_THEME_IMPORT: "app-theme:import",
  APP_THEME_EXPORT: "app-theme:export",
  APP_THEME_SET_COLOR_VISION_MODE: "app-theme:set-color-vision-mode",
  APP_THEME_SET_FOLLOW_SYSTEM: "app-theme:set-follow-system",
  APP_THEME_SET_PREFERRED_DARK_SCHEME: "app-theme:set-preferred-dark-scheme",
  APP_THEME_SET_PREFERRED_LIGHT_SCHEME: "app-theme:set-preferred-light-scheme",
  APP_THEME_SET_RECENT_SCHEME_IDS: "app-theme:set-recent-scheme-ids",
  APP_THEME_SYSTEM_APPEARANCE_CHANGED: "app-theme:system-appearance-changed",

  // Telemetry channels
  TELEMETRY_GET: "telemetry:get",
  TELEMETRY_SET_ENABLED: "telemetry:set-enabled",
  TELEMETRY_MARK_PROMPT_SHOWN: "telemetry:mark-prompt-shown",
  TELEMETRY_TRACK: "telemetry:track",

  // GPU channels
  GPU_GET_STATUS: "gpu:get-status",
  GPU_SET_HARDWARE_ACCELERATION: "gpu:set-hardware-acceleration",

  // Privacy & Data channels
  PRIVACY_GET_SETTINGS: "privacy:get-settings",
  PRIVACY_SET_TELEMETRY_LEVEL: "privacy:set-telemetry-level",
  PRIVACY_SET_LOG_RETENTION: "privacy:set-log-retention",
  PRIVACY_OPEN_DATA_FOLDER: "privacy:open-data-folder",
  PRIVACY_CLEAR_CACHE: "privacy:clear-cache",
  PRIVACY_RESET_ALL_DATA: "privacy:reset-all-data",
  PRIVACY_GET_DATA_FOLDER_PATH: "privacy:get-data-folder-path",

  // Voice Input channels
  VOICE_INPUT_GET_SETTINGS: "voice-input:get-settings",
  VOICE_INPUT_SET_SETTINGS: "voice-input:set-settings",
  VOICE_INPUT_START: "voice-input:start",
  VOICE_INPUT_STOP: "voice-input:stop",
  VOICE_INPUT_AUDIO_CHUNK: "voice-input:audio-chunk",
  VOICE_INPUT_TRANSCRIPTION_DELTA: "voice-input:transcription-delta",
  VOICE_INPUT_TRANSCRIPTION_COMPLETE: "voice-input:transcription-complete",
  VOICE_INPUT_CORRECTION_QUEUED: "voice-input:correction-queued",
  VOICE_INPUT_CORRECTION_REPLACE: "voice-input:correction-replace",
  VOICE_INPUT_ERROR: "voice-input:error",
  VOICE_INPUT_STATUS: "voice-input:status",
  VOICE_INPUT_CHECK_MIC_PERMISSION: "voice-input:check-mic-permission",
  VOICE_INPUT_REQUEST_MIC_PERMISSION: "voice-input:request-mic-permission",
  VOICE_INPUT_OPEN_MIC_SETTINGS: "voice-input:open-mic-settings",
  VOICE_INPUT_VALIDATE_API_KEY: "voice-input:validate-api-key",
  VOICE_INPUT_VALIDATE_CORRECTION_API_KEY: "voice-input:validate-correction-api-key",
  VOICE_INPUT_FLUSH_PARAGRAPH: "voice-input:flush-paragraph",
  VOICE_INPUT_PARAGRAPH_BOUNDARY: "voice-input:paragraph-boundary",
  VOICE_INPUT_FILE_TOKEN_RESOLVED: "voice-input:file-token-resolved",

  // MCP Server channels
  MCP_SERVER_GET_STATUS: "mcp-server:get-status",
  MCP_SERVER_SET_ENABLED: "mcp-server:set-enabled",
  MCP_SERVER_SET_PORT: "mcp-server:set-port",
  MCP_SERVER_SET_API_KEY: "mcp-server:set-api-key",
  MCP_SERVER_GENERATE_API_KEY: "mcp-server:generate-api-key",
  MCP_SERVER_GET_CONFIG_SNIPPET: "mcp-server:get-config-snippet",

  // Crash Recovery channels
  CRASH_RECOVERY_GET_PENDING: "crash-recovery:get-pending",
  CRASH_RECOVERY_RESOLVE: "crash-recovery:resolve",
  CRASH_RECOVERY_GET_CONFIG: "crash-recovery:get-config",
  CRASH_RECOVERY_SET_CONFIG: "crash-recovery:set-config",

  // Renderer Recovery channels
  RECOVERY_RELOAD_APP: "recovery:reload-app",
  RECOVERY_RESET_AND_RELOAD: "recovery:reset-and-reload",

  // Onboarding channels
  ONBOARDING_GET: "onboarding:get",
  ONBOARDING_MIGRATE: "onboarding:migrate",
  ONBOARDING_SET_STEP: "onboarding:set-step",
  ONBOARDING_COMPLETE: "onboarding:complete",
  ONBOARDING_MARK_TOAST_SEEN: "onboarding:mark-toast-seen",
  ONBOARDING_MARK_NEWSLETTER_SEEN: "onboarding:mark-newsletter-seen",
  ONBOARDING_MARK_WAITING_NUDGE_SEEN: "onboarding:mark-waiting-nudge-seen",
  ONBOARDING_CHECKLIST_GET: "onboarding:checklist-get",
  ONBOARDING_CHECKLIST_DISMISS: "onboarding:checklist-dismiss",
  ONBOARDING_CHECKLIST_MARK_ITEM: "onboarding:checklist-mark-item",
  ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN: "onboarding:checklist-mark-celebration-shown",

  // Shortcut Hints channels
  MILESTONES_GET: "milestones:get",
  MILESTONES_MARK_SHOWN: "milestones:mark-shown",

  SHORTCUT_HINTS_GET_COUNTS: "shortcut-hints:get-counts",
  SHORTCUT_HINTS_INCREMENT_COUNT: "shortcut-hints:increment-count",

  // Demo mode channels (dev-only)
  DEMO_MOVE_TO: "demo:move-to",
  DEMO_MOVE_TO_SELECTOR: "demo:move-to-selector",
  DEMO_CLICK: "demo:click",
  DEMO_TYPE: "demo:type",
  DEMO_SET_ZOOM: "demo:set-zoom",
  DEMO_SCREENSHOT: "demo:screenshot",
  DEMO_WAIT_FOR_SELECTOR: "demo:wait-for-selector",
  DEMO_PAUSE: "demo:pause",
  DEMO_RESUME: "demo:resume",
  DEMO_EXEC_MOVE_TO: "demo:exec-move-to",
  DEMO_EXEC_MOVE_TO_SELECTOR: "demo:exec-move-to-selector",
  DEMO_EXEC_CLICK: "demo:exec-click",
  DEMO_EXEC_TYPE: "demo:exec-type",
  DEMO_EXEC_SET_ZOOM: "demo:exec-set-zoom",
  DEMO_EXEC_PAUSE: "demo:exec-pause",
  DEMO_EXEC_RESUME: "demo:exec-resume",
  DEMO_EXEC_WAIT_FOR_SELECTOR: "demo:exec-wait-for-selector",
  DEMO_SLEEP: "demo:sleep",
  DEMO_EXEC_SLEEP: "demo:exec-sleep",
  DEMO_COMMAND_DONE: "demo:command-done",
  DEMO_START_CAPTURE: "demo:start-capture",
  DEMO_STOP_CAPTURE: "demo:stop-capture",
  DEMO_GET_CAPTURE_STATUS: "demo:get-capture-status",
  DEMO_SCROLL: "demo:scroll",
  DEMO_EXEC_SCROLL: "demo:exec-scroll",
  DEMO_DRAG: "demo:drag",
  DEMO_EXEC_DRAG: "demo:exec-drag",
  DEMO_PRESS_KEY: "demo:press-key",
  DEMO_EXEC_PRESS_KEY: "demo:exec-press-key",
  DEMO_SPOTLIGHT: "demo:spotlight",
  DEMO_EXEC_SPOTLIGHT: "demo:exec-spotlight",
  DEMO_DISMISS_SPOTLIGHT: "demo:dismiss-spotlight",
  DEMO_EXEC_DISMISS_SPOTLIGHT: "demo:exec-dismiss-spotlight",
  DEMO_ANNOTATE: "demo:annotate",
  DEMO_EXEC_ANNOTATE: "demo:exec-annotate",
  DEMO_DISMISS_ANNOTATION: "demo:dismiss-annotation",
  DEMO_EXEC_DISMISS_ANNOTATION: "demo:exec-dismiss-annotation",
  DEMO_WAIT_FOR_IDLE: "demo:wait-for-idle",
  DEMO_EXEC_WAIT_FOR_IDLE: "demo:exec-wait-for-idle",
  DEMO_ENCODE: "demo:encode",
  DEMO_ENCODE_PROGRESS: "demo:encode:progress",

  // Plugin channels
  PLUGIN_LIST: "plugin:list",
  PLUGIN_INVOKE: "plugin:invoke",
  PLUGIN_TOOLBAR_BUTTONS: "plugin:toolbar-buttons",
  PLUGIN_MENU_ITEMS: "plugin:menu-items",

  RESOURCE_PROFILE_CHANGED: "resource:profile-changed",

  APP_RELOAD_CONFIG: "app:reload-config",
  APP_CONFIG_RELOADED: "app:config-reloaded",

  PERF_FLUSH_RENDERER_MARKS: "perf:flush-renderer-marks",
} as const;

const api: ElectronAPI = {
  // Worktree API
  worktree: {
    getAll: () => _unwrappingInvoke(CHANNELS.WORKTREE_GET_ALL),

    refresh: () => _unwrappingInvoke(CHANNELS.WORKTREE_REFRESH),

    refreshPullRequests: () => _unwrappingInvoke(CHANNELS.WORKTREE_PR_REFRESH),

    getPRStatus: () => _unwrappingInvoke(CHANNELS.WORKTREE_PR_STATUS),

    setActive: (worktreeId: string) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_SET_ACTIVE, { worktreeId }),

    create: (options: CreateWorktreeOptions, rootPath: string): Promise<string> =>
      _unwrappingInvoke(CHANNELS.WORKTREE_CREATE, { rootPath, options }),

    listBranches: (rootPath: string) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_LIST_BRANCHES, { rootPath }),

    fetchPRBranch: (rootPath: string, prNumber: number, headRefName: string) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_FETCH_PR_BRANCH, { rootPath, prNumber, headRefName }),

    getRecentBranches: (rootPath: string) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_GET_RECENT_BRANCHES, { rootPath }),

    getDefaultPath: (rootPath: string, branchName: string): Promise<string> =>
      _unwrappingInvoke(CHANNELS.WORKTREE_GET_DEFAULT_PATH, { rootPath, branchName }),

    getAvailableBranch: (rootPath: string, branchName: string): Promise<string> =>
      _unwrappingInvoke(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH, { rootPath, branchName }),

    delete: (worktreeId: string, force?: boolean, deleteBranch?: boolean) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_DELETE, { worktreeId, force, deleteBranch }),

    createForTask: (payload: { taskId: string; baseBranch?: string; description?: string }) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_CREATE_FOR_TASK, payload),

    getByTaskId: (taskId: string) => _unwrappingInvoke(CHANNELS.WORKTREE_GET_BY_TASK_ID, taskId),

    cleanupTask: (taskId: string, options?: { force?: boolean; deleteBranch?: boolean }) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_CLEANUP_TASK, taskId, options),

    attachIssue: (payload: AttachIssuePayload) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_ATTACH_ISSUE, payload),

    detachIssue: (worktreeId: string) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_DETACH_ISSUE, { worktreeId }),

    getIssueAssociation: (worktreeId: string): Promise<IssueAssociation | null> =>
      _unwrappingInvoke(CHANNELS.WORKTREE_GET_ISSUE_ASSOCIATION, worktreeId),

    getAllIssueAssociations: (): Promise<Record<string, IssueAssociation>> =>
      _unwrappingInvoke(CHANNELS.WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS),

    onUpdate: (callback: (state: WorktreeState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { worktree: WorktreeState }) =>
        callback(payload.worktree);
      ipcRenderer.on(CHANNELS.WORKTREE_UPDATE, handler);
      return () => ipcRenderer.removeListener(CHANNELS.WORKTREE_UPDATE, handler);
    },

    onRemove: (callback: (data: { worktreeId: string }) => void) =>
      _typedOn(CHANNELS.WORKTREE_REMOVE, callback),

    onActivated: (callback: (data: { worktreeId: string }) => void) =>
      _typedOn(CHANNELS.WORKTREE_ACTIVATED, callback),
  },

  // Worktree Port API (Phase 1 — dedicated MessagePort with request/response)
  worktreePort: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (action: string, payload?: Record<string, unknown>): Promise<any> =>
      worktreePortClient.request(action, payload),

    onEvent: (type: string, callback: (data: unknown) => void): (() => void) =>
      worktreePortClient.onEvent(type, callback),

    isReady: (): boolean => worktreePortClient.isReady(),

    onReady: (callback: () => void): (() => void) => worktreePortClient.onReady(callback),
  },

  // Terminal API
  terminal: {
    spawn: (options: TerminalSpawnOptions) => _unwrappingInvoke(CHANNELS.TERMINAL_SPAWN, options),

    write: (id: string, data: string) => ipcRenderer.send(CHANNELS.TERMINAL_INPUT, id, data),

    submit: (id: string, text: string) => _unwrappingInvoke(CHANNELS.TERMINAL_SUBMIT, id, text),

    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send(CHANNELS.TERMINAL_RESIZE, { id, cols, rows }),

    kill: (id: string) => _unwrappingInvoke(CHANNELS.TERMINAL_KILL, id),
    gracefulKill: (id: string) => _unwrappingInvoke(CHANNELS.TERMINAL_GRACEFUL_KILL, id),

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

    onAllAgentsClear: (callback: (data: { timestamp: number }) => void) =>
      _typedOn(CHANNELS.AGENT_ALL_CLEAR, callback),

    onActivity: (callback: (data: TerminalActivityPayload) => void) =>
      _typedOn(CHANNELS.TERMINAL_ACTIVITY, callback),

    trash: (id: string) => _unwrappingInvoke(CHANNELS.TERMINAL_TRASH, id),

    restore: (id: string) => _unwrappingInvoke(CHANNELS.TERMINAL_RESTORE, id),

    onTrashed: (callback: (data: { id: string; expiresAt: number }) => void) =>
      _typedOn(CHANNELS.TERMINAL_TRASHED, callback),

    onRestored: (callback: (data: { id: string }) => void) =>
      _typedOn(CHANNELS.TERMINAL_RESTORED, callback),

    setActivityTier: (id: string, tier: "active" | "background") =>
      ipcRenderer.send(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, { id, tier }),

    wake: (id: string): Promise<{ state: string | null; warnings?: string[] }> =>
      _unwrappingInvoke(CHANNELS.TERMINAL_WAKE, id),

    acknowledgeData: (id: string, length: number) =>
      ipcRenderer.send(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, { id, length }),

    getForProject: (projectId: string) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_GET_FOR_PROJECT, projectId),

    getAvailableTerminals: () => _unwrappingInvoke(CHANNELS.TERMINAL_GET_AVAILABLE),

    getTerminalsByState: (state: string) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_GET_BY_STATE, state),

    getAllTerminals: () => _unwrappingInvoke(CHANNELS.TERMINAL_GET_ALL),

    reconnect: (terminalId: string) => _unwrappingInvoke(CHANNELS.TERMINAL_RECONNECT, terminalId),

    replayHistory: (terminalId: string, maxLines?: number) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_REPLAY_HISTORY, { terminalId, maxLines }),

    getSerializedState: (terminalId: string) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, terminalId),

    getSerializedStates: (terminalIds: string[]) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATES, terminalIds),

    getInfo: (id: string) => _unwrappingInvoke(CHANNELS.TERMINAL_GET_INFO, id),

    getSharedBuffers: (): Promise<{
      visualBuffers: SharedArrayBuffer[];
      signalBuffer: SharedArrayBuffer | null;
    }> => _unwrappingInvoke(CHANNELS.TERMINAL_GET_SHARED_BUFFERS),

    getAnalysisBuffer: (): Promise<SharedArrayBuffer | null> =>
      _unwrappingInvoke(CHANNELS.TERMINAL_GET_ANALYSIS_BUFFER),

    forceResume: (id: string): Promise<{ success: boolean; error?: string }> =>
      _unwrappingInvoke(CHANNELS.TERMINAL_FORCE_RESUME, id),

    onStatus: (callback: (data: TerminalStatusPayload) => void) =>
      _typedOn(CHANNELS.TERMINAL_STATUS, callback),

    onResourceMetrics: (
      callback: (data: { metrics: TerminalResourceBatchPayload; timestamp: number }) => void
    ) => _typedOn(CHANNELS.TERMINAL_RESOURCE_METRICS, callback),

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

    reportTitleState: (id: string, state: "working" | "waiting") =>
      ipcRenderer.send(CHANNELS.TERMINAL_AGENT_TITLE_STATE, { id, state }),

    onSpawnResult: (callback: (id: string, result: SpawnResultPayload) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, id: unknown, result: unknown) => {
        if (typeof id === "string" && typeof result === "object" && result !== null) {
          callback(id, result as SpawnResultPayload);
        }
      };
      ipcRenderer.on(CHANNELS.TERMINAL_SPAWN_RESULT, handler);
      return () => ipcRenderer.removeListener(CHANNELS.TERMINAL_SPAWN_RESULT, handler);
    },

    onReduceScrollback: (
      callback: (data: { terminalIds: string[]; targetLines: number }) => void
    ) => _typedOn(CHANNELS.TERMINAL_REDUCE_SCROLLBACK, callback),

    onRestoreScrollback: (callback: (data: { terminalIds: string[] }) => void) =>
      _typedOn(CHANNELS.TERMINAL_RESTORE_SCROLLBACK, callback),

    restartService: (): Promise<void> => _unwrappingInvoke(CHANNELS.TERMINAL_RESTART_SERVICE),

    onReclaimMemory: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(CHANNELS.WINDOW_RECLAIM_MEMORY, handler);
      return () => ipcRenderer.removeListener(CHANNELS.WINDOW_RECLAIM_MEMORY, handler);
    },
  },

  // Files API
  files: {
    search: (payload) => _unwrappingInvoke(CHANNELS.FILES_SEARCH, payload),
    read: (payload) => _unwrappingInvoke(CHANNELS.FILES_READ, payload),
  },

  // Slash Commands API
  slashCommands: {
    list: (payload) => _unwrappingInvoke(CHANNELS.SLASH_COMMANDS_LIST, payload),
  },

  // Artifact API
  artifact: {
    onDetected: (callback: (data: ArtifactDetectedPayload) => void) =>
      _typedOn(CHANNELS.ARTIFACT_DETECTED, callback),

    saveToFile: (options: SaveArtifactOptions) =>
      _unwrappingInvoke(CHANNELS.ARTIFACT_SAVE_TO_FILE, options),

    applyPatch: (options: ApplyPatchOptions) =>
      _unwrappingInvoke(CHANNELS.ARTIFACT_APPLY_PATCH, options),
  },

  // CopyTree API
  copyTree: {
    generate: (worktreeId: string, options?: CopyTreeOptions) =>
      _unwrappingInvoke(CHANNELS.COPYTREE_GENERATE, { worktreeId, options }),

    generateAndCopyFile: (worktreeId: string, options?: CopyTreeOptions) =>
      _unwrappingInvoke(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, { worktreeId, options }),

    injectToTerminal: (
      terminalId: string,
      worktreeId: string,
      options?: CopyTreeOptions,
      injectionId?: string
    ) =>
      _unwrappingInvoke(CHANNELS.COPYTREE_INJECT, { terminalId, worktreeId, options, injectionId }),

    isAvailable: () => _unwrappingInvoke(CHANNELS.COPYTREE_AVAILABLE),

    cancel: (injectionId?: string) => _unwrappingInvoke(CHANNELS.COPYTREE_CANCEL, { injectionId }),

    getFileTree: (worktreeId: string, dirPath?: string) =>
      _unwrappingInvoke(CHANNELS.COPYTREE_GET_FILE_TREE, { worktreeId, dirPath }),

    testConfig: (worktreeId: string, options?: CopyTreeOptions) =>
      _unwrappingInvoke(CHANNELS.COPYTREE_TEST_CONFIG, { worktreeId, options }),

    onProgress: (callback: (progress: CopyTreeProgress) => void) =>
      _typedOn(CHANNELS.COPYTREE_PROGRESS, callback),
  },

  // Editor API
  editor: {
    getConfig: (projectId?: string) => _unwrappingInvoke(CHANNELS.EDITOR_GET_CONFIG, projectId),

    setConfig: (payload: {
      editor: { id: string; customCommand?: string; customTemplate?: string };
      projectId?: string;
    }) =>
      _typedInvoke(
        CHANNELS.EDITOR_SET_CONFIG,
        payload as import("../shared/types/editor.js").EditorSetConfigPayload
      ),

    discover: () => _unwrappingInvoke(CHANNELS.EDITOR_DISCOVER),
  },

  // System API
  system: {
    openExternal: (url: string) => _unwrappingInvoke(CHANNELS.SYSTEM_OPEN_EXTERNAL, { url }),

    openPath: (path: string) => _unwrappingInvoke(CHANNELS.SYSTEM_OPEN_PATH, { path }),

    openInEditor: (payload: { path: string; line?: number; col?: number; projectId?: string }) =>
      _unwrappingInvoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, payload),

    checkCommand: (command: string) => _unwrappingInvoke(CHANNELS.SYSTEM_CHECK_COMMAND, command),

    checkDirectory: (path: string) => _unwrappingInvoke(CHANNELS.SYSTEM_CHECK_DIRECTORY, path),

    getHomeDir: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_HOME_DIR),

    getTmpDir: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_TMP_DIR),

    getCliAvailability: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_CLI_AVAILABILITY),

    refreshCliAvailability: () => _unwrappingInvoke(CHANNELS.SYSTEM_REFRESH_CLI_AVAILABILITY),

    getAgentVersions: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_AGENT_VERSIONS),

    refreshAgentVersions: () => _unwrappingInvoke(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS),

    getAgentUpdateSettings: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS),

    setAgentUpdateSettings: (settings: {
      autoCheck: boolean;
      checkFrequencyHours: number;
      lastAutoCheck: number | null;
    }) => _unwrappingInvoke(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS, settings),

    startAgentUpdate: (payload: { agentId: string; method?: string }) =>
      _unwrappingInvoke(CHANNELS.SYSTEM_START_AGENT_UPDATE, payload),

    healthCheck: (agentIds?: string[]) => _unwrappingInvoke(CHANNELS.SYSTEM_HEALTH_CHECK, agentIds),

    getHealthCheckSpecs: (agentIds?: string[]) =>
      _unwrappingInvoke(CHANNELS.SYSTEM_HEALTH_CHECK_SPECS, agentIds),

    checkTool: (spec: {
      tool: string;
      label: string;
      command?: string;
      versionArgs: string[];
      severity: string;
      minVersion?: string;
      installUrl?: string;
      installBlocks?: Record<string, unknown>;
    }) => _unwrappingInvoke(CHANNELS.SYSTEM_CHECK_TOOL, spec),

    downloadDiagnostics: () => _unwrappingInvoke(CHANNELS.SYSTEM_DOWNLOAD_DIAGNOSTICS),

    getAppMetrics: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_APP_METRICS),

    getHardwareInfo: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_HARDWARE_INFO),

    getProcessMetrics: () => _unwrappingInvoke(CHANNELS.DIAGNOSTICS_GET_PROCESS_METRICS),

    getHeapStats: () => _unwrappingInvoke(CHANNELS.DIAGNOSTICS_GET_HEAP_STATS),

    getDiagnosticsInfo: () => _unwrappingInvoke(CHANNELS.DIAGNOSTICS_GET_INFO),

    onWake: (callback: (data: { sleepDuration: number; timestamp: number }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sleepDuration: number; timestamp: number }
      ) => callback(data);
      ipcRenderer.on(CHANNELS.SYSTEM_WAKE, handler);
      return () => ipcRenderer.removeListener(CHANNELS.SYSTEM_WAKE, handler);
    },

    installAgent: (payload: { agentId: string; methodIndex?: number; jobId: string }) =>
      _unwrappingInvoke(CHANNELS.SETUP_AGENT_INSTALL, payload),

    onAgentInstallProgress: (
      callback: (event: { jobId: string; chunk: string; stream: "stdout" | "stderr" }) => void
    ) => _typedOn(CHANNELS.SETUP_AGENT_INSTALL_PROGRESS, callback),

    onResourceProfileChanged: (callback: (payload: ResourceProfilePayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ResourceProfilePayload) =>
        callback(payload);
      ipcRenderer.on(CHANNELS.RESOURCE_PROFILE_CHANGED, handler);
      return () => ipcRenderer.removeListener(CHANNELS.RESOURCE_PROFILE_CHANGED, handler);
    },
  },

  // App State API
  app: {
    getState: () => _unwrappingInvoke(CHANNELS.APP_GET_STATE),

    setState: (partialState: Partial<AppState>) =>
      _unwrappingInvoke(CHANNELS.APP_SET_STATE, partialState),

    getVersion: () => _unwrappingInvoke(CHANNELS.APP_GET_VERSION),

    hydrate: () => _unwrappingInvoke(CHANNELS.APP_HYDRATE),

    quit: () => _unwrappingInvoke(CHANNELS.APP_QUIT),

    forceQuit: () => _unwrappingInvoke(CHANNELS.APP_FORCE_QUIT),

    onMenuAction: (callback: (action: string) => void) => _typedOn(CHANNELS.MENU_ACTION, callback),

    reloadConfig: () => _unwrappingInvoke(CHANNELS.APP_RELOAD_CONFIG),

    onConfigReloaded: (callback: () => void) => _typedOn(CHANNELS.APP_CONFIG_RELOADED, callback),
  },

  menu: {
    showContext: (payload: ShowContextMenuPayload) =>
      _unwrappingInvoke(CHANNELS.MENU_SHOW_CONTEXT, payload),
  },

  // Logs API
  logs: {
    getAll: (filters?: LogFilterOptions) => _unwrappingInvoke(CHANNELS.LOGS_GET_ALL, filters),

    getSources: () => _unwrappingInvoke(CHANNELS.LOGS_GET_SOURCES),

    clear: () => _unwrappingInvoke(CHANNELS.LOGS_CLEAR),

    openFile: () => _unwrappingInvoke(CHANNELS.LOGS_OPEN_FILE),

    setVerbose: (enabled: boolean) => _unwrappingInvoke(CHANNELS.LOGS_SET_VERBOSE, enabled),

    getVerbose: () => _unwrappingInvoke(CHANNELS.LOGS_GET_VERBOSE),

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
    ) => _unwrappingInvoke(CHANNELS.LOGS_WRITE, { level, message, context }),
  },

  // Error API
  errors: {
    onError: (callback: (error: AppError) => void) => _typedOn(CHANNELS.ERROR_NOTIFY, callback),

    retry: (errorId: string, action: RetryAction, args?: Record<string, unknown>) =>
      _unwrappingInvoke(CHANNELS.ERROR_RETRY, { errorId, action, args }),

    cancelRetry: (errorId: string) => ipcRenderer.send(CHANNELS.ERROR_RETRY_CANCEL, errorId),

    onRetryProgress: (callback: (payload: RetryProgressPayload) => void) =>
      _typedOn(CHANNELS.ERROR_RETRY_PROGRESS, callback),

    openLogs: () => _unwrappingInvoke(CHANNELS.ERROR_OPEN_LOGS),

    getPending: () => _unwrappingInvoke(CHANNELS.ERROR_GET_PENDING),
  },

  // Event Inspector API
  eventInspector: {
    getEvents: () => _unwrappingInvoke(CHANNELS.EVENT_INSPECTOR_GET_EVENTS),

    getFiltered: (filters: EventFilterOptions) =>
      _unwrappingInvoke(CHANNELS.EVENT_INSPECTOR_GET_FILTERED, filters),

    clear: () => _unwrappingInvoke(CHANNELS.EVENT_INSPECTOR_CLEAR),

    subscribe: () => ipcRenderer.send(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE),

    unsubscribe: () => ipcRenderer.send(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE),

    onEvent: (callback: (event: EventRecord) => void) =>
      _typedOn(CHANNELS.EVENT_INSPECTOR_EVENT, callback),

    onEventBatch: (callback: (events: EventRecord[]) => void) =>
      _typedOn(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, callback),
  },

  events: {
    emit: (eventType: string, payload: unknown) =>
      _unwrappingInvoke(CHANNELS.EVENTS_EMIT, eventType, payload),
  },

  // Project API
  project: {
    getAll: () => _unwrappingInvoke(CHANNELS.PROJECT_GET_ALL),

    getCurrent: () => _unwrappingInvoke(CHANNELS.PROJECT_GET_CURRENT),

    add: (path: string) => _unwrappingInvoke(CHANNELS.PROJECT_ADD, path),

    remove: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_REMOVE, projectId),

    update: (projectId: string, updates: Partial<Project>) =>
      _unwrappingInvoke(CHANNELS.PROJECT_UPDATE, projectId, updates),

    switch: (
      projectId: string,
      outgoingState?: import("../shared/types/ipc/project.js").ProjectSwitchOutgoingState
    ) => _unwrappingInvoke(CHANNELS.PROJECT_SWITCH, projectId, outgoingState),

    openDialog: () => _unwrappingInvoke(CHANNELS.PROJECT_OPEN_DIALOG),

    onSwitch: (
      callback: (payload: {
        project: Project;
        switchId: string;
        worktreeLoadError?: string;
        hydrateResult?: import("../shared/types/ipc/app.js").HydrateResult;
      }) => void
    ) => _typedOn(CHANNELS.PROJECT_ON_SWITCH, callback),

    onUpdated: (callback: (project: Project) => void) =>
      _typedOn(CHANNELS.PROJECT_UPDATED, callback),

    onRemoved: (callback: (projectId: string) => void) =>
      _typedOn(CHANNELS.PROJECT_REMOVED, callback),

    getSettings: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_GET_SETTINGS, projectId),

    saveSettings: (projectId: string, settings: ProjectSettings) =>
      _unwrappingInvoke(CHANNELS.PROJECT_SAVE_SETTINGS, { projectId, settings }),

    detectRunners: (projectId: string) =>
      _unwrappingInvoke(CHANNELS.PROJECT_DETECT_RUNNERS, projectId),

    close: (projectId: string, options?: { killTerminals?: boolean }) =>
      _unwrappingInvoke(CHANNELS.PROJECT_CLOSE, projectId, options),

    reopen: (
      projectId: string,
      outgoingState?: import("../shared/types/ipc/project.js").ProjectSwitchOutgoingState
    ) => _unwrappingInvoke(CHANNELS.PROJECT_REOPEN, projectId, outgoingState),

    getStats: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_GET_STATS, projectId),

    getBulkStats: (projectIds: string[]) =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_BULK_STATS, projectIds),

    onStatsUpdated: (
      callback: (stats: import("../shared/types/ipc/project.js").ProjectStatusMap) => void
    ) => _typedOn(CHANNELS.PROJECT_STATS_UPDATED, callback),

    createFolder: (parentPath: string, folderName: string): Promise<string> =>
      _unwrappingInvoke(CHANNELS.PROJECT_CREATE_FOLDER, { parentPath, folderName }),

    initGit: (directoryPath: string) => _unwrappingInvoke(CHANNELS.PROJECT_INIT_GIT, directoryPath),

    initGitGuided: (options: import("../shared/types/ipc/gitInit.js").GitInitOptions) =>
      _unwrappingInvoke(CHANNELS.PROJECT_INIT_GIT_GUIDED, options),

    onInitGitProgress: (
      callback: (event: import("../shared/types/ipc/gitInit.js").GitInitProgressEvent) => void
    ) => {
      const listener = (
        _event: unknown,
        data: import("../shared/types/ipc/gitInit.js").GitInitProgressEvent
      ) => callback(data);
      ipcRenderer.on(CHANNELS.PROJECT_INIT_GIT_PROGRESS, listener);
      return () => ipcRenderer.removeListener(CHANNELS.PROJECT_INIT_GIT_PROGRESS, listener);
    },

    cloneRepo: (
      options: import("../shared/types/ipc/gitClone.js").CloneRepoOptions
    ): Promise<import("../shared/types/ipc/gitClone.js").CloneRepoResult> =>
      _unwrappingInvoke(CHANNELS.PROJECT_CLONE_REPO, options),

    onCloneProgress: (
      callback: (event: import("../shared/types/ipc/gitClone.js").CloneRepoProgressEvent) => void
    ) => {
      const listener = (
        _event: unknown,
        data: import("../shared/types/ipc/gitClone.js").CloneRepoProgressEvent
      ) => callback(data);
      ipcRenderer.on(CHANNELS.PROJECT_CLONE_PROGRESS, listener);
      return () => ipcRenderer.removeListener(CHANNELS.PROJECT_CLONE_PROGRESS, listener);
    },

    cancelClone: (): Promise<void> => _unwrappingInvoke(CHANNELS.PROJECT_CLONE_CANCEL),

    getRecipes: (projectId: string): Promise<TerminalRecipe[]> =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_RECIPES, projectId),

    saveRecipes: (projectId: string, recipes: TerminalRecipe[]): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_SAVE_RECIPES, { projectId, recipes }),

    addRecipe: (projectId: string, recipe: TerminalRecipe): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_ADD_RECIPE, { projectId, recipe }),

    updateRecipe: (
      projectId: string,
      recipeId: string,
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
    ): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_UPDATE_RECIPE, { projectId, recipeId, updates }),

    deleteRecipe: (projectId: string, recipeId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_DELETE_RECIPE, { projectId, recipeId }),

    exportRecipeToFile: (name: string, json: string): Promise<boolean> =>
      _unwrappingInvoke(CHANNELS.RECIPE_EXPORT_FILE, { name, json }),

    importRecipeFromFile: (): Promise<string | null> =>
      _unwrappingInvoke(CHANNELS.RECIPE_IMPORT_FILE),

    getInRepoRecipes: (
      projectId: string
    ): Promise<import("../shared/types/index.js").TerminalRecipe[]> =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_INREPO_RECIPES, projectId),

    syncInRepoRecipes: (
      projectId: string,
      recipes: import("../shared/types/index.js").TerminalRecipe[]
    ): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_SYNC_INREPO_RECIPES, { projectId, recipes }),

    updateInRepoRecipe: (
      projectId: string,
      recipe: import("../shared/types/index.js").TerminalRecipe,
      previousName?: string
    ): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_UPDATE_INREPO_RECIPE, {
        projectId,
        recipe,
        previousName,
      }),

    deleteInRepoRecipe: (projectId: string, recipeName: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_DELETE_INREPO_RECIPE, { projectId, recipeName }),

    getTerminals: (
      projectId: string
    ): Promise<import("../shared/types/index.js").TerminalSnapshot[]> =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_TERMINALS, projectId),

    setTerminals: (
      projectId: string,
      terminals: import("../shared/types/index.js").TerminalSnapshot[]
    ): Promise<void> => _unwrappingInvoke(CHANNELS.PROJECT_SET_TERMINALS, { projectId, terminals }),

    getTerminalSizes: (
      projectId: string
    ): Promise<Record<string, { cols: number; rows: number }>> =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_TERMINAL_SIZES, projectId),

    setTerminalSizes: (
      projectId: string,
      terminalSizes: Record<string, { cols: number; rows: number }>
    ): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_SET_TERMINAL_SIZES, { projectId, terminalSizes }),

    getDraftInputs: (projectId: string): Promise<Record<string, string>> =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_DRAFT_INPUTS, projectId),

    setDraftInputs: (projectId: string, draftInputs: Record<string, string>): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_SET_DRAFT_INPUTS, { projectId, draftInputs }),

    getTabGroups: (projectId: string): Promise<import("../shared/types/index.js").TabGroup[]> =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_TAB_GROUPS, projectId),

    setTabGroups: (
      projectId: string,
      tabGroups: import("../shared/types/index.js").TabGroup[]
    ): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_SET_TAB_GROUPS, { projectId, tabGroups }),

    getFocusMode: (
      projectId: string
    ): Promise<{
      focusMode: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    }> => _unwrappingInvoke(CHANNELS.PROJECT_GET_FOCUS_MODE, projectId),

    setFocusMode: (
      projectId: string,
      focusMode: boolean,
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean }
    ): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_SET_FOCUS_MODE, { projectId, focusMode, focusPanelState }),

    readClaudeMd: (projectId: string): Promise<string | null> =>
      _unwrappingInvoke(CHANNELS.PROJECT_READ_CLAUDE_MD, projectId),

    writeClaudeMd: (projectId: string, content: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.PROJECT_WRITE_CLAUDE_MD, { projectId, content }),

    enableInRepoSettings: (projectId: string): Promise<Project> =>
      _unwrappingInvoke(CHANNELS.PROJECT_ENABLE_IN_REPO_SETTINGS, projectId),

    disableInRepoSettings: (projectId: string): Promise<Project> =>
      _unwrappingInvoke(CHANNELS.PROJECT_DISABLE_IN_REPO_SETTINGS, projectId),

    checkMissing: (): Promise<string[]> => _unwrappingInvoke(CHANNELS.PROJECT_CHECK_MISSING),

    locate: (projectId: string): Promise<Project | null> =>
      _unwrappingInvoke(CHANNELS.PROJECT_LOCATE, projectId),
  },

  // Global Recipes API
  globalRecipes: {
    getRecipes: (): Promise<TerminalRecipe[]> => _unwrappingInvoke(CHANNELS.GLOBAL_GET_RECIPES),

    addRecipe: (recipe: TerminalRecipe): Promise<void> =>
      _unwrappingInvoke(CHANNELS.GLOBAL_ADD_RECIPE, { recipe }),

    updateRecipe: (
      recipeId: string,
      updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
    ): Promise<void> => _unwrappingInvoke(CHANNELS.GLOBAL_UPDATE_RECIPE, { recipeId, updates }),

    deleteRecipe: (recipeId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.GLOBAL_DELETE_RECIPE, { recipeId }),
  },

  // Agent Settings API
  agentSettings: {
    get: () => _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_GET),

    set: (agentId: string, settings: Partial<AgentSettingsEntry>) =>
      _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_SET, { agentType: agentId, settings }),

    reset: (agentType?: string) => _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_RESET, agentType),
  },

  userAgentRegistry: {
    get: () => _unwrappingInvoke(CHANNELS.USER_AGENT_REGISTRY_GET),

    add: (config: import("../shared/types/index.js").UserAgentConfig) =>
      _unwrappingInvoke(CHANNELS.USER_AGENT_REGISTRY_ADD, config),

    update: (id: string, config: import("../shared/types/index.js").UserAgentConfig) =>
      _unwrappingInvoke(CHANNELS.USER_AGENT_REGISTRY_UPDATE, { id, config }),

    remove: (id: string) => _unwrappingInvoke(CHANNELS.USER_AGENT_REGISTRY_REMOVE, id),
  },

  agentHelp: {
    get: (request: import("../shared/types/ipc/agent.js").AgentHelpRequest) =>
      _unwrappingInvoke(CHANNELS.AGENT_HELP_GET, request),
  },

  // GitHub API
  github: {
    getRepoStats: (cwd: string, bypassCache?: boolean) =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_REPO_STATS, cwd, bypassCache),

    getProjectHealth: (cwd: string, bypassCache?: boolean) =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_PROJECT_HEALTH, cwd, bypassCache),

    openIssues: (cwd: string, query?: string, state?: string) =>
      _unwrappingInvoke(CHANNELS.GITHUB_OPEN_ISSUES, cwd, query, state),

    openPRs: (cwd: string, query?: string, state?: string) =>
      _unwrappingInvoke(CHANNELS.GITHUB_OPEN_PRS, cwd, query, state),

    openCommits: (cwd: string, branch?: string) =>
      _unwrappingInvoke(CHANNELS.GITHUB_OPEN_COMMITS, cwd, branch),

    openIssue: (cwd: string, issueNumber: number) =>
      _unwrappingInvoke(CHANNELS.GITHUB_OPEN_ISSUE, { cwd, issueNumber }),

    openPR: (prUrl: string) => _unwrappingInvoke(CHANNELS.GITHUB_OPEN_PR, prUrl),

    checkCli: () => _unwrappingInvoke(CHANNELS.GITHUB_CHECK_CLI),

    getConfig: () => _unwrappingInvoke(CHANNELS.GITHUB_GET_CONFIG),

    setToken: (token: string) => _unwrappingInvoke(CHANNELS.GITHUB_SET_TOKEN, token),

    clearToken: () => _unwrappingInvoke(CHANNELS.GITHUB_CLEAR_TOKEN),

    validateToken: (token: string) => _unwrappingInvoke(CHANNELS.GITHUB_VALIDATE_TOKEN, token),

    listIssues: (options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "all";
      cursor?: string;
      bypassCache?: boolean;
      sortOrder?: "created" | "updated";
    }) => _unwrappingInvoke(CHANNELS.GITHUB_LIST_ISSUES, options),

    listPullRequests: (options: {
      cwd: string;
      search?: string;
      state?: "open" | "closed" | "merged" | "all";
      cursor?: string;
      bypassCache?: boolean;
      sortOrder?: "created" | "updated";
    }) => _unwrappingInvoke(CHANNELS.GITHUB_LIST_PRS, options),

    assignIssue: (cwd: string, issueNumber: number, username: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.GITHUB_ASSIGN_ISSUE, { cwd, issueNumber, username }),

    getIssueTooltip: (cwd: string, issueNumber: number) =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_ISSUE_TOOLTIP, { cwd, issueNumber }),

    getPRTooltip: (cwd: string, prNumber: number) =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_PR_TOOLTIP, { cwd, prNumber }),

    getIssueUrl: (cwd: string, issueNumber: number): Promise<string | null> =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_ISSUE_URL, { cwd, issueNumber }),

    getIssueByNumber: (cwd: string, issueNumber: number) =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_ISSUE_BY_NUMBER, { cwd, issueNumber }),

    getPRByNumber: (cwd: string, prNumber: number) =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_PR_BY_NUMBER, { cwd, prNumber }),

    listRemotes: (cwd: string) => _unwrappingInvoke(CHANNELS.GITHUB_LIST_REMOTES, cwd),

    onPRDetected: (callback: (data: PRDetectedPayload) => void) =>
      _typedOn(CHANNELS.PR_DETECTED, callback),

    onPRCleared: (callback: (data: PRClearedPayload) => void) =>
      _typedOn(CHANNELS.PR_CLEARED, callback),

    onIssueDetected: (callback: (data: IssueDetectedPayload) => void) =>
      _typedOn(CHANNELS.ISSUE_DETECTED, callback),

    onIssueNotFound: (callback: (data: IssueNotFoundPayload) => void) =>
      _typedOn(CHANNELS.ISSUE_NOT_FOUND, callback),
  },

  // Notes API
  notes: {
    create: (title: string, scope: "worktree" | "project", worktreeId?: string) =>
      _unwrappingInvoke(CHANNELS.NOTES_CREATE, title, scope, worktreeId),

    read: (notePath: string) => _unwrappingInvoke(CHANNELS.NOTES_READ, notePath),

    write: (
      notePath: string,
      content: string,
      metadata: {
        id: string;
        title: string;
        scope: "worktree" | "project";
        worktreeId?: string;
        createdAt: number;
        tags?: string[];
      },
      expectedLastModified?: number
    ) => _unwrappingInvoke(CHANNELS.NOTES_WRITE, notePath, content, metadata, expectedLastModified),

    list: () => _unwrappingInvoke(CHANNELS.NOTES_LIST),

    delete: (notePath: string) => _unwrappingInvoke(CHANNELS.NOTES_DELETE, notePath),

    search: (query: string) => _unwrappingInvoke(CHANNELS.NOTES_SEARCH, query),

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
    ensure: (request: DevPreviewEnsureRequest): Promise<DevPreviewSessionState> =>
      _unwrappingInvoke(CHANNELS.DEV_PREVIEW_ENSURE, request) as Promise<DevPreviewSessionState>,

    restart: (request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> =>
      _unwrappingInvoke(CHANNELS.DEV_PREVIEW_RESTART, request) as Promise<DevPreviewSessionState>,

    stop: (request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> =>
      _unwrappingInvoke(CHANNELS.DEV_PREVIEW_STOP, request) as Promise<DevPreviewSessionState>,

    stopByPanel: (request: DevPreviewStopByPanelRequest): Promise<void> =>
      _unwrappingInvoke(CHANNELS.DEV_PREVIEW_STOP_BY_PANEL, request) as Promise<void>,

    getState: (request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> =>
      _unwrappingInvoke(CHANNELS.DEV_PREVIEW_GET_STATE, request) as Promise<DevPreviewSessionState>,

    onStateChanged: (callback: (payload: DevPreviewStateChangedPayload) => void) =>
      _typedOn(CHANNELS.DEV_PREVIEW_STATE_CHANGED, callback),
  },

  // Git API
  git: {
    getFileDiff: (cwd: string, filePath: string, status: GitStatus) =>
      _unwrappingInvoke(CHANNELS.GIT_GET_FILE_DIFF, { cwd, filePath, status }),

    getProjectPulse: (options: {
      worktreeId: string;
      rangeDays: 60 | 120 | 180;
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    }) => _unwrappingInvoke(CHANNELS.GIT_GET_PROJECT_PULSE, options),

    listCommits: (options: {
      cwd: string;
      search?: string;
      branch?: string;
      skip?: number;
      limit?: number;
    }) => _unwrappingInvoke(CHANNELS.GIT_LIST_COMMITS, options),

    stageFile: (cwd: string, filePath: string) =>
      _unwrappingInvoke(CHANNELS.GIT_STAGE_FILE, { cwd, filePath }),

    unstageFile: (cwd: string, filePath: string) =>
      _unwrappingInvoke(CHANNELS.GIT_UNSTAGE_FILE, { cwd, filePath }),

    stageAll: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_STAGE_ALL, cwd),

    unstageAll: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_UNSTAGE_ALL, cwd),

    commit: (cwd: string, message: string) =>
      _unwrappingInvoke(CHANNELS.GIT_COMMIT, { cwd, message }),

    push: (cwd: string, setUpstream?: boolean) =>
      _unwrappingInvoke(CHANNELS.GIT_PUSH, { cwd, setUpstream }),

    getStagingStatus: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_GET_STAGING_STATUS, cwd),

    compareWorktrees: (
      cwd: string,
      branch1: string,
      branch2: string,
      filePath?: string,
      useMergeBase?: boolean
    ) =>
      _unwrappingInvoke(CHANNELS.GIT_COMPARE_WORKTREES, {
        cwd,
        branch1,
        branch2,
        filePath,
        useMergeBase,
      }),

    getUsername: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_GET_USERNAME, cwd),

    getWorkingDiff: (cwd: string, type: "unstaged" | "staged" | "head") =>
      _unwrappingInvoke(CHANNELS.GIT_GET_WORKING_DIFF, { cwd, type }),

    snapshotGet: (worktreeId: string) => _unwrappingInvoke(CHANNELS.GIT_SNAPSHOT_GET, worktreeId),

    snapshotList: () => _unwrappingInvoke(CHANNELS.GIT_SNAPSHOT_LIST),

    snapshotRevert: (worktreeId: string) =>
      _unwrappingInvoke(CHANNELS.GIT_SNAPSHOT_REVERT, worktreeId),

    snapshotDelete: (worktreeId: string) =>
      _unwrappingInvoke(CHANNELS.GIT_SNAPSHOT_DELETE, worktreeId),
  },

  // Terminal Config API
  terminalConfig: {
    get: () => _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_GET),

    setScrollback: (scrollbackLines: number) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK, scrollbackLines),

    setPerformanceMode: (performanceMode: boolean) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE, performanceMode),

    setFontSize: (fontSize: number) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE, fontSize),

    setFontFamily: (fontFamily: string) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY, fontFamily),

    setHybridInputEnabled: (enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED, enabled),

    setHybridInputAutoFocus: (enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS, enabled),

    setColorScheme: (schemeId: string) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_COLOR_SCHEME, schemeId),

    setCustomSchemes: (schemesJson: string) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_CUSTOM_SCHEMES, schemesJson),

    setRecentSchemeIds: (ids: string[]) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS, ids),

    importColorScheme: () => _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME),

    setScreenReaderMode: (mode: "auto" | "on" | "off") =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE, mode),

    setResourceMonitoring: (enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_RESOURCE_MONITORING, enabled),

    setMemoryLeakDetection: (enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION, enabled),

    setMemoryLeakAutoRestartThresholdMb: (thresholdMb: number) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART, thresholdMb),

    setCachedProjectViews: (cachedProjectViews: number) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS, cachedProjectViews),
  },

  // Accessibility API
  accessibility: {
    getEnabled: () => _unwrappingInvoke(CHANNELS.ACCESSIBILITY_GET_ENABLED),

    onSupportChanged: (callback: (data: { enabled: boolean }) => void) =>
      _typedOn(CHANNELS.ACCESSIBILITY_SUPPORT_CHANGED, callback),
  },

  // Portal API
  portal: {
    create: (payload: { tabId: string; url: string }) =>
      _unwrappingInvoke(CHANNELS.PORTAL_CREATE, payload),

    show: (payload: {
      tabId: string;
      bounds: { x: number; y: number; width: number; height: number };
    }) => _unwrappingInvoke(CHANNELS.PORTAL_SHOW, payload),

    hide: () => _unwrappingInvoke(CHANNELS.PORTAL_HIDE),

    resize: (bounds: { x: number; y: number; width: number; height: number }) =>
      _unwrappingInvoke(CHANNELS.PORTAL_RESIZE, bounds),

    closeTab: (payload: { tabId: string }) => _unwrappingInvoke(CHANNELS.PORTAL_CLOSE_TAB, payload),

    navigate: (payload: { tabId: string; url: string }) =>
      _unwrappingInvoke(CHANNELS.PORTAL_NAVIGATE, payload),

    goBack: (tabId: string) => _unwrappingInvoke(CHANNELS.PORTAL_GO_BACK, tabId),

    goForward: (tabId: string) => _unwrappingInvoke(CHANNELS.PORTAL_GO_FORWARD, tabId),

    reload: (tabId: string) => _unwrappingInvoke(CHANNELS.PORTAL_RELOAD, tabId),

    showNewTabMenu: (payload: PortalShowNewTabMenuPayload) =>
      _unwrappingInvoke(CHANNELS.PORTAL_SHOW_NEW_TAB_MENU, payload),

    onNavEvent: (callback: (data: { tabId: string; title: string; url: string }) => void) =>
      _typedOn(CHANNELS.PORTAL_NAV_EVENT, callback),

    onFocus: (callback: () => void) => _typedOn(CHANNELS.PORTAL_FOCUS, callback),

    onBlur: (callback: () => void) => _typedOn(CHANNELS.PORTAL_BLUR, callback),

    onNewTabMenuAction: (callback: (action: PortalNewTabMenuAction) => void) =>
      _typedOn(CHANNELS.PORTAL_NEW_TAB_MENU_ACTION, callback),

    onTabEvicted: (callback: (data: { tabId: string }) => void) =>
      _typedOn(CHANNELS.PORTAL_TAB_EVICTED, callback),
    onTabsEvicted: (callback: (payload: { tabIds: string[] }) => void) =>
      _typedOn(CHANNELS.PORTAL_TABS_EVICTED, callback),
  },

  // Webview API
  webview: {
    setLifecycleState: (webContentsId: number, frozen: boolean): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE, webContentsId, frozen),
    registerPanel: (webContentsId: number, panelId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_REGISTER_PANEL, { webContentsId, panelId }),
    respondToDialog: (dialogId: string, confirmed: boolean, response?: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_DIALOG_RESPONSE, { dialogId, confirmed, response }),
    onDialogRequest: (
      callback: (payload: {
        dialogId: string;
        panelId: string;
        type: "alert" | "confirm" | "prompt";
        message: string;
        defaultValue: string;
      }) => void
    ): (() => void) => _typedOn(CHANNELS.WEBVIEW_DIALOG_REQUEST, callback),
    onFindShortcut: (
      callback: (payload: { panelId: string; shortcut: "find" | "next" | "prev" | "close" }) => void
    ): (() => void) => _typedOn(CHANNELS.WEBVIEW_FIND_SHORTCUT, callback),
    onNavigationBlocked: (
      callback: (payload: { panelId: string; url: string; canOpenExternal: boolean }) => void
    ): (() => void) => _typedOn(CHANNELS.WEBVIEW_NAVIGATION_BLOCKED, callback),
    startOAuthLoopback: (
      authUrl: string,
      panelId: string,
      webContentsId: number,
      sessionStorageSnapshot?: Array<[string, string]>
    ): Promise<{ success: boolean; error?: string } | null> =>
      _unwrappingInvoke(
        CHANNELS.WEBVIEW_OAUTH_LOOPBACK,
        authUrl,
        panelId,
        webContentsId,
        sessionStorageSnapshot
      ),
    startConsoleCapture: (webContentsId: number, paneId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_START_CONSOLE_CAPTURE, webContentsId, paneId),
    stopConsoleCapture: (webContentsId: number, paneId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_STOP_CONSOLE_CAPTURE, webContentsId, paneId),
    clearConsoleCapture: (webContentsId: number, paneId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_CLEAR_CONSOLE_CAPTURE, webContentsId, paneId),
    getConsoleProperties: (webContentsId: number, objectId: string) =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES, webContentsId, objectId),
    onConsoleMessage: (
      callback: (row: import("../shared/types/ipc/webviewConsole.js").SerializedConsoleRow) => void
    ): (() => void) => _typedOn(CHANNELS.WEBVIEW_CONSOLE_MESSAGE, callback),
    onConsoleContextCleared: (
      callback: (payload: { paneId: string; navigationGeneration: number }) => void
    ): (() => void) => _typedOn(CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED, callback),
  },

  // Hibernation API
  hibernation: {
    getConfig: (): Promise<{ enabled: boolean; inactiveThresholdHours: number }> =>
      _unwrappingInvoke(CHANNELS.HIBERNATION_GET_CONFIG),

    updateConfig: (
      config: Partial<{ enabled: boolean; inactiveThresholdHours: number }>
    ): Promise<{ enabled: boolean; inactiveThresholdHours: number }> =>
      _unwrappingInvoke(CHANNELS.HIBERNATION_UPDATE_CONFIG, config),

    onProjectHibernated: (
      callback: (payload: {
        projectId: string;
        projectName: string;
        reason: "scheduled" | "memory-pressure";
        terminalsKilled: number;
        timestamp: number;
      }) => void
    ): (() => void) => _typedOn(CHANNELS.HIBERNATION_PROJECT_HIBERNATED, callback),
  },

  // Idle Terminal Notification API
  idleTerminals: {
    getConfig: (): Promise<{ enabled: boolean; thresholdMinutes: number }> =>
      _unwrappingInvoke(CHANNELS.IDLE_TERMINAL_GET_CONFIG),

    updateConfig: (
      config: Partial<{ enabled: boolean; thresholdMinutes: number }>
    ): Promise<{ enabled: boolean; thresholdMinutes: number }> =>
      _unwrappingInvoke(CHANNELS.IDLE_TERMINAL_UPDATE_CONFIG, config),

    closeProject: (projectId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.IDLE_TERMINAL_CLOSE_PROJECT, projectId),

    dismissProject: (projectId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.IDLE_TERMINAL_DISMISS_PROJECT, projectId),

    onNotify: (
      callback: (payload: {
        projects: Array<{
          projectId: string;
          projectName: string;
          terminalCount: number;
          idleMinutes: number;
        }>;
        timestamp: number;
      }) => void
    ): (() => void) => _typedOn(CHANNELS.IDLE_TERMINAL_NOTIFY, callback),
  },

  // System Sleep API
  systemSleep: {
    getMetrics: () => _unwrappingInvoke(CHANNELS.SYSTEM_SLEEP_GET_METRICS),

    getAwakeTimeSince: (startTimestamp: number) =>
      _unwrappingInvoke(CHANNELS.SYSTEM_SLEEP_GET_AWAKE_TIME, startTimestamp),

    reset: () => _unwrappingInvoke(CHANNELS.SYSTEM_SLEEP_RESET),

    onSuspend: (callback: () => void) => _typedOn(CHANNELS.SYSTEM_SLEEP_ON_SUSPEND, callback),

    onWake: (callback: (sleepDurationMs: number) => void) =>
      _typedOn(CHANNELS.SYSTEM_SLEEP_ON_WAKE, callback),
  },

  // Keybinding API
  keybinding: {
    getOverrides: () => _unwrappingInvoke(CHANNELS.KEYBINDING_GET_OVERRIDES),

    setOverride: (actionId: KeyAction, combo: string[]) =>
      _unwrappingInvoke(CHANNELS.KEYBINDING_SET_OVERRIDE, { actionId, combo }),

    removeOverride: (actionId: KeyAction) =>
      _unwrappingInvoke(CHANNELS.KEYBINDING_REMOVE_OVERRIDE, actionId),

    resetAll: () => _unwrappingInvoke(CHANNELS.KEYBINDING_RESET_ALL),

    exportProfile: () => _unwrappingInvoke(CHANNELS.KEYBINDING_EXPORT_PROFILE),

    importProfile: () => _unwrappingInvoke(CHANNELS.KEYBINDING_IMPORT_PROFILE),
  },

  // Worktree Config API
  worktreeConfig: {
    get: () => _unwrappingInvoke(CHANNELS.WORKTREE_CONFIG_GET),

    setPattern: (pattern: string) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_CONFIG_SET_PATTERN, { pattern }),
  },

  // Window API
  window: {
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) =>
        callback(isFullscreen);
      ipcRenderer.on(CHANNELS.WINDOW_FULLSCREEN_CHANGE, handler);
      return () => ipcRenderer.removeListener(CHANNELS.WINDOW_FULLSCREEN_CHANGE, handler);
    },
    toggleFullscreen: (): Promise<boolean> => _unwrappingInvoke(CHANNELS.WINDOW_TOGGLE_FULLSCREEN),
    reload: (): Promise<void> => _unwrappingInvoke(CHANNELS.WINDOW_RELOAD),
    forceReload: (): Promise<void> => _unwrappingInvoke(CHANNELS.WINDOW_FORCE_RELOAD),
    toggleDevTools: (): Promise<void> => _unwrappingInvoke(CHANNELS.WINDOW_TOGGLE_DEVTOOLS),
    zoomIn: (): Promise<void> => _unwrappingInvoke(CHANNELS.WINDOW_ZOOM_IN),
    zoomOut: (): Promise<void> => _unwrappingInvoke(CHANNELS.WINDOW_ZOOM_OUT),
    zoomReset: (): Promise<void> => _unwrappingInvoke(CHANNELS.WINDOW_ZOOM_RESET),
    getZoomFactor: (): number => webFrame.getZoomFactor(),
    close: (): Promise<void> => _unwrappingInvoke(CHANNELS.WINDOW_CLOSE),
    openNew: (projectPath?: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WINDOW_NEW, projectPath),
    onDestroyHiddenWebviews: (callback: (payload: { tier: 1 | 2 }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { tier: 1 | 2 }) =>
        callback(payload);
      ipcRenderer.on(CHANNELS.WINDOW_DESTROY_HIDDEN_WEBVIEWS, handler);
      return () => ipcRenderer.removeListener(CHANNELS.WINDOW_DESTROY_HIDDEN_WEBVIEWS, handler);
    },
    onDiskSpaceStatus: (
      callback: (payload: {
        status: "normal" | "warning" | "critical";
        availableMb: number;
        writesSuppressed: boolean;
      }) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: {
          status: "normal" | "warning" | "critical";
          availableMb: number;
          writesSuppressed: boolean;
        }
      ) => callback(payload);
      ipcRenderer.on(CHANNELS.WINDOW_DISK_SPACE_STATUS, handler);
      return () => ipcRenderer.removeListener(CHANNELS.WINDOW_DISK_SPACE_STATUS, handler);
    },
  },

  // Recovery API (used by recovery.html)
  recovery: {
    reloadApp: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_RELOAD_APP),
    resetAndReload: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_RESET_AND_RELOAD),
  },

  // Notification API
  notification: {
    updateBadge: (state: { waitingCount: number }) =>
      ipcRenderer.send(CHANNELS.NOTIFICATION_UPDATE, state),
    getSettings: (): Promise<{
      enabled: boolean;
      completedEnabled: boolean;
      waitingEnabled: boolean;
      soundEnabled: boolean;
      completedSoundFile: string;
      waitingSoundFile: string;
      escalationSoundFile: string;
      waitingEscalationEnabled: boolean;
      waitingEscalationDelayMs: number;
      workingPulseEnabled: boolean;
      workingPulseSoundFile: string;
      uiFeedbackSoundEnabled: boolean;
    }> => _unwrappingInvoke(CHANNELS.NOTIFICATION_SETTINGS_GET),
    setSettings: (
      settings: Partial<{
        enabled: boolean;
        completedEnabled: boolean;
        waitingEnabled: boolean;
        soundEnabled: boolean;
        completedSoundFile: string;
        waitingSoundFile: string;
        escalationSoundFile: string;
        waitingEscalationEnabled: boolean;
        waitingEscalationDelayMs: number;
        workingPulseEnabled: boolean;
        workingPulseSoundFile: string;
        uiFeedbackSoundEnabled: boolean;
      }>
    ) => _unwrappingInvoke(CHANNELS.NOTIFICATION_SETTINGS_SET, settings),
    playSound: (soundFile: string) =>
      _unwrappingInvoke(CHANNELS.NOTIFICATION_PLAY_SOUND, soundFile),
    playUiEvent: (soundId: string) => _unwrappingInvoke(CHANNELS.SOUND_PLAY_UI_EVENT, soundId),
    showNative: (payload: { title: string; body: string }) =>
      ipcRenderer.send(CHANNELS.NOTIFICATION_SHOW_NATIVE, payload),
    showWatchNotification: (payload: {
      title: string;
      body: string;
      panelId: string;
      panelTitle: string;
      worktreeId?: string;
    }) => ipcRenderer.send(CHANNELS.NOTIFICATION_SHOW_WATCH, payload),
    onWatchNavigate: (
      callback: (context: { panelId: string; panelTitle: string; worktreeId?: string }) => void
    ) => _typedOn(CHANNELS.NOTIFICATION_WATCH_NAVIGATE, callback),
    syncWatchedPanels: (panelIds: string[]) =>
      ipcRenderer.send(CHANNELS.NOTIFICATION_SYNC_WATCHED, panelIds),
    acknowledgeWaiting: (terminalId: string) =>
      ipcRenderer.send(CHANNELS.NOTIFICATION_WAITING_ACKNOWLEDGE, { terminalId }),
    acknowledgeWorkingPulse: (terminalId: string) =>
      ipcRenderer.send(CHANNELS.NOTIFICATION_WORKING_PULSE_ACKNOWLEDGE, { terminalId }),
    onShowToast: (
      callback: (payload: {
        type: "success" | "error" | "info" | "warning";
        title?: string;
        message: string;
        action?: { label: string; ipcChannel: string };
      }) => void
    ) => _typedOn(CHANNELS.NOTIFICATION_SHOW_TOAST, callback),
  },

  // Sound API (Web Audio playback via main → renderer push)
  sound: {
    onTrigger: (callback: (payload: { soundFile: string }) => void) =>
      _typedOn(CHANNELS.SOUND_TRIGGER, callback),
    onCancel: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(CHANNELS.SOUND_CANCEL, handler);
      return () => ipcRenderer.removeListener(CHANNELS.SOUND_CANCEL, handler);
    },
    getSoundDir: (): Promise<string> => _unwrappingInvoke(CHANNELS.SOUND_GET_DIR),
  },

  // Auto-Update API
  update: {
    onUpdateAvailable: (callback: (info: { version: string }) => void) =>
      _typedOn(CHANNELS.UPDATE_AVAILABLE, callback),

    onDownloadProgress: (callback: (info: { percent: number }) => void) =>
      _typedOn(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, callback),

    onUpdateDownloaded: (callback: (info: { version: string }) => void) =>
      _typedOn(CHANNELS.UPDATE_DOWNLOADED, callback),

    quitAndInstall: () => _unwrappingInvoke(CHANNELS.UPDATE_QUIT_AND_INSTALL),

    checkForUpdates: () => _unwrappingInvoke(CHANNELS.UPDATE_CHECK_FOR_UPDATES),

    getChannel: () => _unwrappingInvoke(CHANNELS.UPDATE_GET_CHANNEL),

    setChannel: (channel: "stable" | "nightly") =>
      _unwrappingInvoke(CHANNELS.UPDATE_SET_CHANNEL, channel),
  },

  // Gemini API
  gemini: {
    getStatus: () => _unwrappingInvoke(CHANNELS.GEMINI_GET_STATUS),

    enableAlternateBuffer: () => _unwrappingInvoke(CHANNELS.GEMINI_ENABLE_ALTERNATE_BUFFER),
  },

  // Commands API
  commands: {
    list: (context?: {
      terminalId?: string;
      worktreeId?: string;
      projectId?: string;
      cwd?: string;
      agentId?: string;
    }) => _unwrappingInvoke(CHANNELS.COMMANDS_LIST, context),

    get: (payload: {
      commandId: string;
      context?: {
        terminalId?: string;
        worktreeId?: string;
        projectId?: string;
        cwd?: string;
        agentId?: string;
      };
    }) => _unwrappingInvoke(CHANNELS.COMMANDS_GET, payload),

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
    }) => _unwrappingInvoke(CHANNELS.COMMANDS_EXECUTE, payload),

    getBuilder: (commandId: string) => _unwrappingInvoke(CHANNELS.COMMANDS_GET_BUILDER, commandId),
  },

  // App Agent API - Configuration and API key management
  appAgent: {
    getConfig: () => _unwrappingInvoke(CHANNELS.APP_AGENT_GET_CONFIG),

    setConfig: (config: { provider?: string; model?: string; apiKey?: string; baseUrl?: string }) =>
      _unwrappingInvoke(CHANNELS.APP_AGENT_SET_CONFIG, config),

    hasApiKey: () => _unwrappingInvoke(CHANNELS.APP_AGENT_HAS_API_KEY),

    testApiKey: (apiKey: string) => _unwrappingInvoke(CHANNELS.APP_AGENT_TEST_API_KEY, apiKey),

    testModel: (model: string) => _unwrappingInvoke(CHANNELS.APP_AGENT_TEST_MODEL, model),

    // Listen for action dispatch requests from main process
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
        confirmed?: boolean;
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
          confirmed?: boolean;
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

    // Listen for action confirmation requests from main process
    onConfirmationRequest: (
      callback: (payload: {
        requestId: string;
        actionId: string;
        actionName?: string;
        args?: Record<string, unknown>;
        danger: "safe" | "confirm" | "restricted";
      }) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: {
          requestId: string;
          actionId: string;
          actionName?: string;
          args?: Record<string, unknown>;
          danger: "safe" | "confirm" | "restricted";
        }
      ) => callback(payload);
      ipcRenderer.on("app-agent:confirmation-request", handler);
      return () => ipcRenderer.removeListener("app-agent:confirmation-request", handler);
    },

    // Send confirmation response back to main process
    sendConfirmationResponse: (payload: { requestId: string; approved: boolean }) =>
      ipcRenderer.send("app-agent:confirmation-response", payload),
  },

  // Agent Capabilities API
  agentCapabilities: {
    getRegistry: () => _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_GET_REGISTRY),

    getAgentIds: () => _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_IDS),

    getAgentMetadata: (agentId: string) =>
      _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_METADATA, agentId),

    isAgentEnabled: (agentId: string) =>
      _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_IS_AGENT_ENABLED, agentId),
  },

  // Agent Session History API
  agentSessionHistory: {
    list: (worktreeId?: string) => _unwrappingInvoke(CHANNELS.AGENT_SESSION_LIST, { worktreeId }),
    clear: (worktreeId?: string) => _unwrappingInvoke(CHANNELS.AGENT_SESSION_CLEAR, { worktreeId }),
  },

  // Clipboard API
  clipboard: {
    saveImage: () => _unwrappingInvoke(CHANNELS.CLIPBOARD_SAVE_IMAGE),
    thumbnailFromPath: (filePath: string) =>
      _unwrappingInvoke(CHANNELS.CLIPBOARD_THUMBNAIL_FROM_PATH, filePath),
    writeImage: (pngData: Uint8Array) => _unwrappingInvoke(CHANNELS.CLIPBOARD_WRITE_IMAGE, pngData),
  },

  // Web Utils API
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },

  appTheme: {
    get: () => _unwrappingInvoke(CHANNELS.APP_THEME_GET),

    setColorScheme: (schemeId: string) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_COLOR_SCHEME, schemeId),

    setCustomSchemes: (schemesJson: string) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_CUSTOM_SCHEMES, schemesJson),

    importTheme: () => _unwrappingInvoke(CHANNELS.APP_THEME_IMPORT),

    exportTheme: (scheme: AppColorScheme) => _unwrappingInvoke(CHANNELS.APP_THEME_EXPORT, scheme),

    setColorVisionMode: (mode: ColorVisionMode) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_COLOR_VISION_MODE, mode),

    setFollowSystem: (enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_FOLLOW_SYSTEM, enabled),

    setPreferredDarkScheme: (schemeId: string) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_PREFERRED_DARK_SCHEME, schemeId),

    setPreferredLightScheme: (schemeId: string) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_PREFERRED_LIGHT_SCHEME, schemeId),

    setRecentSchemeIds: (ids: string[]) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_RECENT_SCHEME_IDS, ids),

    onSystemAppearanceChanged: (
      callback: (payload: { isDark: boolean; schemeId: string }) => void
    ) => _typedOn(CHANNELS.APP_THEME_SYSTEM_APPEARANCE_CHANGED, callback),
  },

  telemetry: {
    get: () => _unwrappingInvoke(CHANNELS.TELEMETRY_GET),
    setEnabled: (enabled: boolean) => _unwrappingInvoke(CHANNELS.TELEMETRY_SET_ENABLED, enabled),
    markPromptShown: () => _unwrappingInvoke(CHANNELS.TELEMETRY_MARK_PROMPT_SHOWN),
    track: (event: string, properties: Record<string, unknown>) =>
      _unwrappingInvoke(CHANNELS.TELEMETRY_TRACK, event, properties),
  },

  gpu: {
    getStatus: () => _unwrappingInvoke(CHANNELS.GPU_GET_STATUS),
    setHardwareAcceleration: (enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.GPU_SET_HARDWARE_ACCELERATION, enabled),
  },

  privacy: {
    getSettings: () => _unwrappingInvoke(CHANNELS.PRIVACY_GET_SETTINGS),
    setTelemetryLevel: (level: "off" | "errors" | "full") =>
      _unwrappingInvoke(CHANNELS.PRIVACY_SET_TELEMETRY_LEVEL, level),
    setLogRetention: (days: 7 | 30 | 90 | 0) =>
      _unwrappingInvoke(CHANNELS.PRIVACY_SET_LOG_RETENTION, days),
    openDataFolder: () => _unwrappingInvoke(CHANNELS.PRIVACY_OPEN_DATA_FOLDER),
    clearCache: () => _unwrappingInvoke(CHANNELS.PRIVACY_CLEAR_CACHE),
    resetAllData: () => _unwrappingInvoke(CHANNELS.PRIVACY_RESET_ALL_DATA),
    getDataFolderPath: () => _unwrappingInvoke(CHANNELS.PRIVACY_GET_DATA_FOLDER_PATH),
  },

  onboarding: {
    get: () => _unwrappingInvoke(CHANNELS.ONBOARDING_GET),
    migrate: (payload: {
      agentSelectionDismissed: boolean;
      agentSetupComplete: boolean;
      firstRunToastSeen: boolean;
    }) => _unwrappingInvoke(CHANNELS.ONBOARDING_MIGRATE, payload),
    setStep: (step: string | null | { step: string | null; agentSetupIds?: string[] }) =>
      _unwrappingInvoke(CHANNELS.ONBOARDING_SET_STEP, step),
    complete: () => _unwrappingInvoke(CHANNELS.ONBOARDING_COMPLETE),
    markToastSeen: () => _unwrappingInvoke(CHANNELS.ONBOARDING_MARK_TOAST_SEEN),
    markNewsletterSeen: () => _unwrappingInvoke(CHANNELS.ONBOARDING_MARK_NEWSLETTER_SEEN),
    markWaitingNudgeSeen: () => _unwrappingInvoke(CHANNELS.ONBOARDING_MARK_WAITING_NUDGE_SEEN),
    getChecklist: () => _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_GET),
    dismissChecklist: () => _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_DISMISS),
    markChecklistItem: (item: ChecklistItemId) =>
      _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_MARK_ITEM, item),
    markChecklistCelebrationShown: () =>
      _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN),
  },

  milestones: {
    get: () => _unwrappingInvoke(CHANNELS.MILESTONES_GET),
    markShown: (id: string) => _unwrappingInvoke(CHANNELS.MILESTONES_MARK_SHOWN, id),
  },

  shortcutHints: {
    getCounts: () => _unwrappingInvoke(CHANNELS.SHORTCUT_HINTS_GET_COUNTS),
    incrementCount: (actionId: string) =>
      _unwrappingInvoke(CHANNELS.SHORTCUT_HINTS_INCREMENT_COUNT, actionId),
  },

  // Voice Input API
  voiceInput: {
    getSettings: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_GET_SETTINGS),
    setSettings: (
      patch: Partial<{
        enabled: boolean;
        deepgramApiKey: string;
        correctionApiKey: string;
        language: string;
        customDictionary: string[];
        transcriptionModel: "nova-3" | "nova-2";
        correctionEnabled: boolean;
        correctionModel: "gpt-5-nano" | "gpt-5-mini";
        correctionCustomInstructions: string;
        paragraphingStrategy: "spoken-command" | "manual";
        resolveFileLinks: boolean;
      }>
    ) => _unwrappingInvoke(CHANNELS.VOICE_INPUT_SET_SETTINGS, patch),
    start: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_START),
    stop: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_STOP),
    flushParagraph: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_FLUSH_PARAGRAPH),
    sendAudioChunk: (chunk: ArrayBuffer) =>
      ipcRenderer.send(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, chunk),
    onTranscriptionDelta: (callback: (delta: string) => void) =>
      _typedOn(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, callback),
    onTranscriptionComplete: (
      callback: (payload: { text: string; willCorrect: boolean }) => void
    ) => _typedOn(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, callback),
    onCorrectionQueued: (callback: (payload: { correctionId: string; rawText: string }) => void) =>
      _typedOn(CHANNELS.VOICE_INPUT_CORRECTION_QUEUED, callback),
    onCorrectionReplace: (
      callback: (payload: { correctionId: string; correctedText: string }) => void
    ) => _typedOn(CHANNELS.VOICE_INPUT_CORRECTION_REPLACE, callback),
    onParagraphBoundary: (
      callback: (payload: { rawText: string | null; correctionId: string | null }) => void
    ) => _typedOn(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, callback),
    onError: (callback: (error: string) => void) => _typedOn(CHANNELS.VOICE_INPUT_ERROR, callback),
    onStatus: (callback: (status: VoiceInputStatus) => void) =>
      _typedOn(CHANNELS.VOICE_INPUT_STATUS, callback),
    checkMicPermission: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION),
    requestMicPermission: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION),
    openMicSettings: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS),
    validateApiKey: (apiKey: string) =>
      _unwrappingInvoke(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY, apiKey),
    validateCorrectionApiKey: (apiKey: string) =>
      _unwrappingInvoke(CHANNELS.VOICE_INPUT_VALIDATE_CORRECTION_API_KEY, apiKey),
    onFileTokenResolved: (
      callback: (payload: { description: string; replacement: string; resolved: boolean }) => void
    ) => _typedOn(CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED, callback),
  },

  mcpServer: {
    getStatus: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_GET_STATUS),
    setEnabled: (enabled: boolean) => _unwrappingInvoke(CHANNELS.MCP_SERVER_SET_ENABLED, enabled),
    setPort: (port: number | null) => _unwrappingInvoke(CHANNELS.MCP_SERVER_SET_PORT, port),
    setApiKey: (apiKey: string) => _unwrappingInvoke(CHANNELS.MCP_SERVER_SET_API_KEY, apiKey),
    generateApiKey: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_GENERATE_API_KEY),
    getConfigSnippet: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_GET_CONFIG_SNIPPET),
  },

  mcpBridge: {
    onGetManifestRequest: (callback: (requestId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { requestId: string }) =>
        callback(payload.requestId);
      ipcRenderer.on("mcp:get-manifest-request", handler);
      return () => ipcRenderer.removeListener("mcp:get-manifest-request", handler);
    },

    sendGetManifestResponse: (requestId: string, manifest: unknown) => {
      ipcRenderer.send("mcp:get-manifest-response", { requestId, manifest });
    },

    onDispatchActionRequest: (
      callback: (payload: {
        requestId: string;
        actionId: string;
        args?: unknown;
        confirmed?: boolean;
      }) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { requestId: string; actionId: string; args?: unknown; confirmed?: boolean }
      ) => callback(payload);
      ipcRenderer.on("mcp:dispatch-action-request", handler);
      return () => ipcRenderer.removeListener("mcp:dispatch-action-request", handler);
    },

    sendDispatchActionResponse: (payload: { requestId: string; result: unknown }) => {
      ipcRenderer.send("mcp:dispatch-action-response", payload);
    },
  },

  plugin: {
    list: () => _unwrappingInvoke(CHANNELS.PLUGIN_LIST),

    invoke: (pluginId: string, channel: string, ...args: unknown[]) =>
      _unwrappingInvoke(CHANNELS.PLUGIN_INVOKE, pluginId, channel, ...args),

    on: (pluginId: string, channel: string, callback: (payload: unknown) => void) => {
      const fullChannel = `plugin:${pluginId}:${channel}`;
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on(fullChannel, handler);
      return () => {
        ipcRenderer.removeListener(fullChannel, handler);
      };
    },

    toolbarButtons: () => _unwrappingInvoke(CHANNELS.PLUGIN_TOOLBAR_BUTTONS),
    menuItems: () => _unwrappingInvoke(CHANNELS.PLUGIN_MENU_ITEMS),
  },

  crashRecovery: {
    getPending: () => _unwrappingInvoke(CHANNELS.CRASH_RECOVERY_GET_PENDING),
    resolve: (action: { kind: "restore"; panelIds: string[] } | { kind: "fresh" }) =>
      _unwrappingInvoke(CHANNELS.CRASH_RECOVERY_RESOLVE, action),
    getConfig: () => _unwrappingInvoke(CHANNELS.CRASH_RECOVERY_GET_CONFIG),
    setConfig: (config: { autoRestoreOnCrash?: boolean }) =>
      _unwrappingInvoke(CHANNELS.CRASH_RECOVERY_SET_CONFIG, config),
  },

  // Help workspace API
  help: {
    getFolderPath: () => _unwrappingInvoke(CHANNELS.HELP_GET_FOLDER_PATH),
    markTerminal: (terminalId: string) =>
      _unwrappingInvoke(CHANNELS.HELP_MARK_TERMINAL, terminalId),
    unmarkTerminal: (terminalId: string) =>
      _unwrappingInvoke(CHANNELS.HELP_UNMARK_TERMINAL, terminalId),
  },

  perf: {
    flushMarks: (payload: {
      marks: Array<{
        mark: string;
        timestamp: string;
        elapsedMs: number;
        meta?: Record<string, unknown>;
      }>;
      rendererTimeOrigin: number;
      rendererT0: number;
    }) => ipcRenderer.send(CHANNELS.PERF_FLUSH_RENDERER_MARKS, payload),
  },

  ...(isDemoMode
    ? {
        demo: {
          moveTo: (x: number, y: number, durationMs?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_MOVE_TO, { x, y, durationMs }),
          moveToSelector: (
            selector: string,
            durationMs?: number,
            offsetX?: number,
            offsetY?: number
          ) =>
            _unwrappingInvoke(CHANNELS.DEMO_MOVE_TO_SELECTOR, {
              selector,
              durationMs,
              offsetX,
              offsetY,
            }),
          click: () => _unwrappingInvoke(CHANNELS.DEMO_CLICK),
          type: (selector: string, text: string, cps?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_TYPE, { selector, text, cps }),
          setZoom: (factor: number, durationMs?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_SET_ZOOM, { factor, durationMs }),
          screenshot: () => _unwrappingInvoke(CHANNELS.DEMO_SCREENSHOT),
          waitForSelector: (selector: string, timeoutMs?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_WAIT_FOR_SELECTOR, { selector, timeoutMs }),
          pause: () => _unwrappingInvoke(CHANNELS.DEMO_PAUSE),
          resume: () => _unwrappingInvoke(CHANNELS.DEMO_RESUME),
          sleep: (durationMs: number) => _unwrappingInvoke(CHANNELS.DEMO_SLEEP, { durationMs }),
          startCapture: (payload: {
            fps?: number;
            maxFrames?: number;
            outputPath: string;
            preset: import("../shared/types/ipc/demo.js").DemoEncodePreset;
          }) => _unwrappingInvoke(CHANNELS.DEMO_START_CAPTURE, payload),
          stopCapture: () => _unwrappingInvoke(CHANNELS.DEMO_STOP_CAPTURE),
          getCaptureStatus: () => _unwrappingInvoke(CHANNELS.DEMO_GET_CAPTURE_STATUS),
          scroll: (selector: string) => _unwrappingInvoke(CHANNELS.DEMO_SCROLL, { selector }),
          drag: (fromSelector: string, toSelector: string, durationMs?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_DRAG, { fromSelector, toSelector, durationMs }),
          pressKey: (
            key: string,
            code?: string,
            modifiers?: Array<"mod" | "ctrl" | "shift" | "alt" | "meta">,
            selector?: string
          ) => _unwrappingInvoke(CHANNELS.DEMO_PRESS_KEY, { key, code, modifiers, selector }),
          spotlight: (selector: string, padding?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_SPOTLIGHT, { selector, padding }),
          dismissSpotlight: () => _unwrappingInvoke(CHANNELS.DEMO_DISMISS_SPOTLIGHT),
          annotate: (
            selector: string,
            text: string,
            position?: "top" | "bottom" | "left" | "right",
            id?: string
          ) =>
            _unwrappingInvoke(CHANNELS.DEMO_ANNOTATE, {
              selector,
              text,
              position,
              id,
            }),
          dismissAnnotation: (id?: string) =>
            _unwrappingInvoke(CHANNELS.DEMO_DISMISS_ANNOTATION, { id }),
          waitForIdle: (settleMs?: number, timeoutMs?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_WAIT_FOR_IDLE, { settleMs, timeoutMs }),
          encode: (payload: import("../shared/types/ipc/demo.js").DemoEncodePayload) =>
            _unwrappingInvoke(CHANNELS.DEMO_ENCODE, payload),
          onEncodeProgress: (
            callback: (event: import("../shared/types/ipc/demo.js").DemoEncodeProgressEvent) => void
          ) => _typedOn(CHANNELS.DEMO_ENCODE_PROGRESS, callback),
          onExecCommand: (
            channel: string,
            callback: (payload: Record<string, unknown>) => void
          ): (() => void) => {
            const handler = (_event: Electron.IpcRendererEvent, payload: Record<string, unknown>) =>
              callback(payload);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
          },
          sendCommandDone: (requestId: string, error?: string) => {
            ipcRenderer.send(CHANNELS.DEMO_COMMAND_DONE, { requestId, error });
          },
          getZoomFactor: () => webFrame.getZoomFactor(),
          setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),
        },
      }
    : {}),
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

// Private listener: reclaim renderer memory when notified by the main process.
// Not exposed through window.electron — this is an internal optimization.
ipcRenderer.on(CHANNELS.WINDOW_RECLAIM_MEMORY, () => {
  webFrame.clearCache();
  (globalThis as unknown as { gc?: () => void }).gc?.();
});

// E2E test bridge: expose renderer-side IPC listener introspection in fault mode.
// Gated by CANOPY_E2E_FAULT_MODE to avoid production surface area.
if (process.env.CANOPY_E2E_FAULT_MODE === "1") {
  contextBridge.exposeInMainWorld("__CANOPY_E2E_IPC__", {
    getRendererListenerCount: (channel: string) => ipcRenderer.listenerCount(channel),
  });
}

// Generic e2e-mode flag — set whenever the test harness launches Canopy.
// Used by the renderer to suppress side effects (like the auto-launched
// primary agent at the end of onboarding) that would otherwise pollute
// panel-count assertions in tests.
if (process.env.CANOPY_E2E_MODE === "1") {
  contextBridge.exposeInMainWorld("__CANOPY_E2E_MODE__", true);
}
