import fs, { type FileHandle } from "fs/promises";
import type { BigIntStats } from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { runExclusive } from "../../utils/keyedMutex.js";
import { watchShared } from "../FileObservationService.js";
import { fileTreeService } from "../FileTreeService.js";
import { clipboard, shell } from "electron";
import { decodeClipboardPng, MAX_CLIPBOARD_IMAGE_BYTES } from "../../utils/clipboardImage.js";
import { assertExtensionAllowed } from "../../utils/executablePathGuard.js";

import { getPluginCapabilityConsentService } from "../plugin-capability/instances.js";
import { resolveContainedPath, PluginPathNotAllowedError } from "./pluginFsContainment.js";
import { PluginHostGit, type HostGitFactory } from "./pluginHostGit.js";
import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "./projectPluginIdentity.js";
import { toRuntimePanelKindId } from "../../../shared/config/panelKindRegistry.js";
import type { PluginProcessManager } from "./PluginProcessManager.js";
import { PLUGIN_PTY_DEFAULT_COLS, PLUGIN_PTY_DEFAULT_ROWS } from "./PluginProcessManager.js";
import type { PluginContributionBroadcaster } from "./PluginContributionBroadcaster.js";
import type { PluginPanelLifecycleBroker } from "./PluginPanelLifecycleBroker.js";
import type { PluginRendererDispatcher } from "./PluginRendererDispatcher.js";
import type { PluginPanelReloadDispatcher } from "./PluginPanelReloadDispatcher.js";
import type { PluginUIPromptDispatcher } from "./PluginUIPromptDispatcher.js";
import { assertSettingsKey, type PluginSettingsManager } from "./PluginSettingsManager.js";
import {
  assertStorageKey,
  type ExplicitStorageTarget,
  type PluginStorageManager,
} from "./PluginStorageManager.js";
import { createListenerFailureState, invokeTrackedListener } from "./pluginCallbackUtils.js";
import { isChannelSchema } from "./PluginChannelRegistry.js";
import { abortErrorFor } from "./pluginAbortError.js";
import { openPluginDatabase, resolvePluginDatabaseLocation } from "./pluginDatabase.js";
import { agentMcpEndpointRegistry } from "../pluginAgentMcp/endpointRegistry.js";
import { validateAgentMcpTools } from "../pluginAgentMcp/validateTools.js";
import type { AgentMcpToolInvoker } from "../pluginAgentMcp/types.js";

import { events } from "../events.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import {
  registerForgeProviderImpl,
  unregisterForgeProviderImpl,
} from "../forgeProviderRegistry.js";
import { buildStoredCredentials } from "../forge/forgeCredentialUtils.js";
import {
  registerFileDecorationProviderImpl,
  unregisterFileDecorationProviderImpl,
  scopeMatchesPattern,
} from "../fileDecorationRegistry.js";
import { broadcastToRenderer, broadcastToProjectRenderers } from "../../ipc/utils.js";
import { isAppError } from "../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getPluginActionAuditService } from "../PluginActionAuditService.js";
import { PluginPanelBadgeSchema, PluginToastOptionsSchema } from "../../schemas/plugin.js";
import { makeForgeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import {
  toPluginWorktreeSnapshot,
  toPluginWorktreeStatus,
} from "../../../shared/utils/pluginWorktreeSnapshot.js";
import {
  toPluginAgentSnapshot,
  type AgentStateChangePayload,
} from "../../../shared/utils/pluginAgentSnapshot.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type { PluginDiagnosticsLogLine } from "../../../shared/types/ipc/pluginDiagnostics.js";
import type {
  PluginIpcHandler,
  PluginHostApi,
  PluginIdentity,
  PluginWorktreesResult,
  PluginWorktreesUnavailableReason,
  PluginActionContribution,
  PluginActionDescriptor,
  PluginChannelSchema,
  PluginTypedIpcHandler,
  ActionHandler,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginHostCallOptions,
  PluginInputBoxOptions,
  PluginConfirmOptions,
  BuiltInPluginCapability,
  PluginSettingsScope,
  PluginStorageScope,
  PluginAgentSnapshot,
  PluginPanelLifecycleEvent,
  PluginProcessApi,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessMode,
  PluginDuplexProcessHandle,
  PluginDuplexProcessSpawnOptions,
  PluginPtyProcessHandle,
  PluginPtyProcessSpawnOptions,
  BuiltinPluginFsApi,
  PluginWorkspaceScope,
  PluginFsDirEntry,
  PluginFsWriteErrorCode,
  PluginFsStat,
  PluginGitApi,
  PluginClipboardApi,
  PluginSystemApi,
  PluginGitStatus,
  PluginGitCommitOptions,
  PluginGitCommitResult,
  PluginPanelBadge,
  PluginHostBinding,
  PluginMcpCaller,
  PluginMcpToolDefinition,
} from "../../../shared/types/plugin.js";
import type {
  LoadedPlugin,
  ValidateFn,
  FsRootClass,
  ExpandedFsPath,
  WorkspaceWorktreeEvent,
} from "./PluginServiceTypes.js";

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
 * Ceiling for a `host.fs.watch` `debounceMs`. Node clamps any timer delay past
 * 2^31-1 ms to 1 ms, so an unbounded value would turn "almost never" into
 * "immediately"; a minute is already far past any useful coalescing window.
 */
const MAX_PLUGIN_FS_WATCH_DEBOUNCE_MS = 60_000;

/**
 * The slice of a `WorkspaceClient` worktree event a plugin subscription reads.
 * Only the owning project's path matters here — it is what lets a project-bound
 * host drop another project's worktree churn instead of waking on all of it.
 */
export interface PluginWorktreeEventPayload {
  projectPath?: string;
}

/**
 * Compare two project paths the way the workspace-host pool keys them
 * (`path.resolve`, plus win32's case-insensitive filesystem) so a binding's
 * realpath-resolved root matches the path an event carries.
 */
function isSameProjectPath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Is this the frozen `PROJECT_VIEW_UNAVAILABLE` rejection a bound renderer
 * round-trip raises? The read-only catalog surface is documented as resolving
 * empty rather than throwing when no renderer is available, so it swallows
 * exactly this failure — and nothing else, which would mask real bugs.
 */
function isProjectViewUnavailable(error: unknown): boolean {
  return isAppError(error) && error.code === "PROJECT_VIEW_UNAVAILABLE";
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
  const seen = new Set<string>();
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
    // Ids must be unique — selection tracking and multi-select keys off the id,
    // so a duplicate would toggle/return multiple rows in lockstep.
    if (seen.has(item.id)) {
      throw new Error(
        `Plugin "${pluginId}" showQuickPick: duplicate item id "${item.id}" (ids must be unique)`
      );
    }
    seen.add(item.id);
    return {
      id: item.id,
      label: item.label,
      ...(item.description !== undefined ? { description: String(item.description) } : {}),
      ...(item.detail !== undefined ? { detail: String(item.detail) } : {}),
    };
  });
}

/**
 * Coerce the string fields of the prompt option objects before they cross to
 * the renderer. A buggy plugin passing a non-string (e.g. `{ message: {} }`)
 * would otherwise crash the dialog inside its ErrorBoundary and strand the
 * pending promise until unload — coercion keeps the round-trip serializable and
 * the dialog renderable. Booleans are normalized with `Boolean(...)`.
 */
function sanitizeQuickPickOptions(options?: PluginQuickPickOptions): PluginQuickPickOptions {
  if (!options || typeof options !== "object") return {};
  return {
    ...(options.title !== undefined ? { title: String(options.title) } : {}),
    ...(options.placeholder !== undefined ? { placeholder: String(options.placeholder) } : {}),
    ...(options.canSelectMany !== undefined
      ? { canSelectMany: Boolean(options.canSelectMany) }
      : {}),
    ...(options.matchOnDescription !== undefined
      ? { matchOnDescription: Boolean(options.matchOnDescription) }
      : {}),
  };
}

function sanitizeInputBoxOptions(options?: PluginInputBoxOptions): PluginInputBoxOptions {
  if (!options || typeof options !== "object") return {};
  return {
    ...(options.title !== undefined ? { title: String(options.title) } : {}),
    ...(options.prompt !== undefined ? { prompt: String(options.prompt) } : {}),
    ...(options.placeholder !== undefined ? { placeholder: String(options.placeholder) } : {}),
    ...(options.value !== undefined ? { value: String(options.value) } : {}),
    ...(options.password !== undefined ? { password: Boolean(options.password) } : {}),
    ...(options.validationPattern !== undefined
      ? { validationPattern: String(options.validationPattern) }
      : {}),
    ...(options.validationMessage !== undefined
      ? { validationMessage: String(options.validationMessage) }
      : {}),
  };
}

function sanitizeConfirmOptions(options: PluginConfirmOptions): PluginConfirmOptions {
  return {
    title: String(options.title),
    ...(options.message !== undefined ? { message: String(options.message) } : {}),
    ...(options.confirmLabel !== undefined ? { confirmLabel: String(options.confirmLabel) } : {}),
    ...(options.cancelLabel !== undefined ? { cancelLabel: String(options.cancelLabel) } : {}),
    ...(options.destructive !== undefined ? { destructive: Boolean(options.destructive) } : {}),
  };
}

/**
 * A worktree read the factory's dependencies performed, keeping the reason it
 * came back with nothing (#12174).
 *
 * The internal twin of {@link PluginWorktreesResult}: same discriminant, but
 * carrying raw `WorktreeSnapshot`s, which the factory projects through
 * `toPluginWorktreeSnapshot` before a plugin ever sees them. `plugin-unloaded`
 * is excluded because only the factory can observe it.
 */
export type PluginWorktreeSnapshotFetchResult =
  | { status: "ok"; projectId: string; snapshots: WorktreeSnapshot[] }
  | {
      status: "unavailable";
      reason: Exclude<PluginWorktreesUnavailableReason, "plugin-unloaded">;
    };

/**
 * Live collaborators and shared registries `createHost` and the fs/git/process/
 * clipboard API builders read and write. Every Map/Set/collaborator field here
 * is the SAME live reference `PluginService` holds — never a snapshot — so the
 * post-await `plugins.get(id) === boundPlugin` / `plugins.has(id)` liveness
 * checks inside these closures keep observing concurrent unload races
 * correctly (#9428, #5638, #9322). Built fresh on each `createHost` call from
 * inside `PluginService`'s class body, where private field access is legal.
 */
export interface PluginHostFactoryDeps {
  plugins: Map<string, LoadedPlugin>;
  pluginEventCleanups: Map<string, Array<() => void>>;
  pluginActions: Map<string, PluginActionDescriptor>;
  pluginActionHandlers: Map<string, ActionHandler>;
  pluginActionOwners: Map<string, Set<string>>;
  actionValidators: Map<string, ValidateFn>;
  pluginBadges: Map<string, Map<string, PluginPanelBadge>>;
  pluginFsWatchers: Map<string, Set<() => void>>;
  broadcaster: PluginContributionBroadcaster;
  panelLifecycleBroker: PluginPanelLifecycleBroker;
  dispatcher: PluginRendererDispatcher;
  panelReloadDispatcher: PluginPanelReloadDispatcher;
  promptDispatcher: PluginUIPromptDispatcher;
  settings: PluginSettingsManager;
  storage: PluginStorageManager;
  /** Live read of the mutable `hostGitFactory` field — reassignable via `_setHostGitFactoryForTests`. */
  getHostGitFactory: () => HostGitFactory | undefined;
  getProcessManager: () => PluginProcessManager;
  declaredCapabilities: (pluginId: string) => Set<BuiltInPluginCapability>;
  /**
   * Worktree snapshots for the host's project, carrying why there are none and
   * which project the ones there are belong to (#12174).
   *
   * Result-shaped rather than `WorktreeSnapshot[]` because `[]` is the same
   * answer for "this project has no worktrees" and for five ways of having no
   * answer at all, and the host API has to be able to tell a plugin apart. The
   * `plugin-unloaded` reason is not reachable here — liveness is the factory's
   * own concern, checked around this call — so it is excluded from the shape.
   */
  fetchWorktreeSnapshotsResult: () => Promise<PluginWorktreeSnapshotFetchResult>;
  /**
   * The same read for one named project, for a project-bound host. Reads the
   * workspace host that owns `projectRoot` directly instead of the focused
   * window's, and reports `project-unavailable` once that project closes.
   */
  fetchWorktreeSnapshotsForProjectResult: (
    projectId: string,
    projectRoot: string
  ) => Promise<PluginWorktreeSnapshotFetchResult>;
  recordPluginLog: (
    boundPlugin: LoadedPlugin,
    pluginId: string,
    level: PluginDiagnosticsLogLine["level"],
    message: string,
    fields?: Record<string, unknown>
  ) => void;
  serializePluginBadges: (pluginId: string) => Record<string, PluginPanelBadge>;
  /** User-facing name for a plugin id, for surfaces that name a plugin to a person. */
  pluginDisplayName: (pluginId: string) => string;
  pluginDataDir: (pluginId: string) => string;
  isPathUnder: (root: string, candidate: string) => boolean;
  /**
   * `scope` pins the `${project}` / `${worktree}` tokens to one named project
   * and worktree instead of resolving them from the plugin's binding (or, for
   * an unbound plugin, the focused window) — the expansion behind
   * a built-in host's `fsForWorkspace`. It only ever replaces the
   * token resolution: a scope naming a project or worktree that is not live
   * contributes no token root, so containment denies.
   */
  expandAllowedPathEntries: (
    pluginId: string,
    options: { includeDataDir: boolean; scope?: PluginWorkspaceScope }
  ) => Promise<ExpandedFsPath[]>;
  subscribeWorktreeEvent: (
    pluginId: string,
    event: WorkspaceWorktreeEvent,
    handler: (payload?: PluginWorktreeEventPayload) => void
  ) => () => void;
  registerHandler: (
    pluginId: string,
    channel: string,
    schemaOrHandler: PluginChannelSchema<unknown, unknown> | PluginIpcHandler,
    typedHandler?: PluginTypedIpcHandler<unknown, unknown>
  ) => void;
  validateAndBuildActionDescriptor: (
    pluginId: string,
    contribution: PluginActionContribution
  ) => PluginActionDescriptor;
  safeAppendAudit: (
    input: Parameters<ReturnType<typeof getPluginActionAuditService>["append"]>[0]
  ) => void;
  safeArgsHash: (args: unknown[]) => string;
}

/**
 * Replace the get-or-create-list/push/self-splicing-dispose boilerplate that
 * was copy-pasted across 5 host closures. `teardown` runs the closure-specific
 * unsubscribe/unregister work; the list bookkeeping is identical everywhere.
 */
