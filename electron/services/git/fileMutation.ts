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

function isInsideRoot(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function namesGitDir(segments: string[]): boolean {
  return segments.some((segment) => segment.toLowerCase() === ".git");
}

/**
 * Resolves a worktree-relative path and refuses anything that could reach past
 * the file the user clicked: absolute paths, `..`, the root itself, git's own
 * administration directory (also when reached through a symlinked folder), and
 * a symlinked parent that leads out of the tree.
 *
 * Only the parent is resolved. The leaf is what gets restored or trashed, so a
 * symlink leaf is acted on as the link, never as whatever it points at.
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
  // Git names paths with `/`. A backslash is a separator only on Windows; on
  // POSIX `a\b.txt` is a file of its own and must not become `a/b.txt`.
  const separators = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  const segments = relativePath.split(separators).filter((segment) => segment !== "");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..") ||
    namesGitDir(segments)
  ) {
    throw new Error("Invalid file path: must point at a file inside the worktree");
  }

  const root = await realpath(worktreePath);
  const absolutePath = path.join(root, ...segments);
  const realParent = await realpathNearest(path.dirname(absolutePath));
  const lockKey = path.join(realParent, path.basename(absolutePath));
  const rel = path.relative(root, lockKey);
  if (!isInsideRoot(rel) || namesGitDir(rel.split(path.sep))) {
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
  if (ref) {
    // `for-each-ref` answers a missing ref with empty output and exit 0, so a
    // failed read can't pass for an unborn branch the way a swallowed error
    // from `show-ref` would. Its own failure propagates.
    const tip = await git.raw(["for-each-ref", "--format=%(objectname)", ref]);
    if (tip.trim() === "") return null;
  }
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

  // Planned once to learn which paths to lock, then again under the locks:
  // anything checked before the wait — the status, a rename's partner, what is
  // on disk, where a parent symlink leads — can change while queued behind an
  // editor save, and acting on the stale answer is how the wrong file goes.
  const keys = (await planDiscard(git, target)).targets.map((t) => t.lockKey);
  await runExclusiveAll(keys, async () => {
    const plan = await planDiscard(git, target);
    const lockedKeys = plan.targets.map((t) => t.lockKey);
    if (lockedKeys.some((key) => !keys.includes(key))) {
      throw new Error(`'${target.gitPath}' changed while waiting. Try again.`);
    }
    const toRemove = plan.targets.filter((t) => t.head === "absent");
    const toRestore = plan.targets.filter((t) => t.head === "blob");

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
    if (toRestore.length > 0 && plan.headOid !== null) {
      await git.raw([
        "restore",
        `--source=${plan.headOid}`,
        "--staged",
        "--worktree",
        "--",
        ...toRestore.map((t) => t.gitPath),
      ]);
    }
  });
}

interface DiscardTarget extends ResolvedTarget {
  onDisk: boolean;
  head: HeadEntry;
}

/** Works out which paths discarding `target` touches, refusing what it must not. */
async function planDiscard(
  git: SimpleGit,
  target: ResolvedTarget
): Promise<{ headOid: string | null; targets: DiscardTarget[] }> {
  const status = parsePorcelainV1Z(
    await git.raw(["status", "--porcelain=v1", "-z", "--untracked-files=no"])
  );
  // The row's own entry first. A rename can also be reached by its source, but
  // a copy's source is a different file whose own changes are not this row's.
  const entry =
    status.find((candidate) => candidate.path === target.gitPath) ??
    status.find(
      (candidate) =>
        candidate.origPath === target.gitPath && (candidate.x === "R" || candidate.y === "R")
    );
  if (!entry) {
    throw new Error(`'${target.gitPath}' has no changes to discard.`);
  }
  if (isConflicted(entry)) {
    throw new Error(`'${target.gitPath}' has a merge conflict. Resolve it in the conflict panel.`);
  }

  const isRename = entry.x === "R" || entry.y === "R";
  const headOid = await resolveHeadOid(git);
  const destination =
    entry.path === target.gitPath ? target : await resolveTarget(target.root, entry.path);
  const targets: DiscardTarget[] = [
    {
      ...destination,
      onDisk: await refuseDirectory(destination.absolutePath, entry.path),
      head: await readHeadEntry(git, headOid, entry.path),
    },
  ];

  if (isRename && entry.origPath) {
    const source =
      entry.origPath === target.gitPath ? target : await resolveTarget(target.root, entry.origPath);
    const sourceOnDisk = await refuseDirectory(source.absolutePath, entry.origPath);
    // The rename took the source out of the index, so a file standing there
    // now is a new one the user made. Restoring HEAD over it would lose it.
    if (sourceOnDisk) {
      throw new Error(
        `'${entry.origPath}' was renamed to '${entry.path}', and a new file now stands at '${entry.origPath}'. Move it aside before discarding the rename.`
      );
    }
    targets.push({
      ...source,
      onDisk: false,
      head: await readHeadEntry(git, headOid, entry.origPath),
    });
  }
  return { headOid, targets };
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
  await runExclusive(target.lockKey, async () => {
    // Checked under the lock: a file swapped for a folder, or a parent swapped
    // for a symlink, while this waited must not be what goes to the Trash.
    const current = await resolveTarget(worktreePath, relativePath);
    if (current.lockKey !== target.lockKey) {
      throw new Error(`'${target.gitPath}' changed while waiting. Try again.`);
    }
    if (!(await refuseDirectory(current.absolutePath, current.gitPath))) {
      throw new Error(`'${current.gitPath}' no longer exists.`);
    }
    await trashItem(current.absolutePath);
  });
}
