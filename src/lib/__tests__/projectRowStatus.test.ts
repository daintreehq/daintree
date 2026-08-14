import { describe, it, expect } from "vitest";
import { getProjectRowStatus, getScratchRowStatus, formatWaitAge } from "../projectRowStatus";
import type { SearchableProject, SearchableScratch } from "@/hooks/useProjectSwitcherPalette";

const NOW = 1_700_000_000_000;

function scratch(overrides: Partial<SearchableScratch> = {}): SearchableScratch {
  return {
    id: "s1",
    name: "Scratch",
    path: "/userData/scratches/s1",
    createdAt: 0,
    lastOpened: 0,
    isActive: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    processCount: 0,
    ...overrides,
  };
}

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
    snoozedAgentCount: 0,
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
        snoozedAgentCount: 0,
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
        snoozedAgentCount: 0,
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
        snoozedAgentCount: 0,
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
    expect(status.isDormantFallback).toBe(true);
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

  // The flag decides whether a row keeps its second line at all, so what it
  // must NOT catch matters more than what it does. "Agent finished" and
  // "Suspended to free memory" are muted too — a tone check would take them
  // down with the timestamps, which is the bug this field exists to avoid.
  it("flags only the opened-time fallback, never the other muted states", () => {
    const dormant = [
      project({ lastOpened: NOW - 2 * 3600_000 }),
      project({ lastOpened: 0 }),
      // Closed, but swept by nothing — no auto-park marker, so it falls all the
      // way through to the fallback.
      project({ status: "closed", lastOpened: NOW - 2 * 3600_000 }),
    ];
    for (const row of dormant) {
      expect(getProjectRowStatus(row, NOW).isDormantFallback).toBe(true);
    }

    const reportable = [
      project({ status: "closed", autoParkedAt: NOW - 1000, lastOpened: NOW - 5000 }),
      project({ completedAgentCount: 1, latestCompletionAt: NOW - 2 * 3600_000 }),
      project({ isMissing: true }),
      project({ waitingAgentCount: 1 }),
      project({ activeAgentCount: 1 }),
      project({ processCount: 1 }),
    ];
    for (const row of reportable) {
      const status = getProjectRowStatus(row, NOW);
      expect(status.isDormantFallback).toBeUndefined();
      // Guards the pairing the switcher relies on: anything unflagged still has
      // a sentence to print, so hiding the flagged ones can't blank a row.
      expect(status.text.length).toBeGreaterThan(0);
    }

    // Two of the reportable rows are muted. If that stopped being true the test
    // above would pass while proving nothing.
    expect(getProjectRowStatus(reportable[0]!, NOW).tone).toBe("muted");
    expect(getProjectRowStatus(reportable[1]!, NOW).tone).toBe("muted");
  });

  // The hint disambiguates two projects sharing a folder name, so it is part of
  // the row's identity rather than its status — it has to survive the flag that
  // takes the status line away.
  it("keeps the path hint on a dormant project", () => {
    const status = getProjectRowStatus(
      project({ displayPath: "payments/api", lastOpened: NOW - 2 * 3600_000 }),
      NOW
    );

    expect(status.isDormantFallback).toBe(true);
    expect(status.pathHint).toBe("payments/api");
  });
});

describe("getScratchRowStatus", () => {
  // The point of the shared core: a scratch and a project holding the same
  // agent activity must read identically. Driving both from one field set
  // catches a divergence introduced in either wrapper.
  const ACTIVITY_CASES: Array<[string, Partial<SearchableScratch>]> = [
    ["a plain wait", { waitingAgentCount: 1, oldestWaitingSince: NOW - 5 * 60_000 }],
    ["a wait with a blocked subset", { waitingAgentCount: 3, blockedAgentCount: 1 }],
    ["blocked without waiting", { blockedAgentCount: 2 }],
    [
      "one unreviewed completion",
      { unacknowledgedCompletedAgentCount: 1, latestUnacknowledgedCompletionAt: NOW - 60_000 },
    ],
    [
      "several unreviewed completions",
      {
        unacknowledgedCompletedAgentCount: 3,
        oldestUnacknowledgedCompletionAt: NOW - 2 * 3600_000,
        latestUnacknowledgedCompletionAt: NOW - 3 * 60_000,
      },
    ],
    ["running agents", { activeAgentCount: 2 }],
    ["acknowledged completions", { completedAgentCount: 2, latestCompletionAt: NOW - 60_000 }],
    ["bare processes", { processCount: 1 }],
  ];

  it.each(ACTIVITY_CASES)("matches the project line for %s", (_label, activity) => {
    const scratchStatus = getScratchRowStatus(scratch(activity), NOW);
    const projectStatus = getProjectRowStatus(project(activity), NOW);

    expect(scratchStatus.text).toBe(projectStatus.text);
    expect(scratchStatus.tone).toBe(projectStatus.tone);
    // Shared core, shared verdict on whether the line is worth showing — a
    // scratch and a project holding the same activity must not disagree about
    // which of them gets a second line.
    expect(scratchStatus.isDormantFallback).toBe(projectStatus.isDormantFallback);
  });

  it("falls back to the opened time when nothing is running", () => {
    const status = getScratchRowStatus(scratch({ lastOpened: NOW - 2 * 3600_000 }), NOW);

    expect(status.text).toMatch(/^Opened /);
    expect(status.tone).toBe("muted");
    expect(status.isDormantFallback).toBe(true);
  });

  it("names the never-opened state rather than showing a bare age", () => {
    const status = getScratchRowStatus(scratch({ lastOpened: 0 }), NOW);

    expect(status.text).toBe("Not opened yet");
    expect(status.isDormantFallback).toBe(true);
  });

  // A scratch path is a UUID under the app's own directory, so a fragment of
  // it disambiguates nothing and would only add noise to the row.
  it("never carries a path hint", () => {
    for (const [, activity] of ACTIVITY_CASES) {
      expect(getScratchRowStatus(scratch(activity), NOW).pathHint).toBeUndefined();
    }
    expect(getScratchRowStatus(scratch({ lastOpened: 0 }), NOW).pathHint).toBeUndefined();
  });

  // Activity outranks the dormant fallback: a scratch opened long ago but
  // holding a waiting agent must report the agent, not the age.
  it("prefers live activity over the opened time", () => {
    const status = getScratchRowStatus(
      scratch({ lastOpened: NOW - 5 * 3600_000, waitingAgentCount: 1 }),
      NOW
    );

    expect(status.text).toContain("needs input");
    expect(status.tone).toBe("waiting");
  });
});