function trackPluginDisposer(
  pluginEventCleanups: Map<string, Array<() => void>>,
  pluginId: string,
  teardown: () => void
): () => void {
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    teardown();
    const list = pluginEventCleanups.get(pluginId);
    if (!list) return;
    const idx = list.indexOf(dispose);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) pluginEventCleanups.delete(pluginId);
  };
  let list = pluginEventCleanups.get(pluginId);
  if (!list) {
    list = [];
    pluginEventCleanups.set(pluginId, list);
  }
  list.push(dispose);
  return dispose;
}

/**
 * Run one agent MCP tool the way {@link AgentMcpToolInvoker} promises: a sync
 * throw and a sync return both become a promise, and the promise rejects the
 * moment `signal` aborts even if `execute` never looks at it — a plugin that
 * ignores its signal must not be able to hold a call open past its budget.
 * Called as a method on the plugin's own definition so an `execute` written
 * with `this` behaves as it would in the worker, where it is called that way.
 */
function runAgentMcpTool(
  definition: PluginMcpToolDefinition,
  execute: PluginMcpToolDefinition["execute"],
  args: Record<string, unknown>,
  caller: PluginMcpCaller,
  signal: AbortSignal
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortErrorFor(signal));
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = (): void => reject(abortErrorFor(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    const detach = (): void => signal.removeEventListener("abort", onAbort);
    let result: unknown;
    try {
      result = Reflect.apply(execute, definition, [args, caller, signal]);
    } catch (err) {
      detach();
      reject(err);
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        detach();
        resolve(value);
      },
      (err: unknown) => {
        detach();
        reject(err);
      }
    );
  });
}

/**
 * Build one plugin's host object.
 *
 * `binding` names the project this host acts for and is captured here, once —
 * every closure below reads the captured values, never the focused project
 * view, so "which project?" is answered at construction rather than at call
 * time. An unbound binding (`projectId: null`) is the app-global default for
 * installed and builtin plugins and leaves every surface exactly as it was.
 */
