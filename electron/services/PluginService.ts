import fs from "fs/promises";
import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
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

interface ValidateFn {
  (data: unknown): boolean;
  $async?: boolean;
  errors?: Array<{ instancePath: string; message?: string }>;
}

interface AjvInstance {
  compile(schema: Record<string, unknown>): ValidateFn;
}

import {
  DEPRECATED_CONTRIBUTION_ALIASES,
  getPluginManifestSchema,
  PluginToastOptionsSchema,
} from "../schemas/plugin.js";
import { getPluginMcpSupervisor } from "./PluginMcpSupervisor.js";
import { PluginProcessManager } from "./plugin/PluginProcessManager.js";
import { resolveContainedPath } from "./plugin/pluginFsContainment.js";
import { PluginHostGit, type HostGitFactory } from "./plugin/pluginHostGit.js";
import {
  PLUGIN_PROCESS_STREAM_CHANNEL,
  type PluginProcessInfo,
} from "../../shared/types/ipc/pluginProcess.js";
import { z } from "zod";
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
  PluginQuickPickItem,
  PluginQuickPickOptions,
  BuiltInPluginCapability,
  PluginLoadError,
  PluginInstallResult,
  PluginInstallOptions,
  PluginCheckUpdateResult,
  PluginSettingsScope,
  PluginSettingsUiValues,
  PluginWorktreeStatus,
  PluginProcessApi,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginFsApi,
  PluginFsDirEntry,
  PluginFsStat,
  PluginGitApi,
  PluginGitStatus,
  PluginGitCommitOptions,
  PluginGitCommitResult,
  ViewContribution,
} from "../../shared/types/plugin.js";
import { PluginInstalledRecordsStore } from "./plugin/PluginInstalledRecordsStore.js";
import { PluginContributionBroadcaster } from "./plugin/PluginContributionBroadcaster.js";
import { PluginRendererDispatcher } from "./plugin/PluginRendererDispatcher.js";
import { PluginUIPromptDispatcher } from "./plugin/PluginUIPromptDispatcher.js";
import { PluginSettingsManager, assertSettingsKey } from "./plugin/PluginSettingsManager.js";
import { PluginChannelRegistry, isChannelSchema } from "./plugin/PluginChannelRegistry.js";
import { PluginInstaller } from "./plugin/PluginInstaller.js";
import { PluginDevWorkerHost } from "./plugin/PluginDevWorkerHost.js";
import { PluginDevWorkerMainBridge } from "./plugin/PluginDevWorkerMainBridge.js";
import { PluginInvokeOwnershipError } from "./plugin/PluginInvokeErrors.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import {
  toPluginWorktreeSnapshot,
  toPluginWorktreeStatus,
} from "../../shared/utils/pluginWorktreeSnapshot.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
  onPanelKindRegistered,
  onPanelKindUnregistered,
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
  registerForgeProviderImpl,
  registerForgeProviders,
  unregisterForgeProviderImpl,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "./forgeProviderRegistry.js";
import { buildStoredCredentials } from "./forge/forgeCredentialUtils.js";
import { makeForgeProviderId } from "../../shared/utils/forgeProviderIds.js";
import {
  registerFileDecorationProviderImpl,
  registerFileDecorationProviders,
  scopeMatchesPattern,
  unregisterFileDecorationProviderImpl,
  unregisterFileDecorationProviderImpls,
  unregisterFileDecorationProviders,
} from "./fileDecorationRegistry.js";
import {
  registerPluginAgents,
  unregisterPluginAgents,
} from "../../shared/config/pluginAgentRegistry.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { deepFreeze } from "../utils/deepFreeze.js";
import { CHANNELS } from "../ipc/channels.js";
import type { LoadedPluginInfo } from "../../shared/types/plugin.js";
import type { PluginToolbarButtonId } from "../../shared/types/toolbar.js";
import { getPluginActionAuditService } from "./PluginActionAuditService.js";
import { stableArgsSha256 } from "../utils/pluginMcpHash.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { markAuditedHandlerFailure } from "../utils/pluginAuditMarker.js";
import type {
  PluginDiagnosticsAuditRecord,
  PluginDiagnosticsLogLine,
  PluginDiagnosticsSnapshot,
} from "../../shared/types/ipc/pluginDiagnostics.js";
import { BUILT_IN_ACTION_IDS } from "../../shared/config/actionIds.js";
import { CONFIRM_TRIGGERING_CAPABILITIES } from "../../shared/config/pluginCapabilities.js";

