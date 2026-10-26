import fs from "node:fs";
import path from "node:path";
import {
  REVIEW_POINT_VERSION,
  type ReviewPoint,
  type ReviewPointBaseRequest,
  type ReviewPointCaptureFailure,
  type ReviewPointCaptureResult,
  type ReviewPointEntry,
  type ReviewPointGapReason,
  type ReviewPointGitEntry,
  type ReviewPointHead,
  type ReviewPointIncompleteReason,
  type ReviewPointIndexIdentity,
  type ReviewPointUncovered,
  type ReviewPointWorktreeIdentity,
} from "../../../../shared/types/reviewPoint.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { validateBranchName } from "../../../../shared/utils/pathPattern.js";
import { resolveExistingBaseCompareTarget } from "../../../utils/baseCompareRef.js";
import { resolveGitDirFromFs } from "../../../utils/gitUtils.js";
import {
  parseConfigListing,
  parseDiffTreeRaw,
  parseIndexListing,
  parsePorcelainV2,
  type IndexListingRecord,
  type StatusChangedRecord,
  type StatusUnmergedRecord,
} from "./parseGitRecords.js";
import {
  GitOutputLimitError,
  GitTimeoutError,
  runGitForBytes,
  type RunGitOptions,
  type RunGitResult,
} from "./runGit.js";
import {
  absoluteWorktreePath,
  lstatOrNull,
  readWorktreePath,
  statSignature,
  type ObjectFormat,
  type ReadBudget,
} from "./readWorktreePath.js";

/**
 * Capture a review point (#14582): the worktree's HEAD, the base it is compared
 * against, and an identity for every path in its change set, without writing
 * to the repository. See `shared/types/reviewPoint.ts` for what each field
 * claims.
 *
 * Read-only by construction rather than by care:
 * - status runs with `GIT_OPTIONAL_LOCKS=0`, so it never refreshes the index;
 * - every clean and process filter the repository configures is switched off
 *   for the capture's commands, because status hashes a stat-dirty file
 *   through its clean filter, and a clean filter is the repository's own
 *   program (git-lfs's writes into `.git/lfs/objects`);
 * - submodules are read one level down with their own filters switched off,
 *   instead of letting status recurse into them with theirs on;
 * - no object is ever hashed by git: working-tree identities are computed here.
 *
 * Runs in the process that owns the repository's filesystem, so on a Remote
 * Host it runs on the host, beside the repository.
 */

export interface ReviewPointLimits {
  /** Paths given an entry; the rest are listed as uncovered. */
  maxPaths: number;
  maxFileBytes: number;
  /** Working-tree bytes read across the whole capture. */
  maxTotalBytes: number;
  /** Stdout of any one git command. */
  maxGitOutputBytes: number;
  timeoutMs: number;
  /** Uncovered paths named in the point; the count covers the rest. */
  maxUncoveredListed: number;
}

export const DEFAULT_REVIEW_POINT_LIMITS: ReviewPointLimits = {
  maxPaths: 10_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxGitOutputBytes: 64 * 1024 * 1024,
  timeoutMs: 30_000,
  maxUncoveredListed: 200,
};

export interface CaptureReviewPointOptions {
  base: ReviewPointBaseRequest;
  signal?: AbortSignal;
  limits?: Partial<ReviewPointLimits>;
  /** Test seam: awaited after the reads, before the capture confirms nothing moved. */
  beforeValidation?: () => Promise<void>;
}

/** The empty tree, which every path in HEAD differs from. */
const EMPTY_TREE: Record<ObjectFormat, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

const READ_CONCURRENCY = 8;
/** Share of the time budget the reads may spend; the rest confirms nothing moved. */
const READ_PHASE_SHARE = 0.7;
/** A submodule's status is only read for whether it says anything. */
const SUBMODULE_STATUS_BYTES = 64 * 1024;
const OID_LINE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ABSENT_MODE = /^0+$/;

class CaptureStopped extends Error {
  constructor(readonly reason: "cancelled" | "deadline") {
    super(reason);
  }
}

class InvalidRequest extends Error {}

