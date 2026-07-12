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
import { isTrustedRendererUrl, isRecoveryPageUrl } from "../shared/utils/trustedRenderer.js";
import { isIpcEnvelope } from "../shared/types/ipc/errors.js";
import { deserializeError } from "../shared/utils/ipcErrorSerialization.js";
import type { AppErrorCode } from "../shared/types/appError.js";
import type {
  McpRuntimeSnapshot,
  McpGrantLifecyclePayload,
  McpBearerIdentity,
  McpToolCallStartedPayload,
  McpToolCallSettledPayload,
  McpHelpDisplayImagePayload,
  McpTurnOutcomeAlertPayload,
} from "../shared/types/ipc/mcpServer.js";
import type { ActionContext, ActionDispatchResult } from "../shared/types/actions.js";
import type { PushProgressEvent } from "../shared/types/ipc/gitPush.js";
import { CHANNELS } from "./ipc/channels.js";
import { PERF_MARKS } from "../shared/perf/marks.js";
import {
  BrokerError,
  RequestResponseBroker,
  encodeBrokerError,
} from "./services/rpc/RequestResponseBroker.js";
import { buildClipboardPreloadBindings } from "./ipc/handlers/clipboard.preload.js";
import { buildSlashCommandsPreloadBindings } from "./ipc/handlers/slashCommands.preload.js";
import { buildGlobalEnvPreloadBindings } from "./ipc/handlers/globalEnv.preload.js";
import { buildAccessibilityPreloadBindings } from "./ipc/handlers/accessibility.preload.js";
import { buildHelpPreloadBindings } from "./ipc/handlers/help.preload.js";
import { buildEventInspectorPreloadBindings } from "./ipc/handlers/eventInspector.preload.js";
import { buildCommandsPreloadBindings } from "./ipc/handlers/commands.preload.js";
import { buildPortalPreloadBindings } from "./ipc/handlers/portal.preload.js";
import { buildDevPreviewPreloadBindings } from "./ipc/handlers/devPreview.preload.js";
import { buildPluginPreloadBindings } from "./ipc/handlers/plugin.preload.js";
import { buildPluginMcpPreloadBindings } from "./ipc/handlers/pluginMcp.preload.js";
import { buildPluginCapabilityPreloadBindings } from "./ipc/handlers/pluginCapability.preload.js";
import { buildPluginProcessPreloadBindings } from "./ipc/handlers/pluginProcess.preload.js";
import { buildScratchPreloadBindings } from "./ipc/handlers/scratch/preload.js";
import { buildMcpServerPreloadBindings } from "./ipc/handlers/mcpServer.preload.js";
import { buildForgeAuditPreloadBindings } from "./ipc/handlers/forgeAudit.preload.js";
import { buildRunHistoryPreloadBindings } from "./ipc/handlers/runHistory.preload.js";
import { buildGeminiPreloadBindings } from "./ipc/handlers/gemini.preload.js";
import { buildMilestonesPreloadBindings } from "./ipc/handlers/milestones.preload.js";
import { buildOnboardingPreloadBindings } from "./ipc/handlers/onboarding.preload.js";
import { buildShortcutHintsPreloadBindings } from "./ipc/handlers/shortcutHints.preload.js";
import { buildForgeRecommendationPreloadBindings } from "./ipc/handlers/forgeRecommendation.preload.js";
import { buildSentryPreloadBindings } from "./ipc/handlers/sentry.preload.js";
import { buildPrivacyPreloadBindings } from "./ipc/handlers/privacy.preload.js";
import { buildTelemetryPreloadBindings } from "./ipc/handlers/telemetry.preload.js";
import { buildConnectivityPreloadBindings } from "./ipc/handlers/connectivity.preload.js";
import { buildDiffMediaPreloadBindings } from "./ipc/handlers/diffMedia.preload.js";
import { buildHibernationPreloadBindings } from "./ipc/handlers/hibernation.preload.js";
import { buildIdleTerminalPreloadBindings } from "./ipc/handlers/idleTerminals.preload.js";
import { buildIdleBackgroundAutoClosePreloadBindings } from "./ipc/handlers/idleBackgroundAutoClose.preload.js";
import { buildSystemSleepPreloadBindings } from "./ipc/handlers/systemSleep.preload.js";
import { buildAppVersionInfoPreloadBindings } from "./ipc/handlers/appVersionInfo.preload.js";
import { buildResourceProfilePreloadBindings } from "./ipc/handlers/resourceProfile.preload.js";
import { buildWhySlowPreloadBindings } from "./ipc/handlers/whySlow.preload.js";
import { buildOsDndPreloadBindings } from "./ipc/handlers/osDnd.preload.js";
import { buildAgentCapabilitiesPreloadBindings } from "./ipc/handlers/agentCapabilities.preload.js";
import { buildHelpAssistantPreloadBindings } from "./ipc/handlers/helpAssistant.preload.js";
import { buildMenuPreloadBindings } from "./ipc/handlers/menu.preload.js";
import { buildCliPreloadBindings } from "./ipc/handlers/cli.preload.js";
import { buildGlobalRecipesPreloadBindings } from "./ipc/handlers/globalRecipes.preload.js";
import { buildEditorConfigPreloadBindings } from "./ipc/handlers/editorConfig.preload.js";
import { buildPaintFabricSurfacePreloadBindings } from "./ipc/handlers/paintFabricSurface.preload.js";
import { buildWebviewNavigationPreloadBindings } from "./ipc/handlers/webviewNavigation.preload.js";
import { buildWebviewCapturePreloadBindings } from "./ipc/handlers/webviewCapture.preload.js";
import { buildWorktreeConfigPreloadBindings } from "./ipc/handlers/worktreeConfig.preload.js";
import { buildTerminalLayoutPreloadBindings } from "./ipc/handlers/terminalLayout.preload.js";
import { buildTerminalConfigPreloadBindings } from "./ipc/handlers/terminalConfig.preload.js";

import type {
  Project,
  ProjectSettings,
  TerminalSpawnOptions,
  CopyTreeOptions,
  CopyTreeProgress,
  CopyTreeTestConfigOptions,
  AppState,
  LogEntry,
  LogFilterOptions,
  EventRecord,
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
  ServiceConnectivityPayload,
  GitStatus,
  KeyAction,
  TerminalRecipe,
  RecipeNameCollision,
  AttachIssuePayload,
  IssueAssociation,
  VoiceInputError,
  VoiceInputStatus,
} from "../shared/types/index.js";
import type { ColorVisionMode, AppColorScheme } from "../shared/types/appTheme.js";
import type {
  WorktreePortAction,
  WorktreePortPayload,
  WorktreePortRequestArgs,
  WorktreePortResult,
} from "../shared/types/worktree-port.js";
import { resolveWorktreePortTimeout } from "./utils/worktreePortTimeouts.js";
import type {
  AgentStateChangePayload,
  AgentDetectedPayload,
  AgentExitedPayload,
  AgentFallbackTriggeredPayload,
  ArtifactDetectedPayload,
  SaveArtifactOptions,
  ApplyPatchOptions,
  DevPreviewStateChangedPayload,
  DevPreviewAllSessionsPayload,
} from "../shared/types/ipc.js";
import type { TerminalActivityPayload } from "../shared/types/terminal.js";
import type {
  TerminalStatusPayload,
  SpawnResult,
  TerminalResourceBatchPayload,
  BroadcastWriteResultPayload,
  FdLeakWarningPayload,
  TerminalReliabilityMetricPayload,
} from "../shared/types/pty-host.js";

type SpawnResultPayload = SpawnResult;
import type { PortalNewTabMenuAction } from "../shared/types/portal.js";
import type { ResourceProfilePayload } from "../shared/types/resourceProfile.js";
import type {
  PluginActionDescriptor,
  PluginKeybindingDescriptor,
  ContextMenuContribution,
  PluginDeepLinkIntent,
  PluginPanelBadge,
} from "../shared/types/plugin.js";
import type { PanelKindConfig } from "../shared/config/panelKindRegistry.js";
import type { ToolbarButtonConfig } from "../shared/config/toolbarButtonRegistry.js";

export type { ElectronAPI };

// The preload uses only these four of PERF_MARKS' ~90 entries; local consts
// avoid repeated property lookups in the flush path at preload bottom.
const {
  PRELOAD_EVAL_START,
  PRELOAD_EVAL_END,
  PRELOAD_EXPOSE_IN_MAIN_WORLD_START,
  PRELOAD_EXPOSE_IN_MAIN_WORLD_END,
} = PERF_MARKS;

// Anchor for the per-view preload evaluation span (#9770). This is the first
// executable statement in the bundled preload entry (esbuild hoists the import
// `require()`s above it, so module-resolution cost is excluded by construction);
// everything below — building the API surface and the contextBridge exposure —
// is measured against it and flushed at preload bottom. Guarded so it is inert
// in runtimes without the Web Performance API (none in Electron, but cheap).
const preloadEvalStartMs =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;

// Monotonic clock reader shared by the preload-eval instrumentation below
// (#9770). Falls back to 0 where the Web Performance API is unavailable.
const perfNowMs = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;

// True for packaged production builds. `process.resourcesPath` is undefined in
// sandboxed preloads (sandbox: true), so the only reliable signal here is the
// `app.asar` segment Electron injects into argv when running from the asar.
// Used to gate the E2E test bridges below as defense-in-depth (#9148) — the
// primary strip happens at build time via esbuild defines in build-main.mjs.
const isPackagedBuild = process.argv.some((a) => a.includes("app.asar"));

const isDemoMode = !isPackagedBuild && process.argv.includes("--demo-mode");

// Persisted color scheme id passed from the main process via
// webPreferences.additionalArguments. Read synchronously here (process.argv is
// available even under sandbox: true) so the renderer can apply the saved theme
// on its very first paint instead of a prefers-color-scheme default (#9169).
const INITIAL_COLOR_SCHEME_ARG = "--daintree-initial-color-scheme-id=";
const initialColorSchemeId = process.argv
  .find((a) => a.startsWith(INITIAL_COLOR_SCHEME_ARG))
  ?.slice(INITIAL_COLOR_SCHEME_ARG.length);

// Destination project id passed from the main process via additionalArguments,
// replacing the former `?projectId=` query string so the document URL stays
// static and the V8 bytecode cache is shared across projects (#9162). Read the
// same way as the color scheme above and exposed as
// `window.__DAINTREE_INITIAL_PROJECT__` so renderer stores resolve their scope
// without parsing the URL.
const INITIAL_PROJECT_ID_ARG = "--daintree-initial-project-id=";
const initialProjectId = process.argv
  .find((a) => a.startsWith(INITIAL_PROJECT_ID_ARG))
  ?.slice(INITIAL_PROJECT_ID_ARG.length);

// Instance role passed from the main process via additionalArguments (#10123),
// with a process.env fallback for contexts the main process did not seed
// (process.env is polyfilled even under sandbox: true). Worker instances
// suppress automatic background GitHub polling; only the exact value "worker"
// opts in — anything else normalizes to "attended".
const INSTANCE_ROLE_ARG = "--daintree-instance-role=";
const rawInstanceRole =
  process.argv.find((a) => a.startsWith(INSTANCE_ROLE_ARG))?.slice(INSTANCE_ROLE_ARG.length) ??
  process.env.DAINTREE_INSTANCE_ROLE;
const instanceRole: "attended" | "worker" = rawInstanceRole === "worker" ? "worker" : "attended";

