import { describe, it, expect } from "vitest";
import type { HeatCell, ProjectPulse, PulseRangeDays } from "@shared/types";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";
import { getCoachLine, getCoachSignal, getUsableHealth } from "../coachLine";

// #11172: coaching is framed around what landed, never around commit
// obligations, and no branch may express failure. Precedence and data selection
// are asserted on the signal so rewording the copy can't redden them; the copy
// itself is held to a policy, not to exact strings.

function cell(daysAgo: number, count: number, isToday = false): HeatCell {
  const date = new Date(Date.UTC(2026, 0, 20) - daysAgo * 86_400_000);
  return {
    date: date.toISOString().slice(0, 10),
    count,
    level: Math.min(4, count) as HeatCell["level"],
    ...(isToday ? { isToday: true } : {}),
  };
}

function makePulse(overrides: Partial<ProjectPulse> = {}): ProjectPulse {
  return {
    worktreeId: "wt-1",
    worktreePath: "/repo",
    mainBranch: "main",
    rangeDays: 60,
    generatedAt: 0,
    heatmap: [],
    commitsInRange: 0,
    activeDays: 0,
    projectAgeDays: 400,
    recentCommits: [],
    ...overrides,
  };
}

function makeHealth(overrides: Partial<ForgeProjectHealthPayload> = {}): ForgeProjectHealthPayload {
  return {
    ciStatus: "success",
    issueCount: 0,
    prCount: 0,
    latestRelease: null,
    securityAlerts: { visible: false, count: 0 },
    mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
    repoUrl: "https://github.com/acme/repo",
    hasRemote: true,
    loading: false,
    ...overrides,
  };
}

function withMerges(
  counts: Partial<Record<PulseRangeDays, number>>,
  overrides: Partial<ForgeProjectHealthPayload> = {}
): ForgeProjectHealthPayload {
  return makeHealth({
    mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0, ...counts } },
    ...overrides,
  });
}

// A busy week AND a live streak — the conditions the old copy turned into commit
// pressure. Pairing this with merge data proves outcomes outrank activity.
const ACTIVE_PULSE = makePulse({
  heatmap: [cell(3, 4), cell(2, 2), cell(1, 5), cell(0, 3, true)],
  currentStreakDays: 12,
});

const QUIET_PULSE = makePulse({
  heatmap: [cell(3, 0), cell(2, 0), cell(1, 0), cell(0, 0, true)],
  currentStreakDays: 0,
});

describe("getCoachSignal — outcomes outrank activity", () => {
  it("picks the merge outcome over today's commits and a live streak", () => {
    expect(getCoachSignal(ACTIVE_PULSE, withMerges({ 60: 7 }))).toStrictEqual({
      kind: "merged",
      count: 7,
      rangeDays: 60,
    });
  });

  it("reads the merge count for the range the snapshot is showing", () => {
    const health = withMerges({ 60: 3, 120: 9, 180: 40 });
    for (const [rangeDays, count] of [
      [60, 3],
      [120, 9],
      [180, 40],
    ] as const) {
      expect(getCoachSignal(makePulse({ rangeDays }), health)).toStrictEqual({
        kind: "merged",
        count,
        rangeDays,
      });
    }
  });
});

describe("getCoachSignal — degrading without usable merge data", () => {
  const UNUSABLE: [string, ForgeProjectHealthPayload | null][] = [
    ["no health yet", null],
    ["a provider error", withMerges({ 60: 5 }, { error: "rate limited" })],
    ["no remote", withMerges({ 60: 5 }, { hasRemote: false, repoUrl: "" })],
    ["a blank repo url", withMerges({ 60: 5 }, { repoUrl: "" })],
  ];

  // Every candidate carries a positive merge count, so the only thing deciding
  // whether an outcome is claimed is the usability gate itself.
  it.each(UNUSABLE)("never claims an outcome from %s", (_label, health) => {
    expect(getUsableHealth(health)).toBeNull();
    expect(getCoachSignal(ACTIVE_PULSE, health).kind).not.toBe("merged");
  });

  it("never claims an outcome from a zero merge count", () => {
    // Zero is ambiguous — the provider zero-fills when its velocity query fails.
    expect(getCoachSignal(ACTIVE_PULSE, withMerges({ 60: 0 })).kind).not.toBe("merged");
  });

  it("falls to today, then the recent window, then quiet", () => {
    expect(getCoachSignal(ACTIVE_PULSE, null).kind).toBe("today");

    const quietToday = makePulse({ heatmap: [cell(3, 4), cell(0, 0, true)] });
    expect(getCoachSignal(quietToday, null).kind).toBe("recent");

    expect(getCoachSignal(QUIET_PULSE, null).kind).toBe("quiet");
  });
});

