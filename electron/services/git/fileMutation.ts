import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { SimpleGit } from "simple-git";
import { createHardenedGit } from "../../utils/hardenedGit.js";
import { runExclusive } from "../../utils/keyedMutex.js";

/**
 * Moves one path to the OS Trash. Production passes Electron's
 * `shell.trashItem`, which rejects where no Trash exists (WSL's 9P mounts, NFS,
 * minimal Linux sessions). Neither operation here ever falls back to an
 * unlink: a file the user can't get back is a different, louder action.
 */
export type TrashItem = (absolutePath: string) => Promise<void>;

export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  /** The source path of a rename or copy. */
  origPath?: string;
}

/**
 * Parses `git status --porcelain=v1 -z`. Hand-rolled rather than simple-git's
 * `status()`, which trims records — a destructive operation has to act on the
 * exact name git reported, trailing whitespace included.
 */
export function parsePorcelainV1Z(stdout: string): PorcelainEntry[] {
  const records = stdout.split("\0");
  const entries: PorcelainEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const entry: PorcelainEntry = { x, y, path: record.slice(3) };
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      entry.origPath = records[++i];
    }
    entries.push(entry);
  }
  return entries;
}

function isConflicted({ x, y }: PorcelainEntry): boolean {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

interface ResolvedTarget {
  root: string;
  /** Forward-slash path relative to the worktree root, as git names it. */
  gitPath: string;
  absolutePath: string;
  /** Realpath-anchored key shared with the plugin host's writer mutex. */
  lockKey: string;
}

async function realpathNearest(absolutePath: string): Promise<string> {
  let current = absolutePath;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a worktree-relative path and refuses anything that could reach past
 * the file the user clicked: absolute paths, `..`, the root itself, git's own
 * administration directory, and a symlinked parent that leads out of the tree.
 */
async function resolveTarget(worktreePath: string, relativePath: string): Promise<ResolvedTarget> {
  if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) {
    throw new Error("Worktree path must be absolute");
  }
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) {
    throw new Error("Invalid file path");
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("Invalid file path: must be relative to the worktree");
  }
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment !== "");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..") ||
    segments.some((segment) => segment.toLowerCase() === ".git")
  ) {
    throw new Error("Invalid file path: must point at a file inside the worktree");
  }

  const root = await realpath(worktreePath);
  const absolutePath = path.join(root, ...segments);
  const lockKey = await realpathNearest(absolutePath);
  const rel = path.relative(root, lockKey);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Invalid file path: must point at a file inside the worktree");
  }
  return { root, gitPath: segments.join("/"), absolutePath, lockKey };
}

async function lstatOrNull(absolutePath: string) {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function refuseDirectory(absolutePath: string, gitPath: string): Promise<boolean> {
  const stats = await lstatOrNull(absolutePath);
  if (stats?.isDirectory()) {
    throw new Error(`'${gitPath}' is a folder. Only files can be discarded or deleted.`);
  }
  return stats !== null;
}

/** Holds every key at once, in a fixed order so two callers can never deadlock. */
function runExclusiveAll<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(keys)].sort();
  const step = (index: number): Promise<T> =>
    index === sorted.length ? fn() : runExclusive(sorted[index], () => step(index + 1));
  return step(0);
}

// Paths reach git as plain arguments: `createHardenedGit` sets
// `GIT_LITERAL_PATHSPECS`, so a route file like `[...slug].tsx` names itself.
async function tryRaw(git: SimpleGit, args: string[]): Promise<string | null> {
  try {
    return await git.raw(args);
  } catch {
    return null;
  }
}

/**
 * HEAD's commit id, or `null` for an unborn branch. Any other failure to read
 * HEAD throws: "no commit to restore to" is only true when git says the
 * branch has never had one.
 */
async function resolveHeadOid(git: SimpleGit): Promise<string | null> {
  const oid = (await tryRaw(git, ["rev-parse", "--verify", "HEAD^{commit}"]))?.trim();
  if (oid) return oid;
  const ref = (await tryRaw(git, ["symbolic-ref", "HEAD"]))?.trim();
  if (ref && (await tryRaw(git, ["show-ref", "--verify", ref])) === null) return null;
  throw new Error("Couldn't read this worktree's current commit.");
}

type HeadEntry = "blob" | "absent";

