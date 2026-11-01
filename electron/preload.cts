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
import type { PanelTitleMode } from "../shared/types/panel.js";
import type { HostMemoryPauseSnapshot } from "../shared/types/pty-host.js";
import type { TerminalExitContext, TerminalKillOptions } from "../shared/types/terminal.js";
import type { RendererInputBlockingSnapshot } from "../shared/types/ipc/system.js";
import type {
  McpRuntimeSnapshot,
  McpGrantLifecyclePayload,
  McpBearerIdentity,
  McpDispatchAuthorization,
  McpSessionOrigin,
  McpApprovalReason,
  McpHostPreview,
  McpRequester,
  McpToolCallStartedPayload,
  McpToolCallSettledPayload,
  McpHelpDisplayImagePayload,
  McpTurnOutcomeAlertPayload,
} from "../shared/types/ipc/mcpServer.js";
import type { ActionContext, ActionDispatchResult } from "../shared/types/actions.js";
import type { PushProgressEvent } from "../shared/types/ipc/gitPush.js";
import type { KeybindingOverridesSnapshot } from "../shared/types/ipc/api.js";
import type { GitPushReview } from "../shared/types/git.js";
import type { PluginPerfSnapshot } from "../shared/types/pluginMetrics.js";
import type { PluginRendererMetricsEnvelope } from "../shared/types/ipc/pluginMetrics.js";
import { CHANNELS } from "./ipc/channels.js";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { parseE2ETimerOverrideMs } from "../shared/config/e2eTimerOverrides.js";
import { connectWorktreePortClient } from "./preload/worktreePortClient.js";
import { createEventBus } from "./preload/eventBus.js";
import { createTerminalDataMultiplexer } from "./preload/terminalData.js";
import { createPluginPushTransport } from "./preload/pluginPush.js";
import { buildClipboardPreloadBindings } from "./ipc/handlers/clipboard.preload.js";
import { buildDroppedFilePathsBinding } from "./utils/droppedFilePaths.js";
import { captureInputBlockingSnapshot } from "./utils/inputBlockingSnapshot.js";
import { buildGitFetchPreloadBindings } from "./ipc/handlers/gitFetch.preload.js";
import {
  buildFilesTrashPreloadBindings,
  buildGitDiscardPreloadBindings,
} from "./ipc/handlers/fileMutation.preload.js";
import { buildSlashCommandsPreloadBindings } from "./ipc/handlers/slashCommands.preload.js";
import { buildGlobalEnvPreloadBindings } from "./ipc/handlers/globalEnv.preload.js";
import { buildAccessibilityPreloadBindings } from "./ipc/handlers/accessibility.preload.js";
import { buildConfigBundlePreloadBindings } from "./ipc/handlers/configBundle.preload.js";
import { buildHelpPreloadBindings } from "./ipc/handlers/help.preload.js";
import { buildEventInspectorPreloadBindings } from "./ipc/handlers/eventInspector.preload.js";
import { buildPortalPreloadBindings } from "./ipc/handlers/portal.preload.js";
import { buildDevPreviewPreloadBindings } from "./ipc/handlers/devPreview.preload.js";
import { buildPluginPreloadBindings } from "./ipc/handlers/plugin.preload.js";
import { buildPluginMcpPreloadBindings } from "./ipc/handlers/pluginMcp.preload.js";
import { buildPluginCapabilityPreloadBindings } from "./ipc/handlers/pluginCapability.preload.js";
import { buildPluginProcessPreloadBindings } from "./ipc/handlers/pluginProcess.preload.js";
import { buildPluginPanelCapturePreloadBindings } from "./ipc/handlers/pluginPanelCapture.preload.js";
import { buildPluginProjectPresencePreloadBindings } from "./ipc/handlers/pluginProjectPresence.preload.js";
import { buildPluginMetricsPreloadBindings } from "./ipc/handlers/pluginMetrics.preload.js";
import { buildScratchPreloadBindings } from "./ipc/handlers/scratch/preload.js";
import { buildMcpServerPreloadBindings } from "./ipc/handlers/mcpServer.preload.js";
import { buildVoiceInputPreloadBindings } from "./ipc/handlers/voiceInput.preload.js";
import { buildForgeAuditPreloadBindings } from "./ipc/handlers/forgeAudit.preload.js";
import { buildProjectGroupsPreloadBindings } from "./ipc/handlers/projectGroups.preload.js";
import { buildRunHistoryPreloadBindings } from "./ipc/handlers/runHistory.preload.js";
import { buildCopyTreeHistoryPreloadBindings } from "./ipc/handlers/copyTreeHistory.preload.js";
import { buildScheduledRunsPreloadBindings } from "./ipc/handlers/scheduledRuns.preload.js";
import { buildGeminiPreloadBindings } from "./ipc/handlers/gemini.preload.js";
import { buildCodexPreloadBindings } from "./ipc/handlers/codex.preload.js";
import { buildClaudePreloadBindings } from "./ipc/handlers/claude.preload.js";
import { buildVoiceDictionaryPreloadBindings } from "./ipc/handlers/voiceDictionary.preload.js";
import { buildRecentDictationsPreloadBindings } from "./ipc/handlers/recentDictations.preload.js";
import { buildOnboardingPreloadBindings } from "./ipc/handlers/onboarding.preload.js";
import { buildShortcutHintsPreloadBindings } from "./ipc/handlers/shortcutHints.preload.js";
import { buildForgeRecommendationPreloadBindings } from "./ipc/handlers/forgeRecommendation.preload.js";
import { buildForgeCredentialImportPreloadBindings } from "./ipc/handlers/forgeCredentialImport.preload.js";
import { buildSentryPreloadBindings } from "./ipc/handlers/sentry.preload.js";
import { buildPrivacyPreloadBindings } from "./ipc/handlers/privacy.preload.js";
import { buildRemoteHostsPreloadBindings } from "./ipc/handlers/remoteHosts.preload.js";
import { buildHostModePreloadBindings } from "./ipc/handlers/hostMode.preload.js";
import { buildDeviceAnswerPreloadBindings } from "./ipc/handlers/deviceAnswer.preload.js";
import { buildDriveLeasePreloadBindings } from "./ipc/handlers/driveLease.preload.js";
import { buildOperationsPreloadBindings } from "./ipc/handlers/operations.preload.js";
import { buildHostFilesPreloadBindings } from "./ipc/handlers/hostFiles.preload.js";
import { buildFileTransferPreloadBindings } from "./ipc/handlers/fileTransfer.preload.js";
import { buildHostSwitchPreloadBindings } from "./ipc/handlers/hostSwitch.preload.js";
import { buildProjectMatchPreloadBindings } from "./ipc/handlers/projectMatch.preload.js";
import { buildHostMetricsPreloadBindings } from "./ipc/handlers/hostMetrics.preload.js";
import { buildCanopyHostPreloadBindings } from "./ipc/handlers/canopyHost.preload.js";
import { buildPortForwardsPreloadBindings } from "./ipc/handlers/portForwards.preload.js";
import { buildPluginParityPreloadBindings } from "./ipc/handlers/pluginParity.preload.js";
import { buildSettingsCopyPreloadBindings } from "./ipc/handlers/settingsCopy.preload.js";
import { buildHostSettingsPreloadBindings } from "./ipc/handlers/hostSettings.preload.js";
import { buildTelemetryPreloadBindings } from "./ipc/handlers/telemetry.preload.js";
import { buildConnectivityPreloadBindings } from "./ipc/handlers/connectivity.preload.js";
import { buildProjectPresencePreloadBindings } from "./ipc/handlers/projectPresence.preload.js";
import { buildProjectPresentationPreloadBindings } from "./ipc/handlers/projectPresentation.preload.js";
import { buildProjectThemePreloadBindings } from "./ipc/handlers/projectTheme.preload.js";
import { buildWorktreeTitlesPreloadBindings } from "./ipc/handlers/worktreeTitles.preload.js";
import { buildReviewMarksPreloadBindings } from "./ipc/handlers/reviewMarks.preload.js";
import { buildSchedulesPreloadBindings } from "./ipc/handlers/schedules.preload.js";
import { buildDecisionsPreloadBindings } from "./ipc/handlers/decisions.preload.js";
import { buildDiffMediaPreloadBindings } from "./ipc/handlers/diffMedia.preload.js";
import { buildFileDocumentPreloadBindings } from "./ipc/handlers/fileDocument.preload.js";
import { buildFileBrowserPreloadBindings } from "./ipc/handlers/fileBrowser.preload.js";
import { buildFileWatchPreloadBindings } from "./ipc/handlers/fileWatch.preload.js";
import { buildSessionRestorePreloadBindings } from "./ipc/handlers/sessionRestore.preload.js";
import { buildWindowOpeningPreloadBindings } from "./ipc/handlers/windowOpening.preload.js";
import { buildKeepAwakePreloadBindings } from "./ipc/handlers/keepAwake.preload.js";
import { buildIdleTerminalPreloadBindings } from "./ipc/handlers/idleTerminals.preload.js";
import { buildIdleBackgroundAutoClosePreloadBindings } from "./ipc/handlers/idleBackgroundAutoClose.preload.js";
import { buildSystemSleepPreloadBindings } from "./ipc/handlers/systemSleep.preload.js";
import { buildAppVersionInfoPreloadBindings } from "./ipc/handlers/appVersionInfo.preload.js";
import { buildResourceProfilePreloadBindings } from "./ipc/handlers/resourceProfile.preload.js";
import { buildWhySlowPreloadBindings } from "./ipc/handlers/whySlow.preload.js";
import { buildMemoryPressurePreloadBindings } from "./ipc/handlers/memoryPressure.preload.js";
import { buildOsDndPreloadBindings } from "./ipc/handlers/osDnd.preload.js";
import { buildAgentCapabilitiesPreloadBindings } from "./ipc/handlers/agentCapabilities.preload.js";
import { buildHelpAssistantPreloadBindings } from "./ipc/handlers/helpAssistant.preload.js";
import { buildMenuPreloadBindings } from "./ipc/handlers/menu.preload.js";
import { buildCliPreloadBindings } from "./ipc/handlers/cli.preload.js";
import { buildWorkspaceResidencyPreloadBindings } from "./ipc/handlers/workspaceResidency.preload.js";
import { buildProcessesPreloadBindings } from "./ipc/handlers/processes.preload.js";
import { buildPluginAgentMcpPreloadBindings } from "./ipc/handlers/pluginAgentMcp.preload.js";
import { buildGlobalRecipesPreloadBindings } from "./ipc/handlers/globalRecipes.preload.js";
import { buildAgentDefaultsPreloadBindings } from "./ipc/handlers/agentDefaults.preload.js";
import { buildAgentToolbarPinsPreloadBindings } from "./ipc/handlers/agentToolbarPins.preload.js";
import { buildEditorConfigPreloadBindings } from "./ipc/handlers/editorConfig.preload.js";
import { buildWindowChromePreloadBindings } from "./ipc/handlers/windowChrome.preload.js";
import { buildFleetPreloadBindings } from "./ipc/handlers/fleet.preload.js";
import { buildCanopyPreloadBindings } from "./ipc/handlers/canopy.preload.js";
import { buildProjectHistoryPreloadBindings } from "./ipc/handlers/projectHistory.preload.js";
import { buildWorkspacePreloadBindings } from "./ipc/handlers/workspace.preload.js";
import { buildProjectRelocationPreloadBindings } from "./ipc/handlers/projectRelocation.preload.js";
import { buildPaintFabricSurfacePreloadBindings } from "./ipc/handlers/paintFabricSurface.preload.js";
import { buildWebviewNavigationPreloadBindings } from "./ipc/handlers/webviewNavigation.preload.js";
import { buildWebviewCapturePreloadBindings } from "./ipc/handlers/webviewCapture.preload.js";
import { buildSitePreviewPreloadBindings } from "./ipc/handlers/sitePreview.preload.js";
import { buildElementPickerPreloadBindings } from "./ipc/handlers/elementPicker.preload.js";
import { buildWebviewEmulationPreloadBindings } from "./ipc/handlers/webviewEmulation.preload.js";
import { buildWorktreeConfigPreloadBindings } from "./ipc/handlers/worktreeConfig.preload.js";
import { buildTerminalLayoutPreloadBindings } from "./ipc/handlers/terminalLayout.preload.js";
import { buildTerminalConfigPreloadBindings } from "./ipc/handlers/terminalConfig.preload.js";

