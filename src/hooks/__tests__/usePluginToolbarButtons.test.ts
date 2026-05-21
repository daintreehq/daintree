// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";

const { toolbarButtonsMock, onToolbarButtonsChangedMock, sweepMock } = vi.hoisted(() => ({
  toolbarButtonsMock: vi.fn(),
  onToolbarButtonsChangedMock: vi.fn(),
  sweepMock: vi.fn(),
}));

vi.mock("@/store", () => ({
  useToolbarPreferencesStore: {
    getState: () => ({ sweepStalePluginPinnedButtons: sweepMock }),
  },
}));

function pluginButton(id: string): ToolbarButtonConfig {
  return {
    id: id as ToolbarButtonConfig["id"],
    label: "Button",
    iconId: "star",
    actionId: "acme.do",
    priority: 3,
    pluginId: "acme",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        toolbarButtons: toolbarButtonsMock,
        onToolbarButtonsChanged: onToolbarButtonsChangedMock,
      },
    },
  });
  vi.resetModules();
  toolbarButtonsMock.mockResolvedValue([]);
  onToolbarButtonsChangedMock.mockReturnValue(() => {});
});

describe("usePluginToolbarButtons", () => {
  it("exposes plugin buttons from the mount-time pull without sweeping", async () => {
    toolbarButtonsMock.mockResolvedValue([pluginButton("plugin.acme.foo")]);
    const { usePluginToolbarButtons } = await import("../usePluginToolbarButtons");

    const { result } = renderHook(() => usePluginToolbarButtons());

    await waitFor(() => {
      expect(result.current.buttonIds).toContain("plugin.acme.foo");
    });
    // Pull is partial under deferred init — must never prune persisted prefs.
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("does not sweep on a partial (complete=false) load push", async () => {
    let emit: ((p: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void) | null = null;
    onToolbarButtonsChangedMock.mockImplementation(
      (cb: (p: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginToolbarButtons } = await import("../usePluginToolbarButtons");
    renderHook(() => usePluginToolbarButtons());

    await waitFor(() => expect(emit).not.toBeNull());
    emit!({ buttons: [pluginButton("plugin.acme.foo")], complete: false });

    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("sweeps stale pinned buttons on an authoritative (complete=true) push", async () => {
    let emit: ((p: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void) | null = null;
    onToolbarButtonsChangedMock.mockImplementation(
      (cb: (p: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void) => {
        emit = cb;
        return () => {};
      }
    );
    const { usePluginToolbarButtons } = await import("../usePluginToolbarButtons");
    renderHook(() => usePluginToolbarButtons());

    await waitFor(() => expect(emit).not.toBeNull());
    emit!({ buttons: [pluginButton("plugin.acme.foo")], complete: true });

    expect(sweepMock).toHaveBeenCalledWith(["plugin.acme.foo"]);
  });
});
