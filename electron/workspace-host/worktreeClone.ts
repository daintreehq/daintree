import { spawn } from "child_process";
import { randomUUID } from "crypto";
import type { Dirent } from "fs";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "fs/promises";
import { join as pathJoin } from "path";
import { getSystemErrorName } from "util";
import type { WorktreeSetupClone } from "../../shared/types/worktree.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { checkIgnoredPaths } from "../utils/gitCheckIgnore.js";
import { logInfo, logWarn } from "../utils/logger.js";
import { isInside, safeSegments } from "./worktreeInclude.js";

/**
 * Budget for every clone one worktree's config names, together. Separate from
 * the setup script's own: a clone that cannot finish in this long is not
 * saving the install it was meant to replace.
 */
export const CLONE_IGNORED_TIMEOUT_MS = 60_000;

/**
 * Clones are staged in `<worktree>/.daintree-clone-<uuid>/payload` and renamed
 * into place only once complete, so an interrupted clone never sits at the
 * name a setup script would trust. The staging directory holds a `.gitignore`
 * of `*`, which hides it and itself from `git status` while the clone runs.
 */
export const CLONE_STAGING_PREFIX = ".daintree-clone-";

const GIT_CHECK_TIMEOUT_MS = 10_000;
const MAX_CHILD_OUTPUT_BYTES = 16 * 1024;

/**
 * `clonefile(2)` on a directory clones the whole hierarchy in one atomic call:
 * every object or none, symlinks copied as they are, and an error rather than
 * a byte copy when the volume cannot clone. Neither Node nor `/bin/cp` offers
 * that — `cp -c` falls back to a full copy on a volume without clones and
 * leaves a partial tree across volumes — so it is reached through the
 * Objective-C bridge every macOS ships. Prints `0`, or the errno.
 * `1` is `CLONE_NOFOLLOW`: a source swapped for a symlink is not followed.
 */
const CLONEFILE_JXA = [
  "function run(argv) {",
  '  ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]);',
  '  ObjC.bindFunction("__error", ["int *", []]);',
  '  return $.clonefile(argv[0], argv[1], 1) === 0 ? "0" : String($.__error()[0]);',
  "}",
].join("\n");

export type CloneTreeResult = { ok: true } | { ok: false; reason: string };

/** Clone `src` to `dest`, which must not exist, copy-on-write or not at all. */
export type CloneTree = (
  src: string,
  dest: string,
  signal: AbortSignal
) => Promise<CloneTreeResult>;

export interface CloneIgnoredOptions {
  /** Aborted when the worktree is removed or the host shuts down. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override platform detection — test-only. */
  platform?: NodeJS.Platform;
  /** Override the clone backend — test-only. */
  cloneTree?: CloneTree;
}

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/**
 * Run a child to completion. An abort kills it, but the promise still waits
 * for `close`: the caller removes the staging directory next, and must not do
 * that while the child is still writing into it.
 */
function runChild(
  command: string,
  args: string[],
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<ChildResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CHILD_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CHILD_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      spawnError = formatErrorMessage(err, "spawn failed");
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr, spawnError });
    });
  });
}

function describeErrno(errno: number): string {
  switch (getSystemErrorName(-errno)) {
    case "EXDEV":
      return "It's on a different volume from the worktree";
    case "ENOTSUP":
    case "EOPNOTSUPP":
      return "This volume doesn't support copy-on-write clones";
    case "EEXIST":
      return "It already exists in the worktree";
    default:
      return `clonefile failed: ${getSystemErrorName(-errno)}`;
  }
}

async function cloneWithClonefile(
  src: string,
  dest: string,
  signal: AbortSignal
): Promise<CloneTreeResult> {
  const result = await runChild(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", CLONEFILE_JXA, src, dest],
    signal
  );
  if (result.spawnError !== undefined) {
    return { ok: false, reason: `Couldn't start osascript: ${result.spawnError}` };
  }
  const printed = result.stdout.trim();
  if (result.code === 0 && printed === "0") return { ok: true };
  const errno = Number.parseInt(printed, 10);
  if (result.code === 0 && Number.isInteger(errno) && errno > 0) {
    return { ok: false, reason: describeErrno(errno) };
  }
  return { ok: false, reason: `osascript exited ${result.code ?? "on a signal"}` };
}

