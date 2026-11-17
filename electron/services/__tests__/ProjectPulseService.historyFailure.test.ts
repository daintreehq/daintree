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
    createStrictExitGit: () => ({ checkIsRepo: async () => true, raw }),
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

  it("fails instead of listing no commits when requested recent commits can't be read", async () => {
    let recentFails = true;
    const raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        return "deadbeef\n";
      }
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (args[0] === "log" && args[1] === "-n") {
        if (recentFails) throw new Error("fatal: bad object HEAD");
        return `abc123\x1f${daysAgoSeconds(1)}\x1fAda\x1fFix the thing\x1e`;
      }
      if (args[0] === "log") return HISTORY;
      return "";
    });
    const svc = await loadService(raw);
    const withRecent = { ...OPTS, includeRecentCommits: true };

    await expect(svc.getPulse(withRecent)).rejects.toThrow("Failed to read recent commits");
    // A caller that doesn't read the list never runs the failing query.
    expect((await svc.getPulse(OPTS)).commitsInRange).toBe(3);

    recentFails = false;
    const recovered = await svc.getPulse(withRecent);
    expect(recovered.recentCommits.map((c) => c.sha)).toEqual(["abc123"]);
  });

  it("keeps git's own text out of the error a failed history read rejects with", async () => {
    const raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        return "deadbeef\n";
      }
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      // HEAD went unborn between the probe and the log: the renderer reads
      // this phrase as a new repository and would stop retrying.
      if (isHeatmapLog(args)) {
        throw new Error("fatal: your current branch 'main' does not have any commits yet");
      }
      return "";
    });
    const svc = await loadService(raw);

    const error = await svc.getPulse(OPTS).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(error?.message).toBe("Failed to read commit history");
    expect((error?.cause as Error | undefined)?.message).toMatch(/does not have any commits yet/);
  });

  it("keeps the full-window age when the root read fails, and reads it again next time", async () => {
    let rootsFail = true;
    const raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        return "deadbeef\n";
      }
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "false\n";
      if (args[0] === "rev-list") {
        if (rootsFail) throw new Error("fatal: unable to read 1234abcd");
        return `${daysAgoSeconds(3)} rootsha\n`;
      }
      if (args[0] === "log") return HISTORY;
      return "";
    });
    const svc = await loadService(raw);

    const partial = await svc.getPulse(OPTS);
    expect(partial.commitsInRange).toBe(3);
    expect(partial.projectAgeDays).toBe(60);
    expect(partial.heatmap.some((cell) => cell.isBeforeProject)).toBe(false);

    rootsFail = false;
    const recovered = await svc.getPulse(OPTS);
    expect(recovered.projectAgeDays).toBe(4);
    expect(recovered.heatmap.some((cell) => cell.isBeforeProject)).toBe(true);
  });

  it("caches a shallow clone's missing first-commit date like any complete pulse", async () => {
    const raw = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        return "deadbeef\n";
      }
      if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return "true\n";
      if (args[0] === "log") return HISTORY;
      return "";
    });
    const svc = await loadService(raw);

    await svc.getPulse(OPTS);
    const heatmapReads = raw.mock.calls.filter(([args]) => isHeatmapLog(args)).length;
    const cached = await svc.getPulse(OPTS);
    expect(cached.projectAgeDays).toBe(60);
    expect(raw.mock.calls.filter(([args]) => isHeatmapLog(args)).length).toBe(heatmapReads);
  });
});
