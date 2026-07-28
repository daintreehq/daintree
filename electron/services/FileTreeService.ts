import * as fs from "fs/promises";
import * as path from "path";
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

export function _resetBaseRealpathCacheForTests(): void {
  _baseRealpathCache.clear();
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

/**
 * Raw directory listing: filesystem identity and containment only, no opinion
 * about what belongs in a context.
 *
 * Every entry is returned, `.git` included, so visibility stays a caller
 * concern — the file browser hides entries client-side (junk list + dotfile
 * toggle, #11330) and the context picker asks CopyTree which of these entries
 * it would actually copy (`CopyTreeService.getFileTree`, #11439). This service
 * used to run a `git check-ignore` subprocess for the picker; that engine
 * disagreed with the one that builds the bundle, so it is gone.
 */
export class FileTreeService {
  async getFileTree(basePath: string, dirPath: string = ""): Promise<FileTreeNode[]> {
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

      const statResults = await Promise.all(
        entries.map(async (entry) => {
          if (entry.isSymbolicLink()) return null;

          const relativePath = path.join(relativeDirPath, entry.name);
          const gitRelativePath = toGitPath(relativePath);

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
        const byName = NAME_COLLATOR.compare(a.name, b.name);
        if (byName !== 0) return byName;
        // Numeric collation is not a total order: padded and unpadded forms of
        // the same value (`file1` / `file01` / `file001`) compare equal, and
        // the tie would otherwise fall through to readdir order, which is
        // filesystem- and platform-dependent. Codepoint comparison (not
        // localeCompare) keeps those ties deterministic regardless of host
        // locale.
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
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
