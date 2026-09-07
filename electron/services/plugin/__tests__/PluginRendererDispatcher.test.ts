import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";

const ipcMainMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
    }),
    removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(handler);
    }),
    _emit: (channel: string, event: unknown, payload: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(event, payload);
    },
    _reset: () => listeners.clear(),
  };
});

const windowRefMock = vi.hoisted(() => ({
  getWindowRegistry: vi.fn((): unknown => null),
  getProjectViewManager: vi.fn((): unknown => null),
}));

const registryMock = vi.hoisted(() => ({
  getWebContentsForProject: vi.fn((_projectId: string): unknown[] => []),
  isCachedViewWebContents: vi.fn((_id: number): boolean => false),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: windowRefMock.getWindowRegistry,
  getProjectViewManager: windowRefMock.getProjectViewManager,
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: registryMock.getWebContentsForProject,
  isCachedViewWebContents: registryMock.isCachedViewWebContents,
}));

import { PluginRendererDispatcher } from "../PluginRendererDispatcher.js";
import { isAppError } from "../../../utils/errorTypes.js";

/** Assert a promise rejected with the frozen `PROJECT_VIEW_UNAVAILABLE` AppError. */
async function expectProjectViewUnavailable(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    (value) => value,
    (e: unknown) => e
  );
  expect(isAppError(error)).toBe(true);
  expect(isAppError(error) && error.code).toBe("PROJECT_VIEW_UNAVAILABLE");
}

function makeWebContents(id: number) {
  const destroyed = new Set<() => void>();
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: (ev: string, h: () => void) => {
      if (ev === "destroyed") destroyed.add(h);
    },
    removeListener: (ev: string, h: () => void) => {
      if (ev === "destroyed") destroyed.delete(h);
    },
    _destroy: () => {
      for (const h of [...destroyed]) h();
    },
  };
}

type FakeWebContents = ReturnType<typeof makeWebContents>;

/** Point the window registry (the ambient/focused path) at a single WebContents. */
function setFocusedWebContents(wc: FakeWebContents | null) {
  if (!wc) {
    windowRefMock.getWindowRegistry.mockReturnValue(null);
    windowRefMock.getProjectViewManager.mockReturnValue(null);
    return;
  }
  const ctx = {
    browserWindow: { isDestroyed: () => false },
    services: { projectViewManager: { getActiveView: () => ({ webContents: wc }) } },
  };
  windowRefMock.getWindowRegistry.mockReturnValue({
    getPrimary: () => ctx,
    all: () => [ctx],
  });
  windowRefMock.getProjectViewManager.mockReturnValue(null);
}

/** Point the app-global project→webContents map at a fixed set of views. */
function setProjectViews(views: Record<string, FakeWebContents[]>, cachedIds: number[] = []) {
  registryMock.getWebContentsForProject.mockImplementation(
    (projectId: string) => views[projectId] ?? []
  );
  registryMock.isCachedViewWebContents.mockImplementation((id: number) => cachedIds.includes(id));
}

function lastRequestId(wc: FakeWebContents, channel: string): string {
  const calls = wc.send.mock.calls.filter((c) => c[0] === channel);
  return (calls[calls.length - 1]?.[1] as { requestId: string }).requestId;
}