async function readHeadEntry(
  git: SimpleGit,
  headOid: string | null,
  gitPath: string
): Promise<HeadEntry> {
  if (headOid === null) return "absent";
  const out = await git.raw(["ls-tree", "-z", "--full-tree", headOid, "--", gitPath]);
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1 || record.slice(tab + 1) !== gitPath) continue;
    const [mode, type] = record.slice(0, tab).split(" ");
    if (mode === "160000") {
      throw new Error(`'${gitPath}' is a submodule. Discard it from inside the submodule.`);
    }
    if (type === "blob") return "blob";
  }
  return "absent";
}

/**
 * Puts one changed file back to its committed state: both its staged and its
 * unstaged changes go.
 *
 * Every path the change involves is classified against HEAD rather than by the
 * status the renderer showed, which can't see a rename's source or a staged
 * versus unstaged split:
 *
 * - In HEAD (a modification, a deletion, a rename's source) → restored from
 *   HEAD, index and disk together.
 * - Not in HEAD (a staged addition, a rename's destination, anything on an
 *   unborn branch) → moved to the OS Trash, then dropped from the index.
 *   `git restore` would remove such a file for good, and an agent's new file is
 *   exactly what someone might want back.
 *
 * Untracked and conflicted files are refused: one has nothing to restore to
 * (the Delete item is the operation for it) and the other belongs to the
 * conflict panel.
 */
export async function discardFileChanges(
  worktreePath: string,
  relativePath: string,
  trashItem: TrashItem
): Promise<void> {
  const target = await resolveTarget(worktreePath, relativePath);
  const git = await createHardenedGit(target.root);

  const status = parsePorcelainV1Z(
    await git.raw(["status", "--porcelain=v1", "-z", "--untracked-files=no"])
  );
  const entry = status.find(
    (candidate) => candidate.path === target.gitPath || candidate.origPath === target.gitPath
  );
  if (!entry) {
    throw new Error(`'${target.gitPath}' has no changes to discard.`);
  }
  if (isConflicted(entry)) {
    throw new Error(`'${target.gitPath}' has a merge conflict. Resolve it in the conflict panel.`);
  }

  const isRename = entry.x === "R" || entry.y === "R";
  const gitPaths = [entry.path];
  // A copy's source is unchanged and stays; a rename's source comes back.
  if (isRename && entry.origPath) gitPaths.push(entry.origPath);

  const headOid = await resolveHeadOid(git);
  const targets = await Promise.all(
    gitPaths.map(async (gitPath) => {
      const resolved =
        gitPath === target.gitPath ? target : await resolveTarget(target.root, gitPath);
      const onDisk = await refuseDirectory(resolved.absolutePath, gitPath);
      return { ...resolved, onDisk, head: await readHeadEntry(git, headOid, gitPath) };
    })
  );
  const toRestore = targets.filter((t) => t.head === "blob");
  const toRemove = targets.filter((t) => t.head === "absent");

  await runExclusiveAll(
    targets.map((t) => t.lockKey),
    async () => {
      // Trash before touching the index, so a refused Trash leaves the change
      // exactly as it was rather than half-discarded.
      for (const t of toRemove) {
        if (t.onDisk) await trashItem(t.absolutePath);
      }
      if (toRemove.length > 0) {
        await git.raw([
          "rm",
          "--cached",
          "--quiet",
          "--ignore-unmatch",
          "--",
          ...toRemove.map((t) => t.gitPath),
        ]);
      }
      if (toRestore.length > 0 && headOid !== null) {
        await git.raw([
          "restore",
          `--source=${headOid}`,
          "--staged",
          "--worktree",
          "--",
          ...toRestore.map((t) => t.gitPath),
        ]);
      }
    }
  );
}

/**
 * Moves one file to the OS Trash. The index is left alone: deleting a tracked
 * file shows up as a deletion to stage or discard like any other.
 */
export async function trashFile(
  worktreePath: string,
  relativePath: string,
  trashItem: TrashItem
): Promise<void> {
  const target = await resolveTarget(worktreePath, relativePath);
  const exists = await refuseDirectory(target.absolutePath, target.gitPath);
  if (!exists) {
    throw new Error(`'${target.gitPath}' no longer exists.`);
  }
  await runExclusive(target.lockKey, () => trashItem(target.absolutePath));
}
