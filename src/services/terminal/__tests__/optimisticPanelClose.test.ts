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
import {
  __resetPanelCloseGuardsForTests,
  registerPanelCloseGuard,
} from "@/services/panelCloseGuard";

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

// #12323: a panel holding unsaved work registers a close guard. The close waits
// on the guard's verdict before hiding anything; a cancel leaves the panel and
// its focus untouched, and an unguarded close keeps its synchronous path.
describe("optimisticPanelClose — close guards (#12323)", () => {
  function mountPanel(id: string): HTMLElement {
    const gridCell = document.createElement("div");
    gridCell.dataset.terminalId = id;
    const panel = document.createElement("div");
    panel.dataset.panelId = id;
    gridCell.appendChild(panel);
    document.body.appendChild(gridCell);
    return gridCell;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    __resetOptimisticPanelCloseForTests();
    __resetPanelCloseGuardsForTests();
    setFocusedMock.mockClear();
    mockState.focusedId = null;
    mockState.panelIds = [];
    mockState.panelsById = {};
    document.body.innerHTML = "";
    setFocusedMock.mockImplementation((id: string | null) => {
      mockState.focusedId = id;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetPanelCloseGuardsForTests();
  });

  it("still hides an unguarded panel synchronously", () => {
    const cell = mountPanel("p1");
    mockState.panelIds = ["p1"];
    mockState.panelsById = { p1: { id: "p1" } };
    requestPanelClose({ hideIds: ["p1"], commit: vi.fn() });
    expect(cell.style.display).toBe("none");
    expect(isOptimisticallyClosing("p1")).toBe(true);
  });

  it("waits for the guard and hides nothing while it is pending", async () => {
    const cell = mountPanel("p1");
    mockState.panelIds = ["p1"];
    mockState.panelsById = { p1: { id: "p1" } };
    mockState.focusedId = "p1";
    let resolveGuard: ((verdict: "proceed" | "cancel") => void) | null = null;
    registerPanelCloseGuard(
      "p1",
      () =>
        new Promise((resolve) => {
          resolveGuard = resolve;
        })
    );
    const commit = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit });

    expect(cell.style.display).toBe("");
    expect(isOptimisticallyClosing("p1")).toBe(false);
    expect(setFocusedMock).not.toHaveBeenCalled();

    // The guard starts on a microtask; let it hand out its resolver.
    await vi.advanceTimersByTimeAsync(0);
    resolveGuard!("proceed");
    await vi.advanceTimersByTimeAsync(0);
    expect(cell.style.display).toBe("none");
    expect(isOptimisticallyClosing("p1")).toBe(true);
    flushOptimisticCloses();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("leaves the panel and focus exactly as they were on cancel", async () => {
    const cell = mountPanel("p1");
    mockState.panelIds = ["p1"];
    mockState.panelsById = { p1: { id: "p1" } };
    mockState.focusedId = "p1";
    registerPanelCloseGuard("p1", async () => "cancel");
    const commit = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit });
    await vi.advanceTimersByTimeAsync(0);

    expect(cell.style.display).toBe("");
    expect(isOptimisticallyClosing("p1")).toBe(false);
    expect(mockState.focusedId).toBe("p1");
    expect(setFocusedMock).not.toHaveBeenCalled();
    flushOptimisticCloses();
    expect(commit).not.toHaveBeenCalled();
  });

  it("drops a proceed verdict for a panel that vanished while the prompt was open", async () => {
    mountPanel("p1");
    mockState.panelIds = ["p1"];
    mockState.panelsById = { p1: { id: "p1" } };
    let resolveGuard: ((verdict: "proceed" | "cancel") => void) | null = null;
    registerPanelCloseGuard(
      "p1",
      () =>
        new Promise((resolve) => {
          resolveGuard = resolve;
        })
    );
    const commit = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit });
    // A bulk path removed the panel meanwhile.
    mockState.panelIds = [];
    mockState.panelsById = {};
    // The guard starts on a microtask; let it hand out its resolver.
    await vi.advanceTimersByTimeAsync(0);
    resolveGuard!("proceed");
    await vi.advanceTimersByTimeAsync(0);
    expect(isOptimisticallyClosing("p1")).toBe(false);
    flushOptimisticCloses();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("optimisticPanelClose — close outcomes (#12323)", () => {
  function mountPanel(id: string): HTMLElement {
    const gridCell = document.createElement("div");
    gridCell.dataset.terminalId = id;
    document.body.appendChild(gridCell);
    return gridCell;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    __resetOptimisticPanelCloseForTests();
    __resetPanelCloseGuardsForTests();
    setFocusedMock.mockClear();
    mockState.focusedId = null;
    mockState.panelIds = ["p1"];
    mockState.panelsById = { p1: { id: "p1" } };
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetPanelCloseGuardsForTests();
  });

  it("reports an unguarded close as accepted, synchronously", () => {
    mountPanel("p1");
    const onOutcome = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit: vi.fn(), onOutcome });
    expect(onOutcome).toHaveBeenCalledWith(true);
  });

  it("reports a cancelled guarded close as rejected", async () => {
    mountPanel("p1");
    registerPanelCloseGuard("p1", async () => "cancel");
    const onOutcome = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit: vi.fn(), onOutcome });
    expect(onOutcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(onOutcome).toHaveBeenCalledWith(false);
  });

  it("does not re-close a panel another path trashed while the prompt was open", async () => {
    mountPanel("p1");
    registerPanelCloseGuard("p1", async () => "proceed");
    const commit = vi.fn();
    const onOutcome = vi.fn();
    requestPanelClose({ hideIds: ["p1"], commit, onOutcome });
    mockState.panelsById = { p1: { id: "p1", location: "trash" } };
    await vi.advanceTimersByTimeAsync(0);
    flushOptimisticCloses();
    expect(commit).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(false);
  });
});
