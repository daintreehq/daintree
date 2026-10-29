import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import type { SimpleGit } from "simple-git";
import type {
  FileChangeSide,
  FileChurn,
  FileDiscardPreview,
  FileTextSample,
  FileTrashPreview,
  DiscardOutcome,
} from "../../../shared/types/fileMutation.js";
import { AppError, isAppError } from "../../utils/errorTypes.js";
import { createHardenedGit } from "../../utils/hardenedGit.js";
import { runWithCappedStdout } from "../../utils/cappedGitOutput.js";
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
  const leaf = await lstatOrNull(absolutePath);
  // An existing file is keyed by its full realpath — the spelling the plugin
  // host's writers lock under, including the casing on disk. A symlink leaf or
  // a missing file is keyed by its resolved parent, so the link itself is what
  // gets acted on.
  const lockKey =
    leaf && !leaf.isSymbolicLink()
      ? await realpath(absolutePath)
      : path.join(await realpathNearest(path.dirname(absolutePath)), path.basename(absolutePath));
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
    throw new AppError({
      code: "NOT_A_FILE",
      message: `'${gitPath}' is a folder. Only files can be discarded or deleted.`,
    });
  }
  return stats !== null;
}

/**
 * Electron's `trashItem` rejects with whatever the platform said, which is
 * rarely an errno, so the refusal travels as a code the renderer can word
 * without parsing it. The message stays the platform's, for the log.
 */
async function moveToTrash(trashItem: TrashItem, absolutePath: string): Promise<void> {
  try {
    await trashItem(absolutePath);
  } catch (error) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * Gives a failure from the file system or git a code the renderer can word.
 * Done here because the packaged build scrubs absolute paths from messages on
 * the way out, and the lock's path is how its collision is recognised.
 * Daintree's own refusals already carry codes and pass through.
 */
function classifyFailure(error: unknown): unknown {
  if (isAppError(error)) return error;
  const cause = error instanceof Error ? error : undefined;
  const message = cause?.message ?? String(error);
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  // Checked before the lock: git reports a lock it isn't allowed to create
  // with the lock's path too, and waiting for another process won't fix that.
  if (
    errno === "EACCES" ||
    errno === "EPERM" ||
    /permission denied|operation not permitted/i.test(message)
  ) {
    return new AppError({ code: "PERMISSION", message, cause });
  }
  // A lock that exists: another git process is mid-operation.
  if (/index\.lock'?: File exists|another git process seems to be running/i.test(message)) {
    return new AppError({ code: "GIT_INDEX_LOCKED", message, cause });
  }
  return error;
}

async function classified<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw classifyFailure(error);
  }
}

