import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { createTerminalFocusSlice, type TerminalFocusSlice } from "../terminalFocusSlice";
import type { GetPanelGroupInfo } from "@/store/panelFocusFallback";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
  },
}));

const mockGetActiveWorktreeId = vi.fn(() => "worktree-1" as string | null);
const mockStampLastActive = vi.fn();
// Ungrouped by default. The slice captures this function once at construction,
// so the swappable half has to live behind it — reassigning the argument itself
// would never reach an already-built slice.
let panelGroupInfoImpl: GetPanelGroupInfo = () => undefined;
const mockGetPanelGroupInfo: GetPanelGroupInfo = (id) => panelGroupInfoImpl(id);
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");

describe("TerminalFocusSlice - Layout Snapshot", () => {
  const mockTerminals: PtyPanelData[] = [
    {
      id: "term-1",
      title: "Terminal 1",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
    {
      id: "term-2",
      title: "Terminal 2",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
  ] as PtyPanelData[];

  const getTerminals = vi.fn(() => mockTerminals);

  // Mock getPanelGroup that returns undefined (no group)
  const mockGetPanelGroup = vi.fn(() => undefined);

  let state: TerminalFocusSlice;
  let setState: any;
  let getState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    setState = vi.fn((updater) => {
      const currentState = getState();
      const updates = typeof updater === "function" ? updater(currentState) : updater;
      state = { ...currentState, ...updates };
    });
    getState = vi.fn(() => state);
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState, getState, {} as never);
  });

  it("should capture layout snapshot when maximizing", () => {
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroup);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
  });

  it("should not capture snapshot when unmaximizing", () => {
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };

    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroup);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should clear snapshot when terminal is removed", () => {
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.handleTerminalRemoved("term-1", [mockTerminals[1]!], 0);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    expect(state.preMaximizeLayout).toBe(null);
  });

  it("should clear snapshot via clearPreMaximizeLayout", () => {
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.clearPreMaximizeLayout();

    expect(state.preMaximizeLayout).toBe(null);
  });

  it("should clear all three maximize fields via clearMaximize (#9935)", () => {
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.clearMaximize();

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    expect(state.preMaximizeLayout).toBe(null);
  });

  it("exitMaximize leaves fullscreen but keeps the layout snapshot (#11060)", () => {
    const snapshot = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };
    state.preMaximizeLayout = snapshot;

    state.exitMaximize();

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    // The whole difference from clearMaximize: the grid still restores its
    // column count, because the panel isn't going away — the user is.
    expect(state.preMaximizeLayout).toBe(snapshot);
  });

  it("exitMaximize leaves fullscreen even when the group target no longer resolves (#11060)", () => {
    // A group target whose group has dissolved. toggleMaximize can't resolve it,
    // so it falls through to its maximize branch and re-maximizes term-1 —
    // exitMaximize must not care about the target at all.
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "group", id: "group-gone" };

    state.exitMaximize();

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("toggleMaximize re-maximizes a dissolved group target, which is why exitMaximize exists (#11060)", () => {
    // Pins the hazard this change routes around: the same seed, through the
    // conditional toggle, ends up maximized rather than back in the grid.
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "group", id: "group-gone" };

    state.toggleMaximize("term-1", undefined, undefined, mockGetPanelGroup);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
  });

  it("focusOrMaximizeByIndex restores the grid even when the maximized group has dissolved (#11060)", () => {
    // The index hotkey routes its force-exit through exitMaximize, so it can't
    // fall into toggleMaximize's re-maximize branch (pinned by the test above).
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "group", id: "group-gone" };

    state.focusOrMaximizeByIndex(1, () => "term-2", mockGetPanelGroup);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    expect(state.focusedId).toBe("term-2");
  });

  it("exitMaximize is a no-op when nothing is fullscreen (#11060)", () => {
    state.exitMaximize();

    expect(setState).not.toHaveBeenCalled();
  });

  it("clearMaximize is a no-op when the trio is already null (#9935)", () => {
    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    expect(state.preMaximizeLayout).toBe(null);

    state.clearMaximize();

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    expect(state.preMaximizeLayout).toBe(null);
  });

  it("validateMaximizeTarget clears a dangling target even when maximizedId is null (#9935)", () => {
    const mockGetPanelGroup = vi.fn(() => undefined);
    const mockGetTerminal = vi.fn(() => undefined);

    // Dangling target state — exactly the invariant violation #9935 describes.
    state.maximizedId = null;
    state.maximizeTarget = { type: "panel", id: "term-1" };
    state.preMaximizeLayout = { gridCols: 2, gridItemCount: 4, worktreeId: "worktree-1" };

    state.validateMaximizeTarget(mockGetPanelGroup, mockGetTerminal);

    // The validation pass must sweep the dangling target and its layout
    // snapshot so the next `toggleMaximize` doesn't see a stale target.
    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
    expect(state.preMaximizeLayout).toBe(null);
  });

  it("should not capture snapshot when gridCols or gridItemCount is undefined", () => {
    state.toggleMaximize("term-1", undefined, undefined, mockGetPanelGroup);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
    expect(state.preMaximizeLayout).toBeNull();
  });

  it("should preserve snapshot across multiple maximize/restore cycles", () => {
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroup);

    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });

    state.toggleMaximize("term-1", undefined, undefined, mockGetPanelGroup);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });
});

describe("TerminalFocusSlice - preferredTerminalFocusTarget", () => {
  let state: TerminalFocusSlice;
  let setState: any;
  let getState: any;
  const getTerminals = vi.fn(() => [] as PtyPanelData[]);

  beforeEach(() => {
    vi.clearAllMocks();
    setState = vi.fn((updater) => {
      const currentState = getState();
      const updates = typeof updater === "function" ? updater(currentState) : updater;
      state = { ...currentState, ...updates };
    });
    getState = vi.fn(() => state);
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState, getState, {} as never);
  });

  it("defaults to hybridInput on slice creation", () => {
    expect(state.preferredTerminalFocusTarget).toBe("hybridInput");
  });

  it("flips to xterm via the setter", () => {
    state.setPreferredTerminalFocusTarget("xterm");
    expect(state.preferredTerminalFocusTarget).toBe("xterm");
  });

  it("flips back to hybridInput via the setter", () => {
    state.setPreferredTerminalFocusTarget("xterm");
    setState.mockClear();
    state.setPreferredTerminalFocusTarget("hybridInput");
    expect(state.preferredTerminalFocusTarget).toBe("hybridInput");
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — repeat sets to the same value do not call set()", () => {
    state.setPreferredTerminalFocusTarget("hybridInput"); // already the default
    expect(setState).not.toHaveBeenCalled();

    state.setPreferredTerminalFocusTarget("xterm");
    expect(setState).toHaveBeenCalledTimes(1);
    setState.mockClear();

    // Setting xterm again is a no-op — store stays quiet so DOM focus
    // listeners don't drive notification storms.
    state.setPreferredTerminalFocusTarget("xterm");
    expect(setState).not.toHaveBeenCalled();
  });
});

