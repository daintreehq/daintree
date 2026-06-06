// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";

const { useWorktreeStoreMock } = vi.hoisted(() => ({
  useWorktreeStoreMock: vi.fn(),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: useWorktreeStoreMock,
}));

vi.mock("@/store", async () => {
  const actual = await vi.importActual<typeof import("@/store")>("@/store");
  return {
    ...actual,
    useWorktreeSelectionStore: Object.assign(
      (selector: (s: unknown) => unknown) =>
        selector({ selectWorktree: vi.fn(), activeWorktreeId: null }),
      { getState: () => ({ activeWorktreeId: null }) }
    ),
  };
});

import { useQuickSwitcher } from "../useQuickSwitcher";

type MockWorktreeState = {
  worktrees: Map<string, unknown>;
  isLoading: boolean;
  isInitialized: boolean;
  isReconnecting: boolean;
  error: string | null;
};

function seedWorktreeState(state: Partial<MockWorktreeState>): void {
  const fullState: MockWorktreeState = {
    worktrees: new Map(),
    isLoading: false,
    isInitialized: false,
    isReconnecting: false,
    error: null,
    ...state,
  };
  useWorktreeStoreMock.mockImplementation((selector: (s: MockWorktreeState) => unknown) =>
    selector(fullState)
  );
}

describe("useQuickSwitcher isLoading", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [] });
    useWorktreeStoreMock.mockReset();
  });

  it("reports isLoading=true while the worktree store has not yet initialized", () => {
    seedWorktreeState({ isInitialized: false });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(true);
  });

  it("reports isLoading=false once the worktree store has hydrated", () => {
    seedWorktreeState({ isInitialized: true });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(false);
  });

  it("does not flip back to loading just because a refetch sets isLoading on the store", () => {
    // After cold-start the bar should stay hidden during a transient refresh —
    // only first-load (`!isInitialized`) is the real "no data yet" signal.
    seedWorktreeState({ isInitialized: true, isLoading: true });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(false);
  });

  it("does not show the bar after a fatal workspace-host error", () => {
    // setFatalError clears isInitialized AND isLoading and sets error. Without
    // the error guard, the bar would spin forever in this state instead of
    // letting the surrounding UI surface the failure.
    seedWorktreeState({ isInitialized: false, isLoading: false, error: "host crashed" });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(false);
  });

  it("is reactive to store updates", () => {
    seedWorktreeState({ isInitialized: false });
    const { result, rerender } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(true);
    act(() => {
      seedWorktreeState({ isInitialized: true });
    });
    rerender();
    expect(result.current.isLoading).toBe(false);
  });
});

describe("useQuickSwitcher MRU prune", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [] });
    useWorktreeStoreMock.mockReset();
  });

  it("does not prune while the item set is empty (panels still hydrating) (#9922)", () => {
    // Panels and worktrees populate asynchronously; pruning against an empty
    // item set here would gut the whole MRU list before this project's items load.
    const pruneMru = vi.fn();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      mruList: ["terminal:t-1", "worktree:wt-1"],
      pruneMru,
    });
    seedWorktreeState({ isInitialized: true });

    renderHook(() => useQuickSwitcher());

    expect(pruneMru).not.toHaveBeenCalled();
  });

  it("prunes against the current item set once items are present", () => {
    const pruneMru = vi.fn();
    usePanelStore.setState({
      panelsById: {
        "t-1": {
          id: "t-1",
          title: "T1",
          kind: "terminal",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["t-1"],
      mruList: ["terminal:t-1", "terminal:gone"],
      pruneMru,
    });
    seedWorktreeState({ isInitialized: true });

    renderHook(() => useQuickSwitcher());

    expect(pruneMru).toHaveBeenCalledWith(new Set(["terminal:t-1"]));
  });
});
