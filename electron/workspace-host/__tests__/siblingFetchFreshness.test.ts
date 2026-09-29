import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetGitCommonDir = vi.fn();
const mockRaw = vi.fn();
const fetchPaths: string[] = [];

vi.mock("../../utils/gitUtils.js", () => ({
  getGitCommonDir: (...args: unknown[]) => mockGetGitCommonDir(...args),
  getGitDir: vi.fn().mockReturnValue(null),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../utils/hardenedGit.js", () => ({
  createBackgroundFetchGit: (worktreePath: string) => ({
    raw: (...args: unknown[]) => {
      fetchPaths.push(worktreePath);
      return mockRaw(...args);
    },
  }),
}));

import { RepoFetchCoordinator, type FetchOptions } from "../RepoFetchCoordinator.js";
import { FetchScheduler, type FetchSchedulerHost } from "../FetchScheduler.js";
import type { WorkspaceFetchResult } from "../../../shared/types/workspace-host.js";

const COMMON_DIR = "/repo/.git";

function fetchedRemotes(): string[] {
  return mockRaw.mock.calls.map((call) => (call[0] as string[])[1]!);
}

function opts(overrides: Partial<FetchOptions> = {}): FetchOptions {
  return { worktreeId: "wt", worktreePath: "/repo/wt", ...overrides };
}

describe("RepoFetchCoordinator — caller freshness window", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    mockGetGitCommonDir.mockReset().mockReturnValue(COMMON_DIR);
    mockRaw.mockReset().mockResolvedValue("");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses a sibling's success older than the default window but inside maxAgeMs", async () => {
    const coord = new RepoFetchCoordinator();
    const first = await coord.fetchForWorktree(opts({ worktreeId: "a" }));
    vi.advanceTimersByTime(60_000);

    const second = await coord.fetchForWorktree(opts({ worktreeId: "b", maxAgeMs: 120_000 }));

    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("success");
    expect(second.lastFetchedAt).toBe(first.lastFetchedAt);
    expect(second.freshSince).toBe(first.lastFetchedAt);
  });

  it("fetches without maxAgeMs once the default window has passed", async () => {
    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree(opts({ worktreeId: "a" }));
    vi.advanceTimersByTime(60_000);

    await coord.fetchForWorktree(opts({ worktreeId: "b" }));

    expect(mockRaw).toHaveBeenCalledTimes(2);
  });

  it("fetches once the success is older than maxAgeMs", async () => {
    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree(opts({ worktreeId: "a" }));
    vi.advanceTimersByTime(120_000);

    const result = await coord.fetchForWorktree(opts({ worktreeId: "b", maxAgeMs: 120_000 }));

    expect(mockRaw).toHaveBeenCalledTimes(2);
    expect(result.freshSince).toBe(Date.now());
  });

  it("never narrows the default window", async () => {
    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree(opts({ worktreeId: "a" }));
    vi.advanceTimersByTime(10_000);

    await coord.fetchForWorktree(opts({ worktreeId: "b", maxAgeMs: 1_000 }));

    expect(mockRaw).toHaveBeenCalledTimes(1);
  });

  it("ignores maxAgeMs on a forced fetch", async () => {
    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree(opts({ worktreeId: "a" }));
    vi.advanceTimersByTime(30_000);

    await coord.fetchForWorktree(opts({ worktreeId: "b", force: true, maxAgeMs: 10 * 60_000 }));

    expect(mockRaw).toHaveBeenCalledTimes(2);
  });

  it("does not treat a success followed by a failure as fresh", async () => {
    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree(opts({ worktreeId: "a" }));
    vi.advanceTimersByTime(20_000);
    mockRaw.mockRejectedValueOnce(new Error("could not read from remote repository"));
    const failed = await coord.fetchForWorktree(opts({ worktreeId: "a", force: true }));
    expect(failed.status).toBe("failed");
    expect(failed.freshSince).toBeUndefined();

    // Past the failure backoff, but the earlier success is still inside the
    // caller's window: the failure must win and a real fetch must run.
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    const retried = await coord.fetchForWorktree(opts({ worktreeId: "b", maxAgeMs: 10 * 60_000 }));

    expect(mockRaw).toHaveBeenCalledTimes(3);
    expect(retried.status).toBe("success");
  });

  it("keeps remotes independent — a fresh origin does not cover an upstream-based sibling", async () => {
    const coord = new RepoFetchCoordinator();
    const originFetch = await coord.fetchForWorktree(
      opts({ worktreeId: "a", remotes: ["origin"] })
    );
    vi.advanceTimersByTime(60_000);

    const result = await coord.fetchForWorktree(
      opts({
        worktreeId: "b",
        remotes: ["upstream", "origin"],
        primaryRemote: "upstream",
        maxAgeMs: 120_000,
      })
    );

    expect(fetchedRemotes()).toEqual(["origin", "upstream"]);
    expect(result.remote).toBe("upstream");
    expect(result.lastFetchedAt).toBe(Date.now());
    // Anchored to the older of the two so origin is not left a full extra
    // interval behind.
    expect(result.freshSince).toBe(originFetch.lastFetchedAt);
  });

  it("anchors freshSince on the healthy remotes when an auxiliary remote failed", async () => {
    const coord = new RepoFetchCoordinator();
    mockRaw.mockImplementation((args: string[]) =>
      args[1] === "upstream"
        ? Promise.reject(new Error("could not read from remote repository"))
        : Promise.resolve("")
    );

    const result = await coord.fetchForWorktree(
      opts({ remotes: ["origin", "upstream"], maxAgeMs: 120_000 })
    );

    expect(result.status).toBe("success");
    expect(result.auxiliaryFailed).toBe(true);
    expect(result.freshSince).toBe(result.lastFetchedAt);
  });

  it("carries no freshSince when no planned remote succeeded", async () => {
    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree(opts({ worktreeId: "a" }));
    vi.advanceTimersByTime(20_000);
    mockRaw.mockRejectedValue(new Error("could not read from remote repository"));

    const failed = await coord.fetchForWorktree(opts({ worktreeId: "a", force: true }));
    // Inside the backoff window, with the pre-failure success still well
    // inside the caller's window: a skip, never a reuse.
    const skipped = await coord.fetchForWorktree(opts({ worktreeId: "b", maxAgeMs: 10 * 60_000 }));

    expect(failed.freshSince).toBeUndefined();
    expect(skipped.status).toBe("skipped");
    expect(skipped.freshSince).toBeUndefined();
    expect(mockRaw).toHaveBeenCalledTimes(2);
  });

  it("does not let a non-pruning success satisfy a pruning cadence run", async () => {
    const coord = new RepoFetchCoordinator();
    await coord.fetchForWorktree(opts({ worktreeId: "a", force: true, prune: false }));
    vi.advanceTimersByTime(60_000);

    await coord.fetchForWorktree(opts({ worktreeId: "b", maxAgeMs: 120_000 }));

    expect(mockRaw).toHaveBeenCalledTimes(2);
    expect((mockRaw.mock.calls[1]![0] as string[]).includes("--prune")).toBe(true);
  });
});

