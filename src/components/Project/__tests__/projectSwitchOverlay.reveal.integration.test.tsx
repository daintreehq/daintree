/**
 * @vitest-environment jsdom
 *
 * End-to-end guard for the stuck-overlay regression (#10736): wires the REAL
 * projectStore, the REAL useResetSwitchOverlayOnReveal hook, and the REAL
 * ProjectSwitchOverlay together. The per-unit tests mock the seams between
 * them, so they'd still pass if the units stopped composing — this proves a
 * cached view's stale switch flag actually clears (and the overlay disappears)
 * when the main process fires `app:view-revealed`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

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
import { useResetSwitchOverlayOnReveal } from "@/hooks/app/useResetSwitchOverlayOnReveal";
import { ProjectSwitchOverlay } from "../ProjectSwitchOverlay";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

let revealCallback: (() => void) | null = null;
const onViewRevealedMock = vi.fn((cb: () => void) => {
  revealCallback = cb;
  return () => {};
});

function Harness() {
  useResetSwitchOverlayOnReveal();
  const isSwitching = useProjectStore((s) => s.isSwitching);
  const switchTargetId = useProjectStore((s) => s.switchingToProjectId);
  const clearSwitching = useProjectStore((s) => s.clearSwitching);
  return (
    <ProjectSwitchOverlay
      isSwitching={isSwitching}
      switchTargetId={switchTargetId}
      onAutoDismiss={clearSwitching}
    />
  );
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="status"]');
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("ProjectSwitchOverlay reveal integration (#10736)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    revealCallback = null;
    onViewRevealedMock.mockClear();
    (window as unknown as { electron: unknown }).electron = {
      app: { onViewRevealed: onViewRevealedMock },
    };
    useProjectStore.setState({ isSwitching: false, switchingToProjectId: null, isLoading: false });
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("clears the stuck switch state and tears down the overlay when the view is revealed", () => {
    render(<Harness />);

    // Reproduce the parked-renderer state: a switch was started and the flags
    // were never cleared (happy path leaves them set).
    act(() => {
      useProjectStore.setState({
        isSwitching: true,
        switchingToProjectId: "project-b",
        isLoading: true,
      });
    });
    advance(UI_DOHERTY_THRESHOLD + 50);
    expect(overlay()).not.toBeNull();

    // Main reveals this cached view as the foreground again.
    act(() => {
      revealCallback?.();
    });

    expect(useProjectStore.getState().isSwitching).toBe(false);
    expect(useProjectStore.getState().switchingToProjectId).toBeNull();
    expect(useProjectStore.getState().isLoading).toBe(false);
    expect(overlay()).toBeNull();
  });
});
