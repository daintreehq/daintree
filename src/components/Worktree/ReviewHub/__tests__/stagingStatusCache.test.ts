// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StagingStatus } from "@shared/types";
import {
  beginStagingStatusRead,
  getCachedStagingStatus,
  prefetchStagingStatus,
  rememberStagingStatus,
  resetStagingStatusCacheForTests,
} from "../stagingStatusCache";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import { workingTreeViewedKey } from "@/lib/diffViewedKey";
import {
  resetStoreAccessorsForTesting,
  setViewedMarkSourcesAccessor,
} from "@/store/storeAccessors";

const statusNamed = (branch: string): StagingStatus =>
  ({ currentBranch: branch, staged: [], unstaged: [] }) as unknown as StagingStatus;

describe("stagingStatusCache", () => {
  const getStagingStatus = vi.fn();

  beforeEach(() => {
    getStagingStatus.mockReset();
    (window as unknown as { electron: unknown }).electron = { git: { getStagingStatus } };
  });

  afterEach(() => {
    resetStagingStatusCacheForTests();
    resetStoreAccessorsForTesting();
    useDiffViewedStore.setState({ viewedByWorktree: {}, baselinesByWorktree: {} });
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("lapses Viewed marks on an accepted read, never on one a newer read already beat", () => {
    setViewedMarkSourcesAccessor((worktreePath) => ({
      worktrees: null,
      stagingStatus: getCachedStagingStatus(worktreePath),
    }));
    const listing = (...paths: string[]): StagingStatus =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the sections the rule reads
      ({
        staged: paths.map((path) => ({ path, status: "modified", insertions: 1, deletions: 0 })),
        unstaged: [],
      }) as unknown as StagingStatus;
    const viewed = () =>
      selectViewedSet(useDiffViewedStore.getState(), "/wt").has(workingTreeViewedKey("a.ts"));

    const older = beginStagingStatusRead();
    rememberStagingStatus("/wt", listing("a.ts"), beginStagingStatusRead());
    useDiffViewedStore.getState().setViewed("/wt", workingTreeViewedKey("a.ts"), true);

    // The file left both sections, but an older read says so.
    rememberStagingStatus("/wt", listing(), older);
    expect(viewed()).toBe(true);

    rememberStagingStatus("/wt", listing(), beginStagingStatusRead());
    expect(viewed()).toBe(false);
  });

  it("keeps the newer read when an older one lands after it", () => {
    const older = beginStagingStatusRead();
    const newer = beginStagingStatusRead();

    rememberStagingStatus("/wt", statusNamed("newer"), newer);
    rememberStagingStatus("/wt", statusNamed("older"), older);

    expect(getCachedStagingStatus("/wt")?.currentBranch).toBe("newer");
  });

  it("does not let a slow hover prefetch overwrite the hub's fresher read", async () => {
    let resolvePrefetch!: (s: StagingStatus) => void;
    getStagingStatus.mockReturnValueOnce(new Promise((r) => (resolvePrefetch = r)));
    const prefetch = prefetchStagingStatus("/wt");

    // The hub opens and its own read, which started later, lands first.
    rememberStagingStatus("/wt", statusNamed("hub"), beginStagingStatusRead());
    resolvePrefetch(statusNamed("prefetch"));
    await prefetch;

    expect(getCachedStagingStatus("/wt")?.currentBranch).toBe("hub");
  });

  it("dedupes concurrent prefetches of one worktree", async () => {
    getStagingStatus.mockResolvedValue(statusNamed("main"));

    const [a, b] = [prefetchStagingStatus("/wt"), prefetchStagingStatus("/wt")];
    await Promise.all([a, b]);

    expect(getStagingStatus).toHaveBeenCalledTimes(1);
    expect(getCachedStagingStatus("/wt")?.currentBranch).toBe("main");
  });

  it("ignores a prefetch that was still in flight when the cache was reset", async () => {
    let resolvePrefetch!: (s: StagingStatus) => void;
    getStagingStatus.mockReturnValueOnce(new Promise((r) => (resolvePrefetch = r)));
    const prefetch = prefetchStagingStatus("/wt");

    resetStagingStatusCacheForTests();
    resolvePrefetch(statusNamed("stale"));
    await prefetch;

    expect(getCachedStagingStatus("/wt")).toBeNull();
  });
});
