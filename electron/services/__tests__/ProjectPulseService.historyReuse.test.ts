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
      return state.rootTimestamps.map((t, i) => `${t} root${i}`).join("\n");
    }
    if (isHeatmapLog(args)) {
      const since = Number(args.find((a) => a.startsWith("--since="))!.slice("--since=".length));
      return state.commitTimestamps.filter((t) => t >= since).join("\n");
    }
    if (isStreakLog(args)) return state.commitTimestamps.join("\n");
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
    createHardenedGit: () => ({ checkIsRepo: async () => true, raw }),
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
});
