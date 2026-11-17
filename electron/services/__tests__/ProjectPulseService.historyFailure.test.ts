import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

const NOW = new Date("2025-01-15T12:00:00.000Z");

function daysAgoSeconds(days: number): number {
  const date = new Date(NOW);
  date.setDate(date.getDate() - days);
  return Math.floor(date.getTime() / 1000);
}

// Three commits: yesterday, two days ago, three days ago.
const HISTORY = [1, 2, 3].map(daysAgoSeconds).join("\n");

const OPTS = {
  worktreePath: "/repo",
  worktreeId: "wt-1",
  mainBranch: "main",
  rangeDays: 60 as const,
  includeDelta: false,
  includeRecentCommits: false,
};

function isHeatmapLog(args: string[]): boolean {
  return args[0] === "log" && args.some((a) => a.startsWith("--since="));
}

function isStreakLog(args: string[]): boolean {
  return args[0] === "log" && args.some((a) => a.startsWith("--max-count=")) && !isHeatmapLog(args);
}

async function loadService(raw: (args: string[]) => Promise<string>) {
  vi.doMock("../../utils/hardenedGit.js", () => ({
    createHardenedGit: () => ({ checkIsRepo: async () => true, raw }),
  }));
  const { ProjectPulseService } = await import("../ProjectPulseService.js");
  return new ProjectPulseService();
}

describe("ProjectPulseService history read failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("fails instead of reporting zero commits when the timestamp log fails after a good HEAD probe", async () => {
    let heatmapFails = true;
    const raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        return "deadbeef\n";
      }
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (isHeatmapLog(args)) {
        if (heatmapFails) throw new Error("fatal: unable to read tree 1234abcd");
        return HISTORY;
      }
      if (args[0] === "log") return HISTORY;
      return "";
    });
    const svc = await loadService(raw);

    await expect(svc.getPulse(OPTS)).rejects.toThrow(/commit history/i);
    expect((svc as unknown as { cache: Map<string, unknown> }).cache.size).toBe(0);

    heatmapFails = false;
    const recovered = await svc.getPulse(OPTS);
    expect(recovered.commitsInRange).toBe(3);
    expect(recovered.activeDays).toBe(3);
    expect(recovered.currentStreakDays).toBe(3);
  });

  it("does not serve a cached pulse in place of the failed read inside the TTL", async () => {
    let heatmapFails = false;
    let head = "sha-aaa\n";
    const raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return head;
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (isHeatmapLog(args)) {
        if (heatmapFails) throw new Error("fatal: bad object");
        return HISTORY;
      }
      if (args[0] === "log") return HISTORY;
      return "";
    });
    const svc = await loadService(raw);

    expect((await svc.getPulse(OPTS)).commitsInRange).toBe(3);

    // HEAD moves, so the probe falls through to a recompute whose log fails.
    head = "sha-bbb\n";
    heatmapFails = true;
    await expect(svc.getPulse(OPTS)).rejects.toThrow(/commit history/i);

    // The failure left nothing behind under the new HEAD: the next read recomputes.
    heatmapFails = false;
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => isHeatmapLog(args)).length;
    expect((await svc.getPulse(OPTS)).commitsInRange).toBe(3);
    expect(raw.mock.calls.filter(([args]) => isHeatmapLog(args)).length).toBe(
      heatmapCallsBefore + 1
    );
  });

  it("reports the streak as unknown, not zero, when only the streak log fails, and recomputes it next time", async () => {
    let streakFails = true;
    const raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        return "deadbeef\n";
      }
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (isStreakLog(args)) {
        if (streakFails) throw new Error("timeout: git log exceeded its deadline");
        return HISTORY;
      }
      if (args[0] === "log") return HISTORY;
      return "";
    });
    const svc = await loadService(raw);

    const partial = await svc.getPulse(OPTS);
    expect(partial.commitsInRange).toBe(3);
    expect(partial.currentStreakDays).toBeUndefined();

    streakFails = false;
    const recovered = await svc.getPulse(OPTS);
    expect(recovered.currentStreakDays).toBe(3);
  });
});
