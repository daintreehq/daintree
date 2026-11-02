// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowGlobalAssistantPanel } from "@shared/types/ipc/help";
import type { ProjectViewLifecyclePhase } from "@/lib/viewCacheState";

const lifecycle = vi.hoisted(() => ({
  cached: false,
  listeners: new Set<(phase: ProjectViewLifecyclePhase) => void>(),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => lifecycle.cached,
  subscribeProjectViewLifecycle: (listener: (phase: ProjectViewLifecyclePhase) => void) => {
    lifecycle.listeners.add(listener);
    return () => lifecycle.listeners.delete(listener);
  },
}));
const host = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => host.id }));
vi.mock("@/clients/agentDefaultsClient", () => ({ agentDefaultsClient: { set: vi.fn() } }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useWindowGlobalAssistantPanel } from "../useWindowGlobalAssistantPanel";

const initialState = useHelpPanelStore.getState();
const target = {
  hostId: "local",
  scope: { kind: "global" as const },
  terminalId: "global-1",
  incarnation: 3,
};
const shown: WindowGlobalAssistantPanel = { showing: true, target };
const closed: WindowGlobalAssistantPanel = { showing: false, target: null };

let reads: Array<(panel: WindowGlobalAssistantPanel | null) => void>;
const getPanel = vi.fn(
  () =>
    new Promise<WindowGlobalAssistantPanel | null>((resolve) => {
      reads.push(resolve);
    })
);
const reportPanel = vi.fn((_panel: WindowGlobalAssistantPanel) => Promise.resolve());

function emit(phase: ProjectViewLifecyclePhase) {
  if (phase === "cached") lifecycle.cached = true;
  else lifecycle.cached = false;
  for (const listener of Array.from(lifecycle.listeners)) listener(phase);
}

async function answer(panel: WindowGlobalAssistantPanel | null, index = reads.length - 1) {
  await act(async () => {
    reads[index]!(panel);
    await Promise.resolve();
  });
}

const reported = () => reportPanel.mock.calls.map(([panel]) => panel);

describe("useWindowGlobalAssistantPanel (#16099)", () => {
  beforeEach(() => {
    reads = [];
    getPanel.mockClear();
    reportPanel.mockClear();
    lifecycle.cached = false;
    lifecycle.listeners.clear();
    host.id = null;
    useHelpPanelStore.setState(initialState, true);
    Object.assign(window, {
      electron: {
        help: {
          getWindowGlobalAssistantPanel: getPanel,
          reportWindowGlobalAssistantPanel: reportPanel,
        },
      },
    });
  });

  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  it("opens a cold view on Global when the window showed it, leaving the keyboard alone", async () => {
    useHelpPanelStore.getState().requestFocus();
    renderHook(() => useWindowGlobalAssistantPanel());
    expect(getPanel).toHaveBeenCalledTimes(1);

    await answer(shown);

    expect(useHelpPanelStore.getState()).toMatchObject({
      isOpen: true,
      globalSelected: true,
      globalTarget: target,
      focusRequest: 1,
      globalFocusHandledThrough: 1,
    });
    expect(reported()).toEqual([shown]);
  });

  it("says nothing of its own defaults before it has read the window's record", async () => {
    renderHook(() => useWindowGlobalAssistantPanel());
    act(() => useHelpPanelStore.getState().requestFocus());
    expect(reportPanel).not.toHaveBeenCalled();

    // The first view of a window: nothing to take on, and its state becomes the window's.
    await answer(null);
    expect(useHelpPanelStore.getState().isOpen).toBe(false);
    expect(reported()).toEqual([closed]);
  });

  it("lets a choice made while it read stand over the window's record", async () => {
    renderHook(() => useWindowGlobalAssistantPanel());
    // An "Open in Assistant" landing on this project's lane arrives first.
    act(() => {
      useHelpPanelStore.getState().openSlot();
      useHelpPanelStore.getState().setOpen(true);
    });

    await answer(shown);

    expect(useHelpPanelStore.getState()).toMatchObject({
      isOpen: true,
      globalSelected: false,
      activeSlot: 1,
    });
    expect(reported()).toEqual([closed]);
  });

  it("reports each change of Global's showing or target, and only those", async () => {
    renderHook(() => useWindowGlobalAssistantPanel());
    await answer(null);
    reportPanel.mockClear();

    act(() => {
      useHelpPanelStore.getState().selectGlobal(target);
      useHelpPanelStore.getState().setOpen(true);
    });
    act(() => useHelpPanelStore.getState().requestFocus());
    act(() => useHelpPanelStore.getState().selectGlobal(null));
    act(() => useHelpPanelStore.getState().setOpen(false));
    // A lane opening is this project's own, and Global stays closed.
    act(() => useHelpPanelStore.getState().setActiveSlot(0));
    act(() => useHelpPanelStore.getState().setOpen(true));

    expect(reported()).toEqual([shown, { showing: true, target: null }, closed]);
  });

  it("closes stale Global on returning from the cache once the window closed it", async () => {
    renderHook(() => useWindowGlobalAssistantPanel());
    await answer(shown);

    act(() => emit("cached"));
    reportPanel.mockClear();
    // While cached it no longer speaks for the window.
    act(() => useHelpPanelStore.getState().setWidth(500));
    act(() => useHelpPanelStore.getState().selectGlobal(null));
    expect(reportPanel).not.toHaveBeenCalled();

    act(() => emit("active"));
    expect(getPanel).toHaveBeenCalledTimes(2);
    await answer(closed);

    expect(useHelpPanelStore.getState()).toMatchObject({ isOpen: false, globalSelected: true });
    expect(reported()).toEqual([closed]);
  });

  it("drops a read the cache overtook, and reads again on reveal if no activation came", async () => {
    renderHook(() => useWindowGlobalAssistantPanel());
    act(() => emit("cached"));
    await answer(shown, 0);
    expect(useHelpPanelStore.getState().isOpen).toBe(false);
    expect(reportPanel).not.toHaveBeenCalled();

    act(() => emit("revealed"));
    expect(getPanel).toHaveBeenCalledTimes(2);
    await answer(shown);
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
    // Already reading or synced, a reveal asks nothing more.
    act(() => emit("revealed"));
    expect(getPanel).toHaveBeenCalledTimes(2);
  });

  it("starts reading only once a view restored in the background comes on screen", async () => {
    lifecycle.cached = true;
    renderHook(() => useWindowGlobalAssistantPanel());
    expect(getPanel).not.toHaveBeenCalled();

    act(() => emit("active"));
    await answer(shown);
    expect(useHelpPanelStore.getState().globalSelected).toBe(true);
  });

  it("keeps out of a window bound to another host", () => {
    host.id = "studio-01";
    renderHook(() => useWindowGlobalAssistantPanel());
    act(() => {
      useHelpPanelStore.getState().selectGlobal(target);
      useHelpPanelStore.getState().setOpen(true);
    });
    expect(getPanel).not.toHaveBeenCalled();
    expect(reportPanel).not.toHaveBeenCalled();
  });

  it("stops listening on unmount and ignores a read that lands after it", async () => {
    const { unmount } = renderHook(() => useWindowGlobalAssistantPanel());
    unmount();
    await answer(shown);
    act(() => useHelpPanelStore.getState().setOpen(true));

    expect(useHelpPanelStore.getState().globalSelected).toBe(false);
    expect(reportPanel).not.toHaveBeenCalled();
    expect(lifecycle.listeners.size).toBe(0);
  });
});
