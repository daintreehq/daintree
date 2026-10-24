import path from "path";

import { assertPluginCallerDrives } from "./pluginDriveLease.js";
import { assertSettingsKey } from "./PluginSettingsManager.js";
import { assertStorageKey, type ExplicitStorageTarget } from "./PluginStorageManager.js";
import {
  checkedSchemaOptions,
  openPluginDatabase,
  resolvePluginDatabaseLocation,
} from "./pluginDatabase.js";
import {
  type PluginDatabaseApi,
  type PluginDatabaseContribution,
} from "../../../shared/types/plugin.js";
import {
  databaseBackupApprovers,
  databaseWriteAuthorizers,
  fsWriteApprovers,
} from "./pluginInternalApprovers.js";

import type {
  PluginHostApi,
  PluginWorktreesResult,
  PluginSettingsScope,
  PluginStorageScope,
  PluginHostBinding,
} from "../../../shared/types/plugin.js";
import type { LoadedPlugin } from "./PluginServiceTypes.js";
import {
  type PluginHostFactoryDeps,
  trackPluginDisposer,
  ensureCapabilityConsent,
} from "./pluginHostDeps.js";
import type { PluginEventScope } from "./pluginEventScope.js";
import type { PluginRendererDispatcher } from "./PluginRendererDispatcher.js";
import type { PluginFsApi } from "../../../shared/types/plugin.js";

/**
 * A `host.account` call's `ref`, checked at the boundary: an object whose two
 * optional fields are strings. Which project and connection it means is
 * decided by the account service alone.
 */
