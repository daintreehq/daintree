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

import { repaintAssistantAfterTransition, suppressSidebarResizes } from "../sidebarToggle";
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

  it("includes the assistant terminal when it is a live panel", () => {
    getHelpPanelStateMock.mockReturnValue({ terminalId: "assistant-1" });
    setup(
      [
        { id: "p-grid", location: "grid", worktreeId: "wt-a" },
        { id: "assistant-1", location: "dock", worktreeId: "wt-a" },
      ],
      "wt-a"
    );

    suppressSidebarResizes();

    // The dock-located assistant terminal is suppressed even though dock panels
    // are otherwise excluded — it animates alongside the sidebar gesture.
    expect(suppressMock).toHaveBeenCalledWith(["p-grid", "assistant-1"], SIDEBAR_TOGGLE_LOCK_MS);
  });

  it("omits the assistant terminal when it is not yet a registered panel", () => {
    getHelpPanelStateMock.mockReturnValue({ terminalId: "assistant-1" });
    setup([{ id: "p-grid", location: "grid", worktreeId: "wt-a" }], "wt-a");

    suppressSidebarResizes();

    expect(suppressMock).toHaveBeenCalledWith(["p-grid"], SIDEBAR_TOGGLE_LOCK_MS);
  });
});

describe("repaintAssistantAfterTransition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHelpPanelStateMock.mockReturnValue({ terminalId: null });
  });

  it("fires one corrective repaint for the assistant terminal", () => {
    getHelpPanelStateMock.mockReturnValue({ terminalId: "assistant-1" });

    repaintAssistantAfterTransition();

    expect(repaintForRevealMock).toHaveBeenCalledTimes(1);
    expect(repaintForRevealMock).toHaveBeenCalledWith("assistant-1");
  });

  it("does not clear the resize lock — the suppression timer owns the unlock", () => {
    // reconcileGeometryFresh inside repaintForReveal is lock-exempt, so the
    // corrective resize lands while the lock stays armed. Clearing it here would
    // defeat the dead-man TTL that gates the ResizeObserver debounce tail.
    getHelpPanelStateMock.mockReturnValue({ terminalId: "assistant-1" });

    repaintAssistantAfterTransition();

    expect(lockResizeMock).not.toHaveBeenCalled();
  });

  it("is a no-op when no assistant terminal is present", () => {
    getHelpPanelStateMock.mockReturnValue({ terminalId: null });

    expect(() => repaintAssistantAfterTransition()).not.toThrow();
    expect(repaintForRevealMock).not.toHaveBeenCalled();
  });
});
