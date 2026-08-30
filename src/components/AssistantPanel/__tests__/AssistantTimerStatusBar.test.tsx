// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantTimerStatusBar, soonest } from "../AssistantTimerStatusBar";
import type { AssistantTimerRow } from "@shared/types/ipc/assistantHost";

/**
 * The countdown strip above the composer.
 *
 * What is worth pinning is that it MOVES, that it leads with the right timer, and that
 * it stops moving when nobody can see it. The exact wording of a duration belongs to
 * `formatDueIn`, which is tested where it lives.
 */

const NOW = 1_700_000_000_000;

function row(over: Partial<AssistantTimerRow> = {}): AssistantTimerRow {
  return {
    id: "tmr_1",
    label: "Start default agent terminal",
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
    liveGrants: 0,
    grantsUnknown: false,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("what it leads with", () => {
  it("picks the timer firing soonest, not the first in the list", () => {
    const picked = soonest([
      row({ id: "late", dueAt: NOW + 90_000 }),
      row({ id: "next", dueAt: NOW + 5_000 }),
      row({ id: "middle", dueAt: NOW + 30_000 }),
    ]);
    expect(picked?.id).toBe("next");
  });

  it("leads with an overdue timer over a healthy one", () => {
    // A timer past due that has not fired is the reading a user most needs; burying it
    // under a later timer behaving normally hides the only case worth surfacing.
    const picked = soonest([
      row({ id: "soon", dueAt: NOW + 5_000 }),
      row({ id: "late", dueAt: NOW - 5_000 }),
    ]);
    expect(picked?.id).toBe("late");
  });

  it("renders nothing at all when there is nothing scheduled", () => {
    const { container } = render(<AssistantTimerStatusBar timers={[]} visible />);
    expect(container.textContent).toBe("");
  });
});

describe("the countdown", () => {
  it("falls as the clock advances, with no other input", () => {
    const { container } = render(<AssistantTimerStatusBar timers={[row()]} visible />);
    expect(container.textContent).toContain("in 10s");
    act(() => void vi.advanceTimersByTime(4_000));
    expect(container.textContent).toContain("in 6s");
  });

  it("says what the timer will DO, not just when", () => {
    // "Reminder" and "Runs agentTask.spawnForEdits" are very different things to leave
    // running unattended, and the strip is the only place most users will see either.
    const { container } = render(<AssistantTimerStatusBar timers={[row()]} visible />);
    expect(container.textContent).toContain("Runs agentTask.spawnForEdits");
    expect(container.textContent).toContain("Start default agent terminal");
  });

  it("counts the ones it is not showing", () => {
    const { container } = render(
      <AssistantTimerStatusBar timers={[row(), row({ id: "b", dueAt: NOW + 60_000 })]} visible />
    );
    expect(container.textContent).toContain("+1");
  });
});

describe("when nobody is watching", () => {
  it("does not tick while the panel is hidden", () => {
    // The panel hides by sliding off-canvas rather than unmounting, so an ungated
    // interval would re-render this strip once a second for the rest of the session.
    const { container, rerender } = render(
      <AssistantTimerStatusBar timers={[row()]} visible={false} />
    );
    const before = container.textContent;
    act(() => void vi.advanceTimersByTime(5_000));
    expect(container.textContent).toBe(before);

    // ...and it catches up the moment it is shown again, rather than resuming from a
    // reading taken before the pause.
    rerender(<AssistantTimerStatusBar timers={[row()]} visible />);
    expect(container.textContent).toContain("in 5s");
  });
});

describe("the way into the deck", () => {
  it("is a button when there is somewhere to go", () => {
    const onOpenDeck = vi.fn();
    const { getByTestId } = render(
      <AssistantTimerStatusBar timers={[row()]} visible onOpenDeck={onOpenDeck} />
    );
    const el = getByTestId("assistant-timer-status");
    expect(el.tagName).toBe("BUTTON");
    el.click();
    expect(onOpenDeck).toHaveBeenCalled();
  });

  it("is inert markup when there is not", () => {
    // A dead button would put a focus stop above the composer on every turn that buys
    // a keyboard user nothing.
    const { getByTestId } = render(<AssistantTimerStatusBar timers={[row()]} visible />);
    expect(getByTestId("assistant-timer-status").tagName).not.toBe("BUTTON");
  });
});
