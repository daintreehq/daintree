// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendWakeContinueNotes = vi.hoisted(() => vi.fn(async () => {}));
const dismissWakeContinue = vi.hoisted(() => vi.fn());
vi.mock("@/services/wakeContinue/wakeContinue", () => ({
  DEFAULT_CONTINUE_NOTE: "Please pick up where you left off.",
  sendWakeContinueNotes,
  dismissWakeContinue,
}));

import { useProjectStore } from "@/store/projectStore";
import { useWakeContinueStore, type WakeContinueOffer } from "@/store/wakeContinueStore";
import { WakeContinueNotice } from "../WakeContinueNotice";

function entry(
  terminalId: string,
  outcome: "resumed" | "fresh" | "held"
): WakeContinueOffer["entries"][number] {
  return {
    terminalId,
    title: `Agent ${terminalId}`,
    agentId: "claude",
    worktreeId: null,
    outcome,
    restoredAt: 1,
  };
}

function offer(overrides: Partial<WakeContinueOffer> = {}): WakeContinueOffer {
  return {
    id: "wake-1",
    projectId: "p1",
    entries: [entry("a", "resumed"), entry("b", "resumed"), entry("c", "fresh")],
    phase: "offered",
    ...overrides,
  };
}

beforeEach(() => {
  useProjectStore.setState({
    currentProject: { id: "p1" } as ReturnType<typeof useProjectStore.getState>["currentProject"],
  });
});

afterEach(() => {
  cleanup();
  sendWakeContinueNotes.mockClear();
  dismissWakeContinue.mockClear();
  useWakeContinueStore.setState({ offer: null, dialogOpen: false });
  useProjectStore.setState({ currentProject: null });
});

describe("WakeContinueNotice", () => {
  it("shows nothing without an offer for the project on screen", () => {
    useWakeContinueStore.setState({ offer: offer({ projectId: "other" }) });
    render(<WakeContinueNotice />);
    expect(screen.queryByTestId("wake-continue-notice")).toBeNull();
  });

  it("offers the note for the resumed agents, and × withdraws it", () => {
    useWakeContinueStore.setState({ offer: offer() });
    render(<WakeContinueNotice />);
    expect(screen.getByTestId("wake-continue-notice").textContent).toContain("2 agents resumed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissWakeContinue).toHaveBeenCalledTimes(1);
    expect(sendWakeContinueNotes).not.toHaveBeenCalled();
  });

  it("sends the edited note from the review dialog, listing who gets none", async () => {
    useWakeContinueStore.setState({ offer: offer() });
    render(<WakeContinueNotice />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review note" }));
    });

    const entries = await screen.findByTestId("wake-continue-entries");
    expect(entries.textContent).toContain("Started a new session — no note");

    const note = screen.getByTestId("wake-continue-note") as HTMLTextAreaElement;
    expect(note.value).toBe("Please pick up where you left off.");
    fireEvent.change(note, { target: { value: "Finish the migration, then stop." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to 2 agents" }));
    });
    expect(sendWakeContinueNotes).toHaveBeenCalledWith("Finish the migration, then stop.");
  });

  it("won't send a blank note", async () => {
    useWakeContinueStore.setState({ offer: offer(), dialogOpen: true });
    render(<WakeContinueNotice />);
    const note = (await screen.findByTestId("wake-continue-note")) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "   " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send to 2 agents" }));
    });
    expect(sendWakeContinueNotes).not.toHaveBeenCalled();
  });

  it("reports progress once sending, and × stops it", () => {
    useWakeContinueStore.setState({
      offer: offer({
        phase: "sending",
        entries: [
          { ...entry("a", "resumed"), delivery: { status: "sent" } },
          entry("b", "resumed"),
        ],
      }),
    });
    render(<WakeContinueNotice />);
    expect(screen.getByTestId("wake-continue-notice").textContent).toContain("1 of 2 agents sent");
    fireEvent.click(screen.getByRole("button", { name: "Stop sending" }));
    expect(dismissWakeContinue).toHaveBeenCalledTimes(1);
  });
});