export async function captureReviewPoint(
  cwd: string,
  options: CaptureReviewPointOptions
): Promise<ReviewPointCaptureResult> {
  const limits = { ...DEFAULT_REVIEW_POINT_LIMITS, ...options.limits };
  if (options.signal?.aborted) return failed("cancelled", "The capture was cancelled.");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new CaptureStopped("deadline")),
    limits.timeoutMs
  );
  const onAbort = () => controller.abort(new CaptureStopped("cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await capture(cwd, options, limits, controller.signal);
  } catch (error) {
    const stopped = controller.signal.aborted ? controller.signal.reason : null;
    if (stopped instanceof CaptureStopped || error instanceof GitTimeoutError) {
      const reason = stopped instanceof CaptureStopped ? stopped.reason : "deadline";
      return failed(
        reason,
        reason === "deadline" ? "The capture ran out of time." : "The capture was cancelled."
      );
    }
    if (error instanceof InvalidRequest) return failed("invalid-request", error.message);
    return failed("git-failed", formatErrorMessage(error, "The capture failed."));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function failed(reason: ReviewPointCaptureFailure, message: string): ReviewPointCaptureResult {
  return { kind: "failed", reason, message };
}

type Git = (
  args: readonly string[],
  extra?: Partial<RunGitOptions> & { cwd?: string }
) => Promise<RunGitResult>;

/** One path of the change set, with whatever each listing said about it. */
interface Candidate {
  path: Buffer;
  status?: StatusChangedRecord | StatusUnmergedRecord;
  /** HEAD's side of an unmerged path, which status doesn't report. */
  unmergedHead?: ReviewPointGitEntry | null;
  committed?: ReviewPointGitEntry | null;
  index?: IndexListingRecord[];
  /** Kept only if its file turns out to exist: sparse checkouts leave most absent. */
  skipWorktreeOnly?: boolean;
  /** Kept only if the submodule moved or isn't clean. */
  gitlinkOnly?: boolean;
  worktree?: WorktreeOutcome;
}

interface WorktreeOutcome {
  identity: ReviewPointWorktreeIdentity;
  /** Re-checked once every read is done; null when there is nothing to re-check. */
  recheck: (() => Promise<boolean>) | null;
}

interface RepositorySettings {
  filterDrivers: string[];
  fileMode: boolean;
  symlinks: boolean;
}

async function capture(
  cwd: string,
  options: CaptureReviewPointOptions,
  limits: ReviewPointLimits,
  signal: AbortSignal
): Promise<ReviewPointCaptureResult> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + limits.timeoutMs;
  const readsEndAt = startedAt + limits.timeoutMs * READ_PHASE_SHARE;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    return failed("not-a-repository", "The worktree path must be absolute.");
  }

  let root = cwd;
  let filterConfig: RunGitOptions["config"] = [];
  const git: Git = (args, extra = {}) =>
    runGitForBytes(extra.cwd ?? root, args, {
      signal,
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      maxStdoutBytes: limits.maxGitOutputBytes,
      config: filterConfig,
      ...extra,
    });

  let located: RunGitResult;
  try {
    located = await git([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
      "--show-object-format",
    ]);
  } catch (error) {
    if (signal.aborted) throw error;
    return failed("not-a-repository", formatErrorMessage(error, "Not a git worktree."));
  }
  const lines = located.stdout.toString("utf8").split("\n");
  if (lines.length !== 5 || lines[4] !== "") throw new Error("Unexpected rev-parse output");
  const [toplevel, gitDir, commonDir, objectFormat] = lines;
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`Unsupported object format: ${objectFormat}`);
  }
  root = toplevel;

  const settings = await readRepositorySettings(git, root);
  filterConfig = disableFilters(settings.filterDrivers);

  const indexPath = path.join(gitDir, "index");
  const indexBefore = statSignature(await lstatOrNull(indexPath));

  const reasons = new Set<ReviewPointIncompleteReason>();
  const subtrees: Array<{ path: Buffer; reason: ReviewPointGapReason }> = [];
  let listingComplete = true;

  // -- What changed: status, the branch's commits, and the index ------------

  const status = await listStatus(git, limits);
  let headOid: string | null;
  let headBranch: string | null;
  if (status) {
    ({ headOid, headBranch } = status.parsed);
  } else {
    listingComplete = false;
    reasons.add("change-set-too-large");
    ({ headOid, headBranch } = await readHead(git));
  }

  let head: ReviewPointHead;
  if (headOid === null) {
    if (headBranch === null) throw new Error("HEAD is neither a branch nor a commit");
    head = { kind: "unborn", branch: headBranch };
  } else {
    head = headBranch
      ? { kind: "branch", branch: headBranch, commit: headOid }
      : { kind: "detached", commit: headOid };
  }

  const base = await resolveBase(git, options.base, headOid);
  // Without a base the branch's own commits can't be told apart from history;
  // an unborn branch has none to tell apart.
  if (base.tip === null && headOid !== null) reasons.add("base-unavailable");

  const candidates = new Map<string, Candidate>();
  const candidateFor = (bytes: Buffer): Candidate => {
    const key = bytes.toString("latin1");
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = { path: bytes };
      candidates.set(key, candidate);
    }
    return candidate;
  };

  let hasUnmerged = false;
  for (const record of status?.parsed.records ?? []) {
    if (record.kind === "untracked") {
      // A directory: with every untracked file listed, only a nested
      // repository is left whole; in the collapsed listing, any directory.
      if (record.path[record.path.length - 1] === 0x2f) {
        const nested = await lstatOrNull(
          absoluteWorktreePath(root, Buffer.concat([record.path, Buffer.from(".git")]))
        ).catch(() => null);
        subtrees.push({
          path: record.path,
          reason: nested ? "nested-repository" : "untracked-directory",
        });
      } else {
        candidateFor(record.path);
      }
      continue;
    }
    if (record.kind === "unmerged") hasUnmerged = true;
    candidateFor(record.path).status = record;
  }

  if (hasUnmerged && headOid) {
    // `diff-index --cached` compares the index with HEAD only, never the
    // working tree, and reports HEAD's side of each unmerged path.
    try {
      const out = await git(["diff-index", "--cached", "-r", "-z", "--no-renames", headOid]);
      for (const record of parseDiffTreeRaw(out.stdout)) {
        const candidate = candidates.get(record.path.toString("latin1"));
        if (candidate?.status?.kind === "unmerged") {
          candidate.unmergedHead = gitEntryOrNull(record.srcMode, record.srcOid);
        }
      }
    } catch (error) {
      if (!(error instanceof GitOutputLimitError)) throw error;
      listingComplete = false;
      reasons.add("change-set-too-large");
    }
  }

  if (headOid && base.tip) {
    const from = base.mergeBases.length > 0 ? base.mergeBases : [EMPTY_TREE[objectFormat]];
    try {
      for (const tree of from) {
        const out = await git(["diff-tree", "-r", "-z", "--no-renames", tree, headOid]);
        for (const record of parseDiffTreeRaw(out.stdout)) {
          candidateFor(record.path).committed = gitEntryOrNull(record.dstMode, record.dstOid);
        }
      }
    } catch (error) {
      if (!(error instanceof GitOutputLimitError)) throw error;
      listingComplete = false;
      reasons.add("change-set-too-large");
    }
  }

  try {
    const out = await git(["ls-files", "-s", "-v", "-z"]);
    for (const record of parseIndexListing(out.stdout)) {
      const key = record.path.toString("latin1");
      const existing = candidates.get(key);
      if (existing) {
        (existing.index ??= []).push(record);
        continue;
      }
      if (record.stage !== 0) continue;
      // Paths git has been told not to look at in the working tree. A change
      // there never reaches status, so the capture looks itself.
      const assumeUnchanged = /^[a-z]$/.test(record.tag);
      const skipWorktree = record.tag === "S" || record.tag === "s";
      const gitlink = record.mode === "160000";
      if (!assumeUnchanged && !skipWorktree && !gitlink) continue;
      const candidate = candidateFor(record.path);
      candidate.index = [record];
      candidate.skipWorktreeOnly = skipWorktree && !assumeUnchanged;
      candidate.gitlinkOnly = gitlink && !assumeUnchanged && !skipWorktree;
    }
  } catch (error) {
    if (!(error instanceof GitOutputLimitError)) throw error;
    listingComplete = false;
    reasons.add("change-set-too-large");
  }

  // -- The working tree -------------------------------------------------------

  const budget: ReadBudget = {
    remainingBytes: limits.maxTotalBytes,
    maxFileBytes: limits.maxFileBytes,
    signal,
  };
  let moved = false;
  const readCandidate = async (candidate: Candidate): Promise<void> => {
    if (moved || candidate.worktree) return;
    if (Date.now() >= readsEndAt) {
      candidate.worktree = { identity: unverifiable("deadline"), recheck: null };
      return;
    }
    const outcome = await readWorktree(candidate, root, objectFormat, budget, settings, git);
    if (outcome === "moved") moved = true;
    else candidate.worktree = outcome;
  };

  // Conditional candidates first: whether they belong in the change set at all
  // depends on what the working tree holds.
  const conditional = [...candidates.values()].filter(
    (candidate) => candidate.skipWorktreeOnly || candidate.gitlinkOnly
  );
  await forEachLimited(conditional, READ_CONCURRENCY, readCandidate);
  if (moved) return { kind: "changed-during-capture" };
  for (const [key, candidate] of candidates) {
    const identity = candidate.worktree?.identity;
    if (!identity || identity.kind === "unverifiable") continue;
    const dropSkipped = candidate.skipWorktreeOnly && identity.kind === "absent";
    const dropGitlink =
      candidate.gitlinkOnly &&
      identity.kind === "submodule" &&
      identity.contents === "clean" &&
      (identity.commit === null || identity.commit === candidate.index?.[0]?.oid);
    if (dropSkipped || dropGitlink) candidates.delete(key);
  }

  const ordered = [...candidates.values()].sort((a, b) => Buffer.compare(a.path, b.path));
  const kept = ordered.slice(0, limits.maxPaths);
  const overLimit = ordered.slice(limits.maxPaths);

  await forEachLimited(kept, READ_CONCURRENCY, readCandidate);
  if (moved) return { kind: "changed-during-capture" };

  // -- Did anything move while it was read? -----------------------------------

  await options.beforeValidation?.();
  if (status) {
    try {
      const again = await git(status.args);
      if (!again.stdout.equals(status.output)) return { kind: "changed-during-capture" };
    } catch (error) {
      if (error instanceof GitOutputLimitError) return { kind: "changed-during-capture" };
      throw error;
    }
  } else {
    const again = await readHead(git);
    if (again.headOid !== headOid || again.headBranch !== headBranch) {
      return { kind: "changed-during-capture" };
    }
  }
  if (statSignature(await lstatOrNull(indexPath)) !== indexBefore) {
    return { kind: "changed-during-capture" };
  }
  let unchanged = true;
  await forEachLimited(kept, READ_CONCURRENCY, async (candidate) => {
    const recheck = candidate.worktree?.recheck;
    if (unchanged && recheck && !(await recheck())) unchanged = false;
  });
  if (!unchanged) return { kind: "changed-during-capture" };

  // -- The point --------------------------------------------------------------

  const entries: ReviewPointEntry[] = [];
  const uncovered: Array<{ path: Buffer; reason: ReviewPointGapReason }> = [...subtrees];
  for (const candidate of kept) {
    const worktree = candidate.worktree?.identity ?? unverifiable("deadline");
    entries.push({
      ...pathFields(candidate.path),
      head: headIdentity(candidate),
      index: indexIdentity(candidate),
      worktree,
    });
    if (worktree.kind === "unverifiable") {
      uncovered.push({ path: candidate.path, reason: worktree.reason });
    } else if (worktree.kind === "submodule" && worktree.contents !== "clean") {
      uncovered.push({ path: candidate.path, reason: "submodule-contents" });
    }
  }
  for (const candidate of overLimit) uncovered.push({ path: candidate.path, reason: "path-limit" });
  for (const gap of uncovered) reasons.add(gap.reason);

  uncovered.sort((a, b) => Buffer.compare(a.path, b.path));
  const point: ReviewPoint = {
    version: REVIEW_POINT_VERSION,
    capturedAt: Date.now(),
    worktreePath: root,
    gitDir,
    commonDir,
    objectFormat,
    head,
    base,
    entries,
    incomplete:
      reasons.size === 0
        ? null
        : {
            reasons: [...reasons].sort(),
            uncovered: uncovered
              .slice(0, limits.maxUncoveredListed)
              .map((gap): ReviewPointUncovered => ({ ...pathFields(gap.path), reason: gap.reason })),
            uncoveredCount: listingComplete ? uncovered.length : null,
          },
  };
  return { kind: "captured", point };
}