// Paint-fabric surface-host role (Phase 1V): a non-null value is the surface
// id and makes src/main.tsx mount the minimal surface-host root instead of
// the full app shell. Threaded via additionalArguments like the instance role.
const SURFACE_HOST_ARG = "--daintree-surface-host=";
const surfaceHostId: string | null =
  process.argv.find((a) => a.startsWith(SURFACE_HOST_ARG))?.slice(SURFACE_HOST_ARG.length) ?? null;

const E2E_MODE_ARG = "--daintree-e2e-mode";
const E2E_SKIP_FIRST_RUN_DIALOGS_ARG = "--daintree-e2e-skip-first-run-dialogs";
const E2E_FAULT_MODE_ARG = "--daintree-e2e-fault-mode";
// E2E flags are threaded into renderer argv via webPreferences.additionalArguments
// after the main process validates the matching DAINTREE_E2E_* env values.
// Electron 42 local sandboxed WebContentsView preloads can omit those extra
// argv switches, so keep an exact env fallback for the Playwright-launched
// process while preserving the non-packaged gate.
const isE2EMode =
  !isPackagedBuild &&
  (process.argv.includes(E2E_MODE_ARG) || process.env.DAINTREE_E2E_MODE === "1");
const isE2ESkipFirstRunDialogs =
  !isPackagedBuild &&
  (process.argv.includes(E2E_SKIP_FIRST_RUN_DIALOGS_ARG) ||
    process.env.DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS === "1");
const isE2EFaultMode =
  !isPackagedBuild &&
  (process.argv.includes(E2E_FAULT_MODE_ARG) || process.env.DAINTREE_E2E_FAULT_MODE === "1");

function e2eGlobalKey(name: string): string {
  return ["__", "DAINTREE", "_", "E2E", "_", name, "__"].join("");
}

// Store MessagePort for direct Renderer ↔ Pty Host communication
// Note: We cannot return MessagePort via contextBridge (it's not cloneable/transferable via that API).
// Instead, we use window.postMessage to transfer it to the main world.

let cachedToken: string | null = null;
let pendingTerminalPort: MessagePort | null = null;
let pendingTerminalPortToken: string | null = null;
let terminalPortMainWorldReady = false;

function isAllowedTerminalPortTarget(): boolean {
  return isTrustedRendererUrl(window.location.href);
}

function isSameWindowMessage(event: MessageEvent): boolean {
  if (window.top !== window) return false;
  if (event.source !== window) return false;

  const eventOrigin = event.origin;
  const windowOrigin = window.location.origin;
  const isFile = window.location.protocol === "file:";
  return (
    eventOrigin === windowOrigin || (isFile && eventOrigin === "null" && windowOrigin === "null")
  );
}

function closePendingTerminalPort(): void {
  if (!pendingTerminalPort) return;
  try {
    pendingTerminalPort.close();
  } catch {
    // Port may already be closed.
  }
  pendingTerminalPort = null;
  pendingTerminalPortToken = null;
}

function flushPendingTerminalPort(): void {
  if (!terminalPortMainWorldReady || !pendingTerminalPort || !pendingTerminalPortToken) {
    return;
  }

  if (!isAllowedTerminalPortTarget()) {
    console.error(
      "[Preload] Refusing to forward terminal MessagePort to untrusted origin:",
      window.location.href
    );
    closePendingTerminalPort();
    cachedToken = null;
    return;
  }

  const port = pendingTerminalPort;
  const token = pendingTerminalPortToken;
  pendingTerminalPort = null;
  pendingTerminalPortToken = null;
  cachedToken = null;

  const targetOrigin = window.location.origin;
  window.postMessage({ type: "terminal-port-token", token }, targetOrigin);
  window.postMessage({ type: "terminal-port", token }, targetOrigin, [port]);
  console.log("[Preload] MessagePort transferred to main world");
}

window.addEventListener("message", (event) => {
  if (!isSameWindowMessage(event)) return;
  if (event.data?.type !== "terminal-port-ready") return;

  terminalPortMainWorldReady = true;
  flushPendingTerminalPort();
});

ipcRenderer.on("terminal-port-token", (_event, payload: { token: string }) => {
  cachedToken = payload.token;
  flushPendingTerminalPort();
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
      try {
        port.close();
      } catch {
        // Port may already be closed.
      }
      return;
    }

    closePendingTerminalPort();
    pendingTerminalPort = port;
    pendingTerminalPortToken = token;
    flushPendingTerminalPort();
  }
});

// Dedicated worker-ingest ports (issue #10960). No pending/ready dance: the
// main world requested this port via IPC invoke and holds the matching token,
// so its listener is guaranteed live — forward straight through. The main
// thread never reads the port; it re-transfers it into the parse worker.
ipcRenderer.on("terminal-worker-port", (event, payload: { token: string; terminalId: string }) => {
  if (window.top !== window) return;

  const port = event.ports?.[0];
  if (!port) return;

  if (!isAllowedTerminalPortTarget()) {
    console.error(
      "[Preload] Refusing to forward worker-ingest MessagePort to untrusted origin:",
      window.location.href
    );
    try {
      port.close();
    } catch {
      // Port may already be closed.
    }
    return;
  }

  if (!payload?.token || !payload?.terminalId) {
    try {
      port.close();
    } catch {
      // Port may already be closed.
    }
    return;
  }

  window.postMessage(
    { type: "terminal-worker-port", token: payload.token, terminalId: payload.terminalId },
    window.location.origin,
    [port]
  );
});

// ── Worktree Port Client (Phase 1) ──────────────────────────────────────────
// New dedicated port for worktree data with request/response correlation.

type WorktreePortEventCallback = (data: unknown) => void;