describe("PluginRendererDispatcher", () => {
  beforeEach(() => {
    ipcMainMock._reset();
    ipcMainMock.on.mockClear();
    ipcMainMock.removeListener.mockClear();
    windowRefMock.getWindowRegistry.mockReset();
    windowRefMock.getProjectViewManager.mockReset();
    windowRefMock.getWindowRegistry.mockReturnValue(null);
    windowRefMock.getProjectViewManager.mockReturnValue(null);
    registryMock.getWebContentsForProject.mockReset();
    registryMock.isCachedViewWebContents.mockReset();
    registryMock.getWebContentsForProject.mockReturnValue([]);
    registryMock.isCachedViewWebContents.mockReturnValue(false);
  });

  describe("unbound (no project supplied)", () => {
    it("dispatches to the focused renderer and resolves with its result", async () => {
      const wc = makeWebContents(7);
      setFocusedWebContents(wc);
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      const promise = d.sendDispatchToRenderer("action.run", { a: 1 });
      expect(wc.send).toHaveBeenCalledWith(
        CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST,
        expect.objectContaining({ actionId: "action.run", args: { a: 1 } })
      );

      const requestId = lastRequestId(wc, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST);
      ipcMainMock._emit(
        CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
        { sender: { id: 7 } },
        { requestId, result: { ok: true, result: "done" } }
      );

      await expect(promise).resolves.toEqual({ ok: true, result: "done" });
      // The project map is only for bound calls.
      expect(registryMock.getWebContentsForProject).not.toHaveBeenCalled();
    });

    it("resolves an EXECUTION_ERROR envelope (never rejects) when no renderer is available", async () => {
      setFocusedWebContents(null);
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      await expect(d.sendDispatchToRenderer("action.run", null)).resolves.toEqual({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: expect.any(String) },
      });
      await expect(d.sendActionsListToRenderer()).resolves.toEqual([]);
      await expect(d.sendActionsGetToRenderer("action.run")).resolves.toBeNull();
    });

    it("projects the actions catalog from the focused renderer", async () => {
      const wc = makeWebContents(7);
      setFocusedWebContents(wc);
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      const promise = d.sendActionsListToRenderer();
      const requestId = lastRequestId(wc, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST);
      ipcMainMock._emit(
        CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
        { sender: { id: 7 } },
        { requestId, entries: [{ id: "a" }] }
      );

      await expect(promise).resolves.toEqual([{ id: "a" }]);
      d.dispose();
    });
  });

  describe("bound to a project", () => {
    it("dispatches to the bound project's renderer, never the focused project's", async () => {
      const wcA = makeWebContents(11);
      const wcB = makeWebContents(22);
      setFocusedWebContents(wcB);
      setProjectViews({ A: [wcA], B: [wcB] });
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      const promise = d.sendDispatchToRenderer("action.run", null, "A");
      expect(wcA.send).toHaveBeenCalledWith(
        CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST,
        expect.objectContaining({ actionId: "action.run" })
      );
      expect(wcB.send).not.toHaveBeenCalled();

      const requestId = lastRequestId(wcA, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST);
      // A response forged by B's renderer must not resolve A's dispatch.
      ipcMainMock._emit(
        CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
        { sender: { id: 22 } },
        { requestId, result: { ok: true, result: "forged" } }
      );
      ipcMainMock._emit(
        CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
        { sender: { id: 11 } },
        { requestId, result: { ok: true, result: "real" } }
      );

      await expect(promise).resolves.toEqual({ ok: true, result: "real" });
    });

    it("rejects with PROJECT_VIEW_UNAVAILABLE when the bound project has no live view", async () => {
      const wcB = makeWebContents(22);
      setFocusedWebContents(wcB);
      setProjectViews({ B: [wcB] });
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      await expectProjectViewUnavailable(d.sendDispatchToRenderer("action.run", null, "A"));
      expect(wcB.send).not.toHaveBeenCalled();
    });

    it("reads the actions catalog from the bound project, and rejects rather than falling back", async () => {
      const wcA = makeWebContents(11);
      const wcB = makeWebContents(22);
      setFocusedWebContents(wcB);
      setProjectViews({ A: [wcA], B: [wcB] });
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      const promise = d.sendActionsListToRenderer("A");
      expect(wcB.send).not.toHaveBeenCalled();
      const requestId = lastRequestId(wcA, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST);
      ipcMainMock._emit(
        CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
        { sender: { id: 11 } },
        { requestId, entries: [{ id: "a" }] }
      );
      await expect(promise).resolves.toEqual([{ id: "a" }]);

      setProjectViews({ B: [wcB] });
      await expectProjectViewUnavailable(d.sendActionsListToRenderer("A"));
      await expectProjectViewUnavailable(d.sendActionsGetToRenderer("action.run", "A"));
      expect(wcB.send).not.toHaveBeenCalled();
      d.dispose();
    });

    it("prefers a visible view over a cached one for the same project", async () => {
      const cached = makeWebContents(31);
      const visible = makeWebContents(32);
      setFocusedWebContents(null);
      setProjectViews({ A: [cached, visible] }, [31]);
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      void d.sendDispatchToRenderer("action.run", null, "A");
      expect(visible.send).toHaveBeenCalled();
      expect(cached.send).not.toHaveBeenCalled();
      d.dispose();
    });

    it("treats an empty project id as bound, not as ambient", async () => {
      const wcB = makeWebContents(22);
      setFocusedWebContents(wcB);
      setProjectViews({ B: [wcB] });
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      // A falsy-but-supplied project id is a caller bug; falling through to the
      // focused view would be the exact misroute this path exists to prevent.
      await expectProjectViewUnavailable(d.sendDispatchToRenderer("action.run", null, ""));
      expect(wcB.send).not.toHaveBeenCalled();
    });

    it("still targets a cached view when the project has no visible one", async () => {
      const cached = makeWebContents(31);
      setFocusedWebContents(null);
      setProjectViews({ A: [cached] }, [31]);
      const d = new PluginRendererDispatcher({ isDisposed: () => false });

      void d.sendDispatchToRenderer("action.run", null, "A");
      expect(cached.send).toHaveBeenCalled();
      d.dispose();
    });
  });

  it("resolveScopeWebContents stays focused-window-only and fails closed", () => {
    const wcA = makeWebContents(11);
    setProjectViews({ A: [wcA] });
    windowRefMock.getWindowRegistry.mockReturnValue({ getPrimary: () => undefined, all: () => [] });
    windowRefMock.getProjectViewManager.mockReturnValue(null);
    const d = new PluginRendererDispatcher({ isDisposed: () => false });

    expect(d.resolveScopeWebContents()).toBeNull();

    const wcB = makeWebContents(22);
    setFocusedWebContents(wcB);
    expect(d.resolveScopeWebContents()).toBe(wcB);
  });
});