// -- Listings -----------------------------------------------------------------

function statusArgs(untracked: "all" | "normal"): string[] {
  return [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--no-ahead-behind",
    "--no-renames",
    `--untracked-files=${untracked}`,
    // Reports a submodule whose checked-out commit moved without running
    // status inside it; its contents are read separately, filters off.
    "--ignore-submodules=dirty",
  ];
}

/**
 * Status with every untracked file listed, or, when that is more than the
 * capture can cover, with untracked directories collapsed so they can at least
 * be named as uncovered. Null when even that doesn't fit.
 */
async function listStatus(
  git: Git,
  limits: ReviewPointLimits
): Promise<{ args: string[]; output: Buffer; parsed: ReturnType<typeof parsePorcelainV2> } | null> {
  for (const untracked of ["all", "normal"] as const) {
    const args = statusArgs(untracked);
    try {
      const { stdout } = await git(args);
      const parsed = parsePorcelainV2(stdout);
      if (untracked === "all" && parsed.records.length > limits.maxPaths) continue;
      return { args, output: stdout, parsed };
    } catch (error) {
      if (!(error instanceof GitOutputLimitError)) throw error;
    }
  }
  return null;
}

async function readHead(git: Git): Promise<{ headOid: string | null; headBranch: string | null }> {
  const symbolic = await git(["symbolic-ref", "-q", "HEAD"], { okExitCodes: [1] });
  const commit = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { okExitCodes: [1] });
  const ref = symbolic.stdout.toString("utf8").trim();
  const oid = commit.stdout.toString("utf8").trim();
  return {
    headOid: OID_LINE.test(oid) ? oid : null,
    headBranch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
  };
}