export function createHost(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  binding: PluginHostBinding
): { host: PluginHostApi; revoke: () => void } {
  let revoked = false;
  const { projectId: boundProjectId, projectRoot: boundProjectRoot } = binding;

  /**
   * The worktree set this host may see, with the reason it may see none.
   *
   * Unbound stays ambient on purpose: an app-global plugin has no project of
   * its own, so the focused window's worktrees are the only set its
   * argument-less getters can mean — which is exactly why the result names the
   * project it landed on, so a plugin can notice when focus moved under it.
   */
  const fetchWorktreeSnapshotsResult = async (): Promise<PluginWorktreeSnapshotFetchResult> => {
    if (boundProjectId === null) return deps.fetchWorktreeSnapshotsResult();
    // Bound with no root is a malformed binding. Fail closed rather than fall
    // back to the ambient read, which would hand this plugin whichever project
    // happens to be focused — the confused-deputy bug the binding exists for.
    if (boundProjectRoot === null) {
      return { status: "unavailable", reason: "project-unavailable" };
    }
    const result = await deps.fetchWorktreeSnapshotsForProjectResult(
      boundProjectId,
      boundProjectRoot
    );
    // Belt and braces on the binding, enforced here rather than in one getter so
    // every surface downstream of this read inherits it: a dependency answering
    // for another project would be the confused deputy (#11297) wearing the new
    // shape, and it must not reach `getWorktreeStatus`, the worktree
    // subscriptions or the default spawn cwd either.
    if (result.status === "ok" && result.projectId !== boundProjectId) {
      return { status: "unavailable", reason: "project-unavailable" };
    }
    return result;
  };

  /**
   * The array-shaped read the pre-#12174 surfaces still use. Every unavailable
   * reason flattens back to `[]` here, which is the fail-closed sentinel those
   * surfaces are built on: `${worktree}` and `${project}` allowlist roots drop
   * so containment denies (#9492), `getWorktreeStatus` answers `null`, and the
   * default spawn cwd falls back rather than pointing into another project.
   *
   * Not every worktree-derived surface routes through here — worktree-scoped
   * *storage* resolves its target through `resolveBoundWorktreeTarget`, which
   * reads the projected `getWorktreesResult` so it can name one worktree rather
   * than flatten the set (#12229). Unbound storage skips both and stays on the
   * manager's own app-global lookup.
   */
  const fetchWorktreeSnapshots = async (): Promise<WorktreeSnapshot[]> => {
    const result = await fetchWorktreeSnapshotsResult();
    return result.status === "ok" ? result.snapshots : [];
  };

  /**
   * Renderer push for this host: the bound project's views only.
   *
   * Unbound reaches every renderer on purpose — an app-global plugin's panels,
   * badges and toasts belong to no single project. The bound path widens to a
   * full broadcast only while no project view is registered anywhere (boot, or
   * a window that never routes through ProjectViewManager); in that state there
   * is no other project's view for it to reach.
   */
  const pushToRenderers: (channel: string, ...args: unknown[]) => void =
    boundProjectId === null
      ? broadcastToRenderer
      : (channel, ...args) => broadcastToProjectRenderers(boundProjectId, channel, ...args);

  /**
   * Does a worktree event belong to the bound project? Unbound hosts see every
   * project's events by design. Fails open when the payload carries no project
   * path: the snapshots the callback then delivers are already project-scoped,
   * so an unrecognised payload costs a redundant callback, never another
   * project's data.
   *
   * A bound-but-rootless binding is malformed and drops every event, matching
   * `fetchWorktreeSnapshots` — waking the plugin app-wide to hand it the empty
   * list that path already returns would be pure noise.
   */
  const isEventForBoundProject = (payload?: PluginWorktreeEventPayload): boolean => {
    if (boundProjectId !== null && boundProjectRoot === null) return false;
    if (boundProjectRoot === null) return true;
    const projectPath = payload?.projectPath;
    if (typeof projectPath !== "string" || projectPath.length === 0) return true;
    return isSameProjectPath(projectPath, boundProjectRoot);
  };

  /**
   * Does an agent transition belong to the bound project? Unbound hosts observe
   * every agent by design — that is what `agent:read` has always meant.
   *
   * Fails CLOSED, unlike the worktree predicate: the event carries no
   * project-scoped payload for the callback to re-derive, so delivering one we
   * cannot attribute would hand a bound plugin another project's agent state
   * outright. The routing id is read off the raw event; the plugin-facing
   * projection deliberately drops it (see `toPluginAgentSnapshot`).
   */
  /**
   * The project root a `"project"`-scoped settings or storage call targets.
   *
   * Unbound stays `null`, which both managers read as "use the app-global
   * active project" — the only thing an installed or builtin plugin can mean.
   * A bound-but-rootless binding is malformed and resolves to `""`, which they
   * reject outright: falling through to the ambient read there would hand the
   * plugin whichever project happens to be focused.
   */
  const boundScopeRoot: string | null = boundProjectId === null ? null : (boundProjectRoot ?? "");

  const isAgentEventForBoundProject = (payload: AgentStateChangePayload): boolean => {
    if (boundProjectId === null) return true;
    const terminalId = (payload as { terminalId?: unknown }).terminalId;
    if (typeof terminalId !== "string" || terminalId.length === 0) return false;
    return getPtyClient()?.getTerminalProjectId(terminalId) === boundProjectId;
  };
  // The LoadedPlugin this host is bound to. recordPluginLog compares against
  // the live instance so a stale host (post-unload, or after a same-id
  // reload) can't write into the current session's log buffer.
  const boundPlugin = deps.plugins.get(pluginId);
  // Liveness for the non-revoke-guarded runtime methods: the plugin must still
  // be loaded AND be the same instance this host was bound to. Identity (not
  // just id membership) so a stale timer from a pre-reload instance can't emit
  // into the current same-id instance's panels or read its worktrees.
  const isBound = (): boolean =>
    boundPlugin !== undefined && deps.plugins.get(pluginId) === boundPlugin;
  // Last agent-state snapshot observed for this host since it subscribed via
  // onDidChangeAgentState. The host keeps no pre-subscription history, so
  // getAgentState() returns null until the first transition is observed.
  let lastAgentSnapshot: PluginAgentSnapshot | null = null;
  /**
   * The availability- and scope-aware worktree read behind
   * {@link PluginHostApi.getWorktreesResult}, and the single source the
   * `[]`/`null`-shaped `getWorktrees` and `getActiveWorktree` project from, so
   * the three can never disagree about what this host can see (#12174).
   */
  const getWorktreesResult = async (): Promise<PluginWorktreesResult> => {
    if (!isBound()) return { status: "unavailable", reason: "plugin-unloaded" };
    try {
      const result = await fetchWorktreeSnapshotsResult();
      // Re-checked after the await: an unload (or a same-id reload) that landed
      // while the read was in flight makes these snapshots the previous
      // instance's, so they are discarded rather than handed to whatever still
      // holds this stale host.
      if (!isBound()) return { status: "unavailable", reason: "plugin-unloaded" };
      if (result.status !== "ok") return { status: "unavailable", reason: result.reason };
      // Projection is inside the boundary too: toPluginWorktreeSnapshot throws
      // on a malformed snapshot, and this method's contract is to answer with
      // data rather than reject into whatever timer called it.
      return {
        status: "ok",
        projectId: result.projectId,
        worktrees: result.snapshots.map(toPluginWorktreeSnapshot),
      };
    } catch {
      return isBound()
        ? { status: "unavailable", reason: "fetch-failed" }
        : { status: "unavailable", reason: "plugin-unloaded" };
    }
  };

  // Identity is derived once, here, from the id and binding this host was built
  // with. Deriving it host-side — through the canonical parser that owns the key
  // format — is the whole point: it is what lets a plugin stop splitting its own
  // id apart to find its manifest id or its project (#12211).
  const manifestId = pluginManifestIdFromInstanceKey(pluginId);
  // Origin comes from the KEY, not the binding. The key states what the plugin
  // *is*; the binding states which project this host acts for, and the two
  // disagreeing is a malformed binding, not a global plugin. Reading origin off
  // the binding would silently downgrade such a host to "global" and hand back
  // a dotted id that aliases a project kind onto a global one — the exact
  // collision `toRuntimePanelKindId` refuses to mint.
  const pluginInfo: PluginIdentity = Object.freeze({
    instanceId: pluginId,
    manifestId,
    origin:
      projectIdFromPluginInstanceKey(pluginId) === null
        ? ("global" as const)
        : ("project" as const),
    projectId: boundProjectId,
    projectRoot: boundProjectRoot,
  });

  /**
   * The worktree a `"worktree"`-scoped storage call targets (#12229).
   *
   * The project-root counterpart, `boundScopeRoot`, is fixed for the host's
   * lifetime; the active worktree is not — the user switches it while the host
   * stays alive — so this resolves per call rather than once at construction.
   *
   * Deliberately reads `getWorktreesResult`, the same project-filtered source
   * `getActiveWorktree` projects from, so the two agree about which worktree is
   * active at the moment either resolves. (Only at that moment: calls straddling
   * a switch see different worktrees, which is the point of resolving per call.)
   * Every unavailable reason (including a projection that threw, and an unload
   * caught by that method's own liveness re-checks) collapses to `""`, which the
   * manager rejects: for a filesystem target, failing closed beats salvaging a
   * path out of a snapshot set the binding boundary already called malformed.
   *
   * Unbound returns `undefined` so the manager keeps its app-global lookup —
   * an installed or builtin plugin has no project of its own, so the active
   * worktree is the only thing its worktree scope can mean.
   */
  const resolveBoundWorktreeTarget = async (): Promise<string | undefined> => {
    if (boundProjectId === null) return undefined;
    const result = await getWorktreesResult();
    if (result.status !== "ok") return "";
    const active = result.worktrees.find((w) => w.isCurrent)?.path;
    // The projection copies `path` straight off the workspace host's snapshot
    // without validating it, and this is the one consumer that turns it into a
    // filesystem root. A non-string would throw out of `path.join`, turning
    // `storage.get`'s documented quiet "no target" into a rejection; a relative
    // one would resolve against Electron's cwd, outside every project.
    return typeof active === "string" && path.isAbsolute(active) ? active : "";
  };

  /**
   * The target a storage call resolves against. Only `"worktree"` scope pays for
   * the project-filtered snapshot read — `"user"` and `"project"` need nothing
   * beyond the static root, and they are the hot path.
   */
  const storageTargetFor = async (scope: PluginStorageScope): Promise<ExplicitStorageTarget> =>
    scope === "worktree"
      ? { projectRoot: boundScopeRoot, worktreePath: await resolveBoundWorktreeTarget() }
      : { projectRoot: boundScopeRoot };

  const resolveDatabase = async (id: string, options?: { readonly?: boolean }) => {
    const readonly = options?.readonly === true;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Plugin "${pluginId}" db: id must be a non-empty string`);
    }
    const plugin = deps.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`PLUGIN_UNLOADED: plugin "${pluginId}" db: plugin is no longer loaded`);
    }
    const declaration = (plugin.manifest.contributes.databases ?? []).find((d) => d.id === id);
    if (!declaration) {
      throw new Error(
        `DB_NOT_DECLARED: plugin "${pluginId}" db: "${id}" is not declared in contributes.databases`
      );
    }
    // A project database is a file in the repository: creating its directory,
    // the file, and every migration are project writes, so they wait for the
    // same first-use consent `host.fs.writeFile` does. A local database is
    // plugin-private state, like `host.storage`, and needs none.
    // A read-only open creates and writes nothing, so it needs no consent.
    if (declaration.location === "project" && !readonly) {
      await ensureCapabilityConsent(deps, pluginId, "fs:project-write");
      if (!deps.plugins.has(pluginId)) {
        throw new Error(`PLUGIN_UNLOADED: plugin "${pluginId}" db: plugin is no longer loaded`);
      }
    }
    return resolvePluginDatabaseLocation({
      declaration,
      manifestId,
      projectRoot: boundProjectRoot,
      dataDir: deps.pluginDataDir(pluginId),
      existingOnly: readonly,
    });
  };

  // The live disposer per `agentMcp` endpoint, so a replaced roster is released
  // rather than kept reachable from the unload cascade for the host's lifetime.
  const mcpRosterDisposers = new Map<string, () => void>();

  const host: PluginHostApi = {
    get pluginId() {
      return pluginId;
    },
    pluginInfo,
    panelKindId: (bareId: string) => {
      if (typeof bareId !== "string" || bareId.length === 0) {
        throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
      }
      const qualified = toRuntimePanelKindId(
        { origin: pluginInfo.origin, pluginId: manifestId, kindId: bareId },
        boundProjectId
      );
      // Only reachable for a project-owned host with no project in its binding,
      // or an id carrying the `/` the qualified form delimits on. Both would
      // otherwise mint an id that resolves to no registered kind, so say so
      // rather than hand back something that silently opens nothing.
      if (qualified === null) {
        throw new Error(
          `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
        );
      }
      return qualified;
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
      const built = deps.validateAndBuildActionDescriptor(pluginId, {
        ...descriptor,
        id: namespacedId,
      });

      // Replace semantics (per host-api.md): re-registering the same id
      // overwrites the prior descriptor + handler. Evict any stale compiled
      // input schema so the next dispatch recompiles against the new
      // descriptor. Handlers are cleaned up on unload via
      // unregisterPluginActions, matching the IPC-registered action path.
      deps.pluginActions.set(namespacedId, built);
      deps.pluginActionHandlers.set(namespacedId, handler);
      deps.actionValidators.delete(namespacedId);

      let owners = deps.pluginActionOwners.get(pluginId);
      if (!owners) {
        owners = new Set();
        deps.pluginActionOwners.set(pluginId, owners);
      }
      owners.add(namespacedId);

      deps.broadcaster.broadcastPluginActions();
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
        deps.registerHandler(pluginId, channel, schemaOrHandler, typedHandler);
      } else {
        deps.registerHandler(pluginId, channel, schemaOrHandler as PluginIpcHandler);
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
      // Wrap in the per-instance envelope (panelId: null = broadcast) so the
      // preload dispatcher sees the same shape for every push over this
      // transport — broadcastToRenderer, postToPanel, and the process stream
      // share the `plugin:{pluginId}:{channel}` channel and one `plugin.on`
      // subscriber receives all three.
      pushToRenderers(`plugin:${pluginId}:${channel}`, { panelId: null, payload });
      return Promise.resolve();
    },
    // The post-activation-safe sibling of broadcastToRenderer: same
    // `plugin:{pluginId}:{channel}` transport, but NOT revoke-guarded — it is
    // called from the plugin's own timers, polls, and subscription callbacks
    // long after activate() resolves, so a plugin can stream live data into
    // its panels without the renderer degrading to invoke() polling. Liveness
    // is plugin membership (mirrors invalidateFileDecorations/showToast): once
    // the plugin unloads this silently no-ops.
    postToPanel: (channel, payload, panelId) => {
      if (!isBound()) return Promise.resolve();
      if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
        // Reject (not sync throw): this is a post-activation runtime-surface
        // method returning a Promise, so a validation error must stay inside
        // the Promise contract a plugin can `.catch()` (#10617). The liveness
        // no-op above stays a silent resolve.
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
          )
        );
      }
      // `undefined` (arg omitted) and `null` both mean broadcast; only a
      // non-empty string targets a single panel instance. An empty string is
      // an authoring mistake (it would silently match no subscriber), so
      // reject it loudly rather than coercing to broadcast.
      if (panelId !== undefined && panelId !== null) {
        if (typeof panelId !== "string" || panelId.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
          );
        }
      }
      const targetPanelId = panelId ?? null;
      pushToRenderers(`plugin:${pluginId}:${channel}`, { panelId: targetPanelId, payload });
      return Promise.resolve();
    },
    getActiveWorktree: async () => {
      const result = await getWorktreesResult();
      if (result.status !== "ok") return null;
      return result.worktrees.find((w) => w.isCurrent) ?? null;
    },
    getWorktrees: async () => {
      const result = await getWorktreesResult();
      return result.status === "ok" ? result.worktrees : [];
    },
    getWorktreesResult,
    getWorktreeStatus: async (path, options) => {
      options?.signal?.throwIfAborted();
      if (!isBound()) return null;
      if (typeof path !== "string" || path.length === 0) return null;
      const snapshots = await fetchWorktreeSnapshots();
      options?.signal?.throwIfAborted();
      if (!isBound()) return null;
      const match = snapshots.find((s) => s.path === path);
      return match ? toPluginWorktreeStatus(match.worktreeChanges) : null;
    },
    getAgentState: async () => {
      // Liveness first (mirrors getActiveWorktree/getWorktrees): once unloaded
      // the method degrades to null rather than throwing, so a plugin calling
      // it from a stray timer after unload doesn't get an unhandled rejection.
      // declaredCapabilities() also returns [] post-unload, so a capability
      // check first would mis-report PERMISSION_REQUIRED for a torn-down plugin.
      if (!isBound()) return null;
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" getAgentState requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      return lastAgentSnapshot;
    },
    sendToActiveAgent: async (text, options) => {
      // Liveness first (mirrors getAgentState): once unloaded the method
      // degrades to a no-op rather than throwing into a stray post-unload
      // timer. declaredCapabilities() also returns [] post-unload, so a
      // capability check first would mis-report PERMISSION_REQUIRED.
      if (!isBound()) return;
      if (!deps.declaredCapabilities(pluginId).has("agent:input")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" sendToActiveAgent requires "agent:input", which is not declared in manifest.capabilities`
        );
      }
      // Validate BEFORE prompting for consent so an invalid call can't bank a
      // silent grant and then inject real text unprompted (mirrors the
      // process.spawn ordering for #10524). Reject whitespace-only text too:
      // it stages to nothing but with submit:true would fire a bare Enter,
      // submitting whatever is already in the agent's input buffer — an effect
      // the consent prompt never showed the user.
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error(
          `Plugin "${pluginId}" sendToActiveAgent: text must be a non-empty, non-whitespace string`
        );
      }
      // JIT consent fires before any side effect — first use prompts the user;
      // the grant covers later calls. Throws PERMISSION_REQUIRED on denial.
      // Re-check binding after the prompt await so a racing unload doesn't
      // inject into a torn-down session.
      await ensureCapabilityConsent(deps, pluginId, "agent:input");
      if (!isBound()) return;
      const terminalId = await resolveActiveAgentTerminalId(boundProjectId);
      if (!isBound()) return;
      if (terminalId === null) {
        // Bound host with no agent of its own: stay silent rather than reach
        // for whatever agent is focused. The user consented to this plugin
        // talking to its project's agent, never to another project's.
        if (boundPlugin) {
          deps.recordPluginLog(
            boundPlugin,
            pluginId,
            "warn",
            "sendToActiveAgent: no agent terminal is available in this plugin's project"
          );
        }
        return;
      }
      const ptyClient = getPtyClient();
      if (!ptyClient) {
        throw new Error("NO_ACTIVE_AGENT: terminal host is not available");
      }
      // submit defaults to false — stage-only (no Enter) is the default-safe
      // mode per #10558. submit:true appends Enter and runs the text.
      if (options?.submit === true) {
        ptyClient.submit(terminalId, text);
      } else {
        ptyClient.stage(terminalId, text);
      }
    },
    onDidChangeActiveWorktree: (callback) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeActiveWorktree called after activate() returned or timed out`
        );
      }
      // Subscription wired synchronously (revoke guard already held above);
      // only the disposer return value is wrapped in a resolved promise.
      const dispose = deps.subscribeWorktreeEvent(pluginId, "worktree-activated", async (event) => {
        // A bound host must not wake on another project activating a worktree:
        // "active" means active within its own project, so a foreign event is
        // not a change it can observe at all.
        if (!isEventForBoundProject(event)) return;
        if (!deps.plugins.has(pluginId)) return;
        try {
          const snapshots = await fetchWorktreeSnapshots();
          // Re-check after the async fetch so a racing unloadPlugin()
          // doesn't fire the callback into a disposed plugin closure.
          if (!deps.plugins.has(pluginId)) return;
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
        if (!deps.plugins.has(pluginId)) return;
        try {
          const snapshots = await fetchWorktreeSnapshots();
          if (!deps.plugins.has(pluginId)) return;
          callback(snapshots.map(toPluginWorktreeSnapshot));
        } catch (err) {
          console.error(
            `[PluginService] onDidChangeWorktrees callback for "${pluginId}" failed:`,
            err
          );
        }
      };
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      // A foreign project's churn is dropped before the debounce timer is even
      // armed, so a bound host's trailing callback can't be pushed out
      // indefinitely by worktree traffic in a project it cannot see.
      const emit =
        debounceMs > 0
          ? (event?: PluginWorktreeEventPayload): void => {
              if (!isEventForBoundProject(event)) return;
              if (debounceTimer) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void runEmit();
              }, debounceMs);
            }
          : (event?: PluginWorktreeEventPayload): void => {
              if (!isEventForBoundProject(event)) return;
              void runEmit();
            };
      // Fires on both add/update and remove so plugins' cached lists stay
      // correct after deletions. Each subscription is tracked separately
      // so a single disposer stops both. A shared debounce timer coalesces
      // bursts that span both event kinds.
      const disposeUpdate = deps.subscribeWorktreeEvent(pluginId, "worktree-update", emit);
      const disposeRemove = deps.subscribeWorktreeEvent(pluginId, "worktree-removed", emit);
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
    onDidChangeAgentState: (callback) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeAgentState called after activate() returned or timed out`
        );
      }
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" onDidChangeAgentState requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      // The agent:state-changed bus is a synchronous module-level singleton
      // (unlike WorkspaceClient), so we subscribe directly — no deferred
      // replay queue is needed. The handler caches the latest snapshot so
      // getAgentState() can serve it without re-deriving state.
      const failures = createListenerFailureState();
      const handler = (payload: AgentStateChangePayload): void => {
        if (!isAgentEventForBoundProject(payload)) return;
        if (!deps.plugins.has(pluginId)) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangeAgentState",
          () => {
            const snapshot = toPluginAgentSnapshot(payload);
            lastAgentSnapshot = snapshot;
            return callback(snapshot);
          },
          () => dispose()
        );
      };
      const unsub = events.on("agent:state-changed", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => unsub());
      return Promise.resolve(dispose);
    },
    onDidChangePanelLifecycle: (callback) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangePanelLifecycle called after activate() returned or timed out`
        );
      }
      // No capability gate: the broker resolves panel ownership from main's own
      // kind registry, so a plugin can only ever be handed events for panel
      // instances of kinds it contributed itself (#11301).
      const failures = createListenerFailureState();
      // Teardown lives in a holder rather than a closed-over binding because,
      // unlike every other subscription here, `subscribe` REPLAYS synchronously
      // — `handler` can run before the disposer below exists. A replayed event
      // that exhausts the failure budget would otherwise touch that binding in
      // its temporal dead zone and throw ReferenceError instead of quarantining
      // the listener.
      const teardown: { dispose?: () => void; unsub?: () => void } = {};
      const handler = (event: PluginPanelLifecycleEvent): void => {
        // Runtime delivery is membership-gated, never revoke-gated (#5596):
        // these events fire for the plugin's whole life, long after activate()
        // returned, and must fall silent once it unloads.
        if (!deps.plugins.has(pluginId)) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangePanelLifecycle",
          () => callback(event),
          () => {
            // Mid-replay the tracked disposer does not exist yet, so fall back
            // to unsubscribing directly.
            if (teardown.dispose) teardown.dispose();
            else teardown.unsub?.();
          }
        );
      };
      // `subscribe` replays live panels synchronously, so a plugin activated BY
      // a view opening still sees that panel's `mounted` phase.
      teardown.unsub = deps.panelLifecycleBroker.subscribe(pluginId, handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        teardown.unsub?.()
      );
      teardown.dispose = dispose;
      return Promise.resolve(dispose);
    },
    onDidWake: (callback) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidWake called after activate() returned or timed out`
        );
      }
      // No capability gate: the payload is the machine's own suspend/resume
      // timing and nothing else — no workspace, user, or cross-plugin data. It
      // is also strictly less than every renderer window already receives
      // unconditionally on the same wake (#12175).
      const failures = createListenerFailureState();
      const handler = (payload: { sleepDuration: number; timestamp: number }): void => {
        // Deliberately NOT filtered by the host's project binding, unlike
        // `onDidChangeAgentState`: a wake is machine-scoped, so every loaded
        // instance of the plugin must hear it, including one bound to a project
        // whose window is not focused — which is exactly the stale-state case
        // this event exists for.
        if (!deps.plugins.has(pluginId)) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidWake",
          () =>
            callback(
              Object.freeze({
                sleepDuration: payload.sleepDuration,
                timestamp: payload.timestamp,
              })
            ),
          () => dispose()
        );
      };
      // No replay on subscribe: a wake is a one-shot pulse with no resting
      // state to hand a late subscriber.
      const unsub = events.on("sys:wake", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => unsub());
      return Promise.resolve(dispose);
    },
    registerForgeProvider: (descriptor, impl) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerForgeProvider called after activate() returned or timed out`
        );
      }
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error(`Plugin "${pluginId}" registerForgeProvider: descriptor must be an object`);
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
      const plugin = deps.plugins.get(pluginId);
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

      // Pass `impl` so a stale disposer (from a prior re-bind that was
      // overwritten via a second registerForgeProvider call on the same
      // id) cannot remove the currently-active impl by mistake — the
      // registry compares identities before deleting.
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        unregisterForgeProviderImpl(pluginId, contributionId, impl)
      );
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
      const plugin = deps.plugins.get(pluginId);
      const declared = plugin?.manifest.contributes.fileDecorationProviders.some(
        (c) => c.id === contributionId
      );
      if (!declared) {
        throw new Error(
          `Plugin "${pluginId}" registerFileDecorationProvider: descriptor.id "${contributionId}" is not declared in contributes.fileDecorationProviders`
        );
      }

      registerFileDecorationProviderImpl(pluginId, contributionId, impl);

      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        unregisterFileDecorationProviderImpl(pluginId, contributionId, impl)
      );
      return Promise.resolve(dispose);
    },
    mcp: {
      registerTools: (endpointId, tools) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: mcp.registerTools called after activate() returned or timed out`
          );
        }
        if (!deps.declaredCapabilities(pluginId).has("mcp:expose")) {
          throw new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" mcp.registerTools requires "mcp:expose", which is not declared in manifest.capabilities`
          );
        }
        if (typeof endpointId !== "string" || endpointId.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" mcp.registerTools: endpointId must be a non-empty string`
          );
        }
        // Same reason as forge and decoration providers: per-project enablement,
        // grants and the route are all driven by the manifest's declarations, so
        // a roster for an undeclared endpoint could never be reached — reject it
        // rather than hold an orphan.
        const declared = deps.plugins
          .get(pluginId)
          ?.manifest.contributes.agentMcp?.some((endpoint) => endpoint.id === endpointId);
        if (!declared) {
          throw new Error(
            `Plugin "${pluginId}" mcp.registerTools: endpoint "${endpointId}" is not declared in contributes.agentMcp`
          );
        }
        let descriptors: ReturnType<typeof validateAgentMcpTools>;
        try {
          descriptors = validateAgentMcpTools(tools);
        } catch (err) {
          throw new Error(
            `Plugin "${pluginId}" mcp.registerTools("${endpointId}"): ${formatErrorMessage(err, "invalid tool roster")}`,
            { cause: err }
          );
        }
        // Capture each definition and its `execute` now. The registry advertises
        // the validated snapshot, so dispatch must run exactly those tools too —
        // not whatever the plugin's roster object holds by the time a call lands.
        const roster = tools as Record<string, PluginMcpToolDefinition>;
        const executors = new Map<
          string,
          { definition: PluginMcpToolDefinition; execute: PluginMcpToolDefinition["execute"] }
        >();
        for (const { name } of descriptors) {
          const definition = roster[name];
          executors.set(name, { definition, execute: definition.execute });
        }
        const invoke: AgentMcpToolInvoker = (toolName, args, caller, signal) => {
          // A route that looked the roster up before an unload landed may still
          // call through it; the instance it belonged to is gone, so refuse.
          if (!isBound()) {
            return Promise.reject(new Error(`Plugin "${pluginId}" is not loaded`));
          }
          const entry = executors.get(toolName);
          if (!entry) {
            return Promise.reject(
              new Error(`Plugin "${pluginId}" endpoint "${endpointId}" has no tool "${toolName}"`)
            );
          }
          return runAgentMcpTool(entry.definition, entry.execute, args, caller, signal);
        };
        const unregister = agentMcpEndpointRegistry.register({
          pluginInstanceId: pluginId,
          endpointId,
          tools: descriptors,
          invoke,
        });
        const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
          unregister();
          if (mcpRosterDisposers.get(endpointId) === dispose) mcpRosterDisposers.delete(endpointId);
        });
        // Released after the replacement is bound. The registry's disposer is
        // identity-guarded, so this drops the old roster's tracking and closures
        // without the endpoint ever going empty in between.
        const prior = mcpRosterDisposers.get(endpointId);
        mcpRosterDisposers.set(endpointId, dispose);
        prior?.();
        return Promise.resolve(dispose);
      },
    },
    // NOT revoke-guarded: called from the plugin's own post-activation
    // subscription callbacks (worktree changes, polling timers). The
    // liveness guard is plugin membership, not the activation window — once
    // the plugin unloads this becomes a silent no-op.
    invalidateFileDecorations: (scope, paths) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof scope !== "string" || scope.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope must be a non-empty string`
          )
        );
      }
      // A plugin may only invalidate scopes it actually declared in
      // `contributes.fileDecorationProviders`. Without this a plugin could
      // force unrelated renderer views to re-pull. Mirrors the
      // registration-time declared-id guard so the manifest stays the
      // single source of truth for what a plugin owns.
      const declaredScopes = deps.plugins
        .get(pluginId)
        ?.manifest.contributes.fileDecorationProviders.flatMap((c) => c.scopes);
      if (
        !declaredScopes ||
        !declaredScopes.some((pattern) => scopeMatchesPattern(scope, pattern))
      ) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope "${scope}" is not covered by any declared contributes.fileDecorationProviders[].scopes`
          )
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
      pushToRenderers(CHANNELS.EVENTS_PUSH, {
        name: "plugin:decorations-changed",
        payload: { scope, ...(narrowed && narrowed.length > 0 ? { paths: narrowed } : {}) },
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded for the same reason as invalidateFileDecorations:
    // plugins set badges from post-activation worktree/agent subscription
    // callbacks. Liveness is plugin membership, so it no-ops once unloaded
    // (unloadPlugin clears the plugin's whole badge set).
    setPanelBadge: (panelId, badge) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof panelId !== "string" || panelId.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelBadge: panelId must be a non-empty string`)
        );
      }
      let validated: PluginPanelBadge | null = null;
      if (badge !== null && badge !== undefined) {
        const parsed = PluginPanelBadgeSchema.safeParse(badge);
        if (!parsed.success) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelBadge: invalid badge — ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`
            )
          );
        }
        validated = parsed.data;
      }
      let panelMap = deps.pluginBadges.get(pluginId);
      if (validated === null) {
        // Clear: drop just this panel's badge; prune the plugin's map when empty.
        if (!panelMap || !panelMap.has(panelId)) return Promise.resolve();
        panelMap.delete(panelId);
        if (panelMap.size === 0) deps.pluginBadges.delete(pluginId);
      } else {
        if (!panelMap) {
          panelMap = new Map<string, PluginPanelBadge>();
          deps.pluginBadges.set(pluginId, panelMap);
        }
        panelMap.set(panelId, validated);
      }
      pushToRenderers(CHANNELS.EVENTS_PUSH, {
        name: "plugin:panel-badges-changed",
        payload: { pluginId, badges: deps.serializePluginBadges(pluginId) },
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded: a worker reloads a view when its own work finishes,
    // long after activate() returned. No capability gate — the target must be
    // a panel of a kind this exact instance contributed, which the broker
    // resolves from main's kind registry; the caller is identified by this
    // closure's `pluginId`, never by an argument (#12610).
    reloadPanel: async (panelId) => {
      if (typeof panelId !== "string" || panelId.trim().length === 0) {
        throw new Error(`Plugin "${pluginId}" reloadPanel: panelId must be a non-empty string`);
      }
      if (!isBound()) return "unavailable";
      return deps.panelReloadDispatcher.reload(pluginId, panelId, boundProjectId);
    },
    // NOT revoke-guarded for the same reason as invalidateFileDecorations:
    // plugins fire toasts from post-activation callbacks and timers. Liveness
    // is plugin membership, so it no-ops silently once the plugin unloads.
    showToast: async (options) => {
      if (!deps.plugins.has(pluginId)) return;
      const parsed = PluginToastOptionsSchema.safeParse(options);
      if (!parsed.success) {
        throw new Error(
          `Plugin "${pluginId}" showToast: invalid options — ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        );
      }
      // Provenance: prefix the message with the plugin's name so users can see
      // which plugin raised the toast. Resolved host-side from the pluginId
      // bound to this closure at activation, so it still cannot be spoofed —
      // but it prints the manifest's display name rather than the raw id,
      // which for a project-owned plugin is an instance key no user should be
      // shown (#12211).
      //
      // rateLimitKey keeps the raw id: it is a bucket key, never rendered, and
      // two plugins may legitimately share a display name. It scopes the
      // rate-limit bucket per plugin+type — without it plugin toasts fall into
      // the global type-keyed bucket and a burst of unrelated system toasts
      // could silently suppress a plugin's toast.
      pushToRenderers(CHANNELS.NOTIFICATION_SHOW_TOAST, {
        type: parsed.data.type,
        message: `${deps.pluginDisplayName(pluginId)}: ${parsed.data.message}`,
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
      if (!deps.plugins.has(pluginId)) {
        return {
          ok: false,
          error: {
            code: "PLUGIN_UNLOADED",
            message: `Plugin "${pluginId}" is no longer loaded`,
          },
        };
      }
      // A bound dispatch reaches only its own project's renderer and rejects
      // with PROJECT_VIEW_UNAVAILABLE when that project has no live view;
      // unbound stays ambient, since an app-global plugin's action belongs
      // wherever the user is looking.
      return deps.dispatcher.sendDispatchToRenderer(actionId, args, boundProjectId);
    },
    // Built-in action catalog (#10561). NOT revoke-guarded for the same reason
    // as dispatch: plugins introspect from post-activation callbacks/timers.
    // Once the plugin unloads these degrade to empty/absent results ([] / null
    // / "restricted") without a renderer round-trip. The renderer projects
    // ActionService.list()/get() — which already filter danger:"restricted" —
    // to the slim PluginActionManifestEntry, so the catalog never exposes a
    // restricted action.
    actions: {
      list: async () => {
        if (!deps.plugins.has(pluginId)) return [];
        try {
          return await deps.dispatcher.sendActionsListToRenderer(boundProjectId);
        } catch (err) {
          // A bound host whose project has no live view is the catalog's
          // documented "no renderer available" case, not an error — this
          // surface never throws, and the worker proxy already collapses a
          // failure here into the same empty answer.
          if (isProjectViewUnavailable(err)) return [];
          throw err;
        }
      },
      get: async (actionId) => {
        if (!deps.plugins.has(pluginId)) return null;
        try {
          return await deps.dispatcher.sendActionsGetToRenderer(actionId, boundProjectId);
        } catch (err) {
          if (isProjectViewUnavailable(err)) return null;
          throw err;
        }
      },
      // canDispatch derives locally from get() — no extra round-trip. A null
      // entry (unknown id, or a restricted action the renderer projects away)
      // maps to "restricted"; "confirm" actions surface as "confirm" so a
      // plugin can warn before dispatch() returns CONFIRMATION_REQUIRED.
      canDispatch: async (actionId) => {
        if (!deps.plugins.has(pluginId)) return "restricted";
        const entry = await deps.dispatcher
          .sendActionsGetToRenderer(actionId, boundProjectId)
          .catch((err: unknown) => {
            if (isProjectViewUnavailable(err)) return null;
            throw err;
          });
        if (!entry) return "restricted";
        if (entry.danger === "confirm") return "confirm";
        // Fail closed: only an explicit "safe" entry is dispatchable without a
        // prompt. Any other danger (including an unexpected value) → restricted.
        if (entry.danger === "safe") return "ok";
        return "restricted";
      },
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
      options?: PluginQuickPickOptions,
      callOptions?: PluginHostCallOptions
    ): Promise<PluginQuickPickItem | PluginQuickPickItem[] | undefined> => {
      if (!deps.plugins.has(pluginId)) return undefined;
      const validItems = validateQuickPickItems(pluginId, items);
      // Bound: the prompt lands in the owning project's view even when it is
      // not the visible one, so the user finds it on switching back, and
      // rejects when that project has no view at all. Unbound is deliberately
      // ambient — an app-global plugin's prompt belongs in front of whoever is
      // looking.
      const value = await deps.promptDispatcher.requestPrompt(
        pluginId,
        {
          kind: "quickPick",
          items: validItems,
          options: sanitizeQuickPickOptions(options),
        },
        boundProjectId,
        callOptions?.signal
      );
      return value as PluginQuickPickItem | PluginQuickPickItem[] | undefined;
    }) as PluginHostApi["showQuickPick"],
    showInputBox: async (options, callOptions) => {
      if (!deps.plugins.has(pluginId)) return undefined;
      const value = await deps.promptDispatcher.requestPrompt(
        pluginId,
        { kind: "inputBox", options: sanitizeInputBoxOptions(options) },
        boundProjectId,
        callOptions?.signal
      );
      return value as string | undefined;
    },
    showConfirm: async (options, callOptions) => {
      if (!deps.plugins.has(pluginId)) return false;
      if (!options || typeof options !== "object" || typeof options.title !== "string") {
        throw new Error(`Plugin "${pluginId}" showConfirm: options.title must be a string`);
      }
      const value = await deps.promptDispatcher.requestPrompt(
        pluginId,
        { kind: "confirm", options: sanitizeConfirmOptions(options) },
        boundProjectId,
        callOptions?.signal
      );
      return value === true;
    },
    // NOT revoke-guarded for the same reason as showToast/dispatch: plugins
    // log from post-activation callbacks and timers. Liveness is plugin
    // membership (enforced inside recordPluginLog) — writes silently no-op
    // once the plugin unloads. Synchronous void return; never throws.
    logger: {
      info: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "info", message, fields);
      },
      warn: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "warn", message, fields);
      },
      error: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "error", message, fields);
      },
    },
    // Managed child-process surface (#9234). NOT revoke-guarded — a process
    // orchestrator spawns/respawns from post-activation timers and callbacks.
    // `spawn` is the first runtime enforcement of a scope capability: it
    // rejects unless the plugin declared `shell:exec` (mirrors the channel
    // capability gate at the dispatch boundary). Liveness is plugin membership
    // — once the plugin unloads `spawn` rejects and outstanding processes are
    // torn down by `killAll` in unloadPlugin.
    process: buildProcessApi(deps, pluginId, fetchWorktreeSnapshots),
    // Host-mediated, scope-contained filesystem + git surfaces (fs-API
    // containment unit). NOT revoke-guarded — plugins read/write from
    // post-activation timers and callbacks. Every path argument is realpath-
    // contained to the declared scopes.fs.allowedPaths and capability-gated;
    // this is the runtime enforcement of allowedPaths (formerly advisory).
    fs: buildFsApi(deps, pluginId),
    git: buildGitApi(deps, pluginId),
    // Host-mediated OS clipboard surface backing the clipboard:read /
    // clipboard:write tokens. Runs in the main process (Electron's clipboard
    // module is unavailable in the dev-worker utility process), so it works
    // from a headless plugin with no mounted panel. NOT revoke-guarded —
    // liveness is plugin membership; once unloaded every method rejects.
    clipboard: buildClipboardApi(deps, pluginId),
    // Host-mediated open/reveal, scoped to the plugin's own declared fs roots
    // (including its implicit plugin-data namespace) rather than the user's
    // project roots — the gap that pushed plugins into shelling out to
    // /usr/bin/open. NOT revoke-guarded, same as fs/clipboard.
    system: buildSystemApi(deps, pluginId),
    // NOT revoke-guarded: plugins read/write settings throughout their
    // lifetime (IPC handlers, timers), long after activate() resolves. The
    // store is the source of truth, so a late call is harmless.
    settings: {
      get: async <T = unknown>(
        key: string,
        scope?: PluginSettingsScope
      ): Promise<T | undefined> => {
        assertSettingsKey(pluginId, "get", key);
        // Resolve the manifest-declared scope so a read targets the same scope
        // the write path enforces — otherwise a `scope: "project"` key read
        // with no scope arg silently reads the wrong ("user") store (#10586).
        const declaredScope = deps.settings.getDeclaredScope(pluginId, key);
        if (scope !== undefined && declaredScope !== undefined && declaredScope !== scope) {
          throw new Error(
            `Plugin "${pluginId}" settings.get: key "${key}" is declared in "${declaredScope}" scope, not "${scope}"`
          );
        }
        const effectiveScope = declaredScope ?? scope ?? "user";
        const filePath = deps.settings.resolveSettingsFilePathForKey(
          pluginId,
          key,
          effectiveScope,
          boundScopeRoot
        );
        // Project scope with no active project: read resolves to undefined
        // rather than throwing, matching the "unset key" return.
        if (!filePath) return undefined;
        return deps.settings
          .getOrCreateSettingsStore(pluginId, filePath)
          .get<T>(key, { secret: deps.settings.isSecretKey(pluginId, key) });
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
        deps.settings.assertSettingSerializable(pluginId, key, value);
        deps.settings.assertSettingDeclared(pluginId, key, scope);
        const filePath = deps.settings.resolveSettingsFilePathForKey(
          pluginId,
          key,
          scope,
          boundScopeRoot
        );
        if (!filePath) {
          throw new Error(
            `Plugin "${pluginId}" settings.set: no active project — "project" scope has no target`
          );
        }
        const store = deps.settings.getOrCreateSettingsStore(pluginId, filePath);
        const changed = await store.set(key, value, {
          secret: deps.settings.isSecretKey(pluginId, key),
        });
        if (changed) deps.settings.notifySettingsSubscribers(pluginId, scope, key, value);
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
          throw new Error(`Plugin "${pluginId}" settings.onDidChange: callback must be a function`);
        }
        deps.settings.assertSettingScope(pluginId, key, scope);
        const sub = { key, scope, cb: callback as (value: unknown) => void };
        deps.settings.addSubscriber(pluginId, sub);

        const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
          deps.settings.removeSubscriber(pluginId, sub)
        );
        return Promise.resolve(dispose);
      },
    },
    // Private machine-owned key/value storage (#10556). NOT revoke-guarded
    // (except onDidChange): plugins read/write storage throughout their
    // lifetime. The "worktree"/"project" scopes resolve their target
    // asynchronously, so set/delete re-check liveness after the await — a
    // plugin unloaded mid-resolution silently no-ops rather than writing into
    // a torn-down plugin's file (lessons #9322/#9428/#9533).
    db: {
      resolve: (id: string, options?: { readonly?: boolean }) => resolveDatabase(id, options),
      open: async (id, options) => {
        const mode = { readonly: options?.readonly === true };
        const location = await resolveDatabase(id, mode);
        let untrack: (() => void) | null = null;
        const database = await openPluginDatabase(location, {
          ...options,
          revalidate: () => resolveDatabase(id, mode),
          onClosed: () => untrack?.(),
        });
        if (!deps.plugins.has(pluginId)) {
          await database.close();
          throw new Error(
            `PLUGIN_UNLOADED: plugin "${pluginId}" db.open: plugin is no longer loaded`
          );
        }
        untrack = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
          void database.close();
        });
        return database;
      },
    },
    storage: {
      get: async <T = unknown>(
        key: string,
        scope: PluginStorageScope = "user"
      ): Promise<T | undefined> => {
        assertStorageKey(pluginId, "get", key);
        const filePath = await deps.storage.resolveStorageFilePath(
          pluginId,
          scope,
          await storageTargetFor(scope)
        );
        // No active project/worktree (or unset key): read resolves to undefined
        // rather than throwing, matching the "unset key" return.
        if (!filePath || !isBound()) return undefined;
        return deps.storage.getOrCreateStorageStore(pluginId, scope, filePath).get<T>(key);
      },
      set: async <T = unknown>(
        key: string,
        value: T,
        scope: PluginStorageScope = "user"
      ): Promise<void> => {
        assertStorageKey(pluginId, "set", key);
        if (value === undefined) {
          throw new Error(
            `Plugin "${pluginId}" storage.set: value for "${key}" is undefined — storage cannot store undefined`
          );
        }
        deps.storage.assertStorageSerializable(pluginId, key, value);
        const filePath = await deps.storage.resolveStorageFilePath(
          pluginId,
          scope,
          await storageTargetFor(scope)
        );
        // Re-check liveness after the async resolve so a racing unloadPlugin()
        // doesn't write into a torn-down plugin's storage file.
        if (!isBound()) return;
        if (!filePath) {
          throw new Error(
            `Plugin "${pluginId}" storage.set: no active ${scope} — "${scope}" scope has no target`
          );
        }
        const store = deps.storage.getOrCreateStorageStore(pluginId, scope, filePath);
        const changed = await store.set(key, value);
        if (changed) deps.storage.notifyStorageSubscribers(pluginId, scope, key, value);
      },
      delete: async (key: string, scope: PluginStorageScope = "user"): Promise<void> => {
        assertStorageKey(pluginId, "delete", key);
        const filePath = await deps.storage.resolveStorageFilePath(
          pluginId,
          scope,
          await storageTargetFor(scope)
        );
        // Missing target or unloaded plugin: a delete is a no-op rather than a
        // throw (matching the "already absent" return of the store).
        if (!filePath || !isBound()) return;
        const store = deps.storage.getOrCreateStorageStore(pluginId, scope, filePath);
        const changed = await store.delete(key);
        if (changed) deps.storage.notifyStorageSubscribers(pluginId, scope, key, undefined);
      },
      onDidChange: <T = unknown>(
        key: string,
        callback: (value: T | undefined) => void,
        scope: PluginStorageScope = "user"
      ): Promise<() => void> => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: storage.onDidChange called after activate() returned or timed out`
          );
        }
        assertStorageKey(pluginId, "onDidChange", key);
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" storage.onDidChange: callback must be a function`);
        }
        const sub = { key, scope, cb: callback as (value: unknown) => void };
        deps.storage.addSubscriber(pluginId, sub);

        const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
          deps.storage.removeSubscriber(pluginId, sub)
        );
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
 * Build the `host.process` surface for one plugin. `spawn` is gated on the
 * declared `shell:exec` capability — the first runtime enforcement of a scope
 * capability, mirroring how the typed-channel `requires` gate reads
 * `manifest.capabilities`. A plugin without it is rejected with a
 * `PERMISSION_REQUIRED:` prefix (the same prefix `useHostChannel` already
 * discriminates on).
 */
function buildProcessApi(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  fetchWorktreeSnapshots: () => Promise<WorktreeSnapshot[]>
): PluginProcessApi {
  const spawn = async (
    command: string,
    options?:
      PluginProcessSpawnOptions | PluginDuplexProcessSpawnOptions | PluginPtyProcessSpawnOptions
  ): Promise<PluginProcessHandle | PluginDuplexProcessHandle | PluginPtyProcessHandle> => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }
    const declared = new Set<BuiltInPluginCapability>(
      deps.plugins.get(pluginId)?.manifest.capabilities ?? []
    );
    if (!declared.has("shell:exec")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" process.spawn requires the "shell:exec" capability, which is not declared in manifest.capabilities`
      );
    }
    // Validate inputs BEFORE prompting for consent so a call that would fail
    // anyway never spends — or banks — a user grant. A plugin must not be able
    // to harvest a silent shell:exec grant via a deliberately invalid call
    // (e.g. spawn("")) and then execute real commands unprompted (#10524).
    if (typeof command !== "string" || command.length === 0) {
      throw new Error(`Plugin "${pluginId}" process.spawn: command must be a non-empty string`);
    }
    const rawMode: unknown = options?.mode;
    if (rawMode !== undefined && rawMode !== "pipe" && rawMode !== "duplex" && rawMode !== "pty") {
      throw new Error(
        `Plugin "${pluginId}" process.spawn: mode must be "pipe", "duplex", or "pty": ${String(rawMode)}`
      );
    }
    const mode: PluginProcessMode =
      rawMode === "pty" ? "pty" : rawMode === "duplex" ? "duplex" : "pipe";
    // `undefined` and `null` both mean broadcast, matching postToPanel. An empty
    // string is an authoring mistake — it would silently match no subscriber —
    // so reject it loudly rather than coercing.
    const rawPanelId: unknown = options?.panelId;
    if (rawPanelId !== undefined && rawPanelId !== null) {
      if (typeof rawPanelId !== "string" || rawPanelId.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" process.spawn: panelId must be a non-empty string, null, or undefined: ${String(rawPanelId)}`
        );
      }
    }
    const panelId = typeof rawPanelId === "string" ? rawPanelId : null;
    let cols = PLUGIN_PTY_DEFAULT_COLS;
    let rows = PLUGIN_PTY_DEFAULT_ROWS;
    if (mode === "pty") {
      const ptyOptions = options as PluginPtyProcessSpawnOptions;
      cols = resolvePtyDimension(pluginId, "cols", ptyOptions.cols, PLUGIN_PTY_DEFAULT_COLS);
      rows = resolvePtyDimension(pluginId, "rows", ptyOptions.rows, PLUGIN_PTY_DEFAULT_ROWS);
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
    let cwd = typeof options?.cwd === "string" && options.cwd.length > 0 ? options.cwd : undefined;
    if (cwd === undefined) {
      const active = await fetchWorktreeSnapshots();
      cwd = active.find((s) => s.isCurrent === true)?.path;
    }
    // Re-check membership after the async cwd resolution so a racing unload
    // doesn't spawn into a disposed plugin.
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }
    // JIT consent fires LAST, right before the spawn — first use prompts the
    // user; the grant covers every later spawn by this plugin. Throws
    // PERMISSION_REQUIRED on denial. Re-check membership after the prompt await.
    await ensureCapabilityConsent(deps, pluginId, "shell:exec");
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }

    const handle = await deps
      .getProcessManager()
      .spawn(
        pluginId,
        mode === "pty"
          ? { mode, command, args, cwd, env, panelId, cols, rows }
          : { mode, command, args, cwd, env, panelId }
      );
    // Interactive allocation is asynchronous (it round-trips to the pty-host), so
    // an unload can land while it is in flight. Kill rather than hand back a
    // live process the unload teardown already walked past.
    if (!deps.plugins.has(pluginId)) {
      handle.kill();
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }
    const base: PluginProcessHandle = {
      get id() {
        return handle.id;
      },
      // Gate lifecycle control on membership so a stale handle retained by a
      // leaked timer can't kill or respawn a process after the plugin unloads
      // (killManagedProcesses already tore the live children down on unload).
      kill: () => {
        if (!deps.plugins.has(pluginId)) return;
        handle.kill();
      },
      restart: () => {
        if (!deps.plugins.has(pluginId)) return Promise.resolve();
        return handle.restart();
      },
      onExit: (cb) => handle.onExit(cb),
      onCrash: (cb) => handle.onCrash(cb),
      onData: (cb) => handle.onData(cb),
    };
    if (mode === "pipe") return base;
    // Both writable modes get `write`; only a PTY additionally gets `resize`.
    // Membership-gated like kill/restart so a handle retained by a leaked timer
    // can't drive a child after the plugin unloads.
    const writable: PluginDuplexProcessHandle = {
      ...base,
      get id() {
        return handle.id;
      },
      write: (data) => {
        if (!deps.plugins.has(pluginId) || typeof data !== "string") return;
        handle.write(data);
      },
    };
    if (mode === "duplex") return writable;
    return {
      ...writable,
      get id() {
        return handle.id;
      },
      resize: (nextCols, nextRows) => {
        if (!deps.plugins.has(pluginId)) return;
        handle.resize(nextCols, nextRows);
      },
    } satisfies PluginPtyProcessHandle;
  };
  return { spawn } as PluginProcessApi;
}