describe("snoozed rows", () => {
  const WAKE_AT = NOW + 15 * 60_000;

  it("names the snoozed agents and their wake time", () => {
    const status = getProjectRowStatus(
      project({ snoozedAgentCount: 1, nextSnoozeWakeAt: WAKE_AT }),
      NOW
    );

    expect(status.tone).toBe("snoozed");
    expect(status.text).toContain("snoozed");
    expect(status.text).toContain("until");
  });

  it("pluralises the count", () => {
    const one = getProjectRowStatus(project({ snoozedAgentCount: 1 }), NOW).text;
    const many = getProjectRowStatus(project({ snoozedAgentCount: 3 }), NOW).text;

    expect(one).not.toContain("3");
    expect(many).toContain("3");
  });

  it("states no wake time when every snooze is unlimited", () => {
    const status = getProjectRowStatus(project({ snoozedAgentCount: 2 }), NOW);

    expect(status.tone).toBe("snoozed");
    expect(status.text).not.toContain("until");
  });

  it("renders the same wake time regardless of how much later it is read", () => {
    // The anti-countdown contract: a static clock time stays true without being
    // redrawn, so no timer is needed to keep the row honest.
    const row = project({ snoozedAgentCount: 1, nextSnoozeWakeAt: WAKE_AT });
    const early = getProjectRowStatus(row, NOW).text;
    const later = getProjectRowStatus(row, NOW + 10 * 60_000).text;

    expect(later).toBe(early);
  });

  it("yields to a genuinely waiting agent", () => {
    // Snooze demotes only the runs it covers; an unsnoozed wait still wins.
    const status = getProjectRowStatus(
      project({ snoozedAgentCount: 1, waitingAgentCount: 1 }),
      NOW
    );

    expect(status.tone).toBe("waiting");
  });

  it("yields to a running agent, so a project with work in flight reads as Running", () => {
    const status = getProjectRowStatus(project({ snoozedAgentCount: 1, activeAgentCount: 1 }), NOW);

    expect(status.tone).toBe("working");
  });

  it("yields to work awaiting review", () => {
    const status = getProjectRowStatus(
      project({ snoozedAgentCount: 1, unacknowledgedCompletedAgentCount: 1 }),
      NOW
    );

    expect(status.tone).toBe("review");
  });

  it("outranks the seen-completion line", () => {
    // A snoozed agent is live and coming back; "Agent finished" would deny that.
    const status = getProjectRowStatus(
      project({ snoozedAgentCount: 1, completedAgentCount: 1 }),
      NOW
    );

    expect(status.tone).toBe("snoozed");
  });

  it("outranks the dormant opened-time fallback", () => {
    const status = getProjectRowStatus(project({ snoozedAgentCount: 1, lastOpened: 1 }), NOW);

    expect(status.isDormantFallback).toBeUndefined();
    expect(status.tone).toBe("snoozed");
  });

  it("gives a scratch the same snoozed line a project gets", () => {
    const status = getScratchRowStatus(scratch({ snoozedAgentCount: 1 }), NOW);

    expect(status.tone).toBe("snoozed");
    expect(status.text).toContain("snoozed");
  });

  it("is distinguishable from the muted settled states by more than colour", () => {
    // Tone alone cannot separate snoozed from finished-and-seen, so the row's
    // words have to — otherwise the two greys are the same row.
    const snoozed = getProjectRowStatus(project({ snoozedAgentCount: 1 }), NOW);
    const settled = getProjectRowStatus(
      project({ completedAgentCount: 1, latestCompletionAt: NOW - 60_000 }),
      NOW
    );

    expect(snoozed.text).not.toBe(settled.text);
    expect(snoozed.tone).not.toBe(settled.tone);
  });
});
