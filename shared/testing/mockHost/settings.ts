/**
 * Settings, private storage, accounts, cross-plugin services and databases for
 * `createMockHost`: the values a test seeds, the scopes they resolve to, and
 * the subscribers that hear them change.
 */

import {
  DEFAULT_PLUGIN_CONNECTION_ID,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../../types/plugin.js";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { formatErrorMessage } from "../../utils/errorMessage.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { databaseError, openPluginDatabase } from "../../utils/pluginDatabaseHandle.js";
import type {
  PluginServiceCallContext,
  PluginServiceResult,
  PluginServiceStatus,
  PluginServicesApi,
} from "../../types/pluginServices.js";
import type {
  PluginDatabaseLocation,
  PluginSettingsScope,
  PluginStorageScope,
  PluginAccountAccessToken,
  PluginAccountState,
  SettingsApi,
  StorageApi,
} from "../../types/plugin.js";
import type { MockHostIdentity } from "./identity.js";
import type {
  DispatchedActionRecord,
  ServiceCallRecord,
  CreateMockHostOptions,
  MockHost,
} from "./types.js";

export type SettingsMembers = Pick<
  MockHost,
  "db" | "services" | "account" | "settings" | "storage" | "serviceCalls" | "simulateAccountChange"
>;

export interface SettingsFacet {
  members: SettingsMembers;
}

export function createSettingsFacet(
  identity: MockHostIdentity,
  options: CreateMockHostOptions,
  collaborators: {
    activeWorktreePath(): string | undefined;
    recordDispatch(record: DispatchedActionRecord): void;
  }
): SettingsFacet {
  const { pluginId } = identity;
  const { activeWorktreePath, recordDispatch } = collaborators;
  const serviceCalls: ServiceCallRecord[] = [];
  // Connections by id. The mock has no manifest, so a call without
  // `ref.connection` means `"default"`, the id `contributes.account` gets.
  const accountSubs = new Set<{
    connection: string;
    cb: (state: PluginAccountState) => unknown;
  }>();
  const accountConnections = new Map<
    string,
    { token: PluginAccountAccessToken; identity: string | null }
  >();
  if (options.account?.accessToken) {
    accountConnections.set(options.account.connection ?? DEFAULT_PLUGIN_CONNECTION_ID, {
      token: {
        accessToken: options.account.accessToken,
        expiresAt: options.account.expiresAt ?? null,
      },
      identity: options.account.identity ?? null,
    });
  }
  const accountConnectionOf = (ref: { connection?: string } | undefined): string =>
    ref?.connection ?? DEFAULT_PLUGIN_CONNECTION_ID;
  const accountStateOf = (connection: string): PluginAccountState => {
    const stored = accountConnections.get(connection);
    return { connected: stored !== undefined, identity: stored?.identity ?? null };
  };
  const settingsStore: Record<PluginSettingsScope, Map<string, unknown>> = {
    user: new Map(Object.entries(options.settings?.user ?? {})),
    project: new Map(Object.entries(options.settings?.project ?? {})),
    local: new Map(Object.entries(options.settings?.local ?? {})),
  };

  const settingsSubs: Record<PluginSettingsScope, Map<string, Set<(value: unknown) => void>>> = {
    user: new Map(),
    project: new Map(),
    local: new Map(),
  };

  // `user`/`project` scopes are flat maps; `worktree` scope is isolated per
  // active worktree path (#10578). Production resolves a different storage file
  // per worktree, so a value written under worktree A is invisible after
  // `simulateActiveWorktreeChange(B)`. The sub-map is created lazily on first
  // write; the read path returns `undefined` for an unseen worktree.
  const userProjectStore: Record<"user" | "project", Map<string, unknown>> = {
    user: new Map(Object.entries(options.storage?.user ?? {})),
    project: new Map(Object.entries(options.storage?.project ?? {})),
  };
  const worktreeStorageByPath = new Map<string, Map<string, unknown>>();
  // Seed the worktree scope into the initial active worktree's sub-map. With no
  // active worktree there is no target (production would throw on `set`), so the
  // seed is silently dropped rather than placed in an anonymous map.
  const seedWorktreePath = activeWorktreePath();
  if (seedWorktreePath !== undefined && options.storage?.worktree) {
    worktreeStorageByPath.set(seedWorktreePath, new Map(Object.entries(options.storage.worktree)));
  }
  /** The storage sub-map for the active worktree, created on demand. */
  const worktreeStore = (): Map<string, unknown> | null => {
    const worktreePath = activeWorktreePath();
    if (worktreePath === undefined) return null;
    let store = worktreeStorageByPath.get(worktreePath);
    if (!store) {
      store = new Map();
      worktreeStorageByPath.set(worktreePath, store);
    }
    return store;
  };

  // Subscriptions stay keyed by storage key (not worktree path) for every
  // scope, matching production: a worktree-scope `onDidChange` survives a
  // worktree switch and then fires for the now-active worktree's value.
  const storageSubs: Record<PluginStorageScope, Map<string, Set<(value: unknown) => void>>> = {
    user: new Map(),
    project: new Map(),
    worktree: new Map(),
  };

  // Resolve the declared scope for a key from the opt-in `manifestSettings`,
  // mirroring PluginSettingsManager.getDeclaredScope. Returns undefined when no
  // declarations are provided (loose mode) or the key is undeclared.
  const getDeclaredSettingScope = (key: string): PluginSettingsScope | undefined => {
    const def = options.manifestSettings?.find((s) => s.id === key);
    return def ? ((def.scope ?? "user") as PluginSettingsScope) : undefined;
  };

  // The scope a call targets: the declared one when omitted; a conflicting
  // explicit scope throws, as the real host's write and subscribe guards do.
  const resolveSettingScope = (
    method: string,
    key: string,
    requested: PluginSettingsScope | undefined
  ): PluginSettingsScope => {
    const declared = getDeclaredSettingScope(key);
    if (requested !== undefined && declared !== undefined && requested !== declared) {
      throw new Error(
        `settings.${method}: key "${key}" is declared in "${declared}" scope, not "${requested}"`
      );
    }
    return requested ?? declared ?? "user";
  };

  const getDeclaredSettingDefault = (key: string): unknown => {
    const declared = options.manifestSettings?.find((s) => s.id === key)?.default;
    return declared === undefined ? undefined : (JSON.parse(JSON.stringify(declared)) as unknown);
  };

  const settings: SettingsApi = {
    async get<T = unknown>(key: string, scope?: PluginSettingsScope): Promise<T | undefined> {
      // Manifest-aware mode: a declared key resolves to its declared scope, and an
      // explicit conflicting scope throws — matching the real host (#10586). Loose
      // mode (no manifestSettings) keeps the `scope ?? "user"` default.
      const declaredScope = getDeclaredSettingScope(key);
      if (scope !== undefined && declaredScope !== undefined && declaredScope !== scope) {
        throw new Error(
          `settings.get: key "${key}" is declared in "${declaredScope}" scope, not "${scope}"`
        );
      }
      const effectiveScope = declaredScope ?? scope ?? "user";
      const stored = settingsStore[effectiveScope].get(key);
      return (stored !== undefined ? stored : getDeclaredSettingDefault(key)) as T | undefined;
    },
    async set<T = unknown>(
      key: string,
      value: T,
      requestedScope?: PluginSettingsScope
    ): Promise<void> {
      const scope = resolveSettingScope("set", key, requestedScope);
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
      requestedScope?: PluginSettingsScope
    ): Promise<() => void> {
      const scope = resolveSettingScope("onDidChange", key, requestedScope);
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
    // Recorded as the dispatch the real host sends, so a test asserts it the
    // same way it asserts any other `host.dispatch`.
    async open(key?: string): Promise<void> {
      if (key !== undefined && (typeof key !== "string" || key.length === 0)) {
        throw new Error("settings.open: key must be a non-empty string when given");
      }
      recordDispatch({
        actionId: "plugin.openSettings",
        args: key === undefined ? { pluginId } : { pluginId, key },
      });
    },
    // Declared keys only, as the real host: the declared scope is the target,
    // and subscribers hear the declared default when something was removed.
    async unset(key: string, requestedScope?: PluginSettingsScope): Promise<void> {
      const declaredScope = getDeclaredSettingScope(key);
      if (declaredScope === undefined) {
        throw new Error(`settings.unset: key "${key}" is not declared in contributes.settings`);
      }
      if (requestedScope !== undefined && requestedScope !== declaredScope) {
        throw new Error(
          `settings.unset: key "${key}" is declared in "${declaredScope}" scope, not "${requestedScope}"`
        );
      }
      if (!settingsStore[declaredScope].delete(key)) return;
      const subs = settingsSubs[declaredScope].get(key);
      if (subs) {
        // As the real host: one throwing listener does not hide the rest or fail the clear.
        for (const cb of subs) {
          try {
            cb(getDeclaredSettingDefault(key));
          } catch {
            /* isolated */
          }
        }
      }
    },
    // Manifest-aware only: with no `manifestSettings` nothing is declared, so
    // nothing can be required. A default never satisfies a required key.
    async missingRequired(): Promise<string[]> {
      return (options.manifestSettings ?? [])
        .filter((def) => def.required === true)
        .filter((def) => {
          const store = settingsStore[(def.scope ?? "user") as PluginSettingsScope];
          // As the real host: a secret is set once anything is stored — it is
          // never decrypted to look — while other values must be non-empty.
          if (def.type === "secret" || def.secret === true) return !store.has(def.id);
          const value = store.get(def.id);
          return value === undefined || value === null || value === "";
        })
        .map((def) => def.id);
    },
  };

  // Private machine-owned storage (#10556). Mirrors the settings mock but adds
  // the "worktree" scope and a `delete` method, and never gates on declared keys.
  // The "worktree" scope resolves its target from the current active worktree
  // (#10578): set with no active worktree throws (matching production's "no
  // active worktree" guard), get resolves undefined, and delete no-ops.
  const storage: StorageApi = {
    async get<T = unknown>(
      key: string,
      scope: PluginStorageScope = "user"
    ): Promise<T | undefined> {
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      // No active worktree resolves to undefined rather than throwing, matching
      // production's "unset key" return.
      if (!store) return undefined;
      return store.get(key) as T | undefined;
    },
    async set<T = unknown>(
      key: string,
      value: T,
      scope: PluginStorageScope = "user"
    ): Promise<void> {
      if (value === undefined) {
        throw new Error("storage.set: value cannot be undefined");
      }
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      if (!store) {
        // worktree scope with no active worktree — mirror production's message.
        throw new Error(
          `Plugin "${pluginId}" storage.set: no active ${scope} — "${scope}" scope has no target`
        );
      }
      const prev = store.get(key);
      const had = store.has(key);
      store.set(key, value);
      // Mirror the real store's `valuesEqual` (JSON) change detection rather than
      // `Object.is`, so two equal-but-distinct object literals fire onDidChange
      // exactly once — matching production, not reference identity.
      const changed = !had || !jsonEqual(prev, value);
      if (changed) {
        const subs = storageSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(value as unknown);
        }
      }
    },
    async delete(key: string, scope: PluginStorageScope = "user"): Promise<void> {
      const store = scope === "worktree" ? worktreeStore() : userProjectStore[scope];
      // No active worktree — a delete is a no-op rather than a throw (matching
      // production and the "already absent" return of the store).
      if (!store) return;
      const had = store.has(key);
      store.delete(key);
      if (had) {
        const subs = storageSubs[scope].get(key);
        if (subs) {
          for (const cb of subs) cb(undefined);
        }
      }
    },
    onDidChange<T = unknown>(
      key: string,
      callback: (value: T | undefined) => void,
      scope: PluginStorageScope = "user"
    ): Promise<() => void> {
      let subs = storageSubs[scope].get(key);
      if (!subs) {
        subs = new Set();
        storageSubs[scope].set(key, subs);
      }
      const cb = callback as (value: unknown) => void;
      subs.add(cb);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const set = storageSubs[scope].get(key);
        if (set) {
          set.delete(cb);
          if (set.size === 0) storageSubs[scope].delete(key);
        }
      };
      return Promise.resolve(dispose);
    },
  };
  let mockDatabaseDir: string | null = options.databases?.directory ?? null;
  const resolveMockDatabase = async (
    id: string,
    readonly = false
  ): Promise<PluginDatabaseLocation> => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Plugin "${pluginId}" db: id must be a non-empty string`);
    }
    const declared = options.databases?.declared;
    if (declared && !declared.includes(id)) {
      throw new Error(
        `DB_NOT_DECLARED: plugin "${pluginId}" db: "${id}" is not declared in contributes.databases`
      );
    }
    // Readonly locates an existing file and creates nothing, as the host does.
    const notFound = () => databaseError("DB_NOT_FOUND", `database "${id}" does not exist yet`);
    if (readonly && mockDatabaseDir === null) throw notFound();
    mockDatabaseDir ??= mkdtempSync(path.join(tmpdir(), "daintree-mock-db-"));
    if (!readonly) mkdirSync(mockDatabaseDir, { recursive: true });
    // Canonical, as the host's is: a directory swapped for a link after the
    // handle opened resolves elsewhere, and the handle then refuses to reopen.
    let realDir: string;
    try {
      realDir = realpathSync(mockDatabaseDir);
    } catch (error) {
      if (readonly && (error as NodeJS.ErrnoException).code === "ENOENT") throw notFound();
      throw error;
    }
    const target = path.join(realDir, `${id}.db`);
    const leaf = lstatSync(target, { throwIfNoEntry: false });
    if (leaf?.isSymbolicLink()) {
      throw databaseError("TARGET_IS_SYMLINK", `database "${id}" file is a symlink`);
    }
    if (leaf && !leaf.isFile()) {
      throw databaseError("TARGET_UNAVAILABLE", `database "${id}" is not a regular file`);
    }
    if (!leaf && readonly) throw notFound();
    const schemaVersion = Object.hasOwn(options.databases?.schemaVersions ?? {}, id)
      ? options.databases?.schemaVersions?.[id]
      : undefined;
    return Object.freeze({
      id,
      location: "local" as const,
      path: target,
      projectRelativePath: null,
      journalMode: options.databases?.journalMode ?? "delete",
      ...(schemaVersion !== undefined && { schemaVersion }),
    });
  };

  const members: SettingsMembers = {
    db: {
      resolve: (id, resolveOptions) => resolveMockDatabase(id, resolveOptions?.readonly === true),
      open: async (id, openOptions) =>
        openPluginDatabase(await resolveMockDatabase(id, openOptions?.readonly === true), {
          ...openOptions,
          revalidate: () => resolveMockDatabase(id, openOptions?.readonly === true),
          // The mock has no fs gate; it approves any absolute destination.
          prepareBackup: async (destPath) => {
            if (!path.isAbsolute(destPath)) {
              throw new Error(`Plugin "${pluginId}" db.backup: destination must be absolute`);
            }
            // The real host returns the realpath form, which the handle checks.
            return path.join(realpathSync(path.dirname(destPath)), path.basename(destPath));
          },
        }),
    },
    services: {
      call: (async (
        name: string,
        method: string,
        args: unknown,
        callOptions?: { signal?: AbortSignal }
      ) => {
        serviceCalls.push({ name, method, args });
        const fail = (
          reason: Extract<PluginServiceResult, { ok: false }>["reason"],
          message: string
        ): PluginServiceResult => ({ ok: false, reason, message });
        const provider = options.services?.[name];
        if (!provider) return fail("unavailable", `no enabled plugin provides "${name}"`);
        const fn = Object.hasOwn(provider.methods, method) ? provider.methods[method] : undefined;
        if (typeof fn !== "function") return fail("invalid", `"${name}" has no method "${method}"`);
        const signal = callOptions?.signal;
        if (signal?.aborted) return fail("cancelled", "the call was cancelled");
        let copied: unknown;
        try {
          copied = structuredClone(args);
        } catch (err) {
          return fail("invalid", formatErrorMessage(err, "the arguments can't be copied"));
        }
        // As in production, the caller is settled the moment it cancels; the
        // provider sees the abort on its own signal.
        const controller = new AbortController();
        const ctx: PluginServiceCallContext = {
          signal: controller.signal,
          caller: {
            pluginId: pluginManifestIdFromInstanceKey(pluginId),
            projectId: projectIdFromPluginInstanceKey(pluginId),
          },
        };
        let onAbort: (() => void) | undefined;
        const cancelled = new Promise<PluginServiceResult>((resolve) => {
          onAbort = () => {
            controller.abort();
            resolve(fail("cancelled", "the call was cancelled"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        const answered = (async (): Promise<PluginServiceResult> => {
          let value: unknown;
          try {
            value = await fn(copied, ctx);
          } catch (err) {
            // Cancelled first, even when the provider threw after the abort.
            if (signal?.aborted) return fail("cancelled", "the call was cancelled");
            return fail("provider-error", formatErrorMessage(err, "the provider failed"));
          }
          if (signal?.aborted) return fail("cancelled", "the call was cancelled");
          try {
            return { ok: true, value: structuredClone(value) };
          } catch (err) {
            return fail("invalid", formatErrorMessage(err, "the result can't be copied"));
          }
        })();
        try {
          return await Promise.race([answered, cancelled]);
        } finally {
          if (onAbort) signal?.removeEventListener("abort", onAbort);
        }
      }) as PluginServicesApi["call"],
      status: async (name): Promise<PluginServiceStatus> => {
        const provider = options.services?.[name];
        if (!provider) {
          return {
            available: false,
            required: true,
            reason: "unavailable",
            message: `no enabled plugin provides "${name}"`,
          };
        }
        return {
          available: true,
          required: true,
          running: true,
          provider: {
            pluginId: name.slice(0, name.lastIndexOf(".")),
            projectId: null,
            version: provider.version ?? "1.0.0",
            methods: Object.keys(provider.methods),
            capabilities: [...(provider.capabilities ?? [])],
          },
        };
      },
    },
    account: {
      getState: async (ref) => accountStateOf(accountConnectionOf(ref)),
      getAccessToken: async (ref) => {
        const stored = accountConnections.get(accountConnectionOf(ref));
        return stored ? { ...stored.token } : null;
      },
      onDidChange(callback, ref) {
        if (typeof callback !== "function") {
          throw new Error("account.onDidChange: callback must be a function");
        }
        const registered = {
          connection: accountConnectionOf(ref),
          cb: (state: PluginAccountState): unknown => callback(state),
        };
        accountSubs.add(registered);
        return () => {
          accountSubs.delete(registered);
        };
      },
    },
    settings,
    storage,
    serviceCalls,
    simulateAccountChange(account) {
      const connection = account.connection ?? DEFAULT_PLUGIN_CONNECTION_ID;
      if (account.connected) {
        const previous = accountConnections.get(connection);
        accountConnections.set(connection, {
          token: {
            accessToken: account.accessToken ?? previous?.token.accessToken ?? "mock-access-token",
            expiresAt: account.expiresAt ?? null,
          },
          identity: account.identity ?? null,
        });
      } else {
        accountConnections.delete(connection);
      }
      const state = accountStateOf(connection);
      // One failing subscriber doesn't stop the rest, as in the real host.
      for (const { connection: heard, cb } of [...accountSubs]) {
        if (heard !== connection) continue;
        try {
          const result: unknown = cb({ ...state });
          if (result instanceof Promise) {
            result.catch((err: unknown) =>
              console.error("account.onDidChange callback failed", err)
            );
          }
        } catch (err) {
          console.error("account.onDidChange callback failed", err);
        }
      }
    },
  };

  return { members };
}

/**
 * Value equality matching `PluginSettingsStore.valuesEqual`: reference-equal or
 * JSON-equal. Used by the storage mock so its change detection (and therefore
 * its onDidChange firing) matches the real store rather than reference identity.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
