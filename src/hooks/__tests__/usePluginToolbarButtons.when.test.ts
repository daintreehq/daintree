// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { WhenClauseContext } from "@shared/utils/whenClause";

const { toolbarButtonsMock, onToolbarButtonsChangedMock, sweepMock, contextRef } = vi.hoisted(
  () => ({
    toolbarButtonsMock: vi.fn(),
    onToolbarButtonsChangedMock: vi.fn(),
    sweepMock: vi.fn(),
    contextRef: { current: {} as WhenClauseContext, listeners: new Set<() => void>() },
  })
);

vi.mock("@/store", () => ({
  useToolbarPreferencesStore: {
    getState: () => ({ sweepStalePluginPinnedButtons: sweepMock }),
  },
}));

vi.mock("@/hooks/useChromeWhenContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useChromeWhenContext: () =>
      useSyncExternalStore(
        (listener) => {
          contextRef.listeners.add(listener);
          return () => contextRef.listeners.delete(listener);
        },
        () => contextRef.current
      ),
  };
});

function setWhenContext(next: WhenClauseContext): void {
  contextRef.current = next;
  for (const listener of contextRef.listeners) listener();
}

function pluginButton(id: ToolbarButtonConfig["id"], when?: string): ToolbarButtonConfig {
  return {
    id,
    label: "Button",
    iconId: "star",
    actionId: "acme.do",
    priority: 3,
    pluginId: "acme",
    ...(when !== undefined ? { when } : {}),
  };
}

type Push = (p: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void;

beforeEach(() => {
  vi.clearAllMocks();
  contextRef.current = {};
  contextRef.listeners.clear();
  Reflect.set(window, "electron", {
    plugin: {
      toolbarButtons: toolbarButtonsMock,
      onToolbarButtonsChanged: onToolbarButtonsChangedMock,
    },
  });
  vi.resetModules();
  toolbarButtonsMock.mockResolvedValue([]);
  onToolbarButtonsChangedMock.mockReturnValue(() => {});
});

describe("useVisiblePluginToolbarButtons (#13785)", () => {
  it("shows a button only while its when clause holds, and brings it back", async () => {
    toolbarButtonsMock.mockResolvedValue([
      pluginButton("acme.always"),
      pluginButton("acme.git", "isGitBacked"),
    ]);
    const { useVisiblePluginToolbarButtons } = await import("../usePluginToolbarButtons");
    const { result } = renderHook(() => useVisiblePluginToolbarButtons());

    await waitFor(() => expect(result.current.buttonIds).toEqual(["acme.always"]));
    expect(result.current.configs.has("acme.git")).toBe(false);
    expect(result.current.isRegistered("acme.git")).toBe(false);

    act(() => setWhenContext({ isGitBacked: true }));
    expect(result.current.buttonIds).toEqual(["acme.always", "acme.git"]);
    expect(result.current.isRegistered("acme.git")).toBe(true);

    act(() => setWhenContext({ isGitBacked: false }));
    expect(result.current.buttonIds).toEqual(["acme.always"]);
  });

  it("closes a hidden button's popover, and leaves it closed when the button returns", async () => {
    toolbarButtonsMock.mockResolvedValue([pluginButton("acme.git", "isGitBacked")]);
    setWhenContext({ isGitBacked: true });
    const { useVisiblePluginToolbarButtons } = await import("../usePluginToolbarButtons");
    const { usePluginToolbarPopoverStore } = await import("@/store/pluginToolbarPopoverStore");
    const { result } = renderHook(() => useVisiblePluginToolbarButtons());

    await waitFor(() => expect(result.current.buttonIds).toEqual(["acme.git"]));
    act(() => usePluginToolbarPopoverStore.getState().open("acme.git", "button"));
    expect(usePluginToolbarPopoverStore.getState().opening?.buttonId).toBe("acme.git");

    act(() => setWhenContext({ isGitBacked: false }));
    expect(usePluginToolbarPopoverStore.getState().opening).toBeNull();

    act(() => setWhenContext({ isGitBacked: true }));
    expect(result.current.buttonIds).toEqual(["acme.git"]);
    expect(usePluginToolbarPopoverStore.getState().opening).toBeNull();
  });

  it("drops a popover deferred off a closing menu once its button is hidden", async () => {
    toolbarButtonsMock.mockResolvedValue([pluginButton("acme.git", "isGitBacked")]);
    setWhenContext({ isGitBacked: true });
    const { useVisiblePluginToolbarButtons } = await import("../usePluginToolbarButtons");
    const { usePluginToolbarPopoverStore } = await import("@/store/pluginToolbarPopoverStore");
    const { result } = renderHook(() => useVisiblePluginToolbarButtons());

    await waitFor(() => expect(result.current.buttonIds).toEqual(["acme.git"]));
    act(() => usePluginToolbarPopoverStore.getState().defer("acme.git", "tray"));

    act(() => setWhenContext({ isGitBacked: false }));
    act(() => setWhenContext({ isGitBacked: true }));
    expect(usePluginToolbarPopoverStore.getState().takeDeferred("tray")).toBeNull();
  });

  it("hides a button whose clause doesn't parse, without touching the others", async () => {
    toolbarButtonsMock.mockResolvedValue([
      pluginButton("acme.ok"),
      pluginButton("acme.broken", "isGitBacked &&"),
    ]);
    const { useVisiblePluginToolbarButtons } = await import("../usePluginToolbarButtons");
    const { result } = renderHook(() => useVisiblePluginToolbarButtons());

    await waitFor(() => expect(result.current.buttonIds).toEqual(["acme.ok"]));
  });

  it("sweeps stale pins against every registered button, hidden ones included", async () => {
    let emit: Push | null = null;
    onToolbarButtonsChangedMock.mockImplementation((cb: Push) => {
      emit = cb;
      return () => {};
    });
    const { useVisiblePluginToolbarButtons } = await import("../usePluginToolbarButtons");
    const { result } = renderHook(() => useVisiblePluginToolbarButtons());

    await waitFor(() => expect(emit).not.toBeNull());
    act(() =>
      emit!({
        buttons: [pluginButton("acme.shown"), pluginButton("acme.hidden", "isGitBacked")],
        complete: true,
      })
    );

    expect(result.current.buttonIds).toEqual(["acme.shown"]);
    expect(sweepMock).toHaveBeenCalledWith(["acme.shown", "acme.hidden"]);
  });
});
