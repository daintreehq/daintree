// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantTimerNotifications } from "../useAssistantTimerNotifications";
import type { AssistantTimers } from "@/store/assistantStore";
import type { AssistantTimerOutcomeRow } from "@shared/types/ipc/assistantHost";

// The panel's own notice strip — this hook no longer touches the app-wide notifier,
// because everything the assistant does stays inside the assistant.
const notifyMock = vi.fn();

/**
 * Announcing a fired timer.
 *
 * The rules worth pinning are all about restraint: announce what genuinely just
 * happened, once, and never replay a backlog as though it were news.
 */

function outcome(over: Partial<AssistantTimerOutcomeRow> = {}): AssistantTimerOutcomeRow {
  return {
    eventId: "evt_1",
    timerId: "tmr_1",
    severity: "info",
    title: "Re-check CI",
    summary: "Spawned claude for the CI check.",
    createdAt: 1,
    updatedAt: 1,
    count: 1,
    ...over,
  };
}

function timers(outcomes: AssistantTimerOutcomeRow[]): AssistantTimers {
  return { rows: [], outcomes, takenAt: 1, readFailed: false };
}

/**
 * A stand-in for the store's read-and-clear. Seed it with the ids the engine has said
 * fired; the hook drains it exactly as the real action does.
 */
function firedQueue(ids: string[] = []) {
  let pending = ids;
  return vi.fn(() => {
    const out = pending;
    pending = [];
    return out;
  });
}

function setup(
  initial: AssistantTimers | null,
  sessionId: string | null = "s1",
  takeFiredTimerIds = firedQueue()
) {
  const requestTimers = vi.fn();
  const view = renderHook(
    (props: { timers: AssistantTimers | null; timersStale: boolean; sessionId: string | null }) =>
      useAssistantTimerNotifications({
        ...props,
        requestTimers,
        takeFiredTimerIds,
        pushNotice: (level, message) => notifyMock({ level, message }),
      }),
    { initialProps: { timers: initial, timersStale: false, sessionId } }
  );
  return { ...view, requestTimers, takeFiredTimerIds };
}

beforeEach(() => notifyMock.mockClear());

