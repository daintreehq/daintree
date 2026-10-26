import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ReviewComparisonChange,
  ReviewComparisonCommit,
  ReviewComparisonCommits,
  ReviewComparisonFailure,
  ReviewComparisonFile,
  ReviewComparisonGap,
  ReviewComparisonIncompleteReason,
  ReviewComparisonResult,
  ReviewComparisonSide,
} from "../../../../shared/types/reviewComparison.js";
import {
  ReviewPointSchema,
  reviewPointPathBytes,
  reviewPointPathKey,
  type ReviewPoint,
  type ReviewPointEntry,
  type ReviewPointGitEntry,
  type ReviewPointHead,
  type ReviewPointIncompleteReason,
  type ReviewPointIndexIdentity,
  type ReviewPointUncovered,
  type ReviewPointWorktreeIdentity,
} from "../../../../shared/types/reviewPoint.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import {
  DEFAULT_REVIEW_POINT_LIMITS,
  EMPTY_TREE,
  OID_LINE,
  captureWorktree,
  rejectOnAbort,
  type ReviewPointLimits,
  type WorktreeVsIndex,
} from "./captureReviewPoint.js";
import { parseDiffTreeRaw, type TreeDiffRecord } from "./parseGitRecords.js";
import {
  GitCommandError,
  GitOutputLimitError,
  GitTimeoutError,
  runGitForBytes,
  type RunGitOptions,
  type RunGitResult,
} from "./runGit.js";

/**
 * Compare a worktree as it is now against a review point (#14583): which paths
 * differ from what the point recorded, in the index or the working tree, and
 * which commits arrived. See `shared/types/reviewComparison.ts` for what the
 * result claims.
 *
 * The current state is a fresh capture against the point's own base request,
 * with every path the point listed read again, so each listed path is compared
 * raw bytes to raw bytes. A path neither capture listed held the same thing in
 * HEAD, the index and the working tree as its HEAD commit (or, with the
 * reviewed commit gone, its merge base), so a tree diff of those two commits
 * finds every such path that changed. Files therefore never depend on the
 * reviewed commit's history surviving; only the commit list does.
 *
 * Read-only like the capture: the commands here only read objects and refs.
 */

export interface ReviewComparisonLimits extends ReviewPointLimits {
  /** Commits listed; past this the list says it's truncated. */
  maxCommits: number;
}

export const DEFAULT_REVIEW_COMPARISON_LIMITS: ReviewComparisonLimits = {
  ...DEFAULT_REVIEW_POINT_LIMITS,
  maxCommits: 1_000,
};

export interface CompareReviewPointOptions {
  signal?: AbortSignal;
  limits?: Partial<ReviewComparisonLimits>;
}

/** Share of the time budget the capture may spend; the rest reads history. */
const CAPTURE_SHARE = 0.8;

class ComparisonStopped extends Error {
  constructor(readonly reason: "cancelled" | "deadline") {
    super(reason);
  }
}

