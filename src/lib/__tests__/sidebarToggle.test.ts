// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const suppressMock = vi.hoisted(() => vi.fn());
const lockResizeMock = vi.hoisted(() => vi.fn());
const repaintForRevealMock = vi.hoisted(() => vi.fn());
const lockMock = vi.hoisted(() => vi.fn());
const getPanelStateMock = vi.hoisted(() => vi.fn());
const getWorktreeSelectionStateMock = vi.hoisted(() => vi.fn());
const getHelpPanelStateMock = vi.hoisted(() =>
  vi.fn(() => ({ terminalId: null }) as { terminalId: string | null })
);

vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: {
    suppressResizesDuringLayoutTransition: suppressMock,
    lockResize: lockResizeMock,
    repaintForReveal: repaintForRevealMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: getPanelStateMock },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: getWorktreeSelectionStateMock },
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: { getState: getHelpPanelStateMock },
}));

vi.mock("../layoutTransitionLock", () => ({
  lockSidebarLayoutTransition: lockMock,
}));

import { releaseAssistantResizeLock, suppressSidebarResizes } from "../sidebarToggle";
import { SIDEBAR_TOGGLE_LOCK_MS } from "../terminalLayout";

type PanelFixture = {
  id: string;
  location: "grid" | "dock" | "trash" | "background";
  worktreeId: string | null;
};

function setup(panels: PanelFixture[], activeWorktreeId: string | null) {
  getPanelStateMock.mockReturnValue({
    panelIds: panels.map((p) => p.id),
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
  });
  getWorktreeSelectionStateMock.mockReturnValue({ activeWorktreeId });
}

describe("suppressSidebarResizes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("suppresses resizes for grid panels of the active worktree", () => {
    setup(
      [
        { id: "p-1", location: "grid", worktreeId: "wt-a" },
        { id: "p-2", location: "grid", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledTimes(1);
    expect(suppressMock).toHaveBeenCalledWith(["p-1", "p-2"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("excludes dock panels from the suppression set", () => {
    setup(
      [
        { id: "p-grid", location: "grid", worktreeId: "wt-a" },
        { id: "p-dock", location: "dock", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-grid"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("excludes panels belonging to other worktrees", () => {
    setup(
      [
        { id: "p-active", location: "grid", worktreeId: "wt-a" },
        { id: "p-other", location: "grid", worktreeId: "wt-b" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-active"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("excludes trash and background panels from the suppression set", () => {
    setup(
      [
        { id: "p-grid", location: "grid", worktreeId: "wt-a" },
        { id: "p-trash", location: "trash", worktreeId: "wt-a" },
        { id: "p-bg", location: "background", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-grid"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("handles a null activeWorktreeId without crashing", () => {
    setup([{ id: "p-1", location: "grid", worktreeId: "wt-a" }], null);

    expect(() => suppressSidebarResizes()).not.toThrow();
    expect(suppressMock).toHaveBeenCalledWith([], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("locks the sidebar layout transition for the same window", () => {
    setup([{ id: "p-1", location: "grid", worktreeId: "wt-a" }], "wt-a");

    suppressSidebarResizes();

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(lockMock).toHaveBeenCalledWith(SIDEBAR_TOGGLE_LOCK_MS);
  });
});

describe("releaseAssistantResizeLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHelpPanelStateMock.mockReturnValue({ terminalId: null });
  });

  it("unlocks the assistant terminal and fires one corrective repaint", () => {
    getHelpPanelStateMock.mockReturnValue({ terminalId: "assistant-1" });

    releaseAssistantResizeLock();

    expect(lockResizeMock).toHaveBeenCalledWith("assistant-1", false);
    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-1");
  });

  it("unlocks before repainting so the corrective resize isn't swallowed by the lock", () => {
    getHelpPanelStateMock.mockReturnValue({ terminalId: "assistant-1" });

    releaseAssistantResizeLock();

    // repaintForReveal's geometry reconciliation is gated by the resize lock,
    // so the unlock must be ordered strictly before the repaint.
    const unlockOrder = lockResizeMock.mock.invocationCallOrder[0];
    const repaintOrder = repaintForRevealMock.mock.invocationCallOrder[0];
    expect(unlockOrder).toBeLessThan(repaintOrder);
  });

  it("is a no-op when no assistant terminal is present", () => {
    getHelpPanelStateMock.mockReturnValue({ terminalId: null });

    expect(() => releaseAssistantResizeLock()).not.toThrow();
    expect(lockResizeMock).not.toHaveBeenCalled();
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });
});
