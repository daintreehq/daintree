import fs from "fs/promises";
import path from "path";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { clipboard } from "electron";

import { getPluginCapabilityConsentService } from "../plugin-capability/instances.js";
import { resolveContainedPath, PluginPathNotAllowedError } from "./pluginFsContainment.js";
import { PluginHostGit, type HostGitFactory } from "./pluginHostGit.js";
import type { PluginProcessManager } from "./PluginProcessManager.js";
import { PLUGIN_PTY_DEFAULT_COLS, PLUGIN_PTY_DEFAULT_ROWS } from "./PluginProcessManager.js";
import type { PluginContributionBroadcaster } from "./PluginContributionBroadcaster.js";
import type { PluginPanelLifecycleBroker } from "./PluginPanelLifecycleBroker.js";
import type { PluginRendererDispatcher } from "./PluginRendererDispatcher.js";
import type { PluginUIPromptDispatcher } from "./PluginUIPromptDispatcher.js";
import { assertSettingsKey, type PluginSettingsManager } from "./PluginSettingsManager.js";
import { assertStorageKey, type PluginStorageManager } from "./PluginStorageManager.js";
import { createListenerFailureState, invokeTrackedListener } from "./pluginCallbackUtils.js";
import { isChannelSchema } from "./PluginChannelRegistry.js";

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
import { broadcastToRenderer } from "../../ipc/utils.js";
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
  PluginActionContribution,
  PluginActionDescriptor,
  PluginChannelSchema,
  PluginTypedIpcHandler,
  ActionHandler,
  PluginQuickPickItem,
  PluginQuickPickOptions,
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
  PluginPtyProcessHandle,
  PluginPtyProcessSpawnOptions,
  PluginFsApi,
  PluginFsDirEntry,
  PluginFsStat,
  PluginGitApi,
  PluginClipboardApi,
  PluginGitStatus,
  PluginGitCommitOptions,
  PluginGitCommitResult,
  PluginPanelBadge,
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
  promptDispatcher: PluginUIPromptDispatcher;
  settings: PluginSettingsManager;
  storage: PluginStorageManager;
  /** Live read of the mutable `hostGitFactory` field — reassignable via `_setHostGitFactoryForTests`. */
  getHostGitFactory: () => HostGitFactory | undefined;
  getProcessManager: () => PluginProcessManager;
  declaredCapabilities: (pluginId: string) => Set<BuiltInPluginCapability>;
  fetchAllWorktreeSnapshots: () => Promise<WorktreeSnapshot[]>;
  recordPluginLog: (
    boundPlugin: LoadedPlugin,
    pluginId: string,
    level: PluginDiagnosticsLogLine["level"],
    message: string,
    fields?: Record<string, unknown>
  ) => void;
  serializePluginBadges: (pluginId: string) => Record<string, PluginPanelBadge>;
  pluginDataDir: (pluginId: string) => string;
  isPathUnder: (root: string, candidate: string) => boolean;
  expandAllowedPathEntries: (
    pluginId: string,
    options: { includeDataDir: boolean }
  ) => Promise<ExpandedFsPath[]>;
  subscribeWorktreeEvent: (
    pluginId: string,
    event: WorkspaceWorktreeEvent,
    handler: () => void
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

export function createHost(
  deps: PluginHostFactoryDeps,
  pluginId: string
): { host: PluginHostApi; revoke: () => void } {
  let revoked = false;
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
      broadcastToRenderer(`plugin:${pluginId}:${channel}`, { panelId: null, payload });
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
      broadcastToRenderer(`plugin:${pluginId}:${channel}`, { panelId: targetPanelId, payload });
      return Promise.resolve();
    },
    getActiveWorktree: async () => {
      if (!isBound()) return null;
      const snapshots = await deps.fetchAllWorktreeSnapshots();
      if (!isBound()) return null;
      const active = snapshots.find((s) => s.isCurrent === true);
      return active ? toPluginWorktreeSnapshot(active) : null;
    },
    getWorktrees: async () => {
      if (!isBound()) return [];
      const snapshots = await deps.fetchAllWorktreeSnapshots();
      if (!isBound()) return [];
      return snapshots.map(toPluginWorktreeSnapshot);
    },
    getWorktreeStatus: async (path, options) => {
      options?.signal?.throwIfAborted();
      if (!isBound()) return null;
      if (typeof path !== "string" || path.length === 0) return null;
      const snapshots = await deps.fetchAllWorktreeSnapshots();
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
      const terminalId = await resolveActiveAgentTerminalId();
      if (!isBound()) return;
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
      const dispose = deps.subscribeWorktreeEvent(pluginId, "worktree-activated", async () => {
        if (!deps.plugins.has(pluginId)) return;
        try {
          const snapshots = await deps.fetchAllWorktreeSnapshots();
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
          const snapshots = await deps.fetchAllWorktreeSnapshots();
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
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
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
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
        name: "plugin:panel-badges-changed",
        payload: { pluginId, badges: deps.serializePluginBadges(pluginId) },
      });
      return Promise.resolve();
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
      if (!deps.plugins.has(pluginId)) {
        return {
          ok: false,
          error: {
            code: "PLUGIN_UNLOADED",
            message: `Plugin "${pluginId}" is no longer loaded`,
          },
        };
      }
      return deps.dispatcher.sendDispatchToRenderer(actionId, args);
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
        return deps.dispatcher.sendActionsListToRenderer();
      },
      get: async (actionId) => {
        if (!deps.plugins.has(pluginId)) return null;
        return deps.dispatcher.sendActionsGetToRenderer(actionId);
      },
      // canDispatch derives locally from get() — no extra round-trip. A null
      // entry (unknown id, or a restricted action the renderer projects away)
      // maps to "restricted"; "confirm" actions surface as "confirm" so a
      // plugin can warn before dispatch() returns CONFIRMATION_REQUIRED.
      canDispatch: async (actionId) => {
        if (!deps.plugins.has(pluginId)) return "restricted";
        const entry = await deps.dispatcher.sendActionsGetToRenderer(actionId);
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
      options?: PluginQuickPickOptions
    ): Promise<PluginQuickPickItem | PluginQuickPickItem[] | undefined> => {
      if (!deps.plugins.has(pluginId)) return undefined;
      const validItems = validateQuickPickItems(pluginId, items);
      const value = await deps.promptDispatcher.requestPrompt(pluginId, {
        kind: "quickPick",
        items: validItems,
        options: sanitizeQuickPickOptions(options),
      });
      return value as PluginQuickPickItem | PluginQuickPickItem[] | undefined;
    }) as PluginHostApi["showQuickPick"],
    showInputBox: async (options) => {
      if (!deps.plugins.has(pluginId)) return undefined;
      const value = await deps.promptDispatcher.requestPrompt(pluginId, {
        kind: "inputBox",
        options: sanitizeInputBoxOptions(options),
      });
      return value as string | undefined;
    },
    showConfirm: async (options) => {
      if (!deps.plugins.has(pluginId)) return false;
      if (!options || typeof options !== "object" || typeof options.title !== "string") {
        throw new Error(`Plugin "${pluginId}" showConfirm: options.title must be a string`);
      }
      const value = await deps.promptDispatcher.requestPrompt(pluginId, {
        kind: "confirm",
        options: sanitizeConfirmOptions(options),
      });
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
    process: buildProcessApi(deps, pluginId),
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
        const filePath = deps.settings.resolveSettingsFilePath(pluginId, effectiveScope);
        // Project scope with no active project: read resolves to undefined
        // rather than throwing, matching the "unset key" return.
        if (!filePath) return undefined;
        return deps.settings
          .getOrCreateSettingsStore(pluginId, effectiveScope, filePath)
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
        const filePath = deps.settings.resolveSettingsFilePath(pluginId, scope);
        if (!filePath) {
          throw new Error(
            `Plugin "${pluginId}" settings.set: no active project — "project" scope has no target`
          );
        }
        const store = deps.settings.getOrCreateSettingsStore(pluginId, scope, filePath);
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
    storage: {
      get: async <T = unknown>(
        key: string,
        scope: PluginStorageScope = "user"
      ): Promise<T | undefined> => {
        assertStorageKey(pluginId, "get", key);
        const filePath = await deps.storage.resolveStorageFilePath(pluginId, scope);
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
        const filePath = await deps.storage.resolveStorageFilePath(pluginId, scope);
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
        const filePath = await deps.storage.resolveStorageFilePath(pluginId, scope);
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
function buildProcessApi(deps: PluginHostFactoryDeps, pluginId: string): PluginProcessApi {
  const spawn = async (
    command: string,
    options?: PluginProcessSpawnOptions | PluginPtyProcessSpawnOptions
  ): Promise<PluginProcessHandle | PluginPtyProcessHandle> => {
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
    if (rawMode !== undefined && rawMode !== "pipe" && rawMode !== "pty") {
      throw new Error(
        `Plugin "${pluginId}" process.spawn: mode must be "pipe" or "pty": ${String(rawMode)}`
      );
    }
    const mode: PluginProcessMode = rawMode === "pty" ? "pty" : "pipe";
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
      const active = await deps.fetchAllWorktreeSnapshots();
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
    if (mode !== "pty") return base;
    return {
      ...base,
      get id() {
        return handle.id;
      },
      write: (data) => {
        if (!deps.plugins.has(pluginId) || typeof data !== "string") return;
        handle.write(data);
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
  await getPluginCapabilityConsentService().ensureAllowed(
    pluginId,
    displayName,
    capability,
    plugin.manifest.capabilities ?? []
  );
}

/**
 * Resolve the terminal id of the "active agent" for `host.sendToActiveAgent`
 * (#10558). Centralised here so plugins stop reinventing `terminal.list`-based
 * selection heuristics that drift. Scopes strictly to the active project when
 * one is set — it never crosses a project boundary, since "the active agent"
 * the user consented to is the one in front of them; only when no project is
 * active (e.g. before any project loads) does it consider all terminals. Ranks
 * focused/visible agent (`activityTier: "active"`) first, then a `waiting`
 * agent, then the most recently active by output — with a deterministic id
 * tiebreak. Terminals with no agent or in an ended state (`exited` /
 * `completed`, or no live PTY) are excluded.
 *
 * @throws {Error} `NO_ACTIVE_AGENT:` when no eligible agent terminal exists.
 */
async function resolveActiveAgentTerminalId(): Promise<string> {
  const ptyClient = getPtyClient();
  if (!ptyClient) {
    throw new Error("NO_ACTIVE_AGENT: terminal host is not available");
  }
  const all = await ptyClient.getAllTerminalsAsync();
  const activeProjectId = ptyClient.getActiveProjectId();
  type Term = (typeof all)[number];
  const eligible = (t: Term): boolean =>
    Boolean(t.detectedAgentId ?? t.launchAgentId) &&
    t.hasPty !== false &&
    t.agentState !== "exited" &&
    t.agentState !== "completed";
  // Scope to the active project; never cross into another project's terminals.
  const pool = activeProjectId != null ? all.filter((t) => t.projectId === activeProjectId) : all;
  const candidates = pool.filter(eligible);
  if (candidates.length === 0) {
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

/**
 * Build the host-mediated `host.fs` surface for one plugin. Every path
 * argument is realpath-contained to the declared `scopes.fs.allowedPaths`
 * (traversal/symlink-escape rejected), and reads/writes are capability-gated
 * (`fs:*-read` / `fs:*-write`). This is the first runtime enforcement of
 * `scopes.fs.allowedPaths` — formerly advisory-only. Writes are audited.
 */
function buildFsApi(deps: PluginHostFactoryDeps, pluginId: string): PluginFsApi {
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
  // Contain against the call-time-expanded roots and report which root class
  // matched. We contain per-entry so the matched entry's class is exact (the
  // first containing root wins, same "any allowed root" semantics as before).
  const containWithClass = async (
    targetPath: string
  ): Promise<{ resolved: string; rootClass: FsRootClass }> => {
    const entries = await deps.expandAllowedPathEntries(pluginId, { includeDataDir: true });
    let lastErr: unknown;
    for (const entry of entries) {
      try {
        const resolved = await resolveContainedPath(pluginId, targetPath, [entry.path]);
        return { resolved, rootClass: entry.rootClass };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new PluginPathNotAllowedError(pluginId, targetPath);
  };

  return {
    readFile: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFile");
      requireAnyReadCap("readFile");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFile");
      requireReadCapForClass("readFile", rootClass);
      // Deliberately no 500KB / binary cap — this is a sanctioned plugin API,
      // not the size-limited files.read preview path. The signal cancels the
      // read itself (Node honors it) as well as the boundary checks above.
      return fs.readFile(resolved, { encoding: "utf-8", signal: options?.signal });
    },
    writeFile: async (filePath, contents) => {
      requireLoaded("writeFile");
      const writeCap = requireWriteCap("writeFile");
      if (typeof contents !== "string") {
        throw new Error(`Plugin "${pluginId}" fs.writeFile: contents must be a string`);
      }
      // Lazily materialize the implicit per-plugin data dir before containment
      // when the target (lexically) lands inside it — resolveContainedPath
      // realpaths every root and skips ones that don't exist, so a first write
      // into a not-yet-created data dir would otherwise fail containment. The
      // lexical check only gates the mkdir; realpath containment below stays
      // the security authority.
      const dataDir = deps.pluginDataDir(pluginId);
      // Identify a data-dir write from the (lexical) request path, not the
      // realpath-resolved one: on macOS the resolved path picks up the
      // /private prefix while `dataDir` does not, so comparing against
      // `resolved` would wrongly miss the match. The realpath containment
      // below remains the security authority either way.
      const isDataDirWrite =
        path.isAbsolute(filePath) && deps.isPathUnder(dataDir, path.normalize(filePath));
      if (isDataDirWrite) {
        // A data-dir write is always user-data class — gate before the mkdir
        // so a plugin lacking the cap doesn't materialize the dir as a side
        // effect (the post-containment check below re-asserts it).
        requireWriteCapForClass("writeFile", "user-data");
        await fs.mkdir(dataDir, { recursive: true });
      }
      requireLoaded("writeFile");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("writeFile");
      requireWriteCapForClass("writeFile", rootClass);
      // Create intermediate dirs for a nested write inside the data dir so a
      // plugin can lay out its own subtree without a separate mkdir API.
      if (isDataDirWrite) {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
      }
      // Consent fires after validation + containment so a call that would fail
      // anyway never banks a grant (#10524). Re-check liveness after the await.
      await ensureCapabilityConsent(deps, pluginId, writeCap);
      requireLoaded("writeFile");
      await fs.writeFile(resolved, contents, "utf-8");
      // Audit every write so host-mediated filesystem mutation is observable.
      deps.safeAppendAudit({
        pluginId,
        actionId: `fs.writeFile:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:fs-write",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ path: resolved, bytes: Buffer.byteLength(contents) }]),
        durationMs: 0,
      });
    },
    readdir: async (dirPath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readdir");
      requireAnyReadCap("readdir");
      const { resolved, rootClass } = await containWithClass(dirPath);
      options?.signal?.throwIfAborted();
      requireLoaded("readdir");
      requireReadCapForClass("readdir", rootClass);
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
        deps.pluginFsWatchers.get(pluginId)?.delete(dispose);
      };

      try {
        for (const resolved of resolvedTargets) {
          const watcher = fsWatch(resolved, { persistent: false }, (_event, filename) => {
            if (disposed || !deps.plugins.has(pluginId)) return;
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
 * Host-mediated OS clipboard surface backing the `clipboard:read` /
 * `clipboard:write` tokens. Text-only; both methods run here in the main
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
