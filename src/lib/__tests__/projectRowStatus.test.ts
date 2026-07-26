import { describe, it, expect } from "vitest";
import { getProjectRowStatus, formatWaitAge } from "../projectRowStatus";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

const NOW = 1_700_000_000_000;

function project(overrides: Partial<SearchableProject> = {}): SearchableProject {
  return {
    id: "p1",
    name: "Test",
    path: "/code/test",
    emoji: "🌲",
    lastOpened: 0,
    status: "closed",
    isActive: false,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    frecencyScore: 3,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    processCount: 0,
    displayPath: "test",
    section: "other",
    ...overrides,
  };
}

describe("formatWaitAge", () => {
  it("reads sub-minute waits as just now", () => {
    expect(formatWaitAge(NOW - 30_000, NOW)).toBe("just now");
  });

  it("uses minutes, then hours, then days", () => {
    expect(formatWaitAge(NOW - 42 * 60_000, NOW)).toBe("42m");
    expect(formatWaitAge(NOW - 60 * 60_000, NOW)).toBe("1h");
    expect(formatWaitAge(NOW - 95 * 60_000, NOW)).toBe("1h 35m");
    expect(formatWaitAge(NOW - 50 * 3600_000, NOW)).toBe("2d");
  });

  it("never reports a negative age from a clock skew", () => {
    expect(formatWaitAge(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("getProjectRowStatus", () => {
  it("reports blocked and plain waits together, never one instead of the other", () => {
    // Blocked is a SUBSET of waiting. Reporting only the blocked agent would
    // hide two others that are still asking the user for something.
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 3, blockedAgentCount: 1, activeAgentCount: 2 }),
      NOW
    );

    expect(status.text).toBe("2 agents need input · 1 blocked");
    expect(status.tone).toBe("blocked");
  });

  it("dates the wait, not the block", () => {
    // `oldestWaitingSince` spans every wait, blocked or not, so labelling it as
    // the block's age would date a fresh block by an older prompt's clock.
    const status = getProjectRowStatus(
      project({
        waitingAgentCount: 2,
        blockedAgentCount: 1,
        oldestWaitingSince: NOW - 42 * 60_000,
      }),
      NOW
    );

    expect(status.text).toBe("Agent needs input · 1 blocked · oldest waiting 42m");
  });

  it("clamps a blocked count that exceeds the waits it is drawn from", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 1, blockedAgentCount: 5 }),
      NOW
    );

    expect(status.text).toBe("Agent blocked");
    expect(status.tone).toBe("blocked");
  });

  it("ranks a wait above work in progress", () => {
    const status = getProjectRowStatus(project({ waitingAgentCount: 1, activeAgentCount: 4 }), NOW);

    expect(status.text).toBe("Agent needs input");
    expect(status.tone).toBe("waiting");
  });

  it("carries magnitude and the oldest wait's age", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 3, oldestWaitingSince: NOW - 42 * 60_000 }),
      NOW
    );

    expect(status.text).toBe("3 agents need input · oldest waiting 42m");
  });

  it("drops the 'oldest' qualifier when only one agent waits", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 1, oldestWaitingSince: NOW - 7 * 60_000 }),
      NOW
    );

    expect(status.text).toBe("Agent needs input · waiting 7m");
  });

  it("omits the age when no wait timestamp arrived", () => {
    const status = getProjectRowStatus(project({ waitingAgentCount: 2 }), NOW);

    expect(status.text).toBe("2 agents need input");
  });

  it("reads a fresh unseen completion as just finished", () => {
    const status = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 3 * 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 3 * 60_000,
      }),
      NOW
    );

    expect(status.text).toBe("Ready for review · just finished 3m ago");
    expect(status.tone).toBe("review");
  });

  it("keeps 'just' right up to the freshness boundary and drops it at the boundary", () => {
    // Fixed behavioral inputs, deliberately not derived from the production
    // constant: a completion 14 minutes old is still "just finished", one 15
    // minutes old is not. Catches both a shifted boundary and < becoming <=.
    const fresh = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 14 * 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 14 * 60_000,
      }),
      NOW
    );
    expect(fresh.text).toBe("Ready for review · just finished 14m ago");

    const boundary = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 15 * 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 15 * 60_000,
      }),
      NOW
    );
    expect(boundary.text).toBe("Ready for review · finished 15m ago");

    const stale = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 16 * 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 16 * 60_000,
      }),
      NOW
    );
    expect(stale.text).toBe("Ready for review · finished 16m ago");
  });

  it("elides the redundant timestamp on a seconds-old completion", () => {
    const status = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 10_000,
        oldestUnacknowledgedCompletionAt: NOW - 10_000,
      }),
      NOW
    );

    // "just finished just now ago" is not a sentence.
    expect(status.text).toBe("Ready for review · just finished");
  });

  it("ranges multiple unseen completions newest to oldest", () => {
    const status = getProjectRowStatus(
      project({
        completedAgentCount: 3,
        unacknowledgedCompletedAgentCount: 3,
        latestUnacknowledgedCompletionAt: NOW - 3 * 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 2 * 3600_000,
      }),
      NOW
    );

    expect(status.text).toBe("3 agents ready for review · 3m–2h ago");
    expect(status.tone).toBe("review");
  });

  it("renders a swapped range newest-first anyway", () => {
    // A malformed payload with latest < oldest must not read "2h–3m ago".
    const status = getProjectRowStatus(
      project({
        completedAgentCount: 2,
        unacknowledgedCompletedAgentCount: 2,
        latestUnacknowledgedCompletionAt: NOW - 2 * 3600_000,
        oldestUnacknowledgedCompletionAt: NOW - 3 * 60_000,
      }),
      NOW
    );

    expect(status.text).toBe("2 agents ready for review · 3m–2h ago");
  });

  it("collapses the range when completions round to the same age", () => {
    const status = getProjectRowStatus(
      project({
        completedAgentCount: 2,
        unacknowledgedCompletedAgentCount: 2,
        latestUnacknowledgedCompletionAt: NOW - 8 * 60_000 - 10_000,
        oldestUnacknowledgedCompletionAt: NOW - 8 * 60_000 - 50_000,
      }),
      NOW
    );

    expect(status.text).toBe("2 agents ready for review · 8m ago");
  });

  it("ranks a wait above a completion, and a completion above running work", () => {
    const waiting = getProjectRowStatus(
      project({
        waitingAgentCount: 1,
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 60_000,
      }),
      NOW
    );
    expect(waiting.tone).toBe("waiting");

    const review = getProjectRowStatus(
      project({
        activeAgentCount: 4,
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 60_000,
      }),
      NOW
    );
    expect(review.tone).toBe("review");
    expect(review.text).toContain("Ready for review");
  });

  it("mutes an acknowledged completion and drops the action phrase", () => {
    const status = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 0,
        latestCompletionAt: NOW - 2 * 3600_000,
      }),
      NOW
    );

    expect(status.text).toBe("Agent finished · 2h ago");
    expect(status.tone).toBe("muted");
  });

  it("counts acknowledged completions and dates the latest", () => {
    const status = getProjectRowStatus(
      project({
        completedAgentCount: 3,
        unacknowledgedCompletedAgentCount: 0,
        latestCompletionAt: NOW - 2 * 3600_000,
      }),
      NOW
    );

    expect(status.text).toBe("3 agents finished · latest 2h ago");
  });

  it("ranks running work above acknowledged completions", () => {
    const status = getProjectRowStatus(
      project({
        activeAgentCount: 1,
        completedAgentCount: 2,
        unacknowledgedCompletedAgentCount: 0,
        latestCompletionAt: NOW - 3600_000,
      }),
      NOW
    );

    expect(status.text).toBe("Agent running");
    expect(status.tone).toBe("working");
  });

  it("distinguishes agents from bare processes", () => {
    expect(getProjectRowStatus(project({ activeAgentCount: 2 }), NOW).text).toBe(
      "2 agents running"
    );
    expect(getProjectRowStatus(project({ processCount: 1 }), NOW).text).toBe("Process running");
  });

  it("puts a missing directory above everything else", () => {
    const status = getProjectRowStatus(
      project({ isMissing: true, waitingAgentCount: 5, blockedAgentCount: 2 }),
      NOW
    );

    expect(status.text).toBe("Directory not found");
  });

  it("names the auto-park reason instead of showing a bare time-ago", () => {
    const status = getProjectRowStatus(
      project({ status: "closed", autoParkedAt: NOW - 1000, lastOpened: NOW - 5000 }),
      NOW
    );

    expect(status.text).toBe("Suspended to free memory");
  });

  it("labels the fallback timestamp as an opened time, not a sort key", () => {
    // The browse band is frecency-ordered, so a bare "2h ago" read as the
    // ordering it isn't. The verb pins the fact to the row.
    const status = getProjectRowStatus(project({ lastOpened: NOW - 2 * 3600_000 }), NOW);

    expect(status.text).toMatch(/^Opened /);
    expect(status.tone).toBe("muted");
  });

  it("names the next step for a never-opened project instead of echoing its path", () => {
    const status = getProjectRowStatus(
      project({ displayPath: "payments/api", lastOpened: 0 }),
      NOW
    );

    expect(status.text).toBe("Not opened yet");
    // The path still rides along as the disambiguating hint when needed.
    expect(status.pathHint).toBe("payments/api");
  });

  it("shows the disambiguating path only when one was needed", () => {
    expect(
      getProjectRowStatus(project({ displayPath: "api", waitingAgentCount: 1 }), NOW).pathHint
    ).toBeUndefined();
    expect(
      getProjectRowStatus(project({ displayPath: "payments/api", waitingAgentCount: 1 }), NOW)
        .pathHint
    ).toBe("payments/api");
  });
});
