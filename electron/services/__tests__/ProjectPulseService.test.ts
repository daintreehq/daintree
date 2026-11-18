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

// The cache probe reads HEAD and the branch in one rev-parse.
function isHeadProbe(args: string[]): boolean {
  return args[0] === "rev-parse" && args[1] === "HEAD" && args[2] === "--abbrev-ref";
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
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
      createStrictExitGit: () => createGitStub(raw),
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

  it.each([
    new Date(2025, 0, 15, 0, 30),
    new Date(2025, 0, 15, 8, 30),
    new Date(2025, 0, 15, 15, 30),
    new Date(2025, 0, 15, 23, 30),
    new Date(2025, 2, 1, 15, 30),
  ])(
    "cuts the heatmap off at local midnight of the oldest day when refreshed at %s",
    async (now) => {
      vi.setSystemTime(now);

      const oldestDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 59);
      const oldestDayKey = `${oldestDay.getFullYear()}-${String(oldestDay.getMonth() + 1).padStart(2, "0")}-${String(oldestDay.getDate()).padStart(2, "0")}`;
      const oldestMidnight = Math.floor(oldestDay.getTime() / 1000);
      const lastSecondBeforeOldestDay = oldestMidnight - 1;
      const morningOfOldestDay = Math.floor(
        new Date(oldestDay.getFullYear(), oldestDay.getMonth(), oldestDay.getDate(), 8).getTime() /
          1000
      );
      const commitTimestamps = [lastSecondBeforeOldestDay, oldestMidnight, morningOfOldestDay];

      const cutoffs: number[] = [];
      const raw = vi.fn(async (args: string[]) => {
        const cmd = args[0];
        if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
          return "deadbeef\n";
        if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
        if (cmd !== "log") return "";

        const sinceArgs = args.filter((a) => a.startsWith("--since="));
        if (sinceArgs.length === 0) return commitTimestamps.join("\n");

        // Mirrors git: a bare calendar date borrows the current time of day, an epoch is exact.
        const resolved = sinceArgs.map((arg) => {
          const value = arg.slice("--since=".length);
          if (/^\d+$/.test(value)) return Number(value);
          const [year, month, day] = value.split("-").map(Number);
          const clock = new Date();
          return Math.floor(
            new Date(
              year,
              month - 1,
              day,
              clock.getHours(),
              clock.getMinutes(),
              clock.getSeconds()
            ).getTime() / 1000
          );
        });
        cutoffs.push(...resolved);
        // Git keeps the last --since it is given.
        const cutoff = resolved[resolved.length - 1];
        return commitTimestamps.filter((timestamp) => timestamp >= cutoff).join("\n");
      });

      vi.doMock("../../utils/hardenedGit.js", () => ({
        createStrictExitGit: () => createGitStub(raw),
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

      // The commit before midnight lands in a day with no cell, so only the cutoff itself shows it
      // was excluded.
      expect(cutoffs).toEqual([oldestMidnight]);
      expect(pulse.heatmap[0].date).toBe(oldestDayKey);
      expect(pulse.heatmap[0].count).toBe(2);
      expect(pulse.commitsInRange).toBe(2);
      expect(pulse.activeDays).toBe(1);
    }
  );

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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-list") return "firstcommit\n";
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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

  // The zero a failed read used to fabricate stays reserved for a read that
  // succeeded and found nothing in range (failures: historyFailure.test.ts).
  it("reports zero activity when the log succeeds with no commits in range", async () => {
    // History exists, all of it older than the window.
    const oldCommit = String(Math.floor(new Date("2024-06-01T12:00:00.000Z").getTime() / 1000));
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "HEAD\n";
      if (cmd === "rev-parse" && args[1] === "--is-shallow-repository") return "false\n";
      if (cmd === "rev-list") return `${oldCommit} rootsha\n`;
      if (cmd === "log" && args.some((a) => a.startsWith("--since="))) return "";
      if (cmd === "log") return `${oldCommit}\n`;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
    expect(pulse.heatmap.every((cell) => cell.count === 0)).toBe(true);
    expect(pulse.commitsInRange).toBe(0);
    expect(pulse.activeDays).toBe(0);
    expect(pulse.currentStreakDays).toBe(0);
    // Not the unborn-repository pulse: the project predates the window.
    expect(pulse.projectAgeDays).toBe(60);
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
      createStrictExitGit: () => createGitStub(raw),
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
      createStrictExitGit: () => createGitStub(raw),
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
    const boundaryTimestamp = Math.floor(recentDate.getTime() / 1000);

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "true\n";
      if (cmd === "rev-list") return `${boundaryTimestamp} shallowboundary\n`;
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
    // A boundary only days old would mark most cells isBeforeProject if the guard were gone.
    const boundaryTimestamp = commitTimestamps[4] as number;

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "true\n";
      if (cmd === "rev-list") return `${boundaryTimestamp} shallowboundary\n`;
      if (cmd === "log") return commitOutput;
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "false\n";
      if (cmd === "rev-list") return `${firstCommitTimestamp} rootsha\n`;
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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

  it("dates the project from the earliest root when rev-list prints several, in any order", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    const daysAgo = (days: number) => {
      const d = new Date(baseTime);
      d.setDate(d.getDate() - days);
      return Math.floor(d.getTime() / 1000);
    };
    // rev-list prints newest first, so the old root is the last line here and the
    // first in the reversed run: neither order may change the answer.
    const orders = [
      [`${daysAgo(5)} newroot`, `${daysAgo(20)} oldroot`],
      [`${daysAgo(20)} oldroot`, `${daysAgo(5)} newroot`],
    ];

    for (const lines of orders) {
      vi.resetModules();
      const raw = vi.fn(async (args: string[]) => {
        const cmd = args[0];
        if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
          return "deadbeef\n";
        if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
        if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "false\n";
        if (cmd === "rev-list") return `${lines.join("\n")}\n`;
        return "";
      });
      vi.doMock("../../utils/hardenedGit.js", () => ({
        createStrictExitGit: () => createGitStub(raw),
      }));

      const { ProjectPulseService } = await import("../ProjectPulseService.js");
      const pulse = await new ProjectPulseService().getPulse({
        worktreePath: "/repo",
        worktreeId: "wt-multi-root",
        mainBranch: "main",
        rangeDays: 60 as const,
        includeDelta: false,
        includeRecentCommits: false,
      });

      // 20 days back + inclusive today = 21 days, from the older root.
      expect(pulse.projectAgeDays).toBe(21);
    }
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
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      // Pre-2.15 git echoes back the unknown flag.
      if (cmd === "rev-parse" && args.includes("--is-shallow-repository"))
        return "--is-shallow-repository\n";
      if (cmd === "rev-list") return `${firstCommitTimestamp} rootsha\n`;
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      createStrictExitGit: (_cwd: string, signal?: AbortSignal) => {
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
      createStrictExitGit: (_cwd: string, signal?: AbortSignal) => {
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

  it("invalidate(worktreeId) only affects matching worktree", async () => {
    const baseTime = new Date("2025-01-15T12:00:00.000Z");
    vi.setSystemTime(baseTime);

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (isHeadProbe(args)) return "deadbeef\nmain\n";
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (isHeadProbe(args)) return "sha-aaa\nmain\n";
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "sha-aaa\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (isHeadProbe(args)) return `${currentSha}\nmain\n`;
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD")
        return `${currentSha}\n`;
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (
        (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") ||
        isHeadProbe(args)
      )
        throw new Error("fatal: ambiguous argument 'HEAD': unknown revision");
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
    expect(second).toBe(first);

    expect(second.commitsInRange).toBe(0);
    expect(second.heatmap).toEqual(first.heatmap);
    // Only the probe runs — no recompute (which would call rev-parse again then bail).
    expect(raw.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it("recomputes when HEAD is unchanged but the branch has switched", async () => {
    let currentBranch = "main";
    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (isHeadProbe(args)) return `sha-aaa\n${currentBranch}\n`;
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "sha-aaa\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return `${currentBranch}\n`;
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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
      if (isHeadProbe(args)) {
        if (probeResolve) {
          // Suspend the probe so invalidate() can fire mid-await.
          return new Promise<string>((resolve) => {
            probeResolve = resolve;
          });
        }
        return "sha-aaa\nmain\n";
      }
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "sha-aaa\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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

    // Probe is now suspended on its read. Invalidate while it's in flight.
    expect(raw.mock.calls.some(([args]) => isHeadProbe(args as string[]))).toBe(true);
    svc.invalidate("wt-1");

    // Release the probe with the same SHA. Without the re-check guard, this
    // would happily return the now-deleted cached pulse.
    probeResolve!("sha-aaa\nmain\n");
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
      createStrictExitGit: () => createGitStub(raw),
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
      if (isHeadProbe(args)) {
        if (probeMode === "throw") throw new Error("fatal: some unexpected git failure");
        return "sha-aaa\nmain\n";
      }
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "sha-aaa\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
      if (cmd === "log") return "";
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: () => createGitStub(raw),
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

    const first = await svc.getPulse(opts);
    const heatmapCallsBefore = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;

    // Only the probe throws: the caller must recompute rather than serve the cached value or
    // surface the probe's error.
    probeMode = "throw";
    const recomputed = await svc.getPulse(opts);

    const heatmapCallsAfter = raw.mock.calls.filter(([args]) => {
      const argv = args as string[];
      return argv[0] === "log" && argv.some((a) => a.startsWith("--since="));
    }).length;
    expect(heatmapCallsAfter).toBe(heatmapCallsBefore + 1);
    expect(recomputed).not.toBe(first);
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
      createStrictExitGit: () => createGitStub(raw),
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
      createStrictExitGit: (_cwd: string, signal?: AbortSignal) => {
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

    // The aborted heatmap read rejects as a cancellation, never as zero commits.
    await expect(pulsePromise).rejects.toThrow("Project pulse read was cancelled");

    const cache = (svc as any).cache as Map<string, unknown>;
    expect(cache.size).toBe(0);
  });

  describe("project age across DST changes (#17454)", () => {
    type Moment = [year: number, monthIndex: number, day: number, hour: number, minute: number];
    const at = ([y, m, d, h, min]: Moment) => new Date(y, m, d, h, min, 0, 0);
    const midnightOf = ([y, m, d]: Moment) => new Date(y, m, d, 0, 0, 0, 0);

    let originalTz: string | undefined;
    let resolvedZone: string | undefined;

    beforeEach(() => {
      originalTz = process.env.TZ;
      resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    });

    afterEach(() => {
      // Deleting an unset TZ does not reset the zone on every platform, so fall back to the resolved name.
      const restore = originalTz ?? resolvedZone;
      if (restore === undefined) delete process.env.TZ;
      else process.env.TZ = restore;
    });

    async function pulseFor(first: Moment, commits: Moment[], today: Moment) {
      vi.setSystemTime(at(today));
      const firstTs = Math.floor(at(first).getTime() / 1000);
      const commitOutput = commits.map((m) => Math.floor(at(m).getTime() / 1000)).join("\n");

      const raw = vi.fn(async (args: string[]) => {
        const cmd = args[0];
        if (cmd === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
        if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
        if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "false\n";
        if (cmd === "rev-list") return `${firstTs} rootsha\n`;
        if (cmd === "log") return commitOutput;
        return "";
      });

      vi.doMock("../../utils/hardenedGit.js", () => ({
        createStrictExitGit: () => createGitStub(raw),
      }));

      const { ProjectPulseService } = await import("../ProjectPulseService.js");
      return new ProjectPulseService().getPulse({
        worktreePath: "/repo",
        worktreeId: "wt-dst",
        mainBranch: "main",
        rangeDays: 60 as const,
        includeDelta: false,
        includeRecentCommits: false,
      });
    }

    // In every case an endpoint sits on a different UTC date than its local date (the New York
    // first commits land a UTC day late, Sydney's today a UTC day early), so counting UTC dates
    // instead of local ones comes up short.
    const cases: Array<{
      name: string;
      zone: string;
      first: Moment;
      commits: Moment[];
      today: Moment;
      midnightGapHours: number;
      ageDays: number;
    }> = [
      {
        name: "spring forward in America/New_York, a commit on each of three dates",
        zone: "America/New_York",
        first: [2026, 2, 7, 20, 30],
        commits: [
          [2026, 2, 7, 20, 30],
          [2026, 2, 8, 12, 0],
          [2026, 2, 9, 10, 0],
        ],
        today: [2026, 2, 9, 10, 0],
        midnightGapHours: 47,
        ageDays: 3,
      },
      {
        name: "fall back in America/New_York, a commit on each of three dates",
        zone: "America/New_York",
        first: [2026, 9, 31, 20, 30],
        commits: [
          [2026, 9, 31, 20, 30],
          [2026, 10, 1, 12, 0],
          [2026, 10, 2, 10, 0],
        ],
        today: [2026, 10, 2, 10, 0],
        midnightGapHours: 49,
        ageDays: 3,
      },
      {
        name: "a span that crosses the spring change but starts days before it",
        zone: "America/New_York",
        first: [2026, 2, 1, 20, 30],
        commits: [
          [2026, 2, 1, 20, 30],
          [2026, 2, 20, 10, 0],
        ],
        today: [2026, 2, 20, 10, 0],
        midnightGapHours: 19 * 24 - 1,
        ageDays: 20,
      },
      {
        name: "spring forward in a southern-hemisphere zone (Australia/Sydney, October)",
        zone: "Australia/Sydney",
        first: [2026, 9, 3, 10, 30],
        commits: [
          [2026, 9, 3, 10, 30],
          [2026, 9, 4, 12, 0],
          [2026, 9, 5, 10, 30],
        ],
        today: [2026, 9, 5, 10, 30],
        midnightGapHours: 47,
        ageDays: 3,
      },
    ];

    it.each(cases)(
      "counts calendar dates, not elapsed hours: $name",
      async ({ zone, first, commits, today, midnightGapHours, ageDays }) => {
        process.env.TZ = zone;
        // Guards the premise: the zone took effect and the midnights are not 24h multiples.
        const gapMs = midnightOf(today).getTime() - midnightOf(first).getTime();
        expect(gapMs / (60 * 60 * 1000)).toBe(midnightGapHours);

        const pulse = await pulseFor(first, commits, today);

        expect(pulse.projectAgeDays).toBe(ageDays);
        expect(pulse.activeDays).toBe(new Set(commits.map(([y, m, d]) => `${y}-${m}-${d}`)).size);
        // The strip and summary render activeDays/projectAgeDays, so the numerator can never exceed it.
        expect(pulse.activeDays).toBeLessThanOrEqual(pulse.projectAgeDays);
        // Cells the heatmap greys out agree with the age: exactly the last `ageDays` cells are live.
        const live = pulse.heatmap.filter((cell) => !cell.isBeforeProject);
        expect(live).toHaveLength(ageDays);
        expect(live.every((cell) => pulse.heatmap.indexOf(cell) >= 60 - ageDays)).toBe(true);
      }
    );
  });

  describe("heatmap past 20,000 commits in the window (#17455)", () => {
    // 2,000 commits on each of the last ten days plus one 100 days ago: 20,001
    // in a 180-day window. The stub ignores --since, so a row 200 days back
    // reaches the parser and checks that rows outside the grid stay out of the
    // totals. Newest first, as `git log` prints them, and the stub applies
    // --max-count= so a ceiling cuts the read where git would.
    function buildBusyRepo() {
      vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0));
      const at = (daysAgo: number, second: number) =>
        Math.floor(new Date(2025, 0, 15 - daysAgo, 10, 0, second).getTime() / 1000);
      const timestamps: number[] = [];
      for (let day = 0; day < 10; day++) {
        for (let i = 0; i < 2_000; i++) timestamps.push(at(day, 2_000 - i));
      }
      timestamps.push(at(100, 0));
      timestamps.push(at(200, 0));

      const raw = vi.fn(async (args: string[]) => {
        const cmd = args[0];
        if (cmd === "rev-parse" && args[1] === "--verify") return "deadbeef\n";
        if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "main\n";
        if (cmd === "rev-parse" && args.includes("--is-shallow-repository")) return "false\n";
        if (cmd === "rev-list" && args.includes("--max-parents=0")) {
          return `${Math.floor(new Date(2020, 0, 1).getTime() / 1000)} rootsha\n`;
        }
        if (cmd === "log") {
          const maxArg = args.find((a) => a.startsWith("--max-count="));
          const max = maxArg ? Number(maxArg.slice("--max-count=".length)) : Infinity;
          return timestamps.slice(0, max).join("\n");
        }
        return "";
      });
      return raw;
    }

    async function loadPulse(raw: (args: string[]) => Promise<string>) {
      vi.doMock("../../utils/hardenedGit.js", () => ({
        createStrictExitGit: () => createGitStub(raw),
      }));
      const { ProjectPulseService } = await import("../ProjectPulseService.js");
      return new ProjectPulseService().getPulse({
        worktreePath: "/repo",
        worktreeId: "wt-busy",
        mainBranch: "main",
        rangeDays: 180 as const,
        includeDelta: false,
        includeRecentCommits: false,
      });
    }

    it("counts every commit in the window, not the first 20,000", async () => {
      const pulse = await loadPulse(buildBusyRepo());

      expect(pulse.commitsInRange).toBe(20_001);
      expect(pulse.activeDays).toBe(11);
      expect(pulse.heatmap.reduce((sum, cell) => sum + cell.count, 0)).toBe(20_001);
    });

    it("shows the oldest busy day as active rather than quiet", async () => {
      const pulse = await loadPulse(buildBusyRepo());

      const counts = pulse.heatmap.map((cell) => cell.count);
      // 179 days back is the first cell; the old commit sits 100 days back.
      expect(counts[179 - 100]).toBe(1);
      expect(counts.slice(-10)).toEqual(Array(10).fill(2_000));
      expect(counts.slice(179 - 99, -10).every((count) => count === 0)).toBe(true);
    });

    it("reads the window without a commit ceiling", async () => {
      // 20,001 commits only rule out a ceiling at 20,000; any fixed ceiling
      // leaves a busier window undercounted the same way.
      const raw = buildBusyRepo();
      await loadPulse(raw);

      const windowReads = raw.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === "log" && args.some((a) => a.startsWith("--since=")));
      expect(windowReads).toHaveLength(1);
      expect(windowReads[0].some((a) => /^(--max-count\b|-n|-\d)/.test(a))).toBe(false);
    });
  });

  it("does not cache a complete pulse whose computation was invalidated", async () => {
    let capturedSignal: AbortSignal | undefined;
    const day = String(Math.floor(new Date("2025-01-14T12:00:00.000Z").getTime() / 1000));

    const raw = vi.fn(async (args: string[]) => {
      const cmd = args[0];
      if (cmd === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") return "deadbeef\n";
      if (cmd === "rev-parse" && args.includes("--abbrev-ref")) return "feature\n";
      if (cmd === "log" && args.some((a) => a.startsWith("--since="))) return `${day}\n`;
      // The streak read finishes only after invalidate(), and finishes cleanly.
      if (cmd === "log") {
        await new Promise<void>((resolve) => {
          capturedSignal?.addEventListener("abort", () => resolve());
        });
        return `${day}\n`;
      }
      return "";
    });

    vi.doMock("../../utils/hardenedGit.js", () => ({
      createStrictExitGit: (_cwd: string, signal?: AbortSignal) => {
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
    svc.invalidate("wt-1");

    const pulse = await pulsePromise;
    expect(pulse.commitsInRange).toBe(1);
    expect(pulse.currentStreakDays).toBe(1);
    expect(((svc as any).cache as Map<string, unknown>).size).toBe(0);
  });
});
