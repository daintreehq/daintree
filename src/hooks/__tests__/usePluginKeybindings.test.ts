// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { KEYBINDING_PRIORITY } from "@/services/defaultKeybindings";

const { keybindingsMock, onKeybindingsChangedMock } = vi.hoisted(() => ({
  keybindingsMock: vi.fn(),
  onKeybindingsChangedMock: vi.fn(),
}));

function makeEntry(pluginId: string, actionId: string, combo: string) {
  return { pluginId, item: { actionId, combo } };
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        keybindings: keybindingsMock,
        onKeybindingsChanged: onKeybindingsChangedMock,
      },
    },
  });
  vi.resetModules();
  keybindingsMock.mockResolvedValue([]);
  onKeybindingsChangedMock.mockReturnValue(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePluginKeybindings", () => {
  it("registers plugin keybindings pulled on mount", async () => {
    keybindingsMock.mockResolvedValue([makeEntry("p1", "p1.act", "Cmd+Shift+8")]);

    const { keybindingService } = await import("@/services/KeybindingService");
    const registerSpy = vi.spyOn(keybindingService, "registerBinding");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    renderHook(() => usePluginKeybindings());

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "p1.act",
          pluginId: "p1",
          priority: KEYBINDING_PRIORITY.PLUGIN,
        })
      );
    });
  });

  it("applies push updates authoritatively", async () => {
    let emit:
      | ((payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void)
      | null = null;
    onKeybindingsChangedMock.mockImplementation(
      (
        cb: (payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );

    const { keybindingService } = await import("@/services/KeybindingService");
    const registerSpy = vi.spyOn(keybindingService, "registerBinding");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    renderHook(() => usePluginKeybindings());

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({
        keybindings: [makeEntry("p2", "p2.act", "Cmd+Shift+9")],
        complete: false,
      });
    });

    expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({ actionId: "p2.act" }));
  });

  it("ignores stale pull after push arrives", async () => {
    let resolvePull:
      ((v: Array<{ pluginId: string; item: { actionId: string; combo: string } }>) => void) | null =
      null;
    keybindingsMock.mockImplementation(
      () =>
        new Promise<Array<{ pluginId: string; item: { actionId: string; combo: string } }>>(
          (res) => {
            resolvePull = res;
          }
        )
    );

    let emit:
      | ((payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void)
      | null = null;
    onKeybindingsChangedMock.mockImplementation(
      (
        cb: (payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );

    const { keybindingService } = await import("@/services/KeybindingService");
    const registerSpy = vi.spyOn(keybindingService, "registerBinding");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    renderHook(() => usePluginKeybindings());

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({
        keybindings: [makeEntry("p2", "p2.act", "Cmd+Shift+9")],
        complete: true,
      });
    });

    await act(async () => {
      resolvePull!([makeEntry("p1", "p1.act", "Cmd+Shift+8")]);
      await Promise.resolve();
    });

    const calls = registerSpy.mock.calls.map((c) => c[0].actionId);
    expect(calls).not.toContain("p1.act");
  });

  it("removes plugin bindings on unmount", async () => {
    keybindingsMock.mockResolvedValue([makeEntry("p1", "p1.act", "Cmd+Shift+8")]);

    const { keybindingService } = await import("@/services/KeybindingService");
    const registerSpy = vi.spyOn(keybindingService, "registerBinding");
    const removeSpy = vi.spyOn(keybindingService, "removePluginBindings");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    const { unmount } = renderHook(() => usePluginKeybindings());

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({ actionId: "p1.act" }));
    });

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("p1");
  });

  it("threads scope, when, and description through to registerBinding", async () => {
    keybindingsMock.mockResolvedValue([
      {
        pluginId: "p1",
        item: {
          actionId: "p1.act",
          combo: "Cmd+Shift+8",
          scope: "portal",
          when: "terminalFocused",
          description: "Do the thing",
        },
      },
    ]);

    const { keybindingService } = await import("@/services/KeybindingService");
    const registerSpy = vi.spyOn(keybindingService, "registerBinding");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    renderHook(() => usePluginKeybindings());

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "p1.act",
          scope: "portal",
          when: "terminalFocused",
          description: "Do the thing",
        })
      );
    });
  });

  it("defaults scope to global when the contribution omits it", async () => {
    keybindingsMock.mockResolvedValue([makeEntry("p1", "p1.act", "Cmd+Shift+8")]);

    const { keybindingService } = await import("@/services/KeybindingService");
    const registerSpy = vi.spyOn(keybindingService, "registerBinding");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    renderHook(() => usePluginKeybindings());

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "p1.act", scope: "global" })
      );
    });
  });

  it("removes prior registrations when an authoritative empty push arrives", async () => {
    let emit:
      | ((payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void)
      | null = null;
    onKeybindingsChangedMock.mockImplementation(
      (
        cb: (payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );

    const { keybindingService } = await import("@/services/KeybindingService");
    const removeSpy = vi.spyOn(keybindingService, "removePluginBindings");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    renderHook(() => usePluginKeybindings());

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({ keybindings: [makeEntry("p1", "p1.act", "Cmd+Shift+8")], complete: true });
    });
    act(() => {
      emit!({ keybindings: [], complete: true });
    });

    expect(removeSpy).toHaveBeenCalledWith("p1");
  });

  it("registers a binding that resolves a matching keyboard event, removed on empty push", async () => {
    let emit:
      | ((payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void)
      | null = null;
    onKeybindingsChangedMock.mockImplementation(
      (
        cb: (payload: {
          keybindings: Array<{ pluginId: string; item: { actionId: string; combo: string } }>;
          complete: boolean;
        }) => void
      ) => {
        emit = cb;
        return () => {};
      }
    );

    // Pin the platform so metaKey maps to the Cmd modifier deterministically.
    Object.defineProperty(globalThis.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    const { keybindingService } = await import("@/services/KeybindingService");

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    renderHook(() => usePluginKeybindings());

    await waitFor(() => expect(emit).not.toBeNull());
    act(() => {
      emit!({ keybindings: [makeEntry("p1", "p1.act", "Cmd+Shift+8")], complete: true });
    });

    const event = {
      key: "8",
      code: "Digit8",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      getModifierState: () => false,
    } as unknown as KeyboardEvent;
    expect(keybindingService.findMatchingAction(event)?.actionId).toBe("p1.act");

    act(() => {
      emit!({ keybindings: [], complete: true });
    });
    expect(keybindingService.findMatchingAction(event)).toBeUndefined();
  });

  it("unsubscribes from the push channel on unmount", async () => {
    const unsubscribe = vi.fn();
    onKeybindingsChangedMock.mockReturnValue(unsubscribe);

    const { usePluginKeybindings } = await import("../usePluginKeybindings");
    const { unmount } = renderHook(() => usePluginKeybindings());

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
