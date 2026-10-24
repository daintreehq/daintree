import fs from "fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { app, net, webContents } from "electron";
import { createLogger } from "../utils/logger.js";
import { PluginArtifactService } from "./plugin/PluginArtifactService.js";
import { PluginArtifactStore } from "./plugin/PluginArtifactStore.js";
import { setArtifactSourceResolver } from "../setup/artifactSourceResolver.js";
import type { PluginArtifact, PluginArtifactSource } from "../../shared/types/pluginArtifacts.js";
import { PRODUCT_WEBSITE } from "../utils/productBranding.js";
import { stripUtf8Bom } from "../utils/stripUtf8Bom.js";
// Aliased to avoid colliding with Vite's auto-injected ESM shim
// (`import { createRequire } from 'module'; const require = createRequire(import.meta.url);`),
// which it adds to every bundled chunk for CJS interop.
import { createRequire as nodeCreateRequire } from "node:module";

// ajv and ajv-formats are CJS-only with deep `module.exports = Class` exports.
// NodeNext module resolution can't resolve these from ESM, so use createRequire
// which is the canonical Node.js interop for CJS-in-ESM.
const req = nodeCreateRequire(import.meta.url);
const Ajv: new (opts?: Record<string, unknown>) => AjvInstance = req("ajv");
const addFormats: (ajv: AjvInstance) => void = req("ajv-formats");

interface AjvInstance {
  compile(schema: Record<string, unknown>): ValidateFn;
}

import {
  describeManifestIssues,
  getPluginManifestSchema,
  parsePluginManifestForLoad,
  SCOPED_PLUGIN_NAME_PATTERN,
} from "../schemas/plugin.js";
import { getPluginMcpSupervisor } from "./PluginMcpSupervisor.js";
import { PluginProcessManager } from "./plugin/PluginProcessManager.js";
import { getWorktreeCustomTitles, onWorktreeCustomTitlesChanged } from "./worktreeCustomTitles.js";
import {
  actionHandlerArityHint,
  appendHandlerHint,
  channelHandlerArityHint,
} from "./plugin/pluginHandlerHints.js";
import { PluginPtyTransport } from "./plugin/PluginPtyTransport.js";
import { forgetPluginLaunches, forgetPluginLaunchesWhere } from "./plugin/pluginLaunchedAgents.js";
import { PluginPathNotAllowedError } from "./plugin/pluginFsContainment.js";
import { e2eSideloadPluginDir, isE2EMode } from "../setup/runtimeFlags.js";
import { whenPluginDirResolverLive } from "../setup/pluginProtocolReadiness.js";
import type { HostGitFactory } from "./plugin/pluginHostGit.js";
import type { PluginDataBackupSource } from "./plugin/pluginDataBackup.js";
import {
  PLUGIN_PROCESS_STREAM_CHANNEL,
  type PluginProcessInfo,
} from "../../shared/types/ipc/pluginProcess.js";
import { z } from "zod";
import {
  isBuiltInPluginCapability,
  PLUGIN_WORKER_SELF_RESTART_COOLDOWN_MS,
  UNBOUND_PLUGIN_HOST_BINDING,
  type ProjectSurfaceSlotKey,
  type WorkerRestartResult,
} from "../../shared/types/plugin.js";
import type {
  PluginManifest,
  PluginEventRouteWake,
  PluginIpcHandler,
  PluginIpcContext,
  PluginHostApi,
  PluginActivate,
  PluginActionContribution,
  PluginActionDescriptor,
  PluginTourDescriptor,
  PluginChannelSchema,
  PluginTypedIpcHandler,
  ActionHandler,
  BuiltInPluginCapability,
  PluginLoadError,
  PluginActivationResult,
  PluginInstallResult,
  PluginInstallOptions,
  PluginCheckUpdateResult,
  PluginSettingsScope,
  PluginSettingsUiValues,
  PluginAccountBinding,
  PluginAccountBindingUiStatus,
  PluginAccountConnectResult,
  PluginAccountUiStatus,
  PluginAccountVerification,
  PluginWorktreeStatus,
  PluginPanelBadge,
  PluginToolbarButtonRuntimeState,
  PluginContextValue,
  PluginWorktreeCardStatus,
  PluginWorktreeReviewCheck,
  PluginTerminalStatus,
  PluginPanelActivityReport,
  PluginRuntimeStatus,
  PluginWorkerStatus,
  PluginWorkerState,
  PluginWorkerReason,
  PluginProtocolAuthority,
  PluginHostBinding,
  PluginOrigin,
  ProjectPluginInfo,
  ProjectPluginTrustDecision,
  ProjectPluginTrustRecord,
  ProjectPluginTrustState,
  ProjectPluginVisibility,
  ProjectSurfaceChoice,
  ProjectSurfaceChoiceUpdate,
  ProjectSurfaceChoices,
  ProjectSurfacesSnapshot,
} from "../../shared/types/plugin.js";
import {
  PluginFileLogLimiter,
  boundPluginFileLogText,
  pluginFileLogIdentity,
  type PluginFileLogCategory,
  type PluginFileLogSuppressed,
} from "./plugin/pluginFileLog.js";
import { PluginInstalledRecordsStore } from "./plugin/PluginInstalledRecordsStore.js";
import { PluginProjectInstanceStore } from "./plugin/PluginProjectInstanceStore.js";
import { PluginContributionBroadcaster } from "./plugin/PluginContributionBroadcaster.js";
import {
  getProjectPluginVisibility as readProjectPluginVisibility,
  isPluginVisibleInProject,
  setPluginVisibilityDefault as writePluginVisibilityDefault,
  setProjectPluginVisibility as writeProjectPluginVisibility,
} from "./plugin/projectPluginVisibility.js";
import { selectContributionsForProject } from "./plugin/PluginContributionBroadcaster.js";
import {
  bumpProjectSurfaceRevision,
  getProjectSurfaceRevision,
  getProjectSurfaceSlots,
} from "./plugin/PluginSurfaceRegistry.js";
import {
  getProjectSurfaceChoices as readProjectSurfaceChoices,
  setProjectSurfaceChoices as writeProjectSurfaceChoices,
} from "./plugin/projectSurfaceChoices.js";
import {
  ProjectPluginController,
  type ProjectPluginControllerDeps,
} from "./plugin/ProjectPluginController.js";
import { preflightProjectApplication } from "./plugin/projectApplicationPreflight.js";
import { readPluginManifestForLoad } from "./plugin/pluginManifestLoad.js";
import {
  PluginContributionRegistrar,
  buildPluginViewUrl,
  qualifyOwnActionId,
  runUnloadStep,
} from "./plugin/PluginContributionRegistrar.js";
import { discoverProjectPlugins } from "./plugin/projectPluginDiscovery.js";
import { ProjectPluginWatcher } from "./plugin/ProjectPluginWatcher.js";
import { PluginDevArtifactWatcher } from "./plugin/PluginDevArtifactWatcher.js";
import { getPluginCapabilityConsentService } from "./plugin-capability/instances.js";
import {
  getProjectForWebContents,
  getWebContentsForProject,
  isCachedViewWebContents,
  resolveLiveWebContents,
} from "../window/webContentsRegistry.js";
import { projectStore } from "./ProjectStore.js";
import { isPluginNotificationSilenced } from "./plugin/pluginNotificationSilences.js";

/** How long a plugin notification waits on a project's mute before going out anyway. */
const PLUGIN_NOTIFICATION_MUTE_READ_TIMEOUT_MS = 2_000;
import { store } from "../store.js";
import { wipeSettingsFile } from "./PluginSettingsStore.js";
import { isProjectWorkspaceId } from "../../shared/utils/workspaceIds.js";
import type { EventBusEnvelope } from "../../shared/types/ipc/maps.js";
import {
  makeInstalledProjectInstanceKey,
  makeProjectPluginInstanceKey,
  parseProjectPluginInstanceKey,
  parsePluginHostedViewKindId,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
  type WorktreeDeleteNoteSource,
  type WorktreeDeleteNotesAnswer,
  type WorktreeDeleteNotesReport,
} from "../../shared/types/plugin.js";
import {
  PluginPanelLifecycleBroker,
  type PanelLifecycleSourceHandle,
} from "./plugin/PluginPanelLifecycleBroker.js";
import {
  PLUGIN_ACTION_CATEGORY_MAX_LENGTH,
  isReservedActionCategory,
  normalizePluginActionCategory,
} from "../../shared/config/actionCategories.js";
import { parse as parseWhenClause } from "../../shared/utils/whenClause/index.js";
import { onWebContentsDestroyed } from "../window/webContentsDestroyed.js";
import { PluginRendererDispatcher } from "./plugin/PluginRendererDispatcher.js";
import { PluginPanelReloadDispatcher } from "./plugin/PluginPanelReloadDispatcher.js";
import { PluginUIPromptDispatcher } from "./plugin/PluginUIPromptDispatcher.js";
import { PluginSettingsManager } from "./plugin/PluginSettingsManager.js";
import { PluginAccountService, type AccountSignInBroker } from "./plugin/PluginAccountService.js";
import { pluginAccountBindings } from "./plugin/pluginAccountBindings.js";
import { PluginStorageManager } from "./plugin/PluginStorageManager.js";
import { PluginChannelRegistry } from "./plugin/PluginChannelRegistry.js";
import { PluginServiceBroker } from "./plugin/PluginServiceBroker.js";
import {
  PluginBlocklistService,
  findPluginBlocklistMatch,
  type ParsedPluginBlocklist,
  type PluginBlocklistMatch,
} from "./plugin/PluginBlocklistService.js";
import { PluginInstaller } from "./plugin/PluginInstaller.js";
import { checkPluginEngineRange, type PluginEngineMismatch } from "./plugin/pluginEngineCompat.js";
import { PluginDevWorkerHost } from "./plugin/PluginDevWorkerHost.js";
import { PluginDevWorkerMainBridge } from "./plugin/PluginDevWorkerMainBridge.js";
import { agentMcpEndpointRegistry } from "./pluginAgentMcp/endpointRegistry.js";
import { pluginMcpGrantRegistry } from "./pluginAgentMcp/grantRegistry.js";
import { agentMcpSurfaceOf } from "./pluginAgentMcp/declaredEndpoints.js";
import type { AgentMcpServerSourceLookup } from "./pluginAgentMcp/types.js";
import {
  buildPluginPermissionExecArgv,
  classifyPluginPermissionPaths,
  derivePluginPermissionCapabilities,
  isPluginPermissionModelSpikeEnabled,
} from "./plugin/pluginPermissionFlags.js";
import { PluginInvokeOwnershipError } from "./plugin/PluginInvokeErrors.js";
import {
  computePluginDanger,
  manifestTriggersCompoundElevation,
} from "./plugin/pluginDangerLattice.js";
import {
  createHost as createPluginHost,
  noteNewestPluginInstance,
  type PluginHostFactoryDeps,
  type PluginWorktreeEventPayload,
  type PluginWorktreeSnapshotFetchResult,
} from "./plugin/PluginHostFactory.js";
import { PluginTaskRegistry } from "./plugin/PluginTaskRegistry.js";
import type { ProjectPluginWork } from "./plugin/projectPluginWork.js";
import { createPluginEventRoutes, type PluginEventRoutes } from "./plugin/pluginEventRoutes.js";
import type {
  LoadedPlugin,
  ValidateFn,
  WorkspaceWorktreeEvent,
  ExpandedFsPath,
} from "./plugin/PluginServiceTypes.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { toPluginWorktreeStatus } from "../../shared/utils/pluginWorktreeSnapshot.js";
import { getFleetSnapshotServiceRef, getPtyClient } from "../window/serviceRefs.js";
import { getWindowForWebContents } from "../window/webContentsRegistry.js";
import type { PublishedPanelMenuItem } from "../../shared/utils/pluginPanelMenuItems.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  toRuntimePanelKindId,
  onPanelKindRegistered,
  onPanelKindUnregistered,
  getPanelKindConfig,
  toPersistedPanelKindRef,
} from "../../shared/config/panelKindRegistry.js";
import { PluginSearchCoordinator } from "./plugin/PluginSearchService.js";
import { getHiddenSearchProviders } from "./plugin/searchProviderPreferences.js";
import { unregisterForgeProviderImpls } from "./forgeProviderRegistry.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import {
  scopeMatchesPattern,
  unregisterFileDecorationProviderImpls,
} from "./fileDecorationRegistry.js";
import { unregisterWorktreeDeleteNotesBinding } from "./plugin/worktreeDeleteNotesRegistry.js";
import {
  collectWorktreeDeleteNotes as collectDeleteNotes,
  getWorktreeDeleteNotes as getDeleteNotes,
  listWorktreeDeleteNoteSources as listDeleteNoteSources,
  type WorktreeDeleteNotesHost,
  type WorktreeDeleteNotesTarget,
} from "./plugin/worktreeDeleteNotes.js";
import { isWorktreeDeleteNotesMuted } from "./plugin/pluginWorktreeDeleteNoteMutes.js";
import { toPluginWorktreeSnapshot } from "../../shared/utils/pluginWorktreeSnapshot.js";
import { unregisterWorktreeSetupStepHandlers } from "./worktreeSetupStepRegistry.js";
import {
  arbitrateContextProviders,
  getRegisteredContextProviders,
  unregisterContextProviderImpls,
} from "./contextProviderRegistry.js";
import { getContextProvidersOff } from "./plugin/contextProvidersOff.js";
import type { ContextProviderEntry } from "../../shared/types/pluginContextProvider.js";
import { reconcilePluginThemeSelection } from "./appThemePluginSelection.js";
import {
  getPluginRecipe,
  getPluginRecipeOwner,
  getPluginRecipeQualifiedIdsByPlugin,
  getPluginRecipes,
  setPluginRecipeMetadataSnapshot,
} from "./plugin/PluginRecipeRegistry.js";
import {
  getPluginTourRemoteAudio,
  getPluginTours,
  type PluginTourRemoteAudio,
} from "./plugin/PluginTourRegistry.js";
import { PluginRecipeMetadataStore } from "./plugin/PluginRecipeMetadataStore.js";
import {
  broadcastToRenderer,
  broadcastToProjectRenderers,
  endpointPushTarget,
  getProjectRendererTargets,
  isWithheldFromView,
  type ProjectPushTarget,
} from "../ipc/utils.js";
import type { ClientEndpoint } from "../ipc/endpoint.js";
import { getEndpointRegistry } from "../ipc/endpointRegistry.js";
import {
  PLUGIN_INVOKE_MAX_ARGS_BYTES,
  PLUGIN_INVOKE_MAX_RESULT_BYTES,
} from "../../shared/config/pluginBudgets.js";
import { assertPayloadWithinLimit, estimatePayloadBytes } from "./plugin/pluginPayloadLimits.js";
import {
  compilePluginActionResultSchema,
  enforcePluginActionResult,
  type PluginActionResultCheck,
} from "./plugin/pluginActionResultSchema.js";
import {
  PLUGIN_STATE_PANEL_ACTIVITY,
  PLUGIN_STATE_PANEL_BADGES,
  getPluginPushBatcher,
  getPluginStatePublisher,
  routePluginPush,
} from "./plugin/pluginPushBatcher.js";
import {
  PluginMetricsService,
  classifyInvokeFailure,
  type InvokePromptMark,
} from "./plugin/PluginMetricsService.js";
import { markPerformance } from "../utils/performance.js";
import { CHANNELS } from "../ipc/channels.js";
import type {
  LoadedPluginInfo,
  PluginRequiredSettingsStatus,
  PluginSetupStepCheck,
  PluginSetupStepUiAction,
  PluginSetupStepUiStatus,
  PluginSetupUiStatus,
} from "../../shared/types/plugin.js";
import {
  getProjectPluginSetupSkips,
  setProjectPluginSetupStepSkipped,
} from "./plugin/projectPluginSetupSkips.js";
import type { PluginRecipeMetadataPatch, TerminalRecipe } from "../../shared/types/project.js";
import { getPluginActionAuditService } from "./PluginActionAuditService.js";
import { stableArgsSha256 } from "../utils/pluginMcpHash.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { canDisposeIdlePluginWorker } from "../../shared/utils/workerGovernancePolicy.js";
import type { WorkerResourceSnapshot } from "../../shared/types/workerGovernance.js";
import { isAuditedHandlerFailure, markAuditedHandlerFailure } from "../utils/pluginAuditMarker.js";
import {
  PluginNotOnHostInvokeError,
  pluginIncompatibleError,
  pluginNotOnHostError,
} from "./plugin/parity/errors.js";
import { buildPluginInventory, type PluginInventory } from "./plugin/parity/inventory.js";
import {
  platformDisplayName,
  pluginInstallRefusal,
  replacementRefusal,
} from "./plugin/parity/preflight.js";
import { readArchiveManifest } from "./PluginArchive.js";
import { withTimeout, TimeoutError } from "../utils/withTimeout.js";
import type {
  PluginDiagnosticsAuditRecord,
  PluginDiagnosticsLogLine,
  PluginDiagnosticsSnapshot,
} from "../../shared/types/ipc/pluginDiagnostics.js";
import { BUILT_IN_ACTION_IDS } from "../../shared/config/actionIds.js";
import { isWindowsStoreBuild } from "../../shared/config/distribution.js";
import { CONFIRM_TRIGGERING_CAPABILITIES } from "../../shared/config/pluginCapabilities.js";

/** Plugin action IDs must be `{pluginId}.{actionId}`. Built-in IDs use colons, so the formats cannot collide. */
// The leading segment allows `_` so a project plugin's instance-qualified id
// (`project__{projectId}__{publisher}.{name}.{action}`) validates. A
// plugin-authored id can never contain `_` there — the manifest name pattern is
// `[a-z0-9-]` — so this widens the alphabet without loosening what an author
// may write.
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

const PLUGIN_ACTION_KINDS = new Set(["command", "query"]);
const PLUGIN_ACTION_DANGERS = new Set(["safe", "confirm"]);

/**
 * Built-in action ids materialised as a Set for O(1) collision lookup at
 * load time. Manifest commands whose namespaced `{pluginId}.{cmd.id}` shadows
 * a built-in id are rejected via the provenance `loadError` instead of being
 * silently registered — the renderer would otherwise see two definitions for
 * the same id and resolve in registration order, leaking command behavior to
 * whichever side won the race.
 */
const BUILT_IN_ACTION_ID_SET: ReadonlySet<string> = new Set<string>(BUILT_IN_ACTION_IDS);

/**
 * Filesystem-convention extensions probed for a manifest-declared command's
 * handler module, in precedence order. Only shippable JavaScript is probed:
 * `.ts`/`.tsx` are deliberately excluded (#10620). Node 24's type-stripping
 * makes a `.ts` handler *appear* to work for erasable syntax but throws a
 * `SyntaxError` at first dispatch on any non-erasable construct (enum,
 * parameter properties, decorators), and `.tsx` never runs — a high-confusion
 * footgun that surfaces only at runtime. A `.ts`/`.tsx` handler in a built-in
 * or sample plugin's `src/` is caught at build time by
 * `validateCommandHandlerExtensions` in `scripts/build-main.mjs`. The probe is
 * async file-access only — no module evaluation happens until dispatch time.
 */
const COMMAND_HANDLER_EXTENSIONS = [".js", ".mjs"] as const;

/**
 * Marker file `daintree-plugin dev` writes at the symlinked plugin dir root to
 * flag it for the hot-reload worker path (#9304). Presence alone is the signal;
 * the file's contents are not read.
 */
const DEV_MARKER_FILENAME = ".dev-marker";
/**
 * How long before a card-status call a removal or project close still refuses
 * it: wider than the workspace client's 150ms read coalescing, which can answer
 * a call made just after a removal with a result taken before it, and far
 * shorter than it takes to create a worktree again at the same path.
 */
const WORKTREE_CARD_READ_COALESCE_GRACE_MS = 250;
/**
 * How long a removal or project close is remembered: past any call still
 * queued or in flight from before it, which the host-call deadline bounds.
 */
const WORKTREE_CARD_TARGET_RETIRE_MS = 5 * 60_000;

/**
 * Why this dev plugin's manifest cannot be adopted right now, or `null` when it
 * can. Runs BEFORE the reconcile unloads anything, which is the whole point: a
 * manifest the author is midway through editing — unreadable, malformed, or
 * schema-invalid — must leave the running plugin alone rather than take it down
 * and fail to bring it back.
 *
 * The identity check matters as much as the schema one. `loadPlugin` keys a
 * global plugin by `manifest.name`, so a renamed manifest would register a
 * different id while the session, the unload and the status all still name the
 * old one — a reload that reports success and leaves the author's plugin gone.
 */
async function readDevManifestError(pluginDir: string, pluginId: string): Promise<string | null> {
  let json: unknown;
  try {
    json = JSON.parse(
      stripUtf8Bom(await fs.readFile(path.join(pluginDir, "plugin.json"), "utf-8"))
    );
  } catch (err) {
    return formatErrorMessage(err, "plugin.json could not be read");
  }
  const schema = getPluginManifestSchema(false);
  // Same isolation the load applies: a malformed tour alone must not refuse the
  // reload, or the dev loop would disagree with a cold start.
  const { result: parsed } = parsePluginManifestForLoad("user", json);
  if (!parsed.success) {
    return `plugin.json is not a valid manifest: ${describeManifestIssues(parsed.error.issues, schema)}`;
  }
  if (parsed.data.name !== pluginId) {
    return `plugin.json now declares "${parsed.data.name}", but this dev session is linked as "${pluginId}" — restart daintree-plugin dev to pick up the new name`;
  }
  return null;
}

const ACTIVATE_TIMEOUT_MS = 5000;
/**
 * Time budget for the dynamic `import()` step in {@link PluginService._doActivate}.
 * Separate from {@link ACTIVATE_TIMEOUT_MS} (which guards the plugin's exported
 * `activate()` function) so a plugin with a hanging top-level await cannot pin
 * an activation promise forever — which would in turn block any
 * `Promise.allSettled` fan-out (file-decoration scope activation, startup
 * activation), since `allSettled` waits for every promise to settle.
 */
const IMPORT_TIMEOUT_MS = 5000;

/**
 * Normalise the value thrown out of `activate()` into a serialisable record.
 * `unknown` becomes a stable `{ message, stack?, at }` shape so the Settings
 * diagnostic tab (and the provenance store) don't have to re-handle raw
 * error objects.
 */
function toPluginLoadError(err: unknown): PluginLoadError {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, at: Date.now() };
  }
  if (typeof err === "string") {
    return { message: err, at: Date.now() };
  }
  // `JSON.stringify(undefined)` returns `undefined`, not a string, and would
  // violate the `message: string` contract — coalesce to `String(err)` so
  // bare `throw undefined` / `throw null` still surface a usable label.
  let message: string;
  try {
    message = JSON.stringify(err) ?? String(err);
  } catch {
    message = String(err);
  }
  return { message, at: Date.now() };
}

/**
 * Run a single unload-cascade step with per-step containment. A throwing
 * disposer is logged as a warning (best-effort cleanup, not a user-actionable
 * error per the issue's containment contract) and the cascade continues so
 * subsequent registry unregisters still fire. Without this wrapping, one
 * thrown disposer would strand later steps and leak registrations that fail
 * the next load with a duplicate-id error.
 */
/** Max retained log lines per plugin in the in-memory diagnostics ring buffer. */
const PLUGIN_LOG_BUFFER_MAX = 500;
/** Max bytes for a single rendered log line; longer lines are truncated with an ellipsis. */
const PLUGIN_LOG_LINE_MAX_CHARS = 2048;
/** Max audit records included per plugin in a diagnostics snapshot. */
const PLUGIN_DIAGNOSTICS_AUDIT_PER_PLUGIN = 50;

/**
 * Serialize an arbitrary logger payload without ever throwing. Tries
 * `JSON.stringify`, falls back to `String()`, and absorbs a throwing
 * `toString` so `host.logger.*` keeps its no-throw contract for adversarial
 * `fields`. Returns the empty string only when serialization yields nothing
 * useful.
 */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    // fall through to String()
  }
  try {
    return String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Append a plugin audit record without ever surfacing an audit failure to the
 * caller. Mirrors the `safeAppend` in `electron/ipc/handlers/plugin.ts` — a
 * throw from `append()` (corrupt store, disk error) must never mask the
 * handler error we're in the middle of rethrowing. Audit is a side channel.
 */
function safeAppendAudit(
  input: Parameters<ReturnType<typeof getPluginActionAuditService>["append"]>[0]
): void {
  try {
    getPluginActionAuditService().append(input);
  } catch (err) {
    console.error("[PluginService] Failed to append audit record:", err);
  }
}

/**
 * SHA-256 of the dispatch args for forensic grouping, best-effort. A
 * serialization throw here must not mask the handler error, so it degrades to
 * an empty hash (the documented "hashing failed" sentinel).
 */
function safeArgsHash(args: unknown[]): string {
  try {
    return stableArgsSha256(args);
  } catch {
    return "";
  }
}

/**
 * Monotonic counter behind the view-generation segment. Session-scoped and
 * never reset: the renderer's module map is rebuilt whenever main restarts, so
 * a generation only has to be unique within one main-process lifetime.
 */
let nextPluginViewGeneration = 1;

/** Allocate the generation stamped into a plugin's view URLs for this load. */
export function allocatePluginViewGeneration(): number {
  return nextPluginViewGeneration++;
}

/**
 * How many view generations this session has minted. Each one permanently adds
 * a module record to a renderer's map (Chromium has no eviction API), so the
 * hot-reload path reports it rather than assuming the growth is negligible.
 */
export function pluginViewGenerationsAllocated(): number {
  return nextPluginViewGeneration - 1;
}

/**
 * Suffix match for the installer's parked-old copy (`<pluginId>.old-<uuid>`,
 * no leading dot — see `PluginInstaller._swapPluginDir` /
 * `STALE_PARKED_OLD_RE`). A real plugin dir is exactly `publisher.name`, which
 * can never end with `.old-` + a hyphenated UUID, so this can't exclude a
 * legitimate install.
 */
const PARKED_OLD_DIR_RE = /\.old-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Defence-in-depth guard for {@link PluginService.loadFromDir}: returns true for
 * any installer staging/parked/leftover dir name that must never be scanned as
 * a real plugin even if `sweepStalePluginTempDirs` missed it. Covers the parked
 * `<pluginId>.old-<uuid>` copy (no leading dot — the dot filter alone wouldn't
 * catch it) plus the dot-prefixed `.install-tmp-*` / `.update-check-*` /
 * `.old-*` staging names (belt-and-suspenders against the leading-dot filter).
 */
function isParkedOrTempDirName(name: string): boolean {
  return (
    name.startsWith(".install-tmp-") ||
    name.startsWith(".update-check-") ||
    name.startsWith(".old-") ||
    PARKED_OLD_DIR_RE.test(name)
  );
}

/**
 * `<userData>/global` — the same directory `ProjectStore` puts `recipes.json`
 * in, so the plugin recipe sidecar sits beside the global recipes it
 * deliberately never joins. Resolved at call time (`app.getPath` is invalid at
 * module evaluation).
 *
 * Returns `null` rather than a home-relative guess when the Electron app API
 * is unavailable (the minimal `electron` stubs some suites install). The
 * sidecar then runs inert. A guess would have been worse in both directions: it
 * made unit-test runs write into the user's real `~/.daintree` tree, and a
 * production `getPath` failure would silently relocate everyone's metadata to a
 * directory nothing else reads.
 */
function resolveGlobalConfigDir(): string | null {
  try {
    if (typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), "global");
    }
  } catch {
    // Unresolvable — fall through to inert.
  }
  return null;
}

/** Cheap local predicate so the class body does not import the parser twice. */
function isProjectPluginInstanceKey(pluginId: string): boolean {
  return parseProjectPluginInstanceKey(pluginId) !== null;
}

/**
 * Project-plugin lifecycle goes to the file logger, not `console.*`. A trust
 * decision that failed to persist and a manifest that would not parse are both
 * only diagnosable after the fact, and the packaged app has no console to read
 * them from (#12212).
 */
const logger = createLogger("main:PluginService");

/**
 * Read one project's trust record. Absence is the default and it means
 * disabled — discovery still runs, nothing executes.
 */
function readProjectPluginTrust(projectId: string): ProjectPluginTrustRecord | undefined {
  try {
    const all = store.get("projectPluginTrust") as
      Record<string, ProjectPluginTrustRecord> | undefined;
    const record = all?.[projectId];
    if (!record || (record.decision !== "enabled" && record.decision !== "disabled")) {
      return undefined;
    }
    return {
      decision: record.decision,
      decidedAt: typeof record.decidedAt === "number" ? record.decidedAt : 0,
      knownPluginIds: Array.isArray(record.knownPluginIds)
        ? record.knownPluginIds.filter((id): id is string => typeof id === "string")
        : [],
      stagedPluginIds: Array.isArray(record.stagedPluginIds)
        ? record.stagedPluginIds.filter((id): id is string => typeof id === "string")
        : [],
      mutedPluginIds: Array.isArray(record.mutedPluginIds)
        ? record.mutedPluginIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch (err) {
    // Fail closed: an unreadable record is not a grant.
    logger.warn("Failed to read project plugin trust", { projectId, error: err });
    return undefined;
  }
}

/**
 * Write (or clear) one project's trust record. Always rewrites the whole map —
 * electron-store dot-notation would nest on a key containing dots, and a
 * project id is opaque.
 *
 * Returns whether the record reached disk. A consent decision that silently
 * failed to persist is the worst of both worlds: the session behaves as though
 * the user answered, and the next launch asks again with no trace of why
 * (#12212). The caller propagates a `false` to the renderer rather than
 * assuming the write landed.
 */
function writeProjectPluginTrust(
  projectId: string,
  record: ProjectPluginTrustRecord | undefined
): boolean {
  try {
    const all = {
      ...((store.get("projectPluginTrust") as Record<string, ProjectPluginTrustRecord>) ?? {}),
    };
    if (record === undefined) {
      delete all[projectId];
    } else {
      all[projectId] = record;
    }
    store.set("projectPluginTrust", all);
    return true;
  } catch (err) {
    logger.error("Failed to persist project plugin trust", err, {
      projectId,
      decision: record?.decision ?? "cleared",
    });
    return false;
  }
}

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  /**
   * The single map the `plugin://` protocol handler resolves a URL authority
   * against. Each load seeds two keys pointing at the same root: the opaque
   * authority minted for that load, and the plugin's manifest id as an alias —
   * plugin authors write `plugin://{pluginId}/…` by hand and that contract is
   * documented (docs/plugins/contribution-points.md). One map, so the handler
   * keeps exactly one resolution path.
   *
   * Both keys are dropped on unload, but only the authority is per-load: it is
   * never reissued, so a host-minted URL captured before an unload 404s forever
   * rather than resolving into whatever next occupies that plugin id. The alias
   * keeps plain id semantics by construction — a reload rebinds it — which is
   * exactly what a hand-written `plugin://{pluginId}/…` URL asks for.
   *
   * The alias is the registry key, so a project instance's is its qualified
   * instance key, never the bare manifest id. Each key also records the
   * instance that owns it: per-project instances of
   * one installed package share a root, so the root alone can't say whose
   * authority a request named (#14257).
   */
  private pluginRootsByAuthority = new Map<string, { dir: string; pluginId: string }>();
  /** pluginId → the authority minted for its current load; the invalidation and URL-building side. */
  private pluginAuthorities = new Map<string, PluginProtocolAuthority>();
  /**
   * Live panel badges set via `host.setPanelBadge`, keyed `pluginId → panelId →
   * badge` (#10585). Plugin-first so {@link unloadPlugin} drops a plugin's whole
   * set in O(1), and {@link pushSnapshotTo} can replay each plugin's current
   * badges to a cold-restored WebContentsView (badges are ephemeral, not
   * persisted, so without replay an LRU-evicted view loses them until the plugin
   * next re-emits). The renderer store inverts this to `panelId → pluginId` for
   * O(1) lookup at render time.
   */
  private pluginBadges = new Map<string, Map<string, PluginPanelBadge>>();
  /**
   * Live toolbar-button badges set via `host.setToolbarButtonBadge`, keyed
   * `pluginId → buttonId → badge` (#13503), with `buttonId` the manifest's own
   * id. Held and replayed like {@link pluginBadges}, but scoped to the owning
   * project like {@link runningActions}, since a project plugin's toolbar
   * buttons only exist in that project's views.
   */
  private pluginToolbarBadges = new Map<string, Map<string, PluginPanelBadge>>();
  /**
   * Activity reports set via `host.setPanelActivity`, keyed `pluginId →
   * panelId → report` (#13820). Scoped like {@link pluginToolbarBadges}: a
   * project plugin's panels only exist in that project's views.
   */
  private pluginPanelActivity = new Map<string, Map<string, PluginPanelActivityReport>>();
  /** Last revision handed to an accepted activity report; never reset. */
  private panelActivityRevision = 0;
  /**
   * Tasks started via `host.tasks.start` (#13819). Scoped like
   * {@link pluginToolbarBadges}: a project plugin's tasks show only in that
   * project's views. Interrupted tasks outlive their plugin's unload.
   */
  private pluginTasks = new PluginTaskRegistry((pluginId) => this.emitPluginTasks(pluginId));
  /**
   * The session's artifact cache (#14100), created on first use so a run that
   * never touches artifacts never creates its directory. Null after shutdown.
   */
  private artifactService: PluginArtifactService | null | undefined;
  /** Views whose `destroyed` already revokes their playback leases. */
  private readonly artifactLeaseViews = new Set<number>();
  /**
   * Live toolbar-button state set via `host.setToolbarButtonState`, keyed
   * `pluginId → buttonId → state` (#13785). Held, scoped, cleared and replayed
   * exactly like {@link pluginToolbarBadges}.
   */
  private pluginToolbarStates = new Map<string, Map<string, PluginToolbarButtonRuntimeState>>();
  /**
   * `when`-clause context keys set via `host.setContext`, keyed `pluginId → key
   * → value` (#13506). Held, scoped and replayed like
   * {@link pluginToolbarBadges}: a project plugin's keys reach only its own
   * project's views, and a cold-restored view gets them back through
   * {@link pushSnapshotTo}.
   */
  private pluginContextKeys = new Map<string, Map<string, PluginContextValue>>();
  /**
   * Worktree card statuses set via `host.setWorktreeCardStatus`, keyed
   * `pluginId → projectId → worktreeId → status` (#13704). Every bucket is
   * sent only to its own project's views — an app-global plugin included,
   * since each status names the project its worktree was read from — and
   * replayed to a cold-restored view through {@link pushSnapshotTo}.
   */
  private pluginWorktreeCardStatuses = new Map<
    string,
    Map<string, Map<string, PluginWorktreeCardStatus>>
  >();
  /**
   * Terminal header statuses set via `host.setTerminalStatus`, keyed `pluginId
   * → projectId → terminalId → status` (#13802). Held, scoped and replayed like
   * {@link pluginWorktreeCardStatuses}: each bucket reaches only its own
   * project's views.
   */
  private pluginTerminalStatuses = new Map<
    string,
    Map<string, Map<string, PluginTerminalStatus>>
  >();
  /** Bumped per plugin on each clear of its terminal statuses. */
  private terminalStatusGenerations = new Map<string, number>();
  /** Bumped on every project close, so a setter still reading terminals can tell. */
  private terminalStatusCloseRevision = 0;
  private closedTerminalStatusProjects = new Map<string, number>();
  /** Bumped per plugin on each clear of its statuses; see `worktreeCardStatusGeneration`. */
  private worktreeCardStatusGenerations = new Map<string, number>();
  /**
   * Readiness checks set via `host.setWorktreeReviewChecks`, keyed `pluginId →
   * projectId → worktreeId → checks` (#13806). Scoped, replayed and cleaned up
   * exactly like {@link pluginWorktreeCardStatuses}, and retired by the same
   * removal and close records.
   */
  private pluginWorktreeReviewChecks = new Map<
    string,
    Map<string, Map<string, readonly PluginWorktreeReviewCheck[]>>
  >();
  /** Bumped per plugin on each clear of its checks; see `worktreeReviewChecksGeneration`. */
  private worktreeReviewChecksGenerations = new Map<string, number>();
  /**
   * When each worktree was removed (`w:{id}`) or project closed (`p:{id}`), so
   * a setter whose worktree read was already in flight — or answered from the
   * workspace client's short read coalescing — cannot put a status back.
   */
  private retiredWorktreeCardTargets = new Map<string, { revision: number; at: number }>();
  /** Bumped on every removal or close recorded in {@link retiredWorktreeCardTargets}. */
  private worktreeCardTargetRevision = 0;
  /**
   * Runtime panel menus set via `host.setPanelMenuItems`, keyed `pluginId →
   * panelId → items` (#13213). Held here for the same reason as
   * {@link pluginBadges}: a cold-restored view gets them back through
   * {@link pushSnapshotTo}, and an unload drops a plugin's whole set.
   */
  private pluginPanelMenus = new Map<string, Map<string, readonly PublishedPanelMenuItem[]>>();
  /**
   * Action handlers in flight, keyed `pluginId → actionId → count`, so the host
   * can draw a toolbar button busy and tell a view an action is running however
   * it was dispatched (palette, menu, toolbar, keybinding, agent). Counted
   * because two dispatches of one action can overlap. Ephemeral like badges:
   * dropped on unload and replayed to a cold-restored view.
   */
  private runningActions = new Map<string, Map<string, number>>();
  /**
   * Per-plugin diagnostic log ring buffer, keyed by `pluginId` (= manifest
   * name). Written by `host.logger.*`, capped at {@link PLUGIN_LOG_BUFFER_MAX}
   * lines (FIFO eviction), and cleared in {@link unloadPlugin} so a reload of
   * the same plugin starts clean. Lines are stored scrubbed — this buffer is
   * itself an outbound boundary (it feeds {@link getDiagnosticsSnapshot} →
   * shareable bug reports), and the same scrubbed line mirrors to the console,
   * so {@link recordPluginLog} runs `scrubSecrets` once before either sink.
   */
  private logBuffers = new Map<string, PluginDiagnosticsLogLine[]>();
  /**
   * Rate bound for everything this service writes to `daintree.log` on a
   * plugin's behalf — its own `host.logger` reports and the lifecycle the host
   * observes. The ring above is the full-fidelity record; the file gets a
   * bounded share that survives a crash (#12804).
   */
  private fileLogLimiter = new PluginFileLogLimiter();
  /**
   * The last load error written to the file per loaded instance, so a plugin
   * failing every retry logs the failure once rather than once per attempt.
   * Keyed by the instance, not the id: a reload is a new load that should
   * record its first failure even when it matches the previous one.
   */
  private fileLoggedLoadErrors = new WeakMap<LoadedPlugin, string>();
  /**
   * Owns the typed/legacy IPC handler maps, the registration capability gate,
   * per-channel schema/requires bookkeeping, and per-plugin removal. The
   * dispatch path ({@link dispatchHandler}, which stays here) reads the maps
   * through the collaborator's getters so dispatch semantics are unchanged.
   */
  private readonly channels: PluginChannelRegistry;
  /** User-owned half of plugin-contributed recipes (#11860). */
  private readonly recipeMetadata: PluginRecipeMetadataStore;
  /**
   * Plugin directory names seen across every configured root during
   * {@link initialize}. Directory name IS the plugin id, so this is the
   * "what is installed" side of the metadata reconciliation — deliberately
   * independent of whether the manifest parsed or the plugin was allowed to
   * load, so a disabled, blocked, or broken plugin keeps its metadata.
   */
  private startupInstalledPluginIds = new Set<string>();
  private cleanupMap = new Map<string, () => void>();
  /**
   * Plugin ids whose `activate()` has resolved successfully this session.
   * Checked synchronously by {@link activatePlugin} as the fast path so a
   * hot dispatch site (e.g. `dispatchHandler`) doesn't pay an async hop on
   * every call. Cleared in `unloadPlugin` so a runtime unload+reload cycle
   * re-runs activation.
   */
  private activatedPlugins = new Set<string>();
  /**
   * In-flight activation promises keyed by plugin id. Concurrent callers
   * (e.g. a panel open + an action dispatch racing in the same tick) await
   * the same promise so `_doActivate` runs exactly once per activation.
   * On success the entry stays cached until unload; on failure it is
   * deleted so a Settings → "Retry activation" can re-run.
   */
  private activationPromises = new Map<string, Promise<void>>();
  private pluginActions = new Map<string, PluginActionDescriptor>();
  private pluginActionOwners = new Map<string, Set<string>>();
  private actionValidators = new Map<string, ValidateFn>();
  /**
   * Compiled `resultSchema` checks, keyed by the descriptor they were built
   * with rather than by action id. Every registration path stores the very
   * descriptor `validateAndBuildActionDescriptor` returned, so replacing or
   * removing an action replaces or drops its check with nothing to evict, and
   * a dispatch already running keeps the contract it started under.
   */
  private actionResultChecks = new WeakMap<PluginActionDescriptor, PluginActionResultCheck>();
  /**
   * Main-side action handler closures keyed by the same namespaced action id
   * (`{pluginId}.{actionId}`) used by {@link pluginActions}. Populated only via
   * `host.registerAction` — the renderer-side IPC `registerPluginAction` path
   * stores metadata only, so a key present here is definitionally a main-side
   * handler. The closures never cross the IPC boundary; `dispatchHandler`
   * invokes them directly when a `plugin:invoke` lands on the action id.
   */
  private pluginActionHandlers = new Map<string, ActionHandler>();
  /**
   * Resolved on-disk paths for manifest-declared command handler modules,
   * keyed by namespaced action id (`{pluginId}.{cmd.id}`). Populated at
   * `loadPlugin()` time by probing `src/{cmd.id}.{ts,tsx,js,mjs}` — the
   * module is NOT imported until first dispatch in {@link dispatchHandler}.
   * Absence (no entry for a registered descriptor) means the file was not
   * found at load time and dispatch will surface the documented
   * `Command "{id}" has no handler` error. Entries are cleared on unload
   * via {@link unregisterPluginActions} alongside the matching descriptor.
   */
  private commandModulePaths = new Map<string, string>();
  /**
   * In-flight command-handler discovery, keyed by plugin id. Set synchronously
   * on the same tick the plugin becomes addressable and cleared when probing
   * settles, so activation can tell "this plugin has no command handlers" apart
   * from "we have not looked yet" (#12274).
   *
   * Without it, an activation trigger that lands mid-probe reads an empty
   * {@link commandModulePaths}, concludes the plugin needs no worker, and
   * `activatePlugin` latches that verdict in `activatedPlugins` for the
   * plugin's lifetime — leaving a commands-only plugin permanently unable to
   * fork the worker its commands now need.
   */
  private commandDiscovery = new Map<string, Promise<void>>();
  /**
   * Set of namespaced action ids whose descriptor was registered from
   * `manifest.contributes.commands`. Distinguishes a manifest-declared
   * command (whose handler is the lazy `src/{cmd.id}.{ext}` import) from
   * an imperative `host.registerAction` descriptor (which always pairs
   * with a closure in {@link pluginActionHandlers}). Drives the
   * "Command \"{id}\" has no handler" toast text in {@link dispatchHandler}
   * — without this set, a manifest command with a missing handler file
   * would fall through to the generic "No plugin handler registered" path.
   * Cleared per-plugin in {@link unregisterPluginActions}.
   */
  private manifestCommandIds = new Set<string>();
  /**
   * Plugin ids whose provenance record carries a load-time `loadError` that
   * is independent of the plugin's `main` activation outcome — e.g. a
   * manifest command id colliding with a built-in action id (#9281). When
   * `_doActivate()` finishes successfully it normally clears `loadError` to
   * `null`; entries here are exempted from that clear so the diagnostic
   * survives. Cleared on unload alongside the rest of the per-plugin state.
   */
  private pluginsWithLoadTimeErrors = new Set<string>();
  /**
   * Plugin instances (by id, version and range) already warned about an unmet
   * `engines.daintree` range this session. Project switches, watcher re-scans and dev rebuilds all
   * re-run the load gate, and each would otherwise re-toast the same warning.
   */
  private engineMismatchWarned = new Set<string>();
  /**
   * Runtime load/activation errors for project plugin instances (#12232).
   *
   * A project plugin loads under an instance key that
   * {@link PluginInstalledRecordsStore.upsertInstalledRecord} deliberately
   * refuses to persist — the key names one machine's project id and the plugin
   * has no install provenance to record. Every `loadError` write on the load
   * and activation paths went through that store, so for a project plugin the
   * error was written to nothing at all and `getPluginLoadError` reported a
   * clean load however the activation had actually gone.
   *
   * This is the same channel with the persistence removed: session-scoped,
   * keyed by the instance key the call sites already use, and dropped in
   * `unloadPlugin` with the rest of the per-plugin state.
   */
  private projectPluginLoadErrors = new Map<string, PluginLoadError>();
  private ajv: AjvInstance | null = null;
  private pluginEventCleanups = new Map<string, Array<() => void>>();
  /**
   * Each loaded instance's manifest event routes (#13816). Deliberately apart
   * from {@link pluginEventCleanups}: those are live subscriptions that keep a
   * worker from idle disposal, while routes exist to outlive the worker. Torn
   * down only when the instance unloads.
   */
  private pluginEventRoutes = new Map<string, PluginEventRoutes>();
  private workspaceClient: WorkspaceClient | null = null;
  /**
   * Service-level `worktree-activated` listener that evicts stale worktree-scoped
   * storage stores (#10621). Independent of any plugin's
   * `onDidChangeActiveWorktree` so a worktree switch always drops the prior
   * worktree's cached in-memory snapshot even when no plugin subscribed.
   */
  private readonly onWorktreeActivatedForCache = (): void => {
    this.storage.evictWorktreeScopedStores();
  };
  /**
   * Drop every plugin's card status for a removed worktree (#13704), so a
   * worktree later created at the same path starts bare. A worktree id is its
   * path, so the id alone names it; only a positive removal prunes — an empty
   * or unavailable worktree read never does.
   */
  private readonly onWorktreeRemovedForCardStatuses = (payload: { worktreeId: string }): void => {
    this.retireWorktreeCardTarget(`w:${payload.worktreeId}`);
    for (const [pluginId, byProject] of [...this.pluginWorktreeCardStatuses]) {
      for (const [projectId, statuses] of [...byProject]) {
        if (!statuses.delete(payload.worktreeId)) continue;
        if (statuses.size === 0) byProject.delete(projectId);
        if (byProject.size === 0) this.pluginWorktreeCardStatuses.delete(pluginId);
        this.emitWorktreeCardStatuses(pluginId, projectId);
      }
    }
    for (const [pluginId, byProject] of [...this.pluginWorktreeReviewChecks]) {
      for (const [projectId, checks] of [...byProject]) {
        if (!checks.delete(payload.worktreeId)) continue;
        if (checks.size === 0) byProject.delete(projectId);
        if (byProject.size === 0) this.pluginWorktreeReviewChecks.delete(pluginId);
        this.emitWorktreeReviewChecks(pluginId, projectId);
      }
    }
  };
  /**
   * Event subscriptions registered during plugin `activate()` when the
   * WorkspaceClient did not yet exist. Replayed in `setWorkspaceClient()`
   * so early-boot subscriptions attach to the real client instead of being
   * silently dropped.
   */
  /**
   * The {@link PluginHostBinding} each loaded plugin's host was built with.
   *
   * Only collaborators that outlive a single host closure need this — today
   * just the shared {@link PluginProcessManager}'s stream sink, which is one
   * instance for every plugin and so cannot close over one binding. Everything
   * else reads the binding captured inside its own host object. Dropped in
   * `unloadPlugin` so a reload of the same id can rebind.
   */
  private hostBindings = new Map<string, PluginHostBinding>();

  private pendingWorktreeSubs: Array<{
    pluginId: string;
    event: WorkspaceWorktreeEvent;
    handler: (payload?: PluginWorktreeEventPayload) => void;
    activate: (client: WorkspaceClient) => void;
  }> = [];
  private initialized = false;
  /**
   * Plugin ids that are currently disabled in Preferences and were therefore
   * skipped at load time. Held alongside `this.plugins` so a later dir scan
   * cannot register a different plugin under a claimed namespace just because
   * the matching plugin is turned off — the namespace stays reserved even when
   * activation is skipped. Covers both built-in and user plugins (#9284).
   */
  private reservedNames = new Set<string>();
  /**
   * Manifest metadata for plugins skipped because they're disabled, keyed by
   * `manifest.name`. Populated at `loadPlugin()` skip time so `listPlugins()`
   * can still surface disabled plugins (with `disabled: true`) for the
   * Preferences toggle, without re-scanning directories. Built-in entries win
   * on a name collision (loaded first), mirroring the duplicate guard.
   */
  private disabledPlugins = new Map<
    string,
    { manifest: PluginManifest; dir: string; isBuiltin: boolean }
  >();
  /**
   * Manifest metadata for plugins refused at load time by the remote blocklist
   * / kill-switch (#10891), keyed by `manifest.name`. Populated at `loadPlugin()`
   * skip time so `listPlugins()` can surface the block (with `blocklisted: true`
   * and the reason) without re-scanning. Parallel to `disabledPlugins` but a
   * distinct, host-decided state the user cannot toggle off. `reason` is the
   * human-facing explanation for the UI/notification.
   */
  private blockedPlugins = new Map<
    string,
    { manifest: PluginManifest; dir: string; isBuiltin: boolean; reason: string }
  >();
  /**
   * The blocklist resolved once at `initialize()` and enforced for the whole
   * session (including later install-time loads). `null` when no validated list
   * is available (offline first run, fetch failure) — the fail-open state.
   * Resolved once up front rather than per-plugin so the `Promise.allSettled`
   * load fan-out never awaits a network call (#9428).
   */
  private startupBlocklist: ParsedPluginBlocklist | null = null;
  private readonly blocklistService: PluginBlocklistService;
  /**
   * Per-plugin transition chain for live enable/disable (#9304, #10887). A
   * rapid disable→enable→disable on the same id must not interleave the
   * unload/load mutations to `plugins`/`disabledPlugins`/`reservedNames`, so
   * each `setEnabled` chains onto the prior transition for that id. Applies to
   * both built-in and user plugins. Keyed by `manifest.name`; the entry is
   * dropped once its chain settles.
   */
  private readonly enableTransitions = new Map<string, Promise<void>>();
  private records = new PluginInstalledRecordsStore();
  /**
   * Installed `instanceMode: "project"` packages, by manifest id: a catalog of
   * what is on disk and nothing more. No runtime, contributions, worker or
   * watcher exists for an entry; those belong to the per-project instances
   * below. Empty on a vanilla install.
   */
  private readonly projectInstancePackages = new Map<
    string,
    { dir: string; manifest: Readonly<PluginManifest> }
  >();
  private readonly projectInstanceStore = new PluginProjectInstanceStore();
  /** Live instance keys of installed packages. Repository-local plugins are the controller's. */
  private readonly installedInstanceKeys = new Set<string>();
  /**
   * Bumped by a project close and by an instance's disable, so an in-flight
   * load that was requested before either lands as a no-op instead of
   * resurrecting what was just turned off. Read at request time.
   */
  private readonly installedInstanceProjectEpochs = new Map<string, number>();
  private readonly installedInstanceEpochs = new Map<string, number>();
  private readonly installedInstanceChains = new Map<string, Promise<void>>();
  /** Projects the host has been told are open, with their roots. */
  private readonly openProjectRoots = new Map<string, string>();
  /**
   * Manager for child processes spawned via `host.process.spawn` (#9234).
   * Lazily constructed so the `node:child_process` spawn path only wires up
   * when a plugin actually uses it. The stream sink fans each process's
   * stdout/stderr/exit out to the owning plugin's panels over the same
   * `postToPanel` transport (`plugin:{pluginId}:process`); the auditor records
   * each spawn in the plugin audit trail.
   */
  private processManager: PluginProcessManager | null = null;
  /** Lazily built on the first interactive spawn; see {@link getPluginPtyTransport}. */
  private pluginPtyTransport: PluginPtyTransport | null = null;
  /**
   * Active `host.fs.watch` watchers keyed by pluginId — each entry is a disposer
   * that closes the underlying `fs.watch` handle. Torn down on unload so a
   * disable/revoke can't strand a file watcher (#7880 / fs-API containment unit).
   */
  private pluginFsWatchers = new Map<string, Set<() => void>>();
  /**
   * Test seam: override the git client factory `host.git` uses so commit/add/
   * diff/status can be exercised against a fake simple-git without forking a
   * real repo. Production leaves it `undefined` → {@link PluginHostGit} defaults
   * to `createHardenedGit`.
   */
  private hostGitFactory: HostGitFactory | undefined = undefined;
  /**
   * Live plugin workers, keyed by pluginId (#9304, #10526). Every user-installed
   * plugin (dev and prod) runs in a forked `utilityProcess`; built-ins activate
   * in-process and are absent here. Each entry holds that lifecycle, the message
   * bridge to the real host, and the host `revoke` to call on unload. Disposed
   * via the {@link cleanupMap} disposer registered at activation, so
   * `unloadPlugin` tears the worker down through its normal cascade.
   */
  private pluginWorkers = new Map<
    string,
    {
      workerHost: PluginDevWorkerHost;
      bridge: PluginDevWorkerMainBridge;
      revoke: () => void;
      /** Full teardown — the same disposer registered in {@link cleanupMap}. */
      cleanup: () => void;
      /**
       * Verdict of this entry's last activation: `undefined` while one is in
       * flight, `false` once it failed. Read by {@link activateViaWorker} so a
       * retry against a live-but-failed worker forks a fresh one instead of
       * short-circuiting on the entry's mere existence (#12275).
       */
      activation: { ok?: boolean };
    }
  >();
  /**
   * Last time each plugin was needed (activation trigger, action dispatch,
   * panel/forge/decoration pull — all funnel through `activatePlugin`). Drives
   * the idle gate for governance worker disposal; entries die with the plugin.
   */
  private pluginWorkerActivity = new Map<string, number>();
  private pluginsRoot: string;
  /**
   * Optional override for the built-in plugins directory. When unset, the
   * canonical app-bundled path is resolved lazily at `initialize()` time via
   * {@link getBuiltinDir}. Tests pass an explicit path so they don't depend
   * on `app.isPackaged` / `process.resourcesPath`.
   */
  private builtinPluginsRoot: string | undefined;

  /**
   * E2E-only backdoor: an additional directory scanned after the regular
   * built-in + user scans, with `isBuiltin: true` so plugins claiming the
   * reserved `daintree.*` namespace (e.g. the `hello-daintree` sample) can
   * load. Never set in production — the env-var read in the singleton is
   * constant-folded to `""` via `scripts/build-main.mjs` defines.
   */
  private sideloadPluginsRoot: string | undefined;
  private readonly whenProtocolReady: (() => Promise<void>) | undefined;
  private appVersion: string;
  /**
   * Owns the coalesced per-tick contribution broadcasts (actions, panel kinds,
   * toolbar buttons, keybindings, context-menu items) plus the
   * cold-start {@link pushSnapshotTo} replay. Constructed in the constructor
   * after {@link catalogPromise} is set, so it can await the catalog gate.
   */
  private readonly broadcaster: PluginContributionBroadcaster;
  /**
   * Answers the quick switcher's queries to plugin search providers (#13792).
   * A scoped search may activate a plugin; a blended one never reaches this
   * `activatePlugin` (the coordinator refuses an unbound runtime provider).
   */
  readonly searchCoordinator = new PluginSearchCoordinator({
    activatePlugin: (pluginId) => this.activatePlugin(pluginId),
    recordDiagnostic: (pluginId, message) => {
      const plugin = this.plugins.get(pluginId);
      if (plugin) this.recordPluginLog(plugin, pluginId, "warn", message);
    },
    hiddenProviderKeys: () => new Set(getHiddenSearchProviders()),
  });
  /**
   * Services between plugins (#14105): resolves each `host.services` call to a
   * provider instance, starts it if needed, and owns the call until it settles.
   */
  private readonly services = new PluginServiceBroker({
    getPlugin: (pluginId) => this.plugins.get(pluginId),
    isVisibleInProject: (pluginId, projectId) => isPluginVisibleInProject(pluginId, projectId),
    isActivated: (pluginId) => this.activatedPlugins.has(pluginId),
    activatePlugin: (pluginId) => this.activatePlugin(pluginId),
    reportUnresolvedRequired: (pluginId, message) => {
      const plugin = this.plugins.get(pluginId);
      if (plugin) this.recordPluginLog(plugin, pluginId, "warn", message);
    },
  });
  private readonly panelLifecycleBroker: PluginPanelLifecycleBroker;
  /** Per-plugin cost observations, read by the perf IPC and the dev CLI. */
  readonly metrics: PluginMetricsService;
  /** sourceId → detach its `destroyed` listener. See `watchPanelLifecycleSource`. */
  private readonly panelLifecycleSourceCleanups = new Map<number, () => void>();
  private disposed = false;
  private readonly disposeRegistrySubscriptions: () => void;
  /**
   * Set once a startup scan has enumerated every plugin root, which is what
   * makes the theme catalog authoritative: before it, or after a scan that
   * threw, a selected plugin theme missing from the catalog may simply not
   * have loaded yet, so it is replaced only when its own plugin is known to
   * have loaded without it or to have been removed (#13832).
   */
  private pluginThemeCatalogReady = false;
  private pluginThemeSyncQueued = false;
  /** Theme-bearing plugins between `unloadPlugin(id, { reload: true })` and its settle. */
  private readonly pluginThemeReloads = new Set<string>();
  /** Theme-bearing plugins an unload removed for good since the last sync. */
  private readonly pluginThemeRemovals = new Set<string>();
  /** Whether the catalog changed since renderers were last sent it. */
  private pluginThemeCatalogDirty = false;
  /**
   * Resolves once {@link initialize} and {@link activateStartupFinishedPlugins}
   * have both settled (or {@link dispose} has run): the fully-started gate.
   * Settled in `finally` so a plugin activation failure never permanently
   * deadlocks a caller (#9285).
   */
  private readonly initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;
  /**
   * Resolves once {@link initialize} has settled (or startup activation or
   * {@link dispose} has): the manifest catalog gate (#14127). Renderer
   * pull-on-mount IPC handlers await this so a fresh `getActions` /
   * `getPanelKinds` / `toolbarButtons` call can't return `[]` while plugins are
   * still being scanned, without also waiting on any plugin's activation.
   */
  private readonly catalogPromise: Promise<void>;
  private resolveCatalog: (() => void) | null = null;
  /**
   * True while {@link initialize} is enumerating the startup roots. The
   * registries hold a partial catalog then, so no `complete` snapshot may be
   * published from them — see the broadcaster's `isRegistryUnsettled` dep.
   */
  private catalogScanInFlight = false;
  /** The in-flight {@link initialize}, so a concurrent call joins it rather than scanning twice. */
  private initializing: Promise<void> | null = null;
  /**
   * Owns the `host.dispatch()` main→renderer round-trip: the active-renderer
   * resolution, the lazy `ipcMain` response listener, and the pending-request
   * map with per-request timeout + destroyed-cleanup. Torn down from
   * {@link dispose}.
   */
  private readonly dispatcher: PluginRendererDispatcher;
  private readonly panelReloadDispatcher: PluginPanelReloadDispatcher;
  /** Registers manifest contributions at load and owns their unregister cascade. */
  private readonly contributions: PluginContributionRegistrar;
  /**
   * Owns the imperative `host.showQuickPick`/`showInputBox`/`showConfirm`
   * main→renderer round-trip (#10522): the active-renderer resolution, the lazy
   * `ipcMain` response listener, the pending-prompt map, and the per-plugin
   * cancel drain on unload. Torn down from {@link dispose}.
   */
  private readonly promptDispatcher: PluginUIPromptDispatcher;
  /**
   * Owns the per-(plugin, scope, path) settings store cache, scope/file-path
   * resolution, subscriber notification, the settings-template resolver, and the
   * renderer-facing settings-UI bridge. The settings stores and subscribers live
   * inside it; the manifest stays core-owned and is read through an injected
   * lookup callback.
   */
  private readonly settings: PluginSettingsManager;
  /** Host-managed `contributes.account` sign-ins and their keychain-held tokens (#13823). */
  private readonly accounts: PluginAccountService;
  /**
   * Owns the per-(plugin, scope, path) private-storage store cache, scope and
   * file-path resolution (including the `"worktree"` scope that resolves the
   * active worktree at call time), and subscriber notification for the machine-
   * owned `host.storage` API. Deliberately separate from {@link settings}: storage
   * has no declared-key gating, no secret routing, and never surfaces in the
   * settings UI.
   */
  private readonly storage: PluginStorageManager;
  /**
   * Owns the atomic install/upgrade orchestration, the manual update-check
   * download/compare flow, the uninstall flow, and the stale-temp-dir sweep at
   * init. Reaches core lifecycle (load/unload/activate, record CRUD, archive
   * hashing, provenance broadcast) purely through the injected callback bag, so
   * it never imports the PluginService class — breaking the cycle.
   */
  private readonly installer: PluginInstaller;

  constructor(
    pluginsRoot?: string,
    appVersion?: string,
    options?: {
      builtinPluginsRoot?: string;
      sideloadPluginsRoot?: string;
      blocklistService?: PluginBlocklistService;
      /** Overridable so tests can point the recipe metadata sidecar at a tmpdir. */
      globalConfigDir?: string | null;
      /**
       * Settles once `plugin://` requests reach this service's authorities.
       * Every load awaits it before minting anything addressable (#12996).
       * Absent means requests are always served, which only a test harness
       * without a protocol handler can claim.
       */
      whenProtocolReady?: () => Promise<void>;
    }
  ) {
    this.pluginsRoot = pluginsRoot ?? path.join(os.homedir(), ".daintree", "plugins");
    this.recipeMetadata = new PluginRecipeMetadataStore(
      options?.globalConfigDir ?? resolveGlobalConfigDir()
    );
    this.appVersion = appVersion ?? app.getVersion();
    this.builtinPluginsRoot = options?.builtinPluginsRoot;
    this.sideloadPluginsRoot = options?.sideloadPluginsRoot;
    this.whenProtocolReady = options?.whenProtocolReady;
    this.blocklistService = options?.blocklistService ?? new PluginBlocklistService();

    this.initPromise = new Promise<void>((resolve) => {
      this.resolveInit = resolve;
    });
    this.catalogPromise = new Promise<void>((resolve) => {
      this.resolveCatalog = resolve;
    });

    this.metrics = new PluginMetricsService({
      host: {
        isKnownPlugin: (pluginId) => this.plugins.has(pluginId),
        isCurrentGeneration: (pluginId, generation) =>
          this.pluginAuthorities.get(pluginId) === generation,
        isolationOf: (pluginId) =>
          this.plugins.get(pluginId)?.isBuiltin === true ? "in-process" : "worker",
        workerPids: () => this.liveWorkerPids(),
      },
    });
    getPluginPushBatcher().setFlushObserver((pluginId, messages, bytes) =>
      this.metrics.recordPushes(pluginId, messages, bytes)
    );

    this.broadcaster = new PluginContributionBroadcaster({
      isDisposed: () => this.disposed,
      listPluginActions: () => this.listPluginActions(),
      catalogReady: this.catalogPromise,
      listPluginRuntimeStatuses: () => this.listPluginRuntimeStatuses(),
      isRegistryUnsettled: () => this.devReplaceDepth > 0 || this.catalogScanInFlight,
    });

    // Ownership is resolved against the live kind registry rather than trusted
    // from the renderer's payload, so a plugin can never be addressed with
    // another plugin's panel events (#11301).
    this.panelLifecycleBroker = new PluginPanelLifecycleBroker(
      (panelKindId) => getPanelKindConfig(panelKindId)?.extensionId
    );

    this.dispatcher = new PluginRendererDispatcher({
      isDisposed: () => this.disposed,
    });

    this.panelReloadDispatcher = new PluginPanelReloadDispatcher({
      isDisposed: () => this.disposed,
      locate: (panelId, pluginId) => this.panelLifecycleBroker.locate(panelId, pluginId),
      resolveWebContents: (id) => resolveLiveWebContents(id),
      isCached: (id) => isCachedViewWebContents(id),
      projectFor: (id) => getProjectForWebContents(id),
      resolveEndpoint: (handle) => getEndpointRegistry().getByHandle(handle),
    });

    this.contributions = new PluginContributionRegistrar({
      broadcaster: this.broadcaster,
      panelLifecycleBroker: this.panelLifecycleBroker,
      panelReloadDispatcher: this.panelReloadDispatcher,
      getWorkspaceClient: () => this.workspaceClient,
      isCurrent: (pluginId, plugin) => this.plugins.get(pluginId) === plugin,
      getLoadedPlugin: (pluginId) => this.plugins.get(pluginId),
      recordPluginLog: (plugin, pluginId, level, message) =>
        this.recordPluginLog(plugin, pluginId, level, message),
      pluginDataDir: (pluginId) => this.pluginDataDir(pluginId),
      publishProjectSurfaces: (projectIds) => this.publishProjectSurfaces(projectIds),
      themesChanged: (pluginId, change) => {
        this.pluginThemeCatalogDirty = true;
        if (change === "reloading") this.pluginThemeReloads.add(pluginId);
        else if (change === "removed") this.pluginThemeRemovals.add(pluginId);
        this.schedulePluginThemeSync();
      },
    });

    this.promptDispatcher = new PluginUIPromptDispatcher({
      isDisposed: () => this.disposed,
    });

    this.settings = new PluginSettingsManager({
      getPluginsRoot: () => this.pluginsRoot,
      // Fall back to disabledPlugins so settings for a launch-disabled plugin
      // still resolve its declared fields — its row in the manager dialog now
      // renders a settings form whether or not the plugin is running.
      getManifest: (pluginId) =>
        (this.plugins.get(pluginId) ?? this.disabledPlugins.get(pluginId))?.manifest,
      onSettingChanged: (pluginId) => this.emitSettingsChanged(pluginId),
    });

    this.accounts = new PluginAccountService({
      getSettingsRoot: () => this.settings.settingsRoot(),
      getManifest: (pluginId) =>
        (this.plugins.get(pluginId) ?? this.disabledPlugins.get(pluginId))?.manifest,
      // The settings row listens for the same event to re-read its status.
      // An installed plugin's connection can back its project instances'
      // bindings, so their setup strips and pickers re-read too.
      onAccountChanged: (pluginId) => {
        this.emitSettingsChanged(pluginId);
        if (projectIdFromPluginInstanceKey(pluginId) !== null) return;
        for (const instanceId of this.plugins.keys()) {
          if (instanceId !== pluginId && pluginManifestIdFromInstanceKey(instanceId) === pluginId) {
            this.emitSettingsChanged(instanceId);
          }
        }
      },
      bindings: pluginAccountBindings,
    });

    this.storage = new PluginStorageManager({
      getPluginsRoot: () => this.pluginsRoot,
      // The UNBOUND fallback only: an installed or builtin plugin has no project
      // of its own, so the app-global active worktree — first isCurrent snapshot,
      // the same rule host.getActiveWorktree uses — is the only thing its
      // "worktree" scope can mean. A bound host never reaches this; it resolves
      // its own project's current worktree in PluginHostFactory (#12229).
      // Returns undefined when none is active or the workspace client isn't
      // wired yet, which the storage API treats as "no target" (read →
      // undefined, write → throw).
      getActiveWorktreePath: async () => {
        const snapshots = await this.fetchAllWorktreeSnapshots();
        return snapshots.find((s) => s.isCurrent === true)?.path;
      },
    });

    this.channels = new PluginChannelRegistry({
      getManifest: (pluginId) => this.plugins.get(pluginId)?.manifest,
    });

    this.installer = new PluginInstaller({
      getPluginsRoot: () => this.pluginsRoot,
      records: this.records,
      getSettingsRoot: () => this.settings.settingsRoot(),
      loadPlugin: async (root, pluginId, opts) => {
        const before = this.projectInstancePackages.get(pluginId);
        const loaded = await this.loadPlugin(root, pluginId, opts);
        if (loaded) return loaded;
        // A catalog entry counts as this load's result only if this load wrote it:
        // a replacement that was refused must not be masked by the old entry.
        const after = this.projectInstancePackages.get(pluginId);
        return after !== before ? after : null;
      },
      unloadPlugin: (pluginId, options) => {
        this.unloadPackageInstances(pluginId, {
          uninstall: options?.reload !== true,
          purge: true,
        });
        this.unloadPlugin(pluginId, options);
      },
      settlePluginReload: (pluginId) => {
        this.settlePluginReload(pluginId);
        void this.reloadPackageInstances(pluginId);
      },
      activatePlugin: async (pluginId) => {
        // A catalog-only package has no singleton to activate.
        if (!this.plugins.has(pluginId) && this.projectInstancePackages.has(pluginId)) return;
        await this.activatePlugin(pluginId);
      },
      setPluginArchiveHash: (pluginId, hash) => this.setPluginArchiveHash(pluginId, hash),
      setEnabled: (pluginId, enabled) => this.setEnabled(pluginId, enabled),
      broadcastProvenanceChanged: () => this.broadcaster.broadcastProvenanceChanged(),
      purgeRecipeMetadata: (pluginId) => this.purgePluginRecipeMetadata(pluginId),
      wipeProjectInstanceData: (pluginId) => this.wipeInstalledInstanceData(pluginId),
      getPlugin: (pluginId) => this.plugins.get(pluginId) ?? this.disabledPlugins.get(pluginId),
      reservedNames: this.reservedNames,
      disabledPlugins: this.disabledPlugins,
      blockedPlugins: this.blockedPlugins,
      getInstalledVersion: (pluginId) => this.installedPluginVersion(pluginId),
      getInstalledInstanceMode: (pluginId) => {
        const installed = this.installedPluginRecord(pluginId);
        if (!installed) return null;
        return installed.manifest.instanceMode === "project" ? "project" : "singleton";
      },
    });

    const offRegister = onPanelKindRegistered(() => this.broadcaster.schedulePanelKindsBroadcast());
    const offUnregister = onPanelKindUnregistered(() =>
      this.broadcaster.schedulePanelKindsBroadcast()
    );
    this.disposeRegistrySubscriptions = () => {
      offRegister();
      offUnregister();
    };
  }

  /**
   * Resolves once startup load + activation has settled — every
   * `onStartupFinished` plugin has finished activating or failed to. Only for a
   * caller that genuinely needs that; one that reads manifest contributions or
   * the installed set wants {@link waitForCatalog}, and one that needs a single
   * plugin running awaits that plugin's own activation. Safe to await
   * repeatedly. {@link dispose} also resolves it to prevent test hangs when a
   * service is torn down without calling {@link activateStartupFinishedPlugins}.
   */
  waitForInit(): Promise<void> {
    return this.initPromise;
  }

  /**
   * Resolves once the startup scan ({@link initialize}) has settled, so the
   * loaded, disabled and blocked sets and every manifest contribution
   * registered at load time are populated (#14127). Independent of the remote
   * blocklist fetch and of any plugin's activation: one slow `activate()` must
   * not hold an unrelated catalog read. Also resolved by startup activation and
   * by {@link dispose}, never rejected.
   */
  waitForCatalog(): Promise<void> {
    return this.catalogPromise;
  }

  /**
   * {@link waitForCatalog}, giving up after `ms`, for a caller on a deadline (a
   * delete confirmation's notes, #13805); whatever has loaded by then is what
   * it gets.
   */
  async waitForCatalogWithin(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.catalogPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Whether the manifest scan phase ({@link initialize}) has settled. Forge
   * provider descriptors register at scan-time, so once this is true a
   * hostname-match miss in `resolveForgeProvider` is a definitive "no
   * provider matches" rather than a cold-start race (#9997). The boolean form
   * of {@link waitForCatalog}; {@link waitForInit} also waits for startup
   * activation.
   */
  get isPluginScanComplete(): boolean {
    return this.initialized;
  }

  /**
   * Accept a renderer's batch of plugin panel lifecycle transitions (#11301).
   * `sourceId` is the sender's `webContentsId`, taken from the IPC context
   * rather than the payload, so each project view's panels stay in their own
   * bucket and one view's teardown can't erase another's.
   */
  ingestPanelLifecycleEvents(
    sourceId: number,
    events: readonly unknown[],
    sender?: PanelLifecycleSourceHandle
  ): void {
    if (this.disposed) return;
    if (sender) this.watchPanelLifecycleSource(sourceId, sender);
    this.panelLifecycleBroker.ingest(sourceId, events);
  }

  /**
   * Accept a renderer's set of live non-plugin panel ids (#12610), keyed like
   * {@link ingestPanelLifecycleEvents} so it is forgotten with the renderer.
   * Used only to reject `host.reloadPanel()` on a non-plugin panel.
   */
  ingestPanelInventory(
    sourceId: number,
    nonPluginPanelIds: readonly unknown[],
    sender?: PanelLifecycleSourceHandle
  ): void {
    if (this.disposed) return;
    if (sender) this.watchPanelLifecycleSource(sourceId, sender);
    this.panelLifecycleBroker.setNonPluginPanels(sourceId, nonPluginPanelIds);
  }

  /**
   * Attach a one-shot `destroyed` listener the first time a renderer reports,
   * so its panels are forgotten when its `WebContentsView` goes away. Without
   * this the broker would keep a closed project view's panels forever and
   * replay them to the next subscriber as though they were live.
   *
   * The handle is structurally typed rather than `Electron.WebContents` so this
   * stays unit-testable without an Electron stub.
   */
  private watchPanelLifecycleSource(sourceId: number, sender: PanelLifecycleSourceHandle): void {
    if (this.panelLifecycleSourceCleanups.has(sourceId)) return;
    const onDestroyed = (): void => {
      this.panelLifecycleSourceCleanups.delete(sourceId);
      // Deliberately does NOT synthesize `removed`: a view being destroyed or
      // evicted says nothing about whether the user closed the panel, and a
      // false terminal event is the exact destructive misread this API exists
      // to prevent.
      this.panelLifecycleBroker.clearSource(sourceId);
    };
    let unwatch: () => void;
    try {
      unwatch = onWebContentsDestroyed(sender, onDestroyed);
    } catch {
      // An already-torn-down WebContents can throw; nothing to track then.
      return;
    }
    this.panelLifecycleSourceCleanups.set(sourceId, unwatch);
  }

  /**
   * Stop forwarding shared registry events to the renderer. Intended for
   * tests that need a clean teardown — production code holds a single
   * `pluginService` singleton for the app lifetime. Also drops any pending
   * batched broadcast so a microtask scheduled before disposal doesn't leak
   * an emit into the next test.
   */
  dispose(): void {
    this.disposed = true;
    void this.shutdownArtifacts();
    this.metrics.dispose();
    // Native watchers go first: a settled burst arriving mid-teardown would
    // otherwise queue a reload into a service that is going away.
    this.projectPluginWatcherRegistry?.dispose();
    this.projectPluginWatcherRegistry = null;
    this.devArtifactWatcherRegistry?.dispose();
    this.devArtifactWatcherRegistry = null;
    this.devSessions.clear();
    // Forget every project's plugin bookkeeping BEFORE the unload sweep below,
    // so the controller cannot re-load into a service that is going away.
    this.projectPluginController?.dispose();
    this.projectPluginController = null;
    // A reload can be parked on discovery with its instance absent from every
    // map the sweep below walks; its held credentials go now rather than
    // whenever that filesystem work settles.
    pluginMcpGrantRegistry.revokeHeld(() => true);
    forgetPluginLaunchesWhere(() => true);
    for (const waiters of this.projectOpenWaiters.values()) {
      for (const wake of waiters) wake();
    }
    this.projectOpenWaiters.clear();
    // Run each loaded plugin's full disposer cascade (cleanupMap, event-cleanups,
    // contribution unregisters, best-effort MCP shutdown) so service teardown
    // honors the Disposable contract. App-quit MCP teardown remains owned by
    // lifecycle/shutdown.ts; this covers service-scoped disposal and test reuse.
    for (const id of [...this.plugins.keys()]) {
      try {
        this.unloadPlugin(id);
      } catch (err) {
        console.error(`[PluginService] unloadPlugin("${id}") threw during dispose:`, err);
      }
    }
    this.workspaceClient?.off("worktree-activated", this.onWorktreeActivatedForCache);
    this.workspaceClient?.off("worktree-removed", this.onWorktreeRemovedForCardStatuses);
    this.disposeRegistrySubscriptions();
    // Settle both gates so unit tests that tear down the service without
    // running initialize() / activateStartupFinishedPlugins() don't hang IPC
    // callers awaiting them.
    this.resolveCatalog?.();
    this.resolveCatalog = null;
    this.resolveInit?.();
    this.resolveInit = null;
    this.dispatcher.dispose();
    this.panelReloadDispatcher.dispose();
    this.promptDispatcher.dispose();
    for (const detach of this.panelLifecycleSourceCleanups.values()) detach();
    this.panelLifecycleSourceCleanups.clear();
    this.panelLifecycleBroker.dispose();
    // Drops the PtyClient subscriptions and force-kills any plugin PTY the
    // unload cascade above left running.
    this.pluginPtyTransport?.dispose();
    this.pluginPtyTransport = null;
    this.pluginTasks.dispose();
  }

  /**
   * Inject the WorkspaceClient after it's been created. PluginService may be
   * initialized before WorkspaceClient in the startup sequence, so we can't
   * take it in the constructor. Safe to call multiple times; the latest
   * reference wins. When set for the first time, replays any pending event
   * subscriptions that were registered during early plugin activate().
   */
  setWorkspaceClient(client: WorkspaceClient | null): void {
    // Re-point the service-level worktree-scope cache eviction listener off the
    // previous client onto the new one (#10621). `off` before `on` keeps the
    // subscription single even when called repeatedly with the same client.
    if (this.workspaceClient && this.workspaceClient !== client) {
      this.workspaceClient.off("worktree-activated", this.onWorktreeActivatedForCache);
      this.workspaceClient.off("worktree-removed", this.onWorktreeRemovedForCardStatuses);
    }
    this.workspaceClient = client;
    if (client) {
      client.off("worktree-activated", this.onWorktreeActivatedForCache);
      client.on("worktree-activated", this.onWorktreeActivatedForCache);
      client.off("worktree-removed", this.onWorktreeRemovedForCardStatuses);
      client.on("worktree-removed", this.onWorktreeRemovedForCardStatuses);
    }
    if (client && this.pendingWorktreeSubs.length > 0) {
      const pending = this.pendingWorktreeSubs;
      this.pendingWorktreeSubs = [];
      for (const sub of pending) {
        sub.activate(client);
      }
    }
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.initializing ??= this.runInitialize().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async runInitialize(): Promise<void> {
    this.catalogScanInFlight = true;
    try {
      await this.scanStartupCatalog();
    } finally {
      // Released even when a prerequisite or the scan throws: a failed scan
      // must not strand every catalog reader.
      this.catalogScanInFlight = false;
      this.resolveCatalog?.();
      this.resolveCatalog = null;
      // Publish any authoritative snapshot an unload owed while the catalog
      // was still partial.
      this.broadcaster.flushDeferredCompleteSnapshots();
    }
  }

  private async scanStartupCatalog(): Promise<void> {
    // Reap crash-left staging/parked dirs from the user root BEFORE any
    // user-plugin scan. A parked `<pluginId>.old-<uuid>` dir (no leading dot)
    // can contain a plugin.json, so if it survived into the scan it could be
    // loaded as a real plugin and win the duplicate-name race against the live
    // install — after which this sweep would delete the now-loaded directory.
    // Sweeping first closes that window; loadFromDir also defensively skips
    // parked/temp names so a dir the sweep missed is still never loaded.
    // initialize() runs before any install/update-check/swap can start this
    // session, so this can't race a live temp dir; it only touches the user
    // root, never the built-in or sideload roots.
    this.startupInstalledPluginIds = new Set<string>();

    await this.installer.sweepStalePluginTempDirs();

    // Read the recipe sidecar BEFORE any plugin loads so the first registration
    // already overlays the user's frecency/pins — otherwise the initial
    // broadcast would carry manifest defaults and be corrected a tick later,
    // flashing "Never used" on every plugin recipe (#11860).
    try {
      await this.recipeMetadata.initialize();
      setPluginRecipeMetadataSnapshot(this.recipeMetadata.getAllSync());
    } catch (err) {
      // Degraded, not fatal: manifest defaults apply for the session. Plugin
      // loading must not fail because a frecency file was unreadable.
      console.error("[PluginService] Failed to read plugin recipe metadata:", err);
    }

    // Resolve the kill-switch blocklist before any scan, so the per-plugin load
    // gate reads one snapshot and the Promise.allSettled fan-out never awaits a
    // network call (#9428). A cached list — or, on a fresh profile, the
    // release-shipped seed (#14127) — is enforced as-is even when stale, so
    // startup never waits on the network while one exists; the revalidated list
    // is adopted the moment it arrives, unloading anything it newly blocks. Only
    // with neither does this wait for the fetch. Fails open: null on any
    // fetch/parse failure with no cached list.
    const { blocklist, refreshed } = await this.blocklistService.getStartupBlocklist();
    this.startupBlocklist = blocklist;
    if (refreshed) {
      void refreshed
        .then((fresh) => this.applyRefreshedBlocklist(fresh))
        .catch((err) =>
          console.error("[PluginService] Failed to apply the refreshed blocklist:", err)
        );
    }

    // Built-ins load first so user plugins with a colliding manifest.name are
    // rejected by the duplicate guard in loadPlugin() — built-in wins.
    const builtinDir = this.builtinPluginsRoot ?? this.getBuiltinDir();
    // One snapshot per contribution channel for the whole scan rather than one
    // per plugin: the parallel loads each settle on their own fs callback, so
    // per-tick coalescing alone could not merge them.
    const releaseBroadcasts = this.broadcaster.holdBroadcasts();
    try {
      const builtinLoaded = builtinDir
        ? await this.loadFromDir(builtinDir, { isBuiltin: true })
        : 0;
      const userLoaded = await this.loadFromDir(this.pluginsRoot, { isBuiltin: false });
      // E2E sideload — loaded with isBuiltin:true so manifest.name values in
      // the reserved `daintree.*` namespace pass the schema's namespace guard.
      // Runs after the regular scans so sideloaded plugins lose to a real
      // builtin with the same name (the duplicate guard in loadPlugin keeps
      // the already-registered builtin).
      const sideloadLoaded = this.sideloadPluginsRoot
        ? await this.loadFromDir(this.sideloadPluginsRoot, { isBuiltin: true })
        : 0;
      releaseBroadcasts();
      console.log(
        `[PluginService] Loaded ${builtinLoaded} built-in plugin(s) from ${builtinDir ?? "<unresolved>"}, ${userLoaded} user plugin(s) from ${this.pluginsRoot}, and ${sideloadLoaded} sideloaded plugin(s) from ${this.sideloadPluginsRoot ?? "<none>"}`
      );
      // Only reachable when every configured root was enumerated, so the
      // installed-id set is authoritative. A partial inventory would read as
      // "uninstalled" and delete live metadata (#6110).
      await this.reconcilePluginRecipeMetadata();
      // The same holds for the theme catalog: a selected plugin theme it lacks
      // now is genuinely gone.
      this.pluginThemeCatalogReady = true;
      this.schedulePluginThemeSync();
      // A background-restored project opens without waiting for this scan, so
      // its instances had no catalog to load from when it did.
      await this.reconcileInstalledInstancesForOpenProjects();
    } finally {
      // Idempotency must hold even when a scan throws (e.g. EACCES on the
      // user dir): a retry would re-run the built-in scan and trigger
      // "already registered, overwriting" warnings from the contribution
      // registries.
      releaseBroadcasts();
      this.initialized = true;
      // A refresh that landed mid-scan swept only what had committed by then;
      // sweep again for loads that were in flight across it.
      if (this.startupBlocklist !== blocklist) {
        this.applyRefreshedBlocklist(this.startupBlocklist);
      }
    }
  }

  /**
   * Adopt a revalidated blocklist mid-session. Plugins that loaded against the
   * stale cached list and are now blocked get the full `unloadPlugin()`
   * teardown and move into `blockedPlugins`, exactly as if the load gate had
   * refused them. A null result is the fail-open signal and never drops the
   * list already enforced.
   */
  private applyRefreshedBlocklist(fresh: ParsedPluginBlocklist | null): void {
    if (!fresh || this.disposed) return;
    this.startupBlocklist = fresh;
    let changed = false;
    for (const [pluginId, plugin] of [...this.plugins]) {
      if (this.blockLoadedPluginIfListed(pluginId, plugin)) changed = true;
    }
    for (const [pluginId, entry] of [...this.disabledPlugins]) {
      const match = findPluginBlocklistMatch(fresh, {
        name: entry.manifest.name,
        version: entry.manifest.version,
      });
      if (!match) continue;
      this.disabledPlugins.delete(pluginId);
      this.recordBlockedPlugin(entry, match.message);
      changed = true;
    }
    if (changed) this.broadcaster.broadcastProvenanceChanged();
  }

  /**
   * Unload a registered plugin the current blocklist covers. Returns whether it
   * did. Also the activation gate: a load that passed the check against an
   * older list can commit after {@link applyRefreshedBlocklist} swept, and must
   * still never run code.
   */
  private blockLoadedPluginIfListed(pluginId: string, plugin: LoadedPlugin): boolean {
    const match = this.blocklistMatchFor(plugin);
    if (!match) return false;
    console.warn(
      `[PluginService] Plugin "${plugin.manifest.name}" v${plugin.manifest.version} is blocklisted (${match.reason}) — unloading`
    );
    this.unloadPlugin(pluginId);
    // Project instances never claim the global namespace; see loadPlugin().
    if (plugin.origin !== "project") this.recordBlockedPlugin(plugin, match.message);
    return true;
  }

  private blocklistMatchFor(plugin: LoadedPlugin): PluginBlocklistMatch | null {
    return findPluginBlocklistMatch(this.startupBlocklist, {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
    });
  }

  private recordBlockedPlugin(
    entry: { manifest: Readonly<PluginManifest>; dir: string; isBuiltin: boolean },
    reason: string
  ): void {
    const { manifest } = entry;
    this.reservedNames.add(manifest.name);
    if (this.blockedPlugins.has(manifest.name)) return;
    this.blockedPlugins.set(manifest.name, {
      manifest: manifest as PluginManifest,
      dir: entry.dir,
      isBuiltin: entry.isBuiltin,
      reason,
    });
    broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "warning",
      priority: "low",
      title: "Plugin blocked",
      message: `"${manifest.displayName ?? manifest.name}" was blocked: ${reason}`,
      rateLimitKey: `plugin-blocklist:${manifest.name}`,
    });
  }

  /**
   * Startup sweep of the recipe sidecar against what is installed on disk.
   * Catches a contribution id dropped by a plugin update and an orphan left by
   * a crash between deleting a plugin's files and purging its metadata.
   * Best-effort: a failure leaves stale rows that the next startup retries.
   */
  private async reconcilePluginRecipeMetadata(): Promise<void> {
    try {
      // Directory name is USUALLY the plugin id, but not always — the built-in
      // `github` directory declares `daintree.github`, and a sideloaded folder
      // can be named anything. Union the scanned directory names with every id
      // the service actually knows about (running, disabled, blocked, or
      // name-reserved) so a mismatch can never read as "uninstalled" and purge
      // live metadata. Union is the fail-safe direction: an extra id only means
      // one fewer row is swept.
      const installedPluginIds = new Set(this.startupInstalledPluginIds);
      for (const id of this.plugins.keys()) installedPluginIds.add(id);
      for (const id of this.disabledPlugins.keys()) installedPluginIds.add(id);
      for (const id of this.blockedPlugins.keys()) installedPluginIds.add(id);
      for (const id of this.reservedNames) installedPluginIds.add(id);

      const dropped = await this.recipeMetadata.reconcile({
        installedPluginIds,
        knownQualifiedIdsByPlugin: getPluginRecipeQualifiedIdsByPlugin(),
      });
      setPluginRecipeMetadataSnapshot(this.recipeMetadata.getAllSync());
      // Only when the sweep actually removed something. This runs on every
      // startup and almost always finds nothing, so announcing unconditionally
      // meant every boot emitted an authoritative empty-snapshot broadcast that
      // told the renderer nothing it didn't already know.
      if (dropped) this.broadcaster.scheduleRecipesBroadcast(true);
    } catch (err) {
      console.error("[PluginService] Failed to reconcile plugin recipe metadata:", err);
    }
  }

  /** Effective plugin recipe list — manifest content with user metadata overlaid. */
  getPluginRecipes(): TerminalRecipe[] {
    return getPluginRecipes();
  }

  /** Every loaded plugin's tours, before per-project visibility is applied. */
  getPluginTours(): PluginTourDescriptor[] {
    return getPluginTours();
  }

  /**
   * The remote narration a tour audio route on `authority` stands for. Resolved
   * through the live authority map, so an unloaded plugin's routes die with it.
   */
  getPluginTourRemoteAudio(
    authority: string,
    tourId: string,
    chapterId: string
  ): PluginTourRemoteAudio | undefined {
    for (const [pluginId, current] of this.pluginAuthorities) {
      if (current === authority) return getPluginTourRemoteAudio(pluginId, tourId, chapterId);
    }
    return undefined;
  }

  /**
   * Append one run timestamp for a plugin recipe. Provenance is resolved from
   * the registry, never from the caller — a renderer supplies only the
   * qualified id, and an id no loaded plugin declares is rejected rather than
   * creating a record for a plugin that may not exist.
   */
  async recordPluginRecipeUse(qualifiedId: string, timestamp: number): Promise<TerminalRecipe> {
    const owner = getPluginRecipeOwner(qualifiedId);
    if (!owner) throw new Error(`Plugin recipe ${qualifiedId} not found`);
    await this.recipeMetadata.recordUse(
      qualifiedId,
      owner.pluginId,
      owner.contributionId,
      timestamp
    );
    setPluginRecipeMetadataSnapshot(this.recipeMetadata.getAllSync());
    // The calling window already applied this optimistically, but a second
    // project window would otherwise keep stale frecency ordering until an
    // unrelated push. The payload carries the persisted value, so replaying it
    // over the optimistic one converges rather than conflicts.
    this.broadcaster.scheduleRecipesBroadcast(false);
    const updated = getPluginRecipe(qualifiedId);
    if (!updated) throw new Error(`Plugin recipe ${qualifiedId} not found`);
    return updated;
  }

  /** Apply a user preference patch to a plugin recipe's sidecar record. */
  async updatePluginRecipeMetadata(
    qualifiedId: string,
    patch: PluginRecipeMetadataPatch
  ): Promise<TerminalRecipe> {
    const owner = getPluginRecipeOwner(qualifiedId);
    if (!owner) throw new Error(`Plugin recipe ${qualifiedId} not found`);
    await this.recipeMetadata.setUserOverrides(
      qualifiedId,
      owner.pluginId,
      owner.contributionId,
      patch
    );
    setPluginRecipeMetadataSnapshot(this.recipeMetadata.getAllSync());
    this.broadcaster.scheduleRecipesBroadcast(false);
    const updated = getPluginRecipe(qualifiedId);
    if (!updated) throw new Error(`Plugin recipe ${qualifiedId} not found`);
    return updated;
  }

  /**
   * Drop a plugin's recipe metadata. Wired ONLY to the successful branch of an
   * explicit uninstall — disable, reload, and update all expect the recipes
   * back and their frecency intact.
   */
  async purgePluginRecipeMetadata(pluginId: string): Promise<void> {
    await this.recipeMetadata.purgePlugin(pluginId);
    setPluginRecipeMetadataSnapshot(this.recipeMetadata.getAllSync());
  }

  /**
   * Canonical app-bundled built-in plugins directory. Resolved at call time
   * because `app.isPackaged` / `process.resourcesPath` are not valid at module
   * evaluation. Mirrors the pattern in HelpService / SoundService — built-ins
   * ship via electron-builder's `extraResources`, so the source directory at
   * the repo root maps 1:1 to `<Resources>/plugins/builtin/` in packaged
   * builds. Returns `null` when the Electron app API is unavailable (tests
   * that mock `electron` with a minimal stub) — the built-in scan is then
   * skipped without aborting user-plugin loading.
   */
  private getBuiltinDir(): string | null {
    try {
      if (typeof app.getAppPath !== "function") return null;
      // Plugins must live alongside the shared esbuild chunks at
      // `dist-electron/electron/chunks/` so the relative `import` paths in
      // their bundled output resolve. In dev this resolves to the repo's
      // `dist-electron/` directory; in packaged builds it resolves inside
      // `app.asar/dist-electron/`, which is on disk via Electron's fs patch.
      // Using a single path for both modes keeps the chunk-relative imports
      // honest — copying the plugins into `Resources/plugins/builtin/` would
      // strand the relative chunk references and produce a silent registration
      // gap (descriptor present, impl never bound).
      return path.join(app.getAppPath(), "dist-electron", "plugins", "builtin");
    } catch (err) {
      console.warn("[PluginService] Failed to resolve built-in plugins directory:", err);
      return null;
    }
  }

  private async loadFromDir(root: string, opts: { isBuiltin: boolean }): Promise<number> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log(
          `[PluginService] No ${opts.isBuiltin ? "built-in" : "user"} plugins directory at ${root}, skipping`
        );
        return 0;
      }
      throw err;
    }

    // Skip dot-prefixed dirs: plugin ids are `publisher.name` and a publisher
    // segment can never start with a dot, so `.install-tmp-*` staging dirs and
    // leading-dot `.old-*` leftovers are never mistaken for installable plugins.
    // The installer's parked-old copies are named `<pluginId>.old-<uuid>` (no
    // leading dot); `sweepStalePluginTempDirs` (run before this scan) reaps
    // them first, but `isParkedOrTempDirName` defensively excludes them here
    // too so a leaked parked dir is never loaded even if the sweep missed it.
    const pluginDirs = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && !isParkedOrTempDirName(e.name)
    );
    // Directory name IS the plugin id (uninstall joins it onto the root), so
    // this records "installed" without depending on the manifest parsing or the
    // plugin being allowed to load — which is what keeps recipe metadata alive
    // across disable, blocklist, and engine-incompatibility (#11860).
    for (const dir of pluginDirs) {
      this.startupInstalledPluginIds.add(dir.name);
    }
    // Disabled state applies to built-in and user plugins alike (#9284).
    const disabled = this.records.getDisabledIds();
    const results = await Promise.allSettled(
      pluginDirs.map((d) => this.loadPlugin(root, d.name, { isBuiltin: opts.isBuiltin, disabled }))
    );

    let loaded = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        loaded++;
      }
    }
    return loaded;
  }

  /**
   * An unmet `engines.daintree` range is advisory (#12589). The plugin may well
   * work, and the failure mode of trying is a broken plugin rather than a broken
   * app, so it loads and the user is told once why it might misbehave.
   */
  private warnEngineMismatch(
    pluginId: string,
    binding: PluginHostBinding,
    manifest: PluginManifest,
    requiredRange: string,
    mismatch: PluginEngineMismatch
  ): void {
    console.warn(
      `[PluginService] Plugin "${pluginId}" targets Daintree ${requiredRange} but current version is ${this.appVersion} — loading anyway`
    );
    const warnedKey = `${pluginId}@${manifest.version} ${requiredRange}`;
    if (this.engineMismatchWarned.has(warnedKey)) return;
    this.engineMismatchWarned.add(warnedKey);

    const remedy =
      mismatch === "app-too-old"
        ? " Update Daintree if you run into problems."
        : mismatch === "app-too-new"
          ? " Check for a newer version of the plugin if you run into problems."
          : "";
    // The updater can't be asked whether it's live this early in boot, and some
    // distributions never register it, so point at the download page instead.
    // The Store owns installs there, so a daintree.org download is wrong.
    const offerDownload = mismatch === "app-too-old" && !isWindowsStoreBuild();
    const name = manifest.displayName || manifest.name;
    const payload = {
      type: "warning" as const,
      title: "Plugin version mismatch",
      message: `"${name}" targets Daintree ${requiredRange} and may not work on ${this.appVersion}.${remedy}`,
      rateLimitKey: `plugin-engine:${pluginId}`,
      rateLimitLabel: name,
      // An action would otherwise make the toast sticky, and several mismatched
      // plugins at launch would stack up.
      duration: 8000,
      ...(offerDownload && {
        action: {
          label: "Download latest",
          ipcChannel: CHANNELS.SYSTEM_OPEN_EXTERNAL,
          data: `${PRODUCT_WEBSITE}/download`,
        },
      }),
    };
    if (binding.projectId) {
      broadcastToProjectRenderers(binding.projectId, CHANNELS.NOTIFICATION_SHOW_TOAST, payload);
    } else {
      broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, payload);
    }
  }

  private async loadPlugin(
    root: string,
    dirName: string,
    opts: {
      isBuiltin: boolean;
      disabled: Set<string>;
      /**
       * Which root this directory came from. Defaults to the boolean's meaning
       * so the three startup scans keep their existing behaviour verbatim.
       */
      origin?: PluginOrigin;
      /**
       * Registry key for this instance. A project plugin loads under
       * `project__{projectId}__{manifestId}` so two projects shipping the same
       * manifest id get separate contributions, authority, grants and teardown.
       * Absent for installed and builtin plugins, whose key IS their manifest id.
       */
      instanceKey?: string;
      /** The project this instance is bound to. Absent means app-global. */
      binding?: PluginHostBinding;
      /**
       * The manifest discovery read, which an application's preflight checked
       * (#14113). This load reads `plugin.json` again, and refuses before it
       * registers anything when what it reads is not what was checked.
       */
      checkedManifest?: Readonly<PluginManifest>;
      /**
       * This directory is an installed `instanceMode: "project"` package being
       * loaded as one project's instance. It runs as `origin: "project"` but its
       * manifest is validated as an installed one.
       */
      installedInstance?: boolean;
    }
  ): Promise<LoadedPlugin | null> {
    // Every load path funnels through here — startup scans, a background-
    // restored project's `onProjectOpened` (which never waits on the deferred
    // `plugin-service` task), reloads, installs — and each one ends by
    // publishing `plugin://` URLs. Served by the placeholder resolver, those
    // 404, and a failed import is permanent for its specifier (#12996). Waiting
    // here, before a view generation or authority is minted, means no URL
    // exists until the handler can serve it.
    if (this.whenProtocolReady) {
      await this.whenProtocolReady();
      if (this.disposed) return null;
    }
    const origin: PluginOrigin = opts.origin ?? (opts.isBuiltin ? "builtin" : "user");
    const isProject = origin === "project";
    const isUserInstalled = origin === "user";
    const pluginDir = path.join(root, dirName);
    const prepared = await readPluginManifestForLoad(pluginDir, dirName, {
      isBuiltin: opts.isBuiltin,
      origin,
      instanceKey: opts.instanceKey,
      checkedManifest: opts.checkedManifest,
      installedInstance: opts.installedInstance,
    });
    if (!prepared.ok) {
      const { refusal } = prepared;
      if (refusal?.reason === "reserved-namespace") {
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "error",
          title: "Plugin uses a reserved namespace",
          message: `Plugin "${refusal.pluginName}" uses the reserved "daintree.*" namespace, which is restricted to first-party plugins.`,
        });
      }
      if (refusal && isUserInstalled) {
        this.records.upsertInstalledRecord(refusal.pluginName, {
          loadError: { message: refusal.message, at: Date.now() },
        });
      }
      return null;
    }
    const manifest = prepared.manifest;
    // The registry key for this instance. Identical to the manifest id for
    // installed and builtin plugins, so every existing key, path and id is
    // byte-for-byte what it was; distinct for a project plugin, which is what
    // keeps two projects' copies of the same id from sharing anything.
    const pluginId = opts.instanceKey ?? manifest.name;
    const binding = opts.binding ?? UNBOUND_PLUGIN_HOST_BINDING;

    // Kill-switch: refuse to load any plugin whose name + version matches the
    // remote blocklist (#10891). Checked before the disabled gate so a plugin
    // that is both disabled and blocklisted still surfaces as blocked (the
    // security signal wins). The name is reserved so a later dir scan can't
    // hijack the namespace, and the manifest is tracked so listPlugins() can
    // surface the block. No `activate` runs — it never enters `this.plugins`.
    const blockMatch = findPluginBlocklistMatch(this.startupBlocklist, {
      name: manifest.name,
      version: manifest.version,
    });
    if (blockMatch) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}" v${manifest.version} is blocklisted (${blockMatch.reason}) — refusing to load`
      );
      // A project plugin never claims the global namespace: reserving its id
      // would let one repository's blocklisted manifest deny that id to every
      // other project and to the user's own installed plugins.
      if (!isProject) this.reservedNames.add(manifest.name);
      if (!isProject && !this.blockedPlugins.has(manifest.name)) {
        this.blockedPlugins.set(manifest.name, {
          manifest,
          dir: pluginDir,
          isBuiltin: opts.isBuiltin,
          reason: blockMatch.message,
        });
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "warning",
          priority: "low",
          title: "Plugin blocked",
          message: `"${manifest.displayName ?? manifest.name}" was blocked from loading: ${blockMatch.message}`,
          rateLimitKey: `plugin-blocklist:${manifest.name}`,
        });
      }
      return null;
    }

    // Plugins disabled in Preferences are skipped entirely — neither
    // registered in the plugins map nor activated — for both built-in and
    // user plugins (#9284). The disable persists in electron-store and takes
    // effect on next launch. The name is reserved so a later dir scan cannot
    // hijack a claimed namespace just because the matching plugin is off; the
    // manifest is tracked so listPlugins() can still surface it for the toggle.
    // The Preferences disable list is about installed and builtin plugins. A
    // project plugin's gate is its project's trust decision, and staging is how
    // an individual one stays off — routing it through the global list would let
    // one project's plugin id disable another's.
    if (!isProject && opts.disabled.has(manifest.name)) {
      console.log(
        `[PluginService] ${opts.isBuiltin ? "Built-in" : "User"} plugin "${manifest.name}" is disabled, skipping`
      );
      this.reservedNames.add(manifest.name);
      if (!this.disabledPlugins.has(manifest.name)) {
        this.disabledPlugins.set(manifest.name, {
          manifest,
          dir: pluginDir,
          isBuiltin: opts.isBuiltin,
        });
      }
      return null;
    }

    // An installed package that opted into per-project instances is admitted to
    // the catalog and stops here: nothing registers, activates or reserves the
    // global name until a project enables it, and each enablement loads under
    // its own instance key.
    if (manifest.instanceMode === "project" && !opts.installedInstance && isUserInstalled) {
      if (!this.records.getInstalledRecord(manifest.name)) {
        this.records.upsertInstalledRecord(manifest.name, {});
      }
      this.projectInstancePackages.set(manifest.name, { dir: pluginDir, manifest });
      return null;
    }

    // Collision is checked against the INSTANCE key, not the manifest id. A
    // project plugin is explicitly allowed to share an id with an installed one
    // (§7.1) — both load, identity keeps them apart, and the plugin manager
    // surfaces the overlap rather than hiding it. The reserved-name check still
    // applies to the global roots, where one id really can only have one owner.
    if (this.plugins.has(pluginId) || (!isProject && this.reservedNames.has(manifest.name))) {
      console.error(
        `[PluginService] Duplicate plugin name "${manifest.name}" in ${dirName} — rejecting`
      );
      return null;
    }

    const requiredRange = manifest.engines?.daintree;
    if (requiredRange) {
      const mismatch = checkPluginEngineRange(this.appVersion, requiredRange);
      if (mismatch) this.warnEngineMismatch(pluginId, binding, manifest, requiredRange, mismatch);
    } else {
      console.warn(
        `[PluginService] Plugin "${manifest.name}" does not declare engines.daintree — consider adding it to ensure compatibility`
      );
    }

    // Per-plugin provenance record. Built-ins don't get records — they're
    // identified by load path. Non-builtins get one created on first encounter.
    // Disabled-state filtering already happened upstream via `opts.disabled`
    // (the unified `plugins.disabled` list, #9284), so we only run here when
    // the plugin is going to load. Must run after the rejecting gates above so
    // refused plugins don't leave zombie records in the store.
    if (isUserInstalled) {
      const existing = this.records.getInstalledRecord(manifest.name);
      if (!existing) {
        this.records.upsertInstalledRecord(manifest.name, {});
      }
    }

    if (manifest.capabilities.length > 0) {
      console.log(
        `[PluginService] Plugin "${manifest.name}" declares capabilities: ${manifest.capabilities.join(", ")}`
      );
    }

    const plugin: LoadedPlugin = {
      manifest,
      dir: pluginDir,
      loadedAt: Date.now(),
      isBuiltin: opts.isBuiltin,
      origin,
      binding,
      // One generation per load, shared by every view this plugin contributes,
      // so a reload swaps the whole plugin's view modules together (#11301).
      // Held on the plugin rather than a local so `activatePluginForView` can
      // mint a sibling recovery generation later (#11728).
      viewGeneration: allocatePluginViewGeneration(),
    };

    if (manifest.main) {
      const resolved = this.resolveEntryPath(pluginDir, manifest.main);
      if (resolved && isProject && !(await this.isRealpathContained(pluginDir, resolved))) {
        // Lexical containment is not enough for the one root a repository can
        // write: `dist/main.js` can be a symlink that points anywhere. Match the
        // `plugin://` handler and resolve symlinks before deciding, so an
        // in-directory link out of the plugin is refused rather than executed.
        console.warn(
          `[PluginService] Plugin ${manifest.name}: main entry resolves outside the plugin directory through a symlink, ignoring`
        );
      } else if (resolved) {
        plugin.resolvedMain = resolved;
      } else {
        console.warn(
          `[PluginService] Plugin ${manifest.name}: main entry path escapes plugin directory, ignoring`
        );
      }
    }

    // Dev-mode detection (#9304): a `.dev-marker` at the plugin dir root (written
    // by `daintree-plugin dev`) routes this plugin through the hot-reload worker
    // instead of the in-process loader. Built-ins are never dev plugins. Persist
    // `devMode` to the provenance record so `listPlugins()` surfaces the "DEV"
    // badge (#9290). A dev plugin needs a `main` entry to run in the worker.
    //
    // Synchronous `existsSync` on purpose: it keeps this step from adding
    // another suspension point between the duplicate-name check above and the
    // `this.plugins.set` below. That stretch is NOT a critical section though —
    // `await registerPluginSkills(...)` further down already splits it, so two
    // concurrent loads of the same name can still both pass dedup. Tracked
    // separately; closing it needs an explicit name reservation at the check.
    if (isUserInstalled) {
      const isDev = existsSync(path.join(pluginDir, DEV_MARKER_FILENAME));
      // Armed off the marker, not off `devMode` below: a session whose first
      // build has not landed has no resolvable `main` and so is not a dev
      // plugin yet — but it is exactly the case that needs watching, because
      // the build that makes it one is the next thing to happen (#12277).
      if (isDev) this.ensureDevSession(manifest.name, pluginDir);
      if (isDev && plugin.resolvedMain) {
        plugin.devMode = true;
        this.records.upsertInstalledRecord(manifest.name, { devMode: true });
      } else {
        // Clear a stale dev flag if the marker was removed since last launch.
        const record = this.records.getInstalledRecord(manifest.name);
        if (record?.devMode) {
          this.records.upsertInstalledRecord(manifest.name, { devMode: false });
        }
        if (isDev && !plugin.resolvedMain) {
          console.warn(
            `[PluginService] Plugin "${manifest.name}" has a ${DEV_MARKER_FILENAME} but no resolvable main entry — loading without hot-reload`
          );
        }
      }
    }

    const contributionTarget = { pluginId, plugin, manifest, binding };
    const pending = await this.contributions.prepare(contributionTarget);
    // Insert the plugin into the registry BEFORE importing its main module so
    // synchronous host-API calls made during module evaluation (e.g., a plugin
    // that calls host.registerAction/registerHandler at import time) see the
    // plugin as loaded. Without this, `hasPlugin(pluginId)` returns false
    // inside the plugin's own init, and registerHandler/registerPluginAction
    // throw "Unknown plugin" even for a correctly loaded plugin.
    // Minted and committed synchronously with the registry insert below, so the
    // authority is resolvable the instant the plugin is addressable.
    this.contributions.registerCommitted(contributionTarget, pending, () => {
      const authority = this.mintPluginAuthority(pluginId, plugin.dir);
      this.plugins.set(pluginId, plugin);
      noteNewestPluginInstance(this.plugins, pluginId, plugin);
      this.claimProjectContextNamespace(pluginId);
      return authority;
    });

    // Plugins without a `main` entry contribute no executable code — the
    // provenance record reflects a clean load immediately. Plugins with a
    // `main` entry defer the `loadError: null` write to `_doActivate()` so
    // the record only clears once activation actually succeeds. This must
    // happen BEFORE manifest command registration: a colliding command
    // writes its own `loadError` via `registerManifestCommands` (#9281), and
    // clearing it back to `null` here would silently lose the diagnostic.
    if (!plugin.resolvedMain && isUserInstalled) {
      this.records.upsertInstalledRecord(manifest.name, { loadError: null });
    }

    // Manifest-declared commands (#9281): register descriptors at load time so
    // the command appears in the action palette before activation; probe the
    // filesystem-convention handler path but defer the actual `import()` to
    // first dispatch (the 5s activation budget can't pay N import costs up
    // front). Probes happen after `plugins.set()` so
    // `validateAndBuildActionDescriptor` sees the plugin as loaded.
    if (manifest.contributes.commands.length > 0) {
      // Published before this stack yields, so an activation trigger racing
      // discovery waits for the answer instead of reading a half-filled map
      // (#12274). Calling `registerManifestCommands` runs its body up to the
      // first probe, but nothing else can interleave until this stack suspends —
      // and nothing runs between `plugins.set()` above and here either, so
      // there is no gap on either side to cover.
      const discovery = this.registerManifestCommands(pluginId, plugin);
      this.commandDiscovery.set(pluginId, discovery);
      try {
        await discovery;
      } finally {
        if (this.commandDiscovery.get(pluginId) === discovery) {
          this.commandDiscovery.delete(pluginId);
        }
      }
    }

    // After command discovery, so a route's command is registered before any
    // event can wake it — and only if no unload or reload ran meanwhile.
    if (this.plugins.get(pluginId) === plugin) this.startEventRoutes(pluginId, plugin);

    return plugin;
  }

  /**
   * Hold a loaded instance's manifest event routes (#13816): host-side
   * listeners that activate the plugin and run the routed command when an
   * event happens, without keeping its worker alive in between.
   */
  private startEventRoutes(pluginId: string, plugin: LoadedPlugin): void {
    const routes = plugin.manifest.eventRoutes ?? [];
    if (routes.length === 0) return;
    this.stopEventRoutes(pluginId);
    try {
      this.pluginEventRoutes.set(
        pluginId,
        createPluginEventRoutes(
          {
            plugins: this.plugins,
            declaredCapabilities: (id) => this.declaredCapabilities(id),
            fetchWorktreeSnapshotsResult: () => this.fetchAllWorktreeSnapshotsResult(),
            fetchWorktreeSnapshotsForProjectResult: (projectId, projectRoot) =>
              this.fetchWorktreeSnapshotsForProjectResult(projectId, projectRoot),
            getWorktreeCustomTitles: (projectId) => this.readWorktreeCustomTitles(projectId),
            attachWorktreeEvent: (event, handler) =>
              this.attachWorktreeEvent(pluginId, event, handler),
            isWorkerFailed: (id) => this.workerStatuses.get(id)?.state === "failed",
            dispatch: (actionId, wake) =>
              this.dispatchEventRouteWake(pluginId, plugin, actionId, wake),
          },
          pluginId,
          plugin.binding ?? UNBOUND_PLUGIN_HOST_BINDING,
          routes
        )
      );
    } catch (err) {
      console.error(`[PluginService] Starting event routes for "${pluginId}" failed:`, err);
    }
  }

  private stopEventRoutes(pluginId: string): void {
    const routes = this.pluginEventRoutes.get(pluginId);
    if (!routes) return;
    this.pluginEventRoutes.delete(pluginId);
    routes.dispose();
  }

  /**
   * Run one routed command for an event wake. Goes through
   * {@link dispatchHandler} like a renderer's `plugin:invoke`, so activation,
   * input validation, run tracking, metrics, result checks and the handler
   * audit all apply; what that IPC handler adds itself — the argument cap and
   * the audit of a failure that never reached a handler — is added here.
   *
   * Never rejects: a wake has no caller to report to, so a failure is audited
   * and logged and the next event wakes the plugin again.
   */
  private async dispatchEventRouteWake(
    pluginId: string,
    generation: LoadedPlugin,
    actionId: string,
    wake: PluginEventRouteWake
  ): Promise<void> {
    if (this.plugins.get(pluginId) !== generation) return;
    const descriptor = this.pluginActions.get(actionId);
    if (descriptor?.pluginId !== pluginId || !this.manifestCommandIds.has(actionId)) {
      // The command failed to register (a collision, an invalid descriptor),
      // which load already reported.
      return;
    }
    const args: unknown[] = [wake];
    const start = Date.now();
    let argsWithinLimit = false;
    try {
      assertPayloadWithinLimit(
        pluginId,
        `"${wake.event}" event route arguments to "${actionId}"`,
        args,
        PLUGIN_INVOKE_MAX_ARGS_BYTES
      );
      argsWithinLimit = true;
      // No renderer made this call: `webContentsId` 0 names none, and the
      // project is the one the instance is bound to.
      const ctx: PluginIpcContext = {
        projectId: generation.binding?.projectId ?? null,
        worktreeId: null,
        webContentsId: 0,
        pluginId,
      };
      await this.dispatchHandler(pluginId, actionId, ctx, args);
    } catch (err) {
      if (!isAuditedHandlerFailure(err) && this.plugins.get(pluginId) === generation) {
        safeAppendAudit({
          pluginId,
          actionId,
          recordType: "action-dispatch",
          result: "error",
          errorMessage: formatErrorMessage(err, "event route dispatch failed"),
          argsHash: argsWithinLimit ? safeArgsHash(args) : "",
          durationMs: Date.now() - start,
        });
      }
      console.warn(
        `[PluginService] "${wake.event}" event route to "${actionId}" for "${pluginId}" failed:`,
        err
      );
    }
  }

  /**
   * Register each manifest-declared command's descriptor and probe its
   * filesystem-convention handler path. Handler modules are NOT imported here —
   * the dynamic `import()` is deferred to {@link dispatchHandler} so plugins
   * with many commands don't pay the eval cost during the 5s activation
   * budget. Collisions with built-in action ids surface through
   * {@link recordPluginLoadError} — the provenance record for an installed
   * plugin, the in-memory map for a project one — or as a console warning for
   * builtins, which have neither.
   */
  private async registerManifestCommands(pluginId: string, plugin: LoadedPlugin): Promise<void> {
    let owners = this.pluginActionOwners.get(pluginId);
    let registered = false;
    for (const cmd of plugin.manifest.contributes.commands) {
      const namespacedId = `${pluginId}.${cmd.id}`;
      if (BUILT_IN_ACTION_ID_SET.has(namespacedId)) {
        const message = `Plugin "${pluginId}" command id "${namespacedId}" collides with a built-in action id`;
        console.error(`[PluginService] ${message}`);
        if (this.recordPluginLoadError(pluginId, plugin, { message, at: Date.now() })) {
          // Mark so a later `_doActivate()` success doesn't clear this
          // load-time diagnostic. Collisions are manifest-level facts that
          // don't go away when `main` activates cleanly.
          this.pluginsWithLoadTimeErrors.add(pluginId);
        }
        continue;
      }
      let descriptor: PluginActionDescriptor;
      try {
        descriptor = this.validateAndBuildActionDescriptor(pluginId, {
          ...cmd,
          id: namespacedId,
        });
      } catch (err) {
        const loadError = toPluginLoadError(err);
        console.error(
          `[PluginService] Failed to validate manifest command "${namespacedId}":`,
          err
        );
        if (this.recordPluginLoadError(pluginId, plugin, loadError)) {
          this.pluginsWithLoadTimeErrors.add(pluginId);
        }
        continue;
      }
      // Replace semantics mirror `host.registerAction` — a manifest-declared
      // command silently overrides an earlier registration of the same id
      // from a prior session's host.registerAction call (the handler map gets
      // cleared on reload anyway).
      this.pluginActions.set(descriptor.id, descriptor);
      this.manifestCommandIds.add(descriptor.id);
      if (!owners) {
        owners = new Set();
        this.pluginActionOwners.set(pluginId, owners);
      }
      owners.add(descriptor.id);
      registered = true;

      // A project plugin's `src/` is authoring source the host never reads —
      // its load contract is the committed `dist/`, so there is nothing to
      // probe for. That is a distribution rule, not a trust one: an installed
      // or dev-linked plugin's handler module is imported and run inside that
      // plugin's own worker like every other surface it contributes (#12274),
      // so what this gate selects is which plugins use the filesystem
      // convention at all, never which ones get to run code in Electron main.
      // Project plugins register command handlers from their entry point with
      // `host.registerAction` instead.
      const resolvedPath =
        plugin.origin === "project"
          ? null
          : await this.resolveCommandHandlerPath(plugin.dir, cmd.id);
      if (resolvedPath) {
        this.commandModulePaths.set(descriptor.id, resolvedPath);
      }
      // Missing handler file: descriptor is still registered so the command
      // appears in the palette; dispatch surfaces the documented
      // `Command "{id}" has no handler` toast.
    }
    if (registered) {
      this.broadcaster.schedulePluginActionsBroadcast();
    }
  }

  /**
   * Probe `{pluginDir}/src/{cmdId}.{js,mjs}` in precedence order,
   * returning the first existing path or `null` when none match. The result
   * is cached in {@link commandModulePaths} so the probe runs once per
   * command per load — dispatch reads the cached path directly. Path
   * traversal is guarded by {@link resolveEntryPath}: a `cmd.id` that
   * escapes the plugin dir (e.g. `../../etc/passwd`) is rejected even if it
   * somehow passed the manifest `SAFE_ID_PATTERN` (`.` is allowed in the
   * pattern, so a defence-in-depth check is warranted).
   */
  private async resolveCommandHandlerPath(
    pluginDir: string,
    cmdId: string
  ): Promise<string | null> {
    for (const ext of COMMAND_HANDLER_EXTENSIONS) {
      const candidate = this.resolveEntryPath(pluginDir, path.join("src", `${cmdId}${ext}`));
      if (!candidate) continue;
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // File doesn't exist or is unreadable — try the next extension. No
        // ENOENT vs EACCES distinction because the missing-file case is the
        // dominant one and a permissions issue surfaces at dispatch import.
      }
    }
    return null;
  }

  /**
   * Resolve the handler for a manifest-declared command, deferred to first
   * dispatch so a plugin with twenty commands pays no import cost at load.
   *
   * Where that handler RUNS is the whole point of #12274. A non-builtin's
   * module is imported and invoked inside that plugin's own worker; what comes
   * back here is a synthetic stand-in that relays the call over the port, the
   * same shape `host.registerAction` has produced for worker-registered actions
   * since #5600. Only a built-in — app-bundled code, never uninstalled, never
   * dev-symlinked — is imported into Electron main, and it says so by name
   * rather than by being what's left over after the other branches.
   *
   * The synthetic is deliberately NOT cached in {@link pluginActionHandlers}:
   * it would outlive the worker generation it was built against, and a stale
   * bridge is exactly the binding a reload exists to discard. Rebuilding the
   * closure per dispatch costs nothing and cannot go stale, so no invalidation
   * hook is needed at any of the four teardown paths.
   */
  private async loadManifestCommandHandler(channel: string): Promise<ActionHandler> {
    const cached = this.pluginActionHandlers.get(channel);
    if (cached) return cached;
    const resolvedPath = this.commandModulePaths.get(channel);
    if (!resolvedPath) {
      throw new Error(`Command "${channel}" has no handler`);
    }
    const descriptor = this.pluginActions.get(channel);
    const pluginId = descriptor?.pluginId ?? channel;
    if (this.plugins.get(pluginId)?.isBuiltin !== true) {
      return this.buildWorkerCommandHandler(pluginId, channel, resolvedPath);
    }
    const mod = (await this.runImport(pluginId, resolvedPath)) as { default?: unknown };
    const owner = this.plugins.get(pluginId);
    if (!owner || this.blocklistMatchFor(owner)) {
      throw new Error(`Plugin "${pluginId}" is no longer loaded; cannot run command "${channel}"`);
    }
    if (typeof mod.default !== "function") {
      throw new Error(
        `Command "${channel}" handler module "${resolvedPath}" has no callable default export`
      );
    }
    const handler = mod.default as ActionHandler;
    // Race guard: a concurrent dispatch may have already cached the same
    // handler. Keep the existing entry so the older closure is canonical and
    // any per-call state inside it isn't shadowed by a sibling import.
    const existing = this.pluginActionHandlers.get(channel);
    if (existing) return existing;
    this.pluginActionHandlers.set(channel, handler);
    return handler;
  }

  /**
   * Build the stand-in that relays a manifest command into its plugin's worker
   * (#12274). The worker entry is looked up when the command RUNS, not when
   * this closure is built, so a reload that replaced the worker in between is
   * routed to the live generation rather than a dead one.
   *
   * `dispatchHandler` has already awaited `activatePlugin`, but that promise
   * never rejects (#9428) — a plugin whose activation failed still arrives
   * here, just with no worker behind it. That reads as a missing entry and
   * fails with a message naming activation, so the toast doesn't blame the
   * handler file for a failure that happened before it.
   */
  private buildWorkerCommandHandler(
    pluginId: string,
    channel: string,
    resolvedPath: string
  ): ActionHandler {
    return async (args: unknown) => {
      const entry = this.pluginWorkers.get(pluginId);
      if (!entry || entry.activation.ok === false) {
        throw new Error(`Plugin "${pluginId}" is not activated; cannot run command "${channel}"`);
      }
      // `entry.activation.ok` describes the last outcome the bridge REPORTED,
      // which survives the worker it described: after a crash the entry and its
      // stale `ok: true` both persist while a replacement forks. The bridge's
      // own generation state is the live fact, so it makes the final call.
      return entry.bridge.invokeCommand(channel, resolvedPath, args);
    };
  }

  /**
   * Plugins are lazy by default (#10523): an absent or empty `activationEvents`
   * means the plugin's `main` is imported and `activate()` is run only on first
   * use — a contributed command being dispatched, a forge provider or file
   * decoration being queried, or a contributed panel view being opened. Their
   * static contributions (commands, panels, keybindings, …) are still registered
   * eagerly at load time, so they appear in the palette before any plugin code
   * runs. `"onStartupFinished"` is the explicit opt-in for plugins that genuinely
   * need to run at boot. It is still the only recognised literal; lazy triggers
   * call `activatePlugin` directly rather than matching inferred `onCommand:*` /
   * `onView:*` event strings.
   */
  private shouldActivateOnStartup(manifest: PluginManifest): boolean {
    const events = manifest.activationEvents;
    if (!events || events.length === 0) return false;
    return events.includes("onStartupFinished");
  }

  /**
   * Whether a non-builtin plugin has code for a worker to run (#12274).
   *
   * `main` is the obvious case. The other is a plugin that declares commands
   * and ships handler modules but no entry point: before this, its `src/` files
   * were imported into Electron main precisely BECAUSE it had no worker, which
   * is the asymmetry the issue closes. It needs one now.
   *
   * Reads {@link commandModulePaths}, so it is only meaningful after
   * `registerManifestCommands` has probed — which is load time, well before any
   * activation trigger. A command whose file is missing, whose only sibling is
   * `.ts`, or whose registration was rejected leaves no entry, so a descriptor
   * with nothing behind it still forks nothing.
   */
  private hasWorkerCode(pluginId: string, plugin: LoadedPlugin): boolean {
    if (plugin.isBuiltin) return false;
    if (plugin.resolvedMain) return true;
    return (
      plugin.manifest.contributes?.commands?.some((cmd) =>
        this.commandModulePaths.has(`${pluginId}.${cmd.id}`)
      ) ?? false
    );
  }

  /**
   * Actually import the plugin's `main` module, create its host, and run
   * `activate()`. Wrapped by {@link activatePlugin} for idempotency &
   * concurrent-caller dedup — direct callers will re-import on every call.
   * Errors are persisted to the provenance record but never rethrown by
   * `activatePlugin` (which exposes a never-rejecting promise to triggers).
   */
  private async _doActivate(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    // User-installed plugins activate inside a `utilityProcess.fork` worker
    // (#10526). Dev plugins hot-reload on each `dist/index.js` rebuild; packaged
    // prod plugins run the same worker without the file watcher. Out-of-process
    // gives each a fresh module realm per lifecycle — so uninstall/disable/reload
    // truly reclaims its module state by killing the worker (no ESM cache leak)
    // — plus OS-level crash isolation.
    //
    // Built-in plugins stay on the in-process `import()` loader: they are trusted
    // app-bundled code, never uninstalled, and never dev-symlinked, so the
    // unload/divergence problems don't apply. Crucially, the GitHub built-in's
    // `host.registerForgeProvider` binds a forge impl whose `parseRemote` and URL
    // builders are SYNCHRONOUS — they can't cross the worker's async MessagePort
    // (#8879), so routing built-ins through the worker would silently break forge.
    if (!plugin.isBuiltin) {
      // Eligibility (`main`, or a manifest command with a resolved handler) is
      // decided by `activateViaWorker` itself — it is the same predicate its
      // reuse guard needs, so it lives in one place.
      return this.activateViaWorker(pluginId, plugin);
    }
    // A built-in with no `main` has nothing to activate. Its manifest commands
    // are still dispatchable: `loadManifestCommandHandler` imports them on
    // demand, in-process, which for a built-in is the intended path (#12274).
    if (!plugin.resolvedMain) return;
    try {
      // Bound the dynamic import — a built-in with a hanging top-level await
      // would otherwise pin this promise forever and stall `Promise.allSettled`
      // fan-outs (file-decoration scope, startup activation).
      const mod = (await this.runImport(pluginId, plugin.resolvedMain)) as {
        activate?: unknown;
      };
      // The import is a suspension point: an unload, or a refreshed blocklist
      // naming this plugin, may have landed while it resolved.
      if (this.plugins.get(pluginId) !== plugin || this.blocklistMatchFor(plugin)) return;
      if (typeof mod.activate === "function") {
        const activate = mod.activate as PluginActivate;
        const { host, revoke } = this.createHost(pluginId);

        // Pre-register a rollback that undoes activate-time imperative
        // registrations — channels, imperative actions, and every disposer
        // tracked in `pluginEventCleanups` (event/forge/worktree subscriptions).
        // A built-in whose `activate()` registers then throws — or is unloaded
        // mid-activation — would otherwise strand those registrations forever:
        // unlike a user plugin's worker, a failed built-in never runs the full
        // `unloadPlugin` cascade on its own. Mirrors the worker path, which
        // registers its teardown disposer before `start()` (#10621).
        const rollback = (): void => {
          this.removeHandlers(pluginId);
          this.unregisterImperativePluginActions(pluginId);
          this.flushPluginEventCleanups(pluginId);
        };
        this.cleanupMap.set(pluginId, rollback);

        try {
          const cleanup = await this.runActivate(pluginId, activate, host);
          // Guard against an unload that ran concurrently with this activation:
          // by the time `runActivate` resolves, `unloadPlugin` may have already
          // fired (and cleared) the pre-registered rollback. Only rebind when
          // the plugin is still loaded; otherwise drop it on the floor (#9428).
          if (this.plugins.has(pluginId)) {
            // Activation succeeded — the host-side teardown is owned by
            // `unloadPlugin`'s cascade, so replace the rollback with the
            // plugin's own cleanup (or clear it when none was returned),
            // matching the pre-#10621 contract.
            if (typeof cleanup === "function") {
              this.cleanupMap.set(pluginId, cleanup);
            } else if (this.cleanupMap.get(pluginId) === rollback) {
              this.cleanupMap.delete(pluginId);
            }
          } else if (this.cleanupMap.get(pluginId) === rollback) {
            this.cleanupMap.delete(pluginId);
          }
        } catch (activateErr) {
          // `activate()` threw after partially registering. No `unloadPlugin`
          // cascade runs for a failed built-in activation, so undo the partial
          // registrations now. The identity check skips a double-fire if a
          // concurrent unload already ran (and cleared) the rollback.
          if (this.cleanupMap.get(pluginId) === rollback) {
            this.cleanupMap.delete(pluginId);
            rollback();
          }
          throw activateErr;
        } finally {
          revoke();
        }
      }
    } catch (err) {
      // Built-ins don't carry a provenance record (they're not user-installed),
      // so a failure is logged but not persisted — mirrors the prior loader.
      console.error(`[PluginService] Failed to load main entry for ${pluginId}:`, err);
      throw err;
    }
  }

  /**
   * Activate a plugin inside a `utilityProcess.fork` worker (#9304, #10526).
   * The plugin's code runs in the child; the real host (from {@link createHost})
   * is bridged to the worker over MessagePort. Dev plugins (`mode: "dev"`) watch
   * `dist/index.js` and respawn on every rebuild, so module-scope state never
   * leaks across reloads (the robust fix for the Vite ESM cache leak); prod
   * plugins (`mode: "prod"`) run the same worker without the watcher, getting a
   * fresh module realm per load/unload — uninstall truly reclaims their memory.
   *
   * The host is left un-revoked for the worker's lifetime: the worker
   * legitimately re-registers on every reload, post-activation host calls
   * (dispatch, toast, spawn, fs.watch) keep relaying at runtime, and the
   * activation-window contract is enforced worker-side by its own proxy.
   *
   * A failed `activate()` is recorded but does NOT tear the worker down: a dev
   * worker keeps watching so the author can fix the error and save to reload.
   * Only a fork failure (no worker at all) rejects.
   */
  private async activateViaWorker(pluginId: string, plugin: LoadedPlugin): Promise<void> {
    // Worker eligibility reads the probed handler paths, so it cannot be decided
    // while the probe is still running (#12274) — deciding early would latch
    // "no worker needed" for the plugin's lifetime. Only a plugin with no `main`
    // depends on the answer, though, and the wait is deliberately confined to
    // it: `main` alone already makes a plugin eligible, so making every plugin
    // queue behind a filesystem probe would let one unresponsive mount stall an
    // activation that never needed the probe's result.
    if (!plugin.resolvedMain) {
      const discovery = this.commandDiscovery.get(pluginId);
      if (discovery) {
        await discovery.catch(() => undefined);
        // Post-await liveness re-check (#9428). Throwing rather than returning:
        // a return reads as a successful activation, and `activatePlugin` would
        // leave this fulfilled promise cached under an id whose CURRENT
        // generation was never activated — every later trigger would then get
        // the stale promise back and no worker would ever fork. The rejection
        // path drops the in-flight entry instead, so the live generation can
        // still activate (#10899); `activatePlugin` itself still never rejects.
        if (this.plugins.get(pluginId) !== plugin) {
          throw new Error(`Plugin "${pluginId}" was replaced during activation`);
        }
      }
    }
    if (!this.hasWorkerCode(pluginId, plugin)) return;
    // A re-activation while a worker is already live is a no-op — the worker
    // owns its own reload cycle; activatePlugin's idempotency normally prevents
    // this, but guard defensively against the unload-race re-entry path.
    const existing = this.pluginWorkers.get(pluginId);
    if (existing) {
      // ...unless its last generation FAILED. A worker left alive after a failed
      // activation is not an activated plugin, so returning here would let
      // `activatePlugin` cache the id and turn every later retry into a no-op —
      // the bug this method exists to fix, one level up. Drop it and fork fresh,
      // which is what Settings → Retry means for a generation that is not coming
      // back on its own.
      if (existing.activation.ok !== false) return;
      existing.cleanup();
    }

    // Spike #10890 (opt-in): compute the permission-model execArgv flags BEFORE
    // creating the host, so the default (env-off) path never awaits and stays
    // byte-for-byte the current fork behavior. Only the opt-in path yields — and
    // it fails open (fork without flags) and re-checks liveness after the await,
    // since a prototype/measurement must never break activation or fork a worker
    // for a plugin that unloaded mid-computation (#9533).
    let permissionExecArgv: string[] | undefined;
    if (isPluginPermissionModelSpikeEnabled()) {
      try {
        permissionExecArgv = await this.buildWorkerPermissionExecArgv(pluginId, plugin);
      } catch (err) {
        console.warn(
          `[PluginService] permission-model flag computation failed for ${pluginId}; forking without flags:`,
          err
        );
        permissionExecArgv = undefined;
      }
      if (!this.plugins.has(pluginId)) return;
    }

    const { host, revoke } = this.createHost(pluginId);
    const workerHost = new PluginDevWorkerHost({
      pluginId,
      // The host's own identity, so the worker-side proxy reports the real
      // binding instead of reconstructing one from the instance key.
      identity: host.pluginInfo,
      pluginDir: plugin.dir,
      // Absent for a commands-only plugin: the worker boots the harness and
      // reports activated without importing anything, then imports each command
      // handler on its first dispatch (#12274).
      bundlePath: plugin.resolvedMain ?? undefined,
      mode: plugin.devMode ? "dev" : "prod",
      permissionExecArgv,
    });
    const bridge = new PluginDevWorkerMainBridge({
      pluginId,
      host,
      workerHost,
      getCapabilities: () => this.plugins.get(pluginId)?.manifest.capabilities ?? [],
      // Only while this load is live: a straggler from a replaced instance
      // must not count against its same-id successor.
      onPushRejected: () => {
        if (this.plugins.get(pluginId) === plugin) this.metrics.recordPushOversized(pluginId);
      },
      clearPriorRegistrations: () => {
        // Drop the prior generation's activate-time registrations before the
        // reloaded worker re-registers, so a handler the new code stopped
        // registering doesn't linger. Manifest-declared commands are registered
        // once at load time and NOT replayed on reload, so only imperative
        // (`host.registerAction`) actions are cleared — clearing all of them
        // would erase the plugin's palette commands after the first reload.
        this.removeHandlers(pluginId);
        this.unregisterImperativePluginActions(pluginId);
        // A runtime menu describes the retiring backend's state (a selection,
        // a mode); the next generation republishes its own (#13213). So does a
        // toolbar count (#13503).
        this.clearPluginPanelMenus(pluginId);
        if (this.pluginToolbarBadges.delete(pluginId)) this.emitToolbarBadges(pluginId);
        if (this.pluginToolbarStates.delete(pluginId)) this.emitToolbarStates(pluginId);
        // What the retiring backend said it was doing is not what the next one
        // is doing; it reports afresh (#13820).
        if (this.pluginPanelActivity.delete(pluginId)) this.emitPanelActivity(pluginId);
        // Work the retiring backend was doing stopped with it (#13819).
        this.pluginTasks.interrupt(pluginId);
        this.resetPluginContextKeys(pluginId);
        this.clearPluginWorktreeCardStatuses(pluginId);
        this.clearPluginWorktreeReviewChecks(pluginId);
        this.clearPluginTerminalStatuses(pluginId);
      },
      // A protocol violation terminates the worker for good (#12276). Provenance
      // is already recorded by `onActivationResult`; this releases the runtime
      // state the owner holds — worker entry, activation cache, prompts — so the
      // plugin can be re-opened rather than left stuck dead.
      onTerminalFailure: () => {
        terminalFailure = true;
        // Guarded to the live entry: a replacement worker must not be torn down
        // by its predecessor's failure.
        if (this.pluginWorkers.get(pluginId) !== entry) return;
        // Published HERE rather than from the host listener in
        // `watchWorkerHealth`. The bridge subscribes to `protocol-violation` in
        // its constructor, so it runs first: it fails the activation (which
        // publishes `activation-failed`) and tears the entry down, and by the
        // time the health listener gets its turn its identity guard fails. The
        // violation would otherwise be reported as "it threw while starting up".
        this.setWorkerStatus(pluginId, "failed", "protocol-violation", null);
        this.deactivateWorker(pluginId);
      },
      // Fires on every activation outcome (initial + each reload). Keeps the
      // provenance `loadError` in sync so a fix-and-save clears a stale error
      // and a freshly-introduced one is recorded — the first-activation promise
      // alone can't see post-reload outcomes.
      onActivationResult: (result) => {
        activation.ok = result.ok;
        // Guarded to the live entry: a retired generation settling late must not
        // describe the replacement that already took its place (#10899).
        if (this.pluginWorkers.get(pluginId) === entry) {
          if (result.ok) {
            this.setWorkerStatus(pluginId, "ready", null, null);
          } else {
            this.setWorkerStatus(pluginId, "failed", "activation-failed", result.error);
            // A respawned or reloaded worker that throws keeps the activation
            // latch from the generation before it, so a notes check it bound
            // before throwing would still be asked (#13805).
            unregisterWorktreeDeleteNotesBinding(pluginId);
          }
        }
        if (result.ok) {
          if (!this.pluginsWithLoadTimeErrors.has(pluginId)) {
            this.recordPluginLoadError(pluginId, plugin, null);
          }
        } else {
          this.recordPluginLoadError(pluginId, plugin, {
            message: result.error,
            stack: result.stack,
            at: Date.now(),
          });
        }
      },
    });

    // Tracks the most recent activate() outcome reported by the bridge. A failed
    // first activation must not be cached as "activated" (#10523 retry-on-reopen):
    // for a prod worker — which has no file watcher to auto-recover — we tear the
    // worker down below so a re-open (Settings → Retry) re-forks and re-runs.
    const activation: { ok?: boolean } = {};
    /** Set when the worker broke the protocol and was terminated (#12276). */
    let terminalFailure = false;

    const entry = { workerHost, bridge, revoke, cleanup: () => cleanup(), activation };
    this.pluginWorkers.set(pluginId, entry);
    // Subscribed to the host's own lifecycle events rather than threaded through
    // the bridge: the supervisor respawns a crashed worker without telling this
    // service, so the process edges are only observable here (#12278).
    const detachHealth = this.watchWorkerHealth(pluginId, entry);
    this.setWorkerStatus(pluginId, "starting", null, null, { newGeneration: true });

    // Register the teardown disposer up front so a concurrent unloadPlugin()
    // during fork/activation tears the worker down through the normal cascade.
    let cleanedUp = false;
    const cleanup = (): void => {
      // One-shot: a late catch running after the entry was already replaced must
      // not detach the SUCCESSOR's listeners or dispose its worker.
      if (cleanedUp) return;
      cleanedUp = true;
      detachHealth();
      bridge.dispose();
      workerHost.dispose();
      revoke();
      if (this.pluginWorkers.get(pluginId) === entry) {
        this.pluginWorkers.delete(pluginId);
      }
    };
    this.cleanupMap.set(pluginId, cleanup);

    try {
      await workerHost.start();
    } catch (err) {
      // Fork failure — no worker exists, so this is a hard activation failure.
      //
      // Guarded, because this catch also fires for a startup that was CANCELLED:
      // an unload during the fork disposes the worker, which rejects `start()`.
      // The unload has already dropped this instance's status, so writing here
      // unguarded resurrects an orphan no later `unloadPlugin` can clear (it
      // returns early once the id is gone from `plugins`) — and during a restart
      // it would describe the replacement using its predecessor's disposal
      // error. A protocol violation reported by the bridge keeps its own,
      // sharper reason for the same reason.
      if (!this.disposed && this.pluginWorkers.get(pluginId) === entry && !terminalFailure) {
        this.setWorkerStatus(
          pluginId,
          "failed",
          "fork-failed",
          formatErrorMessage(err, "fork failed")
        );
      }
      cleanup();
      this.recordPluginLoadError(pluginId, plugin, toPluginLoadError(err));
      console.error(`[PluginService] Failed to start worker for ${pluginId}:`, err);
      throw err;
    }

    // A protocol violation during boot already tore the worker down and dropped
    // the entry, so the raced-unload check below would read as a clean return
    // and let `activatePlugin` cache the id as activated. Rethrow instead: the
    // recovery path is a re-open that forks a fresh worker.
    if (terminalFailure) {
      throw new Error(`Plugin "${pluginId}" dev worker stopped: protocol violation`);
    }

    // If an unload raced the fork, the cleanup already disposed everything.
    if (!this.plugins.has(pluginId) || this.pluginWorkers.get(pluginId) !== entry) {
      cleanup();
      return;
    }

    // Bound the first activation so a plugin with a hanging `activate()` (or a
    // never-resolving top-level await in the worker) can't stall the
    // `Promise.allSettled` startup gate forever.
    const gate = bridge.waitForActivation();
    // The race abandons this promise on timeout; a late `activate-error` would
    // otherwise settle it with nobody listening.
    gate.catch(() => undefined);
    try {
      await withTimeout(
        gate,
        ACTIVATE_TIMEOUT_MS,
        `Plugin "${pluginId}" activate() did not settle within ${ACTIVATE_TIMEOUT_MS}ms`
      );
      return;
    } catch (err) {
      // Record only what the bridge did not. It settles a failed activation
      // twice — `onActivationResult` first, with the WORKER's error and stack,
      // then a rejection carrying a freshly-built main-process `Error` — so
      // recording every rejection would overwrite the real plugin stack with
      // this process's own. An outcome the bridge never reported at all, though,
      // is ours to persist: neither a timeout nor a crash calls
      // `onActivationResult`, and those are the two failures that would
      // otherwise leave no evidence at all.
      if (activation.ok === undefined) {
        this.recordPluginLoadError(pluginId, plugin, toPluginLoadError(err));
      }
      console.error(`[PluginService] Plugin "${pluginId}" activation:`, err);
      if (err instanceof TimeoutError) {
        if (this.pluginWorkers.get(pluginId) === entry) {
          this.setWorkerStatus(pluginId, "failed", "activation-timeout", err.message);
        }
        // A hung `activate()` leaves a worker burning CPU behind a host that has
        // already given up on it, and no message will ever arrive to retire it.
        // Isolated: a throw out of teardown must not replace the activation
        // failure it is cleaning up after, nor skip the bookkeeping below.
        try {
          bridge.retire(`Plugin "${pluginId}" activate() did not settle`);
        } catch (retireErr) {
          console.error(`[PluginService] Retiring "${pluginId}" threw:`, retireErr);
        }
      }
    }

    // Every unsuccessful outcome marks the generation failed — not just the ones
    // the bridge reported. A timeout never reports, and neither does a crash, so
    // leaving this `undefined` would let the reuse guard read a dead entry as
    // "still in flight" and cache the id as activated.
    activation.ok = false;

    // An unload raced the failure and already tore the entry down.
    if (this.pluginWorkers.get(pluginId) !== entry) {
      throw new Error(`Plugin "${pluginId}" activate() failed`);
    }

    // A failed first activation must not be cached as a successful one (#10523):
    // `activatePlugin` adds the id to `activatedPlugins` when this method
    // RESOLVES, which would short-circuit every later re-open and make the
    // panel's retry control a no-op forever. Throwing instead routes through
    // `activatePlugin`'s existing identity-guarded rejection handler, which drops
    // the in-flight entry so a retry genuinely re-runs (#10899) — while
    // `activatePlugin` itself still never rejects (#9428).
    //
    // A dev worker is left alive so the author can fix the error and save: its
    // retry path is `PluginDevArtifactWatcher` reconciling the whole plugin
    // (#12277). A prod worker has no watcher, so tear it down and let the next
    // trigger fork a fresh one.
    if (!plugin.devMode) cleanup();
    throw new Error(`Plugin "${pluginId}" activate() failed`);
  }

  /**
   * Wrap `import()` in a timeout race so a plugin with a hanging top-level
   * await (e.g. `await new Promise(() => {})`) can't stall the host. ESM's
   * URL-keyed module cache means a successful import resolves instantly on
   * retry; a hang only affects the first attempt.
   */
  private async runImport(pluginId: string, resolvedMain: string): Promise<unknown> {
    // Built-in origin is a POSITIVE requirement to run plugin code in Electron
    // main, not the default that other branches happen to route around
    // (#12274). Both current callers already select for it — the built-in arm
    // of `_doActivate`, and the built-in arm of `loadManifestCommandHandler` —
    // so this changes nothing today and is here for the next caller, where
    // reaching main by omission is exactly the mistake that would be easy to
    // make and invisible once made.
    if (this.plugins.get(pluginId)?.isBuiltin !== true) {
      throw new Error(
        `Plugin "${pluginId}" is not a built-in and must not be imported into Electron main`
      );
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        import(pathToFileURL(resolvedMain).href),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(`Plugin "${pluginId}" import() timed out after ${IMPORT_TIMEOUT_MS}ms`)
            );
          }, IMPORT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Idempotent activation entry point. Concurrent callers share the same
   * in-flight promise; once activation settles successfully the result is
   * cached for the plugin's lifetime so subsequent callers return synchronously
   * via the fast-path `activatedPlugins` check. A rejected activation deletes
   * the in-flight entry so callers (e.g. Settings "Retry activation") can
   * re-attempt. Errors are surfaced via the persisted `loadError` record —
   * this method never rejects, matching the contribution-point trigger
   * contract that a failed activation must leave routing entries intact.
   */
  async activatePlugin(pluginId: string): Promise<void> {
    // Every lazy trigger (dispatch, panel open, forge/decoration pull) funnels
    // through here — including post-activation short-circuits — so this is the
    // single "the plugin was needed now" edge the idle-dispose gate reads.
    this.pluginWorkerActivity.set(pluginId, Date.now());
    if (this.activatedPlugins.has(pluginId)) return;
    const existing = this.activationPromises.get(pluginId);
    if (existing) return existing;
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    if (this.blockLoadedPluginIfListed(pluginId, plugin)) {
      this.broadcaster.broadcastProvenanceChanged();
      return;
    }
    // A project plugin can activate while the startup scan still holds
    // contribution broadcasts; what it dispatches must find them published.
    this.broadcaster.interruptHolds();

    const activationStart = performance.now();
    const promise = this._doActivate(pluginId).then(
      () => {
        // Guard against an unload — or a disable→re-enable that reloaded the id
        // as a fresh generation — while activation was in flight. unload clears
        // `activatedPlugins`/`plugins` synchronously, so a late-resolving stale
        // activation must not re-insert a tombstoned id, nor mark the NEW
        // generation activated (which would fast-path past its own worker fork,
        // #10887). Identity-compare the loaded object, not just presence.
        if (this.plugins.get(pluginId) === plugin) {
          this.activatedPlugins.add(pluginId);
          this.recordActivationMetric(pluginId, performance.now() - activationStart);
        }
      },
      () => {
        // Error is already persisted to the provenance record inside
        // `_doActivate`. Drop the in-flight entry so a subsequent
        // `activatePlugin(pluginId)` re-runs activation (Settings → Retry) — but
        // only if it's still ours, so a stale generation's late rejection can't
        // evict the new generation's in-flight promise.
        if (this.activationPromises.get(pluginId) === promise) {
          this.activationPromises.delete(pluginId);
        }
      }
    );
    this.activationPromises.set(pluginId, promise);
    return promise;
  }

  /**
   * Call to settled, including worker boot for worker plugins. Only successful
   * activations are recorded; a failure already has its own provenance record.
   */
  private recordActivationMetric(pluginId: string, durationMs: number): void {
    this.metrics.recordActivation(pluginId, durationMs);
    markPerformance("plugin-activated", { pluginId, durationMs: Math.round(durationMs) });
  }

  private *liveWorkerPids(): Iterable<readonly [string, number]> {
    for (const [pluginId, entry] of this.pluginWorkers) {
      const pid = entry.workerHost.pid;
      if (pid !== null) yield [pluginId, pid];
    }
  }

  /**
   * Fan out activation for every plugin that opts into `"onStartupFinished"`
   * (see {@link shouldActivateOnStartup}). Plugins without `activationEvents`
   * are lazy (#10523) and are deliberately excluded here — they activate on
   * first use instead. Activations run in parallel via `Promise.allSettled`;
   * one slow plugin must not block the rest. Wired fire-and-forget from the
   * `plugin-service` deferred task so the renderer keeps progressing while
   * plugins warm up in the background.
   */
  async activateStartupFinishedPlugins(): Promise<void> {
    try {
      const targets: string[] = [];
      for (const plugin of this.plugins.values()) {
        if (!plugin.resolvedMain) continue;
        if (!this.shouldActivateOnStartup(plugin.manifest)) continue;
        targets.push(plugin.manifest.name);
      }
      if (targets.length === 0) return;
      const errorsBefore = targets.map((id) => this.getPluginLoadError(id)?.message);
      await Promise.allSettled(targets.map((id) => this.activatePlugin(id)));
      // Catalog readers no longer wait for this fan-out (#14127), and an
      // installed plugin's activation error is persisted without a push of its
      // own: tell the plugin list to pull an outcome it may have missed. Only
      // on a change, since every provenance push also closes the manager's
      // open uninstall/update confirmations.
      if (targets.some((id, i) => this.getPluginLoadError(id)?.message !== errorsBefore[i])) {
        this.broadcaster.broadcastProvenanceChanged();
      }
    } finally {
      // Open the init gate even if every plugin's activate() rejected — a
      // crashed plugin must not strand renderer IPC callers awaiting
      // waitForInit() forever. `Promise.allSettled` already swallows
      // individual rejections, but `targets.length === 0` short-circuits
      // before the awaited line, so the finally is what guarantees release
      // in the no-plugins case. Fully started implies the catalog is too.
      this.resolveCatalog?.();
      this.resolveCatalog = null;
      this.resolveInit?.();
      this.resolveInit = null;
    }
  }

  /**
   * Activate the plugin that owns the forge provider matching `namespacedId`
   * before the forge RPC server looks up its impl. Resolves the owning plugin
   * via the manifest registry rather than parsing `pluginId.contributionId` —
   * plugin ids are `publisher.name` (already containing a dot), so a split
   * would mis-attribute. A no-op if the namespaced id isn't registered.
   */
  async activatePluginForForgeProvider(namespacedId: string): Promise<void> {
    if (typeof namespacedId !== "string" || namespacedId.length === 0) return;
    for (const [pluginId, plugin] of this.plugins) {
      for (const contribution of plugin.manifest.contributes.forgeProviders) {
        if (`${pluginId}.${contribution.id}` === namespacedId) {
          await this.activatePlugin(pluginId);
          return;
        }
      }
    }
  }

  /**
   * Activate the plugin that owns the contributed panel view identified by
   * `panelKindId` before its `plugin://` module is imported in the renderer.
   * Without this hook a lazy plugin's view module would load before its
   * `activate()` ran, so the `host.registerHandler` calls the view depends on
   * would not yet have fired (#10523). Mirrors {@link activatePluginForForgeProvider}:
   * the owning plugin is resolved by matching the registered panel-kind id
   * (`${pluginId}.${panel.id}`, exactly as built in `loadPlugin`) against the
   * manifest registry rather than splitting `panelKindId` on a dot — plugin ids
   * are `publisher.name` and already contain dots.
   *
   * Returns a plain {@link PluginActivationResult} so the renderer's
   * `PluginViewHost` can surface the real activation cause (#10618). Because
   * {@link activatePlugin} never rejects (the contribution-point trigger
   * contract), failures are read back from {@link getPluginLoadError} after the
   * await — covering all three failure modes (worker fork failure, activate()
   * timeout, activate() throw) for installed plugins through the persisted
   * provenance record and for project plugins through the in-memory map
   * (#12232). An unknown kind id resolves to `{ ok: true }`: there is nothing
   * to activate, and the renderer's module import then fails on its own with a
   * more specific error.
   *
   * Limitation: built-in plugins have neither channel, so a built-in activation
   * failure (logged, not recorded) reads back as `{ ok: true }` here and falls
   * through to the renderer's generic import error. Built-ins are app-bundled
   * trusted code where this is rare.
   *
   * `requestRecoveryPath` is the renderer's "my import of this view's module
   * failed, give me a URL V8 hasn't seen" request (#11728). A rejected dynamic
   * import is permanent for its specifier, so re-importing the published path
   * can never recover; only a fresh generation segment can. The replacement URL
   * is always built HERE from the loaded manifest — the renderer never supplies
   * a path, and never appends its own cache-buster (which would grow the module
   * map without bound). The generation is minted at most once per plugin load
   * and shared by every view the plugin contributes, so a plugin occupies two
   * namespaces at worst no matter how many times the user retries.
   */
  /**
   * Whether a loaded plugin declares `"remote": "unsupported"`: it only works
   * for a person sitting at this machine, so a window attached from another
   * machine must not start or call it.
   */
  isRemoteUnsupported(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.manifest.remote === "unsupported";
  }

  async activatePluginForView(
    panelKindId: string,
    requestRecoveryPath = false,
    options: { remoteFrontend?: boolean } = {}
  ): Promise<PluginActivationResult> {
    if (typeof panelKindId !== "string" || panelKindId.length === 0) return { ok: true };
    const hosted = parsePluginHostedViewKindId(panelKindId);
    if (hosted !== null) {
      return this.activatePluginForHostedView(
        hosted.pluginId,
        hosted.viewId,
        requestRecoveryPath,
        options
      );
    }
    for (const [pluginId, plugin] of this.plugins) {
      const projectId = plugin.binding?.projectId ?? null;
      for (const panel of plugin.manifest.contributes.panels) {
        // A project plugin's kinds are registered under the project-qualified
        // runtime id, not `{pluginId}.{panelId}`, so matching only the latter
        // would leave every lazily-activated project panel un-activated.
        const runtimeId =
          projectId === null
            ? `${pluginId}.${panel.id}`
            : toRuntimePanelKindId(
                { origin: "project", pluginId: plugin.manifest.name, kindId: panel.id },
                projectId
              );
        if (runtimeId === panelKindId) {
          if (options.remoteFrontend && plugin.manifest.remote === "unsupported") {
            console.warn(
              `[PluginService] Refused to activate "${pluginId}" for a window on another machine: the plugin declares "remote": "unsupported"`
            );
            return {
              ok: false,
              error: `Plugin "${pluginId}" only works on the machine it runs on`,
              remoteUnsupported: { pluginId },
            };
          }
          await this.activatePlugin(pluginId);
          const loadError = this.getPluginLoadError(pluginId);
          if (loadError) {
            return { ok: false, error: loadError.message, stack: loadError.stack };
          }
          if (!requestRecoveryPath) return { ok: true };
          // Re-read through the map: `activatePlugin` awaited above, so an
          // unload/disable in that window must not mint a generation onto a
          // detached plugin object the protocol will no longer resolve.
          const live = this.plugins.get(pluginId);
          if (!live || live !== plugin) return { ok: true };
          const view = panel.hasPty
            ? undefined
            : live.manifest.contributes.views.find(
                (v) => v.id === panel.id && v.location === "panel"
              );
          if (!view) return { ok: true };
          // Same reason the map re-read above exists: without a live authority
          // the URL would address nothing, so offer no recovery path at all
          // rather than one that 404s.
          const authority = this.pluginAuthorities.get(pluginId);
          if (!authority) return { ok: true };
          live.recoveryViewGeneration ??= allocatePluginViewGeneration();
          return {
            ok: true,
            recoveryComponentPath: buildPluginViewUrl(
              authority,
              view.componentPath,
              live.recoveryViewGeneration
            ),
          };
        }
      }
    }
    // A window on another machine restored or kept a panel whose plugin this
    // host doesn't have (any more): say so, rather than letting its import 404.
    const ref = options.remoteFrontend ? toPersistedPanelKindRef(panelKindId) : null;
    if (ref && ![...this.plugins.values()].some((p) => p.manifest.name === ref.pluginId)) {
      throw pluginNotOnHostError(ref.pluginId);
    }
    return { ok: true };
  }

  /**
   * {@link activatePluginForView} for a view that mounts outside the panel grid
   * (#13770), which names no panel kind: the id carries the instance key and
   * the view id directly. Same activation, remote gate, failure reporting and
   * recovery-URL contract as a panel view.
   */
  private async activatePluginForHostedView(
    pluginId: string,
    viewId: string,
    requestRecoveryPath: boolean,
    options: { remoteFrontend?: boolean }
  ): Promise<PluginActivationResult> {
    const plugin = this.plugins.get(pluginId);
    const view = plugin?.manifest.contributes.views.find(
      (v) => v.id === viewId && v.location !== "panel"
    );
    if (!plugin || !view) return { ok: true };
    if (options.remoteFrontend && plugin.manifest.remote === "unsupported") {
      console.warn(
        `[PluginService] Refused to activate "${pluginId}" for a window on another machine: the plugin declares "remote": "unsupported"`
      );
      return {
        ok: false,
        error: `Plugin "${pluginId}" only works on the machine it runs on`,
        remoteUnsupported: { pluginId },
      };
    }
    await this.activatePlugin(pluginId);
    const loadError = this.getPluginLoadError(pluginId);
    if (loadError) return { ok: false, error: loadError.message, stack: loadError.stack };
    if (!requestRecoveryPath) return { ok: true };
    const live = this.plugins.get(pluginId);
    if (!live || live !== plugin) return { ok: true };
    const authority = this.pluginAuthorities.get(pluginId);
    if (!authority) return { ok: true };
    live.recoveryViewGeneration ??= allocatePluginViewGeneration();
    return {
      ok: true,
      recoveryComponentPath: buildPluginViewUrl(
        authority,
        view.componentPath,
        live.recoveryViewGeneration
      ),
    };
  }

  /**
   * The `@` context providers a view of `projectId` sees (#13795), each with
   * whether it holds its prefix there, was refused it, or is switched off.
   */
  getContextProvidersForProject(projectId: string | null): ContextProviderEntry[] {
    const visible = selectContributionsForProject(
      getRegisteredContextProviders(),
      (entry) => entry.pluginId,
      projectId
    );
    if (visible.length === 0) return [];
    const off = getContextProvidersOff();
    return arbitrateContextProviders(visible, (pluginId) => off.has(pluginId));
  }

  /**
   * Activate every plugin whose `fileDecorationProviders` declares a scope
   * matching `scope`. Mirrors the registry-side `getFileDecorationImpls`
   * filter so the activation set is exactly the impl set that will be queried
   * once activation resolves. Runs activations in parallel — one slow plugin
   * must not stall an entire decoration pull.
   *
   * `projectId` is the requesting view's project, and is required for the
   * same reason the handler's impl filter needs it: a plugin that project
   * hides must not be started by its file views.
   */
  async activatePluginsForFileDecorationScope(
    scope: string,
    projectId: string | null
  ): Promise<void> {
    if (typeof scope !== "string" || scope.length === 0) return;
    const targets: string[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      for (const contribution of plugin.manifest.contributes.fileDecorationProviders) {
        if (contribution.scopes.some((pattern) => scopeMatchesPattern(scope, pattern))) {
          targets.push(pluginId);
          break;
        }
      }
    }
    const visible = selectContributionsForProject(targets, (id) => id, projectId);
    if (visible.length === 0) return;
    await Promise.allSettled(visible.map((id) => this.activatePlugin(id)));
  }

  private worktreeDeleteNotesHost(): WorktreeDeleteNotesHost {
    return {
      plugins: this.plugins,
      activatePlugin: (pluginId) => this.activatePlugin(pluginId),
      isActivated: (pluginId) => this.activatedPlugins.has(pluginId),
      readWorktree: (projectId, worktreeId) =>
        this.readWorktreeForDeleteNotes(projectId, worktreeId),
      isMuted: isWorktreeDeleteNotesMuted,
    };
  }

  /** The plugins a delete confirmation in `projectId` asks for notes (#13805). */
  listWorktreeDeleteNoteSources(projectId: string): WorktreeDeleteNoteSource[] {
    return listDeleteNoteSources(this.worktreeDeleteNotesHost(), projectId);
  }

  /** One plugin's notes on one of `projectId`'s worktrees, activating it if need be (#13805). */
  getWorktreeDeleteNotes(
    projectId: string,
    pluginId: string,
    worktreeId: string
  ): Promise<WorktreeDeleteNotesAnswer | null> {
    return getDeleteNotes(this.worktreeDeleteNotesHost(), projectId, pluginId, worktreeId);
  }

  /**
   * Every source's notes on one worktree, for a confirmation that can't stream
   * (#13805). `timeoutMs` narrows the per-plugin deadline for a caller that has
   * already spent some of it.
   */
  collectWorktreeDeleteNotes(
    projectId: string,
    worktreeId: string,
    timeoutMs?: number
  ): Promise<WorktreeDeleteNotesReport[]> {
    return collectDeleteNotes(
      { ...this.worktreeDeleteNotesHost(), ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      projectId,
      worktreeId
    );
  }

  /**
   * The worktree a note check asks about, read from the confirmation's own
   * project — never the ambient one an installed plugin's getters follow, which
   * may be another window's.
   */
  private async readWorktreeForDeleteNotes(
    projectId: string,
    worktreeId: string
  ): Promise<WorktreeDeleteNotesTarget> {
    let projectRoot: string | undefined;
    try {
      const row = projectStore.getProjectById(projectId);
      projectRoot = row?.status === "closed" ? undefined : row?.path;
    } catch {
      return { status: "unavailable" };
    }
    if (typeof projectRoot !== "string" || projectRoot.length === 0) return { status: "missing" };
    const result = await this.fetchWorktreeSnapshotsForProjectResult(projectId, projectRoot);
    if (result.status !== "ok") return { status: "unavailable" };
    const snapshot = result.snapshots.find(
      (candidate) => candidate.id === worktreeId || candidate.worktreeId === worktreeId
    );
    if (!snapshot) return { status: "missing" };
    try {
      const titles = this.readWorktreeCustomTitles(projectId);
      const customTitle = Object.hasOwn(titles, snapshot.id) ? (titles[snapshot.id] ?? null) : null;
      return { status: "ok", worktree: toPluginWorktreeSnapshot(snapshot, customTitle) };
    } catch {
      return { status: "unavailable" };
    }
  }

  /**
   * Append one line to a plugin's diagnostic ring buffer and mirror it to the
   * host console. `boundPlugin` is the {@link LoadedPlugin} the calling host
   * was created for; the write no-ops unless it is still the live instance for
   * `pluginId`. This is stricter than a `this.plugins.has(pluginId)` check: it
   * also rejects a stale host left over from a previous activation after a
   * same-id reload (dev-mode rescan), so the old session's timers can't
   * pollute the new buffer.
   *
   * `fields`, when present, is JSON-serialized and folded into the message;
   * serialization is fully defensive (a circular ref or a throwing `toString`
   * never escapes). The rendered line is truncated codepoint-aware so a
   * multi-byte glyph is never split into a lone surrogate — a lone surrogate
   * would make `encodeURIComponent` throw downstream in `buildReportIssueUrl`.
   * A logger call must never propagate an error back into plugin code.
   */
  private recordPluginLog(
    boundPlugin: LoadedPlugin,
    pluginId: string,
    level: PluginDiagnosticsLogLine["level"],
    message: string,
    fields?: Record<string, unknown>
  ): void {
    if (this.plugins.get(pluginId) !== boundPlugin) return;

    const safeMessage = typeof message === "string" ? message : safeStringify(message);
    let rendered = safeMessage;
    if (fields !== undefined) {
      const serialized = safeStringify(fields);
      rendered = serialized ? `${rendered} ${serialized}` : rendered;
    }
    // Scrub before truncation: scrubSecrets replaces each secret with the
    // shorter "[REDACTED]" sentinel, so the codepoint cap below still bounds the
    // line — and a secret straddling that boundary is fully redacted instead of
    // being bisected into a fragment too short for the scrubber to match. Both
    // sinks below — the log buffer that feeds shareable bug reports and the
    // console mirror — consume this scrubbed value.
    rendered = scrubSecrets(rendered);
    // Codepoint-aware cap: spreading splits at codepoint (not UTF-16 code-unit)
    // boundaries, so the slice can never bisect a surrogate pair. (It may clip a
    // trailing "[REDACTED]" sentinel, which is harmless.)
    const codepoints = Array.from(rendered);
    if (codepoints.length > PLUGIN_LOG_LINE_MAX_CHARS) {
      rendered = `${codepoints.slice(0, PLUGIN_LOG_LINE_MAX_CHARS - 1).join("")}…`;
    }

    let buffer = this.logBuffers.get(pluginId);
    if (!buffer) {
      buffer = [];
      this.logBuffers.set(pluginId, buffer);
    }
    buffer.push({ ts: Date.now(), level, message: rendered });
    if (buffer.length > PLUGIN_LOG_BUFFER_MAX) {
      buffer.splice(0, buffer.length - PLUGIN_LOG_BUFFER_MAX);
    }

    console[level](`[plugin:${pluginId}] ${rendered}`);

    // Info stays in the ring: the file gets what a diagnosis needs, not a
    // plugin's routine chatter. `fields` are left out of the durable copy —
    // they are arbitrary plugin payloads, and the only place a terminal buffer
    // or a prompt body could ride along wholesale.
    if (level === "warn" || level === "error") {
      this.writePluginFileLog(
        pluginId,
        level,
        level === "error" ? "Plugin reported an error" : "Plugin reported a warning",
        { message: boundPluginFileLogText(safeMessage) }
      );
    }
  }

  /**
   * Write one plugin-attributed line to `daintree.log` through the rate bound.
   * `category` picks the budget; the level follows it except for lifecycle,
   * which the caller may raise to `warn`. Returns whether the line was
   * admitted. Never throws — this runs inside `host.logger.*` and lifecycle
   * bookkeeping, neither of which may fail because the log did.
   */
  private writePluginFileLog(
    pluginId: string,
    category: PluginFileLogCategory,
    message: string,
    context: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = category === "lifecycle" ? "info" : category
  ): boolean {
    try {
      const identity = pluginFileLogIdentity(pluginId);
      const { admitted, suppressedInPreviousWindow } = this.fileLogLimiter.admit(
        pluginId,
        category
      );
      if (suppressedInPreviousWindow) {
        this.writePluginFileLogSummary(pluginId, suppressedInPreviousWindow);
      }
      if (!admitted) return false;
      if (level === "error") {
        logger.error(message, undefined, { ...identity, ...context });
      } else {
        logger[level](message, { ...identity, ...context });
      }
      return true;
    } catch {
      // A failing log write must not become a failing plugin call.
      return false;
    }
  }

  private writePluginFileLogSummary(pluginId: string, suppressed: PluginFileLogSuppressed): void {
    try {
      logger.warn("Plugin log lines suppressed by rate limit", {
        ...pluginFileLogIdentity(pluginId),
        suppressed,
      });
    } catch {
      // See writePluginFileLog.
    }
  }

  /**
   * Atomic, post-activation diagnostics snapshot of every loaded plugin:
   * provenance, the per-plugin log ring buffer, and the last
   * {@link PLUGIN_DIAGNOSTICS_AUDIT_PER_PLUGIN} audit records. Consumed by the
   * error-report builder. `originalUrl` is intentionally omitted (it can embed
   * install-time credentials); `argsHash`/`argsPlaintext` are dropped from
   * audit records. Returns `{ plugins: [] }` when nothing is loaded so the
   * report can omit the section entirely.
   */
  getDiagnosticsSnapshot(): PluginDiagnosticsSnapshot {
    // getRecords() is global and newest-first; bucket per plugin in one pass,
    // capping each bucket — no per-plugin sort needed.
    const auditByPlugin = new Map<string, PluginDiagnosticsAuditRecord[]>();
    for (const record of getPluginActionAuditService().getRecords()) {
      let list = auditByPlugin.get(record.pluginId);
      if (!list) {
        list = [];
        auditByPlugin.set(record.pluginId, list);
      }
      if (list.length >= PLUGIN_DIAGNOSTICS_AUDIT_PER_PLUGIN) continue;
      const { argsHash: _argsHash, argsPlaintext: _argsPlaintext, ...rest } = record;
      list.push(rest);
    }

    // `this.plugins` is keyed by the REGISTRY key, which for a project plugin is
    // its instance key (`project__{projectId}__{publisher.name}`) and not
    // `manifest.name` — the manifest keeps the bare id it declares, and
    // `loadPlugin` asserts the two agree rather than rewriting either. Keying
    // this off `manifest.name` therefore dropped every project plugin from the
    // snapshot, which is both the wrong set for a bug report and, since the log
    // buffers and audit records are themselves keyed by the registry key, the
    // one class of plugin whose author is reading these diagnostics (#12214).
    //
    // `info.instanceId` IS that registry key — `listPlugins` carries it through
    // (#12211) — so this filters and indexes on the key itself rather than
    // reconstructing it from manifest object identity.
    const plugins = this.listPlugins()
      .filter((info) => this.plugins.has(info.instanceId))
      .map((info) => {
        const pluginId = info.instanceId;
        const buffer = this.logBuffers.get(pluginId);
        return {
          pluginId,
          displayName: info.manifest.displayName ?? info.manifest.name,
          version: info.manifest.version,
          source: info.source,
          installedAt: info.installedAt,
          isBuiltin: info.isBuiltin,
          devMode: info.devMode,
          disabled: info.disabled,
          archiveHash: info.archiveHash,
          loadError: info.loadError,
          logLines: buffer ? buffer.map((line) => ({ ...line })) : [],
          auditRecords: auditByPlugin.get(pluginId) ?? [],
        };
      });

    return { plugins };
  }

  /**
   * Live deps object for {@link createHost} and the host-mediated fs/git/
   * process/clipboard API builders (`electron/services/plugin/PluginHostFactory.ts`).
   * Every Map/Set/collaborator field below is the actual live reference this
   * instance holds — never a snapshot — so the post-await liveness checks
   * inside the extracted host closures (`plugins.get(id) === boundPlugin`,
   * `plugins.has(id)`) keep observing concurrent unload races correctly.
   */
  private get hostFactoryDeps(): PluginHostFactoryDeps {
    return {
      plugins: this.plugins,
      pluginEventCleanups: this.pluginEventCleanups,
      pluginActions: this.pluginActions,
      pluginActionHandlers: this.pluginActionHandlers,
      pluginActionOwners: this.pluginActionOwners,
      actionValidators: this.actionValidators,
      pluginBadges: this.pluginBadges,
      pluginToolbarBadges: this.pluginToolbarBadges,
      emitToolbarBadges: (pluginId) => this.emitToolbarBadges(pluginId),
      pluginPanelActivity: this.pluginPanelActivity,
      emitPanelActivity: (pluginId) => this.emitPanelActivity(pluginId),
      nextPanelActivityRevision: () => ++this.panelActivityRevision,
      pluginTasks: this.pluginTasks,
      pluginToolbarStates: this.pluginToolbarStates,
      emitToolbarStates: (pluginId) => this.emitToolbarStates(pluginId),
      pluginContextKeys: this.pluginContextKeys,
      emitContextKeys: (pluginId) => this.emitContextKeys(pluginId),
      pluginWorktreeCardStatuses: this.pluginWorktreeCardStatuses,
      emitWorktreeCardStatuses: (pluginId, projectId) =>
        this.emitWorktreeCardStatuses(pluginId, projectId),
      worktreeCardStatusGeneration: (pluginId) =>
        this.worktreeCardStatusGenerations.get(pluginId) ?? 0,
      pluginWorktreeReviewChecks: this.pluginWorktreeReviewChecks,
      emitWorktreeReviewChecks: (pluginId, projectId) =>
        this.emitWorktreeReviewChecks(pluginId, projectId),
      worktreeReviewChecksGeneration: (pluginId) =>
        this.worktreeReviewChecksGenerations.get(pluginId) ?? 0,
      worktreeCardTargetRevision: () => this.worktreeCardTargetRevision,
      pluginTerminalStatuses: this.pluginTerminalStatuses,
      emitTerminalStatuses: (pluginId, projectId) => this.emitTerminalStatuses(pluginId, projectId),
      terminalStatusGeneration: (pluginId) => this.terminalStatusGenerations.get(pluginId) ?? 0,
      terminalStatusCloseRevision: () => this.terminalStatusCloseRevision,
      isTerminalStatusProjectClosed: (projectId, sinceRevision) =>
        (this.closedTerminalStatusProjects.get(projectId) ?? 0) > sinceRevision,
      isWorktreeCardTargetRetired: (projectId, worktreeId, since) =>
        this.isWorktreeCardTargetRetired(projectId, worktreeId, since),
      pluginPanelMenus: this.pluginPanelMenus,
      pluginFsWatchers: this.pluginFsWatchers,
      broadcaster: this.broadcaster,
      panelLifecycleBroker: this.panelLifecycleBroker,
      dispatcher: this.dispatcher,
      panelReloadDispatcher: this.panelReloadDispatcher,
      promptDispatcher: this.promptDispatcher,
      settings: this.settings,
      accounts: this.accounts,
      services: this.services,
      storage: this.storage,
      getHostGitFactory: () => this.hostGitFactory,
      getProcessManager: () => this.getProcessManager(),
      declaredCapabilities: (pluginId) => this.declaredCapabilities(pluginId),
      getFleetSnapshotService: () => getFleetSnapshotServiceRef(),
      fetchWorktreeSnapshotsResult: () => this.fetchAllWorktreeSnapshotsResult(),
      fetchWorktreeSnapshotsForProjectResult: (projectId, projectRoot) =>
        this.fetchWorktreeSnapshotsForProjectResult(projectId, projectRoot),
      getWorktreeCustomTitles: (projectId) => this.readWorktreeCustomTitles(projectId),
      // The factory tracks the disposer against the plugin, so an unload drops it.
      subscribeWorktreeCustomTitles: (listener) => onWorktreeCustomTitlesChanged(listener),
      recordPluginLog: (boundPlugin, pluginId, level, message, fields) =>
        this.recordPluginLog(boundPlugin, pluginId, level, message, fields),
      serializePluginBadges: (pluginId) => this.serializePluginBadges(pluginId),
      serializePluginPanelMenus: (pluginId) => this.serializePluginPanelMenus(pluginId),
      pluginDisplayName: (pluginId) => this.getPluginDisplayName(pluginId),
      pluginDataDir: (pluginId) => this.pluginDataDir(pluginId),
      artifactService: () => this.getArtifactService(),
      isPathUnder: (root, candidate) => this.isPathUnder(root, candidate),
      expandAllowedPathEntries: (pluginId, options) =>
        this.expandAllowedPathEntries(pluginId, options),
      subscribeWorktreeEvent: (pluginId, event, handler) =>
        this.subscribeWorktreeEvent(pluginId, event, handler),
      registerHandler: (pluginId, channel, schemaOrHandler, typedHandler) => {
        if (typedHandler !== undefined) {
          this.registerHandler(
            pluginId,
            channel,
            schemaOrHandler as PluginChannelSchema<unknown, unknown>,
            typedHandler
          );
        } else {
          this.registerHandler(pluginId, channel, schemaOrHandler as PluginIpcHandler);
        }
      },
      validateAndBuildActionDescriptor: (pluginId, contribution) =>
        this.validateAndBuildActionDescriptor(pluginId, contribution),
      safeAppendAudit,
      safeArgsHash,
      recordPushRejected: (pluginId) => this.metrics.recordPushOversized(pluginId),
      trackPromptWait: (pluginId) => this.metrics.beginPromptWait(pluginId),
      requestWorkerSelfRestart: (pluginId, boundPlugin) =>
        this.requestWorkerSelfRestart(pluginId, boundPlugin),
      pluginNotificationsBlocked: (pluginId, projectId) =>
        this.pluginNotificationsBlocked(pluginId, projectId),
    };
  }

  /**
   * The user's off switches for a plugin's toasts and notifications (#13818):
   * the plugin silenced, or the project the notification is about muted. A
   * project's settings that can't be read mute nothing — the failure is the
   * settings file's to report, and a lost plugin error would be a second one.
   */
  private async pluginNotificationsBlocked(
    pluginId: string,
    projectId: string | null
  ): Promise<boolean> {
    if (isPluginNotificationSilenced(pluginId)) return true;
    if (projectId === null) return false;
    // Bounded: the plugin's notifications queue behind this read, and a file
    // stuck on a dead mount must not hold every later one back for good.
    let muted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      muted = await Promise.race([
        projectStore.isProjectNotificationsMuted(projectId),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            console.warn("[PluginService] A project's notification mute took too long to read");
            resolve(false);
          }, PLUGIN_NOTIFICATION_MUTE_READ_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.warn("[PluginService] Couldn't read a project's notification mute:", err);
    } finally {
      clearTimeout(timer);
    }
    // Asked again after the read: the user may have silenced the plugin while
    // a cold project file was loading.
    return muted || isPluginNotificationSilenced(pluginId);
  }

  /**
   * Build a plugin's host object, bound to `binding`'s project.
   *
   * Every caller passes {@link UNBOUND_PLUGIN_HOST_BINDING} today: installed
   * and builtin plugins stay app-global by design, and nothing yet loads a
   * project-owned plugin. The parameter is what makes a bound host possible
   * once the project-scoped loader lands.
   */
  private createHost(
    pluginId: string,
    binding?: PluginHostBinding
  ): { host: PluginHostApi; revoke: () => void } {
    // The instance's own binding, captured at load, is authoritative — never a
    // default resolved from whatever project is focused when activation runs.
    const resolved = binding ?? this.plugins.get(pluginId)?.binding ?? UNBOUND_PLUGIN_HOST_BINDING;
    this.hostBindings.set(pluginId, resolved);
    return createPluginHost(this.hostFactoryDeps, pluginId, resolved);
  }

  /**
   * Lazily construct the managed-process manager, wiring its stream sink to the
   * plugin's `postToPanel` transport and its audit hook to the plugin audit
   * trail. Single instance per service so the per-plugin concurrency cap and
   * the unload teardown see every spawned process.
   */
  private getProcessManager(): PluginProcessManager {
    if (!this.processManager) {
      this.processManager = new PluginProcessManager({
        streamSink: (pluginId, event, panelId) => {
          // Membership-gated like postToPanel: a late stream emit after the
          // plugin unloads is dropped rather than broadcast.
          if (!this.plugins.has(pluginId)) return;
          // Same per-instance envelope as host.postToPanel — the process stream
          // rides the same transport and is consumed by the same `plugin.on`
          // dispatcher. `panelId` is the spawn-time routing target (#11300):
          // non-null targets the panel that started the process, null keeps the
          // historical broadcast to every panel the plugin owns.
          //
          // The manager is a single instance shared by every plugin, so the
          // owning plugin's binding is looked up here rather than closed over.
          // A bound plugin's process output reaches only its own project's
          // views; an unbound one deliberately reaches all of them, as its
          // panels can live in any project.
          //
          // Routed through the same per-renderer batcher as postToPanel, so a
          // process's output and the plugin's own pushes on this transport keep
          // one FIFO order per renderer. Host-generated chunks are not capped.
          routePluginPush({
            pluginId,
            projectId: this.hostBindings.get(pluginId)?.projectId ?? null,
            channel: `plugin:${pluginId}:${PLUGIN_PROCESS_STREAM_CHANNEL}`,
            panelId,
            payload: event,
            bytes: estimatePayloadBytes(event),
            locatePanel: (target, owner) => this.panelLifecycleBroker.pushTargetsFor(target, owner),
          });
        },
        ptySpawner: (config, context) =>
          this.getPluginPtyTransport().spawn(context.id, context.generation, {
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: config.env,
            cols: config.cols,
            rows: config.rows,
          }),
        auditor: ({ pluginId, command, args, processId }) => {
          // Surface the spawn in the audit trail so process execution is
          // observable. Best-effort — an audit failure must never block a spawn.
          safeAppendAudit({
            pluginId,
            actionId: `process.spawn:${command}`,
            recordType: "ipc-invoke",
            channel: "plugin:process-spawn",
            result: "success",
            errorMessage: "",
            argsHash: safeArgsHash([{ command, args, processId }]),
            durationMs: 0,
          });
        },
      });
    }
    return this.processManager;
  }

  /**
   * Lazily construct the interactive-process transport (#11300). Deferred until
   * a plugin actually spawns a PTY so the plugin subsystem never forces the
   * pty-host up on its own — the terminal path is what boots it, and this only
   * borrows the crash-isolated process once it exists.
   */
  private getPluginPtyTransport(): PluginPtyTransport {
    if (!this.pluginPtyTransport) {
      const client = getPtyClient();
      if (!client) {
        throw new Error("process.spawn: interactive (pty) mode requires the terminal backend");
      }
      this.pluginPtyTransport = new PluginPtyTransport(client);
    }
    return this.pluginPtyTransport;
  }

  /** Read-only process snapshot for the `plugin-process:list` IPC, optionally scoped to one plugin. */
  listManagedProcesses(pluginId?: string): PluginProcessInfo[] {
    if (!this.processManager) return [];
    return this.processManager.list(pluginId);
  }

  /**
   * App-quit teardown for every child a plugin spawned via `host.process.spawn`
   * (#12216). Called from `lifecycle/shutdown.ts` — the per-plugin `killAll` on
   * the unload cascade only covers a plugin going away, and nothing was
   * unloading these at quit, so a plugin's dev server outlived the app.
   *
   * Deliberately narrower than `dispose()`: quit wants the OS children gone,
   * not a full registry teardown with its contribution broadcasts and a second
   * best-effort MCP shutdown that `shutdown.ts` already runs on its own.
   *
   * Plugin workers are stopped here too. They die with the app either way, and
   * a supervisor that was not told first reads that exit as a crash: it logged
   * "Worker crashed (code 0)" for every worker on every quit and tried to
   * respawn it. Disposing the supervisor marks the exit as expected and sends
   * the worker its cooperative shutdown.
   */
  async shutdownManagedProcesses(): Promise<void> {
    await this.shutdownArtifacts();
    for (const { workerHost } of this.pluginWorkers.values()) {
      try {
        workerHost.dispose();
      } catch {
        // One worker failing to stop must not keep the others running.
      }
    }
    await this.processManager?.shutdownAll();
  }

  private getArtifactService(): PluginArtifactService | null {
    if (this.artifactService !== undefined) return this.artifactService;
    if (this.disposed) return null;
    const service = new PluginArtifactService({
      store: new PluginArtifactStore({
        rootDir: path.join(app.getPath("userData"), "plugin-artifacts"),
      }),
      netFetch: (input, init) => net.fetch(input, init),
    });
    this.artifactService = service;
    setArtifactSourceResolver((artifactId, lease) => service.openLeased(artifactId, lease));
    return service;
  }

  private async shutdownArtifacts(): Promise<void> {
    const service = this.artifactService;
    this.artifactService = null;
    if (!service) return;
    setArtifactSourceResolver(null);
    await service.dispose().catch(() => {});
  }

  /**
   * Import files a view's person chose (a drop or the file dialog) as the
   * plugin's artifacts. `paths` are only ever ones the preload resolved from
   * real Files for that view; the IPC handler checks the grant first.
   *
   * The leaf is refused when it is a symlink, and the opened descriptor must
   * be the entry that `lstat` saw — on Windows `O_NOFOLLOW` does nothing, so
   * that compare is what catches a chosen file swapped for a link. All or
   * nothing: each finished file stays pinned until the batch ends, so a later
   * one can't evict an earlier one to fit, and a failure releases them all.
   */
  async importArtifactSelection(
    pluginId: string,
    projectId: string | null,
    paths: readonly string[]
  ): Promise<PluginArtifact[]> {
    const service = this.requireArtifactAccess(pluginId, "importSelection");
    const imported: PluginArtifact[] = [];
    const pins: Array<() => void> = [];
    const refuse = (filePath: string, why: string) =>
      new Error(`INVALID_PATH: "${path.basename(filePath)}" ${why}`);
    // A project close between two files has no transfer to abort: the batch
    // notices it itself, before each file and once done.
    const closesAtStart = projectId === null ? 0 : service.projectCloseCount(projectId);
    const requireProjectOpen = () => {
      if (projectId !== null && service.projectCloseCount(projectId) !== closesAtStart) {
        throw Object.assign(new Error("ABORT_ERR: the project closed during the import"), {
          name: "AbortError",
          code: "ABORT_ERR",
        });
      }
    };
    try {
      for (const filePath of paths) {
        const leaf = await fs.lstat(filePath, { bigint: true });
        if (leaf.isSymbolicLink()) throw refuse(filePath, "is a link, not a file");
        const handle = await fs.open(
          filePath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
        );
        try {
          const stat = await handle.stat({ bigint: true });
          if (!stat.isFile()) throw refuse(filePath, "is not a regular file");
          if (stat.dev !== leaf.dev || stat.ino !== leaf.ino) {
            throw refuse(filePath, "changed while it was being opened");
          }
          // Synchronously before the transfer registers, so an unload or a
          // project close during the opens leaves nothing running.
          this.requireArtifactAccess(pluginId, "importSelection");
          requireProjectOpen();
          const artifact = await service.importFromHandle({
            pluginId,
            projectId,
            handle,
            size: Number(stat.size),
            sourceName: path.basename(filePath),
          });
          imported.push(artifact);
          const pin = service.store.openForRead(pluginId, artifact.id);
          if (pin) pins.push(pin.unpin);
        } finally {
          await handle.close().catch(() => {});
        }
      }
      requireProjectOpen();
    } catch (error) {
      for (const artifact of imported) service.store.release(pluginId, artifact.id);
      throw error;
    } finally {
      for (const unpin of pins) unpin();
    }
    return imported;
  }

  /** A playback source for `webContentsId`, revoked when that view goes away. */
  mintArtifactSource(
    pluginId: string,
    artifactId: string,
    webContentsId: number
  ): PluginArtifactSource {
    const service = this.requireArtifactAccess(pluginId, "source");
    const source = service.mintSource(pluginId, artifactId, webContentsId);
    if (!this.artifactLeaseViews.has(webContentsId)) {
      const contents = webContents.fromId(webContentsId);
      if (contents) {
        this.artifactLeaseViews.add(webContentsId);
        contents.once("destroyed", () => {
          this.artifactLeaseViews.delete(webContentsId);
          this.artifactService?.store.revokeLeasesForView(webContentsId);
        });
      }
    }
    return source;
  }

  revokeArtifactSource(url: string, webContentsId: number): boolean {
    const lease = /[?&]lease=([0-9a-f]{48})(?:&|$)/.exec(url)?.[1];
    if (!lease) return false;
    return this.artifactService?.store.revokeLease(lease, webContentsId) ?? false;
  }

  private requireArtifactAccess(pluginId: string, op: string): PluginArtifactService {
    if (!this.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" artifacts.${op}: plugin is not loaded`
      );
    }
    if (!this.declaredCapabilities(pluginId).has("artifact:store")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" artifacts.${op} requires the "artifact:store" capability`
      );
    }
    const service = this.getArtifactService();
    if (!service)
      throw new Error(`plugin "${pluginId}" artifacts.${op}: the artifact cache has shut down`);
    return service;
  }

  /**
   * Test seam: inject a {@link PluginProcessManager} wired to a controllable
   * fake spawner so host-level spawn/unload behavior can be exercised without
   * forking a real `node:child_process`. Production never calls this.
   */
  _setProcessManagerForTests(manager: PluginProcessManager): void {
    this.processManager = manager;
  }

  /**
   * Test-only seams for the host-mediated fs/git surface: register a fake
   * loaded plugin (capabilities + scopes) and build its host so `host.fs` /
   * `host.git` containment + gating can be exercised without a real on-disk
   * plugin or a forked git. Production never calls these.
   */
  _setHostGitFactoryForTests(factory: HostGitFactory): void {
    this.hostGitFactory = factory;
  }

  _registerFakePluginForTests(plugin: LoadedPlugin, instanceKey?: string): void {
    this.mintPluginAuthority(instanceKey ?? plugin.manifest.name, plugin.dir);
    // `instanceKey` mirrors the real `loadPlugin`, which keys a project plugin
    // by `project__{projectId}__{name}` while leaving `manifest.name` bare.
    // Without it a test cannot reproduce the shape the registry actually holds
    // for a project plugin, which is where the two diverge (#12214).
    this.plugins.set(instanceKey ?? plugin.manifest.name, plugin);
    noteNewestPluginInstance(this.plugins, instanceKey ?? plugin.manifest.name, plugin);
  }

  _unregisterFakePluginForTests(pluginId: string): void {
    this.invalidatePluginAuthority(pluginId);
    this.plugins.delete(pluginId);
  }

  _createHostForTests(pluginId: string, binding?: PluginHostBinding): PluginHostApi {
    return this.createHost(pluginId, binding).host;
  }

  /** The capabilities a loaded plugin declared, as a Set. Empty when unloaded. */
  private declaredCapabilities(pluginId: string): Set<BuiltInPluginCapability> {
    return new Set<BuiltInPluginCapability>(
      this.plugins.get(pluginId)?.manifest.capabilities ?? []
    );
  }

  /** The plugin's declared `scopes.fs.allowedPaths` (empty when none / unloaded). */
  private declaredAllowedPaths(pluginId: string): readonly string[] {
    return this.plugins.get(pluginId)?.manifest.scopes?.fs?.allowedPaths ?? [];
  }

  /**
   * The implicit project root a project plugin gets when it declares no
   * `scopes.fs.allowedPaths` (spec §7.2).
   *
   * It lives inside that tree, so the tree is the only sensible default, and
   * without it `host.fs` and `host.git` would have no root at all and the
   * plugin could reach nothing but its own data dir. Returned as an explicitly
   * `"project"`-classified entry rather than as a literal path: literal
   * classification calls anything under the user's home directory `"user-data"`,
   * and most projects live under `~/`, which would deny `fs:project-read` the
   * project root while granting it to `fs:user-data-read`.
   *
   * Only a project-origin plugin gets it. An installed or builtin plugin has no
   * project of its own, and `origin` is checked as well as the root so a
   * malformed binding cannot widen one.
   */
  private implicitProjectRoot(pluginId: string): ExpandedFsPath | null {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.origin !== "project") return null;
    const projectRoot = plugin.binding?.projectRoot;
    if (!projectRoot) return null;
    return { path: projectRoot, rootClass: "project" };
  }

  /** The implicit per-plugin data dir, always an allowed `user-data` root. */
  private pluginDataDir(pluginId: string): string {
    return path.join(os.homedir(), ".daintree", "plugin-data", pluginId);
  }

  /** Lexical containment: is `candidate` inside (or equal to) `root`? */
  private isPathUnder(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    return (
      rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
    );
  }

  /**
   * Spike #10890: compute the Node permission-model `execArgv` flags for a
   * plugin worker from its resolved `allowedPaths` + capabilities —
   * `--permission --allow-fs-read/-write` (per-root-class capability gated,
   * mirroring the sanctioned host.fs surface) plus `--allow-child-process` for
   * `shell:exec` and `--allow-addons`. The env gate lives in the caller
   * (`activateViaWorker`), so this always computes when called.
   *
   * Fork-time `${worktree}` limitation: the flags are fixed at fork and the
   * `${worktree}` token resolves against whichever worktree is current now — so a
   * static flag set reflects only the fork-time worktree and would go stale on a
   * worktree switch (no worker restart). `${project}` (main worktree) is stable.
   * Documented as a known limitation of the prototype, not solved here.
   */
  private async buildWorkerPermissionExecArgv(
    pluginId: string,
    plugin: LoadedPlugin
  ): Promise<string[]> {
    const capabilities = plugin.manifest.capabilities ?? [];
    const { allowChildProcess, allowNativeAddons } =
      derivePluginPermissionCapabilities(capabilities);

    const entries = await this.expandAllowedPathEntries(pluginId, { includeDataDir: true });
    const { readPaths, writePaths } = classifyPluginPermissionPaths(
      entries,
      capabilities,
      plugin.dir
    );

    return buildPluginPermissionExecArgv({
      readPaths,
      writePaths,
      allowChildProcess,
      allowNativeAddons,
    });
  }

  /**
   * Expand the plugin's declared `scopes.fs.allowedPaths` into concrete,
   * capability-classified roots at call time. `${project}` / `${worktree}`
   * tokens resolve against the live worktree snapshots — fail-closed: a token
   * with no matching live worktree contributes NO root (it is dropped, never
   * resolved to a fallback or empty path that could widen scope — #9492), so a
   * path that only that token would have matched is still rejected by
   * containment. Dropping just the unresolvable entry (rather than aborting the
   * whole expansion) preserves the always-on data dir and any literal / other
   * resolvable token roots. When `includeDataDir`, the implicit per-plugin data
   * dir is prepended as a `user-data` root so every plugin always has a private
   * scratch space. Literal absolute paths are classified by home-dir membership.
   *
   * The caller is responsible for `requireLoaded()` re-checks around the await
   * (the plugin may unload mid-call — #9533).
   */
  private async expandAllowedPathEntries(
    pluginId: string,
    opts: { includeDataDir: boolean }
  ): Promise<ExpandedFsPath[]> {
    const declared = this.declaredAllowedPaths(pluginId);
    const needsSnapshots = declared.some(
      (entry) => entry.startsWith("${project}") || entry.startsWith("${worktree}")
    );
    const snapshots = needsSnapshots ? await this.allowedPathSnapshots(pluginId) : [];

    const entries: ExpandedFsPath[] = [];
    if (opts.includeDataDir) {
      entries.push({ path: this.pluginDataDir(pluginId), rootClass: "user-data" });
    }
    // A declared list replaces this default rather than extending it.
    if (declared.length === 0) {
      const implicit = this.implicitProjectRoot(pluginId);
      if (implicit) entries.push(implicit);
    }
    for (const raw of declared) {
      try {
        entries.push(this.expandAllowedPathEntry(pluginId, raw, snapshots));
      } catch (err) {
        // Fail-closed on a token with no live worktree: drop just that entry
        // (it contributes no root, so a path that only matched it is still
        // rejected by containment) rather than discarding the whole list — the
        // implicit data dir and any literal/other-token roots stay usable.
        if (err instanceof PluginPathNotAllowedError) continue;
        throw err;
      }
    }
    return entries;
  }

  /**
   * The worktree set a plugin's `${project}` / `${worktree}` tokens expand against.
   *
   * A bound plugin gets its own project's worktrees. Resolving these from the
   * focused window instead would let a project plugin's declared filesystem
   * roots follow whichever project the user happened to be looking at — the
   * confused deputy the binding exists to prevent, and the one place the
   * containment allowlist itself would have leaked.
   *
   * Unbound stays ambient on purpose: an installed or builtin plugin has no
   * project of its own, so every open project's worktrees are the only thing
   * its tokens can mean. A bound-but-rootless binding is malformed and expands
   * to nothing, which drops the token entries and leaves containment closed.
   */
  private async allowedPathSnapshots(pluginId: string): Promise<WorktreeSnapshot[]> {
    const binding = this.plugins.get(pluginId)?.binding;
    if (!binding || binding.projectId === null) return this.fetchAllWorktreeSnapshots();
    if (binding.projectRoot === null) return [];
    return this.fetchWorktreeSnapshotsForProject(binding.projectId, binding.projectRoot);
  }

  /**
   * Expand a single `allowedPaths` entry (token or literal) into a typed root.
   */
  private expandAllowedPathEntry(
    pluginId: string,
    raw: string,
    snapshots: readonly WorktreeSnapshot[]
  ): ExpandedFsPath {
    const token = raw.startsWith("${worktree}")
      ? "worktree"
      : raw.startsWith("${project}")
        ? "project"
        : null;
    if (token === null) {
      // Literal absolute path: a path under the user's home dir is user-data
      // class; anything else (project trees, system paths) is project class.
      return {
        path: raw,
        rootClass: this.isPathUnder(os.homedir(), raw) ? "user-data" : "project",
      };
    }
    const base =
      token === "worktree"
        ? snapshots.find((s) => s.isCurrent === true)?.path
        : snapshots.find((s) => s.isMainWorktree === true)?.path;
    if (typeof base !== "string" || base.length === 0) {
      throw new PluginPathNotAllowedError(pluginId, raw);
    }
    const suffix = raw.slice(`\${${token}}`.length);
    return { path: suffix.length > 0 ? path.join(base, suffix) : base, rootClass: "project" };
  }

  /**
   * Worktree snapshots for the project the plugin is acting on behalf of.
   *
   * The host APIs this feeds (`getActiveWorktree` / `getWorktrees` /
   * `getWorktreeStatus`, plus worktree-scoped storage, `${worktree}`/`${project}`
   * allowlist roots and the `process.spawn` cwd default) hang off a single
   * long-lived closure per plugin — `createHost()` runs once at activation and
   * its methods take no arguments — so there is no per-call sender to key off.
   * Scoping to the focused window is the only resolution structurally available
   * without redesigning the utility-process RPC bridge, which #11297 does not
   * ask for. It is genuinely weaker than a real per-invocation context: a plugin
   * acting from a timer observes whichever project is focused *then*, not the
   * one it was invoked from.
   *
   * Returns `[]` when no window resolves rather than falling back to the
   * cross-project aggregate. This is not merely narrowing — the selected root
   * can change from one project to another, which is the point — but the empty
   * case fails closed: `getActiveWorktree` → `null`, worktree storage → no
   * target, and token-rooted allowlist entries drop so containment denies
   * (#9492). An aggregate would instead answer confidently with an arbitrary
   * project's worktree, which is exactly the bug being fixed.
   */
  private async fetchAllWorktreeSnapshots(): Promise<WorktreeSnapshot[]> {
    const result = await this.fetchAllWorktreeSnapshotsResult();
    return result.status === "ok" ? result.snapshots : [];
  }

  /**
   * {@link fetchAllWorktreeSnapshots} keeping the reason it has nothing and the
   * project the snapshots belong to (#12174), for `host.getWorktreesResult()`.
   *
   * Every branch that flattens to `[]` above maps to a distinct `reason` here.
   * Nothing about the containment posture changes: this still never widens to
   * the cross-project aggregate, and the array-shaped read above is unchanged
   * for storage, `${worktree}`/`${project}` allowlist roots and the spawn cwd —
   * they keep failing closed on an empty list rather than learning a new shape.
   */
  private async fetchAllWorktreeSnapshotsResult(): Promise<PluginWorktreeSnapshotFetchResult> {
    const client = this.workspaceClient;
    if (!client) return { status: "unavailable", reason: "workspace-unavailable" };
    try {
      // Inside the try: scope resolution walks the live window/view registries,
      // and a throw there must degrade like any other failed read rather than
      // reject into a plugin's timer.
      const windowId = this.resolveScopeWindowId();
      if (windowId === undefined) return { status: "unavailable", reason: "scope-unresolved" };
      const result = await client.getAllStatesResultAsync(windowId);
      return result.status === "ok"
        ? { status: "ok", projectId: result.projectId, snapshots: result.states }
        : { status: "unavailable", reason: result.reason };
    } catch (err) {
      console.error("[PluginService] Failed to fetch worktree snapshots:", err);
      return { status: "unavailable", reason: "fetch-failed" };
    }
  }

  /**
   * Worktree snapshots for one named project — the read behind every worktree
   * surface of a project-bound host.
   *
   * Unlike {@link fetchAllWorktreeSnapshots} this consults no window and no
   * focus: the binding names the project, and the workspace-host pool is keyed
   * by project path, so the answer is the same whichever project the user is
   * looking at. `expectedProjectId` guards the path→id race, so a folder
   * reopened as a different project answers `[]` rather than the new project's
   * worktrees.
   *
   * Once the project closes its pool entry is gone and this resolves `[]`,
   * degrading the bound host exactly like an unloaded one (`getActiveWorktree`
   * → `null`, `getWorktrees` → `[]`) instead of throwing into a stray timer.
   */
  private async fetchWorktreeSnapshotsForProject(
    projectId: string,
    projectRoot: string
  ): Promise<WorktreeSnapshot[]> {
    const result = await this.fetchWorktreeSnapshotsForProjectResult(projectId, projectRoot);
    return result.status === "ok" ? result.snapshots : [];
  }

  /**
   * {@link fetchWorktreeSnapshotsForProject} keeping the reason it has nothing
   * (#12174). A closed project — pool entry gone, or the path reopened as a
   * different project so `expectedProjectId` no longer matches — reports
   * `project-unavailable` instead of the `[]` a live project with no worktrees
   * returns, which is the whole distinction the plugin side was missing.
   */
  private async fetchWorktreeSnapshotsForProjectResult(
    projectId: string,
    projectRoot: string
  ): Promise<PluginWorktreeSnapshotFetchResult> {
    const client = this.workspaceClient;
    if (!client) return { status: "unavailable", reason: "workspace-unavailable" };
    try {
      const result = await client.getAllStatesForProjectResultAsync(projectRoot, projectId);
      return result.status === "ok"
        ? { status: "ok", projectId: result.projectId, snapshots: result.states }
        : { status: "unavailable", reason: result.reason };
    } catch (err) {
      console.error(
        `[PluginService] Failed to fetch worktree snapshots for project ${projectId}:`,
        err
      );
      return { status: "unavailable", reason: "fetch-failed" };
    }
  }

  /**
   * A project's custom worktree titles for the plugin projection (#14022). A
   * store that cannot be read costs the titles, never the worktree read.
   */
  private readWorktreeCustomTitles(projectId: string): Readonly<Record<string, string>> {
    try {
      return getWorktreeCustomTitles(projectId).titles;
    } catch (err) {
      console.error(
        `[PluginService] Failed to read custom worktree titles for project ${projectId}:`,
        err
      );
      return {};
    }
  }

  /**
   * The BrowserWindow id whose visible project the plugin is acting on, or
   * `undefined` when none resolves. Uses the dispatcher's strict scope resolver,
   * not its dispatch-targeting one — the latter scans every window in insertion
   * order, which would reintroduce "some other project's worktree" here.
   */
  private resolveScopeWindowId(): number | undefined {
    const webContents = this.dispatcher.resolveScopeWebContents();
    if (!webContents) return undefined;
    return getWindowForWebContents(webContents)?.id;
  }

  /**
   * The active worktree id for a specific window, for `plugin:invoke`'s IPC
   * context (#11297). Unlike {@link fetchAllWorktreeSnapshots} this is
   * sender-precise: the IPC handler has the real invoking `webContents`, so it
   * resolves the window that actually made the call rather than the focused
   * one. The asymmetry is deliberate — use real sender scope wherever one
   * exists.
   *
   * Returns `null` for an unresolved window instead of widening to the
   * cross-project aggregate, and swallows lookup failures: this sits on the
   * critical path of every plugin invocation, so a wedged or crashed workspace
   * host must degrade the context rather than fail the invoke.
   */
  async getActiveWorktreeIdForWindow(windowId: number | undefined): Promise<string | null> {
    const client = this.workspaceClient;
    if (!client || windowId === undefined) return null;
    try {
      const snapshots = await client.getAllStatesAsync(windowId);
      return snapshots.find((s) => s.isCurrent === true)?.id ?? null;
    } catch (err) {
      console.error("[PluginService] Failed to resolve active worktree for window:", err);
      return null;
    }
  }

  /**
   * Renderer-facing companion to the per-plugin `host.getWorktreeStatus`: the
   * changed-file / git-status projection for the worktree at `path`, read off
   * the host's already-polled status (no extra shell-out). `null` when no
   * worktree matches. Used by `plugin:worktree-status-get` so a file list
   * outside the Review Hub can scan the changed set.
   */
  async getWorktreeStatusForPath(path: string): Promise<PluginWorktreeStatus | null> {
    if (typeof path !== "string" || path.length === 0) return null;
    const snapshots = await this.fetchAllWorktreeSnapshots();
    const match = snapshots.find((s) => s.path === path);
    return match ? toPluginWorktreeStatus(match.worktreeChanges) : null;
  }

  /**
   * Register a listener on WorkspaceClient for the given event and track it
   * against the plugin so `unloadPlugin()` can dispose it. Returns a disposer
   * that removes just this subscription; safe to call multiple times.
   *
   * Tracked as one of the plugin's live subscriptions, so it keeps the
   * plugin's worker from being disposed while idle. See
   * {@link attachWorktreeEvent} for the untracked listener underneath.
   */
  private subscribeWorktreeEvent(
    pluginId: string,
    event: WorkspaceWorktreeEvent,
    handler: (payload?: PluginWorktreeEventPayload) => void
  ): () => void {
    const detach = this.attachWorktreeEvent(pluginId, event, handler);
    let disposed = false;

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      detach();
      const list = this.pluginEventCleanups.get(pluginId);
      if (!list) return;
      const idx = list.indexOf(dispose);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.pluginEventCleanups.delete(pluginId);
    };

    let list = this.pluginEventCleanups.get(pluginId);
    if (!list) {
      list = [];
      this.pluginEventCleanups.set(pluginId, list);
    }
    list.push(dispose);
    return dispose;
  }

  /**
   * Listen on WorkspaceClient for the given event without recording a live
   * subscription for the plugin — what a manifest event route needs, since a
   * route must not keep the worker from idle disposal (#13816). The caller owns
   * the returned detach, which is safe to call more than once.
   *
   * If WorkspaceClient is not yet wired (early boot), the listener is queued in
   * `pendingWorktreeSubs` and attached when `setWorkspaceClient()` is later
   * called. The detach handles both the queued and the live state.
   */
  private attachWorktreeEvent(
    pluginId: string,
    event: WorkspaceWorktreeEvent,
    handler: (payload?: PluginWorktreeEventPayload) => void
  ): () => void {
    let boundClient: WorkspaceClient | null = null;
    let pendingRecord: (typeof this.pendingWorktreeSubs)[number] | null = null;
    let detached = false;

    const client = this.workspaceClient;
    if (client) {
      client.on(event, handler);
      boundClient = client;
    } else {
      pendingRecord = {
        pluginId,
        event,
        handler,
        activate: (c: WorkspaceClient) => {
          if (detached) return;
          c.on(event, handler);
          boundClient = c;
          pendingRecord = null;
        },
      };
      this.pendingWorktreeSubs.push(pendingRecord);
    }

    return () => {
      if (detached) return;
      detached = true;
      if (boundClient) {
        boundClient.off(event, handler);
      } else if (pendingRecord) {
        const idx = this.pendingWorktreeSubs.indexOf(pendingRecord);
        if (idx >= 0) this.pendingWorktreeSubs.splice(idx, 1);
      }
    };
  }

  /**
   * Run a built-in plugin's `activate(host)` bounded by a timeout so a hanging
   * activate can't stall the host. Used only for the in-process built-in path;
   * user plugins activate in the worker (see {@link activateViaWorker}).
   */
  private async runActivate(
    pluginId: string,
    activate: PluginActivate,
    host: PluginHostApi
  ): Promise<void | (() => void)> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => activate(host)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(`Plugin "${pluginId}" activate() timed out after ${ACTIVATE_TIMEOUT_MS}ms`)
            );
          }, ACTIVATE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Realpath containment, matching the `plugin://` protocol handler: resolve
   * symlinks on BOTH ends before comparing, so a link that sits inside the root
   * but points outside it is rejected. Returns false when either side cannot be
   * resolved — a path we cannot canonicalise is a path we do not execute.
   */
  private async isRealpathContained(root: string, candidate: string): Promise<boolean> {
    try {
      const realRoot = await fs.realpath(root);
      const realCandidate = await fs.realpath(candidate);
      return this.isPathUnder(realRoot, realCandidate);
    } catch {
      return false;
    }
  }

  private resolveEntryPath(pluginDir: string, relativePath: string): string | null {
    const resolved = path.resolve(pluginDir, relativePath);
    const normalizedDir = path.normalize(pluginDir) + path.sep;
    if (!resolved.startsWith(normalizedDir) && resolved !== path.normalize(pluginDir)) {
      return null;
    }
    return resolved;
  }

  hasPlugin(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /** Whether the plugin is loaded and its latest activation succeeded. */
  isPluginActivated(pluginId: string): boolean {
    return this.activatedPlugins.has(pluginId);
  }

  /**
   * What "Back up data…" needs to find a loaded plugin's databases, read from
   * the host's own manifest and binding so a caller can name nothing but the
   * plugin. Null when the plugin is not loaded.
   */
  getDataBackupSource(pluginId: string): PluginDataBackupSource | null {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return null;
    return {
      manifestId: plugin.manifest.name,
      displayName: plugin.manifest.displayName ?? plugin.manifest.name,
      declarations: plugin.manifest.contributes.databases ?? [],
      projectRoot: plugin.binding?.projectRoot ?? null,
      dataDir: this.pluginDataDir(pluginId),
    };
  }

  /**
   * The managed plugins directory this instance discovers user plugins from.
   * Public because tests and the packaging flow construct the service with a
   * temp root, so callers that need to reason about that root (the manifest
   * validation handler's containment check) must read the live value rather
   * than recompute the default.
   */
  getPluginsRoot(): string {
    return this.pluginsRoot;
  }

  registerHandler<TArgs, TResult>(
    pluginId: string,
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>
  ): void;
  registerHandler(pluginId: string, channel: string, handler: PluginIpcHandler): void;
  registerHandler(
    pluginId: string,
    channel: string,
    schemaOrHandler:
      | PluginChannelSchema<unknown, unknown>
      | PluginIpcHandler
      | PluginTypedIpcHandler<unknown, unknown>,
    typedHandler?: PluginTypedIpcHandler<unknown, unknown>
  ): void {
    (this.channels.register as (...args: unknown[]) => void)(
      pluginId,
      channel,
      schemaOrHandler,
      typedHandler
    );
  }

  async dispatchHandler(
    pluginId: string,
    channel: string,
    ctx: PluginIpcContext,
    args: unknown[]
  ): Promise<unknown> {
    // Metered here rather than from the audit log, which can be disabled and is
    // capped. Timed from after activation: a cold start is recorded as the
    // activation it is, not as a slow first invoke.
    // `promptMark` is taken with `handlerStart`, after activation: a prompt
    // the plugin raised while activating did not overlap the handler.
    const timing: { handlerStart: number; promptMark?: InvokePromptMark } = {
      handlerStart: Number.NaN,
    };
    // A call that outlives an unload+reload of the id describes the old
    // generation; it must not land in the replacement's fresh entry.
    const generation = this.plugins.get(pluginId);
    const sameGeneration = (): boolean =>
      generation !== undefined && this.plugins.get(pluginId) === generation;
    try {
      const result = await this.dispatchHandlerOnHost(pluginId, channel, ctx, args, timing);
      if (sameGeneration()) {
        this.metrics.recordInvoke(
          pluginId,
          performance.now() - timing.handlerStart,
          "ok",
          timing.promptMark
        );
      }
      return result;
    } catch (err) {
      if (!Number.isNaN(timing.handlerStart) && sameGeneration()) {
        this.metrics.recordInvoke(
          pluginId,
          performance.now() - timing.handlerStart,
          classifyInvokeFailure(err),
          timing.promptMark
        );
      }
      throw err;
    }
  }

  private async dispatchHandlerOnHost(
    pluginId: string,
    channel: string,
    ctx: PluginIpcContext,
    args: unknown[],
    timing: { handlerStart: number; promptMark?: InvokePromptMark }
  ): Promise<unknown> {
    if (ctx.origin?.kind !== "remote")
      return this.dispatchHandlerUnmetered(pluginId, channel, ctx, args, timing);
    // A window on another machine may still show a plugin this host has since
    // removed. It is told so in a form it can build its placeholder from, both
    // up front and for a call the removal cut short.
    if (!this.plugins.has(pluginId)) throw new PluginNotOnHostInvokeError(pluginId, channel);
    try {
      return await this.dispatchHandlerUnmetered(pluginId, channel, ctx, args, timing);
    } catch (err) {
      if (this.plugins.has(pluginId)) throw err;
      // A handler that was running when its plugin went is audited already;
      // a call cut off before reaching one is an ownership refusal, as ever.
      if (!isAuditedHandlerFailure(err)) throw new PluginNotOnHostInvokeError(pluginId, channel);
      const typed = pluginNotOnHostError(pluginId);
      markAuditedHandlerFailure(typed);
      throw typed;
    }
  }

  private async dispatchHandlerUnmetered(
    pluginId: string,
    channel: string,
    ctx: PluginIpcContext,
    args: unknown[],
    timing: { handlerStart: number; promptMark?: InvokePromptMark }
  ): Promise<unknown> {
    // Ownership guard (#10462): the renderer is a single shared WebContents in
    // which every plugin runs in the same realm, so a caller can pass an
    // arbitrary `pluginId`. Reject any id the host has not actually loaded
    // before activation or routing — this is the boundary's only achievable
    // ownership guarantee given that shared realm. It lives here, in the single
    // chokepoint every plugin:invoke flows through, rather than in the IPC
    // handler, so no current or future caller of `dispatchHandler` can reach a
    // handler for an unloaded plugin (dev-worker channels are dispatched here
    // too, via their `host.registerHandler` registrations).
    if (!this.plugins.has(pluginId)) {
      throw new PluginInvokeOwnershipError(pluginId, channel);
    }
    // Runs are tracked against the load that admitted this dispatch, so one
    // that outlives an unload (or a reload) during the awaits below is not.
    const generation = this.plugins.get(pluginId);

    // Start the clock before activation so a failure record carries the full
    // dispatch cost (cold activation included) the renderer actually waited on.
    const dispatchStart = Date.now();
    // Implicit activation: the first dispatch into a plugin's channel forces
    // its `activate()` to run if it hasn't yet, so handlers registered during
    // activation are available on the very first call. No-op once activated.
    await this.activatePlugin(pluginId);
    timing.handlerStart = performance.now();
    // A handler awaiting the user's answer to a prompt is not slow; the mark
    // lets the metrics keep such a call out of the latency stats.
    timing.promptMark = this.metrics.markInvokeStart(pluginId);

    const key = `${pluginId}:${channel}`;
    const descriptor = this.pluginActions.get(channel);
    // Main-side action handlers (host.registerAction) are addressed by the
    // namespaced action id and take precedence over a channel-keyed IPC
    // handler. Only honour one the dispatching plugin owns — the namespace
    // already guarantees this, and the guard mirrors the input-schema check.
    let actionHandler =
      descriptor?.pluginId === pluginId ? this.pluginActionHandlers.get(channel) : undefined;
    // Read now, before any await: a re-registration while this call runs must
    // not hold its result to a contract it didn't start under.
    const resultCheck =
      descriptor?.pluginId === pluginId ? this.actionResultChecks.get(descriptor) : undefined;
    const handler = this.channels.getHandler(key);
    // Manifest-declared command (#9281): descriptor registered at load time,
    // handler module deferred until first dispatch. Lazy-load now, then fall
    // through to the existing action-handler dispatch path. A missing handler
    // file throws the documented `Command "{id}" has no handler` toast; a
    // bad default export throws a separate diagnostic — both surface via the
    // renderer's `usePluginActions` rejection wrapper. Imperative-only
    // descriptors (from `host.registerAction` without a manifest entry)
    // already have a handler in `pluginActionHandlers`, so they short-circuit
    // on the first check above and never enter this branch.
    if (
      !actionHandler &&
      descriptor?.pluginId === pluginId &&
      this.manifestCommandIds.has(channel)
    ) {
      actionHandler = await this.loadManifestCommandHandler(channel);
    }
    if (!actionHandler && !handler) {
      throw new Error(`No plugin handler registered for ${key}`);
    }

    if (descriptor?.inputSchema && descriptor.pluginId === pluginId) {
      let validator = this.actionValidators.get(channel);
      if (!validator) {
        if (!this.ajv) {
          this.ajv = new Ajv();
          addFormats(this.ajv);
        }
        validator = this.ajv.compile(descriptor.inputSchema);
        if (validator.$async) {
          throw new Error(
            `Plugin action "${channel}" has an async schema ($async) which is not supported`
          );
        }
        this.actionValidators.set(channel, validator);
      }
      const argsObj = args.length > 0 ? args[0] : {};
      if (!validator(argsObj)) {
        const details = validator.errors
          ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
          .join("; ");
        throw new Error(
          `Invalid arguments for plugin action "${channel}": ${details ?? "unknown error"}`
        );
      }
    }

    // A main-side action handler receives the args payload only — no IPC ctx,
    // per the ActionHandler contract. The renderer's synthetic action forwards
    // a single args object; default to `{}` when called with none so the
    // handler sees the same value the input-schema validation accepted above
    // (which also defaults the empty case to `{}`).
    if (actionHandler) {
      let actionResult: unknown;
      const endRun = this.beginActionRun(pluginId, channel, generation);
      try {
        actionResult = await actionHandler(args.length > 0 ? args[0] : {});
      } catch (err) {
        // Contain at the boundary so a throwing handler can't propagate up
        // through `ipcMain.handle` as an unhandled rejection. The error still
        // surfaces to the renderer (rethrown after logging).
        //
        // Hint first, so the audit record and the renderer's toast both carry
        // it — the failure this catches most often is a signature mistake the
        // plugin's own stack trace cannot name (#12214).
        appendHandlerHint(err, actionHandlerArityHint(actionHandler, err));
        console.error(`[PluginService] Action handler "${channel}" threw:`, err);
        // Audit at the dispatch boundary (#10463) so non-IPC callers (agent
        // automation, recipe dispatch) leave the same durable trail as a
        // `plugin:invoke` call. Mark the error so the outer `plugin:invoke`
        // catch doesn't record it a second time.
        safeAppendAudit({
          pluginId,
          actionId: channel,
          recordType: "action-dispatch",
          result: "error",
          errorMessage: formatErrorMessage(err, "plugin action handler threw"),
          argsHash: safeArgsHash(args),
          durationMs: Date.now() - dispatchStart,
        });
        markAuditedHandlerFailure(err);
        throw err;
      } finally {
        endRun();
      }
      // Size-checked before the success audit: an oversize result is a failed
      // dispatch, which the outer plugin:invoke catch records.
      assertPayloadWithinLimit(
        pluginId,
        `result of "${channel}"`,
        actionResult,
        PLUGIN_INVOKE_MAX_RESULT_BYTES
      );
      // Like the size check, a failed dispatch the outer catch records.
      actionResult = enforcePluginActionResult(
        pluginId,
        channel,
        resultCheck,
        actionResult,
        PLUGIN_INVOKE_MAX_RESULT_BYTES
      );
      // Audit the success path too (#10517). A plugin calling its own
      // registered action handler from its view must leave the same durable
      // trail on success as on failure — otherwise a benign-looking action can
      // run unobserved while only its failures are recorded.
      safeAppendAudit({
        pluginId,
        actionId: channel,
        recordType: "action-dispatch",
        result: "success",
        errorMessage: "",
        argsHash: safeArgsHash(args),
        durationMs: Date.now() - dispatchStart,
      });
      return actionResult;
    }

    if (!handler) {
      throw new Error(`No plugin handler registered for ${key}`);
    }

    // Typed-channel path (registered via the schema overload of
    // `registerHandler`). The capability gate already fired at registration
    // — this re-check is defense-in-depth against a future code path that
    // mutates a loaded manifest after registration.
    const channelSchema = this.channels.getSchema(key);
    const channelRequires = this.channels.getRequires(key);
    if (channelRequires && channelRequires.length > 0) {
      const declared = new Set<BuiltInPluginCapability>(
        this.plugins.get(pluginId)?.manifest.capabilities ?? []
      );
      const missing = channelRequires.find((cap) => !declared.has(cap));
      if (missing) {
        throw new Error(
          `PERMISSION_REQUIRED: channel "${channel}" requires capability "${missing}" which is not declared in plugin "${pluginId}" manifest.capabilities`
        );
      }
    }

    let dispatchArgs: unknown[] = args;
    if (channelSchema) {
      const argsInput = args.length > 0 ? args[0] : undefined;
      const parsed = channelSchema.args.safeParse(argsInput);
      if (!parsed.success) {
        throw new Error(`SCHEMA_ERROR: ${z.prettifyError(parsed.error)}`);
      }
      // Replace the raw variadic with the parsed payload so the typed
      // adapter (and any downstream code) sees Zod's coerced/defaulted
      // output rather than the wire-shape input.
      dispatchArgs = [parsed.data];
    }

    let result: unknown;
    // An action may be backed by a channel handler registered under its id.
    const endRun =
      descriptor?.pluginId === pluginId
        ? this.beginActionRun(pluginId, channel, generation)
        : () => {};
    try {
      result = await handler(ctx, ...dispatchArgs);
    } catch (err) {
      // Contain at the boundary so a throwing plugin handler can't propagate
      // up through `ipcMain.handle` as an unhandled rejection in the main
      // process. The error still surfaces to the renderer (we rethrow after
      // logging) — the renderer-side wrapping in `usePluginActions` turns
      // that rejection into a user-facing toast.
      //
      // Only the legacy path is hinted (#12214). A typed registration is stored
      // as the `(ctx, ...args)` adapter above, whose declared arity is 1 for a
      // reason that has nothing to do with the author's own signature — hinting
      // on it would accuse every typed handler of a mistake it did not make.
      if (!channelSchema) {
        appendHandlerHint(err, channelHandlerArityHint(handler, err));
      }
      console.error(`[PluginService] Handler "${key}" threw:`, err);
      // Audit at the dispatch boundary (#10463). `channel` carries the plugin
      // channel string that failed (the IPC transport is always plugin:invoke);
      // mark the error so the outer `plugin:invoke` catch doesn't double-record.
      safeAppendAudit({
        pluginId,
        actionId: channel,
        recordType: "ipc-invoke",
        channel,
        result: "error",
        errorMessage: formatErrorMessage(err, "plugin IPC handler threw"),
        argsHash: safeArgsHash(args),
        durationMs: Date.now() - dispatchStart,
      });
      markAuditedHandlerFailure(err);
      throw err;
    } finally {
      endRun();
    }

    let finalResult: unknown = result;
    if (channelSchema) {
      const parsedResult = channelSchema.result.safeParse(result);
      if (!parsedResult.success) {
        throw new Error(
          `SCHEMA_ERROR: result for channel "${channel}" failed validation: ${z.prettifyError(parsedResult.error)}`
        );
      }
      finalResult = parsedResult.data;
    }
    assertPayloadWithinLimit(
      pluginId,
      `result of "${channel}"`,
      finalResult,
      PLUGIN_INVOKE_MAX_RESULT_BYTES
    );
    // A channel handler registered under an action's id is that action's
    // implementation, so its result answers to the action's contract too.
    finalResult = enforcePluginActionResult(
      pluginId,
      channel,
      resultCheck,
      finalResult,
      PLUGIN_INVOKE_MAX_RESULT_BYTES
    );

    // Audit the success path too (#10517). The catch above records IPC-handler
    // failures; without this, a plugin invoking its own registered handler via
    // `plugin:invoke` runs with zero audit trail on success. Recorded only once
    // the dispatch will truly return (after result-schema validation), so a
    // host-side schema rejection isn't logged as a success.
    safeAppendAudit({
      pluginId,
      actionId: channel,
      recordType: "ipc-invoke",
      channel,
      result: "success",
      errorMessage: "",
      argsHash: safeArgsHash(args),
      durationMs: Date.now() - dispatchStart,
    });
    return finalResult;
  }

  removeHandlers(pluginId: string): void {
    this.channels.removeHandlers(pluginId);
  }

  /**
   * Atomically install a plugin from a `.dntr` archive path or a pre-extracted
   * directory. This is the ONLY path that mutates {@link pluginsRoot} — direct
   * IPC writes to the plugins directory are a review blocker (#9292). The full
   * lockfile/staging/swap/rollback orchestration lives in {@link PluginInstaller};
   * this thin delegate preserves the public signature IPC handlers call.
   */
  async installPlugin(
    archivePath: string,
    opts?: PluginInstallOptions
  ): Promise<PluginInstallResult> {
    return this.installer.installPlugin(archivePath, opts);
  }

  /**
   * This machine's installed plugins, for another machine to compare with its
   * own. Only reads; nothing about either machine changes.
   */
  async getPluginInventory(options: { includeSecrets?: boolean } = {}): Promise<PluginInventory> {
    await this.waitForCatalog();
    return buildPluginInventory(this, {
      appVersion: this.appVersion,
      platform: process.platform,
      includeSecrets: options.includeSecrets === true,
    });
  }

  /**
   * Install a package another machine sent, through the normal install path.
   * Before anything reaches the plugins folder, its manifest is read from the
   * archive and refused if it has no build for this OS or the plugin
   * blocklist names this version; a package the load-time blocklist would
   * refuse is never copied into place. `pluginId` pins the package to the
   * plugin the person asked for, and `update` requires it to be installed
   * here already. Whether it may replace what is installed is decided inside
   * the installer's lock, against what is installed at that moment. `jobId`
   * is a job already registered for progress and cancellation.
   */
  async installPluginFromAnotherMachine(
    archivePath: string,
    expect: { pluginId?: string; update?: boolean; jobId?: string } = {}
  ): Promise<PluginInstallResult> {
    await this.waitForCatalog();
    let manifest: PluginManifest;
    try {
      manifest = await readArchiveManifest(archivePath);
    } catch (err) {
      return {
        status: "failed",
        errors: [{ code: "manifest_invalid", message: formatErrorMessage(err, "Invalid plugin") }],
      };
    }
    if (expect.pluginId !== undefined && manifest.name !== expect.pluginId) {
      return {
        status: "failed",
        errors: [
          {
            code: "archive_mismatch",
            message: `The package is for "${manifest.name}", not "${expect.pluginId}"`,
          },
        ],
      };
    }
    const blocklist = (await this.blocklistService.getBlocklist()) ?? this.startupBlocklist;
    const refusal = pluginInstallRefusal(manifest, { platform: process.platform, blocklist });
    const displayName = manifest.displayName?.trim() || manifest.name;
    if (refusal?.kind === "platform") {
      const hostPlatform = process.platform === "darwin" ? "darwin" : "linux";
      throw pluginIncompatibleError(
        manifest.name,
        {
          kind: "platform",
          hostPlatform,
          supported: refusal.supported.filter(
            (entry): entry is "darwin" | "linux" => entry === "darwin" || entry === "linux"
          ),
        },
        `${displayName} has no build for ${platformDisplayName(process.platform)}.`
      );
    }
    if (refusal?.kind === "blocklisted") {
      throw pluginIncompatibleError(
        manifest.name,
        { kind: "untrusted" },
        `${displayName} ${manifest.version} is blocked: ${refusal.message}`
      );
    }
    const target = { pluginId: expect.pluginId, update: expect.update };
    return this.installer.installPlugin(
      archivePath,
      { source: "sideload", ...(expect.jobId !== undefined ? { jobId: expect.jobId } : {}) },
      (installedVersion) => replacementRefusal(manifest, installedVersion, target)
    );
  }

  /**
   * The version installed under `pluginId`, whether it loaded, was skipped as
   * disabled, or was refused by the blocklist; null when none is.
   */
  private installedPluginVersion(pluginId: string): string | null {
    return this.installedPluginRecord(pluginId)?.manifest.version ?? null;
  }

  private installedPluginRecord(pluginId: string): { manifest: PluginManifest } | undefined {
    return (
      this.plugins.get(pluginId) ??
      this.disabledPlugins.get(pluginId) ??
      this.blockedPlugins.get(pluginId) ??
      this.projectInstancePackages.get(pluginId)
    );
  }

  /**
   * Manual update check (#9297). Re-fetches the plugin's `originalUrl`, hashes
   * the downloaded archive, and compares it against the installed `archiveHash`.
   * Purely informational — it never installs. Delegates to {@link PluginInstaller}.
   */
  async checkForUpdate(pluginId: string): Promise<PluginCheckUpdateResult> {
    return this.installer.checkForUpdate(pluginId);
  }

  /**
   * Load and activate a dev plugin the `daintree-plugin dev` CLI has already
   * symlinked into {@link pluginsRoot} and stamped with a `.dev-marker`. Called
   * over the CLI control socket (`plugin.dev.start`) once the first build is in
   * place. Reuses the standard {@link loadPlugin} path — the `.dev-marker`
   * detection there routes it through the hot-reload worker. The CLI owns the
   * symlink; this method only reads from `pluginsRoot`, so it doesn't touch the
   * installer's content-mutation invariant (#9292).
   *
   * Idempotent across dev sessions: if the plugin is already loaded (a prior
   * session that didn't clean up, or a crashed CLI), it's unloaded first so the
   * duplicate-name guard in {@link loadPlugin} doesn't reject the reload.
   */
  async loadDevPlugin(pluginId: string): Promise<void> {
    // The id becomes `path.join(pluginsRoot, pluginId)` in `loadPlugin`, so a
    // `../` segment would escape the plugins root and load an arbitrary
    // `plugin.json` (#10518) — reachable over the CLI control socket. Gate on
    // the same scoped-name pattern the uninstall path enforces before any
    // filesystem access.
    if (!SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) {
      throw new Error(`Invalid dev plugin id "${pluginId}" — expected a scoped "publisher.name"`);
    }
    // Queued behind any reconcile or stop for this plugin: a CLI restart sends
    // stop and start back to back, and a start that overtook the stop would be
    // undone by it.
    return this.serializeDevSession(pluginId, () => this.doLoadDevPlugin(pluginId));
  }

  private async doLoadDevPlugin(pluginId: string): Promise<void> {
    const replacing = this.plugins.has(pluginId);
    if (replacing) this.unloadPlugin(pluginId, { reload: true });
    try {
      // Honor the user's persisted disabled intent — the dev path must not be a
      // trust escape hatch that force-loads a plugin the user turned off (#10518).
      // A disabled id makes `loadPlugin` skip + return null, surfacing the clear
      // error below to the CLI caller rather than silently activating it.
      const loaded = await this.loadPlugin(this.pluginsRoot, pluginId, {
        isBuiltin: false,
        disabled: this.records.getDisabledIds(),
      });
      if (!loaded) {
        throw new Error(
          `Couldn't load dev plugin "${pluginId}" from ${this.pluginsRoot} — it may be disabled in Preferences, or the symlink/plugin.json may be invalid`
        );
      }
      await this.activatePlugin(pluginId);
    } finally {
      if (replacing) this.settlePluginReload(pluginId);
    }
  }

  // ----- `daintree-plugin dev` sessions (#12277) --------------------------

  private devArtifactWatcherRegistry: PluginDevArtifactWatcher | null = null;

  /**
   * Per-session state the watcher does not own. Its presence IS the session:
   * it outlives the plugin loads the session drives, so a reload that fails to
   * produce a loadable plugin still has somewhere to report why.
   */
  private devSessions = new Map<string, { reloadCount: number; detail: string | null }>();

  /** One dev operation at a time per plugin — reload, or the stop behind it. */
  private devSessionChains = new Map<string, Promise<void>>();

  /**
   * Nesting depth of in-flight plugin replacements. While non-zero the
   * contribution registries are mid-swap, so no snapshot taken from them is
   * authoritative — see the broadcaster's `isRegistryUnsettled` dep.
   */
  private devReplaceDepth = 0;

  private get devArtifactWatchers(): PluginDevArtifactWatcher {
    if (!this.devArtifactWatcherRegistry) {
      this.devArtifactWatcherRegistry = new PluginDevArtifactWatcher({
        reload: (pluginId) => this.reloadDevPlugin(pluginId),
        onStateChange: (pluginId) => this.emitRuntimeStatus(pluginId),
      });
    }
    return this.devArtifactWatcherRegistry;
  }

  /**
   * Start watching this plugin's artifact, or keep watching it. Idempotent:
   * the reconcile re-enters `loadPlugin`, which calls this again for the same
   * session.
   */
  private ensureDevSession(pluginId: string, pluginDir: string): void {
    if (this.disposed) return;
    if (!this.devSessions.has(pluginId)) {
      this.devSessions.set(pluginId, { reloadCount: 0, detail: null });
    }
    this.devArtifactWatchers.ensure(pluginId, pluginDir);
    this.emitRuntimeStatus(pluginId);
  }

  /**
   * End a dev session and unload its plugin (`plugin.dev.stop`).
   *
   * The watcher is stopped BEFORE the queue is joined, so no further rebuild
   * can queue work behind the unload; the unload itself goes through the chain
   * so it lands after any reconcile already in flight rather than racing it.
   */
  async stopDevSession(pluginId: string): Promise<void> {
    this.devArtifactWatcherRegistry?.stop(pluginId);
    await this.serializeDevSession(pluginId, async () => {
      // Stopped a second time, deliberately. A reconcile already in flight when
      // the first stop landed re-enters `loadPlugin`, which re-arms the session
      // through `ensureDevSession` — so without this the queued teardown would
      // unload the plugin and leave that replacement subscription watching a
      // session nobody owns.
      this.devArtifactWatcherRegistry?.stop(pluginId);
      const had = this.devSessions.delete(pluginId);
      this.unloadPlugin(pluginId);
      if (had) this.emitRuntimeStatus(pluginId);
    });
  }

  // ----- instance runtime health (#12278) ---------------------------------

  /**
   * Last published worker lifecycle per plugin instance. Deliberately keyed
   * independently of {@link pluginWorkers}: a FAILED worker's entry is torn
   * down immediately (crash loop, protocol violation), and dropping the status
   * with it would erase the only account of why a mounted panel went dark. The
   * status is removed by {@link unloadPlugin}, when the instance genuinely
   * leaves the inventory.
   */
  private workerStatuses = new Map<string, PluginWorkerStatus>();

  /**
   * Monotonic worker-process id. Bumped for every fork — including the crash
   * supervisor's own respawns, which `PluginService` never initiates — so a
   * panel can tell "my backend was replaced" from "my backend is the one I
   * mounted against". Distinct from `viewGeneration`, which counts published
   * module URLs and does not move when only the backend is swapped.
   */
  private workerGenerationSeq = 0;

  /** In-flight restarts, keyed by instance. Two panels of one plugin await one. */
  private workerRestarts = new Map<string, Promise<void>>();

  /**
   * When each instance last had a `host.restartWorker()` accepted (#13410).
   * Keyed by id, not by worker, so the cooldown outlives the restart it
   * triggered — a fresh worker that asks again at once is refused — and goes
   * only with a full unload.
   */
  private workerSelfRestartAt = new Map<string, number>();
  /** Self-restarts accepted but not yet started, so an unload can drop them. */
  private scheduledWorkerSelfRestarts = new Map<string, ReturnType<typeof setImmediate>>();

  /**
   * Record a worker lifecycle transition and publish it.
   *
   * `failed` latches against `stopped`: the teardown that FOLLOWS a terminal
   * failure (`onTerminalFailure` calls `deactivateWorker`) must not overwrite
   * the cause with the bland "deactivated" that ordinary idle disposal writes.
   * Every other transition wins, so a restart's `starting` clears the failure.
   */
  private setWorkerStatus(
    pluginId: string,
    state: PluginWorkerState,
    reason: PluginWorkerReason | null,
    detail: string | null,
    opts?: { newGeneration?: boolean }
  ): void {
    const prior = this.workerStatuses.get(pluginId);
    if (state === "stopped" && prior?.state === "failed") return;
    const generation = opts?.newGeneration
      ? ++this.workerGenerationSeq
      : (prior?.generation ?? ++this.workerGenerationSeq);
    // A repeat of the same state under the same generation is not a transition;
    // publishing it would remount every panel watching the generation.
    if (
      prior &&
      prior.state === state &&
      prior.generation === generation &&
      prior.reason === reason &&
      prior.detail === detail
    ) {
      return;
    }
    this.workerStatuses.set(pluginId, {
      generation,
      state,
      stateSince: Date.now(),
      reason,
      detail,
    });
    this.emitRuntimeStatus(pluginId);

    // A crash reports as `starting` + `crashed` while the supervisor decides
    // whether to respawn, so it warns alongside an outright failure.
    const abnormal = state === "failed" || reason === "crashed";
    this.writePluginFileLog(
      pluginId,
      "lifecycle",
      "Plugin worker state changed",
      {
        state,
        previousState: prior?.state ?? null,
        generation,
        ...(reason ? { reason } : {}),
        // Detail can carry the plugin's own activation error text.
        ...(detail ? { detail: boundPluginFileLogText(detail) } : {}),
      },
      abnormal ? "warn" : "info"
    );
  }

  /**
   * Subscribe to one worker host's lifecycle for the life of `entry`.
   *
   * Every handler identity-guards on the captured entry rather than checking
   * presence: a replacement worker registered under the same plugin id must
   * never be described by its predecessor's late events (#10899). Returns the
   * detach function, which the entry's cleanup runs.
   */
  private watchWorkerHealth(
    pluginId: string,
    entry: { workerHost: PluginDevWorkerHost }
  ): () => void {
    const isCurrent = (): boolean => this.pluginWorkers.get(pluginId) === entry;
    const onReady = (): void => {
      if (!isCurrent()) return;
      this.setWorkerStatus(pluginId, "activating", null, null);
    };
    const onExit = (code: number, expected: boolean): void => {
      if (!isCurrent() || expected) return;
      // The supervisor decides a tick later whether to respawn or trip the cap,
      // so this is optimistic by design: `starting` is what the shell renders as
      // "Reloading", and a crash-loop verdict overwrites it with `failed` before
      // the user could act on it.
      this.setWorkerStatus(pluginId, "starting", "crashed", `Worker exited (code ${code})`, {
        newGeneration: true,
      });
    };
    const onCrashLoop = (code: number): void => {
      if (!isCurrent()) return;
      this.setWorkerStatus(
        pluginId,
        "failed",
        "crash-loop",
        `Worker crashed repeatedly (code ${code}) and will not be restarted automatically`
      );
    };
    const onProtocolViolation = (reason: string): void => {
      if (!isCurrent()) return;
      this.setWorkerStatus(pluginId, "failed", "protocol-violation", reason);
    };
    entry.workerHost.on("ready", onReady);
    entry.workerHost.on("exit", onExit);
    entry.workerHost.on("crash-loop", onCrashLoop);
    entry.workerHost.on("protocol-violation", onProtocolViolation);
    return () => {
      entry.workerHost.off("ready", onReady);
      entry.workerHost.off("exit", onExit);
      entry.workerHost.off("crash-loop", onCrashLoop);
      entry.workerHost.off("protocol-violation", onProtocolViolation);
    };
  }

  /**
   * Restart one plugin's backend, retiring the current generation and starting
   * a fresh one. The narrow teardown ({@link deactivateWorker}) keeps the
   * plugin's manifest contributions and its panels' registered kinds, so every
   * panel on the instance rebinds to the new generation rather than closing.
   *
   * Concurrent callers share one restart: a plugin with three open panels whose
   * user clicks "Restart plugin" in each gets one teardown, not three.
   */
  async restartPluginWorker(pluginId: string): Promise<PluginRuntimeStatus | null> {
    const inFlight = this.workerRestarts.get(pluginId);
    if (inFlight) {
      await inFlight;
      return this.buildRuntimeStatus(pluginId);
    }
    // Plain `Error`, like every other refusal this service raises — the IPC
    // handler is the layer that owns user-facing `AppError` shaping.
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin "${pluginId}" isn't loaded`);
    }
    // A restart must not revive what the user deliberately turned off. The
    // disabled set is a Set, not a list.
    if (this.records.getDisabledIds().has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is disabled`);
    }
    // Worker eligibility is the same predicate activation forks on, so it is
    // read from the one place that encodes it: a builtin runs in-process, and a
    // plugin with neither `main` nor a resolved command handler has no code for
    // a worker to run — but a commands-only plugin DOES have a live worker
    // (#12274) and must stay restartable. Refused BEFORE anything is published:
    // a `starting` for a plugin no worker event can ever settle would strand
    // every panel on it in "Reloading" until the stall banner fires.
    if (!this.hasWorkerCode(pluginId, plugin)) {
      throw new Error(`Plugin "${pluginId}" has no backend to restart`);
    }
    const run = (async (): Promise<void> => {
      this.deactivateWorker(pluginId);
      // No explicit `starting` here: `activateViaWorker` publishes one on a new
      // generation as it forks, and doing it twice would bump the generation
      // twice for a single restart. The `failed`/`stopped` this leaves standing
      // in the gap is accurate — the old worker really is gone — and only the
      // `stopped` case is latched, which a fresh `starting` clears.
      //
      // Never rejects by contract (#9428) — the outcome is read back off the
      // status the activation path published.
      await this.activatePlugin(pluginId);
    })();
    const settled = run.finally(() => {
      if (this.workerRestarts.get(pluginId) === settled) this.workerRestarts.delete(pluginId);
    });
    void settled.catch(() => undefined);
    this.workerRestarts.set(pluginId, settled);
    await settled;
    return this.buildRuntimeStatus(pluginId);
  }

  /**
   * Admit a plugin's request to restart its own worker (`host.restartWorker`,
   * #13410). Answers now and starts the restart on a later turn, so the bridge
   * posts this answer to the old worker before the teardown reaches it — a
   * microtask would run before that post. The restart itself is the ordinary
   * {@link restartPluginWorker}, so panels rebind rather than close. A manual
   * "Restart plugin" is never counted against this budget.
   */
  private requestWorkerSelfRestart(
    pluginId: string,
    boundPlugin: LoadedPlugin
  ): WorkerRestartResult {
    if (this.disposed || this.plugins.get(pluginId) !== boundPlugin) return "unavailable";
    if (this.records.getDisabledIds().has(pluginId)) return "unavailable";
    if (!this.hasWorkerCode(pluginId, boundPlugin)) return "unavailable";
    const now = Date.now();
    const last = this.workerSelfRestartAt.get(pluginId);
    if (last !== undefined && now - last < PLUGIN_WORKER_SELF_RESTART_COOLDOWN_MS) {
      return "rate-limited";
    }
    this.workerSelfRestartAt.set(pluginId, now);
    const scheduled = setImmediate(() => {
      this.scheduledWorkerSelfRestarts.delete(pluginId);
      if (this.disposed || this.plugins.get(pluginId) !== boundPlugin) return;
      this.restartPluginWorker(pluginId).catch((err: unknown) => {
        console.warn(`[PluginService] Self-restart of "${pluginId}" failed:`, err);
      });
    });
    this.scheduledWorkerSelfRestarts.set(pluginId, scheduled);
    return "scheduled";
  }

  /** Live state of every tracked instance, for a renderer that has just attached. */
  listPluginRuntimeStatuses(): PluginRuntimeStatus[] {
    const statuses: PluginRuntimeStatus[] = [];
    const ids = new Set([...this.devSessions.keys(), ...this.workerStatuses.keys()]);
    for (const pluginId of ids) {
      const status = this.buildRuntimeStatus(pluginId);
      if (status) statuses.push(status);
    }
    return statuses;
  }

  private buildRuntimeStatus(pluginId: string): PluginRuntimeStatus | null {
    const session = this.devSessions.get(pluginId);
    const worker = this.workerStatuses.get(pluginId) ?? null;
    if (!session && !worker) return null;
    const watcher = session ? this.devArtifactWatcherRegistry?.stateOf(pluginId) : undefined;
    return {
      pluginId,
      viewGeneration: this.plugins.get(pluginId)?.viewGeneration ?? null,
      worker,
      dev: session
        ? {
            reloadCount: session.reloadCount,
            watcher: watcher?.state ?? "waiting",
            // The session's own last failure outranks the watcher's: a healthy
            // watch that keeps loading a broken manifest is the case the author
            // needs told.
            detail: session.detail ?? watcher?.detail ?? null,
          }
        : null,
    };
  }

  /**
   * Mark one dispatch of `actionId` running and return its end. The end is
   * bound to this load of the plugin: a handler that settles after an unload
   * and reload must not clear a run of the replacement.
   */
  private beginActionRun(
    pluginId: string,
    actionId: string,
    generation: LoadedPlugin | undefined
  ): () => void {
    if (generation === undefined || this.plugins.get(pluginId) !== generation) return () => {};
    let byAction = this.runningActions.get(pluginId);
    if (!byAction) {
      byAction = new Map();
      this.runningActions.set(pluginId, byAction);
    }
    const count = byAction.get(actionId) ?? 0;
    byAction.set(actionId, count + 1);
    if (count === 0) this.emitActionsRunning(pluginId);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (this.plugins.get(pluginId) !== generation) return;
      const current = this.runningActions.get(pluginId);
      const remaining = (current?.get(actionId) ?? 0) - 1;
      if (!current || remaining < 0) return;
      if (remaining > 0) {
        current.set(actionId, remaining);
        return;
      }
      current.delete(actionId);
      if (current.size === 0) this.runningActions.delete(pluginId);
      this.emitActionsRunning(pluginId);
    };
  }

  /**
   * Publish the complete set of `pluginId`'s running actions, scoped like
   * {@link emitRuntimeStatus}. An empty list means none are running.
   */
  private emitToolbarBadges(pluginId: string): void {
    if (this.disposed) return;
    const event = {
      name: "plugin:toolbar-badges-changed" as const,
      payload: { pluginId, badges: this.serializePluginToolbarBadges(pluginId) },
    };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /**
   * Publish one plugin's complete activity map, scoped like
   * {@link emitToolbarBadges}. An empty map clears the plugin's reports (#13820).
   */
  private emitPanelActivity(pluginId: string): void {
    if (this.disposed) return;
    const event = {
      name: "plugin:panel-activity-changed" as const,
      payload: { pluginId, activity: this.serializePluginPanelActivity(pluginId) },
    };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /**
   * Publish one plugin's complete task list, scoped like
   * {@link emitPanelActivity}. An empty list clears its tasks (#13819).
   */
  private emitPluginTasks(pluginId: string): void {
    if (this.disposed) return;
    const event = {
      name: "plugin:tasks-changed" as const,
      payload: { pluginId, tasks: this.pluginTasks.snapshot(pluginId) },
    };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /** The user's Cancel on a plugin task. False when it isn't running or can't be cancelled. */
  cancelPluginTask(pluginId: string, taskId: string): boolean {
    return this.pluginTasks.requestCancel(pluginId, taskId);
  }

  /** The user's Dismiss on an interrupted plugin task. */
  dismissPluginTask(pluginId: string, taskId: string): boolean {
    return this.pluginTasks.dismiss(pluginId, taskId);
  }

  private serializePluginPanelActivity(
    pluginId: string
  ): Record<string, PluginPanelActivityReport> {
    const panelMap = this.pluginPanelActivity.get(pluginId);
    if (!panelMap || panelMap.size === 0) return {};
    return Object.fromEntries(panelMap);
  }

  /** Publish one plugin's complete toolbar-button state, scoped like {@link emitToolbarBadges}. */
  private emitToolbarStates(pluginId: string): void {
    if (this.disposed) return;
    const event = {
      name: "plugin:toolbar-states-changed" as const,
      payload: { pluginId, states: this.serializePluginToolbarStates(pluginId) },
    };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /** One plugin's toolbar-button state (`buttonId → state`), empty when it has none. */
  private serializePluginToolbarStates(
    pluginId: string
  ): Record<string, PluginToolbarButtonRuntimeState> {
    const buttonMap = this.pluginToolbarStates.get(pluginId);
    if (!buttonMap || buttonMap.size === 0) return {};
    return Object.fromEntries(buttonMap);
  }

  /** One plugin's toolbar badges (`buttonId → badge`), empty when it has none. */
  private serializePluginToolbarBadges(pluginId: string): Record<string, PluginPanelBadge> {
    const buttonMap = this.pluginToolbarBadges.get(pluginId);
    if (!buttonMap || buttonMap.size === 0) return {};
    return Object.fromEntries(buttonMap);
  }

  /**
   * Publish one plugin's complete card statuses for one project, to that
   * project's views only. An empty map clears them.
   */
  private emitWorktreeCardStatuses(pluginId: string, projectId: string): void {
    if (this.disposed) return;
    broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
      name: "plugin:worktree-card-statuses-changed" as const,
      payload: {
        pluginId,
        projectId,
        statuses: this.serializePluginWorktreeCardStatuses(pluginId, projectId),
      },
    });
  }

  /** One plugin's card statuses in one project (`worktreeId → status`), empty when none. */
  private serializePluginWorktreeCardStatuses(
    pluginId: string,
    projectId: string
  ): Record<string, PluginWorktreeCardStatus> {
    const statuses = this.pluginWorktreeCardStatuses.get(pluginId)?.get(projectId);
    if (!statuses || statuses.size === 0) return {};
    return Object.fromEntries(statuses);
  }

  /**
   * Publish one plugin's complete readiness checks for one project, to that
   * project's views only. An empty map clears them.
   */
  private emitWorktreeReviewChecks(pluginId: string, projectId: string): void {
    if (this.disposed) return;
    broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
      name: "plugin:worktree-review-checks-changed" as const,
      payload: {
        pluginId,
        projectId,
        checks: this.serializePluginWorktreeReviewChecks(pluginId, projectId),
      },
    });
  }

  /**
   * Publish one plugin's complete terminal statuses for one project, to that
   * project's views only. An empty map clears them (#13802).
   */
  private emitTerminalStatuses(pluginId: string, projectId: string): void {
    if (this.disposed) return;
    broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
      name: "plugin:terminal-statuses-changed" as const,
      payload: {
        pluginId,
        projectId,
        statuses: this.serializePluginTerminalStatuses(pluginId, projectId),
      },
    });
  }

  /** One plugin's readiness checks in one project (`worktreeId → checks`), empty when none. */
  private serializePluginWorktreeReviewChecks(
    pluginId: string,
    projectId: string
  ): Record<string, PluginWorktreeReviewCheck[]> {
    const checks = this.pluginWorktreeReviewChecks.get(pluginId)?.get(projectId);
    if (!checks || checks.size === 0) return {};
    return Object.fromEntries([...checks].map(([id, list]) => [id, [...list]]));
  }

  /** Drop a plugin's readiness checks everywhere, clearing each project's views. */
  private clearPluginWorktreeReviewChecks(pluginId: string): void {
    this.worktreeReviewChecksGenerations.set(
      pluginId,
      (this.worktreeReviewChecksGenerations.get(pluginId) ?? 0) + 1
    );
    const byProject = this.pluginWorktreeReviewChecks.get(pluginId);
    if (!byProject) return;
    this.pluginWorktreeReviewChecks.delete(pluginId);
    for (const projectId of byProject.keys()) this.emitWorktreeReviewChecks(pluginId, projectId);
  }

  private serializePluginTerminalStatuses(
    pluginId: string,
    projectId: string
  ): Record<string, PluginTerminalStatus> {
    const statuses = this.pluginTerminalStatuses.get(pluginId)?.get(projectId);
    if (!statuses || statuses.size === 0) return {};
    return Object.fromEntries(statuses);
  }

  /** Drop a plugin's terminal statuses everywhere, clearing each project's views. */
  private clearPluginTerminalStatuses(pluginId: string): void {
    this.terminalStatusGenerations.set(
      pluginId,
      (this.terminalStatusGenerations.get(pluginId) ?? 0) + 1
    );
    const byProject = this.pluginTerminalStatuses.get(pluginId);
    if (!byProject) return;
    this.pluginTerminalStatuses.delete(pluginId);
    for (const projectId of byProject.keys()) this.emitTerminalStatuses(pluginId, projectId);
  }

  private retireWorktreeCardTarget(key: string): void {
    const now = Date.now();
    for (const [retired, { at }] of this.retiredWorktreeCardTargets) {
      if (now - at > WORKTREE_CARD_TARGET_RETIRE_MS)
        this.retiredWorktreeCardTargets.delete(retired);
    }
    this.retiredWorktreeCardTargets.set(key, {
      revision: ++this.worktreeCardTargetRevision,
      at: now,
    });
  }

  /**
   * Whether the worktree was removed, or its project closed, after a call was
   * made (`since.revision`, taken at the call) — or just before it, within the
   * read-coalescing grace. A call made once the worktree exists again, past
   * that grace, is about the new one and goes through.
   */
  private isWorktreeCardTargetRetired(
    projectId: string,
    worktreeId: string,
    since: { revision: number; at: number }
  ): boolean {
    const spans = (key: string): boolean => {
      const retired = this.retiredWorktreeCardTargets.get(key);
      if (!retired) return false;
      return (
        retired.revision > since.revision ||
        retired.at >= since.at - WORKTREE_CARD_READ_COALESCE_GRACE_MS
      );
    };
    return spans(`w:${worktreeId}`) || spans(`p:${projectId}`);
  }

  /** Drop a plugin's card statuses everywhere, clearing each project's views. */
  private clearPluginWorktreeCardStatuses(pluginId: string): void {
    this.worktreeCardStatusGenerations.set(
      pluginId,
      (this.worktreeCardStatusGenerations.get(pluginId) ?? 0) + 1
    );
    const byProject = this.pluginWorktreeCardStatuses.get(pluginId);
    if (!byProject) return;
    this.pluginWorktreeCardStatuses.delete(pluginId);
    for (const projectId of byProject.keys()) this.emitWorktreeCardStatuses(pluginId, projectId);
  }

  /**
   * Publish the complete set of `pluginId`'s context keys, scoped like
   * {@link emitToolbarBadges}. An empty map means the plugin holds none; `null`
   * means it no longer publishes at all (unloaded or its worker retired).
   */
  private emitContextKeys(pluginId: string): void {
    if (this.disposed) return;
    const event = {
      name: "plugin:context-keys-changed" as const,
      payload: {
        pluginId,
        keys: this.pluginContextKeys.has(pluginId)
          ? this.serializePluginContextKeys(pluginId)
          : null,
      },
    };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /**
   * A project copy of a plugin owns its `when` namespace in its project's views
   * from the moment it loads, over an installed copy of the same manifest —
   * not only once it first publishes a key. Installed instances need no claim.
   */
  private claimProjectContextNamespace(pluginId: string): void {
    if (projectIdFromPluginInstanceKey(pluginId) === null) return;
    if (this.pluginContextKeys.has(pluginId)) return;
    this.pluginContextKeys.set(pluginId, new Map());
    this.emitContextKeys(pluginId);
  }

  /**
   * Drop a retiring worker's keys so the next generation republishes its own. A
   * project instance keeps its (now empty) claim; an installed one lets go.
   */
  private resetPluginContextKeys(pluginId: string): void {
    const keys = this.pluginContextKeys.get(pluginId);
    if (!keys) return;
    if (projectIdFromPluginInstanceKey(pluginId) !== null) {
      if (keys.size === 0) return;
      keys.clear();
    } else {
      this.pluginContextKeys.delete(pluginId);
    }
    this.emitContextKeys(pluginId);
  }

  /** One plugin's context keys (`key → value`), empty when it has none. */
  private serializePluginContextKeys(pluginId: string): Record<string, PluginContextValue> {
    const keys = this.pluginContextKeys.get(pluginId);
    if (!keys || keys.size === 0) return {};
    return Object.fromEntries(keys);
  }

  private emitActionsRunning(pluginId: string): void {
    if (this.disposed) return;
    const event = {
      name: "plugin:actions-running-changed" as const,
      payload: { pluginId, actionIds: [...(this.runningActions.get(pluginId)?.keys() ?? [])] },
    };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /**
   * Publish one instance's health to the renderers entitled to see it.
   *
   * Scoped to the owning project for a project-local instance, matching the
   * pull path (`plugin:runtime-statuses-get`) and the precedent every other
   * project-local plugin event already follows. This is not just symmetry: the
   * payload carries plugin-authored `detail` — activation errors, stack text,
   * paths inside that project's checkout — and no other project's view has a
   * panel on the instance to render it. An app-global id takes the full
   * broadcast it has always taken, spelled out rather than routed through
   * `broadcastToProjectRenderers`'s null widening so the common case reads as
   * what it is.
   */
  private emitRuntimeStatus(pluginId: string): void {
    if (this.disposed) return;
    const event = {
      name: "plugin:runtime-status-changed" as const,
      payload: { pluginId, status: this.buildRuntimeStatus(pluginId) },
    };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /**
   * Tell renderers a plugin's stored settings changed, so anything derived from
   * them (the panel "needs setup" strip) re-reads. Scoped like runtime status:
   * a project instance's key stays in its own project's views.
   */
  private emitSettingsChanged(pluginId: string): void {
    if (this.disposed) return;
    const event = { name: "plugin:settings-changed" as const, payload: { pluginId } };
    const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
    if (owningProjectId === null) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, event);
      return;
    }
    broadcastToProjectRenderers(owningProjectId, CHANNELS.EVENTS_PUSH, event);
  }

  /**
   * A plugin's setup checklist (#13824) as the host sees it against
   * `projectId`: whether each setting and account step is done, each context
   * step's clause for the renderer to evaluate, each step's action with a
   * command in the instance's namespace, and which steps the user skipped
   * there. Reads stored state only — nothing activates, signs in or refreshes.
   */
  async getSetupStatusForUi(
    pluginId: string,
    projectId: string | null
  ): Promise<PluginSetupUiStatus> {
    const manifest = (this.plugins.get(pluginId) ?? this.disabledPlugins.get(pluginId))?.manifest;
    const steps = manifest?.contributes.setup ?? [];
    if (!manifest || steps.length === 0) return { steps: [] };

    const settingKeys = steps.flatMap((step) =>
      step.done.kind === "setting" ? [step.done.key] : []
    );
    // One read per distinct connection the steps ask about; `""` is the one
    // the project uses. An account file that can't be read answers for its
    // own steps, which stay outstanding; the rest of the checklist stands.
    const connectionRefs = [
      ...new Set(
        steps.flatMap((step) => (step.done.kind === "account" ? [step.done.connection ?? ""] : []))
      ),
    ];
    const [presence, accountStates] = await Promise.all([
      settingKeys.length > 0
        ? this.settings.settingPresenceForUi(pluginId, settingKeys, projectId)
        : Promise.resolve({} as Record<string, string>),
      Promise.all(
        connectionRefs.map((connection) =>
          this.accounts
            .getStateFor(pluginId, {
              ...(connection === "" ? {} : { connection }),
              ...(projectId === null ? {} : { projectId }),
            })
            .then((state) => [connection, state.connected] as const)
            .catch((err: unknown) => {
              console.warn(`[PluginService] Couldn't read "${pluginId}"'s account for setup:`, err);
              return [connection, false] as const;
            })
        )
      ).then((entries) => new Map(entries)),
    ]);
    const skipped = new Set(
      projectId === null ? [] : getProjectPluginSetupSkips(projectId, pluginId)
    );

    const qualify = (actionId: string): string =>
      qualifyOwnActionId(pluginId, manifest.name, actionId);

    return {
      steps: steps.map((step): PluginSetupStepUiStatus => {
        const { done, action } = step;
        const check: PluginSetupStepCheck =
          done.kind === "context"
            ? { kind: "context", when: done.when }
            : {
                kind: "observed",
                done:
                  done.kind === "setting"
                    ? presence[done.key] === "set"
                    : accountStates.get(done.connection ?? "") === true,
              };
        let uiAction: PluginSetupStepUiAction | null;
        if (action?.kind === "command") {
          uiAction = { kind: "command", actionId: qualify(action.actionId) };
        } else if (action?.kind === "settings") {
          uiAction = { kind: "settings", key: action.key ?? null };
        } else if (done.kind === "setting") {
          uiAction = { kind: "settings", key: done.key };
        } else if (done.kind === "account") {
          uiAction = { kind: "settings", key: null };
        } else {
          uiAction = null;
        }
        return {
          id: step.id,
          title: step.title,
          description: step.description ?? null,
          check,
          action: uiAction,
          skipped: skipped.has(step.id),
        };
      }),
    };
  }

  /**
   * Skip or restore one setup step of `pluginId` in `projectId`. Refuses a step
   * the plugin doesn't declare, so nothing is remembered for a step that can't
   * be shown. The project's own views re-read; no other project's skips moved.
   */
  setSetupStepSkippedFromUi(
    projectId: string,
    pluginId: string,
    stepId: string,
    skipped: boolean
  ): void {
    const manifest = (this.plugins.get(pluginId) ?? this.disabledPlugins.get(pluginId))?.manifest;
    const stepIds = (manifest?.contributes.setup ?? []).map((step) => step.id);
    if (!stepIds.includes(stepId)) {
      throw new Error(`Plugin "${pluginId}" declares no setup step "${stepId}"`);
    }
    const changed = setProjectPluginSetupStepSkipped(projectId, pluginId, stepId, skipped, stepIds);
    if (!changed || this.disposed) return;
    broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
      name: "plugin:settings-changed" as const,
      payload: { pluginId },
    });
  }

  /** {@link PluginSettingsManager.requiredStatusForUi}, for the renderer bridge. */
  async getRequiredSettingsStatusForUi(
    pluginId: string,
    projectId: string | null
  ): Promise<PluginRequiredSettingsStatus> {
    return this.settings.requiredStatusForUi(pluginId, projectId);
  }

  private setDevSessionDetail(pluginId: string, detail: string | null): void {
    const session = this.devSessions.get(pluginId);
    if (!session || session.detail === detail) return;
    session.detail = detail;
    this.emitRuntimeStatus(pluginId);
  }

  /**
   * Serialize dev work for one plugin. The chain is kept settled rather than
   * rejected so one failed reconcile does not poison every reload queued
   * behind it.
   */
  private serializeDevSession<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.devSessionChains.get(pluginId) ?? Promise.resolve();
    const run = prior.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.devSessionChains.set(pluginId, settled);
    void settled.then(() => {
      if (this.devSessionChains.get(pluginId) === settled) {
        this.devSessionChains.delete(pluginId);
      }
    });
    return run;
  }

  /**
   * Reconcile a dev plugin against what is now on disk — manifest, views and
   * backend as one artifact generation.
   *
   * This is `loadDevPlugin`'s path, not a second loader, which is the whole
   * point: the manifest is re-read, `loadPlugin` mints a fresh
   * `viewGeneration`, and every contribution is re-registered under it — so a
   * view-only rebuild republishes `componentPath` on a URL the renderer's
   * module map has never seen, and the backend that answers it is the one that
   * shipped in the same build.
   */
  private reloadDevPlugin(pluginId: string): Promise<boolean> {
    return this.serializeDevSession(pluginId, () => this.doReloadDevPlugin(pluginId));
  }

  /**
   * Returns whether the artifact on disk was actually adopted. A `false` here
   * is not a failure the author has to see — it is the watcher being told not
   * to treat these bytes as loaded, so the next save still reconciles rather
   * than comparing equal against a build that never ran.
   */
  private async doReloadDevPlugin(pluginId: string): Promise<boolean> {
    if (this.disposed) return false;
    // Same escape gate `loadDevPlugin` applies: the id becomes a path segment
    // under `pluginsRoot` (#10518).
    if (!SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) return false;
    // A stop that landed while the settle was in flight wins.
    if (!this.devSessions.has(pluginId)) return false;
    // Re-read rather than captured at arm time: the user can disable the plugin
    // in Preferences while the CLI session keeps running, and an unload-then-load
    // would quietly bring it back.
    if (this.records.getDisabledIds().has(pluginId)) return false;

    const pluginDir = path.join(this.pluginsRoot, pluginId);
    const manifestError = await readDevManifestError(pluginDir, pluginId);
    if (manifestError) {
      // Checked BEFORE anything is unloaded: a manifest the author is midway
      // through editing must never take the running plugin down with it, and
      // the next save reconciles. Reported rather than swallowed, so "my
      // rebuild did nothing" has an answer.
      this.setDevSessionDetail(pluginId, manifestError);
      return false;
    }
    if (this.disposed || !this.devSessions.has(pluginId)) return false;

    // The author's own diagnostics are usually WHY they are saving, so a
    // reconcile that wipes them on every rebuild makes the Logs tab useless
    // exactly when it matters. Carried here and nowhere else: an ordinary
    // unload still clears, because that plugin is going away rather than being
    // replaced by its next build.
    const carriedLogs = this.logBuffers.get(pluginId);
    const restoreLogs = (): void => {
      if (!carriedLogs?.length) return;
      const fresh = this.logBuffers.get(pluginId) ?? [];
      this.logBuffers.set(pluginId, [...carriedLogs, ...fresh].slice(-PLUGIN_LOG_BUFFER_MAX));
    };

    // Everything from here to the matching decrement runs against half-swapped
    // contribution registries. Snapshots taken in that window are not
    // authoritative, and the renderer prunes persisted preferences off ones
    // that claim to be — see the broadcaster's `isRegistryUnsettled`.
    this.devReplaceDepth++;
    const replacing = this.plugins.has(pluginId);
    try {
      if (replacing) this.unloadPlugin(pluginId, { reload: true });
      const loaded = await this.loadPlugin(this.pluginsRoot, pluginId, {
        isBuiltin: false,
        disabled: this.records.getDisabledIds(),
      });
      if (!loaded) {
        restoreLogs();
        this.setDevSessionDetail(
          pluginId,
          `Couldn't load "${pluginId}" after a rebuild — it may be disabled in Preferences, or its plugin.json may be invalid`
        );
        return false;
      }

      // Disabled intent is re-read after the load as well as before it: the
      // toggle is not serialized against this chain, so it can land in the gap
      // and would otherwise be undone by the activation below.
      if (this.records.getDisabledIds().has(pluginId)) {
        this.unloadPlugin(pluginId);
        return false;
      }
      await this.activatePlugin(pluginId);
    } finally {
      if (replacing) this.settlePluginReload(pluginId);
      this.devReplaceDepth--;
      // The registries are whole again, so anything the replacement held back
      // can be published for real.
      if (this.devReplaceDepth === 0) this.broadcaster.flushDeferredCompleteSnapshots();
    }

    // A stop admitted during the load leaves the plugin running behind a
    // session that no longer exists; drop it rather than strand it.
    if (!this.devSessions.has(pluginId)) {
      this.unloadPlugin(pluginId);
      return false;
    }
    restoreLogs();

    const session = this.devSessions.get(pluginId);
    if (session) {
      session.reloadCount++;
      // `activatePlugin` never rejects, so the activation error (if any) is
      // read back off the provenance record rather than caught here. Assigned
      // unconditionally so a fixed plugin clears the previous failure.
      session.detail = this.getPluginLoadError(pluginId)?.message ?? null;
    }
    this.emitRuntimeStatus(pluginId);
    return true;
  }

  // ----- project-local plugins (`<projectRoot>/.daintree/plugins/`) -------

  /**
   * Lazily built so a service that never opens a project never constructs it,
   * and so tests can drive discovery/trust without a project view.
   */
  private projectPluginController: ProjectPluginController | null = null;
  /** Launches waiting for a project's first open, by project. */
  private readonly projectOpenWaiters = new Map<string, Set<() => void>>();

  private get projectPlugins(): ProjectPluginController {
    if (!this.projectPluginController) {
      this.projectPluginController = new ProjectPluginController(this.projectPluginDeps);
    }
    return this.projectPluginController;
  }

  private get projectPluginDeps(): ProjectPluginControllerDeps {
    return {
      discover: (projectRoot) => discoverProjectPlugins(projectRoot),
      loadProjectPlugin: (args) => this.loadProjectPluginInstance(args),
      unloadProjectPlugin: (instanceKey, options) => this.unloadPlugin(instanceKey, options),
      settleProjectPluginReload: (instanceKey, kept) => {
        // A credential held across the reload keeps working only against a
        // generation that is loaded now, still current, and declares the same
        // agent surface it was issued against.
        const current = kept ? this.plugins.get(instanceKey) : undefined;
        pluginMcpGrantRegistry.releasePlugin(
          instanceKey,
          current ? agentMcpSurfaceOf(current.manifest) : null
        );
        // Nothing came back, so nothing is left to drive the agents it launched.
        if (!current) forgetPluginLaunches(instanceKey);
      },
      // Grants are held per plugin instance and an instance key names its
      // project, so revoking by instance key purges exactly this project's
      // grants — never another project's copy of the same manifest id.
      purgeConsentForInstance: (instanceKey) => {
        // The store reports whether the purge reached disk. A silent false
        // means the grants come back on next launch for a plugin the user just
        // revoked, which is exactly the kind of failure that must be loud.
        const durable = getPluginCapabilityConsentService().revokeAllForPlugin(instanceKey);
        if (!durable) {
          console.error(
            `[PluginService] capability grants for "${instanceKey}" were revoked in memory but could not be persisted — they may return on next launch`
          );
        }
      },
      listGlobalPluginIds: () =>
        new Set<string>([
          ...[...this.plugins.keys()].filter((id) => !isProjectPluginInstanceKey(id)),
          ...this.reservedNames,
          ...this.disabledPlugins.keys(),
          ...this.blockedPlugins.keys(),
          // Catalog-only packages that run per project: a repository plugin with
          // the same id cannot run beside an enabled instance of one.
          ...this.projectInstancePackages.keys(),
        ]),
      // The instance's most recent load/activation failure, so a row that
      // loaded but could not run says so instead of reading as clean (#12232).
      getPluginLoadError: (instanceKey) => this.getPluginLoadError(instanceKey),
      readTrust: (projectId) => readProjectPluginTrust(projectId),
      writeTrust: (projectId, record) => writeProjectPluginTrust(projectId, record),
      emitToProject: (projectId, name, payload) => {
        broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, { name, payload });
      },
      isProjectClosed: (projectId) => {
        try {
          return projectStore.getProjectById(projectId)?.status === "closed";
        } catch {
          // A store read failure must not be read as "closed" — that would
          // unload a live project's plugins on a transient DB error.
          return false;
        }
      },
      isEngineIncompatible: (range) => checkPluginEngineRange(this.appVersion, range) !== null,
      getProjectHomeHolder: (projectId) =>
        getProjectSurfaceSlots(projectId).projectHome?.defaultOptionId ?? null,
      preflightApplication: ({ projectId, projectRoot, dir, manifest }) =>
        preflightProjectApplication({
          dir,
          manifest,
          projectRoot,
          dataDir: this.pluginDataDir(makeProjectPluginInstanceKey(projectId, manifest.name)),
        }),
    };
  }

  /**
   * Discover, trust-gate and (if trusted) load a project's own plugins.
   *
   * Called on every switch into a project, warm or cold. It must run AFTER the
   * project's view is registered in `webContentsRegistry`: registration alone
   * fires no contribution broadcast, so a plugin loaded into an unregistered
   * view would be invisible until the next unrelated mutation. The explicit
   * snapshot push at the end closes the same gap for a load that lands while
   * the view is still coming up.
   */
  async onProjectOpened(projectId: string, projectRoot: string): Promise<void> {
    if (this.disposed) return;
    this.openProjectRoots.set(projectId, projectRoot);
    const opening = this.projectPlugins.onProjectOpened(projectId, projectRoot);
    // Queued now, not after the repository scan: the epoch is read at request
    // time, so a close that lands during the scan makes this a no-op, and
    // `waitForProjectPlugins` can see the queue.
    const installed = this.reconcileInstalledInstances(projectId, projectRoot);
    // The open is queued now, so a launch that was waiting for it can wait on
    // the queue instead.
    const waiters = this.projectOpenWaiters.get(projectId);
    if (waiters) {
      this.projectOpenWaiters.delete(projectId);
      for (const wake of waiters) wake();
    }
    await Promise.all([opening, installed]);
    // Disposed meanwhile: the watcher sync below would build a fresh controller.
    if (this.disposed) return;
    await this.pushSnapshotToProject(projectId);
    await this.syncProjectPluginWatcher(projectId, projectRoot);
  }

  /**
   * Resolves true once the project's queued plugin work — an open, a reload, a
   * trust change — has run, so a launch can see what that work loaded; false
   * after `timeoutMs`. Open is fire-and-forget from the switch path, so this is
   * the only way to wait on it. A project with nothing queued yet waits for its
   * first open.
   */
  async waitForProjectPlugins(projectId: string, timeoutMs: number): Promise<boolean> {
    if (this.disposed) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const settled = (async (): Promise<boolean> => {
      // A background restore signals the open only after its view has loaded,
      // so a pane restored into it can ask before the project is known at all.
      if (!this.projectPlugins.hasQueuedWork(projectId)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          let waiters = this.projectOpenWaiters.get(projectId);
          if (!waiters) {
            waiters = new Set();
            this.projectOpenWaiters.set(projectId, waiters);
          }
          waiters.add(resolve);
        });
      }
      // Woken by dispose: the getter would build a fresh controller.
      if (this.disposed) return false;
      await this.projectPlugins.whenSettled(projectId);
      // Follow the queue to its end: an update can append behind the tail read here.
      for (
        let tail = this.installedInstanceChains.get(projectId);
        tail;
        tail = this.installedInstanceChains.get(projectId)
      ) {
        await tail.catch(() => {});
        if (this.installedInstanceChains.get(projectId) === tail) break;
      }
      return !this.disposed;
    })();
    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      clearTimeout(timer);
      if (wake) {
        const waiters = this.projectOpenWaiters.get(projectId);
        waiters?.delete(wake);
        if (waiters?.size === 0) this.projectOpenWaiters.delete(projectId);
      }
    }
  }

  /** This project stopped being live: unload everything it owns. */
  async onProjectClosed(projectId: string): Promise<void> {
    // Stop the watcher first: it is the one thing that could otherwise queue a
    // reload behind the teardown.
    this.projectPluginWatcherRegistry?.stop(projectId);
    // A reload of this project's plugins may be held up behind discovery, and
    // the close queues behind it; its held credentials must not outlive the
    // close by however long that takes.
    pluginMcpGrantRegistry.revokeHeld(
      (instanceId) => projectIdFromPluginInstanceKey(instanceId) === projectId
    );
    forgetPluginLaunchesWhere(
      (instanceId) => projectIdFromPluginInstanceKey(instanceId) === projectId
    );
    // Every plugin's statuses on the closed project's cards, app-global ones
    // included: they described worktrees nobody is looking at any more.
    this.retireWorktreeCardTarget(`p:${projectId}`);
    // Every plugin's artifacts for this project, app-global ones included,
    // before the controller-only early return below.
    this.artifactService?.forgetProject(projectId);
    this.openProjectRoots.delete(projectId);
    this.unloadInstalledInstancesOfProject(projectId);
    for (const [pluginId, byProject] of [...this.pluginWorktreeCardStatuses]) {
      if (!byProject.delete(projectId)) continue;
      if (byProject.size === 0) this.pluginWorktreeCardStatuses.delete(pluginId);
      this.emitWorktreeCardStatuses(pluginId, projectId);
    }
    for (const [pluginId, byProject] of [...this.pluginWorktreeReviewChecks]) {
      if (!byProject.delete(projectId)) continue;
      if (byProject.size === 0) this.pluginWorktreeReviewChecks.delete(pluginId);
      this.emitWorktreeReviewChecks(pluginId, projectId);
    }
    // Terminal chips likewise: the panes they marked went with the project.
    this.closedTerminalStatusProjects.set(projectId, ++this.terminalStatusCloseRevision);
    for (const [pluginId, byProject] of [...this.pluginTerminalStatuses]) {
      if (!byProject.delete(projectId)) continue;
      if (byProject.size === 0) this.pluginTerminalStatuses.delete(pluginId);
      this.emitTerminalStatuses(pluginId, projectId);
    }
    if (!this.projectPluginController) return;
    await this.projectPluginController.onProjectClosed(projectId);
    await this.pushSnapshotToProject(projectId);
  }

  /**
   * Record the user's answer. A decision that applied in memory but did not
   * reach disk still rejects: the plugins are running, and the user needs to
   * know the choice will be asked for again (#12212). The snapshot and the
   * watcher are reconciled either way — the in-memory state changed regardless
   * of whether the write landed.
   */
  async setProjectPluginTrust(
    projectId: string,
    decision: ProjectPluginTrustDecision
  ): Promise<void> {
    let failure: unknown;
    try {
      await this.projectPlugins.setTrust(projectId, decision);
    } catch (err) {
      failure = err;
    }
    await this.pushSnapshotToProject(projectId);
    await this.syncProjectPluginWatcher(projectId);
    if (failure !== undefined) throw failure;
  }

  async activateStagedProjectPlugin(projectId: string, pluginId: string): Promise<void> {
    await this.projectPlugins.activateStaged(projectId, pluginId);
    await this.pushSnapshotToProject(projectId);
    await this.syncProjectPluginWatcher(projectId);
  }

  /**
   * Switch one of a project's own plugins off, or back on, without touching the
   * folder-level trust decision. Same post-change snapshot push and watcher sync
   * as a trust change — muting unloads a plugin, so the project's views have to
   * be told what is no longer there.
   */
  async setProjectPluginMuted(projectId: string, pluginId: string, muted: boolean): Promise<void> {
    await this.projectPlugins.setMuted(projectId, pluginId, muted);
    await this.pushSnapshotToProject(projectId);
    await this.syncProjectPluginWatcher(projectId);
  }

  /**
   * Everything this project's views know about its slots — the arbitrated
   * claims, the refusals and the user's answers — read in one synchronous pass
   * so the revision describes all three.
   *
   * An unreadable answer store yields `choices: null` rather than failing the
   * whole read: the claims and refusals are still worth showing, and the
   * renderer already treats an unknown answer as "stay on stock, don't ask".
   */
  getProjectSurfacesSnapshot(projectId: string): ProjectSurfacesSnapshot {
    let choices: ProjectSurfaceChoices | null;
    try {
      choices = readProjectSurfaceChoices(projectId);
    } catch (err) {
      console.warn("[PluginService] Could not read project surface choices:", err);
      choices = null;
    }
    return {
      projectId,
      revision: getProjectSurfaceRevision(projectId),
      slots: getProjectSurfaceSlots(projectId),
      choices,
    };
  }

  /**
   * Remember the user's answer about a slot, and tell every view of the
   * project: the canvas and the settings pane that discloses the answer can be
   * open in different windows.
   */
  setProjectSurfaceChoice(
    projectId: string,
    slot: ProjectSurfaceSlotKey,
    choice: ProjectSurfaceChoice | null,
    optionId?: string
  ): ProjectSurfacesSnapshot {
    return this.setProjectSurfaceChoices(projectId, [{ slot, choice, optionId }]);
  }

  /**
   * Remember an answer about several slots in one write — all of them or none
   * — under one revision and one signal, so no view ever adopts half of it.
   */
  setProjectSurfaceChoices(
    projectId: string,
    updates: readonly ProjectSurfaceChoiceUpdate[]
  ): ProjectSurfacesSnapshot {
    writeProjectSurfaceChoices(projectId, updates);
    bumpProjectSurfaceRevision(projectId);
    this.publishProjectSurfaces([projectId]);
    return this.getProjectSurfacesSnapshot(projectId);
  }

  /**
   * The one project-scoped signal that a project's slot state changed — a
   * claim, a release, a refusal or an answer. Carries only the revision; each
   * view re-reads the snapshot, which main resolves from the view's own
   * project.
   */
  private publishProjectSurfaces(projectIds: Iterable<string>): void {
    for (const projectId of new Set(projectIds)) {
      broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
        name: "plugin:project-surfaces-changed",
        payload: { projectId, revision: getProjectSurfaceRevision(projectId) },
      } satisfies EventBusEnvelope);
    }
  }

  /** The per-project visibility overlay for INSTALLED plugins. */
  getProjectPluginVisibility(projectId: string): ProjectPluginVisibility {
    return readProjectPluginVisibility(projectId);
  }

  /**
   * Hide or show one installed plugin in one project. `null` clears the decision
   * back to the default.
   *
   * The plugin keeps running — this is a visibility filter, not an unload — so
   * the only thing that has to happen after the write is a rebroadcast of the
   * scoped contribution channels. Nothing in the registries changed, so nothing
   * else would fire, and the switch would otherwise take effect only on the next
   * unrelated plugin event.
   */
  setProjectPluginVisibility(projectId: string, pluginId: string, visible: boolean | null): void {
    if (!writeProjectPluginVisibility(projectId, pluginId, visible)) return;
    this.announceVisibilityChange(projectId);
  }

  /**
   * Set whether a plugin is hidden in projects that have not decided for
   * themselves. Changes what every unanswered project sees, so the rebroadcast
   * is the same one a per-project change triggers.
   */
  setPluginVisibilityDefault(projectId: string, pluginId: string, hidden: boolean): void {
    if (!writePluginVisibilityDefault(pluginId, hidden)) return;
    this.announceVisibilityChange(projectId);
  }

  private announceVisibilityChange(projectId: string): void {
    this.broadcaster.broadcastVisibilityChanged();
    broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
      name: "plugin:project-plugin-visibility-changed",
      payload: { projectId, visibility: readProjectPluginVisibility(projectId) },
    });
  }

  // ----- project-local plugin hot reload (§7.10) -------------------------

  private projectPluginWatcherRegistry: ProjectPluginWatcher | null = null;

  private get projectPluginWatchers(): ProjectPluginWatcher {
    if (!this.projectPluginWatcherRegistry) {
      this.projectPluginWatcherRegistry = new ProjectPluginWatcher({
        discover: (projectRoot) => discoverProjectPlugins(projectRoot),
        loadedManifestIds: (projectId) => this.projectPlugins.loadedManifestIds(projectId),
        reload: (projectId, projectRoot, manifestIds) =>
          this.hotReloadProjectPlugins(projectId, projectRoot, manifestIds),
        viewGenerationsAllocated: () => pluginViewGenerationsAllocated(),
        onAppQuit: (dispose) => {
          try {
            app.once("before-quit", dispose);
          } catch {
            // No app object (tests, or a headless harness): nothing to hook.
          }
        },
      });
    }
    return this.projectPluginWatcherRegistry;
  }

  /**
   * A watcher exists for every open project that has not answered "no".
   *
   * Trust gates *execution*, not observation. Gating the watcher on
   * `enabled` deadlocked the first plugin a project ever gets: trust cannot be
   * granted before a plugin exists, and without a watcher the plugin is not
   * noticed until the user switches projects and back — so an agent creating
   * `.daintree/plugins/` in the project the user is looking at produced nothing
   * at all (#12212). Watching while the decision is still open runs no plugin
   * code: `discoverProjectPlugins` parses `plugin.json` and stops, and
   * `reloadChanged` still refuses to LOAD anything without a recorded grant.
   *
   * It is not free, though, and the comment that once claimed otherwise was
   * wrong: arming a folder that already exists also fingerprints each plugin's
   * build output to seed the hot-reload baseline. That is bounded stat traffic
   * over a folder the user opened, not execution — but a project with many
   * plugin directories pays it before deciding anything, and there is no
   * per-project watcher budget yet. Worth revisiting if watcher count ever
   * shows up in a profile.
   *
   * An explicit "no" is the one answer that stops it. A remembered `disabled`
   * tears the native subscription down with everything else, as does a close.
   */
  private async syncProjectPluginWatcher(projectId: string, projectRoot?: string): Promise<void> {
    const trust = this.projectPlugins.getTrustState(projectId);
    // A close can land while an open is still awaiting its snapshot push, every
    // close notification is fire-and-forget, and the project store's own status
    // reconciliation flips a row to "closed" without ever reaching
    // `onProjectClosed`. Re-reading the row here is what keeps any of them from
    // leaving a live native watcher behind.
    if (
      this.disposed ||
      this.isProjectRowClosed(projectId) ||
      !(trust.enabled || trust.decision === null)
    ) {
      this.projectPluginWatcherRegistry?.stop(projectId);
      return;
    }
    const root = projectRoot ?? projectStore.getProjectById(projectId)?.path;
    if (!root) {
      this.projectPluginWatcherRegistry?.stop(projectId);
      return;
    }
    await this.projectPluginWatchers.ensure(projectId, root);
  }

  /** A store read failure must never be read as "closed" — that would unload a live project. */
  private isProjectRowClosed(projectId: string): boolean {
    try {
      return projectStore.getProjectById(projectId)?.status === "closed";
    } catch {
      return false;
    }
  }

  /**
   * The watcher's reload edge. Drops the plugins it named and re-runs the
   * project-open reconcile in one serialized task, so the swap inherits the
   * trust gate, the staging rules and the generation guard rather than
   * reimplementing them — and a fresh `plugin://` authority and `__dtv-N` view
   * generation are minted by the load itself.
   */
  private async hotReloadProjectPlugins(
    projectId: string,
    projectRoot: string,
    manifestIds: readonly string[]
  ): Promise<void> {
    if (this.disposed) return;
    // The watcher is stopped by close and revoke, but a burst can already be
    // in flight when either lands — and a project closed behind our back never
    // stops it at all. Refuse at the edge as well as at the source.
    if (this.isProjectRowClosed(projectId)) {
      this.projectPluginWatcherRegistry?.stop(projectId);
      return;
    }
    await this.projectPlugins.reloadChanged(projectId, projectRoot, manifestIds);
    await this.pushSnapshotToProject(projectId);
  }

  listProjectPlugins(projectId: string): ProjectPluginInfo[] {
    return this.projectPlugins.listProjectPlugins(projectId);
  }

  getProjectPluginTrustState(projectId: string): ProjectPluginTrustState {
    return this.projectPlugins.getTrustState(projectId);
  }

  /**
   * Manual reload escape hatch: re-scan the folder and reconcile. Same code path
   * as a project open, so it inherits the trust gate and the staging rules
   * rather than bypassing them.
   */
  async reloadProjectPlugins(projectId: string): Promise<void> {
    const root = projectStore.getProjectById(projectId)?.path;
    if (!root) return;
    await this.onProjectOpened(projectId, root);
  }

  // ----- Installed packages that opt into per-project instances (#14103) -----
  //
  // An `instanceMode: "project"` package is one installed package and N
  // instances, one per project it is enabled in. Each instance loads through the
  // same path as a repository-local plugin, so its key, settings, storage,
  // databases, connections and contributions are pinned to the project it was
  // enabled in; nothing here resolves the focused project.

  private installedInstanceEpoch(projectId: string, instanceKey: string): string {
    return `${this.installedInstanceProjectEpochs.get(projectId) ?? 0}:${this.installedInstanceEpochs.get(instanceKey) ?? 0}`;
  }

  private serializeInstalledInstances(projectId: string, task: () => Promise<void>): Promise<void> {
    const prior = this.installedInstanceChains.get(projectId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(task);
    this.installedInstanceChains.set(projectId, next);
    const settle = (): void => {
      if (this.installedInstanceChains.get(projectId) === next) {
        this.installedInstanceChains.delete(projectId);
      }
    };
    next.then(settle, settle);
    return next;
  }

  /**
   * Load every instance this project has enabled. The empty path is two cheap
   * checks: no catalogued package, or no enablement in this project, returns
   * before anything is queued.
   */
  private async reconcileInstalledInstances(projectId: string, projectRoot: string): Promise<void> {
    if (this.projectInstancePackages.size === 0) return;
    const disabled = this.records.getDisabledIds();
    const wanted = this.projectInstanceStore
      .listForProject(projectId)
      .filter((id) => this.projectInstancePackages.has(id) && !disabled.has(id));
    if (wanted.length === 0) return;
    const requested = wanted.map((id) => {
      const key = makeInstalledProjectInstanceKey(projectId, id);
      return { id, key, epoch: this.installedInstanceEpoch(projectId, key) };
    });
    await this.serializeInstalledInstances(projectId, async () => {
      for (const { id, key, epoch } of requested) {
        if (this.disposed) return;
        if (epoch !== this.installedInstanceEpoch(projectId, key)) continue;
        await this.loadInstalledInstance(projectId, projectRoot, id, epoch);
      }
    });
  }

  private async reconcileInstalledInstancesForOpenProjects(): Promise<void> {
    if (this.projectInstancePackages.size === 0) return;
    for (const [projectId, projectRoot] of [...this.openProjectRoots]) {
      if (this.openProjectRoots.get(projectId) !== projectRoot) continue;
      try {
        await this.reconcileInstalledInstances(projectId, projectRoot);
      } catch (err) {
        console.error(`[PluginService] Loading installed instances for ${projectId} threw:`, err);
      }
    }
  }

  private async loadInstalledInstance(
    projectId: string,
    projectRoot: string,
    manifestId: string,
    epoch: string
  ): Promise<boolean> {
    const pkg = this.projectInstancePackages.get(manifestId);
    if (!pkg) return false;
    const key = makeInstalledProjectInstanceKey(projectId, manifestId);
    if (this.plugins.has(key)) return this.installedInstanceKeys.has(key);
    const isCurrent = (): boolean =>
      !this.disposed &&
      this.installedInstanceEpoch(projectId, key) === epoch &&
      this.projectInstancePackages.get(manifestId) === pkg;
    let ok = false;
    try {
      ok = await this.loadProjectPluginInstance({
        projectId,
        projectRoot,
        dir: pkg.dir,
        dirName: path.basename(pkg.dir),
        manifest: pkg.manifest,
        isCurrent,
        installedInstance: true,
      });
    } catch (err) {
      console.error(
        `[PluginService] Loading "${manifestId}" into project ${projectId} threw:`,
        err
      );
    }
    if (!ok) return false;
    // A repository-local load of the same identity can be in flight at once; the
    // registry holds whichever landed, and only ours is ours to track and unload.
    if (this.plugins.get(key)?.dir !== pkg.dir) return false;
    this.installedInstanceKeys.add(key);
    // A close, disable or package replacement landed while this was loading. Its
    // teardown could not see an instance that was not registered yet.
    if (!isCurrent()) this.dropInstalledInstance(key, false);
    return true;
  }

  private dropInstalledInstance(instanceKey: string, purgeGrants: boolean): void {
    this.installedInstanceKeys.delete(instanceKey);
    this.unloadPlugin(instanceKey);
    if (purgeGrants) {
      const durable = getPluginCapabilityConsentService().revokeAllForPlugin(instanceKey);
      if (!durable) {
        console.error(
          `[PluginService] capability grants for "${instanceKey}" were revoked in memory but could not be persisted — they may return on next launch`
        );
      }
    }
  }

  /** A project stopped being live: its instances go, every other project's stay. */
  private unloadInstalledInstancesOfProject(projectId: string): void {
    this.installedInstanceProjectEpochs.set(
      projectId,
      (this.installedInstanceProjectEpochs.get(projectId) ?? 0) + 1
    );
    for (const key of [...this.installedInstanceKeys]) {
      if (projectIdFromPluginInstanceKey(key) === projectId) this.dropInstalledInstance(key, false);
    }
  }

  /**
   * Take every instance of a package down. An update purges their grants because
   * the code behind them is about to change; an uninstall also forgets where the
   * package was enabled. A plain disable keeps both.
   */
  private unloadPackageInstances(
    manifestId: string,
    opts: { uninstall: boolean; purge: boolean }
  ): void {
    for (const key of [...this.installedInstanceKeys]) {
      if (pluginManifestIdFromInstanceKey(key) !== manifestId) continue;
      this.installedInstanceEpochs.set(key, (this.installedInstanceEpochs.get(key) ?? 0) + 1);
      this.dropInstalledInstance(key, opts.purge);
    }
    // Instances of a closed project are unloaded but keep their approvals; the
    // code behind them is about to change or go, so those are purged too.
    if (opts.purge) {
      for (const projectId of this.projectInstanceStore.listForPackage(manifestId)) {
        getPluginCapabilityConsentService().revokeAllForPlugin(
          makeInstalledProjectInstanceKey(projectId, manifestId)
        );
      }
    }
    if (opts.uninstall) {
      this.projectInstanceStore.removePackage(manifestId);
      this.projectInstancePackages.delete(manifestId);
    }
  }

  /** Load a package's instances again in every still-open project that enabled it. */
  private async reloadPackageInstances(manifestId: string): Promise<void> {
    if (this.disposed || !this.projectInstancePackages.has(manifestId)) return;
    for (const projectId of this.projectInstanceStore.listForPackage(manifestId)) {
      let project: { path: string; status?: string } | null | undefined;
      try {
        project = projectStore.getProjectById(projectId);
      } catch {
        project = undefined;
      }
      if (!project || project.status === "closed") continue;
      await this.reconcileInstalledInstances(projectId, project.path);
    }
  }

  /**
   * Enable or disable an installed package in one project. The choice is
   * persisted before anything executes, and only that project's instance is
   * touched.
   */
  async setProjectInstanceEnabled(
    projectId: string,
    projectRoot: string,
    manifestId: string,
    enabled: boolean
  ): Promise<void> {
    if (!isProjectWorkspaceId(projectId)) {
      throw new Error(`setProjectInstanceEnabled: "${projectId}" is not a project id`);
    }
    if (!this.projectInstancePackages.has(manifestId)) {
      throw new Error(`"${manifestId}" is not an installed package that runs per project`);
    }
    this.projectInstanceStore.setEnabled(projectId, manifestId, enabled);
    if (enabled) {
      await this.reconcileInstalledInstances(projectId, projectRoot);
    } else {
      const key = makeInstalledProjectInstanceKey(projectId, manifestId);
      this.installedInstanceEpochs.set(key, (this.installedInstanceEpochs.get(key) ?? 0) + 1);
      // Purged even when the project is closed and the instance is not loaded:
      // the approvals are the instance's, not the runtime's.
      this.dropInstalledInstance(key, true);
    }
    this.broadcaster.broadcastProvenanceChanged();
  }

  /**
   * Delete every per-project instance's user-scope settings and secrets, local
   * settings, account tokens and user-scope storage for one package. Found by
   * filename rather than by the enablement list, which an uninstall has already
   * cleared and which never held projects the package was enabled in before.
   */
  private async wipeInstalledInstanceData(manifestId: string): Promise<void> {
    if (!SCOPED_PLUGIN_NAME_PATTERN.test(manifestId)) return;
    const isInstanceFile = (name: string): boolean => {
      if (!name.endsWith(".json")) return false;
      const parsed = parseProjectPluginInstanceKey(name.slice(0, -".json".length));
      return parsed?.installed === true && parsed.manifestId === manifestId;
    };
    const listDir = async (dir: string): Promise<string[]> => {
      try {
        return await fs.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    };
    const settingsRoot = this.settings.settingsRoot();
    const dirs = [settingsRoot, path.join(settingsRoot, "accounts"), this.storage.storageRoot()];
    const localRoot = path.join(settingsRoot, "local");
    for (const projectId of await listDir(localRoot)) {
      if (isProjectWorkspaceId(projectId)) dirs.push(path.join(localRoot, projectId));
    }
    for (const dir of dirs) {
      for (const name of await listDir(dir)) {
        if (isInstanceFile(name)) await wipeSettingsFile(path.join(dir, name));
      }
    }
  }

  /** Forget every enablement in a project that was removed from Daintree. */
  forgetProjectInstances(projectId: string): void {
    this.unloadInstalledInstancesOfProject(projectId);
    this.projectInstanceStore.removeProject(projectId);
  }

  /** Project ids a package is enabled in. */
  getProjectInstanceProjects(manifestId: string): string[] {
    return this.projectInstanceStore.listForPackage(manifestId);
  }

  /**
   * How an installed or builtin package with this manifest id runs, so a caller
   * can tell an id that may be turned on per project from one that never can.
   * `"project-unavailable"` is an instanced package switched off in
   * Preferences or refused by the blocklist: it is out of the catalog until
   * that changes.
   */
  getInstalledPackageMode(
    manifestId: string
  ): "project" | "project-unavailable" | "singleton" | null {
    if (this.projectInstancePackages.has(manifestId)) {
      // A disable is persisted before its transition leaves the catalog.
      return this.records.getDisabledIds().has(manifestId) ? "project-unavailable" : "project";
    }
    const parked = this.disabledPlugins.get(manifestId) ?? this.blockedPlugins.get(manifestId);
    if (parked) {
      return parked.manifest.instanceMode === "project" && !parked.isBuiltin
        ? "project-unavailable"
        : "singleton";
    }
    return this.plugins.has(manifestId) ? "singleton" : null;
  }

  /**
   * Load one project plugin under its instance key, bound to its project.
   * Returns false when the manifest was rejected at load.
   */
  private async loadProjectPluginInstance(args: {
    projectId: string;
    projectRoot: string;
    dir: string;
    dirName: string;
    manifest: Readonly<PluginManifest>;
    isCurrent?: () => boolean;
    installedInstance?: boolean;
  }): Promise<boolean> {
    // `loadPlugin` waits on the same gate, but a project load can sit there for
    // seconds on a relaunch (#12996) — long enough for its project to close or
    // lose trust. Waiting here first lets it stop before it publishes or
    // activates, which the controller's after-the-fact unload cannot undo.
    if (this.whenProtocolReady) {
      await this.whenProtocolReady();
      if (this.disposed || args.isCurrent?.() === false) return false;
    }
    const instanceKey = args.installedInstance
      ? makeInstalledProjectInstanceKey(args.projectId, args.manifest.name)
      : makeProjectPluginInstanceKey(args.projectId, args.manifest.name);
    // A repository plugin and an installed package's instance with the same
    // manifest id are two identities with separate grants and data, but only one
    // of them runs in a project: whichever landed first keeps it.
    const siblingKey = args.installedInstance
      ? makeProjectPluginInstanceKey(args.projectId, args.manifest.name)
      : makeInstalledProjectInstanceKey(args.projectId, args.manifest.name);
    if (this.plugins.has(siblingKey)) {
      console.error(
        args.installedInstance
          ? `[PluginService] "${args.manifest.name}" is enabled in project ${args.projectId} but a repository-local plugin with that id is already running there — not loading the installed package`
          : `[PluginService] Project ${args.projectId} ships "${args.manifest.name}" but the installed package with that id is already running there — not loading the repository copy`
      );
      return false;
    }
    // Re-derive the parent from the realpath-resolved directory discovery
    // returned, so the load reads through the same resolved path the symlink
    // containment check passed on.
    const parent = path.dirname(args.dir);
    const dirName = path.basename(args.dir);

    const loaded = await this.loadPlugin(parent, dirName, {
      isBuiltin: false,
      disabled: new Set<string>(),
      origin: "project",
      instanceKey,
      binding: { projectId: args.projectId, projectRoot: args.projectRoot },
      checkedManifest: args.manifest,
      installedInstance: args.installedInstance,
    });
    if (!loaded) {
      this.writePluginFileLog(
        instanceKey,
        "lifecycle",
        "Project plugin rejected at load",
        {},
        "warn"
      );
      // Never registered, so no unload will come to drain its window.
      const suppressed = this.fileLogLimiter.drain(instanceKey);
      if (suppressed) this.writePluginFileLogSummary(instanceKey, suppressed);
      return false;
    }

    // The registrations above are already published, so a load that was
    // overtaken while `loadPlugin` ran is taken back down before it can activate.
    if (args.installedInstance && args.isCurrent?.() === false) {
      this.unloadPlugin(instanceKey);
      return false;
    }
    // Both loads passed the check above while the other was still in flight.
    // The repository copy keeps the project; the installed instance stands down.
    if (this.plugins.has(siblingKey)) {
      const installedKey = args.installedInstance ? instanceKey : siblingKey;
      console.error(
        `[PluginService] "${args.manifest.name}" loaded from the repository and the installed package at once in project ${args.projectId} — keeping the repository copy`
      );
      if (args.installedInstance) {
        this.unloadPlugin(installedKey);
        return false;
      }
      this.installedInstanceKeys.delete(installedKey);
      this.unloadPlugin(installedKey);
    }

    const activatesOnStartup = this.shouldActivateOnStartup(loaded.manifest);
    // Recorded before activation so a lazy plugin that is never triggered still
    // leaves evidence that it loaded — its absence of worker transitions then
    // reads as "never activated", not "never loaded".
    this.writePluginFileLog(instanceKey, "lifecycle", "Project plugin loaded", {
      version: loaded.manifest.version,
      activation: activatesOnStartup ? "startup" : "lazy",
    });

    // Activation still obeys the manifest's own activation events — a trusted
    // project plugin with no `onStartupFinished` does not execute until
    // something actually triggers it, exactly like an installed plugin.
    if (activatesOnStartup) {
      await this.activatePlugin(instanceKey);
    }
    return true;
  }

  /**
   * Re-push the full contribution snapshot to every live view of one project.
   * Contribution registration schedules a coalesced broadcast, but a view that
   * registered a moment ago has nothing to coalesce with; this makes the
   * project's own views consistent without widening the broadcaster's
   * unresolved-target behaviour.
   */
  private async pushSnapshotToProject(projectId: string): Promise<void> {
    if (this.disposed) return;
    let targets: Electron.WebContents[];
    try {
      targets = getWebContentsForProject(projectId);
    } catch {
      return;
    }
    for (const wc of targets) {
      await this.broadcaster.pushSnapshotTo(wc, projectId);
    }
    // Remote views attached to the project (Host mode).
    const registry = getEndpointRegistry();
    if (!registry.hasRemote()) return;
    for (const endpoint of registry.getForProject(projectId)) {
      if (endpoint.kind !== "remote-view" || endpoint.isClosed()) continue;
      await this.broadcaster.pushSnapshotTo(endpointPushTarget(endpoint), projectId);
    }
  }

  /**
   * Settle a reload that `unloadPlugin(id, { reload: true })` began. Agent
   * credentials held across it survive only when the generation loaded now
   * declares the agent surface they were issued against; anything else,
   * including nothing coming back, revokes them. A disable that landed while
   * the plugin was out of `this.plugins` found nothing to unload, so the
   * persisted intent is read here too.
   */
  private settlePluginReload(pluginId: string): void {
    // A settled reload speaks for its plugin's themes whether or not anything
    // loaded, so it counts as a removal for the sync it schedules.
    if (this.pluginThemeReloads.delete(pluginId)) this.pluginThemeRemovals.add(pluginId);
    this.schedulePluginThemeSync();
    const current = this.records.getDisabledIds().has(pluginId)
      ? undefined
      : this.plugins.get(pluginId);
    pluginMcpGrantRegistry.releasePlugin(
      pluginId,
      current ? agentMcpSurfaceOf(current.manifest) : null
    );
    if (!current) forgetPluginLaunches(pluginId);
  }

  /**
   * Settle the theme selection against the catalog and publish the catalog,
   * once per turn however many plugins changed (#13832). Deferred so a disable
   * has finished moving the plugin aside before the selection is judged, and
   * skipped after {@link dispose}, whose unload sweep must not read as every
   * plugin going away.
   */
  private schedulePluginThemeSync(): void {
    if (this.disposed || this.pluginThemeSyncQueued) return;
    this.pluginThemeSyncQueued = true;
    queueMicrotask(() => {
      this.pluginThemeSyncQueued = false;
      if (this.disposed) return;
      const removals = new Set(this.pluginThemeRemovals);
      this.pluginThemeRemovals.clear();
      let fallbackSchemeId: string | null = null;
      try {
        fallbackSchemeId = reconcilePluginThemeSelection(
          (owner) =>
            !this.pluginThemeReloads.has(owner) &&
            (this.pluginThemeCatalogReady || this.plugins.has(owner) || removals.has(owner))
        );
      } catch (err) {
        console.error("[PluginService] Failed to settle the plugin theme selection:", err);
      }
      // Renderers pull the catalog on mount, so only a change is worth a push.
      if (!this.pluginThemeCatalogDirty && fallbackSchemeId === null) return;
      this.pluginThemeCatalogDirty = false;
      this.broadcaster.scheduleThemesBroadcast(fallbackSchemeId);
    });
  }

  unloadPlugin(pluginId: string, options?: { reload: true }): void {
    const unloading = this.plugins.get(pluginId);
    if (!unloading) return;
    // First, before anything else can run plugin code or yield: every agent
    // credential for this instance dies, and only then do its rosters go. The
    // other order leaves a window where a live grant resolves to an endpoint
    // with no tools — or, across a reload, to the next generation's tools,
    // which inherits no authority. Idle worker disposal (`deactivateWorker`)
    // deliberately skips this: the instance is still loaded, its grants stay
    // valid, and the roster returns when the worker re-activates.
    //
    // A reload holds them instead: a project plugin's hot reload, a dev
    // plugin's rebuild, or an installed plugin's upgrade. They reach no plugin
    // code until the reload settles, and survive only if the generation it
    // leaves loaded declares the same agent surface. Running agents cannot be
    // handed a new bearer, so revoking here would cut them off for good.
    runUnloadStep(pluginId, "revokeAgentMcpGrants", () => {
      if (options?.reload) {
        pluginMcpGrantRegistry.holdPlugin(pluginId, agentMcpSurfaceOf(unloading.manifest));
      } else {
        pluginMcpGrantRegistry.revokePlugin(pluginId);
      }
      agentMcpEndpointRegistry.unregisterPlugin(pluginId);
    });
    // The agents it launched stay a reloading plugin's for the same reason
    // (#14018): they keep running, and a reload that ended their reach would
    // strand them at the next prompt. The record names the instance, not a
    // generation, so the code loaded next is held to its own capabilities and
    // consent on every call. Any other unload ends the reach.
    if (!options?.reload) {
      runUnloadStep(pluginId, "forgetPluginLaunches", () => forgetPluginLaunches(pluginId));
    }
    // Drop activation state so a runtime reload (e.g. dev-mode re-scan) can
    // re-activate from scratch — otherwise the fast-path `activatedPlugins`
    // hit would short-circuit `_doActivate` after the new manifest landed.
    this.activatedPlugins.delete(pluginId);
    this.activationPromises.delete(pluginId);
    // Before the plugin's own cleanup runs: no longer activated, it can start
    // no new service call, and the calls it made or is answering settle now.
    runUnloadStep(pluginId, "retireServices", () => this.services.retireInstance(pluginId));
    const cleanup = this.cleanupMap.get(pluginId);
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(`[PluginService] Cleanup callback for "${pluginId}" threw:`, err);
      }
      this.cleanupMap.delete(pluginId);
    }
    this.flushPluginEventCleanups(pluginId);
    this.stopEventRoutes(pluginId);

    // Capture the unloaded plugin's declared decoration scopes before clearing
    // the registry so we can tell any renderer that was showing them to
    // re-pull (it will now resolve no impl and clear). Without this, stale
    // decorations from a runtime-unloaded plugin would linger until the next
    // scope/path change or remount.
    const decorationScopes = this.plugins
      .get(pluginId)
      ?.manifest.contributes.fileDecorationProviders.flatMap((c) => c.scopes);

    // Each step is wrapped individually so a throwing registry call can't
    // strand later cleanup steps — partial-unload leaks would re-surface as
    // duplicate-id errors on the next load. Disposer throws are warnings
    // (the cleanup is best-effort), not user-visible errors.
    //
    // Belt-and-suspenders: per-provider disposers pushed onto
    // pluginEventCleanups by host.registerForgeProvider have already fired in
    // flushPluginEventCleanups() above, but the bulk *Impls clears below guard
    // against any impl entry that wasn't tracked through that path (e.g. a
    // future re-bind that didn't refresh the disposer slot). The bulk calls
    // are idempotent — already-cleared keys are silent no-ops. Provider and
    // impl steps are split so a throw in the descriptor unregister doesn't
    // strand the impl unregister and vice versa.
    runUnloadStep(pluginId, "removeHandlers", () => this.removeHandlers(pluginId));
    runUnloadStep(pluginId, "unregisterPluginActions", () =>
      this.unregisterPluginActions(pluginId)
    );
    this.contributions.unregister(pluginId, options);
    // Subscriber disposers already fired in flushPluginEventCleanups() above;
    // this drops any leftover subscriber-set entry and the in-memory settings
    // store caches so a reload starts from disk.
    runUnloadStep(pluginId, "clearPluginSettingsState", () =>
      this.settings.clearPluginSettingsState(pluginId)
    );
    runUnloadStep(pluginId, "clearPluginAccountState", () =>
      this.accounts.clearPluginState(pluginId)
    );
    // Same teardown for private storage: drops leftover subscriber-set entries
    // and the in-memory storage store caches so a reload starts from disk. A
    // discrete step (not bundled with settings) per the unload-cascade contract
    // — a throw here can't strand later cleanup (lessons #9322/#9533).
    runUnloadStep(pluginId, "clearPluginStorageState", () =>
      this.storage.clearPluginStorageState(pluginId)
    );

    // Kill every child process this plugin spawned via host.process.spawn
    // (#9234): clean SIGTERM, then SIGKILL after the grace window. Tied to the
    // plugin lifecycle so a disable/unload/revoke can't strand a dev server or
    // CI job. Best-effort — a throw here can't strand later steps.
    runUnloadStep(pluginId, "killManagedProcesses", () => {
      this.processManager?.killAll(pluginId);
    });

    // Tear down every active host.fs.watch watcher this plugin opened so a
    // disable/unload/revoke can't strand an fs.watch handle. Each disposer
    // closes its underlying watcher and removes itself from the set; copy the
    // set first since dispose() mutates it. Best-effort per the cascade contract.
    runUnloadStep(pluginId, "closeFsWatchers", () => {
      const watchers = this.pluginFsWatchers.get(pluginId);
      if (watchers) {
        for (const dispose of [...watchers]) {
          try {
            dispose();
          } catch (err) {
            console.error(`[PluginService] plugin "${pluginId}" fs watcher dispose threw:`, err);
          }
        }
        this.pluginFsWatchers.delete(pluginId);
      }
    });

    // Tear down any MCP servers contributed by this plugin (#9233). Best-effort
    // — a failing teardown is logged but cannot block the unload chain.
    runUnloadStep(pluginId, "shutdownMcpServers", () => {
      void getPluginMcpSupervisor()
        .shutdown({ pluginId })
        .catch((err) => {
          console.warn(`[PluginService] MCP supervisor shutdown for "${pluginId}" threw:`, err);
        });
    });

    // Drop the load-time-error marker (#9281) so a reload with a fixed
    // manifest can successfully clear `loadError` on next activation, and the
    // project instance's in-memory error (#12232) with it — nothing outlives
    // the load it describes.
    this.pluginsWithLoadTimeErrors.delete(pluginId);
    this.projectPluginLoadErrors.delete(pluginId);

    // The instance is leaving the inventory, so its runtime status goes with it
    // — unlike a worker teardown, which retains the status precisely because the
    // plugin is still there to explain (#12278). Emitted further down, once the
    // plugin itself is gone.
    this.workerStatuses.delete(pluginId);
    const scheduledSelfRestart = this.scheduledWorkerSelfRestarts.get(pluginId);
    if (scheduledSelfRestart !== undefined) clearImmediate(scheduledSelfRestart);
    this.scheduledWorkerSelfRestarts.delete(pluginId);
    this.workerSelfRestartAt.delete(pluginId);

    // Drop the diagnostic log ring buffer so a reload of the same plugin
    // doesn't carry forward log lines from the previous session.
    this.logBuffers.delete(pluginId);

    // Close out the plugin's file-log window: an unload is the last chance to
    // say how much a noisy plugin had dropped before it went.
    if (isProjectPluginInstanceKey(pluginId)) {
      this.writePluginFileLog(pluginId, "lifecycle", "Project plugin unloaded");
    }
    const suppressed = this.fileLogLimiter.drain(pluginId);
    if (suppressed) this.writePluginFileLogSummary(pluginId, suppressed);

    // Resolve any imperative UI prompt this plugin had open (#10522) — the
    // pending host.show* promise resolves undefined/false (never throws) and the
    // renderer dismisses the stranded dialog. Best-effort per the cascade.
    runUnloadStep(pluginId, "cancelUiPrompts", () =>
      this.promptDispatcher.cancelForPlugin(pluginId)
    );

    // Both `plugin://` keys die with the load. The authority is never reissued,
    // so a host-minted URL the renderer captured before this point 404s instead
    // of resolving into the next occupant of this plugin id; the manifest-id
    // alias is rebound by a reload, which is the id semantics a hand-written
    // URL asked for.
    this.invalidatePluginAuthority(pluginId);
    this.plugins.delete(pluginId);
    this.pluginWorkerActivity.delete(pluginId);
    this.metrics.evict(pluginId);
    this.hostBindings.delete(pluginId);
    // Every unload emits, worker or not: a plugin with only views has no
    // worker status, yet a renderer holding one of its settings views needs
    // the signal to retire it. Emitted after both deletes, so the renderer
    // receives a `null` (or, under a dev session, a null `viewGeneration`).
    this.emitRuntimeStatus(pluginId);
    this.contributions.releaseScope(pluginId);

    // Drop any live panel badges this plugin set and tell the renderer to clear
    // them (#10585). Only broadcast when the plugin actually had badges so an
    // unload of a non-badging plugin stays silent.
    if (this.runningActions.delete(pluginId)) {
      runUnloadStep(pluginId, "clearRunningActions", () => this.emitActionsRunning(pluginId));
    }

    // The clears below are the plugin's last word, so a coalesced badge or
    // activity publication still waiting is dropped. One may have been the
    // clear of the last badge a renderer still shows, so it forces the clear
    // even when the map is already empty (#14128).
    let discarded = new Set<string>();
    runUnloadStep(pluginId, "discardPendingState", () => {
      discarded = getPluginStatePublisher().discard(pluginId);
    });

    if (this.pluginBadges.delete(pluginId) || discarded.has(PLUGIN_STATE_PANEL_BADGES)) {
      runUnloadStep(pluginId, "clearPanelBadges", () => {
        broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
          name: "plugin:panel-badges-cleared",
          payload: { pluginId },
        });
      });
    }

    if (this.pluginToolbarBadges.delete(pluginId)) {
      runUnloadStep(pluginId, "clearToolbarBadges", () => this.emitToolbarBadges(pluginId));
    }

    if (this.pluginToolbarStates.delete(pluginId)) {
      runUnloadStep(pluginId, "clearToolbarStates", () => this.emitToolbarStates(pluginId));
    }

    if (this.pluginPanelActivity.delete(pluginId) || discarded.has(PLUGIN_STATE_PANEL_ACTIVITY)) {
      runUnloadStep(pluginId, "clearPanelActivity", () => this.emitPanelActivity(pluginId));
    }

    // After the plugin left `plugins`, so an abort listener that starts again
    // gets an inert handle instead of a task nothing will ever finish.
    runUnloadStep(pluginId, "interruptTasks", () => this.pluginTasks.interrupt(pluginId));

    // After the plugin left `plugins`, so a transfer racing the unload cannot
    // commit into a cache whose owner is gone.
    runUnloadStep(pluginId, "forgetArtifacts", () => this.artifactService?.forgetPlugin(pluginId));

    if (this.pluginContextKeys.delete(pluginId)) {
      runUnloadStep(pluginId, "clearContextKeys", () => this.emitContextKeys(pluginId));
    }

    runUnloadStep(pluginId, "clearWorktreeCardStatuses", () =>
      this.clearPluginWorktreeCardStatuses(pluginId)
    );

    runUnloadStep(pluginId, "clearWorktreeReviewChecks", () =>
      this.clearPluginWorktreeReviewChecks(pluginId)
    );

    runUnloadStep(pluginId, "clearTerminalStatuses", () =>
      this.clearPluginTerminalStatuses(pluginId)
    );

    runUnloadStep(pluginId, "clearPanelMenus", () => this.clearPluginPanelMenus(pluginId));

    if (decorationScopes && decorationScopes.length > 0) {
      runUnloadStep(pluginId, "broadcastDecorationsChanged", () => {
        for (const scope of new Set(decorationScopes)) {
          broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
            name: "plugin:decorations-changed",
            payload: { scope },
          });
        }
      });
    }
  }

  /**
   * Governance snapshots for the plugin-worker subsystem: one entry per
   * user-plugin worker (live or not-yet-forked) plus disabled/blocked plugins
   * (whose workers the unload cascade already cleared). Built-ins run
   * in-process and have no separable worker, so they are not reported.
   * Memory is joined by pid to `app.getAppMetrics()` in the governance
   * service, not here.
   */
  /**
   * What every plugin instance this project owns is doing right now, for the
   * sleep paths (#14093). Synchronous, so a sleep can ask it again at each of
   * its gates. App-global plugins are left out: closing a project never unloads
   * them, so nothing they run is the project's to protect or report.
   */
  getProjectPluginWork(projectId: string): ProjectPluginWork[] {
    const pluginIds = new Set([...this.plugins.keys(), ...this.pluginTasks.pluginIds()]);
    const work: ProjectPluginWork[] = [];
    for (const pluginId of pluginIds) {
      if (projectIdFromPluginInstanceKey(pluginId) !== projectId) continue;
      const liveTasks = this.pluginTasks
        .snapshot(pluginId)
        .filter((task) => task.state !== "interrupted")
        .map((task) => ({ id: task.id, pluginName: task.pluginName, title: task.title }));
      const bridge = this.pluginWorkers.get(pluginId)?.bridge;
      const pendingCalls = bridge ? bridge.pendingInvokeCount + bridge.pendingHostCallCount : 0;
      const runningProcesses = this.processManager?.runningCount(pluginId) ?? 0;
      if (liveTasks.length === 0 && pendingCalls === 0 && runningProcesses === 0) continue;
      work.push({ pluginId, liveTasks, pendingCalls, runningProcesses });
    }
    return work;
  }

  getWorkerGovernanceSnapshots(): WorkerResourceSnapshot[] {
    const snapshots: WorkerResourceSnapshot[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.isBuiltin) continue;
      const entry = this.pluginWorkers.get(pluginId);
      const loadError = this.getPluginLoadError(pluginId) ?? null;
      snapshots.push({
        kind: "plugin-worker",
        id: pluginId,
        pid: entry?.workerHost.pid ?? null,
        threadId: null,
        alive: entry?.workerHost.isReady() ?? false,
        activeSessionCount:
          (this.processManager?.runningCount(pluginId) ?? 0) +
          (this.pluginFsWatchers.get(pluginId)?.size ?? 0),
        queueDepth: entry ? entry.bridge.pendingInvokeCount + entry.bridge.pendingHostCallCount : 0,
        lastActivityAt: this.pluginWorkerActivity.get(pluginId) ?? null,
        memory: null,
        eligibility: {
          trim: false,
          dispose: entry ? this.canDisposeIdleWorker(pluginId).ok : false,
          restart: false,
        },
        state: entry ? (entry.workerHost.isReady() ? "running" : "starting") : "no-worker",
        detail: {
          builtin: false,
          devMode: plugin.devMode ?? false,
          activated: this.activatedPlugins.has(pluginId),
          panels: plugin.manifest.contributes.panels.length,
          bootError: loadError ? loadError.message : null,
        },
      });
    }
    for (const [pluginId, info] of this.disabledPlugins) {
      snapshots.push({
        kind: "plugin-worker",
        id: pluginId,
        pid: null,
        threadId: null,
        alive: false,
        activeSessionCount: 0,
        queueDepth: 0,
        lastActivityAt: null,
        memory: null,
        eligibility: { trim: false, dispose: false, restart: false },
        state: "disabled",
        detail: { builtin: info.isBuiltin },
      });
    }
    for (const [pluginId, info] of this.blockedPlugins) {
      snapshots.push({
        kind: "plugin-worker",
        id: pluginId,
        pid: null,
        threadId: null,
        alive: false,
        activeSessionCount: 0,
        queueDepth: 0,
        lastActivityAt: null,
        memory: null,
        eligibility: { trim: false, dispose: false, restart: false },
        state: "blocked",
        detail: { builtin: info.isBuiltin, reason: info.reason },
      });
    }
    return snapshots;
  }

  /**
   * Governance sweep: dispose the workers of idle plugins that expose no live
   * surface a dead worker could break (see {@link canDisposeIdlePluginWorker}
   * for the full disqualifier list). Deliberately conservative — most real
   * plugins keep a panel, subscription, or process alive and are never
   * eligible; the target is pure action/formatter plugins that were used once
   * and have sat cold since.
   */
  disposeIdlePluginWorkers(opts?: { now?: number; idleDisposeMs?: number }): {
    disposed: string[];
    skipped: number;
  } {
    const disposed: string[] = [];
    let skipped = 0;
    for (const pluginId of [...this.pluginWorkers.keys()]) {
      const verdict = this.canDisposeIdleWorker(pluginId, opts);
      if (!verdict.ok) {
        skipped++;
        continue;
      }
      if (this.deactivateWorker(pluginId)) {
        disposed.push(pluginId);
      } else {
        skipped++;
      }
    }
    if (disposed.length > 0) {
      console.log(
        `[PluginService] Governance disposed ${disposed.length} idle plugin worker(s): ${disposed.join(", ")}`
      );
    }
    return { disposed, skipped };
  }

  private canDisposeIdleWorker(
    pluginId: string,
    opts?: { now?: number; idleDisposeMs?: number }
  ): { ok: boolean; reason: string } {
    const plugin = this.plugins.get(pluginId);
    const entry = this.pluginWorkers.get(pluginId);
    if (!plugin || !entry) return { ok: false, reason: "not running" };
    if (this.enableTransitions.has(pluginId)) {
      return { ok: false, reason: "enable/disable transition in flight" };
    }
    // A settled activation leaves its promise in the map (the fast-path is
    // `activatedPlugins`); only an entry WITHOUT the activated latch is a
    // genuinely in-flight activation.
    if (!this.activatedPlugins.has(pluginId) && this.activationPromises.has(pluginId)) {
      return { ok: false, reason: "activation in flight" };
    }
    // Imperative (`host.registerAction`) actions die with the worker and have
    // no manifest descriptor to lazily re-fork through — a plugin that owns
    // any is never dispose-eligible (the documented command-plugin shape).
    let imperativeActionCount = 0;
    for (const actionId of this.pluginActionOwners.get(pluginId) ?? []) {
      if (!this.manifestCommandIds.has(actionId)) imperativeActionCount++;
    }
    return canDisposeIdlePluginWorker({
      isBuiltin: plugin.isBuiltin ?? false,
      devMode: plugin.devMode ?? false,
      panelContributionCount: plugin.manifest.contributes.panels.length,
      mcpServerContributionCount: plugin.manifest.contributes.mcpServers.length,
      startupActivation: this.shouldActivateOnStartup(plugin.manifest),
      eventSubscriptionCount: this.pluginEventCleanups.get(pluginId)?.length ?? 0,
      imperativeActionCount,
      pendingInvokeCount: entry.bridge.pendingInvokeCount,
      pendingHostCallCount: entry.bridge.pendingHostCallCount,
      managedProcessCount: this.processManager?.runningCount(pluginId) ?? 0,
      fsWatcherCount: this.pluginFsWatchers.get(pluginId)?.size ?? 0,
      liveTaskCount: this.pluginTasks.liveCount(pluginId),
      lastActivityAt: this.pluginWorkerActivity.get(pluginId) ?? null,
      now: opts?.now ?? Date.now(),
      idleDisposeMs: opts?.idleDisposeMs,
    });
  }

  /**
   * Narrow worker teardown: the worker, bridge, and activate-time imperative
   * registrations go; the plugin, its manifest contributions, and its
   * provenance record stay. The next lazy trigger (dispatch, panel open,
   * forge/decoration pull) re-forks via `activateViaWorker` exactly like a dev
   * reload re-registers over `clearPriorRegistrations` — that cycle is the
   * proof this teardown is re-entrant. Contrast `unloadPlugin`, which removes
   * the plugin entirely.
   *
   * Two callers: the idle-dispose sweep, and a terminal protocol violation
   * (#12276), which needs exactly this shape — the worker is unrecoverable, but
   * the plugin itself did nothing to lose its contributions, and clearing the
   * activation cache is what lets a re-open fork a fresh one.
   */
  private deactivateWorker(pluginId: string): boolean {
    const entry = this.pluginWorkers.get(pluginId);
    if (!entry) return false;
    // No-ops when the worker already FAILED — the cause the user needs shown
    // outranks the teardown that followed it (see `setWorkerStatus`).
    this.setWorkerStatus(pluginId, "stopped", "deactivated", null);
    this.activatedPlugins.delete(pluginId);
    this.activationPromises.delete(pluginId);
    // The services stay declared, so the next call starts a fresh worker; the
    // ones it bound, and any call a protocol violation cut short, go now.
    runUnloadStep(pluginId, "retireServices", () => this.services.retireInstance(pluginId));
    const cleanup = this.cleanupMap.get(pluginId);
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(`[PluginService] Worker teardown cleanup for "${pluginId}" threw:`, err);
      }
      this.cleanupMap.delete(pluginId);
    }
    // Activate-time imperative registrations — the same set the dev-reload
    // cycle clears before a worker re-registers.
    this.removeHandlers(pluginId);
    this.unregisterImperativePluginActions(pluginId);
    this.flushPluginEventCleanups(pluginId);
    // Impls are proxies bound to the dead worker; manifest descriptors stay so
    // the lazy triggers keep routing. Belt calls — the eligibility gate already
    // required zero live subscriptions.
    runUnloadStep(pluginId, "unregisterForgeProviderImpls", () =>
      unregisterForgeProviderImpls(pluginId)
    );
    runUnloadStep(pluginId, "unregisterFileDecorationProviderImpls", () =>
      unregisterFileDecorationProviderImpls(pluginId)
    );
    runUnloadStep(pluginId, "unregisterWorktreeSetupStepHandlers", () =>
      unregisterWorktreeSetupStepHandlers(pluginId)
    );
    runUnloadStep(pluginId, "unregisterContextProviderImpls", () =>
      unregisterContextProviderImpls(pluginId)
    );
    runUnloadStep(pluginId, "unregisterWorktreeDeleteNotesBinding", () =>
      unregisterWorktreeDeleteNotesBinding(pluginId)
    );
    runUnloadStep(pluginId, "cancelUiPrompts", () =>
      this.promptDispatcher.cancelForPlugin(pluginId)
    );
    return true;
  }

  /**
   * Flatten one plugin's live badges (`panelId → badge`) into a plain
   * structured-clone-safe record for the `plugin:panel-badges-changed`
   * broadcast. Empty when the plugin has no badges (the renderer reads that as
   * "clear all of this plugin's badges").
   */
  private serializePluginBadges(pluginId: string): Record<string, PluginPanelBadge> {
    const panelMap = this.pluginBadges.get(pluginId);
    if (!panelMap || panelMap.size === 0) return {};
    return Object.fromEntries(panelMap);
  }

  /** Drop every runtime panel menu a plugin published, telling renderers only when there were any. */
  private clearPluginPanelMenus(pluginId: string): void {
    if (!this.pluginPanelMenus.delete(pluginId)) return;
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:panel-menus-changed",
      payload: { pluginId, menus: {} },
    });
  }

  /** One plugin's runtime panel menus (`panelId → items`), empty when it has none. */
  private serializePluginPanelMenus(
    pluginId: string
  ): Record<string, readonly PublishedPanelMenuItem[]> {
    const panelMap = this.pluginPanelMenus.get(pluginId);
    if (!panelMap || panelMap.size === 0) return {};
    return Object.fromEntries(panelMap);
  }

  private flushPluginEventCleanups(pluginId: string): void {
    const list = this.pluginEventCleanups.get(pluginId);
    if (!list || list.length === 0) {
      this.pluginEventCleanups.delete(pluginId);
      return;
    }
    // Snapshot & clear before invoking so each dispose() call (which mutates
    // the list via splice) doesn't interfere with iteration.
    this.pluginEventCleanups.delete(pluginId);
    for (const dispose of [...list]) {
      try {
        dispose();
      } catch (err) {
        console.error(`[PluginService] Event cleanup for "${pluginId}" threw during unload:`, err);
      }
    }
  }

  /**
   * Look up a single `contributes.mcpServers` entry by id along
   * with the plugin's resolved on-disk directory. Used by the
   * `plugin-mcp:restart` IPC handler to feed the supervisor a fresh
   * contribution (with re-resolved `${settings:*}` substitutions) on each
   * restart, plus the cwd the child process should anchor against.
   */
  findMcpServerContribution(
    pluginId: string,
    serverId: string
  ):
    | {
        contribution: PluginManifest["contributes"]["mcpServers"][number];
        pluginDir: string;
      }
    | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    const contribution = plugin.manifest.contributes.mcpServers.find((c) => c.id === serverId);
    if (!contribution) return undefined;
    return { contribution, pluginDir: plugin.dir };
  }

  /**
   * The loaded instance's `agentMcp` endpoint that serves tools from one of its
   * own `mcpServers`, with that server's entry and the instance's directory —
   * everything the host needs to start the server on this backend and serve
   * the chosen tools. `undefined` for an instance with no such endpoint, or one
   * without `mcp:expose`, which the agent route never serves.
   */
  findAgentMcpServerSource(pluginInstanceId: string): AgentMcpServerSourceLookup | undefined {
    const plugin = this.plugins.get(pluginInstanceId);
    if (!plugin || !plugin.manifest.capabilities?.includes("mcp:expose")) return undefined;
    const endpoint = (plugin.manifest.contributes.agentMcp ?? []).find((entry) => entry.source);
    const source = endpoint?.source;
    if (!endpoint || !source) return undefined;
    const contribution = plugin.manifest.contributes.mcpServers.find(
      (server) => server.id === source.mcpServer
    );
    if (!contribution) return undefined;
    return {
      endpointId: endpoint.id,
      groups: (endpoint.groups ?? []).map((group) => ({ id: group.id, access: group.access })),
      source,
      contribution,
      pluginDir: plugin.dir,
      declaredQueryNames: (plugin.manifest.contributes.databases ?? []).flatMap((database) =>
        (database.queries ?? []).map((query) => query.name)
      ),
    };
  }

  /**
   * Resolve the consent-facing metadata for a loaded plugin — the display name
   * and declared capabilities the plugin-MCP `tools/call` handler folds into the
   * consent prompt and tier derivation. Returns `undefined` when the plugin is
   * not currently loaded (e.g. a renderer race with unload).
   */
  getMcpConsentMeta(
    pluginId: string
  ):
    | { pluginDisplayName: string; manifestCapabilities: readonly BuiltInPluginCapability[] }
    | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    return {
      pluginDisplayName: plugin.manifest.displayName ?? plugin.manifest.name,
      manifestCapabilities: plugin.manifest.capabilities ?? [],
    };
  }

  /**
   * The user-facing name of a loaded plugin — what any surface that names a
   * plugin to a person should print instead of its id.
   *
   * The id is an instance key for a project-owned plugin, so printing it raw
   * leaks `project__{projectId}__{manifestId}` into the UI (#12211). An
   * unloaded plugin falls back to its manifest id rather than the instance key,
   * which keeps even the miss path free of the machine-local project id.
   */
  getPluginDisplayName(pluginId: string): string {
    const manifest = this.plugins.get(pluginId)?.manifest;
    if (!manifest) return pluginManifestIdFromInstanceKey(pluginId);
    return manifest.displayName || manifest.name;
  }

  /**
   * Resolve a `${settings:<id>}` template by reading the named user-scope
   * setting and stringifying the value. Booleans and numbers become their
   * JSON representation; objects/arrays become JSON-encoded strings. An
   * undefined or missing setting resolves to the empty string so the
   * substituted command remains a valid argv entry rather than a literal
   * `"undefined"`.
   */
  async resolveSettingTemplate(pluginId: string, settingId: string): Promise<string> {
    return this.settings.resolveSettingTemplate(pluginId, settingId);
  }

  listPlugins(): LoadedPluginInfo[] {
    // Desired state is the persisted list; the running state is `this.plugins`
    // (loaded) vs `this.disabledPlugins` (skipped). Both built-ins (#9304) and
    // user plugins (#10887) transition live via `_applyEnabledToggle`, which
    // moves the entry between the maps (and re-forks the worker for user
    // plugins). `pendingRestart` can only read true transiently — during the
    // brief in-flight window between the persist landing and the live transition
    // settling — after which the maps match again and it clears. Reporting both
    // keeps the switch position and the cue correct across a tab remount.
    const desiredDisabled = this.records.getDisabledIds();
    const installed = this.records.getInstalledRecords();

    // `instanceId` is the MAP KEY, not `manifest.name`: for a project-owned
    // plugin those differ, and the key is what every contribution carries as
    // its `pluginId`/`extensionId`. Dropping it here is what left the renderer
    // unable to match a contribution to its plugin (#12211).
    const toInfo = (
      instanceId: string,
      p: { manifest: PluginManifest; dir: string; isBuiltin: boolean },
      loadedAt: number,
      isRunning: boolean,
      blocklistReason?: string
    ): LoadedPluginInfo => {
      const projectId = projectIdFromPluginInstanceKey(instanceId);
      const isProject = projectId !== null;
      const identity = {
        instanceId,
        origin: isProject ? ("project" as const) : ("global" as const),
        projectId,
      };
      // Both of these are keyed by manifest id, and a project plugin is allowed
      // to share its manifest id with an installed one — so consulting either
      // for a project row hands it the *other* plugin's state. The disable list
      // is explicitly about installed and builtin plugins (a project plugin's
      // gate is its project's trust decision, see the load path), and the
      // install record belongs to the global copy. A project instance only ever
      // reaches this projection from the running map, so it is never disabled.
      const disabled = isProject ? false : desiredDisabled.has(p.manifest.name);
      // pendingRestart: desired state diverges from running state.
      // Running + now-disabled → unload pending; skipped + now-enabled → load pending.
      // Blocklisted plugins are host-refused, not user-toggled — no pending cue.
      const blocklisted = blocklistReason !== undefined;
      const pendingRestart = blocklisted ? false : isRunning ? disabled : !disabled;
      const pluginDanger = computePluginDanger(p.manifest);
      if (p.isBuiltin) {
        return {
          ...identity,
          manifest: p.manifest,
          dir: p.dir,
          loadedAt,
          isBuiltin: true,
          source: "builtin",
          installedAt: 0,
          archiveHash: null,
          originalUrl: null,
          loadError: null,
          disabled,
          updateAvailable: null,
          devMode: false,
          pendingRestart,
          pluginDanger,
          blocklisted,
          blocklistReason,
        };
      }
      const record = isProject ? undefined : installed[p.manifest.name];
      return {
        ...identity,
        manifest: p.manifest,
        dir: p.dir,
        loadedAt,
        isBuiltin: false,
        source: record?.source ?? "sideload",
        installedAt: record?.installedAt ?? 0,
        updatedAt: record?.updatedAt,
        archiveHash: record?.archiveHash ?? null,
        originalUrl: record?.originalUrl ?? null,
        // A blocklisted plugin is a policy refusal, not a technical failure —
        // suppress any stale activation error so the UI shows only "Blocked".
        //
        // Read by INSTANCE key rather than off `record` (#12232). `record` is
        // deliberately undefined for a project row — the install records are
        // keyed by manifest id and belong to the global copy — so every other
        // field above is *inapplicable* to a project plugin, but this one would
        // be silently wrong: a plugin that loaded and then failed would report
        // a clean load to the plugin manager and to the diagnostics snapshot
        // (#12222), which both read this row. For a global plugin the instance
        // key IS `manifest.name`, so this resolves to the same record field it
        // was already reading.
        loadError: blocklisted ? null : (this.getPluginLoadError(instanceId) ?? null),
        disabled,
        updateAvailable: record?.updateAvailable ?? null,
        devMode: record?.devMode ?? false,
        pendingRestart,
        pluginDanger,
        blocklisted,
        blocklistReason,
      };
    };

    // Plugins that loaded and are running this session. Iterated by ENTRY: the
    // map key is the registry id, which diverges from `manifest.name` for a
    // project plugin and is the only thing that names the instance.
    const running = [...this.plugins].map(([id, p]) => toInfo(id, p, p.loadedAt, true));

    // Plugins skipped at launch because they were disabled. They carry no
    // `loadedAt` — the main module never ran — so it's reported as 0.
    const skipped = [...this.disabledPlugins].map(([id, p]) => toInfo(id, p, 0, false));

    // Plugins refused at launch by the blocklist / kill-switch (#10891). Also
    // never ran (`loadedAt: 0`); the reason drives the "Blocked" badge/banner.
    const blocked = [...this.blockedPlugins].map(([id, p]) => toInfo(id, p, 0, false, p.reason));

    // Installed packages that run one instance per project. The package itself
    // never loads, so its row would otherwise exist only while it is switched
    // off — and re-enabling one used to drop it from the list entirely. An
    // enable in flight briefly holds it in both the catalog and the disabled
    // map; the disabled row stands in until the transition settles.
    const catalog = [...this.projectInstancePackages]
      .filter(([id]) => !this.disabledPlugins.has(id) && !this.blockedPlugins.has(id))
      .map(([id, p]) => ({
        ...toInfo(
          id,
          { manifest: p.manifest as PluginManifest, dir: p.dir, isBuiltin: false },
          0,
          false
        ),
        // Not running is the steady state of a catalog entry, not a load waiting on a restart.
        pendingRestart: false,
      }));

    return [...running, ...skipped, ...blocked, ...catalog].map((info) =>
      info.origin === "global" && !info.isBuiltin && info.manifest.instanceMode === "project"
        ? {
            ...info,
            instanceMode: "project" as const,
            enabledInProjects: this.projectInstanceStore.listForPackage(info.instanceId),
          }
        : info
    );
  }

  /**
   * Resolve a `plugin://` URL authority to the plugin root that serves it.
   * Accepts either the opaque per-load authority or a plugin's manifest id,
   * which is seeded as an alias for the same root. Returns `undefined` when the
   * authority is unknown, was invalidated by an unload, or names a plugin that
   * was skipped at load (disabled in Preferences).
   *
   * Used by the `plugin://` protocol handler to map URL hosts to filesystem
   * roots without exposing the private `plugins` map.
   */
  getPluginRootByAuthority(authority: string): string | undefined {
    return this.pluginRootsByAuthority.get(authority)?.dir;
  }

  /** The root a `plugin://` authority serves and the instance key of the load that owns it. */
  resolvePluginAuthority(authority: string): { dir: string; pluginId: string } | undefined {
    const entry = this.pluginRootsByAuthority.get(authority);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Mint the `plugin://` authority for a load and seed both of its keys.
   *
   * The token comes from a CSPRNG and is never derived from the manifest id —
   * derivation would reintroduce the id collision the authority exists to
   * prevent. It is not a secret: it is a namespace, not a capability, so
   * nothing may authorize on possession of one.
   */
  private mintPluginAuthority(pluginId: string, dir: string): PluginProtocolAuthority {
    this.invalidatePluginAuthority(pluginId);
    const authority = `pi-${randomBytes(16).toString("hex")}` as PluginProtocolAuthority;
    this.pluginAuthorities.set(pluginId, authority);
    this.pluginRootsByAuthority.set(authority, { dir, pluginId });
    this.pluginRootsByAuthority.set(pluginId, { dir, pluginId });
    return authority;
  }

  /** Drop both keys a load seeded, so every URL addressing it 404s from here on. */
  private invalidatePluginAuthority(pluginId: string): void {
    const previous = this.pluginAuthorities.get(pluginId);
    if (previous) this.pluginRootsByAuthority.delete(previous);
    this.pluginAuthorities.delete(pluginId);
    this.pluginRootsByAuthority.delete(pluginId);
  }

  /**
   * Toggle a plugin's disabled state in Preferences (#9284). Persists to
   * `plugins.disabled` in electron-store, then applies the change live (#9304,
   * #10887): disabling unloads the running plugin, enabling re-registers and
   * re-activates it, so the toggle takes effect without an app restart. This
   * covers both built-in and user plugins — user (non-builtin) plugins activate
   * inside a fresh `utilityProcess.fork` worker per lifecycle (#10526), so a
   * toggle-driven reload reads the bundle fresh off disk in a new module realm;
   * the old ESM-cache-staleness rationale for excluding them no longer applies
   * (built-ins keep their bundled, immutable `activate()` on the in-process
   * loader — the only branch, resolved inside `loadPlugin`/`_doActivate`).
   *
   * Persists first so a crash mid-transition is recoverable: next launch reads
   * the persisted intent and reaches the same state. Idempotent: toggling to
   * the current state is a no-op write and a no-op transition. Permissive by
   * design — the store is a declared-intent list, so no existence check.
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    // Persist intent first (throws on an empty id, validated in the store).
    this.records.setEnabled(pluginId, enabled);

    // Only a plugin known this session (running or skipped-at-launch) has state
    // to transition live; an unknown id stays persist-only (its intent is
    // recorded for the next scan). Guarding here also keeps the isBuiltin choice
    // where it belongs — inside `_applyEnabledToggle`, derived from the map entry.
    if (
      !this.plugins.has(pluginId) &&
      !this.disabledPlugins.has(pluginId) &&
      !this.projectInstancePackages.has(pluginId)
    ) {
      return;
    }

    // Serialise live transitions per id so concurrent toggles can't interleave
    // their unload/load map mutations. Swallow the prior chain's rejection —
    // `_applyEnabledToggle` never rejects, but the guard keeps the chain alive.
    const prior = this.enableTransitions.get(pluginId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this._applyEnabledToggle(pluginId, enabled));
    this.enableTransitions.set(pluginId, next);
    try {
      await next;
    } finally {
      if (this.enableTransitions.get(pluginId) === next) {
        this.enableTransitions.delete(pluginId);
      }
    }
  }

  /**
   * Apply a live enable/disable transition for a plugin — built-in or user
   * (#9304, #10887). Disable: tear the running plugin down through the full
   * `unloadPlugin()` cascade (which disposes a user plugin's activation worker
   * via its `cleanup` closure), then move its manifest into `disabledPlugins`
   * so `listPlugins()` keeps surfacing it for the toggle. Enable: clear the name
   * reservation and skipped entry (so `loadPlugin`'s duplicate guard doesn't
   * reject the re-load), re-register from the cached manifest dir, then activate
   * — a user plugin re-forks a fresh worker (#10526). The real `isBuiltin` is
   * carried through the disabled entry into `loadPlugin` so `_doActivate` routes
   * built-ins in-process and user plugins to the worker. Always broadcasts
   * provenance so every view re-pulls `listPlugins()` and the restart-required
   * cue clears. Never throws — activation errors are persisted to `loadError`
   * inside `activatePlugin`, and a failed re-register restores the skipped state.
   */
  private async _applyEnabledToggle(pluginId: string, enabled: boolean): Promise<void> {
    try {
      if (!enabled) {
        const running = this.plugins.get(pluginId);
        const catalogued = this.projectInstancePackages.get(pluginId);
        if (!running && catalogued) {
          this.unloadPackageInstances(pluginId, { uninstall: false, purge: false });
          this.projectInstancePackages.delete(pluginId);
          this.disabledPlugins.set(pluginId, {
            manifest: catalogued.manifest as PluginManifest,
            dir: catalogued.dir,
            isBuiltin: false,
          });
          this.reservedNames.add(pluginId);
          return;
        }
        if (!running) return; // already not running — nothing to unload
        const { manifest, dir, isBuiltin } = running;
        this.unloadPlugin(pluginId);
        this.disabledPlugins.set(pluginId, { manifest, dir, isBuiltin });
        this.reservedNames.add(pluginId);
        return;
      }

      const entry = this.disabledPlugins.get(pluginId);
      if (!entry) return; // already running — nothing to load
      // Release ONLY the name reservation up front (the duplicate guard's actual
      // gate), but keep the disabledPlugins entry in place across the async load.
      // This keeps the id resolvable at every await point, so a concurrent
      // setEnabled reaching `_applyEnabledToggle` still sees a known plugin while
      // the load is mid-flight. loadPlugin() with an empty disabled set never
      // touches disabledPlugins, so the entry is safe.
      this.reservedNames.delete(pluginId);
      let loaded: LoadedPlugin | null = null;
      try {
        loaded = await this.loadPlugin(path.dirname(entry.dir), path.basename(entry.dir), {
          isBuiltin: entry.isBuiltin,
          disabled: new Set<string>(),
        });
      } catch (err) {
        // A throw (e.g. a malformed `when` expression in the manifest) must not
        // strand the plugin in neither map — fall through to the restore path.
        console.error(`[PluginService] Re-load of "${pluginId}" threw:`, err);
      }
      if (!loaded && this.projectInstancePackages.has(pluginId)) {
        this.disabledPlugins.delete(pluginId);
        void this.reloadPackageInstances(pluginId);
        return;
      }
      if (!loaded) {
        // Manifest error or a throw: restore the reservation. The
        // disabledPlugins entry was never removed, so the row stays visible.
        // Persisted intent stays "enabled" → pendingRestart:true.
        this.reservedNames.add(pluginId);
        return;
      }
      // Loaded: it's now in `plugins`. Drop the skipped entry synchronously
      // (no await before this line) so the two maps never both miss the id.
      this.disabledPlugins.delete(pluginId);
      await this.activatePlugin(pluginId);
    } finally {
      this.broadcaster.broadcastProvenanceChanged();
    }
  }

  /**
   * Remove a non-builtin plugin from the running session, delete its on-disk
   * install, and drop its provenance record. The full unload + delete + consent
   * purge + MCP shutdown + record-removal orchestration lives in
   * {@link PluginInstaller}; this thin delegate preserves the public signature
   * IPC handlers call. `deleteSettings` defaults to `false` so stored secrets
   * survive a reinstall.
   */
  async uninstallPlugin(pluginId: string, deleteSettings = false): Promise<void> {
    return this.installer.uninstallPlugin(pluginId, deleteSettings);
  }

  /**
   * Record the archive hash for a loaded plugin. Called by the installer (F21)
   * after computing SHA-256 over the `.dntr` archive bytes.
   * Rejects non-hex inputs — only lowercase SHA-256 hex digests are valid.
   */
  setPluginArchiveHash(pluginId: string, archiveHash: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      if (this.projectInstancePackages.has(pluginId) && /^[a-f0-9]{64}$/.test(archiveHash)) {
        this.records.upsertInstalledRecord(pluginId, { archiveHash });
      }
      return;
    }
    if (!/^[a-f0-9]{64}$/.test(archiveHash)) {
      console.warn(
        `[PluginService] setPluginArchiveHash for "${pluginId}": invalid hash format, ignoring`
      );
      return;
    }
    plugin.archiveHash = archiveHash;
    if (!plugin.isBuiltin) {
      this.records.upsertInstalledRecord(pluginId, { archiveHash });
    }
  }

  /**
   * Most recent activation error for a plugin id, or `undefined` if the last
   * load succeeded (or the plugin has never been loaded). An installed plugin
   * reads from the persisted provenance record so the error survives a host
   * restart; a project plugin reads the session-scoped
   * {@link projectPluginLoadErrors} map, which is the only channel it has.
   *
   * The two are exclusive rather than layered. A project instance key is never
   * written to `plugins.installed`, so a record found under one could only be
   * stale or hand-forged — falling back to it would let either outlive the
   * load it describes.
   */
  getPluginLoadError(pluginId: string): PluginLoadError | undefined {
    if (isProjectPluginInstanceKey(pluginId)) {
      return this.projectPluginLoadErrors.get(pluginId);
    }
    return this.records.getInstalledRecord(pluginId)?.loadError ?? undefined;
  }

  /**
   * Record — or clear, with `null` — a plugin's most recent load/activation
   * error on whichever channel owns that plugin id: the in-memory map for a
   * project instance, the durable provenance record for anything else.
   * Built-ins have neither and are dropped here rather than at seven call
   * sites (the documented limitation on {@link activatePluginForView}).
   *
   * Returns whether the error reached a channel, which is the same question
   * the callers' old `!isBuiltin` guard answered — so `pluginsWithLoadTimeErrors`
   * keeps its existing membership — plus a generation check the id-keyed
   * channels need and the durable one never did. The check is object identity,
   * not presence: a project plugin unloads and reloads under the same key on
   * every disable/enable, dev reload and project reopen, so a late
   * `onActivationResult` or activation timeout belonging to the previous load
   * would otherwise pin its error on the healthy new one.
   */
  private recordPluginLoadError(
    pluginId: string,
    plugin: LoadedPlugin,
    loadError: PluginLoadError | null
  ): boolean {
    if (this.plugins.get(pluginId) !== plugin) return false;
    if (plugin.isBuiltin) return false;
    this.fileLogLoadError(pluginId, plugin, loadError);
    if (!isProjectPluginInstanceKey(pluginId)) {
      this.records.upsertInstalledRecord(pluginId, { loadError });
      return true;
    }

    const previous = this.projectPluginLoadErrors.get(pluginId);
    if (loadError === null) {
      if (previous === undefined) return true;
      this.projectPluginLoadErrors.delete(pluginId);
    } else {
      // A repeat of the same failure says nothing new, so keep `at` current but
      // skip the push — otherwise a plugin failing every retry spams the
      // renderer with snapshots whose rows are identical.
      if (previous?.message === loadError.message && previous.stack === loadError.stack) {
        this.projectPluginLoadErrors.set(pluginId, loadError);
        return true;
      }
      this.projectPluginLoadErrors.set(pluginId, loadError);
    }
    // The project plugin list carries this row, and a lazily-activated plugin
    // fails with no other mutation behind it to ride out on — without a push
    // the manager would keep describing a plugin that failed as a clean one.
    // Read through the field, not the lazy getter: an error must never be the
    // thing that constructs the controller.
    this.projectPluginController?.notifyLoadErrorChanged(pluginId);
    return true;
  }

  /**
   * Put a load error in `daintree.log` — for a project plugin the in-memory map
   * is otherwise its only record, and that dies with the process. Repeats
   * within one load are written once; `null` re-arms the next failure.
   */
  private fileLogLoadError(
    pluginId: string,
    plugin: LoadedPlugin,
    loadError: PluginLoadError | null
  ): void {
    if (loadError === null) {
      this.fileLoggedLoadErrors.delete(plugin);
      return;
    }
    const signature = `${loadError.message}\n${loadError.stack ?? ""}`;
    if (this.fileLoggedLoadErrors.get(plugin) === signature) return;
    // Keys avoid `error`, which `logger.error` overwrites with its own error
    // argument. Marked as logged only once admitted, so a failure that lost
    // out to a burst is still written on its next attempt.
    const written = this.writePluginFileLog(pluginId, "error", "Plugin failed to load", {
      loadErrorMessage: boundPluginFileLogText(loadError.message),
      ...(loadError.stack ? { loadErrorStack: boundPluginFileLogText(loadError.stack) } : {}),
    });
    if (written) this.fileLoggedLoadErrors.set(plugin, signature);
  }

  /**
   * Validate a plugin action contribution and build its host-authoritative
   * descriptor. Shared by the renderer IPC path ({@link registerPluginAction},
   * which throws on duplicate) and the main-side `host.registerAction` path
   * (which replaces on duplicate) — so the duplicate check is deliberately NOT
   * performed here. The caller must pass the already-namespaced
   * `contribution.id` (`{pluginId}.{actionId}`).
   */
  private validateAndBuildActionDescriptor(
    pluginId: string,
    contribution: PluginActionContribution
  ): PluginActionDescriptor {
    if (!this.plugins.has(pluginId)) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    if (!contribution || typeof contribution !== "object") {
      throw new Error("Plugin action contribution must be an object");
    }
    const { title, description, category, kind, danger } = contribution;
    const rawId = contribution.id;
    if (typeof rawId !== "string" || !PLUGIN_ACTION_ID_RE.test(rawId)) {
      throw new Error(
        `Plugin action id "${rawId}" is invalid. Expected "{pluginId}.{actionId}" (lowercase start, alphanumerics, dot/dash/underscore).`
      );
    }
    // A project plugin's code only knows its MANIFEST id — it is never told the
    // instance key, and telling it would hand it another project's namespace to
    // guess at. So `host.registerAction("acme.dash.foo")` is accepted from the
    // instance that declares `acme.dash` and normalised to the instance
    // namespace here, which is what keeps two projects' identically-named
    // actions from overwriting each other in the global action map.
    const manifestId = this.plugins.get(pluginId)?.manifest.name;
    const manifestPrefix =
      manifestId !== undefined && manifestId !== pluginId ? `${manifestId}.` : null;
    let id = rawId;
    if (!rawId.startsWith(`${pluginId}.`)) {
      if (manifestPrefix !== null && rawId.startsWith(manifestPrefix)) {
        id = `${pluginId}.${rawId.slice(manifestPrefix.length)}`;
      } else {
        throw new Error(
          `Plugin "${pluginId}" cannot register action "${rawId}": id must be prefixed with the plugin's own id.`
        );
      }
    }

    if (typeof title !== "string" || !title.trim()) {
      throw new Error(`Plugin action "${id}" must have a non-empty title`);
    }
    if (typeof description !== "string") {
      throw new Error(`Plugin action "${id}" must have a string description`);
    }
    if (typeof category !== "string" || !normalizePluginActionCategory(category)) {
      throw new Error(`Plugin action "${id}" must have a non-empty category`);
    }
    // The category is a sub-label inside the plugin's own palette group, so a
    // built-in id would pass for that built-in group's name.
    const normalizedCategory = normalizePluginActionCategory(category);
    if (normalizedCategory.length > PLUGIN_ACTION_CATEGORY_MAX_LENGTH) {
      throw new Error(
        `Plugin action "${id}" category is longer than ${PLUGIN_ACTION_CATEGORY_MAX_LENGTH} characters`
      );
    }
    if (isReservedActionCategory(normalizedCategory)) {
      throw new Error(
        `Plugin action "${id}" category "${normalizedCategory}" is reserved for a built-in group. Pick your own label.`
      );
    }
    const when = this.validateActionClause(id, "when", contribution.when);
    const enablement = this.validateActionClause(id, "enablement", contribution.enablement);
    if (!PLUGIN_ACTION_KINDS.has(kind as string)) {
      throw new Error(`Plugin action "${id}" has invalid kind "${kind}"`);
    }
    if (!PLUGIN_ACTION_DANGERS.has(danger as string)) {
      throw new Error(
        `Plugin action "${id}" has invalid danger "${danger}". Plugins may only register "safe" or "confirm" actions.`
      );
    }

    // Host-authoritative danger: the plugin's self-reported `danger` is
    // advisory. Raise it to "confirm" (never lower) when the plugin holds a
    // high-risk capability or a compound-capability pair (#9247), so a plugin
    // can't declare "safe" on a destructive action to slip past the renderer's
    // confirm/MRU/repeatLast gates.
    const manifest = this.plugins.get(pluginId)?.manifest;
    const manifestCapabilities = manifest?.capabilities ?? [];

    // Per-action capability intent (#11299). `requires` narrows *which*
    // capabilities the derivation below consults — it never changes who
    // derives the verdict, and it grants no access (host APIs still gate on
    // manifest.capabilities at call time). Validated fail-closed as a subset
    // of the manifest, mirroring PluginChannelRegistry.registerHandler, so an
    // action can't name authority the user was never asked to grant.
    const requires = this.validateActionRequires(pluginId, id, contribution, manifestCapabilities);

    // Omitted (not merely empty) means "no intent declared" — fall back to the
    // whole manifest so pre-#11299 plugins keep today's conservative
    // elevation. An explicit `[]` is a real declaration meaning "this action
    // exercises nothing" and must reach the checks below as an empty set.
    // The trap to avoid is any emptiness test (`requires.length > 0 ? … : …`)
    // that folds `[]` back into the omitted case and silently re-elevates
    // every opted-in action; `??` would be equivalent to this ternary, since
    // validateActionRequires rejects a null.
    // Compiled before anything is returned, so a contract the host can't
    // enforce refuses the registration rather than publishing a schema that
    // nothing checks.
    const compiledResult =
      contribution.resultSchema === undefined
        ? undefined
        : compilePluginActionResultSchema(id, contribution.resultSchema);

    const dangerCapabilities = requires === undefined ? manifestCapabilities : requires;
    const hasHighRiskCapability = dangerCapabilities.some((p) =>
      CONFIRM_TRIGGERING_CAPABILITIES.has(p)
    );
    const hasCompoundElevation = manifestTriggersCompoundElevation(manifest, dangerCapabilities);
    const effectiveDanger: "safe" | "confirm" =
      danger === "confirm" || hasHighRiskCapability || hasCompoundElevation ? "confirm" : "safe";

    const descriptor: PluginActionDescriptor = {
      pluginId,
      // From the manifest, never the contribution: a plugin names itself once.
      pluginName: manifest?.displayName?.trim() || manifest?.name,
      id,
      title,
      description,
      category: normalizedCategory,
      kind,
      danger,
      effectiveDanger,
      when,
      enablement,
      keywords: Array.isArray(contribution.keywords) ? [...contribution.keywords] : undefined,
      inputSchema:
        contribution.inputSchema && typeof contribution.inputSchema === "object"
          ? { ...contribution.inputSchema }
          : undefined,
      resultSchema: compiledResult?.schema,
      requires,
    };
    if (compiledResult) this.actionResultChecks.set(descriptor, compiledResult.check);
    return descriptor;
  }

  /**
   * Validate a command's optional `when` / `enablement` clause. Refused rather
   * than dropped: a clause that never parses would otherwise hide (or grey out)
   * the command for good with nothing pointing at the typo.
   */
  private validateActionClause(
    actionId: string,
    field: "when" | "enablement",
    raw: unknown
  ): string | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`Plugin action "${actionId}" has an empty or non-string "${field}" clause`);
    }
    try {
      parseWhenClause(raw);
    } catch (err) {
      throw new Error(
        `Plugin action "${actionId}" has an invalid "${field}" clause: ${formatErrorMessage(err, "could not parse")}`,
        { cause: err }
      );
    }
    return raw;
  }

  /**
   * Validate a contribution's optional per-action capability intent (#11299)
   * and return a defensive copy, or `undefined` when the action declared none.
   *
   * Fail-closed on every rejection path: an unknown token, a token the plugin
   * never declared, or a malformed value throws rather than being dropped.
   * Silently ignoring a bad `requires` would be the dangerous failure — the
   * action would fall back to whole-manifest elevation, which is safe, but the
   * author's typo would go unreported until someone wondered why their action
   * still confirms. Throwing surfaces it at load, matching how
   * `PluginChannelRegistry` handles the same mistake on channels.
   *
   * `requires` is copied because the descriptor is broadcast to renderers and
   * cached; sharing the plugin's array would let a plugin mutate a
   * host-authoritative record after validation.
   */
  private validateActionRequires(
    pluginId: string,
    actionId: string,
    contribution: PluginActionContribution,
    manifestCapabilities: readonly BuiltInPluginCapability[]
  ): readonly BuiltInPluginCapability[] | undefined {
    // Typed as `readonly BuiltInPluginCapability[]`, but the main-side
    // `host.registerAction` path hands us whatever the plugin passed, so the
    // runtime shape is genuinely unknown and every check below earns its keep.
    const raw: unknown = contribution.requires;
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      throw new Error(
        `Plugin action "${actionId}" has invalid "requires": expected an array of capabilities`
      );
    }
    const declared: ReadonlySet<string> = new Set(manifestCapabilities);
    const validated: BuiltInPluginCapability[] = [];
    for (const cap of raw) {
      if (!isBuiltInPluginCapability(cap)) {
        throw new Error(
          `Plugin action "${actionId}" lists unknown capability "${String(cap)}" in "requires"`
        );
      }
      if (!declared.has(cap)) {
        throw new Error(
          `PERMISSION_REQUIRED: action "${actionId}" requires capability "${cap}" which is not declared in plugin "${pluginId}" manifest.capabilities`
        );
      }
      validated.push(cap);
    }
    return validated;
  }

  /**
   * Register a runtime-contributed action for a loaded plugin (renderer IPC
   * path). Validates id format, namespace ownership, and rejects "restricted"
   * danger. Throws if the action id is already registered — re-registration
   * from the renderer is a plugin authoring bug. The main-side
   * `host.registerAction` path uses replace semantics instead.
   * Broadcasts the full action list to all renderers so windows stay in sync.
   */
  registerPluginAction(pluginId: string, contribution: PluginActionContribution): void {
    const descriptor = this.validateAndBuildActionDescriptor(pluginId, contribution);
    if (this.pluginActions.has(descriptor.id)) {
      throw new Error(`Plugin action "${descriptor.id}" is already registered`);
    }

    this.pluginActions.set(descriptor.id, descriptor);
    let owners = this.pluginActionOwners.get(pluginId);
    if (!owners) {
      owners = new Set();
      this.pluginActionOwners.set(pluginId, owners);
    }
    owners.add(descriptor.id);

    this.broadcaster.schedulePluginActionsBroadcast();
  }

  /** Remove a single plugin-registered action. Silent no-op if unknown. */
  unregisterPluginAction(pluginId: string, actionId: string): void {
    const descriptor = this.pluginActions.get(actionId);
    if (!descriptor || descriptor.pluginId !== pluginId) return;

    this.pluginActions.delete(actionId);
    this.actionValidators.delete(actionId);
    this.pluginActionHandlers.delete(actionId);
    this.manifestCommandIds.delete(actionId);
    this.commandModulePaths.delete(actionId);
    const owners = this.pluginActionOwners.get(pluginId);
    if (owners) {
      owners.delete(actionId);
      if (owners.size === 0) this.pluginActionOwners.delete(pluginId);
    }

    this.broadcaster.schedulePluginActionsBroadcast();
  }

  /** Bulk cleanup when a plugin is unloaded. Emits a single broadcast. */
  unregisterPluginActions(pluginId: string): void {
    const owners = this.pluginActionOwners.get(pluginId);
    if (!owners || owners.size === 0) return;

    for (const id of owners) {
      this.pluginActions.delete(id);
      this.actionValidators.delete(id);
      this.pluginActionHandlers.delete(id);
      this.manifestCommandIds.delete(id);
      this.commandModulePaths.delete(id);
    }
    this.pluginActionOwners.delete(pluginId);

    this.broadcaster.schedulePluginActionsBroadcast();
  }

  /**
   * Unregister only the IMPERATIVE actions a plugin registered via
   * `host.registerAction` during `activate()`, leaving manifest-declared
   * commands intact. Used by the dev hot-reload path (#9304): a reload re-runs
   * only `activate()`, not the manifest registration, so wiping every action
   * (as {@link unregisterPluginActions} does) would erase the plugin's palette
   * commands after the first reload.
   */
  unregisterImperativePluginActions(pluginId: string): void {
    const owners = this.pluginActionOwners.get(pluginId);
    if (!owners || owners.size === 0) return;

    let changed = false;
    for (const id of [...owners]) {
      if (this.manifestCommandIds.has(id)) continue; // keep manifest commands
      this.pluginActions.delete(id);
      this.actionValidators.delete(id);
      this.pluginActionHandlers.delete(id);
      this.commandModulePaths.delete(id);
      owners.delete(id);
      changed = true;
    }
    if (owners.size === 0) this.pluginActionOwners.delete(pluginId);
    if (changed) this.broadcaster.schedulePluginActionsBroadcast();
  }

  /** Flattened snapshot of all plugin-registered actions (for renderer pull-on-mount). */
  listPluginActions(): PluginActionDescriptor[] {
    return Array.from(this.pluginActions.values());
  }

  // ============================================================
  // Settings UI bridge (#9301)
  //
  // Renderer-facing read/write/reveal/clear for the generated settings form.
  // These reuse the same per-(plugin, scope) store and subscriber path as the
  // plugin-facing `host.settings` API, so a write from the form fires the
  // owning plugin's `onDidChange` without it reactivating. Project scope is
  // resolved from an explicit `projectId` (not the main-process "current
  // project") so a settings form in one window can't read or write another
  // window's active-project values.
  // ============================================================

  async getSettingValuesForUi(
    pluginId: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<PluginSettingsUiValues> {
    return this.settings.getSettingValuesForUi(pluginId, scope, projectId);
  }

  async setSettingValueFromUi(
    pluginId: string,
    key: string,
    value: unknown,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<void> {
    const changed = await this.settings.setSettingValueFromUi(
      pluginId,
      key,
      value,
      scope,
      projectId
    );
    // Only user-scope values feed `${settings:*}` resolution (resolveSettingTemplate
    // reads user scope), so a project-scope write never affects a supervised
    // MCP server. And a redundant re-save of the same value shouldn't churn a
    // running server through a restart — gate on the store actually changing.
    if (scope === "user" && changed) this.restartMcpServersForSettingChange(pluginId, key);
  }

  async deleteSettingValueFromUi(
    pluginId: string,
    key: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<void> {
    const changed = await this.settings.deleteSettingValueFromUi(pluginId, key, scope, projectId);
    if (scope === "user" && changed) this.restartMcpServersForSettingChange(pluginId, key);
  }

  /**
   * Restart any running MCP server that references the just-changed setting so a
   * rotated secret takes effect (#10619). The supervisor owns the
   * detection + debounce and which servers are eligible (ready/crashed only);
   * this supplies the actual restart — re-resolving the contribution and minting
   * a fresh `resolveSettings` closure, mirroring the `plugin-mcp:restart` IPC
   * path so the supervisor never holds a stale closure.
   */
  private restartMcpServersForSettingChange(pluginId: string, settingId: string): void {
    getPluginMcpSupervisor().notifySettingChanged(pluginId, settingId, async (serverId) => {
      const lookup = this.findMcpServerContribution(pluginId, serverId);
      // The plugin may have unloaded between the debounce scheduling and now —
      // a missing contribution means there's nothing left to restart.
      if (!lookup) return;
      await getPluginMcpSupervisor().restart({
        pluginId,
        pluginDir: lookup.pluginDir,
        serverId,
        contribution: lookup.contribution,
        resolveSettings: (id) => this.resolveSettingTemplate(pluginId, id),
      });
    });
  }

  async revealSecretSettingForUi(
    pluginId: string,
    key: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<string | null> {
    return this.settings.revealSecretSettingForUi(pluginId, key, scope, projectId);
  }

  getAccountStatusForUi(
    pluginId: string,
    connectionId?: string
  ): Promise<PluginAccountUiStatus | null> {
    return this.accounts.getUiStatus(pluginId, connectionId);
  }

  listAccountConnectionsForUi(pluginId: string): Promise<PluginAccountUiStatus[]> {
    return this.accounts.listUiStatus(pluginId);
  }

  connectAccountFromUi(
    pluginId: string,
    connectionId?: string,
    broker?: AccountSignInBroker
  ): Promise<PluginAccountConnectResult> {
    return this.accounts.connect(pluginId, connectionId, broker);
  }

  cancelAccountConnectFromUi(pluginId: string, connectionId?: string): void {
    this.accounts.cancelConnect(pluginId, connectionId);
  }

  setAccountTokenFromUi(
    pluginId: string,
    token: string,
    connectionId?: string
  ): Promise<PluginAccountUiStatus> {
    return this.accounts.setToken(pluginId, token, connectionId);
  }

  disconnectAccountFromUi(pluginId: string, connectionId?: string): Promise<void> {
    return this.accounts.disconnect(pluginId, connectionId);
  }

  testAccountConnectionFromUi(
    pluginId: string,
    connectionId?: string
  ): Promise<PluginAccountVerification> {
    return this.accounts.testConnection(pluginId, connectionId);
  }

  getAccountBindingForUi(
    pluginId: string,
    projectId: string
  ): Promise<PluginAccountBindingUiStatus> {
    return this.accounts.getBindingUiStatus(pluginId, projectId);
  }

  setAccountBindingFromUi(
    pluginId: string,
    projectId: string,
    binding: PluginAccountBinding | null
  ): Promise<PluginAccountBindingUiStatus> {
    return this.accounts.setBinding(pluginId, projectId, binding);
  }

  /**
   * Replay the current actions / panel-kinds / toolbar-button snapshots to a
   * single target webContents. Used by the cold-start view-ready hook so a
   * freshly-restored WebContentsView (post-LRU eviction or first cold load on
   * project switch) gets a complete plugin state on the same channels its
   * persistent push listeners already consume — no renderer-side changes
   * needed. Awaits {@link waitForCatalog} so the snapshot is the scanned
   * catalog, not the empty pre-init view (#9285), without waiting on startup
   * activation (#14127).
   *
   * Toolbar buttons use `complete: false` so the renderer does not stale-prune
   * against this snapshot — replay is authoritative for the target view but
   * conceptually identical to a coalesced "load tick" broadcast, not an
   * unload sweep.
   *
   * Panel badges (#10585) are replayed here too — one
   * `plugin:panel-badges-changed` per badging plugin — so a cold-restored view
   * recovers live badge state it missed while evicted, rather than waiting for
   * each plugin to next re-emit from a subscription callback.
   */
  async pushSnapshotTo(webContents: Electron.WebContents): Promise<void> {
    await this.pushSnapshot(webContents);
  }

  /**
   * {@link pushSnapshotTo} for a view attached from another machine (Host
   * mode). A remote view has no `did-finish-load` here, so the host replays
   * when it attaches, scoped to the project its endpoint is bound to.
   */
  async pushSnapshotToEndpoint(endpoint: ClientEndpoint): Promise<void> {
    if (endpoint.kind !== "remote-view") return;
    await this.pushSnapshot(endpointPushTarget(endpoint), endpoint.projectId);
  }

  private async pushSnapshot(webContents: ProjectPushTarget, projectId?: string | null) {
    await this.broadcaster.pushSnapshotTo(webContents, projectId);
    if (webContents.isDestroyed()) return;
    // A local view's project is read from its registration, which a cached
    // view keeps; a remote view's is the one its endpoint is bound to.
    const inView = (owningProjectId: string): boolean =>
      projectId === undefined
        ? getProjectRendererTargets(owningProjectId).some((wc) => wc.id === webContents.id)
        : owningProjectId === projectId;
    // Each send is independently guarded against a TOCTOU destroy, matching the
    // broadcaster's defensive pattern above.
    for (const pluginId of this.pluginBadges.keys()) {
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, {
          name: "plugin:panel-badges-changed",
          payload: { pluginId, badges: this.serializePluginBadges(pluginId) },
        });
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
    for (const pluginId of this.pluginToolbarBadges.keys()) {
      const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
      if (owningProjectId !== null && !inView(owningProjectId)) continue;
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, {
          name: "plugin:toolbar-badges-changed",
          payload: { pluginId, badges: this.serializePluginToolbarBadges(pluginId) },
        });
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
    for (const pluginId of this.pluginToolbarStates.keys()) {
      const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
      if (owningProjectId !== null && !inView(owningProjectId)) continue;
      const envelope = {
        name: "plugin:toolbar-states-changed",
        payload: { pluginId, states: this.serializePluginToolbarStates(pluginId) },
      };
      // A local view bound to a remote host shows that host's buttons, so this
      // machine's state for a same-named plugin would disable or press them.
      if (
        projectId === undefined &&
        isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])
      ) {
        continue;
      }
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, envelope);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
    for (const pluginId of this.pluginPanelActivity.keys()) {
      const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
      if (owningProjectId !== null && !inView(owningProjectId)) continue;
      const envelope = {
        name: "plugin:panel-activity-changed",
        payload: { pluginId, activity: this.serializePluginPanelActivity(pluginId) },
      };
      // A local view bound to a remote host shows that host's panels, never
      // this machine's same-named plugin's reports.
      if (
        projectId === undefined &&
        isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])
      ) {
        continue;
      }
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, envelope);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
    for (const pluginId of this.pluginTasks.pluginIds()) {
      const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
      if (owningProjectId !== null && !inView(owningProjectId)) continue;
      const envelope = {
        name: "plugin:tasks-changed",
        payload: { pluginId, tasks: this.pluginTasks.snapshot(pluginId) },
      };
      // A local view bound to a remote host shows that host's work, never
      // this machine's same-named plugin's tasks.
      if (
        projectId === undefined &&
        isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])
      ) {
        continue;
      }
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, envelope);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
    for (const pluginId of this.pluginContextKeys.keys()) {
      const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
      if (owningProjectId !== null && !inView(owningProjectId)) continue;
      const envelope = {
        name: "plugin:context-keys-changed",
        payload: { pluginId, keys: this.serializePluginContextKeys(pluginId) },
      };
      // A local view bound to a remote host takes that host's keys, never this
      // machine's: they would gate its bindings on state it cannot see.
      if (
        projectId === undefined &&
        isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])
      ) {
        continue;
      }
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, envelope);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
    for (const [pluginId, byProject] of this.pluginWorktreeCardStatuses) {
      for (const statusProjectId of byProject.keys()) {
        if (!inView(statusProjectId)) continue;
        const envelope = {
          name: "plugin:worktree-card-statuses-changed",
          payload: {
            pluginId,
            projectId: statusProjectId,
            statuses: this.serializePluginWorktreeCardStatuses(pluginId, statusProjectId),
          },
        };
        // Withheld from a local view bound to a remote host, like the context
        // keys: this machine's statuses are not about the cards it shows.
        if (
          projectId === undefined &&
          isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])
        ) {
          continue;
        }
        try {
          webContents.send(CHANNELS.EVENTS_PUSH, envelope);
        } catch {
          // Silently ignore send failures during window initialization/disposal.
        }
      }
    }
    for (const [pluginId, byProject] of this.pluginWorktreeReviewChecks) {
      for (const checksProjectId of byProject.keys()) {
        if (!inView(checksProjectId)) continue;
        const envelope = {
          name: "plugin:worktree-review-checks-changed",
          payload: {
            pluginId,
            projectId: checksProjectId,
            checks: this.serializePluginWorktreeReviewChecks(pluginId, checksProjectId),
          },
        };
        if (
          projectId === undefined &&
          isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])
        ) {
          continue;
        }
        try {
          webContents.send(CHANNELS.EVENTS_PUSH, envelope);
        } catch {
          // Silently ignore send failures during window initialization/disposal.
        }
      }
    }
    for (const [pluginId, byProject] of this.pluginTerminalStatuses) {
      for (const statusProjectId of byProject.keys()) {
        if (!inView(statusProjectId)) continue;
        const envelope = {
          name: "plugin:terminal-statuses-changed",
          payload: {
            pluginId,
            projectId: statusProjectId,
            statuses: this.serializePluginTerminalStatuses(pluginId, statusProjectId),
          },
        };
        if (
          projectId === undefined &&
          isWithheldFromView(webContents.id, CHANNELS.EVENTS_PUSH, [envelope])
        ) {
          continue;
        }
        try {
          webContents.send(CHANNELS.EVENTS_PUSH, envelope);
        } catch {
          // Silently ignore send failures during window initialization/disposal.
        }
      }
    }
    // Scoped like the running-action replay below: a project plugin's menus
    // belong to its own project's views.
    for (const pluginId of this.pluginPanelMenus.keys()) {
      const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
      if (owningProjectId !== null && !inView(owningProjectId)) continue;
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, {
          name: "plugin:panel-menus-changed",
          payload: { pluginId, menus: this.serializePluginPanelMenus(pluginId) },
        });
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
    for (const [pluginId, byAction] of this.runningActions) {
      const owningProjectId = projectIdFromPluginInstanceKey(pluginId);
      if (owningProjectId !== null && !inView(owningProjectId)) continue;
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, {
          name: "plugin:actions-running-changed",
          payload: { pluginId, actionIds: [...byAction.keys()] },
        });
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
}

// E2E backdoor: the host-contract harness (#9286) sideloads the compiled
// sample plugin from `dist-electron/plugins/sample` via a dedicated scan that
// loads with `isBuiltin: true`, which is the only way a plugin claiming the
// reserved `daintree.*` namespace can pass the manifest schema. The
// constant-folded define in `scripts/build-main.mjs` rewrites this read to
// `""` in production builds, so no shipped binary ever sideloads anything.
export const pluginService = new PluginService(undefined, undefined, {
  sideloadPluginsRoot: e2eSideloadPluginDir,
  whenProtocolReady: whenPluginDirResolverLive,
});

// E2E backdoor: activate a loaded plugin by id without adding a production IPC
// surface. Production builds replace DAINTREE_E2E_MODE with "" and strip this.
if (isE2EMode) {
  const activateKey = ["__", "daintree", "Activate", "E2E", "Plugin"].join("");
  (globalThis as Record<string, unknown>)[activateKey] = (pluginId: string) =>
    pluginService.activatePlugin(pluginId);
}