describe("TerminalFocusSlice - Tab Group Maximize", () => {
  const mockTerminals: PtyPanelData[] = [
    {
      id: "term-1",
      title: "Terminal 1",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
    {
      id: "term-2",
      title: "Terminal 2",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
    {
      id: "term-3",
      title: "Terminal 3",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
  ] as PtyPanelData[];

  const mockGroup = {
    id: "group-1",
    panelIds: ["term-1", "term-2"],
    location: "grid" as const,
  };

  const getTerminals = vi.fn(() => mockTerminals);

  // Mock getPanelGroup that returns a group for term-1 and term-2
  const mockGetPanelGroupWithGroup = vi.fn((panelId: string) => {
    if (panelId === "term-1" || panelId === "term-2") {
      return mockGroup;
    }
    return undefined;
  });

  let state: TerminalFocusSlice;
  let setState: any;
  let getState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    setState = vi.fn((updater) => {
      const currentState = getState();
      const updates = typeof updater === "function" ? updater(currentState) : updater;
      state = { ...currentState, ...updates };
    });
    getState = vi.fn(() => state);
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState, getState, {} as never);
  });

  it("should maximize entire group when panel is in a group with multiple panels", () => {
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroupWithGroup);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });
    expect(state.preMaximizeLayout).toEqual({
      gridCols: 2,
      gridItemCount: 4,
      worktreeId: "worktree-1",
    });
  });

  it("should unmaximize group when clicking any panel in the maximized group", () => {
    // First maximize term-1 (which is in group-1)
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroupWithGroup);
    expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });

    // Now click term-2 (also in group-1) - should unmaximize
    state.toggleMaximize("term-2", 2, 4, mockGetPanelGroupWithGroup);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should maximize as single panel when panel is not in any group", () => {
    state.toggleMaximize("term-3", 2, 4, mockGetPanelGroupWithGroup);

    expect(state.maximizedId).toBe("term-3");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-3" });
  });

  it("should maximize as single panel when getPanelGroup returns single-panel group", () => {
    const singlePanelGroup = {
      id: "group-single",
      panelIds: ["term-3"],
      location: "grid" as const,
    };
    const mockGetSinglePanelGroup = vi.fn((panelId: string) => {
      if (panelId === "term-3") {
        return singlePanelGroup;
      }
      return undefined;
    });

    state.toggleMaximize("term-3", 2, 4, mockGetSinglePanelGroup);

    expect(state.maximizedId).toBe("term-3");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-3" });
  });

  it("should work without getPanelGroup (backwards compatibility)", () => {
    state.toggleMaximize("term-1", 2, 4);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
  });

  it("should unmaximize group when getPanelGroup is omitted but panel ID matches", () => {
    // First maximize with group
    state.toggleMaximize("term-1", 2, 4, mockGetPanelGroupWithGroup);
    expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });

    // Now toggle again without getPanelGroup - should still unmaximize
    state.toggleMaximize("term-1", 2, 4);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should downgrade group maximize to panel when group shrinks to single panel", () => {
    const singlePanelGroup = {
      id: "group-1",
      panelIds: ["term-1"],
      location: "grid" as const,
    };
    const mockGetShrunkGroup = vi.fn((panelId: string) => {
      if (panelId === "term-1") {
        return singlePanelGroup;
      }
      return undefined;
    });
    const mockGetTerminal = vi.fn((id: string) => mockTerminals.find((t) => t.id === id));

    // First maximize a multi-panel group
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "group", id: "group-1" };

    // Now validate with a shrunk group (only 1 panel)
    state.validateMaximizeTarget(mockGetShrunkGroup, mockGetTerminal);

    expect(state.maximizedId).toBe("term-1");
    expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-1" });
  });

  it("should clear maximize when group is deleted", () => {
    const mockGetTerminal = vi.fn((id: string) => mockTerminals.find((t) => t.id === id));
    const mockGetNoGroup = vi.fn(() => undefined);

    // Maximize a group
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "group", id: "group-1" };

    // Now validate with group gone
    state.validateMaximizeTarget(mockGetNoGroup, mockGetTerminal);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  it("should clear maximize when panel is moved to trash", () => {
    const trashedTerminal = { ...mockTerminals[0]!, location: "trash" as const };
    const mockGetTerminal = vi.fn((id: string) =>
      id === "term-1" ? trashedTerminal : mockTerminals.find((t) => t.id === id)
    );
    const mockGetPanelGroup = vi.fn(() => undefined);

    // Maximize a panel
    state.maximizedId = "term-1";
    state.maximizeTarget = { type: "panel", id: "term-1" };

    // Now validate with panel in trash
    state.validateMaximizeTarget(mockGetPanelGroup, mockGetTerminal);

    expect(state.maximizedId).toBe(null);
    expect(state.maximizeTarget).toBe(null);
  });

  describe("focusOrMaximizeByIndex - press-again-to-fullscreen", () => {
    // 1 -> term-1, 2 -> term-2, 3 -> term-3, anything else unresolved.
    const findByIndex = vi.fn((idx: number) =>
      idx === 1 ? "term-1" : idx === 2 ? "term-2" : idx === 3 ? "term-3" : null
    );
    // term-3 stands alone (not in any group) per mockGetPanelGroupWithGroup.
    const noGroup = vi.fn(() => undefined);

    it("focuses an unfocused panel without maximizing or touching maximize state", () => {
      state.focusedId = "term-2";
      const toggleSpy = vi.spyOn(state, "toggleMaximize");

      state.focusOrMaximizeByIndex(1, findByIndex, noGroup);

      expect(state.focusedId).toBe("term-1");
      expect(state.maximizedId).toBe(null);
      // Nothing was maximized, so the unmaximize path must not run.
      expect(toggleSpy).not.toHaveBeenCalled();
    });

    it("maximizes the panel when its index is pressed while already focused", () => {
      state.focusedId = "term-3";

      state.focusOrMaximizeByIndex(3, findByIndex, noGroup);

      expect(state.focusedId).toBe("term-3");
      expect(state.maximizedId).toBe("term-3");
      expect(state.maximizeTarget).toEqual({ type: "panel", id: "term-3" });
    });

    it("restores when the focused-and-maximized panel's index is pressed again", () => {
      state.focusedId = "term-3";
      state.maximizedId = "term-3";
      state.maximizeTarget = { type: "panel", id: "term-3" };

      state.focusOrMaximizeByIndex(3, findByIndex, noGroup);

      expect(state.focusedId).toBe("term-3");
      expect(state.maximizedId).toBe(null);
      expect(state.maximizeTarget).toBe(null);
    });

    it("exits fullscreen and focuses the new panel when a different index is pressed", () => {
      state.focusedId = "term-3";
      state.maximizedId = "term-3";
      state.maximizeTarget = { type: "panel", id: "term-3" };
      state.preMaximizeLayout = { gridCols: 2, gridItemCount: 3, worktreeId: "worktree-1" };

      state.focusOrMaximizeByIndex(2, findByIndex, noGroup);

      expect(state.focusedId).toBe("term-2");
      expect(state.maximizedId).toBe(null);
      expect(state.maximizeTarget).toBe(null);
      // Switching panels unmaximizes via toggleMaximize, which preserves the
      // snapshot so the grid's column count restores cleanly (not clearMaximize).
      expect(state.preMaximizeLayout).toEqual({
        gridCols: 2,
        gridItemCount: 3,
        worktreeId: "worktree-1",
      });
    });

    it("reveals a background panel in the grid (not fullscreen) when it was opened during fullscreen", () => {
      // term-1 is fullscreen; term-2 was opened while maximized, so it became
      // focused in the background without ever being displayed. Pressing its
      // index must restore the grid and focus it — NOT fullscreen it. (A second
      // press would then fullscreen it, since nothing is maximized by then.)
      state.focusedId = "term-2";
      state.maximizedId = "term-1";
      state.maximizeTarget = { type: "panel", id: "term-1" };

      state.focusOrMaximizeByIndex(2, findByIndex, noGroup);

      expect(state.maximizedId).toBe(null);
      expect(state.maximizeTarget).toBe(null);
      expect(state.focusedId).toBe("term-2");
    });

    it("maximizes the whole group when the focused panel's index is re-pressed (group-aware)", () => {
      // term-1 is in group-1 (with term-2) per mockGetPanelGroupWithGroup.
      state.focusedId = "term-1";

      state.focusOrMaximizeByIndex(1, findByIndex, mockGetPanelGroupWithGroup);

      expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });
    });

    it("unmaximizes the group when a maximized group's cell index is re-pressed", () => {
      state.focusedId = "term-1";
      state.maximizedId = "term-1";
      state.maximizeTarget = { type: "group", id: "group-1" };

      state.focusOrMaximizeByIndex(1, findByIndex, mockGetPanelGroupWithGroup);

      expect(state.maximizedId).toBe(null);
      expect(state.maximizeTarget).toBe(null);
    });

    it("toggles the group when focus sits on a sibling tab and the cell's representative differs", () => {
      // findByIndex resolves group-1's cell to term-1, but focus is on its
      // sibling term-2. Same cell -> re-press must maximize, not switch+focus.
      state.focusedId = "term-2";
      const activateSpy = vi.spyOn(state, "activateTerminal");

      state.focusOrMaximizeByIndex(1, findByIndex, mockGetPanelGroupWithGroup);

      expect(state.maximizeTarget).toEqual({ type: "group", id: "group-1" });
      expect(state.focusedId).toBe("term-2");
      expect(activateSpy).not.toHaveBeenCalled();
    });

    it("is a no-op when the index does not resolve to a panel", () => {
      state.focusedId = "term-1";
      state.maximizedId = "term-1";
      state.maximizeTarget = { type: "panel", id: "term-1" };
      const toggleSpy = vi.spyOn(state, "toggleMaximize");
      const activateSpy = vi.spyOn(state, "activateTerminal");

      state.focusOrMaximizeByIndex(9, findByIndex, noGroup);

      // Early return: nothing focused/maximized changes, no side effects.
      expect(state.focusedId).toBe("term-1");
      expect(state.maximizedId).toBe("term-1");
      expect(toggleSpy).not.toHaveBeenCalled();
      expect(activateSpy).not.toHaveBeenCalled();
    });
  });
});

