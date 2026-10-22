// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { PluginPanelActivityReport } from "@shared/types/plugin";
import { registerPanelKind, unregisterPluginPanelKinds } from "@shared/config/panelKindRegistry";
import { HAND_BACK_SEEN_DWELL_MS } from "@shared/utils/runHandBack";
import { usePanelStore } from "@/store/panelStore";
import { useCanopyStore } from "@/store/canopyStore";
import {
  _resetPluginPanelActivityStoreForTest,
  usePluginPanelActivityStore,
} from "@/store/pluginPanelActivityStore";
import { usePluginPanelActivitySeenTracking } from "../usePluginPanelActivitySeenTracking";

function panel(id: string, kind: string, location: "grid" | "dock" | "trash" = "grid") {
  return { id, kind, title: id, location } as never;
}

type Payload = { pluginId: string; activity: Record<string, PluginPanelActivityReport> };
let push: (payload: Payload) => void = () => {};
let windowFocused = true;

const seen = () => usePluginPanelActivityStore.getState().seenRevisionByPanelId;

function report(activity: Record<string, PluginPanelActivityReport>, pluginId = "acme") {
  act(() => {
    push({ pluginId, activity });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  windowFocused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
  Object.defineProperty(window, "electron", {
    value: {
      plugin: {
        onPanelActivityChanged: (cb: (payload: Payload) => void) => {
          push = cb;
          return () => {};
        },
      },
    },
    configurable: true,
    writable: true,
  });
  _resetPluginPanelActivityStoreForTest();
  for (const [id, extensionId, reportsActivity] of [
    ["acme.chat", "acme", true],
    ["acme.notes", "acme", undefined],
  ] as const) {
    registerPanelKind({
      id,
      name: id,
      iconId: "puzzle",
      color: "#888888",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId,
      ...(reportsActivity ? { reportsActivity } : {}),
    });
  }
  usePanelStore.setState({
    panelsById: {
      a: panel("a", "acme.chat"),
      b: panel("b", "acme.chat"),
      notes: panel("notes", "acme.notes"),
      gone: panel("gone", "acme.chat", "trash"),
    },
    panelIds: ["a", "b", "notes", "gone"],
    focusedId: "a",
  });
});

afterEach(() => {
  unregisterPluginPanelKinds("acme");
  _resetPluginPanelActivityStoreForTest();
  useCanopyStore.setState({ isOpen: false });
  delete (window as { electron?: unknown }).electron;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("usePluginPanelActivitySeenTracking", () => {
  it("marks a finished report seen once its panel has been in front for the dwell", () => {
    renderHook(() => usePluginPanelActivitySeenTracking());
    report({ a: { state: "finished", revision: 1 } });

    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS - 1);
    });
    expect(seen().a).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(seen().a).toBe(1);
  });

  it("leaves a report unread when focus moves off before the dwell", () => {
    renderHook(() => usePluginPanelActivitySeenTracking());
    report({ a: { state: "finished", revision: 1 } });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS / 2);
    });
    act(() => {
      usePanelStore.setState({ focusedId: "b" });
    });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    });
    expect(seen().a).toBeUndefined();
  });

  it("marks a panel's report seen when the user comes to it later", () => {
    usePanelStore.setState({ focusedId: "b" });
    renderHook(() => usePluginPanelActivitySeenTracking());
    report({ a: { state: "finished", revision: 3 } });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 2);
    });
    expect(seen().a).toBeUndefined();

    act(() => {
      usePanelStore.setState({ focusedId: "a" });
    });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    });
    expect(seen().a).toBe(3);
  });

  it("does not count a pane behind another app's window, or under Canopy", () => {
    windowFocused = false;
    renderHook(() => usePluginPanelActivitySeenTracking());
    report({ a: { state: "finished", revision: 1 } });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 2);
    });
    expect(seen().a).toBeUndefined();

    windowFocused = true;
    act(() => {
      useCanopyStore.setState({ isOpen: true });
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 2);
    });
    expect(seen().a).toBeUndefined();

    act(() => {
      useCanopyStore.setState({ isOpen: false });
    });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    });
    expect(seen().a).toBe(1);
  });

  it("never marks working, waiting or failed, a trashed panel, or an undeclared kind", () => {
    renderHook(() => usePluginPanelActivitySeenTracking());
    report({
      a: { state: "failed", revision: 1 },
      notes: { state: "finished", revision: 2 },
      gone: { state: "finished", revision: 3 },
    });
    for (const id of ["a", "notes", "gone"]) {
      act(() => {
        usePanelStore.setState({ focusedId: id });
      });
      act(() => {
        vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 2);
      });
    }
    expect(seen()).toEqual({});
  });

  it("ignores another plugin's report on the panel", () => {
    renderHook(() => usePluginPanelActivitySeenTracking());
    report({ a: { state: "finished", revision: 1 } }, "other");
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 2);
    });
    expect(seen()).toEqual({});
  });

  it("reads a new completion as unread again until it too is seen", () => {
    renderHook(() => usePluginPanelActivitySeenTracking());
    report({ a: { state: "finished", revision: 1 } });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    });
    expect(seen().a).toBe(1);

    act(() => {
      usePanelStore.setState({ focusedId: "b" });
    });
    report({ a: { state: "working", revision: 2 } });
    report({ a: { state: "finished", revision: 3 } });
    expect(seen().a).toBe(1);
    act(() => {
      usePanelStore.setState({ focusedId: "a" });
    });
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    });
    expect(seen().a).toBe(3);
  });

  it("stops watching on unmount", () => {
    const { unmount } = renderHook(() => usePluginPanelActivitySeenTracking());
    report({ a: { state: "finished", revision: 1 } });
    unmount();
    act(() => {
      vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 2);
    });
    expect(seen().a).toBeUndefined();
  });
});
