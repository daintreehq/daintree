import { describe, expect, it, vi } from "vitest";
import { WindowRegistry } from "../WindowRegistry.js";
import { toDisposable } from "../../utils/lifecycle.js";
import { onProjectPresenceChanged } from "../projectPresenceChanges.js";
import type { BrowserWindow } from "electron";

const { mockRevokeByWindowId } = vi.hoisted(() => ({
  mockRevokeByWindowId: vi.fn<(windowId: number) => Promise<void>>(),
}));

vi.mock("../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    revokeByWindowId: mockRevokeByWindowId,
  },
}));

function makeMockWindow(id: number, webContentsId: number, opts?: { focused?: boolean }) {
  const closedHandlers: Array<() => void> = [];
  const destroyedHandlers: Array<() => void> = [];

  const win = {
    id,
    webContents: {
      id: webContentsId,
      once: vi.fn((event: string, handler: () => void) => {
        if (event === "destroyed") destroyedHandlers.push(handler);
      }),
      isDestroyed: vi.fn(() => false),
    },
    once: vi.fn((event: string, handler: () => void) => {
      if (event === "closed") closedHandlers.push(handler);
    }),
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => opts?.focused ?? false),
    isMinimized: vi.fn(() => false),
    focus: vi.fn(),
    restore: vi.fn(),
    _fireClosed: () => closedHandlers.forEach((h) => h()),
    _fireDestroyed: () => destroyedHandlers.forEach((h) => h()),
  } as unknown as BrowserWindow & {
    _fireClosed: () => void;
    _fireDestroyed: () => void;
  };

  return win;
}

function makeMockApp() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
  };
}

