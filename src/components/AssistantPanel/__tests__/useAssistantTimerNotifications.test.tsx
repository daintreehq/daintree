// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantTimerNotifications } from "../useAssistantTimerNotifications";
import type { AssistantTimers } from "@/store/assistantStore";
import type { AssistantTimerOutcomeRow } from "@shared/types/ipc/assistantHost";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (p: unknown) => notifyMock(p) }));

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

function setup(initial: AssistantTimers | null, sessionId: string | null = "s1") {
  const requestTimers = vi.fn();
  const view = renderHook(
    (props: { timers: AssistantTimers | null; timersStale: boolean; sessionId: string | null }) =>
      useAssistantTimerNotifications({ ...props, requestTimers }),
    { initialProps: { timers: initial, timersStale: false, sessionId } }
  );
  return { ...view, requestTimers };
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
        // grid-bar: the least-restricted surface that crosses a pane boundary. A
        // timer fires outside whatever the user is looking at, but a reminder
        // landing on time is not an interruption, so it is not a toast.
        placement: "grid-bar",
        type: "info",
        message: "Reminder: stand-up",
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
      expect.objectContaining({ type: "error", title: "Scheduled timer failed" })
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
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ supersedeKey: "assistant-timer:tmr_1" })
    );
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
