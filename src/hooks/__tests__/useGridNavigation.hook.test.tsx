// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("@/clients", () => ({
  terminalClient: { spawn: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { cleanup: vi.fn() },
}));

const { usePanelStore } = await import("@/store/panelStore");
const { useGridNavigation } = await import("../useGridNavigation");
const { setGridLayoutSnapshot } = await import("@/components/Terminal/gridLayoutSnapshot");
import type { PtyPanelData } from "@shared/types/panel";

function seed(ids: string[], location: "grid" | "dock" = "grid") {
  const panelsById: Record<string, PtyPanelData> = {};
  for (const id of ids)
    panelsById[id] = { id, kind: "terminal", location, title: id, cwd: "/tmp", cols: 80, rows: 24 };
  usePanelStore.setState({
    panelsById,
    panelIds: ids,
    focusedId: ids[0] ?? null,
  });
}

describe("useGridNavigation", () => {
  beforeEach(() => {
    void usePanelStore.getState().reset();
    setGridLayoutSnapshot({ gridCols: 2, gridItemCount: 0, fleetGridCols: 2 });
  });
  afterEach(() => {
    void usePanelStore.getState().reset();
  });

  it("navigates the grid and follows later store changes", () => {
    seed(["a", "b", "c", "d"]);
    const { result } = renderHook(() => useGridNavigation());

    expect(result.current.findNearest("a", "right")).toBe("b");
    expect(result.current.findNearest("b", "right")).toBe("c");
    expect(result.current.findNearest("a", "down")).toBe("c");
    expect(result.current.findByIndex(4)).toBe("d");

    act(() => seed(["a", "b", "c"]));
    expect(result.current.findNearest("c", "right")).toBe("a");
    expect(result.current.findByIndex(4)).toBeNull();
  });

  it("picks up column-count changes without a re-render", () => {
    seed(["a", "b", "c", "d"]);
    const { result } = renderHook(() => useGridNavigation());
    expect(result.current.findNearest("a", "down")).toBe("c");
    act(() => setGridLayoutSnapshot({ gridCols: 4, gridItemCount: 0, fleetGridCols: 4 }));
    expect(result.current.findNearest("a", "down")).toBe("a");
  });

  it("walks dock panels and reports the focused location", () => {
    seed(["a", "b"], "dock");
    const { result } = renderHook(() => useGridNavigation());
    expect(result.current.findDockByIndex("a", "right")).toBe("b");
    expect(result.current.findDockByIndex("a", "left")).toBeNull();
    expect(result.current.getCurrentLocation()).toBe("dock");
  });

  it("does not re-render on panelsById churn", () => {
    seed(["a", "b"]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useGridNavigation();
    });
    const before = renders;
    const findNearest = result.current.findNearest;
    for (let i = 0; i < 20; i++) {
      act(() => {
        const s = usePanelStore.getState();
        usePanelStore.setState({
          panelsById: { ...s.panelsById, a: { ...s.panelsById.a!, title: `t${i}` } },
        });
      });
    }
    expect(renders).toBe(before);
    expect(result.current.findNearest).toBe(findNearest);
    expect(result.current.findNearest("a", "right")).toBe("b");
  });

  it("follows tab-group and worktree scope changes", () => {
    seed(["a", "b", "c"]);
    const { result } = renderHook(() => useGridNavigation());
    expect(result.current.findByIndex(3)).toBe("c");
    act(() => {
      const s = usePanelStore.getState();
      usePanelStore.setState({
        panelsById: { ...s.panelsById, b: { ...s.panelsById.b!, location: "dock" } },
      });
    });
    expect(result.current.findByIndex(3)).toBeNull();
    expect(result.current.findDockByIndex("b", "right")).toBeNull();
    expect(result.current.getCurrentLocation()).toBe("grid");
  });
});
