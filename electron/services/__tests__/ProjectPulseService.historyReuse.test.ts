import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PulseRangeDays } from "../../../shared/types/pulse.js";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

interface RepoState {
  headSha: string;
  branch: string;
  shallow: boolean;
  rootTimestamps: number[];
  commitTimestamps: number[];
  // Awaited after a command has read the repo and before it answers, to hold it open.
  gate?: (args: string[], signal?: AbortSignal) => Promise<void> | undefined;
  failRootWalk?: boolean;
  failStreakLog?: boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function localNoon(year: number, monthIndex: number, day: number): number {
  return Math.floor(new Date(year, monthIndex, day, 12).getTime() / 1000);
}

function isStreakLog(args: string[]): boolean {
  return args[0] === "log" && !args.some((a) => a.startsWith("--since="));
}

function isHeatmapLog(args: string[]): boolean {
  return args[0] === "log" && args.some((a) => a.startsWith("--since="));
}

function isRootWalk(args: string[]): boolean {
  return args[0] === "rev-list" && args.includes("--max-parents=0");
}

function isShallowCheck(args: string[]): boolean {
  return args[0] === "rev-parse" && args.includes("--is-shallow-repository");
}

// The compute's own branch read, not the cache probe that reads HEAD and the branch together.
function isBranchLookup(args: string[]): boolean {
  return args[0] === "rev-parse" && args[1] === "--abbrev-ref";
}

function isHeadProbe(args: string[]): boolean {
  return args[0] === "rev-parse" && args[1] === "HEAD" && args[2] === "--abbrev-ref";
}

function createRepo(state: RepoState) {
  const answer = (args: string[]): string => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return `${state.headSha}\n`;
    }
    if (isBranchLookup(args)) return `${state.branch}\n`;
    if (isHeadProbe(args)) return `${state.headSha}\n${state.branch}\n`;
    if (args[0] === "rev-parse" && args.includes("--quiet")) return "basesha\n";
    if (isShallowCheck(args)) return state.shallow ? "true\n" : "false\n";
    if (isRootWalk(args)) {
      if (state.failRootWalk) throw new Error("fatal: unable to read tree");
      return state.rootTimestamps.map((t, i) => `${t} root${i}`).join("\n");
    }
    if (isHeatmapLog(args)) {
      const since = Number(args.find((a) => a.startsWith("--since="))!.slice("--since=".length));
      return state.commitTimestamps.filter((t) => t >= since).join("\n");
    }
    if (isStreakLog(args)) {
      if (state.failStreakLog) throw new Error("fatal: unable to read commit");
      return state.commitTimestamps.join("\n");
    }
    return "";
  };
  const raw = vi.fn(async (args: string[], signal?: AbortSignal): Promise<string> => {
    const output = answer(args);
    await state.gate?.(args, signal);
    // Like simple-git, a command whose signal aborted while it ran rejects instead of answering.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return output;
  });
  const count = (predicate: (args: string[]) => boolean) =>
    raw.mock.calls.filter(([args]) => predicate(args)).length;
  return { raw, count };
}

function pulseOptions(rangeDays: PulseRangeDays, extra: Record<string, unknown> = {}) {
  return {
    worktreePath: "/repo",
    worktreeId: "wt-1",
    mainBranch: "main",
    rangeDays,
    includeDelta: false,
    includeRecentCommits: false,
    ...extra,
  };
}

async function loadService(raw: (args: string[], signal?: AbortSignal) => Promise<string>) {
  vi.doMock("../../utils/hardenedGit.js", () => ({
    createStrictExitGit: (_cwd: string, signal?: AbortSignal) => ({
      checkIsRepo: async () => true,
      raw: (args: string[]) => raw(args, signal),
    }),
  }));
  const { ProjectPulseService } = await import("../ProjectPulseService.js");
  return new ProjectPulseService();
}

