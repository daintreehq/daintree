import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// existsSync is a controllable vi.fn so tests that need the worktree path to
// "disappear" mid-run can override it (see the path-missing recompute test).
const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
}));
vi.mock("fs", () => ({
  existsSync: existsSyncMock,
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
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  it("dedupes concurrent requests with same cache key", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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
    expect(pulse.currentStreakDays).toBe(0);
  });

  it("throws for unrecognized rev-parse errors", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
        throw new Error("fatal: some completely unknown error");
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

  it("returns null firstCommitDate and no isBeforeProject cells for shallow clone", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Shallow boundary SHA would be only 5 days old — recent enough to mark
    // most cells as isBeforeProject if we trusted rev-list. The shallow probe
    // must short-circuit before we ever call rev-list.
    const recentDate = new Date(baseTime);
    recentDate.setDate(recentDate.getDate() - 5);

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "true\n";
      if (cmd === "rev-list") return "shallowboundary\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-shallow",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    expect(pulse.heatmap).toHaveLength(60);
    expect(pulse.heatmap.every((cell) => !cell.isBeforeProject)).toBe(true);
    expect(pulse.projectAgeDays).toBe(60);

    // Critical invariant: rev-list must never be called when shallow probe trips.
    const revListCalls = raw.mock.calls.filter(([args]) => (args as string[])[0] === "rev-list");
    expect(revListCalls.length).toBe(0);
  });

  it("renders heatmap cells with commits in shallow clone (regression for #5728)", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Simulate the user-visible symptom from #5728: a long-lived repo cloned shallow.
    // Commits exist across the last 30 days; the heatmap must show them, not collapse
    // to 2 cells because the shallow boundary tricked rev-list into returning a recent SHA.
    const commitTimestamps: number[] = [];
    for (let i = 0; i < 30; i++) {
      const date = new Date(baseTime);
      date.setDate(date.getDate() - i);
      commitTimestamps.push(Math.floor(date.getTime() / 1000));
    }
    const commitOutput = commitTimestamps.join("\n");

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "true\n";
      if (cmd === "rev-list") return "shallowboundary\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-shallow-active",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    expect(pulse.heatmap).toHaveLength(60);
    expect(pulse.commitsInRange).toBe(30);
    expect(pulse.activeDays).toBe(30);
    expect(pulse.heatmap.every((cell) => !cell.isBeforeProject)).toBe(true);
    // Active cells must have count > 0 — the symptom was these getting filtered out entirely.
    const activeCells = pulse.heatmap.filter((cell) => cell.count > 0);
    expect(activeCells.length).toBe(30);
  });

  it("marks early heatmap cells isBeforeProject for non-shallow repo younger than range", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Repo started 20 days ago — half of the 60-day range should be greyed out.
    const firstCommitDate = new Date(baseTime);
    firstCommitDate.setDate(firstCommitDate.getDate() - 20);
    const firstCommitTimestamp = Math.floor(firstCommitDate.getTime() / 1000);

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "false\n";
      if (cmd === "rev-list") return "rootsha\n";
      if (cmd === "log" && args.includes("--format=%ct") && args.includes("rootsha")) {
        return `${firstCommitTimestamp}\n`;
      }
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-young",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    expect(pulse.heatmap).toHaveLength(60);
    // 20 days back + inclusive today = 21 days
    expect(pulse.projectAgeDays).toBe(21);
    expect(pulse.heatmap.some((cell) => cell.isBeforeProject)).toBe(true);
    // Cells in the most recent 21 days should not be marked.
    const recentCells = pulse.heatmap.slice(-21);
    expect(recentCells.every((cell) => !cell.isBeforeProject)).toBe(true);
  });

  it("treats unknown --is-shallow-repository response as non-shallow (old git fallback)", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    // Repo is 300 days old — older than 60-day range, so projectAgeDays should clamp.
    const firstCommitDate = new Date(baseTime);
    firstCommitDate.setDate(firstCommitDate.getDate() - 300);
    const firstCommitTimestamp = Math.floor(firstCommitDate.getTime() / 1000);

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      // Pre-2.15 git echoes back the unknown flag.
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository"))
        return "--is-shallow-repository\n";
      if (cmd === "rev-list") return "rootsha\n";
      if (cmd === "log" && args.includes("--format=%ct") && args.includes("rootsha")) {
        return `${firstCommitTimestamp}\n`;
      }
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulse = await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-oldgit",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // Non-shallow path executed; rev-list was called.
    const revListCalls = raw.mock.calls.filter(([args]) => (args as string[])[0] === "rev-list");
    expect(revListCalls.length).toBeGreaterThan(0);
    // Repo is older than range → clamped.
    expect(pulse.projectAgeDays).toBe(60);
    // No cells marked because firstCommitDate (300 days ago) precedes every cell in the range.
    expect(pulse.heatmap.every((cell) => !cell.isBeforeProject)).toBe(true);
  });

  it("passes AbortSignal to createHardenedGit", async () => {
    let capturedSignal: AbortSignal | undefined;

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: (_cwd: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return createGitStub(raw);
      },
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

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal instanceof AbortSignal).toBe(true);
    expect(capturedSignal!.aborted).toBe(false);
  });

  it("invalidate(worktreeId) aborts active AbortController", async () => {
    let capturedSignal: AbortSignal | undefined;

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        // Stall to keep the computation in-flight; listen for abort on signal
        await new Promise<void>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
        return "deadbeef\n";
      }
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: (_cwd: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return createGitStub(raw);
      },
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulsePromise = svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // Let the computation start and stall
    await vi.advanceTimersByTimeAsync(0);

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    svc.invalidate("wt-1");

    expect(capturedSignal!.aborted).toBe(true);

    // The promise should reject due to the abort
    await expect(pulsePromise).rejects.toThrow("Aborted");
  });

  it("invalidate(worktreeId) clears matching inFlight entries", async () => {
    let capturedSignal: AbortSignal | undefined;

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        await new Promise<void>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
        return "deadbeef\n";
      }
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: (_cwd: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return createGitStub(raw);
      },
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const pulsePromise = svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    await vi.advanceTimersByTimeAsync(0);

    const inFlight = (svc as any).inFlight as Map<string, unknown>;
    expect(inFlight.size).toBeGreaterThan(0);

    svc.invalidate("wt-1");

    expect(inFlight.size).toBe(0);
    await expect(pulsePromise).rejects.toThrow("Aborted");
  });

  it("invalidate(worktreeId) is idempotent", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    // Populate cache
    await svc.getPulse({
      worktreePath: "/repo",
      worktreeId: "wt-1",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // Two back-to-back invalidate calls must not throw
    expect(() => svc.invalidate("wt-1")).not.toThrow();
    expect(() => svc.invalidate("wt-1")).not.toThrow();
  });

  it("invalidate(worktreeId) only affects matching worktree", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    await svc.getPulse({
      worktreePath: "/repo-a",
      worktreeId: "wt-a",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    await svc.getPulse({
      worktreePath: "/repo-b",
      worktreeId: "wt-b",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    svc.invalidate("wt-a");

    // wt-a should recompute (cache miss), wt-b should still be cached.
    // Track heatmap calls — the probe now adds a HEAD read on cache hit,
    // so a raw-count assertion isn't the right shape anymore.
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;

    await svc.getPulse({
      worktreePath: "/repo-a",
      worktreeId: "wt-a",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    const heatmapCallsAfterA = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfterA).toBe(heatmapCallsBefore + 1);

    await svc.getPulse({
      worktreePath: "/repo-b",
      worktreeId: "wt-b",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    });

    // wt-b was cached — probe matches, no heatmap recompute.
    const heatmapCallsAfterB = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfterB).toBe(heatmapCallsAfterA);
  });

  it("serves cached pulse when HEAD-SHA probe matches within TTL", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "sha-aaa\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    await svc.getPulse(opts);
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;

    // Second call within TTL — probe returns same SHA, cache hit served.
    await svc.getPulse(opts);

    const heatmapCallsAfter = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfter).toBe(heatmapCallsBefore);
  });

  it("recomputes within TTL when HEAD-SHA has moved", async () => {
    let currentSha = "sha-aaa";
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
        return `${currentSha}\n`;
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    await svc.getPulse(opts);
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;

    // HEAD moves — next call's probe sees mismatch, falls through to recompute.
    currentSha = "sha-bbb";
    await svc.getPulse(opts);

    const heatmapCallsAfter = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfter).toBe(heatmapCallsBefore + 1);
  });

  it("serves cached empty pulse when repo still has no commits", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
        throw new Error("fatal: ambiguous argument 'HEAD': unknown revision");
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const opts = {
      worktreePath: "/repo",
      worktreeId: "wt-empty",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    };

    const first = await svc.getPulse(opts);
    const callsAfterFirst = raw.mock.calls.length;

    // Second call within TTL: probe also throws no-commits → null === null → serve cached.
    const second = await svc.getPulse(opts);

    expect(second.commitsInRange).toBe(0);
    expect(second.heatmap).toEqual(first.heatmap);
    // Only the probe runs — no recompute (which would call rev-parse again then bail).
    expect(raw.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it("recomputes when HEAD is unchanged but the branch has switched", async () => {
    let currentBranch = "main";
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "sha-aaa\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return `${currentBranch}\n`;
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    await svc.getPulse(opts);
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;

    // `git checkout -b feature` at the same commit: HEAD-SHA is unchanged but
    // the branch name differs. Cache must invalidate so deltaToMain rebuilds.
    currentBranch = "feature";
    await svc.getPulse(opts);

    const heatmapCallsAfter = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfter).toBe(heatmapCallsBefore + 1);
  });

  it("re-checks cache entry after probe to avoid post-invalidation stale read", async () => {
    let probeResolve: ((value: string) => void) | undefined;
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        if (probeResolve) {
          // Suspend the probe so invalidate() can fire mid-await.
          return new Promise<string>((resolve) => {
            probeResolve = resolve;
          });
        }
        return "sha-aaa\n";
      }
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    await svc.getPulse(opts);
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;

    // Arm the probe to suspend on the next sha read.
    probeResolve = () => {};

    const pulsePromise = svc.getPulse(opts);
    await vi.advanceTimersByTimeAsync(0);

    // Probe is now suspended on the SHA call. Invalidate while it's in flight.
    svc.invalidate("wt-1");

    // Release the probe with the same SHA. Without the re-check guard, this
    // would happily return the now-deleted cached pulse.
    probeResolve!("sha-aaa\n");
    probeResolve = undefined;

    await pulsePromise;

    // A recompute MUST have happened — the cached entry was invalidated.
    const heatmapCallsAfter = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfter).toBe(heatmapCallsBefore + 1);
  });

  it("falls through to recompute when the worktree path disappears", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
        throw new Error("fatal: ambiguous argument 'HEAD': unknown revision");
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
    }));

    const { ProjectPulseService } = await import("../ProjectPulseService.js");
    const svc = new ProjectPulseService();

    const opts = {
      worktreePath: "/repo-gone",
      worktreeId: "wt-vanish",
      mainBranch: "main",
      rangeDays: 60 as const,
      includeDelta: false,
      includeRecentCommits: false,
    };

    // First call: empty pulse cached with headSha=null.
    await svc.getPulse(opts);

    // Path disappears before second call. The probe must NOT return null and
    // match the cached empty entry; it must signal "missing" so we recompute
    // and surface the real error from computePulse.
    existsSyncMock.mockReturnValue(false);

    await expect(svc.getPulse(opts)).rejects.toThrow("Worktree path does not exist");
  });

  it("recomputes when HEAD-SHA probe throws an unexpected error", async () => {
    let probeMode: "ok" | "throw" = "ok";
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        if (probeMode === "throw") throw new Error("fatal: some unexpected git failure");
        return "sha-aaa\n";
      }
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    await svc.getPulse(opts);
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;

    // Probe throws → fall through. computePulse will also throw (mock returns
    // same behavior for both calls) so the call rejects; but we just want to
    // verify it didn't short-circuit to the cached value.
    probeMode = "throw";
    await expect(svc.getPulse(opts)).rejects.toThrow();

    // No new heatmap call (computePulse failed at HEAD), but we did go past the cache.
    const heatmapCallsAfter = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfter).toBe(heatmapCallsBefore);
  });

  it("getPulse creates a fresh controller after invalidation", async () => {
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: () => createGitStub(raw),
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

    // Complete a computation, which cleans up its controller
    await svc.getPulse(opts);

    const abortControllers = (svc as any).abortControllers as Map<string, AbortController>;
    // Controller should be deleted by the finally block
    expect(abortControllers.has("wt-1")).toBe(false);

    // Simulate stale controller left by an interrupted computation
    const staleController = new AbortController();
    abortControllers.set("wt-1", staleController);

    // Invalidate should abort and remove the stale controller
    svc.invalidate("wt-1");
    expect(staleController.signal.aborted).toBe(true);
    expect(abortControllers.has("wt-1")).toBe(false);

    // A new getPulse creates a fresh controller
    const pulsePromise = svc.getPulse(opts);
    const freshController = abortControllers.get("wt-1");
    expect(freshController).toBeDefined();
    expect(freshController).not.toBe(staleController);
    expect(freshController!.signal.aborted).toBe(false);

    await pulsePromise;
    // Fresh controller should be cleaned up after successful computation
    expect(abortControllers.has("wt-1")).toBe(false);
  });

  it("does not cache result when aborted during parallel git phase", async () => {
    let capturedSignal: AbortSignal | undefined;

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
        return "deadbeef\n";
      }
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "feature\n";
      // Stall on heatmap log (the first allSettled call) to simulate late abort
      if (cmd === "log" && args.some((a) => a.startsWith("--since="))) {
        await new Promise<void>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
        return "";
      }
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createHardenedGit: (_cwd: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return createGitStub(raw);
      },
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

    const pulsePromise = svc.getPulse(opts);
    await vi.advanceTimersByTimeAsync(0);

    // HEAD + branch resolution completed; now stalled in heatmap
    svc.invalidate("wt-1");

    expect(capturedSignal!.aborted).toBe(true);

    // allSettled absorbs the abort, so the promise resolves with fallback values.
    // The cache guard must prevent writing the fallback result.
    const pulse = await pulsePromise;
    expect(pulse.commitsInRange).toBe(0);

    const cache = (svc as any).cache as Map<string, unknown>;
    expect(cache.size).toBe(0);
  });
});
