import { describe, it, expect } from "vitest";
import type { HeatCell, ProjectPulse, PulseRangeDays } from "@shared/types";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";
import { getCoachLine, getUsableHealth } from "../coachLine";

// #11172: coaching is framed around what shipped, never around commit
// obligations, and no branch may express failure. Commit counts in Daintree
// mostly measure how busy the agents were.

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

function withMerges(counts: Partial<Record<PulseRangeDays, number>>): ForgeProjectHealthPayload {
  return makeHealth({
    mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0, ...counts } },
  });
}

// A busy week AND a live streak — the conditions the old copy used to turn into
// commit pressure. Every test that pairs this with merge data proves outcomes
// outrank activity.
const ACTIVE_PULSE = makePulse({
  heatmap: [cell(3, 4), cell(2, 2), cell(1, 5), cell(0, 3, true)],
  currentStreakDays: 12,
});

const QUIET_PULSE = makePulse({
  heatmap: [cell(3, 0), cell(2, 0), cell(1, 0), cell(0, 0, true)],
  currentStreakDays: 0,
});

describe("getCoachLine — outcomes lead", () => {
  it("reports merged changes ahead of today's commits and a live streak", () => {
    const line = getCoachLine(ACTIVE_PULSE, withMerges({ 60: 7 }));
    expect(line).toContain("7 changes merged");
    expect(line).not.toContain("activity today");
  });

  it("reads the merge count for the range the snapshot is showing", () => {
    const health = withMerges({ 60: 3, 120: 9, 180: 40 });
    expect(getCoachLine(makePulse({ rangeDays: 60 }), health)).toContain("3 changes");
    expect(getCoachLine(makePulse({ rangeDays: 120 }), health)).toContain("9 changes");
    expect(getCoachLine(makePulse({ rangeDays: 180 }), health)).toContain("40 changes");
  });

  it("names the range it is reporting over", () => {
    expect(getCoachLine(makePulse({ rangeDays: 180 }), withMerges({ 180: 12 }))).toContain(
      "last 180 days"
    );
  });

  it("agrees with itself on singular and plural", () => {
    expect(getCoachLine(makePulse(), withMerges({ 60: 1 }))).toContain("1 change merged");
    expect(getCoachLine(makePulse(), withMerges({ 60: 2 }))).toContain("2 changes merged");
  });

  it("stays forge-neutral rather than naming GitHub's vocabulary", () => {
    const line = getCoachLine(makePulse(), withMerges({ 60: 5 }));
    expect(line.toLowerCase()).not.toContain("pull request");
  });
});

describe("getCoachLine — degrading without usable merge data", () => {
  const UNUSABLE: [string, ForgeProjectHealthPayload | null][] = [
    ["no health yet", null],
    ["a provider error", makeHealth({ error: "rate limited" })],
    ["no remote", makeHealth({ hasRemote: false, repoUrl: "" })],
    ["a blank repo url", makeHealth({ repoUrl: "" })],
  ];

  it.each(UNUSABLE)("falls back to activity on %s, never claiming an outcome", (_label, health) => {
    const line = getCoachLine(ACTIVE_PULSE, health);
    expect(line).not.toContain("merged");
    expect(line.trim().length).toBeGreaterThan(0);
  });

  it("never claims an outcome from a zero merge count", () => {
    // Zero is ambiguous — the provider zero-fills when its velocity query fails.
    expect(getCoachLine(ACTIVE_PULSE, withMerges({ 60: 0 }))).not.toContain("merged");
  });

  it("mentions today when today has commits", () => {
    expect(getCoachLine(ACTIVE_PULSE, null)).toContain("today");
  });

  it("falls back to the week when today is quiet but the week wasn't", () => {
    const pulse = makePulse({ heatmap: [cell(3, 4), cell(2, 0), cell(1, 0), cell(0, 0, true)] });
    const line = getCoachLine(pulse, null);
    expect(line).toContain("this week");
    expect(line).not.toContain("today");
  });

  it("stays calm when nothing has happened at all", () => {
    expect(getCoachLine(QUIET_PULSE, null).trim().length).toBeGreaterThan(0);
  });

  it("does not treat a stale trailing cell as today", () => {
    // No cell carries isToday — the old code fell back to the last cell and
    // reported its commits as today's.
    const pulse = makePulse({ heatmap: [cell(9, 6), cell(8, 4)] });
    expect(getCoachLine(pulse, null)).not.toContain("today");
  });
});

describe("getCoachLine — cannot express guilt or failure", () => {
  const SCENARIOS: [string, ProjectPulse, ForgeProjectHealthPayload | null][] = [
    ["shipped work", ACTIVE_PULSE, withMerges({ 60: 7 })],
    ["active today", ACTIVE_PULSE, null],
    ["active this week", makePulse({ heatmap: [cell(3, 4), cell(0, 0, true)] }), null],
    ["fully quiet", QUIET_PULSE, null],
    ["quiet but mid-streak", makePulse({ ...QUIET_PULSE, currentStreakDays: 30 }), null],
  ];

  // The old line was "One small commit today keeps your streak going." — an
  // obligation triggered precisely by having a streak to lose.
  const FORBIDDEN = /\b(streak|missed|keep|keeps|must|should|don't lose|maintain)\b/i;

  it.each(SCENARIOS)("%s: no obligation or failure vocabulary", (_label, pulse, health) => {
    expect(getCoachLine(pulse, health)).not.toMatch(FORBIDDEN);
  });

  it("never asks for a commit", () => {
    for (const [, pulse, health] of SCENARIOS) {
      expect(getCoachLine(pulse, health).toLowerCase()).not.toContain("commit");
    }
  });

  it("says the same thing whether or not a streak is running", () => {
    // A streak must not be able to change the coaching — that's what made the
    // old copy leverage rather than encouragement.
    const withStreak = makePulse({ ...QUIET_PULSE, currentStreakDays: 45 });
    expect(getCoachLine(withStreak, null)).toBe(getCoachLine(QUIET_PULSE, null));
  });
});

describe("getUsableHealth", () => {
  it("passes through only health that can back a merge claim", () => {
    const ok = makeHealth();
    expect(getUsableHealth(ok)).toBe(ok);
    expect(getUsableHealth(null)).toBeNull();
    expect(getUsableHealth(makeHealth({ error: "boom" }))).toBeNull();
    expect(getUsableHealth(makeHealth({ repoUrl: "" }))).toBeNull();
  });

  it("gates the coach line on exactly what it gates the chips on", () => {
    // The card renders HealthSignals off this same call. If the two ever
    // diverged, the line could claim merges above an error hint.
    for (const health of [
      makeHealth(),
      makeHealth({ error: "boom" }),
      makeHealth({ repoUrl: "" }),
      null,
    ]) {
      const claimsMerges = getCoachLine(makePulse(), withMergesFrom(health)).includes("merged");
      expect(claimsMerges).toBe(getUsableHealth(health) !== null);
    }
  });
});

// Give every candidate a positive merge count, so the only thing deciding
// whether the line claims an outcome is the usability gate itself.
function withMergesFrom(health: ForgeProjectHealthPayload | null) {
  if (health === null) return null;
  return { ...health, mergeVelocity: { mergedCounts: { 60: 5, 120: 5, 180: 5 } } };
}
