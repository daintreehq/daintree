// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import { ScheduleRunConfirmDialog } from "../ScheduleRunConfirmDialog";
import {
  cancelScheduleRunConfirmations,
  requestScheduleRunConfirmation,
} from "@/store/scheduleRunConfirmStore";

// No jest-dom in this repo — plain DOM reads only.

function ask(scheduleName: string, policy: "skip" | "replace", openRunCount = 1) {
  let answer: boolean | undefined;
  act(() => {
    void requestScheduleRunConfirmation({ scheduleName, policy, openRunCount }).then((approved) => {
      answer = approved;
    });
  });
  return () => answer;
}

function footerButton(role: "cancel" | "confirm"): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-confirm-role="${role}"]`);
  if (!button) throw new Error(`no ${role} footer action`);
  return button;
}

afterEach(() => {
  act(() => cancelScheduleRunConfirmations());
  cleanup();
});

describe("ScheduleRunConfirmDialog (#15980)", () => {
  it("renders nothing when no Run now is waiting", () => {
    render(<ScheduleRunConfirmDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers to run alongside an open run under the skip policy", async () => {
    const answer = ask("Nightly triage", "skip");
    render(<ScheduleRunConfirmDialog />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Run 'Nightly triage' alongside its open run?");
    expect(dialog.textContent).toContain("starts another agent beside it");
    expect(footerButton("confirm").textContent).toContain("Start another run");
    // Running is the thing in question, so a reflexive Enter backs out.
    await waitFor(() => expect(document.activeElement).toBe(footerButton("cancel")));

    fireEvent.click(footerButton("confirm"));
    await waitFor(() => expect(answer()).toBe(true));
  });

  it("says what replacing closes, for several open runs", async () => {
    const answer = ask("Nightly triage", "replace", 2);
    render(<ScheduleRunConfirmDialog />);

    // Closing terminals is the destructive variant, an alert dialog.
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Replace the open runs of 'Nightly triage'?");
    expect(dialog.textContent).toContain("closes the open runs' terminals");
    expect(footerButton("confirm").textContent).toContain("Replace run");

    fireEvent.click(footerButton("cancel"));
    await waitFor(() => expect(answer()).toBe(false));
  });

  it("backs out on Escape and moves on to the next waiting Run now", async () => {
    const first = ask("Nightly triage", "replace");
    const second = ask("Weekly cleanup", "skip");
    render(<ScheduleRunConfirmDialog />);

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

    await waitFor(() => expect(first()).toBe(false));
    expect(screen.getByRole("dialog").textContent).toContain("Run 'Weekly cleanup'");
    expect(second()).toBeUndefined();
  });
});