async function cloneWithReflink(
  src: string,
  dest: string,
  signal: AbortSignal
): Promise<CloneTreeResult> {
  // GNU cp exits non-zero instead of copying when a reflink is impossible, and
  // `-a` keeps symlinks as symlinks. A cp without `--reflink` (BusyBox) fails
  // on the option, which is the same honest skip. `C` so the message matches.
  const result = await runChild("cp", ["-a", "--reflink=always", "--", src, dest], signal, {
    ...process.env,
    LC_ALL: "C",
  });
  if (result.spawnError !== undefined) {
    return { ok: false, reason: `Couldn't start cp: ${result.spawnError}` };
  }
  if (result.code === 0) return { ok: true };
  if (/cross-device/i.test(result.stderr)) {
    return { ok: false, reason: "It's on a different volume from the worktree" };
  }
  if (/not supported|unrecognized option|invalid argument/i.test(result.stderr)) {
    return { ok: false, reason: "This filesystem doesn't support copy-on-write clones" };
  }
  return { ok: false, reason: `cp --reflink=always exited ${result.code ?? "on a signal"}` };
}

/** The copy-on-write backend for `platform`, or undefined where there is none. */
export function cloneTreeForPlatform(platform: NodeJS.Platform): CloneTree | undefined {
  if (platform === "darwin") return cloneWithClonefile;
  if (platform === "linux") return cloneWithReflink;
  return undefined;
}

function unsupportedPlatformReason(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "Copy-on-write clones aren't supported on Windows"
    : "Copy-on-write clones aren't supported on this platform";
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
}

interface Candidate {
  index: number;
  path: string;
  src: string;
  dest: string;
  destParent: string;
}

/**
 * Check one entry against both trees, short of asking git. Returns the reason
 * to skip it, or null when it may be cloned.
 */
async function precheck(
  candidate: Candidate,
  roots: { src: string; dest: string; realSrc: string; realDest: string }
): Promise<string | null> {
  const srcStats = await lstatOrNull(candidate.src);
  if (!srcStats) return "It isn't in the main checkout";
  if (srcStats.isSymbolicLink()) return "It's a symlink in the main checkout";
  if (!srcStats.isDirectory()) return "It isn't a directory in the main checkout";
  if (!isInside(roots.realSrc, await realpath(candidate.src))) {
    return "It leads out of the main checkout";
  }

  if (await lstatOrNull(candidate.dest)) return "It already exists in the worktree";
  // The parent is never created: a missing one means this branch has no such
  // folder, and creating it would walk through whatever the checkout put there.
  const parentStats = await lstatOrNull(candidate.destParent);
  if (!parentStats || !parentStats.isDirectory()) return "Its parent folder isn't in the worktree";
  if (!isInside(roots.realDest, await realpath(candidate.destParent))) {
    return "Its parent folder leads out of the worktree";
  }
  if (srcStats.dev !== (await stat(candidate.destParent)).dev) {
    return "It's on a different volume from the worktree";
  }
  return null;
}

/**
 * Clone the gitignored directories `entries` names from the main checkout at
 * `srcRoot` into the new worktree at `destRoot`, copy-on-write, and say what
 * became of each, in order.
 *
 * An entry is cloned only when git ignores it in BOTH trees (so a tracked or
 * merely untracked path never qualifies, and the clone cannot make the new
 * branch look dirty), it is a real directory in the source, and nothing is at
 * its path in the worktree. A clone that cannot be copy-on-write is skipped
 * with the reason, never replaced by a full copy.
 *
 * Never throws: every failure becomes a skip, and worktree setup carries on.
 */
