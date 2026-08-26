import * as fs from "fs/promises";
import type { Stats } from "node:fs";
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
 * Resolve one symlink entry into the metadata the browser needs (#11939).
 *
 * What this guarantees, exactly: nothing outside the workspace root is ever
 * *reported*. `realpath` resolves the entire chain and the canonical result is
 * checked against the canonical root before any kind, size or mtime is read —
 * so an escaping link comes back `"external"` with no metadata attached, and
 * `isDirectory` stays false, which is what keeps it non-descendable.
 *
 * What it does NOT guarantee: that the kernel never *traverses* outside during
 * that resolution. The cheap `readlink` gate below rejects a target that
 * directly names an outside path, which covers the ordinary case — a link to
 * another checkout — and spares it a `realpath` that would block on a dead
 * network mount. But a chain that only escapes on a later hop (`a → ./b`,
 * `b → /elsewhere`), or one written to leave and return (`/elsewhere/../in`),
 * passes that gate lexically and is resolved by the OS before the canonical
 * check can refuse it. Two consequences worth naming rather than papering
 * over: an out-of-root path's existence is observable through `"external"`
 * (resolved, then refused) versus `"broken"` (did not resolve), and a dead
 * mount reachable through such a chain can still stall this listing.
 *
 * Closing those would take component-by-component resolution validated at
 * every hop, which is a shared containment primitive this codebase does not
 * have yet — and inventing a private one here is exactly what `.lessons/10971`
 * exists to prevent. The boundary that matters for disclosure is the canonical
 * check, and it holds.
 */
async function describeSymlink(
  linkPath: string,
  listingRealDirPath: string,
  resolvedBasePath: string,
  resolvedBaseRealPath: string
): Promise<{ symlink: FileTreeSymlink; targetStat?: Stats }> {
  const raw = await fs.readlink(linkPath);
  // Against the CANONICAL directory this entry was listed from, not the
  // lexical one. When the listed directory is itself reached through a link,
  // the two are different places, and only the canonical one interprets a
  // relative target the way the kernel will.
  const target = path.resolve(listingRealDirPath, raw);
  const unresolved = (targetKind: FileTreeSymlink["targetKind"]) => ({
    symlink: { target, targetKind },
  });

  // Either spelling of the root counts as inside it. A root reached through a
  // symlink (macOS `/tmp` and `/var` both are) has two absolute names, and an
  // absolute target written in whichever one the link's author had is still
  // pointing at the same workspace — rejecting it would hide a genuinely
  // in-root link. The canonical check below is what actually decides.
  if (!isContained(resolvedBaseRealPath, target) && !isContained(resolvedBasePath, target)) {
    return unresolved("external");
  }

  let realTarget: string;
  try {
    realTarget = await fs.realpath(linkPath);
  } catch (error: unknown) {
    // ENOENT is a dangling link — the one failure specific enough to show.
    // ELOOP (a cycle, or the OS depth limit) and EACCES/EPERM are equally
    // non-actionable, and reporting them as `"external"` would tell the user
    // something false about where their link points.
    const code = (error as NodeJS.ErrnoException).code;
    return unresolved(code === "ENOENT" ? "broken" : "unknown");
  }

  // The authoritative check. A target can be lexically inside the root and
  // canonically outside it — `link → ./sub/escape/etc` where `sub/escape → /`
  // — and this is what keeps such a link from ever reporting a kind, a size,
  // or a disclosure triangle.
  if (!isContained(resolvedBaseRealPath, realTarget)) return unresolved("external");

  try {
    // `lstat`, not `stat`: `realTarget` is fully resolved, so there is no link
    // left to follow and the cheaper call answers the same question.
    const targetStat = await fs.lstat(realTarget);
    return {
      symlink: { target, targetKind: targetStat.isDirectory() ? "directory" : "file" },
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
              targetRealPath,
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