/**
 * Validate one PTY dimension. Omitted falls back to the default; a value that is
 * present but not a positive integer is an authoring mistake worth rejecting
 * before the JIT consent prompt, so a bad call never spends a user grant.
 */
function resolvePtyDimension(
  pluginId: string,
  name: "cols" | "rows",
  value: unknown,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Plugin "${pluginId}" process.spawn: ${name} must be a positive integer: ${String(value)}`
    );
  }
  return value;
}

/**
 * Just-in-time consent gate for a high-risk host capability (#10524).
 * Resolves silently for built-in (first-party) plugins and for capabilities
 * the user has already granted; otherwise raises a first-use prompt and
 * throws a `PERMISSION_REQUIRED:` error on denial. Callers invoke this AFTER
 * the static `manifest.capabilities` check passes, at the top of each gated
 * host API closure — the static check answers "may this plugin ever do X",
 * this answers "has the user agreed to it doing X now".
 */
async function ensureCapabilityConsent(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  capability: BuiltInPluginCapability
): Promise<void> {
  const plugin = deps.plugins.get(pluginId);
  // Membership is re-checked by the caller after this await; a missing plugin
  // here means it unloaded mid-call, so skip the prompt and let the caller's
  // liveness guard reject.
  if (!plugin) return;
  // Built-ins are bundled first-party code — they skip the install-time
  // capability disclosure and likewise skip JIT consent.
  if (plugin.isBuiltin) return;
  const displayName = plugin.manifest.displayName ?? plugin.manifest.name;
  // The scope is taken from the instance's own binding, not from a parameter
  // and not from focus. `ensureAllowed`'s scope argument is optional, so nothing
  // in the type system would have caught omitting it — and omitting it keys
  // every grant under `"global"`, which would let one project's approval of
  // `shell:exec` answer for a different project's copy of the same plugin id.
  const scopeKey = plugin.binding?.projectId ?? "global";
  await getPluginCapabilityConsentService().ensureAllowed(
    pluginId,
    displayName,
    capability,
    plugin.manifest.capabilities ?? [],
    scopeKey
  );
}

/**
 * Resolve the terminal id of the "active agent" for `host.sendToActiveAgent`
 * (#10558). Centralised here so plugins stop reinventing `terminal.list`-based
 * selection heuristics that drift. Ranks focused/visible agent
 * (`activityTier: "active"`) first, then a `waiting` agent, then the most
 * recently active by output — with a deterministic id tiebreak. Terminals with
 * no agent or in an ended state (`exited` / `completed`, or no live PTY) are
 * excluded.
 *
 * `boundProjectId` is the host's binding. Bound: only that project's terminals
 * are eligible, and `null` comes back when it has none, so the caller can
 * no-op instead of injecting into a project the user never consented to.
 * Unbound (`null`): deliberately ambient — it scopes to whatever project the
 * PTY host last saw focused, since "the active agent" an app-global plugin
 * means is the one in front of the user, and considers all terminals only when
 * no project is active at all (e.g. before any project loads).
 *
 * @throws {Error} `NO_ACTIVE_AGENT:` when the terminal host is unavailable, or
 *   when an unbound host finds no eligible agent terminal.
 */
async function resolveActiveAgentTerminalId(boundProjectId: string | null): Promise<string | null> {
  const ptyClient = getPtyClient();
  if (!ptyClient) {
    throw new Error("NO_ACTIVE_AGENT: terminal host is not available");
  }
  const all = await ptyClient.getAllTerminalsAsync();
  type Term = (typeof all)[number];
  const eligible = (t: Term): boolean =>
    Boolean(t.detectedAgentId ?? t.launchAgentId) &&
    t.hasPty !== false &&
    t.agentState !== "exited" &&
    t.agentState !== "completed";
  // Scope to the bound project, or to the focused one; never cross into another
  // project's terminals.
  const scopeProjectId = boundProjectId ?? ptyClient.getActiveProjectId();
  const pool = scopeProjectId != null ? all.filter((t) => t.projectId === scopeProjectId) : all;
  const candidates = pool.filter(eligible);
  if (candidates.length === 0) {
    if (boundProjectId !== null) return null;
    throw new Error(
      "NO_ACTIVE_AGENT: no agent terminal is available to receive input in the current project"
    );
  }
  const score = (t: Term): number =>
    (t.activityTier === "active" ? 2 : 0) + (t.agentState === "waiting" ? 1 : 0);
  candidates.sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    const byOutput = (b.lastOutputTime ?? 0) - (a.lastOutputTime ?? 0);
    if (byOutput !== 0) return byOutput;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return candidates[0].id;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A `host.fs` target refusal (#12323). The code rides on the error object for
 * in-process callers and prefixes the message for callers behind a boundary
 * that keeps only the message.
 */
function fsTargetError(code: PluginFsWriteErrorCode, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Prove an open descriptor is the entry standing at `resolved` — not a symlink
 * swapped in after containment, and not a different file — and return its
 * stats. See {@link withVerifiedReadHandle} for why the compare is needed on
 * top of O_NOFOLLOW.
 */
async function assertHandleIsLeaf(
  pluginId: string,
  op: string,
  resolved: string,
  handle: FileHandle
): Promise<BigIntStats> {
  const [opened, entry] = await Promise.all([
    handle.stat({ bigint: true }),
    fs.lstat(resolved, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  if (entry?.isSymbolicLink()) {
    throw fsTargetError(
      "TARGET_IS_SYMLINK",
      `Plugin "${pluginId}" fs.${op}: refusing to follow a symlink at the target`
    );
  }
  if (entry === null || entry.dev !== opened.dev || entry.ino !== opened.ino) {
    throw fsTargetError(
      "TARGET_UNAVAILABLE",
      `Plugin "${pluginId}" fs.${op}: the target changed while it was being opened`
    );
  }
  return opened;
}

/**
 * Open a contained leaf for reading and prove, before a byte is read, that the
 * descriptor is the entry standing at the contained path (#12618). O_NOFOLLOW
 * refuses a leaf swapped for a symlink after containment realpathed it, but
 * only on POSIX — Windows has no such flag. So the descriptor is also compared
 * with whatever stands at the path once it is open: a symlink there, or a
 * different file, means the open may have followed something containment
 * never saw. A legitimate replace landing between the open and the compare is
 * refused too; the caller reads again.
 *
 * Ancestor directories stay out of scope, as for every other read here: the
 * open is by pathname, and O_NOFOLLOW and the compare both cover only the leaf.
 */
async function withVerifiedReadHandle<T>(
  pluginId: string,
  op: string,
  resolved: string,
  extraFlags: number,
  read: (handle: FileHandle, opened: BigIntStats) => Promise<T>
): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await fs.open(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | extraFlags
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw fsTargetError(
        "TARGET_IS_SYMLINK",
        `Plugin "${pluginId}" fs.${op}: refusing to follow a symlink at the target`
      );
    }
    throw error;
  }
  try {
    const opened = await assertHandleIsLeaf(pluginId, op, resolved, handle);
    return await read(handle, opened);
  } finally {
    // A read-only descriptor has nothing to flush, so a failed close must not
    // replace the refusal or the bytes this call is returning.
    await handle.close().catch(() => undefined);
  }
}

/**
 * Create `resolved` and every missing ancestor, one component at a time,
 * reporting each directory to `onCreated` the moment it exists — so a failure
 * further down the chain never leaves an earlier creation unaudited.
 * Containment has already proven the deepest existing ancestor is a real
 * directory inside scope; walking the missing tail with non-recursive `mkdir`
 * means a component that appears in the meantime is inspected rather than
 * silently followed — only a real directory is accepted, never a symlink to
 * one.
 *
 * The final realpath compare catches an ancestor swapped for a symlink while
 * the chain was being built. It cannot un-create what landed elsewhere, but it
 * refuses to report success for a directory that is not where containment
 * said it would be. The walk is by pathname, so the window is shrunk, not
 * closed — the same limit every host.fs write documents.
 *
 * `hostOwned` is for the plugin data dir, a path the host chose rather than a
 * contained one: it is not realpathed, so its existing ancestors may be links
 * the user made (a symlinked `~/.daintree`) and there is no realpath to
 * compare against at the end.
 */
async function createDirectoryChain(
  pluginId: string,
  op: string,
  resolved: string,
  onCreated: (dir: string) => void,
  hostOwned = false
): Promise<void> {
  const lstatOrNull = (target: string) =>
    (hostOwned ? fs.stat(target) : fs.lstat(target)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const moved = () =>
    fsTargetError(
      "TARGET_UNAVAILABLE",
      `Plugin "${pluginId}" fs.${op}: the target moved while the directory was being created`
    );

  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    const stat = await lstatOrNull(current);
    if (stat !== null) {
      if (stat.isDirectory()) break;
      if (current === resolved) {
        throw fsTargetError(
          "TARGET_EXISTS",
          `Plugin "${pluginId}" fs.${op}: something other than a directory exists at the target`
        );
      }
      throw moved();
    }
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw moved();
    current = parent;
  }
  if (missing.length === 0) return;

  for (const dir of missing.reverse()) {
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A concurrent creator is fine as long as what it made is a directory.
      const stat = await lstatOrNull(dir);
      if (stat === null || !stat.isDirectory()) throw moved();
      continue;
    }
    onCreated(dir);
  }
  if (!hostOwned && (await fs.realpath(resolved)) !== resolved) throw moved();
}

/**
 * Append `bytes` to the contained leaf through one O_APPEND descriptor,
 * creating the file when absent. O_NOFOLLOW refuses a leaf swapped for a
 * symlink on POSIX, and the descriptor is compared with the entry at the path
 * before anything is written, exactly as reads are.
 *
 * A failure after some bytes landed — including a failed close after all of
 * them were written — carries `bytesWritten` on the error so the caller can
 * audit the partial append rather than report it as nothing.
 */
async function appendToContainedFile(
  pluginId: string,
  resolved: string,
  bytes: Buffer
): Promise<void> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK (undefined on Windows): the caller already refused a
    // non-regular leaf, but a FIFO swapped in afterwards would otherwise hold
    // the open — and this path's write lock — until some reader appeared. On
    // a regular file the flag changes nothing.
    handle = await fs.open(
      resolved,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
      0o666
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw fsTargetError(
        "TARGET_IS_SYMLINK",
        `Plugin "${pluginId}" fs.appendFile: refusing to write through a symlink`
      );
    }
    throw error;
  }
  let written = 0;
  try {
    const opened = await assertHandleIsLeaf(pluginId, "appendFile", resolved, handle);
    if (!opened.isFile()) {
      throw fsTargetError(
        "TARGET_UNAVAILABLE",
        `Plugin "${pluginId}" fs.appendFile: the target is not a regular file`
      );
    }
    // A regular file takes the whole buffer in one write; the loop only
    // matters for a short write, where each O_APPEND write still lands at
    // the end but another appender can interleave between the pieces.
    try {
      while (written < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.byteLength - written);
        written += bytesWritten;
      }
    } catch (error) {
      if (written > 0 && error instanceof Error) {
        Object.assign(error, { bytesWritten: written });
      }
      throw error;
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  // Unlike a read, a failed close after a write can mean the bytes did not
  // land, so it is surfaced — with the count, since they may well have.
  try {
    await handle.close();
  } catch (error) {
    if (written > 0 && error instanceof Error) {
      Object.assign(error, { bytesWritten: written });
    }
    throw error;
  }
}

/**
 * Build the host-mediated `host.fs` surface for one plugin. Every path
 * argument is realpath-contained to the declared `scopes.fs.allowedPaths`
 * (traversal/symlink-escape rejected), and reads/writes are capability-gated
 * (`fs:*-read` / `fs:*-write`). This is the first runtime enforcement of
 * `scopes.fs.allowedPaths` — formerly advisory-only. Writes are audited.
 *
 * `workspaceScope`, when given, pins the `${project}` / `${worktree}` roots to
 * one named project and worktree for the life of the returned handle — see
 * {@link buildScopedFsApi}. Nothing else about the surface changes: it is the
 * same closures, the same gates, and the same watcher registry.
 */
function buildFsApi(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  workspaceScope?: PluginWorkspaceScope
): BuiltinPluginFsApi {
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`PLUGIN_UNLOADED: plugin "${pluginId}" fs.${op}: plugin is no longer loaded`);
    }
  };
  // Fast-fail before any filesystem work: a plugin with no fs read/write cap
  // of any class can't touch the surface at all.
  const requireAnyReadCap = (op: string): void => {
    const caps = deps.declaredCapabilities(pluginId);
    if (!caps.has("fs:project-read") && !caps.has("fs:user-data-read")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires "fs:project-read" or "fs:user-data-read", which is not declared in manifest.capabilities`
      );
    }
  };
  // Sync capability check; returns the write capability JIT consent gates on.
  // A plugin holding both prompts once on the project-write grant — the path
  // containment already bounds where the write can land, so a single fs-write
  // grant is the meaningful unit. Consent itself fires later (after input
  // validation + containment), so an invalid call never banks a grant.
  const requireWriteCap = (op: string): BuiltInPluginCapability => {
    const caps = deps.declaredCapabilities(pluginId);
    if (!caps.has("fs:project-write") && !caps.has("fs:user-data-write")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires "fs:project-write" or "fs:user-data-write", which is not declared in manifest.capabilities`
      );
    }
    return caps.has("fs:project-write") ? "fs:project-write" : "fs:user-data-write";
  };
  // Precise per-root-class gate, applied AFTER containment resolves which root
  // class the path falls under: project/worktree paths need `fs:project-*`,
  // the data dir / home paths need `fs:user-data-*`. A plugin can't reach a
  // project path with only a user-data cap (or vice versa).
  const requireReadCapForClass = (op: string, rootClass: FsRootClass): void => {
    const needed = rootClass === "project" ? "fs:project-read" : "fs:user-data-read";
    if (!deps.declaredCapabilities(pluginId).has(needed)) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires the "${needed}" capability for ${rootClass} paths, which is not declared in manifest.capabilities`
      );
    }
  };
  const requireWriteCapForClass = (op: string, rootClass: FsRootClass): void => {
    const needed = rootClass === "project" ? "fs:project-write" : "fs:user-data-write";
    if (!deps.declaredCapabilities(pluginId).has(needed)) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires the "${needed}" capability for ${rootClass} paths, which is not declared in manifest.capabilities`
      );
    }
  };
  const containWithClass = (targetPath: string) =>
    containToDeclaredRoots(deps, pluginId, targetPath, workspaceScope);
  // Every gate a mutation passes before it may touch the disk: the root-class
  // capability, containment, and JIT consent — taken exactly once, and always
  // before anything is created.
  //
  // Consent normally fires after validation + containment so a call that would
  // fail anyway never banks a grant (#10524). The implicit per-plugin data dir
  // is the exception: resolveContainedPath realpaths every root and skips ones
  // that don't exist, so a first mutation into a not-yet-created data dir must
  // create it before containment can succeed — and nothing may be created
  // before consent. There the lexical match stands in for containment until
  // the dir exists; realpath containment afterwards stays the authority.
  //
  // A data-dir target is identified from the (lexical) request path, not the
  // realpath-resolved one: on macOS the resolved path picks up the /private
  // prefix while `dataDir` does not, so comparing against `resolved` would
  // wrongly miss the match.
  const gateMutation = async (
    op: string,
    targetPath: string,
    writeCap: BuiltInPluginCapability
  ): Promise<{ resolved: string; isDataDirTarget: boolean }> => {
    const dataDir = deps.pluginDataDir(pluginId);
    const isDataDirTarget =
      path.isAbsolute(targetPath) && deps.isPathUnder(dataDir, path.normalize(targetPath));
    if (isDataDirTarget) {
      requireWriteCapForClass(op, "user-data");
      await ensureCapabilityConsent(deps, pluginId, writeCap);
      requireLoaded(op);
      await createDirectoryChain(pluginId, op, dataDir, (dir) => auditMutation("mkdir", dir), true);
    }
    const { resolved, rootClass } = await containWithClass(targetPath);
    requireLoaded(op);
    requireWriteCapForClass(op, rootClass);
    if (!isDataDirTarget) {
      await ensureCapabilityConsent(deps, pluginId, writeCap);
      requireLoaded(op);
    }
    return { resolved, isDataDirTarget };
  };
  // A nested target inside the data dir grows its parents implicitly, so a
  // plugin can lay out its own subtree; everywhere else the parent must exist.
  const createDataDirParents = async (op: string, resolved: string): Promise<void> => {
    await createDirectoryChain(pluginId, op, path.dirname(resolved), (dir) =>
      auditMutation("mkdir", dir)
    );
  };
  // Containment resolved before the consent prompt and the per-path queue
  // wait; both can take long enough for the path to change underneath, so a
  // mutation proves it again inside its critical section. A target that has
  // since left scope moved while waiting, the same as one that moved within it.
  const recheckContained = async (op: string, targetPath: string, resolved: string) => {
    const recheck = await containWithClass(targetPath).catch((error: unknown) => {
      if (error instanceof PluginPathNotAllowedError) {
        throw fsTargetError(
          "TARGET_UNAVAILABLE",
          `Plugin "${pluginId}" fs.${op}: the target moved while the write was waiting`
        );
      }
      throw error;
    });
    if (recheck.resolved !== resolved) {
      throw fsTargetError(
        "TARGET_UNAVAILABLE",
        `Plugin "${pluginId}" fs.${op}: the target moved while the write was waiting`
      );
    }
  };
  // A symlink leaf is refused: containment realpaths the leaf, so `resolved`
  // is already the link's destination and a bare lstat there sees a regular
  // file. Inspect the requested leaf itself. Every ancestor was validated by
  // containment; only the leaf can be a link the caller did not ask to write
  // through. Resolves the leaf's stats, or null when nothing stands there.
  const refuseSymlinkLeaf = async (op: string, targetPath: string) => {
    const leafStat = await fs
      .lstat(path.resolve(targetPath))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (leafStat?.isSymbolicLink()) {
      throw fsTargetError(
        "TARGET_IS_SYMLINK",
        `Plugin "${pluginId}" fs.${op}: refusing to write through a symlink`
      );
    }
    return leafStat;
  };
  const auditMutation = (op: string, resolved: string, bytes?: number): void => {
    deps.safeAppendAudit({
      pluginId,
      actionId: `fs.${op}:${resolved}`,
      recordType: "ipc-invoke",
      channel: "plugin:fs-write",
      result: "success",
      errorMessage: "",
      argsHash: deps.safeArgsHash([
        bytes === undefined ? { path: resolved } : { path: resolved, bytes },
      ]),
      durationMs: 0,
    });
  };

  return {
    readFile: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFile");
      requireAnyReadCap("readFile");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFile");
      requireReadCapForClass("readFile", rootClass);
      // The open cannot be cancelled, so an abort during containment is
      // honoured here, before a FIFO at the path could leave it pending.
      options?.signal?.throwIfAborted();
      // Deliberately no 500KB / binary cap — this is a sanctioned plugin API,
      // not the size-limited files.read preview path. The signal cancels the
      // read itself (Node honors it) as well as the boundary checks above.
      return withVerifiedReadHandle(pluginId, "readFile", resolved, 0, (handle) =>
        handle.readFile({ encoding: "utf-8", signal: options?.signal })
      );
    },
    readFileBytes: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFileBytes");
      requireAnyReadCap("readFileBytes");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFileBytes");
      requireReadCapForClass("readFileBytes", rootClass);
      // Same as `readFile`: the open itself cannot be cancelled.
      options?.signal?.throwIfAborted();
      const buffer = await withVerifiedReadHandle(
        pluginId,
        "readFileBytes",
        resolved,
        0,
        (handle) => handle.readFile({ signal: options?.signal })
      );
      // Copy out of Node's pooled Buffer allocator: a small read shares its
      // backing ArrayBuffer with unrelated reads, so handing the view straight
      // to a plugin would expose whatever else the pool holds.
      return new Uint8Array(buffer);
    },
    readFileWithRevision: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFileWithRevision");
      requireAnyReadCap("readFileWithRevision");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFileWithRevision");
      requireReadCapForClass("readFileWithRevision", rootClass);
      options?.signal?.throwIfAborted();
      // Decoded and hashed from one buffer, so the revision always describes
      // the text returned — two reads could straddle a write.
      const buffer = await withVerifiedReadHandle(
        pluginId,
        "readFileWithRevision",
        resolved,
        0,
        (handle) => handle.readFile({ signal: options?.signal })
      );
      return { contents: buffer.toString("utf-8"), revision: sha256Hex(buffer) };
    },
    readFileBounded: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFileBounded");
      requireAnyReadCap("readFileBounded");
      const limit = options?.limitBytes;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
        throw new Error(
          `VALIDATION: plugin "${pluginId}" fs.readFileBounded requires an integer limitBytes`
        );
      }
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFileBounded");
      requireReadCapForClass("readFileBounded", rootClass);
      options?.signal?.throwIfAborted();
      // O_NONBLOCK (undefined on Windows) so a FIFO standing where a regular
      // file was cannot leave the open pending with no writer. The
      // regular-file check below is on the descriptor this open returned, not
      // on a path that could since have become something else — a path stat
      // is evidence about a name, not about an fd.
      //
      // What this does not close, and neither does any other read here: the
      // open is still by pathname, so an ANCESTOR directory swapped for a
      // symlink between containment and this line resolves somewhere else.
      // Closing that needs the whole walk opened directory by directory,
      // which is a change to containment rather than to one read.
      return withVerifiedReadHandle(
        pluginId,
        "readFileBounded",
        resolved,
        fs.constants.O_NONBLOCK ?? 0,
        async (handle, opened) => {
          if (!opened.isFile()) return { status: "not-a-file" as const };
          // limit + 1: the extra byte is how an oversized file is recognised
          // without ever holding more than the cap plus one byte of it.
          const buffer = Buffer.allocUnsafe(limit + 1);
          let filled = 0;
          while (filled <= limit) {
            options?.signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
            if (bytesRead === 0) break;
            filled += bytesRead;
          }
          if (filled > limit) return { status: "too-large" as const };
          // Copied out of the pooled allocator for the same reason
          // `readFileBytes` copies: the pool's backing store holds other reads.
          return { status: "ok" as const, bytes: new Uint8Array(buffer.subarray(0, filled)) };
        }
      );
    },
    writeFile: async (filePath, contents, options) => {
      requireLoaded("writeFile");
      const writeCap = requireWriteCap("writeFile");
      if (typeof contents !== "string") {
        throw new Error(`Plugin "${pluginId}" fs.writeFile: contents must be a string`);
      }
      // Omitted options is the same write as `{}` (#12618): every call shape
      // gets the recheck, the symlink refusal and the atomic replace. A
      // malformed options value is an authoring error, never read as absent.
      if (options !== undefined && (options === null || typeof options !== "object")) {
        throw new Error(`Plugin "${pluginId}" fs.writeFile: options must be an object`);
      }
      const expected = options?.expectedRevision;
      if (expected !== undefined && expected !== null && !/^[0-9a-f]{64}$/.test(expected)) {
        throw new Error(
          `Plugin "${pluginId}" fs.writeFile: expectedRevision must be a sha256 hex string or null`
        );
      }
      const { resolved, isDataDirTarget } = await gateMutation("writeFile", filePath, writeCap);
      if (isDataDirTarget) await createDataDirParents("writeFile", resolved);
      // One writer per resolved path at a time, so a hash-compare-and-replace
      // cannot interleave with any other host-mediated writer to the same
      // file. Distinct paths never wait on each other.
      const revision = await runExclusive(resolved, async () => {
        // A write queued behind another can outlive its plugin; say so before
        // the recheck below misreports an unloaded plugin's roots as scope.
        requireLoaded("writeFile");
        await recheckContained("writeFile", filePath, resolved);
        const leafStat = await refuseSymlinkLeaf("writeFile", filePath);
        const bytes = Buffer.from(contents, "utf-8");
        if (expected === null) {
          // Create-new is an exclusive create at the filesystem, not a check
          // followed by a replace: two writers racing on names that only
          // differ in case would otherwise both see "absent" and both win on
          // a case-insensitive volume. A directory or any other entry at the
          // leaf reads as "exists" without being opened.
          if (leafStat !== null) {
            throw fsTargetError(
              "TARGET_EXISTS",
              `Plugin "${pluginId}" fs.writeFile: the target already exists`
            );
          }
          requireLoaded("writeFile");
          try {
            await fs.writeFile(resolved, bytes, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw fsTargetError(
                "TARGET_EXISTS",
                `Plugin "${pluginId}" fs.writeFile: the target already exists`
              );
            }
            throw error;
          }
          return sha256Hex(bytes);
        }
        if (expected !== undefined) {
          // Only a revision compare needs the current bytes; a write without
          // one never reads the target, so an unreadable or oversized file
          // still gets its atomic replace. The read is verified like any
          // other, so the hash a mismatch hands back is never the hash of a
          // file a swapped-in symlink pointed at.
          const current = await withVerifiedReadHandle(
            pluginId,
            "writeFile",
            resolved,
            0,
            (handle) => handle.readFile()
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (current === null) {
            throw fsTargetError(
              "TARGET_UNAVAILABLE",
              `Plugin "${pluginId}" fs.writeFile: the target no longer exists`
            );
          }
          const currentRevision = sha256Hex(current);
          if (currentRevision !== expected) {
            throw Object.assign(
              fsTargetError(
                "REVISION_MISMATCH",
                `Plugin "${pluginId}" fs.writeFile: the file changed since it was read`
              ),
              { currentRevision }
            );
          }
        }
        // Preserve the file's mode across the replace so an executable script
        // or a read-only note keeps its bits; a new file takes the umask.
        const mode = leafStat && !leafStat.isSymbolicLink() ? leafStat.mode & 0o777 : undefined;
        // Last liveness check before the bytes land: the consent prompt and the
        // queue wait above can outlive the plugin.
        requireLoaded("writeFile");
        await resilientAtomicWriteFile(
          resolved,
          bytes,
          "utf-8",
          mode === undefined ? undefined : { mode }
        );
        return sha256Hex(bytes);
      });
      // Audit every write so host-mediated filesystem mutation is observable.
      auditMutation("writeFile", resolved, Buffer.byteLength(contents));
      return { revision };
    },
    mkdir: async (dirPath) => {
      requireLoaded("mkdir");
      const writeCap = requireWriteCap("mkdir");
      // Containment realpaths the deepest existing ancestor and re-appends the
      // missing tail, so an existing ancestor that is a symlink out of every
      // root is refused here, before anything is created.
      const { resolved } = await gateMutation("mkdir", dirPath, writeCap);
      // Only what this call made is audited; an existing directory changed
      // nothing.
      await runExclusive(resolved, async () => {
        requireLoaded("mkdir");
        await recheckContained("mkdir", dirPath, resolved);
        await createDirectoryChain(pluginId, "mkdir", resolved, (dir) =>
          auditMutation("mkdir", dir)
        );
      });
    },
    appendFile: async (filePath, contents) => {
      requireLoaded("appendFile");
      const writeCap = requireWriteCap("appendFile");
      if (typeof contents !== "string") {
        throw new Error(`Plugin "${pluginId}" fs.appendFile: contents must be a string`);
      }
      const { resolved, isDataDirTarget } = await gateMutation("appendFile", filePath, writeCap);
      if (isDataDirTarget) await createDataDirParents("appendFile", resolved);
      const bytes = Buffer.from(contents, "utf-8");
      // Serialised with writeFile on the same path, so an append can never
      // land between a checked write's hash compare and its rename.
      await runExclusive(resolved, async () => {
        requireLoaded("appendFile");
        await recheckContained("appendFile", filePath, resolved);
        const leafStat = await refuseSymlinkLeaf("appendFile", filePath);
        // A FIFO or device is refused before the open, which on a FIFO with
        // no reader would otherwise block.
        if (leafStat !== null && !leafStat.isFile()) {
          throw fsTargetError(
            "TARGET_UNAVAILABLE",
            `Plugin "${pluginId}" fs.appendFile: the target is not a regular file`
          );
        }
        requireLoaded("appendFile");
        try {
          await appendToContainedFile(pluginId, resolved, bytes);
        } catch (error) {
          const partial = (error as { bytesWritten?: unknown }).bytesWritten;
          if (typeof partial === "number" && partial > 0) {
            deps.safeAppendAudit({
              pluginId,
              actionId: `fs.appendFile:${resolved}`,
              recordType: "ipc-invoke",
              channel: "plugin:fs-write",
              result: "error",
              errorMessage: formatErrorMessage(error, "append failed"),
              argsHash: deps.safeArgsHash([{ path: resolved, bytes: partial }]),
              durationMs: 0,
            });
          }
          throw error;
        }
      });
      auditMutation("appendFile", resolved, bytes.byteLength);
    },
    readdir: async (dirPath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readdir");
      requireAnyReadCap("readdir");
      const { resolved, rootClass, root } = await containWithClass(dirPath);
      options?.signal?.throwIfAborted();
      requireLoaded("readdir");
      requireReadCapForClass("readdir", rootClass);

      if (options?.detail === true) {
        // The same listing the built-in file browser renders, rather than a
        // second implementation of ordering and symlink classification that
        // would drift from it. Scoped to the allowed root that admitted this
        // path, so `targetKind: "external"` means "outside what this plugin may
        // read" — the classification a plugin actually needs.
        // The DECLARED root is the base, not its realpath: `getFileTree`
        // resolves the real one itself and uses both, and its symlink
        // classification gates the raw link target lexically against the
        // declared prefix first. Handing it an already-realpathed base makes
        // every link written with the declared prefix (`/var/...` where the real
        // path is `/private/var/...`) read as "external". The relative dir is
        // still measured from the real root, because `resolved` is realpathed.
        //
        // This does mean the declared root is traversed a second time, after
        // authorization — so a declared root that is itself a symlink, swapped
        // between the two, would list the new target. That window grants a
        // plugin nothing: its `main` runs un-sandboxed and can read either
        // directory through raw `node:fs` regardless (see the honest-scope note
        // in docs/plugins/host-api.md). Closing it properly needs `getFileTree`
        // to take the traversal base and the classification spelling
        // separately, which is a change to a surface the file browser shares.
        const realRoot = await fs.realpath(root);
        options?.signal?.throwIfAborted();
        const nodes = await fileTreeService.getFileTree(root, path.relative(realRoot, resolved));
        options?.signal?.throwIfAborted();
        return nodes.map((node): PluginFsDirEntry => {
          const symlink = node.symlink;
          return {
            name: node.name,
            isDirectory: node.isDirectory,
            // A link is described by what it resolves to, exactly as
            // `isDirectory` already is — so a link that resolves to nothing
            // readable (broken, out of scope, unclassifiable) is neither a file
            // nor a directory. Reporting `!isDirectory` here would have called
            // every dangling link a regular file and invited a plugin to read
            // it.
            isFile: symlink ? symlink.targetKind === "file" : !node.isDirectory,
            isSymbolicLink: symlink !== undefined,
            ...(node.size !== undefined && { size: node.size }),
            ...(node.mtimeMs !== undefined && { mtimeMs: node.mtimeMs }),
            ...(symlink && {
              symlink: { target: symlink.target, targetKind: symlink.targetKind },
            }),
          };
        });
      }

      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return entries.map((e): PluginFsDirEntry => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    },
    stat: async (targetPath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("stat");
      requireAnyReadCap("stat");
      const { resolved, rootClass } = await containWithClass(targetPath);
      options?.signal?.throwIfAborted();
      requireLoaded("stat");
      requireReadCapForClass("stat", rootClass);
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
      requireAnyReadCap("watch");
      if (typeof callback !== "function") {
        throw new Error(`Plugin "${pluginId}" fs.watch: callback must be a function`);
      }
      // Validated here, not trusted from the worker port: a malformed option
      // is an authoring error, never read as "off".
      const rawRecursive = options?.recursive;
      if (rawRecursive !== undefined && typeof rawRecursive !== "boolean") {
        throw new Error(`Plugin "${pluginId}" fs.watch: recursive must be a boolean`);
      }
      const recursive = rawRecursive === true;
      const rawDebounce = options?.debounceMs;
      if (
        rawDebounce !== undefined &&
        (typeof rawDebounce !== "number" || !Number.isFinite(rawDebounce) || rawDebounce < 0)
      ) {
        throw new Error(
          `Plugin "${pluginId}" fs.watch: debounceMs must be a finite, non-negative number`
        );
      }
      // Same floor and off-switch as onDidChangeWorktrees' debounce, plus a
      // ceiling so a huge value cannot wrap to Node's 1 ms overflow delay.
      const debounceMs =
        rawDebounce === undefined || rawDebounce === 0
          ? 0
          : Math.min(
              Math.max(rawDebounce, MIN_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS),
              MAX_PLUGIN_FS_WATCH_DEBOUNCE_MS
            );
      const targets = Array.isArray(paths) ? paths : [];
      if (targets.length === 0) {
        throw new Error(`Plugin "${pluginId}" fs.watch: paths must be a non-empty array`);
      }
      // Contain every path up front so an out-of-scope watch target rejects
      // before any watcher is created; gate each on its own root class.
      const contained = await Promise.all(targets.map((p) => containWithClass(p)));
      options?.signal?.throwIfAborted();
      requireLoaded("watch");
      for (const c of contained) requireReadCapForClass("watch", c.rootClass);
      const resolvedTargets = contained.map((c) => c.resolved);

      // One native watcher per resolved path, shared across every plugin (and
      // every other subscriber) that wants it — five plugins watching one
      // worktree previously meant five `fs.watch` handles for identical events.
      // Containment and capability checks above still run per plugin; only the
      // watcher underneath is shared.
      const releases: Array<() => void> = [];
      let disposed = false;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingPath: string | null = null;
      const deliver = (changed: string): void => {
        if (disposed || !deps.plugins.has(pluginId)) return;
        try {
          callback(changed);
        } catch (err) {
          console.error(`[PluginService] plugin "${pluginId}" fs.watch callback threw:`, err);
        }
      };
      // One timer per subscription, shared across every path it watches, so a
      // burst touching several watched directories still yields one callback.
      const onChange =
        debounceMs > 0
          ? (changed: string): void => {
              if (disposed) return;
              pendingPath = changed;
              if (debounceTimer) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                debounceTimer = null;
                const latest = pendingPath;
                pendingPath = null;
                if (latest !== null) deliver(latest);
              }, debounceMs);
            }
          : deliver;
      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        for (const release of releases) {
          try {
            release();
          } catch {
            // best-effort
          }
        }
        deps.pluginFsWatchers.get(pluginId)?.delete(dispose);
      };

      try {
        for (const resolved of resolvedTargets) {
          // Node's Linux recursive watcher follows static symlink targets, so
          // its reports are not proof of containment. The path it reports is
          // always joined onto the watched root; anything that does not stay
          // lexically inside that root is dropped rather than handed on.
          const withinRoot = (changed: string): void => {
            const rel = path.relative(resolved, changed);
            if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
            onChange(changed);
          };
          releases.push(watchShared(resolved, withinRoot, { recursive }));
        }
      } catch (err) {
        // A later path's watch threw (e.g. ENOENT) after earlier subscriptions
        // were taken — release them so a partial failure doesn't leak a
        // reference and pin a shared watcher open (dispose isn't registered in
        // pluginFsWatchers yet, so teardown wouldn't catch them).
        for (const release of releases) {
          try {
            release();
          } catch {
            // best-effort
          }
        }
        throw err;
      }

      let set = deps.pluginFsWatchers.get(pluginId);
      if (!set) {
        set = new Set();
        deps.pluginFsWatchers.set(pluginId, set);
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
function buildGitApi(deps: PluginHostFactoryDeps, pluginId: string): PluginGitApi {
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" git.${op}: plugin is no longer loaded`
      );
    }
  };
  const requireReadCap = (op: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("git:read")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" git.${op} requires the "git:read" capability, which is not declared in manifest.capabilities`
      );
    }
  };
  const requireWriteCap = (op: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("git:write")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" git.${op} requires the "git:write" capability, which is not declared in manifest.capabilities`
      );
    }
  };
  // A worktree the plugin may access = one contained inside its declared
  // allowedPaths (with `${project}` / `${worktree}` tokens expanded at call
  // time). We resolve the worktree root itself (not a child) so the git ops
  // run against the realpath-verified directory. The implicit per-plugin data
  // dir is NOT an allowed git root — git ops gate on git:read/git:write and
  // should never reach into a plugin's private scratch space.
  const containWorktree = async (worktreePath: string): Promise<string> => {
    const entries = await deps.expandAllowedPathEntries(pluginId, { includeDataDir: false });
    let lastErr: unknown;
    for (const entry of entries) {
      try {
        return await resolveContainedPath(pluginId, worktreePath, [entry.path]);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new PluginPathNotAllowedError(pluginId, worktreePath);
  };
  const git = new PluginHostGit(pluginId, deps.getHostGitFactory());

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
      // Consent fires after containment so an out-of-scope path never banks a
      // git:write grant (#10524). Re-check liveness after the prompt await.
      await ensureCapabilityConsent(deps, pluginId, "git:write");
      requireLoaded("add");
      await git.add(resolved, paths, options?.signal);
      deps.safeAppendAudit({
        pluginId,
        actionId: `git.add:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:git-add",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ worktreePath: resolved, paths: paths ?? ["."] }]),
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
      // Reject an empty message BEFORE prompting for consent, mirroring the
      // #7880 no-silent-fallback guard git.commit enforces internally, so a
      // doomed commit can't bank a git:write grant (#10524).
      if (!options || typeof options.message !== "string" || options.message.trim().length === 0) {
        throw new Error(
          `COMMIT_MESSAGE_REQUIRED: plugin "${pluginId}" git.commit requires a non-empty message`
        );
      }
      const resolved = await containWorktree(worktreePath);
      requireLoaded("commit");
      // Consent fires after containment + message validation so a doomed call
      // never banks a grant (#10524). Re-check liveness after the prompt await.
      await ensureCapabilityConsent(deps, pluginId, "git:write");
      requireLoaded("commit");
      const result = await git.commit(resolved, options, callOptions?.signal);
      deps.safeAppendAudit({
        pluginId,
        actionId: `git.commit:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:git-commit",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ worktreePath: resolved, commit: result.commit }]),
        durationMs: 0,
      });
      return result;
    },
  };
}

