import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorktreeLocalWork } from "../../../shared/types/worktreeLocalWork.js";
import { pathComparisonKey } from "../../../shared/utils/path.js";
import { readWorktreeGitObservation } from "../mcp-server/worktreeRetirementGit.js";
import { runGitForBytes } from "./reviewPoint/runGit.js";
import { WORKTREE_STATUS_READ_TIMEOUT_MS } from "./worktreeStatusObservation.js";

/** Worktrees read at once for one close review: each read is several git calls in a row. */
const READ_CONCURRENCY = 4;
const SMALL_MAX_BYTES = 64 * 1024;

/** A panel a close names: its project's checkout, and the worktree it sits in. */
export interface WorktreeLocalWorkRequest {
  /** The owning project's root on this host, or null when it isn't known here. */
  projectPath: string | null;
  /** The panel's worktree, which is its normalized root; absent when it carries none. */
  worktreeId: string | undefined;
}

export interface WorktreeLocalWorkOptions {
  signal?: AbortSignal;
  /**
   * How long the whole read may take. Whatever hasn't answered by then is
   * unreadable, and its git calls are stopped.
   */
  deadlineMs?: number;
  /** For tests: the observation itself. */
  readGit?: typeof readWorktreeGitObservation;
}

interface GitLocation {
  top: string;
  gitDir: string;
  commonDir: string;
}

const compareOptions = { caseInsensitive: process.platform === "win32" };
const sameDir = (a: string, b: string) =>
  pathComparisonKey(a, compareOptions) === pathComparisonKey(b, compareOptions);

/** Where git finds the repository asked from `dir`, every path resolved and real. */
async function gitLocation(dir: string, signal: AbortSignal): Promise<GitLocation> {
  const { stdout } = await runGitForBytes(
    dir,
    ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
    { signal, timeoutMs: WORKTREE_STATUS_READ_TIMEOUT_MS, maxStdoutBytes: SMALL_MAX_BYTES }
  );
  const lines = stdout.toString("utf8").split(/\r?\n/);
  if (lines.length !== 4 || lines[3] !== "" || lines.slice(0, 3).some((line) => line === "")) {
    throw new Error("git rev-parse gave no location");
  }
  // The git dirs may come back relative to where git was asked.
  const [top, gitDir, commonDir] = await Promise.all(
    lines.slice(0, 3).map((line) => realpath(path.resolve(dir, line)))
  );
  return { top: top!, gitDir: gitDir!, commonDir: commonDir! };
}

/**
 * What each panel's worktree holds that exists only on this machine (#18151),
 * one answer per request in order. Read here, on the host that owns the
 * worktrees; nothing is fetched.
 *
 * A worktree named by several panels is read once. A panel with no worktree
 * isn't read, and neither is one in its project's main checkout: that is
 * decided from git, and only for a checkout of the project's own repository,
 * so a worktree moved away and replaced by another repository at its old path
 * reads as unreadable rather than as a main checkout to pass over. Any failure,
 * and anything unanswered at the deadline, is unreadable, never clean.
 */
export async function readWorktreesLocalWork(
  requests: readonly WorktreeLocalWorkRequest[],
  options: WorktreeLocalWorkOptions = {}
): Promise<WorktreeLocalWork[]> {
  const readGit = options.readGit ?? readWorktreeGitObservation;
  const signals = [
    options.signal,
    options.deadlineMs !== undefined ? AbortSignal.timeout(options.deadlineMs) : undefined,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : new AbortController().signal;

  const keyOf = (request: WorktreeLocalWorkRequest) =>
    `${request.projectPath ?? ""}\u0000${request.worktreeId ?? ""}`;
  const answers = new Map<string, WorktreeLocalWork>();
  const queue: WorktreeLocalWorkRequest[] = [];
  const named = new Set<string>();
  for (const request of requests) {
    const key = keyOf(request);
    if (named.has(key)) continue;
    named.add(key);
    if (request.worktreeId === undefined) answers.set(key, { kind: "not-applicable" });
    else queue.push(request);
  }

  const projectRepos = new Map<string, Promise<string | null>>();
  const projectRepo = (projectPath: string): Promise<string | null> => {
    let repo = projectRepos.get(projectPath);
    if (repo === undefined) {
      repo = gitLocation(projectPath, signal).then(
        (location) => location.commonDir,
        () => null
      );
      projectRepos.set(projectPath, repo);
    }
    return repo;
  };

  const readOne = async (request: WorktreeLocalWorkRequest): Promise<WorktreeLocalWork> => {
    const worktree = request.worktreeId!;
    if (request.projectPath === null) return { kind: "unreadable" };
    const [location, ownTop, repo] = await Promise.all([
      gitLocation(worktree, signal),
      realpath(worktree),
      projectRepo(request.projectPath),
    ]);
    // A directory that lost its `.git` would answer for whatever contains it.
    if (!sameDir(location.top, ownTop)) return { kind: "unreadable" };
    if (repo === null || !sameDir(location.commonDir, repo)) return { kind: "unreadable" };
    if (sameDir(location.gitDir, location.commonDir)) return { kind: "not-applicable" };
    // A linked worktree's administrative directory names the checkout it
    // belongs to. A copy left at the panel's old path after a move still finds
    // the same repository through its `.git` file, but not this backlink.
    // Only a small regular file is read: a FIFO there would hold the open forever.
    const backlinkPath = path.join(location.gitDir, "gitdir");
    const backlinkStat = await stat(backlinkPath);
    if (!backlinkStat.isFile() || backlinkStat.size > SMALL_MAX_BYTES) {
      return { kind: "unreadable" };
    }
    const backlink = (await readFile(backlinkPath, "utf8")).replace(/\r?\n$/, "");
    const registered = await realpath(path.dirname(path.resolve(location.gitDir, backlink)));
    // Both sides are the filesystem's own spelling, so they compare exactly: two
    // directories that differ only by case or normalization stay apart.
    if (registered !== ownTop) return { kind: "unreadable" };
    const observed = await readGit(worktree, signal);
    return {
      kind: "observed",
      unpushedCommits: observed.unpushedCommits,
      changedEntries: observed.changedEntries,
      hiddenFromStatus: observed.hiddenFromStatus,
    };
  };

  const worker = async () => {
    for (let request = queue.shift(); request !== undefined; request = queue.shift()) {
      const key = keyOf(request);
      if (signal.aborted) {
        answers.set(key, { kind: "unreadable" });
        continue;
      }
      answers.set(
        key,
        await readOne(request).catch((): WorktreeLocalWork => ({ kind: "unreadable" }))
      );
    }
  };
  // The deadline answers for whatever is still out, even a filesystem call
  // that never returns: what finished by then stands, the rest is unreadable.
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker)),
      stopped,
    ]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
  return requests.map((request) => answers.get(keyOf(request)) ?? { kind: "unreadable" });
}