import type {
  Project,
  ProjectAddOptions,
  ProjectSettings,
  TerminalSpawnOptions,
  CopyTreeOptions,
  CopyTreeProgress,
  CopyTreeRunSource,
  CopyTreeStopReason,
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
  WorktreeCreateResult,
  IpcInvokeMap,
  IpcEventMap,
  IpcEventBusMap,
  AgentSettings,
  AgentSettingsEntry,
  PanelGridConfig,
  ResumeOnRestart,
  PRDetectedPayload,
  PRClearedPayload,
  IssueDetectedPayload,
  IssueNotFoundPayload,
  ServiceConnectivityPayload,
  AgentDefaultsSnapshot,
  TerminalConfigChange,
  AgentToolbarPinsSnapshot,
  GitStatus,
  KeyAction,
  TerminalRecipe,
  RecipeNameCollision,
  AttachIssuePayload,
  IssueAssociation,
  VoiceInputError,
  VoiceInputStatus,
  VoiceLiveSessionUpdate,
  VoiceLiveLevel,
  VoicePauseRequest,
  VoiceRevealRequest,
  VoiceSessionEndReason,
  VoiceStopRequest,
} from "../shared/types/index.js";
import type { ColorVisionMode, AppColorScheme } from "../shared/types/appTheme.js";
import type { VoiceSessionReport } from "../shared/types/voiceSessionSummary.js";
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
  DevPreviewStateChangedPayload,
  DevPreviewAllSessionsPayload,
} from "../shared/types/ipc.js";
import type {
  ElementPickerPushPayload,
  ElementPickerSourceChangedPush,
} from "../shared/types/ipc/elementPicker.js";
import type { TerminalActivityPayload } from "../shared/types/terminal.js";
import type { PaneNotifyState } from "../shared/types/terminalNotify.js";
import type {
  TerminalStatusPayload,
  TerminalSubmitStatusPayload,
  TerminalFirstPromptPayload,
  SpawnResult,
  TerminalResourceBatchPayload,
  BroadcastWriteResultPayload,
  TerminalReliabilityMetricPayload,
  TerminalResizeResult,
} from "../shared/types/pty-host.js";

type SpawnResultPayload = SpawnResult;
import type { ResourceProfilePayload } from "../shared/types/resourceProfile.js";
import type {
  PluginActionDescriptor,
  PluginKeybindingDescriptor,
  ContextMenuContribution,
  PluginArchiveInstallIntent,
  PluginDeepLinkIntent,
  PluginPanelBadge,
  PluginPanelActivityReport,
  PluginTaskSnapshot,
  PluginToolbarButtonRuntimeState,
  PluginContextValue,
  PluginWorktreeCardStatus,
  PluginWorktreeReviewCheck,
  PluginTerminalStatus,
  PluginFocusedPanel,
  PluginProjectPresence,
} from "../shared/types/plugin.js";
import type { PanelKindConfig } from "../shared/config/panelKindRegistry.js";
import type { PublishedPanelMenuItem } from "../shared/utils/pluginPanelMenuItems.js";
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

// The host a remote view is attached to. Absent for local views, so the
// initial project id above is this machine's own and nothing else changes.
const HOST_ID_ARG = "--daintree-host-id=";
const viewHostId = process.argv.find((a) => a.startsWith(HOST_ID_ARG))?.slice(HOST_ID_ARG.length);

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

const worktreePortClient = connectWorktreePortClient(ipcRenderer);

/**
 * Reconstruct `AppError` thrown in the main process. Electron's contextBridge
 * deep-clones Error instances when they cross the preload→renderer realm
 * boundary and strips ALL custom properties — including own `name` and any
 * added fields like `code`. Only `message` and `stack` survive. The encoded
 * prefix below is decoded by the renderer-side `isClientAppError` guard
 * (`src/utils/clientAppError.ts`), which restores `e.name`, `e.code`,
 * `e.userMessage`, `e.details`, and the cleaned `e.message` on the caught
 * error.
 *
 * Format: `[AppError|<code>] <original message>`
 *      or `[AppError|<code>|<urlencoded userMessage>] <original message>`
 * An optional `|#<urlencoded JSON details>` segment follows the code and any
 * userMessage.
 */
