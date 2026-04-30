// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const suppressMock = vi.hoisted(() => vi.fn());
const getPanelStateMock = vi.hoisted(() => vi.fn());
const getWorktreeSelectionStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: {
    suppressResizesDuringLayoutTransition: suppressMock,
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: getPanelStateMock },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: getWorktreeSelectionStateMock },
}));

import { suppressSidebarResizes } from "../sidebarToggle";
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
});