describe("getCoachSignal — recency is dated, not positional", () => {
  it("does not count activity older than the window as recent", () => {
    // The last 7 array entries are NOT the last 7 days. These commits are 8 and
    // 9 days old; reading the tail of the array would call them "recent".
    const stale = makePulse({
      heatmap: [cell(9, 6), cell(8, 4), cell(0, 0, true)],
    });
    expect(getCoachSignal(stale, null).kind).toBe("quiet");
  });

  it("counts activity inside the window, right up to its edge", () => {
    const edge = makePulse({ heatmap: [cell(6, 2), cell(0, 0, true)] });
    expect(getCoachSignal(edge, null).kind).toBe("recent");

    const justOutside = makePulse({ heatmap: [cell(7, 2), cell(0, 0, true)] });
    expect(getCoachSignal(justOutside, null).kind).toBe("quiet");
  });

  it("does not count a cell dated after today as recent activity", () => {
    // Clock skew or a bad fixture — a future cell is not evidence of work done.
    const future = makePulse({ heatmap: [cell(0, 0, true), cell(-2, 5)] });
    expect(getCoachSignal(future, null).kind).toBe("quiet");
  });

  it("stays quiet when no cell is dated today, rather than guessing", () => {
    // Without an isToday cell there is no way to date the activity, and a stale
    // trailing cell must not be reported as today's.
    const undated = makePulse({ heatmap: [cell(9, 6), cell(8, 4)] });
    expect(getCoachSignal(undated, null).kind).toBe("quiet");
  });
});

describe("getCoachLine — copy policy", () => {
  const EVERY_LINE = [
    getCoachLine(ACTIVE_PULSE, withMerges({ 60: 7 })),
    getCoachLine(makePulse(), withMerges({ 60: 1 })),
    getCoachLine(ACTIVE_PULSE, null),
    getCoachLine(makePulse({ heatmap: [cell(3, 4), cell(0, 0, true)] }), null),
    getCoachLine(QUIET_PULSE, null),
    getCoachLine(makePulse({ ...QUIET_PULSE, currentStreakDays: 45 }), null),
  ];

  // Every line the retired ladder could produce. The guard has to reject all of
  // them, or it isn't guarding anything.
  const RETIRED_COPY = [
    "3 commits today — nice.",
    "One small commit today keeps your streak going.",
    "Momentum's building: 2 active days this week.",
    "Make a tiny win: ship one small change today.",
  ];

  // Streak leverage, imperatives, and the praise that made a commit count feel
  // like a score. This is a regression guard on known-bad vocabulary, not a
  // proof of calmness — it can't catch every way copy could turn into pressure.
  // The invariance tests below are what actually pin the behaviour down.
  const FORBIDDEN =
    /\b(streak|missed|keeps?|maintain|must|should|need to|have to|make|ship|win|momentum|nice|tiny|don't)\b/i;

  it("rejects every line the old ladder could produce", () => {
    for (const retired of RETIRED_COPY) {
      expect(retired).toMatch(FORBIDDEN);
    }
  });

  it("uses no obligation, guilt, or praise vocabulary in any branch", () => {
    for (const line of EVERY_LINE) {
      expect(line).not.toMatch(FORBIDDEN);
    }
  });

  it("never asks for a commit, or mentions commits at all", () => {
    // A commit count measures how busy the agents were, not how the day went.
    for (const line of EVERY_LINE) {
      expect(line.toLowerCase()).not.toContain("commit");
    }
  });

  it("says something in every branch", () => {
    for (const line of EVERY_LINE) {
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it("says the same thing whether or not a streak is running", () => {
    // A streak must not be able to change the coaching — that's what made the
    // old copy leverage rather than encouragement.
    const withStreak = makePulse({ ...QUIET_PULSE, currentStreakDays: 45 });
    expect(getCoachLine(withStreak, null)).toBe(getCoachLine(QUIET_PULSE, null));
  });

  it("does not vary the activity lines with the amount of activity", () => {
    // The old weekly line embedded an active-day count, which turned the heatmap
    // into a score. Busier weeks must read identically.
    const oneDay = makePulse({ heatmap: [cell(3, 1), cell(0, 0, true)] });
    const fiveDays = makePulse({
      heatmap: [cell(5, 9), cell(4, 7), cell(3, 8), cell(2, 6), cell(1, 9), cell(0, 0, true)],
    });
    expect(getCoachLine(oneDay, null)).toBe(getCoachLine(fiveDays, null));

    const busyToday = makePulse({ heatmap: [cell(0, 40, true)] });
    const quietToday = makePulse({ heatmap: [cell(0, 1, true)] });
    expect(getCoachLine(busyToday, null)).toBe(getCoachLine(quietToday, null));
  });

  it("reports the merge count and range it selected", () => {
    // The one branch that is allowed to carry numbers — they're the outcome.
    const line = getCoachLine(makePulse({ rangeDays: 180 }), withMerges({ 180: 12 }));
    expect(line).toContain("12");
    expect(line).toContain("180");
  });

  it("agrees with itself on singular and plural", () => {
    const one = getCoachLine(makePulse(), withMerges({ 60: 1 }));
    const two = getCoachLine(makePulse(), withMerges({ 60: 2 }));

    // Pluralization must change something beyond the digit — swapping the count
    // in the singular line can't reproduce the plural one. Catches "1 changes".
    expect(one.replace("1", "2")).not.toBe(two);
    expect(one).toMatch(/\b1 [a-z]+\b(?<!s)/);
    expect(two).toMatch(/\b2 [a-z]+s\b/);
  });

  it("stays forge-neutral rather than borrowing GitHub's vocabulary", () => {
    expect(getCoachLine(makePulse(), withMerges({ 60: 5 })).toLowerCase()).not.toContain(
      "pull request"
    );
  });
});

describe("getUsableHealth", () => {
  it("passes through only health that can back a claim", () => {
    const ok = makeHealth();
    expect(getUsableHealth(ok)).toBe(ok);
    expect(getUsableHealth(null)).toBeNull();
    expect(getUsableHealth(makeHealth({ error: "boom" }))).toBeNull();
    expect(getUsableHealth(makeHealth({ repoUrl: "" }))).toBeNull();
  });
});
