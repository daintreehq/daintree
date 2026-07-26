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
    processCount: 0,
    displayPath: "test",
    section: "recent",
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

    expect(status.text).toBe("2 need input · 1 blocked");
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

    // Both halves count the agents they describe — one of them spelling the
    // number out while the other implied it read as two different measures.
    expect(status.text).toBe("1 needs input · 1 blocked · oldest 42m");
  });

  it("clamps a blocked count that exceeds the waits it is drawn from", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 1, blockedAgentCount: 5 }),
      NOW
    );

    expect(status.text).toBe("1 blocked");
    expect(status.tone).toBe("blocked");
  });

  it("ranks a wait above work in progress", () => {
    const status = getProjectRowStatus(project({ waitingAgentCount: 1, activeAgentCount: 4 }), NOW);

    expect(status.text).toBe("1 needs input");
    expect(status.tone).toBe("waiting");
  });

  it("carries magnitude and the oldest wait's age", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 3, oldestWaitingSince: NOW - 42 * 60_000 }),
      NOW
    );

    expect(status.text).toBe("3 need input · oldest 42m");
  });

  it("drops the 'oldest' qualifier when only one agent waits", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 1, oldestWaitingSince: NOW - 7 * 60_000 }),
      NOW
    );

    expect(status.text).toBe("1 needs input · 7m");
  });

  it("omits the age when no wait timestamp arrived", () => {
    const status = getProjectRowStatus(project({ waitingAgentCount: 2 }), NOW);

    expect(status.text).toBe("2 need input");
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

  it("shows the disambiguating path only when one was needed", () => {
    expect(
      getProjectRowStatus(project({ displayPath: "api", waitingAgentCount: 1 }), NOW).pathHint
    ).toBeUndefined();
    expect(
      getProjectRowStatus(project({ displayPath: "payments/api", waitingAgentCount: 1 }), NOW)
        .pathHint
    ).toBe("payments/api");
  });

  it("does not repeat the path when the path is already the status", () => {
    // Nothing running and never opened: the line falls back to the path itself,
    // so a trailing copy of it would just be the same string twice.
    const status = getProjectRowStatus(
      project({ displayPath: "payments/api", lastOpened: 0 }),
      NOW
    );

    expect(status.text).toBe("payments/api");
    expect(status.pathHint).toBeUndefined();
  });
});
