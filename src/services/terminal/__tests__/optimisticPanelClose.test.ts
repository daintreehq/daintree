// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setFocusedMock, focusMock } = vi.hoisted(() => ({
  setFocusedMock: vi.fn(),
  focusMock: vi.fn(),
}));

interface MockPanel {
  id: string;
  location?: string;
  worktreeId?: string;
}

const mockState = {
  focusedId: null as string | null,
  panelIds: [] as string[],
  panelsById: {} as Record<string, MockPanel>,
  setFocused: setFocusedMock,
  getTabGroups: undefined as
    | ((
        location: "grid",
        worktreeId?: string
      ) => Array<{ panelIds: string[]; activeTabId: string }>)
    | undefined,
};

vi.mock("@/store", () => ({
  panelStoreApi: { getState: () => mockState },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { focus: focusMock },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import {
  requestPanelClose,
  isOptimisticallyClosing,
  getClosingIdsSnapshot,
  flushOptimisticCloses,
  hasPendingOptimisticCloses,
  subscribeOptimisticClose,
  __resetOptimisticPanelCloseForTests,
} from "../optimisticPanelClose";

describe("optimisticPanelClose", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetOptimisticPanelCloseForTests();
    setFocusedMock.mockClear();
    focusMock.mockClear();
    mockState.focusedId = null;
    mockState.panelIds = [];
    mockState.panelsById = {};
    mockState.getTabGroups = undefined;
    document.body.innerHTML = "";
    // The real store setter updates focusedId; mirror that so the deferred
    // focus guard (`focusedId === target`) sees the committed value.
    setFocusedMock.mockImplementation((id: string | null) => {
      mockState.focusedId = id;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the panel immediately and defers the canonical commit", () => {
    const commit = vi.fn();
    const gridCell = document.createElement("div");
    gridCell.dataset.terminalId = "p1";
    const panel = document.createElement("div");
    panel.dataset.panelId = "p1";
    gridCell.appendChild(panel);
    document.body.appendChild(gridCell);

    requestPanelClose({ hideIds: ["p1"], commit });

    expect(isOptimisticallyClosing("p1")).toBe(true);
    expect(gridCell.style.display).toBe("none");
    expect(gridCell.dataset.optimisticClosing).toBe("true");
    expect(commit).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(commit).toHaveBeenCalledTimes(1);
    // Once the commit has trashed the panel the optimistic overlay is cleared.
    expect(getClosingIdsSnapshot().size).toBe(0);
  });

  it("coalesces a burst of closes into a single deferred flush", () => {
    const c1 = vi.fn();
    const c2 = vi.fn();
    const c3 = vi.fn();
    requestPanelClose({ hideIds: ["a"], commit: c1 });
    requestPanelClose({ hideIds: ["b"], commit: c2 });
    requestPanelClose({ hideIds: ["c"], commit: c3 });

    expect(isOptimisticallyClosing("a")).toBe(true);
    expect(isOptimisticallyClosing("c")).toBe(true);
    expect(hasPendingOptimisticCloses()).toBe(true);

    vi.runAllTimers();

    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).toHaveBeenCalledTimes(1);
    expect(c3).toHaveBeenCalledTimes(1);
    expect(getClosingIdsSnapshot().size).toBe(0);
  });

  it("ignores a duplicate close for an already-closing panel", () => {
    const first = vi.fn();
    const second = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit: first });
    requestPanelClose({ hideIds: ["p1"], commit: second });

    vi.runAllTimers();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("flushOptimisticCloses runs pending commits synchronously", () => {
    const commit = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit });

    flushOptimisticCloses();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(hasPendingOptimisticCloses()).toBe(false);
    expect(getClosingIdsSnapshot().size).toBe(0);
  });

  it("isolates a commit failure so the rest of the batch still runs", () => {
    const ok = vi.fn();
    const boom = vi.fn(() => {
      throw new Error("commit failed");
    });
    requestPanelClose({ hideIds: ["a"], commit: boom });
    requestPanelClose({ hideIds: ["b"], commit: ok });

    expect(() => vi.runAllTimers()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does not notify React subscribers on the visual hide path", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOptimisticClose(listener);

    requestPanelClose({ hideIds: ["p1"], commit: vi.fn() });
    expect(listener).not.toHaveBeenCalled();

    vi.runAllTimers(); // flush clears lifecycle state after canonical commit
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it("advances focus to a surviving same-worktree panel when the focused panel closes", () => {
    mockState.focusedId = "p1";
    mockState.panelIds = ["p1", "p2"];
    mockState.panelsById = {
      p1: { id: "p1", location: "grid", worktreeId: "w1" },
      p2: { id: "p2", location: "grid", worktreeId: "w1" },
    };

    requestPanelClose({ hideIds: ["p1"], commit: vi.fn() });

    // The logical focus retarget is synchronous — a rapid Cmd+W stream relies
    // on it — but the xterm DOM focus is deferred past the close paint.
    expect(setFocusedMock).toHaveBeenCalledWith("p2");
    expect(focusMock).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(focusMock).toHaveBeenCalledWith("p2");
  });

  it("advances focus to the next visual grid panel, not the first panel", () => {
    mockState.focusedId = "p2";
    mockState.panelIds = ["p1", "p2", "p3", "p4"];
    mockState.panelsById = {
      p1: { id: "p1", location: "grid", worktreeId: "w1" },
      p2: { id: "p2", location: "grid", worktreeId: "w1" },
      p3: { id: "p3", location: "grid", worktreeId: "w1" },
      p4: { id: "p4", location: "grid", worktreeId: "w1" },
    };
    mockState.getTabGroups = () => [
      { panelIds: ["p1"], activeTabId: "p1" },
      { panelIds: ["p2"], activeTabId: "p2" },
      { panelIds: ["p3"], activeTabId: "p3" },
      { panelIds: ["p4"], activeTabId: "p4" },
    ];

    requestPanelClose({ hideIds: ["p2"], commit: vi.fn() });

    expect(setFocusedMock).toHaveBeenCalledWith("p3");
  });

  it("falls back to the previous visual grid panel when closing the last panel", () => {
    mockState.focusedId = "p3";
    mockState.panelIds = ["p1", "p2", "p3"];
    mockState.panelsById = {
      p1: { id: "p1", location: "grid", worktreeId: "w1" },
      p2: { id: "p2", location: "grid", worktreeId: "w1" },
      p3: { id: "p3", location: "grid", worktreeId: "w1" },
    };
    mockState.getTabGroups = () => [
      { panelIds: ["p1"], activeTabId: "p1" },
      { panelIds: ["p2"], activeTabId: "p2" },
      { panelIds: ["p3"], activeTabId: "p3" },
    ];

    requestPanelClose({ hideIds: ["p3"], commit: vi.fn() });

    expect(setFocusedMock).toHaveBeenCalledWith("p2");
  });

  it("does not move focus when the closed panel was not focused", () => {
    mockState.focusedId = "p2";
    mockState.panelIds = ["p1", "p2"];
    mockState.panelsById = {
      p1: { id: "p1", location: "grid", worktreeId: "w1" },
      p2: { id: "p2", location: "grid", worktreeId: "w1" },
    };

    requestPanelClose({ hideIds: ["p1"], commit: vi.fn() });

    expect(setFocusedMock).not.toHaveBeenCalled();
  });
});
