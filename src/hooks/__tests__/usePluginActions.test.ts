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
    effectiveDanger: "safe",
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

  it("ignores a stale mount-time pull when a push has already arrived", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    let emitPush: ((payload: { actions: PluginActionDescriptor[] }) => void) | null = null;
    onActionsChangedMock.mockImplementation(
      (cb: (payload: { actions: PluginActionDescriptor[] }) => void) => {
        emitPush = cb;
        return () => {};
      }
    );

    // getActions resolves only after we explicitly settle it, so we can
    // interleave a push before the pull completes.
    let resolveGet: ((value: PluginActionDescriptor[]) => void) | null = null;
    getActionsMock.mockImplementation(
      () =>
        new Promise<PluginActionDescriptor[]>((resolve) => {
          resolveGet = resolve;
        })
    );

    renderHook(() => usePluginActions());
    await waitFor(() => expect(onActionsChangedMock).toHaveBeenCalled());

    const action = descriptor();
    // Push arrives first — registers the action.
    act(() => emitPush!({ actions: [action] }));
    expect(actionService.has(action.id)).toBe(true);

    // Stale pull resolves with empty — must NOT unregister the newly-pushed action.
    await act(async () => {
      resolveGet!([]);
      await Promise.resolve();
    });

    expect(actionService.has(action.id)).toBe(true);
  });

  it("re-registers when an incoming descriptor differs (title/schema update)", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    let emit: ((payload: { actions: PluginActionDescriptor[] }) => void) | null = null;
    onActionsChangedMock.mockImplementation(
      (cb: (payload: { actions: PluginActionDescriptor[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );
    getActionsMock.mockResolvedValue([descriptor({ title: "Original" })]);

    renderHook(() => usePluginActions());
    await waitFor(() =>
      expect(actionService.get("acme.my-plugin.doThing")?.title).toBe("Original")
    );

    act(() => emit!({ actions: [descriptor({ title: "Updated" })] }));
    expect(actionService.get("acme.my-plugin.doThing")?.title).toBe("Updated");
  });

  it("classifies the synthetic definition from effectiveDanger, not the advisory danger", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    // Plugin self-declares "safe" but the host raised effectiveDanger to
    // "confirm" — the renderer must trust the host value.
    const action = descriptor({ danger: "safe", effectiveDanger: "confirm" });
    getActionsMock.mockResolvedValue([action]);

    renderHook(() => usePluginActions());
    await waitFor(() => expect(actionService.has(action.id)).toBe(true));

    expect(actionService.get(action.id)?.danger).toBe("confirm");
  });

  it("fails safe to confirm when effectiveDanger is absent (stale descriptor)", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    const stale = descriptor();
    delete (stale as { effectiveDanger?: unknown }).effectiveDanger;
    getActionsMock.mockResolvedValue([stale]);

    renderHook(() => usePluginActions());
    await waitFor(() => expect(actionService.has(stale.id)).toBe(true));

    expect(actionService.get(stale.id)?.danger).toBe("confirm");
  });

  it("prompts for confirmation before invoking a confirm-classified action and respects rejection", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");
    const { usePluginConfirmStore } = await import("@/store/pluginConfirmStore");

    const action = descriptor({ effectiveDanger: "confirm" });
    getActionsMock.mockResolvedValue([action]);
    invokeMock.mockResolvedValue({ ok: true });

    renderHook(() => usePluginActions());
    await waitFor(() => expect(actionService.has(action.id)).toBe(true));

    // Reject path: invoke must NOT be called.
    const rejected = actionService.dispatch(action.id, { x: 1 });
    await waitFor(() => expect(usePluginConfirmStore.getState().current).not.toBeNull());
    expect(invokeMock).not.toHaveBeenCalled();
    act(() => usePluginConfirmStore.getState().resolveCurrent("rejected"));
    const rejectedResult = await rejected;
    expect(invokeMock).not.toHaveBeenCalled();
    // Cancellation is a silent success — not an error toast, not a
    // `{ ok: false }`-shaped result wrapped as a successful dispatch.
    expect(rejectedResult).toEqual({ ok: true, result: undefined });

    // Approve path: invoke runs after explicit approval.
    const approved = actionService.dispatch(action.id, { x: 2 });
    await waitFor(() => expect(usePluginConfirmStore.getState().current).not.toBeNull());
    act(() => usePluginConfirmStore.getState().resolveCurrent("approved"));
    await approved;
    expect(invokeMock).toHaveBeenCalledWith("acme.my-plugin", action.id, { x: 2 });
  });

  it("skips the confirm dialog for agent-sourced dispatch (MCP bridge already confirmed)", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");
    const { usePluginConfirmStore } = await import("@/store/pluginConfirmStore");

    const action = descriptor({ effectiveDanger: "confirm" });
    getActionsMock.mockResolvedValue([action]);
    invokeMock.mockResolvedValue({ ok: true });

    renderHook(() => usePluginActions());
    await waitFor(() => expect(actionService.has(action.id)).toBe(true));

    await actionService.dispatch(action.id, { y: 1 }, { source: "agent", confirmed: true });
    expect(usePluginConfirmStore.getState().current).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("acme.my-plugin", action.id, { y: 1 });
  });

  it("returns CONFIRMATION_REQUIRED and never invokes for agent dispatch without confirmed:true", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");

    const action = descriptor({ effectiveDanger: "confirm" });
    getActionsMock.mockResolvedValue([action]);
    invokeMock.mockResolvedValue({ ok: true });

    renderHook(() => usePluginActions());
    await waitFor(() => expect(actionService.has(action.id)).toBe(true));

    const result = await actionService.dispatch(action.id, { z: 1 }, { source: "agent" });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("drops a pending confirmation on hook unmount (no leaked resolver, no invoke)", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { usePluginActions } = await import("../usePluginActions");
    const { usePluginConfirmStore } = await import("@/store/pluginConfirmStore");

    const action = descriptor({ effectiveDanger: "confirm" });
    getActionsMock.mockResolvedValue([action]);
    invokeMock.mockResolvedValue({ ok: true });

    const { unmount } = renderHook(() => usePluginActions());
    await waitFor(() => expect(actionService.has(action.id)).toBe(true));

    const pending = actionService.dispatch(action.id, { x: 1 });
    await waitFor(() => expect(usePluginConfirmStore.getState().current).not.toBeNull());

    unmount();

    // The dispatch promise must settle (resolver dropped, not leaked) and
    // the action must never have been invoked.
    const settled = await pending;
    expect(settled).toEqual({ ok: true, result: undefined });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(usePluginConfirmStore.getState().current).toBeNull();
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
