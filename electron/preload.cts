/**
 * Built separately as CommonJS for Electron's preload. The preload is bundled
 * by esbuild (see `scripts/build-main.mjs`), so it can safely `import` from
 * `electron/ipc/**` — esbuild inlines the referenced modules into the preload
 * bundle. `electron` and native modules are kept external.
 *
 * Channel strings come from a single source: `./ipc/channels.ts`. Per-namespace
 * preload bindings are produced by {@link IpcNamespace.preloadBindings} from
 * their declare-once definitions.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { isTrustedRendererUrl } from "../shared/utils/trustedRenderer.js";
import { isIpcEnvelope } from "../shared/types/ipc/errors.js";
import { deserializeError } from "../shared/utils/ipcErrorSerialization.js";
import type { AppErrorCode } from "../shared/types/appError.js";
import type { McpRuntimeSnapshot } from "../shared/types/ipc/mcpServer.js";
import { CHANNELS } from "./ipc/channels.js";
import { buildClipboardPreloadBindings } from "./ipc/handlers/clipboard.preload.js";
import { buildSlashCommandsPreloadBindings } from "./ipc/handlers/slashCommands.preload.js";
import { buildGlobalEnvPreloadBindings } from "./ipc/handlers/globalEnv.preload.js";
import { buildAccessibilityPreloadBindings } from "./ipc/handlers/accessibility.preload.js";
import { buildHelpPreloadBindings } from "./ipc/handlers/help.preload.js";

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
  ErrorRecord,
  ElectronAPI,
  CreateWorktreeOptions,
  IpcInvokeMap,
  IpcEventMap,
  IpcEventBusMap,
  EventBusEnvelope,
  AgentSettingsEntry,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
  GitHubRateLimitPayload,
  GitHubTokenHealthPayload,
  RepoStatsAndPagePayload,
  ServiceConnectivityPayload,
  ServiceConnectivitySnapshot,
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
  WorktreePortAction,
  WorktreePortPayload,
  WorktreePortRequestArgs,
  WorktreePortResult,
} from "../shared/types/worktree-port.js";
import type {
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  AgentFallbackTriggeredPayload,
  ArtifactDetectedPayload,
  SaveArtifactOptions,
  ApplyPatchOptions,
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewSessionState,
  DevPreviewStateChangedPayload,
  DevPreviewGetByWorktreeRequest,
} from "../shared/types/ipc.js";
import type { TerminalActivityPayload } from "../shared/types/terminal.js";
import type {
  TerminalStatusPayload,
  SpawnResult,
  TerminalResourceBatchPayload,
  BroadcastWriteResultPayload,
} from "../shared/types/pty-host.js";

type SpawnResultPayload = SpawnResult;
import type {
  PortalNewTabMenuAction,
  PortalShowNewTabMenuPayload,
} from "../shared/types/portal.js";
import type { ShowContextMenuPayload } from "../shared/types/menu.js";
import type { ResourceProfilePayload } from "../shared/types/resourceProfile.js";
import type { PluginActionDescriptor } from "../shared/types/plugin.js";
import type { PanelKindConfig } from "../shared/config/panelKindRegistry.js";

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
        ipcRenderer.emit(CHANNELS.EVENTS_PUSH, fakeEvent, {
          name: "worktree:update",
          payload: { worktree: data.worktree },
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
  private disconnectedCallbacks: Array<() => void> = [];
  private fatalCallbacks: Array<() => void> = [];
  private _isReady = false;
  // Monotonic counter so stale close signals (e.g. a delayed IPC
  // WORKTREE_HOST_DISCONNECTED that arrives AFTER a replacement port has
  // already been attached) are ignored and do not clobber the new port.
  private portGeneration = 0;

  attach(newPort: MessagePort): void {
    // Bump generation FIRST so any synchronous close event fired by the old
    // port during detach() will be recognised as stale by _handlePortClose
    // and ignored — the disconnect callbacks must only fire on unexpected
    // host crashes, never on normal port replacement.
    const attachedGeneration = ++this.portGeneration;

    if (this.port) {
      this.detach();
    }

    this.port = newPort;
    this._isReady = true;

    // Fires when the peer (workspace host UtilityProcess) dies — Electron's
    // MessagePort delivers a `close` event even on SIGKILL via the Mojo
    // channel.  The generation guard ensures stale close events from old
    // ports cannot reject requests on a newer port.
    newPort.addEventListener("close", () => this._handlePortClose(attachedGeneration));

    this.port.onmessage = (msg: MessageEvent) => {
      const data = msg.data;
      if (!data) return;

      // Response to a request
      if (data.id && this.pending.has(data.id)) {
        const entry = this.pending.get(data.id)!;
        clearTimeout(entry.timeout);
        this.pending.delete(data.id);

        if (data.error != null) {
          entry.reject(new Error(String(data.error)));
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

  /**
   * Handle unexpected port closure (workspace host crashed or was killed).
   * Idempotent — safe to call multiple times.  Rejects pending requests
   * immediately so the UI does not wait for per-request timeouts.
   *
   * @param generation The port generation the caller was registered against.
   *   If it no longer matches the current generation, this is a stale signal
   *   from a previous port lifetime and is ignored.
   */
  _handlePortClose(generation: number): void {
    if (generation !== this.portGeneration) return;
    if (!this.port) return;

    try {
      this.port.close();
    } catch {
      // ignore
    }

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Worktree port disconnected"));
    }
    this.pending.clear();

    this.port = null;
    this._isReady = false;

    for (const cb of this.disconnectedCallbacks) {
      try {
        cb();
      } catch {
        // Don't let listener errors block other listeners
      }
    }
  }

  request<K extends WorktreePortAction>(
    action: K,
    payload?: WorktreePortPayload<K>,
    timeoutMs = 10000
  ): Promise<WorktreePortResult<K>> {
    return new Promise<WorktreePortResult<K>>((resolve, reject) => {
      if (!this.port) {
        reject(new Error("Worktree port not ready"));
        return;
      }

      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Worktree port request timed out: ${String(action)}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      try {
        this.port.postMessage({ id, action, payload: payload ?? {} });
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

  onDisconnected(callback: () => void): () => void {
    this.disconnectedCallbacks.push(callback);
    return () => {
      const idx = this.disconnectedCallbacks.indexOf(callback);
      if (idx >= 0) this.disconnectedCallbacks.splice(idx, 1);
    };
  }

  onFatalDisconnect(callback: () => void): () => void {
    this.fatalCallbacks.push(callback);
    return () => {
      const idx = this.fatalCallbacks.indexOf(callback);
      if (idx >= 0) this.fatalCallbacks.splice(idx, 1);
    };
  }

  /**
   * Fire fatal callbacks when the workspace host exhausts its restart budget.
   * Callers should surface a terminal error state (e.g. "Workspace host
   * crashed — please restart") since no further port will arrive.
   */
  _handleFatal(): void {
    for (const cb of this.fatalCallbacks) {
      try {
        cb();
      } catch {
        // Don't let listener errors block other listeners
      }
    }
  }
}

const worktreePortClient = new WorktreePortClient();

ipcRenderer.on("worktree-port", (event: Electron.IpcRendererEvent) => {
  if (!event.ports || event.ports.length === 0) return;
  worktreePortClient.attach(event.ports[0]);
});

// Main broadcasts this on every host exit.  Only the fatal payload is acted
// on in the renderer — it marks max-restart-budget exhaustion and means no
// replacement port will arrive, so the UI must transition to a terminal
// error state instead of staying in the reconnecting spinner forever.
// Non-fatal broadcasts are ignored here; the MessagePort `close` event is
// the authoritative disconnect signal for the transient case.
ipcRenderer.on(
  "worktree:host-disconnected",
  (_event: Electron.IpcRendererEvent, payload: { fatal?: boolean } | undefined) => {
    if (payload?.fatal) {
      worktreePortClient._handleFatal();
    }
  }
);

/**
 * Reconstruct `AppError` thrown in the main process. Electron's contextBridge
 * deep-clones Error instances when they cross the preload→renderer realm
 * boundary and strips ALL custom properties — including own `name` and any
 * added fields like `code`. Only `message` and `stack` survive. The encoded
 * prefix below is decoded by the renderer-side `isClientAppError` guard
 * (`src/utils/clientAppError.ts`), which restores `e.name`, `e.code`,
 * `e.userMessage`, and the cleaned `e.message` on the caught error.
 *
 * Format: `[AppError|<code>] <original message>`
 *      or `[AppError|<code>|<urlencoded userMessage>] <original message>`
 */
function _reconstructAppError(serialized: {
  name: string;
  message: string;
  code?: string;
  userMessage?: string;
}): Error {
  const code = serialized.code ?? "UNKNOWN";
  const userMsgPart =
    serialized.userMessage !== undefined ? `|${encodeURIComponent(serialized.userMessage)}` : "";
  const encoded = `[AppError|${code}${userMsgPart}] ${serialized.message}`;
  const error = new Error(encoded);
  // Standard properties — set for callers in the same realm. They don't
  // survive the contextBridge crossing; the message prefix is the source
  // of truth on the renderer side.
  error.name = "AppError";
  (error as Error & { code: AppErrorCode }).code = serialized.code as AppErrorCode;
  if (serialized.userMessage !== undefined) {
    (error as Error & { userMessage: string }).userMessage = serialized.userMessage;
  }
  return error;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches ipcRenderer.invoke return type
async function _unwrappingInvoke(channel: string, ...args: unknown[]): Promise<any> {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (isIpcEnvelope(response)) {
    if (!response.ok) {
      const serialized = response.error;
      if (serialized.name === "AppError" && typeof serialized.code === "string") {
        throw _reconstructAppError(serialized);
      }
      throw deserializeError(serialized);
    }
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

// Shared multiplexer for the typed event bus. All `window.electron.events.on`
// subscribers — plus the migrated per-domain helpers below (terminal.onExit,
// window.onFullscreenChange, etc.) — dispatch through a single ipcRenderer
// listener on CHANNELS.EVENTS_PUSH. Ref-counted per event name so Node's
// MaxListenersExceededWarning (fires at 10 listeners per channel) can't trip
// as more events migrate; the ipcRenderer listener stays at exactly 1.
type EventBusSubscriber = (payload: unknown) => void;
const _eventBusSubscribers = new Map<keyof IpcEventBusMap, Set<EventBusSubscriber>>();
let _eventBusWired = false;

function _ensureEventBusWired(): void {
  if (_eventBusWired) return;
  _eventBusWired = true;
  ipcRenderer.on(CHANNELS.EVENTS_PUSH, (_event, envelope: EventBusEnvelope) => {
    if (!envelope || typeof envelope !== "object") return;
    if (typeof envelope.name !== "string") return;
    const subs = _eventBusSubscribers.get(envelope.name);
    if (!subs || subs.size === 0) return;
    // Snapshot before iterating: a subscriber may unsubscribe itself or
    // another subscriber during dispatch; iterating the live Set would make
    // delivery to surviving subscribers depend on insertion order.
    for (const cb of [...subs]) {
      try {
        cb(envelope.payload);
      } catch (err) {
        console.error("[Preload] events:push subscriber threw for", envelope.name, err);
      }
    }
  });
}

function _eventBusOn<K extends keyof IpcEventBusMap>(
  name: K,
  callback: (payload: IpcEventBusMap[K]) => void
): () => void {
  _ensureEventBusWired();
  let set = _eventBusSubscribers.get(name);
  if (!set) {
    set = new Set();
    _eventBusSubscribers.set(name, set);
  }
  const wrapped = callback as EventBusSubscriber;
  set.add(wrapped);
  return () => {
    const current = _eventBusSubscribers.get(name);
    if (!current) return;
    current.delete(wrapped);
    if (current.size === 0) _eventBusSubscribers.delete(name);
  };
}

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

    restartService: (): Promise<void> => _unwrappingInvoke(CHANNELS.WORKTREE_RESTART_SERVICE),

    onUpdate: (callback: (state: WorktreeState) => void) =>
      _eventBusOn("worktree:update", (payload) => callback(payload.worktree)),

    onRemove: (callback: (data: { worktreeId: string }) => void) =>
      _typedOn(CHANNELS.WORKTREE_REMOVE, callback),

    onActivated: (callback: (data: { worktreeId: string }) => void) =>
      _typedOn(CHANNELS.WORKTREE_ACTIVATED, callback),
  },

  // Worktree Port API (Phase 1 — dedicated MessagePort with request/response)
  worktreePort: {
    request: <K extends WorktreePortAction>(
      action: K,
      ...args: WorktreePortRequestArgs<K>
    ): Promise<WorktreePortResult<K>> =>
      worktreePortClient.request<K>(action, args[0] as WorktreePortPayload<K> | undefined),

    onEvent: (type: string, callback: (data: unknown) => void): (() => void) =>
      worktreePortClient.onEvent(type, callback),

    isReady: (): boolean => worktreePortClient.isReady(),

    onReady: (callback: () => void): (() => void) => worktreePortClient.onReady(callback),

    onDisconnected: (callback: () => void): (() => void) =>
      worktreePortClient.onDisconnected(callback),

    onFatalDisconnect: (callback: () => void): (() => void) =>
      worktreePortClient.onFatalDisconnect(callback),
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

    onExit: (callback: (id: string, exitCode: number) => void) =>
      _eventBusOn("terminal:exit", (payload) => {
        if (!Array.isArray(payload)) return;
        const [id, exitCode] = payload;
        if (typeof id === "string" && typeof exitCode === "number") {
          callback(id, exitCode);
        }
      }),

    onAgentStateChanged: (callback: (data: AgentStateChangePayload) => void) =>
      _eventBusOn("agent:state-changed", callback),

    onAgentDetected: (callback: (data: AgentDetectedPayload) => void) =>
      _eventBusOn("agent:detected", callback),

    onAgentExited: (callback: (data: AgentExitedPayload) => void) =>
      _eventBusOn("agent:exited", callback),

    onFallbackTriggered: (callback: (data: AgentFallbackTriggeredPayload) => void) =>
      _eventBusOn("agent:fallback-triggered", callback),

    onAllAgentsClear: (callback: (data: { timestamp: number }) => void) =>
      _eventBusOn("agent:all-clear", callback),

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

    searchSemanticBuffers: (query: string, isRegex: boolean) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_SEARCH_SEMANTIC_BUFFERS, query, isRegex),

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

    forceResume: (id: string): Promise<void> =>
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
    ): (() => void) => _eventBusOn("terminal:backend-crashed", callback),

    onBackendReady: (callback: () => void): (() => void) =>
      _eventBusOn("terminal:backend-ready", () => callback()),

    sendKey: (id: string, key: string) => ipcRenderer.send(CHANNELS.TERMINAL_SEND_KEY, id, key),

    batchDoubleEscape: (ids: string[]) =>
      ipcRenderer.send(CHANNELS.TERMINAL_BATCH_DOUBLE_ESCAPE, ids),

    broadcastWrite: (ids: string[], data: string) =>
      ipcRenderer.send(CHANNELS.TERMINAL_BROADCAST_WRITE, ids, data),

    onBroadcastWriteResult: (callback: (data: BroadcastWriteResultPayload) => void) =>
      _typedOn(CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT, callback),

    reportTitleState: (id: string, state: "working" | "waiting") =>
      ipcRenderer.send(CHANNELS.TERMINAL_AGENT_TITLE_STATE, { id, state }),

    updateObservedTitle: (id: string, title: string) =>
      ipcRenderer.send(CHANNELS.TERMINAL_UPDATE_OBSERVED_TITLE, { id, title }),

    onSpawnResult: (callback: (id: string, result: SpawnResultPayload) => void): (() => void) =>
      _eventBusOn("terminal:spawn-result", (payload) => {
        if (!Array.isArray(payload)) return;
        const [id, result] = payload;
        if (typeof id === "string" && typeof result === "object" && result !== null) {
          callback(id, result as SpawnResultPayload);
        }
      }),

    onReduceScrollback: (
      callback: (data: { terminalIds: string[]; targetLines: number }) => void
    ) => _typedOn(CHANNELS.TERMINAL_REDUCE_SCROLLBACK, callback),

    onRestoreScrollback: (callback: (data: { terminalIds: string[] }) => void) =>
      _typedOn(CHANNELS.TERMINAL_RESTORE_SCROLLBACK, callback),

    restartService: (): Promise<void> => _unwrappingInvoke(CHANNELS.TERMINAL_RESTART_SERVICE),

    onReclaimMemory: (callback: () => void) =>
      _eventBusOn("window:reclaim-memory", () => callback()),
  },

  // Files API
  files: {
    search: (payload) => _unwrappingInvoke(CHANNELS.FILES_SEARCH, payload),
    read: (payload) => _unwrappingInvoke(CHANNELS.FILES_READ, payload),
  },

  // Slash Commands API
  slashCommands: buildSlashCommandsPreloadBindings(_unwrappingInvoke),

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

    getAgentCliDetails: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_AGENT_CLI_DETAILS),

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

    collectDiagnosticsForReview: () =>
      _unwrappingInvoke(CHANNELS.SYSTEM_COLLECT_DIAGNOSTICS_FOR_REVIEW),

    saveDiagnosticsBundle: (
      payload: import("../shared/types/ipc/system.js").DiagnosticsBundleSavePayload
    ) => _unwrappingInvoke(CHANNELS.SYSTEM_SAVE_DIAGNOSTICS_BUNDLE, payload),

    getAppMetrics: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_APP_METRICS),

    getHardwareInfo: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_HARDWARE_INFO),

    getProcessMetrics: () => _unwrappingInvoke(CHANNELS.DIAGNOSTICS_GET_PROCESS_METRICS),

    getHeapStats: () => _unwrappingInvoke(CHANNELS.DIAGNOSTICS_GET_HEAP_STATS),

    getDiagnosticsInfo: () => _unwrappingInvoke(CHANNELS.DIAGNOSTICS_GET_INFO),

    onWake: (callback: (data: { sleepDuration: number; timestamp: number }) => void) => {
      return _eventBusOn("system:wake", callback);
    },

    installAgent: (payload: { agentId: string; methodIndex?: number; jobId: string }) =>
      _unwrappingInvoke(CHANNELS.SETUP_AGENT_INSTALL, payload),

    onAgentInstallProgress: (
      callback: (event: { jobId: string; chunk: string; stream: "stdout" | "stderr" }) => void
    ) => _typedOn(CHANNELS.SETUP_AGENT_INSTALL_PROGRESS, callback),

    onResourceProfileChanged: (callback: (payload: ResourceProfilePayload) => void) =>
      _eventBusOn("resource:profile-changed", callback),
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

    resetAndRelaunch: () => _unwrappingInvoke(CHANNELS.APP_RESET_AND_RELAUNCH),

    notifyFirstInteractive: () => _unwrappingInvoke(CHANNELS.APP_FIRST_INTERACTIVE),

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

    getLevelOverrides: () => _unwrappingInvoke(CHANNELS.LOGS_GET_LEVEL_OVERRIDES),

    setLevelOverrides: (overrides: Record<string, string>) =>
      _unwrappingInvoke(CHANNELS.LOGS_SET_LEVEL_OVERRIDES, overrides),

    clearLevelOverrides: () => _unwrappingInvoke(CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES),

    getRegistry: () => _unwrappingInvoke(CHANNELS.LOGS_GET_REGISTRY),
  },

  // Error API
  errors: {
    onError: (callback: (error: ErrorRecord) => void) => _typedOn(CHANNELS.ERROR_NOTIFY, callback),

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

    onEventBatch: (callback: (events: EventRecord[]) => void) =>
      _typedOn(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, callback),
  },

  events: {
    emit: (eventType: string, payload: unknown) =>
      _unwrappingInvoke(CHANNELS.EVENTS_EMIT, eventType, payload),

    on: <K extends keyof IpcEventBusMap>(
      name: K,
      callback: (payload: IpcEventBusMap[K]) => void
    ): (() => void) => _eventBusOn(name, callback),
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

    getInRepoPresets: (
      projectId: string
    ): Promise<Record<string, import("../shared/config/agentRegistry.js").AgentPreset[]>> =>
      _unwrappingInvoke(CHANNELS.PROJECT_GET_INREPO_PRESETS, projectId),

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

  // Scratch (one-off agent workspace) API
  scratch: {
    getAll: (): Promise<import("../shared/types/scratch.js").Scratch[]> =>
      _unwrappingInvoke(CHANNELS.SCRATCH_GET_ALL),

    getCurrent: (): Promise<import("../shared/types/scratch.js").Scratch | null> =>
      _unwrappingInvoke(CHANNELS.SCRATCH_GET_CURRENT),

    create: (name?: string): Promise<import("../shared/types/scratch.js").Scratch> =>
      _unwrappingInvoke(CHANNELS.SCRATCH_CREATE, name),

    update: (
      scratchId: string,
      updates: { name?: string; lastOpened?: number }
    ): Promise<import("../shared/types/scratch.js").Scratch> =>
      _unwrappingInvoke(CHANNELS.SCRATCH_UPDATE, scratchId, updates),

    remove: (scratchId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.SCRATCH_REMOVE, scratchId),

    switch: (scratchId: string): Promise<import("../shared/types/scratch.js").Scratch> =>
      _unwrappingInvoke(CHANNELS.SCRATCH_SWITCH, scratchId),

    onUpdated: (callback: (scratch: import("../shared/types/scratch.js").Scratch) => void) =>
      _typedOn(CHANNELS.SCRATCH_UPDATED, callback),

    onRemoved: (callback: (scratchId: string) => void) =>
      _typedOn(CHANNELS.SCRATCH_REMOVED, callback),

    onSwitch: (
      callback: (payload: import("../shared/types/ipc/scratch.js").ScratchSwitchPayload) => void
    ) => _typedOn(CHANNELS.SCRATCH_ON_SWITCH, callback),
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

  // Global Environment Variables API
  globalEnv: buildGlobalEnvPreloadBindings(_unwrappingInvoke),

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

    getFirstPageCache: (cwd: string) =>
      _unwrappingInvoke(CHANNELS.GITHUB_GET_FIRST_PAGE_CACHE, cwd),

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

    onRateLimitChanged: (callback: (data: GitHubRateLimitPayload) => void) =>
      _typedOn(CHANNELS.GITHUB_RATE_LIMIT_CHANGED, callback),

    getRateLimitDetails: () => _unwrappingInvoke(CHANNELS.GITHUB_GET_RATE_LIMIT_DETAILS),

    onTokenHealthChanged: (callback: (data: GitHubTokenHealthPayload) => void) =>
      _typedOn(CHANNELS.GITHUB_TOKEN_HEALTH_CHANGED, callback),

    onRepoStatsAndPageUpdated: (callback: (data: RepoStatsAndPagePayload) => void) =>
      _typedOn(CHANNELS.GITHUB_REPO_STATS_AND_PAGE_UPDATED, callback),

    getTokenHealth: () => _unwrappingInvoke(CHANNELS.GITHUB_GET_TOKEN_HEALTH),
  },

  // Per-service connectivity API
  connectivity: {
    getState: (): Promise<ServiceConnectivitySnapshot> =>
      _unwrappingInvoke(CHANNELS.CONNECTIVITY_GET_STATE) as Promise<ServiceConnectivitySnapshot>,

    onServiceChanged: (callback: (payload: ServiceConnectivityPayload) => void) =>
      _typedOn(CHANNELS.CONNECTIVITY_SERVICE_CHANGED, callback),
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

    getByWorktree: (
      request: DevPreviewGetByWorktreeRequest
    ): Promise<DevPreviewSessionState | null> =>
      _unwrappingInvoke(
        CHANNELS.DEV_PREVIEW_GET_BY_WORKTREE,
        request
      ) as Promise<DevPreviewSessionState | null>,

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

    abortRepositoryOperation: (cwd: string) =>
      _unwrappingInvoke(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, cwd),

    continueRepositoryOperation: (cwd: string) =>
      _unwrappingInvoke(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION, cwd),

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

    markSafeDirectory: (path: string) => _unwrappingInvoke(CHANNELS.GIT_MARK_SAFE_DIRECTORY, path),
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

    setCustomSchemes: (schemes: unknown) =>
      _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_SET_CUSTOM_SCHEMES, schemes),

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
    ...buildAccessibilityPreloadBindings(_unwrappingInvoke),

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
    ): Promise<{ success: true } | null> =>
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
    reloadIgnoringCache: (webContentsId: number, panelId: string): Promise<void> =>
      _unwrappingInvoke(CHANNELS.WEBVIEW_RELOAD_IGNORING_CACHE, webContentsId, panelId),
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

    setWslGit: (worktreeId: string, enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_CONFIG_SET_WSL_GIT, { worktreeId, enabled }),

    dismissWslBanner: (worktreeId: string) =>
      _unwrappingInvoke(CHANNELS.WORKTREE_CONFIG_DISMISS_WSL_BANNER, { worktreeId }),
  },

  // Window API
  window: {
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) =>
      _eventBusOn("window:fullscreen-change", callback),
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
    onDestroyHiddenWebviews: (callback: (payload: { tier: 1 | 2 }) => void) =>
      _eventBusOn("window:destroy-hidden-webviews", callback),
    onDiskSpaceStatus: (
      callback: (payload: {
        status: "normal" | "warning" | "critical";
        availableMb: number;
        writesSuppressed: boolean;
      }) => void
    ) => _eventBusOn("window:disk-space-status", callback),
  },

  // Recovery API (used by recovery.html)
  recovery: {
    reloadApp: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_RELOAD_APP),
    resetAndReload: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_RESET_AND_RELOAD),
    exportDiagnostics: (): Promise<boolean> =>
      _unwrappingInvoke(CHANNELS.RECOVERY_EXPORT_DIAGNOSTICS),
    openLogs: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_OPEN_LOGS),
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
      quietHoursEnabled: boolean;
      quietHoursStartMin: number;
      quietHoursEndMin: number;
      quietHoursWeekdays: number[];
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
        quietHoursEnabled: boolean;
        quietHoursStartMin: number;
        quietHoursEndMin: number;
        quietHoursWeekdays: number[];
      }>
    ) => _unwrappingInvoke(CHANNELS.NOTIFICATION_SETTINGS_SET, settings),
    setSessionMuteUntil: (timestampMs: number) =>
      ipcRenderer.send(CHANNELS.NOTIFICATION_SESSION_MUTE_SET, { timestampMs }),
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
        action?: { label: string; ipcChannel: string; data?: string };
      }) => void
    ) => _typedOn(CHANNELS.NOTIFICATION_SHOW_TOAST, callback),
  },

  // Sound API (Web Audio playback via main → renderer push)
  sound: {
    onTrigger: (callback: (payload: { soundFile: string; detune?: number }) => void) =>
      _typedOn(CHANNELS.SOUND_TRIGGER, callback),
    onCancel: (callback: () => void) => _eventBusOn("sound:cancel", () => callback()),
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

    notifyDismiss: (version: string) => _unwrappingInvoke(CHANNELS.UPDATE_DISMISS_TOAST, version),
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
    ) => _eventBusOn("app-agent:dispatch-action-request", callback),

    // Send action dispatch response back to main process
    sendDispatchActionResponse: (payload: {
      requestId: string;
      result: { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    }) => ipcRenderer.send(CHANNELS.APP_AGENT_DISPATCH_ACTION_RESPONSE, payload),

    // Listen for action confirmation requests from main process
    onConfirmationRequest: (
      callback: (payload: {
        requestId: string;
        actionId: string;
        actionName?: string;
        args?: Record<string, unknown>;
        danger: "safe" | "confirm" | "restricted";
      }) => void
    ) => _eventBusOn("app-agent:confirmation-request", callback),

    // Send confirmation response back to main process
    sendConfirmationResponse: (payload: { requestId: string; approved: boolean }) =>
      ipcRenderer.send(CHANNELS.APP_AGENT_CONFIRMATION_RESPONSE, payload),
  },

  // Agent Capabilities API
  agentCapabilities: {
    getRegistry: () => _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_GET_REGISTRY),

    getAgentIds: () => _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_IDS),

    getAgentMetadata: (agentId: string) =>
      _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_GET_AGENT_METADATA, agentId),

    isAgentEnabled: (agentId: string) =>
      _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_IS_AGENT_ENABLED, agentId),

    onPresetsUpdated: (
      callback: (payload: {
        agentId: string;
        presets: Array<{
          id: string;
          name: string;
          description?: string;
          env?: Record<string, string>;
          args?: string[];
        }>;
      }) => void
    ) => _typedOn(CHANNELS.AGENT_PRESETS_UPDATED, callback),

    getCcrPresets: () => _unwrappingInvoke(CHANNELS.AGENT_CAPABILITIES_GET_CCR_PRESETS),
  },

  // Agent Session History API
  agentSessionHistory: {
    list: (worktreeId?: string) => _unwrappingInvoke(CHANNELS.AGENT_SESSION_LIST, { worktreeId }),
    clear: (worktreeId?: string) => _unwrappingInvoke(CHANNELS.AGENT_SESSION_CLEAR, { worktreeId }),
  },

  // Clipboard API — bindings built from the preload-safe channel map in
  // `./ipc/handlers/clipboard.preload.ts`. The handler module is main-only
  // because it imports `node:*` built-ins that aren't available in sandboxed
  // preloads. See #5691.
  clipboard: buildClipboardPreloadBindings(_unwrappingInvoke),

  // Web Utils API
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },

  appTheme: {
    get: () => _unwrappingInvoke(CHANNELS.APP_THEME_GET),

    setColorScheme: (schemeId: string) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_COLOR_SCHEME, schemeId),

    setCustomSchemes: (schemes: unknown) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_CUSTOM_SCHEMES, schemes),

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

    setAccentColorOverride: (color: string | null) =>
      _unwrappingInvoke(CHANNELS.APP_THEME_SET_ACCENT_COLOR_OVERRIDE, color),

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
    preview: {
      getState: () => _unwrappingInvoke(CHANNELS.TELEMETRY_PREVIEW_GET_STATE),
      toggle: (active: boolean) => _unwrappingInvoke(CHANNELS.TELEMETRY_PREVIEW_TOGGLE, active),
      subscribe: () => ipcRenderer.send(CHANNELS.TELEMETRY_PREVIEW_SUBSCRIBE),
      unsubscribe: () => ipcRenderer.send(CHANNELS.TELEMETRY_PREVIEW_UNSUBSCRIBE),
      onEventBatch: (
        callback: (
          events: import("../shared/types/ipc/telemetryPreview.js").SanitizedTelemetryEvent[]
        ) => void
      ) => _typedOn(CHANNELS.TELEMETRY_PREVIEW_EVENT_BATCH, callback),
      onStateChanged: (
        callback: (
          state: import("../shared/types/ipc/telemetryPreview.js").TelemetryPreviewState
        ) => void
      ) => _typedOn(CHANNELS.TELEMETRY_PREVIEW_STATE_CHANGED, callback),
    },
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
    onTelemetryConsentChanged: (
      callback: (payload: { level: "off" | "errors" | "full"; hasSeenPrompt: boolean }) => void
    ) => _typedOn(CHANNELS.PRIVACY_TELEMETRY_CONSENT_CHANGED, callback),
  },

  sentry: {
    getConsentState: () => _unwrappingInvoke(CHANNELS.SENTRY_GET_CONSENT_STATE),
  },

  onboarding: {
    get: () => _unwrappingInvoke(CHANNELS.ONBOARDING_GET),
    setStep: (step: string | null | { step: string | null; agentSetupIds?: string[] }) =>
      _unwrappingInvoke(CHANNELS.ONBOARDING_SET_STEP, step),
    complete: () => _unwrappingInvoke(CHANNELS.ONBOARDING_COMPLETE),
    markToastSeen: () => _unwrappingInvoke(CHANNELS.ONBOARDING_MARK_TOAST_SEEN),
    markNewsletterSeen: () => _unwrappingInvoke(CHANNELS.ONBOARDING_MARK_NEWSLETTER_SEEN),
    markWaitingNudgeSeen: () => _unwrappingInvoke(CHANNELS.ONBOARDING_MARK_WAITING_NUDGE_SEEN),
    markAgentsSeen: (agentIds: string[]) =>
      _unwrappingInvoke(CHANNELS.ONBOARDING_MARK_AGENTS_SEEN, agentIds),
    dismissWelcomeCard: () => _unwrappingInvoke(CHANNELS.ONBOARDING_DISMISS_WELCOME_CARD),
    dismissSetupBanner: () => _unwrappingInvoke(CHANNELS.ONBOARDING_DISMISS_SETUP_BANNER),
    getChecklist: () => _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_GET),
    dismissChecklist: () => _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_DISMISS),
    markChecklistItem: (item: ChecklistItemId) =>
      _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_MARK_ITEM, item),
    markChecklistCelebrationShown: () =>
      _unwrappingInvoke(CHANNELS.ONBOARDING_CHECKLIST_MARK_CELEBRATION_SHOWN),
    onChecklistPush: (
      callback: (state: IpcEventMap["onboarding:checklist-push"]) => void
    ): (() => void) => _typedOn(CHANNELS.ONBOARDING_CHECKLIST_PUSH, callback),
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
    rotateApiKey: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_ROTATE_API_KEY),
    getConfigSnippet: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_GET_CONFIG_SNIPPET),
    getAuditRecords: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_GET_AUDIT_RECORDS),
    getAuditConfig: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_GET_AUDIT_CONFIG),
    clearAuditLog: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_CLEAR_AUDIT_LOG),
    setAuditEnabled: (enabled: boolean) =>
      _unwrappingInvoke(CHANNELS.MCP_SERVER_SET_AUDIT_ENABLED, enabled),
    setAuditMaxRecords: (max: number) =>
      _unwrappingInvoke(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS, max),
    getRuntimeState: () => _unwrappingInvoke(CHANNELS.MCP_SERVER_GET_RUNTIME_STATE),
    onRuntimeStateChanged: (callback: (snapshot: McpRuntimeSnapshot) => void) =>
      _typedOn(CHANNELS.MCP_SERVER_RUNTIME_STATE_CHANGED, callback),
  },

  helpAssistant: {
    getSettings: () => _unwrappingInvoke(CHANNELS.HELP_ASSISTANT_GET_SETTINGS),
    setSettings: (
      patch: Partial<{
        docSearch: boolean;
        daintreeControl: boolean;
        skipPermissions: boolean;
        auditRetention: 7 | 30 | 0;
      }>
    ) => _unwrappingInvoke(CHANNELS.HELP_ASSISTANT_SET_SETTINGS, patch),
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

    sendDispatchActionResponse: (payload: {
      requestId: string;
      result: unknown;
      confirmationDecision?: "approved" | "rejected" | "timeout";
    }) => {
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
    validateActionIds: (actionIds: string[]) =>
      _unwrappingInvoke(CHANNELS.PLUGIN_VALIDATE_ACTION_IDS, actionIds),

    getActions: () => _unwrappingInvoke(CHANNELS.PLUGIN_ACTIONS_GET),
    registerAction: (pluginId: string, contribution: unknown) =>
      _unwrappingInvoke(CHANNELS.PLUGIN_ACTIONS_REGISTER, pluginId, contribution),
    unregisterAction: (pluginId: string, actionId: string) =>
      _unwrappingInvoke(CHANNELS.PLUGIN_ACTIONS_UNREGISTER, pluginId, actionId),
    onActionsChanged: (callback: (payload: { actions: PluginActionDescriptor[] }) => void) =>
      _eventBusOn("plugin:actions-changed", callback),
    getPanelKinds: () => _unwrappingInvoke(CHANNELS.PLUGIN_PANEL_KINDS_GET),
    onPanelKindsChanged: (callback: (payload: { kinds: PanelKindConfig[] }) => void) =>
      _eventBusOn("plugin:panel-kinds-changed", callback),
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
  help: buildHelpPreloadBindings(_unwrappingInvoke),

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
          screenshot: () => _unwrappingInvoke(CHANNELS.DEMO_SCREENSHOT),
          waitForSelector: (selector: string, timeoutMs?: number) =>
            _unwrappingInvoke(CHANNELS.DEMO_WAIT_FOR_SELECTOR, { selector, timeoutMs }),
          pause: () => _unwrappingInvoke(CHANNELS.DEMO_PAUSE),
          resume: () => _unwrappingInvoke(CHANNELS.DEMO_RESUME),
          sleep: (durationMs: number) => _unwrappingInvoke(CHANNELS.DEMO_SLEEP, { durationMs }),
          startCapture: (payload: { fps?: number; outputPath: string }) =>
            _unwrappingInvoke(CHANNELS.DEMO_START_CAPTURE, payload),
          sendCaptureChunk: (captureId: string, data: Uint8Array) => {
            ipcRenderer.send(CHANNELS.DEMO_CAPTURE_CHUNK, { captureId, data });
          },
          sendCaptureStop: (captureId: string, frameCount: number, error?: string) => {
            ipcRenderer.send(CHANNELS.DEMO_CAPTURE_STOP, { captureId, frameCount, error });
          },
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
        },
      }
    : {}),
};

