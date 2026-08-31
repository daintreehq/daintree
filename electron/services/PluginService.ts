import fs from "fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { app } from "electron";
import * as semver from "semver";
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
  DEPRECATED_CONTRIBUTION_ALIASES,
  getPluginManifestSchema,
  SCOPED_PLUGIN_NAME_PATTERN,
} from "../schemas/plugin.js";
import { getPluginMcpSupervisor } from "./PluginMcpSupervisor.js";
import { PluginProcessManager } from "./plugin/PluginProcessManager.js";
import { PluginPtyTransport } from "./plugin/PluginPtyTransport.js";
import { PluginPathNotAllowedError } from "./plugin/pluginFsContainment.js";
import { e2eSideloadPluginDir, isE2EMode } from "../setup/runtimeFlags.js";
import type { HostGitFactory } from "./plugin/pluginHostGit.js";
import {
  PLUGIN_PROCESS_STREAM_CHANNEL,
  type PluginProcessInfo,
} from "../../shared/types/ipc/pluginProcess.js";
import { z } from "zod";
import {
  isBuiltInPluginCapability,
  UNBOUND_PLUGIN_HOST_BINDING,
} from "../../shared/types/plugin.js";
import type {
  PluginManifest,
  PluginIpcHandler,
  PluginIpcContext,
  PluginHostApi,
  PluginActivate,
  PluginActionContribution,
  PluginActionDescriptor,
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
  PluginWorktreeStatus,
  PluginPanelBadge,
  PluginProtocolAuthority,
  ViewContribution,
  PluginHostBinding,
  PluginOrigin,
  ProjectPluginInfo,
  ProjectPluginTrustDecision,
  ProjectPluginTrustRecord,
  ProjectPluginTrustState,
} from "../../shared/types/plugin.js";
import { PluginInstalledRecordsStore } from "./plugin/PluginInstalledRecordsStore.js";
import { PluginContributionBroadcaster } from "./plugin/PluginContributionBroadcaster.js";
import {
  setPluginContributionScope,
  clearPluginContributionScope,
} from "./plugin/PluginContributionBroadcaster.js";
import {
  ProjectPluginController,
  type ProjectPluginControllerDeps,
} from "./plugin/ProjectPluginController.js";
import { discoverProjectPlugins } from "./plugin/projectPluginDiscovery.js";
import { ProjectPluginWatcher } from "./plugin/ProjectPluginWatcher.js";
import { getPluginCapabilityConsentService } from "./plugin-capability/instances.js";
import { getWebContentsForProject } from "../window/webContentsRegistry.js";
import { projectStore } from "./ProjectStore.js";
import { store } from "../store.js";
import {
  makeProjectPluginInstanceKey,
  parseProjectPluginInstanceKey,
} from "../../shared/types/plugin.js";
import {
  PluginPanelLifecycleBroker,
  type PanelLifecycleSourceHandle,
} from "./plugin/PluginPanelLifecycleBroker.js";
import { PLUGIN_VIEW_GENERATION_PREFIX } from "../../shared/utils/pluginViewUrl.js";
import { PluginRendererDispatcher } from "./plugin/PluginRendererDispatcher.js";
import { PluginUIPromptDispatcher } from "./plugin/PluginUIPromptDispatcher.js";
import { PluginSettingsManager } from "./plugin/PluginSettingsManager.js";
import { PluginStorageManager } from "./plugin/PluginStorageManager.js";
import { PluginChannelRegistry } from "./plugin/PluginChannelRegistry.js";
import {
  PluginBlocklistService,
  findPluginBlocklistMatch,
  type ParsedPluginBlocklist,
} from "./plugin/PluginBlocklistService.js";
import { PluginInstaller } from "./plugin/PluginInstaller.js";
import { PluginDevWorkerHost } from "./plugin/PluginDevWorkerHost.js";
import { PluginDevWorkerMainBridge } from "./plugin/PluginDevWorkerMainBridge.js";
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
  type PluginHostFactoryDeps,
  type PluginWorktreeEventPayload,
} from "./plugin/PluginHostFactory.js";
import type {
  LoadedPlugin,
  ValidateFn,
  WorkspaceWorktreeEvent,
  ExpandedFsPath,
} from "./plugin/PluginServiceTypes.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { toPluginWorktreeStatus } from "../../shared/utils/pluginWorktreeSnapshot.js";
import { getPtyClient } from "../window/serviceRefs.js";
import { getWindowForWebContents } from "../window/webContentsRegistry.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  registerPanelKind,
  toRuntimePanelKindId,
  unregisterPluginPanelKinds,
  onPanelKindRegistered,
  onPanelKindUnregistered,
  getPanelKindConfig,
} from "../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "./pluginMenuRegistry.js";
import {
  registerPluginKeybinding,
  unregisterPluginKeybindings,
} from "./pluginKeybindingRegistry.js";
import {
  registerPluginContextMenuItem,
  unregisterPluginContextMenuItems,
} from "./pluginContextMenuRegistry.js";
import {
  trackPluginExpression,
  unregisterPlugin as unregisterWhenClausePlugin,
} from "./WhenClauseService.js";
import {
  registerForgeProviders,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "./forgeProviderRegistry.js";
import { scrubSecrets } from "../../shared/utils/secretScrubber.js";
import {
  registerFileDecorationProviders,
  scopeMatchesPattern,
  unregisterFileDecorationProviderImpls,
  unregisterFileDecorationProviders,
} from "./fileDecorationRegistry.js";
import {
  getPluginIdForAgent,
  registerPluginAgents,
  unregisterPluginAgents,
} from "../../shared/config/pluginAgentRegistry.js";
import {
  registerPluginProcessTools,
  unregisterPluginProcessTools,
} from "../../shared/config/pluginProcessToolRegistry.js";
import { registerPluginSkills, unregisterPluginSkills } from "./plugin/PluginSkillRegistry.js";
import {
  getPluginRecipe,
  getPluginRecipeOwner,
  getPluginRecipeQualifiedIdsByPlugin,
  getPluginRecipes,
  registerPluginRecipes,
  setPluginRecipeMetadataSnapshot,
  unregisterPluginRecipes,
} from "./plugin/PluginRecipeRegistry.js";
import { PluginRecipeMetadataStore } from "./plugin/PluginRecipeMetadataStore.js";
import { broadcastToRenderer, broadcastToProjectRenderers } from "../ipc/utils.js";
import { deepFreeze } from "../utils/deepFreeze.js";
import { CHANNELS } from "../ipc/channels.js";
import type { LoadedPluginInfo } from "../../shared/types/plugin.js";
import type { PluginRecipeMetadataPatch, TerminalRecipe } from "../../shared/types/project.js";
import type { PluginToolbarButtonId } from "../../shared/types/toolbar.js";
import { getPluginActionAuditService } from "./PluginActionAuditService.js";
import { stableArgsSha256 } from "../utils/pluginMcpHash.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { canDisposeIdlePluginWorker } from "../../shared/utils/workerGovernancePolicy.js";
import type { WorkerResourceSnapshot } from "../../shared/types/workerGovernance.js";
import { markAuditedHandlerFailure } from "../utils/pluginAuditMarker.js";
import type {
  PluginDiagnosticsAuditRecord,
  PluginDiagnosticsLogLine,
  PluginDiagnosticsSnapshot,
} from "../../shared/types/ipc/pluginDiagnostics.js";
import { BUILT_IN_ACTION_IDS } from "../../shared/config/actionIds.js";
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

function runUnloadStep(pluginId: string, step: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[PluginService] Unload step "${step}" for "${pluginId}" threw:`, err);
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
 * Build the `plugin://{authority}/{PLUGIN_VIEW_GENERATION_PREFIX}{n}/{path}` URL
 * that `PluginViewHost` passes to `import()`. Strips a single leading `./` so
 * the host segment doesn't end up with an awkward `./dist/view.js` path
 * component — the URL handler accepts either form, but the canonical shape
 * matches the protocol docs.
 *
 * The generation segment is what makes a plugin upgrade visible without a Force
 * Reload (#11301). V8 caches ESM module records by URL and Chromium has no
 * eviction API, so a re-imported identical specifier returns the OLD module no
 * matter how thoroughly the React tree remounts. A fresh segment is a specifier
 * V8 has never seen, so the new bundle is actually fetched and evaluated.
 *
 * This is deliberately NOT a per-load cache-buster — that is the thing the
 * renderer's own comment warns against, because one entry per panel open grows
 * the module map without bound. The generation changes only when the plugin is
 * (re)loaded in main: a genuine install, upgrade, or dev reload. That is the
 * same bounded cost plugin authors already pay by hand-versioning their bundle
 * filename every release, minus the manual step.
 *
 * A path SEGMENT rather than a `?v=` query on purpose: a relative import inside
 * the entry module resolves against the entry's URL and inherits a path prefix,
 * but drops the query — so a query would refresh the entry chunk and leave
 * every secondary chunk stale.
 */
function buildPluginViewUrl(
  authority: PluginProtocolAuthority,
  componentPath: string,
  generation: number
): string {
  const normalized = componentPath.startsWith("./") ? componentPath.slice(2) : componentPath;
  return `plugin://${authority}/${PLUGIN_VIEW_GENERATION_PREFIX}${generation}/${normalized}`;
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
    };
  } catch (err) {
    // Fail closed: an unreadable record is not a grant.
    console.warn("[PluginService] Failed to read project plugin trust:", err);
    return undefined;
  }
}

/**
 * Write (or clear) one project's trust record. Always rewrites the whole map —
 * electron-store dot-notation would nest on a key containing dots, and a
 * project id is opaque.
 */
function writeProjectPluginTrust(
  projectId: string,
  record: ProjectPluginTrustRecord | undefined
): void {
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
  } catch (err) {
    console.warn("[PluginService] Failed to write project plugin trust:", err);
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
   */
  private pluginRootsByAuthority = new Map<string, string>();
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
  private ajv: AjvInstance | null = null;
  private pluginEventCleanups = new Map<string, Array<() => void>>();
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
    { workerHost: PluginDevWorkerHost; bridge: PluginDevWorkerMainBridge; revoke: () => void }
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
  private appVersion: string;
  /**
   * Owns the coalesced per-tick contribution broadcasts (actions, panel kinds,
   * toolbar buttons, keybindings, context-menu items) plus the
   * cold-start {@link pushSnapshotTo} replay. Constructed in the constructor
   * after {@link initPromise} is set, so it can await the init gate.
   */
  private readonly broadcaster: PluginContributionBroadcaster;
  private readonly panelLifecycleBroker: PluginPanelLifecycleBroker;
  /** sourceId → detach its `destroyed` listener. See `watchPanelLifecycleSource`. */
  private readonly panelLifecycleSourceCleanups = new Map<number, () => void>();
  private disposed = false;
  private readonly disposeRegistrySubscriptions: () => void;
  /**
   * Resolves once {@link initialize} and {@link activateStartupFinishedPlugins}
   * have both settled (or {@link dispose} has run). Renderer pull-on-mount IPC
   * handlers await this so a fresh `getActions` / `getPanelKinds` /
   * `toolbarButtons` call can't return `[]` while plugins are still being
   * loaded and activated. Settled in `finally` so a plugin activation failure
   * never permanently deadlocks the renderer (#9285).
   */
  private readonly initPromise: Promise<void>;
  private resolveInit: (() => void) | null = null;
  /**
   * Owns the `host.dispatch()` main→renderer round-trip: the active-renderer
   * resolution, the lazy `ipcMain` response listener, and the pending-request
   * map with per-request timeout + destroyed-cleanup. Torn down from
   * {@link dispose}.
   */
  private readonly dispatcher: PluginRendererDispatcher;
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
    }
  ) {
    this.pluginsRoot = pluginsRoot ?? path.join(os.homedir(), ".daintree", "plugins");
    this.recipeMetadata = new PluginRecipeMetadataStore(
      options?.globalConfigDir ?? resolveGlobalConfigDir()
    );
    this.appVersion = appVersion ?? app.getVersion();
    this.builtinPluginsRoot = options?.builtinPluginsRoot;
    this.sideloadPluginsRoot = options?.sideloadPluginsRoot;
    this.blocklistService = options?.blocklistService ?? new PluginBlocklistService();

    this.initPromise = new Promise<void>((resolve) => {
      this.resolveInit = resolve;
    });

    this.broadcaster = new PluginContributionBroadcaster({
      isDisposed: () => this.disposed,
      listPluginActions: () => this.listPluginActions(),
      initPromise: this.initPromise,
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
    });

    this.storage = new PluginStorageManager({
      getPluginsRoot: () => this.pluginsRoot,
      // Resolve the active worktree's path the same way host.getActiveWorktree
      // does — first isCurrent snapshot — so "worktree"-scoped storage tracks the
      // user's active worktree. Returns undefined when none is active or the
      // workspace client isn't wired yet, which the storage API treats as
      // "no target" (read → undefined, write → throw).
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
      getAppVersion: () => this.appVersion,
      records: this.records,
      getSettingsRoot: () => this.settings.settingsRoot(),
      loadPlugin: (root, pluginId, opts) => this.loadPlugin(root, pluginId, opts),
      unloadPlugin: (pluginId) => this.unloadPlugin(pluginId),
      activatePlugin: (pluginId) => this.activatePlugin(pluginId),
      setPluginArchiveHash: (pluginId, hash) => this.setPluginArchiveHash(pluginId, hash),
      setEnabled: (pluginId, enabled) => this.setEnabled(pluginId, enabled),
      broadcastProvenanceChanged: () => this.broadcaster.broadcastProvenanceChanged(),
      purgeRecipeMetadata: (pluginId) => this.purgePluginRecipeMetadata(pluginId),
      getPlugin: (pluginId) => this.plugins.get(pluginId) ?? this.disabledPlugins.get(pluginId),
      reservedNames: this.reservedNames,
      disabledPlugins: this.disabledPlugins,
      blockedPlugins: this.blockedPlugins,
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
   * Resolves once startup load + activation has settled. The three pull-on-mount
   * IPC handlers (`getActions`, `getPanelKinds`, `toolbarButtons`) await this
   * so a renderer that mounts before plugins activate doesn't observe an empty
   * registry. Safe to await repeatedly; resolves immediately after the first
   * settle. {@link dispose} also resolves it to prevent test hangs when a
   * service is torn down without calling {@link activateStartupFinishedPlugins}.
   */
  waitForInit(): Promise<void> {
    return this.initPromise;
  }

  /**
   * Whether the manifest scan phase ({@link initialize}) has settled. Forge
   * provider descriptors register at scan-time, so once this is true a
   * hostname-match miss in `resolveForgeProvider` is a definitive "no
   * provider matches" rather than a cold-start race (#9997). Distinct from
   * {@link waitForInit}, which also waits for startup activation.
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
    try {
      sender.once("destroyed", onDestroyed);
    } catch {
      // An already-torn-down WebContents can throw; nothing to track then.
      return;
    }
    this.panelLifecycleSourceCleanups.set(sourceId, () => {
      try {
        sender.removeListener("destroyed", onDestroyed);
      } catch {
        // Electron throws if the WebContents is already gone — the listener
        // died with it.
      }
    });
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
    // Native watchers go first: a settled burst arriving mid-teardown would
    // otherwise queue a reload into a service that is going away.
    this.projectPluginWatcherRegistry?.dispose();
    this.projectPluginWatcherRegistry = null;
    // Forget every project's plugin bookkeeping BEFORE the unload sweep below,
    // so the controller cannot re-load into a service that is going away.
    this.projectPluginController?.dispose();
    this.projectPluginController = null;
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
    this.disposeRegistrySubscriptions();
    // Settle the init gate so unit tests that tear down the service without
    // running activateStartupFinishedPlugins() don't hang IPC callers awaiting
    // waitForInit().
    this.resolveInit?.();
    this.resolveInit = null;
    this.dispatcher.dispose();
    this.promptDispatcher.dispose();
    for (const detach of this.panelLifecycleSourceCleanups.values()) detach();
    this.panelLifecycleSourceCleanups.clear();
    this.panelLifecycleBroker.dispose();
    // Drops the PtyClient subscriptions and force-kills any plugin PTY the
    // unload cascade above left running.
    this.pluginPtyTransport?.dispose();
    this.pluginPtyTransport = null;
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
    }
    this.workspaceClient = client;
    if (client) {
      client.off("worktree-activated", this.onWorktreeActivatedForCache);
      client.on("worktree-activated", this.onWorktreeActivatedForCache);
    }
    if (client && this.pendingWorktreeSubs.length > 0) {
      const pending = this.pendingWorktreeSubs;
      this.pendingWorktreeSubs = [];
      for (const sub of pending) {
        sub.activate(client);
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

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

    // Resolve the kill-switch blocklist once, before any scan, so the
    // per-plugin load gate below reads a single immutable snapshot and the
    // Promise.allSettled fan-out never awaits a network call (#9428). Fails
    // open: getBlocklist() returns null on any fetch/parse failure with no
    // cached list, and plugins then load normally.
    this.startupBlocklist = await this.blocklistService.getBlocklist();

    // Built-ins load first so user plugins with a colliding manifest.name are
    // rejected by the duplicate guard in loadPlugin() — built-in wins.
    const builtinDir = this.builtinPluginsRoot ?? this.getBuiltinDir();
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
      console.log(
        `[PluginService] Loaded ${builtinLoaded} built-in plugin(s) from ${builtinDir ?? "<unresolved>"}, ${userLoaded} user plugin(s) from ${this.pluginsRoot}, and ${sideloadLoaded} sideloaded plugin(s) from ${this.sideloadPluginsRoot ?? "<none>"}`
      );
      // Only reachable when every configured root was enumerated, so the
      // installed-id set is authoritative. A partial inventory would read as
      // "uninstalled" and delete live metadata (#6110).
      await this.reconcilePluginRecipeMetadata();
    } finally {
      // Idempotency must hold even when a scan throws (e.g. EACCES on the
      // user dir): a retry would re-run the built-in scan and trigger
      // "already registered, overwriting" warnings from the contribution
      // registries.
      this.initialized = true;
    }
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
    }
  ): Promise<LoadedPlugin | null> {
    const origin: PluginOrigin = opts.origin ?? (opts.isBuiltin ? "builtin" : "user");
    const isProject = origin === "project";
    const isUserInstalled = origin === "user";
    const pluginDir = path.join(root, dirName);
    const manifestPath = path.join(pluginDir, "plugin.json");

    let content: string;
    try {
      content = await fs.readFile(manifestPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`[PluginService] No plugin.json in ${dirName}, skipping`);
        return null;
      }
      console.error(`[PluginService] Failed to read ${manifestPath}:`, err);
      return null;
    }

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      console.error(`[PluginService] Invalid JSON in ${manifestPath}`);
      return null;
    }

    const parseResult = getPluginManifestSchema(origin).safeParse(json);
    if (!parseResult.success) {
      const namespaceIssue = parseResult.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
            "namespace_reserved"
      );
      if (namespaceIssue) {
        const inferredName = (json as Record<string, unknown>)?.name;
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "error",
          title: "Plugin uses a reserved namespace",
          message: `Plugin "${String(inferredName ?? dirName)}" uses the reserved "daintree.*" namespace, which is restricted to first-party plugins.`,
        });
        if (isUserInstalled) {
          this.records.upsertInstalledRecord(String(inferredName ?? dirName), {
            loadError: { message: namespaceIssue.message, at: Date.now() },
          });
        }
      }
      console.error(`[PluginService] Invalid manifest in ${dirName}:`, parseResult.error.issues);
      return null;
    }

    const manifest = parseResult.data;
    // The registry key for this instance. Identical to the manifest id for
    // installed and builtin plugins, so every existing key, path and id is
    // byte-for-byte what it was; distinct for a project plugin, which is what
    // keeps two projects' copies of the same id from sharing anything.
    const pluginId = opts.instanceKey ?? manifest.name;
    const binding = opts.binding ?? UNBOUND_PLUGIN_HOST_BINDING;

    // Discovery validated one manifest; this is a second read of the same file.
    // A rewrite in between — a rebase, an agent edit, a hostile swap — could
    // hand a DIFFERENT plugin the identity the user already knows and trusts.
    // Refuse rather than let a renamed manifest inherit a staged-or-known id.
    if (opts.instanceKey !== undefined) {
      const expected = parseProjectPluginInstanceKey(opts.instanceKey)?.manifestId;
      if (expected !== manifest.name) {
        console.error(
          `[PluginService] Project plugin in ${dirName} declares "${manifest.name}" but was discovered as "${String(expected)}" — refusing to load`
        );
        return null;
      }
    }
    // Manifest-immutability invariant: the parsed manifest is stored on
    // LoadedPlugin.manifest and read across the whole PluginService lifecycle
    // (capability checks, contribution loops, host closures). Deep-freeze it so
    // an accidental in-place mutation of a declared contribution can't poison the
    // shared record. DEV-only (see deepFreeze) — the Readonly<PluginManifest>
    // type below is the compile-time half of the same invariant.
    deepFreeze(manifest);

    // Deprecation surface for the 1.0 freeze: the schema migrates the old
    // `experimental_*` contribution keys to their stable names before
    // validation, so warn (once per alias) when an old manifest is still using
    // them. Inspect the raw JSON because the migrated `manifest` no longer
    // carries the deprecated keys.
    const rawContributes = (json as { contributes?: Record<string, unknown> } | null)?.contributes;
    if (rawContributes && typeof rawContributes === "object") {
      for (const [deprecated, canonical] of Object.entries(DEPRECATED_CONTRIBUTION_ALIASES)) {
        if (deprecated in rawContributes) {
          console.warn(
            `[PluginService] Plugin "${manifest.name}": contributes.${deprecated} is deprecated — rename it to contributes.${canonical}`
          );
        }
      }
    }

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
      if (!semver.satisfies(this.appVersion, requiredRange, { includePrerelease: true })) {
        console.error(
          `[PluginService] Plugin "${manifest.name}" requires Daintree ${requiredRange} but current version is ${this.appVersion} — skipping`
        );
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: "error",
          title: "Plugin incompatible",
          message: `Plugin "${manifest.displayName ?? manifest.name}" requires Daintree ${requiredRange} but current version is ${this.appVersion}.`,
        });
        return null;
      }
    } else {
      console.warn(
        `[PluginService] Plugin "${manifest.name}" does not declare engines.daintree — consider adding it to ensure compatibility`
      );
    }

    // Per-plugin provenance record. Built-ins don't get records — they're
    // identified by load path. Non-builtins get one created on first encounter.
    // Disabled-state filtering already happened upstream via `opts.disabled`
    // (the unified `plugins.disabled` list, #9284), so we only run here when
    // the plugin is going to load. Must run after the engine gate above so
    // incompatible plugins don't leave zombie records in the store.
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

    // Scope the contribution registries to this plugin's project BEFORE a
    // single contribution is registered. The registries are module-level
    // singletons filtered at read/broadcast time by owning plugin id, so a
    // contribution registered while the index says "global" is broadcast to
    // every project until the next mutation corrects it. `"global"` is the
    // explicit no-op form for the unbound roots.
    setPluginContributionScope(pluginId, binding.projectId ?? "global");

    // Contributed `actionId`s are authored in the plugin's own manifest
    // namespace (the schema enforces exactly that), but a project plugin's
    // commands register under its INSTANCE namespace. Left unrewritten, every
    // declarative toolbar button, menu item, keybinding and context-menu entry
    // would dispatch an id that either resolves to nothing or — worse — to a
    // same-named installed plugin's action.
    const ownPrefix = `${manifest.name}.`;
    const qualifyActionId = (actionId: string): string =>
      isProject && actionId.startsWith(ownPrefix)
        ? `${pluginId}.${actionId.slice(ownPrefix.length)}`
        : actionId;

    for (const btn of manifest.contributes.toolbarButtons) {
      // Canonical `{pluginId}.{id}` form (#9281) — matches `registerPluginAction`
      // and `panelKindRegistry`. The legacy `plugin.{pluginId}.{id}` form lived
      // here alone and is migrated renderer-side by `toolbarPreferencesStore`'s
      // v9 migration so existing user pins survive the rename.
      const buttonId = `${pluginId}.${btn.id}` as PluginToolbarButtonId;
      registerToolbarButton({
        id: buttonId,
        label: btn.label,
        iconId: btn.iconId,
        actionId: qualifyActionId(btn.actionId),
        priority: btn.priority ?? 3,
        pluginId,
      });
    }
    if (manifest.contributes.toolbarButtons.length > 0) {
      this.broadcaster.scheduleToolbarButtonsBroadcast(false);
    }

    for (const menuItem of manifest.contributes.menuItems) {
      trackPluginExpression(pluginId, menuItem.when);
      registerPluginMenuItem(pluginId, {
        ...menuItem,
        actionId: qualifyActionId(menuItem.actionId),
      });
    }

    for (const keybinding of manifest.contributes.keybindings) {
      trackPluginExpression(pluginId, keybinding.when);
      registerPluginKeybinding(pluginId, {
        ...keybinding,
        actionId: qualifyActionId(keybinding.actionId),
      });
    }
    if (manifest.contributes.keybindings.length > 0) {
      this.broadcaster.scheduleKeybindingsBroadcast(false);
    }

    for (const ctxMenu of manifest.contributes.contextMenus) {
      trackPluginExpression(pluginId, ctxMenu.when);
      registerPluginContextMenuItem(pluginId, {
        ...ctxMenu,
        actionId: qualifyActionId(ctxMenu.actionId),
      });
    }
    if (manifest.contributes.contextMenus.length > 0) {
      this.broadcaster.scheduleContextMenuItemsBroadcast(false);
    }

    // Lazy MCP discovery (#9235): plugin activation no longer eagerly spawns
    // contributed MCP servers. The subprocess starts on the first tool
    // enumeration (`plugin-mcp:list-tools`), which resolves the contribution
    // and calls the (idempotent) supervisor `start()` at the IPC boundary. This
    // keeps idle plugins from holding live subprocesses they never use.

    if (manifest.contributes.forgeProviders.length > 0) {
      registerForgeProviders(pluginId, manifest.contributes.forgeProviders);
      // Wake workspace-hosts whose PR polling paused on a "no provider
      // matches" resolution so they re-evaluate against the new descriptor
      // (#9997). Covers both the startup scan and runtime install/enable.
      this.workspaceClient?.notifyForgeProviderRegistryUpdated();
    }

    if (manifest.contributes.fileDecorationProviders.length > 0) {
      registerFileDecorationProviders(pluginId, manifest.contributes.fileDecorationProviders);
    }

    // Skills (#10892) are read and parsed eagerly here so the built-in MCP
    // server's `skills.search`/`skills.load` tools query an in-memory registry.
    // A malformed/unreadable skill file is skipped (with a warning) rather than
    // failing the plugin load. Torn down per-plugin in unloadPlugin.
    if (manifest.contributes.skills.length > 0) {
      await registerPluginSkills(pluginId, pluginDir, manifest.contributes.skills);
    }

    if (manifest.contributes.agents.length > 0) {
      registerPluginAgents(pluginId, manifest.contributes.agents, pluginDir);
      this.broadcaster.scheduleAgentsBroadcast(false);
      // Mirror the updated registry into the pty-host so its activity monitor
      // resolves this agent's detection patterns at spawn time (#10587). The
      // renderer is covered by the broadcast above; the pty-host is a separate
      // process that never registers agents itself.
      getPtyClient()?.syncPluginAgentRegistry();
    }

    // Recipes (#11860) are registered AFTER agents so `ownedAgentIds` can be
    // resolved against the live registry rather than the manifest: a
    // cross-plugin agent-id collision resolves first-registered-wins, and a
    // plugin that lost one must not have its recipe launch the winner's agent.
    if (manifest.contributes.recipes.length > 0) {
      const ownedAgentIds = new Set(
        manifest.contributes.agents
          .map((agent) => agent.id)
          .filter((id) => getPluginIdForAgent(id) === pluginId)
      );
      registerPluginRecipes(pluginId, manifest.contributes.recipes, ownedAgentIds);
      this.broadcaster.scheduleRecipesBroadcast(false);
    }

    if (manifest.contributes.processTools.length > 0) {
      registerPluginProcessTools(pluginId, manifest.contributes.processTools);
      // Mirror into the pty-host, where `ProcessDetector` runs — the renderer
      // needs no broadcast because the detected icon id already reaches it on
      // the terminal identity event (#11613).
      getPtyClient()?.syncPluginProcessToolRegistry();
    }

    // Insert the plugin into the registry BEFORE importing its main module so
    // synchronous host-API calls made during module evaluation (e.g., a plugin
    // that calls host.registerAction/registerHandler at import time) see the
    // plugin as loaded. Without this, `hasPlugin(pluginId)` returns false
    // inside the plugin's own init, and registerHandler/registerPluginAction
    // throw "Unknown plugin" even for a correctly loaded plugin.
    // Minted and committed synchronously with the registry insert below, so the
    // authority is resolvable the instant the plugin is addressable.
    const authority = this.mintPluginAuthority(pluginId, plugin.dir);
    this.plugins.set(pluginId, plugin);

    // Panel kinds are published only AFTER the map commit above, with no await
    // in between (#11728). `registerPanelKind` is what makes a panel
    // addressable — it carries the `plugin://` `componentPath` and schedules the
    // `plugin:panel-kinds-changed` broadcast — while the protocol handler's
    // resolver reads the authority map committed with it. Publishing first, as
    // this block used to, handed the renderer a URL that the protocol could not
    // yet resolve; any plugin with an await before the commit (a `skills`
    // contribution alone was enough) 404'd its own view module, and a rejected
    // dynamic import is permanent for that specifier. The map commit is now the
    // single addressability gate, so this ordering is the invariant, not an
    // incidental arrangement.
    //
    // Index views by bare id so the panels loop can attach `componentPath` in
    // a single registerPanelKind pass (#9229). View ids are pre-namespace; the
    // runtime panel id is `${manifest.name}.${panel.id}`. The generation lives
    // on `plugin` (allocated at construction) so every view shares one virtual
    // namespace, which is what lets relative imports inherit it (#11301).
    const viewsByBareId = new Map<string, ViewContribution>();
    const unmatchedViewIds = new Set<string>();
    for (const view of manifest.contributes.views) {
      // `location` is narrowed to `"panel"` and `componentPath` safety is
      // enforced by `ViewContributionSchema` at manifest parse — an unsupported
      // location or unsafe path fails validation before we reach this loop.
      if (viewsByBareId.has(view.id)) {
        // Two entries with the same bare id — last would silently overwrite
        // earlier. Surface the authoring mistake; keep the first to make the
        // outcome deterministic.
        console.warn(
          `[PluginService] Plugin "${manifest.name}": views has duplicate entries for id "${view.id}"; keeping the first occurrence`
        );
        continue;
      }
      viewsByBareId.set(view.id, view);
      unmatchedViewIds.add(view.id);
    }

    for (const panel of manifest.contributes.panels) {
      // A project plugin's panel kinds register under the project-qualified
      // runtime id, so two projects can each contribute `acme.dash/overview`
      // without one silently overwriting the other. `toRuntimePanelKindId`
      // returns null for a project ref with no owning project — that can only
      // mean a bug in the caller, and inventing the unqualified form here would
      // alias a project kind onto a global one.
      const panelId = isProject
        ? toRuntimePanelKindId(
            { origin: "project", pluginId: manifest.name, kindId: panel.id },
            binding.projectId
          )
        : `${manifest.name}.${panel.id}`;
      if (panelId === null) {
        console.error(
          `[PluginService] Plugin "${manifest.name}": cannot qualify panel kind "${panel.id}" without an owning project — skipping`
        );
        continue;
      }
      const view = viewsByBareId.get(panel.id);
      if (view) unmatchedViewIds.delete(panel.id);
      registerPanelKind({
        id: panelId,
        name: panel.name,
        iconId: panel.iconId,
        color: panel.color,
        hasPty: panel.hasPty,
        canRestart: panel.canRestart,
        canConvert: panel.canConvert,
        showInPalette: panel.showInPalette,
        // Dockable by default; only forward an explicit opt-out (or opt-in) so
        // absence stays `undefined` and `panelKindIsDockable` applies the
        // default. #11332.
        ...(panel.dockable !== undefined ? { dockable: panel.dockable } : {}),
        // Keyed by the INSTANCE, because `unregisterPluginPanelKinds` matches
        // on `extensionId` alone: keying by manifest id would make one
        // project's unload sweep every other project's copies of the same kind.
        extensionId: pluginId,
        ...(isProject ? { projectId: binding.projectId, pluginManifestId: manifest.name } : {}),
        ...(view && !panel.hasPty
          ? {
              componentPath: buildPluginViewUrl(
                authority,
                view.componentPath,
                plugin.viewGeneration
              ),
            }
          : {}),
      });
      if (view && panel.hasPty) {
        // A PTY panel with a matching view is contradictory — the view module
        // would never render because TerminalPane owns the surface. Surface the
        // collision rather than silently dropping the view.
        console.warn(
          `[PluginService] Plugin "${manifest.name}": views entry "${view.id}" matches a panel with hasPty=true; the view will be ignored because PTY panels are rendered by TerminalPane`
        );
      }
    }

    for (const orphanId of unmatchedViewIds) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}": views entry "${orphanId}" has no matching contributes.panels entry and will be ignored`
      );
    }

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
      await this.registerManifestCommands(pluginId, plugin, opts.isBuiltin);
    }

    return plugin;
  }

  /**
   * Register each manifest-declared command's descriptor and probe its
   * filesystem-convention handler path. Handler modules are NOT imported here —
   * the dynamic `import()` is deferred to {@link dispatchHandler} so plugins
   * with many commands don't pay the eval cost during the 5s activation
   * budget. Collisions with built-in action ids surface via the provenance
   * `loadError` field for non-builtins, or a console warning for builtins
   * (which have no installed-record slot).
   */
  private async registerManifestCommands(
    pluginId: string,
    plugin: LoadedPlugin,
    isBuiltin: boolean
  ): Promise<void> {
    let owners = this.pluginActionOwners.get(pluginId);
    let registered = false;
    for (const cmd of plugin.manifest.contributes.commands) {
      const namespacedId = `${pluginId}.${cmd.id}`;
      if (BUILT_IN_ACTION_ID_SET.has(namespacedId)) {
        const message = `Plugin "${pluginId}" command id "${namespacedId}" collides with a built-in action id`;
        console.error(`[PluginService] ${message}`);
        if (!isBuiltin) {
          this.records.upsertInstalledRecord(pluginId, {
            loadError: { message, at: Date.now() },
          });
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
        if (!isBuiltin) {
          this.records.upsertInstalledRecord(pluginId, { loadError });
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

      const resolvedPath = await this.resolveCommandHandlerPath(plugin.dir, cmd.id);
      if (resolvedPath) {
        this.commandModulePaths.set(descriptor.id, resolvedPath);
      }
      // Missing handler file: descriptor is still registered so the command
      // appears in the palette; dispatch surfaces the documented
      // `Command "{id}" has no handler` toast.
    }
    if (registered) {
      this.broadcaster.broadcastPluginActions();
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
   * Lazily resolve a manifest-declared command's handler module from
   * {@link commandModulePaths}, import it via `runImport`, and cache the
   * default export in {@link pluginActionHandlers}. Concurrent dispatches
   * race on the cache: the first to set wins; subsequent setters drop the
   * (identical) handler to avoid clobbering an in-flight set. ESM's
   * URL-keyed module cache makes the duplicate import effectively free, so
   * a full in-flight promise map adds no value here.
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
    const mod = (await this.runImport(pluginId, resolvedPath)) as { default?: unknown };
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
   * Actually import the plugin's `main` module, create its host, and run
   * `activate()`. Wrapped by {@link activatePlugin} for idempotency &
   * concurrent-caller dedup — direct callers will re-import on every call.
   * Errors are persisted to the provenance record but never rethrown by
   * `activatePlugin` (which exposes a never-rejecting promise to triggers).
   */
  private async _doActivate(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.resolvedMain) return;
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
      return this.activateViaWorker(pluginId, plugin);
    }
    try {
      // Bound the dynamic import — a built-in with a hanging top-level await
      // would otherwise pin this promise forever and stall `Promise.allSettled`
      // fan-outs (file-decoration scope, startup activation).
      const mod = (await this.runImport(pluginId, plugin.resolvedMain)) as {
        activate?: unknown;
      };
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
    if (!plugin.resolvedMain) return;
    // A re-activation while a worker is already live is a no-op — the worker
    // owns its own reload cycle; activatePlugin's idempotency normally prevents
    // this, but guard defensively against the unload-race re-entry path.
    if (this.pluginWorkers.has(pluginId)) return;

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
      pluginDir: plugin.dir,
      bundlePath: plugin.resolvedMain,
      mode: plugin.devMode ? "dev" : "prod",
      permissionExecArgv,
    });
    const bridge = new PluginDevWorkerMainBridge({
      pluginId,
      host,
      workerHost,
      getCapabilities: () => this.plugins.get(pluginId)?.manifest.capabilities ?? [],
      clearPriorRegistrations: () => {
        // Drop the prior generation's activate-time registrations before the
        // reloaded worker re-registers, so a handler the new code stopped
        // registering doesn't linger. Manifest-declared commands are registered
        // once at load time and NOT replayed on reload, so only imperative
        // (`host.registerAction`) actions are cleared — clearing all of them
        // would erase the plugin's palette commands after the first reload.
        this.removeHandlers(pluginId);
        this.unregisterImperativePluginActions(pluginId);
      },
      // Fires on every activation outcome (initial + each reload). Keeps the
      // provenance `loadError` in sync so a fix-and-save clears a stale error
      // and a freshly-introduced one is recorded — the first-activation promise
      // alone can't see post-reload outcomes.
      onActivationResult: (result) => {
        lastActivationOk = result.ok;
        if (plugin.isBuiltin) return;
        if (result.ok) {
          if (!this.pluginsWithLoadTimeErrors.has(pluginId)) {
            this.records.upsertInstalledRecord(pluginId, { loadError: null });
          }
        } else {
          this.records.upsertInstalledRecord(pluginId, {
            loadError: { message: result.error, stack: result.stack, at: Date.now() },
          });
        }
      },
    });

    // Tracks the most recent activate() outcome reported by the bridge. A failed
    // first activation must not be cached as "activated" (#10523 retry-on-reopen):
    // for a prod worker — which has no file watcher to auto-recover — we tear the
    // worker down below so a re-open (Settings → Retry) re-forks and re-runs.
    let lastActivationOk: boolean | undefined;

    const entry = { workerHost, bridge, revoke };
    this.pluginWorkers.set(pluginId, entry);

    // Register the teardown disposer up front so a concurrent unloadPlugin()
    // during fork/activation tears the worker down through the normal cascade.
    const cleanup = (): void => {
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
      cleanup();
      const loadError = toPluginLoadError(err);
      if (!plugin.isBuiltin) {
        this.records.upsertInstalledRecord(pluginId, { loadError });
      }
      console.error(`[PluginService] Failed to start worker for ${pluginId}:`, err);
      throw err;
    }

    // If an unload raced the fork, the cleanup already disposed everything.
    if (!this.plugins.has(pluginId) || this.pluginWorkers.get(pluginId) !== entry) {
      cleanup();
      return;
    }

    // Bound the first activation so a plugin with a hanging `activate()` (or a
    // never-resolving top-level await in the worker) can't stall the
    // `Promise.allSettled` startup gate forever. On timeout the worker stays
    // alive — `onActivationResult` will clear/record the error if activation
    // eventually settles (or, for a dev worker, a reload follows). The
    // provenance `loadError` is owned by `onActivationResult`; this catch only
    // logs and unblocks startup.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        bridge.waitForActivation(),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Plugin "${pluginId}" activate() did not settle within ${ACTIVATE_TIMEOUT_MS}ms`
              )
            );
          }, ACTIVATE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      // The worker didn't settle in time — typically a hanging `activate()` or a
      // never-resolving top-level await in the bundle. The worker stays alive in
      // isolation (it can't stall the main process); record the timeout as the
      // provenance loadError so diagnostics surface why the plugin never came up.
      // If activation eventually settles (or a dev reload follows),
      // `onActivationResult` overwrites this.
      if (!plugin.isBuiltin) {
        this.records.upsertInstalledRecord(pluginId, { loadError: toPluginLoadError(err) });
      }
      console.error(`[PluginService] Plugin "${pluginId}" activation:`, err);
    } finally {
      if (timer) clearTimeout(timer);
    }

    // A failed first activation must not be cached as a successful one
    // (#10523): `activatePlugin` adds the id to `activatedPlugins` when this
    // method resolves, which would short-circuit every later re-open. A dev
    // worker keeps watching so the author can fix the error and save to reload —
    // its retry path is the watcher, not a re-activation — so leave it alive.
    // A prod worker has no watcher, so the only recovery is a re-open / Settings
    // → Retry that re-runs `activatePlugin`; tear the failed worker down and
    // rethrow so the in-flight entry is dropped and the id is never cached,
    // mirroring the in-process loader's rethrow-on-activate-failure semantics.
    if (lastActivationOk === false && !plugin.devMode) {
      cleanup();
      throw new Error(`Plugin "${pluginId}" activate() failed`);
    }
  }

  /**
   * Wrap `import()` in a timeout race so a plugin with a hanging top-level
   * await (e.g. `await new Promise(() => {})`) can't stall the host. ESM's
   * URL-keyed module cache means a successful import resolves instantly on
   * retry; a hang only affects the first attempt.
   */
  private async runImport(pluginId: string, resolvedMain: string): Promise<unknown> {
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
      await Promise.allSettled(targets.map((id) => this.activatePlugin(id)));
    } finally {
      // Open the init gate even if every plugin's activate() rejected — a
      // crashed plugin must not strand renderer IPC callers awaiting
      // waitForInit() forever. `Promise.allSettled` already swallows
      // individual rejections, but `targets.length === 0` short-circuits
      // before the awaited line, so the finally is what guarantees release
      // in the no-plugins case.
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
   * contract), failures are read back from the persisted provenance `loadError`
   * after the await — covering all three failure modes (worker fork failure,
   * activate() timeout, activate() throw). An unknown kind id resolves to
   * `{ ok: true }`: there is nothing to activate, and the renderer's module
   * import then fails on its own with a more specific error.
   *
   * Limitation: built-in plugins have no installed provenance record, so a
   * built-in activation failure (logged, not persisted) reads back as
   * `{ ok: true }` here and falls through to the renderer's generic import
   * error. Built-ins are app-bundled trusted code where this is rare; surfacing
   * it would need a separate in-memory built-in load-error map.
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
  async activatePluginForView(
    panelKindId: string,
    requestRecoveryPath = false
  ): Promise<PluginActivationResult> {
    if (typeof panelKindId !== "string" || panelKindId.length === 0) return { ok: true };
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
            : live.manifest.contributes.views.find((v) => v.id === panel.id);
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
    return { ok: true };
  }

  /**
   * Activate every plugin whose `fileDecorationProviders` declares a scope
   * matching `scope`. Mirrors the registry-side `getFileDecorationImpls`
   * filter so the activation set is exactly the impl set that will be queried
   * once activation resolves. Runs activations in parallel — one slow plugin
   * must not stall an entire decoration pull.
   */
  async activatePluginsForFileDecorationScope(scope: string): Promise<void> {
    if (typeof scope !== "string" || scope.length === 0) return;
    const targets = new Set<string>();
    for (const [pluginId, plugin] of this.plugins) {
      for (const contribution of plugin.manifest.contributes.fileDecorationProviders) {
        if (contribution.scopes.some((pattern) => scopeMatchesPattern(scope, pattern))) {
          targets.add(pluginId);
          break;
        }
      }
    }
    if (targets.size === 0) return;
    await Promise.allSettled([...targets].map((id) => this.activatePlugin(id)));
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

    let rendered = typeof message === "string" ? message : safeStringify(message);
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

    const plugins = this.listPlugins()
      .filter((info) => this.plugins.has(info.manifest.name))
      .map((info) => {
        const pluginId = info.manifest.name;
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
      pluginFsWatchers: this.pluginFsWatchers,
      broadcaster: this.broadcaster,
      panelLifecycleBroker: this.panelLifecycleBroker,
      dispatcher: this.dispatcher,
      promptDispatcher: this.promptDispatcher,
      settings: this.settings,
      storage: this.storage,
      getHostGitFactory: () => this.hostGitFactory,
      getProcessManager: () => this.getProcessManager(),
      declaredCapabilities: (pluginId) => this.declaredCapabilities(pluginId),
      fetchAllWorktreeSnapshots: () => this.fetchAllWorktreeSnapshots(),
      fetchWorktreeSnapshotsForProject: (projectId, projectRoot) =>
        this.fetchWorktreeSnapshotsForProject(projectId, projectRoot),
      recordPluginLog: (boundPlugin, pluginId, level, message, fields) =>
        this.recordPluginLog(boundPlugin, pluginId, level, message, fields),
      serializePluginBadges: (pluginId) => this.serializePluginBadges(pluginId),
      pluginDataDir: (pluginId) => this.pluginDataDir(pluginId),
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
    };
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
          const channel = `plugin:${pluginId}:${PLUGIN_PROCESS_STREAM_CHANNEL}`;
          const projectId = this.hostBindings.get(pluginId)?.projectId ?? null;
          if (projectId === null) {
            broadcastToRenderer(channel, { panelId, payload: event });
            return;
          }
          broadcastToProjectRenderers(projectId, channel, { panelId, payload: event });
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

  _registerFakePluginForTests(plugin: LoadedPlugin): void {
    this.mintPluginAuthority(plugin.manifest.name, plugin.dir);
    this.plugins.set(plugin.manifest.name, plugin);
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
    const snapshots = needsSnapshots ? await this.fetchAllWorktreeSnapshots() : [];

    const entries: ExpandedFsPath[] = [];
    if (opts.includeDataDir) {
      entries.push({ path: this.pluginDataDir(pluginId), rootClass: "user-data" });
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

  /** Expand a single `allowedPaths` entry (token or literal) into a typed root. */
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
    const client = this.workspaceClient;
    if (!client) return [];
    const windowId = this.resolveScopeWindowId();
    if (windowId === undefined) return [];
    try {
      return await client.getAllStatesAsync(windowId);
    } catch (err) {
      console.error("[PluginService] Failed to fetch worktree snapshots:", err);
      return [];
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
    const client = this.workspaceClient;
    if (!client) return [];
    try {
      return await client.getAllStatesForProjectAsync(projectRoot, projectId);
    } catch (err) {
      console.error(
        `[PluginService] Failed to fetch worktree snapshots for project ${projectId}:`,
        err
      );
      return [];
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
   * If WorkspaceClient is not yet wired (early plugin activate during boot),
   * the subscription is queued in `pendingWorktreeSubs` and replayed when
   * `setWorkspaceClient()` is later called. The returned disposer handles
   * both the queued and the live state.
   */
  private subscribeWorktreeEvent(
    pluginId: string,
    event: WorkspaceWorktreeEvent,
    handler: (payload?: PluginWorktreeEventPayload) => void
  ): () => void {
    let boundClient: WorkspaceClient | null = null;
    let pendingRecord: (typeof this.pendingWorktreeSubs)[number] | null = null;
    let disposed = false;

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (boundClient) {
        boundClient.off(event, handler);
      } else if (pendingRecord) {
        const idx = this.pendingWorktreeSubs.indexOf(pendingRecord);
        if (idx >= 0) this.pendingWorktreeSubs.splice(idx, 1);
      }
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
          if (disposed) return;
          c.on(event, handler);
          boundClient = c;
          pendingRecord = null;
        },
      };
      this.pendingWorktreeSubs.push(pendingRecord);
    }

    return dispose;
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

    // Start the clock before activation so a failure record carries the full
    // dispatch cost (cold activation included) the renderer actually waited on.
    const dispatchStart = Date.now();
    // Implicit activation: the first dispatch into a plugin's channel forces
    // its `activate()` to run if it hasn't yet, so handlers registered during
    // activation are available on the very first call. No-op once activated.
    await this.activatePlugin(pluginId);

    const key = `${pluginId}:${channel}`;
    const descriptor = this.pluginActions.get(channel);
    // Main-side action handlers (host.registerAction) are addressed by the
    // namespaced action id and take precedence over a channel-keyed IPC
    // handler. Only honour one the dispatching plugin owns — the namespace
    // already guarantees this, and the guard mirrors the input-schema check.
    let actionHandler =
      descriptor?.pluginId === pluginId ? this.pluginActionHandlers.get(channel) : undefined;
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
      try {
        actionResult = await actionHandler(args.length > 0 ? args[0] : {});
      } catch (err) {
        // Contain at the boundary so a throwing handler can't propagate up
        // through `ipcMain.handle` as an unhandled rejection. The error still
        // surfaces to the renderer (rethrown after logging).
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
      }
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
    try {
      result = await handler(ctx, ...dispatchArgs);
    } catch (err) {
      // Contain at the boundary so a throwing plugin handler can't propagate
      // up through `ipcMain.handle` as an unhandled rejection in the main
      // process. The error still surfaces to the renderer (we rethrow after
      // logging) — the renderer-side wrapping in `usePluginActions` turns
      // that rejection into a user-facing toast.
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
    if (this.plugins.has(pluginId)) {
      this.unloadPlugin(pluginId);
    }
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
  }

  // ----- project-local plugins (`<projectRoot>/.daintree/plugins/`) -------

  /**
   * Lazily built so a service that never opens a project never constructs it,
   * and so tests can drive discovery/trust without a project view.
   */
  private projectPluginController: ProjectPluginController | null = null;

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
      unloadProjectPlugin: (instanceKey) => this.unloadPlugin(instanceKey),
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
        ]),
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
    await this.projectPlugins.onProjectOpened(projectId, projectRoot);
    await this.pushSnapshotToProject(projectId);
    await this.syncProjectPluginWatcher(projectId, projectRoot);
  }

  /** The user closed this project: unload everything it owns. */
  async onProjectClosed(projectId: string): Promise<void> {
    // Stop the watcher first: it is the one thing that could otherwise queue a
    // reload behind the teardown.
    this.projectPluginWatcherRegistry?.stop(projectId);
    if (!this.projectPluginController) return;
    await this.projectPluginController.onProjectClosed(projectId);
    await this.pushSnapshotToProject(projectId);
  }

  async setProjectPluginTrust(
    projectId: string,
    decision: ProjectPluginTrustDecision
  ): Promise<void> {
    await this.projectPlugins.setTrust(projectId, decision);
    await this.pushSnapshotToProject(projectId);
    await this.syncProjectPluginWatcher(projectId);
  }

  async activateStagedProjectPlugin(projectId: string, pluginId: string): Promise<void> {
    await this.projectPlugins.activateStaged(projectId, pluginId);
    await this.pushSnapshotToProject(projectId);
    await this.syncProjectPluginWatcher(projectId);
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
   * A watcher exists for exactly the projects whose plugins are trusted and
   * open. Trust is the gate: an untrusted project's folder is never watched,
   * so a revoke or a "no" tears the native subscription down with everything
   * else.
   */
  private async syncProjectPluginWatcher(projectId: string, projectRoot?: string): Promise<void> {
    // A close can land while an open is still awaiting its snapshot push, and
    // the idle auto-close service and the free-memory IPC flip a row to
    // "closed" without ever reaching `onProjectClosed`. Re-reading the row here
    // is what keeps either from leaving a live native watcher behind.
    if (
      this.disposed ||
      this.isProjectRowClosed(projectId) ||
      !this.projectPlugins.getTrustState(projectId).enabled
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
  }): Promise<boolean> {
    const instanceKey = makeProjectPluginInstanceKey(args.projectId, args.manifest.name);
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
    });
    if (!loaded) return false;

    // Activation still obeys the manifest's own activation events — a trusted
    // project plugin with no `onStartupFinished` does not execute until
    // something actually triggers it, exactly like an installed plugin.
    if (this.shouldActivateOnStartup(loaded.manifest)) {
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
  }

  unloadPlugin(pluginId: string): void {
    if (!this.plugins.has(pluginId)) return;
    // Drop activation state so a runtime reload (e.g. dev-mode re-scan) can
    // re-activate from scratch — otherwise the fast-path `activatedPlugins`
    // hit would short-circuit `_doActivate` after the new manifest landed.
    this.activatedPlugins.delete(pluginId);
    this.activationPromises.delete(pluginId);
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
    runUnloadStep(pluginId, "unregisterPluginMenuItems", () => unregisterPluginMenuItems(pluginId));
    runUnloadStep(pluginId, "unregisterPluginKeybindings", () =>
      unregisterPluginKeybindings(pluginId)
    );
    runUnloadStep(pluginId, "scheduleKeybindingsBroadcast", () =>
      this.broadcaster.scheduleKeybindingsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginContextMenuItems", () =>
      unregisterPluginContextMenuItems(pluginId)
    );
    runUnloadStep(pluginId, "scheduleContextMenuItemsBroadcast", () =>
      this.broadcaster.scheduleContextMenuItemsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterWhenClausePlugin", () =>
      unregisterWhenClausePlugin(pluginId)
    );
    runUnloadStep(pluginId, "unregisterPluginToolbarButtons", () =>
      unregisterPluginToolbarButtons(pluginId)
    );
    runUnloadStep(pluginId, "scheduleToolbarButtonsBroadcast", () =>
      this.broadcaster.scheduleToolbarButtonsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginPanelKinds", () =>
      unregisterPluginPanelKinds(pluginId)
    );
    // Its own step (#9322): the per-subscription disposers already ran via
    // `flushPluginEventCleanups`, but a disposer lost to an earlier throw would
    // otherwise strand a listener holding this plugin's closure alive.
    runUnloadStep(pluginId, "clearPanelLifecycleListeners", () =>
      this.panelLifecycleBroker.clearPlugin(pluginId)
    );
    runUnloadStep(pluginId, "unregisterForgeProviders", () => unregisterForgeProviders(pluginId));
    runUnloadStep(pluginId, "unregisterForgeProviderImpls", () =>
      unregisterForgeProviderImpls(pluginId)
    );
    // Mirror the load-path notify (loadPlugin, ~line 1152): a runtime disable
    // removes forge descriptors/impls from the registry, so workspace hosts
    // whose PR polling resolved (or no-matched) against this provider must
    // re-evaluate. A spurious notify for a plugin that contributed no forge
    // provider is harmless — PullRequestService only invalidates a cached
    // no-match. Without this, live-disable left stale provider resolution.
    runUnloadStep(pluginId, "notifyForgeProviderRegistryUpdated", () =>
      this.workspaceClient?.notifyForgeProviderRegistryUpdated()
    );
    runUnloadStep(pluginId, "unregisterFileDecorationProviders", () =>
      unregisterFileDecorationProviders(pluginId)
    );
    runUnloadStep(pluginId, "unregisterFileDecorationProviderImpls", () =>
      unregisterFileDecorationProviderImpls(pluginId)
    );
    runUnloadStep(pluginId, "unregisterPluginSkills", () => unregisterPluginSkills(pluginId));
    // Recipes retract on unload/disable/reload, but their sidecar metadata does
    // NOT — only an explicit successful uninstall purges that (#11860).
    runUnloadStep(pluginId, "unregisterPluginRecipes", () => unregisterPluginRecipes(pluginId));
    runUnloadStep(pluginId, "scheduleRecipesBroadcast", () =>
      this.broadcaster.scheduleRecipesBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginAgents", () => unregisterPluginAgents(pluginId));
    runUnloadStep(pluginId, "scheduleAgentsBroadcast", () =>
      this.broadcaster.scheduleAgentsBroadcast(true)
    );
    // Re-mirror the (now-smaller) registry to the pty-host so it stops resolving
    // detection patterns for the unloaded plugin's agents (#10587).
    runUnloadStep(pluginId, "syncPluginAgentRegistryToPtyHost", () =>
      getPtyClient()?.syncPluginAgentRegistry()
    );
    runUnloadStep(pluginId, "unregisterPluginProcessTools", () =>
      unregisterPluginProcessTools(pluginId)
    );
    // Re-mirror the (now-smaller) registry so the pty-host stops resolving the
    // unloaded plugin's command detections. A discrete step from the unregister
    // above per the unload-cascade contract — a throw in one can't strand the
    // other (#11613).
    runUnloadStep(pluginId, "syncPluginProcessToolRegistryToPtyHost", () =>
      getPtyClient()?.syncPluginProcessToolRegistry()
    );
    // Subscriber disposers already fired in flushPluginEventCleanups() above;
    // this drops any leftover subscriber-set entry and the in-memory settings
    // store caches so a reload starts from disk.
    runUnloadStep(pluginId, "clearPluginSettingsState", () =>
      this.settings.clearPluginSettingsState(pluginId)
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
    // manifest can successfully clear `loadError` on next activation.
    this.pluginsWithLoadTimeErrors.delete(pluginId);

    // Drop the diagnostic log ring buffer so a reload of the same plugin
    // doesn't carry forward log lines from the previous session.
    this.logBuffers.delete(pluginId);

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
    this.hostBindings.delete(pluginId);
    // Drop the project-scope index entry with the instance it described.
    // Leaving it behind would keep filtering broadcasts against a plugin id
    // that no longer exists, and would resurface if the id were reloaded
    // under a different project.
    runUnloadStep(pluginId, "clearPluginContributionScope", () =>
      clearPluginContributionScope(pluginId)
    );

    // Drop any live panel badges this plugin set and tell the renderer to clear
    // them (#10585). Only broadcast when the plugin actually had badges so an
    // unload of a non-badging plugin stays silent.
    if (this.pluginBadges.delete(pluginId)) {
      runUnloadStep(pluginId, "clearPanelBadges", () => {
        broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
          name: "plugin:panel-badges-cleared",
          payload: { pluginId },
        });
      });
    }

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
  getWorkerGovernanceSnapshots(): WorkerResourceSnapshot[] {
    const snapshots: WorkerResourceSnapshot[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.isBuiltin) continue;
      const entry = this.pluginWorkers.get(pluginId);
      const loadError = this.records.getInstalledRecord(pluginId)?.loadError ?? null;
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
      if (this.deactivateIdleWorker(pluginId)) {
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
      lastActivityAt: this.pluginWorkerActivity.get(pluginId) ?? null,
      now: opts?.now ?? Date.now(),
      idleDisposeMs: opts?.idleDisposeMs,
    });
  }

  /**
   * Narrow worker teardown for the idle-dispose path: the worker, bridge, and
   * activate-time imperative registrations go; the plugin, its manifest
   * contributions, and its provenance record stay. The next lazy trigger
   * (dispatch, panel open, forge/decoration pull) re-forks via
   * `activateViaWorker` exactly like a dev reload re-registers over
   * `clearPriorRegistrations` — that cycle is the proof this teardown is
   * re-entrant. Contrast `unloadPlugin`, which removes the plugin entirely.
   */
  private deactivateIdleWorker(pluginId: string): boolean {
    const entry = this.pluginWorkers.get(pluginId);
    if (!entry) return false;
    this.activatedPlugins.delete(pluginId);
    this.activationPromises.delete(pluginId);
    const cleanup = this.cleanupMap.get(pluginId);
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(`[PluginService] Idle-dispose cleanup for "${pluginId}" threw:`, err);
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

    const toInfo = (
      p: { manifest: PluginManifest; dir: string; isBuiltin: boolean },
      loadedAt: number,
      isRunning: boolean,
      blocklistReason?: string
    ): LoadedPluginInfo => {
      const disabled = desiredDisabled.has(p.manifest.name);
      // pendingRestart: desired state diverges from running state.
      // Running + now-disabled → unload pending; skipped + now-enabled → load pending.
      // Blocklisted plugins are host-refused, not user-toggled — no pending cue.
      const blocklisted = blocklistReason !== undefined;
      const pendingRestart = blocklisted ? false : isRunning ? disabled : !disabled;
      const pluginDanger = computePluginDanger(p.manifest);
      if (p.isBuiltin) {
        return {
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
      const record = installed[p.manifest.name];
      return {
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
        loadError: blocklisted ? null : (record?.loadError ?? null),
        disabled,
        updateAvailable: record?.updateAvailable ?? null,
        devMode: record?.devMode ?? false,
        pendingRestart,
        pluginDanger,
        blocklisted,
        blocklistReason,
      };
    };

    // Plugins that loaded and are running this session.
    const running = Array.from(this.plugins.values()).map((p) => toInfo(p, p.loadedAt, true));

    // Plugins skipped at launch because they were disabled. They carry no
    // `loadedAt` — the main module never ran — so it's reported as 0.
    const skipped = Array.from(this.disabledPlugins.values()).map((p) => toInfo(p, 0, false));

    // Plugins refused at launch by the blocklist / kill-switch (#10891). Also
    // never ran (`loadedAt: 0`); the reason drives the "Blocked" badge/banner.
    const blocked = Array.from(this.blockedPlugins.values()).map((p) =>
      toInfo(p, 0, false, p.reason)
    );

    return [...running, ...skipped, ...blocked];
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
    return this.pluginRootsByAuthority.get(authority);
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
    this.pluginRootsByAuthority.set(authority, dir);
    this.pluginRootsByAuthority.set(pluginId, dir);
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
    if (!this.plugins.has(pluginId) && !this.disabledPlugins.has(pluginId)) return;

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
      if (!loaded) {
        // Engine gate, manifest error, or a throw: restore the reservation. The
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
    if (!plugin) return;
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
   * load succeeded (or the plugin has never been loaded). Reads from the
   * persisted provenance record so the error survives a host restart.
   */
  getPluginLoadError(pluginId: string): PluginLoadError | undefined {
    return this.records.getInstalledRecord(pluginId)?.loadError ?? undefined;
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
    if (typeof category !== "string" || !category.trim()) {
      throw new Error(`Plugin action "${id}" must have a non-empty category`);
    }
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
    const dangerCapabilities = requires === undefined ? manifestCapabilities : requires;
    const hasHighRiskCapability = dangerCapabilities.some((p) =>
      CONFIRM_TRIGGERING_CAPABILITIES.has(p)
    );
    const hasCompoundElevation = manifestTriggersCompoundElevation(manifest, dangerCapabilities);
    const effectiveDanger: "safe" | "confirm" =
      danger === "confirm" || hasHighRiskCapability || hasCompoundElevation ? "confirm" : "safe";

    return {
      pluginId,
      id,
      title,
      description,
      category,
      kind,
      danger,
      effectiveDanger,
      keywords: Array.isArray(contribution.keywords) ? [...contribution.keywords] : undefined,
      inputSchema:
        contribution.inputSchema && typeof contribution.inputSchema === "object"
          ? { ...contribution.inputSchema }
          : undefined,
      requires,
    };
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

    this.broadcaster.broadcastPluginActions();
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

    this.broadcaster.broadcastPluginActions();
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

    this.broadcaster.broadcastPluginActions();
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
    if (changed) this.broadcaster.broadcastPluginActions();
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

  /**
   * Replay the current actions / panel-kinds / toolbar-button snapshots to a
   * single target webContents. Used by the cold-start view-ready hook so a
   * freshly-restored WebContentsView (post-LRU eviction or first cold load on
   * project switch) gets a complete plugin state on the same channels its
   * persistent push listeners already consume — no renderer-side changes
   * needed. Awaits {@link waitForInit} so the snapshot is post-activation, not
   * the empty pre-init view (#9285).
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
    await this.broadcaster.pushSnapshotTo(webContents);
    if (webContents.isDestroyed()) return;
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
});

// E2E backdoor: activate a loaded plugin by id without adding a production IPC
// surface. Production builds replace DAINTREE_E2E_MODE with "" and strip this.
if (isE2EMode) {
  const activateKey = ["__", "daintree", "Activate", "E2E", "Plugin"].join("");
  (globalThis as Record<string, unknown>)[activateKey] = (pluginId: string) =>
    pluginService.activatePlugin(pluginId);
}
