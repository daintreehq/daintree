import { describe, it, expect } from "vitest";
import {
  formatFleetLiveness,
  formatWaitAge,
  getProjectRowStatus,
  getScratchRowStatus,
  runningShare,
} from "../projectRowStatus";
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

/**
 * The demand half of a row's line, as a reader sees it: the state phrase and
 * the age that dates it, joined the way the row joins them.
 *
 * The two are separate fields because they draw in different ink — the state
 * carries the demand tone, the age is muted — but almost every assertion below
 * is about the sentence they make together, and splitting each one in two would
 * say less about the copy while checking it twice.
 */
function demandLine(status: { text: string; ageDetail?: string }): string {
  return status.ageDetail === undefined ? status.text : `${status.text} · ${status.ageDetail}`;
}

describe("getProjectRowStatus", () => {
  it("reports blocked and plain waits together, never one instead of the other", () => {
    // Blocked is a SUBSET of waiting. Reporting only the blocked agent would
    // hide two others that are still asking the user for something.
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 3, blockedAgentCount: 1, activeAgentCount: 2 }),
      NOW
    );

    expect(demandLine(status)).toBe("2 need input · 1 blocked");
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

    expect(demandLine(status)).toBe("1 needs input · 1 blocked · oldest 42m");
  });

  it("clamps a blocked count that exceeds the waits it is drawn from", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 1, blockedAgentCount: 5 }),
      NOW
    );

    expect(demandLine(status)).toBe("1 blocked");
    expect(status.tone).toBe("blocked");
  });

  it("ranks a wait above work in progress", () => {
    const status = getProjectRowStatus(project({ waitingAgentCount: 1, activeAgentCount: 4 }), NOW);

    expect(demandLine(status)).toBe("1 needs input");
    expect(status.tone).toBe("waiting");
  });

  it("carries magnitude and the oldest wait's age", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 3, oldestWaitingSince: NOW - 42 * 60_000 }),
      NOW
    );

    expect(demandLine(status)).toBe("3 need input · oldest 42m");
  });

  it("drops the 'oldest' qualifier when only one agent waits", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 1, oldestWaitingSince: NOW - 7 * 60_000 }),
      NOW
    );

    expect(demandLine(status)).toBe("1 needs input · waiting 7m");
  });

  it("omits the age when no wait timestamp arrived", () => {
    const status = getProjectRowStatus(project({ waitingAgentCount: 2 }), NOW);

    expect(demandLine(status)).toBe("2 need input");
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

    expect(demandLine(status)).toBe("1 ready for review · just finished 3m ago");
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
    expect(demandLine(fresh)).toBe("1 ready for review · just finished 14m ago");

    const boundary = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 15 * 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 15 * 60_000,
      }),
      NOW
    );
    expect(demandLine(boundary)).toBe("1 ready for review · finished 15m ago");

    const stale = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 16 * 60_000,
        oldestUnacknowledgedCompletionAt: NOW - 16 * 60_000,
      }),
      NOW
    );
    expect(demandLine(stale)).toBe("1 ready for review · finished 16m ago");
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
    expect(demandLine(status)).toBe("1 ready for review · just finished");
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

    expect(demandLine(status)).toBe("3 ready for review · 3m–2h ago");
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

    expect(demandLine(status)).toBe("2 ready for review · 3m–2h ago");
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

    expect(demandLine(status)).toBe("2 ready for review · 8m ago");
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
    expect(review.text).toContain("ready for review");
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

    expect(demandLine(status)).toBe("1 finished · 2h ago");
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

    expect(demandLine(status)).toBe("3 finished · latest 2h ago");
  });

  it("reports running work beside an acknowledged completion rather than instead of it", () => {
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

    // Running is not a tier: the completion keeps the sentence it earned, and
    // the run rides the count. Before, the run took the line and the two
    // finished agents went unmentioned.
    expect(demandLine(status)).toBe("2 finished · latest 1h ago");
    expect(status.livenessDetail).toBe("1 agent running");
  });

  it("distinguishes agents from bare processes", () => {
    // Agents report as a count with no sentence of their own to claim.
    const agents = getProjectRowStatus(project({ activeAgentCount: 2 }), NOW);
    expect(agents.livenessDetail).toBe("2 agents running");
    expect(agents.isDormantFallback).toBe(true);

    // A bare process is not an agent, so it stays a sentence and no count.
    const bare = getProjectRowStatus(project({ processCount: 1 }), NOW);
    expect(bare.text).toBe("1 process running");
    expect(bare.livenessDetail).toBeUndefined();
  });

  it("keeps the process line from double-counting the PTYs its agents run in", () => {
    // `processCount` includes each running agent's own terminal, so a row with
    // two agents in three PTYs must not print a process count beside a count of
    // 2 and leave the reader to reconcile them. Asserted as an equality with
    // the same row carrying no processes at all: a reworded process line would
    // slip past a "does not contain" check.
    const withProcesses = getProjectRowStatus(
      project({ activeAgentCount: 2, processCount: 3 }),
      NOW
    );
    const without = getProjectRowStatus(project({ activeAgentCount: 2, processCount: 0 }), NOW);

    expect(withProcesses).toEqual(without);
    expect(withProcesses.livenessDetail).toBe("2 agents running");
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
      project({ processCount: 1 }),
    ];
    for (const row of reportable) {
      const status = getProjectRowStatus(row, NOW);
      expect(status.isDormantFallback).toBeUndefined();
      // Guards the pairing the switcher relies on: anything unflagged still has
      // a sentence to print, so hiding the flagged ones can't blank a row.
      expect(status.text.length).toBeGreaterThan(0);
    }

    // A row whose only fact is a running agent belongs on the dormant side now:
    // it has nothing to ask of anyone, so it prints no sentence — but it is not
    // silent, because the count and the mark both still speak for it.
    const running = getProjectRowStatus(project({ activeAgentCount: 1 }), NOW);
    expect(running.isDormantFallback).toBe(true);
    expect(running.livenessDetail).toBe("1 agent running");
    expect(running.markTone).toBe("working");

    // Two of the reportable rows are muted. If that stopped being true the test
    // above would pass while proving nothing.
    expect(getProjectRowStatus(reportable[0]!, NOW).tone).toBe("muted");
    expect(getProjectRowStatus(reportable[1]!, NOW).tone).toBe("muted");
  });

  // Cuts across the flag above rather than with it: an auto-parked row keeps
  // its line and still yields its dot, which is the pairing #11822 fixed. The
  // rows that say what a project is doing keep their own mark.
  it("lets a stopped row yield its dot without giving up its line", () => {
    const yields = [
      project({ lastOpened: NOW - 2 * 3600_000 }),
      project({ lastOpened: 0 }),
      project({ status: "closed", autoParkedAt: NOW - 1000, lastOpened: NOW - 5000 }),
    ];
    for (const row of yields) {
      expect(getProjectRowStatus(row, NOW).allowsResumeMark).toBe(true);
    }

    // The auto-parked row is the one that has to hold both answers at once —
    // yielding the dot while keeping the reason it was parked.
    const parked = getProjectRowStatus(yields[2]!, NOW);
    expect(parked.isDormantFallback).toBeUndefined();
    expect(parked.text.length).toBeGreaterThan(0);

    // The hint is decorated onto the status afterwards, so it is the one path
    // that could drop the flag while every other row kept it — and it would
    // only show up on parked projects whose folder name collides.
    expect(
      getProjectRowStatus(
        project({
          status: "closed",
          autoParkedAt: NOW - 1000,
          displayPath: "payments/api",
        }),
        NOW
      )
    ).toMatchObject({ allowsResumeMark: true, pathHint: "payments/api" });

    // Stated as open projects, which is where these settle: the counts are
    // computed from live terminals, so a project that stays closed reports
    // zero. A row whose agents finished in a window that is still open is not
    // waiting on disk for anyone.
    const keepsItsMark = [
      project({ status: "background", isBackground: true, completedAgentCount: 1 }),
      project({ status: "background", isBackground: true, waitingAgentCount: 1 }),
      project({ status: "background", isBackground: true, activeAgentCount: 1 }),
      project({ status: "background", isBackground: true, snoozedAgentCount: 1 }),
      project({ status: "background", isBackground: true, processCount: 1 }),
      project({ status: "missing", isMissing: true }),
    ];
    for (const row of keepsItsMark) {
      expect(getProjectRowStatus(row, NOW).allowsResumeMark).toBeUndefined();
    }

    // The finished row is muted exactly like the parked one, so tone cannot be
    // what separates them — asserted as the pair, since checking either alone
    // would stay green while the premise stopped being true.
    expect(getProjectRowStatus(keepsItsMark[0]!, NOW).tone).toBe(parked.tone);
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
    expect(status.ageDetail).toContain("until");
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
    expect(status.ageDetail).toBeUndefined();
  });

  it("renders the same wake time regardless of how much later it is read", () => {
    // The anti-countdown contract: a static clock time stays true without being
    // redrawn, so no timer is needed to keep the row honest.
    const row = project({ snoozedAgentCount: 1, nextSnoozeWakeAt: WAKE_AT });
    const early = getProjectRowStatus(row, NOW).ageDetail;
    const later = getProjectRowStatus(row, NOW + 10 * 60_000).ageDetail;

    expect(later).toBe(early);
  });

  it("actually derives the line from the wake time, not a fixed string", () => {
    // Paired with the stability test above: without this, a hard-coded or
    // omitted time would satisfy "unchanged when read later" perfectly.
    const early = getProjectRowStatus(
      project({ snoozedAgentCount: 1, nextSnoozeWakeAt: WAKE_AT }),
      NOW
    ).ageDetail;
    const late = getProjectRowStatus(
      project({ snoozedAgentCount: 1, nextSnoozeWakeAt: WAKE_AT + 3 * 60 * 60_000 }),
      NOW
    ).ageDetail;

    expect(late).not.toBe(early);
  });

  it("drops only the wake clause when the wake time is absent, keeping the count", () => {
    const timed = getProjectRowStatus(
      project({ snoozedAgentCount: 2, nextSnoozeWakeAt: WAKE_AT }),
      NOW
    );
    const unlimited = getProjectRowStatus(project({ snoozedAgentCount: 2 }), NOW);

    // The count is the same fact either way; only the wake time is conditional.
    expect(timed.text).toBe(unlimited.text);
    expect(timed.ageDetail).toBeTruthy();
    expect(unlimited.ageDetail).toBeUndefined();
  });

  it("yields to a genuinely waiting agent", () => {
    // Snooze demotes only the runs it covers; an unsnoozed wait still wins.
    const status = getProjectRowStatus(
      project({ snoozedAgentCount: 1, waitingAgentCount: 1 }),
      NOW
    );

    expect(status.tone).toBe("waiting");
  });

  it("keeps its line while a running agent reports beside it", () => {
    // The snooze and the run are both true, and the row now says both: before,
    // running took the line outright and the snoozed agent vanished from it.
    const status = getProjectRowStatus(project({ snoozedAgentCount: 1, activeAgentCount: 1 }), NOW);

    expect(status.tone).toBe("snoozed");
    expect(status.livenessDetail).toBe("1 agent running");
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

describe("assistant presence status lines (#11806)", () => {
  const SEEN = NOW - 10 * 60_000;

  it("names the assistant instead of claiming an agent count", () => {
    const status = getProjectRowStatus(
      project({ assistantState: "working", assistantStateSince: NOW - 60_000 }),
      NOW
    );

    expect(status.text).toBe("Assistant working");
    // The row must not read as a run the user launched.
    expect(status.text).not.toMatch(/agent/i);
    expect(status.isDormantFallback).toBeUndefined();
  });

  it("reads a directing assistant as working too", () => {
    expect(getProjectRowStatus(project({ assistantState: "directing" }), NOW).text).toBe(
      "Assistant working"
    );
  });

  it("ages a wait so a fresh one and an old one stop rendering identically", () => {
    const fresh = getProjectRowStatus(
      project({
        assistantState: "waiting",
        assistantStateSince: NOW - 30_000,
        lastOpened: SEEN,
      }),
      NOW
    );
    const old = getProjectRowStatus(
      project({
        assistantState: "waiting",
        assistantStateSince: NOW - 42 * 60_000,
        lastOpened: SEEN,
      }),
      NOW
    );

    expect(demandLine(fresh)).toBe("Assistant waiting · just now");
    expect(demandLine(old)).toBe("Assistant waiting · 42m");
  });

  it("says blocked, in the danger tone, when the assistant failed", () => {
    const status = getProjectRowStatus(
      project({
        assistantState: "waiting",
        assistantWaitingReason: "error",
        assistantStateSince: NOW - 5 * 60_000,
      }),
      NOW
    );

    expect(demandLine(status)).toBe("Assistant blocked · 5m");
    expect(status.tone).toBe("assistant-blocked");
  });

  it("keeps every assistant tone out of the worker vocabulary", () => {
    // The worker dot is the thing the issue says must keep meaning what it
    // means. Assistant rows must never borrow one of its tones — and must earn
    // a line of their own rather than falling through to the dormant fallback,
    // which would satisfy the first half of this while saying nothing.
    const workerTones = ["working", "waiting", "blocked", "review", "running", "snoozed"];
    for (const assistantState of ["working", "waiting"] as const) {
      const status = getProjectRowStatus(project({ assistantState, lastOpened: NOW }), NOW);
      expect(status.text).toContain("Assistant");
      expect(status.isDormantFallback).toBeUndefined();
      expect(workerTones).not.toContain(status.tone);
    }
  });

  it.each(["idle", "completed", "exited"] as const)(
    "says nothing for a settled assistant in state %s",
    (assistantState) => {
      const status = getProjectRowStatus(project({ assistantState, lastOpened: SEEN }), NOW);

      // Falls all the way through to the dormant line, drawing no dot.
      expect(status.isDormantFallback).toBe(true);
      expect(status.text).not.toMatch(/assistant/i);
    }
  );

  it("lets an assistant failure outrank an unreviewed completion", () => {
    const status = getProjectRowStatus(
      project({
        assistantState: "waiting",
        assistantWaitingReason: "error",
        unacknowledgedCompletedAgentCount: 1,
        latestUnacknowledgedCompletionAt: NOW - 60_000,
      }),
      NOW
    );

    expect(status.text).toContain("Assistant blocked");
  });

  it("keeps workers waiting on the user above the assistant", () => {
    // Both land the row in the attention band; the people stalled on a run
    // they started are the louder ask.
    const status = getProjectRowStatus(
      project({
        waitingAgentCount: 2,
        assistantState: "waiting",
        assistantWaitingReason: "error",
      }),
      NOW
    );

    expect(status.text).toContain("need input");
  });

  it("reports a working assistant rather than the snooze beneath it", () => {
    // A working assistant is why this row is in Running at all — announcing
    // "Agent snoozed" from that band would contradict its own placement.
    const status = getProjectRowStatus(
      project({ assistantState: "working", snoozedAgentCount: 1 }),
      NOW
    );

    expect(status.text).toBe("Assistant working");
  });

  it("counts the workers rather than announcing the assistant beside them", () => {
    // Both are executing, but only the runs the user launched are countable
    // (#11806) — and "Assistant working" must not stand in for a number when
    // there is a real one to give.
    const status = getProjectRowStatus(
      project({ activeAgentCount: 2, assistantState: "working" }),
      NOW
    );

    expect(status.livenessDetail).toBe("2 agents running");
    expect(status.markTone).toBe("working");
  });

  it("puts a seen wait below the snooze but above the settled lines", () => {
    const snoozed = getProjectRowStatus(
      project({
        snoozedAgentCount: 1,
        assistantState: "waiting",
        assistantStateSince: SEEN - 60_000,
        lastOpened: SEEN,
      }),
      NOW
    );
    const settled = getProjectRowStatus(
      project({
        completedAgentCount: 1,
        latestCompletionAt: NOW - 60_000,
        assistantState: "waiting",
        assistantStateSince: SEEN - 60_000,
        lastOpened: SEEN,
      }),
      NOW
    );

    expect(snoozed.text).toContain("snoozed");
    expect(settled.text).toContain("Assistant waiting");
  });

  it("outranks a bare process count", () => {
    const status = getProjectRowStatus(
      project({ processCount: 3, assistantState: "working" }),
      NOW
    );

    expect(status.text).toBe("Assistant working");
  });

  it("gives a scratch the same assistant line a project gets", () => {
    // A help session is provisioned against an opaque workspace id, so a
    // scratch can host one and must not render it differently.
    const status = getScratchRowStatus(
      scratch({ assistantState: "working", assistantStateSince: NOW - 60_000 }),
      NOW
    );

    expect(status.text).toBe("Assistant working");
    expect(status.tone).toBe("assistant");
  });

  it("still names the assistant when the wait has no recorded start", () => {
    const status = getProjectRowStatus(project({ assistantState: "waiting" }), NOW);

    // No age to state, but the presence is still the most useful fact here —
    // and an undatable wait must not render as an epoch-old one.
    expect(status.text).toBe("Assistant waiting");
    expect(status.text).not.toContain("·");
  });
});

/**
 * Liveness is the second axis (#11832): demand says what the row wants, this
 * says whether it will change on its own. The cases below are written as
 * comparisons between two computed statuses rather than assertions about
 * particular strings, because the property under test is that one axis moves
 * while the other does not.
 */
describe("row status liveness", () => {
  const RUNNING = 2;

  it("separates a waiting row that is still churning from one that has stalled", () => {
    // The bug: the cascade picks the wait and drops everything under it, so
    // these two rendered identically while only one of them was still moving.
    const stalled = getProjectRowStatus(
      project({ waitingAgentCount: 1, oldestWaitingSince: NOW - 17 * 60_000 }),
      NOW
    );
    const churning = getProjectRowStatus(
      project({
        waitingAgentCount: 1,
        oldestWaitingSince: NOW - 17 * 60_000,
        activeAgentCount: RUNNING,
      }),
      NOW
    );

    // Demand is untouched — the whole point is that this is additive.
    expect(churning.text).toBe(stalled.text);
    expect(churning.tone).toBe(stalled.tone);

    expect(stalled.livenessDetail).toBeUndefined();
    expect(churning.livenessDetail).toBe(`${RUNNING} agents running`);
    // And the mark follows: only one of them has anything to weigh.
    expect(stalled.agentMix).toEqual({ demand: 1, running: 0 });
    expect(churning.agentMix).toEqual({ demand: 1, running: RUNNING });
  });

  it("carries the count through whichever demand tier won the line", () => {
    // The reason running cannot be a tier. Each of these rows has a louder fact
    // than "3 agents running", and each of them used to swallow it whole — the
    // count has to survive every one of them, because "how many of mine are
    // still going" is the question this surface gets opened for.
    //
    // Asserted as a pair rather than against literal copy: the same row is
    // computed with and without the run, and the demand half has to come back
    // byte-identical. A tier that quietly started reporting the run itself
    // would pass a "says something" check and fail this one.
    const tiers: Array<[string, Partial<SearchableProject>]> = [
      ["a wait", { waitingAgentCount: 1, oldestWaitingSince: NOW - 60_000 }],
      ["a block", { waitingAgentCount: 1, blockedAgentCount: 1 }],
      ["work awaiting review", { unacknowledgedCompletedAgentCount: 2 }],
      ["a snooze", { snoozedAgentCount: 1, nextSnoozeWakeAt: NOW + 600_000 }],
      ["a seen completion", { completedAgentCount: 1, latestCompletionAt: NOW - 60_000 }],
      ["a missing directory", { isMissing: true }],
      ["an already-seen assistant wait", { assistantState: "waiting", isActive: true }],
    ];

    for (const [label, overrides] of tiers) {
      const settled = getProjectRowStatus(project({ ...overrides }), NOW);
      const live = getProjectRowStatus(project({ ...overrides, activeAgentCount: 3 }), NOW);

      expect(live.text, label).toBe(settled.text);
      expect(live.tone, label).toBe(settled.tone);

      expect(settled.livenessDetail, label).toBeUndefined();
      expect(live.livenessDetail, label).toBe("3 agents running");

      // The mark follows the demand only while the demand is asking for
      // something. A snooze and a seen completion are not, so on those rows the
      // run takes the mark instead of leaving it settled beside three agents
      // that are visibly still going.
      const asking = settled.tone !== "snoozed" && settled.tone !== "muted";
      expect(live.markTone, label).toBe(asking ? settled.markTone : "working");
    }
  });

  it("leaves a row with nothing happening unmarked", () => {
    // The null case the required field exists for: no demand, no run, so the
    // slot stays empty rather than defaulting to a tone that means something.
    const quiet = getProjectRowStatus(project({ lastOpened: NOW - 3 * 3600_000 }), NOW);

    expect(quiet.markTone).toBeNull();
    expect(quiet.agentMix).toBeNull();
    expect(quiet.isDormantFallback).toBe(true);
  });

  it("lets a working assistant keep its line without taking a running row's", () => {
    // The one case where the mark and the sentence come apart: the assistant is
    // presence rather than demand (#11806), so it says what it is while the
    // mark goes to the runs the user actually launched.
    const assistantOnly = getProjectRowStatus(project({ assistantState: "working" }), NOW);
    expect(assistantOnly.text).toBe("Assistant working");
    expect(assistantOnly.markTone).toBe("assistant");

    const alsoRunning = getProjectRowStatus(
      project({ assistantState: "working", activeAgentCount: 2 }),
      NOW
    );
    expect(alsoRunning.markTone).toBe("working");
    expect(alsoRunning.livenessDetail).toBe("2 agents running");
  });

  it("keeps a running row's own settled line instead of the assistant's", () => {
    // The assistant branch sits above snooze so an assistant-only project does
    // not announce "Agent snoozed" from the Running band. On a row that is
    // itself running, the count already explains the band — so the snooze the
    // user set has to survive rather than being evicted by the machine's own
    // session.
    const status = getProjectRowStatus(
      project({
        assistantState: "working",
        activeAgentCount: 1,
        snoozedAgentCount: 1,
        nextSnoozeWakeAt: NOW + 600_000,
      }),
      NOW
    );

    expect(status.text).toContain("snoozed");
    expect(status.livenessDetail).toBe("1 agent running");
  });

  it("withholds the parked line from a row whose agents are still running", () => {
    // The sweep marks a project closed at once while its counts arrive on a
    // 200ms debounce, so "Suspended to free memory" can reach a row that is
    // demonstrably still working. Contradicting the count is worse than saying
    // nothing, so the row drops to the silent fallback for that beat.
    const parked = { status: "closed" as const, autoParkedAt: NOW - 50, lastOpened: NOW - 5000 };

    const settled = getProjectRowStatus(project(parked), NOW);
    expect(settled.text).toBe("Suspended to free memory");
    expect(settled.allowsResumeMark).toBe(true);

    const midSweep = getProjectRowStatus(project({ ...parked, activeAgentCount: 1 }), NOW);
    expect(midSweep.text).not.toContain("Suspended");
    expect(midSweep.isDormantFallback).toBe(true);
    expect(midSweep.allowsResumeMark).toBeUndefined();
    expect(midSweep.livenessDetail).toBe("1 agent running");
    expect(midSweep.markTone).toBe("working");
  });

  it("says nothing extra on the line that already names the assistant's work", () => {
    // "Assistant working · Assistant working" would state one fact twice. The
    // suppression is scoped to that phrase: an assistant working alongside real
    // runs still lets the count through, which the worker test above covers.
    const status = getProjectRowStatus(project({ assistantState: "working" }), NOW);

    expect(status.text).toBe("Assistant working");
    expect(status.livenessDetail).toBeUndefined();
  });

  it("singularises the clause the way the sentences above it do", () => {
    const status = getProjectRowStatus(project({ waitingAgentCount: 1, activeAgentCount: 1 }), NOW);

    expect(status.livenessDetail).toBe("1 agent running");
  });

  it("keeps the clause off a row where nothing is executing", () => {
    // Every settled tone at once: a completion, a snooze and a bare process
    // count are all reachable only after the cascade established that no agent
    // is running, so none of them may claim otherwise.
    const settled = [
      project({ completedAgentCount: 1, latestCompletionAt: NOW - 60_000 }),
      project({ snoozedAgentCount: 1 }),
      project({ processCount: 4 }),
      project({ lastOpened: NOW - 3600_000 }),
      project({ status: "closed", autoParkedAt: NOW - 60_000 }),
    ].map((row) => getProjectRowStatus(row, NOW));

    for (const status of settled) {
      expect(status.livenessDetail).toBeUndefined();
      // Nothing to weigh either, so these rows keep a plain settled mark.
      expect(status.agentMix?.running ?? 0).toBe(0);
    }
  });

  it("does not take a process count for a running agent", () => {
    // `processCount` nets out the assistant's own PTY and trails the truth by a
    // poll interval, so a row keyed off it would claim to be moving after its
    // last agent stopped.
    const byProcess = getProjectRowStatus(project({ waitingAgentCount: 1, processCount: 5 }), NOW);
    const byAgent = getProjectRowStatus(
      project({ waitingAgentCount: 1, activeAgentCount: 1 }),
      NOW
    );

    expect(byProcess.livenessDetail).toBeUndefined();
    expect(byProcess.agentMix).toEqual({ demand: 1, running: 0 });
    expect(byAgent.livenessDetail).toBe("1 agent running");
  });

  it("counts a working assistant as live without inventing an agent for it", () => {
    const hidden = getProjectRowStatus(
      project({ waitingAgentCount: 1, assistantState: "working" }),
      NOW
    );

    // Named, not numbered: the assistant is one thing the user never launched,
    // and "1 agent running" would enrol it in a tally it is excluded from everywhere
    // else.
    expect(hidden.livenessDetail).toBe("Assistant working");
  });

  it("reports the workers when both they and the assistant are going", () => {
    const status = getProjectRowStatus(
      project({ waitingAgentCount: 1, activeAgentCount: RUNNING, assistantState: "working" }),
      NOW
    );

    expect(status.livenessDetail).toBe(`${RUNNING} agents running`);
  });

  it("leaves the assistant's own line without a clause about itself", () => {
    const status = getProjectRowStatus(project({ assistantState: "working" }), NOW);

    expect(status.text).toBe("Assistant working");
    expect(status.livenessDetail).toBeUndefined();
  });

  it("treats a directing assistant as executing, the way the classifier does", () => {
    // A directing assistant is mid-task, so it speaks; an idle one has nothing
    // to say and lets the row fall through to whatever is underneath it.
    const directing = getProjectRowStatus(project({ assistantState: "directing" }), NOW);
    const idle = getProjectRowStatus(project({ assistantState: "idle" }), NOW);

    expect(directing.text).toBe("Assistant working");
    expect(idle.isDormantFallback).toBe(true);
  });

  it("needs no union with the snooze count to see a snoozed run still working", () => {
    // Snoozing withholds a row from the demanding tallies; it does not stop the
    // run, so a still-working snoozed agent is already inside `activeAgentCount`.
    const status = getProjectRowStatus(
      project({ snoozedAgentCount: 1, activeAgentCount: 1, waitingAgentCount: 1 }),
      NOW
    );

    expect(status.livenessDetail).toBe("1 agent running");
  });

  it("keeps reporting the run when the folder underneath it has gone", () => {
    // `isMissing` pre-empts the activity cascade outright, so without this the
    // one row whose agents are most likely orphaned says the least about them.
    const missing = getProjectRowStatus(
      project({ isMissing: true, activeAgentCount: RUNNING }),
      NOW
    );
    const found = getProjectRowStatus(project({ isMissing: true }), NOW);

    expect(missing.text).toBe(found.text);
    expect(missing.tone).toBe(found.tone);
    expect(missing.livenessDetail).toBe(`${RUNNING} agents running`);
    expect(found.livenessDetail).toBeUndefined();
  });

  it("carries the clause under every demand tier that can hide a run", () => {
    // One matrix rather than a case each: the property is that no tier above
    // `running` may swallow it. A fixed list cannot catch a tier added later —
    // `withLiveness` running on every exit is what does that — so this pins the
    // tiers that exist today rather than claiming to police future ones.
    const hiding = [
      project({ waitingAgentCount: 1 }),
      project({ waitingAgentCount: 2, blockedAgentCount: 1 }),
      project({ blockedAgentCount: 1 }),
      project({ unacknowledgedCompletedAgentCount: 1, completedAgentCount: 1 }),
      project({ assistantState: "waiting", assistantWaitingReason: "error" }),
    ];

    for (const row of hiding) {
      const stalled = getProjectRowStatus(row, NOW);
      const churning = getProjectRowStatus({ ...row, activeAgentCount: RUNNING }, NOW);

      expect(churning.text).toBe(stalled.text);
      expect(churning.tone).toBe(stalled.tone);
      expect(stalled.livenessDetail).toBeUndefined();
      expect(churning.livenessDetail).toBe(`${RUNNING} agents running`);
    }
  });

  it("gives a scratch the same two axes a project gets", () => {
    const stalled = getScratchRowStatus(scratch({ waitingAgentCount: 1 }), NOW);
    const churning = getScratchRowStatus(
      scratch({ waitingAgentCount: 1, activeAgentCount: RUNNING }),
      NOW
    );

    expect(churning.text).toBe(stalled.text);
    expect(stalled.livenessDetail).toBeUndefined();
    expect(churning.livenessDetail).toBe(`${RUNNING} agents running`);
    expect(churning.agentMix).toEqual({ demand: 1, running: RUNNING });
  });

  it("never counts in the line what the mark is not weighing", () => {
    // The renderer trusts both fields, so a status that printed "2 agents
    // running" while handing the mark a mix with nothing running would draw a
    // settled dot beside a sentence about work in flight.
    const rows = [
      project({ waitingAgentCount: 1 }),
      project({ waitingAgentCount: 1, activeAgentCount: 3 }),
      project({ activeAgentCount: 1 }),
      project({ assistantState: "working" }),
      project({ processCount: 2 }),
      project({ isMissing: true, activeAgentCount: 1 }),
      project({ snoozedAgentCount: 1, activeAgentCount: 2 }),
      project({ lastOpened: NOW - 3600_000 }),
    ];

    for (const row of rows) {
      const status = getProjectRowStatus(row, NOW);
      const running = status.agentMix?.running ?? 0;
      const claimsAgents = status.livenessDetail?.includes("running") ?? false;
      expect(claimsAgents).toBe(running > 0);
    }
  });
});

describe("formatFleetLiveness", () => {
  it("says nothing at all when the fleet has gone quiet", () => {
    // Absence is the signal. A standing "0 agents running" would make the reader parse
    // a number to learn there is nothing to learn.
    expect(formatFleetLiveness({ runningAgentCount: 0, workingAssistantCount: 0 })).toBeNull();
  });

  it("reports agents and assistants as separate tallies", () => {
    const both = formatFleetLiveness({ runningAgentCount: 3, workingAssistantCount: 2 });

    // Never summed: an assistant is not a run the user launched, so one number
    // covering both would answer neither question it is asked. Matched as whole
    // phrases — a bare `toContain("3")` also passes on "32 agents running".
    expect(both).not.toContain("5");
    expect(both).toMatch(/\b3 running\b/);
    expect(both).toMatch(/\b2 assistants working\b/);
  });

  it("drops the half that is idle rather than printing a zero", () => {
    const agentsOnly = formatFleetLiveness({ runningAgentCount: 4, workingAssistantCount: 0 });
    const assistantsOnly = formatFleetLiveness({ runningAgentCount: 0, workingAssistantCount: 1 });

    expect(agentsOnly).not.toContain("assistant");
    expect(agentsOnly).not.toContain("0");
    expect(assistantsOnly).not.toContain("0");
    expect(assistantsOnly).toContain("assistant");
  });
});

/**
 * The mark's proportion, which has one job the exact counts cannot do: say
 * which way a row leans without being read. It draws the counts' own fraction,
 * so everything here is about the two places that is not the whole story — the
 * floor that keeps a lone agent from becoming a splinter at 8px, and the
 * branches where a side reaching zero hands the mark over entirely.
 */
describe("running share", () => {
  it("gives the whole mark to whichever side is alone", () => {
    expect(runningShare({ demand: 0, running: 4 })).toBe(1);
    expect(runningShare({ demand: 4, running: 0 })).toBe(0);
    // The empty guard, which is unreachable through `agentMix` today — it is
    // null when both sides are zero — and is here because removing it turns a
    // division by zero into NaN coordinates in the wedge path rather than into
    // anything a caller would notice.
    expect(runningShare({ demand: 0, running: 0 })).toBe(0);
  });

  it("never lets a present side round out of the mark", () => {
    // The failure this exists to prevent: a mark that says "nothing is running"
    // about a project with a running agent is worse than one that says nothing.
    // Swept well past the floor, because the two exclusive branches are the
    // only places a share of exactly 0 or 1 may come from — a lopsided mix must
    // reach neither, however lopsided it gets.
    for (const other of [1, 4, 13, 60, 400]) {
      for (const [demand, running] of [
        [other, 1],
        [1, other],
      ] as const) {
        const share = runningShare({ demand, running });
        expect(share).toBeGreaterThan(0);
        expect(share).toBeLessThan(1);
      }
    }
  });

  it("draws the counts' own proportion once both sides are visible", () => {
    // The mark is a pie, not a set of poses: a mixed row's wedge is the
    // fraction the counts make, so it cannot lean one way while the figures
    // printed beside it lean the other. Sampled across the range rather than
    // asserted case by case — the property is what matters, and a case list
    // would just restate the arithmetic.
    for (let demand = 1; demand <= 12; demand++) {
      for (let running = 1; running <= 12; running++) {
        const exact = running / (demand + running);
        const share = runningShare({ demand, running });
        // Clamped only where a side would otherwise be a splinter, which no
        // pair this small reaches.
        expect(share).toBeCloseTo(exact, 10);
      }
    }
  });

  it("keeps a lone agent among many wide enough to see", () => {
    // 1-of-50 is 2% of the disc — a sub-pixel sliver at 8px. The clamp is what
    // stops the mark from claiming a side that is present has nothing.
    const sliver = runningShare({ demand: 49, running: 1 });
    expect(sliver).toBeGreaterThan(1 / 50);
    expect(sliver).toBeLessThan(0.1);
    expect(runningShare({ demand: 1, running: 49 })).toBeCloseTo(1 - sliver, 10);
  });

  it("leans the way the counts do", () => {
    // Monotonic in the one variable that matters: with the waiting side held
    // still, adding a run never moves the mark toward demand. Holding `demand`
    // fixed is the point — varying both at once would pass on a function that
    // merely responded to the ratio's sign.
    for (const demand of [1, 3, 20]) {
      let previous = runningShare({ demand, running: 1 });
      for (let running = 2; running <= 40; running++) {
        const share = runningShare({ demand, running });
        expect(share).toBeGreaterThanOrEqual(previous);
        previous = share;
      }
    }

    // Equal counts split the mark down the middle, which is the one proportion
    // a reader can name on sight.
    expect(runningShare({ demand: 2, running: 2 })).toBe(0.5);
  });

  it("stops being proportional only where a side would be a splinter", () => {
    // The floor's cost, stated rather than hidden: past a point, two different
    // ratios draw the same mark. Asserted as a plateau between two extremes
    // rather than against the constant itself, so the number can be retuned for
    // a different mark size without editing this.
    const veryLopsided = runningShare({ demand: 400, running: 1 });
    const evenMoreSo = runningShare({ demand: 4000, running: 1 });
    expect(veryLopsided).toBe(evenMoreSo);

    // ...and the plateau is narrow. A mix that any reader could see is lopsided
    // without being extreme still draws its true proportion.
    expect(runningShare({ demand: 9, running: 1 })).toBeCloseTo(0.1, 10);

    // Symmetric: the same clamp applies to whichever side is outnumbered.
    expect(runningShare({ demand: 1, running: 400 })).toBeCloseTo(1 - veryLopsided, 10);
  });
});