/**
 * A `host.fs` for one named project and worktree — the implementation behind a
 * built-in host's `fsForWorkspace` (`shared/types/plugin.ts`).
 *
 * Built-ins are app-global, so their token roots otherwise track the focused
 * window; a built-in holding long-lived state about a worktree needs roots that
 * do not move when the user looks elsewhere. It repoints the tokens rather than
 * relaxing anything: the declared `allowedPaths`, capability classes, realpath
 * containment and write audit are untouched, and the roots it names are ones
 * the same manifest already reaches when that project is focused — reaching
 * them while it is NOT focused is the point, and is why the caller must
 * validate the scope against its own invocation context. A project that is not
 * open expands to no token root at all, and an unresolvable worktree drops
 * `${worktree}` alone, both following #9492's fail-closed posture.
 *
 * Whether the caller may name this scope is the CALLER's check, made against
 * the invoking renderer's `PluginIpcContext` before it asks — nothing about a
 * scope object is authenticated here.
 */
export function buildScopedFsApi(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  scope: PluginWorkspaceScope
): BuiltinPluginFsApi {
  return buildFsApi(deps, pluginId, scope);
}

/**
 * Contain a plugin-supplied path against the plugin's call-time-expanded
 * allowed roots and report which root class matched.
 *
 * Containment runs per entry rather than against the union so the matched
 * entry's class is exact — the union would only tell us "some root", and the
 * capability gate needs to know *which*. The first containing root wins; when
 * a path sits inside two roots of different classes the earlier declaration
 * decides, which is the same "any allowed root" semantics the fs API has
 * always had.
 *
 * Shared by `host.fs` and `host.system` so the two can never drift into
 * disagreeing about what a plugin may reach or which capability guards it.
 */