function changedWhileWaiting(gitPath: string): AppError {
  return new AppError({
    code: "FILE_CHANGED_SINCE_REVIEW",
    message: `'${gitPath}' changed while waiting. Try again.`,
  });
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
      throw new AppError({
        code: "NOT_A_FILE",
        message: `'${gitPath}' is a submodule. Discard it from inside the submodule.`,
      });
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
 * (the Trash file item is the operation for it) and the other belongs to the
 * conflict panel.
 */
export function discardFileChanges(
  worktreePath: string,
  relativePath: string,
  trashItem: TrashItem,
  /**
   * The `token` of the preview the user approved. When given, the discard
   * refuses unless every version it would act on is still the one that preview
   * read: an agent saving between the confirm and the click would otherwise
   * lose work the user never saw.
   */
  expectedToken?: string
): Promise<void> {
  return classified(() => runDiscard(worktreePath, relativePath, trashItem, expectedToken));
}

async function runDiscard(
  worktreePath: string,
  relativePath: string,
  trashItem: TrashItem,
  expectedToken: string | undefined
): Promise<void> {
  const target = await resolveTarget(worktreePath, relativePath);
  const git = await createHardenedGit(target.root);

  // Planned once to learn which paths to lock, then again under the locks:
  // anything checked before the wait — the status, a rename's partner, what is
  // on disk, where a parent symlink leads — can change while queued behind an
  // editor save, and acting on the stale answer is how the wrong file goes.
  //
  // A reviewed file with nothing left to discard changed since the review —
  // committed, reverted, unstaged into an untracked file — so the confirm
  // should ask again rather than report a refusal it can't explain.
  const planOrStale = async (from: ResolvedTarget): Promise<DiscardPlan> => {
    try {
      return await planDiscard(git, from);
    } catch (error) {
      if (expectedToken !== undefined && isAppError(error) && error.code === "NOT_FOUND") {
        throw new AppError({
          code: "FILE_CHANGED_SINCE_REVIEW",
          message: `'${from.gitPath}' changed after the discard was reviewed.`,
        });
      }
      throw error;
    }
  };
  const keys = (await planOrStale(target)).targets.map((t) => t.lockKey);
  await runExclusiveAll(keys, async () => {
    const plan = await planOrStale(await resolveTarget(worktreePath, relativePath));
    const lockedKeys = plan.targets.map((t) => t.lockKey);
    if (lockedKeys.some((key) => !keys.includes(key))) {
      throw changedWhileWaiting(target.gitPath);
    }
    if (expectedToken !== undefined && (await fingerprintPlan(git, plan)) !== expectedToken) {
      throw new AppError({
        code: "FILE_CHANGED_SINCE_REVIEW",
        message: `'${target.gitPath}' changed after the discard was reviewed.`,
      });
    }
    const toRemove = plan.targets.filter((t) => t.head === "absent");
    const toRestore = plan.targets.filter((t) => t.head === "blob");

    // Trash before touching the index, so a refused Trash leaves the change
    // exactly as it was rather than half-discarded.
    let trashedPath: string | null = null;
    for (const t of toRemove) {
      if (t.onDisk) {
        await moveToTrash(trashItem, t.absolutePath);
        trashedPath = t.gitPath;
      }
    }
    try {
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
    } catch (error) {
      // The file is already in the Trash; saying only "couldn't discard" would
      // read as though nothing happened.
      if (trashedPath === null) throw error;
      throw new AppError({
        code: "INTERNAL",
        message: `'${trashedPath}' is in the Trash, but git stopped before the discard finished.`,
        cause: error instanceof Error ? error : undefined,
      });
    }
  });
}

interface DiscardTarget extends ResolvedTarget {
  onDisk: boolean;
  head: HeadEntry;
}

interface DiscardPlan {
  headOid: string | null;
  entry: PorcelainEntry;
  targets: DiscardTarget[];
}

/** Works out which paths discarding `target` touches, refusing what it must not. */
async function planDiscard(git: SimpleGit, target: ResolvedTarget): Promise<DiscardPlan> {
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
    throw new AppError({
      code: "NOT_FOUND",
      message: `'${target.gitPath}' has no changes to discard.`,
    });
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
    const sourceStats = await lstatOrNull(source.absolutePath);
    if (sourceStats?.isDirectory()) {
      throw new AppError({
        code: "NOT_A_FILE",
        message: `'${entry.origPath}' is a folder. Only files can be discarded or deleted.`,
      });
    }
    // The rename took the source out of the index, so a file standing there
    // now is a new one the user made, and restoring HEAD over it would lose it.
    // Unless it is the destination itself: a case-only rename on a
    // case-insensitive disk reads back under both names.
    const destinationStats = await lstatOrNull(destination.absolutePath);
    const isCaseAlias =
      sourceStats !== null &&
      destinationStats !== null &&
      sourceStats.dev === destinationStats.dev &&
      sourceStats.ino === destinationStats.ino;
    if (sourceStats && !isCaseAlias) {
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
  return { headOid, entry, targets };
}

/**
 * Moves one file to the OS Trash. The index is left alone: deleting a tracked
 * file shows up as a deletion to stage or discard like any other.
 */
export function trashFile(
  worktreePath: string,
  relativePath: string,
  trashItem: TrashItem
): Promise<void> {
  return classified(() => runTrash(worktreePath, relativePath, trashItem));
}

async function runTrash(
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
      throw changedWhileWaiting(target.gitPath);
    }
    if (!(await refuseDirectory(current.absolutePath, current.gitPath))) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `'${current.gitPath}' no longer exists.`,
      });
    }
    await moveToTrash(trashItem, current.absolutePath);
  });
}

/** Patch text past this is cut at a line: the preview shows a sample, not the change. */
const PATCH_CAP_BYTES = 24 * 1024;
/** A patch git is still writing past this is abandoned rather than read. */
const PATCH_READ_CAP_BYTES = 512 * 1024;
/** Files past this aren't read to count their lines. */
const LINE_COUNT_CAP_BYTES = 1024 * 1024;
const EXCERPT_LINES = 24;
const EXCERPT_CAP_BYTES = 4 * 1024;

