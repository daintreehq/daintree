import { describe, expect, it, vi } from "vitest";
import { WindowRegistry } from "../WindowRegistry.js";
import type { BrowserWindow } from "electron";

function makeMockWindow(id: number, webContentsId: number) {
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

  it("returns undefined for unknown IDs", () => {
    const registry = new WindowRegistry();

    expect(registry.getByWindowId(999)).toBeUndefined();
    expect(registry.getByWebContentsId(999)).toBeUndefined();
  });

  it("sets first registered window as primary", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    registry.register(win);

    expect(registry.getPrimary()?.windowId).toBe(1);
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

  it("skips destroyed windows when reassigning primary", () => {
    const registry = new WindowRegistry();
    const win1 = makeMockWindow(1, 100);
    const win2 = makeMockWindow(2, 200);
    const win3 = makeMockWindow(3, 300);

    registry.register(win1);
    registry.register(win2);
    registry.register(win3);

    // Mark win2 as destroyed so it gets skipped during primary reassignment
    (win2.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);

    registry.unregister(1);

    // Should skip destroyed win2 and pick win3
    expect(registry.getPrimary()?.windowId).toBe(3);
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

  it("idempotent cleanup — both closed and destroyed fire without error, cleanup runs once", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);
    const cleanupSpy = vi.fn();

    const ctx = registry.register(win);
    ctx.cleanup.push(cleanupSpy);

    win._fireClosed();
    win._fireDestroyed();

    expect(registry.size).toBe(0);
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("runs cleanup callbacks on unregister", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    const ctx = registry.register(win);
    ctx.cleanup.push(fn1, fn2);

    registry.unregister(1);

    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it("tolerates cleanup callback errors", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);
    const fn1 = vi.fn(() => {
      throw new Error("cleanup error");
    });
    const fn2 = vi.fn();

    const ctx = registry.register(win);
    ctx.cleanup.push(fn1, fn2);

    registry.unregister(1);

    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
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
    ctx.cleanup.push(fn);
    registry.register(win2);

    registry.dispose();

    expect(registry.size).toBe(0);
    expect(registry.getPrimary()).toBeUndefined();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("stores projectPath when provided", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    const ctx = registry.register(win, { projectPath: "/path/to/project" });

    expect(ctx.projectPath).toBe("/path/to/project");
  });

  it("projectPath defaults to null", () => {
    const registry = new WindowRegistry();
    const win = makeMockWindow(1, 100);

    const ctx = registry.register(win);

    expect(ctx.projectPath).toBeNull();
  });

  describe("AbortController lifecycle", () => {
    it("creates an AbortController on register", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx = registry.register(win);

      expect(ctx.abortController).toBeInstanceOf(AbortController);
      expect(ctx.abortController.signal.aborted).toBe(false);
    });

    it("aborts signal on unregister", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx = registry.register(win);
      registry.unregister(1);

      expect(ctx.abortController.signal.aborted).toBe(true);
    });

    it("aborts signal when closed event fires", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx = registry.register(win);
      win._fireClosed();

      expect(ctx.abortController.signal.aborted).toBe(true);
    });

    it("abort is idempotent — both closed and destroyed fire without error", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx = registry.register(win);
      win._fireClosed();
      win._fireDestroyed();

      expect(ctx.abortController.signal.aborted).toBe(true);
    });

    it("dispose aborts all controllers", () => {
      const registry = new WindowRegistry();
      const win1 = makeMockWindow(1, 100);
      const win2 = makeMockWindow(2, 200);

      const ctx1 = registry.register(win1);
      const ctx2 = registry.register(win2);

      registry.dispose();

      expect(ctx1.abortController.signal.aborted).toBe(true);
      expect(ctx2.abortController.signal.aborted).toBe(true);
    });

    it("signal is aborted before cleanup callbacks run", () => {
      const registry = new WindowRegistry();
      const win = makeMockWindow(1, 100);

      const ctx = registry.register(win);
      let signalAbortedDuringCleanup = false;
      ctx.cleanup.push(() => {
        signalAbortedDuringCleanup = ctx.abortController.signal.aborted;
      });

      registry.unregister(1);

      expect(signalAbortedDuringCleanup).toBe(true);
    });
  });
});