describe("the first reading is a baseline", () => {
  // Reconnecting to a project would otherwise replay every outcome still sitting in
  // the engine's queue as though it had just happened — a burst of notifications
  // about work that finished yesterday.
  it("announces nothing on the reading it arrives with", () => {
    setup(timers([outcome(), outcome({ eventId: "evt_2" })]));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("re-baselines when the session changes", () => {
    const { rerender } = setup(timers([outcome()]));
    rerender({
      timers: timers([outcome({ eventId: "evt_new" })]),
      timersStale: false,
      sessionId: "s2",
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("what it announces", () => {
  it("announces an outcome that arrives after the baseline", () => {
    const { rerender } = setup(timers([outcome()]));
    rerender({
      timers: timers([outcome(), outcome({ eventId: "evt_2", summary: "Reminder: stand-up" })]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        // Reported in the PANEL, never on a surface that spans the window.
        level: "info",
        message: expect.stringContaining("Reminder: stand-up"),
      })
    );
  });

  it("grades a failed fire as an error", () => {
    const { rerender } = setup(timers([]));
    rerender({
      timers: timers([outcome({ severity: "error", summary: "Timer check failed" })]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledWith(
      // A failure is a WARNING in the panel: the timer did what it was asked, and it is
      // the action it carried that failed. The panel's error level is for the session
      // itself being broken.
      expect.objectContaining({ level: "warning", message: expect.stringContaining("failed") })
    );
  });

  it("announces each firing of a repeat, not just the first", () => {
    // A repeating timer publishes under ONE dedupe key, so the fourth failure
    // UPDATES the first row rather than adding a fourth. Keying on the id alone
    // would report a nightly job's first failure and then go quiet for every one
    // after it — the exact case where silence is most misleading.
    const { rerender } = setup(timers([outcome({ severity: "error", count: 1 })]));
    rerender({
      timers: timers([outcome({ severity: "error", count: 2 })]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    // ...and one live signal per timer: the repeat replaces its own notice rather
    // than stacking a new one beside it every night.
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
  });

  it("does not re-announce a reading that has not changed", () => {
    const rows = [outcome()];
    const { rerender } = setup(timers([]));
    rerender({ timers: timers(rows), timersStale: false, sessionId: "s1" });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    rerender({ timers: timers(rows), timersStale: false, sessionId: "s1" });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe("the first fire of a session", () => {
  /**
   * The defect this correlation exists for.
   *
   * The list is read lazily, so a session's FIRST timer usually fires before anything
   * has read the list — the fire is what triggers the first read. Baselining that
   * reading (correct for a reading that arrives unprompted) swallowed the exact
   * outcome it had been fetched to describe. Schedule a timer, watch it fire, see
   * nothing.
   */
  it("announces a fire that arrives on the very first reading", () => {
    const { rerender } = setup(null, "s1", firedQueue(["tmr_1"]));
    // The engine says tmr_1 fired. Nothing has been read yet.
    rerender({ timers: null, timersStale: true, sessionId: "s1" });
    // ...and the answer to that arrives carrying its outcome.
    rerender({
      timers: timers([outcome({ timerId: "tmr_1", summary: "Spawned claude." })]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        message: expect.stringContaining("Spawned claude."),
      })
    );
  });

  it("announces the failure of a fire that had nothing read before it", () => {
    // The real one: a timer-dispatched spawn that named no worktree. It fired, it
    // failed, and the only place that said so was a deck nobody had open.
    const { rerender } = setup(null, "s1", firedQueue(["tmr_1"]));
    rerender({ timers: null, timersStale: true, sessionId: "s1" });
    rerender({
      timers: timers([
        outcome({ timerId: "tmr_1", severity: "error", summary: "must name the worktree" }),
      ]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
  });

  it("swallows the backlog that arrives alongside it, however recent", () => {
    // The correlation must not degrade into "announce everything on the first read".
    // The discriminator is WHICH TIMER fired, not when a row was stamped — so a
    // backlog row stamped in the same millisecond still stays quiet.
    const at = Date.now();
    const { rerender } = setup(null, "s1", firedQueue(["tmr_new"]));
    rerender({ timers: null, timersStale: true, sessionId: "s1" });
    rerender({
      timers: timers([
        outcome({ eventId: "evt_old", timerId: "tmr_old", summary: "backlog", updatedAt: at }),
        outcome({ eventId: "evt_new", timerId: "tmr_new", summary: "just now", updatedAt: at }),
      ]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("just now") })
    );
  });

  it("announces a fire whose read took longer than any plausible time window", () => {
    // A stamped-recently rule could not survive this: a slow or suspended renderer
    // pushes the outcome arbitrarily far into the past before it is ever seen. The id
    // does not decay.
    const { rerender } = setup(null, "s1", firedQueue(["tmr_1"]));
    rerender({ timers: null, timersStale: true, sessionId: "s1" });
    rerender({
      timers: timers([
        outcome({ timerId: "tmr_1", summary: "late", updatedAt: Date.now() - 3_600_000 }),
      ]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("late") })
    );
  });

  it("does not announce the backlog when no fire was signalled", () => {
    // Unchanged behaviour, restated because the correlation is the only thing standing
    // between it and a burst of notifications on every reconnect.
    const { rerender } = setup(null);
    rerender({
      timers: timers([outcome({ updatedAt: Date.now() })]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("keeps the fire when the session id and the fire land in the same commit", () => {
    // The ordering trap. Effects run in declaration order, so a baseline reset that
    // lived in the announce effect would wipe a fire the effect above it had just
    // recorded — silently baselining its outcome. Drives sessionId null -> "s1" and
    // timersStale false -> true in ONE render, which is what a replayed pre-ready
    // fire, or a reconnect, actually looks like.
    const { rerender } = setup(null, null, firedQueue(["tmr_1"]));
    rerender({ timers: null, timersStale: true, sessionId: "s1" });
    rerender({
      timers: timers([outcome({ timerId: "tmr_1", summary: "survived" })]),
      timersStale: false,
      sessionId: "s1",
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("survived") })
    );
  });
});

describe("the eager baseline", () => {
  it("reads the list once as soon as there is a session to read it from", () => {
    // Establishing the baseline BEFORE anything can fire is what makes the latch
    // above the rare path rather than the guaranteed one.
    const { requestTimers } = setup(null);
    expect(requestTimers).toHaveBeenCalled();
  });
});

describe("the re-read", () => {
  it("asks for a fresh list when a timer fires", () => {
    // The engine's fire event carries an id and no payload, so the only way to say
    // WHAT happened is to go and look.
    const { rerender, requestTimers } = setup(timers([]));
    requestTimers.mockClear();
    rerender({ timers: timers([]), timersStale: true, sessionId: "s1" });
    expect(requestTimers).toHaveBeenCalled();
  });

  it("asks for nothing when there is no session to ask", () => {
    const { rerender, requestTimers } = setup(null, null);
    requestTimers.mockClear();
    rerender({ timers: null, timersStale: true, sessionId: null });
    expect(requestTimers).not.toHaveBeenCalled();
  });
});
