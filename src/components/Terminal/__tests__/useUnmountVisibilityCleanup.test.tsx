/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUnmountVisibilityCleanup } from "../useUnmountVisibilityCleanup";

const mocks = vi.hoisted(() => ({
  getAttachGeneration: vi.fn(() => 1),
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { getAttachGeneration: mocks.getAttachGeneration },
}));

describe("useUnmountVisibilityCleanup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.getAttachGeneration.mockReturnValue(1);
  });

  it("marks the panel hidden on a real unmount (generation unchanged)", () => {
    const updateVisibility = vi.fn();
    const { unmount } = renderHook(() => useUnmountVisibilityCleanup("t1", 0, updateVisibility));

    unmount();
    expect(updateVisibility).toHaveBeenCalledTimes(1);
    expect(updateVisibility).toHaveBeenCalledWith("t1", false);
  });

  it("skips the stale cleanup when the terminal re-attached under a newer generation", () => {
    const updateVisibility = vi.fn();
    const { unmount } = renderHook(() => useUnmountVisibilityCleanup("t1", 0, updateVisibility));

    // Warm-swap: the replacement pane attaches before this cleanup fires.
    mocks.getAttachGeneration.mockReturnValue(2);
    unmount();
    expect(updateVisibility).not.toHaveBeenCalled();
  });

  it("re-captures the generation when restartKey changes", () => {
    const updateVisibility = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ restartKey }) => useUnmountVisibilityCleanup("t1", restartKey, updateVisibility),
      { initialProps: { restartKey: 0 } }
    );

    // Restart re-attaches (generation bumps) before the effect re-runs; the
    // outgoing effect's cleanup must not write false for the still-mounted pane.
    mocks.getAttachGeneration.mockReturnValue(2);
    rerender({ restartKey: 1 });
    expect(updateVisibility).not.toHaveBeenCalled();

    // The re-captured generation makes the final real unmount clean up normally.
    unmount();
    expect(updateVisibility).toHaveBeenCalledTimes(1);
    expect(updateVisibility).toHaveBeenCalledWith("t1", false);
  });

  it("still cleans up after this mount's own late attach advanced the generation", () => {
    const updateVisibility = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ attachEpoch }) => useUnmountVisibilityCleanup("t1", 0, updateVisibility, attachEpoch),
      { initialProps: { attachEpoch: 0 } }
    );

    // XtermAdapter awaits getOrCreate, so this mount's own attach lands after
    // the passive capture. Announcing it must re-capture, not be read as a
    // warm-swap by someone else.
    mocks.getAttachGeneration.mockReturnValue(2);
    rerender({ attachEpoch: 1 });

    // Re-capturing must not fire the cleanup while the pane is still mounted.
    expect(updateVisibility).not.toHaveBeenCalled();

    unmount();
    expect(updateVisibility).toHaveBeenCalledTimes(1);
    expect(updateVisibility).toHaveBeenCalledWith("t1", false);
  });

  it("still skips a genuinely superseded mount that never announced the attach", () => {
    const updateVisibility = vi.fn();
    const { unmount } = renderHook(
      ({ attachEpoch }) => useUnmountVisibilityCleanup("t1", 0, updateVisibility, attachEpoch),
      { initialProps: { attachEpoch: 0 } }
    );

    // A replacement pane attached — this mount's own epoch never moved, so the
    // owned generation stays behind and the write must not land.
    mocks.getAttachGeneration.mockReturnValue(2);
    unmount();

    expect(updateVisibility).not.toHaveBeenCalled();
  });

  it("cleans up the outgoing id when the pane is reused for another terminal", () => {
    const updateVisibility = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useUnmountVisibilityCleanup(id, 0, updateVisibility),
      { initialProps: { id: "t1" } }
    );

    rerender({ id: "t2" });
    expect(updateVisibility).toHaveBeenCalledTimes(1);
    expect(updateVisibility).toHaveBeenCalledWith("t1", false);
  });
});