describe("WindowRegistry", () => {
  it("registers a window and retrieves it by windowId", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    const ctx = registry.register(win);

    expect(ctx.windowId).toBe(1);
    expect(ctx.webContentsId).toBe(100);
    expect(ctx.browserWindow).toBe(win);
    expect(registry.getByWindowId(1)).toBe(ctx);
  });

  it("retrieves a window by webContentsId", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    const ctx = registry.register(win);

    expect(registry.getByWebContentsId(100)).toBe(ctx);
  });

  it("does not change primary when a second window is registered", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    registry.register(win1);
    registry.register(win2);

    expect(registry.getPrimary()?.windowId).toBe(1);
    expect(registry.size).toBe(2);
  });

  it("reassigns primary to next alive window on unregister", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    registry.register(win1);
    registry.register(win2);

    registry.unregister(1);

    expect(registry.getPrimary()?.windowId).toBe(2);
    expect(registry.size).toBe(1);
  });

  it("returns undefined for primary when all windows are unregistered", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    registry.register(win);
    registry.unregister(1);

    expect(registry.getPrimary()).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it("returns undefined primary when all remaining windows are destroyed", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    registry.register(win1);
    registry.register(win2);

    (win2.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    registry.unregister(1);

    expect(registry.getPrimary()).toBeUndefined();
  });

  it("setPrimary changes the primary window", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    registry.register(win1);
    registry.register(win2);
    registry.setPrimary(2);

    expect(registry.getPrimary()?.windowId).toBe(2);
  });

  it("setPrimary ignores unknown windowId", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    registry.register(win);
    registry.setPrimary(999);

    expect(registry.getPrimary()?.windowId).toBe(1);
  });

  describe("focus tracking", () => {
    it("wireFocusTracking: focus event for window not in registry does not change primary", () => {
      const registry = new WindowRegistry();
      const mockApp = makeMockApp();
      const win1 = makeMockWindow(1, 100);

      registry.wireFocusTracking(mockApp);
      registry.register(win1);

      const devtoolsLikeWin = makeMockWindow(42, 4200);
      mockApp.emit("browser-window-focus", null, devtoolsLikeWin);

      expect(registry.getPrimary()?.windowId).toBe(1);
    });

    it("wireFocusTracking is idempotent — calling twice attaches only one listener", () => {
      const registry = new WindowRegistry();
      const mockApp = makeMockApp();

      registry.wireFocusTracking(mockApp);
      registry.wireFocusTracking(mockApp);

      expect(mockApp.listenerCount("browser-window-focus")).toBe(1);
    });

    it("register: already-focused window becomes primary immediately even when not first", () => {
      const registry = new WindowRegistry();
      const win1 = makeMockWindow(1, 100, { focused: false });
      const win2 = makeMockWindow(2, 200, { focused: true });

      registry.register(win1);
      registry.register(win2);

      expect(registry.getPrimary()?.windowId).toBe(2);
    });

    it("focus updates survive after unregister of unrelated window", () => {
      const registry = new WindowRegistry();
      const mockApp = makeMockApp();
      const win1 = makeMockWindow(1, 100);
      const win2 = makeMockWindow(2, 200);
      const win3 = makeMockWindow(3, 300);

      registry.wireFocusTracking(mockApp);
      registry.register(win1);
      registry.register(win2);
      registry.register(win3);

      mockApp.emit("browser-window-focus", null, win3);
      expect(registry.getPrimary()?.windowId).toBe(3);

      registry.unregister(2);
      expect(registry.getPrimary()?.windowId).toBe(3);
    });

    it("FOCUS_SEQUENCE_LAST_EVENT_WINS_THREE_WINDOWS", () => {
      const registry = new WindowRegistry();
      const mockApp = makeMockApp();
      const win1 = makeMockWindow(1, 100);
      const win2 = makeMockWindow(2, 200);
      const win3 = makeMockWindow(3, 300);

      registry.wireFocusTracking(mockApp);
      registry.register(win1);
      registry.register(win2);
      registry.register(win3);

      mockApp.emit("browser-window-focus", null, win1);
      expect(registry.getPrimary()?.windowId).toBe(1);

      mockApp.emit("browser-window-focus", null, win2);
      expect(registry.getPrimary()?.windowId).toBe(2);

      mockApp.emit("browser-window-focus", null, win1);
      expect(registry.getPrimary()?.windowId).toBe(1);
    });
  });

  it("auto-unregisters on window closed event", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    registry.register(win);
    expect(registry.size).toBe(1);

    win._fireClosed();

    expect(registry.size).toBe(0);
    expect(registry.getByWindowId(1)).toBeUndefined();
    expect(registry.getByWebContentsId(100)).toBeUndefined();
  });

  it("auto-unregisters on webContents destroyed event", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    registry.register(win);
    win._fireDestroyed();

    expect(registry.size).toBe(0);
  });

  it("returns same context when registering the same window twice", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    const ctx1 = registry.register(win);
    const ctx2 = registry.register(win);

    expect(ctx1).toBe(ctx2);
    expect(registry.size).toBe(1);
  });

  it("all() returns all registered contexts", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    registry.register(win1);
    registry.register(win2);

    const all = registry.all();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.windowId).sort()).toEqual([1, 2]);
  });

  it("dispose cleans up all contexts", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);
    const fn = vi.fn();

    const ctx = registry.register(win1);
    ctx.cleanup.add(toDisposable(fn));
    registry.register(win2);

    registry.dispose();

    expect(registry.size).toBe(0);
    expect(registry.getPrimary()).toBeUndefined();
    expect(fn).toHaveBeenCalledOnce();
  });

  describe("AbortController lifecycle", () => {
    it("aborts signal on unregister", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx = registry.register(win);
      registry.unregister(1);

      expect(ctx.abortController.signal.aborted).toBe(true);
    });

    it("signal is aborted before cleanup callbacks run", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx = registry.register(win);
      let signalAbortedDuringCleanup = false;
      ctx.cleanup.add(
        toDisposable(() => {
          signalAbortedDuringCleanup = ctx.abortController.signal.aborted;
        })
      );

      registry.unregister(1);

      expect(signalAbortedDuringCleanup).toBe(true);
    });

    it("re-registration after unregister provides a fresh AbortController", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx1 = registry.register(win);
      registry.unregister(1);
      expect(ctx1.abortController.signal.aborted).toBe(true);

      const win2 = makeMockWindow(1, 100);
      const ctx2 = registry.register(win2);
      expect(ctx2.abortController.signal.aborted).toBe(false);
      expect(ctx2.abortController).not.toBe(ctx1.abortController);
    });
  });

  describe("help-session revoke wire-up (#10053)", () => {
    it("unregister fires revokeByWindowId for the closing window", async () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(42, 100);
      registry.register(win);

      mockRevokeByWindowId.mockClear();
      registry.unregister(42);

      // Wire-up is fire-and-forget: import().then(revokeByWindowId). Wait one
      // macrotask so the dynamic import resolves + the .then() runs.
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();

      expect(mockRevokeByWindowId).toHaveBeenCalledWith(42);
    });

    it("unregister fires revokeByWindowId only once when both closed and destroyed fire (idempotent)", async () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(13, 100);
      registry.register(win);

      mockRevokeByWindowId.mockClear();
      win._fireClosed();
      win._fireDestroyed();

      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();

      // doUnregister's ctx._unregistered guard short-circuits the second
      // call before the wire-up runs.
      expect(mockRevokeByWindowId).toHaveBeenCalledTimes(1);
      expect(mockRevokeByWindowId).toHaveBeenCalledWith(13);
    });

    it("unregister logs and swallows a revokeByWindowId rejection", async () => {
      mockRevokeByWindowId.mockRejectedValueOnce(new Error("synthetic revoke failure"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const registry = new WindowRegistry();
      const win = makeMockWindow(99, 100);
      registry.register(win);

      // Must not throw — the unregister path is the hot shutdown-cleanup path.
      expect(() => registry.unregister(99)).not.toThrow();

      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(
        "[WindowRegistry] revokeByWindowId failed during unregister:",
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });

    it("two concurrent window closes each fire their own revokeByWindowId with the right windowId", async () => {
      // Defends against a stale-closure refactor: each close path must
      // resolve its own windowId, not capture an outer one.
      const registry = new WindowRegistry();
      const win1 = makeMockWindow(101, 200);
      const win2 = makeMockWindow(202, 201);
      registry.register(win1);
      registry.register(win2);

      mockRevokeByWindowId.mockClear();
      registry.unregister(101);
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();
      // After the first chain fully drains, fire the second close.
      registry.unregister(202);
      await new Promise((r) => setTimeout(r, 0));
      await Promise.resolve();

      expect(mockRevokeByWindowId).toHaveBeenCalledTimes(2);
      expect(mockRevokeByWindowId).toHaveBeenCalledWith(101);
      expect(mockRevokeByWindowId).toHaveBeenCalledWith(202);
    });
  });

  describe("focusOrder", () => {
    const ids = (registry: WindowRegistry) => registry.focusOrder().map((c) => c.windowId);

    it("orders focused windows most-recent-first", () => {
      const registry = new WindowRegistry();
      const app = makeMockApp();
      registry.wireFocusTracking(app);
      const w1 = makeMockWindow(1, 100);
      const w2 = makeMockWindow(2, 200);
      const w3 = makeMockWindow(3, 300);
      registry.register(w1);
      registry.register(w2);
      registry.register(w3);

      app.emit("browser-window-focus", {}, w1);
      app.emit("browser-window-focus", {}, w3);
      app.emit("browser-window-focus", {}, w2);

      expect(ids(registry)).toEqual([2, 3, 1]);
    });

    it("moves a re-focused window back to the front without duplicating it", () => {
      const registry = new WindowRegistry();
      const app = makeMockApp();
      registry.wireFocusTracking(app);
      const w1 = makeMockWindow(1, 100);
      const w2 = makeMockWindow(2, 200);
      registry.register(w1);
      registry.register(w2);

      app.emit("browser-window-focus", {}, w1);
      app.emit("browser-window-focus", {}, w2);
      app.emit("browser-window-focus", {}, w1);

      expect(ids(registry)).toEqual([1, 2]);
    });

    it("keeps never-focused windows rather than dropping them", () => {
      // The open-window manifest describes every window and trims from the
      // tail, so a restored background window absent from the focus history
      // would be the first one silently lost.
      const registry = new WindowRegistry();
      const app = makeMockApp();
      registry.wireFocusTracking(app);
      const w1 = makeMockWindow(1, 100);
      const w2 = makeMockWindow(2, 200);
      const w3 = makeMockWindow(3, 300);
      registry.register(w1);
      registry.register(w2);
      registry.register(w3);

      app.emit("browser-window-focus", {}, w3);

      expect(ids(registry)).toEqual([3, 1, 2]);
    });

    it("leaves never-focused windows out when asked for focused ones only", () => {
      const registry = new WindowRegistry();
      const app = makeMockApp();
      registry.wireFocusTracking(app);
      const w1 = makeMockWindow(1, 100);
      const w2 = makeMockWindow(2, 200);
      const w3 = makeMockWindow(3, 300);
      registry.register(w1);
      registry.register(w2);
      registry.register(w3);

      app.emit("browser-window-focus", {}, w3);
      app.emit("browser-window-focus", {}, w1);

      expect(registry.focusOrder({ focusedOnly: true }).map((c) => c.windowId)).toEqual([1, 3]);
      expect(ids(registry)).toEqual([1, 3, 2]);
    });

    it("falls back to registration order when nothing has been focused", () => {
      const registry = new WindowRegistry();
      registry.register(makeMockWindow(1, 100));
      registry.register(makeMockWindow(2, 200));

      expect(ids(registry)).toEqual([1, 2]);
    });

    it("drops an unregistered window from the order", () => {
      const registry = new WindowRegistry();
      const app = makeMockApp();
      registry.wireFocusTracking(app);
      const w1 = makeMockWindow(1, 100);
      const w2 = makeMockWindow(2, 200);
      registry.register(w1);
      registry.register(w2);
      app.emit("browser-window-focus", {}, w1);
      app.emit("browser-window-focus", {}, w2);

      registry.unregister(2);

      expect(ids(registry)).toEqual([1]);
    });
  });
});

