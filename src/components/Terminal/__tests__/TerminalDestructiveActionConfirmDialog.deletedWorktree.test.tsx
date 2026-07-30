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

const openDockPopoverId = vi.hoisted(() => ({ current: null as string | null }));

// The derivation behind this is exercised against the real store shape in
// dockPanelVisibility.test.ts; here it is the input to the tier choice.
vi.mock("@/components/Layout/useOpenDockPopoverId", () => ({
  useOpenDockPopoverId: () => openDockPopoverId.current,
}));

import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { TerminalDestructiveActionConfirmDialog } from "../TerminalDestructiveActionConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";

beforeEach(() => {
  cleanup();
  dispatch.mockClear();
  openDockPopoverId.current = null;
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

/**
 * A dock popover paints above the standard modal tier, so this confirm was
 * drawn underneath the docked terminal it was about while still holding focus
 * — a destructive prompt the user agrees to without reading (#11505).
 */
describe("TerminalDestructiveActionConfirmDialog — layering over a dock popover", () => {
  /**
   * The z-tier a surface resolved to, read off the rendered element rather than
   * compared against a hard-coded token so the tier's value stays free to change.
   */
  function tierClassOf(el: Element): string | undefined {
    return Array.from(el.classList).find((c) => c.startsWith("z-["));
  }

  /** What each `zIndex` option actually renders, for comparison. */
  function referenceTier(zIndex: "modal" | "nested"): string | undefined {
    const { unmount } = render(
      <AppDialog isOpen onClose={() => {}} zIndex={zIndex}>
        <span>reference</span>
      </AppDialog>
    );
    const tier = tierClassOf(screen.getByRole("dialog"));
    unmount();
    return tier;
  }

  it("keeps the standard tier when no dock popover is on screen", () => {
    stage(1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(tierClassOf(screen.getByRole("alertdialog"))).toBe(referenceTier("modal"));
  });

  it("clears a dock popover that is on screen", () => {
    openDockPopoverId.current = "dock-1";
    stage(1);
    render(<TerminalDestructiveActionConfirmDialog />);

    expect(tierClassOf(screen.getByRole("alertdialog"))).toBe(referenceTier("nested"));
  });

  it("distinguishes the two tiers at all", () => {
    // Guards the two assertions above: if both options ever rendered the same
    // token they would pass while the bug was fully present.
    expect(referenceTier("modal")).not.toBe(referenceTier("nested"));
  });
});
