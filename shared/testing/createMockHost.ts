/**
 * In-memory `PluginHostApi` implementation for unit tests. Records every host
 * call into a recording array so a plugin's `activate()` can be exercised
 * without booting Electron, the renderer, or the real contribution registries.
 *
 * Why the intersection return type — `PluginHostApi & MockHostState` makes the
 * recording arrays and `simulate*` helpers visible to callers while still
 * giving TypeScript a compile error the moment `PluginHostApi` gains a new
 * method this mock doesn't implement.
 */

import type { ActionDispatchResult } from "../types/actions.js";
import type {
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderImpl,
} from "../types/forge.js";
import type { NotificationType } from "../types/notification.js";
import type {
  ActionHandler,
  PluginActionContribution,
  PluginChannelSchema,
  PluginHostApi,
  PluginIpcHandler,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginSettingsScope,
  PluginToastOptions,
  PluginTypedIpcHandler,
  PluginWorktreeSnapshot,
  PluginGitCommitResult,
  SettingsApi,
} from "../types/plugin.js";

export interface RegisteredActionRecord {
  descriptor: PluginActionContribution;
  handler: ActionHandler;
}

export interface RegisteredHandlerRecord {
  channel: string;
  handler: PluginIpcHandler;
}

export interface BroadcastRecord {
  channel: string;
  payload: unknown;
}

/** Captured `host.postToPanel(channel, payload)` calls — the post-activation push path. */
export interface PostToPanelRecord {
  channel: string;
  payload: unknown;
}

export interface ShownToastRecord {
  message: string;
  type: NotificationType | undefined;
  durationMs: number | undefined;
}

/** Captured `host.process.spawn(command, options)` calls. */
export interface SpawnRecord {
  command: string;
  options: PluginProcessSpawnOptions | undefined;
}

export interface DispatchedActionRecord {
  actionId: string;
  args: unknown;
}

export interface RegisteredForgeProviderRecord {
  descriptor: ForgeProviderDescriptor;
  impl: ForgeProviderImpl;
}

export interface RegisteredFileDecorationProviderRecord {
  descriptor: FileDecorationProviderDescriptor;
  impl: FileDecorationProviderImpl;
}

export interface InvalidationRecord {
  scope: string;
  paths: string[] | undefined;
}

/** Captured `host.fs.writeFile(path, contents)` calls. */
export interface FsWriteRecord {
  path: string;
  contents: string;
}

/** Captured `host.git.commit(worktreePath, options)` calls. */
export interface GitCommitRecord {
  worktreePath: string;
  message: string;
}

export interface MockHostState {
  readonly registeredActions: ReadonlyArray<RegisteredActionRecord>;
  readonly registeredHandlers: ReadonlyArray<RegisteredHandlerRecord>;
  readonly broadcastCalls: ReadonlyArray<BroadcastRecord>;
  readonly postToPanelCalls: ReadonlyArray<PostToPanelRecord>;
  readonly shownToasts: ReadonlyArray<ShownToastRecord>;
  readonly dispatchedActions: ReadonlyArray<DispatchedActionRecord>;
  readonly registeredForgeProviders: ReadonlyArray<RegisteredForgeProviderRecord>;
  readonly registeredFileDecorationProviders: ReadonlyArray<RegisteredFileDecorationProviderRecord>;
  readonly invalidationCalls: ReadonlyArray<InvalidationRecord>;
  readonly spawnCalls: ReadonlyArray<SpawnRecord>;
  readonly fsWriteCalls: ReadonlyArray<FsWriteRecord>;
  readonly gitCommitCalls: ReadonlyArray<GitCommitRecord>;

  /**
   * Replace the active worktree and notify every `onDidChangeActiveWorktree`
   * subscriber. Helpers are top-level on the {@link MockHostState} side of the
   * intersection so they cannot drift into the production `PluginHostApi`.
   */
  simulateActiveWorktreeChange(snapshot: PluginWorktreeSnapshot | null): void;
  simulateWorktreesChange(snapshots: PluginWorktreeSnapshot[]): void;

