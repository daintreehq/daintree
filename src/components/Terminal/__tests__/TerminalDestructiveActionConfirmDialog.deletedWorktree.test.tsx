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

function stageGroup(): void {
  useTerminalPendingDestructiveActionStore.getState().request({
    kind: "deletedWorktreeGroupDismiss",
    targetCount: 3,
    runningAgentCount: 1,
    preview: [
      {
        worktreeId: "wt-1",
        worktreeTitle: "feature/alpha",
        terminals: [
          { terminalId: "t1", terminalTitle: "Claude", hasRunningAgent: true },
          { terminalId: "t2", terminalTitle: "zsh", hasRunningAgent: false },
        ],
      },
      {
        worktreeId: "wt-2",
        worktreeTitle: "feature/beta",
        terminals: [{ terminalId: "t3", terminalTitle: "Codex", hasRunningAgent: false }],
      },
    ],
  });
}

describe("TerminalDestructiveActionConfirmDialog — grouped deleted-worktree clear (#11260)", () => {
  it("previews the actual terminals rather than only a count (D2)", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("zsh")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("groups the previewed terminals under the worktree each came from", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText("feature/alpha")).toBeTruthy();
    expect(screen.getByText("feature/beta")).toBeTruthy();
  });

  it("names both counts in the title", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText("Close 3 terminals from 2 deleted worktrees?")).toBeTruthy();
  });

  it("fans the single-worktree executor over every previewed worktree on confirm", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close 3 terminals" }));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.trashAll",
      { worktreeId: "wt-1", confirmed: true },
      { source: "user" }
    );
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.sessions.trashAll",
      { worktreeId: "wt-2", confirmed: true },
      { source: "user" }
    );
  });

  it("dispatches nothing when the preview is empty", () => {
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "deletedWorktreeGroupDismiss",
      targetCount: 0,
      runningAgentCount: 0,
      preview: [],
    });
    render(<TerminalDestructiveActionConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close 0 terminals" }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still points at dragging as the alternative", () => {
    stageGroup();
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(screen.getByText(/Drag them to another worktree instead/)).toBeTruthy();
  });
});
