// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

const { selectWorktreeMock } = vi.hoisted(() => ({ selectWorktreeMock: vi.fn() }));

vi.mock("@/store", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ selectWorktree: selectWorktreeMock, activeWorktreeId: "wt-main" }),
}));

import { useWorktreePalette } from "../useWorktreePalette";
import { usePaletteStore } from "@/store/paletteStore";
import { consumeDeferredPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";

function worktree(id: string, name: string, isMainWorktree = false): WorktreeState {
  return { id, name, path: `/repo/${name}`, isMainWorktree } as WorktreeState;
}

const worktrees = [worktree("wt-main", "main", true), worktree("wt-feature", "feature")];

// Switching worktrees focuses the target's last panel; the palette's exit-time
// restore ~100ms later must not hand the keyboard back to the opener (#16923).
describe("useWorktreePalette focus restore", () => {
  beforeEach(() => {
    selectWorktreeMock.mockReset();
    consumeDeferredPaletteFocusRestore();
    usePaletteStore.setState({ activePaletteId: "worktree" });
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
    consumeDeferredPaletteFocusRestore();
  });

  it("hands the restore to a worktree picked by click", () => {
    const { result } = renderHook(() => useWorktreePalette({ worktrees }));

    act(() => result.current.selectWorktree(worktrees[1]!));

    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-feature");
    expect(result.current.isOpen).toBe(false);
    // The hand-off runs the palette's guarded restore, which only refocuses the
    // opener while nothing else holds the keyboard.
    const receive = consumeDeferredPaletteFocusRestore();
    expect(receive).not.toBeNull();
    const restore = vi.fn();
    receive!(restore);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("hands the restore to a worktree picked with Enter", () => {
    const { result } = renderHook(() => useWorktreePalette({ worktrees }));
    act(() => result.current.selectNext());
    expect(result.current.results[result.current.selectedIndex]?.id).toBe("wt-feature");

    act(() => result.current.confirmSelection());

    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-feature");
    expect(result.current.isOpen).toBe(false);
    expect(consumeDeferredPaletteFocusRestore()).not.toBeNull();
  });

  it("keeps the opener restore for a dismissal and for Enter with nothing to pick", () => {
    const { result } = renderHook(() => useWorktreePalette({ worktrees: [] }));

    act(() => result.current.confirmSelection());
    expect(selectWorktreeMock).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);
    expect(consumeDeferredPaletteFocusRestore()).toBeNull();

    act(() => usePaletteStore.setState({ activePaletteId: "worktree" }));
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(consumeDeferredPaletteFocusRestore()).toBeNull();
  });
});