  /**
   * Pre-seed a deterministic `dispatch()` result for one action id. Overrides
   * the default in-memory routing (which resolves the registered handler).
   */
  setDispatchResult(actionId: string, result: ActionDispatchResult): void;
}

export interface CreateMockHostOptions {
  pluginId?: string;
  activeWorktree?: PluginWorktreeSnapshot | null;
  worktrees?: PluginWorktreeSnapshot[];
  settings?: {
    user?: Record<string, unknown>;
    project?: Record<string, unknown>;
  };
  /**
   * Custom resolver for `host.dispatch`. The default routes the call to a
   * matching `registerAction` handler, returning `NOT_FOUND` otherwise — which
   * mirrors `ActionService.dispatch` closely enough for activation-time tests.
   */
  dispatch?: (actionId: string, args?: unknown) => Promise<ActionDispatchResult>;
}

/**
 * Mirrors the action-id regex and kind/danger sets in
 * `electron/services/PluginService.ts` `PLUGIN_ACTION_ID_RE` /
 * `PLUGIN_ACTION_KINDS` / `PLUGIN_ACTION_DANGERS`. The mock can't import
 * those (cross-process boundary), so the values are duplicated here and the
 * production constants are the source of truth. If the production regex or
 * sets change, mirror the change here.
 */
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;
const PLUGIN_ACTION_KINDS = new Set(["command", "query"]);
const PLUGIN_ACTION_DANGERS = new Set(["safe", "confirm"]);

