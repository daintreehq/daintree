import type { PluginManifest } from "../../../shared/types/plugin.js";

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
  /** SHA-256 hex digest of the `.dntr` archive, set by the installer at install time. */
  archiveHash?: string;
  /**
   * True when the plugin dir carries a dev marker file (written by
   * `daintree-plugin dev`). Dev plugins activate inside a `utilityProcess.fork`
   * worker that hot-reloads on `dist/index.js` rebuilds (#9304), instead of the
   * in-process `import()` loader.
   */
  devMode?: boolean;
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
