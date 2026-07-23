import * as fs from "fs/promises";
import * as path from "path";
import { checkIgnoredPaths } from "../utils/gitCheckIgnore.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { FileTreeNode } from "../../shared/types/ipc.js";

// Natural-numeric name ordering so `version_10` sorts after `version_9`
// instead of between `version_1` and `version_2`. Locale is left undefined so
// the host-locale collation of the plain `localeCompare` it replaces is
// preserved — this only adds numeric ordering; default "variant" sensitivity
// likewise keeps the existing case tie-break. Constructed once at module scope:
// `getFileTree` runs on every directory read and bulk scan, and per-call
// collator construction is costly.
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });

const _baseRealpathCache = new Map<string, Promise<string>>();

// Throttle for the fail-closed warn so a sustained git failure (e.g. a
// broken FUSE mount on a refresh storm) doesn't spam the main process log
// with one line per `getFileTree` call. First occurrence is logged
// immediately; subsequent occurrences within the throttle window are
// suppressed.
const WARN_THROTTLE_MS = 30_000;
const _lastWarnAt = new Map<string, number>();

export function _resetBaseRealpathCacheForTests(): void {
  _baseRealpathCache.clear();
  _lastWarnAt.clear();
}

function _getBaseRealpath(resolvedBasePath: string): Promise<string> {
  const cached = _baseRealpathCache.get(resolvedBasePath);
  if (cached) return cached;
  const promise = fs.realpath(resolvedBasePath).catch((_err) => {
    _baseRealpathCache.delete(resolvedBasePath);
    return resolvedBasePath;
  });
  _baseRealpathCache.set(resolvedBasePath, promise);
  return promise;
}

export interface GetFileTreeOptions {
  /**
   * Raw-listing mode for the file browser: skip the `git check-ignore` pass
   * entirely (no git subprocess, no `isIgnored` annotation) and return every
   * entry — including gitignored ones and `.git` itself — so visibility is a
   * pure client-side concern (the always-hidden junk list and the per-panel
   * dotfile toggle live in the renderer, issue #11330).
   *
   * Off by default so the copy-tree file picker keeps its fail-closed listing:
   * when the check-ignore invocation errors, every checked path is still
   * treated as ignored rather than leaking. That path is deliberately untouched
   * here — this flag bypasses the check, it does not weaken it.
   */
  includeIgnored?: boolean;
}

export class FileTreeService {
  async getFileTree(
    basePath: string,
    dirPath: string = "",
    options: GetFileTreeOptions = {}
  ): Promise<FileTreeNode[]> {
    const resolvedBasePath = path.resolve(basePath);

    if (path.isAbsolute(dirPath)) {
      throw new Error("Invalid directory path: absolute paths not allowed");
    }

    const normalizedDirPath = path.normalize(dirPath);
    const normalizedForCheck = normalizedDirPath.replace(/\\/g, "/");
    if (
      normalizedForCheck === ".." ||
      normalizedForCheck.startsWith("../") ||
      normalizedForCheck.includes("/../")
    ) {
      throw new Error("Invalid directory path: path traversal not allowed");
    }

    const relativeDirPath =
      normalizedForCheck === "." ? "" : normalizedForCheck.replace(/^\.\/+/, "");
    const targetPath = path.resolve(resolvedBasePath, relativeDirPath);
    const relativeTarget = path.relative(resolvedBasePath, targetPath);

    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new Error("Invalid directory path: path traversal not allowed");
    }

    try {
      const resolvedBaseRealPath = await _getBaseRealpath(resolvedBasePath);
      const targetRealPath = await fs.realpath(targetPath).catch(() => targetPath);
      const relativeRealTarget = path.relative(resolvedBaseRealPath, targetRealPath);
      if (relativeRealTarget.startsWith("..") || path.isAbsolute(relativeRealTarget)) {
        throw new Error("Invalid directory path: path traversal not allowed");
      }

      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`);
      }

      const entries = await fs.readdir(targetPath, { withFileTypes: true });

      // Raw-listing mode (the file browser) skips the git check-ignore pass
      // wholesale: no subprocess, no ignored-path set, and `.git` is returned
      // like any other entry so the renderer's junk list — not this service —
      // decides whether it is hidden. Default mode (copy-tree) is unchanged.
      const skipIgnoreCheck = options.includeIgnored === true;

      const toGitPath = (p: string) => p.split(path.sep).join("/");
      const ignoredPaths = new Set<string>();

      if (!skipIgnoreCheck) {
        const pathsToCheck = entries
          .filter((e) => e.name !== ".git")
          .map((e) => toGitPath(path.join(relativeDirPath, e.name)));

        try {
          if (pathsToCheck.length > 0) {
            const ignored = await checkIgnoredPaths(resolvedBasePath, pathsToCheck);
            for (const p of ignored) {
              ignoredPaths.add(p);
            }
          }
        } catch (error) {
          // Fail closed: if the check-ignore invocation errors (E2BIG, ENOMEM,
          // missing git, broken repo, …) populate the set with every path we
          // tried to check so the downstream filter hides all of them. This
          // is the same shape as "everything in this dir is gitignored" and
          // prevents gitignored entries (build output, dependency folders,
          // secret-like files) from leaking into the tree. A transient
          // failure self-heals on the next successful call.
          const now = Date.now();
          const last = _lastWarnAt.get(resolvedBasePath) ?? 0;
          if (now - last >= WARN_THROTTLE_MS) {
            _lastWarnAt.set(resolvedBasePath, now);
            console.warn("git check-ignore failed; hiding checked entries to prevent leak", {
              code: (error as NodeJS.ErrnoException)?.code,
              message: formatErrorMessage(error, "Unknown git check-ignore error"),
              entryCount: pathsToCheck.length,
            });
          }
          for (const p of pathsToCheck) {
            ignoredPaths.add(p);
          }
        }
      }

      const statResults = await Promise.all(
        entries.map(async (entry) => {
          // `.git` is a structural exclusion only in default mode; raw mode
          // surfaces it so the junk list can hide it transparently.
          if (entry.name === ".git" && !skipIgnoreCheck) return null;
          if (entry.isSymbolicLink()) return null;

          const relativePath = path.join(relativeDirPath, entry.name);
          const gitRelativePath = toGitPath(relativePath);

          if (ignoredPaths.has(gitRelativePath)) return null;

          const absolutePath = path.join(resolvedBasePath, relativePath);
          try {
            const fileStat = await fs.lstat(absolutePath);
            return { fileStat, name: entry.name, gitRelativePath };
          } catch {
            return null;
          }
        })
      );

      const nodes: FileTreeNode[] = [];
      for (const result of statResults) {
        if (!result) continue;
        const { fileStat, name, gitRelativePath } = result;

        const isDirectory = fileStat.isDirectory();
        if (isDirectory) {
          nodes.push({ name, path: gitRelativePath, isDirectory });
          continue;
        }

        try {
          nodes.push({
            name,
            path: gitRelativePath,
            isDirectory,
            size: fileStat.size,
          });
        } catch {
          // skip entries where size read fails
        }
      }

      nodes.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return NAME_COLLATOR.compare(a.name, b.name);
      });

      return nodes;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`Failed to read directory tree: ${error.message}`);
      }
      throw new Error(`Failed to read directory tree: ${String(error)}`);
    }
  }
}

export const fileTreeService = new FileTreeService();
