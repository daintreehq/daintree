/**
 * @vitest-environment jsdom
 *
 * Integration guard for the stuck-busy-state regression (#10736): wires the REAL
 * projectStore and the REAL useClearSwitchBusyStateOnReveal hook together. The
 * hook's unit test mocks the store seam, so it'd still pass if the units stopped
 * composing — this proves a cached view's stale switch flags (`isSwitching`,
 * `switchingToProjectId`, `isLoading`) actually clear when the main process
 * fires `app:view-revealed`, so the reactivated view's ProjectSwitcher never
 * resurfaces a stuck busy spinner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

// projectStore pulls these in at module load; stub them so the real store
// imports cleanly (mirrors projectStore.switching.test.ts).
vi.mock("@/clients", () => ({
  projectClient: {
    getAll: vi.fn().mockResolvedValue([]),
    getCurrent: vi.fn().mockResolvedValue(null),
    switch: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(undefined),
    onWorktreeLoadStatus: vi.fn(() => () => {}),
  },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/errorContext", () => ({ logErrorWithContext: vi.fn() }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("../../../store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    getPreviousSnapshotMap: vi.fn(() => undefined),
    cancel: vi.fn(),
  },
  panelToSnapshot: vi.fn(),
}));

import { useProjectStore } from "@/store/projectStore";
import { useClearSwitchBusyStateOnReveal } from "../useClearSwitchBusyStateOnReveal";

let revealCallback: (() => void) | null = null;
const onViewRevealedMock = vi.fn((cb: () => void) => {
  revealCallback = cb;
  return () => {};
});

describe("useClearSwitchBusyStateOnReveal reveal integration (#10736)", () => {
  beforeEach(() => {
    revealCallback = null;
    onViewRevealedMock.mockClear();
    (window as unknown as { electron: unknown }).electron = {
      app: { onViewRevealed: onViewRevealedMock },
    };
    useProjectStore.setState({ isSwitching: false, switchingToProjectId: null, isLoading: false });
  });

  afterEach(() => {
    cleanup();
  });

  it("clears the stuck switch flags when the cached view is revealed", () => {
    renderHook(() => useClearSwitchBusyStateOnReveal());

    // Reproduce the parked-renderer state: a switch was started and the flags
    // were never cleared (the happy path leaves them set).
    act(() => {
      useProjectStore.setState({
        isSwitching: true,
        switchingToProjectId: "project-b",
        isLoading: true,
      });
    });

    // Main reveals this cached view as the foreground again.
    act(() => {
      revealCallback?.();
    });

    expect(useProjectStore.getState().isSwitching).toBe(false);
    expect(useProjectStore.getState().switchingToProjectId).toBeNull();
    expect(useProjectStore.getState().isLoading).toBe(false);
  });

  it("a reveal with no switch in flight does not clobber an unrelated isLoading", () => {
    renderHook(() => useClearSwitchBusyStateOnReveal());

    // A non-switch load is in flight (load/add/remove all share `isLoading`),
    // with no switch flagged.
    act(() => {
      useProjectStore.setState({
        isSwitching: false,
        switchingToProjectId: null,
        isLoading: true,
      });
    });

    act(() => {
      revealCallback?.();
    });

    // clearSwitching's guard leaves the unrelated load untouched.
    expect(useProjectStore.getState().isLoading).toBe(true);
  });
});