export async function compareReviewPoint(
  cwd: string,
  reviewed: unknown,
  options: CompareReviewPointOptions = {}
): Promise<ReviewComparisonResult> {
  const limits = { ...DEFAULT_REVIEW_COMPARISON_LIMITS, ...options.limits };
  if (options.signal?.aborted) return failed("cancelled", "The comparison was cancelled.");
  const parsed = ReviewPointSchema.safeParse(reviewed);
  if (!parsed.success) return failed("invalid-review-point", "The review point isn't valid.");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ComparisonStopped("deadline")),
    limits.timeoutMs
  );
  const onAbort = () => controller.abort(new ComparisonStopped("cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const work = compare(cwd, parsed.data, limits, controller.signal);
    // As in the capture: a stalled filesystem call can't be cancelled, so the
    // caller is answered when the signal fires.
    work.catch(() => {});
    return await Promise.race([work, rejectOnAbort(controller.signal)]);
  } catch (error) {
    const stopped = controller.signal.aborted ? controller.signal.reason : null;
    if (stopped instanceof ComparisonStopped || error instanceof GitTimeoutError) {
      const reason = stopped instanceof ComparisonStopped ? stopped.reason : "deadline";
      return failed(
        reason,
        reason === "deadline" ? "The comparison ran out of time." : "The comparison was cancelled."
      );
    }
    return failed("git-failed", formatErrorMessage(error, "The comparison failed."));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function failed(reason: ReviewComparisonFailure, message: string): ReviewComparisonResult {
  return { state: "failed", reason, message };
}

type Git = (args: readonly string[], extra?: Partial<RunGitOptions>) => Promise<RunGitResult>;

/** One path, with whatever each source said about it. */
interface Candidate {
  bytes: Uint8Array;
  fields: { path: string; pathBytes?: string };
  reviewed?: ReviewPointEntry;
  current?: ReviewPointEntry;
  /** The path in the diff of the reviewed tree against HEAD now. */
  diff?: TreeDiffRecord;
}

async function compare(
  cwd: string,
  reviewed: ReviewPoint,
  limits: ReviewComparisonLimits,
  signal: AbortSignal
): Promise<ReviewComparisonResult> {
  const deadlineAt = Date.now() + limits.timeoutMs;
  if (process.platform === "win32" && !usableOnWindows(reviewed)) {
    return failed("invalid-review-point", "The review point names a path Windows can't hold.");
  }
  // Every path the point has anything to say about is read again, so it's
  // compared like for like whether or not it is still in the change set.
  const include = [
    ...reviewed.entries,
    ...(reviewed.incomplete?.uncovered ?? []).filter((gap) => !isSubtree(gap)),
  ].map(pathBytesOf);

  const captured = await captureWorktree(cwd, {
    base: reviewed.base.requested,
    signal,
    include,
    limits: { ...limits, timeoutMs: Math.max(1, limits.timeoutMs * CAPTURE_SHARE) },
  });
  if (captured.kind === "changed-during-capture") {
    return failed("changed-during-compare", "The worktree changed while it was being compared.");
  }
  if (captured.kind === "failed") return failed(captured.reason, captured.message);
  const { point: current, worktreeVsIndex } = captured.capture;
  if (
    current.objectFormat !== reviewed.objectFormat ||
    current.commonDir !== reviewed.commonDir ||
    current.worktreePath !== reviewed.worktreePath
  ) {
    return failed("invalid-review-point", "The review point was taken in another worktree.");
  }
  if (!sameBranch(reviewed.head, current.head)) {
    return { state: "different-branch", reviewed: reviewed.head, current: current.head };
  }

  const git: Git = (args, extra = {}) =>
    runGitForBytes(current.worktreePath, args, {
      signal,
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      maxStdoutBytes: limits.maxGitOutputBytes,
      ...extra,
    });

  const emptyTree = EMPTY_TREE[current.objectFormat];
  const reviewedCommit = reviewed.head.kind === "unborn" ? null : reviewed.head.commit;
  const currentCommit = current.head.kind === "unborn" ? null : current.head.commit;
  const present = await existingCommits(git, [
    reviewedCommit,
    reviewed.base.tip,
    ...reviewed.base.mergeBases,
    current.base.tip,
  ]);

  // What the reviewed point's unlisted paths held: its HEAD commit, or any
  // merge base, which its change set made identical to HEAD outside the set.
  let reviewedTree: string | null = null;
  if (reviewedCommit === null) reviewedTree = emptyTree;
  else if (present.has(reviewedCommit)) reviewedTree = reviewedCommit;
  else {
    reviewedTree = reviewed.base.mergeBases.find((oid) => present.has(oid)) ?? null;
    // A base with no common ancestor put every path in HEAD in the change set.
    if (reviewed.base.tip !== null && reviewed.base.mergeBases.length === 0) {
      reviewedTree = emptyTree;
    }
  }
  const currentTree = currentCommit ?? emptyTree;

  const reasons = new Set<ReviewComparisonIncompleteReason>();
  if (reviewedTree === null) reasons.add("reviewed-state-unavailable");
  if (
    reviewed.incomplete?.reasons.some(
      (reason) => reason !== "base-unavailable" || reviewedTree === null
    )
  ) {
    reasons.add("reviewed-point-incomplete");
  }
  if (current.incomplete?.reasons.some((reason) => reason !== "base-unavailable")) {
    reasons.add("current-state-incomplete");
  }

  const candidates = new Map<string, Candidate>();
  const candidateFor = (fields: { path: string; pathBytes?: string }): Candidate => {
    const key = reviewPointPathKey(fields);
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = { bytes: pathBytesOf(fields), fields: pathFieldsOf(fields) };
      candidates.set(key, candidate);
    }
    return candidate;
  };
  for (const entry of reviewed.entries) candidateFor(entry).reviewed = entry;
  for (const entry of current.entries) candidateFor(entry).current = entry;
  for (const gap of reviewed.incomplete?.uncovered ?? []) {
    if (!isSubtree(gap)) candidateFor(gap);
  }

  let treesDiffed = reviewedTree !== null;
  if (reviewedTree !== null && reviewedTree !== currentTree) {
    try {
      const out = await git(["diff-tree", "-r", "-z", "--no-renames", reviewedTree, currentTree]);
      for (const record of parseDiffTreeRaw(out.stdout)) {
        candidateFor(pathFieldsOf(record.path)).diff = record;
      }
    } catch (error) {
      if (error instanceof GitOutputLimitError) reasons.add("change-set-too-large");
      // The commit is there but its tree isn't, as in a shallow or partial clone.
      else if (error instanceof GitCommandError) reasons.add("reviewed-state-unavailable");
      else throw error;
      treesDiffed = false;
    }
  }

  const baseChanged = await baseUpdatePaths(git, reviewed, current, present);
  const bothHaveBase = reviewed.base.tip !== null && current.base.tip !== null;
  const reviewedCoverage = coverage(reviewed);
  const currentCoverage = coverage(current);

  const files: ReviewComparisonFile[] = [];
  const ordered = [...candidates.entries()].sort(([, a], [, b]) =>
    Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))
  );
  for (const [key, candidate] of ordered) {
    let reviewedSide = sideFrom(reviewedCoverage, candidate.bytes, candidate.reviewed);
    if (!reviewedSide) {
      if (reviewedTree === null) {
        reviewedSide = { kind: "uncovered", reason: "reviewed-state-unavailable" };
      } else if (candidate.diff) {
        reviewedSide = {
          kind: "unlisted",
          entry: gitEntry(candidate.diff.srcMode, candidate.diff.srcOid),
        };
      } else if (treesDiffed && candidate.current) {
        // Not in the tree diff, so the reviewed tree had what HEAD has now.
        reviewedSide = { kind: "unlisted", entry: candidate.current.head };
      } else {
        reviewedSide = { kind: "uncovered", reason: "change-set-too-large" };
      }
    }
    let currentSide = sideFrom(currentCoverage, candidate.bytes, candidate.current);
    if (!currentSide) {
      currentSide = candidate.diff
        ? { kind: "unlisted", entry: gitEntry(candidate.diff.dstMode, candidate.diff.dstOid) }
        : // A path the capture was asked to read but left out, past a cap on naming them.
          { kind: "uncovered", reason: currentCoverage.unnamed ?? "change-set-too-large" };
    }

    const { index, worktree } = compareSides(
      reviewedSide,
      currentSide,
      currentSide.kind === "unlisted" ? "matches" : (worktreeVsIndex.get(key) ?? null)
    );
    if (index === "unchanged" && worktree === "unchanged") continue;

    const only =
      bothHaveBase && reviewedSide.kind === "unlisted" && currentSide.kind === "unlisted";
    files.push({
      ...candidate.fields,
      status: fileStatus(reviewedSide, currentSide, index, worktree),
      index,
      worktree,
      baseUpdate: only
        ? "only"
        : baseChanged === null
          ? "unknown"
          : baseChanged.has(key)
            ? "also"
            : "none",
      reviewed: reviewedSide,
      current: currentSide,
    });
  }
  if (files.length > limits.maxPaths) reasons.add("path-limit");

  const commits = await listCommits(git, reviewed, current, present, limits);
  if (commits.kind === "unavailable" && commits.reason !== "reviewed-commit-missing") {
    reasons.add("commits-unavailable");
  }

  const compared = {
    comparedAt: current.capturedAt,
    head: current.head,
    base: { reviewed: baseSummary(reviewed), current: baseSummary(current) },
    files: files.slice(0, limits.maxPaths),
    commits,
  };
  if (reasons.size > 0) {
    const gaps: ReviewComparisonGap[] = [
      ...(reviewed.incomplete?.uncovered ?? []).map((gap) => toGap(gap, "reviewed")),
      ...(current.incomplete?.uncovered ?? []).map((gap) => toGap(gap, "current")),
    ];
    return {
      state: "incomplete",
      reasons: [...reasons].sort(),
      gaps: gaps.slice(0, limits.maxUncoveredListed),
      ...compared,
    };
  }
  if (commits.kind === "unavailable") return { state: "reviewed-commit-missing", ...compared };
  return { state: "comparable", ...compared };
}

