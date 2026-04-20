// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { PluginActionDescriptor } from "@shared/types/plugin";

const { getActionsMock, onActionsChangedMock, invokeMock } = vi.hoisted(() => ({
  getActionsMock: vi.fn(),
  onActionsChangedMock: vi.fn(),
  invokeMock: vi.fn(),
}));

function descriptor(overrides: Partial<PluginActionDescriptor> = {}): PluginActionDescriptor {
  return {
    pluginId: "acme.my-plugin",
    id: "acme.my-plugin.doThing",
    title: "Do Thing",
    description: "Does a thing",
    category: "plugin",
    kind: "command",
    danger: "safe",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        getActions: getActionsMock,
        onActionsChanged: onActionsChangedMock,
        invoke: invokeMock,
      },
    },
  });
  vi.resetModules();
  getActionsMock.mockResolvedValue([]);
  onActionsChangedMock.mockReturnValue(() => {});
});

describe("usePluginActions", () => {
  it("registers plugin actions pulled on mount", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    const action = descriptor();
    getActionsMock.mockResolvedValue([action]);

    renderHook(() => usePluginActions());

    await waitFor(() => {
      expect(actionService.has(action.id)).toBe(true);
    });

    const entry = actionService.get(action.id);
    expect(entry?.pluginId).toBe("acme.my-plugin");
    expect(entry?.title).toBe("Do Thing");

    // dispatching routes through window.electron.plugin.invoke(pluginId, id, args)
    invokeMock.mockResolvedValue({ ok: true });
    await actionService.dispatch(action.id, { x: 1 });
    expect(invokeMock).toHaveBeenCalledWith("acme.my-plugin", action.id, { x: 1 });
  });

  it("registers and unregisters as push updates arrive", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    let emit: ((payload: { actions: PluginActionDescriptor[] }) => void) | null = null;
    onActionsChangedMock.mockImplementation(
      (cb: (payload: { actions: PluginActionDescriptor[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );

    renderHook(() => usePluginActions());
    await waitFor(() => expect(onActionsChangedMock).toHaveBeenCalled());

    const a = descriptor({ id: "acme.my-plugin.a" });
    const b = descriptor({ id: "acme.my-plugin.b" });

    act(() => emit!({ actions: [a, b] }));
    expect(actionService.has(a.id)).toBe(true);
    expect(actionService.has(b.id)).toBe(true);

    act(() => emit!({ actions: [a] }));
    expect(actionService.has(a.id)).toBe(true);
    expect(actionService.has(b.id)).toBe(false);

    act(() => emit!({ actions: [] }));
    expect(actionService.has(a.id)).toBe(false);
  });

  it("unregisters all plugin actions on unmount", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    getActionsMock.mockResolvedValue([descriptor()]);

    const { unmount } = renderHook(() => usePluginActions());
    await waitFor(() => expect(actionService.has("acme.my-plugin.doThing")).toBe(true));

    unmount();
    expect(actionService.has("acme.my-plugin.doThing")).toBe(false);
  });

  it("does not clobber an already-registered built-in action of the same id", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    // Pre-register a built-in with the same id (simulating a collision)
    actionService.register({
      id: "acme.my-plugin.doThing",
      title: "Original",
      description: "built-in",
      category: "builtin",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: vi.fn().mockResolvedValue("builtin"),
    });

    getActionsMock.mockResolvedValue([descriptor()]);

    renderHook(() => usePluginActions());
    await waitFor(() => expect(getActionsMock).toHaveBeenCalled());

    // The plugin registration is skipped — the built-in is preserved
    const entry = actionService.get("acme.my-plugin.doThing");
    expect(entry?.title).toBe("Original");
  });
});