// Expose the API to the renderer process only for trusted origins in the main frame
if (window.top === window && isTrustedRendererUrl(window.location.href)) {
  contextBridge.exposeInMainWorld("electron", api);
  // Bridge for @sentry/electron/renderer's IPC transport. The renderer SDK
  // looks up window.__SENTRY_IPC__["sentry-ipc"] and uses these methods to
  // forward envelopes to the main process (which owns the real DSN and HTTP
  // transport). contextIsolation blocks Sentry's default preload injection,
  // so we expose the bridge manually here — gated to the trusted main-frame
  // origin just like the `electron` API above.
  contextBridge.exposeInMainWorld("__SENTRY_IPC__", {
    "sentry-ipc": {
      sendRendererStart: (...args: unknown[]) => ipcRenderer.send("sentry-ipc.start", ...args),
      sendScope: (...args: unknown[]) => ipcRenderer.send("sentry-ipc.scope", ...args),
      sendEnvelope: (...args: unknown[]) => ipcRenderer.send("sentry-ipc.envelope", ...args),
      sendStatus: (...args: unknown[]) => ipcRenderer.send("sentry-ipc.status", ...args),
      sendStructuredLog: (...args: unknown[]) =>
        ipcRenderer.send("sentry-ipc.structured-log", ...args),
      sendMetric: (...args: unknown[]) => ipcRenderer.send("sentry-ipc.metric", ...args),
    },
  });
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

/// Private listener: reclaim renderer memory when notified by the main process.
// Not exposed through window.electron — this is an internal optimization.
// Subscribed through the shared events:push dispatcher so the underlying
// ipcRenderer listener is ref-counted alongside user-facing subscribers.
_eventBusOn("window:reclaim-memory", () => {
  webFrame.clearCache();
  (globalThis as unknown as { gc?: () => void }).gc?.();
});

// Private listener: report Blink (DOM/CSS/cross-frame) memory back to
// ProcessMemoryMonitor. Tracks the tier of memory that V8 heap stats miss.
// `process.getBlinkMemoryInfo` is an Electron-specific addition on the
// renderer's `process` global; it works under sandbox: true. Failures here
// are silent — the sample is best-effort observability, not a recovery path.
type BlinkMemoryInfo = {
  allocated: number;
  marked?: number;
  total?: number;
  partitionAlloc?: number;
};
_eventBusOn("window:sample-blink-memory", ({ requestId }) => {
  try {
    const fn = (process as unknown as { getBlinkMemoryInfo?: () => BlinkMemoryInfo })
      .getBlinkMemoryInfo;
    if (typeof fn !== "function") return;
    const info = fn();
    if (!info || typeof info.allocated !== "number") return;
    void ipcRenderer.invoke(CHANNELS.SYSTEM_REPORT_BLINK_MEMORY, {
      requestId,
      allocated: info.allocated,
      marked: info.marked,
      total: info.total,
      partitionAlloc: info.partitionAlloc,
    });
  } catch {
    /* observability is best-effort */
  }
});

// Renderer event-loop utilization sampler. The Node ELU API
// (performance.eventLoopUtilization) is unavailable under sandbox: true, so we
// observe the Web `long-animation-frame` PerformanceObserver and accumulate
// `blockingDuration` between sample events. The preload runs on the same
// renderer main thread as the page, so LoAF entries reflect the user-visible
// JS thread saturation. blockingDuration is 0 for entries < 50ms by spec —
// that's the intended noise floor for "long task" detection.
//
// No startup suppression: ProcessMemoryMonitor's poll cadence is 30s, so any
// LoAF replay from `buffered: true` is diluted across a full window before
// the first sample. The 0.85 ratio + 6-sample streak threshold on the main
// side absorbs the residual cold-start noise.
type LoAFEntry = PerformanceEntry & { blockingDuration?: number };
let eluAccumulatedBlockingMs = 0;
let eluWindowStartMs =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
try {
  if (typeof PerformanceObserver === "function") {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LoAFEntry[]) {
        const blocking = entry.blockingDuration;
        if (typeof blocking === "number" && blocking > 0) {
          eluAccumulatedBlockingMs += blocking;
        }
      }
    });
    // long-animation-frame is in Chromium 123+. Older runtimes throw on
    // observe() — caught and ignored; the handler will report 0 blocking.
    // The observer is intentionally not stored — it lives for the renderer's
    // lifetime and never needs to be disconnected.
    observer.observe({ type: "long-animation-frame", buffered: true });
  }
} catch {
  /* observer unavailable — sampler reports 0/window */
}
_eventBusOn("window:sample-renderer-elu", ({ requestId }) => {
  try {
    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const sampleWindowMs = Math.max(0, Math.round(now - eluWindowStartMs));
    const blockingDurationMs = Math.max(0, Math.round(eluAccumulatedBlockingMs));
    eluAccumulatedBlockingMs = 0;
    eluWindowStartMs = now;
    void ipcRenderer.invoke(CHANNELS.SYSTEM_REPORT_RENDERER_ELU, {
      requestId,
      blockingDurationMs,
      sampleWindowMs,
    });
  } catch {
    /* observability is best-effort */
  }
});