describe("WindowRegistry presence change signal (#12597)", () => {
  it("reports a window registering", () => {
    const registry = new WindowRegistry();
    const listener = vi.fn();
    const unsubscribe = onProjectPresenceChanged(listener);

    registry.register(makeMockWindow(1, 100));

    unsubscribe();
    expect(listener).toHaveBeenCalled();
  });

  it("reports a window closing only once it is gone from the registry", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);
    registry.register(win);
    const stillRegistered: boolean[] = [];
    const unsubscribe = onProjectPresenceChanged(() => {
      stillRegistered.push(registry.getByWindowId(1) !== undefined);
    });

    win._fireClosed();
    // Teardown can reach unregister twice (closed, then destroyed).
    win._fireDestroyed();

    unsubscribe();
    expect(stillRegistered).toEqual([false]);
  });
});

type Handler = () => void;

type MockBrowserWindow = BrowserWindow & {
  _fireClosed: () => void;
  _fireDestroyed: () => void;
  webContents: BrowserWindow["webContents"] & {
    _destroyed: boolean;
  };
  _destroyed: boolean;
};

function makeStatefulMockWindow(id: number, webContentsId: number): MockBrowserWindow {
  const closedHandlers: Handler[] = [];
  const destroyedHandlers: Handler[] = [];

  const win = {
    id,
    _destroyed: false,
    webContents: {
      id: webContentsId,
      _destroyed: false,
      once: vi.fn((event: string, handler: Handler) => {
        if (event === "destroyed") {
          destroyedHandlers.push(handler);
        }
      }),
      isDestroyed: vi.fn(() => win.webContents._destroyed),
    },
    once: vi.fn((event: string, handler: Handler) => {
      if (event === "closed") {
        closedHandlers.push(handler);
      }
    }),
    isDestroyed: vi.fn(() => win._destroyed),
    isFocused: vi.fn(() => false),
    _fireClosed: () => {
      win._destroyed = true;
      closedHandlers.forEach((handler) => handler());
    },
    _fireDestroyed: () => {
      win.webContents._destroyed = true;
      destroyedHandlers.forEach((handler) => handler());
    },
  } as unknown as MockBrowserWindow;

  return win;
}