describe("ProjectPulseService range-independent history reuse", () => {
  let state: RepoState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15, 15, 0));
    state = {
      headSha: "deadbeef",
      branch: "main",
      shallow: false,
      rootTimestamps: [localNoon(2024, 9, 1)],
      // A two-day streak ending yesterday (today is empty, Jan 12 is a gap), plus the root commit
      // and one more that only the 120 and 180 day ranges reach.
      commitTimestamps: [
        localNoon(2025, 0, 14),
        localNoon(2025, 0, 13),
        localNoon(2025, 0, 11),
        localNoon(2024, 9, 15),
        localNoon(2024, 9, 1),
      ],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("walks roots and streak history once across 60, 120 and 180 days on one head", async () => {
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const p60 = await svc.getPulse(pulseOptions(60));
    const p120 = await svc.getPulse(pulseOptions(120));
    const p180 = await svc.getPulse(pulseOptions(180));

    expect(count(isRootWalk)).toBe(1);
    expect(count(isShallowCheck)).toBe(1);
    expect(count(isStreakLog)).toBe(1);
    expect(count(isHeatmapLog)).toBe(3);
    // Per range: HEAD, branch and the heatmap window; once: shallow probe, root walk, streak log.
    // Before reuse each range repeated all six.
    expect(raw).toHaveBeenCalledTimes(12);
    const cutoffs = raw.mock.calls
      .map(([args]) => args.find((a) => a.startsWith("--since=")))
      .filter(Boolean);
    expect(new Set(cutoffs).size).toBe(3);

    expect(p60.heatmap).toHaveLength(60);
    expect(p120.heatmap).toHaveLength(120);
    expect(p180.heatmap).toHaveLength(180);
    for (const pulse of [p60, p120, p180]) {
      expect(pulse.currentStreakDays).toBe(2);
    }
    // Oct 1 root, 107 days before Jan 15 inclusive: 60 days sit inside the project, 120 and 180
    // reach back before it.
    expect(p60.projectAgeDays).toBe(60);
    expect(p120.projectAgeDays).toBe(107);
    expect(p180.projectAgeDays).toBe(107);
    expect(p60.heatmap.filter((c) => c.isBeforeProject)).toHaveLength(0);
    expect(p120.heatmap.filter((c) => c.isBeforeProject)).toHaveLength(13);
    expect(p180.heatmap.filter((c) => c.isBeforeProject)).toHaveLength(73);
    expect(p60.commitsInRange).toBe(3);
    expect(p120.commitsInRange).toBe(5);
    expect(p180.commitsInRange).toBe(5);
  });

  it("keeps reused history correct across midnight within the TTL", async () => {
    vi.setSystemTime(new Date(2025, 0, 15, 23, 59, 50));
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const before = await svc.getPulse(pulseOptions(180));
    await vi.advanceTimersByTimeAsync(20_000);
    const after = await svc.getPulse(pulseOptions(180));

    expect(count(isHeatmapLog)).toBe(2);
    expect(count(isRootWalk)).toBe(1);
    expect(count(isStreakLog)).toBe(1);

    expect(before.currentStreakDays).toBe(2);
    // Jan 15 had no commits, so on Jan 16 the run is broken.
    expect(after.currentStreakDays).toBe(0);
    expect(after.projectAgeDays).toBe(before.projectAgeDays + 1);
    expect(before.heatmap.at(-1)).toMatchObject({ date: "2025-01-15", isToday: true });
    expect(after.heatmap.at(-1)).toMatchObject({ date: "2025-01-16", isToday: true });
  });

  it("answers for the day a compute started in when midnight lands mid-compute", async () => {
    vi.setSystemTime(new Date(2025, 0, 15, 23, 59, 50));
    const walk = deferred();
    const firstHeatmap = deferred();
    let heatmapLogs = 0;
    state.gate = (args) => {
      if (isStreakLog(args)) return walk.promise;
      if (isHeatmapLog(args) && heatmapLogs++ === 0) return firstHeatmap.promise;
      return undefined;
    };
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const started = svc.getPulse(pulseOptions(180));
    await vi.advanceTimersByTimeAsync(20_000);
    // After midnight the same range starts its own compute but shares the pending walk.
    const afterMidnight = svc.getPulse(pulseOptions(180));
    await vi.advanceTimersByTimeAsync(0);
    expect(count(isHeatmapLog)).toBe(2);
    expect(count(isStreakLog)).toBe(1);

    walk.resolve();
    const second = await afterMidnight;
    expect(second.heatmap.at(-1)).toMatchObject({ date: "2025-01-16", isToday: true });
    expect(second.currentStreakDays).toBe(0);

    // The pre-midnight compute settles last, still answering for Jan 15, and must not replace
    // the Jan 16 entry.
    firstHeatmap.resolve();
    const first = await started;
    expect(first.heatmap.at(-1)).toMatchObject({ date: "2025-01-15", isToday: true });
    expect(first.currentStreakDays).toBe(2);

    expect(await svc.getPulse(pulseOptions(180))).toBe(second);
    expect(count(isHeatmapLog)).toBe(2);
  });

  it("walks again when HEAD moves but not when only the branch name changes", async () => {
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    await svc.getPulse(pulseOptions(60));

    state.branch = "feature";
    const switched = await svc.getPulse(pulseOptions(60));
    expect(switched.branch).toBe("feature");
    expect(count(isHeatmapLog)).toBe(2);
    expect(count(isRootWalk)).toBe(1);
    expect(count(isStreakLog)).toBe(1);

    state.headSha = "cafef00d";
    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];
    const moved = await svc.getPulse(pulseOptions(120, { includeDelta: true }));
    expect(count(isRootWalk)).toBe(2);
    expect(count(isStreakLog)).toBe(2);
    expect(moved.currentStreakDays).toBe(3);
    // Every read starts from the resolved SHA rather than whatever HEAD is by then.
    for (const isWalk of [isRootWalk, isStreakLog, isHeatmapLog]) {
      expect(count((args) => isWalk(args) && args.includes("cafef00d"))).toBe(1);
    }
    expect(moved.deltaToMain).toMatchObject({ baseBranch: "main", headBranch: "feature" });
    expect(count((args) => args.includes("basesha...cafef00d"))).toBe(2);
    expect(count((args) => args.some((a) => a.endsWith("...HEAD")))).toBe(0);
  });

  it("starts a separate walk for a new HEAD while the old HEAD's walk is still running", async () => {
    const gate = deferred();
    state.gate = (args) =>
      isStreakLog(args) && args.includes("deadbeef") ? gate.promise : undefined;
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const old = svc.getPulse(pulseOptions(60));
    await vi.advanceTimersByTimeAsync(0);

    state.headSha = "cafef00d";
    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];
    const moved = await svc.getPulse(pulseOptions(120));
    expect(count(isStreakLog)).toBe(2);
    expect(moved.currentStreakDays).toBe(3);

    gate.resolve();
    expect((await old).currentStreakDays).toBe(2);

    // The old HEAD's walk finished last; the new HEAD's history must still be the one kept.
    const next = await svc.getPulse(pulseOptions(180));
    expect(count(isStreakLog)).toBe(2);
    expect(next.currentStreakDays).toBe(3);
  });

  it("keeps the newer HEAD's history when an older HEAD's walk publishes first", async () => {
    const olderBranch = deferred();
    const newerWalk = deferred();
    let branchLookups = 0;
    state.gate = (args) => {
      if (isBranchLookup(args) && branchLookups++ === 0) return olderBranch.promise;
      if (isStreakLog(args) && args.includes("cafef00d")) return newerWalk.promise;
      return undefined;
    };
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    // The older compute reads HEAD first, then stalls before its walk starts.
    const older = svc.getPulse(pulseOptions(60));
    await vi.advanceTimersByTimeAsync(0);
    state.headSha = "cafef00d";
    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];
    const newer = svc.getPulse(pulseOptions(120));
    await vi.advanceTimersByTimeAsync(0);

    olderBranch.resolve();
    await older;
    newerWalk.resolve();
    expect((await newer).currentStreakDays).toBe(3);

    const next = await svc.getPulse(pulseOptions(180));
    expect(count(isStreakLog)).toBe(2);
    expect(next.currentStreakDays).toBe(3);
  });

  it("drops reused history on invalidate, for that worktree only", async () => {
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);
    const other = { worktreeId: "wt-2", worktreePath: "/repo-2" };

    await svc.getPulse(pulseOptions(60));
    await svc.getPulse(pulseOptions(60, other));
    expect(count(isStreakLog)).toBe(2);

    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];
    svc.invalidate("wt-1");

    const otherPulse = await svc.getPulse(pulseOptions(120, other));
    expect(count(isStreakLog)).toBe(2);
    expect(otherPulse.currentStreakDays).toBe(2);

    const pulse = await svc.getPulse(pulseOptions(120));
    expect(count(isStreakLog)).toBe(3);
    expect(count(isRootWalk)).toBe(3);
    expect(pulse.currentStreakDays).toBe(3);
  });

  it("walks again on forceRefresh and lets the other ranges reuse that walk", async () => {
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    await svc.getPulse(pulseOptions(60));
    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];

    const forced = await svc.getPulse(pulseOptions(60, { forceRefresh: true }));
    expect(count(isStreakLog)).toBe(2);
    expect(forced.currentStreakDays).toBe(3);

    const next = await svc.getPulse(pulseOptions(180));
    expect(count(isStreakLog)).toBe(2);
    expect(count(isRootWalk)).toBe(2);
    expect(next.currentStreakDays).toBe(3);
  });

  it("walks afresh on forceRefresh rather than joining a walk that began before it", async () => {
    const gate = deferred();
    let streakLogs = 0;
    state.gate = (args) => (isStreakLog(args) && streakLogs++ === 0 ? gate.promise : undefined);
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const ordinary = svc.getPulse(pulseOptions(60));
    await vi.advanceTimersByTimeAsync(0);

    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];
    const forced = await svc.getPulse(pulseOptions(120, { forceRefresh: true }));
    expect(count(isStreakLog)).toBe(2);
    expect(forced.currentStreakDays).toBe(3);

    // The overtaken walk settles last: it must neither replace the forced facts nor drop them.
    gate.resolve();
    expect((await ordinary).currentStreakDays).toBe(2);
    const next = await svc.getPulse(pulseOptions(180));
    expect(count(isStreakLog)).toBe(2);
    expect(next.currentStreakDays).toBe(3);
  });

  it("does not let a forced refresh join a same-range compute already running", async () => {
    const gate = deferred();
    let streakLogs = 0;
    state.gate = (args) => (isStreakLog(args) && streakLogs++ === 0 ? gate.promise : undefined);
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const ordinary = svc.getPulse(pulseOptions(60));
    await vi.advanceTimersByTimeAsync(0);

    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];
    const forced = await svc.getPulse(pulseOptions(60, { forceRefresh: true }));
    expect(count(isHeatmapLog)).toBe(2);
    expect(forced.currentStreakDays).toBe(3);

    gate.resolve();
    expect((await ordinary).currentStreakDays).toBe(2);
    // The overtaken compute settled last but must not replace the forced result.
    expect(await svc.getPulse(pulseOptions(60))).toBe(forced);
  });

  it("expires a Pulse built on reused history when that history expires", async () => {
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    await svc.getPulse(pulseOptions(60));
    await vi.advanceTimersByTimeAsync(50_000);
    await svc.getPulse(pulseOptions(120));
    expect(count(isStreakLog)).toBe(1);

    // 65s after the walk: the 120-day Pulse is only 15s old, but its history is not fresh.
    await vi.advanceTimersByTimeAsync(15_000);
    await svc.getPulse(pulseOptions(120));
    expect(count(isHeatmapLog)).toBe(3);
    expect(count(isStreakLog)).toBe(2);

    await svc.getPulse(pulseOptions(60));
    expect(count(isHeatmapLog)).toBe(4);
    expect(count(isStreakLog)).toBe(2);
  });

  it.each([
    { failing: "root walk", flag: "failRootWalk", beforeProject: false, streak: 2 },
    // A failed streak walk leaves the streak unknown, never zero.
    { failing: "streak log", flag: "failStreakLog", beforeProject: true, streak: undefined },
  ] as const)(
    "does not keep a history load whose $failing failed",
    async ({ flag, beforeProject, streak }) => {
      state[flag] = true;
      const { raw, count } = createRepo(state);
      const svc = await loadService(raw);

      // The walk that succeeded still serves this response.
      const degraded = await svc.getPulse(pulseOptions(180));
      expect(degraded.heatmap.some((c) => c.isBeforeProject)).toBe(beforeProject);
      expect(degraded.currentStreakDays).toBe(streak);

      // Neither the history nor the Pulse standing on its fallback is kept, so the same range
      // walks again rather than serving the fallback.
      state[flag] = false;
      const recovered = await svc.getPulse(pulseOptions(180));
      expect(count(isHeatmapLog)).toBe(2);
      expect(count(isRootWalk)).toBe(2);
      expect(count(isStreakLog)).toBe(2);
      expect(recovered.heatmap.some((c) => c.isBeforeProject)).toBe(true);
      expect(recovered.currentStreakDays).toBe(2);

      await svc.getPulse(pulseOptions(60));
      expect(count(isRootWalk)).toBe(2);
      expect(count(isStreakLog)).toBe(2);
    }
  );

  it("shares one history load between ranges requested together", async () => {
    const gate = deferred();
    state.gate = (args) => (isStreakLog(args) ? gate.promise : undefined);
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const pending = [60, 120, 180].map((range) =>
      svc.getPulse(pulseOptions(range as PulseRangeDays))
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(count(isStreakLog)).toBe(1);

    gate.resolve();
    const pulses = await Promise.all(pending);
    expect(count(isRootWalk)).toBe(1);
    expect(count(isStreakLog)).toBe(1);
    expect(count(isHeatmapLog)).toBe(3);
    expect(pulses.map((p) => p.currentStreakDays)).toEqual([2, 2, 2]);
  });

  it.each([
    { label: "across ranges", ranges: [60, 120, 180], heatmapLogs: 3 },
    { label: "within one range", ranges: [60, 60, 60], heatmapLogs: 2 },
  ] as const)(
    "never caches a compute that invalidate overtook, nor lets it evict the replacement ($label)",
    async ({ ranges, heatmapLogs }) => {
      const gates = [deferred(), deferred()];
      let streakLogs = 0;
      state.gate = (args) => (isStreakLog(args) ? gates[streakLogs++]?.promise : undefined);
      const { raw, count } = createRepo(state);
      const svc = await loadService(raw);

      const stale = svc.getPulse(pulseOptions(ranges[0]));
      await vi.advanceTimersByTimeAsync(0);
      svc.invalidate("wt-1");

      const replacement = svc.getPulse(pulseOptions(ranges[1]));
      await vi.advanceTimersByTimeAsync(0);
      expect(count(isStreakLog)).toBe(2);

      // The stale compute settles first; a request arriving after it must still join the
      // replacement rather than start a third walk.
      gates[0].resolve();
      await stale;
      const joined = svc.getPulse(pulseOptions(ranges[2]));
      await vi.advanceTimersByTimeAsync(0);
      expect(count(isStreakLog)).toBe(2);
      expect(count(isHeatmapLog)).toBe(heatmapLogs);

      gates[1].resolve();
      await Promise.all([replacement, joined]);

      await svc.getPulse(pulseOptions(ranges[1]));
      expect(count(isStreakLog)).toBe(2);
      expect(count(isRootWalk)).toBe(2);
    }
  );

  it("lets invalidate abort a compute that outlived the sibling it shared a controller with", async () => {
    const gate = deferred();
    let heatmapLogs = 0;
    state.gate = (args) => (isHeatmapLog(args) && heatmapLogs++ === 1 ? gate.promise : undefined);
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const first = svc.getPulse(pulseOptions(60));
    const survivor = svc.getPulse(pulseOptions(120));
    await first;

    svc.invalidate("wt-1");
    gate.resolve();
    // Its heatmap read was aborted, which is a cancellation, never zero activity.
    await expect(survivor).rejects.toThrow("Project pulse read was cancelled");

    // The survivor answered from before the invalidation, so it must not be served again.
    await svc.getPulse(pulseOptions(120));
    expect(count(isHeatmapLog)).toBe(3);
    expect(count(isStreakLog)).toBe(2);
  });

  it("opens no history walk for a compute invalidate already aborted", async () => {
    const branchGate = deferred();
    const abortedWalk = deferred();
    let branchLookups = 0;
    state.gate = (args, signal) => {
      if (isBranchLookup(args) && branchLookups++ === 0) return branchGate.promise;
      if (isStreakLog(args) && signal?.aborted) return abortedWalk.promise;
      return undefined;
    };
    const { raw } = createRepo(state);
    const svc = await loadService(raw);

    const stale = svc.getPulse(pulseOptions(60));
    // Its heatmap read is aborted too, so it rejects as a cancellation rather than answering.
    const staleSettled = expect(stale).rejects.toThrow("Project pulse read was cancelled");
    await vi.advanceTimersByTimeAsync(0);
    svc.invalidate("wt-1");
    state.commitTimestamps = [localNoon(2025, 0, 15), ...state.commitTimestamps];

    branchGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // Had the aborted compute opened a walk, this request would join it and get its empty facts.
    const replacement = svc.getPulse(pulseOptions(120));
    await vi.advanceTimersByTimeAsync(0);
    abortedWalk.resolve();

    expect((await replacement).currentStreakDays).toBe(3);
    await staleSettled;
  });

  it("misses both caches when the local time zone changes", async () => {
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    // Two names for the same January offset, so the day matches and only the zone differs.
    const machineZone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      await svc.getPulse(pulseOptions(60));
      process.env.TZ = "Europe/London";
      await svc.getPulse(pulseOptions(60));
    } finally {
      if (machineZone === undefined) delete process.env.TZ;
      else process.env.TZ = machineZone;
    }

    expect(count(isHeatmapLog)).toBe(2);
    expect(count(isRootWalk)).toBe(2);
    expect(count(isStreakLog)).toBe(2);
  });
});