function accountRef(
  pluginId: string,
  method: string,
  ref: unknown
): { connection?: string; projectId?: string } {
  if (ref === undefined) return {};
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    throw new Error(`Plugin "${pluginId}" account.${method}: ref must be an object`);
  }
  const { connection, projectId } = ref as Record<string, unknown>;
  if (connection !== undefined && typeof connection !== "string") {
    throw new Error(`Plugin "${pluginId}" account.${method}: ref.connection must be a string`);
  }
  if (projectId !== undefined && typeof projectId !== "string") {
    throw new Error(`Plugin "${pluginId}" account.${method}: ref.projectId must be a string`);
  }
  return {
    ...(connection !== undefined ? { connection } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

/**
 * Per plugin registry, the newest instance registered or hosted under each id —
 * kept past that instance's unload, so a host from an older generation stays
 * retired from settings writes (#14092).
 */
const newestInstances = new WeakMap<PluginHostFactoryDeps["plugins"], Map<string, LoadedPlugin>>();

/**
 * Record `plugin` as the newest instance under `pluginId`. Called as it enters
 * the registry, so a successor that never makes a host (a lazy plugin whose
 * secret was saved from the settings form) still retires its predecessor's hosts.
 */
export function noteNewestPluginInstance(
  plugins: PluginHostFactoryDeps["plugins"],
  pluginId: string,
  plugin: LoadedPlugin
): void {
  let byId = newestInstances.get(plugins);
  if (!byId) {
    byId = new Map();
    newestInstances.set(plugins, byId);
  }
  byId.set(pluginId, plugin);
}

/** What the settings, account and storage surface reads from `createHost`. */
export interface PluginHostSettingsContext {
  readonly boundPlugin: PluginEventScope["boundPlugin"];
  readonly boundProjectId: PluginHostBinding["projectId"];
  readonly boundProjectRoot: PluginHostBinding["projectRoot"];
  /** The manifest frozen at registration, or `undefined` to read the live one. */
  readonly declaring: LoadedPlugin["manifest"] | undefined;
  readonly deps: Pick<
    PluginHostFactoryDeps,
    "accounts" | "pluginDataDir" | "pluginEventCleanups" | "plugins" | "settings" | "storage"
  >;
  /** Delivers this plugin's pending pushes before each renderer round-trip. */
  readonly dispatcher: PluginRendererDispatcher;
  /** The host's own `host.fs`; database backups are approved through this same object. */
  readonly fsApi: PluginFsApi;
  readonly getWorktreesResult: () => Promise<PluginWorktreesResult>;
  readonly isBound: PluginEventScope["isBound"];
  /** True once `activate()` has returned; activation-only registrations refuse after it. */
  readonly isRevoked: () => boolean;
  readonly manifestId: string;
  readonly pluginId: string;
}

/**
 * The host's accounts, settings, databases and storage, with their project
 * and worktree targets resolved from the host's binding.
 */
export function buildSettingsHostApi(
  ctx: PluginHostSettingsContext
): Pick<PluginHostApi, "account" | "settings" | "db" | "storage"> {
  const {
    boundPlugin,
    boundProjectId,
    boundProjectRoot,
    declaring,
    deps,
    dispatcher,
    fsApi,
    getWorktreesResult,
    isBound,
    isRevoked,
    manifestId,
    pluginId,
  } = ctx;
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

  const assertAccountHostLoaded = (method: string): void => {
    if (!isBound()) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" account.${method}: plugin is no longer loaded`
      );
    }
  };

  const assertSettingsInstanceCurrent = (method: string): void => {
    if (boundPlugin === undefined) return;
    const current = deps.plugins.get(pluginId);
    // A successor that has since unloaded still retires this instance: its
    // own settings, perhaps a secret this instance declared ordinary, stay on disk.
    const superseded =
      (current !== undefined && current !== boundPlugin) ||
      newestInstances.get(deps.plugins)?.get(pluginId) !== boundPlugin;
    if (superseded) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" settings.${method}: this instance was replaced by a reload; only the running instance can change its settings`
      );
    }
  };
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

  // By identity, not id: a host kept by a plugin that has since reloaded
  // must not reach the new instance's declarations or register handles on it.
  const requireBoundForDb = (op: string): void => {
    if (!isBound()) {
      throw new Error(`PLUGIN_UNLOADED: plugin "${pluginId}" ${op}: plugin is no longer loaded`);
    }
  };
  const prepareDatabaseBackup = async (id: string, destPath: string): Promise<string> => {
    await resolveDatabase(id, { readonly: true });
    const approve = fsWriteApprovers.get(fsApi);
    if (!approve) throw new Error(`Plugin "${pluginId}" db.backup: unavailable`);
    const approved = await approve(`db.backup:${id}`, destPath);
    requireBoundForDb("db.backup");
    return approved;
  };

  const declaredDatabase = (id: string) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Plugin "${pluginId}" db: id must be a non-empty string`);
    }
    requireBoundForDb("db");
    const declaration = (boundPlugin?.manifest.contributes.databases ?? []).find(
      (d) => d.id === id
    );
    if (!declaration) {
      throw new Error(
        `DB_NOT_DECLARED: plugin "${pluginId}" db: "${id}" is not declared in contributes.databases`
      );
    }
    return declaration;
  };

  // Writing a project database changes the repository, so a call from a view
  // that watches the project is refused as its `host.fs` writes are. Asked on
  // every write, not once at open: a handle outlives the lease it was opened
  // under. A local database is in no project and passes. The file's own path,
  // not the bound root, since it may sit in a nested project; worked out as
  // the resolver will, so it can be asked before anything is created.
  // A held handle also names the file it resolved, since a link on the way
  // may have moved since.
  const requireCallerDrivesDatabase = async (
    declaration: PluginDatabaseContribution,
    op: string,
    openedPath?: string
  ): Promise<void> => {
    if (declaration.location !== "project" || boundProjectRoot === null) return;
    const target = path.resolve(
      boundProjectRoot,
      declaration.path ?? `.daintree/data/${manifestId}/${declaration.id}.db`
    );
    const paths =
      openedPath !== undefined && openedPath !== target ? [target, openedPath] : [target];
    await assertPluginCallerDrives(pluginId, `db.${op}`, { paths });
    requireBoundForDb(`db.${op}`);
  };

  const resolveDatabase = async (id: string, options?: { readonly?: boolean }) => {
    const readonly = options?.readonly === true;
    const declaration = declaredDatabase(id);
    // Before consent and the directory: a refused open creates nothing.
    if (!readonly) await requireCallerDrivesDatabase(declaration, "open");
    // A project database is a file in the repository: creating its directory,
    // the file, and every migration are project writes, so they wait for the
    // same first-use consent `host.fs.writeFile` does. A local database is
    // plugin-private state, like `host.storage`, and needs none.
    // A read-only open creates and writes nothing, so it needs no consent.
    if (declaration.location === "project" && !readonly) {
      await ensureCapabilityConsent(deps, pluginId, "fs:project-write");
      requireBoundForDb("db");
      // Control may have moved while the prompt waited.
      await requireCallerDrivesDatabase(declaration, "open");
    }
    const location = await resolvePluginDatabaseLocation({
      declaration,
      manifestId,
      projectRoot: boundProjectRoot,
      dataDir: deps.pluginDataDir(pluginId),
      existingOnly: readonly,
    });
    requireBoundForDb("db");
    return location;
  };

  const authorizeDatabaseWrite = (id: string, openedPath?: string): Promise<void> => {
    if (
      openedPath !== undefined &&
      (typeof openedPath !== "string" || !path.isAbsolute(openedPath))
    ) {
      return Promise.reject(new Error(`Plugin "${pluginId}" db: path must be an absolute path`));
    }
    return requireCallerDrivesDatabase(declaredDatabase(id), "write", openedPath);
  };

  const dbApi: PluginDatabaseApi = {
    resolve: (id: string, options?: { readonly?: boolean }) => resolveDatabase(id, options),
    open: async (id, options) => {
      const mode = { readonly: options?.readonly === true };
      // Schema options are checked before resolveDatabase prompts for
      // project-write consent, so a malformed open never banks a grant (#10524).
      const schema = checkedSchemaOptions(id, options);
      const location = await resolveDatabase(id, mode);
      let untrack: (() => void) | null = null;
      const database = await openPluginDatabase(location, {
        ...options,
        ...schema,
        revalidate: () => resolveDatabase(id, mode),
        authorizeWrite: () => authorizeDatabaseWrite(id, location.path),
        prepareBackup: (destPath) => prepareDatabaseBackup(id, destPath),
        onClosed: () => untrack?.(),
      });
      if (!isBound()) {
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
  };
  databaseBackupApprovers.set(dbApi, prepareDatabaseBackup);
  databaseWriteAuthorizers.set(dbApi, authorizeDatabaseWrite);

  return {
    // NOT revoke-guarded: a plugin asks for a token from timers and callbacks.
    // Signing in and out are not here at all — only the host's settings row
    // can start either.
    // `ref.projectId` is resolved once, in the account service: a project
    // plugin's host may only name its own project, an installed plugin's names
    // the project it is acting in.
    account: {
      getState: async (ref) => {
        assertAccountHostLoaded("getState");
        return deps.accounts.getStateFor(pluginId, accountRef(pluginId, "getState", ref));
      },
      getAccessToken: async (ref) => {
        assertAccountHostLoaded("getAccessToken");
        const token = await deps.accounts.getAccessTokenFor(
          pluginId,
          accountRef(pluginId, "getAccessToken", ref)
        );
        // A token read that outlives an unload or reload doesn't reach a host
        // that no longer speaks for the plugin.
        assertAccountHostLoaded("getAccessToken");
        return token;
      },
      onDidChange: (callback, ref) => {
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" account.onDidChange: callback must be a function`);
        }
        const target = accountRef(pluginId, "onDidChange", ref);
        // An undeclared account never changes. Same answer in a worker, which
        // can't see the manifest to refuse synchronously.
        if (!isBound() || !deps.accounts.declaredAccount(pluginId)) return () => {};
        const unsubscribe = deps.accounts.subscribe(
          pluginId,
          (state) => (isBound() ? callback(state) : undefined),
          target
        );
        return trackPluginDisposer(deps.pluginEventCleanups, pluginId, unsubscribe);
      },
    },
    // NOT revoke-guarded: plugins read/write settings throughout their
    // lifetime (IPC handlers, timers), long after activate() resolves. The
    // store is the source of truth, so a late call is harmless.
    //
    // Every settings call classifies its key from `declaring` — the frozen
    // manifest of the instance this host was made for — never the live one, so
    // an unload mid-call can't turn a secret into plaintext or move a key into
    // another scope (#14092). An unloaded instance's writes still land (a
    // deactivate() saving state); a replaced one's never commit, since the
    // instance now running may declare the key differently.
    settings: {
      get: async <T = unknown>(
        key: string,
        scope?: PluginSettingsScope
      ): Promise<T | undefined> => {
        assertSettingsKey(pluginId, "get", key);
        // Resolve the manifest-declared scope so a read targets the same scope
        // the write path enforces — otherwise a `scope: "project"` key read
        // with no scope arg silently reads the wrong ("user") store (#10586).
        const declaredScope = deps.settings.getDeclaredScope(pluginId, key, declaring);
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
          boundScopeRoot,
          declaring
        );
        // Project scope with no active project reads as unset rather than
        // throwing; unset reads as the declared default, if there is one.
        const stored = filePath
          ? await deps.settings
              .getOrCreateSettingsStore(pluginId, filePath)
              .get<T>(key, { secret: deps.settings.isSecretKey(pluginId, key, declaring) })
          : undefined;
        return stored !== undefined
          ? stored
          : (deps.settings.getDeclaredDefault(pluginId, key, declaring) as T | undefined);
      },
      set: async <T = unknown>(
        key: string,
        value: T,
        requestedScope?: PluginSettingsScope
      ): Promise<void> => {
        assertSettingsKey(pluginId, "set", key);
        assertSettingsInstanceCurrent("set");
        // Omitted, the declared scope is the target, as it is for `get`; a
        // conflicting explicit scope still throws in assertSettingDeclared.
        const scope =
          requestedScope ?? deps.settings.getDeclaredScope(pluginId, key, declaring) ?? "user";
        if (value === undefined) {
          throw new Error(
            `Plugin "${pluginId}" settings.set: value for "${key}" is undefined — settings cannot store undefined`
          );
        }
        deps.settings.assertSettingSerializable(pluginId, key, value);
        deps.settings.assertSettingDeclared(pluginId, key, scope, declaring);
        const secret = deps.settings.isSecretKey(pluginId, key, declaring);
        const filePath = deps.settings.resolveSettingsFilePathForKey(
          pluginId,
          key,
          scope,
          boundScopeRoot,
          declaring
        );
        if (!filePath) {
          throw new Error(
            `Plugin "${pluginId}" settings.set: no active project — "project" scope has no target`
          );
        }
        // Project settings live in the repository's `.daintree`; user and local
        // files, outside every project, change none.
        await assertPluginCallerDrives(pluginId, "settings.set", { paths: [filePath] });
        assertSettingsInstanceCurrent("set");
        const store = deps.settings.getOrCreateSettingsStore(pluginId, filePath);
        const changed = await store.set(key, value, { secret });
        if (changed) deps.settings.notifySettingsSubscribers(pluginId, scope, key, value);
      },
      unset: async (key: string, requestedScope?: PluginSettingsScope): Promise<void> => {
        assertSettingsKey(pluginId, "unset", key);
        assertSettingsInstanceCurrent("unset");
        // Unlike `set`, only a declared key can be cleared: the scope it lives in
        // is the manifest's, so nothing here guesses a file to delete from.
        const declaredScope = deps.settings.getDeclaredScope(pluginId, key, declaring);
        if (declaredScope === undefined) {
          throw new Error(
            `Plugin "${pluginId}" settings.unset: key "${key}" is not declared in contributes.settings`
          );
        }
        if (requestedScope !== undefined && requestedScope !== declaredScope) {
          throw new Error(
            `Plugin "${pluginId}" settings.unset: key "${key}" is declared in "${declaredScope}" scope, not "${requestedScope}"`
          );
        }
        const filePath = deps.settings.resolveSettingsFilePathForKey(
          pluginId,
          key,
          declaredScope,
          boundScopeRoot,
          declaring
        );
        // No active project means nothing is stored there to clear.
        if (!filePath) return;
        // Same guard as `set`: project settings live in the repository's `.daintree`.
        await assertPluginCallerDrives(pluginId, "settings.unset", { paths: [filePath] });
        assertSettingsInstanceCurrent("unset");
        const store = deps.settings.getOrCreateSettingsStore(pluginId, filePath);
        // A secret is an encrypted envelope in the same file, so deleting the
        // key clears it without decrypting anything.
        const changed = await store.delete(key);
        if (changed)
          deps.settings.notifySettingsSubscribers(pluginId, declaredScope, key, undefined);
      },
      onDidChange: <T = unknown>(
        key: string,
        callback: (value: T | undefined) => void,
        requestedScope?: PluginSettingsScope
      ): Promise<() => void> => {
        const scope = requestedScope ?? deps.settings.getDeclaredScope(pluginId, key) ?? "user";
        if (isRevoked()) {
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
      // Always this plugin's own settings: the id is the closure's, never the
      // caller's, and a bound host reaches only its own project's renderer —
      // the same routing `dispatch` uses, so a project plugin cannot open
      // another project's settings.
      open: async (key?: string): Promise<void> => {
        if (key !== undefined) assertSettingsKey(pluginId, "open", key);
        if (!deps.plugins.has(pluginId)) {
          throw new Error(`Plugin "${pluginId}" settings.open: plugin is no longer loaded`);
        }
        const result = await dispatcher.sendDispatchToRenderer(
          "plugin.openSettings",
          key === undefined ? { pluginId } : { pluginId, key },
          boundProjectId
        );
        if (!result.ok) {
          throw new Error(`Plugin "${pluginId}" settings.open: ${result.error.message}`);
        }
      },
      missingRequired: (): Promise<string[]> =>
        deps.settings.missingRequiredForHost(pluginId, boundScopeRoot),
    },
    // Private machine-owned key/value storage (#10556). NOT revoke-guarded
    // (except onDidChange): plugins read/write storage throughout their
    // lifetime. The "worktree"/"project" scopes resolve their target
    // asynchronously, so set/delete re-check liveness after the await — a
    // plugin unloaded mid-resolution silently no-ops rather than writing into
    // a torn-down plugin's file (lessons #9322/#9428/#9533).
    db: dbApi,
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
        // Project and worktree storage lives in the repository's `.daintree`;
        // user storage is in no project unless one holds the storage dir.
        await assertPluginCallerDrives(pluginId, "storage.set", { paths: [filePath] });
        if (!isBound()) return;
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
        await assertPluginCallerDrives(pluginId, "storage.delete", { paths: [filePath] });
        if (!isBound()) return;
        const store = deps.storage.getOrCreateStorageStore(pluginId, scope, filePath);
        const changed = await store.delete(key);
        if (changed) deps.storage.notifyStorageSubscribers(pluginId, scope, key, undefined);
      },
      onDidChange: <T = unknown>(
        key: string,
        callback: (value: T | undefined) => void,
        scope: PluginStorageScope = "user"
      ): Promise<() => void> => {
        if (isRevoked()) {
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
}
