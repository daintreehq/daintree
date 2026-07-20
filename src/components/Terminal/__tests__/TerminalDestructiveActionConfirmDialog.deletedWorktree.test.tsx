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

function stage(targetCount: number, runningAgentCount = 0): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "deletedWorktreeDismiss",
    targetCount,
    runningAgentCount,
    worktreeId: "wt-1",
  });
}

describe("TerminalDestructiveActionConfirmDialog — deleted-worktree dismiss", () => {
  it("names the count in the confirm button", () => {
    stage(3);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "Close 3 terminals" })).toBeTruthy();
  });

  it("uses the singular noun for one terminal", () => {
    stage(1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByRole("button", { name: "Close 1 terminal" })).toBeTruthy();
  });

  it("points at dragging as the alternative to closing", () => {
    stage(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/Drag them to another worktree instead/)).toBeTruthy();
  });

  it("warns when a terminal still has a running agent", () => {
    stage(2, 1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/1 still has a running agent/)).toBeTruthy();
  });

  it("stays silent about agents when none are running", () => {
    stage(2, 0);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.queryByText(/running agent/)).toBeNull();
  });

  it("trashes the worktree's sessions on confirm", () => {
    stage(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close 2 terminals" }));

    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.trashAll",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing while the dialog is merely open", () => {
    stage(2);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(dispatch).not.toHaveBeenCalled();
  });
});