/** A mark belongs to its branch; a detached HEAD only matches another. */
function sameBranch(reviewed: ReviewPointHead, current: ReviewPointHead): boolean {
  if (reviewed.kind === "detached" || current.kind === "detached") {
    return reviewed.kind === current.kind;
  }
  return reviewed.branch === current.branch;
}

/**
 * git never writes a backslash or a colon into a Windows path, and joined onto
 * the worktree either could reach outside it.
 */
function usableOnWindows(point: ReviewPoint): boolean {
  return [...point.entries, ...(point.incomplete?.uncovered ?? [])].every(
    (item) => !/[\\:]/.test(item.path)
  );
}

/** What one point can vouch for beyond the paths it lists. */
interface Coverage {
  /** Its listings may be wrong about anything, so nothing from it is used. */
  untrusted: boolean;
  /** Set when it may have left paths out without naming them, so unlisted proves nothing. */
  unnamed: ReviewPointIncompleteReason | null;
  gaps: GapIndex;
}

function coverage(point: ReviewPoint): Coverage {
  const { incomplete } = point;
  // A listing that failed outright leaves even listed entries' index and HEAD
  // sides resting on an assumption about the rest.
  const untrusted = incomplete?.reasons.includes("change-set-too-large") ?? false;
  let unnamed: ReviewPointIncompleteReason | null = null;
  if (untrusted) unnamed = "change-set-too-large";
  else if (incomplete && incomplete.uncoveredCount !== incomplete.uncovered.length) {
    unnamed = incomplete.reasons.includes("path-limit") ? "path-limit" : incomplete.reasons[0]!;
  }
  return { untrusted, unnamed, gaps: gapIndex(point) };
}