async function resolveBase(
  git: Git,
  requested: ReviewPointBaseRequest,
  headOid: string | null
): Promise<ReviewPoint["base"]> {
  let ref: string | null;
  if (requested.kind === "branch") {
    if (!validateBranchName(requested.branch).valid) {
      throw new InvalidRequest("The base branch name isn't valid.");
    }
    const target = await resolveExistingBaseCompareTarget(
      { raw: async (args) => (await git(args)).stdout.toString("utf8") },
      requested.branch
    );
    ref = target?.fullRef ?? null;
  } else {
    const name = requested.ref.startsWith("refs/") ? requested.ref.slice("refs/".length) : "";
    if (!validateBranchName(name).valid) throw new InvalidRequest("The base ref isn't valid.");
    ref = requested.ref;
  }

  let tip: string | null = null;
  if (ref) {
    const out = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { okExitCodes: [1] });
    const oid = out.stdout.toString("utf8").trim();
    tip = OID_LINE.test(oid) ? oid : null;
  }
  if (tip === null) return { requested, ref: null, tip: null, mergeBases: [] };

  let mergeBases: string[] = [];
  if (headOid) {
    // `--all`: with criss-cross history there is more than one best ancestor
    // and git won't say which it would pick, so the change set covers each.
    const out = await git(["merge-base", "--all", headOid, tip], { okExitCodes: [1] });
    mergeBases = out.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => OID_LINE.test(line))
      .slice(0, 64);
  }
  return { requested, ref, tip, mergeBases };
}