function capAtLine(text: string, capBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= capBytes) return { text, truncated: false };
  // A cut mid-character decodes as U+FFFD; dropping back to the last whole
  // line removes it along with the partial line.
  const cut = bytes.subarray(0, capBytes).toString("utf8");
  const end = cut.lastIndexOf("\n");
  return { text: end > 0 ? cut.slice(0, end + 1) : "", truncated: true };
}

/** Sums `git diff --numstat`; null when git reports nothing. */
function parseNumstat(out: string): FileChurn | null {
  let insertions = 0;
  let deletions = 0;
  let any = false;
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [added, removed] = line.split("\t");
    if (added === "-" || removed === "-") return "binary";
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
    any = true;
  }
  return any ? { insertions, deletions } : null;
}

// `--no-ext-diff --no-textconv` on every read: a configured diff driver or
// textconv filter would otherwise run an arbitrary command just because the
// confirm opened, and a slow or interactive one would hold the confirm up.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

async function readChurn(
  git: SimpleGit,
  args: string[],
  paths: string[]
): Promise<FileChurn | null> {
  return parseNumstat(await git.raw(["diff", ...args, ...DIFF_FLAGS, "--numstat", "--", ...paths]));
}

async function readSide(
  root: string,
  git: SimpleGit,
  args: string[],
  paths: string[]
): Promise<FileChangeSide | null> {
  const churn = await readChurn(git, args, paths);
  if (churn === null) return null;
  if (churn === "binary") return { churn, patch: "", truncated: false };
  // Stopped while git writes it, so a huge generated file can't be buffered
  // whole in the main process just to show its first lines.
  const raw = await runWithCappedStdout(root, PATCH_READ_CAP_BYTES, (capped) =>
    capped.raw(["diff", ...args, ...DIFF_FLAGS, "--unified=2", "--", ...paths])
  );
  if (raw === null) return { churn, patch: "", truncated: true };
  const { text, truncated } = capAtLine(raw, PATCH_CAP_BYTES);
  return { churn, patch: text, truncated };
}

/**
 * Opens a file for reading only if it is still a regular file once open.
 * Non-blocking, so a FIFO swapped in after an `lstat` can't hang the open,
 * and checked on the descriptor itself, so the swap can't slip between the
 * check and the read. Null for anything that isn't a regular file.
 */
async function openRegularFile(absolutePath: string): Promise<FileHandle | null> {
  const handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  if ((await handle.stat()).isFile()) return handle;
  await handle.close();
  return null;
}

async function hashDisk(absolutePath: string): Promise<string> {
  const stats = await lstatOrNull(absolutePath);
  if (stats === null) return "absent";
  if (stats.isSymbolicLink()) return `link:${await readlink(absolutePath)}`;
  // Special files are fingerprinted by what they are, never read.
  if (!stats.isFile()) return `special:${stats.mode}:${stats.ino}`;
  const handle = await openRegularFile(absolutePath);
  if (handle === null) return `special:${stats.mode}:${stats.ino}`;
  const hash = createHash("sha256");
  try {
    await new Promise<void>((resolve, reject) => {
      handle
        .createReadStream({ autoClose: false })
        .on("data", (chunk) => hash.update(chunk))
        .on("end", () => resolve())
        .on("error", reject);
    });
  } finally {
    await handle.close();
  }
  // The mode too: git tracks the executable bit, and flipping it is a change
  // a discard would undo.
  return `file:${stats.mode}:${hash.digest("hex")}`;
}

/**
 * Every version a discard would act on — the commit it restores from, each
 * path's index entry and what is on disk — folded into one value, so the
 * discard can tell whether anything moved since the preview was read.
 */
async function fingerprintPlan(git: SimpleGit, plan: DiscardPlan): Promise<string> {
  const { entry } = plan;
  const hash = createHash("sha256");
  hash.update(`head:${plan.headOid ?? "unborn"}\0`);
  // The status that chose what the preview read and said: the same content
  // under a different status (a staged addition that has since gained
  // unstaged edits) is a different discard.
  hash.update(`status:${entry.x}${entry.y}\0${entry.path}\0${entry.origPath ?? ""}\0`);
  for (const target of plan.targets) {
    const index = await git.raw(["ls-files", "--stage", "-z", "--", target.gitPath]);
    hash.update(
      `${target.gitPath}\0${target.head}\0${target.onDisk}\0${index}\0${await hashDisk(target.absolutePath)}\0`
    );
  }
  return hash.digest("hex");
}

