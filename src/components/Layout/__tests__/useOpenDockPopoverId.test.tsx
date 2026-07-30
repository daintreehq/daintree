// @vitest-environment jsdom
/**
 * The hook composes three stores, and the two it reads for scope are the easy
 * ones to get wrong: reading them imperatively inside the panel-store selector
 * would look correct and even pass a panel-store-driven test, while silently
 * never re-running when a worktree switch or the help panel is what changed.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOpenDockPopoverId, useDockPopoverLayerSync } from "../useOpenDockPopoverId";
import {
  getDockPopoverOpen,
  _resetForTests as _resetDockPopoverForTests,
} from "@/lib/dockPopoverLayer";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import type { PtyPanelData } from "@shared/types/panel";

// Annotated rather than inferred: a bare object literal widens `kind` and
// `location` to `string`, which vitest runs happily and only the composite
// typecheck rejects.
const DOCK_PANEL: PtyPanelData = {
  id: "dock-1",
  title: "Agent",
  kind: "terminal",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  location: "dock",
  worktreeId: "wt-a",
};

function seedVisibleDockPopover() {
  usePanelStore.setState({
    activeDockTerminalId: "dock-1",
    panelIds: ["dock-1"],
    panelsById: { "dock-1": DOCK_PANEL },
    trashedTerminals: new Map(),
  });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a" });
  useHelpPanelStore.setState({ terminalId: null });
}

beforeEach(() => {
  seedVisibleDockPopover();
});

afterEach(() => {
  usePanelStore.setState({
    activeDockTerminalId: null,
    panelIds: [],
    panelsById: {},
    trashedTerminals: new Map(),
  });
  useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  useHelpPanelStore.setState({ terminalId: null });
});

describe("useOpenDockPopoverId", () => {
  it("reports the dock popover the dock is rendering", () => {
    const { result } = renderHook(() => useOpenDockPopoverId());

    expect(result.current).toBe("dock-1");
  });

  it("re-derives when only the active worktree changes", () => {
    const { result } = renderHook(() => useOpenDockPopoverId());
    expect(result.current).toBe("dock-1");

    // No panel-store write at all: the dock filters the chip out on a worktree
    // switch while the pointer stays put (#7278).
    act(() => {
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-b" });
    });

    expect(result.current).toBeNull();
  });

  it("re-derives when only the help panel claims the terminal", () => {
    const { result } = renderHook(() => useOpenDockPopoverId());
    expect(result.current).toBe("dock-1");

    act(() => {
      useHelpPanelStore.setState({ terminalId: "dock-1" });
    });

    expect(result.current).toBeNull();
  });

  it("follows the pointer when the panel store changes", () => {
    const { result } = renderHook(() => useOpenDockPopoverId());

    act(() => {
      usePanelStore.setState({ activeDockTerminalId: null });
    });

    expect(result.current).toBeNull();
  });
});

/**
 * The publisher half. `AppDialog` reads a plain boolean and knows nothing about
 * the dock; this is the only thing that connects the two, so a dialog's
 * layering is only correct if this keeps the signal in step.
 */
describe("useDockPopoverLayerSync", () => {
  afterEach(() => {
    _resetDockPopoverForTests();
  });

  it("publishes that a popover is up while one is rendered", () => {
    renderHook(() => useDockPopoverLayerSync());

    expect(getDockPopoverOpen()).toBe(true);
  });

  it("publishes nothing when the pointer names a panel the dock filtered out", () => {
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-b" });
    renderHook(() => useDockPopoverLayerSync());

    expect(getDockPopoverOpen()).toBe(false);
  });

  it("follows the popover closing", () => {
    renderHook(() => useDockPopoverLayerSync());
    expect(getDockPopoverOpen()).toBe(true);

    act(() => {
      usePanelStore.setState({ activeDockTerminalId: null });
    });

    expect(getDockPopoverOpen()).toBe(false);
  });

  it("clears the signal when the view goes away", () => {
    const { unmount } = renderHook(() => useDockPopoverLayerSync());
    expect(getDockPopoverOpen()).toBe(true);

    // Otherwise a dialog surviving a teardown stays promoted over a popover
    // that no longer exists.
    unmount();

    expect(getDockPopoverOpen()).toBe(false);
  });
});
