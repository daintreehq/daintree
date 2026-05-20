import { describe, expect, it, vi } from "vitest";
import { WindowRegistry } from "../WindowRegistry.js";
import { toDisposable } from "../../utils/lifecycle.js";
import type { BrowserWindow } from "electron";

type Handler = () => void;

type MockBrowserWindow = BrowserWindow & {
  _fireClosed: () => void;
  _fireDestroyed: () => void;
  webContents: BrowserWindow["webContents"] & {
    _destroyed: boolean;
  };
  _destroyed: boolean;
};

function makeMockWindow(id: number, webContentsId: number): MockBrowserWindow {
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
  };
}

describe("WindowRegistry adversarial", () => {
  it("DESTROY_STORM_CLEANS_ONCE", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);
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
    const win = makeMockWindow(1, 100);

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
    const oldWin = makeMockWindow(1, 100);

    registry.register(oldWin);
    registry.registerAppViewWebContents(1, 300);
    oldWin._fireClosed();

    const newWin = makeMockWindow(2, 200);
    const newCtx = registry.register(newWin);
    registry.registerAppViewWebContents(2, 300);

    expect(registry.getByWebContentsId(300)).toBe(newCtx);
    expect(registry.getByWindowId(1)).toBeUndefined();
  });

  it("RAPID_CYCLE_NO_EXTRA_HANDLERS", () => {
    const registry = new WindowRegistry();
    const first = makeMockWindow(1, 100);
    const second = makeMockWindow(1, 100);
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
    const firstWin = makeMockWindow(1, 100);
    const secondWin = makeMockWindow(2, 200);

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
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);
    const win3 = makeMockWindow(3, 300);

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

  it("FOCUS_AFTER_UNREGISTER_NO_REVIVE", () => {
    const registry = new WindowRegistry();
    const mockApp = makeMockApp();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    registry.wireFocusTracking(mockApp);
    registry.register(win1);
    registry.register(win2);

    mockApp.emit("browser-window-focus", null, win2);
    expect(registry.getPrimary()?.windowId).toBe(2);

    registry.unregister(2);

    // After unregistration, focus event for the dead window must NOT
    // revive it as primary.
    mockApp.emit("browser-window-focus", null, win2);

    expect(registry.getPrimary()?.windowId).toBe(1);
    expect(registry.getByWindowId(2)).toBeUndefined();
  });

  it("FOCUS_COLD_START_FALLBACK_PRESERVED", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);

    // No wireFocusTracking, no isFocused() returning true — pure cold start.
    registry.register(win1);
    registry.register(win2);

    expect(registry.getPrimary()?.windowId).toBe(1);
  });

  it("UNKNOWN_APP_VIEW_UNREGISTER_NO_OP", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);
    const ctx = registry.register(win);
    registry.registerAppViewWebContents(1, 300);

    expect(() => registry.unregisterAppViewWebContents(99, 999)).not.toThrow();

    expect(registry.getByWindowId(1)).toBe(ctx);
    expect(registry.getByWebContentsId(100)).toBe(ctx);
    expect(registry.getByWebContentsId(300)).toBe(ctx);
  });
});