/** A side from what its point says directly, or null when it has to be derived. */
function sideFrom(
  coverage: Coverage,
  bytes: Uint8Array,
  entry: ReviewPointEntry | undefined
): ReviewComparisonSide | null {
  if (coverage.untrusted) return { kind: "uncovered", reason: "change-set-too-large" };
  if (entry) return listed(entry);
  const gap = gapFor(coverage.gaps, bytes);
  if (gap) return gap;
  if (coverage.unnamed) return { kind: "uncovered", reason: coverage.unnamed };
  return null;
}

async function existingCommits(git: Git, oids: ReadonlyArray<string | null>): Promise<Set<string>> {
  const wanted = [...new Set(oids.filter((oid): oid is string => oid !== null))];
  if (wanted.length === 0) return new Set();
  const out = await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: Buffer.from(wanted.map((oid) => `${oid}\n`).join("")),
  });
  const present = new Set<string>();
  for (const line of out.stdout.toString("utf8").split("\n")) {
    const [oid, type] = line.split(" ");
    if (type === "commit" && oid !== undefined && OID_LINE.test(oid)) present.add(oid);
  }
  return present;
}

/**
 * Paths the base update changed: the merge base then against the one now, or
 * nothing when the merge bases didn't move. Null when that can't be told: a
 * side without a base, a merge base gone, or more than one on either side,
 * where no single pair stands for the update.
 */
