// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantOperationsDeck } from "../AssistantOperationsDeck";
import type { AssistantTimerRow } from "@shared/types/ipc/assistantHost";

/**
 * The deck's clock.
 *
 * A countdown is the one thing on this surface whose whole job is to change on its
 * own, and it was computed from a `Date.now()` read during render — a reading, not a
 * clock. Nothing re-rendered the deck, so "in 10s" sat there while the timer beneath
 * it came due and fired. These tests are about MOVEMENT, so they assert that the same
 * component shows a different number as the wall clock advances, not that any
 * particular string is produced (formatDueIn owns that, and is tested where it lives).
 */

const NOW = 1_700_000_000_000;

function row(over: Partial<AssistantTimerRow> = {}): AssistantTimerRow {
  return {
    id: "tmr_1",
    label: "Spawn new default agent terminal",
    dueAt: NOW + 10_000,
    createdAt: NOW,
    payloadKind: "tool_call",
    toolName: "agentTask.spawnForEdits",
    runCount: 0,
    repeatEveryMs: 0,
    repeatMaxRuns: 0,
    repeatUntilAt: 0,
    targetWorktreeId: "",
    targetTerminalId: "",
    liveGrants: 1,
    grantsUnknown: false,
    ...over,
  };
}

function renderDeck(rows: AssistantTimerRow[] = [row()]) {
  return render(
    <AssistantOperationsDeck
      operations={{
        inbox: [],
        workflows: [],
        agents: [],
        async: [],
        timers: [],
        audit: [],
        at: NOW,
      }}
      timers={{ rows, outcomes: [], takenAt: NOW, readFailed: false }}
      timersStale={false}
      timerCancelPending={{}}
      timerCancelErrors={{}}
      onCancelTimer={vi.fn()}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("the countdown", () => {
  it("counts down without anything else changing", () => {
    const { container } = renderDeck();
    expect(container.textContent).toContain("in 10s");

    act(() => void vi.advanceTimersByTime(3_000));
    expect(container.textContent).toContain("in 7s");
    expect(container.textContent).not.toContain("in 10s");

    act(() => void vi.advanceTimersByTime(6_000));
    expect(container.textContent).toContain("in 1s");
  });

  it("crosses into overdue on its own", () => {
    // The state the user actually hit: the timer's moment arrives while they are
    // looking at it. Before the clock ticked, a due timer sat at its original
    // countdown forever, which read as "it never fired".
    const { container } = renderDeck();
    act(() => void vi.advanceTimersByTime(30_000));
    expect(container.textContent).toContain("due");
    expect(container.textContent).toContain("ago");
  });

  it("stops ticking once the deck is closed", () => {
    // The deck only exists while it is open; an interval that outlived it would be a
    // leak that re-renders an unmounted tree on every second of the session.
    const { unmount } = renderDeck();
    const cleared = vi.spyOn(globalThis, "clearInterval");
    unmount();
    expect(cleared).toHaveBeenCalled();
  });
});
