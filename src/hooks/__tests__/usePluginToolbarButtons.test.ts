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
  toolbarButtonsMock.mockResolvedValue({ buttons: [], complete: true });
  onToolbarButtonsChangedMock.mockReturnValue(() => {});
});

describe("usePluginToolbarButtons", () => {
  it("exposes plugin buttons from the mount-time pull and sweeps on a complete snapshot", async () => {
    toolbarButtonsMock.mockResolvedValue({
      buttons: [pluginButton("plugin.acme.foo")],
      complete: true,
    });
    const { usePluginToolbarButtons } = await import("../usePluginToolbarButtons");

    const { result } = renderHook(() => usePluginToolbarButtons());

    await waitFor(() => {
      expect(result.current.buttonIds).toContain("plugin.acme.foo");
    });
    // The handler awaits initialize(), so a complete pull is authoritative and
    // sweeps a plugin uninstalled while this view was evicted (#9285).
    expect(sweepMock).toHaveBeenCalledWith(["plugin.acme.foo"]);
  });

  it("does not sweep on a partial (complete=false) pull", async () => {
    toolbarButtonsMock.mockResolvedValue({
      buttons: [pluginButton("plugin.acme.foo")],
      complete: false,
    });
    const { usePluginToolbarButtons } = await import("../usePluginToolbarButtons");

    const { result } = renderHook(() => usePluginToolbarButtons());

    await waitFor(() => {
      expect(result.current.buttonIds).toContain("plugin.acme.foo");
    });
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("does not sweep on a partial (complete=false) load push", async () => {
    // Keep the mount-time pull non-authoritative so this test isolates the
    // push path (the default pull mock is complete=true and would sweep).
    toolbarButtonsMock.mockResolvedValue({ buttons: [], complete: false });
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

  it("a partial push before the pull resolves does not suppress the authoritative pull sweep", async () => {
    // Regression for #9285: a load-time partial push must not flip pushReceived
    // and drop the gated complete pull — the pull is the only snapshot that
    // sweeps stale pins when a view revives after an uninstall it missed.
    let resolvePull: (v: { buttons: ToolbarButtonConfig[]; complete: boolean }) => void = () => {};
    toolbarButtonsMock.mockReturnValue(
      new Promise<{ buttons: ToolbarButtonConfig[]; complete: boolean }>((r) => {
        resolvePull = r;
      })
    );
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

    resolvePull({ buttons: [pluginButton("plugin.acme.foo")], complete: true });
    await waitFor(() => expect(sweepMock).toHaveBeenCalledWith(["plugin.acme.foo"]));
  });

  it("sweeps stale pinned buttons on an authoritative (complete=true) push", async () => {
    // Non-authoritative pull so the only complete-snapshot sweep under test is
    // the push below.
    toolbarButtonsMock.mockResolvedValue({ buttons: [], complete: false });
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
