import type { GitStatus } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { GIT_FILE_DIFF_MAX_BYTES } from "@shared/config/gitReadLimits";
import type {
  ReviewFileSinceSide,
  ReviewMarkFileSinceOutcome,
} from "@shared/types/ipc/reviewMarks";

/**
 * Session-scoped LRU so stepping back and forth through a change set doesn't
 * re-pay git spawn + IPC + parse for files already viewed (and doesn't burn the
 * shared gitOps rate-limit budget).
 *
 * Unlike the modal this replaced, the cache is *not* cleared when one surface
 * closes: several diff panels can now be open at once, so one panel closing
 * must not evict entries another is still stepping through. Staleness is
 * covered by the freshness key instead, which is the signal that actually
 * tracks whether a file changed.
 */
const DIFF_CACHE_MAX = 20;

export interface CachedDiff {
  content: string;
  /**
   * Freshness key at fetch initiation, undefined when the worktree store had
   * no signal for the file. Stored with the entry so a prefetched diff whose
   * file changed before the user navigated to it still reads as stale.
   */
  freshnessKey: string | undefined;
  /** What the host said about a since-review file; `content` is derived from it. */
  sinceReview?: ReviewMarkFileSinceOutcome;
}

const diffCache = new Map<string, CachedDiff>();
const inflightDiffRequests = new Map<string, Promise<CachedDiff | null>>();
let diffCacheGeneration = 0;

/** Identifies what to diff — the two fetch paths differ past this point. */
export type DiffSubject =
  | {
      source: "working-tree" | "staged" | "unstaged";
      worktreePath: string;
      filePath: string;
      status: GitStatus;
    }
  | {
      source: "base-branch";
      worktreePath: string;
      filePath: string;
      baseBranch: string;
      currentBranch: string;
    }
  | {
      source: "since-review";
      worktreePath: string;
      worktreeId: string;
      filePath: string;
      /** Absent: the host picks the side that changed. */
      side: ReviewFileSinceSide | undefined;
      /** The mark's revision when asked, so a replaced mark is a new request. */
      markRevision: number | undefined;
    };

export function _resetDiffCacheForTests(): void {
  diffCache.clear();
  inflightDiffRequests.clear();
  diffCacheGeneration++;
}

export function diffCacheKey(subject: DiffSubject, ignoreWhitespace: boolean): string {
  const tail =
    subject.source === "base-branch"
      ? `${subject.baseBranch}\u0000${subject.currentBranch}`
      : subject.source === "since-review"
        ? `${subject.worktreeId}\u0000${subject.side ?? ""}\u0000${subject.markRevision ?? ""}`
        : subject.status;
  return [
    subject.source,
    subject.worktreePath,
    subject.filePath,
    tail,
    String(ignoreWhitespace),
  ].join("\u0000");
}

/**
 * Drop every entry built under an ignore-whitespace flag nothing can ask for
 * any more. Takes the set of live flags rather than a single one: the rendered
 * Markdown layout requests exact patches regardless of the preference, so both
 * variants can be legitimately in use at once (#12171).
 */
export function purgeWhitespaceEntriesExcept(live: readonly boolean[]): void {
  const suffixes = live.map((flag) => `\u0000${flag}`);
  for (const key of [...diffCache.keys()]) {
    if (!suffixes.some((suffix) => key.endsWith(suffix))) diffCache.delete(key);
  }
}

/**
 * The text a since-review outcome puts where a patch goes: the exact patch, or
 * the stand-in against the reviewed commit (the pane labels it), else a
 * sentinel. A view with nothing to show says so in the pane's notice.
 */
export function sinceReviewContent(outcome: ReviewMarkFileSinceOutcome): string {
  if (outcome.status !== "read") return "NO_CHANGES";
  const { view } = outcome;
  switch (view.kind) {
    case "exact":
      return view.patch || "NO_CHANGES";
    case "unavailable":
      return view.standIn?.patch || "NO_CHANGES";
    case "binary":
      return "BINARY_FILE";
    case "too-large":
      return "FILE_TOO_LARGE";
    default:
      return "NO_CHANGES";
  }
}

