// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// ConfirmDialog's scroll-shadow hook observes its scroll container, which jsdom
// does not implement. Declared as a real ResizeObserver so no cast is needed.
class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// Typed explicitly so asserting on `toHaveBeenCalledWith` needs no cast.
const dispatch = vi.fn<(id: string, args: unknown, opts: unknown) => Promise<void>>(() =>
  Promise.resolve()
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args: unknown, opts: unknown) => dispatch(id, args, opts),
  },
}));

vi.mock("@/lib/accessibility", () => ({
  closeAndAnnounce: (clear: () => void) => clear(),
}));

import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { TerminalDestructiveActionConfirmDialog } from "../TerminalDestructiveActionConfirmDialog";

beforeEach(() => {
  cleanup();
  dispatch.mockClear();
  useTerminalPendingDestructiveActionStore.getState().clear();
});

function stageEndAll(targetCount: number, runningAgentCount = 0): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "worktreeEndAll",
    targetCount,
    runningAgentCount,
    worktreeId: "wt-1",
  });
}

describe("TerminalDestructiveActionConfirmDialog — worktree end-all (#11345)", () => {
  it("names the count in the confirm button", () => {
    stageEndAll(3);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "End 3 sessions" })).toBeTruthy();
  });

  it("uses the singular noun for one session", () => {
    stageEndAll(1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "End 1 session" })).toBeTruthy();
  });

  it("frames the loss as permanent and unrecoverable, unlike trashing", () => {
    stageEndAll(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/can't be restored/)).toBeTruthy();
  });

  it("warns when a session has a running agent", () => {
    stageEndAll(2, 1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/1 has a running agent/)).toBeTruthy();
  });

  it("stays silent about agents when none are running", () => {
    stageEndAll(2, 0);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.queryByText(/running agent/)).toBeNull();
  });

  it("ends the worktree's sessions on confirm", () => {
    stageEndAll(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "End 2 sessions" }));

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.endAll",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing while the dialog is merely open", () => {
    stageEndAll(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the worktree id is missing from the snapshot", () => {
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "worktreeEndAll",
      targetCount: 2,
      runningAgentCount: 0,
    });
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "End 2 sessions" }));

    expect(dispatch).not.toHaveBeenCalled();
  });
});

function stageClearHistory(): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "worktreeClearHistory",
    targetCount: 0,
    runningAgentCount: 0,
    worktreeId: "wt-1",
  });
}

describe("TerminalDestructiveActionConfirmDialog — worktree clear-history (#11345)", () => {
  it("uses count-free copy rather than a misleading '0 sessions'", () => {
    stageClearHistory();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "Clear session history" })).toBeTruthy();
    expect(screen.getByText("Clear session history for this worktree?")).toBeTruthy();
    expect(screen.queryByText(/0 session/)).toBeNull();
  });

  it("clears the worktree's history on confirm", () => {
    stageClearHistory();
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Clear session history" }));

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.clearHistory",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing while the dialog is merely open", () => {
    stageClearHistory();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the worktree id is missing from the snapshot", () => {
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "worktreeClearHistory",
      targetCount: 0,
      runningAgentCount: 0,
    });
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Clear session history" }));

    expect(dispatch).not.toHaveBeenCalled();
  });
});
