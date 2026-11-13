import { create } from "zustand";
import type { StagingStatus, WorktreeSnapshot } from "@shared/types";
import {
  FRESHNESS_MISSING,
  buildFreshnessIndex,
  comparablePath,
  findWorktreeByPath,
} from "@/lib/diffFreshness";
import { WORKING_TREE_VIEWED_SECTION } from "@/lib/diffViewedKey";
import { getViewedMarkSources, type ViewedMarkSources } from "./storeAccessors";

/**
 * Session-scoped "viewed" markers for changeset review, shared by the diff
 * workspace sidebar and the Review Hub file list so a file checked off in one
 * surface reads as reviewed in the other. Keys are caller-owned strings, scoped
 * per worktree path: every working-tree surface shares one
 * `working-tree:{path}` mark per file (`workingTreeViewedKey`), whichever
 * staging section the file sits in; base-branch review uses `base:{path}` and
 * Review Hub's Since review view `since-review:{path}`. Deliberately not
 * persisted: a fresh app session starts a fresh review.
 *
 * The key stays put across polls, so a mark remembers what Daintree had
 * observed of its file when it was set and lapses the first time a later
 * observation differs (#14581). That is only as fresh as the polling behind
 * it; it is a review aid, not a record of the content that was read.
 */

/**
 * One fingerprint per observation source, each absent while that source had
 * nothing to say. `file` is the worktree store's change entry, read so that
 * staging leaves it alone; `staging` is whether the Review Hub's last staging
 * read lists the file in either section; `base` is the commit on each side of
 * a base comparison.
 */
interface ViewedBaseline {
  file?: string;
  staging?: string;
  base?: string;
}

const SIGNALS = ["file", "staging", "base"] as const;

const STAGING_LISTED = "listed";

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_BASELINES: ReadonlyMap<string, ViewedBaseline> = new Map();

interface DiffViewedState {
  viewedByWorktree: Record<string, ReadonlySet<string>>;
  /** What each mark was set against, by worktree path then key. */
  baselinesByWorktree: Record<string, ReadonlyMap<string, ViewedBaseline>>;
  setViewed: (worktreePath: string, key: string, viewed: boolean) => void;
  toggleViewed: (worktreePath: string, key: string) => void;
  clearWorktree: (worktreePath: string) => void;
  /**
   * Drop every mark whose file has been observed to change since it was set.
   * Without a path, checks every worktree holding marks.
   */
  reconcileViewed: (worktreePath?: string) => void;
}

function splitKey(key: string): { section: string; path: string } | null {
  const colon = key.indexOf(":");
  if (colon <= 0) return null;
  return { section: key.slice(0, colon), path: key.slice(colon + 1) };
}

// Presence only: which section a file sits in, and how its churn splits
// between them, moves with every stage and unstage without touching what the
// mark covers. A content edit lapses the mark through `file` instead.
//
// Absence counts only against a mark that has seen the file listed. The
// staging read is a cache that can be older than the worktree poll, so a file
// marked from the change list may not be in it yet; recording that as the
// baseline would lapse the mark the moment the Review Hub caught up.
function stagingSignal(
  status: StagingStatus,
  path: string,
  baseline: ViewedBaseline | undefined
): string | undefined {
  const listed =
    status.staged.some((entry) => entry.path === path) ||
    status.unstaged.some((entry) => entry.path === path);
  if (listed) return STAGING_LISTED;
  return baseline?.staging === STAGING_LISTED ? FRESHNESS_MISSING : undefined;
}

function baseComparisonSignal(
  worktrees: ReadonlyMap<string, WorktreeSnapshot>,
  worktreePath: string
): string | undefined {
  const worktree = findWorktreeByPath(worktrees, worktreePath);
  let main: WorktreeSnapshot | undefined;
  for (const candidate of worktrees.values()) {
    if (candidate.isMainWorktree) {
      main = candidate;
      break;
    }
  }
  // Review Hub compares the two branches, and a worktree's HEAD is its branch
  // tip only while it is on one. A detached side would track the wrong commit,
  // so it says nothing rather than lapse marks on moves the comparison ignores.
  // `isDetached` too: a worktree that detaches mid-session keeps its old
  // `branch` on the snapshot.
  const head = worktree?.worktreeChanges?.headOid;
  const baseHead = main?.worktreeChanges?.headOid;
  if (!worktree?.branch || !main?.branch || !head || !baseHead) return undefined;
  if (worktree.isDetached || main.isDetached) return undefined;
  return `${main.branch}@${baseHead}..${worktree.branch}@${head}`;
}

function observe(
  sources: ViewedMarkSources,
  worktreePath: string,
  key: string,
  fileIndex: () => ReadonlyMap<string, string> | undefined,
  baseline?: ViewedBaseline
): ViewedBaseline {
  const parsed = splitKey(key);
  if (!parsed) return {};
  const observed: ViewedBaseline = {};
  if (parsed.section === "base") {
    // A dirty edit doesn't move a commit comparison, so the working-tree
    // signal stays out of it.
    if (sources.worktrees) observed.base = baseComparisonSignal(sources.worktrees, worktreePath);
    return observed;
  }
  const index = fileIndex();
  if (index) {
    observed.file = index.get(comparablePath(worktreePath, parsed.path)) ?? FRESHNESS_MISSING;
  }
  if (parsed.section === WORKING_TREE_VIEWED_SECTION && sources.stagingStatus) {
    const staging = stagingSignal(sources.stagingStatus, parsed.path, baseline);
    if (staging !== undefined) observed.staging = staging;
  }
  return observed;
}