async function fetchDiffContent(
  subject: DiffSubject,
  ignoreWhitespace: boolean
): Promise<{ content: string; sinceReview?: ReviewMarkFileSinceOutcome } | null> {
  if (subject.source === "since-review") {
    const outcome = await window.electron.reviewMarks.fileSince(subject.worktreeId, {
      path: subject.filePath,
      ...(subject.side && { side: subject.side }),
    });
    return { content: sinceReviewContent(outcome), sinceReview: outcome };
  }
  if (subject.source === "base-branch") {
    const result = await window.electron.git.compareWorktrees(
      subject.worktreePath,
      subject.baseBranch,
      subject.currentBranch,
      subject.filePath,
      true,
      ignoreWhitespace
    );
    return typeof result === "string" ? { content: result || "NO_CHANGES" } : null;
  }

  // The panes render a whole diff, so they ask for the full transport ceiling
  // rather than the agent-facing default window. A diff that still overflows it
  // maps back onto the FILE_TOO_LARGE sentinel the panes already handle, so the
  // windowing added in #11531 leaves their contract unchanged.
  const result = await actionService.dispatch<{ content: string; truncated: boolean }>(
    "git.getFileDiff",
    {
      cwd: subject.worktreePath,
      filePath: subject.filePath,
      status: subject.status,
      ignoreWhitespace,
      maxBytes: GIT_FILE_DIFF_MAX_BYTES,
      // "working-tree" names no side: it keeps HEAD against the working tree.
      ...(subject.source !== "working-tree" && { side: subject.source }),
    },
    { source: "user" }
  );
  if (!result.ok) return null;
  if (result.result.truncated) return { content: "FILE_TOO_LARGE" };
  return { content: result.result.content || "NO_CHANGES" };
}

/**
 * Single fetch path shared by the foreground load and the next-file prefetch:
 * cache hits resolve without dispatching and in-flight requests are deduped so
 * the two never double-spend the shared gitOps rate-limit budget. The
 * generation guard keeps a request resolving after a test reset from seeding
 * the next session with a stale entry.
 */
export function requestDiff(
  subject: DiffSubject,
  ignoreWhitespace: boolean,
  bypassCache = false,
  freshnessKey?: string
): Promise<CachedDiff | null> {
  const key = diffCacheKey(subject, ignoreWhitespace);
  // A base-branch key is `baseBranch + currentBranch` — branch NAMES, which are
  // not content identity: `main` advancing produces the same key for different
  // content, and the freshness signal can't catch it either (it reads
  // working-tree file metadata, which is "missing" for a clean worktree). So a
  // reopen would serve the old diff with no stale banner. The modal this
  // replaced cached nothing here; keep it that way until we can key on commit
  // ids. In-flight dedup still applies — that window is one request's lifetime.
  // A since-review diff is uncacheable for the same reason: its mark can be
  // replaced or cleared under an unchanged key.
  const cacheable = subject.source !== "base-branch" && subject.source !== "since-review";
  if (!bypassCache) {
    if (cacheable) {
      const cached = diffCache.get(key);
      // Reinsert on hit so eviction is genuinely least-recently-USED: a Map
      // drops in insertion order, which without this is plain FIFO.
      if (cached !== undefined) {
        cacheDiff(key, cached);
        return Promise.resolve(cached);
      }
    }
    const inflight = inflightDiffRequests.get(key);
    if (inflight) return inflight;
  }
  const generation = diffCacheGeneration;
  const request = fetchDiffContent(subject, ignoreWhitespace)
    .then((fetched) => {
      if (fetched === null) return null;
      const entry: CachedDiff = { content: fetched.content, freshnessKey };
      if (fetched.sinceReview) entry.sinceReview = fetched.sinceReview;
      if (cacheable && generation === diffCacheGeneration) cacheDiff(key, entry);
      return entry;
    })
    .finally(() => {
      if (inflightDiffRequests.get(key) === request) inflightDiffRequests.delete(key);
    });
  inflightDiffRequests.set(key, request);
  return request;
}

function cacheDiff(key: string, value: CachedDiff): void {
  diffCache.delete(key);
  diffCache.set(key, value);
  if (diffCache.size > DIFF_CACHE_MAX) {
    const oldest = diffCache.keys().next().value;
    if (oldest !== undefined) diffCache.delete(oldest);
  }
}

export function peekCachedDiff(
  subject: DiffSubject,
  ignoreWhitespace: boolean
): CachedDiff | undefined {
  return diffCache.get(diffCacheKey(subject, ignoreWhitespace));
}
