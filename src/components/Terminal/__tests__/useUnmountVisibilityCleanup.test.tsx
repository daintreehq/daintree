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
