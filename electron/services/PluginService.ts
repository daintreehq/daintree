// eager-import-allow: reads plugin settings via store.get synchronously during service init
import fs from "fs/promises";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { app, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
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

// proper-lockfile is CJS-only and ships no bundled types. Require it via the
// same createRequire interop as ajv and declare the narrow surface we use.
interface LockOptions {
  stale?: number;
  update?: number;
  realpath?: boolean;
  retries?: number | { retries: number; minTimeout?: number; maxTimeout?: number };
  onCompromised?: (err: Error) => void;
}
interface ProperLockfile {
  lock(file: string, opts?: LockOptions): Promise<() => Promise<void>>;
}
const properLockfile: ProperLockfile = req("proper-lockfile");
import { getPluginManifestSchema, PluginToastOptionsSchema } from "../schemas/plugin.js";
import { extractPluginArchive, computeArchiveHash } from "./PluginArchive.js";
import { resilientRename } from "../utils/fs.js";
import { getPluginMcpSupervisor } from "./PluginMcpSupervisor.js";
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
  BuiltInPluginCapability,
  InstalledPluginRecord,
  PluginLoadError,
  PluginInstallSource,
  PluginInstallError,
  PluginInstallErrorCode,
  PluginInstallResult,
  PluginInstallOptions,
  PluginSettingsScope,
  ViewContribution,
} from "../../shared/types/plugin.js";
import { PluginSettingsStore } from "./PluginSettingsStore.js";
import { projectStore } from "./ProjectStore.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { toPluginWorktreeSnapshot } from "../../shared/utils/pluginWorktreeSnapshot.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
  onPanelKindRegistered,
  onPanelKindUnregistered,
  getPluginPanelKinds,
} from "../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
  getAllPluginToolbarButtonConfigs,
} from "../../shared/config/toolbarButtonRegistry.js";
import {
  registerPluginMenuItem,
  unregisterPluginMenuItems,
  getPluginMenuItems,
} from "./pluginMenuRegistry.js";
import {
  registerPluginKeybinding,
  unregisterPluginKeybindings,
  getPluginKeybindings,
} from "./pluginKeybindingRegistry.js";
import {
  registerPluginContextMenuItem,
  unregisterPluginContextMenuItems,
  getPluginContextMenuItems,
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
import {
  registerFileDecorationProviderImpl,
  registerFileDecorationProviders,
  scopeMatchesPattern,
  unregisterFileDecorationProviderImpl,
  unregisterFileDecorationProviderImpls,
  unregisterFileDecorationProviders,
} from "./fileDecorationRegistry.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { CHANNELS } from "../ipc/channels.js";
import { getWindowRegistry, getProjectViewManager } from "../window/windowRef.js";
import type { ActionDispatchResult } from "../../shared/types/actions.js";
import type { LoadedPluginInfo } from "../../shared/types/plugin.js";
import type { PluginToolbarButtonId } from "../../shared/types/toolbar.js";
import { store } from "../store.js";
import { BUILT_IN_ACTION_IDS } from "../../shared/config/actionIds.js";

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
 * Capabilities whose presence in a plugin's manifest forces every action that
 * plugin contributes up to `effectiveDanger: "confirm"`, regardless of the
 * `danger` the plugin self-declared. These are the capabilities that grant
 * irreversible or hard-to-undo side effects: arbitrary process execution,
 * git history mutation, project/user-config filesystem writes, and agent
 * invocation. Read-only or trivially-reversible capabilities (`*-read`,
 * `network:fetch`, `clipboard:*`) are intentionally excluded — promoting on
 * those would over-confirm and train users to dismiss the dialog. The host
 * may only raise danger; a plugin declaring `"confirm"` always stays
 * `"confirm"` even with none of these.
 */
const CONFIRM_TRIGGERING_CAPABILITIES: ReadonlySet<BuiltInPluginCapability> = new Set([
  "shell:exec",
  "git:write",
  "fs:project-write",
  "fs:user-data-write",
  "agent:invoke",
]);

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

interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  resolvedMain?: string;
  loadedAt: number;
  isBuiltin: boolean;
  /** SHA-256 hex digest of the `.dntr` archive, set by the installer at install time. */
  archiveHash?: string;
}

const ACTIVATE_TIMEOUT_MS = 5000;
/**
 * Time budget for a `host.dispatch()` main→renderer round-trip. Matches the MCP
 * dispatch timeout (`MCP_DISPATCH_TIMEOUT_MS`); without it a destroyed or
 * unresponsive renderer would leak entries in `pendingPluginDispatches` forever.
 * On timeout the pending request resolves with an `EXECUTION_ERROR` result.
 */
const PLUGIN_DISPATCH_TIMEOUT_MS = 30_000;

/**
 * A `host.dispatch()` request awaiting its renderer response. Unlike the MCP
 * bridge's `PendingRequest`, the promise always resolves with an
 * {@link ActionDispatchResult} (never rejects) — `host.dispatch` returns the
 * `{ ok: false }` envelope on failure rather than throwing.
 */