function _reconstructAppError(serialized: {
  name: string;
  message: string;
  code?: string;
  userMessage?: string;
  details?: unknown;
}): Error {
  const code = serialized.code ?? "UNKNOWN";
  const userMsgPart =
    serialized.userMessage !== undefined ? `|${encodeURIComponent(serialized.userMessage)}` : "";
  let detailsPart = "";
  if (serialized.details !== undefined && serialized.details !== null) {
    try {
      detailsPart = `|#${encodeURIComponent(JSON.stringify(serialized.details))}`;
    } catch {
      detailsPart = "";
    }
  }
  const encoded = `[AppError|${code}${userMsgPart}${detailsPart}] ${serialized.message}`;
  const error = new Error(encoded);
  // Standard properties — set for callers in the same realm. They don't
  // survive the contextBridge crossing; the message prefix is the source
  // of truth on the renderer side.
  error.name = "AppError";
  (error as Error & { code: AppErrorCode }).code = serialized.code as AppErrorCode;
  if (serialized.userMessage !== undefined) {
    (error as Error & { userMessage: string }).userMessage = serialized.userMessage;
  }
  if (serialized.details !== undefined) {
    (error as Error & { details: unknown }).details = serialized.details;
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

/**
 * Reconstruct `HelpSessionError` thrown by help-session provisioning. Same
 * realm-boundary stripping as `_reconstructAppError`: contextBridge discards
 * the custom `code`, so it rides an encoded message prefix that the renderer
 * decodes via `extractHelpSessionErrorCode` (`src/utils/clientHelpSessionError.ts`).
 *
 * Format: `[HelpSessionError|<code>] <original message>`
 */
function _reconstructHelpSessionError(serialized: {
  name: string;
  message: string;
  code?: string;
}): Error {
  const code = serialized.code ?? "UNKNOWN";
  const error = new Error(`[HelpSessionError|${code}] ${serialized.message}`);
  // Standard properties — set for callers in the same realm. They don't
  // survive the contextBridge crossing; the message prefix is the source
  // of truth on the renderer side.
  error.name = "HelpSessionError";
  (error as Error & { code: string }).code = code;
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
      if (serialized.name === "HelpSessionError" && typeof serialized.code === "string") {
        throw _reconstructHelpSessionError(serialized);
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

/**
 * Latched view-cache state, tracked from preload evaluation onward (#11212).
 *
 * The app:view-* signals are non-replaying `ipcRenderer.on` edges, and main
 * releases a cold switch at the pre-React skeleton — so a switch storm can
 * cache a view long before its deferred module graph evaluates and subscribes,
 * and the renderer would never learn it is cached. Preload runs before any page
 * script, so latching here gives a late subscriber an authoritative snapshot to
 * seed from instead of defaulting to "not cached" and running the full-rate
 * terminal work this issue exists to stop.
 */
let _viewCached = false;
// Blink's memory cache keeps every script the view has loaded, about 25 MB of
// source per view, and nothing re-reads it: loaded modules live in the module
// map. Dropping it saves ~30 MB per cached view, and the view stays smaller
// after it returns (#14219). Live images and fonts are held by their elements.
// clearCache() also raises critical memory pressure in this renderer, so it
// waits out a quick switch back and never runs once the view is active again.
// A view the efficiency profile freezes inside the delay keeps its cache.
const CACHED_VIEW_CACHE_CLEAR_DELAY_MS = 2_000;
let _cacheClearTimer: ReturnType<typeof setTimeout> | null = null;
// A full collection of what the view left behind in the foreground, run in its
// first idle period after caching, while nobody is looking at it. Renderers get
// `gc` from `--expose-gc` (main.ts), in this world as well as the page's.
const CACHED_VIEW_GC_IDLE_TIMEOUT_MS = 1_000;
let _cachedViewGcHandle: number | null = null;
// Set by the page's `freeze` event, cleared when the view is active again. A
// frozen renderer's overdue timers and idle callbacks run the moment
// activation thaws it, ahead of the warm-activated IPC that would clear
// `_viewCached` (#15680), so cached-time reclaim is cancelled when the freeze
// lands and never scheduled after one. IPC still runs while frozen, so a
// cached signal can arrive after the freeze. Nothing marks the thaw itself:
// `resume` does not fire for main's CDP unfreeze. The main-side purge session
// still collects a view that stays cached.
let _viewFrozenSinceActive = false;

function cancelCachedViewReclaim(): void {
  if (_cacheClearTimer !== null) {
    clearTimeout(_cacheClearTimer);
    _cacheClearTimer = null;
  }
  if (_cachedViewGcHandle !== null) {
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(_cachedViewGcHandle);
    _cachedViewGcHandle = null;
  }
}

function scheduleCachedViewReclaim(): void {
  cancelCachedViewReclaim();
  if (_viewFrozenSinceActive) return;
  _cacheClearTimer = setTimeout(() => {
    _cacheClearTimer = null;
    if (!_viewCached) return;
    try {
      webFrame.clearCache();
    } catch {
      // Best-effort reclaim; a renderer mid-teardown has nothing to free.
    }
  }, CACHED_VIEW_CACHE_CLEAR_DELAY_MS);
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function" || typeof requestIdleCallback !== "function") return;
  _cachedViewGcHandle = requestIdleCallback(
    () => {
      _cachedViewGcHandle = null;
      if (!_viewCached) return;
      gc();
    },
    { timeout: CACHED_VIEW_GC_IDLE_TIMEOUT_MS }
  );
}

function onViewActiveAgain(): void {
  _viewCached = false;
  _viewFrozenSinceActive = false;
  cancelCachedViewReclaim();
}

// Suites that evaluate this bundle against a bare fake `window` have no DOM.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("freeze", () => {
    _viewFrozenSinceActive = true;
    cancelCachedViewReclaim();
  });
}
/**
 * Work that persists unsaved edits when this view is cached (#15633), run here
 * rather than by `_typedOn` subscribers so their promises can be awaited. Main
 * holds the view unfrozen and resident only while this is non-empty, and lets
 * go when the edge's flush id comes back.
 */
const _viewCachedFlushers = new Set<() => unknown>();
ipcRenderer.on(CHANNELS.APP_VIEW_CACHED, (_event, payload?: { flushId?: unknown }) => {
  _viewCached = true;
  const flushes = Array.from(_viewCachedFlushers, (flush) => {
    try {
      return flush();
    } catch (error) {
      return Promise.reject(error);
    }
  });
  // Settled even when main isn't waiting, so a failed flush never goes unhandled.
  const flushId = payload?.flushId;
  void Promise.allSettled(flushes).then(() => {
    if (typeof flushId === "string") ipcRenderer.send(CHANNELS.APP_VIEW_CACHED_FLUSHED, flushId);
  });
  // Best-effort and last: it must never keep the edits from flushing, main from
  // hearing back, or the view's own cached-edge listeners from running.
  try {
    scheduleCachedViewReclaim();
  } catch {
    // A renderer mid-teardown has nothing worth reclaiming.
  }
});
// Warm activation — not reveal — owns the clear: main only sends
// APP_VIEW_REVEALED while the view is still the active project, so a superseded
// switch delivers warm-activated alone. Reveal clears too, defensively.
ipcRenderer.on(CHANNELS.APP_VIEW_WARM_ACTIVATED, onViewActiveAgain);
ipcRenderer.on(CHANNELS.APP_VIEW_REVEALED, onViewActiveAgain);

// Wired eagerly at creation: see createEventBus.
const { on: _eventBusOn } = createEventBus(ipcRenderer);
const { on: _terminalDataOn } = createTerminalDataMultiplexer(ipcRenderer);
const {
  on: _pluginPushOn,
  invoke: _pluginInvoke,
  pluginsWithPushDeliveriesDuring: _pluginsWithPushDeliveriesDuring,
} = createPluginPushTransport(ipcRenderer, _unwrappingInvoke);

// One main-side subscription per preload, however many listeners the page adds.
const _perfSnapshotListeners = new Set<(snapshots: PluginPerfSnapshot[]) => void>();
let _perfSnapshotDetach: (() => void) | null = null;

function _onPerfSnapshotsChanged(callback: (snapshots: PluginPerfSnapshot[]) => void): () => void {
  _perfSnapshotListeners.add(callback);
  if (!_perfSnapshotDetach) {
    _perfSnapshotDetach = _typedOn(CHANNELS.PLUGIN_PERF_SNAPSHOTS_CHANGED, (snapshots) => {
      for (const listener of [..._perfSnapshotListeners]) listener(snapshots);
    });
    ipcRenderer.send(CHANNELS.PLUGIN_PERF_SNAPSHOTS_SUBSCRIBE);
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    _perfSnapshotListeners.delete(callback);
    if (_perfSnapshotListeners.size > 0 || !_perfSnapshotDetach) return;
    _perfSnapshotDetach();
    _perfSnapshotDetach = null;
    ipcRenderer.send(CHANNELS.PLUGIN_PERF_SNAPSHOTS_UNSUBSCRIBE);
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

      getAllWithStatus: () => _unwrappingInvoke(CHANNELS.WORKTREE_GET_ALL_WITH_STATUS),

      refresh: (worktreeId?: string) => _unwrappingInvoke(CHANNELS.WORKTREE_REFRESH, worktreeId),

      refreshPullRequests: () => _unwrappingInvoke(CHANNELS.WORKTREE_PR_REFRESH),

      getPRStatus: () => _unwrappingInvoke(CHANNELS.WORKTREE_PR_STATUS),

      setActive: (worktreeId: string) =>
        _unwrappingInvoke(CHANNELS.WORKTREE_SET_ACTIVE, { worktreeId }),

      create: (
        options: CreateWorktreeOptions,
        rootPath: string,
        opId?: string
      ): Promise<WorktreeCreateResult> =>
        _unwrappingInvoke(CHANNELS.WORKTREE_CREATE, {
          rootPath,
          options,
          ...(opId !== undefined ? { opId } : {}),
        }),

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

      submit: (
        id: string,
        text: string,
        submissionToken?: string,
        handbackCode?: string,
        imagePaths?: string[]
      ) =>
        imagePaths === undefined
          ? _unwrappingInvoke(CHANNELS.TERMINAL_SUBMIT, id, text, submissionToken, handbackCode)
          : _unwrappingInvoke(
              CHANNELS.TERMINAL_SUBMIT,
              id,
              text,
              submissionToken,
              handbackCode,
              imagePaths
            ),

      /**
       * Resolve one submission token across several terminals (#12337). A
       * terminal that was read but holds no record maps to `null`, which the
       * caller reports as the `unknown` phase.
       */
      getSubmissions: (terminalIds: string[], submissionToken: string) =>
        _unwrappingInvoke(CHANNELS.TERMINAL_GET_SUBMISSIONS, terminalIds, submissionToken),

      /** Read `lastOutputChangeAt` across several terminals (#12495). */
      getOutputActivity: (terminalIds: string[]) =>
        _unwrappingInvoke(CHANNELS.TERMINAL_GET_OUTPUT_ACTIVITY, terminalIds),

      resize: (id: string, cols: number, rows: number) =>
        ipcRenderer.send(CHANNELS.TERMINAL_RESIZE, { id, cols, rows }),

      kill: (id: string, options?: TerminalKillOptions) =>
        options
          ? _unwrappingInvoke(CHANNELS.TERMINAL_KILL, id, options)
          : _unwrappingInvoke(CHANNELS.TERMINAL_KILL, id),
      gracefulKill: (id: string, options?: TerminalKillOptions) =>
        options
          ? _unwrappingInvoke(CHANNELS.TERMINAL_GRACEFUL_KILL, id, options)
          : _unwrappingInvoke(CHANNELS.TERMINAL_GRACEFUL_KILL, id),

      // Tuple payload [id, data] dispatched via the shared multiplexer above
      // Accepts both string and Uint8Array/Buffer (binary optimization for reduced GC pressure)
      onData: (id: string, callback: (data: string | Uint8Array, streamEnd?: number) => void) =>
        _terminalDataOn(id, callback),

      onExit: (callback: (id: string, exitCode: number, context?: TerminalExitContext) => void) =>
        _eventBusOn("terminal:exit", (payload) => {
          if (!Array.isArray(payload)) return;
          const [id, exitCode, context] = payload;
          if (typeof id !== "string" || typeof exitCode !== "number") return;
          if (context?.preserveSession === true) {
            callback(id, exitCode, { preserveSession: true });
          } else {
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

      onAllAgentsClear: (callback: (data: { timestamp: number; shouldFlash: boolean }) => void) =>
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

      getSerializedState: (terminalId: string, options?: { tailRows?: number }) =>
        options === undefined
          ? _unwrappingInvoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, terminalId)
          : _unwrappingInvoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATE, terminalId, options),

      getSerializedStates: (terminalIds: string[]) =>
        _unwrappingInvoke(CHANNELS.TERMINAL_GET_SERIALIZED_STATES, terminalIds),

      getInfo: (id: string) => _unwrappingInvoke(CHANNELS.TERMINAL_GET_INFO, id),

      locate: (id: string) => _unwrappingInvoke(CHANNELS.TERMINAL_LOCATE, id),

      getSharedBuffers: (): Promise<{
        visualBuffers: SharedArrayBuffer[];
        signalBuffer: SharedArrayBuffer | null;
      }> => _unwrappingInvoke(CHANNELS.TERMINAL_GET_SHARED_BUFFERS),

      forceResume: (id: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.TERMINAL_FORCE_RESUME, id),

      getHostMemoryPause: (): Promise<HostMemoryPauseSnapshot> =>
        _unwrappingInvoke(CHANNELS.TERMINAL_GET_HOST_MEMORY_PAUSE),

      requestWorkerIngestPort: (id: string): Promise<{ token: string } | null> =>
        _unwrappingInvoke(CHANNELS.TERMINAL_REQUEST_WORKER_INGEST_PORT, id),

      releaseWorkerIngestPort: (id: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.TERMINAL_RELEASE_WORKER_INGEST_PORT, id),

      onStatus: (callback: (data: TerminalStatusPayload) => void) =>
        _typedOn(CHANNELS.TERMINAL_STATUS, callback),

      onSubmitStatus: (callback: (data: TerminalSubmitStatusPayload) => void): (() => void) =>
        _eventBusOn("terminal:submit-status", callback),

      onFirstPrompt: (callback: (data: TerminalFirstPromptPayload) => void): (() => void) =>
        _eventBusOn("terminal:first-prompt", callback),

      onNotifyState: (callback: (data: PaneNotifyState) => void): (() => void) =>
        _eventBusOn("terminal:notify-state", callback),

      onReliabilityMetric: (
        callback: (data: TerminalReliabilityMetricPayload) => void
      ): (() => void) => _eventBusOn("terminal:reliability-metric", callback),

      onResizeResult: (
        callback: (id: string, result: TerminalResizeResult) => void
      ): (() => void) =>
        _eventBusOn("terminal:resize-result", ([id, result]) => callback(id, result)),

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

      broadcastWrite: (ids: string[], data: string, reportSuccess?: boolean) =>
        ipcRenderer.send(CHANNELS.TERMINAL_BROADCAST_WRITE, ids, data, reportSuccess === true),

      onBroadcastWriteResult: (callback: (data: BroadcastWriteResultPayload) => void) =>
        _typedOn(CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT, callback),

      reportTitleState: (id: string, state: "working" | "waiting") =>
        ipcRenderer.send(CHANNELS.TERMINAL_AGENT_TITLE_STATE, { id, state }),

      updateObservedTitle: (id: string, title: string) =>
        ipcRenderer.send(CHANNELS.TERMINAL_UPDATE_OBSERVED_TITLE, { id, title }),

      updateTitle: (id: string, title: string, titleMode: PanelTitleMode) =>
        ipcRenderer.send(CHANNELS.TERMINAL_UPDATE_TITLE, { id, title, titleMode }),

      updateWorktreeId: (id: string, worktreeId: string | null) =>
        ipcRenderer.send(CHANNELS.TERMINAL_UPDATE_WORKTREE_ID, { id, worktreeId }),

      onSpawnResult: (callback: (id: string, result: SpawnResultPayload) => void): (() => void) =>
        _eventBusOn("terminal:spawn-result", (payload) => {
          if (!Array.isArray(payload)) return;
          const [id, result] = payload;
          if (typeof id === "string" && typeof result === "object" && result !== null) {
            callback(id, result as SpawnResultPayload);
          }
        }),

      onReduceScrollback: (callback: (data: { targetLines: number }) => void) =>
        _typedOn(CHANNELS.TERMINAL_REDUCE_SCROLLBACK, callback),

      onRestoreScrollback: (callback: (data: { terminalIds: string[] }) => void) =>
        _typedOn(CHANNELS.TERMINAL_RESTORE_SCROLLBACK, callback),

      restartService: (): Promise<void> => _unwrappingInvoke(CHANNELS.TERMINAL_RESTART_SERVICE),

      onReclaimMemory: (callback: () => void) =>
        _eventBusOn("window:reclaim-memory", () => callback()),

      onHostMemoryPause: (callback: (snapshot: HostMemoryPauseSnapshot) => void) =>
        _eventBusOn("terminal:host-memory-pause", callback),
    },

    // Files API
    files: {
      search: (payload) => _unwrappingInvoke(CHANNELS.FILES_SEARCH, payload),
      read: (payload) => _unwrappingInvoke(CHANNELS.FILES_READ, payload),
      ...buildFilesTrashPreloadBindings(_unwrappingInvoke),
      // The one bridge from a dropped or pasted `File` to its native path.
      // `webUtils.getPathForFile` has to run here (Electron 32 removed
      // `File.path`), and it is exposed only as this purpose-named batch call
      // rather than as `webUtils` itself. That narrows the surface; it is not
      // isolation. Plugin views render inline in this same document, so any
      // code in the page can still call it — separating them would need a
      // context of their own. `""` for a File with nothing on disk behind it.
      // The paths are also recorded in main as files the person chose here:
      // a remote-bound view's upload reads only those, and a local plugin view
      // imports only those as artifacts.
      getDroppedFilePaths: buildDroppedFilePathsBinding<File>(
        (file) => webUtils.getPathForFile(file),
        (paths) => ipcRenderer.send(CHANNELS.FILE_TRANSFER_GRANT_LOCAL_SOURCES, paths)
      ),
    },

    // Diff media API — HEAD vs working-tree image versions for image compare
    diffMedia: buildDiffMediaPreloadBindings(_unwrappingInvoke),

    // Host-owned document for view-backed file editors (#13809).
    fileDocument: buildFileDocumentPreloadBindings(_unwrappingInvoke),

    // File browser API — lazy directory listings for the read-only browser panel
    fileBrowser: buildFileBrowserPreloadBindings(_unwrappingInvoke),

    // File watch API — the change signal for paths no git watcher covers
    fileWatch: buildFileWatchPreloadBindings(_unwrappingInvoke),

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
      generate: (
        worktreeId: string,
        options?: CopyTreeOptions,
        includeContent?: boolean,
        source?: CopyTreeRunSource,
        name?: string
      ) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_GENERATE, {
          worktreeId,
          options,
          includeContent,
          source,
          name,
        }),

      generateAndCopyFile: (
        worktreeId: string | undefined,
        options?: CopyTreeOptions,
        source?: CopyTreeRunSource,
        name?: string
      ) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE, {
          worktreeId,
          options,
          source,
          name,
        }),

      injectToTerminal: (
        terminalId: string,
        worktreeId: string,
        options?: CopyTreeOptions,
        injectionId?: string,
        source?: CopyTreeRunSource,
        name?: string
      ) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_INJECT, {
          terminalId,
          worktreeId,
          options,
          injectionId,
          source,
          name,
        }),

      isAvailable: () => _unwrappingInvoke(CHANNELS.COPYTREE_AVAILABLE),

      cancel: (injectionId?: string, reason?: CopyTreeStopReason) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_CANCEL, { injectionId, reason }),

      getFileTree: (worktreeId: string, dirPath?: string, includeExcluded?: boolean) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_GET_FILE_TREE, {
          worktreeId,
          dirPath,
          includeExcluded,
        }),

      testConfig: (worktreeId: string, options?: CopyTreeTestConfigOptions) =>
        _unwrappingInvoke(CHANNELS.COPYTREE_TEST_CONFIG, { worktreeId, options }),

      onProgress: (callback: (progress: CopyTreeProgress) => void) =>
        _typedOn(CHANNELS.COPYTREE_PROGRESS, callback),
    },

    // Editor API
    editor: buildEditorConfigPreloadBindings(_unwrappingInvoke),

    // Native window chrome — keeps the Windows caption strip in step with the
    // global banner occupying the same band (#11766)
    windowChrome: buildWindowChromePreloadBindings(_unwrappingInvoke),

    // Per-window back/forward over visited projects
    projectHistory: buildProjectHistoryPreloadBindings(_unwrappingInvoke),
    workspace: buildWorkspacePreloadBindings(_unwrappingInvoke),

    // Move or rename project — preview + apply (#11282, phase 4)
    projectRelocation: buildProjectRelocationPreloadBindings(_unwrappingInvoke),

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

      healthCheck: (options?: import("../shared/types/ipc/system.js").SystemHealthCheckOptions) =>
        _unwrappingInvoke(CHANNELS.SYSTEM_HEALTH_CHECK, options),

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

      installAgent: (payload: import("../shared/types/ipc/system.js").AgentInstallPayload) =>
        _unwrappingInvoke(CHANNELS.SETUP_AGENT_INSTALL, payload),

      onAgentInstallProgress: (
        callback: (event: { jobId: string; chunk: string; stream: "stdout" | "stderr" }) => void
      ) => _typedOn(CHANNELS.SETUP_AGENT_INSTALL_PROGRESS, callback),

      onResourceProfileChanged: (callback: (payload: ResourceProfilePayload) => void) =>
        _eventBusOn("resource:profile-changed", callback),

      ...buildResourceProfilePreloadBindings(_unwrappingInvoke),

      ...buildWhySlowPreloadBindings(_unwrappingInvoke),

      ...buildMemoryPressurePreloadBindings(_unwrappingInvoke),
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

      onMenuAction: (
        callback: (payload: { actionId: string; args?: unknown; portalActionId?: string }) => void
      ) => _typedOn(CHANNELS.MENU_ACTION, callback),

      reloadConfig: () => _unwrappingInvoke(CHANNELS.APP_RELOAD_CONFIG),

      onConfigReloaded: (callback: () => void) => _typedOn(CHANNELS.APP_CONFIG_RELOADED, callback),

      onPanelGridConfigChanged: (callback: (config: PanelGridConfig) => void) =>
        _typedOn(CHANNELS.APP_PANEL_GRID_CONFIG_CHANGED, callback),

      onViewRevealed: (callback: (payload?: { switchId?: string }) => void) =>
        _typedOn(CHANNELS.APP_VIEW_REVEALED, callback),
      onViewWarmActivated: (callback: (payload?: { switchId?: string }) => void) =>
        _typedOn(CHANNELS.APP_VIEW_WARM_ACTIVATED, callback),
      onViewCached: (callback: () => void) => _typedOn(CHANNELS.APP_VIEW_CACHED, callback),
      isViewCached: () => _viewCached,
      onViewCachedFlush: (callback: () => unknown) => {
        // Wrapped so registering the same function twice still unsubscribes each.
        const flush = () => callback();
        _viewCachedFlushers.add(flush);
        if (_viewCachedFlushers.size === 1) {
          ipcRenderer.send(CHANNELS.APP_VIEW_CACHED_FLUSH_ARMED, true);
        }
        return () => {
          if (!_viewCachedFlushers.delete(flush)) return;
          if (_viewCachedFlushers.size === 0) {
            ipcRenderer.send(CHANNELS.APP_VIEW_CACHED_FLUSH_ARMED, false);
          }
        };
      },
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

      // Forward the optional options bag only when present — an open-existing-repo
      // add stays a one-argument invoke, byte-identical to before.
      add: (path: string, options?: ProjectAddOptions) =>
        options
          ? _unwrappingInvoke(CHANNELS.PROJECT_ADD, path, options)
          : _unwrappingInvoke(CHANNELS.PROJECT_ADD, path),

      remove: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_REMOVE, projectId),

      update: (projectId: string, updates: Partial<Project>) =>
        _unwrappingInvoke(CHANNELS.PROJECT_UPDATE, projectId, updates),

      switch: (
        projectId: string,
        outgoingState?: import("../shared/types/ipc/project.js").ProjectSwitchOutgoingState,
        options?: {
          focusIntent?: import("../shared/types/ipc/project.js").ProjectFocusOnActivateIntent;
          trace?: import("../shared/types/ipc/project.js").ProjectSwitchTrace;
          ignoreMemoryPressure?: boolean;
        }
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

      onOpenGitInitDialog: (callback: (payload: { directoryPath: string }) => void) =>
        _typedOn(CHANNELS.PROJECT_OPEN_GIT_INIT_DIALOG, callback),

      onFocusOnActivate: (
        callback: (
          payload: import("../shared/types/ipc/project.js").ProjectFocusOnActivateIntent
        ) => void
      ) => _typedOn(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, callback),

      onPanelRecoveryQuery: (callback: (requestId: string) => void) =>
        _typedOn(CHANNELS.PROJECT_PANEL_RECOVERY_QUERY, callback),

      replyPanelRecovery: (requestId: string, holding: boolean) => {
        ipcRenderer.send(CHANNELS.PROJECT_PANEL_RECOVERY_REPLY, { requestId, holding });
      },

      reportPanelRecoveryState: (holding: boolean) => {
        ipcRenderer.send(CHANNELS.PROJECT_PANEL_RECOVERY_STATE, holding);
      },

      onBackgroundResize: (callback: (payload: { width: number; height: number }) => void) =>
        _typedOn(CHANNELS.PROJECT_BACKGROUND_RESIZE, callback),

      onUpdated: (callback: (project: Project) => void) =>
        _typedOn(CHANNELS.PROJECT_UPDATED, callback),

      onSlept: (callback: (projectId: string) => void) =>
        _typedOn(CHANNELS.PROJECT_SLEPT, callback),

      onRemoved: (callback: (projectId: string) => void) =>
        _typedOn(CHANNELS.PROJECT_REMOVED, callback),

      getSettings: (projectId: string) =>
        _unwrappingInvoke(CHANNELS.PROJECT_GET_SETTINGS, projectId),

      saveSettings: (projectId: string, settings: ProjectSettings) =>
        _unwrappingInvoke(CHANNELS.PROJECT_SAVE_SETTINGS, { projectId, settings }),

      addBrowserAllowedHost: (projectId: string, hostname: string) =>
        _unwrappingInvoke(CHANNELS.PROJECT_ADD_BROWSER_ALLOWED_HOST, { projectId, hostname }),

      detectRunners: (projectId: string) =>
        _unwrappingInvoke(CHANNELS.PROJECT_DETECT_RUNNERS, projectId),

      listRemotes: (cwd: string) => _unwrappingInvoke(CHANNELS.PROJECT_LIST_REMOTES, cwd),

      close: (projectId: string, options?: { killTerminals?: boolean }) =>
        _unwrappingInvoke(CHANNELS.PROJECT_CLOSE, projectId, options),

      sleepProject: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_SLEEP, projectId),

      reopen: (
        projectId: string,
        outgoingState?: import("../shared/types/ipc/project.js").ProjectSwitchOutgoingState,
        options?: {
          trace?: import("../shared/types/ipc/project.js").ProjectSwitchTrace;
          ignoreMemoryPressure?: boolean;
        }
      ) => _unwrappingInvoke(CHANNELS.PROJECT_REOPEN, projectId, outgoingState, options),

      getStats: (projectId: string) => _unwrappingInvoke(CHANNELS.PROJECT_GET_STATS, projectId),

      getBulkStats: (projectIds: string[]) =>
        _unwrappingInvoke(CHANNELS.PROJECT_GET_BULK_STATS, projectIds),

      getNotificationOverrides: (projectIds: string[]) =>
        _unwrappingInvoke(CHANNELS.PROJECT_GET_NOTIFICATION_OVERRIDES, projectIds),

      onStatsUpdated: (
        callback: (stats: import("../shared/types/ipc/project.js").ProjectStatusMap) => void
      ) => _typedOn(CHANNELS.PROJECT_STATS_UPDATED, callback),

      createFolder: (
        parentPath: string,
        folderName: string,
        template?: import("../shared/types/plugin.js").ProjectTemplateSelection
      ): Promise<string> =>
        _unwrappingInvoke(CHANNELS.PROJECT_CREATE_FOLDER, {
          parentPath,
          folderName,
          ...(template !== undefined ? { template } : {}),
        }),

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

      cancelClone: (opId?: string): Promise<void> =>
        _unwrappingInvoke(CHANNELS.PROJECT_CLONE_CANCEL, opId ? { opId } : undefined),

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

    // Fleet-wide run snapshot — every agent run across every workspace, pushed
    // from main. Read-only and broadcast-only: main is the only process that
    // can see past a project view's own V8 context.
    fleet: {
      ...buildFleetPreloadBindings(_unwrappingInvoke),

      onSnapshotUpdated: (
        callback: (snapshot: import("../shared/types/ipc/fleet.js").FleetSnapshot) => void
      ) => _typedOn(CHANNELS.FLEET_SNAPSHOT_UPDATED, callback),
    },

    // Canopy panel cards, built in main from every agent run's screen.
    canopy: {
      ...buildCanopyPreloadBindings(_unwrappingInvoke),

      onSnapshotUpdated: (
        callback: (snapshot: import("../shared/types/ipc/canopy.js").CanopySnapshot) => void
      ) => _typedOn(CHANNELS.CANOPY_SNAPSHOT_UPDATED, callback),

      onTerminalData: (
        callback: (chunk: import("../shared/types/ipc/canopy.js").CanopyTerminalData) => void
      ) => _typedOn(CHANNELS.CANOPY_TERMINAL_DATA, callback),

      onTrashRequested: (
        callback: (request: import("../shared/types/ipc/canopy.js").CanopyTrashRequest) => void
      ) => _typedOn(CHANNELS.CANOPY_TRASH_REQUESTED, callback),

      onRestoreRequested: (
        callback: (request: import("../shared/types/ipc/canopy.js").CanopyRestoreRequest) => void
      ) => _typedOn(CHANNELS.CANOPY_RESTORE_REQUESTED, callback),

      onRemoveRequested: (
        callback: (request: import("../shared/types/ipc/canopy.js").CanopyRemoveRequest) => void
      ) => _typedOn(CHANNELS.CANOPY_REMOVE_REQUESTED, callback),

      onResumeRequested: (
        callback: (request: import("../shared/types/ipc/canopy.js").CanopyResumeRequest) => void
      ) => _typedOn(CHANNELS.CANOPY_RESUME_REQUESTED, callback),

      onRenameRequested: (
        callback: (request: import("../shared/types/ipc/canopy.js").CanopyRenameRequest) => void
      ) => _typedOn(CHANNELS.CANOPY_RENAME_REQUESTED, callback),
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

      setResumeOnRestart: (value: ResumeOnRestart) =>
        _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_SET_RESUME_ON_RESTART, value),

      reset: (agentType?: string) => _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_RESET, agentType),

      stampVersion: (version: number) =>
        _unwrappingInvoke(CHANNELS.AGENT_SETTINGS_STAMP_VERSION, version),

      onChanged: (callback: (settings: AgentSettings) => void) =>
        _typedOn(CHANNELS.AGENT_SETTINGS_CHANGED, callback),
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

    // Host-owned agent defaults (#13345)
    agentDefaults: {
      ...buildAgentDefaultsPreloadBindings(_unwrappingInvoke),

      onChanged: (callback: (snapshot: AgentDefaultsSnapshot) => void) =>
        _typedOn(CHANNELS.AGENT_DEFAULTS_CHANGED, callback),
    },

    // This machine's toolbar agent pins (#14702)
    agentToolbarPins: {
      ...buildAgentToolbarPinsPreloadBindings(_unwrappingInvoke),

      onChanged: (callback: (snapshot: AgentToolbarPinsSnapshot) => void) =>
        _typedOn(CHANNELS.AGENT_TOOLBAR_PINS_CHANGED, callback),
    },

    // Per-service connectivity API
    connectivity: {
      ...buildConnectivityPreloadBindings(_unwrappingInvoke),

      onServiceChanged: (callback: (payload: ServiceConnectivityPayload) => void) =>
        _typedOn(CHANNELS.CONNECTIVITY_SERVICE_CHANGED, callback),
    },

    // Which windows hold a live view of which projects (#12597)
    projectPresence: {
      ...buildProjectPresencePreloadBindings(_unwrappingInvoke),

      onChanged: (callback: () => void) => _typedOn(CHANNELS.PROJECT_PRESENCE_CHANGED, callback),
    },

    // The sender project's presentation profile (#13771)
    projectPresentation: {
      ...buildProjectPresentationPreloadBindings(_unwrappingInvoke),

      onChanged: (callback: (snapshot: IpcEventMap["project-presentation:changed"]) => void) =>
        _typedOn(CHANNELS.PROJECT_PRESENTATION_CHANGED, callback),
    },

    // The sender project's own theme (#13833)
    projectTheme: {
      ...buildProjectThemePreloadBindings(_unwrappingInvoke),

      onChanged: (callback: (change: IpcEventMap["project-theme:changed"]) => void) =>
        _typedOn(CHANNELS.PROJECT_THEME_CHANGED, callback),
    },

    // The sender project's custom worktree titles (#14022)
    worktreeTitles: {
      ...buildWorktreeTitlesPreloadBindings(_unwrappingInvoke),

      onChanged: (callback: (snapshot: IpcEventMap["worktree-titles:changed"]) => void) =>
        _typedOn(CHANNELS.WORKTREE_TITLES_CHANGED, callback),
    },

    // The sender project's review marks (#14584)
    reviewMarks: {
      ...buildReviewMarksPreloadBindings(_unwrappingInvoke),

      onChanged: (callback: (snapshot: IpcEventMap["review-marks:changed"]) => void) =>
        _typedOn(CHANNELS.REVIEW_MARKS_CHANGED, callback),
    },

    // The sender project's schedules (#15975)
    schedules: {
      ...buildSchedulesPreloadBindings(_unwrappingInvoke),

      onChanged: (callback: (snapshot: IpcEventMap["schedules:changed"]) => void) =>
        _typedOn(CHANNELS.SCHEDULES_CHANGED, callback),

      onLaunchRequest: (callback: (request: IpcEventMap["schedules:launch-request"]) => void) =>
        _typedOn(CHANNELS.SCHEDULES_LAUNCH_REQUEST, callback),

      sendLaunchResponse: (
        response: import("../shared/types/ipc/schedules.js").ScheduledLaunchViewResponse
      ) => {
        ipcRenderer.send(CHANNELS.SCHEDULES_LAUNCH_RESPONSE, response);
      },
    },

    // Decisions, as main observes it (#16001)
    decisions: buildDecisionsPreloadBindings(_unwrappingInvoke),

    // Dev Preview API
    devPreview: {
      ...buildDevPreviewPreloadBindings(_unwrappingInvoke),

      onStateChanged: (callback: (payload: DevPreviewStateChangedPayload) => void) =>
        _typedOn(CHANNELS.DEV_PREVIEW_STATE_CHANGED, callback),

      onAllSessionsChanged: (callback: (payload: DevPreviewAllSessionsPayload) => void) =>
        _typedOn(CHANNELS.DEV_PREVIEW_ALL_SESSIONS_CHANGED, callback),
    },

    // Site Preview bridge API: the lifecycle commands for an Element Picker
    // binding. No `evaluate` method by design.
    sitePreview: buildSitePreviewPreloadBindings(_unwrappingInvoke),

    // Core Element Picker. Like the bridge, no way to choose what runs in the
    // page; a workspace names a worktree of the sender's project, never a path.
    elementPicker: {
      ...buildElementPickerPreloadBindings(_unwrappingInvoke),

      onEvent: (callback: (payload: ElementPickerPushPayload) => void) =>
        _typedOn(CHANNELS.ELEMENT_PICKER_EVENT, callback),

      onSourceChanged: (callback: (payload: ElementPickerSourceChangedPush) => void) =>
        _typedOn(CHANNELS.ELEMENT_PICKER_SOURCE_CHANGED, callback),
    },

    // Git API
    git: {
      getFileDiff: (
        cwd: string,
        filePath: string,
        status: GitStatus,
        ignoreWhitespace?: boolean,
        window?: { offset?: number; maxBytes?: number; side?: "staged" | "unstaged" }
      ) =>
        _unwrappingInvoke(CHANNELS.GIT_GET_FILE_DIFF, {
          cwd,
          filePath,
          status,
          ignoreWhitespace,
          side: window?.side,
          offset: window?.offset,
          maxBytes: window?.maxBytes,
        }),

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
        includeTotal?: boolean;
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

      push: (cwd: string, setUpstream?: boolean, opId?: string, review?: GitPushReview) =>
        _unwrappingInvoke(CHANNELS.GIT_PUSH, {
          cwd,
          setUpstream,
          opId,
          ...(review
            ? {
                expectedBranch: review.branch,
                expectedHeadOid: review.headOid,
                expectedRemote: review.destination.remote,
                expectedRemoteBranch: review.destination.branch,
              }
            : {}),
        }),

      pullRebase: (cwd: string) => _unwrappingInvoke(CHANNELS.GIT_PULL_REBASE, { cwd }),

      ...buildGitFetchPreloadBindings(_unwrappingInvoke),

      ...buildGitDiscardPreloadBindings(_unwrappingInvoke),

      forcePushWithLease: (cwd: string, branchName: string, leaseSha: string) =>
        _unwrappingInvoke(CHANNELS.GIT_FORCE_PUSH_WITH_LEASE, { cwd, branchName, leaseSha }),

      listRemoteCommits: (cwd: string, branchName: string, limit?: number) =>
        _unwrappingInvoke(CHANNELS.GIT_LIST_REMOTE_COMMITS, { cwd, branchName, limit }),
      listPushCommits: (cwd: string, branchName: string, limit?: number) =>
        _unwrappingInvoke(CHANNELS.GIT_LIST_PUSH_COMMITS, { cwd, branchName, limit }),
      listRebaseCommits: (cwd: string, branchName: string, limit?: number) =>
        _unwrappingInvoke(CHANNELS.GIT_LIST_REBASE_COMMITS, { cwd, branchName, limit }),
      listBaseIntegrationCommits: (
        cwd: string,
        baseBranch: string,
        kind: "rebase-onto-base" | "merge-base",
        limit?: number
      ) =>
        _unwrappingInvoke(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS, {
          cwd,
          baseBranch,
          kind,
          limit,
        }),
      rebaseOntoBase: (
        cwd: string,
        baseBranch: string,
        expected?: { branch?: string; headOid?: string; baseOid?: string }
      ) =>
        _unwrappingInvoke(CHANNELS.GIT_REBASE_ONTO_BASE, {
          cwd,
          baseBranch,
          expectedBranch: expected?.branch,
          expectedHeadOid: expected?.headOid,
          expectedBaseOid: expected?.baseOid,
        }),
      mergeBaseIntoBranch: (
        cwd: string,
        baseBranch: string,
        expected?: { branch?: string; headOid?: string; baseOid?: string }
      ) =>
        _unwrappingInvoke(CHANNELS.GIT_MERGE_BASE_INTO_BRANCH, {
          cwd,
          baseBranch,
          expectedBranch: expected?.branch,
          expectedHeadOid: expected?.headOid,
          expectedBaseOid: expected?.baseOid,
        }),

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
        ignoreWhitespace?: boolean,
        contextLines?: number
      ) =>
        _unwrappingInvoke(CHANNELS.GIT_COMPARE_WORKTREES, {
          cwd,
          branch1,
          branch2,
          filePath,
          useMergeBase,
          ignoreWhitespace,
          contextLines,
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

      onChanged: (callback: (change: TerminalConfigChange) => void) => {
        const offDevice = _typedOn(CHANNELS.TERMINAL_CONFIG_DEVICE_CHANGED, (config) =>
          callback({ owner: "device", config })
        );
        const offHost = _typedOn(CHANNELS.TERMINAL_CONFIG_HOST_CHANGED, (config) =>
          callback({ owner: "host", config })
        );
        return () => {
          offDevice();
          offHost();
        };
      },
    },

    // Configuration export/import API (#11889)
    configBundle: {
      ...buildConfigBundlePreloadBindings(_unwrappingInvoke),

      onImported: (callback: () => void) => _typedOn(CHANNELS.CONFIG_BUNDLE_IMPORTED, callback),
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

      onNavEvent: (
        callback: (data: {
          tabId: string;
          title: string;
          url: string;
          canGoBack: boolean;
          canGoForward: boolean;
        }) => void
      ) => _typedOn(CHANNELS.PORTAL_NAV_EVENT, callback),

      onFocus: (callback: () => void) => _typedOn(CHANNELS.PORTAL_FOCUS, callback),

      onBlur: (callback: () => void) => _typedOn(CHANNELS.PORTAL_BLUR, callback),

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
          origin: string | null;
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
      getConsoleProperties: (
        webContentsId: number,
        paneId: string,
        rowId: number,
        objectId: string
      ) =>
        _unwrappingInvoke(
          CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES,
          webContentsId,
          paneId,
          rowId,
          objectId
        ),
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
      getScrollPosition: (webContentsId: number): Promise<number | null> =>
        _unwrappingInvoke(CHANNELS.WEBVIEW_GET_SCROLL_POSITION, webContentsId),
      ...buildWebviewNavigationPreloadBindings(_unwrappingInvoke),
      ...buildWebviewCapturePreloadBindings(_unwrappingInvoke),
      ...buildWebviewEmulationPreloadBindings(_unwrappingInvoke),
    },

    // Hibernation API
    sessionRestore: {
      ...buildSessionRestorePreloadBindings(_unwrappingInvoke),
    },

    windowOpening: {
      ...buildWindowOpeningPreloadBindings(_unwrappingInvoke),
    },

    // Keep-awake API
    keepAwake: {
      ...buildKeepAwakePreloadBindings(_unwrappingInvoke),

      onStateChanged: (
        callback: (state: import("../shared/types/ipc/keepAwake.js").KeepAwakeState) => void
      ): (() => void) => _typedOn(CHANNELS.KEEP_AWAKE_STATE_CHANGED, callback),
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

      onOverridesChanged: (callback: (snapshot: KeybindingOverridesSnapshot) => void) =>
        _typedOn(CHANNELS.KEYBINDING_OVERRIDES_CHANGED, callback),
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
        flashEnabled: boolean;
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
          flashEnabled: boolean;
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
      syncWatchedPanels: (panelIds: string[], context?: { activeWorktreeId: string | null }) =>
        ipcRenderer.send(CHANNELS.NOTIFICATION_SYNC_WATCHED, panelIds, context),
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
          rateLimitLabel?: string;
          priority?: "high" | "low" | "watch";
          action?: { label: string; ipcChannel: string; data?: string };
          pluginActions?: Array<{
            label: string;
            actionId: string;
            args?: Record<string, unknown>;
          }>;
          replaceKey?: string;
          context?: {
            projectId?: string;
            worktreeId?: string;
            panelId?: string;
            plugin?: { id: string; name: string };
          };
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

      getLatest: () => _unwrappingInvoke(CHANNELS.UPDATE_GET_LATEST),
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
    codex: buildCodexPreloadBindings(_unwrappingInvoke),
    claude: buildClaudePreloadBindings(_unwrappingInvoke),

    // Daintree CLI install API
    cli: buildCliPreloadBindings(_unwrappingInvoke),

    workspaceResidency: buildWorkspaceResidencyPreloadBindings(_unwrappingInvoke),

    processes: buildProcessesPreloadBindings(_unwrappingInvoke),

    // Per-project consent for plugin agent tools. Renderer-only by design.
    pluginAgentMcp: buildPluginAgentMcpPreloadBindings(_unwrappingInvoke),

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
      list: (worktreeId?: string, projectId?: string) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_LIST, { worktreeId, projectId }),
      clear: (worktreeId?: string) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_CLEAR, { worktreeId }),
      getRetentionDays: () => _unwrappingInvoke(CHANNELS.AGENT_SESSION_GET_RETENTION),
      setRetentionDays: (days: number) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_SET_RETENTION, days),
      // Session bookmarks (#11288)
      prepareBookmark: (input: unknown) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_PREPARE_BOOKMARK, input),
      promoteBookmark: (input: unknown) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_PROMOTE_BOOKMARK, input),
      renameBookmark: (input: unknown) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_RENAME_BOOKMARK, input),
      deleteBookmark: (input: unknown) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_DELETE_BOOKMARK, input),
      listBookmarks: (input?: unknown) =>
        _unwrappingInvoke(CHANNELS.AGENT_SESSION_LIST_BOOKMARKS, input),
    },

    // Clipboard API — bindings built from the preload-safe channel map in
    // `./ipc/handlers/clipboard.preload.ts`. The handler module is main-only
    // because it imports `node:*` built-ins that aren't available in sandboxed
    // preloads. See #5691.
    clipboard: buildClipboardPreloadBindings(_unwrappingInvoke),

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

    // Remote Hosts (absent in effect on Windows: the handlers are never registered).
    remoteHosts: {
      ...buildRemoteHostsPreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["remote-hosts:event"]) => void) =>
        _typedOn("remote-hosts:event", callback),
    },
    hostMode: {
      ...buildHostModePreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["host-mode:event"]) => void) =>
        _typedOn("host-mode:event", callback),
    },
    deviceAnswer: {
      ...buildDeviceAnswerPreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["device-answer:event"]) => void) =>
        _typedOn("device-answer:event", callback),
    },
    driveLease: {
      ...buildDriveLeasePreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["drive-lease:event"]) => void) =>
        _typedOn("drive-lease:event", callback),
    },
    operations: {
      ...buildOperationsPreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["operations:event"]) => void) =>
        _typedOn("operations:event", callback),
    },
    hostFiles: buildHostFilesPreloadBindings(_unwrappingInvoke),
    fileTransfer: {
      ...buildFileTransferPreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["file-transfer:event"]) => void) =>
        _typedOn("file-transfer:event", callback),
    },
    hostSwitch: buildHostSwitchPreloadBindings(_unwrappingInvoke),
    projectMatch: buildProjectMatchPreloadBindings(_unwrappingInvoke),
    hostMetrics: {
      ...buildHostMetricsPreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["host-metrics:event"]) => void) =>
        _typedOn("host-metrics:event", callback),
    },
    canopyHost: {
      ...buildCanopyHostPreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["canopy-host:event"]) => void) =>
        _typedOn("canopy-host:event", callback),
    },
    portForwards: {
      ...buildPortForwardsPreloadBindings(_unwrappingInvoke),
      onEvent: (callback: (event: IpcEventMap["port-forwards:event"]) => void) =>
        _typedOn("port-forwards:event", callback),
    },
    pluginParity: buildPluginParityPreloadBindings(_unwrappingInvoke),
    settingsCopy: buildSettingsCopyPreloadBindings(_unwrappingInvoke),
    hostSettings: buildHostSettingsPreloadBindings(_unwrappingInvoke),

    onboarding: {
      ...buildOnboardingPreloadBindings(_unwrappingInvoke),

      onChecklistPush: (
        callback: (state: IpcEventMap["onboarding:checklist-push"]) => void
      ): (() => void) => _typedOn(CHANNELS.ONBOARDING_CHECKLIST_PUSH, callback),
    },

    shortcutHints: buildShortcutHintsPreloadBindings(_unwrappingInvoke),

    forgeRecommendation: buildForgeRecommendationPreloadBindings(_unwrappingInvoke),

    forge: {
      ...buildForgeCredentialImportPreloadBindings(_unwrappingInvoke),
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
      openIssue: (
        payload: {
          cwd: string;
          issueNumber: number;
        } & import("../shared/types/ipc/forge.js").IssueLinkTarget
      ) => _unwrappingInvoke(CHANNELS.FORGE_OPEN_ISSUE, payload),
      getIssueUrl: (
        payload: {
          cwd: string;
          issueNumber: number;
        } & import("../shared/types/ipc/forge.js").IssueLinkTarget
      ) => _unwrappingInvoke(CHANNELS.FORGE_GET_ISSUE_URL, payload),
      openRepo: (payload: { cwd: string }) => _unwrappingInvoke(CHANNELS.FORGE_OPEN_REPO, payload),
      getRepoUrl: (payload: { cwd: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_REPO_URL, payload),
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
      getPR: (payload: { cwd: string; prNumber: number; fresh?: boolean }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PR, payload),
      getCIStatus: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_CI_STATUS, payload),
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
      onRemoteChanged: (callback: (payload: { projectId: string }) => void) =>
        _eventBusOn("forge:remote-changed", callback),
      classifyPushError: (payload: { cwd: string; stderr: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_CLASSIFY_PUSH_ERROR, payload),
      getRepoStats: (payload: { cwd: string; bypassCache?: boolean }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_REPO_STATS, payload),
      getFirstPageCache: (payload: { cwd: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_FIRST_PAGE_CACHE, payload),
      getRepoKey: (payload: { cwd: string }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_REPO_KEY, payload),
      getProjectHealth: (payload: { cwd: string; bypassCache?: boolean }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PROJECT_HEALTH, payload),
      getIssueTooltip: (
        payload: {
          cwd: string;
          issueNumber: number;
        } & import("../shared/types/ipc/forge.js").IssueLinkTarget
      ) => _unwrappingInvoke(CHANNELS.FORGE_GET_ISSUE_TOOLTIP, payload),
      getPRTooltip: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PR_TOOLTIP, payload),
      getIssuesByNumbers: (payload: { cwd: string; numbers: number[] }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_ISSUES_BY_NUMBERS, payload),
      getPRsByNumbers: (payload: { cwd: string; numbers: number[] }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PRS_BY_NUMBERS, payload),
      getReferencesByNumbers: (payload: { cwd: string; numbers: number[] }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_REFERENCES_BY_NUMBERS, payload),
      getPRReviewThreads: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_PR_REVIEW_THREADS, payload),
      listIssueComments: (payload: { cwd: string; issueNumber: number; opts?: unknown }) =>
        _unwrappingInvoke(CHANNELS.FORGE_LIST_ISSUE_COMMENTS, payload),
      getChecks: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_GET_CHECKS, payload),
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
        expectedHeadSha?: string;
        expectedBaseRef?: string;
      }) => _unwrappingInvoke(CHANNELS.FORGE_MERGE_PR, payload),
      enableAutoMerge: (payload: {
        cwd: string;
        prNumber: number;
        mergeMethod?: "merge" | "squash" | "rebase";
        expectedHeadSha: string;
        expectedBaseRef?: string;
      }) => _unwrappingInvoke(CHANNELS.FORGE_ENABLE_AUTO_MERGE, payload),
      disableAutoMerge: (payload: { cwd: string; prNumber: number }) =>
        _unwrappingInvoke(CHANNELS.FORGE_DISABLE_AUTO_MERGE, payload),
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

    projectGroups: buildProjectGroupsPreloadBindings(_unwrappingInvoke),
    runHistory: buildRunHistoryPreloadBindings(_unwrappingInvoke),
    copyTreeHistory: buildCopyTreeHistoryPreloadBindings(_unwrappingInvoke),
    scheduledRuns: buildScheduledRunsPreloadBindings(_unwrappingInvoke),

    // Voice Input API
    voiceInput: {
      ...buildVoiceInputPreloadBindings(_unwrappingInvoke),
      getSettings: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_GET_SETTINGS),
      setSettings: (
        patch: Partial<{
          enabled: boolean;
          openaiApiKey: string;
          deepgramApiKey: string;
          xaiApiKey: string;
          anthropicApiKey: string;
          language: string;
          transcriptionProvider: "openai" | "deepgram" | "grok";
          transcriptionModel: "gpt-live-transcribe";
          correctionEnabled: boolean;
          correctionProvider: "openai" | "anthropic";
          correctionModel:
            "gpt-6.1-terra" | "gpt-6-luna" | "claude-haiku-5-5" | "claude-sonnet-5-5";
          correctionCustomInstructions: string;
          paragraphingStrategy: "spoken-command" | "manual";
          resolveFileLinks: boolean;
          deviceId: string;
          recordingMode: "toggle" | "push-to-talk" | "tap-or-hold";
        }>
      ) => _unwrappingInvoke(CHANNELS.VOICE_INPUT_SET_SETTINGS, patch),
      sendAudioChunk: (sessionId: string, chunk: ArrayBuffer) =>
        ipcRenderer.send(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, sessionId, chunk),
      onTranscriptionDelta: (
        callback: (payload: {
          sessionId: string;
          text: string;
          itemId?: string;
          replace?: boolean;
        }) => void
      ) => _typedOn(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, callback),
      onTranscriptionComplete: (
        callback: (payload: {
          sessionId: string;
          text: string;
          willCorrect: boolean;
          /** The words as transcribed, when heard-as rules rewrote them into `text`. */
          heard?: string;
          itemId?: string;
          transcriptId?: string;
          send?: boolean;
          commandText?: string;
          /** Spans of `text` the recogniser was unsure of. */
          uncertain?: Array<{ from: number; to: number }>;
          /** Spans of `heard` the recogniser was unsure of. */
          heardUncertain?: Array<{ from: number; to: number }>;
          /** Spans of `commandText` the recogniser was unsure of. */
          commandUncertain?: Array<{ from: number; to: number }>;
          /**
           * Where the speaker paused in `text`, each straight after a word. With no
           * words, `[0]` marks a pause after the words that landed before it.
           */
          pauses?: number[];
          /** Where the speaker paused in `heard`. */
          heardPauses?: number[];
          /** Where the speaker paused in `commandText`. */
          commandPauses?: number[];
        }) => void
      ) => _typedOn(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, callback),
      onParagraphBoundary: (
        callback: (payload: { sessionId: string; rawText: string | null }) => void
      ) => _typedOn(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, callback),
      onError: (callback: (payload: { sessionId: string; error: VoiceInputError }) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_ERROR, callback),
      onStatus: (callback: (payload: { sessionId: string; status: VoiceInputStatus }) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_STATUS, callback),
      onSessionEnded: (
        callback: (payload: {
          sessionId: string;
          reason: VoiceSessionEndReason;
          report: VoiceSessionReport;
        }) => void
      ) => _typedOn(CHANNELS.VOICE_INPUT_SESSION_ENDED, callback),
      onLiveSession: (callback: (update: VoiceLiveSessionUpdate) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_LIVE_SESSION, callback),
      onStopRequested: (callback: (payload: VoiceStopRequest) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_STOP_REQUESTED, callback),
      onRevealRequested: (callback: (payload: VoiceRevealRequest) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_REVEAL_REQUESTED, callback),
      onLiveLevel: (callback: (payload: VoiceLiveLevel) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_LIVE_LEVEL, callback),
      onPauseRequested: (callback: (payload: VoicePauseRequest) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_PAUSE_REQUESTED, callback),
      checkMicPermission: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION),
      requestMicPermission: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION),
      openMicSettings: () => _unwrappingInvoke(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS),
      validateApiKey: (apiKey: string) =>
        _unwrappingInvoke(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY, apiKey),
      correct: (request: {
        rawText: string;
        recentContext?: string[];
        followingText?: string;
        terminalId?: string;
        startsPrompt?: boolean;
        sessionId?: string;
        streamId?: string;
      }) => _unwrappingInvoke(CHANNELS.VOICE_INPUT_CORRECT, request),
      onCorrectionProgress: (callback: (payload: { streamId: string; text: string }) => void) =>
        _typedOn(CHANNELS.VOICE_INPUT_CORRECTION_PROGRESS, callback),
      onFileTokenResolved: (
        callback: (payload: {
          sessionId: string;
          transcriptId: string;
          references: Array<{ description: string; path: string | null; failed?: true }>;
        }) => void
      ) => _typedOn(CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED, callback),
    },

    voiceDictionary: buildVoiceDictionaryPreloadBindings(_unwrappingInvoke),

    recentDictations: {
      ...buildRecentDictationsPreloadBindings(_unwrappingInvoke),

      onChanged: (callback: () => void) => _typedOn(CHANNELS.RECENT_DICTATIONS_CHANGED, callback),
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
          targetTier: "core" | "full" | null;
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
          sessionOrigin?: McpSessionOrigin;
          offerSessionApproval?: boolean;
          approvalOnly?: boolean;
          approvalReason?: McpApprovalReason;
          hostPreview?: McpHostPreview;
          authorization?: McpDispatchAuthorization;
          requester?: McpRequester;
          dispatchDeadlineAt?: number;
        }) => void
      ) => _typedOn(CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST, callback),

      sendDispatchActionResponse: (payload: {
        requestId: string;
        result: unknown;
        confirmationDecision?: "approved" | "rejected" | "timeout";
        approvalScope?: "once" | "session";
      }) => {
        ipcRenderer.send(CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE, payload);
      },
    },

    pluginBridge: {
      onDispatchActionRequest: (
        callback: (payload: {
          requestId: string;
          actionId: string;
          args?: unknown;
          pluginId?: string;
        }) => void
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

      onAgentsListRequest: (callback: (payload: { requestId: string }) => void) =>
        _typedOn(CHANNELS.PLUGIN_AGENTS_LIST_REQUEST, callback),

      sendAgentsListResponse: (payload: {
        requestId: string;
        agents: import("../shared/types/plugin.js").PluginAgentPane[];
      }) => {
        ipcRenderer.send(CHANNELS.PLUGIN_AGENTS_LIST_RESPONSE, payload);
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

      onPanelReloadRequest: (
        callback: (
          payload: import("../shared/types/pluginPanelReload.js").PluginPanelReloadRequest
        ) => void
      ) => _typedOn(CHANNELS.PLUGIN_PANEL_RELOAD_REQUEST, callback),

      sendPanelReloadResponse: (
        payload: import("../shared/types/pluginPanelReload.js").PluginPanelReloadResponse
      ) => {
        ipcRenderer.send(CHANNELS.PLUGIN_PANEL_RELOAD_RESPONSE, payload);
      },
    },

    plugin: {
      ...buildPluginPreloadBindings(_pluginInvoke),
      ...buildPluginMetricsPreloadBindings(_unwrappingInvoke),
      ...buildPluginPanelCapturePreloadBindings(_unwrappingInvoke),
      ...buildPluginProjectPresencePreloadBindings(_unwrappingInvoke),

      // This view's project presence changed (#13813). Pushed per project, so
      // the payload names it; `getProjectPresence()` answers for this view.
      onProjectPresenceChanged: (callback: (presence: PluginProjectPresence) => void) =>
        _typedOn(CHANNELS.PLUGIN_PROJECT_PRESENCE_CHANGED, callback),

      // Fire-and-forget: renderer-side view cost observations, drained in batches.
      reportViewMetrics: (reports: PluginRendererMetricsEnvelope[]) => {
        ipcRenderer.send(CHANNELS.PLUGIN_REPORT_VIEW_METRICS, reports);
      },

      // Fire-and-forget: the kind of panel holding DOM focus in this view.
      reportFocusedPanel: (report: PluginFocusedPanel) => {
        ipcRenderer.send(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL, report);
      },

      // Pushed at most once a second, only while subscribed. Carries every
      // tracked plugin's snapshot; read `getPerfSnapshots()` for the first one.
      onPerfSnapshotsChanged: (callback: (snapshots: PluginPerfSnapshot[]) => void) =>
        _onPerfSnapshotsChanged(callback),

      // Local read, no IPC: which plugins had a push delivered to their
      // listeners here between two `performance.now()` instants.
      pluginsWithPushDeliveriesDuring: (start: number, end: number): string[] =>
        _pluginsWithPushDeliveriesDuring(start, end),

      // plugin:invoke uses raw ipcMain.handle with variadic args — its signature
      // can't be expressed through IpcInvokeMap, so it stays inline.
      invoke: (pluginId: string, channel: string, ...args: unknown[]) =>
        _pluginInvoke(CHANNELS.PLUGIN_INVOKE, pluginId, channel, ...args),

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
      onSettingsChanged: (callback: (payload: { pluginId: string }) => void) =>
        _eventBusOn("plugin:settings-changed", callback),
      // Direct channel, not the event bus: install progress is targeted at the
      // window that started the install, never broadcast to every view (#11302).
      onInstallProgress: (
        callback: (event: import("../shared/types/plugin.js").PluginInstallProgressEvent) => void
      ) => _typedOn(CHANNELS.PLUGIN_INSTALL_PROGRESS, callback),
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
      onRecipesChanged: (
        callback: (payload: {
          recipes: import("../shared/types/project.js").TerminalRecipe[];
          complete: boolean;
        }) => void
      ) => _eventBusOn("plugin:recipes-changed", callback),
      onToursChanged: (
        callback: (payload: {
          tours: import("../shared/types/plugin.js").PluginTourDescriptor[];
        }) => void
      ) => _eventBusOn("plugin:tours-changed", callback),
      onHostedViewsChanged: (
        callback: (payload: {
          views: import("../shared/types/plugin.js").PluginHostedViewDescriptor[];
        }) => void
      ) => _eventBusOn("plugin:hosted-views-changed", callback),
      onThemesChanged: (
        callback: (payload: {
          themes: import("../shared/types/appTheme.js").AppColorScheme[];
          fallbackSchemeId?: string;
        }) => void
      ) => _eventBusOn("plugin:themes-changed", callback),
      onIconsChanged: (
        callback: (payload: {
          icons: import("../shared/config/pluginCustomIcon.js").PluginCustomIconAsset[];
        }) => void
      ) => _eventBusOn("plugin:icons-changed", callback),
      onToolbarButtonsChanged: (
        callback: (payload: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void
      ) => _eventBusOn("plugin:toolbar-buttons-changed", callback),
      onLaunchEntriesChanged: (
        callback: (payload: {
          entries: import("../shared/types/plugin.js").PluginLaunchEntryConfig[];
        }) => void
      ) => _eventBusOn("plugin:launch-entries-changed", callback),
      onLayoutsChanged: (
        callback: (payload: {
          layouts: import("../shared/types/plugin.js").PluginLayoutConfig[];
        }) => void
      ) => _eventBusOn("plugin:layouts-changed", callback),
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
      onPanelActivityChanged: (
        callback: (payload: {
          pluginId: string;
          activity: Record<string, PluginPanelActivityReport>;
        }) => void
      ) => _eventBusOn("plugin:panel-activity-changed", callback),
      onTasksChanged: (
        callback: (payload: { pluginId: string; tasks: PluginTaskSnapshot[] }) => void
      ) => _eventBusOn("plugin:tasks-changed", callback),
      onToolbarBadgesChanged: (
        callback: (payload: { pluginId: string; badges: Record<string, PluginPanelBadge> }) => void
      ) => _eventBusOn("plugin:toolbar-badges-changed", callback),
      onToolbarStatesChanged: (
        callback: (payload: {
          pluginId: string;
          states: Record<string, PluginToolbarButtonRuntimeState>;
        }) => void
      ) => _eventBusOn("plugin:toolbar-states-changed", callback),
      onContextKeysChanged: (
        callback: (payload: {
          pluginId: string;
          keys: Record<string, PluginContextValue> | null;
        }) => void
      ) => _eventBusOn("plugin:context-keys-changed", callback),
      onWorktreeCardStatusesChanged: (
        callback: (payload: {
          pluginId: string;
          projectId: string;
          statuses: Record<string, PluginWorktreeCardStatus>;
        }) => void
      ) => _eventBusOn("plugin:worktree-card-statuses-changed", callback),
      onWorktreeReviewChecksChanged: (
        callback: (payload: {
          pluginId: string;
          projectId: string;
          checks: Record<string, PluginWorktreeReviewCheck[]>;
        }) => void
      ) => _eventBusOn("plugin:worktree-review-checks-changed", callback),
      onTerminalStatusesChanged: (
        callback: (payload: {
          pluginId: string;
          projectId: string;
          statuses: Record<string, PluginTerminalStatus>;
        }) => void
      ) => _eventBusOn("plugin:terminal-statuses-changed", callback),
      onPanelMenusChanged: (
        callback: (payload: {
          pluginId: string;
          menus: Record<string, readonly PublishedPanelMenuItem[]>;
        }) => void
      ) => _eventBusOn("plugin:panel-menus-changed", callback),
      onActionsRunningChanged: (
        callback: (payload: { pluginId: string; actionIds: string[] }) => void
      ) => _eventBusOn("plugin:actions-running-changed", callback),
      onDeepLink: (callback: (intent: PluginDeepLinkIntent) => void) =>
        _eventBusOn("plugin:deep-link", callback),
      onArchiveInstallIntent: (callback: (intent: PluginArchiveInstallIntent) => void) =>
        _eventBusOn("plugin:archive-install-intent", callback),
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
    help: {
      ...buildHelpPreloadBindings(_unwrappingInvoke),

      onGlobalAssistantChanged: (
        callback: (state: import("../shared/types/ipc/help.js").GlobalAssistantView) => void
      ) => _typedOn(CHANNELS.HELP_GLOBAL_ASSISTANT_CHANGED, callback),
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

// Renderer long-animation-frame sampler. This is not event-loop utilisation:
// the Node ELU API is unavailable under sandbox: true and the web has none, so
// we accumulate LoAF `blockingDuration` between sample events, plus the longest
// single frame. The preload runs on the same renderer main thread as the page,
// so LoAF entries reflect the user-visible JS thread saturation.
// blockingDuration counts only the part of a frame past 50ms, so work in
// shorter slices never shows — the ratio is a floor on how busy the view was.
//
// No startup suppression: ProcessMemoryMonitor's poll cadence is 30s, so any
// LoAF replay from `buffered: true` is diluted across a full window before
// the first sample. The 0.85 ratio + 6-sample streak threshold on the main
// side absorbs the residual cold-start noise.
type LoAFEntry = PerformanceEntry & { blockingDuration?: number };
let eluAccumulatedBlockingMs = 0;
let eluLongestFrameMs = 0;
let eluLongestBlockingMs = 0;
let eluWindowStartMs =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : 0;
let loafObserver: PerformanceObserver | null = null;
const accumulateLoafEntries = (entries: PerformanceEntryList): void => {
  for (const entry of entries as LoAFEntry[]) {
    const blocking = entry.blockingDuration;
    if (typeof blocking === "number" && blocking > 0) {
      eluAccumulatedBlockingMs += blocking;
      if (blocking > eluLongestBlockingMs) eluLongestBlockingMs = blocking;
    }
    if (entry.duration > eluLongestFrameMs) eluLongestFrameMs = entry.duration;
  }
};
try {
  if (typeof PerformanceObserver === "function") {
    const observer = new PerformanceObserver((list) => accumulateLoafEntries(list.getEntries()));
    // long-animation-frame is in Chromium 123+. Older runtimes throw on
    // observe() — caught and ignored; the handler will report 0 blocking.
    // The observer lives for the renderer's lifetime and is never disconnected;
    // it is kept only so a sample can drain entries not yet delivered.
    observer.observe({ type: "long-animation-frame", buffered: true });
    loafObserver = observer;
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
    if (loafObserver) accumulateLoafEntries(loafObserver.takeRecords());
    const sampleWindowMs = Math.max(0, Math.round(now - eluWindowStartMs));
    const blockingDurationMs = Math.max(0, Math.round(eluAccumulatedBlockingMs));
    const longestFrameMs = Math.max(0, Math.round(eluLongestFrameMs));
    const longestBlockingMs = Math.max(0, Math.round(eluLongestBlockingMs));
    eluAccumulatedBlockingMs = 0;
    eluLongestFrameMs = 0;
    eluLongestBlockingMs = 0;
    eluWindowStartMs = now;
    let inputBlocking: RendererInputBlockingSnapshot | undefined;
    try {
      inputBlocking = captureInputBlockingSnapshot(document, window);
    } catch {
      /* the LoAF sample still goes out without it */
    }
    ipcRenderer
      .invoke(CHANNELS.SYSTEM_REPORT_RENDERER_ELU, {
        requestId,
        blockingDurationMs,
        sampleWindowMs,
        longestFrameMs,
        longestBlockingMs,
        inputBlocking,
      })
      .catch(() => {
        /* observability is best-effort */
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

// E2E-only trash TTL override. The pty-host reads the same env var for its own
// kill timer; the renderer's copy drives the trash row expiry and countdown.
// The env check is inline so a production build folds the branch away.
if (!isPackagedBuild && process.env.DAINTREE_E2E_MODE === "1") {
  const trashTtlOverrideMs = parseE2ETimerOverrideMs(process.env.DAINTREE_E2E_TRASH_TTL_MS);
  if (trashTtlOverrideMs !== null) {
    contextBridge.exposeInMainWorld(e2eGlobalKey("TRASH_TTL_MS"), trashTtlOverrideMs);
  }
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

// Exposed only for a view of a remote host's project; its initial project id
// is the host's id for the project, and persisted keys scope by this host.
if (viewHostId) {
  contextBridge.exposeInMainWorld("__DAINTREE_HOST_ID__", { id: viewHostId });
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
  // Let the renderer know a capture run is live: the launch-time env var never
  // reaches the sandboxed renderer, so without this bridge the renderer-side
  // flush (`isRendererPerfCaptureEnabled`) stays off for the whole session.
  contextBridge.exposeInMainWorld("__DAINTREE_PERF_CAPTURE__", true);
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
