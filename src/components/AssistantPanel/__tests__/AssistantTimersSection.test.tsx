// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AssistantTimersSection,
  describeAction,
  describeCancelConsequence,
  formatDueIn,
  formatRepeat,
} from "../AssistantTimersSection";
import type { AssistantTimerRow } from "@shared/types/ipc/assistantHost";

/**
 * The timer manager.
 *
 * What is worth pinning is what the user is told BEFORE they cancel something that
 * cannot be undone, and that a cancel cannot happen without them being told it. The
 * rendering of a row is incidental; the confirmation's content is the safeguard.
 */

function row(over: Partial<AssistantTimerRow> = {}): AssistantTimerRow {
  return {
    id: "tmr_1",
    label: "Nightly suite",
    dueAt: 2_000_000,
    createdAt: 1_000_000,
    payloadKind: "reminder",
    toolName: "",
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

function renderSection(props: Partial<React.ComponentProps<typeof AssistantTimersSection>> = {}) {
  const onCancel = vi.fn();
  const utils = render(
    <AssistantTimersSection
      timers={[row()]}
      pending={{}}
      errors={{}}
      onCancel={onCancel}
      now={1_500_000}
      {...props}
    />
  );
  return { ...utils, onCancel };
}

describe("formatDueIn", () => {
  it("counts forwards to the fire time", () => {
    const now = 1_000_000;
    expect(formatDueIn(now + 30_000, now)).toBe("in 30s");
    expect(formatDueIn(now + 5 * 60_000, now)).toBe("in 5m");
    expect(formatDueIn(now + 2 * 3_600_000, now)).toBe("in 2h");
    expect(formatDueIn(now + 3 * 86_400_000, now)).toBe("in 3d");
  });

  // A timer whose moment has passed but which has not fired is a real state: the
  // scheduler ticks on an interval, and nothing ticks at all while no engine is
  // running. "in -3m" would read as a bug rather than as a backlog.
  it("says a past-due timer is overdue rather than negative", () => {
    const now = 1_000_000;
    const text = formatDueIn(now - 3 * 60_000, now);
    expect(text).toBe("due 3m ago");
    expect(text).not.toContain("-");
  });
});

describe("formatRepeat", () => {
  it("is absent for a one-shot timer", () => {
    expect(formatRepeat(row())).toBeNull();
    // A zero interval is not a repeat either — it would render as "every 0s".
    expect(formatRepeat(row({ repeatEveryMs: 0, runCount: 4 }))).toBeNull();
  });

  it("reports progress against a bound when there is one", () => {
    // runCount is how many have ALREADY fired, so the run in hand is the next one.
    expect(formatRepeat(row({ repeatEveryMs: 3_600_000, repeatMaxRuns: 12, runCount: 3 }))).toBe(
      "every 1h · run 4 of 12"
    );
  });

  it("falls back to how many have run when the repeat is unbounded", () => {
    const text = formatRepeat(row({ repeatEveryMs: 60_000, runCount: 7 }));
    expect(text).toContain("every 1m");
    expect(text).toContain("7 so far");
  });
});

describe("describeAction", () => {
  it("distinguishes a reminder from something that will run a tool", () => {
    expect(describeAction(row({ payloadKind: "reminder" }))).toBe("Reminder");
    expect(
      describeAction(row({ payloadKind: "tool_call", toolName: "agentTask.spawnForEdits" }))
    ).toBe("Runs agentTask.spawnForEdits");
  });

  // The engine can hand back a tool_call row whose name it could not read. Claiming
  // it is a reminder would understate what is about to happen unattended.
  it("does not claim a nameless tool call is a reminder", () => {
    const text = describeAction(row({ payloadKind: "tool_call", toolName: "" }));
    expect(text).toBe("Runs a tool");
  });

  it("marks a legacy row rather than passing it off as an ordinary reminder", () => {
    expect(describeAction(row({ payloadKind: "legacy" }))).toContain("legacy");
  });

  it("tells a message apart from a reminder", () => {
    // The two are opposite promises — one carries the work out, the other waits for a
    // human — and before the engine reported "message" as its own kind this row fell
    // through to the legacy branch and told the user a scheduled instruction was a
    // stale reminder.
    const message = describeAction(row({ payloadKind: "message" }));
    expect(message).not.toContain("Reminder");
    expect(message).not.toContain("legacy");
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("describeCancelConsequence", () => {
  // D2 says a count alone is insufficient and D1 says the body must state the
  // specific consequence. For a timer the consequence has two halves, and the grant
  // revocation is the half a user would not predict.
  it("names the grants the cancel withdraws", () => {
    expect(describeCancelConsequence(row({ liveGrants: 1 }))).toContain(
      "revokes the automation grant"
    );
    expect(describeCancelConsequence(row({ liveGrants: 3 }))).toContain(
      "revokes the 3 automation grants"
    );
  });

  it("says nothing about grants when there are none to withdraw", () => {
    expect(describeCancelConsequence(row({ liveGrants: 0 }))).not.toContain("grant");
  });

  // The third state. Rendering an unreadable count as "no grants" would be a silent
  // fallback default on a destructive submit — it asserts there is no standing
  // authority to withdraw precisely when the user is deciding whether to withdraw it.
  it("admits when the grant count could not be read", () => {
    const text = describeCancelConsequence(row({ liveGrants: 0, grantsUnknown: true }));
    expect(text).toContain("could not be read");
    expect(text).toContain("grant");
    // And it must not claim a number it does not have.
    expect(text).not.toContain("revokes the 0");
  });

  it("says a repeating timer stops repeating", () => {
    expect(describeCancelConsequence(row({ repeatEveryMs: 60_000 }))).toContain("repeat again");
    expect(describeCancelConsequence(row())).not.toContain("repeat again");
  });

  it("names the tool a scheduled call would have run", () => {
    const text = describeCancelConsequence(
      row({ payloadKind: "tool_call", toolName: "terminal.sendCommand" })
    );
    expect(text).toContain("terminal.sendCommand");
  });
});

describe("the cancel control", () => {
  // The whole point of the safeguard: pressing Cancel on a row must not cancel it.
  it("confirms before cancelling anything", () => {
    const { onCancel, getByText } = renderSection();
    fireEvent.click(getByText("Cancel"));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(getByText("Cancel timer"));
    expect(onCancel).toHaveBeenCalledWith("tmr_1");
  });

  it("cancels nothing when the confirmation is declined", () => {
    const { onCancel, getByText } = renderSection();
    fireEvent.click(getByText("Cancel"));
    fireEvent.click(getByText("Keep timer"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  // Two buttons reading "Cancel" — one cancelling the timer, one cancelling the
  // cancelling — is the confusion this label exists to avoid.
  it("does not label the dismiss action 'Cancel'", () => {
    const { getByText, queryAllByText } = renderSection();
    fireEvent.click(getByText("Cancel"));
    // With the dialog open there must be exactly ONE bare "Cancel" in the document —
    // the row's own trigger. The dialog taking the default label would make two, one
    // cancelling the timer and one cancelling the cancelling.
    const bare = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Cancel"
    );
    expect(bare).toHaveLength(1);
    expect(queryAllByText("Keep timer").length).toBeGreaterThan(0);
  });

  // The dialog describes the row it was OPENED on. A refresh landing mid-read must
  // not change what the user is about to agree to.
  it("keeps describing the timer it was opened on when the list changes underneath", () => {
    const { getByText, rerender, onCancel } = renderSection({
      timers: [row({ id: "tmr_1", label: "Nightly suite" })],
    });
    fireEvent.click(getByText("Cancel"));
    expect(document.body.textContent).toContain("Nightly suite");

    rerender(
      <AssistantTimersSection
        timers={[row({ id: "tmr_2", label: "Something else" })]}
        pending={{}}
        errors={{}}
        onCancel={onCancel}
        now={1_500_000}
      />
    );
    // Still the original timer, and confirming still retires THAT one.
    expect(document.body.textContent).toContain("Nightly suite");
    fireEvent.click(getByText("Cancel timer"));
    expect(onCancel).toHaveBeenCalledWith("tmr_1");
  });

  it("makes the control inert and says so while a cancel is in flight", () => {
    const { queryByText, getByText, onCancel } = renderSection({ pending: { tmr_1: true } });
    expect(queryByText("Cancel")).toBeNull();
    const button = getByText("Cancelling…") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Inert means inert: a second press must not open a second confirmation for a
    // cancel the engine is already settling.
    fireEvent.click(button);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });

  it("shows a failed cancel against the row that failed", () => {
    const { container } = renderSection({ errors: { tmr_1: "No timer with id tmr_1" } });
    expect(container.textContent).toContain("No timer with id tmr_1");
  });
});

describe("the row", () => {
  it("says what the timer does, not just what it is called", () => {
    const { container } = renderSection({
      timers: [
        row({
          label: "Kick off the deploy check",
          payloadKind: "tool_call",
          toolName: "agentTask.spawnForEdits",
          targetWorktreeId: "/p/app",
        }),
      ],
    });
    expect(container.textContent).toContain("Kick off the deploy check");
    expect(container.textContent).toContain("Runs agentTask.spawnForEdits");
    expect(container.textContent).toContain("/p/app");
  });

  it("renders one control per timer", () => {
    const { getAllByText } = renderSection({
      timers: [row({ id: "tmr_1" }), row({ id: "tmr_2" }), row({ id: "tmr_3" })],
    });
    expect(getAllByText("Cancel")).toHaveLength(3);
  });
});
