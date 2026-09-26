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
    delete (window as unknown as { electron?: unknown }).electron;
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