export function createMockHost(options: CreateMockHostOptions = {}): PluginHostApi & MockHostState {
  const pluginId = options.pluginId ?? "test.mock";
  let activeWorktree: PluginWorktreeSnapshot | null = options.activeWorktree ?? null;
  let worktrees: PluginWorktreeSnapshot[] = options.worktrees ?? [];

  const registeredActions: RegisteredActionRecord[] = [];
  const registeredHandlers: RegisteredHandlerRecord[] = [];
  const broadcastCalls: BroadcastRecord[] = [];
  const postToPanelCalls: PostToPanelRecord[] = [];
  const shownToasts: ShownToastRecord[] = [];
  const dispatchedActions: DispatchedActionRecord[] = [];
  const registeredForgeProviders: RegisteredForgeProviderRecord[] = [];
  const registeredFileDecorationProviders: RegisteredFileDecorationProviderRecord[] = [];
  const invalidationCalls: InvalidationRecord[] = [];
  const spawnCalls: SpawnRecord[] = [];
  const fsFiles = new Map<string, string>();
  const fsWriteCalls: FsWriteRecord[] = [];
  const gitCommitCalls: GitCommitRecord[] = [];

  const activeWorktreeSubs = new Set<(snapshot: PluginWorktreeSnapshot | null) => void>();
  const worktreesSubs = new Set<(snapshots: PluginWorktreeSnapshot[]) => void>();

  const settingsStore: Record<PluginSettingsScope, Map<string, unknown>> = {
    user: new Map(Object.entries(options.settings?.user ?? {})),
    project: new Map(Object.entries(options.settings?.project ?? {})),
  };

  const settingsSubs: Record<PluginSettingsScope, Map<string, Set<(value: unknown) => void>>> = {
    user: new Map(),
    project: new Map(),
  };

  const dispatchOverrides = new Map<string, ActionDispatchResult>();

  const settings: SettingsApi = {
    async get<T = unknown>(
      key: string,
      scope: PluginSettingsScope = "user"
    ): Promise<T | undefined> {
      return settingsStore[scope].get(key) as T | undefined;
    },
    async set<T = unknown>(
      key: string,
      value: T,
      scope: PluginSettingsScope = "user"
    ): Promise<void> {
      if (value === undefined) {
        throw new Error("settings.set: value cannot be undefined");
      }
      const prev = settingsStore[scope].get(key);
      settingsStore[scope].set(key, value);
      if (!Object.is(prev, value)) {
        const subs = settingsSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(value as unknown);
        }
      }
    },
    onDidChange<T = unknown>(
      key: string,
      callback: (value: T | undefined) => void,
      scope: PluginSettingsScope = "user"
    ): Promise<() => void> {
      let subs = settingsSubs[scope].get(key);
      if (!subs) {
        subs = new Set();
        settingsSubs[scope].set(key, subs);
      }
      const cb = callback as (value: unknown) => void;
      subs.add(cb);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const set = settingsSubs[scope].get(key);
        if (set) {
          set.delete(cb);
          if (set.size === 0) settingsSubs[scope].delete(key);
        }
      };
      return Promise.resolve(dispose);
    },
  };

  const host: PluginHostApi & MockHostState = {
    pluginId,
    registerAction(descriptor, handler) {
      // Mirrors PluginService.createHost L1577-L1631. Validation order matches
      // production: non-object descriptor, non-function handler, non-empty
      // string id, plugin-prefix not already in id, then the
      // validateAndBuildActionDescriptor checks (L2686-L2723) applied to the
      // namespaced id (since production namespaces before that step).
      // Re-registering the same id replaces the prior descriptor + handler
      // (replace-by-id, see host-api.md). A plugin test that calls
      // registerAction with the same id twice should see the second call win,
      // not accumulate two entries.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerAction: descriptor must be an object");
      }
      if (typeof handler !== "function") {
        throw new Error("registerAction: handler must be a function");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerAction: descriptor.id must be a non-empty string");
      }
      if (descriptor.id.startsWith(`${pluginId}.`)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix`
        );
      }
      // Mirrors validateAndBuildActionDescriptor (L2697-L2723). The mock
      // namespaces the id the same way production does and runs the same
      // checks against the namespaced form, so a plugin test that registers
      // an action the production host would reject fails the mock in the
      // same way — no "passes the mock, throws at activation" gap.
      const namespacedId = `${pluginId}.${descriptor.id}`;
      if (!PLUGIN_ACTION_ID_RE.test(namespacedId)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" (namespaced to "${namespacedId}") is invalid. Expected "{pluginId}.{actionId}" (lowercase start, alphanumerics, dot/dash/underscore).`
        );
      }
      if (typeof descriptor.title !== "string" || !descriptor.title.trim()) {
        throw new Error("registerAction: descriptor.title must be a non-empty string");
      }
      if (typeof descriptor.description !== "string") {
        throw new Error("registerAction: descriptor.description must be a string");
      }
      if (typeof descriptor.category !== "string" || !descriptor.category.trim()) {
        throw new Error("registerAction: descriptor.category must be a non-empty string");
      }
      if (!PLUGIN_ACTION_KINDS.has(descriptor.kind)) {
        throw new Error(
          `registerAction: descriptor.kind "${descriptor.kind}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_KINDS,
          ].join(", ")})`
        );
      }
      if (!PLUGIN_ACTION_DANGERS.has(descriptor.danger)) {
        throw new Error(
          `registerAction: descriptor.danger "${descriptor.danger}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_DANGERS,
          ].join(", ")})`
        );
      }
      const existing = registeredActions.findIndex((r) => r.descriptor.id === descriptor.id);
      if (existing >= 0) {
        registeredActions[existing] = { descriptor, handler };
      } else {
        registeredActions.push({ descriptor, handler });
      }
      // Validation/registry mutation runs synchronously above (sync throws still
      // surface at the call site); only the return value is a resolved promise.
      return Promise.resolve();
    },
    registerHandler<TArgs = unknown, TResult = unknown>(
      channel: string,
      schemaOrHandler: PluginChannelSchema<TArgs, TResult> | PluginIpcHandler,
      handler?: PluginTypedIpcHandler<TArgs, TResult>
    ): Promise<void> {
      // Handle both overloads:
      // 1. registerHandler(channel, schema, handler) — typed
      // 2. registerHandler(channel, handler) — untyped
      if (handler !== undefined) {
        // Typed overload: schemaOrHandler is a schema, handler is the typed handler
        // The cast is necessary because PluginTypedIpcHandler is structurally compatible
        // with PluginIpcHandler and we're storing it in a untyped recording array.
        registeredHandlers.push({
          channel,
          handler: handler as unknown as PluginIpcHandler,
        });
      } else {
        // Untyped overload: schemaOrHandler is the handler
        registeredHandlers.push({
          channel,
          handler: schemaOrHandler as PluginIpcHandler,
        });
      }
      return Promise.resolve();
    },
    broadcastToRenderer(channel, payload) {
      broadcastCalls.push({ channel, payload });
      return Promise.resolve();
    },
    postToPanel(channel, payload) {
      postToPanelCalls.push({ channel, payload });
      return Promise.resolve();
    },
    async getActiveWorktree() {
      return activeWorktree;
    },
    async getWorktrees() {
      return worktrees;
    },
    async getWorktreeStatus(path, options) {
      options?.signal?.throwIfAborted();
      const match =
        worktrees.find((w) => w.path === path) ??
        (activeWorktree?.path === path ? activeWorktree : null);
      return match?.status ?? null;
    },
    onDidChangeActiveWorktree(callback) {
      activeWorktreeSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        activeWorktreeSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    onDidChangeWorktrees(callback, _options) {
      // The mock ignores `debounceMs` — coalescing is a host-side concern and is
      // unit-tested against PluginService directly; activation tests just need
      // the subscription wired.
      worktreesSubs.add(callback);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        worktreesSubs.delete(callback);
      };
      return Promise.resolve(dispose);
    },
    registerForgeProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1738-L1817. Validation order matches
      // production: non-object descriptor, non-empty string id, non-object impl.
      // The manifest-declared-id check is intentionally skipped — the mock has
      // no manifest model (see issue #9878). Re-registering the same id
      // replaces the prior binding (replace-by-id). The disposer's identity
      // guard compares the captured `impl` reference against the currently
      // active entry's `impl`, matching `unregisterForgeProviderImpl`'s
      // `expected` argument: a stale disposer from a re-bound id is a no-op.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerForgeProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerForgeProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object") {
        throw new Error("registerForgeProvider: impl must be an object");
      }
      const contributionId = descriptor.id;
      const existing = registeredForgeProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredForgeProviders[existing] = { descriptor, impl };
      } else {
        registeredForgeProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above) —
      // only the return value is a resolved promise, never a deferred write.
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredForgeProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredForgeProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerFileDecorationProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1818-L1875. Validation order matches
      // production: non-object descriptor, non-empty string id, impl must be
      // an object exposing `provideDecorations()`. The manifest-declared-id
      // check is intentionally skipped — the mock has no manifest model (see
      // issue #9878). Re-registering the same id replaces the prior binding
      // (replace-by-id). The disposer's identity guard mirrors
      // `unregisterFileDecorationProviderImpl`'s `expected` argument.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerFileDecorationProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerFileDecorationProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
        throw new Error("registerFileDecorationProvider: impl must expose provideDecorations()");
      }
      const contributionId = descriptor.id;
      const existing = registeredFileDecorationProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredFileDecorationProviders[existing] = { descriptor, impl };
      } else {
        registeredFileDecorationProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above).
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredFileDecorationProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredFileDecorationProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    invalidateFileDecorations(scope, paths) {
      invalidationCalls.push({ scope, paths });
      return Promise.resolve();
    },
    async showToast(opts: PluginToastOptions) {
      if (!opts.message) {
        throw new Error("showToast: message must be a non-empty string");
      }
      shownToasts.push({
        message: opts.message,
        type: opts.type,
        durationMs: opts.durationMs,
      });
    },
    async dispatch(actionId, args) {
      dispatchedActions.push({ actionId, args });
      const override = dispatchOverrides.get(actionId);
      if (override) return override;
      if (options.dispatch) return options.dispatch(actionId, args);
      // Match the real host's contract: dispatch ids are always fully
      // namespaced as `{pluginId}.{descriptor.id}`. Looking up by the full
      // form means a plugin calling `host.dispatch("greet")` against a
      // registered action also id'd `"greet"` returns NOT_FOUND in the mock
      // exactly as it would in production where ActionService never sees an
      // unprefixed id.
      const reg = registeredActions.find((r) => actionId === `${pluginId}.${r.descriptor.id}`);
      if (!reg) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Action not found: ${actionId}` },
        };
      }
      try {
        const result = await reg.handler(args);
        return { ok: true, result };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
    // Imperative UI prompts (#10522). The mock has no renderer to drive a
    // dialog, so it resolves the dismiss value (undefined / false) — the same
    // outcome a plugin sees when the user cancels. Tests that need a concrete
    // answer can wrap the host and override these.
    showQuickPick: (async () => undefined) as PluginHostApi["showQuickPick"],
    async showInputBox() {
      return undefined;
    },
    async showConfirm() {
      return false;
    },
    process: {
      async spawn(command, options): Promise<PluginProcessHandle> {
        spawnCalls.push({ command, options });
        // A no-op handle: the mock records the call without spawning anything.
        // Lifecycle callbacks never fire (no real process), and kill/restart
        // are inert — tests that exercise real process behavior use
        // PluginProcessManager directly with an injected fake spawner.
        return {
          id: `mock-process-${spawnCalls.length}`,
          kill: () => {},
          restart: async () => {},
          onExit: () => () => {},
          onCrash: () => () => {},
        };
      },
    },
    // In-memory fs mock: writes land in `fsFiles` and are recorded; reads return
    // a previously-written value or reject ENOENT. No containment is modeled
    // (containment lives in pluginFsContainment and is unit-tested directly) —
    // this mock is for exercising a plugin's activate()/handlers, not the guard.
    fs: {
      async readFile(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        return v;
      },
      async writeFile(filePath, contents) {
        fsFiles.set(filePath, contents);
        fsWriteCalls.push({ path: filePath, contents });
      },
      async readdir(_dirPath, options) {
        options?.signal?.throwIfAborted();
        return [];
      },
      async stat(targetPath, options) {
        options?.signal?.throwIfAborted();
        return {
          isDirectory: false,
          isFile: fsFiles.has(targetPath),
          isSymbolicLink: false,
          size: fsFiles.get(targetPath)?.length ?? 0,
          mtimeMs: 0,
        };
      },
      async watch(_paths, _callback, options) {
        options?.signal?.throwIfAborted();
        return () => {};
      },
    },
    // In-memory git mock. `commit` mirrors the host's #7880 guard — an empty
    // message rejects — so a plugin tested against the mock sees the same
    // no-silent-fallback contract as production.
    git: {
      async status(worktreePath, options) {
        options?.signal?.throwIfAborted();
        return { worktreePath, files: [], changedFileCount: 0 };
      },
      async diff(_worktreePath, _filePath, options) {
        options?.signal?.throwIfAborted();
        return "";
      },
      async add(_worktreePath, _paths, options) {
        options?.signal?.throwIfAborted();
      },
      async commit(worktreePath, options, callOptions): Promise<PluginGitCommitResult> {
        callOptions?.signal?.throwIfAborted();
        const message = typeof options?.message === "string" ? options.message : "";
        if (message.trim().length === 0) {
          throw new Error(
            `COMMIT_MESSAGE_REQUIRED: mock git.commit requires an explicit non-empty message`
          );
        }
        gitCommitCalls.push({ worktreePath, message });
        return { commit: `mock-${gitCommitCalls.length}`, message, preview: "" };
      },
    },
    settings,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },

    registeredActions,
    registeredHandlers,
    broadcastCalls,
    postToPanelCalls,
    shownToasts,
    dispatchedActions,
    registeredForgeProviders,
    registeredFileDecorationProviders,
    invalidationCalls,
    spawnCalls,
    fsWriteCalls,
    gitCommitCalls,

    simulateActiveWorktreeChange(snapshot) {
      activeWorktree = snapshot;
      for (const cb of activeWorktreeSubs) cb(snapshot);
    },
    simulateWorktreesChange(snapshots) {
      worktrees = snapshots;
      for (const cb of worktreesSubs) cb(snapshots);
    },
    setDispatchResult(actionId, result) {
      dispatchOverrides.set(actionId, result);
    },
  };

  return host;
}
