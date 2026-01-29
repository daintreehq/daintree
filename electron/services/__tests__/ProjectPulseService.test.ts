import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", () => ({
  existsSync: () => true,
}));

type SimpleGitStub = {
  raw: (args: string[]) => Promise<string>;
  checkIsRepo: () => Promise<boolean>;
};

function createGitStub(impl: (args: string[]) => Promise<string>): SimpleGitStub {
  return {
    checkIsRepo: async () => true,
    raw: impl,
  };
}

describe("ProjectPulseService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("dedupes concurrent requests with same cache key", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const opts = {
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    };

    const p1 = svc.getPulse(opts);
    const p2 = svc.getPulse(opts);
    await Promise.all([p1, p2]);

    // Filter for heatmap calls (with --since) vs streak calls (without --since)
    const heatmapCalls = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.includes("--pretty=format:%ct") && argv.some((a) => a.startsWith("--since="));
    });
    expect(heatmapCalls.length).toBe(1);
  });

  it("does not reuse cache across different include options", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: true,
    });

    // Filter for heatmap calls (with --since) vs streak calls (without --since)
    const heatmapCalls = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.includes("--pretty=format:%ct") && argv.some((a) => a.startsWith("--since="));
    });
    expect(heatmapCalls.length).toBe(2);
  });

  it("calculates full streak beyond view range", async () => {
    // Set system time to Jan 15, 2025
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Generate commit timestamps for a 200-day streak (beyond 180-day max view range)
    // Commits are at noon each day going back 200 days from Jan 14 (yesterday since today has no commits)
    const fullStreakTimestamps: number[] = [];
    for (let i = 1; i <= 200; i++) {
      const date = new Date(baseTime);
      date.setDate(date.getDate() - i);
      fullStreakTimestamps.push(Math.floor(date.getTime() / 1000));
    }
    const fullStreakOutput = fullStreakTimestamps.join("\n");

    // Heatmap should only see last 60 days (with --since)
    const heatmapTimestamps: number[] = [];
    for (let i = 1; i <= 59; i++) {
      const date = new Date(baseTime);
      date.setDate(date.getDate() - i);
      heatmapTimestamps.push(Math.floor(date.getTime() / 1000));
    }
    const heatmapOutput = heatmapTimestamps.join("\n");

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log" && args.some((a) => a.startsWith("--since="))) {
        // Heatmap query (with --since)
        return heatmapOutput;
      }
      if (cmd === "log" && args.includes("--pretty=format:%ct")) {
        // Full streak query (without --since)
        return fullStreakOutput;
      }
      if (cmd === "log") return fullStreakOutput;
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    // Use 60-day view range but expect full 200-day streak
    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // The streak should be 200 days (beyond the 60-day view range)
    expect(pulse.currentStreakDays).toBe(200);
    // The heatmap should only show 60 days
    expect(pulse.heatmap).toHaveLength(60);
  });

  it("skips today when calculating streak if no commits today", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Commits for yesterday and day before (2-day streak, no commits today)
    const commitTimestamps: number[] = [];
    for (let i = 1; i <= 2; i++) {
      const date = new Date(baseTime);
      date.setDate(date.getDate() - i);
      commitTimestamps.push(Math.floor(date.getTime() / 1000));
    }
    const commitOutput = commitTimestamps.join("\n");

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // Should count yesterday and day before = 2 day streak
    expect(pulse.currentStreakDays).toBe(2);
  });

  it("includes today in streak if commits today", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Commits for today, yesterday, and day before (3-day streak)
    const commitTimestamps: number[] = [];
    for (let i = 0; i <= 2; i++) {
      const date = new Date(baseTime);
      date.setDate(date.getDate() - i);
      commitTimestamps.push(Math.floor(date.getTime() / 1000));
    }
    const commitOutput = commitTimestamps.join("\n");

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // Should count today, yesterday, and day before = 3 day streak
    expect(pulse.currentStreakDays).toBe(3);
  });

  it("handles gap in streak correctly", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Commits today (i=0), 2 days ago (i=2), 3 days ago (i=3)
    // Missing yesterday (i=1) - should break streak
    const commitTimestamps: number[] = [];
    [0, 2, 3].forEach((i) => {
      const date = new Date(baseTime);
      date.setDate(date.getDate() - i);
      commitTimestamps.push(Math.floor(date.getTime() / 1000));
    });
    const commitOutput = commitTimestamps.join("\n");

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // Streak should be 1 (only today) since yesterday is missing
    expect(pulse.currentStreakDays).toBe(1);
  });

  it("handles no recent commits", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Last commit was 5 days ago
    const date = new Date(baseTime);
    date.setDate(date.getDate() - 5);
    const commitOutput = Math.floor(date.getTime() / 1000).toString();

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // No streak since last commit was 5 days ago
    expect(pulse.currentStreakDays).toBe(0);
  });

  it("handles multiple commits on same day", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Multiple commits on each of the last 3 days
    const commitTimestamps: number[] = [];
    for (let i = 0; i <= 2; i++) {
      const date = new Date(baseTime);
      date.setDate(date.getDate() - i);
      // Add 3 commits per day at different times
      commitTimestamps.push(Math.floor(date.getTime() / 1000));
      commitTimestamps.push(Math.floor((date.getTime() + 3600000) / 1000));
      commitTimestamps.push(Math.floor((date.getTime() + 7200000) / 1000));
    }
    const commitOutput = commitTimestamps.join("\n");

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // Should count 3 days, not 9 commits
    expect(pulse.currentStreakDays).toBe(3);
  });

  it("returns empty heatmap on git log error", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") throw new Error("no commits");
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "HEAD\n";
      if (cmd === "log") throw new Error("fatal");
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    expect(pulse.heatmap).toHaveLength(60);
    expect(pulse.commitsInRange).toBe(0);
    expect(pulse.branch).toBeUndefined();
  });
});
