// Main-side half of `host.db`: turn a `contributes.databases` declaration into
// an absolute path, proving the file cannot land outside the project root (or
// the plugin's data dir) through a symlinked ancestor. The connection itself is
// opened by the shared handle wherever the plugin's code runs.

import fsp from "node:fs/promises";
import path from "node:path";
import type { PluginDatabaseLocation } from "../../../shared/types/plugin.js";
import { databaseError } from "../../../shared/utils/pluginDatabaseHandle.js";

export { openPluginDatabase } from "../../../shared/utils/pluginDatabaseHandle.js";

export interface PluginDatabaseDeclaration {
  id: string;
  location: "project" | "local";
  path?: string;
  journalMode: "delete" | "wal";
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Create `dir` (recursively) only if every ancestor that already exists
 * resolves inside `realRoot`. Checking the deepest existing ancestor is what
 * refuses a committed symlink — `data -> /Users/me/elsewhere` — before mkdir
 * follows it and materialises directories outside the project. `refuse` sees
 * the canonical form `dir` will have, also before anything is created.
 */
async function mkdirContained(
  realRoot: string,
  dir: string,
  label: string,
  refuse?: (canonicalDir: string) => void
): Promise<string> {
  let probe = dir;
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      if (!isInside(realRoot, real)) {
        throw databaseError(
          "PATH_NOT_ALLOWED",
          `database "${label}" resolves outside its root through ${probe}`
        );
      }
      refuse?.(path.join(real, path.relative(probe, dir)));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  await fsp.mkdir(dir, { recursive: true });
  const realDir = await fsp.realpath(dir);
  if (!isInside(realRoot, realDir)) {
    throw databaseError(
      "PATH_NOT_ALLOWED",
      `database "${label}" directory resolves outside its root`
    );
  }
  return realDir;
}

async function existingContainedDir(
  realRoot: string,
  dir: string,
  label: string,
  notFound: () => Error
): Promise<string> {
  const realDir = await fsp.realpath(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw notFound();
    throw error;
  });
  if (!isInside(realRoot, realDir)) {
    throw databaseError(
      "PATH_NOT_ALLOWED",
      `database "${label}" directory resolves outside its root`
    );
  }
  return realDir;
}

/**
 * Whether any segment of a root-relative path is the repository's `.git`,
 * compared case-insensitively because the common desktop filesystems are.
 * Checked on the canonical path too, so `data -> .git` cannot smuggle the
 * file into the git directory through a link that stays inside the project.
 */
function isInsideGitDir(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git");
}

/**
 * Resolve a declared database to an absolute path, creating its directory.
 * `projectRoot` is the plugin's bound project root; `dataDir` its implicit
 * per-plugin data directory. The returned path is under the realpath of the
 * root it belongs to, and the leaf is refused if it is a symlink.
 */
export async function resolvePluginDatabaseLocation(options: {
  declaration: PluginDatabaseDeclaration;
  manifestId: string;
  projectRoot: string | null;
  dataDir: string;
  /**
   * Locate an existing file only: create nothing, and reject with
   * `DB_NOT_FOUND` when the file or its directory is missing.
   */
  existingOnly?: boolean;
}): Promise<PluginDatabaseLocation> {
  const { declaration, manifestId, projectRoot, dataDir, existingOnly = false } = options;
  let root: string;
  let relative: string;
  if (declaration.location === "project") {
    if (!projectRoot) {
      throw databaseError(
        "PROJECT_UNAVAILABLE",
        `database "${declaration.id}" is a project database but this plugin has no project`
      );
    }
    root = projectRoot;
    relative = declaration.path ?? `.daintree/data/${manifestId}/${declaration.id}.db`;
  } else {
    if (!existingOnly) await fsp.mkdir(dataDir, { recursive: true });
    root = dataDir;
    relative = `databases/${declaration.id}.db`;
  }
  const notFound = () =>
    databaseError("DB_NOT_FOUND", `database "${declaration.id}" does not exist yet`);
  const realRoot = await fsp.realpath(root).catch((error: NodeJS.ErrnoException) => {
    if (existingOnly && error.code === "ENOENT") throw notFound();
    throw error;
  });
  const lexical = path.resolve(realRoot, relative);
  if (!isInside(realRoot, lexical)) {
    throw databaseError("PATH_NOT_ALLOWED", `database "${declaration.id}" path escapes its root`);
  }
  if (declaration.location === "project" && isInsideGitDir(path.relative(realRoot, lexical))) {
    throw databaseError("PATH_NOT_ALLOWED", `database "${declaration.id}" path is inside .git`);
  }
  const refuseGitDir = (canonical: string): void => {
    if (declaration.location === "project" && isInsideGitDir(path.relative(realRoot, canonical))) {
      throw databaseError("PATH_NOT_ALLOWED", `database "${declaration.id}" resolves inside .git`);
    }
  };
  const realDir = existingOnly
    ? await existingContainedDir(realRoot, path.dirname(lexical), declaration.id, notFound)
    : await mkdirContained(realRoot, path.dirname(lexical), declaration.id, refuseGitDir);
  const target = path.join(realDir, path.basename(lexical));
  refuseGitDir(target);
  const leaf = await fsp.lstat(target).catch(() => null);
  if (leaf?.isSymbolicLink()) {
    throw databaseError("TARGET_IS_SYMLINK", `database "${declaration.id}" file is a symlink`);
  }
  if (!leaf && existingOnly) throw notFound();
  if (leaf && !leaf.isFile()) {
    throw databaseError("TARGET_UNAVAILABLE", `database "${declaration.id}" is not a regular file`);
  }
  return {
    id: declaration.id,
    location: declaration.location,
    path: target,
    projectRelativePath:
      declaration.location === "project"
        ? path.relative(realRoot, target).split(path.sep).join("/")
        : null,
    journalMode: declaration.journalMode,
  };
}