export async function cloneIgnoredDirectories(
  srcRoot: string,
  destRoot: string,
  entries: readonly string[],
  options: CloneIgnoredOptions = {}
): Promise<WorktreeSetupClone[]> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? CLONE_IGNORED_TIMEOUT_MS;
  const paths = [...new Set(entries)];
  const results: WorktreeSetupClone[] = paths.map((path) => ({ path, outcome: "skipped" }));
  const skip = (index: number, reason: string): void => {
    results[index] = { path: paths[index], outcome: "skipped", reason };
  };
  if (paths.length === 0) return results;

  const cloneTree = options.cloneTree ?? cloneTreeForPlatform(platform);
  if (!cloneTree) {
    paths.forEach((_, index) => skip(index, unsupportedPlatformReason(platform)));
    return finish(results, destRoot);
  }

  let roots: { src: string; dest: string; realSrc: string; realDest: string };
  try {
    roots = {
      src: srcRoot,
      dest: destRoot,
      realSrc: await realpath(srcRoot),
      realDest: await realpath(destRoot),
    };
  } catch (err) {
    const reason = `Couldn't read the checkouts: ${formatErrorMessage(err, "realpath failed")}`;
    paths.forEach((_, index) => skip(index, reason));
    return finish(results, destRoot);
  }
  if (roots.realSrc === roots.realDest) {
    paths.forEach((_, index) => skip(index, "The worktree is the main checkout"));
    return finish(results, destRoot);
  }

  const candidates: Candidate[] = [];
  for (const [index, path] of paths.entries()) {
    // A trailing slash is how .gitignore spells a directory; accept it here.
    const segments = safeSegments(path.endsWith("/") ? path.slice(0, -1) : path);
    if (!segments) {
      skip(index, "It isn't a relative path inside the project");
      continue;
    }
    if (segments[0].startsWith(CLONE_STAGING_PREFIX)) {
      skip(index, "That name is reserved for Daintree's staging folders");
      continue;
    }
    const candidate = {
      index,
      path,
      src: pathJoin(srcRoot, ...segments),
      dest: pathJoin(destRoot, ...segments),
      destParent: pathJoin(destRoot, ...segments.slice(0, -1)),
    };
    try {
      const reason = await precheck(candidate, roots);
      if (reason !== null) skip(index, reason);
      else candidates.push(candidate);
    } catch (err) {
      skip(index, `Couldn't inspect it: ${formatErrorMessage(err, "stat failed")}`);
    }
  }

  let eligible: Candidate[] = [];
  if (candidates.length > 0) {
    try {
      // The trailing slash makes git treat a path as a directory. Without it a
      // `node_modules/` rule never matches the worktree side, which does not
      // exist yet, and git has no other way to know it would be a directory.
      const asDir = (path: string): string => `${path}/`;
      const [srcIgnored, destIgnored] = await Promise.all([
        checkIgnoredPaths(
          srcRoot,
          candidates.map((c) => asDir(c.src)),
          { timeoutMs: GIT_CHECK_TIMEOUT_MS, signal: options.signal }
        ),
        checkIgnoredPaths(
          destRoot,
          candidates.map((c) => asDir(c.dest)),
          { timeoutMs: GIT_CHECK_TIMEOUT_MS, signal: options.signal }
        ),
      ]);
      for (const candidate of candidates) {
        if (!srcIgnored.has(asDir(candidate.src))) {
          skip(candidate.index, "Git doesn't ignore it in the main checkout");
        } else if (!destIgnored.has(asDir(candidate.dest))) {
          skip(candidate.index, "Git doesn't ignore it in this worktree");
        } else {
          eligible.push(candidate);
        }
      }
    } catch (err) {
      const reason = `Couldn't ask Git whether it's ignored: ${formatErrorMessage(err, "git failed")}`;
      for (const candidate of candidates) skip(candidate.index, reason);
      eligible = [];
    }
  }

  const deadline = Date.now() + timeoutMs;
  for (const candidate of eligible) {
    if (options.signal?.aborted) {
      skip(candidate.index, "Setup was cancelled");
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      skip(candidate.index, `Cloning ran out of its ${Math.round(timeoutMs / 1000)}s budget`);
      continue;
    }
    const outcome = await cloneOne(
      candidate,
      roots,
      cloneTree,
      remaining,
      timeoutMs,
      options.signal
    );
    results[candidate.index] = outcome;
  }

  return finish(results, destRoot);
}

