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
  PluginSettingsScope,
  PluginToastOptions,
  PluginTypedIpcHandler,
  PluginWorktreeSnapshot,
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

export interface ShownToastRecord {
  message: string;
  type: NotificationType | undefined;
  durationMs: number | undefined;
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

export interface MockHostState {
  readonly registeredActions: ReadonlyArray<RegisteredActionRecord>;
  readonly registeredHandlers: ReadonlyArray<RegisteredHandlerRecord>;
  readonly broadcastCalls: ReadonlyArray<BroadcastRecord>;
  readonly shownToasts: ReadonlyArray<ShownToastRecord>;
  readonly dispatchedActions: ReadonlyArray<DispatchedActionRecord>;
  readonly registeredForgeProviders: ReadonlyArray<RegisteredForgeProviderRecord>;
  readonly registeredFileDecorationProviders: ReadonlyArray<RegisteredFileDecorationProviderRecord>;
  readonly invalidationCalls: ReadonlyArray<InvalidationRecord>;

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

export function createMockHost(options: CreateMockHostOptions = {}): PluginHostApi & MockHostState {
  const pluginId = options.pluginId ?? "test.mock";
  let activeWorktree: PluginWorktreeSnapshot | null = options.activeWorktree ?? null;
  let worktrees: PluginWorktreeSnapshot[] = options.worktrees ?? [];

  const registeredActions: RegisteredActionRecord[] = [];
  const registeredHandlers: RegisteredHandlerRecord[] = [];
  const broadcastCalls: BroadcastRecord[] = [];
  const shownToasts: ShownToastRecord[] = [];
  const dispatchedActions: DispatchedActionRecord[] = [];
  const registeredForgeProviders: RegisteredForgeProviderRecord[] = [];
  const registeredFileDecorationProviders: RegisteredFileDecorationProviderRecord[] = [];
  const invalidationCalls: InvalidationRecord[] = [];

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
    ): () => void {
      let subs = settingsSubs[scope].get(key);
      if (!subs) {
        subs = new Set();
        settingsSubs[scope].set(key, subs);
      }
      const cb = callback as (value: unknown) => void;
      subs.add(cb);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const set = settingsSubs[scope].get(key);
        if (set) {
          set.delete(cb);
          if (set.size === 0) settingsSubs[scope].delete(key);
        }
      };
    },
  };

  const host: PluginHostApi & MockHostState = {
    pluginId,
    registerAction(descriptor, handler) {
      // Mirrors PluginService.createHost L1577-L1631. Validation order matches
      // production: non-object descriptor, non-function handler, non-empty
      // string id, plugin-prefix not already in id. Re-registering the same id
      // replaces the prior descriptor + handler (replace-by-id, see
      // host-api.md). A plugin test that calls registerAction with the same id
      // twice should see the second call win, not accumulate two entries.
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
      const existing = registeredActions.findIndex((r) => r.descriptor.id === descriptor.id);
      if (existing >= 0) {
        registeredActions[existing] = { descriptor, handler };
      } else {
        registeredActions.push({ descriptor, handler });
      }
    },
    registerHandler<TArgs = unknown, TResult = unknown>(
      channel: string,
      schemaOrHandler: PluginChannelSchema<TArgs, TResult> | PluginIpcHandler,
      handler?: PluginTypedIpcHandler<TArgs, TResult>
    ) {
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
    },
    broadcastToRenderer(channel, payload) {
      broadcastCalls.push({ channel, payload });
    },
    async getActiveWorktree() {
      return activeWorktree;
    },
    async getWorktrees() {
      return worktrees;
    },
    onDidChangeActiveWorktree(callback) {
      activeWorktreeSubs.add(callback);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        activeWorktreeSubs.delete(callback);
      };
    },
    onDidChangeWorktrees(callback) {
      worktreesSubs.add(callback);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        worktreesSubs.delete(callback);
      };
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
      return () => {
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
      return () => {
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
    },
    invalidateFileDecorations(scope, paths) {
      invalidationCalls.push({ scope, paths });
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
    settings,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },

    registeredActions,
    registeredHandlers,
    broadcastCalls,
    shownToasts,
    dispatchedActions,
    registeredForgeProviders,
    registeredFileDecorationProviders,
    invalidationCalls,

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