class WorktreePortClient {
  private port: MessagePort | null = null;
  private broker = new RequestResponseBroker({
    idPrefix: "worktree",
    defaultTimeoutMs: 10000,
  });
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
      if (data.id && this.broker.has(data.id)) {
        if (data.error != null) {
          this.broker.reject(data.id, new Error(String(data.error)));
        } else {
          this.broker.resolve(data.id, data.result);
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

    // Clear pending BEFORE nulling state — preserves the invariant that no
    // request can be registered after clearance but before the null check.
    // Port replacement is a transient/recoverable condition (host restart,
    // project switch within window), not app shutdown — surface HOST_EXITED
    // so callers can retry rather than treating it as terminal.
    this.broker.clear(encodeBrokerError(new BrokerError("HOST_EXITED", "Worktree port replaced")));

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

    this.broker.clear(
      encodeBrokerError(new BrokerError("HOST_EXITED", "Worktree port disconnected"))
    );

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
    timeoutMs?: number
  ): Promise<WorktreePortResult<K>> {
    if (!this.port) {
      return Promise.reject(
        encodeBrokerError(new BrokerError("HOST_EXITED", "Worktree port not ready"))
      );
    }

    const id = this.broker.generateId();
    // Resolve the per-action timeout (#8551): create/delete-worktree,
    // resource-action, and run-lifecycle-setup legitimately run longer than
    // the 10s default. The broker's own getEffectiveTimeout only validates a
    // single defaultTimeoutMs, so the per-action table must be applied here.
    const effectiveTimeout = resolveWorktreePortTimeout(action, timeoutMs);
    const promise = this.broker.register<WorktreePortResult<K>>(id, {
      method: String(action),
      timeoutMs: effectiveTimeout,
    });

    try {
      this.port.postMessage({ id, action, payload: payload ?? {} });
    } catch (error) {
      this.broker.reject(id, error instanceof Error ? error : new Error(String(error)));
    }

    // Encode BrokerError rejections (TIMEOUT, HOST_EXITED, APP_SHUTDOWN) so
    // the renderer can decode the discriminant via `isClientBrokerError`.
    // contextBridge strips own Error properties, so the prefix is the only
    // reliable carrier across the realm boundary.
    return promise.catch((err: unknown) => {
      if (err instanceof BrokerError) {
        throw encodeBrokerError(err);
      }
      throw err;
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

/**
 * Reconstruct `GitOperationError` thrown in the main process. Same realm-
 * boundary stripping as `_reconstructAppError`: contextBridge clones the Error
 * and discards `gitReason`, `leaseSha`, and `branchName`. The renderer decodes
 * this prefix via `isClientGitError` (`src/utils/clientGitError.ts`).
 *
 * Optional fields use a fixed three-slot positional layout so the renderer
 * regex always matches; absent fields are empty between the pipes. `leaseSha`
 * is hex (URL-safe) but encoded for consistency with `branchName`, which can
 * contain `/` and other ref characters.
 *
 * Format: `[GitError|<reason>|<urlencoded leaseSha>|<urlencoded branchName>] <original message>`
 */
function _reconstructGitError(serialized: {
  name: string;
  message: string;
  gitReason?: string;
  leaseSha?: string;
  branchName?: string;
}): Error {
  const reason = serialized.gitReason ?? "unknown";
  const leaseShaPart = encodeURIComponent(serialized.leaseSha ?? "");
  const branchNamePart = encodeURIComponent(serialized.branchName ?? "");
  const encoded = `[GitError|${reason}|${leaseShaPart}|${branchNamePart}] ${serialized.message}`;
  const error = new Error(encoded);
  // Standard properties — set for callers in the same realm. They don't
  // survive the contextBridge crossing; the message prefix is the source
  // of truth on the renderer side.
  error.name = "GitOperationError";
  (error as Error & { gitReason: string }).gitReason = reason;
  if (serialized.leaseSha !== undefined) {
    (error as Error & { leaseSha: string }).leaseSha = serialized.leaseSha;
  }
  if (serialized.branchName !== undefined) {
    (error as Error & { branchName: string }).branchName = serialized.branchName;
  }
  return error;
}

// Typed overload: when `channel` is a key of `IpcInvokeMap` and the args match,
// the result is statically enforced against the central IPC contract. Calls
// that don't match the typed overload — including the function-value
// pass-through to `build*PreloadBindings` — fall through to the loose
// signature below and return `Promise<any>`.
function _unwrappingInvoke<K extends Extract<keyof IpcInvokeMap, string>>(
  channel: K,
  ...args: IpcInvokeMap[K]["args"]
): Promise<IpcInvokeMap[K]["result"]>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fallback for function-value pass-through to build*PreloadBindings
function _unwrappingInvoke(channel: string, ...args: unknown[]): Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches ipcRenderer.invoke return type
async function _unwrappingInvoke(channel: string, ...args: unknown[]): Promise<any> {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (isIpcEnvelope(response)) {
    if (!response.ok) {
      const serialized = response.error;
      if (serialized.name === "AppError" && typeof serialized.code === "string") {
        throw _reconstructAppError(serialized);
      }
      if (serialized.name === "GitOperationError" && typeof serialized.gitReason === "string") {
        throw _reconstructGitError(serialized);
      }
      throw deserializeError(serialized);
    }
    return response.data;
  }
  return response;
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

// Events safe to replay to a late first subscriber. A `daintree://` deep link
// (#9559) is delivered by main on the primary view's first paint — which fires
// from the Suspense *parent* before `AppInner` (the component that owns the
// subscription) has mounted past its `app:boot` gate. Without a replay buffer
// the intent would land with no subscriber and be dropped on a slow cold
// launch. `window:disk-space-status` is replayed for the same reason (#9769):
// main pushes the current non-normal status once at `did-finish-load`, and the
// `useDiskSpaceWarnings` subscriber now mounts behind the `isStateLoaded` gate
// (after the full hydration round-trip), so without buffering the one-shot
// warning would be dropped on a slow startup and only resurface on the next
// status *change*. Only latest-wins, single-shot, low-frequency signals belong
// here — replaying a high-frequency or stale state event to a late subscriber
// would be wrong. Disk status qualifies: latest-wins and emitted on change
// (~5-min poll), so the buffered payload always reflects the current state.
const _eventBusReplayable: ReadonlySet<keyof IpcEventBusMap> = new Set([
  "plugin:deep-link",
  "window:disk-space-status",
]);
const _eventBusBuffered = new Map<keyof IpcEventBusMap, unknown>();

function _ensureEventBusWired(): void {
  if (_eventBusWired) return;
  _eventBusWired = true;
  ipcRenderer.on(CHANNELS.EVENTS_PUSH, (_event, envelope: EventBusEnvelope) => {
    if (!envelope || typeof envelope !== "object") return;
    if (typeof envelope.name !== "string") return;
    const subs = _eventBusSubscribers.get(envelope.name);
    if (!subs || subs.size === 0) {
      // No subscriber yet: buffer replayable events so a late-mounting
      // subscriber (e.g. one behind a Suspense boundary) still receives them.
      if (_eventBusReplayable.has(envelope.name)) {
        _eventBusBuffered.set(envelope.name, envelope.payload);
      }
      return;
    }
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
  // Replay a buffered event to the first subscriber (see _eventBusReplayable) so
  // a signal delivered before this subscriber mounted isn't lost.
  if (_eventBusBuffered.has(name)) {
    const buffered = _eventBusBuffered.get(name);
    _eventBusBuffered.delete(name);
    try {
      wrapped(buffered);
    } catch (err) {
      console.error("[Preload] events:push replay threw for", name, err);
    }
  }
  return () => {
    const current = _eventBusSubscribers.get(name);
    if (!current) return;
    current.delete(wrapped);
    if (current.size === 0) _eventBusSubscribers.delete(name);
  };
}

// Multiplexer for the shared terminal:data channel, mirroring _eventBusOn:
// one ipcRenderer listener dispatching by terminal id, instead of one
// filtering listener per terminal (O(N) handler invocations per chunk and a
// MaxListenersExceededWarning at 10+ terminals).
type TerminalDataSubscriber = (data: string | Uint8Array) => void;
const _terminalDataSubscribers = new Map<string, Set<TerminalDataSubscriber>>();
let _terminalDataWired = false;

function _ensureTerminalDataWired(): void {
  if (_terminalDataWired) return;
  _terminalDataWired = true;
  ipcRenderer.on(CHANNELS.TERMINAL_DATA, (_event, terminalId: unknown, data: unknown) => {
    if (typeof terminalId !== "string") return;
    const subs = _terminalDataSubscribers.get(terminalId);
    if (!subs || subs.size === 0) return;
    // Accept string, Uint8Array, or Buffer (Node.js extends Uint8Array)
    if (typeof data === "string" || data instanceof Uint8Array || Buffer.isBuffer(data)) {
      // Iterate the live Set directly — unlike the events:push dispatcher
      // above, terminal data subscribers don't unsubscribe during dispatch,
      // and this path runs per chunk, so the snapshot allocation matters.
      for (const cb of subs) {
        cb(data);
      }
    }
  });
}

function _terminalDataOn(id: string, callback: TerminalDataSubscriber): () => void {
  _ensureTerminalDataWired();
  let subs = _terminalDataSubscribers.get(id);
  if (!subs) {
    subs = new Set();
    _terminalDataSubscribers.set(id, subs);
  }
  // Fresh wrapper per subscription so the same callback can subscribe twice
  // and each cleanup removes only its own subscription.
  const wrapped: TerminalDataSubscriber = (data) => callback(data);
  subs.add(wrapped);
  return () => {
    const current = _terminalDataSubscribers.get(id);
    if (!current) return;
    current.delete(wrapped);
    if (current.size === 0) _terminalDataSubscribers.delete(id);
  };
}

// Multiplexer for the plugin push transport `plugin:{pluginId}:{channel}`,
// mirroring _terminalDataOn. host.broadcastToRenderer, host.postToPanel, and the
// managed-process stream all push a PluginPanelEventEnvelope `{ panelId, payload }`
// over this channel, and multiple panel instances of one kind each subscribe to
// the same channel. Before #10618 every `plugin.on` call added its own raw
// ipcRenderer.on with no per-instance filter, so every push reached every
// instance. Now one physical listener per full channel fans out by panelId: a
// broadcast envelope (`panelId: null`) reaches only broadcast subscribers (those
// registered via `plugin.on`), and a targeted envelope reaches only the
// subscribers registered for that exact panelId via `plugin.onPanel` — so
// `postToPanel(channel, payload, "panel-a")` no longer leaks to sibling
// instances.
type PluginPushSubscriber = (payload: unknown) => void;
interface PluginPushChannelEntry {
  handler: (event: Electron.IpcRendererEvent, raw: unknown) => void;
  // Keyed by panelId; the `null` key holds broadcast subscribers.
  subscribers: Map<string | null, Set<PluginPushSubscriber>>;
}
const _pluginPushChannels = new Map<string, PluginPushChannelEntry>();

function _pluginPushOn(
  pluginId: string,
  channel: string,
  panelId: string | null,
  callback: PluginPushSubscriber
): () => void {
  const fullChannel = `plugin:${pluginId}:${channel}`;
  let entry = _pluginPushChannels.get(fullChannel);
  if (!entry) {
    const subscribers = new Map<string | null, Set<PluginPushSubscriber>>();
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      // Unwrap the envelope. Every push site enveloples, but normalize
      // defensively: an unexpected shape degrades to a broadcast of the raw
      // value rather than crashing the dispatcher or dropping the push.
      let targetPanelId: string | null = null;
      let payload: unknown = raw;
      if (raw !== null && typeof raw === "object" && "panelId" in raw && "payload" in raw) {
        const env = raw as { panelId: unknown; payload: unknown };
        targetPanelId = typeof env.panelId === "string" ? env.panelId : null;
        payload = env.payload;
      }
      const set = subscribers.get(targetPanelId);
      if (!set || set.size === 0) return;
      // Snapshot before dispatch: a subscriber may unsubscribe (or its panel may
      // unmount) inside its own callback, mutating the Set mid-iteration.
      for (const cb of [...set]) {
        try {
          cb(payload);
        } catch (err) {
          console.error("[Preload] plugin push subscriber threw for", fullChannel, err);
        }
      }
    };
    ipcRenderer.on(fullChannel, handler);
    entry = { handler, subscribers };
    _pluginPushChannels.set(fullChannel, entry);
  }
  let set = entry.subscribers.get(panelId);
  if (!set) {
    set = new Set();
    entry.subscribers.set(panelId, set);
  }
  // Fresh wrapper per subscription so the same callback can subscribe twice and
  // each cleanup removes only its own registration.
  const wrapped: PluginPushSubscriber = (payload) => callback(payload);
  set.add(wrapped);
  return () => {
    const current = _pluginPushChannels.get(fullChannel);
    if (!current) return;
    const currentSet = current.subscribers.get(panelId);
    if (currentSet) {
      currentSet.delete(wrapped);
      if (currentSet.size === 0) current.subscribers.delete(panelId);
    }
    // Tear down the physical listener once every panelId bucket is empty, so an
    // unmounted view doesn't leak its channel listener.
    if (current.subscribers.size === 0) {
      ipcRenderer.removeListener(fullChannel, current.handler);
      _pluginPushChannels.delete(fullChannel);
    }
  };
}

// Recovery API (used by recovery.html). Hoisted out of buildElectronApi so the
// recovery page exposes these four methods without constructing the full
// ~490-closure surface.
const recoveryApi: ElectronAPI["recovery"] = {
  reloadApp: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_RELOAD_APP),
  resetAndReload: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_RESET_AND_RELOAD),
  exportDiagnostics: (): Promise<boolean> =>
    _unwrappingInvoke(CHANNELS.RECOVERY_EXPORT_DIAGNOSTICS),
  openLogs: (): Promise<void> => _unwrappingInvoke(CHANNELS.RECOVERY_OPEN_LOGS),
};

function buildElectronApi(): ElectronAPI {
  return {
    // Worktree API
    worktree: {
      getAll: () => _unwrappingInvoke(CHANNELS.WORKTREE_GET_ALL),

      refresh: (worktreeId?: string) => _unwrappingInvoke(CHANNELS.WORKTREE_REFRESH, worktreeId),

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

      attachIssue: (payload: AttachIssuePayload) =>
        _unwrappingInvoke(CHANNELS.WORKTREE_ATTACH_ISSUE, payload),

      detachIssue: (worktreeId: string) =>
        _unwrappingInvoke(CHANNELS.WORKTREE_DETACH_ISSUE, { worktreeId }),

      getAllIssueAssociations: (): Promise<Record<string, IssueAssociation>> =>
        _unwrappingInvoke(CHANNELS.WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS),

      restartService: (): Promise<void> => _unwrappingInvoke(CHANNELS.WORKTREE_RESTART_SERVICE),

      retryProjectLoad: (): Promise<void> =>
        _unwrappingInvoke(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD),

      retryAuthFetch: (): Promise<void> => _unwrappingInvoke(CHANNELS.WORKTREE_RETRY_AUTH_FETCH),

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

      // Tuple payload [id, data] dispatched via the shared multiplexer above
      // Accepts both string and Uint8Array/Buffer (binary optimization for reduced GC pressure)
      onData: (id: string, callback: (data: string | Uint8Array) => void) =>
        _terminalDataOn(id, callback),

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

      setActivityTier: (id: string, tier: "active" | "background", pollingIntervalMs?: number) =>
        ipcRenderer.send(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, { id, tier, pollingIntervalMs }),

      setFocused: (id: string | null) => ipcRenderer.send(CHANNELS.TERMINAL_SET_FOCUSED, { id }),

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

      reconnectBulk: (terminalIds: string[]) =>
        _unwrappingInvoke(CHANNELS.TERMINAL_RECONNECT_BULK, terminalIds),

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

      requestWorkerIngestPort: (id: string): Promise<{ token: string } | null> =>
        _unwrappingInvoke(CHANNELS.TERMINAL_REQUEST_WORKER_INGEST_PORT, id),

      releaseWorkerIngestPort: (id: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.TERMINAL_RELEASE_WORKER_INGEST_PORT, id),

      onStatus: (callback: (data: TerminalStatusPayload) => void) =>
        _typedOn(CHANNELS.TERMINAL_STATUS, callback),

      onReliabilityMetric: (
        callback: (data: TerminalReliabilityMetricPayload) => void
      ): (() => void) => _eventBusOn("terminal:reliability-metric", callback),

      onResourceMetrics: (
        callback: (data: { metrics: TerminalResourceBatchPayload; timestamp: number }) => void
      ) => _typedOn(CHANNELS.TERMINAL_RESOURCE_METRICS, callback),

      onFdLeakWarning: (callback: (data: FdLeakWarningPayload) => void) =>
        _typedOn(CHANNELS.TERMINAL_FD_LEAK_WARNING, callback),

      onBackendCrashed: (
        callback: (data: {
          crashType: string;
          code: number | null;
          signal: string | null;
          timestamp: number;
        }) => void
      ): (() => void) => _eventBusOn("terminal:backend-crashed", callback),

      onBackendRecovering: (
        callback: (data: {
          crashType: string;
          code: number | null;
          signal: string | null;
          timestamp: number;
        }) => void
      ): (() => void) => _eventBusOn("terminal:backend-recovering", callback),

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

    // Diff media API — HEAD vs working-tree image versions for image compare
    diffMedia: buildDiffMediaPreloadBindings(_unwrappingInvoke),

    // Watchdog API — surfaces the main-process deadlock detector's disabled
    // state to the renderer and exposes a manual restart path.
    watchdog: {
      restart: (): Promise<void> => _unwrappingInvoke(CHANNELS.WATCHDOG_RESTART),

      onDisabled: (
        callback: (data: {
          attemptCount: number;
          lastExitCode: number | null;
          timestamp: number;
        }) => void
      ): (() => void) => _eventBusOn("watchdog:disabled", callback),

      onActive: (callback: () => void): (() => void) =>
        _eventBusOn("watchdog:active", () => callback()),
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
        _unwrappingInvoke(CHANNELS.COPYTREE_INJECT, {
          terminalId,
          worktreeId,
          options,
          injectionId,
        }),

      isAvailable: () => _unwrappingInvoke(CHANNELS.COPYTREE_AVAILABLE),

      cancel: (injectionId?: string) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_CANCEL, { injectionId }),

      getFileTree: (worktreeId: string, dirPath?: string) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_GET_FILE_TREE, { worktreeId, dirPath }),

      testConfig: (worktreeId: string, options?: CopyTreeTestConfigOptions) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_TEST_CONFIG, { worktreeId, options }),

      onProgress: (callback: (progress: CopyTreeProgress) => void) =>
        _typedOn(CHANNELS.COPYTREE_PROGRESS, callback),
    },

    // Editor API
    editor: buildEditorConfigPreloadBindings(_unwrappingInvoke),

    // Paint-fabric surface views (Phase 1V substrate)
    paintSurface: {
      ...buildPaintFabricSurfacePreloadBindings(_unwrappingInvoke),
      // Surface-view side of the webglBudget apply step: the surface renderer
      // subscribes and applies granted thresholds to its TerminalWebGLManager.
      onWebglThresholds: (
        callback: (
          payload: import("../shared/types/paintFabricSurface.js").SurfaceWebglThresholds
        ) => void
      ) => _typedOn(CHANNELS.PAINT_SURFACE_WEBGL_THRESHOLDS, callback),
    },

    // System API
    system: {
      openExternal: (url: string) => _unwrappingInvoke(CHANNELS.SYSTEM_OPEN_EXTERNAL, { url }),

      openPath: (path: string) => _unwrappingInvoke(CHANNELS.SYSTEM_OPEN_PATH, { path }),

      showItemInFolder: (path: string) =>
        _unwrappingInvoke(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER, { path }),

      showItemInFolderUnconfined: (path: string) =>
        _unwrappingInvoke(CHANNELS.SYSTEM_SHOW_ITEM_IN_FOLDER_UNCONFINED, { path }),

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

      getAgentVersion: (agentId: string, refresh?: boolean) =>
        _unwrappingInvoke(CHANNELS.SYSTEM_GET_AGENT_VERSION, agentId, refresh),

      refreshAgentVersions: () => _unwrappingInvoke(CHANNELS.SYSTEM_REFRESH_AGENT_VERSIONS),

      getAgentUpdateSettings: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_AGENT_UPDATE_SETTINGS),

      setAgentUpdateSettings: (settings: {
        autoCheck: boolean;
        checkFrequencyHours: number;
        lastAutoCheck: number | null;
      }) => _unwrappingInvoke(CHANNELS.SYSTEM_SET_AGENT_UPDATE_SETTINGS, settings),

      startAgentUpdate: (payload: { agentId: string; method?: string }) =>
        _unwrappingInvoke(CHANNELS.SYSTEM_START_AGENT_UPDATE, payload),

      healthCheck: (agentIds?: string[]) =>
        _unwrappingInvoke(CHANNELS.SYSTEM_HEALTH_CHECK, agentIds),

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

      getReportEnrichment: () => _unwrappingInvoke(CHANNELS.SYSTEM_GET_REPORT_ENRICHMENT),

      startRendererCpuProfile: () => _unwrappingInvoke(CHANNELS.SYSTEM_RENDERER_CPU_PROFILE_START),

      stopRendererCpuProfile: () => _unwrappingInvoke(CHANNELS.SYSTEM_RENDERER_CPU_PROFILE_STOP),

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

      ...buildResourceProfilePreloadBindings(_unwrappingInvoke),

      ...buildWhySlowPreloadBindings(_unwrappingInvoke),
    },

    // App State API
    app: {
      getState: () => _unwrappingInvoke(CHANNELS.APP_GET_STATE),

      setState: (partialState: Partial<AppState>) =>
        _unwrappingInvoke(CHANNELS.APP_SET_STATE, partialState),

      getVersion: () => _unwrappingInvoke(CHANNELS.APP_GET_VERSION),

      ...buildAppVersionInfoPreloadBindings(_unwrappingInvoke),

      hydrate: () => _unwrappingInvoke(CHANNELS.APP_HYDRATE),

      boot: () => _unwrappingInvoke(CHANNELS.APP_BOOT),

      quit: () => _unwrappingInvoke(CHANNELS.APP_QUIT),

      forceQuit: () => _unwrappingInvoke(CHANNELS.APP_FORCE_QUIT),

      dismissRosettaWarning: () => _unwrappingInvoke(CHANNELS.APP_DISMISS_ROSETTA_WARNING),

      resetAndRelaunch: () => _unwrappingInvoke(CHANNELS.APP_RESET_AND_RELAUNCH),

      clearQuarantinedPanel: (panelId: string) =>
        _unwrappingInvoke(CHANNELS.APP_CLEAR_QUARANTINED_PANEL, panelId),

      skeletonParsed: () => ipcRenderer.send(CHANNELS.APP_SKELETON_PARSED),

      notifyFirstInteractive: () => _unwrappingInvoke(CHANNELS.APP_FIRST_INTERACTIVE),

      notifyViewPainted: () => _unwrappingInvoke(CHANNELS.APP_VIEW_PAINTED),

      notifyWarmViewPainted: () => _unwrappingInvoke(CHANNELS.APP_VIEW_WARM_PAINTED),

      onMenuAction: (callback: (payload: { actionId: string; args?: unknown }) => void) =>
        _typedOn(CHANNELS.MENU_ACTION, callback),

      reloadConfig: () => _unwrappingInvoke(CHANNELS.APP_RELOAD_CONFIG),

      onConfigReloaded: (callback: () => void) => _typedOn(CHANNELS.APP_CONFIG_RELOADED, callback),

      onViewRevealed: (callback: () => void) => _typedOn(CHANNELS.APP_VIEW_REVEALED, callback),
      onViewWarmActivated: (callback: () => void) =>
        _typedOn(CHANNELS.APP_VIEW_WARM_ACTIVATED, callback),
      onViewCached: (callback: () => void) => _typedOn(CHANNELS.APP_VIEW_CACHED, callback),
    },

    menu: buildMenuPreloadBindings(_unwrappingInvoke),

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

      writeBatch: (
        entries: Array<{
          level: "debug" | "info" | "warn" | "error";
          message: string;
          context?: Record<string, unknown>;
        }>
      ) => _unwrappingInvoke(CHANNELS.LOGS_WRITE_BATCH, entries),

      getDefaultLevel: () => _unwrappingInvoke(CHANNELS.LOGS_GET_DEFAULT_LEVEL),

      getLevelOverrides: () => _unwrappingInvoke(CHANNELS.LOGS_GET_LEVEL_OVERRIDES),

      setLevelOverrides: (overrides: Record<string, string>) =>
        _unwrappingInvoke(CHANNELS.LOGS_SET_LEVEL_OVERRIDES, overrides),

      clearLevelOverrides: () => _unwrappingInvoke(CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES),

      onLevelOverridesChanged: (callback: (overrides: Record<string, string>) => void) =>
        _typedOn(CHANNELS.LOGS_LEVEL_OVERRIDES_CHANGED, callback),

      getRegistry: () => _unwrappingInvoke(CHANNELS.LOGS_GET_REGISTRY),
    },

    // Error API
    errors: {
      onError: (callback: (error: ErrorRecord) => void) =>
        _typedOn(CHANNELS.ERROR_NOTIFY, callback),

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
      ...buildEventInspectorPreloadBindings(_unwrappingInvoke),

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
        outgoingState?: import("../shared/types/ipc/project.js").ProjectSwitchOutgoingState,
        options?: { focusIntent?: "focus-next-waiting" }
      ) => _unwrappingInvoke(CHANNELS.PROJECT_SWITCH, projectId, outgoingState, options),

      prefetchHydrate: (projectId: string) =>
        _unwrappingInvoke(CHANNELS.PROJECT_PREFETCH_HYDRATE, projectId),

      openDialog: () => _unwrappingInvoke(CHANNELS.PROJECT_OPEN_DIALOG),

      onSwitch: (
        callback: (payload: {
          project: Project;
          switchId: string;
          worktreeLoadError?: string;
          hydrateResult?: import("../shared/types/ipc/app.js").HydrateResult;
        }) => void
      ) => _typedOn(CHANNELS.PROJECT_ON_SWITCH, callback),

      onWorktreeLoadStatus: (
        callback: (payload: { projectId: string; worktreeLoadError: string | null }) => void
      ) => _typedOn(CHANNELS.PROJECT_WORKTREE_LOAD_STATUS, callback),

      onFocusOnActivate: (callback: (payload: { intent: "focus-next-waiting" }) => void) =>
        _typedOn(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, callback),

      onBackgroundResize: (callback: (payload: { width: number; height: number }) => void) =>
        _typedOn(CHANNELS.PROJECT_BACKGROUND_RESIZE, callback),

      onUpdated: (callback: (project: Project) => void) =>
        _typedOn(CHANNELS.PROJECT_UPDATED, callback),

      onRemoved: (callback: (projectId: string) => void) =>
        _typedOn(CHANNELS.PROJECT_REMOVED, callback),

      getSettings: (projectId: string) =>
        _unwrappingInvoke(CHANNELS.PROJECT_GET_SETTINGS, projectId),

      saveSettings: (projectId: string, settings: ProjectSettings) =>
        _unwrappingInvoke(CHANNELS.PROJECT_SAVE_SETTINGS, { projectId, settings }),

      detectRunners: (projectId: string) =>
        _unwrappingInvoke(CHANNELS.PROJECT_DETECT_RUNNERS, projectId),

      listRemotes: (cwd: string) => _unwrappingInvoke(CHANNELS.PROJECT_LIST_REMOTES, cwd),

      close: (projectId: string, options?: { killTerminals?: boolean }) =>
        _unwrappingInvoke(CHANNELS.PROJECT_CLOSE, projectId, options),

      freeMemory: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_FREE_MEMORY, projectId),

      reopen: (
        projectId: string,
        outgoingState?: import("../shared/types/ipc/project.js").ProjectSwitchOutgoingState
      ) => _unwrappingInvoke(CHANNELS.PROJECT_REOPEN, projectId, outgoingState),

      getStats: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_GET_STATS, projectId),