describe("TerminalFocusSlice - dock focus sync invariant", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          notification: { acknowledgeWaiting: vi.fn(), acknowledgeWorkingPulse: vi.fn() },
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  const makeTerminal = (
    id: string,
    location: "grid" | "dock",
    worktreeId = "worktree-1"
  ): PtyPanelData =>
    ({
      id,
      title: id,
      kind: "terminal",
      type: "terminal",
      cwd: "/test",
      location,
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId,
    }) as PtyPanelData;

  let terminals: PtyPanelData[];
  let state: TerminalFocusSlice;

  const setup = () => {
    const getTerminals = vi.fn(() => terminals);
    const getState = vi.fn((): TerminalFocusSlice => state);
    const setState = vi.fn(
      (
        updater:
          | Partial<TerminalFocusSlice>
          | ((s: TerminalFocusSlice) => Partial<TerminalFocusSlice>)
      ) => {
        const currentState = getState();
        const updates = typeof updater === "function" ? updater(currentState) : updater;
        state = { ...currentState, ...updates };
      }
    );
    return { getTerminals, setState, getState };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    terminals = [
      makeTerminal("grid-1", "grid"),
      makeTerminal("grid-2", "grid"),
      makeTerminal("dock-1", "dock"),
      makeTerminal("dock-2", "dock"),
    ];
    const { getTerminals, setState, getState } = setup();
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState as never, getState as never, {} as never);
  });

  it("focusDockDirection sets activeDockTerminalId when moving between dock terminals", () => {
    state.focusedId = "dock-1";
    state.activeDockTerminalId = "dock-1";
    const findDockByIndex = vi.fn(() => "dock-2");

    state.focusDockDirection("right", findDockByIndex);

    expect(state.focusedId).toBe("dock-2");
    expect(state.activeDockTerminalId).toBe("dock-2");
  });

  it("focusDockDirection is a no-op when focusedId is null", () => {
    state.focusedId = null;
    const findDockByIndex = vi.fn();

    state.focusDockDirection("right", findDockByIndex);

    expect(findDockByIndex).not.toHaveBeenCalled();
    expect(state.focusedId).toBeNull();
  });

  it("focusDockDirection is a no-op when findDockByIndex returns null", () => {
    state.focusedId = "dock-1";
    state.activeDockTerminalId = "dock-1";
    const findDockByIndex = vi.fn(() => null);

    state.focusDockDirection("left", findDockByIndex);

    expect(state.focusedId).toBe("dock-1");
    expect(state.activeDockTerminalId).toBe("dock-1");
  });

  it("focusByIndex clears activeDockTerminalId when targeting a grid terminal", () => {
    state.focusedId = "dock-1";
    state.activeDockTerminalId = "dock-1";
    const findByIndex = vi.fn(() => "grid-1");

    state.focusByIndex(0, findByIndex);

    expect(state.focusedId).toBe("grid-1");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("focusDirection clears activeDockTerminalId when navigating to a grid terminal", () => {
    state.focusedId = "grid-1";
    state.activeDockTerminalId = "dock-1";
    const findNearest = vi.fn(() => "grid-2");

    state.focusDirection("right", findNearest);

    expect(state.focusedId).toBe("grid-2");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("setFocused sets activeDockTerminalId when focusing a dock terminal", () => {
    state.focusedId = "grid-1";
    state.activeDockTerminalId = null;

    state.setFocused("dock-1");

    expect(state.focusedId).toBe("dock-1");
    expect(state.activeDockTerminalId).toBe("dock-1");
  });

  it("setFocused clears activeDockTerminalId when focusing a grid terminal", () => {
    state.focusedId = "dock-1";
    state.activeDockTerminalId = "dock-1";

    state.setFocused("grid-1");

    expect(state.focusedId).toBe("grid-1");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("setFocused(null) clears both focusedId and activeDockTerminalId", () => {
    state.focusedId = "dock-1";
    state.activeDockTerminalId = "dock-1";

    state.setFocused(null);

    expect(state.focusedId).toBeNull();
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("setFocused clears activeDockTerminalId for unknown terminal ids", () => {
    state.activeDockTerminalId = "dock-1";

    state.setFocused("unknown-id");

    expect(state.focusedId).toBe("unknown-id");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("openDockTerminal opens only dock terminals", () => {
    state.openDockTerminal("dock-1");

    expect(state.focusedId).toBe("dock-1");
    expect(state.activeDockTerminalId).toBe("dock-1");
    expect(terminalInstanceService.wake).toHaveBeenCalledWith("dock-1");
  });

  it("openDockTerminal clears stale dock activation for grid or missing terminals", () => {
    state.focusedId = "grid-1";
    state.activeDockTerminalId = "dock-1";

    state.openDockTerminal("grid-1");

    expect(state.focusedId).toBeNull();
    expect(state.activeDockTerminalId).toBeNull();

    state.activeDockTerminalId = "dock-2";
    state.openDockTerminal("missing-id");

    expect(state.activeDockTerminalId).toBeNull();
  });
});

describe("TerminalFocusSlice - focusNextBlockedDock", () => {
  beforeAll(() => {
    // openDockTerminal accesses window.electron?.notification?.acknowledgeWaiting
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          notification: { acknowledgeWaiting: vi.fn(), acknowledgeWorkingPulse: vi.fn() },
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  const makeDockTerminal = (
    id: string,
    agentState: string,
    worktreeId = "worktree-1"
  ): PtyPanelData =>
    ({
      id,
      title: id,
      kind: "terminal",
      type: "claude",
      cwd: "/test",
      location: "dock",
      agentState,
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId,
    }) as PtyPanelData;

  let terminals: PtyPanelData[];
  let getTerminals: any;
  let state: TerminalFocusSlice;
  let setState: any;
  let getState: any;

  beforeEach(() => {
    vi.clearAllMocks();
    terminals = [];
    getTerminals = vi.fn(() => terminals);
    setState = vi.fn((updater) => {
      const currentState = getState();
      const updates = typeof updater === "function" ? updater(currentState) : updater;
      state = { ...currentState, ...updates };
    });
    getState = vi.fn(() => state);
    const focusSlice = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState, getState, {} as never);
    // Add setActiveTab stub — in the real store this comes from the registry slice
    state = { ...focusSlice, setActiveTab: vi.fn() } as TerminalFocusSlice & {
      setActiveTab: ReturnType<typeof vi.fn>;
    };
  });

  it("should be a no-op when no dock terminals are blocked", () => {
    terminals = [makeDockTerminal("d1", "idle"), makeDockTerminal("d2", "working")];
    state.focusNextBlockedDock("worktree-1");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("should select the first blocked dock terminal when none is currently open", () => {
    terminals = [makeDockTerminal("d1", "idle"), makeDockTerminal("d2", "waiting")];
    state.focusNextBlockedDock("worktree-1");
    expect(state.activeDockTerminalId).toBe("d2");
    expect(state.focusedId).toBe("d2");
  });

  it("should cycle through blocked terminals with wrap-around", () => {
    terminals = [
      makeDockTerminal("d1", "waiting"),
      makeDockTerminal("d2", "waiting"),
      makeDockTerminal("d3", "waiting"),
    ];

    // First call: selects d1 (first waiting)
    state.focusNextBlockedDock("worktree-1");
    expect(state.activeDockTerminalId).toBe("d1");

    // Second call: d2
    state.focusNextBlockedDock("worktree-1");
    expect(state.activeDockTerminalId).toBe("d2");

    // Third call: d3
    state.focusNextBlockedDock("worktree-1");
    expect(state.activeDockTerminalId).toBe("d3");

    // Fourth call: wraps back to d1
    state.focusNextBlockedDock("worktree-1");
    expect(state.activeDockTerminalId).toBe("d1");
  });

  it("should ignore grid terminals and other worktrees", () => {
    terminals = [
      {
        ...makeDockTerminal("g1", "waiting"),
        location: "grid",
      } as PtyPanelData,
      makeDockTerminal("d1", "waiting", "worktree-2"),
      makeDockTerminal("d2", "waiting"),
    ];
    state.focusNextBlockedDock("worktree-1");
    expect(state.activeDockTerminalId).toBe("d2");
  });

  it("should call setActiveTab for grouped panels", () => {
    terminals = [makeDockTerminal("d1", "waiting")];
    const mockGetPanelGroup = vi.fn(() => ({ id: "group-1", panelIds: ["d1", "d-other"] }));

    state.focusNextBlockedDock("worktree-1", mockGetPanelGroup);

    expect(mockGetPanelGroup).toHaveBeenCalledWith("d1");
    // setActiveTab is now on the registry slice, accessed via composed store
    expect(
      (state as TerminalFocusSlice & { setActiveTab: ReturnType<typeof vi.fn> }).setActiveTab
    ).toHaveBeenCalledWith("group-1", "d1");
    expect(state.activeDockTerminalId).toBe("d1");
  });
});

describe("TerminalFocusSlice - focusNextAgent / focusPreviousAgent runtime identity", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          notification: { acknowledgeWaiting: vi.fn(), acknowledgeWorkingPulse: vi.fn() },
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  const makeTerminal = (
    id: string,
    opts: {
      kind?: "agent" | "terminal";
      launchAgentId?: string;
      detectedAgentId?: string;
      everDetectedAgent?: boolean;
      agentState?: string;
    } = {}
  ): PtyPanelData =>
    ({
      id,
      title: id,
      kind: opts.kind,
      launchAgentId: opts.launchAgentId,
      detectedAgentId: opts.detectedAgentId,
      everDetectedAgent: opts.everDetectedAgent,
      cwd: "/test",
      location: "grid",
      agentState: opts.agentState ?? "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    }) as PtyPanelData;

  let terminals: PtyPanelData[];
  let state: TerminalFocusSlice;

  const setup = () => {
    const getTerminals = vi.fn(() => terminals);
    const getState = vi.fn((): TerminalFocusSlice => state);
    const setState = vi.fn(
      (
        updater:
          | Partial<TerminalFocusSlice>
          | ((s: TerminalFocusSlice) => Partial<TerminalFocusSlice>)
      ) => {
        const currentState = getState();
        const updates = typeof updater === "function" ? updater(currentState) : updater;
        state = { ...currentState, ...updates };
      }
    );
    return { getTerminals, setState, getState };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const { getTerminals, setState, getState } = setup();
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState as never, getState as never, {} as never);
  });

  const neverInTrash = () => false;
  const validWorktrees = new Set(["worktree-1"]);

  it("includes a launch-affinity agent before detection rehydrates", () => {
    terminals = [
      makeTerminal("launch-agent", {
        kind: "terminal",
        launchAgentId: "claude",
      }),
      makeTerminal("shell", { kind: "terminal" }),
    ];
    state.focusedId = "shell";

    state.focusNextAgent(neverInTrash, validWorktrees);

    expect(state.focusedId).toBe("launch-agent");
  });

  it("excludes an ex-agent panel whose runtime identity has cleared", () => {
    // Spawned as agent, detector fired then a strong exit arrived — no longer
    // in cycle even though launchAgentId remains persisted for restart/resume.
    terminals = [
      makeTerminal("ex-agent", {
        kind: "terminal",
        launchAgentId: "claude",
        everDetectedAgent: true,
        agentState: "exited",
      }),
      makeTerminal("live-agent", {
        kind: "terminal",
        launchAgentId: "gemini",
        detectedAgentId: "gemini",
      }),
    ];
    // Seed focus on the ex-agent so the cycle has to make a choice
    state.focusedId = "ex-agent";

    state.focusNextAgent(neverInTrash, validWorktrees);

    // Only live-agent is a runtime agent; cycle lands there regardless of seed
    expect(state.focusedId).toBe("live-agent");
  });

  it("includes a promoted shell that a runtime agent has entered", () => {
    terminals = [
      makeTerminal("promoted-shell", {
        kind: "terminal",
        detectedAgentId: "claude",
      }),
      makeTerminal("shell-2", { kind: "terminal" }),
    ];
    state.focusedId = "shell-2";

    state.focusNextAgent(neverInTrash, validWorktrees);

    expect(state.focusedId).toBe("promoted-shell");
  });

  it("focusPreviousAgent wraps across a mixed set using runtime identity", () => {
    terminals = [
      makeTerminal("agent-1", {
        kind: "terminal",
        launchAgentId: "claude",
        detectedAgentId: "claude",
      }),
      // Demoted: kind agent but detection fired and cleared → skipped
      makeTerminal("demoted", {
        kind: "terminal",
        launchAgentId: "gemini",
        everDetectedAgent: true,
        agentState: "exited",
      }),
      makeTerminal("shell", { kind: "terminal" }),
      makeTerminal("agent-2", {
        kind: "terminal",
        launchAgentId: "codex",
        detectedAgentId: "codex",
      }),
    ];
    state.focusedId = "agent-1";

    state.focusPreviousAgent(neverInTrash, validWorktrees);

    // Previous from agent-1 wraps to agent-2, skipping "demoted" and shell
    expect(state.focusedId).toBe("agent-2");
  });

  it("is a no-op when only ex-agent panels remain", () => {
    terminals = [
      makeTerminal("ex-agent", {
        kind: "terminal",
        launchAgentId: "claude",
        everDetectedAgent: true,
        agentState: "exited",
      }),
    ];
    state.focusedId = "ex-agent";

    state.focusNextAgent(neverInTrash, validWorktrees);

    // No cycle candidates because the sole agent has a strong exit signal;
    // focus is left untouched.
    expect(state.focusedId).toBe("ex-agent");
  });
});

describe("TerminalFocusSlice - cycle from non-matching focus (issue #5834)", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          notification: { acknowledgeWaiting: vi.fn(), acknowledgeWorkingPulse: vi.fn() },
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  const makeTerminal = (
    id: string,
    opts: {
      kind?: "agent" | "terminal";
      launchAgentId?: string;
      detectedAgentId?: string;
      everDetectedAgent?: boolean;
      agentState?: string;
    } = {}
  ): PtyPanelData =>
    ({
      id,
      title: id,
      kind: opts.kind ?? "terminal",
      launchAgentId: opts.launchAgentId,
      detectedAgentId: opts.detectedAgentId,
      everDetectedAgent: opts.everDetectedAgent,
      cwd: "/test",
      location: "grid",
      agentState: opts.agentState ?? "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    }) as PtyPanelData;

  let terminals: PtyPanelData[];
  let state: TerminalFocusSlice;

  beforeEach(() => {
    vi.clearAllMocks();
    const getTerminals = vi.fn(() => terminals);
    const getState = vi.fn((): TerminalFocusSlice => state);
    const setState = vi.fn(
      (
        updater:
          | Partial<TerminalFocusSlice>
          | ((s: TerminalFocusSlice) => Partial<TerminalFocusSlice>)
      ) => {
        const currentState = getState();
        const updates = typeof updater === "function" ? updater(currentState) : updater;
        state = { ...currentState, ...updates };
      }
    );
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState as never, getState as never, {} as never);
  });

  const neverInTrash = () => false;
  const validWorktrees = new Set(["worktree-1"]);

  it("focusNextWaiting from a non-waiting terminal between two waiting terminals lands on the next waiting after focus, not the first", () => {
    terminals = [
      makeTerminal("waiting-a", { agentState: "waiting" }),
      makeTerminal("idle-x", { agentState: "idle" }),
      makeTerminal("waiting-b", { agentState: "waiting" }),
      makeTerminal("idle-y", { agentState: "idle" }),
      makeTerminal("waiting-c", { agentState: "waiting" }),
    ];
    state.focusedId = "idle-y";

    state.focusNextWaiting(neverInTrash, validWorktrees);

    // idle-y sits between waiting-b and waiting-c; the next waiting after that
    // spatial position is waiting-c. The pre-fix code returned waiting-a (index 0).
    expect(state.focusedId).toBe("waiting-c");
  });

  it("focusNextWorking from a non-working terminal between two working terminals advances spatially", () => {
    terminals = [
      makeTerminal("working-a", { agentState: "working" }),
      makeTerminal("idle-x", { agentState: "idle" }),
      makeTerminal("working-b", { agentState: "working" }),
    ];
    state.focusedId = "idle-x";

    state.focusNextWorking(neverInTrash, validWorktrees);

    expect(state.focusedId).toBe("working-b");
  });

  it("focusNextAgent from a non-agent shell between two agents advances spatially", () => {
    terminals = [
      makeTerminal("agent-a", { detectedAgentId: "claude" }),
      makeTerminal("shell", {}),
      makeTerminal("agent-b", { detectedAgentId: "gemini" }),
    ];
    state.focusedId = "shell";

    state.focusNextAgent(neverInTrash, validWorktrees);

    expect(state.focusedId).toBe("agent-b");
  });

  it("focusPreviousAgent from a non-agent shell lands on the agent immediately before, not the last agent", () => {
    terminals = [
      makeTerminal("agent-a", { detectedAgentId: "claude" }),
      makeTerminal("shell", {}),
      makeTerminal("agent-b", { detectedAgentId: "gemini" }),
    ];
    state.focusedId = "shell";

    state.focusPreviousAgent(neverInTrash, validWorktrees);

    // Before the fix this returned agent-b (last in the filtered subset).
    expect(state.focusedId).toBe("agent-a");
  });

  it("focusNextWaiting wraps from the last waiting back to the first", () => {
    terminals = [
      makeTerminal("waiting-a", { agentState: "waiting" }),
      makeTerminal("idle-x", { agentState: "idle" }),
      makeTerminal("waiting-b", { agentState: "waiting" }),
    ];
    state.focusedId = "waiting-b";

    state.focusNextWaiting(neverInTrash, validWorktrees);

    expect(state.focusedId).toBe("waiting-a");
  });

  it("focusNextWaiting advances when the previously-focused waiting terminal transitions out of waiting between presses", () => {
    terminals = [
      makeTerminal("waiting-a", { agentState: "waiting" }),
      makeTerminal("waiting-b", { agentState: "waiting" }),
      makeTerminal("waiting-c", { agentState: "waiting" }),
    ];
    state.focusedId = "outside";

    // First press from a non-waiting/non-existent focus → lands on the first waiting.
    state.focusNextWaiting(neverInTrash, validWorktrees);
    expect(state.focusedId).toBe("waiting-a");

    // Simulate state churn: the just-focused terminal transitions to working.
    terminals = [
      makeTerminal("waiting-a", { agentState: "working" }),
      makeTerminal("waiting-b", { agentState: "waiting" }),
      makeTerminal("waiting-c", { agentState: "waiting" }),
    ];

    // Second press should advance to waiting-b, not loop back to itself.
    state.focusNextWaiting(neverInTrash, validWorktrees);
    expect(state.focusedId).toBe("waiting-b");
  });

  it("focusNextAgent with focus on a non-existent terminal lands on the first agent", () => {
    terminals = [
      makeTerminal("agent-a", { detectedAgentId: "claude" }),
      makeTerminal("agent-b", { detectedAgentId: "gemini" }),
    ];
    state.focusedId = "ghost";

    state.focusNextAgent(neverInTrash, validWorktrees);

    expect(state.focusedId).toBe("agent-a");
  });

  it("focusPreviousAgent with focus on a non-existent terminal lands on the last agent", () => {
    terminals = [
      makeTerminal("agent-a", { detectedAgentId: "claude" }),
      makeTerminal("agent-b", { detectedAgentId: "gemini" }),
    ];
    state.focusedId = "ghost";

    state.focusPreviousAgent(neverInTrash, validWorktrees);

    expect(state.focusedId).toBe("agent-b");
  });
});

describe("TerminalFocusSlice - setFocused ping gating", () => {
  const mockTerminals: PtyPanelData[] = [
    {
      id: "term-1",
      title: "Terminal 1",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
    {
      id: "term-2",
      title: "Terminal 2",
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    },
  ] as PtyPanelData[];

  const getTerminals = vi.fn(() => mockTerminals);

  let state: TerminalFocusSlice;
  let setState: any;
  let getState: any;
  let pingSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setState = vi.fn((updater) => {
      const currentState = getState();
      const updates = typeof updater === "function" ? updater(currentState) : updater;
      state = { ...currentState, ...updates };
    });
    getState = vi.fn(() => state);
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState, getState, {} as never);
    // Spy on pingTerminal so we can assert without running the 1600ms timer.
    pingSpy = vi.fn();
    state.pingTerminal = pingSpy as unknown as TerminalFocusSlice["pingTerminal"];
  });

  it("pings on initial focus (no previously focused terminal)", () => {
    state.setFocused("term-1", true);
    expect(pingSpy).toHaveBeenCalledWith("term-1");
  });

  it("pings when focus moves to a different terminal", () => {
    state.setFocused("term-1", true);
    pingSpy.mockClear();

    state.setFocused("term-2", true);
    expect(pingSpy).toHaveBeenCalledWith("term-2");
  });

  it("does not ping when re-focusing the already-focused terminal", () => {
    state.setFocused("term-1", true);
    pingSpy.mockClear();

    state.setFocused("term-1", true);
    expect(pingSpy).not.toHaveBeenCalled();
  });

  it("does not ping when shouldPing is false, even on focus change", () => {
    state.setFocused("term-1", false);
    expect(pingSpy).not.toHaveBeenCalled();
    state.setFocused("term-2", false);
    expect(pingSpy).not.toHaveBeenCalled();
  });

  it("routes a focus move through wakeForFocus (never a destructive wake on a live grid pane)", () => {
    state.setFocused("term-1");
    expect(terminalInstanceService.wakeForFocus).toHaveBeenCalledWith("term-1");

    vi.mocked(terminalInstanceService.wakeForFocus).mockClear();
    state.setFocused("term-2");
    expect(terminalInstanceService.wakeForFocus).toHaveBeenCalledWith("term-2");
  });

  it("does NOT re-wake when re-focusing the already-focused terminal", () => {
    // A wake reset()+replays the serialized buffer. Re-focusing a live
    // foreground terminal (clicking the xterm while the pane hybrid input held
    // focus) must not trigger that, or the redundant replay clobbers the live
    // buffer and collapses an alt-screen TUI like OpenCode.
    state.setFocused("term-1");
    vi.mocked(terminalInstanceService.wakeForFocus).mockClear();

    state.setFocused("term-1");

    expect(terminalInstanceService.wakeForFocus).not.toHaveBeenCalled();
  });
});

describe("TerminalFocusSlice - focusAlternate (last-pane toggle)", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: {
        electron: {
          notification: { acknowledgeWaiting: vi.fn(), acknowledgeWorkingPulse: vi.fn() },
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "window", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  const makeTerminal = (
    id: string,
    location: "grid" | "dock" | "trash" | "background" = "grid",
    worktreeId = "worktree-1"
  ): PtyPanelData =>
    ({
      id,
      title: id,
      cwd: "/test",
      location,
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId,
    }) as PtyPanelData;

  let terminals: PtyPanelData[];
  let state: TerminalFocusSlice;

  const setup = () => {
    const getTerminals = vi.fn(() => terminals);
    const getState = vi.fn((): TerminalFocusSlice => state);
    const setState = vi.fn(
      (
        updater:
          | Partial<TerminalFocusSlice>
          | ((s: TerminalFocusSlice) => Partial<TerminalFocusSlice>)
      ) => {
        const currentState = getState();
        const updates = typeof updater === "function" ? updater(currentState) : updater;
        state = { ...currentState, ...updates };
      }
    );
    return { getTerminals, setState, getState };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    terminals = [
      makeTerminal("a"),
      makeTerminal("b"),
      makeTerminal("c"),
      makeTerminal("dock-1", "dock"),
    ];
    const { getTerminals, setState, getState } = setup();
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState as never, getState as never, {} as never);
  });

  it("initializes previousFocusedId to null", () => {
    expect(state.previousFocusedId).toBeNull();
  });

  it("setFocused records the prior focus as previousFocusedId on a real change", () => {
    state.setFocused("a");
    expect(state.focusedId).toBe("a");
    expect(state.previousFocusedId).toBeNull();

    state.setFocused("b");
    expect(state.focusedId).toBe("b");
    expect(state.previousFocusedId).toBe("a");
  });

  it("setFocused does not corrupt previousFocusedId when re-focusing the active panel", () => {
    state.setFocused("a");
    state.setFocused("b");
    expect(state.previousFocusedId).toBe("a");

    // Re-focusing the already-active panel must not overwrite the alternate
    // pointer with itself — that would break A↔B round-tripping.
    state.setFocused("b");
    expect(state.previousFocusedId).toBe("a");
  });

  it("activateTerminal records the prior focus as previousFocusedId on a real change", () => {
    state.activateTerminal("a");
    expect(state.previousFocusedId).toBeNull();

    state.activateTerminal("b");
    expect(state.previousFocusedId).toBe("a");
  });

  it("activateTerminal does not corrupt previousFocusedId when re-activating the active panel", () => {
    state.activateTerminal("a");
    state.activateTerminal("b");
    expect(state.previousFocusedId).toBe("a");

    state.activateTerminal("b");
    expect(state.previousFocusedId).toBe("a");
  });

  it("focusAlternate is a no-op when previousFocusedId is null", () => {
    state.activateTerminal("a");
    expect(state.previousFocusedId).toBeNull();

    state.focusAlternate();
    expect(state.focusedId).toBe("a");
  });

  it("focusAlternate swaps to the previous panel and back (A↔B round-trip)", () => {
    state.activateTerminal("a");
    state.activateTerminal("b");
    expect(state.focusedId).toBe("b");
    expect(state.previousFocusedId).toBe("a");

    state.focusAlternate();
    expect(state.focusedId).toBe("a");
    expect(state.previousFocusedId).toBe("b");

    state.focusAlternate();
    expect(state.focusedId).toBe("b");
    expect(state.previousFocusedId).toBe("a");
  });

  it("focusAlternate ignores trashed targets", () => {
    state.activateTerminal("a");
    state.activateTerminal("b");
    expect(state.previousFocusedId).toBe("a");

    // Simulate the panel being trashed in place (without going through
    // handleTerminalRemoved, which would null the pointer itself).
    terminals = terminals.map((t) => (t.id === "a" ? { ...t, location: "trash" } : t));

    state.focusAlternate();
    expect(state.focusedId).toBe("b");
  });

  it("focusAlternate ignores background (hibernated) targets", () => {
    state.activateTerminal("a");
    state.activateTerminal("b");

    terminals = terminals.map((t) => (t.id === "a" ? { ...t, location: "background" } : t));

    state.focusAlternate();
    expect(state.focusedId).toBe("b");
  });

  it("focusAlternate is a no-op when the previous panel was removed entirely", () => {
    state.activateTerminal("a");
    state.activateTerminal("b");

    terminals = terminals.filter((t) => t.id !== "a");

    state.focusAlternate();
    expect(state.focusedId).toBe("b");
  });

  it("works across grid and dock panels", () => {
    state.activateTerminal("a");
    state.activateTerminal("dock-1");
    expect(state.focusedId).toBe("dock-1");
    expect(state.activeDockTerminalId).toBe("dock-1");
    expect(state.previousFocusedId).toBe("a");

    state.focusAlternate();
    expect(state.focusedId).toBe("a");
    expect(state.activeDockTerminalId).toBeNull();
    expect(state.previousFocusedId).toBe("dock-1");

    state.focusAlternate();
    expect(state.focusedId).toBe("dock-1");
    expect(state.activeDockTerminalId).toBe("dock-1");
  });

  it("handleTerminalRemoved clears previousFocusedId when the removed panel was the alternate", () => {
    state.activateTerminal("a");
    state.activateTerminal("b");
    expect(state.previousFocusedId).toBe("a");

    state.handleTerminalRemoved(
      "a",
      terminals.filter((t) => t.id !== "a"),
      0
    );
    expect(state.previousFocusedId).toBeNull();
    expect(state.focusedId).toBe("b");
  });

  it("handleTerminalRemoved clears previousFocusedId when the focused panel is removed (auto-fallback)", () => {
    state.activateTerminal("a");
    state.activateTerminal("b");
    expect(state.previousFocusedId).toBe("a");

    // b is currently focused; removing b reassigns focusedId to a fallback,
    // and the old previousFocusedId is no longer the user's preceding choice.
    state.handleTerminalRemoved(
      "b",
      terminals.filter((t) => t.id !== "b"),
      1
    );
    expect(state.previousFocusedId).toBeNull();
  });

  it("openDockTerminal records the prior focus as previousFocusedId", () => {
    // Most dock-focus entry points (clicks in DockedTerminalItem, focusDock
    // action, navigateTab dock branch, focusNextBlockedDock) route through
    // openDockTerminal — the alternate chain must include them.
    state.activateTerminal("a");

    state.openDockTerminal("dock-1");
    expect(state.focusedId).toBe("dock-1");
    expect(state.activeDockTerminalId).toBe("dock-1");
    expect(state.previousFocusedId).toBe("a");

    state.focusAlternate();
    expect(state.focusedId).toBe("a");
    expect(state.previousFocusedId).toBe("dock-1");
  });

  it("openDockTerminal does not corrupt previousFocusedId when reopening the same dock panel", () => {
    state.activateTerminal("a");
    state.openDockTerminal("dock-1");
    expect(state.previousFocusedId).toBe("a");

    state.openDockTerminal("dock-1");
    expect(state.previousFocusedId).toBe("a");
  });
});

// Issue #8703 — the focus stamp pinpoints the last user-intent focus per panel
// so the restore predicate can promote each worktree's most-recent panel.
describe("TerminalFocusSlice - lastActiveAt stamping (issue #8703)", () => {
  const makeTerminal = (
    id: string,
    location: "grid" | "dock" | "trash" | "background" = "grid"
  ): PtyPanelData =>
    ({
      id,
      title: id,
      cwd: "/test",
      location,
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    }) as PtyPanelData;

  let terminals: PtyPanelData[];
  let state: TerminalFocusSlice;

  beforeEach(() => {
    vi.clearAllMocks();
    terminals = [makeTerminal("a"), makeTerminal("b"), makeTerminal("dock-1", "dock")];
    const getTerminals = vi.fn(() => terminals);
    const getState = vi.fn((): TerminalFocusSlice => state);
    const setState = vi.fn(
      (
        updater:
          | Partial<TerminalFocusSlice>
          | ((s: TerminalFocusSlice) => Partial<TerminalFocusSlice>)
      ) => {
        const currentState = getState();
        const updates = typeof updater === "function" ? updater(currentState) : updater;
        state = { ...currentState, ...updates };
      }
    );
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState as never, getState as never, {} as never);
  });

  it("activateTerminal stamps the focused panel", () => {
    state.activateTerminal("a");
    expect(mockStampLastActive).toHaveBeenCalledWith("a");
  });

  it("setFocused stamps the focused panel", () => {
    state.setFocused("b");
    expect(mockStampLastActive).toHaveBeenCalledWith("b");
  });

  it("openDockTerminal stamps the opened dock panel", () => {
    state.openDockTerminal("dock-1");
    expect(mockStampLastActive).toHaveBeenCalledWith("dock-1");
  });

  it("activateTerminal(null) does not stamp", () => {
    state.activateTerminal(null);
    expect(mockStampLastActive).not.toHaveBeenCalled();
  });

  it("setFocused(null) does not stamp", () => {
    state.setFocused(null);
    expect(mockStampLastActive).not.toHaveBeenCalled();
  });

  it("activateTerminal does not stamp when the terminal is not in the registry", () => {
    state.activateTerminal("not-here");
    expect(mockStampLastActive).not.toHaveBeenCalled();
  });

  it("setFocused does not stamp when the terminal id is unknown", () => {
    // setFocused still updates focusedId optimistically, but stamping is gated
    // on terminal existence so transient pre-registration calls don't write
    // ghost timestamps onto missing panels.
    state.setFocused("not-here");
    expect(mockStampLastActive).not.toHaveBeenCalled();
  });

  it("openDockTerminal does not stamp when the panel is not an openable dock terminal", () => {
    // The early-return branch (non-dock or missing terminal) clears dock state
    // without registering user focus — no stamp should fire.
    state.openDockTerminal("a"); // "a" is a grid panel, not dock
    expect(mockStampLastActive).not.toHaveBeenCalled();
  });
});

// Issue #9933 — the post-hydration focus pick must not corrupt persistence
// (`lastActiveAt`, MRU). `setBootFocus` is the bare commit used by the boot
// picker: it lands an initial `focusedId` but does NOT stamp activity, wake
// the terminal, or ping it. Callers are responsible for wrapping the call in
// `suppressMruRecording` if the orchestrator's MRU subscription must be
// gated.
describe("TerminalFocusSlice - boot focus (issue #9933)", () => {
  const makeTerminal = (id: string): PtyPanelData =>
    ({
      id,
      title: id,
      cwd: "/test",
      location: "grid",
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId: "worktree-1",
    }) as PtyPanelData;

  let terminals: PtyPanelData[];
  let state: TerminalFocusSlice;

  beforeEach(() => {
    vi.clearAllMocks();
    terminals = [makeTerminal("a"), makeTerminal("b")];
    const getTerminals = vi.fn(() => terminals);
    const getState = vi.fn((): TerminalFocusSlice => state);
    const setState = vi.fn(
      (
        updater:
          | Partial<TerminalFocusSlice>
          | ((s: TerminalFocusSlice) => Partial<TerminalFocusSlice>)
      ) => {
        const currentState = getState();
        const updates = typeof updater === "function" ? updater(currentState) : updater;
        state = { ...currentState, ...updates };
      }
    );
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState as never, getState as never, {} as never);
  });

  it("setBootFocus sets focusedId and clears activeDockTerminalId", () => {
    state.focusedId = null;
    state.activeDockTerminalId = "stale-dock";

    state.setBootFocus("a");

    expect(state.focusedId).toBe("a");
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("setBootFocus does NOT call stampLastActive", () => {
    // The whole point of the new setter: persistence must not be touched.
    // If this fires, the per-panel recency that `panelRestorePhase` uses
    // to promote each worktree's most-recently-focused panel gets
    // overwritten on every boot (#9933).
    state.setBootFocus("a");
    expect(mockStampLastActive).not.toHaveBeenCalled();
  });

  it("setBootFocus does NOT call terminalInstanceService.wake", () => {
    // The boot pick targets a panel the restore pipeline already woke.
    // Waking it again would be wasted work and could race with the
    // restore-batch PTY spawn.
    state.setBootFocus("a");
    expect(terminalInstanceService.wake).not.toHaveBeenCalled();
  });

  it("setBootFocus updates previousFocusedId only when focus actually changes", () => {
    // null → "a" changes focus: previousFocusedId should be preserved
    // (the prior value was null, so it stays null — no real prior
    // focus existed).
    state.focusedId = null;
    state.previousFocusedId = null;
    state.setBootFocus("a");
    expect(state.previousFocusedId).toBeNull();

    // "a" → "b" changes focus: previousFocusedId should become "a".
    state.setBootFocus("b");
    expect(state.previousFocusedId).toBe("a");

    // "b" → "b" is a no-op: previousFocusedId must NOT move to "b"
    // (the toggle-anchor would lose its real prior value).
    state.setBootFocus("b");
    expect(state.previousFocusedId).toBe("a");
  });

  it("setBootFocus does NOT trigger pingTerminal (no user intent to visualize)", () => {
    // Defensive: even though `setBootFocus` doesn't directly call
    // pingTerminal, this guards against future regressions where
    // someone adds an unconditional ping to the grid branch.
    state.setBootFocus("a");
    expect(state.pingedId).toBeNull();
    expect(state.pingSeq).toBe(0);
  });
});

/**
 * Closing the dock popover used to clear `activeDockTerminalId` and nothing
 * else. If the dismissed pane held focus, `focusedId` kept pointing at it while
 * its DOM subtree was parked in an aria-hidden container — the pane the user
 * could no longer see went on eating every keystroke (#11133).
 */
describe("TerminalFocusSlice - closeDockTerminal focus reconciliation (#11133)", () => {
  const makePanel = (
    id: string,
    location: "grid" | "dock",
    worktreeId: string | undefined = "worktree-1"
  ): PtyPanelData =>
    ({
      id,
      title: id,
      kind: "terminal",
      type: "terminal",
      cwd: "/test",
      location,
      agentState: "idle",
      isVisible: true,
      cols: 80,
      rows: 24,
      worktreeId,
    }) as PtyPanelData;

  let panels: PtyPanelData[];
  let state: TerminalFocusSlice;

  beforeEach(() => {
    vi.clearAllMocks();
    panelGroupInfoImpl = () => undefined;
    panels = [
      makePanel("grid-1", "grid"),
      makePanel("grid-2", "grid"),
      makePanel("dock-1", "dock"),
      makePanel("dock-2", "dock"),
    ];
    const getTerminals = vi.fn(() => panels);
    const getState = vi.fn((): TerminalFocusSlice => state);
    const setState = vi.fn(
      (
        updater:
          | Partial<TerminalFocusSlice>
          | ((s: TerminalFocusSlice) => Partial<TerminalFocusSlice>)
      ) => {
        const currentState = getState();
        const updates = typeof updater === "function" ? updater(currentState) : updater;
        state = { ...currentState, ...updates };
      }
    );
    state = createTerminalFocusSlice(
      getTerminals,
      mockGetActiveWorktreeId,
      mockStampLastActive,
      mockGetPanelGroupInfo
    )(setState as never, getState as never, {} as never);
    state.activeDockTerminalId = "dock-1";
    state.focusedId = "dock-1";
    state.previousFocusedId = "grid-2";
  });

  it("hands focus back to the pane the user opened the dock from", () => {
    state.closeDockTerminal("dock-1");

    expect(state.activeDockTerminalId).toBeNull();
    expect(state.focusedId).toBe("grid-2");
    // Automatic hand-back, not a user navigation — there is no pane to bounce
    // back to, so the alternate pointer must not survive.
    expect(state.previousFocusedId).toBeNull();
  });

  it("falls back to a visible grid pane when the previous pane is gone", () => {
    state.previousFocusedId = "deleted-panel";

    state.closeDockTerminal("dock-1");

    expect(state.focusedId).toBe("grid-1");
  });

  it("never hands focus to another dock pane", () => {
    state.previousFocusedId = "dock-2";

    state.closeDockTerminal("dock-1");

    expect(state.focusedId).toBe("grid-1");
  });

  it("clears focus when the worktree has no visible grid pane left", () => {
    panels = [makePanel("dock-1", "dock"), makePanel("dock-2", "dock")];
    state.previousFocusedId = null;

    state.closeDockTerminal("dock-1");

    expect(state.focusedId).toBeNull();
    expect(state.activeDockTerminalId).toBeNull();
  });

  it("leaves focus alone when the dismissed pane never held it", () => {
    state.focusedId = "grid-1";
    state.previousFocusedId = "grid-2";

    state.closeDockTerminal("dock-1");

    expect(state.activeDockTerminalId).toBeNull();
    expect(state.focusedId).toBe("grid-1");
    expect(state.previousFocusedId).toBe("grid-2");
  });

  it("ignores a stale close for a pane the dock has already moved on from", () => {
    // Dock popovers open and close from several places at once (chip click,
    // drag start, Escape, the phantom-panel watchdog). A late close for the
    // pane that *was* open must not tear focus out of the one that just won it.
    state.activeDockTerminalId = "dock-2";
    state.focusedId = "dock-2";

    state.closeDockTerminal("dock-1");

    expect(state.activeDockTerminalId).toBe("dock-2");
    expect(state.focusedId).toBe("dock-2");
  });

  it("hands focus to the maximized pane, not the first pane in the grid", () => {
    // Only the maximized pane is on screen. A dock-to-dock switch overwrites
    // `previousFocusedId` with the other dock pane, so the fallback cannot lean
    // on it here — picking the first grid pane would focus one nothing renders.
    state.previousFocusedId = "dock-2";
    state.maximizedId = "grid-2";
    state.maximizeTarget = { type: "panel", id: "grid-2" };

    state.closeDockTerminal("dock-1");

    expect(state.focusedId).toBe("grid-2");
  });

  it("hands focus to a group's visible tab, never a tab behind it", () => {
    panelGroupInfoImpl = (panelId) =>
      panelId === "grid-1" || panelId === "grid-2"
        ? { groupId: "group-1", activeTabId: "grid-2" }
        : undefined;
    state.previousFocusedId = null;

    state.closeDockTerminal("dock-1");

    // grid-1 comes first in panel order but is a background tab of the group.
    expect(state.focusedId).toBe("grid-2");
  });
});