interface MutableHost {
  isRunning: boolean;
  pollingEnabled: boolean;
  isCurrent: boolean;
  hasInitialStatus: boolean;
  hasFetchCallback: boolean;
  onExecuteFetch: ReturnType<typeof vi.fn>;
  onUpdate: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return {
    isRunning: true,
    pollingEnabled: true,
    isCurrent: false,
    hasInitialStatus: true,
    hasFetchCallback: true,
    onExecuteFetch: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn(),
    ...overrides,
  };
}

describe("FetchScheduler — sibling freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("asks for a window a lone worktree's own last fetch can never satisfy", async () => {
    for (const isCurrent of [true, false]) {
      // Shortest delay the jitter can draw.
      vi.spyOn(Math, "random").mockReturnValue(0);
      const firedAt: number[] = [];
      const host = makeHost({
        isCurrent,
        onExecuteFetch: vi.fn(() => {
          firedAt.push(Date.now());
          return Promise.resolve<WorkspaceFetchResult>({
            status: "success",
            lastFetchedAt: Date.now(),
            freshSince: Date.now(),
          });
        }),
      });
      const scheduler = new FetchScheduler(host as FetchSchedulerHost);

      scheduler.schedule(true);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      scheduler.clearTimer();

      const cadenceCalls = host.onExecuteFetch.mock.calls.slice(1);
      expect(cadenceCalls.length).toBeGreaterThan(0);
      for (let i = 0; i < cadenceCalls.length; i++) {
        const maxAgeMs = cadenceCalls[i]![2] as number;
        const gap = firedAt[i + 1]! - firedAt[i]!;
        expect(maxAgeMs).toBeLessThan(gap);
      }
      vi.restoreAllMocks();
    }
  });

  it("does not pass a freshness window on initial (startup / focus-flip) runs", async () => {
    const host = makeHost({ isCurrent: false });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    scheduler.schedule(true);
    await vi.advanceTimersByTimeAsync(5_001);
    host.isCurrent = true;
    scheduler.reschedule(true);
    await vi.advanceTimersByTimeAsync(5_001);
    scheduler.clearTimer();

    expect(host.onExecuteFetch.mock.calls).toEqual([
      [false, undefined],
      [false, undefined],
    ]);
  });

  it("does not pass a freshness window on forced runs", async () => {
    const host = makeHost();
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    await scheduler.triggerNow(true);
    scheduler.clearTimer();

    expect(host.onExecuteFetch.mock.calls).toEqual([[true, true]]);
  });

  /**
   * Drives one cadence run: arms a cadence timer at random=0.5 (the 5 min
   * base), lets it fire, and hands back the result `respond` builds.
   */
  async function runOneCadence(
    respond: (startedAt: number) => Promise<WorkspaceFetchResult | undefined>
  ) {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = makeHost({
      onExecuteFetch: vi.fn(() => respond(Date.now())),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);
    scheduler.schedule(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    host.onExecuteFetch.mockImplementation(() => Promise.resolve(undefined));
    return { host, scheduler };
  }

  async function expectNextFetchAfter(
    host: MutableHost,
    scheduler: FetchScheduler,
    delayMs: number
  ) {
    const calls = host.onExecuteFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delayMs - 1_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(calls + 1);
    scheduler.clearTimer();
  }

  it("anchors the next timer to a reused sibling fetch instead of now", async () => {
    const { host, scheduler } = await runOneCadence(async (now) => ({
      status: "success",
      lastFetchedAt: now - 100_000,
      freshSince: now - 100_000,
    }));
    await expectNextFetchAfter(host, scheduler, 5 * 60_000 - 100_000);
  });

  it("does not count time spent fetching toward the anchor", async () => {
    // A slow batch whose every remote was fetched during the run: nothing was
    // reused, so the next interval runs from completion, not from the batch's
    // first remote — otherwise slow remotes chain minimum-delay re-arms.
    const { host, scheduler } = await runOneCadence(async (startedAt) => {
      await new Promise((resolve) => setTimeout(resolve, 50_000));
      return { status: "success", lastFetchedAt: startedAt + 50_000, freshSince: startedAt + 1 };
    });
    await vi.advanceTimersByTimeAsync(50_000);
    await expectNextFetchAfter(host, scheduler, 5 * 60_000);
  });

  it("re-arms from now when no remote succeeded", async () => {
    const { host, scheduler } = await runOneCadence(async (now) => ({
      status: "failed",
      reason: "network-unavailable",
      lastFetchedAt: now - 100_000,
    }));
    await expectNextFetchAfter(host, scheduler, 5 * 60_000);
  });

  it("re-arms from now after a success that carries no freshSince", async () => {
    const { host, scheduler } = await runOneCadence(async () => ({ status: "success" }));
    await expectNextFetchAfter(host, scheduler, 5 * 60_000);
  });

  it("anchors on a healthy remote even when the primary failed", async () => {
    const { host, scheduler } = await runOneCadence(async (now) => ({
      status: "failed",
      reason: "network-unavailable",
      freshSince: now - 100_000,
    }));
    await expectNextFetchAfter(host, scheduler, 5 * 60_000 - 100_000);
  });

  it("does not anchor after forced or initial runs, whatever they reused", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const reused = () =>
      Promise.resolve<WorkspaceFetchResult>({
        status: "success",
        lastFetchedAt: Date.now() - 10_000,
        freshSince: Date.now() - 10_000,
      });
    const host = makeHost({ onExecuteFetch: vi.fn(reused) });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);

    await scheduler.triggerNow();
    await expectNextFetchAfter(host, scheduler, 5 * 60_000);

    host.onExecuteFetch.mockClear();
    scheduler.schedule(true);
    // Startup-tier delay at random=0.5.
    await vi.advanceTimersByTimeAsync(3_500);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    await expectNextFetchAfter(host, scheduler, 5 * 60_000);
  });

  it("keeps the anchor when an interval change re-arms the timer", async () => {
    const { host, scheduler } = await runOneCadence(async (now) => ({
      status: "success",
      lastFetchedAt: now - 100_000,
      freshSince: now - 100_000,
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    // Background base 4 min at random=0.5, counted from the anchor 160 s ago.
    scheduler.updateIntervals(undefined, 4 * 60_000);
    await expectNextFetchAfter(host, scheduler, 4 * 60_000 - 160_000);
  });

  it("drops the anchor when an initial timer restarts the cadence", async () => {
    const { host, scheduler } = await runOneCadence(async (now) => ({
      status: "success",
      lastFetchedAt: now - 100_000,
      freshSince: now - 100_000,
    }));
    scheduler.clearTimer();
    // Resume arms the startup tier; an interval change then replaces it.
    scheduler.schedule(true);
    scheduler.updateIntervals(undefined, 4 * 60_000);
    await expectNextFetchAfter(host, scheduler, 4 * 60_000);
  });

  it("a forced run re-arms a timer armed off a stale anchor while it ran", async () => {
    const { host, scheduler } = await runOneCadence(async (now) => ({
      status: "success",
      lastFetchedAt: now - 100_000,
      freshSince: now - 100_000,
    }));
    let finish!: () => void;
    host.onExecuteFetch.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        })
    );
    await vi.advanceTimersByTimeAsync(150_000);
    const forced = scheduler.triggerNow();
    // Armed off the old anchor (250 s ago): fires 10 s from now.
    scheduler.updateIntervals(undefined, 4 * 60_000);
    finish();
    await forced;
    host.onExecuteFetch.mockImplementation(() => Promise.resolve(undefined));

    await expectNextFetchAfter(host, scheduler, 4 * 60_000);
  });

  it("re-arms from the anchor when an interval change lands mid-run", async () => {
    let finish!: (r: WorkspaceFetchResult) => void;
    let startedAt = 0;
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = makeHost({
      onExecuteFetch: vi.fn(() => {
        startedAt = Date.now();
        return new Promise<WorkspaceFetchResult>((resolve) => {
          finish = resolve;
        });
      }),
    });
    const scheduler = new FetchScheduler(host as FetchSchedulerHost);
    scheduler.schedule(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(host.onExecuteFetch).toHaveBeenCalledTimes(1);
    host.onExecuteFetch.mockImplementation(() => Promise.resolve(undefined));

    // Changing only the focused interval still re-arms a background timer
    // from now while the run is in flight.
    scheduler.updateIntervals(20_000);
    finish({
      status: "success",
      lastFetchedAt: startedAt - 100_000,
      freshSince: startedAt - 100_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    await expectNextFetchAfter(host, scheduler, 5 * 60_000 - 100_000);
  });
});

describe("sibling schedulers sharing one coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    mockGetGitCommonDir.mockReset().mockReturnValue(COMMON_DIR);
    mockRaw.mockReset().mockResolvedValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function wire(coord: RepoFetchCoordinator, id: string, isCurrent: boolean, remotes: string[]) {
    const host: FetchSchedulerHost = {
      isRunning: true,
      pollingEnabled: true,
      isCurrent,
      hasInitialStatus: true,
      hasFetchCallback: true,
      onExecuteFetch: (force, prune, maxAgeMs) =>
        coord.fetchForWorktree({
          worktreeId: id,
          worktreePath: `/repo/${id}`,
          force,
          prune,
          remotes,
          primaryRemote: remotes[0],
          ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
        }),
      onUpdate: () => {},
    };
    const scheduler = new FetchScheduler(host);
    scheduler.schedule(true);
    return scheduler;
  }

  it("background siblings stop re-fetching a remote the focused worktree keeps fresh", async () => {
    const coord = new RepoFetchCoordinator();
    const focused = wire(coord, "focused", true, ["origin"]);
    const siblings = Array.from({ length: 5 }, (_, i) => wire(coord, `bg${i}`, false, ["origin"]));

    // Warm-up covers the 2-5 s initial fetches, which keep the default window.
    await vi.advanceTimersByTimeAsync(60_000);
    fetchPaths.length = 0;
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(fetchPaths.length).toBeGreaterThan(0);
    expect(fetchPaths.filter((p) => p !== "/repo/focused")).toEqual([]);
    for (const s of [focused, ...siblings]) s.clearTimer();
  });

  it("keeps each remote's refs within one background interval of fresh", async () => {
    const coord = new RepoFetchCoordinator();
    const all = [
      wire(coord, "focused", true, ["origin"]),
      ...Array.from({ length: 4 }, (_, i) => wire(coord, `up${i}`, false, ["upstream", "origin"])),
    ];

    // Initial runs keep the default window and re-arm from now, so a sibling's
    // fetch they reused can run up to 15 s past one interval until each
    // scheduler's first cadence run anchors it. Warm up past the latest that
    // can land: the longest initial delay plus one full background interval.
    await vi.advanceTimersByTimeAsync(5_000 + 6.25 * 60_000);
    mockRaw.mockClear();
    const worstAge = { origin: 0, upstream: 0 };
    for (let t = 0; t < 30 * 60; t++) {
      await vi.advanceTimersByTimeAsync(1_000);
      for (const remote of ["origin", "upstream"] as const) {
        const last = coord.getLastSuccessfulFetch(COMMON_DIR, remote)!;
        worstAge[remote] = Math.max(worstAge[remote], Date.now() - last);
      }
    }

    // Upper edge of each tier's jitter band (+25%): focused for origin,
    // background for upstream.
    expect(worstAge.origin).toBeLessThanOrEqual(37_500);
    expect(worstAge.upstream).toBeLessThanOrEqual(6.25 * 60_000);
    // Four siblings used to fetch upstream on their own phases; now roughly
    // one fetch per interval covers them all.
    const upstreamFetches = fetchedRemotes().filter((r) => r === "upstream").length;
    expect(upstreamFetches).toBeLessThanOrEqual(12);
    for (const s of all) s.clearTimer();
  });
});
