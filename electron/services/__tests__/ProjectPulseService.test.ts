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
      return (
        argv[0] === "log" &&
        argv.includes("--pretty=format:%ct") &&
        argv.some((a) => a.startsWith("--since="))
      );
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
      return (
        argv[0] === "log" &&
        argv.includes("--pretty=format:%ct") &&
        argv.some((a) => a.startsWith("--since="))
      );
    });
    expect(heatmapCalls.length).toBe(2);
  });

  it("includes today in heatmap if commits today", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Commits for today, yesterday, and day before
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

    // Should count today, yesterday, and day before = 3 active days
    expect(pulse.activeDays).toBe(3);
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
    expect(pulse.activeDays).toBe(3);
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

  it.each([
    ["does not have any commits yet", "your current branch 'main' does not have any commits yet"],
    ["not a valid object name", "fatal: not a valid object name: 'HEAD'"],
    ["bad default revision", "fatal: bad default revision 'HEAD'"],
    ["ambiguous argument (original)", "fatal: ambiguous argument 'HEAD': unknown revision"],
    ["unknown revision", "unknown revision or path not in the working tree"],
    ["needed a single revision", "fatal: needed a single revision"],
  ])("returns empty pulse for no-commits error variant: %s", async (_label, errorMessage) => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
        throw new Error(errorMessage);
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-empty",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    expect(pulse.heatmap).toHaveLength(60);
    expect(pulse.commitsInRange).toBe(0);
    expect(pulse.activeDays).toBe(0);
  });

  it("throws for unrecognized rev-parse errors", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
        throw new Error("fatal: some completely unknown error");
      return "";
    });

    vi.doMock("simple-git", () => ({
      simpleGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    await expect(
      svc.getPulse({
        worktreePath: "/repo",
        worktreeId: "wt-err",
        mainBranch: "main",
        rangeDays: 60 as const,
        includeDelta: false,
        includeRecentCommits: false,
      })
    ).rejects.toThrow("Failed to read git HEAD");
  });
});