      getBulkStats: (projectIds: string[]) =>
        _unwrappingInvoke(CHANNELS.PROJECT_GET_BULK_STATS, projectIds),

      getNotificationOverrides: (projectIds: string[]) =>
        _unwrappingInvoke(CHANNELS.PROJECT_GET_NOTIFICATION_OVERRIDES, projectIds),

      onStatsUpdated: (
        callback: (stats: import("../shared/types/ipc/project.js").ProjectStatusMap) => void
      ) => _typedOn(CHANNELS.PROJECT_STATS_UPDATED, callback),

      createFolder: (parentPath: string, folderName: string): Promise<string> =>
        _unwrappingInvoke(CHANNELS.PROJECT_CREATE_FOLDER, { parentPath, folderName }),

      initGit: (directoryPath: string) =>
        _unwrappingInvoke(CHANNELS.PROJECT_INIT_GIT, directoryPath),

      initGitGuided: (options: import("../shared/types/ipc/gitInit.js").GitInitOptions) =>
        _unwrappingInvoke(CHANNELS.PROJECT_INIT_GIT_GUIDED, options),

      onInitGitProgress: (
        callback: (event: import("../shared/types/ipc/gitInit.js").GitInitProgressEvent) => void
      ) => _typedOn(CHANNELS.PROJECT_INIT_GIT_PROGRESS, callback),