async function baseUpdatePaths(
  git: Git,
  reviewed: ReviewPoint,
  current: ReviewPoint,
  present: ReadonlySet<string>
): Promise<Set<string> | null> {
  if (reviewed.base.tip === null || current.base.tip === null) return null;
  const before = reviewed.base.mergeBases;
  const now = current.base.mergeBases;
  if (before.length === now.length && before.every((oid) => now.includes(oid))) {
    return new Set();
  }
  const [from] = before;
  const [to] = now;
  if (before.length !== 1 || now.length !== 1 || !from || !to || !present.has(from)) return null;
  try {
    const out = await git(["diff-tree", "-r", "-z", "--no-renames", from, to]);
    return new Set(
      parseDiffTreeRaw(out.stdout).map((record) => reviewPointPathKey(pathFieldsOf(record.path)))
    );
  } catch (error) {
    // Only the labels depend on it; the files are listed either way.
    if (error instanceof GitOutputLimitError || error instanceof GitCommandError) return null;
    throw error;
  }
}

// -- Commits ------------------------------------------------------------------

const COMMIT_FORMAT = "--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%at%x00%s";

async function listCommits(
  git: Git,
  reviewed: ReviewPoint,
  current: ReviewPoint,
  present: ReadonlySet<string>,
  limits: ReviewComparisonLimits
): Promise<ReviewComparisonCommits> {
  const from = reviewed.head.kind === "unborn" ? null : reviewed.head.commit;
  // Without the reviewed commit there is nothing to tell new commits from old
  // ones by, and calling that a rewrite would be a guess.
  if (from !== null && !present.has(from)) {
    return { kind: "unavailable", reason: "reviewed-commit-missing" };
  }
  const to = current.head.kind === "unborn" ? null : current.head.commit;
  if (to === null) {
    return {
      kind: "listed",
      history: from === null ? "extended" : "rewritten",
      commits: [],
      truncated: false,
    };
  }

  // With the base gone, history merged in from it can't be told from the
  // branch's own; the old base tip only accounts for what came before.
  if (current.base.tip === null && reviewed.base.tip !== null) {
    return { kind: "unavailable", reason: "base-unavailable" };
  }

  // The base's own history is left out on both sides: what the branch was
  // compared against then, and what it is compared against now. A reviewed
  // commit the base has since taken in is left out with it, so a rewrite of
  // that one is listed as new.
  const excluded = [current.base.tip, reviewed.base.tip]
    .filter((oid): oid is string => oid !== null && present.has(oid))
    .map((oid) => `^${oid}`);
  const range = from === null ? [to] : [`${from}...${to}`];
  try {
    // A shallow clone's walks stop at its boundary without failing: past it,
    // the reviewed commit stops looking like an ancestor, branch commits go
    // missing, and base history escapes its exclusion.
    const boundary = await shallowBoundary(current.commonDir);
    if (boundary === null || (await walkReachesBoundary(git, [...range, ...excluded], boundary))) {
      return { kind: "unavailable", reason: "unreadable" };
    }

    let history: "extended" | "rewritten" = "extended";
    if (from !== null && from !== to) {
      const out = await git(["merge-base", "--is-ancestor", from, to], { okExitCodes: [1] });
      if (out.exitCode !== 0) history = "rewritten";
    }
    const out = await git([
      "rev-list",
      "--topo-order",
      `--max-count=${limits.maxCommits + 1}`,
      COMMIT_FORMAT,
      ...(from === null ? [] : ["--right-only", "--cherry-mark"]),
      ...range,
      ...excluded,
    ]);
    const listed = parseCommitListing(out.stdout);
    // Patch ids skip merges, so a merge amended for its message alone is
    // matched here: the same tree on the same parents.
    if (history === "rewritten" && listed.some((item) => item.parents.length > 1)) {
      const left = await git([
        "rev-list",
        "--left-only",
        "--merges",
        COMMIT_FORMAT,
        ...range,
        ...excluded,
      ]);
      const reviewedMerges = new Set(parseCommitListing(left.stdout).map(mergeKey));
      for (const item of listed) {
        if (item.parents.length > 1 && reviewedMerges.has(mergeKey(item))) {
          item.kind = "patch-equivalent";
        }
      }
    }
    return {
      kind: "listed",
      history,
      commits: listed.slice(0, limits.maxCommits).map(({ tree: _tree, ...item }) => item),
      truncated: listed.length > limits.maxCommits,
    };
  } catch (error) {
    if (error instanceof GitOutputLimitError) return { kind: "unavailable", reason: "limit" };
    // History git can't walk, as in a shallow or partial clone; the files stand.
    if (error instanceof GitCommandError) return { kind: "unavailable", reason: "unreadable" };
    throw error;
  }
}