async function readRepositorySettings(git: Git, cwd: string): Promise<RepositorySettings> {
  const out = await git(
    [
      "config",
      "-z",
      "--get-regexp",
      "^(filter\\..+\\.(clean|process|required)|core\\.(filemode|symlinks))$",
    ],
    { cwd, okExitCodes: [1] }
  );
  const settings: RepositorySettings = { filterDrivers: [], fileMode: true, symlinks: true };
  const drivers = new Set<string>();
  for (const { key, value } of parseConfigListing(out.stdout)) {
    if (key === "core.filemode") settings.fileMode = gitBool(value);
    else if (key === "core.symlinks") settings.symlinks = gitBool(value);
    else drivers.add(key.slice("filter.".length, key.lastIndexOf(".")));
  }
  settings.filterDrivers = [...drivers];
  return settings;
}

function gitBool(value: string | null): boolean {
  if (value === null) return true;
  return !["false", "no", "off", "0", ""].includes(value.trim().toLowerCase());
}

/** Switch a driver's clean side off, and stop git failing a path for lacking it. */
function disableFilters(drivers: readonly string[]): Array<readonly [string, string]> {
  return drivers.flatMap((name) => [
    [`filter.${name}.clean`, ""] as const,
    [`filter.${name}.process`, ""] as const,
    [`filter.${name}.required`, "false"] as const,
  ]);
}