/** Plugin action IDs must be `{pluginId}.{actionId}`. Built-in IDs use colons, so the formats cannot collide. */
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

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
 * handler module, in precedence order. `.ts`/`.tsx` resolve in Electron 41
 * (Node 24's type-stripping covers `.ts`; `.tsx` needs the plugin author to
 * pre-compile or it'll fail at first dispatch) so a dev-mode plugin can ship
 * source directly. The probe is async file-access only — no module evaluation
 * happens until dispatch time.
 */
const COMMAND_HANDLER_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"] as const;

/**
 * Compound-capability lattice (#9247). The flat
 * {@link CONFIRM_TRIGGERING_CAPABILITIES} set only catches single capabilities
 * that are themselves irreversible. It misses the two compound threat classes:
 *
 * 1. **Exfiltration** — a sensitive read paired with an unconstrained network
 *    or shell sink. Neither side alone is destructive (read-only or merely
 *    capable of network I/O), but together they form a data-exfiltration path.
 * 2. **Remote-controlled mutation** — `network:fetch` paired with a local
 *    write or shell sink. Both sides may already elevate individually
 *    (`fs:*-write`, `git:write`, `shell:exec` are flat-elevated), but the
 *    compound rule documents the intent and is belt-and-suspenders if the
 *    flat set ever drifts.
 *
 * A plugin can attenuate the elevation by declaring tight scopes on the sink
 * — currently only `scopes.network.allowedUrls` is consulted, since
 * `shell:exec` is categorically high-risk and fs writes already elevate
 * individually. Wildcard rejection is enforced at the schema boundary so the
 * runtime only needs to check non-empty presence; see
 * `electron/schemas/plugin.ts`.
 */
const SENSITIVE_READ_CAPABILITIES: ReadonlySet<BuiltInPluginCapability> = new Set([
  "agent:read",
  "git:read",
  "fs:project-read",
  "fs:user-data-read",
]);
const REMOTE_MUTATION_SINK_CAPABILITIES: ReadonlySet<BuiltInPluginCapability> = new Set([
  "fs:project-write",
  "fs:user-data-write",
  "git:write",
  "shell:exec",
]);

function manifestHasTightNetworkScope(manifest: PluginManifest | undefined): boolean {
  const urls = manifest?.scopes?.network?.allowedUrls;
  return Array.isArray(urls) && urls.length > 0;
}

function manifestTriggersCompoundElevation(
  manifest: PluginManifest | undefined,
  declaredCapabilities: readonly BuiltInPluginCapability[]
): boolean {
  if (declaredCapabilities.length < 2) return false;
  const capSet = new Set<BuiltInPluginCapability>(declaredCapabilities);
  const hasSensitiveRead = [...SENSITIVE_READ_CAPABILITIES].some((c) => capSet.has(c));
  const hasNetworkFetch = capSet.has("network:fetch");
  const hasShellExec = capSet.has("shell:exec");
  const networkScoped = manifestHasTightNetworkScope(manifest);

  // Exfiltration class: sensitive read + unconstrained sink.
  if (hasSensitiveRead) {
    if (hasShellExec) return true;
    if (hasNetworkFetch && !networkScoped) return true;
  }

  // Remote-controlled mutation class: network:fetch (the remote control
  // channel) + any local write or shell sink. A tightly-scoped network:fetch
  // can't be remote-controlled, so the scope attenuates this class too.
  if (hasNetworkFetch && !networkScoped) {
    for (const sink of REMOTE_MUTATION_SINK_CAPABILITIES) {
      if (capSet.has(sink)) return true;
    }
  }

  return false;
}

/**
 * Aggregate danger verdict for a whole plugin (vs. the per-action
 * `effectiveDanger` computed in {@link PluginService.validateAndBuildActionDescriptor}).
 * Surfaced on {@link LoadedPluginInfo.pluginDanger} so the manager UI can show
 * an effective-danger summary without re-deriving the lattice in the renderer.
 * Single source of truth on main: reuses {@link CONFIRM_TRIGGERING_CAPABILITIES}
 * and {@link manifestTriggersCompoundElevation} rather than spawning a third copy.
 */
function computePluginDanger(manifest: PluginManifest | undefined): "safe" | "confirm" {
  const caps = manifest?.capabilities ?? [];
  if (caps.some((c) => CONFIRM_TRIGGERING_CAPABILITIES.has(c))) return "confirm";
  if (manifestTriggersCompoundElevation(manifest, caps)) return "confirm";
  return "safe";
}

interface LoadedPlugin {
  /** Deep-frozen at load (see `deepFreeze` call in `loadPlugin`); `Readonly` is the compile-time half of that invariant. */
  manifest: Readonly<PluginManifest>;
  dir: string;
  resolvedMain?: string;
  loadedAt: number;
  isBuiltin: boolean;
  /** SHA-256 hex digest of the `.dntr` archive, set by the installer at install time. */
  archiveHash?: string;
  /**
   * True when the plugin dir carries a {@link DEV_MARKER_FILENAME} (written by
   * `daintree-plugin dev`). Dev plugins activate inside a `utilityProcess.fork`
   * worker that hot-reloads on `dist/index.js` rebuilds (#9304), instead of the
   * in-process `import()` loader.
   */
  devMode?: boolean;
}

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
 * Max file paths a single `host.invalidateFileDecorations` call broadcasts.
 * A misbehaving plugin could otherwise pass an unbounded array, forcing an
 * arbitrarily large IPC payload to every renderer view. Beyond the cap the
 * scope-wide invalidation (no `paths`) is the correct fallback anyway.
 */
const MAX_FILE_DECORATION_PATHS = 1000;
/**
 * Floor for a plugin-supplied `onDidChangeWorktrees` `debounceMs`. A positive
 * value below this is clamped up so a plugin can't request a near-zero debounce
 * that defeats the coalescing intent while still paying timer overhead; `0` /
 * omitted disables debouncing entirely (fire on every change).
 */
const MIN_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS = 50;

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
 * Validate the `items` passed to `host.showQuickPick` and return a structurally
 * narrowed copy — only the serializable fields cross the IPC boundary, so a
 * plugin that attaches extra non-cloneable properties (functions, class
 * instances) can't strand the send. Throws on a non-array or any malformed row
 * so authoring mistakes surface loudly (mirrors the showToast options check).
 */
function validateQuickPickItems(
  pluginId: string,
  items: PluginQuickPickItem[]
): PluginQuickPickItem[] {
  if (!Array.isArray(items)) {
    throw new Error(`Plugin "${pluginId}" showQuickPick: items must be an array`);
  }
  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Plugin "${pluginId}" showQuickPick: items[${index}] must be an object`);
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(
        `Plugin "${pluginId}" showQuickPick: items[${index}].id must be a non-empty string`
      );
    }
    if (typeof item.label !== "string") {
      throw new Error(`Plugin "${pluginId}" showQuickPick: items[${index}].label must be a string`);
    }
    return {
      id: item.id,
      label: item.label,
      ...(item.description !== undefined ? { description: String(item.description) } : {}),
      ...(item.detail !== undefined ? { detail: String(item.detail) } : {}),
    };
  });
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
 * Build the `plugin://{pluginId}/{path}` URL that `PluginViewHost` passes to
 * `import()`. Strips a single leading `./` so the host segment doesn't end up
 * with an awkward `./dist/view.js` path component — the URL handler accepts
 * either form, but the canonical shape matches the protocol docs.
 */
function buildPluginViewUrl(pluginId: string, componentPath: string): string {
  const normalized = componentPath.startsWith("./") ? componentPath.slice(2) : componentPath;
  return `plugin://${pluginId}/${normalized}`;
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

type WorkspaceWorktreeEvent = "worktree-update" | "worktree-activated" | "worktree-removed";

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  /**
   * Per-plugin diagnostic log ring buffer, keyed by `pluginId` (= manifest
   * name). Written by `host.logger.*`, capped at {@link PLUGIN_LOG_BUFFER_MAX}
   * lines (FIFO eviction), and cleared in {@link unloadPlugin} so a reload of
   * the same plugin starts clean. Lines are stored raw — secret/path scrubbing
   * happens only at the report-export boundary, never here (mirrors the
   * action-breadcrumb ring's raw-capture convention).
   */
  private logBuffers = new Map<string, PluginDiagnosticsLogLine[]>();
  /**
   * Owns the typed/legacy IPC handler maps, the registration capability gate,
   * per-channel schema/requires bookkeeping, and per-plugin removal. The
   * dispatch path ({@link dispatchHandler}, which stays here) reads the maps
   * through the collaborator's getters so dispatch semantics are unchanged.
   */
  private readonly channels: PluginChannelRegistry;
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
   * Event subscriptions registered during plugin `activate()` when the
   * WorkspaceClient did not yet exist. Replayed in `setWorkspaceClient()`
   * so early-boot subscriptions attach to the real client instead of being
   * silently dropped.
   */
  private pendingWorktreeSubs: Array<{
    pluginId: string;
    event: WorkspaceWorktreeEvent;
    handler: () => void;
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
   * Per-plugin transition chain for live built-in enable/disable (#9304). A
   * rapid disable→enable→disable on the same id must not interleave the
   * unload/load mutations to `plugins`/`disabledPlugins`/`reservedNames`, so
   * each `setEnabled` for a built-in chains onto the prior transition for that
   * id. Keyed by `manifest.name`; the entry is dropped once its chain settles.
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
   * Live dev-mode hot-reload workers, keyed by pluginId (#9304). Each holds the
   * forked `utilityProcess` lifecycle, the message bridge to the real host, and
   * the host `revoke` to call on unload. Disposed via the {@link cleanupMap}
   * disposer registered at activation, so `unloadPlugin` tears the worker down
   * through its normal cascade.
   */
  private devWorkers = new Map<
    string,
    { workerHost: PluginDevWorkerHost; bridge: PluginDevWorkerMainBridge; revoke: () => void }
  >();
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
    options?: { builtinPluginsRoot?: string; sideloadPluginsRoot?: string }
  ) {
    this.pluginsRoot = pluginsRoot ?? path.join(os.homedir(), ".daintree", "plugins");
    this.appVersion = appVersion ?? app.getVersion();
    this.builtinPluginsRoot = options?.builtinPluginsRoot;
    this.sideloadPluginsRoot = options?.sideloadPluginsRoot;

    this.initPromise = new Promise<void>((resolve) => {
      this.resolveInit = resolve;
    });

    this.broadcaster = new PluginContributionBroadcaster({
      isDisposed: () => this.disposed,
      listPluginActions: () => this.listPluginActions(),
      initPromise: this.initPromise,
    });

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
      getPlugin: (pluginId) => this.plugins.get(pluginId) ?? this.disabledPlugins.get(pluginId),
      reservedNames: this.reservedNames,
      disabledPlugins: this.disabledPlugins,
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
   * Stop forwarding shared registry events to the renderer. Intended for
   * tests that need a clean teardown — production code holds a single
   * `pluginService` singleton for the app lifetime. Also drops any pending
   * batched broadcast so a microtask scheduled before disposal doesn't leak
   * an emit into the next test.
   */
  dispose(): void {
    this.disposed = true;
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
    this.disposeRegistrySubscriptions();
    // Settle the init gate so unit tests that tear down the service without
    // running activateStartupFinishedPlugins() don't hang IPC callers awaiting
    // waitForInit().
    this.resolveInit?.();
    this.resolveInit = null;
    this.dispatcher.dispose();
    this.promptDispatcher.dispose();
  }

  /**
   * Inject the WorkspaceClient after it's been created. PluginService may be
   * initialized before WorkspaceClient in the startup sequence, so we can't
   * take it in the constructor. Safe to call multiple times; the latest
   * reference wins. When set for the first time, replays any pending event
   * subscriptions that were registered during early plugin activate().
   */
  setWorkspaceClient(client: WorkspaceClient | null): void {
    this.workspaceClient = client;
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
    await this.installer.sweepStalePluginTempDirs();

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
    } finally {
      // Idempotency must hold even when a scan throws (e.g. EACCES on the
      // user dir): a retry would re-run the built-in scan and trigger
      // "already registered, overwriting" warnings from the contribution
      // registries.
      this.initialized = true;
    }
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
    opts: { isBuiltin: boolean; disabled: Set<string> }
  ): Promise<LoadedPlugin | null> {
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

    const parseResult = getPluginManifestSchema(opts.isBuiltin).safeParse(json);
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
        if (!opts.isBuiltin) {
          this.records.upsertInstalledRecord(String(inferredName ?? dirName), {
            loadError: { message: namespaceIssue.message, at: Date.now() },
          });
        }
      }
      console.error(`[PluginService] Invalid manifest in ${dirName}:`, parseResult.error.issues);
      return null;
    }

    const manifest = parseResult.data;
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

    // Plugins disabled in Preferences are skipped entirely — neither
    // registered in the plugins map nor activated — for both built-in and
    // user plugins (#9284). The disable persists in electron-store and takes
    // effect on next launch. The name is reserved so a later dir scan cannot
    // hijack a claimed namespace just because the matching plugin is off; the
    // manifest is tracked so listPlugins() can still surface it for the toggle.
    if (opts.disabled.has(manifest.name)) {
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

    if (this.plugins.has(manifest.name) || this.reservedNames.has(manifest.name)) {
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
    if (!opts.isBuiltin) {
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
    };

    if (manifest.main) {
      const resolved = this.resolveEntryPath(pluginDir, manifest.main);
      if (resolved) {
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
    // Synchronous `existsSync` on purpose: an `await` here would split the
    // synchronous critical section between the duplicate-name check above and
    // the `this.plugins.set` below, letting two concurrent loads of the same
    // name both slip past dedup.
    if (!opts.isBuiltin) {
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

    // Index views by bare id so the panels loop can attach `componentPath` in
    // a single registerPanelKind pass (#9229). View ids are pre-namespace; the
    // runtime panel id is `${manifest.name}.${panel.id}`.
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
      const panelId = `${manifest.name}.${panel.id}`;
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
        extensionId: manifest.name,
        ...(view && !panel.hasPty
          ? { componentPath: buildPluginViewUrl(manifest.name, view.componentPath) }
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

    for (const btn of manifest.contributes.toolbarButtons) {
      // Canonical `{pluginId}.{id}` form (#9281) — matches `registerPluginAction`
      // and `panelKindRegistry`. The legacy `plugin.{pluginId}.{id}` form lived
      // here alone and is migrated renderer-side by `toolbarPreferencesStore`'s
      // v9 migration so existing user pins survive the rename.
      const buttonId = `${manifest.name}.${btn.id}` as PluginToolbarButtonId;
      registerToolbarButton({
        id: buttonId,
        label: btn.label,
        iconId: btn.iconId,
        actionId: btn.actionId,
        priority: btn.priority ?? 3,
        pluginId: manifest.name,
      });
    }
    if (manifest.contributes.toolbarButtons.length > 0) {
      this.broadcaster.scheduleToolbarButtonsBroadcast(false);
    }

    for (const menuItem of manifest.contributes.menuItems) {
      trackPluginExpression(manifest.name, menuItem.when);
      registerPluginMenuItem(manifest.name, menuItem);
    }

    for (const keybinding of manifest.contributes.keybindings) {
      trackPluginExpression(manifest.name, keybinding.when);
      registerPluginKeybinding(manifest.name, keybinding);
    }
    if (manifest.contributes.keybindings.length > 0) {
      this.broadcaster.scheduleKeybindingsBroadcast(false);
    }

    for (const ctxMenu of manifest.contributes.contextMenus) {
      trackPluginExpression(manifest.name, ctxMenu.when);
      registerPluginContextMenuItem(manifest.name, ctxMenu);
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
      registerForgeProviders(manifest.name, manifest.contributes.forgeProviders);
      // Wake workspace-hosts whose PR polling paused on a "no provider
      // matches" resolution so they re-evaluate against the new descriptor
      // (#9997). Covers both the startup scan and runtime install/enable.
      this.workspaceClient?.notifyForgeProviderRegistryUpdated();
    }

    if (manifest.contributes.fileDecorationProviders.length > 0) {
      registerFileDecorationProviders(manifest.name, manifest.contributes.fileDecorationProviders);
    }

    if (manifest.contributes.agents.length > 0) {
      registerPluginAgents(manifest.name, manifest.contributes.agents);
      this.broadcaster.scheduleAgentsBroadcast(false);
    }

    // Insert the plugin into the registry BEFORE importing its main module so
    // synchronous host-API calls made during module evaluation (e.g., a plugin
    // that calls host.registerAction/registerHandler at import time) see the
    // plugin as loaded. Without this, `hasPlugin(pluginId)` returns false
    // inside the plugin's own init, and registerHandler/registerPluginAction
    // throw "Unknown plugin" even for a correctly loaded plugin.
    this.plugins.set(manifest.name, plugin);

    // Plugins without a `main` entry contribute no executable code — the
    // provenance record reflects a clean load immediately. Plugins with a
    // `main` entry defer the `loadError: null` write to `_doActivate()` so
    // the record only clears once activation actually succeeds. This must
    // happen BEFORE manifest command registration: a colliding command
    // writes its own `loadError` via `registerManifestCommands` (#9281), and
    // clearing it back to `null` here would silently lose the diagnostic.
    if (!plugin.resolvedMain && !opts.isBuiltin) {
      this.records.upsertInstalledRecord(manifest.name, { loadError: null });
    }

    // Manifest-declared commands (#9281): register descriptors at load time so
    // the command appears in the action palette before activation; probe the
    // filesystem-convention handler path but defer the actual `import()` to
    // first dispatch (the 5s activation budget can't pay N import costs up
    // front). Probes happen after `plugins.set()` so
    // `validateAndBuildActionDescriptor` sees the plugin as loaded.
    if (manifest.contributes.commands.length > 0) {
      await this.registerManifestCommands(manifest.name, plugin, opts.isBuiltin);
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
   * Probe `{pluginDir}/src/{cmdId}.{ts,tsx,js,mjs}` in precedence order,
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
   * In v1 only `"onStartupFinished"` is recognised. An empty `activationEvents`
   * array is treated the same as `["onStartupFinished"]` — every plugin with a
   * `main` entry activates at startup unless it explicitly lists other events
   * (none of which exist yet). When `onCommand:*`, `onView:*` etc. land, a
   * plugin will be able to opt out of startup activation by omitting
   * `"onStartupFinished"` from a non-empty list.
   */
  private shouldActivateOnStartup(manifest: PluginManifest): boolean {
    const events = manifest.activationEvents;
    if (!events || events.length === 0) return true;
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
    // Dev-mode plugins run inside a hot-reload worker instead of the in-process
    // import() loader (#9304).
    if (plugin.devMode) {
      return this.activateViaDevWorker(pluginId, plugin);
    }
    try {
      // Bound the dynamic import — a plugin with a hanging top-level await
      // would otherwise pin this promise forever and stall `Promise.allSettled`
      // fan-outs (file-decoration scope, startup activation).
      const mod = (await this.runImport(pluginId, plugin.resolvedMain)) as {
        activate?: unknown;
      };
      if (typeof mod.activate === "function") {
        const activate = mod.activate as PluginActivate;
        const { host, revoke } = this.createHost(pluginId);
        try {
          const cleanup = await this.runActivate(pluginId, activate, host);
          // Guard against an unload that ran concurrently with this activation:
          // by the time `runActivate` resolves, `unloadPlugin` may have already
          // cleared `cleanupMap` — writing a cleanup back after that fires
          // would leak (e.g. a setInterval the plugin set up in activate()
          // would never be cleared). Drop it on the floor instead.
          if (typeof cleanup === "function" && this.plugins.has(pluginId)) {
            this.cleanupMap.set(pluginId, cleanup);
          }
        } finally {
          revoke();
        }
      }
      // Successful activation (or a main with no activate fn) clears any
      // diagnostic record left over from a prior failed attempt — persisted
      // to the provenance record so it survives a host restart. Plugins with
      // a load-time error that is independent of `main` activation (e.g. a
      // manifest command id collision, #9281) are exempted: their diagnostic
      // is a manifest-level fact that doesn't go away when `main` activates.
      if (!plugin.isBuiltin && !this.pluginsWithLoadTimeErrors.has(pluginId)) {
        this.records.upsertInstalledRecord(pluginId, { loadError: null });
      }
    } catch (err) {
      const loadError = toPluginLoadError(err);
      if (!plugin.isBuiltin) {
        this.records.upsertInstalledRecord(pluginId, { loadError });
      }
      console.error(`[PluginService] Failed to load main entry for ${pluginId}:`, err);
      throw err;
    }
  }

  /**
   * Activate a dev-mode plugin inside a hot-reload worker (#9304). The plugin's
   * code runs in a `utilityProcess.fork` child; the real host (from
   * {@link createHost}) is bridged to the worker over MessagePort. The worker
   * watches `dist/index.js` and respawns on every rebuild, so module-scope state
   * never leaks across reloads (the robust fix for the Vite ESM cache leak).
   *
   * The host is left un-revoked for the worker's lifetime — unlike the
   * in-process path, the worker legitimately re-registers on every reload, and
   * the activation-window contract is enforced worker-side by its own proxy.
   *
   * A failed `activate()` is recorded but does NOT tear the worker down: the
   * worker keeps watching so the author can fix the error and save to reload.
   * Only a fork failure (no worker at all) rejects.
   */
  private async activateViaDevWorker(pluginId: string, plugin: LoadedPlugin): Promise<void> {
    if (!plugin.resolvedMain) return;
    // A re-activation while a worker is already live is a no-op — the worker
    // owns its own reload cycle; activatePlugin's idempotency normally prevents
    // this, but guard defensively against the unload-race re-entry path.
    if (this.devWorkers.has(pluginId)) return;

    const { host, revoke } = this.createHost(pluginId);
    const workerHost = new PluginDevWorkerHost({
      pluginId,
      pluginDir: plugin.dir,
      bundlePath: plugin.resolvedMain,
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
        if (plugin.isBuiltin) return;
        if (result.ok) {
          if (!this.pluginsWithLoadTimeErrors.has(pluginId)) {
            this.records.upsertInstalledRecord(pluginId, { loadError: null });
          }
        } else {
          this.records.upsertInstalledRecord(pluginId, {
            loadError: { message: result.error, at: Date.now() },
          });
        }
      },
    });

    const entry = { workerHost, bridge, revoke };
    this.devWorkers.set(pluginId, entry);

    // Register the teardown disposer up front so a concurrent unloadPlugin()
    // during fork/activation tears the worker down through the normal cascade.
    const cleanup = (): void => {
      bridge.dispose();
      workerHost.dispose();
      revoke();
      if (this.devWorkers.get(pluginId) === entry) {
        this.devWorkers.delete(pluginId);
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
      console.error(`[PluginService] Failed to start dev worker for ${pluginId}:`, err);
      throw err;
    }

    // If an unload raced the fork, the cleanup already disposed everything.
    if (!this.plugins.has(pluginId) || this.devWorkers.get(pluginId) !== entry) {
      cleanup();
      return;
    }

    // Bound the first activation so a plugin with a hanging `activate()` (or a
    // never-resolving top-level await in the worker) can't stall the
    // `Promise.allSettled` startup gate forever. On timeout the worker stays
    // alive and watching — `onActivationResult` will clear/record the error if
    // activation eventually settles or a reload follows. Mirrors the in-process
    // ACTIVATE_TIMEOUT_MS contract. The provenance `loadError` is owned by
    // `onActivationResult`; this catch only logs and unblocks startup.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        bridge.waitForActivation(),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Dev plugin "${pluginId}" activate() did not settle within ${ACTIVATE_TIMEOUT_MS}ms`
              )
            );
          }, ACTIVATE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      console.error(`[PluginService] Dev plugin "${pluginId}" activation:`, err);
    } finally {
      if (timer) clearTimeout(timer);
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
    if (this.activatedPlugins.has(pluginId)) return;
    const existing = this.activationPromises.get(pluginId);
    if (existing) return existing;
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    const promise = this._doActivate(pluginId).then(
      () => {
        // Guard against an unload that ran while activation was in flight:
        // unload clears `activatedPlugins` and `plugins` synchronously, but a
        // late-resolving activation would otherwise re-insert a tombstoned id.
        if (this.plugins.has(pluginId)) {
          this.activatedPlugins.add(pluginId);
        }
      },
      () => {
        // Error is already persisted to the provenance record inside
        // `_doActivate`. Drop the in-flight entry so a subsequent
        // `activatePlugin(pluginId)` re-runs activation (Settings → Retry).
        this.activationPromises.delete(pluginId);
      }
    );
    this.activationPromises.set(pluginId, promise);
    return promise;
  }

  /**
   * Fan out activation for every plugin whose manifest opts into
   * `"onStartupFinished"` (or whose `activationEvents` is unset / empty —
   * see {@link shouldActivateOnStartup}). Activations run in parallel via
   * `Promise.allSettled`; one slow plugin must not block the rest. Wired
   * fire-and-forget from the `plugin-service` deferred task so the renderer
   * keeps progressing while plugins warm up in the background.
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
    // Codepoint-aware cap: spreading splits at codepoint (not UTF-16 code-unit)
    // boundaries, so the slice can never bisect a surrogate pair.
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

  private createHost(pluginId: string): { host: PluginHostApi; revoke: () => void } {
    let revoked = false;
    // The LoadedPlugin this host is bound to. recordPluginLog compares against
    // the live instance so a stale host (post-unload, or after a same-id
    // reload) can't write into the current session's log buffer.
    const boundPlugin = this.plugins.get(pluginId);
    // Liveness for the non-revoke-guarded runtime methods: the plugin must still
    // be loaded AND be the same instance this host was bound to. Identity (not
    // just id membership) so a stale timer from a pre-reload instance can't emit
    // into the current same-id instance's panels or read its worktrees.
    const isBound = (): boolean =>
      boundPlugin !== undefined && this.plugins.get(pluginId) === boundPlugin;
    const host: PluginHostApi = {
      get pluginId() {
        return pluginId;
      },
      registerAction: (descriptor, handler) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: registerAction called after activate() returned or timed out`
          );
        }
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(`Plugin "${pluginId}" registerAction: descriptor must be an object`);
        }
        if (typeof handler !== "function") {
          throw new Error(`Plugin "${pluginId}" registerAction: handler must be a function`);
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" registerAction: descriptor.id must be a non-empty string`
          );
        }
        // The host adds the prefix, so a pre-prefixed id would silently produce
        // a doubled "{pluginId}.{pluginId}.{id}" that still passes validation.
        // Reject it up front to enforce the "id must NOT include the plugin
        // prefix" contract (see host-api.md) instead of registering a malformed
        // action id.
        if (descriptor.id.startsWith(`${pluginId}.`)) {
          throw new Error(
            `Plugin "${pluginId}" registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix — Daintree adds it`
          );
        }
        // The host receives an un-prefixed id ("plan-from-issue") and
        // namespaces it to "{pluginId}.{id}" — the inverse of the renderer IPC
        // path, which already sends the namespaced id. validateAndBuild* then
        // checks the prefixed id against the shared format/ownership rules.
        const namespacedId = `${pluginId}.${descriptor.id}`;
        const built = this.validateAndBuildActionDescriptor(pluginId, {
          ...descriptor,
          id: namespacedId,
        });

        // Replace semantics (per host-api.md): re-registering the same id
        // overwrites the prior descriptor + handler. Evict any stale compiled
        // input schema so the next dispatch recompiles against the new
        // descriptor. Handlers are cleaned up on unload via
        // unregisterPluginActions, matching the IPC-registered action path.
        this.pluginActions.set(namespacedId, built);
        this.pluginActionHandlers.set(namespacedId, handler);
        this.actionValidators.delete(namespacedId);

        let owners = this.pluginActionOwners.get(pluginId);
        if (!owners) {
          owners = new Set();
          this.pluginActionOwners.set(pluginId, owners);
        }
        owners.add(namespacedId);

        this.broadcaster.broadcastPluginActions();
        // All registry mutation above is synchronous (sync throws still surface
        // at the call site during activate()); only the return value is async.
        return Promise.resolve();
      },
      registerHandler: ((
        channel: string,
        schemaOrHandler:
          | PluginChannelSchema<unknown, unknown>
          | PluginIpcHandler
          | PluginTypedIpcHandler<unknown, unknown>,
        typedHandler?: PluginTypedIpcHandler<unknown, unknown>
      ) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: registerHandler called after activate() returned or timed out`
          );
        }
        if (typedHandler !== undefined) {
          // A three-argument call is the typed overload by definition; if the
          // second arg isn't a schema, reject loudly instead of silently
          // dropping the typed handler and registering the second arg as a
          // legacy handler — that mismatch would look like a phantom no-op
          // at first dispatch.
          if (!isChannelSchema(schemaOrHandler)) {
            throw new Error(
              `Plugin "${pluginId}" registerHandler: second argument must be a channel schema { args, result } when a typed handler is provided`
            );
          }
          this.registerHandler(pluginId, channel, schemaOrHandler, typedHandler);
        } else {
          this.registerHandler(pluginId, channel, schemaOrHandler as PluginIpcHandler);
        }
        return Promise.resolve();
      }) as PluginHostApi["registerHandler"],
      broadcastToRenderer: (channel, payload) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: broadcastToRenderer called after activate() returned or timed out`
          );
        }
        if (typeof channel !== "string" || channel.includes(":")) {
          throw new Error(
            `Plugin broadcast channel must be a string without colons: ${String(channel)}`
          );
        }
        broadcastToRenderer(`plugin:${pluginId}:${channel}`, payload);
        return Promise.resolve();
      },
      // The post-activation-safe sibling of broadcastToRenderer: same
      // `plugin:{pluginId}:{channel}` transport, but NOT revoke-guarded — it is
      // called from the plugin's own timers, polls, and subscription callbacks
      // long after activate() resolves, so a plugin can stream live data into
      // its panels without the renderer degrading to invoke() polling. Liveness
      // is plugin membership (mirrors invalidateFileDecorations/showToast): once
      // the plugin unloads this silently no-ops.
      postToPanel: (channel, payload) => {
        if (!isBound()) return Promise.resolve();
        if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
          throw new Error(
            `Plugin "${pluginId}" postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
          );
        }
        broadcastToRenderer(`plugin:${pluginId}:${channel}`, payload);
        return Promise.resolve();
      },
      getActiveWorktree: async () => {
        if (!isBound()) return null;
        const snapshots = await this.fetchAllWorktreeSnapshots();
        if (!isBound()) return null;
        const active = snapshots.find((s) => s.isCurrent === true);
        return active ? toPluginWorktreeSnapshot(active) : null;
      },
      getWorktrees: async () => {
        if (!isBound()) return [];
        const snapshots = await this.fetchAllWorktreeSnapshots();
        if (!isBound()) return [];
        return snapshots.map(toPluginWorktreeSnapshot);
      },
      getWorktreeStatus: async (path, options) => {
        options?.signal?.throwIfAborted();
        if (!isBound()) return null;
        if (typeof path !== "string" || path.length === 0) return null;
        const snapshots = await this.fetchAllWorktreeSnapshots();
        options?.signal?.throwIfAborted();
        if (!isBound()) return null;
        const match = snapshots.find((s) => s.path === path);
        return match ? toPluginWorktreeStatus(match.worktreeChanges) : null;
      },
      onDidChangeActiveWorktree: (callback) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: onDidChangeActiveWorktree called after activate() returned or timed out`
          );
        }
        // Subscription wired synchronously (revoke guard already held above);
        // only the disposer return value is wrapped in a resolved promise.
        const dispose = this.subscribeWorktreeEvent(pluginId, "worktree-activated", async () => {
          if (!this.plugins.has(pluginId)) return;
          try {
            const snapshots = await this.fetchAllWorktreeSnapshots();
            // Re-check after the async fetch so a racing unloadPlugin()
            // doesn't fire the callback into a disposed plugin closure.
            if (!this.plugins.has(pluginId)) return;
            const active = snapshots.find((s) => s.isCurrent === true);
            callback(active ? toPluginWorktreeSnapshot(active) : null);
          } catch (err) {
            console.error(
              `[PluginService] onDidChangeActiveWorktree callback for "${pluginId}" failed:`,
              err
            );
          }
        });
        return Promise.resolve(dispose);
      },
      onDidChangeWorktrees: (callback, options) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: onDidChangeWorktrees called after activate() returned or timed out`
          );
        }
        // Opt-in debounce: the host re-emits the worktree set on every git-status
        // poll, so a UI-updating plugin can coalesce bursts into a single
        // trailing callback. Values below the floor are clamped up; 0/omitted
        // fires on every change. See PluginHostSubscriptionOptions.
        const debounceMs =
          typeof options?.debounceMs === "number" && options.debounceMs > 0
            ? Math.max(options.debounceMs, MIN_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS)
            : 0;
        const runEmit = async (): Promise<void> => {
          if (!this.plugins.has(pluginId)) return;
          try {
            const snapshots = await this.fetchAllWorktreeSnapshots();
            if (!this.plugins.has(pluginId)) return;
            callback(snapshots.map(toPluginWorktreeSnapshot));
          } catch (err) {
            console.error(
              `[PluginService] onDidChangeWorktrees callback for "${pluginId}" failed:`,
              err
            );
          }
        };
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const emit =
          debounceMs > 0
            ? (): void => {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                  debounceTimer = null;
                  void runEmit();
                }, debounceMs);
              }
            : (): void => {
                void runEmit();
              };
        // Fires on both add/update and remove so plugins' cached lists stay
        // correct after deletions. Each subscription is tracked separately
        // so a single disposer stops both. A shared debounce timer coalesces
        // bursts that span both event kinds.
        const disposeUpdate = this.subscribeWorktreeEvent(pluginId, "worktree-update", emit);
        const disposeRemove = this.subscribeWorktreeEvent(pluginId, "worktree-removed", emit);
        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          disposeUpdate();
          disposeRemove();
        };
        return Promise.resolve(dispose);
      },
      registerForgeProvider: (descriptor, impl) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: registerForgeProvider called after activate() returned or timed out`
          );
        }
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${pluginId}" registerForgeProvider: descriptor must be an object`
          );
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" registerForgeProvider: descriptor.id must be a non-empty string`
          );
        }
        if (!impl || typeof impl !== "object") {
          throw new Error(`Plugin "${pluginId}" registerForgeProvider: impl must be an object`);
        }
        // The impl is keyed by the same `{pluginId}.{descriptor.id}` namespace
        // used by the eager descriptor table. Binding an impl whose id wasn't
        // declared in `contributes.forgeProviders` produces an orphaned entry —
        // unreachable through the routing table, since `listMatchingProviders`
        // walks descriptors first. Reject up front so the failure is loud.
        const contributionId = descriptor.id;
        const plugin = this.plugins.get(pluginId);
        const declared = plugin?.manifest.contributes.forgeProviders.some(
          (c) => c.id === contributionId
        );
        if (!declared) {
          throw new Error(
            `Plugin "${pluginId}" registerForgeProvider: descriptor.id "${contributionId}" is not declared in contributes.forgeProviders`
          );
        }

        registerForgeProviderImpl(pluginId, contributionId, impl);

        // Replay the persisted credential into the freshly bound impl so a
        // cold start, plugin reload, or dev-mode rescan reaches the provider
        // authenticated (#9983) — the store is the durable source of truth but
        // nothing pushed it back into the impl on bind. Synchronous (the
        // revoked guard above already holds), and wrapped in try/catch because
        // a plugin's `setCredentials` throwing must not abort activation.
        const replayId = makeForgeProviderId(pluginId, contributionId);
        const storedCredentials = buildStoredCredentials(replayId);
        if (storedCredentials) {
          try {
            impl.setCredentials?.(storedCredentials);
          } catch (err) {
            console.warn(
              `[PluginService] registerForgeProvider: setCredentials replay failed for "${replayId}":`,
              err
            );
          }
        }

        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          // Pass `impl` so a stale disposer (from a prior re-bind that was
          // overwritten via a second registerForgeProvider call on the same
          // id) cannot remove the currently-active impl by mistake — the
          // registry compares identities before deleting.
          unregisterForgeProviderImpl(pluginId, contributionId, impl);
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
        // Disposer captured and registered into the unload cascade
        // synchronously above; only the return value is async.
        return Promise.resolve(dispose);
      },
      registerFileDecorationProvider: (descriptor, impl) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: registerFileDecorationProvider called after activate() returned or timed out`
          );
        }
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: descriptor must be an object`
          );
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: descriptor.id must be a non-empty string`
          );
        }
        if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: impl must expose provideDecorations()`
          );
        }
        // Reject ids not declared in `contributes.fileDecorationProviders` for
        // the same reason as forge providers: an undeclared id is unreachable
        // through the eager scope-routing table, so the binding would be a
        // silent orphan. Fail loud at registration instead.
        const contributionId = descriptor.id;
        const plugin = this.plugins.get(pluginId);
        const declared = plugin?.manifest.contributes.fileDecorationProviders.some(
          (c) => c.id === contributionId
        );
        if (!declared) {
          throw new Error(
            `Plugin "${pluginId}" registerFileDecorationProvider: descriptor.id "${contributionId}" is not declared in contributes.fileDecorationProviders`
          );
        }

        registerFileDecorationProviderImpl(pluginId, contributionId, impl);

        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          unregisterFileDecorationProviderImpl(pluginId, contributionId, impl);
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
        return Promise.resolve(dispose);
      },
      // NOT revoke-guarded: called from the plugin's own post-activation
      // subscription callbacks (worktree changes, polling timers). The
      // liveness guard is plugin membership, not the activation window — once
      // the plugin unloads this becomes a silent no-op.
      invalidateFileDecorations: (scope, paths) => {
        if (!this.plugins.has(pluginId)) return Promise.resolve();
        if (typeof scope !== "string" || scope.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope must be a non-empty string`
          );
        }
        // A plugin may only invalidate scopes it actually declared in
        // `contributes.fileDecorationProviders`. Without this a plugin could
        // force unrelated renderer views to re-pull. Mirrors the
        // registration-time declared-id guard so the manifest stays the
        // single source of truth for what a plugin owns.
        const declaredScopes = this.plugins
          .get(pluginId)
          ?.manifest.contributes.fileDecorationProviders.flatMap((c) => c.scopes);
        if (
          !declaredScopes ||
          !declaredScopes.some((pattern) => scopeMatchesPattern(scope, pattern))
        ) {
          throw new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope "${scope}" is not covered by any declared contributes.fileDecorationProviders[].scopes`
          );
        }
        let narrowed =
          Array.isArray(paths) && paths.length > 0
            ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
            : undefined;
        if (narrowed && narrowed.length > MAX_FILE_DECORATION_PATHS) {
          // Over the cap, fall back to a scope-wide invalidation (drop `paths`)
          // rather than truncating: a truncated list would silently omit the
          // tail, and the renderer skips a re-pull for any visible file not in
          // the list — leaving stale decorations with no error surfaced. A
          // path-less broadcast forces an unconditional re-pull, which is
          // correct (just broader) for this pathological case.
          console.warn(
            `Plugin "${pluginId}" invalidateFileDecorations: ${narrowed.length} paths exceeds cap of ${MAX_FILE_DECORATION_PATHS} for scope "${scope}"; falling back to scope-wide invalidation`
          );
          narrowed = undefined;
        }
        broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
          name: "plugin:decorations-changed",
          payload: { scope, ...(narrowed && narrowed.length > 0 ? { paths: narrowed } : {}) },
        });
        return Promise.resolve();
      },
      // NOT revoke-guarded for the same reason as invalidateFileDecorations:
      // plugins fire toasts from post-activation callbacks and timers. Liveness
      // is plugin membership, so it no-ops silently once the plugin unloads.
      showToast: async (options) => {
        if (!this.plugins.has(pluginId)) return;
        const parsed = PluginToastOptionsSchema.safeParse(options);
        if (!parsed.success) {
          throw new Error(
            `Plugin "${pluginId}" showToast: invalid options — ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`
          );
        }
        // Provenance: prefix the message with the plugin id so users can see
        // which plugin raised the toast. pluginId is bound to the host closure
        // at activation and cannot be spoofed.
        //
        // rateLimitKey scopes the rate-limit bucket per plugin+type. Without it
        // plugin toasts fall into the global type-keyed bucket and a burst of
        // unrelated system toasts could silently suppress a plugin's toast.
        broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: parsed.data.type,
          message: `${pluginId}: ${parsed.data.message}`,
          duration: parsed.data.durationMs,
          rateLimitKey: `plugin:${pluginId}:${parsed.data.type}`,
        });
      },
      // NOT revoke-guarded for the same reason as invalidateFileDecorations and
      // showToast: plugins dispatch actions from post-activation callbacks and
      // timers. Liveness is plugin membership — once the plugin unloads this
      // returns PLUGIN_UNLOADED without attempting a round-trip. Args are
      // validated by ActionService against the action's argsSchema, and
      // danger:"restricted"/"confirm" are rejected there with the "plugin"
      // source, so the host does not re-check them.
      dispatch: async (actionId, args) => {
        if (!this.plugins.has(pluginId)) {
          return {
            ok: false,
            error: {
              code: "PLUGIN_UNLOADED",
              message: `Plugin "${pluginId}" is no longer loaded`,
            },
          };
        }
        return this.dispatcher.sendDispatchToRenderer(actionId, args);
      },
      // Imperative UI prompts (#10522). NOT revoke-guarded for the same reason
      // as showToast/dispatch: plugins prompt from command handlers that run
      // long after activate() resolves. Liveness is plugin membership — once the
      // plugin unloads these resolve the dismiss value (undefined / false)
      // without a renderer round-trip, and an in-flight prompt is drained by
      // promptDispatcher.cancelForPlugin in unloadPlugin. Invalid options throw
      // so authoring mistakes surface loudly (mirrors showToast).
      showQuickPick: (async (
        items: PluginQuickPickItem[],
        options?: PluginQuickPickOptions
      ): Promise<PluginQuickPickItem | PluginQuickPickItem[] | undefined> => {
        if (!this.plugins.has(pluginId)) return undefined;
        const validItems = validateQuickPickItems(pluginId, items);
        const value = await this.promptDispatcher.requestPrompt(pluginId, {
          kind: "quickPick",
          items: validItems,
          options: options ?? {},
        });
        return value as PluginQuickPickItem | PluginQuickPickItem[] | undefined;
      }) as PluginHostApi["showQuickPick"],
      showInputBox: async (options) => {
        if (!this.plugins.has(pluginId)) return undefined;
        const value = await this.promptDispatcher.requestPrompt(pluginId, {
          kind: "inputBox",
          options: options ?? {},
        });
        return value as string | undefined;
      },
      showConfirm: async (options) => {
        if (!this.plugins.has(pluginId)) return false;
        if (!options || typeof options !== "object" || typeof options.title !== "string") {
          throw new Error(`Plugin "${pluginId}" showConfirm: options.title must be a string`);
        }
        const value = await this.promptDispatcher.requestPrompt(pluginId, {
          kind: "confirm",
          options,
        });
        return value === true;
      },
      // NOT revoke-guarded for the same reason as showToast/dispatch: plugins
      // log from post-activation callbacks and timers. Liveness is plugin
      // membership (enforced inside recordPluginLog) — writes silently no-op
      // once the plugin unloads. Synchronous void return; never throws.
      logger: {
        info: (message, fields) => {
          if (boundPlugin) this.recordPluginLog(boundPlugin, pluginId, "info", message, fields);
        },
        warn: (message, fields) => {
          if (boundPlugin) this.recordPluginLog(boundPlugin, pluginId, "warn", message, fields);
        },
        error: (message, fields) => {
          if (boundPlugin) this.recordPluginLog(boundPlugin, pluginId, "error", message, fields);
        },
      },
      // Managed child-process surface (#9234). NOT revoke-guarded — a process
      // orchestrator spawns/respawns from post-activation timers and callbacks.
      // `spawn` is the first runtime enforcement of a scope capability: it
      // rejects unless the plugin declared `shell:exec` (mirrors the channel
      // capability gate at the dispatch boundary). Liveness is plugin membership
      // — once the plugin unloads `spawn` rejects and outstanding processes are
      // torn down by `killAll` in unloadPlugin.
      process: this.buildProcessApi(pluginId),
      // Host-mediated, scope-contained filesystem + git surfaces (fs-API
      // containment unit). NOT revoke-guarded — plugins read/write from
      // post-activation timers and callbacks. Every path argument is realpath-
      // contained to the declared scopes.fs.allowedPaths and capability-gated;
      // this is the runtime enforcement of allowedPaths (formerly advisory).
      fs: this.buildFsApi(pluginId),
      git: this.buildGitApi(pluginId),
      // NOT revoke-guarded: plugins read/write settings throughout their
      // lifetime (IPC handlers, timers), long after activate() resolves. The
      // store is the source of truth, so a late call is harmless.
      settings: {
        get: async <T = unknown>(
          key: string,
          scope: PluginSettingsScope = "user"
        ): Promise<T | undefined> => {
          assertSettingsKey(pluginId, "get", key);
          const filePath = this.settings.resolveSettingsFilePath(pluginId, scope);
          // Project scope with no active project: read resolves to undefined
          // rather than throwing, matching the "unset key" return.
          if (!filePath) return undefined;
          return this.settings
            .getOrCreateSettingsStore(pluginId, scope, filePath)
            .get<T>(key, { secret: this.settings.isSecretKey(pluginId, key) });
        },
        set: async <T = unknown>(
          key: string,
          value: T,
          scope: PluginSettingsScope = "user"
        ): Promise<void> => {
          assertSettingsKey(pluginId, "set", key);
          if (value === undefined) {
            throw new Error(
              `Plugin "${pluginId}" settings.set: value for "${key}" is undefined — settings cannot store undefined`
            );
          }
          this.settings.assertSettingSerializable(pluginId, key, value);
          this.settings.assertSettingDeclared(pluginId, key, scope);
          const filePath = this.settings.resolveSettingsFilePath(pluginId, scope);
          if (!filePath) {
            throw new Error(
              `Plugin "${pluginId}" settings.set: no active project — "project" scope has no target`
            );
          }
          const store = this.settings.getOrCreateSettingsStore(pluginId, scope, filePath);
          const changed = await store.set(key, value, {
            secret: this.settings.isSecretKey(pluginId, key),
          });
          if (changed) this.settings.notifySettingsSubscribers(pluginId, scope, key, value);
        },
        onDidChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
          scope: PluginSettingsScope = "user"
        ): Promise<() => void> => {
          if (revoked) {
            throw new Error(
              `Plugin "${pluginId}" host revoked: settings.onDidChange called after activate() returned or timed out`
            );
          }
          assertSettingsKey(pluginId, "onDidChange", key);
          if (typeof callback !== "function") {
            throw new Error(
              `Plugin "${pluginId}" settings.onDidChange: callback must be a function`
            );
          }
          this.settings.assertSettingScope(pluginId, key, scope);
          const sub = { key, scope, cb: callback as (value: unknown) => void };
          this.settings.addSubscriber(pluginId, sub);

          let disposed = false;
          const dispose = (): void => {
            if (disposed) return;
            disposed = true;
            this.settings.removeSubscriber(pluginId, sub);
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
          return Promise.resolve(dispose);
        },
      },
    };
    return {
      host,
      revoke: () => {
        revoked = true;
      },
    };
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
        streamSink: (pluginId, event) => {
          // Membership-gated like postToPanel: a late stream emit after the
          // plugin unloads is dropped rather than broadcast.
          if (!this.plugins.has(pluginId)) return;
          broadcastToRenderer(`plugin:${pluginId}:${PLUGIN_PROCESS_STREAM_CHANNEL}`, event);
        },
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
    this.plugins.set(plugin.manifest.name, plugin);
  }

  _unregisterFakePluginForTests(pluginId: string): void {
    this.plugins.delete(pluginId);
  }

  _createHostForTests(pluginId: string): PluginHostApi {
    return this.createHost(pluginId).host;
  }

  /**
   * Build the `host.process` surface for one plugin. `spawn` is gated on the
   * declared `shell:exec` capability — the first runtime enforcement of a scope
   * capability, mirroring how the typed-channel `requires` gate reads
   * `manifest.capabilities`. A plugin without it is rejected with a
   * `PERMISSION_REQUIRED:` prefix (the same prefix `useHostChannel` already
   * discriminates on).
   */
  private buildProcessApi(pluginId: string): PluginProcessApi {
    const spawn = async (
      command: string,
      options?: PluginProcessSpawnOptions
    ): Promise<PluginProcessHandle> => {
      if (!this.plugins.has(pluginId)) {
        throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
      }
      const declared = new Set<BuiltInPluginCapability>(
        this.plugins.get(pluginId)?.manifest.capabilities ?? []
      );
      if (!declared.has("shell:exec")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" process.spawn requires the "shell:exec" capability, which is not declared in manifest.capabilities`
        );
      }
      if (typeof command !== "string" || command.length === 0) {
        throw new Error(`Plugin "${pluginId}" process.spawn: command must be a non-empty string`);
      }
      const args = Array.isArray(options?.args)
        ? options.args.filter((a): a is string => typeof a === "string")
        : [];
      const env =
        options?.env && typeof options.env === "object"
          ? Object.fromEntries(Object.entries(options.env).filter(([, v]) => typeof v === "string"))
          : {};
      // Default cwd to the active worktree so a relative `command`/argv resolves
      // against the project the user is in, then fall back to the host cwd.
      let cwd =
        typeof options?.cwd === "string" && options.cwd.length > 0 ? options.cwd : undefined;
      if (cwd === undefined) {
        const active = await this.fetchAllWorktreeSnapshots();
        cwd = active.find((s) => s.isCurrent === true)?.path;
      }
      // Re-check membership after the async cwd resolution so a racing unload
      // doesn't spawn into a disposed plugin.
      if (!this.plugins.has(pluginId)) {
        throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
      }

      const handle = this.getProcessManager().spawn(pluginId, { command, args, cwd, env });
      return {
        get id() {
          return handle.id;
        },
        // Gate lifecycle control on membership so a stale handle retained by a
        // leaked timer can't kill or respawn a process after the plugin unloads
        // (killManagedProcesses already tore the live children down on unload).
        kill: () => {
          if (!this.plugins.has(pluginId)) return;
          handle.kill();
        },
        restart: () => {
          if (!this.plugins.has(pluginId)) return Promise.resolve();
          return handle.restart();
        },
        onExit: (cb) => handle.onExit(cb),
        onCrash: (cb) => handle.onCrash(cb),
      };
    };
    return { spawn };
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
   * Build the host-mediated `host.fs` surface for one plugin. Every path
   * argument is realpath-contained to the declared `scopes.fs.allowedPaths`
   * (traversal/symlink-escape rejected), and reads/writes are capability-gated
   * (`fs:*-read` / `fs:*-write`). This is the first runtime enforcement of
   * `scopes.fs.allowedPaths` — formerly advisory-only. Writes are audited.
   */
  private buildFsApi(pluginId: string): PluginFsApi {
    const requireLoaded = (op: string): void => {
      if (!this.plugins.has(pluginId)) {
        throw new Error(
          `PLUGIN_UNLOADED: plugin "${pluginId}" fs.${op}: plugin is no longer loaded`
        );
      }
    };
    const requireReadCap = (op: string): void => {
      const caps = this.declaredCapabilities(pluginId);
      if (!caps.has("fs:project-read") && !caps.has("fs:user-data-read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires "fs:project-read" or "fs:user-data-read", which is not declared in manifest.capabilities`
        );
      }
    };
    const requireWriteCap = (op: string): void => {
      const caps = this.declaredCapabilities(pluginId);
      if (!caps.has("fs:project-write") && !caps.has("fs:user-data-write")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires "fs:project-write" or "fs:user-data-write", which is not declared in manifest.capabilities`
        );
      }
    };
    const contain = (targetPath: string): Promise<string> =>
      resolveContainedPath(pluginId, targetPath, this.declaredAllowedPaths(pluginId));

    return {
      readFile: async (filePath, options) => {
        options?.signal?.throwIfAborted();
        requireLoaded("readFile");
        requireReadCap("readFile");
        const resolved = await contain(filePath);
        requireLoaded("readFile");
        // Deliberately no 500KB / binary cap — this is a sanctioned plugin API,
        // not the size-limited files.read preview path. The signal cancels the
        // read itself (Node honors it) as well as the boundary checks above.
        return fs.readFile(resolved, { encoding: "utf-8", signal: options?.signal });
      },
      writeFile: async (filePath, contents) => {
        requireLoaded("writeFile");
        requireWriteCap("writeFile");
        if (typeof contents !== "string") {
          throw new Error(`Plugin "${pluginId}" fs.writeFile: contents must be a string`);
        }
        const resolved = await contain(filePath);
        requireLoaded("writeFile");
        await fs.writeFile(resolved, contents, "utf-8");
        // Audit every write so host-mediated filesystem mutation is observable.
        safeAppendAudit({
          pluginId,
          actionId: `fs.writeFile:${resolved}`,
          recordType: "ipc-invoke",
          channel: "plugin:fs-write",
          result: "success",
          errorMessage: "",
          argsHash: safeArgsHash([{ path: resolved, bytes: Buffer.byteLength(contents) }]),
          durationMs: 0,
        });
      },
      readdir: async (dirPath, options) => {
        options?.signal?.throwIfAborted();
        requireLoaded("readdir");
        requireReadCap("readdir");
        const resolved = await contain(dirPath);
        options?.signal?.throwIfAborted();
        requireLoaded("readdir");
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        return entries.map(
          (e): PluginFsDirEntry => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
            isSymbolicLink: e.isSymbolicLink(),
          })
        );
      },
      stat: async (targetPath, options) => {
        options?.signal?.throwIfAborted();
        requireLoaded("stat");
        requireReadCap("stat");
        const resolved = await contain(targetPath);
        options?.signal?.throwIfAborted();
        requireLoaded("stat");
        const s = await fs.stat(resolved);
        return {
          isDirectory: s.isDirectory(),
          isFile: s.isFile(),
          isSymbolicLink: s.isSymbolicLink(),
          size: s.size,
          mtimeMs: s.mtimeMs,
        } satisfies PluginFsStat;
      },
      watch: async (paths, callback, options) => {
        options?.signal?.throwIfAborted();
        requireLoaded("watch");
        requireReadCap("watch");
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" fs.watch: callback must be a function`);
        }
        const targets = Array.isArray(paths) ? paths : [];
        if (targets.length === 0) {
          throw new Error(`Plugin "${pluginId}" fs.watch: paths must be a non-empty array`);
        }
        // Contain every path up front so an out-of-scope watch target rejects
        // before any watcher is created.
        const resolvedTargets = await Promise.all(targets.map((p) => contain(p)));
        options?.signal?.throwIfAborted();
        requireLoaded("watch");

        const watchers: FSWatcher[] = [];
        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          for (const w of watchers) {
            try {
              w.close();
            } catch {
              // best-effort
            }
          }
          this.pluginFsWatchers.get(pluginId)?.delete(dispose);
        };

        try {
          for (const resolved of resolvedTargets) {
            const watcher = fsWatch(resolved, { persistent: false }, (_event, filename) => {
              if (disposed || !this.plugins.has(pluginId)) return;
              const changed =
                typeof filename === "string" && filename.length > 0
                  ? path.join(resolved, filename)
                  : resolved;
              try {
                callback(changed);
              } catch (err) {
                console.error(`[PluginService] plugin "${pluginId}" fs.watch callback threw:`, err);
              }
            });
            watcher.on("error", (err) => {
              console.error(`[PluginService] plugin "${pluginId}" fs.watch error:`, err);
            });
            watchers.push(watcher);
          }
        } catch (err) {
          // A later path's fsWatch threw (e.g. ENOENT) after earlier watchers
          // were created — close them so a partial failure doesn't leak FDs
          // (dispose isn't registered in pluginFsWatchers yet, so teardown
          // wouldn't catch them).
          for (const w of watchers) {
            try {
              w.close();
            } catch {
              // best-effort
            }
          }
          throw err;
        }

        let set = this.pluginFsWatchers.get(pluginId);
        if (!set) {
          set = new Set();
          this.pluginFsWatchers.set(pluginId, set);
        }
        set.add(dispose);
        return dispose;
      },
    };
  }

  /**
   * Build the host-mediated `host.git` surface for one plugin. The
   * `worktreePath` is realpath-contained to the declared `scopes.fs.allowedPaths`
   * before any git work; reads gate on `git:read`, mutations on `git:write`.
   * `commit` enforces the host-side change-preview safeguard (#7880 / D2).
   * Implemented over the existing hardened simple-git layer via {@link PluginHostGit}.
   */
  private buildGitApi(pluginId: string): PluginGitApi {
    const requireLoaded = (op: string): void => {
      if (!this.plugins.has(pluginId)) {
        throw new Error(
          `PLUGIN_UNLOADED: plugin "${pluginId}" git.${op}: plugin is no longer loaded`
        );
      }
    };
    const requireReadCap = (op: string): void => {
      if (!this.declaredCapabilities(pluginId).has("git:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" git.${op} requires the "git:read" capability, which is not declared in manifest.capabilities`
        );
      }
    };
    const requireWriteCap = (op: string): void => {
      if (!this.declaredCapabilities(pluginId).has("git:write")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" git.${op} requires the "git:write" capability, which is not declared in manifest.capabilities`
        );
      }
    };
    // A worktree the plugin may access = one contained inside its declared
    // allowedPaths. We resolve the worktree root itself (not a child) so the git
    // ops run against the realpath-verified directory.
    const containWorktree = (worktreePath: string): Promise<string> =>
      resolveContainedPath(pluginId, worktreePath, this.declaredAllowedPaths(pluginId));
    const git = new PluginHostGit(pluginId, this.hostGitFactory);

    return {
      status: async (worktreePath, options): Promise<PluginGitStatus> => {
        options?.signal?.throwIfAborted();
        requireLoaded("status");
        requireReadCap("status");
        const resolved = await containWorktree(worktreePath);
        requireLoaded("status");
        return git.status(resolved, options?.signal);
      },
      diff: async (worktreePath, filePath, options): Promise<string> => {
        options?.signal?.throwIfAborted();
        requireLoaded("diff");
        requireReadCap("diff");
        const resolved = await containWorktree(worktreePath);
        requireLoaded("diff");
        return git.diff(resolved, filePath, options?.signal);
      },
      add: async (worktreePath, paths, options): Promise<void> => {
        options?.signal?.throwIfAborted();
        requireLoaded("add");
        requireWriteCap("add");
        const resolved = await containWorktree(worktreePath);
        requireLoaded("add");
        await git.add(resolved, paths, options?.signal);
        safeAppendAudit({
          pluginId,
          actionId: `git.add:${resolved}`,
          recordType: "ipc-invoke",
          channel: "plugin:git-add",
          result: "success",
          errorMessage: "",
          argsHash: safeArgsHash([{ worktreePath: resolved, paths: paths ?? ["."] }]),
          durationMs: 0,
        });
      },
      commit: async (
        worktreePath,
        options: PluginGitCommitOptions,
        callOptions
      ): Promise<PluginGitCommitResult> => {
        callOptions?.signal?.throwIfAborted();
        requireLoaded("commit");
        requireWriteCap("commit");
        // commit returns the staged diff as its change-preview, so it discloses
        // repo content — require read alongside write.
        requireReadCap("commit");
        const resolved = await containWorktree(worktreePath);
        requireLoaded("commit");
        // git.commit throws COMMIT_MESSAGE_REQUIRED before any mutation when the
        // message is empty — the #7880 no-silent-fallback guard at the host.
        const result = await git.commit(resolved, options, callOptions?.signal);
        safeAppendAudit({
          pluginId,
          actionId: `git.commit:${resolved}`,
          recordType: "ipc-invoke",
          channel: "plugin:git-commit",
          result: "success",
          errorMessage: "",
          argsHash: safeArgsHash([{ worktreePath: resolved, commit: result.commit }]),
          durationMs: 0,
        });
        return result;
      },
    };
  }

  private async fetchAllWorktreeSnapshots(): Promise<WorktreeSnapshot[]> {
    const client = this.workspaceClient;
    if (!client) return [];
    try {
      return await client.getAllStatesAsync();
    } catch (err) {
      console.error("[PluginService] Failed to fetch worktree snapshots:", err);
      return [];
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
    handler: () => void
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
    if (this.plugins.has(pluginId)) {
      this.unloadPlugin(pluginId);
    }
    const loaded = await this.loadPlugin(this.pluginsRoot, pluginId, {
      isBuiltin: false,
      disabled: new Set(),
    });
    if (!loaded) {
      throw new Error(
        `Couldn't load dev plugin "${pluginId}" from ${this.pluginsRoot} — check the symlink and that plugin.json is valid`
      );
    }
    await this.activatePlugin(pluginId);
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
    runUnloadStep(pluginId, "unregisterPluginAgents", () => unregisterPluginAgents(pluginId));
    runUnloadStep(pluginId, "scheduleAgentsBroadcast", () =>
      this.broadcaster.scheduleAgentsBroadcast(true)
    );
    // Subscriber disposers already fired in flushPluginEventCleanups() above;
    // this drops any leftover subscriber-set entry and the in-memory settings
    // store caches so a reload starts from disk.
    runUnloadStep(pluginId, "clearPluginSettingsState", () =>
      this.settings.clearPluginSettingsState(pluginId)
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

    this.plugins.delete(pluginId);

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
    // Desired state is the live persisted list; the running state is
    // `this.plugins` (loaded) vs `this.disabledPlugins` (skipped). For user
    // plugins these are fixed for the session, so a toggle diverges them and
    // raises a "restart required" cue (#9284). Built-ins transition live
    // (#9304): `setEnabled` moves the entry between the two maps immediately, so
    // the running state already matches the desired state and pendingRestart is
    // false. Reporting both keeps the switch position and the cue correct across
    // a tab remount.
    const desiredDisabled = this.records.getDisabledIds();
    const installed = this.records.getInstalledRecords();

    const toInfo = (
      p: { manifest: PluginManifest; dir: string; isBuiltin: boolean },
      loadedAt: number,
      isRunning: boolean
    ): LoadedPluginInfo => {
      const disabled = desiredDisabled.has(p.manifest.name);
      // pendingRestart: desired state diverges from running state.
      // Running + now-disabled → unload pending; skipped + now-enabled → load pending.
      const pendingRestart = isRunning ? disabled : !disabled;
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
        loadError: record?.loadError ?? null,
        disabled,
        updateAvailable: record?.updateAvailable ?? null,
        devMode: record?.devMode ?? false,
        pendingRestart,
        pluginDanger,
      };
    };

    // Plugins that loaded and are running this session.
    const running = Array.from(this.plugins.values()).map((p) => toInfo(p, p.loadedAt, true));

    // Plugins skipped at launch because they were disabled. They carry no
    // `loadedAt` — the main module never ran — so it's reported as 0.
    const skipped = Array.from(this.disabledPlugins.values()).map((p) => toInfo(p, 0, false));

    return [...running, ...skipped];
  }

  /**
   * Resolve a plugin id to its installed-on-disk root directory. Returns
   * `undefined` when the plugin is unknown or was skipped at load (disabled in
   * Preferences). Used by the `plugin://` protocol handler to map URL hosts to
   * filesystem roots without exposing the private `plugins` map.
   */
  getPluginDir(pluginId: string): string | undefined {
    return this.plugins.get(pluginId)?.dir;
  }

  /**
   * Toggle a plugin's disabled state in Preferences (#9284). Persists to
   * `plugins.disabled` in electron-store, then — for built-in plugins only —
   * applies the change live (#9304): disabling unloads the running plugin,
   * enabling re-registers and re-activates it, so the toggle takes effect
   * without an app restart. User plugins stay persist-only and surface the
   * restart-required cue, because their on-disk code can change between toggles
   * and Node's ESM module cache has no eviction API (the dev-worker fork path
   * exists precisely to sidestep that for recompiling dev plugins) — re-running
   * a built-in's bundled, immutable `activate()` carries no such risk.
   *
   * Persists first so a crash mid-transition is recoverable: next launch reads
   * the persisted intent and reaches the same state. Idempotent: toggling to
   * the current state is a no-op write and a no-op transition. Permissive by
   * design — the store is a declared-intent list, so no existence check.
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    // Persist intent first (throws on an empty id, validated in the store).
    this.records.setEnabled(pluginId, enabled);

    const isBuiltin =
      this.plugins.get(pluginId)?.isBuiltin ??
      this.disabledPlugins.get(pluginId)?.isBuiltin ??
      false;
    if (!isBuiltin) return;

    // Serialise live transitions per id so concurrent toggles can't interleave
    // their unload/load map mutations. Swallow the prior chain's rejection —
    // `_applyBuiltinToggle` never rejects, but the guard keeps the chain alive.
    const prior = this.enableTransitions.get(pluginId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this._applyBuiltinToggle(pluginId, enabled));
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
   * Apply a live enable/disable transition for a built-in plugin (#9304).
   * Disable: tear the running plugin down through the full `unloadPlugin()`
   * cascade, then move its manifest into `disabledPlugins` so `listPlugins()`
   * keeps surfacing it for the toggle. Enable: clear the name reservation and
   * skipped entry (so `loadPlugin`'s duplicate guard doesn't reject the
   * re-load), re-register from the cached manifest dir, then activate. Always
   * broadcasts provenance so every view re-pulls `listPlugins()` and the
   * restart-required cue clears. Never throws — activation errors are persisted
   * to `loadError` inside `activatePlugin`, and a failed re-register restores
   * the skipped state.
   */
  private async _applyBuiltinToggle(pluginId: string, enabled: boolean): Promise<void> {
    try {
      if (!enabled) {
        const running = this.plugins.get(pluginId);
        if (!running) return; // already not running — nothing to unload
        const { manifest, dir } = running;
        this.unloadPlugin(pluginId);
        this.disabledPlugins.set(pluginId, { manifest, dir, isBuiltin: true });
        this.reservedNames.add(pluginId);
        return;
      }

      const entry = this.disabledPlugins.get(pluginId);
      if (!entry) return; // already running — nothing to load
      // Release ONLY the name reservation up front (the duplicate guard's actual
      // gate), but keep the disabledPlugins entry in place across the async load.
      // This keeps the id resolvable as a built-in at every await point, so a
      // concurrent setEnabled can't slip past the isBuiltin check into the
      // persist-only path while the load is mid-flight. loadPlugin() with an
      // empty disabled set never touches disabledPlugins, so the entry is safe.
      this.reservedNames.delete(pluginId);
      let loaded: LoadedPlugin | null = null;
      try {
        loaded = await this.loadPlugin(path.dirname(entry.dir), path.basename(entry.dir), {
          isBuiltin: true,
          disabled: new Set<string>(),
        });
      } catch (err) {
        // A throw (e.g. a malformed `when` expression in the manifest) must not
        // strand the plugin in neither map — fall through to the restore path.
        console.error(`[PluginService] Re-load of built-in "${pluginId}" threw:`, err);
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
    const { id, title, description, category, kind, danger } = contribution;
    if (typeof id !== "string" || !PLUGIN_ACTION_ID_RE.test(id)) {
      throw new Error(
        `Plugin action id "${id}" is invalid. Expected "{pluginId}.{actionId}" (lowercase start, alphanumerics, dot/dash/underscore).`
      );
    }
    if (!id.startsWith(`${pluginId}.`)) {
      throw new Error(
        `Plugin "${pluginId}" cannot register action "${id}": id must be prefixed with the plugin's own id.`
      );
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
    const hasHighRiskCapability = manifestCapabilities.some((p) =>
      CONFIRM_TRIGGERING_CAPABILITIES.has(p)
    );
    const hasCompoundElevation = manifestTriggersCompoundElevation(manifest, manifestCapabilities);
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
    };
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
    return this.settings.setSettingValueFromUi(pluginId, key, value, scope, projectId);
  }

  async deleteSettingValueFromUi(
    pluginId: string,
    key: string,
    scope: PluginSettingsScope,
    projectId: string | null
  ): Promise<void> {
    return this.settings.deleteSettingValueFromUi(pluginId, key, scope, projectId);
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
   */
  pushSnapshotTo(webContents: Electron.WebContents): Promise<void> {
    return this.broadcaster.pushSnapshotTo(webContents);
  }
}

// E2E backdoor: the host-contract harness (#9286) sideloads the compiled
// sample plugin from `dist-electron/plugins/sample` via a dedicated scan that
// loads with `isBuiltin: true`, which is the only way a plugin claiming the
// reserved `daintree.*` namespace can pass the manifest schema. The
// constant-folded define in `scripts/build-main.mjs` rewrites this read to
// `""` in production builds, so no shipped binary ever sideloads anything.
const e2eSideloadDir = process.env.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR || undefined;
export const pluginService = new PluginService(undefined, undefined, {
  sideloadPluginsRoot: e2eSideloadDir,
});