function lazyFileIndex(
  sources: ViewedMarkSources,
  worktreePath: string
): () => ReadonlyMap<string, string> | undefined {
  let built = false;
  let index: ReadonlyMap<string, string> | undefined;
  return () => {
    if (!built) {
      built = true;
      index = sources.worktrees ? buildFreshnessIndex(sources.worktrees, worktreePath) : undefined;
    }
    return index;
  };
}

function observeForMark(worktreePath: string, key: string): ViewedBaseline {
  const sources = getViewedMarkSources(worktreePath);
  if (!sources) return {};
  return observe(sources, worktreePath, key, lazyFileIndex(sources, worktreePath));
}

function withMark(
  state: DiffViewedState,
  worktreePath: string,
  key: string,
  viewed: boolean
): Partial<DiffViewedState> {
  const nextSet = new Set(state.viewedByWorktree[worktreePath] ?? EMPTY_SET);
  const nextBaselines = new Map(state.baselinesByWorktree[worktreePath] ?? EMPTY_BASELINES);
  if (viewed) {
    nextSet.add(key);
    nextBaselines.set(key, observeForMark(worktreePath, key));
  } else {
    nextSet.delete(key);
    nextBaselines.delete(key);
  }
  return {
    viewedByWorktree: { ...state.viewedByWorktree, [worktreePath]: nextSet },
    baselinesByWorktree: { ...state.baselinesByWorktree, [worktreePath]: nextBaselines },
  };
}

export const useDiffViewedStore = create<DiffViewedState>((set) => ({
  viewedByWorktree: {},
  baselinesByWorktree: {},
  setViewed: (worktreePath, key, viewed) =>
    set((state) => {
      const current = state.viewedByWorktree[worktreePath] ?? EMPTY_SET;
      if (current.has(key) === viewed) return state;
      return withMark(state, worktreePath, key, viewed);
    }),
  toggleViewed: (worktreePath, key) =>
    set((state) => {
      const current = state.viewedByWorktree[worktreePath] ?? EMPTY_SET;
      return withMark(state, worktreePath, key, !current.has(key));
    }),
  // Called on commit success (Review Hub) — a commit starts a new review, so
  // stale markers must not stick to files that change again afterwards — and
  // when a worktree is deleted, so its markers don't outlive it.
  clearWorktree: (worktreePath) =>
    set((state) => {
      if (!(worktreePath in state.viewedByWorktree)) return state;
      const { [worktreePath]: _removed, ...rest } = state.viewedByWorktree;
      const { [worktreePath]: _removedBaselines, ...restBaselines } = state.baselinesByWorktree;
      return { viewedByWorktree: rest, baselinesByWorktree: restBaselines };
    }),
  reconcileViewed: (worktreePath) =>
    set((state) => {
      const paths =
        worktreePath === undefined
          ? Object.keys(state.viewedByWorktree)
          : worktreePath in state.viewedByWorktree
            ? [worktreePath]
            : [];
      let viewedByWorktree = state.viewedByWorktree;
      let baselinesByWorktree = state.baselinesByWorktree;
      for (const path of paths) {
        const marks = state.viewedByWorktree[path];
        if (!marks || marks.size === 0) continue;
        const sources = getViewedMarkSources(path);
        if (!sources) continue;
        const fileIndex = lazyFileIndex(sources, path);
        const baselines = state.baselinesByWorktree[path] ?? EMPTY_BASELINES;
        let nextMarks: Set<string> | null = null;
        let nextBaselines: Map<string, ViewedBaseline> | null = null;
        for (const key of marks) {
          const baseline = baselines.get(key) ?? {};
          const observed = observe(sources, path, key, fileIndex, baseline);
          let lapsed = false;
          let adopted: ViewedBaseline | null = null;
          for (const signal of SIGNALS) {
            const now = observed[signal];
            // A source with nothing to say neither lapses the mark nor moves
            // its baseline, so a gap compares the far side against the mark.
            if (now === undefined) continue;
            const then = baseline[signal];
            if (then === undefined) {
              adopted = { ...(adopted ?? baseline), [signal]: now };
            } else if (then !== now) {
              lapsed = true;
              break;
            }
          }
          if (lapsed) {
            nextMarks ??= new Set(marks);
            nextMarks.delete(key);
            nextBaselines ??= new Map(baselines);
            nextBaselines.delete(key);
          } else if (adopted) {
            nextBaselines ??= new Map(baselines);
            nextBaselines.set(key, adopted);
          }
        }
        if (nextMarks) viewedByWorktree = { ...viewedByWorktree, [path]: nextMarks };
        if (nextBaselines) baselinesByWorktree = { ...baselinesByWorktree, [path]: nextBaselines };
      }
      if (
        viewedByWorktree === state.viewedByWorktree &&
        baselinesByWorktree === state.baselinesByWorktree
      ) {
        return state;
      }
      return { viewedByWorktree, baselinesByWorktree };
    }),
}));

/** Stable empty-set selector helper so components don't allocate per render. */
export function selectViewedSet(state: DiffViewedState, worktreePath: string): ReadonlySet<string> {
  return state.viewedByWorktree[worktreePath] ?? EMPTY_SET;
}