// E2E test bridge: expose renderer-side IPC listener introspection in fault mode.
// Gated by DAINTREE_E2E_FAULT_MODE to avoid production surface area.
if (process.env.DAINTREE_E2E_FAULT_MODE === "1") {
  contextBridge.exposeInMainWorld("__DAINTREE_E2E_IPC__", {
    getRendererListenerCount: (channel: string) => ipcRenderer.listenerCount(channel),
  });
}

// Generic e2e-mode flag — set whenever the test harness launches Daintree.
// Used by the renderer to suppress side effects (like the auto-launched
// primary agent at the end of onboarding) that would otherwise pollute
// panel-count assertions in tests.
if (process.env.DAINTREE_E2E_MODE === "1") {
  contextBridge.exposeInMainWorld("__DAINTREE_E2E_MODE__", true);
}

// E2E test bridge: expose the "skip first-run dialogs" flag to the renderer at
// runtime. This cannot travel through `import.meta.env` because that is baked
// at Vite build time, and CI builds do not set the var at build time — it is
// only set when the E2E harness launches Electron. The sandboxed renderer
// cannot read `process.env` directly, so the preload (which does have a
// polyfilled `process.env` even under sandbox: true) is the propagation point.
if (process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS === "1") {
  contextBridge.exposeInMainWorld("__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__", true);
}