interface PendingPluginDispatch {
  resolve: (result: ActionDispatchResult) => void;
  timer: ReturnType<typeof setTimeout>;
  webContentsId: number;
  destroyedCleanup?: () => void;
}
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
function runUnloadStep(pluginId: string, step: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[PluginService] Unload step "${step}" for "${pluginId}" threw:`, err);
  }
}

function assertSettingsKey(pluginId: string, method: string, key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(`Plugin "${pluginId}" settings.${method}: key must be a non-empty string`);
  }
}

/**
 * Discriminate between the typed `registerHandler(channel, schema, handler)`
 * overload and the legacy `registerHandler(channel, handler)` overload. A
 * typed schema must expose `args` and `result` Zod-compatible types — we
 * probe for a `safeParse` method on both rather than trusting structural
 * shape alone, so a JS plugin author bypassing TypeScript can't slip a
 * malformed `{ args: {}, result: ... }` past registration only to crash at
 * dispatch with a raw `safeParse is not a function` TypeError outside the
 * documented `SCHEMA_ERROR:` envelope.
 */
function isChannelSchema(value: unknown): value is PluginChannelSchema<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (!("args" in value) || !("result" in value)) return false;
  const args = (value as { args: unknown }).args;
  const result = (value as { result: unknown }).result;
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as { safeParse?: unknown }).safeParse === "function" &&
    typeof result === "object" &&
    result !== null &&
    typeof (result as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Validate a manifest-declared `experimental_views[].componentPath` before we
 * resolve it to a `plugin://` URL (#9229). The protocol handler at
 * `electron/setup/protocols.ts` rejects traversal at request time, but
 * pre-validating here surfaces a noisy authoring mistake (`/abs/path` or
 * `../escape`) as a `[PluginService]` warn during load, instead of a silent
 * 404 from `import('plugin://...')` later. Accepts relative POSIX paths only —
 * a leading `./` is preserved (the URL builder normalizes it).
 */
function isSafePluginViewComponentPath(componentPath: string): boolean {
  if (typeof componentPath !== "string" || componentPath.length === 0) return false;
  if (componentPath.startsWith("/")) return false;
  if (componentPath.includes("\\")) return false;
  if (componentPath.includes("\0")) return false;
  // Reject embedded URL structure markers — `https://...` (`:`), `?query`, or
  // `#fragment`. The `plugin://` protocol handler defends against traversal at
  // request time via realpath containment, so these are authoring-mistake
  // guards (catch typos early, don't pollute the V8 module cache with
  // duplicate query-string variants), not the security boundary.
  if (componentPath.includes(":")) return false;
  if (componentPath.includes("?")) return false;
  if (componentPath.includes("#")) return false;
  const segments = componentPath.split("/");
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  return true;
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

type WorkspaceWorktreeEvent = "worktree-update" | "worktree-activated" | "worktree-removed";

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  private handlerMap = new Map<string, PluginIpcHandler>();
  /**
   * Per-channel Zod schemas for typed `registerHandler` registrations, keyed
   * by the same `pluginId:channel` key as {@link handlerMap}. Only populated
   * for the typed overload — legacy untyped registrations omit the entry and
   * skip schema validation at dispatch. Cleared per-plugin in
   * {@link removeHandlers} alongside the handler entry.
   */
  private channelSchemas = new Map<string, PluginChannelSchema<unknown, unknown>>();
  /**
   * Per-channel capability gate for typed `registerHandler` registrations,
   * keyed by the same `pluginId:channel` key as {@link handlerMap}.
   * Authoritative check runs at registration (throws `PERMISSION_REQUIRED:`
   * for missing capabilities); the dispatch-time re-check is defense-in-depth
   * for future code paths that mutate manifests after load.
   */
  private channelRequires = new Map<string, readonly BuiltInPluginCapability[]>();
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
  /**
   * Persisted-settings stores keyed by `{pluginId}\u0000{scope}\u0000{filePath}`.
   * The NUL (`\u0000`) separator is unambiguous because a valid plugin id can
   * never contain it (see the manifest name pattern). Keyed on the resolved path
   * (not just scope) so a project switch — which changes the `project`-scope
   * path — creates a fresh store without evicting the old project's cache.
   * Entries for a plugin are dropped on unload.
   */
  private settingsStores = new Map<string, PluginSettingsStore>();
  /**
   * Active `host.settings.onDidChange` subscriptions per plugin. Held here (not
   * on the store) so they survive project-root switches and are flushed in one
   * place on unload. Each disposer is also tracked in {@link pluginEventCleanups}.
   */
  private settingsSubscribers = new Map<
    string,
    Set<{ key: string; scope: PluginSettingsScope; cb: (value: unknown) => void }>
  >();
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
   * Coalesces multiple registry events fired in the same tick (e.g., when a
   * plugin contributes several panel kinds, or when `unregisterPluginPanelKinds`
   * removes N kinds in one call) into a single broadcast carrying the current
   * snapshot.
   */
  private panelKindsBroadcastPending = false;
  /**
   * Same coalescing rationale as {@link panelKindsBroadcastPending}: a plugin
   * contributing N toolbar buttons calls `registerToolbarButton` N times in
   * `loadPlugin()`, and `unregisterPluginToolbarButtons` removes them in one
   * call on unload — batch into a single snapshot broadcast per tick.
   */
  private toolbarButtonsBroadcastPending = false;
  /**
   * OR-accumulated across triggers coalesced into one tick: true if any was an
   * unload (uninstall). The registry at microtask-drain time always reflects
   * the current set, so a tick that included an unload is an authoritative
   * snapshot the renderer may safely sweep against; a tick of only loads is a
   * partial/growing snapshot (concurrent load + deferred init) and must not.
   */
  private toolbarButtonsBroadcastComplete = false;
  /**
   * Same coalescing rationale as {@link toolbarButtonsBroadcastPending}. Menu
   * items are mutated only from `loadPlugin()` / `unloadPlugin()`, so the two
   * call sites invoke {@link scheduleMenuItemsBroadcast} directly.
   */
  private menuItemsBroadcastPending = false;
  /** Mirrors {@link toolbarButtonsBroadcastComplete} for menu items. */
  private menuItemsBroadcastComplete = false;
  private keybindingsBroadcastPending = false;
  private keybindingsBroadcastComplete = false;
  /**
   * Same coalescing rationale as {@link menuItemsBroadcastPending}. Context-menu
   * items are mutated only from `loadPlugin()` / `unloadPlugin()`, so the two
   * call sites invoke {@link scheduleContextMenuItemsBroadcast} directly.
   */
  private contextMenuItemsBroadcastPending = false;
  /** Mirrors {@link menuItemsBroadcastComplete} for context-menu items. */
  private contextMenuItemsBroadcastComplete = false;
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
   * In-flight `host.dispatch()` round-trips keyed by `requestId`. Each entry is
   * resolved by the {@link CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE} listener,
   * the timeout, the renderer's `destroyed` event, or {@link dispose}.
   */
  private pendingPluginDispatches = new Map<string, PendingPluginDispatch>();
  /**
   * Removes the lazily-registered `ipcMain` response listener for plugin
   * dispatch. `null` until the first `host.dispatch()` registers it; cleared in
   * {@link dispose}.
   */
  private pluginDispatchListenerCleanup: (() => void) | null = null;

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

    const offRegister = onPanelKindRegistered(() => this.schedulePanelKindsBroadcast());
    const offUnregister = onPanelKindUnregistered(() => this.schedulePanelKindsBroadcast());
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
   * Stop forwarding shared registry events to the renderer. Intended for
   * tests that need a clean teardown — production code holds a single
   * `pluginService` singleton for the app lifetime. Also drops any pending
   * batched broadcast so a microtask scheduled before disposal doesn't leak
   * an emit into the next test.
   */
  dispose(): void {
    this.disposed = true;
    this.disposeRegistrySubscriptions();
    this.pluginDispatchListenerCleanup?.();
    this.pluginDispatchListenerCleanup = null;
    // Settle the init gate so unit tests that tear down the service without
    // running activateStartupFinishedPlugins() don't hang IPC callers awaiting
    // waitForInit().
    this.resolveInit?.();
    this.resolveInit = null;
    for (const pending of this.pendingPluginDispatches.values()) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.resolve({
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: "PluginService disposed before plugin action dispatch resolved",
        },
      });
    }
    this.pendingPluginDispatches.clear();
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

  /**
   * Read disabled plugin ids (built-in and user) from the user store.
   * Defensive against missing keys (in-memory fallback during tests) and read
   * failures — a failed read returns an empty set so all plugins activate,
   * matching the safest startup behavior.
   */
  private getDisabledIds(): Set<string> {
    try {
      const value = store.get("plugins") as { disabled?: unknown } | undefined;
      const list = Array.isArray(value?.disabled) ? value.disabled : [];
      return new Set(list.filter((id): id is string => typeof id === "string"));
    } catch (err) {
      console.warn("[PluginService] Failed to read disabled plugins from store:", err);
      return new Set();
    }
  }

  private getInstalledRecords(): Record<string, InstalledPluginRecord> {
    try {
      const plugins = store.get("plugins") as { installed?: unknown } | undefined;
      const raw = plugins?.installed;
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        return raw as Record<string, InstalledPluginRecord>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private getInstalledRecord(name: string): InstalledPluginRecord | undefined {
    return this.getInstalledRecords()[name];
  }

  private writeInstalledRecords(records: Record<string, InstalledPluginRecord>): void {
    try {
      const current = store.get("plugins");
      store.set("plugins", { ...current, installed: records });
    } catch (err) {
      console.warn("[PluginService] Failed to write installed plugin records:", err);
    }
  }

  private upsertInstalledRecord(
    name: string,
    patch: Partial<InstalledPluginRecord>
  ): InstalledPluginRecord {
    const records = this.getInstalledRecords();
    const existing = records[name];
    const updated: InstalledPluginRecord = existing
      ? { ...existing, ...patch }
      : {
          source: "sideload" as PluginInstallSource,
          installedAt: Date.now(),
          archiveHash: null,
          originalUrl: null,
          disabled: false,
          updateAvailable: null,
          devMode: false,
          loadError: null,
          ...patch,
        };
    records[name] = updated;
    this.writeInstalledRecords(records);
    return updated;
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
    // `.old-*` parked dirs left by the installer (e.g. after a crash mid-swap)
    // are never mistaken for installable plugins.
    const pluginDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
    // Disabled state applies to built-in and user plugins alike (#9284).
    const disabled = this.getDisabledIds();
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
          this.upsertInstalledRecord(String(inferredName ?? dirName), {
            loadError: { message: namespaceIssue.message, at: Date.now() },
          });
        }
      }
      console.error(`[PluginService] Invalid manifest in ${dirName}:`, parseResult.error.issues);
      return null;
    }

    const manifest = parseResult.data;

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
      const existing = this.getInstalledRecord(manifest.name);
      if (!existing) {
        this.upsertInstalledRecord(manifest.name, {});
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

    // Index views by bare id so the panels loop can attach `componentPath` in
    // a single registerPanelKind pass (#9229). View ids are pre-namespace; the
    // runtime panel id is `${manifest.name}.${panel.id}`.
    const viewsByBareId = new Map<string, ViewContribution>();
    const unmatchedViewIds = new Set<string>();
    for (const view of manifest.contributes.experimental_views) {
      if (view.location === "sidebar") {
        console.warn(
          `[PluginService] Plugin "${manifest.name}": experimental_views entry "${view.id}" has location "sidebar" which is not yet implemented and will be ignored`
        );
        continue;
      }
      if (!isSafePluginViewComponentPath(view.componentPath)) {
        console.warn(
          `[PluginService] Plugin "${manifest.name}": experimental_views entry "${view.id}" has an unsafe componentPath ${JSON.stringify(view.componentPath)} and will be ignored`
        );
        continue;
      }
      if (viewsByBareId.has(view.id)) {
        // Two entries with the same bare id — last would silently overwrite
        // earlier. Surface the authoring mistake; keep the first to make the
        // outcome deterministic.
        console.warn(
          `[PluginService] Plugin "${manifest.name}": experimental_views has duplicate entries for id "${view.id}"; keeping the first occurrence`
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
          `[PluginService] Plugin "${manifest.name}": experimental_views entry "${view.id}" matches a panel with hasPty=true; the view will be ignored because PTY panels are rendered by TerminalPane`
        );
      }
    }

    for (const orphanId of unmatchedViewIds) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}": experimental_views entry "${orphanId}" has no matching contributes.panels entry and will be ignored`
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
      this.scheduleToolbarButtonsBroadcast(false);
    }

    for (const menuItem of manifest.contributes.menuItems) {
      trackPluginExpression(manifest.name, menuItem.when);
      registerPluginMenuItem(manifest.name, menuItem);
    }
    if (manifest.contributes.menuItems.length > 0) {
      this.scheduleMenuItemsBroadcast(false);
    }

    for (const keybinding of manifest.contributes.keybindings) {
      trackPluginExpression(manifest.name, keybinding.when);
      registerPluginKeybinding(manifest.name, keybinding);
    }
    if (manifest.contributes.keybindings.length > 0) {
      this.scheduleKeybindingsBroadcast(false);
    }

    for (const ctxMenu of manifest.contributes.contextMenus) {
      trackPluginExpression(manifest.name, ctxMenu.when);
      registerPluginContextMenuItem(manifest.name, ctxMenu);
    }
    if (manifest.contributes.contextMenus.length > 0) {
      this.scheduleContextMenuItemsBroadcast(false);
    }

    // Lazy MCP discovery (#9235): plugin activation no longer eagerly spawns
    // contributed MCP servers. The subprocess starts on the first tool
    // enumeration (`plugin-mcp:list-tools`), which resolves the contribution
    // and calls the (idempotent) supervisor `start()` at the IPC boundary. This
    // keeps idle plugins from holding live subprocesses they never use.

    if (manifest.contributes.forgeProviders.length > 0) {
      registerForgeProviders(manifest.name, manifest.contributes.forgeProviders);
    }

    if (manifest.contributes.fileDecorationProviders.length > 0) {
      registerFileDecorationProviders(manifest.name, manifest.contributes.fileDecorationProviders);
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
      this.upsertInstalledRecord(manifest.name, { loadError: null });
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
          this.upsertInstalledRecord(pluginId, {
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
          this.upsertInstalledRecord(pluginId, { loadError });
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
      this.broadcastPluginActions();
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
        this.upsertInstalledRecord(pluginId, { loadError: null });
      }
    } catch (err) {
      const loadError = toPluginLoadError(err);
      if (!plugin.isBuiltin) {
        this.upsertInstalledRecord(pluginId, { loadError });
      }
      console.error(`[PluginService] Failed to load main entry for ${pluginId}:`, err);
      throw err;
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

  private createHost(pluginId: string): { host: PluginHostApi; revoke: () => void } {
    let revoked = false;
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

        this.broadcastPluginActions();
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
      },
      getActiveWorktree: async () => {
        const snapshots = await this.fetchAllWorktreeSnapshots();
        const active = snapshots.find((s) => s.isCurrent === true);
        return active ? toPluginWorktreeSnapshot(active) : null;
      },
      getWorktrees: async () => {
        const snapshots = await this.fetchAllWorktreeSnapshots();
        return snapshots.map(toPluginWorktreeSnapshot);
      },
      onDidChangeActiveWorktree: (callback) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: onDidChangeActiveWorktree called after activate() returned or timed out`
          );
        }
        return this.subscribeWorktreeEvent(pluginId, "worktree-activated", async () => {
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
      },
      onDidChangeWorktrees: (callback) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: onDidChangeWorktrees called after activate() returned or timed out`
          );
        }
        const emit = async (): Promise<void> => {
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
        // Fires on both add/update and remove so plugins' cached lists stay
        // correct after deletions. Each subscription is tracked separately
        // so a single disposer stops both.
        const disposeUpdate = this.subscribeWorktreeEvent(pluginId, "worktree-update", emit);
        const disposeRemove = this.subscribeWorktreeEvent(pluginId, "worktree-removed", emit);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          disposeUpdate();
          disposeRemove();
        };
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
        return dispose;
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
        return dispose;
      },
      // NOT revoke-guarded: called from the plugin's own post-activation
      // subscription callbacks (worktree changes, polling timers). The
      // liveness guard is plugin membership, not the activation window — once
      // the plugin unloads this becomes a silent no-op.
      invalidateFileDecorations: (scope, paths) => {
        if (!this.plugins.has(pluginId)) return;
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
        const narrowed =
          Array.isArray(paths) && paths.length > 0
            ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
            : undefined;
        broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
          name: "plugin:decorations-changed",
          payload: { scope, ...(narrowed && narrowed.length > 0 ? { paths: narrowed } : {}) },
        });
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
        return this.sendDispatchToRenderer(actionId, args);
      },
      // NOT revoke-guarded: plugins read/write settings throughout their
      // lifetime (IPC handlers, timers), long after activate() resolves. The
      // store is the source of truth, so a late call is harmless.
      settings: {
        get: async <T = unknown>(
          key: string,
          scope: PluginSettingsScope = "user"
        ): Promise<T | undefined> => {
          assertSettingsKey(pluginId, "get", key);
          const filePath = this.resolveSettingsFilePath(pluginId, scope);
          // Project scope with no active project: read resolves to undefined
          // rather than throwing, matching the "unset key" return.
          if (!filePath) return undefined;
          return this.getOrCreateSettingsStore(pluginId, scope, filePath).get<T>(key);
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
          let serialized: string | undefined;
          try {
            serialized = JSON.stringify(value);
          } catch {
            serialized = undefined;
          }
          if (serialized === undefined) {
            throw new Error(
              `Plugin "${pluginId}" settings.set: value for "${key}" is not JSON-serializable`
            );
          }
          this.assertSettingDeclared(pluginId, key);
          const filePath = this.resolveSettingsFilePath(pluginId, scope);
          if (!filePath) {
            throw new Error(
              `Plugin "${pluginId}" settings.set: no active project — "project" scope has no target`
            );
          }
          const store = this.getOrCreateSettingsStore(pluginId, scope, filePath);
          const changed = await store.set(key, value);
          if (changed) this.notifySettingsSubscribers(pluginId, scope, key, value);
        },
        onDidChange: <T = unknown>(
          key: string,
          callback: (value: T | undefined) => void,
          scope: PluginSettingsScope = "user"
        ): (() => void) => {
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
          const sub = { key, scope, cb: callback as (value: unknown) => void };
          let subs = this.settingsSubscribers.get(pluginId);
          if (!subs) {
            subs = new Set();
            this.settingsSubscribers.set(pluginId, subs);
          }
          subs.add(sub);

          let disposed = false;
          const dispose = (): void => {
            if (disposed) return;
            disposed = true;
            const set = this.settingsSubscribers.get(pluginId);
            if (set) {
              set.delete(sub);
              if (set.size === 0) this.settingsSubscribers.delete(pluginId);
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
          return dispose;
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
   * Resolve the active project's renderer WebContents, mirroring the MCP
   * renderer bridge's resolution order: walk every live window's active
   * project view first, then fall back to the global `ProjectViewManager`.
   * Returns `null` (rather than throwing) when no renderer is available so
   * `sendDispatchToRenderer` can return an error result.
   */
  private resolveActiveWebContents(): Electron.WebContents | null {
    const registry = getWindowRegistry();
    if (registry) {
      for (const ctx of registry.all()) {
        if (ctx.browserWindow.isDestroyed()) continue;
        const webContents = ctx.services.projectViewManager?.getActiveView()?.webContents;
        if (webContents && !webContents.isDestroyed()) {
          return webContents;
        }
      }
    }
    const fallback = getProjectViewManager()?.getActiveView()?.webContents;
    if (fallback && !fallback.isDestroyed()) {
      return fallback;
    }
    return null;
  }

  /**
   * Lazily register the single `ipcMain` listener that resolves plugin dispatch
   * responses. Registered on first `host.dispatch()` and torn down in
   * {@link dispose}. The handler validates `event.sender.id` against the
   * pending request's `webContentsId` so a renderer in another window cannot
   * resolve a dispatch initiated for a different window (#4641).
   */
  private ensurePluginDispatchListener(): void {
    if (this.pluginDispatchListenerCleanup) return;
    const handler = (
      event: Electron.IpcMainEvent,
      payload: { requestId: string; result: ActionDispatchResult }
    ) => {
      if (!payload || typeof payload.requestId !== "string") return;
      const pending = this.pendingPluginDispatches.get(payload.requestId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[PluginService] Ignoring dispatch response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
        );
        return;
      }
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      this.pendingPluginDispatches.delete(payload.requestId);
      pending.resolve(payload.result);
    };
    ipcMain.on(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE, handler);
    this.pluginDispatchListenerCleanup = () => {
      ipcMain.removeListener(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE, handler);
    };
  }

  /**
   * Send a plugin-sourced action dispatch to the active renderer and await its
   * response. Always resolves with an {@link ActionDispatchResult} — failures
   * (no renderer, timeout, destroyed view, send error) come back as
   * `EXECUTION_ERROR` rather than a rejected promise.
   */
  private sendDispatchToRenderer(actionId: string, args: unknown): Promise<ActionDispatchResult> {
    return new Promise((resolve) => {
      if (this.disposed) {
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "PluginService is disposed",
          },
        });
        return;
      }
      const webContents = this.resolveActiveWebContents();
      if (!webContents) {
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "No active renderer available to dispatch plugin action",
          },
        });
        return;
      }

      this.ensurePluginDispatchListener();

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = this.pendingPluginDispatches.get(requestId);
        if (!pending) return;
        pending.destroyedCleanup?.();
        this.pendingPluginDispatches.delete(requestId);
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: `Plugin action dispatch timed out: ${actionId}`,
          },
        });
      }, PLUGIN_DISPATCH_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = this.pendingPluginDispatches.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingPluginDispatches.delete(requestId);
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "Renderer destroyed before plugin action dispatch resolved",
          },
        });
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort; webContents may already be gone
        }
      };

      this.pendingPluginDispatches.set(requestId, {
        resolve,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST, { requestId, actionId, args });
      } catch {
        clearTimeout(timer);
        destroyedCleanup();
        this.pendingPluginDispatches.delete(requestId);
        resolve({
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: `Failed to dispatch plugin action: ${actionId}`,
          },
        });
      }
    });
  }

  /**
   * Root directory for user-scope plugin settings: a sibling of the plugins
   * dir. Production: `~/.daintree/plugin-settings`. Derived from
   * {@link pluginsRoot} so tests that pass a custom root stay isolated.
   */
  private settingsRoot(): string {
    return path.join(path.dirname(this.pluginsRoot), "plugin-settings");
  }

  /**
   * Resolve the JSON file backing a plugin's settings for a scope. User scope is
   * fixed; project scope resolves the active project at call time and returns
   * `undefined` when none is active.
   */
  private resolveSettingsFilePath(
    pluginId: string,
    scope: PluginSettingsScope
  ): string | undefined {
    if (scope === "project") {
      const root = projectStore.getCurrentProject()?.path;
      if (!root) return undefined;
      return path.join(root, ".daintree", "plugin-settings", `${pluginId}.json`);
    }
    return path.join(this.settingsRoot(), `${pluginId}.json`);
  }

  private getOrCreateSettingsStore(
    pluginId: string,
    scope: PluginSettingsScope,
    filePath: string
  ): PluginSettingsStore {
    const cacheKey = `${pluginId}\u0000${scope}\u0000${filePath}`;
    let store = this.settingsStores.get(cacheKey);
    if (!store) {
      store = new PluginSettingsStore(filePath);
      this.settingsStores.set(cacheKey, store);
    }
    return store;
  }

  /**
   * Enforce `contributes.settings` key declarations on `set`. F29 has not landed
   * yet, so manifests never declare settings today and any key is accepted; once
   * a plugin declares them, undeclared keys are rejected.
   */
  private assertSettingDeclared(pluginId: string, key: string): void {
    const declared = this.plugins.get(pluginId)?.manifest.contributes.settings;
    if (!declared || declared.length === 0) return;
    if (!declared.some((s) => s.id === key)) {
      throw new Error(
        `Plugin "${pluginId}" settings.set: key "${key}" is not declared in contributes.settings`
      );
    }
  }

  private notifySettingsSubscribers(
    pluginId: string,
    scope: PluginSettingsScope,
    key: string,
    value: unknown
  ): void {
    const subs = this.settingsSubscribers.get(pluginId);
    if (!subs) return;
    // Snapshot so a callback that disposes itself doesn't mutate the live set
    // mid-iteration.
    for (const sub of [...subs]) {
      if (sub.key !== key || sub.scope !== scope) continue;
      try {
        sub.cb(value);
      } catch (err) {
        console.error(
          `[PluginService] settings.onDidChange callback for "${pluginId}" key "${key}" failed:`,
          err
        );
      }
    }
  }

  private clearPluginSettingsState(pluginId: string): void {
    this.settingsSubscribers.delete(pluginId);
    const prefix = `${pluginId}\u0000`;
    for (const cacheKey of [...this.settingsStores.keys()]) {
      if (cacheKey.startsWith(prefix)) this.settingsStores.delete(cacheKey);
    }
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
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    if (channel.includes(":")) {
      throw new Error(`Plugin channel must not contain colons: ${channel}`);
    }

    const key = `${pluginId}:${channel}`;
    const isTypedOverload = isChannelSchema(schemaOrHandler);

    if (isTypedOverload) {
      const schema = schemaOrHandler;
      if (typeof typedHandler !== "function") {
        throw new Error(`Plugin handler must be a function, got ${typeof typedHandler}`);
      }
      // Fail-closed at registration: every capability listed in `requires`
      // must already be declared in the plugin's manifest. Throwing here
      // surfaces author misconfiguration loudly at load instead of at first
      // dispatch (where it would look like a transient runtime error).
      const requires = schema.requires ?? [];
      const declared = new Set<BuiltInPluginCapability>(plugin.manifest.capabilities ?? []);
      const missing = requires.filter((cap) => !declared.has(cap));
      if (missing.length > 0) {
        throw new Error(
          `PERMISSION_REQUIRED: channel "${channel}" requires capability "${missing[0]}" which is not declared in plugin "${pluginId}" manifest.capabilities`
        );
      }

      const boundHandler = typedHandler;
      // Adapt the single-payload typed handler to the variadic
      // PluginIpcHandler shape so the dispatch path stays uniform. The
      // first variadic arg is the parsed payload; `dispatchHandler` only
      // calls this after `schema.args.safeParse` succeeds, so the cast is
      // safe at call time.
      const adapter: PluginIpcHandler = (ctx, ...args) =>
        boundHandler(ctx, args.length > 0 ? args[0] : undefined);

      this.handlerMap.set(key, adapter);
      this.channelSchemas.set(key, schema);
      this.channelRequires.set(key, requires);
      return;
    }

    if (typeof schemaOrHandler !== "function") {
      throw new Error(`Plugin handler must be a function, got ${typeof schemaOrHandler}`);
    }
    // Re-registration drops any prior typed-channel metadata so a legacy
    // re-bind doesn't strand a stale schema or capability gate keyed to the
    // same channel.
    this.channelSchemas.delete(key);
    this.channelRequires.delete(key);
    this.handlerMap.set(key, schemaOrHandler);
  }

  async dispatchHandler(
    pluginId: string,
    channel: string,
    ctx: PluginIpcContext,
    args: unknown[]
  ): Promise<unknown> {
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
    const handler = this.handlerMap.get(key);
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
      try {
        return await actionHandler(args.length > 0 ? args[0] : {});
      } catch (err) {
        // Contain at the boundary so a throwing handler can't propagate up
        // through `ipcMain.handle` as an unhandled rejection. The error still
        // surfaces to the renderer (rethrown after logging).
        // TODO(#9232): emit PluginActionAuditRecord to the audit pipeline.
        console.error(`[PluginService] Action handler "${channel}" threw:`, err);
        throw err;
      }
    }

    if (!handler) {
      throw new Error(`No plugin handler registered for ${key}`);
    }

    // Typed-channel path (registered via the schema overload of
    // `registerHandler`). The capability gate already fired at registration
    // — this re-check is defense-in-depth against a future code path that
    // mutates a loaded manifest after registration.
    const channelSchema = this.channelSchemas.get(key);
    const channelRequires = this.channelRequires.get(key);
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
      // TODO(#9232): emit PluginActionAuditRecord to the audit pipeline.
      console.error(`[PluginService] Handler "${key}" threw:`, err);
      throw err;
    }

    if (channelSchema) {
      const parsedResult = channelSchema.result.safeParse(result);
      if (!parsedResult.success) {
        throw new Error(
          `SCHEMA_ERROR: result for channel "${channel}" failed validation: ${z.prettifyError(parsedResult.error)}`
        );
      }
      return parsedResult.data;
    }

    return result;
  }

  removeHandlers(pluginId: string): void {
    const prefix = `${pluginId}:`;
    for (const key of [...this.handlerMap.keys()]) {
      if (key.startsWith(prefix)) {
        this.handlerMap.delete(key);
        this.actionValidators.delete(key.slice(prefix.length));
        this.channelSchemas.delete(key);
        this.channelRequires.delete(key);
      }
    }
  }

  /**
   * Atomically install a plugin from a `.dntr` archive path or a pre-extracted
   * directory. This is the ONLY path that mutates {@link pluginsRoot} — direct
   * IPC writes to the plugins directory are a review blocker (#9292).
   *
   * The flow, with rollback on every failure branch:
   * 1. Acquire the cross-process `install.lock` (sub-30s stale TTL so a crashed
   *    prior install can't hold it forever). A second instance blocks, not races.
   * 2. Extract / copy the source into a sibling `.install-tmp-*` dir — same
   *    filesystem as the final location so the eventual rename is atomic.
   * 3. Validate `plugin.json` with the strict Zod schema (unknown keys, reserved
   *    `daintree.*` namespace, publisher/name agreement) and the engine range.
   * 4. Compute the `.dntr` SHA-256 for the `archiveHash` provenance field.
   * 5. If the id already exists: `unloadPlugin` (disposer cascade), then swap via
   *    rename — park old aside → move new in → restore old on failure. Per-plugin
   *    settings/secrets live under a separate `plugin-settings/` root, so the
   *    directory swap never touches them; no preserve/restore step is needed.
   * 6. On any failure the temp dir is removed, the lock released, and a structured
   *    error returned. The on-disk plugin directory is never left half-written.
   *
   * Structured validation errors are RETURNED as `{ status: "failed", errors }`
   * data, never thrown, so they survive the IPC structured-clone boundary
   * intact (#3769) for the F22/F23/F24 install dialogs.
   */
  async installPlugin(
    archivePath: string,
    opts?: PluginInstallOptions
  ): Promise<PluginInstallResult> {
    const fail = (code: PluginInstallErrorCode, message: string): PluginInstallResult => ({
      status: "failed",
      errors: [{ code, message }],
    });

    await fs.mkdir(this.pluginsRoot, { recursive: true });

    const lockPath = path.join(this.pluginsRoot, "install.lock");
    let release: (() => Promise<void>) | null = null;
    try {
      release = await properLockfile.lock(lockPath, {
        // Sub-30s stale TTL with mid-hold refresh every 10s. A crashed prior
        // install's lock is reclaimed after 20s instead of being held forever.
        stale: 20_000,
        update: 10_000,
        // The lock target need not pre-exist — proper-lockfile creates
        // `install.lock.lock` adjacent. `realpath: false` skips the existence
        // probe that would otherwise reject before the lock dir is made.
        realpath: false,
        retries: { retries: 5, minTimeout: 100, maxTimeout: 1_000 },
        onCompromised: (err) => {
          console.error("[PluginService] install.lock compromised during install:", err);
        },
      });
    } catch (err) {
      return fail(
        "lock_failed",
        `Couldn't acquire the plugin install lock: ${(err as Error).message}`
      );
    }

    let tmpDir: string | null = null;
    try {
      tmpDir = await fs.mkdtemp(path.join(this.pluginsRoot, ".install-tmp-"));

      // 1. Materialize the plugin into the temp dir.
      let sourceIsDir: boolean;
      try {
        sourceIsDir = (await fs.stat(archivePath)).isDirectory();
      } catch (err) {
        return fail("archive_invalid", `Install source not found: ${(err as Error).message}`);
      }

      let hash: string | null = null;
      if (sourceIsDir) {
        try {
          await fs.cp(archivePath, tmpDir, { recursive: true });
        } catch (err) {
          return fail(
            "archive_invalid",
            `Failed to copy plugin directory: ${(err as Error).message}`
          );
        }
      } else {
        try {
          await extractPluginArchive(archivePath, tmpDir);
        } catch (err) {
          return fail("archive_invalid", `Failed to extract archive: ${(err as Error).message}`);
        }
        try {
          hash = await computeArchiveHash(archivePath);
        } catch (err) {
          return fail("hash_failed", `Failed to compute archive hash: ${(err as Error).message}`);
        }
      }

      // 2. Read + strictly validate the manifest.
      let rawManifest: string;
      try {
        rawManifest = await fs.readFile(path.join(tmpDir, "plugin.json"), "utf-8");
      } catch {
        return fail("manifest_invalid", "plugin.json not found at the archive root");
      }
      let json: unknown;
      try {
        json = JSON.parse(rawManifest);
      } catch {
        return fail("manifest_invalid", "plugin.json is not valid JSON");
      }
      const parsed = getPluginManifestSchema(false).safeParse(json);
      if (!parsed.success) {
        const errors: PluginInstallError[] = parsed.error.issues.map((issue) => {
          const isNamespace =
            issue.code === "custom" &&
            (issue as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
              "namespace_reserved";
          return {
            code: isNamespace ? "namespace_unauthorized" : "manifest_invalid",
            path: issue.path.map(String),
            message: issue.message,
          };
        });
        return { status: "failed", errors };
      }
      const manifest = parsed.data;

      // 3. Engine compatibility.
      const requiredRange = manifest.engines?.daintree;
      if (
        requiredRange &&
        !semver.satisfies(this.appVersion, requiredRange, { includePrerelease: true })
      ) {
        return fail(
          "engine_incompatible",
          `Plugin requires Daintree ${requiredRange} but the running version is ${this.appVersion}`
        );
      }

      // 4. Atomic swap into the final location.
      const pluginId = manifest.name;
      const finalDir = path.join(this.pluginsRoot, pluginId);
      let existing = false;
      try {
        await fs.access(finalDir);
        existing = true;
      } catch {
        existing = false;
      }

      if (existing) {
        try {
          this.unloadPlugin(pluginId);
        } catch (err) {
          return fail(
            "unload_failed",
            `Failed to unload the existing "${pluginId}" before upgrade: ${(err as Error).message}`
          );
        }
      }

      const swapError = await this._swapPluginDir(tmpDir, finalDir, existing);
      if (swapError) return { status: "failed", errors: [swapError] };
      // The temp dir was renamed into place — drop the handle so the `finally`
      // cleanup doesn't delete the freshly installed plugin.
      tmpDir = null;

      // 5. Persist provenance and load the new plugin.
      this.upsertInstalledRecord(pluginId, {
        source: opts?.source ?? "sideload",
        installedAt: Date.now(),
        originalUrl: opts?.originalUrl ?? null,
        archiveHash: hash,
        loadError: null,
      });

      const loaded = await this.loadPlugin(this.pluginsRoot, pluginId, {
        isBuiltin: false,
        disabled: this.getDisabledIds(),
      });
      if (!loaded) {
        // The swap committed and provenance is persisted, so the directory is
        // intact and consistent — the user can retry activation or reinstall
        // without re-downloading. We deliberately leave the directory in place.
        return {
          status: "failed",
          errors: [
            {
              code: "load_failed",
              message: `Plugin "${pluginId}" installed but failed to load. Retry from Settings.`,
            },
          ],
        };
      }

      // setPluginArchiveHash requires the plugin to be loaded; call it after.
      if (hash) this.setPluginArchiveHash(pluginId, hash);
      await this.activatePlugin(pluginId);

      return { status: "installed", pluginId };
    } finally {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[PluginService] Failed to clean up install temp dir ${tmpDir}:`, err);
        });
      }
      if (release) {
        await release().catch((err) => {
          console.warn("[PluginService] Failed to release install lock:", err);
        });
      }
    }
  }

  /**
   * Atomic directory swap for {@link installPlugin}. Returns `null` on success
   * or a structured {@link PluginInstallError} on failure. When `existing` is
   * true the current `finalDir` is parked aside first and restored if the new
   * directory can't be moved in.
   *
   * `swap_unrecoverable` is reserved for the case where BOTH the move-in AND
   * the restore fail — the plugin directory may be missing and the message
   * says so explicitly rather than swallowing the inconsistency.
   */
  private async _swapPluginDir(
    tmpDir: string,
    finalDir: string,
    existing: boolean
  ): Promise<PluginInstallError | null> {
    const parked = existing ? `${finalDir}.old-${randomUUID()}` : null;

    if (parked) {
      try {
        await resilientRename(finalDir, parked);
      } catch (err) {
        return {
          code: "swap_failed",
          message: `Couldn't move the existing plugin aside: ${(err as Error).message}`,
        };
      }
    }

    try {
      await resilientRename(tmpDir, finalDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const detail =
        code === "EXDEV"
          ? `cross-device rename not supported — the staging dir is on a different filesystem than ${finalDir}`
          : (err as Error).message;
      if (parked) {
        try {
          await resilientRename(parked, finalDir);
        } catch (restoreErr) {
          return {
            code: "swap_unrecoverable",
            message: `Install failed (${detail}) and the previous plugin couldn't be restored (${(restoreErr as Error).message}). The directory at ${finalDir} may be missing — reinstall to recover.`,
          };
        }
      }
      return {
        code: "swap_failed",
        message: `Couldn't move the new plugin into place: ${detail}`,
      };
    }

    // New dir is in place — remove the parked old copy best-effort. A failure
    // here only leaks a `.old-*` dir (skipped by the load scan), never the
    // installed plugin.
    if (parked) {
      await fs.rm(parked, { recursive: true, force: true }).catch((err) => {
        console.warn(`[PluginService] Failed to remove parked old plugin dir ${parked}:`, err);
      });
    }
    return null;
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
    runUnloadStep(pluginId, "scheduleMenuItemsBroadcast", () =>
      this.scheduleMenuItemsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginKeybindings", () =>
      unregisterPluginKeybindings(pluginId)
    );
    runUnloadStep(pluginId, "scheduleKeybindingsBroadcast", () =>
      this.scheduleKeybindingsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginContextMenuItems", () =>
      unregisterPluginContextMenuItems(pluginId)
    );
    runUnloadStep(pluginId, "scheduleContextMenuItemsBroadcast", () =>
      this.scheduleContextMenuItemsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterWhenClausePlugin", () =>
      unregisterWhenClausePlugin(pluginId)
    );
    runUnloadStep(pluginId, "unregisterPluginToolbarButtons", () =>
      unregisterPluginToolbarButtons(pluginId)
    );
    runUnloadStep(pluginId, "scheduleToolbarButtonsBroadcast", () =>
      this.scheduleToolbarButtonsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginPanelKinds", () =>
      unregisterPluginPanelKinds(pluginId)
    );
    runUnloadStep(pluginId, "unregisterForgeProviders", () => unregisterForgeProviders(pluginId));
    runUnloadStep(pluginId, "unregisterForgeProviderImpls", () =>
      unregisterForgeProviderImpls(pluginId)
    );
    runUnloadStep(pluginId, "unregisterFileDecorationProviders", () =>
      unregisterFileDecorationProviders(pluginId)
    );
    runUnloadStep(pluginId, "unregisterFileDecorationProviderImpls", () =>
      unregisterFileDecorationProviderImpls(pluginId)
    );
    // Subscriber disposers already fired in flushPluginEventCleanups() above;
    // this drops any leftover subscriber-set entry and the in-memory settings
    // store caches so a reload starts from disk.
    runUnloadStep(pluginId, "clearPluginSettingsState", () =>
      this.clearPluginSettingsState(pluginId)
    );

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
   * Look up a single `contributes.experimental_mcpServers` entry by id along
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
        contribution: PluginManifest["contributes"]["experimental_mcpServers"][number];
        pluginDir: string;
      }
    | undefined {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return undefined;
    const contribution = plugin.manifest.contributes.experimental_mcpServers.find(
      (c) => c.id === serverId
    );
    if (!contribution) return undefined;
    return { contribution, pluginDir: plugin.dir };
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
    const filePath = this.resolveSettingsFilePath(pluginId, "user");
    if (!filePath) return "";
    const value = await this.getOrCreateSettingsStore(pluginId, "user", filePath).get<unknown>(
      settingId
    );
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  listPlugins(): LoadedPluginInfo[] {
    // Desired state is the live persisted list; the running state is fixed for
    // the session (`this.plugins` = loaded at launch, `this.disabledPlugins` =
    // skipped at launch — disabling never unloads at runtime). Reporting both
    // lets the renderer show the correct switch position and a "restart
    // required" cue that survives a tab remount (#9284).
    const desiredDisabled = this.getDisabledIds();
    const installed = this.getInstalledRecords();

    const toInfo = (
      p: { manifest: PluginManifest; dir: string; isBuiltin: boolean },
      loadedAt: number,
      isRunning: boolean
    ): LoadedPluginInfo => {
      const disabled = desiredDisabled.has(p.manifest.name);
      // pendingRestart: desired state diverges from running state.
      // Running + now-disabled → unload pending; skipped + now-enabled → load pending.
      const pendingRestart = isRunning ? disabled : !disabled;
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
        archiveHash: record?.archiveHash ?? null,
        originalUrl: record?.originalUrl ?? null,
        loadError: record?.loadError ?? null,
        disabled,
        updateAvailable: record?.updateAvailable ?? null,
        devMode: record?.devMode ?? false,
        pendingRestart,
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
   * `plugins.disabled` in electron-store; the change takes effect on next
   * launch (no synchronous unload — the renderer surfaces a restart-required
   * cue). Idempotent: enabling an already-enabled plugin or disabling an
   * already-disabled one is a no-op write. Permissive by design — the store is
   * a declared-intent list, not a live registry, so no existence check.
   */
  setEnabled(pluginId: string, enabled: boolean): void {
    if (typeof pluginId !== "string" || pluginId.trim().length === 0) {
      throw new Error("setEnabled: pluginId must be a non-empty string");
    }
    if (typeof enabled !== "boolean") {
      throw new Error("setEnabled: enabled must be a boolean");
    }
    const plugins = (store.get("plugins") as { disabled?: unknown } | undefined) ?? {};
    const current = Array.isArray(plugins.disabled)
      ? plugins.disabled.filter((id): id is string => typeof id === "string")
      : [];
    const next = enabled
      ? current.filter((id) => id !== pluginId)
      : Array.from(new Set([...current, pluginId]));
    store.set("plugins", { ...plugins, disabled: next } as never);
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
      this.upsertInstalledRecord(pluginId, { archiveHash });
    }
  }

  /**
   * Most recent activation error for a plugin id, or `undefined` if the last
   * load succeeded (or the plugin has never been loaded). Reads from the
   * persisted provenance record so the error survives a host restart.
   */
  getPluginLoadError(pluginId: string): PluginLoadError | undefined {
    return this.getInstalledRecord(pluginId)?.loadError ?? undefined;
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

    this.broadcastPluginActions();
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

    this.broadcastPluginActions();
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

    this.broadcastPluginActions();
  }

  /** Flattened snapshot of all plugin-registered actions (for renderer pull-on-mount). */
  listPluginActions(): PluginActionDescriptor[] {
    return Array.from(this.pluginActions.values());
  }

  private broadcastPluginActions(): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions: this.listPluginActions() },
    });
  }

  /**
   * Coalesce multiple registry mutations in the same microtask into a single
   * broadcast. `unregisterPluginPanelKinds` fires the unregister listener once
   * per removed kind; without this batching a plugin contributing N panels
   * would trigger N broadcasts on unload, each carrying the same shrinking
   * snapshot.
   */
  private schedulePanelKindsBroadcast(): void {
    if (this.disposed) return;
    if (this.panelKindsBroadcastPending) return;
    this.panelKindsBroadcastPending = true;
    queueMicrotask(() => {
      this.panelKindsBroadcastPending = false;
      // Disposal between scheduling and the microtask draining must not leak
      // a phantom broadcast — particularly important for test isolation where
      // a service from one test could otherwise emit into the next.
      if (this.disposed) return;
      this.broadcastPluginPanelKinds();
    });
  }

  private broadcastPluginPanelKinds(): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:panel-kinds-changed",
      payload: { kinds: getPluginPanelKinds() },
    });
  }

  /**
   * Coalesce toolbar-button registry mutations the same way panel kinds are
   * batched (see {@link schedulePanelKindsBroadcast}). Toolbar buttons are only
   * ever mutated from `loadPlugin()` / `unloadPlugin()`, so the two call sites
   * invoke this directly rather than via registry event listeners.
   */
  private scheduleToolbarButtonsBroadcast(complete: boolean): void {
    if (this.disposed) return;
    if (complete) this.toolbarButtonsBroadcastComplete = true;
    if (this.toolbarButtonsBroadcastPending) return;
    this.toolbarButtonsBroadcastPending = true;
    queueMicrotask(() => {
      this.toolbarButtonsBroadcastPending = false;
      const complete = this.toolbarButtonsBroadcastComplete;
      this.toolbarButtonsBroadcastComplete = false;
      if (this.disposed) return;
      this.broadcastPluginToolbarButtons(complete);
    });
  }

  private broadcastPluginToolbarButtons(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:toolbar-buttons-changed",
      payload: { buttons: getAllPluginToolbarButtonConfigs(), complete },
    });
  }

  /**
   * Same shape as {@link scheduleToolbarButtonsBroadcast}; see that method for
   * the coalescing and `complete`-OR-accumulation rationale.
   */
  private scheduleMenuItemsBroadcast(complete: boolean): void {
    if (this.disposed) return;
    if (complete) this.menuItemsBroadcastComplete = true;
    if (this.menuItemsBroadcastPending) return;
    this.menuItemsBroadcastPending = true;
    queueMicrotask(() => {
      this.menuItemsBroadcastPending = false;
      const drained = this.menuItemsBroadcastComplete;
      this.menuItemsBroadcastComplete = false;
      if (this.disposed) return;
      this.broadcastPluginMenuItems(drained);
    });
  }

  private broadcastPluginMenuItems(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:menu-items-changed",
      payload: { items: getPluginMenuItems(), complete },
    });
  }

  private scheduleKeybindingsBroadcast(complete: boolean): void {
    this.keybindingsBroadcastComplete ||= complete;
    if (this.keybindingsBroadcastPending) {
      return;
    }
    this.keybindingsBroadcastPending = true;
    queueMicrotask(() => {
      const isComplete = this.keybindingsBroadcastComplete;
      this.keybindingsBroadcastPending = false;
      this.keybindingsBroadcastComplete = false;
      if (this.disposed) return;
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
        name: "plugin:keybindings-changed",
        payload: { keybindings: getPluginKeybindings(), complete: isComplete },
      });
    });
  }

  /**
   * Same shape as {@link scheduleMenuItemsBroadcast}; see that method for the
   * coalescing and `complete`-OR-accumulation rationale.
   */
  private scheduleContextMenuItemsBroadcast(complete: boolean): void {
    if (this.disposed) return;
    if (complete) this.contextMenuItemsBroadcastComplete = true;
    if (this.contextMenuItemsBroadcastPending) return;
    this.contextMenuItemsBroadcastPending = true;
    queueMicrotask(() => {
      this.contextMenuItemsBroadcastPending = false;
      const drained = this.contextMenuItemsBroadcastComplete;
      this.contextMenuItemsBroadcastComplete = false;
      if (this.disposed) return;
      this.broadcastPluginContextMenuItems(drained);
    });
  }

  private broadcastPluginContextMenuItems(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:context-menu-items-changed",
      payload: { items: getPluginContextMenuItems(), complete },
    });
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
  async pushSnapshotTo(webContents: Electron.WebContents): Promise<void> {
    await this.initPromise;
    if (this.disposed) return;
    if (webContents.isDestroyed()) return;
    // Mirror `broadcastToRenderer`'s defensive send pattern (electron/ipc/utils.ts:337-352):
    // the wc may be destroyed between the isDestroyed() check above and any
    // individual send (TOCTOU), and a throw on the first send would otherwise
    // leave the next two channels un-sent — silently degrading the
    // cold-restored renderer to its pull-on-mount path for those two channels
    // only. Each send is independently guarded.
    const events: Array<{ name: string; payload: unknown }> = [
      { name: "plugin:actions-changed", payload: { actions: this.listPluginActions() } },
      { name: "plugin:panel-kinds-changed", payload: { kinds: getPluginPanelKinds() } },
      {
        name: "plugin:toolbar-buttons-changed",
        payload: { buttons: getAllPluginToolbarButtonConfigs(), complete: false },
      },
      {
        name: "plugin:menu-items-changed",
        payload: { items: getPluginMenuItems(), complete: false },
      },
      {
        name: "plugin:keybindings-changed",
        payload: { keybindings: getPluginKeybindings(), complete: true },
      },
      {
        name: "plugin:context-menu-items-changed",
        payload: { items: getPluginContextMenuItems(), complete: false },
      },
    ];
    for (const event of events) {
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, event);
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
const e2eSideloadDir = process.env.DAINTREE_E2E_SIDELOAD_PLUGIN_DIR || undefined;
export const pluginService = new PluginService(undefined, undefined, {
  sideloadPluginsRoot: e2eSideloadDir,
});