/**
 * What discarding loses, judged by the versions involved rather than the
 * status letter. A path in the last commit comes back from it, so only a pure
 * deletion loses nothing. A path the last commit doesn't have goes to the
 * Trash, so its disk copy survives; what doesn't is a staged version that
 * differs from it (a rename's staged copy is the committed content under a new
 * name until it carries edits of its own).
 */
function discardOutcome(plan: DiscardPlan, stagedIsOwnVersion: boolean): DiscardOutcome {
  const { entry } = plan;
  const destination = plan.targets[0]!;
  if (destination.head === "blob") {
    // A staged deletion with a file standing at the path again: the restore
    // writes over that file, which git has never seen.
    const pureDeletion =
      (entry.x === " " || entry.x === "D") &&
      (entry.y === " " || entry.y === "D") &&
      !(entry.x === "D" && destination.onDisk);
    return pureDeletion ? "restore" : "lose";
  }
  if (!destination.onDisk) return stagedIsOwnVersion ? "lose" : "restore";
  return entry.y !== " " && stagedIsOwnVersion ? "lose" : "trash";
}

/**
 * Whether the index holds a version of a path the last commit doesn't have
 * that nothing else will keep once it leaves the index. A staged addition
 * does; a rename or copy does only when its staged blob (or mode) differs
 * from its source's committed one, which HEAD keeps either way.
 */
async function stagedIsOwnVersion(git: SimpleGit, plan: DiscardPlan): Promise<boolean> {
  const { entry } = plan;
  if (entry.x === "A") return true;
  if ((entry.x !== "R" && entry.x !== "C") || !entry.origPath || plan.headOid === null) {
    return false;
  }
  // `<mode> <oid> <stage>\t<path>` and `<mode> <type> <oid>\t<path>`.
  const staged = (await git.raw(["ls-files", "--stage", "-z", "--", entry.path])).split("\t")[0];
  const committed = (
    await git.raw(["ls-tree", "-z", "--full-tree", plan.headOid, "--", entry.origPath])
  ).split("\t")[0];
  const [stagedMode, stagedOid] = (staged ?? "").split(" ");
  const [committedMode, , committedOid] = (committed ?? "").split(" ");
  return !stagedOid || stagedOid !== committedOid || stagedMode !== committedMode;
}

/** Reads that keep seeing the file change give up rather than show a moving target. */
const PREVIEW_ATTEMPTS = 3;

/**
 * Reads what `discardFileChanges` would do to one file, without doing it: the
 * same plan, its two sides with a sample of each patch, and a fingerprint the
 * discard checks. Refuses exactly what the discard refuses.
 *
 * The fingerprint is taken before and after the patches are read and must
 * match: an agent saving between the two would otherwise leave the dialog
 * showing one version while the approval vouched for the next.
 */
export function previewDiscard(
  worktreePath: string,
  relativePath: string
): Promise<FileDiscardPreview> {
  return classified(() => readDiscardPreview(worktreePath, relativePath));
}

async function readDiscardPreview(
  worktreePath: string,
  relativePath: string
): Promise<FileDiscardPreview> {
  const target = await resolveTarget(worktreePath, relativePath);
  const git = await createHardenedGit(target.root);
  for (let attempt = 0; attempt < PREVIEW_ATTEMPTS; attempt++) {
    const plan = await planDiscard(git, target);
    const before = await fingerprintPlan(git, plan);
    const { entry } = plan;
    const destination = plan.targets[0]!;
    const isRename = entry.x === "R" || entry.y === "R";
    const isCopy = entry.x === "C" || entry.y === "C";
    const stagedPaths = isRename && entry.origPath ? [entry.origPath, entry.path] : [entry.path];
    const staged =
      entry.x === " " ? null : await readSide(target.root, git, ["--cached"], stagedPaths);
    const unstaged = entry.y === " " ? null : await readSide(target.root, git, [], [entry.path]);
    const ownStaged = await stagedIsOwnVersion(git, plan);
    const overwrites =
      destination.head === "blob" && entry.x === "D" && destination.onDisk
        ? await readTextSample(destination.absolutePath, true)
        : null;
    const after = await fingerprintPlan(git, await planDiscard(git, target));
    if (after !== before) continue;
    return {
      kind: "discard",
      path: entry.path,
      renamedFrom: isRename ? (entry.origPath ?? null) : null,
      copiedFrom: isCopy ? (entry.origPath ?? null) : null,
      inLastCommit: destination.head === "blob",
      outcome: discardOutcome(plan, ownStaged),
      staged,
      unstaged,
      overwrites,
      token: before,
    };
  }
  throw new AppError({
    code: "FILE_CHANGED_SINCE_REVIEW",
    message: `'${target.gitPath}' kept changing while it was read.`,
  });
}