async function cloneOne(
  candidate: Candidate,
  roots: { dest: string; realDest: string },
  cloneTree: CloneTree,
  remainingMs: number,
  budgetMs: number,
  outer: AbortSignal | undefined
): Promise<WorktreeSetupClone> {
  const skipped = (reason: string): WorktreeSetupClone => ({
    path: candidate.path,
    outcome: "skipped",
    reason,
  });
  const staging = pathJoin(roots.dest, `${CLONE_STAGING_PREFIX}${randomUUID()}`);
  const payload = pathJoin(staging, "payload");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remainingMs);
  const forwardAbort = (): void => controller.abort();
  outer?.addEventListener("abort", forwardAbort, { once: true });
  const startedAt = Date.now();
  try {
    await mkdir(staging);
    await writeFile(pathJoin(staging, ".gitignore"), "*\n", { flag: "wx" });
    const result = await cloneTree(candidate.src, payload, controller.signal);
    if (timedOut) return skipped(`Cloning ran out of its ${Math.round(budgetMs / 1000)}s budget`);
    if (controller.signal.aborted) return skipped("Setup was cancelled");
    if (!result.ok) return skipped(result.reason);

    const cloned = await lstatOrNull(payload);
    if (!cloned?.isDirectory()) return skipped("It changed while it was being cloned");
    // Last look before publishing: whatever reached the path meanwhile wins,
    // and the parent must still be the folder checked before cloning, since a
    // rename goes wherever its path leads. A process swapping it in the
    // instant left already runs as this user with write access to both trees.
    if (await lstatOrNull(candidate.dest)) return skipped("It already exists in the worktree");
    const parent = await lstatOrNull(candidate.destParent);
    if (!parent?.isDirectory() || !isInside(roots.realDest, await realpath(candidate.destParent))) {
      return skipped("Its parent folder changed while it was being cloned");
    }
    // Rechecked after those awaits, with none between here and the rename.
    if (timedOut) return skipped(`Cloning ran out of its ${Math.round(budgetMs / 1000)}s budget`);
    if (controller.signal.aborted) return skipped("Setup was cancelled");
    try {
      await rename(payload, candidate.dest);
    } catch (err) {
      const code = errorCode(err);
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        return skipped("It already exists in the worktree");
      }
      return skipped(`Couldn't move the clone into place: ${code ?? "rename failed"}`);
    }
    logInfo("[WorktreeClone] cloned ignored directory into new worktree", {
      path: candidate.path,
      destRoot: roots.dest,
      ms: Date.now() - startedAt,
    });
    return { path: candidate.path, outcome: "cloned" };
  } catch (err) {
    return skipped(`Couldn't clone it: ${formatErrorMessage(err, "clone failed")}`);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forwardAbort);
    // Holds only the `.gitignore` after a success; a partial tree otherwise.
    await removeStaging(staging).catch((err: unknown) => {
      logWarn("[WorktreeClone] could not remove a staging directory", {
        staging,
        error: formatErrorMessage(err, "rm failed"),
      });
    });
  }
}

/**
 * Remove a staging directory, partial tree and all. A clone can leave
 * read-only directories behind (`cp -a` applies a directory's mode once its
 * contents are in; `clonefile` copies it outright), and nothing inside one can
 * be unlinked, so a failed first pass makes every directory writable and tries
 * again. Links are never followed: only real directories are touched.
 */
async function removeStaging(staging: string): Promise<void> {
  try {
    await rm(staging, { recursive: true, force: true });
    return;
  } catch {
    await makeDirectoriesWritable(staging);
  }
  await rm(staging, { recursive: true, force: true });
}

async function makeDirectoriesWritable(dir: string): Promise<void> {
  const stats = await lstatOrNull(dir).catch(() => null);
  if (!stats?.isDirectory()) return;
  await chmod(dir, (stats.mode & 0o7777) | 0o700).catch(() => {});
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await makeDirectoriesWritable(pathJoin(dir, entry.name));
  }
}

function finish(results: WorktreeSetupClone[], destRoot: string): WorktreeSetupClone[] {
  const skipped = results.filter((r) => r.outcome === "skipped");
  if (skipped.length > 0) {
    logWarn("[WorktreeClone] skipped cloning ignored directories", {
      destRoot,
      skipped: skipped.map((r) => `${r.path}: ${r.reason ?? ""}`),
    });
  }
  return results;
}