// -- Working-tree reads -------------------------------------------------------

async function readWorktree(
  candidate: Candidate,
  root: string,
  objectFormat: ObjectFormat,
  budget: ReadBudget,
  settings: RepositorySettings,
  git: Git
): Promise<WorktreeOutcome | "moved"> {
  const target = absoluteWorktreePath(root, candidate.path);
  const index = indexIdentity(candidate);
  const indexMode = index.kind === "entry" ? index.mode : null;
  const headMode = headIdentity(candidate)?.mode ?? null;

  const isGitlink = indexMode === "160000" || (index.kind === "absent" && headMode === "160000");
  if (isGitlink) {
    const stats = await lstatOrNull(target);
    if (stats?.isDirectory()) return readSubmodule(target.toString(), git);
  }

  const { read, signature } = await readWorktreePath(
    target,
    objectFormat,
    budget,
    settings.fileMode,
    indexMode
  );
  const recheck = async () => statSignature(await lstatOrNull(target)) === signature;
  switch (read.kind) {
    case "changed":
      return "moved";
    case "absent":
    case "directory":
      return { identity: { kind: read.kind }, recheck };
    case "symlink":
      return { identity: { kind: "symlink", oid: read.oid }, recheck };
    case "file":
      // With `core.symlinks` off (Windows' default) git checks a link out as a
      // file holding its text, and still tracks it as a link.
      if (!settings.symlinks && indexMode === "120000") {
        return { identity: { kind: "symlink", oid: read.oid }, recheck };
      }
      return {
        identity: { kind: "file", mode: read.mode, oid: read.oid, size: read.size },
        recheck,
      };
    case "too-large":
      return { identity: unverifiable(read.reason), recheck: null };
    case "special":
      return { identity: unverifiable("special-file"), recheck: null };
    case "unreadable":
      return { identity: unverifiable("unreadable"), recheck: null };
  }
}

/**
 * The commit a submodule has checked out, and whether its own status reports
 * anything. Bound to the submodule's git dir explicitly: run from an
 * unpopulated submodule, plain discovery would walk up and answer for the
 * superproject.
 */
