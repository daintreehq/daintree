import * as fs from "fs/promises";
import * as path from "path";
import { checkIgnoredPaths } from "../utils/gitCheckIgnore.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { FileTreeNode } from "../../shared/types/ipc.js";

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
   * Return gitignored entries too, each flagged `isIgnored: true`, instead of
   * dropping them. Off by default so every existing caller (the copy-tree file
   * picker) keeps the fail-closed listing it was written against.
   *
   * Note this deliberately does not weaken the check-ignore failure path: when
   * `git check-ignore` errors, every checked path is still treated as ignored,
   * so an opted-in caller sees them marked rather than silently presented as
   * clean.
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

      const toGitPath = (p: string) => p.split(path.sep).join("/");
      const pathsToCheck = entries
        .filter((e) => e.name !== ".git")
        .map((e) => toGitPath(path.join(relativeDirPath, e.name)));
      const ignoredPaths = new Set<string>();

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

      const statResults = await Promise.all(
        entries.map(async (entry) => {
          if (entry.name === ".git") return null;
          if (entry.isSymbolicLink()) return null;

          const relativePath = path.join(relativeDirPath, entry.name);
          const gitRelativePath = toGitPath(relativePath);

          const isIgnored = ignoredPaths.has(gitRelativePath);
          if (isIgnored && !options.includeIgnored) return null;

          const absolutePath = path.join(resolvedBasePath, relativePath);
          try {
            const fileStat = await fs.lstat(absolutePath);
            return { fileStat, name: entry.name, gitRelativePath, isIgnored };
          } catch {
            return null;
          }
        })
      );

      const nodes: FileTreeNode[] = [];
      for (const result of statResults) {
        if (!result) continue;
        const { fileStat, name, gitRelativePath, isIgnored } = result;
        // Omitted rather than set to `false` so the default listing serializes
        // byte-for-byte as it did before the flag existed.
        const ignoredField = isIgnored ? { isIgnored: true as const } : {};

        const isDirectory = fileStat.isDirectory();
        if (isDirectory) {
          nodes.push({ name, path: gitRelativePath, isDirectory, ...ignoredField });
          continue;
        }

        try {
          nodes.push({
            name,
            path: gitRelativePath,
            isDirectory,
            size: fileStat.size,
            ...ignoredField,
          });
        } catch {
          // skip entries where size read fails
        }
      }

      nodes.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
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