/** The commits a shallow clone's history stops at; null when that can't be read. */
async function shallowBoundary(commonDir: string): Promise<Set<string> | null> {
  try {
    const text = await fs.promises.readFile(path.join(commonDir, "shallow"), "utf8");
    return new Set(text.split("\n").filter((line) => OID_LINE.test(line)));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null;
  }
}

/**
 * Whether the walk touches a boundary commit, listed or as the edge of what it
 * excluded. One below everything it walks cuts nothing off.
 */
async function walkReachesBoundary(
  git: Git,
  revisions: readonly string[],
  boundary: ReadonlySet<string>
): Promise<boolean> {
  if (boundary.size === 0) return false;
  const out = await git(["rev-list", "--boundary", ...revisions]);
  return out.stdout
    .toString("utf8")
    .split("\n")
    .some((line) => boundary.has(line.replace(/^-/, "")));
}

function mergeKey(commit: { tree: string; parents: readonly string[] }): string {
  return `${commit.tree} ${commit.parents.join(" ")}`;
}

/**
 * `rev-list --format`: a `commit [=+]<oid>` line, then the formatted line. A
 * subject is one line however the message wraps, and none of the fields can
 * hold a NUL.
 */
export function parseCommitListing(
  output: Buffer
): Array<ReviewComparisonCommit & { tree: string }> {
  const lines = output.toString("utf8").split("\n");
  if (lines.pop() !== "") throw new Error("Truncated commit listing");
  if (lines.length % 2 !== 0) throw new Error("Malformed commit listing");
  const commits: Array<ReviewComparisonCommit & { tree: string }> = [];
  for (let i = 0; i < lines.length; i += 2) {
    const header = /^commit ([=+]?)([0-9a-f]+)$/.exec(lines[i] ?? "");
    const fields = (lines[i + 1] ?? "").split("\0");
    if (!header || fields.length !== 7) throw new Error("Malformed commit listing");
    const [oid, tree, parents, authorName, authorEmail, authoredAt, subject] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (oid !== header[2] || !OID_LINE.test(oid) || !OID_LINE.test(tree)) {
      throw new Error("Malformed commit listing");
    }
    commits.push({
      oid,
      tree,
      parents: parents === "" ? [] : parents.split(" "),
      subject,
      authorName,
      authorEmail,
      authoredAt: Number(authoredAt) * 1000,
      kind: header[1] === "=" ? "patch-equivalent" : "new",
    });
  }
  return commits;
}

// -- Paths --------------------------------------------------------------------

function pathBytesOf(fields: { path: string; pathBytes?: string }): Uint8Array {
  const bytes = reviewPointPathBytes(fields);
  // The schema refuses a point whose two fields disagree.
  if (!bytes) throw new Error("Unreadable review point path");
  return bytes;
}

// `ignoreBOM`: a name may start with U+FEFF, and that is part of the name.
const displayDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** The same spelling a capture gives a path: text when exact, bytes beside it when not. */
function pathFieldsOf(input: Uint8Array | { path: string; pathBytes?: string }): {
  path: string;
  pathBytes?: string;
} {
  if (!(input instanceof Uint8Array)) {
    return input.pathBytes === undefined
      ? { path: input.path }
      : { path: input.path, pathBytes: input.pathBytes };
  }
  const text = displayDecoder.decode(input);
  return Buffer.from(text, "utf8").equals(input)
    ? { path: text }
    : { path: text, pathBytes: Buffer.from(input).toString("base64") };
}

function isSubtree(gap: ReviewPointUncovered): boolean {
  return gap.path.endsWith("/");
}

interface GapIndex {
  exact: Map<string, ReviewPointUncovered>;
  subtrees: Array<{ prefix: Buffer; gap: ReviewPointUncovered }>;
}

