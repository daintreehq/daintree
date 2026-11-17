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
  // Awaited before the streak log answers, to hold a history load open.
  streakGate?: () => Promise<void>;
  failRootWalk?: boolean;
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

function createRepo(state: RepoState) {
  const raw = vi.fn(async (args: string[]): Promise<string> => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return `${state.headSha}\n`;
    }
    if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return `${state.branch}\n`;
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
      const commits = state.commitTimestamps.join("\n");
      await state.streakGate?.();
      return commits;
    }
    return "";
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

async function loadService(raw: (args: string[]) => Promise<string>) {
  vi.doMock("../../utils/hardenedGit.js", () => ({
    createStrictExitGit: () => ({ checkIsRepo: async () => true, raw }),
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
      // A two-day streak ending yesterday (today is empty, Jan 12 is a gap), plus one commit
      // that only the 120 and 180 day ranges reach.
      commitTimestamps: [
        localNoon(2025, 0, 14),
        localNoon(2025, 0, 13),
        localNoon(2025, 0, 11),
        localNoon(2024, 9, 15),
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
    // Oct 1 root: the 60-day range is fully inside the project, 120/180 are not.
    expect(p60.projectAgeDays).toBe(60);
    expect(p120.projectAgeDays).toBe(107);
    expect(p180.projectAgeDays).toBe(107);
    expect(p180.heatmap.filter((c) => c.isBeforeProject)).toHaveLength(73);
    expect(p60.commitsInRange).toBe(3);
    expect(p120.commitsInRange).toBe(4);
    expect(p180.commitsInRange).toBe(4);
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
    const moved = await svc.getPulse(pulseOptions(120));
    expect(count(isRootWalk)).toBe(2);
    expect(count(isStreakLog)).toBe(2);
    expect(moved.currentStreakDays).toBe(3);
    // Both walks start from the resolved SHA rather than whatever HEAD is by then.
    expect(count((args) => isRootWalk(args) && args.includes("cafef00d"))).toBe(1);
    expect(count((args) => isStreakLog(args) && args.includes("cafef00d"))).toBe(1);
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

  it("does not keep a history load that partly failed", async () => {
    state.failRootWalk = true;
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const degraded = await svc.getPulse(pulseOptions(180));
    expect(degraded.heatmap.some((c) => c.isBeforeProject)).toBe(false);
    expect(degraded.currentStreakDays).toBe(2);

    state.failRootWalk = false;
    const recovered = await svc.getPulse(pulseOptions(120));
    expect(count(isRootWalk)).toBe(2);
    expect(count(isStreakLog)).toBe(2);
    expect(recovered.heatmap.some((c) => c.isBeforeProject)).toBe(true);

    await svc.getPulse(pulseOptions(60));
    expect(count(isRootWalk)).toBe(2);
    expect(count(isStreakLog)).toBe(2);
  });

  it("shares one history load between ranges requested together", async () => {
    const gate = deferred();
    state.streakGate = () => gate.promise;
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

  it("never caches a load that invalidate overtook, nor lets it evict the replacement", async () => {
    const gates = [deferred(), deferred()];
    let streakLogs = 0;
    state.streakGate = () => gates[streakLogs++]?.promise ?? Promise.resolve();
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    const stale = svc.getPulse(pulseOptions(60));
    await vi.advanceTimersByTimeAsync(0);
    svc.invalidate("wt-1");

    const replacement = svc.getPulse(pulseOptions(120));
    await vi.advanceTimersByTimeAsync(0);
    expect(count(isStreakLog)).toBe(2);

    // The stale load settles first; a request arriving after it must still join the replacement.
    gates[0].resolve();
    await stale;
    const joined = svc.getPulse(pulseOptions(180));
    await vi.advanceTimersByTimeAsync(0);
    expect(count(isStreakLog)).toBe(2);

    gates[1].resolve();
    await Promise.all([replacement, joined]);

    await svc.getPulse(pulseOptions(60));
    expect(count(isStreakLog)).toBe(2);
    expect(count(isRootWalk)).toBe(2);
  });

  it("walks again when the local time zone changes", async () => {
    const { raw, count } = createRepo(state);
    const svc = await loadService(raw);

    await svc.getPulse(pulseOptions(60));

    const machineZone = process.env.TZ;
    const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = current === "Asia/Tokyo" ? "America/Los_Angeles" : "Asia/Tokyo";
    try {
      await svc.getPulse(pulseOptions(120));
    } finally {
      if (machineZone === undefined) delete process.env.TZ;
      else process.env.TZ = machineZone;
    }

    expect(count(isRootWalk)).toBe(2);
    expect(count(isStreakLog)).toBe(2);
  });
});