async function readHead(absolutePath: string, bytes: number): Promise<Buffer | null> {
  const handle = await openRegularFile(absolutePath);
  if (handle === null) return null;
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Size, line count and (when wanted) the first lines of a file on disk. */
async function readTextSample(absolutePath: string, wantExcerpt: boolean): Promise<FileTextSample> {
  const stats = await lstat(absolutePath);
  const sample: FileTextSample = {
    bytes: stats.size,
    binary: false,
    lines: null,
    excerpt: null,
    excerptTruncated: false,
  };
  if (!stats.isFile()) return sample;
  // A file past the cap is sampled from its start rather than read whole: its
  // first lines still identify it, though its line count is unknown.
  const whole = stats.size <= LINE_COUNT_CAP_BYTES;
  const content = await readHead(absolutePath, whole ? stats.size : EXCERPT_CAP_BYTES * 2);
  if (content === null) return sample;
  if (content.subarray(0, 8192).includes(0)) {
    sample.binary = true;
    return sample;
  }
  const text = content.toString("utf8");
  const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (whole) sample.lines = lines;
  if (wantExcerpt) {
    const head = text.split("\n").slice(0, EXCERPT_LINES).join("\n");
    const capped = capAtLine(head, EXCERPT_CAP_BYTES);
    sample.excerpt =
      capped.text === "" && head !== "" ? head.slice(0, EXCERPT_CAP_BYTES) : capped.text;
    sample.excerptTruncated = !whole || capped.truncated || lines > EXCERPT_LINES;
  }
  return sample;
}

/**
 * Reads what moving one file to the Trash would leave behind: which copies
 * git keeps (the committed one, a staged one, or none), the changes the Trash
 * copy carries, and — for a file git has no copy of — its first lines, since
 * the Trash will hold the only one.
 */
export function previewTrash(
  worktreePath: string,
  relativePath: string
): Promise<FileTrashPreview> {
  return classified(() => readTrashPreview(worktreePath, relativePath));
}

async function readTrashPreview(
  worktreePath: string,
  relativePath: string
): Promise<FileTrashPreview> {
  const target = await resolveTarget(worktreePath, relativePath);
  const stats = await lstatOrNull(target.absolutePath);
  if (stats === null) {
    throw new AppError({ code: "NOT_FOUND", message: `'${target.gitPath}' no longer exists.` });
  }
  if (stats.isDirectory()) {
    throw new AppError({
      code: "NOT_A_FILE",
      message: `'${target.gitPath}' is a folder. Only files can be discarded or deleted.`,
    });
  }
  const git = await createHardenedGit(target.root);
  const inIndex = (await git.raw(["ls-files", "-z", "--", target.gitPath])) !== "";
  const headOid = await resolveHeadOid(git);
  const inLastCommit = (await readHeadEntry(git, headOid, target.gitPath)) === "blob";
  // check-ignore answers with its exit code; a failure to run reads as "not
  // ignored", which only softens the copy to "untracked".
  const ignored =
    !inIndex &&
    !inLastCommit &&
    (await tryRaw(git, ["check-ignore", "-q", "--", target.gitPath])) !== null;
  // Ignored files are often secrets (.env), so their content stays off screen.
  const wantExcerpt = !inIndex && !inLastCommit && !ignored;

  return {
    kind: "trash",
    path: target.gitPath,
    inLastCommit,
    inIndex,
    ignored,
    staged: inIndex ? await readChurn(git, ["--cached"], [target.gitPath]) : null,
    unstaged: inIndex ? await readChurn(git, [], [target.gitPath]) : null,
    ...(await readTextSample(target.absolutePath, wantExcerpt)),
  };
}