describe("WindowRegistry adversarial", () => {
  it("DESTROY_STORM_CLEANS_ONCE", () => {
    const registry = new WindowRegistry();
    const win = makeStatefulMockWindow(1, 100);
    const cleanup = vi.fn();

    const ctx = registry.register(win);
    ctx.cleanup.add(toDisposable(cleanup));

    registry.unregister(1);
    win._fireClosed();
    win._fireDestroyed();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
    expect(registry.getByWindowId(1)).toBeUndefined();
    expect(registry.getByWebContentsId(100)).toBeUndefined();
  });

  it("APP_VIEW_IDS_PURGED_ON_CRASH", () => {
    const registry = new WindowRegistry();
    const win = makeStatefulMockWindow(1, 100);

    registry.register(win);
    registry.registerAppViewWebContents(1, 300);
    registry.registerAppViewWebContents(1, 301);

    win._fireClosed();
    win._fireDestroyed();

    expect(registry.getByWebContentsId(100)).toBeUndefined();
    expect(registry.getByWebContentsId(300)).toBeUndefined();
    expect(registry.getByWebContentsId(301)).toBeUndefined();
  });

  it("REBIND_AFTER_CRASH_NO_REVIVE", () => {
    const registry = new WindowRegistry();
    const oldWin = makeStatefulMockWindow(1, 100);

    registry.register(oldWin);
    registry.registerAppViewWebContents(1, 300);
    oldWin._fireClosed();

    const newWin = makeStatefulMockWindow(2, 200);
    const newCtx = registry.register(newWin);
    registry.registerAppViewWebContents(2, 300);

    expect(registry.getByWebContentsId(300)).toBe(newCtx);
    expect(registry.getByWindowId(1)).toBeUndefined();
  });

  it("RAPID_CYCLE_NO_EXTRA_HANDLERS", () => {
    const registry = new WindowRegistry();
    const first = makeStatefulMockWindow(1, 100);
    const second = makeStatefulMockWindow(1, 100);
    const cleanup = vi.fn();

    const firstCtx = registry.register(first);
    firstCtx.cleanup.add(toDisposable(cleanup));
    registry.unregister(1);

    const secondCtx = registry.register(second);
    secondCtx.cleanup.add(toDisposable(cleanup));
    second._fireClosed();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(0);
  });

  it("MULTI_REGISTRY_ISOLATION", () => {
    const firstRegistry = new WindowRegistry();
    const secondRegistry = new WindowRegistry();
    const firstWin = makeStatefulMockWindow(1, 100);
    const secondWin = makeStatefulMockWindow(2, 200);

    const firstCtx = firstRegistry.register(firstWin);
    const secondCtx = secondRegistry.register(secondWin);
    firstRegistry.registerAppViewWebContents(1, 300);

    firstRegistry.unregister(1);

    expect(secondRegistry.getPrimary()).toBe(secondCtx);
    expect(secondRegistry.size).toBe(1);
    expect(secondRegistry.getByWebContentsId(200)).toBe(secondCtx);
    expect(firstRegistry.getByWindowId(1)).toBeUndefined();
    expect(firstRegistry.getByWebContentsId(300)).toBeUndefined();
    expect(firstCtx.abortController.signal.aborted).toBe(true);
  });

  it("PRIMARY_REASSIGNMENT_IGNORES_DESTROYED", () => {
    const registry = new WindowRegistry();
    const win1 = makeStatefulMockWindow(1, 100);
    const win2 = makeStatefulMockWindow(2, 200);
    const win3 = makeStatefulMockWindow(3, 300);

    registry.register(win1);
    registry.register(win2);
    const liveCtx = registry.register(win3);
    registry.registerAppViewWebContents(2, 220);
    registry.registerAppViewWebContents(3, 330);

    win2._destroyed = true;

    registry.unregister(1);

    expect(registry.getPrimary()).toBe(liveCtx);
    expect(registry.getByWebContentsId(220)).toBe(registry.getByWindowId(2));

    registry.unregister(2);

    expect(registry.getPrimary()).toBe(liveCtx);
    expect(registry.getByWebContentsId(220)).toBeUndefined();
    expect(registry.getByWebContentsId(330)).toBe(liveCtx);
  });

  it("UNREGISTER_PRIMARY_PREFERS_FOCUS_ORDER_NOT_MAP_ORDER", () => {
    const registry = new WindowRegistry();
    const mockApp = makeMockApp();
    const win1 = makeStatefulMockWindow(1, 100);
    const win2 = makeStatefulMockWindow(2, 200);
    const win3 = makeStatefulMockWindow(3, 300);

    registry.wireFocusTracking(mockApp);
    registry.register(win1);
    registry.register(win2);
    registry.register(win3);

    // Focus B, then C. Now close C. Fallback should pick B (last-focused-
    // surviving), NOT A (first inserted in Map).
    mockApp.emit("browser-window-focus", null, win2);
    mockApp.emit("browser-window-focus", null, win3);

    registry.unregister(3);

    expect(registry.getPrimary()?.windowId).toBe(2);
  });

  it("FOCUS_EVENT_FOR_DESTROYED_BUT_STILL_REGISTERED_WINDOW_IGNORED", () => {
    const registry = new WindowRegistry();
    const mockApp = makeMockApp();
    const win1 = makeStatefulMockWindow(1, 100);
    const win2 = makeStatefulMockWindow(2, 200);

    registry.wireFocusTracking(mockApp);
    registry.register(win1);
    registry.register(win2);

    // Simulate the window being destroyed mid-flight without its registry
    // entry being cleaned up yet.
    win2._destroyed = true;

    mockApp.emit("browser-window-focus", null, win2);

    expect(registry.getPrimary()?.windowId).toBe(1);
  });

  it("UNKNOWN_APP_VIEW_UNREGISTER_NO_OP", () => {
    const registry = new WindowRegistry();
    const win = makeStatefulMockWindow(1, 100);
    const ctx = registry.register(win);
    registry.registerAppViewWebContents(1, 300);

    expect(() => registry.unregisterAppViewWebContents(99, 999)).not.toThrow();

    expect(registry.getByWindowId(1)).toBe(ctx);
    expect(registry.getByWebContentsId(100)).toBe(ctx);
    expect(registry.getByWebContentsId(300)).toBe(ctx);
  });
});