function gapIndex(point: ReviewPoint): GapIndex {
  const index: GapIndex = { exact: new Map(), subtrees: [] };
  for (const gap of point.incomplete?.uncovered ?? []) {
    if (isSubtree(gap)) index.subtrees.push({ prefix: Buffer.from(pathBytesOf(gap)), gap });
    else index.exact.set(reviewPointPathKey(gap), gap);
  }
  return index;
}

function gapFor(index: GapIndex, bytes: Uint8Array): ReviewComparisonSide | null {
  const exact = index.exact.get(reviewPointPathKey(pathFieldsOf(bytes)));
  if (exact) return { kind: "uncovered", reason: exact.reason };
  const path = Buffer.from(bytes);
  for (const { prefix, gap } of index.subtrees) {
    if (path.length > prefix.length && path.subarray(0, prefix.length).equals(prefix)) {
      return { kind: "uncovered", reason: gap.reason };
    }
  }
  return null;
}

function toGap(gap: ReviewPointUncovered, side: "reviewed" | "current"): ReviewComparisonGap {
  return { ...pathFieldsOf(gap), side, reason: gap.reason };
}

function baseSummary(point: ReviewPoint) {
  return { ref: point.base.ref, tip: point.base.tip, mergeBases: point.base.mergeBases };
}

// -- Identities ---------------------------------------------------------------

function listed(entry: ReviewPointEntry): ReviewComparisonSide {
  return { kind: "listed", head: entry.head, index: entry.index, worktree: entry.worktree };
}

function gitEntry(mode: string, oid: string): ReviewPointGitEntry | null {
  if (/^0+$/.test(mode)) return null;
  if (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000") {
    throw new Error(`Unexpected git mode ${mode}`);
  }
  return { mode, oid };
}

/** The index a side held, and its working tree: raw, or "whatever the index holds". */
function normalize(side: Exclude<ReviewComparisonSide, { kind: "uncovered" }>): {
  index: ReviewPointIndexIdentity;
  worktree: ReviewPointWorktreeIdentity | "as-index";
} {
  if (side.kind === "listed") return { index: side.index, worktree: side.worktree };
  return {
    index: side.entry ? { kind: "entry", ...side.entry } : { kind: "absent" },
    worktree: "as-index",
  };
}

/**
 * @param currentVsIndex what status said about the current working tree
 *   against the current index, as git compares them; null when it didn't say.
 */
export function compareSides(
  reviewed: ReviewComparisonSide,
  current: ReviewComparisonSide,
  currentVsIndex: WorktreeVsIndex | null
): { index: ReviewComparisonChange; worktree: ReviewComparisonChange } {
  if (reviewed.kind === "uncovered" || current.kind === "uncovered") {
    return { index: "unknown", worktree: "unknown" };
  }
  const before = normalize(reviewed);
  const now = normalize(current);
  const sameIndex = isDeepStrictEqual(before.index, now.index);

  let worktree: ReviewComparisonChange;
  if (before.worktree !== "as-index" && now.worktree !== "as-index") {
    worktree = sameWorktree(before.worktree, now.worktree);
  } else if (before.worktree === "as-index" && now.worktree === "as-index") {
    worktree = sameIndex ? "unchanged" : "changed";
  } else if (before.worktree === "as-index") {
    // The reviewed file held what its index held, as git compares them; its
    // raw bytes were never read, so only git's comparison now can match it.
    worktree = againstEntry(now.worktree as ReviewPointWorktreeIdentity, before.index, () => {
      if (currentVsIndex === "matches") return sameIndex ? "unchanged" : "changed";
      if (currentVsIndex === "differs" && sameIndex) return "changed";
      return "unknown";
    });
  } else {
    worktree = againstEntry(before.worktree, now.index, () => "unknown");
  }

  let index: ReviewComparisonChange = "changed";
  if (sameIndex) index = "unchanged";
  // The index caught up with the reviewed working tree: the reviewed edit was
  // staged or committed as it was. Nothing in it is content not on screen then.
  else if (worktree === "unchanged" && currentVsIndex === "matches") index = "unchanged";
  else if (before.worktree !== "as-index" && holds(before.worktree, now.index, true)) {
    index = "unchanged";
  }
  return { index, worktree };
}