async function readSubmodule(target: string, git: Git): Promise<WorktreeOutcome> {
  const gitDir = await resolveGitDirFromFs(target);
  if (!gitDir) {
    let names: string[];
    try {
      names = await fs.promises.readdir(target);
    } catch {
      return { identity: unverifiable("unreadable"), recheck: null };
    }
    // An unpopulated submodule is an empty directory, which git counts as
    // unchanged; anything else in there is nothing git can vouch for.
    return {
      identity: { kind: "submodule", commit: null, contents: names.length === 0 ? "clean" : "unknown" },
      recheck: async () => (await fs.promises.readdir(target).catch(() => [])).length === names.length,
    };
  }

  const bound = ["--git-dir", gitDir, "--work-tree", target];
  const readCommit = async () => {
    const out = await git([...bound, "rev-parse", "--verify", "-q", "HEAD^{commit}"], {
      cwd: target,
      config: [],
      okExitCodes: [1],
    });
    const oid = out.stdout.toString("utf8").trim();
    return OID_LINE.test(oid) ? oid : null;
  };
  const commit = await readCommit();
  if (!commit) return { identity: unverifiable("unreadable"), recheck: null };

  const settings = await readRepositorySettings(
    (args, extra) => git([...bound, ...args], { ...extra, config: [] }),
    target
  );
  let dirty: boolean;
  try {
    const out = await git(
      [...bound, "status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=dirty"],
      { cwd: target, config: disableFilters(settings.filterDrivers), maxStdoutBytes: SUBMODULE_STATUS_BYTES }
    );
    dirty = out.stdout.length > 0;
  } catch (error) {
    if (!(error instanceof GitOutputLimitError)) throw error;
    dirty = true;
  }
  // One level down only: a submodule of its own would need the same care again.
  const nested = (await lstatOrNull(path.join(target, ".gitmodules")).catch(() => null)) !== null;
  return {
    identity: {
      kind: "submodule",
      commit,
      contents: dirty ? "dirty" : nested ? "unknown" : "clean",
    },
    recheck: async () => (await readCommit()) === commit,
  };
}

// -- Identities ---------------------------------------------------------------

function gitEntryOrNull(mode: string, oid: string): ReviewPointGitEntry | null {
  if (ABSENT_MODE.test(mode)) return null;
  if (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000") {
    throw new Error(`Unexpected git mode ${mode}`);
  }
  return { mode, oid };
}

function headIdentity(candidate: Candidate): ReviewPointGitEntry | null {
  const { status } = candidate;
  if (status?.kind === "changed") return gitEntryOrNull(status.modeHead, status.oidHead);
  if (status?.kind === "unmerged") return candidate.unmergedHead ?? null;
  if (candidate.committed !== undefined) return candidate.committed;
  // Not in status: the index matches HEAD.
  const stageZero = candidate.index?.find((record) => record.stage === 0);
  return stageZero ? gitEntryOrNull(stageZero.mode, stageZero.oid) : null;
}

function indexIdentity(candidate: Candidate): ReviewPointIndexIdentity {
  const { status } = candidate;
  if (status?.kind === "unmerged") return conflicted(status.stages);
  if (status?.kind === "changed") {
    // `.A`: added with `git add -N`, so nothing is staged for it yet.
    if (status.xy[1] === "A") return { kind: "intent-to-add" };
    const entry = gitEntryOrNull(status.modeIndex, status.oidIndex);
    return entry ? { kind: "entry", ...entry } : { kind: "absent" };
  }
  const records = candidate.index ?? [];
  const stageZero = records.find((record) => record.stage === 0);
  if (stageZero) {
    const entry = gitEntryOrNull(stageZero.mode, stageZero.oid);
    return entry ? { kind: "entry", ...entry } : { kind: "absent" };
  }
  if (records.length > 0) {
    return conflicted(
      records.map((record) => ({ stage: record.stage as 1 | 2 | 3, mode: record.mode, oid: record.oid }))
    );
  }
  // Committed but not in status: the index matches HEAD.
  if (candidate.committed) return { kind: "entry", ...candidate.committed };
  return { kind: "absent" };
}

function conflicted(
  stages: ReadonlyArray<{ stage: 1 | 2 | 3; mode: string; oid: string }>
): ReviewPointIndexIdentity {
  return {
    kind: "conflicted",
    stages: stages.flatMap(({ stage, mode, oid }) => {
      const entry = gitEntryOrNull(mode, oid);
      return entry ? [{ stage, ...entry }] : [];
    }),
  };
}

function unverifiable(
  reason: Extract<ReviewPointWorktreeIdentity, { kind: "unverifiable" }>["reason"]
): ReviewPointWorktreeIdentity {
  return { kind: "unverifiable", reason };
}

/** The path as text when that is exact, with its bytes alongside when it isn't. */
function pathFields(bytes: Buffer): { path: string; pathBytes?: string } {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes)
    ? { path: text }
    : { path: text, pathBytes: bytes.toString("base64") };
}

/** Runs `run` over `items`, `limit` at a time; the first failure stops the rest. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await run(items[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}
