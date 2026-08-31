import type {
  PluginHostBinding,
  PluginManifest,
  PluginOrigin,
} from "../../../shared/types/plugin.js";

export interface ValidateFn {
  (data: unknown): boolean;
  $async?: boolean;
  errors?: Array<{ instancePath: string; message?: string }>;
}

export interface LoadedPlugin {
  /** Deep-frozen at load (see `deepFreeze` call in `loadPlugin`); `Readonly` is the compile-time half of that invariant. */
  manifest: Readonly<PluginManifest>;
  dir: string;
  resolvedMain?: string;
  loadedAt: number;
  isBuiltin: boolean;
  /**
   * Which root this instance was discovered under. `isBuiltin` still answers
   * "does it run on the in-process loader?"; this answers "where did it come
   * from?", which is the question the three roots could not express once a
   * fourth, project-owned one existed.
   */
  origin?: PluginOrigin;
  /**
   * The project this instance belongs to, captured at load and handed to every
   * host closure. Absent (or unbound) for installed and builtin plugins, which
   * stay app-global by design.
   */
  binding?: PluginHostBinding;
  /** SHA-256 hex digest of the `.dntr` archive, set by the installer at install time. */
  archiveHash?: string;
  /**
   * True when the plugin dir carries a dev marker file (written by
   * `daintree-plugin dev`). Dev plugins activate inside a `utilityProcess.fork`
   * worker that hot-reloads on `dist/index.js` rebuilds (#9304), instead of the
   * in-process `import()` loader.
   */
  devMode?: boolean;
  /**
   * Virtual `__dtv-N` namespace segment minted once per load and shared by every
   * view this plugin contributes (#11301), so a reload swaps the whole plugin's
   * view modules together and relative imports inherit the generation.
   */
  viewGeneration: number;
  /**
   * Second generation, minted lazily the first time a renderer reports an
   * import-stage failure for one of this plugin's views (#11728). A rejected
   * dynamic import is permanent for its specifier, so recovery needs a URL V8
   * has never seen. Allocated at most once per load and shared by every view,
   * which bounds a plugin to two namespaces however many times the user retries.
   */
  recoveryViewGeneration?: number;
}

export type WorkspaceWorktreeEvent = "worktree-update" | "worktree-activated" | "worktree-removed";

/**
 * Capability class of an expanded `scopes.fs.allowedPaths` root. Project /
 * worktree roots gate on `fs:project-*`; the implicit per-plugin data dir and
 * any path under the user's home dir gate on `fs:user-data-*`.
 */
export type FsRootClass = "project" | "user-data";

/** An `allowedPaths` entry after token expansion, with its capability class. */
export interface ExpandedFsPath {
  path: string;
  rootClass: FsRootClass;
}
