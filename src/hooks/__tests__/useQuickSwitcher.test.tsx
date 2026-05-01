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