/**
 * A raw working-tree identity against an index entry it may or may not have
 * been checked out from: equal bytes, or something else on disk altogether,
 * settle it; otherwise `fallback` decides.
 */
function againstEntry(
  worktree: ReviewPointWorktreeIdentity,
  entry: ReviewPointIndexIdentity,
  fallback: () => ReviewComparisonChange
): ReviewComparisonChange {
  if (!covered(worktree)) return "unknown";
  if (holds(worktree, entry)) return "unchanged";
  if (worktreeKind(worktree) !== entryKind(entry)) return "changed";
  return fallback();
}

function worktreeKind(identity: ReviewPointWorktreeIdentity): string {
  if (identity.kind === "directory") return "absent";
  return identity.kind === "file" ? `file ${identity.mode}` : identity.kind;
}

function entryKind(index: ReviewPointIndexIdentity): string {
  if (index.kind === "absent") return "absent";
  if (index.kind !== "entry") return "other";
  if (index.mode === "160000") return "submodule";
  return index.mode === "120000" ? "symlink" : `file ${index.mode}`;
}

/** Whether a working-tree identity says anything definite about its contents. */
function covered(identity: ReviewPointWorktreeIdentity): boolean {
  if (identity.kind === "unverifiable") return false;
  return identity.kind !== "submodule" || identity.contents === "clean";
}

function sameWorktree(
  a: ReviewPointWorktreeIdentity,
  b: ReviewPointWorktreeIdentity
): ReviewComparisonChange {
  if (!covered(a) || !covered(b)) return "unknown";
  // A directory where a file was is no file at this path; its files are paths of their own.
  const kindOf = (identity: ReviewPointWorktreeIdentity) =>
    identity.kind === "directory" ? "absent" : identity.kind;
  if (kindOf(a) !== kindOf(b)) return "changed";
  if (a.kind === "file" && b.kind === "file") {
    return a.oid === b.oid && a.mode === b.mode ? "unchanged" : "changed";
  }
  if (a.kind === "symlink" && b.kind === "symlink") {
    return a.oid === b.oid ? "unchanged" : "changed";
  }
  if (a.kind === "submodule" && b.kind === "submodule") {
    return a.commit === b.commit ? "unchanged" : "changed";
  }
  return "unchanged";
}

/**
 * Whether a working-tree identity is what an index entry stores, byte for byte.
 * @param exact refuse an unpopulated submodule, which git counts as matching
 *   any commit but which proves nothing about which one was there.
 */
function holds(
  worktree: ReviewPointWorktreeIdentity,
  index: ReviewPointIndexIdentity,
  exact = false
): boolean {
  if (index.kind === "absent") return worktree.kind === "absent" || worktree.kind === "directory";
  if (index.kind !== "entry") return false;
  switch (index.mode) {
    case "160000":
      return (
        worktree.kind === "submodule" &&
        worktree.contents === "clean" &&
        (worktree.commit === index.oid || (!exact && worktree.commit === null))
      );
    case "120000":
      return worktree.kind === "symlink" && worktree.oid === index.oid;
    default:
      return worktree.kind === "file" && worktree.mode === index.mode && worktree.oid === index.oid;
  }
}

function fileStatus(
  reviewed: ReviewComparisonSide,
  current: ReviewComparisonSide,
  index: ReviewComparisonChange,
  worktree: ReviewComparisonChange
): ReviewComparisonFile["status"] {
  if (reviewed.kind === "uncovered" || current.kind === "uncovered") return "unknown";
  if (index !== "changed" && worktree !== "changed") return "unknown";
  const before = isPresent(reviewed);
  const now = isPresent(current);
  if (!before && now) return "added";
  if (before && !now) return "deleted";
  return "modified";
}

function isPresent(side: Exclude<ReviewComparisonSide, { kind: "uncovered" }>): boolean {
  if (side.kind === "unlisted") return side.entry !== null;
  const onDisk = side.worktree.kind !== "absent" && side.worktree.kind !== "directory";
  return onDisk || side.index.kind !== "absent";
}
