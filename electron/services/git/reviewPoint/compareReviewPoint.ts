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
} from "./captureReviewPoint.js";
import { parseDiffTreeRaw, type TreeDiffRecord } from "./parseGitRecords.js";
import {
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
        reason === "deadline"
          ? "The comparison ran out of time."
          : "The comparison was cancelled."
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
  const reviewedGaps = gapIndex(reviewed);
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
  const { point: current, worktreeMatchesIndex } = captured.capture;
  if (current.objectFormat !== reviewed.objectFormat) {
    return failed("invalid-review-point", "The review point is from another kind of repository.");
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
  const reviewedMergeBase = reviewed.base.mergeBases.find((oid) => present.has(oid)) ?? null;

  // What the reviewed point's unlisted paths held: its HEAD commit, or any
  // merge base, which its change set made identical to HEAD outside the set.
  let reviewedTree: string | null = null;
  if (reviewedCommit === null) reviewedTree = emptyTree;
  else if (present.has(reviewedCommit)) reviewedTree = reviewedCommit;
  else if (reviewedMergeBase) reviewedTree = reviewedMergeBase;
  // A base with no common ancestor put every path in HEAD in the change set.
  else if (reviewed.base.tip !== null && reviewed.base.mergeBases.length === 0) {
    reviewedTree = emptyTree;
  }
  const currentTree = currentCommit ?? emptyTree;

  const reasons = new Set<ReviewComparisonIncompleteReason>();
  if (reviewedTree === null) reasons.add("reviewed-state-unavailable");
  const reviewedListed = listsWholeChangeSet(reviewed);
  const currentListed = listsWholeChangeSet(current);
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
      if (!(error instanceof GitOutputLimitError)) throw error;
      treesDiffed = false;
      reasons.add("change-set-too-large");
    }
  }

  const baseChanged = await baseUpdatePaths(git, reviewedMergeBase, current.base.mergeBases);
  const bothHaveBase = reviewed.base.tip !== null && current.base.tip !== null;
  const currentGaps = gapIndex(current);

  const files: ReviewComparisonFile[] = [];
  const ordered = [...candidates.entries()].sort(([, a], [, b]) =>
    Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))
  );
  for (const [key, candidate] of ordered) {
    const reviewedSide: ReviewComparisonSide = candidate.reviewed
      ? listed(candidate.reviewed)
      : (gapFor(reviewedGaps, candidate.bytes) ??
        (!reviewedListed
          ? { kind: "uncovered", reason: "change-set-too-large" }
          : reviewedTree === null
            ? { kind: "uncovered", reason: "reviewed-state-unavailable" }
            : candidate.diff
              ? { kind: "unlisted", entry: gitEntry(candidate.diff.srcMode, candidate.diff.srcOid) }
              : treesDiffed && candidate.current
                ? // Not in the tree diff, so the reviewed tree had what HEAD has now.
                  { kind: "unlisted", entry: candidate.current.head }
                : { kind: "uncovered", reason: unnamedGap(reviewed) }));
    const currentSide: ReviewComparisonSide = candidate.current
      ? listed(candidate.current)
      : (gapFor(currentGaps, candidate.bytes) ??
        (!currentListed
          ? { kind: "uncovered", reason: "change-set-too-large" }
          : candidate.diff
            ? { kind: "unlisted", entry: gitEntry(candidate.diff.dstMode, candidate.diff.dstOid) }
            : // A path the capture was asked to read but left out, past a cap on naming them.
              { kind: "uncovered", reason: unnamedGap(current) }));

    const { index, worktree } = compareSides(
      reviewedSide,
      currentSide,
      currentSide.kind === "unlisted" || worktreeMatchesIndex.has(key)
    );
    if (index === "unchanged" && worktree === "unchanged") continue;

    const only = bothHaveBase && reviewedSide.kind === "unlisted" && currentSide.kind === "unlisted";
    files.push({
      ...candidate.fields,
      status: fileStatus(reviewedSide, currentSide, index, worktree),
      index,
      worktree,
      baseUpdate: only ? "only" : baseChanged?.has(key) ? "also" : null,
      reviewed: reviewedSide,
      current: currentSide,
    });
  }
  if (files.length > limits.maxPaths) reasons.add("path-limit");

  const commits = await listCommits(git, reviewed, current, present, limits);
  if (commits.kind === "unavailable" && commits.reason === "limit") {
    reasons.add("change-set-too-large");
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

/** Whether an unlisted path is known to match HEAD: the listing itself was whole. */
function listsWholeChangeSet(point: ReviewPoint): boolean {
  return !point.incomplete?.reasons.includes("change-set-too-large");
}

async function existingCommits(
  git: Git,
  oids: ReadonlyArray<string | null>
): Promise<Set<string>> {
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

/** Paths the base update changed: a merge base then against one now. Null when unknown. */
async function baseUpdatePaths(
  git: Git,
  from: string | null,
  now: readonly string[]
): Promise<Set<string> | null> {
  const to = now[0];
  if (from === null || to === undefined) return null;
  if (now.includes(from)) return new Set();
  try {
    const out = await git(["diff-tree", "-r", "-z", "--no-renames", from, to]);
    return new Set(
      parseDiffTreeRaw(out.stdout).map((record) => reviewPointPathKey(pathFieldsOf(record.path)))
    );
  } catch (error) {
    // Only the labels depend on it; the files are listed either way.
    if (error instanceof GitOutputLimitError) return null;
    throw error;
  }
}

// -- Commits ------------------------------------------------------------------

const COMMIT_FORMAT = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s";

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

  let history: "extended" | "rewritten" = "extended";
  if (from !== null && from !== to) {
    const out = await git(["merge-base", "--is-ancestor", from, to], { okExitCodes: [1] });
    if (out.exitCode !== 0) history = "rewritten";
  }

  // The base's own history is left out on both sides: what the branch was
  // compared against then, and what it is compared against now.
  const excluded = [current.base.tip, reviewed.base.tip]
    .filter((oid): oid is string => oid !== null && present.has(oid))
    .map((oid) => `^${oid}`);
  const range =
    from === null ? [to] : ["--right-only", "--cherry-mark", `${from}...${to}`];
  let out: RunGitResult;
  try {
    out = await git([
      "rev-list",
      "--topo-order",
      `--max-count=${limits.maxCommits + 1}`,
      COMMIT_FORMAT,
      ...range,
      ...excluded,
    ]);
  } catch (error) {
    if (error instanceof GitOutputLimitError) return { kind: "unavailable", reason: "limit" };
    throw error;
  }
  const commits = parseCommitListing(out.stdout);
  return {
    kind: "listed",
    history,
    commits: commits.slice(0, limits.maxCommits),
    truncated: commits.length > limits.maxCommits,
  };
}

/**
 * `rev-list --format`: a `commit [=+]<oid>` line, then the formatted line. A
 * subject is one line however the message wraps, and none of the fields can
 * hold a NUL.
 */
export function parseCommitListing(output: Buffer): ReviewComparisonCommit[] {
  const lines = output.toString("utf8").split("\n");
  const commits: ReviewComparisonCommit[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const header = /^commit ([=+]?)([0-9a-f]+)$/.exec(lines[i] ?? "");
    const fields = (lines[i + 1] ?? "").split("\0");
    if (!header || fields.length !== 6) throw new Error("Malformed commit listing");
    const [oid, parents, authorName, authorEmail, authoredAt, subject] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (oid !== header[2] || !OID_LINE.test(oid)) throw new Error("Malformed commit listing");
    commits.push({
      oid,
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

/** Why a point has a path it neither lists nor names as uncovered. */
function unnamedGap(point: ReviewPoint): ReviewPointIncompleteReason {
  return point.incomplete?.reasons.includes("path-limit") ? "path-limit" : "change-set-too-large";
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
 * @param currentMatchesIndex whether status found the current working tree
 *   equal to the current index, as git compares them.
 */
export function compareSides(
  reviewed: ReviewComparisonSide,
  current: ReviewComparisonSide,
  currentMatchesIndex: boolean
): { index: ReviewComparisonChange; worktree: ReviewComparisonChange } {
  if (reviewed.kind === "uncovered" || current.kind === "uncovered") {
    return { index: "unknown", worktree: "unknown" };
  }
  const before = normalize(reviewed);
  const now = normalize(current);

  let worktree: ReviewComparisonChange;
  if (before.worktree !== "as-index" && now.worktree !== "as-index") {
    worktree = sameWorktree(before.worktree, now.worktree);
  } else if (before.worktree === "as-index" && now.worktree === "as-index") {
    worktree = isDeepStrictEqual(before.index, now.index) ? "unchanged" : "changed";
  } else if (now.worktree !== "as-index") {
    // The reviewed file was whatever its index held, as git compares them.
    if (!covered(now.worktree)) worktree = "unknown";
    else if (currentMatchesIndex && isDeepStrictEqual(now.index, before.index)) {
      worktree = "unchanged";
    } else worktree = holds(now.worktree, before.index) ? "unchanged" : "changed";
  } else {
    const reviewedTree = before.worktree as ReviewPointWorktreeIdentity;
    if (!covered(reviewedTree)) worktree = "unknown";
    else worktree = holds(reviewedTree, now.index) ? "unchanged" : "changed";
  }

  let index: ReviewComparisonChange = "changed";
  if (isDeepStrictEqual(before.index, now.index)) index = "unchanged";
  // The index caught up with the reviewed working tree: the reviewed edit was
  // staged or committed as it was. Nothing in it is content not on screen then.
  else if (worktree === "unchanged" && currentMatchesIndex) index = "unchanged";
  else if (before.worktree !== "as-index" && holds(before.worktree, now.index)) {
    index = "unchanged";
  }
  return { index, worktree };
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

/** Whether a working-tree identity is exactly what an index entry stores, byte for byte. */
function holds(worktree: ReviewPointWorktreeIdentity, index: ReviewPointIndexIdentity): boolean {
  if (index.kind === "absent") return worktree.kind === "absent" || worktree.kind === "directory";
  if (index.kind !== "entry") return false;
  switch (index.mode) {
    case "160000":
      // An unpopulated submodule is unchanged as far as git is concerned.
      return (
        worktree.kind === "submodule" &&
        worktree.contents === "clean" &&
        (worktree.commit === null || worktree.commit === index.oid)
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
  if (index === "unknown" || worktree === "unknown") return "unknown";
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
