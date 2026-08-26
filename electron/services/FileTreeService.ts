import * as fs from "fs/promises";
import * as path from "path";
import type { FileTreeNode, FileTreeSymlink } from "../../shared/types/ipc.js";

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
 * Whether `candidate` sits at or under `root`, both already canonical.
 *
 * The house containment idiom, shared by `electron/setup/protocols.ts` and
 * `resolveContainedPath` in `electron/ipc/handlers/pathGuard.ts`: relativize
 * and reject anything that climbs out or lands on another root. A raw
 * `startsWith(root)` would accept a sibling like `/workspace-other`, and a
 * bare `rel.startsWith("..")` would reject a directory legitimately named
 * `..foo`, so the escape test is anchored on a separator instead.
 *
 * One predicate for the whole file rather than a second variant beside the
 * first — this is exactly the reinvention `.lessons/10971.md` exists to stop.
 */
function isContained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(rel);
}

/**
 * Resolve one symlink entry into the metadata the browser needs, without ever
 * dereferencing a target that points outside the root (#11939).
 *
 * The order matters and is the whole safety argument. `readlink` reads the
 * stored target string and follows nothing, so it is the only call safe to
 * make first. Its result is checked lexically before `realpath` — the first
 * call that would actually traverse — because dereferencing an arbitrary
 * absolute target turns any symlink in a cloned repository into two things we
 * refuse to offer: an existence-and-kind probe for paths outside the
 * workspace, and a `stat` that blocks forever on a dead network mount, which
 * would hang this entry's whole `Promise.all` and with it the directory
 * listing.
 *
 * So an out-of-root link costs exactly one extra syscall and reports
 * `"unknown"` — honest, since we genuinely did not look. Only a link that
 * survives both the lexical and the canonical containment checks is stat'd.
 */
async function describeSymlink(
  linkPath: string,
  resolvedBasePath: string,
  resolvedBaseRealPath: string
): Promise<{ symlink: FileTreeSymlink; targetStat?: Awaited<ReturnType<typeof fs.lstat>> }> {
  const raw = await fs.readlink(linkPath);
  const target = path.resolve(path.dirname(linkPath), raw);
  const unresolved = (targetKind: FileTreeSymlink["targetKind"]) => ({
    symlink: { target, targetKind, insideRoot: false },
  });

  if (!isContained(resolvedBasePath, target)) return unresolved("unknown");

  let realTarget: string;
  try {
    realTarget = await fs.realpath(linkPath);
  } catch (error: unknown) {
    // ENOENT is a dangling link — the one failure that means something
    // specific enough to show. ELOOP (a cycle, or the OS depth limit) and
    // EACCES/EPERM are indistinguishable to a user and equally non-actionable.
    const code = (error as NodeJS.ErrnoException).code;
    return unresolved(code === "ENOENT" ? "broken" : "unknown");
  }

  // A target can be lexically inside the root and still canonically outside it
  // — `link → ./sub/escape/etc` where `sub/escape → /`. The canonical check is
  // what keeps `insideRoot` honest, so the renderer never draws a disclosure
  // triangle on a row whose listing would be refused.
  if (!isContained(resolvedBaseRealPath, realTarget)) return unresolved("unknown");

  try {
    // `lstat`, not `stat`: `realTarget` is fully resolved, so there is no link
    // left to follow and the cheaper call answers the same question.
    const targetStat = await fs.lstat(realTarget);
    return {
      symlink: {
        target,
        targetKind: targetStat.isDirectory() ? "directory" : "file",
        insideRoot: true,
      },
      targetStat,
    };
  } catch {
    return unresolved("unknown");
  }
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
 *
 * Symbolic links are entries too (#11939). Listing a link is not dereferencing
 * it, so containment governs descent rather than visibility: a link is always
 * shown, a link resolving inside the root reports its target's kind and can be
 * expanded like the real thing, and a link resolving outside is a terminal
 * node carrying where it points. `node_modules/.bin` is nothing but relative
 * in-root links, and it used to render as an empty folder.
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

    if (!isContained(resolvedBasePath, targetPath)) {
      throw new Error("Invalid directory path: path traversal not allowed");
    }

    try {
      const resolvedBaseRealPath = await _getBaseRealpath(resolvedBasePath);
      const targetRealPath = await fs.realpath(targetPath).catch(() => targetPath);
      // Still the guard that makes an out-of-root link non-expandable: the
      // listing marks such a node `insideRoot: false` so the renderer never
      // asks, but this is what holds if something asks anyway.
      if (!isContained(resolvedBaseRealPath, targetRealPath)) {
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
          const relativePath = path.join(relativeDirPath, entry.name);
          const gitRelativePath = toGitPath(relativePath);

          const absolutePath = path.join(resolvedBasePath, relativePath);
          try {
            const fileStat = await fs.lstat(absolutePath);
            // The `Dirent` already said this is a link; `lstat` is asked again
            // rather than trusted from the dirent because it is the same call
            // every other entry makes and it re-confirms the entry still
            // exists. A link deleted between `readdir` and here fails the
            // `readlink` below and drops out exactly like any other race.
            if (!fileStat.isSymbolicLink()) {
              return { fileStat, name: entry.name, gitRelativePath };
            }
            const { symlink, targetStat } = await describeSymlink(
              absolutePath,
              resolvedBasePath,
              resolvedBaseRealPath
            );
            return { fileStat, name: entry.name, gitRelativePath, symlink, targetStat };
          } catch {
            return null;
          }
        })
      );

      const nodes: FileTreeNode[] = [];
      for (const result of statResults) {
        if (!result) continue;
        const { fileStat, name, gitRelativePath, symlink, targetStat } = result;

        // Both branches read `mtimeMs` off the `lstat` above rather than
        // stat-ing again: the modified column in the file browser's folder
        // listing (#11620) is free here and would otherwise cost one extra
        // syscall per entry on every directory read and bulk scan.
        //
        // A resolved link reports its target's stat instead, because the
        // columns describe what opening the row would give you. An unresolved
        // one keeps the link's own mtime and reports no size at all: a
        // symlink's `lstat.size` is the byte length of the stored target
        // string, which renders as a real but meaningless file size.
        const stat = targetStat ?? fileStat;
        const isDirectory = stat.isDirectory();
        const link = symlink ? { symlink } : {};

        if (isDirectory) {
          nodes.push({
            name,
            path: gitRelativePath,
            isDirectory,
            mtimeMs: stat.mtimeMs,
            ...link,
          });
          continue;
        }

        nodes.push({
          name,
          path: gitRelativePath,
          isDirectory,
          ...(targetStat || !symlink ? { size: stat.size } : {}),
          mtimeMs: stat.mtimeMs,
          ...link,
        });
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