      cloneRepo: (
        options: import("../shared/types/ipc/gitClone.js").CloneRepoOptions
      ): Promise<import("../shared/types/ipc/gitClone.js").CloneRepoResult> =>
        _unwrappingInvoke(CHANNELS.PROJECT_CLONE_REPO, options),

      onCloneProgress: (
        callback: (event: import("../shared/types/ipc/gitClone.js").CloneRepoProgressEvent) => void
      ) => _typedOn(CHANNELS.PROJECT_CLONE_PROGRESS, callback),

      cancelClone: (): Promise<void> => _unwrappingInvoke(CHANNELS.PROJECT_CLONE_CANCEL),

      getRecipes: (
        projectId: string
      ): Promise<{ recipes: TerminalRecipe[]; collisions: RecipeNameCollision[] }> =>
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
        previousName?: string,
        options?: { force?: boolean }
      ): Promise<void> =>
        _unwrappingInvoke(CHANNELS.PROJECT_UPDATE_INREPO_RECIPE, {
          projectId,
          recipe,
          previousName,
          force: options?.force === true ? true : undefined,
        }),

      deleteInRepoRecipe: (projectId: string, recipeName: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.PROJECT_DELETE_INREPO_RECIPE, { projectId, recipeName }),

      getInRepoPresets: (
        projectId: string
      ): Promise<Record<string, import("../shared/config/agentRegistry.js").AgentPreset[]>> =>
        _unwrappingInvoke(CHANNELS.PROJECT_GET_INREPO_PRESETS, projectId),

      ...buildTerminalLayoutPreloadBindings(_unwrappingInvoke),

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
      ...buildScratchPreloadBindings(_unwrappingInvoke),

      onUpdated: (callback: (scratch: import("../shared/types/scratch.js").Scratch) => void) =>
        _typedOn(CHANNELS.SCRATCH_UPDATED, callback),

      onRemoved: (callback: (scratchId: string) => void) =>
        _typedOn(CHANNELS.SCRATCH_REMOVED, callback),

      onSwitch: (
        callback: (payload: import("../shared/types/ipc/scratch.js").ScratchSwitchPayload) => void
      ) => _typedOn(CHANNELS.SCRATCH_ON_SWITCH, callback),
    },

    // Global Recipes API
    globalRecipes: buildGlobalRecipesPreloadBindings(_unwrappingInvoke),

    // Global Environment Variables API
    globalEnv: buildGlobalEnvPreloadBindings(_unwrappingInvoke),

    // Agent Settings API
    agentSettings: {
      get: () => _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_GET),

      set: (agentId: string, settings: Partial<AgentSettingsEntry>) =>
        _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_SET, { agentType: agentId, settings }),

      setGlobal: (value: boolean) => _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_SET_GLOBAL, value),

      setGlobalInline: (value: boolean) =>
        _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_SET_GLOBAL_INLINE, value),

      reset: (agentType?: string) => _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_RESET, agentType),

      stampVersion: (version: number) =>
        _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_STAMP_VERSION, version),
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

    // Per-service connectivity API
    connectivity: {
      ...buildConnectivityPreloadBindings(_unwrappingInvoke),

      onServiceChanged: (callback: (payload: ServiceConnectivityPayload) => void) =>
        _typedOn(CHANNELS.CONNECTIVITY_SERVICE_CHANGED, callback),
    },

    // Dev Preview API
    devPreview: {
      ...buildDevPreviewPreloadBindings(_unwrappingInvoke),

      onStateChanged: (callback: (payload: DevPreviewStateChangedPayload) => void) =>
        _typedOn(CHANNELS.DEV_PREVIEW_STATE_CHANGED, callback),

      onAllSessionsChanged: (callback: (payload: DevPreviewAllSessionsPayload) => void) =>
        _typedOn(CHANNELS.DEV_PREVIEW_ALL_SESSIONS_CHANGED, callback),
    },

    // Git API
    git: {
      getFileDiff: (cwd: string, filePath: string, status: GitStatus, ignoreWhitespace?: boolean) =>
        _unwrappingInvoke(CHANNELS.GIT_GET_FILE_DIFF, { cwd, filePath, status, ignoreWhitespace }),

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

      stageFiles: (cwd: string, filePaths: string[]) =>
        _unwrappingInvoke(CHANNELS.GIT_STAGE_FILES, { cwd, filePaths }),

      unstageFiles: (cwd: string, filePaths: string[]) =>
        _unwrappingInvoke(CHANNELS.GIT_UNSTAGE_FILES, { cwd, filePaths }),

      stageAll: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_STAGE_ALL, cwd),

      unstageAll: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_UNSTAGE_ALL, cwd),

      commit: (cwd: string, message: string) =>
        _unwrappingInvoke(CHANNELS.GIT_COMMIT, { cwd, message }),

      push: (cwd: string, setUpstream?: boolean) =>
        _unwrappingInvoke(CHANNELS.GIT_PUSH, { cwd, setUpstream }),

      pullRebase: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_PULL_REBASE, { cwd }),

      forcePushWithLease: (cwd: string, branchName: string, leaseSha: string) =>
        _unwrappingInvoke(CHANNELS.GIT_FORCE_PUSH_WITH_LEASE, { cwd, branchName, leaseSha }),

      listRemoteCommits: (cwd: string, branchName: string, limit?: number) =>
        _unwrappingInvoke(CHANNELS.GIT_LIST_REMOTE_COMMITS, { cwd, branchName, limit }),

      onPushProgress: (callback: (event: PushProgressEvent) => void) =>
        _typedOn(CHANNELS.GIT_PUSH_PROGRESS, callback),

      getStagingStatus: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_GET_STAGING_STATUS, cwd),

      abortRepositoryOperation: (cwd: string) =>
        _unwrappingInvoke(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, cwd),

      continueRepositoryOperation: (cwd: string) =>
        _unwrappingInvoke(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION, cwd),

      scanConflictMarkers: (cwd: string, filePaths: string[]) =>
        _unwrappingInvoke(CHANNELS.GIT_SCAN_CONFLICT_MARKERS, { cwd, filePaths }),

      checkoutOursTheirs: (cwd: string, filePath: string, side: "ours" | "theirs") =>
        _unwrappingInvoke(CHANNELS.GIT_CHECKOUT_OURS_THEIRS, { cwd, filePath, side }),

      compareWorktrees: (
        cwd: string,
        branch1: string,
        branch2: string,
        filePath?: string,
        useMergeBase?: boolean,
        ignoreWhitespace?: boolean
      ) =>
        _unwrappingInvoke(CHANNELS.GIT_COMPARE_WORKTREES, {
          cwd,
          branch1,
          branch2,
          filePath,
          useMergeBase,
          ignoreWhitespace,
        }),

      getUsername: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_GET_USERNAME, cwd),

      getWorkingDiff: (cwd: string, type: "unstaged" | "staged" | "head") =>
        _unwrappingInvoke(CHANNELS.GIT_GET_WORKING_DIFF, { cwd, type }),

      markSafeDirectory: (path: string) =>
        _unwrappingInvoke(CHANNELS.GIT_MARK_SAFE_DIRECTORY, path),
    },

    // Terminal Config API
    terminalConfig: {
      ...buildTerminalConfigPreloadBindings(_unwrappingInvoke),

      importColorScheme: () => _unwrappingInvoke(CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME),
    },

    // Accessibility API
    accessibility: {
      ...buildAccessibilityPreloadBindings(_unwrappingInvoke),

      onSupportChanged: (callback: (data: { enabled: boolean }) => void) =>
        _typedOn(CHANNELS.ACCESSIBILITY_SUPPORT_CHANGED, callback),
    },

    // Portal API
    portal: {
      ...buildPortalPreloadBindings(_unwrappingInvoke),

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
      registerPanel: (webContentsId: number, panelId: string, kind?: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_REGISTER_PANEL, { webContentsId, panelId, kind }),
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
      onDialogDismiss: (callback: (payload: { panelId: string }) => void): (() => void) =>
        _typedOn(CHANNELS.WEBVIEW_DIALOG_DISMISS, callback),
      onFindShortcut: (
        callback: (payload: {
          panelId: string;
          shortcut: "find" | "next" | "prev" | "close";
        }) => void
      ): (() => void) => _typedOn(CHANNELS.WEBVIEW_FIND_SHORTCUT, callback),
      onReloadShortcut: (callback: (payload: { panelId: string }) => void): (() => void) =>
        _typedOn(CHANNELS.WEBVIEW_RELOAD_SHORTCUT, callback),
      onCloseShortcut: (callback: (payload: { panelId: string }) => void): (() => void) =>
        _typedOn(CHANNELS.WEBVIEW_CLOSE_SHORTCUT, callback),
      onNavigationBlocked: (
        callback: (payload: { panelId: string; url: string; canOpenExternal: boolean }) => void
      ): (() => void) => _typedOn(CHANNELS.WEBVIEW_NAVIGATION_BLOCKED, callback),
      onUnresponsive: (callback: (payload: { panelId: string }) => void): (() => void) =>
        _typedOn(CHANNELS.WEBVIEW_UNRESPONSIVE, callback),
      onResponsive: (callback: (payload: { panelId: string }) => void): (() => void) =>
        _typedOn(CHANNELS.WEBVIEW_RESPONSIVE, callback),
      startOAuthLoopback: (
        authUrl: string,
        panelId: string,
        webContentsId: number,
        sessionStorageSnapshot?: Array<[string, string]>
      ): Promise<
        | {
            success: true;
            callbackUrl: string;
            loopbackRedirectUri: string;
            originalRedirectUri: string;
          }
        | {
            success: false;
            cause: "cancelled" | "timed-out" | "server-error" | "open-external-failed";
          }
      > =>
        _unwrappingInvoke(
          CHANNELS.WEBVIEW_OAUTH_LOOPBACK,
          authUrl,
          panelId,
          webContentsId,
          sessionStorageSnapshot
        ),
      cancelOAuthLoopback: (panelId: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_CANCEL_OAUTH_LOOPBACK, { panelId }),
      onOAuthLoopbackStatus: (
        callback: (payload: {
          panelId: string;
          phase: "token-exchange-intercepted" | "completed" | "timed-out" | "error";
          message?: string;
        }) => void
      ): (() => void) => _typedOn(CHANNELS.WEBVIEW_OAUTH_LOOPBACK_STATUS, callback),
      startConsoleCapture: (webContentsId: number, paneId: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_START_CONSOLE_CAPTURE, webContentsId, paneId),
      stopConsoleCapture: (webContentsId: number, paneId: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_STOP_CONSOLE_CAPTURE, webContentsId, paneId),
      clearConsoleCapture: (webContentsId: number, paneId: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_CLEAR_CONSOLE_CAPTURE, webContentsId, paneId),
      getConsoleProperties: (webContentsId: number, objectId: string) =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES, webContentsId, objectId),
      onConsoleMessage: (
        callback: (
          row: import("../shared/types/ipc/webviewConsole.js").SerializedConsoleRow
        ) => void
      ): (() => void) => _typedOn(CHANNELS.WEBVIEW_CONSOLE_MESSAGE, callback),
      onConsoleContextCleared: (
        callback: (payload: { paneId: string; navigationGeneration: number }) => void
      ): (() => void) => _typedOn(CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED, callback),
      reloadIgnoringCache: (webContentsId: number, panelId: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_RELOAD_IGNORING_CACHE, webContentsId, panelId),
      getScrollPosition: (webContentsId: number): Promise<number> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_GET_SCROLL_POSITION, webContentsId),
      ...buildWebviewNavigationPreloadBindings(_unwrappingInvoke),
      ...buildWebviewCapturePreloadBindings(_unwrappingInvoke),
    },

    // Hibernation API
    hibernation: {
      ...buildHibernationPreloadBindings(_unwrappingInvoke),

      onProjectHibernated: (
        callback: (payload: {
          projectId: string;
          projectName: string;
          reason: "scheduled" | "memory-pressure" | "user-initiated";
          terminalsKilled: number;
          timestamp: number;
        }) => void
      ): (() => void) => _typedOn(CHANNELS.HIBERNATION_PROJECT_HIBERNATED, callback),
    },

    // Idle Terminal Notification API
    idleTerminals: {
      ...buildIdleTerminalPreloadBindings(_unwrappingInvoke),

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

    // Idle Background-Project Auto-Close API
    idleBackgroundAutoClose: {
      ...buildIdleBackgroundAutoClosePreloadBindings(_unwrappingInvoke),

      onClosed: (
        callback: (payload: {
          projects: Array<{ projectId: string; projectName: string }>;
          timestamp: number;
        }) => void
      ): (() => void) => _typedOn(CHANNELS.IDLE_BACKGROUND_CLOSED, callback),
    },

    // System Sleep API
    systemSleep: {
      ...buildSystemSleepPreloadBindings(_unwrappingInvoke),

      onSuspend: (callback: () => void) => _typedOn(CHANNELS.SYSTEM_SLEEP_ON_SUSPEND, callback),

      onWake: (callback: (sleepDurationMs: number) => void) =>
        _typedOn(CHANNELS.SYSTEM_SLEEP_ON_WAKE, callback),
    },

    // OS Do-Not-Disturb / Focus state. Read-only signal — never used to gate
    // in-app toasts (the OS already silences its native banners).
    osDnd: {
      ...buildOsDndPreloadBindings(_unwrappingInvoke),

      onStateChanged: (callback: (payload: { osDndActive: boolean | undefined }) => void) =>
        _typedOn(CHANNELS.OS_DND_STATE_CHANGED, callback),
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
    worktreeConfig: buildWorktreeConfigPreloadBindings(_unwrappingInvoke),

    // Window API
    window: {
      onFullscreenChange: (callback: (isFullscreen: boolean) => void) =>
        _eventBusOn("window:fullscreen-change", callback),
      toggleFullscreen: (): Promise<boolean> =>
        _unwrappingInvoke(CHANNELS.WINDOW_TOGGLE_FULLSCREEN),
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
    recovery: recoveryApi,

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
          duration?: number;
          rateLimitKey?: string;
          priority?: "high" | "low" | "watch";
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

      getLastCheck: () => _unwrappingInvoke(CHANNELS.UPDATE_GET_LAST_CHECK),
    },

    // Windows Store update-notification API (parallel to `update`; only active
    // on MSIX/AppX builds where electron-updater is suppressed).
    storeUpdate: {
      onUpdateAvailable: (callback: (info: { version: string; storeUrl: string }) => void) =>
        _typedOn(CHANNELS.STORE_UPDATE_AVAILABLE, callback),

      getLatest: () => _unwrappingInvoke(CHANNELS.STORE_UPDATE_GET_LATEST),

      dismiss: (version: string) => _unwrappingInvoke(CHANNELS.STORE_UPDATE_DISMISS, version),

      getSettings: () => _unwrappingInvoke(CHANNELS.STORE_UPDATE_GET_SETTINGS),

      setSettings: (enabled: boolean) =>
        _unwrappingInvoke(CHANNELS.STORE_UPDATE_SET_SETTINGS, enabled),
    },

    // Gemini API
    gemini: buildGeminiPreloadBindings(_unwrappingInvoke),

    // Daintree CLI install API
    cli: buildCliPreloadBindings(_unwrappingInvoke),

    // Commands API
    commands: buildCommandsPreloadBindings(_unwrappingInvoke),

    // App Agent API - Configuration and API key management
    appAgent: {
      getConfig: () => _unwrappingInvoke(CHANNELS.APP_AGENT_GET_CONFIG),

      setConfig: (config: {
        provider?: string;
        model?: string;
        apiKey?: string;
        baseUrl?: string;
      }) => _unwrappingInvoke(CHANNELS.APP_AGENT_SET_CONFIG, config),

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
      ...buildAgentCapabilitiesPreloadBindings(_unwrappingInvoke),

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
    },

    // Agent Session History API
    agentSessionHistory: {
      list: (worktreeId?: string) => _unwrappingInvoke(CHANNELS.AGENT_SESSION_LIST, { worktreeId }),
      clear: (worktreeId?: string) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_CLEAR, { worktreeId }),
      getRetentionDays: () => _unwrappingInvoke(CHANNELS.AGENT_SESSION_GET_RETENTION),
      setRetentionDays: (days: number) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_SET_RETENTION, days),
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

    telemetry: (() => {
      const flat = buildTelemetryPreloadBindings(_unwrappingInvoke);
      return {
        get: flat.get,
        setEnabled: flat.setEnabled,
        markPromptShown: flat.markPromptShown,
        track: flat.track,
        preview: {
          getState: flat.previewGetState,
          toggle: flat.previewToggle,
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
      };
    })(),

    gpu: {
      getStatus: () => _unwrappingInvoke(CHANNELS.GPU_GET_STATUS),
      setHardwareAcceleration: (enabled: boolean) =>
        _unwrappingInvoke(CHANNELS.GPU_SET_HARDWARE_ACCELERATION, enabled),
    },

    privacy: {
      ...buildPrivacyPreloadBindings(_unwrappingInvoke),

      onTelemetryConsentChanged: (
        callback: (payload: { level: "off" | "errors" | "full"; hasSeenPrompt: boolean }) => void
      ) => _typedOn(CHANNELS.PRIVACY_TELEMETRY_CONSENT_CHANGED, callback),
    },

    sentry: buildSentryPreloadBindings(_unwrappingInvoke),

    onboarding: {
      ...buildOnboardingPreloadBindings(_unwrappingInvoke),

      onChecklistPush: (
        callback: (state: IpcEventMap["onboarding:checklist-push"]) => void
      ): (() => void) => _typedOn(CHANNELS.ONBOARDING_CHECKLIST_PUSH, callback),
    },

    milestones: buildMilestonesPreloadBindings(_unwrappingInvoke),

    shortcutHints: buildShortcutHintsPreloadBindings(_unwrappingInvoke),

    forgeRecommendation: buildForgeRecommendationPreloadBindings(_unwrappingInvoke),

    forge: {
      getSettings: () => _unwrappingInvoke(CHANNELS.FORGE_GET_SETTINGS),
      setDefaultProvider: (providerId: string | null) =>
        _unwrappingInvoke(CHANNELS.FORGE_SET_DEFAULT_PROVIDER, providerId),
      getProviders: () => _unwrappingInvoke(CHANNELS.FORGE_GET_PROVIDERS),
      resolveProvider: (projectId: string, remoteUrl?: string) =>
        _unwrappingInvoke(CHANNELS.FORGE_RESOLVE_PROVIDER, projectId, remoteUrl),
      openIssues: (cwd: string, query?: string, state?: string) =>
        _unwrappingInvoke(CHANNELS.FORGE_OPEN_ISSUES, cwd, query, state),
      openPRs: (cwd: string, query?: string, state?: string) =>
        _unwrappingInvoke(CHANNELS.FORGE_OPEN_PRS, cwd, query, state),
      openCommits: (cwd: string, branch?: string) =>
        _unwrappingInvoke(CHANNELS.FORGE_OPEN_COMMITS, cwd, branch),
      openIssue: (payload: { cwd: string; issueNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_OPEN_ISSUE, payload),
      getIssueUrl: (payload: { cwd: string; issueNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_ISSUE_URL, payload),
      assignIssue: (payload: { cwd: string; issueNumber: number; username: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_ASSIGN_ISSUE, payload),
      unassignIssue: (payload: { cwd: string; issueNumber: number; username: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_UNASSIGN_ISSUE, payload),
      approvePR: (payload: { cwd: string; prNumber: number; body?: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_APPROVE_PR, payload),
      requestChanges: (payload: { cwd: string; prNumber: number; body: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_REQUEST_CHANGES, payload),
      dismissReview: (payload: {
        cwd: string;
        prNumber: number;
        reviewId: number;
        message: string;
      }) => _unwrappingInvoke(CHANNELS.FORGE_DISMISS_REVIEW, payload),
      requestReviewers: (payload: {
        cwd: string;
        prNumber: number;
        users?: string[];
        teams?: string[];
      }) => _unwrappingInvoke(CHANNELS.FORGE_REQUEST_REVIEWERS, payload),
      createIssue: (payload: {
        cwd: string;
        input: { title: string; body?: string; labels?: string[] };
      }) => _unwrappingInvoke(CHANNELS.FORGE_CREATE_ISSUE, payload),
      closeIssue: (payload: {
        cwd: string;
        issueNumber: number;
        stateReason?: "completed" | "not_planned";
      }) => _unwrappingInvoke(CHANNELS.FORGE_CLOSE_ISSUE, payload),
      reopenIssue: (payload: { cwd: string; issueNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_REOPEN_ISSUE, payload),
      editIssue: (payload: {
        cwd: string;
        issueNumber: number;
        input: { title?: string; body?: string };
      }) => _unwrappingInvoke(CHANNELS.FORGE_EDIT_ISSUE, payload),
      addIssueComment: (payload: { cwd: string; issueNumber: number; body: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_ADD_ISSUE_COMMENT, payload),
      addIssueLabel: (payload: { cwd: string; issueNumber: number; label: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_ADD_ISSUE_LABEL, payload),
      removeIssueLabel: (payload: { cwd: string; issueNumber: number; label: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_REMOVE_ISSUE_LABEL, payload),
      validateToken: (payload: { providerId: string; token: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_VALIDATE_TOKEN, payload),
      setCredential: (providerId: string, credentials: Record<string, string>) =>
        _unwrappingInvoke(CHANNELS.FORGE_SET_CREDENTIAL, providerId, credentials),
      getCredentialStatus: (providerId: string) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_CREDENTIAL_STATUS, providerId),
      clearCredential: (providerId: string) =>
        _unwrappingInvoke(CHANNELS.FORGE_CLEAR_CREDENTIAL, providerId),
      listIssues: (payload: { cwd: string; opts?: unknown }) =>
        _unwrappingInvoke(CHANNELS.FORGE_LIST_ISSUES, payload),
      listPRs: (payload: { cwd: string; opts?: unknown }) =>
        _unwrappingInvoke(CHANNELS.FORGE_LIST_PRS, payload),
      getIssue: (payload: { cwd: string; issueNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_ISSUE, payload),
      getPR: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PR, payload),
      getRepoMetadata: (payload: { cwd: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_REPO_METADATA, payload),
      getCurrentUser: (payload: { cwd: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_CURRENT_USER, payload),
      onRateLimitChanged: (
        callback: (
          data: import("../shared/types/ipc/forge.js").ForgeRateLimitChangedPayload
        ) => void
      ) => _typedOn(CHANNELS.FORGE_RATE_LIMIT_CHANGED, callback),
      onTokenHealthChanged: (
        callback: (
          data: import("../shared/types/ipc/forge.js").ForgeTokenHealthChangedPayload
        ) => void
      ) => _typedOn(CHANNELS.FORGE_TOKEN_HEALTH_CHANGED, callback),
      classifyPushError: (payload: { cwd: string; stderr: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_CLASSIFY_PUSH_ERROR, payload),
      getRepoStats: (payload: { cwd: string; bypassCache?: boolean }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_REPO_STATS, payload),
      getFirstPageCache: (payload: { cwd: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_FIRST_PAGE_CACHE, payload),
      getProjectHealth: (payload: { cwd: string; bypassCache?: boolean }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PROJECT_HEALTH, payload),
      getIssueTooltip: (payload: { cwd: string; issueNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_ISSUE_TOOLTIP, payload),
      getPRTooltip: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PR_TOOLTIP, payload),
      getIssuesByNumbers: (payload: { cwd: string; numbers: number[] }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_ISSUES_BY_NUMBERS, payload),
      getPRsByNumbers: (payload: { cwd: string; numbers: number[] }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PRS_BY_NUMBERS, payload),
      getPRReviewThreads: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PR_REVIEW_THREADS, payload),
      resolveAuthorAvatar: (payload: { cwd: string; email: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_RESOLVE_AUTHOR_AVATAR, payload),
      getTokenHealth: (payload: { providerId: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_TOKEN_HEALTH, payload),
      getRateLimitDetails: (payload: { cwd: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_RATE_LIMIT_DETAILS, payload),
      openPR: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_OPEN_PR, payload),
      createPR: (payload: {
        cwd: string;
        head: string;
        base: string;
        title: string;
        body?: string;
        draft?: boolean;
      }) => _unwrappingInvoke(CHANNELS.FORGE_CREATE_PR, payload),
      closePR: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_CLOSE_PR, payload),
      reopenPR: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_REOPEN_PR, payload),
      mergePR: (payload: {
        cwd: string;
        prNumber: number;
        mergeMethod?: "merge" | "squash" | "rebase";
        commitTitle?: string;
        commitMessage?: string;
      }) => _unwrappingInvoke(CHANNELS.FORGE_MERGE_PR, payload),
      convertPRToDraft: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_CONVERT_PR_TO_DRAFT, payload),
      markPRReadyForReview: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_MARK_PR_READY_FOR_REVIEW, payload),
      commentOnPR: (payload: { cwd: string; prNumber: number; body: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_COMMENT_ON_PR, payload),
      editPR: (payload: { cwd: string; prNumber: number; title?: string; body?: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_EDIT_PR, payload),
      onRepoStatsAndPageUpdated: (
        callback: (
          data: import("../shared/types/ipc/forge.js").ForgeRepoStatsAndPagePayload
        ) => void
      ) => _typedOn(CHANNELS.FORGE_REPO_STATS_AND_PAGE_UPDATED, callback),
      onRepoCountsUpdated: (
        callback: (
          data: import("../shared/types/ipc/forge.js").ForgeRepoCountsUpdatedPayload
        ) => void
      ) => _typedOn(CHANNELS.FORGE_REPO_COUNTS_UPDATED, callback),
      onPRDetected: (callback: (data: PRDetectedPayload) => void) =>
        _typedOn(CHANNELS.PR_DETECTED, callback),
      onPRCleared: (callback: (data: PRClearedPayload) => void) =>
        _typedOn(CHANNELS.PR_CLEARED, callback),
      onIssueDetected: (callback: (data: IssueDetectedPayload) => void) =>
        _typedOn(CHANNELS.ISSUE_DETECTED, callback),
      onIssueNotFound: (callback: (data: IssueNotFoundPayload) => void) =>
        _typedOn(CHANNELS.ISSUE_NOT_FOUND, callback),
    },

    forgeAudit: buildForgeAuditPreloadBindings(_unwrappingInvoke),

    runHistory: buildRunHistoryPreloadBindings(_unwrappingInvoke),

    // Voice Input API
    voiceInput: {
      getSettings: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_GET_SETTINGS),
      setSettings: (
        patch: Partial<{
          enabled: boolean;
          openaiApiKey: string;
          deepgramApiKey: string;
          language: string;
          customDictionary: string[];
          transcriptionProvider: "openai" | "deepgram";
          transcriptionModel: "gpt-realtime-whisper";
          correctionEnabled: boolean;
          correctionModel: "gpt-5-nano" | "gpt-5-mini";
          correctionCustomInstructions: string;
          paragraphingStrategy: "spoken-command" | "manual";
          resolveFileLinks: boolean;
          deviceId: string;
          recordingMode: "toggle" | "push-to-talk";
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
      onParagraphBoundary: (callback: (payload: { rawText: string | null }) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, callback),
      onError: (callback: (error: VoiceInputError) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_ERROR, callback),
      onStatus: (callback: (status: VoiceInputStatus) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_STATUS, callback),
      checkMicPermission: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION),
      requestMicPermission: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION),
      openMicSettings: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS),
      validateApiKey: (apiKey: string) =>
        _unwrappingInvoke(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY, apiKey),
      correct: (request: { rawText: string; recentContext?: string[] }) =>
        _unwrappingInvoke(CHANNELS.VOICE_INPUT_CORRECT, request),
      onFileTokenResolved: (
        callback: (payload: { description: string; replacement: string; resolved: boolean }) => void
      ) => _typedOn(CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED, callback),
    },

    mcpServer: {
      ...buildMcpServerPreloadBindings(_unwrappingInvoke),

      onRuntimeStateChanged: (callback: (snapshot: McpRuntimeSnapshot) => void) =>
        _typedOn(CHANNELS.MCP_SERVER_RUNTIME_STATE_CHANGED, callback),
      onTierNotPermitted: (
        callback: (payload: {
          sessionId: string;
          toolId: string;
          tier: string;
          targetTier: "workbench" | "action" | "system" | null;
        }) => void
      ) => _typedOn(CHANNELS.MCP_TIER_NOT_PERMITTED, callback),
      onGrantLifecycle: (callback: (payload: McpGrantLifecyclePayload) => void) =>
        _typedOn(CHANNELS.MCP_GRANT_LIFECYCLE, callback),
      onSessionRevoked: (callback: (payload: { sessionId: string; denialKind: string }) => void) =>
        _typedOn(CHANNELS.MCP_SESSION_REVOKED, callback),
      onToolCallStarted: (callback: (payload: McpToolCallStartedPayload) => void) =>
        _typedOn(CHANNELS.MCP_TOOL_CALL_STARTED, callback),
      onToolCallSettled: (callback: (payload: McpToolCallSettledPayload) => void) =>
        _typedOn(CHANNELS.MCP_TOOL_CALL_SETTLED, callback),
      onDisplayImage: (callback: (payload: McpHelpDisplayImagePayload) => void) =>
        _typedOn(CHANNELS.MCP_HELP_DISPLAY_IMAGE, callback),
      onTurnOutcomeAlert: (callback: (payload: McpTurnOutcomeAlertPayload) => void) =>
        _typedOn(CHANNELS.MCP_TURN_OUTCOME_ALERT, callback),
    },

    helpAssistant: buildHelpAssistantPreloadBindings(_unwrappingInvoke),

    mcpBridge: {
      onGetManifestRequest: (callback: (requestId: string) => void) =>
        _typedOn(CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST, (payload) =>
          callback(payload.requestId)
        ),

      sendGetManifestResponse: (requestId: string, manifest: unknown) => {
        ipcRenderer.send(CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE, { requestId, manifest });
      },

      onDispatchActionRequest: (
        callback: (payload: {
          requestId: string;
          actionId: string;
          args?: unknown;
          confirmed?: boolean;
          context?: ActionContext;
          callerInfo?: McpBearerIdentity;
        }) => void
      ) => _typedOn(CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST, callback),

      sendDispatchActionResponse: (payload: {
        requestId: string;
        result: unknown;
        confirmationDecision?: "approved" | "rejected" | "timeout";
      }) => {
        ipcRenderer.send(CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE, payload);
      },
    },

    pluginBridge: {
      onDispatchActionRequest: (
        callback: (payload: { requestId: string; actionId: string; args?: unknown }) => void
      ) => _typedOn(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST, callback),

      sendDispatchActionResponse: (payload: {
        requestId: string;
        result: ActionDispatchResult;
      }) => {
        ipcRenderer.send(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE, payload);
      },

      onActionsListRequest: (callback: (payload: { requestId: string }) => void) =>
        _typedOn(CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST, callback),

      sendActionsListResponse: (payload: {
        requestId: string;
        entries: import("../shared/types/actions.js").PluginActionManifestEntry[];
      }) => {
        ipcRenderer.send(CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE, payload);
      },

      onActionsGetRequest: (callback: (payload: { requestId: string; actionId: string }) => void) =>
        _typedOn(CHANNELS.PLUGIN_ACTIONS_GET_REQUEST, callback),

      sendActionsGetResponse: (payload: {
        requestId: string;
        entry: import("../shared/types/actions.js").PluginActionManifestEntry | null;
      }) => {
        ipcRenderer.send(CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE, payload);
      },

      onUiPromptRequest: (
        callback: (
          payload: import("../shared/types/pluginUiPrompt.js").PluginUiPromptRequest
        ) => void
      ) => _typedOn(CHANNELS.PLUGIN_UI_PROMPT_REQUEST, callback),

      sendUiPromptResponse: (
        payload: import("../shared/types/pluginUiPrompt.js").PluginUiPromptResponse
      ) => {
        ipcRenderer.send(CHANNELS.PLUGIN_UI_PROMPT_RESPONSE, payload);
      },

      onUiPromptCancel: (
        callback: (
          payload: import("../shared/types/pluginUiPrompt.js").PluginUiPromptCancel
        ) => void
      ) => _typedOn(CHANNELS.PLUGIN_UI_PROMPT_CANCEL, callback),
    },

    plugin: {
      ...buildPluginPreloadBindings(_unwrappingInvoke),

      // Plugin-scoped bridge to the native filesystem path of a dropped File.
      // `webUtils.getPathForFile` must run in the preload (Electron 32 removed
      // `File.path`). Confined to the plugin namespace — deliberately NOT a
      // global `window.electron` method — so arbitrary native-path recovery
      // stays bounded to the plugin install surface (#9295). Returns `""` for
      // synthetic/non-disk File objects; the renderer treats empty as an error.
      getDroppedFilePath: (file: File): string => webUtils.getPathForFile(file),

      // plugin:invoke uses raw ipcMain.handle with variadic args — its signature
      // can't be expressed through IpcInvokeMap, so it stays inline.
      invoke: (pluginId: string, channel: string, ...args: unknown[]) =>
        _unwrappingInvoke(CHANNELS.PLUGIN_INVOKE, pluginId, channel, ...args),

      // Broadcast subscription: receives `host.postToPanel(channel, payload)`
      // and `host.broadcastToRenderer` pushes (envelope `panelId: null`) for
      // every instance of the kind. Per-instance targeting is `onPanel` below.
      on: (pluginId: string, channel: string, callback: (payload: unknown) => void) =>
        _pluginPushOn(pluginId, channel, null, callback),

      // Per-instance subscription: receives only the pushes targeted at this
      // exact `panelId` via `host.postToPanel(channel, payload, panelId)`, so
      // multiple open instances of the same panel kind no longer all receive
      // every push (#10618). Broadcast pushes (`panelId: null`) do NOT reach an
      // onPanel subscriber — use `on` for those.
      onPanel: (
        pluginId: string,
        channel: string,
        panelId: string,
        callback: (payload: unknown) => void
      ) => {
        // Reject an empty panelId loudly: the host side rejects an empty target
        // in postToPanel, so an empty subscription here could never be reached —
        // it would be a silently-dead listener. Surface the authoring mistake.
        if (typeof panelId !== "string" || panelId.length === 0) {
          throw new Error(`plugin.onPanel: panelId must be a non-empty string: ${String(panelId)}`);
        }
        return _pluginPushOn(pluginId, channel, panelId, callback);
      },

      onActionsChanged: (callback: (payload: { actions: PluginActionDescriptor[] }) => void) =>
        _eventBusOn("plugin:actions-changed", callback),
      onProvenanceChanged: (callback: (payload: Record<string, never>) => void) =>
        _eventBusOn("plugin:provenance-changed", callback),
      onBackgroundUpdateAvailable: (
        callback: (
          payload: import("../shared/types/plugin.js").PluginBackgroundUpdateCheckResult
        ) => void
      ) => _eventBusOn("plugin:bg-update-available", callback),
      onPanelKindsChanged: (callback: (payload: { kinds: PanelKindConfig[] }) => void) =>
        _eventBusOn("plugin:panel-kinds-changed", callback),
      onAgentsChanged: (
        callback: (payload: {
          agents: Record<string, import("../shared/config/agentRegistry.js").AgentConfig>;
          complete: boolean;
        }) => void
      ) => _eventBusOn("plugin:agents-changed", callback),
      onToolbarButtonsChanged: (
        callback: (payload: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void
      ) => _eventBusOn("plugin:toolbar-buttons-changed", callback),
      onKeybindingsChanged: (
        callback: (payload: {
          keybindings: PluginKeybindingDescriptor[];
          complete: boolean;
        }) => void
      ) => _eventBusOn("plugin:keybindings-changed", callback),
      onContextMenuItemsChanged: (
        callback: (payload: {
          items: Array<{ pluginId: string; item: ContextMenuContribution }>;
          complete: boolean;
        }) => void
      ) => _eventBusOn("plugin:context-menu-items-changed", callback),
      onDecorationsChanged: (callback: (payload: { scope: string; paths?: string[] }) => void) =>
        _eventBusOn("plugin:decorations-changed", callback),
      onPanelBadgesChanged: (
        callback: (payload: { pluginId: string; badges: Record<string, PluginPanelBadge> }) => void
      ) => _eventBusOn("plugin:panel-badges-changed", callback),
      onPanelBadgesCleared: (callback: (payload: { pluginId: string }) => void) =>
        _eventBusOn("plugin:panel-badges-cleared", callback),
      onDeepLink: (callback: (intent: PluginDeepLinkIntent) => void) =>
        _eventBusOn("plugin:deep-link", callback),
    },

    pluginMcp: buildPluginMcpPreloadBindings(_unwrappingInvoke),

    pluginCapability: buildPluginCapabilityPreloadBindings(_unwrappingInvoke),

    pluginProcess: buildPluginProcessPreloadBindings(_unwrappingInvoke),

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

    // Demo API — channel constants live in `./ipc/handlers/demo.preload.ts` and
    // back the main-side `defineIpcNamespace`, but the renderer-facing shape
    // takes positional args (moveTo(x, y, durationMs)) while channels carry a
    // single payload object. The translation stays inline so window.electron.demo
    // matches its declared `ElectronAPI.demo` signature.
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
            startCapture: (payload: {
              fps?: number;
              outputPath: string;
              videoBitsPerSecond?: number;
              width?: number;
              height?: number;
            }) => _unwrappingInvoke(CHANNELS.DEMO_START_CAPTURE, payload),
            sendCaptureChunk: (captureId: string, data: Uint8Array) => {
              ipcRenderer.send(CHANNELS.DEMO_CAPTURE_CHUNK, { captureId, data });
            },
            sendCaptureStop: (captureId: string, chunkCount: number, error?: string) => {
              ipcRenderer.send(CHANNELS.DEMO_CAPTURE_STOP, { captureId, chunkCount, error });
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
            typeInTerminal: (selector: string, text: string, cps?: number) =>
              _unwrappingInvoke(CHANNELS.DEMO_TYPE_IN_TERMINAL, { selector, text, cps }),
            sendKeyToTerminal: (selector: string, key: string) =>
              _unwrappingInvoke(CHANNELS.DEMO_SEND_KEY_TO_TERMINAL, { selector, key }),
            spotlight: (selector: string, padding?: number) =>
              _unwrappingInvoke(CHANNELS.DEMO_SPOTLIGHT, { selector, padding }),
            dismissSpotlight: () => _unwrappingInvoke(CHANNELS.DEMO_DISMISS_SPOTLIGHT),
            annotate: (
              selector: string,
              text: string,
              position?:
                | "top"
                | "bottom"
                | "left"
                | "right"
                | "screen-top"
                | "screen-bottom"
                | "screen-center"
                | "lower-third-left"
                | "lower-third-right"
                | "top-left"
                | "top-right"
                | "bottom-left"
                | "bottom-right"
                | "above-cursor"
                | "below-cursor",
              size?: "sm" | "md" | "lg" | "xl",
              id?: string
            ) =>
              _unwrappingInvoke(CHANNELS.DEMO_ANNOTATE, {
                selector,
                text,
                position,
                size,
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
              const handler = (
                _event: Electron.IpcRendererEvent,
                payload: Record<string, unknown>
              ) => callback(payload);
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
}

// Expose the API to the renderer process only for trusted origins in the main frame.
// The recovery page (recovery.html) is a static crash-recovery surface whose sole
// consumer (recovery-renderer.js) only touches `window.electron.recovery.*`. It gets
// a narrow bridge exposing only the 4-method `recovery` namespace, so an XSS on that
// page can't reach terminal.spawn, files.*, worktree.*, etc. Every other trusted
// same-origin route (index.html, and any future route) gets the full surface — using
// isRecoveryPageUrl as the discriminator keeps the full surface as the safe default.
const rendererUrl = window.location.href;
// Sub-span around the `window.electron` contextBridge handoff (#9770). Bracketed
// tightly around the exposeInMainWorld("electron", …) call in whichever branch
// runs, so the Sentry bridge exposure and origin-rejection logging are excluded.
// Defaults to a zero-width span for the untrusted path (no exposure happens).
let exposeStartMs = perfNowMs();
let exposeEndMs = exposeStartMs;
if (window.top === window && isTrustedRendererUrl(rendererUrl)) {
  if (isRecoveryPageUrl(rendererUrl)) {
    exposeStartMs = perfNowMs();
    contextBridge.exposeInMainWorld("electron", { recovery: recoveryApi });
    exposeEndMs = perfNowMs();
    // __SENTRY_IPC__ is intentionally withheld here: recovery.html has no Sentry
    // renderer SDK and exposing the transport would needlessly widen its surface.
  } else {
    // Built here — not at module scope — so recovery and untrusted frames
    // never pay for the ~490-closure full surface they don't expose.
    const api = buildElectronApi();
    exposeStartMs = perfNowMs();
    contextBridge.exposeInMainWorld("electron", api);
    exposeEndMs = perfNowMs();
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
  }
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
  if (isE2EFaultMode) {
    performance.mark("daintree-e2e-reclaim-memory");
  }
  if (document.visibilityState !== "hidden") return;
  const reclaim = () => (globalThis as unknown as { gc?: () => void }).gc?.();
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(reclaim, { timeout: 5_000 });
  } else {
    setTimeout(reclaim, 0);
  }
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
if (isE2EFaultMode) {
  contextBridge.exposeInMainWorld(e2eGlobalKey("IPC"), {
    getRendererListenerCount: (channel: string) => ipcRenderer.listenerCount(channel),
  });
}

// Generic e2e-mode flag — set whenever the test harness launches Daintree.
// Used by the renderer to suppress side effects (like the auto-launched
// primary agent at the end of onboarding) that would otherwise pollute
// panel-count assertions in tests.
if (isE2EMode) {
  contextBridge.exposeInMainWorld(e2eGlobalKey("MODE"), true);
}

// E2E test bridge: expose the "skip first-run dialogs" flag to the renderer at
// runtime. This cannot travel through `import.meta.env` because that is baked
// at Vite build time, and CI builds do not set the var at build time — it is
// only set when the E2E harness launches Electron. The sandboxed renderer
// cannot read `process.env` directly, so the preload (which does have a
// polyfilled `process.env` even under sandbox: true) is the propagation point.
if (isE2ESkipFirstRunDialogs) {
  contextBridge.exposeInMainWorld(e2eGlobalKey("SKIP_FIRST_RUN_DIALOGS"), true);
}

// Surface the persisted color scheme id (seeded via additionalArguments) so the
// renderer applies the saved theme on first paint, eliminating the flash of the
// prefers-color-scheme default before the async theme config resolves (#9169).
if (initialColorSchemeId) {
  contextBridge.exposeInMainWorld("__DAINTREE_INITIAL_THEME__", {
    colorSchemeId: initialColorSchemeId,
  });
}

// Surface the destination project id (seeded via additionalArguments) so the
// renderer resolves its project scope without a `?projectId=` query string,
// keeping the document URL static for V8 bytecode cache reuse (#9162).
if (initialProjectId) {
  contextBridge.exposeInMainWorld("__DAINTREE_INITIAL_PROJECT__", {
    id: initialProjectId,
  });
}

// Surface the instance role so renderer pollers can suppress automatic
// background GitHub polling in worker instances (#10123). Exposed
// unconditionally — attended instances get { role: "attended" } so consumers
// never need to null-guard the global.
contextBridge.exposeInMainWorld("__DAINTREE_INSTANCE_ROLE__", {
  role: instanceRole,
});

// Surface-host role for paint-fabric surface views (Phase 1V). Exposed
// unconditionally with null for ordinary views so consumers never null-guard
// the global itself.
contextBridge.exposeInMainWorld("__DAINTREE_SURFACE_HOST__", {
  surfaceId: surfaceHostId,
});

// Flush the per-view preload evaluation cost (#9770). Runs at preload bottom —
// before any renderer page script — so the main process can attribute the
// `preload.eval` and `preload.exposeInMainWorld` spans to this WebContentsView
// (via the IPC sender's id). Reuses the existing renderer-marks channel and its
// rebasing math: the preload shares the renderer frame's `performance.timeOrigin`,
// so each mark's elapsed value is relative to `preloadEvalStartMs`. Gated on the
// same runtime flag as the rest of the perf pipeline; `process.env` is polyfilled
// in the sandboxed preload, and the flag is intentionally NOT esbuild-stripped.
if (process.env.DAINTREE_PERF_CAPTURE === "1") {
  const preloadEvalEndMs = perfNowMs();
  const timestamp = new Date().toISOString();
  ipcRenderer.send(CHANNELS.PERF_FLUSH_RENDERER_MARKS, {
    marks: [
      {
        mark: PRELOAD_EVAL_START,
        timestamp,
        elapsedMs: 0,
      },
      {
        mark: PRELOAD_EXPOSE_IN_MAIN_WORLD_START,
        timestamp,
        elapsedMs: exposeStartMs - preloadEvalStartMs,
      },
      {
        mark: PRELOAD_EXPOSE_IN_MAIN_WORLD_END,
        timestamp,
        elapsedMs: exposeEndMs - preloadEvalStartMs,
        meta: { durationMs: exposeEndMs - exposeStartMs },
      },
      {
        mark: PRELOAD_EVAL_END,
        timestamp,
        elapsedMs: preloadEvalEndMs - preloadEvalStartMs,
        meta: { durationMs: preloadEvalEndMs - preloadEvalStartMs },
      },
    ],
    rendererTimeOrigin:
      typeof performance !== "undefined" && typeof performance.timeOrigin === "number"
        ? performance.timeOrigin
        : 0,
    rendererT0: preloadEvalStartMs,
  });
}