async function containToDeclaredRoots(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  targetPath: string,
  scope?: PluginWorkspaceScope
): Promise<{ resolved: string; rootClass: FsRootClass; root: string }> {
  const entries = await deps.expandAllowedPathEntries(pluginId, {
    includeDataDir: true,
    scope,
  });
  let lastErr: unknown;
  for (const entry of entries) {
    try {
      const resolved = await resolveContainedPath(pluginId, targetPath, [entry.path]);
      // The matching root travels with the result so a caller that needs to
      // reason about scope — a detailed listing classifying whether a symlink
      // leaves it — does not have to rediscover which root allowed the path.
      return { resolved, rootClass: entry.rootClass, root: entry.path };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new PluginPathNotAllowedError(pluginId, targetPath);
}

/**
 * Host-mediated OS clipboard surface backing the `clipboard:read` /
 * `clipboard:write` tokens. Text reads/writes plus bounded PNG writes
 * (#11299); every method runs here in the main
 * process because Electron's `clipboard` module is undefined inside the
 * dev-worker utility process (a worker-side call would silently no-op). Like
 * {@link buildGitApi} the liveness check precedes the capability check so a
 * torn-down plugin reports `PLUGIN_UNLOADED`, not `PERMISSION_REQUIRED`
 * (declaredCapabilities() also returns [] post-unload). Clipboard ops are
 * stateless — no watchers or handles — so there is nothing to tear down on
 * unload.
 */
function buildClipboardApi(deps: PluginHostFactoryDeps, pluginId: string): PluginClipboardApi {
  // Mirror the renderer IPC clipboard write guard (electron/ipc/handlers/
  // clipboard.ts) so a runaway plugin can't exhaust the main-process heap.
  const MAX_TEXT_BYTES = 8 * 1024 * 1024;
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" clipboard.${op}: plugin is no longer loaded`
      );
    }
  };
  return {
    writeText: async (text): Promise<void> => {
      requireLoaded("writeText");
      if (!deps.declaredCapabilities(pluginId).has("clipboard:write")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" clipboard.writeText requires the "clipboard:write" capability, which is not declared in manifest.capabilities`
        );
      }
      if (typeof text !== "string") {
        throw new Error(`VALIDATION: plugin "${pluginId}" clipboard.writeText requires a string`);
      }
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        throw new Error(
          `PAYLOAD_TOO_LARGE: plugin "${pluginId}" clipboard.writeText text exceeds the ${MAX_TEXT_BYTES} byte limit`
        );
      }
      clipboard.writeText(text);
    },
    writeImage: async (pngData): Promise<void> => {
      requireLoaded("writeImage");
      // Same token as writeText: putting an image on the clipboard is exactly
      // as reversible as putting text there, so it earns no second capability
      // and doesn't elevate the plugin's action danger.
      if (!deps.declaredCapabilities(pluginId).has("clipboard:write")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" clipboard.writeImage requires the "clipboard:write" capability, which is not declared in manifest.capabilities`
        );
      }
      if (!(pngData instanceof Uint8Array)) {
        throw new Error(
          `VALIDATION: plugin "${pluginId}" clipboard.writeImage requires a Uint8Array of PNG bytes`
        );
      }
      // Size-check before decoding: createFromBuffer allocates a decoded
      // bitmap several times the compressed size, so admitting the bytes
      // first would defeat the cap it exists to enforce.
      if (pngData.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
        throw new Error(
          `PAYLOAD_TOO_LARGE: plugin "${pluginId}" clipboard.writeImage image exceeds the ${MAX_CLIPBOARD_IMAGE_BYTES} byte limit`
        );
      }
      const image = decodeClipboardPng(pngData);
      if (image === null) {
        throw new Error(
          `VALIDATION: plugin "${pluginId}" clipboard.writeImage could not decode the data as an image`
        );
      }
      clipboard.writeImage(image);
      // Audit the byte count only — never the bytes. An image write is
      // user-visible state the plugin changed without a prompt, so it belongs
      // in the trail even though it isn't destructive.
      deps.safeAppendAudit({
        pluginId,
        actionId: "clipboard.writeImage",
        recordType: "ipc-invoke",
        channel: "plugin:clipboard-write-image",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ bytes: pngData.byteLength }]),
        durationMs: 0,
      });
    },
    readText: async (): Promise<string> => {
      requireLoaded("readText");
      if (!deps.declaredCapabilities(pluginId).has("clipboard:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" clipboard.readText requires the "clipboard:read" capability, which is not declared in manifest.capabilities`
        );
      }
      // Electron returns "" for empty or non-text clipboard content.
      return clipboard.readText();
    },
  };
}

/**
 * Host-mediated "open / reveal" surface (#11299), scoped to the calling
 * plugin's own filesystem roots.
 *
 * The renderer's built-in `system.openPath` action validates against the
 * *user's* roots — open projects, tracked worktrees, `userData` — and carries
 * no caller identity, so a plugin dispatching it could not reach
 * `~/.daintree/plugin-data/<plugin-id>/`: the one directory that is
 * unambiguously its own. Plugins worked around that by shelling out to
 * `/usr/bin/open`, trading a contained call for arbitrary execution.
 *
 * `pluginId` is bound here at construction rather than travelling as an
 * argument, which is what makes the scoping trustworthy — there is no
 * parameter for one plugin to name another's namespace. That is also why this
 * is a host API rather than plugin identity threaded through the generic
 * ActionService dispatch payload, which every non-plugin caller shares.
 *
 * Stateless — no watchers or handles, so nothing to tear down on unload.
 */
function buildSystemApi(deps: PluginHostFactoryDeps, pluginId: string): PluginSystemApi {
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" system.${op}: plugin is no longer loaded`
      );
    }
  };
  // Accept either the read or the write capability for the matched root's
  // class. Revealing a file is strictly less authority than the read that
  // would let the plugin exfiltrate its contents, and a plugin that could
  // legitimately *create* the file should not also have to declare read
  // access just to show the user where it landed.
  const requireCapForClass = (op: string, rootClass: FsRootClass): void => {
    const read = rootClass === "project" ? "fs:project-read" : "fs:user-data-read";
    const write = rootClass === "project" ? "fs:project-write" : "fs:user-data-write";
    const held = deps.declaredCapabilities(pluginId);
    if (!held.has(read) && !held.has(write)) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" system.${op} requires the "${read}" or "${write}" capability for ${rootClass} paths, which is not declared in manifest.capabilities`
      );
    }
  };
  const containWithClass = (targetPath: string) =>
    containToDeclaredRoots(deps, pluginId, targetPath);
  // The plugin path resolver deliberately admits a non-existent final
  // component so `fs.writeFile` can create a new file inside an allowed root.
  // That is wrong for these sinks: `shell.showItemInFolder` silently no-ops on
  // a missing path, so without this gate a plugin revealing a deleted file
  // would be told it succeeded while nothing opened. Checked after the
  // capability gate so an unauthorized plugin can't probe for existence.
  const requireExists = async (op: string, resolved: string): Promise<void> => {
    try {
      await fs.stat(resolved);
    } catch (err) {
      // Report only a genuine absence as absence. A permissions or I/O error
      // says the path is unreadable, not missing, and collapsing the two sends
      // an author hunting for a file that is sitting right there.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const reason =
        code === "ENOENT" || code === "ENOTDIR" ? "path does not exist" : `stat failed (${code})`;
      throw new Error(`INVALID_PATH: plugin "${pluginId}" system.${op}: ${reason}: ${resolved}`, {
        cause: err,
      });
    }
  };

  return {
    openPath: async (targetPath): Promise<void> => {
      requireLoaded("openPath");
      // Deny executables on the raw path before any I/O, then again on the
      // realpath target below — a benignly named symlink inside an allowed
      // root would otherwise be a launch primitive.
      assertExtensionAllowed(targetPath);
      const { resolved, rootClass } = await containWithClass(targetPath);
      // Re-check liveness after the await: expansion and realpath are async,
      // and the plugin can unload underneath them (#9533).
      requireLoaded("openPath");
      requireCapForClass("openPath", rootClass);
      assertExtensionAllowed(resolved);
      await requireExists("openPath", resolved);
      requireLoaded("openPath");
      // shell.openPath reports failure through a non-empty return string
      // rather than by rejecting, so an unchecked call fails silently.
      const error = await shell.openPath(resolved);
      if (error !== "") {
        throw new Error(`plugin "${pluginId}" system.openPath failed: ${error}`);
      }
      deps.safeAppendAudit({
        pluginId,
        actionId: `system.openPath:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:system-open-path",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ path: resolved }]),
        durationMs: 0,
      });
    },
    showItemInFolder: async (targetPath): Promise<void> => {
      requireLoaded("showItemInFolder");
      // No executable deny-list here: revealing a file in Finder/Explorer
      // shows it, it does not run it. Containment still applies in full.
      const { resolved, rootClass } = await containWithClass(targetPath);
      requireLoaded("showItemInFolder");
      requireCapForClass("showItemInFolder", rootClass);
      await requireExists("showItemInFolder", resolved);
      requireLoaded("showItemInFolder");
      // Returns void and no-ops on a missing path — requireExists above is
      // what turns that silent nothing into a reported failure.
      shell.showItemInFolder(resolved);
      deps.safeAppendAudit({
        pluginId,
        actionId: `system.showItemInFolder:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:system-show-item",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ path: resolved }]),
        durationMs: 0,
      });
    },
  };
}
